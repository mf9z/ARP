<div align="center">

<img src="ardp/assets/icons/icon-128.png" width="96" alt="">

# arp

**Aesthetic Remote Protocol. Your computers, from anywhere, with nothing in the way.**

Remote desktop today. Virtual machines next. Then calling and screen sharing.

[![Last Commit](https://img.shields.io/github/last-commit/mf9z/ARP)](https://github.com/mf9z/ARP/commits/main)
[![Stars](https://img.shields.io/github/stars/mf9z/ARP?style=flat)](https://github.com/mf9z/ARP/stargazers)

![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![QEMU](https://img.shields.io/badge/QEMU-FF6600?logo=qemu&logoColor=white)

</div>

```
┌──────────────────────────────────────────────────────────────┐
│ studio-pc - 192.168.1.20 - ARDP                   ─   □   ✕  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                                                              │
│                 the other computer's desktop                 │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

A session is a title bar and the other desktop. That's the whole window.

## What's in here

| folder                                       | what it is | state |
|----------------------------------------------|------------|-------|
| [`ardp`](ardp)                               | Aesthetic Remote Desktop Protocol. The app: connect to a computer, or let one connect to you | works |
| [`arp-vm`](arp-vm)                           | virtual machines on QEMU that you open like any other computer | next |

## Install

```sh
git clone https://github.com/mf9z/ARP && cd ARP/ardp
npm install
npm start
```

Needs Node 22.12+. `npm run dist` builds an installer.

## Use

Both computers run the same app.

1. On the computer you want to reach, open **This computer** and tick
   **Allow remote connections**. It shows an address and an access code.
2. On the one you're sitting at, type both and press **Connect**.

Everything else is in [ardp](ardp).

## Roadmap

- [x] remote desktop
- [ ] virtual machines
- [ ] calling
- [ ] screen sharing
