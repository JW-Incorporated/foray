# Similar shows: eval set and measured baseline (2026-10)

Issue #560 item 8 said: *"Nothing measures whether a suggestion is good: no
eval set, metric or gate on `similarShows` / `showsWeVouchFor`."* This note
covers the `similarShows` half. It records the first measurement, taken on
2026-10-04 against `main` at `c9692ee0`, after the catalogue PKG-07 relabel
(#1037) and the PKG-03 `label_scope: "general"` rule. The numbers come from the
labels as they are now, not from the labels before the clean-up.

## What was built

| File | What it is |
|---|---|
| `tools/similar-eval/similar-shows.mjs` | An exact copy of `app.js:similarShows`, with a small wrapper that supplies the one piece of `state` the function reads (`state.catalog`). |
| `tools/similar-eval/eval-set.json` | 64 seed shows, each with an `expected` list (shows judged similar) and a `must_not` list (shows judged wrong), plus a one-line reviewer note. Every id comes from `data/catalog-client.json`. |
| `tools/similar-eval/score.mjs` | The scorer: precision, recall@k, hit rate, coverage and must-not violations, each averaged per seed. |
| `tools/similar-eval/run.mjs` | The runner. It rewrites the generated block below. `--check` exits 1 when the block is out of date, and `--json` prints the totals. |
| `test/similar-shows-eval.test.js` | 12 tests. They pin the copy to app.js (by text and by output across every catalogue show, 229 since PKG-36), check that the eval set is valid, check the scorer's arithmetic against hand-worked numbers, enforce the floors below, and check that this report is up to date. |

No `app.js` change in the item 8 PR (item 9 later changed the tie-break; see
the 2026-10-05 #560 item 9 note below). The scores use `data/catalog-client.json`, which is the
file `app.js` loads. Its `taxonomy_node_ids` and `label_scope` values match
`data/catalog.json` on all 220 rows.

**Keeping the copy in step.** The copy can go stale if someone edits app.js and
forgets it. To catch that, the first test pulls the `function similarShows`
text out of app.js and requires it to match the code between the
`BEGIN/END MIRROR` markers exactly. If `similarShows` changes in app.js, that
test fails until the new function is pasted between the markers. The floor
tests then show whether the change made suggestions better or worse.

## How the set was judged

- **Reviewer.** Claude (agent) judged every pair by hand on 2026-10-04, using
  each show's title and `editorial_note`. **No founder has reviewed it.** The
  set records one reader's judgement and has not been validated against
  listeners.
- **`expected`** lists the shows a listener of the seed would plausibly want
  next. They were chosen by looking at the shows themselves, never at their
  `taxonomy_node_ids`. That is the point of the set: it can catch label
  mistakes because it was not built from the labels.
- **`must_not`** lists a show only if suggesting it would make a listener
  distrust the whole row, meaning both the subject and the audience differ.
  A show goes on this list only where a shared label could actually bring it
  up. For example, the Supreme Court show *Strict Scrutiny* should not
  suggest *Dateline*, although both carry `society/law`.
- **Unjudged.** A suggested show that is on neither list counts against
  precision but is not a violation. The generated block lists every such
  suggestion so the next reviewer can judge it.
- **Second pass.** After the first run, six shows from the "shown but
  unjudged" list were added to `expected` lists because they were plainly
  right:
  - *History of Ancient Greece* for *Hardcore History*
  - *Handsome* for *Conan O'Brien Needs a Friend*
  - *Robot Brains* for *Practical AI*
  - *Ten Percent Happier* for *The Psychology Podcast*
  - *Ear Hustle* for *Heavyweight*
  - *Morbid* for *Lore*

  This pass favours the current ranking slightly. No judgement was changed in
  the other direction.
- **Hard cases.** All 13 `label_scope: "general"` shows are seeds. A test
  fails if a 14th show is marked general and is not added to the set.
  Fourteen curated seeds list a general show among their `expected` shows. These are
  good suggestions that the PKG-03 rule (founder ruling 24,
  `docs/roadmap/README.md`) never offers.

## What the numbers say

The full tables are in the generated block below. In summary: across the 46
seeds that get a non-empty row, about **60% of the suggested shows are right**.
On average a seed's row contains **41% of the shows it should**. **18 of the 64
seeds get no row at all**, and **11 wrong shows appear across 8 seeds**.

*2026-10-05 (#547 fusion residue):* the summary and the groups below are the
2026-10-04 measurement. CleanTechies Podcast (`engineering/energy-grid`,
`business/startups`) and Lab to Market Leadership (`business/startups`) then
lost their wrong `engineering/energy-fusion` show label. The generated block is
re-run on that catalogue: precision 0.611, recall 0.418 (curated 0.525), hit
rate 0.703, coverage unchanged, violations unchanged. The floors stay at the
2026-10-04 baseline, because other open catalogue PRs move the same numbers.

*2026-10-05 (#279 drinks wave, PKG-36):* the catalogue grows from 220 to 229
shows. Nine drinks shows are added and nothing is relabelled. The generated
block is re-run: precision 0.606, recall 0.410 (curated 0.515). The cause is
one missed pair, `whiskycast` → `spirits-and-distilling`. No ranking changed.
`whiskycast` has a single node, `food/drinks`. Every drinks show ties with it
on that node, and `similarShows` breaks ties by `show_id`. So
`beer-in-front`, `beersmith-podcast` and `brew-strong` sort ahead of
`spirits-and-distilling` and push it out of the six slots. The same tie-break
also keeps the wave's two whiskey shows (`the-bourbon-road`,
`the-bourbon-life`) out of WhiskyCast's row. **The recall floors were lowered
to the new measurement (0.410 / 0.514).** That is an accepted regression with
a named cause. It is not a new baseline anyone chose. A tie-break that prefers
fewer total nodes, or `apple_genre`, is the obvious fix, and it belongs to
whoever next changes `similarShows`.

*2026-10-05 (#560 item 9, crowded-row half):* `similarShows` now breaks a tie
on `shared` by preferring the candidate with **fewer total
`taxonomy_node_ids`**, a Jaccard-style share: one shared node out of one is a
closer match than one out of two. `show_id` is kept only as the last key, so
the order stays stable. `apple_genre` was not used, because it is not in
`data/catalog-client.json`, the file `app.js` loads. Both `label_scope:
"general"` guards are unchanged. The generated block is re-run on the same 229
shows:

| Measure | Alphabetical tie-break | Fewer-nodes tie-break |
|---|---|---|
| Precision (46 seeds) | 0.606 | 0.613 |
| Recall, all / curated | 0.410 / 0.515 | 0.426 / 0.534 |
| Hit rate / coverage | 0.703 / 0.719 | 0.703 / 0.719 |
| Wrong shows | 11 in 8 seeds | 9 in 6 seeds |
| Expected pairs missed | 150 | 148 |

- *WhiskyCast* (`food/drinks` only) now shows the six single-node drinks shows
  ahead of the four that also carry `food/fermentation`: `beer-in-front`,
  `bourbon-pursuit`, `ill-drink-to-that-wine-talk`, `spirits-and-distilling`,
  `the-bourbon-life`, `the-bourbon-road`. The PKG-36 missed pair
  (`spirits-and-distilling`) is back, and both bourbon shows are in the row.
- *5-4* now shows *Strict Scrutiny* (`society/law` only) ahead of the
  two-node true-crime shows; *Serial* drops out of its row.
- *Acquired* and *Fall of Civilizations* no longer suggest each other. Each
  sits on `history/technology` plus one other node, so single-node neighbours
  now take their slots. That removes the two `history/technology` violations.
- *omega tau* already showed *Titans of Nuclear* on this catalogue before the
  change: the #547 fusion residue left omega tau only five candidates, so its
  row was never cut. It is unchanged.
- *My Brother, My Brother and Me* is unchanged. Every `comedy/casual-hangs`
  candidate has the same number of nodes, so the alphabetical last key still
  decides that row.

The tie-break only reorders candidates. It never adds or removes one, so no
row gets longer or shorter, and hit rate and coverage do not move. **The
precision floor, both recall floors and the curated must-not ceiling were
raised to this measurement (0.613, 0.425 / 0.534, ≤ 9).** Group 4 below
describes the 2026-10-04 behaviour that this change addresses.

The failures fall into four groups.

1. **The general rule costs coverage to avoid wrong suggestions.** All 13
   general seeds get an empty row, and 26 of the 150 missed pairs name a
   general show as the missing suggestion. Two curated seeds also get an empty
   row because their only node-mate is a general show:
   `spit-and-twitches-animal-cognition` (Ologies) and
   `the-worlds-best-construction-podcast` (99% Invisible). To measure the trade-off, the rule's
   two lines were removed and the eval run again (a one-off run, not
   committed):

   | Measure | With the rule | Without the rule |
   |---|---|---|
   | Recall | 0.413 | 0.521 |
   | Coverage | 0.719 | 0.938 |
   | Precision | 0.602 | 0.574 |
   | Wrong shows | 11 in 8 seeds | 25 in 16 seeds |

   Without the rule, *CBC Ideas* suggests all four fusion shows again. So the
   rule works as intended: it blocks the fusion-label problem. But it also
   throws away good neighbours, such as *Huberman Lab* to *Matt Walker* and
   *Freakonomics* to *Planet Money*. Matching on labels cannot get both.

2. **Related subjects sit on separate nodes, and the match never walks up to
   the parent node.** Three curated seeds share no node with any other show,
   so their rows are empty:
   - `spycast`
   - `wow-in-the-world`
   - `broken-record`, whose only node is the parent `music`, which no other
     show carries

   Other seeds miss neighbours that sit on a sibling node:
   - `aviation/accidents` and `engineering/disasters` (*Black Box Down* and
     *Well There's Your Problem* never meet)
   - `business/startups` and `business/founders` (*Acquired* and *Founders*
     miss *How I Built This*, *Business Wars* and *Masters of Scale*)
   - `psychology` and `psychology/decision-making`
   - `history/military-ancient` and `history/military-modern`
   - `kids-family/education` and `kids-family/stories`

   This is item 5's exact-id match (`showsForCategory` never walks children)
   showing up on the show page.

3. **Labels that mix unrelated shows still produce wrong suggestions, even
   after the clean-up.** All 11 violations come from three labels that cover
   shows with different subjects and audiences:
   - `society/law` covers both Supreme Court analysis and true crime (6
     violations)
   - `science/storytelling` covers both *Science Vs* and *The Moth* or *Snap
     Judgment* (3)
   - `history/technology` links *Acquired* and *Fall of Civilizations* (2)

   PKG-07 relabelled episodes. These are show-level labels, so PKG-07 did not
   touch them. *(2026-10-05, #560 item 9: the fewer-nodes tie-break pushed the
   two `history/technology` violations out of their rows. The 9 that remain
   are the `society/law` and `science/storytelling` ones.)*

4. **Alphabetical order decides crowded rows.** When more than six candidates
   share the same number of nodes with the seed, `show_id` order picks which
   six are shown. *omega tau*'s row is six candidates that each share one node,
   cut alphabetically. That drops *Titans of Nuclear*, the closest neighbour it
   has. *My Brother, My Brother and Me* shows the first six
   `comedy/casual-hangs` shows in alphabetical order. The tie-break was chosen
   to keep the order stable, but it is not a measure of similarity.
   *(2026-10-05, #560 item 9: fixed for rows whose tied candidates differ in
   node count; equal overlap now prefers fewer total nodes, and `show_id` only
   breaks what is still tied. A row where every tied candidate has the same
   node count, such as *My Brother, My Brother and Me*, is still cut
   alphabetically.)*

## Floors (test/similar-shows-eval.test.js)

Each floor is the value measured above, cut to three decimal places. They
record where the ranking is today, not where it should be. A ranking change
that lowers any of them turns the suite red. A change that raises them should
raise the floor in the same PR.

| Gate | Value | Mutation that turns it red (run 2026-10-04) |
|---|---|---|
| precision (shown) | ≥ 0.613 (was 0.601 before #560 item 9) | remove `.filter(x => x.shared > 0)`; drop the node-count tie-break key (run 2026-10-05) |
| recall@6, all / curated | ≥ 0.425 / ≥ 0.534 (was 0.413 / 0.518 before PKG-36, 0.410 / 0.514 before #560 item 9) | `limit = 6` → `limit = 3`; drop the node-count tie-break key (run 2026-10-05) |
| hit rate / coverage | ≥ 0.687 / ≥ 0.718 | `x.shared > 0` → `x.shared > 1` |
| must-not, curated seeds | ≤ 9 (was 11 before #560 item 9) | drop `&& s.label_scope !== "general"`; drop the node-count tie-break key (run 2026-10-05) |
| must-not, general seeds | = 0 | drop `if (show?.label_scope === "general") return [];` |

**To change the ranking:**

1. Edit `app.js:similarShows`.
2. Paste the new function between the MIRROR markers in
   `tools/similar-eval/similar-shows.mjs`.
3. Run `node tools/similar-eval/run.mjs`.
4. Read the failing pairs in the regenerated block.
5. Adjust any floors that moved, and commit all of it together.

## Limits

- One reviewer, who is an agent, and 64 seeds out of 220 shows. A shown show
  that nobody judged counts as a miss, which makes precision a lower bound.
- The breadth tier is not covered. Breadth shows only get nodes from the API
  row (PKG-09/10), and the eval reads only the committed curated catalogue.
- `showsWeVouchFor`, the other half of item 8, is not covered. It is an
  editorial row with no seed, so it needs a different kind of eval.
- Nothing here measures what listeners do (click-through, dwell time). This is
  an offline proxy only.

<!-- BEGIN GENERATED: node tools/similar-eval/run.mjs -->
k = 6 (the slots the show page renders). Precision is over what was shown; recall is over min(|expected|, k).

| Group | Seeds | Precision (shown) | Recall@6 | Hit rate | Coverage | Must-not violations |
|---|---:|---:|---:|---:|---:|---:|
| All seeds | 64 | 0.613 (46 seeds) | 0.426 | 0.703 | 0.719 | 9 in 6 seeds |
| Curated seeds | 51 | 0.613 (46 seeds) | 0.534 | 0.882 | 0.902 | 9 in 6 seeds |
| `label_scope: "general"` seeds | 13 | n/a (0 seeds) | 0.000 | 0.000 | 0.000 | 0 in 0 seeds |

### Per seed

| Seed | General | Shown | Hits | Precision | Recall | Violations |
|---|:-:|---:|---:|---:|---:|---|
| `lex-fridman-podcast` | yes | 0 | 0 | n/a | 0.000 |  |
| `catalyst-shayle-kann` | yes | 0 | 0 | n/a | 0.000 |  |
| `cbc-ideas` | yes | 0 | 0 | n/a | 0.000 |  |
| `stuff-you-should-know` | yes | 0 | 0 | n/a | 0.000 |  |
| `being-an-engineer` | yes | 0 | 0 | n/a | 0.000 |  |
| `the-rest-is-history` | yes | 0 | 0 | n/a | 0.000 |  |
| `99-percent-invisible` | yes | 0 | 0 | n/a | 0.000 |  |
| `ologies-with-alie-ward` | yes | 0 | 0 | n/a | 0.000 |  |
| `software-engineering-daily` | yes | 0 | 0 | n/a | 0.000 |  |
| `freakonomics-radio` | yes | 0 | 0 | n/a | 0.000 |  |
| `unexplainable` | yes | 0 | 0 | n/a | 0.000 |  |
| `huberman-lab` | yes | 0 | 0 | n/a | 0.000 |  |
| `techsurge-deep-tech-podcast` | yes | 0 | 0 | n/a | 0.000 |  |
| `titans-of-nuclear` |  | 1 | 1 | 1.000 | 0.200 |  |
| `omega-tau` |  | 5 | 1 | 0.200 | 0.250 |  |
| `materialism-podcast` |  | 4 | 2 | 0.500 | 0.667 |  |
| `inside-chips` |  | 4 | 1 | 0.250 | 0.333 |  |
| `making-chips` |  | 4 | 3 | 0.750 | 1.000 |  |
| `fall-of-civilizations` |  | 6 | 4 | 0.667 | 0.800 |  |
| `hardcore-history` |  | 4 | 3 | 0.750 | 0.500 |  |
| `engines-of-our-ingenuity` |  | 3 | 1 | 0.333 | 0.333 |  |
| `acquired` |  | 6 | 1 | 0.167 | 0.250 |  |
| `founders` |  | 5 | 1 | 0.200 | 0.250 |  |
| `twenty-minute-vc` |  | 5 | 1 | 0.200 | 0.333 |  |
| `conan-obrien-needs-a-friend` |  | 6 | 4 | 0.667 | 0.667 |  |
| `my-brother-my-brother-and-me` |  | 6 | 1 | 0.167 | 0.333 |  |
| `black-box-down` |  | 1 | 1 | 1.000 | 0.250 |  |
| `well-theres-your-problem` |  | 2 | 2 | 1.000 | 0.500 |  |
| `gastropod` |  | 1 | 0 | 0.000 | 0.000 |  |
| `lingthusiasm` |  | 1 | 1 | 1.000 | 1.000 |  |
| `song-exploder` |  | 3 | 3 | 1.000 | 0.750 |  |
| `spit-and-twitches-animal-cognition` |  | 0 | 0 | n/a | 0.000 |  |
| `the-worlds-best-construction-podcast` |  | 0 | 0 | n/a | 0.000 |  |
| `spycast` |  | 0 | 0 | n/a | 0.000 |  |
| `main-engine-cut-off` |  | 2 | 2 | 1.000 | 1.000 |  |
| `corecursive` |  | 1 | 1 | 1.000 | 0.333 |  |
| `planet-money` |  | 1 | 1 | 1.000 | 0.500 |  |
| `hidden-brain` |  | 2 | 2 | 1.000 | 0.400 |  |
| `the-matt-walker-podcast` |  | 2 | 2 | 1.000 | 0.500 |  |
| `strict-scrutiny` |  | 6 | 2 | 0.333 | 1.000 | `dateline-nbc` |
| `5-4-podcast` |  | 6 | 2 | 0.333 | 1.000 | `dateline-nbc` |
| `criminal` |  | 6 | 3 | 0.500 | 0.600 | `5-4-podcast`, `amicus-dahlia-lithwick` |
| `dateline-nbc` |  | 6 | 3 | 0.500 | 0.600 | `5-4-podcast`, `amicus-dahlia-lithwick` |
| `morbid` |  | 6 | 4 | 0.667 | 0.800 |  |
| `radiolab` |  | 4 | 2 | 0.500 | 0.400 |  |
| `the-moth` |  | 4 | 2 | 0.500 | 0.500 | `science-vs` |
| `science-vs` |  | 4 | 1 | 0.250 | 0.250 | `snap-judgment`, `the-moth` |
| `happiness-lab` |  | 6 | 3 | 0.500 | 0.600 |  |
| `the-psychology-podcast` |  | 5 | 2 | 0.400 | 0.400 |  |
| `good-inside-dr-becky` |  | 5 | 1 | 0.200 | 1.000 |  |
| `heavyweight` |  | 6 | 4 | 0.667 | 0.667 |  |
| `where-should-we-begin` |  | 6 | 2 | 0.333 | 0.500 |  |
| `armchair-expert` |  | 5 | 3 | 0.600 | 0.600 |  |
| `kill-tony` |  | 1 | 1 | 1.000 | 0.333 |  |
| `welcome-to-night-vale` |  | 3 | 3 | 1.000 | 1.000 |  |
| `whiskycast` |  | 6 | 2 | 0.333 | 1.000 |  |
| `craft-beer-and-brewing-magazine-podcast` |  | 6 | 2 | 0.333 | 1.000 |  |
| `practical-ai` |  | 3 | 2 | 0.667 | 0.500 |  |
| `wow-in-the-world` |  | 0 | 0 | n/a | 0.000 |  |
| `broken-record` |  | 0 | 0 | n/a | 0.000 |  |
| `lore` |  | 4 | 3 | 0.750 | 0.600 |  |
| `the-sharp-end-podcast` |  | 2 | 2 | 1.000 | 1.000 |  |
| `f1-beyond-the-grid` |  | 2 | 2 | 1.000 | 1.000 |  |
| `volts` |  | 3 | 3 | 1.000 | 0.750 |  |

### Failing pairs

**Must-not shows that appeared** (seed → shown show):

- `strict-scrutiny` → `dateline-nbc`
- `5-4-podcast` → `dateline-nbc`
- `criminal` → `5-4-podcast`, `amicus-dahlia-lithwick`
- `dateline-nbc` → `5-4-podcast`, `amicus-dahlia-lithwick`
- `the-moth` → `science-vs`
- `science-vs` → `snap-judgment`, `the-moth`

**Empty rows** (the seed renders no Similar shows section):

- `lex-fridman-podcast`, `catalyst-shayle-kann`, `cbc-ideas`, `stuff-you-should-know`, `being-an-engineer`, `the-rest-is-history`, `99-percent-invisible`, `ologies-with-alie-ward`, `software-engineering-daily`, `freakonomics-radio`, `unexplainable`, `huberman-lab`, `techsurge-deep-tech-podcast`, `spit-and-twitches-animal-cognition`, `the-worlds-best-construction-podcast`, `spycast`, `wow-in-the-world`, `broken-record`

**Expected shows missed** (seed → expected shows not in its row):

- `lex-fridman-podcast` → `twiml-ai`, `robot-brains`, `practical-ai`, `the-peter-attia-drive`, `huberman-lab`
- `catalyst-shayle-kann` → `volts`, `energy-gang`, `watt-it-takes`, `cleantechies-podcast`
- `cbc-ideas` → `philosophy-bites`, `philosophize-this`, `radiolab`, `hidden-brain`, `distillations`
- `stuff-you-should-know` → `radiolab`, `science-vs`, `engines-of-our-ingenuity`, `ologies-with-alie-ward`, `freakonomics-radio`, `unexplainable`
- `being-an-engineer` → `making-chips`, `business-of-machining`, `within-tolerance`
- `the-rest-is-history` → `hardcore-history`, `fall-of-civilizations`, `we-have-ways-of-making-you-talk`, `the-ancients`, `our-fake-history`
- `99-percent-invisible` → `twenty-thousand-hertz`, `the-worlds-best-construction-podcast`, `strong-towns-podcast`, `the-engineering-history-podcast`, `design-matters`
- `ologies-with-alie-ward` → `radiolab`, `science-vs`, `this-podcast-will-kill-you`, `stuff-you-should-know`, `unexplainable`
- `software-engineering-daily` → `practical-ai`, `corecursive`, `twiml-ai`
- `freakonomics-radio` → `planet-money`, `hidden-brain`, `odd-lots`, `choiceology`, `you-are-not-so-smart`
- `unexplainable` → `radiolab`, `science-vs`, `ologies-with-alie-ward`, `stuff-you-should-know`
- `huberman-lab` → `the-matt-walker-podcast`, `the-peter-attia-drive`, `foundmyfitness`, `feel-better-live-more`
- `techsurge-deep-tech-podcast` → `lab-to-market-leadership`, `twenty-minute-vc`, `this-week-in-startups`, `watt-it-takes`
- `titans-of-nuclear` → `cleantechies-podcast`, `catalyst-shayle-kann`, `volts`, `energy-gang`
- `omega-tau` → `off-nominal`, `main-engine-cut-off`, `the-engineering-history-podcast`
- `materialism-podcast` → `chemistry-world-podcast`
- `inside-chips` → `mrs-bulletin-materials-news`, `materialism-podcast`
- `fall-of-civilizations` → `the-rest-is-history`
- `hardcore-history` → `the-rest-is-history`, `we-have-ways-of-making-you-talk`, `history-of-wwii-podcast`
- `engines-of-our-ingenuity` → `distillations`, `advent-of-computing`
- `acquired` → `business-wars`, `how-i-built-this`, `masters-of-scale`
- `founders` → `how-i-built-this`, `masters-of-scale`, `business-wars`
- `twenty-minute-vc` → `masters-of-scale`, `techsurge-deep-tech-podcast`
- `conan-obrien-needs-a-friend` → `smartless`, `armchair-expert`
- `my-brother-my-brother-and-me` → `handsome`, `how-did-this-get-made`
- `black-box-down` → `well-theres-your-problem`, `causality-engineered-network`, `brady-heywood-podcast`
- `well-theres-your-problem` → `black-box-down`, `flight-safety-detectives`
- `gastropod` → `fermup`, `tiny-matters`, `distillations`
- `song-exploder` → `broken-record`
- `spit-and-twitches-animal-cognition` → `the-sound-aquatic`, `ologies-with-alie-ward`
- `the-worlds-best-construction-podcast` → `99-percent-invisible`, `strong-towns-podcast`, `brady-heywood-podcast`, `the-engineering-history-podcast`
- `spycast` → `we-have-ways-of-making-you-talk`, `unauthorized-history-pacific-war`, `history-of-wwii-podcast`
- `corecursive` → `software-engineering-daily`, `practical-ai`
- `planet-money` → `freakonomics-radio`
- `hidden-brain` → `freakonomics-radio`, `happiness-lab`, `the-psychology-podcast`
- `the-matt-walker-podcast` → `huberman-lab`, `feel-better-live-more`
- `criminal` → `casefile-true-crime`, `crime-junkie`
- `dateline-nbc` → `crime-junkie`, `casefile-true-crime`
- `morbid` → `lore`
- `radiolab` → `unexplainable`, `ologies-with-alie-ward`, `stuff-you-should-know`
- `the-moth` → `storycorps`, `modern-love`
- `science-vs` → `unexplainable`, `maintenance-phase`, `ologies-with-alie-ward`
- `happiness-lab` → `hidden-brain`, `happier-gretchen-rubin`
- `the-psychology-podcast` → `hidden-brain`, `you-are-not-so-smart`, `choiceology`
- `heavyweight` → `this-american-life`, `the-moth`
- `where-should-we-begin` → `modern-love`, `we-can-do-hard-things`
- `armchair-expert` → `smartless`, `conan-obrien-needs-a-friend`
- `kill-tony` → `2-bears-1-cave`, `bad-friends`
- `practical-ai` → `software-engineering-daily`, `lex-fridman-podcast`
- `wow-in-the-world` → `story-pirates`, `circle-round`
- `broken-record` → `song-exploder`, `dissect`, `switched-on-pop`
- `lore` → `myths-and-legends`, `our-fake-history`
- `volts` → `catalyst-shayle-kann`

148 expected pairs missed in all; 26 of them name a `label_scope: "general"` show, which similarShows never offers as a candidate.

**Shown but unjudged** (in the row, in neither list; counted as misses in precision):

- `omega-tau` → `its-a-material-world`, `materialism-podcast`, `mrs-bulletin-materials-news`, `mtdcnc-podcast`
- `materialism-podcast` → `mtdcnc-podcast`, `omega-tau`
- `inside-chips` → `business-of-machining`, `making-chips`, `mtdcnc-podcast`
- `making-chips` → `inside-chips`
- `fall-of-civilizations` → `engines-of-our-ingenuity`, `the-engineering-history-podcast`
- `hardcore-history` → `ancient-history-fangirl`
- `engines-of-our-ingenuity` → `acquired`, `fall-of-civilizations`
- `acquired` → `engines-of-our-ingenuity`, `lab-to-market-leadership`, `the-engineering-history-podcast`, `this-week-in-startups`, `twenty-minute-vc`
- `founders` → `lab-to-market-leadership`, `this-week-in-startups`, `twenty-minute-vc`, `cleantechies-podcast`
- `twenty-minute-vc` → `founders`, `lab-to-market-leadership`, `acquired`, `cleantechies-podcast`
- `conan-obrien-needs-a-friend` → `2-bears-1-cave`, `bad-friends`
- `my-brother-my-brother-and-me` → `2-bears-1-cave`, `bad-friends`, `conan-obrien-needs-a-friend`, `fly-on-the-wall`, `good-hang-amy-poehler`
- `gastropod` → `the-bbq-central-show`
- `strict-scrutiny` → `bone-valley`, `criminal`, `in-the-dark`
- `5-4-podcast` → `bone-valley`, `criminal`, `in-the-dark`
- `criminal` → `dateline-nbc`
- `dateline-nbc` → `criminal`
- `morbid` → `bone-valley`, `criminal`
- `radiolab` → `snap-judgment`, `the-moth`
- `the-moth` → `radiolab`
- `science-vs` → `this-american-life`
- `happiness-lab` → `ask-lisa-parenting`, `feel-better-live-more`, `good-inside-dr-becky`
- `the-psychology-podcast` → `ask-lisa-parenting`, `good-inside-dr-becky`, `where-should-we-begin`
- `good-inside-dr-becky` → `the-psychology-podcast`, `happiness-lab`, `ten-percent-happier`, `where-should-we-begin`
- `heavyweight` → `dear-prudence`, `dear-sugars`
- `where-should-we-begin` → `the-psychology-podcast`, `ask-lisa-parenting`, `dear-prudence`, `good-inside-dr-becky`
- `armchair-expert` → `las-culturistas`, `working-it-out-birbiglia`
- `whiskycast` → `beer-in-front`, `ill-drink-to-that-wine-talk`, `the-bourbon-life`, `the-bourbon-road`
- `craft-beer-and-brewing-magazine-podcast` → `fermup`, `beersmith-podcast`, `brew-strong`, `cider-chat`
- `practical-ai` → `robot-talk`
- `lore` → `wicked-words-kate-winkler-dawson`
<!-- END GENERATED -->
