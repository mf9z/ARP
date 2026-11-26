'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { scrubber, deep, findable } = require('../src/common/privacy');

const scrub = scrubber(() => ['K7QM-2RXD-9TLA']);

test('addresses never survive, wherever they sit in a sentence', () => {
  const cases = [
    '192.168.1.20 could not be reached.',
    'connect ECONNREFUSED 10.0.0.7:7389',
    'listen EADDRINUSE: address already in use 0.0.0.0:7389',
    'Too many attempts from (203.0.113.9).',
    'peer fe80::1c2d:3e4f:5a6b:7c8d went away',
    'bound to [2001:db8::17]:7389',
    'loopback ::1 answered',
  ];
  for (const text of cases) {
    const out = scrub(text);
    assert.doesNotMatch(out, /\d+\.\d+\.\d+\.\d+/, text);
    assert.doesNotMatch(out, /[0-9a-f]{1,4}:[0-9a-f:]*:[0-9a-f]{1,4}/i, text);
    assert.match(out, /hidden/, text);
  }
});

test('home folders, this computer and its code are taken out too', () => {
  assert.equal(scrub('could not open C:\\Users\\rohan\\Downloads\\win11.iso'), 'could not open C:\\Users\\hidden\\Downloads\\win11.iso');
  assert.equal(scrub('no such file /home/rohan/isos/alpine.iso'), 'no such file /home/hidden/isos/alpine.iso');
  assert.equal(scrub('/Users/rohan/Library/x'), '/Users/hidden/Library/x');
  assert.equal(scrub('the code K7QM-2RXD-9TLA was refused'), 'the code hidden was refused');
  if (findable(os.hostname())) assert.doesNotMatch(scrub(`${os.hostname().toLowerCase()} is busy`), new RegExp(os.hostname(), 'i'));
});

test('a computer named with a plain word does not blank that word everywhere', () => {
  assert.equal(findable('desktop'), false);
  assert.equal(findable('DESKTOP-7QK2'), true);
  assert.equal(findable('rohans-pc'), true);
  assert.equal(findable('pc1'), false);
});

test('ordinary text is left alone', () => {
  for (const text of ['Version 0.1.0', 'Waiting for connections on port 7389.', 'Display 2 (main)', 'Saved computer 3', 'vm:quiet-vm', '4096 MB, with 2 processors', 'note: nothing to do', 'Aesthetic Remote Desktop Protocol']) {
    assert.equal(scrub(text), text);
  }
});

test('a whole payload is cleaned, except the ids the app needs back', () => {
  const out = deep({ id: '10.0.0.7', text: 'at 10.0.0.7', list: [{ id: 'vm:a', error: 'C:\\Users\\rohan\\a.qcow2 is locked' }], port: 7389, on: true, bytes: new Uint8Array([1, 2]) }, scrub);
  assert.equal(out.id, '10.0.0.7');
  assert.equal(out.text, 'at hidden');
  assert.equal(out.list[0].id, 'vm:a');
  assert.equal(out.list[0].error, 'C:\\Users\\hidden\\a.qcow2 is locked');
  assert.equal(out.port, 7389);
  assert.equal(out.on, true);
  assert.deepEqual([...out.bytes], [1, 2]);
});
