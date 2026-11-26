'use strict';

const net = require('net');
const { EventEmitter } = require('events');

// qemu's control socket: one json object per line
class Qmp extends EventEmitter {
  static connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const qmp = new Qmp(net.connect(port, host));
      qmp.once('ready', () => resolve(qmp));
      qmp.once('close', (err) => reject(err || new Error('qemu closed its control socket')));
    });
  }

  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.pending = new Map();
    this.nextId = 1;
    this.text = '';
    socket.setEncoding('utf8');
    socket.on('data', (text) => this._feed(text));
    socket.on('error', (err) => this._end(err));
    socket.on('close', () => this._end());
  }

  execute(command, args) {
    if (this.closed) return Promise.reject(new Error('qemu is not running'));
    const id = this.nextId++;
    const message = { execute: command, id };
    if (args) message.arguments = args;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  close() {
    this._end();
  }

  _feed(text) {
    this.text += text;
    for (;;) {
      const end = this.text.indexOf('\n');
      if (end === -1) return;
      const line = this.text.slice(0, end).trim();
      this.text = this.text.slice(end + 1);
      if (line) this._line(line);
    }
  }

  _line(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.QMP) {
      // nothing works until the greeting is answered
      this.execute('qmp_capabilities').then(
        () => this.emit('ready'),
        (err) => this._end(err),
      );
      return;
    }
    if (message.event) {
      this.emit('event', message.event, message.data || {});
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.desc || 'qemu refused the command'));
    else waiter.resolve(message.return);
  }

  _end(err) {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    const reason = err || new Error('qemu closed its control socket');
    for (const waiter of this.pending.values()) waiter.reject(reason);
    this.pending.clear();
    this.emit('close', err || null);
  }
}

module.exports = { Qmp };
