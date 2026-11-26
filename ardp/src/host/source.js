'use strict';

const { EventEmitter } = require('events');

class Source {
  describe() {
    throw new Error('not implemented');
  }

  async open(request) {
    throw new Error('not implemented');
  }
}

class SourceStream extends EventEmitter {
  constructor() {
    super();
    this.info = { source: '', name: '', width: 0, height: 0, control: false };
    this.bitrate = { start: 8_000_000, min: 400_000, max: 8_000_000 };
    this.fps = 60;
  }

  start() {}
  requestKeyframe() {}
  tune(settings) {}
  input(event) {}
  clipboard(text) {}
  action(name) {}
  close() {}
}

module.exports = { Source, SourceStream };
