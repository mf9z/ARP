'use strict';

// run like qemu: node fake-qemu.js ...the arguments qemu would get

const { startFake } = require('./fake');

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1] || '';

if (process.env.FAKE_QEMU_FAIL) {
  console.error('qemu-system-x86_64: -drive file=disk.qcow2: Could not open the disk');
  process.exit(1);
}

const display = Number(/:(\d+)/.exec(value('-vnc'))[1]);

startFake({
  vnc: 5900 + display,
  stdio: true,
  locked: value('-vnc').includes('password=on'),
  width: Number(process.env.FAKE_QEMU_WIDTH) || 320,
  height: Number(process.env.FAKE_QEMU_HEIGHT) || 200,
  ignorePower: !!process.env.FAKE_QEMU_IGNORE_POWER,
  onQuit: () => process.exit(0),
});
