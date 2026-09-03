# Foray — Market Brief (CMO synthesis)

> **Name change since this memo — 2026-08-21.** At the time this brief was
> written the app itself was called "Foray" (hence the title above); the
> founder later renamed the app **4a**, and "foray" was repurposed to mean
> only the stitched-audio unit 4a assembles (see `docs/DECISIONS.md`,
> 2026-08-21 entry, and `06-naming-study.md`). **The underlying market
> research and positioning conclusions below still apply as-is to 4a** —
> this is a naming change only, not a repositioning; read every "Foray" in
> the prose below as "4a" unless it is describing the stitched-audio unit
> specifically.

*Synthesized 2026-07-08 from desks 01–07. One page of conclusions; evidence lives in the numbered memos. Product principles (curiosity-first, anti-echo-chamber, no dark patterns, legally boring) supersede every finding here.*

## The one-paragraph read

The market is large (167M US monthly listeners), discovery is its acknowledged unsolved problem (25–33% actively struggle; word-of-mouth still beats every algorithm on trust), and the specific lane Foray occupies — *aligned, explained, episode-level curation of real shows* — is verifiably vacant: Apple bought this exact concept (Scout FM, 2020) and shipped nothing in six years; Spotify's 2026 AI stack is powerful but structurally misaligned (marketplace incentives, ignores negative feedback); the 2024–26 AI wave went to podcast *generation*, not curation. The graveyard's five causes of death (social layers, clip formats, screen-dependence, owned content, parent-strategy kills) are all avoided by Foray's existing constraints. The two residual structural threats are ours alone: **signal sparsity** (1 user × ~1 pick/day may never out-learn a static menu) and **habit gravity** (beating the muscle memory of opening Overcast). Neither is a marketing problem.

## Positioning

- **Category language:** "your personal podcast curator" — never "AI podcast app" (that phrase now means text-to-synthetic-audio generators). The emotional register that wins: Discover Weekly's "it knows me" intimacy + the anti-algorithm era's "no infinite scroll, no engagement farming" calm.
- **Flagship marketable feature:** *explained serendipity.* Evidence says diversity without explanation reads as error; diversity with a stated bridge lifts satisfaction. The Stretch card's spoken bridge is simultaneously our UX bet and our headline.
- **Structural trust claim:** the bounded 4-card session is immune-by-design to the mechanisms (autoplay, infinite feeds, variable reward) that regulators and users now attack. This is a durable differentiator, not a feature.
- **Ritual:** own a daily time-slot like Wordle owns coffee. Cue = the drive (or the walk); cap = the session. No streaks, ever ([CONFLICTS-WITH-PRINCIPLES], rejected).
- **Persona order:** Commuter-Learner first (curiosity/need-for-cognition is the medium's core psychographic, peer-reviewed), Echo-Chamber-Wary Explorer second.
- **Car framing caution:** only ~11% of listening minutes happen in cars (67% home). The commute is the wedge and the founding ritual — not the product's identity. Session triggers must generalize.

## Pricing (for M7; do nothing now)

- Envelope: paid podcast apps converge on **$3.99/mo or $25–40/yr**; broader subscription benchmarks put $6.68/mo median, $9.99 anchor. Recommendation: **$4.99/mo / $34.99/yr** placeholder, freemium not hard-paywall.
- **Never paywall curation quality** — a deliberately-worse free curator contradicts the trust thesis. Paywall scope/volume/voice: sessions per day, TTS voice quality, history depth, family mode.

## Unit economics sketch (assumptions, calibrate against cost_events when key lands)

Per-user-day at current API prices, cheap-first cascade working as designed:
- Tier-1 metadata classification (Haiku-class, ~30 eps/day): **~$0.05–0.10** — but this is a *shared catalog cost*, amortized across all users at scale.
- Session build + why-lines (Sonnet-class, 2 sessions/day): **~$0.03–0.05** per user.
- TTS intros (~1.2k chars/session): **~$0.04–0.15** per user depending on provider tier.
- Tier-2 transcription is the cost cliff: API Whisper ≈ $0.36/ep-hour. At 1 gated episode/day it dominates everything (**~$0.36**); on the always-on workstation it's ~$0. **The workstation-Whisper option is load-bearing for the economics — treat it as architecture, not a nice-to-have.**

Net: marginal cost ≈ **$1.50–4.50/user-month** (local Whisper, shared enrichment) vs $4.99 price → viable but thin at the personal phase, improving with every user because enrichment amortizes. The pre-mortem's sharper question stands: whether menu quality *worth paying for* exists inside this envelope at all — that's what the blind test (REQUIREMENTS-DELTA R1) exists to answer.

**⚠️ Stale scope — needs recomputation before any pricing decision or Phase 2 (2026-09-02).** This sketch prices a *curation-only* product: metadata classification, session building, and short (~1.2k character) TTS intros per session. It predates the AI-generation feature's separate per-Foray cost ceiling — per `docs/curation/generation-architecture.md` §9.2, Joey set a generous ~$5–10/Foray ceiling for full episode generation (research, spine-building, per-act deepening, per-beat writing, independent fact-verification), which is a fundamentally different, additive cost shape (potentially tens of thousands of characters of TTS/LLM generation per Foray, not a 1.2k-character intro). If any material share of users generate custom Forays, this $1.50–4.50/user-month envelope and the $4.99 anchor it's checked against no longer capture the full marginal cost. **Do not finalize a pricing decision or schedule Phase 2 (any-user generation) without recomputing this envelope using the $5–10/Foray ceiling as an additive input.**

## Risks (rank-ordered by the pre-mortem, P × damage)

1. Signal sparsity starves the learning loop → descope trigger pre-committed (delta R4).
2. Hobby-budget pipeline can't reproduce hand-curated week-one quality → blind test now (R1).
3. Solo-dev iOS audio gauntlet stalls → 14-day M0 timebox with PWA fallback (R5).
4. Why-line habituation → freshness monitor + copy gates (R3, partially shipped).
5. Creator retention unmeasurable → durable event telemetry (R2, partially shipped).
6. Spotify demoralization → pre-committed re-assessment triggers only; feature demos change nothing.

## Standing order from the pre-mortem

Marketing corpus is **frozen** until there's a retention curve for it to describe. Web client is **good enough**. The next meaningful dollar goes to the automated builder's menu quality and the iOS audio spike — the two untested things that decide life or death.
