'use strict';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { defaultPort } = require('../common/product');

const DEFAULTS = {
  host: {
    enabled: false,
    port: defaultPort,
    bind: '',
    code: null,
    salt: null,
    allowControl: true,
  },
  client: {
    recent: [],
    known: {},
    quality: 'balanced',
    viewOnly: false,
    fullScreen: false,
  },
  app: {
    startAtLogin: false,
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  for (const key of Object.keys(base)) {
    const value = extra[key];
    if (value === undefined) continue;
    const isMap = base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]);
    if (isMap && Object.keys(base[key]).length > 0) merge(base[key], value);
    else if (typeof value === typeof base[key] || base[key] === null) base[key] = value;
  }
  return base;
}

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = clone(DEFAULTS);
    try {
      merge(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
  }

  save() {
    const temp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  // secrets go through the os credential store when there is one
  async seal(text) {
    try {
      if (typeof safeStorage.encryptStringAsync === 'function') {
        if (await safeStorage.isAsyncEncryptionAvailable()) {
          return `os:${(await safeStorage.encryptStringAsync(text)).toString('base64')}`;
        }
      } else if (safeStorage.isEncryptionAvailable()) {
        return `os:${safeStorage.encryptString(text).toString('base64')}`;
      }
    } catch {}
    return `plain:${text}`;
  }

  async unseal(value) {
    if (typeof value !== 'string') return null;
    try {
      if (value.startsWith('os:')) {
        const sealed = Buffer.from(value.slice(3), 'base64');
        if (typeof safeStorage.decryptStringAsync === 'function') return (await safeStorage.decryptStringAsync(sealed)).result;
        return safeStorage.decryptString(sealed);
      }
      if (value.startsWith('plain:')) return value.slice(6);
    } catch {}
    return null;
  }
}

module.exports = { Config };
