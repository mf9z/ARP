'use strict';

// boots a real qemu guest and checks the vm layer against it: screen, keys, shutdown.
// no window is shown. pictures of the vm's screen are saved as png.
// run: npx electron arp-launcher/scripts/real-vm-check.js [--arch aarch64] [--iso file.iso] [--out dir] [--type "text"]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, nativeImage } = require('electron');
const { VmStore } = require('arp-vm');

const arg = (name, fallback = '') => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const iso = arg('iso');
const out = arg('out', os.tmpdir());
const typed = arg('type');
const arch = arg('arch');
const settle = Number(arg('settle', iso ? 60 : 8)) * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// event.code for the characters a shell command needs
const CODES = { ' ': 'Space', '-': 'Minus', '.': 'Period', '/': 'Slash', '\n': 'Enter' };
const codeFor = (ch) => CODES[ch] || (/[a-z]/.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : null);

app.on('window-all-closed', () => {});
process.on('uncaughtException', (err) => {
  console.error('uncaught:', err.stack || err);
  app.exit(1);
});

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-real-vm-'));
  const store = new VmStore(dir);
  let failed = false;
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failed = true;
  };
  try {
    check(store.available, `qemu found${store.binary ? ` at ${path.dirname(store.binary.system)}` : ''}`);
    const vm = await store.create({ name: 'Real Check', memory: 1024, cpus: 2, diskGb: 2, iso, arch });
    console.log(`guest: ${vm.config.arch}, one of ${store.archs.join(' and ')}`);
    check(fs.statSync(vm.config.disk).size > 0, 'qemu-img made the disk');

    const started = Date.now();
    await vm.start();
    check(vm.state === 'running', `the vm started in ${Date.now() - started} ms, running on ${vm.accel}`);
    console.log('status:', JSON.stringify(await vm.qmp.execute('query-status')));

    const display = await vm.display();
    let pixels = Buffer.alloc(display.width * display.height * 4);
    let size = { width: display.width, height: display.height };
    let rects = 0;
    let frames = 0;
    display.on('resize', (next) => {
      size = next;
      pixels = Buffer.alloc(next.width * next.height * 4);
      display.refresh();
    });
    display.on('rect', (r) => {
      rects += 1;
      for (let row = 0; row < r.height; row++) {
        if (r.y + row >= size.height) break;
        r.data.copy(pixels, ((r.y + row) * size.width + r.x) * 4, row * r.width * 4, row * r.width * 4 + Math.min(r.width, size.width - r.x) * 4);
      }
    });
    display.on('frame', () => (frames += 1));
    display.refresh();

    const snap = (name) => {
      const file = path.join(out, name);
      // the fourth byte of each pixel is padding, not alpha
      const opaque = Buffer.from(pixels);
      for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
      fs.writeFileSync(file, nativeImage.createFromBitmap(opaque, size).toPNG());
      const lit = pixels.some((v, i) => i % 4 !== 3 && v > 40);
      console.log(`saved ${file} (${size.width}x${size.height}, ${lit ? 'something on screen' : 'all black'})`);
      return lit;
    };

    await sleep(3000);
    check(frames > 0 && rects > 0, `the screen arrives: ${frames} updates, ${rects} rectangles, ext keys ${display.rfb.extKeys}`);
    snap('vm-1-early.png');

    console.log(`waiting ${settle / 1000} s for the guest to settle...`);
    await sleep(settle);
    check(snap('vm-2-booted.png'), 'the guest draws to its screen');

    if (typed) {
      const before = frames;
      for (const ch of `${typed}\n`) {
        const code = codeFor(ch);
        if (!code) continue;
        display.input({ t: 'key', code, down: true });
        display.input({ t: 'key', code, down: false });
        await sleep(40);
      }
      await sleep(4000);
      check(frames > before, `typing "${typed}" changed the screen`);
      snap('vm-3-typed.png');
    }

    display.input({ t: 'move', x: 0.5, y: 0.5 });
    display.close();

    const stopping = Date.now();
    await vm.stop({ wait: iso ? 20000 : 4000 });
    check(vm.state === 'stopped', `the vm stopped in ${Date.now() - stopping} ms`);
    await store.remove(vm.id);
    check(store.list().length === 0, 'and was removed');
  } catch (err) {
    console.error('failed:', err.stack || err.message);
    failed = true;
  }
  await store.stopAll({ force: true }).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? 'PROBLEMS' : 'ALL GOOD');
  app.exit(failed ? 1 : 0);
});
