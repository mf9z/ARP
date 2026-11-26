'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const exe = process.platform === 'win32' ? '.exe' : '';

function searchDirs(hint) {
  const dirs = hint ? [hint] : [];
  dirs.push(...(process.env.PATH || '').split(path.delimiter));
  if (process.platform === 'win32') dirs.push('C:\\Program Files\\qemu', 'C:\\Program Files (x86)\\qemu');
  else dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return dirs.filter(Boolean);
}

function findQemu(hint) {
  for (const dir of searchDirs(hint)) {
    const system = path.join(dir, `qemu-system-x86_64${exe}`);
    if (fs.existsSync(system)) return { system, img: path.join(dir, `qemu-img${exe}`) };
  }
  return null;
}

// the fast one first, plain emulation as the fallback
function accelerators() {
  return { win32: ['whpx', 'tcg'], darwin: ['hvf', 'tcg'], linux: ['kvm', 'tcg'] }[process.platform] || ['tcg'];
}

// qemu splits option values on commas, so a real one is written twice
const escape = (value) => String(value).replace(/,/g, ',,');

function buildArgs(vm, { vnc, qmp }) {
  const args = ['-name', `guest=${escape(vm.name)}`, '-machine', 'q35'];
  for (const accel of accelerators()) args.push('-accel', accel);
  args.push('-m', String(vm.memory), '-smp', String(vm.cpus));
  args.push('-drive', `file=${escape(vm.disk)},format=qcow2,media=disk`);
  if (vm.iso) args.push('-drive', `file=${escape(vm.iso)},media=cdrom,readonly=on`);
  // disk first: an empty disk falls through to the installer, an installed one boots
  args.push('-boot', 'order=cd');
  args.push('-vga', 'std', '-display', 'none', '-vnc', `127.0.0.1:${vnc}`);
  // the tablet gives absolute pointer positions, which is what a remote pointer needs
  args.push('-usb', '-device', 'usb-tablet');
  args.push('-nic', 'user,model=e1000');
  args.push('-rtc', 'base=localtime');
  args.push('-qmp', `tcp:127.0.0.1:${qmp},server=on,wait=off`);
  return args;
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

module.exports = { findQemu, accelerators, buildArgs, freePort, freeVncDisplay };
