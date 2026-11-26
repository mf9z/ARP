'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { VmStore, Vm, VmDisplay, Qmp, buildArgs } = require('../src');
const keys = require('../src/keys');
const { startFake } = require('../dev/fake');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));
const fakeQemu = path.join(__dirname, '..', 'dev', 'fake-qemu.js');
const launcher = (env = {}) => (args) =>
  spawn(process.execPath, [fakeQemu, ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });

async function fakeWithDisplay(t, options) {
  const fake = await startFake(options);
  const display = await VmDisplay.connect(fake.vncPort, { fps: 50 });
  t.after(() => {
    display.close();
    fake.close();
  });
  return { fake, display };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-vm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('reads the whole screen, then keeps getting changes', async (t) => {
  const { fake, display } = await fakeWithDisplay(t, { width: 320, height: 200 });
  assert.deepEqual([display.width, display.height], [320, 200]);

  const rects = [];
  let frames = 0;
  display.on('rect', (r) => rects.push(r));
  display.on('frame', () => (frames += 1));
  display.refresh();
  await once(display, 'frame');

  assert.equal(rects.length, 1);
  assert.deepEqual([rects[0].x, rects[0].y, rects[0].width, rects[0].height], [0, 0, 320, 200]);
  assert.equal(rects[0].data.length, 320 * 200 * 4);
  // pixel (160, 100) of the test picture, stored b g r x
  const p = (100 * 320 + 160) * 4;
  assert.deepEqual([...rects[0].data.subarray(p, p + 2)], [127, 127]);

  await sleep(400);
  assert.ok(frames >= 5, `only ${frames} frames`);
  assert.ok(frames <= 26, `${frames} frames is more than 50 a second`);
  assert.ok(rects.slice(1).every((r) => r.width === 16 && r.height === 16));
  assert.ok(fake.state.encodings.includes(-258) && fake.state.encodings.includes(-223));
});

test('pointer, buttons and wheel reach the guest', async (t) => {
  const { fake, display } = await fakeWithDisplay(t, { width: 320, height: 200 });
  display.input({ t: 'move', x: 0.5, y: 1 });
  display.input({ t: 'button', b: 0, down: true, x: 0, y: 0 });
  display.input({ t: 'button', b: 2, down: true });
  display.input({ t: 'button', b: 0, down: false });
  display.input({ t: 'wheel', dx: 0, dy: 250 });
  display.input({ t: 'wheel', dx: 0, dy: -150 });
  display.input({ t: 'release' });
  await sleep(80);
  assert.deepEqual(
    fake.state.events.map((e) => [e.x, e.y, e.mask]),
    [
      [160, 199, 0],
      [0, 0, 1],
      [0, 0, 5],
      [0, 0, 4],
      [0, 0, 4 | 16],
      [0, 0, 4],
      [0, 0, 4 | 16],
      [0, 0, 4],
      [0, 0, 4 | 8],
      [0, 0, 4],
      [0, 0, 0],
    ],
  );
});

test('keys go as scancodes to qemu, and are let go on release', async (t) => {
  const { fake, display } = await fakeWithDisplay(t);
  display.refresh();
  await once(display, 'frame');
  display.input({ t: 'key', code: 'KeyA', down: true });
  display.input({ t: 'key', code: 'KeyA', down: false });
  display.input({ t: 'key', code: 'ArrowUp', down: true });
  display.input({ t: 'key', code: 'ShiftLeft', down: true });
  display.input({ t: 'key', code: 'KeyZ', down: false });
  display.input({ t: 'key', code: 'NotAKey', down: true });
  display.input({ t: 'release' });
  display.tap(['ControlLeft', 'AltLeft', 'Delete']);
  await sleep(80);
  assert.deepEqual(
    fake.state.events.map((e) => [e.t, e.code, e.down]),
    [
      ['xkey', 0x1e, true],
      ['xkey', 0x1e, false],
      ['xkey', 0xc8, true],
      ['xkey', 0x2a, true],
      ['xkey', 0xc8, false],
      ['xkey', 0x2a, false],
      ['xkey', 0x1d, true],
      ['xkey', 0x38, true],
      ['xkey', 0xd3, true],
      ['xkey', 0xd3, false],
      ['xkey', 0x38, false],
      ['xkey', 0x1d, false],
    ],
  );
});

test('a plain vnc server gets keysyms instead', async (t) => {
  const { fake, display } = await fakeWithDisplay(t, { extKeys: false });
  display.refresh();
  await once(display, 'frame');
  display.input({ t: 'key', code: 'KeyQ', down: true });
  display.input({ t: 'key', code: 'Enter', down: true });
  await sleep(80);
  assert.deepEqual(fake.state.events.map((e) => [e.t, e.keysym, e.down]), [['key', 0x71, true], ['key', 0xff0d, true]]);
});

test('every key has a scancode and a keysym', () => {
  for (const [code, [scancode, keysym]] of Object.entries(keys.KEYS)) {
    assert.ok(scancode > 0 && keysym > 0, code);
  }
  assert.equal(keys.lookup('F10').scancode, 0x44);
  assert.equal(keys.lookup('Digit0').scancode, 0x0b);
  assert.equal(keys.lookup('KeyM').scancode, 0x32);
  assert.equal(keys.lookup('nope'), null);
});

test('a resolution change is reported', async (t) => {
  const { fake, display } = await fakeWithDisplay(t);
  const qmp = await Qmp.connect(fake.qmpPort);
  t.after(() => qmp.close());
  display.refresh();
  await once(display, 'frame');
  await qmp.execute('x-fake-resize', { width: 800, height: 600 });
  const size = await once(display, 'resize');
  assert.deepEqual(size, { width: 800, height: 600 });
  assert.equal(display.width, 800);
});

test('qmp: commands, errors and events', async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());
  const qmp = await Qmp.connect(fake.qmpPort);
  assert.equal((await qmp.execute('query-status')).status, 'running');
  await assert.rejects(qmp.execute('make-coffee'), /has not been found/);
  const event = once(qmp, 'event');
  await qmp.execute('system_reset');
  assert.equal(await event, 'RESET');
  qmp.close();
  await assert.rejects(qmp.execute('query-status'), /not running/);
});

