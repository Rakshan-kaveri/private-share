# Security and logic review — 24 October 2026

This is a source review, not a penetration test or a certification. The updated frontend production build succeeded and `npm audit --omit=dev --audit-level=high` reported zero known production dependency advisories in this environment. Maven, Docker, two-device browser tests, and the live deployment were not available here. The backend changes are therefore **not claimed as compiled or deployed**.

## Corrected in this revision

- File signalling now ignores offers, answers, ICE and acceptance messages from a different transfer ID or peer. Invalid exchanges close the active transfer.
- File MIME metadata must match both the invitation and signed manifest. Binary chunks require prior metadata and a minimum authenticated packet length.
- Failed incoming verification rejects the invitation and closes its peer connection. A new transfer closes a prior completed connection; active transfers can be cancelled.
- Server signalling transitions for a session are synchronized, duplicate IDs are rejected atomically, and browser-session replacement cancels the earlier sessions. Outbound WebSocket writes are serialized per socket.
- Anonymous WebSockets are closed after ten seconds without authentication. Expired or revoked sessions are checked on each message and closed by a periodic server task; peers receive cancellation on disconnect.
- Active connected sessions are retained up to the one-hour application session expiry instead of disappearing after fifteen minutes.
- Fresh short-lived TURN credentials are requested for each new call or transfer. The Content Security Policy restricts outbound connections to the application and Google Identity Services instead of any HTTPS/WSS destination.
- Media invitations are signature-checked before display, while a new peer key is pinned only when the recipient accepts. First-use identity language in the UI is explicit about its limitation.

## Remaining security and reliability limits

- **First-contact identity:** trust on first use (TOFU) is browser-local. A compromised signalling service can substitute the first identity key, and clearing site data loses pins. There is no independently verified, durable account-to-key directory or recovery protocol. The same browser-local signing identity may be used when different Google accounts sign in on that browser. Verify safety fingerprints out of band for high-trust use.
- **Media:** WebRTC DTLS-SRTP encrypts transport, but no independent SFrame/insertable-stream E2EE exists. A malicious or compromised endpoint can record media. TURN and the service can observe metadata. Simultaneous screen renegotiation by both parties can collide; the app does not implement the full WebRTC perfect-negotiation pattern. Test that case before production use.
- **Sessions:** bearer tokens are held in browser memory and server memory for one hour. Backend restart signs users out. A compromised authenticated browser can act until revocation or expiry. No cross-instance session store, durable identity directory, or independent abuse assessment is included.
- **Connectivity:** audio capture, tab/system audio, device selection, network recovery, and TURN fallback vary by browser and network. The live certificate, DNS, Google OAuth configuration and TURN reachability were not verified from source.
- **File size:** receipt contents are buffered in memory up to 256 MiB; large files can exhaust a device. The sender does not receive a cryptographically authenticated receipt proving that the receiver saved the file. A “sent” state is not a recipient verification claim.

## Before public deployment

Run `mvn test`, `mvn package`, `docker compose config`, and the two-account browser checklist in `deploy/ACCEPTANCE.md`. Verify the CSP with the real Google sign-in button and inspect console errors. Test malformed signalling, corrupt file chunks, changed identity keys, account replacement, expiry, a call longer than fifteen minutes, simultaneous sharing, and TURN across separate networks. Arrange an independent application security review before making strong security claims.
