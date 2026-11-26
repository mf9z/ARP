# arp-vm

**Virtual machines for ARP, on QEMU.**

A VM shows up on a host as one more thing you can connect to, next to its
desktop. Same protocol, same session window.

This is the part that runs the VMs. It has no UI of its own: [ardp](../ardp)
carries their screen, and [arp-launcher](../arp-launcher) has the window that
manages them.

## Needs

[QEMU](https://www.qemu.org/download/) on the computer that runs the VMs:
`qemu-system-x86_64` and `qemu-img`, on the `PATH` or in the usual install
folder. Set `ARP_QEMU` to point somewhere else. Nothing is needed on the
computers that only connect.

## How it works

1. A VM is a folder with a `vm.json` and a qcow2 disk made by `qemu-img`.
2. Starting one runs QEMU with no window of its own. Control goes over pipes
   only ARP holds, so there is no control port for anything else to find. The
   screen listens on this computer only, behind a random password set at
   every start.
3. `VmDisplay` reads the screen from there and hands changed rectangles to
   ardp, which encodes them like a desktop.
4. Mouse and keys arrive as ardp input events and go into the guest: absolute
   pointer positions and physical key scancodes, so the guest's own keyboard
   layout decides what is typed.
5. Shut down presses the guest's power button. If it ignores that for 30
   seconds it is switched off.

## Use

```js
const { VmStore } = require('arp-vm');

const store = new VmStore('/path/to/vms');
const vm = await store.create({ name: 'Ubuntu', memory: 4096, cpus: 2, diskGb: 64, iso: '/isos/ubuntu.iso' });
await vm.start();

const display = await vm.display();
display.on('rect', ({ x, y, width, height, data }) => {});   // b g r x pixels
display.on('frame', () => {});                                // an update is complete
display.refresh();
display.input({ t: 'key', code: 'Enter', down: true });

await vm.stop();
```

## Development

```sh
npm test -w arp-vm
```

The tests don't need QEMU. `dev/fake-qemu.js` stands in for it: it takes the
same arguments, serves a test picture as the VM's screen and answers the
control socket. `ARP_FAKE_QEMU=1` makes the app use it too.

Against the real thing, from the repo root (no window is shown, the guest's
screen is saved as png):

```sh
npx electron arp-launcher/scripts/real-vm-check.js --iso some.iso --type root
npx electron arp-launcher/scripts/vm-check.js --real
```

## Limits

- Tested on Windows with QEMU 11 and an Alpine Linux guest. Nothing else yet.
- Without hardware acceleration guests are slow. On Windows that means turning
  on the "Windows Hypervisor Platform" feature; QEMU falls back to plain
  emulation when it is off.

- x86-64 guests only.
- No sound and no clipboard between the guest and you.
- A guest can reach network services that listen only on this computer
  (127.0.0.1) through its own gateway address; that is how QEMU's built-in
  networking works. ARP's own listeners all need a secret, other programs'
  may not. Treat a VM running something you don't trust accordingly.
- An installer image is always attached as a plain disc image, so a file that
  is really a QEMU disk pointing at other files on this computer gets nowhere.
- If the app is killed, its VMs keep running until you end the QEMU processes.
