# Architecture assessment — Foray

*Principal-engineer review, 2026-07-08 (night 3). Scope: everything in the repo as of commit 6869d98.
Method: full read of app.js / index.html / styles.css, all of backend/src + migrations + tests (suite
run locally: 184/184 green), ios/ForayKit + ios/App, data/*.json shapes, CI, git history, and the
brief/decision/marketing corpus. Cross-referenced against docs/marketing/07-premortem.md,
08-REQUIREMENTS-DELTA.md, and docs/NEXT-MORNING.md.*

**Headline.** The codebase is unusually disciplined for a three-night-old project — the risk is not
code quality. The risk is three seams that are already leaking:

1. The backend session builder **cannot yet produce a document the site can run the R1 blind test
   with** — no `builder` field, an incompatible episode-ID scheme, no artwork/link enrichment, and
   no publish path. R1 is the project's named most-important test; today it would ship broken.
2. The data layer **drifted within one day of the expansion-merge pattern existing**: 11 taxonomy
   branches live in discover.json but not taxonomy.json (so stars and sliders silently ignore them),
   and 6 episodes exist under two different IDs across session.json and discover.json.
3. All user state is **browser-locked in the same week a second tester started**. There is no
   identity of any kind, so even future syncing can't attribute what's already being logged.

Everything else found is healthy scheduled debt or deliberate simplicity worth defending.

---

## 1. Web client (app.js — 717 lines, vanilla, innerHTML templates, localStorage state)

**Verdict: appropriate for this phase. Do not introduce a framework, build step, or state library.**
The full-rerender pattern with `esc()`/`safeUrl()` discipline is the right altitude for a
feature-frozen (REQUIREMENTS-DELTA P2) menu client, and the pre-mortem explicitly names web polish
as the thing to do less of.

### Findings

- **F1.1 — Interest learning silently no-ops for all 11 expansion branches (defect).**
  `boostTopics()` (app.js:81–88) only bumps topics already `in state.interests`, and
  `loadInterests()` (app.js:72–77) seeds exclusively from taxonomy.json leaves. discover.json now
  carries `food/cooking-science`, `aviation/accidents`, `medicine/biology`, `linguistics/language`,
  `sports/biomechanics`, `nature/ocean-science`, `music/theory-production`, `math/puzzles`,
  `architecture/infrastructure`, `nature/animal-cognition`, `espionage/cold-war-tech` — none of
  which exist in taxonomy.json (still the 2026-07-07 seed set). Consequences:
  - Starring those items teaches nothing — contradicting the shelf copy "saving also teaches your
    interests" (app.js:375).
  - The interests panel can't tune them (`leafNodes()`, app.js:68–70, iterates taxonomy only).
  - `interestScore()` (app.js:288–293) pins every such item at 0.5 forever — they can neither rise
    nor sink relative to your real tastes.
  - `.dot-*` branch colors (styles.css:232–237) cover only the original six branches.
- **F1.2 — Same episode under two IDs → duplicate surfacing and split state (defect).**
  `fullPool()` (app.js:223–234) dedups by `id` only. Six episodes exist in both session.json and
  discover.json under different IDs (verified by normalized title, three additionally by
  `apple_track_id`): e.g. `lex-485-kirtley` ↔ `lex-fridman-podcast--david-kirtley-helion`,
  `conan-mcbride-returns` ↔ `conan-obrien-needs-a-friend--danny-mcbride`,
  `catalyst-pacific-fusion` ↔ `catalyst-shayle-kann--blueprint-fusion-power`. The same episode can
  be dealt as a card and appear in the splatter simultaneously; playing or starring one ID leaves
  its twin unplayed/unstarred; `cp_history`/`cp_seen` exclusions don't transfer between twins.
- **F1.3 — Data-attribute interpolation bypasses `esc()` (hardening gap, not exploitable today).**
  `starBtn()` (app.js:166), splatter rows (app.js:360), `playButtons()` (app.js:423), card
  `data-branch` (app.js:437), and `epRowHtml()` (app.js:498–499) interpolate `item.id`, `data-app`,
  `data-ctx`, `data-branch` into HTML attributes raw. Today IDs are repo-authored slugs, and the
  backend slugifier strips to `[a-z0-9-]` (candidateExtractor.ts:96–103), so there is no live hole —
  but it violates the stated invariant (CLAUDE.md: "All escaping in app.js goes through esc()") and
  becomes load-bearing the day IDs derive from live RSS titles. Close it while it's cheap.
- **F1.4 — Quests reference IDs that rot.** `cp_quests` stores bare `item_ids` (app.js:514–520);
  `renderQuests()` resolves through `state.itemIndex` and silently drops misses (app.js:531). When
  discover.json rotates content out (which the DURABLE-WORK catalog waves guarantee), saved series
  shrink without explanation. Stars solved this with snapshots; quests didn't.
- **F1.5 — The `itemIndex` global is a working but fragile pattern.** It is a render-side-effect
  registry: anything that renders must remember to call `snapshot()` first, and `renderQuests()`
  calls `fullPool()` *purely* for that side effect (app.js:528, "ensure itemIndex is populated").
  Not a bug — every current path feeds it — but it is the one place a future render path will
  quietly produce dead star buttons. Acceptable until the client is rewritten; do not abstract now.
- **F1.6 — Event-listener rebinding is actually sound.** innerHTML replacement discards old nodes,
  so re-binding inside `render()` (app.js:627–649) cannot stack handlers on surviving elements;
  `bindStars()`'s `_bound` guard (app.js:617–619) covers the overlapping-scope case. The asymmetry —
  `bindPickLogging()` (app.js:599–614) has no such guard — is a latent double-log if two scopes ever
  overlap. One-line fix, low priority.
- **F1.7 — Init: waterfall, not race.** session.json is awaited before the parallel trio
  (app.js:659–668) — one avoidable RTT, zero consistency bugs (nothing renders until all four
  settle; every consumer null-checks). Failure modes degrade gracefully: no discover → splatter
  falls back to session episodes (app.js:283–286); no taxonomy → neutral 0.5 scores. Leave it.

### When does this warrant a build step / framework?

Adopt tooling only when one of these fires — none has:

1. **The R5 fallback fires** and the web client becomes the product: in-page audio, position
   tracking, service-worker offline — i.e. real state machines with async lifecycles.
2. **app.js crosses ~1,500 lines** or a third mutually-interacting stateful surface appears
   (the current surfaces — cards, splatter, saved, quests — interact only through localStorage
   and full re-render, which is exactly why vanilla still works).
3. **A second contributor** joins the web client.

Then: Vite + TypeScript, Preact or lit, ported view-by-view behind the same data contract. Until
then, zero build pipeline is a feature: `node --check app.js` is the entire CI story for the site.

## 2. Data layer (data/*.json + the expansion-merge pattern)

Current sizes: session.json 16.0KB · discover.json 114.3KB (146 items ≈ 783 B/item) ·
catalog.json 49.7KB (64 shows — **not fetched by the client**; build-side bench only) ·
validated-links.json 15.3KB · taxonomy.json 3.2KB. Client payload ≈ 149KB raw, roughly 35–45KB
gzipped over the wire.

- **F2.1 — Schema versioning is half-disciplined.** All files carry `version: 1`, and backend zod
  schemas plus `test/dataSchemaCompliance.test.ts` pin session/taxonomy shapes. But session.json
  gained `builder` (2026-07-08) with no version bump and no schema update — `SessionDocSchema`
  (backend/src/types/session.ts:55–68) has no `builder`, and zod's non-strict default let the
  compliance test keep passing while the contract drifted. The identical drift exists in Swift
  (§6). Rule to adopt: **an additive field lands in every consumer schema in the same commit**;
  enforce by making at least one compliance test parse strictly.
- **F2.2 — The expansion-merge pattern has no integrity gate.** Commit b6929dc ("Horizon expansion")
  grew catalog + discover but touched neither taxonomy.json (→ F1.1) nor checked ID collisions with
  session.json (→ F1.2). CI validates only JSON parseability + session-internal refs (ci.yml:30–41).
  The missing checks are all cheap and mechanical — see A5. Also noted: at least one semantic mistag
  (`lex-fridman-podcast--ffmpeg-video` carries `engineering/energy-fusion`); a subset check won't
  catch those — the golden-tags corpus (DURABLE-WORK §2) is the right tool for that class.
- **F2.3 — session/discover overlap is structural and fine — once IDs are canonical.** session.json
  is "the curated menu + its own episode details"; discover.json is "the browse pool"; the client
  unions them. Decide the canonical ID now (recommendation: the discover-style
  `show-slug--episode-slug`, with `apple_track_id` as the dedup key since it's the one verified
  external identifier), migrate session.json's 27 episodes once, and handle localStorage: cp_history
  / cp_saved / cp_seen store old IDs, so either ship a one-time remap table in app.js or accept the
  small state reset now, while it is one user plus a one-day-old tester. It only gets more expensive.
- **F2.4 — Growth limits: the binding constraint is the phone, not GitHub Pages.** At 783 B/item:
  1,000 items ≈ 0.8MB · 2,000 ≈ 1.6MB · 5,000 ≈ 3.9MB · 10,000 ≈ 7.8MB raw. Pages limits are
  irrelevant at this shape — the 1GB site cap ≈ 1.3M items; the 100GB/mo soft bandwidth cap ÷ 149KB
  ≈ 660k page loads/month. What actually degrades first, in order:
  1. Cellular fetch time — there's no service worker and `fetchJson` uses `cache: "no-cache"`
     (app.js:651–656), so every open revalidates; Pages serves 304s, but cold loads pay full price.
  2. `JSON.parse` — roughly 100–300ms for 5–8MB on mid-range phones, on the critical render path.
  3. `fullPool()` allocating a fresh snapshot per item **per search keystroke** (app.js:552–566,
     180ms debounce) and per re-deal — GC churn territory past a few thousand items.
  **Practical soft cap: ~2,000 discover items / ~1.5MB.** At the cap: shard discover.json per
  top-level branch and lazy-load — or treat hitting the cap as the natural trigger for API-served
  search (§3, stage 4). Write the cap into DURABLE-WORK.md before tonight's catalog wave (A26).
  *(Done 2026-10-05: DURABLE-WORK.md §7. The measurement then was 2,167 items / 2.55 MB.)*
- **F2.5 — Migration path to API-served data.** The client is already shaped for it: all data
  arrives through `fetchJson()` into `state.*`, so "try API with a short timeout, fall back to the
  static file" is a ~10-line change when stage 3 (§3) arrives. No pre-work needed now.

## 3. Backend

Structure is genuinely good: a pure-function feed layer hardened against eight real-world fixture
feeds, a pluggable enricher whose stub still writes $0 cost events so the ledger stays complete, zod
at every boundary, dedup as pure union-find, and the budget guard as the single enforced spend path.
The test suite is the strongest artifact in the repo. Findings:

- **F3.1 — R1 cannot run against builder output today (defect, the important one).** Three gaps
  between `backend/output/session-2026-07-08.json` and what the live site needs:
  1. **No `builder` field** — absent from the schema (session.ts:55–68) and the output, so the web
     client would tag every event `builder: "unknown"` (app.js:59) and the blind-test ledger is
     unattributable. The entire point of R1 is that attribution.
  2. **Episode IDs use the slugifier scheme** (`lex-fridman-podcast-485-david-kirtley-...`),
     incompatible with session.json, validated-links.json keys, and all existing localStorage state.
  3. **No artwork / apple_episode_url enrichment** — the hand pipeline gets those via the
     validated-links overlay; builder output has nothing for the overlay to join on.
  The runbook (NEXT-MORNING.md step 3) says "copy the output over data/session.json" — that copy
  would ship a machine session with broken art and deep links and no attribution, contaminating the
  exact comparison R1 exists to make. Fix before the key lands (A1, A2, A12).
- **F3.2 — `fitLine()` regenerates banned copy.** sessionBuilder.ts:46–56 emits "fits today's drive
  almost exactly/comfortably" and "about N drives at your 1.5×" — the commute-length framing
  DECISIONS 2026-07-08 dropped. It slips the copy gate twice over: the regexes
  (test/copyRules.test.ts:19–28) match "fits your drive" but not "fits today's drive", and the suite
  only reads `data/*.json`, never builder output. fit_line is currently dead on the web (app.js
  never renders it) but is a first-class field in the iOS card model, so it will resurface. Fix the
  generator and the gate (A11, A12).
- **F3.3 — The DB layer is designed, not connected — and one real consequence hides there.**
  Twelve careful migrations, `user_id` on every table, and zero code paths that touch Postgres
  except the migration runner. The in-memory sinks are honest about this (costEvents.ts header).
  But note: while the cost sink is in-memory, **the daily budget cap resets per process** — a
  nightly one-shot build is capped per run, not per day; two builds in a day silently doubles the
  budget. Harmless at $2/day dry-run; fix when a real DB exists (A18).
- **F3.4 — The research-md candidate source must be replaced at key-landing, not refactored.**
  candidateExtractor.ts is a self-declared stopgap reading two frozen research docs — nightly builds
  from it would draw from a static fusion-heavy pool forever. The right near-term source is
  **catalog.json + live iTunes episode lookup** (the exact pipeline that built discover.json by
  hand): catalog shows → lookup → `NormalizedCandidate[]`. No DB required, 64 shows of reach (A13).
- **F3.5 — Deployment: nothing deployable exists, and mostly nothing needs to yet.** No HTTP
  server, no Dockerfile, no compose file (02_ARCHITECTURE.md's Docker Compose is aspiration). The
  first process that must exist is `POST /events` (R2: "first backend deployment milestone").
  Minimum honest shape: one Hono/Fastify file + Postgres in Docker Compose on the workstation,
  exposed via a Cloudflare Tunnel (free, stable hostname, TLS, no router surgery). Client-side,
  remember `connect-src 'self'` (index.html:7) blocks the POST — the CSP edit ships with the
  endpoint, and it is the only client security-surface change in the whole cutover below.

### F3.6 — Cutover plan: baked JSON → served API, with no stage able to break the live site

1. **Stage 0 — machine-built, still baked** *(at key-landing; A12)*. A `publish-session` script:
   run builder → map IDs to the canonical scheme → merge artwork/links overlay → set
   `builder: "machine-v1"` → run copy-rules + schema + ref-integrity gates **against the output** →
   write data/session.json → commit + push. The site is unchanged infrastructure-wise; R1 begins.
   Rollback = `git revert`. Hand-curated control days use the same script with a hand-written
   candidates file and `builder: "hand-architect-v1"`.
2. **Stage 1 — events become durable** *(before the second tester's history matters; A16–A17)*.
   Deploy `POST /events`. Client keeps localStorage as the buffer and flushes batches
   (`fetch(..., {keepalive: true})`), marking flushed indices. If the endpoint is down, the buffer
   simply doesn't drain — identical behavior to today. CSP gains the API origin.
3. **Stage 2 — nightly cron** *(key + ~1 week; A20)*. Workstation cron runs the stage-0 publish
   unattended; git push is the deploy. Failure mode: yesterday's session stays live — degraded,
   never broken. Alert on push failure; the R2 zero-picks alert doubles as uptime monitoring.
4. **Stage 3 — API-served session with static fallback** *(A24)*. `GET /sessions/current` serves
   the same document; `init()` tries the API with a short timeout, falls back to
   `data/session.json`, which the cron keeps baking as the permanent fallback artifact. Only after
   this holds: per-profile sessions, server-side search, shrinking the shipped discover.json.
5. **Stage 4 — DB-backed pipeline** *(post-R1-pass only)*. Migrations applied; ingest worker
   populates shows/episodes from catalog feeds (the feed layer already exists for this); builder
   reads DB + events-derived recentPicks/weights; the static site is a pure client. Do not start
   this before the blind test says the project has a spine — the pre-mortem is explicit.

## 4. Multi-user readiness

- **F4.1 — Everything the friend does is browser-locked.** cp_saved / cp_history / cp_interests /
  cp_events live under one anonymous namespace (app.js:50–64). One "clear browsing data" erases his
  entire history. Worse: there is no identity at all, so events synced *later* can't be attributed
  retroactively — every anonymous week is permanently anonymous.
- **F4.2 — Cheapest durable-identity ladder, before any Supabase auth:**
  1. **Profile ID — do tonight (~15 lines).** Mint `cp_profile_id = crypto.randomUUID()` on first
     load; attach to every `logEvent`. Costs nothing, makes all future telemetry attributable, and
     is the join key when the endpoint lands (A6).
  2. **Export/import — do this week (small).** A footer button serializing all `cp_*` keys to a
     downloadable JSON, plus import. Triples as: backup, phone migration, and the manual events-sync
     path the pre-mortem's tripwire 1 wants before the endpoint exists (he sends a file; crude,
     works; also exactly the "export view" NEXT-MORNING.md step 4 already authorizes under the
     feature freeze).
  3. **URL-token profiles (`?p=<token>` namespacing localStorage)** — only if a third tester
     appears before stage 1; otherwise skip straight to the endpoint.
- **F4.3 — Does anything in the current design block multi-user later?** The DB schema does not —
  `user_id` everywhere is real, including the forward-compatible shared-catalog note in
  0002_shows.sql. Two things do:
  1. **session.json is a single-user document served to everyone.** The why-lines are second-person
     and Will-specific ("Your fusion-reactor tour opens with…"). The friend is being curated *as
     you* — his picks even feed your R1 ledger with someone else's taste. Acceptable this month;
     at multi-user it becomes per-profile session docs (stage 3+) or builder-neutral copy (A25).
     Interim mitigation: A6's profile ID at least lets you segment his events out of R1 analysis.
  2. **Client interests/weights never reach the builder** — personalization is currently one-way
     even for you (§5). Both are API-shaped problems the cutover plan already absorbs; no rework now.

## 5. Event/learning pipeline: cp_events → (nothing)

Intended loop per the specs: **events → durable store → interest-weight updates (user_interests →
taxonomy_nodes) → scoring (relevance from weights, fatigue from recent picks) → session builder →
menus → events.** Status of every link:

| # | Link | Status | Where |
|---|------|--------|-------|
| 1 | Client logs events, builder-tagged, 5000 buffer | **exists** | app.js:57–64 |
| 2 | Events attributable to a person | **missing** | no profile id (F4.2) |
| 3 | Events leave the browser | **missing** | no endpoint (R2); interim: export button |
| 4 | Client and DB event vocabularies agree | **missing** | client emits `session_shown`, `refreshed_slot`, `refreshed_all`, `reshuffled_splatter`, `quest_built`, `quest_removed`, `searched`, `interest_adjusted`, `unsaved` — none legal under 0009_events.sql's CHECK (`card_shown`,`picked`,`skipped_at`,`finished`,`voice_command`,`thumbs`,`saved`,`session_built`,`session_rated`) |
| 5 | Weights update from events | **half** | client-side only (`boostTopics`, sliders → cp_interests), which nothing downstream reads; DB path is DDL-only |
| 6 | Builder consumes weights | **half** | reads static taxonomy.json, frozen at the 2026-07-07 hand seed |
| 7 | Builder consumes pick history | **half** | `computeFatigue` fully implemented and tested (scoring.ts:80–95) but always invoked with `recentPicks: []` — the CLI passes nothing |
| 8 | R4 weekly signal ledger | **missing** | nothing counts durable signals |

**Order of work** (each step independently valuable, none blocked on the previous being perfect):
(1) profile id + export button — tonight (A6); (2) events endpoint + vocabulary reconciliation —
stage 1 (A16, A17); (3) feed `recentPicks` into the builder from exported/synced picks — trivially
activates the already-tested fatigue term, the highest learning value per unit effort in the repo
(A14); (4) the weights job: events → user_interests deltas → regenerated node weights consumed by
the nightly build; interim acceptable version is folding an exported cp_interests into taxonomy
weights inside the publish script (A21); (5) the R4 ledger — a 20-line weekly script, but it is the
pre-committed descope trigger, so it must exist by week 4 of real use (A19).

## 6. iOS

- **F6.1 — Fixture drift, one day after the sync warning was written.** Both
  `ios/ForayKit/Tests/ForayKitTests/Fixtures/session_fixture.json` and
  `ios/App/Resources/sample_session.json` differ from data/session.json by exactly the `builder`
  line. Package.swift:36–40 says "keep this in sync manually" — manual sync failed within 24 hours,
  predictably. Decode still succeeds (Codable ignores unknown keys), so SessionModelsTests passes
  while its "matches the real document" charter is already false. Fix the process, not the file:
  a sync script + CI equality check (A9, A8).
- **F6.2 — The Swift `Session` model lacks `builder`** (SessionModels.swift:38–62). Harmless for
  decode; not harmless for R1 — iOS-logged picks must carry builder the day the app exists. Add
  `builder: String?` + CodingKey now while the file is fresh in mind (A27).
- **F6.3 — Will project.yml + the package assemble?** No rename debris found: `name: Foray`,
  package path/product `ForayKit`, bundle `com.wjduvall.foray`, zero `CommutePilot` strings under
  ios/. The honest assembly risks are the ones project.yml already flags about itself (lines 17–24):
  (a) whether `info.properties` without `info.path` synthesizes a valid Info.plist on the current
  XcodeGen; (b) the scheme's `test.targets: [ForayKitTests]` referencing a *local-package* test
  target by bare name — scheme test entries normally name project targets, and the package target
  may need explicit `package: ForayKit/ForayKitTests` syntax, or simply omission (Xcode
  auto-discovers package tests once the dependency exists). Neither is resolvable from Windows;
  both are minute-one checks on the Mac.
- **F6.4 — Pre-Mac fix list (all cheap, all now-able):** (1) fixture sync script + CI check (A9);
  (2) `builder` in the Swift model (A27); (3) `DEVELOPMENT_TEAM: ${DEVELOPMENT_TEAM}` env
  substitution in project.yml instead of a blank tracked value (A27); (4) run `swift test` in CI on
  a macOS runner **now** — public repos get them free, ForayKit needs no Xcode project, and the
  "heart of the app" state machine currently has three test files that have never executed anywhere
  (A8); (5) keep ios/README.md's AUDIT table as the literal M0 day-1 script — it is excellent and
  maps 1:1 onto the 14-day timebox acceptance tests.

## 7. CI / quality

- **F7.1 — CI runs tests but not the linters.** The backend job is `npm ci && npm test`
  (ci.yml:9–22). `npm run lint` (eslint + security plugin) and `npm run typecheck` exist and pass
  locally but are unenforced — the security-plugin disable-comment discipline visible throughout the
  CLIs only means something if CI executes the plugin. Two added lines (A7).
- **F7.2 — Data validation is parse-only** (ci.yml:30–41): JSON loads + session-internal episode
  refs. It cannot catch F1.1 or F1.2 — and those were introduced by an agent-driven expansion wave,
  which is precisely the kind of write that needs mechanical gates rather than review vigilance.
  Add the integrity set in A5; it would have failed commit b6929dc at push time.
- **F7.3 — No iOS checks, but they're free today.** `swift test` in ios/ForayKit runs on a
  `macos-14` runner in ~2 minutes: no simulator, no signing, no xcodegen. Add the job plus the
  fixture-equality check (A8).
- **F7.4 — Mutation survivors unexamined.** Stryker baseline 73.79% (commit fa28073), report in
  backend/output/mutation/. Survivors only matter where mutants change menus: scoring.ts and
  dedup.ts. One scheduled pass to read those survivors and add the missing assertions (A15). Do
  **not** put Stryker in CI — minutes-long runs, and test rigor is not this project's bottleneck.
- **F7.5 — Pre-push is a convention, not a mechanism — and Pages deploys before CI finishes.**
  CLAUDE.md lists the verify commands; nothing runs them automatically, and since Pages serves
  `main` directly, a bad push is live for the minutes it takes CI to even report red. A root
  `verify` script wired as a pre-push hook closes the gap (A10).
- **F7.6 — Flake risk: low.** 1.3s suite, zero network (enricher stubbed; clients take
  `fetchImpl`), and the only nondeterminism is fast-check property tests — pin seeds if a repro is
  ever lost, not preemptively.

## 8. Security / ops

- **F8.1 — CSP/escaping posture: verified, one edge.** The CSP (index.html:7) is genuinely strict:
  `default-src 'none'`, self-only script/style/connect, `img-src https: data:` (required for
  arbitrary podcast artwork; acceptable), `base-uri 'none'`, `form-action 'none'`. No inline
  styles/scripts anywhere; `esc()` covers element content and `safeUrl()` rejects non-http(s)
  schemes before hrefs/srcs. The single gap is F1.3 (raw attribute interpolation) — a consistency
  fix, not an active hole. The only planned CSP change in the entire roadmap through stage 3 is
  adding the events-API origin to `connect-src`.
- **F8.2 — Secrets: clean.** `.env` is gitignored and untracked (verified; all three keys currently
  empty), `.env.example` is the committed template, `envPresenceSummary()` logs booleans only, and
  the Podcast Index client signs sha1(key+secret+ts) per spec with a keyless stub mode. One habit to
  keep: when the Anthropic key gets pasted (runbook step 1), it goes in `.env` only — `.env.example`
  is tracked and one muscle-memory slip away.
- **F8.3 — Public-repo exposure: accept, with eyes open.** data/*.json and docs/ publish a detailed
  personal taste profile, commute pattern (18 min, 1.5×), and your email (User-Agent, env.ts:66).
  Behavioral data does *not* leak — cp_events never leave the browser. This is the accepted cost of
  free Pages. One standing rule to write down: **event data — yours or the friend's — never gets
  committed to the repo**, however tempting a "sync via git" shortcut looks at stage 1.
- **F8.4 — GitHub Pages limits vs catalog growth: not the constraint.** Full math in F2.4 — the
  site is ~350KB against a 1GB cap, and bandwidth headroom is five orders of magnitude. The real
  ops fragility arrives at stage 2: a workstation cron + tunnel is an unmonitored single point of
  failure — which is why wiring the R2 zero-picks alert doubles as the uptime monitor.

---

## Master action list

Phases: **now** · **2nd-tester** (before the friend's history is worth protecting; ~1–2 weeks) ·
**key** (the morning the Anthropic key lands) · **iOS** (Mac phase start) · **multi** (multi-user).
Effort: S <1h · M half-day · L multi-day.

### Defects — fix now

| ID | Action + exact scope | Effort | Prereq | Phase |
|----|----------------------|--------|--------|-------|
| A1 | Add `builder: z.string()` to `SessionDocSchema` and `BuildSessionOptions` (default `"machine-v1"`); emit in `buildSession()`; make `dataSchemaCompliance` parse session.json strictly so future field drift fails | S | — | now |
| A2 | Canonical episode IDs: adopt discover-style `show--episode` slugs with `apple_track_id` as dedup key; remap session.json's 27 episode keys + card/alternate/category refs + validated-links.json keys; one-time localStorage remap table in app.js (or documented accepted reset) | M | — | now |
| A3 | Add the 11 expansion branches to taxonomy.json (leaf nodes, weight 0.5, confidence 0.3, plus new top-level parents); add matching `.dot-*` colors in styles.css | S | — | now |
| A4 | Route every data-attribute interpolation through `esc()` (app.js:166, 360, 423, 437, 498–499); add the missing `_bound` guard to `bindPickLogging` while in there | S | — | now |
| A5 | CI data-integrity gate (extend the ci.yml inline script or promote to `tools/validate-data.js` shared with A10): every `topics[]` ∈ taxonomy nodes; no cross-file duplicate by `apple_track_id` or normalized title under different IDs; validated-links keys ⊆ session episodes; catalog `taxonomy_node_ids` ⊆ taxonomy | S | A2, A3 | now |
| A6 | Durable-identity seed: mint `cp_profile_id` (crypto.randomUUID) on first load, attach to every `logEvent`; add footer export button (all `cp_*` → JSON download) + import; explicitly allowed under the freeze per NEXT-MORNING.md step 4 | S | — | now |

### Debt — scheduled

| ID | Action + exact scope | Effort | Prereq | Phase |
|----|----------------------|--------|--------|-------|
| A7 | CI: add `npm run lint` and `npm run typecheck` steps to the backend job | S | — | now |
| A8 | CI: `macos-14` job running `swift test` in ios/ForayKit + a step diffing both iOS session fixtures against data/session.json | S | A9 | now |
| A9 | `tools/sync-ios-fixtures` script copying data/session.json → session_fixture.json + sample_session.json; run it once to fix current drift | S | — | now |
| A10 | Root `verify` script (backend test/lint/typecheck + `node --check app.js` + A5's data gate) wired as a pre-push hook; matters because Pages deploys main before CI reports | S | A5 | now |
| A11 | Fix `fitLine()` (sessionBuilder.ts:46–56): plain duration + resume hint, no drive framing; extend copyRules regexes to catch "today's drive" / "N drives" | S | — | key |
| A12 | `publish-session` script (cutover stage 0): builder → canonical IDs → validated-links/artwork merge → builder field → copy-rules + schema + ref gates **on the output** → data/session.json; hand-control days use the same script with `--builder hand-architect-v1` | M | A1, A2, A11 | key |
| A13 | `--candidates-from-catalog` builder mode: catalog.json shows → iTunes episode lookup (client exists) → `NormalizedCandidate[]`; retires the research-md path for daily builds without touching it | M | — | key |
| A14 | Pass `recentPicks` into `buildSession` from exported/synced picked events — activates the tested-but-dormant fatigue term | S | A6, A12 | key |
| A15 | Read Stryker survivors in scoring.ts + dedup.ts only; add missing assertions; leave the rest | M | — | key |
| A16 | `POST /events` (cutover stage 1): Hono/Fastify single service + Postgres (run migrations), Docker Compose on workstation + Cloudflare Tunnel; client batch-flush keeping localStorage as buffer; add API origin to `connect-src` | L | A6 | 2nd-tester |
| A17 | Reconcile client event vocabulary with 0009_events.sql CHECK (widen the constraint — it's your schema — rather than lossily mapping) | S | A16 | 2nd-tester |
| A18 | Postgres `CostEventSink` implementing the existing interface (~60 lines); fixes the per-process daily-budget reset in F3.3 | S | A16 | key/2nd-tester |
| A19 | Weekly R4 signal-ledger script + R2 zero-picks alert over the events store (this alert is also stage-2 uptime monitoring) | S | A16 | 2nd-tester |
| A20 | Nightly cron publish (cutover stage 2) + push-failure alert | S | A12, A13 | key +1wk |
| A21 | Weights job: events → user_interests rows → regenerated taxonomy node weights consumed by the nightly build; interim: fold exported cp_interests into weights inside the publish script | M | A16 | key + |
| A22 | Quest durability: store item snapshots in cp_quests (mirror the cp_saved pattern) instead of bare IDs | S | — | 2nd-tester |
| A23 | Service worker: cache-first app shell + stale-while-revalidate data (fixes the offline white-screen noted in docs/marketing/09; bug-fix class, freeze-compatible) | M | — | 2nd-tester |
| A24 | `GET /sessions/current` + API-first/static-fallback in `init()` (cutover stage 3); cron keeps baking the static fallback | M | A16, A20 | multi |
| A25 | Per-profile session docs, or builder-neutral second-person copy, so testers stop being curated as you (F4.3) | M | A24 | multi |
| A26 | Document the discover.json soft cap (~2,000 items / 1.5MB) + the shard-per-branch fallback in DURABLE-WORK.md, before more catalog waves land. **DONE 2026-10-05** (#560 item 10): DURABLE-WORK.md §7. Measured then: 2,167 items / 2.55 MB, already over the cap; documented as a budget, not a CI gate | S | — | now (doc) |
| A27 | iOS pre-Mac batch: `builder: String?` in the Swift Session model; `DEVELOPMENT_TEAM: ${DEVELOPMENT_TEAM}` substitution in project.yml; minute-one Mac checklist for `info.properties` synthesis and the package-test scheme reference | S | A9 | iOS |

### Fine — deliberately simple, do not touch

- **Vanilla JS; no framework, bundler, or site-side npm.** Re-evaluate only on F1.7's three triggers.
- **Full-rerender innerHTML pattern and the `itemIndex` registry.** Correct at this scale;
  componentizing or virtualizing now is decoration on the waiting room (pre-mortem's phrase).
- **localStorage `cp_` prefix.** Renaming wipes user state; keep forever or migrate deliberately.
- **In-memory cost/event sinks as CLI defaults.** The interface seam is right; only A18 when a DB
  exists.
- **O(n²) dedup, the research-md extractor, StubEnricher, dry-run-by-default.** All self-documented
  stopgaps with named successors; the extractor retires via A13, not via refactoring.
- **The init fetch waterfall, the sequential enrichment loop in buildSession, keyword series-builder
  v1.** Real inefficiencies; none on any critical path; the last is explicitly awaiting the
  curation brain (R12).
- **Marketing corpus and web feature surface.** Frozen by standing order — this assessment adds
  zero web features beyond instrumentation (A6) and bug/consistency fixes.

## If I were you, tonight

1. **A1 + the skeleton of A12** — `builder` through the backend schema and a minimal publish
   script. This is the only work that gates R1, and R1 gates everything else in the project.
2. **A2 + A3 + A5 as one commit** — canonical IDs, taxonomy catch-up, and the CI gate that makes
   the next expansion wave mechanically unable to reintroduce either. Land it *before* tonight's
   queued catalog wave merges more data on top of the drift.
3. **A6** — profile ID + export/import. Fifteen minutes; every event logged from tomorrow morning —
   yours and the friend's — becomes durable and attributable instead of anonymous and doomed.
4. **A7 + A8 + A9** — lint/typecheck in CI and `swift test` on a free macOS runner. The "heart of
   the app" state machine has never executed anywhere; make it execute nightly, months before the
   Mac phase bets its 14-day timebox on it.
5. **A11** — fix `fitLine()` while it is a two-line string change, so the first machine-built
   session doesn't greet you with copy your own principles banned two days ago.
