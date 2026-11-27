'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Operators } = require('../src/host/operators');
const { fingerprintOf } = require('../src/protocol/auth');

const someone = () => fingerprintOf(crypto.randomBytes(64));

function store(saved = []) {
  const box = { saved, writes: 0 };
  box.operators = new Operators(
    () => box.saved,
    (list) => {
      box.saved = list;
      box.writes += 1;
    },
  );
  return box;
}

test('an operator is remembered by identity, once', () => {
  const box = store();
  const a = someone();
  const b = someone();
  assert.equal(box.operators.has(a), false);

  box.operators.add(a, 'Studio');
  box.operators.add(a, 'Studio again');
  assert.equal(box.writes, 1);
  assert.equal(box.operators.has(a), true);
  assert.equal(box.operators.has(a.toLowerCase().replace(/:/g, '')), true, 'however the fingerprint is written');
  assert.equal(box.operators.has(b), false);

  const [entry] = box.operators.list();
  assert.equal(entry.name, 'Studio');
  assert.match(entry.tag, /^[0-9a-f]{12}$/);
  assert.ok(entry.since > 0);
});

test('nobody is an operator without an identity', () => {
  const box = store();
  for (const none of ['', null, undefined, 'AA:BB', 'not a fingerprint']) {
    assert.equal(box.operators.has(none), false);
    assert.throws(() => box.operators.add(none, 'x'), /cannot be remembered/);
  }
  assert.equal(box.writes, 0);
});

test('an operator is removed by its tag and asked again from then on', () => {
  const box = store();
  const a = someone();
  const b = someone();
  box.operators.add(a, 'A');
  box.operators.add(b, 'B');
  const tagOfA = box.operators.list().find((o) => o.name === 'A').tag;
  box.operators.remove('no such tag');
  assert.equal(box.operators.list().length, 2);
  box.operators.remove(tagOfA);
  assert.equal(box.operators.has(a), false);
  assert.equal(box.operators.has(b), true);
});

test('a damaged or oversized list is read with care', () => {
  const good = { tag: 'abcdef012345', identity: someone(), name: 'Good', since: 1 };
  const box = store([null, 'text', { tag: 'x', identity: 'short' }, { identity: someone() }, good, { ...good, name: 'x'.repeat(200), tag: 'bbbbbbbbbbbb', identity: someone() }]);
  const list = box.operators.list();
  assert.deepEqual(list.map((o) => o.tag), ['abcdef012345', 'bbbbbbbbbbbb']);
  assert.equal(list[1].name.length, 64);
  assert.equal(store('nonsense').operators.list().length, 0);
  assert.equal(store({ 0: good }).operators.list().length, 0);

  const full = store();
  for (let i = 0; i < 32; i++) full.operators.add(someone(), `pc ${i}`);
  assert.throws(() => full.operators.add(someone(), 'one too many'), /at most 32/);
});
