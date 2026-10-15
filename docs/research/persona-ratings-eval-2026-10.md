# Persona-rating prior: offline eval (RV-21), 2026-10-14

Card RV-21 of [`docs/roadmap/recommender-v1.md`](../roadmap/recommender-v1.md), issue #1380. It answers one question before any client change: does the persona prior agree with the only ground truth on `main`, and how skewed is it, measured against baselines that cost nothing? The inputs are the committed pilot ratings (#1401): 299 shows rated by 13 personas, 90 of them curated, as reported in [`persona-ratings-pilot-2026-10.md`](persona-ratings-pilot-2026-10.md). The block between the `GENERATED` markers is written by `node tools/recommender/eval.mjs`. Everything outside it is written by hand.

**Nothing here is a gate.** The card puts no floors on these numbers. They are a first measurement on a 299-show pilot, and the floors belong to the PR that earns them, after the RV-19 gold run. `test/recommender-eval.test.js` checks the scorer's arithmetic and that the block below is current. Any PR that changes `data/recommender/ratings.json` (each RV-19 merge does) must rerun the script.

## What was built

| File | What it is |
|---|---|
| `tools/recommender/eval.mjs` | The eval. Pure scorers (archetype agreement and its baselines, persona-vector neighbours, chart Spearman, top-50 share profiles), a loader that reads only committed files, and a CLI with `--check` and `--json`, following the `tools/similar-eval/run.mjs` pattern. It calls no model and fetches nothing. |
| `test/recommender-eval.test.js` | 7 tests on hand-worked fixtures plus the block-is-current check. Each test names its mutation, and every mutation was run red. |
| this note | The reading below and the generated block. |

**Choices the card left open.**
- `documentary` maps to narrative-binger and true-crime-careful. All 12 documentary shows in `data/catalog.json` are produced true-crime or paranormal story series.
- A show with several `archetype_fit` values is a hit if its top persona falls in the union of their sets.
- The node-overlap baseline appears twice. "Node modal" is the leave-one-out modal top persona of the show's root, taken over all 299 rated shows. "Node affinity" is the persona with the highest `taxonomy_affinity` for that root, which uses no rating at all.
- The persona similarity uses `fit - 1`, so a show that every persona rates 1 has no direction and no neighbours.
- Explicit is the rater's flag. `catalog-breadth.json` has `explicit: false` on all 26,340 rows, because the chart harvest does not carry the flag, so the catalogue base for explicit would read 0% by construction.

## Reading the numbers

### 1. Archetype agreement: better than every free baseline, but weak

- **Overall.** The top persona lands in the mapped set for **36 of 84 curated shows (0.429)**. The baselines are 0.238 (random), 0.286 (node modal) and 0.333 (node affinity). So the prior carries signal that the taxonomy alone does not. Still, at 0.43, the top persona alone is a poor proxy for a hand-assigned archetype.
- **`comfort` (0.611) agrees best.**
- **`documentary`** scores 4 of 4, but n = 4.
- **`deep-learn` (0.304)** is the largest group, and the baseline nearly matches it: node affinity scores 0.375. The misses are not random. Of the 56 deep-learn shows, **commute-explainer is the top persona for 15**, more than any mapped persona. Commute-explainer is a generalist explainer, and the card's map leaves it out. With it included, deep-learn would score 32 of 56 (0.571; one-off count, not in the block). That is a mapping question, not evidence against the ratings. RV-29 or the next eval should decide it, not this card.
- **`narrative` (0.167)** is at chance. The catalogue's "narrative" means story-told nonfiction: The Ancients, Spycast, Maritime History, 99% Invisible. The narrative-binger persona is defined as serialised, produced audio with arcs. On these shows narrative-binger usually rates 2-3, while another persona (history-deep-diver, mechanism-hunter or commute-explainer) rates 4-5. The two vocabularies split the genre differently. The ratings are not wrong about these shows.

### 2. Similar shows: high recall, low precision, a complement to node overlap

- **Most seeds are unrated.** Only 25 of the 64 seeds are rated, so the "every seed" row (recall@6 0.076, coverage 0.391) mostly measures that gap. It says nothing about ranking quality, and it will change after RV-19 and the student (RV-25).
- **The reachable view is the fair comparison.** It covers the 17 rated seeds that have a rated expected show, with the judged lists cut to rated shows. On the same pool:

| ranking | recall@6 | precision | coverage |
|---|---|---|---|
| persona-vector | **0.500** | 0.167 | 1.000 |
| `similarShows` (node overlap) | 0.338 | 0.792 | 0.471 (empty rows on more than half the seeds) |

  No must-not show appears in either ranking.
- **The two rankings fail in opposite ways.** Node overlap is precise and sparse. Persona fit always fills the row and finds more of the right shows, but pads it with shows that share a listener rather than a subject.
- **This supports the blend design (D2): the prior should re-rank inside node overlap, not replace it.** That is already RV-27's seam C, which adds the prior to `similarShows` as the third comparator key, after `shared` and own-node count. This eval gives no reason to promote the prior above shared nodes.

### 3. Chart baseline: no prestige leak, a slight lean

