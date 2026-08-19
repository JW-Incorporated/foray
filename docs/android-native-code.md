# Where Android's hand-written native code lives, and the foreground service that lives there

Part of **#27** (lock-screen and steering-wheel controls) and **#37** (the Android
build). Reads on from `docs/android-shell-build.md` and
`docs/research/mp1-background-audio.md` §5.

## 0. The blocker this resolves

**There was nowhere for native Android code to live.** `git ls-files` contained
**zero** `.kt` and **zero** `.java` files, and `mobile/android/` is gitignored in
full.

#37 was right to reject committing the generated platform — ~100 generated files
with no reviewer — and it made the same call for `mobile/ios/`. That decision is
about *generated output*, and it had a consequence nobody chose: **Android needs
hand-written native code and had no home for it.**

> **A PREMISE CORRECTED, 2026-08-18, AND THE VERDICT IS UNCHANGED.** This
> paragraph used to justify that call partly on `mobile/` being *"a directory that
> auto-merges with no post-merge review window"*. **That is false, and it was
> false when it was written.** `mobile/` is not in `ALLOWED_PREFIXES`, so a PR
> touching it is never armed for auto-merge — #271's own
> `automerge-decision` run logged *"auto-merge was enabled and has been turned OFF"*
> and its `merged_by` was a human account with `auto_merge: null`.
>
> **The decision does not depend on the merge path and never did.** The surviving
> argument is the stronger one and it is §2.1(a)'s: the native code would sit
> inside a tree `cap add` regenerates, so a reviewer would have to tell four
> hand-written files from the whole generated tree, on every diff, forever
> (§2.1(a) puts it at 2,619 files — cited rather than restated here, because that
> figure is not sourced anywhere in the repo and sits sixteen lines from a "~100").
> A directory nobody can read is a directory nobody notices a change in.
> Committing the generated platform is still the wrong call.
>
> Recorded rather than quietly rewritten, because this is **a wrong reason
> attached to a right decision — the kind that persists longest, because nothing
> it produces ever looks broken.** §8 states the actual rule.

Two things make that native code non-optional, and neither is a preference:

1. **Backgrounded playback beyond the audible window needs a `mediaPlayback`
   foreground service.** MP1 §5.3: from Android 14 a foreground service must
   declare a type, `mediaPlayback` is the only appropriate one with no runtime
   prerequisites and **no runtime timeout** — and a Foray is 45 to 90 minutes.
2. **`navigator.mediaSession` is switched off in Android WebView at the engine
   level.** MP1 §5.4: `aw_main_delegate.cc` appends
   `switches::kDisableMediaSessionAPI`, so **an Android shell gets no lock-screen
   controls at any price from JS.** #37's report put it exactly right: *"#27's
   Android half and the FGS are one job."*

## 1. How every claim in this document was obtained

The one table to read before quoting anything. `docs/android-shell-build.md` §0 and
MP1 §1 keep the same table for the same reason.

| Claim | How |
|---|---|
| A local Capacitor plugin at `mobile/plugins/foray-audio/` is discovered and wired into the generated project | **Executed.** `cap add android` reports `Found 5 Capacitor plugins for android: foray-audio@0.1.0`, and the generated Gradle files name it. §3.1 |
| Anything about the lock screen, the Media3 session or the transport controls added since | **See `docs/android-lock-screen.md` §0**, which keeps its own table. Nothing there is measured on a device either |
| Both APKs still build, with sizes and wall clock | **Executed on this machine.** §4 |
| The `<service>` and both `FOREGROUND_SERVICE*` permissions reach the app's merged manifest | **Executed** — read out of `app/build/intermediates/merged_manifest/…/AndroidManifest.xml` after `assembleDebug`. §4.2 |
| The web half's state machine — start on first play, stop after a settle window, survive a seam, self-correct a refused play | **Executed, against fakes.** 57 tests in Node (53 `test()` declarations, two of them looped into six runs), 23 mutations, 23 caught. §5.3. **No WebView ran.** |
| The foreground service actually starts, or holds process importance, or keeps audio alive | **NEITHER MEASURED NOR INFERRED — UNVERIFIED.** Nothing has run this code on an emulator or a device. §6 |
| A `mediaPlayback` FGS prevents freezing | **INFERRED**, and the inference is MP1 §5.3's, not upgraded here |
| Our CSP does not block the injected Capacitor bridge | **INFERRED** by `docs/android-shell-build.md` §2, unchanged. This change does not depend on it: the script it adds is an ordinary same-origin `<script src>` placed **after** the CSP meta, so `script-src 'self'` is genuinely what allows it |
| Whether Android 15's audio-focus rule bites us | **OPEN.** §6.2 |

**No emulator was attempted.** MP1 §6.2 spent ~75 minutes across three cold boots
and reached nothing usable, and §6.4 explains why an emulator would have been
necessary but not sufficient anyway. Nothing here re-litigates that.

## 2. The decision: a committed local Capacitor plugin

**`mobile/plugins/foray-audio/`**, declared in `mobile/package.json` as
`"foray-audio": "file:plugins/foray-audio"`, consumed by the generated project
through Capacitor's own plugin discovery.

Against the four requirements:

