# Fable-driven adversarial review — foray-tts / foray-audio Capacitor plugins

Task: t_05800921 (Foray/4a board, one of 4 parallel Fable review lanes)
Repo: /workspace/projects/foray
Scope: mobile/plugins/foray-tts/ and mobile/plugins/foray-audio/ (Android Java, iOS Swift, web JS bridge), both AndroidManifest.xml files, lexicon/hard-terms.json

## Method / blocker

`claude --model claude-fable-5 -p` (the designated Fable arbiter) was attempted 40+ times
over ~35 minutes — single calls, backgrounded, and a retry loop (25 tries/chunk) — and was
OOM-killed (exit 137) on **every single attempt**, including a trivial "reply OK" prompt,
in this sandbox's ~114-182MB cgroup. This is an infrastructure limitation of this task's
sandbox, not a code or prompt-sizing issue (chunks were kept 28-46KB, under the 75KB
guidance). In its place I performed a full manual adversarial line-by-line read of every
requested file and cross-checked every claim against docs/legal/privacy-policy.md and
docs/legal/data-safety.md.

Files actually read in full:
- mobile/plugins/foray-tts/android/.../ForayTtsPlugin.java
- mobile/plugins/foray-tts/ios/.../ForayTtsPlugin.swift
- mobile/plugins/foray-tts/web/foray-tts.js
- mobile/plugins/foray-tts/lexicon/hard-terms.json
- mobile/plugins/foray-tts/android/src/main/AndroidManifest.xml
- mobile/plugins/foray-audio/android/.../ForayAudioPlugin.java
- mobile/plugins/foray-audio/android/.../NowPlayingHub.java
- mobile/plugins/foray-audio/android/.../WebViewPlayer.java
- mobile/plugins/foray-audio/android/.../NowPlaying.java
- mobile/plugins/foray-audio/android/.../PlaybackKeepAliveService.java
- mobile/plugins/foray-audio/android/src/main/AndroidManifest.xml
- mobile/plugins/foray-audio/web/foray-media-session.js
- mobile/plugins/foray-audio/web/foray-audio-shell.js
- docs/legal/privacy-policy.md, docs/legal/data-safety.md (for disclosure cross-check)

Also ran repo-wide greps across both plugin trees for network primitives
(`fetch|XMLHttpRequest|http://|https://(?!localhost)|WebSocket|sendBeacon`) and logging
calls (`Log\.|console\.|NSLog|print\(`).

## Findings

**No real "data leaving the device" findings in either plugin.**

1. **foray-tts is fully on-device.** Android wraps `android.speech.tts.TextToSpeech`,
   iOS wraps `AVSpeechSynthesizer` — both are local OS TTS engines. No `URLSession`,
   `OkHttp`, `fetch`, or `XMLHttpRequest` anywhere in the plugin. `Log.w` calls only log
   exception class names and fixed strings ("empty text", "TextToSpeech not ready yet",
   etc.) — narration text itself is never logged. `hard-terms.json` is a static bundled
   pronunciation lexicon (no `ipa` values populated except one entry with a public-source
   citation), not a data sink. The Android manifest declares zero permissions, which is
   correct — `TextToSpeech` needs none.

2. **foray-audio is fully local.** All "now playing" metadata (title/artist/album/
   artwork URI, position, playback state) flows only:
   `page JS -> Capacitor bridge (window.Capacitor.nativePromise) -> NowPlayingHub
   (Java, in-process singleton) -> local Android Notification / Media3 MediaSession`.
   `assetUri()` in foray-media-session.js only (a) rewrites a same-origin WebView URL to
   the local bundled-asset file:// path Capacitor already ships, or (b) passes an
   already-vetted `https:` artwork URL through untouched for the native notification
   renderer to load — the same publisher/Apple-hosted artwork fetch already disclosed in
   privacy-policy.md 4.3, not a new third-party send. `Log.w` calls capture only
   exception class+message and fixed action names (never episode text). The Android
   manifest permissions (`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
   `POST_NOTIFICATIONS`) are minimal and justified by the documented background-playback /
   lock-screen-controls use case; none are broad relative to what the code does.

3. **Notable but not a leak - worth a doc-consistency check, no sign-off needed.**
   `PlaybackKeepAliveService.buildNotification()` sets
   `.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)`, so the episode title/show name
   is visible on a *locked* phone's lock screen. This is intentional (the code comment
   states it is load-bearing for the whole feature - without PUBLIC visibility a
   lock-screen-hiding user sees "Contents hidden" instead of transport controls) and is
   local-device UI behavior, not data transmission off the device. No founder/legal
   sign-off is needed since nothing leaves the device; recommend a one-line addition to
   data-safety.md's native-shell section (Part C) confirming this is covered if it isn't
   already, purely as documentation hygiene.

## Sign-off assessment

None of the above requires founder/legal sign-off - no privacy-sensitive behavior change
is proposed or found. If Fable-arbiter sign-off is a hard gate for closing this lane, it
needs to be re-run in an environment with materially more memory headroom than this
sandbox provided (every attempt here OOM'd regardless of prompt size).
