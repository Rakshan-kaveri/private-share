# Version 3 — Automated trust + premium black UI

## Changes
- Removes the blocking browser fingerprint prompt.
- Automatically pins each peer's first valid ECDSA identity public key in browser IndexedDB (trust-on-first-use / TOFU).
- Blocks a peer's future transfers if its pinned identity key changes. Do not clear site data or switch browsers without understanding this resets the local pin.
- Uses a premium black and muted champagne/gold visual palette.
- Keeps browser-side AES-256-GCM encryption, ECDH key agreement, signed transfer key bundles, signed SHA-256 manifests, and integrity rejection.

## Security limitation
TOFU is a usability improvement, not perfect first-contact authentication. If an attacker can impersonate a peer during the very first contact (for example, through a compromised signalling service), this browser may pin the attacker's key. A stronger fully automated design needs a trusted account-to-public-key binding service with explicit key registration/rotation and recovery, or an independent identity provider that authenticates the key binding. This version must not be described as foolproof or independently audited.

## Build status
Source package prepared. Build/deployment must be validated on the target Ubuntu host using Docker Compose; this environment could not complete npm dependency installation, so do not assume a fresh frontend build has been verified here.
