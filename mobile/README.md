# `mobile/` — the native app shell

Capacitor project for the iOS and Android apps (issue **#36**, MP2, Capacitor
**8.5.0**). The
architecture, the reasoning, and the decisions are in
**[`docs/mobile-shell.md`](../docs/mobile-shell.md)** — read that first. This
file is the commands.

**Nothing here has been generated or built.** `mobile/ios/` and
`mobile/android/` do not exist yet, `node_modules/` has never been installed,
and no `cap` command has been run. That is deliberate, not unfinished: neither
platform can be *built* on the Windows machine this was written on, and
committing a few hundred generated native files that nobody has compiled is how
a scaffold starts telling lies. See § Generating the platforms.

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

`prepare:webdir` runs `tools/mobile/prepare-webdir.mjs`, which **copies** the
real `index.html`, `app.js`, `search-engine.js`, `styles.css`, the icons,
`manifest.json`, every non-test module in `player/`, and only the 2.1 MB of
`data/*.json` the client actually fetches (2.5 MB of bundle in total). There is no second copy of the player
in the repo, and `mobile/www/` is gitignored so there never will be.

## Generating the platforms

Android generates on Windows; iOS generates anywhere but **builds only on
macOS**.

```bash
cd mobile
npm run add:android         # creates mobile/android
npm run add:ios             # creates mobile/ios
npm run sync                # rebuild webDir + cap sync, after any web change
```

Commit both generated directories when they appear (Capacitor's own guidance —
they hold real configuration, and it keeps CI from needing a `cap add` step).
`.gitignore` here already covers what those projects *produce*.

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
