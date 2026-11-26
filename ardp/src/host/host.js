'use strict';

const tls = require('tls');
const { EventEmitter } = require('events');
const wire = require('../protocol/wire');
const auth = require('../protocol/auth');
const input = require('../protocol/input');
const { Channel } = require('../protocol/channel');
const { ArdpError } = require('../protocol/errors');
const { FlowControl } = require('./flow');
const { isLoopback } = require('../common/address');

const { T } = wire;

const HANDSHAKE_TIMEOUT = 15000;
const MAX_CONNECTIONS = 16;
const MAX_CLIPBOARD = 1024 * 1024;
const FAILURES_BEFORE_LOCK = 5;

const tidyAddress = (address) => String(address || '').replace(/^::ffff:/i, '');
const b64 = (text, min, max) => {
  if (typeof text !== 'string' || text.length > 512) return null;
  const buf = Buffer.from(text, 'base64');
  return buf.length >= min && buf.length <= max ? buf : null;
};

class ArdpHost extends EventEmitter {
  constructor({ identity, info, credential, sources }) {
    super();
    this.identity = identity;
    this.info = info;
    this.credential = credential;
    this.sources = typeof sources === 'function' ? sources : () => sources;
    this.server = null;
    this.connections = new Set();
    this.sessions = new Set();
    this._failures = new Map();
    this._nextId = 1;
  }

  get listening() {
    return !!this.server;
  }

