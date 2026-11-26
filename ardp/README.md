<div align="center">

<img src="assets/icons/icon-128.png" width="96" alt="">

# ardp

**Aesthetic Remote Desktop Protocol. Use another computer like you're sitting at it.**

A session is a title bar and the other desktop. That's the whole window.

[![Last Commit](https://img.shields.io/github/last-commit/mf9z/ARP)](https://github.com/mf9z/ARP/commits/main)
[![Stars](https://img.shields.io/github/stars/mf9z/ARP?style=flat)](https://github.com/mf9z/ARP/stargazers)

![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)

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

The remote desktop part of [ARP](..), the Aesthetic Remote Protocol. It carries
the screen, keyboard and mouse.

## Install

```sh
git clone https://github.com/mf9z/ARP && cd ARP/ardp
npm install
npm start
```

Or build an installer and run that on each computer:

```sh
npm run dist      # dist/ARDP Setup 0.1.0.exe, or a .dmg when built on a Mac
```

Needs Node 22.12+. Builds aren't code-signed yet, so Windows SmartScreen warns
on first launch.

## Use

Both computers run the same app.

1. On the computer you want to reach, open **This computer** and tick
   **Allow remote connections**. It shows an address and an access code.
2. On the one you're sitting at, type both and press **Connect**.

```
192.168.1.20            default port 7389
192.168.1.20:7400       a different port
studio-pc               a name works too
```

| in a session        | what it does |
|---------------------|--------------|
| click the penguin   | window menu: full screen, view only, switch display, send the Windows key, disconnect |
| `Ctrl+Alt+Enter`    | full screen. The title bar hides; rest the pointer on the top edge to get it back |
| copy / paste        | text copied on one side can be pasted on the other |

While a computer accepts connections the app stays in the tray. Windows asks
about the firewall the first time; to connect over the internet, forward the
port or use a VPN.

## How it works

1. The host captures a display and encodes it as H.264 on the GPU. Without one
   it falls back to software H.264, then VP8.
2. Frames travel over a single TLS connection. The client decodes them and
   draws straight to a canvas.
3. The client acknowledges every frame it shows. If frames start piling up the
   host stops encoding and lowers the bitrate instead of falling behind.
4. Mouse and keys go back as physical keys and 0 to 1 coordinates, and the
   host plays them into its desktop.

Frames are only sent when the screen changes. A still screen gets a few extra
passes so text ends up sharp. The wire format is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Security

- Everything is inside TLS. The host's certificate is made on first run.
- Both sides prove they know the access code, and the proof is tied to the
  certificate the client saw, so it can't be relayed by someone in the middle.
- A host's identity is remembered. If it changes you're asked before going on.
- Five wrong codes lock that address out, for longer each time.
- Hosting is off until you turn it on. **New** replaces the code and
  disconnects everyone using the old one.
- Saved codes are encrypted with the OS credential store.

## Limits

- No sound yet.
- The Windows key, `Alt+Tab` and `Ctrl+Alt+Del` stay on the computer you're
  sitting at. The window menu can send the Windows key.
- It runs as a normal app, so it can't see or control UAC prompts or the lock
  screen. Someone has to be signed in on the host.
- Connecting to the same computer only watches, otherwise the pointer chases
  itself.
- Not tested on macOS yet. The host needs Screen Recording and Accessibility
  permission there.

## Development

```sh
npm test            # protocol tests
npm run selftest    # the real app connects to itself and saves screenshots
npm run icons       # rebuild the icons from assets/ardp.svg
```

| path            | what's in it |
|-----------------|--------------|
| `src/protocol`  | framing, messages, access code proof |
| `src/host`      | the host, flow control, the `Source` interface |
| `src/client`    | the client |
| `src/app`       | the Electron app: launcher, session window, capture, input |
| `docs`          | the wire protocol |

## Sources

The host doesn't talk to a desktop directly, it talks to a `Source`
(`src/host/source.js`). The desktop is the first one. [arp-vm](../arp-vm) adds
QEMU guests as another: same protocol, same session window.
