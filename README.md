# Private Share

Responsive browser-based file sharing using Google sign-in, browser-side AES-256-GCM encryption, ECDH P-256 key agreement, ECDSA-signed transfer keys and a signed SHA-256 file manifest. The application server coordinates signalling and does not provide file upload/download endpoints. The UI uses a premium black-and-champagne visual theme. Peer keys are automatically pinned locally on first use; changed keys are blocked. WebRTC prefers direct peer-to-peer transport.

## Important deployment facts

- Intended public hostname: `https://share.rakzu.xyz`.
- Ubuntu host port: `127.0.0.1:8187` only. Publish through the existing Cloudflare Tunnel; do not open port 8187 to the Internet.
- `APP_ORIGIN` must be the exact browser origin and must match the Google OAuth JavaScript origin.
- `ICE_SERVERS_JSON` is for public ICE server configuration only. Never expose a permanent TURN secret in the frontend bundle. A separate TURN provider/VPS with short-lived credentials is required for reliable global connectivity through restrictive networks.
- Current maximum file size: 256 MiB; receive-side data is buffered in memory.
- Peer identity prompts have been replaced with local trust-on-first-use (TOFU): the first valid peer signing key is pinned in this browser, and later key changes fail closed. This automates normal use and helps detect identity-key changes, but first contact is not independently authenticated against a malicious signalling server. For high-assurance first-contact verification, use an authenticated account-to-key directory or out-of-band verification. Clearing browser site data or using another browser/device resets local trust.

## Run

```bash
cp .env.example .env
chmod 600 .env
# Set GOOGLE_CLIENT_ID and APP_ORIGIN in .env
sudo docker compose config
sudo docker compose up -d --build
curl -I http://127.0.0.1:8187
```

Detailed deployment steps are in `deploy/UBUNTU.md`. This project has not undergone an independent security audit or penetration test; do not describe it as foolproof or audited.


## V4 global connectivity
See `VERSION-4-CHANGES.md` and `deploy/V4-GLOBAL-TURN.md`. TURN needs a separate public IP/host; Cloudflare Tunnel alone is not TURN. Identity pinning remains TOFU and has not been independently audited.


## V5 update
V5 adds a responsive Security tab explaining the transfer flow, CIA (confidentiality, integrity, availability), server metadata, no-file-storage design, and TURN trade-offs. Read `VERSION-5-CHANGES.md` and `deploy/V5-VALIDATION.md` before deployment. The code is not independently audited; build and run the acceptance checklist before public use.
