'use strict';

// what the protocol itself costs, measured over loopback in plain node: a real host and a
// real client on 127.0.0.1, real TLS, a stand-in for the screen. no capture, no encoder,
// no decoder and no network are in these numbers.   node ardp/scripts/bench.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const wire = require('../src/protocol/wire');
const auth = require('../src/protocol/auth');
const { ArdpHost } = require('../src/host/host');
const { ArdpClient } = require('../src/client/client');
const { Source, SourceStream } = require('../src/host/source');
const { loadIdentity } = require('../src/host/identity');

const CODE = 'K7QM-2XWP-9RDT';
const INFO = { name: 'bench', platform: process.platform, version: '0' };
const WIDTH = 1920;
const HEIGHT = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

class BenchStream extends SourceStream {
  constructor(request) {
    super();
    this.info = { source: 'bench', name: 'Bench', width: WIDTH, height: HEIGHT, control: !request.viewOnly };
    this.bitrate = { start: 80e6, min: 80e6, max: 80e6 };
    this.onInput = null;
  }

  start() {
    this.emit('config', { codec: 'bench', width: WIDTH, height: HEIGHT });
  }

  input(event) {
    if (this.onInput) this.onInput(event);
  }
}

class BenchSource extends Source {
  describe() {
    return { id: 'bench', kind: 'desktop', name: 'Bench', displays: [{ id: 1, name: 'Display 1', width: WIDTH, height: HEIGHT, primary: true }] };
  }

  async open(request) {
    this.stream = new BenchStream(request);
    return this.stream;
  }
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { median: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] };
}

const ms = (v) => `${v.toFixed(v < 10 ? 2 : 1)} ms`;
const row = (name, s) => console.log(`${name.padEnd(46)} median ${ms(s.median).padStart(9)}   p99 ${ms(s.p99).padStart(9)}   max ${ms(s.max).padStart(9)}`);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardp-bench-'));
  const identity = await loadIdentity(dir, 'bench');
  const salt = crypto.randomBytes(16);
  const key = await auth.deriveKey(CODE, salt);
  const source = new BenchSource();
  const host = new ArdpHost({ identity, info: INFO, credential: () => ({ salt, key }), sources: () => [source] });
  const { port } = await host.listen(0, '127.0.0.1');
  const connect = () => new ArdpClient({ host: '127.0.0.1', port, accessCode: CODE, info: INFO });

  console.log(`${os.cpus()[0].model}, ${process.platform} ${process.arch}, node ${process.versions.node}, loopback\n`);

  // tcp + tls + hello/challenge/auth/welcome. scrypt on the client is most of it
  const dials = [];
  for (let i = 0; i < 15; i++) {
    const client = connect();
    const t = now();
    await client.connect();
    dials.push(now() - t);
    client.close();
    await sleep(20);
  }
  row('connect and authenticate', summary(dials));

  const kdf = [];
  for (let i = 0; i < 15; i++) {
    const t = now();
    await auth.deriveKey(CODE, salt);
    kdf.push(now() - t);
  }
  row('  of which scrypt (N = 32768)', summary(kdf));

  const client = connect();
  await client.connect();
  await client.open({ codecs: ['h264'], quality: 'high' });
  const stream = source.stream;

  // one INPUT message, from sendInput() on the client to the source on the host
  const sentAt = [];
  const inputs = [];
  stream.onInput = () => inputs.push(now() - sentAt[inputs.length]);
  const events = 2000;
  for (let i = 0; i < events; i++) {
    sentAt.push(now());
    client.sendInput({ t: 'move', x: i / events, y: 0.5 });
    await sleep(1);
  }
  await sleep(100);
  if (inputs.length !== events) throw new Error(`only ${inputs.length} of ${events} input events arrived`);
  row('input event, client to host', summary(inputs));

  // one VIDEO_FRAME, from the encoder's output on the host to the client's decoder input,
  // at 60 frames a second. the sizes are what 1080p60 averages at each quality setting
  let seq = 0;
  const emitted = new Map();
  let arrivals = [];
  client.on('video-frame', (frame) => {
    arrivals.push(now() - emitted.get(frame.seq));
    emitted.delete(frame.seq);
    client.ack(frame.seq);
  });
  for (const [label, bitrate] of [['low', 4.4e6], ['balanced', 11.2e6], ['high', 27.4e6]]) {
    const bytes = Math.round(bitrate / 8 / 60);
    const data = crypto.randomBytes(bytes);
    arrivals = [];
    const frames = 600;
    const started = now();
    for (let i = 0; i < frames; i++) {
      seq += 1;
      emitted.set(seq, now());
      stream.emit('frame', { key: i === 0, timestamp: seq * 16667 }, data);
      const due = started + (i + 1) * (1000 / 60);
      const wait = due - now();
      if (wait > 0) await sleep(wait);
    }
    await sleep(200);
    if (arrivals.length !== frames) throw new Error(`only ${arrivals.length} of ${frames} frames arrived`);
    row(`video frame, host to client (${label}, ${(bytes / 1024).toFixed(0)} KiB)`, summary(arrivals));
  }

  await sleep(4500);
  console.log(`${'ping round trip (whole milliseconds)'.padEnd(46)} ${client.rtt} ms`);

  const move = wire.encodeJson(wire.T.INPUT, { t: 'move', x: 0.5134, y: 0.2871 }).length;
  const keyMsg = wire.encodeJson(wire.T.INPUT, { t: 'key', code: 'KeyA', down: true }).length;
  console.log(`\nbytes before TLS: ${5 + wire.VIDEO_HEAD} per video frame on top of the encoded picture, ${move} for a pointer move, ${keyMsg} for a key`);

  client.close();
  await host.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
