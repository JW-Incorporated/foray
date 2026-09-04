# Mobile shell bundle — where the bytes are, what grows, and what to cut

**Status:** research, 2026-09-04. Recommendations only — nothing here is implemented.
**Asked for by:** the founder (CTO), after the bundle crossed the 2.5 MB alarm in
`tools/mobile/prepare-webdir.test.mjs` and the alarm was raised to 2.7 MB to buy
time (inside PR #467 itself). Companion to `docs/mobile-shell.md` §3, which this
supersedes on numbers.

Every number below is labelled **measured** (a command was run against the
checkout at `origin/main` = `88e2416`, and the command is named),
**verified** (a claim about code or a document, checked by reading the source
named), or **estimated/inferred** (arithmetic on measured numbers, an
extrapolation, or a platform fact not re-verified here). Nothing else.
Units: KB and "1,530 KB" are decimal (bytes ÷ 1,000); "MB" alone is binary
(bytes ÷ 1,048,576), because that is what `prepare-webdir.mjs` prints.

---

## 0. TL;DR for the founders

1. **The bundle is 2,625,084 bytes (2.50 MB) as CI measures it; 206 KB under the
   2.7 MB alarm, 521 KB under the 3 MB hard cap.** (Measured. On a Windows
   checkout the same bundle reads 2,672,143 bytes — 47 KB fatter — because
   `core.autocrlf=true` copies CRLF text into the bundle. Local alarms fire 47 KB
   earlier than CI's. STATE.md already records this.)

2. **The growth nobody had measured is the code, not the data.** Everyone has
   been watching `data/item-tags.json` (+4.7 KB/night, measured — the test
   comment's "~4 KB" is right). But the code half of the bundle went **109 KB →
   1,098 KB in 39 days: +25 KB/day**, five times item-tags' rate, and it is
   feature work, so it does not stop at night. **Up to 58% of those code bytes
   are comments and the formatting around them** (measured with a parser, not a
   regex). The bundle ships this repo's documentation to every phone.

3. **At the measured combined rate the 2.7 MB alarm is ~7–9 days away and the 3 MB
   cap ~17–22 days away** (inferred by extrapolating the trailing 11-day and
   39-day rates; feature velocity is not a constant, so treat this as "weeks",
   not a date). The "~75 nights" the raised alarm's comment promises counts
   item-tags alone.

4. **There is no unreachable content this time.** Every one of the 40 files has a
   live reader; the `player/` import graph is fully connected; a scan of
   `app.js`'s 209 top-level functions found none that is referenced only at its
   definition. The #327-class "pure waste" win does not exist today.

5. **Stripping comments and whitespace from the shipped JS/CSS — names kept, no
   mangling — saves 794 KB (72% of the code half) with zero user cost, and it
   bends the steepest growth curve by the same 72%.** That is the single action
   to take if only one is taken. Minifying the JSON whitespace is the second:
   **301 KB**, zero user cost, one line of build script. Together they take the
   bundle from 2.50 MB to ~1.46 MB *and* cut the daily growth from ~30 KB to
   ~10 KB. Both need a founder decision about **where a minifier is allowed to
   live** (§6.3) — the repo root stays dependency-free either way.
   (Arithmetic on measured parts: 2,625 − 794 − 301 = 1,530 KB, i.e. 1.46 MB.)

6. **The df sidecar is real but smaller than the file it protects.** Trimming
   `item-tags.json` to the bundled pool saves 168–241 KB; the sidecar that keeps
   search identical for the vocabulary costs 23 KB. One thing the refusal's
   comments do not say: the app's search **already** differs from the web's on
   the *other* df — the discover slice moves one vocabulary term (`comedy`)
   across the "too broad to anchor" line (measured, §8.3), so the parity being
   guarded is already imperfect, if only slightly. Whether 12 more terms matter
   is a product call for the founders, not a bytes call.

7. **3 MB is arbitrary.** It comes from issue #36's *"assert the output is under
   ~3 MB"*, written as a tripwire so a 12–16 MB pipeline input could never land in
   the bundle by accident. It is not an App Store rule, not a cellular rule, and
   not a `DECISIONS.md` ruling on user experience. The measured `App.app` is
   8.3 MB; Apple's cellular-download prompt is at 200 MB (platform figure, not
   re-verified). §11.

---

## 1. How this was measured

```
cd mobile && npm run prepare:webdir            # no npm install needed: the script is Node builtins only
# -> webDir ready: mobile\www  (40 files, 2.55 MB of 3.00 MB)   <- Windows, CRLF
```

Then, over `mobile/www/`: raw `fs.statSync().size` per file (which is exactly
what `MAX_BYTES` sums), the same file with `\r\n` → `\n` (what CI and the macOS
build see), gzip -9, and brotli. Growth: `git log --first-parent origin/main`
per file with `git cat-file -s` at each commit (git blobs are LF, so growth
numbers are CI bytes). Comment ratio: `esbuild.transformSync` with no minify
flags (strips comments only) and with `minifyWhitespace` (comments + whitespace,
identifiers untouched), run in a scratch directory — **esbuild was not added to
the repo**. Reachability: the `import` graph under `player/`, the
`href`/`src` references in `index.html`, and a reference scan of every
`function name(` / `const name = (…) =>` at column 0 in `app.js` against the
comment-stripped source of every shipped file.

Where a measurement was taken on the Windows checkout it says so; every other
byte count is LF.

## 2. The bundle today, biggest first

40 files, **2,625,084 bytes LF / 2,672,143 CRLF**. (Measured.)

| bytes (LF) | gzip -9 | file | how it gets in |
|---:|---:|---|---|
| 744,740 | 174,532 | `data/discover.json` | **sliced** — `BUNDLED_ITEMS_PER_SHOW`=3 of 221 shows + topic top-up: 666 of 1,946 items |
| 368,987 | 76,639 | `data/item-tags.json` | **copied whole**, asserted byte-identical (`COPIED_WHOLE`) |
| 247,836 | 85,028 | `app.js` | copied whole |
| 105,237 | 39,805 | `search-engine.js` | copied whole |
| 104,277 | 35,762 | `player/html-audio-backend.js` | copied (every non-test `player/*.js`) |
| 100,295 | 25,798 | `data/catalog-client.json` | copied whole; already a client projection of `catalog.json` (`tools/build-catalog-client.mjs`) |
| 87,266 | 30,404 | `player/client.js` | copied |
| 69,813 | 23,944 | `player/queue-manager.js` | copied |
| 61,184 | 18,238 | `styles.css` | copied whole |
| 58,507 | 10,371 | `data/semantic-index.json` | copied whole |
| 57,937 | 12,172 | `data/segments.json` | **sliced** — the 57 segments the bundled Forays reference (#327) |
| 51,176 | 18,604 | `player/diagnostic-log.js` | copied |
| 48,065 | 46,819 | `icon-512.png` | copied; **reachable** — lock-screen fallback artwork (`foray-media-session.js`, `player/media-session.js`) |
| 46,230 | 5,014 | `data/taxonomy.json` | copied whole |
| 44,926 | 15,717 | `foray-audio-shell.js` | shell-only (`SHELL_ONLY_FILES`) |
| 44,249 | 15,016 | `foray-media-session.js` | shell-only |
| 37,371 | 12,976 | `player/durable-store.js` | copied |
| 26,691 | 9,488 | `player/event-log.js` | copied |
| 27,201 | 10,255 | `player/media-session.js` | copied |
| 25,671 | 3,901 | `data/forays.json` | **copied whole** (it is the selector for the two segment slices) |
| 25,456 | 8,146 | `player/queue-state.js` | copied |
| 24,900 | 6,302 | `data/segment-sources.json` | **sliced** — the 19 episodes those segments play out of |
| 23,299 | 8,326 | `player/foray-resolve.js` | copied |
| 22,856 | 8,910 | `player/foray-queue.js` | copied |
| 22,924 | 6,654 | `data/session.json` | copied whole |
| 20,804 | 7,847 | `player/foray-progress.js` | copied |
| 20,537 | 8,153 | `player/segment-strip.js` | copied |
| 15,270 | 3,366 | `data/validated-links.json` | copied whole (reader: `app.js` `state.validated?.episodes?.[id]`) |
| 14,659 | 5,384 | `player/seek-policy.js` | copied |
| 12,118 | 5,293 | `player/playback-rate.js` | copied |
| 11,757 | 4,548 | `player/strip-scrub-gesture.js` | copied |
| 10,299 | 4,198 | `foray-tts.js` | shell-only |
| 9,299 | 9,106 | `icon-180.png` | copied; referenced by `index.html` (`apple-touch-icon`, favicon) |
| 8,091 | 3,111 | `player/foray-sources.js` | copied |
| 7,170 | 3,118 | `player/seam-gap.js` | copied |
| 6,757 | 2,782 | `player/idb-tier.js` | copied |
| 4,381 | 1,893 | `player/position-store.js` | copied |
| 3,902 | 1,752 | `index.html` | copied, then the three shell `<script>` tags are injected |
| 2,537 | 1,254 | `player/queue-strategy.js` | copied |
| 409 | 260 | `manifest.json` | copied; a PWA artefact the shell never uses, but 409 bytes |

By category (measured, LF):

| half | bytes | share | gzip -9 |
|---|---:|---:|---:|
| `data/` (10 files) | 1,465,461 | 55.8% | 324,749 |
| `player/` (20 files) | 584,217 | 22.3% | 210,198 |
| root code (`app.js`, `search-engine.js`, `styles.css`, `index.html`) | 418,159 | 15.9% | 144,823 |
| shell-only (3 files) | 99,474 | 3.8% | 34,931 |
| icons + manifest | 57,773 | 2.2% | 56,185 |
| **total** | **2,625,084** | | **770,886** (brotli: 617,250) |

**Against `docs/mobile-shell.md` §3's table** (post-#327): `discover.json`
slice 704.6 → 744.7 KB (221 shows, 666 items), `item-tags.json` 329 → 369 KB,
`segments.json` slice 41 → 58 KB, `segment-sources.json` 15 → 25 KB, and
`data/catalog-client.json` (100 KB, added 2026-08-31 for show pages) is new and
not in that table. 36 → 40 files, `data/catalog-client.json` and
`foray-tts.js` among the additions.

## 3. What grows, at what rate, driven by what

All rates measured from `origin/main` history (LF bytes). "Trailing 30d" is the
size 30 days before the latest commit to the file against the latest.

| file / group | 2026-07-27 | 2026-08-17 | 2026-09-04 | trailing rate | driver | bounded? |
|---|---:|---:|---:|---:|---|---|
| `data/item-tags.json` | 199 KB | 291 KB | 369 KB | **+4,697 B/day** (30d) | nightly tagger, O(episodes) | **no** — the one unbounded data file, as the test says |
| `data/discover.json` (slice) | — | 705 KB (08-23) | 745 KB | ~+3.3 KB per new show, 213 → 221 shows since 07-13 | new *shows*, not episodes | yes, O(shows × topics); 800 KB budget |
| `data/segments.json` + `segment-sources.json` (slices) | — | 56 KB | 83 KB | per Foray authored | authored Forays | yes, O(Forays) |
| `data/taxonomy.json` | 34 KB | 46 KB | 46 KB | +331 B/day, then flat since 08-16 | taxonomy edits | yes |
| `data/catalog-client.json` | — | — | 100 KB | one commit | show-page build | O(shows); grows with Stage 3b RSS ingestion (see STATE.md) |
| `semantic-index`, `session`, `validated-links`, `forays` | flat | flat | flat | ~0 | — | yes |
| **`app.js`** | 26 KB | 118 KB | 248 KB | **+6,182 B/day** (35d) | feature work | **no** |
| **`search-engine.js`** | 22 KB | 30 KB | 105 KB | **+2,035 B/day** (41d) | feature work | **no** |
| **`styles.css`** | 9 KB | 32 KB | 61 KB | **+1,383 B/day** (35d) | feature work | **no** |
| **`player/*.js`** (non-test) | 53 KB | 395 KB | 584 KB | **+13.6 KB/day** (39d) | feature work | **no** |
| shell-only `*.js` | 0 | 30 KB | 99 KB | flat since 08-31 | plugin web halves | bounded by plugin count |
| **code half, total** | **109 KB** | **606 KB** | **1,098 KB** | **+25.4 KB/day** (39d); +19.4 KB/day (last 11d) | | **no** |

Three things this table says that the existing comments do not:

- **`data/item-tags.json` is not "the one deliberately-unbounded thing left."**
  It is the one unbounded *data* file. The code half has grown 5× faster over
  the same window and nothing in `prepare-webdir.test.mjs` denominates an alarm
  in it — the "data half" alarm (B, 1.5 MB) can only see `data/`, and the total
  alarm (A) cannot say which half moved, which is the same blindness #328
  exploited.
- **The code growth is mostly prose.** Measured on today's files (§6.1):
  comments and formatting are 58% of the code half's bytes, and 77–81% of two
  of the largest files (`search-engine.js`, `foray-audio-shell.js`). The repo's
  commenting culture is a strength in git and a cost on a
  phone; those are different places.
- **Extrapolation (inferred, not measured):** item-tags alone reaches the 2.7 MB
  alarm in ~44 nights from CI's 2,625 KB, close to the "~75 nights" the alarm's
  comment states from its own baseline. Item-tags *plus* the trailing code rate
  reaches it in **~7–9 days** and the 3 MB cap in **~17–22 days**. Feature
  velocity varies; the direction does not.

## 4. Reachability — is anything bundled that the app cannot use?

Checked, and **no**. (Measured.)

- **Every `data/*.json` has a reader.** `session.json` (`state.session`,
  12 sites), `validated-links.json` (`state.validated`, `app.js:408`),
  `taxonomy.json`, `discover.json`, `semantic-index.json` and `item-tags.json`
  (`state._searchCtx`, `app.js:808` → `search-engine.js`), `forays.json`,
  `segments.json`, `segment-sources.json` (`renderForay` → `player/client.js`
  `resolve()`), `catalog-client.json` (`state.catalog`, `#/show/:id`).
- **Every `player/*.js` is on the import graph from `player/client.js`**, which
  `index.html` loads. No orphan module.
- **`icon-512.png` is reachable**: `foray-media-session.js:57` and
  `player/media-session.js` name it as the lock-screen artwork fallback. Not
  waste. `manifest.json` is a PWA artefact the shell never reads, and it is 409
  bytes.
- **`app.js` has no dead top-level function** by the reference scan (209 names,
  0 referenced only at their own definition). This is a heuristic — it cannot
  see a function that is *called* only from a dead branch — but the #327 shape
  (a whole file most of which nothing can name) is absent.
- **Inside the `discover.json` slice**, every item is reachable: the four cards
  draw from the pool, `#/subject/<topic>` lists a topic's items, and search runs
  over `discover.items`. Whether 666 items is the *right* depth is a product
  question (§9, option D), not a reachability one.

So the class of win #327 found — 160 KB of pool the app could not play — is not
available. Every reduction below either changes bytes-per-thing (encoding) or
things-per-bundle (product).

## 5. The `df sidecar`

**What it is.** `search-engine.js`'s `tagDF(term)` is `tagCount(term) / (number
of entries in item-tags)`, and `tagCount` walks the *whole* tag map through the
shared matcher (`tagSegmentIndex`, candidate forms, `hitTag`). Three thresholds
read the fraction — `TAG_DF_TOO_BROAD` 0.10, `TAG_DF_COMMON` 0.02, `TAG_DF_RARE`
0.008 — to drop / down-weight expansion terms and to pick a score multiplier.
Trimming the map to the bundled pool changes the *sample* the fraction is taken
over, and the existing real-repo test measures the effect: **12 vocabulary terms
change expansion bucket and 62 change score multiplier** (e.g. `comedy` 10.70% →
8.47%, `world-war` 2.95% → 1.69%). The sidecar is a build-time table of
`term → tagCount` over the *full* map, plus the full map's size, shipped beside
the trimmed map; the engine reads the table when present and computes when not.

**What it costs (measured):** for the 1,366 terms `tagDF` can be reached with
from the vocabulary (concept terms + `ALIASES`), a `{n, df:{term:fraction}}`
table is **23,058 bytes** minified. Both dfs (tag + corpus, §8.3) for the same
vocabulary: **46,736 bytes**.

**What it saves (measured):** `item-tags.json` 368,987 → trimmed to the bundled
pool (666 slice items + 27 session episodes = 693 entries) **127,990 bytes**
pretty-printed, **89,179 minified**. Net of the 23 KB sidecar: **−218 KB** today
(pretty) or **−146 KB** after JSON minification (§7). Structurally it ends the
last O(episodes) file: item-tags becomes O(slice) and the nightly adds ~0 bytes.

**What it cannot do, and this is the part the existing comments miss:**
`tagDF` is also called on the *typed query token itself* (`search-engine.js:865`,
`df: tagDF(tok, ctx)`), and typed tokens are unbounded, so no finite sidecar is
exact for them; out-of-vocabulary tokens would fall back to the trimmed map.
And **the app already diverges from the web on the other df** — §8.3.

**Effort:** small-to-medium. A build-time table in `prepare-webdir.mjs` (the
engine's own exported `tagCount` can produce it, so it cannot drift), a
`PROJECTED_DATA` entry replacing the `COPIED_WHOLE` one, ~20 lines in
`search-engine.js` to prefer the table, and the real-repo test flips from
"trimming still re-ranks" to "trimming with the table re-ranks nothing in the
vocabulary". Testable in Node without a Mac. Risk: the "don't swap `itemTags` on
a used ctx" contract in `search-engine.js` now has a second document to honour.

## 6. The code half

### 6.1 How much of it is comments (measured)

`esbuild.transformSync` with no minify options strips comments and normalises
formatting; `minifyWhitespace` additionally removes whitespace but **keeps every
identifier**; `minify` also mangles local names and compresses syntax.

| file | LF bytes | comments stripped | comments + whitespace | full minify |
|---|---:|---:|---:|---:|
| `app.js` | 247,836 | 114,724 (−54%) | — | 84,896 (−66%) |
| `search-engine.js` | 105,237 | 19,887 (**−81%**) | — | 11,419 (−89%) |
| `player/html-audio-backend.js` | 104,277 | 42,684 (−59%) | — | 16,124 (−85%) |
| `player/client.js` | 87,266 | 43,467 (−50%) | — | 17,860 (−80%) |
| `player/queue-manager.js` | 69,813 | 40,160 (−42%) | — | 13,918 (−80%) |
| `styles.css` | 61,184 | 35,156 (−43%) | — | 28,525 (−53%) |
| `foray-audio-shell.js` | 44,926 | 10,318 (**−77%**) | — | 4,815 (−89%) |
| `foray-media-session.js` | 44,249 | 15,436 (−65%) | — | 7,875 (−82%) |
| **all shipped JS + CSS** (26 files) | **1,097,948** | **458,024 (−58%)** | **303,669 (−72%)** | **256,572 (−77%)** |

So: comments (with the formatting esbuild normalises around them — an upper
bound on pure comment bytes) are **640 KB** of the bundle; comments plus all
whitespace are **794 KB**; full minification buys only a further 47 KB on top of that and costs
readable names in device diagnostics (`player/diagnostic-log.js` is a field
record precisely so that a founder in a car can copy a trace).
**Recommendation: comments + whitespace, identifiers kept.**

### 6.2 Dead code

None found at the top level of `app.js` (§4). Not re-scanned inside `player/`
at function granularity; those modules are unit-tested per export and the import
graph is complete, so the expected yield is small. Not pursued further.

### 6.3 The build-step constraint, confronted

CLAUDE.md "Layout": *the repo root stays dependency-free and no-build; a
directory that needs deps carries its own `package.json`.* `docs/mobile-shell.md`
§2.4 and `shell-invariants.test.mjs` pin it: root `package.json` declares no
dependencies and one script, no root lockfile, no root `node_modules`. That
constraint is what keeps the keyless Pages deploy a plain checkout of `main`.

**Nothing here proposes changing that.** The web keeps serving the commented
source from the root, exactly as now. What is proposed is a transform *inside
the mobile build*, which is already the one place in the repo with a build step
(`prepare-webdir.mjs` already writes derived files: three slices and an injected
`index.html`). The question is only **where the minifier package may live**,
and there are two honest answers:

- **(a) `tools/mobile/package.json` with `esbuild` as a devDependency and a
  `test` script ending in `node --test`.** `tools/ci/run-suites.mjs` already
  handles this shape — a directory with its own `package.json` + `test` script is
  installed and run in place (that is how `tools/corpus/` works) — so **CI would
  measure the bundle the way it ships**, and the real-repo alarms keep their
  meaning. Cost: `npm install` of esbuild (~10 MB of platform binary) in every
  CI run, a few seconds. This is the recommended placement.
- **(b) `mobile/package.json`** (already a dependency-bearing package, never
  installed by CI). `prepare-webdir.mjs` would resolve esbuild optionally and
  copy verbatim when absent. Cheaper, but CI would then measure an *unminified*
  bundle while the founder's Mac ships a minified one — the alarms would fire
  early rather than late, which is the safe direction, but they would no longer
  measure what ships. Not recommended for that reason.

A dependency-free comment stripper (regex) was considered and rejected: `//` and
`/*` inside template literals and regex literals make it unsafe without a
parser, and this repo has paid for "the fixture was more forgiving than the
thing" five times.

**The fork hazard, addressed.** `prepare-webdir.mjs`'s header forbids a second
copy of the player. A transformed copy is not that: one source, one rule, applied
at build time, output gitignored — the same argument the header already makes
for the slices and the injected script tag. What changes is that the bundle's
`app.js` is no longer byte-identical to the root's, so the invariant to assert
becomes *semantic* rather than byte identity (`node --check` on every output;
esbuild is deterministic so a round-trip test can pin it).

## 7. Compression, and what the cap actually counts

**`MAX_BYTES` counts raw on-disk bytes** — `fs.statSync().size` summed over
`written` in `prepare()`, after the slices and the injection. Nothing is
compressed. (Verified, by reading the code.)

**The shell serves raw bytes.** Capacitor iOS serves `capacitor://localhost`
through `WebViewAssetHandler.swift`, which does `Data(contentsOf: fileUrl)` and
sets only `Content-Type` and `Cache-Control: no-cache` — no `Content-Encoding`,
no special handling for `.gz` (read from the Capacitor source on GitHub,
2026-09-04; not exercised on a device here). Android's `WebViewLocalServer`
reads from APK assets the same way (platform knowledge, not re-verified).

**What "install size" means per platform (platform knowledge, labelled as such):**
iOS installs the `.app` uncompressed, so `webDir` bytes are `.app` bytes 1:1;
the App Store *download* is compressed. Android keeps the APK compressed on
device, and `.js`/`.json` assets are deflated in it, so Android's install cost
is closer to the gzip column (~771 KB for the whole bundle). Either way the
bundle is a minority of the app: `App.app` measured **8.3 MB** on the CI
simulator build (`docs/ios-ci.md`), of which this bundle is ~2.6 MB.

**Pre-compressing assets** (`data/*.json.gz` + `DecompressionStream("gzip")` in
`fetchJson`) would cut the data half from 1,465 KB to ~325 KB (**−1.14 MB,
measured as gzip -9 sizes; the runtime cost is estimated**). It is not
recommended now: it needs a shell-only branch in shared `fetchJson` (the web
would get gzip from Pages for free and must not fetch `.gz`), a fallback for
WebViews without `DecompressionStream` (Safari ≥ 16.4 per platform release
notes, not re-verified — and the shell's real minimum iOS is not pinned
anywhere I could find), a decode step on the cold
path before first paint, and it changes what `MAX_BYTES` measures. All of that
to relieve a cap that §11 argues is not the real constraint.

**The CRLF artefact, and a free 47 KB on Windows builds:** `prepare-webdir.mjs`
copies text files as checked out. With `core.autocrlf=true` the shipped text
files carry 47,059 bytes of `\r` between them (measured). Normalising to LF on copy makes the local
measurement equal CI's (so the local test stops going red 47 KB early) and
removes 47 KB from any bundle built on Windows. It saves nothing on the macOS CI
build, which is what ships.

## 8. `item-tags.json` and the search-parity question

### 8.1 Verified: it grows as stated

+4,697 B/day trailing 30 days; 82 KB (07-08) → 369 KB (09-03); 1,973 entries;
6.5 tags per entry. (Measured.)

### 8.2 The two cheap cuts that do not touch search at all

- JSON minification: 368,987 → 257,702 (**−111 KB**, −30%). Zero behaviour
  change; the file is parsed, never read by a human on a phone.
- Nothing else. Every entry is a real item; there is no field to drop.

### 8.3 The consistency the refusal protects is already gone on the other df

`search-engine.js` has *two* document-frequency measures. `tagDF` reads the tag
map (the refusal's subject). `corpusDF` reads **`ctx.discover.items`** — the
title/hook/topics/tags of every item in the discover pool — and gates
`BROAD_DF_THRESHOLD` (0.10, "this token is too generic to anchor a query") and
`THIN_ANCHOR_DF` (0.002, "this token is too rare to be outvoted"). In the app,
`state.discover` **is the slice**: 666 items, not 1,946.

Measured with the engine's own exported `corpusDF` over the full document and
over `discoverSlice()` of it, for the same 1,366-term vocabulary the item-tags
test uses, and then read against the gates in `interpretQuery`:

- **1 term crosses the *broad* line and changes behaviour: `comedy`, 12.1% →
  8.9%** — "too generic to anchor a query" on the web, an ordinary anchor in the
  app. (The same term the item-tags test names.) The `broad` gate at
  `search-engine.js:864` reads `corpusDF` for every token, so this is real.
- 132 further terms cross the *thin* line numerically, because the slice's
  granularity is 1/666 = 0.15% and the threshold is 0.2% — but for these terms
  the crossing is **inert**: `thin` is gated `!hasConceptExpansion && …`
  (line 869), and every term in this vocabulary has a concept expansion by
  construction, so the engine never reads it. (Verified by reading the gate; the
  first draft of this section counted them, and review caught it.)
- What the thin gate *does* govern is a typed token the taxonomy has **not**
  modelled. For those, the slice's 0.15% granularity means any rare word with
  one hit reads 0.15% (thin) in the app while four hits in 1,946 read 0.21%
  (not thin) on the web. That set is unbounded and was not measured; the
  mechanism is inferred from the numbers above.

So the parity the item-tags refusal protects is **already imperfect** — one
vocabulary term today, plus an unmeasured tail of rare typed words — rather
than intact. That is a smaller finding than "already gone", and it is stated
at that size: trimming `item-tags.json` without a sidecar would move 12 more
vocabulary terms across an expansion threshold (and 62 across a score
multiplier), against the 1 that already moved. Whether 1 is fine and 13 is not
is the founders' call; the bytes are in §9. A sidecar that restored parity for
the vocabulary would have to carry *both* tables (47 KB, measured) and still
could not cover typed out-of-vocabulary tokens (§5).

## 9. Ranked recommendations

**Rubric.** Score = (bytes saved × durability) ÷ (user cost + effort).
Durability: *structural* = changes the growth rate (worth every night from now
on); *one-off* = reclaimed once and refilled at the file's rate. User cost is
what a listener loses: pool depth, first paint, a feature, search parity.
Effort includes the review burden of touching a shared file and whether the
change can be tested without a Mac. Options with no user cost rank above options
with any, and are marked.

| # | action | bytes saved | durability | user cost | effort / risk | Mac-free test? |
|---|---|---:|---|---|---|---|
| **1** | **A. Strip comments + whitespace from shipped JS/CSS in the mobile build (identifiers kept)** | **794 KB measured** (1,098 → 304 KB) | **structural** — cuts the 25 KB/day code growth by ~72% | **none** | medium: a minifier dependency under `tools/mobile/` (§6.3a), a `node --check` + determinism test, the byte-identity invariants become semantic ones | yes |
| **2** | **B. Minify JSON whitespace in every bundled data file** | **301 KB measured** (1,465 → 1,140 KB LF; 326 KB on a Windows checkout, where re-serialising also drops the CRLF) | **structural** — every data file's growth rate falls by its whitespace share (item-tags −30%, discover −15%) | **none** | small: `serializeSlice` → `JSON.stringify(json)`; copied files re-serialised on the way through; `COPIED_WHOLE` asserts parse-equality instead of byte-equality; `docs/mobile-shell.md` numbers redone | yes |
| **3** | **C1. Trim `item-tags.json` to the bundled pool + ship the tag-df sidecar** | **218 KB measured** pretty (146 KB after B) net of the 23 KB table | **structural** — ends the last O(episodes) file | near-none: exact for the vocabulary; out-of-vocabulary typed tokens fall back to the trimmed map (§5) | small-medium: ~20 lines in `search-engine.js` + a `PROJECTED_DATA` entry; flips one real-repo test | yes |
| 3′ | C2. Trim `item-tags.json` without the sidecar | 241 KB measured pretty (168 KB after B) | structural | measured: 12 vocabulary terms change expansion bucket, 62 change multiplier — on top of the 1 the discover slice already moves (§8.3) | small; a founder ruling on search parity | yes |
| 4 | D. `BUNDLED_ITEMS_PER_SHOW` 3 → 2 | 220 KB measured pretty (188 KB after B); 3 → 1 saves 464 KB | structural for the per-show constant; the topic top-up and anchors stay | **real**: offline pool 666 → 471 items (→ 253 at 1); the trade #467's test comment declined to make when it raised the alarm instead | trivial — one constant; every guard holds at every value | yes |
| 5 | E. Drop `apple_episode_url` from bundled discover items; `appleLink()` rebuilds `…/id<collection>?i=<track>` | 86 KB measured in today's slice (~73 KB after B) | structural, proportional to the slice | small: the rebuilt link is the id form, not the slugged `…&uo=4` form the web opens — same destination, different string (measured: 0 of 1,946 identical) | small: a slice field filter + a test that `appleLink()` resolves for every bundled item; a product-adjacent copy change | yes |
| 6 | F. LF-normalise text on copy | 47 KB measured, Windows builds only — 0 on the macOS CI build that ships, which is why a zero-cost option sits this low | one-off | none | trivial | yes |
| 7 | G. Pre-compress data as `.gz` + `DecompressionStream` | ~1.14 MB measured (gzip) | structural | first-paint decode (estimated tens of ms), an iOS floor, a shell-only branch in shared code | medium-high; changes what the cap measures; **not recommended now** (§7) | partly — the WebView path needs a device |
| — | H. Redefine the alarms so the code half has one (§11) | 0 | governance | none | small | yes |

**Why this order.** A and B are the only two options with zero user cost *and*
structural durability, and A is 2.4× B's bytes on the half that is growing 5×
faster; B is smaller but nearly free, so it should land in the same PR or the
next one. C ranks third because it is structural and its user cost is either
nil (C1) or small and measured (C2: 12 terms, on top of 1 already moved); it is
not first because 146–241 KB is a fifth of A. F has no user cost but saves
nothing on the build that ships, so the "zero-cost first" rule does not lift it. D is the biggest *lever* per line of code and the only one that
costs listeners something they can feel, so it stays an emergency valve, not a
plan. E is real but small and touches copy the founders may care about. G is
large on paper and wrong in kind: it adds runtime machinery to satisfy a number
that §11 says is not a constraint.

**After A + B (inferred from the measured parts):** 2,625 − 794 − 301 =
~1,530 KB bundle (1.46 MB), growth ~10 KB/day (item-tags ~3.3 KB, code ~7 KB),
which puts the *existing* 2.7 MB alarm ~125 days out instead of ~8, without
touching pool depth. After A + B + C1: ~1,385 KB and ~7 KB/day, all of it
feature code.

**If only one action is possible: A.** It is the largest saving, it has no
user cost, and it is the only option that touches the half of the bundle that
is actually running away. Every other option leaves a +25 KB/day trend in place.

## 10. What to do first, concretely (for the implementing PR — not this one)

1. Founder ruling on §6.3 (a): may `tools/mobile/` carry a `package.json` with
   `esbuild` as a devDependency? (This is the "architecture/infra" class of
   decision; it changes what CI installs.)
2. A + B in one PR under `tools/mobile/`, with: `node --check` on every emitted
   JS, a determinism test (two builds byte-identical), parse-equality for every
   data file against its source, the real-repo alarms re-baselined *downward*
   (2.7 MB is meaningless at 1.4 MB — see §11 for what to replace them with),
   and `docs/mobile-shell.md` §3 + `docs/DECISIONS.md` updated.
3. C1 or C2 as its own PR after the founders read §8.3.

## 11. Is 3 MB the right cap?

**Where it comes from (verified — the text is quoted):** issue #36, the
Capacitor shell spec: *"Assert the output is under ~3 MB and fail loudly
otherwise; that guard is what stops the 12 MB catalogue silently landing in the
bundle."* and acceptance criterion *"produces a `webDir` under 3 MB … and fails
if it exceeds the cap."* `docs/DECISIONS.md` records the *derivation* of the file
list and, on 2026-08-18, the decision *not to raise or lower* the number — it
never records a reason for the number itself beyond #36's. No App Store rule,
no cellular rule, no measurement of a device is behind it.

**What the real constraints are:**

- *Apple's cellular-download prompt* is at 200 MB (platform knowledge, not
  re-verified today); the whole `App.app` measured 8.3 MB. The bundle could be
  ten times its size before any store-side threshold noticed.
- *Startup cost.* `init()` fetches and `JSON.parse`s all ten data files before
  first paint. That is the user-facing cost of data bytes in the shell, and it
  is proportional to raw bytes — but it is milliseconds at this size and it is
  not measured anywhere in the repo. If a cap is to mean something to a
  listener, this is the quantity to measure and cap.
- *The web's cellular fetch* of the same files (no service worker for data;
  `cache: "no-cache"`) is a real cost — but it is gzip'd by Pages (771 KB for
  everything) and it is the web's concern, not the bundle's.
