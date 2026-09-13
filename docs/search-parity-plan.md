# Deck: search parity — what "as good as Pocket Casts" actually requires

**Status:** plan to cut into kanban cards, written 2026-09-13 by the founder's
Claude session after Wyatt reported that search "still totally sucks" the day
`docs/search-plan.md`'s S-01..S-08 landed. Cards are **P-**. This deck does not
replace the S-deck; the S-deck built the *machine* (a local prefix index, a
debounce, a ranking, a cache, an endpoint, a fall-through) and this deck is
about the four reasons that machine still does not answer a listener's query
the way Pocket Casts does.

The rule that governs every card, from `CLAUDE.md`: **measured beats inferred.**
Every number below was measured on 2026-09-13 against `main` and the live
endpoint, and says how.

---

## 0. The brief

Wyatt, 2026-09-13:

> "the search function still totally sucks. I thought we would have fixed that
> by now? refer to the previous conversations for what I'm after there."

The standing definition of done, from the S-deck's own §0, which quotes him on
2026-09-09:

> "right now our search feature sucks. It sounds like it should be pretty easy
> to copy paste the pocket cast search strategy, right?"

and the mechanism that brief names, which this deck adopts unchanged:

> Pocket Casts does not scan a catalogue at query time. It typeaheads over a
> small in-memory prefix index of titles **and authors**, debounces keystrokes,
> ranks by a precomputed popularity prior, caches hot queries, and falls through
> to Apple's directory — the keyless iTunes Search API — for the misses.

---

## 1. The end state, stated as a listener would test it

1. I type three letters and see plausible shows **before I stop typing**.
2. I type a **host's name** and get their show, even when the host's name is not
   in the show's title.
3. I type a show that exists **anywhere in podcasting** and I find it — not only
   the ones on a US top chart.
4. When my query matches one thing locally but twenty things in the directory,
   **I see the twenty**, with the local one first.
5. Episodes are searchable on the same terms, at the same speed.
6. All of the above works **on my phone**, not only on the website.

---

## 2. What is measured today (2026-09-13, `main`, and the live endpoint)

**The good news first, because it is real and it landed yesterday.** Typing now
filters locally on every keystroke in well under a millisecond, against 10,113
shows instead of 220; the costly passes wait for a 250 ms debounce; a repeated
query costs nothing; ranking is exact → prefix → word-start → substring with a
popularity prior; the server now truncates under the same rule the client
displays. None of that is in question, and none of it is what Wyatt is hitting.

Four things are, in the order they cost him:

### 2.1 One weak local match suppresses the entire directory

| query | local-only | with `fallthrough=1` |
|---|---|---|
| `tim ferriss` | 1 — *The Tim Ferriss Show* | 1 |
| `lex fridman` | 1 — *Lex Fridman Podcast* | 1 |
| `sam harris` | 1 — *Making Sense with Sam Harris* | 1 |

One row, for three of the best-known shows in podcasting. Pocket Casts answers
each of those with a screenful. The fall-through is not broken — it is never
asked. **This single condition is the largest share of "still totally sucks".**

**CORRECTED 2026-09-12 — THIS SECTION NAMED THE WRONG GATE, and a card written
against the version it replaces would have shipped a diff that changed nothing.**

It originally cited `app.js:3675` —
`const fallthrough = shown.length === 0 ? "&fallthrough=1" : "";` — as "the
single condition". It is *a* condition and it is not the binding one. There are
**two gates in series**, and the client's is the weaker of the two:

| | the gate | measured against |
|---|---|---|
| client, `app.js` | ask only when the LOCAL pass is empty | the **10,113**-row cut the device holds |
| **endpoint, `api/shows/search.ts:198`** | **call Apple only when the merged catalogue is empty** | **the full 19,904-row catalogue** |

The endpoint's is the one that decides, because it is measured against a
catalogue twice the size of the client's. Setting `fallthrough=1` from the client
does not make Apple answer — the endpoint still refuses unless its own 19,904
rows return zero.

