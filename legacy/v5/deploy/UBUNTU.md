# Private Share — Ubuntu deployment (`share.rakzu.xyz`)

This is an improved security iteration, not an externally audited product. It keeps the frontend bound to `127.0.0.1:8187`, so it does not open a public host port. It does not use a file upload endpoint or store file bytes on the application server.

## 1. Preserve the existing installation

Back up the current project and environment before replacing any files:

```bash
sudo cp -a /opt/private-share /opt/private-share.backup-$(date +%Y%m%d-%H%M%S)
```

Copy this project into `/opt/private-share` (or test it from a separate directory first). Preserve your existing `.env` and set permissions:

```bash
cd /opt/private-share
cp .env.example .env   # only if there is no existing .env
chmod 600 .env
nano .env
```

Set `GOOGLE_CLIENT_ID` to the OAuth Web client ID and `APP_ORIGIN=https://share.rakzu.xyz`. Do not put a Google client secret or permanent TURN secret in this file. The Google client ID is public and is embedded into the browser build.

## 2. Configure Google OAuth

In Google Cloud Console → Google Auth Platform → Clients → your Web client:

- Authorized JavaScript origin: `https://share.rakzu.xyz`
- Remove `http://10.x.x.x` origins; private IP origins are not accepted by Google.
- Keep localhost origins only if you actively use local development.
- Add all intended test users while the OAuth app is in Testing mode.

The origin must match exactly, including scheme and hostname. Do not add a path or trailing slash.

## 3. Build and test locally

```bash
cd /opt/private-share
sudo docker compose config
sudo docker compose up -d --build
sudo docker compose ps
curl -I http://127.0.0.1:8187
sudo docker compose logs --tail=100 backend frontend
```

Expected local response: HTTP 200. Run a two-account test in separate browser profiles before global exposure. The application limits files to 256 MiB because the receiver currently buffers the file in memory; do not remove this limit until streaming receive and incremental hashing are implemented.

## 4. Publish `share.rakzu.xyz` with the existing Cloudflare Tunnel

Use the existing Cloudflare account and tunnel; do not replace or reconfigure other hostnames.

1. In Cloudflare Zero Trust → Networks → Tunnels, select the existing healthy tunnel.
2. Add a **Public Hostname** / published application route:
   - Subdomain: `share`
   - Domain: `rakzu.xyz`
   - Service type: HTTP
   - URL: `http://127.0.0.1:8187` if `cloudflared` runs directly on the Ubuntu host.
3. If `cloudflared` runs in a container, `127.0.0.1` means the tunnel container itself. Follow the existing tunnel deployment's host access pattern; do not assume host loopback is visible inside a container.
4. Cloudflare Tunnel supports WebSocket proxying, which this application needs for signalling. Do not expose backend port 8081 or PostgreSQL publicly.
5. Confirm `https://share.rakzu.xyz` loads and `/ws` connects before testing sign-in.

Cloudflare Tunnel publishes the web application; it is not a TURN relay. It does not make a coturn UDP listener reachable.

## 5. Global WebRTC / TURN

The current frontend always includes Google's public STUN service. `ICE_SERVERS_JSON` can add ICE server entries, but putting static long-lived TURN credentials in a Vite environment variable would expose them to every visitor. For production relay fallback, use a managed TURN provider with short-lived credentials or a separate public VPS running coturn. Add a backend endpoint that issues time-limited TURN credentials using a server-only shared secret before adding TURN to the public site. Do not put the coturn shared secret in the frontend, `.env` values passed as Vite build args, or browser code.

Without a working TURN relay, some restrictive networks will fail to connect. The app must fail closed; it must never upload or fall back to plaintext.

## 6. Security changes in this iteration

- Signalling backend checks transfer parties and state transitions: invite → recipient accept/reject → sender offer → recipient answer; ICE and cancel are restricted to those parties.
- Rejects oversized signalling payloads, limits each account to 120 signalling messages per minute, caps active transfers per account, and expires transfer state after 15 minutes.
- Login sessions expire after one hour, expired sessions are cleaned up, logout revokes a session, and active WebSockets check session validity.
- ECDH P-256 ephemeral public keys are signed with a persistent browser ECDSA identity key. The receiver verifies the signature and transfer/account binding.
- The sender signs a canonical manifest including transfer ID, sender, recipient, file size, file name, MIME type, chunk count and SHA-256 digest. The receiver verifies the signature, each AES-GCM chunk, size and digest before saving.
- File size is capped at 256 MiB to reduce browser memory exhaustion risk.

## 7. Trust limitation that cannot be solved by signatures alone

A public key sent through the same signalling server is not automatically bound to a real Google account. The app prompts both users to compare the peer's identity fingerprint through a separate trusted channel. Users must actually compare it (for example, over a voice call) and cancel if it differs. A malicious server can still substitute an unverified first-contact key if users skip out-of-band verification. A future production version should provide durable key pinning / key-change warnings and a formal threat-model review.

## 8. Operational checks

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 backend frontend
sudo ss -lntup
```

Confirm the frontend is bound only to `127.0.0.1:8187`, and backend port 8081 is only exposed on the internal Compose network. Keep logs free of file contents, keys and bearer tokens. Apply Cloudflare edge rate limiting to `/api/auth/google` and monitor abuse without recording sensitive payloads.

This code has not received an independent penetration test. Treat it as a hardened test build, not a guarantee of production security.


## Automated peer identity (TOFU)
The browser automatically pins a peer's first valid ECDSA identity key in IndexedDB and blocks subsequent key changes. This removes manual fingerprint prompts. It is trust-on-first-use, not a guarantee against a malicious signalling server during the very first contact. Site-data clearing or a new browser/device resets the local pin. Do not claim the system is foolproof or independently audited.
