'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const qemu = require('./qemu');
const { Qmp } = require('./qmp');
const { VmDisplay } = require('./display');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastLine = (text) => text.trim().split(/\r?\n/).pop() || '';

async function connectWhenUp(port, alive, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await Qmp.connect(port);
    } catch (err) {
      if (!alive() || Date.now() > end) throw err;
      await sleep(150);
    }
  }
}

// one virtual machine. states: stopped, starting, running, stopping
class Vm extends EventEmitter {
  constructor(config, { binary, launcher } = {}) {
    super();
    this.config = config;
    this.launcher = launcher || ((args) => spawn(binary.system, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }));
    this.state = 'stopped';
    this.error = '';
    this.child = null;
    this.qmp = null;
    this.vncPort = 0;
    this._starting = null;
  }

  get id() {
    return this.config.id;
  }

  get name() {
    return this.config.name;
  }

  describe() {
    const { id, name, memory, cpus, iso } = this.config;
    return { id, name, memory, cpus, iso: iso || '', state: this.state, error: this.error };
  }

  start() {
    if (this.state === 'running') return Promise.resolve();
    if (this.state === 'stopping') return Promise.reject(new Error(`${this.name} is still shutting down.`));
    if (!this._starting) {
      this._starting = this._start().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async _start() {
    this.error = '';
    this._set('starting');
    let stderr = '';
    try {
      const vnc = await qemu.freeVncDisplay();
      const qmpPort = await qemu.freePort();
      const child = this.launcher(qemu.buildArgs(this.config, { vnc, qmp: qmpPort }));
      this.child = child;
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr = (stderr + data).slice(-4000);
        });
      }
      const died = new Promise((_, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(lastLine(stderr) || `qemu exited with code ${code}`)));
      });
      died.catch(() => {});
      child.once('exit', () => this._exited(child));

      this.qmp = await Promise.race([connectWhenUp(qmpPort, () => this.child === child), died]);
      this.vncPort = 5900 + vnc;
      this._set('running');
    } catch (err) {
      this.error = err.code === 'ENOENT' ? 'QEMU could not be started.' : err.message;
      this._kill();
      this._set('stopped');
      throw new Error(this.error);
    }
  }

  // asks the guest to shut down like pressing the power button; force pulls the plug
  async stop({ force = false, wait = 30000 } = {}) {
    if (this.state === 'stopped' || !this.child) return;
    const child = this.child;
    this._set('stopping');
    const gone = new Promise((resolve) => child.once('exit', resolve));
    const within = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        gone.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });

    this._tell(force ? 'quit' : 'system_powerdown');
    if (await within(force ? 3000 : wait)) return;
    this._tell('quit');
    if (await within(3000)) return;
    child.kill();
    await within(3000);
  }

  reset() {
    if (this.state !== 'running') return Promise.reject(new Error(`${this.name} is not running.`));
    return this.qmp.execute('system_reset');
  }

  display(options) {
    if (this.state !== 'running') return Promise.reject(new Error(`${this.name} is not running.`));
    return VmDisplay.connect(this.vncPort, options);
  }

  _tell(command) {
    if (this.qmp && !this.qmp.closed) this.qmp.execute(command).catch(() => {});
    else this._kill();
  }

  _kill() {
    if (this.child) this.child.kill();
  }

  _exited(child) {
    if (this.child !== child) return;
    this.child = null;
    if (this.qmp) this.qmp.close();
    this.qmp = null;
    this.vncPort = 0;
    this._set('stopped');
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }
}

module.exports = { Vm };
