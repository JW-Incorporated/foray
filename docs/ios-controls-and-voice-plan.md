# Hermes deck: iOS lock-screen and car controls, the voice picker, and retiring the diagnostic Foray

**Status:** plan for Hermes to cut into kanban cards. Written 2026-09-06 by the
founder's Claude session, from the 2026-09-05 TestFlight session and the founder
feedback log. Companion to `docs/ui-transition-plan.md` (U-cards) and
`docs/release-lockstep-plan.md` (R-cards); this deck's cards are **L-** (lock screen),
**V-** (voice) and **D-** (diagnostic retirement).

The rule that governs every card here, from `CLAUDE.md`: **measured beats inferred.**
Every claim below is tagged. Where a card depends on something no machine here can
observe, it says so and names the human gate.

---

## 0. The brief, verbatim

Wyatt, 2026-09-05, after the on-device narration test (HUMAN-ACTIONS #29):

> "it keeps working all the way through, but the voice is much worse than the
> original test. also, there are no controls for 4a on the lock screen"

Wyatt, 2026-09-05, on what to build for voices:

> "it would be great if we could use a different voice on device for free. is that
> possible? assuming yes, please push a few test forays in the different voices for
> me to evaluate"

— refined later the same evening into an **in-app picker**: list the voices actually
downloaded on the device as selectable, grey out the recommended-but-missing ones
with the Settings path and instructions, switch between installed voices live.

From the founder feedback log (`4a-feedback.md`, kept **off-repo** on Wyatt's Desktop;
quoted here because Hermes cannot read it):

> **F5** (2026-09-04) — *Car controls do not work when the app is backgrounded /
> screen off.* Paused in the car, used the phone, screen off, pressed play on the
> car's controls — nothing. Status: **rank highest; 4a is a driving app and this is
> also a safety issue.**
>
> **F6** (2026-09-04) — *Playback jumped backwards ~2 minutes mid-podcast,*
> unprompted. Leads only, not diagnosed. Hypothesis: a consequence of F7.
>
> **F7** (2026-09-04) — *Lock screen showed "paused" while audio was playing, and a
> position ~1 minute behind actual.* Probably the same root cause as F5.

## 1. What is measured, what is inferred (2026-09-06, `main` @ `#500`)

**Measured, by inspection of `main`:**

- There is **no iOS remote-command or now-playing code in the shipping shell.**
  Zero matches for `MPRemoteCommandCenter` / `MPNowPlayingInfoCenter` under
  `mobile/`. The only matches are under `ios/App/`, the SwiftUI reference app
  `CLAUDE.md` classifies as a design document, not the app.
- `mobile/plugins/foray-audio` is **Android-only** (`package.json` `"//no-ios"`
  says so on purpose: "on iOS WebKit sets the AVAudioSession category itself…
  Adding an ios/ src here would be native code with nothing to do"). That reasoning
  was about *keeping audio alive*, which iOS does; it was never about *controls*.
- The Android lock screen shipped 2026-08-18 (#271, closing #27) as a
  **`navigator.mediaSession` polyfill** whose native side "plays the part of the
  browser". `player/` was not modified. Cost: 1,913 lines Java + 1,830 web, 156
  tests (`foray-audio-shell.test.mjs` 83, `foray-media-session.test.mjs` 67, floors in
  `test/suite-integrity.test.js`). `docs/android-lock-screen.md` argues every decision.
- `player/media-session.js` (floor 131) already decides everything a lock screen
  says: three metadata fields, previous/next are **segments**, the position is the
  **Foray's** clock, a finished Foray reports `"none"`, the 2.0 s seam beat reads as
  playing. `player/client.js` `syncMediaSession()` writes it from `render()`.
- The polyfill's install guard is `mediaSessionApplies()`: `getPlatform() === "android"`
  and nothing else. On iOS it returns false and the file is inert.
  `tools/mobile/prepare-webdir.mjs` already copies it into the bundle on **both**
  platforms (`SHELL_ONLY_FILES`), so the iOS bundle carries the code and never runs it.
- `mobile/plugins/foray-tts` has an iOS half (`Package.swift`, SwiftPM, iOS 15+),
  three methods — `speak`, `state`, `listVoices` — and since #491 `speak` takes a
  `voice` identifier and picks the best **installed** tier when none is given.
  `listVoices()` reports `{identifier, name, language, qualityRank}` sorted best-first.
  Its XCTests exist and are **compiled but not run** in CI (`ios-build.yml`'s
  `ios-shell` builds the app; `ci.yml`'s `ios-kit` runs `swift test` only against
  `ios/ForayKit`, line 83).
- The plugin claims the audio session itself before speaking:
  `setCategory(.playback, mode: .spokenAudio)` + `setActive(true)`
  (`ForayTtsPlugin.swift:439-440`). Knowing when an utterance **finishes** is
  documented as "real future work" (`:465`); the queue does not advance past a spoken
  item.
- ~~The diagnostic instrument from #29 is **still in the tree**~~ — **superseded 2026-09-12.**
  D-01 deleted it: Foray `tts-locked-screen-check` is gone from `data/forays.json`,
  `DIAGNOSTIC_FORAY_ID` / `withDiagnosticUnlock()` from `player/foray-resolve.js`, and its
  call sites and tests with them. A repo-wide search finds the strings only inside the
  tripwire that forbids them (`test/release-gates.test.js:389-391`, the gate itself at
  `:406`), and `test/suite-integrity.test.js:121` records the floor going 54 -> 59 when the
  instrument landed and 59 -> 54 when D-01 removed it. `docs/curation/tts-locked-screen-check.md`
  is kept as the measurement record, as the card asked. The paragraph below is left as written
  because it is what was true when this deck was cut.
- HUMAN-ACTIONS #40 is OPEN: download one Enhanced voice, re-listen. Its step 4 plays
  the diagnostic Foray. Its own note admits there is "no UI for" `listVoices()`.

**Measured on a device (Wyatt, 2026-09-05, TestFlight off `main`):** AVSpeechSynthesizer
narration continues with the screen locked, all the way through (#29 RESULT). 1.5x
played at ~3x (fixed by #490, **uncorroborated** — one data point, needs a second
reading). The lock screen offered no controls.

**Inferred, flagged for M-01 to measure:**

- WKWebView on iOS 15+ probably *exposes* `navigator.mediaSession` (Safari does).
  If it does, `createMediaSession()` in `client.js` believes it is supported, writes
  to it, and the OS shows whatever WebKit forwards — which F7 suggests is populated
  once from the `<audio>` element and never refreshed. **This changes L-02's
  install strategy**: on Android the polyfill installs where the API is *absent*; on
  iOS it may have to *replace* a present-but-inert one. Do not design past this
  without M-01's answer.
- During **spoken narration** there is no `<audio>` element playing, so WebKit
  publishes nothing to Now Playing at all; the lock screen would be blank or stale
  even if the `<audio>` path worked. Native must own Now Playing for both.
- Two writers to `MPNowPlayingInfoCenter` fight. If WebKit is publishing from the
  element and our plugin publishes from the page, the display flickers between
  them. L-01's design comment must say which wins and how (likely: the plugin
  publishes, and the element path is made silent by never letting WebKit see
  metadata — or the reverse; M-01 decides).
- F6 (the 2-minute backwards jump) may be a remote command or an interruption-resume
  acting on the OS's *stale* position. Not a workstream here; L-04 records whether it
  recurs after L-01/L-02 ship.

## 2. Target

- **Lock screen and car (Bluetooth / steering wheel) controls on iOS**, showing the
  same thing the Android lock screen shows, decided by the same file
  (`player/media-session.js`), with `player/` unmodified — the Android argument,
  reapplied. Play/pause, previous/next **segment**, −15/+30, scrub on the Foray's
  clock, stop; a finished Foray offers no transport. Position and playing-state that
  are **true**, including during narration.
- **A voice picker in the app** (Wyatt's refined design), on both platforms, with an
  audition line, persisting the choice, and feeding it into narration playback.
- **The diagnostic Foray gone**, with a release gate that keeps it gone.

## 3. Human gates

| # | Who | What | Blocks |
|---|---|---|---|
| H1 | Wyatt | **The drive test.** After L-02's TestFlight build: lock the phone mid-Foray, use the lock-screen controls and the car's controls; report each control (worked / did nothing / did the wrong thing), whether the position shown tracked the audio, and whether any backwards jump (F6) recurred. ~10 minutes, in the car. Written up as a new HUMAN-ACTIONS item by L-04. | Closing F5/F7; L-04 |
| H2 | Wyatt | **#40** — download one Enhanced voice and listen. After V-01, the listen happens through the picker's Audition button, not the diagnostic Foray. | The server-vs-device narration decision |
| H3 | Wyatt | **The 2x re-check** for #490's rate curve: pick 2x in the app, tap Audition on the counting line, time it with a stopwatch; ~50 s means the curve is right, materially off means the *shape* is wrong. New HUMAN-ACTIONS item, written by V-01. | Confirming #490 |
| H4 | Wyatt | `founder-approved` label for the one `.github/` change (running the plugins' XCTests in `ios-kit`, L-01). Batch with the R-deck's label sitting. | L-01's tests running in CI |
| H5 | Wyatt | **The narration pause test** (L-05, #654). On a TestFlight build carrying L-05: start a Foray with a narration line and, while it is SPEAKING, press pause (a) in the mini-player and (b) on the lock screen. Each must silence the voice within about a second, and resume must continue from the same sentence rather than restarting the line. Then close the player mid-line and confirm the voice stops. ~3 minutes, at a desk. | Closing F12 |
| H6 | Wyatt | **The Now Playing display** (L-06, #654). Same build, in the car or on the locked phone: read back title / artist / album / artwork for a Foray SEGMENT and for a NARRATION line. None of the six text fields may say "4a". Then copy the Playback diagnostics and paste the `now playing` header line plus a few `nowplaying` rows. | Closing F15 |
| H7 | Wyatt | **The why-did-it-stop copy** (M-03, #654). Reproduce F16 if it still happens — play with the screen off, wait for it to stop — then copy the diagnostics. A `session` row above the `stop` row names the cause; no `session` row at all is itself the finding. Whatever it names becomes a follow-up card with the evidence attached. | Closing F16 / #548 |
| H8 | anyone with an Android phone | **The Android narration pause pass** (L-05, #654). Android's pause is emulated — `TextToSpeech` has none — so whether `onRangeStart` fires at all on the shipping engine, and therefore whether resume continues mid-line or re-speaks the whole line, is a device reading nobody has taken. `resume()`'s `fromStart` flag answers it. | The Android half of F12 |

Not a gate here, recorded so nobody thinks it is: a **CarPlay app** (a Foray list on
the car's display) needs Apple's CarPlay audio entitlement, a founder request with a
review cycle. F5 is about Bluetooth/steering-wheel transport, which
`MPRemoteCommandCenter` serves without any entitlement. CarPlay is a non-goal (§7).

## 4. The card deck

Conventions as in the other decks: the ask; owned vs shared files; dependencies;
**measured** acceptance; sizing (S ≤ ½ day, M ≤ 2 days, L ≤ 5); governance; design
comment first where marked. Branch `t_<card>/<slug>`, STATE.md entry per PR. `mobile/`
auto-merges since #492; `player/`, `app.js`, `test/`, `data/` auto-merge;
`.github/` is DENIED → `founder-approved`. `tools/mobile/shell-invariants.test.mjs`
(floor 50) reads the Java to pin plugin names — extend it, never loosen it.

Read first: `CLAUDE.md`; this file; `docs/android-lock-screen.md` (the argument you
are mirroring); `mobile/plugins/foray-audio/web/foray-media-session.js` header;
`player/media-session.js` header; `docs/ios-native-player-gap.md` §4 "Tier 0" (on
branch `docs/ios-native-player-gap`, unmerged — it prices exactly this shim);
`docs/research/on-device-tts.md` §1 and §7; `mobile/plugins/foray-tts/README.md`;
HUMAN-ACTIONS #29 (RESULT) and #40.

### Track L — the iOS lock screen and car controls

#### M-01 · Measure the iOS WebView's `navigator.mediaSession` before designing around it — **S**
- **Ask:** in the existing `ios-build` simulator run (the `ios-shell` job already
  boots the app and `tools/mobile/ios-ci.mjs` parses its log), record from inside the
  page: `typeof navigator.mediaSession`, whether `setActionHandler("play", fn)` is
  callable, whether `metadata`/`playbackState`/`setPositionState` writes throw, and
  whether the simulator log shows WebKit publishing Now Playing info from the
  `<audio>` element (grep the log for `MRMediaRemote` / `NowPlaying` needles; record
  "no coverage" honestly if the simulator log is silent, as `parseSimulatorLifecycle`
  already does). Write the result as a dated section in a new
  `docs/ios-lock-screen.md` §0, tagged measured/inferred per line.
- **Owned:** `tools/mobile/ios-ci.mjs` (one new probe subcommand + parser), its test
  (`ios-ci.test.mjs`, floor 89 → raise), `docs/ios-lock-screen.md` (new, §0 only).
- **Acceptance:** the run's summary states the four facts above with the run id; the
  doc quotes them. **Not acceptable:** "probably exposed" without a run id.
- **Governance:** no `.github/` change if the probe rides the existing job's steps;
  if a step must be added, batch its label with L-01.

#### L-01 · `foray-audio` grows an iOS half: `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` behind the same `setNowPlaying` — **L** — *design comment first*
- **Ask:** add `mobile/plugins/foray-audio/ios/` as a SwiftPM package in the shape
  `foray-tts/Package.swift` already uses (iOS 15+, `Sources/ForayAudioPlugin`,
  `Tests/ForayAudioPluginTests`), and set `capacitor.ios.src` in the plugin's
  `package.json` (rewrite the `"//no-ios"` note to say what changed and why; the
  audio-keepalive half stays Android-only). `ForayAudioPlugin.swift` implements
  **exactly** the web contract Android answers: method `setNowPlaying` taking the
  `nowPlayingPayload()` object (`state`, `title`, `artist`, `album`, `artworkUri`,
  `durationMs`, `positionMs`, `playbackRate`, `canPlay`… `hasNext`, `hasPrevious`,
  `canSeekBack`, `canSeekForward`), and a `transport` event carrying the same
  `{action, seekOffset?, seekTime?}` the Android side emits. Map it onto
  `MPNowPlayingInfoCenter.default().nowPlayingInfo` (title/artist/album, elapsed,
  duration, rate, artwork via `MPMediaItemArtwork` loaded from the bundle's
  `public/` for our icon and from the network for a publisher's) and enable/disable
  `MPRemoteCommandCenter` commands from the `can*`/`has*` flags: `play`, `pause`,
  `togglePlayPause`, `stop`, `nextTrack`, `previousTrack`, `skipBackward(15)`,
  `skipForward(30)`, `changePlaybackPosition`. A finished Foray (`state: "none"`)
  disables every transport command, mirroring `NowPlaying.acceptsTransport()`.
  **Position** is written once per report; the OS extrapolates from
  `MPNowPlayingInfoPropertyPlaybackRate`, the same reasoning
  `foray-media-session.js` §1 gives for the 1 s write rate.
  **Design comment must settle**, with M-01's evidence: (1) who owns Now Playing when
  an `<audio>` element is playing — the plugin or WebKit — and how the loser is kept
  quiet; (2) audio-session policy — the plugin must **not** re-set the category while
  WebKit or `ForayTts` is speaking (both already set `.playback`), only ensure the
  session is active so remote commands are delivered; (3) whether `stop` is offered
  on a finished Foray (Android: yes, because the notification needs an exit; iOS has
  no ongoing notification, so probably no — say which and why).
- **Owned:** `mobile/plugins/foray-audio/ios/**` (new), `package.json` (plugin),
  `tools/mobile/shell-invariants.test.mjs` (pin the Swift plugin name and method
  name against `PLUGIN_NAME`/`SET_METHOD` in the web half, the way it reads the Java),
  `.github/workflows/ci.yml` (`ios-kit` job, beside its `swift test --package-path
  ios/ForayKit` at line 83: the same for `mobile/plugins/foray-audio` **and**
  `mobile/plugins/foray-tts`, so both plugins' XCTests finally run — one `.github/`
  touch, H4), `tools/mobile/ios-workflow.test.mjs` only if `ios-build.yml` changes
  (it pins workflow properties by regex; update in the same PR, never loosen).
- **Tests (XCTest, mirroring `NowPlayingParsingTest` / `NowPlayingHubTest`):** payload
  parsing with missing/garbage fields degrades, never crashes; the command set
  enabled equals the flags (MUTATION: enable `nextTrack` when `hasNext` is false →
  red); `"none"` disables all transport; a `changePlaybackPosition` event becomes a
  `transport {action:"seekto", seekTime}` on the **Foray's** clock.
- **Acceptance:** `ios-shell` builds green with the plugin folded in (`cap sync`
  discovers it via `capacitor.ios.src` — say so in the PR with the log line);
  `ios-kit` runs both plugins' XCTests and they pass; `shell-invariants` pins the
  names. Nothing under `player/` changes (a diff of `player/*.js` is empty).
- **Governance:** `mobile/` auto-merges; the `.github/` line needs `founder-approved`
  (H4). If the label wait would block, split the workflow line into its own PR.

#### L-02 · The web half installs on iOS — and replaces a present-but-inert `mediaSession` if M-01 says there is one — **M**
- **Ask:** `mediaSessionApplies()` accepts `"ios"` as well as `"android"`. Then the
  part M-01 decides: if iOS exposes `navigator.mediaSession`, `install()` must
  **take it over** (`Object.defineProperty(navigator, "mediaSession", …)` if
  configurable; if not configurable, wrap its methods) so `client.js`'s one-time read
  at init lands on ours — and `uninstall()` restores the original. If iOS does not
  expose it, the Android path applies unchanged. `ASSET_BASE` is Android's
  `file:///android_asset/public/`; iOS needs the equivalent rewrite for our icon
  (the plugin can load from `Bundle.main` — pass a `bundle:` scheme or the bare path
  and let L-01 resolve it; decide in one place and test it). Keep the payload
  identical: the Swift side is a second reader of the same object, not a second
  opinion.
- **Owned:** `mobile/plugins/foray-audio/web/foray-media-session.js`,
  `tools/mobile/foray-media-session.test.mjs` (floor 67 → raise; new cases: iOS
  applies; takeover of a fake existing `mediaSession`; restore on uninstall;
  MUTATION: leave the original in place → red), `tools/mobile/prepare-webdir.test.mjs`
  only if the injected tags change (they should not).
- **Dependencies:** M-01 (strategy), L-01 (a native side to talk to).
- **Acceptance:** in the `ios-shell` simulator run, the page reports
  `navigator.mediaSession` is ours (a marker property the test can read) and one
  `setNowPlaying` call reached the plugin (log line). On Android, `foray-media-session.test.mjs`
  and `shell-invariants` unchanged in outcome.

#### L-03 · Now Playing tells the truth during spoken narration — **M**
- **Ask:** when the current item is narration (a `script`, no asset),
  `syncMediaSession()` must still report `playing`, a title ("Narration" or the
  Foray's title — take `media-session.js`'s existing rule for narration items if it
  has one; if not, add it **there**, argued in its header, since that file owns the
  mapping), and a **running** position. Today `isPlaying()` reads
  `manager.state.type === "playing"` and `forayPosition()` reads the Foray clock —
  verify both advance during an utterance (the queue's narration path was unreachable
  until #487; nothing has watched it under `syncMediaSession()`). Then the half that
  is honestly bigger and should be its **own card if it grows**: `ForayTtsPlugin`
  emits a `finished` event from `speechSynthesizer(_:didFinish:)` (the "real future
  work" at `:465`), `foray-tts.js` surfaces it, `tts-bridge.js` exposes it, and
  `queue-manager.js` advances past a spoken item when it fires — the gap
  `generation-architecture.md` §7 item 3 names, and the reason the diagnostic Foray
  "is designed around" not advancing. Without it, previous/next from the lock screen
  are the only way past a narration line.
- **Owned:** `player/media-session.js` (+ test, floor 131 → raise), `player/client.js`,
  `player/queue-manager.js` (+ test), `mobile/plugins/foray-tts/**` (Swift + web +
  `foray-tts.test.mjs` floor 38 → raise), `player/tts-bridge.js`.
- **Acceptance:** with a fake TTS bridge in Node, a narration item reports `playing`
  and a position that increases across two `render()` calls; a `finished` event
  advances the queue to the next item exactly once (MUTATION: fire it twice → still
  one advance). On device this is what H1 hears: narration → next segment with no tap.
- **Governance:** all auto-merge paths. `player/` is shared with U-08 (which promises
  not to touch `player/*.js`) — no conflict by construction.

#### L-05 · Pause, stop and resume for spoken narration — **M** — *added 2026-09-06 from founder feedback F12* — **DONE** (#654, 2026-09-12; `pause`/`resume`/`stop` on `ForayTtsPlugin.swift`, `ForayTtsPlugin.java` (emulated — `TextToSpeech` has no pause on any API level, said on the wire as `emulated`/`fromStart` and in the README), `web/foray-tts.js`, `player/tts-bridge.js`, and both reducer effect sites; `stop()`/`dispose()` silence speech and the narration clock freezes across a pause so Now Playing keeps its state. The card's own mutation — swap pause and resume — is `player/queue-manager.test.js`'s "resume after a narration pause CONTINUES it". **Still open: H5**, the founder's 3-minute desk test, and an Android device pass for whether `onRangeStart` fires at all on the shipping engine — both named in `docs/ios-lock-screen.md` §7.4)
- **What Wyatt hit (TestFlight 2026090603):** *"Once the on-device narration foray
  test starts, none of the pause buttons work."* **Root cause, measured in code:**
  `mobile/plugins/foray-tts` exposes `speak`, `state` and `listVoices` only — there
  is no `pause`, `stop` or `resume` on either platform (`ForayTtsPlugin.swift`
  `pluginMethods`, `ForayTtsPlugin.java` `@PluginMethod`s), and `queue-manager.js`'s
  pause effect calls `backend.pause()`, which pauses the `<audio>` element while
  `AVSpeechSynthesizer` keeps talking. Nothing in the app can silence narration
  once it starts. For a driving app that is a safety defect, so it outranks L-03's
  polish and should ship first.
- **Ask:** three plugin methods on both platforms — `pause()`, `resume()`, `stop()`
  — with `state()` reporting `speaking | paused | idle`. iOS: `pauseSpeaking(at: .word)`,
  `continueSpeaking()`, `stopSpeaking(at: .immediate)`. Android's `TextToSpeech`
  has no pause: implement pause as `stop()` plus remembering the utterance's last
  `onRangeStart` boundary, and resume as re-speaking from that boundary (say so in
  the README; it is a documented Android limitation, not ours). Web Speech fallback:
  `speechSynthesis.pause()/resume()/cancel()`. Then route the reducer's effects:
  when the current item is narration, `pause`/`resume`/`stop` go to the TTS bridge
  instead of the element; `isPlaying()` reflects the plugin's state so the button
  and the lock screen say the truth. Stopping a Foray (`stopAndClose`) must also
  stop speech.
- **Owned:** `mobile/plugins/foray-tts/**` (Swift, Java, `web/foray-tts.js`,
  `foray-tts.test.mjs` floor 38 → raise), `player/tts-bridge.js`,
  `player/queue-manager.js` (+ test: pause during a narration item calls
  `tts.pause` and not `backend.pause` — MUTATION: swap them → red), `player/client.js`.
- **Dependencies:** none. Can start day 0; L-03 builds on it (the `finished` event
  and this card share the plugin's state machine — land this first, then L-03).
- **Acceptance:** in Node with a fake bridge, pause/resume/stop during narration
  call the bridge and leave the element alone; on device (H1's drive test, or a
  desk test) the mini-player pause and the lock-screen pause both silence
  narration within a second and resume from the same sentence.
- **Governance:** `mobile/` and `player/` auto-merge.

#### M-02 · Reproduce the dead play/pause taps in the iOS Simulator with a UI-tap probe — **M** — *added 2026-09-08 from founder feedback F11 and F13*
- **What Wyatt hit:** F11 (build 2026090603, show page): play needed two taps, then the
  pause button did nothing. F13 (build 2026090705, a playlist): neither play nor pause
  works. **Measured 2026-09-08:** headless Chromium on the web code — the pre-cutover
  build (`872030a`) and current `main` — plays on the first tap and pauses, on a subject
  playlist row, with the real network. So the web player is not the defect; the shell is.
  The candidates are all iOS-side: the WKWebView first-tap gesture rules
  (`html-audio-backend.js` `notePlayGesture`), the new native media-session takeover
  (L-01/L-02, build 2026090705 only — F11 predates it, so it cannot be the whole story),
  and the tab-bar router's click handling under WebKit. A hidden page (`document.hidden`)
  never starts the media load at all and reports "did not settle within 20000ms"; if the
  shell's WebView is ever `hidden` at tap time (a sheet, the first-run overlay, an
  occluded state after the tab-bar switch), that is exactly the symptom reported.
- **Ask:** a fourth probe beside `probe-bridge` / `probe-outpoint` / `probe-seam` in
  `tools/mobile/probe/`, run by `ios-build.yml`'s simulator step: boot the **real app**
  (not a fixture page), navigate to a subject playlist, dispatch a real tap on the first
  `.play-btn` (XCUITest tap or `simctl io` tap at the button's rect; a synthetic
  `.click()` is NOT a gesture and proves nothing), wait 8 s, record
  `ForayPlayer.isPlaying(id)`, `document.visibilityState` at tap time, the mini-player's
  main button label, and the `cp_diag` tail; then tap the mini-player's pause and record
  again. Write it as `foray_probe_tap` in localStorage the way the others do, and have
  `ios-ci.mjs verdict` fail the job when play did not start or pause did not stop.
  Run it twice: once with `foray-media-session.js`'s iOS install disabled (env flag), once
  enabled — that isolates L-02.
- **Owned:** `tools/mobile/probe/probe-tap.js` (+ install wiring in `install-probe.mjs`),
  `tools/mobile/ios-ci.mjs` (+ test, floor 125 → raise), `.github/workflows/ios-build.yml`
  (one step; → `founder-approved`), `docs/ios-ci.md` (a §4d with the measurement).
- **Acceptance:** a run id in `docs/ios-ci.md` with the probe record; either the defect
  reproduces in the simulator (then the record names the stage and the fix is a
  follow-up card with the cause) or it does not (then the record is the evidence that
  it is device- or build-specific, and the next step is Wyatt's diagnostics copy).
- **Governance:** `tools/mobile/` auto-merges; the workflow line needs the label.

#### L-04 · Records, and the drive test written up — **S**
- **Ask:** finish `docs/ios-lock-screen.md` in the shape of `docs/android-lock-screen.md`
  (§ how every claim was obtained; what the lock screen says; controls exposed and
  declined with reasons; the Now Playing ownership decision from L-01), a new
  HUMAN-ACTIONS item for **H1** with per-control checkboxes and a place to write the
  F6 observation, STATE.md entries, and a line in `docs/ios-native-player-gap.md` §4
  Tier 0 (if that branch has merged) saying the shim now exists on iOS. Ask Wyatt (via
  the item) to update F5/F6/F7 in his off-repo log.
- **Dependencies:** L-01, L-02 merged; ideally one TestFlight build in Wyatt's hands.
- **Governance:** docs only; auto-merge.

#### L-06 · Now Playing fields match Apple Podcasts — and the record shows what was sent — **M** — *added 2026-09-09 from founder feedback F15* — **DONE** (#654, 2026-09-12; the parity rule is `narrationCredit()` and `media-session.js` §1b — a segment unchanged, a line we wrote credited to the FORAY's title with a real-name fallback ladder, and `"4a"` no longer the artist of anything a listener hears while F-89's no-empty-credit requirement survives on the first rung. The instrumentation half is `createMediaSession`'s `onWrite` hook, which fires only on a REAL write, into a `nowplaying` entry carrying the three capped strings, the artwork count and the shim's `installed`/`sends` — so a Foray with no `nowplaying` rows is itself the third explanation. **Still open: H6**, the display read-back and diagnostics copy, §7.4)
- **Ask:** on the lock screen and in the car the founder saw only "4a" — no title,
  artist or album. Two halves. (1) **Instrument before designing:** the playback
  diagnostics record (`player/diagnostic-log.js`) gains a `nowplaying` entry per
  `setNowPlaying` call carrying `title`/`artist`/`album` (truncated to 40 chars each,
  no artwork bytes) and the platform verdict (`ok`/`reason`) the plugin returns, so the
  next founder copy says which of the three explanations applies: a narration line with
  no `nextItem` and an empty Foray title (`mediaMetadata()` then emits title AND artist
  `"4a"`), an item with empty `title`/`show`, or a payload that never reached
  `MPNowPlayingInfoCenter` (WebKit's default is the app name). (2) **Parity rule,
  written into `media-session.js` §1 and applied on both platforms:** what Apple
  Podcasts shows is title = episode, artist = show, album = show, artwork = show art.
  For a segment that is exactly what we send; keep it. For a narration line: title =
  `"Up next: <episode>"` as now, **artist = the Foray's title** (a collection name,
  never the app's), album = the Foray title with the part counter; **`"4a"` may not
  appear as the title or artist of anything a listener hears** — the fallback for a
  missing Foray title is the first act's title, then the show of the next item.
  Single-episode play keeps album empty. Artwork for narration stays our icon.
- **Owned:** `mobile/www/player/media-session.js` (+ its tests, floor raise),
  `player/diagnostic-log.js`, `ForayAudioPlugin.swift` only if a field is dropped
  there (verify with the M-01 probe's `nowPlayingCoverage()`), Android `NowPlayingHub`
  unchanged unless the parity rule changes a field it reads.
- **Acceptance:** a unit test per rule above with the F15 inputs; the diagnostics copy
  from a TestFlight build shows a `nowplaying` line with three non-empty fields for a
  Foray segment AND for a narration line; H1's drive test re-run for the display only.
- **Governance:** `mobile/www/` and `tools/mobile/` auto-merge.

#### M-03 · Why did it stop? — native interruption and lifecycle events in the record, then the screen-off reproduction — **M** — *added 2026-09-09 from founder feedback F16 (#548)* — **DONE** (#654, 2026-09-12; (a) both iOS plugins observe `AVAudioSession` interruption / route change / media-services reset and `UIApplication` background/foreground and raise one `session` event, re-broadcast on `window` by `foray-media-session.js` and recorded against a closed vocabulary that never admits a route's NAME, keeping the plugin's own stamp beside the page's so the delivery lag — the suspension's length — is readable; (b) every play/pause records its source, `tap` vs `remote`, BEFORE the no-op early return so an F5-style dead press still leaves a row; (c) the screen-off half landed as `foraySessionEvents()` over the UNIFIED LOG rather than as a new probe, because that is the only channel a suspended WKWebView cannot silence and `ios-build.yml` already captures it — **so this needed no `.github/` change and no `founder-approved` label**. Silence reads as `no-coverage` and cannot fail the job. Per the card, the FIX for whatever the record names is a follow-up with the evidence attached. **Still open: H7**, the founder's diagnostics copy after a reproduction, §7.4)
- **Ask:** the founder's record shows ONE `stop element pausedUnexpectedly` +
  `reconcile unexplainedPause` at `hidden=y`, `seams 0` — not #224's seam path, and not
  the F11/F13 loop #537 closed — about 30 s (his clock; the record has no play entries)
  after play with the screen off. The record cannot say why, so make it able to:
  (a) `ForayAudioPlugin` and `ForayTtsPlugin` observe `AVAudioSession.interruptionNotification`
  (type, `shouldResume`), `routeChangeNotification` (reason), `mediaServicesWereReset`,
  and `UIApplication` `didEnterBackground`/`willEnterForeground`, and emit one
  `session` event to the web with `{kind, reason, at}`; (b) `client.js` records every
  play/pause SOURCE (tap, remote command, reconcile, session event) as its own
  diagnostics entry and the element's `pause` with WebKit's interruption reason where
  exposed; (c) the M-02 simulator probe (#536) gains a screen-off/backgrounded pass:
  play, background the app (`simctl` lock where available, else the `UIApplication`
  suspend path M-02 already drives), wait 60 s, and parse the log for the same three
  signals. Then fix whichever cause the record names — the candidates are listed in
  #548 — as a follow-up card with the evidence attached, not as part of this one.
- **Owned:** both iOS plugins (+ XCTests), `player/diagnostic-log.js`, `client.js`,
  `tools/mobile/ios-ci.mjs` probe + parser + tests.
- **Acceptance:** a diagnostics copy where a stop is preceded by the session/lifecycle
  event that caused it, or by nothing — which is itself the finding; the simulator pass
  reports coverage honestly (`parseSimulatorLifecycle`'s "no coverage" convention).
- **Governance:** `tools/mobile/`, `mobile/plugins/` auto-merge; a workflow-line change
  needs the label.

### Track V — the voice picker

#### V-01 · Settings gains a voice picker, an Audition button, and a persisted choice — **M** — *design comment first*
> **2026-09-10 note (founder decision, after the first real listen).** The card below
> shipped as written (PR #519). Wyatt's verdict on the result: *"those voices were all so
> bad. Samantha was the least worst so let's go with that for now."* The follow-up
> changes three things the card text still describes the old way: (1) the picker renders
> a **curated allowlist in a fixed order** — Samantha plus a trial set (Allison, Susan,
> Joelle, Tom, Nicky, Aaron; Daniel, Serena; Karen; Moira; Tessa; Rishi) — and hides
> every other installed voice, because `listVoices()` on iOS 17+ returns Apple's novelty
> and Eloquence voices at Samantha compact's own tier and the plugin does not filter
> `isNoveltyVoice`; Ava, Evan, Nathan, Zoe are removed. (2) **Samantha's best installed
> tier is the default** when no `cp_voice` is stored (`player/default-voice.js`, one
> rule for narration and the picker; #491's best-installed heuristic is now the fallback
> when no Samantha is installed). (3) Audition is **"one … ten."** — no twenty, no
> markers; H3's predicted 2x reading halves. `listVoices` is asked for `lang: "en"` so
> the non-US voices come back at all (both native halves match the exact locale first
> and alone). Card text left as the historical record.
- **Ask:** a **Narration voice** section reachable from the drawer (`renderDrawer()`,
  next to *Playback diagnostics*) and, once U-02 lands, from its Settings entry — this
  card must not wait for `cp_ui_v2`. It calls `tts.listVoices({lang})` through
  `createTtsBridge()` and renders: **installed voices as selectable rows** (name,
  quality label from `qualityRank`, language), best-first as the plugin already
  sorts; **recommended-but-missing voices greyed** (a short, hard-coded list of the
  common Enhanced/Premium English names — Ava, Samantha, Evan, Nathan, Zoe — marked
  *not downloaded*), each with the exact path text
  `Settings → Accessibility → Spoken Content → Voices → English` and an **Open
  Settings** button. **Constraint, stated in the UI copy:** iOS lets a third-party app
  open only its *own* Settings page (`UIApplication.openSettingsURLString`); it cannot
  deep-link to Voices, so the button gets the listener into Settings and the text
  gets them the rest of the way. Android: `listVoices()` exists there too — render
  the same list; the missing-voice hint points at the TTS engine's own settings.
  **Audition:** one button per installed row speaks a fixed line — the counting line
  from the diagnostic Foray, *"one… two…"* to twenty with a marker every ten seconds
  — at the **current playback speed**, so it doubles as the stopwatch test for H3.
  **Persist** the choice under a new durable key `cp_voice` (identifier + platform;
  follow `durable-store.js`'s `cp_` discipline and list it wherever the legal docs
  enumerate local keys — the table in `docs/legal/privacy-policy.md` §"what is stored
  on your device" lists every `cp_` key, and `test/legal-citations.test.js` checks
  it). Feed it into playback: the one `speak` call is
  `player/queue-manager.js:984`, `this._tts.speak(item.script, { rate: this._rate })`
  inside `_speakNarration`; give the manager a `voice` the same way it has `_rate`
  (an option set from the page, not a `localStorage` read inside `player/`, which is
  pure) and pass `voice` alongside `rate`. On `voiceFallback: true` in the result,
  the page shows one non-blocking notice ("Your chosen voice isn't installed; using
  the best available"). Refresh the list on `visibilitychange` so a voice downloaded
  in Settings appears on return.
  **Design comment must settle:** where the section lives before and after U-02;
  the recommended-names list and its source; what Web Speech (plain browser) shows
  (probably the same list from `speechSynthesis.getVoices()`, with no download hint).
- **Owned:** `app.js` (`renderVoiceSettings`, drawer entry), `styles.css`,
  `player/queue-manager.js` (the `voice` option + `_speakNarration`, with its test),
  `player/client.js` (reads `cp_voice`, hands it to the manager),
  `test/voice-settings.test.js` (new, floored; MUTATION: drop the `voice` from the
  `speak` call → red), `docs/legal/privacy-policy.md` (the `cp_` table) and
  `test/legal-citations.test.js`, HUMAN-ACTIONS (rewrite #40 step 4 to use
  Audition; add **H3** as a new item with the ~50 s criterion and #490's curve named).
- **Dependencies:** none. Can start day 0.
- **Acceptance:** with a fake bridge returning two installed voices and the
  recommended list, the page renders 2 selectable + N greyed rows; selecting one
  writes `cp_voice`; the next `speak` carries that identifier; Audition speaks
  exactly the counting line at `backend.rate`. On device (H2): Wyatt downloads a
  voice, returns, sees it, auditions it, and writes the name and verdict in #40.
- **Governance:** `app.js`, `player/`, `test/` auto-merge. No `index.html` touch.

### Track D — retire the instrument

#### D-01 · Delete the diagnostic Foray and gate releases on its absence — **S**
- **DONE** 2026-09-12 (verified in an audit, not at merge time): the instrument is absent
  from `player/`, `app.js` and `data/`, and `test/release-gates.test.js:406` gates every
  release on its absence.
- **Ask:** one commit, as #29's steps prescribe: remove Foray `tts-locked-screen-check`
  from `data/forays.json`, `DIAGNOSTIC_FORAY_ID` and `withDiagnosticUnlock()` from
  `player/foray-resolve.js`, their call sites in `player/client.js`, and the tests
  that name them (`player/foray-playback.test.js` and any other — `git grep` for
  both identifiers and the Foray id). Then add to `test/release-gates.test.js` (which
  `release.yml` runs before either store upload, R-03) a test that **fails if any of
  the three strings reappears** anywhere under `player/`, `app.js` or `data/`, with a
  message pointing at #29. Update HUMAN-ACTIONS #29's "delete the instrument" line
  to DONE-with-date, `STATE.md`'s "Delete after the answer" line, and
  `docs/curation/tts-locked-screen-check.md` (mark it historical, do not delete it —
  it is the record of the measurement).
- **Dependencies:** **V-01 merged** (Audition replaces the instrument for H2/H3).
  Not before.
- **Acceptance:** `git grep -n "tts-locked-screen-check\|DIAGNOSTIC_FORAY_ID\|withDiagnosticUnlock"`
  returns only docs and HUMAN-ACTIONS; `node --test test/release-gates.test.js` green
  (floor 5 → raise in `suite-integrity`); MUTATION: re-add the Foray id to
  `data/forays.json` → the gate goes red.
- **Governance:** all auto-merge paths.

## 5. Sequencing

```
Day 0 (parallel):   M-01 (measure)        V-01 (voice picker; no dependencies)
Then:               L-01 ← M-01 (design comment needs the measurement)
Then:               L-02 ← M-01, L-01     L-05 (day 0, no dependencies; ship before L-03)   L-03 ← L-05
Then:               D-01 ← V-01           L-04 ← L-01, L-02, one TestFlight build
2026-09-09:         L-06 (instrument, then parity)   M-03 (instrument, then reproduce) — both day 0, no dependencies
Human:              H2, H3 as soon as V-01 is on TestFlight;  H1 after L-02;  H4 with the R-deck label sitting
```

The R-deck's `release.yml` (R-03) is the path that produces TestFlight builds once
R-05 retires the old ones. D-01's gate lives in the test that workflow runs, which is
why D-01 waits for V-01: a gate that blocks every TestFlight build while the founder
still needs the instrument would be the friction pointing the wrong way.

## 6. Coordination

- **U-08** (player chrome restyle) promises an empty `player/*.js` diff; L-03 owns the
  `player/` changes here. **U-02** adds a Settings entry; V-01 must be reachable
  before it exists and must move under it when it does — say so in both PRs.
- **R-03/R-05** own `release.yml`. D-01 adds a test to a file that workflow already
  runs; it does not touch the workflow.
- **`docs/ios-native-player-gap.md`** (unmerged branch) is the reference for what
  Tier 0 costs and sacrifices. It should merge as a research doc; L-04 links it.

## 7. Non-goals

- A **CarPlay app** (templates on the car's display). Needs Apple's entitlement, a
  founder request; F5 is served without it.
- Porting any of `player/` to native (Tier 1/2 in the player-gap doc). The Android
  argument holds: the page is the source of truth and native plays the browser.
- Fixing F6 directly. L-04 records whether it recurs once Now Playing is truthful.
- Changing what the lock screen *says*. `player/media-session.js` decided that; this
  deck delivers the decision to a second platform.