- Raters never saw `chart_rank` (D7). Over the 213 charted rated shows, Spearman between rank and fit sits between **-0.144 and +0.047** per persona, and **-0.122 for mean fit**. A negative value means better-ranked shows got slightly higher fits.
- At n = 213, the 95% band around zero is about +/-0.135. Three personas sit just past it: sharp-comedy, commute-explainer and narrative-binger. None is near the strong correlation that would mean the evidence leaked prestige.
- A small lean is possible even without a leak: charting shows may have longer, better-described feeds, so their packs carry more evidence. This is a hypothesis; the eval does not test it. Re-read this table on the gold set.

### 4. Coverage and skew: the 52% ones shape every top-50

The pilot found that about 52% of all fits are 1 (mean 1.74). True-crime-careful has 79% ones and sharp-comedy 75%. That skew sets the floor of each persona's top-50.

- **Narrow personas reach down to fit 2 to fill 50 slots.** These are family-listener, history-deep-diver, news-current, practical-improver, sharp-comedy and true-crime-careful (`lowest fit` column), and maker-tinkerer reaches 2.5. Their top-50 tails are "might sample one", not recommendations. A served list should cut at fit >= 3 (or 4, the threshold the pilot set for showing `top_reason`) rather than at a fixed N.
- **Chart top-25.** It is 26.1% of the rated set but 9.4% of the catalogue. The sampler stratified on chart band (D12), so the pilot over-represents charting shows by design. Inside the rated set, family-listener (42%) and comfort-companion, commute-explainer and sharp-comedy (38%) lean further toward top-25 shows. This fits section 3's slight lean.
- **DAI.** It is measurable only on the 229 curated shows the DAI classifier covered, and the persona columns have 10-30 such shows each. Narrative-binger (85%), news-current (80%) and true-crime-careful (76.5%) sit above the 56.7% rated base. Maker-tinkerer (32%) sits below it. The n is too small to read a direction from. If the gold set confirms it, `dai_penalty` (D2, RV-16) is the lever.
- **Explicit.** Raters flagged 14 of 299 shows (4.7%). Sharp-comedy (18%), banter-regular (12%) and narrative-binger (10%) concentrate them, as expected.
- **Transcript tier is 0% everywhere.** The pilot had no transcript-tier packs (no local transcript windows; R2 is gated on #1163 17.3). Every audio sub-score is null, so this column carries no information until RV-05 runs.
- **Roots follow the personas' intent.** Comedy leads for banter-regular and sharp-comedy, true-crime for the two story personas, history for history-deep-diver and craft/food for maker-tinkerer. `unlabelled` breadth shows (12.9% of the catalogue) appear in several top-50s. That is a catalogue-label gap (RV-26's anomaly list), not a persona defect.

### One more reading, outside the block

Curated shows rate higher than breadth shows. The best persona fit per show averages 4.12 on the 90 curated shows against 3.43 on the 209 breadth shows, and 83% of curated shows have some persona at 4+ against 48% of breadth shows (one-off count, not in the block). Curation was done before any persona existed, so this is some independent evidence that the ratings track how well a show fits a listener, not only its topic. There is a caveat: curated shows also carry richer packs (episode titles from the availability file), so part of the gap may come from evidence rather than fit.

## What follows

1. **No floors yet.** Re-run `node tools/recommender/eval.mjs` on the RV-19 gold ratings. Then floor the archetype precision against the node-affinity baseline (the rule: the prior must beat the free baseline), and floor the reachable persona recall@6.
2. **For RV-29 / the archetype map:** decide whether commute-explainer belongs under `deep-learn` and whether the catalogue's `narrative` should map to history-deep-diver as well. Change the map in a PR that says why, and re-run.
3. **For RV-27 (parked):** keep seam C as written (the prior as a tie-break inside node-overlap candidates, never the candidate source). Cut served persona lists at fit >= 3 rather than a fixed N.
4. **For RV-26:** list the `unlabelled` shows that reach persona top-50s.

## Generated

<!-- BEGIN GENERATED: node tools/recommender/eval.mjs -->
Inputs: 299 rated shows (90 curated), 13 personas, 19 merged batches in `data/recommender/ratings.json`; catalogue universe 26394 shows.

### 1. Archetype agreement

A hit: the show's `top_persona` is in the persona set its `archetype_fit` values map to. Baselines: uniform random, the root's modal top persona (leave-one-out over every rated show), the root's highest-affinity persona.

| archetype | personas | shows | hits | precision | random | node modal | node affinity |
|---|---|---:|---:|---:|---:|---:|---:|
| **all mapped** | union | 84 | 36 | 0.429 | 0.238 | 0.286 | 0.333 |
| `comfort` | banter-regular, comfort-companion | 18 | 11 | 0.611 | 0.154 | 0.556 | 0.111 |
| `deep-learn` | history-deep-diver, mechanism-hunter, practical-improver | 56 | 17 | 0.304 | 0.231 | 0.161 | 0.375 |
| `documentary` | narrative-binger, true-crime-careful | 4 | 4 | 1.000 | 0.154 | 1.000 | 1.000 |
| `narrative` | narrative-binger, true-crime-careful | 24 | 4 | 0.167 | 0.154 | 0.042 | 0.042 |

