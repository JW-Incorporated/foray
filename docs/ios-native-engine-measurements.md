# iOS native engine: measurements

The running record of what CI has measured for the native iOS playback
engine (`docs/native-engine-plan.md`). The plan's rule applies to every line
here: no `swift` or `xcodebuild` runs on the Windows machine this repo is
written on, so every Swift claim is either **CI-executed** (with the job, the
run and the head SHA) or marked **not executed**. An estimate is labelled as
one and is never quoted as a measurement.

Cards append their own section. NE-01 (the packaging spike) wrote §1-§6;
NE-25a (the click-track spike) wrote §7, NE-15 (AVDeck) §8, NE-06
(engine-parity CI) §9, NE-25b (two-deck preroll) §10 and NE-25c (the speech
smoke and the session probe) §11.

## 1. What NE-01 changed, in one paragraph

`mobile/plugins/foray-audio/foray-engine-core/` is a new, pure SwiftPM package
(Foundation only; iOS 15, macOS 12) with two products: `ForayEngineCore` (one
trivial type, `EngineHandshake`, plus the `SharedRowStore` prefix) and
`ForayEngineParity` (a stub runner that returns results as data and imports no
XCTest). `foray-audio`'s `Package.swift` depends on it by path;
`ForayAudioPlugin` links the core, and `ForayAudioPluginTests` links the parity
library. The plugin gained a stub `engineHello` that resolves
`{mode: "legacy", reason: "not-built"}`. No page calls it, so the app behaves
exactly as before.

## 2. The claims, and what executed them

The runs are all on PR #751 (base `engine/m1`). "Before" is commit `2baa8f8a`
(no engine code; it corrects one pre-existing legacy test, see §5). "After"
is commit `c4cc751d`, the commit that adds the package.

| Claim | Status | Evidence |
|---|---|---|
| The core builds and its host tests pass on macOS (`swift test --package-path mobile/plugins/foray-audio/foray-engine-core`): 6 tests, 0 failures | **CI-executed** | ios-kit, run 35952197000, job 107482909168, `c4cc751d` |
| The core builds and passes on Linux | **Not executed.** G-1a's `engine-parity` job (NE-06) is the first Linux run | none yet |
| `xcodebuild test -scheme ForayAudio` is green with the core folded in: 36 tests (33 existing + 3 new), 0 failures | **CI-executed** | ios-kit, run 35952197000, `c4cc751d` |
| The parity library runs inside the plugin's test target (`EngineParityWrapperTests`, 2 smoke cases) | **CI-executed** | same run |
| The Preferences prefix round-trip against the REAL `@capacitor/preferences` 8.0.1 class passes, and was executed rather than skipped (`CapacitorStoragePrefixTests`, "passed (0.009 seconds)") | **CI-executed** | same run; the test step resolved `CapacitorPreferences: .../mobile/node_modules/@capacitor/preferences @ local` |
| The scheme lists are unchanged (§3) | **CI-executed** | before: run 35951455396 (`2baa8f8a`); after: run 35952197000 (`c4cc751d`) |
| The app builds for the Simulator and for a device with the core folded in, through `cap add ios` | **CI-executed** | ios-build, run 35952197034, job 107482908831, `c4cc751d`: `** BUILD SUCCEEDED **` in both logs |
| The app's resolved package graph is the previous one plus exactly `ForayEngineCore` (§4) | **CI-executed** | `spm-resolve.log` in the `ios-shell-evidence` artifact of runs 35951455427 (before) and 35952197034 (after) |
| The Preferences pin never reaches the app's graph | **CI-executed** (the after graph in §4 has no entry the before graph lacks, apart from `ForayEngineCore`), and pinned statically by `shell-invariants.test.mjs` | as above |
| The nested package resolves, so the card's fallback ("a second target in the same package") was **not needed** | **CI-executed** | as above |
| The app bundle size did not move | **CI-executed**, at `du -sh` granularity: 147M before and after | `app-size.txt` in both artifacts |
| `engineHello` answers `{mode: "legacy", reason: "not-built"}` over the bridge | **Not executed.** No page calls it before NE-20/NE-21. The answer's dictionary is executed by both wrappers (host and Simulator), and `shell-invariants.test.mjs` pins that the method body copies it and never rejects | — |

## 3. `xcodebuild -list`, before and after

`ci.yml`'s ios-kit prints the list on every run, just before each plugin's
`xcodebuild test`. Xcode names a package's schemes from its products; the core's
two products belong to the NESTED package, so `foray-audio` keeps one product
and one scheme, and `shell-invariants.test.mjs` pins the single product.

Before (run 35951455396, `2baa8f8a`):

```
Resolved source packages:
  ForayAudio: /Users/runner/work/foray/foray/mobile/plugins/foray-audio
  capacitor-swift-pm: https://github.com/ionic-team/capacitor-swift-pm.git @ 8.5.2

Information about workspace "foray-audio":
    Schemes:
        ForayAudio

Information about workspace "foray-tts":
    Schemes:
        ForayTts
```

After (run 35952197000, `c4cc751d`):

```
Resolved source packages:
  ForayEngineCore: /Users/runner/work/foray/foray/mobile/plugins/foray-audio/foray-engine-core @ local
  capacitor-swift-pm: https://github.com/ionic-team/capacitor-swift-pm.git @ 8.5.2
  ForayAudio: /Users/runner/work/foray/foray/mobile/plugins/foray-audio

Information about workspace "foray-audio":
    Schemes:
        ForayAudio

Information about workspace "foray-tts":
    Schemes:
        ForayTts
```

The foray-audio list is printed BEFORE the Preferences pin is switched on, so
it is the list of the graph the app ships.

## 4. The cap sync line, and how the nested package resolves in the app

`cap add ios` is byte-identical before and after apart from its own timings
(`cap-add-ios.log`, both artifacts):

```
[info] All Capacitor plugins have a Package.swift file and will be included in Package.swift
[info] Writing Package.swift
[info] Found 6 Capacitor plugins for ios:
       foray-audio@0.1.0
       foray-tts@0.1.0
       @capacitor/app@8.1.1
       @capacitor/preferences@8.0.1
       @capacitor/splash-screen@8.0.2
       @capacitor/status-bar@8.0.3
```

The CLI finds `foray-audio` through npm's `file:` link
(`mobile/node_modules/foray-audio`), then writes CapApp-SPM's
`.package(path:)` at the plugin's real path. The resolution the app build used
(`spm-resolve.log`, after, run 35952197034):

