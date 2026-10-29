# Changelog

## 6.1
- **Send files without a call.** "Send files" opens a transfer screen. No microphone and no call screen, and no audio channels are created at all.
- **Screen sharing with sound.** Chrome and Edge on a computer share tab audio (and full system audio on Windows) when "Share audio" is ticked in the picker. The viewer hears it through a separate channel.
- **Viewer tools.** Rotate the shared screen 90° at a time, switch fit/fill, and go full screen. On Android, full screen also turns the phone to landscape.
- **Connection steps.** Every call shows each step (accepted → keys verified → route found → connected). If a call can't connect, the message names the cause: the other device never answered, a device can't reach the relay, no relay is set up, or WebRTC is blocked by a VPN or extension.
- **Fresh relay credentials for every call**, so a relay set up after someone signed in is used straight away.
- **Check relay** button in the lock menu.
- Redesigned sign-in page and mobile layout fixes.
- Security: invite rate limit, a cap of 200 files per session, `Cross-Origin-Resource-Policy` and related headers, and coturn blocked from reaching private networks and the cloud metadata server.
- `deploy/gcp-setup.sh`: one-shot setup on a Google Cloud VM. Its check for an old version holding the port now matches the host port correctly.

## 6.0
Rewritten from scratch. Voice calls, video calls and screen sharing added alongside file transfer.

| v5 | v6 |
|---|---|
| File transfer only | File transfer, voice call, video call and screen sharing |
| Spring Boot backend + React/Vite frontend + nginx (3 builds, `"latest"` npm versions) | One Node.js server with **zero npm dependencies**, plain-JS client, **no build step** |
| `Permissions-Policy` blocked the camera and microphone | Camera, microphone and screen capture allowed for this site only |
| Spring's default 8 KB WebSocket buffer (call descriptions are larger) | 64 KB messages and keep-alive pings (Cloudflare closes idle sockets after about 100 s) |
| Google client ID and ICE servers baked in at build time | Read at runtime from `.env` |
| A changed peer key blocked that person forever | A clear warning with "Trust and connect" or "End call" |
| Files held fully in memory and hashed in one go (256 MB cap) | Chunk-by-chunk hashing and Blob-backed receive, 1 GB per file |

A v5 `.env` works unchanged. New optional keys: `HOST_PORT`, `TURN_PORT`, `TURN_TLS_PORT`, `DEV_LOGIN`.

## 5 and earlier
File transfer with browser-side AES-256-GCM, ECDH key agreement and trust-on-first-use key pinning. The code is in [`legacy/v5`](legacy/v5).
