# Suggested shows — show discovery and recommendation, as built

**Status:** authoritative reference for what the app **actually does** when it
suggests, lists, ranks or looks up a *show*, read out of the code on
`origin/main` @ `92d1bad`, 2026-09-09.
**Audience:** founders and agents. It assumes no knowledge of the codebase.
**Sibling document:** `docs/curation/foray-generation-requirements.md` (branch
`generation-run-2026-09-09`) does the same job for Foray generation. This one
answers the founder's follow-up ask — *"Similar to the requirements page for
forays, we should likely have one for playlists and for suggested shows."*
Playlists are a separate document.

**Relationship to the other documents:**

| Document | What it is | Authority |
|---|---|---|
| `docs/show-pages-plan.md` | The 2026-08-31 design plan (Stages 1–4). Its own header says *"Planning only — no implementation in this change."* | Design intent. Stages 1, 2, 3b and 4 have since shipped; where the plan and the code disagree, **the code is what runs** and this document says so. |
| `docs/CATALOG-PIPELINE.md` | The 2026-07-09 two-tier catalogue architecture and the harvester it specifies. | Built, but partially stale (its "~150 shows" is now 220 — flagged by `docs/catalog-growth-plan.md` §0). |
| `docs/catalog-growth-plan.md` | The path from 19,787 breadth shows to a playable English catalogue. Header: *"Planning only."* | **Design only.** Nothing in Stages 0–4 is built. |
| `C:\Users\wjduv\Desktop\4a-shows-pipeline-plan.md` (off-repo) | The founder/Joey show-intake plan, 2026-09-04, addendum 2026-09-07. Its own header: *"Nothing in it is built yet."* | **Design only.** Its D-numbers and card ids (S-02, S-04, S-06, S-07, S-16…) are cited here where shipped code implements one. |
| `docs/curation/interest-survey-plan.md` | The interest-chip survey. Carries the `hold` label. | Partially built — §4.1/§4.3's subtree rule and seed lift ship in `app.js`; the survey itself does not. |
| **This document** | What the code does, surface by surface, function by function. | The single reference. Every claim cites `path:function`. |

Nothing here is invented. Where behaviour is absent, this document says
**"not implemented"** or **"design only"**. Counts are what the committed files
hold, measured 2026-09-09; where a `docs/` file quotes a different number it is
stale and this document uses the measured one and says which doc is stale.

---

## 1. Purpose and scope

### 1.1 What "a suggested show" means here

A **show** is a podcast — a feed, a title, artwork, a publisher. It is not
playable. Every show surface in 4a is a *navigation* surface: it hands the
listener a link to `#/show/:show_id`, and the show page hands them episodes,
which are playable. `app.js:showResultRow` enforces this shape — a show row
carries artwork and a title and **no play, star or duration control**, because
it "names a SHOW, not a playable item".

This document governs every surface where 4a decides *which shows to put in
front of a listener*, and every mechanism behind those decisions.

### 1.2 The five surfaces, and what each one promises

| # | Surface | Route / function | What it promises the listener | What it actually reads |
|---|---|---|---|---|
| 1 | **Home** | `#/` → `app.js:renderHome` → `app.js:renderHomeV2` | Nothing about shows. Home has four sections — greeting, Jump back in, Forays for you, Playlists for you, Episodes for you — and **no show-shaped row at all**. | Show names appear only as `app.js:showNameLink` inside an episode card. |
| 2 | **Shows tab** | `#/shows` → `app.js:renderAllShows` | "Does this show exist here?" — a search box, a browse-by-subject pill row, a starred-shows link, an editorial row, and an A–Z index. | `state.catalog` (the 220 curated shows), `state.taxonomy`, plus two live endpoints. |
| 3 | **Show page — "Similar shows"** | `#/show/:id` → `app.js:similarShowsSection` | "Shows like this one." | `state.catalog` only. Up to 6. |
| 4 | **Search results** | `#/shows`, after a submit → `app.js:renderShowSearchResults` | Three result blocks — Shows, Episodes, Playlists — for one typed query. | Local catalogue, then `GET /api/shows/search`, then `GET /api/episodes/search`, then local playlists. |
| 5 | **First-run chips** | `app.js:showFirstTimeExplainerOnce` → `renderPreferences` | "What are you into?" — 17 subject chips plus a free-text field. | Writes `state.interests`; **never suggests a show**. It moves the weights that Home's *episode* picks read. |

Two consequences worth stating plainly, because they are the shape of the
whole feature:

- **Nothing in 4a recommends a show from a listener's behaviour.** Starring a
  show writes `cp_starred_shows` and, by explicit design, "changes nothing
  about what the app recommends or fetches" (`app.js:starredShowsMap` header).
  `state.interests` moves episode and playlist selection only. The only two
  show-ranking mechanisms in the product are **taxonomy-node overlap**
  (`app.js:similarShows`) and **a calendar-day seeded shuffle**
  (`app.js:showsWeVouchFor`). Neither reads any signal about the listener.
- **Show discovery is name-lookup first.** `docs/show-pages-plan.md` §2's
  framing — "the two ask different questions (*what should I listen to* vs
  *does this show exist here*)" — is enforced structurally: the topic scorer
  (`search-engine.js:searchWithRelaxation`) never ranks shows, and
  `search-engine.js:searchShows` never tokenises or stems.

### 1.3 What this document does not govern

- **Playlist and Foray generation.** `app.js:generatedPlaylists`,
  `app.js:buildCards` and `player/foray-*.js` are described only where a show
  surface reads them (§3.5, §5.4).
- **Playback.** Once a listener taps an episode row, `player/client.js` owns it.
- **Foray tape sourcing.** `docs/curation/foray-generation-requirements.md` and
  ADR-0007/0008 own which shows can be *cut into a Foray*. §4.3 explains why
  that constraint does not currently reach show discovery at all.
- **The corpus database.** Joey's Postgres (`foray-db`, tailnet-only) is not on
  any request path; see §6.9.

---

## 2. Inputs and storage

### 2.1 The three catalogues, and what each one is for

There are three distinct show catalogues plus a client projection. They are
easy to confuse and they do not contain the same shows.

