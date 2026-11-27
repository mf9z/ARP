'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');

const { VmStore, Vm, VmDisplay, Qmp, buildArgs, accelerators, HOST } = require('../src');
const keys = require('../src/keys');
const { startFake } = require('../dev/fake');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));
const fakeQemu = path.join(__dirname, '..', 'dev', 'fake-qemu.js');
const launcher = (env = {}) => (args) =>
  spawn(process.execPath, [fakeQemu, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
const qmpTo = (port) => {
  const socket = net.connect(port, '127.0.0.1');
  return Qmp.open(socket, socket).then((qmp) => Object.assign(qmp, { hangUp: () => socket.destroy() }));
};

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
  const qmp = await qmpTo(fake.qmpPort);
  t.after(() => qmp.hangUp());
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
  const qmp = await qmpTo(fake.qmpPort);
  t.after(() => qmp.hangUp());
  assert.equal((await qmp.execute('query-status')).status, 'running');
  await assert.rejects(qmp.execute('make-coffee'), /has not been found/);
  const event = once(qmp, 'event');
  await qmp.execute('system_reset');
  assert.equal(await event, 'RESET');
  qmp.close();
  await assert.rejects(qmp.execute('query-status'), /not running/);
});

test('qemu arguments', () => {
  const args = buildArgs({ name: 'a,b', memory: 4096, cpus: 4, disk: 'C:\\vms\\x,y\\disk.qcow2', iso: 'D:\\win.iso' }, { vnc: 12 });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('-name'), 'guest=a,,b');
  assert.equal(after('-m'), '4096');
  assert.equal(after('-smp'), '4');
  assert.equal(after('-vnc'), '127.0.0.1:12,password=on');
  assert.ok(!args.includes('-qmp') && !args.some((a) => a.startsWith('tcp:')), 'no control port');
  assert.equal(after('-chardev'), 'stdio,id=mon');
  assert.equal(after('-mon'), 'chardev=mon,mode=control');
  assert.equal(after('-display'), 'none');
  assert.ok(args.includes('file=C:\\vms\\x,,y\\disk.qcow2,format=qcow2,media=disk'));
  assert.ok(args.includes('file=D:\\win.iso,format=raw,media=cdrom,readonly=on'));
  assert.ok(args.includes('usb-tablet'));
  assert.ok(!buildArgs({ name: 'a', memory: 1, cpus: 1, disk: 'd' }, { vnc: 1 }).some((a) => a.includes('cdrom')));
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
  assert.equal(vm.vncPassword.length, 8);
  await assert.rejects(VmDisplay.connect(vm.vncPort), /wants a password/);
  await assert.rejects(VmDisplay.connect(vm.vncPort, { password: 'guessing' }), /Authentication failed/);

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
    { id: 'windows-11', name: 'Windows 11', arch: HOST, memory: 4096, cpus: 4, iso: '', state: 'stopped', error: '' },
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

test('the screen password: right one in, wrong one out, and a screen without one is not trusted', async (t) => {
  const fake = await startFake({ locked: true });
  t.after(() => fake.close());
  await assert.rejects(VmDisplay.connect(fake.vncPort, { password: 'anything' }), /Authentication failed/);
  fake.state.password = 'Zx81+abc';
  const display = await VmDisplay.connect(fake.vncPort, { password: 'Zx81+abc' });
  assert.equal(display.width, 320);
  display.close();

  const open = await startFake();
  t.after(() => open.close());
  await assert.rejects(VmDisplay.connect(open.vncPort, { password: 'Zx81+abc' }), /did not ask for its password/);
});

test('a screen that reports an absurd size is refused', async (t) => {
  const fake = await startFake({ width: 60000, height: 60000 });
  t.after(() => fake.close());
  await assert.rejects(VmDisplay.connect(fake.vncPort), /impossible screen size/);
});

test('junk on the control channel is ignored, not fatal', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const opening = Qmp.open(input, output);
  input.write('null\n42\n"text"\n[1]\nnot json\n{"QMP":{}}\n{"QMP":{}}\n');
  const asked = JSON.parse((await once(output, 'data')).toString());
  assert.equal(asked.execute, 'qmp_capabilities');
  input.write(`{"return":{},"id":${asked.id}}\n{"event":null}\n`);
  const qmp = await opening;
  const closed = once(qmp, 'close');
  input.write('x'.repeat(1024 * 1024 + 10));
  await closed;
  assert.equal(qmp.closed, true);
});