**Measured 2026-09-12, live endpoint, 25 listener queries, each asked twice
(plain and `fallthrough=1`): for 23 of the 25 the two responses were
byte-identical and the flagged one came back carrying
`fallthrough: {attempted: false}`.** Apple was reached on exactly two —
`ira glass` and `hubermann` (the typo) — the only two queries where the full
catalogue returned nothing at all. **Editing the client alone would have moved 0
of those 25 queries.**

So P-02 is an endpoint change first and a client change second, and it needs both
halves: the endpoint has to become willing to answer, and the client has to ask.

### 2.2 There is no author or host anywhere in the local index
`data/show-index.tsv` is four columns — title, id, `chart_rank`, curated
(`tools/build-show-index.mjs:105-118`). No author. The S-deck said so plainly in
its §1: *"the one place the analogy breaks (we have no author field, and Pocket
Casts does)."*

It breaks harder than that note implies, because **we do have the data and we
throw it away**: `api/shows/appleShowSearch.ts:115` already keeps
`artist_name: hit.artistName`, and its own comment at `:51-53` records that the
harvester calls Apple's `lookup`, which returns `artistName`. So a host search
works only by the accident of the host being named in the title.

> **AMENDED 2026-09-12 while implementing P-03, and read this before writing
> any code against the paragraph above.** "We have the data and we throw it
> away" is true of the *product* and false of the *disk*, and the difference is
> the whole card. We throw it away **at harvest**, not at index build: nothing
> committed has an author at all. Enumerated key by key across every row —
> `data/catalog-breadth.json` (19,787 shows, 17 keys) and `data/catalog.json`
> (220 shows, 13 keys) have **zero** fields matching
> `artist|author|host|creator|publisher|owner|producer|network`. The cause is
> one line never written: `tools/harvest-catalog.mjs`'s row literal projects
> seven fields off Apple's `lookup` response and never reads `r.artistName`,
> which is sitting in the same object. `appleShowSearch.ts:115` keeps the field
> because it calls Apple **at query time** — that proves Apple has it, not that
> we harvested it. An agent reading the unamended paragraph goes looking for a
> column to project and finds nothing.
>
> Apple does hold it universally: measured 2026-09-12, a single `lookup` of 20
> ids taken from the committed index returned a non-empty `artistName` on
> **20/20**. It is a **publisher** field, not a host field — the person for
> *Joe Rogan* and *Alex Cooper*, the network for *WNYC Studios*, *Scicomm
> Media*, *iHeartPodcasts* — and on the long tail it is SEO-stuffed
> ("Hosted By: Amanda McKinney | Andrew Huberman | ..."). That distinction is
> not pedantry; it is what killed the ranking half of this card. See P-03b.

### 2.3 The local index is half of a small catalogue
10,113 rows (`wc -l data/show-index.tsv`), from a `chart_rank <= 100` cut chosen
on a measured budget (`tools/build-show-index.mjs:132-137`: the full 19,904 is
398.4 KB gzip against a 400 KB budget). And 19,904 is itself only the US
top-chart set — Apple's directory is roughly 2.5–4 M shows. So the local index
is about 0.3 % of what a listener thinks they are searching, and 2.1 means the
other 99.7 % is unreachable for any query that matches one local row.

