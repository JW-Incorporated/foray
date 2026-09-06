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
- The diagnostic instrument from #29 is **still in the tree**: Foray
  `tts-locked-screen-check` in `data/forays.json`, `DIAGNOSTIC_FORAY_ID` /
  `withDiagnosticUnlock()` in `player/foray-resolve.js`, call sites in
  `player/client.js:99,1377`, tests in `player/foray-playback.test.js`. #29's own
  step says: *"When it is answered, delete the instrument… None of it should be in the
  App Store build."* #29 is answered (DONE 2026-09-05). It has not been deleted
  because #40 (voice re-listen) and the 2x rate re-check still use it. This deck
  replaces that dependency (V-01) and then deletes it (D-01).
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

### Track V — the voice picker

#### V-01 · Settings gains a voice picker, an Audition button, and a persisted choice — **M** — *design comment first*
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
Then:               L-02 ← M-01, L-01     L-03 (can start after L-01's design comment; own PR)
Then:               D-01 ← V-01           L-04 ← L-01, L-02, one TestFlight build
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
