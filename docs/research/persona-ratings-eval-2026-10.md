# Persona-rating prior: offline eval (RV-21), 2026-10-14, re-run on the RV-19 gold set and archetype map v1.1 (RV-31) 2026-10-15

Card RV-21 of [`docs/roadmap/recommender-v1.md`](../roadmap/recommender-v1.md), issue #1380. It answers one question before any client change: does the persona prior agree with the only ground truth on `main`, and how skewed is it, measured against baselines that cost nothing? The inputs are the committed RV-19 gold ratings: 2,978 shows rated by 13 personas, 220 of them curated, as reported in [`persona-ratings-gold-2026-10.md`](persona-ratings-gold-2026-10.md). The first version of this note read the 299-show pilot (#1401, [`persona-ratings-pilot-2026-10.md`](persona-ratings-pilot-2026-10.md)); where the gold numbers change a pilot reading, the text below says so. RV-31 then changed the archetype map (v1.1, below) and added two floors; section 1 keeps the map v1 numbers beside the v1.1 ones. The block between the `GENERATED` markers is written by `node tools/recommender/eval.mjs`. Everything outside it is written by hand.

**Two numbers are now gated (RV-31); the rest is reported.** RV-21 put no floors on these numbers, and the gold-set re-run deferred them until the archetype map was settled ("What follows" item 1). With map v1.1, `test/recommender-eval.test.js` holds two floors on the committed data. The "all mapped" archetype precision must be at least the node-modal baseline's under the same map: the prior must beat the free baseline. The reachable persona recall@6 must be at least 0.30 (0.339 measured, less noise). The suite also checks the scorer's arithmetic and that the block below is current. Any PR that changes `data/recommender/ratings.json` (each RV-19 merge does) must rerun the script.

## What was built

| File | What it is |
|---|---|
| `tools/recommender/eval.mjs` | The eval. Pure scorers (archetype agreement and its baselines, persona-vector neighbours, chart Spearman, top-50 share profiles), a loader that reads only committed files, and a CLI with `--check` and `--json`, following the `tools/similar-eval/run.mjs` pattern. It calls no model and fetches nothing. |
| `test/recommender-eval.test.js` | 9 tests: 6 on hand-worked fixtures and the committed catalogue, the block-is-current check, and the two floors on the committed data (RV-31). Each test names its mutation, and every mutation was run red. |
| this note | The reading below and the generated block. |

