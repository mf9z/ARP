'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow } = require('electron');
const { ArdpError } = require('../../protocol/errors');

// the hidden window that turns pictures into video (ui/capture.js).
// mode 'display' captures a screen itself, mode 'frames' is fed with rect() and present()
class Encoder extends EventEmitter {
  static async open(options, afterStart) {
    const encoder = new Encoder();
    try {
      await encoder._open(options, afterStart);
    } catch (err) {
      encoder.close();
      throw err;
    }
    return encoder;
  }

  constructor() {
    super();
    this.win = null;
    this.closed = false;
    this.label = '';
    this.codec = '';
    this.width = 0;
    this.height = 0;
    this.stats = null;
    this._giveUp = null;
  }

  async _open(options, afterStart) {
    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'capture.js'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const contents = this.win.webContents;
    this.contents = contents;
    Encoder.capturing.add(contents);
    const ipc = contents.ipc;

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ArdpError('capture_failed', 'The picture did not start in time.')), 15000);
      const stop = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this._giveUp = stop(reject);
      ipc.once('capture:ready', (_e, info) => stop(resolve)(info));
      ipc.once('capture:error', (_e, message) => stop(reject)(new ArdpError('capture_failed', String(message))));
      contents.once('render-process-gone', () => stop(reject)(new ArdpError('capture_failed', 'The video encoder stopped unexpectedly.')));
    });
    ready.catch(() => {});

    await this.win.loadFile(path.join(__dirname, '..', 'ui', 'capture.html'));
    contents.send('capture:start', options);
    if (afterStart) afterStart(this);

    const info = await ready;
    this._giveUp = null;
    this.label = info.encoder;
    this.codec = info.codec;
    this.width = info.width;
    this.height = info.height;

    ipc.on('capture:frame', (_e, meta, data) => {
      if (this.closed || !(data instanceof Uint8Array) || !meta) return;
      this.emit('frame', { key: meta.key === true, timestamp: Number(meta.timestamp) || 0 }, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    });
    ipc.on('capture:stats', (_e, stats) => {
      this.stats = stats;
    });
    const failed = () => {
      if (!this.closed) this.emit('failed');
    };
    ipc.on('capture:error', failed);
    ipc.on('capture:ended', failed);
    contents.on('render-process-gone', failed);
  }

  get config() {
    return { codec: this.codec, width: this.width, height: this.height };
  }

  go() {
    this._send('capture:go');
  }

  key() {
    this._send('capture:key');
  }

  tune(settings) {
    this._send('capture:tune', settings);
  }

  rect({ x, y, width, height, data }) {
    // copy: the pixels sit inside a bigger socket chunk and ipc would serialize all of it
    this._send('capture:rect', { x, y, width, height }, new Uint8Array(data));
  }

  present() {
    this._send('capture:present');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._giveUp) this._giveUp(new ArdpError('capture_failed', 'The picture was stopped.'));
    if (this.contents) Encoder.capturing.delete(this.contents);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  _send(channel, ...args) {
    if (!this.closed && this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }
}

// the only windows allowed to capture a screen
Encoder.capturing = new Set();

module.exports = { Encoder };
