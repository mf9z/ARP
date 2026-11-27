'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const wire = require('../src/protocol/wire');
const auth = require('../src/protocol/auth');
const input = require('../src/protocol/input');
const { parseAddress, formatAddress, isLoopback } = require('../src/common/address');
const { ArdpHost } = require('../src/host/host');
const { ArdpClient } = require('../src/client/client');
const { Source, SourceStream } = require('../src/host/source');
const { FlowControl } = require('../src/host/flow');
const { loadIdentity } = require('../src/host/identity');

const CODE = 'K7QM-2XWP-9RDT';
const INFO = { name: 'test', platform: 'test', version: '0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeStream extends SourceStream {
  constructor(request) {
    super();
    this.request = request;
    this.info = { source: 'fake', name: 'Fake', width: 64, height: 48, control: !request.viewOnly };
    this.inputs = [];
    this.keyframes = 0;
    this.closed = false;
  }

  start() {
    this.emit('config', { codec: 'test', width: 64, height: 48 });
    this.emit('frame', { key: true, timestamp: 1000 }, Buffer.from('key-frame'));
    this.emit('frame', { key: false, timestamp: 2000 }, crypto.randomBytes(200000));
  }

  requestKeyframe() {
    this.keyframes += 1;
    this.emit('frame', { key: true, timestamp: 3000 }, Buffer.from('again'));
  }

  input(event) {
    this.inputs.push(event);
  }

  close() {
    this.closed = true;
  }
}

class FakeSource extends Source {
  constructor() {
    super();
    this.streams = [];
  }

  describe() {
    return { id: 'fake', kind: 'desktop', name: 'Fake', displays: [{ id: 1, name: 'Display 1', width: 64, height: 48, primary: true }] };
  }

  async open(request) {
    const stream = new FakeStream(request);
    this.streams.push(stream);
    return stream;
  }
}

async function startHost(t, code = CODE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardp-test-'));
  const identity = await loadIdentity(dir, 'test');
  const salt = crypto.randomBytes(16);
  const key = await auth.deriveKey(code, salt);
  const source = new FakeSource();
  const host = new ArdpHost({ identity, info: INFO, credential: () => ({ salt, key }), sources: () => [source] });
  const { port } = await host.listen(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { host, port, source, identity, dir };
}

const client = (port, accessCode = CODE, extra = {}) => new ArdpClient({ host: '127.0.0.1', port, accessCode, info: INFO, timeout: 4000, ...extra });

test('decoder reassembles messages split at every byte', () => {
  const messages = [wire.encodeJson(wire.T.HELLO, { a: 1 }), wire.encode(wire.T.VIDEO_KEY), wire.encode(wire.T.VIDEO_FRAME, crypto.randomBytes(5000))];
  const stream = Buffer.concat(messages);
  for (const step of [1, 2, 3, 7, 4096, stream.length]) {
    const seen = [];
    const decoder = new wire.Decoder((type, payload) => seen.push([type, Buffer.from(payload)]));
    for (let i = 0; i < stream.length; i += step) decoder.push(stream.subarray(i, i + step));
    assert.equal(seen.length, 3, `step ${step}`);
    assert.deepEqual(seen.map((m) => m[0]), [wire.T.HELLO, wire.T.VIDEO_KEY, wire.T.VIDEO_FRAME]);
    assert.equal(seen[1][1].length, 0);
    assert.ok(seen[2][1].equals(messages[2].subarray(5)));
  }
});

test('decoder rejects absurd lengths', () => {
  const decoder = new wire.Decoder(() => {});
  assert.throws(() => decoder.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 1])), /invalid message length/);
});

test('video frame header round trip', () => {
  const head = wire.packVideoHead({ key: true, seq: 42, timestamp: 1234567890123 });
  const frame = wire.unpackVideoFrame(Buffer.concat([head, Buffer.from('xyz')]));
  assert.deepEqual({ ...frame, data: frame.data.toString() }, { key: true, seq: 42, timestamp: 1234567890123, data: 'xyz' });
});