| File | Size | Shape | Shows | Who writes it | Who reads it |
|---|---|---|---|---|---|
| `data/catalog.json` | 172,616 B | `{version, built_at, notes, shows[]}` | **220** | Hand curation, 11 commits ever (§2.5) | `tools/build-catalog-client.mjs`, `backend/src/catalog/breadthCatalog.ts`, `api/shows/[show_id]/episodes.ts`, `api/episodes/*`, `tools/refresh/scan.mjs` |
| `data/catalog-client.json` | 102,550 B | `{version, shows[]}` | **220** | `tools/build-catalog-client.mjs:buildCatalogClient` | **`app.js` only** — `init()`'s `fetchJson("data/catalog-client.json")` → `state.catalog` |
| `data/catalog-breadth.json` | 12,486,611 B | `{version, built_at, region, source, genre_count, shows[]}` | **19,787** (US) | `tools/harvest-catalog.mjs` | `backend/src/catalog/breadthCatalog.ts`, `api/shows/[show_id]/episodes.ts:loadShowIndex`, `api/episodes/search.ts:loadShowMeta`. **Never fetched by the client** (`docs/CATALOG-PIPELINE.md` §"Forward-compatibility requirements" #5) |
| `data/catalog-breadth-intl.json.gz` | 13,779,425 B | same, 18 storefronts | **121,786** | same harvester, `--regions` | **Nothing.** No endpoint, tool or test reads it (§6.5) |
| `data/discover.json` | 2,414,655 B | `{version, built_at, items[]}` | **2,080 episodes** across 221 distinct `show` strings | The nightly (§3.7) | `app.js:fullPool`, `app.js:episodesForShow`, `app.js:showArtworkUrl` |

**The join.** `data/discover.json` items carry **no `show_id`** — measured, 0 of
2,080. The join key between an episode and its show is the **title string**
`item.show`, matched against `catalog.json`'s `title`:

- `app.js:episodesForShow` — `new Set([show.title, TITLE_ALIASES[show.title]])`
  then `pool.filter(it => wanted.has(it.show))`, sorted newest-first by
  `app.js:dateValue(release_date)` (an unparseable date sorts to epoch-0, i.e.
  last).
- `app.js:showIdForShowName` — the reverse lookup, used by
  `app.js:showNameLink`.
- `app.js:TITLE_ALIASES` holds exactly one entry, for *Lingthusiasm*, whose
  `catalog.json` title carries a subtitle its `discover.json` `show` field does
  not. The header states a second entry "is a sign the underlying assumption
  needs revisiting, not that this list needs a third line."

**Show identity across the two tiers.** `docs/CATALOG-PIPELINE.md` makes
`apple_collection_id` the shared primary key. Curated shows additionally carry a
slug `show_id`; breadth shows have none, so
`backend/src/catalog/breadthCatalog.ts:loadBreadthCatalog` mints
`String(apple_collection_id)` as the id — the same id
`api/shows/[show_id]/episodes.ts:loadShowIndex` resolves. There is **no
`podcastGuid` anywhere in the client path**; `tools/harvest-catalog.mjs` writes
`podcastindex_id: null` on every breadth row, and the GUID only appears in the
`tools/shows/` dump importer (`tools/shows/dedupe.mjs:groupKeyFor` prefers
`guid:<podcastGuid>` over `ta:<title>|<author>`), which does not ship.

### 2.2 Field-level shapes

**`data/catalog.json` `shows[]`** — 13 fields:

```
show_id              slug, e.g. "engines-of-our-ingenuity"; the #/show/:id key
title                the join key against discover.json's `show`
apple_collection_id  Apple's id; the join key against catalog-breadth.json
feed_url             the publisher's RSS URL — read server-side only (§2.4)
artwork_url          600x600 https, or null (53 of 220 are null — §6.12)
apple_genre          Apple's own genre string, kept raw
episode_count        the publisher's own count at harvest time
editorial_note       4a's one-line vouch. 220 of 220 are non-empty
taxonomy_node_ids    1 or 2 data/taxonomy.json node ids — see below
archetype_fit, cadence_hint, explicit, source
```

**Measured distribution of `taxonomy_node_ids`** — this is the single most
load-bearing number in this document:

| Nodes on a show | Shows |
|---|---|
| 0 | **0** |
| 1 | **170** |
| 2 | **50** |
| ≥ 3 | **0** |

Mean 1.23, max 2. `tools/refresh/topics.mjs` allows `MAX_TOPICS = 5` and its own
comment records "the nightly prompt asks for 1-3, and the whole catalogue's
maximum is 2."

**`data/catalog-client.json` `shows[]`** — `tools/build-catalog-client.mjs`
projects exactly six fields (`CLIENT_SHOW_FIELDS`): `show_id`, `title`,
`artwork_url`, `editorial_note`, `taxonomy_node_ids`, `episode_count`. Dropped:
`apple_collection_id`, `feed_url`, `apple_genre`, `archetype_fit`,
`cadence_hint`, `explicit`, `source`. The script's header records the reason and
the measurement: 134,788 B (33,632 gzip) → 83,552 B (25,451 gzip), **~24 % gzip
saving**, and notes `feed_url` is "a legally-relevant field per CLAUDE.md
product principle #3" deliberately kept out of a public static fetch.

**`data/catalog-breadth.json` `shows[]`** — 17 fields, all harvest provenance:
`apple_collection_id, title, feed_url, artwork_url, apple_genre,
apple_genre_ids, episode_count, explicit, chart_genre_id, chart_genre_name,
chart_rank, in_curated, podcastindex_id (always null), tier ("breadth"), region,
harvest_source, harvested_at`. **103** rows carry `in_curated: true`; 19,726 of
19,787 carry a `feed_url`.

**`data/discover.json` `items[]`** — 16 fields: `id, show, title,
apple_collection_id, apple_track_id, apple_episode_url, release_date,
duration_min, artwork_url, topics, hook, audio_url, audio_type, audio_bytes,
duration_sec, dai_suspected`. The taxonomy field here is **`topics`**, not
`taxonomy_node_ids`.

**`data/taxonomy.json` `nodes[]`** — **194** nodes, `{id, parent, label,
apple_anchor, weight, confidence, last_evidence_at}`. **41 roots**
(`parent === null`), 153 children. Exactly two levels — no node's parent has a
parent (`docs/research/taxonomy-review-2026-08.md` §3.5), which is why
`app.js:expandTaxonomyPick` needs one parent-lookup and no recursion.

**`data/semantic-index.json`** — 120 concepts, `{terms, topics, related}`. Read
by the topic scorer (`search-engine.js`), **not** by any show surface.

### 2.3 The three population scales, and the sourcing constraint

| Pool | Count | Source |
|---|---|---|
| Curated | **220** shows / 2,080 episodes | `data/catalog.json` + `data/discover.json`. Cited at `docs/show-pages-plan.md` §1 and `docs/curation/interest-survey-plan.md` §1.2 ("220 shows, **zero** with an empty `taxonomy_node_ids`"). |
| Harvested breadth | **138,470** unique feeds (19,787 US + 121,786 intl, 1,157 overlap) | `docs/curation/catalogue-broadening.md` §1: *"Our catalogue is **138,470 unique feeds** after normalising scheme, case and trailing slash… The dump is **34x larger**; we hold **2.94 %** of it."* Per-file breakdown at `docs/curation/grilling-foray-sourcing.md` §5.1. |
| PodcastIndex universe | **4,712,165** feeds / 165,012,527 episodes | `docs/curation/grilling-foray-sourcing.md` §5.4 (keyless `stats.podcastindex.org/daily_counts.json`, 2026-08-15); the bulk dump itself carries 4,710,545 rows (`docs/curation/catalogue-broadening.md` §1). |

`docs/catalog-growth-plan.md` §0 quotes **~141,500** for the middle row. That is
the *undeduped* sum and disagrees with `catalogue-broadening.md`'s 138,470.
**Use 138,470.**

**The sourcing constraint, stated correctly.** A DAI (dynamic-ad-insertion) host
stitches ads per request, so the same episode GUID serves different bytes and a
duration that moves by 1–4 minutes; a timestamp authored against one copy does
not survive into another (ADR-0007 §Context). The named blocklist is **data, not
prose** — `tools/refresh/dai-hosts.json`, `_matching: "suffix"`, 16 hosts:
`megaphone.fm, art19.com, acast.com, omny.fm, simplecast.com,
simplecastaudio.com, spreaker.com, anchor.fm, tritondigital.com, podbean.com,
buzzsprout.com, captivate.fm, transistor.fm, redcircle.com, omnycontent.com,
prxu.org`; consumed by `tools/refresh/dai.mjs:DAI_HOSTS` / `isDaiHost`.

Two corrections that a requirements document must not get wrong:

1. **DAI is no longer a reason to reject a show.** ADR-0008 (*Accepted — Wyatt,
   2026-08-16*) reverses the binary gate three sourcing documents had been
   applying: *"Ads should not be a blocking issue as long as we can find the
   approximate right timestamp."* Ad load now decides **how a segment anchors**
   (≤ 120 s → padded and playable; > 120 s → authored now, played once
   ADR-0007's anchor-resolution rung exists), never whether a show can be
   sourced. `docs/DECISIONS.md`: *"`tools/transcribe/ad-inflation.mjs` survives
   as a **label**, not a verdict."*
2. **The blocklist has never been an intake filter.** No harvester, importer or
   nightly step consults it to exclude a show. It stamps `dai_suspected` on an
   episode in `tools/refresh/merge.mjs` (from `data/dai-classification.json`,
   220 shows) and gates seek precision. Measured exposure, ADR-0007: **903 of
   1,309 playable items were `dai_suspected`** — 69 %.

So the honest statement of the constraint for *show discovery* is: **DAI
constrains what can be cut into a Foray, and does not currently constrain what
can be suggested as a show at all.** §4.3 says why that is a gap rather than a
design.

### 2.4 What leaves the device

`app.js:API_ORIGIN = "https://foray-web-seven.vercel.app"`, joined by
`app.js:apiUrl`. `index.html:22`'s CSP `connect-src` names exactly three
sources: `'self'`, the Supabase project, and that origin — pinned by
`test/api-origin.test.js` ("the CSP names the API origin, and nothing wider").
`sw.js` does not intercept `/api/*` (`if (url.origin !== location.origin)
return;`), so there is no service-worker cache over any show endpoint.

Server-side, `api/_lib/cors.ts:ALLOWED_ORIGINS` is a five-element exact-match
echo list: `capacitor://localhost`, `https://localhost`, `https://jwlabs.ai`,
`https://jw-incorporated.github.io`, `https://foray-web-seven.vercel.app`.
`Vary: Origin` is set on every response; `Access-Control-Allow-Credentials` is
never set.

### 2.5 Provenance — who writes each file, and how often

- **`data/catalog.json`: 11 commits, ever.** All hand-curated agent waves
  (`Catalog wave 1/2/3`, `Gap wave 1/3/4/5/10+11`, `Horizon expansion`, and
  `8bb51ca` — the seven drinks shows from #279). It is **not on any cadence and
  no automation writes it.**
- **`data/discover.json`: roughly nightly.** Commit subjects are
  `Nightly refresh: +N episodes (YYYY-MM-DD) (#nnn)`, N ranging **+4 to +91**,
  with visible gaps (2026-08-19→08-21, 08-31→09-05) and three commits labelled
  `recovery`.
- **The `Classify batch …` commits write neither.** `fbd8968`
  (*"Classify batch fresh-2026-09-09-0ba8c8be: 44 shows (tier 1)"*) touches only
  `data/breadth-classification.json` (17.7 MB, 19,787 entries).
  `tools/classify/merge-results.mjs`'s own header: *"This never touches
  data/catalog.json or data/discover.json (the curated tier)."*
- **`data/catalog-breadth.json`** is written by a manual
  `node tools/harvest-catalog.mjs` run. No workflow invokes it.
- **`data/catalog-client.json`** is written by
  `node tools/build-catalog-client.mjs`. **No workflow invokes it either** — the
  only drift guard is `test/show-page.test.js:491` running it with `--check`.

---

## 3. The mechanisms

### 3.1 How a show gets its taxonomy nodes

**Curated tier (the 220): by hand, one or two labels, no classifier.** Nothing
in the repo derives `catalog.json`'s `taxonomy_node_ids` programmatically. They
were written by the curation agent waves listed in §2.5 and edited by hand
since. There is no tool that re-derives them, no test that challenges them, and
no schedule on which they are revisited.

**Breadth tier (the 19,787): a four-layer cascade, into a separate file.**
`tools/classify-breadth.mjs` merges layers into
`data/breadth-classification.json` with a strict precedence:
`genre-map` < `llm-title-genre` < `classify-agent-tier1` < `classify-agent-tier2`.
The agent path is `tools/classify/prepare-batch.mjs` → a Claude Code agent
following `docs/agents/runner-prompts/classify-batch.md` →
`tools/classify/merge-results.mjs:validateResult`. Batch defaults:
`--batch-size 60`, `--episodes-per-show 8`, tier-2 fetches at most 2 transcript
URLs, each excerpt `.slice(0, 2000)`. Confidence buckets: `>= 0.75` high,
`>= 0.5` medium, else low. **`validateResult` imposes no numeric cap on topics
per show** — only non-empty and valid-node.

**Neither of those reaches the app.** `data/breadth-classification.json` is read
only by `backend/src/generation/taxonomyFamily.ts:loadBreadthNodes` (Foray
generation, and only for a numeric Apple id).
`backend/src/catalog/breadthCatalog.ts:loadBreadthCatalog` sets
`taxonomy_node_ids: []` on **every** breadth entry, unconditionally. So a
breadth show reaching the client has no subject at all (§6.4).

**The only true LLM classifier in the repo classifies episodes, not shows, and
is unwired from every show path.** `backend/src/enrich/AnthropicEnricher.ts`:
`MODEL = "claude-haiku-4-5"`, `max_tokens: 512`, response schema
`topics: z.array(z.string()).min(1).max(4)`, description truncated at
`slice(0, 2000)`. Its only caller is `backend/src/cli/buildSession.ts`.
`backend/src/enrich/createEnricher.ts` falls back to
`backend/src/enrich/StubEnricher.ts` (topics `1 + (seed % 2)`,
`sourceConfidence: 0.4`) whenever `ANTHROPIC_API_KEY` is absent.

**How an episode gets its topics — the inheritance, measured.**
`tools/refresh/scan.mjs:main` seeds every scanned episode with
`topics: show.taxonomy_node_ids || []`. `tools/refresh/merge.mjs` applies an
optional per-episode `topics` override from `edits.json`, validated by
`tools/refresh/topics.mjs:episodeTopics` (`TOPICS_EMPTY` is refused outright —
"an empty override would be an exclusion wearing a label's clothes"). Omit the
override and the show label stands.

Measured on the committed files, 2026-09-09:

- **1,720 of 2,080 discover items (82.7 %) carry a `topics` array identical to
  their show's `taxonomy_node_ids`.** (Issue #547 measured 1,688 of 2,047 on
  2026-09-09; the ratio is unchanged after that night's +30.)
- `engineering/energy-fusion` is on **26** items, from eight shows whose *only*
  node it is: *Lex Fridman Podcast, Titans of Nuclear, omega tau, CleanTechies
  Podcast, Catalyst with Shayle Kann, Lab to Market Leadership, CBC Ideas,
  TechSurge: Deep Tech Podcast.*
- `node tools/refresh/topic-uniformity.mjs`, run now: **71 of 115 shows with
  ≥ 8 episodes carry ONE topic set on every episode.** PR #300 (issue #292)
  moved that number from 77 of 99 to 68 of 99 by re-deriving nine ranging shows.
  It has since drifted back up (§6.3).

This is the mechanism behind founder feedback **F19** and issue **#547**, and —
per finding **F-59** in `docs/curation/generation-run-2026-09-09.md` — behind
the topic resolver's fusion magnet as well: *"whatever vocabulary that node
advertises in `data/taxonomy.json` is broad enough to win on generic technology
text, in show classification AND in topic resolution."*

### 3.2 "Similar shows"

`app.js:similarShows(show, limit = 6)` — the whole algorithm, verbatim in
behaviour:

1. `nodeIds = new Set(show?.taxonomy_node_ids || [])`; return `[]` if empty.
2. Over `state.catalog.shows` (the curated 220 — **never the breadth tier**),
   drop the show itself, score each candidate as
   `shared = candidate.taxonomy_node_ids.filter(id => nodeIds.has(id)).length`.
3. `filter(x => x.shared > 0)` — "a show sharing none is not 'weakly similar',
   it is unrelated, so it is filtered out rather than padded in."
4. `sort((a,b) => b.shared - a.shared || a.show.show_id.localeCompare(b.show.show_id))`
   — ties broken by `show_id` so the order is stable and pinnable.
5. `.slice(0, 6)`.

`app.js:similarShowsSection` renders nothing (not an empty section) when the
result is empty, and reuses `app.js:showResultRow` verbatim.

**What that means arithmetically, measured over the committed catalogue.**
Because a show carries 1 or 2 nodes and 170 of 220 carry exactly 1, "shares at
least one node" is very nearly "carries the same single label":

| Metric | Value |
|---|---|
| Candidate-set size per show (before the 6-cap) | min **0**, median **3**, max **12** |
| Shows with **zero** similar shows | 4 |
| Shows whose similar list is **shorter than the 6-slot limit** | **161 of 220** |

So the median show page offers three similar shows, and the label that produces
them is the same label F19/#547 shows to be wrong for broad shows. There is no
scoring beyond node overlap: no description, no genre, no co-listening, no
artwork, no popularity, no chart rank.

### 3.3 Shows search — a local pass and a breadth pass

> **SUPERSEDED IN PART, 2026-09-12 (PR #657 / the follow-up `api/**` PR,
> `docs/search-plan.md` S-02/S-03/S-04/S-06).** The description below is kept
> as the record of what shipped before the S-deck, because §6.2, §6.8 and
> §6.11 all reason from it. What is now different:
> 
> - **There is a keystroke path.** `#sh-input`'s `input` event runs the local
>   pass alone; the breadth pass, the episode pass and the playlist CTA all
>   moved onto a **250 ms trailing debounce**. Enter and the Go button skip
>   the debounce. Clearing the box restores the A-Z list.
> - **The local pass is no longer 220 shows.** `data/show-index.tsv`
>   (10,113 shows at the `chart_rank <= 100` cut) is fetched lazily on the
>   first focus of the search box and searched by binary search on the
>   keystroke; the linear scan runs only on the debounce tick and only when
>   the prefix pass returned fewer than 10 hits.
> - **The ranking rule is four buckets, not three** (exact > prefix >
>   word-start > substring), with curated-before-breadth and a BUCKETED
>   `chart_rank` prior. The server's rule in `searchBreadthShows.ts` was
>   deliberately NOT mirrored — see `docs/DECISIONS.md` 2026-09-12.
> - **The breadth pass is cached in memory** by normalized query, and falls
>   through to Apple's directory server-side on a genuine miss, behind two
>   independent gates.


`app.js:renderShowSearchResults(query)` runs three sections against one query,
all guarded by a single module-level `app.js:showSearchToken`.

**Pass 1 — local, synchronous, no network.**
`search-engine.js:searchShows(query, shows)` over `state.catalog.shows`:
case-insensitive `title.indexOf(q)`, `rank = title === q ? 0 : idx === 0 ? 1 : 2`,
stable sort by `(rank, idx)`. It deliberately does **not** route through
`interpretQuery`/`tokenize`/stopwords — `test/show-search.test.js` pins that "a
stopword-only show name still matches". Painted immediately.

**Pass 2 — breadth, over the network.**
`fetchApiJson("api/shows/search?q=…&limit=25")` →
`api/shows/search.ts:handler` → `backend/src/catalog/searchBreadthShows.ts:searchBreadthShows`
over `backend/src/catalog/breadthCatalog.ts:loadBreadthCatalog`.

- The merged index is `data/catalog.json` (220, `tier: "curated"`) plus
  `data/catalog-breadth.json` minus the 103 rows marked `in_curated`
  (19,684, `tier: "breadth"`, `taxonomy_node_ids: []`, `editorial_note: null`).
  Cached per warm process; `FORAY_SKIP_CATALOGUE_CACHE=1` disables it.
- Same three-bucket ranking rule as the client, reimplemented deliberately
  ("the client module has no Node/DOM-free access to the ~10k-show breadth
  file"), with an extra tie-break: **curated before breadth**, then
  `title.localeCompare`.
- `limit`: `Math.min(parsed, 100)`, default 25 (`DEFAULT_LIMIT` in
  `searchBreadthShows.ts`). `q` missing → `400`. Non-GET → `405`.
  Unreadable catalogue file → **200 with `shows: [], degraded: true`**, never a
  500.
- `Cache-Control: public, max-age=300, stale-while-revalidate=3600` on success.

Back in the client: a response is dropped if `myToken !== showSearchToken`;
results already shown locally are deduped by `show_id`; each addition is cached
into `state.breadthShowCache[s.show_id]` **so `app.js:showById` can resolve it
once a result is tapped**; a network failure "degrades silently: local-only
results already painted". All four behaviours are pinned by
`test/show-search.test.js`.

**Pass 3 — episodes.** `app.js:renderEpisodeSearchResults` fires
`api/episodes/search?q=…&limit=10` unless `navigator.onLine === false`. See
§3.6.

**The `Go` button.** `app.js:renderAllShows` binds `#sh-form`'s `submit` only.
There is no `input` listener on `#sh-input`, so **nothing filters as you type**
— this is founder feedback **F2**, still open (§6.2).

### 3.4 Browse by subject, and the category page

`app.js:browsePillsHtml` renders one `app.js:taxonomyChip` per
`app.js:taxonomyRootNodes()` — **all 41 roots**, alphabetical by label. Each
chip links to `#/category/<encoded node id>` →
`app.js:renderCategory` → `app.js:showsForCategory(nodeId)`, which is
`state.catalog.shows.filter(s => s.taxonomy_node_ids.includes(nodeId))` — an
**exact** id match, curated tier only. An unknown node id still renders, falling
back to the raw id as its own label; an empty list gets "No shows here yet."

Measured over the committed catalogue:

- **76 of 194** taxonomy nodes are on at least one curated show. **118 category
  pages render "No shows here yet."**
- Only **9 of 41 roots** appear directly in a show's `taxonomy_node_ids` (the
  rest of the catalogue's labels are `parent/child` leaves). So **32 of the 41
  browse pills lead to an empty page** (§6.7).

The show page's own chips are the same component:
`app.js:renderShow` builds `chips` from `show.taxonomy_node_ids.map(taxonomyChip)`
— one or two per show.

### 3.5 How Home picks "for you", and why no show appears there

`app.js:renderHomeV2` renders, top to bottom: `homeGreeting()`,
`jumpBackInV2Html()`, `foraysForYouHtml()`, `playlistsForYouHtml()`,
`episodesForYouHtml()`. None of the five is show-shaped.

The interest model:

- `app.js:loadInterests` seeds `state.interests[n.id] = saved[n.id] ?? Math.max(0, n.weight)`
  over **every** taxonomy node, roots and leaves (the fix for the bug where a
  root-level pick silently vanished on reload).
- `app.js:interestScore(item)` = the arithmetic mean of `state.interests[t]` over
  `item.topics`, defaulting an unknown topic to `0.5`; an item with no topics
  scores `0.5`.
- `app.js:nudgeTopics(topics, amount)` clamps to `[0, 1]` and propagates to the
  parent root at `app.js:PARENT_NUDGE_RATIO = 0.5`, **once per distinct parent
  per call**, skipping a root named directly in `topics`.
- First-run: `app.js:PREFS_CHIP_IDS` is 17 root ids (`history, comedy,
  engineering, business, health, society, science, true-crime, culture,
  psychology, food, craft, nature, medicine, music, personal-journals, sports`)
  chosen for "measured pool depth (>= 50 items AND several distinct shows —
  interest-survey-plan.md §3.2)". `app.js:applyOnboardingPicks` expands each pick
  to its subtree (`app.js:expandTaxonomyPick`) and adds
  `ONBOARDING_SEED_LIFT / Math.sqrt(ids.length)` where
  `app.js:ONBOARDING_SEED_LIFT = 0.20` — "worth about four finishes or two and a
  half thumbs-ups, never a fact."

"Episodes for you" is `state.cardSlots` verbatim, built by `app.js:buildCards`:
group the pool by `app.js:branchOf(item)` (the **root** of `topics[0]`), rank
branches by average `interestScore`, reserve one slot for a branch outside the
top `Math.ceil(n * 0.6)` ("the stretch"), take 4 slots of `QUEUE_SIZE = 3` items
each via `app.js:branchChain` (unseen-first, then seen-not-played, then played,
each newest-first).

"Playlists for you" is the listener's own three most recent playlists plus
`app.js:generatedPlaylists()`: interest **leaves** whose parent no card slot
already covers, weight `> 0`, sorted by weight then id;
`GENERATED_PLAYLIST_SIZE = 6` newest items per leaf, dropped below
`GENERATED_PLAYLIST_MIN = 3`, capped at `GENERATED_PLAYLIST_COUNT = 3`.

This is the exact path founder feedback **F19** travelled: `generatedPlaylists`
selects by leaf, the leaf's members are episodes wearing their show's single
label, and the "fusion" list arrives full of Civil War and psychopaths.

The only show-shaped thing on any of these cards is `app.js:showNameLink`, which
resolves a name to `#/show/:id` via `app.js:showIdForShowName` and falls back to
plain escaped text when nothing joins.

### 3.6 Episodes for one show — the full list, and its reachability

`app.js:renderShow(show_id)` paints twice. First, synchronously, from the
curated pool (`episodesForShow`) so the page is never blank; then it calls
`app.js:fetchShowEpisodes(show_id, cursor)` and swaps in the full list.

`GET /api/shows/:show_id/episodes` — `api/shows/[show_id]/episodes.ts:handler`:

- Resolves `show_id` through `loadShowIndex()` over `data/catalog.json` **and**
  `data/catalog-breadth.json`; unknown id → `404` **before any feed fetch**
  (pinned: `api/test/episodes-no-db.test.mjs` asserts `fetch` is never called).
- **No-DB mode** (the branch production takes — `DATABASE_URL` is unset):
  `backend/src/feeds/conditionalGet.ts:fetchFeedConditional(meta.feedUrl, …)`
  against the publisher's own RSS, `timeoutMs 15_000`,
  `MAX_FEED_BYTES = 20 * 1024 * 1024`, User-Agent
  `"Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)"`; then
  `backend/src/feeds/parser.ts:parseFeed`; then
  `api/_lib/episodeCursor.ts:paginate` at `PAGE_SIZE = 100`, keyset cursor on
  `published_at` **descending** with `guid` ascending as tiebreak. An episode
  with no enclosure is dropped, never given a fabricated `audio_url`.
  `Cache-Control: s-maxage=3600, stale-while-revalidate=86400`; a failed fetch
  returns `200 … degraded: true` with `Cache-Control: no-store`.
- **DB mode** is dormant (`ingestShowFeed`, `DEFAULT_TTL_MS = 24h`,
  `catalog_show_episodes` / `catalog_show_feed_state`).

**F4(c) — status: fixed.** Founder feedback F4 reported that this endpoint was
unreachable from the native app for two independent reasons: `pinnedUrl()`
returned a relative path resolving against `capacitor://localhost`, and the CSP
`connect-src` did not name the API host. Both are now closed on `main`:
`app.js:API_ORIGIN` + `app.js:apiUrl` give an absolute URL,
`index.html:22` names `https://foray-web-seven.vercel.app`, and
`test/api-origin.test.js` pins all of it ("every `api/*` call in app.js goes
through `apiUrl()`, none through `pinnedUrl()`"). PR #471 — the fix F4 names —
was **closed unmerged**; the shipped fix came in separately. `app.js:pinnedUrl`
still exists and still appends `_fdid=<deploy id>`, but only for `data/*.json`
static fetches, and its header says explicitly why an `/api/*` call must not use
it.

**The count label is a contract.** `app.js:showEpisodeCountLabel` never claims a
total while a cursor remains: `"N+ episodes loaded so far — more available"`,
dropping the hedge only when a page returns `next_cursor: null`. Pinned by
`test/show-page-pagination.test.js`.

**Show-page episode search.** `app.js:searchShowEpisodesScoped` calls
`api/episodes/search?show=<id>&q=<q>&limit=25`, which fetches the show's live
feed server-side and matches **title only** (`ep.title.toLowerCase().includes(q)`),
never Apple. On failure or `degraded`, the client falls back to
`app.js:filterLoadedEpisodes` (title **or** description, over loaded pages only)
and says so in `paintSearchNote()` — "searching loaded episodes only (N of the
full list loaded so far)". Debounced at **250 ms**, guarded by a per-render
`searchToken`. The box stays hidden until page 1 lands.

**General episode search.** No `show=` → `api/episodes/search.ts:searchApple`
against `https://itunes.apple.com/search?entity=podcastEpisode`, keyless,
`APPLE_TIMEOUT_MS = 8_000`, `MAX_RESULTS = 25` (cap 100), rate-limited by
`api/episodes/appleBucket.ts` (`APPLE_BUCKET_CAPACITY = 20`,
`APPLE_BUCKET_WINDOW_MS = 60_000`, sliding-window, **per warm instance only**),
cached 1 h by `api/episodes/searchCache.ts` keyed
`` `${show ?? ""}::${limit}::${q.trim().toLowerCase()}` ``. Every hit's
`collectionId` is mapped back to a 4a `show_id` via
`api/episodes/showIdMap.ts:loadShowIdMap`; **an unmapped hit is dropped** rather
than shown with a broken link. The id map's preferred source,
`data/shows-index-pointer.json`, **does not exist in the repo**, so the map is
always the 220-entry `catalog.json` fallback.

### 3.7 The nightly refresh, and the weekly show import

**`.github/workflows/nightly-refresh.yml` — cron `40 6 * * *` (06:40 UTC).**
Steps, in order: an overwrite guard that refuses to publish over a digest that
never merged (`tools/refresh/watch-nightly.mjs --mode overwrite`, issue #290) →
`npm ci --prefix backend` → restore scan state → `tools/refresh/scan.mjs
--window-hours 48` → `tools/refresh/resolve.mjs` → publish `resolved.json` and
`refresh-state.json` to the unprotected `refresh-digest` branch. It commits
nothing to `main` and opens no PR.

`scan.mjs` reads `data/catalog.json` and, per show, fetches the feed
(`THROTTLE_MS = 1800`), takes `items.slice(0, 10)`, drops anything without a
guid/title, anything older than the 48 h cutoff, and anything whose
`show + "::" + title` is already in `discover.json`; it keeps a **60-guid
ring buffer per show**; and it stamps `topics: show.taxonomy_node_ids`.
`resolve.mjs` matches each pending episode to an iTunes `trackId`
(`limit=25`, exact → substring → token overlap accepted at **`>= 0.6`**) and
drops anything with no valid taxonomy topic.

The judgment half runs as a Claude Cloud agent at ~11:40 UTC
(`docs/nightly-refresh-cloud.md`): it authors `edits.json`, runs
`tools/refresh/merge.mjs` (copy rules: hook ≤ 16 words, 5–12 tags, banned
phrases, optional per-episode `topics` override) and opens `nightly/<date>`
against protected `main`; `automerge-nightly.yml` merges on green.
`nightly-watch.yml` at `40 21 * * *` is the absence alarm.

**Nothing in this loop adds a show.** It adds episodes to shows already in
`data/catalog.json`.

**`.github/workflows/shows-import.yml` — cron `7 6 * * 0` (Sunday 06:07 UTC).**
This is the only automated *show*-list job. `tools/shows/run-and-publish.mjs`
downloads the PodcastIndex bulk dump
(`https://public.podcastindex.org/podcastindex_feeds.db.tgz`, keyless), applies
D1 (`tools/shows/filter.mjs`: `D1_MIN_EPISODES = 3`,
`D1_MAX_MONTHS_STALE = 24`, plus `dead`; a curated row is exempt and counted
under `curated_exempt`), D13 dedupe (`tools/shows/dedupe.mjs`), builds
prefix shards (`shard-build.mjs`, `MAX_SHARD_GZ_P95_BYTES = 400 KB`,
`MAX_TOP_JSON_BYTES = 250 KB`, `TOP_N_BY_POPULARITY = 2000`) and publishes them
as a GitHub Release; only `data/shows-index-pointer.json` is committed, via an
auto-merged PR. **That pointer file is absent from `main`, so this job has never
successfully published one that landed.**

**Language is deliberately never filtered.** `tools/shows/filter.mjs`'s header:
*"this module stores `language` on every row and never filters on it —
re-confirming/closing that decision is gate G6 (card S-17), not this one."*
`tools/harvest-catalog.mjs` has no language filter either.

---

## 4. Quality rules and gates

### 4.1 What is actually gated

| Gate | Where | What it enforces |
|---|---|---|
| Client-projection drift | `test/show-page.test.js:491` runs `tools/build-catalog-client.mjs --check` | `catalog-client.json` is byte-identical to a fresh derivation, and carries exactly the six fields `renderShow()` reads |
| API origin + CSP | `test/api-origin.test.js` | `API_ORIGIN` is a bare https origin; every `api/*` call goes through `apiUrl()`; `connect-src` names exactly 3 sources and never `https:` or `*` |
| CORS | `api/test/cors.test.mjs`, `api/test/search-cors.test.mjs` | `ALLOWED_ORIGINS` deep-equals the 5-element list; OPTIONS answered before any handler body or upstream call; credentials never allowed |
| Vercel bundling | `api/test/vercel-bundle.test.mjs` | `vercel.json`'s `includeFiles` glob actually matches `data/catalog*.json` — **for `api/shows/**` only** (§6.1) |
| Import closure | `api/test/import-closure.test.mjs` | No `api/**` file transitively imports a bare specifier absent from `api/package.json` — the guard against the `dotenv`/`zod` module-load 500 |
| Honest empty/partial states | `test/show-search.test.js`, `test/show-page.test.js`, `test/show-page-pagination.test.js`, `test/show-page-search.test.js`, `test/episode-search.test.js` | A junk query renders an honest empty state, not a padded list; a breadth-tier show gets its own non-alarming copy; the count label always hedges while a cursor remains; a superseded response is dropped |
| Ranking determinism | `backend/test/breadthCatalog.test.ts`, `test/show-search.test.js` | Exact > prefix > substring; ties prefer curated then alphabetical; `catalog-client.json` is a strict subset of the merged curated tier |
| Off-device search tripwire | `test/release-gates.test.js` (`SHOWS_SEARCH_OFF_DEVICE`) | A release build cannot ship shard search **and** the old "nothing you type … is transmitted" sentence simultaneously |
| Episode-topic overrides | `tools/refresh/topics.mjs:episodeTopics` | An override may only relabel: `TOPICS_EMPTY` refused, `TOPICS_UNKNOWN` fails the whole run in preflight |

### 4.2 Sampling bias in the pool the suggestions draw from

Every breadth show 4a can suggest came from Apple's per-genre top charts.
`tools/harvest-catalog.mjs` sets `CHART_LIMIT = 200` and walks
`itunes.apple.com/.../rss/toppodcasts/limit=200/genre=<id>/json` over ~110
subgenres. `docs/curation/grilling-foray-sourcing.md` §5.1 states the
consequence: *"The catalogue is therefore, by construction, 'the top 200 of each
of 110 genre charts in 19 countries' — and nothing else can ever be in it."*

§5.2 of the same document measures the bias and finds it runs against 4a:

> 70 US breadth-catalogue shows, deterministically sampled 14 per rank band…
> **ranks 1–25 are 33 % ad-free (9/27). Ranks 26–200 are 71 % ad-free (30/42).**
> Yates-corrected χ² = **8.22** on 1 df — significant at p < 0.01… **the higher a
> show ranks, the less likely we can build a Foray from it.**

`docs/CATALOG-PIPELINE.md` records the earlier, different bias in the *curated*
tier: *"Web-search discovery biases toward famous shows in list-articles; a
breadth catalog needs systematic coverage, not vibes."*

`chart_rank` is recorded on every breadth row and **read by nothing** — not by
`searchBreadthShows`, not by `similarShows`, not by any surface.

### 4.3 The English-only ruling, and how far it reaches

The ruling is Wyatt's, 2026-08-16, recorded in `docs/DECISIONS.md` alongside the
narrator ruling: a non-Anglophone tradition is *described in English* rather
than shipped as non-English tape. `docs/curation/grilling-history-coverage.md`
restates it: *"This is decided, not pending."* Issue #279 restates it as a
non-negotiable constraint on catalogue growth: *"**English only**, per standing
founder instruction."*

**Its scope is Foray tape sourcing, not the catalogue.** ADR-0008 says so
explicitly: *"It does not settle the English-only question."*
`docs/catalog-growth-plan.md` §3 treats English filtering of the breadth tier as
**unbuilt Stage-0 work**, and `tools/shows/filter.mjs` names it as open gate G6.
There is no ADR. Nothing in the search path filters by language, so a
non-English show in `catalog-breadth.json` is fully searchable and fully
suggestible today.

### 4.4 Ad-inflation measurement

`tools/transcribe/ad-inflation.mjs` measures `delivered bytes / feed-declared
enclosure length` with a 2-byte ranged GET, reading the true total out of
`Content-Range`. Its header carries the trap: **"HEAD REQUESTS LIE."** On DAI
hosts HEAD returns the ad-free master's `Content-Length` while a real GET
delivers the assembled file — verified by downloading two *Stuff You Should
Know* episodes in full: HEAD said 35,549,607, the download was 44,961,612.

Constants: `AD_FREE_THRESHOLD = 1.01`, `AD_FREE_FLOOR = 0.99` (two-sided —
under-size is `unknown`, not ad-free), `MIN_PLAUSIBLE_BYTES = 1_000_000`,
`MIN_SAMPLES_FOR_AD_FREE = 2`, `RATIO_PRECISION = 1000`,
`PROBE_TIMEOUT_MS = 20_000`, `MAX_ATTEMPTS = 3`,
`RETRYABLE_STATUS = {408,425,429,500,502,503,504}`. Verdicts fold into
`data/dai-classification.json` (220 shows) via `applyVerdicts`.

Per ADR-0008 and `docs/DECISIONS.md`, this survives **as a label, not a
verdict**.

### 4.5 What nothing checks

Stated as flatly as the gates above, because the absence is the finding:

- **Nothing measures whether a suggestion is good.** There is no offline
  evaluation set for `similarShows`, no click-through or dwell metric on a show
  row, no A/B, no gate. `tools/test-search.mjs` is a search-quality battery for
  the **topic scorer** and never exercises `searchShows` or `similarShows`.
- **Nothing gates topic uniformity.** `tools/refresh/topic-uniformity.mjs` is a
  report a human runs; `ci.yml` does not run it, and its number has drifted
  (§6.3).
- **Nothing checks that a category page is non-empty**, that a browse pill leads
  anywhere, or that a show has more than zero similar shows.
- **Nothing checks that a curated show's `taxonomy_node_ids` is right.** There
  is no classifier, no confidence field, no `needs_review` flag and no review
  cadence on the curated tier — all three exist on the breadth tier
  (`tools/classify/merge-results.mjs`) and none of it reaches `catalog.json`.
- **Nothing checks show artwork.** 53 of 220 are `artwork_url: null`;
  `app.js:showArtworkUrl` papers over it at render time from the discover pool
  and its own header says "Backfilling catalog.json's 53 nulls is still the root
  fix."
- **No CI job builds `catalog-client.json`.** Its only guard is a unit test.

---

## 5. Outputs and what the listener sees

### 5.1 The Shows page, in render order

`app.js:renderAllShows` → `app.js:renderShowIndexPage("Shows", "<N> shows in
4a's catalogue, A–Z", shows, above)` where `above` is, in order:

1. `#sh-form` — a text input (`maxlength=120`) and a **Go** button.
2. `app.js:browsePillsHtml()` — 41 subject pills.
3. `#sh-note` — the empty-state line: `No shows match "<q>" in 4a's catalogue.`
4. `#sh-results` — show rows, curated first then breadth.
5. `#ep-search-results` — an "Episodes" section, captioned
   *"from Apple's index"* when `data.source` includes `apple`.
6. `#pl-search-results` — the listener's own matching playlists, then generated
   ones badged **"Generated for you"**, or a *"Create a playlist about X"* CTA.
7. `Starred shows ›`
8. `app.js:vouchForHtml()` — **"Shows we vouch for"**.
9. The A–Z list of all 220, `title.localeCompare` sorted.

The ordering is deliberate and documented in `renderAllShows`'s header: search
first, because "search answers 'does this show exist here', which is why someone
opens this page on purpose", A–Z last so it does not push the box under 220 rows.

**"Shows we vouch for"** — `app.js:showsWeVouchFor(limit = 8, now = new Date())`:
every show with a non-empty `editorial_note` (all 220), sorted by `show_id`, then
`app.js:seededShuffle` (Fisher–Yates driven by an LCG,
`s = (Math.imul(s, 1103515245) + 12345) >>> 0`) seeded by
`app.js:dayOfYearSeed(now)` (an FNV-ish hash of the UTC `YYYY-MM-DD`), sliced to
8. Every visitor sees the same eight on the same day; a test can pin it by
passing a fixed `now`. At 8 of 220 per day a given show surfaces here about
**13 times a year**.

### 5.2 The show page

`app.js:renderShow` renders, in order: back link; title + `explicitBadge`;
a count line (`data-show-count`); artwork (`showArtworkUrl`, falling back to the
discover pool's live 600×600 URL, then to a grey placeholder); a
`☆ Star this show` button; the `editorial_note`; the taxonomy chips; a hidden
episode-search box; the episode list; a `Show more episodes` button; **Similar
shows**; and **"used in these forays"** (`app.js:showForaysHtml`, bridged
through `player/foray-resolve.js:foraysReferencingShow` — `app.js` is not
allowed to enumerate the segment pool itself).

Three honest empty states, deliberately distinct:

- curated show, zero pool episodes → *"No episodes from this show are in 4a's
  catalogue right now."*
- breadth-tier show (`show.tier === "breadth"`) → *"Fetching this show's
  episodes — 4a is adding full episode lists for shows outside its curated
  picks. Check back soon."*
- unknown `show_id` → *"Show not found."*

### 5.3 Row shapes

`app.js:showResultRow` is the single show-row component, reused verbatim by the
search results, the A–Z index, the category page and Similar shows: artwork (or
`.show-result-art-blank`) plus title, wrapped in an `<a href="#/show/:id">`. No
play button, no star, no duration. `app.js:starredShowRow` is the one variant,
rendering from the snapshot stored in `cp_starred_shows` and falling back
through the live record for artwork.

### 5.4 Local state a show surface writes

| Key | Written by | Read by |
|---|---|---|
| `cp_starred_shows` | `app.js:toggleShowStar` (a `{show_id, title, artwork_url, starred_at}` snapshot) | `app.js:renderStarredShows`, `app.js:showStarBtn` |
| `cp_interests` | `app.js:saveInterests` | `app.js:interestScore`, `buildCards`, `generatedPlaylists`, `renderInterests` |
| `cp_history`, `cp_seen`, `cp_recent_branches` | episode interactions | `app.js:buildCards`, `app.js:listenedShows` |
| `state.breadthShowCache` (in-memory, **not** persisted) | `app.js:renderShowSearchResults` | `app.js:showById` |

`logEvent("show_starred" | "show_unstarred", {show_id})` are **local-only** event
types — `app.js:toEventRow` transmits five types and neither of these is one of
them (`docs/legal/data-safety.md` §A4).

---

## 6. Known gaps and open decisions

Ordered by how visible the defect is to a listener. Each row says whether an
existing doc or issue already records it.

### 6.1 `api/episodes/**` is not covered by `vercel.json`'s `includeFiles` — NOT RECORDED ANYWHERE

`vercel.json`'s only `functions` entry is
`"api/shows/**/*.ts": { "includeFiles": "data/catalog*.json" }`.
But `api/episodes/search.ts:loadShowMeta` reads `data/catalog.json` and
`data/catalog-breadth.json`, and `api/episodes/showIdMap.ts` reads
`data/catalog.json` and `data/shows-index-pointer.json` — all four through a
runtime `path.join()` + `readFileSync`, exactly the pattern
`api/shows/[show_id]/episodes.ts`'s own BUNDLING NOTE says Vercel's bundler does
**not** auto-include. `api/test/vercel-bundle.test.mjs` hardcodes
`TARGETS = ["api/shows/[show_id]/episodes.ts", "api/shows/search.ts"]`, so it
passes while this is open.

If the files are absent from the deployed episodes bundle, the failure is
silent and honest-looking: `loadCatalogFallback()` yields an empty map, every
Apple hit is dropped by `mapAppleHit`, and `/api/episodes/search` returns
`episodes: [], degraded: false, error: null`. The Episodes section on the Shows
page and the show page's own search box would both go quietly empty in
production while every test stays green. **This is the same "fails green"
shape F4(c) had.** Needs a production probe, then a one-line glob widening.

`api/episodes/*` also uses a **fixed** `REPO_ROOT = path.resolve(__dirname,
"..", "..")` rather than `episodes.ts`'s `findRepoRoot()` walk-up, which that
function's comment says was written precisely because a fixed offset is not
reliable across module transforms.

### 6.2 F2 — the Shows search does not filter live as you type — RESOLVED (PR #657, 2026-09-12)

> **RESOLVED by `docs/search-plan.md` S-02 (PR #657, 2026-09-12).** The fix
> took the shape F2's own note predicted — local pass on the keystroke,
> 250 ms debounce for everything that costs something, reusing the show
> page's existing `onSearchInputChange`/`runSearch` idiom rather than
> inventing a second debounce. **The Go button survived** (§6.13 row 1, G2's
> default): Enter still submits, the button still submits, neither is
> required. The issue this section says is unfiled is filed as part of S-08.


`app.js:renderAllShows` binds `#sh-form`'s `submit` only. F2's own note is
correct about the shape of the fix: the local pass
(`search-engine.js:searchShows` over 220 in-memory records) can drive live
filtering at no network cost, and only the breadth pass needs debouncing — the
show *page's* episode search already does exactly this at 250 ms
(`app.js:runSearch`). The Go button's fate is a product call. **No issue is
filed.**

### 6.3 Topic uniformity has regressed past #300's fix — NOT RECORDED ANYWHERE

`d1379c4` / PR #300 (issue #292) moved uniformity from **77 of 99** shows with
≥ 8 episodes to **68 of 99** by re-deriving nine ranging shows, and shipped
`tools/refresh/topic-uniformity.mjs` as the committed report. Run today it says
**71 of 115**. The regression is structural, not accidental: `scan.mjs` still
seeds `topics = show.taxonomy_node_ids` on every new episode, and the per-episode
override in `edits.json` is optional, so every night's additions re-inherit. No
CI job runs the report and no threshold exists.

This is the mechanism issue **#547** asks to fix, but #547 frames the fix as
per-episode classification needing an Anthropic key at scale. The cheaper half —
**re-run `topic-uniformity.mjs` in CI and fail on an increase** — is not in
#547 and is not in any doc.

### 6.4 Breadth shows are subject-less by construction — NOT RECORDED ANYWHERE

`backend/src/catalog/breadthCatalog.ts:loadBreadthCatalog` writes
`taxonomy_node_ids: []` on every breadth entry, unconditionally, even though
`data/breadth-classification.json` holds 19,787 classified entries and
`data/catalog-breadth.json` carries `apple_genre_ids` and a
`data/genre-taxonomy-map.json` exists to map them.

Consequences, all silent:

- `app.js:similarShows` returns `[]` for any breadth show — `nodeIds.size` is 0
  and the function returns early. **A breadth show page has no Similar shows,
  ever.**
- `app.js:showsForCategory` reads `state.catalog` only, so no breadth show can
  ever appear on a category page or behind a browse pill.
- `app.js:renderShow`'s `chips` is empty for a breadth show.

Net: of the 19,787 shows the search endpoint can reach, **19,567 are reachable
by exact name only**. Every other discovery surface is closed to them. The
founder's ask — *"the user should never notice any limitations based on our own
limited curation"* (`app.js:renderShowSearchResults` header, A3.1/Q3) — is met
for lookup and not met for discovery.

### 6.5 The international breadth catalogue is dead weight — NOT RECORDED ANYWHERE

`data/catalog-breadth-intl.json.gz` (13.8 MB, **121,786 shows**) is read by no
endpoint, tool or test. `loadBreadthCatalog` names only
`data/catalog-breadth.json`. So the "138,470-feed catalogue" that
`docs/curation/catalogue-broadening.md` §1 and `docs/agents/fleet-review-2026-08.md`
both quote is **not what show search reaches** — search reaches 19,787 US rows
minus 103 curated duplicates. Any statement that 4a can find "138k shows" is
false as shipped.

### 6.6 F-59 / #547 — the same magnet label drives Similar shows — PARTIALLY RECORDED

`docs/curation/generation-run-2026-09-09.md` finding **F-59** and issue **#547**
both name `engineering/energy-fusion` as a magnet that wins on generic
technology text, in show classification and in topic resolution. Neither traces
the consequence into **`app.js:similarShows`**, which is the surface a listener
sees: with 170 of 220 shows carrying exactly one node, "shares ≥ 1 node" is
"carries the same label", so *Lex Fridman Podcast*'s Similar-shows list is
*Titans of Nuclear, CleanTechies, Catalyst, CBC Ideas, omega tau…* — the same
eight-show contamination set F19 complained about, rendered as a recommendation
rather than a playlist. F-59's proposed fix (inspect the node's terms, add a
regression test) is necessary and not sufficient: a 1.23-nodes-per-show label
space cannot express similarity however clean each label is.

### 6.7 32 of 41 browse pills lead to an empty page — NOT RECORDED ANYWHERE

`app.js:browsePillsHtml` renders every taxonomy root; `app.js:showsForCategory`
matches node ids **exactly** and never walks children. Only 9 of 41 roots appear
directly in a curated show's `taxonomy_node_ids`, so 32 pills render *"No shows
here yet."* More broadly, **118 of 194 taxonomy nodes have no curated show at
all.**

The one-line fix in the existing idiom is to make `showsForCategory` accept a
root by expanding it the way `app.js:expandTaxonomyPick` already does (the
taxonomy is capped at two levels, so one parent-lookup covers it). Nothing
records the defect or the fix.

### 6.8 A breadth show page is not linkable or reloadable — RESOLVED (the `api/**` PR, 2026-09-12)

> **RESOLVED by `docs/search-plan.md` S-06(b).** Both halves of the fix this
> section says do not exist now do: `GET /api/shows/search?id=<id>` returns
> the single merged-catalogue row (a lookup over a per-instance id index,
> not a scan), and `app.js:resolveMissingShow` seeds `breadthShowCache` from
> it and re-renders. WHICH PATH ANSWERS: the loaded S-03 index when it is
> already in memory (free, no network), the endpoint otherwise — fetching
> 436 KB of index to render one show page would be a worse trade than one
> row over the wire, and a cold open of a shared link is exactly when the
> index is not loaded. A confirmed miss still renders "Show not found.",
> and the endpoint answers it with a **200 and `show: null`** rather than a
> 404, so the client can tell a real miss from a dead endpoint.


`app.js:showById` resolves `state.catalog` then `state.breadthShowCache`, which
is in-memory and populated **only** by a `renderShowSearchResults` response this
session. A cold open on `#/show/1234567890` — a shared link, a reload, a restored
tab, a deep link from a notification — renders *"Show not found."* Every curated
`#/show/:slug` works. The fix would be a `showById` fallback through
`GET /api/shows/search?q=` or a per-id endpoint; neither exists.

### 6.9 F4(a) — pool depth — RECORDED AND TABLED

Founder feedback F4's catalogue-depth half is explicitly tabled ("Joey is
working on show intake"). Measured now: `discover.json` holds **9** *Lex Fridman
Podcast* items of 2,080; per-show depth is min 1, median 8, max 53.
`tools/mobile/prepare-webdir.mjs:BUNDLED_ITEMS_PER_SHOW = 3` slices the mobile
bundle further. The plan that unblocks it is off-repo
(`4a-shows-pipeline-plan.md` §9): Joey's corpus database has **4.72 M podcasts**
but has crawled only **6,319 of 4.72 M feeds**, and of 4a's 220 curated feeds
**168 match by exact feed URL** and only **91 have been crawled**. The blocking
human gate is G7 — a Tailscale OAuth client and ACL, because `foray-db` is
reachable only over the tailnet and neither GitHub runners nor Vercel functions
are on it.

### 6.10 #279 — the curation gap — RECORDED

Issue #279: filtering all 19,787 rows of `data/catalog-breadth.json` on
drinks-shaped names finds **443** shows, of which **1** is `in_curated`. *"This
is a selection problem, not a discovery one."* Its two non-negotiables —
**label, never exclude** and **English only** — are the standing rules for any
promotion mechanism. It is sequenced behind #275. Nothing has promoted a breadth
show into `catalog.json` since; `data/catalog.json`'s last commit is #279's own
seven drinks shows.

### 6.11 The privacy policy's conditional does not match the code — RESOLVED (PR #657, 2026-09-12)

> **RESOLVED by `docs/search-plan.md` S-07, under G1's Option B ruling
> (Wyatt, 2026-09-11, `docs/DECISIONS.md`).** The sentence lost its
> condition; the code did not gain a local-hit branch. §2 now states
> affirmatively that the lookup happens **whether or not** the show is
> already on the device, that the typed text and nothing else is sent, that
> it is debounced rather than per-keystroke, and that a repeat inside the
> session is answered from memory. The analysis below is left intact because
> it is the record of what was wrong and why the other option was rejected.
> `test/release-gates.test.js` now pins the new contract from both sides:
> `SHOWS_SEARCH_OFF_DEVICE = true` arms its AND-gate for real, and a new case
> asserts the replacement sentence is **affirmative** rather than merely
> absent — deleting a false promise without replacing it would have passed
> the old check and told the reader nothing.


`docs/legal/privacy-policy.md` §2, shipped:

> **The Shows search box works the same way — until it has to look further than
> your device.** Typing a search first checks 4a's local catalogue on-device…
> and **if a show or episode is already in that local catalogue nothing you
> typed leaves your device.** If it is not… 4a sends your typed query
> off-device…

`app.js:renderShowSearchResults` paints the local results and then fires
`api/shows/search?q=…` **unconditionally**, and `renderEpisodeSearchResults`
fires `api/episodes/search?q=…` unconditionally too (the only guard is
`navigator.onLine === false`). There is no local-hit branch anywhere. So the
query is transmitted on **every** Shows search, including one that matched
locally.

`test/release-gates.test.js` does not catch this, deliberately: its header
reasons that `api/shows/search` is "an existing, intentional, ALREADY-DISCLOSED
network call", and its `SHOWS_SEARCH_OFF_DEVICE` tripwire fires only on the
flag S-05 is contracted to set. The gap is between the policy's *conditional*
and the code's *unconditional*, and it is exactly the kind of sentence
`docs/legal/data-safety.md` already flags as "worth a lawyer's eye". Either the
code grows the local-hit branch or the sentence loses its condition.

### 6.12 Smaller, all NOT RECORDED

- **53 of 220 curated shows have `artwork_url: null`** — whole harvest batches
  where `tools/harvest-catalog.mjs`'s iTunes lookup found no match. Papered over
  at render time by `app.js:showArtworkUrl`'s pool index; the backfill is the
  root fix and has not happened.
- **`show.tier` is an API-only field.** `app.js:renderShow` branches on
  `show.tier === "breadth"`, but **no show in `data/catalog.json` or
  `data/catalog-client.json` carries a `tier` field** (measured: 0 of 220). The
  value only ever arrives on a `/api/shows/search` response. Correct behaviour,
  undocumented contract.
- **`data/discover.json` is over its documented soft cap.** 2,080 items against
  `docs/architecture-assessment.md` A26's "~2,000 items / 1.5 MB", at 2.41 MB.
- **`api/shows/search`'s degraded path sets no `Cache-Control`** — **FIXED**
  (`docs/search-plan.md` S-05, 2026-09-12). It sets `no-store` now, matching
  the other two endpoints, so a "the catalogue file is unreadable" answer can
  no longer be edge-cached for five minutes. There are now TWO degraded
  branches in that file (the search's and the `id` lookup's) and
  `api/test/shows-search-apple.test.mjs` asserts the count as well as the
  header, so a third one cannot appear without the header.
- **The `stale-while-revalidate` directive that endpoint sets does not
  arrive.** Measured three times independently (`docs/search-plan.md` §1.4,
  §1.6, §1.7): the source sets
  `public, max-age=300, stale-while-revalidate=3600` and the response as
  received carries only `public, max-age=300`. S-05 deliberately did NOT add
  an `s-maxage` to compensate — that would be a second unverified directive
  beside the first — and wrote the finding into the source header instead,
  pinned by a test. **Two decks already assumed this token was in effect.**
- **`tools/build-catalog-client.mjs` runs in no workflow.** A `data/catalog.json`
  edit that skips the test suite ships a stale client catalogue.
- **`data/shows-index-pointer.json` does not exist**, so
  `api/episodes/showIdMap.ts` is permanently on its 220-show fallback. Documented
  in the source as expected pre-S-04; not recorded in any doc or issue as a
  *product* ceiling on general episode search.
- **Two stray root scripts** — `classify-shows.mjs` and `classify-shard-0.mjs`
  (the latter with hardcoded `/home/user/foray/...` paths). Already flagged in
  `HUMAN-ACTIONS.md` and two review docs; neither deleted.

### 6.13 Open decisions that belong to a human

| # | Decision | Where it is parked |
|---|---|---|
| 1 | ~~Does the Go button survive live filtering?~~ **ANSWERED** — it survives, as G2's default (PR #657): Enter submits, the button submits, neither is required | F2; `docs/search-plan.md` G2 |
| 2 | Does a curated show get more than 2 taxonomy nodes, or a "general" marker the generators refuse to inherit? | #547's "What to fix" #2 |
| 3 | Is English a catalogue-level filter or only a tape-level one? | `tools/shows/filter.mjs` gate G6; ADR-0008 says it is unsettled |
| 4 | Which of the three tailnet options closes G7 for the corpus database? | `4a-shows-pipeline-plan.md` §9 |
| 5 | Do breadth shows get subjects (from `breadth-classification.json` or `genre-taxonomy-map.json`), or stay lookup-only? | Nowhere — this document raises it (§6.4) |
| 6 | ~~Does the privacy policy lose its conditional, or does the code gain a local-hit branch?~~ **RULED by Wyatt 2026-09-11: the policy loses its conditional (Option B)** — shipped in PR #657 | `docs/DECISIONS.md` 2026-09-11; §6.11 |

---

## 7. Appendix

### 7.1 Function table

**Client — `app.js`**

| Function | Line | What it does |
|---|---|---|
| `showById(id)` | 1624 | curated catalogue → `state.breadthShowCache` → `null` |
| `episodesForShow(show)` | 1646 | discover-pool episodes for a show, joined by title, newest first |
| `dateValue(dateStr)` | 1642 | epoch-0 for a missing or unparseable date, so it sorts last |
| `showArtworkUrl(show)` | 1700 | show artwork, falling back to a pool-built title→artwork index |
| `showIdForShowName(name)` | 1728 | reverse title→`show_id` lookup |
| `showNameLink(name)` | 1743 | an `<a>` to `#/show/:id`, or plain escaped text |
| `taxonomyChip(nodeId)` | 1755 | an `<a>` to `#/category/:id` |
| `showsForCategory(nodeId)` | 1765 | curated shows whose nodes include an exact id |
| `renderShowIndexPage(title, sub, shows, above)` | 1777 | the shared shell for the category page and the A–Z index |
| `renderCategory(nodeId)` | 1799 | the category landing page |
| `browsePillsHtml()` | 1847 | one chip per taxonomy root (41) |
| `renderAllShows()` | 1854 | the `#/shows` page |
| `fullCatalogueRowToEpRowItem(show, ep)` | 1886 | a full-catalogue API row → a playable `epRow` item |
| `fetchShowEpisodes(show_id, cursor)` | 1918 | one page of `/api/shows/:id/episodes` |
| `similarShows(show, limit = 6)` | 1949 | taxonomy-overlap similarity |
| `similarShowsSection(show)` | 1967 | the rendered section, or `""` |
| `foraysUsingShow(show)` / `showForaysHtml(show)` | 1993 / 2008 | the reverse Foray join |
| `showEpisodeCountLabel({…})` | 2027 | the partial-list-honesty count line |
| `filterLoadedEpisodes(loaded, q)` | 2058 | the local fallback episode filter |
| `searchShowEpisodesScoped(show_id, q)` | 2078 | `/api/episodes/search?show=…` |
| `renderShow(show_id)` | 2084 | the show page, plus its pagination/search closure |
| `showResultRow(show)` | 3006 | the one show-row component |
| `dayOfYearSeed(now)` / `seededShuffle(arr, seed)` | 3035 / 3045 | the deterministic day rotation |
| `showsWeVouchFor(limit = 8, now)` / `vouchForHtml()` | 3056 / 3068 | the editorial row |
| `renderShowSearchResults(query)` | 3098 | local pass, breadth pass, episodes, playlists |
| `renderEpisodeSearchResults(query, token)` | 3288 | the Episodes block |
| `starredShowsMap` / `toggleShowStar` / `showStarBtn` / `renderStarredShows` | 879–949 | follow-lite |
| `buildCards()` | 1002 | the four interest-ranked episode slots + the stretch floor |
| `generatedPlaylists()` | 1087 | themed lists from interest leaves |
| `loadInterests` / `nudgeTopics` / `interestScore` | 415 / 450 / 813 | the interest model |
| `expandTaxonomyPick` / `applyOnboardingPicks` | 2706 / 2726 | first-run chip writes |
| `apiUrl(path)` / `fetchApiJson(path)` / `pinnedUrl(path)` | 272 / 7127 / 7352 | the three URL builders, and which is for what |

**Client — `search-engine.js`**

| Function | Line | What it does |
|---|---|---|
| `searchShows(query, shows)` | 1758 | exact > prefix > substring, stable, no tokenisation |

**API**

| Endpoint | File : handler | Notes |
|---|---|---|
| `GET /api/shows/search` | `api/shows/search.ts:handler` | limit ≤ 100, default 25; degrades to `shows: [], degraded: true` |
| `GET /api/shows/:show_id/episodes` | `api/shows/[show_id]/episodes.ts:handler` | `PAGE_SIZE = 100`, keyset cursor, live feed fetch |
| `GET /api/episodes/search` | `api/episodes/search.ts:handler` | Apple mode (20/min, 1 h cache) or show-scoped live-feed mode |
| — | `api/_lib/cors.ts:applyCors` | 5-origin echo, `Vary: Origin`, no credentials |
| — | `api/_lib/episodeCursor.ts:decodeCursor` / `paginate` | opaque base64url, never throws |

**Backend / tools**

| Symbol | What it does |
|---|---|
| `backend/src/catalog/breadthCatalog.ts:loadBreadthCatalog` | merges curated + breadth, drops `in_curated`, blanks `taxonomy_node_ids` |
| `backend/src/catalog/searchBreadthShows.ts:searchBreadthShows` | server-side twin of `searchShows`, curated-first tie-break |
| `backend/src/feeds/conditionalGet.ts:fetchFeedConditional` | 15 s timeout, `MAX_FEED_BYTES = 20 MB` |
| `backend/src/enrich/AnthropicEnricher.ts:classifyTier1` | the only key-gated classifier; **episodes, not shows**; 1–4 topics |
| `tools/build-catalog-client.mjs:buildCatalogClient` | the six-field client projection |
| `tools/harvest-catalog.mjs:main` | Apple genre tree → top-200 charts → batched lookup |
| `tools/refresh/scan.mjs:main` | 48 h feed scan; seeds `topics` from the show label |
| `tools/refresh/resolve.mjs:matchTrack` | title → iTunes `trackId`, accepted at ≥ 0.6 |
| `tools/refresh/topics.mjs:episodeTopics` | validates a per-episode override; refuses `[]` |
| `tools/refresh/topic-uniformity.mjs` | the uniformity report (run by hand) |
| `tools/refresh/dai.mjs:isDaiHost` | suffix match against the 16-host list |
| `tools/transcribe/ad-inflation.mjs:summariseShow` | median ratio → `ad-free` / `injected` / `unknown` |
| `tools/shows/filter.mjs:evaluateD1` | ≥ 3 episodes, ≤ 24 months stale, not dead; no language filter |
| `tools/classify/merge-results.mjs:validateResult` | breadth classification validation; no topic cap |

### 7.2 Constants

| Constant | Value | Where |
|---|---|---|
| `similarShows` limit | 6 | `app.js:1949` (default parameter) |
| `showsWeVouchFor` limit | 8 | `app.js:3056` |
| LCG multiplier / increment | 1103515245 / 12345 | `app.js:seededShuffle` |
| Shows-search request limit | 25 | `app.js:renderShowSearchResults` |
| Episode-search request limit | 10 (general), 25 (show-scoped) | `app.js` |
| Show-page search debounce | 250 ms | `app.js:onSearchInputChange` |
| Shows-page search debounce | 250 ms | `app.js:SHOW_SEARCH_DEBOUNCE_MS` |
| Prefix-pass under-delivery threshold | 10 hits | `app.js:SHOW_PREFIX_UNDERDELIVERS_BELOW` |
| Hot-query cache cap | 200 | `app.js:SHOW_BREADTH_CACHE_MAX` |
| Show-index cut | `chart_rank <= 100` (10,113 shows) | `tools/build-show-index.mjs:BUILD_MAX_RANK` |
| Show-index bundle budget | 512 KB raw | `tools/mobile/prepare-webdir.mjs:UNPINNED_DATA` |
| Popularity prior bands | `<=10 / <=50 / <=200 / unranked` | `search-engine.js:SHOW_PRIOR_BANDS` |
| Show-search Apple bucket / window | 20 / 60 000 (its own instance) | `api/shows/appleShowSearch.ts` |
| Show-search Apple cache TTL | 1 h | `api/shows/appleShowSearch.ts` |
| `DEFAULT_LIMIT` / hard cap | 25 / 100 | `searchBreadthShows.ts` / `api/shows/search.ts` |
| `PAGE_SIZE` | 100 | `api/shows/[show_id]/episodes.ts` |
| `MAX_RESULTS` | 25 | `api/episodes/search.ts` |
| `APPLE_TIMEOUT_MS` | 8 000 | `api/episodes/search.ts` |
| `APPLE_BUCKET_CAPACITY` / `WINDOW_MS` | 20 / 60 000 | `api/episodes/appleBucket.ts` |
| Episode-search cache TTL | 1 h | `api/episodes/searchCache.ts` |
| `MAX_FEED_BYTES` / feed timeout | 20 MB / 15 000 ms | `backend/src/feeds/conditionalGet.ts` |
| `DEFAULT_TTL_MS` (DB mode) | 24 h | `backend/src/catalog/ingestShowFeed.ts` |
| `BUNDLED_ITEMS_PER_SHOW` | 3 | `tools/mobile/prepare-webdir.mjs:490` |
| `GENERATED_PLAYLIST_COUNT` / `_SIZE` / `_MIN` | 3 / 6 / 3 | `app.js:1084–1086` |
| `PARENT_NUDGE_RATIO` | 0.5 | `app.js:428` |
| `ONBOARDING_SEED_LIFT` | 0.20 (÷ √d) | `app.js:2716` |
| `PREFS_CHIP_IDS` | 17 root ids | `app.js:2754` |
| `MAX_TOPICS` | 5 | `tools/refresh/topics.mjs` |
| Classifier topic range | 1–4 | `AnthropicEnricher.ts:ClassificationSchema` |
| `CHART_LIMIT` / `THROTTLE_MS` / `LOOKUP_BATCH` | 200 / 3 000 / 150 | `tools/harvest-catalog.mjs` |
| `D1_MIN_EPISODES` / `D1_MAX_MONTHS_STALE` | 3 / 24 | `tools/shows/config.mjs` |
| `TOP_N_BY_POPULARITY` | 2 000 | `tools/shows/config.mjs` |
| `AD_FREE_THRESHOLD` / `AD_FREE_FLOOR` | 1.01 / 0.99 | `tools/transcribe/ad-inflation.mjs` |
| nightly-refresh cron | `40 6 * * *` | `.github/workflows/nightly-refresh.yml` |
| nightly-watch cron | `40 21 * * *` | `.github/workflows/nightly-watch.yml` |
| shows-import cron | `7 6 * * 0` | `.github/workflows/shows-import.yml` |

### 7.3 Glossary

- **Curated tier** — the 220 hand-picked shows in `data/catalog.json`, with
  editorial notes and taxonomy labels, plus their hand-picked episodes in
  `data/discover.json`. Everything Home, playlists and Forays draw on.
- **Breadth tier** — the 19,787 US shows harvested from Apple's genre charts
  into `data/catalog-breadth.json`. Show-level only: no episodes, no editorial
  note, and (in the client's view) no taxonomy.
- **`show_id`** — a slug for a curated show; `String(apple_collection_id)` for a
  breadth one.
- **Taxonomy node** — an id in `data/taxonomy.json`, either a root
  (`engineering`) or one leaf below it (`engineering/energy-fusion`). Exactly two
  levels.
- **Magnet label** — a taxonomy node whose advertised vocabulary is broad enough
  to win on generic text, so unrelated shows and episodes accumulate under it.
  `engineering/energy-fusion` is the measured example (#547, F-59).
- **Inheritance** — an episode wearing its show's `taxonomy_node_ids` because
  `scan.mjs` seeded it and no `edits.json` override replaced it. 1,720 of 2,080
  discover items.
- **DAI** — dynamic ad insertion. A host that stitches ads per request, so the
  same episode has a different duration in every copy.
- **Ad inflation** — `delivered bytes / feed-declared enclosure length`; > 1.01
  means injected ad load. A label, not a verdict (ADR-0008).
- **Breadth pass** — the `/api/shows/search` half of the Shows search, appended
  to the local results when it lands.
- **`showSearchToken`** — the module-level counter that lets a newer query
  supersede a slower in-flight one across all three result sections at once.
- **Stretch slot** — a deliberately-reserved slot for a subject outside the
  listener's top 60 % of branches. Applies to episodes and Forays; **no show
  surface has one.**
- **No-DB mode** — the branch every episode endpoint takes in production because
  `DATABASE_URL` is unset: fetch the publisher's feed live, paginate in memory,
  persist nothing, and let the CDN be the cache.
