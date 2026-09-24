# iOS native engine: measurements

The running record of what CI has measured for the native iOS playback
engine (`docs/native-engine-plan.md`). The plan's rule applies to every line
here: no `swift` or `xcodebuild` runs on the Windows machine this repo is
written on, so every Swift claim is either **CI-executed** (with the job, the
run and the head SHA) or marked **not executed**. An estimate is labelled as
one and is never quoted as a measurement.

Cards append their own section. NE-01 (the packaging spike) wrote §1-§6.

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
