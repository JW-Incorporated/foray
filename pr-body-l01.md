## L-01: foray-audio grows an iOS half — MPNowPlayingInfoCenter + MPRemoteCommandCenter

Source: `docs/ios-controls-and-voice-plan.md` card L-01, kanban `t_44e5da2a`. Depends on M-01 (merged, #515), which measured that WKWebView on iOS DOES expose a live `navigator.mediaSession` publishing from `<audio>` — that evidence is what this PR's design comment (posted to the kanban card before writing code) settles against.

### What this adds

`mobile/plugins/foray-audio/ios/` — a SwiftPM package in the exact shape `foray-tts/Package.swift` already uses (iOS 15+, `Sources/ForayAudioPlugin`, `Tests/ForayAudioPluginTests`), with `capacitor.ios.src` set in the plugin's `package.json`.

`ForayAudioPlugin.swift` implements exactly the web contract Android already answers:
- `setNowPlaying` takes the `nowPlayingPayload()` object and maps it onto `MPNowPlayingInfoCenter.default().nowPlayingInfo` (title/artist/album, elapsed, duration, rate, artwork via `MPMediaItemArtwork`).
- `MPRemoteCommandCenter` commands (`play`, `pause`, `togglePlayPause`, `nextTrack`, `previousTrack`, `skipBackward(15)`, `skipForward(30)`, `changePlaybackPosition`) are enabled/disabled from the `can*`/`has*` flags.
- A finished Foray (`state: "none"`) disables every transport command, mirroring `NowPlaying.acceptsTransport()`.
- `stop` is registered but **permanently disabled** — see design comment #3 below.
- Position is written once per report; the OS extrapolates from `MPNowPlayingInfoPropertyPlaybackRate`.

### Design comment (posted to the card before the bulk of this code)

1. **Who owns Now Playing when `<audio>` is playing — plugin or WebKit?** The plugin, by construction: WebKit publishes synchronously off the `<audio>` element's own events; our `setNowPlaying` crosses the Capacitor bridge asynchronously and lands on a later runloop turn on every seam. No suppression needed (there's no API for it anyway). During narration there's no `<audio>` element, so no second writer exists at all.
2. **Audio-session policy.** Only `setActive(true)`, never `setCategory` — WebKit/`ForayTts` already own the category (`.playback`/`.spokenAudio`). Never `setActive(false)`.
3. **`stop` on iOS: declined outright**, not just on a finished Foray. Android needs it because a foreground-service notification needs a one-press exit; iOS has no equivalent ongoing surface.

Full comment: see kanban card `t_44e5da2a`.

### Owned by this PR

- `mobile/plugins/foray-audio/ios/**` (new)
- `mobile/plugins/foray-audio/package.json` (rewrote the iOS platform notes)
- `tools/mobile/shell-invariants.test.mjs` — new test pins the Swift plugin's `jsName`/`setNowPlaying`/`TRANSPORT_EVENT` against the web half's `PLUGIN_NAME`/`SET_METHOD`/`TRANSPORT_EVENT`, the way it already reads the Java. Also updates one pre-existing test that asserted foray-audio declared no iOS platform — true before this card, intentionally false now (the note explains the history).
- `test/suite-integrity.test.js` — floor raised 50 → 51 for `shell-invariants.test.mjs`.

### NOT included

The `.github/workflows/ci.yml` `ios-kit` line that would actually run these XCTests in CI. Per the plan's own governance note, that change needs the `founder-approved` label (H4) and is deliberately split into its own follow-up PR so this one isn't blocked waiting on a label.

### Verification

- `node --test tools/mobile/shell-invariants.test.mjs` → 55/55 passing (51 top-level `test()` sites).
- `node --test test/suite-integrity.test.js` → 209/209 (floor updated in the same commit).
- `node --test test/*.test.js` (full root suite) → 833/833.
- `node --test tools/mobile/*.test.mjs` (full tools/mobile suite) → 717/717.
- `git diff origin/main -- 'player/*.js'` → empty, per the card's acceptance criterion (nothing under `player/` changes).

Governance: `mobile/` auto-merges (foray `merge_authority: agent`, `human_gates: []`).
