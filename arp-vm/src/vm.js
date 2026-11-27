'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const qemu = require('./qemu');
const { Qmp } = require('./qmp');
const { VmDisplay } = require('./display');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastLine = (text) => text.trim().split(/\r?\n/).pop() || '';

// vnc only looks at the first eight characters of a password
const screenPassword = () => crypto.randomBytes(6).toString('base64');

// one virtual machine. states: stopped, starting, running, stopping
class Vm extends EventEmitter {
  constructor(config, { binary, launcher } = {}) {
    super();
    this.config = config;
    this.binary = binary || null;
    // each kind of guest has its own qemu program
    this.launcher = launcher || ((args, arch) => spawn(binary.systems[arch] || binary.system, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    this.state = 'stopped';
    this.error = '';
    this.child = null;
    this.qmp = null;
    this.vncPort = 0;
    this.vncPassword = '';
    // how it is running: a hypervisor's name, or tcg for plain emulation
    this.accel = '';
    this._starting = null;
  }

  get id() {
    return this.config.id;
  }

  get name() {
    return this.config.name;
  }

  describe() {
    const { id, name, arch, memory, cpus, iso } = this.config;
    return { id, name, arch: arch || 'x86_64', memory, cpus, iso: iso || '', state: this.state, error: this.error };
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
    try {
      const vnc = await qemu.freeVncDisplay();
      const ways = qemu.accelerators(this.config.arch || 'x86_64');
      try {
        await this._launch(vnc, ways);
      } catch (err) {
        // the fast way can refuse outright, inside another vm for one. emulation always starts
        if (ways.length < 2 || err.code === 'ENOENT') throw err;
        await this._drop();
        await this._launch(vnc, ['tcg']);
      }
      this.vncPort = 5900 + vnc;
      this._set('running');
    } catch (err) {
      this.error = err.code === 'ENOENT' ? 'QEMU could not be started.' : err.message;
      this._kill();
      this._set('stopped');
      throw new Error(this.error);
    }
  }

  async _launch(vnc, accel) {
    let stderr = '';
    // with a stand-in for qemu there is no firmware to find, and none is read
    const firmware = this.binary ? this.binary.firmware : { code: 'edk2-aarch64-code.fd', vars: '' };
    const child = this.launcher(qemu.buildArgs(this.config, { vnc, firmware, accel }), this.config.arch || 'x86_64');
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

    this.qmp = await Promise.race([Qmp.open(child.stdout, child.stdin), died]).catch(async (err) => {
      // if qemu died, its own last words say more than a closed pipe does
      const last = await Promise.race([died.catch((e) => e), sleep(500).then(() => null)]);
      throw last || err;
    });
    this.vncPassword = screenPassword();
    await Promise.race([this.qmp.execute('set_password', { protocol: 'vnc', password: this.vncPassword }), died]);
    // qemu says so when it stepped down to emulation by itself
    this.accel = accel.length > 1 && !/falling back to tcg/i.test(stderr) ? accel[0] : 'tcg';
  }

  // an attempt that failed has to be fully gone before the next one takes its place
  async _drop() {
    const child = this.child;
    this.child = null;
    if (this.qmp) this.qmp.close();
    this.qmp = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([gone, sleep(3000)]);
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
    return VmDisplay.connect(this.vncPort, { ...options, password: this.vncPassword });
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
    this.vncPassword = '';
    this.accel = '';
    this._set('stopped');
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }
}

module.exports = { Vm };
