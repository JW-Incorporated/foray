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

**The headline is not the cadence.** Four weeks is achievable at the cadence
already registered — every 8h, six shards, 18 runs/day — with **no increase in
run count and no extra token spend**, because five of every six runs are
currently doing *identical duplicate work*. The cron is not the lever. One
missing command-line flag is.

## The four answers, up front

| Question | Answer |
|---|---|
| **1. Right list?** | Right list to *classify*; do not change it before the blitz. But it is a top-200 chart harvest and can never be more than that — 2.94% of PodcastIndex's 4.71M feeds — and the argument that it "selects against us" has been substantially overtaken by ADR-0008. Fix the **order**, not the list. |
| **2. Classifications sufficient?** | No. All 14 recorded fields are subject and display copy. Nothing records whether a show is *usable*, and `data/taxonomy.json` already defines the vocabulary (`episode_attributes`) that the classifier does not emit. |
| **3. "Cataloguing taste, not usability"?** | **Substantially right, with one correction that matters.** Ads are no longer the binding constraint (ADR-0008, accepted the day before this review) and the transcript sweep runs the *opposite* way to the rank/ad finding. The real ranking is transcripts > content shape > ads. |
| **4. Four-week cadence?** | Achievable, ~20–24 days, at the **existing** cadence. Blocked on a per-routine argument only the account owner can set (`HUMAN-ACTIONS.md` #5). |

---

## 0. What the fleet is actually doing right now — measured

Everything in this section is from `data/breadth-classification.json`,
`data/classify-progress.json`, `git log` and the GitHub API on 2026-08-16.

| | |
|---|---|
| Breadth catalogue | **19,787** US shows |
| Have a real agent classification (`source: classify-agent-tier1`) | **1,851** (9.4%) |
| Still on distrusted signal | **17,936** — 12,563 `genre-map`, 5,373 `llm-title-genre` |
| Eligible for a fresh batch (has `feed_url`) | 17,908 |
| Batches ever merged | **37**, mean **50.0** shows per batch |
| Active window | 2026-07-25 → **2026-08-03**, then nothing |
| Steady-state throughput (07-26 → 08-03) | **129 shows/day** |
| Configured run rate | 6 shards × every 8h = **18 runs/day** |
| Batches actually landing per day | **~2.6** |
| `needs_review` pile | 301 (16.3% of classified) |
| `display_copy_ok: false` | 141 (7.6%) |

### The fleet is dark, and that is already filed

The last classify batch to land is `fresh-2026-08-03-03cc71da` (PR #86). At the
registered cadence the 13 days since should have produced ~230 runs and ~11,000
classifications. They produced none. **This is `HUMAN-ACTIONS.md` #4**, filed by
the open PR #198 — this review does not re-raise it, and everything below
assumes it gets resolved first. Nothing in this document delivers a single show
until the routines are alive again.

### The finding this review adds: 5 of every 6 runs are duplicate work

`tools/classify/prepare-batch.mjs` **supports sharding**:

```js
shard: get("--shard", null) // "i/N" for parallel sharded runs
...
if (shardCount && Number(id) % shardCount !== shardIndex) continue;
```

The six routines **do not use it.** All six run one shared prompt file
(`runner-prompts/classify-batch.md`) containing one literal command:

```sh
node tools/classify/prepare-batch.mjs --batch-size 40 --mode fresh \
  --progress data/classify-progress.json
```

No `--shard`. The shard number exists only in the *routine name*. So
`shardCount` stays `0`, the guard short-circuits, and every shard iterates the
full catalogue. Selection is fully deterministic — priority bucket, then
ascending `apple_collection_id`, no randomness, no timestamp — so **all six
shards select the identical 40 shows in the identical order.** Verified: two
independent simulations produced byte-identical id lists, and shards `0/6` and
`1/6` (when the flag *is* passed) have zero overlap.

The `in_flight` reservation in `data/classify-progress.json` cannot save it. It
is a git-committed file, so shard0's reservations are invisible to shard1 until
shard0's PR merges; `main`'s copy has exactly one commit ever (2026-07-29, PR
#60 — PR #86 did not commit it at all); and every entry in it is past the 12h
`STALE_IN_FLIGHT_MS` window and is deleted on read. There is no lockfile and no
atomic write anywhere in the pipeline.

The arithmetic corroborates it exactly: **18 runs/day producing ~2.6 landed
batches/day is 1/6.** Five shards' worth of Max-plan reasoning is spent every
cycle and discarded.

**Wiring the flag is a 6× throughput increase at zero additional spend.** That
is the whole cadence answer, and it is why the cron is not the lever.

### Two more mechanical facts that shape the plan

**The merge header guarantees a conflict.** `merge-results.mjs` rewrites
`built_at` and the whole `provenance` block on every run:

```js
classification.built_at = now;
classification.provenance = { ..., last_batch_id: batch.batch_id, ... };
```

Those land on lines 3 and 7–8 of a 184,042-line pretty-printed file. **Any two
concurrent classify PRs modify the same two lines with different values → hard
conflict, even when their entry sets are disjoint.** So sharding fixes duplicate
*work* but not the *merge*: six simultaneous shard PRs would still land one and
conflict five. The cadence below therefore staggers the shards rather than
running them together — which needs no code change at all.

**Auto-merge is no longer the problem.** It was: PR #86 sat open 8 days because
`automerge-nightly.yml` gated on `startsWith(head_ref, 'nightly/')`. Since
2026-08-11 the policy is path-based (`tools/ci/path-policy.mjs`), `data/` is
allowlisted, and a PR touching only `data/breadth-classification.json` +
`data/classify-progress.json` **arms and lands on green** (~60 s of CI). One
trap survives: PR #60 also committed `backend/package-lock.json` and two stray
root scripts, which are *unlisted* and fail safe to a human. Any stray file at
repo root un-arms the PR.

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

The curated path is separate and untouched by the fleet: `data/catalog.json` +
`data/discover.json`, ~150 shows with hand-picked episodes, hooks and tags.
`prepare-batch.mjs`/`merge-results.mjs` have **no write path** to it at all, so
"curated always wins" holds by construction. `tools/classify-breadth.mjs` is the
old deterministic genre-map pass — the source of the 12,563 `genre-map` entries
the fleet exists to replace.

### The measured bias, and why it no longer says what it said

`docs/curation/grilling-foray-sourcing.md` §5.1–5.2 is the primary source.
`CHART_LIMIT = 200`, maximum `chart_rank` present in either catalogue file is
**200**, US Food holds 199 of a possible 200. The catalogue is, by construction,
"the top 200 of each of 110 genre charts in 19 storefronts, and nothing else can
ever be in it." Against PodcastIndex's 4.71M feeds we hold **2.94%**, and of
7,237 food/history feeds that dump nominated, **88.6% were not in our
138,470-feed catalogue**. Six of the sources Foray #1 actually uses are not in
it either.

Then §5.2, the finding the brief cites — and it is real, well-measured, and
**misattributed** (it is not in `catalogue-broadening.md`):

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
rank is within genre chart… enough to act on and not enough to publish."* The
raw rows were produced by an uncommitted throwaway script and **no longer
exist** — that table is the entire surviving record.

**Two things have happened since that make this a much weaker argument for
changing the list, and both must be said plainly.**

**(a) ADR-0008 removed ads as a gate — the day before this review.** "Ad load is
not a rejection reason at sourcing. The content gate ("someone has to be
*explaining* something") and transcript availability remain the only grounds for
rejecting a source." §5.2's conclusion — "the higher
a show ranks, the less likely we can build a Foray from it" — was a statement
about a **binary gate that no longer exists**. Ads are now a per-episode
padding/locate parameter, not an admission test.

**(b) On the axis that still costs money, the correlation runs the other way.**
`data/transcript-availability.json` swept 213 shows:

| | shows | episodes | with transcript | coverage |
|---|---|---|---|---|
| DAI-suspected | 144 | 59,768 | 7,966 | **13.3%** |
| non-DAI | 68 | 22,275 | 46 | **0.2%** |

A **66× difference, favouring the ad-injecting shows.** ADR-0008 draws the
conclusion explicitly: "because monetised shows are also the ones that pay for
transcription, they are disproportionately the ones shipping free timed
transcripts. Stuff You Should Know alone ships **2,850** and Odd Lots **1,251**;
together they are half of our entire free-transcript inventory, and both were
excluded."

So the top of the chart is ad-heavy *and* transcript-rich. Under the old gate
that was a straight loss. Under ADR-0008 it is a trade — and transcripts are the
side that costs 1.33× realtime of CPU on the only machine we have (32 days per
1,000 episodes, `transcription-scale-plan.md` §5).

### Verdict

**Do not change the list before spending four weeks on it.** Three reasons:

1. **Classifying is not the expensive part.** The list already exists and the
   per-show cost is one RSS fetch plus a paragraph of reasoning. The expensive
   parts downstream — transcription, the locate step — are gated on *which*
   shows, which is exactly what a classification pass tells you.
2. **The one measured argument for changing it has been superseded as a gate and
   contradicted on the axis that still bills.** Re-pointing the harvest at ranks
   26–200 would optimise for a constraint the CTO removed on 2026-08-16 while
   giving up the half of the free-transcript inventory that ADR-0008 just
   unlocked.
3. **Changing it is a different workstream with its own measured verdict.** The
   PodcastIndex dump is a **research tool, not an ingest path** — 1.8 GB down,
   6.84 GB peak, no episode table, every query a full table scan
   (`catalogue-broadening.md` §2). Broadening the harvest also resets the
   denominator mid-blitz, so "have we finished?" stops having an answer.

**But change two things about the list's *use*, neither of which needs a
re-harvest.**

**(a) The order is currently meaningless, and that is a real defect.** Selection
sorts into three priority buckets (`llm-title-genre` → `genre-map` → unseen) and
within a bucket falls back to input order, which `harvest-catalog.mjs` built as
**ascending `apple_collection_id`** — i.e. *show registration age*. `chart_rank`
is passed into the batch as context and **never used for ordering**. The
observed rank sequence of the next 40 is noise: `67, 36, 75, 7, 12, 4, 19, 6,
78, 86, 18, 184, …`. The entire 5,373-show `llm-title-genre` bucket must drain
before any `genre-map` show is touched. A rank-1 show can sit behind thousands
of obscure older ones for no reason anybody chose.

This matters less if we finish everything in four weeks — which is the plan — so
it is a **should**, not a **must**: order within bucket by `chart_rank`
ascending, so that if the blitz stalls halfway, the half that got done is the
half a listener might encounter. One comparator in `prepare-batch.mjs`.

**(b) Write the ceiling down where consumers of the file will see it.**
`docs/CATALOG-PIPELINE.md` describes the harvest correctly but nothing warns a
reader that 19,787 is a chart artefact rather than a catalogue. Rank 200 is a
wall; 2.94% is the coverage; a show absent from `catalog-breadth.json` has not
been assessed and rejected, it has never been seen.

---

## 2. Are the classifications sufficient?

### What a classified show records — all 14 fields

From `merge-results.mjs`: `topics`, `confidence` (bucket string), 
`topic_confidences`, `needs_review`, `rationale`, `display_title`, `blurb`,
`display_copy_ok`, `display_copy_notes`, `model`, `source`, `tier`, `batch_id`,
`classified_at`.

Every one of them is **subject or display copy.** There is no field about the
show as a thing we could build from.

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
taxonomy.** `format: "hang"` is precisely the category that every content-gate
rejection has fallen into. The classifier reads the description and five to ten
recent episodes — exactly the signal needed to fill these three — and emits none
of them.

Three further gaps, all in bytes the pipeline already has on the wire:

- **Language.** Nothing records it, anywhere, despite four of six newly-sourced
  traditions being non-English and the English-only question being a standing
  founder decision (`catalogue-broadening.md` §3). RSS carries `<language>`.
- **Liveness.** `catalog-breadth.json` has `episode_count` and `harvested_at`
  but no newest-episode date. A dead show is unusable and indistinguishable from
  a live one in the current record. The fetched feed's newest `<pubDate>`
  answers it for free.
- **A terminal dead-feed state.** `failed_fetch` retries three times with a 6h
  cooldown, and then the logic *inverts*: at `attempts >= maxFetchAttempts` the
  show becomes permanently and immediately eligible **every run**, forever, and
  is included with Tier-0-only signal. As the fleet descends into older feeds
  this is a growing tax on every batch — and merged batch sizes did decay
  56 → 44 across the eight days the fleet ran.

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
weakest of them, and building the ad probe into the fleet would be building a
gate the CTO removed on 2026-08-16.**

### Where the claim is right, measured

`grilling-foray-passages.md` §6 is the cleanest possible test, because it is the
list of episodes we actually want, after every gate:

- **Nine rows in the ASR queue. Every one measured 1.0000 — ad-free.** Ads
  blocked **zero of nine**.
- **All nine are blocked on transcript availability.** Transcripts blocked
  **nine of nine**.
- **Content shape rejected 6h 02m of audio** (The Grill Coach's six "BBQ World
  Tour" episodes, §7) — *more audio than the entire funded queue*, which is
  2h 27m for ASR-1 through ASR-4.

And the content failures are exactly the ones no subject tag can see: a passage
rejected because the hosts perform a sniff test and cite "video evidence on
Nobby's Instagram"; a cut point that cannot be crossed because the hosts tell
listeners to open Google Maps; Gurmelik Denemeleri, measured **1.0000** and
rejected as "hosts riffing with no sourced expertise"; 肉の丸一 rejected as
supplier interviews; Unlock Local rejected because its guests are "an aspiring
chef and family members, not scholars"; Dis a Fi Mi rejected as a supper-club
business interview. Every one of these would classify cleanly as `food` or
`food/food-history` and every one is unusable.

So yes: the fleet's output cannot distinguish a show we can build from a show we
cannot, and the gap is not marginal — it is the majority of the rejections on
record.

### Where the claim needs correcting — and this is the part to push back on

**Ads are no longer a constraint, and treating them as one would be a
regression.** ADR-0008 §Decision 1: *"Ad load is not a rejection reason at
sourcing. The content gate and transcript availability remain the only grounds
for rejecting a source."* The brief's own framing — "if a show injects ads, our
timestamps do not point at the listener's audio, so no Foray can be built from
it" — is the pre-ADR-0008 position. It is now: author anyway, anchors are
durable, pad if `pad ≤ 120 s`, otherwise wait for the locate step.

Worse, **the way a fleet would naturally measure ads is invalid by ADR-0008's
own rules**, twice over:

1. **N ≥ 2 probes of the *same* episode is mandatory, not advisory.** Two probes
   of one Gastropod episode disagreed by **33.4 s**. "N = 1 bounds nothing."
   **No episode in this repo has ever been probed twice** except that one.
2. **`summariseShow()` is "wrong twice over"** — ADR-0008's words: it takes a
   *median* (wrong statistic) across *different episodes* (wrong axis). A
   per-show ad number is not a thing that means anything. And on `length="0"`
   feeds (Megaphone) a ratio is uncomputable at all, so the only instrument is a
   full decode — a download per probe.

A per-show ad flag added to 19,787 classification records would therefore be a
field that is cheap, confident, and wrong — the exact failure mode ADR-0006
exists to correct. We already have one of those: `data/dai-classification.json`,
213 shows of host-based inference, which ADR-0008 and
`transcription-scale-plan.md` both say **over-reports** (Being an Engineer is
flagged DAI and delivers byte-identical bytes).

### The honest ranking, by what it costs us

| Rank | Constraint | Why it binds | Cost if we get it wrong |
|---|---|---|---|
| **1** | **Transcript availability** | Blocked 9 of 9 ASR-queue rows. A `<podcast:transcript>` tag makes an episode nearly free; without one it is **1.33× realtime measured** — 32 days per 1,000 episodes on the only machine we have, or $30–400 of founder-approved spend | The whole pipeline stalls; this is the funding decision |
| **2** | **Content shape** | Rejected 6h 02m — more than the funded queue. The only gate ADR-0008 left standing alongside transcripts. No subject tag can see it | Wasted transcription budget on audio nobody can use |
| **3** | **Ad load** | Not a gate. A per-episode playback *parameter* (`delta_max`, spread, N) for shows we have already decided to author | A padded segment or a skipped one — never a bad cut, because `seekPrecision()` already fails honest |

### So: which belongs in the fleet's job?

**In the fleet's deterministic step (`prepare-batch.mjs`), at zero marginal
cost — this is the single highest-value change in the review.**

The fleet **already fetches the complete RSS feed for every show it classifies**
(Tier 0.5) and throws almost all of it away. `<podcast:transcript>` tags, the
`<enclosure>` host, `<language>`, and the newest `<pubDate>` are all in bytes
already on the wire. Extracting them is a **parser change** — no LLM call, no
extra network request, no extra token. It converts a one-use signal into a
permanent usability record for 19,787 shows.

| Field | Source | Marginal cost | Honest caveat |
|---|---|---|---|
| `transcript_tags`, `episodes_with_timed_transcript`, `transcript_types` | `<podcast:transcript>` in the fetched feed | **zero** | Sampled over the 5–10 items already fetched, not the whole back catalogue — a floor, not a count. Say so in the field name or the schema note |
| `enclosure_host`, `dai_suspected` | `<enclosure url>` host | **zero** | Host inference **over-reports**. It is a screen for ordering probe effort, never a verdict |
| `language` | `<language>` | **zero** | Publisher-declared; some feeds lie or omit |
| `newest_episode_at`, `feed_dead` | newest `<pubDate>` / terminal `failed_fetch` | **zero** | — |

These four rows are the same fields `data/transcript-availability.json` already
carries for 213 shows (1.1% of the catalogue) — so the schema is proven and the
consumer pattern exists. We would be extending a 1% sample to 100% for free.

**In the agent's job (judgment, a handful of output tokens).**

`format`, `depth`, `evergreen` from `taxonomy.json`'s existing
`episode_attributes` — no new vocabulary — plus one new boolean.

- `format` gives us `hang` as the negative signal for chat shows.
- **`expertise_sourced` (boolean) is the one genuinely new field I recommend**,
  because `format` alone does not capture what the rejections actually turned
  on. Gurmelik Denemeleri is `format: "hang"`, but Unlock Local and 肉の丸一 are
  `interview` — a perfectly respectable format — and were rejected because the
  *guests* were an aspiring chef, family members, and the company's own beef
  buyer. The question is "is someone with sourced expertise explaining
  something", and it needs its own field.

This is exactly the argument ADR-0006 already made and won for
`display_title`/`blurb`: *"the marginal cost is a handful of output tokens on a
call that is already reading the show's description and recent episodes."* The
same argument applies with more force here, because these fields decide whether
we spend 32 days of CPU on a show.

**Not in the fleet — a separate, later, narrower sweep.**

The ad probe. Three reasons, in order of weight:

1. **Sequencing.** A per-episode ad delta only matters for episodes we have
   decided to author. That is a few hundred, not 19,787. Probing all of them is
   precisely the "bulk invocation" ADR-0004 calls the corner case the budget
   guard exists to prevent.
2. **It cannot be an LLM routine.** It is one ranged GET per episode, ~1.2 s,
   with a committed tool (`tools/transcribe/ad-inflation.mjs`) that already does
   it. That is a GitHub Action.
3. **Doing it right is not cheap at catalogue scale.** N ≥ 2 per episode, 2
   episodes per show: 19,787 × 2 × 2 = **~79,000 probes**, at ~1.2 s each ≈
   **26 hours serial** — and on every `length="0"` feed it degrades to two *full
   downloads* per episode, which is not a sweep at all.

**Recommended sweep, when it is wanted:** run it over shows that have already
passed the transcript and content gates in the fleet's own output — an ordered
worklist the fleet will have produced for free — and record `delta_max`, the
observed spread, and N per ADR-0008 Decision 2. Never a per-show median. Never a
boolean.

### One thing to add that the brief did not ask for

**The fleet should record its own failures terminally.** Seven shows sit in
`failed_fetch` with `HTTP 503`/`HTTP 403`, and after three attempts they become
permanently eligible every run forever. A `feed_dead: true` terminal state ends
the treadmill and is also a usability fact worth having.

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
12–18** — the estimate is **off by 11.8× to 17.7×** (mid ≈ 14×). Per this
review's brief, that correction is recorded **here as a note, not by editing the
ADR** (`docs/adr/` is deny-listed to auto-merge and to agents).

The error was consequential: it is why the fleet was registered at a cadence
that could never finish, and why "roughly two weeks" was written into the runner
prompt as the pacing target.

### What actually delivers 640/day

Target: **17,936 shows ÷ 28 days = 640.6 shows/day.**

Measured inputs — all from the 37 landed batches, no extrapolation:

- **Merged yield per landed batch: 50.0** (1,851 ÷ 37; range 33–56).
- **A batch of ~56 is proven.** On 2026-07-25 the orchestrator ran **14 batches
  in ~12 hours** at 53–56 each — **688 shows in one day.** The 640/day target
  has already been exceeded once, by hand.
- **Per-run wall clock: ~10–25 minutes** (batch timestamps 9–26 min apart during
  that burst). The RSS fetch floor is `batch_size × 1.5 s` serial
  (`THROTTLE_MS`), so ~1.5 min at 60; the agent's reasoning is the rest.
- **Steady-state efficiency: 86%** (129 shows/day delivered against 150 nominal)
  — feed failures and short batches, and `prepare-batch.mjs` does **not backfill**
  a failed show from the candidate pool.

Now the key move. The registered cadence is already **6 shards × 3 runs/day = 18
runs/day**. With `--shard` wired:

```
18 runs/day × 50 shows/run          = 900 shows/day nominal
× 0.85 (measured efficiency)        = 765 shows/day
17,936 ÷ 765                        = 23.4 days
```

**Four weeks, at the cadence already registered, with 16% slack — and zero
additional runs, so zero additional Max-plan spend.** The 6× comes entirely from
not doing the same 40 shows six times.

### Checked against real constraints, not hopes

| Constraint | Verdict |
|---|---|
| **Max-plan weekly usage** | **Not increased.** 18 classify runs/day is what `runners.md` already registers, and `runners.md` records Wyatt's standing decision to leave the cadence as-is. This plan spends the same tokens on 6× the shows. |
| **GitHub Actions minutes** | **Not a constraint.** `foray` is a public repo (free minutes), and CI completes in ~50–60 s. 18 PRs/day ≈ 18 min/day. |
| **PR merge throughput** | **The binding constraint.** `merge-results.mjs` rewrites `built_at`/`provenance` on lines 3 and 7–8 every run, so any two *concurrent* classify PRs conflict by construction. Solved below by staggering, not by code. |
| **Auto-merge** | Works now (path-based since 2026-08-11). ~60–90 s from push to merged. |
| **Batch collision on files** | Only `data/breadth-classification.json` + `data/classify-progress.json`. Disjoint from the nightly refresh (`data/session.json`, `data/discover.json`), so classify and nightly PRs never conflict with each other. |

### Recommended configuration

**Do not increase the cadence. Stagger it, shard it, and raise the batch size.**

Six shards, still 3 runs/day each, but spaced **40 minutes apart** inside each
8-hour window so that only one classify PR is ever open at a time — which
sidesteps the merge-header conflict without touching `merge-results.mjs`. A run
takes 10–25 min and auto-merge lands in ~90 s, so 40 min is ~1.6× the observed
worst case.

| Routine | Cron (UTC) | Runs at | Command |
|---|---|---|---|
| `foray-classify-shard0` | `10 0,8,16 * * *` | 00:10, 08:10, 16:10 | `--shard 0/6 --batch-size 60 --mode fresh --progress data/classify-progress.json` |
| `foray-classify-shard1` | `50 0,8,16 * * *` | 00:50, 08:50, 16:50 | `--shard 1/6 …` |
| `foray-classify-shard2` | `10 2,10,18 * * *` | 02:10, 10:10, 18:10 | `--shard 2/6 …` |
| `foray-classify-shard3` | `50 2,10,18 * * *` | 02:50, 10:50, 18:50 | `--shard 3/6 …` |
| `foray-classify-shard4` | `10 4,12,20 * * *` | 04:10, 12:10, 20:10 | `--shard 4/6 …` |
| `foray-classify-shard5` | `50 4,12,20 * * *` | 04:50, 12:50, 20:50 | `--shard 5/6 …` |

Minutes are offset off `:00` per `runners.md`'s convention. Minimum separation
between any two classify runs is 40 min. 12:10 and 12:50 fall 30 and 70 min
after `foray-nightly-enrich` (11:40) — acceptable, because the two touch
disjoint files, but if the nightly ever runs long, move shard4/5 to
`10 5,13,21` / `50 5,13,21`.

**`--batch-size 60`, expecting ~50 merged.** 56 was demonstrated 14 times in one
day, at an observed request→merge yield of ~89%, so 60 should merge ~53; the
plan uses 50 to stay conservative. **The break-even batch size for 28 days is
~47**, so 60 carries about 28% headroom. Dropping to 45 (~40 merged) gives
~612/day → **29.3 days, marginally outside four weeks** — so batch size is the
first thing to trade away, but not by much. If runs hit usage or context limits,
cut the batch size to 50 before touching the cron; below ~47 the four-week
target goes.

**Escalation runs stay single.** `--mode escalate` has **no shard support at
all** and no ordering — it iterates `Object.entries(classification.entries)`. Six
concurrent escalate runs are 100% guaranteed to select identical shows. Run
escalation as one routine, or by hand after the fresh pass drains. The pile is
301 today and will grow at ~16% of throughput — **roughly 2,900 more over four
weeks.**

### Failure modes at this rate — stated plainly

1. **A run overruns its 40-minute slot** → two classify PRs open → the second
   hard-conflicts on `built_at`. Its tokens are lost; its shows are *not* lost
   (they stay eligible, because progress commits only on merge). Cost is one
   wasted run, self-correcting. **This is the mode to watch, and the permanent
   fix is to stop rewriting `built_at`/`provenance` per batch** — a
   `tools/classify/` change, allowlisted, out of scope here.
2. **A malformed `--shard` fails open, silently.** `6/6`, `abc`, `0/0` or a
   missing value all leave `shardCount = 0` and the run processes the **full
   unsharded catalogue with no warning** — silently recreating today's
   collision. One typo in one routine's config. It should throw; today it does
   not. Flagged as a must-fix in the engineering PR.
3. **Review burden is the real cost, and it is not solvable by scheduling.** 18
   auto-merging PRs/day, landing ~765 shows/day, with **no review window** by
   design. Over four weeks that is ~500 runs, ~430 landed PRs and ~17,900 shows
   nobody reads. ~2,900
   land as `needs_review`, and ADR-0006 says outright that the review *process*
   is **undesigned**: "This ADR still does not define what that human pass
   does." Four weeks of blitz converts an undesigned process from a hypothetical
   into a 2,900-item backlog.
4. **~1,360 shows will land with `display_title`/`blurb` withheld** (7.6%
   `display_copy_ok: false` observed). Correct behaviour, but it means the tile
   copy the fields exist to supply will be missing for one show in thirteen.
5. **Yield decays as the fleet descends.** Merged batches fell 56 → 44 over
   eight days, and dead feeds at `attempts >= 3` are re-fetched every run
   forever. If that decay continues linearly it is the single biggest threat to
   the 23-day estimate. Mitigation: the `feed_dead` terminal state (§3).
6. **A stray file un-arms a PR.** PR #60 committed `backend/package-lock.json`
   and two root scripts. Anything outside the allowlist fails safe to a human,
   and at 18 PRs/day a systematic version of that mistake becomes a daily
   interruption rather than a one-off.
7. **Cost is not zero even though spend is flat.** These 18 runs/day were
   already "the majority of all agent spend across Foray and Swift2 combined"
   (`runners.md`, 2026-07-25). This plan does not add to it — but it does mean
   four straight weeks at that level with no dip.

### Is four weeks achievable? Yes — but not by a cadence change

**It is achievable, in ~23 days, and the cron does not change at all.** What has
to change is two things an agent cannot do and one it can:

- the **routine arguments** (six per-routine `--shard i/6`) — owner only,
  `HUMAN-ACTIONS.md` #5;
- the **routines being alive** — owner only, `HUMAN-ACTIONS.md` #4 (PR #198);
- the **prompt and schema** — a normal engineering PR, described below.

Without the shard flag, the ceiling is today's measured **129 shows/day → 139
days.** That is the honest fallback, and it is why #5 is tagged BLOCKING.

**A note on the one thing I could not do anything about.** All six routines
share one prompt file with one literal command, so the shard cannot come from the
repo as things stand. The cheapest robust fix is six thin prompt files
(`classify-batch-shard0.md` … `shard5.md`), each stating its own shard, so the
owner changes a *path* per routine rather than an *argument* — safer, and it
removes the fail-open in mode 2 above. I have deliberately **not** created them
in this PR: they should land in the same change as the schema additions, or they
will point at a contract that does not exist yet. `docs/` auto-merges on green
with no review window, so a half-landed contract cannot be walked back.

---

## 5. What to add to the classification schema, and why

All additive, matching ADR-0006's "backward-compatible schema" consequence — no
consumer of `topics`/`confidence` changes.

**Written by `prepare-batch.mjs` (deterministic, zero marginal cost — the feed
is already fetched):**

| Field | Why |
|---|---|
| `transcript_tags` (int), `episodes_with_timed_transcript` (int), `transcript_types` (map) | Rank 1 constraint. Blocked 9 of 9 ASR-queue rows. Decides ~0 vs 1.33× realtime per episode |
| `enclosure_host` (string), `dai_suspected` (bool) | Orders ad-probe effort later. **A screen, never a verdict** — host inference over-reports |
| `language` (string) | Gates four of six newly-sourced traditions; a standing founder decision has nothing to key on |
| `newest_episode_at` (ISO), `feed_dead` (bool) | Liveness; and ends the dead-feed retry treadmill |

**Written by the agent (judgment, a handful of output tokens):**

| Field | Why |
|---|---|
| `format` — `taxonomy.json`'s existing enum | `hang` is the chat-show signal. Vocabulary already exists; do not invent one |
| `depth` — existing enum | Distinguishes explanation from mention |
| `evergreen` — existing boolean | Decides whether a segment has a shelf life |
| `expertise_sourced` (bool) + one-line `content_shape_note` | The only genuinely new field. `format` misses it: the rejections turned on *who is talking*, and two of them were a respectable `interview` |

**Explicitly not added:** any per-show ad ratio or ad-free boolean. ADR-0008
Decision 2 requires a per-episode delta in seconds over N ≥ 2 probes of the
*same* episode and takes the maximum; a per-show median across different
episodes is "wrong twice over". A cheap confident wrong field is the exact
failure ADR-0006 exists to correct.

**Sequencing, and it is a genuine founder call, not a technical one.** Adding
these fields *before* the blitz costs one engineering PR and delays the start by
a day. Adding them *after* means a second four-week pass over 19,787 shows to
collect signal that was on the wire the first time and discarded. `prepare-batch`
skips any show whose source starts with `classify-agent-`, so a re-run also needs
a deliberate progress reset. **Recommendation: schema first.** It is the
difference between four weeks and eight. Filed as `HUMAN-ACTIONS.md` #6.

---

## 6. Ordered list of what a founder must do

The routines can only be changed by the account owner, so every step that
touches them is in `HUMAN-ACTIONS.md`. Item numbers there are stable IDs.

1. **`HUMAN-ACTIONS.md` #4 — revive the six routines** (already filed by PR
   #198; not re-raised here). *Nothing below delivers a single show until this
   is done.*
2. **`HUMAN-ACTIONS.md` #5 — give each routine its own `--shard i/6`.**
   `[BLOCKING]`, ~15 min. This is the 6× throughput fix and the whole
   four-week plan.
3. **`HUMAN-ACTIONS.md` #6 — decide schema-before-or-after.** `[BLOCKING]` as a
   *sequencing* decision, ~10 min. Cheap now, a second four weeks later.
4. **`HUMAN-ACTIONS.md` #7 — confirm the list stays the chart-200 catalogue for
   these four weeks.** `[UPGRADE]`, ~5 min. §1 recommends yes; it is a product
   call because it is a decision about what we are choosing not to see.
5. **Then, an engineering PR** (no founder needed): the schema fields, the six
   shard prompt files, `--shard` failing loudly instead of open, `chart_rank`
   ordering within bucket, `feed_dead`, and the two stray root scripts deleted.
6. **Then set the cron** from §4's table — which, note, is the cadence already
   registered. Only the arguments and the minute offsets change.

---

## 7. Two things found on the way that are not about cadence

**`classify-shard-0.mjs` and `classify-shows.mjs` sit committed at the repo
root.** The first is a hard-coded keyword-rules classifier with an absolute path
baked in (`/home/user/foray/data-local/classify-batch-…json`) and a per-show `if`
ladder (`if (title.includes('Marathon Handbook'))`). An agent once wrote a
lookup table to produce a results file **instead of exercising judgment**, and
committed it. It is dead code — the path will not resolve — but it is a working
template for defeating this entire pipeline, sitting in an auto-merge-allowlisted
path. Delete both. (Flagged but not removed in
`docs/research/taxonomy-review-2026-08.md`.)

**`loadProgress` silently drops unknown keys.** It returns only `in_flight` and
`failed_fetch`, so any field a future tool adds to
`data/classify-progress.json` is erased on the next prepare run. Worth knowing
before anyone stores anything there.

---

## Provenance

Measured 2026-08-16 against `origin/main` at `ad833c9`. Primary sources:
`data/breadth-classification.json`, `data/classify-progress.json`,
`data/transcript-availability.json`, `data/taxonomy.json`,
`tools/classify/prepare-batch.mjs`, `tools/classify/merge-results.mjs`,
`tools/ci/path-policy.mjs`, `docs/adr/0006-…`, `docs/adr/0008-…`,
`docs/curation/grilling-foray-sourcing.md` §5.1–5.2,
`docs/curation/grilling-foray-passages.md` §5–§7,
`docs/curation/catalogue-broadening.md`,
`docs/curation/transcription-scale-plan.md` §4–§5, `git log`, GitHub API.

**One correction to the brief that commissioned this review:** the rank/ad
finding (33% vs 71%, χ² = 8.22) is in **`grilling-foray-sourcing.md` §5.2**, not
`catalogue-broadening.md`. Its raw rows were produced by an uncommitted
throwaway script and no longer exist, so the table in §1 above is the entire
surviving record of that measurement.
