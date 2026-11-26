'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// options for VmStore that swap qemu for the fake one, for working on the
// rest without qemu installed. the "vm" shows a test picture
module.exports = function standIn({ width = 1024, height = 768 } = {}) {
  const env = { ...process.env, FAKE_QEMU_WIDTH: String(width), FAKE_QEMU_HEIGHT: String(height) };
  // electron's binary runs plain scripts when told to
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    binary: null,
    launcher: (args) => spawn(process.execPath, [path.join(__dirname, 'fake-qemu.js'), ...args], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true }),
    makeDisk: async (file) => fs.writeFileSync(file, ''),
  };
};
