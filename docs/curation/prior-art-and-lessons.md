# Curation & recommenders — prior art and lessons for Foray

Curation and recommendation are decades old. This is a survey of how the systems
that got large actually work, and — more importantly — what each one teaches us
for Foray specifically. Foray is deliberately *not* an engagement-maximizing
feed (see `CLAUDE.md` product principles: curiosity-first, anti-echo-chamber,
no dark patterns), so several of these systems are studied as much for what to
**avoid** as what to copy.

Read this alongside `docs/brief/03_CURATION_SPEC.md` (Foray's original,
single-user curation design) and `docs/curation/personalization-and-depth-plan.md`
(the forward plan this review feeds).

## The two classic families (and why Foray needs both)

- **Content-based filtering.** Recommend items similar to what a user liked,
  using item *features* (genre, topic, tempo, hosts). Strength: works from day
  one with zero other users (no cold-start-by-population), fully explainable
  ("because you liked fusion"). Weakness: over-specializes — it can only give you
  more of what you already touched (the echo chamber).
- **Collaborative filtering (CF).** Recommend what *similar users* liked, from
  the behavior matrix alone, ignoring item content. Strength: finds non-obvious
  cross-topic gems ("people who love metallurgy also love this bread-baking
  show") and needs no feature engineering. Weakness: **cold-start** (useless for
  a new user or a new episode with no interactions) and **popularity bias**
  (rich-get-richer), which trends toward a filter bubble at the population level.

Every mature system is a **hybrid**. Foray must be too — but with a twist: our
anti-echo-chamber principle means we use CF as a *candidate source*, never as the
final objective. Content-based relevance + an explicit exploration budget stay in
control of the slate.

## System-by-system

### Spotify — Discover Weekly / the "BaRT" home
- **How:** a hybrid of CF (matrix factorization over listening), NLP over
  editorial + user playlists (playlists as a giant co-occurrence signal), and
  raw-audio CNN models for cold-start tracks. The home screen is assembled by
  **BaRT ("Bandits for Recommendations as Treatments")** — a contextual
  multi-armed bandit that treats each shelf/card as an arm and balances
  exploit (known likes) vs. explore (uncertain bets), learning from plays.
- **Lessons for Foray:**
  1. **Playlists are training data.** Human-assembled sequences teach the model
     what "goes together." Foray's future curated **depth ladders** (see plan)
     are the same asset — they should feed relevance, not just ship as content.
  2. **Bandits are the right tool for explore/exploit.** Foray already encodes
     this intuitively as the ε-greedy Stretch slot; formalizing it as a
     contextual bandit (context = commute length, time of day) is the natural
     upgrade and directly serves the exploration floor.
  3. **Content models solve episode cold-start.** A brand-new episode has zero
     plays; its topic/format/depth tags (and, later, text embeddings) let it be
     ranked on day one. Foray's LLM enrichment already produces these tags.

### Pandora — the Music Genome Project
- **How:** musicologists hand-labeled every song against ~450 attributes; pure
  content-based radio off that rich feature vector. Extremely high-quality,
  extremely expensive to scale (human analysts).
- **Lessons for Foray:**
  1. Foray's `topics` + `depth` + `format` + `evergreen` + `reactor_types`
     (`data/taxonomy.json` → `episode_attributes`) **are a mini Music Genome for
     podcasts.** The insight worth stealing: a rich, curated feature vector per
     item is a durable moat that CF can't replicate.
  2. The reason Pandora didn't dominate is cost. Foray's modern advantage is that
     an **LLM does the "musicologist" labeling** cheaply and consistently — but
     that only holds if the taxonomy is disciplined (see the taxonomy-alignment
     section of the plan). Garbage tags → garbage genome.

### YouTube — deep two-tower retrieval + watch-time ranking
- **How:** a **two-tower** deep net (one tower embeds the user/context, one
  embeds the video; nearest-neighbor retrieval over millions of candidates),
  then a heavy ranking model. Historically optimized for **expected watch
  time**.