```
Resolved source packages:
  ForayEngineCore: /Users/runner/work/foray/foray/mobile/plugins/foray-audio/foray-engine-core @ local
  ForayAudio: /Users/runner/work/foray/foray/mobile/plugins/foray-audio @ local
  CapacitorSplashScreen: /Users/runner/work/foray/foray/mobile/node_modules/@capacitor/splash-screen @ local
  CapacitorStatusBar: /Users/runner/work/foray/foray/mobile/node_modules/@capacitor/status-bar @ local
  ForayTts: /Users/runner/work/foray/foray/mobile/plugins/foray-tts @ local
  capacitor-swift-pm: https://github.com/ionic-team/capacitor-swift-pm.git @ 8.5.0
  CapacitorPreferences: /Users/runner/work/foray/foray/mobile/node_modules/@capacitor/preferences @ local
  CapApp-SPM: /Users/runner/work/foray/foray/mobile/ios/App/CapApp-SPM @ local
  onnxruntime: https://github.com/microsoft/onnxruntime-swift-package-manager @ 1.20.0
  CapacitorApp: /Users/runner/work/foray/foray/mobile/node_modules/@capacitor/app @ local
```

Before (run 35951455427) the list was the same nine entries without
`ForayEngineCore`. `CapacitorPreferences` is in both because the app ships the
Preferences plugin itself; NE-01's test-only pin adds nothing here.

Worth knowing for later cards: the app resolves `capacitor-swift-pm` at
**8.5.0** while the plugin packages alone resolve **8.5.2** in ios-kit. Both
satisfy `from: "8.0.0"`. Why the app lands on the older one is not
investigated here (not executed); a card that depends on a Capacitor API
newer than 8.5.0 should check the app's resolution, not ios-kit's.

## 5. The loop-time baseline (for the week-2 re-estimate)

Wall time of each macOS job this PR triggers, from GitHub's job timestamps.
Queue time is not included.

| Job | Before (`2baa8f8a`) | After (`c4cc751d`) |
|---|---|---|
| ios-kit (whole job) | 8 min 16 s (run 35951455396) | 8 min 14 s (run 35952197000) |
| · ForayKit `swift test` | 30 s | 43 s |
| · foray-engine-core `swift test` (new step) | — | 29 s |
| · foray-audio `xcodebuild test` (after adds `npm ci` in `mobile/`) | 1 min 34 s | 1 min 50 s |
| · foray-tts `xcodebuild test` | 1 min 22 s | 1 min 37 s |
| · `xcodebuild test -scheme Foray` | 4 min 38 s | 3 min 15 s |
| ios-build `ios-shell` (whole job, probes included) | 9 min 51 s (run 35951455427) | 8 min 33 s (run 35952197034) |
| · Simulator build | 1 min 3 s | 42 s |
| · device build | 41 s | 25 s |
| · probes (two passes) | 3 min 59 s | 4 min 19 s |

