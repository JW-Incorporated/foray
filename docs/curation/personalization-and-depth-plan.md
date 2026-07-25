# Personalization & depth — the plan

How Foray goes from one hand-tuned taxonomy (Wyatt's) to **per-user curation**,
and from a flat pool to **depth-laddered learning paths** — without breaking the
product principles. Grounded in `docs/curation/prior-art-and-lessons.md` and the
original single-user design in `docs/brief/03_CURATION_SPEC.md`.

> **North star.** A new user's second week should feel like a knowledgeable
> friend who has been paying attention — not a subscription list with extra
> steps, and not an engagement feed that narrows them. Curiosity in, breadth
> preserved.

---

## 1. Where we actually are (honest baseline)

- **Interest model = one global taxonomy.** `data/taxonomy.json` (149 evidence-
  weighted nodes) encodes *Wyatt's* tastes (fusion at weight 1.0, etc.). There is
  **no per-user model.**
- **Scoring is built but starved.** `backend/src/curation/scoring.ts` implements
  `relevance/freshness/quality/fatigue`, but: relevance is taxonomy-weight only
  (no embeddings), quality is a depth heuristic (no completion history), and
  fatigue runs on an **empty event history** — because there is **no persisted
  behavioral store.**
- **The 4-slot archetype menu works** (`archetypes.ts`) — variety by construction
  is real and worth keeping.
- **No accounts.** User state lives in `localStorage` (`cp_` prefix). There is no
  auth, no server-side per-user data — though `user_id` is already threaded
  through the backend schema, so the plumbing anticipates multi-user.
- **Rich item features exist** (`topics`, `depth`, `format`, `evergreen`,
  `reactor_types`) — our "podcast genome." **No depth ladders / sequences** yet.

So the work is not "add ML." It's: **(a) give each user their own interest
state, (b) capture the behavioral signal that state learns from, (c) add a
curriculum layer, and (d) keep exploration protected the whole way.**

## 2. Two tensions to resolve up front

### 2a. Onboarding pop-ups vs. "state observed, never declared" (principle #2)
The principle bans *declared config where observation is possible*. Onboarding
questions look like a violation. They are not — **if** scoped correctly:

- **Allowed:** a light cold-start *seed* to escape the empty room, which
  observation immediately begins to override and which is always visible/editable.
  `03_CURATION_SPEC` already sanctions exactly this ("onboarding interview → seed
  weights").
- **Banned:** standing preference screens for things we can observe (e.g. "how
  long is your commute?" — that is *learned*, never asked), or treating an
  onboarding answer as durable truth after behavior contradicts it.

**Rule of thumb:** onboarding may only set *priors*, never *facts*. Every prior it
sets decays as evidence arrives. We prefer **zero-question defaults** (a persona,
§3a) and treat any question as an optional accelerant, not a gate.

### 2b. Personalization vs. the ~30% exploration floor (principle #1)
CF and behavioral personalization naturally converge on a filter bubble. Foray's
floor is the antidote and is **non-negotiable**. Architectural commitment:

- Exploration is a **protected budget**, not an emergent outcome. The Stretch slot
  and the floor are computed *first*; the personalizer fills the *remaining*
  exploit capacity.
- Behavioral/CF signals may **generate candidates** and **rank within exploit
  pools**. They may **never** set the session objective or shrink the floor.

## 3. User-interest modeling (the three phases of a user's life)

A user moves through three regimes. The interest model is the same object
throughout — a weight vector over taxonomy nodes (`-1..+1`, with confidence) —
only the *source of evidence* changes.

### 3a. Cold start (session 0–3): personas + optional light onboarding
1. **Default persona (zero questions).** Do market research to define 4–6
   archetypal Foray users (e.g. "Curious Engineer", "History & Ideas", "Health &
   Performance", "True-Crime & Narrative", "Generalist"). Each persona is a
   preset weight vector over the *existing taxonomy*. A brand-new user starts on
   the **Generalist** persona (broad, high-exploration) so even with no input the
   first menu is sane and diverse. *This is the single highest-leverage cold-start
   fix and needs no ML.*
2. **Optional 20-second onboarding (accelerant, not gate).** One screen: "Pick a
   few that spark something" — 8–12 taxonomy-node chips (Fusion, Ancient history,
   Woodworking, Comedy hangs, …) drawn from top-level nodes. Selecting some snaps
   the user onto the nearest persona blend and up-weights the picked nodes. Skippable;
   skipping = Generalist. This mirrors Netflix's title-pick onboarding, kept to
   *node* granularity so it aligns 1:1 with the catalogue (§5).
3. **First-week exploration boost.** Per the spec: run a higher explore rate and
   prefer shorter items (cheaper to evaluate) for the first ~2 weeks, and end each
   session with one lightweight "how was that pick?" until ~30 signal events
   exist — then stop asking (anti-nag).

### 3b. Warm-up (≈ sessions 3–20): behavior takes the wheel
Observed signals now dominate the priors. Update rules are already specified in
`03_CURATION_SPEC` ("Learning from signals" table) — implement that table against
the new event store:

| Signal | Effect on interest state |
|---|---|
| Finished ≥85% | strong + on episode topics/show/format |
| Picked from menu | mild + on archetype & topics (choice ≠ completion) |
| Skip < 2 min | strong − on *episode*, weak − on topic |
| Skip 2–20 min | moderate − episode, mild − format |
| Saved for later | + topic, neutral on now-context |
| "More like this" / thumbs | explicit ± on named node/topic |
| Card shown, never picked ×5 | gentle − on that framing/topic |

Two invariants from the spec that MUST carry over: **separate durable taste from
session context** ("something different" and time-of-day never permanently mutate
taste), and **make the state user-inspectable/editable** (an Interests screen with
draggable weights — the sanctioned form of "declared", because it edits an
observed model rather than replacing it).

### 3c. Steady state (20+ sessions): light collaborative signal
Once there is a population of users with event histories, add CF **as a candidate
source only** (item-item co-occurrence: "users whose finish-vector looks like
yours also finished X"). Feeds the Deep-learn and Stretch candidate pools; never
overrides the archetype structure or the floor. This is where the two-tower
retrieval pattern (prior-art) becomes worth building — but not before we have the
data to justify it.

## 4. Where the data lives (storage & the accounts decision)

This is the **foundational decision** the plan depends on, because Foray has no
accounts today.

**Recommended path — anonymous-first, accounts-later:**

- **Interest state (the weight vector): client-first, in `localStorage`** (keep
  the `cp_` prefix — renaming wipes state). It is small, private, and needs no
  server. This keeps us "legally boring" (no PII to start) and works offline.
- **Behavioral events: a first-party event store keyed by an anonymous
  `user_id`.** Generate a UUID on first run, persist it in `localStorage`, and
  send events (play, finish %, skip, save, pick, dismiss) to a backend table.
  Every backend table already carries `user_id`, so this is the intended shape.
  Events are the fuel for §3b/§3c and for cross-device later.
- **Accounts (email/OAuth) are a later, opt-in step** — offered only when a user
  wants cross-device sync ("keep my picks on my phone and car"). Not a launch gate.
  When added, accounts simply *bind* the anonymous `user_id` to an identity.

**Proposed schema (backend, all `user_id`-scoped):**
```
users            (user_id, created_at, persona_seed, account_id?  -- account_id null until they link)
user_interests   (user_id, node_id, weight, confidence, last_evidence_at)   -- the taste vector
events           (user_id, ts, type, episode_id, show, topics[], value)      -- finish%, skip_at, etc.
user_context     (user_id, learned_commute_min, tz, ...)   -- OBSERVED, never asked (principle #2)
ladder_progress  (user_id, ladder_id, rung_reached, updated_at)  -- for §6
```
`user_interests` is literally a per-user copy of the taxonomy weight columns —
so the whole existing scoring engine works per-user by swapping the global
taxonomy weights for the user's row set. **Minimal engine change, maximal payoff.**

**Privacy stance (legally boring):** store the minimum — anonymous id + behavioral
events over our own catalogue. No third-party audio, no cross-site tracking, no
selling. Make the Interests screen also the "see/export/delete my data" screen.

## 5. One taxonomy for both catalogue and preferences

The user's requirement — "preferences/interests/categories should line up with how
we catalogue podcasts" — is **already structurally true and must be protected as an
invariant:**

- Catalogue items are tagged with taxonomy `node_id`s (`discover.json.items[].topics`).
- User interests are weights over the **same** `node_id`s.
- Personas are preset weight vectors over the **same** nodes.
- Onboarding chips are the **same** top-level nodes.

So relevance is a dot-product between a user's weight vector and an item's node
membership — trivially explainable ("because you rate Fusion highly"). **Action
items to keep this honest:**
1. **Taxonomy governance.** Adding a catalogue tag that has no taxonomy node is
   already a CI failure (good — `ci.yml` checks this). Extend the discipline:
   node additions get an ADR; keep the two-level hierarchy shallow and legible
   (users must recognize the labels).
2. **Persona vectors are versioned data** (`data/personas.json`), reviewed like
   content — not code constants.
3. **Coverage check.** A periodic report: for each persona, does the catalogue
   have enough fresh, quality items in its high-weight nodes to fill a good menu?
   Gaps are a content-sourcing signal (which shows to add).

## 6. Depth-laddered playlists (the learning-path layer)

The user's fusion example — "start with an overview of the types of fusion and the
fundamentals, then a deep dive into each" — is a **curriculum**, not a ranked
list. This is a new first-class object and, per the prior-art review, an unclaimed
niche.

### Data model — `data/ladders.json`
```jsonc
{
  "id": "fusion-101",
  "node": "engineering/energy-fusion",     // aligns to the taxonomy (§5)
  "title": "Understanding fusion energy",
  "estimated_total_min": 260,
  "rungs": [
    { "level": "overview",
      "goal": "the landscape: what fusion is, the main approaches",
      "episode_ids": ["..."], "prerequisites": [] },
    { "level": "fundamentals",
      "goal": "confinement, the plasma problem, the Lawson criterion",
      "episode_ids": ["..."], "prerequisites": ["overview"] },
    { "level": "deep-dive", "subtopic": "tokamaks / SPARC",
      "episode_ids": ["..."], "prerequisites": ["fundamentals"] },
    { "level": "deep-dive", "subtopic": "stellarators / W7-X",
      "episode_ids": ["..."], "prerequisites": ["fundamentals"] },
    { "level": "frontier",
      "goal": "where the field is now — startups, timelines",
      "episode_ids": ["..."], "prerequisites": ["deep-dive"] }
  ]
}
```
This reuses the existing per-episode `depth` (low/medium/high) as the raw
material — but adds what `depth` alone can't express: **sequence, prerequisites,
and subtopic branching.** (`reactor_types` on fusion episodes is a preview of how
rich the deep-dive branching can get.)

### How ladders get built (and stay legally/editorially safe)
- **LLM-assembled, human-approved** — same governance as the nightly refresh. A
  cloud pass takes all catalogue items in a node, plus their `depth`/`format`/
  summaries, and proposes a ladder (ordering + prerequisites + one-line rung
  goals). It opens a PR; a founder approves. Ladders are curation, so they're
  content (Joey's lane), reviewed before publish.
- **Copy rules apply** to rung goals and any why-lines (≤ the limits, banned
  words — reuse the `merge.mjs`/CI gate).
- Start with a **handful of hand-picked flagship ladders** (Fusion, one History,
  one Health) to prove the format before scaling.

### How ladders surface and personalize
- **Which ladder:** driven by the user's high-weight nodes (a Curious-Engineer
  persona sees the Fusion ladder; History persona sees the Rome ladder).
- **Where to start:** observed history sets the entry rung — if a user already
  finished two overview-level fusion episodes, start them at fundamentals, not the
  overview (don't bore demonstrated competence). `ladder_progress` tracks this.
- **In the menu:** a ladder can supply the **Deep-learn** slot as "next rung in
  Understanding Fusion," making the daily menu double as steady progress through a
  curriculum — without an autoplay chain (still one deliberate tap per session,
  principle-safe).

## 7. Recommender architecture — the evolution (not a rewrite)

Each step is shippable and preserves the archetype menu + exploration floor.

| Step | Adds | Unlocks | Depends on |
|---|---|---|---|
| **A. Per-user weights** | `user_interests` table; engine reads user vector not global taxonomy | real per-user relevance | §4 store |
| **B. Personas + onboarding** | `personas.json`, cold-start seed, chip screen | sane new-user menus | A |
| **C. Event capture** | `events` table + client instrumentation | fatigue, quality, the §3b learning table | §4 store |
| **D. Depth ladders** | `ladders.json`, ladder builder, Deep-learn integration | the curriculum product | §5 taxonomy |
| **E. Embeddings/adjacency** | episode embeddings + per-node centroids | true Stretch serendipity (spec's original intent) | C (signal to tune) |
| **F. Bandit slate + light CF** | contextual bandit for slot fill; item-item CF candidates | learned explore rate; cross-topic gems | C+E, a user population |

Steps A–D are buildable now and don't need a population or an embedding pipeline.
E–F are earned once there's data. **Do not skip to F** — CF without the guardrails
of A–D and the exploration floor is how you rebuild an engagement feed by accident.

## 8. Metrics — measure the right thing (not watch-time)

Because the objective is curiosity/learning, not time-on-app:
- **Deliberate-completion rate** (finished ≥85% of a *chosen* item) — the core
  quality signal.
- **Breadth** — distinct top-level nodes a user finishes over 30 days (guards the
  anti-echo-chamber goal; a *falling* breadth is a red flag, the opposite of most
  apps).
- **Stretch acceptance** — how often the exploration slot gets picked and finished
  (is our serendipity actually good, or just noise?).
- **Ladder progression** — rungs completed; do curricula get finished?
- **Explicitly NOT a metric:** session length, daily-active minutes, or anything
  that rewards keeping someone in the app longer than their commute.

## 9. Open decisions for the founders

1. **Accounts model (Wyatt):** confirm anonymous-first with opt-in accounts later
   (§4), or do we want real accounts at launch? Everything downstream depends on
   this.
2. **Persona research (Joey):** who are our 4–6 default personas? This is a
   product/market-research task and gates cold-start quality (§3a). Worth doing
   properly — it's the cheapest big win.
3. **How much onboarding (Joey):** zero-question (persona only) vs. the optional
   20-second chip screen. Recommendation: ship persona-only first, add chips if
   cold-start data shows we need it.
4. **Ladder scope (Joey):** which 3 flagship ladders to hand-build first?
5. **Personalization cost budget (Wyatt):** per-user why-lines at scale cost LLM
   spend (the budget guard exists for this). Likely answer: templated why-lines +
   LLM only for the Stretch bridge; confirm the ceiling.
6. **Privacy posture:** confirm the minimal-data, self-serve export/delete stance
   (§4) as a written principle (candidate for `docs/DECISIONS.md`).

## 10. Suggested sequencing

1. **Decisions #1, #2** (accounts model + persona research) — they gate everything.
2. **Step A + B** (per-user weights + personas + optional onboarding) — the
   biggest perceived-quality jump for the least infrastructure; no population
   needed.
3. **Step C** (event capture) — turns on real learning; instrument the client and
   stand up the `events` table.
4. **Step D** (one flagship depth ladder, e.g. Fusion) — proves the curriculum
   format end-to-end through the existing PR/review flow.
5. **Steps E–F** once there's a real event corpus — embeddings for true
   serendipity, then bandit slate + light CF, always behind the exploration floor.
