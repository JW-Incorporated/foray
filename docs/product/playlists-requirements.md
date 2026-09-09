# Playlists — requirements

**Status:** authoritative reference for playlists **as built** on `main`, read
out of the code on 2026-09-09.
**Audience:** founders and agents. It assumes no knowledge of the codebase.
**Scope:** the client. Playlists have no backend and no server component
(§2.7), so unlike `docs/curation/foray-generation-requirements.md` — the
document this one is written to match — everything here lives in `app.js`,
`search-engine.js` and `data/`.

**Relationship to the other documents:**

| Document | What it is | Authority |
|---|---|---|
| `docs/ui-transition-plan.md` | The card deck that specified today's Home, Search, Create, Library and Interests screens (U-03, U-05, U-06, U-07, U-10; decisions D5–D8). | Design intent. Where it and the code disagree, **the code is what runs** and this document says so. |
| `docs/curation/foray-generation-requirements.md` | The same treatment for the Foray pipeline. | The sibling document. A Foray is a different object (§1.2); nothing in it governs playlists. |
| `docs/listening-queue-plan.md` | Up Next (`cp_queue`), deliberately **not** shaped like a playlist. | Owns Up Next. §1.2 states the boundary. |
| `docs/legal/privacy-policy.md`, `docs/legal/data-safety.md` | What `cp_playlists` holds and that it never leaves the device. | Authoritative on the privacy claim; §2.7 restates it with the code citation. |
| `C:\Users\wjduv\Desktop\4a-feedback.md` (off-repo) | The founder feedback log. F3, F14, F19, N3 are the playlist rows. | The evidence base for §6. |
| **This document** | What the code actually does — every rule, threshold and size as a named constant, every claim citing `path:function`. | The single reference. |

Nothing here is invented. Where behaviour is absent, this document says
**"not implemented"** or **"design only, see `docs/ui-transition-plan.md` D<n>"**.
Where a comment in the code is stale relative to the code beside it, this
document follows the code and records the discrepancy in §6.

---

## 1. Purpose and scope

### 1.1 What a playlist is

A playlist is **an ordered list of whole podcast episodes, assembled from one
sentence the listener typed, and stored on their device**. It is not audio, not
a stitched artefact, and not a subscription. Three properties define it:

- **It is built from a typed request.** `app.js:buildPlaylist` takes free text
  ("give me a series about fusion"), runs it through the topic scorer in
  `search-engine.js`, and keeps the picks. There is exactly one creation
  function in the app and two forms that call it (§3.6).
- **It is a list of pointers plus a copy of each pointer's description.** A part
  is `{ id, title, show, duration_min, apple_collection_id, apple_track_id,
  topics }` — `app.js:PLAYLIST_PART_FIELDS`. The audio URL is deliberately not
  kept, because it rots (§2.5).
- **It is per-device and private.** `cp_playlists` is `localStorage` (mirrored
  into IndexedDB by `player/durable-store.js`). No playlist, and no query used
  to build one, is ever transmitted (§2.7).

A **generated playlist** ("Playlists for you" on Home) is the same *shape* with
none of the persistence: a themed list computed per render from the listener's
interest weights over the discover pool (`app.js:generatedPlaylists`). It has an
id (`gen-<leaf>`), renders through the same detail page, and disappears the
moment the inputs change. Nothing about it is stored.

### 1.2 A playlist versus the four things it is not

This section exists because founder feedback F14 (2026-09-08) was exactly a
collapse of two of these into each other.

| Object | Built by | Unit | Persisted | Route |
|---|---|---|---|---|
| **Playlist** | `app.js:buildPlaylist` from typed text | whole episodes | yes, `cp_playlists`, cap 50 | `#/playlist/<id>` |
| **Generated playlist** | `app.js:generatedPlaylists` from interest leaves | whole episodes | no — recomputed per render | `#/playlist/gen-<leaf>` |
| **Subject queue** | `app.js:buildCards` → `state.cardSlots`, projected by `app.js:subjectQueueById` | whole episodes | no — rebuilt every load | `#/subject/<branch>` |
| **"Episodes for you"** | `app.js:buildCards`, rendered by `app.js:episodesForYouHtml` | single episodes in cards | no | Home only |
| **Foray** | `backend/src/generation/runPipeline.ts` | *segments* of episodes plus 4a's own narration | yes, `data/forays.json`, committed | `#/foray/<id>` |
| **Up Next** | the listener, one episode at a time (`app.js:addToQueue`) | whole episodes | yes, `cp_queue` (ids only) | `#/queue` |

The load-bearing distinctions:

- **A playlist is not a Foray.** A Foray is an ordered run of anchored
  *segments* with narration between them, produced by a model pipeline and
  published by a founder. A playlist is whole episodes, produced by a
  deterministic local scorer, published by nobody. They share no code:
  `player/foray-resolve.js` never sees a playlist, and `app.js:buildPlaylist`
  never sees a segment.
- **A playlist is not "Episodes for you".** "Episodes for you" is
  `state.cardSlots` rendered verbatim (`app.js:episodesForYouHtml`) — the
  discover pool ranked by interest, one episode per branch. F14 reported that
  "Playlists for you" had become the same thing, because the first
  implementation of `playlistsForYouHtml` projected `state.cardSlots` into
  playlist cards. PR #535 replaced that with `generatedPlaylists()`, which draws
  from interest **leaves** and explicitly excludes every episode a card slot is
  already showing (§3.2).
- **A playlist is not Up Next.** `docs/listening-queue-plan.md` §2 made
  `cp_queue` a new key deliberately: one flat, ordered array of ids, no snapshots,
  one global list. An episode can be in both at once; they answer different
  questions ("a list I asked for about a subject" vs "the next thing I'll play").
  Only Up Next auto-advances (§3.5).

### 1.3 Who it is for, and the page's job

- **The listener who names a subject.** The Create tab is the front door
  (`app.js:renderCreate`); `#/playlists` carries the same form
  (`app.js:renderPlaylists`, `#pl-form`). The job of that page is to turn one
  sentence into a list they can play, or to say honestly that the catalogue
  cannot answer it — `SearchEngine.classifyResults` returns `ok` / `sparse` /
  `empty` and the empty branch offers real adjacent topics rather than padding
  (§3.1, §4.1).
- **The listener who has not typed anything.** Home's "Playlists for you"
  (`app.js:playlistsForYouHtml`) exists so the concept is populated on day one:
  their own recent playlists first, then up to three generated from interests.
- **The listener coming back.** Library (`app.js:renderLibrary`) and the drawer
  (`app.js:renderDrawer`) list saved playlists; the detail page
  (`app.js:renderPlaylistDetail`) is the only place a playlist is played, part by
  part.

### 1.4 What this document does not govern

- **The scorer.** `search-engine.js` (`interpretQuery`, `scoreMatch`,
  `searchWithRelaxation`, `classifyResults`, `diversify`) is shared with Shows
  search and with the `tools/test-search.mjs` battery. This document states the
  constants a playlist depends on and what they mean; the calibration argument
  lives in that file's own comments and in `test/search-tiering.test.js`.
- **Playback internals.** `player/client.js`, `player/queue-manager.js` and the
  native plugins own what happens after `ForayPlayer.play(item)` is called. §3.5
  covers only what the playlist path hands them and what comes back.
- **The catalogue pipeline.** How `data/discover.json` and `data/catalog.json`
  are built (`tools/refresh/`, `tools/classify/`) is owned by
  `docs/CATALOG-PIPELINE.md`. §2.2 measures its *output*, because that output is
  the direct cause of issue #547.
- **Foray generation** (`docs/curation/foray-generation-requirements.md`), which
  is out of the UI entirely by decision D8.

---

## 2. Inputs and storage

Two storage classes matter here. **Committed** files live in `data/` and are in
git; the client fetches them at boot. **Device-local** state lives under the
`cp_` prefix in `player/durable-store.js`'s tiered store and never leaves the
device.

### 2.1 The discover pool

`data/discover.json` is the only episode source a playlist can draw from.
Measured on this branch, 2026-09-09:

| Property | Value |
|---|---|
| Shape | `{ version, built_at, items[] }` |
| `items` | **2,080** |
| Item fields | `id, show, title, apple_collection_id, apple_track_id, apple_episode_url, release_date, duration_min, artwork_url, topics, hook, audio_url, audio_type, audio_bytes, duration_sec, dai_suspected` |
| Items carrying at least one topic | **2,080 (100 %)** |
| Distinct topic values used | **135** |
| Topics per item | mean **1.34**, min 1, max 5 |

It is read into `state.discover` once in `app.js:init` and never reassigned —
`app.js:buildPlaylist`'s cache-key comment states that as the reason the pool
cannot change under a query mid-session.

The pool reaches every mechanism through two functions:

- `app.js:fullPool` — projects every item through `app.js:snapshot` into
  `state.itemIndex` (an id→snapshot cache) and rebuilds `state.poolIds` (a `Set`
  of ids the catalogue holds **right now**). The distinction between the two is
  load-bearing and is the subject of §3.4.
- `app.js:poolFiltered` — `fullPool()` plus Family Mode: when on, it drops
  `explicit === true` items and everything whose first topic's root is `comedy`.
  Every playlist mechanism reads `poolFiltered()`, never the raw pool, so Family
  Mode is honoured in the builder, in the generator, and in search alike.

**The pool moves.** The nightly refresh rotates episodes through it on the web,
and the native bundle ships a per-show slice — 622 of 1,534 items at the time
`app.js`'s `#276` comment was written, roughly three weeks per show. That
movement is the entire reason a saved part carries its own snapshot (§2.5).

### 2.2 How an episode carries `topics`, and where they come from

`topics` is an array of `data/taxonomy.json` node ids. `data/taxonomy.json`:

| Property | Value |
|---|---|
| Shape | `{ version, notes, nodes[], episode_attributes }` |
| `nodes` | **194** — **41** roots (`parent === null`) and **153** leaves |
| Node fields | `id, parent, label, apple_anchor, weight, confidence, last_evidence_at` |
| Leaf id form | `"<root>/<leaf>"`, enforced by `test/data-topic-integrity.test.js` |
| `weight` | authored, range **0.5 – 1.0** across all 194 nodes |

Every topic value in the pool resolves to a real node (measured: **0** unknown
ids), which `test/data-topic-integrity.test.js` and CI's data-invariant step both
pin. Of the 135 distinct values in use, **112** are leaves and **23** are roots —
so about a sixth of the pool's topic vocabulary is root-level, which matters in
§3.2 because the generator only ever looks at leaves.

