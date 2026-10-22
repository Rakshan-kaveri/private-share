# Browser behavior and limits

Use HTTPS or localhost. `getDisplayMedia()` must run from a user action and always presents the browser's native picker. Available display, window and tab choices vary by browser and operating system. Audio may be absent even when requested; Cove continues video sharing and reports that limitation. The app cannot identify the exact selected application unless the browser exposes it. A browser-native stop triggers cleanup. Camera and microphone permissions can be denied or unavailable. Speaker selection requires `HTMLMediaElement.setSinkId`; unsupported browsers use the system default. Device selectors affect the next call. The app does not record screen or call media.

Test separately on Chrome/Edge/Firefox/Safari, desktop and mobile. Mobile screen capture and system audio vary widely. Test tab and full display sharing only where supported. TURN configuration is needed for restrictive networks; STUN alone does not guarantee connectivity.
