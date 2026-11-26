'use strict';

class FlowControl {
  constructor({ fps = 60, bitrate, minBitrate = 400_000, maxBitrate } = {}) {
    this.fps = fps;
    this.maxBitrate = maxBitrate || bitrate || 8_000_000;
    this.minBitrate = Math.min(minBitrate, this.maxBitrate);
    this.bitrate = Math.min(bitrate || this.maxBitrate, this.maxBitrate);
    this.sent = 0;
    this.acked = 0;
    this.paused = false;
    this._calm = 0;
    this._busy = 0;
    this._lastChange = 0;
  }

  get inFlight() {
    return Math.max(0, this.sent - this.acked);
  }

  onSent(seq) {
    this.sent = seq;
  }

  onAck(seq) {
    if (Number.isInteger(seq) && seq > this.acked && seq <= this.sent) this.acked = seq;
  }

  // tcp never drops, it queues: when frames pile up stop encoding and lower the bitrate
  tick(bufferedBytes = 0, now = Date.now()) {
    const limit = Math.max(4, Math.round(this.fps * 0.2));
    const queueLimit = Math.max(128 * 1024, this.bitrate / 8 / 4);
    const behind = this.inFlight > limit || bufferedBytes > queueLimit;
    const clear = this.inFlight <= Math.max(2, limit / 2) && bufferedBytes < queueLimit / 2;

    const before = { paused: this.paused, bitrate: this.bitrate };

    if (behind) {
      this.paused = true;
      this._calm = 0;
      this._busy += 1;
      if (this._busy >= 2 && now - this._lastChange > 1000) {
        this.bitrate = Math.max(this.minBitrate, Math.round(this.bitrate * 0.7));
        this._lastChange = now;
      }
    } else {
      if (clear) this.paused = false;
      this._busy = 0;
      this._calm += 1;
      if (this._calm >= 12 && now - this._lastChange > 2500 && this.bitrate < this.maxBitrate) {
        this.bitrate = Math.min(this.maxBitrate, Math.round(this.bitrate * 1.15));
        this._lastChange = now;
      }
    }

    if (before.paused === this.paused && before.bitrate === this.bitrate) return null;
    return { paused: this.paused, bitrate: this.bitrate };
  }
}

module.exports = { FlowControl };
