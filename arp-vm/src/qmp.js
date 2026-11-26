'use strict';

const { EventEmitter } = require('events');

const MAX_LINE = 1024 * 1024;

// qemu's control channel: one json object per line. arp runs it over qemu's own
// stdin and stdout, so nothing else on the machine (or inside the guest) can reach it
class Qmp extends EventEmitter {
  static open(input, output, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const qmp = new Qmp(input, output);
      const timer = setTimeout(() => qmp._end(new Error('qemu did not answer on its control channel')), timeout);
      qmp.once('ready', () => {
        clearTimeout(timer);
        resolve(qmp);
      });
      qmp.once('close', (err) => {
        clearTimeout(timer);
        reject(err || new Error('qemu closed its control channel'));
      });
    });
  }

  constructor(input, output) {
    super();
    this.input = input;
    this.output = output;
    this.closed = false;
    this.pending = new Map();
    this.nextId = 1;
    this.text = '';
    input.setEncoding('utf8');
    input.on('data', (text) => this._feed(text));
    input.on('error', (err) => this._end(err));
    input.on('close', () => this._end());
    input.on('end', () => this._end());
    output.on('error', (err) => this._end(err));
  }

  execute(command, args) {
    if (this.closed) return Promise.reject(new Error('qemu is not running'));
    const id = this.nextId++;
    const message = { execute: command, id };
    if (args) message.arguments = args;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.output.write(`${JSON.stringify(message)}\n`);
    });
  }

  close() {
    this._end();
  }

  _feed(text) {
    this.text += text;
    for (;;) {
      const end = this.text.indexOf('\n');
      if (end === -1) break;
      const line = this.text.slice(0, end).trim();
      this.text = this.text.slice(end + 1);
      if (line) this._line(line);
    }
    if (this.text.length > MAX_LINE) this._end(new Error('qemu sent an oversized reply'));
  }

  _line(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.QMP) {
      // nothing works until the greeting is answered
      if (this.greeted) return;
      this.greeted = true;
      this.execute('qmp_capabilities').then(
        () => this.emit('ready'),
        (err) => this._end(err),
      );
      return;
    }
    if (typeof message.event === 'string') {
      this.emit('event', message.event, message.data || {});
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error((message.error && message.error.desc) || 'qemu refused the command'));
    else waiter.resolve(message.return);
  }

  _end(err) {
    if (this.closed) return;
    this.closed = true;
    const reason = err || new Error('qemu closed its control channel');
    for (const waiter of this.pending.values()) waiter.reject(reason);
    this.pending.clear();
    this.emit('close', err || null);
  }
}

module.exports = { Qmp };
