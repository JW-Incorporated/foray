# Taxonomy review — 2026-08

Desk: Curation / Data. Date: 2026-08-15. Author: Claude Code session.
Scope: `data/taxonomy.json`, its consumers, and the classifier fleet that applies it.
Companion to ADR-0003 (taxonomy representation), `docs/research/curation-practices.md`,
`docs/research/genre-map-notes.md`, and `docs/marketing/10-category-coverage.md`.

**This review shipped its own conclusion.** Per the CTO's 2026-08-15 directive ("act on
the categories that research presents"), the node set below is already applied to
`data/taxonomy.json` in the same PR as this document. The doc is the rationale, not a
proposal awaiting sign-off. Two items are deliberately left for a founder — see §8.

---

## 1. Correcting the brief

This review was commissioned on the premise that `data/taxonomy.json` "has only 12 nodes"
and that "there is NO food/cooking category at all." **Both were false at the time of
writing**, and the correction matters because it changes what the actual problem is.

| Claim in the brief | Measured on 2026-08-15 |
|---|---|
| 12 nodes | **149 nodes** — 41 top-level branches, 108 children |
| no food category | `food`, `food/cooking-science`, `food/fermentation` all existed |
| grilling Foray is blocked | **Not blocked.** `food/cooking-science` is a valid node that `merge-segments.mjs` accepts today; `data/topic-coverage-report.json` already resolves the `bbq-grilling` topic to it at priority 6 ("none — already fine") |

The 12-node description matches the **2026-07-07 seed** (commit `e53b794`, 15 nodes:
`engineering`, `engineering/energy-fusion`, `engineering/precision-mfg`, `science`,
`science/materials`, `history`, `history/military-ancient`, `history/technology`, `craft`,
`craft/instrument-making`, `craft/diy-home`, `business`, `business/startups`, `comedy`,
`comedy/casual-hangs`). It grew to 36 nodes at `5d847d3`, then to 147 at `0233c65`
("Category coverage audit: 12% → 80% of listening hours"). A near-identical 9-id list
also survives as `FALLBACK_TOPICS` in `backend/src/enrich/StubEnricher.ts:36-45`, which is
a plausible source of the stale impression — that array has never been updated and is now
5% of the tree.

**Why this matters:** the taxonomy's problem is not that it is *small*. It is that it is
*lopsided* — large, but shaped so that a lot of it cannot be reached. Fixing the wrong
problem (bolting on a food branch that already existed) would have left the real defect
in place.

## 2. What the taxonomy is for

Four consumers key off the **same** node ids, which is why ids are expensive to change
(`docs/curation/personalization-and-depth-plan.md` §5 calls this an invariant to protect):

- **Catalogue tags** — `discover.json.items[].topics`, `session.json.episodes[].topics`
- **User interest weights** — the Interests screen, `backend/src/curation/userInterests.ts`
- **Persona presets** — `data/personas.json`, 72 weight refs across 6 personas
- **Onboarding chips** — the top-level branches

Relevance is then a dot product between a user's weight vector and an item's node
membership, which is what makes a why-line explainable ("because you rate Fusion highly").
Per ADR-0003 the tree is deliberately *symbolic and hand-editable* rather than pure
embeddings, and per `curation-practices.md` `depth` is an episode attribute, not a
taxonomy dimension. **Both of those decisions are correct and this review does not
reopen them.**

It is a **personal interest graph with evidence timestamps**, not a universal directory.
That distinction defends something that looks like a bug: six nodes have **zero**
catalogue support (`engineering/energy-fusion`, `engineering/precision-mfg`,
`science/materials`, `espionage/cold-war-tech`, `linguistics`, `cities`). Those are the
original founder-interest seeds. `03_CURATION_SPEC.md` explicitly makes the Stretch slot
draw from "a cold taxonomy node with high global quality" — a cold node is a **feature of
the exploration design**, not dead weight. They stay.

## 3. Where it actually failed — with counts

### 3.1 The headline defect: six branches were invisible in the UI

`app.js:166-168` renders interest sliders from `leafNodes()` —
`state.taxonomy.nodes.filter(n => n.parent !== null)`. **Only non-root nodes become user
interests.** A top-level branch with no children therefore has no slider anywhere in the
product, no matter how much content sits in it.

Six branches were in exactly that state:

| Branch | Breadth shows | Curated episodes |
|---|---:|---:|
| `hobbies` | 281 | 0 |
| `true-crime` | 245 | 67 |
| `relationships` | 244 | 37 |
| `personal-journals` | 230 | 53 |
| `travel` | 209 | 1 |
| `paranormal` | 15 | 23 |
| **Total unreachable** | **1,224** | **181** |

True crime is ~9% of US listening hours (`docs/marketing/10-category-coverage.md`) and had
67 curated episodes that no user could express a preference for. This is the single
largest failure in the file and it has nothing to do with food.

### 3.2 The shape defect: roots absorb what children should catch