- *A pipeline input getting in* — #36's actual worry — is a **per-file** hazard
  (`breadth-classification.json` is 16 MB on its own), and a total cap is a
  clumsy way to catch it: it fires on ordinary growth (the headroom alarms
  tripped on #328 and #467, and #274 found the hard cap 16 KB away) and it
  would *not* have fired on a 2 MB input landing in a 1 MB
  bundle.

**So: the number is arbitrary, and the shape is wrong for the failure it
exists to catch.** Two things worth saying to the founders:

1. **Keep a hard stop, but make it per-file and by cause.** *Any* `data/` file
   entering the plan without a `PROJECTED_DATA` or `COPIED_WHOLE` entry above,
   say, 256 KB is a hard error ("something got in that nobody chose" — exactly
   #36's sentence, made precise). This is the shape `PROJECTED_DATA.maxBytes`
   already has for the three sliced files; the proposal extends it to the
   *unlisted* case, which is the one #36 was afraid of. A total cap can then be
   generous (4 MB is as defensible as 3) because it is no longer the tripwire.
2. **Alarm on rate, not on level, for the two things that actually grow**: the
   code half and item-tags. A real-repo test that compares today's code-half
   bytes against a checked-in baseline and fails on more than, say, +15% in a
   single PR would have caught #467's 9 KB step *and* would have said which half
   moved — the one question the current total alarm cannot answer.

The honest summary for a non-coder: **3 MB is a smoke detector someone bolted to
the ceiling at a round number. It has gone off on cooking twice (#274's near
miss, #467) and once on something that was arguably a fire (#328's 160 KB of
unplayable pool) — and in that case it could not say which. Keep a detector;
move it to where the fire would start; and stop shipping ~640 KB of
documentation and formatting to phones.**

---

### Appendix — commands used (scratch only; nothing added to the repo)

- Bundle: `cd mobile && npm run prepare:webdir`; sizes via a 20-line Node
  script over `mobile/www` (raw / LF / gzip -9 / brotli).
- History: `git log --first-parent --format=%H,%cs origin/main -- <file>` +
  `git cat-file -s <sha>:<file>`; weekly `git ls-tree -r -l` sums for `player/`.
- Comments: `npm i esbuild@0.25.0` in a scratch dir; `transformSync` with `{}`,
  `{minifyWhitespace:true}`, `{minify:true}` per file.
- Slices: `import { discoverSlice, sliceBytes } from tools/mobile/prepare-webdir.mjs`
  at `perShow` 1–4; item-tags trim as in the existing real-repo test; sidecar
  sizes via the engine's exported `tagDF` / `corpusDF` over the 1,366-term
  vocabulary.
- Reachability: `player/` import graph by grep; `index.html` local refs;
  `app.js` top-level name reference scan against comment-stripped sources.
- Capacitor iOS serving: `ios/Capacitor/Capacitor/WebViewAssetHandler.swift` on
  `ionic-team/capacitor@main`, read 2026-09-04.