test('an installer must be a real local file given by its full path', async (t) => {
  const dir = tempDir(t);
  const store = new VmStore(dir, { binary: null, launcher: launcher(), makeDisk: async (file) => fs.writeFileSync(file, '') });
  const iso = path.join(dir, 'real.iso');
  fs.writeFileSync(iso, 'x');
  for (const bad of ['real.iso', dir, '\\\\server\\share\\x.iso', '//server/share/x.iso', 'http://example.com/x.iso']) {
    await assert.rejects(store.create({ name: 'Bad', iso: bad }), /not found/, bad);
  }
  const vm = await store.create({ name: 'Good', iso });
  assert.equal(vm.config.iso, iso);
});

test('paths in a tampered vm.json are not believed', async (t) => {
  const dir = tempDir(t);
  const options = { binary: null, launcher: launcher(), makeDisk: async (file) => fs.writeFileSync(file, '') };
  await new VmStore(dir, options).create({ name: 'Mine' });
  const file = path.join(dir, 'mine', 'vm.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, disk: 'C:\\Windows\\win.ini', iso: 'relative.iso', memory: 512 }));
  const vm = new VmStore(dir, options).get('mine');
  assert.equal(vm.config.disk, path.join(dir, 'mine', 'disk.qcow2'));
  assert.equal(vm.config.iso, '');
});

test('an arm guest is started as a different machine', () => {
  const firmware = { code: '/share/qemu/edk2-aarch64-code.fd', vars: '/share/qemu/edk2-arm-vars.fd' };
  const vm = { name: 'Arm', arch: 'aarch64', memory: 2048, cpus: 2, disk: '/vms/arm/disk.qcow2', iso: '/isos/a,b.iso', vars: '/vms/arm/efi-vars.fd' };
  const args = buildArgs(vm, { vnc: 12, firmware, platform: 'darwin', host: 'aarch64' });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('-machine'), 'virt');
  assert.equal(after('-cpu'), 'max');
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-accel'), ['hvf', 'tcg']);
  assert.ok(args.includes('if=pflash,format=raw,unit=0,readonly=on,file=/share/qemu/edk2-aarch64-code.fd'));
  assert.ok(args.includes('if=pflash,format=raw,unit=1,file=/vms/arm/efi-vars.fd'));
  assert.ok(args.includes('virtio-blk-pci,drive=disk,bootindex=1'));
  assert.ok(args.includes('if=none,id=cd,file=/isos/a,,b.iso,format=raw,media=cdrom,readonly=on'));
  assert.ok(args.includes('usb-storage,drive=cd,bootindex=2'));
  // no ps/2 and no vga on that machine: the keyboard, the pointer and the screen are added
  for (const device of ['qemu-xhci', 'usb-kbd', 'usb-tablet', 'virtio-gpu-pci']) assert.ok(args.includes(device), device);
  assert.ok(args.indexOf('qemu-xhci') < args.indexOf('usb-storage,drive=cd,bootindex=2'), 'the usb controller comes before what plugs into it');
  assert.ok(!args.includes('-vga') && !args.includes('-boot'));
  // the same screen and control channel as any other guest
  assert.equal(after('-vnc'), '127.0.0.1:12,password=on');
  assert.equal(after('-mon'), 'chardev=mon,mode=control');

  const plain = buildArgs({ ...vm, vars: '', iso: '' }, { vnc: 1, firmware, platform: 'darwin', host: 'aarch64' });
  assert.equal(plain[plain.indexOf('-bios') + 1], firmware.code);
  assert.ok(!plain.some((a) => a.includes('cdrom') || a.includes('pflash')));
  assert.throws(() => buildArgs(vm, { vnc: 1, firmware: null }), /cannot run ARM/);
});

