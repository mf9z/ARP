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
  constructor({ id, kind, name, connect, state, allowControl, actions = {} }) {
    super();
    this.id = id;
    this.kind = kind;
    this.name = name;
    this.connect = connect;
    this.state = state || (() => undefined);
    this.actions = actions;
    this.allowControl = allowControl || (() => true);
    this.active = null;
    this._opening = null;
  }

  describe() {
    return { id: this.id, kind: this.kind, name: this.name, state: this.state(), displays: [] };
  }

  // one at a time, so two callers cannot both end up attached
  open(request) {
    const turn = (this._opening || Promise.resolve()).catch(() => {}).then(() => this._open(request));
    this._opening = turn;
    return turn;
  }

  async _open(request) {
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
    this.feed = null;
    this.started = false;
    this.closed = false;
    this._building = null;
    this._stale = false;

    const { fps, bitrate } = quality.plan(request.quality, display.width, display.height, 30);
    this.fps = fps;
    this.bitrate = bitrate;
    // on this computer the owner always controls their own vm; others only if the host allows it
    const control = !request.viewOnly && (request.peer.local === true || source.allowControl());
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
    display.on('rect', (rect) => {
      if (this.feed) this.feed.rect(rect);
    });
    display.on('frame', () => {
      if (this.feed) this.feed.present();
    });
    // a guest changes resolution a few times while it boots; the stream just carries on
    display.on('resize', () => {
      this._stale = true;
      if (this.feed && this.feed !== this.encoder) this.feed.close();
      this._rebuild().catch(() => this.finish('capture_failed'));
    });
    await this._rebuild();
    if (this.closed) throw new ArdpError('source_ended', 'It stopped while connecting.');
  }

  // makes the encoder for the size the display has now, and swaps it in
  _rebuild() {
    if (!this._building) {
      this._building = this._build().finally(() => {
        this._building = null;
      });
    }
    return this._building;
  }

  async _build() {
    do {
      this._stale = false;
      const { width, height } = this.display;
      let encoder;
      try {
        encoder = await Encoder.open(
          { mode: 'frames', width, height, fps: this.fps, bitrate: quality.plan(this.request.quality, width, height, 30).bitrate.start, codecs: this.request.codecs },
          (enc) => {
            this.feed = enc;
            this.display.refresh();
          },
        );
      } catch (err) {
        if (this._stale && !this.closed) continue;
        throw err;
      }
      if (this.closed || this._stale) {
        encoder.close();
        continue;
      }

      const old = this.encoder;
      this.encoder = encoder;
      this.info.width = encoder.width;
      this.info.height = encoder.height;
      encoder.on('frame', (meta, data) => {
        if (this.encoder === encoder) this.emit('frame', meta, data);
      });
      encoder.on('failed', () => {
        if (this.encoder === encoder) this.finish('capture_failed');
      });
      if (old) old.close();
      if (this.started) {
        this.emit('config', encoder.config);
        encoder.go();
      }
    } while (this._stale && !this.closed);
  }

  start() {
    if (this.closed) return;
    this.started = true;
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
    const run = Object.hasOwn(this.source.actions, name) ? this.source.actions[name] : null;
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
    if (this.feed) this.feed.close();
    if (this.encoder) this.encoder.close();
  }
}

module.exports = { FrameSource };
