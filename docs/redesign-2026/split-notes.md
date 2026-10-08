# Phase 0d — splitting app.js into per-screen scripts

Branch `redesign/p0-split`. Behaviour-preserving: no function body, string or
selector changed. The point is that later agents can rebuild screens in
parallel, each in its own file, without editing one 1 MB file.

## What it looks like now

`app.js` (about 6,500 lines) is the **core**: state, the storage shim, `esc` /
`safeUrl`, data loading, event logging and sync, playlists / queue / episode
snapshot state, the router and scroll memory, playback glue (`bindPlay`,
`startEpisodePlay`), keyboard chrome, and `init()`. Everything that renders or
binds one screen moved to `ui/*.js`, loaded by `index.html` with plain
`<script src>` tags, in this fixed order, directly after `app.js`:

| File | Owns |
|---|---|
| `ui/browse.js` | Shows index, category pages, All Shows page, browse tiles |
| `ui/create.js` | Create page (`#/create`) |
| `ui/delete-data.js` | Delete-my-data flow (remote + local deletion, its sheet) |
| `ui/diagnostics.js` | Diagnostics sheet; the Settings page's delete / diagnostics bindings |
| `ui/downloads.js` | Downloads glue, controls, Library downloads section |
| `ui/episode.js` | Episode page: description, chapters, timestamp seeks |
| `ui/foray-player.js` | Foray player surface: segment strip, transport, rate menu, `paintForay` |
| `ui/foray.js` | Foray page: rows, feedback sheet, credits, sources, `renderForay` |
| `ui/forays.js` | Forays directory page; Foray list, resume and ribbon rows |
| `ui/home.js` | Home: greeting, Jump back in, Forays / Playlists / Suggested rails |
| `ui/interests.js` | Tuning (ex-Interests, `#/interests`): three states per subject |
| `ui/library.js` | Library and Playlists list pages |
| `ui/onboarding.js` | First-run subject picks, personas, explainer, intro popup |
| `ui/playlist.js` | Playlist detail page |
| `ui/queue.js` | Up Next page: rows, reorder, drag, swipe |
| `ui/rows.js` | Shared episode-row components (`epRow`, archived / hidden rows) |
| `ui/search.js` | Search page: show / playlist / episode / Foray results and show-search caches |
| `ui/settings-dev.js` | Settings' Developer group: voice probe, engine override rows (was `ui/drawer-dev.js`) |
| `ui/settings.js` | The gear's Sheet, Settings, About, "What 4a does", appearance (`cp_theme`), the switches and the control host (replaces the drawer, `ui/drawer.js`) |
| `ui/sheets.js` | Sheet infrastructure: `openSheet`, focus, inert, slide motion, drag |
| `ui/show.js` | Show page: episode fetch + cache, similar shows, `renderShow` |
| `ui/tabbar.js` | Tab bar |
| `ui/voice-sheet.js` | Voice picker sheet |
| `ui/boot.js` | Starts `init()` and registers the service worker. **Must stay last.** |

They are classic scripts that share globals exactly as before. **Not ES
modules** (the CSP is `script-src 'self'`; same-origin files are fine).

## The rules that keep it working

1. **app.js loads first, `ui/boot.js` last.** `init()` used to be called from
   the middle of app.js; it now runs from `ui/boot.js` so every screen function
   exists before the first render. The service-worker registration tail moved
   with it, in its original order (after `init()`).
2. **Top-level code in a `ui/` file must be inert at load.** A `function`
   declaration in a later script is not hoisted into an earlier script, and a
   `const` in a later script is in its temporal dead zone. So: declarations are
   fine; a top-level statement may use app.js and files earlier in the order,
   never a later file. Function bodies are free to call anything (they run
   after everything has loaded). `window.ForaySheets` / `window.ForayNotes`
   exports sit in the file that declares what they export; `window.ForayNav`
   stays in app.js, so `announce()` (a one-line live-region helper `ForayNav`
   exposes) was kept in app.js too.
3. **A new screen file** needs: a `<script>` tag in index.html (before
   `ui/boot.js`), nothing else. `prepare-dist`, the deploy manifest and the
   native bundle plan derive `ui/*.js` from the directory, and `test/app-split.test.js`
   fails if the directory and the tags disagree.
4. **No name may be declared in two files** (`app-split.test.js` checks it).

## Tests

- `test/helpers/app-source.js` is the one place that knows the file list (it
  reads index.html's tags). `readAppSource()` returns app.js plus `ui/*.js`
  concatenated in load order (LF-normalised, one marker comment per file), and
  every source-scanning invariant (esc / safeUrl, no inline style, `cp_` keys,
  copy rules, legal citations, tap targets…) now reads that. `runAppSource(src,
  ctx)` runs it in a `node:vm` context **one script per file in order, the way
  the browser does**; a test that patches the source first (`src.replace(...)`)
  keeps working because the markers survive the patch.
- ~99 suites were switched by a scripted edit (direct reads, local `read()`
  helpers, `vm.runInContext(..., {filename: "app.js"})`), the rest by hand.
- `tools/ci/app-files.mjs` is the same thing for tools (`vouch-run.mjs`).
- New: `test/app-split.test.js` (tag/directory agreement, boot last, one
  `init()`, no duplicate declarations, each file parses, every shipping path
  lists the files, path-policy), floored in `suite-integrity`.

## Everything that lists app files, and what changed

`index.html` (script tags) · `tools/ci/generate-manifest.mjs` (`uiSources()` in
`listedFiles` and the stamp's git pathspecs, so the deploy id and manifest cover
`ui/`, which is what `sw.js` precaches and verifies) · `tools/web/prepare-dist.mjs`
· `tools/mobile/prepare-webdir.mjs` (`uiFiles()`, `appSourceText()` so the
data-file derivation scans every client file; the 3 MB bundle cap is unchanged
and still passes) · `vercel.json` (`/ui/*` revalidates like app.js) ·
`tools/ci/path-policy.mjs` (`ui/` on the allow-list, **this branch only**; test
added in `path-policy.test.mjs`) · workflows (`ui/**` path filters on the
android / iOS builds and the smoke job, `node --check` over `ui/*.js` in `ci.yml`,
`ui/boot.js` in the AAB content check).

`sw.js` needed no logic change. A fallen-back page document tags every
`<script src>` it contains (so `ui/*.js` are requested from the same generation);
the pin statement is still prepended to `app.js` only, which is the file that
reads it. A `ui/` file that has to fall back while `app.js` was live is handled
like `search-engine.js` already is: the page is told (`stale-shell`, no pin) and
shows the reload control.

## How the move was done (and proven)

Node scripts, no hand edits of the big file: parse app.js with acorn, assign
each top-level node (with its leading comments) to a file by the start-line
ranges above, write the files preserving relative order, then check. The
scripts live in `docs/redesign-2026/split-tools/` as `.txt` (they need
`npm i acorn acorn-walk` outside the tree and are one-shot).

Checks run: every top-level declaration of the original is in exactly one new
file (multiset of node texts equal: 924 nodes in, 924 out); no duplicate names;
a load-order pass over every top-level statement (direct and closure
references, flagged any reference to a later file: found `announce`, fixed);
`node --check` on every file; the full plan.

## Known soft spots

- Some files group by screen but hold shared helpers that other screens call
  at runtime (for example `showSearchFieldFocused` lives in `ui/browse.js`
  because it sits in that region; `ui/search.js` holds the show-search caches).
  Moving them again is free (cut and paste a function between scripts), it just
  was not needed for equivalence.
- This Windows checkout has CRLF files (`core.autocrlf=true`); the helper
  LF-normalises, matching Linux CI.