| Requirement | How this meets it |
|---|---|
| **Survives a platform regeneration** | `cap sync` rewrites `capacitor.settings.gradle`, `app/capacitor.build.gradle` and `capacitor.plugins.json` **from the plugin list, every run**. There is no patch to re-apply and no order to get right |
| **Reviewable** | 8 files, ~700 lines including comments. A human can read the whole diff |
| **Generated output stays uncommitted** | `mobile/android/` and `mobile/ios/` are still ignored in full. Nothing about #37's call changes |
| **Nothing a founder has to run that a script cannot** | `npm install && npm run add:android` — unchanged from `mobile/README.md`. The plugin needs no extra step |

### 2.1 What was rejected, and why

**(a) Commit `mobile/android/`.** Rejected again, and for a reason that is now
stronger than #37's rather than weaker. #37's objection was unreviewability: ~100
generated files, no reviewer. That still holds. What this change adds is that
committing the platform would *not even solve the problem well*: the native code
would sit inside a tree `cap add` regenerates, so every reviewer would have to tell
our four hand-written files apart from 2,619 generated ones, on every diff, forever.
A directory nobody can read is a directory nobody notices a change in.

**(c) A post-`cap add` patch or codegen step in `tools/mobile/`.** The closest call,
because the repo already has one of these and it works — `inject-background-audio.mjs`
writes iOS's `UIBackgroundModes` key. Rejected for three reasons:

- **It must be re-run, and forgetting is silent.** `cap sync` regenerates the
  Android manifest; a patch step that did not run leaves an app that builds,
  installs, plays, and dies in the background. Adding it to `npm run sync` helps
  and does not fix `npx cap sync`, which `mobile/README.md`, Capacitor's own docs
  and every habit point at.
- **It is the harder thing to test.** `inject-background-audio.mjs` is 400 lines of
  care for **one plist key** precisely because injecting into generated XML is
  hazardous. Injecting a `<service>`, two `<uses-permission>` elements, a
  `res/values` string set and two Java source files is that problem several times
  over, and the tests would be tests of a patcher rather than of the service.
- **It is not the idiomatic answer.** A Capacitor plugin *is* the extension point.
  Choosing to hand-patch the generated tree instead means owning a private
  mechanism where a supported one exists.

The one thing (c) has that (b) does not is that it needs no `mobile/package.json`
dependency entry, which is a real cost of (b) — see §3.2.

### 2.2 Why the plugin is not in `mobile/android/` even though that is where it runs

Worth stating because it is the question a reader arrives with. Capacitor's plugin
mechanism resolves a plugin's Gradle module by path and writes
`project(':foray-audio').projectDir = new File('../plugins/foray-audio/android')`
into the generated project. The module therefore does not have to be *inside* the
generated tree to be *part of* the generated build. That indirection is the whole
trick, and it is Capacitor's, not ours.

## 3. What was built

### 3.1 The plugin

```
mobile/plugins/foray-audio/
  package.json                                   the `capacitor.android.src` pointer
  android/build.gradle                           a com.android.library module
  android/src/main/AndroidManifest.xml           the <service> + two permissions
  android/src/main/res/values/strings.xml        prefixed foray_* strings
  android/src/main/java/…/ForayAudioPlugin.java  start / stop / state
  android/src/main/java/…/PlaybackKeepAliveService.java
  web/foray-audio-shell.js                       the state machine
  web/package.json                               `"type": "module"`, so Node can test it
```

**Two Gradle dependencies, and neither is new to the build:**
`project(':capacitor-android')` for the `Plugin`/`PluginCall` base classes, and
`androidx.appcompat:appcompat` for `NotificationCompat`, `ServiceCompat` and
`ContextCompat` (appcompat exposes `androidx.core` as `api`). Both are already
modules or dependencies of every generated Capacitor project, so the native half of
the shell adds **no new Maven artefact**, and `shell-invariants.test.mjs` asserts
that.

**Not Media3, on purpose.** The audio is the WebView's own `<audio>` element, not
an ExoPlayer, so a service that holds process importance up needs no player library.
Media3 `MediaSession` plus a `Player` adapter over the WebView element is the right
vehicle for #27's metadata and transport controls, and at that point this service
should become a `MediaSessionService` — but declaring `androidx.media3.session`
today would be a dependency with no caller.

### 3.2 The one real cost of choosing (b)

`mobile/package.json` gained a dependency, and `shell-invariants.test.mjs` had a
test requiring every dependency to start with `@capacitor/`, whose failure message
asked for *"a line in `docs/mobile-shell.md` saying why the shell needs it"*. That
test **fired**, which is what it was for.

It is relaxed narrowly rather than deleted. The rule that matters is not "only
Capacitor" — it is **no third-party JavaScript in the shell**. So a non-Capacitor
entry is allowed only as a `file:` specifier resolving **inside `mobile/`**, which
is this repo's own code by construction, and every `@capacitor/*` entry must still
be a registry range. A `lodash`, a git URL, a tarball and a `file:` path pointing
out of the tree all still fail, and each of those is a mutation the suite catches.

**What it does to the lockfile, checked because a machine-absolute path in a committed
lockfile would make the build non-reproducible** — the exact objection #37 raised when
it committed `mobile/package-lock.json`. `npm` records:

