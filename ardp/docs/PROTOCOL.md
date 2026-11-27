# ARDP wire protocol, version 1

ARDP (Aesthetic Remote Desktop Protocol) carries one remote display and its input over a single TCP connection. This is everything a second implementation needs. The reference implementation is `src/protocol`, `src/host` and `src/client`.

## Transport

- TCP, default port **7389**. The client connects to the host.
- TLS 1.2 or newer, ALPN `ardp/1`. The host presents a long-lived self-signed certificate (ECDSA P-256). The client does not validate the chain; identity comes from the access-code proof below.
- The **fingerprint** of the host is the SHA-256 of its DER certificate, written as upper-case hex.
- The host asks for a client certificate and accepts any, or none. A client should present its own long-lived self-signed certificate; its fingerprint, computed the same way, is the **client identity**. TLS proves the client holds the key. A host may use the identity to recognise a client it has let in before, for example to skip asking its user again. It never replaces the access-code proof, and a client without a certificate must still be served.

## Framing

Every message, in both directions:

| Bytes | Field | Notes |
| --- | --- | --- |
| 4 | length | big endian; counts the type byte and the payload; 1 to 33 554 432 |
| 1 | type | see below |
| length − 1 | payload | UTF-8 JSON object, except `VIDEO_FRAME` |

An empty payload is read as `{}`. Unknown message types and unknown JSON members are ignored, so either side can be newer than the other.

**A connection has one direction.** The side that connected is the client for as long as the connection lives, and the other side is the host. A message marked C → H below may only come from the client, and one marked H → C only from the host. A client that receives a C → H message (HELLO, AUTH, OPEN, VIDEO_KEY, VIDEO_ACK, INPUT, ACTION) and a host that receives an H → C message (CHALLENGE, WELCOME, OPENED, WAIT, VIDEO_CONFIG, VIDEO_FRAME) must answer `ERROR bad_protocol` and close. There is no message that swaps the roles, and none may be added: a host must never be able to see or steer the computer that connected to it.

## Messages

| Type | Name | Direction | Payload |
| --- | --- | --- | --- |
| `0x01` | HELLO | C → H | `{ v: 1, client: { name, platform, version }, nonce }` |
| `0x02` | CHALLENGE | H → C | `{ v: 1, host: { name, platform, version }, nonce, salt, kdf }` |
| `0x03` | AUTH | C → H | `{ proof }` |
| `0x04` | WELCOME | H → C | `{ proof, sources: [Source] }` |
| `0x05` | ERROR | both | `{ code, message }`; the sender closes afterwards |
| `0x10` | OPEN | C → H | `{ source?, display?, codecs: [family], quality, viewOnly }` |
| `0x11` | OPENED | H → C | `{ source, kind, name, display, width, height, control, actions }` |
| `0x12` | CLOSE | both | `{ reason }`; the sender closes afterwards |
| `0x13` | WAIT | H → C | `{ for: "approval" }`; OPENED will take a while |
| `0x20` | VIDEO_CONFIG | H → C | `{ codec, width, height, description? }` |
| `0x21` | VIDEO_FRAME | H → C | binary, below |
| `0x22` | VIDEO_KEY | C → H | empty; asks for a key frame |
| `0x23` | VIDEO_ACK | C → H | `{ seq }`; the newest frame the client has put on screen |
| `0x30` | INPUT | C → H | one input event, below |
| `0x40` | CLIPBOARD | both | `{ text }`; at most 1 MiB |
| `0x50` | PING | both | `{ t }` |
| `0x51` | PONG | both | the PING payload, unchanged |
| `0x60` | ACTION | C → H | `{ action }`; one of the names in `OPENED.actions` |
| `0x61`–`0x7F` | reserved | | more of ARP |

`nonce`, `salt` and `proof` are base64. `Source` is `{ id, kind: "desktop" | "vm", name, state?, displays: [{ id, name, width, height, primary }] }`. Display ids are strings. A virtual machine has a `state`: `stopped`, `starting`, `running` or `stopping`.

## Handshake and authentication

```
C → H   HELLO      client nonce (32 random bytes)
H → C   CHALLENGE  host nonce (32 random bytes), salt, kdf parameters
C → H   AUTH       client proof
H → C   WELCOME    host proof, list of sources      (or ERROR auth_failed)
```

Both sides know an **access code**. It is normalised by upper-casing and removing spaces and dashes, then stretched:

```
key   = scrypt(normalise(code), salt, N = 32768, r = 8, p = 1, 32 bytes)
proof = HMAC-SHA256(key, "ardp1/" + role + clientNonce + hostNonce + fingerprint + binding)
```

`role` is `client` in AUTH and `host` in WELCOME. `fingerprint` is the hex fingerprint **of the certificate each side saw on this connection** (the host uses its own). That binds the proof to the certificate: a machine in the middle has to present a different one, so a proof it relays does not verify. `binding` is 32 bytes of TLS exported keying material (RFC 5705, label `EXPORTER-ardp-auth`, no context), which only the two ends of this one TLS session can compute, so even a relay holding a stolen copy of the host's key cannot pass a proof along.

