# Share changes

- Renamed the visible product to Share and added concise Files, Screen, Voice, Video, and How it works navigation with a matte black and muted gold palette.
- Added WebRTC voice/video calls and screen sharing, with signed SDP and pinned browser identity, acceptance flow, device permissions, session controls and track cleanup.
- Extended the authenticated signalling state machine to support call renegotiation, sharing status and peer disconnect cleanup.
- Corrected Nginx media permissions and aligned documentation with the actual Compose loopback port.
- Documented trust boundaries, browser support, verification steps, HTTPS diagnosis and untested deployment requirements.

## Interface refinement
- Replaced the promotional landing copy and badges with a concise sign-in screen.
- Simplified file and media panels, flattened the security guide, and reduced rounded cards and decorative effects.
- Kept the original matte black and muted gold palette with solid surfaces and restrained borders.

## Logic and security review
- Tightened file-transfer peer/session correlation and signed metadata consistency checks.
- Serialized server signalling transitions and outbound socket writes; cancelled sessions on account replacement and expiry.
- Refreshed TURN credentials per session and reduced the CSP's outbound connection scope.
- Deferred first-contact media key pinning until acceptance, added anonymous socket timeout, and documented remaining trust and renegotiation limits.

## Call repair
- Applied incoming offer before attaching recipient microphone/camera tracks; added focused negotiation tests.
- Added guarded call actions, collision rollback, remote-audio playback fallback, state/candidate-count diagnostics, and mobile screen-capture feature detection.
- Documented observed production headers, missing TURN/device verification, deployment and rollback in `deploy/CALL-REPAIR.md`.