### 2.4 His phone does not have any of yesterday's work
The last store build is **2026091211**, cut from `main` at `e2934d0`. Every
search card (#657, #658) and both ranking fixes (#662, #668) merged *after* it.
Whatever Wyatt is testing on the phone is the pre-S-deck search: submit-only, no
live filtering, two unconditional network calls per submit. **A build is a
prerequisite for him being able to judge any of this**, and shipping one costs
nothing but the dispatch.

---

## 3. The design, in one paragraph

**Ask the directory whenever the directory could plausibly beat what we have,
and index the people as well as the titles.** The fall-through stops being a
last resort and becomes the normal second pass: the local index answers instantly
and always, the directory answers a beat later and is merged beneath it, and the
listener sees one list that grows rather than one row that stops. The index gains
an author column so a host's name is a first-class query, paid for by the same
budget that currently buys chart ranks 101–200. Episodes ride the same two-pass
shape. Nothing here is novel — it is the mechanism the S-deck's own §0 described
and did not finish.

*(Amended 2026-09-12 by P-05's measurement: the episode half of that last
sentence survived only in a narrower form than it was written. Episodes already
had the second pass; their first pass can only be the listener's own library,
because zero episodes are resident on the device and a real index is 375x over
budget. And the episode path's real defect was never latency — it was throwing
away 73 % of the answer it had already paid for. See P-05.)*

> **AMENDED 2026-09-12 (P-03):** the clause "paid for by the same budget that
> currently buys chart ranks 101–200" is wrong twice and it points the next
> agent at the wrong gate.
>
> 1. **Nothing buys ranks 101–200 today.** The committed cut is
>    `chart_rank <= 100`. There is no spent budget to reclaim; the column would
>    be paid for by ranks *below* 100, not above it.
> 2. **The 400 KB gzip budget is not the binding one.**
>    `tools/mobile/prepare-webdir.mjs:606` puts a **512 KB RAW** per-file budget
>    on `data/show-index.tsv`, enforced in `buildPlan` and throwing before
>    `MAX_BYTES` ever applies. Measured on the committed file 2026-09-12:
>    **435.9 KB raw = 85.1 % of that gate, 76.1 KB of headroom** (and 201.1 KB
>    gzip = 50.3 % of 400 KB, which is why gzip looks roomy and is not the
>    constraint). An author column adds roughly 189 KB of raw text — about
>    **2.5× the headroom that exists** — so a PR can pass this deck's stated
>    acceptance and still fail the mobile build. That file's header pre-refuses
>    the obvious workaround: *"It is not a knob to turn — lower the cut
>    instead."* So the real trade is the column against **chart ranks ~76–100**,
>    and it belongs to P-04.

---

## 4. Cards

### P-01 · Ship a build before anything else — **S — overlord**
**Ask.** Dispatch a release from current `main` so Wyatt is judging the search
that exists rather than the one from two days ago, and tell him the build number
and what changed. No code.
**Done when.** A build number is in his hands and he has confirmed which build
he is testing. **Human gate.** Wyatt installs it.

### P-02 · The directory is a second pass, not a last resort — **H · M**
**Ask.** Replace the `shown.length === 0` gate with a rule that asks the
directory whenever it could add something a listener would want: as a first cut,
whenever the local pass returns fewer than a named threshold of *strong* matches
(exact/prefix/word-start, not substring), and always for a query of ≥ 3
characters that no curated show matches exactly. The local results paint first
and never wait; the directory's arrive and are merged beneath them, deduped by
`apple_collection_id` and by normalised title. A directory pass that fails or
times out must leave the local list exactly as it was.
**Owned.** `app.js` (`runShowSearchCostly`, `mergeBreadth`), `api/shows/search.ts`
if the gate moves server-side, their tests.
**Done when.** ~~`tim ferriss`, `lex fridman` and `sam harris` each return ≥ 10
rows with the exact show first~~ — **REWRITTEN 2026-09-12 against the measured
ceiling, because the original is unachievable for one of its own three cases.**
A query cannot return more rows than Apple has for it, and `lex fridman` is
capped at **3**: Apple returns 4 results for that term at `limit=25` *and* at
`limit=200`, and three of the four are duplicate `Lex Fridman Podcast` entries
that the dedup collapses into one. No merge and no limit reaches ten. The other
two have room, and both also sit at their ceilings: `tim ferriss` 14,
`sam harris` 11.

> **Done when (measured ceilings — live endpoint + Apple, `limit=25`,
> 2026-09-13).** Each named case returns **its Apple ceiling rather than a fixed
> count** — `tim ferriss` ≥ 14, `sam harris` ≥ 11, `lex fridman` ≥ 3 — and in
> each the show the listener meant is somewhere in the list. A query with a
> strong local match still paints locally in under a millisecond, and the rate
> limiter's behaviour under the new call volume is measured and named.
>
> *Ranking it FIRST is deliberately not part of this card.* Measured today, with
> `rankShows` applied exactly as the client applies it, `The Tim Ferriss Show`
> lands at position 7 and `Making Sense with Sam Harris` at 3, behind titles that
> merely START with the query text. That is `rankShows`'s bucket order — a title
> beginning "Tim Ferriss" is a prefix match and outranks one that is only a
> word-start match because of its leading "The" — and Apple did not make that
> mistake; we re-sort its answer. It is a ranking change, it belongs to P-04 or a
> card of its own, and folding it in here would make a correct merge look broken.

**The condition that was chosen, and the one that was rejected.** The ask above
proposed "fewer than a named threshold of *strong* matches". **That was measured
and refused.** What shipped is **always ask, with a length floor (≥ 3 characters)
and no strength test of any kind**: `SHOW_DIRECTORY_MIN_QUERY_LENGTH` is the only
gate left on the client, and on the endpoint the caller's `fallthrough=1` is the
only gate left at all.

*Why no threshold.* It is not merely unnecessary — it is **backwards at exactly
the lengths that matter**. Measured 2026-09-12: `tim` returns **10 strong local
matches**, prefix hits, the strongest bucket there is, and **not one of them is
The Tim Ferriss Show**, which Apple returns at position 5. A threshold of ten —
the value already sitting in `app.js` as `SHOW_PREFIX_UNDERDELIVERS_BELOW` —
suppresses precisely the show the listener meant, *because* the local pass
delivered plenty. Every count threshold has that shape: the queries where the
local catalogue looks healthiest are the ones where it is answering with a
different set of shows.

*Why the floor stays.* One and two-character queries match thousands of rows and
name nothing. The floor is what keeps the directory off the first two keystrokes
of every search.

**Dedup, amended 2026-09-12 after adversarial review.** The ask says "deduped by
`apple_collection_id` and by normalised title". Normalised title alone is not
enough: the shape Apple actually varies is a **subtitle**, and the committed
catalogue already carries it — joining `data/catalog.json` to
`data/catalog-breadth.json` by `apple_collection_id` gives 164 comparable rows
and 5 of them disagree, every one a suffix or a subtitle (`The Twenty Minute VC
(20VC)` against `…(20VC): Venture Capital | Startup Funding | The Pitch`). The
rule is now the full normalised title **and** the title's *stem* — the title cut
at its first subtitle separator — with either match counting as a duplicate.
Both keys, because neither is a superset of the other: one committed pair
(`It's a Material World: …` / `It's a Material World | …`) has identical full
titles and different stems. The cost is named in `api/shows/appleShowSearch.ts`
rather than left implicit: two genuinely different shows in the committed
catalogue are now suppressed by it, and no title rule can tell them apart from
the five.

**Watch.** This raises directory call volume — measure it and say what it costs
before assuming it is free.

### P-03 · Index the author, and search it — **H · M — SPLIT 2026-09-12, see P-03a/b**
**Ask (as written).** Add an author column to `data/show-index.tsv` and to the
client's matcher, ranked below a title hit of the same strength (a show whose
*title* matches beats a show whose *host* matches). Source it from what the
harvester already stores; `appleShowSearch.ts:115` proves the field exists
upstream. Say what it costs in bytes and re-argue the budget in §2.3's terms — an
author column and chart ranks 101–200 are competing for the same ~200 KB, and the
measurement should decide, not the order the cards were written in.