- The host compares the client proof in constant time. On a mismatch it replies `ERROR auth_failed` and closes. After 5 failures from one address, that address is refused (`rate_limited`) for 30 seconds, doubling up to 10 minutes.
- The client must verify the host proof before trusting anything else on the connection. A host that accepts the client without proving the code is not the real host (`host_untrusted`).
- The client remembers the fingerprint per `host:port` after the first successful connection. If it differs later, the person is asked before the code proof is sent.
- A client must refuse scrypt parameters outside `32768 ≤ N ≤ 131072`, `r = 8`, `p = 1`: the host names them before it has proved anything.
- The host gives up on a connection that has not authenticated within 15 seconds, and on an authenticated one that has not sent OPEN within 120 seconds.
- The host accepts at most 16 connections, 4 from one address.
- Until a peer has proved itself it gets little room: a host reads messages of at most 4 KiB before authentication and 4 MiB after; a client reads at most 256 KiB before it has verified the host and 32 MiB after.

## Opening a source

After WELCOME the client sends one OPEN. `source` picks an entry from `sources` (the first if absent); `display` picks one of its displays (the primary if absent). `codecs` lists the families the client can decode, any of `h264`, `vp8`, `vp9`. `quality` is `low`, `balanced` or `high`.

The host answers OPENED, then VIDEO_CONFIG, then frames. `control` says whether the host will accept INPUT; it is false when the client asked for `viewOnly` and when the host only allows watching. A client that wants control later closes and opens again without `viewOnly`. A client looking at its own machine should start out not sending INPUT, since the pointer would chase its own picture.

A source serves one session at a time. A newer session takes over; the older one gets `CLOSE replaced`.

**Asking first.** A host may ask its user before letting a session open. It sends WAIT, then OPENED if the answer is yes or `ERROR denied` if it is no or nobody answers. A client should wait at least 90 seconds for OPENED. If the client hangs up meanwhile, the host withdraws the question. Only one question per address is open at a time (a second OPEN from the same address is denied at once), and a no counts as a failed attempt toward the lockout.

**Virtual machines.** Opening a virtual machine that is off switches it on. It can be controlled from the same machine too, since its input goes to the guest and not to the host's desktop.

**Actions.** `OPENED.actions` lists what the source can do besides showing a screen, and ACTION asks for one. A virtual machine offers `ctrl-alt-del`, `restart` and `shutdown`; a desktop offers none. The host ignores ACTION when `control` is false and for names it did not list.

## Video

`VIDEO_CONFIG.codec` is a WebCodecs codec string (for example `avc1.64002a`, `vp8`). H.264 is sent as Annex B with parameter sets in every key frame, so no `description` is needed. A new VIDEO_CONFIG may arrive at any time; the frame after it is a key frame.

`VIDEO_FRAME` payload:

| Bytes | Field | Notes |
| --- | --- | --- |
| 1 | flags | bit 0: key frame |
| 4 | seq | big endian, starts at 1, +1 per frame |
| 8 | timestamp | big endian, microseconds, strictly increasing |
| rest | data | one encoded access unit |

The client acknowledges frames with VIDEO_ACK as it presents them (acknowledging the newest is enough). A client that has to drop frames waits for the next key frame, sends VIDEO_KEY to get one sooner, and still acknowledges what it dropped.

**Flow control.** The transport is reliable, so a slow link shows up as frames in flight rather than loss. The host tracks `sent − acked`. When that exceeds about 0.2 s of frames, or its socket queue exceeds 0.25 s of video, it stops encoding new frames until the backlog drains and lowers the bitrate by 30 %. After 3 calm seconds the bitrate climbs 15 % at a time back to the ceiling set by `quality`.

## Input

Each INPUT message is one event:

| Event | Members |
| --- | --- |
| `{ t: "move", x, y }` | pointer position |
| `{ t: "button", b, down, x?, y? }` | `b`: 0 left, 1 middle, 2 right, 3 back, 4 forward |
| `{ t: "wheel", dx, dy, x?, y? }` | CSS pixels; positive `dy` scrolls down; ±10 000 at most |
| `{ t: "key", code, down }` | `code` is a W3C UI Events `KeyboardEvent.code` such as `KeyA` or `ShiftLeft` |
| `{ t: "release" }` | release every key and button this session holds |

`x` and `y` run from 0 to 1 across the remote display, left to right and top to bottom. Keys name the physical key; the host's keyboard layout decides the character. A repeated `down` is an auto-repeat. The host validates every event and drops what it does not recognise. When a session ends, the host releases whatever that session was holding.

## Liveness

Each side sends PING every 4 seconds and answers PING with PONG. A PING payload larger than 64 bytes is ignored. A side that receives nothing for 15 seconds closes the connection.

## Codes

Used in `ERROR.code` and `CLOSE.reason`.

Both ends must treat these as data from a stranger. A receiver accepts a code only if it matches `[a-z_]{1,32}` and otherwise reads it as `lost`; it must not use the code to index anything but its own table of known codes. `message` is optional help text: at most 300 characters are kept, control and direction characters are dropped, and a sender must not put its own paths, account names or addresses in it. For `internal` a host sends a fixed sentence.

| Code | Meaning |
| --- | --- |
| `auth_failed` | wrong access code |
| `rate_limited` | too many wrong codes from this address |
| `host_disabled` | the host has no access code set |
| `version` | protocol versions do not match |
| `bad_protocol` | a malformed or out-of-order message |
| `denied` | the host's user said no, or did not answer |
| `no_source` | the requested source does not exist |
| `capture_failed` | the source could not start or keep producing video |
| `display_changed` | the source's resolution changed; open it again |
| `replaced` | another session took over the source |
| `kicked` | the host's user ended the session |
| `host_stopped` | the host stopped accepting connections |
| `source_ended` | the source stopped, for example a virtual machine shut down |
| `closed` | the client hung up |
| `timeout`, `internal` | as named |
