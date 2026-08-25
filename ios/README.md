# Foray — iOS

> ## This is not the iOS app that ships. Read this box first.
>
> As of **2026-08-17** (issue **#36**, MP2) the shipping iOS app is a **Capacitor
> shell around the web player**, and it lives in **`mobile/`** — see
> `docs/mobile-shell.md`, which explains why in full. This directory is
> **reference material plus one CI-tested Swift package**. It is deliberately not
> moved or renamed; only its role changed.
>
> - **`ios/ForayKit/` is alive.** CI's `ios-kit` job runs `swift test
>   --package-path ios/ForayKit` on a macOS runner, so this package really does
>   compile and pass. `IntentGrammar.swift` (the Tier-1 voice grammar) exists
>   **only** here — there is no JavaScript equivalent anywhere in the repo.
> - **Two files are mirrored in JavaScript and must be changed together.**
>   `ForayKit/Sources/ForayKit/PlayerQueueState.swift` ↔ `player/queue-state.js`,
>   and `App/Player/PlayerQueueManager.swift` ↔ `player/queue-manager.js`. The
>   port was deliberate and the two are meant to stay diffable by eye — see the
>   header of `player/queue-state.js`. **Where they differ in status:**
>   `PlayerQueueState` is tested on both sides (`PlayerQueueStateTests` here,
>   `player/queue-state.test.js` there); `PlayerQueueManager` is tested **only** in
>   JavaScript, and writing that port is what surfaced two real position bugs —
>   which PR **#50** then fixed in this Swift (see AUDIT item 9 below, which cites
>   issue #33, the port). So the Swift is not currently known-wrong; it is
>   uncompiled by CI, which is a different and more permanent problem.
> - **Nothing under `App/` is compiled by CI.** More decisively than any of the
>   above: the machinery the product actually runs on — `foray-resolve`,
>   `foray-queue`, `seam-gap`, `seek-policy`, `html-audio-backend`,
>   `durable-store` — has **no Swift counterpart at all**. That, not the duplicated
>   state machine, is why the web player is the host. Whether the Swift copies get
>   retired belongs to **#28**.
> - **Do not point `cap add ios` at this directory.** Capacitor's default output
>   path is `ios`, which is why `mobile/capacitor.config.json` sets `ios.path`
>   explicitly and `tools/mobile/shell-invariants.test.mjs` fails if the two ever
>   resolve to the same place.
> - **`PRODUCT_BUNDLE_IDENTIFIER` here is `com.wjduvall.foray`**, which predates
>   the org. The shell uses `dev.jwlabs.foura`. They are different apps;
>   this one has never been published.

This was scaffolded on Windows, so **none of it has been compiled or run**.
Every file was written with care for Swift/AVFoundation/SwiftUI correctness,
and every spot where the exact behavior of an Apple API couldn't be
verified without Xcode is marked `// AUDIT:` in the source. Read the
"AUDIT items" section below before assuming anything audio-session-related
just works — that area (`ios/App/Player/PlayerQueueManager.swift`,
`ios/App/Player/PlayerBackend.swift`) is explicitly the highest-risk code
in this scaffold, per `docs/brief/04_VOICE_AUDIO_SPEC.md`.

## Setup (on the Mac)

```bash
brew install xcodegen
cd ios
xcodegen
open Foray.xcodeproj
```

Then in Xcode:
1. Select the `Foray` scheme, pick a simulator or your device.
2. Signing: `project.yml` leaves `DEVELOPMENT_TEAM` blank on purpose (it's
   not something to hardcode into a shared spec file). Set your team in
   Xcode's Signing & Capabilities tab after the project is generated, or
   edit `project.yml`'s `DEVELOPMENT_TEAM` and re-run `xcodegen`.
3. Build and run. `ForayApp` loads the bundled
   `App/Resources/sample_session.json` (a verbatim copy of
   `data/session.json`) on launch — there is no backend yet, so this is
   what populates the Today screen's four cards.
4. `ForayKitTests` (the state machine, intent grammar, and session
   model tests) run either from Xcode's Test navigator (⌘U — it appears
   automatically once the local `ForayKit` package is a target
   dependency) or from the command line:
   ```bash
   cd ios/ForayKit
   swift test
   ```
   The `swift test` path requires no Xcode project at all and is the
   fastest way to check the core logic changed correctly — it has zero
   AVFoundation/UIKit dependency by design.

Re-run `xcodegen` from `ios/` any time `project.yml` or the file layout
under `App/`/`ForayKit/` changes; the generated `.xcodeproj` is a
build artifact, not something to hand-edit or commit.

## Repo layout

