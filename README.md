# Share

Share is a browser based workspace for encrypted file transfer, voice and video calls, and screen sharing. It evolves the supplied Private Share V5 project. The tabs are **Files**, **Screen**, **Voice**, **Video**, and **How it works**. The existing React/Vite, Spring Boot, WebSocket, WebRTC, Docker Compose, and Google sign-in structure is retained.

## What is implemented

- File transfer: existing AES-256-GCM chunk encryption, signed ECDH exchange, signed SHA-256 manifest, local first-use identity pinning, and WebRTC data channel. Limit: 256 MiB, buffered by the receiver in memory.
- Calls: explicit invitation and acceptance; microphone/camera capture, mute and camera toggles, elapsed time, device selectors (selection applies to the next call), network state, and hangup.
- Screen: native browser picker through `getDisplayMedia`, optional captured audio if available, preview, remote playback, native stop detection, and screen sharing added to an active voice or video call using the same peer connection with renegotiation.
- Signalling: authenticated WebSocket messages are bound to server-side session participants and session state. Offer and answer SDP is signed by the locally pinned identity key. Media uses WebRTC DTLS-SRTP. The application server does not handle media or file bytes.

## Build and run

Copy `.env.example` to `.env`, set `GOOGLE_CLIENT_ID`, `APP_ORIGIN`, and optional TURN settings. Keep `.env` private.

```bash
cd frontend && npm ci && npm run build
cd ../backend && mvn test && mvn package
cd .. && docker compose config && docker compose up -d --build
curl -I http://127.0.0.1:8187
```

The Compose frontend port is bound to loopback. Put a TLS reverse proxy or the existing tunnel in front of it. `APP_ORIGIN` must exactly equal the browser origin and be registered as the Google OAuth JavaScript origin. Enable the optional `turn` profile only after configuring a publicly reachable TURN server and opening its relay ports; see `deploy/V4-GLOBAL-TURN.md`.

## Current verification and limitations

The frontend production build passed here. This workspace has no Maven or Docker executable, so backend tests/compilation and Compose validation were not run. Two-device browser verification, OAuth, transfer integrity, camera and screen permissions, TURN fallback, and production deployment remain to be tested. See `deploy/ACCEPTANCE.md` for exact manual cases.

Identity pinning is trust on first use (TOFU). It detects a changed key after first contact, but a malicious signalling service could substitute a key on first contact. Browser storage reset loses pins. No independent security audit or penetration test has been performed. WebRTC encrypts transport; there is no independent insertable-stream media E2EE. Google tokens and signalling metadata are handled by the server. Do not claim the platform is fully audited or immune to first-contact impersonation.

See `docs/SECURITY-REVIEW.md` for corrected issues, untested paths and residual risks. See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/BROWSER-COMPATIBILITY.md`, `deploy/HTTPS.md`, and `CHANGELOG.md`.