`stretch` only (no mapped persona, not scored): 6 shows; top persona banter-regular 2, comfort-companion 1, maker-tinkerer 1, mechanism-hunter 1, news-current 1.

### 2. Similar-shows agreement

Persona ranking: cosine over the fit vector (fit - 1) among the 90 rated curated shows. k = 6. Reported, not gated.

| ranking | view | seeds | precision (shown) | recall@6 | hit rate | coverage | must-not |
|---|---|---:|---:|---:|---:|---:|---:|
| persona fit | every seed, lists as judged | 64 | 0.113 (25) | 0.076 | 0.141 | 0.391 | 0 in 0 |
| persona fit | reachable: rated seeds, lists cut to rated shows | 17 | 0.167 (17) | 0.500 | 0.529 | 1.000 | 0 in 0 |
| similarShows (node overlap) | reachable, same rated pool | 17 | 0.792 (8) | 0.338 | 0.412 | 0.471 | 0 in 0 |
| similarShows floors (229 shows) | committed, test/similar-shows-eval.test.js | 64 | 0.613 | 0.425 | 0.687 | 0.718 | general 0 |

### 3. Chart baseline

Spearman between `chart_rank` (1 = top of an Apple genre chart) and `fit`, over the 213 of 299 rated shows that chart. Negative means better-charting shows got higher fits.

| persona | shows | spearman |
|---|---:|---:|
| banter-regular | 213 | -0.026 |
| comfort-companion | 213 | -0.079 |
| commute-explainer | 213 | -0.143 |
| family-listener | 213 | 0.025 |
| history-deep-diver | 213 | 0.002 |
| maker-tinkerer | 213 | 0.014 |
| mechanism-hunter | 213 | 0.047 |
| narrative-binger | 213 | -0.142 |
| news-current | 213 | 0.023 |
| practical-improver | 213 | -0.070 |
| sharp-comedy | 213 | -0.144 |
| slow-news-contextualist | 213 | -0.040 |
| true-crime-careful | 213 | -0.058 |
| **mean fit** | 213 | -0.122 |

### 4. Coverage and skew

Each persona's top 50 rated shows (fit, then return_prob, then show_key). DAI is a share of the shows the DAI classifier covered (n in brackets); the other shares are of all 50. Explicit is the rater's flag; transcript tier and explicit have no catalogue base (the catalogue's tier mix depends on data-local caches, and the breadth harvest carries no explicit flag).

| set | lowest fit | DAI (classified) | chart top-25 | explicit | transcript tier | leading roots |
|---|---:|---:|---:|---:|---:|---|
| **catalogue** |  | 62.4% (229) | 9.4% | n/a | n/a | sports 13.0%, unlabelled 12.9%, religion 6.3% |
| **rated set** |  | 56.7% (90) | 26.1% | 4.7% | 0.0% | sports 7.4%, unlabelled 7.0%, business 5.7% |
| banter-regular | 3 | 75.0% (12) | 26.0% | 12.0% | 0.0% | comedy 22.0%, sports 16.0%, unlabelled 10.0% |
| comfort-companion | 3.5 | 56.5% (23) | 38.0% | 2.0% | 0.0% | food 16.0%, comedy 8.0%, craft 8.0% |
| commute-explainer | 3 | 65.4% (26) | 38.0% | 0.0% | 0.0% | history 8.0%, nature 8.0%, business 6.0% |
| family-listener | 2 | 66.7% (18) | 42.0% | 0.0% | 0.0% | nature 12.0%, kids-family 10.0%, sports 8.0% |
| history-deep-diver | 2 | 57.7% (26) | 28.0% | 4.0% | 0.0% | history 16.0%, music 12.0%, culture 6.0% |
| maker-tinkerer | 2.5 | 32.0% (25) | 24.0% | 2.0% | 0.0% | craft 18.0%, food 18.0%, engineering 8.0% |
| mechanism-hunter | 3 | 50.0% (30) | 28.0% | 0.0% | 0.0% | engineering 14.0%, medicine 8.0%, space 8.0% |
| narrative-binger | 3 | 85.0% (20) | 30.0% | 10.0% | 0.0% | true-crime 18.0%, unlabelled 10.0%, fiction 8.0% |
| news-current | 2 | 80.0% (10) | 28.0% | 0.0% | 0.0% | sports 24.0%, unlabelled 12.0%, news 10.0% |
| practical-improver | 2 | 66.7% (15) | 26.0% | 2.0% | 0.0% | health 14.0%, sports 14.0%, medicine 12.0% |
| sharp-comedy | 2 | 71.4% (14) | 38.0% | 18.0% | 0.0% | comedy 22.0%, unlabelled 14.0%, fiction 6.0% |
| slow-news-contextualist | 3 | 72.2% (18) | 34.0% | 0.0% | 0.0% | engineering 12.0%, business 10.0%, cities 8.0% |
| true-crime-careful | 2 | 76.5% (17) | 34.0% | 4.0% | 0.0% | true-crime 20.0%, unlabelled 8.0%, history 6.0% |
<!-- END GENERATED -->