**Choices the card left open.**
- `documentary` maps to narrative-binger and true-crime-careful. All 12 documentary shows in `data/catalog.json` are produced true-crime or paranormal story series.
- A show with several `archetype_fit` values is a hit if its top persona falls in the union of their sets.
- **Map v1.1 (RV-31).** `deep-learn` adds commute-explainer, as decided in RV-29 (`docs/curation/persona-profiles-v1.md`, "v1.1 pruning", PR #1416). `narrative` adds history-deep-diver, because the numbers met the rule RV-31 set for it: the row must rise above its own node-modal baseline under the same map (section 1). `comfort`, `documentary` and `stretch` are unchanged.
- The node-overlap baseline appears twice. "Node modal" is the leave-one-out modal top persona of the show's root, taken over all rated shows. "Node affinity" is the persona with the highest `taxonomy_affinity` for that root, which uses no rating at all.
- The persona similarity uses `fit - 1`, so a show that every persona rates 1 has no direction and no neighbours.
- Explicit has two sources. The persona and rated-set columns use the rater's `flags.explicit`. The catalogue base is Apple's `explicit` in `data/catalog.json`, over the 212 curated shows where it is a boolean (17 have `null`), which is the same curated-only denominator the DAI share uses. Breadth rows are left out of the explicit base: `catalog-breadth.json` has `explicit: false` on all 26,340 rows, because the chart harvest does not carry the flag, so counting them would read 0% by construction.

## Reading the numbers

### 1. Archetype agreement: with map v1.1 the prior beats every baseline

- **Overall, map v1.1.** The top persona lands in the mapped set for **129 of 205 curated shows (0.629)**. The baselines under the same map are 0.302 (random), **0.561 (node modal)** and 0.429 (node affinity).
  - One binomial standard error is about 0.034. The prior leads node modal by about 2 standard errors and node affinity by about 6.
  - That lead is the floor's margin: the test needs precision >= node modal, and the gap is 14 shows of 205.
- **Map v1, for the record.** The card's map gave 90 of 205 (0.439), against 0.239 random, **0.473 node modal** and 0.380 node affinity. The prior was behind node modal, within one standard error.
  - That reversed the pilot's reading. On 84 pilot shows the prior led every baseline (0.429 against a node modal of 0.286), and that note called the lead provisional. At n = 205 the node-modal baseline overtook it, because with 2,978 rated shows the modal top persona of each root is well estimated.
- **Each step of v1.1, measured (one-off counts, not in the block).**
  - Commute-explainer into `deep-learn` alone gives 122 of 205 (0.595), against a node modal of 0.532.
  - Adding history-deep-diver to `narrative` as well gives the block's 129 (0.629), against 0.561.
  - The node-modal baseline rises with every persona the map adds, because it is scored against the same sets. The floor therefore compares like with like, and a map cannot pass it just by adding personas.
- **What that means.** The top persona of a show still mostly restates its root. That is expected, because the taxonomy and the personas both describe topic first. The persona vector's value has to come from what the root cannot carry: format, depth and tone within a topic. A single top-persona hit is the wrong instrument to see that, and the lead over node modal is modest.
- **Restricting to confident tops.** Counting only shows whose top persona has fit 4 or more (173 shows) gives 0.653 under v1.1, against a node modal of 0.561. Under v1 it was 0.462 against 0.480 (one-off counts, not in the block).
- **`comfort` (0.564)** agrees well, but node modal reaches 0.764 there: comedy and talk roots map straight to banter-regular and comfort-companion.
- **`documentary`** scores 9 of 12.
- **`deep-learn` (0.586, was 0.336) was a map gap, not a rating failure.**
  - Of 128 deep-learn shows, **commute-explainer is the top persona for 32**, more than any v1 member. Next are mechanism-hunter (24) and maker-tinkerer (20).
  - With commute-explainer in the set the row is 75 of 128, against a node modal of 0.414.
  - This is the same finding as the pilot (15 of 56), now at more than twice the n.
- **`narrative` (0.350, was 0.117) clears its node-modal baseline, narrowly.**
  - Under v1 the row was 7 of 60, below random (0.154). Commute-explainer (15) and history-deep-diver (14) are the top persona on these story-told nonfiction shows, and narrative-binger on only 7.
  - With history-deep-diver the row is 21 of 60, against 0.231 random and **0.267 node modal**. That meets RV-31's rule for adding it, so v1.1 adds it.
  - The margin is 5 shows. At n = 60 one standard error is about 0.062, so the lead is about 1.4 standard errors, not a firm one.
  - Commute-explainer was not added to `narrative`, because RV-31 asked only about history-deep-diver. Adding it as well would give 22 of 60 there (one-off count).
  - The catalogue's "narrative" and the narrative-binger persona still split the genre differently, as the pilot found.

### 2. Similar shows: node overlap now leads on both recall and precision

- **Seeds are now mostly rated.** 60 of the 64 seeds have ratings. The every-seed and reachable views are therefore close: persona recall@6 is 0.298 and 0.339.
- **On the same rated pool, node overlap leads.**
  - Recall@6 is 0.400 for node overlap against 0.339 for the persona ranking. Precision is 0.609 against 0.206.
  - Persona fit still fills every row (coverage 1.000 against 0.667), and it shows 2 must-not shows in 2 rows, against node overlap's 9 in 6.
  - **This reverses the pilot's recall reading.** The pilot's 0.500 against 0.338 came from 17 reachable seeds.
- **The blend design (D2) stands, and more firmly.** The prior should re-rank inside node overlap, never replace it. That is RV-27's seam C: the prior is the third comparator key, after `shared` and own-node count. Persona fit fills rows that would otherwise be empty, and it is never a candidate source.

### 3. Chart baseline: no prestige leak

- Raters never saw `chart_rank` (D7). Over the 1,970 charted rated shows, Spearman between rank and fit runs from **-0.090 to +0.020** per persona. It is **-0.107 for mean fit**.
- At n = 1,970, the 95% band around zero is about +/-0.044.
  - Six personas are statistically past it: slow-news-contextualist, narrative-binger, sharp-comedy, true-crime-careful, commute-explainer and news-current.
  - All of them are below 0.1 in size: better-charting shows get very slightly higher fits.
- The pilot's hypothesis fits this. Charting shows have longer, better-described feeds, so their packs carry more evidence. A correlation of 0.1 is far from the strong one that would mean prestige leaked into the evidence.

### 4. Coverage and skew

The gold set has the same skew as the pilot, slightly stronger. True-crime-careful has 86% ones, sharp-comedy 72% and history-deep-diver 71% (see the gold report's distribution table).

- **At 2,978 shows, most personas fill a top-50 at fit 4 or more.** In the pilot, narrow personas reached down to fit 2. Now only sharp-comedy (3.3) and true-crime-careful (3) dip below 4. Serving should still cut at fit >= 3, not at a fixed N, so those two personas' tails stay out.
- **Chart top-25** is 15.1% of the rated set against 9.4% of the catalogue, because the sampler stratifies on chart band (D12). Commute-explainer (48%), banter-regular (46%) and comfort-companion (36%) lean further toward top-25 shows, which fits section 3.
- **DAI** is still measurable only on the 220 classified curated shows, which leaves 0 to 24 per persona. Maker-tinkerer (35.7% of 14) remains below the 62.7% base. The n is still too small to move `dai_penalty`.
- **Explicit.**
  - Raters flagged 5.4% of the rated set, against Apple's 3.8% on curated shows.
  - Most of the flags fall on sharp-comedy (34%), banter-regular (30%) and narrative-binger (12%), as expected.
  - The two flags are still different measurements; see the four disagreements in the pilot note.
- **Transcript tier is still 0%.** No transcript-tier packs exist locally, and R2 is gated on #1163 17.3. Audio sub-scores stay null until RV-05 runs.
- **Roots follow intent.** Examples: kids-family is 50% of family-listener's top 50, true-crime 62% of true-crime-careful's, history 42% of history-deep-diver's and comedy 44% of sharp-comedy's. `unlabelled` shows still reach the narrative-binger, commute-explainer and true-crime-careful top-50s; RV-26 lists them.

### One more reading, outside the block

Curated shows still rate higher than breadth shows:
- The best persona fit per show averages **4.15 on the 220 curated shows**, against **3.49 on the 2,758 breadth shows**.
- 82% of curated shows have some persona at 4 or more, against 50% of breadth shows (one-off count, not in the block).

Curation was done before any persona existed, so this is independent evidence that the ratings track fit, not only topic. The pilot's caveat still applies: curated shows carry richer packs.

## What follows

1. **Floors, now in place (RV-31).**
   - The rule was that the prior must beat the free baseline. With the card's map it beat node affinity but not node modal, so the gold-set re-run deferred the floors.
   - With map v1.1 it beats node modal, 0.629 against 0.561. `test/recommender-eval.test.js` now floors the "all mapped" precision at node modal (same map), and the reachable persona recall@6 at 0.30, about one standard error below its measured 0.339 (the mean of 60 per-seed recalls, standard error about 0.042).
   - Any PR that changes `ratings.json` or the map reruns this note, and either floor can turn it red.
2. **The archetype map (done in RV-31):**
   - Commute-explainer joined `deep-learn` (RV-29's decision). It is the top persona on 32 of 128 shows, and the overall score is 0.595 with it alone.
   - History-deep-diver joined `narrative`. The row goes from 0.117 to 0.350, above its node modal of 0.267 by about 1.4 standard errors. Revisit if a later gold run drops it back under node modal.
   - The pilot raised both, and the gold set confirmed them at 2.4 times the n.
3. **For RV-27 (parked):** keep seam C as written, with the prior as a tie-break inside node-overlap candidates. Cut served persona lists at fit >= 3.
4. **For RV-26:** list the `unlabelled` shows that reach persona top-50s.

## Generated

<!-- BEGIN GENERATED: node tools/recommender/eval.mjs -->
Inputs: 2978 rated shows (220 curated), 13 personas, 201 merged batches in `data/recommender/ratings.json`; catalogue universe 26394 shows.

### 1. Archetype agreement

A hit: the show's `top_persona` is in the persona set its `archetype_fit` values map to. Baselines: uniform random, the root's modal top persona (leave-one-out over every rated show), the root's highest-affinity persona. Map v1.1 (RV-31). Floored: the all-mapped precision is at least the node-modal baseline's.

| archetype | personas | shows | hits | precision | random | node modal | node affinity |
|---|---|---:|---:|---:|---:|---:|---:|
| **all mapped** | union | 205 | 129 | 0.629 | 0.302 | 0.561 | 0.429 |
| `comfort` | banter-regular, comfort-companion | 55 | 31 | 0.564 | 0.154 | 0.764 | 0.182 |
| `deep-learn` | commute-explainer, history-deep-diver, mechanism-hunter, practical-improver | 128 | 75 | 0.586 | 0.308 | 0.414 | 0.445 |
| `documentary` | narrative-binger, true-crime-careful | 12 | 9 | 0.750 | 0.154 | 0.833 | 1.000 |
| `narrative` | history-deep-diver, narrative-binger, true-crime-careful | 60 | 21 | 0.350 | 0.231 | 0.267 | 0.250 |

`stretch` only (no mapped persona, not scored): 15 shows; top persona comfort-companion 6, banter-regular 3, mechanism-hunter 2, news-current 2, commute-explainer 1, maker-tinkerer 1.

### 2. Similar-shows agreement

Persona ranking: cosine over the fit vector (fit - 1) among the 220 rated curated shows. k = 6. Floored: the reachable persona recall@6 is at least 0.30. The rest is reported, not gated.

| ranking | view | seeds | precision (shown) | recall@6 | hit rate | coverage | must-not |
|---|---|---:|---:|---:|---:|---:|---:|
| persona fit | every seed, lists as judged | 64 | 0.206 (60) | 0.298 | 0.594 | 0.938 | 2 in 2 |
| persona fit | reachable: rated seeds, lists cut to rated shows | 60 | 0.206 (60) | 0.339 | 0.633 | 1.000 | 2 in 2 |
| similarShows (node overlap) | reachable, same rated pool | 60 | 0.609 (40) | 0.400 | 0.617 | 0.667 | 9 in 6 |
| similarShows floors (229 shows) | committed, test/similar-shows-eval.test.js | 64 | 0.613 | 0.425 | 0.687 | 0.718 | general 0 |

### 3. Chart baseline

Spearman between `chart_rank` (1 = top of an Apple genre chart) and `fit`, over the 1970 of 2978 rated shows that chart. Negative means better-charting shows got higher fits.

| persona | shows | spearman |
|---|---:|---:|
| banter-regular | 1970 | -0.033 |
| comfort-companion | 1970 | -0.016 |
| commute-explainer | 1970 | -0.065 |
| family-listener | 1970 | 0.020 |
| history-deep-diver | 1970 | -0.038 |
| maker-tinkerer | 1970 | -0.013 |
| mechanism-hunter | 1970 | -0.028 |
| narrative-binger | 1970 | -0.085 |
| news-current | 1970 | -0.050 |
| practical-improver | 1970 | -0.005 |
| sharp-comedy | 1970 | -0.079 |
| slow-news-contextualist | 1970 | -0.090 |
| true-crime-careful | 1970 | -0.078 |
| **mean fit** | 1970 | -0.107 |

### 4. Coverage and skew

Each persona's top 50 rated shows (fit, then return_prob, then show_key). DAI is a share of the shows the DAI classifier covered (n in brackets); chart and tier shares are of all 50. Explicit is a share of the shows with a known flag (n in brackets): the rater's flag for the rated set and the personas, Apple's flag in `data/catalog.json` for the catalogue row, which covers curated shows only (the breadth harvest carries no explicit flag). Transcript tier has no catalogue base (the catalogue's tier mix depends on data-local caches).

| set | lowest fit | DAI (classified) | chart top-25 | explicit (known) | transcript tier | leading roots |
|---|---:|---:|---:|---:|---:|---|
| **catalogue** |  | 62.4% (229) | 9.4% | 3.8% (212) | n/a | sports 13.0%, unlabelled 12.9%, religion 6.3% |
| **rated set** |  | 62.7% (220) | 15.1% | 5.4% (2978) | 0.0% | sports 11.7%, unlabelled 8.2%, business 5.0% |
| banter-regular | 5 | 100.0% (3) | 46.0% | 30.0% (50) | 0.0% | comedy 32.0%, tv-film 18.0%, sports 14.0% |
| comfort-companion | 4 | 66.7% (9) | 36.0% | 2.0% (50) | 0.0% | craft 14.0%, comedy 10.0%, culture 8.0% |
| commute-explainer | 4 | 100.0% (10) | 48.0% | 0.0% (50) | 0.0% | science 10.0%, unlabelled 10.0%, nature 8.0% |
| family-listener | 4 | 100.0% (3) | 26.0% | 0.0% (50) | 0.0% | kids-family 50.0%, nature 12.0%, fiction 8.0% |
| history-deep-diver | 4 | 64.7% (17) | 22.0% | 2.0% (50) | 0.0% | history 42.0%, culture 10.0%, religion 6.0% |
| maker-tinkerer | 4 | 35.7% (14) | 14.0% | 0.0% (50) | 0.0% | craft 22.0%, food 16.0%, adventure 10.0% |
| mechanism-hunter | 4 | 58.3% (24) | 22.0% | 0.0% (50) | 0.0% | engineering 16.0%, health 8.0%, nature 8.0% |
| narrative-binger | 4 | 88.9% (9) | 20.0% | 12.0% (50) | 0.0% | fiction 36.0%, true-crime 20.0%, unlabelled 14.0% |
| news-current | 4 | n/a (0) | 30.0% | 0.0% (50) | 0.0% | news 36.0%, sports 18.0%, economics 14.0% |
| practical-improver | 4 | 66.7% (12) | 26.0% | 2.0% (50) | 0.0% | health 28.0%, sports 22.0%, medicine 8.0% |
| sharp-comedy | 3.3 | 100.0% (7) | 22.0% | 34.0% (50) | 0.0% | comedy 44.0%, fiction 20.0%, gaming 6.0% |
| slow-news-contextualist | 4 | 66.7% (12) | 20.0% | 2.0% (50) | 0.0% | news 30.0%, economics 14.0%, cities 10.0% |
| true-crime-careful | 3 | 100.0% (9) | 24.0% | 6.0% (50) | 0.0% | true-crime 62.0%, unlabelled 10.0%, news 6.0% |
<!-- END GENERATED -->
