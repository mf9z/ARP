'use strict';

// a vm from end to end without qemu and without showing a window:
// stand-in vm -> encoder -> host -> client, and input back into the vm.
// run: npx electron scripts/vm-check.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const auth = require('../src/protocol/auth');
const { ArdpHost } = require('../src/host/host');
const { ArdpClient } = require('../src/client/client');
const { loadIdentity } = require('../src/host/identity');
const { VmService } = require('../src/app/vm-service');

const CODE = 'TEST-CODE-1234';
const INFO = { name: 'check', platform: process.platform, version: '0' };
const SIZE = { width: 1280, height: 720 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const standIn = require('arp-vm/dev/stand-in');

process.on('uncaughtException', (err) => {
  console.error('uncaught:', err.stack || err);
  app.exit(1);
});

// the encoder window is the only window; closing it must not end the check
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-vm-check-'));
  const problems = [];
  const expect = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) problems.push(what);
  };
  let service;
  try {
    service = new VmService({ dir, store: standIn(SIZE) });
    const vm = await service.create({ name: 'Check VM', memory: 1024, cpus: 2, diskGb: 8 });

    const salt = crypto.randomBytes(16);
    const credential = { salt, key: await auth.deriveKey(CODE, salt) };
    const host = new ArdpHost({
      identity: await loadIdentity(path.join(dir, 'identity'), 'check'),
      info: INFO,
      credential: () => credential,
      sources: () => service.sources(),
    });
    const { port } = await host.listen(0, '127.0.0.1');

    const client = new ArdpClient({ host: '127.0.0.1', port, accessCode: CODE, info: INFO });
    const { sources } = await client.connect();
    expect(sources.length === 1 && sources[0].id === 'vm:check-vm' && sources[0].kind === 'vm' && sources[0].state === 'stopped', `the host lists the vm, switched off: ${JSON.stringify(sources)}`);

    let frames = 0;
    let keys = 0;
    let bytes = 0;
    let config = null;
    client.on('video-config', (c) => (config = c));
    client.on('video-frame', (frame) => {
      frames += 1;
      bytes += frame.data.length;
      if (frame.key) keys += 1;
      client.ack(frame.seq);
    });
    let closed = null;
    client.on('close', (reason) => (closed = reason));

    const started = Date.now();
    const opened = await client.open({ source: 'vm:check-vm', codecs: ['h264', 'vp8', 'vp9'], quality: 'balanced' });
    console.log(`opened in ${Date.now() - started} ms: ${JSON.stringify(opened)}`);
    expect(vm.state === 'running', 'opening it switched the vm on');
    expect(opened.kind === 'vm' && opened.width === SIZE.width && opened.height === SIZE.height && opened.control, 'the stream has the size of the vm screen and can be controlled');
    expect(opened.actions.join() === 'ctrl-alt-del,restart,shutdown', 'the vm offers ctrl+alt+del, restart and shut down');

    await sleep(2500);
    const stream = host.sources()[0].active;
    console.log(`video: ${config && config.codec} via ${stream.encoder.label}, ${frames} frames (${keys} key), ${(bytes / 1024).toFixed(0)} KiB in 2.5 s, ${JSON.stringify(stream.encoder.stats)}`);
    expect(config && frames >= 20 && keys >= 1, 'encoded video arrives at the client');

    client.sendInput({ t: 'move', x: 0.5, y: 0.5 });
    client.sendInput({ t: 'button', b: 0, down: true });
    client.sendInput({ t: 'button', b: 0, down: false });
    client.sendInput({ t: 'key', code: 'KeyA', down: true });
    client.sendInput({ t: 'key', code: 'KeyA', down: false });
    client.sendAction('ctrl-alt-del');
    await sleep(300);
    const events = await vm.qmp.execute('x-fake-events');
    const pointer = events.filter((e) => e.t === 'pointer').map((e) => [e.x, e.y, e.mask]);
    const typed = events.filter((e) => e.t === 'xkey').map((e) => `${e.code}${e.down ? '+' : '-'}`);
    expect(JSON.stringify(pointer) === JSON.stringify([[640, 360, 0], [640, 360, 1], [640, 360, 0]]), `the pointer lands in the middle of the vm screen and clicks: ${JSON.stringify(pointer)}`);
    expect(typed.join(' ') === '30+ 30- 29+ 56+ 211+ 211- 56- 29-', `keys arrive as scancodes, then ctrl+alt+del: ${typed.join(' ')}`);

    client.sendAction('shutdown');
    for (let i = 0; i < 50 && !closed; i++) await sleep(100);
    expect(closed && closed.code === 'source_ended', `shutting the vm down ends the session: ${JSON.stringify(closed)}`);
    expect(vm.state === 'stopped', 'and the vm is off');
    await host.close();
  } catch (err) {
    console.error('failed:', err.stack || err.message);
    problems.push(err.message);
  }
  if (service) await service.shutdown().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(problems.length ? `${problems.length} PROBLEM(S)` : 'ALL GOOD');
  app.exit(problems.length ? 1 : 0);
});
