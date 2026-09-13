# Hermes deck: Pocket Casts-style typeahead over 4a's own catalogue

**Status:** **the whole deck landed — S-01 (#576), S-02/S-03/S-04/S-05/S-07 (#657),
S-05's degraded header + S-06 + S-08 (#658)**, per-card **DONE** markers below, after
numbers in §1.7. Each card's own **Governance** line still names the human gates it
needed; `docs/DECISIONS.md` is not among the files #658 touched, so read G4 as still
open unless a DECISIONS entry says otherwise. (S-05, S-06 and S-08 carried no marker at all until
2026-09-12 — three cards that had landed still reading as outstanding, which is the
*under*-claiming half of deck drift and just as expensive as the overclaiming half:
it gets the work done twice.) Written 2026-09-09 by the
founder's Claude session, from Wyatt's brief, founder feedback **F2**, issue
**#560**, and `docs/product/suggested-shows-requirements.md` (merged the same
day, PR #559). Companion to `docs/ui-transition-plan.md` (U-cards),
`docs/ios-controls-and-voice-plan.md` (L-/V-/D-cards) and
`docs/release-lockstep-plan.md` (R-cards); this deck's cards are **S-**.

The rule that governs every card here, from `CLAUDE.md`: **measured beats
inferred.** Every claim below is tagged. Where a card depends on something no
machine here can observe, it says so and names the human gate.

---

## 0. The brief, verbatim

Wyatt, 2026-09-09:

> "right now our search feature sucks. It sounds like it should be pretty easy
> to copy paste the pocket cast search strategy, right? … make a clear detailed
> plan how to do so as a .md file that I can give to Hermes to execute."

Founder feedback log (`4a-feedback.md`, kept **off-repo** on Wyatt's Desktop;
quoted here because Hermes cannot read it):

> **F2** (2026-09-04) — **Shows search should filter live as you type.** Hitting
> "Go" should not be required. Status: **Logged.**

**The premise, stated as the founder stated it.** Pocket Casts does not scan a
catalogue at query time. It typeaheads over a small in-memory prefix index of
titles and authors, debounces keystrokes, ranks by a precomputed popularity
prior, caches hot queries, and falls through to Apple's directory — the keyless
iTunes Search API, rate-limited — for the misses. Apple's directory is roughly
2.5–4 M shows, not billions.

That premise is sound and this deck adopts it. §1 says which parts of it are
already true of 4a, which parts are cheaper here than there, and the one place
the analogy breaks (we have no author field, and Pocket Casts does).

---

## 1. What is measured, what is inferred (2026-09-09, `main` @ `4b654af`)

### 1.1 The catalogue we would index

**Measured**, by reading `data/catalog-breadth.json` and `data/catalog.json`:

- `data/catalog-breadth.json` is **12,486,611 B**, **19,787** US shows,
  17 fields per row. **103** carry `in_curated: true`.
- **All 19,787 rows carry `chart_rank`** (Apple per-genre top-chart position,
  1–200, alongside `chart_genre_id` / `chart_genre_name`).
  `docs/CATALOG-PIPELINE.md` forward-compatibility requirement **#2** names that
  field as exactly this: *"this becomes the curation engine's global-quality
  prior."* It already exists; nothing has to compute it.
- **There is no author, artist or host field anywhere in the breadth catalogue.**
  Measured: 0 of 19,787 rows carry `artistName`, `author` or `artist_name`. The
  harvester (`tools/harvest-catalog.mjs`) calls Apple's `lookup`, which returns
  `artistName`, and does not keep it. **So "a title+author prefix index" is not
  buildable from what is committed** — it is a title index today, and the author
  half needs either a re-harvest or S-06's Apple fall-through (which does return
  `artistName`). This is the one place the Pocket Casts analogy does not
  transfer for free.
- The merged set the endpoint already serves — curated 220 + breadth minus the
  103 `in_curated` rows — is **19,904 rows**. Title length: mean 27.0 chars,
  p95 59, max 125.

### 1.2 What a client-side index would weigh

**Measured** on the founder's workstation, Node 22, `zlib.gzipSync` level 9,
over all 19,904 merged rows (throwaway probe, not committed):

| Shape | raw | **gzip** | brotli |
|---|---|---|---|
| sorted TSV `title \t id` | 768.9 KB | **357.7 KB** | 289.9 KB |
| sorted TSV `title \t id(base36) \t chart_rank` | 761.0 KB | **375.8 KB** | — |
| sorted TSV `title \t id \t rank \t curated` | 874.4 KB | **398.8 KB** | 322.4 KB |
| front-coded (shared-prefix) variant of the above | 772.1 KB | 379.9 KB | 312.6 KB |
| `JSON.stringify` of arrays (the naive shape) | 992.0 KB | 410.5 KB | 326.3 KB |
| word-start posting list alone (63,355 postings) | 737.0 KB | 238.6 KB | 162.7 KB |
| index **+** word-start postings | 1,611.4 KB | 637.5 KB | 485.6 KB |
| *for scale:* today's `data/catalog-client.json` | 100.1 KB | 25.2 KB | — |

Trimmed by the popularity prior, same shape (`title \t id36 \t rank`):

| Cut | Shows | raw | **gzip** |
|---|---|---|---|
| everything (`chart_rank ≤ 200`) | 19,904 | 761.0 KB | **375.8 KB** |
| `chart_rank ≤ 100` | 10,113 | 379.0 KB | **189.0 KB** |
| `chart_rank ≤ 50` | 5,136 | 191.4 KB | **96.0 KB** |
| `chart_rank ≤ 25` | 2,667 | 97.9 KB | **49.2 KB** |

**Measured — front-coding is not worth it.** It saves 8 KB raw and *costs*
22 KB gzipped against the plain sorted TSV, because gzip's own window already
exploits the shared prefixes of sorted titles. Do not hand-roll it.

**Measured — brotli buys ~19 %** over gzip. Both Vercel and GitHub Pages
negotiate `br` on static assets, so this is free if the file ships static.

### 1.3 What a query costs, once the index is local

**Measured**, same machine, 20 reps averaged, warm:

- Linear `String.indexOf` substring scan over all **19,904** lowercased titles:
  **12.9–19.9 ms** per query (`"l"` 15.2 ms / 11,268 hits; `"lex"` 15.8 ms /
  37 hits; `"radiolab"` 15.8 ms / 1 hit; `"zzqx"` 12.9 ms / 0 hits).
- The same scan over today's **220** curated titles: **0.056–0.291 ms**.
- One-time `split("\n").map(split("\t"))` decode of the 19,904-row TSV:
  **140.5 ms**.

**This is the number that decides S-03's structure.** 13–20 ms is *over* a 16 ms
frame budget, so a per-keystroke linear scan of the full index would drop frames
on a phone (which is slower than this machine). A prefix answer, by contrast, is
two binary searches — ~15 comparisons — and is free. So: **sorted array +
binary search for the prefix pass, linear scan only on the debounce tick and
only when the prefix pass under-delivers.** A trie/FST would buy the same prefix
answer for a custom decoder and a build-time format nobody else in this repo
reads; it is not justified by these numbers.

### 1.4 The live endpoint

**Measured**, `curl -w` against `API_ORIGIN`
(`https://foray-web-seven.vercel.app`, `app.js:270`), 2026-09-09, from the
founder's workstation:

- The endpoint is **reachable and healthy**: `?q=zzqx1` returns
  `{"query":"zzqx1","shows":[],"degraded":false}`. `degraded: false` means
  `vercel.json`'s `includeFiles` glob really is delivering `data/catalog*.json`
  into the `api/shows/**` bundle in production.
- **First request of a session: 3.70 s total** — of which **3.53 s was the TLS
  handshake**. That is connection setup, not the function. The next two on the
  warm connection: 0.82 s and 1.05 s.
- **Forced cache MISS** (unique query each time, so the function actually runs):
  ttfb **0.88 / 0.80 / 0.72 s**.
- **Repeat of one identical query**: first `X-Vercel-Cache: MISS` (0.51 s), then
  four `HIT`s at ttfb **0.41 / 0.41 / 0.89 / 1.12 s**.
- **The MISS→HIT delta is only ~0.3 s.** A HIT does not invoke the function at
  all, so **the function is not the bottleneck — the round trip is.** A warm-up
  ping would buy ~0.3 s of a ~0.8 s wall time. Moving the index onto the device
  buys all of it. S-05 is written accordingly.
- Response header is **`Cache-Control: public, max-age=300`**. The source
  (`api/shows/search.ts`) sets `public, max-age=300, stale-while-revalidate=3600`
  — **the `stale-while-revalidate` token is not in the response.** Recorded here
  because two decks now assume it is there.
- A `?q=lex&limit=25` response is **9,113 B**.