**What happened.** Both halves were attempted. The card rests on a premise that
is false at rest (see §2.2's amendment: no committed row has an author), so the
column half cannot be written at all until a re-harvest. The matcher half *was*
written, against the directory rows that do carry `artist_name`, and measurement
said to throw it away. What shipped is the third thing nobody asked for and the
measurement made obvious: **show the author, don't rank on it.** Split below.

### P-03a · Keep `artistName` at harvest — **S — DONE 2026-09-12, `feat/search-parity`**
**Ask.** One field in `tools/harvest-catalog.mjs`'s row literal. Apple's `lookup`
has returned `artistName` in the same response object since the first harvest and
the projection never read it, so the repo re-fetches at query time a field it
discarded at harvest. Zero new calls, zero new quota, no key, $0.
**Done.** Shipped as `artist_name`, documented as requirement 7 in
`docs/CATALOG-PIPELINE.md`. **It is not retroactive** — every committed row still
lacks the field, and nothing may assume it is present until a re-harvest runs
(~12 min full, and it also refreshes a harvest dated 2026-07-09). **This does not
unblock P-03b by itself; it is the prerequisite.**

### P-03b · The author column in the index — **HELD, folded into P-04**
**Why held, measured rather than deferred on taste.**
1. **It fails the build, not the budget.** 512 KB raw gate, 76.1 KB of headroom,
   ~189 KB of author text. See §3's amendment. The only in-policy fix is cutting
   shows, which is P-04's question, not this card's.
2. **The ranking rule the card specifies makes search worse.** Built and measured
   2026-09-12 against the live directory over 20 host-name queries. Target show
   in the top 5: **16/20 with no author bucket, 14/20 with the card's "half a
   step below a title hit of the same strength", 15/20 with the stricter "below
   every title hit"**. Top-1: 6 / 4 / 5. Both readings of the card's own sentence
   lose to doing nothing. Two reasons, both about the field rather than the rule:
   `artistName` is SEO-stuffed on the long tail (`andrew huberman` promotes three
   shows whose artist string name-drops him over *Huberman Lab*, published by
   "Scicomm Media"), and where honest it is a *publisher* field, so an exact
   author hit is the wrong artefact by the right person (`tim ferriss` promotes
   *CØCKPUNCH*, *Tools of Titans* and *Tribe of Mentors* over *The Tim Ferriss
   Show*). Pinned as a refusal in `test/show-search-ranking.test.js`.
3. **P-02 already answers the queries this card was written for.** All 20 host
   names were run against the live `itunes.apple.com/search` the fall-through
   uses: **19 of 20 return the right show** (only `sarah koenig` is absent at
   limit=25), 11 of them at rank 1. The card's premise — "a host's name finds
   their show when the title does not contain it" — is *already true on `main`
   as of P-02* for 19/20, by a mechanism that costs no bytes.
**So the open question is P-04's, and it is one trade rather than two halves:**
*the author column makes the long tail findable by the person who makes it, and
costs the ~2,500 least-popular shows in the index; the shows you would actually
test are already handled by the directory pass. Tail, or rows?*

### P-03c · Show the author — **S — DONE 2026-09-12, `feat/search-parity`**
**Ask.** After P-02 most of the list is rows *Apple* chose, matched against an
author index we do not have — so "andrew huberman" returns *Huberman Lab* first
and nothing visible on the row contains a word he typed. `showResultRow` now
renders `artist_name` as a byline when a row has one. Gated on the field rather
than on `source === "apple"`, so it lights up for catalogue rows the day P-03a's
re-harvest lands, with no second edit.
**Done when.** A directory row explains itself; curated rows (which have no
author) render exactly as before. Pinned in `test/show-search-fallthrough.test.js`.

### P-04 · Decide what the local index is for — **M · S — needs P-02 and P-03 measured**
**Ask.** Once the directory answers every query (P-02), the local index stops
being the catalogue and becomes the *instant* tier. Re-derive its cut from that
job: it should hold what a listener is most likely to type, which is not
obviously "chart rank ≤ 100". Candidates to measure: the curated set plus the
top N by chart rank; the curated set plus everything a listener has played or
starred; a smaller cut that buys the author column. **This card is a measurement
and a decision, not a foregone change** — it may conclude the current cut is
right.

### P-05 · Episodes — **M · M — REWRITTEN 2026-09-12 after measurement, then built**

**The card as first written, kept for the record:** *"Give episode search the
two-pass treatment shows now have: instant local pass over what is already on
the device, directory/endpoint pass merged beneath. Note `api/episodes/search.ts`
fetches a show's live feed server-side, so its latency is structurally worse
than shows — measure it before designing, and if the honest answer is 'this
needs a different mechanism', say that instead."*

The measurement was taken (live endpoint, 2026-09-12, CDN busted on every
request — `x-vercel-cache: MISS`, `age: 0` on all 100+ samples) and it moved
the card. **The premise was attached to the wrong half of the endpoint, and
latency was not the episode path's real defect.**

**`api/episodes/search.ts` is two endpoints wearing one name**, chosen by
whether `show=` is present, and the two surfaces do not overlap:

- **The search page** (`app.js`, `renderEpisodeSearchResults`) calls it with
  **no `show=`** — the unscoped Apple path. **It never fetches a feed.** So the
  card's "fetches a show's live feed server-side" is **refuted for the surface
  P-05 is about**.
- **The show page's episode box** (`searchShowEpisodesScoped`) calls it with
  `?show=<id>` — the live-feed path. There the premise is **confirmed, and
  worse than stated**: 954 ms median forced-cold on Lex Fridman, 2082 ms
  observed worst.

Episodes *are* structurally slower than shows on the search page, for a
different reason: shows answer from a file already in the function bundle
(median 104 ms, no cold penalty); episodes make a third-party round trip
(median 369 ms cold, 730 ms max; 117 ms warm, and see the caveat in §4's
watch list — the server cache is per-warm-instance, so a listener's second
query is not reliably a hit).

#### The actual defect, which was not latency

`mapAppleHit` **dropped any hit whose `collectionId` did not resolve through
`showIdMap.ts`**, and `loadCatalogFallback()` read **only `data/catalog.json` —
220 ids**. (S-04's `data/shows-index-pointer.json` was never shipped; the file
does not exist on `main`, so the release path returns null on every call and
the 220-id fallback *was* production.) Meanwhile `search.ts`'s own sibling
`loadShowMeta()` **in the same file** already read `data/catalog-breadth.json`
— **19,787 ids** — and `vercel.json` already listed it in `includeFiles`.

Measured against Apple's live endpoint, 78 hits over the deck's eight probe
queries:

| query | Apple hits | mappable at 220 | mappable with breadth | dropped |
|---|---|---|---|---|
| `tim ferriss` | 10 | 0 | 10 | 10 |
| `sam harris` | 10 | 0 | 9 | 10 |
| `elon musk` | 10 | 0 | 10 | 10 |
| `artificial intelligence` | 10 | 0 | 10 | 10 |
| `the daily` | 9 | 0 | 3 | 9 |
| `lex fridman` | 10 | 10 | 10 | 0 |
| `huberman` | 10 | 9 | 10 | 1 |
| `ozempic` | 9 | 2 | 4 | 7 |
| **total** | **78** | **21** | **66** | **57 (73 %)** |

**Five of eight queries returned zero episodes with `degraded: false`**, and the
live endpoint returned exactly those counts — this was production behaviour,
not a model of it. And the drop rule's stated justification was spent: it
existed so a result is "never surfaced with a broken show link", but S-06(b)/
#560 landed after S-07 and made breadth show pages resolvable
(`GET /api/shows/search?id=863897795` → "The Tim Ferriss Show", verified live).

#### Can episodes ride the two-pass shape? Half of it already did.

`renderEpisodeSearchResults` already fires in parallel with the show passes,
paints its own container, shares `showSearchToken` and never blocks the show
list — that is the *second* pass. What was missing is the *first*, and **there
is almost nothing on the device to fill it with**: `data/catalog-client.json` is
220 shows / 100 KB carrying `episode_count` only — **zero episodes are resident
at boot**. The only persisted episode corpus is the listener's own `cp_saved`
and `cp_queue`, tens of items.

**A real local episode index is not affordable, and the number is recorded here
so it is not re-litigated from taste.** Built from `data/episode-archive.json.gz`
(98 shows, 73,719 episodes, `built_at: 2026-07-09`), a title+show_id TSV is
4.35 MB raw / **1,486 KB gzip**. Extrapolated to the 10,113 shows
`data/show-index.tsv` already covers: **~150 MB gzip against §2.3's 400 KB
budget — 375x over.** Server-side it needs a datastore production does not have
(`api/episodes/search.ts`'s own header: DB-mode "not implemented… production has
no DATABASE_URL today") plus a refresh job over ~10k feeds, plus the ingest S-04
never shipped. **A prebuilt episode index is a project, not a card.** Revisit
only if P-04 concludes the local tier should hold episodes at all.

#### What was built, in three pieces — one per surface

**Piece 1 — the id-map (the card). Search page.** `loadCatalogFallback()` also
reads `data/catalog-breadth.json`, curated merged first so a curated slug id
wins over the numeric breadth id — load-bearing, because
`backend/src/catalog/breadthCatalog.ts` drops a breadth row flagged
`in_curated`, so the numeric id for such a show resolves to nothing. Zero wire
bytes (already in `includeFiles`), zero client change, zero new infrastructure;
cost is one lazy ~95 ms read+parse per warm instance against a 369 ms median
cold round trip. The drop rule stays — an id we cannot place at all still must
not render a dead link — and its comment now says what it is actually for.

**Piece 2 — the honest instant tier. Search page.** `paintShowSearchLocal` now
paints a local episode pass on the keystroke, over `cp_saved` + `cp_queue`, and
the endpoint's rows merge beneath it deduped by `guid` (falling back to
normalised title + show, reusing P-02's `normaliseShowTitle`). It is scoped to
what actually exists on the device — **and that is the mechanism, not a
shortfall**: Pocket Casts' instant episode tier is *your subscriptions*, not the
world's episodes. `state.itemIndex` is deliberately NOT a source; it grows with
every rendered row and would put unbounded work back on the tick #662 just
cleared, as well as resurfacing the previous query's Apple results as though
they were the listener's own. Offline now answers from the device instead of
clearing.

**Piece 3 — stop paying for a feed that never answers. Show page.** The scoped
path skipped the cache write on error and set `no-store`, so `omega-tau` burned
387–756 ms on **every** query forever. The failure is now remembered for 90 s,
**keyed by show** (the feed is what a fresh `q` would refetch), replayed as
`degraded: true` with the original error — never as an empty success, which
would be a lie and would disable the client's `filterLoadedEpisodes` fallback.
Short on purpose: a cached failure means a recovered feed stays dark until it
expires.

**Done when.** `tim ferriss`, `sam harris`, `elon musk`, `artificial
intelligence` and `the daily` each return ≥ 5 episodes **against the live
endpoint**, with the query-by-query before/after in the PR body per §6. The
table above is a prediction from the committed catalogue files; **it is not the
live after-number and must not be reported as one until this is deployed.**
A saved episode's title appears in the Episodes section on the keystroke,
before any network call, and is not duplicated when the endpoint returns the
same episode.

**Watch.** Today five of eight queries return nothing, so nobody scrolls and
nobody retypes. After piece 1 every query produces results people interact
with, and `appleBucket.ts`'s 20/min limit is **per warm instance, not a global
deployment cap** — a cold start gets a fresh bucket and concurrent instances
each get their own. P-02 raises show-directory volume in the same week.
**Measure the two together and name the number before assuming it is free** —
the same watch this deck already attached to P-02.

**Also watch.** A breadth-mapped episode carries Apple's metadata, not ours:
`show_title` from `collectionName`, `audio_url` from `episodeUrl`. That is
already the behaviour of the `source: "apple"` rows shipping today, but piece 1
makes it load-bearing for ~3x more rows — so drift between Apple's show title
and ours becomes visible in the Episodes header, and an `episodeUrl` that is a
page rather than an enclosure becomes a play button that does not play. Worth
one spot-check across the newly-unblocked queries before merge; not worth
blocking on.

#### The structural note this deck should carry forward

**The show-scoped path's floor is the third-party feed origin.** 165 ms best
case, ~950 ms median on Lex Fridman, 2082 ms observed worst — and bytes do not
predict it (2284 KB in 258 ms vs 2053 KB in 954 ms: a bigger feed on a CDN is
4x faster than a smaller one on WordPress). **No amount of our code moves
that.** Do not promise the show page's episode box will feel like the search
page's. If it must, that is the one place a per-show cached episode list earns
its keep — and it is a separate card with real infrastructure behind it.

**And the measurements are one machine, one network, one day** (Windows
desktop, home broadband, 2026-09-12, n=3–5 per cell). The medians are stable
and the cold/warm split is unambiguous, but the absolute numbers are not a
phone on LTE and the tails are under-sampled. Anything graded against "under
1.5 s" should be re-measured from a device before it is called done.

### P-06 · One measured after-number, from the probe that already exists — **S**
**Ask.** `tools/search-probe.mjs` (S-01) produced the before numbers. Re-run it
after P-02/P-03 and put the before/after in `docs/search-plan.md` §1.7 beside the
existing table. Add the three queries from §2.1 as named cases, because
"one row for *tim ferriss*" is the defect this deck exists to close and it should
be impossible to regress silently.

### P-07 · The listening test — **founder gate**
**Ask.** Wyatt searches for five things he would actually search for, on the
phone, on the build from P-01 plus this deck. The question is not a number; it is
whether he finds what he was looking for without thinking about it. A no names
the query that failed, and that query becomes a case in P-06.

---

## 5. Order

P-01 immediately and independently — he cannot judge anything without it.
P-02 is the card; it is most of the win and it is a condition, not an
architecture. P-03 in parallel with it. P-04 only after both are measured.
P-05 after shows are right, never before. P-06 alongside. P-07 closes.

*(P-05 amendment, 2026-09-12: its three pieces are three PRs, one per surface —
pieces 1 and 2 are the search page, piece 3 is the show page. A PR that mixes
them gets argued on the wrong axis. Piece 1 is the one with the ratio; ship it
first and measure Apple call volume together with P-02's, per both cards' watch
lists.)*

**AMENDED 2026-09-12.** P-03a and P-03c are done and neither needed a decision.
P-03b is **held and folded into P-04**, which is now the only open question in
this deck's second half — and it cannot be answered until a re-harvest has run
(P-03a made the harvester keep the field; it did not backfill the 19,787 rows).
So: **re-harvest, then P-06, then P-04 with real numbers.** P-04's own text
already says it may conclude the current cut is right; the author column is a
cut question, and putting it there means the founder sees one trade instead of
two half-trades in different cards.

## 6. Rules for the agents

One PR per card, tests green with the killing mutation named in each header,
CRLF stays CRLF, no repo-wide `format:write`, never run `npm ci`/`npm install`
inside a junctioned worktree, never `git worktree remove` one. New test files get
a floor in `test/suite-integrity.test.js`. `api/**` is unlisted in
`tools/ci/path-policy.mjs` and needs a human merge click; `backend/src/` needs the
`founder-approved` label, which the overlord applies. Cite the card id in the PR
title. **Measure against the live endpoint and the committed index, not against a
fixture**, and put the query-by-query before/after in the PR body.
