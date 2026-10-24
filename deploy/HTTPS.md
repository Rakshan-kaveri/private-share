# HTTPS diagnosis for share.rakzu.xyz

The supplied archive includes Nginx and Compose but no Caddyfile or live certificate. Its Compose frontend currently binds `127.0.0.1:8187:80`; older README text referenced 8187. Check the actual tunnel or reverse-proxy target. Nginx now permits camera, microphone and display capture for this origin. Do not disable certificate verification or browser protection.

Run from a public network:

```bash
getent ahosts share.rakzu.xyz
curl -Iv --max-time 15 https://share.rakzu.xyz/
openssl s_client -connect share.rakzu.xyz:443 -servername share.rakzu.xyz -showcerts </dev/null
curl -I http://share.rakzu.xyz/
```

Check subjectAltName includes `share.rakzu.xyz`, the leaf validity window, intermediate chain, redirects, and the certificate served by the actual Cloudflare/Caddy endpoint. In browser DevTools inspect the Security panel, failing requests, mixed content, WebSocket `wss://` handshake and `Permissions-Policy`. Review Caddy/tunnel routing and renewal logs on the VM. Verify the Google OAuth origin equals `APP_ORIGIN`. If using Caddy, proxy to `127.0.0.1:8187`, not the outdated port. The source uses relative API paths and derives `wss` on HTTPS.

A network attempt from this workspace timed out before receiving the public page, so no claim about the current certificate or browser warning is made. DNS, certificate, proxy, firewall, OAuth and TURN changes require access to your Google Cloud, DNS and reverse-proxy setup.