Counting every node reference across all 19,787 classified shows
(`data/breadth-classification.json`), branches split into two clearly different
populations by the ratio of child hits to root hits:

**Working (children absorb the volume) — these mirror Apple's own subcategory tree:**

| Branch | root | children | ratio |
|---|---:|---:|---:|
| `health` | 62 | 1,338 | 21.6 |
| `kids-family` | 36 | 641 | 17.8 |
| `culture` | 89 | 1,161 | 13.0 |
| `sports` | 321 | 2,649 | 8.3 |
| `religion` | 189 | 1,277 | 6.8 |
| `education` | 131 | 789 | 6.0 |

**Broken (the root is a dumping ground) — these are the hand-authored personal-interest
branches, which got one or two hyper-specialist children and nothing general:**

| Branch | root | children | ratio | children it had |
|---|---:|---:|---:|---|
| `computing` | 426 | 5 | **0.01** | `history` |
| `math` | 153 | 3 | **0.02** | `puzzles` |
| `music` | 742 | 24 | **0.03** | `theory-production`, `classical` |
| `gaming` | 383 | 15 | **0.04** | `design` |
| `automotive` | 196 | 7 | **0.04** | `racing` |
| `psychology` | 319 | 16 | **0.05** | `decision-making` |
| **`food`** | **374** | **21** | **0.06** | `cooking-science`, `fermentation` |
| `space` | 239 | 14 | 0.06 | `rockets` |
| `history` | 657 | 59 | 0.09 | 4 specialist nodes |
| `aviation` | 206 | 1 | 0.00 | `accidents` |

`music` is the worst in absolute terms: 742 shows, and the only ways to express a music
interest were "music theory & production" and "classical". `food` is the clearest
illustration of the pattern — 374 shows classified to the branch, 21 reaching a child,
because the only two children were a science node and a fermentation node. A listener who
likes barbecue had nothing to turn up.

### 3.3 Thirteen topics had no node at all

`data/topic-coverage-report.json` (155 topics evaluated) flags 13 as `no-node`, all
tagged `needs-taxonomy-adr`: MMA/UFC, meditation & mindfulness, cryptocurrency, jazz,
hip-hop & rap, immigrant & diaspora stories, LGBTQ+ stories, cybersecurity, coffee,
esports, board games & tabletop, K-pop & global pop, boxing.

**Be precise about the size of this**: 13 of 155 is 8.4%. The report's own priority
buckets put only **24 topics at priority 4 (retag / taxonomy governance)** while **47 are
priority 2** and mostly need a *semantic-index* or *content-sourcing* fix, not a taxonomy
one. The taxonomy was never the biggest bottleneck in the coverage story, and this review
does not claim it was.

### 3.4 An ADR-0003 compliance drift

ADR-0003 says "Every node anchors to a standard Apple Podcasts category." **67 of 149
nodes (45%) had `apple_anchor: null`**, including 23 of 41 top-level branches — and
`food` itself, despite Apple having a literal `Arts > Food` category that
`data/genre-taxonomy-map.json` already routes to it with `high` confidence. Some of those
nulls are real gaps in Apple's tree; most were just never filled in. See §5 for how this
is now resolved.

### 3.5 What is NOT wrong

- **The two-level depth limit is right.** It keeps ids parseable (`id.split("/")[0]`
  is the branch, relied on by `topic-coverage-report.mjs:46` and
  `tools/transcribe/fetch-audio.mjs:166`) and keeps the Interests screen legible.
- **`depth` as an episode attribute, not a taxonomy axis** — correct, per
  `curation-practices.md` §3, and untouched.
- **Cold nodes with zero catalogue support** — correct, per §2 above.
- **Multi-label topics** — correct; it is what lets a history-of-grilling Foray be both
  food and history without duplicating nodes.

## 4. Not letting Apple define the taxonomy

Our entire catalogue was harvested from Apple charts, so a genre distribution computed
from it describes **what Apple ranks**, not what exists.

**A trap worth naming explicitly:** the brief asked for "the real genre distribution"
from `data/catalog-breadth.json`. That file is a per-genre top-200 chart harvest —
**91 of its 110 genres sit at exactly 200 shows**, and the 19 that fall short are umbrella
genres Apple under-populates (Arts 34, Religion & Spirituality 35, Education 36,
Health & Fitness 38, Kids & Family 38, Leisure 40, Business 43, News 44). The distribution
is **flat by construction**. Any node set derived from those counts would be laundering
Apple's harvest shape into our taxonomy while looking like evidence. The counts used
throughout §3 are from `breadth-classification.json` (what our classifiers decided each
show is *about*) and `discover.json` (our curated pool), never from raw `apple_genre`
frequency.

### 4.1 Where Apple's taxonomy is actively bad for Foray

