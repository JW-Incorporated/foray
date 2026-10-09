# Package CH3 — code health 3: the native playback engine, reviewed for the drive — revision 1

Written 2026-10-09 against `origin/main` @ `9fffb085` (`C:/w/ch3`). The review read `7276893c`; `git diff 7276893c 9fffb085` is empty for every path in scope, so every line number below holds at both. Line numbers are anchors; if a cited symbol is not within ±40 lines, `git grep -n "<symbol>"` and continue — stop only if the symbol does not exist.

[code-health.md](code-health.md) (CH-xx) took the client and the native shells' comments; [code-health-2.md](code-health-2.md) (CH2-xx) took the backend, the API and the tooling. This package takes what neither reached: the **native playback engine** — `mobile/plugins/foray-audio/**` (the Swift `ForayEngineCore` and `ForayAudioPlugin`, the Java `foray-engine-core-jvm` and the Android plugin), `mobile/plugins/foray-downloads/**`, and the page's side of the bridge (`player/native-engine.js`, `player/native-facades.js`, `player/engine-contract.js`, `player/parity/**`). Card ids are `CH3-xx`.

## 0. Why, method, and what changed in scoping

**Founder request (Wyatt, 2026-10-09).** A DHH-style review of the native playback engine — one obvious way, no rule held twice, no dead code, no speculative seam, no lying comment — **ranked by corner-case bug risk for a listener driving with CarPlay or a plain Bluetooth head unit**. Context given: #1124 added a 1 Hz Now Playing refresh for AVRCP head units; #1111 removed the Kokoro probe code; the car diagnostics show `stop cause=load-deadline` stops and repeated route-change interruptions on the drive.

**Method.**
1. **Five reviewer agents, one area each**, all reading the same brief (finding shape: id, category, severity, file:line evidence, failure scenario for a listener in a car, the parity fixture or test that pins it today, the fix, and what the reviewer did NOT verify). **R1** iOS host layer (`ForayEngine`, `NowPlayingPublisher`, `RemoteSurface`, `EngineBridge`, `EngineOwnership`, the legacy `ForayAudioPlugin`); **R2** iOS decks, audio session and the core's interruption / route / deadline / reset paths (`AVDeck`, `DeckPair`, `AudioSessionOwner`, `SpeechNarrator`, `InterludePlayer`, `EngineCore.swift`'s session handlers, the reducer); **R3** Swift ↔ Java core drift and parity coverage (both cores, both scenario drivers, the comparators, `player/parity/**`); **R4** the page's side of the bridge and `foray-downloads`; **R5** the Android plugin layer (`ForayPlaybackService`, `ForayEngineHost`, `ExoDeck`, `EnginePlayer`, the JS-lane service). No Swift or Java toolchain exists on this machine: the review is by reading and `git grep`; the JS claims were reproduced with `node -e`, and `node tools/parity/record.mjs --check --family manager-episode` was run read-only (44/44 match).
2. **Skeptic pass.** Each reviewer re-checked its own findings before filing (a missed guard, a test that already pins it) and listed what it checked and did NOT file. The integrator then re-read the source for every high and medium and for every dead-code claim (`git grep` over the whole repo, tests, fixtures, tools and docs included). Verdict `confirmed` = the integrator reproduced every claim from the source; `reviewer-checked` = the reviewer's evidence (quoted lines, grep) was spot-read but not re-derived end to end; `adjusted` = a claim was wrong or overstated and the severity moved. Nothing was refuted outright. **56 issues were filed; 40 survive into this package** (4 high, 19 medium, 17 low). The 16 below the cut are real but carry no drive-time risk; they are listed in Appendix B so the next reviewer need not re-find them.
3. **Scoping.** The 40 were grouped into 24 cards — one agent, one PR each — ordered into 5 waves so that **no two cards in a wave edit the same file** (the two exceptions are the append-only books named in §4). Every card opens with characterization tests that pin today's behaviour; a bug's reproduction is committed RED in commit 1. Native changes compile only in CI; a rule that lives in JS and Swift and/or Java changes JS-first and is re-recorded with `tools/parity/record.mjs`.

**UI freeze.** No card touches `app.js`, `styles.css` or `index.html`. Two fixes whose obvious home is `app.js` (R4-04's boot reconcile, R4-07's "send visibility after hello") are placed in `player/download-bridge.js` and `player/client.js` instead, and the card says so.

