'use strict';

const { Source, SourceStream } = require('../../host/source');
const { ArdpError } = require('../../protocol/errors');
const { Encoder } = require('./encoder');
const quality = require('./quality');

const failure = (err) => (err instanceof ArdpError ? err : new ArdpError('capture_failed', err.message));

// a source whose picture comes from somewhere other than this desktop, like a vm.
// connect() resolves with a display: { width, height, refresh(), input(event), close() }
// that emits rect, frame, resize and close
class FrameSource extends Source {
  constructor({ id, kind, name, connect, state, actions = {} }) {
    super();
    this.id = id;
    this.kind = kind;
    this.name = name;
    this.connect = connect;
    this.state = state || (() => undefined);
    this.actions = actions;
    this.active = null;
  }

  describe() {
    return { id: this.id, kind: this.kind, name: this.name, state: this.state(), displays: [] };
  }

  async open(request) {
    if (this.active) this.active.finish('replaced');
    let display;
    try {
      display = await this.connect();
    } catch (err) {
      throw failure(err);
    }
    const stream = new FrameStream(this, display, request);
    this.active = stream;
    try {
      await stream.prepare();
    } catch (err) {
      stream.close();
      throw failure(err);
    }
    return stream;
  }
}

class FrameStream extends SourceStream {
  constructor(source, display, request) {
    super();
    this.source = source;
    this.display = display;
    this.request = request;
    this.encoder = null;
    this.closed = false;

    const { fps, bitrate } = quality.plan(request.quality, display.width, display.height, 30);
    this.fps = fps;
    this.bitrate = bitrate;
    const control = !request.viewOnly;
    this.info = {
      source: source.id,
      kind: source.kind,
      name: source.name,
      display: '0',
      width: display.width,
      height: display.height,
      control,
      actions: control ? Object.keys(source.actions) : [],
    };
  }

  async prepare() {
    const display = this.display;
    display.on('close', () => this.finish('source_ended'));
    display.on('resize', () => this.finish('display_changed'));

    const encoder = await Encoder.open(
      {
        mode: 'frames',
        width: display.width,
        height: display.height,
        fps: this.fps,
        bitrate: this.bitrate.start,
        codecs: this.request.codecs,
      },
      (enc) => {
        display.on('rect', (rect) => enc.rect(rect));
        display.on('frame', () => enc.present());
        display.refresh();
      },
    );
    if (this.closed) {
      encoder.close();
      throw new ArdpError('source_ended', 'It stopped while connecting.');
    }
    this.encoder = encoder;
    this.info.width = encoder.width;
    this.info.height = encoder.height;
    encoder.on('frame', (meta, data) => this.emit('frame', meta, data));
    encoder.on('failed', () => this.finish('capture_failed'));
  }

  start() {
    if (this.closed) return;
    this.emit('config', this.encoder.config);
    this.encoder.go();
  }

  requestKeyframe() {
    if (this.encoder) this.encoder.key();
  }

  tune(settings) {
    if (this.encoder) this.encoder.tune(settings);
  }

  input(event) {
    if (!this.closed && this.info.control) this.display.input(event);
  }

  action(name) {
    const run = this.source.actions[name];
    if (this.closed || !this.info.control || !run) return;
    Promise.resolve()
      .then(() => run(this.display))
      .catch(() => {});
  }

  finish(reason) {
    if (this.closed) return;
    this.emit('end', reason);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.source.active === this) this.source.active = null;
    this.display.close();
    if (this.encoder) this.encoder.close();
  }
}

module.exports = { FrameSource };
