# `mobile/` — the native app shell

Capacitor project for the iOS and Android apps (issue **#36**, MP2). Capacitor
core, CLI, `android` and `ios` are **8.5.0**; the four plugins version
independently of the core and resolve to 8.1.1 / 8.0.1 / 8.0.2 / 8.0.3, which is
why `package-lock.json` is committed (`docs/android-shell-build.md` §1.3). The
architecture, the reasoning, and the decisions are in
**[`docs/mobile-shell.md`](../docs/mobile-shell.md)** — read that first. This
file is the commands.

**Both platforms are generated on demand and neither is committed.** `mobile/ios/`
and `mobile/android/` are gitignored in full; `npm install && npm run add:android`
(or `add:ios`) rebuilds either from what *is* committed. **Android builds on
Windows and is proven to** — issue #37, `docs/android-shell-build.md`. iOS builds
on macOS and is proven to by #213's `ios-build` workflow, which generates the
project in the job rather than checking it out.

The reason not to commit them is no longer "nobody has compiled these": it is ~100
generated files with no reviewer, in a tree `cap add` rewrites — so every future
diff would ask a reviewer to tell a handful of hand-written files from the whole
generated tree. `mobile/.gitignore` carries the full argument.

**This paragraph used to end "in a directory that auto-merges with no post-merge
review window", and that was never true of `mobile/`** — it is not in
`ALLOWED_PREFIXES`, so a PR touching it waits for a human rather than landing on
green. See `docs/android-native-code.md` §8. The reason changed; the decision did
not.

## Why this is its own directory

The repo root is deliberately dependency-free with no build step — that is what
lets the keyless GitHub Action deploy the static site straight from `main`'s
root, and the root `package.json`'s own description says so. Capacitor brings
`node_modules` and a build. So it lives here, with its own `package.json`, and
reaches *up* into the repo for the web files. Same pattern as `tools/corpus/`
and `backend/`.

**The web deploy is untouched.** No root dependency, no root build step, no file
the Action serves is changed in shape. `index.html` gained one CSP token; that is
the only root-served file this touched, and it is a widening to same-origin.

## First time, on any machine

```bash
cd mobile
npm install
npm run prepare:webdir      # builds mobile/www from the repo root
```

`prepare:webdir` first runs `npm ci --prefix ../tools/mobile` (one devDependency,
esbuild, pinned — it lives there and not here or at the root; see
`docs/mobile-shell.md` §3.4), then `tools/mobile/prepare-webdir.mjs`, which
**copies** the real `index.html`, `app.js`, `search-engine.js`, `styles.css`, the
icons, `manifest.json`, every non-test module in `player/`, and only the
`data/*.json` the client actually fetches — stripping comments and whitespace from
the JS/CSS (every identifier kept, so stack traces still read) and indentation
from the JSON on the way in. What was a 2.6 MB bundle is **1.53 MB**; the
website keeps serving the commented source. There is no second copy of the player
in the repo, and `mobile/www/` is gitignored so there never will be.

## Generating the platforms

Android generates **and builds** on Windows; iOS generates anywhere but **builds
only on macOS**.

```bash
cd mobile
npm run add:android         # creates mobile/android
npm run add:ios             # creates mobile/ios
npm run sync                # rebuild webDir + cap sync, after any web change
```

**Do not commit either generated directory.** Both are gitignored; the argument
is in `mobile/.gitignore`, and `tools/mobile/shell-invariants.test.mjs` fails if
those ignore rules are relaxed without also narrowing what it skips.

## Building Android

Needs **JDK 21** — Capacitor 8 fails on JDK 17 with `invalid source release: 21`
— an Android SDK with platform **android-36** and build-tools **36.0.0**, and a
`local.properties` that uses **forward slashes**:

```bash
cd mobile/android
# sdk.dir MUST use forward slashes: it is a Java properties file, so C:\Users\…
# silently loses its backslashes.
echo 'sdk.dir=C:/path/to/android-sdk' > local.properties
JAVA_HOME=/path/to/jdk-21 ./gradlew assembleDebug      # app-debug.apk
JAVA_HOME=/path/to/jdk-21 ./gradlew assembleRelease    # app-release-unsigned.apk
```

Both were built for #37 on a cold Gradle cache; versions, sizes and timings are in
`docs/android-shell-build.md` §1. **Do not reach for the emulator** —
`docs/research/mp1-background-audio.md` §6.2 spent ~75 minutes across three cold
API-36 boots without reaching a usable framework. To settle anything about a
*running* app, use a phone over USB and `chrome://inspect`.

## The one line iOS needs, and the one line that would break everything

**Add to `mobile/ios/App/App/Info.plist` the moment it is generated:**

```xml
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

That is the *entire* iOS background-audio requirement — no plugin, no Swift, no
audio-session code. WebKit sets the `AVAudioSession` category to `MediaPlayback`
itself. Measured and sourced in `docs/research/mp1-background-audio.md` §7.

**Never set the Cordova preference `KeepRunning` to `false`.** It makes Capacitor
call `WebView.pauseTimers()`, which Android documents as process-global, and that
would stop every JavaScript out-point in the app from firing on every
backgrounding. A missed out-point is a **936.5 s median overrun** — 15.6 minutes
of the wrong episode. The default is `true` and is safe; the footgun is one
config key with a reassuring name. `tools/mobile/shell-invariants.test.mjs`
fails if anything in this repo sets it false.

## What is checked mechanically

`node --test tools/mobile/*.test.mjs`, and CI runs it via
`node tools/ci/run-suites.mjs`. Between them the suites pin: the `webDir` size cap
(**and the cap's own value** — it used to be compared only against itself) and its
derived file list, that the service worker is not registered in the shell but
still is on the web *and* on real mobile browsers, that `KeepRunning` is `true`
and not merely "not `false`", that no Capacitor config exists outside `mobile/`
and that nothing has generated into the repo's `ios/`, and that the repo root
stays dependency-free with no build step.

An adversarial review on 2026-08-17 defeated six of these in one edit each; the
header of `tools/mobile/shell-invariants.test.mjs` lists every hole and the test
that now closes it. Read that before relaxing anything.