test('access codes ignore case, spaces and dashes', async () => {
  assert.equal(auth.normaliseCode(' k7qm 2xwp-9rdt '), 'K7QM2XWP9RDT');
  assert.match(auth.generateCode(), /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const salt = crypto.randomBytes(16);
  const a = await auth.deriveKey('K7QM-2XWP-9RDT', salt);
  const b = await auth.deriveKey('k7qm2xwp9rdt', salt);
  assert.ok(a.equals(b));
  await assert.rejects(auth.deriveKey('x', salt, { name: 'scrypt', N: 1 << 30, r: 8, p: 1 }), /unreasonable/);
  await assert.rejects(auth.deriveKey('x', salt, { name: 'scrypt', N: 1024, r: 1, p: 1 }), /unreasonable/);
});

test('input events are validated', () => {
  assert.deepEqual(input.sanitise({ t: 'move', x: 2, y: -1 }), { t: 'move', x: 1, y: 0 });
  assert.equal(input.sanitise({ t: 'move', x: 'a', y: 0 }), null);
  assert.deepEqual(input.sanitise({ t: 'key', code: 'KeyA', down: true, extra: 1 }), { t: 'key', code: 'KeyA', down: true });
  assert.equal(input.sanitise({ t: 'key', code: '../etc', down: true }), null);
  assert.equal(input.sanitise({ t: 'button', b: 9, down: true }), null);
  assert.equal(input.sanitise({ t: 'exec', cmd: 'x' }), null);
});

test('addresses', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), { host: '192.168.1.20', port: 7389, source: undefined });
  assert.deepEqual(parseAddress(' studio-pc:7400 '), { host: 'studio-pc', port: 7400, source: undefined });
  assert.deepEqual(parseAddress('[fe80::1]:7400'), { host: 'fe80::1', port: 7400, source: undefined });
  assert.deepEqual(parseAddress('fe80::1'), { host: 'fe80::1', port: 7389, source: undefined });
  assert.deepEqual(parseAddress('10.0.0.2/win11'), { host: '10.0.0.2', port: 7389, source: 'win11' });
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress('host:port'), null);
  assert.equal(parseAddress('host:99999'), null);
  assert.equal(formatAddress({ host: '10.0.0.2', port: 7389 }), '10.0.0.2');
  assert.equal(formatAddress({ host: 'fe80::1', port: 7400 }), '[fe80::1]:7400');
  assert.ok(isLoopback('::ffff:127.0.0.1') && isLoopback('::1') && !isLoopback('10.0.0.1'));
});

test('flow control pauses when frames pile up and recovers', () => {
  const flow = new FlowControl({ fps: 60, bitrate: 8e6, maxBitrate: 8e6 });
  flow.onSent(40);
  let now = 0;
  assert.deepEqual(flow.tick(0, (now += 250)), { paused: true, bitrate: 8e6 });
  const cut = flow.tick(0, (now += 1000));
  assert.ok(cut.bitrate < 8e6 && cut.paused);
  flow.onAck(40);
  assert.equal(flow.tick(0, (now += 250)).paused, false);
  let raised = null;
  for (let i = 0; i < 40 && !raised; i++) raised = flow.tick(0, (now += 250));
  assert.ok(raised && raised.bitrate > cut.bitrate);
});

test('connect, open, stream video and send input', async (t) => {
  const { port, source, host, identity } = await startHost(t);
  const c = client(port);
  const info = await c.connect();
  assert.equal(info.fingerprint, identity.fingerprint);
  assert.equal(info.sources[0].id, 'fake');
  assert.equal(host.list().length, 1);

  const frames = [];
  const configs = [];
  c.on('video-config', (cfg) => configs.push(cfg));
  c.on('video-frame', (f) => frames.push({ ...f, data: Buffer.from(f.data) }));

  const opened = await c.open({ codecs: ['test'], quality: 'high' });
  assert.equal(opened.width, 64);
  assert.equal(opened.control, true);
  await sleep(150);

  assert.equal(configs.length, 1);
  assert.deepEqual(frames.map((f) => [f.seq, f.key, f.timestamp]), [[1, true, 1000], [2, false, 2000]]);
  assert.equal(frames[0].data.toString(), 'key-frame');
  assert.equal(frames[1].data.length, 200000);
  assert.equal(source.streams[0].request.quality, 'high');

  c.sendInput({ t: 'move', x: 0.5, y: 0.25 });
  c.sendInput({ t: 'key', code: 'KeyA', down: true });
  c.sendInput({ t: 'nonsense' });
  c.requestKeyframe();
  c.ack(2);
  await sleep(150);
  assert.deepEqual(source.streams[0].inputs, [{ t: 'move', x: 0.5, y: 0.25 }, { t: 'key', code: 'KeyA', down: true }]);
  assert.equal(source.streams[0].keyframes, 1);
  assert.equal(frames.length, 3);

  const closed = new Promise((resolve) => c.once('close', resolve));
  c.close();
  assert.equal((await closed).code, 'closed');
  await sleep(100);
  assert.equal(source.streams[0].closed, true);
  assert.equal(host.list().length, 0);
});