Read it as: **one Swift feedback loop is about 8-10 minutes of wall clock on
a macOS runner**, dominated by steps NE-01 did not add (the `ios/` scaffold's
`-scheme Foray` run in ios-kit, the probes in ios-build). The two jobs run in
parallel, so a push that triggers both answers in about 9-10 minutes. The
step NE-01 added costs about 30 s, and the `npm ci` in `mobile/` about 2 s
(105 packages, from the log's own timestamps). The
before/after differences in the unchanged steps are runner variance, not
anything this card did: the same steps moved in both directions by more than
the new ones cost.

The pre-existing red: on the very first run of this PR (run 35951040271,
`b843b233`), ios-kit was red on `testSessionMoveTable`, and it had been red on
`main` since #746 (`9730b5b8`). The assertion expected `.none` where the table
returns `.supersede` for a stale hold while playing, which is the row
`shell-invariants.test.mjs` pins and the build that shipped. Commit `2baa8f8a`
corrects the assertion; the plugin's code is unchanged.
Main fixed the same red the other way in audit round 2 (#749): the table
gained a `(.playing, .playing) -> .none` case (a position write is not a
resume). When main was merged into engine/m1 the two halves met and ios-kit
went red again, so the assertion is back to `.none`, main's reading.

## 6. Mutation checks

Every new Swift behaviour has a test that fails without it. Two were proved in
CI on throwaway draft PRs (closed, never merged), so the pins are known to
bite rather than assumed to:

| Mutation | Expected | Result |
|---|---|---|
| `SharedRowStore.preferencesKeyPrefix = "CapStorage."` (PR #753) | the host prefix and smoke tests fail; the Simulator prefix pin fails against the real Preferences class | **Killed.** ios-kit run 35952886266 (head `1fc836cd`): host `swift test` 6 tests / 4 failures (`testSmokeCasesAllPass`, `testSharedRowKeysCarryTheCapacitorStoragePrefix`, `testCasesDecodeInThePlanCaseFormat`, ...; the mutant set that step to `continue-on-error` so the Simulator step still ran); `xcodebuild test -scheme ForayAudio` 36 tests / 4 failures, 3 of them in `CapacitorStoragePrefixTests` against the real class, 1 in `EngineParityWrapperTests` |
| `FORAY_PREFERENCES_PIN` dropped from ios-kit, the runner requirement kept (PR #754) | the pin FAILS (not skips) because the module compiled out | **Killed.** ios-kit run 35952901363 (head `4f19ed34`): `CapacitorStoragePrefixTests` failed with "FORAY_REQUIRE_PREFERENCES_PIN=1 reached the test runner but the PreferencesPlugin module did not reach this target"; every other ForayAudio test passed |

The node-side pins in `tools/mobile/shell-invariants.test.mjs` were
mutation-checked locally: 14 single-line mutations (an `import AVFoundation` in
the core, `import XCTest` in the parity library, a dependency in the core
manifest, a second foray-audio product, the plugin target losing the core, a
rejecting / unregistered / `native` `engineHello`, the Preferences path moved
out of its gate, `ios-build.yml` setting the pin, `ci.yml` dropping the runtime
requirement, the XCTFail turned into a skip, the page configuring a Preferences
group, a second Preferences caller), all 14 killed.

## 7. NE-25a: in-point and out-point on click tracks (Measured, 2026-09-24)

**CI-executed**, Simulator only: ios-kit, `xcodebuild test -scheme ForayAudio`,
iPhone 17 Pro Simulator, iOS 26.4.1. The numbers below come from **run
35967960596** (head `765abf5e`). Runs 35964966803 (`458bf447`), 35963652605
(`c7def6d5`) and 35962279894 (`c9705f78`) measured the same things with the
earlier methods described in §7.2 and are cited only where they agree or show
why a method changed. Every number is in that run's job summary (the test
appends its tables there) and in its log as `NE-25a |` table lines and one
`NE-25a-json` line per trial.

A Simulator is not a phone and a local file is not a CDN. **DV-5 repeats this
on real CDNs in M2.** Nothing here is a pass mark except the never-early rule.

### 7.1 The rig

- **Fixtures** (`tools/audio/make-click-tracks.py`, deterministic; checked
  without a decoder by `tools/audio/click-tracks.test.mjs`): a 1 ms click
  every second and a double click (50 ms apart) every ten.
  `click-cbr.mp3` (16 kHz mono, CBR 16 kbps, no header frame),
  `click-vbr-xing.mp3` and `click-vbr-notoc.mp3` (the same VBR audio frames,
  with and without a Xing TOC), all 90 s; `click.wav` (8 kHz u8 PCM, the
  control). 964 KB in all. **Deviation:** the WAV is 60 s, not 90 s, to stay
  under the card's 1 MB (a 90 s WAV alone is 720 KB).
- **Listening:** an `MTAudioProcessingTap` on the item's audio mix sees every
  buffer the player renders, with AVFoundation's `timeRange` label.
- **Loading** follows plan §4.3 step by step (`MeasuredDeck`): asset and
  tracks, both statuses `.readyToPlay`, a zero-tolerance seek, `preroll`
  only after readiness and at rate 0, then play. "Precise" is
  `AVURLAssetPreferPreciseDurationAndTimingKey = true`.
- **Out-point layers**, as §4.3 describes them: `forwardPlaybackEndTime = end`,
  a boundary observer at `end`, and the windowed watchdog (one timer at
  `(end - t)/rate - 1.5 s`, then a 250 ms poll). The first layer to fire
  stops playback. Out-point 55.005 s, playback from 4 s before it.

### 7.2 How a landing is read, and why the method changed twice

The tap's per-buffer labels **cannot be trusted to the millisecond**:

- Run 35962279894 read the landing from labels, with the reference taken by
  playing from zero. The sample-exact WAV came out 10.2 ms "late" at every
  in-point: its from-zero reference read 11.1 ms, but 0.9 ms after any seek.
- Run 35963652605 took the reference after a precise seek. The WAV's
  from-zero offset then read 6.4 ms, a double click's 50 ms gap read 45 ms,
  and one click's ringing read as two onsets 7.5 ms apart.
- Run 35964966803 counted frames inside a run, anchored at the run's first
  label. The landings snapped to 6-7 ms steps, and the worst label-vs-count
  drift was 11.5 ms (10.8 ms in the final run).

The final method uses **no label in any measured number**
(`ClickRuler.swift`; pinned by `ClickRulerTests` and `BufferTimelineTests`):

1. A seek starts a new run of contiguous buffers.
2. The frames counted from the run's first sample to the first double click
   (a whole ten seconds of content) place that sample in the file's decoded
   timeline.
3. The decoder delay is counted the same way from the stream's first sample
   when playing from zero: 66.0 ms for all three MP3s (LAME's encoder delay as
   Apple's decoder presents it, plus the lead-in in §7.4), and 27.9 ms for the
   WAV.

Labels only tell runs apart and pick the nearest ten-second mark, which
tolerates any error under 5 s.

### 7.3 In-point landing error

The landing error is the first sample the tap hears, minus the in-point, in ms.
Negative means the listener starts EARLY and hears audio from before the
in-point. After every seek `currentTime` equalled the request exactly (0.0 ms
in all 30 trials): AVFoundation reports the position it was asked for, whatever
it landed on.

| fixture | timing | 9.65 s | 19.65 s | 49.65 s | 79.65 s |
|---|---|---|---|---|---|
| click-cbr.mp3 | precise | 0.0 | -4.9 | 0.0 | 0.0 |
| click-cbr.mp3 | approximate | -4.9 | 0.0 | 0.0 | -4.9 |
| click-vbr-xing.mp3 | precise | 0.0 | -4.9 | -7.2 (a) | 0.0 |
| click-vbr-xing.mp3 | approximate | 0.0 | 0.0 | **-220.9** | **+36.0** |
| click-vbr-notoc.mp3 | precise | 0.0 | 0.0 | -7.2 (a) | 0.0 |
| click-vbr-notoc.mp3 | approximate | 0.0 | 0.0 | **-396.0** | **-576.0** |
| click.wav | precise | 0.0 | 0.0 | 0.0 | (60 s file) |
| click.wav | approximate | 0.0 | 0.0 | 0.0 | (60 s file) |

- **Approximate seeks into VBR are wrong by hundreds of milliseconds, and
  AVFoundation cannot tell.** Without a TOC the landing drifts EARLY with
  depth into the file (-396 ms at 49.65 s, -576 ms at 79.65 s). A Xing TOC
  helps but does not fix it (-221 ms, +36 ms).
- The approximate numbers repeat across runs to within about 8 ms:
  - no TOC: -399.2 / -404.4 / -396.0 ms at 49.65 s;
  - Xing: -217.4 / -215.9 / -216.0 / -220.9 ms.

  So they are properties of the files, not noise.
- **Precise seeks, CBR and the WAV land within 0 to -4.9 ms** of where playing
  from zero puts the same content. The -4.9 ms rows are a run starting 78
  samples earlier, which is visible in the counted offsets (0.4209 s vs
  0.4160 s to the double click). A precise seek never landed late.
- (a) **After a precise seek to 49.65 s, both VBR files decoded the double
  click at 50 s weak and displaced** (peak 0.28 against 0.81, +7.3 ms). The
  same thing happened in runs 35963652605 and 35964966803. The -7.2 ms
  reading comes from that damaged click: the ruler residual (7.3 ms) flags
  it, and the next click sits on the whole second. The two VBR files share
  their audio frames, so this is the frames, not the TOC. It is a decode
  artefact about 0.4 s after a VBR seek. NE-32 should not treat it as
  landing error, and DV-5 should listen for it.
- The implication for the plan: this **confirms P-7's provisional rule
  (precise timing for bounded segments)**. It is also the evidence for
  ADR-0007's "approximate means skip": an approximate VBR landing can put a
  listener more than half a second into the previous segment's audio.

**Time to ready.** This covers asset + readiness + seek + preroll, local files.

- Final run: 30-110 ms in 27 of 30 trials, with no visible precise-vs-
  approximate difference at this file size.
- The first two loads of the run took 1.0 s and 1.7 s (the process's first
  AVPlayer), and one took 294 ms. Isolated loads of 578 ms, 888 ms and 1.2 s
  appear in other runs.
- The 20 s provisional load deadline (P-13) is two orders of magnitude above
  anything measured locally; NE-38 sets it from the field.

### 7.4 What the tap cannot settle: a 23-35 ms lead-in

The first buffer of every run is labelled 23.2 ms (sometimes 34.8 ms) BEFORE
the in-point, and 22.9-23.2 ms before zero when playing from the start.
Playing from zero, there is no content before 0, so that lead-in is at least
partly render-pipeline priming. It is consistent with the `.timeDomain`
algorithm's look-ahead.

Whether any of it is AUDIBLE cannot be observed from here: the tap sits before
the time-pitch unit. The landing errors above measure seek against playback
from zero, so a constant lead-in cancels out of them.

**Open, not measured:** a `.varispeed` comparison would settle it on the
Simulator. DV-5 settles it on a phone.

### 7.5 Out-point overshoot

Figures are the player's `currentTime` when each layer fired, minus the
out-point, in ms. Every configuration ran once per fixture and rate (32
trials).

| layer (armed alone) | 1x (four fixtures) | 2x (four fixtures) |
|---|---|---|
| `forwardPlaybackEndTime` | 0.0, 0.0, 0.0, 0.0 | 0.0, 0.0, 0.0, 0.0 |
| boundary observer (fire / settled after `pause()`) | 0.1-0.4 / 0.8-2.4 | 0.2-0.6 / 1.6-2.9 |
| windowed watchdog (fire) | 14.1-49.5 | 61.3-236.4 |

- **Never early: green.** The assertion covered every layer's fire and every
  settled position, at 1x and 2x, with 1 ms of CMTime slack and stopPad 0. It
  was green in all four runs (128 trials).
- **No early stop was measured, so NE-32's stopPad stays 0.** The assertion
  (`InOutPointMeasurementTests.neverEarlyToleranceSec`) is pinned by
  `click-tracks.test.mjs`, so it cannot be widened in silence.
- **`forwardPlaybackEndTime` stops exactly at the out-point** (0.0 ms in all
  64 trials across the four runs that armed it). It is the layer to trust.
  Its `AVPlayerItemDidPlayToEndTime` notification, though, arrived 29.7-37.3
  ms (host clock) after the boundary observer fired, in every "all three"
  trial of the final run. **The boundary observer is the fastest signal**
  that the out-point was reached, 0.0-0.4 ms past it.
- **A boundary observer can fail to fire at all.** When
  `forwardPlaybackEndTime` stopped the player exactly on the boundary first
  (8 trials across runs 35962279894, 35963652605 and 35964966803), the
  observer never fired. The
  engine must not depend on it.
- **The watchdog's overshoot is its poll**, up to 250 ms of wall clock, which
  is up to 500 ms of media at 2x: measured up to 49.5 ms at 1x and 236.4 ms
  at 2x, and 227 ms in run 35962279894. It is a backstop for a layer that
  failed, not a stop. NE-32 could make it a one-shot timer at the computed
  end instead of a poll, but that is not measured here.
- The watchdog's one-shot delay was 2,500 ms at 1x and 500 ms at 2x (4 s of
  lead-in, `4/rate - 1.5`), so it was armed for real in every trial.
- 'Tap pulled-to' reached 360-822 ms past the out-point. It is where the
  render pipeline had PULLED audio (an upper bound, ahead of the speaker), not
  the overshoot: with `forwardPlaybackEndTime` the player stops at the
  boundary regardless.

### 7.6 The WebView out-point probe: same run not feasible

The card asks to run the WebView probe on the same file, in the same run,
"where feasible". **It was not feasible in this card.**

- The WebView probe runs inside the built app in `ios-build.yml`'s
  `ios-shell` job. This measurement runs in `ci.yml`'s ios-kit, a different
  workflow, so it can never share a run.
- Moving the probe to the click track would mean changing `ios-build.yml`
  and the probe installer. That belongs with NE-36, which owns the ios-build
  native probe phase.

For comparison only, from this PR's own ios-build run 35963652608 (`c7def6d5`),
on its generated tone:

- the JavaScript out-point stopped 0.006 s past `end_sec`;
- with the page VISIBLE, the backgrounded case read `inconclusive`.

### 7.7 Mutation checks

**Node (local, all killed):**

- `click-tracks.test.mjs`: 10 of 10. Covered: a changed fixture byte, a stray
  WAV sample, a click moved by one sample, a Xing TOC byte, the Xing frame
  count, resources on the plugin target, a raised stopPad, a raised tolerance,
  the early assertion deleted, and a hard-coded ruler.
- The audio-guard exemption in `fetch-audio.test.mjs`: 3 of 3. Covered: no
  hash check, a 200 MB cap, and exempting every file in the directory.

**Swift:** `ClickRulerTests` and `BufferTimelineTests` name their mutations
in their comments (`TO SEE IT FAIL`). They ran green in CI on every head. The
mutations were **not executed in CI**: no throwaway mutant PR was opened for
this card. The loop cost (about 15 minutes per push) went to the four
measurement runs instead.

## 8. NE-15: AVDeck, what the Simulator measured

Card NE-15 (PR #766, base `engine/m1`) added `Engine/AVDeck.swift`, one
`AVPlayer` behind the `DeckDriving` seam with a readiness-gated preroll, and
`AVDeckTests.swift` (14 Simulator tests on a bundled 20 s CBR MP3, 64 kbit/s
with no Xing tag, and a 20 s PCM WAV, 601 KB together). Every number below
is **CI-executed** by ios-kit's `xcodebuild test -scheme ForayAudio` step. No
device has run AVDeck, and nothing in the app calls it yet.

**The fixtures changed after these runs.** When NE-15 merged onto
`engine/m1` (2026-09-24), NE-25a's click tracks (§7.1) were already there,
and the repo's audio guards exempt exactly one descriptor-named, hash-checked
set under 1 MB (`tools/audio/click-tracks.mjs`). So `AVDeckTests` now play
NE-25a's `click-cbr.mp3` (90 s, CBR 16 kbit/s, no header frame) and
`click.wav` (60 s, 8 kHz u8 PCM), and NE-15's own two tracks and their
generator are gone. The numbers below were taken on the original 20 s tracks;
the post-merge ios-kit runs write the same lines to their job summaries under
"AVDeck (NE-15): Simulator measurements".

### 8.1 Landing and time to ready

The same three loads ran in every green run, starting at 7.3 s:

| Load | Landing error (`currentTime` after the zero-tolerance seek) | Time to ready, per run |
|---|---|---|
| CBR MP3, precise timing | +0.000 ms | 445, 222, 404 ms |
| CBR MP3, approximate timing | +0.000 ms | 891, 959, 401 ms |
| WAV, precise timing | +0.000 ms | 391, 428, 646 ms |

The runs are 35961598950 (`fdfc9b23`), 35962750658 (`e8587ea1`) and
35967059600 (`14694a77`). Each load was prerolled (`finished == true`) on its
first attempt, so the retry and ordinary-load fallback never ran.

**What the landing number is not.** `currentTime` reports the requested time,
not the audible one. A mutant that gave the gate seek infinite tolerance
(run 35963951606) also landed both fixtures on exactly 7.300 s, because CBR
and PCM seek exactly anyway. The audible landing, and the VBR fixtures where
tolerance matters, are NE-25a's measurement (`MTAudioProcessingTap`). The zero
tolerance is pinned statically in `shell-invariants.test.mjs`.

### 8.2 The cold first load is close to the 20 s deadline

Before any deck exists, the test class loads the WAV once and records how
long it takes (`DeckMeasurements.warmUpOnce`). Results by run: **19,599 ms**
(35962750658), 13,829 ms (35963951606), 6,825 ms (35967059600) and 1,464 ms
(35967120142). Later loads in the same run were typically ready in under 1 s. In the
first run, which had no warm-up, the first AVDeck test had not even loaded a
local WAV's duration after 15 s.

On the Simulator, a cold media stack can therefore take nearly the whole
provisional 20 s load deadline (P-13, `// MEASURE:`). **This is a Simulator
number, not the phone's.** It is the reason AVDeck's behaviour tests give the
deck a 40 s deadline (the 20 s production value keeps its own test).
NE-25a's rig (§7.3) saw its process's first loads at 1.0 s and 1.7 s, so the
cold cost varies by run as much as by rig; neither is a device number. NE-38
should look for the device equivalent: the first load after a cold launch
(DV-7a) in the `build launch=background` rows.

### 8.3 A false stop right after a play (fixed in this card)

The event trace of the green run 35962750658 showed a second
`pausedUncommanded` 13 ms after the first. It came right after the test's
re-play and just before `.playing`: AVPlayer still reported `rate == 0` after
the play command. Reported at once, that is a false "the system stopped us"
while audio is starting. It also cleared the deck's intent to play, so the
next real system pause would not have been reported. AVDeck now treats a stop
as a suspicion. It confirms the stop 0.25 s later (`pauseSettleSec`, inside
the core's 500 ms route-attribution window), and only if the player is still
stopped (rate 0 and `.paused`), it is not the end, and no play was commanded
in between. The rule itself is `AVDeck.isUncommandedPause`, a pure function
that NE-14s moves into `DeckPolicy`.

### 8.4 Mutation checks (Swift)

Each mutant ran on a throwaway draft PR (#769, #770, #771, closed unmerged).

| Mutation | Result |
|---|---|
| `play` allowed before `.ready` | **Killed** (`testNothingIsAudibleBeforeReady`), 35963951606 |
| `load` no longer pauses a playing deck first | **Killed** (`testALoadSilences…`), 35963951606 |
| a seek before `.ready` ignored | **Killed** (`testASeekBeforeReadyMovesTheStart`), 35963951606 |
| `load` neither detaches the old item nor guards `durationLoaded` on the generation | **Killed** (`testASupersededLoadIsSilent`: two durations), 35963951606 |
| the rate reset to 1 on every load | **Killed** (`testRateIsHeldAcrossThreeLoads`), 35963951606 |
| no load deadline | **Killed** (`testANeverReadyUrl…`), 35963951606 |
| uncommanded-pause detection off | **Killed** (`testAnExternalPause…`), 35963951606 |
| no session check before play | **Killed** (`testAPlayWithoutAnActiveSession…`), 35963951606 |
| `pause()` keeps the intent to play | **Killed** (`testAnExternalPause…`, the commanded-pause phase), 35965812640 |
| the gate skips its seek | **Killed** (`testOffsetLands…` and two more), 35965819905 |
| a stop reported at once, with no settle | **Killed** (`testAPlayInsideTheSettleWindowVoidsTheStop`), 35967120142 |
| the `reachedEnd`, `.paused` and end-slack branches of the rule | **Killed**, each by its own assertion in `testTheUncommandedPauseRule`, 35967120142 |
| the end-slack check (before the rule required `.paused`) | **Killed** (`testTheEndIsEnded…`), 35963951987 |
| no `.timeDomain` line | **Survived**: the Simulator's default is already `.timeDomain`. The line is pinned statically. |
| a tolerant gate seek | **Survived**: see "What the landing number is not" above. Pinned statically. |
| the settle removed (Simulator only), or the end's guards removed | **Survived** in run 35965798877: both are races whose order varies from run to run. This is why the pure-rule test and the deterministic settle test exist. |

The node-side pins (`shell-invariants.test.mjs`, three NE-15 tests) were
mutation-checked locally. There were 14 mutations: a second `preroll(`; the
item-status and rate guards before the preroll; skipping the seek; a tolerant seek;
the deadline at 30 s; no session check; `defaultRate` outside the iOS 16
branch; `play()` called from `setRate`; `actionAtItemEnd`; the pitch
algorithm; no DEBUG assert; and the job-summary hand-off and fixture
resources removed. All 14 were killed.

At the merge onto `engine/m1` the third of those tests was rewritten for
NE-25a's fixtures (AVDeckTests play `click-cbr.mp3` and `click.wav`, the one
exempt set, and report through `FORAY_MEASURE_SUMMARY`). Its 7 local
mutations were all killed: a test pointed at `click-vbr-notoc.mp3`; the
helper's subdirectory back to `Fixtures`; a second fixture set beside
`ClickTracks/`; `.copy("Fixtures")` whole; `DeckMeasurements` reading
`GITHUB_STEP_SUMMARY`; the ci.yml hand-off dropped; and a second hand-off
added.

## 9. engine-parity CI, ios-gate and release refusal (NE-06)

NE-06 landed G-1a (the Linux parity job) and the code half of G-1b (the
short-circuit, `ios-gate`, release refusal) in one PR (#772), because it
lands on `engine/m1`, and G-1a's week of green runs happens on that
branch's PRs well before `engine/m1` reaches `main`. **The other half of G-1b
is a founder action:** add `engine-parity` and `ios-gate` to `protect-main`'s
required checks, then record it in STATE.md. That is a branch-protection
setting, so no file in this repo can do it.

### The fast loop, measured

Every row is CI-executed, from GitHub's job timestamps.

| What | Run | Wall clock |
|---|---|---|
| `engine-parity`, full parity run (head `3e3d5a6b`) | 35966876624 | **59 s**: 36 s pulling `swift:5.10` (Swift 5.10.1), about 8 s to build and run 70 XCTests, the rest checkout and setup-node |
| `engine-parity`, short-circuited (content-only probe #774, head `15990b34`) | 35968721212 | 29 s, nearly all of it the image pull |
| `ios-gate`, no Swift path changed (same probe) | 35968721212 | **15 s**, and it never read ios-kit |
| `ios-gate`, Swift path changed (head `3e3d5a6b`) | 35966876624 | 18 min 37 s: it waited for ios-kit, which spent 4 min 46 s in the macOS queue and 13 min 46 s running |

So a Swift author's loop is now about **one minute on Linux** against 15 to
30 minutes for ios-kit with its queue. The macOS queue is also the variable
part: with four ios-kit runs in flight, the red probe's ios-kit waited
28 minutes to start.

**The image is not cached.** The plan says "image cached", but GitHub
pulls a job `container:` before the first step runs, so no `actions/cache`
step can reach it. The 36 s pull above is the cost, and it is paid even when
the job short-circuits.

The first Linux run printed every family, including `continuation`, which
NE-13 had just recorded as JS only:
`compare 37/37 passed, seam-gap 30/30 passed, continuation 48 js-only, and
queue-state, rate, resume-rules, rows, number-format, transport and
media-episode all owed by their port cards`. That is the same result as the
macOS host run, so Linux Foundation raised nothing in the current core.

### Acceptance, CI-executed

| Criterion | Evidence |
|---|---|
| G-1a: engine-parity green on the PR, with the family table | run 35966876624 (head `3e3d5a6b`); the summary step writes the table from `parity-report.json` |
| A pr-hygiene round trip reports engine-parity on the new head | `gh workflow run ci.yml --ref engine/ne-06`, the same dispatch pr-hygiene makes: run 35968735311 (head `2ad29ab5`), where engine-paths diffed against `main` (95 files, engine=true, swift=true) and engine-parity, ios-kit (now run on a Swift dispatch) and ios-gate were all green |
| A content-only PR short-circuits both | probe #774 (closed unmerged), run 35968721212: `1 changed file(s) on pull_request; engine=false swift=false`, and both gates green in under 30 s |
| A deliberately red ios-kit on a Swift PR keeps ios-gate red | probe #775 (closed unmerged; `SeamGap.defaultGapSec` 2.0 -> 1.5), run 35968727263: ios-kit failed in `swift test (foray-engine-core, macOS host)`, and ios-gate printed `FAIL: a Swift path changed and ios-kit ended 'failure'` |
| Release refuses a SHA with red parity (dry run) | `node tools/ci/engine-ci.mjs release-checks 66c3122a...` (the probe's head) exited 1 with `refusing to cut an iOS TestFlight ... engine-parity: failure (.../job/107533230225); ios-kit: queued`. The same command on `3e3d5a6b` exited 0: `engine-parity: success; ios-kit: success` |
| The engine-parity summary still prints when swift test fails | on probe #775 the table step and the artifact step ran after the failed test step; the log shows `seam-gap cases=30 executed=30 passed=27 failed=3` |
| Branch protection lists engine-parity and ios-gate | **not done: a founder action** (above) |

### Mutation checks (local, node)

`tools/ci/engine-ci.mjs` has 24 single-line mutations and every one is
killed by `engine-ci.test.mjs`. The first pass let two survive: the all-zero
`before` guard and the dispatch-on-main guard were both hidden by the fake
git throwing. The tests now answer the fetch and the diff, so only the guard
can return "unknown". There are 9 mutations of `ci.yml` (dropping
`workflow_dispatch`, the raw `RUN_PARITY` output, an unguarded swift test, a
dispatch skip on engine-parity, ios-kit's old skip, `ios-gate` needing
ios-kit, `fetch-depth: 1`, a dropped summary, and no container). There are
5 of `release.yml` and 2 of `ios-build.yml`, one of which moves the negation
above the pattern it narrows. All are killed by the workflow suites.

## 10. NE-25b: two-deck preroll and readiness timing (Measured, 2026-09-24)

**CI-executed**, Simulator only: ios-kit, `xcodebuild test -scheme ForayAudio`,
iPhone 17 Pro Simulator, iOS 26.4.1. The tables below come from **run
35988169841** (head `1e5dd14a`). **Run 35989547345** (head `55015225`) repeated
everything, and its figures are quoted wherever they differ. Both runs'
job summaries carry the three "NE-25b:" tables, and their logs carry them as
`NE-25b |` table lines plus one `NE-25b-json` line per trial. `TwoDeckPrerollTests.swift` (PR #784) is the
rig. NE-32 (DeckPair) reads this section.

**Both decks are the production `AVDeck`**, not a test rig. The readiness gate
being measured is `AVDeck.prerollWhenReady`, the only `preroll(` in the plugins
and the core, and the test file issues none of its own (pinned in
`shell-invariants.test.mjs`). The gate evidence is the primitive the deck
records from `player.status`, `item.status` and `player.rate` on the line
before the call. The same pin checks that this record is a live reading, not
a literal.

A Simulator is not a phone and a local file is not a CDN. **DV-4 and DV-5
repeat this on a phone and on real CDNs in M2.**

### 10.1 The standby's time to ready, alone and while the other deck is audible

Deck B loads each click track at 19.65 s with precise timing and runs the full
gate: duration, both statuses `.readyToPlay`, a zero-tolerance seek, then a
preroll while the player is at rate 0. B runs once with nothing sounding and
once while deck A plays `click-cbr.mp3` at 1x, three reps each. Then the swap:
A's pause and B's play are sent in the same main turn, and the time is B's
play command to its `.playing`.

| fixture | alone: time to ready, ms | while A is audible, ms | swap alone: play to `.playing`, ms | swap after A's pause, ms |
|---|---|---|---|---|
| click-cbr.mp3 | 91, 77, 63 | 29, 48, 22 | 16.1, 15.1, 17.6 | 43.6, 47.1, 49.0 |
| click-vbr-xing.mp3 | 81, 71, 91 | 36, 46, 29 | 13.7, 13.1, 13.6 | 43.0, 44.4, 41.5 |
| click-vbr-notoc.mp3 | 70, 55, 67 | 31, 35, 27 | 11.7, 15.4, 18.9 | 43.8, 45.5, 38.1 |
| click.wav | 61, 58, 61 | 11, 21, 43 | 13.4, 16.9, 9.3 | 42.4, 49.1, 50.1 |

- **Preparing the standby did not disturb the audible deck** in any of the 12
  trials. A reported no stall, wait, pause or failure, and was still
  `.playing` when B became ready. This is asserted.
- **Preroll was never issued before `.readyToPlay`.** Every preroll, 24 of 24,
  read `player=1 item=1 rate=0.0`, and each came directly after the gate's
  zero-tolerance seek. Every load was prerolled on its first attempt: no
  preroll finished `false` without a forced seek. B stayed at rate 0 until
  its own play. All of this is asserted.
- **Loads were faster with a deck sounding:** median 31 ms against 70 ms
  alone (the repeat run: 34 ms against 69 ms). This is a measurement, not a rule. A plausible reading is that the
  render pipeline is already running while A plays. The effect is small and
  goes the helpful way for NE-32, which always prepares while something is
  audible.
- **The swap costs tens of milliseconds, not seconds.** B reaches `.playing`
  38-50 ms after its play when A pauses in the same turn, and 9-19 ms with
  nothing to pause (the repeat run: 43-58 ms and 11-23 ms). NE-32 plays B only after A confirms `.paused` (plan §4.3),
  so its gap is A's pause confirmation plus the 9-19 ms. Either figure is
  small next to the 2.0 s + 250 ms seam budget in NE-32's acceptance.

### 10.2 The gate against a held source

A resource loader on a custom scheme accepted every request and answered none
for 1.5 s, then served `click-cbr.mp3`, while A played. This stands in for a
standby on a slow CDN, which NE-32 meets at every seam.

| hold | loader requests in the hold | prerolls in the hold | item `.readyToPlay` in the hold (133 samples, 10 ms apart) | release to ready | time to ready | prerolls after |
|---|---|---|---|---|---|---|
| 1,500 ms | 1 | **0** | no | 19.7 ms | 1,531 ms | 1: `preroll player=1 item=1 rate=0.0` |
| repeat run | 1 | **0** | no (130 samples) | 23.2 ms | 1,538 ms | the same |

The gate waited for the source. Once bytes flowed, the whole pipeline
(duration, both statuses, seek, preroll) took under 20 ms, and it issued
exactly one preroll with no `not-ready`. A was undisturbed. All of this is
asserted.

### 10.3 `preroll` finished=false under a forced seek

While B's preroll ran, the test seeked B's own `AVPlayer` to 22.65 s,
bypassing the deck, 0-25 ms after its poll (about 0.5 ms) saw the preroll
issued. Four trials ran per cell, with A audible throughout. Each cell
reads "finished=false count, run 35988169841 / run 35989547345".

| fixture | seek 0 ms after | 2 ms | 5 ms | 10 ms | 25 ms |
|---|---|---|---|---|---|
| click-cbr.mp3 | **4/4 / 3/4** (+1 raced) | 0/4 / 0/4 | 0/4 / 0/4 | 0/4 / 0/4 | 0/4 / 0/4 |
| click-vbr-xing.mp3 | **4/4 / 4/4** | **4/4 / 4/4** | 0/4 / 1/4 | 0/4 / 0/4 | 0/4 / 1/4 |

- **Every finished=false recovered on AVDeck's single retry:** 12 of 40 in
  the first run and 13 of 40 in the repeat. The retry seeks back to the start
  and prerolls again. Every one ended `prerolled=true` at the requested
  start, ready 23-86 ms after the load. The ordinary-load fallback was never
  needed, and no load missed `.ready`.
- **Preroll timing.** A local preroll usually completes within about 2 ms for
  CBR and 2-5 ms for this VBR file. Once, it ran past 25 ms. A seek arriving
  after that found the deck already ready (the rows where no preroll was
  interrupted).
- **One race was measured, and it misreports the landing.** In the repeat
  run, one CBR trial at 0 ms fell into the gap between a preroll completing
  (`finished == true`) and that completion reaching main. The forced seek had
  already gone out, so AVDeck reported `.ready(prerolled: true)` with
  `landedSec` = **22.65 s, 3,000 ms from the requested 19.65 s**. AVPlayer
  reports a pending seek's time as `currentTime`, and the deck took it as its
  own landing. The deck did not notice: the gate held, but the player was no
  longer where the gate put it.
- **The retry path is exercised on every run.** The test fails if no preroll
  was interrupted, so "every load recovered" can never be published having
  tested no recovery.
- **For NE-32:**
  - In production, nothing seeks the standby's player behind the deck. A
    `.seek` before `.ready` only moves the target (NE-15), so a real
    finished=false needs a system time change or an incompatible rate change.
    **DeckPair must never touch a deck's `AVPlayer` directly.** The race
    above shows that a foreign seek can leave the deck `.ready` at the wrong
    place with no event to say so.
  - If NE-32 wants a belt-and-braces check, compare `landedSec` with the
    target at `.ready` and treat a mismatch as `not-ready`. This is not
    implemented here: a spike measures and does not change the deck.
  - On a CDN the preroll window is much longer than 2 ms, so DV-4 should look
    for `not-ready` causes in the seam rows.

### 10.4 Mutation checks

**Node (local, all killed):** the `shell-invariants` pin failed on 7 of 7
mutations:

- a `preroll(` in the test file;
- AVDeck recording the literal `preroll player=1 item=1 rate=0.0`;
- `gatePrimitive` at rate 1.0;
- an untagged json line;
- a fixture outside the exempt set;
- the forced seek no longer on the player;
- the no-interrupted-preroll guard weakened to `>= 0`.

**Swift (throwaway draft PRs #786, #787, #788, closed unmerged):** each
mutant changed `AVDeck.swift` alone.

| Mutation | Result |
|---|---|
| `prerollCompleted` ignores `finished` | **Killed** (`testPrerollFinishedFalseUnderAForcedSeek`: no preroll-unfinished was ever reported, so the vacuity guard fired), run 35989598006 |
| `advanceIfReady` proceeds on the duration alone (no status checks) | **Killed** by all three NE-25b tests. `prerollWhenReady`'s re-check then reports `not-ready-to-play`, which `assertGateHeld` refuses. On the held source the load never prerolled at all. Run 35989602152 |
| `notReady` skips the retry and goes straight to the ordinary load | **Killed** (`testPrerollFinishedFalseUnderAForcedSeek`: `prerolled=false` after one not-ready, in all 8 trials at 0 ms), run 35989605855 |

**NE-15's `AVDeckTests` stayed green against all three mutants** (14 of 14 in
each run). The retry and the runtime status gate were pinned only statically
(`shell-invariants`) until this card. NE-25b's tests are the first to
execute them.

## 11. NE-25c: speech, then a deck (Simulator smoke, 2026-09-24), and the DV-9 probe

**Simulator smoke. Not evidence.** DV-9 asks whether the session an
`AVSpeechSynthesizer` on the application session (`usesApplicationAudioSession
= true`) leaves behind after `didFinish` still lets a deck play **on a locked
phone, in the background**. A Simulator has no lock, no background, no car and
no other app, and its session is the Mac's audio. This section records only
that the obvious failure is absent on the rig. **DV-9 is answered by the
Developer session probe on the phone, in the NE-27 desk pre-flight**, and
NE-33 chooses SpeechNarrator's path from that row, not from this one.

### 11.1 The smoke

**CI-executed:** ios-kit, `xcodebuild test -scheme ForayAudio`, iPhone 17 Pro
Simulator, iOS 26.4.1, **run 36062420799** (head `4baa88d6`) and **run
36064494379** (head `5d6d203a`, the same smoke code). The rig is
`SpeechSessionSmokeTests.testADeckStartedInTheSameTurnAsDidFinishPlaysWithinOneSecond`
(PR #805). It uses the production pieces:

- `AudioSessionOwner` (`.playback` / `.spokenAudio`), activated;
- `PreviewSpeaker`, the engine's one synthesizer configuration
  (`usesApplicationAudioSession = true`, Apple's 1x rate);
- the production `AVDeck` on `click-cbr.mp3`, loaded and paused at 5 s before
  the line.

The test speaks "Session probe." and sends the deck's `play` from inside the
`didFinish` callback. It then waits for the deck's own `.playing`.

| run | activateMs | line start to `didFinish`, ms | `didFinish` on main | play to `.playing`, ms | interruptions | before the line | at `didFinish` | at `.playing` |
|---|---|---|---|---|---|---|---|---|
| 36062420799 | 1.6 | 2,302.3 | yes (same turn) | **17.2** | **0** | other=n hint=n | other=n hint=n | other=n hint=n |
| 36064494379 | 40.8 | 10,993.1 | yes (same turn) | **27.5** | **0** | other=n hint=n | other=n hint=n | other=n hint=n |

`other` is `isOtherAudioPlaying` and `hint` is
`secondaryAudioShouldBeSilencedHint`. iOS has no public "is my session active"
getter, so these readings and the deck's `timeControlStatus` are the
observable proxy. The Simulator had 68 voices installed.

- **Green in both runs.** `.playing` came 17.2 ms and 27.5 ms after the
  play, inside the card's 1 s bound. No interruption notification arrived during the line, the play or
  the 0.5 s after. Neither the deck nor the speaker found the owner's session
  inactive: there was no `fault implicit-activation` row.
- **The line's own time varies by 5x on the rig** (2.3 s and 11.0 s for the
  same two words). The second run's Simulator was slower throughout (its
  activation took 40.8 ms against 1.6 ms). The likely cost is loading the voice
  for the first utterance. The probe waits up to 30 s for `didFinish`, and the
  phone's row carries `speechMs`.
- **The synthesizer's delegate ran on main.** So the play really was in the
  same main turn as `didFinish`. `PreviewSpeaker` hops to main (and writes
  `speaker <end> thread=bg`) if a device ever delivers it elsewhere.
- **The deck did not sound during the line.** This is asserted: the deck's
  rate stayed 0 until the play.
- What the smoke cannot show: whether iOS **deactivates or yields** the
  session around a synthesizer in the background, with the screen locked,
  with another app's audio waiting. That is the probe's job.

### 11.2 The probe (for the NE-27 desk pre-flight)

`Engine/SessionProbe.swift`, driven by `engineSend probeSession` (the page's
Developer row lands with NE-20/NE-22). The run:

1. The founder pauses an episode and taps the probe. The probe checks that an
   episode is loaded and paused, then writes `probe kind=armed held= session=
   hold=`.
2. The founder locks the phone within 10 s.
3. The probe speaks "Session probe." through the core's audition path. The
   core activates first only if its session is not active, for example under
   "Pause hold: none".
4. In the same main call as `didFinish`, the probe sends an ordinary `play`.
   The core activates only if it must, and opens BackgroundGrace because the
   phone is locked.
5. On the deck's own `.playing` (or a refusal, or 5 s), the probe writes the
   DV-9 row, then pauses the play it started.

The row: `probe kind=speech-then-play result=ok|failed token= activated=
activateMs= timeToPlayingMs= speechMs= grace= held= session=`.

| The row says | Reading for NE-33 |
|---|---|
| `result=ok activated=false held=true` | The play started, locked, with no activation by the engine. SpeechNarrator path A: `AVSpeechSynthesizer` on the application session. Whether iOS re-activated the session implicitly underneath cannot be observed (no public getter), but a deck that reaches `.playing` in the background is the practical answer DV-9 needs. |
| `result=ok activated=true` | The core had to activate again after the line. The session was taken (usually a `session kind=interruption` row sits between the two) but came back. Inconclusive for path A: re-run held, and read the interruption rows. |
| `result=failed token=session-failed:<t>` | The play after the line could not get the session back. Path B: `write(_:toBufferCallback:)` into the engine's own output. |
| `result=failed token=no-playing` | The play was accepted, but the deck never confirmed `.playing` within 5 s: the session looked active but did not render. Path B. |
| `token=speech-cancelled` or `speech-timeout` | The line itself did not finish (an interruption took it, or the synthesizer stalled). Inconclusive: re-run. |
| `held=false` | "Pause hold" was not `forever` when armed, so the run did not ask DV-9's question. Re-run with the default hold. |

`backgroundTimeRemaining` is not measured here: package tests have no host
app. The locked run's `grace` rows (NE-16g) carry it from the device.

### 11.3 Mutation checks

**Node (local, all killed):** the NE-25c `shell-invariants` pin failed on 11
of 11 mutations:

- `import AVFoundation` in SessionProbe;
- the probe sending the deck a play directly;
- the probe pausing on every finish;
- teardown not cancelling the probe;
- teardown not clearing `Speaking.onFinish`;
- dropping `usesApplicationAudioSession = true`;
- the implicit-activation guard switched off;
- a second `AVSpeechSynthesizer()` in foray-audio (in AVDeck);
- the smoke's tag changed;
- a second `SessionProbe(` builder;
- a narration rate other than Apple's default.

**Swift:** MUTATION_RESULTS_PENDING
