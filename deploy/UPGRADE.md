# Upgrade the existing VM to Share

Keep the existing private `.env` on the VM. Do not upload it into the project ZIP, publish it, or replace it with `.env.example`. Copy the new `Share/` source into the application directory and keep the domain `share.rakzu.xyz`.

```bash
cd /path/to/Share
# Confirm GOOGLE_CLIENT_ID, APP_ORIGIN=https://share.rakzu.xyz, and TURN settings exist in your private .env.
sudo docker compose config
sudo docker compose up -d --build --force-recreate backend frontend
sudo docker compose ps
curl -I http://127.0.0.1:8187/
curl -I https://share.rakzu.xyz/
```

Ensure Caddy or Cloudflare Tunnel routes the public domain to `http://127.0.0.1:8187`. A previous Compose file bound 8188 while deployment documentation said 8187. If the tunnel still points at an older service, the browser will show old code. Open browser DevTools, disable cache once, reload, and check the page title says **Share**. Verify the WebSocket handshake to `wss://share.rakzu.xyz/ws` returns HTTP 101 after sign-in. In the Network tab inspect `/api/auth/google` and `/api/ice-config`; verify there are no failed requests or certificate warnings. If Google sign-in does not appear, confirm the Google OAuth JavaScript origin is exactly `https://share.rakzu.xyz`.

Test with **two different Google accounts in separate browsers or devices**. The server keeps one active WebSocket per account, so two tabs using the same account replace one another. Both people must appear online before a call or transfer can start. Grant the browser microphone, camera, or screen permission when requested. For different networks, configure a reachable TURN service and its firewall ports; STUN alone does not guarantee a connection. The app now reports offline signalling, unavailable recipients, and call timeouts instead of silently waiting.

This archive cannot update your VM automatically. Run the commands there, then perform the two-account checklist in `deploy/ACCEPTANCE.md`.
