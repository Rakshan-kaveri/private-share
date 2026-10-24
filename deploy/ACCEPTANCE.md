# Verification checklist

Automated here: `npm run build` passed. Maven and Docker executables were unavailable here, so `mvn test`, `mvn package`, and `docker compose config` must be run on your machine/VM.

With two signed-in browsers or devices, verify: Google sign-in and online presence; file accept/reject, content digest, tampered-chunk rejection, and logout; voice accept/reject/mute/hangup and audible remote audio; video camera/mic controls and remote playback; tab/window/display picker; optional screen audio; native and in-app stop; share during voice and video call, then return to the call; TURN relay across separate networks; device permissions denied; second account session; disconnect and reconnection; mobile layout. Check WebSocket authorization by trying a missing/expired token and a session ID owned by neither participant. Verify certificate and mixed content using `deploy/HTTPS.md`.

These cases are **not recorded as passed**. Use real peers and check console/network logs before publishing. File size limit is 256 MiB, and browser memory usage may be high.
