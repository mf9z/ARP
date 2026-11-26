'use strict';

const ALPN = 'ardp/1';
const VERSION = 1;
const MAX_MESSAGE = 32 * 1024 * 1024;

const T = Object.freeze({
  HELLO: 0x01,
  CHALLENGE: 0x02,
  AUTH: 0x03,
  WELCOME: 0x04,
  ERROR: 0x05,

  OPEN: 0x10,
  OPENED: 0x11,
  CLOSE: 0x12,
  WAIT: 0x13,

  VIDEO_CONFIG: 0x20,
  VIDEO_FRAME: 0x21,
  VIDEO_KEY: 0x22,
  VIDEO_ACK: 0x23,

  INPUT: 0x30,

  CLIPBOARD: 0x40,

  PING: 0x50,
  PONG: 0x51,

  // 0x60-0x7f is arp's: things a source can do besides showing a screen
  ACTION: 0x60,
});

const EMPTY = Buffer.alloc(0);

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = 'bad_protocol';
  }
}

function header(type, length) {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(length + 1, 0);
  head.writeUInt8(type, 4);
  return head;
}

function encode(type, payload = EMPTY) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([header(type, body.length), body]);
}

function encodeJson(type, object) {
  return encode(type, Buffer.from(JSON.stringify(object === undefined ? {} : object), 'utf8'));
}

function parseJson(payload) {
  if (!payload || payload.length === 0) return {};
  try {
    const value = JSON.parse(payload.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (err) {
    throw new ProtocolError(`malformed JSON payload (${err.message})`);
  }
}

class Decoder {
  constructor(onMessage, limit = MAX_MESSAGE) {
    this.onMessage = onMessage;
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      if (this.size < 5) return;
      if (this.chunks[0].length < 4) this._flatten();
      const length = this.chunks[0].readUInt32BE(0);
      if (length < 1 || length > this.limit) throw new ProtocolError(`invalid message length ${length}`);
      if (this.size < 4 + length) return;
      const message = this._take(4 + length);
      this.onMessage(message[4], message.subarray(5));
    }
  }

  _flatten() {
    this.chunks = [Buffer.concat(this.chunks, this.size)];
  }

  _take(n) {
    if (this.chunks[0].length < n) this._flatten();
    const head = this.chunks[0];
    const out = head.subarray(0, n);
    if (head.length === n) this.chunks.shift();
    else this.chunks[0] = head.subarray(n);
    this.size -= n;
    return out;
  }
}

// flags u8, seq u32, timestamp u64 in microseconds, then one access unit
const VIDEO_HEAD = 13;
const FLAG_KEY = 1;

function packVideoHead({ key, seq, timestamp }) {
  const head = Buffer.allocUnsafe(VIDEO_HEAD);
  head.writeUInt8(key ? FLAG_KEY : 0, 0);
  head.writeUInt32BE(seq >>> 0, 1);
  head.writeBigUInt64BE(BigInt(Math.max(0, Math.round(timestamp || 0))), 5);
  return head;
}

function unpackVideoFrame(payload) {
  if (payload.length < VIDEO_HEAD) throw new ProtocolError('short video frame');
  return {
    key: (payload.readUInt8(0) & FLAG_KEY) !== 0,
    seq: payload.readUInt32BE(1),
    timestamp: Number(payload.readBigUInt64BE(5)),
    data: payload.subarray(VIDEO_HEAD),
  };
}

module.exports = {
  ALPN,
  VERSION,
  MAX_MESSAGE,
  T,
  ProtocolError,
  Decoder,
  header,
  encode,
  encodeJson,
  parseJson,
  packVideoHead,
  unpackVideoFrame,
  VIDEO_HEAD,
};
