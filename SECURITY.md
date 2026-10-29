# Security policy

Private Share is a student project and has **not** had an independent security audit.
The design and its known limits are described in the [README](README.md#security).

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply as soon as possible.

## In scope

- Anything that lets the server, the TURN relay or a network attacker read or change call content or files
- Bypassing the signature checks on key bundles, connection descriptions (SDP) or file manifests
- Signing in as someone else, or sending signalling messages into someone else's call
- Script injection through names, file names or any other user-supplied text
- Ways to crash or exhaust the server or the relay with little effort

## Known limitations (not vulnerabilities)

- The first call with someone trusts the key it receives until the safety code is compared.
- The client code is served by the same server, as in every browser-based end-to-end encryption scheme.
- The server and Cloudflare see routing metadata: who is online and who calls whom.
- File names listed in a "Send files" invite are signed but not encrypted.