  listen(port, address) {
    if (this.server) return Promise.reject(new Error('already listening'));
    return new Promise((resolve, reject) => {
      const server = tls.createServer(
        { key: this.identity.key, cert: this.identity.cert, ALPNProtocols: [wire.ALPN], minVersion: 'TLSv1.2' },
        (socket) => this._accept(socket),
      );
      server.on('tlsClientError', () => {});
      server.once('error', reject);
      server.listen(port, address || undefined, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => this.emit('error', err));
        this.server = server;
        resolve(server.address());
      });
    });
  }

  close() {
    const server = this.server;
    this.server = null;
    for (const session of [...this.connections]) session.end('host_stopped');
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  list() {
    return [...this.sessions].map((s) => s.summary());
  }

  disconnect(id, reason = 'kicked') {
    for (const session of [...this.connections]) {
      if (id === undefined || session.id === id) session.end(reason);
    }
  }

  _accept(socket) {
    if (this.connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const session = new HostSession(this, socket);
    this.connections.add(session);
  }

  _lockedFor(address, now = Date.now()) {
    const entry = this._failures.get(address);
    return entry && entry.until > now ? entry.until - now : 0;
  }

  _recordFailure(address, now = Date.now()) {
    for (const [key, entry] of this._failures) {
      if (now - entry.last > 60 * 60 * 1000) this._failures.delete(key);
    }
    const entry = this._failures.get(address) || { count: 0, until: 0, last: now };
    entry.count += 1;
    entry.last = now;
    if (entry.count >= FAILURES_BEFORE_LOCK) {
      const step = entry.count - FAILURES_BEFORE_LOCK;
      entry.until = now + Math.min(10 * 60 * 1000, 30000 * 2 ** step);
    }
    this._failures.set(address, entry);
  }

  _recordSuccess(address) {
    this._failures.delete(address);
  }
}

class HostSession {
  constructor(host, socket) {
    this.host = host;
    this.id = host._nextId++;
    this.address = tidyAddress(socket.remoteAddress);
    this.loopback = isLoopback(this.address);
    this.client = { name: '', platform: '', version: '' };
    this.since = Date.now();
    this.state = 'hello';
    this.stream = null;
    this.flow = null;
    this.seq = 0;
    this._opening = false;
    this._flowTimer = null;
    this._auth = null;

    this.channel = new Channel(socket);
    this.channel.on('message', (type, payload) => this._onMessage(type, payload));
    this.channel.on('close', () => this._cleanup());
    this._deadline = setTimeout(() => this.channel.fail('timeout', 'The handshake took too long.'), HANDSHAKE_TIMEOUT);
  }

  summary() {
    return {
      id: this.id,
      address: this.address,
      name: this.client.name,
      platform: this.client.platform,
      since: this.since,
      streaming: !!this.stream,
      control: !!(this.stream && this.stream.info.control),
      source: this.stream ? this.stream.info.source : null,
    };
  }

  end(reason) {
    if (this.channel.closed) return;
    this.channel.sendJson(T.CLOSE, { reason });
    this.channel.end();
  }

  _onMessage(type, payload) {
    try {
      switch (this.state) {
        case 'hello':
          return this._hello(type, payload);
        case 'auth':
          return this._authenticate(type, payload);
        default:
          return this._ready(type, payload);
      }
    } catch (err) {
      this.channel.fail(err.code === 'bad_protocol' ? 'bad_protocol' : 'internal', err.message);
    }
  }

  _hello(type, payload) {
    if (type !== T.HELLO) throw new wire.ProtocolError('expected HELLO');
    const msg = wire.parseJson(payload);
    if (msg.v !== wire.VERSION) {
      this.channel.fail('version', `This computer speaks ARDP version ${wire.VERSION}.`);
      return;
    }
    const clientNonce = b64(msg.nonce, 16, 64);
    if (!clientNonce) throw new wire.ProtocolError('bad nonce');

    const client = msg.client && typeof msg.client === 'object' ? msg.client : {};
    this.client = {
      name: String(client.name || '').slice(0, 64),
      platform: String(client.platform || '').slice(0, 16),
      version: String(client.version || '').slice(0, 16),
    };

    const credential = this.host.credential();
    if (!credential) {
      this.channel.fail('host_disabled', 'This computer is not accepting connections.');
      return;
    }
    const locked = this.host._lockedFor(this.address);
    if (locked > 0) {
      this.channel.fail('rate_limited', `Too many wrong access codes. Try again in ${Math.ceil(locked / 1000)} seconds.`);
      return;
    }

    const hostNonce = auth.randomNonce();
    this._auth = { key: credential.key, ctx: { clientNonce, hostNonce, fingerprint: this.host.identity.fingerprint } };
    this.state = 'auth';
    this.channel.sendJson(T.CHALLENGE, {
      v: wire.VERSION,
      host: this.host.info,
      nonce: hostNonce.toString('base64'),
      salt: credential.salt.toString('base64'),
      kdf: auth.KDF,
    });
  }

  _authenticate(type, payload) {
    if (type !== T.AUTH) throw new wire.ProtocolError('expected AUTH');
    const msg = wire.parseJson(payload);
    const given = b64(msg.proof, 32, 32);
    const { key, ctx } = this._auth;
    this._auth = null;

    if (!given || !auth.safeEqual(given, auth.clientProof(key, ctx))) {
      this.host._recordFailure(this.address);
      this.host.emit('auth-failed', this.address);
      this.channel.fail('auth_failed', 'The access code is not correct.');
      return;
    }

    this.host._recordSuccess(this.address);
    clearTimeout(this._deadline);
    this.state = 'ready';
    this.host.sessions.add(this);
    this.channel.sendJson(T.WELCOME, {
      proof: auth.hostProof(key, ctx).toString('base64'),
      sources: this.host.sources().map((s) => s.describe()),
    });
    this.host.emit('session', this.summary());
  }

  _ready(type, payload) {
    switch (type) {
      case T.OPEN:
        this._open(wire.parseJson(payload)).catch((err) => {
          this.channel.fail(err.code === 'bad_protocol' ? 'bad_protocol' : 'internal', err.message);
        });
        return;
      case T.CLOSE:
        this.channel.end();
        return;
      case T.INPUT: {
        if (!this.stream || !this.stream.info.control) return;
        const event = input.sanitise(wire.parseJson(payload));
        if (event) this.stream.input(event);
        return;
      }
      case T.VIDEO_ACK:
        if (this.flow) this.flow.onAck(wire.parseJson(payload).seq);
        return;
      case T.VIDEO_KEY:
        if (this.stream) this.stream.requestKeyframe();
        return;
      case T.CLIPBOARD: {
        if (!this.stream || !this.stream.info.control) return;
        const { text } = wire.parseJson(payload);
        if (typeof text === 'string' && text.length <= MAX_CLIPBOARD) this.stream.clipboard(text);
        return;
      }
      case T.ACTION: {
        if (!this.stream || !this.stream.info.control) return;
        const { action } = wire.parseJson(payload);
        if (typeof action === 'string' && action.length <= 32) this.stream.action(action);
        return;
      }
      // unknown types are skipped so newer clients still work
      default:
        return;
    }
  }

  async _open(msg) {
    if (this.stream || this._opening) throw new wire.ProtocolError('a source is already open');
    this._opening = true;
    try {
      const sources = this.host.sources();
      const wanted = typeof msg.source === 'string' ? msg.source : null;
      const source = wanted ? sources.find((s) => s.describe().id === wanted) : sources[0];
      if (!source) throw new ArdpError('no_source', 'That computer or virtual machine is not available.');

      const stream = await source.open({
        peer: { address: this.address, name: this.client.name, loopback: this.loopback },
        display: msg.display === undefined ? null : msg.display,
        codecs: Array.isArray(msg.codecs) ? msg.codecs.filter((c) => typeof c === 'string').slice(0, 16) : [],
        quality: ['low', 'balanced', 'high'].includes(msg.quality) ? msg.quality : 'balanced',
        viewOnly: msg.viewOnly === true,
      });
      if (this.channel.closed) {
        stream.close();
        return;
      }

      this.stream = stream;
      this.flow = new FlowControl({
        fps: stream.fps,
        bitrate: stream.bitrate.start,
        minBitrate: stream.bitrate.min,
        maxBitrate: stream.bitrate.max,
      });

      stream.on('config', (config) => this.channel.sendJson(T.VIDEO_CONFIG, config));
      stream.on('frame', (meta, data) => {
        if (this.channel.closed) return;
        this.seq += 1;
        this.channel.sendVideoFrame({ key: meta.key, seq: this.seq, timestamp: meta.timestamp }, data);
        this.flow.onSent(this.seq);
      });
      stream.on('clipboard', (text) => this.channel.sendJson(T.CLIPBOARD, { text }));
      stream.on('end', (reason) => this.end(reason || 'source_ended'));

      this.channel.sendJson(T.OPENED, stream.info);
      stream.start();

      this._flowTimer = setInterval(() => {
        const change = this.flow.tick(this.channel.buffered);
        if (change) stream.tune(change);
      }, 250);
      this.host.emit('stream', this.summary());
    } catch (err) {
      const code = err instanceof ArdpError ? err.code : 'internal';
      this.channel.fail(code, err.message);
    } finally {
      this._opening = false;
    }
  }

  _cleanup() {
    clearTimeout(this._deadline);
    clearInterval(this._flowTimer);
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      stream.removeAllListeners();
      stream.on('error', () => {});
      try {
        stream.close();
      } catch {}
    }
    this.host.connections.delete(this);
    if (this.host.sessions.delete(this)) this.host.emit('session-end', this.summary());
  }
}

module.exports = { ArdpHost };
