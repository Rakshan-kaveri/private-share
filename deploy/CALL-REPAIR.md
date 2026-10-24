# Voice/video and cross-device screen diagnosis (24 October 2026)

## Evidence and change

The inspected frontend source is the Share source supplied in the earlier archive and updated in this workspace. The named GitHub repository was not accessible here, so compare its current commit before applying the patch. The public site's HTML title is Share and its headers show Caddy. The public page response did not include Cross-Origin-Opener-Policy or Cross-Origin-Embedder-Policy. The host-level Caddyfile, authenticated `/api/ice-config` response, call logs, and two real peer sessions were unavailable.

In `frontend/src/MediaPanel.jsx`, `accept()` captured microphone/camera and called `addTrack()` **before** receiving the caller's SDP offer. `handle('offer')` then applied the offer and created an answer. A screen-only receiver did not add local tracks. This asymmetric negotiation is a likely explanation for screen reception working while bidirectional voice/video fails: the answerer's tracks can be on transceivers not associated with the offered media sections. `applyOfferAndAttach()` now applies the offer first and then attaches answerer tracks before `createAnswer()`. The caller's path and file transfer were not rewritten. A focused test verifies the order, screen-only answer, and rollback on an offer collision.

The recipient's video/audio playback remains on a single peer connection. An explicit Play call audio control appears if browser autoplay rejects remote audio. Diagnostics show only state, candidate counts, and elapsed timing; candidate IP addresses, SDP, OAuth tokens, and media are not logged.

Simultaneous media offers are serialized by the signalling server. The peer whose offer is rejected waits for the accepted offer and rolls back its local offer before applying it. This behavior needs a two-browser regression test; it is not a complete independently validated perfect-negotiation implementation.

## Mobile screen sharing

A phone **receiving** a PC screen does not need `getDisplayMedia`; it needs working WebRTC connectivity and video playback. A phone **sending** its screen requires `navigator.mediaDevices.getDisplayMedia()` in that particular browser. Share checks that API and disables Start screen share with a clear explanation when absent. The browser's native picker still determines which surfaces and optional audio are available. No website code can make an unsupported mobile browser capture its entire screen.

## TURN and COOP

`backend/src/main/java/com/privateshare/auth/IceConfigController.java` issues short-lived TURN credentials after bearer authentication when `TURN_HOST` and `TURN_SHARED_SECRET` are set. The frontend refreshes ICE configuration for each new session. The supplied `compose.yaml` offers coturn on UDP/TCP 3478 with a configured public IP and relay range; its profile is optional and disables TURN TLS. Do not infer relay availability from these settings alone. This workspace could not obtain an authenticated ICE response or verify UDP relay candidates from two networks. A DNS lookup for the example `turn.share.rakzu.xyz` did not resolve in this environment, which is inconclusive for your production network. If NAT blocks direct connectivity, configure and verify TURN with authenticated relay candidates. TLS relay requires additional infrastructure/certificates and is not enabled by this patch.

The observed public homepage response had no COOP or COEP header. The Google Identity Services popup/iframe can report a cross-origin `postMessage` warning; the code path for WebRTC offers/answers uses WebSocket and does not use `postMessage`. Without a failed OAuth flow or a specific conflicting response header, the warning is not evidence of the call failure. No COOP/Caddy header was changed.

## Tests performed here

- `cd frontend && npm test`: 3 focused negotiation tests passed.
- `cd frontend && npm run build`: production Vite build passed.
- Public `GET /` returned the Share page; public `HEAD /` showed Caddy and the listed CSP/Permissions-Policy, no COOP/COEP. Unauthenticated `HEAD /api/ice-config` returned 401 as expected.
- No browser executable, Maven, Docker, production credentials, physical phone, or two signed-in peers were available here. The backend patch and real call scenarios are **unverified**.

## Manual acceptance and diagnosis

Use two different Google accounts on separate PCs. Confirm both appear online. On PC A start Voice; on B accept. Both should show a connected peer and ICE state, and both should hear audio (press Play call audio if offered). Repeat Video and Screen. Check the collapsed Connection details on both sides: local/remote candidate counts, ICE connection state, and stage. In `chrome://webrtc-internals` check selected candidate pair type without sharing raw candidate addresses. If ICE remains checking/failed, verify actual TURN DNS, UDP/TCP firewall, credentials and relay candidates. If ICE connects but one side is silent, inspect track directions in `getTransceivers()` and browser autoplay/device permissions. Do not log SDP or tokens to general production logs.

Next, have a PC share to a phone and verify the phone receives video. Separately test starting capture from the phone only when its browser exposes `getDisplayMedia`. Test accept/reject, denied mic/camera, missing devices, hang-up, network drop, simultaneous share actions, and a file-transfer regression. Record actual browser versions and direction of capture. These cases are not reported as passed here.

## Safe deployment and rollback

Work in a clean checkout of the **actual GitHub repository** and compare this source patch against its current commit first. Preserve the private `.env`, existing volumes, Caddy config, TURN secrets, and known-good images. Do not use `docker compose down -v`.

```bash
cd /path/to/private-share
sudo docker compose config
BACKEND_CID=$(sudo docker compose ps -q backend)
FRONTEND_CID=$(sudo docker compose ps -q frontend)
BACKEND_IMAGE=$(sudo docker inspect -f '{{.Image}}' "$BACKEND_CID")
FRONTEND_IMAGE=$(sudo docker inspect -f '{{.Image}}' "$FRONTEND_CID")
BACKEND_TAG=$(sudo docker inspect -f '{{.Config.Image}}' "$BACKEND_CID")
FRONTEND_TAG=$(sudo docker inspect -f '{{.Config.Image}}' "$FRONTEND_CID")
sudo docker image tag "$BACKEND_IMAGE" share-backend:rollback-20261024
sudo docker image tag "$FRONTEND_IMAGE" share-frontend:rollback-20261024
# Preserve BACKEND_TAG and FRONTEND_TAG securely for rollback.
sudo docker compose build backend frontend
sudo docker compose up -d --no-build --no-deps backend frontend
sudo docker compose ps
curl -I https://share.rakzu.xyz/
```

If validation fails, tag the saved images back to the recorded service tags and recreate only the two services:

```bash
sudo docker image tag share-backend:rollback-20261024 "$BACKEND_TAG"
sudo docker image tag share-frontend:rollback-20261024 "$FRONTEND_TAG"
sudo docker compose up -d --no-build --no-deps --force-recreate backend frontend
```

The variables above must remain in the same shell for immediate rollback; record their values in your deployment notes for later rollback. Confirm the actual Caddy upstream and port before deployment. This patch does not change them.
