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
`app.js:3675` — `const fallthrough = shown.length === 0 ? "&fallthrough=1" : "";`

The Apple fall-through fires **only when the local pass returns nothing at all.**
Measured against the live endpoint, `limit=5`:

| query | local-only | with `fallthrough=1` |
|---|---|---|
| `tim ferriss` | 1 — *The Tim Ferriss Show* | 1 |
| `lex fridman` | 1 — *Lex Fridman Podcast* | 1 |
| `sam harris` | 1 — *Making Sense with Sam Harris* | 1 |

One row, for three of the best-known shows in podcasting. Pocket Casts answers
each of those with a screenful. The fall-through is not broken — it is never
asked, because one match is not zero. **This single condition is the largest
share of "still totally sucks".**

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
**Done when.** `tim ferriss`, `lex fridman` and `sam harris` each return ≥ 10
rows with the exact show first; a query with a strong local match still paints
locally in under a millisecond; the rate limiter's behaviour under the new call
volume is measured and named. **Watch.** This raises directory call volume —
measure it and say what it costs before assuming it is free.

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

### P-05 · Episodes ride the same shape — **M · M**
**Ask.** Give episode search the two-pass treatment shows now have: instant local
pass over what is already on the device, directory/endpoint pass merged beneath.
Note `api/episodes/search.ts` fetches a show's live feed server-side, so its
latency is structurally worse than shows — measure it before designing, and if
the honest answer is "this needs a different mechanism", say that instead.

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