```json
"node_modules/foray-audio": { "resolved": "plugins/foray-audio", "link": true },
"plugins/foray-audio":     { "version": "0.1.0", "license": "UNLICENSED" }
```

A relative path inside the repo and a link. No registry, no tarball, no integrity hash
to go stale, and nothing about this machine.

**And `npm ci` was run against it**, not just `npm install` — because `ci` is what a CI
job would use and it fails outright on a lockfile that disagrees with `package.json`. It
installs, the `node_modules/foray-audio` link is recreated, and `npx cap ls` from that
clean tree still reports `Found 5 Capacitor plugins for android: foray-audio@0.1.0`. So
the discovery chain in §2 does not depend on the incremental state of the machine that
built it.

### 3.3 The web half, and why it patches a prototype

`player/html-audio-backend.js` builds its element with `new Audio()`. A **detached**
element's events never reach `document`, so the obvious
`document.addEventListener("play", …, true)` catches nothing. The only reliable hook
is `HTMLMediaElement.prototype.play`, and the shell wraps it under three rules: it
calls through always, it returns the original's value **by identity**, and it never
reads `.then` on that value — attaching a handler to a `play()` promise would mark a
rejection handled and silently delete a console warning the player's author relies
on. All three are tested, the third with a thenable that records whether `.then` was
touched.

**`player/` is not modified.** #224 is open there and PR #241 owns `sw.js`. Nothing
in the player knows this file exists.

### 3.4 The settle window, which is the only interesting decision in the web half

Stopping the service the instant the last element pauses would be a **crash**: a
cross-episode seam pauses one element and plays another, and from Android 12
`startForegroundService` throws `ForegroundServiceStartNotAllowedException` when the
app is in the background. So the stop is delayed, and the delay has a floor and a
ceiling that are not ours:

- **Floor — 20 s.** #239 gives a **hidden** media load 20 s before it gives up,
  because MP1 §4.4 measured hidden-page loads at 9–11 s *for a small local bundled
  file*. A window at or below that fires mid-seam.
- **Ceiling — 30 s.** Blink's `page_scheduler_impl.h`: *"A page cannot be throttled
  or frozen 30 seconds after playing audio"* (`kRecentAudioDelay`). Our settle timer
  runs in a page that has just gone **silent**, so it is inside that grace window and
  only inside it. At or past 30 s the timer that stops the service can be frozen
  before it fires.

**20 s < 25 s < 30 s.** It is tight because the two bounds are somebody else's
constants, and if #239's hidden deadline ever rises past ~28 s the two requirements
stop being simultaneously satisfiable — at which point the answer is a native stop
timer, not a bigger number in JS. A test asserts the inequality against both
literals, separately from the test that pins 25 000 ms.

**What it costs, stated plainly.** A user who deliberately pauses sees "Playback
active" for up to 25 more seconds. It cannot be shortened by telling a deliberate
pause apart from a seam, because from JS they are the same event — MP1 §5.2 records
that #227's own safety nets could not tell an autoplay refusal, an audio-focus
denial and an unexplained pause apart either. **#27's Android half is what fixes
it:** once a pause can arrive from a transport control, a pause the app *issued* is
attributable and can stop the service at once. A `visibilitychange` net covers the
other half — becoming visible with nothing playing stops the service immediately,
which is also the only recovery if the settle timer was frozen after all.

## 4. Both APKs still build

### 4.1 The numbers

JDK **21.0.12+8**, SDK platform **android-36**, build tools **36.0.0**, Gradle
**8.14.3**, AGP **8.13.0**, minSdk **24**, compileSdk/targetSdk **36**,
cordova-android **14.0.1**, `androidx.webkit` **1.14.0** — every one of them
unchanged from `docs/android-shell-build.md` §1.2, and **no version pin, no
`gradle.properties` line and no `variables.gradle` edit was needed**. The plugin
takes its `compileSdk`/`minSdk`/`targetSdk` and its appcompat version from
`rootProject.ext`, so it tracks the generated project rather than pinning a second
set.

| | Result | APK | vs #37 | Wall clock |
|---|---|---|---|---|
| `./gradlew assembleDebug` | **BUILD SUCCESSFUL** | `app-debug.apk`, **5,025,787 bytes** | +93,302 B | 11 m 40 s from cold, 243 tasks all executed |
| `./gradlew assembleRelease` | **BUILD SUCCESSFUL** | `app-release-unsigned.apk`, **3,890,405 bytes** | +38,132 B | 18 m 33 s, 316 of 323 executed |

**Three builds, and saying so precisely because the alternative is the quiet rounding
§1 exists to prevent.** Both configurations were built **from cold** at the wall clocks
above; both were rebuilt after §5.4's review fixes changed the Java (3 m 42 s for the
pair); both were rebuilt again after this branch was **rebased onto a `main` that had gained
#241** (4 m 40 s), and both were rebuilt a fourth time after §5.6's fixes changed the
bundled JS (17 m 40 s — slower than the 4 m 40 s incremental because the full test suite
was running concurrently on the same machine, which is worth noting only because #37
recorded a test flake under exactly that condition and **this run did not reproduce it**:
2,270 tests, 0 failures, under saturating Gradle load). `:app:lintVitalRelease` was
included every time. The byte counts are from that last pair — the tree this actually
lands as.

