# Plan: path to ~every English-language podcast being playable in 4a

*2026-08-31. Requested by Joey, decoupled from the show-pages UI work
(`docs/show-pages-plan.md`, PR #358, merged) so the two don't block each
other. Planning only — no implementation in this change.*

**Naming note per CLAUDE.md:** this plan is about the app's podcast
*catalogue*. It is unrelated to the `foray` audio-assembly feature
(stitched-audio units). The app is always **4a**; a stitched-audio unit is
always a **foray**. Nothing here touches `data/forays.json`, the segment
pool, or narration.

## 0. What's stale in `docs/CATALOG-PIPELINE.md` vs. still accurate

Read in full first, per the card. It's from 2026-07-09/2026-08-16 range.
Checked against `git log` and `STATE.md` for anything that superseded it:

- **Breadth-tier size is stale.** The doc's table says "~10k shows" and the
  card body says 19,787. Both are now behind current disk state: the US
  batch (`data/catalog-breadth.json`, 12.5 MB) plus the international batch
  added 2026-08-27 (`data/catalog-breadth-intl.json.gz`, 121,786 shows
  across 18 regions, §"Breadth tier, batch 2") — **~141,500 breadth shows
  on disk today**, not 19,787 and not "~10k." The card's framing that
  discovery is "mostly solved" undersells it further once the international
  batch is counted.
- **Curated tier count.** The doc's original table says "~150 shows,
  grows by editorial waves." Current `data/catalog.json` is **220 shows**
  (confirmed against the show-pages-plan's own count, done the same week).
  Consistent with the doc's growth model, just needs the number updated.
- **Client isolation rule is still accurate and still deliberate** — the
  breadth files are still never fetched by `app.js`, confirmed by grep of
  the current tree. Not stale.
- **Classification-layer precedence section is current** — its own
  self-dated numbers (2026-08-16 file) are the newest content in the doc.
- **Everything about ADR-0001 (ingestion is not the harvester's job) is
  still accurate** — read in full below.
- The doc does **not** mention the international batch's own scope
  limitation, which matters for §3 below: it captured 18 regions of Apple's
  charts, not a language field. This plan treats that gap as open, not
  closed, contrary to a first read of the card body which implied breadth
  might already be partially English-filtered "batch 2 (international)"
  might be read as "the non-English work is done" — it isn't; it only
  found more shows, in more regions, with no language signal attached.

**Bottom line correction to the card's framing:** the discovery gap is even
smaller than the card assumed (~141k shows already harvested, not ~20k),
which makes the case for §2's blocker below stronger, not weaker — more
metadata sitting idle changes nothing about whether any of it is playable.

## 1. Read ADR-0001 in full — this is the real blocker, stated plainly

**ADR-0001 (feed polling strategy) is Accepted in *design* but its own
Status line says the scheduler itself is not built.** What exists today:
`conditionalGet.ts` (ETag/If-Modified-Since plumbing), `politeness.ts`
(per-host budget/backoff), and three DB columns reserved on `shows`
(`polling_tier`, `next_poll_due_at`, `last_polled_at`). What does **not**
exist: anything that populates an `episodes` table from a feed, anything
that decides a show's `polling_tier` (the ADR says this "is deliberately
deferred until there's a populated `episodes` table to compute it from" —
a circular dependency the ADR itself names and defers rather than
resolves), and any scheduler loop that calls the polling primitives on a
cadence.

**So: yes, this is the blocker, and it is named here rather than routed
around.** "Every English podcast is IN 4a" means *playable*, and
playable requires episode data. The breadth tier is deliberately
episode-free by design (`CATALOG-PIPELINE.md` §"What stays out of scope":
"a one-shot iTunes episode grab of 10k shows would be stale on arrival").
There is no third option that produces fresh, legally-boring (original
enclosure URL) episode data without either (a) building the feed-polling
backend past what ADR-0001 currently covers, or (b) accepting stale,
one-shot episode snapshots that violate the reasoning the harvester was
explicitly built to avoid. This plan does not propose (b).

### What "in 4a" means at each stage (so the term isn't ambiguous downstream)

| Stage | Show is... | Episodes are... | Data source |
|---|---|---|---|
| A — listed | browsable via a show page/search result | absent or stale-snapshot only | breadth tier, as-is |
| B — browsable | show page shows real metadata, artwork, editorial framing | still absent — page states "episodes coming soon," never a blank/broken row (per the show-pages-plan's own "never a blank can't-play row" rule) | breadth tier + promotion (§3) |
| C — playable | full show page | live, playable via original enclosure URL, kept fresh by conditional-GET polling | curated tier + feed-polling backend |

Stage A is achievable today with zero new infra (the breadth tier already
has 141k+ show records). Stage B is what §3's bulk promotion buys — better
curation/classification confidence, still not playable. **Only Stage C is
"every English podcast is actually IN 4a" in the sense the card asks for,
and Stage C is gated on the feed-polling backend shipping past ADR-0001's
current state.** Any rollout plan that promotes shows to a show page
without episodes must say so in the UI, not imply completeness.

## 2. Bulk promotion path (breadth → curated/Stage B), not the 30/agent-run process

The manual editorial-wave process (`CATALOG-PIPELINE.md`'s "three agent
waves... 154 shows / 389 episodes," now 220) does hand-picked hooks and
per-episode curation. That does not scale and — per the doc's own
verdict — was never meant to: *"the agent-wave process is a curation
pipeline, not a catalog pipeline."* Bulk promotion needs a different,
mechanical process:

**Proposed batching key:** `chart_genre_id` + `chart_rank`, already
captured on every breadth-tier row (`harvest-catalog.mjs` line ~141-143).
Promote in descending popularity-prior order, batched per genre so no
single genre's top shows crowd out the batch (e.g. top 50 per genre per
wave, tunable).

**Promotion gate (quality floor), reusing what already exists rather than
inventing new review machinery:**
1. Must have a non-null `feed_url` (no promoting a show 4a can't play
   anyway).
2. Must carry a `classify-agent-tier1` or `classify-agent-tier2`
   classification (`breadth-classification.json`'s two highest-trust
   layers per `CATALOG-PIPELINE.md`'s precedence table) — base `genre-map`
   alone is not enough signal to promote sight-unseen; this keeps quality
   from regressing the way the doc's own measurement (rule 2's
   "add-only-fixing-children" finding) showed looser rules do.
3. `explicit` flag surfaced, not filtered — a founder call on whether
   explicit content promotes by default or opt-in (flagged below, not
   decided here).
4. Mechanical dedupe against `in_curated` — a promotion pass never
   re-adds a show already in `catalog.json`.

**What promotion actually writes:** a new record in `catalog.json`
(or a purpose-built `catalog-promoted.json` if mixing 220 hand-curated
editorial entries with thousands of mechanically-promoted ones in one file
is judged to blur "curated" — flagged as an open naming/schema call, not
decided here) with `editorial_note: null` (mechanical promotion has no
hand-written hook — Stage B pages need a template state for "no editorial
note," distinct from the 220 hand-picked shows) and no episodes (Stage B,
not C, until the feed-poller reaches it).

**This is a script, not an agent run** — `tools/promote-breadth.mjs`,
same shape as `tools/harvest-catalog.mjs` and `tools/classify-breadth.mjs`:
keyless, idempotent, checkpointed, `--dry-run` by default per repo
convention. Per CLAUDE.md workflow rule 6 ("codify repetition"), this
should ship as a committed tool, not a one-off.

## 3. English-language filtering — what signal exists, what's cheapest

**Today: no explicit language field is harvested.** `harvest-catalog.mjs`
stores `apple_genre`/`apple_genre_ids` (from `primaryGenreName`/`genreIds`)
and `region` (which Apple chart the row came from), but never captures
Apple's iTunes Lookup API's own `country`/language-adjacent fields beyond
that. Genre is not a language signal — Apple's genre tree is
language-agnostic (a `Comedy` genre show can be in any language).

**Cheapest correct signal, ranked by cost:**

1. **`region` as a weak prior, free today.** The batch-2 international
   harvest already tags each row with which of the 18 regional charts it
   came from. US charts skew heavily English but are not English-only
   (Spanish-language US charts exist); non-US English-speaking regions
   (`gb`, `ie`, `au`, `nz`, `ca`) are captured and reliably
   English-majority. This is a **prior, not a filter** — good enough to
   sort promotion order, not good enough to gate promotion alone.
2. **iTunes Lookup already returns enough to derive language for the
   promoted subset cheaply.** The Lookup API's per-result payload includes
   fields the harvester currently discards (it only keeps
   `collectionName`/`feedUrl`/`artworkUrl600`/genre/`trackCount`/
   explicitness). Re-deriving language would mean either (a) a second,
   targeted Lookup pass on the promotion candidates only (cheap — it's
   already a batched, keyless call the harvester makes; adding a field to
   what's kept costs nothing extra since the request already returns it)
   or (b) a lightweight title/description language-detection pass (e.g.
   `franc`/`cld3`-class npm package, no paid API, run only against the
   ~week's promotion batch, not the full 141k backlog at once).
3. **NOT recommended: a paid language-ID API.** Unnecessary — (1)+(2) get
   correct-enough signal at $0, keyless, consistent with this repo's
   stated preference (`CATALOG-PIPELINE.md`, ADR set) for keyless
   pipelines wherever one exists.

**Recommended combination:** region as a promotion-order prior (promote
English-majority regions first) + a keyless title/description
language-detection pass gating the batch actually promoted, logged per
show (`detected_language`, `detection_confidence`) so a wrong call is
correctable later without re-harvesting. This is new, small, keyless
tooling — not a re-harvest.

## 4. Staged rollout, acceptance criteria per stage

### Stage 0 — language-detection pass on the existing breadth backlog

- New tool `tools/classify-language.mjs`, same architecture as
  `classify-breadth.mjs`: reads `catalog-breadth.json` +
  `catalog-breadth-intl.json.gz`, writes `detected_language`/
  `detection_confidence` fields, additive only (does not touch existing
  classification layers).
- **Acceptance criteria:** every breadth row gets a `detected_language`
  value or an explicit `null` (never silently skipped); a spot-check
  sample (e.g. 100 known-English, 100 known-non-English shows by title) is
  measured for precision/recall before the first promotion wave uses it as
  a gate, and that measurement is recorded in `docs/DECISIONS.md` per
  workflow rule 4.

### Stage 1 — bulk promotion tool, dry-run only, no catalog write yet

- `tools/promote-breadth.mjs --dry-run` implementing §2's gate. Output:
  a report of what *would* promote (counts per genre, quality-gate pass
  rate, English-detection pass rate) — no write to `catalog.json`.
- **Acceptance criteria:** report is reviewable by a founder before any
  data lands; `node --test` suite covers the gate logic per-field
  (missing feed_url excluded, base-only classification excluded, etc.)
  with the mutation-naming discipline CLAUDE.md requires ("A green test is
  not evidence until you have broken it").

### Stage 2 — first live promotion wave (Stage B, browsable-not-playable)

- Run `tools/promote-breadth.mjs` for real on one bounded batch (e.g. top
  50/genre, English-detected only). Client-side change required: the
  show-pages-plan's `renderShow()` needs a documented "no episodes yet"
  empty state (see §1's Stage-A/B/C table) — this is a **dependency on
  Stage 1 of `docs/show-pages-plan.md`**, named explicitly since that
  plan didn't anticipate promoted-but-episode-less shows.
- **Acceptance criteria:** promoted shows render correctly (artwork,
  title, no editorial note, "episodes coming soon" state, never a blank
  row); `in_curated` on the breadth file updates for promoted rows exactly
  once (idempotency — re-running the tool must not double-promote or
  duplicate); bundle-size budget re-measured (`prepare-webdir.mjs`'s
  existing per-file budget check) since this materially grows
  `catalog.json`'s size for the first time since it was hand-curated.

### Stage 3 — feed-polling backend, past ADR-0001's current state

- This is the real unlock for Stage C (playable). Scope: build the
  scheduler loop ADR-0001 defers (`polling_tier` assignment once an
  `episodes` table has data to compute cadence from — a genuine
  chicken/egg the ADR names; likely resolved by seeding `polling_tier`
  from `chart_rank`/genre heuristics on first poll, then correcting from
  observed cadence) plus wiring the already-built `conditionalGet`/
  `politeness` primitives into it.
- **This is its own large piece of work and its own plan/spec per
  workflow rule 1 — not detailed further here.** Flagging it as required,
  not scoping it, is this plan's job per the card.
- **Acceptance criteria (to be detailed in that spec, named here only so
  Stage 4 isn't orphaned):** a promoted show's episodes appear within one
  polling cycle of a real-world publish, playable via original enclosure
  URL, with the per-host politeness budget holding under the batch-2 host
  concentration (many breadth shows share hosts like Libsyn/Megaphone —
  the same corner-case-8 concern ADR-0001 was written for, just at 100x+
  more shows).

### Stage 4 — full promotion + ongoing re-harvest cadence

- Once Stage 3 ships, promotion waves continue until the English-detected
  breadth backlog is exhausted, and the harvester (`harvest-catalog.mjs`)
  re-runs periodically to catch new shows entering Apple's charts —
  this needs a decision on cadence (nightly? weekly?) and whether it joins
  the existing `tools/refresh/` nightly pipeline or stays a separate,
  manually-triggered job. Flagged, not decided, below.

## 5. Founder decisions to flag explicitly (nothing here is guessed)

Per CLAUDE.md workflow rule 4, anything expensive to reverse goes in
`docs/DECISIONS.md` before implementation. These are the calls this plan
surfaces rather than makes:

1. **Deploying the feed-polling backend past ADR-0001's current state is
   the real cost and the real blocker.** This is engineering effort, not
   a paid API, but it's a new always-on service (a scheduler loop hitting
   thousands of third-party hosts on a cadence) — a genuine new
   operational surface for a company that is otherwise a static site plus
   keyless batch tools. Recommend a scoped follow-on planning card once
   this plan is approved, sized against real host counts from the
   breadth data (already harvested, so this estimate is cheap to produce).
2. **No new paid API is proposed anywhere in this plan** — restating
   explicitly since §3 evaluated and rejected one. If a founder wants
   the marginal accuracy of a paid language-ID or podcast-metadata API
   later, that's a new decision, not implied by this plan.
3. **Storage/CDN cost of artwork for a promoted catalogue.** Today's 220
   curated shows' artwork is not bundled into the client build in bulk
   (the mobile shell only bundles the referenced discover-pool episodes'
   segment data, per `STATE.md`'s "segment pool stops shipping whole"
   entry — a different mechanism, but the same class of concern). If
   promoted shows' artwork is fetched client-side on-demand (lazy, by
   `artwork_url`, not bundled), the marginal cost is near-zero — it's
   Apple's CDN, hot-linked, same as today's 220. If any caching/proxying
   of artwork is proposed later, re-flag: proxying starts to brush against
   product principle #3's spirit even though that principle is about
   audio specifically. This plan assumes lazy client-side artwork fetch
   (no new infra, no new cost) and states that assumption for a founder
   to correct if wrong.
4. **Explicit-content default for mechanically promoted shows** (§2 gate
   item 3) — promote by default with an explicit flag surfaced, or
   opt-in only. Not decided here.
5. **Schema call: does mechanical promotion write into `catalog.json`
   alongside the 220 hand-curated shows, or a separate
   `catalog-promoted.json`?** (§2.) Affects the show-pages-plan's Stage 1
   client fetch and every downstream consumer of "what does `in_curated`
   mean." Flagged, not decided.
6. **Harvester/promotion re-run cadence** (§4 Stage 4) and whether it
   joins the existing `tools/refresh/` nightly pipeline.

## 6. Product principle #3 restated for this pipeline

Per CLAUDE.md, restating explicitly since this plan proposes new
ingestion machinery: **the feed-polling backend and the bulk-promotion
tool never rehost, proxy, or transform episode audio.** Every episode a
promoted show ever plays comes from that show's own RSS `enclosure` URL,
fetched by the client (or handed to it) exactly as today's 220 curated
shows work. The polling backend's job is discovering *that a new episode
exists and its enclosure URL*, via polite conditional-GET against the
show's own feed — never downloading, caching, or serving the audio bytes
itself. This is unchanged from how curated-tier playback already works
and is not a new legal question, only a new *scale* of the same one.

## 7. Files this plan touches (planning only, none written here)

- New tools (Stage 0/1): `tools/classify-language.mjs`,
  `tools/promote-breadth.mjs` (+ test suites, + floors in
  `test/suite-integrity.test.js` per workflow rule).
- `docs/CATALOG-PIPELINE.md` — needs its size/count numbers corrected
  (§0) as its own small follow-up, since this plan found them stale while
  reading, not as part of the "no implementation" scope here.
- `docs/DECISIONS.md` — an entry once any of §5's open calls resolve.
- Backend (`src/feeds/`) — Stage 3 only, its own spec, not detailed here.
- `app.js` / `docs/show-pages-plan.md`'s Stage 1 — needs the "episodes
  coming soon" empty state named in §4 Stage 2, flagged as a dependency
  on that plan, not a scope change to it.

## 8. What this plan does NOT include

- No implementation. Each of Stage 0–4 becomes its own child card once
  approved, per the parent card's instruction.
- No decision on any of §5's six open founder calls.
- No detailed spec for Stage 3 (the feed-polling backend) — that's a
  separate, sizeable planning effort this plan recommends but does not
  write.
- Nothing here touches the `foray` audio-assembly feature, `data/forays.json`,
  narration, or segment machinery — unrelated despite the naming overlap the
  card's constraints section warns about.
