'use strict';

const crypto = require('crypto');
const { normaliseFingerprint } = require('../protocol/auth');

const MAX = 32;

const real = (identity) => normaliseFingerprint(identity).length === 64;
const same = (a, b) => normaliseFingerprint(a) === normaliseFingerprint(b);

// computers that were let in once and are not asked about again. each is known by the
// fingerprint of the certificate it connects with, and nobody can show that without
// the key behind it. an operator still needs the access code like anyone else
class Operators {
  // `read` gives the saved list, `write` takes the new one
  constructor(read, write) {
    this.read = read;
    this.write = write;
  }

  list() {
    const saved = this.read();
    return (Array.isArray(saved) ? saved : [])
      .filter((o) => o && typeof o === 'object' && real(o.identity) && typeof o.tag === 'string' && o.tag)
      .slice(0, MAX)
      .map((o) => ({ tag: o.tag, identity: String(o.identity), name: String(o.name || '').slice(0, 64), since: Number(o.since) || 0 }));
  }

  has(identity) {
    return real(identity) && this.list().some((o) => same(o.identity, identity));
  }

  add(identity, name) {
    if (!real(identity)) throw new Error('That computer did not show an identity of its own, so it cannot be remembered.');
    const list = this.list();
    if (list.some((o) => same(o.identity, identity))) return;
    if (list.length >= MAX) throw new Error(`There can be at most ${MAX} operators.`);
    // the tag is what a window refers to it by, so the identity itself never has to leave
    list.push({ tag: crypto.randomBytes(6).toString('hex'), identity: String(identity), name: String(name || '').slice(0, 64), since: Date.now() });
    this.write(list);
  }

  remove(tag) {
    const list = this.list();
    const rest = list.filter((o) => o.tag !== tag);
    if (rest.length !== list.length) this.write(rest);
  }
}

module.exports = { Operators };
