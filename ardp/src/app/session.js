'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, screen, clipboard } = require('electron');
const product = require('../common/product');
const { describe } = require('../common/messages');
const { formatAddress } = require('../common/address');

const TITLE_H = 32;
const BORDER = 2;
const MAX_CLIPBOARD = 1024 * 1024;

const side = (n) => (Number.isInteger(n) && n >= 16 && n <= 16384 ? n : 0);

// what the host says about the stream is data from the network: keep only what makes sense
function tidy(opened) {
  return {
    source: String(opened.source || '').slice(0, 64),
    kind: opened.kind === 'vm' ? 'vm' : 'desktop',
    name: String(opened.name || '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .slice(0, 64),
    display: String(opened.display || '').slice(0, 32),
    width: side(opened.width),
    height: side(opened.height),
    control: opened.control === true,
    actions: (Array.isArray(opened.actions) ? opened.actions : []).filter((a) => typeof a === 'string').slice(0, 8),
  };
}

class Session extends EventEmitter {
  constructor({ target, client, redial, options, local, quiet, icon, privacy }) {
    super();
    this.target = target;
    this.local = !!local;
    this.privacy = privacy || { on: () => false, scrub: (text) => text };
    this._notice = null;
    this._live = false;
    this.viewOnly = !!options.viewOnly;
    this._asked = false;
    this.address = formatAddress(target);
    this.redial = redial;
    this.options = options;
    this.client = null;
    this.opened = null;
    this.codecs = null;
    this.remoteName = client.remote.name;
    this.aspect = 16 / 9;
    this._fitted = false;
    this._clip = null;
    this._reconnecting = false;
    this._lastAuto = 0;

    this.win = new BrowserWindow({
      width: 1026,
      height: 576 + TITLE_H + BORDER,
      minWidth: 420,
      minHeight: 280,
      show: false,
      frame: false,
      backgroundColor: '#000000',
      title: this.title(),
      icon,
      fullscreen: !!options.fullScreen,
      webPreferences: {
        preload: path.join(__dirname, 'preload', 'session.js'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const win = this.win;
    win.removeMenu();

    const ipc = win.webContents.ipc;
    ipc.on('session:ready', (_e, info) => {
      this.codecs = Array.isArray(info && info.codecs) ? info.codecs : [];
      this._notice = ['session:status', () => ({ text: this._connecting() })];
      this.send('session:init', { title: this.title(), status: this._connecting(), viewOnly: !!options.viewOnly });
      this._pushState();
      this._open();
    });
    ipc.on('session:input', (_e, event) => {
      if (this.client && this._control()) this.client.sendInput(event);
    });
    ipc.on('session:ack', (_e, seq) => {
      if (!this.client) return;
      // a frame reached the screen, so the notice is gone
      this._live = !!this.opened;
      this.client.ack(seq);
    });
    ipc.on('session:keyframe', () => {
      if (this.client) this.client.requestKeyframe();
    });
    ipc.on('session:reconnect', () => this.reconnect());
    ipc.on('session:control', (_e, on) => {
      if (on !== true) {
        this.viewOnly = true;
        this._keys();
        return;
      }
      this.viewOnly = false;
      this._asked = true;
      this._keys();
      // the host was told this session only watches: ask again, this time for control
      if (this.opened && !this.opened.control && this.options.viewOnly) {
        this.options.viewOnly = false;
        this.reconnect();
      }
    });
    ipc.on('session:action', (_e, name) => {
      if (this.client && this._control() && typeof name === 'string') this.client.sendAction(name);
    });
    ipc.on('session:display', (_e, id) => {
      if (typeof id !== 'string' || id === this.options.display) return;
      this.options.display = id;
      this.reconnect();
    });

    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'restore']) {
      win.on(event, () => this._pushState());
    }
    win.on('resized', () => this._snapToAspect());
    if (!quiet) win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      clearInterval(this._clipTimer);
      const client = this.client;
      this.client = null;
      if (client) client.close();
      this.emit('closed');
    });

    this._clipTimer = setInterval(() => this._offerClipboard(), 700);

    this._attach(client);
    win.loadFile(path.join(__dirname, 'ui', 'session.html'));
  }

  // in private mode nothing on screen says which computer this is
  _hide() {
    return this.privacy.on();
  }

  _connecting(again) {
    return `${again ? 'Reconnecting' : 'Connecting'}${this._hide() ? '' : ` to ${this.address}`}…`;
  }

  _describe(reason) {
    return this._hide() ? this.privacy.scrub(describe(reason, 'The other computer')) : describe(reason, this.address);
  }

  title() {
    const o = this.opened;
    const hide = this._hide();
    if (o && o.kind === 'vm') {
      const where = this.local ? 'this computer' : hide ? 'another computer' : this.remoteName;
      const text = `${o.name} - ${where} - ${product.ardp.name}`;
      return hide ? this.privacy.scrub(text) : text;
    }
    return hide ? `Remote computer - ${product.ardp.name}` : `${this.remoteName} - ${this.address} - ${product.ardp.name}`;
  }

  // what the window says while there is no picture. kept, so it can be said again
  // without names when private mode is switched on
  _tell(channel, make) {
    this._live = false;
    this._notice = [channel, make];
    this.send(channel, make());
  }

  // private mode was switched: say everything again the way it should read now
  refresh() {
    if (this.win.isDestroyed()) return;
    this.win.setTitle(this.title());
    this.send('session:title', this.title());
    if (this.opened) this._announce();
    if (this._notice && !(this.opened && this._live)) this.send(this._notice[0], this._notice[1]());
  }

  send(channel, ...args) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  async reconnect() {
    if (this._reconnecting || this.win.isDestroyed()) return;
    this._reconnecting = true;
    this._tell('session:status', () => ({ text: this._connecting(true) }));
    try {
      const old = this.client;
      this.client = null;
      if (old) {
        old.removeAllListeners();
        old.close();
      }
      const client = await this.redial();
      if (this.win.isDestroyed()) {
        client.close();
        return;
      }
      this.remoteName = client.remote.name;
      this._attach(client);
      await this._open();
    } catch (err) {
      this._tell('session:closed', () => ({ code: err.code || 'lost', text: this._describe(err) }));
    } finally {
      this._reconnecting = false;
    }
  }

  _attach(client) {
    this.client = client;
    this.opened = null;
    client.on('video-config', (config) => {
      this.send('session:config', config);
      if (!this.opened || !(config.width > 0 && config.height > 0)) return;
      const aspect = config.width / config.height;
      if (Math.abs(aspect - this.aspect) < 0.001) return;
      this.aspect = aspect;
      this._fit(config.width, config.height);
    });
    client.on('waiting', () => this._tell('session:status', () => ({ text: `Waiting for someone at ${this._hide() ? 'the other computer' : this.remoteName} to allow this…` })));
    client.on('video-frame', (frame) => {
      // copy out of the socket chunk, ipc would serialize all of it
      this.send('session:frame', { key: frame.key, seq: frame.seq, timestamp: frame.timestamp }, new Uint8Array(frame.data));
    });
    client.on('clipboard', (text) => {
      // only while this window is in front, so the host cannot swap what you paste elsewhere
      if (!this._control() || text.length > MAX_CLIPBOARD || this.win.isDestroyed() || !this.win.isFocused()) return;
      this._clip = text;
      clipboard.writeText(text);
    });
    client.on('close', (reason) => {
      if (this.client !== client) return;
      this.client = null;
      this.opened = null;
      if (reason.code === 'display_changed' && Date.now() - this._lastAuto > 3000) {
        this._lastAuto = Date.now();
        this.reconnect();
        return;
      }
      this._tell('session:closed', () => ({ code: reason.code, text: this._describe(reason) }));
    });
  }

  async _open() {
    const client = this.client;
    if (!client || this.codecs === null) return;
    try {
      const raw = await client.open({
        source: this.target.source,
        display: this.options.display,
        codecs: this.codecs,
        quality: this.options.quality,
        viewOnly: this.options.viewOnly,
      });
      if (this.client !== client || this.win.isDestroyed()) return;
      const opened = tidy(raw || {});
      this.opened = opened;
      // looking at this very computer, the pointer would chase its own picture: start out
      // watching and let the person take control when the window is somewhere sensible
      if (this.options.watchFirst && opened.kind !== 'vm' && !this._asked) this.viewOnly = true;
      this._clip = clipboard.readText();
      if (opened.width > 0 && opened.height > 0) {
        const aspect = opened.width / opened.height;
        const changed = Math.abs(aspect - this.aspect) > 0.001;
        this.aspect = aspect;
        if (!this._fitted || changed) this._fit(opened.width, opened.height);
      }
      this._announce();
    } catch (err) {
      if (this.client === client) this.client = null;
      this._tell('session:closed', () => ({ code: err.code || 'lost', text: this._describe(err) }));
    }
  }

  _announce() {
    const { opened, client } = this;
    if (!opened || !client) return;
    const hide = this._hide();
    const source = client.sources.find((s) => s && s.id === opened.source) || client.sources[0] || {};
    const displays = (Array.isArray(source.displays) ? source.displays : []).slice(0, 8).map((d, i) => ({
      id: String(d.id),
      // a monitor's name can say whose it is
      name: hide ? '' : String(d.name || `Display ${i + 1}`).slice(0, 40),
      primary: d.primary === true,
    }));
    this.win.setTitle(this.title());
    this._keys();
    this.send('session:opened', {
      title: this.title(),
      kind: opened.kind === 'vm' ? 'vm' : 'desktop',
      actions: (Array.isArray(opened.actions) ? opened.actions : []).filter((a) => typeof a === 'string').slice(0, 8),
      control: !!opened.control,
      viewOnly: this.viewOnly,
      wanted: !this.options.viewOnly,
      width: opened.width,
      height: opened.height,
      display: String(opened.display || ''),
      displays,
    });
  }

  _fit(remoteWidth, remoteHeight) {
    this._fitted = true;
    const win = this.win;
    if (win.isFullScreen() || win.isMaximized()) return;
    const display = screen.getDisplayMatching(win.getBounds());
    const area = display.workArea;
    const maxW = Math.floor(area.width * 0.9) - BORDER;
    const maxH = Math.floor(area.height * 0.9) - TITLE_H - BORDER;
    const w = remoteWidth / display.scaleFactor;
    const h = remoteHeight / display.scaleFactor;
    const scale = Math.min(1, maxW / w, maxH / h);
    const width = Math.round(w * scale) + BORDER;
    const height = Math.round(h * scale) + TITLE_H + BORDER;
    win.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    });
  }

  // keep the window the shape of the remote screen so there are no bars
  _snapToAspect() {
    const win = this.win;
    if (!this.opened || win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return;
    const [width, height] = win.getSize();
    const wanted = Math.round((width - BORDER) / this.aspect) + TITLE_H + BORDER;
    if (Math.abs(wanted - height) > 1) win.setSize(width, wanted);
  }

  _offerClipboard() {
    if (!this.client || !this._control() || this.win.isDestroyed() || !this.win.isFocused()) return;
    const text = clipboard.readText();
    if (text === this._clip) return;
    this._clip = text;
    if (text && text.length <= MAX_CLIPBOARD) this.client.sendClipboard(text);
  }

  // controlling needs both: the host allows it and the person here has not chosen view only
  _control() {
    return !!this.opened && this.opened.control && !this.viewOnly;
  }

  // while controlling, the app's own menu shortcuts stand down. on a mac that is what
  // lets cmd+q, cmd+w and cmd+h reach the other computer instead of acting here
  _keys() {
    if (!this.win.isDestroyed()) this.win.webContents.setIgnoreMenuShortcuts(this._control());
  }

  _pushState() {
    const win = this.win;
    if (win.isDestroyed()) return;
    this.send('window:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() });
  }
}

module.exports = { Session };
