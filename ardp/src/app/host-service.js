'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const auth = require('../protocol/auth');
const { ArdpHost } = require('../host/host');
const { loadIdentity } = require('../host/identity');
const { DesktopSource } = require('./host/desktop-source');
const { NativeInput } = require('./host/input');
const permissions = require('./host/permissions');

const TUNNEL = /mullvad|wireguard|nordlynx|openvpn|proton|vpn|tailscale|zerotier|hamachi|^wgd|^tund|^tapd|^utun/i;
const VIRTUAL = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|bluetooth|^bridge|^veth|^virbr/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function localAddresses() {
  const found = [];
  for (const [adapter, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      // lan first, then vpn tunnels, then virtual switches
      const rank = VIRTUAL.test(adapter) ? 3 : TUNNEL.test(adapter) ? 2 : PRIVATE.test(entry.address) ? 0 : 1;
      found.push({ address: entry.address, rank });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.address);
}

class HostService extends EventEmitter {
  constructor({ config, dir, version, extraSources, approve }) {
    super();
    this.config = config;
    this.extraSources = extraSources || (() => []);
    this.approve = approve || null;
    this.dir = dir;
    // a mac calls itself studio.local
    this.name = os.hostname().replace(/\.local$/i, '');
    this.info = { name: this.name, platform: process.platform, version };
    this.input = NativeInput.load();
    this.identity = null;
    this.host = null;
    this.local = null;
    this.code = null;
    this.credential = null;
    this.error = null;
    this.busy = false;
  }

  async init() {
    this.identity = await loadIdentity(path.join(this.dir, 'identity'), this.name, {
      seal: (text) => this.config.seal(text),
      unseal: (text) => this.config.unseal(text),
    });

    const settings = this.config.data.host;
    const stored = await this.config.unseal(settings.code);
    const salt = typeof settings.salt === 'string' ? Buffer.from(settings.salt, 'base64') : null;
    if (stored && salt && salt.length >= 8) await this._useCode(stored, salt, false);
    else await this._useCode(auth.generateCode(), crypto.randomBytes(16), true);

    const desktop = new DesktopSource({
      name: this.name,
      input: this.input,
      // without the system's say-so the pointer would not move, so such a session only watches
      allowControl: () => this.config.data.host.allowControl !== false && permissions.status().control,
    });
    const options = {
      identity: this.identity,
      info: this.info,
      credential: () => this.credential,
      sources: () => [desktop, ...this.extraSources()],
    };
    this.host = new ArdpHost({
      ...options,
      approve: (who, signal) => (this.approve && this.config.data.host.askFirst !== false ? this.approve(who, signal) : true),
    });
    // a second listener on loopback only, for opening this computer's own vms. it has
    // its own secret that never leaves this process, serves vms and nothing else, and
    // does not know the access code people are given
    this.localCode = crypto.randomBytes(24).toString('hex');
    const localSalt = crypto.randomBytes(16);
    const localCredential = { salt: localSalt, key: await auth.deriveKey(this.localCode, localSalt) };
    this.local = new ArdpHost({
      identity: this.identity,
      info: this.info,
      credential: () => localCredential,
      sources: () => this.extraSources(),
      lockout: false,
      local: true,
    });
    for (const event of ['session', 'session-end', 'stream']) this.host.on(event, () => this._changed());
    this.host.on('error', (err) => {
      this.error = err.message;
      this._changed();
    });

    if (settings.enabled) await this._listen();
  }

  state() {
    const settings = this.config.data.host;
    return {
      name: this.name,
      enabled: !!settings.enabled,
      listening: !!(this.host && this.host.listening),
      port: settings.port,
      allowControl: settings.allowControl !== false,
      askFirst: settings.askFirst !== false,
      canControl: !!this.input && permissions.status().control,
      permissions: permissions.status(),
      code: this.code,
      addresses: localAddresses(),
      fingerprint: this.identity ? this.identity.fingerprint : '',
      error: this.error,
      sessions: this.host ? this.host.list() : [],
    };
  }

  async setEnabled(enabled) {
    this.config.data.host.enabled = !!enabled;
    this.config.save();
    if (enabled) await this._listen();
    else await this._stop();
    this._changed();
  }

  async setPort(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
    if (port === this.config.data.host.port) return;
    this.config.data.host.port = port;
    this.config.save();
    if (this.config.data.host.enabled) {
      await this._stop();
      await this._listen();
    }
    this._changed();
  }

  setAllowControl(allow) {
    this.config.data.host.allowControl = !!allow;
    this.config.save();
    if (this.host) this.host.disconnect(undefined, 'kicked');
    this._changed();
  }

  async newCode() {
    await this._useCode(auth.generateCode(), crypto.randomBytes(16), true);
    if (this.host) this.host.disconnect(undefined, 'kicked');
    this._changed();
  }

  setAskFirst(ask) {
    this.config.data.host.askFirst = !!ask;
    this.config.save();
    this._changed();
  }

  disconnect(id) {
    if (this.host) this.host.disconnect(id, 'kicked');
  }

  async localPort() {
    if (!this.local.listening) await this.local.listen(0, '127.0.0.1');
    return this.local.server.address().port;
  }

  async shutdown() {
    if (this.local) await this.local.close();
    if (this.host) await this._stop();
  }

  async _useCode(code, salt, persist) {
    const key = await auth.deriveKey(code, salt);
    this.code = code;
    this.credential = { salt, key };
    if (persist) {
      this.config.data.host.code = await this.config.seal(code);
      this.config.data.host.salt = salt.toString('base64');
      this.config.save();
    }
  }

  async _listen() {
    if (!this.host || this.host.listening) return;
    const port = this.config.data.host.port;
    try {
      await this.host.listen(port, this.config.data.host.bind || undefined);
      this.error = null;
    } catch (err) {
      this.error = err.code === 'EADDRINUSE' ? `Port ${port} is being used by another program.` : err.message;
    }
  }

  async _stop() {
    this.error = null;
    await this.host.close();
  }

  _changed() {
    this.emit('change', this.state());
  }
}

module.exports = { HostService };
