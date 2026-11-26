'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const qemu = require('./qemu');
const { Vm } = require('./vm');

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const within = (value, min, max, what) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be between ${min} and ${max}.`);
  return n;
};

// the vms on this machine: one folder each, holding vm.json and the disk
class VmStore extends EventEmitter {
  constructor(dir, { binary, launcher, makeDisk } = {}) {
    super();
    this.dir = dir;
    this.binary = binary === undefined ? qemu.findQemu(process.env.ARP_QEMU) : binary;
    this.launcher = launcher;
    this.makeDisk = makeDisk || ((file, gb) => this._qemuImg(['create', '-f', 'qcow2', file, `${gb}G`]));
    this.vms = new Map();
    this._load();
  }

  get available() {
    return !!(this.binary || this.launcher);
  }

  list() {
    return [...this.vms.values()];
  }

  get(id) {
    return this.vms.get(id) || null;
  }

  async create({ name, memory = 2048, cpus = 2, diskGb = 32, iso = '' }) {
    if (!this.available) throw new Error('QEMU is not installed on this computer.');
    name = String(name || '').trim();
    if (!NAME.test(name)) throw new Error('Use up to 32 letters, digits, spaces, dots or dashes for the name.');
    const id = slug(name);
    if (!id || this.vms.has(id)) throw new Error('There is already a virtual machine with that name.');
    memory = within(memory, 256, 262144, 'Memory');
    cpus = within(cpus, 1, 64, 'Processors');
    diskGb = within(diskGb, 1, 4096, 'Disk size');
    iso = String(iso || '').trim();
    if (iso && !fs.existsSync(iso)) throw new Error('The installer file was not found.');

    const home = path.join(this.dir, id);
    const config = { id, name, memory, cpus, iso, disk: path.join(home, 'disk.qcow2'), created: new Date().toISOString() };
    fs.mkdirSync(home, { recursive: true });
    try {
      await this.makeDisk(config.disk, diskGb);
      this._save(config);
    } catch (err) {
      fs.rmSync(home, { recursive: true, force: true });
      throw err;
    }
    return this._add(config);
  }

  update(id, changes) {
    const vm = this.get(id);
    if (!vm) throw new Error('That virtual machine does not exist.');
    const next = { ...vm.config };
    if (changes.memory !== undefined) next.memory = within(changes.memory, 256, 262144, 'Memory');
    if (changes.cpus !== undefined) next.cpus = within(changes.cpus, 1, 64, 'Processors');
    if (changes.iso !== undefined) {
      next.iso = String(changes.iso || '').trim();
      if (next.iso && !fs.existsSync(next.iso)) throw new Error('The installer file was not found.');
    }
    vm.config = next;
    this._save(next);
    this.emit('change');
    return vm;
  }

  // deletes the vm and its disk for good
  async remove(id) {
    const vm = this.get(id);
    if (!vm) return;
    if (vm.state !== 'stopped') throw new Error(`Shut ${vm.name} down first.`);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.vms.delete(id);
    this.emit('change');
  }

  stopAll(options) {
    return Promise.all(this.list().map((vm) => vm.stop(options).catch(() => {})));
  }

  _load() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const config = JSON.parse(fs.readFileSync(path.join(this.dir, entry.name, 'vm.json'), 'utf8'));
        if (config && config.id === entry.name && config.name && config.disk) this._add(config);
      } catch {}
    }
  }

  _add(config) {
    const vm = new Vm(config, { binary: this.binary, launcher: this.launcher });
    vm.on('state', () => this.emit('change'));
    this.vms.set(config.id, vm);
    this.emit('change');
    return vm;
  }

  _save(config) {
    fs.writeFileSync(path.join(this.dir, config.id, 'vm.json'), `${JSON.stringify(config, null, 2)}\n`);
  }

  _qemuImg(args) {
    return new Promise((resolve, reject) => {
      execFile(this.binary.img, args, { windowsHide: true }, (err, _out, stderr) => {
        if (err) reject(new Error(String(stderr).trim().split(/\r?\n/).pop() || 'The disk could not be created.'));
        else resolve();
      });
    });
  }
}

module.exports = { VmStore };
