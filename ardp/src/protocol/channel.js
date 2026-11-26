'use strict';

const { EventEmitter } = require('events');
const wire = require('./wire');

const { T } = wire;

class Channel extends EventEmitter {
  constructor(socket, { pingInterval = 4000, idleTimeout = 15000 } = {}) {
    super();
    this.socket = socket;
    this.closed = false;
    this.rtt = null;
    this._lastRx = Date.now();
    this._error = null;

    this._decoder = new wire.Decoder((type, payload) => this._onMessage(type, payload));

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this._lastRx = Date.now();
      try {
        this._decoder.push(chunk);
      } catch (err) {
        this.destroy(err);
      }
    });
    socket.on('error', (err) => {
      if (!this._error) this._error = err;
    });
    socket.on('close', () => this._finish());

    this._timer = setInterval(() => {
      if (Date.now() - this._lastRx > idleTimeout) {
        const err = new Error('The connection timed out.');
        err.code = 'timeout';
        this.destroy(err);
        return;
      }
      this.sendJson(T.PING, { t: Date.now() });
    }, pingInterval);
    if (this._timer.unref) this._timer.unref();
  }

  get buffered() {
    return this.socket.writableLength || 0;
  }

  send(type, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const body = payload || Buffer.alloc(0);
    this.socket.cork();
    this.socket.write(wire.header(type, body.length));
    const ok = this.socket.write(body);
    this.socket.uncork();
    return ok;
  }

  sendJson(type, object) {
    return this.send(type, Buffer.from(JSON.stringify(object === undefined ? {} : object), 'utf8'));
  }

  sendVideoFrame(meta, data) {
    if (this.closed || this.socket.destroyed) return false;
    const head = wire.packVideoHead(meta);
    this.socket.cork();
    this.socket.write(wire.header(T.VIDEO_FRAME, head.length + data.length));
    this.socket.write(head);
    const ok = this.socket.write(data);
    this.socket.uncork();
    return ok;
  }

  fail(code, message) {
    this.sendJson(T.ERROR, { code, message });
    this.end();
  }

  end() {
    if (this.closed) return;
    clearInterval(this._timer);
    this.socket.end();
    const kill = setTimeout(() => this.socket.destroy(), 1500);
    if (kill.unref) kill.unref();
  }

  destroy(err) {
    if (err && !this._error) this._error = err;
    this.socket.destroy();
    this._finish();
  }

  _onMessage(type, payload) {
    if (type === T.PING) {
      this.send(T.PONG, payload);
      return;
    }
    if (type === T.PONG) {
      try {
        const { t } = wire.parseJson(payload);
        if (Number.isFinite(t)) this.rtt = Math.max(0, Date.now() - t);
      } catch {}
      return;
    }
    try {
      this.emit('message', type, payload);
    } catch (err) {
      this.destroy(err);
    }
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._timer);
    this.emit('close', this._error);
  }
}

module.exports = { Channel };