**So the "vs #37" column is no longer attributable to this change alone, and should not
be quoted as if it were.** The `webDir` grew from #37's **2.63 MB** to **2.73 MB** over
the same period, and only ~16 KB of that is `foray-audio-shell.js`; the rest is
`discover.json` and #241. The plugin's own contribution is its dex and its five merged
strings.

`assembleRelease` runs `lintVitalRelease`, the lint pass that can fail a release
build on its own, and it passed — **including `:foray-audio:lintVitalAnalyzeRelease`,
so the new module's sources were analysed, not skipped.** The APK is unsigned; there
is no keystore in this repo and no Play account, so that is the correct final
artefact of a build here. Signing is a founder action.

The bundle is now **2.71 MB of the 3.00 MB cap**, up from 2.63 MB. Only ~16 KB of
that is the shell script; the rest is `discover.json` growing since #37. The
headroom is thin and that is the cap doing its job.

### 4.2 The part a build alone does prove

Two things were read out of build output rather than assumed, and they are the
reason this is more than "it compiled":

- **The manifest merge landed.** `app/build/intermediates/merged_manifest/debug/…/AndroidManifest.xml`
  carries `<service android:name="com.jwincorporated.foray.audio.PlaybackKeepAliveService"
  android:exported="false" android:foregroundServiceType="mediaPlayback"
  android:stopWithTask="true" />` and both `FOREGROUND_SERVICE` and
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permissions. A library manifest that failed to
  merge would build silently and throw at runtime.
- **Both halves are in the APK.** `assets/capacitor.plugins.json` names
  `com.jwincorporated.foray.audio.ForayAudioPlugin`, and
  `assets/public/foray-audio-shell.js` is present. Capacitor derived that classpath
  by finding the `@CapacitorPlugin` annotation itself.

### 4.3 Two things about this machine, recorded because they cost time

- **The toolchain lives in `%TEMP%`.** JDK 21 and the Android SDK are at
  `C:/Users/wjduv/AppData/Local/Temp/mp1-android/{jdk21,sdk}` — MP1's spike
  downloaded them there and every Android build since has depended on it. There is
  no JDK in `Program Files`, nothing on `PATH`, and no `JAVA_HOME`. **A Windows temp
  cleanup deletes the ability to build this app**, and the only record of the path
  was a gitignored `local.properties` in an old worktree. Written down here so the
  next agent does not go looking for Android Studio.
- **`local.properties` still needs forward slashes**, and it is still gitignored, so
  every machine writes its own. Unchanged from #37, and still true.

## 5. The tests, and what they are worth

Three suites, all in `tools/mobile/` (dependency-free, so `tools/ci/run-suites.mjs`
discovers them in the root group). **65 tests in the two extended suites plus 35 new
ones; 22 mutations attempted, 22 caught.**

### 5.1 `shell-invariants.test.mjs` — invariant 6

The sixth invariant is *Android's hand-written native code is committed and the
generated platform is not*. Six tests, and two of them exist because of failures
this change actually had:

- **The gitignore's EFFECT, through `git check-ignore`, not its spelling.** See §7.
- **Every file the plugin needs is in the git index.** Without it, a re-broadened
  ignore rule takes the native code out of the repo while the machine that generated
  the platform still has the files on disk — so the build passes *there* and fails
  for everyone else.
- **The `@CapacitorPlugin(name = …)` matches the web half's `PLUGIN_NAME`.** If these
  disagree, nothing fails: the bridge answers *"ForayAudio does not have a method
  called start"* on a WebView console nobody is reading, the service is never
  started, and the app plays perfectly until the screen locks. Method names are
  derived from the Java's `@PluginMethod`s rather than listed.
- **The service is `mediaPlayback`, not exported, `stopWithTask`, with both
  permissions, and names a class that exists.**

### 5.2 `prepare-webdir.test.mjs` — the bundle's one non-copy

The shell script is copied into the bundle and **one** `<script type="module">` tag
is added to the bundle's **copy** of `index.html`, at the end of the head. That is
not the fork `prepare-webdir.mjs`'s header warns about — the fork hazard is two
copies of the same thing drifting — but it does mean the bundle's `index.html` is no
longer byte-identical to the site's, so: the tag is **derived** from
`SHELL_ONLY_FILES` rather than written out twice, the injection is **idempotent**,
and the result is **re-read off disk and asserted**. Without that last part a missed
injection is the worst shape available here — the app builds, installs, plays, and
loses background audio on a device weeks later.

The position is deliberate. Our CSP meta is on line 22 of `index.html` and the tag
lands at the end of the head, so `script-src 'self'` is genuinely what permits it.
Contrast Capacitor's own bridge, which inserts at `indexOf("<head>")` and parses
nineteen lines *before* the policy exists (`docs/android-shell-build.md` §2.2). Being
on the governed side of that line is the point.

### 5.3 `foray-audio-shell.test.mjs` — and the two bugs it found

57 tests against a fake bridge, a fake prototype and a fake clock. **It found two
real bugs in code that had already been read twice:**

