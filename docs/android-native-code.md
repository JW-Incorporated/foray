# Where Android's hand-written native code lives, and the foreground service that lives there

Part of **#27** (lock-screen and steering-wheel controls) and **#37** (the Android
build). Reads on from `docs/android-shell-build.md` and
`docs/research/mp1-background-audio.md` §5.

## 0. The blocker this resolves

**There was nowhere for native Android code to live.** `git ls-files` contained
**zero** `.kt` and **zero** `.java` files, and `mobile/android/` is gitignored in
full.

#37 was right to reject committing the generated platform — ~100 generated files
with no reviewer, in a directory that **auto-merges with no post-merge review
window** — and it made the same call for `mobile/ios/`. That decision is about
*generated output*, and it had a consequence nobody chose: **Android needs
hand-written native code and had no home for it.**

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
| Both APKs still build, with sizes and wall clock | **Executed on this machine.** §4 |
| The `<service>` and both `FOREGROUND_SERVICE*` permissions reach the app's merged manifest | **Executed** — read out of `app/build/intermediates/merged_manifest/…/AndroidManifest.xml` after `assembleDebug`. §4.2 |
| The web half's state machine — start on first play, stop after a settle window, survive a seam, self-correct a refused play | **Executed, against fakes.** 35 tests in Node, 12 mutations, 12 caught. §5.3. **No WebView ran.** |
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
generated files, auto-merging. That still holds. What this change adds is that
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
| `./gradlew assembleDebug` | **BUILD SUCCESSFUL** | `app-debug.apk`, **4,969,849 bytes** | +37,364 B | 11 m 40 s, 243 tasks all executed |
| `./gradlew assembleRelease` | **BUILD SUCCESSFUL** | `app-release-unsigned.apk`, **3,883,705 bytes** | +31,432 B | 18 m 33 s, 316 of 323 executed |

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

35 tests against a fake bridge, a fake prototype and a fake clock. **It found two
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
all 39 tests stayed green — correctly**, because `wanted` already goes false at
dispatch and it is the first term of that guard. The line was removed rather than kept
with a truer comment. A surviving mutant is not always a missing test; sometimes it is
a mechanism that was never doing anything.

**Mutation results, in full: 13 mutations of the shell, 13 caught** — plus the one
above, which was removed instead. The two that would matter most on a device are
`activeCount`'s prune (17 tests fail) and the call-through ordering in the `play`
wrapper (31 fail).

## 6. What is NOT done, and what is not known

### 6.1 Deliberately left for #27's Android half

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
- **A CI job.** `.github/` is governed and needs a founder label. The shape is in
  `docs/android-shell-build.md` §3.3 and is unchanged by this: `ubuntu-latest`, no
  emulator, `setup-java` at 21. It would prove §4 keeps holding and **cannot** prove
  anything in §6.

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

- `window.ForayAudioShell.inspect()` reports `{ installed, active, wanted,
  serviceRunning, lastReason, stopPending }`, so "the service is not running and here
  is the exception Android threw" is readable from the console rather than guessable.
- `ForayAudio.state()` answers the same question from the native side, so the two can
  be compared.

— and one thing to watch for: `adb shell dumpsys activity services com.jwincorporated.foray`
should show the service with `foregroundServiceType=mediaPlayback`. `HUMAN-ACTIONS.md`'s
Android device pass is the right home for that list.

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
a directory that auto-merges with no review window.** Windows' path limit is the only
reason that did not happen, which is not a control. `plugins/*/android/build/`,
`.gradle/`, `.cxx/` and `local.properties` are now ignored, and the same
`check-ignore` test asserts all four — in the same test that asserts the plugin's
**sources** are not ignored, so the two halves cannot drift apart.

**The general lesson, since it caught two things in one change:** gitignore anchoring
is exactly backwards from the intuition. A pattern with **no** slash matches at any
depth; a pattern **with** a slash is anchored to the file's own directory. Adding a
second `android/` directory to `mobile/` walked into both halves of that in a single
afternoon.