**Measured, and it corrects #560 item 1.** `GET /api/episodes/search?q=lex%20fridman`
in production returns real hits mapped to `show_id: "lex-fridman-podcast"`, and
`?q=huberman` returns hits for `huberman-lab`. So `data/catalog.json` **is**
present in the deployed `api/episodes/**` bundle and `loadShowIdMap` is not
empty — the catastrophic "fails green, id map empty" case #560 item 1 warns
about is **not** what production is doing. `?q=joe%20rogan` returns
`episodes: []`: Joe Rogan is not one of the 220 curated shows, so the hit is
dropped by `mapAppleHit`'s "unmapped → dropped" rule. **The live ceiling on
general episode search is the absent `data/shows-index-pointer.json` (§6.12),
not the bundling glob.** #560 item 1 still deserves its glob widening and its
bundle-test broadening; it does not deserve its severity. *(Not proven either
way: whether `data/catalog-breadth.json` reaches the episodes bundle — no probe
distinguishes it, because `loadShowMeta`'s curated half answers first.)*

### 1.5 The keystroke-to-results path today

**Measured**, by reading the code:

1. **There is no keystroke path.** `app.js:renderAllShows` (`:1869`) binds
   `#sh-form`'s **`submit` only**. No `input` listener exists on `#sh-input`.
   Enter or the **Go** button is the only trigger. That is F2, exactly.
2. On submit, `renderShowSearchResults(query)` (`app.js:3098`) takes a token
   (`showSearchToken`, `:3096`), runs `SearchEngine.searchShows` over
   `state.catalog.shows` (220 rows — **0.056–0.291 ms measured**) and paints
   `#sh-results.innerHTML` immediately.
3. In parallel it fires `fetchApiJson("api/shows/search?q=…&limit=25")`
   (**0.4–1.1 s measured**, §1.4), drops the response on a token mismatch,
   dedupes by `show_id`, caches each addition into `state.breadthShowCache`, and
   repaints. A failure degrades silently to the local results.
4. It then calls `renderEpisodeSearchResults` — **a second network call**,
   `api/episodes/search?q=…&limit=10`, guarded only by
   `navigator.onLine === false`.
5. It then calls `renderPlaylistSearchResults`, which is local, but whose
   "Create a playlist about X" CTA defers `topicSearchStatus()` — a full
   `searchWithRelaxation()` scan the source itself measures at
   **1.3–8 s on a cold cache**.

**So one submit costs two network calls and can cost a 1.3–8 s CPU-bound topic
scan.** Naively adding an `input` listener multiplies all three by the
keystroke. That consequence is the whole design of S-02 and it is why S-02 is
not a two-line card.

**Measured — the browser HTTP cache is deliberately defeated.**
`fetchApiJson` (`app.js:7129`) and `fetchJson` (`:7108`) both pass
`{ cache: "no-cache" }`, so a repeat of an identical query revalidates over the
network every time regardless of `max-age`. Any hot-query cache has to be an
in-memory one in `app.js`; the HTTP layer will not provide it.

**Measured — the service worker will not rescue a new data file.**
`sw.js:handleData` (`:633`) is network-first and its offline fallback reads
**only the precached generation cache**; it never runtime-caches. Worse, every
`fetchJson()` call goes through `app.js:pinnedUrl` (`:7352`), which appends
`?_fdid=<deploy id>`, and `handleData`'s tagged branch returns **`unavailable()`
— a bare 504** when the pinned generation has no copy. So a new `data/*` file
fetched through `fetchJson()` **without** being added to
`tools/ci/generate-manifest.mjs`'s `RUNTIME_DATA` fails hard, offline and
online-after-install alike. S-03 must choose its load path deliberately; the
choice is written into the card.

**Measured — two lists, not one.** `tools/web/prepare-dist.mjs`'s `RUNTIME_DATA`
decides what is *served on the web at all*; `tools/ci/generate-manifest.mjs`'s
`RUNTIME_DATA` decides what `sw.js` *precaches*. They are kept in sync by hand
and both headers say so. `tools/mobile/prepare-webdir.mjs` is a **third**
list — its `runtimeDataFiles()` scans for literal `fetchJson("data/…")` call
sites, so an unpinned `fetch()` will not be seen by it, and its `MAX_BYTES` is
`3 * 1024 * 1024` with the source naming roughly **740 KB of headroom** today.

**Measured — the privacy conditional is false as shipped.**
`docs/legal/privacy-policy.md` §2 promises *"if a show or episode is already in
that local catalogue nothing you typed leaves your device."*
`renderShowSearchResults` fires both endpoints **unconditionally**. There is no
local-hit branch anywhere. `test/release-gates.test.js` deliberately does not
catch it. This is #560 item 2 and requirements §6.11/§6.13 row 6, and it is the
one thing in this deck that is not ours to decide (§3 G1).

**Inferred**, flagged as such:

- That 0.4–1.1 s is dominated by network RTT rather than compute is inferred
  from the small MISS→HIT delta plus the fact that a HIT skips the function. It
  has not been decomposed with server timings.
- Phone-side scan cost is inferred from the desktop numbers; a mid-range phone
  is commonly 2–4× slower. S-01 exists so that stops being an inference.
- Apple's iTunes Search rate limit is inferred from this repo's own committed
  ceiling (`api/episodes/appleBucket.ts` caps at **≤ 20/min**, with an honest
  header saying it is per-warm-instance and not a global cap). Apple publishes
  no contractual number; do not invent one.

---

### 1.6 S-01's before numbers (2026-09-10, this branch @ `e9ff264`)

**Measured**, `node tools/search-probe.mjs --check`, this repo's committed
`data/catalog-client.json` (220 curated shows), 20 reps per query, this
sandbox (not the founder's device — a second on-device run against the same
tool is still owed before S-02/S-03 numbers are graded against a phone):

| query | len | hits | median ms | p95 ms |
|---|---|---|---|---|
| `l` | 1 | 112 | 0.074 | 0.610 |
| `le` | 2 | 27 | 0.029 | 0.045 |
| `lex` | 3 | 1 | 0.029 | 0.049 |
| `lex f` | 5 | 1 | 0.024 | 0.045 |
| `sci` | 3 | 9 | 0.029 | 0.047 |
| `science f` | 9 | 1 | 0.025 | 0.039 |
| `hist` | 4 | 11 | 0.034 | 0.049 |
| `the daily` | 9 | 0 | 0.015 | 0.052 |
| `radiolab` | 8 | 1 | 0.014 | 0.016 |
| `99%` | 3 | 1 | 0.013 | 0.017 |
| `zzqx` | 4 | 0 | 0.010 | 0.011 |
| `伊藤洋一のRound Up World Now！` | 24 | 0 | 0.008 | 0.014 |

Decode (`JSON.parse` of `data/catalog-client.json`, 20 reps): median
**0.169ms**, p95 **0.208ms**.

Breadth round-trip (`API_ORIGIN`'s `/api/shows/search`, three forced-MISS +
three repeat samples, headers as received):

| sample | ttfb ms | status | Cache-Control | X-Vercel-Cache | Age |
|---|---|---|---|---|---|
| MISS 1 | 313 | 200 | `public, max-age=300` | MISS | 0 |
| MISS 2 | 277 | 200 | `public, max-age=300` | MISS | 0 |
| MISS 3 | 122 | 200 | `public, max-age=300` | MISS | 0 |
| repeat 1 | 130 | 200 | `public, max-age=300` | MISS | 0 |
| repeat 2 | 34 | 200 | `public, max-age=300` | HIT | 0 |
| repeat 3 | 38 | 200 | `public, max-age=300` | HIT | 0 |

Confirms §1.4's own finding again: the response never carries
`stale-while-revalidate` even though the source sets it, and a HIT still
costs real ttfb (34–38ms here) rather than being free — this sandbox's
numbers are faster end-to-end than §1.4's original desktop run (no TLS
handshake cold-start observed), so treat the **shape** (MISS→HIT delta small,
`stale-while-revalidate` missing) as the durable finding and the absolute
ms as environment-dependent.

**A diagnostics copy carrying a `search` entry with a non-null `paintedMs`**
(from `player/diagnostic-log.js`'s new entry kind, S-01's other acceptance
line), produced via `PlayerDiagnostics.search()` and rendered by
`formatDiagnosticReport`:

```
#1    04:39:28.030 search     qLen=3 local=0ms/1h net=313ms/0h ep=—/—h cta=— painted=1ms path=local+net  hidden=n
```

**CI run id**: `node --test` run over `tools/search-probe.test.mjs` (27
tests), `player/diagnostic-log.test.js` (55 tests, +5 for the new `search`
entry kind), and `test/search-probe-record.test.js` (9 tests, new) — all
green in this branch's worktree at commit `e9ff264` (`git rev-parse HEAD`);
the PR's own CI run id is the canonical one once opened, recorded here as
the local equivalent per S-01's own acceptance line.

---


### 1.7 S-08's after numbers (2026-09-12, `feat/search-deck-s02-s08` @ `b3a12a6`+)

**Measured**, `node tools/search-probe.mjs --check`, same sandbox and same
12-query battery as §1.6, 20 reps, median and p95. Read this section beside
§1.6, not instead of it: the local 220-show pass is **unchanged code** and its
numbers move only with machine load, which is exactly why it is the control.

**(a) The curated 220-show pass — the control.**

| query | len | hits | median ms | p95 ms |
|---|---|---|---|---|
| `l` | 1 | 112 | 0.916 | 28.994 |
| `le` | 2 | 27 | 0.143 | 0.737 |
| `lex` | 3 | 1 | 0.084 | 0.152 |
| `lex f` | 5 | 1 | 0.123 | 0.138 |
| `sci` | 3 | 9 | 0.107 | 0.182 |
| `science f` | 9 | 1 | 0.083 | 0.113 |
| `hist` | 4 | 11 | 0.139 | 0.162 |
| `the daily` | 9 | 0 | 0.126 | 0.234 |
| `radiolab` | 8 | 1 | 0.147 | 0.867 |
| `99%` | 3 | 1 | 0.076 | 0.171 |
| `zzqx` | 4 | 0 | 0.070 | 0.129 |
| `伊藤洋一のRound Up World Now！` | 24 | 0 | 0.048 | 0.068 |

Hit counts are **identical to §1.6's** for every query, which is the check that
matters here: S-04 changed the ORDER, not the membership. The times are ~3-5x
§1.6's because this sandbox was under load (§1.6's `l` read 0.074 ms median and
0.610 p95; this run reads 0.916 / 28.994 for the same unchanged code). Treat the
absolute ms as environment-dependent — the durable finding is that the curated
pass is still far inside a frame.

**(b) The index pass — the number S-03 exists to produce.** `data/show-index.tsv`,
10,113 rows, 446,334 B on disk, **201.1 KB gzipped** (level 9) against S-03's
400 KB budget. `parseShowIndex` decode: median **51.6 ms**, p95 **102.9 ms** —
which is why it runs once, on first focus, and never at `init()` or on a
keystroke.

| query | pfx hits | pfx median | pfx p95 | scan hits | scan median | scan p95 | scan run? |
|---|---|---|---|---|---|---|---|
| `l` | 418 | 1.808 | 14.215 | 5332 | 232.042 | 471.331 | no |
| `le` | 90 | 0.350 | 0.498 | 1382 | 94.482 | 136.817 | no |
| `lex` | 1 | 0.004 | 0.012 | 15 | 46.296 | 74.340 | yes |
| `lex f` | 1 | 0.004 | 0.004 | 0 | 22.346 | 42.625 | yes |
| `sci` | 14 | 0.022 | 0.025 | 117 | 24.879 | 45.737 | no |
| `science f` | 3 | 0.006 | 0.010 | 7 | 18.147 | 40.959 | yes |
| `hist` | 15 | 0.029 | 0.049 | 110 | 28.730 | 47.789 | no |
| `the daily` | 18 | 0.035 | 0.059 | 2 | 27.763 | 54.623 | no |
| `radiolab` | 1 | 0.005 | 0.026 | 0 | 18.625 | 36.987 | yes |
| `99%` | 1 | 0.004 | 0.005 | 0 | 13.839 | 24.290 | yes |
| `zzqx` | 0 | 0.003 | 0.004 | 0 | 10.594 | 23.728 | yes |
| `伊藤洋一のRound Up World Now！` | 24 | 0.004 | 0.006 | 0 | 9.227 | 18.561 | yes |

