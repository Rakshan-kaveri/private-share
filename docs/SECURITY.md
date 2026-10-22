# Threat model and known limitations

Protected against: unauthenticated WebSocket signalling, cross-session messages, client-supplied sender impersonation, modified file chunks, modified final file manifests, and a changed browser identity key after first use. These controls depend on correct token validation, uncompromised browsers, and the peer key already being correctly pinned.

Remaining risks: first-contact key substitution by a malicious signalling service; stolen bearer tokens until expiry or logout; in-memory sessions lost on backend restart; no session persistence across replicas; no file streaming beyond 256 MiB; no independent media E2EE on top of WebRTC DTLS-SRTP; metadata at the application and TURN servers; untested abuse controls and traffic exhaustion. A verified account-to-key directory or out-of-band fingerprint check is needed for stronger identity guarantees. Session revocation is checked on every signalling message, but already established WebRTC transport may persist until a peer closes it. Independent security review is still needed before high-trust use.

The original project does not include a Caddyfile in the ZIP. The live certificate, DNS, and browser warning cannot be fixed or verified from this source alone. See the HTTPS checklist.
