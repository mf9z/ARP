# arp-launcher

**The ARP app. One window that launches the rest.**

```
› Remote desktop     use another computer, or let one use this one
  Virtual machines   run other computers inside this one
```

| button            | opens |
|-------------------|-------|
| Remote desktop    | [ardp](../ardp)'s window: connect to a computer, or let computers connect to this one |
| Virtual machines  | the VM manager, on top of [arp-vm](../arp-vm): new, open, start, shut down, remove |

Under the buttons is **Settings**, with one switch so far:

| setting       | what it does |
|---------------|--------------|
| Private mode  | for sharing your screen. Every window stops showing addresses, computer names, access codes and account folders. Saved computers are listed by number, typed addresses and codes are dotted out, and anything else on its way to a window is scrubbed first |

It also owns what has to outlive any one window: the tray icon while this
computer is reachable or runs a VM, the allow / deny question when someone
connects, and shutting VMs down properly when the app quits.

## Run

From the repo root:

```sh
npm install
npm start
npm run dist           # installer in arp-launcher/dist (a .dmg per kind of Mac, on a Mac)
```

## Development

```sh
npm run selftest:vm    # everything but the picture on your screen, no windows shown
npm run selftest       # opens real windows and connects this computer to itself
ARP --check            # a built copy: starts as it would for you, says what works, quits
npx electron arp-launcher/scripts/vm-check.js    # a vm through encoder, host and client (--real for real QEMU)
npx electron arp-launcher/scripts/real-vm-check.js --iso some.iso    # boot a real guest, save its screen
```

`src/main.js` is the app. `src/ui` holds the home window and the VM manager;
the look (title bar, classic controls) comes from ardp over the `ardp-ui://`
scheme, so every window matches.
