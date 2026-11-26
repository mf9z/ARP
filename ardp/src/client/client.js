'use strict';

const tls = require('tls');
const { EventEmitter } = require('events');
const wire = require('../protocol/wire');
const auth = require('../protocol/auth');
const { Channel } = require('../protocol/channel');
const { ArdpError, fromSocketError } = require('../protocol/errors');

const { T } = wire;

class ArdpClient extends EventEmitter {
  constructor({ host, port, accessCode, info, trust, timeout = 10000 }) {
    super();
    this.host = host;
    this.port = port;
    this.accessCode = accessCode;
    this.info = info;
    this.trust = trust || null;
    this.timeout = timeout;
    this.channel = null;
    this.remote = null;
    this.sources = [];
    this.fingerprint = null;
    this.opened = null;
    this._waiter = null;
    this._closed = false;
    this._connected = false;
    this._reason = null;
  }

  get rtt() {
    return this.channel ? this.channel.rtt : null;
  }

  async connect() {
    const socket = await this._dial();
    let binding;
    try {
      this.fingerprint = auth.fingerprintOf(socket.getPeerCertificate(true).raw);
      binding = auth.sessionBinding(socket);
    } catch (err) {
      socket.destroy();
      throw new ArdpError('bad_protocol', 'The other end is not an ARDP host.');
    }

    // until the other side has proved itself it gets little room
    this.channel = new Channel(socket, { limit: 256 * 1024 });
    this.channel.on('message', (type, payload) => this._onMessage(type, payload));
    this.channel.on('close', (err) => this._onClose(err));

    try {
      const clientNonce = auth.randomNonce();
      this.channel.sendJson(T.HELLO, { v: wire.VERSION, client: this.info, nonce: clientNonce.toString('base64') });

      const challenge = await this._expect(T.CHALLENGE);
      if (challenge.v !== wire.VERSION) throw new ArdpError('version', 'The other computer runs an incompatible version of ARDP.');
      const hostNonce = Buffer.from(String(challenge.nonce || ''), 'base64');
      const salt = Buffer.from(String(challenge.salt || ''), 'base64');
      if (hostNonce.length < 16 || salt.length < 8) throw new ArdpError('bad_protocol', 'Malformed challenge.');
      const remote = challenge.host && typeof challenge.host === 'object' ? challenge.host : {};
      this.remote = {
        name: String(remote.name || this.host).slice(0, 64),
        platform: String(remote.platform || '').slice(0, 16),
        version: String(remote.version || '').slice(0, 16),
      };

      const id = `${this.host}:${this.port}`;
      const known = this.trust ? this.trust.get(id) : undefined;
      if (known && auth.normaliseFingerprint(known) !== auth.normaliseFingerprint(this.fingerprint)) {
        const proceed = this.trust.changed ? await this.trust.changed({ id, known, presented: this.fingerprint, name: this.remote.name }) : false;
        if (!proceed) throw new ArdpError('identity_changed', 'The identity of the other computer has changed.');
        if (this._closed) throw this._reason || new ArdpError('lost', 'The connection was lost.');
      }

      let key;
      try {
        key = await auth.deriveKey(this.accessCode, salt, challenge.kdf);
      } catch (err) {
        throw new ArdpError('bad_protocol', err.message);
      }
      const ctx = { clientNonce, hostNonce, fingerprint: this.fingerprint, binding };
      this.channel.sendJson(T.AUTH, { proof: auth.clientProof(key, ctx).toString('base64') });

      const welcome = await this._expect(T.WELCOME);
      const proof = Buffer.from(String(welcome.proof || ''), 'base64');
      // a host that lets us in without knowing the code is not the real one
      if (!auth.safeEqual(proof, auth.hostProof(key, ctx))) {
        throw new ArdpError('host_untrusted', 'The other computer could not prove its identity.');
      }
      this.sources = Array.isArray(welcome.sources) ? welcome.sources : [];
      if (this.trust) this.trust.set(id, this.fingerprint);
      this.channel.setLimit(wire.MAX_MESSAGE);
      this._connected = true;
      return { remote: this.remote, sources: this.sources, fingerprint: this.fingerprint };
    } catch (err) {
      const error = err instanceof ArdpError ? err : fromSocketError(err);
      this._reason = this._reason || error;
      this.channel.destroy();
      throw error;
    }
  }

