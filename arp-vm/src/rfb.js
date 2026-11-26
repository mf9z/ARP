'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ByteQueue } = require('./bytes');

const RAW = 0;
const DESKTOP_SIZE = -223;
const QEMU_EXT_KEY = -258;
const MAX_SIDE = 8192;
const MAX_TEXT = 1024 * 1024;

// vnc's login: des-encrypt the server's challenge with the password, each key byte bit-reversed
function answer(password, challenge) {
  const key = Buffer.alloc(8);
  Buffer.from(password, 'latin1').copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let b = key[i];
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
    key[i] = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
  }
  let des;
  try {
    des = crypto.createCipheriv('des-ecb', key, null);
  } catch {
    // plain des is switched off in newer openssl; triple des with one key three times is the same thing
    des = crypto.createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null);
  }
  des.setAutoPadding(false);
  return Buffer.concat([des.update(challenge), des.final()]);
}

const sane = (width, height) => {
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error('the vm reported an impossible screen size');
};

// just enough vnc to read a qemu framebuffer and type into it.
// pixels come out as b, g, r, x
class Rfb extends EventEmitter {
  constructor({ password = '' } = {}) {
    super();
    this.password = password;
    this.width = 0;
    this.height = 0;
    this.name = '';
    this.extKeys = false;
    this.closed = false;
    this.socket = null;
    this.queue = new ByteQueue();
    this.step = this._version;
    this.rects = 0;
    this.version = 8;
  }

  connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this._settle = { resolve, reject };
      const socket = net.connect(port, host);
      this.socket = socket;
      this._timer = setTimeout(() => this._fail(new Error('the vm display did not answer')), 10000);
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this._feed(chunk));
      socket.on('error', (err) => this._fail(err));
      socket.on('close', () => this._fail());
    });
  }

  requestUpdate(incremental = true) {
    const b = Buffer.alloc(10);
    b[0] = 3;
    b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(this.width, 6);
    b.writeUInt16BE(this.height, 8);
    this._write(b);
  }

  pointer(x, y, mask) {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    this._write(b);
  }

  key({ keysym, scancode }, down) {
    if (this.extKeys && scancode) {
      const b = Buffer.alloc(12);
      b[0] = 255;
      b.writeUInt16BE(down ? 1 : 0, 2);
      b.writeUInt32BE(keysym || 0, 4);
      // qemu wants e0-prefixed keys folded into one byte with the high bit set
      b.writeUInt32BE(scancode > 0xff ? (scancode & 0x7f) | 0x80 : scancode, 8);
      this._write(b);
    } else if (keysym) {
      const b = Buffer.alloc(8);
      b[0] = 4;
      b[1] = down ? 1 : 0;
      b.writeUInt32BE(keysym, 4);
      this._write(b);
    }
  }

  close() {
    this._fail();
  }

  _write(buffer) {
    if (!this.closed && this.socket) this.socket.write(buffer);
  }

  _feed(chunk) {
    this.queue.push(chunk);
    try {
      while (!this.closed && this.step()) {}
    } catch (err) {
      this._fail(err);
    }
  }

  _fail(err) {
    if (this.closed) return false;
    this.closed = true;
    clearTimeout(this._timer);
    if (this.socket) this.socket.destroy();
    const settle = this._settle;
    this._settle = null;
    if (settle) settle.reject(err || new Error('the vm display closed'));
    this.emit('close', err || null);
    return false;
  }

  _version() {
    const b = this.queue.take(12);
    if (!b) return false;
    const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(b.toString('latin1'));
    if (!m) throw new Error('that is not a vnc server');
    const minor = Number(m[1]) > 3 ? 8 : Number(m[2]);
    this.version = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
    this._write(Buffer.from(`RFB 003.00${this.version}\n`, 'latin1'));
    this.step = this.version === 3 ? this._securityOld : this._security;
    return true;
  }

  _security() {
    const count = this.queue.peek(1);
    if (!count) return false;
    if (count[0] === 0) {
      this.queue.take(1);
      this.step = this._refused;
      return true;
    }
    const list = this.queue.take(1 + count[0]);
    if (!list) return false;
    const offered = list.subarray(1);
    if (this.password) {
      // we set a password on our own vm, so a screen that does not ask for it is not ours
      if (!offered.includes(2)) throw new Error('the vm display did not ask for its password');
      this._write(Buffer.from([2]));
      this.step = this._challenge;
      return true;
    }
    if (!offered.includes(1)) throw new Error('the vm display wants a password');
    this._write(Buffer.from([1]));
    if (this.version === 8) {
      this.step = this._securityResult;
      return true;
    }
    return this._hello();
  }

  _challenge() {
    const challenge = this.queue.take(16);
    if (!challenge) return false;
    this._write(answer(this.password, challenge));
    this.step = this._securityResult;
    return true;
  }

  _securityOld() {
    const b = this.queue.take(4);
    if (!b) return false;
    const type = b.readUInt32BE(0);
    if (type === 2 && this.password) {
      this.step = this._challenge;
      return true;
    }
    if (this.password) throw new Error('the vm display did not ask for its password');
    if (type === 1) return this._hello();
    if (type === 0) {
      this.step = this._refused;
      return true;
    }
    throw new Error('the vm display wants a password');
  }

  _securityResult() {
    const b = this.queue.take(4);
    if (!b) return false;
    if (b.readUInt32BE(0) === 0) return this._hello();
    this.step = this._refused;
    return true;
  }

  _refused() {
    const head = this.queue.peek(4);
    if (!head) return false;
    if (head.readUInt32BE(0) > 1024) throw new Error('the vm display refused the connection');
    const b = this.queue.take(4 + head.readUInt32BE(0));
    if (!b) return false;
    throw new Error(b.subarray(4).toString('latin1') || 'the vm display refused the connection');
  }

  _hello() {
    this._write(Buffer.from([1]));
    this.step = this._serverInit;
    return true;
  }

  _serverInit() {
    const head = this.queue.peek(24);
    if (!head) return false;
    if (head.readUInt32BE(20) > 1024) throw new Error('the vm display sent an oversized name');
    const b = this.queue.take(24 + head.readUInt32BE(20));
    if (!b) return false;
    this.width = b.readUInt16BE(0);
    this.height = b.readUInt16BE(2);
    sane(this.width, this.height);
    clearTimeout(this._timer);
    this.name = b.subarray(24).toString('utf8');

    const format = Buffer.alloc(20);
    format[4] = 32;
    format[5] = 24;
    format[7] = 1;
    format.writeUInt16BE(255, 8);
    format.writeUInt16BE(255, 10);
    format.writeUInt16BE(255, 12);
    format[14] = 16;
    format[15] = 8;

    const wanted = [RAW, DESKTOP_SIZE, QEMU_EXT_KEY];
    const encodings = Buffer.alloc(4 + 4 * wanted.length);
    encodings[0] = 2;
    encodings.writeUInt16BE(wanted.length, 2);
    wanted.forEach((e, i) => encodings.writeInt32BE(e, 4 + 4 * i));
    this._write(Buffer.concat([format, encodings]));

    this.step = this._message;
    const settle = this._settle;
    this._settle = null;
    if (settle) settle.resolve(this);
    return true;
  }

  _message() {
    const type = this.queue.peek(1);
    if (!type) return false;
    switch (type[0]) {
      case 0: {
        const b = this.queue.take(4);
        if (!b) return false;
        this.rects = b.readUInt16BE(2);
        this.step = this._rect;
        return true;
      }
      case 1: {
        const head = this.queue.peek(6);
        if (!head) return false;
        return !!this.queue.take(6 + head.readUInt16BE(4) * 6);
      }
      case 2:
        this.queue.take(1);
        return true;
      case 3: {
        const head = this.queue.peek(8);
        if (!head) return false;
        if (head.readUInt32BE(4) > MAX_TEXT) throw new Error('the vm sent an oversized clipboard');
        return !!this.queue.take(8 + head.readUInt32BE(4));
      }
      default:
        throw new Error(`unexpected vnc message ${type[0]}`);
    }
  }

  _rect() {
    if (this.rects === 0) {
      this.step = this._message;
      this.emit('frame');
      return true;
    }
    const head = this.queue.peek(12);
    if (!head) return false;
    const x = head.readUInt16BE(0);
    const y = head.readUInt16BE(2);
    const width = head.readUInt16BE(4);
    const height = head.readUInt16BE(6);
    const encoding = head.readInt32BE(8);

    if (encoding === RAW) {
      if (x + width > this.width || y + height > this.height) throw new Error('vnc update outside the screen');
      const b = this.queue.take(12 + width * height * 4);
      if (!b) return false;
      if (width && height) this.emit('rect', { x, y, width, height, data: b.subarray(12) });
    } else if (encoding === DESKTOP_SIZE) {
      this.queue.take(12);
      sane(width, height);
      this.width = width;
      this.height = height;
      this.emit('resize', { width, height });
    } else if (encoding === QEMU_EXT_KEY) {
      this.queue.take(12);
      this.extKeys = true;
    } else {
      throw new Error(`unsupported vnc encoding ${encoding}`);
    }
    this.rects -= 1;
    return true;
  }
}

module.exports = { Rfb };

module.exports.answer = answer;
