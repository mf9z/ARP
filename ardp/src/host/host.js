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
const { scrubber } = require('../common/privacy');

const { T } = wire;

const HANDSHAKE_TIMEOUT = 15000;
const MAX_CONNECTIONS = 16;
const MAX_PER_ADDRESS = 4;
const IDLE_AFTER_AUTH = 120000;
// a stranger gets a few kilobytes; a client with the code gets room for a clipboard
const LIMIT_STRANGER = 4096;
const LIMIT_CLIENT = 4 * 1024 * 1024;
const MAX_CLIPBOARD = 1024 * 1024;
const FAILURES_BEFORE_LOCK = 5;

const tidyAddress = (address) => String(address || '').replace(/^::ffff:/i, '');

// a name the other side gave itself ends up in lists and questions on this screen.
// nothing in it may change how the line around it reads
const label = (text, max) =>
  String(text || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, max);

// a client is told what failed, not what this computer's folders, user or addresses are called
const scrub = scrubber();
const telling = (code, message) => (code === 'internal' ? 'Something went wrong on the other computer.' : scrub(String(message || '')).slice(0, 300));

// a client may show a certificate of its own. that it holds the key is proved by tls
// itself, so the fingerprint is something to know this client by the next time
function identityOf(socket) {
  try {
    const cert = socket.getPeerCertificate(true);
    return cert && cert.raw ? auth.fingerprintOf(cert.raw) : '';
  } catch {
    return '';
  }
}
const b64 = (text, min, max) => {
  if (typeof text !== 'string' || text.length > 512) return null;
  const buf = Buffer.from(text, 'base64');
  return buf.length >= min && buf.length <= max ? buf : null;
};

class ArdpHost extends EventEmitter {
  constructor({ identity, info, credential, sources, approve, trusted, lockout = true, local = false }) {
    super();
    this.approve = approve || null;
    // says whether a client is let in without the question, so nobody is told to wait for nothing
    this.trusted = trusted || null;
    this.lockout = lockout;
    this.local = local;
    this._asking = new Set();
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
        // the client's certificate is asked for, not judged: it is self-signed like ours
        { key: this.identity.key, cert: this.identity.cert, ALPNProtocols: [wire.ALPN], minVersion: 'TLSv1.2', handshakeTimeout: 10000, requestCert: true, rejectUnauthorized: false },
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

  // everything one computer has open here, whichever address it came from
  disconnectIdentity(identity, reason = 'kicked') {
    const wanted = auth.normaliseFingerprint(identity);
    if (!wanted) return;
    for (const session of [...this.connections]) {
      if (auth.normaliseFingerprint(session.clientIdentity) === wanted) session.end(reason);
    }
  }

  _accept(socket) {
    const address = tidyAddress(socket.remoteAddress);
    const sameAddress = [...this.connections].filter((s) => s.address === address).length;
    // one address cannot take every slot
    if (this.connections.size >= MAX_CONNECTIONS || (!this.local && sameAddress >= MAX_PER_ADDRESS)) {
      socket.destroy();
      return;
    }
    const session = new HostSession(this, socket);
    this.connections.add(session);
  }

  _lockedFor(address, now = Date.now()) {
    if (!this.lockout) return 0;
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
    this.clientIdentity = identityOf(socket);
    this.client = { name: '', platform: '', version: '' };
    this.since = Date.now();
    this.state = 'hello';
    this.stream = null;
    this.flow = null;
    this.seq = 0;
    this._opening = false;
    this._asking = null;
    this._flowTimer = null;
    this._auth = null;

    this.socket = socket;
    this.channel = new Channel(socket, { limit: LIMIT_STRANGER });
    this.channel.on('message', (type, payload) => this._onMessage(type, payload));
    this.channel.on('close', () => this._cleanup());
    this._deadline = setTimeout(() => this.channel.fail('timeout', 'The handshake took too long.'), HANDSHAKE_TIMEOUT);
  }

  summary() {
    return {
      id: this.id,
      address: this.address,
      identity: this.clientIdentity,
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
      this._fail(err.code === 'bad_protocol' ? 'bad_protocol' : 'internal', err.message);
    }
  }

  _fail(code, message) {
    this.channel.fail(code, telling(code, message));
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
      name: label(client.name, 64),
      platform: label(client.platform, 16),
      version: label(client.version, 16),
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
    const binding = auth.sessionBinding(this.socket);
    this._auth = { key: credential.key, ctx: { clientNonce, hostNonce, fingerprint: this.host.identity.fingerprint, binding } };
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
    this.channel.setLimit(LIMIT_CLIENT);
    // connected is not the same as doing something: open a source or go
    this._deadline = setTimeout(() => this.end('timeout'), IDLE_AFTER_AUTH);
    this.channel.sendJson(T.WELCOME, {
      proof: auth.hostProof(key, ctx).toString('base64'),
      sources: this.host.sources().map((s) => s.describe()),
    });
    this.host.emit('session', this.summary());
  }

  _ready(type, payload) {
    if (wire.FROM_HOST.has(type)) throw new wire.ProtocolError('a client cannot act as the host');
    switch (type) {
      case T.OPEN:
        this._open(wire.parseJson(payload)).catch((err) => {
          this._fail(err.code === 'bad_protocol' ? 'bad_protocol' : 'internal', err.message);
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
    clearTimeout(this._deadline);
    try {
      const sources = this.host.sources();
      const wanted = typeof msg.source === 'string' ? msg.source : null;
      const source = wanted ? sources.find((s) => s.describe().id === wanted) : sources[0];
      if (!source) throw new ArdpError('no_source', 'That computer or virtual machine is not available.');

      // someone at this computer gets to say yes or no first
      const about = source.describe();
      const who = { address: this.address, identity: this.clientIdentity, name: this.client.name, source: about.id, kind: about.kind, sourceName: about.name, viewOnly: msg.viewOnly === true };
      if (this.host.approve && !(this.host.trusted && this.host.trusted(who))) {
        // one question per address at a time, so the screen cannot be flooded with them
        if (this.host._asking.has(this.address)) throw new ArdpError('denied', 'The other computer is already being asked.');
        this.host._asking.add(this.address);
        this._asking = new AbortController();
        this.channel.sendJson(T.WAIT, { for: 'approval' });
        const allowed = await this.host.approve(who, this._asking.signal);
        this._asking = null;
        this.host._asking.delete(this.address);
        if (this.channel.closed) return;
        if (!allowed) {
          // a no counts like a wrong code, so asking again and again locks the address out
          this.host._recordFailure(this.address);
          throw new ArdpError('denied', 'The other computer did not allow the connection.');
        }
      }

      const stream = await source.open({
        peer: { address: this.address, name: this.client.name, loopback: this.loopback, local: this.host.local },
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
      this._fail(code, err.message);
    } finally {
      this._opening = false;
    }
  }

  _cleanup() {
    clearTimeout(this._deadline);
    if (this._asking) {
      this._asking.abort();
      this.host._asking.delete(this.address);
    }
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
