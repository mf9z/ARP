'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fingerprintOf } = require('../protocol/auth');

const YEARS = 20;

function read(dir) {
  try {
    const key = fs.readFileSync(path.join(dir, 'host-key.pem'), 'utf8');
    const cert = fs.readFileSync(path.join(dir, 'host-cert.pem'), 'utf8');
    const x509 = new crypto.X509Certificate(cert);
    if (new Date(x509.validTo).getTime() < Date.now() + 24 * 3600 * 1000) return null;
    return { key, cert, fingerprint: fingerprintOf(x509.raw) };
  } catch {
    return null;
  }
}

async function create(dir, name) {
  const selfsigned = require('selfsigned');
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + YEARS);
  const pems = await selfsigned.generate([{ name: 'commonName', value: `ARDP ${name}`.slice(0, 64) }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate,
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'host-key.pem'), pems.private, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'host-cert.pem'), pems.cert, { mode: 0o644 });
  const x509 = new crypto.X509Certificate(pems.cert);
  return { key: pems.private, cert: pems.cert, fingerprint: fingerprintOf(x509.raw) };
}

async function loadIdentity(dir, name) {
  return read(dir) || create(dir, name);
}

module.exports = { loadIdentity };
