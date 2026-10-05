# Durable token-intensive work

Work whose output survives every future architecture change — verified data and compiled
knowledge, not code. Ranked by durability × usefulness. Status as of the 2026-07-08 night run.

## 1. Catalog growth (highest leverage, effectively unlimited)
Verified shows + episodes with hooks are pure asset: the future backend ingests this catalog
as its seed; the iOS app reads the same pools; nothing about it is throwaway. Every entry is
iTunes-verified (no invented IDs) and copy-gated.
**Status:** 64 shows / 146 items → wave 1 (space, computing, economics, psychology, disasters,
automotive, grid-energy, philosophy…) in flight tonight; further waves queued until budget or
territories run out.

## 2. Episode tagging & classification (the search/curation brain's food)
5–10 concrete tags per episode (subjects, people, orgs, qualities, eras) — feeds search,
series-building, and later the taxonomy/embedding pipeline. When real enrichment (Tier-1 LLM
classification) comes online, these hand-quality tags become its **golden calibration set**:
we can measure the cheap pipeline against frontier-model tags.
**Status:** all 146 current items being tagged tonight (data/item-tags.json); each catalog
wave gets a tagging pass after merge.

## 3. Semantic index (compiled query understanding)
Concept clusters (fusion → tokamak/plasma/stellarator/…), query modifiers ("short and funny"
→ duration+branch filters), topic mappings. This is the "lightweight model" the user asked
for, compiled offline by a frontier model into JSON the static client interprets in
microseconds. Survives the move to server-side search — it becomes the query-rewrite layer
there too.
**Status:** being built tonight (data/semantic-index.json); client interpreter shipped.

## 4. Fixture corpus growth (feeds parser hardening)
Real-world weird RSS feeds are irreplaceable test data — every future parser refactor runs
against them. Currently 8 feeds; each new catalog wave brings new hosts (Buzzsprout, Acast,
Megaphone, Substack variants) worth snapshotting.
**Status:** 8 fixtures; expansion candidate for tonight if budget allows.

## 5. Golden eval sets
The copy-rules suite (shipped) + hand-graded examples of good/bad why-lines and menus. When
the Anthropic key lands, these gate the automated pipeline's output quality (pre-mortem
tripwire 3, blind test R1).
**Status:** copy rules in CI; menu-quality golden set waits for real pipeline output to grade.

## 6. Research corpus (bounded — deliberately frozen)
Marketing/competitive/legal research is durable but has diminishing returns; the pre-mortem
froze it. Only tonight's two commissioned reviews (feature audit, architecture assessment)
remain, then frozen again.

## 7. The discover.json soft cap (A26; written 2026-10-05)
Catalog growth (§1) has a client-side ceiling, and it was crossed before this section was
written. `docs/architecture-assessment.md` F2.4 sets the practical soft cap at **~2,000
discover items / ~1.5 MB**. Past it, three costs grow: the cold fetch on cellular,
`JSON.parse` on the critical render path, and `fullPool()` snapshots on every re-deal and
search keystroke.
**Measured 2026-10-05:** 2,167 items, 2,552,586 bytes (2.55 MB; 572 KB gzipped). That is 8%
over on items and 70% over on bytes. It was 2,080 items / 2.41 MB when
`docs/product/suggested-shows-requirements.md` §6.12 first recorded it.
**The fallback when growth must continue:** shard `discover.json` per top-level taxonomy
branch and lazy-load the branches a listener's interests touch. Alternatively, treat the
cap as the trigger for API-served search (architecture-assessment §3, stage 4).
**Rule for catalog waves until then:** a wave that adds discover items states the new item
count and byte size in its PR. Nothing in CI enforces the cap. Today it is a documented
budget, not a gate.

## Anti-list: token work that would NOT be durable
- Generating why-lines/session builds with the stub or by hand at scale (the real pipeline
  regenerates these; only the golden few are worth keeping).
- Web UI polish beyond user requests (feature freeze; iOS replaces much of it).
- Speculative embeddings/vector data (format depends on the chosen embedding model — wait
  for the key and pick once).
