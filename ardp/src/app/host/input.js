'use strict';

const { KEYS } = require('./keymap');

const BUTTONS = ['left', 'middle', 'right'];

class NativeInput {
  static load() {
    try {
      const { libnut } = require('@nut-tree-fork/libnut/dist/import_libnut');
      libnut.setMouseDelay(0);
      libnut.setKeyboardDelay(0);
      return new NativeInput(libnut);
    } catch (err) {
      NativeInput.loadError = err;
      return null;
    }
  }

  constructor(native) {
    this.native = native;
    this.keys = new Set();
    this.buttons = new Set();
    this._wheelX = 0;
    this._wheelY = 0;
  }

  move(x, y) {
    this._try(() => this.native.moveMouse(Math.round(x), Math.round(y)));
  }

  position() {
    return this.native.getMousePos();
  }

  button(index, down) {
    const name = BUTTONS[index];
    if (!name) return;
    if (down) this.buttons.add(name);
    else if (!this.buttons.delete(name)) return;
    this._try(() => this.native.mouseToggle(down ? 'down' : 'up', name));
  }

  wheel(dx, dy) {
    // windows counts 120 per notch, a browser notch is 100px
    const scale = process.platform === 'win32' ? 1.2 : process.platform === 'darwin' ? 1 : 0.03;
    this._wheelX += dx * scale;
    this._wheelY += -dy * scale;
    const x = Math.trunc(this._wheelX);
    const y = Math.trunc(this._wheelY);
    if (x === 0 && y === 0) return;
    this._wheelX -= x;
    this._wheelY -= y;
    this._try(() => this.native.scrollMouse(process.platform === 'darwin' ? -x : x, y));
  }

  key(code, down) {
    const name = KEYS[code];
    if (!name) return;
    // only release what this session pressed
    if (down) this.keys.add(name);
    else if (!this.keys.delete(name)) return;
    this._try(() => this.native.keyToggle(name, down ? 'down' : 'up'));
  }

  releaseAll() {
    for (const name of this.keys) this._try(() => this.native.keyToggle(name, 'up'));
    for (const name of this.buttons) this._try(() => this.native.mouseToggle('up', name));
    this.keys.clear();
    this.buttons.clear();
  }

  _try(fn) {
    try {
      fn();
    } catch {}
  }
}

NativeInput.loadError = null;

module.exports = { NativeInput };
