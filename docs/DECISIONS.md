# DECISIONS.md — running changelog

Per-topic ADRs live in `docs/adr/`. This file is the chronological record.

## 2026-07-07 (overnight web-first sprint)

- **Web-first pivot.** First deliverable is a deployed static site (GitHub Pages), not the iOS app — App Store distribution wasn't feasible for a next-morning test. The site front-loads the M2 curation-quality gate ("would I pick something from this menu?"); the iOS roadmap in `docs/brief/06_ROADMAP.md` is unchanged, just re-sequenced. Audio-session choreography (M0's top risk) is untestable on web and remains the first iOS task.
- **Playback = external handoff.** Cards link out: Apple Podcasts (episode-level deep links), Overcast (show-level — Overcast has no public episode-URL scheme), pod.link (show-level universal links; covers Android testers). No hosted or proxied audio, consistent with hard constraint #3.
- **Repo is public** on GitHub (free Pages requires it). No secrets in repo; `.env` is gitignored with `.env.example` template committed.
- **Pages deploys from `main` branch root** (legacy build + `.nojekyll`), not GitHub Actions — the gh OAuth token lacks `workflow` scope. Revisit if/when `gh auth refresh -s workflow` is run.
- **Taxonomy anchors to Apple Podcasts categories** (the industry-standard taxonomy used by Podcast Index) with custom two-level nodes beneath, because Apple's tree has no Engineering category and no History/Science subtypes that match the user's interests. Depth (low/medium/high) is a **per-episode attribute**, not a taxonomy dimension. See `docs/research/curation-practices.md` and ADR-0003.
- **Session document v1** (`data/session.json`): cards with archetype/why_line/fit_line/alternates + an episodes map + browsable categories. The web client and the future iOS client consume the same document. `data/validated-links.json` is a generated overlay (resolved track IDs, artwork) so hand-curated data and machine-verified data stay separable.
- **Curation for session 1 was done by the architect (Claude) at build time**, from agent-researched candidates verified against the iTunes API. The backend session builder (in progress) reproduces this pipeline programmatically.
- **Commute parameters**: 15–20 min drive, playback at 1.5× → ~27 content-minutes per commute. Fit-lines speak in the user's effective listening time.
- **Long episodes are offered honestly** (e.g., the 3¼-hour Whyte episode is the Deep-learn lead with a "week of drives" fit-line) per the resume-across-sessions model — not filtered out.
- **Client-side event logging** (`localStorage`, capped at 500 events): session_shown / picked / refreshed. This is the learning-signal schema seed; syncs to the backend `events` table once it exists.
- **Podcast Index key is pending** (their signup email is slow) — everything tonight uses the keyless iTunes Search/Lookup API; the backend's Podcast Index client ships in dry-run mode.

## 2026-07-08 (first-morning feedback)

- **Discovery must feel like a splatter, not a directory.** Static category shelves replaced with a shuffled cross-topic feed: interest-weighted sampling with heavy jitter, a hard 30% exploration floor ("wildcards" that ignore weights), and no two adjacent items from the same topic branch. Taxonomy remains internal machinery + an editable interests panel, never the primary browse UI.
- **State is observed, never declared.** User principle: playback position, episode-finished status, and listening-stint length must be inferred by the system, not entered by the user. The iOS architecture already complies (15-second position persistence + events table drive the Continue card automatically). The web page's "Done ✓" button is a documented stopgap — external podcast apps hide playback position from us — and disappears when playback moves in-app.
- **Commute length is demoted from setting to learned parameter.** Dropped from all UI copy (no more "fits your drive" fit-lines; duration shown plainly). The user is happy spanning an episode across several drives. Session assembly's target duration should eventually be inferred from session start/stop events; retained internally only as a heuristic default (e.g. the web Continue-card threshold).
- **Fresh on every load.** Card slots shuffle their candidate chains per visit (already-played sink to the back); splatter excludes the ~36 most recently shown items. Stars/saves persist snapshots locally and gently boost topic weights (spec: "saved = right content, wrong time").

## 2026-07-08 (night 2: rename, marketing synthesis, hardening)

- **Renamed CommutePilot → Foray** per the naming study (foray.fm RDAP-available, App Store clear). Repo is now `wjduvall-cmd/foray`; marketing docs keep the old name as historical record; localStorage keys unchanged.
- **Marketing program concluded** (docs/marketing/00–08): market brief + requirements delta synthesized from four research desks, a legal memo, and a red-team pre-mortem. Product principles trumped three proven-but-conflicting tactics (familiarity-heavy menus, streaks, clip feeds). **Standing order adopted from the pre-mortem: marketing corpus and web-client features are frozen; next effort goes to the automated builder's menu quality (blind machine-vs-hand test, R1) and the iOS audio spike (14-day timebox, R5).**
- **Quality/security gates shipped:** CI (backend tests + data validation), copy-rules test suite gating all user-facing copy, XSS hardening (esc + safeUrl + strict CSP), secrets/history scan clean, CLAUDE.md agent guide, `builder` field + 5000-event buffer for the blind-test and retention telemetry.

## 2026-07-09 (night 3: the go-ham run)

- **Catalog engine ran three waves: 154 shows / 389 episodes across ~35 topic branches**, every entry iTunes-verified, every hook copy-gated, every episode tagged (5–10 tags), all durable data per docs/DURABLE-WORK.md. Client payload ceiling checked: largest fetch ~300KB vs ~1.5MB soft cap.
- **Semantic search layer complete: 112 concept clusters + 28 modifiers + 389/389 tagged.** The "lightweight model" is compiled offline by a frontier model into data/semantic-index.json + item-tags.json; the client interprets asks (concept expansion, duration/branch/recency filters, progressive relaxation). Same index becomes the server-side query-rewrite layer later.
- **Architecture assessment (docs/architecture-assessment.md, 27 actions)** — four defects fixed same-night: builder field missing from backend session output (would have silently invalidated the R1 blind test), 3 episodes duplicated across ID schemes, 11 topic branches missing taxonomy nodes (stars/sliders silently no-oped), backend fitLine still generating banned commute copy. New CI invariants enforce all of it. Profile IDs + data export shipped for tester identity.
- **ForayKit Swift suite executed for the first time** (new macos-latest CI job): one manifest fix (tools-6-only API), then all tests green. iOS code is now under permanent compile+test protection.
- **Marketing review 2 (docs/marketing/09)**: R13–R23; iOS v1 table-stakes fixed at six player features; offline shell shipped same-night (service worker; the web app previously white-screened offline). Watchlist: Spotify Prompted Playlists + Snipd AI DJ assessed — R10 triggers NOT fired.
- **Standing order retained:** with the catalog engine done, the two life-or-death items remain the R1 blind test (waiting on the Anthropic key) and the iOS audio spike (waiting on the Mac).

## 2026-07-09 (scale day)