1. A `playing` event reconciled but never put the element **back** in the active set
   — the preceding pause had pruned it out — so a stall recovering left the settle
   timer armed and **stopped the foreground service while audio was flowing**.
2. `reconcile()` had no `installed` guard, so an uninstalled shell kept calling
   native from events on elements it used to watch.

The test that matters most is *"A REFUSED PLAY NEVER STARTS THE SERVICE"*: an
autoplay-blocked `play()` leaves `paused === true` and fires no event at all, so
without the prune in `activeCount` the element sits in the active set for the rest of
the session and the notification never goes away.

**A third defect, found by re-reading rather than by a failing test.** Bridge calls
were not serialised, and Capacitor dispatches plugin calls on a thread pool — so the
`stop` at the end of a settle window and the `start` from a `play()` a few
milliseconds later could land **out of order**, leaving the service switched off
underneath live audio. That is the same symptom the plugin exists to prevent, arriving
from our own code. They now go through a promise chain, with an `inFlight` guard so
two `play()` calls before the first answer are one request.

**And one thing that turned out not to be a defect at all, recorded because being
wrong in public is cheaper than being wrong in private.** The same pass added
`serviceRunning = false` at stop-dispatch time under a comment calling it a bug fix,
on the reasoning that a `play()` in that window would hit `ensureStarted`'s `wanted &&
serviceRunning` guard and return early. **The mutation harness deleted the line and
every test stayed green — correctly**, because `wanted` already goes false at
dispatch and it is the first term of that guard. The line was removed rather than kept
with a truer comment. A surviving mutant is not always a missing test; sometimes it is
a mechanism that was never doing anything.

**Mutation results, in full: 23 mutations of the shell, 23 caught** — plus the one
above, which was removed instead. The two that would matter most on a device are
`activeCount`'s prune (20 tests fail) and the call-through ordering in the `play`
wrapper (40 fail).

### 5.4 And four more that only a human review pass found

Recorded at this length because the pattern behind all four is the point: **a fake
written from the same mental model as the code cannot falsify that model.** Every one
of these was green in a 41-test suite.

1. **The gate read a race, and it defeated the settle window.** `start()` reported
   `running` from a read taken immediately after `startForegroundService` — which only
   asks ActivityManager; the service's `onStartCommand` runs later on the main thread,
   so the field was **false on every first start**. `ensureStarted` gated on it, so its
   short-circuit could never fire and **every** `play()` re-issued a start — including
   the one on the far side of a hidden seam, which is a *background*
   `startForegroundService` and precisely the call §3.4's whole design exists to
   avoid. The fixture answered `running: true`, so the fake was the only place the code
   worked. Now: `start()` reports `started` (the request was accepted) and
   `alreadyRunning` (a truthful *pre*-call read); `stop()` reports `stopped` and
   `wasRunning`; **`state()` is the only method that answers "is it running"**, and it
   can because by the time anything calls it the main-thread dispatch has happened.
   `shell-invariants.test.mjs` now pins the exact field set of all three against the
   Java.
2. **A fatal media error never released the element.** Only the media *load* algorithm
   sets `paused = true` — which is what makes `emptied` and `abort` safe — so a decode
   or network error mid-playback leaves `paused === false` and `ended === false`. The
   service and its notification would have stayed up for the rest of the session with
   no audio: the exact leak the prune was written to prevent. `el.error` is now part of
   the test. `el.readyState === 0` was suggested with it and is **deliberately not**
   used — a brand-new element has `readyState 0` between `play()` and its first
   metadata, which is every seam's incoming element.
3. **The visibility net cancelled settle windows that were still counting.** It fired
   on any visible-and-silent transition, so foregrounding the app mid-seam disarmed a
   live window; backgrounding again before the seam's `play()` landed produced the
   refused background start the window exists to prevent. It now requires
   `now() - stopArmedAt >= settleMs`, which is exactly "this timer should already have
   fired" — the definition of frozen.
4. **`uninstall()` restored `play` blindly**, deleting any wrapper installed after ours
   — the mirror image of the "always call through" rule the file opens with.

**One instrument changed shape because of finding 1, and `HUMAN-ACTIONS.md`'s device
pass should use the new one.** `inspect()` now reports `startAccepted` (our request was
accepted) and `lastKnownRunning` (native's answer as of the last `refresh()`, `null`
until asked). The truthful reading is `await window.ForayAudioShell.refresh()` followed
by `window.ForayAudioShell.inspect()` — and `refresh()` is also the only thing that can
see a service that started and then failed its own `startForeground()`, which is the
API 34 service-type and permission failure mode.

### 5.6 A SECOND review pass, five more, and the same lesson twice

The pass that closed §5.4 was itself reviewed, against a 51-test suite and 21 caught
mutations. It found five more, and the fact that it did is the honest summary of what
a fake-driven suite is worth: **every one of these was green.**

1. **The in-flight marker was cleared by name, and an interleave defeated it.**
   `inFlight` held the bare method name, so with two `start` requests outstanding and a
   `stop` between them, start#1's clear link ran while the marker already belonged to
   start#2 and nulled it. start#2 was then in flight but unmarked, so the next `play()`
   queued a redundant third start. Hidden, Android 12+ refuses that, which clears the
   gate **while the service is actually up** — and from there every `play()` re-issues a
   refused start. **That is §5.4 finding 1's re-issue loop reached by a different
   route**, and its trigger is the exact seam sequence this design is built around. Now
   a monotonic token per call, cleared only on match.
2. **`lastKnownRunning` was cleared by a stop native reported as FAILED.** It read
   `wasRunning` — the truthful *pre*-call read, always present — instead of `stopped`, so
   a `stopService` that threw left the instrument saying the service was down while it
   and its notification were still up. The field claiming more than it knows, in the one
   place §6.4 points a device pass at.
3. **`uninstall()` stranded the foreground service.** It is on `window.ForayAudioShell`,
   which is what §6.4 tells a device pass to drive from `chrome://inspect` — and it left
   `wanted: true` with no JS path back, because the prototype is restored and no future
   `play()` reaches the shell. A diagnostic that leaks a foreground service for the life
   of the process is worse than no diagnostic.
