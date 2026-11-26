'use strict';

// a stand-in for qemu: a vnc server showing a test picture and a qmp server,
// so everything above them can be tested without a real vm

const net = require('net');
const { ByteQueue } = require('../src/bytes');

function picture(width, height, tick = 0) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = (tick * 8) & 255;
    }
  }
  return data;
}

function rect(x, y, width, height, encoding, data) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(x, 0);
  head.writeUInt16BE(y, 2);
  head.writeUInt16BE(width, 4);
  head.writeUInt16BE(height, 6);
  head.writeInt32BE(encoding, 8);
  return data ? Buffer.concat([head, data]) : head;
}

function update(rects) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(rects.length, 2);
  return Buffer.concat([head, ...rects]);
}

function startVnc(state, port) {
  const server = net.createServer((socket) => {
    const queue = new ByteQueue();
    let stage = 'version';
    let tick = 0;
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.write('RFB 003.008\n');

    const messages = {
      0: () => queue.take(20),
      2: () => {
        const head = queue.peek(4);
        if (!head) return null;
        const b = queue.take(4 + head.readUInt16BE(2) * 4);
        if (!b) return null;
        const wanted = [];
        for (let i = 4; i < b.length; i += 4) wanted.push(b.readInt32BE(i));
        state.encodings = wanted;
        if (state.extKeys && wanted.includes(-258)) socket.write(update([rect(0, 0, state.width, state.height, -258)]));
        return b;
      },
      3: () => {
        const b = queue.take(10);
        if (!b) return null;
        state.requests += 1;
        if (state.resizeTo) {
          Object.assign(state, state.resizeTo, { resizeTo: null });
          socket.write(update([rect(0, 0, state.width, state.height, -223)]));
        } else if (b[1] === 0) {
          socket.write(update([rect(0, 0, state.width, state.height, 0, picture(state.width, state.height, tick))]));
        } else {
          // something always moves, like a blinking cursor would
          tick += 1;
          const x = (tick * 4) % (state.width - 16);
          setTimeout(() => {
            if (!socket.destroyed) socket.write(update([rect(x, 8, 16, 16, 0, Buffer.alloc(16 * 16 * 4, 200))]));
          }, 5);
        }
        return b;
      },
      4: () => {
        const b = queue.take(8);
        if (b) state.events.push({ t: 'key', down: b[1] === 1, keysym: b.readUInt32BE(4) });
        return b;
      },
      5: () => {
        const b = queue.take(6);
        if (b) state.events.push({ t: 'pointer', mask: b[1], x: b.readUInt16BE(2), y: b.readUInt16BE(4) });
        return b;
      },
      255: () => {
        const b = queue.take(12);
        if (b) state.events.push({ t: 'xkey', down: b.readUInt16BE(2) === 1, keysym: b.readUInt32BE(4), code: b.readUInt32BE(8) });
        return b;
      },
    };

    socket.on('data', (chunk) => {
      queue.push(chunk);
      for (;;) {
        if (stage === 'version') {
          if (!queue.take(12)) return;
          socket.write(Buffer.from([1, 1]));
          stage = 'security';
        } else if (stage === 'security') {
          if (!queue.take(1)) return;
          socket.write(Buffer.alloc(4));
          stage = 'init';
        } else if (stage === 'init') {
          if (!queue.take(1)) return;
          const name = Buffer.from(state.name);
          const init = Buffer.alloc(24);
          init.writeUInt16BE(state.width, 0);
          init.writeUInt16BE(state.height, 2);
          init.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([init, name]));
          stage = 'run';
        } else {
          const type = queue.peek(1);
          if (!type) return;
          const handler = messages[type[0]];
          if (!handler) {
            socket.destroy();
            return;
          }
          if (!handler()) return;
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function startQmp(state, port, { onQuit } = {}) {
  const server = net.createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    const send = (object) => socket.write(`${JSON.stringify(object)}\r\n`);
    send({ QMP: { version: { qemu: { major: 9, minor: 0, micro: 0 } }, capabilities: [] } });

    const commands = {
      qmp_capabilities: () => ({}),
      'query-status': () => ({ status: 'running', running: true }),
      system_reset: () => {
        state.resets += 1;
        send({ event: 'RESET', data: { guest: false } });
        return {};
      },
      system_powerdown: () => {
        if (!state.ignorePower) {
          send({ event: 'SHUTDOWN', data: { guest: true } });
          setTimeout(() => onQuit && onQuit(), 30);
        }
        return {};
      },
      quit: () => {
        setTimeout(() => onQuit && onQuit(), 10);
        return {};
      },
      'x-fake-events': () => state.events.splice(0),
      'x-fake-state': () => ({ requests: state.requests, encodings: state.encodings, resets: state.resets, argv: process.argv.slice(2) }),
      'x-fake-resize': (args) => {
        state.resizeTo = { width: args.width, height: args.height };
        return {};
      },
    };

    socket.on('data', (chunk) => {
      text += chunk;
      for (;;) {
        const end = text.indexOf('\n');
        if (end === -1) return;
        const line = text.slice(0, end).trim();
        text = text.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const run = commands[message.execute];
        if (run) send({ return: run(message.arguments || {}), id: message.id });
        else send({ error: { class: 'CommandNotFound', desc: `The command ${message.execute} has not been found` }, id: message.id });
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function startFake({ vnc = 0, qmp = 0, width = 320, height = 200, extKeys = true, ignorePower = false, onQuit } = {}) {
  const state = { width, height, name: 'fake', extKeys, ignorePower, events: [], encodings: [], requests: 0, resets: 0, resizeTo: null };
  const vncServer = await startVnc(state, vnc);
  const qmpServer = await startQmp(state, qmp, { onQuit });
  return {
    state,
    vncPort: vncServer.address().port,
    qmpPort: qmpServer.address().port,
    close() {
      vncServer.close();
      qmpServer.close();
    },
  };
}

module.exports = { startFake };