test('view only sessions cannot send input', async (t) => {
  const { port, source } = await startHost(t);
  const c = client(port);
  await c.connect();
  const opened = await c.open({ viewOnly: true });
  assert.equal(opened.control, false);
  c.sendInput({ t: 'move', x: 0.5, y: 0.5 });
  await sleep(100);
  assert.deepEqual(source.streams[0].inputs, []);
  c.close();
});

test('a wrong access code is refused and repeated failures lock the address out', async (t) => {
  const { port, host } = await startHost(t);
  let failures = 0;
  host.on('auth-failed', () => (failures += 1));
  for (let i = 0; i < 5; i++) {
    await assert.rejects(client(port, 'WRONG-CODE').connect(), (err) => err.code === 'auth_failed');
  }
  assert.equal(failures, 5);
  await assert.rejects(client(port, CODE).connect(), (err) => err.code === 'rate_limited');
  assert.equal(host.list().length, 0);
});

test('a changed host identity stops the connection unless approved', async (t) => {
  const { port } = await startHost(t);
  const store = new Map([[`127.0.0.1:${port}`, 'AA:BB:CC']]);
  const asked = [];
  const trust = {
    get: (id) => store.get(id),
    set: (id, fp) => store.set(id, fp),
    changed: async (q) => {
      asked.push(q);
      return false;
    },
  };
  await assert.rejects(client(port, CODE, { trust }).connect(), (err) => err.code === 'identity_changed');
  assert.equal(asked.length, 1);

  trust.changed = async () => true;
  const c = client(port, CODE, { trust });
  const info = await c.connect();
  assert.equal(store.get(`127.0.0.1:${port}`), info.fingerprint);
  c.close();
});

test('an unreachable host reports a clear error', async () => {
  await assert.rejects(client(1, CODE).connect(), (err) => ['refused', 'unreachable'].includes(err.code));
});

test('a host that stops tells its clients why', async (t) => {
  const { port, host } = await startHost(t);
  const c = client(port);
  await c.connect();
  await c.open({});
  const closed = new Promise((resolve) => c.once('close', resolve));
  await host.close();
  assert.equal((await closed).code, 'host_stopped');
});

test('a host that asks first lets the client in only on a yes', async (t) => {
  const { port, host, source } = await startHost(t);
  const asked = [];
  let answer = true;
  host.approve = async (who) => {
    asked.push(who);
    await sleep(50);
    return answer;
  };

  const yes = client(port);
  await yes.connect();
  const waiting = [];
  yes.on('waiting', (what) => waiting.push(what));
  const opened = await yes.open({ viewOnly: true });
  assert.equal(opened.width, 64);
  assert.deepEqual(waiting, ['approval']);
  assert.deepEqual(asked[0], { address: '127.0.0.1', identity: '', name: 'test', source: 'fake', kind: 'desktop', sourceName: 'Fake', viewOnly: true });
  yes.close();

  answer = false;
  const no = client(port);
  await no.connect();
  await assert.rejects(no.open({}), (err) => err.code === 'denied');
  assert.equal(source.streams.length, 1);
});

test('the question is withdrawn when the client gives up', async (t) => {
  const { port, host } = await startHost(t);
  let withdrawn = false;
  host.approve = (_who, signal) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        withdrawn = true;
        resolve(false);
      });
    });
  const c = client(port);
  await c.connect();
  c.open({}).catch(() => {});
  await sleep(100);
  c.abort();
  await sleep(100);
  assert.equal(withdrawn, true);
});