test('the fast way is only used for guests built like the computer', () => {
  assert.deepEqual(accelerators('aarch64', 'darwin', 'aarch64'), ['hvf', 'tcg']);
  assert.deepEqual(accelerators('x86_64', 'darwin', 'aarch64'), ['tcg']);
  assert.deepEqual(accelerators('x86_64', 'darwin', 'x86_64'), ['hvf', 'tcg']);
  assert.deepEqual(accelerators('aarch64', 'darwin', 'x86_64'), ['tcg']);
  assert.deepEqual(accelerators('x86_64', 'win32', 'x86_64'), ['whpx', 'tcg']);
  assert.deepEqual(accelerators('aarch64', 'win32', 'aarch64'), ['tcg']);
  assert.deepEqual(accelerators('x86_64', 'linux', 'x86_64'), ['kvm', 'tcg']);
  // a pc guest keeps the arguments it always had on windows, and asks for a full processor elsewhere
  const pc = { name: 'Pc', memory: 1024, cpus: 1, disk: 'd' };
  assert.ok(!buildArgs(pc, { vnc: 1, platform: 'win32', host: 'x86_64' }).includes('-cpu'));
  const onMac = buildArgs(pc, { vnc: 1, platform: 'darwin', host: 'aarch64' });
  assert.equal(onMac[onMac.indexOf('-cpu') + 1], 'max');
  assert.deepEqual(onMac.filter((a, i) => onMac[i - 1] === '-accel'), ['tcg']);
});

test('the store makes guests of either kind and remembers which', async (t) => {
  const dir = tempDir(t);
  const seen = [];
  const run = launcher();
  const options = { binary: null, launcher: (args, arch) => (seen.push(arch), run(args)), makeDisk: async (file) => fs.writeFileSync(file, '') };
  const store = new VmStore(dir, options);
  assert.deepEqual(store.archs, ['x86_64', 'aarch64']);
  assert.equal(store.defaultArch, HOST);

  const arm = await store.create({ name: 'Arm One', arch: 'aarch64' });
  const pc = await store.create({ name: 'Pc One', arch: 'x86_64' });
  assert.equal(arm.describe().arch, 'aarch64');
  assert.equal(pc.describe().arch, 'x86_64');
  await assert.rejects(store.create({ name: 'Odd', arch: 'riscv64' }), /cannot run that kind/);
  assert.ok(!fs.existsSync(path.join(dir, 'odd')));

  // a vm.json from before there was a choice is a pc
  const old = JSON.parse(fs.readFileSync(path.join(dir, 'pc-one', 'vm.json'), 'utf8'));
  delete old.arch;
  fs.writeFileSync(path.join(dir, 'pc-one', 'vm.json'), JSON.stringify(old));
  const again = new VmStore(dir, options);
  assert.deepEqual(Object.fromEntries(again.list().map((v) => [v.id, v.describe().arch])), { 'arm-one': 'aarch64', 'pc-one': 'x86_64' });

  // each kind is started with its own program
  await again.get('arm-one').start();
  assert.deepEqual(seen, ['aarch64']);
  await again.stopAll({ force: true });
});

test('a hypervisor that refuses to start is not the end: the vm comes up emulated', async () => {
  const tried = [];
  const run = launcher({ FAKE_QEMU_NO_HYPERVISOR: '1' });
  const vm = new Vm(
    { id: 'one', name: 'One', arch: HOST, memory: 512, cpus: 1, disk: 'disk.qcow2' },
    { launcher: (args) => (tried.push(args.filter((a, i) => args[i - 1] === '-accel')), run(args)) },
  );
  await vm.start();
  assert.equal(vm.state, 'running');
  assert.equal(vm.accel, 'tcg');
  // where this computer has a hypervisor it was tried first, and then left out
  const ways = accelerators(HOST);
  assert.deepEqual(tried, ways.length > 1 ? [ways, ['tcg']] : [['tcg']]);
  await vm.stop({ force: true });
  assert.equal(vm.accel, '');
});
