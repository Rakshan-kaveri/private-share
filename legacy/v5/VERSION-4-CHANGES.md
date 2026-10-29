# Private Share V4 — global connectivity groundwork

## Included
- Premium black/champagne UI retained from V3.
- Authenticated `/api/ice-config` endpoint issues 10-minute coturn REST credentials derived with HMAC-SHA1. The shared TURN secret stays on the server; it is not compiled into frontend assets.
- Frontend fetches ICE config after Google sign-in and uses STUN plus TURN when configured. It reports when TURN credentials are not configured.
- Coturn service profile included in Compose.
- The frontend still uses local trust-on-first-use (TOFU) identity pinning. This is automated, but does **not** authenticate the first contact against a malicious signalling server. It is not a production identity assurance solution.

## Critical deployment constraint
Cloudflare Tunnel exposes HTTP/HTTPS and WebSocket traffic; it does not expose arbitrary TURN UDP relay ports. Coturn needs its own publicly reachable host/IP. A home server behind CGNAT/private-only networking cannot offer reliable global TURN simply by adding this container. Use a public VPS or a real public IP with firewall/security-group access.

## Configure TURN
1. Create a DNS record `turn.share.rakzu.xyz` pointing directly to the public IP of the TURN host (DNS-only; not proxied through Cloudflare).
2. Ensure inbound UDP and TCP 3478 and UDP 49160-49200 are allowed by host firewall and provider firewall.
3. Copy `.env.example` to `.env`; set `TURN_HOST`, `TURN_REALM`, `TURN_PUBLIC_IP`, and generate `TURN_SHARED_SECRET` using `openssl rand -hex 32`. Use the same secret for backend and coturn. Never commit or publish `.env`.
4. Start app: `sudo docker compose up -d --build`. Start TURN profile: `sudo docker compose --profile turn up -d coturn`.
5. Verify `sudo docker compose ps -a`, `sudo docker compose logs --tail=100 coturn`, and test from a network outside your LAN. A TURN candidate should appear in WebRTC diagnostics when relay is selected.
6. Set Google OAuth authorized JavaScript origin to `https://share.rakzu.xyz`. `APP_ORIGIN` must match the origin used by the browser.

## Do not call it production-secure yet
- This package has not been independently penetration-tested or audited.
- Current identity protection is TOFU stored in IndexedDB. First-contact impersonation and browser-storage loss remain concerns. For stronger account identity, implement server-side account-to-public-key registration with authenticated key rotation/recovery and independent security review.
- Sessions are in-memory and expire after one hour; multiple backend replicas/restarts log users out.
- TURN is a relay for encrypted WebRTC packets; it does not itself provide end-to-end encryption.
- Validate OAuth, HTTPS/WSS, abuse/rate limits, resource limits, transfer cancellation, file integrity and two-device cross-network behavior before production.
