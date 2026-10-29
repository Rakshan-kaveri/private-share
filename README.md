# Private Share

**Encrypted voice calls, video calls, screen sharing and file transfer between two browsers, on phone or PC.**
The server only signs people in and introduces the two devices; everything you say, show and send travels device to device.

![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A5%2020-c8a35b?style=flat-square)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-c8a35b?style=flat-square)
![End-to-end tests: 27 passing](https://img.shields.io/badge/e2e%20tests-27%20passing-c8a35b?style=flat-square)
![WebRTC](https://img.shields.io/badge/WebRTC-DTLS--SRTP-c8a35b?style=flat-square)

<img src="docs/screenshots/hero.png" alt="A shared screen watched on a laptop and on a phone, with the call header showing End-to-end encrypted and a safety code">

## Features

| | |
| --- | --- |
| **Voice and video calls** | Phone to laptop in any direction. Mute, camera on/off and front/back switch, and a voice call becomes a video call without redialling. |
| **Screen sharing with sound** | Share a tab, a window or the whole screen, including its audio in Chrome and Edge. Viewers on any device can rotate, fill or go full screen. |
| **File transfer** | Send files up to 1 GB each, with or without a call. Every file is encrypted, verified on arrival and only then offered for saving. |
| **End-to-end encryption** | Keys are created and kept in each browser. A 12-digit safety code lets two people confirm out loud that nobody is in the middle. |
| **No storage** | No database, no uploads and no message history. The server keeps sign-ins and online status in memory and nothing else. |

## Screenshots

> From a local test run with three browsers (two desktops, one phone). The camera feeds and the shared screen are generated test content. The sign-in page shows the local test sign-in; the live site shows "Continue with Google".

**Sign in and choose someone**

| Desktop | Phone |
| --- | --- |
| <img src="docs/screenshots/01-sign-in.png" width="560" alt="Sign-in page"> | <img src="docs/screenshots/01b-sign-in-phone.png" width="200" alt="Sign-in page on a phone"> |
| <img src="docs/screenshots/02-home.png" width="560" alt="People online, with voice, video, screen and file options"> | <img src="docs/screenshots/02b-contact-phone.png" width="200" alt="Contact options on a phone"> |

**Video call**, end-to-end encrypted, with a safety code both people can compare

<img src="docs/screenshots/03-incoming-call.png" width="49%" alt="Incoming video call"> <img src="docs/screenshots/05-video-call.png" width="49%" alt="Video call in progress">
<img src="docs/screenshots/06-safety-code.png" width="49%" alt="Safety code check">

**Screen sharing with sound.** The viewer can rotate, fill or go full screen.

<img src="docs/screenshots/07-screen-share-viewer.png" width="49%" alt="Viewer watching a shared screen"> <img src="docs/screenshots/07b-screen-share-sharer.png" width="49%" alt="Sharer's view during a screen share">

<img src="docs/screenshots/08-incoming-screen-phone.png" width="24%" alt="Screen share request on a phone"> <img src="docs/screenshots/09-screen-phone.png" width="24%" alt="Shared screen on a phone"> <img src="docs/screenshots/10-screen-phone-rotated.png" width="24%" alt="Shared screen rotated on a phone">

**Send files**, no call needed

<img src="docs/screenshots/11-incoming-files.png" width="49%" alt="Incoming files request"> <img src="docs/screenshots/12-file-transfer.png" width="49%" alt="Receiving files with progress and Save buttons">
<img src="docs/screenshots/12b-file-transfer-sender.png" width="49%" alt="Sender's view of a file transfer"> <img src="docs/screenshots/13-how-it-stays-private.png" width="49%" alt="The in-app explanation of how it stays private">

## How it works

```mermaid
flowchart LR
    A["Browser A<br/>keys + encryption"] -- "sign-in and signed setup<br/>(HTTPS / WSS)" --> CF["Cloudflare Tunnel"]
    B["Browser B<br/>keys + encryption"] -- "sign-in and signed setup<br/>(HTTPS / WSS)" --> CF
    CF --> S["Signalling server<br/>Node.js, stores nothing"]
    A <== "media and files, end-to-end encrypted" ==> B
    A -. "only if a direct route is blocked" .-> T["TURN relay<br/>forwards ciphertext"]
    T -.-> B
```

1. **Sign in.** Google confirms who you are. The server issues a short-lived session and lists who is online.
2. **Exchange keys.** Each call creates fresh ECDH P-256 keys. Every key and every connection description is signed by a device key that never leaves the browser, so the server can relay them but can't swap them.
3. **Connect.** WebRTC finds a direct route (or uses the TURN relay) and runs a DTLS handshake whose fingerprint must match the signed description.
4. **Talk, show, send.** Audio, video and screen travel over DTLS-SRTP. Files get a second layer: a per-file AES-256-GCM key, per-chunk authentication and a signed whole-file fingerprint.
5. **Hang up.** Cameras and microphones stop, the connection closes and its keys are discarded.

## Security

| Layer | Protection |
| --- | --- |
| Sign-in | Google ID token checked on the server: RS256 signature, audience, issuer, expiry and verified email. Sessions expire after 2 h idle or 24 h. |
| Device identity | ECDSA P-256 key per browser; the private key is non-extractable and stays in IndexedDB. |
| Key exchange | Fresh ECDH P-256 per call, then HKDF-SHA-256. Key bundles are signed by the device key. |
| Media | Every SDP, including its DTLS fingerprint, is signed and verified before use. Audio, video and screen use DTLS-SRTP. |
| Files | AES-256-GCM per file. Additional data binds each chunk to its call, file, index and count. A signed manifest covers a SHA-256 hash list; any failed check discards the file. |
| Trust | Keys are pinned on first contact, and a changed key raises a warning. The safety code closes the first-contact gap. |
| Server | Origin-checked WebSocket, per-call state machine, rate limits, size limits, strict CSP, read-only non-root container with all capabilities dropped. |
| Relay | Credentials derived with HMAC, expiring after 12 h. coturn is blocked from private networks and the cloud metadata address and capped at 4 Mbit/s per session. |

**Known limits.** The first call with someone trusts the key it sees until the safety code is compared. The client code comes from the same server, as in every browser-based end-to-end scheme. The server sees routing metadata (who is online, who calls whom). This project has **not** had an independent security audit. See [SECURITY.md](SECURITY.md) to report a problem.

## Quick start (local)

Needs Node.js 20 or newer. There are no packages to install.

```bash
git clone https://github.com/Rakshan-kaveri/private-share.git
cd private-share
DEV_LOGIN=true PORT=8099 node server.js
```

Open http://localhost:8099 in two windows (make the second a private window) and sign in with any name.
`DEV_LOGIN` turns on a name-only test sign-in. **Never enable it on a public server.**

## Deploy

```bash
cp .env.example .env && chmod 600 .env
nano .env                                          # GOOGLE_CLIENT_ID and APP_ORIGIN at minimum
sudo docker compose up -d --build                  # the app, on 127.0.0.1 only
sudo docker compose --profile turn up -d coturn    # optional TURN relay
```

- **HTTPS:** publish the app through Cloudflare Tunnel (or any reverse proxy that passes WebSockets). Cameras and microphones need HTTPS.
- **Google sign-in:** add your exact site origin under *Authorized JavaScript origins* for the OAuth web client.
- **TURN relay:** needed when one side is on mobile data behind carrier-grade NAT or on strict Wi-Fi. It needs a public IP and inbound UDP/TCP 3478 plus UDP 49160–49200. Cloudflare Tunnel can't carry it.
- **Google Cloud:** [`deploy/GOOGLE-CLOUD.md`](deploy/GOOGLE-CLOUD.md) and `bash deploy/gcp-setup.sh` set up the app and the relay on one VM. The script also prints the firewall commands.

In the app, the lock menu's **Check relay** button confirms the relay is reachable.

### Configuration

| Variable | Purpose | Example |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID (public) | `1234-abc.apps.googleusercontent.com` |
| `APP_ORIGIN` | Exact public origin; WebSocket connections must come from it | `https://share.example.com` |
| `HOST_PORT` | Loopback port the reverse proxy points at | `8188` |
| `TURN_HOST` | Relay hostname or public IP given to browsers | `turn.example.com` |
| `TURN_PUBLIC_IP` | `public/private` address pair for coturn behind 1:1 NAT | `203.0.113.5/10.0.0.2` |
| `TURN_SHARED_SECRET` | Shared by the app and coturn; generate with `openssl rand -hex 32` | — |
| `TURN_PORT`, `TURN_TLS_PORT` | Relay ports (`TURN_TLS_PORT=0` turns TLS off) | `3478`, `0` |
| `ICE_SERVERS_JSON` | Extra STUN/TURN servers | `[]` |
| `DEV_LOGIN` | Name-only test sign-in; keep `false` in production | `false` |

## Tests

[`tests/e2e.mjs`](tests/e2e.mjs) runs two real Chromium browsers (plus a phone-sized one) against the server and checks 27 things. They include: video and audio both ways, matching safety codes, camera toggling, screen sharing with sound, rotate and fill for viewers, a 24 MB file with an identical SHA-256 in both directions, declines, voice-to-video upgrade, file-only sessions with no audio, HTML in display names rendered as text, and the key-change warning.

```bash
npm install && npx playwright install chromium     # test tools only
DEV_LOGIN=true PORT=8099 node server.js &
npm test
```

## Project layout

```
server.js               HTTP, Google sign-in check, TURN credentials, WebSocket signalling (no dependencies)
public/index.html       page shell and icons
public/css/app.css      matte black and gold theme, phone layout
public/js/crypto.js     identity keys, signatures, ECDH/HKDF, AES-GCM, key pinning, safety code
public/js/call.js       session engine: media, negotiation, diagnosis, encrypted file transfer
public/js/signal.js     WebSocket client with reconnect and keep-alive
public/js/app.js        interface and viewer tools
tests/e2e.mjs           end-to-end browser tests
compose.yaml            hardened app container + optional coturn relay
deploy/                 Google Cloud guide and setup script
docs/screenshots/       images used in this README
legacy/v5/              the previous Spring Boot + React version, kept for reference
```

See [CHANGELOG.md](CHANGELOG.md) for what changed between versions.