- **Search ranking overhauled** after "sleep training" surfaced AI content: coverage tiers, contextual concept disambiguation, word-boundary matching for short tokens, document-frequency term weighting. Verified on the failing query + controls.
- **Two-tier catalog architecture adopted** (docs/CATALOG-PIPELINE.md): curated tier (editorial waves, episode-level) + breadth tier (programmatic). **19,787 shows harvested** across all 110 Apple podcast genres via checkpoint-resumable tools/harvest-catalog.mjs — 99.7% with feed URLs, chart-rank popularity priors, Podcast Index cross-ref fields reserved. Backend seed data; not client-fetched.
- **Multi-app identity captured** (data/app-links.json): Pocket Casts + Castbox verified derivable from Apple IDs; Overcast scheme standard but not server-verifiable; 38 native Spotify IDs search-verified for top curated shows (pod.link unscrapable — SPA behind checkpoint); YouTube Music deferred. Feed URL remains the master key.
- **Breadth tier fully classified**: 19,787 shows with taxonomy topics (genre-map base + 8-slice opus refinement, per-entry provenance), 516 curated episodes at series depth. The curation engine now has a mapped universe with popularity priors.
- **Branch-out complete (2026-07-09)**: market-share audit (docs/marketing/10) drove five gap-curation waves — comedy at depth, true crime/paranormal, wellness/psychology/parenting, storytelling/relationships, kids/fiction/arts. Curated tier: 213 shows / 679 episodes, episode-level coverage of US listening hours ~12%→~75%. News/sports deferred until feed polling exists (timely content expires). Per-episode explicit flags from contentAdvisoryRating (show-level flags proven unreliable) — family-mode data prerequisite met. Episode archive: 73,719 episodes for the top-100 shows (full public feeds).

## 2026-07-11