**It sorts by format and mood, not subject.** `Documentary`, `Personal Journals`,
`Courses`, `How To`, `After Shows`, `Improv`, `Comedy Interviews`, `Film Interviews`, and
all three Music subcategories (`Music Commentary`, `Music History`, `Music Interviews`)
describe *how a show is made*, not what it is about. For a subject-interest model this is
actively harmful: a user's weight on "documentary" says nothing about what to serve them.
Foray already separates these correctly — `episode_attributes.format`
(`interview | narrative | panel | solo | documentary | hang`) is a per-episode attribute,
exactly where format belongs. `genre-map-notes.md` reached the same conclusion
independently, filing Apple's umbrella/format genres as `low` confidence "topic-agnostic
umbrellas or formats where the genre says nothing about subject matter."

**It has no category for whole intellectual domains.** `curation-practices.md` already
recorded the biggest: there is no Engineering category at all. The same is true of
philosophy-as-a-discipline (Apple has `Society & Culture > Philosophy`, which is a
culture sub-slot, not a domain), mathematics (one leaf under Science), law, linguistics,
architecture, and food beyond the single `Arts > Food` leaf.

**Its depth is wildly uneven.** Sports gets 15 subcategories — but not boxing or MMA.
History and Technology and True Crime get **zero** subcategories each, despite History
being 2.5% of US listening hours. Music gets three, all formats. The unevenness tracks
commercial ad-sales value, not intellectual structure.

### 4.2 What the other classification systems get right

