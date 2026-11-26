'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { VmStore } = require('arp-vm');
const { FrameSource } = require('./host/frame-source');

const CTRL_ALT_DEL = ['ControlLeft', 'AltLeft', 'Delete'];

class VmService extends EventEmitter {
  constructor({ dir, store }) {
    super();
    // ARP_FAKE_QEMU=1 swaps qemu for a stand-in that shows a test picture
    if (!store && process.env.ARP_FAKE_QEMU === '1') store = require('arp-vm/dev/stand-in')();
    this.store = new VmStore(path.join(dir, 'vms'), store);
    this.made = new Map();
    this.store.on('change', () => this.emit('change', this.state()));
  }

  state() {
    return { available: this.store.available, vms: this.store.list().map((vm) => vm.describe()) };
  }

  sources() {
    const vms = this.store.list();
    for (const id of this.made.keys()) {
      if (!vms.some((vm) => vm.id === id)) this.made.delete(id);
    }
    return vms.map((vm) => {
      if (!this.made.has(vm.id)) this.made.set(vm.id, this._source(vm));
      return this.made.get(vm.id);
    });
  }

  create(spec) {
    return this.store.create(spec);
  }

  start(id) {
    return this._vm(id).start();
  }

  stop(id, force = false) {
    return this._vm(id).stop({ force });
  }

  remove(id) {
    return this.store.remove(id);
  }

  shutdown() {
    return this.store.stopAll();
  }

  _vm(id) {
    const vm = this.store.get(id);
    if (!vm) throw new Error('That virtual machine does not exist.');
    return vm;
  }

  _source(vm) {
    return new FrameSource({
      id: `vm:${vm.id}`,
      kind: 'vm',
      name: vm.name,
      state: () => vm.state,
      // connecting to a vm that is off turns it on
      connect: async () => {
        await vm.start();
        return vm.display();
      },
      actions: {
        'ctrl-alt-del': (display) => display.tap(CTRL_ALT_DEL),
        restart: () => vm.reset(),
        shutdown: () => vm.stop(),
      },
    });
  }
}

module.exports = { VmService };
