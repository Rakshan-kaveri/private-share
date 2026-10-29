# Private Share v6

Encrypted **voice calls, video calls, screen sharing and file transfer** between two browsers, on phone or PC.
The server only signs people in and passes connection messages between them. Audio, video, screens and
files go device to device over WebRTC and never touch the server.

## What changed from v5

| v5 | v6 |
|---|---|
| File transfer only | File transfer **+ voice call + video call + screen sharing** |
| Spring Boot backend + React/Vite frontend + nginx (3 builds, `"latest"` npm versions) | One Node.js server with **zero npm dependencies**, plain-JS frontend, **no build step** |
| `Permissions-Policy` blocked camera and microphone | Camera, microphone and screen capture allowed for this site only |
| Spring's default 8 KB WebSocket buffer (call descriptions are larger) | 64 KB messages, keep-alive pings (Cloudflare closes idle sockets after ~100 s) |
| Google client ID and ICE servers baked in at build time | Read at runtime from `.env`, so a restart applies changes |
| A changed peer key blocked that person forever | Clear warning with "Trust and connect" / "End call" |
| Files held fully in memory and hashed in one go (256 MB cap) | Chunk-by-chunk hashing, Blob-backed receive, 1 GB per file |

Your `.env` from v5 works unchanged. New optional keys: `HOST_PORT`, `TURN_PORT`, `TURN_TLS_PORT`, `DEV_LOGIN`.

## Run it

```bash
cp .env.example .env      # skip if you are keeping your existing .env
chmod 600 .env
nano .env                 # GOOGLE_CLIENT_ID and APP_ORIGIN at minimum
sudo docker compose up -d --build
curl -s http://127.0.0.1:8188/api/health     # {"ok":true}
```

Point the Cloudflare Tunnel public hostname `share.rakzu.xyz` at `http://127.0.0.1:8188` (HTTP service).
WebSockets pass through Cloudflare Tunnel without extra settings.

Google Cloud → APIs & Services → Credentials → your Web client → **Authorized JavaScript origins**:
`https://share.rakzu.xyz` (exactly, no trailing slash). While the OAuth app is in Testing mode, add each person as a test user.

Without Docker: `node server.js` (Node 20 or newer). It reads the same variables from the environment.

### Try it on your LAN without Google

```bash
DEV_LOGIN=true PORT=8099 node server.js
```

Open `http://localhost:8099` in two browser windows (use a private window for the second) and sign in with any name.
Phones on the LAN need HTTPS for the camera and microphone, so use the tunnel for phone testing.
**Never set `DEV_LOGIN=true` on the public site.** Anyone could sign in with any name.

## TURN: needed for many phone calls

**On Google Cloud:** follow `deploy/GOOGLE-CLOUD.md` and run `bash deploy/gcp-setup.sh`. It configures everything except the firewall rule, and prints the exact command for that.

WebRTC first tries a direct path. That fails when one side is behind carrier-grade NAT (common on Jio/Airtel/Vi
mobile data) or strict office/college Wi-Fi. The call then shows *"Couldn't connect… needs a TURN relay"*.
A TURN relay fixes this. It forwards packets that stay encrypted end to end, so it can't see the call or the files.

Cloudflare Tunnel **cannot** carry TURN. You need a machine with a public IP (a small VPS is enough):

1. DNS `turn.share.rakzu.xyz` → the VPS public IP, **DNS only** (grey cloud, not proxied).
2. Open inbound UDP+TCP **3478** and UDP **49160–49200**.
3. In `.env`: `TURN_HOST`, `TURN_REALM`, `TURN_PUBLIC_IP` and `TURN_SHARED_SECRET` (`openssl rand -hex 32`).
4. On the TURN host: `sudo docker compose --profile turn up -d coturn` (or install coturn with the same flags).
5. Restart the app. Click the lock icon → **Check relay** to confirm. In a call, the header shows **Relayed (still encrypted)** when TURN is in use.

The app issues TURN usernames and passwords that expire after 12 hours, derived from the shared secret.
The secret itself never reaches the browser.

## How the four features work

All four run over **one** WebRTC connection per call. The camera, screen and files can be switched on and off
mid-call without redialling. A voice call becomes a video call when either person taps *Camera*.

- **Voice / video:** Opus audio with echo cancellation, camera up to 720p, a front/back switch on phones, mute,
  and live state sync (the other side sees when you mute or turn the camera off).
- **Screen sharing:** start it from the list or during a call. The viewer gets your screen full-stage with your camera in the corner,
  plus a full-screen button. Any device can **watch** a shared screen. Most phone browsers (iOS Safari, Chrome on Android)
  **can't share** their own screen; the button is hidden there.
- **Files:** pick or drag-and-drop several files, in both directions, during any call or via *Send files*.
  The receiver accepts or declines each one, and gets progress, speed and a *Save* button. Image files show a preview.

## Security model

| Layer | What protects it |
|---|---|
| Sign-in | Google ID token checked on the server (RS256 signature against Google's keys, audience, issuer, expiry, verified email). Login tokens expire after 2 h idle or 24 h total. |
| Device identity | ECDSA P-256 key per browser, private key non-extractable in IndexedDB. |
| Key exchange | Fresh ECDH P-256 keys per call → HKDF-SHA-256. The key bundle is signed by the device key. |
| Media path | Every SDP (which carries the DTLS fingerprint) is **signed** and checked before use, so the signalling server can't put itself in the middle. Audio/video: DTLS-SRTP. |
| Files | Extra AES-256-GCM layer: one key per file, per-chunk authentication (AAD binds call, file, index, count), a signed manifest over a SHA-256 hash list. Anything that fails a check is discarded. |
| Trust | Keys are pinned on first contact (TOFU). The **safety code** in the call header lets two people confirm out loud that nobody is in the middle, and *It matches* marks the contact as verified. |
| Server | Origin-checked WebSocket, per-call state machine (only the two parties, in the right order), rate limits, size limits, CSP, `frame-ancestors 'none'`, read-only container, all capabilities dropped. |

Honest limits: the first call with someone trusts the key it sees until you compare the safety code. Clearing
site data creates a new device key, and the other person gets a warning. Received files stay in the tab until saved.
This has not had an independent security audit. Don't advertise it as audited.

## Tests

`tests/e2e.mjs` drives two real Chromium browsers (fake camera and microphone) through the server and checks 23 things:
video both ways, live audio, matching safety codes, camera off/on, screen share in and out, a 24 MB file with
identical SHA-256, reverse transfer, decline, voice call, mute, voice→video upgrade, declined call, multi-file
*Send files*, received files after hang-up, a phone-sized screen viewer, and the key-change warning.

```bash
npm install            # installs Playwright (test only; the app itself needs nothing)
npx playwright install chromium
DEV_LOGIN=true PORT=8099 node server.js &
npm test
```

## Files

```
server.js            HTTP, Google sign-in, TURN credentials, WebSocket signalling (no dependencies)
public/index.html    page shell and icons
public/css/app.css   matte black and gold theme, phone layout
public/js/crypto.js  identity keys, signatures, ECDH/HKDF, AES-GCM, safety code
public/js/signal.js  WebSocket client with reconnect
public/js/call.js    the call engine: media, renegotiation, encrypted file transfer
public/js/app.js     interface
tests/e2e.mjs        two-browser end-to-end test
compose.yaml         app (127.0.0.1:8188) + optional coturn profile
deploy/gcp-setup.sh  one-shot setup on a Google Cloud VM (app + TURN)
deploy/GOOGLE-CLOUD.md  step-by-step for Google Cloud, firewall, static IP, troubleshooting
```
