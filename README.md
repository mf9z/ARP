<div align="center">

<img src="ardp/assets/icons/icon-128.png" width="96" alt="">

# arp

**Aesthetic Remote Protocol. Your computers, from anywhere, with nothing in the way.**

Remote desktop and virtual machines.

[![Last Commit](https://img.shields.io/github/last-commit/mf9z/ARP)](https://github.com/mf9z/ARP/commits/main)
[![Stars](https://img.shields.io/github/stars/mf9z/ARP?style=flat)](https://github.com/mf9z/ARP/stargazers)

![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![QEMU](https://img.shields.io/badge/QEMU-FF6600?logo=qemu&logoColor=white)

</div>

```
ARP
Aesthetic Remote Protocol

› Remote desktop     use another computer, or let one use this one
  Virtual machines   run other computers inside this one
```

One launcher opens everything. A remote session is a title bar and the other
desktop, and that's the whole window:

```
┌──────────────────────────────────────────────────────────────┐
│ studio-pc - 192.168.1.20 - ARDP                   ─   □   ✕  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                 the other computer's desktop                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## What's in here

| folder                                       | what it is | state |
|----------------------------------------------|------------|-------|
| [`arp-launcher`](arp-launcher)               | the app. One window that launches the rest | works |
| [`ardp`](ardp)                               | Aesthetic Remote Desktop Protocol: the protocol, the host, the session window | works |
| [`arp-vm`](arp-vm)                           | virtual machines on QEMU that you open like any other computer | works |

## Install

```sh
git clone https://github.com/mf9z/ARP && cd ARP
npm install
npm start
```

`npm run dist` builds an installer into `arp-launcher/dist`: a setup program on
Windows, a disk image for each kind of Mac on macOS.

### Needs

| what        | get it with |
|-------------|-------------|
| Node 22.12+ | [nodejs.org](https://nodejs.org) |
| QEMU        | `winget install SoftwareFreedomConservancy.QEMU` on Windows, `brew install qemu` on a Mac, `sudo apt install qemu-system-x86 qemu-utils` on Linux |

`npm install` checks for both and tells you what is missing; `npm run setup`
checks again. Without QEMU the app still opens, says so on its home window and
keeps virtual machines off.

### On a Mac

The first time a Mac is used from another computer, macOS asks twice. Both
questions have a button on **Remote desktop > This computer**:

| macOS setting     | without it |
|-------------------|------------|
| Screen Recording  | the other computer sees nothing. ARP has to be reopened after you allow it |
| Accessibility     | the other computer can watch but not use the pointer or keyboard |

The app is not signed with a paid Apple developer account. The first launch has
to be allowed by hand (right-click the app and choose **Open**, or
**System Settings > Privacy & Security > Open Anyway**), and macOS asks for
the two permissions again after every update.

Virtual machines on an Apple silicon Mac should be **ARM64** ones: those run
at full speed, a PC (x86-64) one is emulated and much slower. The choice is in
the **New** form.

## Use

Every computer runs the same app.

1. On the computer you want to reach, open **Remote desktop**, go to
   **This computer** and tick **Allow remote connections**. It shows an
   address and an access code.
2. On the one you're sitting at, open **Remote desktop**, type both and press
   **Connect**.
3. Back on the first computer a question pops up: allow or deny. Untick
   **Ask me before someone connects** to skip it when nobody is there.

If the other computer has a virtual machine running you're asked which to
open, the main PC or the VM. A VM running on your own computer shows up in
**Remote desktop** with an **Open** button, no address needed.

### Private mode

Tick **Private mode** in the launcher's settings before you share your screen.
From then on no ARP window shows an address, a computer's name, an access code
or the folder your account lives in.

- Saved computers go by **Saved computer 1**, **Saved computer 2** and so on.
- What you type into the address and access code boxes is dotted out.
- **This computer** reads Hidden. **Copy** still copies the real address and code.
- Session title bars, notices, errors and the allow / deny question name nobody.

It hides what ARP itself shows. It cannot hide what is on the other computer's
desktop, or what your system shows in its own file dialogs.

More in [ardp](ardp) and [arp-vm](arp-vm).

## Development

```sh
npm test               # protocol and vm tests
npm run selftest:vm    # the whole app with a stand-in for QEMU, no windows shown
```

## Roadmap

- [x] remote desktop
- [x] one launcher for everything
- [x] virtual machines
- [ ] macOS (passes the same checks on a Mac as on Windows; not yet used on one day to day)
- [ ] calling
- [ ] screen sharing