- **Podcast Index demoted from required to optional** (amends brief hard-constraint #2 in practice). Everything runs on keyless Apple APIs + direct RSS — the durable path, since feeds are ground truth. PI remains respected (Curry/Jones, open, powers Podcasting 2.0) but is a two-person project; if its data is ever wanted, ingest their free full-DB dump (no API key) rather than holding credentials. podcastindex_id fields stay reserved; backend PI client stays dry-run-optional. The pending API signup is cancelled from the owner to-do list.

## 2026-07-24 (org migration + curation planning)

- **Foray migrated to cloud automation under the `JW-Incorporated` org.** New repo `JW-Incorporated/foray` (old `wjduvall-cmd/foray` retired), protected `main` (PR + `backend`/`data-and-site` checks, zero bypass), Pages moved to `jw-incorporated.github.io/foray`. Nightly refresh is now cloud-based (Swift2 two-tier model): a keyless GitHub Action (`tools/refresh/` scan+resolve) publishes a credential-free digest to the `refresh-digest` branch; a Claude Cloud agent (`foray-nightly-enrich`) authors hooks/tags and opens a PR that auto-merges on green checks (`automerge-nightly.yml`). The old local Windows task is disabled. Roles: Joey = CEO/Product, Wyatt = CTO/Eng (`docs/roles.md`, `CLAUDE.md` operating manual). See `docs/nightly-refresh-cloud.md`.
- **Curation strategy documented** (`docs/curation/`): prior-art review + a plan to go from one global taxonomy (Wyatt's) to per-user personalization (personas + optional light onboarding + observed signals), one-taxonomy catalogue/preference alignment, depth-laddered learning-path playlists, and token-light search/playlists (the tag/feature layer as a query language; LLM only translates a vague prompt into a filter spec, never selects content).
- **Identity: anonymous-first, opt-in accounts via Supabase Auth** (ADR-0005). `user_id` becomes `auth.uid()`; new users get a frictionless anonymous account (`signInAnonymously()`) that can later be upgraded to email/OAuth on the *same* uid (no data migration). RLS enforces per-user isolation; the same model carries to native iOS/Android via the Supabase Swift/Kotlin SDKs. Fills the one schema gap (no owning users row): `0013_app_users.sql` (portable) + `backend/migrations/supabase/` (RLS/auth, applied to the project separately). Founder action pending: provision the Supabase project. Retires the `SEEDED_USER_ID` placeholder.
- **Per-user interest vector + personas scaffold shipped** (personalization-and-depth-plan.md Step A+B). `data/personas.json` (schema `backend/src/types/personas.ts`) holds preset weight vectors over top-level taxonomy nodes — ships with one persona, `generalist` (broad/flat weights, low `seed_confidence`), as the zero-question cold-start default; the other 4-6 personas are Joey's product-research call (issue #8, `docs/curation/persona-catalogue-fit.md`) and are a data-only addition, no code changes, once chosen. `backend/src/curation/userInterests.ts` adds the engine's first per-user data seam: `resolveEffectiveTaxonomy()` is a pure, node-by-node three-tier fallback — real observed `taxonomy_nodes` row → persona seed (a decaying prior, never standing config per principle #2) → global `data/taxonomy.json` (today's founder-tuned behavior, unchanged) — fed straight into the unmodified `scoring.ts` (it already took a generic `TaxonomyNode[]`). `sessionBuilder.ts` gained one optional `userInterestsProvider` field; omitting it (every caller/test before this change) is byte-identical to before. Ships with `InMemoryUserInterestsProvider` only (keyless, mirrors `Enricher`/`CostEventSink`'s pluggable-I/O pattern) — a real Postgres-backed provider is designed (`createUserInterestsProvider.ts`, env-gated on `DATABASE_URL`) but deliberately not built yet, since backend DB credentials for the now-provisioned Supabase project aren't wired into `src/config/env.ts`. `0014_persona_seed_source.sql` widens `taxonomy_nodes.source`/`user_interests.reason` to accept persona-seed provenance and gives `app_users.persona_seed` an explicit `'generalist'` default (a written row, not an implicit app-logic assumption) — not yet applied to the live Supabase project. Seeding is lazy (first `buildSession()` call for a user with zero rows and a persona seed) and top-level-only by design: a freshly-seeded user's `taxonomy_nodes` table stays honestly sparse, and the 4-slot archetype menu + ~30% exploration floor are unaffected because archetype-pool membership is assigned upstream of scoring and never depends on relevance score (verified with an adversarial-persona regression test).
- **First-party behavioral event capture — backend + contract shipped** (personalization-and-depth-plan.md Step C). `backend/src/types/events.ts` is the zod contract (a discriminated union keyed on `type`, matching `0009_events.sql`'s check constraint exactly: `card_shown/picked/skipped_at/finished/voice_command/thumbs/saved/session_built/session_rated`). Two contract decisions made explicit here because they're expensive to reverse: (1) **`events.episode_id`/`events.session_id` (uuid FK columns) are always written `null`.** The client's real identifiers are catalogue slugs (`data/session.json` episode ids like `"lex-353-whyte"`, session ids like `"2026-07-08-morning"`), not uuids matching the `episodes`/`sessions` tables — there is no live catalogue-ingest-to-Postgres pipeline yet, so those FKs cannot resolve. Durable identity travels in the jsonb `payload` instead (`episode_slug`/`session_key`). `0009_events.sql` is deliberately NOT modified and no companion column was added — this is an accepted, known gap, not a fix; a future ingest-pipeline pass should either populate the FKs opportunistically or replace them. `user_interests.episode_id` (0006_user_interests.sql) has the identical gap for the same reason. (2) **`finished`/`skipped_at` payloads carry a mandatory `source: "observed"|"manual_stopgap"`.** The web client hands playback off to external apps and cannot observe real position (`DECISIONS.md` 2026-07-08); its "Done ✓" button is a declared click, not observation, so it must be tagged `manual_stopgap` rather than silently presented as `observed` — principle #2 ("state observed, never declared") applies to signal provenance, not just UI copy. The learning job (`backend/src/curation/interestLearning.ts` + `learningRepository.ts` + `eventStore.ts` + `learningCursor.ts` + `learningJob.ts`, CLI: `npm run learn-interests`) implements 03_CURATION_SPEC.md's "Learning from signals" table, scoped deliberately to **node/topic-level durable taste only** — the spec's per-episode and per-format skip penalties are query-time fatigue concerns already living in `scoring.ts`, not state this job mutates. The critical invariant ("something different" must never permanently mutate taste) is enforced structurally: such signals are still audited into `user_interests` (a zero-delta row) but never reach `taxonomy_nodes.weight`. Negative signal from the Stretch slot is damped 0.4x relative to Deep-learn (`curation-practices.md` sec.4's explore-slot-damping recommendation) — positive Stretch signal is never damped. `0015_learning_cursor.sql` (additive-only, no existing table touched) tracks a per-user `(ts, id)` high-water mark into `events` so the job is idempotent/resumable. This learning-write repository is intentionally separate from the persona-seeding write path above (both touch `taxonomy_nodes`/`user_interests`, for different operations — onboarding-seed vs. observed-signal); unifying them is deferred. Two items scoped out on purpose: a `never_this_show` voice command has no home yet (show blocklist isn't a taxonomy-node concept — needs a small table near `saved_items`, not built here); `thumbs`-up reuses the `more_like_this` audit reason rather than getting its own enum value (accepted overload, no migration). `docs/curation/events-client-integration-spec.md` is the handoff doc for client instrumentation (a DOC only — `app.js` is untouched by this change) — it maps every existing `cp_events` call site in `app.js` to a canonical type and flags real gaps: `card_shown`/`thumbs`/`voice_command`/`session_rated` don't exist in the client yet, and `skipped_at` should NOT be faked on web (real skip telemetry waits for iOS's in-app position tracking) since approximating it would itself be a declared-not-observed violation.

## 2026-07-24 (depth-laddered learning paths — Step D)

- **`data/ladders.json` schema adopted** (docs/curation/personalization-and-depth-plan.md §6): a ladder is `{id, node, title, status, estimated_total_min, rungs[]}`; each rung is `{id, level, subtopic, goal, episode_ids[], prerequisites[]}`. Refines the plan's original sketch by making `prerequisites` reference explicit rung `id`s rather than `level` strings — levels repeat across parallel deep-dive branches, so they can't double as a graph key. **Prerequisites are advisory ordering metadata only, never access control** — no rung is ever locked behind another in the UI; this is a hard product-principle call (no dark-pattern gating, CLAUDE.md #1), not just an implementation detail.
- **Token-light builder, zero LLM calls in v1.** `backend/src/curation/ladderBuilder.ts` deterministically buckets an already-tagged episode pool (depth/format/release date, plus curator-supplied role/subtopic hints — see `docs/research/fusion-ladder-curation.json`, which mirrors the existing `fusion-candidates.md` hand-authored-and-reviewed pattern) into overview → fundamentals → parallel deep-dive branches → frontier. Rung `goal` prose is never machine-generated — the builder requires an explicit human-authored line per rung or refuses to build. An optional one-time, build-time, human-approved-via-PR LLM assist is documented as a future extension point (for scaling past hand-curated flagships) but is **not implemented or called anywhere in this change**.
- **Known scale blocker, deliberately deferred:** `data/discover.json`'s ~984 items have no `depth`/`format` (only `data/session.json`'s 27-episode hand-curated pool does — that enrichment is produced by `Enricher.classifyTier1()` but isn't persisted back into discover.json today). The ladder builder excludes and reports any discover.json episode matching a target node rather than silently dropping it. Backfilling discover.json enrichment is out of scope here; needed before ladder #2 on a node whose material lives mainly in discover.json.
- **Flagship ladder shipped as `status: "draft"`, not surfaced.** `engineering/energy-fusion` ("Understanding fusion energy," 7 rungs, 12 episodes, ~19.4h) is built entirely from `data/session.json`'s enriched fusion pool via `npm run build-ladder`. Flagged for founder sign-off: the `overview` rung uses `cbc-general-fusion` (a CBC Ideas documentary nominally about General Fusion specifically) as a proxy landscape episode — none of the 12 candidates is a true neutral "here are the six approaches" survey. Ship as-is or hold for a dedicated overview episode is Joey's call.
- **Copy-rule consolidation.** `backend/src/copy/rules.js` is now the single source of truth for the banned-phrase list + word-count helper, previously defined independently (and driftably) in `backend/test/copyRules.test.ts` and `tools/refresh/merge.mjs`. Deliberately plain CommonJS (not TypeScript) so the dependency-free, no-build-step `tools/refresh/merge.mjs` can import it directly; a hand-authored `rules.d.ts` gives the TypeScript side normal types with no `allowJs` needed. Both call sites' behavior is unchanged (byte-identical banned list, byte-identical word-count logic) — only the ownership moved.
- **Client surfacing (why-line badge, entry-rung UI, `data/ladders.json` fetch wiring) is explicitly out of scope for this change** — `app.js`/`sw.js` are untouched. That work is a separate, careful client-integration pass to avoid colliding with concurrent client-side work in flight. The reference algorithm for observed-not-declared entry-rung inference ("any one episode picked in a rung ⇒ that rung is reached; recommend the earliest unreached rung whose prerequisites are satisfied") is written once, as a pure function, in `backend/src/curation/ladderProgress.ts`, and specified for client consumption in `docs/curation/ladders-client-spec.md` — the future client pass should port or call this rather than re-deriving the rules.

## 2026-07-24 (breadth-catalog classification methodology — design only)

- **Founders no longer trust `data/breadth-classification.json`.** Root cause confirmed: the "8-slice opus refinement" (`docs/DECISIONS.md` 2026-07-09 "scale day") classified from title + Apple genre only (`source: "llm-title-genre"`) — concretely, *Science Friday* (general-audience science, `apple_genre: "Life Sciences"`) is tagged `medicine/biology` at `confidence: "low"`. Compounding cause: `data/catalog-breadth.json` show records carry **no description field at all**, so the richer per-show signal a better classifier needs (description + episode sample) doesn't exist yet and must be fetched, not just re-prompted for.
- **ADR-0006 adopted** (`docs/adr/0006-podcast-classification-methodology.md`, design-only, not implemented): a Tier-0/Tier-0.5/Tier-1/Tier-2 cheap-first cascade mirroring `02_ARCHITECTURE.md`'s enrichment pipeline — Tier 0 (genre-map prior, free, never final) → Tier 0.5 (new: fetch each show's RSS feed for description + ~5–10 recent episode titles/descriptions, free but real wall-clock/politeness cost, not built yet) → Tier 1 (`claude-haiku-4-5`, multi-label + per-node confidence + `needs_review` flag, taxonomy prompt-cached across the batch, Message Batches API for the 50% discount) → Tier 2 (Sonnet 5, gated on low Tier-1 confidence or Tier-0/Tier-1 disagreement, escalates a minority of shows only). Full-transcript-always and genre-map-only were both considered and rejected in the ADR (cost and accuracy respectively).
- **Cost model**: Tier 1 alone across 19,787 US breadth shows ≈ $25–85 depending on batch/cache adoption; full Tier 1 + Tier 2 (assuming ~15–25% escalation) ≈ $100–200. Pilot (50–100 shows, spanning genres + known-hard cases including issue #12's fusion/fission confusion) costs under $5. The 121,786-show international batch (`data/catalog-breadth-intl.json.gz`) is explicitly out of scope for this pass — extrapolated ~$700–900, deferred pending a founder scope call, separate from an unresolved cross-lingual classification-quality risk (the taxonomy is English-labeled).
- **Budget-guard routing decided, not yet built**: this is a one-off batch job, not runtime traffic, so it must not run under the production `DAILY_BUDGET_USD` cap ($2.00 default — would take years to clear a $100–200 spend). The existing `BudgetGuard` class already accepts an explicit `dailyBudgetUsd` override in its constructor and already tier-routes by `tier1_*`/`tier2_*` operation-name prefix with zero code change needed; the classification tool will construct its own guard instance with a founder-approved `--budget-usd` ceiling and write to `cost_events` under a synthetic `userId` so the batch's spend is audited exactly like any other LLM call.
- **Explicitly not done in this pass**: no LLM call was made, no RSS fetch step was built, no classification output was written or committed. This is the plan only; implementation (pilot run, then scaled run) awaits explicit founder go-ahead per the commissioning instructions.

## 2026-07-24 (breadth-catalog classification: execution engine pivot + tooling)

- **API pilot approved, then superseded before any run.** The founders approved a real-API pilot (Anthropic API, `claude-haiku-4-5` Tier 1 + Sonnet 5 Tier 2, hard `--budget-usd 3` cap) for ADR-0006's design. Before it ran, two things happened in sequence: (1) the root `.env`'s `ANTHROPIC_API_KEY` was found empty in this environment (template only, no real credential) — a genuine blocker, surfaced rather than worked around; (2) independently, the founders changed the execution engine entirely — **all classification now runs on the Claude Max plan via Claude Code cron routines** (the same pattern as the nightly content refresh, `docs/nightly-refresh-cloud.md`), not the Anthropic API. No dollar was ever spent; zero API calls were made under either the old or new plan.
- **Tooling built to the (unchanged) methodology**: `tools/classify/prepare-batch.mjs` (Tier 0 genre-map prior + Tier 0.5 RSS fetch — description + 5–10 recent episode titles/descriptions, never full transcripts by default; deterministic, keyless; tracks progress + retry-with-backoff for dead feeds in `data/classify-progress.json`), `docs/agents/runner-prompts/classify-batch.md` (the classification agent's contract — Tier 1 fresh batches and Tier 2 escalation batches, both driven by the same prompt), `tools/classify/merge-results.mjs` (validates the agent's output — taxonomy node ids, confidence bounds, copy rules on the new `display_title`/`blurb` fields — and merges into `data/breadth-classification.json`, idempotently). Full contract: `tools/classify/README.md`.
- **Verified end-to-end against the real catalog** (deterministic parts only — no agent/LLM step invoked): `prepare-batch.mjs` fetched real RSS feeds for 10 live shows across two separate batches with zero overlap; the very first show fetched was *Science Friday* itself, and its real fetched signal (general-audience science description, wide-ranging episode topics) directly contradicts the genre-map's `medicine/biology` guess — a live confirmation the methodology fixes the documented bug, not just a hoped-for one. `merge-results.mjs` was exercised with hand-crafted results covering the happy path, a deliberate copy-rule violation (correctly nulled the display fields and force-flagged `needs_review`, including a violation — "explores" — the test data tripped by accident, a good sign the gate is real), a deliberate invalid taxonomy node (correctly rejected and left the show untouched for a future batch), and a repeat run (correctly idempotent, zero duplication). All test-induced changes to the tracked `data/breadth-classification.json` were reverted before commit — no fake/test classification data ships in this PR.
- **Schema stays backward-compatible**: `topics` remains a flat `string[]` (so `tools/topic-coverage-report.mjs` and any other existing consumer keep working unchanged) with the richer `topic_confidences: [{node, confidence}]`, `needs_review`, `rationale`, `display_title`, `blurb`, `source`, `tier`, `batch_id`, `classified_at` added alongside — additive, not a breaking migration.
- **Founder decisions locked in**: `needs_review` output is never auto-applied, always held for a human pass (principle #2); international (121,786 shows) is out of scope, US breadth only; curated tier (`data/catalog.json`/`data/discover.json`) always wins over breadth reclassification — enforced structurally here, since this pipeline's tooling has no write path to either curated file at all.
- **Two new copy-rule constants added to the single source of truth** (`backend/src/copy/rules.js`/`.d.ts`): `MAX_DISPLAY_TITLE_WORDS` (8) and `MAX_BLURB_WORDS` (30), for the new Foray-authored tile fields — additive, no existing export changed.
- **Explicitly not done in this pass**: no classification batch was run (fresh or escalate), no `docs/agents/runners.md` registration, no cron schedule configured — the orchestrator runs the first test batches and decides pacing/cadence using this tooling, per the commissioning instructions.

## 2026-07-30 (home page: subject queues instead of single-episode cards)

- **Product call (Joey), Wyatt sign-off given verbally, not yet reviewed against the actual diff.** Motivation: four individual episode titles on the home screen don't differentiate Foray from any other podcast app's recommendation row, and read as exactly the failure mode `03_CURATION_SPEC.md` names ("your 3 usual shows + 1 random thing, a subscription list with extra steps"). Requested shape: 4 subject-level cards (already-interested or adjacent topics) plus a Continue card for the in-progress episode.
- **Turned out to be a client-only change, not a data-model change** — corrects what was described to Wyatt beforehand. The live home page (`app.js`'s `buildCards()`) does its own lightweight per-branch ranking client-side and only borrows episode *records* from `data/session.json`'s `episodes` map; it never reads the backend's curated `cards[]` (archetype/why-line/alternates from `sessionBuilder.ts`). So this change doesn't touch `sessionBuilder.ts`, `data/session.json`'s schema, or anything the iOS client codes against — it's scoped entirely to `app.js`.
- **Implementation**: `buildCards()` now keeps each ranked branch's whole candidate chain (`items`, capped at 3) instead of just the top pick (`item`, kept for backward-compat lookups). `miniCard()` renders the branch's taxonomy label (`subjectLabel()`, `data/taxonomy.json` top-level node label) + episode count + total duration, and links to a new in-app route (`#/subject/<branch>`) instead of linking straight out to the episode. `renderPlaylistDetail()` is generalized to resolve either a saved playlist (`cp_playlists`, existing) or a subject queue (`subjectQueueById()` — reads live from `state.cardSlots`, never persisted, no remove button) — same list/queue UI serves both, since a subject card behaves like an auto-built, one-day playlist. Continue (`bannerHtml()`/`currentContinue()`) is unchanged — it was already a separate element above the 4-card grid, already satisfying "plus where I left off" before this change.
- **Not done in this pass**: the `sessionBuilder.ts` archetype-slotting system (deep-learn/stretch/narrative/comfort scoring, why-lines, alternates) still runs and still produces `data/session.json`'s `cards[]`, but nothing in the web client consumes it for the home page grid anymore beyond opportunistic why-line reuse (`whyFor()`). Whether to wire the real archetype-scored picks into subject-card selection (vs. the current simpler client-side branch ranking) is an open follow-up, not resolved here.

## 2026-07-30 (subject-card selection: real exploration floor, not a live backend)

- **Explicit product delegation (Joey): "solve that now... make smart decisions."** Investigated wiring `sessionBuilder.ts`'s real archetype scoring into subject-card selection, as flagged in the prior entry. **Decided against standing up a live per-user backend to do it** — deliberately, not by default. The deployed web client (`vercel.json`: static build, `node tools/web/prepare-dist.mjs`, no serverless functions) has no live backend today; `data/session.json` is a single hand-authored fixture shared by every visitor, never regenerated on a schedule (`build-session` is a manual CLI script, not called from any CI workflow or cron). Standing up real per-user session-serving would mean provisioning/wiring the already-designed-but-unbuilt Postgres/Supabase `UserInterestsProvider` (`createUserInterestsProvider.ts`, gated on `DATABASE_URL`) behind a new deployed API surface — a genuine infra/secrets change. That stays outside what gets decided in a chat aside even under an explicit delegation; it needs its own scoping pass and is Wyatt's call per `docs/roles.md`, not bundled into this one.
- **What shipped instead, entirely client-side in `app.js`** (no backend/schema touched, consistent with the prior entry's scope): `buildCards()` now assigns real archetype-style **roles**, not just ranks branches. One of the 4 slots is a structural **stretch** pick — deliberately drawn from outside the user's top ~60%-by-interest branches (real signal: `state.interests`, seeded from `data/taxonomy.json`'s authored weights, refined by local overrides and observed history), preferring one not shown recently. This replaces the prior implementation's only exploration mechanism (a `Math.random()` jitter term that could land on a low-interest branch or could just as easily not) with a guaranteed floor — actually enforcing product principle #1's "hard ~30% exploration floor" for the first time on the live web client, instead of approximating it by chance. Verified via 8 rebuilds in a live session: stretch count was `1` every time, never `0` or `2`.
- **Freshness, the one other scoring.ts component honestly portable client-side**, now orders each branch's candidate queue by `release_date` recency instead of pure shuffle — `quality`/`depth`/`evergreen` from the real formula are not portable (discover.json's ~1080 items carry `release_date`/`topics`/`duration` but zero `depth`/`format`, confirmed by direct inspection; only the ~27-episode curated `session.json` pool has those fields, too small a slice to run the full formula meaningfully against the real live pool).
- **UI**: the stretch card gets a visible "Stretch" badge (`.mc-stretch`, `styles.css`) — the home page previously gave no indication which of the 4 picks (if any) was the deliberate outlier, silently breaking the "one deliberately outside what you already like" promise from the product principles. It's now honestly labeled.
- **Follow-up still open, now narrower**: real per-user server-side scoring (the full `relevance + freshness + quality − fatigue` formula, `sessionBuilder.ts`'s why-lines/alternates) remains unused by the live client. Wiring it in requires the live-backend decision above, which is intentionally not made here.

## 2026-08-06 (home page: explainer + card hierarchy fix)

- **Direct user feedback on the live deployed site** (jw-incorporated.github.io/foray, first visit after PR #82 merged): "I don't have any clue what this app does," and separately, on a subject card: "it's certainly not clear that it's more than one podcast... I have no clue how they relate, what subject I'm about to learn, or that the 3 podcasts overlap in any way." Both confirmed directly against the live page — the header was bare (`☰ Foray ↻`, no tagline anywhere) and `miniCard()`'s h3 rendered the lead episode's title as the headline, with the subject label demoted to small kicker text above it — so a subject queue visually read as one episode with a stray metadata line, not a themed group.
- **Fix scoped to legibility, not aesthetics** (the user separately deferred a full visual-identity pass to a later, bigger conversation — this is not that). Two changes, both `app.js`/`styles.css` only:
  1. `miniCard()`'s heading is now the subject label (`subjectLabel()`), not the lead episode's title. A new `subjectBlurb()` states plainly what actually connects the queue's episodes — the real fact (they share a taxonomy branch), expressed as the real shows involved ("All from The War on Cars." / "From X, Y, and N more.") — instead of implying a curatorial narrative the grouping doesn't have. The lead episode's title survives as a secondary "Starts with ..." clause.
  2. A dismissible intro block (`introHtml()`, `cp_intro_dismissed` in localStorage) explains the model in two sentences above the card grid on first visit: what the four queues are, and that one is a deliberate stretch pick. Dismissal persists; returning visitors don't see it again.
- **Not done here, on purpose**: no visual/theme redesign (colors, type system, overall look) — flagged by the user as real ("what makes this any different... other than it looks shitty") but explicitly deferred to a separate pass since it's a bigger, more subjective, more Joey's-call project than a copy/hierarchy fix.

## 2026-08-06 (first visual design pass)

- **Explicit go-ahead**: "begin working on making it look better, please." First real design pass on `styles.css`, no `app.js` structural changes. CSP stays untouched (`style-src 'self'`, no inline styles anywhere in `app.js` — confirmed via direct grep before starting, kept that discipline) and no web fonts (CSP has no permissive `font-src`) — typography differentiation comes from a system-font serif stack (`Georgia, "Iowan Old Style", "Palatino Linotype", ui-serif, serif`) for headlines only, paired with the existing sans body copy.
- **Root cause of "looks bare/flat" partly identified**: the dark theme (`:root`) was already reasonably considered (navy `#0d1117`, blue accent, gold accent), but the `@media (prefers-color-scheme: light)` override was a lazy gray inversion with zero elevation — flat white-bordered cards on off-white read as bare. Every screenshot taken this session rendered in light mode (the automation browser's default), so what looked "generic" was specifically the under-designed half of an already-half-decent system.
- **Changes**: warm off-white light palette (was cold gray) with theme-aware shadow tokens (`--shadow`) for real card elevation in both themes; serif headlines on card subject names, the subject-queue page header, and the topbar wordmark; branch color moved from a full-height card border (read as a spreadsheet row) to a small dot on the kicker line; consistent shadow applied to cards, episode rows, and the playlist-search input/button for visual cohesion.
- **Verified in both card and queue-detail views** via browser automation, light mode (dark mode not independently verified this pass — same token system, should track, but not confirmed pixel-by-pixel).
- **Not done here**: no icon/illustration system, no motion beyond the existing tap-scale, no changes to the in-app player UI (`#foray-player`) or drawer — this pass touched only the home page and subject-queue page, where the user's feedback was specifically pointed.

## 2026-08-11 (segment anchoring, the chapters investigation, and a starter-kit merge)

- **Playback ruling (Wyatt), resolving #63 §3's open fork:** a Foray plays
  **seek-and-stop against the publisher's original enclosure**. It never
  produces a concatenated or otherwise derived audio artefact. This was the
  posture `docs/marketing/05-legal-risk-memo.md` §1 and #63 already argued for;
  it is now decided rather than assumed, because a product mockup under
  consideration described the feature as "clipping" and "stitching," which reads
  as the rejected Stitcher/Luminary behaviour even though the same UX is
  buildable the compliant way. Copy must follow the mechanism: no user-facing
  language implying we produce a new audio file.
- **Chapters were investigated as a DAI workaround and rejected on two
  independent grounds** (`docs/adr/0007-segment-anchoring.md` option 2).
  *Structurally*: a `<podcast:chapters>` tag points at a static JSON file at a
  fixed URL — the same bytes for every listener, with no per-listener mechanism
  in Podcasting 2.0 and no way for a stitcher to correlate the chapters fetch
  with a particular stitch. So chapter offsets are authored against the
  un-stitched master and drift exactly like our own timestamps.
  `player/seek-policy.js` already names this precise case as its canonical
  `FOREIGN` example. *Empirically*: probed all 213 curated shows' live feeds
  (209 fetched) — only **10 (4.8%)** publish chapters at all, and the split is
  **7/136 (5.1%) of DAI shows** vs 3/73 (4.1%) of non-DAI. The seven are small
  indie shows on Buzzsprout/Transistor/Captivate, several of them thin (Acquired
  publishes chapters on 1 of 216 episodes). There is no version of this that
  unlocks a meaningful catalogue. The same probe found `<podcast:transcript>` at
  roughly 3× chapter coverage on DAI shows (23/136, 16.9%), which is what
  pointed at the accepted option.
- **ADR-0007 accepted: segments are dual-anchored.** Every segment carries a
  timeline cache (`start_sec`/`end_sec` + `reference_duration_sec`) *and*
  content anchors (`start_anchor`/`end_anchor`, verbatim transcript text at each
  edge). Timestamps are an optimisation; the anchor is the truth. At playback,
  a drifted duration triggers anchor re-resolution rather than a bad cut, and an
  unresolvable anchor skips the segment rather than playing the wrong place.
  The load-bearing reason is **durability of extraction output**: a segment
  stored as bare timestamps is scoped to one copy of one file and rots when a
  publisher re-uploads, re-encodes, or changes ad load. This was decided *before*
  any bulk extraction ran, because getting it wrong invalidates every segment
  produced. Consequence for #65: the validator's hard `dai_suspected: false`
  requirement relaxes to "a DAI source is permitted iff both anchors are present."
  It does **not** make DAI sources v1-playable — that still needs downloads (#29).
- **Also recorded (DAI exposure is growing):** 903 of 1,309 playable items in
  `data/discover.json` are now `dai_suspected` — 69%, up from the 64% recorded
  when #63 was written. The timestamp-only eligible pool is shrinking, which is
  an independent argument for anchoring.
- **Segment-extraction architecture written** (`docs/curation/segment-extraction-pipeline.md`),
  reusing `tools/classify/`'s proven prepare → agent → merge shape rather than
  inventing a second one. Two findings shaped it: full-corpus Whisper is ≈$20k
  (73,719 episodes) and is *dollar*-bound not token-bound, so the fan-out routes
  to free `<podcast:transcript>` only; and the merge validator must exist before
  extraction runs, since an LLM paraphrasing an anchor produces a boundary that
  can never be resolved and fails silently at playback.
- **`data/segments.json` schema + `tools/segments/merge-segments.mjs` shipped
  (#106).** The durable output of the extraction pipeline, and its validator,
  built before any extraction runs. Two calls worth recording because they are
  expensive to change once a fan-out has written thousands of records:
  - **What "verbatim" means for an anchor.** Both sides are canonicalised —
    NFKC, lowercased, apostrophes elided, every other non-alphanumeric run
    collapsed to a single space — and compared as a whole-word subsequence.
    That forgives only artefacts of *how text was written down* (case, doubled
    spaces, hyphenation, smart quotes, `that's` == `thats`) and rejects every
    artefact of *rewriting* (`that is` for `that's`, `30` for `thirty`,
    synonyms, tense). Punctuation becomes a space so `hand-waving` matches
    `hand waving`; apostrophes are deleted rather than spaced so contractions
    do not split. Digits are deliberately not spelled out: the test that
    matters is whether a resolver could find the anchor in the *listener's*
    transcript, and it could not. Two extra guards, free once the transcript
    is indexed: an anchor under 4 words is not a location, and an anchor whose
    every occurrence is >120s from the timestamp it claims means the timeline
    cache is junk even though the words are real.
  - **Provenance lives in the record.** Each segment stores
    `transcript_source` (`publisher` | `asr-local`) and `dai_suspected`, so
    the file is self-validating: `merge-segments.mjs --check` re-enforces
    everything except verbatim-ness offline, which is what lets CI reject a
    malformed or hand-edited `data/segments.json` without refetching a single
    transcript. ADR-0007's DAI relaxation is enforced there too — both anchors
    required on a DAI item; a non-DAI item may omit them but merges
    `needs_review: true`, because a publisher can re-upload a static file too.
  - Idempotency is byte-level: an unchanged merge writes nothing at all, not
    even a fresh `built_at`. 39 tests, one deliberate violation per check;
    mutation-verified (see the PR) rather than assumed.
- **Starter-kit merge** (`JW-Incorporated/starter-kit`, reviewed 2026-08-11).
  Foray was missing several hard-won items:
  - **`CLAUDE.md` had no "never babysit your own PR" rule** — the kit's #1
    lesson (~69% of Swift2's scheduled agent spend) and marked KEEP VERBATIM.
    Foray had it only as a checklist item for *new routines* in
    `routine-invariants.md`, which interactive sessions never read — and
    interactive sessions are where the loops were armed. Now in `CLAUDE.md`.
  - Added: never-discard-uncommitted-work (with the Windows/CRLF false-alarm
    note), don't-stop-to-ask, definition of done, the PR TL;DR convention, and
    the instruction to propose lessons back to the starter kit.
  - **`.github/workflows/automerge-nightly.yml` gated on branch name, not
    path** — the kit is explicit that the safety model must be path-based. This
    was wrong in both directions: any PR from a `nightly/*` branch auto-merged
    on green *regardless of what it touched* (app.js, CI workflows, backend/),
    and the `classify/*` runners' PRs never auto-merged at all, which is why
    PR #86 sat open for 8 days. Now path-gated to `data/`, with a `hold` /
    `founder-decision` label escape hatch and an `AUTOMERGE_FREEZE` repo
    variable as an instant kill switch — both of which matter materially more
    with a large fan-out about to run.
  - **`docs/agents/runners.md` was fiction**: it listed two runners, both
    "pending", while seven were live. This is verbatim the kit's lesson *"a
    registry that is not enforced becomes fiction."* Rewritten with the real
    fleet, plus the model-tiering section `routine-invariants.md` referenced
    but which did not exist.
- **Flowing back to the kit** (not done in this pass, owed): Foray's
  `routine-invariants.md` documents a gotcha the kit's copy lacks — the API
  accepts `mcp_connections: []` with a 200 and silently keeps the
  `Claude_Code_Remote` connector, so removing it is UI-only. That belongs in
  the starter kit, per its own "keeping it alive" rule.
- **Auto-merge widened to tiers 1–4 (Wyatt, 2026-08-11).** Goal stated
  directly: *"get to the point where I pretty much never approve a PR and we
  merge most items just after autonomous checks."* The governing principle is
  the starter kit's — *removing a human gate raises the bar on whatever is
  upstream of it* — so the allowlist was widened only where a mechanical check
  already catches the bad version of the change, and the gap was built where it
  didn't.
  - **T1 `data/`** — already covered by `ci.yml`'s data invariants (session
    refs, cross-file dupes, taxonomy coverage, `audio_url` scheme, tokened-URL
    secret leaks, DAI flags in both directions) plus `copyRules.test.ts`.
  - **T2 `docs/`** — low blast radius, with governance paths denied.
  - **T3 `player/`, `tools/`, `test/`** — already have `node --test` suites in
    a required check.
  - **T4 `app.js`, `styles.css`, `search-engine.js`** — gated on new coverage
    built in this change (below), because `node --check` is a *syntax* check
    and would have passed an XSS regression, a CSP violation, or a
    `javascript:` URL.
- **A DENIED list now overrides the allowlist**, containing the files that
  define the gates and the operating rules: `.github/`, `.claude/`, `CLAUDE.md`,
  `docs/DECISIONS.md`, `docs/adr/`, `docs/roles.md`,
  `docs/agents/routine-invariants.md`, `backend/src/config/`. The reasoning is
  structural, not stylistic: **a bot that can auto-merge a change to its own
  checks has no checks** — one PR widens the allowlist or rewrites the standing
  instructions every future session reads, and every downstream guarantee is
  gone. Same shape as keeping `Claude_Code_Remote` off every routine but the
  auditor. `.github/`/`.claude/` are denied *and* absent from ALLOWED, so a
  careless future widening still cannot expose them. Verified against 12 path
  cases including the mixed one (a single denied file blocks an otherwise
  allowed PR).
- **`test/app-security.test.js` (new, 18 tests)**: `esc()` behaviour (all five
  entities, script-tag and attribute-breakout payloads, ampersand-first
  ordering, null/undefined coercion), `safeUrl()` scheme rejection
  (`javascript:` incl. mixed case, `data:`, `vbscript:`, `file:`, `blob:`,
  protocol-relative, malformed), and static invariants that were previously
  enforced by nothing: every interpolated `href`/`src` passes through
  `safeUrl`, no inline `style=`, no `<script`, no `javascript:` in source, and
  localStorage keys keep the `cp_` prefix. Dependency-free — loads `app.js` in
  a `node:vm` with a stub whose `fetch` never settles, which parks the
  top-level `init()` at its first await so the hoisted declarations are
  reachable with no DOM work. **Mutation-tested**: an unguarded `href`, an
  injected inline `style`, and a weakened `esc()` were each confirmed to fail
  the suite before `app.js` was restored byte-identical.
- **`test/suite-integrity.test.js` (new)**: committed per-suite test-count
  floors. `test/` and `player/` being allowlisted means a PR could otherwise
  gut a suite and still pass CI — a suite with nothing in it passes trivially,
  and the two-step version (weaken the gate, then land what it would have
  caught) involves no human at any point. Also fails when a new suite appears
  with no floor. Verified by truncating the security suite and confirming the
  build breaks. Honest limit, documented in the file: it cannot distinguish a
  real test from an empty one, and gutting the gate now requires editing two
  files rather than one — it makes deletion loud, not impossible.
- **Audit found while writing the above**: `${query}` and `subjectBlurb()` both
  looked like unescaped injection sites on grep. Neither is — `${query}` is
  assigned via `textContent`, and `subjectBlurb()`'s whole return value is
  wrapped in `esc()` at its single call site. No XSS existed; recorded so the
  next reader doesn't re-investigate.
- **Still open, and required before "never approve a PR" is honest**: nothing
  currently watches *what merged*. The account-wide auditor checks routine
  invariants, not merge outcomes. A weekly digest — what auto-merged, which
  paths, what landed with zero human eyes, as one evolving issue rather than
  one per run — is the missing complement. Also noted: `ios-kit` is not a
  required check in `protect-main`, which is harmless while `ios/` stays off
  the allowlist (it does) but would not be if that changed.
- **Deliberately not adopted: the `autonomous-templates/` Fable-orchestrator
  set.** It is a workflow change (orchestrator model, five agent roles, four
  enforcement hooks, `STATE.md`/`MAP.md`/`PLAN.md`), not a docs merge, and its
  hooks require `bash` + `python3` — the kit's own README flags Windows as
  needing WSL or a port. Its §9 guidance is adopted in spirit here regardless:
  *autonomy is bought with verification, not permission*, which is exactly why
  the segment merge validator is sequenced before the fan-out.

## 2026-08-12 (Lane B: the free-transcript corpus is now a list, not a guess)

- **`tools/segments/sweep-transcripts.mjs` shipped and run over all 213 curated
  shows** (issue #104), emitting `data/transcript-availability.json`. Nothing in
  the repo previously recorded where free transcripts are: the nightly pipeline
  never reads `<podcast:transcript>` and `data/discover.json` carries no
  transcript field. Every downstream lane — segment extraction, Joey's topic
  selection (A10) — now reads one file instead of re-probing feeds.
- **`has_timestamps` is a first-class recorded field, not a derivation left to
  callers.** `text/vtt`, `application/srt`, `application/x-subrip` and
  `application/json` carry a timeline; `text/plain` and `text/html` are prose
  and cannot anchor a boundary (ADR-0007). Plain text is the third most
  published format in the wild, so this distinction decides the usable corpus:
  of 8,012 transcribed episodes, **7,515 are anchorable and ~500 are not**. The
  preference order is deliberately duplicated from
  `backend/src/feeds/parser.ts`'s `TIMED_TRANSCRIPT_TYPES` (#103) rather than
  imported, because `tools/` is dependency-free and unbuilt while `backend/` is
  TypeScript; the sweep's test suite pins the copy so the two cannot drift
  silently.
- **The index stores availability, never bodies.** 8,012 transcripts at ~50KB
  is ~400MB against a 44MB `data/`. The script has no code path that fetches a
  `transcript_url`, a test asserts that structurally, and CI fails on any
  body-sized string reaching the file. Episode rows are kept only for episodes
  with a transcript or chapters (counts cover all 82,043) — 5.4MB instead of
  ~20MB of rows no lane can act on. `--all-episodes` overrides.
- **Measured coverage, 82,043 episodes across 212 fetched feeds: 9.8% carry a
  transcript — 13.3% of DAI episodes vs 0.2% of non-DAI.** This reproduces
  epic #102's finding on an independent run (its probe measured 13.4% / 0.7%;
  the non-DAI number is lower here because this sweep resolves each show's
  enclosure host live, and the disagreement is one or two shows changing
  bucket). The corpus is extremely concentrated: **30 of 213 shows publish any
  transcript at all, 25 publish a timed one**, and Stuff You Should Know
  (2,850) plus Odd Lots (1,251) are half of it. Chapters remain negligible at
  0.9%, consistent with the 2026-08-11 rejection of chapters as a DAI
  workaround.
- **Resumability is the design, not a nicety.** The run checkpoints atomically
  after every show to a gitignored `data/transcript-progress.json`; a SIGKILL
  mid-run was verified to resume at the next unswept show. The curated tier
  takes minutes, but the 19,787-show breadth tier is hours, and that run is
  only affordable if a crash costs one show rather than a day.
- **Failures are named, never a silent empty result.** Every failure mode
  carries a code (`HTTP_404`, `TIMEOUT`, `EMPTY_FEED`, `NOT_RSS`, `NETWORK`,
  `BAD_CHECKPOINT`) into the show record and the run summary, a corrupt
  checkpoint refuses to start rather than quietly restarting, and a run where
  no show succeeded writes nothing and exits non-zero. One real failure this
  run: omega tau (`CERT_HAS_EXPIRED`).

## 2026-08-12 (research corpus)

- **Research corpus data model** (`tools/corpus/`, PLAN: `docs/research/corpus/PLAN.md`,
  announcement: root `STATE.md`). The ~57-source research dossier
  (`docs/research/foray-research-dossier.md`) is scraped into a corpus DB that
  later feeds agent context, retrieval experiments, and an embedding backfill.
  Decisions expensive to reverse, recorded before ingestion ran:
  - **SQLite via built-in `node:sqlite`** (zero native deps), single file at
    `data-local/corpus/corpus.db` — **gitignored, not LFS**: the corpus is fully
    regenerable from the committed dossier + the network, so repo history is the
    wrong place for ~100MB of fetched bytes. Migrations are numbered `.sql`
    files tracked via `PRAGMA user_version`, shaped for a mechanical lift to
    Postgres+pgvector (the FTS5 index is isolated in its own migration; the
    `chunks.embedding BLOB` column stays NULL until a dedicated backfill pass —
    consistent with the DURABLE-WORK anti-list on speculative embeddings).
  - **`documents` is append-only fetch history; `chunks` exist only for the
    current document** of each source — history stays queryable, search never
    double-counts a refetched page.
  - **The dossier markdown IS the manifest**: titles/URLs/areas/why-notes are
    parsed verbatim (test-pinned), never hand-copied.
  - **Politeness is enforced twice**: per-process rate limiter (≥2s/host or
    robots Crawl-delay, robots.txt respected, honest UA with contact) plus a
    cross-process host gate (lock-dir mutex under `data-local/corpus/hostgate/`)
    because ingestion runs one process per dossier area in parallel and several
    hosts appear in multiple areas. Same "legally boring" posture as playback:
    fetch politely, archive privately, never republish.

## 2026-08-12 (research corpus, part 2: what may leave the machine)

- **The corpus stays local. What gets committed is an index plus digests we
  wrote ourselves** (`docs/research/corpus/digests.md` + `corpus-index.json`,
  exported by `corpus export-index`). The corpus as built is 40MB in
  `data-local/corpus/`: 37.5MB of raw bytes (13 PDFs dominate; one arXiv PDF is
  22.6MB), 1.1MB of cleaned markdown across 52 files, 2.2MB of SQLite. Size was
  never the blocker — 1.1MB against a 50MB `data/` is nothing. **The blocker is
  that this repo is public**, so committing the cleaned text of 54 third-party
  works is republication, not archiving. Product principle #3 ("legally
  boring") and the part-1 entry above ("fetch politely, archive privately,
  never republish") both point the same way, and the transcript-availability
  decision earlier the same day already set the precedent for this exact
  trade-off: **store the index, never the bodies.**
- **Every source carries a redistribution verdict with named evidence, and the
  default is deny.** 16 of 54 sources are `allow` — CC BY 4.0 (both
  podcasting2.org spec pages, four arXiv papers whose authors chose CC BY, one
  ACL Anthology paper), CC0 (podcast-namespace repo), MIT/BSD (pyannote,
  WhisperX, StreamingKit, docs-api), CC BY-SA 4.0 (TreeSeg, Wikipedia), and the
  Hunley v. Instagram opinion, which has no copyright at all under the
  government-edicts doctrine. The other 38 are deny: trade press, law-firm and
  law-review articles, vendor pricing and marketing pages, Apple documentation
  and forum threads, IAB/AES standards, GitHub issue threads (third-party
  comments are not covered by a repo's licence), and every arXiv paper left on
  arXiv's default licence — **which grants arXiv the right to distribute, not
  us.** That distinction is the single easiest mistake to make here.
- **Even the 16 permitted sources are not committed.** Their extractions are
  403KB of the 1.1MB. Three reasons not to take them: a corpus that is 30%
  present invites `grep` results that look authoritative and are silently
  partial; two of the permitted licences are copyleft (CC BY-SA) and one is
  BSD-4-Clause with the advertising clause, and this repo has **no LICENSE file
  of its own**, so importing share-alike text creates a licensing tangle nobody
  asked for; and the permitted set is precisely the set that is cheapest to
  re-fetch (arXiv, GitHub, a court CDN). The verdicts are recorded so the
  decision can be revisited on evidence rather than re-litigated from scratch.
- **"Our own words" is enforced by code, not by good intentions.**
  `export-index` refuses to write the index if any digest shares a ten-word run
  of prose with its own archived extraction (`verbatimRuns`, with a stopword
  floor so that listing five MIME types or five model names — facts — does not
  trip it). The parser also rejects any digest over 2500 characters. This is
  the same shape of guard as the transcript index's "no body-sized strings"
  rule in CI: make the wrong thing fail loudly instead of trusting review.
- **Regeneration is the answer to "but the cloud runners still can't query
  it."** They can't, and that is accepted. The dossier is the manifest, so any
  machine rebuilds the whole corpus with `init` → `load-manifest` →
  `ingest --all`, and the committed `content_sha256` per source says whether a
  rebuild matches this snapshot or the upstream page has changed since.

## 2026-08-13 (research corpus, part 3: embedding storage and model choice)

Recorded before the backfill ran, per workflow rule 4. The measured OUTCOME —
including whether semantic search earned the default — is appended to
`docs/research/corpus/PLAN.md`'s retro, not here; this entry is the choice and
its reasoning.

- **Vectors do NOT go in `chunks.embedding`. That column is dropped**
  (migration `0003_embeddings.sql`), and replaced by a registry
  (`embedding_models`) plus a join table (`chunk_embeddings`, composite PK
  `(chunk_id, model_id)`, `ON DELETE CASCADE` from `chunks`). 0001 reserved
  one BLOB column for "the" model; that reservation cannot survive a second
  one. Under the Postgres+pgvector lift this schema has been written for since
  day one, a vector column's **dimension lives in the column type**
  (`vector(384)`), so one column physically cannot hold a 384-dim and a
  768-dim model at once — you would end up adding a column per model and
  teaching every reader which one is live. The join table is the shape that
  survives a model swap: a new model is one registry row plus N vector rows,
  and the old vectors stay queryable while the new ones backfill. Keeping the
  old column beside the new table would have been worse than either: two
  places to write, one of them wrong.
- **The cascade is a correctness mechanism, not tidiness.** `corpus rechunk`
  rewrites `chunks` wholesale, and a vector keyed to a chunk id that no longer
  exists is the classic stale-index bug — search returning text that was never
  embedded, or missing text that was. `ON DELETE CASCADE` makes that
  structurally impossible instead of merely remembered, and the backfill's own
  coverage count then reports the corpus as unembedded, which is the truth.
  `rechunk` additionally refuses to run at all while any vector exists unless
  told `--drop-embeddings`, so the loss is always a decision.
- **Prefix asymmetry is stored as registry DATA, not written into caller
  code.** BGE-family models are trained so that queries carry an instruction
  prefix and passages carry none; E5 prefixes both sides, GTE neither. Applying
  the wrong convention degrades every single result and **raises no error** —
  the numbers just get quietly worse. So `query_prefix` and `passage_prefix`
  are columns on `embedding_models`, read by the retriever off the row it is
  already loading. `registerModel` refuses to redefine any space-defining field
  (dim, pooling, normalization, quantization, passage prefix) of an existing
  model in place, because every stored vector was produced under the old
  settings; the new configuration gets its own revision and its own id.
- **The blob format is bare little-endian float32, L2-normalized at write, no
  header** — element count is `byteLength / 4`, and a trigger asserts
  `length(vector) = 4 * dim` on every insert and update. Deliberately
  byte-compatible with **sqlite-vec**'s convention, so if brute-force scanning
  hundreds of vectors ever stops being instant, `vec0` becomes a virtual table
  over these same bytes instead of a re-encoding migration. Normalizing at
  write is what makes similarity a plain dot product over one flat matrix. A
  zero or non-finite vector throws at the write rather than being stored: it
  would score zero against every query forever, i.e. a chunk silently invisible
  to search.
- **The model is `Xenova/bge-small-en-v1.5` (384-dim, q8 ONNX, MIT), run
  locally on CPU via `@huggingface/transformers` — keyless, offline, $0.** No
  paid API, consistent with decision-authority item 3 and with this repo's
  keyless posture. (Anthropic publishes no embeddings endpoint, so "just use
  the model we already pay for" was never an option here.) Weights live in
  `data-local/models/` via an explicitly set cache directory — never
  `node_modules`, never a default global cache — and nothing about the model is
  ever committed.
- **The runtime is quarantined in `tools/corpus/embed/`, with its own
  `package.json`.** `onnxruntime-node` is ~250MB of native binaries, and
  `tools/corpus/` has advertised zero native dependencies since it was built.
  That is a stack change, not a feature, so it is opt-in: base corpus tooling,
  the entire fixture-only test suite, and `search --mode keyword` all work with
  the runtime **entirely absent**, and CI (which installs only
  `tools/corpus/package.json`) proves it on every PR by never installing it.
  `--mode hybrid` on a checkout without the runtime degrades to keyword search
  with a one-line notice rather than failing — the CLI must never hard-fail for
  someone who only wants keyword search.
- **The backfill is gated on measurement, and a negative result is a valid
  outcome.** The default mode flips only if a candidate beats fixed-keyword on
  both Recall@5 and MRR with no query regressing from found to not-found;
  otherwise the default stays `keyword` and the numbers say so. Vector-only is
  reported either way — it is the number that distinguishes "the model isn't
  helping" from "the fusion isn't helping". **Outcome: the default did not
  move; see `docs/research/corpus/PLAN.md`'s 2026-08-13 retro.**
- **A gate is only as honest as its metric, so the metric is now part of the
  decision.** This pass shipped with `Recall@5` computed as *hit rate* — 1.0 if
  any one of a query's expected sources came back — which scored the keyword
  baseline a perfect 1.000 and made "beat the baseline on Recall@5"
  unpassable by construction. Real recall (fraction of expected sources
  retrieved) puts that baseline at 0.867, with real headroom. `compareToBaseline`
  now reports a saturated baseline explicitly rather than returning a quiet
  `false`, refuses to credit a run that silently downgraded, and has tests.
  The standing rule: **a retrieval metric that reads 1.000 on the first try is
  a bug until proven otherwise.**
