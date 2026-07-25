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
  depth-laddered playlists, the step-by-step recommender evolution, the right
  metrics, and the open decisions for the founders.

Background these build on: `docs/brief/03_CURATION_SPEC.md` (the original,
excellent — but single-user — curation design) and the product principles in
`CLAUDE.md` (curiosity-first, anti-echo-chamber, observed-not-declared, no dark
patterns), which constrain everything here.

**The one-line thesis:** Foray already has a strong single-user curation engine;
the work is to give *each* user their own interest state, capture the behavioral
signal it learns from, add a curriculum layer, and keep exploration a protected
budget the personalizer can never spend.
