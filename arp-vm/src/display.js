'use strict';

const { EventEmitter } = require('events');
const { Rfb } = require('./rfb');
const keys = require('./keys');

const BUTTON = [1, 2, 4];
const WHEEL = { up: 8, down: 16, left: 32, right: 64 };
const NOTCH = 100;

class VmDisplay extends EventEmitter {
  static async connect(port, { fps = 30, host = '127.0.0.1' } = {}) {
    const rfb = new Rfb();
    await rfb.connect(port, host);
    return new VmDisplay(rfb, fps);
  }

  constructor(rfb, fps = 30) {
    super();
    this.rfb = rfb;
    this.interval = 1000 / fps;
    this.closed = false;
    this.x = 0;
    this.y = 0;
    this.mask = 0;
    this.held = new Map();
    this.wheel = { x: 0, y: 0 };
    this.asked = 0;
    this.timer = null;
    this.dirty = false;

    rfb.on('rect', (rect) => {
      this.dirty = true;
      this.emit('rect', rect);
    });
    rfb.on('frame', () => {
      if (this.dirty) this.emit('frame');
      this.dirty = false;
      // qemu only sends when asked, so asking at most `fps` times a second is the frame limit
      const wait = Math.max(0, this.interval - (Date.now() - this.asked));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._ask(true), wait);
    });
    rfb.on('resize', (size) => this.emit('resize', size));
    rfb.on('close', (err) => {
      this.closed = true;
      clearTimeout(this.timer);
      this.emit('close', err);
    });
  }

  get width() {
    return this.rfb.width;
  }

  get height() {
    return this.rfb.height;
  }

  refresh() {
    clearTimeout(this.timer);
    this._ask(false);
  }

  input(event) {
    if (this.closed) return;
    switch (event.t) {
      case 'move':
        this._aim(event);
        this._point();
        break;
      case 'button': {
        const bit = BUTTON[event.b];
        if (!bit) return;
        this._aim(event);
        this.mask = event.down ? this.mask | bit : this.mask & ~bit;
        this._point();
        break;
      }
      case 'wheel':
        this._aim(event);
        this._scroll('y', event.dy, WHEEL.down, WHEEL.up);
        this._scroll('x', event.dx, WHEEL.right, WHEEL.left);
        break;
      case 'key': {
        const key = keys.lookup(event.code);
        if (!key) return;
        if (event.down) this.held.set(event.code, key);
        else if (!this.held.delete(event.code)) return;
        this.rfb.key(key, event.down);
        break;
      }
      case 'release':
        this.releaseAll();
        break;
      default:
        break;
    }
  }

  // press and release a chord, e.g. ['ControlLeft', 'AltLeft', 'Delete']
  tap(codes) {
    const chord = codes.map(keys.lookup).filter(Boolean);
    for (const key of chord) this.rfb.key(key, true);
    for (const key of chord.reverse()) this.rfb.key(key, false);
  }

  releaseAll() {
    for (const key of this.held.values()) this.rfb.key(key, false);
    this.held.clear();
    if (this.mask) {
      this.mask = 0;
      this._point();
    }
  }

  close() {
    if (this.closed) return;
    this.releaseAll();
    this.rfb.close();
  }

  _ask(incremental) {
    if (this.closed) return;
    this.asked = Date.now();
    this.rfb.requestUpdate(incremental);
  }

  _aim({ x, y }) {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    this.x = Math.round(x * (this.width - 1));
    this.y = Math.round(y * (this.height - 1));
  }

  _point(extra = 0) {
    this.rfb.pointer(this.x, this.y, this.mask | extra);
  }

  // vnc has no wheel deltas, only "wheel buttons" that are clicked once per notch
  _scroll(axis, delta, forward, back) {
    if (!delta) return;
    this.wheel[axis] += delta;
    const notches = Math.max(-20, Math.min(20, Math.trunc(this.wheel[axis] / NOTCH)));
    this.wheel[axis] -= notches * NOTCH;
    for (let i = 0; i < Math.abs(notches); i++) {
      this._point(notches > 0 ? forward : back);
      this._point();
    }
  }
}

module.exports = { VmDisplay };
