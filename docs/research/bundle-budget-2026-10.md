# Native bundle budget, 2026-10: what is in it and what can come out

Measured 2026-10-09 on `main` at 26ef5ab5 (after #1209), and identical at a4a7b643, with the step CI runs:
`node tools/mobile/prepare-webdir.mjs` on an LF checkout, with esbuild 0.28.2
whitespace-minifying JS and CSS and `JSON.stringify` re-serialising `data/*.json`.
The numbers are bytes on disk in `mobile/www`.

**Bundle: 2,750,852 B** (82 files). The 2.8 MB alarm (`prepare-webdir.test.mjs`
assertion A) is 2,936,013 B, and the `MAX_BYTES` hard cap is 3,145,728 B. This
work leaves every threshold as it is.

The brief was to find savings that change nothing a listener sees or hears and
that touch no UI file. `app.js`, `styles.css` and `index.html` are frozen for the
UI revamp. So every item below names the file it would have to change, and the
items that need a UI file are listed but not built.

## Where the bytes are

| Part | Bytes | Largest files |
|---|---:|---|
| `data/` | 1,559,744 | discover.json 667,848 (sliced) · show-index.tsv 444,121 · item-tags.json 124,908 (sliced) · catalog-client.json 109,238 · segments.json 40,962 · forays.json 37,533 · taxonomy.json 33,682 · semantic-index.json 32,852 · segment-sources.json 28,336 · session.json 21,888 · validated-links.json 13,352 · personas.json 4,531 |
| JS (minified) | 843,014 | app.js 334,063 · player/client.js 83,189 · player/diagnostic-log.js 62,760 · player/queue-manager.js 38,610 · player/engine-contract.js 27,893 · search-engine.js 23,278 · foray-media-session.js 19,374 |
| CSS (minified) | 68,136 | styles.css |
| fonts | 211,548 | fraunces-italic 81,520 · fraunces 67,304 · dm-sans 62,724 (already Latin subsets: 222 to 223 code points each) |
| images, html, other | 68,410 | icon-512.png 48,065 · index.html 10,612 · icon-180.png 9,299 |

## Ranked savings

"Safe" here means two things: nothing a listener sees or hears changes, and no UI
file changes. Items are ranked by bytes saved.

| # | Item | Bytes saved | Needs a UI file? | Risk | Status |
|---:|---|---:|---|---|---|
| 1 | Fetch `data/show-index.tsv` from the origin, not the bundle | 444,121 | yes (`app.js` `loadShowIndex`) | medium | not built |
| 2 | Mangle identifiers in the JS | 128,974 | no (`minify.mjs`) | policy | rejected |
| 3 | Derive `apple_episode_url` from the two ids | 90,171 | yes (`app.js`) | medium | not built |
| 4 | Take item artwork from the show record instead of repeating it | 80,835 | yes (`app.js`) | medium | not built |
| 5 | **Drop data keys that no shipped code reads** | **44,323** | no | low | **built: perf/bundle-trim-2** |
| 6 | Drop `audio_type`/`audio_bytes` from the discover slice | 32,617 | no | medium | not built |
| 7 | Syntax minification (`minifySyntax`) | 26,564 | no (`minify.mjs`) | policy | rejected |
| 8 | Bundle the player's import graph and tree-shake unused exports | 19,554 | no, but it changes the module layout | high | not built |
| 9 | Front-code the item-tags `df` term lists | 12,598 | yes (`search-engine.js` reader) | low | not built |
| 10 | **Stop shipping `player/` modules that nothing imports** | **12,647** | no | low | **built: perf/bundle-trim-1** |
| 11 | Drop the unread prose keys (`notes`) | ~3,500 | no | low | not built (guard cost) |
| 12 | Drop the unread top-level keys of `forays.json` | ~1,900 | no | medium | excluded |
| 13 | Drop `manifest.json` from the shell | 409 | `index.html` links it | low | not built |
| 14 | Recompress the PNG icons losslessly | ~0 | no | none | measured, nothing to gain |
| 15 | Strip JSON whitespace | 0 | no | none | already done (2026-09-04) |
| 16 | `BUNDLED_ITEMS_PER_SHOW` 3 to 2 | ~217,000 | no | the listener sees it | out of scope |

Items 5 and 10 together take the bundle from **2,750,852 B to 2,693,882 B**
(−56,970 B), all of it in `tools/`.

### 1. `data/show-index.tsv` (444,121 B): the largest single lever, and it needs `app.js`

The S-03 title index has 10,069 rows, and its parser (`search-engine.js`
`parseShowIndex`) reads all four columns, so there is no column to drop. The only
saving is to stop bundling the file. `app.js` would fetch it from `API_ORIGIN` on
the shell and keep the bundled copy as a fallback, or not bundle it at all.

Today a missing index is already a working state: `localShowMatches` falls back to
the curated 220 shows and the breadth endpoint still answers. So the cost would
fall on offline show search, which would see only those 220 shows. That is visible
to a listener, and the change is in `app.js`'s `loadShowIndex`, so it waits for the
UI freeze to end and for a product call on offline search.

A middle option is to ship the file gzipped (201 KB) and decode it with
`DecompressionStream`. That saves about 243 KB, but it is still an `app.js` change.

### 2. Identifier mangling (128,974 B) and 7. `minifySyntax` (26,564 B): rejected by policy

Both are a one-line change in `tools/mobile/minify.mjs` `MINIFY_OPTIONS`. Its
header refuses both, with reasons that still hold:

- A field record from `player/diagnostic-log.js` must still name the function that
  threw.
- "What runs on the device is the source with its prose removed, not a different
  program."

The measured figure for mangling is identifiers alone. Turning on both options
saves 162,045 B. This needs a founder decision; I have not built it.

### 3. `apple_episode_url` (90,171 B) and 4. repeated artwork (80,835 B): need `app.js`

In the discover slice, `apple_episode_url` is the largest field after `audio_url`
and `artwork_url`. It can be rebuilt from `apple_collection_id` and
`apple_track_id` (`https://podcasts.apple.com/podcast/id<c>?i=<t>`), but the
readers are in `app.js` (`episode()`, `snapshot()`, the link-out rows). The rebuilt
URL also drops Apple's slug: the link lands on the same page, but it is not the
same string.

80,835 B of the discover items' `artwork_url` values are byte-for-byte a
`catalog-client.json` show's `artwork_url`. Leaving them out needs an `app.js`
fallback to the show record. The join in `player/foray-sources.js` reads item
artwork too, and its slice guard would have to learn the fallback.

### 5. Data keys no shipped code reads (44,323 B): built, perf/bundle-trim-2

A key whose name appears nowhere in the JavaScript the bundle ships cannot be read
by that code. It also cannot be read by the native engines, which see only what JS
hands them. The candidates were checked against every shipped `.js` file
(`app.js`, `search-engine.js`, the shell-only scripts and every bundled
`player/*.js`) and against the native plugin sources. Every spread that forwards a
whole row was then followed:

- `player/foray-resolve.js` `hydrateForayItems` builds segment items from a
  whitelist.
- `app.js` `snapshot()` is a whitelist.
- `episode()`'s `{...ep}` forwards session episodes into that whitelist.
- `forays.json`'s `{...foray, items}` forwards every top-level key. Its unread keys
  (item 12) are therefore excluded.

| File | Keys dropped in the bundle | Bytes |
|---|---|---:|
| `segment-sources.json` | `provenance`; per source `feed_url`, `episode_guid`, `ad_free_ratio`, `audio_verified_on`, `ad_delta_sec`, `ad_delta_probes`, `ad_delta_spread_sec`, `ad_tier`, `ad_pad_method`, `ad_pad_measured_at`, `feed_declared_duration_sec`, `transcript_url`, `transcript_type`, `transcript_sha256` | 13,188 |
| `taxonomy.json` | `episode_attributes`; per node `apple_anchor`, `last_evidence_at` | 13,191 |
| `segments.json` | `provenance`; per segment `transcript_source`, `batch_id`, `needs_review` | 6,308 |
| `catalog-client.json` | per show `episode_count` | 4,616 |
| `session.json` | `commute`, `categories`; per card `archetype_label`, `fit_line`, `alternates`, `provenance`; per episode `format`, `reactor_types` | 3,749 |
| `validated-links.json` | `podlink_episode_format`, `podlink_note`, `overcast_ok`, `overcast_note`, `verification_summary`; per episode `episode_guid`, `duration_min_confirmed` | 2,529 |
| `discover.json` | per item `episode_guid` | 742 |

Two things are not affected:

- `ad_pad_sec`, the one ad field the player reads, is kept.
- The web keeps every key, and so do the Foray directory's whole files, which
  replace the seed on the first refresh that reaches the network.

The build fails if one of these key names starts appearing in shipped code, or as a
quoted string in the native plugin sources. So a future reader cannot be starved
silently. The fix is to take the key off the list.

### 6. `audio_type` / `audio_bytes` (32,617 B): not built

Their only reader is `app.js` `snapshot()`, which copies them into a snapshot that
nothing downstream reads by name. But snapshots persist, and some sync. A phone's
snapshot would then hold `null` where the website's holds a value. That is
invisible to a listener today, but it is a divergence in stored data, so it needs
an owner's call rather than a bundle PR.

### 8. Tree-shaking (19,554 B): not built

esbuild bundling `player/client.js`'s closure with tree-shaking comes to 412,931 B,
against 432,485 B for the 49 modules shipped separately. Getting that saving means
shipping one bundled module instead of 49 files. That collides with `index.html`'s
modulepreload list (a UI file, and pinned by `test/boot-path.test.js` perf-1) and
with the "one file in, one file out" rule in `minify.mjs`.

### 9. Front-coding the `df` block (12,598 B): needs `search-engine.js`

`df.by_count` is 34,585 B of sorted term lists. Front-coding them (shared-prefix
length plus suffix) makes them 21,987 B. The reader is `search-engine.js`
`readTagDfBlock`, which this brief does not cover.

### 10. Unimported `player/` modules (12,647 B): built, perf/bundle-trim-1

`playerFiles` copied every non-test `player/*.js`. The web has deployed only
`player/client.js`'s import closure (`playerSources`) since CH-07, and
`index.html` preloads exactly that list. Five modules rode along that no shipped
script imports:

| Module | Bytes |
|---|---:|
| `catalogue-directory.js` | 3,301 |
| `locate-window.js` | 3,201 |
| `route-resume.js` | 3,111 |
| `foray-structure.js` | 2,490 |
| `alert-open.js` | 544 |

The native parity harness reads the repo's `player/`, never the bundle. The bundle
now ships the web's list, so a module joins both by being imported.

### 11 to 16

- **11. Prose `notes` keys (~3,500 B).** The name `notes` appears in `app.js` as an
  ordinary variable, so the name-based guard from item 5 cannot clear it. A
  path-specific guard is worth more than the bytes it would save.
- **12. `forays.json` top-level keys (~1,900 B).** `label_prefixes`, `source_doc`,
  `spine_doc`, `beats_*` and `runtime_sec` are forwarded by a spread, and
  `runtime_sec` is read by the Swift parity harness. Excluded.
- **13. `manifest.json` (409 B).** `index.html` links it, and the shell never reads
  it.
- **14. PNG icons.** Re-deflating the IDAT at level 9 made `icon-512.png` 373 B
  larger (48,381 B against 48,008 B), and `icon-180.png` came out the same. Both
  are already tight. `icon-512.png` is also the lock-screen fallback artwork
  (`APP_ARTWORK_URL`), so it stays.
- **15. JSON whitespace.** Already compact since 2026-09-04 (`serializeSlice`).
- **16. Fewer items per show.** Lowering `BUNDLED_ITEMS_PER_SHOW` shrinks the
  offline catalogue pool, which a listener sees. It is out of this brief.

The fonts are already Latin subsets. Pinning the `opsz` axis or narrowing `wght`
would change how text renders, and the type is the UI revamp's to decide, so I
left them alone.
