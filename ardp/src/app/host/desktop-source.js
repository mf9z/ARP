'use strict';

const { app, desktopCapturer, screen, clipboard, systemPreferences } = require('electron');
const { Source, SourceStream } = require('../../host/source');
const { ArdpError } = require('../../protocol/errors');
const { Encoder } = require('./encoder');
const quality = require('./quality');

const MAX_CLIPBOARD = 1024 * 1024;

const pixelSize = (display) => ({
  width: Math.round(display.size.width * display.scaleFactor),
  height: Math.round(display.size.height * display.scaleFactor),
});

function inputRect(display) {
  // windows injects in physical pixels
  if (process.platform === 'win32') return screen.dipToScreenRect(null, display.bounds);
  return display.bounds;
}

class DesktopSource extends Source {
  constructor({ name, input, allowControl }) {
    super();
    this.name = name;
    this.input = input;
    this.allowControl = allowControl || (() => true);
    this.active = null;
  }

  describe() {
    const primary = screen.getPrimaryDisplay().id;
    return {
      id: 'desktop',
      kind: 'desktop',
      name: this.name,
      displays: screen.getAllDisplays().map((d, i) => ({
        id: String(d.id),
        name: d.label || `Display ${i + 1}`,
        ...pixelSize(d),
        primary: d.id === primary,
      })),
    };
  }

  async open(request) {
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
      throw new ArdpError('capture_failed', 'ARDP is not allowed to record the screen on that computer (System Settings > Privacy & Security > Screen Recording).');
    }
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === String(request.display)) || screen.getPrimaryDisplay();

    // one desktop, one session: the newest wins
    if (this.active) this.active.finish('replaced');

    const stream = new DesktopStream(this, display, displays.indexOf(display), request);
    this.active = stream;
    try {
      await stream.prepare();
    } catch (err) {
      stream.close();
      throw err instanceof ArdpError ? err : new ArdpError('capture_failed', err.message);
    }
    return stream;
  }
}

class DesktopStream extends SourceStream {
  constructor(source, display, index, request) {
    super();
    this.source = source;
    this.display = display;
    this.index = index;
    this.request = request;
    this.encoder = null;
    this.closed = false;
    this._clip = null;
    this._clipTimer = null;
    this._onMetrics = null;

    const size = pixelSize(display);
    const { fps, bitrate } = quality.plan(request.quality, size.width, size.height);
    this.fps = fps;
    this.bitrate = bitrate;

    // over loopback the pointer would chase itself, so those sessions only watch
    const testing = !app.isPackaged && process.env.ARDP_LOOPBACK_INPUT === '1';
    const loopback = request.peer.loopback && !testing;
    const control = !request.viewOnly && !!source.input && source.allowControl() && !loopback;
    this.info = {
      source: 'desktop',
      kind: 'desktop',
      name: source.name,
      display: String(display.id),
      width: size.width,
      height: size.height,
      control,
      actions: [],
    };
    this.rect = inputRect(display);
  }

  async prepare() {
    const size = pixelSize(this.display);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const picked = sources.find((s) => s.display_id && s.display_id === String(this.display.id)) || sources[this.index] || sources[0];
    if (!picked) throw new ArdpError('capture_failed', 'That computer has no display to share.');

    const encoder = await Encoder.open({
      mode: 'display',
      sourceId: picked.id,
      width: size.width,
      height: size.height,
      fps: this.fps,
      bitrate: this.bitrate.start,
      codecs: this.request.codecs,
    });
    if (this.closed) {
      encoder.close();
      throw new ArdpError('replaced', 'Another session took over.');
    }
    this.encoder = encoder;
    this.info.width = encoder.width;
    this.info.height = encoder.height;
    encoder.on('frame', (meta, data) => this.emit('frame', meta, data));
    encoder.on('failed', () => this.finish('capture_failed'));
  }

  start() {
    if (this.closed) return;
    this.emit('config', this.encoder.config);
    this.encoder.go();

    this._onMetrics = (_e, display, changed) => {
      if (display.id !== this.display.id) return;
      if (changed.includes('bounds') || changed.includes('scaleFactor')) this.finish('display_changed');
    };
    screen.on('display-metrics-changed', this._onMetrics);

    if (this.info.control) {
      this._clip = clipboard.readText();
      this._clipTimer = setInterval(() => {
        const text = clipboard.readText();
        if (text === this._clip) return;
        this._clip = text;
        if (text && text.length <= MAX_CLIPBOARD) this.emit('clipboard', text);
      }, 700);
    }
  }

  requestKeyframe() {
    if (this.encoder) this.encoder.key();
  }

  tune(settings) {
    if (this.encoder) this.encoder.tune(settings);
  }

  input(event) {
    const input = this.source.input;
    if (this.closed || !this.info.control || !input) return;
    switch (event.t) {
      case 'move':
        this._move(event);
        break;
      case 'button':
        if (event.x !== undefined) this._move(event);
        input.button(event.b, event.down);
        break;
      case 'wheel':
        if (event.x !== undefined) this._move(event);
        input.wheel(event.dx, event.dy);
        break;
      case 'key':
        input.key(event.code, event.down);
        break;
      case 'release':
        input.releaseAll();
        break;
      default:
        break;
    }
  }

  clipboard(text) {
    if (this.closed || !this.info.control) return;
    this._clip = text;
    clipboard.writeText(text);
  }

  finish(reason) {
    if (this.closed) return;
    this.emit('end', reason);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._clipTimer);
    if (this._onMetrics) screen.removeListener('display-metrics-changed', this._onMetrics);
    if (this.info.control && this.source.input) this.source.input.releaseAll();
    if (this.source.active === this) this.source.active = null;
    if (this.encoder) this.encoder.close();
  }

  _move({ x, y }) {
    const r = this.rect;
    this.source.input.move(r.x + x * (r.width - 1), r.y + y * (r.height - 1));
  }
}

module.exports = { DesktopSource };
