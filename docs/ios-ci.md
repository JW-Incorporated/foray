# Building iOS without a Mac — and the four claims the runner goes after (it settles three)

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
| Our CSP does not block Capacitor's injected bridge *on iOS* | `docs/mobile-shell.md` §5 | Reasoned from WKWebView's `WKUserScript` injection. `HUMAN-ACTIONS.md` #16 step 6.2 asks a human to type `Capacitor` into a console |
| Our out-point still fires when the app is backgrounded | `docs/research/mp1-background-audio.md` §8 | "**The single most load-bearing untested claim** in this document" — its words. **SETTLED, run 32026332637: it holds.** See §4b |
| A Foray's 31 seam **transitions** survive backgrounding — the 2.0 s beat's `setTimeout`, then a fresh cross-episode load | `docs/research/mp1-background-audio.md` §8, last paragraph | Named as a risk and left unmeasured. The out-point result does **not** cover it: different mechanism, and the beat runs on the clock the same run measured at 1 s alignment. Probe C (§3). **STILL OPEN after run 32036295743** — one hidden transition completed, which is below this workflow's own floor of two, so the verdict is `too-few-transitions`. And the one that completed took **9.2 s against a 2.0 s beat** — since fixed by #227, which this probe is now the only thing that can verify. See §4c |

**The fourth row is the one to read carefully.** A green `ios-build` run does not
mean the seam is sound, and this document's own machinery says so: a single
successful hidden transition reports `too-few-transitions`, not a pass. The seam
measurement so far is **one encouraging data point and one defect**, and §4c gives
them equal weight on purpose.