test('qemu arguments', () => {
  const args = buildArgs({ name: 'a,b', memory: 4096, cpus: 4, disk: 'C:\\vms\\x,y\\disk.qcow2', iso: 'D:\\win.iso' }, { vnc: 12, qmp: 4444 });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('-name'), 'guest=a,,b');
  assert.equal(after('-m'), '4096');
  assert.equal(after('-smp'), '4');
  assert.equal(after('-vnc'), '127.0.0.1:12');
  assert.equal(after('-display'), 'none');
  assert.equal(after('-qmp'), 'tcp:127.0.0.1:4444,server=on,wait=off');
  assert.ok(args.includes('file=C:\\vms\\x,,y\\disk.qcow2,format=qcow2,media=disk'));
  assert.ok(args.includes('file=D:\\win.iso,media=cdrom,readonly=on'));
  assert.ok(args.includes('usb-tablet'));
  assert.ok(!buildArgs({ name: 'a', memory: 1, cpus: 1, disk: 'd' }, { vnc: 1, qmp: 1 }).some((a) => a.includes('cdrom')));
});

test('a vm starts, shows its screen, and shuts down', async () => {
  const vm = new Vm({ id: 'one', name: 'One', memory: 512, cpus: 1, disk: 'disk.qcow2' }, { launcher: launcher() });
  const states = [];
  vm.on('state', (s) => states.push(s));
  await Promise.all([vm.start(), vm.start()]);
  assert.equal(vm.state, 'running');

  const display = await vm.display();
  assert.deepEqual([display.width, display.height], [320, 200]);
  display.close();

  const seen = await vm.qmp.execute('x-fake-state');
  assert.ok(seen.argv.includes('-vnc') && seen.argv.includes('guest=One'));
  await vm.reset();
  assert.equal((await vm.qmp.execute('x-fake-state')).resets, 1);

  await vm.stop();
  assert.equal(vm.state, 'stopped');
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
  await assert.rejects(vm.display(), /not running/);
});

test('a guest that ignores the power button is switched off anyway', async () => {
  const vm = new Vm({ id: 'two', name: 'Two', memory: 512, cpus: 1, disk: 'd' }, { launcher: launcher({ FAKE_QEMU_IGNORE_POWER: '1' }) });
  await vm.start();
  const started = Date.now();
  await vm.stop({ wait: 300 });
  assert.equal(vm.state, 'stopped');
  assert.ok(Date.now() - started >= 300);
});

test('a vm that cannot start says why', async () => {
  const vm = new Vm({ id: 'bad', name: 'Bad', memory: 512, cpus: 1, disk: 'd' }, { launcher: launcher({ FAKE_QEMU_FAIL: '1' }) });
  await assert.rejects(vm.start(), /Could not open the disk/);
  assert.equal(vm.state, 'stopped');
  assert.match(vm.describe().error, /Could not open the disk/);
});

test('the store keeps vms on disk', async (t) => {
  const dir = tempDir(t);
  const disks = [];
  const options = { binary: null, launcher: launcher(), makeDisk: async (file, gb) => (disks.push(gb), fs.writeFileSync(file, '')) };
  const store = new VmStore(dir, options);
  let changes = 0;
  store.on('change', () => (changes += 1));

  const vm = await store.create({ name: 'Windows 11', memory: 4096, cpus: 4, diskGb: 64 });
  assert.equal(vm.id, 'windows-11');
  assert.deepEqual(disks, [64]);
  assert.ok(fs.existsSync(path.join(dir, 'windows-11', 'disk.qcow2')));
  assert.ok(changes >= 1);

  await assert.rejects(store.create({ name: 'windows 11' }), /already/);
  await assert.rejects(store.create({ name: '../etc' }), /letters/);
  await assert.rejects(store.create({ name: 'Tiny', memory: 8 }), /Memory/);
  await assert.rejects(store.create({ name: 'Iso', iso: path.join(dir, 'missing.iso') }), /not found/);
  assert.ok(!fs.existsSync(path.join(dir, 'tiny')));

  const again = new VmStore(dir, options);
  assert.deepEqual(again.list().map((v) => v.describe()), [
    { id: 'windows-11', name: 'Windows 11', memory: 4096, cpus: 4, iso: '', state: 'stopped', error: '' },
  ]);

  await vm.start();
  await assert.rejects(store.remove('windows-11'), /Shut Windows 11 down first/);
  await store.stopAll({ force: true });
  await store.remove('windows-11');
  assert.equal(store.list().length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'windows-11')));
});

test('without qemu nothing can be created', async (t) => {
  const store = new VmStore(tempDir(t), { binary: null });
  assert.equal(store.available, false);
  await assert.rejects(store.create({ name: 'x' }), /QEMU is not installed/);
});
