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

ardp is a library plus its windows. The app that runs it is
[arp-launcher](../arp-launcher); from the repo root:

```sh
npm install
npm start
```

## Use

Both computers run the same app.

1. On the computer you want to reach, open **This computer** and tick
   **Allow remote connections**. It shows an address and an access code.
2. On the one you're sitting at, type both and press **Connect**. Leave
   **Click and control with my mouse and keyboard** ticked to use that
   computer, or untick it to only watch.

```
192.168.1.20            default port 7389
192.168.1.20:7400       a different port
studio-pc               a name works too
```

| in a session        | what it does |
|---------------------|--------------|
| **Take control**    | the button in the title bar. Click it to use your mouse and keyboard on the other computer; it turns blue and reads **Controlling**. Click again to go back to watching |
| click the penguin   | window menu: full screen, view only, switch display, send the Windows key, disconnect |
| `Ctrl+Alt+Enter`    | full screen. The title bar hides; rest the pointer on the top edge to get it back |
| copy / paste        | text copied on one side can be pasted on the other |

### Asking first

With **Ask me before someone connects** ticked (it is by default), the computer
being connected to shows who is asking and waits for **Allow** or **Deny**. No
answer in 30 seconds counts as no. Untick it to reach a computer nobody is
sitting at.

### Virtual machines

If the other computer has a virtual machine running you're asked which to
open, the main PC or the VM. You can also type `192.168.1.20/vm:name`, which
switches the VM on if it is off. A VM running on this computer is listed under
**Running on this computer** with an **Open** button. A VM's window menu gets
**Send Ctrl+Alt+Del**, **Restart** and **Shut down**.

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
  certificate the client saw and to that one TLS session, so it can't be
  relayed by someone in the middle, not even with a stolen copy of the host's key.
- A host's identity is remembered. If it changes you're asked before going on.
- Five wrong codes lock that address out, for longer each time.
- Someone at the host gets to allow or deny each connection, unless that is switched off.
- Hosting is off until you turn it on. **New** replaces the code and
  disconnects everyone using the old one.
- Saved codes and the host's private key are encrypted with the OS credential
  store.
- A connection only goes one way. You see and steer the computer you connected
  to; it can never see, steer or open anything on yours through that
  connection. If it tries, the connection is dropped.
- View only is enforced on your side, whatever the other computer claims, and
  the clipboard is only shared while you control and the session window is in
  front.
- In private mode the app does the hiding, not the page: a window is sent
  "Saved computer 2" or "Hidden" in place of an address, a name or a code,
  and every other piece of text passes through a scrubber on the way.
- Each window can only call the parts of the app that belong to it. A window
  showing another computer's picture cannot read the access code or change
  settings.
- Strangers get a few kilobytes and 15 seconds; one address cannot take every
  connection slot.

## Limits

- No sound yet.
- The Windows key, `Alt+Tab` and `Ctrl+Alt+Del` stay on the computer you're
  sitting at. The window menu can send the Windows key.
- It runs as a normal app, so it can't see or control UAC prompts or the lock
  screen. Someone has to be signed in on the host.
- Connecting to the same computer starts out watching, because the pointer
  would chase its own picture. Move the window where you want it, then press
  **Take control**.
- On a Mac the host needs Screen Recording and Accessibility permission.
  **This computer** says which one is missing and has a button for each. Until
  Accessibility is given, sessions to that Mac only watch.
- While you control another computer from a Mac, `Cmd+Q`, `Cmd+W` and `Cmd+H`
  go to it. `Cmd+Tab` and `Cmd+Space` stay with macOS.
- On a Mac it has only been run by the automated checks, not used day to day.

## Development

```sh
npm test -w ardp                                # protocol tests
npx electron ardp/scripts/capture-check.js      # which video encoder this machine picks
npx electron ardp/scripts/make-icons.js         # rebuild the icons from assets/ardp.svg
```

| path            | what's in it |
|-----------------|--------------|
| `src/protocol`  | framing, messages, access code proof |
| `src/host`      | the host, flow control, the `Source` interface |
| `src/client`    | the client |
| `src/app`       | the Electron side: the remote desktop window, the session window, capture, input |
| `docs`          | the wire protocol |

## Sources

The host doesn't talk to a desktop directly, it talks to a `Source`
(`src/host/source.js`). The desktop is one (`src/app/host/desktop-source.js`).
A virtual machine is another (`frame-source.js`, fed by [arp-vm](../arp-vm)):
same encoder, same protocol, same session window.