Be precise about the second one, because the sloppy version overclaims: §5's
heading is *"the top open risk: **Android's** injected bridge versus this CSP"*,
and its iOS line is "iOS is probably fine". So this workflow does not settle that
risk. It settles the *iOS assumption that sits beside it* — the one #16 step 6.2
calls "the single most important line of output in this whole item" — and Android
stays exactly where it was (`HUMAN-ACTIONS.md` #18).

GitHub's macOS runners have Xcode **and the iOS Simulator**. So the third
column can change without anyone buying a laptop.

## 1. What the workflow does, in order

1. `npm install` in `mobile/`, then **`npm run add:ios`** — the committed script,
   used rather than re-spelling `cap add ios`, so the workflow cannot drift from
   what `HUMAN-ACTIONS.md` #16 tells a human on a Mac to run.
2. Work out whether to build a **workspace or a project** (§5: Capacitor 8 is
   SwiftPM and generates no workspace), and assert Capacitor did **not** generate
   into the repo's `ios/`. #209 pins the second through config; here it is checked
   against a directory that actually exists.
3. **Inject `UIBackgroundModes: audio`** into the generated `Info.plist` with
   `tools/mobile/inject-background-audio.mjs`. MP1 §7.3: this is the *entire* iOS
   background-audio requirement — WebKit sets the `AVAudioSession` category
   itself, so no plugin, no `AppDelegate` edit, no Swift.
4. **Declare `ITSAppUsesNonExemptEncryption = false`** in the same plist, with
   the same script (`--encryption false`). Apple, to the founder on 2026-09-03:
   *"Since your build doesn't contain encryption, you can specify this in the
   information property list (Info.plist) in your Xcode project to avoid
   answering encryption questions with each app submission."* The answer is
   legitimately "none" — the only crypto call in shipped code is
   `crypto.subtle.digest("SHA-256", …)` in `sw.js`, a hash for cache integrity
   using WebKit's implementation; HTTPS is the OS's; the root `package.json` has
   zero dependencies. The reasoning lives beside the key in the script, and a
   test asserts it is still there, because `false` stops being true the day the
   app gains real crypto.
5. **Write the real app icon into the generated `AppIcon.appiconset`** with
   `tools/mobile/inject-app-icon.mjs`. Capacitor generates its own PLACEHOLDER
   artwork and nothing replaced it, so a TestFlight build on 2026-09-03 shipped
   wearing it. The script reads the catalog's own `Contents.json` for the
   filenames rather than hardcoding one (that name is a Capacitor template
   detail and has already changed between major versions), refuses a source icon
   the App Store would reject (not 1024×1024, or carrying an alpha channel), and
   refuses a catalog with no 1024 slot — because since Xcode 14 App Store
   Connect **extracts the public listing icon from the uploaded binary's asset
   catalog**, with no manual upload and no way to fix a build already sent.
   `--check` compares BYTES, not existence: the placeholder is also 1024×1024,
   so any `test -f` passes on the bug itself.
6. **Build for the simulator, unsigned**, then assert the icon reached the
   BUILT bundle (`Assets.car` exists, `CFBundleIconName` is `AppIcon`,
   `assetutil --info` names it) — a different claim from step 5's, because
   `actool` can leave an icon out for reasons no source-side check can see.
   Then **build for a real device's
   architecture, unsigned** — arm64/Release, the configuration a TestFlight build
   would use. Two different compiles; the second is the one that would catch a
   Release-only or arch-specific failure.
7. Boot a simulator, install a **probed copy** of the built app, and run the
   measurements in **two passes** (§3): the bridge + out-point probes, then a
   reinstall with `--phase seam` and the seam-transition probe. One container read
   at the end collects both, with the app never foregrounded in between.
8. Report every verdict to the job summary, and upload logs, screenshots and the
   raw probe records as an artifact.
9. **Gated on secrets that do not exist:** archive, export, upload to TestFlight.

## 2. Three design decisions worth defending

### The build is unsigned, and that is the point

Signing needs an Apple Developer account, a distribution certificate, a
provisioning profile and an App Store Connect API key. None exist
(`HUMAN-ACTIONS.md` #19). A workflow that needed them would be a workflow that
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

**Measured, 2026-08-17, and then REVERTED — the one-run experiment and what it cost.**
The seam window went 90 s → 175 s for exactly one run (**32077857553**, **8 min 26 s**
wall clock, so ~85 billable minutes at the 10× multiplier), to put the probe's first
silence at 60 s of hidden time instead of 15 s. That was the only way to tell a
suspension **ceiling** apart from a suspension following the probe's own silence, and it
settled it (§4c-iii). **Both the window and the arm are back to 90 s and 15 s**, because
at a 60 s arm the boundary lands past the ceiling and the run measures nothing about the
seam — a permanent 14-billable-minute surcharge for a blind probe.

Two things a longer window would **not** have licensed, recorded because a slower job
invites both: widening the path filter, and making this a required check. And one thing
that cost a run: `player/**` is in the path filter, so a second push to the same PR
**cancelled an in-flight run mid-probe** (`concurrency: cancel-in-progress`) and started
another — ~10 wasted 10×-billed minutes. Batch pushes to a branch this workflow watches.

`.github/workflows/ios-build.yml` is **governed**, so the window change needed a founder
label while the probe change it paid for did not — which is why `ios-workflow.test.mjs`
now **derives** the window's floor from `probe-seam.js`'s own constants rather than
trusting the two files to move together. That test is the lasting part of this.

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
`HUMAN-ACTIONS.md` #18 and it stays open. `bridgeVerdict()` carries both halves of
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
and #16 still want one real phone.

### Probe C — the seam transition, backgrounded

**Probe B's pass does not cover this, and that is the whole reason C exists.** B
settled the *stop*. A Foray is 32 segments joined by **31 transitions**, and each
transition is a different mechanism:

> stop at `end_sec` → wait a **2.0 s** beat (`player/seam-gap.js`, a `setTimeout`)
> → load a **different episode** → seek to its `start_sec` → play

Probe B's own numbers are the reason to doubt it. `timeupdate` kept its 252 ms rate
while hidden — that is a *media* event. The beat is a `setTimeout`, and the same
page measured hidden DOM timers at a **median of 1000 ms**. The load is worse
again: a fresh media fetch, `LOAD_SETTLE_TIMEOUT_MS` at 10 s visible / 20 s hidden, in a page that has
been *silent* since the boundary and may therefore have lost WebKit's audibility
assertion (`audibleActivityClearDelay` — **measured at 5 s, see §4c**; the 10 s
figure widely quoted for it is a different timer). If that chain breaks, a listener with
a locked screen hears one segment and then **silence for the rest of the commute** —
a different defect from playing the wrong episode, and one no amount of out-point
accuracy fixes.

`probe-seam.js` drives the **real `PlayerQueueManager`** over the real
`HtmlAudioBackend`, with the manager's own `REAL_SCHEDULER` — no injected clock,
because the clock is the suspect. Three bounded segments over **three** audio files:

| | Why |
|---|---|
| Three segments, so **two** transitions | One transition can succeed inside the 10 s audibility grace and the next still fail once the page has been silent through a beat. `MIN_HIDDEN_TRANSITIONS` is 2, and a single success reports `too-few-transitions`, not a pass |
| **Three** files, one per segment | `html-audio-backend.js` turns a same-URL load into a seek with no refetch — correct for consecutive segments of one episode, and the one path this must not take. Two files would force an A, B, A queue whose second load WebKit may satisfy from its media cache, putting the *easier* load on the transition that matters more. `seamTransitionVerdict` also checks the recorded `src` per item, so the property is measured rather than only asserted over the queue literal |
| The first boundary armed on `visibilitychange` | Probe B's expensive lesson. A fixed `end_sec` raced `simctl launch com.apple.Preferences`, which returns before Settings is actually foregrounded (~39 s once), and produced two contradictory verdicts from identical code |
| `hiddenAtBoundary` **and** `hiddenAtNextPlaying` **and** the wall clock vs `resumedAtWall` | A transition that completed because the app came *back* proves nothing. Two independent channels have to agree: the page's own `document.hidden` readings, and wall-clock stamps the page cannot fake by blinking |
| `lastStage` on every pending transition | "The beat's timer never fired" and "the load never settled" are different bugs with different fixes. Every stage — `boundary`, `beat-armed`, `load-started`, `loadedmetadata`, `canplay`, `playing` — is stamped and flushed as it happens, so a stall leaves a record of **how far it got** |

`seamTransitionVerdict` reports the stall case **first and above everything else**,
including a completed transition sitting next to it, because the stall is the
finding that changes what gets built.

**Its limit, and it ships with every verdict** (`LOCAL_MEDIA_CAVEAT`): the next
segment is a **local bundled file**, so this settles **the beat's timer and a fresh
media load while hidden** and not DNS + TLS + a range request into someone's CDN
while hidden — the other half of the risk MP1 §8 names. That limit is **permanent**,
not a to-do; §4d explains why, and why the two reasons this caveat used to give were
the weak ones.

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

- **`HUMAN-ACTIONS.md` #19 (new):** an Apple Developer Program membership, a
  distribution certificate, a provisioning profile, an App Store Connect API key,
  and the seven repository secrets. Until then there is no TestFlight build, only
  an unsigned one.
- **#15:** rule on the permanent bundle id. It is baked into the generated
  project; changing it after a store release means a new listing.
- **Nothing, on the seam gap — it is already fixed.** The 9.2 s this PR measured
  (§4c) was filed as **#223** and fixed by **#227** the same day. What is left is
  *verification*, and it needs a dispatch of this workflow on `main` rather than a
  founder: expect `observedGapMs` ~2,000–3,000 ms. See §4c.
- **The one thing only a phone can settle is now `HUMAN-ACTIONS.md` #11 step 6** —
  at each change of voice, does it sound like a two-second pause or like the app
  stopped? #224 is a founder report that it sounded like the latter.
- **#16 / #18:** still open. #16's *build* is now automated, but its device
  questions — icons visible, a Foray advancing with the phone locked, stale-content
  behaviour after an update — are device questions and a simulator cannot answer
  them. #18 is Android and this workflow says nothing about it.
- **#17:** whether the bundled-data freeze blocks a store submission.

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
   wrong. `HUMAN-ACTIONS.md` #11 and #16 step 6.4 are unchanged.
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

## 4c. The seam run — one transition, nine seconds, and one open question

Run [32036295743](https://github.com/JW-Incorporated/foray/actions/runs/32036295743),
2026-08-17. **The job was green. The job being green is not the result.**

| | |
|---|---|
| `seamTransitionVerdict` | **`too-few-transitions`** — *"1 hidden transition(s) completed, below the 2 this workflow requires before calling the seam sound"* |
| the transition that did complete | backgrounded start to finish: `hiddenAtBoundary: true`, `hiddenAtNextPlaying: true`, `armedWhileHidden: true`, `endReason: "outPoint"`, `resumedAtWall: null` |
| a different file really loaded | `seg-a` = `probe-tone.wav` → `seg-b` = `probe-tone-b.wav`, entered at `startedAtSec: 12` |
| out-point precision at that boundary | **3.1 ms** past `end_sec` |
| **the beat** | asked **2,000 ms**, observed **9,153 ms** |
| hidden DOM-timer alignment | median **1000 ms**, 25 samples |

### The pass half: the chain does run backgrounded, and no Swift is needed

One full segment-to-segment transition — beat, cross-episode load, seek, play —
completed with the app in the background and **never resumed**. Together with probe
B's out-point result that is the whole chain running hidden, and it is why the
`fired-on-resume` reading that argued for a native audio backend is retracted
(§4b). **A native out-point owner was started on that reading and thrown away.**

### The defect half: the 2.0 s beat took 9.2 seconds

`askedGapMs: 2000` → `observedGapMs: 9153`. **4.6x.** A listener with a locked screen
hears about **seven seconds of nothing** at that seam. The per-stage trace, offsets
from the boundary, localises it and exonerates the timer:

| stage | +ms | reading |
|---|---|---|
| `boundary` | 0 | the out-point stopped the element |
| `beat-armed` | **2** | **the `setTimeout` beat armed instantly — the JS timer is not the problem** |
| `load-started` | 12 | `backend.load()` began inside the beat, as designed |
| `stalled` | **3,173** | the media element fired `stalled` — on a **local bundled file** |
| `loadedmetadata` | 9,127 | |
| `canplay` | 9,142 | |
| `beat-ended` | **9,142** | **the same millisecond as `canplay`** |
| `playing` | 9,153 | |

`beat-ended` landing on `canplay` is the mechanism: the silence is
**`max(beat, load)`**, and the load dominated by 7 seconds.

**This was not undocumented behaviour, and it was never a bug in the beat.**
`player/queue-manager.js` §10 already stated it deliberately — *"total silence is
`max(gap, load)`, never `gap + load`"* — and that ordering is correct; the
alternative is `gap + load`, which is worse. What was wrong was the *size* it
assumed (§10 sized the cold-CDN case at *"the difference between 2 s and 5 s"*,
against 9.2 s on a bundled file) and the fact that `player/seam-gap.js` read as
though its `SEAM_GAP_SEC = 2.0` were the silence rather than a floor.

**Both have since been fixed, by #227, using this run's numbers.** Filed as #223,
addressed the same day. `seam-gap.js` now opens with *"THE SEAM THIS FILE DESCRIBES
WAS NOT THE SEAM THE PRODUCT HAD"* and says to read its number as the length of the
**beat**; and `html-audio-backend.js` moves the load off the boundary entirely,
warming the next segment on a second element `PREFETCH_LEAD_SEC` (12 s) before the
out-point while the current one is still audible. **The beat is still spent in full**
— 2.0 s between two voices is authored, not an artifact of loading.

So a real Foray is no longer worse than this measurement in the way it was. What
remains true is the compounding: the file here was **local**, and Foray #1 has
**31 seams**, not one — which is what made the fix worth doing rather than
tolerating.

### This probe is now the regression test for #227, and that is its job on `main`

Nothing on this machine can verify a prefetch that exists to win a race inside a
backgrounded WebView. This workflow can, and it is the only thing that can.

> **SUPERSEDED — DO NOT READ ~2,000 ms AS THE PASS CONDITION ANY MORE.** Run
> **32057395270** dispatched exactly this and #227 FAILED: `observedGapMs: null`,
> `lastStage: canplay` — the segment was dropped, not merely slow. The handover is
> now parked (default off), so this probe measures the **one-element** path and
> **~9–11 s, or a `did not settle within 10000ms` drop, is the expected reading**.
> Root cause in `docs/research/mp1-background-audio.md` §4.1a: media-element load
> tasks are throttled by VISIBILITY, so warming in the audible window buys
> nothing. Re-measuring the handover needs `prefetch: true` added to
> `probe-seam.js`'s `new HtmlAudioBackend(...)` by hand — without it a run cannot
> say anything about the handover either way.

**Dispatch `ios-build` on `main` and read `observedGapMs` in the seam record.
Against this run's 9,153 ms baseline, expect ~2,000–3,000 ms.** Two things to check
before reading a number as a verdict:

- **A bridged Foray gets no warming at all.** Eligibility is `seamGapSec(...) > 0`,
  the same call that decides the beat, so a narrated seam is deliberately not warmed.
  **"No change" on a bridged Foray is not a failed fix** — the run must be read at an
  **unbridged cross-episode** seam. The probe's own queue is three unbridged bounded
  segments over three files, so a dispatch of this workflow is the right shape by
  construction; the caveat matters for anyone reading a *product* Foray instead.
- **`SEAM_MIN_PLAUSIBLE_MS = 500` stays meaningful.** The beat is still 2.0 s, so a
  transition completing in under 500 ms still means the beat did not happen rather
  than that the prefetch was fast, and `seamTransitionVerdict` should still call that
  `inconclusive`. Do not relax that floor to accommodate a good result.

### The founder's own ears found the failure mode this predicted — #224

Recorded here because it is the strongest argument for keeping this workflow.

Wyatt listened to `grilling-history-1` on a real phone: *"The transitions worked ok
while my phone was unlocked, but when my screen was off then it would just pause."*

**That is the shape this section derived, realised on a device.** The cause given on
#224 is the load crossing **our own** `LOAD_SETTLE_TIMEOUT_MS` (10 s, defined in
`player/html-audio-backend.js`), whose expiry throws into `_loadItem`'s catch in
`player/queue-manager.js` and dispatches `E.error` — idle, and pause. *(Named by
function rather than by line: #227 moved these lines, and a line number in prose is
wrong the moment anyone edits above it. It was `queue-manager.js:470` before that
merge and is not now.)*

The measured beat was **9,153 ms**, which is **92% of that timeout** — so this was
never a comfortable margin, and on a real device with a real CDN it was spent. Read
the deadline table below before quoting the 847 ms figure, because #224 crossed
*ours*, not WebKit's.

Two consequences worth stating plainly:

1. **The Simulator pass was the weak direction of the evidence, and this is what
   that means in practice.** `SIMULATOR_CAVEAT` says a pass here cannot promise a
   device. A device then failed. The caveat earned its keep.
2. **The seam probe stops being a research curiosity.** It is now the regression test
   for a founder-reported bug (#224) and for the fix (#227), and it is the only rig
   that can exercise either one backgrounded.

### The open question this run could not answer, and it is the more serious one

**The record simply stops at +25.2 s of a 90 s hidden window**, one second after
`seg-b` became audible, with `seg-b`'s own out-point armed. The hidden DOM-timer
samples stop at the same instant (25 samples over 24.236 s; median 1000 ms, and every
sample after the first is 985–1015 ms — the first is 252 ms, a partial interval at the
visibility flip).
The probe saves every 2 s, so roughly **32 subsequent saves never landed**, and
about **65 s of the window went unused**.

Two readings, and this artifact cannot separate them:

- **(a) the page stopped being scheduled** about a second after a 9.15 s silence. If
  so it is a far bigger problem than the seam gap: it would mean a hidden page can be
  descheduled **mid-Foray** after sustained silence, which is the failure that makes
  the whole WebView-shell approach unsafe.
- **(b) the page kept running and its `localStorage` writes stopped reaching disk**,
  making the collected record a ~65 s stale snapshot. A harness defect.

**Do not let this settle into a footnote about save cadence.** Under (a) the product
decision changes.

What was ruled out, so nobody re-treads it:

- **The 90 s budget is not the cause.** At the measured 9.2 s beat the chain needs
  15 + 9.2 + 8 + 9.2 ≈ **41.3 s**, ~45 s with margin; two worst-case beats at
  `SEAM_BAD_MS` need ~59 s. 90 s clears it with ~2x headroom and is **unchanged** —
  macOS minutes bill at 10x. What was wrong was the budget's stated *derivation*,
  which assumed a 2 s beat; that is corrected in the workflow.
  **Superseded 2026-08-17: the window IS now changed, to 175 s, and not because 90 s
  was too small for this chain — it was not. It is because the chain itself moved
  (`ARM_AFTER_HIDDEN_SEC` 15 → 60 s), which is what §4c-ii is about. "Unchanged" above
  describes the reasoning of the day, kept because the reasoning was sound.**
- **`04-seam-backgrounded.png` cannot show it.** It captures the device screen —
  Settings in the foreground, `◀ Foray` in the status bar — not the probe's WebView.
  It is good independent corroboration that the app really was backgrounded, and it
  is nothing else.
- **The simulator log cannot show it either, and that was its own defect.**
  `simulator-log.txt` is **exactly 20,000,000 bytes** — truncated — covering
  **13:45:30.961 → 13:46:44.369**. The seam pass began at **13:47:08.446**, twenty-four
  seconds after the log ends, so it has **no log coverage at all**. The predicate was
  `processImagePath CONTAINS "App"`, which matches most of the system, so the shared
  20 MB cap was spent by pass 1: **1,153 of 99,491** timestamped lines came from our
  process (~1.2%), all of them PID 19964 — pass 1's process. Of the four `Suspended`
  hits for it, two are `WebProcessProxy::canTerminateAuxiliaryProcess: returns false`
  (which means *do not* terminate), one is
  `WebPageProxy::applicationDidEnterBackground` (`com.apple.WebKit:ViewState`) and one
  is a KeyboardArbiter `invalidateConnection (appDidSuspend)` — a UIKit lifecycle
  label, not process suspension. **None is a RunningBoard suspension.**

**Fixed here so the next run decides it from the record alone:** each pass gets its
own log capture and its own cap, the predicate matches our bundle id instead of the
substring `App`, the reporter reads both logs, and the seam record now carries
`saveSeq` + `firstSavedAtWall`. If `saveSeq` is high while `lastSavedAtWall` is old,
the writes stopped landing — reading (b). If both are old and `saveSeq` matches
elapsed/2 s, the page stopped being scheduled — reading (a).

> **THAT LAST SENTENCE IS WRONG AND `probe-seam.js` SAYS SO IN ITS OWN COMMENT.**
> `saveSeq` and `lastSavedAtWall` are serialised into the **same** `setItem` blob, so
> whatever reaches disk always carries a matching pair: "high seq, old wall clock" is
> unobservable by construction, and no counter inside a record can be otherwise —
> a page cannot record that its own later write failed to persist. What the pair buys
> is the **cadence**, which is worth having and is not a discriminator.

### 4c-ii. What actually separates (a) from (b), and what it has already found

Three channels, added 2026-08-17, because the two that existed were both the page's
own account of itself.

1. **`saveTrail`, in the record.** One stamp per save carrying the **wall clock and
   the media clock together**. Different machinery drives them — `Date.now()` needs
   the page scheduled, `currentTime` needs the audio pipeline running — so a **gap**
   between stamps is proof the page was frozen **and resumed**, which no "the record
   stops" observation can show, and the media delta across the gap says whether the
   audio kept flowing through it.
2. **The simulator log's own media clock and lifecycle**, parsed by
   `parseSimulatorLifecycle` in `tools/mobile/ios-ci.mjs`. This is the only channel
   that can see anything **after** the last write reached disk. It is deliberately
   brittle-tolerant: needles copied out of a real log, degrading to "no coverage"
   rather than to a confident number, and a log whose timestamps do not **overlap**
   the record's hidden window is discarded rather than offset-corrected.
3. **`suspensionVerdict`**, which combines them into section **3b** of the job
   summary: where the record stops, whether audio was provably still playing then,
   and which channel carried it. `suspended-while-audible` requires **positive**
   evidence of audio from a channel — "no pause was recorded" lands on
   `suspended-audio-unknown` instead, because an unobserved silence must not be able
   to wear an observed one's headline.

**Run 32064639785's artifact, re-read through it, already changes two things** — and
`docs/research/mp1-background-audio.md` §4.1b-ii carries the log lines and the labels:

- **The record's end is a real suspension, not a flush failure.** It lands at
  **+27.86 s** of hidden time and `didChangeThrottleState(Suspended)` is at **+27.99 s**.
  Reading (a) at that instant, not (b).
- **But the suspension was already in motion.** WebKit armed a ~10 s
  foreground-assertion release when the probe's **own** first boundary silenced the
  audio at +15 s, and re-taking the media-playback assertion when `seg-b` became
  audible at +20.16 s **failed** — `originator doesn't have entitlement
  com.apple.runningboard.assertions.webkit`, which no `simctl`-launched Simulator app
  holds. So this is not "suspended regardless of audio"; it is "suspended by a timer
  our own beat started, which this instrument cannot cancel".
- **And the Foray kept advancing.** The log runs 35 s past the record: the process
  resumes at ~+41 s, `seg-b`'s out-point fires **11.1 s late in media time**, a fresh
  load runs, and a third segment plays 20 → 26.2 s at +56 s — **both transitions
  completed, hidden, never foregrounded by the harness.** `MIN_HIDDEN_TRANSITIONS = 2`
  was satisfied by the *app* and not by the *record*.

**So `too-few-transitions` on every past run is a statement about the artifact, not
about the seam** — including the runs people (the founder included) described as
successes. Quote it that way.

### 4c-iii. The experiment ran, and the ceiling is real — run 32077857553

**The question §4c-ii left open — whether a hidden page is suspended at ~26 s *when its
audio never stops at all* — is answered: YES.** The arm went to 60 s and the window to
175 s so the probe's own audio never stopped anywhere near the number in question. One
variable moved.

| | |
|---|---|
| audio before the suspension | **continuous**, from 14.5 s before the app was hidden |
| the record's own save trail | 24 stamps, `paused: false` on all of them, media clock at **0.99992×** wall clock over 24.6 s |
| first boundary | armed at media **74.47 s** — never reached |
| record's last durable write | **+24.59 s** of hidden time, PLAYING |
| log's media clock | `isPlaying = true` at **+25.01 s** — 1.3 s before the suspension |
| suspension | `didChangeThrottleState(Suspended)` **+26.28 s** |
| assertion-release timers | **NONE armed anywhere in the window** |

**So §4c-ii's mechanism is retracted as the explanation.** Its lead-time arithmetic
(15 s of arm + a 10-13 s WebKit release ≈ 25-28 s) held across three runs and was a
coincidence — all three shared one arm value. The measurements in it stand; the causal
reading does not. That is what an inference is for, and this is what testing one costs.

**The traced cause is the one thing a Simulator cannot model.** From this run's log: a
**~30 s UIKit background-task budget** expired (`WKProcessAssertionBackgroundTaskManager:
_handleBackgroundTaskExpirationOnMainThread (remainingTime=3.94979)`) while the
`'View is playing audio'` foreground activity was **still held** — and it could not save
the process because the RBS `'WebKit Media Playback'` assertion had been **refused at
playback start** for want of `com.apple.runningboard.assertions.webkit`. That entitlement
is what `UIBackgroundModes: audio` buys a real signed app.

**Both halves of that, kept together:**

- the ceiling is real *here*, it is not a fixture artifact, and it bounds every hidden
  number this workflow has ever produced at ~26 s. **`MIN_HIDDEN_TRANSITIONS = 2` needs
  ~39 s of hidden time at the measured 9.2 s beat, so it is unsatisfiable on this
  instrument** — `too-few-transitions` on every run to date is a statement about a 30 s
  background-task budget, not about the seam;
- and the cause is a **missing entitlement on an unsigned `simctl`-launched app**, which
  is a property of the Simulator rather than of iOS. `SIMULATOR_CAVEAT` finally points the
  other way: this *failure* is the weak direction of the evidence, because its mechanism
  is visibly absent here and present on a phone.

**Do not report "a Foray stops advancing 26 s after the screen locks" as a device
finding.** `HUMAN-ACTIONS.md` **#11** is now the highest-value twenty minutes available
to this project: screen off, does the running order keep advancing past half a minute?

**The probe is back to `ARM_AFTER_HIDDEN_SEC = 15` and the window to 90 s**, because at
60 s the boundary lands ~34 s past the ceiling and the run measures nothing about the
seam (that run's `seamTransitionVerdict` was `inconclusive`). The ceiling instrument —
`saveTrail`, `parseSimulatorLifecycle`, `suspensionVerdict`, section 3b — stays
permanently, and `ARM_AFTER_HIDDEN_SEC`'s comment carries the recipe for re-running the
experiment.

### The audibility grace is **5 s**, not 10 s — and the beat blew straight through it

**This corrects a number this document and MP1 §7.4 both had wrong**, and the
correction makes the result more interesting rather than less. There are **two**
timers, and the same log carries both, verbatim, for our process:

```
13:46:27.185  WebProcessPool::updateAudibleMediaAssertions: Starting timer to clear
              audible activity in 5 seconds because we are no longer playing audio
13:46:32.191  WebProcessPool::clearAudibleActivity: ...          <- 5.006 s later
13:46:27.205  WebPageProxy::updateThrottleState: UIProcess starting timer to release
              a foreground assertion in 10 seconds if audio doesn't start to play
```

`clearAudibleActivity` is the operation `audibleActivityClearDelay` drives, and it
fired at **5 s**, measured. The **10 s** figure belongs to a *different* mechanism —
releasing the foreground assertion. MP1 §7.4 labels the 10 s one
`audibleActivityClearDelay = 10_s`; that is wrong, and this run is the evidence.

So the honest reading of the 9,153 ms beat is **not** "it squeaked inside a 10 s
grace by 850 ms". It is:

- the silence **exceeded** the 5 s audible-activity clear, comfortably — audible
  activity was cleared *during the beat*;
- it stayed under the 10 s foreground-assertion release, by ~850 ms;
- **and the transition completed anyway.**

That is a stronger pass on the mechanism than the wrong version claimed: the page
lost its audible-activity assertion mid-seam and still loaded, seeked and played.
It also relocates the cliff. The thing to fear is the **10 s** foreground-assertion
release, and the measured beat came within **847 ms** of it — **on a local file**.
A cross-origin fetch has under a second of headroom before crossing that threshold.

**And a real phone then hit a 10 s deadline — but be careful WHICH one, because
there are three, and they were all 10,000 ms until ours moved.** **SHIPPED 2026-08-17: the deadline is visibility-aware — 10 s visible, 20 s hidden.** WebKit's two are unchanged and not ours to move. #224: a founder heard a Foray *pause*
at a seam with the screen off. **The report is an ear, not an artifact** — #224 is
open, with no device log — so the mechanism below is the *traced* cause and not a
measured one, which is the same standard §4c applies to itself. It is our **own**
application deadline, `LOAD_SETTLE_TIMEOUT_MS` in `html-audio-backend.js`, whose expiry throws
into `_loadItem`'s catch and dispatches `E.error` — idle, and pause. That is not
WebKit's foreground-assertion release, and it is not the 5 s audible-activity clear.

The three, kept apart on purpose:

| deadline | whose | what it does at expiry |
|---|---|---|
| `audibleActivityClearDelay` **5 s** | WebKit | drops the audible-activity assertion. **Crossed** during the measured beat; playback continued |
| foreground-assertion release **10 s** | WebKit | `WebPageProxy::updateThrottleState` releases the foreground assertion |
| `LOAD_SETTLE_TIMEOUT_MS` **10 s** | **ours** | `E.error` → idle → **pause**. This is #224's stated cause |

The measured 9,153 ms is **92% of our own timeout** and 847 ms short of WebKit's.
Both arithmetics gave 847 ms because both constants were 10,000 ms, which is exactly
why they are easy to conflate — the earlier draft of this paragraph did. ~~#227's
prefetch takes the load out of the silent window, which addresses all three at
once.~~ **It does not: run 32057395270 measured the load taking ~11 s whether the
page is audible or silent, because the throttle is on VISIBILITY (§4.1a). All
three are still open on WebKit's side; ours SHIPPED as a visibility-aware
`LOAD_SETTLE_TIMEOUT_MS` so a slow load stops dropping the segment.**

### What the log DOES say, and a claim it walks back

The narrow claim above — the seam pass has no log coverage — is correct. The broader
"there was no log" framing was wrong and left **1,153 lines from our own process**
(of 99,491 timestamped, ~1.2%) unread. Two things in them matter:

- **The app could not take the media-playback assertion at all.**
  `ProcessAssertion::acquireSync Failed to acquire RBS assertion 'WebKit Media
  Playback'`, because *"originator doesn't have entitlement
  com.apple.runningboard.assertions.webkit"*. This is exactly the entitlement gate
  MP1 §7.4 documents as the reason a real app must carry the background mode. **A
  simulator app run from `simctl` does not hold it.** That materially strengthens
  `SIMULATOR_CAVEAT`: this measurement is not merely missing power management, it is
  missing the assertion the real mechanism depends on.
- RunningBoard's last observed state for the process is `unknown-NotVisible`, and it
  logs `assertionsDidInvalidate` at 13:46:34.509. **No RunningBoard suspension is
  ever observed** — but the log ends before it could have been, so that is an
  absence of evidence, not evidence of absence.

### One caveat that was over-corrected once, so read the scoping

The 0-byte `csp-messages.txt` **cannot** support "zero CSP violations" for the seam
pass, because the log never covered it. But the **in-page** observation is separate
and stands: `foray_probe_bridge`, written by the seam pass's own launch at
13:47:05, carries `cspViolations: []`, `capacitorType: "object"`,
`isNativePlatform: true`, nine plugin names, `hasServiceWorkerApi: false`, origin
`capacitor://localhost`, rechecked after 3,000 ms. **CSP is measured clean in-page;
the log file proves nothing either way.** Keep both halves of that.

Relatedly: **zero `FORAY_PROBE_` lines appeared in 110,579 captured lines**, so a
WKWebView `console.log` has never once been observed reaching the simulator system
log. `collectProbes`' console channel is therefore **unproven, not clean** —
`localStorage` is the only measurement path that has ever worked, and a report that
looks multiply-sourced has one source.

## 4d. Can this ever measure a cross-origin fetch? — no, and that is permanent

The honest answer to the question `LOCAL_MEDIA_CAVEAT` raises, because a caveat that
reads as a formality invites someone to discharge it cheaply and believe they have.

**The two reasons the caveat used to give are the weak ones.**

- **`media-src 'self'` is a one-line, zero-risk obstacle.** The probe pages carry
  their own `<meta>` CSP (`probe-seam.html`) and `install-probe.mjs` copies them
  byte-for-byte; widening it would touch nothing shipped and would not even turn a
  test red today. It is a fact about our own fixture, not an obstacle.
- **Product principle #3's letter is satisfied** by streaming from the original
  enclosure URL — that *is* "download via original enclosure URLs". The real
  objection is load and politeness, and this repo already ruled on it once:
  `tools/foray/verify-source-audio.mjs` is *"MANUAL, NEVER CI ... CI must not go red
  because a podcast CDN had a bad afternoon."* A defensible **choice**, not a
  prohibition. (CORS is a non-issue: `html-audio-backend.js` deliberately sets no
  `crossorigin`, so a no-CORS `<audio>` load needs no header from any of the 43 hosts.)

**First, #227 narrowed the risk without removing it.** Since the prefetch landed, a
warmed seam fetches 12 s early **while the page is audible and holds its assertion**,
so the fetch is no longer in the silent window at all. What still fetches inside the
silence is the **unwarmed residue**: bridged seams (deliberately not warmed), the
first item, user-driven transitions, and a warm **miss** — a warm element whose buffer
was evicted or whose load lost the race. So the question below is no longer "how slow
is a seam fetch" but "**how often does a seam fall back to the cold path, and how slow
is it when it does**".

**The binding reason it cannot be answered here, and no CI change fixes it.** A
`macos-latest` runner is a datacenter IP on a datacenter link — **the fastest network
this app will ever see**. The risk being chased is a **slow** cold fetch in the silent
window. So a green cross-origin number from CI would be a **floor**, and a floor
cannot retire a tail-latency risk. It is
the same asymmetry `SIMULATOR_CAVEAT` already names for power management, and it
survives widening the CSP *and* proving the runner has egress. (Whether a runner can
reach a podcast CDN is, separately, **unproven rather than blocked** — the
"every CDN was unreachable" line in `STATE.md` is a fact about the Windows dev
machine, not about GitHub Actions, and should not be quoted as one.)

**What would actually settle it.** Not a CI change and not only a device test: move
the per-stage stamping the probe already does — `load-started` → `canplay` — into the
**shipped** seam path (`player/queue-manager.js`'s beat clock and
`player/html-audio-backend.js`'s load events) and read a **distribution** off real
networks, real hosts and real times of day, including the LTE-in-a-tunnel tail that
is the actual risk. It costs no extra CDN load — the listener's player was going to
fetch that byte range anyway — needs nothing new in the CSP (`index.html` already
carries `media-src https:`), and has zero principle-#3 exposure. The one real phone
`HUMAN-ACTIONS.md` #11/#16 asks for then **confirms a real number** instead of
supplying a single anecdote.

**Post-#227 that instrumentation has to cover the WARM path too** — `prefetch` → the
warm element's `canplay` — and report the **warm-miss rate**. The miss rate is now
what decides whether a seam fetch happens in the silent window at all, so
instrumenting only the cold path would measure the exception and report it as the
rule.

Until that exists, the correct sentence is the one the constant carries: a cold
cross-origin fetch at a seam is **unmeasured, and unmeasurable here**.

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
Capacitor guide shows, and the shape `HUMAN-ACTIONS.md` #16 was written around —
and handed xcodebuild a path that does not exist.

**This is the finding, not the bug.** A founder following #16 on their own Mac
would have hit the same wall, in Xcode, with less signal. `pickXcodeContainer()`
now chooses `-workspace` or `-project` from what is actually on disk (workspace
wins if both exist, which is Xcode's own rule), throws if neither is there, and
has three tests. **`mobile/package.json` needs no change** — Capacitor's own CLI
made this choice, and the four plugins resolved fine.

Consequences worth knowing: the iOS shell has **no Podfile and no Podfile.lock**,
so the plugin versions are pinned by `mobile/package-lock.json` (which is not
committed — see the `npm install` note above) and by `Package.swift`, which
`cap sync` regenerates. That is a reproducibility question for #16 step 7
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