  async open({ source, display, codecs, quality, viewOnly } = {}) {
    if (!this._connected) throw new ArdpError('closed', 'Not connected.');
    this.channel.sendJson(T.OPEN, { source, display, codecs, quality, viewOnly: !!viewOnly });
    try {
      // the other side may be asking its user, so this one waits longer
      this.opened = await this._expect(T.OPENED, 90000);
      return this.opened;
    } catch (err) {
      const error = err instanceof ArdpError ? err : fromSocketError(err);
      this._reason = this._reason || error;
      this.channel.destroy();
      throw error;
    }
  }

  sendInput(event) {
    if (this.channel && !this._closed) this.channel.sendJson(T.INPUT, event);
  }

  ack(seq) {
    if (this.channel && !this._closed) this.channel.sendJson(T.VIDEO_ACK, { seq });
  }

  requestKeyframe() {
    if (this.channel && !this._closed) this.channel.send(T.VIDEO_KEY);
  }

  sendAction(action) {
    if (this.channel && !this._closed) this.channel.sendJson(T.ACTION, { action });
  }

  sendClipboard(text) {
    if (this.channel && !this._closed) this.channel.sendJson(T.CLIPBOARD, { text });
  }

  close() {
    if (!this.channel || this._closed) return;
    this._reason = this._reason || new ArdpError('closed', 'Disconnected.');
    this.channel.sendJson(T.CLOSE, { reason: 'closed' });
    this.channel.end();
  }

  abort() {
    this._reason = new ArdpError('cancelled', 'Cancelled.');
    if (this.channel) this.channel.destroy();
    else if (this._socket) this._socket.destroy(this._reason);
  }

  _dial() {
    return new Promise((resolve, reject) => {
      if (this._reason) {
        reject(this._reason);
        return;
      }
      let settled = false;
      const done = (err, socket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          sock.destroy();
          reject(fromSocketError(err));
        } else resolve(socket);
      };
      const sock = tls.connect({
        host: this.host,
        port: this.port,
        ALPNProtocols: [wire.ALPN],
        minVersion: 'TLSv1.2',
        // self-signed host cert: identity comes from the access code proof instead
        rejectUnauthorized: false,
      });
      this._socket = sock;
      const timer = setTimeout(() => done(new ArdpError('unreachable', 'The computer did not answer.')), this.timeout);
      sock.once('error', (err) => done(err));
      sock.once('secureConnect', () => {
        if (sock.alpnProtocol !== wire.ALPN) {
          done(new ArdpError('bad_protocol', 'The other end is not an ARDP host.'));
          return;
        }
        done(null, sock);
      });
    });
  }

  _expect(type, wait = this.timeout + 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        reject(new ArdpError('timeout', 'The other computer stopped answering.'));
      }, wait);
      this._waiter = {
        type,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  _onMessage(type, payload) {
    // the computer we connected to may show us things. it may never ask, steer or open anything here
    if (wire.FROM_CLIENT.has(type)) throw new wire.ProtocolError('the other computer tried to turn the connection around');
    if (type === T.VIDEO_FRAME) {
      this.emit('video-frame', wire.unpackVideoFrame(payload));
      return;
    }
    const msg = wire.parseJson(payload);

    if (type === T.ERROR || type === T.CLOSE) {
      const code = typeof msg.code === 'string' ? msg.code : typeof msg.reason === 'string' ? msg.reason : 'closed';
      this._reason = new ArdpError(code, typeof msg.message === 'string' ? msg.message : undefined);
      const waiter = this._waiter;
      this._waiter = null;
      if (waiter) waiter.reject(this._reason);
      return;
    }

    if (this._waiter && this._waiter.type === type) {
      const waiter = this._waiter;
      this._waiter = null;
      waiter.resolve(msg);
      return;
    }

    switch (type) {
      case T.WAIT:
        this.emit('waiting', msg.for);
        break;
      case T.VIDEO_CONFIG:
        this.emit('video-config', msg);
        break;
      case T.CLIPBOARD:
        if (typeof msg.text === 'string') this.emit('clipboard', msg.text);
        break;
      default:
        break;
    }
  }

  _onClose(err) {
    if (this._closed) return;
    this._closed = true;
    const reason = this._reason || fromSocketError(err);
    const waiter = this._waiter;
    this._waiter = null;
    if (waiter) waiter.reject(reason);
    if (this._connected) this.emit('close', { code: reason.code, message: reason.message });
  }
}

module.exports = { ArdpClient };
