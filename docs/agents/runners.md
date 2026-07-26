# Scheduled runner registry

The source of truth for every scheduled agent/job in Foray: what runs, where,
on what cadence, and who pays. Update this in the same change that adds or
changes a runner.

| Runner | Where | Cadence | Billing | Prompt / source | Status |
|--------|-------|---------|---------|-----------------|--------|
| **nightly-refresh (scan+resolve)** | GitHub Actions (`.github/workflows/nightly-refresh.yml`) | Daily 06:40 UTC | GitHub Actions minutes (free tier) | workflow file | live after Phase 1 |
| **nightly-refresh (enrich+merge+PR)** | Claude Cloud scheduled agent | Daily ~11:40 UTC (≥2h after the Action) | *assigned at Phase 2* | `docs/agents/runner-prompts/foray-nightly.md` | pending Phase 2 |

## Conventions

- Cron minutes are offset off :00 (GitHub top-of-hour contention).
- The Claude Cloud agent runs **after** the Action so it always reads a fresh
  `refresh-digest`. Keep ≥2h of slack for slow feed nights (scan can take ~10m).
- All Claude Cloud scheduled-agent spend is billed to a single designated
  account (recorded above once chosen), matching the Swift2 model.
- Every runner prompt is versioned in `docs/agents/runner-prompts/`.