**The inheritance defect (issue #547, feedback F19).** Episode topics are not
authored per episode. They are copied from the show's `taxonomy_node_ids` in
`data/catalog.json`. Measured on this branch, 2026-09-09:

- **1,717 of 2,080** discover items (**82.5 %**) carry *exactly* their show's
  `taxonomy_node_ids`, sorted-set identical.
- **170 of 220** shows in `data/catalog.json` carry exactly **one**
  `taxonomy_node_ids` entry, which every one of their episodes then inherits.
- The worked example from #547: **26** items are tagged
  `engineering/energy-fusion`, of which **10** are *CBC Ideas*, **6**
  *Catalyst with Shayle Kann*, **3** *Lex Fridman Podcast*, **3** *TechSurge*,
  **2** *Lab to Market Leadership*, **1** *CleanTechies*, **1** *Stuff You
  Should Know*. Among them: *#499 Gary Gallagher: American Civil War*, *Are
  psychopaths real?*, three wildfire episodes.

Issue #547 measured 1,688 of 2,047 on 2026-09-09 before that day's nightly
refresh; the figures above are the same measurement after it (+33 items). The
ratio is unchanged. This is a **data** defect, not a playlist defect —
`generatedPlaylists()` selects by topic node and is doing exactly what it is
told — but every generated playlist for a contaminated leaf inherits it, and
so does every typed query the topic scorer answers from `itemTags`. §6.1.

### 2.3 Interests: where they live, how they are seeded

| | |
|---|---|
| In memory | `state.interests`, `{ nodeId: number }`, values clamped 0–1 |
| On device | `cp_interests` |
| Seeded by | `app.js:loadInterests` |
| Persisted by | `app.js:saveInterests` |
| Moved by | `app.js:nudgeTopics` (plays, picks, thumbs) and the sliders in `app.js:bindInterestsControls` |
| Cache generation | `state._interestsGen`, bumped on every write |

`app.js:loadInterests` iterates **`taxonomyNodes()`** — every node, roots and
leaves — and seeds `saved[n.id] ?? Math.max(0, n.weight)`. So on a fresh device
all 194 nodes are present with their authored weight, and no leaf is ever 0
unless the listener drove it there.

**The root-category bug is fixed in the code.** `app.js:loadInterests` used to
iterate `leafNodes()`, so a declared interest in a root (`true-crime`) was never
seeded and the next `saveInterests()` silently dropped it. The fix (D6 / U-07,
kanban `t_1cb3688a`) is the `taxonomyNodes()` call above; `app.js:taxonomyNodes`
carries the comment explaining why it is kept distinct from `leafNodes()`.
`test/interests-roots.test.js` pins it in 8 tests, including the mutation
"restore `leafNodes()` → red". **Both `docs/ui-transition-plan.md` §2 and
feedback row N3 still describe the bug in the present tense; they are stale.**
§6.2.

`app.js:nudgeTopics` moves a node and, at `PARENT_NUDGE_RATIO = 0.5`, its parent
root — once per distinct parent per call, never once per sibling leaf, and never
at all for a root named directly in the same `topics` array. Amounts in use:
`±0.08` for a thumb (`app.js:setFeedback`); the pick/play call sites pass their
own. Every write bumps `state._interestsGen`, which is folded into
`buildPlaylist`'s cache key so a rebuild after a nudge re-scores instead of
serving a stale ranking.

The interests page (`#/interests`, `app.js:renderInterests`) shows every root
plus every leaf whose weight has diverged from `Math.max(0, node.weight)`
(`app.js:interestGroups`), each as a 0–1 slider with a *Reset to learned*
control. No history feed, no evidence log — D6, deliberately not built.

### 2.4 What a saved playlist looks like

```
id             "q" + Date.now()        (buildPlaylist)  |  "gen-<leaf>"  (generated, never saved)
query          the trimmed text the listener typed
title          prettyTitle(query)
items[]        the ordered spine — one part per episode
item_ids[]     a derived mirror of items[].id, rewritten on every write
created        ISO timestamp
last_played_at ISO timestamp or null   (touchPlaylistPlayed)
sparse         true when classifyResults returned "sparse"
```

A **part** carries exactly `id` plus the seven whitelisted fields in
`app.js:PLAYLIST_PART_FIELDS`, projected by `app.js:playlistPart`:

| Kept (268 B mean/part) | Not kept (594 B) | Why not |
|---|---|---|
| `id` 52 B, `title` 62 B, `show` 32 B, `duration_min` 18 B, `apple_collection_id` 33 B, `apple_track_id` 31 B, `topics` 39 B | `audio_url` 182 B | the most expensive field **and the only one that rots** — a copied enclosure that has moved renders a play button that fails |
| | `artwork_url` 161 B | `epRow` never renders it |
| | `apple_episode_url` 134 B | derivable by `appleLink()` |
| | `hook` 97 B | only a live part reaches the player's why-line |
| | `duration_sec` 20 B | only the player uses it; rows print `duration_min` |

`topics` is kept although nothing renders it: without it an archived part cannot
be starred at all (`toggleStar` bails when `itemIndex` has no snapshot) and a
`picked` event from one would report no topics. All byte figures are measured
over the real catalogue and asserted in `test/playlist-durability.test.js`, so
widening the whitelist turns CI red rather than this table stale.

### 2.5 Limits, storage budget and the mirror

- **Cap: 50 playlists.** `app.js:savePlaylists` — `all.slice(0, 50).map(withMirror)`.
  The cap is applied on **write only**: `app.js:playlists` deliberately does not
  route its self-healing write through `savePlaylists`, so a read never truncates
  a store that already holds more.
- **Budget.** ~3.4 KB per playlist (2.7 KB of parts at 10 picks + ~0.5 KB mirror
  + ~0.2 KB metadata) → **~168 KB** for a full 50, up from ~33 KB before parts
  were stored. Worst case named rather than rounded away: the largest single part
  is 468 B, and 50 playlists of the ten longest-titled episodes come to **~252 KB**.
- **Refused writes are reported, not swallowed.** `app.js:lsSet` returns a
  boolean; `buildPlaylist` acts on it and returns `{ status: "unsaved" }`, which
  both forms turn into a specific sentence about device storage (§3.1, §5.4).
- **`item_ids` is a derived mirror**, kept in step by `app.js:withMirror` on every
  write. It exists so a listener whose service worker is still serving an older
  `app.js` — which reads `p.item_ids.length` in `renderPlaylists` — does not get a
  blank view for the length of the update window. 47 B a part buys that.
  `items` is authoritative; `app.js:hydratePlaylistParts` repairs a disagreeing
  mirror rather than believing it.

### 2.6 Migrations

Two, both in `app.js:playlists`, both idempotent and both safe to run whenever
they happen to run.

1. **`cp_quests` → `cp_playlists`** (the original key rename). Read once when
   `cp_playlists` is absent, plus a `prettyTitle(p.query)` backfill for entries
   that never had a title. Pinned by `test/playlist-durability.test.js`'s
   "THE FIRST MIGRATION STILL WORKS".
2. **`item_ids`-only → snapshotted `items`** (`app.js:hydratePlaylistParts`,
   #276). Three outcomes per id, in order: the live pool has it → a full part,
   snapshotted now; `cp_saved` has it (the listener starred it) → recovered from
   that snapshot; neither → **stays a stub `{ id }`**, keeps its position, and is
   retried on every read, so it upgrades itself the day the pool carries that
   episode again. **Nothing is ever dropped.** A version that deleted what it
   could not resolve would empty a healthy playlist on a partial deploy or a
   stale service-worker cache (`state.discover === null`) and write that verdict
   down permanently.

Both run inside one pass over the store, share one lazily-built
`{ pool, saved }` source so 50 legacy playlists cost one `cp_saved` parse rather
than 50, and skip the pool entirely for a fully-snapshotted playlist
(`spine.some(part => part && part.id && !part.title)` is the fast-path guard).
A non-object entry in the array is dropped — there is nothing in it to lose —
because six call sites iterate that array and one `null` used to throw out of
all of them at once.

### 2.7 Per-device versus shared

**Everything about a playlist is per-device.** There is no playlist table, no
playlist API route and no sync path: `grep -rl playlist api/ backend/src` returns
only `backend/src/types/ladders.ts`, which is unrelated. Specifically:

- `cp_playlists`, `cp_interests`, `cp_saved`, `cp_history`, `cp_queue` are all
  device-local, held by `player/durable-store.js` in memory + localStorage +
  IndexedDB (+ Capacitor Preferences on native). Durability against eviction is
  the point of that store; transmission is not one of its tiers.
- `playlist_built` and `playlist_removed` are **local-only events**:
  `app.js:toEventRow`'s `switch` has no case for them, so they fall to
  `default: return null` and are never inserted server-side. The comment on that
  line names them.
- What *does* leave the device when a playlist part is played is the ordinary
  `picked` / `play_started` event — `{ episode_slug, topics, app }` — with no
  playlist id and no query text. `app.js:bindPickLogging` passes
  `ctx: "playlist-<id>"`, but `toEventRow` only forwards `context` when it is one
  of `SB_ARCHETYPES`, which `playlist-…` is not.
- `docs/legal/privacy-policy.md` §2 and `docs/legal/data-safety.md` both state
  the "In-app search history: No" claim on exactly this basis.

**The consequence for design.** F3 asks for "similar playlists". Because
`cp_playlists` is per-device, "similar" today can only mean *this device's own
playlists*; a shared or global notion of a playlist does not exist and would need
a backend that has not been designed. §6.3.

---

## 3. The mechanisms

### 3.1 Building a playlist from a typed request — `app.js:buildPlaylist`

**Signature.** `buildPlaylist(query) → { status, playlist? , suggestions? }`.
`status` is one of `ok`, `sparse`, `empty`, `unsaved`.

**Steps, in order:**

1. `SearchEngine.interpretQuery(query, searchCtx())` → `{ groups, filters, … }`.
   `searchCtx()` is a session-lifetime memo of `{ semantic, itemTags, discover }`.
2. **Nothing to interpret.** If `!interp.groups.length && !interp.filters.length`,
   return `{ status: "empty", suggestions: [] }` immediately — note the empty
   suggestion list; adjacent-topic suggestions are only produced on the *scored*
   empty path below.
3. `poolFiltered()` — the Family-Mode-filtered pool, and the call that refreshes
   `state.itemIndex` / `state.poolIds` as a side effect.
4. **Cache lookup.** Key is `JSON.stringify([query, familyMode(), state._interestsGen || 0])`
   against `searchCache`, a plain `Map` bounded by `SEARCH_CACHE_MAX = 200` and
   **cleared wholesale on overflow** (every entry is a pure function of its key
   and cheap to rebuild). The three key components are exactly the three things
   that can change what the same typed query should return in one session.
5. `SearchEngine.searchWithRelaxation(pool, interp, 2, state.itemTags, interestScore)`
   — `minScore = 2`; `interestScore` is the rank fallback used when the query has
   no content tokens at all (a bare "comedy", "something short"). Only `results`
   is destructured; **the `relaxed` flag is discarded** (§6.6).
6. `SearchEngine.classifyResults(cached.results, { listenedShows: listenedShows() })`
   → `{ status, picks }`. Caching happens **before** this call, deliberately:
   `classifyResults` reads `listenedShows()`, which changes on every pick
   independent of the query, and it is O(results) rather than O(catalogue).
7. **Empty.** Return `{ status: "empty", suggestions: SearchEngine.suggestAdjacentTopics(interp, ctx) }`
   — deterministic, catalogue-backed suggestions only; an uncovered related
   concept is dropped rather than suggested.
8. **Otherwise persist.** Build `withMirror({ id: "q" + Date.now(), query,
   title: prettyTitle(query), items: picks.map(x => playlistPart(x.i)), created,
   last_played_at: null, sparse: status === "sparse" })` and
   `savePlaylists([playlist, ...playlists()])` — newest first. If that write is
   refused, return `{ status: "unsaved" }` rather than a playlist the detail page
   would render as "Playlist not found."

**The tiering rule** (`search-engine.js:classifyResults`), which is what makes a
playlist honest rather than padded:

| Constant | Value | Meaning |
|---|---|---|
| `STRONG_RATIO` | **0.5** | a result is "strong" if `sum >= results[0].sum * 0.5` — relative, so it works for both the `scoreMatch` scale (~2–16) and the `interestScore` fallback scale (~0–1) |
| `RICH_MIN` | **6** | fewer than 6 strong results ⇒ `sparse` |
| `DEFAULT_CAP` | **10** | maximum picks, hence maximum parts in a new playlist |
| `PER_SHOW_CAP` | **2** | per-show cap in `diversify`, with a backfill pass so capping can never *shrink* a genuinely single-show answer |
| `LISTENED_PENALTY` | **0.85** | 15 % down-weight on shows in `cp_history` — a nudge toward discovery, never an exclusion |
| — | `strong.length < 2` | ⇒ `empty`. One clearer is not an answer |

`sparse` widens the candidate set to `strongPrefix(results, bar)` — the prefix of
the ranking ending at the last bar-clearer — **only** when the strong set spans
more than one show and the prefix fits inside `cap`. Both guards are behavioural
and both have fixtures in `test/search-tiering.test.js`.

**Titles.** `app.js:prettyTitle` strips `SearchEngine.STOPWORDS`, keeps up to
`TITLE_MAX_WORDS = 8` significant words, upper-cases anything in `ACRONYMS`
(`ai, bbq, ww2, ww1, f1, nasa, diy, cia, fbi, nfl, nba, mlb, ufc, tv`), then
trims **whole words from the end** until the string fits `TITLE_MAX_CHARS = 60`.
Falls back to `"Playlist"`. The 8-word budget replaced a 4-word one that turned
"history of organized crime in southern california" into "History Organized
Crime Southern" — dropping the word that pinned the topic.

**The submit guard.** `app.js:bindPlaylistFormSubmit` (and its twin
`app.js:bindCreateFormSubmit`) disable the button, set the label to `Building…`,
and then call `buildPlaylist` inside `setTimeout(…, 0)`. The timeout is
load-bearing: `buildPlaylist` is synchronous and CPU-bound and takes **1.3–8 s**
on a cold cache against the real catalogue, so without a task-queue turn the
browser never paints the disabled state and the button just looks frozen. The
`finally` restores the button whether the call returned, threw, or returned
early.

### 3.2 Generated "Playlists for you" — `app.js:generatedPlaylists`

Pure over `state`. No persistence, no backend, recomputed on every render, and
resolvable by id for the detail page (`app.js:generatedPlaylistById`, which
requires the `gen-` prefix).

| Constant | Value |
|---|---|
| `GENERATED_PLAYLIST_COUNT` | **3** — at most three sections' worth |
| `GENERATED_PLAYLIST_SIZE` | **6** — episodes per generated playlist |
| `GENERATED_PLAYLIST_MIN` | **3** — fewer than this and the leaf is skipped entirely |

**How leaves are chosen:**

1. `pool = poolFiltered()`; `slots = state.cardSlots`.
2. `slotBranches` = the set of card-slot **root** branches; `slotItemIds` = every
   episode id any card slot is showing (both `sl.items[]` and the legacy
   `sl.item`).
3. `byTopic` = a `Map` from topic id to the pool items carrying it — built over
   every value in `it.topics`, roots included.
4. Candidate leaves are `taxonomyNodes()` filtered by **all three** of:
   `n.parent !== null` (a leaf, never a root), `!slotBranches.has(n.parent)` (its
   root is not already a card slot — this is the anti-F14 rule), and
   `byTopic.has(n.id)` (the pool actually has something on it).
5. Each carries `w = state.interests[n.id] ?? 0`, is filtered to `w > 0`, and
   sorted `(b.w - a.w) || a.n.id.localeCompare(b.n.id)` — interest descending,
   ties alphabetical by node id, so the output is deterministic.

**How items are ranked:** within a leaf, `byTopic.get(n.id)` is filtered by
`!slotItemIds.has(it.id)` — **an episode a card slot is showing can never appear
in a generated playlist**, which is the mechanical half of the F14 fix — then
sorted `String(b.release_date).localeCompare(String(a.release_date)) ||
String(a.id).localeCompare(String(b.id))` (newest first, ties by id) and sliced
to `GENERATED_PLAYLIST_SIZE`. A leaf yielding fewer than `GENERATED_PLAYLIST_MIN`
after exclusion is skipped, not padded.

**Output shape:** `withMirror({ id: "gen-" + n.id, branch: n.id, title: n.label
|| n.id, items: items.map(playlistPart), sparse: false, isSubject: false,
isGenerated: true })` — the same shape a saved playlist has, so `resolveParts`
and `renderPlaylistDetail` stay one code path.

**Measured against the current pool (2026-09-09):** **90 of 153** leaves have at
least `GENERATED_PLAYLIST_MIN` items and **78** have at least
`GENERATED_PLAYLIST_SIZE`, so the generator is not supply-constrained; which
three appear is decided by interest weight and by which roots the card slots
took.

**Two consequences of the selection rule that are design facts, not bugs, but
are worth stating because they are not written down anywhere else** (§6.4):

- Because `state.interests` is seeded from the taxonomy's authored `weight`
  (min **0.5** across all nodes), the `w > 0` filter excludes only leaves the
  listener has actively driven to zero. On a fresh device the ordering is
  therefore the *authored* weights, alphabetically tie-broken — the same three
  playlists for every new listener with the same card slots.
- Because `buildCards` gives card slots the listener's **highest**-interest
  roots, and generated playlists exclude every leaf under a card-slot root, a
  generated playlist is by construction drawn from a *lower*-interest root than
  "Episodes for you". That is what keeps the two sections distinct (F14); it also
  means the listener's single strongest interest never produces a generated
  playlist.
- The **23** root-level topic values in the pool can never seed a generated
  playlist at all, because step 4 requires `n.parent !== null`.

### 3.3 Playlist search and matching

Two functions, both local and synchronous, both reading state already in memory.

**`app.js:playlistMatchesQuery(playlist, query)`** — does one of the listener's
own saved playlists cover this query?

- Lower-cased substring test, in two passes: the playlist's own `title` first,
  then `playlistSpine(playlist).some(part => (part.topics || []).some(t =>
  t.toLowerCase().includes(q)))`.
- **`playlistSpine`, not `resolveParts`** — so a query still matches an archived
  part's stored topics without needing the live pool.
- **Not** routed through `SearchEngine.interpretQuery`/`tokenize`, for the reason
  `test/show-search.test.js` pins for `searchShows`: a listener's own playlist
  name is not a topic query, and stripping "the"/"on" would break a literal name
  match.
- Empty/whitespace query returns `false`.

**`app.js:generatedPlaylistCandidatesForQuery(query)`** — `generatedPlaylists()`
filtered to those whose **title** (the leaf's label) contains the query as a
substring. No re-ranking, no rebuild for the query.

**The results section** (`app.js:renderPlaylistSearchResults`, mounted at
`#pl-search-results` on the Shows/Search page):

1. Guarded by the same `showSearchToken` every section on that page shares, so a
   fast retype cannot let a stale computation paint over a newer one.
2. `own = playlists().filter(p => playlistMatchesQuery(p, query))`, then
   `generated = generatedPlaylistCandidatesForQuery(query).filter(p => !ownIds.has(p.id))`
   — own playlists lead, generated follow, deduplicated by id.
3. Each row is the same `.pl-row` markup `renderPlaylists` prints (title, then
   `${resolveParts(p).length} parts`, then a chevron), with generated rows
   carrying a `Generated for you` badge — D5's wording, reused verbatim.
4. **The CTA.** When neither list has anything, the section clears itself and
   defers `createPlaylistCtaHtml(query)` by `setTimeout(…, 0)`. That defer is
   load-bearing for the same reason as §3.1's: the CTA calls
   `app.js:topicSearchStatus`, which runs the identical
   `searchWithRelaxation` scan (1.3–8 s cold), and the no-playlist-match case is
   the *common* one (any show-name search). The token is re-checked inside the
   timeout.
5. `app.js:topicSearchStatus` is `buildPlaylist` **without the side effect** —
   same `interpretQuery`, same pool, same `searchCache` (same key shape, so the
   two share work), same `classifyResults` — returning only `status`. It exists
   so typing into Search never silently accumulates playlists the listener did
   not ask to save. The CTA appears only when that status is `empty`.
6. `app.js:bindCreatePlaylistCta` navigates to `#/playlists`, then on the next
   task turn prefills `#pl-input` and dispatches a `submit` on `#pl-form`. It
   does **not** call `buildPlaylist` itself: there remains exactly one creation
   path per form, which is D8's scope line.

`ui2On()` returns `true` unconditionally since the U-11 cutover, so the
flag-off branch at the top of `renderPlaylistSearchResults` is dead code
(§6.7).

### 3.4 Resolving parts against the live pool — `app.js:resolveParts`

`resolveParts(p)` maps `playlistSpine(p)` to one row per saved part, in saved
order, each tagged with what the live pool can still do for it:

| State | Test | Rendered as |
|---|---|---|
| `live` | `state.poolIds.has(id)` → `state.itemIndex[id]` | `app.js:epRow` — full row, in-app play, star, + Up Next |
| `archived` | not live, but the part has a `title` | `app.js:archivedRow` — named, linked to `#/episode/:id`, star and + Up Next, and `notPlayableNote()` instead of a play button |
| `unnamed` | neither | `archivedRow`'s id-only branch — "Part no longer in the catalogue", no controls at all |

**Two rules this function exists to hold:**

1. **The pool can no longer change the length of a playlist.** Both the list view
   and the detail view print `resolveParts(p).length`, from one function, so
   "7 parts" over five rows — the #276 defect — cannot recur.
2. **Liveness comes from `state.poolIds`, never from `state.itemIndex`.**
   `itemIndex` is a snapshot cache nothing clears, and `renderPlaylistDetail`
   itself writes archived parts into it so they can be starred. An earlier
   version asked `state.itemIndex[part.id]` and therefore called an archived part
   live on the *second* render of the same page in one session — a fix that
   worked exactly once and then restored the defect.
   `test/playlist-durability.test.js`'s "THE SECOND RENDER SAYS WHAT THE FIRST
   SAID" pins it.

"Label, never exclude" (#226) is the catalogue rule written *for* playlists: a
part the app can still describe is kept and labelled, never silently dropped.

`app.js:rowsForIds` is the same three-way resolution for a bare id list, shared
by Up Next (`queueRows`) and Library's Saved/History sections, so a change to the
liveness rule cannot land in one caller and not the others.

### 3.5 Playback of a playlist

**There is no playlist-level playback.** A playlist plays one part at a time,
each as an ordinary single-episode play:

- `renderPlaylistDetail` calls `bindPlay($("#view"))` **with no `origin`**, so
  `app.js:bindPlay` calls `clearQueuePlaybackOrigin()` and then
  `window.ForayPlayer.play(item, { why: whyFor(id, item) })`.
- `app.js:whyFor` prefers a curated `why_line` from `state.session.cards`, else
  the item's `hook`. An archived part has neither (`hook` is not persisted).
- Only a play started **from `#/queue`** can auto-advance
  (`app.js:setQueuePlaybackOrigin`, `app.js:advanceQueueOnEnded`,
  `docs/listening-queue-plan.md` §4 Q1) — and only when
  `app.js:autoAdvanceOn` (`cp_autoadvance`, default **false**) is on. So
  when a playlist part ends, playback stops. Auto-advance through a playlist is
  **not implemented** (§6.5); CLAUDE.md product principle #1 bans autoplay
  chains, and Up Next is the single, deliberately narrow exception carved out of
  that rule.
- **When an item is gone**, there is nothing to play and nothing is attempted:
  `archivedRow` renders `notPlayableNote()` — plain text, no href, nothing to
  click — because `audio_url` was deliberately never persisted and a link-out was
  removed in 2026-09-03 (4a plays everything itself or says so honestly).
  `test/playlist-durability.test.js` pins that an archived part offers no
  clickable action at all, so nothing false is ever logged for it.
- **The "next" marker** is `rows.findIndex(r => r.state === "live" &&
  !history.has(r.item.id))` — it can only ever land on a part that can actually
  be opened.
- **Played count** is an id-in-history question, not a liveness one: a part
  played before it aged out still counts as played.
- **`last_played_at`** is written by `app.js:touchPlaylistPlayed`, called from
  `bindPickLogging` when the click context matches `/^playlist-(.+)$/`. Note this
  fires on the **link-out/pick** path; an in-app `play` through `bindPlay` does
  not touch it (§6.8).

### 3.6 The Create page — `app.js:renderCreate`

U-06 / D7 / D8. The screen is the mockup's Create, restyled, with a
**Playlist | Foray** toggle where the Foray half is permanently disabled:

- `app.js:createToggleHtml` renders the Foray button with a real `disabled`
  attribute plus `aria-disabled="true"`, so it is not focusable as a control,
  and prints the honest line "Custom Forays aren't available yet — you can still
  build a playlist below." `test/create-page.test.js` pins both, with the
  mutation "enable the Foray option → red".
- The mockup's ~20/~40/~75-minute length picker is **not shown**: it sizes a
  stitched run of segments and has no meaning for a playlist of whole episodes.
- `CREATE_SUBJECT_SUGGESTIONS = ["The history of the Fed", "Mechanical watches",
  "Small launch economics"]` render as pills that fill the input and focus it.
  They do not submit.
- Submission is `app.js:bindCreateFormSubmit` → the **same** `buildPlaylist`,
  so a playlist built here and one built from `#/playlists` produce byte-identical
  `cp_playlists` entries (the card's acceptance line, pinned by
  `test/create-page.test.js`). The only difference is the logged event, which
  carries `source: "create"`.
- The mockup's fake `idle → building → done` step list is deliberately not
  ported: `buildPlaylist` is real synchronous work with no intermediate stages,
  so only the honest part of that shape — a `Building…` transient — survives.

### 3.7 Subject queues (the adjacent mechanism)

`app.js:subjectQueueById` projects a `state.cardSlots` entry into the playlist
shape (`items`, `isSubject: true`, `withMirror`) so `#/subject/<branch>` renders
through `renderPlaylistDetail` exactly like a saved playlist. Nothing is
persisted, every part resolves `live` by construction, and there is no remove
button. It is listed here because it shares the entire render path and because
D5's original wording ("generated … via the existing subject queues") described
generated playlists as these — which is what F14 rejected.

---

## 4. Quality rules and gates

### 4.1 What is validated

| Rule | Where | Enforcement |
|---|---|---|
| An answer is `ok`, `sparse` or `empty` — never padded toward `cap` with sub-bar filler | `search-engine.js:classifyResults` | `test/search-tiering.test.js`, `tools/test-search.mjs` battery |
| A single bar-clearing result is not an answer | `classifyResults` (`strong.length < 2`, and again `picks.length < 2`) | as above |
| No more than `PER_SHOW_CAP = 2` per show while other shows are available, with backfill so a genuinely single-show answer is not shrunk | `search-engine.js:diversify` | `tools/test-search.mjs` |
| The pool cannot change a saved playlist's length | `app.js:resolveParts` (one function, both views) | `test/playlist-durability.test.js` (floor **33**, zero slack) |
| A part is never dropped — archived and unnamed parts keep their position | `app.js:hydratePlaylistParts`, `app.js:archivedRow` | as above |
| A saved part carries exactly the seven whitelisted fields and no more; the rotting/expensive fields are not copied | `app.js:PLAYLIST_PART_FIELDS`, `playlistPart` | as above, asserted against the real catalogue |
| The store stays inside its stated byte budget at 50 playlists | `app.js:savePlaylists` | as above |
| A refused write is reported, not navigated to | `app.js:lsSet` → `buildPlaylist` `"unsaved"` | as above |
| An archived title is escaped, so a hostile feed cannot reach the page through a saved playlist | `app.js:archivedRow` via `esc()` | as above; `test/app-security.test.js` floors the escaping convention repo-wide |
| A corrupt store costs one row, not the whole app | `app.js:playlists` (`filter(p => p && typeof p === "object")`), `app.js:partId` | as above |
| A generated playlist is an interest leaf filled from the pool, never a card slot | `app.js:generatedPlaylists` | `test/home-v2.test.js` (floor **9**) — "F14: a generated playlist is an interest leaf filled from the pool, never a card slot" |
| A generated card is badged "Generated for you"; the listener's own never is | `app.js:playlistCardV2Html` | `test/home-v2.test.js` |
| Search's Playlists section ranks own before generated, dedupes, and its CTA never itself creates a playlist | `app.js:renderPlaylistSearchResults`, `bindCreatePlaylistCta` | `test/search-playlists.test.js` (floor **17**) |
| The Playlists section is presentation-only — no scoring change | — | `test/search-playlists.test.js` asserts the `search-engine.js` diff is additive and that the full `tools/test-search.mjs` battery passes unchanged |
| Create builds through the same `buildPlaylist` and the Foray toggle is inert | `app.js:renderCreate` | `test/create-page.test.js` (floor **8**) |
| Every root, and every diverged leaf, is seeded and persisted | `app.js:loadInterests` | `test/interests-roots.test.js` (floor **8**), `test/interests-page.test.js` (floor **11**) |
| Every taxonomy id referenced by a data file exists, and every leaf id is `"<root>/<leaf>"` | `data/taxonomy.json` | `test/data-topic-integrity.test.js` (floor **12**) |
| Playlist data never leaves the device | `app.js:toEventRow` `default: return null` | `test/data-deletion.test.js` scans the shipped source for `cp_` literals and floors the key list at **22** families |

Suite floors live in `test/suite-integrity.test.js`; `playlist-durability` is
floored **with zero slack** because saved playlists decay silently and weeks
pass before anyone notices.

### 4.2 What is not validated

Stated plainly, because these are the gaps §6 draws on.

- **Nothing checks that an episode's `topics` are actually about that episode.**
  `test/data-topic-integrity.test.js` checks that a topic id *exists*, not that
  it is *right*. So a mis-tagged episode enters a generated playlist unchallenged
  — which is exactly issue #547: 82.5 % of the pool inherits its show's label
  wholesale, and 170 of 220 shows carry a single label. #547's own item 3 asks
  for "a regression check: no generated playlist for leaf L may contain an
  episode whose only claim to L is its show's label." **That check does not
  exist.**
- **Nothing checks a generated playlist's coherence at render time.** There is no
  minimum topic overlap between the six items, no show-diversity rule (unlike
  `diversify`'s `PER_SHOW_CAP = 2` on the typed path, `generatedPlaylists` applies
  **no per-show cap at all** — six episodes of one show is a valid generated
  playlist), and no exclusion of already-played episodes.
- **Nothing checks that a typed playlist's picks stay relevant over time.** The
  scorer runs once, at build; a playlist is a frozen answer.
- **No gate exists on playlist *content* at all** in the sense
  `tools/foray/check-forays.mjs` gates a Foray. There is no `check-playlists.mjs`
  and no publish step, because a playlist is per-device and never published.
- **The `relaxed` signal is computed and discarded** (§3.1 step 5), so a query
  whose duration filter was dropped to find any results at all looks
  indistinguishable from one that was answered as asked.

---

## 5. Outputs — what the listener sees

### 5.1 Home — "Playlists for you"

`app.js:playlistsForYouHtml`, the fourth section of `renderHomeV2` (greeting →
Jump back in → Forays for you → **Playlists for you** → Episodes for you), pinned
in that order by `test/home-v2.test.js`.

- Own playlists: `[...playlists()]` sorted by `(b.last_played_at || b.created || "")`
  descending, `slice(0, 3)`.
- Then `generatedPlaylists()` — up to 3 more.
- Renders nothing at all when both are empty; absence is a real state.
- Each card (`app.js:playlistCardV2Html`): optional `Generated for you` badge,
  the title, and `${count} episode${…}` where `count = (p.items || []).length`.
- Href is `#/playlist/<id>` for own and generated, `#/subject/<branch>` for a
  subject queue.

### 5.2 Library and the drawer

- `app.js:renderLibrary` (`#/library`) — Saved, **Playlists**, Up Next, History.
  Playlists are **linked, not embedded**: a summary row per playlist (title +
  `${resolveParts(p).length} part${…}`) capped at **5**, with an
  "All N playlists ›" link to `#/playlists` beyond that, and the honest empty
  state "No playlists yet — build one from the home screen." The reason for
  linking rather than embedding is that `#/playlists` has controls (build,
  remove) that an aggregate view has no room for at mobile width.
- `app.js:renderDrawer` — the five most recent playlists as plain links, or
  "none yet".
- `app.js:renderPlaylists` (`#/playlists`) — the build form (`#pl-form`,
  `maxlength=120`), the note element `#pl-note`, and one `.pl-row` per playlist
  showing `${resolveParts(p).length} parts` plus a localised
  `· played <date>` when `last_played_at` is set. Reachable from the drawer
  (`index.html`), from Library's overflow link, and from the search CTA
  hand-off — **not** from the tab bar.
- The tab bar (`app.js:TAB_ROUTES`) is Home · Search · Create · Library.
  `app.js:tabForHash` maps `#/playlists`, `#/playlist/…`, `#/subject/…` and
  `#/create` to the **Create** tab, while Library also lists playlists (§6.9).

### 5.3 The playlist page

`app.js:renderPlaylistDetail(id)` resolves, in order, `playlistById(id) ||
subjectQueueById(id) || generatedPlaylistById(id)`, so one page serves all three.

- Head: the title, and a sub-line
  `${rows.length} episode(s)` + `" · today's queue"` (subject) or
  `" · generated for you"` (generated) or `" playlist"` (saved) + `" · N played"`.
- `sparse` playlists print "Only found a few on this — here's what we've got."
- `app.js:partsNote` prints at most one sentence about a shortfall, with every
  plural agreeing (noun *and* verb), and does not blame the listener: ageing out
  of the pool is the app's doing. It also does not claim that rebuilding
  *replaces* this playlist — `buildPlaylist` mints a new id and prepends.
- Rows: `epRow` for live, `archivedRow` otherwise (§3.4).
- A remove button (`#pl-remove`) appears **only** for a saved playlist —
  never for a subject queue or a generated one. Removing logs
  `playlist_removed` and calls `app.js:leaveRemovedPlaylist`, which goes back one
  real step when `#/playlists` is the previous entry and otherwise navigates
  there, so a drawer deep-link does not dead-end.
- A missing playlist still gets a real page head with a working back control and
  the line "Playlist not found."
- Every archived part is seeded into `state.itemIndex` (only when absent, so a
  full pool snapshot is never overwritten by a partial one) so it can be starred
  and so a `picked` from it reports its topics.

### 5.4 Copy the listener sees on failure

All three come from `bindPlaylistFormSubmit` / `bindCreateFormSubmit`:

- `unsaved` → "That playlist could not be saved — this device has no storage
  space left. Removing a playlist you have finished with frees enough for a new
  one."
- `empty` with suggestions → `Not much on "<query>" yet — try <labels> instead.`
- `empty` without → `Not much on "<query>" yet — try different words.`

`test/playlist-durability.test.js` pins the repo's copy rules on these: no
exclamation, no blame, an actual next step.

### 5.5 Now Playing metadata for a playlist item

A playlist part plays through the **single-episode** path, so
`player/client.js:syncMediaSession` takes its non-`foray` branch and passes
`forayTitle: ""`, `index: 0`, `total: 0`. `player/media-session.js:mediaMetadata`
therefore yields:

| Field | Value for a playlist part |
|---|---|
| `title` | the episode title (`clean(item.title)`) |
| `artist` | the show name (`clean(item.show)`) |
| `album` | **empty** — `albumOf("", 0, 0)` has neither a collection title nor a part counter |
| `artwork` | the show's artwork, falling back to the app's |

So the lock screen and the car show **no indication that a playlist is playing,
and no "part N of M"** — that album line exists only for Forays. Whether a
playlist should behave like a collection there is an open product question
(§6.10); it is adjacent to feedback F15.

---

## 6. Known gaps and open decisions

Numbered so they can be cited. Each says whether it is already recorded
elsewhere.

### 6.1 Show-level topic inheritance contaminates every generated playlist — **issue #547, feedback F19**

Recorded. Measured on this branch 2026-09-09: **1,717 of 2,080** items carry
exactly their show's `taxonomy_node_ids`; **170 of 220** shows carry exactly one
node; the `engineering/energy-fusion` leaf holds **26** items of which 10 are
*CBC Ideas* and 3 are *Lex Fridman Podcast*. `generatedPlaylists()` is correct
and the data is wrong. #547's three asks: per-episode classification for the
topics that drive playlists (needs an Anthropic key at scale); a "general"
marker or multiple nodes for broad shows; and a regression check that no
generated playlist for leaf L contains an episode whose only claim to L is its
show's label. **None of the three is built.** The third is the cheapest and is
purely client-side once the data carries provenance.

### 6.2 The root-category bug is fixed in code but still described as open in two places — **not recorded anywhere**

`docs/ui-transition-plan.md` §2 ("Today's interests: `loadInterests()` seeds
**leaf nodes only**… that is the bug D6 names") and feedback row N3 ("today
`loadInterests()` seeds leaf nodes only, so a declared interest in a root
category like `true-crime` is silently discarded") both describe the pre-U-07
state. The code seeds every node via `app.js:taxonomyNodes` and
`test/interests-roots.test.js` pins it with a mutation test. N3's stated
dependency — "fix that bug first or the feature is a facade" — **is already
satisfied**; N3 is now purely the re-openable-prompt question, and
`docs/ui-transition-plan.md` U-09 already answers it ("The N3 feedback item is
satisfied by the Settings entry to `#/interests`"), which shipped:
`app.js:ensureInterestsDrawerLink` puts it in the drawer and `#/interests`
routes to `app.js:renderInterests`. What is genuinely **not** built is the
*first-run* re-entry: `showFirstTimeExplainerOnce` is still one-shot behind
`cp_intro_dismissed`, and PR #461's interest-survey chip screen is on hold.

### 6.3 F3 "similar playlists" is unanswerable as scoped — **recorded as F3, open questions unresolved**

Today a typed request *assembles*; F3 asks to *retrieve*. `app.js:playlistMatchesQuery`
plus `generatedPlaylistCandidatesForQuery` is the nearest thing that exists
(§3.3) and it is a literal substring match over the listener's own titles and
their parts' stored topics — no similarity metric, no embedding, no ranking. The
constraint F3 itself names is confirmed here: `cp_playlists` never leaves the
device (§2.7), so "similar" can only mean *this device's own playlists* until a
backend exists. The three open questions in F3 — own vs global vs subject queues
— remain open and are a product decision, not an implementation one.

### 6.4 The generated-playlist selection rule has three unstated consequences — **not recorded anywhere**

All three follow from `app.js:generatedPlaylists` and none is written down:

1. **A fresh listener gets authored defaults, not personalisation.** All 194
   taxonomy weights are ≥ 0.5, so the `w > 0` filter is nearly a no-op and the
   ordering is the taxonomy's own weights with alphabetical tie-breaks. Two
   listeners with the same card slots and no history see the same three
   generated playlists.
2. **The strongest interest never generates a playlist**, because its root is a
   card slot and `!slotBranches.has(n.parent)` excludes it. This is deliberate
   (it is what makes the section differ from "Episodes for you", per F14) but it
   is the opposite of what "Playlists for you" implies to a listener.
3. **Root-level interests are invisible to the generator.** 23 of the pool's 135
   topic values are roots; none can seed a generated playlist. A listener who
   sets a root slider to 1.0 on the interests page moves card slots and the typed
   scorer, but not this section.

### 6.5 A playlist does not play as a playlist — **not recorded anywhere**

There is no queue construction for a playlist. `renderPlaylistDetail` binds
`bindPlay` with no `origin`, so `clearQueuePlaybackOrigin()` runs and
`app.js:advanceQueueOnEnded` (which returns early unless `wasFromQueue`) never
advances anything. Playback
stops at the end of every part. Whether that is right is a product call —
CLAUDE.md principle #1 bans autoplay chains and Up Next is the single carved-out
exception — but the asymmetry is undocumented, and it means the most natural
reading of "playlist" (press play, hear the list) is not what the app does.
Related but distinct: feedback F13 ("in a playlist, neither the play nor the
pause button works") was diagnosed as the iOS-native external-pause bug (F11),
not as this.

### 6.6 The relaxation signal is computed and thrown away — **not recorded anywhere**

`search-engine.js:searchWithRelaxation` returns `{ results, relaxed }` where
`relaxed` is `"duration"` (a duration filter had to be dropped to find anything)
or `"all"` (every filter dropped). Both `app.js:buildPlaylist` and
`app.js:topicSearchStatus` destructure only `results`. So "podcasts about fusion
under 20 minutes" can silently return a list of hour-long episodes with nothing
said. The honest-answer principle that governs `sparse` and `empty` applies here
too and is not applied.

### 6.7 Dead flag-off branches survive the U-11 cutover — **partially recorded**

`app.js:ui2On` returns `true` unconditionally. `renderPlaylistSearchResults` and
`createPlaylistCtaHtml` still carry `if (!ui2On())` early returns that cannot
execute; `renderTabBar` carries one too. `test/suite-integrity.test.js` records
that the *tests* for those branches were retired (`show-search` 17→15,
`search-playlists` 18→17), so the removal was noticed on the test side but not
on the source side.

### 6.8 `last_played_at` is written on the pick path only — **not recorded anywhere**

`app.js:touchPlaylistPlayed` is called from `app.js:bindPickLogging` when
`data-ctx` matches `/^playlist-(.+)$/`. `app.js:bindPlay` — the in-app play
button, which is the primary control on every live row — does not call it. So a
playlist the listener has played entirely inside 4a keeps `last_played_at: null`,
which is the sort key for Home's "own recent playlists" and for the drawer's
five. The effect is that Home orders own playlists by `created` for anyone who
plays in-app rather than linking out.

### 6.9 `#/playlist/:id` highlights the **Create** tab while Library also lists playlists — **not recorded anywhere**

`app.js:tabForHash` maps `playlists$|playlist/|subject/|create$` to `create` and
`library$|queue$|forays$|foray/` to `library`. So opening a playlist from the
Library tab moves the highlight to Create. Minor, but it is an IA decision no
deck records.

### 6.10 Now Playing says nothing about the playlist — **adjacent to F15, not itself recorded**

§5.5: album is empty for a playlist part, so the lock screen and the car show a
bare episode/show pair with no collection context, where a Foray shows
"<Foray title> · part N of M". Whether a playlist should populate that field —
and if so with what — is undecided. F15 covers the *Foray* and narration cases of
the same surface.

### 6.11 `renderDrawer`'s sort can throw on a playlist with neither timestamp — **not recorded anywhere; a latent crash**

`app.js:renderDrawer` sorts with
`(b.last_played_at || b.created).localeCompare(a.last_played_at || a.created)`.
`app.js:playlistsForYouHtml` does the same thing but with a `|| ""` guard on both
sides. `app.js:playlists` backfills a missing `title` and missing `items` but
**not** a missing `created`, so a store entry with neither field — a hand-edited
store, a truncated write, or a `cp_quests` entry that never carried `created` —
makes `localeCompare` read a property of `undefined` and throws. Verified:
sorting `[{id:'q1'},{id:'q2'}]` with that comparator throws
`Cannot read properties of undefined (reading 'localeCompare')`. The drawer is
rendered on every navigation, so the failure would blank the drawer app-wide —
precisely the class of failure `app.js:playlists`'s own corrupt-entry filter and
the `item_ids` mirror exist to prevent. The one-character fix is the same `|| ""`
`playlistsForYouHtml` already carries.

### 6.12 A stale comment describes the wrong mechanism — **not recorded anywhere**

`app.js:generatedPlaylistCandidatesForQuery`'s header still says it reuses
"today's subject queues, `state.cardSlots`, built once per session by
`buildCards()`… projected through the existing `subjectQueueById()`". The body
calls `generatedPlaylists()` and projects nothing — this is the pre-F14
description that PR #535 superseded in the code but not in the comment. Likewise
`docs/DECISIONS.md` (the D5 entry) still records "the generated half of that
section is `state.cardSlots`", which F14 explicitly rejected.

### 6.13 No per-show cap on a generated playlist — **not recorded anywhere**

The typed path applies `PER_SHOW_CAP = 2` through `search-engine.js:diversify`.
`generatedPlaylists` applies none: it takes the six newest items on a leaf,
whatever their shows. Given §6.1's inheritance defect, a leaf dominated by one
broad show produces a generated playlist that is six episodes of that show — the
"echo chamber" outcome `diversify` was written to prevent on the other path.

### 6.14 An archived part loses its publish date — **not recorded anywhere; cosmetic**

`app.js:archivedRow` prints `fmtDate(item.release_date)`, but `release_date` is
not in `PLAYLIST_PART_FIELDS`, so a stored part never carries it and the date is
always blank for an archived row. `app.js:snapshot` *does* keep `release_date`
(added so `generatedPlaylists` can order a leaf newest-first from a snapshot), so
the field is available one layer up and simply is not projected into the part.
Cost if added: ~16 B a part, ~0.8 KB across a full 50-playlist store.

---

## 7. Appendix

### 7.1 Every function in the playlist path

| Function | File | What it does |
|---|---|---|
| `buildPlaylist` | `app.js` | The only function that creates and persists a playlist from typed text. |
| `bindPlaylistFormSubmit` | `app.js` | `#pl-form`'s submit handler: paint-guarded call into `buildPlaylist`, then navigate or explain. |
| `bindCreateFormSubmit` | `app.js` | The same for `#cr-form` on the Create screen; logs `source: "create"`. |
| `topicSearchStatus` | `app.js` | `buildPlaylist`'s scorer without the persistence side effect; returns `ok`/`sparse`/`empty`. |
| `prettyTitle` | `app.js` | Query text → a playlist title (8 words, 60 chars, acronym casing). |
| `playlistPart` | `app.js` | Projects a pool item or `cp_saved` snapshot down to the seven stored fields. |
| `withMirror` | `app.js` | Rewrites the derived `item_ids` mirror from `items`. |
| `partId` | `app.js` | A part's id, or `null` for a row corrupt enough not to have one. |
| `playlistSpine` | `app.js` | The ordered spine: `items`, else legacy `item_ids` as stubs. One definition. |
| `hydrationPool` | `app.js` | Builds `state.itemIndex` if nothing has yet; never throws. |
| `hydratePlaylistParts` | `app.js` | The #276 migration and per-read self-healing; returns whether anything changed. |
| `playlists` | `app.js` | Reads `cp_playlists` (migrating `cp_quests` once), drops corrupt entries, hydrates, writes back if touched. |
| `savePlaylists` | `app.js` | Caps at 50, re-mirrors, writes; returns whether the write was accepted. |
| `playlistById` | `app.js` | Finds a saved playlist by id. |
| `resolveParts` | `app.js` | One row per part tagged `live` / `archived` / `unnamed`. The count both views print. |
| `rowsForIds` | `app.js` | The same three-way resolution for a bare id list (Up Next, Library). |
| `touchPlaylistPlayed` | `app.js` | Stamps `last_played_at` (pick path only). |
| `subjectLabel` | `app.js` | A root branch id → its taxonomy label. |
| `subjectQueueById` | `app.js` | Projects a `state.cardSlots` entry into the playlist shape for `#/subject/<branch>`. |
| `generatedPlaylists` | `app.js` | Up to 3 themed lists of 6 from the strongest interest leaves, excluding card-slot roots and card-slot episodes. |
| `generatedPlaylistById` | `app.js` | Resolves `gen-<leaf>` for the detail page. |
| `playlistMatchesQuery` | `app.js` | Substring match over a playlist's title then its parts' stored topics. |
| `generatedPlaylistCandidatesForQuery` | `app.js` | Generated playlists whose title contains the query. |
| `renderPlaylistSearchResults` | `app.js` | The Playlists section on the Search page: own, then generated, else the deferred CTA. |
| `createPlaylistCtaHtml` | `app.js` | "Create a playlist about X", only when `topicSearchStatus` is `empty`. |
| `bindCreatePlaylistCta` | `app.js` | Hands off to `#/playlists`' single creation path. |
| `playlistCardV2Html` | `app.js` | One Home card, with the `Generated for you` badge when generated. |
| `playlistsForYouHtml` | `app.js` | Home's section: own recent (3) then generated (≤3), or nothing. |
| `renderPlaylistDetail` | `app.js` | The playlist page — saved, subject queue or generated, one path. |
| `epRow` | `app.js` | A live row: play, star, + Up Next, links to `#/episode/:id` and `#/show/:id`. |
| `archivedRow` | `app.js` | An aged-out or unnamed row: named honestly, star kept, no play. |
| `notPlayableNote` | `app.js` | The plain-text dead end that replaces a play button. |
| `partsNote` | `app.js` | The one honest sentence about archived/unnamed parts, or nothing. |
| `renderPlaylists` | `app.js` | `#/playlists`: the build form plus one row per playlist. |
| `renderCreate` | `app.js` | `#/create`: the toggle (Foray disabled), the subject field, the suggestion pills. |
| `createToggleHtml` | `app.js` | The Playlist \| Foray toggle markup. |
| `renderLibrary` | `app.js` | `#/library`: Saved, Playlists (≤5, linked), Up Next, History. |
| `libSummaryRow` / `libSection` | `app.js` | Library's summary row and section chrome. |
| `renderDrawer` | `app.js` | The five most recent playlists in the drawer. |
| `leaveRemovedPlaylist` | `app.js` | Where to go after removing the playlist you are looking at. |
| `loadInterests` / `saveInterests` | `app.js` | Seed every taxonomy node from `cp_interests` or its authored weight; persist. |
| `nudgeTopics` / `boostTopics` | `app.js` | Move a node's weight and, at `PARENT_NUDGE_RATIO`, its parent's; bump `_interestsGen`. |
| `interestScore` | `app.js` | Mean interest over an item's topics (0.5 when it has none) — the scorer's rank fallback. |
| `interestGroups` / `interestSliderRow` / `renderInterests` / `bindInterestsControls` | `app.js` | The `#/interests` page. |
| `taxonomyNodes` / `leafNodes` / `nodeById` | `app.js` | Taxonomy access; the roots-and-leaves vs leaves-only distinction. |
| `buildCards` / `branchChain` | `app.js` | `state.cardSlots` — "Episodes for you", and the exclusion set generated playlists subtract. |
| `poolFiltered` / `fullPool` / `snapshot` | `app.js` | The pool, Family-Mode filtering, and the id→snapshot projection. |
| `searchCtx` / `listenedShows` | `app.js` | The scorer's memo context and the history-derived down-weight set. |
| `interpretQuery` | `search-engine.js` | Free text → concept groups and filters. |
| `scoreMatch` | `search-engine.js` | One item's score against an interpreted query. |
| `searchWithRelaxation` | `search-engine.js` | Scores the pool, applies the primary/thin-token gates, drops filters if nothing matched. |
| `classifyResults` | `search-engine.js` | The `ok`/`sparse`/`empty` tiering and the final picks. |
| `strongPrefix` | `search-engine.js` | The prefix of the ranking ending at the last bar-clearer. |
| `diversify` | `search-engine.js` | Per-show cap with backfill and the listened-show penalty. |
| `suggestAdjacentTopics` | `search-engine.js` | Catalogue-backed suggestions for the honest-empty state. |
| `mediaMetadata` / `albumOf` | `player/media-session.js` | The three Now Playing strings; album is empty for a playlist part. |
| `syncMediaSession` | `player/client.js` | Chooses the Foray or single-episode metadata branch. |

### 7.2 Glossary

**Playlist** — an ordered list of whole episodes built from one typed request and
stored in `cp_playlists` on one device. Never published, never transmitted.

**Part** — one entry in a playlist: an episode id plus the seven whitelisted
descriptive fields. Not an audio pointer; the audio URL is deliberately absent.

**Spine** — the ordered array of parts (`items`), or the legacy `item_ids`
promoted to stubs. `app.js:playlistSpine` is its single definition.

**Mirror** — `item_ids`, derived from `items` and rewritten on every write, kept
only so an older cached `app.js` reading `p.item_ids.length` cannot blank a view
during an update window.

**Live / archived / unnamed** — the three states a part can be in relative to the
live catalogue (`app.js:resolveParts`). Live plays in-app; archived renders from
what was saved and says it cannot play; unnamed keeps its number and says why.

**Liveness** — membership of `state.poolIds`, rebuilt from scratch by `fullPool`.
Never membership of `state.itemIndex`, which is a cache the render path itself
writes into.

**Generated playlist** — a themed list computed per render from an interest leaf
(`gen-<leaf>`), badged "Generated for you", never persisted, no remove button.

**Subject queue** — a projection of one `state.cardSlots` entry
(`#/subject/<branch>`), rebuilt every load, rendered by the same detail page.

**Leaf / root** — a taxonomy node with (`parent !== null`) or without a parent.
Generated playlists come only from leaves; card slots are grouped by root.

**Interest weight** — a number 0–1 per taxonomy node in `state.interests`, seeded
from the node's authored `weight`, moved by plays, picks, thumbs and the
interests sliders, persisted to `cp_interests`.

**Strong result** — a scored result within `STRONG_RATIO` (0.5) of *this query's
own* top score. Relative, so the same rule works for both scoring scales.

**Rich / sparse / empty** — ≥ `RICH_MIN` (6) strong results, fewer than that, or
fewer than two. An empty answer offers adjacent topics; it never pads.

**Relaxation** — `searchWithRelaxation` dropping duration filters (then all
filters) when nothing matched. Computed, currently discarded (§6.6).

**Card slot** — one of the (up to four) branch queues `buildCards` produces for
"Episodes for you". Their roots and their episodes are both subtracted from the
generated-playlist candidate set.

**Up Next** — `cp_queue`, a flat ordered array of ids, the only list in the app
that auto-advances, and deliberately not shaped like a playlist.

**Foray** — an ordered run of anchored *segments* plus 4a's own narration,
generated by the backend pipeline and published by a founder. Shares no code with
playlists.

**`cp_` key** — the localStorage/IndexedDB key prefix for all device-local
listener state. `test/data-deletion.test.js` floors the family list at 22.