4. **`acquire` mutated the active Set ahead of the `installed` guard**, so an event after
   `uninstall()` resurrected a discarded element into a Set nothing prunes any more.
5. **A tautological assertion**, and its own message named what it could not check:
   `assert.equal(r.total, sum(r.files.bytes))` — where `prepare()` *defines* `total` as
   that sum. The guarantee it was written for (sizes measured *after* the injection)
   survived its own deletion. Now checked against the source file's size and the bytes
   on disk, with the growth pinned to the injected tags' own length.

**And two of my own tests were vacuous in the same way, both caught by the harness
rather than by reading them.** The `inFlight` dedupe test and then the interleave test
above both asserted the dispatch list **while a call was still in flight** — where a
redundant call sits in the queue undispatched and therefore invisible. Draining the
queue first is the whole difference. It is worth naming twice because it is the specific
way an async fake lies: the bug is queued, the assertion is on what was sent.

### 5.5 One thing the review could not pin down, recorded rather than dropped

Against an intermediate state of this branch, `node --test` over the three
`tools/mobile` suites failed **3 of 15 runs** — once with 31 failures — with assertions
of the shape "the native call had not been dispatched yet". Every failing test passed
in isolation. It did not reproduce on the finished tree across ~20 runs including under
saturating CPU load, and the most likely cause is the exact defect fixed in between: a
`queue` link with no rejection handler, which silently stops all further dispatch for
the life of the shell. Written down because `npm test` runs the whole root group in one
`node --test` invocation, so if it resurfaces it will resurface as CI flake rather than
as a local failure — and because a flake that has been seen and not explained is worth
more on the page than in nobody's memory.

## 6. What is NOT done, and what is not known

### 6.1 Deliberately left for #27's Android half

> **BUILT SINCE, 2026-08-18 — `docs/android-lock-screen.md`.** The first two bullets
> are done and the section is left standing because its *reasoning* is what that change
> was built against. Two corrections to it, both worth reading:
>
> - **The `Player` adapter is a `SimpleBasePlayer` and this service did NOT become a
>   `MediaSessionService`.** Media3's service subclass owns the foreground lifecycle,
>   keyed to `player.isPlaying` — which is precisely the lifetime §3.4 argued out
>   between a 20 s floor and a 30 s ceiling. Handing a reviewed mechanism to a library
>   nothing here can execute was the wrong trade with no device.
> - **The service's lifetime DID change**, in the one way §3.4 predicted: it now lives
>   as long as **the transport can act on something** — playing or paused — rather than
>   as long as **audio is sounding**, because the `MediaSession` lives here and a pause
>   must not take the controls away 25 s later. That is fewer `startForegroundService`
>   calls, not more. (It said "a Foray is loaded" first, which held the service open
>   through a FINISHED Foray behind a notification with no buttons on it. That was a
>   blocking review finding — `docs/android-lock-screen.md` §5.5.)
>
> Everything in §6.2, §6.3 and §6.4 still holds, and **nothing about it has been
> executed on a device or an emulator** either.

- **Lock-screen and steering-wheel metadata and transport controls.** The
  notification says "Playback active" with a platform `ic_media_play` icon and no
  episode title, because the native side has no metadata: `mediaSession` is off, so
  metadata has to cross the bridge explicitly. The right shape is Media3
  `MediaSession` + a `Player` adapter over the WebView element, with this service
  becoming a `MediaSessionService`.
- **`POST_NOTIFICATIONS`.** Not declared and not requested. A foreground service
  still runs when the permission is denied — the notification is simply not shown —
  so the process-importance and audio-focus properties this service exists for do
  not depend on it. Requesting it means a runtime prompt and UI to justify, and the
  notification is only worth showing once it carries controls.
- **Audio focus.** Nothing here requests or abandons audio focus. Whether WebView
  requests it for a plain `<audio>` element is unestablished — §6.2.
- **iOS.** The plugin declares no `ios` platform, and that is not an omission: MP1
  §7.3 established that WebKit sets the `AVAudioSession` category itself for an
  audible `<audio>` element, so iOS's whole requirement is the `UIBackgroundModes`
  key `tools/mobile/inject-background-audio.mjs` already writes. Native iOS code
  here would have nothing to do.
