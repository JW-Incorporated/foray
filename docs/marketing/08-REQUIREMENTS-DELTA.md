# Requirements Delta — marketing research → product requirements

*2026-07-08. Updates the briefing package in `docs/brief/` without editing it. Product principles supersede all findings; conflicts are listed as REJECTED at the bottom. Status tags: ✅ shipped tonight · 🔑 blocked on Anthropic key · 📱 needs Mac/iOS phase.*

## New requirements

**R1 — Blind machine-vs-hand curation gate (the project's most important test).** 🔑
M2's honesty gate ("would I pick from this menu?") must run against menus built by the *automated pipeline with no architect-in-the-loop*, with hand-curated control menus blind-interleaved (`builder` field logged against picks, unlabeled in UI). Pass/fail decides whether iOS effort is justified. Weekly: one deliberately unconstrained build (frontier model + transcripts, no budget cap) alongside budget builds to measure the quality-per-dollar curve directly. *(Pre-mortem tripwires 2 & cause-6; infrastructure — `builder` field in session doc + event payloads — ✅ shipped tonight.)*

**R2 — Durable retention telemetry.** Partially ✅
Events must survive beyond localStorage: raised buffer 500→5000 tonight ✅; `POST /events` endpoint becomes the first backend deployment milestone (before any other API surface). Alert rule: 3 consecutive weekdays with zero picks. Weekly 7-day pick-rate review. The M7 retention gate is unmeasurable until this exists.

**R3 — Why-line freshness defenses.** Partially ✅
Copy-rule gates in CI ✅ (length caps, banned generic praise, no commute framing). Remaining: embed every generated why-line; alert at >0.9 similarity to trailing 30 days or 3+ repeats of a rhetorical frame per week 🔑. Auto-brief rule (drop show-explainers after N hearings) moves from M5 to the first TTS milestone.

**R4 — Signal ledger with pre-committed descope.**
Count durable taste signals weekly (per the spec's learning table). **Trigger, recorded now: if <10 durable signals/week at week 4 of real use, M5 formally descopes from "ranker beats baseline" to "editable interests + fatigue rules."** No relitigating in the moment.

**R5 — M0 hard timebox.** 📱
The three iOS risk spikes get 14 elapsed calendar days from the first day of iOS work. Fallback pre-written: Foray becomes a PWA + handoff product and all iOS-dependent roadmap items re-scope that day. (Audio spike remains first — reliability is the #1 deletion trigger in retention research.)

**R6 — Sessions generalize beyond the car.**
Only ~11% of listening minutes are in-car (67% home). Rename internal concepts commute→session; session triggers configurable by context (drive/walk/gym/chores) with observed-not-declared timing. CarPlay stays the wedge, drops out of the identity. *(Converges with the user's own 2026-07-08 instinct to drop commute-length framing.)*

**R7 — Positioning language locked.**
"Your personal podcast curator." Never "AI podcast app." Explained serendipity is the flagship claim; the bounded no-dark-patterns session is the trust claim. Stretch-card why-lines get *more* explanation, in-lane picks less (expectation-tuned verbosity — retention desk verdict: STRENGTHEN the why-line bet).

**R8 — Pricing architecture (M7, no action now).**
Freemium; never paywall curation quality; paywall scope/volume/voice (sessions/day, premium TTS, history depth, family mode). Placeholder $4.99/mo / $34.99/yr. Workstation-hosted Whisper is load-bearing for unit economics — design the transcript ladder's compute-location switch as production architecture, not a dev convenience. **⚠️ Stale (2026-09-02): this $4.99 placeholder and its unit-economics basis (00-MARKET-BRIEF.md, ~$1.50–4.50/user-month marginal cost) price curation only — short TTS intros, not AI-generated episodes. `docs/curation/generation-architecture.md` §9.2 separately sets a ~$5–10/Foray ceiling for the generation feature; that's an additive cost not yet reflected here. Recompute before any pricing decision is finalized or before Phase 2 (any-user generation) is scheduled.**

**R9 — App Store readiness items (from legal memo).** 📱
App Review notes distinguishing offline podcast downloads from rippers (guideline 5.2.3); named third-party-AI disclosure for Anthropic (5.1.2); privacy nutrition labels; "skip the sponsor read" feature requests trigger legal review, always. OPML import ships with first multi-user release (switching-cost mitigation).

**R10 — Competitive re-assessment triggers, pre-committed.**
Competitor feature demos change nothing unless: Spotify starts honoring negative feedback signals, or Apple ships a personalized drive/commute mode. Quarterly watchlist per 01-competitive-landscape §6. (Anti-demoralization rule from the pre-mortem.)

**R11 — Intro-skip, the compliant way (user request 2026-07-08).** 📱
Automated ad detection/stripping is permanently rejected (hard constraint #3 + legal memo precedent). Ship instead in the iOS app: (a) per-show *user-configured* "skip first N seconds" (Pocket Casts precedent), (b) "start at first content chapter" via publisher-provided chapter markers, gated on `chapters_reliable` and not `dai_suspected`. Any ad-adjacent feature request triggers legal review.

**R12 — Free-text series assembly ("give me a series about fusion").**
Shipped v1 on web (keyword+alias scoring over the pool, persisted quests with progress). When the key lands, the same input posts to the curation engine for semantic series assembly with pedagogical ordering; ships in the iOS app as a first-class feature.

## Changed priorities

**P1 — Pipeline quality and iOS audio spike jump the queue.** Everything else (web polish, marketing, growth thinking) is downstream of R1 passing and M0 surviving its timebox.
**P2 — Marketing corpus frozen** until a retention curve exists. Web client feature-frozen except bug fixes and R1/R2 instrumentation.

## Rejected (marketing said it works; principles say no)

- **Familiarity-heavy menus** to boost short-term retention — recreates the subscription-list-with-extra-steps failure the spec exists to prevent.
- **Streak/guilt mechanics** — proven engagement lever, textbook dark pattern.
- **Clip/highlight feeds** — the graveyard's most reliable death (Podz, Moonbeam, Shuffle), and infinite-scroll adjacent.
- **Unqualified "we'll surprise you" marketing headline** — the exploration floor stays; the unqualified framing tests poorly and over-promises.
