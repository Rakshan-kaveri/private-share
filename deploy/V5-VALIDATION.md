# V5 deployment and acceptance checklist

## Build first
From the project root:

```bash
sudo docker compose config
sudo docker compose build --no-cache
sudo docker compose up -d
sudo docker compose ps -a
sudo docker compose logs --tail=150 frontend backend
curl -I http://127.0.0.1:8187
```

Do not proceed if the build fails, either container exits, Google sign-in fails, or the local curl does not return an HTTP response. Keep the existing deployment and `.env` backup until the new one passes.

## Configure global access
- Set the Google OAuth JavaScript origin to the exact public HTTPS origin, e.g. `https://share.rakzu.xyz`.
- Set `APP_ORIGIN` to the same public origin.
- Use HTTPS/WSS and verify WebSocket signalling in browser developer tools.
- Keep frontend/backend ports private; expose only the reverse proxy's 80/443 and the necessary TURN ports.
- TURN needs a public-reachable address, matching shared secret, public DNS, UDP/TCP 3478, and the configured UDP relay range. Do not put TURN behind an ordinary HTTP proxy.

## Functional tests
1. Test Google login with two distinct accounts on separate browser profiles.
2. Test small text, image, video, and binary files; compare received file hash with the source hash.
3. Test cancel/reject, duplicate or unexpected messages, reconnects, offline recipients, and large files within the configured limit.
4. Test direct P2P and inspect `chrome://webrtc-internals` to confirm the selected candidate pair.
5. Force relay-only ICE in a test environment and confirm the selected candidate type is `relay` and a file arrives with matching hash.
6. Verify the app does not send file contents to any HTTP API and review signalling logs/metadata handling.
7. Verify identity key changes are blocked and test what happens after browser storage is cleared. Remember TOFU does not authenticate first contact.
8. Check phone-sized layout, keyboard focus, modal close behavior, and reduced-motion preference.

## Production release gate
Do not call the app production-secure based on a successful build or a successful transfer alone. Complete a code review/security audit, fix account-to-key binding and key recovery/rotation, validate signalling authorization, add abuse/resource controls, review dependency versions, and document incident/revocation handling.