- **A CI job. ADDED SINCE, by #245, and never run.**
  `.github/workflows/android-build.yml`: `ubuntu-latest`, no emulator,
  `setup-java` at 21, both APKs uploaded. It proves §4 keeps holding and **cannot**
  prove anything in §6 — a build is not a launch. Two of its assertions exist
  because of this document: §4.2's merged-manifest read is now a step rather than a
  thing done once by hand, and the `cap sync` wiring this file's whole argument
  rests on (`mobile/android/` is not committed, so nothing else can check it) is
  checked in both `capacitor.settings.gradle` and `app/capacitor.build.gradle`.
  See `docs/android-shell-build.md` §3. *(This item said the job was not added and
  pointed at a "§3.3" that has never existed; corrected 2026-08-19.)*

### 6.2 The open question this change does not settle

**Android 15's audio-focus rule, and it cuts both ways.** *"If an app targets Android
15 (API level 35) or higher, it cannot request audio focus unless it's the top app or
running a foreground service."* We target 36, so we are inside the rule from the
first build (measured, from the generated `variables.gradle`).

An FGS is exactly the exemption that rule names, so if WebView **does** request focus
for `<audio>`, this change is the fix. If it **does not**, the restriction cannot
deny us — but then our audio never ducks for a phone call and is not paused when
another media app takes over, which is its own defect and a *different* piece of
work. Both branches are real and **only a device tells you which one you are in.**

### 6.3 And the trap that must not be forgotten

**A foreground service does not fix the seam, and nothing here claims it does.**
Hidden-page throttling is on the media-load **task chain** and is keyed to
**visibility**, not audibility (MP1 §4.1a): a hidden load of a small **local bundled
file** measured 9–11 s, because each step of the HTML media load algorithm is a
queued task delivered ~3 s apart while hidden. An FGS does not make the page
visible. Local files and offline downloads do not help either. Different rules apply
to different things: media *loads* throttle by visibility; DOM timers and out-points
throttle by audibility and stay accurate while audio flows.

### 6.4 What would settle any of it

Unchanged from `docs/android-shell-build.md` §3 and MP1 §6.1, and now with more to
read: **a real phone over USB, off charger, app backgrounded and screen locked**,
across at least two cross-episode seams, `chrome://inspect` on the desktop. This
change adds two instruments worth using —

- `await window.ForayAudioShell.refresh()` then `window.ForayAudioShell.inspect()`.
  `refresh()` calls native's `state()`; `inspect()` then reports
  `{ installed, active, wanted, startAccepted, lastKnownRunning, lastReason,
  stopPending }`. **Read those two names literally** — `startAccepted` is *our request
  was accepted*, `lastKnownRunning` is *the service's own answer as of the last
  refresh*, and nothing reports "running now" without a `refresh()`. §5.4 finding 1 is
  why.
- `Capacitor.nativePromise("ForayAudio", "state", {})` asks native directly, so the two
  sides can be compared.

— and one thing to watch for: `adb shell dumpsys activity services com.jwincorporated.foray`
should show the service with `foregroundServiceType=mediaPlayback`. `HUMAN-ACTIONS.md`'s
Android device pass is the right home for that list.

## 8. The merge rule this document twice got wrong, stated once

Written out because six files in this repo asserted the wrong version of it, and
because the two words involved name **different sets**.

*(This section sits before §7 on purpose — it explains the premise §7's own
rationale used to rest on, and every reference to it elsewhere is by number, so
renumbering would cost more than the out-of-order spine does. The file already has
§5.6 before §5.5.)*

**`tools/ci/path-policy.mjs` is the authority.** `ALLOWED_PREFIXES` is:

```
data/  docs/  player/  tools/  test/  backend/test/
app.js  styles.css  search-engine.js  STATE.md  HUMAN-ACTIONS.md
```

- **Governed** means *on `DENIED_PREFIXES`* — `.github/`, `.claude/`, `CLAUDE.md`,
  `docs/DECISIONS.md`, `docs/adr/`, `docs/roles.md`,
  `docs/agents/routine-invariants.md`, `backend/src/`, `tools/ci/`,
  `tools/test-search.mjs`, `tools/validate-semantic-index.mjs`. A PR touching one
  is reported **UNAPPROVED** by the `path-policy` check, **which is enforcing and
  goes RED** — `PATH_POLICY_ENFORCE=1` was set on 2026-08-16, and this PR's own run
  printed `ENFORCE: 1`, `verdict: UNAPPROVED` and exit 1 for touching `CLAUDE.md`.
  A `founder-approved` label clears it.

  Two qualifications, and the first is the one that decides what the red actually
  costs. **`path-policy` is enforcing but not yet a *required* check on `main`** —
  that is the open half of `HUMAN-ACTIONS.md` #1, deliberately parked — so the red
  is loud rather than absolute; `backend` and `data-and-site` are the required
  ones. And `formatGovernedCheck()` says out loud that an agent with write access
  can apply the approval label, so it records a decision rather than locking
  anything.

  > **THIS BULLET WAS WRONG IN ITS FIRST VERSION AND THE ERROR IS THE POINT.** It
  > said the check was *"report-only until `PATH_POLICY_ENFORCE` is set, which
  > HUMAN-ACTIONS #1 is still open on"* — reasoned from `governedCheck()`'s
  > `enforce: false` default plus a half-read ticket, and never checked the live
  > repo variable. The variable had been set two days earlier, HUMAN-ACTIONS #1 says
  > *"Step 1 is already done"* in its own text, and the check went red on this very
  > change. **A default is not a setting and an open ticket is not a state**, which
  > is the same species of mistake as the premise this whole section exists to
  > correct.
