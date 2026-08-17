# Building iOS without a Mac — and the four things the runner settles

Issue **#38** (MP4), part of **#34**. Stacks on **#209** (#36's `mobile/`
scaffold) and reads on from `docs/mobile-shell.md` and
`docs/research/mp1-background-audio.md` (#207).

The workflow is `.github/workflows/ios-build.yml`. Its own header carries the
operational detail; this file is the argument.

## 0. Why a CI runner is worth more here than a build

Nobody on this project has a Mac. That is not a gap in the tooling, it is the
shape of the team — and it has left four separate claims sitting unverified,
each of them blocking a decision:

| Claim | Where it lives | Status before #38 |
|---|---|---|
| The Capacitor shell compiles at all | `docs/mobile-shell.md` §0 | **Never generated, never installed, never compiled.** Its author said so in a table |
| Our CSP does not block Capacitor's injected bridge *on iOS* | `docs/mobile-shell.md` §5 | Reasoned from WKWebView's `WKUserScript` injection. `HUMAN-ACTIONS.md` #14 step 6.2 asks a human to type `Capacitor` into a console |
| Our out-point still fires when the app is backgrounded | `docs/research/mp1-background-audio.md` §8 | "**The single most load-bearing untested claim** in this document" — its words. **SETTLED, run 32026332637: it holds.** See §4b |
| A Foray's 31 seam **transitions** survive backgrounding — the 2.0 s beat's `setTimeout`, then a fresh cross-episode load | `docs/research/mp1-background-audio.md` §8, last paragraph | Named as a risk and left unmeasured. The out-point result does **not** cover it: different mechanism, and the beat runs on the clock the same run measured at 1 s alignment. Probe C (§3) |

Be precise about the second one, because the sloppy version overclaims: §5's
heading is *"the top open risk: **Android's** injected bridge versus this CSP"*,
and its iOS line is "iOS is probably fine". So this workflow does not settle that
risk. It settles the *iOS assumption that sits beside it* — the one #14 step 6.2
calls "the single most important line of output in this whole item" — and Android
stays exactly where it was (`HUMAN-ACTIONS.md` #16).

GitHub's macOS runners have Xcode **and the iOS Simulator**. So the third
column can change without anyone buying a laptop.

## 1. What the workflow does, in order

1. `npm install` in `mobile/`, then **`npm run add:ios`** — the committed script,
   used rather than re-spelling `cap add ios`, so the workflow cannot drift from
   what `HUMAN-ACTIONS.md` #14 tells a human on a Mac to run.
2. Work out whether to build a **workspace or a project** (§5: Capacitor 8 is
   SwiftPM and generates no workspace), and assert Capacitor did **not** generate
   into the repo's `ios/`. #209 pins the second through config; here it is checked
   against a directory that actually exists.
3. **Inject `UIBackgroundModes: audio`** into the generated `Info.plist` with
   `tools/mobile/inject-background-audio.mjs`. MP1 §7.3: this is the *entire* iOS
   background-audio requirement — WebKit sets the `AVAudioSession` category
   itself, so no plugin, no `AppDelegate` edit, no Swift.
4. **Build for the simulator, unsigned.** Then **build for a real device's
   architecture, unsigned** — arm64/Release, the configuration a TestFlight build
   would use. Two different compiles; the second is the one that would catch a
   Release-only or arch-specific failure.
5. Boot a simulator, install a **probed copy** of the built app, and run the
   measurements in **two passes** (§3): the bridge + out-point probes, then a
   reinstall with `--phase seam` and the seam-transition probe. One container read
   at the end collects both, with the app never foregrounded in between.
6. Report every verdict to the job summary, and upload logs, screenshots and the
   raw probe records as an artifact.
7. **Gated on secrets that do not exist:** archive, export, upload to TestFlight.

## 2. Three design decisions worth defending

### The build is unsigned, and that is the point

Signing needs an Apple Developer account, a distribution certificate, a
provisioning profile and an App Store Connect API key. None exist
(`HUMAN-ACTIONS.md` #17). A workflow that needed them would be a workflow that
has never run — so the build is unsigned and always runs, and the upload is
gated behind them.

The gate has **three** outcomes, not two:

| Secrets | Behaviour |
|---|---|
| all 7 present | archive, export, upload |
| none present | skip the upload, loudly. **Not a failure** — this is today |
| *some* present | **fail the job** |

The third is the one that earns its keep. Six of seven secrets set means a green
run, no build on TestFlight, and nobody finding out until a release is expected.
The rule is in `signingReadiness()` in `tools/mobile/ios-ci.mjs` with a test per
outcome, because a three-way rule cannot be written as `if: secrets.X != ''`.

### It is not a required check, and it is designed for infrequency

macOS runners bill at **10× Linux minutes**. This repo is **public**, and GitHub
charges nothing for standard runners on public repos — which is also why
`ci.yml`'s `ios-kit` job can run `macos-latest` on every PR today. Both facts are
recorded because the second one changes the day the repo stops being public. A
sister project already suspected Actions-minutes exhaustion behind a build freeze,
and "it was free when we wrote it" is not a design.

**Measured, 2026-08-17.** A full green run of the SINGLE-PASS version — both
builds, the simulator boot, the bridge and out-point probes, the report and the
artifact upload — took **8 min 19 s** of wall clock (run 32023924627,
`11:13:42Z` → `11:22:01Z`). So ~8-9 minutes, not the 12-18 first estimated, which
would be **~85 billable minutes** at the 10x multiplier if this repo were ever
private. The estimate is left in the workflow header alongside the measurement
rather than quietly replaced, because the gap between the two is the point this
document keeps making.

**Estimated, not yet measured:** probe C adds a second pass — a reinstall, a
relaunch, and a 15 s + 90 s window — for about **95 s more**, so ~10 minutes and
~100 billable minutes. Labelled as an estimate on purpose; the run linked from the
PR that added it is the measurement, and this line should be replaced with that
number rather than left to be quoted as one.

So: `workflow_dispatch` plus a path filter narrow enough that nightly content
PRs never trigger it (`mobile/`, `tools/mobile/`, `index.html`, `app.js`,
`player/`, and the workflow file itself). `concurrency` with
`cancel-in-progress`. No `push`, no `schedule`. And **not** in the `protect-main`
required set — `backend` and `data-and-site` stay the gates, because putting a
15-minute macOS build in front of every content PR would be a worse product than
a slightly less verified iOS shell.

`tools/mobile/ios-workflow.test.mjs` holds each of those properties, including
that no job in this workflow is *named* `backend` or `data-and-site` — required
checks match by name, across workflows.

### `ios/` is untouched

`ios/ForayKit` is the only Swift this repo's CI compiles, and it holds
`IntentGrammar.swift`, which has no JavaScript equivalent anywhere. `ci.yml` is
not edited by #38 and `ios-kit` runs exactly as before. The shell generates into
`mobile/ios/`; the workflow asserts the two never collide.

## 3. The three measurements, and what they are worth

### Probe A — `window.Capacitor`, on the real page, under the real CSP

`tools/mobile/probe/probe-bridge.js` is added to the built app's `index.html` as
an **external** `<script>`. That is not a style choice: the question being asked
is what `script-src 'self'` does to Capacitor's *inline* bridge injection, so a
probe that itself needed `'unsafe-inline'` would be blocked by the rule under
test and would report nothing — indistinguishable from "the bridge is fine".

It records `typeof window.Capacitor`, `isNativePlatform()`, the plugin list, any
`securitypolicyviolation` events, and — the consequence rather than the cause —
`navigator.serviceWorker.getRegistrations().length`, which must be **0** inside
the shell whatever the bridge did.

**Scope discipline.** A pass establishes one thing: on iOS, `script-src 'self'`
does not block Capacitor's bridge injection. That is what `docs/mobile-shell.md`
§5 *reasoned* and nobody had run. It says nothing about Android, which injects an
inline `<script>` into the served HTML from a `https://localhost` origin — a
different mechanism, and the one §5's risk is actually about. That is
`HUMAN-ACTIONS.md` #16 and it stays open. `bridgeVerdict()` carries both halves of
that sentence in its own output so the claim cannot creep in a retelling.

**And a `bridge-blocked` result does not automatically mean the CSP.** On iOS the
CSP is the *least* likely explanation, so the verdict names it as the cause only
when a `script-src` violation was actually observed; otherwise it says the cause is
unknown and points at `cap-add-ios.log` and `csp-messages.txt`. A harness failure
promoted to an architectural finding is how a wrong claim gets into a document.

### Probe B — the out-point, backgrounded

`probe-outpoint.js` imports the **real** `player/html-audio-backend.js`, points
it at a generated 150-second tone, arms `setOutPoint(25)`, and records how far
past 25 s playback got. The workflow backgrounds the app by foregrounding
Settings — `simctl` has no "press home" — waits 50 s, and reads the numbers out
of WebKit's local-storage database in the app container.

Five things come back, and each answers a different question.

| | What it settles |
|---|---|
| `stoppedWhileBackgrounded` | **The one that decides the architecture.** `false` means nothing stopped the audio until the app was foregrounded — MP1 §3's failure whatever the overshoot reads (**936.5 s median: 15.6 minutes of the wrong episode**) |
| `endReason` | Whether the *out-point* stopped it, or the file simply ran out. `html-audio-backend.js` reports the same callback for both, deliberately; here they are opposite results |
| `overshootSec` | How late the boundary was. Foreground today is ~14 ms — *measured on desktop Chromium, n=3, MP1 §4.3*, not on a phone. MP1 §8 predicts 0.25–1 s backgrounded |
| median `timeupdate` interval while hidden | **The inference itself, measured.** ~250 ms means MP1 §8's load-bearing claim held; ~1000 ms means it did not and the aligned DOM timer covered for it. The overshoot alone cannot tell those apart, which is why this is reported separately |
| median 250 ms `setInterval` while hidden | MP1 §7.5's claim that WebKit aligns hidden-page DOM timers to 1 s — itself never verified, since WebKit's preference YAMLs had moved |

Two reporting channels, because the primary one is fragile. The probe writes to
`localStorage` and the workflow reads WebKit's database out of the app container
**by filename** — a filename WebKit has changed before. Both probes also
`console.log` their record, Capacitor's iOS bridge forwards console output to
`print()`, and that lands in the system log the workflow already captures. So a
renamed database does not silently produce a run that measured nothing. Note the
dependency honestly: the console channel works only if the bridge is alive, so it
can rescue an out-point run and can never rescue a `bridge-blocked` one.

**A SIMULATOR IS NOT A DEVICE.** It runs on the host's CPU under the host's power
policy and models neither true suspension nor RunningBoard's assertions. So a
**pass here is weaker evidence than a failure would be** — a failure would have
been decisive, a pass only removes one way of being wrong. That sentence is
`SIMULATOR_CAVEAT` in `tools/mobile/ios-ci.mjs`, shipped with every report, so it
cannot be dropped from one retelling and kept in another. `HUMAN-ACTIONS.md` #11
and #14 still want one real phone.

### Probe C — the seam transition, backgrounded

**Probe B's pass does not cover this, and that is the whole reason C exists.** B
settled the *stop*. A Foray is 32 segments joined by **31 transitions**, and each
transition is a different mechanism:

> stop at `end_sec` → wait a **2.0 s** beat (`player/seam-gap.js`, a `setTimeout`)
> → load a **different episode** → seek to its `start_sec` → play

Probe B's own numbers are the reason to doubt it. `timeupdate` kept its 252 ms rate
while hidden — that is a *media* event. The beat is a `setTimeout`, and the same
page measured hidden DOM timers at a **median of 1000 ms**. The load is worse
again: a fresh media fetch, `LOAD_SETTLE_TIMEOUT_MS` at 10 s, in a page that has
been *silent* since the boundary and may therefore have lost WebKit's audibility
assertion (`audibleActivityClearDelay`, 10 s). If that chain breaks, a listener with
a locked screen hears one segment and then **silence for the rest of the commute** —
a different defect from playing the wrong episode, and one no amount of out-point
accuracy fixes.

`probe-seam.js` drives the **real `PlayerQueueManager`** over the real
`HtmlAudioBackend`, with the manager's own `REAL_SCHEDULER` — no injected clock,
because the clock is the suspect. Three bounded segments over **two** audio files:

| | Why |
|---|---|
| Three segments, so **two** transitions | One transition can succeed inside the 10 s audibility grace and the next still fail once the page has been silent through a beat. `MIN_HIDDEN_TRANSITIONS` is 2, and a single success reports `too-few-transitions`, not a pass |
| **Two** files, alternating | `html-audio-backend.js` turns a same-URL load into a seek with no refetch — correct for consecutive segments of one episode, and the one path this must not take. A seek inside a buffered file would answer a much easier question |
| The first boundary armed on `visibilitychange` | Probe B's expensive lesson. A fixed `end_sec` raced `simctl launch com.apple.Preferences`, which returns before Settings is actually foregrounded (~39 s once), and produced two contradictory verdicts from identical code |
| `hiddenAtBoundary` **and** `hiddenAtNextPlaying` **and** the wall clock vs `resumedAtWall` | A transition that completed because the app came *back* proves nothing. Two independent channels have to agree: the page's own `document.hidden` readings, and wall-clock stamps the page cannot fake by blinking |
| `lastStage` on every pending transition | "The beat's timer never fired" and "the load never settled" are different bugs with different fixes. Every stage — `boundary`, `beat-armed`, `load-started`, `loadedmetadata`, `canplay`, `playing` — is stamped and flushed as it happens, so a stall leaves a record of **how far it got** |

`seamTransitionVerdict` reports the stall case **first and above everything else**,
including a completed transition sitting next to it, because the stall is the
finding that changes what gets built.

**Its limit, and it ships with every verdict** (`LOCAL_MEDIA_CAVEAT`): the next
segment is a **local bundled file**. Product principle #3 forbids reusing episode
audio — a CI job hammering a podcast CDN is exactly what that principle is about —
and the probe page's CSP is `media-src 'self'`. So this settles **the beat's timer
and a fresh media load while hidden**. It does *not* settle DNS + TLS + a range
request into someone's CDN while hidden, which is the other half of the risk MP1 §8
names. Saying so is the difference between an honest partial result and a claim the
run cannot support.

**Two passes, one step, ~95 s of extra runner time.** Probes B and C need the same
scarce resource — a window in which the app is backgrounded — and B spends its whole
window on one boundary. So the workflow measures B, reinstalls the same built `.app`
with `--phase seam`, and measures C. The app container survives the reinstall, so one
container read at the end collects both records; the localStorage keys are distinct.
**Nothing between the last backgrounding and that read foregrounds the app**, which
is the point: `simctl terminate` kills the outgoing app rather than raising it, and a
collection path that resumed the app could not tell a working transition from one
that only completed on resume. A test in `ios-workflow.test.mjs` asserts that no
`simctl launch` of our app id appears after the final backgrounding.

### Two ways the probes can lie, and what stops them

- **Reporting a pass from absent data.** Every verdict function has an explicit
  `inconclusive` outcome, and empty, missing or malformed input lands there
  rather than in the good bucket. Tested harder than the happy path, because this
  repo has shipped a conclusion drawn from a measurement that did not happen
  twice already (`corpus eval`'s mislabelled `Recall@5`; MP1's emulator run).
- **Mistaking a natural end for an out-point.** If the tone ran out first the
  backend would report `END_NATURAL` and the overshoot would look perfect. The tone
  is 150 s against a ~67 s window and a test pins that margin — but a margin is not
  a check, so `outPointVerdict` also refuses any `endReason` that is not
  `"outPoint"`.
- **Ranking away the decisive negative.** `simctl launch` on a running app can
  restart it, which writes a second, fresh record. The picker weights *having been
  backgrounded* above *having stopped*, so a tidy foreground run cannot outrank the
  backgrounded run in which the out-point never fired — which is the single most
  valuable result this workflow can produce.

## 4. What still needs a human

- **`HUMAN-ACTIONS.md` #17 (new):** an Apple Developer Program membership, a
  distribution certificate, a provisioning profile, an App Store Connect API key,
  and the seven repository secrets. Until then there is no TestFlight build, only
  an unsigned one.
- **#13:** rule on the permanent bundle id. It is baked into the generated
  project; changing it after a store release means a new listing.
- **#14 / #16:** still open. #14's *build* is now automated, but its device
  questions — icons visible, a Foray advancing with the phone locked, stale-content
  behaviour after an update — are device questions and a simulator cannot answer
  them. #16 is Android and this workflow says nothing about it.
- **#15:** whether the bundled-data freeze blocks a store submission.

## 4b. What the runs have actually measured

Run [32021861601](https://github.com/JW-Incorporated/foray/actions/runs/32021861601),
2026-08-17. Runner: **macOS 26.5.2, Xcode 26.6, CocoaPods 1.17.0**; simulator
**iPhone 17 / iOS 26.5**. Labelled the way
`docs/research/mp1-background-audio.md` §1 labels things, because the difference
between these rows is the whole point.

| Claim | Basis | Result |
|---|---|---|
| The shell compiles for the simulator | **Measured** | `** BUILD SUCCEEDED`. `App.app` 8.3 MB |
| The shell compiles for arm64 device, Release | **Measured** | `** BUILD SUCCEEDED`, unsigned |
| `UIBackgroundModes: audio` lands in the generated plist | **Measured**, by Apple's own reader | `PlistBuddy` prints `Array { audio }`; `plutil -lint` clean |
| Capacitor 8 iOS uses SwiftPM, no workspace | **Measured** | `-project mobile/ios/App/App.xcodeproj` |
| `window.Capacitor` survives our CSP on iOS | **Measured** | `typeof` = `object`, `isNativePlatform()` = `true`, `getPlatform()` = `"ios"`, origin `capacitor://localhost`, **9 plugins** registered, **0** CSP violations, **0** "Content Security Policy" lines in the system log |
| Hidden-page DOM timers are aligned to ~1 s | **Measured** | a 250 ms `setInterval` ran at **median 1000 ms, n=33, range 254–1003 ms** |
| `timeupdate` survives backgrounding | **Attempted, too thin to claim** | 243 and 246 ms — but **n=2**, see below |
| The out-point fires while backgrounded | **Attempted, NOT obtained** | fired 3.7 ms past the boundary with the page hidden — from a hidden window of **0.446 s**. Not a measurement of backgrounding |

Three of those deserve their own paragraph.

**MP1 §7.5 is now measured, and it was right.** That section inferred WebKit aligns
hidden-page DOM timers to 1 s from `DOMTimer.h`, and flagged that it could not
verify whether the preference defaults on in WKWebView. It does: a 250 ms
`setInterval` in the backgrounded shell ran at a median of exactly 1000 ms over 33
samples. So the out-point's **fine** stage genuinely loses its precision in the
background, exactly as predicted — which makes the coarse `timeupdate` stage the
thing that matters, which is the claim below.

**`navigator.serviceWorker` does not exist at all on `capacitor://localhost`.** Not
"registers nothing" — the API is absent (`hasServiceWorkerApi: false`). So on iOS
the "app won't update after a store release" bug is impossible by construction,
and `shouldRegisterServiceWorker`'s guard is belt-and-braces there rather than
load-bearing. It stays load-bearing on Android, whose shell origin is
`https://localhost`. This also means the run's `swRegistrations: 0` is *not*
evidence of invariant 3 holding, and `bridgeVerdict` says so instead of counting it.

**The backgrounding measurement did not happen, and the first version of this
workflow claimed it did.** That run reported `fires-in-background`, a 4 ms
overshoot and "MP1 §8's load-bearing inference HELD". Every sentence was true.
None of it was evidence: the page was **visible for 24.5 of the 25 s** and hidden
for the final **0.446 s**, with two hidden `timeupdate` samples, because `xcrun
simctl launch com.apple.Preferences` returns as soon as the launch is accepted and
Settings took ~10 s to actually reach the foreground on a cold-booted simulator.
The wall-clock timeline was a race and it lost.

**And the next run, on identical code, said something different — which is the
proof it was a race.** Run
[32023924627](https://github.com/JW-Incorporated/foray/actions/runs/32023924627)
reported `fired-on-resume`, the label for MP1 §8's *failure* mode, with an overshoot
of **0.003 s**. Those two cannot both be about a real failure: an out-point that had
genuinely stopped firing while backgrounded would overshoot by however long the app
stayed backgrounded, not by three milliseconds. It means the boundary was crossed
while the page was **visible**. Read at face value it is a harness artifact wearing
the label of an architectural failure — and #28 (a native audio backend) is a
decision somebody could reasonably make on it.

So `outPointVerdict` now refuses that combination: `stoppedWhileBackgrounded: false`
with a sub-tolerance overshoot is `inconclusive` with the reason spelled out, and
`fired-on-resume` is claimed only when the overshoot is actually large.

Three changes in total, because a race cannot be tightened into reliability:

1. **`outPointVerdict` rejects the incoherent combination** above, so a harness
   artifact cannot borrow the failure mode's label.
2. **The boundary is armed relative to going hidden**, not to wall clock:
   `setOutPoint(currentTime + 15)` on the first `visibilitychange` to hidden.
   However long backgrounding takes, the boundary is 15 s inside the hidden window.
3. **`outPointVerdict` has a floor.** Below `MIN_HIDDEN_PLAYBACK_SEC` (5 s) of
   observed hidden playback the verdict is `hidden-window-too-short`, not a pass.
   The 15 s arm clears it by 3x, so a run landing there means something went wrong
   and says so.

### The run that settled it

Run [32026332637](https://github.com/JW-Incorporated/foray/actions/runs/32026332637),
with those changes in place and `armedWhileHidden: true` — the designed path, not
the fallback:

| | |
|---|---|
| out-point fired | **4.5 ms** past the boundary (`end_sec` 45.460 → stopped 45.469) |
| while hidden? | **yes** — `stoppedWhileBackgrounded: true`, `endReason: "outPoint"` |
| hidden playback observed | **15.056 s**, three times the 5 s floor |
| `timeupdate` while hidden | **61 samples, median 252 ms, max 299 ms** |
| hidden-page DOM timer | median **1000 ms** over 25 samples (250 ms requested) |

Reproduced across runs: an earlier one (32025079276) got 4.9 ms over **6.44 s** of
hidden playback and 27 samples via the fallback arm. Same answer, thinner sample.

**So MP1 §8's most load-bearing inference held.** `timeupdate` is a media event
driven by WebCore's playback-progress timer, not a `DOMTimer`, and it kept firing
at ~4 Hz in a backgrounded WKWebView while the aligned DOM timer next to it was
throttled to 1 s — the two mechanisms measured side by side, in the same page, at
the same time. That is exactly the distinction §8 reasoned to and could not test,
and it is the difference between a 5 ms overshoot and MP1 §3's 936.5-second median
disaster.

**Read the caveats, both of them.**

1. **A Simulator is not a device**, so this is the weak direction of the evidence
   (§3). A failure here would have been decisive; a pass removes one way of being
   wrong. `HUMAN-ACTIONS.md` #11 and #14 step 6.4 are unchanged.
2. **Backgrounding is slow and variable on a cold-booted runner**, which is why the
   arm is relative to it rather than to a clock. `simctl launch
   com.apple.Preferences` returns immediately, but Settings has taken anywhere up to
   ~54 s to actually reach the foreground; one earlier run therefore armed via the
   40 s fallback (`armedWhileHidden: false`) and got a 6.44 s window instead of 15 s.
   If a run ever reports `hidden-window-too-short`, that is what happened, and the
   record says which path armed it.

**And retract the `fired-on-resume` reading of run 32023924627 wherever it is
quoted.** It was the same harness race, with a **3 ms** overshoot — the tell that it
was never a real failure. It is easy to re-quote because the label names MP1 §8's
predicted failure mode exactly, and *a native audio backend for iOS is a decision
somebody could reasonably have made on it*. One was started on that reading and
thrown away; `docs/research/mp1-background-audio.md` §0b carries the retraction.

**What this result does NOT settle is the TRANSITION**, and that is probe C's
question. The stop is a media event. The beat is a `setTimeout`, on the very clock
this run measured at 1000 ms alignment, with a fresh cross-episode load inside it.
Nothing above covers it.

### One thing that cost 18 minutes, recorded so nobody re-learns it

`xcrun simctl spawn <udid> log stream --level debug` with no predicate captured a
**117 MB** system log in ~70 seconds, and
`grep -a -i -o '.\{0,120\}Content Security Policy.\{0,200\}'` over it ran for
**18 minutes** — a counted-context pattern backtracks at every byte position. On a
60-minute job timeout that is a way to lose a run that had already produced the
answer, since a timed-out job skips its `always()` artifact upload. Now
predicate-filtered, capped at 20 MB, and read with whole-line greps.

Related, and honest: **the console log as a second channel is unproven.** The idea
is that Capacitor's `Console` plugin forwards `console.log` to `print()` and thence
to the system log. The plugin *is* registered — it is in the 9 — but
`probe-console.txt` came back **0 bytes**, so nothing was recovered that way. The
localStorage channel carried everything. Treat the console channel as a fallback
that has never fired.

## 5. If the first run fails

Expected, and cheap to read. The artifact `ios-shell-evidence` carries
`xcodebuild-simulator.log`, `xcodebuild-device.log`, `cap-add-ios.log`,
`toolchain.txt` (the OS, Xcode and CocoaPods versions — the first thing to check
when a runner image moves under you), the injected `Info.plist`, the simulator
system log, `container-tree.txt`, two screenshots (`01-playing.png`,
`02-backgrounded.png`) and the raw probe records.

### The first run already found one, and it is worth recording

**Capacitor 8's iOS template is Swift Package Manager. There is no
`.xcworkspace` and no CocoaPods.** Run
[32021466913](https://github.com/JW-Incorporated/foray/actions/runs/32021466913)
failed at "generate the iOS project" in 21 seconds, and the log is unambiguous:

```
✔ Adding native Xcode project in ios
[info] All Capacitor plugins have a Package.swift file and will be included in Package.swift
[info] Writing Package.swift
[info] Found 4 Capacitor plugins for ios: @capacitor/app@8.1.1, @capacitor/preferences@8.0.1,
       @capacitor/splash-screen@8.0.2, @capacitor/status-bar@8.0.3
[success] ios platform added!
```

No `pod install`, no workspace. The first draft of this workflow hardcoded
`xcodebuild -workspace mobile/ios/App/App.xcworkspace` — the shape every
Capacitor guide shows, and the shape `HUMAN-ACTIONS.md` #14 was written around —
and handed xcodebuild a path that does not exist.

**This is the finding, not the bug.** A founder following #14 on their own Mac
would have hit the same wall, in Xcode, with less signal. `pickXcodeContainer()`
now chooses `-workspace` or `-project` from what is actually on disk (workspace
wins if both exist, which is Xcode's own rule), throws if neither is there, and
has three tests. **`mobile/package.json` needs no change** — Capacitor's own CLI
made this choice, and the four plugins resolved fine.

Consequences worth knowing: the iOS shell has **no Podfile and no Podfile.lock**,
so the plugin versions are pinned by `mobile/package-lock.json` (which is not
committed — see the `npm install` note above) and by `Package.swift`, which
`cap sync` regenerates. That is a reproducibility question for #14 step 7
("commit `mobile/ios/`?") and it now has one more input.

### The other thing to check first

`prepare-webdir.mjs` reported **30 files, 2.46 MB of 3.00 MB** on the runner —
0.06 MB smaller than the 2.52 MB #209 measured on Windows, which is line endings,
not drift. Worth knowing because that cap is thin on purpose: `discover.json` is
the file that will push it.

**All three probe steps are `continue-on-error`** (choose simulator, install probe,
run probes) — a probe that cannot report is a *measurement* failure, not a build
failure, and conflating them would turn "we did not learn anything today" into "the
iOS shell is broken". The **build** steps deliberately are not, and a test asserts
they never become so: proving the shell compiles is the one claim this workflow can
make on its own, and a build that cannot fail proves nothing. The **reporting**
step is not either, because the only thing that flag could hide there is a crash in
the reporter — a green run with no summary at all, which reads as fine.
