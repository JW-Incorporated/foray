# Curation & recommender design

Curation is the crux of Foray. These docs think it through — from how the rest of
the industry does it to a concrete forward plan for per-user personalization and
depth-based learning paths.

- **[prior-art-and-lessons.md](prior-art-and-lessons.md)** — how Spotify, Pandora,
  YouTube, Netflix, the podcast incumbents, engagement feeds, and learning
  products do curation/recommendation, and the 10 distilled lessons for Foray
  (including what to deliberately *avoid*).
- **[personalization-and-depth-plan.md](personalization-and-depth-plan.md)** — the
  plan: multi-user interest modeling (personas + light onboarding + observed
  signals), where user data lives (the accounts decision), one-taxonomy alignment,
  depth-laddered playlists, **token-light search & playlist-building** (§7 — the
  feature layer as a query language; LLM only to translate a vague prompt into a
  filter spec, never to select content), the step-by-step recommender evolution,
  the right metrics, and the open decisions for the founders.

- **[persona-catalogue-fit.md](persona-catalogue-fit.md)** — preliminary check on
  Decision #2: candidate default personas and whether the catalogue actually
  serves them (finding: the taxonomy architecture fits; content is founder-skewed,
  with software/computing and true-crime the notable gaps). Full persona research
  is delegated to Joey's lane via a tracking issue.
- **[ladders-client-spec.md](ladders-client-spec.md)** — Step D (§6): how the
  web client should fetch `data/ladders.json`, infer a listener's entry rung
  from observed history (never declared), and surface it as an additive badge
  — not yet implemented; `app.js`/`sw.js` are untouched pending a dedicated
  client-integration pass.
- **[search-coverage-gaps.md](search-coverage-gaps.md)** — §7's search promise
  (deterministic query over tags/concepts, no runtime LLM) cross-referenced
  against `data/top-topics.json` (155 topics a general user actually searches
  for): most catalogue gaps are a breadth-tier *promotion* problem, not a
  sourcing problem (19.7k shows already harvested and genre-mapped, barely
  promoted into the curated tier); the semantic index also has a systemic
  concept-misrouting bug (8 flagged concepts, incl. true-crime search
  silently routing into history). Full machine-readable cross-reference:
  `data/topic-coverage-report.json` (built by `tools/topic-coverage-report.mjs`).
- **[grilling-foray-sourcing.md](grilling-foray-sourcing.md)** — sourcing pass
  for a grilling/barbecue Foray's non-Western half (asado, braai, yakitori,
  jerk, satay, tandoor, lechon, mangal, Santa Maria, the cooking hypothesis):
  which traditions have a usable ad-free source, which have **none**, and a
  measured answer to whether the Apple-chart catalogue can support subject-led
  curation at all. Headline: chart rank predicts ad injection — ranks 1–25 are
  33% ad-free vs 71% at ranks 26–200 (χ²=8.22, p<0.01) — so a chart harvest
  selects *against* the shows we can anchor. Note this sits alongside, not
  against, `search-coverage-gaps.md`: promotion is still the fix for most
  topics; sourcing is the fix for non-Anglophone ones.

Background these build on: `docs/brief/03_CURATION_SPEC.md` (the original,
excellent — but single-user — curation design) and the product principles in
`CLAUDE.md` (curiosity-first, anti-echo-chamber, observed-not-declared, no dark
patterns), which constrain everything here.

**The one-line thesis:** Foray already has a strong single-user curation engine;
the work is to give *each* user their own interest state, capture the behavioral
signal it learns from, add a curriculum layer, and keep exploration a protected
budget the personalizer can never spend.