**PodcastIndex** ([docs-categories](https://github.com/Podcastindex-org/docs-categories))
ships `categories.txt` with **106 entries** alongside a 127-line `apple_categories.txt`.
It is Apple's set with the hierarchy **thrown away** — a flat list in which compound
names are split into separate tokens (`Fashion` and `Beauty` are two entries;
`Performing` and `Visual`; `Language` and `Learning`). It gets one thing right — a flat
id space is trivial to match against RSS `<itunes:category>` — and one thing badly wrong
for us: with no parent links there is no partial credit for adjacency, which is precisely
the property ADR-0003 chose a hierarchy to get. It is an interop format, not an interest
model.

**Dewey Decimal** organises by *discipline*, not by genre, into ten main classes:
000 Generalities, 100 Philosophy & psychology, 200 Religion, 300 Social sciences,
400 Language, 500 Natural sciences & mathematics, 600 Technology (Applied sciences),
700 The arts, 800 Literature & rhetoric, 900 Geography & history
([Illinois DDC guide](https://www.library.illinois.edu/infosci/research/guides/dewey/)).
Line those up against Apple's 19 and the gaps are stark:

| Dewey main class | Apple equivalent |
|---|---|
| 100 Philosophy & psychology | **none** — `Society & Culture > Philosophy` is a culture sub-slot; psychology has no home at all |
| 400 Language | **none** — `Education > Language Learning` is pedagogy, not linguistics |
| 340 Law (in 300) | **none** |
| 620 Engineering (in 600) | **none** — already the known biggest gap |
| 630 Agriculture (in 600) | **none** |
| 610 Medicine (in 600) | only `Health & Fitness > Medicine`, framed as consumer wellness |
| 900 Geography (with History) | **none** |

**Four of Dewey's ten top-level classes are wholly or partly unrepresented in Apple's
19.** The instructive part: Foray's tree had *already* independently reinvented most of
them — `engineering`, `linguistics`, `math`, `philosophy`, `psychology`, `medicine`,
`society/law`, `cities`, `transport`, `architecture` all exist as branches with
`apple_anchor: null`. Those nulls are not sloppiness; they are the discipline-based
skeleton showing through a genre-based veneer. §4.4 makes that explicit rather than
treating it as debt.

**Library of Congress** is the strongest evidence for the food decision, because it and
Dewey independently make the *same split*, and it is not the split Apple makes:

| Concept | Dewey | Library of Congress |
|---|---|---|
| Cooking, technique, recipes | **641** Food & drink (inside 640 Home economics, inside 600 Technology) | **TX642–840** Cooking (TX = Home economics) |
| Food customs, foodways, the history of how a people eats | **394.1** Food customs (inside 394 General customs, inside 300 Social sciences) | **GT2850–GT2960** Food habits (GT = Manners & Customs) |
| Regional / national cuisine | **641.59** | — |

Sources: [LC Food habits authority sh85050275](https://id.loc.gov/authorities/subjects/sh85050275.html),
[LC Foodways research guide](https://guides.loc.gov/foodways-folklife),
[LCC TX642-840](https://www.librarything.com/lcc/TX642-840),
[DDC 641.59](https://www.librarything.com/mds/641.59), [DDC 394.1](https://www.librarything.com/mds/394.1).

Two schemes, built a century apart for different purposes, both conclude that **the
technique of cooking and the culture/history of eating are different subjects** — far
enough apart to sit in different *main classes*. Apple compresses all of it into one leaf,
`Arts > Food`. That is the single clearest case in this review of Apple's tree being
actively wrong for us, and §5.1's food branch is shaped on the library split
(`cooking-science`, `grilling-bbq`, `baking` on the technique side; `food-history`,
`cuisines` on the culture side) rather than on Apple's single bucket.

**Academic field schemes agree with Dewey and LC on the gaps.** OECD FORD (Frascati 2015)
uses **6 major fields / 42 minor**, one of which is *Engineering and technology* and
another *Agricultural and veterinary sciences*. UNESCO ISCED-F 2013 uses **11 broad
fields**, including **08 Agriculture, forestry, fisheries and veterinary**. ANZSRC 2020
uses **23 divisions** and is the one scheme that names food at division level —
**30 Agricultural, Veterinary and Food Sciences**. NCES CIP 2020 uses **48 two-digit
series**. Oxford organises into **4 divisions**. Every one of them treats engineering and
agriculture/food as top-level concerns; Apple has neither.
Sources: [OECD Frascati](https://www.oecd.org/content/dam/oecd/en/publications/reports/2015/10/frascati-manual-2015_g1g57dcb/9789264239012-en.pdf),
[UNESCO ISCED-F](https://www.uis.unesco.org/sites/default/files/medias/fichiers/2025/04/international-standard-classification-of-education-fields-of-education-and-training-2013-detailed-field-descriptions-2015-en.pdf),
[ANZSRC 2020](https://www.abs.gov.au/statistics/classifications/australian-and-new-zealand-standard-research-classification-anzsrc/latest-release),
[CIP 2020](https://nces.ed.gov/ipeds/cipcode/Files/2020_CIP_Introduction.pdf),
[Oxford divisions](https://www.ox.ac.uk/research/divisions).

**Not completed:** Spotify and YouTube category sets, and Wikipedia's Main Topic
Classifications, were not verified in time. Neither would change the node set — the food
split is corroborated twice over — so they are recorded as an open thread, not a blocker.

### 4.3 What the recommender and HCI literature says about size and shape

This is the evidence for *how many* and *how deep*, and it happens to validate three
choices this repo already made — plus retire one worry I had written into an earlier draft
of §5.6.

**Depth hurts; breadth does not.** Larson & Czerwinski, CHI '98, pp. 25–32
([DOI 10.1145/274644.274649](https://dl.acm.org/doi/10.1145/274644.274649)) tested 512
targets in 8×8×8, 16×32 and 32×16 hierarchies: **8×8×8 was reliably the slowest and left
users most lost**, 16×32 fastest. Silla & Freitas's hierarchical-classification survey
(*DMKD* 22(1–2), 31–72, [DOI](https://doi.org/10.1007/s10618-010-0175-9)) names the
mechanism on the machine side — the **"blocking" problem**, where a top-down error at a
high level cannot be recovered below. Both point the same way: **the two-level cap in
ADR-0003 is right, and 41 branches wide is not the problem it looks like.**

**"7±2" does not apply to menus.** Miller (1956) measured span of absolute judgment for
unidimensional stimuli. Larson & Czerwinski's own retrospective disclaims the transfer
("*When picking between web links subject's short-term memory does not appear to be an
important factor*"), and Nielsen is blunter still — a menu "*relies on recognition rather
than recall*", and over-short menus force **abstract, obscure labels**
([NN/g](https://www.nngroup.com/articles/short-term-memory-and-web-usability/)). Hick's
Law is logarithmic anyway.

**Choice overload is close to a non-effect here.** Scheibehenne, Greifeneder & Todd,
*JCR* 37(3), 409–425 ([DOI](https://doi.org/10.1086/651235)) meta-analysed 63 conditions /
50 experiments / N=5,036: **mean D = 0.02, 95% CI [−0.09, 0.12]**. The one robust
moderator is decisive for us — overload needs "*lack of familiarity with, or prior
preferences for, the items*", while "*decision makers with strong prior preferences or
expertise benefit from having more options*". **An interest picker asks exclusively about
self-known preferences.** (Contested: Chernev et al., *JCP* 25(2), 333–358, find non-zero
effects under moderators. Nobody defends a flat limit of 7.)

**Our label density is in the healthy regime.** The Extreme Classification Repository's
two granularities of the same Amazon catalogue: AmazonCat-13K has **448.57 training
points per label**; Amazon-670K has **3.99**. Foray at 194 nodes over 19,787 shows and
24,795 topic assignments is **127.8 assignments per node** — same order as the dense
dataset, ~32× the few-shot one. Adding 45 nodes did not push us near the sparse regime.
This is the number to re-check before any future expansion.

**The 30% exploration floor specifically requires a hierarchy.** Ziegler, McNee, Konstan
& Lausen, "Improving Recommendation Lists Through Topic Diversification," WWW '05, 22–32
([PDF](https://files.grouplens.org/papers/ziegler-www05.pdf)) diversify against a
*taxonomy* and find their best result at **F = 0.3** — the same figure as Foray's
exploration floor, arrived at independently. Two findings bind directly on this review:

> "the structure of these taxonomies **severely affects the taxonomy-based similarity
> measure c, which lies at the very heart of the topic diversification** algorithm."

> "The issue is effectively **inherent to the taxonomy's structure, which has been
> designed with browsing tasks and ease of searching rather than with interest profile
> generation in mind.**"

The second sentence is a precise description of what importing Apple's tree wholesale
would do to us. And the first is the argument against PodcastIndex's flat list: a flat
vocabulary can only say "same category" or "different category", which is not enough
resolution to steer a 30% budget — it cannot express that astrophysics is nearer to
chemistry than to stand-up. **The parent/child structure is what makes the Stretch slot's
bridge computable.**

**Format belongs on a second axis — and the standards bodies agree.** The Library of
Congress split genre/form from subject in 2007 with LCGFT, on the principle of "what a
resource *is*, rather than what it is *about*"; Dewey has had standard subdivisions since
1876. IAB went the other way and then reversed: **v3.0 deleted v2.2's facet roots**
(`Content Media Format`, `Content Type`, `Content Channel`, …) and shrank the taxonomy
**from 1,196 nodes to 703 — 41% smaller, not larger**. Foray's
`episode_attributes.format` already implements the LCGFT principle, which is why §4.1's
criticism of Apple's format-genres is a criticism and not a gap in our own design. It
also means **exploration must be computed on the subject axis only** — a
Documentary → Personal Journals hop would otherwise score as exploration while being a
pure format swap.

*Caveat, stated because it is load-bearing: no published study varies the number of
top-level interests at cold start and measures downstream recommendation quality. The
menu-navigation numbers above are transferred from "find a known target" tasks, which may
not share an optimum with "express who I am." Some citations here were verified from
abstracts and author retrospectives rather than paywalled proceedings; treat the Larson &
Czerwinski condition-level detail as secondary until someone pulls the ACM PDF.*

### 4.4 The decision on `apple_anchor`

**Keep the field, demote its status: it is now an optional interop hint, not the
skeleton.** Reasoning:

- Removing it is a breaking schema change (`backend/src/types/taxonomy.ts` pins
  `version: z.literal(1)`; `dataSchemaCompliance.test.ts` validates the live file) for no
  functional gain.
- It genuinely pays for itself: it lets ingestion pre-filter candidate feeds against
  iTunes/PodcastIndex *before* any LLM classification runs, which is a real cost lever
  under `01_PROMPT.md` #8.
- But requiring it, as ADR-0003 does, forces every node to be expressible in Apple's
  vocabulary — which is exactly the skew we were told to remove.

So: `null` now **means something**. It records a domain Apple cannot express, and the
`notes` field in `data/taxonomy.json` says so. After this change **19 nodes remain null**,
and every one is a genuine gap rather than an oversight: `architecture{,/infrastructure}`,
`espionage{,/cold-war-tech}`, `linguistics{,/language}`, `cities{,/urbanism}`,
`transport{,/maritime,/trains}`, `paranormal{,/ghosts-hauntings,/cryptids-folklore,
/conspiracies}`, `music/{jazz,hip-hop,pop-global}`, and `sports/combat-sports`.

That list is itself the argument: **Apple has no way to say "jazz", "hip-hop", "boxing",
"urbanism", or "linguistics"** — five things any general knowledge scheme has had a place
for since the nineteenth century.

## 5. The node set as shipped

**Additive only. No node was renamed, removed, or re-parented.** 149 → **194 nodes**
(41 branches unchanged, 108 → 153 children). Two supporting changes: 55 previously-null
`apple_anchor` values were backfilled with the exact Apple strings from
`curation-practices.md`'s table, and `notes` was rewritten to state the id-stability
contract and the new `apple_anchor` policy.

Every new node is a **child of an existing branch**. That is deliberate and load-bearing:
`backend/test/personas.test.ts:67-73` asserts "the generalist persona covers every
top-level taxonomy node," so a single new branch would have failed CI until
`data/personas.json` was edited in lockstep. Zero new branches means zero blast radius on
personas, onboarding chips, and the six ADR-0003-era consumers.

`weight` is 0.5 (neutral — these are catalogue capabilities, not asserted founder taste;
the interest-learning loop moves them). `confidence` is 0.4 where the node is backed by
counted shows in `breadth-classification.json`, 0.3 where the topic is named in
`top-topics.json` but has zero measured supply today. `last_evidence_at` is 2026-08-15.

### 5.1 Food — the branch the brief asked for (6 new)

Grounded in what the 383 food-tagged shows actually are, by keyword theme over their
titles, blurbs and classifier rationales:

| id | label | apple_anchor | Evidence |
|---|---|---|---|
| `food/grilling-bbq` | Grilling & barbecue | `Arts > Food` | 8 dedicated shows (HowToBBQRight, The BBQ Central Show, The Black Smoke Barbecue Podcast, This Week In Barbecue); `bbq-grilling` is a **tier-2** topic in `top-topics.json`; `search-engine.js:39` already ships a `bbq → barbecue, grill` alias and `tools/test-search.mjs:169` pins a "how bbq works" query |
| `food/food-history` | Food history & foodways | `Arts > Food` | 8 shows (THE HISTORY OF FOOD, The British Food History Podcast, Food Non-Fiction, Biscuits & Jam) |
| `food/drinks` | Coffee, tea & drinks | `Arts > Food` | **47 shows** — the largest food sub-theme (WhiskyCast, Basic Brewing Radio, Wine for Normal People). Absorbs the `coffee` no-node topic and un-strands `wine-cocktails`, which was mis-filed on `food/cooking-science` |
| `food/baking` | Baking & pastry | `Arts > Food` | 10 shows (Pastry Arts Podcast, The Crumb, Breaking Bread with Tom Papa) |
| `food/restaurants-chefs` | Restaurants & chefs | `Arts > Food` | 18 shows (Andrew Talks to Chefs, The Kitchen Counter, Deep South Dining) |
| `food/cuisines` | World cuisines | `Arts > Food` | 7 shows (The Splendid Table, Gola: Italian Food & Beverage Culture) |

`food/cooking-science` and `food/fermentation` are unchanged, ids intact. `food` itself
gained its missing `Arts > Food` anchor.

**Note the 50 nutrition-flavoured shows** in that pool are *not* getting a food child —
`health/nutrition` already exists and is the right home. Multi-label handles the overlap.

### 5.2 Where grilling and barbecue belong, and why

**Primary node: `food/grilling-bbq`. The history-of-grilling Foray should be tagged
`["food/grilling-bbq", "food/food-history", "food/cuisines"]`, in that order.**

The reasoning, which generalises to every "history of X" item:

1. **Tag the subject, not the treatment.** A history of grilling is *about barbecue*;
   history is the angle. Filing it primarily under `history` would mean a listener who
   turned up "Grilling & barbecue" never sees it, while a listener who likes ancient
   military history gets served barbecue. The subject is what the interest slider is for.
2. **The angle is still a real tag, second.** `food/food-history` exists precisely so the
   historical framing is expressible without stealing the primary slot; `topics[]` is
   multi-label by design (`03_CURATION_SPEC.md`).
3. **"World barbecue traditions" is the third tag.** `food/cuisines` carries the
   comparative/regional dimension.
4. **Format and depth are not taxonomy.** If it is narrative and substantial, that is
   `format: "narrative"` and `depth: "high"` in `episode_attributes` — not a node.
5. **`history/technology` is a defensible fourth** if the Foray leans on fire, fuel and
   smoker engineering. Optional; don't pad.

To be explicit about the blocker question: **nothing was hard-blocked before this change**
— a segment tagged `food/cooking-science` would have passed `merge-segments.mjs`. But it
would have been *wrong*, and it would have landed the Foray in a node about the chemistry
of cooking, where no barbecue listener would find it. `food/grilling-bbq` now exists, so
tag it correctly.

### 5.3 The six stranded branches get children (18 new)

This is the §3.1 fix — each of these makes a previously-unreachable branch appear in the
Interests UI.

| Branch | New children |
|---|---|
| `true-crime` (245 shows / 67 eps) | `investigative`, `cold-cases`, `justice-forensics`, `fraud-cults` — grounded in Criminal/Casefile/In The Dark (reported), Missing/The Vanished/Up and Vanished/The Trail Went Cold (cold cases), Court Junkie/FBI Case File Review, and the report's own `serial-killers`/`cults`/`wrongful-convictions-forensics`/`financial-fraud-scams` topics |
| `hobbies` (281) | `collecting`, `gardening`, `outdoors`, `genealogy` — The Coin Show/a ModelersLife, GardenFork/The Beekeeper's Corner, Gun Talk, The Genealogy Guys. `gardening` also clears a priority-2 topic with 18 curated episodes and 199 breadth shows |
| `relationships` (244 / 37) | `dating`, `marriage-partnership`, `intimacy` — Second Date Update, Save The Marriage/Focus on the Family Marriage, Savage Lovecast/Multiamory |
| `travel` (209) | `destinations`, `theme-parks`, `outdoors-parks` — Rick Steves/Amateur Traveler; the theme-park cluster is unusually large (WDW News Today, Be Our Guest, MouseChat, Unofficial Universal Orlando, Coaster Radio) |
| `personal-journals` (230 / 53) | `narrative-storytelling`, `oral-history` — This American Life/Love and Radio/STORIES by Lea Thau; Witness History/Desert Island Discs |
| `paranormal` (15 / 23) | `ghosts-hauntings`, `cryptids-folklore`, `conspiracies` |

### 5.4 The thirteen no-node topics (11 new nodes, all under existing branches)

`sports/combat-sports` (MMA/UFC **and** boxing — Apple has 15 sport subcategories and
neither), `health/meditation`, `economics/crypto`, `music/jazz`, `music/hip-hop`,
`music/pop-global`, `society/immigration-diaspora`, `society/lgbtq`,
`computing/cybersecurity`, `gaming/esports`, `gaming/tabletop`. The thirteenth, `coffee`,
is covered by `food/drinks` above.

### 5.5 Broken-shape branches get general children (10 new)

Targeting §3.2's dumping grounds: `music/music-history`,
`computing/{software-engineering,internet-culture}`, `gaming/game-history`,
`space/astronomy`, `automotive/ev-future` (clears the `electric-vehicles` priority-2
topic, 15 curated episodes), `aviation/flight-history`, `philosophy/ethics`,
`history/social-history`.

### 5.6 Is 194 too many?

The product principle is that "a category set that collapses everything into 5 buckets
defeats [the ~30% exploration floor], and one with 400 leaves is unusable." 194 nodes =
41 branches × ~3.7 children. For comparison, Apple ships ~106 leaves under 19 top-level
categories and PodcastIndex mirrors it.

**The count itself is defensible on the evidence in §4.3**: depth is what hurts
navigation, not breadth; "7±2" does not apply to recognition menus; choice overload is a
~zero effect for self-known preferences; and 127.8 assignments per node keeps us in the
data-dense classification regime. Google's NL taxonomy ships 1,092 nodes and IAB 3.0
ships 703, both far larger.

**One honest caveat, narrowed:** `app.js` renders *all 153 children* as interest sliders
in a single flat list. Per §4.3 the objection is **not** "too many options" — it is that
a flat list discards the parent/child structure at exactly the moment the user is
expressing taste, which is the structure Ziegler et al. show the diversification maths
depends on. The fix is progressive disclosure (branch first, expand for children), an
`app.js` change this PR does not make. Called out in the PR body as follow-up, not armed
as a self-check-in.

## 6. Migration notes

**Every id is stable. Nothing was renamed, removed, or re-parented, so nothing orphans.**
That was the design constraint, chosen after mapping the consumers below — the cost of a
rename here is high enough that "additive only" was worth some inelegance.

Checked for references before changing anything; all clean after the change:

| Reference | Count | Gate | Status |
|---|---:|---|---|
| `data/discover.json` topics | 1,480 items, 89 distinct nodes | `ci.yml:62-66` hard fail | ok |
| `data/session.json` episode topics | — | `ci.yml:62-66` | ok |
| `data/segments.json` topics | **0 (file is empty)** | `merge-segments.mjs:581` `--check` | ok |
| `data/personas.json` | 72 weight refs / 41 nodes | `personas.test.ts` | ok — refs are all top-level, none touched |
| `data/genre-taxonomy-map.json` | 101 distinct node ids | silent drop → **now a hard fail**, see §7 | ok |
| `data/semantic-index.json` | 71 distinct topic ids | `validate-semantic-index.mjs:65` | ok |
| `data/ladders.json` | `engineering/energy-fusion` | `ladderIntegrity.test.ts:45` | ok — node retained |
| `data/breadth-classification.json` | 19,787 entries, 143 nodes | regenerated downstream | ok |
| iOS fixtures | `comedy/casual-hangs` | `SessionModelsTests.swift:113` | ok |

**What a future rename would break** (recorded so the next session does not have to
re-derive it): `ci.yml:62-66`, `merge-segments.mjs:286-290` and `:581`,
`validate-semantic-index.mjs:65`, `personas.test.ts:56`, `ladderIntegrity.test.ts:45`,
`poolIntegrity.test.ts:47` all hard-fail. `classify-breadth.mjs:30` and
`app.js:171-175` (orphaned localStorage sliders) fail *silently* — the first of those is
fixed in §7. Adding a **top-level branch** additionally fails
`personas.test.ts:67-73`.

**Stale artefacts noticed, not touched:** `classify-shows.mjs` and `classify-shard-0.mjs`
at the repo root hardcode dozens of node ids and absolute Linux paths
(`/home/user/foray/...`); they are unrunnable on any current checkout. Deleting them is
out of scope here — flagged in the PR body.

## 7. What the classifier fleet needed, and what changed

Three fleet changes ship with this review.

**1. `docs/agents/runner-prompts/classify-batch.md` — the specificity rule.**
The prompt loads `data/taxonomy.json` at runtime (step 2), so the 45 new nodes are picked
up with no prompt edit at all. But new nodes alone would not have fixed §3.2: the fleet
produced 374 bare-`food` classifications *because nothing told it to prefer a child*. Two
rules added to the multi-label section: prefer the most specific supported node and emit
its parent alongside it (so branch-level matching keeps working while the child makes the
slider fire), and never invent a node to get more specific — `merge-results.mjs` rejects
the entire show on an unknown id, so a guessed node costs more than a coarse one.

**2. `tools/classify-breadth.mjs` — silent drop is now a hard failure.**
Line 30 filtered genre-map topics through the taxonomy and discarded misses without a
word; combined with `if (!topics.size) continue`, a stale map could silently
un-classify thousands of shows, and the existing `UNMAPPED GENRES` warning does not cover
that case (it only fires for genres absent from the map). Stale topics are now collected
and the script exits non-zero naming them.

**3. `backend/test/dataSchemaCompliance.test.ts` — structural invariants.**
Six new assertions on the live file: unique ids; exactly two levels (every parent exists
and is itself top-level); child ids namespaced `<parent>/<leaf>` (the `split("/")`
convention that `topic-coverage-report.mjs:46` and `tools/transcribe/fetch-audio.mjs:166`
depend on); labels non-empty and unique within a branch; a food branch with
`food/grilling-bbq` and `food/food-history`; and — the regression guard that matters —
**every top-level branch has at least one child**, which is the §3.1 defect encoded so it
cannot come back.

**Deliberately NOT changed:**

- `tools/classify/merge-results.mjs` — its validation is already correct; new nodes are
  accepted automatically.
- `tools/classify/prepare-batch.mjs` — only writes a *pointer* to the taxonomy path.
- `data/genre-taxonomy-map.json` — all 110 entries still resolve. It is tempting to route
  Apple's `Food` genre to the new children, but a genre label cannot tell you whether a
  food show is about baking or barbecue; that is precisely the per-show judgement the
  Tier-1 LLM pass exists for. Leaving the coarse prior coarse is correct.
- `docs/agents/runner-prompts/foray-nightly.md` — no taxonomy references.
- `backend/src/enrich/StubEnricher.ts` `FALLBACK_TOPICS` — stale (9 seed ids) but only
  used in keyless dry-run; noted in the PR body.

## 8. Items left to a founder

### 8.1 ADR-0003 needs a one-line amendment

ADR-0003 states "Every node anchors to a standard Apple Podcasts category." §4.4 changes
that in practice to "may anchor; null records a gap Apple cannot express." **This PR does
not edit the ADR**, deliberately: `docs/adr/` is on the auto-merge DENIED list in
`.github/workflows/automerge-nightly.yml`, so amending it here would block the whole
change behind a human review — and quietly rewriting a governance document inside an
auto-merging PR is exactly what that denylist exists to prevent. The amendment should be
a separate, human-reviewed PR. Flagged rather than done.

The same applies to `docs/curation/personalization-and-depth-plan.md` §5's "node
additions get an ADR" rule. This change added 45 nodes under a direct CTO instruction to
act rather than propose; that instruction overrides the standing rule for this change
only, and the rule itself is worth keeping.

### 8.2 The back-catalogue is not re-classified

**`data/breadth-classification.json` is not re-classified against the new nodes.** All
19,787 shows keep the topics they were assigned before this change, so the 374 shows on
bare `food` stay on bare `food` until the classification fleet next runs over them. The
new nodes are live and usable immediately for curation and for the grilling Foray; what
lags is the *back-catalogue*.

This is left as a founder call rather than done here because re-running Tier-1
classification over the affected branches costs real LLM budget and the routine is a
cron-driven Max-plan agent (ADR-0006) — an interactive session forcing a full re-run is a
spend decision, which CLAUDE.md reserves to the founders. The cheap partial alternative is
to re-run `node tools/classify-breadth.mjs` (deterministic, keyless, $0), but that only
re-applies the coarse genre map and would not populate the new children either.

Recommendation: let the existing hourly classify cron pick the new nodes up naturally on
its normal sweep, and re-run `tools/topic-coverage-report.mjs` afterwards to re-measure
§3.2's ratios. No action needed today.

## 9. Sources

- `docs/brief/03_CURATION_SPEC.md` — interest model, 4-slot menu, ≥3 distinct branches
- `docs/adr/0003-taxonomy-representation.md` — hierarchical + centroid decision
- `docs/research/curation-practices.md` — Apple's 19/106 category table; depth-as-attribute
- `docs/research/genre-map-notes.md` — the 110-genre mapping and its judgement calls
- `docs/marketing/10-category-coverage.md` — modeled US listening-hours by category
- `docs/curation/personalization-and-depth-plan.md` §5 — the one-taxonomy invariant
- `data/topic-coverage-report.json` — 155 topics, priority buckets, 13 no-node
- `data/breadth-classification.json`, `data/discover.json` — the counts in §3

The searchable research corpus (`tools/corpus/corpus.mjs`) could not be queried in this
session: the DB lives in gitignored `data-local/` and exists only on the machine that
built it. `docs/research/corpus/digests.md` was read instead, per CLAUDE.md; it carries
one directly relevant finding — Spotify's TREC podcast-summarization entry conditioned on
**22 collapsed iTunes/RSS genre labels** and beat its baseline by 9% on human grading,
which is evidence that coarse genre labels are useful *conditioning signal* even where
they are poor *interest* categories. That is the split this review preserves:
`apple_anchor` for machine interop, our own tree for what the user actually sees.