- **Lessons for Foray:**
  1. **The two-tower retrieval pattern is the standard way to scale candidate
     generation** once you have many users and items. Worth adopting *if/when*
     Foray's catalogue and user base grow past what taxonomy filtering handles.
  2. **The watch-time objective is exactly what Foray must NOT do.** Optimizing
     time-on-app is what produced rabbit-holes and radicalization dynamics.
     Foray's objective is *completion of a deliberately-chosen thing* and
     *learning breadth* — a different, healthier target. This is a principle, not
     a preference (`CLAUDE.md` #1).

### Netflix — the personalized page (row/slate optimization)
- **How:** the homepage is not a ranked list; it's a **page of rows**, each row
  a themed candidate pool ("Because you watched…", "Critically acclaimed…"),
  with both the *rows* and the *items within rows* personalized — plus
  personalized artwork and per-item **explanations**. Cold-start onboarding asks
  new users to pick a few titles they like.
- **Lessons for Foray:**
  1. **Slate construction > ranked list.** Foray's 4-slot archetype menu
     (Deep-learn / Stretch / Narrative / Comfort) is a small, principled version
     of Netflix's row model: variety *by construction*, not by luck. Keep it.
  2. **Explanations build trust.** Netflix's "because you watched" ≈ Foray's
     why-line. Foray goes further (the Stretch slot must state its *bridge*) —
     lean into it; explanation is a feature, not decoration.
  3. **A tiny "pick a few things you like" onboarding is industry-normal** and
     compatible with a later observation-driven model — see the cold-start
     reconciliation in the plan.

### Apple Podcasts / Overcast / Pocket Casts — the incumbents
- **How:** fundamentally **subscription managers**. Discovery is charts +
  editorial + search. Personalization is weak; the mental model is "your shows,
  newest first."
- **Lessons for Foray:**
  1. **This is the market gap Foray targets.** The incumbents optimize
     *retention of subscriptions*, not *discovery of the next great listen*. The
     `03_CURATION_SPEC` failure mode ("after two weeks it's your 3 usual shows +
     1 random thing") is literally the incumbent product. Foray's whole reason to
     exist is to beat that.
  2. Their weakness is also a **data-access reality**: no play-completion feed
     from Apple. Foray only knows what it can observe *in its own app* — which
     makes first-party signal capture (finishes, skips, saves) essential, not
     optional.

### Engagement feeds — Google Discover, TikTok, X/Twitter
- **How:** heavily CF + real-time engagement optimization; extremely effective at
  time-on-app; well-documented **filter-bubble / outrage-amplification** side
  effects.
- **Lesson for Foray:** cautionary control group. These prove that a pure
  "give people more of what they engage with" loop converges on a narrow,
  often-worse experience. Foray's **hard ~30% exploration floor** is the
  designed antidote and must survive contact with any CF signal we add.

### Learning-oriented products — Blinkist, MasterClass, Wikipedia paths, Primer, Readwise
- **How:** structured **curricula** — an ordered path from overview → fundamentals
  → depth, curated by editors or generated from a knowledge graph.
- **Lessons for Foray:**
  1. **Depth-as-a-product barely exists in podcasting.** No major podcast app
     says "here's how to actually *learn* fusion from podcasts: start here, then
     these three, then go deep." That's a wide-open, on-brand (curiosity-first)
     wedge — the **depth ladder** in the plan.
  2. Ordering is itself curation. A good path respects prerequisites; "you can't
     appreciate the SPARC deep-dive before the tokamak-vs-stellarator overview."
     Foray's per-episode `depth` field is the seed of this but not sufficient —
     ladders need *sequence* and *prerequisite* structure.

## Cross-cutting lessons (the distilled list)

1. **Hybrid, always.** Content-based for cold-start + explainability; CF/behavioral
   for serendipity; never one alone.
2. **Bandits, not a single ranked list, for explore/exploit.** Formalizes Foray's
   exploration floor and learns the right explore rate per context.
3. **A rich per-item feature vector is a moat.** Foray's LLM-generated
   topic/depth/format tags are its Music Genome — protect their quality.
4. **Optimize the right objective.** Watch-time is harmful; Foray optimizes
   deliberate-choice completion + learning breadth. This changes the loss
   function, the metrics, and the UI (no autoplay, no streaks).
5. **Slate construction beats top-N.** Keep the archetype-slot menu; diversity by
   construction is a feature the incumbents lack.
6. **Explanations are core, not garnish.** The why-line (and especially the
   Stretch bridge) is a trust and learning mechanism.
7. **Cold-start is a first-class design problem,** solved by a blend of: a light
   onboarding signal, a market-research default persona, and fast switchover to
   observed behavior. (Details in the plan; reconciled with the
   observed-not-declared principle.)
8. **First-party signal capture is existential** for a podcast app, because the
   platforms give you nothing. Instrument finishes/skips/saves from day one.
9. **Personalization must not eat the exploration floor.** CF's natural tendency
   is a filter bubble; the architecture must keep exploration as a protected
   budget the personalizer cannot spend.
10. **Depth/curriculum curation is an unclaimed niche** perfectly aligned with
    Foray's curiosity-first mission.