```
ios/
  ForayKit/            Swift Package — platform-independent core
    Sources/ForayKit/
      SessionModels.swift     Codable models for the session.json v1 document
      PlayerQueueState.swift  Formal player state machine (pure, no AVFoundation)
      IntentGrammar.swift     Tier-1 local voice-intent grammar (pure)
    Tests/ForayKitTests/
      SessionModelsTests.swift
      PlayerQueueStateTests.swift
      IntentGrammarTests.swift
      Fixtures/session_fixture.json   (copy of data/session.json — keep in sync)
  App/                         SwiftUI app (assembled by XcodeGen, not a checked-in .xcodeproj)
    ForayApp.swift
    Views/
      TodayView.swift          4-card session picker
      NowPlayingView.swift     Now Playing skeleton
    Player/
      PlayerBackend.swift      Protocol wrapping AVPlayer + the real AVPlayerBackend
      PlayerQueueManager.swift The actor that drives PlayerBackend from PlayerQueueState
    Support/
      SessionStore.swift       Loads the bundled sample session (stand-in for a backend)
    Resources/
      sample_session.json      Copy of data/session.json
  project.yml                  XcodeGen spec
  README.md                    This file
```

## What's implemented vs. stubbed

**Fully implemented, unit tested, platform-independent (ForayKit):**
- `SessionModels.swift` — Codable models matching `data/session.json` v1
  exactly, including forward-compatible open enums (`Archetype`,
  `EpisodeDepth`, `EpisodeFormat`) that degrade to `.other(rawValue)`
  instead of failing to decode on a future/unknown tag, and a
  `Session.decode(from:)` entry point that gates on `version` before
  trusting the rest of the shape.
- `PlayerQueueState.swift` — the full `idle → loadingItem → playing →
  transitioning → interrupted → ended` state machine as a pure
  `reduce(state:event:) -> (PlayerQueueState, [PlayerEffect])` function.
  Encodes: position-save-on-interruption, resume-only-if-shouldResume,
  immediate-pause-on-route-loss, TTS-always-1.0x, and the single-player
  invariant (a `play()`/`itemLoaded` race while already playing is
  guarded and telemetered, never allowed to produce two concurrent
  "start playback" effects).
- `IntentGrammar.swift` — Tier-1 deterministic parser for all listed
  commands (skip, pause/resume, next/back, option 1–4 by ordinal or fuzzy
  keyword match, more-like-this, something-different, save, what-is-this,
  thumbs up/down, faster/slower, family mode on/off, skip-intro-only).
  Ordinals always beat fuzzy matches; low-confidence/no-match input
  returns `.unrecognized` rather than guessing.

**Implemented but unverified on real hardware (App target):**
- `PlayerBackend.swift` / `PlayerQueueManager.swift` — a real
  `AVPlayer`-backed actor wired to the state machine above, with
  AVAudioSession category/mode setup, interruption + route-change
  notification handling, position persistence (15s timer + event-driven),
  and MPNowPlayingInfoCenter/MPRemoteCommandCenter. This is the code that
  needs the M0 spike acceptance testing below — see every `// AUDIT:`
  comment in these two files first.
- `TodayView.swift` — 4-card picker, big tap targets, reads the bundled
  sample session.
- `NowPlayingView.swift` — explicitly a **skeleton** per the task brief:
  why-card, transport buttons wired to `PlayerQueueManager`, a hold-to-talk
  circle with press/release visual state. It does not run any audio yet
  (see "Not implemented" below).

