'use strict';

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  _front(n) {
    if (n > this.length) return null;
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0];
  }

  peek(n) {
    const head = this._front(n);
    return head && head.subarray(0, n);
  }

  take(n) {
    const head = this._front(n);
    if (!head) return null;
    if (head.length === n) this.chunks.shift();
    else this.chunks[0] = head.subarray(n);
    this.length -= n;
    return head.subarray(0, n);
  }
}

module.exports = { ByteQueue };
