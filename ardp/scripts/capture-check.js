'use strict';

const { app } = require('electron');
const { DesktopSource } = require('../src/app/host/desktop-source');
const { NativeInput } = require('../src/app/host/input');

const quality = process.argv.find((a) => ['low', 'balanced', 'high'].includes(a)) || 'balanced';

app.whenReady().then(async () => {
  try {
    const input = NativeInput.load();
    console.log(`input backend: ${input ? 'loaded' : `unavailable (${NativeInput.loadError && NativeInput.loadError.message})`}`);
    const source = new DesktopSource({ name: 'check', input });
    console.log('displays:', JSON.stringify(source.describe().displays));

    const started = Date.now();
    const stream = await source.open({
      peer: { address: '127.0.0.1', name: 'check', loopback: true },
      display: null,
      codecs: ['h264', 'vp8', 'vp9'],
      quality,
      viewOnly: true,
    });
    console.log(`ready in ${Date.now() - started} ms: ${stream.encoder.label}, ${stream.info.width}x${stream.info.height}, target ${(stream.bitrate.max / 1e6).toFixed(1)} Mbit/s @ ${stream.fps} fps`);

    let frames = 0;
    let keys = 0;
    let bytes = 0;
    let first = null;
    stream.on('config', (config) => console.log('config:', JSON.stringify(config)));
    stream.on('frame', (meta, data) => {
      if (!first) first = { key: meta.key, bytes: data.length, head: data.subarray(0, 6).toString('hex') };
      frames += 1;
      if (meta.key) keys += 1;
      bytes += data.length;
    });
    stream.on('end', (reason) => console.log('ended:', reason));
    stream.start();

    setTimeout(() => stream.requestKeyframe(), 1500);
    setTimeout(() => {
      console.log(`first frame: ${JSON.stringify(first)}`);
      console.log(`3 s: ${frames} frames (${keys} key), ${(bytes / 1024).toFixed(0)} KiB, stats ${JSON.stringify(stream.encoder.stats)}`);
      stream.close();
      app.exit(frames > 0 ? 0 : 1);
    }, 3000);
  } catch (err) {
    console.error('failed:', err.code || '', err.message);
    app.exit(1);
  }
});