**"scan run?" is the column that makes this table honest.** The scan is the
linear pass; app.js runs it **only on the debounce tick and only when the prefix
pass returned fewer than 10 hits** (`SHOW_PREFIX_UNDERDELIVERS_BELOW`). So `l`'s
232 ms scan is measured here and **never paid** — the queries whose scans are
actually reached cost 9-46 ms, on a tick 250 ms after the last keystroke, which
is the budget §1.3 set for it.

**Against §1.3's prediction, which held.** §1.3 measured a linear scan of all
19,904 titles at 12.9-19.9 ms and concluded it was over a frame budget; this run
measures the same shape at 9-232 ms over 10,113 rows on a loaded sandbox, and
the prefix pass it prescribed instead at **0.003-0.035 ms median for every query
longer than one character**. The one-character query `l` costs 1.8 ms median,
and that cost is the SORT of its 418 results rather than the search.

**A measurement bug found and fixed while producing this table**, recorded
because it would have made S-03 look like it failed its own acceptance line: the
first version of `indexPassBattery` ran the prefix and scan reps interleaved per
query, which put the prefix timing inside the scan's GC window. `l`'s prefix
median read **22-43 ms** interleaved and **1.8-2.3 ms** when the two passes are
swept separately, for identical work. The probe now sweeps them separately and
says so in its own header.

**(c) The breadth round-trip — unchanged, and still the reason S-03 exists.**

| sample | ttfb ms | status | Cache-Control | X-Vercel-Cache | Age |
|---|---|---|---|---|---|
| MISS 1 | 2978 | 200 | `public, max-age=300` | MISS | 0 |
| MISS 2 | 944 | 200 | `public, max-age=300` | MISS | 0 |
| MISS 3 | 169 | 200 | `public, max-age=300` | MISS | 0 |
| repeat 1 | 178 | 200 | `public, max-age=300` | MISS | 0 |
| repeat 2 | 249 | 200 | `public, max-age=300` | HIT | 0 |
| repeat 3 | 112 | 200 | `public, max-age=300` | HIT | 0 |

**`stale-while-revalidate` is still missing from the response** even though
`api/shows/search.ts` sets it — third independent observation (§1.4, §1.6, here).
S-05's source-comment correction is in the follow-up `api/**` PR.

**The comparison that matters, stated in one line.** Before: every keystroke was
worthless (there was no keystroke path at all) and every submit paid
**101-2978 ms** for a result. After: every keystroke is answered in **under
0.04 ms** from 10,113 shows on the device, and the round trip happens once, 250 ms
after the listener stops typing, and not at all on a repeat of a query already
asked this session.

**Still owed, and named rather than implied:** a run of this same probe **on the
founder's device**. Every number above and in §1.6 is from this sandbox. S-01's
acceptance line asked for a device run and it has not happened; the phone-side
claims in §1.3 ("a mid-range phone is commonly 2-4x slower") remain **inferred**.

---


### 1.8 P-06's before/after (2026-09-13, `origin/main` @ `c1deb48` vs `feat/search-parity` @ `287296c`)

**Read this beside §1.7, not instead of it.** §1.7 is the S-deck's after-table;
this is the P-deck's, produced by re-running the same harness
(`tools/search-probe.mjs`, S-01) against **both** revisions on the same machine
inside the same twenty minutes, plus a replay of the three queries
`docs/search-parity-plan.md` §2.1 names as the defect.

**The headline, before the tables, because the tables do not contain it.**
*The probe cannot see P-02's win.* Its 12-query battery is a timing battery and
its network section deliberately asks for queries that match nothing, so it
measures the same passes at the same speed on both revisions — which is the
correct result and a useless one. **What the P-deck exists to fix is measured in
§1.8(d), and it had to be added to the probe to be measurable at all.**

**(a) The curated 220-show pass and the index pass are a CONTROL, and this is
checkable rather than asserted.** Every changed line in `search-engine.js` on
this branch is a comment (`git diff origin/main...HEAD -- search-engine.js |
grep '^[+-][^+-]' | grep -v '^[+-] \*'` is empty), and `data/` is untouched. So
(a) and (b) run byte-identical executable code over byte-identical data; any
delta below is machine noise, and reading one as a result would be an error.

| query | len | hits main / branch | median ms main | median ms branch | p95 ms main | p95 ms branch |
|---|---|---|---|---|---|---|
| `l` | 1 | 112 / 112 | 0.103 | 0.127 | 0.826 | 1.132 |
| `le` | 2 | 27 / 27 | 0.019 | 0.025 | 0.037 | 0.038 |
| `lex` | 3 | 1 / 1 | 0.012 | 0.017 | 0.019 | 0.026 |
| `lex f` | 5 | 1 / 1 | 0.015 | 0.022 | 0.023 | 0.033 |
| `sci` | 3 | 9 / 9 | 0.015 | 0.023 | 0.032 | 0.091 |
| `science f` | 9 | 1 / 1 | 0.011 | 0.015 | 0.033 | 0.025 |
| `hist` | 4 | 11 / 11 | 0.018 | 0.025 | 0.023 | 0.033 |
| `the daily` | 9 | 0 / 0 | 0.019 | 0.023 | 0.024 | 0.040 |
| `radiolab` | 8 | 1 / 1 | 0.025 | 0.033 | 0.092 | 0.081 |
| `99%` | 3 | 1 / 1 | 0.017 | 0.030 | 0.031 | 0.037 |
| `zzqx` | 4 | 0 / 0 | 0.011 | 0.015 | 0.015 | 0.025 |
| `伊藤洋一のRound Up World Now！` | 24 | 0 / 0 | 0.009 | 0.011 | 0.028 | 0.034 |

`JSON.parse` decode: main median **0.127 ms** / p95 0.265; branch median
**0.169 ms** / p95 0.399.

**Hit counts are identical on every row**, which is the assertion that matters:
P-02 and P-03 changed nothing about what the local pass *finds*. The branch
column reads ~1.3-1.5x slower throughout, and that is **sandbox load, not the
branch** — a second `origin/main` run taken immediately after the branch run
reproduced the branch's numbers, not the first main run's (index decode 5.963 ms
vs 6.395 vs 8.832 across three runs of identical code). Treat the absolute ms
here the way §1.7 asks you to: environment-dependent, and far inside a frame.

