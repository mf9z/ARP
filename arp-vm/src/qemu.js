'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const exe = process.platform === 'win32' ? '.exe' : '';

// the two kinds of guest. a guest built like this computer runs at full speed, the other is emulated
const ARCHS = ['x86_64', 'aarch64'];
const HOST = process.arch === 'arm64' ? 'aarch64' : 'x86_64';

function searchDirs(hint) {
  // the usual install folders come before PATH, which other programs can add to
  const dirs = hint ? [hint] : [];
  if (process.platform === 'win32') dirs.push('C:\\Program Files\\qemu', 'C:\\Program Files (x86)\\qemu');
  else dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  dirs.push(...(process.env.PATH || '').split(path.delimiter));
  return dirs.filter(Boolean);
}

// arm guests start from uefi firmware that ships with qemu: next to the program on
// windows, under share/qemu with homebrew and on linux
function findFirmware(dir) {
  for (const share of [path.join(dir, 'share'), path.join(dir, '..', 'share', 'qemu'), '/usr/share/qemu']) {
    const code = path.join(share, 'edk2-aarch64-code.fd');
    if (!fs.existsSync(code)) continue;
    const vars = path.join(share, 'edk2-arm-vars.fd');
    return { code, vars: fs.existsSync(vars) ? vars : '' };
  }
  return null;
}

function findQemu(hint) {
  for (const dir of searchDirs(hint)) {
    const system = path.join(dir, `qemu-system-x86_64${exe}`);
    if (!fs.existsSync(system)) continue;
    const found = { system, img: path.join(dir, `qemu-img${exe}`), systems: { x86_64: system }, firmware: null };
    const arm = path.join(dir, `qemu-system-aarch64${exe}`);
    const firmware = findFirmware(dir);
    if (fs.existsSync(arm) && firmware) {
      found.systems.aarch64 = arm;
      found.firmware = firmware;
    }
    return found;
  }
  return null;
}

// the fast one first, plain emulation as the fallback. a hypervisor only runs guests
// built like the computer it is on
function accelerators(arch = 'x86_64', platform = process.platform, host = HOST) {
  const fast = { win32: 'whpx', darwin: 'hvf', linux: 'kvm' }[platform];
  if (!fast || arch !== host) return ['tcg'];
  // on windows the hypervisor is only known to work for x86 guests
  if (platform === 'win32' && arch !== 'x86_64') return ['tcg'];
  return [fast, 'tcg'];
}

// qemu splits option values on commas, so a real one is written twice
const escape = (value) => String(value).replace(/,/g, ',,');

// the same for every guest: where the screen is, and how qemu is told what to do
function common(vnc) {
  return [
    // the screen only answers to the password set over the control channel after start
    '-display',
    'none',
    '-vnc',
    `127.0.0.1:${vnc},password=on`,
    // control runs over our own pipes to qemu. a tcp port would be open to every
    // program here, and to the guest itself through its network gateway
    '-monitor',
    'none',
    '-serial',
    'none',
    '-parallel',
    'none',
    '-chardev',
    'stdio,id=mon',
    '-mon',
    'chardev=mon,mode=control',
  ];
}

function pcArgs(vm, { vnc, accel, platform = process.platform, host = HOST }) {
  const args = ['-name', `guest=${escape(vm.name)}`, '-machine', 'q35'];
  for (const way of accel || accelerators('x86_64', platform, host)) args.push('-accel', way);
  // off windows, ask for the fullest processor: the host's own under a hypervisor,
  // everything qemu can emulate otherwise. newer systems refuse to install on less
  if (platform !== 'win32') args.push('-cpu', 'max');
  args.push('-m', String(vm.memory), '-smp', String(vm.cpus));
  args.push('-drive', `file=${escape(vm.disk)},format=qcow2,media=disk`);
  // raw on purpose: left to guess, qemu would follow a disk image's link to other host files
  if (vm.iso) args.push('-drive', `file=${escape(vm.iso)},format=raw,media=cdrom,readonly=on`);
  // disk first: an empty disk falls through to the installer, an installed one boots
  args.push('-boot', 'order=cd');
  args.push('-vga', 'std');
  // the tablet gives absolute pointer positions, which is what a remote pointer needs
  args.push('-usb', '-device', 'usb-tablet');
  args.push('-nic', 'user,model=e1000');
  args.push('-rtc', 'base=localtime');
  return [...args, ...common(vnc)];
}

// an arm guest is a different machine: no bios, no ide, no ps/2. it boots from uefi
// and everything hangs off pci and usb
function armArgs(vm, { vnc, firmware, accel, platform = process.platform, host = HOST }) {
  if (!firmware) throw new Error('The QEMU on this computer cannot run ARM virtual machines.');
  const args = ['-name', `guest=${escape(vm.name)}`, '-machine', 'virt'];
  for (const way of accel || accelerators('aarch64', platform, host)) args.push('-accel', way);
  args.push('-cpu', 'max', '-m', String(vm.memory), '-smp', String(vm.cpus));
  if (vm.vars) {
    // the firmware is shared and read only; what it remembers is this vm's own file
    args.push('-drive', `if=pflash,format=raw,unit=0,readonly=on,file=${escape(firmware.code)}`);
    args.push('-drive', `if=pflash,format=raw,unit=1,file=${escape(vm.vars)}`);
  } else {
    args.push('-bios', firmware.code);
  }
  args.push('-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet');
  args.push('-drive', `if=none,id=disk,file=${escape(vm.disk)},format=qcow2`, '-device', 'virtio-blk-pci,drive=disk,bootindex=1');
  // raw on purpose, as above. after the disk, so an installed system boots and an empty disk falls through
  if (vm.iso) args.push('-drive', `if=none,id=cd,file=${escape(vm.iso)},format=raw,media=cdrom,readonly=on`, '-device', 'usb-storage,drive=cd,bootindex=2');
  args.push('-device', 'virtio-gpu-pci');
  args.push('-nic', 'user,model=virtio-net-pci');
  args.push('-rtc', 'base=utc');
  return [...args, ...common(vnc)];
}

function buildArgs(vm, options) {
  return vm.arch === 'aarch64' ? armArgs(vm, options) : pcArgs(vm, options);
}

function listenOn(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(0));
    server.listen(port, '127.0.0.1', () => {
      const got = server.address().port;
      server.close(() => resolve(got));
    });
  });
}

async function freePort() {
  const port = await listenOn(0);
  if (!port) throw new Error('no free port');
  return port;
}

// vnc displays are numbered: display n listens on 5900 + n
async function freeVncDisplay() {
  for (let n = 10; n < 200; n++) {
    if (await listenOn(5900 + n)) return n;
  }
  throw new Error('no free display');
}

module.exports = { ARCHS, HOST, findQemu, accelerators, buildArgs, freePort, freeVncDisplay };
