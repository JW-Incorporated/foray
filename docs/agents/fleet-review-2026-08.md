# Fleet review, 2026-08 — and the cadence that finishes the catalogue

*Commissioned 2026-08-16:* "Let's review the fleet heavily — what list are they
scrubbing, are the classifications sufficient, should they also be flagging
other things, etc. Once we're happy with that, let's set the fleet off at a
cadence to catalogue everything in about 4 weeks."

Scope: the six `foray-classify-shard0–5` Claude Cloud routines
(`docs/agents/runners.md`), the prompt they run
(`runner-prompts/classify-batch.md`), the tooling around them
(`tools/classify/`), and the list they operate on
(`data/catalog-breadth.json`).

> **Revised 2026-08-16 (PR #200).** The first version of this document (PR #199)
> auto-merged before its reviewer pass finished, and that pass found thirteen
> must-fix defects. Two were material: the recommended shard key
> `Number(id) % 6` is **badly unbalanced** (§4), and the claim that git
> "corroborates exactly" a 1/6 collision rate was **conflating batches produced
> with batches landed** (§0). Both are corrected here, along with a set of
> smaller factual errors. The headline conclusion survives; one number in the
> recommended configuration changed, and it changed the advice. The process
> lesson is recorded in §8 — it is the same one `CLAUDE.md` already records for
> PR #147, which is why it belongs in a file rather than only in a chat.

**The headline is not the cadence.** Four weeks is reachable at the cadence
already registered — every 8h, six shards, 18 runs/day — with **no increase in
run count and no extra token spend**, because five of every six runs appear to
be doing *identical duplicate work*. The cron is not the lever. One missing
command-line flag is — plus a one-line fix to how that flag splits the work.

## The four answers, up front

| Question | Answer |
|---|---|
| **1. Right list?** | Right list to *classify*; do not change it before the blitz. But it is a top-200 chart harvest and can never be more — 19,787 shows is **0.42%** of PodcastIndex's 4.71M feeds — and the argument that it "selects against us" has been substantially overtaken by ADR-0008. Fix the **order**, not the list. |
| **2. Classifications sufficient?** | No. Of 14 recorded fields, nine describe subject or display copy and five are provenance. **None** describes whether a show is *usable*, and `data/taxonomy.json` already defines the vocabulary (`episode_attributes`) that the classifier does not emit. |
| **3. "Cataloguing taste, not usability"?** | **Substantially right, with one correction that matters.** Ads are no longer the binding constraint (ADR-0008, accepted the day before this review) and the transcript sweep runs the *opposite* way to the rank/ad finding. The real ranking is transcripts > content shape > ads. |
| **4. Four-week cadence?** | Reachable in ~24 days, at the **existing** cadence, but only with a balanced shard key. Blocked on a per-routine argument only the account owner can set (`HUMAN-ACTIONS.md` #5). |

---

## 0. What the fleet is actually doing right now — measured

From `data/breadth-classification.json`, `data/classify-progress.json`,
`data/catalog-breadth.json`, `git log` and the GitHub API on 2026-08-16.

| | |
|---|---|
| Breadth catalogue | **19,787** US shows (19,726 with a `feed_url`) |
| Have a real agent classification (`source: classify-agent-tier1`) | **1,851** (9.4%) |
| Still on distrusted signal | **17,936** — 12,563 `genre-map`, 5,373 `llm-title-genre` |
| Eligible for a fresh batch (has `feed_url`, not already agent-classified) | **17,875** |
| Distinct `batch_id`s present in the file | **37**, mean **50.0** shows each (range 33–56) |
| PRs that ever landed them | **2** — PR #60 carried 25 batches in one commit, PR #86 the other 12 |
| Window those batches were produced in | 2026-07-25 → **2026-08-03**, then nothing |
| Production rate in that window (07-26 → 08-03) | **129 shows/day** |
| Configured run rate | 6 shards × every 8h = **18 runs/day** |
| `needs_review` pile | 301 (16.3% of classified) |
| `display_copy_ok: false` | 141 (7.6%) |

### The fleet is dark, and that is already filed

The last batch to land is `fresh-2026-08-03-03cc71da` (PR #86). **This is
`HUMAN-ACTIONS.md` #4**, filed by PR #198 — this review does not re-raise it,
and everything below assumes it is resolved first. Nothing here delivers a
single show until the routines are alive again.

*Be careful with the counterfactual.* At 18 runs/day the 13 dark days
"should" have produced ~230 runs — but at the **observed** 129 shows/day that is
~1,700 classifications, not the ~11,000 an unsharded-run-count calculation
suggests. The larger number is the *sharded* rate, which has never existed.

### The finding this review adds: 5 of every 6 runs appear to be duplicate work

`tools/classify/prepare-batch.mjs` **supports sharding**:

```js
shard: get("--shard", null) // "i/N" for parallel sharded runs
...
if (shardCount && Number(id) % shardCount !== shardIndex) continue;
```

The six routines' committed prompt (`runner-prompts/classify-batch.md`) contains
one literal command, shared by all six:

```sh
node tools/classify/prepare-batch.mjs --batch-size 40 --mode fresh \
  --progress data/classify-progress.json
```

No `--shard`. The shard number appears only in the *routine name*. Selection is
deterministic — priority bucket, then ascending `apple_collection_id`, no
randomness — so with no shard flag every routine walks the same list from the
same end. Simulated against the real catalogue: two runs of the selector produce
byte-identical id lists, and shards `0/6` and `1/6` (when the flag *is* passed)
have zero overlap.

The `in_flight` reservation in `data/classify-progress.json` cannot prevent the
collision. It is a git-committed file, so one shard's reservations are invisible
to its siblings until its PR merges; `main`'s copy has exactly **one** commit
ever (PR #60 — PR #86 did not touch it); and every entry in it is past the 12h
`STALE_IN_FLIGHT_MS` window and is deleted on read. There is no lockfile and no
atomic write anywhere in the pipeline.

**Two honest caveats on this diagnosis, both of which the first draft of this
document got wrong.**

**(a) Git does not corroborate a 1/6 rate — I cannot measure landing frequency
at all.** The first draft claimed "18 runs/day producing ~2.6 landed batches/day
is 1/6". That was wrong: 2.6/day is the rate at which `batch_id`s were
*produced* (derived from `classified_at`), and only **two PRs ever merged**,
each carrying many batches at once. So there is no per-run PR record to compare
against. The duplicate-work claim rests on **reading the code and the prompt**,
not on merge frequency — which is strong evidence about what the command does
and no evidence about what the routines are configured to run.

**(b) The routines are demonstrably not running the committed command.** A merge
can never exceed its batch size, yet **33 of the 37 batches merged more than 40
shows** (up to 56). So `--batch-size 40` was not what produced them. That means
the committed prompt is *not* a reliable description of the live configuration —
which cuts both ways: it is the reason the shard diagnosis needs confirming from
the routine's own config rather than from the repo, and it is also a defect in
its own right, because `classify-batch.md` calls itself "the operational
contract" and instructs the agent to re-read it every run.

**So the shard gap is the most likely explanation for the fleet's low yield, not
a proven one.** Confirming it costs one glance at a routine's configuration —
step 1 of `HUMAN-ACTIONS.md` #5, which asks the owner to copy out the command
each routine currently runs *before* changing it. (Item #4's step 3 asks only
whether each routine exists, is enabled, and when it last ran — not what it
executes — so it does not settle this on its own.) If the
routines turn out to already pass `--shard`, the diagnosis is wrong and the
throughput problem is elsewhere — say so rather than proceeding.

**If it is right, wiring the flag is a ~6× throughput increase at zero
additional spend.** That is the whole cadence answer, and it is why the cron is
not the lever.

### Two more mechanical facts that shape the plan

**The merge header guarantees a conflict.** `merge-results.mjs` rewrites
`built_at` and the whole `provenance` block every run:

```js
classification.built_at = now;
classification.provenance = { ..., last_batch_id: batch.batch_id, ... };
```

Those land on lines 3 and 7–8 of a 184,042-line pretty-printed file. **Any two
concurrent classify PRs modify the same two lines with different values → hard
conflict, even when their entry sets are disjoint.** Sharding fixes duplicate
*work* but not the *merge*: six simultaneous shard PRs would still land one and
conflict five. The cadence below staggers the shards rather than running them
together — which needs no code change.

**Auto-merge is no longer the problem.** It was: PR #86 sat open 8 days because
`automerge-nightly.yml` gated on `startsWith(head_ref, 'nightly/')`. Since
2026-08-11 the policy is path-based (`tools/ci/path-policy.mjs`), `data/` is
allowlisted, and a PR touching only `data/breadth-classification.json` +
`data/classify-progress.json` **arms and lands on green** (~60 s of CI). One trap
survives: PR #60 also committed `backend/package-lock.json` and two stray root
scripts, which are **unlisted** and fail safe to a human. Any *unlisted* file
un-arms the PR — note that `app.js`, `styles.css`, `search-engine.js`,
`STATE.md` and `HUMAN-ACTIONS.md` are root files that *are* allowlisted, so the
rule is about the allowlist, not about the root.

---

## 1. What list are they scrubbing, and is it the right list?

### The trace

```
tools/harvest-catalog.mjs        Apple genre tree (~110 subgenres)
                                  → per-genre top-200 charts (CHART_LIMIT = 200)
                                  → dedupe collectionIds → batched lookup
  → data/catalog-breadth.json    19,787 US shows, show-level only, NO description
tools/classify/prepare-batch.mjs Tier 0 genre-map prior + Tier 0.5 RSS fetch
  → (agent)                      Tier 1 judgment
tools/classify/merge-results.mjs validation + idempotent merge
  → data/breadth-classification.json
```

The curated path is separate and untouched by the fleet: `data/catalog.json`
(**213** shows) + `data/discover.json`, with hand-picked episodes, hooks and
tags. `prepare-batch.mjs`/`merge-results.mjs` have **no write path** to it, so
"curated always wins" holds by construction. `tools/classify-breadth.mjs` is the
old deterministic genre-map pass — the source of the 12,563 `genre-map` entries
the fleet exists to replace.

### The measured bias, and why it no longer says what it said

`docs/curation/grilling-foray-sourcing.md` §5.1–5.2 is the primary source.
`CHART_LIMIT = 200`, and the maximum `chart_rank` present in either catalogue
file is **200**. The catalogue is, by construction, "the top 200 of each of 110
genre charts in 19 storefronts, and nothing else can ever be in it."

Two coverage figures, and they are easy to mix up — the first draft of this
document did:

- **`catalog-breadth.json` alone (19,787 US shows) is 0.42%** of PodcastIndex's
  4.71M feeds.
- **The whole catalogue — US plus 18 international storefronts, 138,480 unique
  feeds (§5.1's count) — is 2.94%.**

Of 7,237 food/history feeds the PodcastIndex dump nominated, **88.6% were not in
that catalogue** (the source computes it against 138,470; §5.1 counts
138,480 — a 10-feed discrepancy between two docs, immaterial here). And six of the candidate sources that one
sourcing pass found were not in it at all — including **The Moreish Podcast**,
which Foray #1 now uses. (The first draft claimed six of Foray #1's own sources
were missing; that was wrong. Foray #1 draws on five shows per
`data/segment-sources.json`, and only Moreish came from outside the catalogue.)

Then §5.2, the finding the brief cites — real, well-measured, and
**misattributed** in the brief (it is not in `catalogue-broadening.md`):

| Chart rank band | Measured | % ad-free | Median ratio |
|---|---|---|---|
| 1–10 | 14 | 36% | 1.038 |
| 11–25 | 13 | 31% | 1.024 |
| 26–50 | 14 | 71% | 1.000 |
| 51–100 | 14 | 79% | 1.000 |
| 101–200 | 14 | 64% | 1.000 |

Collapsed: ranks 1–25 are **33% ad-free (9/27)**, ranks 26–200 are **71%
(30/42)**, Yates-corrected χ² = 8.22, 1 df, p < 0.01; 41% vs 72% on the stronger
byte-ratio subset. Its author's own verdict: *"n=69, one storefront, one day;
rank is within genre chart… It is enough to act on and not enough to publish."*
The raw rows came from an uncommitted throwaway script and **no longer exist** —
that table is the entire surviving record.

**Two things have happened since that make this a much weaker argument for
changing the list, and both must be said plainly.**

**(a) ADR-0008 removed ads as a gate — the day before this review.** *"Ad load
is not a rejection reason at sourcing. The content gate ("someone has to be
*explaining* something") and transcript availability remain the only grounds for
rejecting a source."* §5.2's conclusion — "The higher a show ranks, the less
likely we can build a Foray from it" — was a statement about a **binary gate
that no longer exists**. Ads are now a per-episode padding/locate parameter, not
an admission test.

**(b) On the axis that still costs money, the correlation runs the other way.**
`data/transcript-availability.json` swept 213 shows:

| | shows | episodes | with transcript | coverage |
|---|---|---|---|---|
| DAI-suspected | 144 | 59,768 | 7,966 | **13.3%** |
| non-DAI | 68 | 22,275 | 46 | **0.2%** |

A **64.5× difference, favouring the ad-injecting shows.** ADR-0008 draws the
conclusion explicitly: "because monetised shows are also the ones that pay for
transcription, they are disproportionately the ones shipping free timed
transcripts. Stuff You Should Know alone ships **2,850** of them and Odd Lots
**1,251**; together they are half of our entire free-transcript inventory…
and both were excluded."

So the top of the chart is ad-heavy *and* transcript-rich. Under the old gate
that was a straight loss. Under ADR-0008 it is a trade — and transcripts are the
side that costs 1.33× realtime of CPU on the only machine we have (32 days per
1,000 episodes, `transcription-scale-plan.md` §5).

### Verdict

**Do not change the list before spending four weeks on it.** Three reasons:

1. **Classifying is not the expensive part.** The list already exists and the
   per-show cost is one RSS fetch plus a paragraph of reasoning. The expensive
   work downstream — transcription, the locate step — is gated on *which* shows,
   which is exactly what a classification pass tells you.
2. **The one measured argument for changing it has been superseded as a gate and
   contradicted on the axis that still bills.** Re-pointing the harvest at ranks
   26–200 would optimise for a constraint the CTO removed on 2026-08-16 while
   giving up the half of the free-transcript inventory ADR-0008 just unlocked.
3. **Changing it is a different workstream with its own measured verdict.** The
   PodcastIndex dump is a **research tool, not an ingest path** — 1.8 GB down,
   6.84 GB peak, no episode table, every query a full table scan
   (`catalogue-broadening.md` §2). Broadening also resets the denominator
   mid-blitz, so "have we finished?" stops having an answer.

**But change two things about the list's *use*, neither of which needs a
re-harvest.**

**(a) The order is currently meaningless, and that is a real defect.** Selection
sorts into three priority buckets (`llm-title-genre` → `genre-map` → unseen) and
within a bucket falls back to input order, which `harvest-catalog.mjs` built as
**ascending `apple_collection_id`** — i.e. show registration age. `chart_rank`
is passed into every batch as context and **never used for ordering**. The
observed rank sequence of the next 40 is noise: `67, 36, 75, 7, 12, 4, 19, 6,
78, 86, 18, 184, …`. The entire 5,373-show `llm-title-genre` bucket must drain
before any `genre-map` show is touched.

This matters less if we finish everything in four weeks — which is the plan — so
it is a **should**, not a **must**: order within bucket by `chart_rank`
ascending, so that if the blitz stalls halfway, the half that got done is the
half a listener might encounter. One comparator in `prepare-batch.mjs`.

**(b) Write the ceiling down where consumers of the file will see it.**
`docs/CATALOG-PIPELINE.md` describes the harvest correctly, but nothing warns a
reader that 19,787 is a chart artefact rather than a catalogue. Rank 200 is a
wall; a show absent from `catalog-breadth.json` has not been assessed and
rejected, it has never been seen.

---

## 2. Are the classifications sufficient?

### What a classified show records — all 14 fields

From `merge-results.mjs`. **Nine are subject or display copy** — `topics`,
`confidence` (bucket string), `topic_confidences`, `needs_review`, `rationale`,
`display_title`, `blurb`, `display_copy_ok`, `display_copy_notes`. **Five are
provenance** — `model`, `source`, `tier`, `batch_id`, `classified_at`.

**None of the fourteen describes the show as a thing we could build from.**

Validation is genuinely good where it exists — an unknown taxonomy node id
rejects the whole show, confidence must be a real number in [0,1], copy-rule
failures withhold `display_title`/`blurb` and force `needs_review` rather than
emitting bad copy. That machinery is not the problem. What it validates is.

### What the repo already says it needs, and does not collect

`data/taxonomy.json` carries, today, unused by the fleet:

```json
"episode_attributes": {
  "depth": ["low", "medium", "high"],
  "format": ["interview", "narrative", "panel", "solo", "documentary", "hang"],
  "evergreen": "boolean"
}
```

**The vocabulary for "explanatory versus chat" already exists in this repo's own
taxonomy.** `format: "hang"` is precisely the category the content-gate
rejections fall into. The classifier reads the description and up to 8 recent
episodes (`--episodes-per-show` defaults to 8) — exactly the signal needed to
fill these three — and emits none of them.

Three further gaps, all in bytes the pipeline already has on the wire:

- **Language.** Nothing records it, anywhere, despite four of six newly-sourced
  traditions being non-English and the English-only question being a standing
  founder decision (`catalogue-broadening.md` §3). RSS carries `<language>`.
- **Liveness.** `catalog-breadth.json` has `episode_count` and `harvested_at`
  but no newest-episode date. A dead show is unusable and indistinguishable from
  a live one in the current record. The fetched feed's newest `<pubDate>`
  answers it for free.
- **A terminal dead-feed state.** `failed_fetch` retries three times with a 6h
  cooldown, and then the logic *inverts*: at `attempts >= maxFetchAttempts` a
  show becomes permanently and immediately eligible **every run**, forever, with
  Tier-0-only signal. **This is a latent defect, not a current cost** — all
  **7** entries in `failed_fetch` today sit at `attempts: 1` (six `HTTP 503`/
  `HTTP 403`, one `no <rss><channel> found`), so nothing is on the treadmill
  yet. It becomes a real tax only once the fleet runs long enough to exhaust
  retries at volume, which four weeks of blitz would do.

**Verdict: not sufficient.** A show can carry all 14 fields, be perfectly
tagged, and tell us nothing about whether a Foray can be built from it.

---

## 3. Should they be flagging other things? — the claim, tested

> *"The fleet catalogues subject… the binding constraints on whether a show is
> usable are different properties entirely… A show can be perfectly classified
> and completely unusable. If that is right, the fleet is cataloguing taste
> while the product is bottlenecked on usability."*

**Verdict: substantially right, and the strongest evidence for it is one the
brief did not cite. But the three constraints are not co-equal, ads are the
weakest of them, and building an ad flag into the fleet would be building a gate
the CTO removed on 2026-08-16.**

### Where the claim is right, measured

`grilling-foray-passages.md` §6 is the cleanest available test, because it is the
list of episodes we actually want, after every gate:

- **Nine rows in the ASR queue. Every one measured 1.0000 — ad-free.** Ads
  blocked **zero of nine**.
- **All nine are blocked on transcript availability.** Transcripts blocked
  **nine of nine**.
- **Content shape rejected 6h 02m of audio** (The Grill Coach's six "BBQ World
  Tour" episodes, §7) — *more audio than the entire funded queue*, which is
  2h 27m for ASR-1 through ASR-4.

And the content failures are the ones no subject tag can see. At **show** level:
Gurmelik Denemeleri, measured **1.0000** and rejected as "hosts riffing with no
sourced expertise"; 肉の丸一 rejected as supplier and staff interviews; Unlock
Local rejected because its guests are "an aspiring chef and family members, not
scholars"; Dis a Fi Mi's episode rejected as a supper-club business interview.
Every one of these would classify cleanly as `food` or `food/food-history`.

At **passage** level the same property bites inside shows that clear the show-level
gate — and this distinction matters, because a show-level flag would not have
caught these: in **Satay? Okay!**, a show in Foray #1's *candidate* inventory
(not among the five it ships), one passage was rejected because the hosts perform
a live sniff test and cite "video evidence *of this* on Nobby's Instagram", and
one cut point cannot be crossed at all because the hosts tell listeners to open
Google Maps (P1 deliberately ends at 815.6 s to clear it). So
content shape is partly a show property and partly an episode property; the
fleet can only ever record the former, and that is still worth having.

### Where the claim needs correcting — and this is the part to push back on

**Ads are no longer a constraint, and treating them as one would be a
regression.** ADR-0008 Decision 1: *"Ad load is not a rejection reason at
sourcing. The content gate ("someone has to be *explaining* something") and
transcript availability remain the only grounds for rejecting a source."* The
brief's framing — "if a show injects ads… no Foray can be built from it" — is
the pre-ADR-0008 position. It is now: author anyway, anchors are durable, pad if
`pad ≤ 120 s`, otherwise wait for the locate step.

Worse, **the way a fleet would naturally measure ads is invalid by ADR-0008's
own rules**, twice over:

1. **N ≥ 2 probes of the *same* episode is mandatory, not advisory.** Two probes
   of one Gastropod episode disagreed by **33.4 s**. "N = 1 bounds nothing."
   No episode in this repo has ever been probed twice except that one.
2. **`summariseShow()` is "wrong twice over"** — ADR-0008's words: it takes a
   *median* (wrong statistic) across *different episodes* (wrong axis). A
   per-show ad number is not a thing that means anything. And on `length="0"`
   feeds (Megaphone) a ratio is uncomputable at all, so the only instrument is a
   full decode — a download per probe.

A per-show ad flag on 19,787 records would therefore be cheap, confident, and
wrong — the exact failure mode ADR-0006 exists to correct. We already have one:
`data/dai-classification.json`, 213 shows of host-based inference, which
`transcription-scale-plan.md` says **over-reports** (ADR-0008 is more cautious,
calling the mid-roll shape "a well-founded inference… but it is an inference").
Being an Engineer is flagged DAI and measured at **+0.8 s and +0.3 s of decoded
duration** — no injection at all.

### The honest ranking, by what it costs us

| Rank | Constraint | Why it binds | Cost if we get it wrong |
|---|---|---|---|
| **1** | **Transcript availability** | Blocked 9 of 9 ASR-queue rows. A `<podcast:transcript>` tag makes an episode nearly free; without one it is **1.33× realtime measured** — 32 days per 1,000 episodes on the only machine we have, or a founder-approved **~$30–75** (rented GPU) to **~$150–400** (managed ASR API) | The whole pipeline stalls; this is the funding decision |
| **2** | **Content shape** | Rejected 6h 02m — more than the funded queue. The only gate ADR-0008 left standing alongside transcripts. No subject tag can see it | Wasted transcription budget on audio nobody can use |
| **3** | **Ad load** | Not a gate. A per-episode playback *parameter* (`delta_max`, spread, N) for shows we have already decided to author | A padded segment or a skipped one — never a bad cut, because `seekPrecision()` already fails honest |

### So: which belongs in the fleet's job?

**In the fleet's deterministic step (`prepare-batch.mjs`), at zero marginal
cost — this is the single highest-value change in the review.**

The fleet **already fetches the RSS feed for every show it classifies** (Tier
0.5) and throws almost all of it away. `<podcast:transcript>` tags, the
`<enclosure>` host, `<language>` and the newest `<pubDate>` are all in bytes
already on the wire. Extracting them is a **parser change** — no LLM call, no
extra network request, no extra token.

| Field | Source | Marginal cost | Honest caveat |
|---|---|---|---|
| `transcript_tags`, `episodes_with_timed_transcript`, `transcript_types` | `<podcast:transcript>` in the fetched feed | **zero** | Sampled over the ≤8 items already fetched, not the whole back catalogue — a floor, not a count. Say so in the schema note |
| `enclosure_host`, `dai_suspected` | `<enclosure url>` host | **zero** | Host inference **over-reports**. A screen for ordering probe effort, never a verdict |
| `language` | `<language>` | **zero** | Publisher-declared; some feeds lie or omit |
| `newest_episode_at`, `feed_dead` | newest `<pubDate>` / terminal `failed_fetch` | **zero** | — |

These are the same fields `data/transcript-availability.json` already carries for
213 shows (1.1% of the catalogue, and its `source_catalog` is
`data/catalog.json`) — so the schema is proven and the consumer pattern exists.
We would be extending a 1% sample to 100% for free.

**In the agent's job (judgment, a handful of output tokens).**

`format`, `depth`, `evergreen` from `taxonomy.json`'s existing
`episode_attributes` — no new vocabulary — plus one new boolean.

- `format` gives us `hang` as the negative signal for chat shows.
- **`expertise_sourced` (boolean) is the one genuinely new field I recommend**,
  because `format` alone does not capture what the rejections turned on.
  Gurmelik Denemeleri is `format: "hang"`, but Unlock Local and 肉の丸一 are
  `interview` — a respectable format — and were rejected because the *guests*
  were an aspiring chef, family members, and the company's own beef buyer. The
  question is "is someone with sourced expertise explaining something", and it
  needs its own field.

This is the argument ADR-0006 already made and won for `display_title`/`blurb`:
*"the marginal cost is a handful of output tokens on a call that is already
reading the show's description and recent episodes."* It applies with more force
here, because these fields decide whether we spend 32 days of CPU on a show.

**Not in the fleet — a separate, later, narrower sweep.**

The ad probe. Three reasons, in order of weight:

1. **Sequencing.** A per-episode ad delta only matters for episodes we have
   decided to author — a few hundred, not 19,787. ADR-0004 gates exactly this:
   Tier 2 runs "never in bulk", enforced by **a shortlist token minted by the
   curation engine** ("can't be invoked in bulk by accident"), not by the budget
   guard. That gate is about transcription cost rather than a keyless ranged GET,
   but the sequencing principle is the same.
2. **It cannot be an LLM routine.** It is one ranged GET per episode, ~1.2 s,
   with a committed tool (`tools/transcribe/ad-inflation.mjs`) that already does
   it. That is a GitHub Action.
3. **Doing it right is not cheap at catalogue scale.** N ≥ 2 per episode, 2
   episodes per show: 19,787 × 2 × 2 = **~79,000 probes**, at ~1.2 s each ≈
   **26 hours serial** — and on every `length="0"` feed it degrades to two *full
   downloads* per episode, which is not a sweep at all.

**Recommended sweep, when it is wanted:** run it over shows that have already
passed the transcript and content gates in the fleet's own output — a worklist
the fleet will have produced for free — and record `delta_max`, the observed
spread, and N per ADR-0008 Decision 2. Never a per-show median. Never a boolean.

### One thing to add that the brief did not ask for

**The fleet should record its own failures terminally.** A `feed_dead: true`
state pre-empts the retry inversion in §2 before four weeks of running turns it
from latent into expensive, and it is a usability fact worth having.

---

## 4. The four-week cadence

### First, correct ADR-0006's arithmetic

ADR-0006 §"Usage/pacing model" states
`shows_covered = batch_size × runs_per_day × days`, then concludes: *"a batch
size of 40 shows/run at 2–3 runs/day covers the full US catalog in roughly 12–18
days."*

Its own formula refutes it:

| | shows in 14 days | % of 19,787 |
|---|---|---|
| 40 × 2 × 14 | 1,120 | 5.7% |
| 40 × 3 × 14 | 1,680 | 8.5% |

Covering 19,787 in 14 days needs **1,413 shows/day = 35.3 runs/day** at 40 per
run. So 40 shows/run at 2–3 runs/day covers the catalogue in **165–247 days, not
12–18**. Stated precisely, because the two ratios are different quantities: **the
required run rate is 11.8×–17.7× the 2–3 runs/day the ADR assumed** (35.3 ÷ 3 and
35.3 ÷ 2 — note this is not a comparison against the 18 runs/day actually
registered, which is ~2.0× short), **and the day estimate is off by ~14×**
(165/12 = 13.8, 247/18 = 13.7).

Per this review's brief, that correction is recorded **here as a note, not by
editing the ADR** (`docs/adr/` is deny-listed). The error was consequential: it
is why the fleet was registered at a cadence that could never finish, and why
"roughly two weeks" was written into the runner prompt as the pacing target.

### What actually delivers 640/day

Target: **17,875 eligible shows ÷ 28 days = 638 shows/day.**

Measured inputs:

- **Merged yield per batch: 50.0** (1,851 ÷ 37 `batch_id`s; range 33–56).
- **A batch well above 40 is proven.** On 2026-07-25 fourteen batches merged
  **40, 37, 34, 33, 53, 56, 56, 55, 55, 55, 55, 54, 50, 55** — 688 shows in one
  day, mean 49.1, with ten of the fourteen at 50 or above. That is the evidence
  that a ~55-show batch completes; it is *not* evidence that 56 is routine.
- **Production rate: 129 shows/day** in the 07-26 → 08-03 steady window.
- **Per-run wall clock is NOT measured.** Consecutive batch timestamps bound
  *spacing*, not duration: the 07-25 gaps run 9, 26, 21, 66, 53, 60, 60, 60, 62,
  63, 60, 55, 120 min, which after the first four look like an **hourly
  trigger**, not a run length. So the stagger below is sized on the observed
  ~60 min spacing, not on a duration anybody has measured.

The registered cadence is already **6 shards × 3 runs/day = 18 runs/day**. With
`--shard` wired and a **balanced** shard key:

```
18 runs/day × 50 shows/run          = 900 shows/day nominal
× 0.86 (measured production efficiency) = 774 shows/day
17,875 ÷ 774                        = 23.1 days
```

### The shard key must be changed, and this is a correction to PR #199

**`Number(id) % 6` is badly unbalanced, because Apple collection ids are not
uniform mod 6.** Measured over the 17,875 eligible shows:

| shard | `id % 6` (current) | `fnv1a(id) % 6` |
|---|---|---|
| 0 | **1,504** (8.4%) | 2,943 |
| 1 | 3,207 | 3,081 |
| 2 | 3,271 | 2,992 |
| 3 | **3,322** | 2,927 |
| 4 | 3,263 | 2,993 |
| 5 | 3,308 | 2,939 |
| max/min | **2.21×** | **1.05×** |

With a fixed shard assignment, **finish time is the largest shard, not the
aggregate.** At 50 × 3 × 0.86 = 129 shows/shard/day:

- **`id % 6`: 3,322 ÷ 129 = 25.8 days**, and **shard0 runs dry at ~day 12** and
  then emits `CLASSIFY_BATCH_EMPTY` for the rest of the blitz — a sixth of the
  fleet idle for over half the run.
- **`fnv1a(id) % 6`: 3,081 ÷ 129 = 23.9 days**, no idle shard.

Both land inside four weeks, so this does not break the plan — but it cuts the
slack from ~15% to ~8% and wastes a shard, so **the engineering PR should replace
the shard key with a hash.** FNV-1a of the id string is the recommendation
because it is balanced *and* stable per-show; `Math.floor(id / 6) % 6` measures
equally well (1.05×) if a one-liner is preferred. **Do not use index-in-list
modulo** — the eligible list shrinks as work completes, so a show's shard would
move between runs, which reintroduces both overlap and gaps.

### Checked against real constraints, not hopes

| Constraint | Verdict |
|---|---|
| **Max-plan weekly usage** | **Not increased.** 18 classify runs/day is what `runners.md` already registers, and it records Wyatt's standing decision to leave the cadence as-is. This plan spends the same tokens on ~6× the shows. |
| **GitHub Actions minutes** | **Not a constraint.** `foray` is a public repo (free minutes) and CI completes in ~50–60 s. 18 PRs/day ≈ 18 min/day. |
| **PR merge throughput** | **The binding constraint.** `merge-results.mjs` rewrites `built_at`/`provenance` every run, so any two *concurrent* classify PRs conflict by construction. Solved by staggering, not by code. |
| **Auto-merge** | Works now (path-based since 2026-08-11), ~60–90 s from push to merged. |
| **File collisions** | Only `data/breadth-classification.json` + `data/classify-progress.json`. Disjoint from the nightly refresh (`data/session.json`, `data/discover.json`), so classify and nightly PRs never conflict with each other. |

### Recommended configuration

**Do not change any routine's cadence. Stagger the six, shard them, and raise the
batch size.** Each routine still runs 3×/day, 8h apart. Four of the six get a new
**hour** offset (not merely a new minute) so that no two classify runs overlap:

| Routine | Cron (UTC) | Runs at | Change vs today |
|---|---|---|---|
| `foray-classify-shard0` | `10 0,8,16 * * *` | 00:10, 08:10, 16:10 | minute only† |
| `foray-classify-shard1` | `50 0,8,16 * * *` | 00:50, 08:50, 16:50 | minute only† |
| `foray-classify-shard2` | `10 2,10,18 * * *` | 02:10, 10:10, 18:10 | **hour + minute** |
| `foray-classify-shard3` | `50 2,10,18 * * *` | 02:50, 10:50, 18:50 | **hour + minute** |
| `foray-classify-shard4` | `10 4,12,20 * * *` | 04:10, 12:10, 20:10 | **hour + minute** |
| `foray-classify-shard5` | `50 4,12,20 * * *` | 04:50, 12:50, 20:50 | **hour + minute** |

† `runners.md` records only "Every 8h" with no offsets, so shard0/1's current
minute is unknown; "minute only" assumes the repo's `:00`-offset convention.

Each routine keeps an exact 8h period; only the phase changes. Minutes are
offset off `:00` per `runners.md`'s convention. Minimum separation between any
two classify runs is **40 min**. 12:10 and 12:50 fall 30 and 70 min after
`foray-nightly-enrich` (11:40) — acceptable, since the two touch disjoint files,
but if the nightly runs long, move shard4/5 to `10 5,13,21` / `50 5,13,21`.

Every argument, per shard: `--shard <i>/6 --batch-size 60 --mode fresh
--progress data/classify-progress.json`.

**`--batch-size 60`, expecting ~50 merged.** The break-even for 28 days is **~43
merged per batch** on the largest balanced shard (3,081 ÷ 28 ÷ 3 ÷ 0.86 = 42.6;
41.2 on the aggregate), so 50 carries ~16% headroom. Dropping the request to 45
— which at the observed request→merge ratio yields ~40 merged — puts the largest
balanced shard at 3,081 ÷ (40 × 3 × 0.86) = **~30 days, outside four weeks**. So
batch size is the first thing to trade away, and there is less room than it
looks.

**The committed prompt still says `--batch-size 40`, and nothing in this plan
changes that.** `classify-batch.md` step 1 is a literal 40, and the prompt calls
itself the operational contract and tells the agent to re-read it every run. An
agent that follows it runs 40 regardless of what the routine passes. **The prompt
edit is mandatory, not optional** — without it the 638/day target is unreachable.

**Escalation runs stay single.** `--mode escalate` has **no shard support at all**
and no ordering — it iterates `Object.entries(classification.entries)`. Six
concurrent escalate runs are guaranteed to select identical shows. Run escalation
as one routine, or by hand after the fresh pass drains. The pile is 301 today and
grows at ~16% of throughput — **~2,900 more over four weeks, ~3,200 in total.**

### Failure modes at this rate — stated plainly

1. **A run overruns its slot** → two classify PRs open → the second
   hard-conflicts on `built_at`. Its tokens are lost; its shows are not (they
   stay eligible, because progress commits only on merge). Self-correcting, one
   wasted run. **This is the mode to watch**, and since per-run duration has
   never been measured (see above), the 40-minute slot is an assumption. The
   permanent fix is to stop rewriting `built_at`/`provenance` per batch.
2. **A malformed `--shard` fails open, silently.** `6/6`, `abc`, `0/0` or a
   missing value all leave `shardCount = 0` and the run processes the **full
   unsharded catalogue with no warning** — silently recreating today's collision.
   One typo in one routine's config. It should throw; today it does not.
3. **Review burden is the real cost, and scheduling cannot fix it.** 18
   auto-merging PRs/day, ~774 shows/day, **no review window** by design. Over
   four weeks: ~500 runs, **~360 landed PRs**, ~17,900 shows nobody reads. ~2,900
   arrive `needs_review`, and ADR-0006 says outright that the review *process* is
   **undesigned** — "This ADR still does not define what that human pass does."
   Four weeks converts an undesigned process into a ~3,200-item backlog.
4. **~1,360 shows will land with `display_title`/`blurb` withheld** (7.6%
   observed) — correct behaviour, but one show in thirteen missing the tile copy
   those fields exist to supply.
5. **Yield may decay as the fleet descends** into older feeds. Merged batches
   fell 56 → 44 across the ten dates the fleet produced work. **The cause is not
   established** — the dead-feed treadmill described in §2 is *not* it, since all
   7 failures sit at `attempts: 1`. Watch it; do not assume the 24-day estimate
   is robust to it.
6. **A stray unlisted file un-arms a PR.** PR #60 committed
   `backend/package-lock.json` and two root scripts. At 18 PRs/day a systematic
   version becomes a daily interruption.
7. **Cost is flat, not zero.** These 18 runs/day were already "the majority of
   all agent spend across Foray and Swift2 combined" (`runners.md`, 2026-07-25).
   This plan does not add to it, but it does mean four straight weeks at that
   level.

### Is four weeks achievable? Yes — but not by a cadence change

**Reachable in ~24 days with a balanced shard key, ~26 with the current one**,
and the cron periods do not change at all. What has to change:

- the **routines being alive** — owner only, `HUMAN-ACTIONS.md` #4 (PR #198);
- the **routine arguments** (six `--shard i/6`, `--batch-size 60`) and four
  hour-phase offsets — owner only, `HUMAN-ACTIONS.md` #5;
- the **prompt, schema and shard key** — a normal engineering PR (§6).

Without the shard flag the ceiling is today's **129 shows/day → 139 days.** That
is the honest fallback, and it is why #5 is BLOCKING.

**A note on the one thing I could not do anything about.** All six routines share
one prompt file with one literal command, so the shard cannot come from the repo
as things stand. The cheapest robust fix is six thin prompt files
(`classify-batch-shard0.md` … `shard5.md`), each stating its own shard, so the
owner changes a *path* per routine rather than an *argument* — safer, and it
removes the fail-open in mode 2. I deliberately did **not** create them here:
they should land with the schema change and the prompt's batch-size fix, or they
point at a contract that does not exist.

---

## 5. What to add to the classification schema, and why

All additive, matching ADR-0006's "Backward-compatible schema" consequence — no
consumer of `topics`/`confidence` changes.

**Written by `prepare-batch.mjs` (deterministic, zero marginal cost — the feed is
already fetched):** `transcript_tags`, `episodes_with_timed_transcript`,
`transcript_types`; `enclosure_host`, `dai_suspected`; `language`;
`newest_episode_at`, `feed_dead`. Reasons and caveats in §3's table.

**Written by the agent (judgment, a handful of output tokens):** `format`,
`depth`, `evergreen` (existing `taxonomy.json` enums), plus `expertise_sourced`
and a one-line `content_shape_note`.

**Explicitly not added:** any per-show ad ratio or ad-free boolean. ADR-0008
Decision 2 requires a per-episode delta in seconds over N ≥ 2 probes of the
*same* episode, taking the maximum; a per-show median across different episodes
is "wrong twice over".

**Sequencing is a genuine decision, and it is close.** Schema first costs one
engineering PR and a day's delay. Blitz first means a **second** four-week pass
to collect signal that was on the wire the first time and discarded, plus a
deliberate progress reset (`prepare-batch` skips any show already sourced
`classify-agent-`). **Recommendation: schema first** — the difference between
four weeks and eight. Filed as `HUMAN-ACTIONS.md` #6. Note this is partly a
technical call (it ships a schema change ahead of a run), so Wyatt owns the cost
side even though the ordering is a product judgement.

---

## 6. Ordered list of what a founder must do

1. **`HUMAN-ACTIONS.md` #4 — revive the six routines** (PR #198's item, not
   re-raised here). *Nothing below delivers a show until this is done.*
2. **`HUMAN-ACTIONS.md` #5 — per-routine `--shard i/6`, `--batch-size 60`, and
   the four hour-phase offsets.** `[BLOCKING]`, ~15 min. The ~6× fix.
3. **`HUMAN-ACTIONS.md` #6 — decide schema-before-or-after.** `[BLOCKING]` as a
   sequencing decision, ~10 min.
4. **`HUMAN-ACTIONS.md` #7 — confirm the list stays the chart-200 catalogue.**
   `[UPGRADE]`, ~5 min.
5. **Then an engineering PR** (no founder needed): the schema fields; **a
   balanced shard key**; **`--batch-size 60` in `classify-batch.md`**; the six
   per-shard prompt files; `--shard` failing loudly instead of open;
   `chart_rank` ordering within bucket; `feed_dead`; **an updated
   `docs/agents/runners.md`** (its own header requires updating it in the same
   change that changes a runner, and it currently records only "Every 8h" with
   no offsets or arguments); and deletion of the two stray root scripts.
6. **Then set the cron** from §4's table.

---

## 7. Two things found on the way that are not about cadence

**`classify-shard-0.mjs` and `classify-shows.mjs` sit committed at the repo
root.** The first is a hard-coded keyword-rules classifier with an absolute path
baked in (`/home/user/foray/data-local/classify-batch-…json`) and a per-show `if`
ladder (`if (title.includes('Marathon Handbook'))`). An agent once wrote a lookup
table to produce a results file **instead of exercising judgment**, and committed
it. It is dead code — the path will not resolve — and being root `.mjs` files
they are **unlisted**, so they un-arm any PR that touches them. Delete both.
(Flagged but not removed in `docs/research/taxonomy-review-2026-08.md`.)

**`loadProgress` silently drops unknown keys.** It returns only `in_flight` and
`failed_fetch`, so any field a future tool adds to
`data/classify-progress.json` is erased on the next prepare run.

---

## 8. How this document got its own correction — and the rule that follows

PR #199 shipped this review with thirteen must-fix defects, including a
recommended shard key that would have idled a sixth of the fleet for half the
blitz. They were all found — by the reviewer pass that was **already running when
the PR was pushed**, and which reported after auto-merge had landed it.

`CLAUDE.md` workflow rule 7 already records this exact failure for PR #147:
*"review before PUSH — not before merge… PR #147 merged before its planned review
could start; that review then found a must-fix chunker bug which cost a
follow-up PR."* This is the second instance, so the operative detail is worth
stating more sharply than the rule does:

**On an auto-merge path, "the reviewer pass is running" is not the same as "the
reviewer pass is done", and only the second one licenses a push.** A reviewer
launched in parallel with the writing is a reviewer whose findings arrive after
the window closes. Launch it, then **wait for it** — or do not open the PR yet.
The `hold` label does not exist in this repo, and the cost of waiting is minutes
against a follow-up PR and a public correction.

---

## Provenance

Measured 2026-08-16 against `origin/main` at `ad833c9` (corrections verified
against `b754f8d`). Primary sources: `data/breadth-classification.json`,
`data/classify-progress.json`, `data/catalog-breadth.json`,
`data/transcript-availability.json`, `data/taxonomy.json`,
`data/segment-sources.json`, `tools/classify/prepare-batch.mjs`,
`tools/classify/merge-results.mjs`, `tools/ci/path-policy.mjs`,
`docs/adr/0004-…`, `0006-…`, `0008-…`,
`docs/curation/grilling-foray-sourcing.md` §5.1–5.2,
`docs/curation/grilling-foray-passages.md` §5–§7,
`docs/curation/catalogue-broadening.md`,
`docs/curation/transcription-scale-plan.md` §4–§5, `git log`, GitHub API.

**One correction to the brief that commissioned this review:** the rank/ad
finding (33% vs 71%, χ² = 8.22) is in **`grilling-foray-sourcing.md` §5.2**, not
`catalogue-broadening.md`. Its raw rows came from an uncommitted throwaway script
and no longer exist, so the table in §1 is the entire surviving record.