**Out of scope, not re-filed:** everything already carded in CH-xx / CH2-xx (the native-adjacent ones: CH-04, CH-06, CH-12, CH-15, CH-19, CH-31, CH-34, CH-40, the #1111 Kokoro removal, the deferred two-element handover park, and CH-11b's dropped jingle-rate rule — jingles follow the listener's speed, founder ruling #1120). Foray generation is out of scope.

### 0.1 What this package fixes that a listener can hear or see

- **CH3-01** (R2-01, high): a nav prompt or "Hey Siri" that lands while an episode or a Foray clip is still LOADING (every cold play, every seam, every retry) is never resumed — the reducer records the load as "was not playing", the interruption's `shouldResume` is ignored, and the car goes silent after the prompt. It resumes.
- **CH3-02** (R2-02): an A2DP ↔ HFP flap during a call or Siri marks the pause "route-lost", so the call's `shouldResume` is refused (`resumed=false why=route-lost`). A loss that lands inside an interruption no longer overrides it.
- **CH3-03** (R2-03, high): after a media-services reset (CarPlay and Bluetooth stacks are known triggers) both decks keep their dead `AVPlayer`; every later load runs to the 20 s deadline and stops `cause=load-deadline` until the app is killed. The shell rebuilds its players.
- **CH3-04** (R4-01, high): in the native lane every episode the ENGINE walks to by itself (Continuous playback at the end of an episode, the wheel's ⏭/⏮) streams even when it is downloaded — an offline drive through a downloaded Up Next hits the load deadline and goes silent. The plan carries the downloaded source.
- **CH3-05** (R4-02, high; R4-04): the page keeps each download's absolute iOS path forever and plays `file://<that path>`; the plugin's own header says the container moves on every app update. After an update every download is "missing" and, offline, skipped one after another with the earcon. The page reconciles from the native index at boot; a transfer that finished while 4a was not running stops reading "Downloading 87%" forever.
- **CH3-06** (R1-02): a hello-watchdog hand-over leaves the engine's stale "Episode X, paused" on the head unit with every command disabled, for the rest of the process. The legacy registration clears an entry no page will overwrite.
- **CH3-10** (R1-03): the 2026-09-23 ruling "the track pair only where a track button exists" is implemented in the legacy lane only; on the native lane (the iOS default) the lock screen draws ⏭ instead of the founder's 30↻ whenever Up Next holds something. One rule in the core for both lanes.
- **CH3-11** (R2-04): §16 "continue a load that is getting somewhere" (the 2026-10-01 drive fix) is keyed on precise timing, and the shipping CBR exemption made most clips approximate — so a CBR clip's deadline retry starts from byte zero again, which is the `load-deadline` → cold-restart loop. Keyed on "a clip" instead.
- **CH3-12** (R4-03): a downloaded file that will not open (removed, moved by an update) fails a car press after a cold restore silently: the page's stream fallback only hears of the failure through an event the bridge drops while the page is hidden. The engine falls back to the stream itself.
- **CH3-13** (R2-07): a prepared clip not ready at the boundary leaves the standby deck fetching the same file while the playing deck cold-loads it again, splitting a weak car link in two. The standby is let go.
- **CH3-15** (R2-06): the narration voice's `AVAudioEngine` runs (rendering silence) from the first spoken line to the end of the process, and every later deactivation reports `is-busy`. It stops between lines.
- **CH3-16** (R1-01): an artwork fetch still in flight at a relinquish repaints the engine's pre-relinquish title over the legacy lane's entry up to 10 s later.
- **CH3-18** (R4-05): in the native lane the phone's ↺15/30↻ during an engine-started load (a wheel ⏭, an auto-advance) is computed from the page's 0:00 and sent as an absolute seek — the resume point at 38:00 becomes 0:30. Nudges go to the engine as `seekBy`.
- **CH3-19** (R2-05): a late or declined-call interruption during a spoken narration line cuts the line and pauses the Foray, because the host never tells the core the synthesiser is still speaking.
- **CH3-21** (R1-10): an artwork fetch that times out as the car connects leaves CarPlay bare for the rest of the item on the native lane; the legacy lane learned to retry (mobile-native-6), the engine did not.

Android (native lane OFF by default, `mobile/ENGINE_DEFAULT.json` android = `js`; these land before A-28/A-31 switch it on): **CH3-07** (R5-01) a core relinquish leaves a frozen Media3 session beside the legacy one (two "4a" sessions in the car, the wheel bound to the dead one); **CH3-08** (R5-02) a play refused audio focus (driver on a call) reports `success` and an interruption instead of iOS's `commandFailed`; **CH3-17** (R3-01, R3-02) the JVM core still auto-resumes on a known car's return after the listener's own pause (the rule the founder deleted, Q5) and its `stop()` lacks the "stop is silence" postcondition.

### 0.2 What this package deletes or corrects

The test-only `ForayEngine.shared`/`ForayEngine.boot` (and the plan line that names a method that does not exist); `EngineStore.onEmit`/`onPendingEvent` (no writer anywhere); `ForayAudioPlugin.commandsRegistered` and the three `sessionOwnedByEngine` guards in foray-audio's legacy lane that cannot be reached; the second "who owns Now Playing" record (`NowPlayingPublisher.current` vs `ForayEngine.published`); the JVM's `knownCarRoutes` resume branch; `NativeManagerFacade.toggle()`; `EngineState.pageVisible` in both cores (written, never read); the core's "press carries its own skip interval" override no host uses; the page helper misnamed `fileSrc` (beside a native `fileSrc` nothing calls). Corrected comments: `DeckPolicy`/`DeckPolicyReadings` ("AVDeck's decisions are made here"), `ExoDeck`'s "the same number as AVDeck's" and `HandlerTiming`'s clock, `AudioSessionOwner.rebuild()`'s "the decks are rebuilt by the core's `.unload`", and the parity `exclusions.json` / `queue-manager.js` notes that credit Swift with the `knownCarRoutes` it deleted.

### 0.3 Integrator adjustments to the reviewers' findings

1. **R1-04 medium → low.** `ForayEngine.shared`/`boot` is test-only and its comment lies, but nothing in production can reach it; the cost is a misleading door, not a drive-time path.
2. **R1-17 re-scoped.** `EngineBridge.lastError` is cleared only on `playEpisode` — and `git grep -n lastError -- 'player/*.js' app.js` finds no page reader of the snapshot field at all (only `engine-contract.js:629`'s schema and durable-store's unrelated field). It is folded into CH3-12, which makes the page settle a local-file failure from `snapshot.lastError` on attach — which is exactly when a stale value would bite.
3. **R2-02 high → medium.** The code path is certain (`EngineCore.swift:1753` sets `pausedByRoute` on every `oldDeviceUnavailable`, and `player/queue-manager.js:1349` does the same). Whether iOS delivers an A2DP ↔ HFP switch to an already-interrupted app as `oldDeviceUnavailable` was not verified on a device; the drive rows show the reason, not the order. Device check in §1.
4. **R2-05 and R2-08 travel together.** The reviewer showed R2-08's split session phase becomes a live bug the moment R2-05 is fixed; one card (CH3-19) lands both, and R2-05's Android half (the Java host also passes no narrator reading) goes with the Android card CH3-22.
5. **R3-04 split.** Its two concrete Java drifts (grace-expiry row order; no `relinquish` stop row in `teardown()`) are code fixes in CH3-17; the new `native-episode` family that would have caught them is CH3-20.
6. **R3-06 below the cut, its fix kept.** No parity runner calls `commandAvailability` on either side; CH3-10 changes that rule and adds the fixture group, which makes `EngineSurface.swift`'s "fixture-pinned" sentence true instead of deleting it.
7. **R5-06 deferred (§5).** Two Media3 `SimpleBasePlayer` facades (`WebViewPlayer`, `EnginePlayer`) hand-implement one mapping. A shared `SessionFacade` is a speculative abstraction if A-31 deletes the JS lane; whether it does is a ruling.

## 1. Goal, done-definition, dependencies, founder questions

**Goal.** One rule, one place, on the path a listener drives: every interruption, route and reset path leaves the audio session, Now Playing and the remote commands in the state the next press needs; every rule held in Swift and Java is held equal by a fixture the JVM runs; the page holds no second copy of a fact the engine owns (the playhead for a nudge, a download's path, its status, whether the page is looking); dead native entry points and lying comments are gone.

**Done when.** Every card's PR is merged wave by wave; `node tools/ci/run-suites.mjs` and `node tools/parity/record.mjs --check` are green with every floor raised to the true count; `ios-kit`, `engine-parity` and `android-build` are green on `main`; the §1 device checks are filed in `HUMAN-ACTIONS.md`; and Appendix A's 40 ids are each closed by a merged card (Appendix B's 16 stay as a record).

**Dependencies.**
- None on a credential, a store submission or spend.
- **CI is the compiler.** `ci.yml` `ios-kit` (`swift test` on `foray-engine-core`, `xcodebuild test` on `foray-audio` and `foray-downloads`), `ci.yml` `engine-parity` (Linux `swift test` parity run), `android-build.yml` (`:foray-audio:testDebugUnitTest`, `:foray-downloads:testDebugUnitTest`, `:foray-engine-core-jvm:test` incl. the JVM `ParitySuite`).
- **The `hold` rule** (`docs/native-engine-plan.md` §12) is still in force (`ios-gate` is not yet a required check: `tools/ci/pr-triage.mjs:84`): every card touching `mobile/plugins/*/ios/**` or `foray-engine-core/**` opens with the `hold` label. 18 of the 24 cards do.
- **Governed paths.** No card touches a DENIED path (`Package.swift`, `*.gradle`, `mobile/**/package.json`, `.github/`, `tools/ci/`, `docs/DECISIONS.md`). `mobile/` auto-merges when green, which is why the `hold` rule matters.
- **Android plan.** CH3-07, 08, 14 (half), 17, 22 edit the dormant Android native lane and the JVM core that `docs/plans/android-assessment.md` A-28/A-31/A-40/A-60/A-61/A-67 also touch. They land BEFORE those cards and each says which A-card it unblocks; an A-card in flight on the same file goes first and the CH3 card rebases.

**Device checks (to file as `HUMAN-ACTIONS.md` items when the wave lands; nothing here blocks a merge).**
1. CH3-01/02: on a drive with Apple Maps guidance, a turn prompt during a cold load, and a phone call over the car's Bluetooth; the Copy shows `interruption ... resumed=true`.
2. CH3-03: Settings → Developer → Reset Media Services mid-episode, then play: it plays (today, by the code, `deadline playerStatus=failed`).
3. CH3-05: download two episodes, install a TestFlight update, go offline, play both from Library.
4. CH3-15: a Foray's first spoken line, then lock and wait 10 min: the app suspends (no `AVAudioEngine` running), and the close row says `deactivated ok=true`.

**Open founder questions (defaults proposed; each card proceeds on the default).**
1. **Interruption resume during a load** (CH3-01): a Siri / nav prompt / call that begins while 4a is loading and ends with `shouldResume` now resumes. *Default: resume* — the listener's intent was to play, and DECISIONS 2026-09-25 Q5's "a call, Siri or a system pause never resumes" is about a ROUTE coming back, not about an interruption's own should-resume (which the playing case already honours).
2. **A route loss inside an interruption** (CH3-02): *default: the interruption's should-resume decides*; a loss while PLAYING stays non-resumable (`manager-episode/a-lost-route-is-not-resumed-by-a-later-call` keeps passing).
3. **Android twins of the iOS track-route gate** (CH3-10): Android's notification and Android Auto draw both pairs side by side, so the Android host passes "track route present" = true always. *Default: true on Android.*

## 2. Task table

| id | title | wave | executor | why-opus | depends-on | size |
|---|---|---:|---|---|---|---|
| CH3-01 | An interruption that begins during a load resumes when it ends with `shouldResume` | 1 | opus | reducer in JS + Swift + Java, re-record `queue-state` | — | M |
| CH3-02 | A route loss inside an interruption leaves the interruption's should-resume in charge | 1 | opus | manager rule in JS + both cores; new `manager-episode` case | — | M |
| CH3-03 | A media-services reset rebuilds the shell's players (both decks, the narration engine, the jingle) | 1 | opus | AVFoundation lifecycle, CI-only Swift | — | M |
| CH3-04 | The continuation plan carries each hop's downloaded source | 1 | qwen | | — | S |
| CH3-05 | Downloads: the native index is the one truth — paths and statuses reconciled from `list()`, iOS `reconcileInterrupted` emits | 1 | opus | Swift + JS; persisted-state migration | — | M |
| CH3-06 | The legacy hand-over: one ownership truth, unreachable guards gone, a page-less watchdog hand-over clears the dead entry | 1 | opus | three Swift files + the NE-16 pin | — | M |
| CH3-07 | Android: a core relinquish releases the Media3 session; `isHosting()` reads volatiles only | 1 | opus | Media3 service lifecycle, CI-only Java | — | M |
| CH3-08 | Android: a play Media3 refuses focus for is a refused play, as on iOS | 1 | opus | Media3 focus semantics, Robolectric | — | S |
| CH3-09 | `voiceFallback` is one boolean: schema, snapshot body, reference engine | 1 | opus | contract change across JS + Swift (+ Java enum) | — | S |
| CH3-10 | The "track pair only where a track button exists" rule moves into the core for both lanes | 2 | opus | core rule in Swift + Java, legacy lane rewired, fixture group | CH3-03, CH3-06, CH3-07 | M |
| CH3-11 | §16 continue/lapse keyed on "a clip", not on precise timing | 2 | opus | AVDeck load path, CI-only | CH3-03 | S |
| CH3-12 | The engine falls back to the stream when a downloaded file will not open; `lastError` means the current item | 2 | opus | both cores + bridge + page | CH3-02, CH3-04, CH3-06 | M |
| CH3-13 | A not-ready prepare miss lets the standby go instead of fetching the same file twice | 2 | opus | DeckPair, CI-only | CH3-03 | S |
| CH3-14 | Deadline comments tell the truth: DeckPolicy's native reach, ExoDeck's number, HandlerTiming's clock | 2 | opus | Swift core + Java comments (hold) | CH3-08 | XS |
| CH3-15 | The narration voice's `AVAudioEngine` stops between lines | 2 | opus | AVAudioEngine lifecycle, CI-only | CH3-03 | S |
| CH3-16 | Now Playing has one holder and nothing writes it after a teardown | 3 | opus | publisher seam + NE-17 pin | CH3-10 | S |
| CH3-17 | The JVM core matches Swift on the episode path: no known-car auto-resume, stop is silence, stop rows in Swift's order | 3 | opus | JVM core + parity books | CH3-02, CH3-12 | M |
| CH3-18 | Native-lane nudges are intents: the page sends `seekBy`, not an absolute target from its own playhead | 3 | opus | page transport in native mode | CH3-12 | S |
| CH3-19 | The core hears whether the narrator is speaking; one session phase gates every audible start | 4 | opus | seam change + session ownership | CH3-15, CH3-16 | M |
| CH3-20 | Parity reaches the steering wheel: remote presses (toggle included), a deadline step, a `native-episode` family that compares `n.*`; one home for the skip step | 4 | opus | both drivers, three comparators, both cores | CH3-17, CH3-12 | M |
| CH3-21 | One artwork loader, with the legacy lane's retry-after rule | 4 | opus | Swift, two lanes | CH3-10, CH3-16 | S |
| CH3-22 | Android: one buffering derivation for the facade; the host passes the narrator reading | 5 | opus | Media3 facade + JVM view | CH3-10, CH3-19, CH3-07 | S |
| CH3-23 | "Is the page looking?" has one rule; the dead facade `toggle` goes | 5 | opus | bridge rule in JS + Swift + both cores | CH3-18, CH3-20 | S |
| CH3-24 | Delete the engine's test-only and writer-less doors | 5 | opus | Swift deletions (hold) | CH3-19, CH3-16 | XS |

**24 cards: 23 opus, 1 qwen (CH3-04); sizes 2 XS / 11 S / 11 M. Per wave: 1 → 9, 2 → 6, 3 → 3, 4 → 3, 5 → 3. Human-merge PRs: none (no governed path); 18 cards open with the `hold` label (every card but CH3-04, 07, 08, 17, 18 and 22; the Android and JVM ones among those still wait for a green `android-build`).**

## Standard conventions (every card applies these verbatim)

- Repo: `C:/Users/wjduv/Desktop/Vibe Coding/foray`. Start: `git -C "<repo>" fetch origin` then `git -C "<repo>" -c core.autocrlf=false worktree add C:/w/<card-id> -b refactor/<card-id>-<slug> origin/main` and work ONLY in that worktree (LF tree; never run `format:write` repo-wide; never `git restore`/`git clean`; never work in the founder checkout).
- **No Swift or Java toolchain exists locally.** Every native change compiles only in CI: `ci.yml` `ios-kit`, `ci.yml` `engine-parity` (short-circuits unless `player/parity/`, `foray-engine-core/` or `tools/parity/` changed), `android-build.yml`. A card that edits Swift or Java pushes, lets those run, and quotes the green run URL and head SHA in the PR. **The `hold` rule** (`docs/native-engine-plan.md` §12): every PR touching `mobile/plugins/*/ios/**` or `foray-engine-core/**` opens with the `hold` label and the agent removes it only after quoting a green `ios-kit` on the exact head SHA — the one label an agent may apply, and only to its own PR.
- **Characterization first.** Every card's first commit adds the tests that pin today's behaviour (named under "Characterization FIRST") and they pass against the unmodified code — for Swift/Java that means CI green on commit 1 before commit 2 lands. Where the card says a pin is "RED today", that test is the bug's reproduction: committed red in commit 1 with a `// RED on main: <issue id>` comment, green with the change.
- **Mutations.** Every new test's comment names the one-line mutation that turns it red, and you run that mutation once before committing (in CI for native: push the mutation as its own commit, quote the red run, revert).
- **Parity is the cross-language pin.** A rule that lives in JS AND Swift AND/OR Java changes JS-first: edit the JS reference (`player/*.js` / `player/parity/reference-engine.js`), add or change the case in the fixture family, re-record with `node tools/parity/record.mjs --family <F>` (`--jvm-card <id>` when the JVM runs that family and is owed the new case), then port to Swift and Java in the SAME PR so `engine-parity` and the JVM `ParitySuite` are green. `node tools/parity/record.mjs --check` must be green before every push. A card whose `--check` moves a fixture it was not told to re-record has made a behaviour change and stops. `player/parity/floors.json` floors each family's case count: a card that adds cases raises its family's floor; one that removes cases sets it exact and says so.
- **Static pins.** `tools/mobile/shell-invariants.test.mjs` greps the Swift/Java sources (the guarded `setActive`/`setCategory` sites, `preroll(` only inside the readiness gate, `stopRow(` sites tabled in `StopCauseTests`, the NE-17 teardown shape); extend it, never loosen it except where the card says exactly which assertion changes and why. `player/parity/coverage.test.js` checks `xctest.json`/`facades.json`/`exclusions.json` entries exist; a card that renames an XCTest or deletes a JS test updates those books in the same PR.
- **Floors are minimums.** `test/suite-integrity.test.js` asserts `count >= floor` over `player/`, `test/`, `tools/` recursively. A NEW suite needs a floor entry. When a suite grows by N, raise its floor by N and append `; <old> -> <new> // CH3-xx: <what>` to that line's comment. When a card DELETES tests, set the floor exact and say so. Never delete a test to hit a number. XCTest and JUnit suites have no floor.
- **Runners.** JS: `node --test <file>`, one process at a time; CI-equivalent full run `node tools/ci/run-suites.mjs` once before the PR. Parity: `node tools/parity/record.mjs --check`; `node --test player/parity/run.test.js player/parity/coverage.test.js`.
- **Line numbers are hints.** Re-locate every cited symbol on `origin/main` with `git grep` before editing; a missing symbol is a stop condition.
- **UI freeze.** No card touches `app.js`, `styles.css` or `index.html`. `sw.js` `BUILD_ID` stays `"unstamped"`. Never commit `deploy-manifest.json` or `data/forays-directory.json`. `test/data-deletion.test.js` and `test/legal-citations.test.js` stay green untouched (the latter pins `EngineKeys.swift`'s private keys and the diagnostics ring cap — a card touching `Persist/EngineKeys.swift` leaves the key list as is).
- **Flags stay as they are.** `mobile/ENGINE_DEFAULT.json` (ios `native`, android `js`) and the `EngineConfig` defaults (`routeResumeBluetooth` OFF, `approximateCBRClips` core OFF / boot ON, `silenceNode` OFF, `routeSharingLongForm` OFF) are founder-gated field decisions; no card flips one.
- **No new vocabulary without admission.** A new `stop cause`, `remote` status, `nowplaying via=`, `route` or `session` row token is added to `Diag/Vocabulary.swift`, `Vocabulary.java`, `player/parity/vocabulary.json` AND `player/engine-vocabulary.js`/`diagnostic-log.js` in the same PR (the `diag-tokens` family and CH-31's pins hold them equal); no card adds a `logEvent` type or a `cp_` key.
- Commit messages end with the trailer lines your harness gives you (`Co-Authored-By:` + `Claude-Session:`). PR opened as DRAFT (`gh pr create --draft`), title `refactor(<area>): <card title> (CH3-xx)` (or `fix(...)` for a listener-visible bug), body opens with a 1–2 sentence TL;DR then `---`, lists the issues closed by id, names every characterization test and every mutation run, quotes `--check` and the CI runs, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and the session URL line. Open the PR and STOP. Never merge; apply no label but `hold` on your own native PR.
- **Stop and escalate if:** a cited symbol does not exist on `origin/main`; a characterization test marked "survives" fails against the UNMODIFIED code (the issue's premise is wrong — report, do not "fix" the test); `--check` moves a fixture the card did not name; `ios-kit`, `engine-parity` or `android-build` is red on commit 1 for a reason outside the card; or the card's file list overlaps a change already merged this wave.

## 3. Cards

Each card: the issues it closes (Appendix A), the exact change, files (the agent touches nothing else), dependencies, risk, and the tests — characterization first, then the new tests with the mutation each one kills. Paths abbreviated: `ios/` = `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/`, `iosT/` = `mobile/plugins/foray-audio/ios/Tests/ForayAudioPluginTests/`, `core/` = `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/`, `coreT/` = `mobile/plugins/foray-audio/foray-engine-core/Tests/ForayEngineCoreTests/`, `parity/` = `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineParity/`, `jvm/` = `mobile/plugins/foray-audio/android/foray-engine-core-jvm/src/main/java/ai/jwlabs/foura/engine/`, `jvmT/` = its `src/test/java/ai/jwlabs/foura/engine/`, `and/` = `mobile/plugins/foray-audio/android/src/main/java/ai/jwlabs/foura/audio/`, `andT/` = its `src/test/java/ai/jwlabs/foura/audio/`.

### Wave 1 — every drive-time bug that needs no shared file (9 cards, all independent)

### CH3-01 · An interruption that begins during a load resumes when it ends with `shouldResume` (opus, M — hold)

**Issues:** R2-01 (high). **Listener-visible fix** (founder Q1, default resume).

**Exact change.** JS first: `player/queue-state.js` `handleInterruptionBegan` (~441–447), the `loadingItem` arm returns `S.interrupted(state.target, true)` — the listener's intent was to play; the "stray `itemLoaded` must not start playback into a call" guarantee is unchanged because `interrupted` still ignores `itemLoaded`. The route-loss arm (`routeChanged(true)` during a load) keeps `false`: a lost route is not resumable. Re-record `queue-state` (`--family queue-state --jvm-card CH3-01`): `interruption-began-during-load` flips its expectation to `wasPlaying: true`, and a new case `interruption-during-load-then-ended-should-resume` expects `loadingItem(target)` + `loadItem` + `interruption.ended.resumed`. Port: `core/Reducer/PlayerQueueState.swift` (485–491) and the JVM reducer `jvm/PlayerQueueStateMachine.java` (the same arm). Nothing in `EngineCore.onInterruptionEnded` changes: it already activates and reloads in place when the reducer says `wasPlaying` (the deck's same-source rule makes the reload a continue).

**Files:** `player/queue-state.js`, `player/queue-state.test.js`, `player/parity/fixtures/queue-state/queue-state.json`, `player/parity/manifest.json`, `player/parity/floors.json`, `core/Reducer/PlayerQueueState.swift`, `coreT/PlayerQueueStateTests.swift`, `jvm/PlayerQueueStateMachine.java`, `test/suite-integrity.test.js`. **Depends on:** —. **Risk:** medium — a listener-visible behaviour change in both lanes (the JS lane shares the reducer); the PR TL;DR says so.

**Tests.** Characterization FIRST: `player/queue-state.test.js` pins today's `loadingItem` → `interrupted(target, false)` and today's `ended(shouldResume: true)` → `staysPaused` from that state (the second is the RED-today reproduction, flipped in commit 2); `coreT/PlayerQueueStateTests.swift` mirrors both. New: the two re-recorded fixture cases run on Swift and the JVM (`queue-state` is JVM-run); a `queue-state.test.js` case that a route loss during a load still lands `interrupted(target, false)` and stays paused after a call (kills widening the change to the route arm). **Mutations killed:** reverting `true` → `false` in the load arm (the new fixture case red on all three runners); setting `true` in the route arm (the route case red).

### CH3-02 · A route loss inside an interruption leaves the interruption's should-resume in charge (opus, M — hold)

**Issues:** R2-02 (adjusted to medium), R3-05 (the `queue-manager.js` half). **Listener-visible fix** (founder Q2).

**Exact change.** JS first: `player/queue-manager.js` `routeChanged` (~1342–1352): set `this._pausedByRoute = true` only when the loss itself pauses something — the reducer state before the dispatch is `playing`, `transitioning` or `loadingItem` — so a loss that lands inside an OS interruption (reducer already `interrupted`) leaves that interruption's should-resume in charge. Rewrite the R3-05 comment at ~1330–1339 to name Swift's `RouteResume`/`state.knownRoutes` (the `knownCarRoutes` it cites is Java's, and is deleted by CH3-17). Add the case `manager-episode/a-route-flap-during-a-call-still-resumes` (play → `interruptionBegan` → `routeChanged(true)` → `routeChanged(false)` → `interruptionEnded(shouldResume: true)` → resumes) to `scenarios.json`; re-record `--family manager-episode --jvm-card CH3-02`. Port: `core/Engine/EngineCore.swift` `onRoute` (1753) and `jvm/EngineCore.java` `onRoute` (~1236–1265): the same "only if the loss paused something" condition on `state.pausedByRoute = true`. Leave the route-resume bookkeeping (`routeResumeStep(.lost …)`) untouched.

**Files:** `player/queue-manager.js`, `player/queue-manager.test.js`, `player/parity/fixtures/manager-episode/scenarios.json`, `player/parity/manifest.json`, `player/parity/floors.json`, `core/Engine/EngineCore.swift`, `coreT/EngineCoreTests.swift`, `jvm/EngineCore.java`, `jvmT/EngineCoreTest.java`, `test/suite-integrity.test.js`. **Depends on:** —. **Risk:** medium — `manager-episode/a-lost-route-is-not-resumed-by-a-later-call` and `queue-manager.test.js:3502–3524` (the opposite order) must stay green untouched; they are the guard that the fix did not widen.

**Tests.** Characterization FIRST: `queue-manager.test.js` pins that a route loss while `interrupted` followed by `interruptionEnded(true)` stays paused today (RED-today reproduction), and that a loss while playing then a call stays paused (survives). New: the fixture case on JS, Swift and JVM; `EngineCoreTests` asserts the `interruption ... resumed=true` row on the flap order and `resumed=false why=route-lost` on the playing order. **Mutations killed:** restoring the unconditional `_pausedByRoute = true` (new case red on all three); dropping the `playing` arm from the condition (the existing lost-route case red).

### CH3-03 · A media-services reset rebuilds the shell's players (opus, M — hold)

**Issues:** R2-03 (high).

**Exact change.** `.sessionRebuild` becomes a real rebuild in the shell. `ios/Engine/AVDeck.swift`: `let player: AVPlayer` (369) becomes a `private(set) var`, and a `rebuildPlayer()` invalidates the player KVO (`playerObservations`) and the boundary observer, makes a new `AVPlayer` with the same settings `init` applies (plan §4.3), re-observes, and bumps the generation so any callback from the old player is dropped. `ios/Engine/DeckPair.swift` forwards `rebuild()` to both decks and empties its warm state. `ios/Engine/SpeechNarrator.swift` `PcmOutput` re-creates its `AVAudioEngine` and `AVAudioPlayerNode` (`let engine`/`let player` → vars, rebuilt and re-attached on demand). `ios/Engine/InterludePlayer.swift`: `release()` (drop the cached `AVAudioPlayer`). `ios/Engine/ForayEngine.swift` `interpret(.sessionRebuild)` (549–550) calls `seams.session.rebuild()` then `seams.deck.rebuild()`, `seams.speaker.rebuild()`, `seams.interlude?.release()` — add `rebuild()` to the `DeckDriving`/`Speaking` seams in `ios/Engine/Seams.swift` and to `iosT/Engine/RecordingSeams.swift`. Correct `AudioSessionOwner.rebuild()`'s comment (181–190): the shell rebuilds the players; the core's `.unload` only detaches items.

**Files:** `ios/Engine/AVDeck.swift`, `ios/Engine/DeckPair.swift`, `ios/Engine/SpeechNarrator.swift`, `ios/Engine/InterludePlayer.swift`, `ios/Engine/ForayEngine.swift`, `ios/Engine/Seams.swift`, `ios/Engine/AudioSessionOwner.swift`, `iosT/Engine/RecordingSeams.swift`, `iosT/AVDeckTests.swift`, `iosT/Engine/DeckPairTests.swift`, `iosT/Engine/ForayEngineHostTests.swift`. **Depends on:** —. **Risk:** medium — a new `AVPlayer` mid-process; `TwoDeckPrerollTests` and `DeckPairSeamTests` must stay green untouched. Device check §1.2.

**Tests.** Characterization FIRST: `ForayEngineHostTests` posts `.mediaServicesReset` while engine-owned and asserts the `RecordingSeams` see `session.rebuild` and an `.unload` and NO deck rebuild (RED-today: the assertion "the deck was rebuilt" is committed red). New: `AVDeckTests` — after `rebuildPlayer()` the deck's `player` is a different object, a load reaches `.ready` on it, and a KVO callback from the old player is ignored (generation); `DeckPairTests` — `rebuild()` reaches both decks. **Mutations killed:** dropping the `seams.deck.rebuild()` call (host test red); not bumping the generation in `rebuildPlayer` (the stale-callback test red).

### CH3-04 · The continuation plan carries each hop's downloaded source (qwen, S)

**Issues:** R4-01 (high).

**Exact change.** `player/client.js` `sendEnginePlan` (3966–3976): before `chainItems` is built and the plan sent, map each `hop.item` through `localSourceFor(hop.item)` (4718; it returns the item unchanged when there is no `done` file) — the `audio_url` the engine walks to is then the file, with `source_audio_url` carrying the stream (as `localPlayable` already writes for a page-started play). `lastEpisodeRow` stays computed from the ORIGINAL item (`continuation.js` builds it; do not touch `continuation.js`). Re-send the current plan when a download for a hop id finishes or is removed: the existing `window.forayDownloads` publication point in client.js gains one call to the plan re-send (find the current plan holder with `git grep -n "sendEnginePlan(" player/client.js`).

**Files:** `player/client.js`, `test/engine-continuation.test.js`, `test/suite-integrity.test.js`. **Depends on:** —. **Risk:** low — a play the page itself starts already takes this path; the engine needs nothing new (`EngineInput.swift:32–33` reads `audio_url`).

**Tests.** Characterization FIRST: `test/engine-continuation.test.js` pins that today a hop of a downloaded episode is sent with the remote `audio_url` (RED-today reproduction, R4's repro: `chain.map(h => h.item.audio_url)` → `https://cdn/b.mp3` for a `done` row). New: the hop is sent with the `file:` URL and `source_audio_url` set; a hop with no download is byte-identical to today; a `downloadDone` for a hop id re-sends the plan. **Mutations killed:** removing the `localSourceFor` map (first test red); computing `lastEpisodeRow` from the localised item (a pin that the row carries the remote id/url red).

### CH3-05 · Downloads: the native index is the one truth (opus, M — hold)

**Issues:** R4-02 (high), R4-04, R4-10.

**Exact change.** (a) `player/download-bridge.js`: on the first listener subscription (where `bootDownloads` attaches; no `app.js` edit), call the native `list()` once and replay every row to the listener as the event the page already handles — `downloadDone {id, path, bytes}` for a `done` row (with TODAY's path), `downloadFailed {id, reason, status}` for `failed`/`interrupted`, `downloadProgress` for an active one — so `player/download-store.js` `reportFromEvent` rewrites `cp_downloads` from the native truth (the stale absolute path is replaced; a transfer that finished while 4a was not running is recorded). Do the same on `resume` (the bridge already hears the app lifecycle; if not, the reconcile runs on each subscription only and the PR says so). (b) Rename the page-side `fileSrc({path})` (237–246) to `webSrc(path)` and its caller in `player/download-store.js` `readSource` (~425); the native `fileSrc` stays registered, unused by the page, with a header line saying the page reconciles from `list()` instead. (c) `mobile/plugins/foray-downloads/ios/Sources/ForayDownloadsPlugin/DownloadStore.swift` `reconcileInterrupted` (164–180) emits `downloadFailed` for each row it flips, as the Java twin's `pollOnce` already does.

**Files:** `player/download-bridge.js`, `player/download-bridge.test.js`, `player/download-store.js`, `player/download-store.test.js`, `test/downloads.test.js`, `mobile/plugins/foray-downloads/ios/Sources/ForayDownloadsPlugin/DownloadStore.swift`, `mobile/plugins/foray-downloads/ios/Tests/ForayDownloadsPluginTests/DownloadStoreTests.swift` (new), `test/suite-integrity.test.js`. **Depends on:** — (CH-02, CH-27 merged). **Risk:** medium — a boot-time rewrite of `cp_downloads`; it must be idempotent (a row already `done` with the same path is not re-written, so `last_played_at` from CH-02 survives). Device check §1.3.

**Tests.** Characterization FIRST: `download-bridge.test.js` pins that `list()` has no production caller and that a stored path is used verbatim by `playSource` (R4's repro, RED-today for the "path refreshed" assertion). New: a fake bridge whose `list()` answers a `done` row with a NEW container path rewrites the stored path; a `done` row the page never heard of becomes `done`; an `interrupted` row becomes `failed`; a second subscription does not rewrite an unchanged row (`last_played_at` kept). `DownloadStoreTests.swift`: `reconcileInterrupted` emits one `downloadFailed` per flipped row. **Mutations killed:** dropping the replay (path test red); replaying unconditionally (the idempotence test red); removing the Swift emit (XCTest red).

### CH3-06 · The legacy hand-over: one ownership truth, unreachable guards gone, a page-less watchdog hand-over clears the dead entry (opus, M — hold)

**Issues:** R1-02, R1-06, R1-07.

**Exact change.** (a) `ios/Engine/EngineOwnership.swift` `engineDidTearDown` (468–474) passes whether a page said hello this navigation into the parked legacy registration; `ios/ForayAudioPlugin.swift` `runLegacyRegistration` (320–355) takes that flag and, with NO page, clears Now Playing (`applyNowPlayingInfo(.empty)`) alongside the existing `applyCommandAvailability(.empty)`, so the head unit shows no entry rather than a dead "paused" one. The page-initiated path is unchanged (the page's `setNowPlaying` overwrites as today). (b) Delete `commandsRegistered` (the owner's `legacyRegistered` is the guard; `registerCommandHandlers` has one caller). (c) Delete the three `guard !EngineModeFlag.sessionOwnedByEngine` sites in foray-audio's legacy lane (~340, ~1101, ~1144) and the L23 skip helpers they feed (`holdSkipped`, `releaseSkipped`, `noteEngineOwnedSkip`): `engineDidTearDown` clears the flag before `runLegacyRegistration` can run (pinned `EngineOwnershipTests:395`), so they never fire. Keep `EngineModeFlag.swift` — foray-tts reads it. (d) `ios/Engine/EngineBridge.swift` asks the owner (`owner.relinquished`) instead of `engine.isTornDown` (253) for liveness. Update the NE-16 pin in `tools/mobile/shell-invariants.test.mjs` (~3806–3853) to count foray-audio's `setActive`/`setCategory` sites as owner-gated (reachable only inside `runLegacyRegistration`) instead of flag-gated; foray-tts's pins are untouched.

**Files:** `ios/Engine/EngineOwnership.swift`, `ios/ForayAudioPlugin.swift`, `ios/Engine/EngineBridge.swift`, `iosT/Engine/EngineOwnershipTests.swift`, `iosT/Engine/EngineBridgeTests.swift`, `tools/mobile/shell-invariants.test.mjs`. **Depends on:** —. **Risk:** medium — the NE-16 pin changes shape; the PR quotes the before/after assertion text.

**Tests.** Characterization FIRST: `EngineOwnershipTests` drives the hello watchdog with no hello and asserts the legacy registration ran with an empty command set and that Now Playing still holds the engine's entry (RED-today for "the entry is cleared"); a pin that `sessionOwnedByEngine` is false at legacy registration (exists, :395 — survives). New: the page-initiated relinquish leaves the entry (survives, unchanged); `EngineBridgeTests` — a snapshot after `owner.relinquished` answers the relinquished body. **Mutations killed:** dropping the `.empty` Now Playing write (watchdog test red); restoring a flag guard (shell-invariants' new "no flag guard in foray-audio's legacy lane" assertion red).

### CH3-07 · Android: a core relinquish releases the Media3 session; `isHosting()` reads volatiles only (opus, M)

**Issues:** R5-01, R5-05. Extends A-29 ("terminal relinquish"), which names only the JS side; unblocks A-28.

**Exact change.** `and/engine/ForayEngineHost.java`: add an `onTornDown` callback (the iOS host has one, `ForayEngine.swift:172–176`) fired at the end of `teardown()` (163–175); `teardown()` publishes `computeSurface(++surfaceSeq)` of the relinquished core (its `commandSnapshot` is UNLOADED → `clearsNowPlaying`) instead of the stale `surface` field. `and/ForayPlaybackService.java` `attach` sets `onTornDown` to `release()` + `stopSelf()` and nulls `host` — Android's meaning of "leave it for the legacy lane" is "release the session" (two `MediaSession`s, unlike iOS's one `MPNowPlayingInfoCenter`); `isHosting()` (131–135) becomes `s != null && s.host != null` over volatiles only, and `isTornDown()` leaves the cross-thread path.

**Files:** `and/engine/ForayEngineHost.java`, `and/ForayPlaybackService.java`, `andT/engine/ForayEngineHostTest.java`, `andT/ForayPlaybackServiceTest.java`. **Depends on:** —. **Risk:** low today (the Android native lane is off and no page sends `Relinquish`); medium at A-28.

**Tests.** Characterization FIRST: `ForayEngineHostTest` drives a core relinquish and asserts the listener received the PRE-relinquish surface (RED-today for "a cleared surface"); `ForayPlaybackServiceTest` asserts `isHosting()` is false after it while the session is still not released (RED-today for "released"). New: after the relinquish the service has released its session, `current()` is null and `ForayAudioPlugin.start` may start the legacy service. **Mutations killed:** publishing the stale field (host test red); not calling `release()` from `onTornDown` (service test red).

### CH3-08 · Android: a play Media3 refuses focus for is a refused play, as on iOS (opus, S)

**Issues:** R5-02.

**Exact change.** `and/engine/ExoDeck.java` `play()` (608–637): after `player.play()`, read `player.getPlayWhenReady()`; if Media3 refused audio focus (false), set `intendsToPlay = false` and emit `DeckEvent.Refused("play", "focus-denied")` in the same turn, so the core fails the press (`remote status=commandFailed`) as a refused activation does on iOS. Rewrite `and/engine/EngineSeams.java`'s "holds twice over" paragraph (33–43) to say what Android can and cannot refuse. If `DeckEvent.Refused` does not exist in `jvm/`, stop: the card uses the existing refusal event or escalates (no new vocabulary without admission).

**Files:** `and/engine/ExoDeck.java`, `and/engine/EngineSeams.java`, `andT/engine/FocusIntegrationTest.java`, `andT/engine/ExoDeckTest.java`. **Depends on:** —. **Risk:** low (lane off).

**Tests.** Characterization FIRST: `FocusIntegrationTest` with Robolectric's `ShadowAudioManager.setNextFocusRequestResponse(AUDIOFOCUS_REQUEST_FAILED)` asserts today's deck emits no refusal and the core answers success (RED-today). New: the same setup yields the refusal and the core's `commandFailed`; a granted focus request is unchanged (`aPlayWithoutAnActiveSessionWritesTheFaultAndStillPlays` survives). **Mutation killed:** removing the read-back.

### CH3-09 · `voiceFallback` is one boolean (opus, S — hold)

**Issues:** R4-06.

**Exact change.** `player/engine-contract.js` (630): `voiceFallback: nullable(bool)`; regenerate the schema (`node tools/parity/contract-schema.mjs`). `player/parity/reference-engine.js` `_body` emits `voiceFallback` from its narration state; `core/Contract/EngineBridgeRules.swift` `EngineSnapshot.body` (209–252) emits `state.lastVoiceFallback` (already kept, `EngineCore.swift:2831`). Drop `"voiceFallback"` from the contract's `EVENTS` (105) and from the Swift/Java decoders (`core/Contract/ContractDecoding.swift` ~593/679 and the JVM twin) — nothing emits it. Add a `snapshot` family example with `voiceFallback: true`; re-record `--family snapshot`. `player/native-facades.js` (267–270) and `client.js:3986` already read a boolean: unchanged.

**Files:** `player/engine-contract.js`, `player/engine-contract.test.js`, `player/parity/schema/*` (regenerated), `player/parity/reference-engine.js`, `player/parity/reference-engine.test.js`, `player/parity/fixtures/snapshot/*`, `player/parity/manifest.json`, `player/parity/floors.json`, `core/Contract/EngineBridgeRules.swift`, `core/Contract/ContractDecoding.swift`, `coreT/EngineBridgeRulesTests.swift`, the JVM contract decoder (`git grep -ln voiceFallback jvm/`), `test/suite-integrity.test.js`. **Depends on:** —. **Risk:** low — additive on the wire; a stale page validating with the old schema would refuse a boolean, so the Swift emit and the schema change ship in one PR (the page and the bundle ship together).

**Tests.** Characterization FIRST: `engine-contract.test.js` pins `validateSnapshot({... voiceFallback: true})` → `/voiceFallback: must be string or null` (RED-today flips). New: the snapshot example validates on JS and Swift; `EngineBridgeRulesTests` asserts the body carries the core's value. **Mutations killed:** reverting the schema type; omitting the Swift emit.

### Wave 2 — the core rule for the track pair, the deck and narration fixes, the file fallback (6 cards)

### CH3-10 · The "track pair only where a track button exists" rule moves into the core for both lanes (opus, M — hold)

**Issues:** R1-03 (closes R3-06's comment by making it true).

**Exact change.** Move `ForayAudioPlugin.trackCommandsAllowed(portTypes:)` (1597) into `core/Policy/MediaMapping.swift` as `MediaMapping.trackCommandsAllowed(portTypes:)` and give `commandAvailability(_:steps:trackRoute:)` (530–551) a `trackRoute: Bool` that gates `next`/`previous` exactly as the legacy lane's `transportable && hasNext && trackRoutePresent` does. `ios/Engine/ForayEngine.swift` `publishSurface` (~665–668) passes `MediaMapping.trackCommandsAllowed(portTypes: seams.session.currentRoute …)` and republishes on a route change; `ios/ForayAudioPlugin.swift` (274–279, 538–542, 1639–1640) calls the core function and deletes its own. Java: `jvm/MediaMapping.java` `commandAvailability` (449–473) gains the same parameter; `and/engine/ForayEngineHost.java` passes `true` (founder Q3). Add a `call` group for `commandAvailability` to `player/parity/media-actions.js` (snapshot × trackRoute in, enabled set + `clearsNowPlaying` out), authored from the DECISIONS table, run by both `MediaEpisodeFamily` runners; `core/Engine/EngineSurface.swift`'s "fixture-pinned by the media-episode family" (5–12) becomes true.

**Files:** `core/Policy/MediaMapping.swift`, `core/Engine/EngineSurface.swift`, `coreT/MediaMappingTests.swift`, `ios/Engine/ForayEngine.swift`, `ios/ForayAudioPlugin.swift`, `iosT/Engine/RemoteSurfaceTests.swift`, `iosT/ForayAudioPluginTests.swift`, `jvm/MediaMapping.java`, `jvmT/PolicyPortTest.java`, `and/engine/ForayEngineHost.java`, `player/parity/media-actions.js`, `player/parity/fixtures/media-episode/*`, `parity/Families/` (the media-episode runner), `jvmT/parity/MediaEpisodeFamily.java`, `player/parity/manifest.json`, `player/parity/floors.json`. **Depends on:** CH3-03, CH3-06, CH3-07 (files). **Risk:** medium — listener-visible on the native lane (the lock screen on the speaker draws 30↻ again; the car is unchanged).

**Tests.** Characterization FIRST: `RemoteSurfaceTests` asserts `nextTrack` is enabled on a speaker route with Up Next non-empty (RED-today for the ruling); `ForayAudioPluginTests.testTrackCommandsAllowedOnlyOnARouteWithATrackButton` (166) survives against the moved function. New: the fixture group on Swift and the JVM; `MediaMappingTests`: speaker → no track pair, `carAudio`/A2DP → track pair. **Mutations killed:** ignoring `trackRoute` (fixture red on both); the legacy lane keeping a private copy (a shell-invariants grep that `trackCommandsAllowed` is defined once, in the core).

### CH3-11 · §16 continue/lapse keyed on "a clip", not on precise timing (opus, S — hold)

**Issues:** R2-04.

**Exact change.** `ios/Engine/AVDeck.swift`: `continuesInFlight` (~696–705) and `deadlineFired`'s lapse (~997–1018) test "this load is a Foray clip" instead of `preciseTiming`/`loadedPreciseTiming`. Read it from what the load command already carries (its deadline class `.clip` together with item bounds — `git grep -n "deadlineClass\|bounds" ios/Engine/AVDeck.swift` before editing); if the load command carries neither, STOP and escalate (adding a `DeckCommand` field is a core + JVM change this card does not own). Correct the header (94–112).

**Files:** `ios/Engine/AVDeck.swift`, `iosT/AVDeckTests.swift`. **Depends on:** CH3-03. **Risk:** low — an episode and a rendered line keep today's path.

**Tests.** Characterization FIRST: `AVDeckTests` (~707–735, `for precise in [true, false]`) — the approximate case pins today's cold restart (RED-today for an approximate CLIP). New: an approximate clip that progressed lapses and a same-source retry continues it; an approximate EPISODE still detaches. **Mutation killed:** restoring the `preciseTiming` guard.

### CH3-12 · The engine falls back to the stream when a downloaded file will not open; `lastError` means the current item (opus, M — hold)

**Issues:** R4-03, R1-17 (adjusted).

**Exact change.** `core/Engine/EngineCore.swift` episode load-failure branch (~1335–1346): when the failed item's `audio_url` is a `file:` URL and the node carries `source_audio_url`, retry the load once on `source_audio_url` (offline is not the core's to know: the retry runs into its own deadline and then stops as today), write a `stop`-free `deck` row naming the fallback, and emit the existing `error` event with code `load` so the page marks the record missing. The JVM twin in `jvm/EngineCore.java` gets the same branch. No JS manager change: the JS lane's fallback is the page's (`client.js` `degradeLocalPlay`), so the rule is pinned by identically named unit tests on both cores, and the case is listed in `player/parity/exclusions.json` with that `why`. `ios/Engine/EngineBridge.swift`: clear `lastError` on every accepted start (`playEpisode`, `playForay`, `restoreBar`, a remote play), not on `playEpisode` alone (211). `player/client.js` `settleEngineLocalLoad` (4779–4797) only bookkeeps, and on attach it also settles from `snapshot.lastError` when a `localAttempt` ticket is open.

**Files:** `core/Engine/EngineCore.swift`, `coreT/EngineCoreTests.swift`, `jvm/EngineCore.java`, `jvmT/EngineCoreTest.java`, `ios/Engine/EngineBridge.swift`, `iosT/Engine/EngineBridgeTests.swift`, `player/client.js`, `test/downloads.test.js`, `player/parity/exclusions.json`, `test/suite-integrity.test.js`. **Depends on:** CH3-02 (EngineCore), CH3-04 (client.js), CH3-06 (EngineBridge.swift). **Risk:** medium — a new retry on the stop path; `StopCauseTests` and `shell-invariants`' `stopRow(` table must stay green (the fallback writes no stop row).

**Tests.** Characterization FIRST: `EngineCoreTests` — a `file:` load failure with `source_audio_url` stops with `cause=error` and no second load (RED-today); `EngineBridgeTests` — `lastError` survives a successful `playForay` (RED-today). New: the fallback loads `source_audio_url` once, and a second failure stops; an `https` failure is unchanged (no retry); JVM mirror. **Mutations killed:** dropping the `file:` check (the https test red); retrying twice (the "once" test red); clearing `lastError` only on `playEpisode` (bridge test red).

### CH3-13 · A not-ready prepare miss lets the standby go instead of fetching the same file twice (opus, S — hold)

**Issues:** R2-07.

**Exact change.** `ios/Engine/DeckPair.swift` `load` (237–268): on a `.notReady` miss whose `held.warm.url == url`, send `.unload` to the standby before the active deck's cold load (the minimal fix; the late-promotion alternative R2-07 offers is NOT this card — it changes the deck-pair state machine `deck-pair` pins).

**Files:** `ios/Engine/DeckPair.swift`, `iosT/Engine/DeckPairTests.swift`. **Depends on:** CH3-03. **Risk:** low.

**Tests.** Characterization FIRST: `DeckPairTests` — a not-ready warm load at the boundary leaves the standby's item attached (RED-today). New: it is unloaded; a ready warm load is still promoted (survives). **Mutation killed:** removing the unload.

### CH3-14 · Deadline comments tell the truth (opus, XS — hold)

**Issues:** R2-09, R5-03 (comment half; the port of §16 to ExoDeck stays A-40/A-60).

**Exact change.** Comments only. `core/Policy/DeckPolicy.swift` (6–13) and `core/Policy/DeckPolicyReadings.swift` (5–8): name which functions the native deck uses (`sameSourceIsSeek`, `outPointStep`, `prefetchWindowDelayMs`, the warm/handover set) and which are ported for parity only (`loadDeadlineMs`, `recoveryLoadedOps`, `recoveryFailedOps`, `fineWakeAction`, `fineWatchDelayMs`, `settledNear`, `playRefusalAction`, `deckSeekTarget`, `deckVolume`, `deckDuration`, `deckReportedRate`); name `AVDeck.defaultLoadDeadlineSec`/`defaultLineLoadDeadlineSec` as the one native spelling. `and/engine/ExoDeck.java` (160–164): "20 s is the CLIP class; AVDeck also has an 8 s line class and the §16 lapse, both owed at A-40/A-60". `and/engine/HandlerTiming.java` (13–17): the deck's deadline is also an uptime `Handler`; the gate's wake lock is what keeps it honest.

**Files:** `core/Policy/DeckPolicy.swift`, `core/Policy/DeckPolicyReadings.swift`, `and/engine/ExoDeck.java`, `and/engine/HandlerTiming.java`. **Depends on:** CH3-08 (ExoDeck). **Risk:** none (comments; `hold` because `foray-engine-core/**` changes).

**Tests.** None new; `ios-kit`, `engine-parity` and `android-build` green on the head SHA.

### CH3-15 · The narration voice's `AVAudioEngine` stops between lines (opus, S — hold)

**Issues:** R2-06.

**Exact change.** `ios/Engine/SpeechNarrator.swift` `PcmOutput`: in `end(_:_:)` and `silence()` (~526–566), when no line is in flight, `engine.pause()` (keeps the graph, so the next line's `startEngine()` is cheap); `stop()` calls `engine.stop()`. `received`/`resume` start it as now. `ios/Engine/AudioSessionOwner.swift` (161–175): re-check the `isBusy` comment against Apple's documented semantics (a failed deactivate with running I/O still deactivates) and make the owner's phase follow — `inactive` with an `is-busy` row — so the owner and core agree (half of R2-08; CH3-19 removes the second phase).

**Files:** `ios/Engine/SpeechNarrator.swift`, `ios/Engine/AudioSessionOwner.swift`, `iosT/Engine/SpeechNarratorTests.swift`, `iosT/Engine/AudioSessionOwnerTests.swift`. **Depends on:** CH3-03. **Risk:** low-medium — a line's start latency; `SpeechNarratorCatchUpTests` and `NarrationSeamTests` stay green untouched. Device check §1.4.

**Tests.** Characterization FIRST: `SpeechNarratorTests` — after a line finishes, `PcmOutput`'s engine `isRunning` is true (RED-today); `AudioSessionOwnerTests:192–206` pins the `isBusy` → still-active rule (flips, with the reason in the PR). New: running between a line's start and end only; a pause/resume mid-line unchanged. **Mutation killed:** removing the `pause()` in `end`.

### Wave 3 — Now Playing's one holder, the JVM catch-up, native nudges (3 cards)

### CH3-16 · Now Playing has one holder and nothing writes it after a teardown (opus, S — hold)

**Issues:** R1-01, R1-05.

**Exact change.** `ios/Engine/NowPlayingPublisher.swift`: the publisher keeps no view. `current` (68–70) goes; on an artwork landing it calls an `onArtworkLanded(src)` hook the host sets, and the host republishes through `publishSurface` with `surfaceMove = .jump` (which rebuilds at the deck's real playhead — no `advancedBySec` extrapolation, no second clock). `ios/Engine/Seams.swift` `NowPlayingWriting` (171–174) gains `var onArtworkLanded: ((String) -> Void)? { get set }`; `ios/Engine/ForayEngine.swift` sets it at start and nils it in `teardown()` (240–281), so a landing after a relinquish reaches nothing. Update the NE-17 pin in `tools/mobile/shell-invariants.test.mjs` (~4881): `teardown` may assign `seams.nowPlaying.onArtworkLanded = nil` and still may not `write`/`clear`.

**Files:** `ios/Engine/NowPlayingPublisher.swift`, `ios/Engine/Seams.swift`, `ios/Engine/ForayEngine.swift`, `iosT/Engine/RecordingSeams.swift`, `iosT/Engine/NowPlayingPublisherTests.swift`, `tools/mobile/shell-invariants.test.mjs`. **Depends on:** CH3-10 (ForayEngine.swift). **Risk:** low — the #1124 heartbeat and the `via` rows (`NowPlayingPublisherTests` 153–219, 251–304) must stay green untouched.

**Tests.** Characterization FIRST: `NowPlayingPublisherTests` — a write with a missing artwork, then the host's teardown, then the artwork completion: the centre is rewritten (RED-today). New: after teardown nothing is written; before teardown the landing produces one `publishSurface` with `via=jump` at the deck's playhead; `testTheArtworkObjectIsReusedAcrossRewrites` (529) survives. **Mutations killed:** not nil-ing the hook in teardown; the publisher writing the centre itself on landing.

### CH3-17 · The JVM core matches Swift on the episode path (opus, M)

**Issues:** R3-01, R3-02, R3-04 (the two Java drifts), R3-05 (the `exclusions.json` half), R3-07. Unblocks A-61 and A-67.

**Exact change.** `jvm/EngineCore.java`: (a) delete the `knownCarRoutes` learn-and-resume branch in `onRoute` (~1236–1265) and `jvm/EngineState.java`'s `knownCarRoutes` (63–68) — a reconnect never resumes, the JS rule, until A-61 ports `RouteResume`; (b) port the player-core-7 postcondition into `stop()` (474–496): after `dispatch(PlayerEvent.STOP)`, `if (audibleNow()) { diag("pause", …); deckCommand(DeckCommand.PAUSE); }` as `EngineCore.swift:672–681`; (c) grace expiry writes the stop row first, as Swift (`stopRow(GRACE_EXPIRED); endGrace(EXPIRED)`, 1318–1328 vs Swift 1984–1985); (d) `teardown()` (1600–1611) opens with `stopRow(RELINQUISH)` as Swift's (3174); (e) mirror `bufferingWhileWaiting` (Swift 171–180) as a JVM constant with the same `// MEASURE:` tag and use it at 1114. Books: register a JVM runner for `manager-remainder` (the episode driver is enough) in `jvmT/parity/JvmFamilies.java`/`ManagerEpisodeFamily.java`; in `player/parity/jvm-pending.json` move `manager-remainder` from owed-whole to run, owing only its Foray-shaped case ids to A-40. `player/parity/exclusions.json` (856–858, 960–962): rewrite both `why`s — Swift's route policy is `RouteResume`, pinned by `route-resume` and `RouteResumeTests`; the JVM has none until A-61. Invert `jvmT/EngineCoreTest.java:584–621`'s "the known car resumes".

**Files:** `jvm/EngineCore.java`, `jvm/EngineState.java`, `jvmT/EngineCoreTest.java`, `jvmT/parity/JvmFamilies.java`, `jvmT/parity/ManagerEpisodeFamily.java`, `jvmT/parity/ParityBooksTest.java` (if it lists the books), `player/parity/jvm-pending.json`, `player/parity/exclusions.json`. **Depends on:** CH3-02, CH3-12 (EngineCore.java). **Risk:** medium — the JVM runs a family it never ran; the PR quotes the `ParitySuite` outcome for every `manager-remainder` case.

**Tests.** Characterization FIRST: `EngineCoreTest` — known car returns after a listener pause → resumes (today's assertion; flipped in commit 2 with `// RED on main: R3-01`); `stop()` with the deck audible behind a paused machine sends no pause (RED-today); grace-expiry row order and the missing relinquish row pinned as today. New: the JVM runs `manager-remainder/stop-is-silence-behind-a-paused-machine` and the family's other episode cases; reversed assertions. **Mutations killed:** restoring the resume branch; dropping the `audibleNow()` pause (fixture red on the JVM); swapping the grace order back.

### CH3-18 · Native-lane nudges are intents (opus, S)

**Issues:** R4-05.

**Exact change.** `player/native-facades.js`: `NativeManagerFacade` gains `seekBy(deltaSec, opts)` → engine `seekBy {sec}` (the contract already has the command; `EngineCore.swift:621–646` implements the pending-start rule "for the page's command and the car's alike"). `player/client.js` `seekEpisodeBy`/`nudgeBy` (~2090–2095) send it when `engineMode === "native"` instead of computing `skipTarget` from `episodePositionSec`; the JS lane is unchanged. Add the facade method to `player/parity/facades.json`.

**Files:** `player/native-facades.js`, `player/native-facades.test.js`, `player/client.js`, `test/transport-controls.test.js`, `player/parity/facades.json`, `test/suite-integrity.test.js`. **Depends on:** CH3-12 (client.js). **Risk:** low-medium — native-lane nudges now land where the engine says; the ±1 s coalescing staleness disappears with it.

**Tests.** Characterization FIRST: `test/transport-controls.test.js` — R4's repro (a `loadingItem` snapshot for B with `positionSec: 0`, 30↻ → `seekTo {sec: 30}`) pinned RED-today. New: native mode sends `seekBy {sec: 30}`; JS mode byte-identical. **Mutation killed:** falling back to `seekTo` in native mode.

### Wave 4 — the narrator reading and one session phase, parity at the wheel, one artwork loader (3 cards)

### CH3-19 · The core hears whether the narrator is speaking; one session phase gates every audible start (opus, M — hold)

**Issues:** R2-05 (iOS half), R2-08.

**Exact change.** `ios/Engine/Seams.swift` `Speaking` (228–244) gains `var reading: NarratorReading { get }`; `ios/Engine/SpeechNarrator.swift` answers `.speaking`/`.paused`/`.idle` from `current` and `paused`; `ios/Engine/ForayEngine.swift` `now()` (516–519) passes `narrator: seams.speaker.reading`. The core's two guards (`onInterruptionBegan`'s late-event rule, `reconcileNarrationInterrupted`'s `skipped-narration-speaking`) then run on a phone as they do in parity. One phase: `ios/Engine/EngineBoot.swift` (118) wires `sessionIsActive` to the core's `state.session == .active` once the engine exists; `ios/Engine/AudioSessionOwner.swift` keeps `phase` for its rows only (65–71, 220–229) and leaves it alone on an interruption the core ruled late.

**Files:** `ios/Engine/Seams.swift`, `ios/Engine/SpeechNarrator.swift`, `ios/Engine/ForayEngine.swift`, `ios/Engine/EngineBoot.swift`, `ios/Engine/AudioSessionOwner.swift`, `iosT/Engine/RecordingSeams.swift`, `iosT/Engine/ForayEngineHostTests.swift`, `iosT/Engine/AudioSessionOwnerTests.swift`, `iosT/Engine/SpeechNarratorTests.swift`. **Depends on:** CH3-15, CH3-16. **Risk:** medium — the gate every deck play, jingle and silence start reads changes owner; `InterludeSeamTests` and `SessionOwnershipTests` stay green untouched.

**Tests.** Characterization FIRST: `ForayEngineHostTests` — an interruption-began while the fake narrator is speaking stops the line (`stop cause=interruption`; RED-today); `AudioSessionOwnerTests` pins the owner's own phase on a late began (flips). New: the late began touches nothing; a jingle after it starts (no `fault implicit-activation`). **Mutations killed:** passing `.unknown` again in `now()`; reading the owner's phase in `sessionIsActive`.

### CH3-20 · Parity reaches the steering wheel (opus, M — hold)

**Issues:** R3-03, R3-04 (the family half), R3-08.

**Exact change.** (a) A `remote` verb arm that takes a raw command name (`togglePlayPause`, `skipBackward`, `skipForward`, `changePlaybackPosition`, `play`, `pause`, `nextTrack`, `previousTrack`), bypassing `MediaMapping.intent`, in `player/parity/runner.js`, `parity/EngineScenarioDriver.swift` (647–669) and `jvmT/parity/EngineScenarioDriver.java` (359–381). (b) A `deck: deadline` step in both drivers that feeds `.deadlineExceeded` (today every fixture failure is `failed: "missing file"`). (c) A new authored family `native-episode`, listed in `NATIVE_TOKEN_FAMILIES` in `player/parity/compare.js` and both comparators (`parity/Comparator.swift`, `jvmT/parity/Comparator.java`), so its `n.*` tokens (session, grace, stop cause, `failed`, restore) are compared; expectations recorded from the Swift core and checked by the JVM; cases: toggle with the deck audible behind a paused machine, back-15 during a cold load, a duplicate press, a load deadline on an episode, grace expiry, a relinquish. (d) R3-08: both cores drop `press.value` for `skipForward`/`skipBackward` (`EngineCore.swift:831–832`, `EngineCore.java:590–591`) — always `MediaMapping.SeekSteps()`; `value` stays for `changePlaybackPosition`; `coreT/ForayNarrationSkipTests.swift` (49–50) and the drivers send no value.

**Files:** `player/parity/runner.js`, `player/parity/compare.js`, `player/parity/run.test.js`, `player/parity/fixtures/native-episode/*` (new), `player/parity/manifest.json`, `player/parity/floors.json`, `player/parity/jvm-pending.json`, `parity/EngineScenarioDriver.swift`, `parity/Comparator.swift`, `parity/Families/` (register the family), `jvmT/parity/EngineScenarioDriver.java`, `jvmT/parity/Comparator.java`, `jvmT/parity/JvmFamilies.java`, `core/Engine/EngineCore.swift`, `jvm/EngineCore.java`, `coreT/ForayNarrationSkipTests.swift`, `tools/parity/record.mjs` (only if an authored family needs a flag), `test/suite-integrity.test.js`. **Depends on:** CH3-17 (the JVM must already write rows in Swift's order or the new family is red on day one), CH3-12. **Risk:** medium — the comparator change is the riskiest edit here: `NATIVE_TOKEN_FAMILIES` must widen by exactly one name, and every other family's `--check` must not move.

**Tests.** Characterization FIRST: `player/parity/run.test.js` pins that no fixture holds a `togglePlayPause` press and that `compare.js` strips `n.*` outside `prepare`/`prepare-narration` (both flip by design, stated). New: the `native-episode` family green on Swift and the JVM; `media-episode`'s `actions-platform-seek-offset-ignored` survives. **Mutations killed:** re-adding `press.value ??` in either core (a `native-episode` case with a 10 s head-unit interval red); swapping Java's grace order (family red on the JVM); a toggle that reads only the belief (the audible-behind-paused case red).

### CH3-21 · One artwork loader, with the legacy lane's retry-after rule (opus, S — hold)

**Issues:** R1-10.

**Exact change.** `ios/Engine/ArtworkCache.swift`: a failure is a retry time, not a permanent `failed` (`settle` → `failed.insert(src)`, 97–110): adopt the legacy `artworkRetryAfterSec = 45`. `ios/ForayAudioPlugin.swift` `artworkItem(for:)` (1349–1434) becomes a thin call into `ArtworkCache` (strip the `bundle://public/` prefix at the boundary); delete its private timeout/retry constants.

**Files:** `ios/Engine/ArtworkCache.swift`, `ios/ForayAudioPlugin.swift`, `iosT/Engine/NowPlayingPublisherTests.swift`, `iosT/ForayAudioPluginTests.swift`. **Depends on:** CH3-10 (ForayAudioPlugin.swift), CH3-16 (NowPlayingPublisherTests). **Risk:** low.

**Tests.** Characterization FIRST: `NowPlayingPublisherTests` (~614, "a dead source costs one attempt") pinned, then flipped: a dead source is retried after 45 s; `ForayAudioPluginTests` (~313) survives against the shared loader. **Mutation killed:** restoring the permanent `failed` set.

### Wave 5 — Android facade, the visibility rule, deletions (3 cards)

### CH3-22 · Android: one buffering derivation for the facade; the host passes the narrator reading (opus, S)

**Issues:** R5-08, R2-05 (Android half).

**Exact change.** Drop `Surface.buffering` from `and/engine/ForayEngineHost.java` (348–357); carry the core's `View.buffering` on `SessionView` in `jvm/MediaMapping.java` (one derivation, `state.buffering || loading`); `and/engine/EnginePlayer.java` (108–112) reads `view.buffering()` — no OR with `playbackRate == 0`. The host's `EngineNow` gains the narrator reading from its `Speaking` seam (the Java mirror of CH3-19), at `ForayEngineHost.java:255`.

**Files:** `and/engine/ForayEngineHost.java`, `and/engine/EnginePlayer.java`, `jvm/MediaMapping.java`, `andT/engine/EnginePlayerTest.java`, `andT/engine/ForayEngineHostTest.java`, `jvmT/PolicyPortTest.java`. **Depends on:** CH3-10 (MediaMapping.java, ForayEngineHost.java), CH3-19, CH3-07. **Risk:** low (lane off).

**Tests.** Characterization FIRST: `EnginePlayerTest` — duration unknown + loading → READY with a running clock (RED-today); `aStallIsBufferingSoTheLockScreensClockStops` (122–130) survives. New: the loading case is BUFFERING; the host passes `speaking` while the fake narrator speaks. **Mutation killed:** reading `Surface`-level buffering again.

### CH3-23 · "Is the page looking?" has one rule; the dead facade `toggle` goes (opus, S — hold)

**Issues:** R4-07, R4-09.

**Exact change.** `ios/Engine/EngineBridge.swift` `hello` (129–134) stops resetting `SnapshotCoalescer(visible: true)` (keep the window cancel) — the reference engine already leaves visibility alone. `player/native-engine.js` (159) initialises `visible` from `document.hidden` where a document exists; `player/client.js` sends `setPageVisible` once after `hello()` (beside the existing `visibilitychange` handler, 4385–4392). Delete `EngineState.pageVisible` and its write in both cores (`core/Engine/EngineState.swift:230`, `core/Engine/EngineCore.swift:410`, `jvm/EngineState.java:125`, `jvm/EngineCore.java:276`) — written, never read. Delete `NativeManagerFacade.toggle()` (`player/native-facades.js:334`; `git grep -n "\.toggle("` finds no caller); the contract's `toggle` command stays (the reference engine and parity use it) — say so in the PR.

**Files:** `ios/Engine/EngineBridge.swift`, `iosT/Engine/EngineBridgeTests.swift`, `player/native-engine.js`, `player/native-engine.test.js`, `player/native-facades.js`, `player/native-facades.test.js`, `player/client.js`, `player/parity/facades.json`, `core/Engine/EngineState.swift`, `core/Engine/EngineCore.swift`, `jvm/EngineState.java`, `jvm/EngineCore.java`, `test/suite-integrity.test.js`. **Depends on:** CH3-18, CH3-20. **Risk:** low.

**Tests.** Characterization FIRST: `EngineBridgeTests` — `setPageVisible(false)` then `hello` → visible again (RED-today vs the reference); `native-engine.test.js` — a hidden document starts `visible = true` (RED-today). New: both stay hidden. **Mutation killed:** restoring the reset in `hello`.

### CH3-24 · Delete the engine's test-only and writer-less doors (opus, XS — hold)

**Issues:** R1-04 (adjusted), R1-08.

**Exact change.** Delete `ForayEngine.shared` and `ForayEngine.boot(seams:config:positions:)` (`ios/Engine/ForayEngine.swift:59–74`) and `ForayEngineHostTests.testBootBuildsOneEnginePerProcess` (~447–453) — the one-engine guarantee is `EngineOwnership.bootEngine`'s, pinned by `EngineOwnershipTests`; fix `docs/native-engine-plan.md:275` to name `ForayEngineColdPath.bootIfNeeded()`. Delete `EngineStore.onEmit`/`onPendingEvent` (`ios/Engine/EngineStore.swift:41–45, 194–200`; no writer anywhere) and the `emit`/`appendEvent` fan-out they feed if `EngineOutput` (`ios/Engine/Seams.swift`) has no other implementation.

**Files:** `ios/Engine/ForayEngine.swift`, `ios/Engine/EngineStore.swift`, `ios/Engine/Seams.swift`, `iosT/Engine/ForayEngineHostTests.swift`, `iosT/Engine/EngineStoreTests.swift`, `player/parity/xctest.json` (if it names the deleted test), `docs/native-engine-plan.md`. **Depends on:** CH3-19, CH3-16 (files). **Risk:** none.

**Tests.** None new; `coverage.test.js` green after `xctest.json` is updated; `ios-kit` green.

## 4. Sequencing

Waves run in order; a wave starts when the previous wave's PRs are all merged and `node tools/ci/run-suites.mjs`, `record.mjs --check`, `ios-kit`, `engine-parity` and `android-build` are green on `origin/main`. Within a wave every card is independent by file; native cards may overlap in CI.

- **Wave 1** (9): CH3-01, 02, 03, 04, 05, 06, 07, 08, 09. Shared-file check: `EngineCore.swift`/`EngineCore.java` — CH3-02 only; `PlayerQueueState.swift`/`PlayerQueueStateMachine.java` — CH3-01 only; `ForayEngine.swift`, `Seams.swift`, `RecordingSeams.swift` — CH3-03 only; `ForayAudioPlugin.swift`, `EngineBridge.swift`, `shell-invariants.test.mjs` — CH3-06 only; `client.js` — CH3-04 only.
- **Wave 2** (6): CH3-10, 11, 12, 13, 14, 15. `ForayEngine.swift`/`ForayAudioPlugin.swift`/`MediaMapping.*`/`ForayEngineHost.java` — CH3-10; `EngineCore.*`/`EngineBridge.swift`/`client.js` — CH3-12; `AVDeck.swift` — CH3-11; `DeckPair.swift` — CH3-13; `SpeechNarrator.swift`/`AudioSessionOwner.swift` — CH3-15.
- **Wave 3** (3): CH3-16 (`ForayEngine.swift`, `Seams.swift`, shell-invariants), CH3-17 (`EngineCore.java`, JVM books), CH3-18 (`client.js`, `native-facades.js`).
- **Wave 4** (3): CH3-19 (`ForayEngine.swift`, `Seams.swift`, `SpeechNarrator.swift`, `AudioSessionOwner.swift`), CH3-20 (both cores, both drivers, comparators), CH3-21 (`ArtworkCache.swift`, `ForayAudioPlugin.swift`).
- **Wave 5** (3): CH3-22, CH3-23, CH3-24.

**The two append-only books.** `test/suite-integrity.test.js` (one floor line per card — rebase and keep both) and the recorder's outputs `player/parity/manifest.json` / `floors.json` (one family entry per card — rebase, then re-run `node tools/parity/record.mjs --check`; never hand-merge a manifest). No other file is shared inside a wave.

An Opus reviewer reads each DRAFT against its card (characterization tests present and green before the change; RED-today pins committed red in commit 1 and green after; every named mutation run; nothing outside the file list changed; `--check` and the CI runs quoted; `hold` removed only after a green `ios-kit` on the head SHA), marks it ready and merges when CI is green.

**Cross-package rules that bind here:** the Android A-cards (A-28/29/31/40/60/61/67) touching `ForayEngineHost.java`, `ExoDeck.java`, `EngineCore.java` or `jvm-pending.json` run one at a time with the CH3 card on the same file; no card adds a `logEvent` type or a `cp_` key; no card touches `app.js`, `styles.css` or `index.html`.

## 5. Deferred — founder or product rulings, not engineering

| issue | title | why deferred | what this package does meanwhile |
|---|---|---|---|
| R5-06 (low) | Two Media3 `SimpleBasePlayer` facades (`WebViewPlayer`, `EnginePlayer`) hand-implement one mapping (neighbourhood timeline, both next/previous spellings, `setMaxSeekToPreviousPositionMs(0)`, STATE_BUFFERING for a stall, the metadata pairs, `handleSeek`) with no pin tying them | A shared `SessionFacade` is the DHH answer only if both lanes live on; if A-31 deletes the Android JS lane, the abstraction is speculative and the right move is to delete `WebViewPlayer` then. Whether the JS lane survives A-31 is an Android-plan ruling (`docs/plans/android-assessment.md` §6). | CH3-22 makes `EnginePlayer`'s buffering rule single-sourced; nothing else. |

## Appendix A — the 40 verified issues

Format: **id** · title — *severity · category · verdict* → card. **Where:** anchors at `9fffb085` (= `7276893c`). **Fails:** the failure scenario (or "none today" when the cost is drift or hygiene). Abbreviations as in §3.

### R1 — iOS host layer (10)

**R1-01** · An artwork load still in flight at relinquish rewrites Now Playing over the legacy lane's entry — *medium · corner-case-bug · confirmed* → CH3-16. **Where:** ios/Engine/NowPlayingPublisher.swift 83–97, 124–129; ios/Engine/ForayEngine.swift 240–281 (`teardown` leaves the publisher's `current`; its own comment says "nothing of ours may write it again"); ios/Engine/ArtworkCache.swift 68 (`timeoutSec = 10`). **Fails:** cold boot paints a restored episode on a slow link (artwork load starts); the page relinquishes; the legacy lane paints its entry; up to 10 s later the artwork lands and the car's display snaps back to the engine's pre-relinquish title and an extrapolated position.

**R1-02** · A hello-watchdog relinquish leaves the engine's stale entry with every command disabled, and nothing will overwrite it — *medium · corner-case-bug · confirmed* → CH3-06. **Where:** ios/Engine/EngineOwnership.swift 421–436, 468–486; ios/ForayAudioPlugin.swift 320–355 (`applyCommandAvailability(.empty)` at 353), 1205–1209 (`reassertNowPlaying` only re-asserts the page's last payload). **Fails:** a car's wake cold-boots "Episode X, paused" with a live play button; a broken bundle never says hello; 15 s later the watchdog hands over and the head unit shows "Episode X, paused" with every button dead for the rest of the process.

**R1-03** · The 2026-09-23 "track pair only where a track button exists" ruling is implemented in the legacy lane only — *medium · inconsistency · confirmed* → CH3-10. **Where:** core/Policy/MediaMapping.swift 530–551 (no route input); ios/ForayAudioPlugin.swift 279, 350, 538–540, 1597, 1639–1640; docs/DECISIONS.md 1126–1134. **Fails:** native lane (the iOS default), phone on its speaker, Up Next non-empty: the lock screen draws ⏭ instead of 30↻ — the p-impatient-3 complaint the ruling fixed.

**R1-04** · `ForayEngine.shared`/`boot` is a test-only second "one engine per process" guard; its comment and the plan lie about who calls it — *low · duplicated-state · adjusted (medium → low)* → CH3-24. **Where:** ios/Engine/ForayEngine.swift 59–74; ios/Engine/EngineOwnership.swift 213, 309–324; ios/Engine/EngineBoot.swift 168–171; docs/native-engine-plan.md 275. `git grep -n 'ForayEngine.boot(\|ForayEngine.shared'` → `ForayEngineHostTests.swift:450–453` and the plan only. **Fails:** none today; a caller following the comment builds a second engine.

**R1-05** · The last-written Now Playing entry is held twice, on two clocks (`ForayEngine.published`, `NowPlayingPublisher.current`) — *low · duplicated-state · reviewer-checked* → CH3-16. **Where:** ios/Engine/ForayEngine.swift 599–608, 687–694; ios/Engine/NowPlayingPublisher.swift 68–70, 124–129. **Fails:** none today; R1-01 exists because the publisher holds state the host does not know about.

**R1-06** · "Which lane owns this process" is spelled in seven flags across four files — *low · duplicated-state · reviewer-checked* → CH3-06. **Where:** ios/EngineModeFlag.swift 13–16; ios/Engine/EngineOwnership.swift 216–217, 482–486; ios/ForayAudioPlugin.swift 179, 284, 321; ios/Engine/ForayEngine.swift 84, 465; ios/Engine/EngineBridge.swift 253. **Fails:** none today (all flip in one main-thread call); `commandsRegistered` is a third once-guard for a function with one gated caller.

**R1-07** · The `sessionOwnedByEngine` guards inside foray-audio's legacy lane are unreachable — *low · dead-code · reviewer-checked* → CH3-06. **Where:** ios/ForayAudioPlugin.swift 340–342, 1095–1108, 1141–1149, 1166–1174; ios/Engine/EngineOwnership.swift 468–474 (flag cleared before the legacy registration runs; pinned `EngineOwnershipTests:395`). **Fails:** none; a reader waits for a `skipped-engine-owned` row that cannot appear.

**R1-08** · `EngineStore.onEmit`/`onPendingEvent` are never assigned; their comment says the bridge sets them — *low · dead-code · confirmed* → CH3-24. **Where:** ios/Engine/EngineStore.swift 41–45, 194–200; `git grep -n onPendingEvent` → the declaration and its call only. **Fails:** none; two fan-outs for one event, one going nowhere.

**R1-10** · Two artwork loaders in one plugin with different retry rules; the engine's forgets the mobile-native-6 lesson — *low · duplicate · reviewer-checked* → CH3-21. **Where:** ios/ForayAudioPlugin.swift 243–250, 1344–1434 (`artworkRetryAfterSec = 45`); ios/Engine/ArtworkCache.swift 68, 97–110 (`failed.insert(src)`, permanent). **Fails:** native lane: an artwork fetch that times out as the car connects leaves CarPlay bare for the rest of the item.

**R1-17** · The bridge's `lastError` is cleared only on a successful `playEpisode` — *low · inconsistency · adjusted (no page reader today; folded into the file-fallback card, which adds one)* → CH3-12. **Where:** ios/Engine/EngineBridge.swift 98, 211, 294, 317; player/engine-contract.js 629. **Fails:** none today; once CH3-12's attach-time settle reads it, a stale code would mark the wrong record.

### R2 — iOS decks, audio session, the core's session paths (9)

**R2-01** · An interruption that lands during a load or a seam beat is never resumed — *high · corner-case-bug · confirmed* → CH3-01. **Where:** core/Reducer/PlayerQueueState.swift 485–491, 501–528; core/Engine/EngineCore.swift 1698–1737; player/queue-state.js 441–447; fixture `queue-state/interruption-began-during-load` pins the `false`, nothing pins began-during-load → ended(shouldResume). **Fails:** Foray in the car; a clip reaches its out-point (or a wheel ▶ is still cold-loading); Apple Maps speaks a turn or the driver says "Hey Siri"; the interruption ends with `shouldResume: true`; the reducer says "was not playing" and stays paused: prompt, then silence.

**R2-02** · A route flap during a call or Siri marks the pause "route-lost", so the interruption's should-resume is refused — *medium · corner-case-bug · adjusted (high → medium: delivery order unverified on a device)* → CH3-02. **Where:** core/Engine/EngineCore.swift 1747–1754 (unconditional `state.pausedByRoute = true`), 1698–1704; player/queue-manager.js 1342–1352. **Fails:** Bluetooth car, a call arrives, the output flips A2DP → HFP → A2DP while it rings, the call ends with should-resume: `interruption ... resumed=false why=route-lost`, and 4a stays paused.

**R2-03** · A media-services reset rebuilds nothing: both decks keep their dead `AVPlayer` — *high · corner-case-bug · confirmed (code path); device behaviour per Apple's reset guidance* → CH3-03. **Where:** ios/Engine/AudioSessionOwner.swift 181–190; ios/Engine/AVDeck.swift 369 (`let player: AVPlayer`); ios/Engine/ForayEngine.swift 549–550; ios/Engine/SpeechNarrator.swift 448–449; ios/Engine/InterludePlayer.swift 195–197. **Fails:** mediaserverd resets mid-drive; every later play attaches an item to the dead player, never reaches `.ready`, and stops `cause=load-deadline` after 20 s until the app is killed; a drive paste shows `mediaServicesReset` followed by `deadline playerStatus=failed`.

**R2-04** · §16 "continue a load that is getting somewhere" is keyed on precise timing; the shipping CBR exemption made most clips approximate — *medium · drift-risk · reviewer-checked* → CH3-11. **Where:** ios/Engine/AVDeck.swift 94–112, 661–673, 696–705, 997–1018; ios/Engine/EngineBoot.swift 105–113 (`approximateCBRClips = true`). **Fails:** thin car network, a CBR clip passes 20 s with megabytes fetched; the retry throws them away and starts from zero; two in a row is `stop cause=load-deadline`.

**R2-05** · The host never tells the core whether the synthesiser is speaking, so the core's two "still speaking" guards run only in parity — *medium · corner-case-bug · reviewer-checked* → CH3-19 (iOS), CH3-22 (Android). **Where:** core/Engine/DeckVocabulary.swift 190–205 (`EngineNow.narrator` defaults `.unknown`); ios/Engine/ForayEngine.swift 516–519; ios/Engine/Seams.swift 228–244; and/engine/ForayEngineHost.java 255. **Fails:** a spoken line in the car; a declined call's late interruption cuts the line and pauses the Foray until a press.

**R2-06** · The narration voice's `AVAudioEngine` is started for the first line and never stopped — *medium · leak · reviewer-checked* → CH3-15. **Where:** ios/Engine/SpeechNarrator.swift 448–449, 526–612 (the only `engine.stop()` is at 592, inside `connect`); ios/Engine/AudioSessionOwner.swift 161–175. **Fails:** after a Foray's first line the app renders silence indefinitely (the background keep-alive the `silenceNode` flag is kept OFF for), and the close row reports `deactivated ok=false token=is-busy`.

**R2-07** · A prepare that misses as not-ready leaves the standby fetching the same file while the playing deck cold-loads it again — *medium · corner-case-bug · reviewer-checked* → CH3-13. **Where:** ios/Engine/DeckPair.swift 237–268; core/Policy/DeckPolicyReadings.swift 121–131, 160–167. **Fails:** a slow car network at a seam: two `AVPlayerItem`s fetch one URL, the load the listener waits through slows, a deadline and a skip become likelier.

**R2-08** · Two session phases: the owner's gates the shell's audible starts, the core's gates the core's, and they disagree on known inputs — *low · duplicated-state · reviewer-checked* → CH3-19 (CH3-15 closes the `isBusy` divergence). **Where:** ios/Engine/AudioSessionOwner.swift 65–71, 119, 161–175, 220–229; ios/Engine/EngineBoot.swift 118; ios/Engine/ForayEngine.swift 856–866. **Fails:** none today; becomes "no jingle for the rest of the Foray" once R2-05 is fixed alone.

**R2-09** · `DeckPolicy` says AVDeck's decisions are made there; its deadline, fine-wake, recovery and readings rules have no native caller — *low · stale-comment · reviewer-checked* → CH3-14. **Where:** core/Policy/DeckPolicy.swift 6–13, 70–139; core/Policy/DeckPolicyReadings.swift 5–8; ios/Engine/AVDeck.swift 147, 155. **Fails:** none; a change to AVDeck's 20 s / 8 s moves no fixture while the comment promises one.

### R3 — Swift ↔ Java core drift and parity coverage (7)

**R3-01** · The JVM core still carries the known-car-route auto-resume the founder ruled deleted (Q5), with no listener-pause guard — *medium · corner-case-bug · confirmed* → CH3-17. **Where:** jvm/EngineCore.java 1236–1265 (learns on ANY route event naming a car, resumes on `Interrupted(wasPlaying)` with no `pausedByListener` read); jvm/EngineState.java 63–68; jvmT/EngineCoreTest.java 584–621 (asserts "the known car resumes"); docs/DECISIONS.md 848. **Fails:** today unreachable (the Android host never names a route); at A-61, the listener pauses on the wheel, parks, and next morning the car reconnects and 4a plays the episode they paused.

**R3-02** · The JVM `stop()` lacks the "stop is silence" postcondition; the case that pins it is shelved inside a family owed whole to A-40 — *medium · corner-case-bug · confirmed* → CH3-17. **Where:** jvm/EngineCore.java 474–496; core/Engine/EngineCore.swift 672–681; `player/parity/fixtures/manager-remainder/transport.json` `stop-is-silence-behind-a-paused-machine`; player/parity/jvm-pending.json 16. **Fails:** (Android native lane) audio audible behind an interrupted machine (Media3 resumed after a transient loss), the listener closes: Now Playing clears, every command disabled, ExoPlayer keeps playing.

**R3-03** · No fixture drives a car or lock-screen press into either core for an episode; the vocabulary cannot express `togglePlayPause` — *medium · drift-risk · reviewer-checked* → CH3-20. **Where:** parity/EngineScenarioDriver.swift 647–669; jvmT/parity/EngineScenarioDriver.java 359–381; ios/Engine/RemoteSurface.swift 71; player/parity/jvm-pending.json 26–41. **Fails:** none today (both `onRemote` bodies agree for episodes); the next one-platform edit to remote handling changes what the AVRCP play/pause does and nothing cross-checks it.

**R3-04** · The comparator strips every `n.*` token outside `prepare`/`prepare-narration`; no driver feeds a load deadline; two Java drifts already pass — *medium · drift-risk · reviewer-checked* → CH3-17 (the drifts), CH3-20 (the family). **Where:** player/parity/compare.js 28–31, 50, 76–77; parity/Comparator.swift 22, 71–74; jvmT/parity/Comparator.java 28, 74–77; core/Engine/EngineCore.swift 1984–1985 vs jvm/EngineCore.java 1322–1323 (grace order); EngineCore.swift 3174 vs EngineCore.java 1600–1611 (no relinquish row). **Fails:** an Android and an iOS drive paste disagree about why audio stopped (`load-deadline` is fixture-blind on both) while parity stays green.

**R3-05** · Parity notes credit the native engines with a route rule they do not have — *low · stale-comment · reviewer-checked* → CH3-02 (queue-manager.js), CH3-17 (exclusions.json). **Where:** player/parity/exclusions.json 856–858, 960–962; player/queue-manager.js 1330–1339. **Fails:** none; they point a reader at the one core (Java) that breaks the rule.

**R3-07** · Swift gates "waiting is buffering" behind a provisional `MEASURE` knob; Java hard-codes it untagged — *low · drift-risk · reviewer-checked* → CH3-17. **Where:** core/Engine/EngineCore.swift 171–180, 1585–1587; jvm/EngineCore.java 1114. **Fails:** none today; if NE-38e flips Swift, Android's car clock freezes through every brief stall on one platform only.

**R3-08** · Both cores honour a skip interval carried on the press that no host sends — *low · needless-complexity · reviewer-checked* → CH3-20. **Where:** core/Engine/EngineCore.swift 831–832; jvm/EngineCore.java 590–591; ios/Engine/RemoteSurface.swift 108–115; and/engine/EnginePlayer.java 233–238. **Fails:** none today; a host change forwarding the head unit's interval would silently change the step on one platform against the JS rule.

### R4 — the page's side of the bridge, foray-downloads (9)

**R4-01** · Every episode the native engine walks to by itself streams, even when it is downloaded — *high · corner-case-bug · confirmed* → CH3-04. **Where:** player/client.js 3966–3976 (`sendEnginePlan` sends `chain` as built), 4718–4724 and 4958 (`localSourceFor` used only inside `ForayPlayer.play`); player/continuation.js 168–186; core/Engine/EngineInput.swift 32–33. **Fails:** a downloaded Up Next on an offline drive: the first episode plays from its file; Continuous playback (or the wheel's ⏭) walks to the next one over a dead link; `stop cause=load-deadline`; silence.

**R4-02** · The page keeps each download's absolute path forever; the plugin says the path changes on every update and the page must re-read `list()`, which nothing calls — *high · corner-case-bug · confirmed* → CH3-05. **Where:** mobile/plugins/foray-downloads/ios/Sources/ForayDownloadsPlugin/ForayDownloadsPlugin.swift 21–26; player/download-store.js 236, 442–447; player/download-bridge.js 225–246. **Fails:** after a TestFlight/App Store update every downloaded episode is "missing"; offline in the car each is skipped with the earcon.

**R4-03** · The engine has no fallback for a downloaded file that will not open; the page's fallback hears of it only through an event dropped while the page is hidden — *medium · corner-case-bug · reviewer-checked* → CH3-12. **Where:** ios/Engine/EngineBridge.swift 316–320 (`guard coalescer.visible`); core/Engine/EngineCore.swift 1335–1346; player/client.js 4779–4797, 4960–4966; `git grep source_audio_url -- '*.swift'` → empty. **Fails:** a removed or moved file, the app killed overnight, a wheel ▶ restores the `file://` item: a stop row, no stream retry, no earcon, silence.

**R4-04** · The page's download status is a second copy of the native index fed only by live events; an event sent before the page listens, or never sent, leaves "Downloading…" forever — *medium · duplicated-state · confirmed (the silent `reconcileInterrupted`, the missing `list()` caller)* → CH3-05. **Where:** ForayDownloadsPlugin.swift 46–51; DownloadStore.swift 155–180; android DownloadStore.java 253–269; player/download-bridge.js 225–246. **Fails:** a transfer that finishes while iOS has terminated 4a is replayed before the page subscribes; the row stays `downloading`, the button disabled, the drive streams.

**R4-05** · In the native lane ↺15/30↻ are computed from the page's own copy of the playhead and sent as an absolute `seekTo` — *medium · duplicated-state · reviewer-checked (node repro)* → CH3-18. **Where:** player/client.js 2016–2033, 2090–2095, 4912–4915; player/native-facades.js 126, 338–341; core/Engine/EngineCore.swift 621–646. **Fails:** a wheel ⏭ starts the next episode at 38:00; the bar shows 0:00; 30↻ before the load lands starts it at 0:30 and the resume point is overwritten.

**R4-06** · `voiceFallback` is spelled three incompatible ways — *medium · inconsistency · confirmed* → CH3-09. **Where:** player/engine-contract.js 105, 630 (`nullable(str)`); player/native-facades.js 267–270 (`Boolean(v)`); player/client.js 3986 (`=== true`); core/Contract/EngineBridgeRules.swift 209–252 (never emitted). **Fails:** today the "spoken in a different voice" notice is dead on iOS; the obvious Swift fix (emit a Bool) gets every snapshot refused and freezes the bar.

**R4-07** · "Is the page looking?" is held in four places and they disagree — *low · duplicated-state · reviewer-checked* → CH3-23. **Where:** player/native-engine.js 159, 391–396, 418–426; player/client.js 4385–4392; ios/Engine/EngineBridge.swift 129–134; core/Engine/EngineCore.swift 410 + EngineState.swift 230; jvm/EngineCore.java 276 + EngineState.java 125. **Fails:** nothing audible; snapshot traffic into a suspended WebView; a Swift/reference divergence.

**R4-09** · `NativeManagerFacade.toggle()` has no caller — *low · dead-code · reviewer-checked* → CH3-23. **Where:** player/native-facades.js 334. **Fails:** none.

**R4-10** · Two methods named `fileSrc` do different things; the native one has no caller — *low · dead-code · reviewer-checked* → CH3-05. **Where:** player/download-bridge.js 237–246; ForayDownloadsPlugin.swift 41, 111–117; DownloadStore.swift 306–324. **Fails:** none; it is why R4-02 looks handled.

### R5 — Android plugin layer (5)

**R5-01** · After the core relinquishes, the host hands the session its pre-relinquish surface and nothing releases the Media3 session — *medium · corner-case-bug · confirmed* → CH3-07. **Where:** and/engine/ForayEngineHost.java 163–175, 238–252, 359–372; and/ForayPlaybackService.java 131–135, 232–269; and/ForayAudioPlugin.java 237–247. **Fails:** (at A-28) the car shows two "4a" sessions, the wheel bound to the dead one (every press `RELINQUISHED`).

**R5-02** · Activation on Android can never be refused; a denied focus request surfaces as `success` + an interruption instead of iOS's `commandFailed` — *medium · drift-risk · reviewer-checked* → CH3-08. **Where:** and/ForayPlaybackService.java 319–328; and/engine/EngineSeams.java 33–43; and/engine/ExoDeck.java 608–637; and/engine/FocusMapping.java 70–84. **Fails:** (native lane) a driver on a call presses ▶: the press "succeeds", the lock screen may show BUFFERING with a pause glyph, nothing sounds, nothing resumes after the call.

**R5-03** · ExoDeck's deadline rule has drifted from AVDeck's §16 while its header says "the same number as AVDeck's"; `HandlerTiming` misdescribes the deadline's clock — *medium · drift-risk · confirmed* → CH3-14 (comments; the port is A-40/A-60). **Where:** and/engine/ExoDeck.java 160–164, 579–604; and/engine/HandlerTiming.java 13–17; ios/Engine/AVDeck.swift 94–112, 147, 155. **Fails:** none today for episodes; at A-40 the iOS-fixed `load-deadline` → cold-restart loop returns on Android.

**R5-05** · `isHosting()` reads a non-volatile `tornDown` off the main thread — *low · thread-safety · reviewer-checked* → CH3-07. **Where:** and/ForayPlaybackService.java 117–118, 131–135; and/engine/ForayEngineHost.java 67, 102. **Fails:** none audible; a stale answer lets the legacy service start beside a live native one (R5-01).

**R5-08** · "Buffering" reaches the facade twice, derived differently, then OR'ed — *low · duplicated-state · reviewer-checked* → CH3-22. **Where:** and/engine/ForayEngineHost.java 348–357; jvm/EngineCore.java 172–176; jvm/MediaMapping.java 254–265; and/engine/EnginePlayer.java 108–112. **Fails:** rare: an item with no known duration shows a running clock during its load; the car's clock runs on and snaps back.

## Appendix B — verified, below the cut (16)

Real, evidenced, and without drive-time risk; not carded. Listed so the next review does not re-find them. Ids are the reviewers'.

- **R1-09** `ForayEngine.post(fromAnyThread:)` is test-only (`ForayEngineHostTests:430`); its comment names callers that hop by themselves. Delete with its test when CH3-24's file is next open.
- **R1-11** `HoldPolicyStore` is a second `UserDefaults` door for `EnginePrivateKey.holdPolicy`; `shell-invariants.test.mjs:3687–3700` names it "THE ONE EXCEPTION … folding it into EngineStore is a follow-up"; `makeEngine` loads it twice.
- **R1-12** `MainQueueTiming`'s header says the engine's timers are "the position cadence and the hold release"; it now also runs the 1 Hz heartbeat (#1124), the narration tick, the seam beat and the bridge window. The 50 ms leeway is still fine.
- **R1-13** `runLegacyRegistration` writes `trackRoutePresent`/`lastIntervalsKey` on main while every other writer is on `stateQueue`; safe today only because the native page uninstalls the shim (`client.js:390`). CH3-10 removes `trackRoutePresent`'s private computation; the queue rule stays a note.
- **R1-14** A press's route is read twice per press in two spellings (`RemotePress.routePort` "CarAudio" vs `EngineNow.route`; legacy `portToken` "carplay").
- **R1-15** `EngineOwnership.relinquish`'s explicit `engine.teardown()` after a non-deferred verdict is a no-op second path (`runTurn` already tears down at `ForayEngine.swift:465`).
- **R1-16** A present-but-unparseable restore record is reported `record=none` and left in place.
- **R1-18** `publishSurface`'s `via` ladder re-derives what `rewriteReason` already decided.
- **R3-06** `commandAvailability`/`commandSnapshot`/`mediaView` are called by no parity runner although `EngineSurface.swift` says "fixture-pinned"; CH3-10 adds the fixture group and makes the sentence true.
- **R4-08** The snapshot body is built twice (Swift `EngineSnapshot.body`, JS `_body`) and they disagree on `effectiveRate` inside a seam gap (`EngineBridgeRules.swift:205` vs `reference-engine.js:410`); no page code reads `effectiveRate` today.
- **R5-04** `ExoDeck.debugFault` defaults to a no-op in every build (the Swift twin asserts in DEBUG and is pinned).
- **R5-06** Two `SimpleBasePlayer` facades — deferred, §5.
- **R5-07** `seekButtons()`, the custom-command grant and the notification channel are built twice, once per Android service.
- **R5-09** `PlaybackKeepAliveService` and `WebViewPlayer` headers say nothing has run on a device or emulator; `docs/android-emulator-measurements.md` §1–§7 says otherwise.
- **R5-10** #924's JVM home is named A-42 in `EngineCore.swift:819–824` and A-40 in `jvm-pending.json`.
- **R5-11** `SessionMonitor.current()` and `ExoDeck.token()` have no caller (`git grep` → declarations only); the 3-arg `ForayAudioPlugin.sessionEvent` is test-only.

**Checked by the reviewers and not filed** (so no one re-checks them): every core-armed timer, the grace task, the observers and remote targets are cancelled on `teardown()` and pinned to zero live; the #1124 heartbeat is armed only while rate > 0 and cancelled on rate 0, clear and teardown; `RemoteSurface.deliver`'s `DispatchQueue.main.sync` cannot deadlock against the legacy `stateQueue.sync`; every `AVAudioSession` call is on main; AVDeck's observers and timers are cancelled on every exit and every async callback is generation-checked; SessionPolicy, MediaMapping (outside `commandAvailability`), RestoreRecord and the three comparators are identical across Swift and Java and pinned by JVM-run families; `floors.json` equals every family's manifest count and is raise-only; JS ↔ Swift contract decoding agrees field by field; snapshot extrapolation freezes on a stall within the ≤ 1 s coalescing window; Android's transient focus loss survives a pause (pinned on a real ExoPlayer).
