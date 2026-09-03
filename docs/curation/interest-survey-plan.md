# Asking about topics, not shows — the interest survey plan

How Foray should gather a listener's **interests** — "true crime", "engineering" —
rather than their opinion of specific shows, and how that asking reconciles with
the cataloguing system already in the repo.

Commissioned by Wyatt (CTO), verbatim:

> "when we survey people what they are interested in, that survey should not be
> about specific shows, we should be trying to gauge their interests. I would
> expect to be asked questions about categories, like 'true crime',
> 'engineering', etc. make a detailed plan how to improve here, including
> reconciling this surveying with how our current cataloguing system works."

Companion to `docs/curation/personalization-and-depth-plan.md` (§2a, §3a, §5 —
which already spec'd most of this), `docs/curation/persona-set-v1.md`,
`docs/research/taxonomy-review-2026-08.md`, and `docs/brief/03_CURATION_SPEC.md`.

**This is a plan, not an implementation.** No code changed. It carries the `hold`
label deliberately so it cannot auto-merge before the founders rule on §8.

---

## 0. The verdict up front

**The taxonomy is not the problem.** `data/taxonomy.json` already is a topical
category tree, and Wyatt's two examples are literally node ids in it:
`true-crime` (label "True Crime") and `engineering` (label "Engineering"). 41
top-level branches, 153 children, two levels, no deeper. No restructuring is
needed to survey on it. That is the headline, and it is measured, not inferred.

**Four things are the problem, in descending order of how much they cost us:**

1. **Nothing asks anything.** The one first-run screen we ship
   (`app.js:showFirstTimeExplainerOnce`) states the opposite of Wyatt's ask, in
   shipped copy: *"There's no interview."*
2. **The cold-start interest model is flat, so the first menu is close to
   random.** Measured below: 29 of the 38 branches present in `data/discover.json`
   tie at *exactly* 0.5000 on a fresh install, the entire spread across all
   branches is 0.155, and `buildCards()`'s tie-break jitter is ±0.25 — **1.6× the
   whole spread.** The four home cards a new listener sees are, for practical
   purposes, four random branches.
3. **A survey answer has nowhere to be stored.** `loadInterests()` populates
   **leaf nodes only** (`leafNodes()` filters `n.parent !== null`). There is no
   `state.interests["true-crime"]` and never can be. Writing a root id into
   `cp_interests` today is silently discarded on the next `saveInterests()`.
4. **We already designed this and never shipped it.** `personalization-and-depth-plan.md`
   §3a.2 specifies the exact screen Wyatt is asking for.
   `data/personas.json` ships six weight vectors over top-level nodes with a
   `seed_confidence` dial. `docs/marketing/09-product-feature-review.md` R14
   ranked it #2 for the web-test phase. None of it reached the client.

So the recommendation is **not** "rebuild the taxonomy". It is: **ship the
already-specified onboarding chip screen, and fix the one real structural
blocker (leaf-only interests) that stops a category answer from being
representable at all.**

---

## 1. What exists today, measured

Every number in this section was computed against the committed data in this
worktree. The commands are inline so they can be re-run.

### 1.1 The taxonomy IS a topical category tree

`data/taxonomy.json` — 194 nodes, `version: 1`.

| Property | Measured |
|---|---:|
| Total nodes | 194 |
| Top-level branches (`parent: null`) | 41 |
| Children | 153 |
| Maximum depth | 2 (no node id has more than one `/`) |

The 41 branches are subject categories, not formats: `engineering`, `science`,
`history`, `craft`, `business`, `comedy`, `architecture`, `aviation`,
`espionage`, `food`, `linguistics`, `math`, `medicine`, `music`, `nature`,
`sports`, `space`, `computing`, `economics`, `psychology`, `automotive`,
`philosophy`, `cities`, `adventure`, `gaming`, `society`, `culture`,
`transport`, `news`, `true-crime`, `religion`, `kids-family`, `fiction`,
`tv-film`, `health`, `education`, `personal-journals`, `relationships`,
`hobbies`, `travel`, `paranormal`.

Format is deliberately kept *out* of the tree and lives in
`taxonomy.json`'s `episode_attributes` instead — `format:
interview | narrative | panel | solo | documentary | hang`, plus `depth` and
`evergreen`. `docs/research/taxonomy-review-2026-08.md` §4.1 argues at length
why that separation is correct and why Apple's tree (which sorts Documentary,
Courses, After Shows and all three Music subcategories by format) is the wrong
skeleton for an interest model. **This is the one design decision that makes
category surveying viable at all, and it is already made.**

**Verdict: the existing nodes are usable as survey categories as-is, at the
top level.** They are *not* usable as-is at the child level — 59 of the 194
nodes appear nowhere in the live pool, and tagging depth varies by branch. See
§1.2 and §3.2.

### 1.2 How tags attach to content, and where the depth is uneven

Shows in `data/catalog.json` carry `taxonomy_node_ids`; pool items in
`data/discover.json` carry `topics`. Both key off the same node ids, which is
the invariant `personalization-and-depth-plan.md` §5 exists to protect.

`data/catalog.json` — 220 shows, **zero** with an empty `taxonomy_node_ids`.
Tags per show: min 1, max 2, mean 1.23 (170 shows have one tag, 50 have two).

Tagging depth is **inconsistent by branch**, and this is the fact that breaks a
naive survey mapping:

| Tagging shape | Shows | Branches |
|---|---:|---|
| Leaf-tagged only (`engineering/energy-fusion`) | 187 | most |
| Root-tagged only (bare `true-crime`) | 17 | `true-crime`, `personal-journals`, `relationships`, `paranormal` |
| Mixed | 16 | `history`, `fiction`, `psychology`, `society`, `music` |

So in the catalogue: **no show is tagged bare `engineering`, and no show is
tagged with any `true-crime/*` child.** Wyatt's two example categories fail a
naive exact-match mapping in *opposite directions*. A survey answer must
therefore expand to a **subtree** (`root` + all its descendants), never match a
single id. That is the single most important mechanical requirement in this
document.

`data/discover.json` — 1,855 items, zero with no topics, 41 branches present
(38 if counted by `branchOf()`, which reads only `topics[0]`).

### 1.3 The client's interest state

`app.js`, `cp_interests` (the `cp_` prefix is legacy and load-bearing —
renaming wipes user state; `CLAUDE.md` § Conventions).

```
app.js:367  leafNodes()      -> state.taxonomy.nodes.filter(n => n.parent !== null)
app.js:371  loadInterests()  -> for each LEAF: state.interests[id] = saved[id] ?? max(0, n.weight)
app.js:378  saveInterests()  -> lsSet("cp_interests", state.interests)
app.js:384  nudgeTopics(topics, amount) -> if (t in state.interests) clamp(v + amount, 0, 1)
app.js:531  interestScore(item) -> mean over item.topics of (state.interests[t] ?? 0.5)
app.js:527  branchOf(item)   -> item.topics[0].split("/")[0]
app.js:714  buildCards()     -> group pool by branch, rank branches by mean interestScore
```

Four consequences, all verified against the source:

1. **Root ids are unrepresentable.** `leafNodes()` has exactly one caller,
   `loadInterests()`. `state.interests` therefore never holds a key without a
   `/`. `nudgeTopics` guards on `if (t in state.interests)`, so a nudge on a
   root id is a no-op, and `saveInterests()` writes `state.interests` wholesale,
   so any root key a survey wrote into `cp_interests` is erased on the first
   save, silently.
2. **Root-tagged content is frozen at 0.5.** `interestScore` falls back to `0.5`
   for any topic not in `state.interests`. In the live pool, **232 of 1,855
   items (12.5%)** carry at least one root-level topic that contributes a
   hardcoded 0.5, and **58 items (3.1%)** are entirely made of such topics — so
   their score can never move no matter what the listener does. Worst offenders,
   as fully-frozen-items / branch-items: `true-crime` 18/89, `relationships`
   12/34, `paranormal` 7/28, `personal-journals` 7/26.
   `docs/research/taxonomy-review-2026-08.md` §3.1 identified this defect in
   August 2026 and it is still live.
3. **The prior is essentially flat.** 145 of the 153 leaf nodes sit at exactly
   `weight: 0.5`. Only 8 are higher, and only one — `engineering/energy-fusion`
   — is at 1.0 (Wyatt's own seed, per `03_CURATION_SPEC.md`).
4. **Therefore the cold-start menu is near-random.** Simulating `buildCards()`
   on a fresh install against `data/discover.json`:

   | Branch | cold-start `avgInterest` |
   |---|---:|
   | `history` | 0.6551 |
   | `engineering` | 0.6284 |
   | `comedy` | 0.5847 |
   | `business` | 0.5698 |
   | `science` | 0.5491 |
   | …9 more between 0.5017 and 0.5197 | |
   | **29 further branches** | **exactly 0.5000** |

   Full spread across all 38 branches: **0.155**. The jitter in
   `buildCards()` — `(Math.random() - 0.5) * 0.5` — is **±0.25**, and the
   recency penalty is `-0.35`. Both dwarf the signal. **Every one of the 38
   branches sits within one jitter draw of the top.**

   This is the honest, measurable answer to why the product feels like it does
   not know you: it does not, and on day one it barely tries.

### 1.4 What onboarding actually asks today: nothing

`app.js:showFirstTimeExplainerOnce()` (gated on `isGenuineFirstTimeUser()` —
no history, no saves, no playlists — *and* on `cp_intro_dismissed`) shows one
sheet with a title, three paragraphs, "Skip for now" and "Get started". Both
buttons do the same thing: set `cp_intro_dismissed` and close.

**It asks zero questions.** Its middle paragraph is shipped copy that says:

> "There's no interview. 4a learns your interests from what you play, save and
> skip — every weight can change, nothing is locked in."

That sentence is a deliberate product position — the function's own comment
says the M3 prototype's preference-interview step "has no counterpart in the
real backend … this screen does not build one." **Wyatt's ask reverses it.**
That is a founder-level copy and positioning decision, not an implementation
detail, and it is Open Question J1 in §8.

Note the irony worth stating plainly: `docs/brief/03_CURATION_SPEC.md:7` — the
original spec — says the taxonomy should be *"seeded from an onboarding
interview."* The product shipped a screen saying there isn't one. Wyatt is
asking for the original design back.

### 1.5 R14: never shipped

`docs/marketing/09-product-feature-review.md` R14 specifies "skippable
taxonomy-chip interest seeding into `cp_interests`", instrumented with
`onboarding_seen` and `interests_seeded`, and ranks it #2 of the web-test
actions.

**Status: partly shipped — the explainer card only.** Searching the whole
repo for `onboarding_seen` and `interests_seeded` returns hits in that
marketing document and **nowhere else**. No chip UI, no seeding, no events.
The explainer sheet exists but is not instrumented either. R14's third item
(the wildcard label) *did* ship, as the `.mc-stretch` badge
(`docs/DECISIONS.md`, 2026-07-30).

### 1.6 The backend side is real, designed, and all but inert

`data/personas.json` already contains **exactly the answer space a survey
needs**: six personas, each a weight vector over **top-level** nodes, each with
a `seed_confidence`.

| Persona | Primary | `seed_confidence` | Weights |
|---|---|---:|---:|
| `curious-engineer-maker` | `engineering` 0.9 | 0.35 | 8 |
| `history-and-ideas` | `history` 0.9 | 0.35 | 6 |
| `health-and-performance` | `health` 0.9 | 0.35 | 6 |
| `true-crime-and-story` | `true-crime` 1.0 | 0.35 | 6 |
| `comedy-and-culture` | `comedy` 0.9 | 0.35 | 5 |
| `generalist` (default) | — (all 0.25) | 0.15 | 41 |

`seed_confidence` is precisely the "declared input yields to observed signal"
dial this plan needs, and it already exists as versioned data reviewed like
content (`personalization-and-depth-plan.md` §5.2). `persona-set-v1.md` records
Joey's rationale, the Edison *Infinite Dial 2026* reach numbers behind it, and
the deliberate choice to weight True Crime to the 1.0 ceiling.

The consumer is `backend/src/curation/userInterests.ts`.
`resolveEffectiveTaxonomy()` (`userInterests.ts:59-82`) is a strict three-tier
**override cascade**, not a blend — real user row wins outright, else persona
weight, else the global node passes through unchanged. Two details in it matter
enormously to this plan:

- **The backend already does subtree expansion.** `userInterests.ts:73`:
  `personaByNode.get(node.id) ?? personaByNode.get(topLevelOf(node.id))` —
  a child node with no persona entry inherits its root's weight, via
  `topLevelOf()` (`userInterests.ts:40-42`), a single `id.split("/")[0]`. §4.1's
  client-side expansion is the mirror of a rule that already exists server-side.
- **`UserTaxonomyRow.source` already includes `"onboarding-interview"`**
  (`userInterests.ts:17-22`), and `interestLearning.ts`'s `InterestReason` union
  already includes `"onboarding"`. **Nothing produces either value.** The data
  model has been waiting for this survey since July.

The Postgres-backed `createUserInterestsProvider` is **gated on `DATABASE_URL`**
— `docs/DECISIONS.md` 2026-07-30 ("subject-card selection: real exploration
floor, not a live backend") records the decision and its reasoning:

> "Standing up real per-user session-serving would mean provisioning/wiring the
> already-designed-but-unbuilt Postgres/Supabase `UserInterestsProvider`
> (`createUserInterestsProvider.ts`, gated on `DATABASE_URL`) behind a new
> deployed API surface — a genuine infra/secrets change. That stays outside what
> gets decided in a chat aside … it needs its own scoping pass and is Wyatt's
> call."

**Two corrections to what the repo says about this, both worth fixing:**

1. **The provider is wired, not absent.** `buildSession.ts:127` calls
   `createUserInterestsProvider()` and line 137 passes the result into
   `buildSession`. It resolves to `InMemoryUserInterestsProvider`, which returns
   `null` for the seeded user's persona, so the net effect today is a no-op —
   but the wiring is live. `docs/legal/data-safety.md:414` states
   `buildSession.ts` "passes a fixed placeholder id **and no provider**". The
   second half is **stale**, and it is in a store-submission document. Filed as
   W7 in §8.
2. **Setting `DATABASE_URL` today throws, it does not silently personalize.**
   `createUserInterestsProvider.ts:17-26` returns the in-memory provider when
   `env.databaseUrl === undefined` and otherwise **throws** ("`PostgresUserInterestsProvider`
   does not exist yet"). That is a genuine tripwire and it is better news than
   `data-safety.md:414`'s "no CSP change and no code review" warning implies.
   The warning is still right about the *direction*; it is wrong that the flip
   is silent. Both belong in the record. See §6.3.

**Critically: `data/personas.json` is never fetched by the client.** The
client's data load (`app.js`, the `Promise.all` over `fetchJson`) pulls
`validated-links`, `taxonomy`, `discover`, `semantic-index`, `item-tags`,
`forays`, `segments`, `segment-sources` and `catalog-client`. Personas are not
in that list. The best-designed asset we have for this problem is invisible to
the only client we ship.

---

## 2. The gap

| Wyatt expects | Reality |
|---|---|
| A survey that asks about categories | Nothing asks anything; shipped copy says "There's no interview" |
| Categories like "true crime", "engineering" | Both are literally node ids — the vocabulary is already right |
| Answers feed curation | No storage path exists for a category answer (leaf-only `cp_interests`) |
| Cataloguing aligned with the survey | Structurally aligned already, but **tagging depth is inconsistent**, so alignment needs subtree expansion, not exact match |

The gap is **surface and plumbing, not taxonomy.**

---

## 3. The proposed survey

### 3.1 Shape

**One screen. One question. Chips. Skippable. Shown once.**

Not a multi-question wizard. `personalization-and-depth-plan.md` §3a.2 caps
this at "20 seconds", and the principle-2 argument in §5 only holds while the
ask is a *prior-setter*, not an intake form. A second question buys much less
than it costs.

- **Where:** inside `showFirstTimeExplainerOnce()`, as a second pane after the
  existing explanation, reached by "Get started". "Skip for now" bypasses it
  entirely. Reusing that gate matters: it already carries the correct
  "genuine first-time user" test (`isGenuineFirstTimeUser()`), which is
  stricter than `cp_intro_dismissed` alone and was written precisely so an
  existing user never re-sees a first-run screen.
- **Answer space:** multi-select over **top-level taxonomy node labels**. No
  ordering, no ranking, no sliders, no free text.
- **Selection:** any number, including zero. Zero = skip = Generalist.
- **Never shown again**, on the same `cp_intro_dismissed` flag.

### 3.2 The chips — from the real taxonomy, chosen by measured pool depth

A chip must be backed by enough content to fill a queue, or it is a promise we
break on day one. **Selection rule: top-level nodes with ≥ 50 items in
`data/discover.json` (counting the node and its descendants).** That yields
**17**, and it covers all five non-default personas' primary nodes:

| Node id | Label | Pool items | Distinct shows |
|---|---|---:|---:|
| `history` | History | 243 | 26 |
| `comedy` | Comedy | 202 | 18 |
| `engineering` | Engineering | 159 | 29 |
| `business` | Business | 128 | 12 |
| `health` | Health & Fitness | 108 | 20 |
| `society` | Society | 97 | 24 |
| `science` | Science | 95 | 19 |
| `true-crime` | True Crime | 93 | 13 |
| `culture` | Culture | 87 | 21 |
| `psychology` | Psychology | 84 | 19 |
| `food` | Food | 80 | 15 |
| `craft` | Craft & making | 79 | 15 |
| `nature` | Nature | 74 | 21 |
| `medicine` | Medicine | 73 | 14 |
| `music` | Music | 65 | 13 |
| `personal-journals` | Personal Journals | 58 | 11 |
| `sports` | Sports | 51 | 8 |

**Read the second column, not the first.** `business` has 128 items from only
**12 shows**; `sports` 51 from **8**. Item count overstates depth, because one
prolific feed contributes dozens of items. A chip backed by a handful of feeds
will feel repetitive within a week. `economics` (47 items, **5 shows**) and
`cities` (30 items, **3 shows**) are below the line for exactly this reason.

**Five branches are unsurveyable today** and must not appear as chips:
`religion` (5 items), `news` (4), `math` (3), `travel` (2), `hobbies`
(**0** — no item in the pool carries any `hobbies` node). Offering a "News"
chip would be a straightforward lie; `docs/curation/persona-set-v1.md` already
defers a News persona on exactly this ground — "0 items by design; can't be
served until feed polling ships", citing `docs/DECISIONS.md` 2026-07-09.

Whether 17 is the right number, and whether the labels read well to a normal
person ("Personal Journals" is our word, not theirs), is Joey's call — J2 in §8.

### 3.3 Copy (drafted to the gate)

All of it obeys `CLAUDE.md` § Copy rules and the `BANNED` list in
`backend/src/copy/rules.js` — no "fascinat*", "deep dive", "delve", "explores",
no clickbait withholding, no commute framing. Word counts shown.

| Element | Copy | Words |
|---|---|---:|
| Title | "What are you curious about?" | 5 |
| Sub | "Pick a few. Or skip — we learn either way, from what you play." | 14 |
| Skip | "Skip" | 1 |
| Confirm | "Start listening" | 2 |
| Confirmation line | "We'll start here. What you play, save and skip moves it from now on." | 14 |

Replacement for the "There's no interview" paragraph, if J1 goes yes:

> "This is a starting point, not a setting. What you play, save and skip moves
> it from here."

18 words exactly — it passes, with zero margin. Every string above was run
through the real `BANNED` list and `wordCount()` from `backend/src/copy/rules.js`,
not eyeballed. A safer variant with room to edit: "A starting point, not a
setting. What you play, save and skip moves it." — 14 words.

**Gap to fix in the same change:** `backend/test/copyRules.test.ts` is 57 lines
and reads exactly two files — `data/session.json`'s `cards[].why_line` and
`data/discover.json`'s `items[].hook`. Copy hardcoded in `app.js` is **not
gated by anything**. R14 promises "Copy goes through the CI copy-rules gate", so
honouring it means either putting these strings in a `data/*.json` copy fixture
(the same route R23 specifies for App Store listing strings, and which R23 never
executed) or extending the test. Recommendation: a small
`data/onboarding-copy.json` plus one new `describe` block, modelled on
`backend/test/personas.test.ts`, which is the closest structural template — it
already validates schema, referential integrity against the taxonomy, and copy
rules on `label`/`description`. This is W4 in §8.

Two live drift risks to fix while in there, both found during this review:
`personas.test.ts:22-31` keeps its **own inline duplicate** of the eight `BANNED`
patterns with a comment saying to swap it for an import "once that module
lands" — the module landed in July 2026 and the swap never happened;
`player/seek-policy.test.js:137` keeps a third, narrower copy. Three copies of a
rule list is how a banned word quietly stops being banned.

One edge case that will bite a survey: `wordCount("")` returns **1**, not 0
(`"".trim().split(/\s+/)` → `[""]`). An optional copy field left blank passes
the length check and fails nothing. If any survey string is optional, assert
non-empty separately.

---

## 4. The reconciliation — survey answer → taxonomy → ranking

This is the substance. Four questions: how an answer becomes weights, how it
reaches the ranker, how it is weighed against behaviour, and what happens when
they disagree.

### 4.1 An answer is a *subtree* expansion, never an exact match

Because of §1.2's inconsistent tagging depth, a chip for node `R` must produce
a write to `R` **and every descendant of `R`**. Anything else silently misses
content:

- Chip `engineering` → without expansion, matches **0** catalogue shows (none
  is tagged bare `engineering`) but 159 pool items via children. Expansion is
  what makes it work.
- Chip `true-crime` → without expansion **downward** it matches the 93 pool
  items that carry the bare root, but in `data/catalog.json` all 9 true-crime
  shows are root-tagged and **all four `true-crime/*` children are unused**.
  The subtree is the only stable unit.

```
expand(R) = { R } ∪ { n ∈ taxonomy.nodes : n.parent === R }
```

Two levels means the expansion is one hop. That is a direct dividend of the
depth limit `taxonomy-review-2026-08.md` §3.5 defends — keep it.

### 4.2 Fix the leaf-only defect first, or none of this works

`loadInterests()` must seed **all** nodes, not just leaves:

```js
// today  — app.js:367
function leafNodes() { return (state.taxonomy?.nodes || []).filter(n => n.parent !== null); }

// proposed
function interestNodes() { return state.taxonomy?.nodes || []; }
```

This is a two-line change with three effects, and it is worth shipping **even
if the survey is rejected**:

- Root ids become writable, so a category answer can be stored at all.
- The 232 pool items (12.5%) whose score is partly pinned at 0.5 become
  learnable, and the 58 fully-frozen ones stop being frozen. True crime,
  relationships, personal journals and paranormal have been un-learnable since
  launch — a listener who finishes ten true-crime episodes moves nothing.
- It closes the defect `taxonomy-review-2026-08.md` §3.1 named as "the single
  largest failure in the file."

**Migration risk, stated:** existing users' `cp_interests` blobs have no root
keys. `loadInterests()`'s `saved[n.id] ?? Math.max(0, n.weight)` handles this
correctly — missing keys fall back to the authored weight — so this is
backward-compatible with no migration. **Unverified:** whether adding 41 keys
measurably changes the `cp_interests` write size against the
`DurableStore` quota path in `player/durable-store.js`. It should not (41 short
keys), but it is a write-path change and `player/durable-store.test.js` should
get a case.

### 4.3 The write: a bounded prior, not a fact

For each selected chip `R`, and for `d` = the number of chips selected:

```
prior(n)  = BASE + SEED_LIFT / sqrt(d)     for every n ∈ expand(R)
```

with `BASE` the node's authored `taxonomy.json` weight and a proposed
`SEED_LIFT = 0.20`, clamped to `[0, 1]` exactly as `nudgeTopics` clamps.

Three properties, each deliberate:

- **`/sqrt(d)` punishes breadth-spam.** Selecting all 17 chips lifts each by
  0.05 — near-nothing — which is the correct reading of "I like everything".
  Selecting two lifts each by 0.14.
- **The lift is bounded and small relative to the ceiling.** A survey answer
  cannot pin a node at 1.0. It moves it from 0.5 to ~0.7 for a two-chip answer.
- **Unselected nodes are never pushed down.** A survey says what you like; it
  does not say what you dislike, and treating silence as a negative is exactly
  the echo-chamber failure principle 1 forbids. This is the difference between
  seeding and filtering, and it is not negotiable.

### 4.4 How this weighs against observed behaviour — the arithmetic

The observed-signal magnitudes shipped in `app.js` today:

| Signal | Call | Amount |
|---|---|---:|
| Saved an episode | `boostTopics(snap.topics, 0.05)` (`app.js:552`) | +0.05 |
| Finished an episode | `boostTopics(c.topics, 0.05)` (`app.js:2172`) | +0.05 |
| Thumbs up / down | `nudgeTopics([entry.topic], ±0.08)` (`app.js:2653`) | ±0.08 |

So `SEED_LIFT = 0.20` is worth **four finishes, or two and a half thumbs-ups**.
That is the whole weighting policy, and it is legible in one sentence: *an
onboarding answer is worth about four episodes of real behaviour.* By the end
of a first week of genuine use, observation has outvoted the survey — which is
what `personalization-and-depth-plan.md` §2a demands ("onboarding may only set
*priors*, never *facts*").

Cross-check: `data/personas.json` sets `seed_confidence: 0.35` for a directed
persona and `0.15` for Generalist. `SEED_LIFT = 0.20` sits between them and is
of the same order. That is a consistency argument, **not** a derivation — the
two numbers are not on the same scale and I am not claiming they are.

**And a warning about copying the backend's approach: `seed_confidence` does
nothing.** `backend/src/types/personas.ts:34-40` documents it as the mechanism
that makes the persona seed "decaying in practice without a separate decay
function". `resolveEffectiveTaxonomy()` does write it (`userInterests.ts:76`).
But `computeRelevance()` in `scoring.ts:40-48` **reads only `weight`, never
`confidence`.** A high-confidence observed row and a low-confidence persona seed
of equal weight rank identically. The repo's stated decay mechanism is inert.

This is why §4.3 puts the whole prior in the **weight**, where it is actually
read, and does not invent a parallel confidence channel. It is also W8 in §8 —
whoever eventually stands the backend up needs to know that the seed-decay story
is currently a comment, not a behaviour.

### 4.5 Decay: structural, not scheduled

**Recommendation: do not implement a time-based decay.** A repo-wide search for
`decay`, `half_life`, `halfLife`, `recency`, `EWMA` finds **no decay on interest
scores anywhere**. Every hit is something else: `computeFreshness`
(`scoring.ts:55-61`) decays *content* age on a linear 30-day / 3650-day
"half-life"; `computeFatigue` (`scoring.ts:84-92`) is a 7-day step function
keyed on show, not topic; `nextConfidence` (`interestLearning.ts:89-92`) is a
flat `+0.02` ratchet with no time term; `app.js:695` "recency" is a
`release_date` sort. Adding a background timer that quietly edits someone's
stored interests is both new machinery and hard to explain.

The prior decays **structurally** instead, by three mechanisms that already
exist:

1. **Relative dilution.** The prior is a one-time +0.20; behaviour adds ±0.05
   and ±0.08 without limit and clamps at 1.0. After ~4 contrary finishes the
   observed signal has erased the lift on that node.
2. **The clamp.** `nudgeTopics` clamps at both ends. A seeded node the listener
   consistently skips walks back down to 0 and stays reachable — the clamp at
   zero exists precisely so a node can climb back (see the comment at
   `app.js:380`).
3. **The branch-memory penalty.** `buildCards()` subtracts 0.35 for a branch
   shown in the last `BRANCH_MEMORY = 8` slots, which is larger than the seed
   lift. A seeded branch cannot monopolise the menu even in week one.

If the founders want an explicit decay later, the right shape is
event-count-based, not clock-based: retire the seed contribution once ~30
signal events exist — the same "~30 signal events, then stop asking" threshold
`03_CURATION_SPEC.md:59` already uses for the how-was-that-pick card. Recording
that number twice is better than inventing a second one. On the backend the
natural anchor already exists and is unused: `last_evidence_at` is on every
taxonomy node (`backend/src/types/taxonomy.ts:14`) and written by
`learningRepository.ts`, but **nothing reads it for scoring** — it is a pure
audit column today.

### 4.6 When declared and observed disagree — observed wins, silently

No reconciliation UI, no "you said you liked true crime, but…". The seed is
additive and bounded; contrary behaviour simply outweighs it. The listener is
never told they were wrong about themselves, and the system never argues.

This also means **the seed must be stored in the same field as observed
weight, not alongside it.** Keeping `declared` and `observed` as separate
columns invites a future ranking rule that privileges the declared one, which
is the failure mode principle 2 exists to prevent. One number, one meaning:
*how much we currently think you like this.*

Trade-off, stated honestly: fusing them means we cannot later answer "did the
survey improve retention?" from `cp_interests` alone. The instrumentation
answer is the `interests_seeded` event (§6) plus the pre-committed R14 success
metric — a pick on 3 of the first 7 days, and one wildcard played in week one
(`09-product-feature-review.md`) — not a second stored field.

### 4.7 Where it reaches the ranker

Nowhere new. `buildCards()` already ranks branches by mean `interestScore` over
the pool, and `interestScore` already reads `state.interests`. Once §4.2 lands
and §4.3 writes, the survey affects the home screen **through the existing code
path with no ranking change at all.** `search-engine.js` gets it too, via
`interestScore` as `searchWithRelaxation`'s `rankFallback` (`app.js:1609`) —
so a bare "comedy" query is also improved. The `_interestsGen` cache-key bump
(`app.js:398`) must be applied after the seed write, or a playlist built
earlier in the session serves a stale ranking.

The backend path (`sessionBuilder.ts`, `userInterests.ts`, personas) is
**untouched**: it keeps resolving to the in-memory provider and keeps producing
no per-user effect (§1.6). When it is eventually stood up, the survey
answer maps onto it directly, because both sides are weight vectors over the
same node ids — which is §5 of `personalization-and-depth-plan.md`, already
true and now load-bearing.

### 4.8 Why chips and not personas (for stage 1)

`data/personas.json` is the more sophisticated answer: snap the listener onto
the nearest persona blend, get 6–8 correlated weights from one tap. It is also
strictly more work — the client does not fetch the file, and the
nearest-persona match is a new function with its own edge cases (what is
"nearest" for a two-chip answer that straddles two personas?).

**Recommendation: chips first, personas as stage 3.** Chips reuse the taxonomy
the client already has in memory. The persona layer is a refinement of the same
write, not a different architecture, so nothing is thrown away. Sequenced in §7.

---

## 5. Principle compliance, stated explicitly

### Principle 2 — "State observed, never declared"

**There is a real tension here and I am not going to pretend otherwise.** A
survey is declared state on its face, and the shipped onboarding copy currently
takes the maximalist reading of the principle ("There's no interview").

The narrower reading is already the repo's official position, decided before
this document existed. `personalization-and-depth-plan.md` §2a:

> **Allowed:** a light cold-start *seed* to escape the empty room, which
> observation immediately begins to override and which is always
> visible/editable. …
> **Banned:** standing preference screens for things we can observe (e.g. "how
> long is your commute?" …), or treating an onboarding answer as durable truth
> after behavior contradicts it.
> **Rule of thumb:** onboarding may only set *priors*, never *facts*.

And `03_CURATION_SPEC.md:7`, the founding spec, seeds the taxonomy "from an
onboarding interview."

**What asking buys that observation cannot: the first four cards.** Observation
has nothing to observe before the first session. §1.3 measures the cost of
that vacuum precisely — 29 of 38 branches tied at 0.5000, spread 0.155, jitter
±0.25. There is no observational route to a better first menu, because there is
no observation yet. That is the entire and only justification, and it expires
the moment real signal arrives.

**The proposal complies because:** it sets a prior not a fact (§4.3); the prior
is bounded at four episodes' worth of behaviour (§4.4); it is fused into the
observed field so no rule can privilege it later (§4.6); it is asked once and
never again; it is skippable with an equal-weight button; and it never asks
anything observable — no commute length, no listening times, no session length.

**Where I would push back on Wyatt's framing:** "survey" implies a
questionnaire. A questionnaire with several questions, or one that recurs, or
one that gates entry to the app, would violate principle 2 as written, and I
would not recommend building it. One optional screen that sets priors is
compliant. Two screens is a slope, and the second question buys much less than
the first. **If the founders want a genuine multi-question survey, that is a
principle-2 amendment and should be recorded in `docs/DECISIONS.md` as one, not
slipped in as a feature.**

### Principle 1 — the ~30% exploration floor and the Stretch pick

A survey narrows. The floor must not narrow with it.

- **The Stretch slot is computed before the personalizer spends anything.** In
  `buildCards()` the stretch branch is selected from outside the top ~60% tier
  and *removed from the pool* before the top three are ranked. Seeding cannot
  take that slot; it can only change which branch fills it.
- **Seeding never pushes anything down** (§4.3). A branch nobody selected keeps
  its authored weight and stays a Stretch candidate. Selecting 3 chips leaves
  38 of the 41 branches unseeded and fully eligible.
- **`topCount = ceil(n * 0.6)` is computed on branch count, not on weights**,
  so the exploit/explore split is structurally fixed regardless of how skewed
  the interest vector becomes.
- **Extra safeguard, recommended:** exclude every seeded branch from Stretch
  eligibility for the first N sessions. Without it, a listener who picks 10 of
  17 chips could get a Stretch pick from a branch they explicitly chose, which
  is a Stretch in name only.

**An honest discrepancy, and it is bigger than it looks.** `CLAUDE.md`
principle 1 says "hard ~30% exploration floor". **There is no `0.3` anywhere in
the curation engine or the client.** What exists:

- The shipped client's floor is **1 slot of 4 = 25%**, with the tier split at
  `0.6` (`app.js:724`) — the top 60% of branches are "top tier", Stretch draws
  from the bottom 40%.
- The backend is the same 1-of-4 by construction (`ARCHETYPE_ORDER` in
  `archetypes.ts:18`), and `archetypes.ts:31-39` says so explicitly: *"the
  exploration guarantee comes from the pool selection … not from ignoring score
  here."* No numeric floor is asserted or tested there.
- The only literal `EXPLORATION_FLOOR = 0.3` in the repo is
  `backend/src/types/spine.ts:42`, which governs **beats inside a generated
  Foray audio spine** — a different pipeline entirely, unrelated to episode
  curation.
- `docs/DECISIONS.md` 2026-07-30 nevertheless describes the 1-of-4 client
  implementation as "actually enforcing product principle #1's 'hard ~30%
  exploration floor' for the first time."

So the ~30% number is real in the generation pipeline and rhetorical in
curation, where the honest figure is 25% structural. This predates this plan
and I am not proposing to change either number, but a survey is exactly the
pressure that makes the gap matter, and it should stop being described as 30%
when it is 25% — W5 in §8.

### Principle 4 — copy rules

Every drafted string in §3.3 was checked against the real `BANNED` list and
`wordCount()` from `backend/src/copy/rules.js`, and all pass. The gap that
survey copy in `app.js` is gated by nothing is named in §3.3 and carried as W4.

### Principle 3 — legally boring

Not engaged. Nothing here touches audio.

---

## 6. Privacy and disclosure — read this before scheduling it

**A store submission is imminent** (`HUMAN-ACTIONS.md` carries multiple
`[BLOCKING] for App Store submission` items). A change that alters a filed
privacy answer is expensive right now, so this section is deliberately
conservative.

### 6.1 The recommendation: stage 1 collects nothing new

**`cp_interests` already exists, is already local-only, and is already
disclosed.** Seeding it writes new *values* into an existing key — not a new
data type, not a new destination. `test/data-deletion.test.js` already inventories
`cp_interests` in the `cp_` key set and asserts it is cleared by the delete
path, so the deletion promise covers this with no change.

**On that basis, stages 1–3 change no App Privacy answer.** The filed answers
(`docs/legal/data-safety.md` §B2/§B3) are: exactly three Apple types collected
— **User ID**, **Usage Data → Product Interaction**, **User Content → Other
User Content**; all three **linked** to the anonymous account id; **none used
for tracking**; therefore **no ATT prompt**; purposes limited to **App
Functionality** and **Product Personalization**. Nothing in stages 1–3 adds a
data type, adds a recipient, or changes a purpose — "Product Personalization"
already covers a locally-stored interest weight moving the menu (§A3 cites
`app.js:nudgeTopics()` for exactly that).

### 6.2 The instrumentation is where the disclosure cost hides

R14 asks for `onboarding_seen` and `interests_seeded` events. If either is
**transmitted**, this stops being free:

- `test/legal-citations.test.js` §2 executes `app.js`'s `toEventRow` once per
  event type and asserts the transmitted set equals the `Sent` table in
  `docs/legal/privacy-policy.md` §2, **in both directions**. A new transmitted
  type turns that suite red until both legal documents are updated. That is the
  mechanism working as designed, and it is why this section exists.
- An `interests_seeded` payload carrying the selected node ids is a transmitted
  statement of a person's declared topical interests. That is a materially
  different disclosure from "what you picked and finished". §B2 currently
  answers **"Sensitive Info: No"** on the grounds that "4a asks for none" —
  and Apple's Sensitive Info category covers religious and political belief,
  sexual orientation and health. `health`, `medicine`, `psychology`,
  `relationships`, `religion` and `society` are all top-level taxonomy nodes;
  four of the first five are in the §3.2 chip list. A *declared, transmitted*
  selection of "Health & Fitness" is a much closer call than an observed play
  event, and §A5's slant-chip precedent already concedes such readings are
  *"worth a lawyer's eye."* **Transmitting the node ids is the single change in
  this plan most likely to make a filed App Privacy answer wrong.**

**Recommendation: transmit a count, not a list.** `interests_seeded: { count: 3 }`
answers the only question the R14 metric asks ("did they engage with the
screen?") and carries no topical content. The node ids stay on the device, in
`cp_interests`, where §6.1's argument holds. If the founders want per-node
seeding analytics, that is a deliberate disclosure decision, not a default —
W3 in §8.

### 6.3 The third-party AI vendor line — not crossed

The load-bearing text is **`docs/legal/data-safety.md:414`**, a row in the
"What would change these answers" table (not §A6, which is entirely about
publisher-CDN IP leakage and says nothing about this). It calls wiring the
Postgres `userInterestsProvider` **"the likeliest silent invalidation, and it
needs no client change at all"**: `AnthropicEnricher.buildWhyLinePrompt()`
already sends `Listener context: …`, `sessionBuilder.ts` builds that from
`resolveEffectiveTaxonomy()`, and setting `DATABASE_URL` would push
event-derived interest labels to a third-party AI vendor — triggering Apple rule
5.1.2 disclosure and consent, a new third-party recipient in the policy, and
Play `Shared: Yes`.

The path is real and current: `sessionBuilder.ts:283-286`'s `buildUserContext()`
maps taxonomy node ids to their human labels and hands them to the why-line
prompt at line 213. **If a survey answer ever reached tier 1 of
`resolveEffectiveTaxonomy()`, the listener's declared categories would be sent
to Anthropic as prose.**

**Nothing in stages 1–3 of this plan sets `DATABASE_URL`, calls
`createUserInterestsProvider` with a database, or sends any interest label to
any vendor.** The survey writes to `localStorage` and is read by `app.js`.
Stage 4 (§7) is the first thing that would change that, and it is explicitly
listed as **not recommended before submission**, requiring Wyatt's sign-off and
its own `docs/DECISIONS.md` entry.

**One piece of good news, contra §414's "no tripwire":** setting `DATABASE_URL`
today does not silently personalize — `createUserInterestsProvider.ts:21-25`
**throws**, because `PostgresUserInterestsProvider` does not exist. The flip is
loud, not silent. That does not weaken the warning; it means the warning
currently overstates the risk in one specific way, and both facts should be in
the record before a reviewer reads §414 and draws the wrong conclusion in either
direction. W7 in §8.

**If any future session proposes "just wire the survey into the backend
provider", that is the line, and this paragraph is the warning.**

---

## 7. Staged implementation

Each stage is independently shippable and independently valuable.

### Stage 1 — Fix the leaf-only defect (ship regardless of the survey verdict)

`leafNodes()` → all nodes, in `loadInterests()`. Roots become writable and
nudgeable.

- **Buys:** 232 pool items stop being partly frozen and 58 stop being fully
  frozen; true crime, relationships, personal journals and paranormal become
  learnable for the first time; a category answer becomes representable.
- **Does not buy:** any change to the cold-start menu — the new root keys seed
  to their authored weights, which are 0.5 for 36 of 41 roots. **This stage
  alone changes nothing a founder can see.** Say so when it lands.
- **Tests:** a case in `test/app-security.test.js` or `player/foray-playback.test.js`
  that a root id survives a `saveInterests()`/`loadInterests()` round trip, and
  that `nudgeTopics(["true-crime"], 0.05)` moves it. **Mutation that must kill
  it:** restore the `.filter(n => n.parent !== null)`.
- **Risk:** low. Backward compatible (§4.2). Touches `app.js` — coordinate via
  `STATE.md`; a session was editing `app.js` and `styles.css` when this was
  written.

### Stage 2 — The chip screen

Second pane in `showFirstTimeExplainerOnce()`, 17 chips, subtree expansion,
`SEED_LIFT / sqrt(d)`, `_interestsGen` bump, `interests_seeded: { count }`.

- **Buys:** the founder's ask, and a non-random first menu.
- **Does not buy:** anything for the existing testers — the gate is
  `isGenuineFirstTimeUser()`, so **nobody with history ever sees it.** If the
  founders want to see it themselves they need a fresh profile or a cleared
  device. Flag this before anyone reports it as broken.
- **Also required:** the copy fixture + copy-rules test extension (§3.3), and
  the chip UI in `styles.css` — CSP forbids inline styles.
- **Depends on:** Stage 1. Without it the writes are discarded.

### Stage 3 — Persona snap

Client fetches `data/personas.json`; chip selection additionally snaps onto the
nearest persona blend, applying its secondary weights at a fraction of
`seed_confidence`.

- **Buys:** correlated breadth from one tap — picking True Crime also lifts
  `personal-journals`, `psychology`, `relationships`, `paranormal`, `fiction`,
  which is Joey's researched call in `persona-set-v1.md` and is *more* diverse
  than the chip alone.
- **Does not buy:** anything if the chip set already covers the listener well.
  Measure stage 2 before building it.
- **Cost:** one more `fetchJson` in the critical path (~5 KB) and a
  nearest-persona function with real edge cases.

### Stage 4 — Server-side per-user interests — NOT RECOMMENDED BEFORE SUBMISSION

Stand up `createUserInterestsProvider`, `DATABASE_URL`, per-user
`sessionBuilder`. Requires Wyatt's sign-off, a `docs/DECISIONS.md` entry, and
re-answering App Privacy (§6.3). Out of scope here; named so nobody drifts into
it.

---

## 8. Open questions for the founders

### For Joey — product, UX, copy

- **J1 — Does "There's no interview" come out?** It is shipped copy taking an
  explicit position against what Wyatt is asking for. One of the two has to
  give, and it is a positioning call, not an engineering one. Suggested
  replacement in §3.3.
- **J2 — Is 17 chips right, and are the labels human?** The rule (≥50 pool
  items) is defensible but arbitrary at the edges. "Personal Journals" and
  "Society" are our vocabulary, not a normal listener's. Do the chips get
  display labels distinct from the taxonomy labels? (That is a new copy surface
  if so.)
- **J3 — Should the chips carry examples?** "True Crime" is self-explanatory;
  "Craft & making" is not. One example show per chip would help and costs one
  `data/` field — but a show name in an interest survey is exactly the "about
  specific shows" framing Wyatt is moving away from. I lean no.
- **J4 — Do the five thin branches get hidden, or shown greyed?** Hiding
  `religion`, `news`, `travel`, `hobbies`, `math` is honest about supply but
  invisible; showing them greyed is honest about intent and reads as a roadmap.
  Neither is wrong.
- **J5 — Does the answer stay visible and editable?** `personalization-and-depth-plan.md`
  §2a's compliance argument says the seed should be "always visible/editable",
  and §3b calls an Interests screen "the sanctioned form of declared". **No such
  screen exists** — `leafNodes()`'s only caller is `loadInterests()`. Building
  one is a separate feature; not building one weakens the principle-2 argument.
  Which?

### For Wyatt — architecture, data

- **W1 — Is `SEED_LIFT = 0.20` (≈ 4 finishes) the right exchange rate?** §4.4
  makes it legible on purpose so it can be argued about. It is a chosen number
  consistent with `personas.json`, not a measured one.
- **W2 — Confirm no time-based decay** (§4.5), and that the retirement
  threshold, if we ever want one, reuses `03_CURATION_SPEC.md`'s ~30 signal
  events rather than a new constant.
- **W3 — `interests_seeded`: count only, or node ids?** §6.2. Count is free.
  Node ids are a new transmitted disclosure of declared topical interest,
  touching `health`/`medicine`/`psychology`, and would turn
  `test/legal-citations.test.js` §2 red until both legal documents are updated.
  Before a submission, I recommend count.
- **W4 — Where does onboarding copy live so CI gates it?** A new
  `data/onboarding-copy.json` plus a `copyRules.test.ts` block is the smallest
  path, and it is the same migration R23 specified for listing strings and never
  executed. Do both at once, or just this one?
- **W5 — 25% or 30%?** The exploration floor is one slot of four. The principle
  says ~30% and `docs/DECISIONS.md` 2026-07-30 calls the 1-of-4 implementation
  an enforcement of it. Either the number in `CLAUDE.md` changes or the
  implementation does. Pre-existing; surfaced here because a survey is exactly
  the pressure that makes it matter.
- **W6 — Does Stage 1 ship on its own, now?** It is a genuine defect fix,
  invisible to users, independent of the survey verdict, and it unfreezes 12.5%
  of the pool. It could land while J1–J5 are still open.
- **W7 — `docs/legal/data-safety.md:414` needs a correction before
  submission.** It states `buildSession.ts` "passes a fixed placeholder id and
  no provider". `buildSession.ts:137` passes one. It also warns the
  `DATABASE_URL` flip has "no tripwire", when
  `createUserInterestsProvider.ts:21-25` throws. Neither error changes a filed
  answer, but a store reviewer reads that file and this repo's whole citation
  discipline (`test/legal-citations.test.js`) exists because stale references
  read as precision. Two-line fix; not mine to make unilaterally in a
  submission document.
- **W8 — `seed_confidence` does not affect ranking.** `computeRelevance()`
  reads only `weight`. `personas.ts:34-40` documents `seed_confidence` as what
  makes the persona seed decay "without a separate decay function"; it does
  nothing. Either `computeRelevance` should read confidence, or the comment
  should stop claiming a decay mechanism exists. Pre-existing; matters here
  because it is the obvious wrong place to put a survey prior.
- **W9 — `docs/DECISIONS.md` has no entry for the persona-set-v1 expansion.**
  `data/personas.json` went from one persona to six (a product-direction change,
  grounded in published market research) and `docs/DECISIONS.md`'s
  2026-07-24 entry still says "ships with one persona, `generalist`".
  `docs/curation/persona-set-v1.md` is the rationale but is not a decision
  record. Worth a short entry, since Stage 3 depends on those weights.

---

## 9. What I could not verify

Labelled per this repo's measured-vs-inferred discipline.

**Measured** (computed against committed data / read in the shipped source):
node and branch counts; tagging-depth splits; the frozen-item counts; the
cold-start `avgInterest` table and its 0.155 spread; the jitter and recency
constants; leaf weight distribution; nudge magnitudes; per-branch pool and
distinct-show counts; the absence of `onboarding_seen`/`interests_seeded`
anywhere but the marketing document; the absence of any Interests screen; the
absence of `data/personas.json` from the client fetch list; the `BANNED` list
and the two files `copyRules.test.ts` scans; `resolveEffectiveTaxonomy()`'s
three-tier cascade and its `topLevelOf` fallback; that `computeRelevance` never
reads `confidence`; that `buildSession.ts:137` passes a provider; that
`createUserInterestsProvider` throws on a set `DATABASE_URL`; that no `0.3`
exploration constant exists in curation; the §B2/§B3 filed answers.

**Inferred, not measured:**

- **That a survey improves anything.** No user data exists. The R14 success
  metric (a pick on 3 of the first 7 days, one wildcard played in week one) is
  pre-committed and unmeasured, with 2 testers. Everything in §7's "buys"
  column is a mechanism argument, not evidence.
- **`SEED_LIFT = 0.20`.** Chosen for legibility (§4.4) and consistency with
  `personas.json`'s 0.35/0.15 (§4.4). Not derived, not tuned, not validated.
- **That 17 chips fits one screen.** A layout assumption. Not prototyped, and
  `docs/ux/foray-m3-prototype.html` was not run.
- **That the chip screen changes the first menu materially.** Follows from the
  arithmetic in §1.3 and §4.3, but not simulated end-to-end against
  `buildCards()` with a seeded vector.

**Not verified at all:**

- **Whether 41 extra `cp_interests` keys affect the `DurableStore` quota
  path.** Named as a test gap in §4.2.
- **Whether Apple would treat a transmitted topical-interest list as a new
  App Privacy data type**, or as Sensitive Info. §6.2 assumes it might and
  recommends avoiding the question entirely by transmitting a count. That is
  risk-avoidance, not a legal reading, and I am not qualified to give one.
  `data-safety.md` §A5 already flags the adjacent judgement as *"worth a
  lawyer's eye"*; this is the same class of call.
- **Anything about the iOS/Capacitor shell.** `mobile/` and `ios/` were not
  examined. If the survey screen needs anything different there, this plan does
  not say so.

**A range mismatch nobody has had to resolve yet.** The client clamps interests
to `[0, 1]` (`app.js:387`); the backend taxonomy weight range is `[-1, 1]`
(`backend/src/types/taxonomy.ts`). The client is also **leaf-only** while
persona seeds are **top-level-only** — the exact inverse. Neither has mattered
because the two halves have never exchanged an interest vector. Stage 4 is where
that bill comes due; §4.2 removes half of it (the leaf/root inverse) as a side
effect, and the sign range is left open.
