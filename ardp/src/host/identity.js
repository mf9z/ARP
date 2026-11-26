'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fingerprintOf } = require('../protocol/auth');

const YEARS = 20;

const describe = (key, cert) => {
  const x509 = new crypto.X509Certificate(cert);
  if (new Date(x509.validTo).getTime() < Date.now() + 24 * 3600 * 1000) return null;
  return { key, cert, fingerprint: fingerprintOf(x509.raw) };
};

async function read(dir, { seal, unseal }) {
  const plain = path.join(dir, 'host-key.pem');
  const sealed = path.join(dir, 'host-key.sealed');
  try {
    const cert = fs.readFileSync(path.join(dir, 'host-cert.pem'), 'utf8');
    let key = null;
    if (unseal && fs.existsSync(sealed)) key = await unseal(fs.readFileSync(sealed, 'utf8'));
    if (!key && fs.existsSync(plain)) {
      key = fs.readFileSync(plain, 'utf8');
      // an older install left the key readable; put it away
      if (seal) {
        fs.writeFileSync(sealed, await seal(key), { mode: 0o600 });
        fs.rmSync(plain);
      }
    }
    return key ? describe(key, cert) : null;
  } catch {
    return null;
  }
}

async function create(dir, name, { seal }) {
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
  // with the key, someone in the middle could pose as this computer, so it goes
  // through the os credential store when the app gives us one
  if (seal) fs.writeFileSync(path.join(dir, 'host-key.sealed'), await seal(pems.private), { mode: 0o600 });
  else fs.writeFileSync(path.join(dir, 'host-key.pem'), pems.private, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'host-cert.pem'), pems.cert, { mode: 0o644 });
  return describe(pems.private, pems.cert);
}

async function loadIdentity(dir, name, sealing = {}) {
  return (await read(dir, sealing)) || create(dir, name, sealing);
}

module.exports = { loadIdentity };
