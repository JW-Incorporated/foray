# Search coverage gaps — top topics vs. catalogue vs. semantic index

What a general Foray user actually searches for (`data/top-topics.json`, 155
topics) cross-referenced against the curated catalogue (`discover.json` +
`item-tags.json`), the compiled search layer (`semantic-index.json`), and the
already-harvested breadth tier (`breadth-classification.json`). Full per-topic
numbers live in the generated `data/topic-coverage-report.json` (machine-
readable — the sibling agent improving search should consume that directly
rather than re-deriving it). This doc is the prioritized, human-readable read
of the same data.

**Starting point, not gospel.** Same caveat as `data/personas.json` and
`persona-catalogue-fit.md`: the topic list and tiering are a data-grounded
first pass for Joey to sanity-check, not a final ranked taxonomy.

**Method, in one line:** deterministic cross-reference that mirrors app.js's
real query matching (word-boundary/substring rules copied from
`interpretQuery`/`scoreMatch`) — see `tools/topic-coverage-report.mjs`. No
LLM. Known noise: `engineering/energy-fusion` counts are inflated by issue
#12's 46 mistagged items (not fixed here); the tiny app.js `ALIASES` table
(bbq/cooking/rome/ww2/plane/car/ocean) isn't replicated, so a handful of
tag/text counts slightly underestimate real search recall.

## Headline finding: most gaps are a promotion problem, not a sourcing problem

**19,787 US shows (+121,786 international) are already harvested, chart-
ranked, and genre-mapped to our taxonomy in `data/catalog-breadth.json` /
`data/breadth-classification.json` — and almost none of it has been promoted
into the curated tier (`discover.json`) that the app and search actually
serve.** For most of the biggest gaps below, the fix is **not** "go find
content" — it's "run the existing agent-wave curation process
(`docs/CATALOG-PIPELINE.md`) against shows we've already ranked and
classified." That's a content-review job, not a discovery job, and it's an
order of magnitude cheaper.

The gap is stark for exactly the genres market data says matter most:

| Topic | Curated-tier items today | Breadth-tier supply (already harvested) |
|---|---:|---:|
| **News** (general) | 0 | 1,210 |
| **TV & film** (general) | 8 | 1,499 |
| **True crime** | 40 | 214 |
| **Computing & software** | 9 | 328 |
| **Comedy itself is fine (99 items) — but adjacent genres aren't:** | | |
| Movie & TV reviews | 8 | 400 |
| Fitness & workouts | 3 | 464 |
| Video games | 9 | 376 |
| Politics | 0 | 210 |
| Tech news | 0 | 217 |
| Every individual sports league (NFL, NBA, MLB, NHL, soccer) | **0 each** | ~200 each |
| Christianity / Spirituality / Judaism | 0 each | 276 / 209 / 206 |
| Language learning | 0 | 207 |
| Physics | 0 | 202 |

64 of the 155 top topics carry a `promote-from-breadth` recommendation.
**Recommended action:** feed `docs/CATALOG-PIPELINE.md`'s agent-wave process a
priority queue drawn from `breadth-classification.json`, ordered by
`chart_rank` within each of these thin/absent nodes, starting with the table
above — this is the single highest-leverage lever available and doesn't
require new discovery work. This is a content-sourcing decision for Joey/the
nightly pipeline, not something this slice implements.

*Caveat:* breadth-tier records are show-level only (no episodes, no hooks,
no tags — see the pipeline doc's two-tier design) — promotion still costs a
real editorial pass per show, it's just starting from "which 30 shows should
we look at" instead of "search the internet for true-crime shows."

## Second headline finding: the search layer misroutes real content it already has

Independent of catalogue depth, `tools/topic-coverage-report.mjs` scans every
concept in `semantic-index.json` for cases where a concept's own `terms`
clearly name a taxonomy node/branch that its `topics` field does **not**
point at. **8 concepts are flagged** (`data/topic-coverage-report.json` →
`concept_misroutes`) — a systemic authoring pattern, not a one-off:

| Concept | Terms imply | `topics` actually says |
|---|---|---|
| `storytelling` | has the literal term `"true-crime"` | `history/military-ancient`, `history/technology` — **not `true-crime`** |
| `space` | rockets, spacex, mars, moon, astronauts, launch | `business/startups` — **not `space/rockets`** |
| `economics` | economics, markets, stocks, investing | `business/startups` — **not `economics/markets`** |
| `cars` | automotive, ferrari, racing, motorsport | `business/startups` — **not `automotive/racing`** |
| `computing` | computing, software, programming, code | **`[]` — empty, no boost at all** |
| `medicine` | includes the term `"health"` | `medicine/biology` only — **no `health/*` node** |
| `infrastructure` | includes the term `"cities"` | `architecture/infrastructure` only — **no `cities/urbanism`** |
| `philosophy` | includes `"religion"`, `"christianity"`, `"buddhism"` | `philosophy/ideas` only — **no `religion/*` node** |

Notably, **3 of the 8** (`space`, `economics`, `cars`) wrongly route to
`business/startups` specifically —
this reads like several concepts were seeded from an example episode that
happened to also be tagged `business/startups` (e.g. a SpaceX or Ferrari
interview catalogued as a business story) without the concept's `topics`
field being generalized back to the concept's actual subject. That's a
one-line fix per concept, high leverage: **true crime, space, economics,
automotive, computing, health, cities, and religion searches are all quietly
degraded today even though real content exists for most of them** (true
crime alone has 40 curated items completely missed by concept-level search
boosting).

**Two more empty-topics concepts the automated scan can't catch** (the
heuristic only flags a term that *exactly* matches an existing taxonomy node
id, and no node is literally named `ai` or `data-centers`) — found manually
while researching this doc, worth fixing in the same pass:

- `ai` — terms include `ai`, `artificial-intelligence`, `chatgpt`,
  `machine-learning`, `llm`; **`topics: []`**. (Partially masked in practice —
  a related concept, `llms`, correctly routes to `engineering/ai-robotics`
  and the query still "works," just with less boost than intended.)
- `data-centers` — terms include `data-center`, `cloud`, `inference`,
  `servers`; **`topics: []`**, no rescuing related concept.

**Recommended action:** the sibling agent improving search should treat
`data/topic-coverage-report.json`'s `concept_misroutes` array as its punch
list — it's already the exact diff needed (`concept: current_topics` →
what it should be), plus the true-crime case gets its own concept rather
than being smuggled inside `storytelling` (which legitimately serves
history/narrative content and shouldn't lose that role).

## Priority-1 list (tier-1 topic, real catalogue content, broken discovery)

The cheapest, highest-leverage fixes — real content sitting behind a broken
or missing semantic concept:

| Topic | Catalogue items | Status |
|---|---:|---|
| True crime | 40 | misrouted (see above) |
| Society & culture | 50 | missing — no concept at all |
| Health & fitness | 50 | misrouted (`medicine`/`longevity` concepts don't route to `health/*`) |
| Mental health | 32 | misrouted |
| World War II | 22 | misrouted |
| TV & film | 8 | misrouted |
| Self-improvement | 14 | misrouted (`philosophy` concept doesn't route to `education/self-improvement`) |
| Parenting | 10 | missing — no concept at all |

## Full breakdown

Of the 155 evaluated topics (`data/topic-coverage-report.json` →
`summary.by_priority`):

- **8 priority-1** — fix search now (above).
- **58 priority-2 / 26 priority-3** — a search fix and/or breadth-tier
  promotion closes the gap; see the headline table and the `recommended_actions`
  field per topic in the report.
- **24 priority-4** — either a re-tagging pass over items already in the
  catalogue (11 topics — e.g. Archaeology, Sports science, Aviation, where
  items exist but are tagged with adjacent words, not the query term itself;
  4 more topics need re-tagging *and* a search fix, so they already surface
  at priority 2), or genuinely **no taxonomy node exists** (13 topics — see
  below).
- **39 priority-6** — already well served: Comedy, Business, Startups,
  History, Science, AI, Investing, Ancient Rome & Greece, Nature, Engineering,
  Psychology, and others where the founder's original tuning happens to
  overlap general-audience demand.

### Needs a taxonomy ADR (no node fits — not created here)

Per `personalization-and-depth-plan.md` §5, taxonomy node additions require
governance, so these are flagged, not invented: MMA/UFC, combat sports
(boxing), esports, board games/tabletop, jazz, hip-hop/rap, K-pop, coffee,
cryptocurrency, cybersecurity, meditation/mindfulness, immigrant/diaspora
stories, LGBTQ+ stories & culture. Several of these (MMA/UFC, jazz, crypto)
are real, frequent query terms in the general podcast market and worth an ADR
discussion; others (K-pop, board games) are lower-tier long-tail.

### Genuinely low-priority (no lever today)

None landed here in this pass — every absent/thin topic had either real
breadth-tier supply, a search fix, or a retag opportunity. That's itself a
useful signal: the catalogue's *breadth problem* is almost entirely solved by
promoting already-harvested shows, not by net-new discovery.

## How to use this

- **Nightly/Joey content-sourcing lane:** treat the headline promotion table
  as the next agent-wave queue, drawing candidate shows from
  `breadth-classification.json` ordered by `chart_rank`.
- **Sibling search-engine agent:** `data/topic-coverage-report.json` →
  `concept_misroutes` is the concept-fix punch list; `topics[].semantic_status
  === "missing"` topics with real `catalog_count` (Society & Culture,
  Parenting, and others at priority 1-3) need a new concept, not just a
  reroute.
- **Taxonomy governance (founders):** the needs-ADR list above is a candidate
  slate for the next taxonomy review, prioritized by how often the term
  showed up in market research vs. how well `taxonomy_nodes: []` items are
  currently served by nothing.

## Open questions

1. Tiering in `data/top-topics.json` is reasoned from general podcast-market
   knowledge (Apple's own genre tree + Edison Research genre-share data), not
   Foray's own search logs (none exist yet) — Joey should sanity-check before
   it drives sourcing priority.
2. Should `true-crime`, `news`, `sports`, and other flat top-level nodes grow
   subnodes (the way `sports` already has 13 league subnodes with zero
   items) before or after the breadth-promotion pass fills them? Sequencing
   affects which items land where.
3. Whether MMA/UFC and jazz specifically justify new taxonomy nodes now vs.
   staying tag-only is a founder call — both showed real query-pattern
   evidence in this research.