**Not implemented (out of scope for this deliverable, needed before the
app actually plays audio end-to-end):**
- `DownloadManager` — nothing downloads episode/TTS audio from a real URL
  yet. `PlayerQueueManager.loadQueue(_:)` expects `PlayableItem`s that
  already point at local files; nothing currently constructs those from a
  real session (only the sample JSON's metadata is used, for card text).
- `VoiceController` — hold-to-talk's actual duck+record+`SFSpeechRecognizer`
  pipeline, and wiring `IntentGrammar.parse` output to
  `PlayerQueueManager`'s transport methods. `NowPlayingView`'s mic button
  is a visual placeholder only.
- App Intents (Siri, "Hey Siri, skip this") — none registered yet.
  05_CORNER_CASES.md #23 ("Siri intent while app cold") will need
  `PlayerQueueManager.configureRemoteCommands()` (or an equivalent) to be
  reachable from an App Intent's `perform()` independent of any view
  appearing; `ForayApp.swift` flags this with a comment.
- Backend networking — `GET /sessions/current`, `POST /events`, etc. don't
  exist; `SessionStore` reads the bundled fixture only.
- Library/History, Interests editor, Settings screens.
- CarPlay.

## Design decisions worth knowing about

- **Kit has zero AVFoundation/UIKit dependency**, on purpose — `swift
  test` runs `PlayerQueueStateTests` and `IntentGrammarTests` without a
  simulator. The App target is a thin adapter layer over it.
- **`PlayerQueueManager` is an `actor`**, and the app creates exactly one
  instance for its whole lifetime (see the comment in
  `ForayApp.swift`). That, plus the state machine's own
  single-player-invariant guard, is the two-layer defense against
  05_CORNER_CASES.md #19 (two AVPlayers alive after a fast skip).
- **Pause is modeled by re-using `interruptionBegan`/`interruptionEnded`**
  in the state machine rather than adding a dedicated pause event — see
  the comment on `PlayerQueueManager.pause()`. This keeps "why are we
  paused" as a single code path but slightly overloads `.interrupted`'s
  telemetry meaning; flagged as a spot to revisit once real telemetry
  consumers exist.
- **The bridge/transition TTS item is modeled as its own queue entry**
  (matching the session document's literal `transition_tts` item type),
  and `PlayerQueueState.transitioning(from:to:)`'s `to` is that bridge
  item's own ref, not the ultimate next episode — see the design note in
  `PlayerQueueState.swift` and the corresponding comments in
  `PlayerQueueManager.handleBackendItemEnded`/`playTransitionBridge`. This
  took a couple of iterations to get consistent; read both files together
  if you're modifying transition behavior.
- **`skipToPrevious()` always restarts the current item in place** for now
  (matches the literal spec text "prevTrack = restart item / previous");
  true "go to the actual previous item" behavior (typically gated on
  elapsed time, mirroring standard podcast apps) is flagged as a follow-up,
  not decided here since it's a taste call.

## AUDIT items — verify on real hardware before trusting

Every one of these is called out inline with `// AUDIT:` at its exact
location. Summarized here for the M0 spike:

1. **Category/route-change notification parsing**
   (`PlayerQueueManager.handleInterruptionNotification`/
   `handleRouteChangeNotification`) — `userInfo` dictionary key names and
   `NSNumber`→`UInt`→enum `rawValue` bridging. This is standard,
   well-established Apple sample-code idiom, but it has never been
   compiled here; a typo'd key silently returns `nil` instead of failing
   to build.
2. **Reactivating `AVAudioSession` after a long interruption**
   (05_CORNER_CASES.md #11's 20-minute-call case) — confirm whether the
   explicit `setActive(true)` call is necessary/sufficient, or whether the
   system already reactivates before delivering `.ended`.
3. **`rate` assignment semantics on `AVPlayer`** (`PlayerBackend.rate`) —
   setting a non-zero rate both sets speed AND starts playback; confirm
   `PlayerQueueManager`'s effect ordering (`resetRateForTTS`/`restoreRate`
   before `startPlayback`) never produces an audible blip at the stale
   per-show rate before the TTS-specific 1.0x lands.
4. **BT record-quality trap** (05_CORNER_CASES.md #24) — not applicable
   yet (no VoiceController), but `PlayerQueueManager` doesn't yet listen
   for a route change to HFP during a future hold-to-talk session; flagged
   for whoever builds VoiceController next.
5. **`AVPlayerItem.seek` async overload** (`PlayerBackend.load`/`.seek`) —
   assumed available at iOS 17; verify exact signature and whether the
   discarded `Bool` return needs handling.
6. **`AVURLAsset.load(.isPlayable)` async property API** — same category
   of "assumed current SDK shape, never compiled" risk.
7. **MPRemoteCommandCenter handlers bridging into actor-isolated async
   work** (`configureRemoteCommands`) — handlers return
   `MPRemoteCommandHandlerStatus` synchronously while spawning a detached
   `Task` for the actual `await`-based work; confirm this reads as
   correct/responsive on a real lock screen and steering wheel, since the
   returned `.success` doesn't reflect the task's eventual real outcome.
8. **`@unchecked Sendable` on `AVPlayerBackend`** — the safety argument
   (all access is serialized because only the actor ever calls in) is
   documented at the declaration; confirm AVFoundation's own internal
   callback delivery (KVO/notifications) never reenters from an
   unexpected thread in a way that breaks that assumption.
9. **`currentIndex` / `targetIndex` split in `PlayerQueueManager`** — added
   2026-07-26 to fix two real bugs found by the JS port (issue #33): a skip
   wrote the outgoing episode's playhead under the *incoming* episode's id
   (destroying its resume point), and `skipToPrevious()` resumed instead of
   restarting. The fix is compiled and tested in `player/queue-manager.js`;
   this Swift copy is not compiled by CI. Verify the two behaviours on device:
   skip to a part-heard episode and confirm it still resumes where you left it,
   and confirm prev-track restarts from zero rather than the current playhead.

10. **`.spokenAudio` audio session mode** dynamics processing on
   music-adjacent comedy/hang content — spec calls this mode out for
   podcasts generally, but verify it doesn't do anything undesirable on
   the "comfort" archetype's content.

## Test plan — mapping to M0's audio-choreography spike

`docs/brief/06_ROADMAP.md` M0 acceptance criteria: *"play a local mp3 →
hold-to-talk ducks + records + on-device STT → resume; survive a phone
call and a BT disconnect... no pops, no lost position, PTT round-trip <
1s, tested in my actual car."*

This scaffold gets you partway there — the state machine and its rules are
done and unit tested; the spike still needs the following manual, on-device
passes before M0 is actually closed out. None of this can be verified from
Windows.

| # | Test | What to check | Where the logic lives |
|---|------|----------------|------------------------|
| 1 | Cold build & run | `xcodegen` succeeds, app launches, Today shows 4 cards from the sample session | `project.yml`, `TodayView.swift` |
| 2 | `swift test` in `ios/ForayKit` | All tests pass with zero AVFoundation involved | `ForayKitTests/*` |
| 3 | Play a local file, no interruptions | Tap a card → audio starts within the 1.5s budget (04_VOICE_AUDIO_SPEC.md latency budget), no pop at start | `PlayerQueueManager.play(itemAt:)`, `AVPlayerBackend.load` |
| 4 | Skip mid-episode | Tap skip → next item's audio audible within 1s, exactly one `pausePlayback` + one `loadItem` (no overlap) | `PlayerQueueState.handleSkip`, `PlayerQueueStateTests.testFastDoubleSkipToNextReplacesInFlightLoadWithoutStackingLoads` |
| 5 | Fast double-skip | Tap skip twice in quick succession → only the second target ever becomes audible, no overlapping audio | Same as #4 |
| 6 | Phone call — declined | Call rings, decline immediately → playback resumes automatically, position exact | `handleInterruptionNotification`, `PlayerQueueStateTests.testDeclinedCall_...` |
| 7 | Phone call — answered, short | Answer, hang up quickly → app stays paused-but-ready (does NOT auto-resume), lock screen shows correct paused state, manual play resumes exactly | `PlayerQueueStateTests.testAnsweredCall_...` |
| 8 | Phone call — 20 minutes | Long call → session reactivates cleanly after, position still exact | AUDIT item 2 above |
| 9 | Bluetooth disconnect (car off) | Mid-playback, turn off car BT → playback pauses immediately, no dead air, position saved | `handleRouteChangeNotification`, `PlayerQueueStateTests.testRouteChangedOldDeviceUnavailableWhilePlayingPausesImmediately` |
| 10 | Bluetooth reconnect | Turn car back on within the auto-resume window → playback resumes only if this route was previously marked as a known car route | `maybeAutoResumeForKnownCarRoute` |
| 11 | Route change mid-TTS | Force a route change while a transition TTS is playing → pauses cleanly, never replays episode audio on resume | `PlayerQueueStateTests.testRouteChangedMidTTSTransitionPausesAndTracksUpcomingItem` |
| 12 | Background/lock screen | Lock the phone during playback → MPNowPlayingInfoCenter shows correct title/artist/elapsed time; play/pause/skip work from the lock screen | `updateNowPlayingInfo`, `configureRemoteCommands` |
| 13 | Kill app mid-episode, relaunch | Position restored exactly; airplane mode on during relaunch must still restore from local state before any network attempt | `restoreColdLaunchState` — **note:** currently only demonstrated with `loadQueue`'d items already in memory; wiring this to actual on-disk persisted queue/index/position state is not implemented (there's no local persistence store beyond `UserDefaultsPositionStore`'s per-item seconds) |
| 14 | TTS item rate | An episode with a non-1.0x per-show rate, followed by a transition TTS, followed by the next episode → TTS is audibly 1.0x regardless of the show's rate, and the next episode's rate is correctly restored after | `PlayerQueueStateTests.testItemLoadedForTTSResetsRateInsteadOfRestoring`, `.testItemEndedAfterTransitioningMovesToNextEpisodeAndRestoresRate` |
| 15 | Hold-to-talk PTT round trip | **Not testable yet** — VoiceController isn't implemented. Once built: press-to-release round trip < 1s, and specifically test hold-to-talk over car Bluetooth for the HFP/A2DP quality-drop trap (05_CORNER_CASES.md #24) | Not implemented — see "Not implemented" above |

Items 1–14 exercise code that exists in this scaffold. Item 15 is the one
piece of the M0 spike (`04_VOICE_AUDIO_SPEC.md`'s "bare screen with two
buttons" prototype) genuinely not started — hold-to-talk recording,
category switching to `.playAndRecord`, and `SFSpeechRecognizer` wiring
are all future work.