**(b) The index pass.** `data/show-index.tsv`, **10,113 rows, 446,334 B on both
revisions** — P-03b shipped no column, so the file is byte-identical (see
P-03's own commit message for why the author column was measured and refused).
`parseShowIndex` decode: main median **6.395 ms** / p95 10.075; branch median
**8.832 ms** / p95 12.704.

| query | pfx hits m/b | pfx med m | pfx med b | pfx p95 m | pfx p95 b | scan hits m/b | scan med m | scan med b | scan run? |
|---|---|---|---|---|---|---|---|---|---|
| `l` | 418 / 418 | 0.330 | 0.586 | 0.649 | 1.515 | 5332 / 5332 | 6.652 | 9.951 | no |
| `le` | 90 / 90 | 0.058 | 0.109 | 0.078 | 0.123 | 1382 / 1382 | 2.039 | 3.408 | no |
| `lex` | 1 / 1 | 0.001 | 0.001 | 0.001 | 0.001 | 15 / 15 | 0.625 | 0.951 | yes |
| `lex f` | 1 / 1 | 0.001 | 0.001 | 0.001 | 0.001 | 0 / 0 | 0.601 | 0.910 | yes |
| `sci` | 14 / 14 | 0.004 | 0.006 | 0.005 | 0.007 | 117 / 117 | 0.784 | 1.354 | no |
| `science f` | 3 / 3 | 0.001 | 0.001 | 0.001 | 0.002 | 7 / 7 | 0.602 | 0.977 | yes |
| `hist` | 15 / 15 | 0.005 | 0.008 | 0.006 | 0.009 | 110 / 110 | 0.695 | 1.136 | no |
| `the daily` | 18 / 18 | 0.006 | 0.011 | 0.007 | 0.012 | 2 / 2 | 0.697 | 1.093 | no |
| `radiolab` | 1 / 1 | 0.001 | 0.001 | 0.001 | 0.002 | 0 / 0 | 0.650 | 1.030 | yes |
| `99%` | 1 / 1 | 0.001 | 0.001 | 0.001 | 0.001 | 0 / 0 | 0.440 | 0.696 | yes |
| `zzqx` | 0 / 0 | 0.001 | 0.001 | 0.001 | 0.001 | 0 / 0 | 0.451 | 0.718 | yes |
| `伊藤洋一のRound Up World Now！` | 0 / 0 | 0.001 | 0.001 | 0.001 | 0.001 | 0 / 0 | 0.284 | 0.459 | yes |

**A correction to §1.7's index table, found by re-running it.** §1.7 records
**24** prefix hits for `伊藤洋一のRound Up World Now！`. Measured today on both
revisions, on the same file, it is **0**. 24 is that query's `query_len` — the
probe prints `query_len` as its first column and §1.7 transcribed the query text
in its place, shifting the row. The other eleven rows transcribed correctly
(`l`'s 418 and 5332 both reproduce exactly). Nothing regressed; §1.7's number was
never measured.

**(c) The breadth round-trip — the same deployment on both runs, so this is one
measurement printed twice.** `API_ORIGIN` is
`https://foray-web-seven.vercel.app`, which serves `main`. Neither run is
testing the checkout it was launched from.

| sample | ttfb main | cache main | ttfb branch | cache branch |
|---|---|---|---|---|
| MISS 1 | 374 | MISS | 369 | MISS |
| MISS 2 | 335 | MISS | 214 | MISS |
| MISS 3 | 180 | MISS | 184 | MISS |
| repeat 1 | 111 | MISS | 117 | MISS |
| repeat 2 | 83 | HIT | 188 | HIT |
| repeat 3 | 30 | HIT | 32 | HIT |

All twelve samples: status 200, `Cache-Control: public, max-age=300`.
**`stale-while-revalidate` is still absent from the response** — fourth
independent observation (§1.4, §1.6, §1.7, here).

---

#### (d) The three named cases — `tim ferriss`, `lex fridman`, `sam harris`

`docs/search-parity-plan.md` §2.1 measured each of these returning **one row**,
with and without `fallthrough=1`. P-06 asks for them as named cases so that
cannot regress silently, and they are now `PARITY_CASES` in
`tools/search-probe.mjs` — its own battery, deliberately **not** appended to
`QUERY_BATTERY`, whose length is asserted and whose contents §1.6 and §1.7 quote
verbatim. Fifteen tests in `tools/search-probe.test.mjs` pin them (floor 30 ->
45).

**What the probe reports today, run from this branch's worktree:**

```
  query          plain  tgt#  directory  tgt#  gain  first title (directory)
  tim ferriss        1     1          1     1     0  The Tim Ferriss Show
  lex fridman        1     1          1     1     0  Lex Fridman Podcast
  sam harris         1     1          1     1     0  Making Sense with Sam Harris
  ^ EVERY case gained nothing: the directory pass is inert (this is §2.1's defect).
```

**That is not a finding about the branch.** This section asks the *deployed*
endpoint, which is `main`; it reproduces §2.1 exactly, three days on, and its
real content is that **P-02 is not in front of a listener yet**. The probe says
so in its own header rather than letting a future reader mistake it for a
verdict on the code.

**So the after-column is a replay, and it says what it replays.** The local pass
is `app.js`'s own (`prefixSearchShows` -> `searchShows` over the committed
`data/show-index.tsv` and `data/catalog-client.json`, then `scanShowIndex` under
`SHOW_PREFIX_UNDERDELIVERS_BELOW`); BEFORE merges the live endpoint under main's
gate (`&fallthrough=1` only when the local pass was empty — it never is here);
AFTER merges the live endpoint **plus** `itunes.apple.com/search?entity=podcast`
through this branch's `mergeDirectoryShows` and `mergeBreadth`, deduped by
`show_id` and by normalised title. Live, `limit=25`, 2026-09-13.

| query | local | endpoint | Apple raw | **rows before** | **rows after** | gain |
|---|---|---|---|---|---|---|
| `tim ferriss` | 1 | 1 | 14 | **1** | **14** | +13 |
| `lex fridman` | 1 | 1 | 4 | **1** | **3** | +2 |
| `sam harris` | 1 | 1 | 11 | **1** | **11** | +10 |

**First three titles, which is where the interesting result is.**

| query | before | after |
|---|---|---|
| `tim ferriss` | 1. *The Tim Ferriss Show* | 1. *Tim Ferriss "The 4-Hour Body": Meet the Author*<br>2. *Tim Ferriss Podcast*<br>3. ***The Tim Ferriss Show*** |
| `lex fridman` | 1. *Lex Fridman Podcast* | 1. ***Lex Fridman Podcast***<br>2. *Lex Fridman Podcast \| 5 minute podcast summaries*<br>3. *5 minute podcast summaries of: Tim Ferriss, Hidden Brain, Sam Harris, Lex Fridman, Jordan Peterson* |
| `sam harris` | 1. *Making Sense with Sam Harris* | 1. ***Making Sense with Sam Harris***<br>2. *5 minute podcast summaries of: Tim Ferriss, Hidden Brain, Sam Harris, Lex Fridman, Jordan Peterson*<br>3. *Making Sense with Sam Harris \| 5 minute podcast summaries* |

**`tim ferriss` does not meet P-02's own done-when, and the row count hides it.**
P-02 asks for ">= 10 rows **with the exact show first**". It returns 14 rows and
The Tim Ferriss Show is **third**, behind two shows nobody is searching for:

```
 1 prefix      apple      Tim Ferriss "The 4-Hour Body": Meet the Author
 2 prefix      apple      Tim Ferriss Podcast
 3 word-start  catalogue  The Tim Ferriss Show
 4 word-start  apple      5 minute podcast summaries of: Tim Ferriss, ...
 …
 8 unmatched   apple      Tools of Titans: …
```

The cause is `rankShows`'s bucket order, not the merge: a title that **starts
with** "tim ferriss" is a prefix match and outranks *The Tim Ferriss Show*,
which is only a word-start match because of its leading "The". Apple itself does
not make this mistake — these rows arrive in Apple's order and are re-sorted by
us. **This is the same failure P-03b refused the author column for**, arriving
through the title bucket instead: re-ranking Apple's answer on one lexical
signal discards a better ranking than the one it substitutes. It is named here
rather than fixed because it is a ranking change and P-06 is a measurement card;
it belongs to P-04's re-derivation or a card of its own.

`lex fridman`'s ceiling of 3 is Apple's, not ours, and is already recorded in
P-02's commit message: Apple returns 4 rows at `limit=25` **and** at
`limit=200`, three of them duplicate *Lex Fridman Podcast* entries that the
normalised-title dedup correctly collapses. **P-02's ">= 10 rows" cannot be met
for this query by any merge**, and the deck's done-when should be rewritten
against that measured ceiling rather than left to fail forever.

**The one-line comparison.** Before: three of the best-known shows in podcasting
returned **one row each**, because one local match is not zero. After: **14, 3
and 11**, with the show the listener meant **first on two of the three** — and
the third is a ranking defect that the row count alone would have called a win,
which is exactly why the target's rank is now reported beside the count.

**Still owed, unchanged from §1.7 and now also true of (d):** none of this has
been run on the founder's device, and none of it is deployed. P-01's build is
still the prerequisite for P-07.

---


### 1.9 P-08's before/after: WHERE the show lands, over 30 queries (2026-09-12, `origin/main` @ `3b899d8` vs `fix/search-ranking-intent`)

**This section measures a POSITION, not a duration, and that is the point.**
§1.7 and §1.8 measure how fast the answer arrives and how many rows it has.
Neither can see the defect this card closes: after P-02, `tim ferriss` returned
14 rows and *The Tim Ferriss Show* was the third of them. A row count improving
from 1 to 14 reads as a win in every table above while the listener still does
not find what they typed.

**The harness.** The whole client pipeline, run offline against the real
committed `data/catalog-client.json`, the real `data/show-index.tsv`, the real
merged catalogue through `searchBreadthShows` at `limit=25`, and the LIVE
directory rows — collected once per query from
`https://foray-web-seven.vercel.app/api/shows/search?…&fallthrough=1`, cached,
and replayed identically into both revisions so the only variable is the rule.
The passes and their order are `app.js`'s: `localShowMatches` →
`scanShowIndex` (only when the local pass returns < 10) → the catalogue pass →
the directory pass, each merged through `mergeShowRows` and re-ranked by
`rankShows`. **The intended show was written down before the run** (the case
list is the table's second column), so no result could be rationalised after the
fact.

**A note on pacing that the next person to run this will need.** The endpoint's
Apple bucket is 20 calls per 60 s (`api/episodes/appleBucket.ts`), shared across
queries. A 30-query battery fired back to back trips it at query 21 and every
query after that comes back `fallthrough: {error: "rate limit exceeded"}` with
directory rows silently missing — which looks exactly like a catalogue that has
nothing to say. Collect at ~1 query per 3.5 s, and assert on
`fallthrough.error`, not on the row count.

| query | intended show | pos before | pos after | rows before | rows after |
|---|---|---:|---:|---:|---:|
| `tim ferriss` | The Tim Ferriss Show | 3 | **1** | 14 | 14 |
| `sam harris` | Making Sense with Sam Harris | 1 | 1 | 11 | 11 |
| `lex fridman` | Lex Fridman Podcast | 1 | 1 | 3 | 3 |
| `huberman` | Huberman Lab | 1 | 1 | 13 | 13 |
| `hard fork` | Hard Fork | 1 | 1 | 4 | 4 |
| `radiolab` | Radiolab | 1 | 1 | 18 | 18 |
| `crime junkie` | Crime Junkie | 1 | 1 | 26 | 26 |
| `99% invisible` | 99% Invisible | 1 | 1 | 7 | 7 |
| `history` | Dan Carlin's Hardcore History | 30 | **2** | 57 | 53 |
| `science` | Science Vs | 3 | 3 | 51 | 52 |
| `the daily` | The Daily | 1 | 1 | 44 | 45 |
| `planet money` | Planet Money | 1 | 1 | 6 | 6 |
| `smartless` | SmartLess | 1 | 1 | 13 | 13 |
| `serial` | Serial | 1 | 1 | 27 | 27 |
| `this american life` | This American Life | 1 | 1 | 8 | 8 |
| `freakonomics` | Freakonomics Radio | 1 | 1 | 14 | 14 |
| `rogan` | The Joe Rogan Experience | 5 | **1** | 25 | 25 |
| `conan` | Conan O'Brien Needs a Friend | 1 | 1 | 24 | 24 |
| `armchair` | Armchair Expert with Dax Shepard | 1 | 1 | 26 | 26 |
| `stuff you should know` | Stuff You Should Know | 1 | 1 | 19 | 19 |
| `ferriss` | The Tim Ferriss Show | 1 | 1 | 14 | 14 |
| `fridm` | Lex Fridman Podcast | 1 | 1 | 3 | 3 |
| `huber` | Huberman Lab | 1 | 1 | 25 | 25 |
| `dark history` | Dark History | 1 | 1 | 22 | 22 |
| `pod save` | Pod Save America | 1 | 1 | 21 | 21 |
| `daily` | The Daily | 40 | **17** | 59 | 66 |
| `money` | Planet Money | 19 | **2** | 40 | 42 |
| `american` | This American Life | 33 | **1** | 40 | 41 |
| `fork` | Hard Fork | 10 | **1** | 27 | 27 |
| `the rest is history` | The Rest Is History | 1 | 1 | 9 | 9 |

**Summary: intended show first on 22/30 → 26/30; in the top 3 on 24/30 → 29/30;
7 queries improved, 0 regressed. Total rows across the battery 670 → 678.**

**Reach was not traded for order.** 29 of the 30 queries return at least as many
rows as before. The one that does not is `history` (57 → 53), and the swap is
worth stating rather than netting out: the endpoint sends 25 rows either way, and
under the old rule all 25 were titles BEGINNING with "history", 13 of which
(*History of L.A. Ska: One On One Sessions*, *History Tea Time*, *History Chats
with Dr. S.*, …) no longer survive the cut. In their place come 9 charting
word-start rows (*A History of Rock Music in 500 Songs*, *Unpacking Israeli
History*, *The History of Chemistry*, …) plus *Dan Carlin's Hardcore History*
itself, which under the old rule **was not in the endpoint's reply at all** and
reached the listener only because Apple's directory happened to send it too.
Four fewer rows, and every one of the four was worse than what replaced it.

**What did NOT get fixed, measured rather than hand-waved.** Four queries still
do not put the intended show first, and all four fail for the same reason: the
popularity prior cannot separate the rows that are left.

| query | intended show | after | what stands above it, and why |
|---|---|---:|---|
| `history` | Dan Carlin's Hardcore History | 2 | *Ancient History Fangirl* — also curated, so both are band 0. **Curated rows carry no `chart_rank` at all**, so 220 editorially chosen shows tie and fall to the alphabet. |
| `money` | Planet Money | 2 | *Death, Sex & Money* — same, and worse: the join in `data/catalog-breadth.json` knows *Death, Sex & Money* is rank 8 in *Relationships* and *Planet Money* is rank 20 in *Business*, which is not a comparison. |
| `science` | Science Vs | 3 | *Science* (a genuine exact title, correctly first) and *Science for Sport Podcast* — curated, band 0, alphabetically earlier. |
| `daily` | The Daily | 17 | ~16 breadth rows that are also band 1. `chart_rank` is PER-GENRE, so *The Daily* (rank 1, *News*) is in the same band as *BirdNote Daily* (rank 7, *Nature*) and *Kinda Funny Games Daily* (rank 1, *Video Games*). |

Both causes are written up as cards: **P-09** (curated rows have no popularity
signal, and one is available today) and **P-10** (`chart_rank` is per-genre and
no cross-genre measure exists).

**A tempting fix that was built, measured and REFUSED, recorded so it is not
re-proposed.** Adding a fourth band at the top — `SHOW_PRIOR_BANDS = [3, 10, 50,
200]` — moves `daily` from 17 to **4** with no regression anywhere else in the
battery. It was reverted anyway. The boundary at 10 is not arbitrary: it is the
point past which this repo has decided two per-genre ranks stop being
comparable, and `test/show-search-ranking.test.js`'s cross-genre test pins that
with a rank-3-against-rank-8 fixture. A band edge at 3 makes exactly that
comparison decisive, so buying the 13 places would have meant deleting the pin
that says the comparison is meaningless. It is meaningless either way; the
number just flattered it. P-10 is the honest version of the same win.

---


## 2. Target

- **The Shows search filters as you type** (F2), locally, at frame rate, with no
  network call attributable to a single keystroke.
- **The local pass covers what the breadth endpoint covers** — all 19,904 shows,
  from a compact index on the device — so the endpoint stops being on the
  critical path and becomes the fall-through, not the search.
- **Ranked the way a listener expects**: exact title, then prefix, then
  word-start, then substring; curated first inside each bucket; Apple's
  `chart_rank` as the tie-break; ties stable.
- **A genuine miss falls through to Apple's directory**, server-side, under the
  rate limit this repo already enforces, and the show it finds is **linkable** —
  a breadth show page survives a reload and a shared link (#560 item 7).
- **The privacy policy and the code say the same thing** (#560 item 2), decided
  by the founder, recorded in `docs/DECISIONS.md`.

---

## 3. Human gates

| # | Who | What | Blocks |
|---|---|---|---|
| **G1** | **Wyatt** | **RULED 2026-09-11: Option B** — the policy loses its conditional; typed search text may go to our origin and Apple's directory; Wyatt updates the store listing. S-07 writes the Option-B diff; S-02's network half, S-05, S-06 and S-08 are unblocked. *(Original ask:)* **The privacy decision, #560 item 2 / requirements §6.13 row 6.** Either the code gates the network passes on a local miss (the shipped promise), or the policy loses its conditional. S-07 writes both diffs and does not choose. **Until G1 is answered, no card in this deck may ship a network call attached to a keystroke.** S-02 therefore ships live *local* filtering plus the debounce machinery, with the debounced network pass left on the submit trigger; S-05 and S-06 do not start. | S-02's network half, S-05, S-06, S-08 |
| **G2** | Wyatt (product) | **Does the Go button survive live filtering?** (requirements §6.13 row 1; F2's own note calls it "a product call, not just a technical one".) The deck's default, if no answer: keep the button, keep Enter, make neither *required* — the button becomes "search now, skip the debounce". | S-02's final copy only; S-02 is not blocked from shipping the default |
| **G3** | Wyatt (merge click) | **The unlisted paths.** `api/shows/search.ts`, `vercel.json` and `index.html` are on neither `ALLOWED_PREFIXES` nor `DENIED_PREFIXES` in `tools/ci/path-policy.mjs`. Measured from `automergeDecision`: unlisted → code `UNLISTED_PATH`, auto-merge declines, `needsFounder: true`. **The `founder-approved` label does not help here** — `governedCheck` counts only DENIED paths as governed. These need a human clicking merge. | S-05, S-06 |
| **G4** | Wyatt (`founder-approved` label) | The DENIED paths this deck touches: `docs/DECISIONS.md` (S-07, S-08), `tools/ci/generate-manifest.mjs` (S-03, if the index is precached), and `backend/src/catalog/searchBreadthShows.ts` (S-04, only if the server ranking is changed to match). Batch the label sitting with the R-deck's and the L-deck's H4. | S-03 (option A), S-04's server half, S-07, S-08 |
| **G5** | Wyatt | **The index budget.** §1.2 measures the full 19,904-show index at **~376 KB gzipped**. Does that clear, on the web precache and inside the 3 MB mobile bundle (~740 KB headroom)? If not, the measured trims are `chart_rank ≤ 100` → 189 KB / 10,113 shows and `≤ 50` → 96 KB / 5,136 shows. S-01's after-numbers make this decidable rather than a matter of taste. | S-03's cut, not its shape |

Not a gate, recorded so nobody treats it as one: **the international catalogue.**
`data/catalog-breadth-intl.json.gz` (121,786 shows, read by nothing — #560 item 6)
stays dead weight. Indexing it is a separate decision with a separate budget and
it is a non-goal here (§7).

---

## 4. The card deck

Conventions as in the other decks: the ask; owned vs shared files; dependencies;
**measured** acceptance; sizing (**S** ≤ ½ day, **M** ≤ 2 days, **L** ≤ 5);
governance; design comment first where marked. Branch `t_<card>/<slug>`,
STATE.md entry per PR. Every card runs `node tools/ci/run-suites.mjs`, keeps
`test/app-security.test.js`'s invariants green (`esc()`, `safeUrl()`, no inline
styles), raises rather than lowers every floor it touches in
`test/suite-integrity.test.js`, and names the mutation that turns each new test
red.

**Governance, stated once and exactly, read from `tools/ci/path-policy.mjs`
(enforcement is ON — `PATH_POLICY_ENFORCE=1`):**

- **Auto-merges when green** (`ALLOWED_PREFIXES`): `app.js`, `search-engine.js`,
  `styles.css`, `sw.js`, `data/`, `docs/`, `player/`, `test/`, `tools/`,
  `mobile/`, `STATE.md`, `HUMAN-ACTIONS.md`, `deploy-manifest.json`.
- **Needs the `founder-approved` label** (`DENIED_PREFIXES`, which is checked
  first and wins over the allowlist): `.github/`, `docs/DECISIONS.md`,
  `docs/adr/`, `backend/src/`, **`tools/ci/`** (so
  `tools/ci/generate-manifest.mjs` counts), `tools/test-search.mjs`,
  `tools/validate-semantic-index.mjs`.
- **Needs a human merge click, and no label helps**: anything on neither list —
  `index.html`, `vercel.json`, `api/**`, root `package.json`. Auto-merge returns
  `UNLISTED_PATH`; the PR gets `needs-founder`. **Batch every unlisted touch
  into as few PRs as possible.**

**Read first:** `CLAUDE.md`; this file;
`docs/product/suggested-shows-requirements.md` **§3.3, §6.2, §6.4, §6.8, §6.11,
§6.13**; issue **#560** (items 1, 2, 4, 6, 7, 10); `docs/CATALOG-PIPELINE.md`
"Forward-compatibility requirements" (**#2** popularity prior, **#5** client
isolation); `docs/DECISIONS.md` **2026-09-02** (show search reaches the breadth
catalogue); `docs/legal/privacy-policy.md` §2; `search-engine.js:searchShows`'s
header; `app.js:renderShowSearchResults`' header; `api/episodes/search.ts`'s
header and `api/episodes/appleBucket.ts`; `tools/ci/path-policy.mjs`'s two
prefix lists.

---

#### S-01 · Measure first: a search probe with a before number — **M** — **DONE** (#576, 2026-09-10; before numbers in §1.6. Extended by #657: the probe now also measures S-03's index — both passes reported separately — and its entrypoint guard was silently false on Windows, so it printed nothing and exited 0 on the founder's own machine)

- **Ask:** a probe that produces, on the CI runner and on the founder's device,
  the three numbers every later card is graded against. (a) `tools/search-probe.mjs`,
  a Node harness in the idiom of `tools/build-catalog-client.mjs` (same
  `--check`/`--out` argument shape), that loads the real committed catalogues and
  reports: **local-pass time** (`SearchEngine.searchShows` over the 220, and over
  the merged 19,904 once S-03 exists), **decode time** for the index, and
  **hit counts**, over a fixed 12-query battery (`l`, `le`, `lex`, `lex f`,
  `sci`, `science f`, `hist`, `the daily`, `radiolab`, `99%`, `zzqx`, and one
  non-ASCII title from the catalogue), 20 reps, reporting median and p95 — never
  a single sample. (b) A **breadth round-trip** measurement against `API_ORIGIN`:
  three forced-MISS samples and three repeat-HIT samples, recording
  `X-Vercel-Cache`, `Age` and the full `Cache-Control` **as received** (§1.4
  found the response is missing the `stale-while-revalidate` the source sets —
  the probe must notice that class of thing, not assume the source). Network
  samples are **skipped, not failed**, when the origin is unreachable, and the
  report says "no coverage" the way `parseSimulatorLifecycle` already does.
  (c) **Results-to-paint** in the page: a `search` entry kind in
  `player/diagnostic-log.js` (the idiom L-06 uses for `nowplaying`), written by
  `app.js` once per completed search with `{qLen, localMs, localHits,
  netMs, netHits, epMs, epHits, ctaMs, paintedMs, path, hidden}` — **query length, never the query
  text**, because `diagnostic-log.js`'s header is explicit that this record does
  not transmit and must not become a reason to reconsider that. Surfaced in the
  existing *Playback diagnostics* copy-out.
- **Owned:** `tools/search-probe.mjs` + `tools/search-probe.test.mjs` (new,
  floored), `player/diagnostic-log.js` + its test (floor → raise), `app.js`
  (the one call site), `test/search-probe-record.test.js` (new, floored;
  MUTATION: log the raw query string → red), `docs/search-plan.md` (a dated §1.6
  with the run id and the numbers).
- **Dependencies:** none. Day 0.
- **Acceptance:** a CI run id with the twelve-query table, median and p95, on the
  runner; a diagnostics copy from the founder's device carrying at least one
  `search` entry with a non-null `paintedMs`; the doc quotes both. **Not
  acceptable:** a single sample, a mean without a p95, or a network number with
  no `X-Vercel-Cache` beside it.
- **Governance:** all auto-merge paths.

#### S-02 · Live filtering, debounce, and the Go button (F2) — **M** — **DONE** (#657, 2026-09-12; `input` runs the local pass and fires nothing, the three expensive passes moved onto a 250 ms trailing debounce, Enter/Go skip it, clearing restores the A-Z list. G2's default taken: the button survives, the requirement does not. G1 having been ruled Option B, the network half shipped with the rest rather than staying behind the submit trigger)

- **Ask:** `renderAllShows` binds `input` on `#sh-input` as well as `submit` on
  `#sh-form`. On **every keystroke**: run the **local** pass and repaint —
  nothing else. On a **250 ms** trailing debounce after the last keystroke: run
  the passes that cost something. Reuse the exact idiom the show page's episode
  search already ships (`app.js:onSearchInputChange` / `runSearch`, `:2283`–`:2325`)
  — same 250 ms, same "Enter/submit runs immediately, no debounce wait", same
  token guard — rather than inventing a second debounce. `showSearchToken`
  already exists and already supersedes stale responses (`:3096`); extend it to
  cover the debounce timer so a fast retype cancels the pending tick as well as
  dropping the in-flight response.
  **Three things this card must not do**, each measured in §1.5:
  (1) the **episode** pass (`renderEpisodeSearchResults`, a second network call)
  moves onto the debounce tick with the breadth pass, never onto the keystroke;
  (2) the **playlist CTA**'s deferred `topicSearchStatus()` — 1.3–8 s cold —
  moves onto the debounce tick and additionally requires the query to have
  stopped changing, or it will freeze the page mid-word;
  (3) **while G1 is unanswered, the debounced network passes stay behind the
  submit trigger.** Ship the debounce plumbing, wire the local half to the
  keystroke, and leave the network half exactly as trigger-happy as it is today
  — no more. The moment G1 lands, one line moves it.
  **The Go button (G2):** the requirement goes, the affordance stays. Enter
  still submits; the button still submits; neither is needed to see results.
  If G2 says delete it, that is a one-line follow-up, not a redesign.
  A query the listener clears must return the page to its unfiltered A–Z list,
  not to an empty results box.
- **Owned:** `app.js` (`renderAllShows`, `renderShowSearchResults`,
  `renderEpisodeSearchResults`, `renderPlaylistSearchResults` call ordering),
  `test/show-search.test.js` (extend), `test/show-search-live.test.js` (new,
  floored: a keystroke repaints local results and fires **zero** fetches;
  N keystrokes inside 250 ms produce **one** debounce tick; Enter runs
  immediately; clearing restores the A–Z list — MUTATION: drop the
  `clearTimeout` → the "one tick" test goes red).
- **Dependencies:** S-01 (for the before number). Network half gated on **G1**.
- **Acceptance, measured by S-01's probe:** on the CI probe, **local results
  paint within 16 ms of the keystroke** at the 220-show scale (measured today:
  0.056–0.291 ms for the scan, so the budget is the paint, not the search);
  a 10-keystroke burst typed at 50 ms intervals produces **exactly one**
  debounced pass and **at most one** in-flight request at any instant; no
  `topicSearchStatus()` call occurs while the query is still changing.
- **Governance:** all auto-merge paths. No `index.html` touch.

#### S-03 · The breadth catalogue as a client-side prefix index — **L** — *design comment first* — **DONE** (#657, 2026-09-12; `tools/build-show-index.mjs` → `data/show-index.tsv`, 10,113 shows at the `chart_rank <= 100` cut, 436 KB raw / 201 KB gzipped. The design comment is at the top of the new module rather than in the PR thread — a thread is read once, that file is read by everyone who touches the index. **Option B**, and it needed NO new `sw.js` code: `cachePut`'s existing untracked-path branch already caches it, now pinned by name in `test/sw-generation.test.js`. G5 answered with measurements — the full 19,904 set is 398.4 KB gzipped against a 400 KB budget, a 0.4 % margin the next harvest breaks, and would put the native bundle at 89 % of its cap)

- **Ask:** a build step that emits a compact title index over the merged
  catalogue, and a client that loads it lazily and searches it in O(log n).
  **The build step:** `tools/build-show-index.mjs`, modelled line-for-line on
  `tools/build-catalog-client.mjs` (same `--out`/`--check` flags, same
  "refusing to write an empty derivation" guard, same field-list-is-the-contract
  header). Input: `data/catalog.json` + `data/catalog-breadth.json` minus
  `in_curated` rows. Output `data/show-index.tsv`: one row per show, **sorted by
  lowercased title**, `title \t id \t chart_rank \t curated`, where `id` is the
  curated `show_id` or `String(apple_collection_id)` (matching
  `backend/src/catalog/breadthCatalog.ts`'s minted id exactly, so a tapped
  result resolves through the existing `state.breadthShowCache` path unchanged).
  **The structure, and why** (§1.3 has the numbers): a **sorted array plus
  binary search**, not a trie and not an FST. A prefix query is two binary
  searches — lower bound of `q`, lower bound of `q + "￿"` — and the hits
  are the slice between them. A substring query falls back to the linear scan,
  which is **12.9–19.9 ms measured**, and therefore runs **only on the debounce
  tick and only when the prefix pass returns fewer than 10 hits**. A trie or FST
  answers the same prefix question for a bespoke binary format and a decoder
  nobody else in this repo reads; these numbers do not justify it.
  **The budget:** **≤ 400 KB gzipped**, against **375.8 KB measured** for the
  full 19,904 rows. If G5 rejects that, the card ships the `chart_rank ≤ 100`
  cut (189.0 KB, 10,113 shows) behind the same code path and records the
  trade in the PR — **do not front-code it**, that was measured and it costs
  22 KB gzipped rather than saving anything.
  **The load strategy, and this is the part that bites:** lazy, on the **first
  focus** of `#sh-input` — never at `init()`. Decode is 140.5 ms measured, so it
  runs once, off the keystroke path, and the local 220-show pass keeps serving
  until it resolves. It must **not** be fetched through `fetchJson()`: that pins
  to the deploy generation and `sw.js:handleData` returns a bare 504 for a
  pinned file the generation does not hold (§1.5). Two honest options; **the
  design comment must pick one and say why**:
  **(A) precache it.** Add `show-index.tsv` to `RUNTIME_DATA` in **both**
  `tools/web/prepare-dist.mjs` (or it is not served at all) and
  `tools/ci/generate-manifest.mjs` (or it is not precached), fetch it with
  `fetchJson()`. Cost: +376 KB on an all-or-nothing precache that already
  re-downloads `data/discover.json` (2.41 MB) on every nightly deploy — a ~15 %
  increase. `tools/ci/` is **DENIED** → this option needs **G4**'s label.
  **(B) runtime-cache it.** Serve it from `prepare-dist.mjs` only, fetch it
  unpinned, and add a runtime-cache branch to `sw.js:handleData`. Cost: new code
  in the highest-privilege file on the origin, for a file that is a pure
  build artefact. No label needed (`sw.js` is allowlisted) — which is precisely
  why the comment has to argue it rather than default into it.
  **The mobile bundle:** `tools/mobile/prepare-webdir.mjs`'s `runtimeDataFiles()`
  scans for **literal `fetchJson("data/…")` call sites**, so option B's unpinned
  fetch is invisible to it. Either way the file needs an explicit
  `PROJECTED_DATA` entry with its own per-file budget, checked against
  `MAX_BYTES = 3 * 1024 * 1024` and the ~740 KB of headroom the source names.
  **`docs/CATALOG-PIPELINE.md` requirement #5** says *"the web client never
  fetches the breadth file."* This card does not violate it — it ships a
  derived title projection, not the 12.5 MB file, exactly as
  `catalog-client.json` is a projection of `catalog.json` — **but the
  requirement's wording must be amended in the same PR** to say so, or the next
  reader will read a rule this deck appears to have broken.
- **Owned:** `tools/build-show-index.mjs` + `.test.mjs` (new, floored),
  `data/show-index.tsv` (new), `search-engine.js` (`prefixSearchShows`, pure, no
  DOM, exported on `SearchEngine` beside `searchShows`), `app.js` (lazy load on
  first focus; the local pass prefers the index when loaded), `test/show-index.test.js`
  (new, floored; MUTATION: unsort the emitted file → binary search returns wrong
  hits → red), `tools/web/prepare-dist.mjs`, `tools/mobile/prepare-webdir.mjs`
  + its test, `docs/CATALOG-PIPELINE.md` (requirement #5's amendment), and —
  **option A only** — `tools/ci/generate-manifest.mjs` + `deploy-manifest.json`.
- **Dependencies:** S-01 (the budget argument needs the before numbers), S-02
  (there must be a keystroke path for the index to serve).
- **Acceptance:** `node tools/build-show-index.mjs --check` is green in CI and
  the emitted file is **≤ 400 KB gzipped** (assert the gzipped size in the test,
  not the raw size); `prefixSearchShows` returns the same results as a reference
  linear filter on all 12 probe queries (property test over the real committed
  index, not a fixture); the prefix pass is **under 1 ms at p95** on S-01's
  probe over all 19,904 rows; the index is fetched **zero** times before
  `#sh-input` is focused and **once** thereafter (assert the fetch count); the
  app renders correctly with the index fetch failing (the 220-show pass is the
  fallback and the failure is silent, per this file's "absence is a real state"
  rule); the mobile bundle stays under `MAX_BYTES` with the delta reported in
  the PR.
- **Governance:** everything auto-merges **except** option A's
  `tools/ci/generate-manifest.mjs` → **`founder-approved`, G4**. If the label
  wait would block, split that one file into its own PR.

#### S-04 · Ranking: exact, prefix, word-start, substring — with the popularity prior — **M** — **DONE** (#657, 2026-09-12; four buckets, curated before breadth, `chart_rank` bucketed `<=10/<=50/<=200/unranked` because it is per-genre, then a cached-collator `localeCompare`. `node tools/test-search.mjs` passes unchanged. The server rule in `backend/src/catalog/searchBreadthShows.ts` was NOT mirrored — the divergence is deliberate, recorded in `docs/DECISIONS.md`, and defensible only while S-03 keeps the endpoint off the interactive path. U-05's "no `search-engine.js` scoring changes" line needs a pointer here)

- **Ask:** one ranking rule, in `search-engine.js`, applied to the local pass and
  the index pass alike. Buckets, in order: **0** exact title match
  (case-insensitive, after trimming); **1** title starts with the query;
  **2** a **word** in the title starts with the query (so `fridman` reaches
  *Lex Fridman Podcast* — today's `rank === 2` substring bucket buries it);
  **3** substring anywhere. Inside a bucket: **curated before breadth** (the
  same tie-break `backend/src/catalog/searchBreadthShows.ts` already applies
  server-side), then the **popularity prior**, then `title.localeCompare` so
  ties are stable and deterministic for a fixed snapshot.
  **The prior is `chart_rank`**, and its limits are measured and must be
  respected: it is present on **all 19,787** breadth rows, it is Apple's
  **per-genre** chart position 1–200 (paired with `chart_genre_id`), and it is
  from the **2026-07-09** harvest. It is therefore **not comparable across
  genres** — rank 3 in *Life Sciences* is not rank 3 in *Comedy*. Use it
  **bucketed** (deciles, or `≤10 / ≤50 / ≤200`), never as a raw cross-genre
  score, and say so in the header. Curated shows carry no `chart_rank` and do
  not need one: they are already first inside their bucket.
  **Do not touch the topic scorer.** `interpretQuery` / `scoreMatch` /
  `searchWithRelaxation` answer a different question, `searchShows`'s own header
  says so, and `tools/test-search.mjs` is **DENIED** — its battery must pass
  **unchanged** and this card must not edit it.
  **The server half:** `backend/src/catalog/searchBreadthShows.ts` reimplements
  the client's rule deliberately (there is no shared-module boundary without a
  build step neither side has). If this card changes the client rule, the server
  rule diverges. Either mirror it in the same PR — `backend/src/` is **DENIED**,
  so that needs **G4** — or state plainly in the PR that the two now differ,
  which is only defensible if S-03 has landed and the server is no longer on the
  interactive path. Prefer the second; say which.
- **Owned:** `search-engine.js`, `test/show-search.test.js` (extend),
  `test/show-search-ranking.test.js` (new, floored: exact beats prefix beats
  word-start beats substring; `fridman` puts *Lex Fridman Podcast* first;
  curated beats breadth on an equal bucket; two shows with equal everything come
  back in a stable order across 20 runs — MUTATION: sort by raw `chart_rank`
  across genres → the cross-genre case goes red), and — only if mirrored —
  `backend/src/catalog/searchBreadthShows.ts` + `backend/test/`.
- **Dependencies:** S-03 (the prior only exists in the index).
- **Acceptance:** `node tools/test-search.mjs` passes **unchanged** (paste the
  before/after line counts in the PR); the four buckets are asserted against the
  **real committed** catalogue, not a fixture; ordering is byte-identical across
  20 consecutive runs of the probe battery.
- **Governance:** `search-engine.js` and `test/` auto-merge; the optional
  `backend/src/` mirror needs **G4**'s label.

#### S-05 · Stop paying for the round trip: cache the hot queries, fix the degraded header — **S** — **DONE** (#657 and #658, 2026-09-12; the in-memory hot-query cache landed in #657, the degraded header in #658)

- **Ask:** three small things, and one deliberate refusal.
  (1) **In-memory hot-query cache in the client.** `fetchApiJson` passes
  `{ cache: "no-cache" }` (measured), so the browser cache is defeated by design
  and `max-age=300` buys the app nothing. Add a bounded `Map` of
  `normalized query → results` in `app.js` (cap it, LRU or simple FIFO — say
  which; follow `buildPlaylist`'s existing `SEARCH_CACHE_MAX` idiom rather than
  inventing a second cache convention), consulted before the debounced breadth
  pass fires. A retype of a query typed 3 s ago should cost nothing.
  (2) **The degraded path's missing header** (#560 item 10, requirements §6.12):
  `api/shows/search.ts`'s catch branch sets no `Cache-Control` at all, so an
  empty degraded response can be edge-cached under Vercel's default while the
  other two endpoints set `no-store` on theirs. Set `no-store`. One line.
  (3) **Record what the edge actually returns.** §1.4 measured
  `Cache-Control: public, max-age=300` in the response where the source sets
  `public, max-age=300, stale-while-revalidate=3600`. Either add an explicit
  `s-maxage` and re-measure, or write the finding into the source's header so
  the next reader is not misled. Do not silently keep a directive that does not
  arrive.
  **The refusal, and it is the point of the card:** **no warm-up ping, and no
  keep-warm cron.** Measured: MISS ttfb 0.72–0.88 s, HIT ttfb 0.41–1.12 s — a
  ~0.3 s delta on a ~0.8 s wall time. Cold start is not what makes search feel
  slow; the round trip is, and S-03 removes it. A warm-up ping would add a
  scheduled job and buy a third of the wrong number. Say that in the PR.
- **Owned:** `app.js` (the cache), `api/shows/search.ts` (the header +
  the source-comment correction), `test/show-search-cache.test.js` (new,
  floored; MUTATION: remove the cache lookup → the "second identical query
  fires no fetch" test goes red), `api/test/` (a case for the degraded
  branch's header).
- **Dependencies:** **G1**. S-02.
- **Acceptance:** a repeat of an identical query inside the cache window fires
  **zero** network requests (assert the fetch count); the degraded branch
  responds with `Cache-Control: no-store`; S-01's probe re-run shows the
  received `Cache-Control` and it matches what the source claims.
- **Governance:** `app.js`, `test/` auto-merge. **`api/shows/search.ts` is
  unlisted → human merge (G3).** Batch it with S-06's `api/` change into one PR
  if the two land together.

#### S-06 · Fall-through to Apple's directory, and a breadth show page that survives a reload — **L** — *design comment first* — **DONE** (#658, 2026-09-12; the Apple fall-through on a zero-hit local query, and breadth show pages that are linkable and survive a reload)

- **Ask:** two halves that share one endpoint change, which is why they share a
  card.
  **(a) The fall-through.** When a query returns **zero** hits from the local
  index, ask Apple. **Server-side, in `api/shows/search.ts`**, reusing the
  machinery `api/episodes/search.ts` already ships and has tests for:
  `SlidingWindowBucket` (`api/episodes/appleBucket.ts`, **≤ 20/min**, with its
  honest per-warm-instance caveat — repeat that caveat, do not overclaim a
  global cap), `TtlCache` (`api/episodes/searchCache.ts`, 1 h by normalized
  query), the 8 s timeout, and the honest User-Agent
  `Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)`. Call
  `https://itunes.apple.com/search?entity=podcast&term=…`. Map each hit into the
  shape `renderShowSearchResults` already caches:
  `{show_id: String(collectionId), title: collectionName, artwork_url:
  artworkUrl600, tier: "breadth", editorial_note: null, taxonomy_node_ids: []}`
  — and **keep `artistName`**, because §1.1 measured that it is the author field
  our own breadth catalogue does not have, and it is the only place the
  Pocket Casts "titles *and authors*" half becomes available at all. Rate-limit
  exhaustion returns the local results with a flag, never an error.
  **Why server-side, argued rather than assumed:** doing it from the client
  would need `https://itunes.apple.com` in `index.html`'s CSP `connect-src`,
  which today names exactly three sources and is pinned by
  `test/api-origin.test.js` ("the CSP names the API origin, and nothing wider").
  `index.html` is **unlisted** → a human merge, and the pin would have to be
  loosened. Server-side needs neither, reuses a rate limiter and cache that
  already exist and are already tested, and keeps the listener's query going to
  one origin instead of two. **The design comment must state this choice and its
  cost:** the fall-through inherits the ~0.8 s round trip S-03 just removed —
  which is acceptable precisely because it now happens only on a genuine miss.
  **(b) Linkability** (#560 item 7, requirements §6.8). `app.js:showById`
  resolves `state.catalog` then `state.breadthShowCache`, which is in-memory and
  populated **only** by a search response this session — so a cold open on
  `#/show/1234567890`, a shared link, a reload or a restored tab renders
  *"Show not found."* Add an id lookup: `GET /api/shows/search?id=<apple_collection_id>`
  returning the single merged-catalogue row (the function already holds that
  catalogue in memory via `loadBreadthCatalog`; this is a lookup, not a scan),
  and a `showById` fallback that calls it and seeds `breadthShowCache`. Once
  S-03 ships, the index answers most of these **without any network call at
  all** — say which path wins and why. `q` and `id` are mutually exclusive;
  neither present is still a `400`.
- **Owned:** `api/shows/search.ts` (the `id` param + the Apple fall-through),
  `api/shows/appleShowSearch.ts` (new, or reuse the episodes module — the
  comment must say which and not copy-paste a third rate limiter),
  `api/test/shows-search-apple.test.mjs` (new: the bucket refuses the 21st call
  in a window; a cached query does not re-call; an unmappable hit degrades
  rather than throwing), `app.js` (`showById` fallback, zero-hit trigger),
  `test/show-search-fallthrough.test.js` (new, floored; MUTATION: fire the
  fall-through on a non-empty local result → red), `api/test/vercel-bundle.test.mjs`
  (extend its hardcoded `TARGETS`, which #560 item 1 names as the reason that
  test passes while a gap is open).
- **Dependencies:** **G1**, **G3**. S-03 (zero-hit must mean "not in 19,904
  shows", not "not in 220" — otherwise the fall-through fires constantly and
  burns the 20/min bucket in seconds). **Do not start this before S-03 lands.**
- **Acceptance:** a query for a show in neither catalogue returns Apple hits and
  the first one is tappable; the tapped page **survives a reload** (open
  `#/show/<id>` in a fresh session — this is the #560 item 7 acceptance);
  synthetic burst of 25 queries in one minute against one warm instance yields
  at most 20 Apple calls and 5 honest empties; `api/test/vercel-bundle.test.mjs`
  covers every `api/**` runtime file reader, not two hardcoded targets.
- **Governance:** `app.js`, `test/` auto-merge. **`api/**` is unlisted → human
  merge (G3).** No `index.html` change — if the design comment reverses that and
  goes client-side, the CSP line makes this a second human-merge file and
  `test/api-origin.test.js`'s pin must be widened in the same PR.

#### S-07 · The privacy conditional: write both diffs, let the founder pick — **S** — **DONE** (#657, 2026-09-12; **G1 was ruled Option B on 2026-09-11** — `git show a554fb6`, `docs/DECISIONS.md` — so this card did not write both diffs, it wrote the one the founder chose. §2's conditional is gone and replaced with an affirmative unconditional statement; `SHOWS_SEARCH_OFF_DEVICE = true` arms `test/release-gates.test.js`'s AND-gate for real, its "the flag is false" test is inverted with the reason, and a new case pins that the replacement is affirmative rather than merely absent. Option A's cost and Option C's partial truth are both recorded in DECISIONS)

- **Ask:** this card does **not** decide. It makes the decision cheap by putting
  both answers side by side as real diffs, on a branch, and then waits for
  **G1**.
  **The gap, measured** (#560 item 2, requirements §6.11):
  `docs/legal/privacy-policy.md` §2 promises *"if a show or episode is already
  in that local catalogue nothing you typed leaves your device."*
  `renderShowSearchResults` fires `api/shows/search` and
  `renderEpisodeSearchResults` fires `api/episodes/search` **unconditionally**;
  the only guard anywhere is `navigator.onLine === false`. There is no
  local-hit branch. So **every** Shows search transmits the query, including one
  that matched locally. `test/release-gates.test.js` does not catch it, and its
  header says why on purpose.
  **Option A — honour the promise in code.** Gate both network passes on a local
  **miss**. Cost, measured: 37 of the 19,904 merged titles contain `"lex"`, and
  1 of the 220 curated titles does — so under today's 220-show local pass, a
  listener typing `lex` would see one show and never the other 36. That
  contradicts the founder answer recorded in `docs/DECISIONS.md` **2026-09-02**:
  *"the user should never notice any limitations based on our own limited
  curation."* Write the diff anyway; it is three lines.
  **Option B — the sentence loses its condition.** Rewrite §2 to say plainly
  that a Shows search sends the typed query off-device, that the query and
  nothing else is what is sent, and to whom. Cheaper, honest, and it costs the
  promise. `docs/legal/data-safety.md` already flags this sentence class as
  "worth a lawyer's eye" — note that in the PR.
  **Option C, which this deck recommends, and the reason S-03 and S-07 are
  sequenced together.** Once S-03 puts all **19,904** titles on the device, the
  local pass covers everything the breadth endpoint covers. The only off-device
  call left is S-06's Apple fall-through, which by construction fires **only on
  a genuine zero-hit** — at which point the shipped sentence becomes **true as
  written**, with no product loss and no rewrite. Option A's cost disappears
  because the local catalogue stops being 220 shows and becomes the catalogue.
  **What the card ships regardless of the answer:** a `test/release-gates.test.js`
  case that pins whichever contract wins — a network call on a local hit either
  fails the gate (A/C) or is explicitly permitted with the policy line quoted
  beside it (B) — so this cannot drift back open silently, and a
  `docs/DECISIONS.md` entry recording the choice and its cost.
- **Owned:** `docs/legal/privacy-policy.md` **or** `app.js` (whichever the
  answer selects — the branch carries both, only one is merged),
  `test/release-gates.test.js` (floor → raise), `docs/DECISIONS.md`,
  `docs/product/suggested-shows-requirements.md` (§6.11 and §6.13 row 6 →
  RESOLVED).
- **Dependencies:** none to start. **G1 to finish.**
- **Acceptance:** both diffs exist on the branch and each is independently
  green; the release-gate case fails when the losing behaviour is reintroduced
  (state the mutation); `docs/DECISIONS.md` records the choice, the cost of the
  option not taken, and the date.
- **Governance:** `docs/legal/`, `app.js`, `test/` auto-merge.
  **`docs/DECISIONS.md` is DENIED → `founder-approved` (G4).**

#### S-08 · Records, and the after numbers — **S** — **DONE** (#658, 2026-09-12; the after table is §1.7 above, measured on `feat/search-deck-s02-s08`)

- **Ask:** close the loop the way the other decks do.
  Re-run **S-01's probe** on the CI runner and paste the after table beside the
  before table in this file's §1.6 — every acceptance number in this deck is a
  claim until that table exists.
  Update `docs/product/suggested-shows-requirements.md`: **§3.3** (the Go button
  paragraph and the two-pass description are both wrong once S-02/S-03 land),
  **§6.2** (F2 → RESOLVED, with the PR), **§6.8** (breadth show linkability →
  RESOLVED by S-06), **§6.11** and **§6.13** rows 1 and 6 (→ RESOLVED by S-07,
  G2), and **§7.2** (the new constants).
  `docs/DECISIONS.md`: one entry for the client-side index (what it costs in
  bytes, what it buys in latency, and the `CATALOG-PIPELINE.md` #5 amendment),
  one for the ranking rule and the client/server divergence S-04 either created
  or avoided.
  `STATE.md` entries per PR as they land. **File the F2 issue** — requirements
  §6.2 records that "**No issue is filed**" — and comment on **#560** with what
  this deck resolved (items 2, 7, and 10's `Cache-Control` half), what it
  corrected (item 1's severity, §1.4 — production is not failing green), and
  what it deliberately did not touch (items 4, 5, 6, 8, 9).
- **Dependencies:** every other card merged.
- **Governance:** docs auto-merge; **`docs/DECISIONS.md` → `founder-approved`
  (G4)**, batched with S-07's.

---

## 5. Sequencing

```
Day 0 (parallel):   S-01 Measure (no dependencies)
                    S-07 Privacy (writes both diffs, then waits on G1)
                    ----------------------------------------------------
Then:               S-02 Live filtering + debounce  ← S-01
                       · local half ships immediately
                       · network half held behind G1
Then:               S-03 Client-side index  ← S-01, S-02        (G5 sets the cut; G4 if option A)
Then:               S-04 Ranking  ← S-03                        (G4 if the server is mirrored)
Then:               S-05 Hot-query cache + degraded header  ← G1, S-02   (G3: api/)
Then:               S-06 Apple fall-through + linkable pages ← G1, G3, S-03
                       NOT before S-03: "zero hits" must mean 19,904, not 220
Last:               S-08 Records + the after numbers  ← everything
Human:              G1 as early as possible — it gates four cards
                    G2 any time before S-02's final copy
                    G3 / G4 batched with the R-deck's and L-deck's label sittings
                    G5 once S-01 has the before numbers
```

**S-01 and S-07 are first, and for opposite reasons.** S-01 first because every
other card's acceptance is a number this deck does not yet have on the runner or
on a phone. S-07 first because it is the only card that can make the others
unshippable, and the founder should be looking at both diffs while Hermes is
still building the cheap parts.

**S-03 is the hinge.** It is what makes the search fast (removes a ~0.8 s round
trip from the interactive path), what makes the ranking prior available at all
(`chart_rank` is not on the client today), what makes the Apple fall-through
affordable (a zero-hit over 19,904 titles is rare; a zero-hit over 220 is
constant), and what makes the shipped privacy promise true without a rewrite.
If only one card ships, ship that one.

---

## 6. Coordination

- **U-05** (`docs/ui-transition-plan.md`) owns the Shows page's *look* and its
  Playlists results section, and its own acceptance line says *"Ranking is
  presentation-only: `node tools/test-search.mjs` must pass unchanged and no
  `search-engine.js` scoring changes."* **S-04 changes exactly that file.** The
  two must not be in flight simultaneously on `search-engine.js`. S-04 keeps
  `tools/test-search.mjs` green — that half of U-05's promise is preserved — but
  U-05's "no scoring changes" line needs a pointer to this deck when S-04 lands.
  Name it in both PRs.
- **L-06 / M-03** (`docs/ios-controls-and-voice-plan.md`) both add entry kinds to
  `player/diagnostic-log.js`, and so does **S-01**. Three cards, one file, one
  floor in `test/suite-integrity.test.js`. Land them in whatever order they are
  ready and raise the floor each time; do not batch them into one PR across two
  decks.
- **#560 item 1** (the `api/episodes/**` `includeFiles` glob) is **not** a card
  here, but §1.4 measured that production is healthier than the issue assumes
  and **S-06 extends `api/test/vercel-bundle.test.mjs`** — the test whose two
  hardcoded targets are why item 1 passes CI. Whoever takes item 1 should read
  §1.4 first and re-scope.
- **#279 / requirements §6.4** — promoting breadth shows into the curated tier,
  and giving them subjects — is the discovery half of the same complaint this
  deck answers for lookup. This deck deliberately does not touch it (§7). S-03's
  index makes the *selection* problem easier to work on, not harder: the
  candidate list is now on the device.
- **`tools/harvest-catalog.mjs`** is where the missing author field (§1.1) would
  come from. Not a card here. If a re-harvest is scheduled for any other reason,
  keeping `artistName` is a one-line addition and it is what makes a real
  title-**and**-author index possible.

---

## 7. Non-goals

- **Restyling anything.** Hermes' U-deck owns the Shows page's look
  (`docs/ui-transition-plan.md` U-05). This deck changes what the field *does*,
  not what it looks like. No new CSS beyond what a new result bucket strictly
  needs.
- **A new backend service.** Everything server-side here is an edit to the
  existing `api/shows/search.ts` function, reusing the rate limiter and cache
  `api/episodes/` already ships. No database, no queue, no second origin, no
  scheduled warm-up job (§1.4 says why the last one would not help).
- **Semantic or embedding search.** `interpretQuery` / `scoreMatch` /
  `searchWithRelaxation` and `data/semantic-index.json` answer "what should I
  listen to". This deck answers "does this show exist here".
  `search-engine.js:searchShows`'s own header says the two must not be merged,
  and `tools/test-search.mjs` is a DENIED path this deck does not edit.
- **The international catalogue.** `data/catalog-breadth-intl.json.gz` (121,786
  shows, read by nothing — #560 item 6) stays dead weight. Indexing it is a
  different budget question and a different founder decision.
- **Giving breadth shows subjects** (#560 item 4, requirements §6.4/§6.13 row 5),
  **fixing the 32 empty browse pills** (§6.7), or **promoting anything into
  `data/catalog.json`** (#279). Discovery, not lookup.
- **Transmitting search queries as telemetry.** S-01's probe records query
  *length* and never query *text*, and `player/diagnostic-log.js` does not
  transmit. Changing that is a separate change behind a real consent gate and
  has to be argued on its own — which is exactly what that file's header already
  says about everything else in it.
