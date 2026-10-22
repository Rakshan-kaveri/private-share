# Private Share V5 — UI and security transparency update

## Included
- Responsive classic-black/champagne UI based on the V4 app.
- New **Security** tab/button available before and after sign-in.
- Step-by-step explanation of sign-in, ECDH/HKDF key derivation, AES-256-GCM encryption, WebRTC direct transport, TURN relay fallback, and receiver verification.
- CIA triad explainer that describes availability limitations honestly.
- Explicit description of metadata processing, no intentional application-side file storage, and relay bandwidth trade-offs.
- Reduced-motion CSS support and mobile-specific layout for the security panel.

## Security scope and limitations — read before public deployment
This is a student/project implementation, not a security-audited production product. V5 inherits V4's implementation. The security tab is explanatory documentation, not proof of correctness.

- **Confidentiality:** browser-side AES-256-GCM and WebRTC encryption are intended to protect file contents in transit. Do not claim the server can never access any data without validating all code and runtime paths.
- **Integrity:** AES-GCM authenticates encrypted chunks and signed metadata is checked by the app. This does not eliminate all protocol, implementation, browser, endpoint, or identity risks.
- **Identity:** automatic trust-on-first-use (TOFU) pins a first-seen identity in local browser storage. It detects later key changes but does not independently authenticate first contact against a malicious signalling server. Clearing browser storage or using a different browser/device can reset this trust.
- **Availability:** no protocol can guarantee service availability; outages, blocking, resource exhaustion, or unavailable TURN can stop transfers.
- **Storage:** the application is designed not to upload file contents to a file-storage API. The app still processes authentication, online-presence and signalling metadata; receiving browsers temporarily buffer encrypted chunks in memory. TURN forwards encrypted transport packets when selected and consumes relay bandwidth.
- **TURN:** a reachable public TURN host, DNS, firewall rules, shared secret and tested relay candidate pair are required. A Compose service being up is not proof of relay functionality.
- **Production hardening still required:** account-to-key binding with safe rotation/recovery, signalling authorization/state validation, rate and resource limits, multi-instance session strategy if scaled, dependency pinning/scanning, security review, and cross-network tests.

## Validation status
The source bundle was not successfully built in the authoring environment because frontend dependencies could not be installed there. Build and cross-device tests must be run after extraction. Do not label this ZIP error-free or production-secure until the checks in `deploy/V5-VALIDATION.md` pass.