test('a stranger cannot make the host buffer or echo much', async (t) => {
  const { port, host } = await startHost(t);
  const tls = require('tls');
  const dial = () =>
    new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port, ALPNProtocols: [wire.ALPN], rejectUnauthorized: false }, () => resolve(s));
      s.on('error', () => {});
    });

  // a message bigger than a stranger is allowed ends the connection
  const big = await dial();
  const gone = new Promise((resolve) => big.once('close', resolve));
  big.write(wire.header(wire.T.HELLO, 1024 * 1024));
  await gone;

  // an oversized ping is not echoed
  const pinger = await dial();
  let back = 0;
  pinger.on('data', (chunk) => (back += chunk.length));
  pinger.write(wire.encode(wire.T.PING, Buffer.alloc(3000, 1)));
  await sleep(200);
  assert.ok(back < 200, `${back} bytes came back`);
  pinger.destroy();

  // one address cannot hold every slot
  const held = [];
  for (let i = 0; i < 4; i++) held.push(await dial());
  const fifth = await dial();
  await new Promise((resolve) => fifth.once('close', resolve));
  for (const s of held) s.destroy();
  await sleep(100);
  assert.equal(host.connections.size, 0);
});

test('a proof is good for one tls session only', async (t) => {
  const { port, identity } = await startHost(t);
  const c = client(port);
  await c.connect();
  // the same code and certificate, but another session's binding, must not verify
  const key = await auth.deriveKey(CODE, crypto.randomBytes(16));
  const ctx = { clientNonce: crypto.randomBytes(32), hostNonce: crypto.randomBytes(32), fingerprint: identity.fingerprint };
  const one = auth.clientProof(key, { ...ctx, binding: crypto.randomBytes(32) });
  const two = auth.clientProof(key, { ...ctx, binding: crypto.randomBytes(32) });
  assert.ok(!one.equals(two));
  c.close();
});

test('asking twice at once from one address is refused, and a no counts against it', async (t) => {
  const { port, host } = await startHost(t);
  let release;
  host.approve = () => new Promise((resolve) => (release = resolve));
  const first = client(port);
  await first.connect();
  const waiting = first.open({}).catch((err) => err);
  await sleep(100);
  const second = client(port);
  await second.connect();
  await assert.rejects(second.open({}), (err) => err.code === 'denied');
  release(false);
  assert.equal((await waiting).code, 'denied');
  assert.ok(host._failures.get('127.0.0.1').count >= 1);
});

test('a connection cannot be turned around', async (t) => {
  const { port, host, source } = await startHost(t);

  // the host tries to steer the client: the client hangs up at once
  const c = client(port);
  await c.connect();
  await c.open({});
  const closed = new Promise((resolve) => c.once('close', resolve));
  const session = [...host.connections][0];
  for (const type of [wire.T.INPUT, wire.T.OPEN, wire.T.ACTION]) session.channel.sendJson(type, { t: 'move', x: 0.5, y: 0.5, action: 'restart', source: 'desktop' });
  assert.equal((await closed).code, 'bad_protocol');

  // a client that starts sending pictures is cut off, and nothing reaches the source
  const d = client(port);
  await d.connect();
  await d.open({});
  const gone = new Promise((resolve) => d.once('close', resolve));
  d.channel.send(wire.T.VIDEO_FRAME, Buffer.alloc(64));
  assert.equal((await gone).code, 'bad_protocol');
  assert.deepEqual(source.streams.map((s) => s.inputs.length), [0, 0]);
});

test('a client is known by its own certificate, and only by one it holds the key to', async (t) => {
  const { port, host, identity: hostIdentity } = await startHost(t);
  const asked = [];
  host.approve = async (who) => (asked.push(who.identity), true);

  const dirs = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'ardp-test-')));
  t.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const [one, two] = await Promise.all(dirs.map((dir, i) => loadIdentity(dir, `client ${i}`)));

  const open = async (extra) => {
    const c = client(port, CODE, extra);
    await c.connect();
    await c.open({});
    const seen = host.list().map((s) => s.identity);
    c.close();
    await sleep(30);
    return seen;
  };

  // the same computer is the same identity every time, and two computers are two
  assert.deepEqual(await open({ identity: one }), [one.fingerprint]);
  assert.deepEqual(await open({ identity: one }), [one.fingerprint]);
  assert.deepEqual(await open({ identity: two }), [two.fingerprint]);
  // a client that shows nothing is nobody in particular
  assert.deepEqual(await open({}), ['']);
  assert.deepEqual(asked, [one.fingerprint, one.fingerprint, two.fingerprint, '']);
  assert.notEqual(one.fingerprint, two.fingerprint);
  assert.notEqual(one.fingerprint, hostIdentity.fingerprint);

  // showing someone else's certificate without their key does not get as far as saying hello
  const thief = client(port, CODE, { identity: { cert: one.cert, key: two.key } });
  await assert.rejects(thief.connect());
  assert.equal(host.list().length, 0);
});
