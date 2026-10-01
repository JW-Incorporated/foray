# Hermes deck: the 4a iOS native playback engine (Tier 2, "full native engine") — revision 2

**Status:** plan for Hermes to cut into kanban cards. **M3 re-planned 2026-09-29** (§7 M3, §14 Track M3): M1 and M2 are on `main`, and M3 proceeds on provisional field values while the founder's drives wait. Revision 2 was written 2026-09-23 against `origin/main` @ `adde5e12`. It answers the 47-finding critique of revision 1, and §13 gives the disposition of every finding. Revision 1 was written the same day, after the founder picked Tier 2 of `docs/ios-native-player-gap.md` §4. Companion decks: `docs/ios-controls-and-voice-plan.md` (L-, V- and D-cards), `docs/bundled-voice-plan.md` (K-cards), and the requirements document written the same day (IDs A/S/Q/P/N/R/T/C/M/NP/D/W/J/V/L/DV/H, cited below). This deck's cards are **NE-** (native engine). A card suffixed `j` is JavaScript only, runs on Windows and auto-merges. A card suffixed `s` is the Swift port that burns the same families down.

**Where it comes from.** Three architecture designs were written against the requirements and judged three times. The spine is the **risk-first** design, which two of the three judges picked. Its first TestFlight build is the car test. It extends `foray-audio`, so that one module owns `MPRemoteCommandCenter` and the audio session. It uses two AVPlayer decks, and it is the only design that names silent-gap suspension. Grafted in, and named where each lands:
- **From the contract-first design:** the mode is decided before any target is registered; a crash-loop guard (now based on a sentinel); a one-way handover per process; an explicit `lostToInterruption` session state; snapshot extrapolation from the page's own receipt time; continuation hops precomputed in JS; facades plus a JS reference engine; and three multiplexed bridge methods on the existing plugin.
- **From the parity-first design:** the recorder with `--check`; the coverage guard; burn-down-only pending lists tied to the capabilities the engine advertises; the Linux `swift:5.10` parity job; click-track fixtures measured through `MTAudioProcessingTap`; and a check of the session after `AVSpeechSynthesizer` finishes (moved to the device in revision 2).

The rule that governs every card, from `CLAUDE.md`: **measured beats inferred.** Tags:
- **Measured:** taken from the founder's record or from CI.
- **Read:** read from the code at `adde5e12`. "Read (verified)" means it was re-checked while this revision was written.
- **Documented:** an Apple document says so.
- **Assumed:** not verified. Every Assumed item names the card or device test that checks it.

---

## 0. The decision, verbatim

Founder (Wyatt), 2026-09-23, choosing from three priced options after reading the field record in §1:

> "Full native engine"

That is Tier 2. On iOS the native plugin owns playback: the queue, Foray segments, out-points and seams, narration, positions, remote commands, Now Playing and the audio session. The web page becomes a remote control and a view. The orchestrator's scope defaults: iOS goes first; Android and the website keep today's JS player until iOS has been proven on the founder's phone; behaviour parity is enforced by shared fixtures that the Swift engine must pass.

## 1. Why: the field record

> **Addendum 2026-09-24 — the HA #108 baseline (`docs/field-records/2026-09-24-car-baseline.md`).** On build 2026092429 the app-process `.playback` hold SUCCEEDED (activated in the foreground) and was held and re-asserted for 8 minutes while paused and locked — and the car still chose Spotify on connect. A held session is not sufficient; iOS returns the car to the app whose audio last PLAYED, which for 4a was WebKit's media process. So NE-16's hold must be the session the engine's own playback ran through, and NE-27's car test is judged against this record: (1) paused in the app, locked, car connects → 4a resumes; (2) paused from the car, long pause, play → 4a resumes and stays.

Source: the founder's diagnostics, build 2026092327, iPhone, in the car, 2026-09-23/24 (**Measured**).

| # | What the record shows | Mechanism | Fixed in |
|---|---|---|---|
| FR-1 | `session audio sessionActivated (failed) hidden=y` each time the plugin tried to hold `.playback` while backgrounded. After a long pause, the car's play went to Spotify. | Activating a non-mixable session from the background is refused (**Documented**). Today's hold starts at pause time (`ForayAudioPlugin.swift:594-607`, **Read**). | **M1**: the session is activated by the user's play and held through pause, under `pauseHoldPolicy` (§4.4). |
| FR-2 | In the foreground the hold succeeds, but every play is followed by `interruptionBegan (began-while-held)`. | Two processes and two sessions. | **M1** for episodes, **M2** for Forays. |
| FR-3 | `remote play -> play from webkit handled=y` five times in 4 s, with no sound. | A paused, backgrounded WebKit element cannot restart. | **M1**: the car's play goes to the engine, and the engine holds a background task until audio is confirmed (§4.4 BackgroundGrace, now M1). |
| FR-4 | After a call, iOS had no 4a session to resume, so Spotify resumed. | Nothing in the app process owned the interruption. | **M1**: the engine owns interruptions (S-6). |
| FR-5 | `stop element pausedUnexpectedly hiddenFor 1202936ms`. | WebView media is not the app's own background audio. | **M1/M2**. Every stop gets a cause row (D-5). |
| FR-6 | Lock screen and car showed "4a / Unknown / Unknown". | WebKit publishes its own Now Playing client. | **M1/M2**. |
| FR-7 | An authored 2.0 s seam measured 9,153 ms while hidden. | WebView loads are throttled by visibility. | **M2**: standby deck prepare and preroll. |
| FR-8 | A hidden page is suspended after about 26 s. | The page, and the queue with it, is descheduled. | **M1/M2**: the engine advances with no page. BackgroundGrace covers every silence while playback is intended, from M1. |

## 2. What is measured, read and assumed

**Read (verified in this revision):**
- `setActive(` occurs at **four** legacy sites: `ForayAudioPlugin.swift:599` and `:614`, and `ForayTtsPlugin.swift:648` and `:789`. `setCategory(` occurs at **three**: `ForayAudioPlugin.swift:598` (mode `.default`), and `ForayTtsPlugin.swift:647` and `:788` (mode `.spokenAudio`).
- `foray-tts` is a separate SwiftPM package. It cannot see a type in `foray-audio`.
- `ios/ForayKit/Package.swift` declares only `.iOS(.v17)`. `ios/App/ForayApp.swift` references `PlayerQueueManager`. Moving the reducer out of `ios/` is therefore not free (§4.1).
- The iOS shell is generated (`cap add ios`) in CI. `inject-background-audio.mjs <Info.plist>` already runs, with `--check`, in both `ios-build.yml:276-309` and `.github/actions/ios-archive/action.yml:110-120`, and in `ios-build` it runs after `cap add`/`cap sync`.
- `ci.yml` `ios-kit` has `if: github.event_name != 'workflow_dispatch'` and is not a required check.
- `tools/ci/path-policy.mjs:65` denies `docs/DECISIONS.md`. `mobile/`, `player/`, `tools/`, `test/`, `docs/` (other files) and `app.js` auto-merge. `ios/` is unlisted and needs a human merge. `.github/` and `tools/ci/` need `founder-approved`.
- Top-level `test(` counts: `queue-state` 58, `queue-manager` 144, `media-session` 152, `foray-progress` 59, `html-audio-backend` 112, `tts-bridge` 29, `foray-playback` 91, `transport-reconcile` 80, `playback-rate` 22, `seam-gap` 17, `interlude` 16, `seek-policy` 33. Cards never type these counts: the recorder computes them (NE-03).

**Read (by the reviewers; the owning card re-checks):**
- `durable-store.js` hydrates every `cp_` key, then `_migrateUp()` pushes local copies down into Preferences (UserDefaults `CapacitorStorage.*`). `isNewer()` returns false when either row is undated (NE-23).
- `RESTART_WINDOW_SEC` and `SEEK_INSIDE_END_SEC` are private to `client.js`, and `POSITION_INTERVAL_MS` is private to `queue-manager.js`. `DRIFT_TOLERANCE_SEC` is exported twice, as 1 (`foray-progress.js`) and as 30 (`seek-policy.js`) (NE-04, NE-08).
- `planAfterEnded`/`nextAfterEnded` read and mutate `app.js` globals. Skip-next exists regardless of `autoAdvanceOn()`. The "Continuous playback" toggle never calls `refreshEpisodeNavigation` (NE-13).
- `episode-progress.js` `SNAPSHOT_FIELDS` is `[id, title, show, artwork_url, audio_url, duration_min, duration_sec]` (NE-10j).
- `PositionStore.onSave` emits a `position` cp_event about once a minute (NE-14).
- `default-voice.js` holds the founder's 2026-09-10 Samantha ruling (NE-33).
- `release-trigger.yml` ships `main` every 2 h when a release-relevant commit lands (§12).
- `data/forays.json`: 7 Forays, 157 script-only narration items, 0 rendered. M2 therefore carries narration.

**Assumed, each owned by a card or device test:**

| Assumption | Checked by |
|---|---|
| A nested `.package(path: "foray-engine-core")` resolves through `cap sync` and npm's `file:` symlink, and adding it leaves the `ForayAudio`/`ForayTts` scheme names unchanged | NE-01 (`xcodebuild -list` before and after) |
| `@capacitor/preferences` stores iOS keys as `CapacitorStorage.<key>` | NE-01 |
| In `ios-archive`, `inject-background-audio.mjs` runs after `cap sync`, so `AppDelegate.swift` exists beside `Info.plist` | NE-17 and NE-24 (`--check` log of an archive run) |
| A `UserDefaults` volatile domain set by `foray-audio` is readable by `foray-tts` in the same process | NE-16 XCTest |
| Holding the paused session is needed to keep 4a as the car's target | H-1 against H-1b (§7 M1) |
| A remote play can activate after an interruption that ended without `shouldResume` | H-3 / DV-3 |
| `MPRemoteCommandCenter` handlers are delivered on main | NE-18 thread-check row on the device |
| Returning `.commandFailed`/`.noActionableNowPlayingItem` does not cost 4a the Now Playing slot | H-1 step 6 |
| A background-launch remote play completes inside a background task | NE-16g rows, H-1, DV-7a |
| iOS does not suspend the app during a seam while a background task is held | H-2 `grace=` rows |
| `AVSpeechSynthesizer` (application session) leaves the session usable after `didFinish` | **DV-9 in the M1 TestFlight** via the Developer session probe (NE-25c). The Simulator result is smoke only. |
| `forwardPlaybackEndTime` never stops early | NE-25a, NE-32 |
| Apple Maps prompts interrupt `.spokenAudio` and end with `shouldResume` | the navigation arm of the M1 drive |
| `appWasSuspended` began-notifications arrive late for a suspended app | `session kind=interruption reason=` rows |
| iOS relaunches a *system-terminated* 4a for a car's play | DV-7a |
| iOS never delivers one press twice | `dupCandidate` rows, DV-6 |

## 3. Requirements this deck satisfies

| Topic | Ruling |
|---|---|
| Who owns what (A-1) | The engine owns queue, bounds, seam, interlude, narration, rate, positions, remote commands, Now Playing and the session. The page owns *decisions*: `buildForayQueue`, "Jump back in" math, continuation hops, voice choice (including `pickDefaultVoice`), and the UI. |
| One audio producer (A-2) | Native mode builds no `HtmlAudioBackend`, interlude element or `PlayerQueueManager`, writes no `navigator.mediaSession`, and never calls `ForayTts.speak` (audition goes through the engine). The page builds nothing audible until `engineModeReady` resolves. |
| Session (S-1..S-9) | Activation only on a user-caused play. **No audible start without an active session** is a core invariant with fixtures (§4.4). A pause does not deactivate under the default `pauseHoldPolicy = .forever`. A long-idle release is routed as OQ-12, because it amends S-4. |
| Parity (V-1..V-3) | JS is the reference. A rule change is JS, then re-record, then Swift. Through M2 a JS PR added new case ids to `swift-pending.json` automatically, and the Swift PR burned them down; NE-39s (M3) burned the list to nothing and deleted it, so since then the Swift port lands in the same change. Fixtures are read in place. |
| Continuation (C-2) | `planAfterEnded` is extracted into `player/continuation.js` but not ported to Swift. JS precomputes K = 8 hops plus `autoAdvance`, and the engine walks them. |
| De-dup (T-8) | Record `dupCandidate` without dropping anything; DV-6 decides. |
| Narration rate (R-4 / OQ-3) | 1x (founder, 2026-09-24): synthesized narration speaks at 1x whatever the listener's rate, as the JS reference does since `fix/narration-1x` (`NARRATION_RATE`). `narrationFollowsListenerRate = false`; the switch stays so "maybe we change later" is one flag. |
| Audition (OQ-5) | Always routed through the engine in native mode. Refused with `engine-busy` while running. While paused or idle, the engine's synthesizer speaks it after a `SessionPolicy` activation (a tap is user-caused). |

## 4. Architecture

### 4.1 Where the code lives

The engine **extends `mobile/plugins/foray-audio`**. `MPRemoteCommandCenter` and `AVAudioSession` are process-wide singletons, and one module owning both arbitrates ownership by construction.

```
mobile/plugins/foray-audio/
  Package.swift                     + .package(path: "foray-engine-core")
  foray-engine-core/                PURE SwiftPM package: Foundation only; iOS 15, macOS 12, Linux
    Package.swift                   products: ForayEngineCore, ForayEngineParity
    Sources/ForayEngineCore/
      Reducer/PlayerQueueState.swift   COPIED from ios/ForayKit @ adde5e12 (header names the commit), extended to JS parity
      EngineConstants.swift            GENERATED, namespaced by source module (SeekPolicy.driftToleranceSec, ForayProgress.driftToleranceSec, ...)
      Engine/EngineCore.swift          handle(_ input:, now:) -> [EngineCommand]
      Engine/EngineInput, EngineCommand, EngineState, Snapshot
      Policy/SeamGap, Interlude, SeekPolicy, DeckPolicy, PlaybackRate, ForayClock, TransportPolicy,
             ResumeRules, SessionPolicy, EngineMode, SpeechRules, MediaMapping
      Persist/Rows.swift, JSWriter.swift
      Diag/DiagRow.swift, Vocabulary.swift
    Sources/ForayEngineParity/      decode + run + compare -> results as data; NO XCTest import
    Tests/ForayEngineCoreTests/     thin XCTest wrappers over ForayEngineParity + the 34 copied reducer tests
  ios/Sources/ForayAudioPlugin/
    ForayAudioPlugin.swift          bridge: engineHello / engineSend / engineRead (iOS only)
    EngineModeFlag.swift            ~10 lines; BYTE-IDENTICAL copy in foray-tts (node test)
    Engine/ForayEngine.swift        @MainActor host; interprets EngineCommand through the seams below
    Engine/Seams.swift              SessionControlling, BackgroundTasking, RemoteCommandRegistering,
                                    NowPlayingWriting, DeckDriving, Speaking (each with a recording fake)
    Engine/EngineOwnership.swift    decideOnce(), sentinel, strikes, sticky legacy, relinquish
    Engine/AVDeck, DeckPair, AssetCache, AudioSessionOwner, RemoteSurface, NowPlayingPublisher,
           ArtworkCache, SpeechNarrator (M1: PreviewSpeaker seed), InterludePlayer, BackgroundGrace,
           EngineStore, EngineDiagnostics, SessionProbe (Developer only)
  ios/Tests/ForayAudioPluginTests/  existing target; + adapter tests over the fakes, + thin parity wrappers
mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/EngineModeFlag.swift   the byte-identical copy
player/engine-contract.js           PROTOCOL, names, OWNED_PREFIXES, decideMode, validate, extrapolate
player/native-engine.js, native-facades.js, reference-engine.js (warm handover ON under fakes)
player/transport-policy.js, player/continuation.js      extracted pure rules
player/parity/                      fixtures, schema, runner, recorder, coverage guard (§6)
mobile/ENGINE_DEFAULT.json          per platform since A-20: {"ios": {"mode": "js"|"native", "capabilities": [...]}, "android": {...}}
tools/mobile/inject-background-audio.mjs   + writes ForayEngineDefault/Capabilities and patches AppDelegate
tools/mobile/engine-report.mjs      turns a Copy paste into DV verdicts and a seam distribution
tools/parity/record.mjs, gen-constants.mjs
```

