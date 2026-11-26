'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// checks what arp needs before it can run. `--strict` fails when something is missing
const strict = process.argv.includes('--strict');
const root = path.join(__dirname, '..');
const missing = [];
const say = (ok, text) => {
  console.log(`${ok ? '  ok     ' : '  MISSING'}  ${text}`);
  if (!ok) missing.push(text);
};

const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = major > 22 || (major === 22 && minor >= 12);
say(nodeOk, `node ${process.versions.node}${nodeOk ? '' : ' (22.12 or newer is needed)'}`);

// npm sometimes skips electron's own download step, so do it here
const electron = path.join(root, 'node_modules', 'electron');
const hasElectron = () => fs.existsSync(path.join(electron, 'path.txt'));
if (fs.existsSync(electron) && !hasElectron()) {
  try {
    execFileSync(process.execPath, [path.join(electron, 'install.js')], { stdio: 'inherit' });
  } catch {}
}
say(hasElectron(), 'electron');

let qemu = null;
try {
  qemu = require(path.join(root, 'arp-vm')).findQemu(process.env.ARP_QEMU);
} catch {}
say(!!qemu, qemu ? `qemu (${path.dirname(qemu.system)})` : 'qemu');

if (!qemu) {
  const how = {
    win32: 'winget install SoftwareFreedomConservancy.QEMU',
    darwin: 'brew install qemu',
    linux: 'sudo apt install qemu-system-x86 qemu-utils',
  }[process.platform];
  console.log(`\nARP needs QEMU for its virtual machines. Install it with:\n\n    ${how || 'https://www.qemu.org/download/'}\n\nthen run "npm run setup" to check again.`);
}

if (strict && missing.length) process.exit(1);
