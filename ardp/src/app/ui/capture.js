'use strict';

(() => {
  const api = window.ardpCapture;

  let options = null;
  let track = null;
  let reader = null;
  let encoder = null;
  let config = null;
  let live = false;
  let paused = false;
  let wantKey = true;
  let last = null;
  let lastActivity = 0;
  let stale = false;
  let refine = 0;
  let clock = 0;
  let failed = false;
  const counters = { captured: 0, encoded: 0, skipped: 0, bytes: 0 };

  // timestamps have to keep increasing, even for frames we send twice
  function nextTimestamp() {
    clock = Math.max(clock + 1, Math.round(performance.now() * 1000));
    return clock;
  }

  function h264Level(width, height, fps) {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    const rate = mbs * fps;
    const levels = [
      ['1f', 3600, 108000],
      ['20', 5120, 216000],
      ['28', 8192, 245760],
      ['2a', 8704, 522240],
      ['32', 22080, 589824],
      ['33', 36864, 983040],
      ['34', 36864, 2073600],
    ];
    const fit = levels.find(([, maxMbs, maxRate]) => mbs <= maxMbs && rate <= maxRate);
    return fit ? fit[0] : '34';
  }

  function candidates(width, height, fps) {
    const level = h264Level(width, height, fps);
    return [
      { family: 'h264', label: 'H.264 High (hardware)', codec: `avc1.6400${level}`, hw: 'prefer-hardware', annexb: true },
      { family: 'h264', label: 'H.264 Main (hardware)', codec: `avc1.4d00${level}`, hw: 'prefer-hardware', annexb: true },
      { family: 'h264', label: 'H.264 Baseline (hardware)', codec: `avc1.42e0${level}`, hw: 'prefer-hardware', annexb: true },
      { family: 'h264', label: 'H.264 Baseline (software)', codec: `avc1.42e0${level}`, hw: 'prefer-software', annexb: true },
      { family: 'vp8', label: 'VP8 (software)', codec: 'vp8', hw: 'no-preference' },
      { family: 'vp9', label: 'VP9 (software)', codec: 'vp09.00.51.08', hw: 'no-preference' },
    ];
  }

  function onChunk(chunk) {
    if (!live) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    counters.encoded += 1;
    counters.bytes += data.byteLength;
    api.frame({ key: chunk.type === 'key', timestamp: chunk.timestamp }, data);
  }

  function fail(message) {
    if (failed) return;
    failed = true;
    api.error(String(message));
  }

  function probe(candidateConfig, frame) {
    return new Promise((resolve) => {
      let settled = false;
      let produced = false;
      let enc = null;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok && enc && enc.state !== 'closed') {
          try {
            enc.close();
          } catch {}
        }
        resolve(ok ? enc : null);
      };
      const timer = setTimeout(() => settle(false), 5000);
      try {
        enc = new VideoEncoder({
          output: (chunk) => {
            if (live) onChunk(chunk);
            else produced = true;
          },
          error: (err) => {
            if (settled && live) fail(`The video encoder stopped: ${err.message}`);
            else settle(false);
          },
        });
        enc.configure(candidateConfig);
        const copy = new VideoFrame(frame, { timestamp: nextTimestamp() });
        enc.encode(copy, { keyFrame: true });
        copy.close();
        enc.flush().then(
          () => settle(produced),
          () => settle(false),
        );
      } catch {
        settle(false);
      }
    });
  }

  async function chooseEncoder(first, width, height) {
    const wanted = new Set(options.codecs && options.codecs.length ? options.codecs : ['h264', 'vp8', 'vp9']);
    const notes = [];
    for (const candidate of candidates(width, height, options.fps)) {
      if (!wanted.has(candidate.family)) continue;
      const cfg = {
        codec: candidate.codec,
        width,
        height,
        bitrate: options.bitrate,
        framerate: options.fps,
        latencyMode: 'realtime',
        bitrateMode: 'variable',
        hardwareAcceleration: candidate.hw,
      };
      if (candidate.annexb) cfg.avc = { format: 'annexb' };
      try {
        const support = await VideoEncoder.isConfigSupported(cfg);
        if (!support.supported) {
          notes.push(`${candidate.label}: not supported`);
          continue;
        }
        const enc = await probe(cfg, first);
        if (enc) return { encoder: enc, config: cfg, candidate };
        notes.push(`${candidate.label}: failed to start`);
      } catch (err) {
        notes.push(`${candidate.label}: ${err.message}`);
      }
    }
    throw new Error(`No video encoder could be started (${notes.join('; ') || 'no codec in common'}).`);
  }

  async function openDisplay() {
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: options.sourceId,
        minWidth: options.width,
        maxWidth: options.width,
        minHeight: options.height,
        maxHeight: options.height,
        maxFrameRate: options.fps,
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    return stream.getVideoTracks()[0];
  }

  function remember(frame) {
    if (last) last.close();
    last = frame.clone();
  }

  function encode(frame, forceKey) {
    const key = forceKey || wantKey;
    wantKey = false;
    const stamped = new VideoFrame(frame, { timestamp: nextTimestamp() });
    try {
      encoder.encode(stamped, { keyFrame: key });
    } catch (err) {
      fail(`The video encoder stopped: ${err.message}`);
    } finally {
      stamped.close();
    }
  }

  async function pump() {
    for (;;) {
      let result;
      try {
        result = await reader.read();
      } catch (err) {
        fail(`Screen capture stopped: ${err.message}`);
        return;
      }
      if (result.done) {
        api.ended();
        return;
      }
      const frame = result.value;
      counters.captured += 1;
      lastActivity = performance.now();
      remember(frame);
      if (!live || failed) {
        frame.close();
        continue;
      }
      // skip, don't queue: a late frame is worth less than the next one
      if (paused || encoder.encodeQueueSize > 2) {
        counters.skipped += 1;
        stale = true;
        frame.close();
        continue;
      }
      stale = false;
      refine = 3;
      encode(frame, false);
      frame.close();
    }
  }

  // the capturer only fires when the screen changes, so the last frame is re-sent
  // for key frames and a few more times to sharpen a still screen
  function housekeeping() {
    if (!live || failed || !last || paused || encoder.encodeQueueSize > 0) return;
    const idle = performance.now() - lastActivity;
    if (wantKey && idle > 30) {
      encode(last, true);
    } else if (stale && idle > 40) {
      stale = false;
      refine = 3;
      encode(last, false);
    } else if (refine > 0 && idle > 150) {
      refine -= 1;
      lastActivity = performance.now() - 60;
      encode(last, false);
    }
  }

  api.onStart(async (startOptions) => {
    options = startOptions;
    try {
      track = await openDisplay();
      track.addEventListener('ended', () => api.ended());
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 2 });
      reader = processor.readable.getReader();

      const first = await reader.read();
      if (first.done) throw new Error('The display produced no picture.');
      const frame = first.value;
      // codecs want even sizes
      const width = frame.displayWidth & ~1;
      const height = frame.displayHeight & ~1;
      remember(frame);
      const chosen = await chooseEncoder(frame, width, height);
      frame.close();

      encoder = chosen.encoder;
      config = chosen.config;
      api.ready({ width, height, codec: config.codec, family: chosen.candidate.family, encoder: chosen.candidate.label });
      pump();
      setInterval(housekeeping, 40);
      setInterval(() => {
        api.stats({ ...counters, bitrate: config.bitrate, paused });
      }, 1000);
    } catch (err) {
      fail(err && err.message ? err.message : String(err));
    }
  });

  api.onGo(() => {
    live = true;
    wantKey = true;
    lastActivity = performance.now() - 1000;
  });

  api.onKey(() => {
    wantKey = true;
  });

  api.onTune((settings) => {
    if (!encoder || failed) return;
    if (typeof settings.paused === 'boolean') paused = settings.paused;
    if (Number.isFinite(settings.bitrate) && Math.abs(settings.bitrate - config.bitrate) / config.bitrate > 0.04) {
      config = { ...config, bitrate: Math.round(settings.bitrate) };
      try {
        encoder.configure(config);
      } catch (err) {
        fail(`The video encoder stopped: ${err.message}`);
      }
    }
  });
})();
