# V4: Global deployment and TURN setup

## Architecture
- Publish the web app and `/ws` signalling via HTTPS/WSS through Cloudflare Tunnel to the local frontend.
- Run coturn on a separate public VPS (recommended if the home ISP uses CGNAT), or a host with a real public IP. Do not point the TURN hostname at a Cloudflare-proxied orange-cloud record.
- TURN packets are still encrypted by the browser's WebRTC DTLS-SRTP/data-channel transport; application file chunks are additionally encrypted with AES-GCM.

## Configure app server
1. Copy `.env.example` to `.env` and set Google client ID, `APP_ORIGIN=https://share.rakzu.xyz`, `TURN_HOST=turn.share.rakzu.xyz`, and a long random `TURN_SHARED_SECRET`.
2. Keep `.env` readable only by administrators (`chmod 600 .env`).
3. Deploy with `sudo docker compose up -d --build`. This starts the app but not the host-network coturn profile.

## Configure TURN host
Use coturn 4.6.3 or later on a public host. Open inbound UDP/TCP 3478 and UDP 49160-49200. Configure long-term credential mechanism plus shared-secret REST authentication, realm `share.rakzu.xyz`, the same secret as `TURN_SHARED_SECRET`, and the public IP. The provided Compose `coturn` profile runs coturn on the same machine as the app and is appropriate only if that machine itself has the public network reachability described above. If coturn is on a separate VPS, run coturn there and set `TURN_HOST` on the app server to its DNS name; configure the same secret on both.

## Validation
- Login and inspect `/api/ice-config` in browser devtools: response must include STUN and TURN entries; credentials expire in 10 minutes. Do not share the response publicly.
- Use `chrome://webrtc-internals` during a transfer. If a candidate pair with candidate type `relay` is selected, TURN relay is in use.
- Test with sender and receiver on different networks, including a mobile hotspot and restrictive NAT.
- Confirm transfer still works with TURN blocked (direct path) and with direct UDP blocked (relay fallback where supported).

## Identity limitation
Automated TOFU pinning blocks a key change after first use, but first contact is not protected from a malicious signalling service. Do not advertise this build as production-secure. Implement a server-enforced account-to-key registry and audited key rotation/recovery before making stronger claims.
