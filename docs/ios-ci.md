# Building iOS without a Mac — and the three things the runner settles

Issue **#38** (MP4), part of **#34**. Stacks on **#209** (#36's `mobile/`
scaffold) and reads on from `docs/mobile-shell.md` and
`docs/research/mp1-background-audio.md` (#207).

The workflow is `.github/workflows/ios-build.yml`. Its own header carries the
operational detail; this file is the argument.

## 0. Why a CI runner is worth more here than a build

Nobody on this project has a Mac. That is not a gap in the tooling, it is the
shape of the team — and it has left three separate claims sitting unverified,
each of them blocking a decision:

| Claim | Where it lives | Status before #38 |
|---|---|---|
| The Capacitor shell compiles at all | `docs/mobile-shell.md` §0 | **Never generated, never installed, never compiled.** Its author said so in a table |
| Our CSP does not block Capacitor's injected bridge *on iOS* | `docs/mobile-shell.md` §5 | Reasoned from WKWebView's `WKUserScript` injection. `HUMAN-ACTIONS.md` #14 step 6.2 asks a human to type `Capacitor` into a console |
| Our out-point still fires when the app is backgrounded | `docs/research/mp1-background-audio.md` §8 | "**The single most load-bearing untested claim** in this document" — its words |

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
2. Assert Capacitor did **not** generate into the repo's `ios/`. #209 pins that
   through config; here it is checked against a directory that actually exists.
3. **Inject `UIBackgroundModes: audio`** into the generated `Info.plist` with
   `tools/mobile/inject-background-audio.mjs`. MP1 §7.3: this is the *entire* iOS
   background-audio requirement — WebKit sets the `AVAudioSession` category
   itself, so no plugin, no `AppDelegate` edit, no Swift.
4. **Build for the simulator, unsigned.** Then **build for a real device's
   architecture, unsigned** — arm64/Release, the configuration a TestFlight build
   would use. Two different compiles; the second is the one that would catch a
   Release-only or arch-specific failure.
5. Boot a simulator, install a **probed copy** of the built app, and run the two
   measurements (§3).
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
recorded because the second one changes the day the repo stops being public: at an
**estimated** ~12–18 minutes of wall clock, a run would then cost ~120–180
billable minutes. A sister project already suspected Actions-minutes exhaustion
behind a build freeze, and "it was free when we wrote it" is not a design.

**Those minute figures are an estimate, not a measurement** — they were written
before anything had run. Replace them with the run's real duration once one
exists. This document sits next to one whose entire §1 is a
measured-versus-documented table, for exactly this reason.

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

## 3. The two measurements, and what they are worth

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

## 5. If the first run fails

Expected, and cheap to read. The artifact `ios-shell-evidence` carries
`xcodebuild-simulator.log`, `xcodebuild-device.log`, `cap-add-ios.log`,
`toolchain.txt` (the OS, Xcode and CocoaPods versions — the first thing to check
when a runner image moves under you), the injected `Info.plist`, the simulator
system log, `container-tree.txt`, two screenshots (`01-playing.png`,
`02-backgrounded.png`) and the raw probe records.

The two most likely first-run failures, in order:

1. **No `.xcworkspace`.** The workflow builds with `-workspace
   mobile/ios/App/App.xcworkspace` and asserts that file exists, which assumes
   Capacitor 8 still generates a CocoaPods workspace. If `cap add ios` ever
   switches its iOS template to Swift Package Manager there is no workspace and no
   `pod install`, and the "generate the iOS project" step fails on the `test -f`.
   It fails **loudly**, which is the point of the assertion — the fix is
   `-project mobile/ios/App/App.xcodeproj`.
2. **CocoaPods.** `cap add ios` runs `pod install` itself. Capacitor's Podfile
   references every `@capacitor/*` pod by local path, so no remote spec repo should
   be needed — but `cap-add-ios.log` is where that assumption gets tested.

**All three probe steps are `continue-on-error`** (choose simulator, install probe,
run probes) — a probe that cannot report is a *measurement* failure, not a build
failure, and conflating them would turn "we did not learn anything today" into "the
iOS shell is broken". The **build** steps deliberately are not, and a test asserts
they never become so: proving the shell compiles is the one claim this workflow can
make on its own, and a build that cannot fail proves nothing. The **reporting**
step is not either, because the only thing that flag could hide there is a crash in
the reporter — a green run with no summary at all, which reads as fine.
