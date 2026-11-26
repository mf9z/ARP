'use strict';

const crypto = require('crypto');

const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1, length: 32 });
// no 0/o or 1/i/l, easier to read out loud
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normaliseCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

function generateCode(groups = 3, groupLength = 4) {
  const out = [];
  for (let g = 0; g < groups; g++) {
    let part = '';
    for (let i = 0; i < groupLength; i++) part += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    out.push(part);
  }
  return out.join('-');
}

function randomNonce() {
  return crypto.randomBytes(32);
}

function deriveKey(code, salt, kdf = KDF) {
  if (!kdf || kdf.name !== 'scrypt') return Promise.reject(new Error('unsupported key derivation'));
  const N = Number(kdf.N);
  const r = Number(kdf.r);
  const p = Number(kdf.p);
  if (!(N >= 1024 && N <= 1 << 20) || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4)) {
    return Promise.reject(new Error('unreasonable key derivation parameters'));
  }
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(normaliseCode(code), 'utf8'),
      salt,
      32,
      { N, r, p, maxmem: 256 * N * r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

// the proof covers the cert fingerprint, so someone in the middle can't relay it
function proof(label, key, { clientNonce, hostNonce, fingerprint }) {
  return crypto
    .createHmac('sha256', key)
    .update(`ardp1/${label}`)
    .update(clientNonce)
    .update(hostNonce)
    .update(normaliseFingerprint(fingerprint), 'utf8')
    .digest();
}

const clientProof = (key, ctx) => proof('client', key, ctx);
const hostProof = (key, ctx) => proof('host', key, ctx);

function safeEqual(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normaliseFingerprint(fingerprint) {
  return String(fingerprint || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
}

function fingerprintOf(der) {
  const hex = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
  return hex.match(/.{2}/g).join(':');
}

module.exports = {
  KDF,
  normaliseCode,
  generateCode,
  randomNonce,
  deriveKey,
  clientProof,
  hostProof,
  safeEqual,
  normaliseFingerprint,
  fingerprintOf,
};
