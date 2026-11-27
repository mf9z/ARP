'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const qemu = require('./qemu');
const { Vm } = require('./vm');

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;
const VARS = 'efi-vars.fd';

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// an installer has to be a real file on this computer, given by its full path
function installer(file) {
  const iso = String(file || '').trim();
  if (!iso) return '';
  const local = path.isAbsolute(iso) && !/^[\\/]{2}/.test(iso) && !iso.includes('://');
  let isFile = false;
  try {
    isFile = local && fs.statSync(iso).isFile();
  } catch {}
  if (!isFile) throw new Error('The installer file was not found.');
  return iso;
}

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

  // the kinds of guest this computer's qemu can run
  get archs() {
    if (!this.binary) return this.launcher ? [...qemu.ARCHS] : [];
    return qemu.ARCHS.filter((arch) => this.binary.systems && this.binary.systems[arch]);
  }

  // a new vm is built like this computer when it can be, which is what runs fast
  get defaultArch() {
    return this.archs.includes(qemu.HOST) ? qemu.HOST : 'x86_64';
  }

  list() {
    return [...this.vms.values()];
  }

  get(id) {
    return this.vms.get(id) || null;
  }

  async create({ name, memory = 2048, cpus = 2, diskGb = 32, iso = '', arch = '' }) {
    if (!this.available) throw new Error('QEMU is not installed on this computer.');
    name = String(name || '').trim();
    if (!NAME.test(name)) throw new Error('Use up to 32 letters, digits, spaces, dots or dashes for the name.');
    const id = slug(name);
    if (!id || this.vms.has(id)) throw new Error('There is already a virtual machine with that name.');
    memory = within(memory, 256, 262144, 'Memory');
    cpus = within(cpus, 1, 64, 'Processors');
    diskGb = within(diskGb, 1, 4096, 'Disk size');
    iso = installer(iso);
    arch = String(arch || this.defaultArch);
    if (!this.archs.includes(arch)) throw new Error('The QEMU on this computer cannot run that kind of virtual machine.');

    const home = path.join(this.dir, id);
    const config = { id, name, arch, memory, cpus, iso, disk: path.join(home, 'disk.qcow2'), vars: '', created: new Date().toISOString() };
    fs.mkdirSync(home, { recursive: true });
    try {
      await this.makeDisk(config.disk, diskGb);
      // an arm guest keeps its firmware settings in a file of its own, started from qemu's blank one
      const blank = arch === 'aarch64' && this.binary && this.binary.firmware ? this.binary.firmware.vars : '';
      if (blank) {
        config.vars = path.join(home, VARS);
        fs.copyFileSync(blank, config.vars, fs.constants.COPYFILE_FICLONE);
      }
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
    if (changes.iso !== undefined) next.iso = installer(changes.iso);
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
        const saved = JSON.parse(fs.readFileSync(path.join(this.dir, entry.name, 'vm.json'), 'utf8'));
        if (!saved || saved.id !== entry.name || !NAME.test(String(saved.name))) continue;
        let iso = '';
        try {
          iso = installer(saved.iso);
        } catch {}
        // the disk is always the one in the vm's own folder, whatever the file says. so is the firmware's memory
        const vars = path.join(this.dir, entry.name, VARS);
        this._add({
          id: entry.name,
          name: String(saved.name),
          arch: saved.arch === 'aarch64' ? 'aarch64' : 'x86_64',
          vars: fs.existsSync(vars) ? vars : '',
          memory: within(saved.memory, 256, 262144, 'Memory'),
          cpus: within(saved.cpus, 1, 64, 'Processors'),
          iso,
          disk: path.join(this.dir, entry.name, 'disk.qcow2'),
          created: String(saved.created || ''),
        });
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
