# The native app shell — architecture

Issue **#36** (MP2), part of **#34**. Reads on from
`docs/research/mp1-background-audio.md` (#35), which is what made this issue's
shape knowable.

Foray ships as a **Capacitor shell around the real web player**. The app loads the
same `index.html`, `app.js`, `styles.css` and `player/` the website serves —
copied at build time, never forked — plus the ~2.5 MB of `data/*.json` the client
actually fetches.

## 0. Status — what exists and what does not

| | State |
|---|---|
| `mobile/` project, config, ignore rules | **Committed** |
| `tools/mobile/prepare-webdir.mjs` (the `webDir` build) | **Committed and run.** 30 files, **2.52 MB** of a 3.00 MB cap |
| The four architecture changes (§2) | **Committed**, each with a test |
| `mobile/node_modules` | **Never installed.** The seven `@capacitor/*` versions were checked against the registry (all 8.x) but nothing was resolved locally |
| `mobile/ios/`, `mobile/android/` | **Not generated.** No `cap init`, no `cap add`, no `cap sync` has been run |
| Either platform built or launched | **No.** See §5 |

Nothing here has been compiled or put on a device. That is a hard limit of the
machine, not a to-do that was skipped, and §5 says exactly which claims are
therefore unverified.

## 1. The `ios/` question — resolved before anything was scaffolded

`ios/` already holds a SwiftUI app and the ForayKit Swift package, and
`CLAUDE.md` § Layout calls it *"SwiftUI app + ForayKit Swift package"*. Capacitor
generates its iOS project at `ios/` **by default**. So the first real question was
not how to scaffold, but whether scaffolding creates a second iOS codebase.

**Verdict: the shell and `ios/` sit side by side. `ios/` does not move, is not
deleted, and is not the host for the web player. There is exactly one iOS target
that ships, and it is the shell.**

Three findings, in the order that settles it.

**The SwiftUI app is not the better host.** None of it has ever been compiled —
`ios/README.md` says so in its first line, and ten `// AUDIT:` items mark the
AVFoundation code as unverified. More decisively, its player layer is now a
*stale second copy* of code that is live and tested in JavaScript:
`player/queue-state.js` is a direct port of
`ios/ForayKit/Sources/ForayKit/PlayerQueueState.swift`, and the port is the copy
that is right — it found **two real bugs** in the Swift (a skip writing the
outgoing episode's playhead under the incoming episode's id, and prev-track
resuming instead of restarting; #50, AUDIT item 9). The JS file's own header
already says *"change it there too (or retire the Swift — see #28)"*. On top of
that, the segment machinery the product depends on — `foray-resolve`,
`foray-queue`, `seam-gap`, `seek-policy`, `html-audio-backend`, `durable-store` —
exists **only** in JavaScript, under twelve CI-gated suites. Hosting the web
player inside the SwiftUI app would mean hand-writing a `WKWebView` bridge, a
local asset scheme handler and an audio session: reimplementing Capacitor, less
well, to solve a background-audio problem MP1 showed costs **one `Info.plist`
line**.

**Capacitor does not replace it either.** `ios/ForayKit` is the only Swift in this
repo that CI actually compiles — `ios-kit` runs `swift test --package-path
ios/ForayKit` on a macOS runner — and it holds `IntentGrammar.swift`, the Tier-1
voice grammar, which has **no JavaScript equivalent anywhere in the repo**. It is
also the named design source for #28 (native audio backend) and #33. Deleting
tested work to tidy a directory name would be a straight loss.

**So the collision is mechanical, and the fix is mechanical.** `mobile/capacitor.config.json`
sets `ios.path` and `android.path` explicitly, and because the config lives in
`mobile/`, Capacitor generates into `mobile/ios/` and `mobile/android/`.
`tools/mobile/shell-invariants.test.mjs` fails if either path ever resolves onto
the repo's `ios/`, and separately fails if ForayKit's files stop existing.

**Why not move `ios/` to `ios-native-reference/`, which #36 recommends.** Moving
buys nothing that `ios.path` does not, and costs: `.github/workflows/ci.yml`'s
`ios-kit` path, `CLAUDE.md` § Layout, `ios/README.md`, and the references in #28
and #33 — three of which are auto-merge **denied** paths. The ambiguity #36 was
worried about is about *role*, and role is fixed by writing it down, which
`ios/README.md` now does. A rename would have been motion mistaken for clarity.

**What is genuinely still a founder call**, and is not decided here: whether the
Swift `PlayerQueueState`/`PlayerQueueManager` copies get **retired** now that the
JS port is canonical. That belongs to #28, which MP1 already re-scoped ("iOS half
can lag"). Until someone rules, the repo carries two copies of one state machine
and the JS one is authoritative.

## 2. The four architecture changes the scaffold forces

### 1. A build step — for the native bundle only

Capacitor bundles exactly one directory. Foray's web root **is** the repo root,
which also holds ~62 MB of pipeline inputs in `data/`
(`breadth-classification.json` 16 MB, `catalog-breadth.json` 12 MB, two 13 MB
`.gz` archives). The client fetches ~2.5 MB.

`tools/mobile/prepare-webdir.mjs` copies the shell, every non-test module in
`player/`, and only the data the client fetches, into `mobile/www`. It is
dependency-free, uses Node builtins only, and **fails** above 3 MB rather than
warning — that cap is the only thing between the bundle and the 16 MB
classification file.

Two properties worth naming:

- **The data list is derived from `app.js`, not written down.** #36 listed the
  files by hand and then said to verify the list against the `fetchJson` calls; a
  list that must be manually verified is a list that will drift, so the script
  reads the calls instead. Add a `fetchJson("data/new.json")` and the next bundle
  carries it.
- **The derivation cannot fail green.** A regex that stops matching would emit a
  bundle with no session document that is small, silent and under the cap. Fewer
  than six derived files is a hard error, and a derived file missing from disk is
  a hard error.

**The web path is unchanged.** No root dependency, no root build step, no change
to what GitHub Pages serves from `main`'s root. `shell-invariants` pins that: the
root `package.json` may declare no dependencies of any kind and exactly one
script.

### 2. The service worker must not register inside the shell

`sw.js` is cache-first for the shell. Inside the app the assets are already local
files, so it adds a stale-cache layer in front of local files for no benefit — and
it is the classic *"the app won't update"* bug: a shipped build would keep serving
its own cached bundle after a store update replaced it, with no error anywhere.

`app.js` now asks `shouldRegisterServiceWorker(window)`. It checks
`window.Capacitor.isNativePlatform()` first (the bridge is injected before page
scripts) and the `capacitor:`/`ionic:` origin second, as an independent net for
iOS.

It deliberately does **not** check the hostname. Capacitor's Android default
origin is `https://localhost`, so a "localhost" test would also kill the service
worker for anyone serving the real site from a local dev server — breaking a live
web behaviour to fix an app one.

Four tests execute the real `app.js` in four environments: web (registers), native
bridge (does not), `capacitor://` origin (does not), and a Capacitor bridge
reporting the *web* platform (registers). There is no single line whose deletion
leaves all four green.

### 3. CSP

The CSP is a `<meta>` tag, so it applies identically in the shell — which is
precisely why one directive was already wrong for iOS and nobody could have seen
it on the web.

- **`img-src` gained `'self'`.** This is the real fix. On the web the origin is
  `https://…`, so local icons match `https:`. In the iOS shell the origin is
  `capacitor://localhost` — a custom scheme, which WKWebView requires because you
  cannot register a handler for `https` — and the app's **own bundled icons**
  match neither `https:` nor `data:`. They would be blocked outright. Android's
  shell defaults to `https://localhost` and would never have shown it.
- **`media-src https:` was already there** (#24), contrary to #36's assumption
  that it still needed adding. It is now pinned by a test, because with
  `default-src 'none'` and no `media-src` every `<audio>` load is blocked and the
  player is simply dead.
- **`connect-src` was deliberately NOT widened.** #36 asks for
  `https://jw-incorporated.github.io`. Nothing fetches that origin: in the shell
  the data files are bundled, so `fetchJson` is same-origin and `'self'` covers
  it. That entry belongs to **#40**'s remote-refresh code, and should land with
  the code that needs it rather than sitting open in advance.
- `'unsafe-inline'` and `'unsafe-eval'` remain absent, and a test keeps them
  absent.

The last CSP test is mechanical rather than a fixed list: it pulls the local
`href`/`src` references out of the real `index.html` and checks that whichever
directive governs each one allows `'self'`. A future local image is covered
without anyone remembering.

### 4. A second package boundary, and what it protects

Capacitor brings `node_modules` and a CLI. The repo root is deliberately
dependency-free with no build step — that is what lets the keyless Action deploy
the static site from `main`'s root, and the root `package.json`'s own description
records it.

So **#36's own recommendation is not followed here.** It says the scaffold "puts a
`package.json` + `node_modules` at the repo root for the first time". It must not.
Everything Capacitor lives in `mobile/`, with its own `package.json`, reaching
*up* into the repo for the web files — the same pattern as `backend/` and
`tools/corpus/`. The root keeps no lockfile, no `node_modules`, no build script,
and `shell-invariants` asserts each of those separately.

One mechanical consequence: `tools/ci/run-suites.mjs` hard-errors on a
`package.json` that declares dependencies but no `test` script. `mobile/` is safe
because the runner only scans `player/`, `test/` and `tools/` — but that is why
the shell's suites live in `tools/mobile/` (dependency-free, root group) rather
than in `mobile/`, and why `mobile/package.json` carries a comment saying so.

## 3. Data: bundled, fetched, and what a cold first launch shows

**Bundled.** All nine files `app.js` fetches ship in the app: `session.json`,
`validated-links.json`, `taxonomy.json`, `discover.json`, `semantic-index.json`,
`item-tags.json`, `forays.json`, `segments.json`, `segment-sources.json`.
`discover.json` is 1.7 MB of the 2.52 MB total and is the file that will push the
cap.

**Not fetched, by design, for now.** Nothing in the shell re-fetches data from the
network. `sw.js`'s network-first-for-data policy does not apply, because the
service worker is not registered here at all (§2) — inside the shell, data is
simply local files.

**A cold first launch with no network shows a complete, working menu and cannot
play audio.** Specifically: the four cards, search, browse, playlists and the
Foray running orders all render from bundled data; the durable store (#204)
hydrates from `localStorage`/IndexedDB, which exist in both web views. Pressing
play fails, because episode audio comes from ~41 podcast CDNs over `https:` and we
never rehost or proxy it (product principle #3). That is the honest shape: the
*curation* is offline-complete, the *audio* is not, and #29 (downloads) is the
issue that changes it.

**The limitation to put in front of a founder before any store submission:
bundled data is frozen at build time.** A shipped app would show its build day's
session forever. `data/` is regenerated nightly and the web site picks that up
immediately; the app would not. This is exactly **#40**'s remaining half ("data
freshness"), whose web half landed in #204 — and it is the difference between a
demo and a daily product. `@capacitor/preferences` is installed for #40's native
storage tier, but nothing registers it yet.

## 4. Two footguns that are pinned rather than remembered

**Never set the Cordova preference `KeepRunning` to `false`.** MP1 traced it
through the installed `@capacitor/android` 8.5.0 source: `Bridge.java:457` reads
it (default `true`), and when false `MockCordovaWebViewImpl.setPaused(true)` calls
`webView.pauseTimers()`, which Android documents as process-global, *"not
restricted to just this WebView"*. Every JavaScript out-point in the app would
stop firing on every backgrounding — and audio would keep playing, so it would
look fine while delivering the wrong episode. A missed out-point has a **936.5 s
median overrun: 15.6 minutes**. Two tests guard it: one on the parsed config at
any depth, case-insensitively; one that walks `mobile/` for the Cordova-compat
`config.xml` files `cap add` will generate.

**Do not redesign the 2.0 s seam beat for backgrounding.** It is safe. The beat
pauses the element, which withdraws audibility, but both engines carry a far
longer grace window — 30 s on Chromium, 10 s on WebKit
(`docs/research/mp1-background-audio.md` §8). Measured, the beat stretches to
2.8–4.6 s in a hidden page: baggy, not broken.

## 5. What is blocked, and on what

Honest accounting of #36's acceptance criteria:

| Criterion | State |
|---|---|
| `prepare-webdir.mjs` produces a `webDir` under 3 MB, fails above it | **Met.** 30 files, 2.52 MB; both directions tested |
| Service worker off in the shell, on in the web | **Met**, four executed tests |
| App ID and the `ios/` decision recorded | **Met** — §1 here, and the app id is pinned by a test |
| Web deploy byte-for-byte unaffected | **Met in shape.** `index.html` gained one CSP token — a widening to same-origin. Nothing else the Action serves changed |
| `npx cap sync` succeeds for both platforms | **BLOCKED.** Never run. Needs `npm install` in `mobile/` and `cap add` |
| App loads in the Android emulator, no CSP violations | **BLOCKED.** MP1 already established this machine cannot get there: three cold API-36 x86_64 boots failed at ~35 minutes each, and Capacitor 8 needs JDK 21. Do not re-attempt without budgeting for it |
| iOS build | **BLOCKED on macOS.** Windows can *generate* the project; only a Mac (or #38's runner) can build it |

So: the shape, the guards and the bundle are done and checked. **Every claim about
a running app is unverified**, and the CSP change in particular is reasoned from
WebKit's scheme behaviour rather than observed — it needs one launch on a device
to confirm, which is the same device pass `HUMAN-ACTIONS.md` #11 already asks for.

## 6. What a founder has to do

Filed as `HUMAN-ACTIONS.md` items with exact steps. In brief:

1. **Rule on the app id** — `com.jwincorporated.foray` is pinned in the config and
   in a test. Permanent once published; a change after a store release means a new
   listing. Note `ios/project.yml` still says `com.wjduvall.foray`, which predates
   the org and belongs to the reference scaffold, not to the shell.
2. **On a Mac: generate and build the iOS project**, and add the one background
   line to `mobile/ios/App/App/Info.plist`:
   `UIBackgroundModes` → `audio`. That is the whole iOS background-audio
   requirement.
3. **Decide whether the bundled-data freeze (§3) blocks a store submission**, or
   whether #40 lands first.

`sw.js` also still needs its `foray-v5` bump — already `HUMAN-ACTIONS.md` **#9**,
from #204, and not re-raised here.