- **The directory is `foray-engine-core`, not `core`.** A path dependency takes its identity from the last path component, and `core` is too generic.
- **The reducer is copied, not moved.** `ios/` is a dead SwiftUI scaffold that ships nowhere. Moving the reducer breaks `ForayApp.swift`, and it breaks ForayKit's host `swift test` (ForayKit is iOS 17 only, the core targets macOS 12). It would also put a human merge (G-2) on the critical path. The copy's header names the source commit. An optional M4 card (NE-44) freezes or deletes the scaffold.
- **The parity engine is a library, not a test file.** SwiftPM tests cannot share sources across packages, so `ForayEngineParity` returns results as data. Thin XCTest wrappers in both `foray-engine-core/Tests` (Linux and macOS `swift test`) and `ForayAudioPluginTests` (the existing `xcodebuild test -scheme ForayAudio` step) run it. That gives a real zero-`.github` fallback.
- **Three bridge methods on the existing plugin.** New commands never need a new `CAPPluginMethod`. Android gains the same three, speaking the same protocol v1, when its Media3 engine lands (card A-28 of `docs/plans/android-assessment.md`, track A1). Until then the page does not ask an Android shell (`HELLO_PLATFORMS` in `player/engine-contract.js`, A-20's flag), so Android's answer is `no-method`: the JS player, as always. `decideMode` already accepts `platform: "android"` with a protocol-1 hello (A-20), and `mobile/ENGINE_DEFAULT.json` holds an `android` block that stays `js` until A-31.

### 4.2 Runtime shape: a functional core and an imperative shell, confined to main

```
page (WKWebView; may be suspended, killed or reloaded)
  | engineSend {v, cmdSeq, cmd, args, source}  -> {ok, reason?, snapshot}   (never rejects)
  v                                            ^ "engine" events (best effort, latest wins, visible only)
ForayAudioPlugin (bridge)
  v
ForayEngine  @MainActor, one per process (A-4)
  core.handle(EngineInput) -> [EngineCommand]           pure, fixture-tested
  interpret through seams: DeckDriving(A,B) · Speaking · Interlude · SessionControlling · NowPlayingWriting
                           RemoteCommandRegistering · BackgroundTasking · EngineStore · EngineDiagnostics · timers
  observations (KVO, notifications on .main, delegates, timers, remote handlers) -> EngineInput
```

- **Main is the engine's serial queue.** Remote handlers call `ForayEngine.handle(.remote)` directly and return the core's verdict.
  - Apple does not document that handlers run on main. Each handler checks `Thread.isMainThread`. Off main, it writes a `remote thread=bg` row and runs through `DispatchQueue.main.sync` (no deadlock is possible, because the caller is not on main). On main it uses `MainActor.assumeIsolated`.
- **Activation is a request and a response inside one turn.**
  1. The core emits `sessionActivate` and stops.
  2. The interpreter calls the seam synchronously and feeds `sessionResult(ok|failed, token, activateMs)` straight back in.
  3. Only then does the core emit the audible command.

  A failed activation therefore produces `.commandFailed` and no audible command at all.
- **Observers** for session notifications use `addObserver(forName:object:queue: .main)`. Route changes are posted on a secondary thread, and the 500 ms route-attribution window relies on ordering on main.
- Artwork fetches and `asset.load(.duration)` run off-main and come back as inputs. Nothing on the playback path awaits the page.
- `activateMs` is logged in every `session` row. If the device p95 exceeds 100 ms, a follow-up adds the reserved `CommandGate`.

**Composite state:** the six reducer states plus:
- `currentIndex`/`targetIndex`, `loadToken`
- `overlay` (`.none | .seamBeat{…} | .narrating{…}`)
- `session` (`.inactive | .active | .lostToInterruption | .relinquished`)
- `rate`/`pendingRate`, `pendingSeek`
- `continuation{autoAdvance, hops}`, `advanceLog`, `pendingEvents`
- `decks{audible?, standby{index, token, stage}}`
- `grace` (`none | held(reason, since)`)

### 4.3 AVFoundation choices

- **Two `AVPlayer` decks, not `AVQueuePlayer`.** The next segment must sit seeked to its in-point and prerolled before the boundary (P-10). At most one deck is audible, and roles swap only after the outgoing deck confirms `.paused`. In M2 this sits behind `EngineConfig.deckPairEnabled` (off until NE-37).
- **Deck settings:** `actionAtItemEnd = .pause`, `automaticallyWaitsToMinimizeStalling = true`, `audioTimePitchAlgorithm = .timeDomain`. Rate: `defaultRate` on iOS 16+; on iOS 15, `playImmediately(atRate:)` or `rate`, re-applied on every play and swap.
- **Load pipeline, gated on readiness (P-1, P-8).**
  1. Create the item and attach it.
  2. Load the duration.
  3. The core runs the ADR-0007 gate (approximate means skip).
  4. **Wait for KVO `player.status == .readyToPlay` and `item.status == .readyToPlay`.**
  5. Seek to `start_sec` with zero tolerance.
  6. `preroll(atRate: 0)`, only while `rate == 0`.
  7. Emit `ready`.

  Calling `preroll` before `.readyToPlay` raises an uncatchable `NSInvalidArgumentException`. A static pin in `shell-invariants` therefore allows `preroll(` only inside the readiness-gated function. An interrupted seek or a `preroll` completing with `finished == false` is "not ready": retry once, then fall back to an ordinary load. `deckPlay` is legal only after `ready`.
- **Precise timing (P-7).** Provisional: precise for bounded segments and local files, approximate for unbounded episodes. NE-25a measures both on the Simulator; DV-5 repeats on real CDNs. A precise load that exceeds the deadline skips; it never falls back to approximate.
- **Out-point in three layers, never early (P-2).**
  1. `forwardPlaybackEndTime = end (+ stopPad)`.
  2. A boundary observer.
  3. A watchdog that is **armed only for the last ~1.5 s**: one `DispatchSourceTimer` at `(end − currentTime)/rate − 1.5 s`, re-armed on seek and rate change, polling at 250 ms only inside that window. This avoids about 12,000 main wakeups per 51-minute Foray (DV-11). The re-arm has a fixture in `deck`.

  The first layer to fire wins, per load token. Overshoot goes into the `outPoint` row.
- **Load deadline (P-13):** 20 s provisional (`// MEASURE:`), set in M3.
- **Stalls (P-14):** `waitingToPlayAtSpecifiedRate` → `buffering: true`.
- **Observe, don't believe (Q-9).** An uncommanded pause is handled in this order:
  1. within 500 ms of `.route(oldDeviceUnavailable)`, it is attributed to `routeChanged`;
  2. while interrupted, it is ignored;
  3. otherwise it becomes `stop cause=system-pause` plus a correction.
- **Implicit activation is a known hazard.** `AVPlayer.play()`, `AVAudioPlayer.play()` and an application-session synthesizer all activate an inactive session implicitly. Every audible primitive in the adapters checks `AudioSessionOwner.phase == .active`. If it is not, it writes a `fault implicit-activation` row, and in DEBUG it asserts (§4.4).

### 4.4 Audio session: one owner, and no audible start without it

`SessionPolicy.transition(phase, input) -> (phase, [action])` is pure and fixture-pinned (`session` family):

```
inactive           --userPlay(tap|remote|autoresume|auditionTap)--> active  [activate] fail: stay, token, .commandFailed, NO audible cmd
active             --pause|beat|narration|background-->   active            [] (S-4; pauseHoldPolicy .forever by default)
active             --holdExpired (policy .until(m) only)--> inactive        [deactivate(no notify)]; Now Playing kept
active             --interruptionBegan(default|unknown)-->  lostToInterruption []
any                --interruptionBegan(builtInMicMuted)-->  unchanged         [] + row
not running        --interruptionBegan(appWasSuspended)--> lostToInterruption [] (no stop row: it is not a stop)
activated in this process & running --began(appWasSuspended)--> unchanged  [] + `stale=y` row
lostToInterruption --ended(shouldResume) & wasPlaying-->  active            [activate] + resume (see below)
lostToInterruption --ended(no shouldResume)-->            inactive          [] keep Now Playing and targets (NP-9)
lostToInterruption|inactive --remotePlay|tapPlay-->       active            [activate once] (S-5)
*                  --mediaServicesReset-->                inactive          [re-apply category; rebuild] -> interrupted(wasPlaying:false)
active|inactive    --relinquish-->                        relinquished      [] NO deactivate, NO notify (terminal; §4.6)
active             --close|finalEnd|dataDeletion-->       inactive          [deactivate(.notifyOthersOnDeactivation)]
```

- **The audible-start invariant** has its own `session-invariant` family. In every `handle()` output, each `deckPlay`, `speak`, `interludeStart` or `silenceStart` must come after either `session == .active` at entry or a successful `sessionResult` in the same turn.
  - Mutation cases: emit `deckPlay` in `lostToInterruption`, and a case goes red. The same holds for an autoadvance hop, a reconcile correction, and a seam timer tail after an interruption.
- **Resume after an interruption with `shouldResume`:** when the item is healthy (`item.status == .readyToPlay`, no error), call `play()` on the existing item after a rewind of `INTERRUPTION_REWIND_SEC = 1.5`. This is authored, lands JS-first in `transport-policy.js`, and the PR flags that the web and Android interruption path changes by the same amount. The `loadingItem` rebuild runs only for a failed item. Navigation prompts therefore cost no network round trip.
- **Category** is `.playback`, mode `.spokenAudio`, no options. `.spokenAudio` is kept deliberately (Apple's podcast guidance); prompts interrupt and then resume. `.longFormAudio` sits behind an off flag until DV-8.
- **`pauseHoldPolicy`** is `.forever | .until(minutes) | .none`, set through a Developer row and recorded in the `build` row. The default is `.forever`, which meets S-4 as written. Every `session` row logs `secondaryAudioShouldBeSilencedHint`, so the side effect of holding (other apps muting) is on record.
  - The M1 drive runs an H-1b arm with `.none`: the session is released without notify at pause, and Now Playing is kept.
  - OQ-12 (G-5) then decides from the rows whether to keep `.forever` or add a long-idle release (for example 60 min).
- **Session ownership is split from mode (legacy guards).**
  - `EngineModeFlag.sessionOwnedByEngine` lives in the `UserDefaults` volatile domain `ai.jwlabs.foura.engine`. It is process-scoped and never persisted.
  - `decideOnce()` sets it true in native mode. Relinquish flips it to false, one way.
  - `foray-tts` reads it through its byte-identical `EngineModeFlag.swift`, so no cross-package dependency is needed. A node test checks the two copies are identical.
  - All four `setActive` sites and all three `setCategory` sites are guarded on it. After a relinquish, the legacy hold and ForayTts behave exactly as build 2026092327.
  - The `shell-invariants` pin names the seven guarded sites plus `AudioSessionOwner.swift`, and fails on any other occurrence.
- **Error tokens:** `cannot-interrupt-others`, `cannot-start-playing`, `other`. Interruption `reason` vocabulary: `default`, `appWasSuspended`, `builtInMicMuted`, `unknown`.

**BackgroundGrace (M1; revision 1 had it in M2).** `UIBackgroundModes: audio` keeps the app alive only while audio renders. BackgroundGrace is a core-level span, *silent while intending to play*.
- **It begins** on any running intent that is not yet audible: a remote play, a tap play while backgrounded, an interruption resume, a route resume, a cold play, a seam beat, a narration handover, or a prepare miss.
- **It ends** on the first confirmed `timeControlStatus == .playing`, or at idle.
- **Every `beginBackgroundTask` has an expiration handler.** The handler ends the task, writes `grace expired`, and applies a deterministic outcome: pause, with `stop cause=grace-expired`.
- If `backgroundTimeRemaining` is already small, or the begin returns `.invalid`, that is written to the row.
- `grace=` and `bgRemainingMs` appear in the `remote`, `resume` and `seam` rows.
- Headless tests go through the `BackgroundTasking` fake. The real numbers come from the device.

**The silence fallback (flag, off by default).**
- An `AVAudioEngine` source node renders digital silence. It is timing only and never uses enclosure bytes (L-3).
- It is **hard-capped at `INTERLUDE_CEILING_SEC` (4.5 s) from the out-point**, whatever the load does. After the cap, only the grace task covers the gap.
- A fixture asserts it never runs when `state != running` or `session != active`, and a Simulator test asserts the cap.
- The audible interlude (real user-facing content) is preferred as a bridge.
- The flag is enabled only if H-2 rows show a suspension. The NE-37 HUMAN-ACTIONS item carries an App Review note stating what the audio background mode plays (guideline 2.5.4).

### 4.5 Now Playing and remote commands

- **`RemoteSurface`** is the only registrant in native mode (through `RemoteCommandRegistering`).
  - It registers play, pause, toggle, next/previous, `skipBackward [15]`, `skipForward [30]` (both from `EngineConstants`) and `changePlaybackPosition`. `stopCommand` is registered and disabled; a remote stop is a pause (T-7).
  - **In a Foray, both skips and `changePlaybackPosition` are on the Foray's clock**, exactly as the page's own `seekBy` / `seekTo` commands are (`EngineCore.seekBy` / `seekTo` route to `forayNudge` / `forayScrub` first). Inside the spoken line sounding, back says it again and forward goes on past it (`nudgeAction`); a scrub into it restarts it; a rendered line in `transitioning` is re-entered at the offset, because the reducer refuses a seek there (`scrubTarget`). M2 drive 2026-10-01 found the car's skips going to the episode seek and refused inside every line; `manager-foray/narration-skip-*` and `ForayNarrationSkipTests` pin it.
  - Every `remote` row records the command, the returned status, `route=<portType>` (`carAudio`, `bluetoothA2DP`, ...), `dupCandidate`, `grace=` and the thread.
- **`NowPlayingPublisher`** writes the `MediaMapping` output at every transition and every seek.
  - `PlaybackRate` is the true rate while playing, and 0 while paused or interrupted. `playbackState` is never used.
  - Nothing is cleared on a pause or an unresumed interruption, and on relinquish the entry is left for the legacy lane to overwrite. `nil` happens only on a finished Foray, close or data deletion.
- **Artwork:** https or the bundled icon, off-main, bounded at 10 s, cached; on failure the key is dropped. Narration never shows a publisher's artwork.
- **Cold path (A-8, M-9, M1).**
  - The restore record is engine-private (§4.6): `{v, mode, queue[], index, offsetSec, forayId?, rate, voiceId?, advanceLog, pendingEvents, updated_at, build}`.
  - `inject-background-audio.mjs` (already invoked in both CI paths) gains the AppDelegate patch. It calls `ForayEngine.shared.bootIfNeeded()` from `didFinishLaunching`, is idempotent, and is checked by `--check`. Targets therefore exist even when the bridge never loads.
  - Now Playing is painted at rate 0 **without activation** (S-3). A cold play loads, activates once, holds grace, and plays.
  - With no record, or a `mode: "relinquished"` record, the play returns `.noActionableNowPlayingItem`.

### 4.6 Mode, fallback, storage ownership and the founder's daily use

- **`EngineOwnership.decideOnce()`** is a lazily initialised static.
  - Whichever of `bootIfNeeded` (AppDelegate) and `ForayAudioPlugin.load()` runs first computes the mode. The other reads it. There is one strike accounting per process, pinned by an XCTest.
  - Inputs: `buildDefault` (Info.plist `ForayEngineDefault`; **absent → `js`, `reason=no-plist-key`**, a fixture), `override`, `strikes`, `stickyLegacy`, `built`.
- **Engine-private keys live outside `CapacitorStorage.`**, so DurableStore never sees them:
  - `UserDefaults` keys `ForayEngine.modeOverride`, `.strikes`, `.sentinel`, `.stickyLegacyBuild`, `.restore` and `.holdPolicy`
  - the diagnostics ring, which is a file (`Application Support/foray-engine/diag.jsonl`)

  They are reachable from the page only through `engineRead`/`engineSend`. The Developer control writes the override through `engineSend setModeOverride`, which writes `UserDefaults` synchronously (no async write-behind, no JSON-string parsing).
- **Crash-loop guard (sentinel, not counter).**
  - `ForayEngine.sentinel = <launchId>` is written before native boot. It is cleared by the healthy marker, whichever comes first:
    - the first successfully handled input
    - 5 s of the main run loop after boot
    - `willResignActive` or `didEnterBackground`
    - the first confirmed `.playing`
  - At the next launch, a strike is added **only if the previous sentinel is still set**. A healthy marker resets strikes to 0.
  - A **page-health strike** is added when no `engineHello` arrives within 10 s of a foreground page load.
  - At 3 strikes the process runs legacy with `mode reason=crash-loop`, and legacy stays **sticky until `CFBundleVersion` changes**, which prevents oscillation. Changing the Developer engine setting clears strikes and the sticky flag.
  - Fixture: three background launches with clean sentinels give `strikes = 0`.
  - If the page itself is broken, the escape is **TestFlight → Previous Builds**, named in every script.
- **Legacy mode:** today's `load()` registration runs unchanged.
- **Native mode:** that registration is deferred, and `RemoteSurface` registers instead.
- **One-way relinquish per process** (M1 Foray taps, and a failed hello with `cap:'all'`).
  - **Native side:**
    1. Stop with persistence.
    2. **Keep the session active, with no deactivate and no `notifyOthers`**, so no app that 4a interrupted is invited back.
    3. Flip `sessionOwnedByEngine` to false.
    4. Leave Now Playing for the legacy lane to overwrite.
    5. Remove the engine's targets, **tear down every observer, KVO, timer and grace task**, and enter the terminal `.relinquished` state, in which `handle()` returns `[]`.
    6. Write the restore record as `{mode:"relinquished"}`.
    7. Run the legacy registration and write `mode reason=downgrade cap=<cap>`.

    XCTest: synthetic interruption-ended, route and reset notifications posted after relinquish produce zero engine commands and zero `setActive` calls.
  - **Page side, in order:**
    1. Await `relinquish`.
    2. Call `engineRead("rows", OWNED_PREFIXES)` and `adoptExternal`.
    3. `storage.releaseOwnership()`.
    4. Set `engineMode = "js"`, which turns the JS branches of `persistForayProgress`, `flushPositions` and `syncMediaSession` back on.
    5. `ensureJsBooted()`.
  - The M1 price is that after a Foray, episodes play the old way until the next launch.
- **Page boot order.** On the iOS shell, `ensureBooted` and every restore path (`restoreLastEpisode`, `restoreForay`, and position flushes) await `engineModeReady`, bounded at 5 s.
  - On a timeout, a rejection or a protocol mismatch, the page sends `relinquish{cap:"all"}` and runs JS.
  - Native watchdog: if no hello arrives within 15 s of the WebView finishing its load while the engine is idle, the engine relinquishes by itself, so a JS page never runs without the legacy remote surface.
  - In M1, `restoreForay` paints from `cp_foray` only; the tap relinquishes.
- **DurableStore ownership from construction.**
  - On the iOS shell, DurableStore treats `OWNED_PREFIXES` (`cp_pos:`, `cp_foray:`, `cp_last_episode`, from `engine-contract.js`) as *deferred* from the moment it is constructed. It reads them, but never pushes them down (`_migrateUp`), never queues Preferences writes for them, and never mirrors them into localStorage or IDB until the mode is known.
  - hello = native → `externallyOwned` for the process. On attach, the page **replaces its set for those prefixes** with `engineRead("rows")`; a key absent natively is deleted from memory.
  - hello = legacy/js, or relinquish → release, and the deferred migration runs.
- **Build default.** `ENGINE_DEFAULT.json` stays `js` until NE-27. NE-27 flips it only after G-1b and the G-5 answer to OQ-9.
- **Positions survive switching engines.** Both engines write `cp_pos:*`, `cp_foray:*` and `cp_last_episode` identically (`cp_last_episode` is built by the page with `makeLastEpisode` and stored verbatim, §5.2), and DurableStore's deferral keeps a stale page from clobbering them.
- Every Copy report starts with `engine=native v<ver> proto=1 caps=<list> reason=<r> strikes=<n> hold=<policy> build=<CFBundleVersion> | web=<build-stamp>`.

## 5. The web ↔ native contract (protocol v1)

### 5.1 Transport

These methods exist on iOS only. They always resolve and never reject:

| Method | Payload | Returns |
|---|---|---|
| `engineHello` | `{pageBuild, protocol: 1}` | `{mode, reason, engineVersion, protocol, capabilities[], ownedKeyPrefixes[], snapshot, pendingAdvances[], pendingEvents[]}` |
| `engineSend` | `{v: 1, cmdSeq, cmd, args, source, issuedAtWallMs}` | `{ok, reason?, snapshot}` |
| `engineRead` | `{what: "snapshot"\|"rows"\|"diagnostics", prefixes?}` | the snapshot, `{rows}`, or `{rows: [DiagRow]}` |

One JSON Schema (`player/parity/schema/engine-contract.schema.json`) serves both sides, through the `contract` family.

### 5.2 Commands (W-2)

| `cmd` | `args` | Notes |
|---|---|---|
| `playEpisode` | `{item, startSec?, moved?, lastEpisodeRow}` | `lastEpisodeRow = makeLastEpisode(item)` without `updated_at`. The engine stores it verbatim plus `updated_at`. |
| `playForay` | `{forayId, title, items[], buildReport, startElapsedSec?, isLocalFile, allowAdPad, voiceId}` | M2. The engine re-validates structure (J-4). |
| `setContinuation` | `{planSeq, autoAdvance, chain: [Hop], previous?: Hop}` | Each hop carries `lastEpisodeRow`. |
| `play` `pause` `toggle` `next` `previous` | none | Intents (W-3, T-2) |
| `seekBy` `seekTo` `jump` | | |
| `stop {persist}` | | `persist: false` is data deletion |
| `setRate` `setVoice` `setInterludeEnabled` | | The page still writes `cp_rate` |
| `setPageVisible {visible}` | | Gates events |
| `ackAdvances {upToSeq}` `ackEvents {upToSeq}` `restoreBar` `purge` `relinquish {cap}` `audition {text, voiceId}` `setModeOverride {mode}` `setHoldPolicy {policy}` `probeSession` | | `probeSession` is Developer only (NE-25c) |

Reason tokens: `not-loaded`, `no-next`, `no-previous`, `ended`, `refused-structure`, `capability-off`, `session-failed:<token>`, `engine-busy`, `relinquished`, `unknown-cmd`. `source` is recorded before any no-op return (D-4).

### 5.3 Snapshot v1

```
{ v:1, seq, capturedAtWallMs, capturedAtMonotonicMs,
  mode: "none"|"episode"|"foray", forayId?, index?, itemId?, itemKind?,
  state, wasPlaying?, running, inSeamGap, inInterlude, buffering, ended,
  positionSec, durationSec, sourceTimeSec, playheadItemId, isNarrationPlayhead, narrationElapsedSec?,
  rate, effectiveRate, canNext, canPrevious, autoAdvance,
  lastError?, voiceFallback?, skippedSegments, pendingAdvances, pendingEvents,
  session: "inactive"|"active"|"lostToInterruption"|"relinquished", holdPolicy,
  nowPlaying: {title, artist, album} }
```

### 5.4 Events, and why a stale page is harmless

- **Events:**
  - `snapshot` on every transition, coalesced to at most 1 Hz, only while the page is visible;
  - `advanced`, `skipped`, `error`, `voiceFallback`, `diag` and `modeChanged`.
- **Delivery is best effort.** Visible, `pageshow` and resume each trigger `engineRead("snapshot")`.
- **Extrapolation** uses the page's own receipt time: `pos = positionSec + effectiveRate × (now − receivedAtMs)/1000`, clamped, and frozen while `inSeamGap || buffering || !running`.
- **Commands are intents** (W-7).
- **Attach, don't restore (W-8).**

### 5.5 Continuous playback (C-1..C-6)

- NE-13 first extracts `planAfterEnded`, `nextAfterEnded` and `continuationChain` into `player/continuation.js` as pure functions over an injected `{queue, playList, playChainId, playListCursor, isPlayable}`. `app.js` delegates to them.
- **`setContinuation` carries `autoAdvance`** (`cp_autoadvance`) and `chain`.
  - At an episode end, the engine walks the chain only if `autoAdvance` is true.
  - **`canNext` = the chain is non-empty, regardless of `autoAdvance`**, which matches `EPISODE_NAVIGATION.next` today.
  - The Continuous playback toggle now calls `refreshEpisodeNavigation`, so the engine sees changes while playing.
- **Walking hops:**
  - The engine persists each hop into `advanceLog`.
  - An exhausted chain writes a row.
  - A failed chained start emits `error{code:"chain-start"}` (C-6).
- **Page side of an advance:** on attach, the page applies unacked hops through `applyEngineAdvance(hop)`, which is idempotent via the page-owned `cp_engine_applied` watermark written before `logEvent`. The page then acks.
- **Position events (restored in revision 2).** The engine appends `{kind:"position", episode_id, seconds, duration, at}` to a bounded `pendingEvents` log, using the once-a-minute `PositionStore.onSave` rule (a `resume-rules` fixture). On attach, the page drains the log through `logEvent` with the original timestamps and acks it. The event type is unchanged, so the privacy disclosure is unchanged.

### 5.6 The page side: facades, not a rewrite

- `NativeManagerFacade` and `NativeBackendFacade` implement exactly the surface `client.js` reads today.
- `reference-engine.js` puts protocol v1 over the real `PlayerQueueManager` plus fakes, **with warm handover on**, so a JS path to prepare/preroll behaviour exists (§6).
- `client.js` native edits, guarded by `engineMode === "native"` and gated on `engineModeReady`:
  - no backend, interlude element or manager is built;
  - transport entry points send intents;
  - `syncMediaSession` returns early, and the `foray-media-session.js` iOS install is skipped;
  - position saves are no-ops for owned keys;
  - `reconcileOnReturn` becomes `attach(why)`;
  - audition goes through `engineSend audition`;
  - diagnostics merge the engine ring.
- DurableStore: see §4.6.

## 6. Parity-fixture strategy

**The rule.** JS is the reference and fixtures are the contract. A behaviour change is a JS change plus a re-record in a JS PR, which **adds the affected ids to `swift-pending.json` tagged with the port card**, followed by a Swift PR that burns them down. The capability gate (step 6) stops an advertised capability from shipping with anything pending.

**Since NE-39s (M3) nothing can be owed.** NE-39s burned `swift-pending.json` and `unported.json` to nothing and deleted them. `coverage.test.js` requires both absent, `record.mjs --check` is red on either, and the Swift loader refuses to run on either. So a behaviour change is now one change: the JS, the re-record and the Swift port. `record.mjs` refuses `--port-card` and `--classify`, and engine-parity is red on a re-recorded case until its port lands. A rule that exists only because the JS manager awaits (a load parked on a bridge round trip) is recorded into a `jsOnly` family, as `manager-await` is, and its native form is an XCTest named in the case's note. `jvm-pending.json` stays: it is Android's book, and A-63 retires it.

1. **Layout.** Under `player/parity/`:
   - `schema/`
   - `fixtures/<family>/*.json`
   - `manifest.json`, recorded
   - `exclusions.json`, closed reasons: `webview-only`, `dom-only`, `text-pin`, `js-module-shape`
   - `unported.json`, JS tests that have no fixture or XCTest yet, each tagged with a card; burn-down only. **Deleted by NE-39s.**
   - `swift-pending.json`, burn-down only. **Deleted by NE-39s.**
   - `jvm-pending.json`, burn-down only: the Android JVM port's books (A-22, `docs/plans/android-assessment.md` §5.4). A family the JVM does not run is owed whole, a family it runs is listed in `runs`, and `--check` holds every recorded family to exactly one of the two; `record.mjs --jvm-card` hands a case new in a family it runs, or a new family, to an Android card. Rules in `player/parity/jvm-pending.js`.
   - `capabilities.json`
   - `floors.json`
2. **Case format.** Pure calls `{id, covers[], call, args, expect}`. Scenarios `{setup, steps[], expect}`, with the closed verbs `call`, `settle`, `clock`, `deck`, `tts`, `interlude`, `session`, `lifecycle`, `remote` and `checkpoint`. Macros `$seg`, `$ep`, `$tts`, `$foray`. The op-log grammar is unchanged. Native-only `n.*` tokens are stripped, **except in the `prepare` family, which asserts them**.
3. **JS runner and recorder.**
   - `record.mjs --check` runs in `npm test`.
   - `authored: true` cases are never overwritten. They cover the seam beat (0.5 s since the founder's 2026-09-24 ruling; `engine/m1`'s `seam-gap/rule-is-2.0s` still pins 2.0 s until the merge that brings the ruling in renames it, see `docs/DECISIONS.md` 2026-09-24), 15/30, 0.25 s inside-end, never-early, "4a is never the artist", `INTERRUPTION_REWIND_SEC`, and the prepare timing.
   - **Mutation smoke:** for a named set of rules (seam gap, never-early, 15/30, pause-silence), `record.mjs --mutate` flips the rule, and both the original JS test and its fixture must fail.
   - New suites (`position-store`, `transport-policy`, `continuation`) **read their fixtures**, so one file is both the JS assertion and the Swift case. Existing suites are not rewritten, because that would put hundreds of passing tests at risk.
4. **Swift runner.**
   - `ForayEngineParity` is a library, and thin XCTest wrappers run it on Linux, macOS `swift test` and `xcodebuild -scheme ForayAudio`.
   - It writes `parity-report.json`.
   - It fails if a manifest id was neither executed nor pending, or if a pending case passes.
5. **Coverage guard** (`coverage.test.js`, in `npm test`). Every top-level `test(...)` in the covered suites must appear in some case's `covers[]`, in an `xctest:<Class>/<method>` mapping, in `exclusions.json` or in `unported.json`.
   - **The guard greps the Swift test sources for every `xctest:` mapping**, so an unmapped or deleted XCTest turns it red.
   - Covered suites: `queue-state`, `seam-gap`, `interlude`, `seek-policy`, `playback-rate`, `foray-progress`, `media-session`, `transport-policy`, `position-store`, `continuation`, `queue-manager`, **plus `html-audio-backend`, `tts-bridge`, `foray-playback` and `transport-reconcile`**. These hold the rules that AVDeck, DeckPair, SpeechNarrator and the facades reimplement.
   - Their cases map to:
     - the `deck` family, which feeds `DeckEvent` in and checks `EngineCommand`/`DeckPolicy` ops out;
     - the `prepare` family;
     - named Simulator XCTests;
     - JS-only facade tests (for `transport-reconcile`, run against `reference-engine`).
6. **Capability gate.** `capabilities.json` requires zero `swift-pending` and zero `unported` entries for these families (both lists are deleted since NE-39s, so every family is either run by Swift whole or `jsOnly`; NE-39s also retired the unadvertised `remainder` gate and charged `manager-remainder` and `manager-await` to `foray`):

   | Capability | Families |
   |---|---|
   | `episode` | queue-state, rate, resume-rules, transport, rows, number-format, session, session-invariant, engine-mode, handshake, contract, snapshot, diag-tokens, media-episode, manager-episode, deck-episode |
   | `continuation` | continuation |
   | `restore` | rows, resume-rules, engine-mode |
   | `foray` | seam-gap, interlude, seek-policy, outpoint, foray-clock, foray-progress, foray-structure, media, manager-foray, deck, prepare, speech-rate, lexicon, default-voice |

   `coverage.test.js` parses the advertised list from `ENGINE_DEFAULT.json` and from the Swift source.
7. **Generated constants.** `gen-constants.mjs` imports the JS exports and namespaces them by source module. A test fails on a stale file and on any duplicate export name. `RESTART_WINDOW_SEC`, `SEEK_INSIDE_END_SEC` and `POSITION_INTERVAL_MS` are exported by NE-08 first. `vocabulary.json` holds the closed token sets. Since A-23 (`docs/plans/android-assessment.md` §5.4) it also writes `EngineConstants.java` and `Vocabulary.java` into the Android engine's JVM core (`foray-engine-core-jvm`), from the same exports, so the two native engines read one set of numbers.
8. **CI.**
   - **G-1a (requested on day 1):** `engine-parity` in `ci.yml` on `ubuntu-latest`, container `swift:5.10`, image cached. It runs on `push`, `pull_request` **and `workflow_dispatch`**, and is advisory. This is the only fast Swift loop the Windows agents have.
   - **G-1b (after about a week of green G-1a runs; a hard prerequisite of NE-27):**
     - make `engine-parity` required, with a step-level short-circuit to success when neither `player/parity/**`, the core package nor the generator changed;
     - add a required `ios-gate` job that runs on every event: success when no Swift path changed, otherwise it needs ios-kit green on the head SHA;
     - make release refuse to cut an iOS TestFlight from a SHA whose `engine-parity` or `ios-kit` is not green.
   - **Before G-1a:** the `ForayAudioPluginTests` wrapper runs parity inside the existing `ios-kit` step, which is the zero-`.github` fallback.

**Families** (the recorder computes case counts; the suite sizes shown are Read (verified)):

| Family | Source (suite size) | Milestone |
|---|---|---|
| queue-state | `queue-state` (58) | M1 |
| rate | `playback-rate` (22) | M1 |
| resume-rules, rows, number-format | `position-store` (new), `makeLastEpisode`, JSON.stringify | M1 |
| transport (episode) | `transport-policy` (new) | M1 |
| continuation | `continuation` (new), JS only | M1 |
| session, session-invariant, engine-mode, handshake, contract, snapshot, diag-tokens | new tables | M1 |
| media-episode | `media-session` (152; all classified in NE-12j) | M1 |
| manager-episode | `queue-manager` (144; episode scenarios) | M1 |
| deck-episode | `html-audio-backend` (112; same-source seek, deadline, never-early arithmetic, stop during recovery) | M1 |
| seam-gap, interlude, seek-policy + ladder + pad, outpoint | (17, 16, 33) + new | M2 |
| foray-clock, foray-progress (59), foray-structure, media (remainder) | | M2 |
| manager-foray, deck (remainder), prepare (authored), speech-rate, lexicon, default-voice | `queue-manager`, `html-audio-backend`, `tts-bridge` (29), `default-voice` | M2 |
| foray-playback mapping | `foray-playback` (91): real curated Forays end to end | M2 |
| manager remainder (about 70 scenarios) | `queue-manager` | M3 |

**Seams are compared at the audible level.** The `prepare` family asserts "audible start of item N+1 at time T with offset O". It is authored, because the JS warm handover is off by default. `reference-engine.js` turns the handover on, and the Swift `n.prepare:` tokens are asserted there rather than stripped.

## 7. Milestones

Every milestone ends in a TestFlight build and a written script. **Each script names one exact build number.** Step 0 asks the founder to:
- confirm the Copy header shows that build, `engine=native`, `strikes=0` and no `mode reason=downgrade`;
- turn off TestFlight automatic updates for the drive window.

Pastes go to **one GitHub issue per milestone**. `tools/mobile/engine-report.mjs` turns each paste into a DV verdict table.

In the car, there is **one Copy per test block, taken while parked**, never while driving. **A 10-minute desk pre-flight** comes first: lock screen, AirPods, Control Center, and the session probe. **H-3 calls are placed by a second person, or by FaceTime audio from another device.**

Provisional estimates (revised up from revision 1): **M1 about 6 weeks, M2 about 5, M3 about 3.** They are re-derived at the end of week 2 from the PR loop times NE-01..NE-05 measure. At most two Swift PRs are open at once.

### M1 · "One owner": native episodes, the car test

**Builds:**
- `foray-engine-core` (the copied reducer) and the parity library
- generated constants and the harness
- the M1 families, with the capability gate on `episode`/`continuation`/`restore`
- `EngineCore` for episodes, including the audible-start invariant, interruption reasons and resume on the healthy item
- AVDeck with the readiness-gated preroll
- the ForayEngine host with the seams
- AudioSessionOwner (the hold policy, `sessionOwnedByEngine`, seven guarded sites)
- **BackgroundGrace**
- RemoteSurface, NowPlayingPublisher
- EngineStore (shared rows) with private keys and the file ring
- `decideOnce` with the sentinel guard
- relinquish (terminal, no notify)
- the bridge; the page client, facades and reference engine
- the `client.js` native branch behind `engineModeReady`
- DurableStore deferral from construction
- continuation (extracted, with `autoAdvance`) and position events
- the cold path through the existing injector
- the three CI spikes and the Developer session probe
- the engine report tool
- the L-2 legal edits in the flip PR; DECISIONS in its own PR (G-7)

**Forays in M1** run on today's player after a relinquish. The script says so.

**Founder test (G-3), with an EPISODE.** Each block records the route port type and ends with one Copy, parked.
1. **H-1:** play in the car, pause from the car, lock the phone, and wait 2, then 10, then 30 min. Press the car's play each time → 4a resumes.
2. **H-1b:** repeat H-1 at 10 min with Developer "Pause hold: none" (the hold arm for OQ-12).
3. **H-3:** a call while playing (placed by a second person) → 4a resumes by itself. A call while paused, then the car's play → 4a.
4. **Navigation:** Apple Maps navigation on, with at least 3 prompts during an episode. Each prompt resumes, and the `session` rows show the reason and the resume latency.
5. **H-6e:** the lock screen and car show episode, show and artwork, never "4a/Unknown". The skip glyphs read 15/30. **Press the physical steering-wheel next and previous**, and record which `MPRemoteCommand` arrived.
6. **Status probe:** with nothing restorable (after close), press play, then start Spotify, then press the car's play, and record who gets the press.
7. **Negative control:** pause 4a, play Spotify for 10 s, press the car's play. Expected: **Spotify**.
8. **DV-12** (kill mid-listen, at most 15 s lost) and **DV-13** (headset, unplug).
9. **DV-7a**, recorded: Developer "Simulate system termination" (persists the restore record and calls `exit(0)` while paused in the background), then the car's play. Expected: 4a with `launch=background`.
10. **DV-9** from the desk pre-flight's session probe.
11. The Developer → Web fallback check.

**Exit:** three drives in which the engine report shows:
- no `sessionActivated failed`;
- no `remote play handled=y` without audio;
- no takeover **unless another app played after 4a**.

DV-12 and DV-13 must pass. DV-7a and DV-9 must be recorded.

### M2 · Native Forays: tape, narration, seams

**Builds:**
- the M2 families and `EngineCore` for Forays
- DeckPair prepare and preroll behind `deckPairEnabled`
- the three-layer out-point with the windowed watchdog
- `SpeechNarrator` on the path DV-9 chose, with `pickDefaultVoice` ported and `voiceId` in the restore record; audition moves onto it
- InterludePlayer
- BackgroundGrace extended to seams, with the capped silence fallback
- page `playForay` and the `foray` capability gate
- the `--phase native` probe; existing probe phases pinned to legacy

**Founder test (G-4):**
- H-2: a 51-minute screen-off Foray drive
- H5: narration pause and resume mid-sentence while locked
- H6: tape, narration and pause never show "4a"
- DV-4, DV-5 and DV-10 from the report

**Exit:** H-2 with no `stop cause=unknown`; the seam distribution is on record.

### M3 · Values from the field and completeness

*Re-planned 2026-09-29 (§14 Track M3). The founder's human actions will be a while, so every field value ships provisional (`// MEASURE`), and only NE-38f, the drive and NE-40d need a human.*

**Builds:**
- **Provisional values from existing evidence**, each with the row that settles it (NE-38):
  - P-13, split by class: clip 20 s, rendered line 8 s;
  - the 600 s reuse idle limit;
  - the grace low-water mark;
  - OQ-12 `.forever`.
- `engine-report.mjs` verdicts for each of those values (NE-38e). The values are settled from the pastes later (NE-38f, gated).
- **Route resume on a known car** (founder Q5): a JS reference policy and fixtures, then the engine, keyed by port type and UID, persisted, with a Bluetooth arm that is off until the rows say otherwise (NE-38rj/rs).
- **Rendered narration seams become ordinary deck seams**: the next clip is prepared behind a line, and the line behind a clip (NE-45j/s). Speech is the fallback only.
- **The silence-node decision** (it stays off) and the late-timer row that would justify turning it on (NE-46).
- **The car's Next over narration** and the fallback's cause (NE-39n); **audition by URL** (NE-47).
- **The manager remainder** (18 tests), after which `swift-pending.json` and `unported.json` are deleted; the de-dup decision (NE-39j/s).
- **The D-5 stop-cause audit, the `.longFormAudio` flag (off), the `engine/m3` → `main` merge and the M3 script** (NE-40).
- **The DECISIONS entries** (G-7, NE-40d).

**Founder test (G-6):**
- DV-7a (required).
- DV-7b: force-quit, then the car's play. Expected "not 4a"; recorded only.
- The route-resume block (a car switched off and on while playing; a listener's pause must stay paused).
- A rendered-Foray block, once one is published.
- DV-11.
- A regression drive of H-1 to H-3.
- An optional `.longFormAudio` arm.

Nothing in M3's engineering waits for this test, or for the M2 drive (#128).

### M4 · Harden, don't remove (after two clean weeks)

- Retire only the Developer "Web" UI entry (the native override setter stays), the 500 ms de-dup window on the iOS native path, and the M1 Foray relinquish.
- **Keep the legacy lane reachable** through the crash guard, the sticky-legacy rule, `relinquish{cap:"all"}` and the override. A legacy-mode smoke test runs in CI.
- Phase-2 seats: `PcmNarrator` and the NP-11 read APIs.
- Optional: freeze or delete the `ios/` scaffold (G-2).

```
Day 1:        G-1a requested (engine-parity advisory; ios-build path filter excludes player/parity/**, tools/parity/**)
Week 1:       NE-01 · NE-03 · NE-08 · NE-13 · NE-25a (Swift PRs: NE-01, NE-25a)
Week 2:       NE-02 · NE-04 · NE-05 · NE-07j/10j/11j/12j · NE-15 vs stub DeckEvent · NE-21 · NE-23 → re-derive estimates
Weeks 2-5:    NE-07s, NE-09..NE-12s, NE-14j/s → NE-15h → NE-16, NE-16g, NE-17..NE-20 · NE-22 · NE-24..NE-26r · G-1b
Week ~6:      NE-27 flip (hold until OQ-9) + NE-27d DECISIONS → TestFlight 1 → G-3
Weeks 7-11:   NE-28j..NE-36 → NE-37 → TestFlight 2 → G-4
Weeks 12-14:  NE-38, NE-38e, NE-38rj/rs, NE-45j/s, NE-39j/n/s, NE-46, NE-47 → NE-40 (merge + TestFlight 3) → G-6 → NE-38f, NE-40d (re-planned 2026-09-29)
+2 clean weeks: NE-41, NE-42, NE-44, NE-48
```

## 8. Risks and how each one is retired

| # | Risk | Retired by |
|---|---|---|
| R1 | Background activation after an interruption that ended without `shouldResume` is refused | H-3/DV-3. Now Playing and the targets stay, and the failure returns `.commandFailed` with a token. |
| R2 | The app is suspended during a silent span | BackgroundGrace from M1 with expiration handlers, `grace=` rows, and the capped silence flag. |
| R3 | Speech disturbs the session | DV-9 via the M1 session probe (NE-25c) decides NE-33's path before M2 starts. The Simulator result is smoke only. |
| R4 | MP3 timing | NE-25a, DV-5, NE-38. |
| R5 | Early out-point | The three layers, the `outpoint` and `deck` fixtures, never-early XCTests. |
| R6 | Two-language drift | Fixtures in place, generated namespaced constants, `--check`, `--mutate`, the coverage guard over 15 suites with the `xctest:` grep, burn-down lists, capability gates on every capability, G-1a/G-1b. |
| R7 | Packaging | NE-01 (`xcodebuild -list`; fallback is a second target). |
| R8 | A stale page clobbers native rows | DurableStore deferral from construction, replace-set on attach, private keys out of `CapacitorStorage`, the clobber test, and the NE-36 reload assertion. |
| R9 | A bad engine build breaks daily listening | Default `js` until NE-27, the sentinel guard with sticky legacy, page-health strikes, the Developer override, TestFlight Previous Builds, and a legacy smoke test in CI. |
| R10 | A lane switch brings FR-2 back | One-way relinquish, a terminal state, no notify. |
| R11 | A WebKit element sneaks back | NE-22 pins, the NE-36 probe. |
| R12 | Byte-identical JSON | JSWriter, `rows`/`number-format`; `lastEpisodeRow` stored verbatim. |
| R13 | `setActive` blocks main | `activateMs`; `CommandGate` held in reserve. |
| R14 | Human merges on the critical path | The reducer is copied, so G-2 is optional. The inject changes ride the existing injector, so no `.github` edit is needed for the flip. DECISIONS goes in separate PRs (G-7). |
| R15 | The Windows loop and macOS capacity | Split `j`/`s` cards, at most two Swift PRs open, G-1a Linux loop on day 1, a narrowed ios-build path filter, estimates re-derived at week 2. |
| R16 | Founder time is the critical path | One build per script, desk pre-flight, parked Copies, one issue per milestone, `engine-report.mjs`. |
| R17 | Implicit activation by `play()`/`speak` outside the policy | The `session-invariant` family, activation as request and response, `fault implicit-activation` rows. |
| R18 | Background launches misread as crashes | Sentinel strikes, `decideOnce`. |
| R19 | Red Swift auto-merges and halts all releases (HOLD_MAIN_RED) | The day-1 `hold` label rule (§12), then G-1b `ios-gate` and the release refusal. |
| R20 | 2-hourly TestFlights change code under an ongoing drive series | One named build per script, auto-update off, M2 shared-path changes behind off-by-default flags, legacy smoke in CI. |
| R21 | App Review 2.5.4 | The silence node is capped and off by default, the audible interlude is preferred, and the App Review note goes in NE-37. |
| R22 | `preroll` before readiness crashes | The readiness gate, retry once then fall back, the `preroll(` pin. |

## 9. Human gates

| # | Who | What | Blocks |
|---|---|---|---|
| G-1a | Wyatt (`founder-approved`) | **Day 1:** `engine-parity` in `ci.yml` (push, pull_request, workflow_dispatch; advisory; cached image) with a job-summary table; ios-build path filter excludes `player/parity/**` and `tools/parity/**`. | The fast Swift loop for NE-05 onward (the fallback covers the gap) |
| G-1b | Wyatt (`founder-approved`, `tools/ci` human merge) | After about a week green: `engine-parity` required, with a short-circuit; the required `ios-gate`; release refusal on a non-green `engine-parity`/`ios-kit`; the `ios-build --phase native` step (or a G-1c sitting). | **NE-27**, NE-36 |
| G-2 | a human merger | Optional `ios/` scaffold cleanup. | NE-44 only |
| G-3 | Wyatt + a second person for calls | The M1 car test (§7). | M1 exit |
| G-4 | Wyatt | The M2 drive. | M2 exit |
| G-5 | Wyatt | OQ-9 (native default for the M1 build; recommended), OQ-3, OQ-5, OQ-6 (jingle 1.5 s vs 3.0 s), OQ-11 (delayed `play_started`), **OQ-12 (pause-hold policy, from the H-1/H-1b rows; amends S-4)**. | NE-27 (OQ-9), NE-29j (OQ-6), NE-38f (OQ-12; `.forever` stays the default until then) |
| G-6 | Wyatt | DV-7a, DV-7b, the route-resume block, the rendered-Foray block, DV-11, the regression drive (NE-40's script). | M3 exit, and NE-38f's settled values. No M3 engineering card waits on it (re-plan 2026-09-29). |
| G-7 | Wyatt (`founder-approved`; `docs/DECISIONS.md` is denied) | Separate DECISIONS PRs: NE-27d, NE-37d, NE-40d. Batched with label sittings. | Records only; never blocks a flip |

### 9a. Defaults applied by the orchestrator (2026-09-24), so no card waits

The founder's standing instruction is to route only true product/spend/legal calls to him and take a sensible default for the rest, recording it (CLAUDE.md, `docs/DECISIONS.md`). His instruction for this deck, 2026-09-24: *"Please wrap up whatever is in flight and then focus on getting this out the door before starting new work."* Each default below is reversible and is named in the card that implements it; a founder ruling overrides it.

| OQ | Default | Why |
|---|---|---|
| OQ-1 placement | The pure core lives under `mobile/plugins/` (a new SwiftPM package beside `foray-audio`), not in `ios/`. | `ios/` is reference material and outside auto-merge; the shipping plugins already live here. `PlayerQueueState.swift` is copied (NE-02), `ios/` untouched. |
| OQ-2 required parity check | Yes, after G-1a's week green (G-1b). | The repo is public, so macOS runner minutes cost nothing; drift between JS and Swift is the failure this deck exists to prevent. |
| OQ-3 synthesized narration speed | 1x (founder, 2026-09-24), and on iOS 1x **stays `AVSpeechUtteranceDefaultSpeechRate` (0.5)** — not the ~0.58 estimate (founder, 2026-09-24: *"assume 1x speed"*). | *"1x for now, but maybe we change later. I recall 1x felt like 0.6x or so, it was very slow."* Round-1 qa 28 is fixed by `fix/narration-1x`; the switch defaults to false. Asked the same day whether iOS 1x should move to ~0.58 to make up that feel, he answered *"assume 1x speed"*, so the XCTest's 1x anchor stays Apple's default (`docs/DECISIONS.md`, 2026-09-24). |
| OQ-4 provisional values | Ship M1 with provisional deadlines + diagnostics; NE-38 replaces them from field rows. | Measurements need a native build to exist first. |
| OQ-5 audition | Through the engine (single session owner, S-1). | Two owners is the defect this deck removes. |
| OQ-6 jingle clock | Count an authored JINGLE at the asset's measured duration (3.0 s), fixed JS-first before fixtures freeze (NE-29j). | The clock and the audio must agree; 1.5 s vs 3.0 s is a latent drift. |
| OQ-7 remote de-dup | Keep until DV-6 shows single delivery; retire in NE-39s/NE-41. | Removing a guard needs evidence. |
| OQ-8 playbackState on iOS | Fix in the engine only (write `nowPlayingInfo` rate; do not rely on the macOS-only property). | The legacy shim is retired by this deck. |
| OQ-9 kill switch | Native default-on for the founder's builds, with a Developer drawer toggle back to the JS player. | He tests in the car; a one-tap fallback protects his daily listening. |
| OQ-10 cold launch | In M1 (NE-24): a car's play after iOS terminated the app must work. | "Paused for a long time" is exactly when iOS terminates a background app. |
| OQ-11 delayed rows | Accepted: `play_started`/history rows written on the next page wake are local-only rows the privacy policy already discloses. | No new data leaves the device. |
| OQ-12 pause-hold policy | Decided from the H-1/H-1b rows in NE-38, default `.forever` until then. | Needs measurements. |

## 10. What needs the founder's phone

| Question | When | Answered by rows |
|---|---|---|
| DV-1 / H-1, H-1b | M1 | `remote`, `session hint=`, `resume grace=` |
| DV-3 / H-3 | M1 | `session kind=interruption reason=`, `activateMs` |
| Navigation prompts | M1 | `session kind=interruption`, `resume latencyMs` |
| DV-6 | M1 → M3 | `remote dupCandidate` |
| DV-9 | **M1** (desk probe) | `probe speech-then-play` |
| DV-10 / H6 | M1, M2 | `nowplaying` |
| DV-12, DV-13 | M1 | `resume`, `session kind=route` |
| Steering-wheel buttons, route type, status probe | M1 | `remote route= status=` |
| DV-7a / DV-7b | recorded M1, required M3 | `build launch=background` |
| DV-2 / H-2, DV-4, DV-5 | M2 | packed `seam` rows, `outPoint` |
| DV-8 | M3 | `build routeSharing=` |
| DV-11 | M3 | Settings → Battery |
| Route resume: does the car send its own play on connect? Is the Bluetooth arm needed? | M3 | `route kind=lost/back`, `remote play` → `route-back` (NE-38e) |
| P-13 by class, the reuse idle limit, the rate latch | M2 → M3 | `deck kind=ready/deadline/attach/reuse`, `nowplaying via=rate` → `P13-clip`, `P13-line`, `reuse-idle`, `rate-latch` |
| A suspension inside a silent seam (the silence node) | M2 → M3 | `grace kind=late inSeam=` → `suspension-in-seam` |
| Rendered-line seams, the fallback's cause | M3 | packed `seam from= to= prepare=`, `narration kind=fallback cause=` |

## 11. Out of scope

Android's native engine is out of scope for THIS deck, not for the product: it has its own plan, `docs/plans/android-assessment.md` (tracks A0–A2, ruled 2026-09-29 to start in parallel with M2; Track A4, A-60..A-69, mirrors this deck's M3), which ports this deck's core and contract to Media3 against the same parity fixtures. This deck's only Android edits are A-20's inert contract gating (§4.1). Also out of scope: any other Android work here (J-1), the website apart from behaviour-preserving extractions, CarPlay templates and Swift `foray-resolve`/`foray-queue`, the Kokoro engine, ADR-0007 rung 4, offline downloads, and proxying or padding enclosure bytes (L-3).

## 12. Card conventions

- Every card states the ask, owned files, dependencies, **measured** acceptance, a device check, and a **size** (S ≤ ½ day, M ≤ 2 days, L ≤ 5).
- Branch `t_<card>/<slug>`, and a `STATE.md` entry per PR.
- **`j` cards are JavaScript only.** They run on Windows, and their new fixture ids go to `swift-pending.json` automatically. **`s` cards are Swift.** At most two Swift PRs may be open at once.
- **The `hold` rule, from day 1:** every PR touching `mobile/plugins/*/ios/**` or `foray-engine-core/**` opens with the `hold` label. The agent removes it only after quoting a green `ios-kit` run (and `ios-build` where relevant) **on the exact head SHA**. This remains in force until G-1b's `ios-gate` is required.
- **M2 code that changes shared episode paths** merges behind an off-by-default `EngineConfig` flag until NE-37.
- Code is cited by function name, not line number.
- `shell-invariants.test.mjs`: extend it, never loosen it.
- No `swift` or `xcodebuild` on Windows. Every Swift claim is marked CI-executed (job and run URL, head SHA) or not executed.
- One test process at a time locally.
- DECISIONS edits never ride in a flip PR (G-7).

## 13. Critique disposition

| # | Finding | Disposition |
|---|---|---|
| 1 | Implicit activation defeats the setActive pin | Accepted: §4.4 invariant, `session-invariant` family, activation request/response turn, adapter fault rows (NE-11j/s, NE-14s, NE-15h). |
| 2 | Legacy guards unbuildable; relinquish breaks the legacy lane; four sites | Accepted: `sessionOwnedByEngine` in the volatile domain, flipped at relinquish, byte-identical `EngineModeFlag` in foray-tts, seven guarded sites (NE-16). |
| 3 | Relinquish with notifyOthers hands audio to Spotify | Accepted, choosing "keep the session active, no deactivate, no notify" over "deactivate without notify". The legacy hold would re-activate at once anyway, and a background re-activation can fail. Now Playing is overwritten, never set to nil. |
| 4 | BackgroundGrace needed in M1 | Accepted: NE-16g in M1, expiration handlers, `play()` on the healthy item. |
| 5 | NE-25 Simulator cannot measure the session or background time | Accepted: re-tagged as smoke, a proxy test, and the M1 Developer session probe answers DV-9 (NE-25c). |
| 6 | Crash guard counts background launches | Accepted: sentinel, `decideOnce`. |
| 7 | DV-7 force-quit cannot pass | Accepted: DV-7a (simulated system termination) is required; DV-7b (force-quit) is a negative control. |
| 8 | Holding forever has side effects | Partly accepted: `pauseHoldPolicy`, the H-1b arm, the hint logged. The long-idle release is **not** adopted unilaterally, because it amends S-4; it goes to the founder as OQ-12 with the rows. |
| 9 | Late `appWasSuspended` began | Accepted: reason vocabulary, policy edges, fixtures, `.main` observers. |
| 10 | preroll before readyToPlay crashes | Accepted: gate, retry/fallback, pin, XCTest. |
| 11 | Navigation prompts cause reloads | Accepted: `play()` on the existing item with an authored 1.5 s rewind; navigation arm in the script. |
| 12 | Silence fallback vs App Review; no cap | Accepted: 4.5 s cap, fixtures, interlude preferred, App Review note (NE-34, NE-37). |
| 13 | Watchdog cost; status semantics; handlers on main | Accepted: windowed watchdog, status in every remote row, the status probe step, thread check. |
| 14 | CarPlay vs Bluetooth; wheel buttons; no negative control | Accepted: route type, wheel step, Spotify control, a redefined exit criterion. |
| 15 | Hydration resurrects deletes and overwrites undated engine keys | Accepted: private keys out of `CapacitorStorage`, deferral from construction, replace-set on attach. **Tombstones rejected**: they would change row formats that Android, the web and the JS lane read, and replace-set gives the same guarantee without that. |
| 16 | Page refuses writes after relinquish | Accepted: ordered relinquish steps, `releaseOwnership`, a `relinquished` restore record, M1 `restoreForay` paints only, script step 0. |
| 17 | Injectors need `.github`; DECISIONS denied | Accepted: the injections ride the already-wired `inject-background-audio.mjs` (Read (verified): both paths call it with `--check`), so no `.github` edit is needed. `decide(nil) = js` is a fixture. DECISIONS moves to G-7 PRs. |
| 18 | No parity gate at the M1 flip | Accepted: episode/continuation/restore capability maps; G-1b is a hard prerequisite of NE-27; release refusal. |
| 19 | Miscounted suites; suites omitted from the guard | Accepted: counts computed by the recorder (verified above), four suites added, the `deck` family, `xctest:` grep, `--mutate`. Fixture-reading applied to new suites only (existing suites are not rewritten). |
| 20 | No JS oracle for prepare | Accepted: authored `prepare` family at the audible level; reference engine with warm handover on. |
| 21 | Boot order vs hello | Accepted: `engineModeReady`, relinquish `cap:"all"` on failure, the native hello watchdog. |
| 22 | Escape hatch too narrow | Accepted, except the `Settings.bundle` switch, which is rejected: the shell is generated by `cap add` and a Settings bundle needs pbxproj injection. The page-broken escape is TestFlight Previous Builds plus page-health strikes and sticky legacy. |
| 23 | Relinquish leaves observers live | Accepted: terminal `.relinquished`, full teardown, XCTest. |
| 24 | ForayTts guard; audition risks FR-1 | Accepted: audition routed through the engine (M1 PreviewSpeaker, M2 SpeechNarrator); the DV-9 probe covers the same synthesizer path. |
| 25 | Continuation flags | Accepted: `autoAdvance` plus `chain`, the toggle refresh, cases. |
| 26 | `cp_last_episode` shape | Accepted: `lastEpisodeRow` stored verbatim. |
| 27 | Position cp_events dropped | Accepted: `pendingEvents`. |
| 28 | Default voice not ported | Accepted: `pickDefaultVoice` in SpeechRules, `voiceId` in the restore record (NE-29j/NE-33). |
| 29 | Existing probe phases measure the wrong lane | Accepted: pinned to legacy and labelled (NE-36). |
| 30 | M4 removes the only fallback | Accepted: M4 hardens and keeps legacy. |
| 31 | Swift PRs auto-merge; a red ios-kit halts releases | Accepted: the day-1 `hold` rule, then G-1b `ios-gate`. |
| 32 | Injectors unwired | Accepted (see 17). NE-27 acceptance reads the archive's `--check` log. |
| 33 | No stable M1 TestFlight | Accepted: one named build per script, auto-update off, flags, legacy smoke. |
| 34 | NE-02 breaks the build; human merge on the critical path | Accepted: copy, not move; G-2 optional (NE-44). |
| 35 | DurableStore local-wins hydration | Accepted (with 15); NE-19 and NE-27 depend on NE-23; NE-36 reload assertion. |
| 36 | ForayTts/pin (duplicate) | Accepted (with 2 and 24). |
| 37 | 200-row ring overflows; pastes unprocessed | Accepted: packed seam rows, a 2,000-row file ring, a 51-min retention test, `engine-report.mjs` (NE-26r), parked Copies, issue per milestone, a second caller. |
| 38 | Fixture counts wrong | Accepted: generic acceptance, M3 re-planned at about 70 scenarios, media-session classified in NE-12j. |
| 39 | gen-constants imports and duplicate | Accepted: NE-04 depends on NE-08, namespacing, duplicate test, function-name citations. |
| 40 | Fallback not buildable; `core` identity | Accepted: `ForayEngineParity` library, `foray-engine-core`, `xcodebuild -list` check. |
| 41 | engine-parity wiring | Accepted: G-1a/G-1b split, workflow_dispatch, short-circuit, pr-hygiene round trip. |
| 42 | Headless tests cannot run | Accepted: seam protocols with recording fakes; real values from the probe app and the device. |
| 43 | Crash guard trips in the script | Accepted: sentinel, clear on setting change, step 0 `strikes=0`. |
| 44 | No sizes; mixed cards; capacity | Accepted: sizes, `j`/`s` split, NE-25 split in three, two Swift PRs max, NE-15 early against a stub, estimates re-derived. |
| 45 | DECISIONS in flip PRs | Accepted (G-7). The flip PR carries `hold` until OQ-9 is answered, and a test requires the recorded answer. |
| 46 | NE-36 cannot use launch arguments | Accepted: seed `ForayEngine.modeOverride` with `simctl spawn … defaults write`. |
| 47 | `continuationChain` not pure | Accepted: `player/continuation.js` extraction first. |

Read first: `CLAUDE.md`, this deck, the Tier 2 requirements, `docs/ios-native-player-gap.md`, `docs/ios-lock-screen.md`, the `html-audio-backend.js`, `queue-manager.js` and `durable-store.js` headers, and `ForayAudioPlugin.swift`'s header.

> **Added 2026-09-25 — NE-38r · Resume on a known car route (founder Q5).** *"Q5 yes move everything in the app to the native engine."* When a route the engine has seen playing (CarPlay or a car's Bluetooth, keyed by port type and UID) comes back **and** the engine's last pause was caused by that route going away (not by a listener press, a call or Siri), the engine resumes on its own; a listener's pause is never resumed. It lives in the engine's route policy (NE-16's AudioSessionOwner route observer and the core's reason for the pause), with parity cases for "route-lost pause → resume" and "listener pause → no resume", and a car-test block. Milestone M3, after NE-38 (it needs the field rows on route change reasons). The web player's dead branch (round-3 finding player-core-10) is deleted rather than wired. **Status 2026-09-29:** the web branch is deleted. `EngineCore.onRoute` carries a partial port with five gaps: no JS reference or fixtures, keyed by name, CarPlay only, not persisted, and it resumes a listener's pause. The card is now NE-38rj and NE-38rs (§14 Track M3).

## 14. The card deck

72 cards (revision 2 had 61; NE-37c and NE-39n were added with M2, and the M3 re-plan of 2026-09-29 added nine). Conventions are §12: the ask, owned files, dependencies, **measured** acceptance, a device check and a size (S ≤ ½ day, M ≤ 2 days, L ≤ 5). A `j` card is JavaScript only and runs on Windows; an `s` card is the Swift port that burns the same families down. Every card touching `mobile/plugins/*/ios/**` or `foray-engine-core/**` opens with the `hold` label (§12). The sequencing is the §7 timeline; `depends_on` below is the hard order.

| Card | Title | Milestone | Size | Depends on |
|---|---|---|---|---|
| NE-01 | Packaging spike: foray-engine-core package, parity library, cap sync, scheme list, Preferences prefix, loop-time baseline | M1 | M | none |
| NE-02 | Copy PlayerQueueState.swift and its 34 tests into foray-engine-core (ios/ untouched) | M1 | S | NE-01 |
| NE-03 | Parity harness, JS side: schema, runner, recorder (--check, --mutate, auto-pending), comparator, coverage guard over 15 suites | M1 | L | none |
| NE-04 | Generated, namespaced EngineConstants.swift and the closed vocabularies | M1 | M | NE-03, NE-08 |
| NE-05 | ForayEngineParity library and its XCTest wrappers; the zero-.github fallback | M1 | M | NE-01, NE-03 |
| NE-06 | engine-parity CI (G-1a day 1, G-1b required, ios-gate, release refusal) | M1 | M | NE-05 |
| NE-07j | Record the queue-state and rate families (JS) | M1 | S | NE-03 |
| NE-07s | Swift reducer to JS parity: bounds, seek, out-point, pendingSeek, elementResumed | M1 | M | NE-02, NE-05, NE-07j |
| NE-08 | JS extractions with no behaviour change: transport-policy.js, exported constants, position-store suite | M1 | M | NE-03 |
| NE-09 | Swift ports: PlaybackRate, ResumeRules, TransportPolicy | M1 | M | NE-04, NE-05, NE-07j, NE-08 |
| NE-10j | Record the rows and number-format families from the real JS builders (JS) | M1 | S | NE-03 |
| NE-10s | JSWriter and Rows: byte-identical shared rows | M1 | M | NE-04, NE-05, NE-10j |
| NE-11j | engine-contract.js, the contract schema, and the session / session-invariant / engine-mode / handshake / snapshot / contract families (JS) | M1 | M | NE-03, NE-04, NE-10j |
| NE-11s | Swift SessionPolicy, EngineMode.decideOnce rules, and contract decoding | M1 | M | NE-05, NE-11j |
| NE-12j | Classify all media-session tests; record the media-episode family (JS) | M1 | M | NE-03 |
| NE-12s | MediaMapping port, episode subset, and command enablement | M1 | M | NE-04, NE-05, NE-12j |
| NE-13 | player/continuation.js extraction, autoAdvance, applyEngineAdvance, and the toggle refresh | M1 | M | NE-03 |
| NE-14j | Record the manager-episode and deck-episode families; JS-first interruption rewind (JS) | M1 | M | NE-03, NE-08, NE-11j |
| NE-14s | EngineCore for episodes: handle(input) -> [EngineCommand], with the audible-start invariant | M1 | L | NE-07s, NE-09, NE-10s, NE-11s, NE-12s, NE-14j |
| NE-15 | AVDeck adapter against a stub DeckEvent: readiness-gated preroll, observation, rate, deadline (start week 1) | M1 | L | NE-01 |
| NE-15h | ForayEngine host and adapter seams with recording fakes | M1 | M | NE-14s, NE-15 |
| NE-16 | AudioSessionOwner, pauseHoldPolicy, interruption reasons, and sessionOwnedByEngine across both plugins | M1 | L | NE-11s, NE-15h |
| NE-16g | BackgroundGrace in M1: silent-while-intending-to-play spans with expiration handlers | M1 | M | NE-15h, NE-16 |
| NE-17 | EngineOwnership: decideOnce, sentinel strikes, sticky legacy, private keys, terminal relinquish, hello watchdog, plist injection | M1 | L | NE-11s, NE-15h |
| NE-18 | RemoteSurface, NowPlayingPublisher and ArtworkCache, through the seams | M1 | L | NE-12s, NE-15h, NE-17 |
| NE-19 | EngineStore (shared rows), private keys, a 2,000-row diagnostics file ring, packed seam rows, os.Logger | M1 | M | NE-10s, NE-15h, NE-23 |
| NE-20 | Bridge: engineHello, engineSend and engineRead, with coalesced events | M1 | M | NE-11s, NE-15h, NE-17 |
| NE-21 | Page engine client, facades, and reference engine with warm handover on | M1 | L | NE-03, NE-11j |
| NE-22 | client.js native branch for episodes, gated boot, the ordered relinquish, audition through the engine | M1 | L | NE-13, NE-20, NE-21, NE-23 |
| NE-23 | DurableStore single writer from construction: deferral, replace-set adoption, release | M1 | M | NE-10j, NE-11j |
| NE-24 | Cold path: bootIfNeeded via the existing injector's AppDelegate patch | M1 | M | NE-16, NE-16g, NE-17, NE-18, NE-19 |
| NE-25a | CI spike: in-point and out-point measurement on click tracks | M1 | L | NE-01 |
| NE-25b | CI spike: two-deck preroll and readiness timing | M1 | M | NE-01, NE-15 |
| NE-25c | Speech and background smoke tests, plus the Developer session probe that answers DV-9 in M1 | M1 | M | NE-15h, NE-16 |
| NE-26 | Diagnostics: merge the engine ring into Copy, and the engine header line | M1 | S | NE-19, NE-21 |
| NE-26r | tools/mobile/engine-report.mjs: a Copy paste to DV verdicts and a seam distribution | M1 | M | NE-19 |
| NE-27 | M1 flip: native default for iOS episodes, legal edits, and the car-test script | M1 | S | NE-06, NE-14s, NE-15, NE-16, NE-16g, NE-17, NE-18, NE-19, NE-20, NE-22, NE-23, NE-24, NE-25c, NE-26, NE-26r |
| NE-27d | DECISIONS entry: the iOS app plays episodes natively (G-7) | M1 | S | NE-27 |
| NE-28j | Record the seam-gap, interlude, seek-policy (+ladder, pad) and outpoint families (JS) | M2 | M | NE-03, NE-04 |
| NE-28s | Swift ports: SeamGap, Interlude, SeekPolicy, outpoint policy | M2 | M | NE-07s, NE-28j |
| NE-29j | Record foray-clock, foray-progress, foray-structure, the remaining media cases, and default-voice (JS) | M2 | M | NE-12j, NE-28j |
| NE-29s | Swift ForayClock, foray-progress rules, StructuralCheck, full MediaMapping | M2 | M | NE-12s, NE-28s, NE-29j |
| NE-30j | Record manager-foray tape, the deck remainder, the authored prepare family, and the foray-playback mapping (JS) | M2 | M | NE-14j, NE-21, NE-29j |
| NE-30s | EngineCore for Forays, tape: playForay, in-points, the gate, seams, Foray transport, cp_foray | M2 | L | NE-14s, NE-28s, NE-29s, NE-30j |
| NE-31j | Record the narration, interlude, jingle and tts-bridge scenarios (JS) | M2 | M | NE-30j |
| NE-31s | EngineCore narration, interlude and jingle overlays | M2 | L | NE-30s, NE-31j |
| NE-32 | DeckPair: readiness-gated prepare and preroll on the standby deck; the windowed three-layer out-point | M2 | L | NE-15, NE-25a, NE-25b, NE-30s |
| NE-33 | SpeechNarrator on the path DV-9 chose, SpeechRules with pickDefaultVoice, audition moved onto it | M2 | L | NE-25c, NE-27, NE-31s |
| NE-34 | InterludePlayer, seam BackgroundGrace, and the capped silence fallback | M2 | M | NE-16g, NE-31s, NE-32 |
| NE-35 | Page: native Forays, the capability gate, audition copy | M2 | M | NE-22, NE-30j |
| NE-36 | ios-build native probe phase; existing phases pinned to legacy; reload clobber check | M2 | M | NE-06, NE-30s, NE-32 |
| NE-37 | M2 flip: advertise 'foray', the drive script, the App Review note | M2 | S | NE-31s, NE-32, NE-33, NE-34, NE-35, NE-36 |
| NE-37d | DECISIONS entry: Forays play natively on iOS (G-7) | M2 | S | NE-37 |
| NE-37c | M2 catch-up with main after the M1 car test: #866 in Foray paths, audit round 3 and the Phase 2 narration rules in the engine | M2 | M | NE-37 |
| NE-38 | Provisional field values now (P-13 per class, reuse idle, grace, OQ-12 default), and the rows that settle them | M3 | M | NE-37 |
| NE-38e | engine-report.mjs learns the M3 verdicts (JS) | M3 | M | NE-38 |
| NE-38f | Settle the values from the field (human-gated input: #128 and G-6 pastes) | M3 | S | NE-38e, #128, NE-40 drive |
| NE-38rj | Route resume, the JS reference: a pure policy and the route-resume family (JS) | M3 | M | NE-37 |
| NE-38rs | Route resume in the engine: port the policy, key by port type and UID, persist, rows | M3 | M | NE-38rj, NE-38 |
| NE-45j | Prepare across narration seams, the JS reference (JS) | M3 | M | NE-37 |
| NE-45s | Prepare across narration in the engine: a rendered line's seams are deck seams | M3 | L | NE-45j, NE-38 |
| NE-39j | Record the manager remainder (18 tests) (JS) | M3 | M | NE-45j |
| NE-39n | The car's own Next over narration, and the fallback's cause (retargeted) | M3 | M | NE-37c |
| NE-46 | The silence-node decision: stays off, plus the late-timer row | M3 | S | NE-38 |
| NE-47 | Audition by URL: the voice preview plays a rendered file on the engine | M3 | M | NE-37 |
| NE-39s | Swift burn-down; delete the pending lists; the de-dup decision | M3 | L | NE-39j, NE-38rs, NE-45s, NE-39n, NE-47 |
| NE-40 | Stop-cause audit, the .longFormAudio trial flag, the M3 merge and build, and the M3 script | M3 | M | NE-38, NE-38e, NE-38rs, NE-39s, NE-45s, NE-46 |
| NE-40d | DECISIONS entries for M3 (G-7, human-gated) | M3 | S | NE-38f, NE-39s, NE-40 |
| NE-41 | Harden, don't remove: retire the Developer Web entry and the iOS de-dup window; keep the legacy lane as fallback | M4 | M | NE-40 |
| NE-42 | Phase-2 seat: the CarPlay read APIs (the Kokoro PcmNarrator half is obsolete) | M4 | S | NE-24 |
| NE-48 | NarrationCache: download a Foray's rendered narration when it starts | M4 | M | NE-45s |
| NE-44 | Optional: freeze or delete the ios/ SwiftUI scaffold (G-2) | M4 | S | NE-02 |

### Track M1 · "One owner": native episodes, the car test

#### NE-01 · Packaging spike: foray-engine-core package, parity library, cap sync, scheme list, Preferences prefix, loop-time baseline — **M**
- **Milestone:** M1
- **Depends on:** none
- **Ask:** Create mobile/plugins/foray-audio/foray-engine-core as a pure SwiftPM package (Foundation only; iOS 15, macOS 12, Linux) with two library products: ForayEngineCore (one trivial type) and ForayEngineParity (a stub runner with no XCTest import), plus core/Tests with a thin XCTest wrapper. Add .package(path: "foray-engine-core") to foray-audio's Package.swift. ForayAudioPlugin depends on ForayEngineCore, and ForayAudioPluginTests depends on ForayEngineParity through a thin wrapper. Add a stub engineHello on ForayAudioPlugin (iOS only; returns {mode:"legacy", reason:"not-built"}). Add a Simulator XCTest that writes through @capacitor/preferences' native class and reads raw UserDefaults, pinning the 'CapacitorStorage.' prefix. Record `xcodebuild -list` output for the plugin package before and after, and the cap sync line proving the nested package resolved through npm's file: symlink. Record the wall time of each CI job this PR triggers (ios-kit, ios-build) in docs/ios-native-engine-measurements.md (new) as the loop-time baseline for the week-2 re-estimate. If the nested package fails to resolve, fall back to a second target in the same package and record it. Owned: mobile/plugins/foray-audio/{Package.swift, foray-engine-core/**, ios/Sources/ForayAudioPlugin/ForayAudioPlugin.swift (stub only), ios/Tests/**}, tools/mobile/shell-invariants.test.mjs (pin engineHello), docs/ios-native-engine-measurements.md. Opens with the `hold` label (§12).
- **Acceptance:** The PR quotes, with run ids on the head SHA: ios-build green with the package folded in, including the cap sync line; ios-kit's xcodebuild test -scheme ForayAudio green, including the prefix round-trip and the parity-wrapper stub; `xcodebuild -list` before and after showing the ForayAudio and ForayTts scheme names unchanged. All existing ForayAudioPluginTests stay green (legacy behaviour unchanged). The loop-time baseline is in the measurements doc. Every Swift claim in the claims table is marked CI-executed.
- **Device check:** None (CI only). The next TestFlight must behave exactly as today.

#### NE-02 · Copy PlayerQueueState.swift and its 34 tests into foray-engine-core (ios/ untouched) — **S**
- **Milestone:** M1
- **Depends on:** NE-01
- **Ask:** Copy ios/ForayKit/Sources/ForayKit/PlayerQueueState.swift and its 34 PlayerQueueStateTests into foray-engine-core/Sources/ForayEngineCore/Reducer and core/Tests. Add a header naming the source path and commit adde5e12, and saying the ios/ copy is frozen reference. Do NOT touch ios/, project.yml or ForayKit. Moving them would break ios/App/ForayApp.swift, which references PlayerQueueManager, and ForayKit's host swift test (ForayKit is .iOS(.v17) only), and would need a human merge. Add a floor for the copied tests in floors.json or suite-integrity as applicable. Opens with `hold`.
- **Acceptance:** `swift test --package-path mobile/plugins/foray-audio/foray-engine-core` runs the 34 copied tests green on macOS (ios-kit fallback wrapper, or G-1a engine-parity once it exists), with the run id on the head SHA. `git diff --stat` shows no path under ios/. The ios-kit ForayKit and Foray steps are unchanged and green.
- **Device check:** None.

#### NE-03 · Parity harness, JS side: schema, runner, recorder (--check, --mutate, auto-pending), comparator, coverage guard over 15 suites — **L**
- **Milestone:** M1
- **Depends on:** none
- **Ask:**

  Create player/parity/:
  - schema/fixture.schema.json (pure calls and scenarios; macros; error codes)
  - fakes.js (FakeBackend op-log, ManualScheduler, MemoryStore, FakeTts, FakeInterlude)
  - compare.js
  - run.test.js
  - manifest.json, exclusions.json (closed reasons), unported.json (JS tests awaiting a fixture or XCTest, tagged with a card), swift-pending.json, capabilities.json (episode/continuation/restore/foray maps from plan §6.6), floors.json

  Create tools/parity/record.mjs with:
  - --family and --check (runs in npm test)
  - refusal to overwrite authored:true cases
  - automatic addition of every newly recorded case id to swift-pending.json, tagged with a --port-card argument, so a JS PR never turns the Swift runner red
  - --mutate, for the named rules (seam gap, never-early, 15/30, pause-silence): flip the rule and assert that the original JS test and its fixture both fail

  Create coverage.test.js:
  - every top-level test in the 15 covered suites (queue-state, seam-gap, interlude, seek-policy, playback-rate, foray-progress, media-session, transport-policy, position-store, continuation, queue-manager, html-audio-backend, tts-bridge, foray-playback, transport-reconcile) is in covers[], an xctest:<Class>/<method> mapping (grepped in the Swift test sources), exclusions.json or unported.json
  - the manifest hashes match
  - pending and unported ids exist
  - every capability advertised in ENGINE_DEFAULT.json and the Swift source has zero pending and zero unported entries in its families
  - floors are welded to test/suite-integrity.test.js

  Re-baseline: the recorder prints per-suite counts, and no card types a count. Initial classification puts every test not yet fixtured into unported.json with its port card. Seed the seam-gap family end to end.

- **Acceptance:**

  npm test runs run.test.js and coverage.test.js green, one process at a time. Mutations:
  - hand-edit a recorded expect and --check goes red;
  - add a test() to seam-gap.test.js with no mapping and the guard goes red;
  - add an xctest: mapping to a non-existent Swift method and the guard goes red;
  - change JS against an authored case and record.mjs refuses;
  - recording a new case adds its id to swift-pending.json;
  - --mutate on the seam-gap rule fails both the JS test and the fixture.

  The existing suites' counts are unchanged.

- **Device check:** None.

#### NE-04 · Generated, namespaced EngineConstants.swift and the closed vocabularies — **M**
- **Milestone:** M1
- **Depends on:** NE-03, NE-08
- **Ask:**

  tools/parity/gen-constants.mjs imports the JS exports and writes foray-engine-core/Sources/ForayEngineCore/EngineConstants.swift, with a do-not-edit header.
  - Constants are namespaced by source module (e.g. SeekPolicy.driftToleranceSec = 30 and ForayProgress.driftToleranceSec = 1; Transport.restartWindowSec and Transport.seekInsideEndSec, exported by NE-08; QueueManager.positionIntervalMs; the rate ladder; seam, interlude, jingle, pad and position thresholds; INTERRUPTION_REWIND_SEC once NE-14j exports it).
  - tools/parity/gen-constants.test.mjs fails if the file is stale and fails on any duplicate export name across the imported modules. It runs on Windows.
  - player/parity/vocabulary.json holds the closed sets: stages, session error tokens, interruption reasons (default, appWasSuspended, builtInMicMuted, unknown), stop causes (including grace-expired and seam-timeout), sources, mode reasons (including no-plist-key, crash-loop, page-health, downgrade) and fault kinds (implicit-activation, externally-owned).
  - Add the diag-tokens family.

- **Acceptance:** node --test tools/parity/gen-constants.test.mjs is green. Changing SEAM_GAP_SEC without regenerating turns it red. A deliberate duplicate export name turns it red. Both DRIFT_TOLERANCE_SEC values appear under distinct namespaces. The diag-tokens cases pass in JS.
- **Device check:** None.

#### NE-05 · ForayEngineParity library and its XCTest wrappers; the zero-.github fallback — **M**
- **Milestone:** M1
- **Depends on:** NE-01, NE-03
- **Ask:**

  In foray-engine-core/Sources/ForayEngineParity (no XCTest import):
  - a runner that resolves FORAY_PARITY_DIR or walks up from #filePath to player/parity/fixtures (no copy)
  - decoding with a JSONValue type, one FamilyRunner protocol per family, and a Swift Comparator (with a 'compare' meta-family, so the JS and Swift comparators cannot disagree)
  - results returned as data, written to parity-report.json at $PARITY_REPORT, printing 'parity family=<f> cases=<n>'
  - failure when a manifest id is neither executed nor pending, or when a pending case passes

  Thin XCTest wrappers, one method per family and one XCTFail per case, in core/Tests (Linux and macOS swift test) and in ForayAudioPluginTests (so the existing ios-kit 'xcodebuild test -scheme ForayAudio' step executes parity before G-1a). Implement the seam-gap FamilyRunner as proof. Opens with `hold`.

- **Acceptance:** ios-kit's ForayAudio step executes the seam-gap family through the plugin wrapper and logs its count (run id, head SHA). Mutation: move one seam-gap id into swift-pending.json while Swift passes, and the runner goes red. No XCTest import in ForayEngineParity (a grep pin in shell-invariants).
- **Device check:** None.

#### NE-06 · engine-parity CI (G-1a day 1, G-1b required, ios-gate, release refusal) — **M**
- **Milestone:** M1
- **Depends on:** NE-05
- **Ask:**

  Two founder-approved PRs.

  G-1a, requested on day 1:
  - a job engine-parity inside ci.yml on ubuntu-latest, container swift:5.10 (image cached), running swift test --package-path mobile/plugins/foray-audio/foray-engine-core with FORAY_PARITY_DIR and PARITY_REPORT, and appending the family table to $GITHUB_STEP_SUMMARY
  - it runs on push, pull_request AND workflow_dispatch (never copying ios-kit's skip), advisory
  - a macOS 'swift test' of the core in ios-kit
  - ios-build's path filter excludes player/parity/** and tools/parity/**

  G-1b, after about a week of green G-1a runs:
  - make engine-parity required, with a step-level short-circuit to success when neither player/parity/**, foray-engine-core/** nor tools/parity/** changed
  - add a required ios-gate job that runs on every event: success when no Swift path changed, otherwise it runs or needs ios-kit on the head SHA
  - release refuses to cut an iOS TestFlight from a SHA whose engine-parity or ios-kit is not green
  - the ios-build '--phase native' step, if NE-36 is ready

  Update ios-workflow.test.mjs and release-workflow.test.mjs pins; never loosen them.

- **Acceptance:** G-1a: engine-parity is green on the PR and shows the family table. A pr-hygiene round trip (update a PR branch) shows engine-parity reporting on the new head SHA. G-1b: branch protection lists engine-parity and ios-gate (recorded in STATE.md). A test PR touching only content shows both short-circuit green. A deliberately red ios-kit on a Swift PR keeps ios-gate red. Release refuses a SHA with red parity (dry-run log).
- **Device check:** None.

#### NE-07j · Record the queue-state and rate families (JS) — **S**
- **Milestone:** M1
- **Depends on:** NE-03
- **Ask:** With NE-03's recorder (--port-card NE-07s for queue-state, NE-09 for rate), record every top-level test of queue-state.test.js and playback-rate.test.js into the queue-state and rate families, or into exclusions with a closed reason. That covers the elementResumed cases of 2026-09-22. New ids go to swift-pending automatically.
- **Acceptance:** The coverage guard shows zero unported entries for queue-state and playback-rate. The case counts are produced by the recorder and written to floors.json. npm test is green. No Swift file changes.
- **Device check:** None.

#### NE-07s · Swift reducer to JS parity: bounds, seek, out-point, pendingSeek, elementResumed — **M**
- **Milestone:** M1
- **Depends on:** NE-02, NE-05, NE-07j
- **Ask:**

  Extend the copied PlayerQueueState to match queue-state.js:
  - QueueItemRef gains bounds and sameRef (Q-2)
  - Events gain .seek(seconds:precise:) and .elementResumed (Q-9)
  - Effects gain .seekTo, .seekRejected and .setOutPoint
  - loadingItem gains pendingSeek
  - telemetry strings are byte-identical

  Implement the queue-state FamilyRunner and burn the family out of swift-pending.json. The 34 copied tests stay green. Opens with `hold`.

- **Acceptance:** The queue-state family's executed counts are equal in JS and Swift (engine-parity or the fallback, run id on the head SHA), and its swift-pending entries are zero. Mutation: swap two effects in itemLoaded and a named case goes red.
- **Device check:** None.

#### NE-08 · JS extractions with no behaviour change: transport-policy.js, exported constants, position-store suite — **M**
- **Milestone:** M1
- **Depends on:** NE-03
- **Ask:** Lift the client-layer transport rules out of client.js closures into pure player/transport-policy.js functions, cited by function name, not line number: resolveToggle, previousAction, skipTarget (the Foray clock and the episode clamp), scrubTarget, remoteStopAction, endedPlayAction, and the paused/loading/nothing-loaded seek rules. Export RESTART_WINDOW_SEC and SEEK_INSIDE_END_SEC from it, and export POSITION_INTERVAL_MS from queue-manager.js. client.js delegates, with no behaviour-bearing edits. Add player/position-store.test.js, which reads its cases from the resume-rules fixtures (one file is both the JS assertion and the Swift case): resumeOffset < 10 s → 0, within 30 s of the end → 0, row shape, and the once-a-minute onSave position-event rule. Record the transport and resume-rules families (--port-card NE-09).
- **Acceptance:** All existing suites are green with unchanged counts (transport-reconcile, the client tests, media-session). The new suites have floors. The transport and resume-rules families pass in JS, and their ids sit in swift-pending tagged NE-09. The diff shows client.js only delegating. The Android and web suites are the proof of no change.
- **Device check:** None.

#### NE-09 · Swift ports: PlaybackRate, ResumeRules, TransportPolicy — **M**
- **Milestone:** M1
- **Depends on:** NE-04, NE-05, NE-07j, NE-08
- **Ask:**

  - core/Policy/PlaybackRate.swift: the ladder, snap with telemetry, and utteranceRate copied from ForayTtsPlugin with the same numbers.
  - ResumeRules.swift: resumeOffset, the episode cadence (15 s / 10 media seconds), the Foray cadence (5 s), unknown never overwrites known, and the once-a-minute position-event rule.
  - TransportPolicy.swift: the NE-08 functions.

  Implement the FamilyRunners and burn rate, resume-rules and transport out of swift-pending. Opens with `hold`.

- **Acceptance:** rate, resume-rules and transport have equal executed counts in JS and Swift and zero pending, with run ids. utteranceRate matches ForayTts for every ladder step (one fixture case per step).
- **Device check:** None.

#### NE-10j · Record the rows and number-format families from the real JS builders (JS) — **S**
- **Milestone:** M1
- **Depends on:** NE-03
- **Ask:** Record a 'rows' family from JSON.stringify of the real JS builders: the cp_pos:<id> row, the cp_foray makeProgress row, and cp_last_episode from episode-progress.js makeLastEpisode (SNAPSHOT_FIELDS id, title, show, artwork_url, audio_url, duration_min, duration_sec, plus updated_at). Record a 'number-format' family: 0.1+0.2, -0, 1e21, 5e-7, 123456789.125, integral doubles. Declare player/engine-contract.js OWNED_PREFIXES = ['cp_pos:', 'cp_foray:', 'cp_last_episode'] here, as NE-11j and NE-23 consume it. Port card NE-10s.
- **Acceptance:** Both families pass in JS and sit in swift-pending tagged NE-10s. The cp_last_episode case is recorded from makeLastEpisode, not hand-written.
- **Device check:** None.

#### NE-10s · JSWriter and Rows: byte-identical shared rows — **M**
- **Milestone:** M1
- **Depends on:** NE-04, NE-05, NE-10j
- **Ask:**

  - core/Persist/JSWriter.swift: per-row key order, and ECMAScript Number::toString (shortest round-trip, the exponent thresholds, -0).
  - Rows.swift: serialisers and parsers for cp_pos, cp_foray, cp_last_episode (stored verbatim from the page's lastEpisodeRow plus updated_at), the engine-private restore record (with pendingEvents and voiceId), and DiagRow, including the packed seam row (observedGapMs, askedGapMs, prepared, grace, bgRemainingMs, stage list).

  Burn down rows and number-format. Opens with `hold`.

- **Acceptance:** rows and number-format pass byte-for-byte on both sides with zero pending. A JS parser reads every Swift-written row. isNewer ordering holds on engine-written rows.
- **Device check:** None.

#### NE-11j · engine-contract.js, the contract schema, and the session / session-invariant / engine-mode / handshake / snapshot / contract families (JS) — **M**
- **Milestone:** M1
- **Depends on:** NE-03, NE-04, NE-10j
- **Ask:**

  player/engine-contract.js holds:
  - PROTOCOL = 1, command and event names (including relinquish{cap}, setModeOverride, setHoldPolicy, ackEvents, probeSession)
  - OWNED_PREFIXES
  - decideMode for the page (ios, method present, protocol match, hello.mode == native)
  - validateSnapshot, and extrapolate(snapshot, receivedAtMs, now)
  - a JS reference of SessionPolicy.transition and EngineMode.decideOnce as pure tables

  player/parity/schema/engine-contract.schema.json has valid and invalid examples.

  Families:
  - session: the full §4.4 table, including the interruption reasons, stale appWasSuspended, holdExpired, the relinquish edge carrying neither deactivate nor notify, and deactivate+notify only on close, finalEnd and dataDeletion
  - session-invariant: authored; every audible command follows an active session or a successful sessionResult in the same turn; mutation cases for deckPlay in lostToInterruption, an autoadvance hop, a reconcile correction and a seam timer tail
  - engine-mode: an absent plist key gives js reason=no-plist-key; the sentinel strike rule; three clean background launches give strikes 0; sticky legacy until CFBundleVersion changes; a setting change clears; a page-health strike
  - handshake, snapshot, contract

  Port card NE-11s.

- **Acceptance:** All six families pass in JS against the JS reference tables and sit in swift-pending tagged NE-11s. extrapolate is frozen when inSeamGap, buffering or not running.
- **Device check:** None.

#### NE-11s · Swift SessionPolicy, EngineMode.decideOnce rules, and contract decoding — **M**
- **Milestone:** M1
- **Depends on:** NE-05, NE-11j
- **Ask:** core/Policy/SessionPolicy.swift implements the §4.4 table, including .relinquished (terminal) and the interruption reasons. core/Policy/EngineMode.swift implements the pure decide(buildDefault?, override, sentinelWasSet, strikes, stickyLegacyBuild, currentBuild, built) -> (mode, reason, newStrikes). Decode the contract examples in Swift. Burn down the six NE-11j families. Opens with `hold`.
- **Acceptance:** All six families have equal counts and zero pending on both sides. Mutations: add a deactivate edge on pause and a session case goes red; add notify to the relinquish edge and a case goes red.
- **Device check:** None.

#### NE-12j · Classify all media-session tests; record the media-episode family (JS) — **M**
- **Milestone:** M1
- **Depends on:** NE-03
- **Ask:**

  Classify every top-level test in media-session.test.js (152 at adde5e12):
  - the episode subset → the media-episode family
  - Foray and narration cases → unported.json tagged NE-29j
  - WebView-only mediaSession plumbing → exclusions.json with a closed reason, one entry per test

  The guard can then go live in M1 without porting all 152. Port card NE-12s.

- **Acceptance:** The coverage guard shows every media-session test classified. media-episode passes in JS and sits in swift-pending tagged NE-12s. Nothing in media-session.test.js changes.
- **Device check:** None.

#### NE-12s · MediaMapping port, episode subset, and command enablement — **M**
- **Milestone:** M1
- **Depends on:** NE-04, NE-05, NE-12j
- **Ask:** core/Policy/MediaMapping.swift ports mediaMetadata, albumOf, mediaPositionState, mediaPlaybackState and the episode action enablement. The narrationCredit ladder is ported but exercised in M2. commandAvailability(snapshot) implements NP-5: skip intervals from EngineConstants, stop always disabled, all disabled and nowPlaying nil only when finished/closed/deleted, and canNext from the chain regardless of autoAdvance. Burn down media-episode. Opens with `hold`.
- **Acceptance:** media-episode has equal counts and zero pending. Mutation: enable next when canNext is false, and a case goes red. No literal 15 or 30 in Swift (a shell-invariants grep pin).
- **Device check:** None.

#### NE-13 · player/continuation.js extraction, autoAdvance, applyEngineAdvance, and the toggle refresh — **M**
- **Milestone:** M1
- **Depends on:** NE-03
- **Ask:**

  - First extract planAfterEnded, nextAfterEnded and a new continuationChain(state, K = 8) from app.js into player/continuation.js, as pure functions over an injected {queue, playList, playChainId, playListCursor, isPlayable}. app.js delegates, and the existing up-next and continuous-playback suites prove behaviour is unchanged.
  - Hops are {hopSeq, finishedId, nextId, fromList, queueAfter[], item, lastEpisodeRow}.
  - app.js gains applyEngineAdvance(hop): saveQueueIds, chain and cursor, logEvent('play_started', ..., 'autoadvance') and recordHistory, made idempotent through the page-owned cp_engine_applied watermark written BEFORE logEvent. It also gains drainEngineEvents(events), which replays 'position' events with their original timestamps.
  - The 'Continuous playback' toggle now calls refreshEpisodeNavigation.
  - setContinuation carries {autoAdvance: cp_autoadvance, chain}.

  The continuation family (JS only; its suite reads its fixtures) covers: chain order vs planAfterEnded; autoAdvance off with skip-next still available; a toggle while playing re-sends; replaying the log twice is a no-op; the event drain is idempotent.

- **Acceptance:** The continuation family passes, with a floor. The existing up-next and continuous-playback suites are unchanged and green. Mutations: drop the watermark write and the replay-twice case goes red; make canNext depend on autoAdvance and a case goes red. OQ-11 is noted in the PR for G-5.
- **Device check:** None.

#### NE-14j · Record the manager-episode and deck-episode families; JS-first interruption rewind (JS) — **M**
- **Milestone:** M1
- **Depends on:** NE-03, NE-08, NE-11j
- **Ask:**

  - Record from queue-manager.test.js the episode scenarios (route, interruption, #19 single-audible, cold launch, superseded load, fast double skip, pause silence) into manager-episode.
  - Record from html-audio-backend.test.js the episode-deck rules (same source is a seek not a refetch, the hidden load deadline, never-early arithmetic at every rate, a stop during recovery still arms the boundary) into a deck-episode family, expressed as DeckEvent in and EngineCommand/DeckPolicy ops out.
  - Add the authored INTERRUPTION_REWIND_SEC = 1.5 rule to transport-policy.js (interruptionResumeOffset), and use it in queue-manager's interruption-resume path. The PR states the one-line web/Android behaviour change.
  - Record authored cases for position-event emission and lastEpisodeRow pass-through.

  Port card NE-14s. The remaining queue-manager tests are classified into unported.json (NE-30j, NE-31j, NE-39j) or exclusions.

- **Acceptance:** manager-episode and deck-episode pass in JS and sit in swift-pending tagged NE-14s. Every queue-manager and html-audio-backend test is classified in the guard. The existing suites are green, with the interruption-resume expectation updated only for the rewind case (called out in the PR).
- **Device check:** None.

#### NE-14s · EngineCore for episodes: handle(input) -> [EngineCommand], with the audible-start invariant — **L**
- **Milestone:** M1
- **Depends on:** NE-07s, NE-09, NE-10s, NE-11s, NE-12s, NE-14j
- **Ask:**

  core/Engine holds EngineInput (commands with source, remote, deck events, sessionResult, session events with reason, lifecycle, timers), EngineCommand, EngineState and EngineCore.handle for the episode paths:
  - play and resume with the offset on the load
  - the loaded/target split and superseded loads by token
  - pause silence
  - stop and errors
  - seeks while paused, loading or with nothing loaded
  - ended play; toggle from native truth; remote stop is a pause
  - activation as request/response (sessionActivate, then wait for sessionResult, then audible commands; a failure gives .commandFailed and no audible command)
  - interruptions by reason, and resume on the healthy item with the rewind, or rebuild only for a failed item
  - routes with 500 ms attribution; observed-pause reconcile with cause rows
  - rate on every play; the position cadence and pendingEvents
  - continuation walking gated on autoAdvance, advanceLog, canNext from the chain
  - lastEpisodeRow stored verbatim
  - restore-record writes; dupCandidate recording
  - grace begin/end commands for every silent-while-intending span (remote play, background tap play, interruption resume, route resume, cold play)
  - the .relinquished terminal state returning []
  - core/Policy/DeckPolicy.swift for the deck-episode rules

  Burn down manager-episode, deck-episode and session-invariant. Opens with `hold`.

- **Acceptance:** manager-episode, deck-episode and session-invariant have equal counts and zero pending. Mutations: deckPlay before deck ready → red; deckPlay while lostToInterruption → red. A fake-deck scenario proves at most one audible source. Every stop path emits a cause row first (a fixture per cause). Every grace begin has a matching end or expiry in the scenarios.
- **Device check:** None (pure); exercised by NE-27's car test.

#### NE-15 · AVDeck adapter against a stub DeckEvent: readiness-gated preroll, observation, rate, deadline (start week 1) — **L**
- **Milestone:** M1
- **Depends on:** NE-01
- **Ask:**

  Start in week 1 against a stub DeckEvent/DeckCommand type in the plugin, and swap to the core types when NE-14s lands. ios/Sources/ForayAudioPlugin/Engine/AVDeck.swift wraps one AVPlayer behind the DeckDriving seam.
  - Settings: actionAtItemEnd .pause; automaticallyWaitsToMinimizeStalling true; .timeDomain.
  - Load: attach item → load duration → wait for KVO player.status and item.status == .readyToPlay → zero-tolerance seek → preroll(atRate: 0) only when rate == 0 → ready.
  - preroll finished=false or an interrupted seek is 'not ready': retry once, then an ordinary load.
  - Rate via defaultRate on iOS 16+; on iOS 15, playImmediately(atRate:) or rate, re-applied every play.
  - KVO on timeControlStatus, rate, status and reasonForWaitingToPlay, plus stall, failed-to-end and did-play-to-end, mapped to DeckEvent.
  - A 20 s // MEASURE: deadline.
  - Before any play, check AudioSessionOwner.phase through a closure: if it is not active, write a 'fault implicit-activation' row and assert in DEBUG.

  A shell-invariants pin allows preroll( only inside the readiness-gated function. Simulator XCTests on bundled CBR MP3 and WAV click tracks (< 1 MB): offset landing, nothing audible before ready, rate held across 3 loads, a never-ready URL hits the deadline with no preroll issued, an external pause becomes a reconcile input. Opens with `hold`.

- **Acceptance:** ios-kit runs the AVDeck tests green (run id, head SHA). The no-preroll-before-ready test and the preroll( pin are green. The CBR landing error is in the job summary as a measurement. The iOS 15 target builds.
- **Device check:** None directly; DV-12/DV-13 in NE-27.

#### NE-15h · ForayEngine host and adapter seams with recording fakes — **M**
- **Milestone:** M1
- **Depends on:** NE-14s, NE-15
- **Ask:**

  Engine/Seams.swift defines SessionControlling, BackgroundTasking, RemoteCommandRegistering, NowPlayingWriting, DeckDriving and Speaking, each with a recording fake in the test target. The AVFoundation/UIKit/MediaPlayer implementations are the only callers of the real APIs. Engine/ForayEngine.swift is the @MainActor singleton hosting EngineCore:
  - it interprets EngineCommand through the seams
  - it runs activation as request/response in one turn (sessionActivate executes synchronously, sessionResult is fed back before any further command)
  - timers are DispatchSourceTimer on main
  - off-main results (artwork, duration) come back as inputs
  - teardown() removes every observer, KVO token, timer and grace task

  This is what makes NE-16, NE-17 and NE-18's acceptance executable headless (package tests have no host app, and MPRemoteCommand targets cannot be enumerated). Opens with `hold`.

- **Acceptance:** XCTests over the fakes: a failed activation yields no DeckDriving.play call; a remote play runs activate → play in one main turn; teardown leaves zero live observers (fake counts). ios-kit green (run id).
- **Device check:** None.

#### NE-16 · AudioSessionOwner, pauseHoldPolicy, interruption reasons, and sessionOwnedByEngine across both plugins — **L**
- **Milestone:** M1
- **Depends on:** NE-11s, NE-15h
- **Ask:**

  Engine/AudioSessionOwner.swift (the SessionControlling implementation):
  - Category .playback, mode .spokenAudio, no options, set at boot with no activation.
  - Activates only on the policy's activate. Writes sessionActivated ok|failed with the token, activateMs and secondaryAudioShouldBeSilencedHint.
  - Deactivates with notifyOthers only on close, finalEnd and dataDeletion, and without notify on holdExpired.
  - pauseHoldPolicy (.forever default | .until(m) | .none), set by engineSend setHoldPolicy and stored in ForayEngine.holdPolicy (a private key), recorded in the build row; a Developer row 'Pause hold: forever / none'.
  - Observes interruptionNotification with AVAudioSessionInterruptionReasonKey (default, appWasSuspended, builtInMicMuted), routeChangeNotification (port type recorded) and mediaServicesWereReset, all with addObserver(forName:object:queue: .main).
  - .longFormAudio behind an off flag.

  EngineModeFlag.swift (~10 lines) reads and writes sessionOwnedByEngine in the UserDefaults volatile domain 'ai.jwlabs.foura.engine'. A byte-identical copy lives in foray-tts, checked by a node test in the data/item-tags.json style. Guard all four setActive sites (ForayAudioPlugin holdSession/releaseSession; ForayTtsPlugin speak/resume) and all three setCategory sites on it. Extend shell-invariants: setActive( and setCategory( appear only in AudioSessionOwner.swift plus the seven guarded legacy sites, each guarded. Opens with `hold`.

- **Acceptance:** XCTests over the fakes: no activation at launch or restoreBar; no deactivate on pause or background under .forever; deactivate without notify on holdExpired under .until; appWasSuspended while running after an activation in this process gives a stale=y row and no state change; builtInMicMuted changes nothing. A real-API XCTest: foray-tts reads the volatile flag set by foray-audio in the same process, and after the flag flips to false, ForayTts.speak's setCategory runs. The byte-identity test and the seven-site pin are green, and adding an unguarded setActive turns the pin red. Legacy ForayAudio and ForayTts tests are unchanged.
- **Device check:** H-1, H-1b, H-3 and the navigation arm in NE-27.

#### NE-16g · BackgroundGrace in M1: silent-while-intending-to-play spans with expiration handlers — **M**
- **Milestone:** M1
- **Depends on:** NE-15h, NE-16
- **Ask:**

  Engine/BackgroundGrace.swift (the BackgroundTasking implementation) interprets the core's grace begin and end commands.
  - beginBackgroundTask always has an expiration handler that ends the task, writes 'grace expired', and feeds a graceExpired input (the core pauses with stop cause=grace-expired).
  - An .invalid begin or a small backgroundTimeRemaining is recorded.
  - The span ends on the first confirmed timeControlStatus == .playing, or at idle.
  - grace= and bgRemainingMs go into the remote, resume and cold-play rows.

  In M1 it covers remote play, a background tap play, interruption resume, route resume and cold play. M2 (NE-34) adds seams, the narration handover and prepare misses. Opens with `hold`.

- **Acceptance:** XCTests over the fake: begin and end counts match across remote-play, interruption-resume and cold-play scenarios; the expiry path pauses with a cause row; no task leaks after teardown. ios-kit green (run id).
- **Device check:** H-1/H-3 rows in NE-27 show grace=y and a positive bgRemainingMs on every background resume; DV-7a covers cold play.

#### NE-17 · EngineOwnership: decideOnce, sentinel strikes, sticky legacy, private keys, terminal relinquish, hello watchdog, plist injection — **L**
- **Milestone:** M1
- **Depends on:** NE-11s, NE-15h
- **Ask:**

  Engine/EngineOwnership.swift:
  - decideOnce() is a lazy static shared by bootIfNeeded and ForayAudioPlugin.load(), so there is one strike accounting per process. Its inputs: Info.plist ForayEngineDefault (absent → js, reason=no-plist-key), ForayEngine.modeOverride, sentinel, strikes, stickyLegacyBuild, CFBundleVersion, and a built flag.
  - Private UserDefaults keys live outside 'CapacitorStorage.'.
  - The sentinel is written before native boot and cleared by the healthy marker (first handled input, 5 s of main run loop, willResignActive/didEnterBackground, or first .playing). A strike is added only if the previous sentinel is still set; healthy resets strikes. 3 strikes → legacy, sticky until CFBundleVersion changes. setModeOverride clears strikes and sticky.
  - Legacy mode runs today's registration unchanged. Native mode defers it and sets sessionOwnedByEngine = true.
  - relinquish{cap}, one way: stop with persistence; keep the session active (no deactivate, no notify); flip sessionOwnedByEngine to false; leave Now Playing for legacy to overwrite; remove targets; call ForayEngine.teardown(); enter .relinquished; write restore {mode:'relinquished'}; run the legacy registration; write 'mode reason=downgrade cap=<cap>'.
  - Native hello watchdog: no engineHello within 15 s of the WebView load finishing while the engine is idle → self-relinquish (cap 'all') plus a page-health strike row.
  - engineSend setModeOverride writes synchronously, and the Developer row 'Playback engine: Automatic / Native / Web (applies after restart)' uses it.
  - mobile/ENGINE_DEFAULT.json = {"mode":"js"}.
  - tools/mobile/inject-background-audio.mjs gains the ForayEngineDefault/ForayEngineCapabilities writes, with --check extended and tests. It is already invoked in ios-build.yml and ios-archive/action.yml, so no .github edit is needed. ios-workflow.test.mjs and release-workflow.test.mjs pin that both invocations still exist.

  Opens with `hold`.

- **Acceptance:** engine-mode fixtures pass. XCTests: decideOnce called from both entry points increments strikes once; three launches with cleared sentinels leave strikes 0; a launch after an uncleared sentinel adds 1; sticky legacy survives relaunch and clears on a new CFBundleVersion. Over the RemoteCommandRegistering fake: legacy registration is identical to today's; native mode registers no legacy target before relinquish, and exactly one set after it; a second relinquish is refused. After relinquish, synthetic interruption-ended, route and reset notifications produce zero engine commands and zero setActive calls. inject-background-audio tests are green, and the ios-build log shows ForayEngineDefault=js via --check. With ENGINE_DEFAULT js, the build is behaviourally identical to today.
- **Device check:** NE-27 script: Developer → Web, relaunch, confirm the old player; back to Automatic; the Copy header shows strikes=0.

#### NE-18 · RemoteSurface, NowPlayingPublisher and ArtworkCache, through the seams — **L**
- **Milestone:** M1
- **Depends on:** NE-12s, NE-15h, NE-17
- **Ask:**

  Engine/RemoteSurface.swift (the RemoteCommandRegistering implementation) is the only registrant in native mode: play, pause, toggle, next, previous, skipBackward [EngineConstants], skipForward [EngineConstants], changePlaybackPosition, and stop registered but disabled.
  - Handlers check Thread.isMainThread: on main, MainActor.assumeIsolated; off main, a 'remote thread=bg' row and DispatchQueue.main.sync.
  - Handlers return the core's verdict. The OS skip interval is ignored.
  - Each remote row records command, status returned, route port type, dupCandidate (same command within 300 ms; recorded, never dropped), grace and thread.

  Engine/NowPlayingPublisher.swift (the NowPlayingWriting implementation) writes MediaMapping at every transition and seek:
  - rate 0 when paused or interrupted; playbackState never used
  - nothing cleared on pause, on an unresumed interruption or on relinquish
  - nil only when finished, closed or deleted

  Engine/ArtworkCache.swift: https or bundled only, off-main, 10 s bound, cached, the key dropped on failure, no publisher artwork for narration.

  Opens with `hold`.

- **Acceptance:** XCTest truth table over the fakes: every command in every snapshot state returns the documented status. Enablement is mutation-tested. nowPlayingInfo after pause (real center) shows rate 0 with its fields intact. Artwork timeout drops the key. The no-literal 15/30 pin is green.
- **Device check:** H-6e, the steering-wheel next/previous step and the status probe (step 6) in NE-27.

#### NE-19 · EngineStore (shared rows), private keys, a 2,000-row diagnostics file ring, packed seam rows, os.Logger — **M**
- **Milestone:** M1
- **Depends on:** NE-10s, NE-15h, NE-23
- **Ask:**

  Engine/EngineStore.swift writes only the shared rows under 'CapacitorStorage.' (cp_pos:*, cp_foray:*, cp_last_episode), as the exact JSWriter strings, synchronously, including at didEnterBackground and willTerminate. All engine-only state (restore, strikes, sentinel, override, hold policy) lives in private UserDefaults keys. purge() removes the shared engine rows, every private key and the ring file. Engine/EngineDiagnostics.swift:
  - a durable ring in Application Support/foray-engine/diag.jsonl, capped at 2,000 rows, with monotonic seq and wall clock
  - ONE packed row per seam (observedGapMs, askedGapMs, prepared, grace, bgRemainingMs, stage list), not one row per stage
  - tokens admitted only through Vocabulary
  - no URLs, no route names (port types only), and free text only for the three Now Playing strings, capped at 40
  - mirrored to os.Logger (subsystem ai.jwlabs.foura, category engine) with .public tokens only
  - the build row records engineVersion, protocol, CFBundleVersion, launch=background|foreground, pitch algorithm and hold policy

  Pin the logger needles. Opens with `hold`.

- **Acceptance:** Simulator XCTests: the engine writes cp_pos and @capacitor/preferences reads the identical string; the ring survives relaunch and caps at 2,000; a simulated 51-minute, 32-segment Foray (31 seams plus session, remote and nowplaying rows) still holds seam 1 at the end; a bad token is dropped; purge leaves no engine key or file (enumerated); no private key has the CapacitorStorage prefix.
- **Device check:** DV-12 in NE-27.

#### NE-20 · Bridge: engineHello, engineSend and engineRead, with coalesced events — **M**
- **Milestone:** M1
- **Depends on:** NE-11s, NE-15h, NE-17
- **Ask:**

  On ForayAudioPlugin (iOS only):
  - engineHello returns {mode, reason, engineVersion, protocol:1, capabilities (ForayEngineCapabilities ∩ implemented), ownedKeyPrefixes, snapshot, pendingAdvances, pendingEvents}.
  - engineSend decodes {v, cmdSeq, cmd, args, source}, dispatches on main, always resolves {ok, reason?, snapshot}, and records seqGap. It covers audition (M1: an engine-owned PreviewSpeaker AVSpeechSynthesizer using the page-resolved voiceId, activated through SessionPolicy as a tap, refused engine-busy while running; replaced by SpeechNarrator in NE-33), setModeOverride, setHoldPolicy, ackEvents and probeSession.
  - engineRead serves the snapshot, rows by prefix (shared rows only), and diagnostics (the whole file ring in one call).
  - The 'engine' event: snapshots coalesced to ≤ 1 Hz, visible only; plus advanced, skipped, error, voiceFallback, modeChanged and diag.

  shell-invariants pins the method and event names against engine-contract.js. Opens with `hold`.

- **Acceptance:** The contract family passes on both sides. XCTest: 1,000 transitions while hidden emit zero events and one snapshot on visible; an invalid payload resolves {ok:false, reason:'unknown-cmd'}; audition while running returns engine-busy; audition while idle activates once through the SessionControlling fake before speaking. Pins green.
- **Device check:** None directly.

#### NE-21 · Page engine client, facades, and reference engine with warm handover on — **L**
- **Milestone:** M1
- **Depends on:** NE-03, NE-11j
- **Ask:**

  - player/native-engine.js: hello, send, read, subscribe, setVisible, latest() → {snapshot, receivedAtMs}, and engineModeReady (a promise resolved by hello or by a 5 s timeout, rejection or mismatch → 'js' plus a relinquish{cap:'all'} attempt). It uses window.Capacitor.nativePromise the way durable-store.js does.
  - player/native-facades.js: NativeManagerFacade and NativeBackendFacade implementing exactly the surface client.js reads. addMediaListener synthesises media events from snapshot diffs plus a visible-only 1 Hz ticker. Extrapolation uses receivedAtMs.
  - player/reference-engine.js: protocol v1 over the real PlayerQueueManager plus the NE-03 fakes, with warm handover ON, so a JS path to prepare behaviour exists for the prepare family.

  Map transport-reconcile.test.js cases to facade tests where they apply (xctest-free, JS only), and record them in the guard.

- **Acceptance:** Unit tests with a fake bridge: coalescing, seq ordering, extrapolation clamps and freezes, and synthesised media events matching an HtmlAudioBackend trace for play → pause → ended. engineModeReady resolves 'js' and sends relinquish on a 5 s delay and on a rejection. reference-engine passes the contract family. The transport-reconcile mapping is complete in the guard. Everything runs on Windows.
- **Device check:** None.

#### NE-22 · client.js native branch for episodes, gated boot, the ordered relinquish, audition through the engine — **L**
- **Milestone:** M1
- **Depends on:** NE-13, NE-20, NE-21, NE-23
- **Ask:**

  Guarded by engineMode === 'native':
  - ensureBooted and every restore path (restoreLastEpisode, restoreForay, the position flushes) await engineModeReady.
  - ensureBooted builds no HtmlAudioBackend, createInterludePlayer or PlayerQueueManager, and uses the facades. ensureJsBooted exists for relinquish.
  - Episode transport entry points send intents. playEpisode carries lastEpisodeRow = makeLastEpisode(item) without updated_at.
  - syncMediaSession returns early, and the foray-media-session.js iOS install is skipped.
  - Owned-key flushes are skipped.
  - reconcileOnReturn becomes attach(why): getSnapshot, replace-set adopt of the owned rows, applyEngineAdvance for pendingAdvances, drainEngineEvents for pendingEvents, ack, repaint.
  - Booting while the engine is running attaches only.
  - refreshEpisodeNavigation sends setContinuation {autoAdvance, chain}.
  - The voice-picker preview sends engineSend audition and never calls ForayTts.speak. 'Pause playback to preview' shows on engine-busy.
  - A Foray tap without the 'foray' capability runs the ordered relinquish: await relinquish → engineRead rows + adoptExternal → storage.releaseOwnership() → engineMode = 'js' → ensureJsBooted → today's player.
  - In M1, restoreForay at boot paints from cp_foray only.

  player/native-mode.test.js boots the real client.js with the transport-reconcile DOM stub against reference-engine.

- **Acceptance:**

  native-mode.test.js pins:
  - HtmlAudioBackend and the interlude element are never constructed (including while hello is delayed 5 s);
  - no navigator.mediaSession write;
  - no owned key written by the page;
  - attach-only while running;
  - ForayTts.speak is never called in native mode;
  - a Foray tap relinquishes before any Audio is built;
  - after relinquish, a Foray position write lands, and the adopted cp_pos equals the engine's;
  - a hello rejection yields JS mode with relinquish sent.

  The existing client and transport-reconcile suites are unchanged.

- **Device check:** NE-27 script: a Foray plays as today, and the Copy shows 'mode reason=downgrade cap=foray'.

#### NE-23 · DurableStore single writer from construction: deferral, replace-set adoption, release — **M**
- **Milestone:** M1
- **Depends on:** NE-10j, NE-11j
- **Ask:**

  durable-store.js:
  - On the iOS Capacitor shell, OWNED_PREFIXES (from engine-contract.js) are DEFERRED from construction. Hydrate reads them, but _migrateUp never pushes them down, the Preferences write queue never carries them, and they are never mirrored into localStorage or IDB until the mode is known.
  - externallyOwned(prefixes): setItem and removeItem are refused with a 'fault externally-owned' row, not a throw.
  - adoptOwnedSet(rowsMap) replaces the in-memory set for those prefixes; a key absent natively is deleted from memory.
  - releaseOwnership() runs the deferred migration for JS/legacy mode or after relinquish.
  - Data deletion in native mode is send('stop',{persist:false}) → send('purge') → the page's own purge.

  Extend test/data-deletion.test.js with cp_engine_applied (page-owned) and assert the engine-private keys are purged by the native purge (listed in the privacy text by NE-27).

- **Acceptance:**

  durable-store clobber tests:
  - a stale localStorage row plus a newer native row, page boot: the Preferences tier receives no write for that key;
  - a row the engine deleted is not resurrected by a reboot;
  - a refused write leaves the store untouched;
  - after releaseOwnership the deferred migration runs once.

  data-deletion.test.js is green. JS-mode behaviour on web and Android is unchanged (the existing suite is green; deferral applies only on the iOS shell).

- **Device check:** DV-12 in NE-27.

#### NE-24 · Cold path: bootIfNeeded via the existing injector's AppDelegate patch — **M**
- **Milestone:** M1
- **Depends on:** NE-16, NE-16g, NE-17, NE-18, NE-19
- **Ask:** ForayEngine.bootIfNeeded() calls decideOnce(). If the mode is native and a restore record exists (and is not mode:'relinquished'), it builds EngineCore from the record, registers RemoteSurface, and paints Now Playing at rate 0 WITHOUT activating (S-3). A cold remote play loads, begins grace, activates once and plays. With no record or a relinquished record, it returns .noActionableNowPlayingItem. tools/mobile/inject-background-audio.mjs gains the AppDelegate patch (AppDelegate.swift beside the Info.plist it is given), idempotent and covered by --check. It is already invoked in both ios-build and ios-archive, so no .github edit is needed; the header's 'no AppDelegate edit' note is updated. The bridge's later load() attaches to the same singleton and never re-registers. Add a Developer control 'Simulate system termination': persist the restore record, then exit(0) while paused in the background (for DV-7a; never a user force-quit). Opens with `hold`.
- **Acceptance:** inject-background-audio tests are green and idempotent for the AppDelegate patch. ios-build compiles the patched AppDelegate, and the --check log line is quoted. An ios-archive --check log confirms that AppDelegate.swift existed at injection time (the §2 Assumed row). Simulator XCTest over the fakes: boot from a record paints nowPlayingInfo at rate 0 with zero SessionControlling activations; a play activates and loads at the recorded offset with grace begun; a relinquished record returns .noActionableNowPlayingItem.
- **Device check:** DV-7a recorded in NE-27 (required in NE-40).

#### NE-25a · CI spike: in-point and out-point measurement on click tracks — **L**
- **Milestone:** M1
- **Depends on:** NE-01
- **Ask:**

  Simulator XCTests that measure, and assert only one-sided rules. Fixtures: 90 s mono click-track MP3s (CBR, VBR+Xing, VBR with no TOC; a 1 ms click every second, a double click every 10 s) and a WAV, under 1 MB total. MTAudioProcessingTap timestamps the first click rendered. Measure:
  (1) in-point landing error and time-to-ready, precise vs approximate, per fixture
  (2) out-point overshoot at 1x and 2x through forwardPlaybackEndTime, the boundary observer and the windowed watchdog (armed 1.5 s before end); which fires first; assert never early

  Run the WebView out-point probe on the same file in the same run where feasible. Write a dated, Measured section in docs/ios-native-engine-measurements.md with run ids. Opens with `hold`.

- **Acceptance:** Every number is in the job summary and the doc with a run id. The never-early assertion is green; if an early stop is measured, the doc records it and NE-32's stopPad is set from it.
- **Device check:** None (Simulator). DV-5 repeats in M2.

#### NE-25b · CI spike: two-deck preroll and readiness timing — **M**
- **Milestone:** M1
- **Depends on:** NE-01, NE-15
- **Ask:** A Simulator XCTest: a second AVPlayer, readiness-gated, seeked and prerolled while the first is audible. Measure time to ready, confirm that preroll is never issued before .readyToPlay, and record preroll finished=false frequency under a forced seek. Results go into the measurements doc, and NE-32 uses them. Opens with `hold`.
- **Acceptance:** Time-to-ready and the finished=false rate are recorded with a run id. The readiness-gate assertion is green.
- **Device check:** None.

#### NE-25c · Speech and background smoke tests, plus the Developer session probe that answers DV-9 in M1 — **M**
- **Milestone:** M1
- **Depends on:** NE-15h, NE-16
- **Ask:**

  (1) Simulator SMOKE (explicitly not evidence): after an AVSpeechSynthesizer (usesApplicationAudioSession = true) didFinish, start a deck in the same run-loop turn and assert timeControlStatus reaches .playing within 1 s with no interruption notification. Log isOtherAudioPlaying and secondaryAudioShouldBeSilencedHint. iOS has no public isActive getter, so this is the observable proxy.
  (2) Engine/SessionProbe.swift, a Developer-only control 'Session probe', driven by engineSend probeSession. While paused and held, it arms a 10 s timer. The founder locks the phone. The timer speaks a short utterance through the same synthesizer configuration SpeechNarrator will use (the PreviewSpeaker in M1), then after didFinish attempts a deck play of the paused episode, records 'probe speech-then-play ok|failed token activateMs timeToPlayingMs grace', and pauses again.

  The probe runs in the NE-27 desk pre-flight, so DV-9 is answered before NE-33 starts. backgroundTimeRemaining is not measured headless (package tests have no host); it comes from the NE-16g device rows.

- **Acceptance:** The smoke test is green or red, with the run id, and is labelled 'Simulator smoke' in the measurements doc. The probe compiles, is reachable only from the Developer drawer, and an XCTest over the fakes shows the probe's command sequence (speak → didFinish → activate if needed → play → pause).
- **Device check:** DV-9 in the NE-27 desk pre-flight: the probe row after locking. Its result sets NE-33's path.

#### NE-26 · Diagnostics: merge the engine ring into Copy, and the engine header line — **S**
- **Milestone:** M1
- **Depends on:** NE-19, NE-21
- **Ask:** The page's 'Playback diagnostics → Copy' calls engineRead('diagnostics') once and merges the rows by wall clock into formatDiagnosticReport, labelled src=engine. The header gains 'engine=<native|js> v<ver> proto=<n> caps=<list> reason=<r> strikes=<n> hold=<policy> build=<CFBundleVersion> | web=<build-stamp>'; in JS mode it reads engine=js with the reason. Formatters cover session (activateMs, token, reason, hint), remote (status, route, thread, dupCandidate), mode, the packed seam row, grace, probe and lifecycle.
- **Acceptance:** Diagnostic tests: a fake 2,000-row ring merges in order; the header renders in both modes; unknown row kinds show as counts, never dropped silently. The existing diagnostic suites are green.
- **Device check:** Every NE-27 block ends with a Copy showing the header.

#### NE-26r · tools/mobile/engine-report.mjs: a Copy paste to DV verdicts and a seam distribution — **M**
- **Milestone:** M1
- **Depends on:** NE-19
- **Ask:**

  A Windows-runnable node tool with tests. It parses a Copy paste (header plus rows) and prints:
  - the header check (build number, engine=native, strikes=0, no downgrade)
  - a DV-1..DV-13 verdict table (pass / fail / no-data, each citing the rows)
  - the resume latencies after interruption and navigation
  - the remote status and route-type summary
  - the seam distribution (p50/p95 observedGapMs, prepared rate, grace coverage)
  - counts of fault rows (implicit-activation, externally-owned) and of stop cause=unknown

  Every milestone exit quotes its output in that milestone's GitHub issue.

- **Acceptance:** Unit tests over synthetic pastes cover every verdict and the no-data paths. A paste with an early seam evicted is flagged as incomplete, not passed.
- **Device check:** None; used on every milestone paste.

#### NE-27 · M1 flip: native default for iOS episodes, legal edits, and the car-test script — **S**
- **Milestone:** M1
- **Depends on:** NE-06, NE-14s, NE-15, NE-16, NE-16g, NE-17, NE-18, NE-19, NE-20, NE-22, NE-23, NE-24, NE-25c, NE-26, NE-26r
- **Ask:**

  Opens with the `hold` label, which stays until G-5 answers OQ-9 (quoted in STATE.md). Set mobile/ENGINE_DEFAULT.json to {"mode":"native","capabilities":["episode","continuation","restore"]}. If the founder prefers opt-in, leave js and make the Developer toggle step 0. A test in shell-invariants requires that ENGINE_DEFAULT says native only when STATE.md records the OQ-9 answer. In the SAME PR (L-2): the privacy policy §1 mechanism paragraph; rows for the shared keys, the engine-private UserDefaults keys and the diagnostics file; the data-safety Part C storage row; test/legal-citations.test.js. NO DECISIONS edit (that is NE-27d). A HUMAN-ACTIONS item naming ONE build number, with the §7 M1 script:
  - step 0 (header check, TestFlight auto-update off, TestFlight Previous Builds named as the escape)
  - a 10-minute desk pre-flight (lock screen, AirPods, Control Center, the session probe for DV-9)
  - H-1 at 2/10/30 min and H-1b at 10 min with hold 'none'
  - H-3 with a second caller
  - the Apple Maps navigation arm (≥ 3 prompts)
  - H-6e plus the steering-wheel next/previous
  - the status probe; the Spotify negative control
  - DV-12, DV-13, DV-7a (simulated system termination), the Developer → Web check
  - a note that Forays play the old way in this build
  - one Copy per block, parked, pasted to the M1 issue
  - route type in every block

- **Acceptance:** All M1 cards are merged. G-1b is in place (engine-parity and ios-gate required). coverage.test.js shows zero pending and zero unported in every family mapped to episode, continuation and restore. legal-citations and data-deletion are green. A TestFlight build is produced from main, and its ios-archive --check log shows ForayEngineDefault=native and the patched AppDelegate. That build number is in the HUMAN-ACTIONS item.
- **Device check:** G-3: three drives per the script. The exit is judged from engine-report.mjs output: no 'sessionActivated failed', no silent 'remote play handled=y', no takeover unless another app played after 4a (the negative control correctly goes to Spotify), DV-12 and DV-13 pass, DV-7a and DV-9 recorded.

#### NE-27d · DECISIONS entry: the iOS app plays episodes natively (G-7) — **S**
- **Milestone:** M1
- **Depends on:** NE-27
- **Ask:** A separate PR editing only docs/DECISIONS.md (a denied path, needs founder-approved). It records the M1 decision, the pause-hold default and OQ-9's answer. It is batched with the next label sitting and never blocks the flip.
- **Acceptance:** The PR is merged with founder-approved, and STATE.md links it.
- **Device check:** None.

### Track M2 · Native Forays: tape, narration, seams

#### NE-28j · Record the seam-gap, interlude, seek-policy (+ladder, pad) and outpoint families (JS) — **M**
- **Milestone:** M2
- **Depends on:** NE-03, NE-04
- **Ask:** Record every test of seam-gap, interlude and seek-policy, plus the ladder-at-load and ADR-0008 pad cases, and an outpoint policy family expressed on the op log (arithmetic, driven clock, scrub-past, speed change, back-to-back same episode, and the windowed-watchdog re-arm on seek and rate change). Add synthetic DAI fixtures. Authored cases: 2.0 s, the 4.5 s ceiling, never-early, and the silence-node cap (never beyond INTERLUDE_CEILING_SEC from the out-point; never when not running or not active). Port card NE-28s.
- **Acceptance:** The families pass in JS and sit in swift-pending tagged NE-28s. The guard shows zero unported entries for seam-gap, interlude and seek-policy.
- **Device check:** None.

#### NE-28s · Swift ports: SeamGap, Interlude, SeekPolicy, outpoint policy — **M**
- **Milestone:** M2
- **Depends on:** NE-07s, NE-28j
- **Ask:** core/Policy: SeamGap.swift, Interlude.swift, SeekPolicy.swift (the ladder, the pad, out-point arming for scrub-past), and the outpoint policy plus watchdog-window arithmetic in DeckPolicy. Burn down the NE-28j families. Opens with `hold`.
- **Acceptance:** Equal counts and zero pending for every NE-28j family, with run ids.
- **Device check:** None.

#### NE-29j · Record foray-clock, foray-progress, foray-structure, the remaining media cases, and default-voice (JS) — **M**
- **Milestone:** M2
- **Depends on:** NE-12j, NE-28j
- **Ask:** Record foray-clock, foray-progress (all tests), foray-structure (J-4), and the media-session cases NE-12j left in unported.json (tagged NE-29j), including the real committed Forays through the $foray macro. Record a default-voice family from default-voice.test.js (pickDefaultVoice: the Samantha ruling of 2026-09-10). Resolve OQ-6 in JS first if the founder has ruled; otherwise mark the jingle case authored with the current value and a note. Port card NE-29s.
- **Acceptance:** The families pass in JS and sit in swift-pending tagged NE-29s. media-session has zero unported entries. 'Never 4a as artist of anything audible' is an authored case over every committed Foray.
- **Device check:** None.

#### NE-29s · Swift ForayClock, foray-progress rules, StructuralCheck, full MediaMapping — **M**
- **Milestone:** M2
- **Depends on:** NE-12s, NE-28s, NE-29j
- **Ask:** core/Policy/ForayClock.swift; ResumeRules gains the foray-progress thresholds and drift verdicts; Rows gains segment id plus offset; StructuralCheck (refused-structure); MediaMapping completes (narrationCredit, album 'Foray · clip N of M', the Foray clock position, seam and interlude reported as playing, a finished Foray reports none). Burn down the NE-29j families except default-voice, which NE-33 ports. Opens with `hold`.
- **Acceptance:** Equal counts and zero pending for foray-clock, foray-progress, foray-structure and media.
- **Device check:** None directly; H6 in NE-37.

#### NE-30j · Record manager-foray tape, the deck remainder, the authored prepare family, and the foray-playback mapping (JS) — **M**
- **Milestone:** M2
- **Depends on:** NE-14j, NE-21, NE-29j
- **Ask:**

  - Record the queue-manager Foray tape scenarios (seam timing, out-point from the manager, ladder at load, back-to-back same episode).
  - Record the remaining html-audio-backend rules into the deck family: warm-handover promotion (a wrong offset, a different item or a stale ready is never promoted; the outgoing element pauses before the incoming one plays; a pause mid-handover never restarts audio), and backwards same-episode slices.
  - Author the prepare family: seams compared at 'audible start of item N+1 at T with offset O', with the n.prepare: tokens asserted (not stripped). It is checked against reference-engine with warm handover on.
  - Map foray-playback.test.js (real curated Forays end to end) to scenario cases or named XCTests.

  Port card NE-30s (the DeckPair ones: NE-32).

- **Acceptance:** The families pass in JS (prepare against reference-engine). The guard shows zero unported entries for html-audio-backend and foray-playback, apart from those tagged NE-31j and NE-39j.
- **Device check:** None.

#### NE-30s · EngineCore for Forays, tape: playForay, in-points, the gate, seams, Foray transport, cp_foray — **L**
- **Milestone:** M2
- **Depends on:** NE-14s, NE-28s, NE-29s, NE-30j
- **Ask:**

  Extend EngineCore:
  - playForay with structural validation
  - the in-point rule; the gate at deck ready; approximate means skip with a skipped event and row
  - the seam beat stamped at the out-point (does not scale with rate; any transport action cuts it)
  - prepare eligibility; grace begin/end at the out-point and at a prepare miss
  - the out-point and natural ends both become itemEnded
  - Foray-clock transport through TransportPolicy; play on an ended Foray starts at 0; a Foray never chains
  - the cp_foray cadence

  Every change to a shared episode path sits behind an off-by-default EngineConfig flag until NE-37. Burn down manager-foray (tape), deck and prepare. Opens with `hold`.

- **Acceptance:** Equal counts and zero pending for manager-foray tape, deck and prepare. Mutation: start the next load after the beat, and a seam-timing case goes red. A-4 holds with two fake decks across 3 seams. With the flags off, the manager-episode family is unchanged.
- **Device check:** None directly; H-2 in NE-37.

#### NE-31j · Record the narration, interlude, jingle and tts-bridge scenarios (JS) — **M**
- **Milestone:** M2
- **Depends on:** NE-30j
- **Ask:** Record the L-05, L-03, interlude-manager and jingle scenarios from queue-manager.test.js. Map tts-bridge.test.js to speech-rate and lexicon family cases or named XCTests. Authored: exactly-once finished by seq; pause at a word boundary; stop never advances; a call during a bridge resumes on the next real item; audition refused while running. Port card NE-31s (speech-rate and lexicon: NE-33).
- **Acceptance:** The families pass in JS. tts-bridge has zero unported entries.
- **Device check:** None.

#### NE-31s · EngineCore narration, interlude and jingle overlays — **L**
- **Milestone:** M2
- **Depends on:** NE-30s, NE-31j
- **Ask:**

  Extend EngineCore:
  - the narrating overlay (speak(seq, script, voice, utteranceRate) at 1x — OQ-3, founder 2026-09-24 — behind narrationFollowsListenerRate = false; pause at a word; resume the same utterance; stop immediate; finished exactly once by seq; failed skips)
  - the wall-time narration clock
  - voice and fallback; the voiceId in the restore record
  - rendered narration at 1.0x
  - pendingRate
  - interlude arming, stretch and shrink, the ceiling timer
  - JINGLE at 1.0x
  - grace at narration end
  - the silence node commands (flagged off) capped at INTERLUDE_CEILING_SEC from the out-point, after which only grace covers
  - audition refused while running

  The session-invariant cases extend to speak, interludeStart and silenceStart. Opens with `hold`.

- **Acceptance:** The narration and interlude families pass on both sides with zero pending. Mutations: map cancel to finished and an L-05 case goes red; drop the seq check and exactly-once goes red; start the silence node while not running and session-invariant goes red.
- **Device check:** None directly; H5 in NE-37.

#### NE-32 · DeckPair: readiness-gated prepare and preroll on the standby deck; the windowed three-layer out-point — **L**
- **Milestone:** M2
- **Depends on:** NE-15, NE-25a, NE-25b, NE-30s
- **Ask:**

  Engine/DeckPair.swift, behind EngineConfig.deckPairEnabled (off until NE-37):
  - decks A and B, at most one audible
  - the standby deck loads through AVDeck's readiness-gated pipeline, runs the gate, seeks with zero tolerance, and prerolls at rate 0 while the current deck is audible
  - roles swap after the outgoing deck confirms paused; a miss degrades to an ordinary load
  - AssetCache shares an AVURLAsset per URL

  The out-point in AVDeck:
  - forwardPlaybackEndTime (+ stopPad from NE-25a)
  - a boundary observer
  - a single DispatchSourceTimer armed at (end − currentTime)/rate − 1.5 s, polling at 250 ms only inside that window, re-armed on seek and rate change
  - first to fire wins, per token; overshoot goes into the outPoint row; scrub-past sets .invalid and re-arms

  Packed seam rows. Precise timing per NE-25a. Simulator XCTests on click tracks: seam silence on a hit and a miss; never early at 1x and 2x; rate held across 3 swaps; audible count ≤ 1; no watchdog wakeups outside the window (timer fake). Opens with `hold`.

- **Acceptance:** Simulator tests are green: seam silence on a prepare hit ≤ `SEAM_GAP_SEC` (0.5 s since the founder's 2026-09-24 ruling) + 250 ms on local files; overshoot at 1x and 2x reported against the WebView baseline; never-early green; the watchdog fires only in the last-1.5 s window. The deck and prepare families' Swift runners pass through DeckPolicy.
- **Device check:** DV-4/H-2 in NE-37.

#### NE-33 · SpeechNarrator on the path DV-9 chose, SpeechRules with pickDefaultVoice, audition moved onto it — **L**
- **Milestone:** M2
- **Status (2026-09-29):** shipped in M2, and **demoted to the fallback** by the Spark direction (DECISIONS 2026-09-28, D1). A rendered line plays on the deck, and the SpeechNarrator speaks only a line whose file will not load, or a Foray with no rendered narration. No M3 work retargets it. DV-9 matters only for that fallback.
- **Depends on:** NE-25c, NE-27, NE-31s
- **Ask:**

  Read the DV-9 probe rows from the M1 issue first.
  - Move resolveVoice, bestVoice, candidates, lexicon/IPA application and pickDefaultVoice (the 2026-09-10 Samantha ruling) into core/Policy/SpeechRules.swift. ForayTts keeps a byte-identical copy of the shared code (node test). The lexicon JSON is bundled into foray-audio with a hash pin to foray-tts's hard-terms.json.
  - Engine/SpeechNarrator.swift (the Speaking seam) owns one synthesizer and never touches the session.
  - If DV-9 showed the session usable after speech: AVSpeechSynthesizer (usesApplicationAudioSession = true), pauseSpeaking(at: .word), continueSpeaking(), stop never maps to finished.
  - If not, or if DV-9 is inconclusive: write(_:toBufferCallback:) into AVAudioEngine plus AVAudioPlayerNode, with the same NarratorEvents, and AVSpeech behind a flag.
  - Audition moves from the M1 PreviewSpeaker onto SpeechNarrator.
  - Cold-path narration uses the restore record's voiceId, else pickDefaultVoice.

  Burn down speech-rate, lexicon and default-voice. Opens with `hold`.

- **Acceptance:** speech-rate, lexicon and default-voice pass on both sides with zero pending. The byte-identity test is green. The PR cites the DV-9 rows (issue link) for the chosen path. XCTests: pause and resume mid-utterance continues; stop does not advance; fallback reported; with no voiceId, the cold path picks the pickDefaultVoice result, never the bestVoice heuristic. ForayTts legacy tests are unchanged.
- **Device check:** H5/DV-9 re-check in NE-37.

#### NE-34 · InterludePlayer, seam BackgroundGrace, and the capped silence fallback — **M**
- **Milestone:** M2
- **Depends on:** NE-16g, NE-31s, NE-32
- **Ask:**

  - Engine/InterludePlayer.swift: one AVAudioPlayer on the bundled interlude-placeholder.wav, with a SHA-256 pin to player/assets/interlude-placeholder.wav, rate 1.0. It starts only after the audible-start invariant holds (fault row otherwise). The ceiling is an engine timer.
  - BackgroundGrace is extended to the seam beat, the narration handover and prepare misses (core commands from NE-30s and NE-31s).
  - The silence node (an AVAudioEngine source node rendering digital silence; timing only, L-3) sits behind a flag, off by default. It is hard-capped at INTERLUDE_CEILING_SEC from the out-point regardless of the load, and never runs when the state is not running or the session is not active.
  - Write the App Review note text (what the audio background mode plays) for NE-37.

- **Acceptance:** The hash-pin test is green. XCTests: the ceiling path fires when audioPlayerDidFinishPlaying never comes; grace begin and end counts match around synthetic seams and narration handovers; the silence node's lifetime never exceeds 4.5 s with a 20 s load (timer fake); the flag defaults off and its path runs in a test.
- **Device check:** H-2 grace= rows in NE-37; the flag is enabled in a follow-up only if a suspension is shown.

#### NE-35 · Page: native Forays, the capability gate, audition copy — **M**
- **Milestone:** M2
- **Depends on:** NE-22, NE-30j
- **Ask:**

  In native mode, when hello advertises 'foray':
  - the Foray start runs buildForayQueue in JS and sends playForay with startElapsedSec and voiceId (cp_voice, else pickDefaultVoice)
  - forayNext, Previous, Jump and Seek send intents
  - the strip, Foray page, mini bar, sheet and scrubber paint from the snapshot
  - the skipped event shows the existing copy
  - restoreForay attaches or uses restoreBar

  Without the 'foray' capability, the tap relinquishes (NE-22). native-mode.test.js cases against reference-engine.

- **Acceptance:** native-mode.test.js Foray cases are green: no Audio constructed; the playForay payload matches buildForayQueue exactly; audition is refused while running; relinquish happens only when 'foray' is absent. JS-mode suites are unchanged.
- **Device check:** H6 in NE-37.

#### NE-36 · ios-build native probe phase; existing phases pinned to legacy; reload clobber check — **M**
- **Milestone:** M2
- **Depends on:** NE-06, NE-30s, NE-32
- **Ask:**

  tools/mobile/probe gains '--phase native'. Before launch, it seeds ForayEngine.modeOverride=native with `xcrun simctl spawn <udid> defaults write ai.jwlabs.foura ForayEngine.modeOverride native` (no launch-argument input exists; pinned in ios-ci.test.mjs). It then:
  - calls engineSend playForay on a committed 3-segment local-file Foray
  - backgrounds the app for more than 90 s
  - kills the WebContent process mid-Foray (A-3)
  - reloads the WebView (W-8)
  - greps the engine subsystem's seam, outPoint and nowplaying rows

  It asserts:
  - no WebKit/MRMediaRemote publish line, no 'ForayAudio.setNowPlaying reached', no HTMLMediaElement construction
  - seams advanced; nowPlayingInfo was set
  - the UserDefaults cp_pos/cp_foray rows are unchanged by the reload

  The existing outpoint and seam phases seed modeOverride=web and are labelled 'JS lane (Android/web parity)' in the summary. A legacy-mode bridge smoke runs in every ios-build. The parser and tests live in tools/mobile (ios-ci.mjs). The workflow step goes to G-1b or a G-1c sitting. Silence reads as no-coverage, never as a pass.

- **Acceptance:** ios-ci.test.mjs covers the parser and the seeding, with its floor raised. With the step approved, an ios-build run reports each assertion with a run id, including the reload clobber check and the legacy smoke. Known Simulator limits are stated in the summary.
- **Device check:** None (Simulator).

#### NE-37 · M2 flip: advertise 'foray', the drive script, the App Review note — **S**
- **Milestone:** M2
- **Depends on:** NE-31s, NE-32, NE-33, NE-34, NE-35, NE-36
- **Ask:**

  Add 'foray', 'narration' and 'interlude' to ENGINE_DEFAULT.json capabilities, and turn on deckPairEnabled and the other M2 flags. coverage.test.js must show zero swift-pending and zero unported in every family mapped to 'foray'. Update the L-2 text if storage changed. No DECISIONS edit (NE-37d). A HUMAN-ACTIONS item naming ONE build, with the M2 script:
  - step 0 and the desk pre-flight
  - H-2: a 51-minute screen-off Foray drive
  - H5: narration pause and resume mid-sentence, locked
  - H6: tape, narration and pause never show '4a'; the narration → tape seam keeps the fields
  - DV-4, DV-5, DV-9 re-check and DV-10 read via engine-report.mjs
  - one parked Copy per block, pasted to the M2 issue

  Add the App Review note (NE-34 text) to the item for any external TestFlight or App Store submission.

- **Acceptance:** All M2 cards are merged and CI is green, including the capability gate. A TestFlight build number is recorded, and its archive --check log shows the capabilities.
- **Device check:** G-4: the engine report shows H-2 complete with no 'stop cause=unknown', seam 1 through the last seam present, and the LTE seam distribution; narration resumes mid-sentence; never '4a/Unknown'.

#### NE-37d · DECISIONS entry: Forays play natively on iOS (G-7) — **S**
- **Milestone:** M2
- **Depends on:** NE-37
- **Ask:** A separate docs/DECISIONS.md PR, founder-approved, batched with a label sitting.
- **Acceptance:** Merged with founder-approved and linked in STATE.md.
- **Device check:** None.

#### NE-37c · M2 catch-up with main after the M1 car test — **M**
- **Milestone:** M2
- **Depends on:** NE-37
- **Why:** `engine/m2` was held while the founder drove the M1 car test (#114, passed 2026-09-28 on build 2026092706). `main` moved on under it: #866 (AVDeck same-source reuse, the stall re-report, deck and Now Playing rows), audit round 3 (#835) and the Phase 2 rendered-narration rules (#867, founder rulings D1-D11). The parity guard then owed the `foray` capability 60 JS tests and 7 fixture cases.
- **Ask (done on the M2 PR):**
  - Merge `main` into `engine/m2` (AVDeck: both sides; see the merge commit).
  - #866 in the M2-only paths: the DeckPair's decks are AVDecks, so a same-source load on either (a seam between two clips of one episode, a prepare onto a standby that held that episode) is a seek in the held item; an out-point stop and the reuse keep the idle clock; the stall latch is PER ITEM in the core (cleared when an item ends, when a new load lands and when a spoken line starts); a Foray's Now Playing is a Foray's (client.js `mediaViewFields`: the Foray's title and "clip n of N", the Foray clock, a sounding line counting on instead of reading as a load at rate 0).
  - Audit round 3 in the engine: a speak() the player left is stopped (player-core-4/7), a bridge that lands or starts after a pause or a stop is not played (player-core-2), a line the output could not play advances at once (mobile-native-3), and the lexicon keeps one match per stretch (mobile-native-8). The rest hold by construction and are pinned by XCTests (xctest.json).
  - Phase 2 narration in the engine: a RENDERED line (a narration item with `audio_url`) plays on the deck like a clip at the LISTENER's speed (D2), and a tap during it lands at once; a spoken line stays 1x. A rendered line whose file fails (its load, a bridge's load, or mid-line) is read aloud from its script on the synthesiser (§14), on a fresh token so a late report about the file is dropped; a paused fallback line resumes its utterance.
- **Acceptance:** `coverage.test.js` green with nothing owed to `foray`; the new manager-foray, lexicon and speech-rate cases pass in Swift with `swift-pending.json` empty; ForayCatchUpTests, SpeechNarratorCatchUpTests and PositionFlushTests pass.
- **Device check:** HUMAN-ACTIONS #128 (the M2 drive): the car shows the Foray's title and a moving progress bar through clips and narration; a long pause and a call resume.

### Track M3 · Values from the field and completeness (re-planned 2026-09-29)

> **Re-plan, 2026-09-29.** The founder, 2026-09-29: *"It's going to be a while until I get to those human actions. keep progressing towards milestone 3 for both iPhone and android."* So M3 no longer waits for field data. Every value that needs the founder's rows ships now as a **provisional value taken from existing evidence**, marked `// MEASURE:`, with the row that will settle it and an `engine-report.mjs` verdict that reads that row. Only three cards need a human: NE-38f (the pastes), the NE-40 drive (G-6) and NE-40d (the label). No engineering card waits on any of them. The M2 drive (HUMAN-ACTIONS #128) is still pending, and M3 does not wait for it either.
>
> **What changed since this track was written (2026-09-23):**
> 1. **Narration is rendered centrally and played as files** (DECISIONS 2026-09-28, D1/D2; `docs/plans/spark-central-narration-assessment.md` §3.3, §4). A rendered line is an ordinary deck item, so its seams are ordinary deck seams (NE-45). On-device speech (NE-33's SpeechNarrator) is only the fallback. NE-42 loses its Kokoro half. The assessment's post-M2 list has five items:
>    - the fallback and the rendered rate: shipped in M2 (NE-37c);
>    - prepare across narration: NE-45;
>    - audition by URL: NE-47;
>    - `NarrationCache`: NE-48 (M4);
>    - append (on-demand): stays out of this deck until on-demand is scheduled.
> 2. **M2 review leftovers:**
>    - The clip after a rendered narration line is not prepared. `EngineCore.warmNextSegment` warms only a transition that gets a beat, and `SeamGap.gapSec` gives any seam with a line in it 0 s. So a clip → line → clip passage costs two cold loads. Fixed by NE-45.
>    - The silence node is built but off. The decision is NE-46.
> 3. **Field evidence, 2026-09-28** (the founder's paste on build 2026092706; PR #866):
>    - The stuck loads on a remote resume were same-source refetches, and #866 turned them into seeks.
>    - The 20 s load deadline (P-13) and AVDeck's 600 s reuse idle limit are provisional (`// MEASURE`).
>    - The Now Playing rate-0 latch is fixed, per item.
>
>    NE-38 and NE-38e carry this.
> 4. **The M1 car test passed** (#114, build 2026092706). After a day parked, the car's play resumed 4a. That happened under `pauseHoldPolicy = .forever` and with every load cold. It is the evidence behind NE-38's provisional OQ-12 default.
> 5. **NE-38r is only half done on `main`.** `EngineCore.onRoute` has a known-car resume branch, but it has five gaps:
>    - no JS reference and no fixtures: the JS one was deleted by player-core-10;
>    - it is keyed by the port's name;
>    - it covers only `.carAudio` (CarPlay). The founder's car is `BluetoothA2DPOutput` (paste row e#83);
>    - the set of known routes is in memory only;
>    - its guard (`case .interrupted(_, true)`) also matches a listener's own pause, because the reducer models a pause as `interrupted(wasPlaying: true)` (#866). That breaks the founder's Q5 rule that "a listener's pause is never resumed".
>
>    NE-38rj and NE-38rs finish it.
> 6. **The manager remainder is 18 tests, not about 70** (`player/parity/unported.json` at `32989b5c`). Seven of them are the warming rules that NE-45j rewrites, so NE-39j comes after NE-45j.
>
> **Branch and order.** The work happens on `engine/m3`, cut from `main` at `32989b5c`, with one PR per card into `engine/m3`. NE-40 merges `engine/m3` into `main` as one PR, as M2 did (#873). Every `s` card opens with `hold` (§12). At most two Swift PRs are open at once. Hard order:
>
> ```
> NE-38 ─┬─ NE-38e ─────────────────────────────┐
>        ├─ NE-46 ──────────────────────────────┤
> NE-38rj ─ NE-38rs ────────────────────────────┤
> NE-45j ─┬─ NE-45s ────────────────────────────┤
>         └─ NE-39j ─┐                          │
> NE-39n ────────────┼─ NE-39s ─────────────────┴─ NE-40 ─ (G-6 drive) ─ NE-38f ─ NE-40d
> NE-47 ─────────────┘
> ```
>
> **The Android twin** of this track is Track A4 in `docs/plans/android-assessment.md` §5.7 (A-60..A-69). A JS card here that records a new family also books that family in `player/parity/jvm-pending.json`, owed to its A4 card (`record.mjs --jvm-card`), so the JVM runner stays consistent.

#### NE-38 · Provisional field values now, and the rows that settle them — **M**
- **Milestone:** M3
- **Depends on:** NE-37 (M2 on `main`, #873)
- **Human-gated:** no. NE-38f is the gated half.
- **Files:**
  - `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/`: `AVDeck.swift`, `DeckPair.swift`, `AssetCache.swift`, `ForayEngine.swift`, `EngineBoot.swift`
  - `foray-engine-core/Sources/ForayEngineCore/Engine/`: `EngineCore.swift` and `DeckVocabulary.swift` (the load's deadline class)
  - JS first if a token is new: `player/engine-vocabulary.js` and the `diag-tokens` fixtures
  - `docs/ios-native-engine-measurements.md` (new §"Provisional values (M3)")
  - XCTests: `AVDeckTests`, `DeckPairTests`, `ForayCatchUpTests`
- **Ask:** Give every value below a named constant. Its header comment cites the evidence and names the row and the NE-38e verdict that settle it.

  | Value | Provisional | Evidence it rests on | Settled by (row → NE-38e verdict) |
  |---|---|---|---|
  | P-13 load deadline, clip or episode | **20 s**, unchanged, `// MEASURE` | Simulator cold first loads took 1.5–19.6 s (measurements §8.2). Warm loads took 0.2–1.2 s (§8.1, §10.1). In the field (2026-09-28), token 1 had its duration in 2.2 s and token 3 in 1.4 s. The only load past 19 s (token 2) was a same-source refetch, which #866 made a seek. | `deck kind=ready elapsedMs marks`, `deck kind=deadline step=` → `P13-clip` |
  | P-13 load deadline, rendered narration line | **8 s**, new, `// MEASURE` | A line is about 160 KB (64 kbps, about 20 s of speech), and warm AVPlayer loads take under 1.3 s. A line that fails falls back to speech (NE-37c), so a longer wait only lengthens a silence. | the same rows with `kind=line` → `P13-line` |
  | Reuse idle limit (`AVDeck.defaultReuseMaxIdleSec`, `AssetCache`) | **600 s**, unchanged, `// MEASURE` | #866's review: an item held for hours can report ready over an expired connection. M1's car win came from cold loads. | a `reuse idleSec=` followed within 30 s by `failed`, `deadline` or `stalled` on that token; `attach cold=stale idleSec=` → `reuse-idle` |
  | `lowBackgroundRemainingMs` | **5 s**, unchanged, `// MEASURE` | about one CDN load that goes wrong | `grace low=y` against the span's outcome → `resume-latency` |
  | `pauseHoldPolicy` (OQ-12) | **`.forever`**, unchanged (§9a default) | #114 passed on `.forever`. The HA #108 baseline shows a held session is necessary but not sufficient. The Developer "Pause hold: none" arm stays. | H-1 against H-1b rows → G-5 |
  | P-14 stall display | buffering once `time-control waiting reason=` holds (as shipped in #866) | #866 | `time-control` and `nowplaying via=rate` rows → `rate-latch` |

  - The core names a **deadline class** (`clip` or `line`) on the load it issues. AVDeck maps the class to seconds.
  - If the `.load` command's fields are recorded in the `deck`, `deck-episode` or `prepare` fixtures, the class goes in JS first: `deck-policy.js` gains `loadDeadlineClass(item)`. Re-record with `--port-card NE-38` and `--jvm-card` (the family's A-card).
  - The `deadline` row gains `class=`.
  - No behaviour changes for a clip.
- **Acceptance:**
  - `grep -rn "// MEASURE" mobile/plugins/foray-audio` lists exactly the table's constants. Each tag names its verdict.
  - XCTests on a fake clock:
    - a rendered line whose load is still pending at 8 s writes `deck kind=deadline class=line`, and the line falls back to speech on a fresh token;
    - a clip load that lands at 19 s does not time out;
    - a prepared (standby) line uses the line class too.
  - The measurements doc carries the table.
  - `record.mjs --check` and `coverage.test.js` are green, and so are ios-kit, engine-parity and ios-gate on the head SHA.
- **Device check:** none. NE-38f reads the pastes.

#### NE-38e · `engine-report.mjs` learns the M3 verdicts — **M**
- **Milestone:** M3
- **Depends on:** NE-38 (the row fields). It can start in parallel against the grammar named here.
- **Human-gated:** no. JS only, so it runs on Windows.
- **Files:** `tools/mobile/engine-report.mjs`, `tools/mobile/engine-report.test.mjs`, a fixture paste under `tools/mobile/fixtures/` (synthetic, title-free), and its floor in `test/suite-integrity.test.js`.
- **Ask:** Add these verdicts. Each is `pass`, `fail` or `no-coverage`, and it cites its rows. **Silence is `no-coverage`, never a pass.**
  - `P13-clip` and `P13-line`: n, p50, p95 and max of `deck kind=ready elapsedMs` for cold loads (`attach cold=`), split by `access wwan>0`. Every `deadline` row with its `step` and `class`. A **proposal** (p95 × 2, rounded up to whole seconds, never below the observed max) is printed and never applied.
  - `reuse-idle`: every `reuse` with `idleSec`, and whether a `failed`, `deadline` or `stalled` followed on that token within 30 s (the risk). Every `attach cold=stale` with its `idleSec` (what the limit cost).
  - `rate-latch` (the #866 regression check): fail on any span over 3 s in which `nowplaying engineState=playing buffering=n` publishes `rate=0` while `elapsedSec` advances.
  - `resume-latency`: `grace heldMs` for `remote-play` and `route-resume`, split by `cold` against `reuse`.
  - `route-back` (NE-38rs): for each `route kind=back`, the decision, `known`, `lostSec`, and the ms until the next `remote play` (the car's own press). This answers whether the Bluetooth arm is needed.
  - `seam-kinds` (NE-45s): the seam distribution, split `clip→clip`, `clip→line` and `line→clip`, with `prepare=hit|miss|none`.
  - `suspension-in-seam` (NE-46): `grace kind=late inSeam=y` rows.
  - `narration-fallback` (NE-39n): counts by `cause`.
  - `dup` (DV-6, NE-39s): the `dupCandidate=y` count and the ms between presses of one command.
- **Acceptance:**
  - A test per verdict on synthetic pastes, covering pass, fail and no-coverage.
  - A title-free excerpt of the 2026-09-28 paste (rows e#75–e#103) gives `no-coverage` for every new verdict, because it predates the rows. It never gives a pass.
  - The CLI is executed on the fixture, and the output is quoted in the PR.
- **As built (2026-09-29):** the fixtures are `tools/mobile/fixtures/engine-report/2026-09-28-excerpt.txt` (all ten no-coverage) and `m3-drive-synthetic.txt` (all ten pass, printed through the real `engineLineFor`). Rules the card left open, each stated in the tool's header:
  - A load with no `class=` (an M2 row) reads as `clip`; the report counts them. A `P13-*` fail is a deadline row of that class, or a proposal above the shipped value.
  - `resume-latency` counts only spans with a `deck attach` (cold) or `deck reuse` inside them, and fails on `grace expired`.
  - `rate-latch` ignores a jump larger than the span could play (a seek). It judges `buffering=y` spans too, because a stuck `buffering=y` while audio plays is the #866 latch itself: such a span fails when the clock ran at least half its wall time, or when the deck's latest `deck time-control` row said `status=playing` for over 3 s inside it (this also judges a span still open when the Copy was taken). An honest stall has the deck waiting and the clock still. A relaunch ends a span.
  - `route-back` fails on a resume of a pause the route did not cause (Q5), a silent resume, or `why=bluetooth-off` on a known route with no car `remote play` within 30 s.
  - `seam-kinds` reads `prepare=hit` (the standby was promoted), `miss` (prepared, still loaded cold) and `none`. It fails on `miss`, on a line→clip seam that was not prepared and on a never-audible seam. On an evicted ring a pass reads `incomplete`, as DV-2 does. NE-45s writes these tokens.
  - `suspension-in-seam` needs the detector in the build (a `grace late` row, or a `deck` row with `class=`) and a seam held in the background.
  - `dup` is no-coverage unless two presses of one command are within 1 s, because the 2026-09-28 plays 5 s apart say nothing about a window. It fails under 150 ms, which is faster than a hand (provisional).
  - `--strict` also exits 1 on an M3 fail. A test pins the judged values to the Swift constants and checks that every `// MEASURE: verdict=` names a verdict.
- **Device check:** none.

#### NE-38f · Settle the values from the field — **S**
- **Milestone:** M3
- **Depends on:** NE-38e, and the pastes from HUMAN-ACTIONS #128 (the M2 drive) and the NE-40 drive (G-6)
- **Human-gated:** **yes (input only).** It runs when the pastes exist, and nothing else waits on it.
- **Files:** the constants NE-38 tagged, `docs/ios-native-engine-measurements.md`, any re-recorded fixture, and `STATE.md`.
- **Ask:** This is the old NE-38 work.
  - Run `engine-report.mjs` over each paste.
  - Replace each `// MEASURE` value with its verdict's proposal, or keep it with a dated reason ("n = 3, too few").
  - Record in the measurements doc:
    - DV-5's in-point error and the outPoint overshoot, per item kind;
    - the H-1 against H-1b summary and the `secondaryAudioShouldBeSilencedHint` data, for OQ-12 (G-5).
  - Apply the founder's OQ-12 ruling, or keep `.forever` and say so.
  - Re-record any fixture whose constant changed, JS first.
- **Acceptance:**
  - The headers cite issue-linked pastes and run ids.
  - No bare `// MEASURE:` tag remains; each one kept has a dated reason.
  - The fixtures are green in JS, Swift and the JVM books (`record.mjs --check`).
  - The OQ-12 ruling or default is in `STATE.md`.
- **Device check:** the pastes themselves.

#### NE-38rj · Route resume, the JS reference: a pure policy and the `route-resume` family (JS) — **M**
- **Milestone:** M3
- **Depends on:** NE-37
- **Human-gated:** no.
- **Files:**
  - `player/route-resume.js` (new and pure). It is **not wired** into `queue-manager.js` or `client.js`: the web and Android JS lanes keep "a reconnect never resumes" (player-core-10).
  - `player/route-resume.test.js`
  - `player/parity/fixtures/route-resume/*.json`, `manifest.json`, `capabilities.json` (an `episode` rule, but charged to the unadvertised `remainder` gate while it is owed: the M2 build advertises `episode`, which may owe nothing; NE-38rs moves it), `coverage.js` `COVERED_SUITES`
  - the books: `swift-pending.json` (`--port-card NE-38rs`) and `jvm-pending.json` (`families["route-resume"] = "A-61"`, `--jvm-card A-61`)
  - `tools/parity/gen-constants.mjs` (the two constants)
  - the floor in `test/suite-integrity.test.js`
- **Ask:** `routeResumeDecision({ pausedBy, lost, back, known, lostAgoSec, bluetoothArm })` → `{ resume, why }`, plus `routeClass(portType)` and `routeKey(portType, uid)` (the key is hashed by the caller).
  - `pausedBy` is one of `route`, `listener`, `interruption`, `system` or `none`.
  - The classes:
    - `car`: `CarAudio`;
    - `bluetooth`: `BluetoothA2DPOutput`, `BluetoothHFP` and `BluetoothLE`;
    - `other`: everything else.
  - The rule is the founder's Q5 (DECISIONS 2026-09-25). Resume only when every condition below holds:
    - the last pause was the loss of **that** route (same key);
    - the route is known: it carried audible playback of ours;
    - the loss is at most `ROUTE_RESUME_MAX_LOST_SEC` old: **24 h provisional, `// MEASURE`** ("after a day at work", #114, is about 9–10 h; a night parked is about 14 h);
    - the route's class allows it: `car` always; `bluetooth` only with `bluetoothArm` on (**provisional OFF, `// MEASURE`**); `other` never.
  - Why the Bluetooth arm is off: the founder's car is A2DP and sends its own play 7.4 s after connecting (2026-09-28 paste, e#83 → e#85). AirPods are A2DP too. An automatic resume would race the car's press and misfire on headphones.
  - A listener's pause, a call, Siri, or any press after the loss clears eligibility. At most one resume per loss.
  - Export `ROUTE_RESUME_MAX_LOST_SEC` and `ROUTE_RESUME_BLUETOOTH_DEFAULT`.
  - Record at least 12 cases:
    - route lost, then a known car back → resume;
    - a listener's pause, then the car lost and back → no;
    - a call during the loss → no;
    - an unknown car → no;
    - Bluetooth with the arm off → no, and with it on → yes;
    - a loss 25 h old → no;
    - a different car back → no;
    - a second route-back after a resume → no;
    - a back while a load is pending → exactly one resume;
    - headphones (`other`) → no;
    - a route lost while already paused → no.
- **Acceptance:**
  - The family passes in JS (`record.mjs --check`).
  - It is pending for NE-38rs in `swift-pending.json` and owed whole to A-61 in `jvm-pending.json` (the `--check` books rule).
  - `coverage.test.js` is green.
  - `--mutate` on the listener rule turns a case red.
  - A pin test proves `queue-manager.js` and `client.js` do not import `route-resume.js`.
- **Device check:** none.

#### NE-38rs · Route resume in the engine: port the policy, key by port type and UID, persist, rows — **M**
- **Milestone:** M3
- **Depends on:** NE-38rj, NE-38 (the vocabulary edit, to avoid a conflict)
- **Human-gated:** no. The NE-40 route block is the device check.
- **Files:**
  - `foray-engine-core/Sources/ForayEngineCore/Policy/RouteResume.swift` (new)
  - `Engine/EngineCore.swift`: `onRoute` rewritten over the policy, with `pausedBy` tracked
  - `Engine/EngineState.swift`
  - `Engine/EngineInput.swift`: `RouteChange` gains `portUID` and the class
  - `ForayAudioPlugin/Engine/AudioSessionOwner.swift`: the `routeChange` classifier fills them
  - `Engine/EngineStore.swift`: a private key, `ForayEngine.knownRoutes`
  - `mobile/ENGINE_DEFAULT.json` and the `EngineConfig` flag `routeResumeBluetooth: false`
  - the `ForayEngineParity` runner for `route-resume`
  - `player/parity/capabilities.json`: move `route-resume` from `remainder` to `episode` (NE-38rj parked it there while owed), and the NE-38rj test in `coverage.test.js` with it
  - XCTests: `RouteResumeTests`, `AudioSessionOwnerTests`
- **Ask:**
  - Replace the current branch with the policy.
  - A route becomes known once our audio has played through it for at least 1 s (a `.playing` time-control while it is the current route).
  - Keys are a salted SHA-256 of port type and UID. At most 8 are kept (least recently used goes first), and they persist in `EngineStore` private keys, never in `CapacitorStorage`.
  - Rows:
    - `route kind=lost port= key=<8 hex> known=`
    - `route kind=back port= key= known= lostSec= pausedBy= decision=resume|no why=`

    Never a name or a raw UID (DiagGate).
  - A resume is `begin(.routeResume, source: .autoresume)`, with grace, like a car's press.
  - `lostSec` is measured on the wall clock (`Date()`), never on uptime (`ProcessInfo.systemUptime`, `DispatchTime`), which stops while the phone sleeps: a phone asleep overnight in a parked car would otherwise read a two-day loss as minutes old (route-resume.js, THE CLOCK). A negative age is refused.
  - Burn down `route-resume`. Opens with `hold`.
  - The reference is `routeResumeDecision` plus the reducer `routeResumeStep` (replayed by `routeResumeReplay` in the `sequences` fixtures): the reducer is how `pausedBy` and the one-resume-per-loss rule are tracked, so `EngineCore` tracks them the same way.
- **Acceptance:**
  - `route-resume` passes in the Swift runner, with nothing pending.
  - XCTests:
    - a listener's pause, then the car lost and back → no resume. The PR quotes this test failing against `main`'s branch before the port;
    - CarPlay lost and back → exactly one resume, with an activation and grace;
    - A2DP with the flag off → `decision=no why=bluetooth-off`;
    - the known set survives an `EngineStore` reload;
    - no row carries the raw UID.
  - ios-kit, engine-parity and ios-gate are green on the head SHA.
- **Device check:** the NE-40 route block.
- **Status 2026-09-29 (PR #904):** ported. `RouteResume` (Policy/RouteResume.swift) is route-resume.js line for line, plus the salted SHA-256 (plain Swift: the core is Foundation-only and runs on Linux), the LRU known set and its stored form `{v, salt, keys}`. The salt is per install and lives in `ForayEngine.knownRoutes` beside the keys, so a purge takes both; the host writes the key whenever a turn changes the set and removes it when the set is empty. The current route reaches the core as `EngineNow.route` (`SessionControlling.currentRoute`), which is how a `.playing` deck is heard through it. The Bluetooth arm ships through `mobile/ENGINE_DEFAULT.json` `ios.routeResumeBluetooth` → plist `ForayEngineRouteResumeBluetooth` → `EngineConfig.routeResumeBluetooth`. `route-resume` moved from `remainder` to `episode` with nothing pending; A-61 still owes the JVM port.

#### NE-45j · Prepare across narration seams, the JS reference (JS) — **M**
- **Milestone:** M3
- **Depends on:** NE-37
- **Human-gated:** no.
- **Files:**
  - `player/deck-policy.js`: a new pure `warmsAcross({ from, to })`
  - `player/queue-manager.js` `_warmNextSegment`: `warmsAcross` replaces the `seamGapSec(seam) > 0` gate
  - `player/seam-gap.js`: its "warming follows the beat" coupling note now points at `deck-policy.js`
  - `player/parity/reference-engine.js`: `WarmingBackend` warms on a natural end too
  - `player/parity/fixtures/prepare/*` — as built, a sibling family `player/parity/fixtures/prepare-narration/` (`seams.json`: authored engine seams; `policy.json`: `warmsAcross` and the duration window). `prepare` is charged to `foray`, which the M2 build advertises and which may owe nothing, so the new ids could not be pending there; the family is parked under the unadvertised `remainder` gate, keeps its `n.*` tokens (`NATIVE_TOKEN_FAMILIES`, JS, Swift and Java), and NE-45s moved it to `foray`. A same-source prepare on the standby is written `n.prepare-seek:<id>@<s>`.
  - `queue-manager.test.js`: the two warming tests that assert the old rule ("a bridged seam is not warmed", "warming follows the SAME rule as the beat") are re-authored to the new rule
  - `deck-policy.test.js`
  - the books: `swift-pending.json` (`--port-card NE-45s`) and `jvm-pending.json` (`prepare` stays owed whole to A-40, which A-25 handed it to; once A-40 has ported it, new ids are `cases` owed to A-62)
- **Ask:** The new rule:
  - The next item is warmed when it has a file (a clip, or a rendered line with `audio_url`), whatever the beat.
  - A spoken (script-only) line warms nothing. The item after a spoken line is warmed when the line **starts**, because the standby deck is idle while the synthesiser speaks.
  - For an item with no out-point (a rendered line, or an episode's natural end), the window opens `PREFETCH_LEAD_SEC` of wall clock before its duration ends. An item shorter than the lead is warmed when it starts.
  - The Foray's last item warms nothing, as today.
  - Author a `prepare` case for clip → line → clip where both clips come from one episode: the standby still holds that episode, so the prepare is a same-source seek.
  - **The web lane does not change.** `HtmlAudioBackend` prefetch stays parked, and a pin test proves no warm reaches it.
- **Acceptance:**
  - `prepare` is re-recorded and green in JS, with its new ids pending for NE-45s.
  - `record.mjs --check` and `coverage.test.js` are green.
  - `--mutate` back to the beat rule turns a clip → line case red.
  - The web pin test is green.
- **Device check:** none.

#### NE-45s · Prepare across narration in the engine: a rendered line's seams are deck seams — **L**
- **Milestone:** M3
- **Depends on:** NE-45j, NE-38 (the `line` deadline class)
- **Human-gated:** no.
- **Files:**
  - `EngineCore.swift`: `warmNextSegment` over `DeckPolicy.warmsAcross`, plus the warm at a spoken line's start
  - `DeckPolicy.swift`
  - `AVDeck.swift`: a window with no out-point, taken from the duration
  - `DeckPair.swift`: promotion of a prepared rendered line, and a standby prepared under a spoken line
  - `EngineCommand.swift`: no `narrationPulse` on a rendered line
  - the packed `seam` rows
  - XCTests: `DeckPairTests`, and `ForayCatchUpTests` extended
  - the Swift `prepare` runner
- **Ask:**
  - Port NE-45j (`prepare-narration`: burn it down, then move it from `remainder` to `foray` in `capabilities.json`, with the NE-45j test in `coverage.test.js`). A rendered line becomes an ordinary deck item from end to end:
    - it is prepared on the standby and swaps like a clip;
    - its seam row is packed like a clip's (`seam from=clip|line to=clip|line prepare=hit|miss|none`);
    - its load uses the `line` deadline class;
    - it gets no `narrationPulse`, because the deck has a position.
  - A prepared line whose file fails falls back to speech at its turn, exactly as a cold one does (NE-37c's fresh-token rule).
  - Opens with `hold`.
  - *As built:* `prepare-narration` passes in Swift (`PrepareNarrationFamily`: the `deck-policy.js` half through the deck-pair readers plus `warmsAcross`, the seams through the engine-target driver, whose standby now remembers its source and whose window opens from a duration and at a load's first play) and moved from `remainder` to `foray`. Every seam packs one row (`EngineCore.packSeamRow`, from a `SeamMark` stamped at the item's end): `from`, `to` and `prepare=hit|miss|none` are appended after the old fields. A rendered line's end in the background holds the same `seam`/`prepare-miss` grace a clip's out-point does. The DeckPair's `prefetch` row gains `reuse` (a same-source prepare on the demoted deck) and `class`. A spoken line followed by a clip from the same source as the clip before it reads `prepare=none` (the playing deck seeks the source it holds), not a miss.
  - *M3 review (2026-09-30):* a WHOLE episode is never prepared. The duration window also opens at a plain episode's natural end, and `warmsAcross` (JS, Swift, the `prepare-narration` policy cases) now answers false when `to` is neither a narration line nor a bounded slice, so M1's episode-to-episode continuation (car-proven, #114) stays a cold load at the next episode's own resume position, as it was before NE-45s (the old `seamGapSec > 0` rule never warmed one). A prepare at offset 0 would have fetched the episode with precise timing and then missed on any episode resumed part-way.
- **Acceptance:**
  - `prepare` passes in Swift, with nothing pending.
  - Simulator XCTests on local files:
    - on prepare hits, clip → rendered line → clip has seam silence ≤ `SEAM_GAP_SEC` + 250 ms at each boundary, and the second clip has no cold `attach` (it was prepared during the line);
    - the clip after a spoken line is `prepare=hit`;
    - at most one deck is audible at any time;
    - a prepared line whose file returns 404 falls back to speech at its turn, with no early audio.
  - ios-kit, engine-parity, ios-gate and ios-shell are green.
- **Device check:** the NE-40 rendered-Foray block, once a Foray with rendered narration exists (Spark Phase 1).

#### NE-39j · Record the manager remainder (18 tests) (JS) — **M**
- **Milestone:** M3
- **Depends on:** NE-45j (7 of the 18 are warming rules it rewrites)
- **Human-gated:** no.
- **Files:**
  - `player/queue-manager.test.js`
  - `player/parity/fixtures/manager-remainder/*` (the family `unported.json` names)
  - `exclusions.json`
  - `unported.json`
  - the books: `swift-pending.json` (`--port-card NE-39s`) and `jvm-pending.json` (`manager-remainder` stays owed whole to A-40)
- **Ask:** Record every `queue-manager` test still in `unported.json`. There were 18 at `32989b5c`: 7 warming, 2 position timer, 2 rate getter, player-core-7 and player-core-9, 2 round-2, an unknown ref, and a backend with no prefetch. The recorder gives the real count.
  - Tests that only make sense for the WebView (the position timer while the ELEMENT plays, and a backend with no prefetch) go to `exclusions.json`, one entry each, with its closed reason.
- **Acceptance:**
  - `queue-manager` has no unported entries.
  - The cases pass in JS and are pending for NE-39s.
  - `coverage.test.js` is green.
- **Device check:** none.
- **Status (2026-09-29):** built on `engine/m3`. The recorder's count was **22**, not 18 (NE-45j added four `NE-45j:` warming tests). 20 are recorded as 22 `manager-remainder` cases (`warming.json` 14, `transport.json` 8), all `manager` target, all pending for NE-39s; the family stays owed whole to A-40. Two are excluded: "a backend with no prefetch is never asked for one" (`js-module-shape`: DeckPair always prepares) and "the position timer also runs while the ELEMENT plays behind a paused machine" (`webview-only`: every native remote press is an engine command). `unported.json` now holds nothing; NE-39s deletes it. Harness additions (`runner.js`, `fakes.js`, schema): `setup.backend.prefetch` (`true` or `"loses"`: the op `prefetch:<id>@<s>` is the manager's ASK, not the deck's decision) with a `deck: "window"` step, `coldLoadMs` on the manual clock, `slowFirstPlay`, `tts.pause: "held"` with `tts: "releasePause"`, `setup.settledEvents` (`event.settled:<state>`), `setup.telemetry: ["rate.snapped"]` (`telemetry:<line>`; the engine's `rate kind=snapped` row), and the `positionTimer` view. **For NE-39s:** the Swift `EngineScenarioDriver` refuses setup keys it does not know, so the port teaches it these; `prefetch:` maps to the engine's DeckPair prepare request (not its `n.prepare` decision), `event.settled` to the snapshot turn, `telemetry:rate.snapped` to the `rate kind=snapped` diagnostics row.

#### NE-39n · The car's own Next over narration, and the fallback's cause (retargeted) — **M**
- **Milestone:** M3
- **Depends on:** NE-37c
- **Human-gated:** no.
- **Files:**
  - JS first: `player/media-session.js` and `player/queue-manager.js` (Next), `player/engine-vocabulary.js` (causes), the `media` and `manager-foray` fixtures
  - then Swift: `EngineCore.swift` (the remote's next, and the fallback row) and `MediaMapping.swift`
  - XCTests
- **Ask:** Part (2) of the old card, the narration warm, is now NE-45.
  - **(1) Next.** The engine's own Next (car and lock screen) steps over narration lines. The web lock screen's Next lands on them. **Provisional ruling: the engine follows the JS reference**, so Next goes to the next item, a narration line included. That is one behaviour on every surface.
    - Record `nexttrack` cases: from a clip whose next item is a line (lands on the line), and from a line (lands on the next clip).
    - The manager's `skipToNext` scenarios move with it, JS first, then Swift.
  - **(3) The fallback's cause.** The `narration kind=fallback` row gains `cause=`, one of `timeout`, `http-4xx`, `http-5xx`, `offline`, `decode` or `other`. It is mapped from AVDeck's `failed` and `deadline` fields (error domain and code, `logStatus`), as tokens only, JS vocabulary first.
- **Acceptance:**
  - The fixtures are green in JS and in Swift, with nothing pending.
  - An XCTest maps each cause from a synthetic deck failure.
  - The Next decision is recorded in `STATE.md`, with the JS citation.
- **Device check:** the NE-40 rendered-Foray block (Next during a line; airplane mode during a line).

#### NE-46 · The silence-node decision: it stays off, and a row that would show the suspension it exists for — **S**
- **Milestone:** M3
- **Depends on:** NE-38
- **Human-gated:** only the enable flip, and only on evidence. The card itself is not gated.
- **Files:** `EngineCore.swift` (timer lateness), `BackgroundGrace.swift`, `SilenceNode.swift` (its header states the decision rule), `EngineConfig`/`ENGINE_DEFAULT.json` (a pin), and XCTests.
- **Ask:**
  - **Decision (provisional): `silenceNodeEnabled` stays false.** Four reasons:
    - App Review 2.5.4 (R21);
    - no suspension inside a seam has been observed, neither in the M1 car test nor in the 2026-09-28 paste;
    - BackgroundGrace holds a task across every silent span;
    - NE-45 shrinks silent spans to the beat.
  - **Add the detector.** Every engine timer that fires while grace is held (the seam beat, the silence cap, the narration tick, a load deadline) compares its due time with now. If it is late by more than `NARRATION_SUSPEND_GAP_MS` (5 s, an existing constant), it writes `grace kind=late timer= lateMs= inSeam=y|n bgRemainingMs=`.
  - **The rule for turning it on:** only if a drive shows at least one `grace kind=late inSeam=y`, meaning a suspension inside a silent seam despite grace. The change is a one-line flag PR that cites the paste, and the App Review note (NE-34) must already be in the submission notes.
- **Acceptance:**
  - XCTests on a fake clock: a seam-beat timer delivered 6 s late while grace is held writes the row; one 4 s late does not.
  - A pin test shows the flag defaults to false.
- **Device check:** the `grace` rows of #128 and the NE-40 drive (NE-38e `suspension-in-seam`).

#### NE-47 · Audition by URL: the voice preview plays a rendered file on the engine — **M**
- **Milestone:** M3
- **Depends on:** NE-37
- **Human-gated:** no.
- **Files:**
  - JS first: `player/engine-contract.js` (`audition` gains an optional `url`: https, on the narration host), the contract schema, the `contract` fixtures, `player/parity/reference-engine.js`
  - then Swift: `ContractDecoding.swift`, `EngineCore.swift`
  - XCTests
  - `PreviewSpeaker.swift` is unchanged
- **Ask:** This is Spark §3.3: the preview plays `preview.m4a`.
  - An audition that carries a `url` plays on a deck. The tap's own user-caused activation covers it.
  - It is refused with `engine-busy` while running, as today.
  - A preview that fails to load falls back to `PreviewSpeaker` speaking the text.
  - An audition with no `url` stays on `PreviewSpeaker` (the Apple voice is the fallback).
  - **The page sends `url` only once the picker offers rendered voices** (the Spark voice-picker card, KV-06/KV-12 retargeted). Until then nothing changes on the page.
- **Acceptance:**
  - The contract cases pass in JS and in Swift.
  - XCTests:
    - a `url` audition loads on the deck and activates once;
    - it is refused while running;
    - a 404 falls back to speech;
    - a no-`url` audition is byte-identical to today.
- **Device check:** none until the picker ships rendered voices.
- **Status (2026-09-29):** built on `engine/m3`. The contract admits `url` only as a plain path on `NARRATION_PUBLIC_BASE` (`https://audio.jwlabs.ai`, held equal to `render-profile.json`); the preview plays on a PREVIEW deck of its own (`EngineSeams.preview`, an `AVDeck` whose rows say `lane=preview`), so a paused Foray's item on the main deck is untouched; the next play, a stop, a relinquish or the teardown cut it. A load past `EngineBoot.previewLoadDeadlineSec` (6 s, `// MEASURE` from the `lane=preview` time-to-ready rows) or a failure is spoken instead, with an `audition kind=fallback` row. Fixtures: `manager-foray/audition-url-*` and seven `contract/send-request-*-audition-*` cases. `PreviewSpeaker` is now `SpeechNarrator` (NE-33); its audition path is unchanged.

#### NE-39s · Swift burn-down; delete `swift-pending.json` and `unported.json`; the de-dup decision — **L**
- **Milestone:** M3
- **Depends on:** NE-39j, NE-38rs, NE-45s, NE-39n, NE-47. Every M3 JS card's Swift port has to land first, because once the lists are deleted nothing may be owed.
- **Human-gated:** no.
- **Files:** the Swift runners and ports for `manager-remainder`; `player/parity/swift-pending.json` and `unported.json` (deleted); `coverage.test.js` (requires both absent); and `EngineCore.swift` / `RemoteSurface.swift` only if the de-dup decision changes.
- **Ask:**
  - Port the NE-39j cases. Empty and delete `swift-pending.json` and `unported.json`.
  - `jvm-pending.json` **stays**: it is Android's book (A-63).
  - **De-dup (DV-6), provisional decision: keep it record-only, with no drop guard.** The iOS native path's 500 ms window stays until NE-41.
    - Evidence: every remote row in the 2026-09-28 paste has `dupCandidate=n`.
    - The car's repeated plays (e#85 and e#89, 5 s apart; e#116/118/120) are separate presses seconds apart, retries of a silent resume. A guard wide enough to catch them would drop real presses.
    - NE-38e's `dup` verdict settles it later.
  - Opens with `hold`.
- **Acceptance:**
  - The manager family's JS and Swift counts are equal.
  - Neither pending file exists, and `coverage.test.js` requires that.
  - The de-dup evidence is linked in the PR and drafted for NE-40d.
- **Device check:** reads the DV-6 rows.
- **Status (2026-09-29):** built on `engine/m3`. The Swift `ManagerRemainderFamily` runner (the Foray tape on) runs `manager-remainder` whole: **20 cases, JS 20 = Swift 20**. The first CI run passed 18 of the 22 NE-39j cases as they stood. The other four went like this:
  - **Stop behind a paused machine (player-core-7) was a real gap.** `EngineCore.stop` now pauses a deck that is audible while the machine says stopped, by the deck's own word, as `pause()` already did.
  - **The unknown ref** is re-recorded onto a path both sides share: an OS interruption pauses `a`, the queue is replaced, and the interruption's end resumes `a`, which errors to idle. Deleting the JS error path turns the case red.
  - **Player-core-9 and round 2's `onStateSettled`** pin how the JS manager's awaits interleave: a load parked on the synthesiser's pause, and the hook counted per `_handle` frame. A synchronous native turn has neither. Both cases moved, expects unchanged, into a new `jsOnly` family, `manager-await`, which is charged to `foray` and owed to no book. `mutations.json`'s stale-load rule is killed there. Their native forms are XCTests: `ForayCatchUpTests/testTwoNextsFromASpokenLineLoadTheNewestTargetAndTheFirstLoadPlaysNothing` and `ForayEngineHostTests/testTheSurfaceIsToldAfterEveryInputTheNaturalEndIncluded`.

  The driver learned NE-39j's manager-target shapes: backend `prefetch` (the core's `.prepare` logged as the ask `prefetch:<id>@<s>`, a warm key landing at once), `deck: "window"` (`.prepareWindow`), `coldLoadMs` on the manual clock (the `load:` op written when it lands), `slowFirstPlay`, `telemetry: ["rate.snapped"]` (from the `rate kind=snapped` row) and the `positionTimer` view. It refuses `settledEvents` and `tts.pause: "held"` with the reason.

  `swift-pending.json` and `unported.json` are deleted:
  - `coverage.js` loads both as empty;
  - `record.mjs` refuses `--port-card` and `--classify`, and `--check` is red on either file coming back;
  - `ParityData.load` (Swift) refuses a tree holding either;
  - the JVM loader tolerates `unported.json`'s absence.

  `remainder` is retired and `jvm-pending.json` stays (A-63). De-dup: record-only, no change to `EngineCore`/`RemoteSurface`; the entry for NE-40d is drafted below.

#### NE-40 · Stop-cause audit, the `.longFormAudio` trial flag, the M3 merge and build, and the M3 script — **M**
- **Milestone:** M3
- **Depends on:** NE-38, NE-38e, NE-38rs, NE-39s, NE-45s, NE-46
- **Human-gated:** the drive (G-6) only. The audit, the flag and the merge are not gated.
- **Files:**
  - the stop paths in `AVDeck.swift`, `DeckPair.swift`, `SpeechNarrator.swift`, `InterludePlayer.swift`, `AudioSessionOwner.swift`, `BackgroundGrace.swift`, `SilenceNode.swift` and `EngineCore.swift`
  - `StopCauseTests.swift` (new)
  - the `EngineConfig` flag `routeSharingLongForm`
  - the Developer drawer toggle (`app.js`, through the existing `setModeOverride`-style bridge)
  - `docs/native-engine-m3-drive-test.md` (new)
  - `HUMAN-ACTIONS.md` (one new item)
- **Ask:**
  - **Stop-cause audit (D-5).** Every path that stops audio writes a cause row before the stop. That covers AVDeck, DeckPair, the SpeechNarrator (fallback only now), InterludePlayer, the session observers, grace expiry, the silence cap, the route policy and the line deadline. Every `stop cause=unknown` in the pastes gets a named cause or a follow-up card.
  - **`.longFormAudio` (DV-8)** goes behind `routeSharingLongForm`, **default OFF, `// MEASURE`**.
    - M1's car win happened on the default route-sharing policy, so the default does not change without a drive.
    - A Developer toggle lets the drive trial it, and `build routeSharing=` goes in the Copy header.
  - **Merge `engine/m3` into `main`** as one PR (as #873 did), with CI green. If it touches denied paths, it waits for `founder-approved`; never self-apply it. Record the TestFlight build number.
  - **The M3 script:** `docs/native-engine-m3-drive-test.md`, plus a HUMAN-ACTIONS item that is ready to issue.
    - It names ONE build.
    - Step 0: the Copy header shows that build with `engine=native` and `strikes=0`, and TestFlight automatic updates are off.
    - The 10-minute desk pre-flight comes first.
    - One parked Copy per block, pasted to the M3 issue.

    The blocks:
    1. **DV-7a (REQUIRED):** play, pause, lock, background the app, then Developer → "Simulate system termination". Then press the car's play. Expected: 4a plays, with `launch=background`.
    2. **DV-7b (recorded only):** force-quit 4a from the app switcher, then press the car's play. Expected: *not* 4a.
    3. **Route resume (NE-38r):**
       - Play in the car and switch the car off while 4a plays. Wait at least 10 min, then switch the car on. With CarPlay, 4a resumes by itself. With Bluetooth, note whether the car sends play itself (`route-back`).
       - Then pause in the app, switch the car off and on again. 4a must **not** resume.
       - Play at least a few seconds in the car first: a route becomes known only after 1 s of our audio through it. Each loss writes `route kind=lost port= key=<8 hex> known=`, and each return `route kind=back ... pausedBy= decision= why=` (NE-38rs). Expected: the first return reads `pausedBy=route` and, on CarPlay, `decision=resume why=route-back` (on Bluetooth `decision=no why=bluetooth-off`, then the car's own `remote play`); the second reads `pausedBy=listener decision=no why=listener-paused`.
    4. **Rendered Foray (when one is published):** screen off, through at least two clip → line → clip seams. Press the car's Next during a line. Turn on airplane mode for 10 s during a line: the line falls back to the phone's voice.
    5. **DV-11:** an hour of native playback, then an hour with the Developer JS toggle. Read Settings → Battery for each.
    6. **Regression:** H-1 (2, 10 and 30 min), H-1b, H-3 (a call placed by a second person), the navigation arm, and the Spotify negative control.
    7. **Optional:** H-1 at 10 min with the `.longFormAudio` toggle on.
- **Acceptance:**
  - `StopCauseTests` enumerates every stop path and asserts a cause row for each.
  - The flag defaults off (pin).
  - The merge PR is green on ios-kit, engine-parity, ios-gate, ios-shell and android-shell.
  - The TestFlight build number is recorded in the HUMAN-ACTIONS item.
  - `engine-report.mjs` run on the script's sample paste lists every M3 verdict.
- **Device check:** G-6. DV-7a passes. DV-7b is recorded. DV-11 and the regression drive pass per `engine-report`.
- **As built (2026-09-30, PR #916 into `engine/m3`):**
  - **The audit.** `StopCauseTests` (foray-engine-core) tables 32 stop paths from the 13 `EngineCore` functions that call `stopRow`, each with its adapter, and asserts the named cause, the ring's admission of it, one row per stop, and the row before the first silencing command. Every `StopCause` is emitted by a path or reserved: `seam-timeout` (a seam's next clip that never loads is its load's P-13 deadline, `load-deadline`) and `unknown` (never written). `shell-invariants` is red when a `stopRow(` call site has no `site:` in the table.
  - **What it fixed.** Six paths (pause, close, relinquish, interruption, route loss, the ladder's last refusal) cut the seam, and so silenced a sounding jingle or the silence node, BEFORE their cause row; the row now comes first. Grace expiry writes its row before ending grace. `teardown()` while playing writes `relinquish` (the app's host never sends it; the page's `dispose()` does). The `silence capped`/`stopped` and `interlude cut` rows now precede their commands.
  - **The trial.** `EngineConfig.routeSharingLongForm` (OFF, `// MEASURE: DV-8`). The Developer row **Route sharing: Default / Long-form (applies after restart)** sends `setRouteSharing {policy}` (a new contract command, `ROUTE_SHARING_POLICIES`); the host stores it in `ForayEngine.routeSharing` (privacy policy §1 and data safety list it), and the next boot builds `AudioSessionOwner` with it. The `build` row carries `routeSharing`, and the Copy header prints it after `hold=`. Pinned OFF by `RouteSharingTrialTests.testTheTrialDefaultsOff` and a shell invariant (no literal `true`, no ENGINE_DEFAULT key).
  - **The script.** `docs/native-engine-m3-drive-test.md` and HUMAN-ACTIONS #129; the build number is "Claude adds here" until the post-merge TestFlight build exists. `engine-report.mjs` on `m3-drive-synthetic.txt` lists all ten M3 verdicts.
  - **The merge** is PR #913 (`engine/m3` → `main`, draft; the founder merges it).

#### NE-40d · DECISIONS entries for M3 (G-7) — **S**
- **Milestone:** M3
- **Depends on:** NE-38f, NE-39s, NE-40
- **Human-gated:** **yes** (`founder-approved`; `docs/DECISIONS.md` is denied).
- **Files:** `docs/DECISIONS.md` only, in its own PR.
- **Ask:** Record:
  - the JS-first rule-change discipline is permanent;
  - the de-dup decision, with its evidence;
  - the OQ-12 pause-hold ruling;
  - the route-resume Bluetooth arm (on or off, and the `route-back` rows behind it);
  - the silence-node decision;
  - the settled P-13 values;
  - the Next-over-narration ruling (NE-39n).

  Batch it with a label sitting. If the M3 Android entry (A-69) is ready, it can ride in the same PR.
- **Draft: the de-dup entry (NE-39s, 2026-09-29).** NE-40d copies it into `docs/DECISIONS.md` once NE-38e's `dup` verdict has read the G-6 drive:
  > **Remote de-dup (DV-6, OQ-7): record-only, no drop guard.** The engine records `dupCandidate` on every `remote` row (`y` for the same command inside `REMOTE_DUPLICATE_WINDOW_MS`, 500 ms) and drops nothing; the press is still handled. The iOS native path's 500 ms window stays until NE-41 retires it.
  >
  > *Evidence.* Every remote row in the 2026-09-28 car paste (PR #866; `diag-2026-09-28-wacky.txt`) has `dupCandidate=n`. The car's repeated plays are separate presses seconds apart, not one press delivered twice: e#85 and e#89 (15:13:10.171 and 15:13:15.188, 5 s apart, the second finding `state=loadingItem`) retried a resume that stayed silent, and e#116, e#118 and e#120 (the founder's second paste, quoted in PR #866) came while 4a was playing and Now Playing still said rate 0 (the stall latch #866 fixed), so the car read "paused" and pressed again. A guard wide enough to catch either would drop real presses; the fix for the second kind is the rate latch, not a drop.
  >
  > *What settles it.* NE-38e's `dup` verdict on the G-6 drive: the `dupCandidate=y` count and the ms between presses of one command. A `y` on the drive reopens the question; zero `y` confirms record-only, and NE-41 then retires the 500 ms window.
- **Acceptance:** merged with `founder-approved` and linked in `STATE.md`.
- **Device check:** none.

### Track M4 · Harden, don't remove

#### NE-41 · Harden, don't remove: retire the Developer Web entry and the iOS de-dup window; keep the legacy lane as fallback — **M**
- **Milestone:** M4
- **Depends on:** NE-40
- **Ask:**

  Only after two weeks of founder use with no crash-loop, page-health or downgrade rows. Retire:
  - the Developer 'Web' option from the visible drawer (the native setModeOverride and an 'advanced recovery' row remain)
  - the 500 ms cross-origin de-dup window on the iOS native path
  - the M1 Foray relinquish branch (Forays are native)

  KEEP:
  - the legacy registration reachable through the crash guard, sticky legacy, relinquish{cap:'all'} and the override
  - ForayAudio.setNowPlaying/transport and ForayTts speak/pause/resume/stop for Android and the web (W-10)

  Add a legacy-mode smoke test to ios-kit, over the fakes, so the fallback cannot rot. Update shell-invariants and docs/ios-lock-screen.md (a pointer to the engine).

- **Acceptance:** Android and web suites are unchanged. The legacy smoke test is green in ios-kit. The iOS native path has no HtmlAudioBackend construction (unit pin plus probe). The two-week evidence is linked in the PR.
- **Device check:** A normal week of founder use plus a final H-1/H-2/H-3 drive.

#### NE-42 · Phase-2 seat: the CarPlay read APIs (retargeted 2026-09-29: the Kokoro PcmNarrator half is obsolete) — **S**
- **Milestone:** M4
- **Depends on:** NE-24
- **Human-gated:** no.
- **Why retargeted:** narration is rendered centrally (DECISIONS 2026-09-28, D1; Spark assessment §4: "NE-42 drops the PcmNarrator for Kokoro half"). No on-device Kokoro engine will need a PCM seat. If DV-9 ever forces the fallback voice onto a PCM path, NE-33's `write(_:toBufferCallback:)` path already is one.
- **Files:** `ForayEngine.swift` (the read APIs), `ForayEngineHostTests`, and a grep pin in `tools/mobile/shell-invariants.test.mjs`.
- **Ask:** Expose the NP-11 read APIs on ForayEngine: the current queue with titles, and play a Foray by id or an episode from the restore record. Leave them unused, and document them as the CarPlay seam. No entitlement, no CarPlay scene, and no Swift `foray-resolve`/`foray-queue`.
- **Acceptance:** XCTests: the read APIs return the snapshot's queue. A grep pin shows no CarPlay entitlement or scene.
- **Device check:** none.

#### NE-48 · NarrationCache: download a Foray's rendered narration when it starts — **M**
- **Milestone:** M4 (added 2026-09-29 from Spark assessment §3.3 and §3.7)
- **Depends on:** NE-45s. It is also worth doing only once published Forays carry rendered narration (Spark Phase 1).
- **Human-gated:** no.
- **Files:** `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/NarrationCache.swift` (new), `EngineBoot.swift`, `AVDeck.swift` (a local-file URL for a cached line), `EngineStore.swift` (its index, in private keys), `NarrationCacheTests`.
- **Ask:** When a Foray starts, download its rendered lines for the chosen voice (about 7 MB per voice per Foray) into Caches. The URLs are content-addressed and immutable, so a file never goes stale. A line plays from the local file when it is there, and from the URL otherwise. This makes narration seams instant and survives a mid-drive dropout, where today an unprefetched line falls back to the phone's voice.
  - The download runs on a background `URLSession`, never competes with the audible deck's load, and stops when the Foray ends.
  - The cache is capped at 50 MB (least recently used goes first). `// MEASURE`: settled by the `narration-cache hit|miss|evicted` rows.
- **Acceptance:** XCTests: a cached line loads from a file URL; a miss streams; the cap evicts the oldest entries; a download never starts while a deck load is pending. The rows are admitted by DiagGate.
- **Device check:** a Foray played with airplane mode on after its narration has downloaded.

> **Not in this deck: append and the waiting state** (Spark §3.3, on-demand S2/S3: Swift `appendForayItems`, "Building the next part…"). They are planned when on-demand is scheduled, JS first.

#### NE-44 · Optional: freeze or delete the ios/ SwiftUI scaffold (G-2) — **S**
- **Milestone:** M4
- **Depends on:** NE-02
- **Ask:** Off the critical path. Either delete the ios/ scaffold (App, AppTests, ForayKit's PlayerQueueState copy) with the ios-kit steps adjusted in a G-1-style PR, or mark it frozen in a README pointing at foray-engine-core. If ForayKit is kept and made to depend on the core, it must add .macOS(.v12) to its platforms, and the PlayerQueueManager switches must gain default arms. Needs a human merge (ios/ is unlisted).
- **Acceptance:** ios-kit is green after the change (run id). No shipped target is affected (ios-build unchanged).
- **Device check:** None.