- **`DENIED_PREFIXES` IS TESTED FIRST AND WINS.** `pathPolicy()` checks denied,
  `continue`s on a hit, and only then consults the allow-list — so `docs/adr/` and
  `tools/ci/` are governed even though `docs/` and `tools/` are allowlisted. Any
  sentence of the form "a PR touching only `docs/` is armed" is wrong for that
  reason.
- **Auto-mergeable** means *every changed file is on `ALLOWED_PREFIXES` and none is
  on `DENIED_PREFIXES`*.
- **A path on neither list is `unlisted`.** `path-policy` reports **CLEAN** — it is
  not governed, and nothing needs approving — and `automergeDecision()` returns
  `UNLISTED_PATH` with `needsFounder: true`, so **it waits for a human.**

**So "ungoverned" and "auto-mergeable" are different sets, and `mobile/` is in the
gap between them.** That gap is the whole reason this was got wrong: a `CLEAN`
path-policy check reads like permission to land, and it is not.

**And the decision is per-PR, all-or-nothing.** `automergeDecision()` arms only
when *"All N changed file(s) are allowlisted"*; its one-line `reason` names the
first unlisted file and its `findings` list accumulates **every** blocker, which
the module's own comment says was the point of replacing the bash that exited on
the first one. So there is no such thing as the `docs/` half of a PR merging while
the `mobile/` half waits. One unlisted file makes the whole PR wait, which is
exactly what happened to #271 and to #244 before it.

**What follows for an agent working here.** A PR touching `mobile/` will not land
on its own, so say in the PR body that it needs a human and stop — do not poll for
it (CLAUDE.md's "Never babysit your own PR"). And the review discipline does not
relax: a PR whose files are all allowlisted **and none of them denied** is armed and
lands the moment checks go green, so the reviewer pass belongs before `git push`,
not before merge. ("The moment checks go green" is modulo `automergeDecision()`'s
other gates, which are worth knowing before relying on either outcome: a draft, a
base that is not `main`, the `AUTOMERGE_FREEZE` kill switch, a `hold` or
`founder-decision` label, and a truncated changed-file list each keep it unarmed.)

## 7. Two gitignore failures, and they are the same failure twice

`mobile/.gitignore` said `android/`, with no leading slash. **An unanchored gitignore
pattern matches a directory of that name at any depth**, so it ignored
`mobile/plugins/foray-audio/android/` — this repo's own hand-written native code —
and `git add mobile/plugins` staged the `package.json` and the web half while
**dropping every `.java` file, the `build.gradle` and the manifest**, with no
warning.

It was caught by noticing four files missing from `git status`, which is luckier than
it should have been. A reviewer would have seen a plugin with no native code in it,
and the build on the machine that generated the platform **would still have
passed**, because the untracked files were sitting right there on disk. Both platform
lines are now `/android/` and `/ios/`, which is what they always meant — the
*generated platform*, which `capacitor.config.json` names exactly — and the invariant
is asserted through `git check-ignore` rather than by grepping the file, because a
rule's spelling is not the invariant, its effect is.

**And then the same class of mistake in the other direction, an hour later.** The
plugin's `android/` **is** a Gradle library module, so Gradle writes a `build/` tree
into it — and none of `mobile/.gitignore`'s `android/build/`-style rules cover it,
because *a gitignore pattern containing a slash is anchored to the `.gitignore`'s own
directory*, so `android/build/` means `mobile/android/build/` and nothing else. The
first `git add -A` after a release build died with:

```
error: open("mobile/plugins/foray-audio/android/build/.transforms/2118c5f6…/
  transformed/bundleLibRuntimeToDirRelease/…/PlaybackKeepAliveService.dex"):
  Filename too long
```

**A shorter transform hash would have committed several hundred build artefacts into
a directory nobody reviews file-by-file.** (This sentence used to say "a directory
that auto-merges with no review window", which is the corrected premise in §0 —
`mobile/` is not auto-mergeable. The hazard is unchanged: several hundred build
artefacts in a diff nobody reads closely is the same accident either way.) Windows'
path limit is the only reason that did not happen, which is not a control.
`plugins/*/android/build/`,
`.gradle/`, `.cxx/` and `local.properties` are now ignored, and the same
`check-ignore` test asserts all four — in the same test that asserts the plugin's
**sources** are not ignored, so the two halves cannot drift apart.

**The general lesson, since it caught two things in one change:** gitignore anchoring
is exactly backwards from the intuition. A pattern with **no** slash matches at any
depth; a pattern **with** a slash is anchored to the file's own directory. Adding a
second `android/` directory to `mobile/` walked into both halves of that in a single
afternoon.
