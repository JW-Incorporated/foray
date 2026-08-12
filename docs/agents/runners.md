# Scheduled runner registry

The source of truth for every scheduled agent/job in Foray: what runs, where,
on what cadence, and who pays. Update this in the same change that adds or
changes a runner.

> **This file drifted once already.** Until 2026-08-11 it listed two runners,
> both marked "pending", while seven were actually live — the same failure the
> starter kit's `LESSONS.md` records as *"a registry that is not enforced
> becomes fiction"* (Swift2 described ~15 runners; the account had 97).
> A hand-maintained list goes stale by default. The load-bearing check is the
> account-wide auditor and the invariants in
> [`routine-invariants.md`](routine-invariants.md) — **not this table.**
> Treat the table as documentation of intent, and the auditor as truth.

## Live runners

| Runner | Where | Cadence | Model | Billing | Prompt / source | Status |
|--------|-------|---------|-------|---------|-----------------|--------|
| **nightly-refresh (scan+resolve)** | GitHub Actions (`.github/workflows/nightly-refresh.yml`) | Daily 06:40 UTC | — (deterministic) | Actions minutes (free tier, public repo) | workflow file | live |
| **foray-nightly-enrich** | Claude Cloud routine | Daily ~11:40 UTC (≥2h after the Action) | Sonnet | Wyatt's account | `runner-prompts/foray-nightly.md` | live |
| **foray-classify-shard0–5** | Claude Cloud routines (6) | Every 8h | Sonnet | Wyatt's account | `runner-prompts/classify-batch.md` | live |

~19 runs/day, which as of 2026-07-25 was the majority of all agent spend across
Foray and Swift2 combined (~19 of ~32). That is not a problem by itself — it is
just where the money is, so it is the first place to look when trimming.
Wyatt's standing decision is to leave the cadence as-is.

## Planned (not yet registered)

| Runner | Purpose | Gate |
|--------|---------|------|
| **foray-segment-extract** | Segment proposal from free transcripts — see `docs/curation/segment-extraction-pipeline.md` Lane C | #64 ruling + ADR-0007 (accepted) + the merge validator existing first |

## Model tiering

Referenced by `routine-invariants.md` step 4. The biggest model is a default,
not a decision — tier at creation:

| Work shape | Model |
|---|---|
| Deterministic poll, set difference, "did X happen" | Haiku |
| Script-then-summarize; mechanical merge of tool output | Haiku / Sonnet |
| Classification against a fixed taxonomy (Tier 1, ADR-0006) | Sonnet |
| Genuine authoring, adjudication, editorial judgement — hooks, why-lines, segment boundaries | Sonnet, escalating to Opus only on measured need |

**Read the prompt before downgrading.** Swift2 downgraded one routine that
looked like "bucketing" and was actually applying privacy redlines. A job whose
output nobody re-checks is the wrong job to make cheaper — and Foray has
exactly that shape in the copy-gated content path.

## Conventions

- Cron minutes are offset off `:00` (GitHub top-of-hour contention).
- The Claude Cloud agent runs **after** the Action so it always reads a fresh
  `refresh-digest`. Keep ≥2h of slack for slow feed nights (scan can take ~10m).
- **All scheduled spend runs on Wyatt's account** so Joey's weekly limit stays
  free for product and QA work. A routine armed from a Joey session spends
  exactly the tokens that split exists to protect.
- Every runner prompt is versioned in `runner-prompts/`. **A runner without a
  committed prompt file is not registered** — nine Swift2 runners drifted
  precisely because their prompts lived only inside the trigger, where the
  "repo file is the source of truth" rule silently did not apply.
- A finished runner gets **deleted**, not left no-opping. Expiry guards inside
  prompts are invisible once passed; prefer a cadence change you can see.
- Bot PRs auto-merge only if they are **content-only** (`data/`) — see
  `.github/workflows/automerge-nightly.yml`. Set the repo variable
  `AUTOMERGE_FREEZE` to halt all auto-merging instantly.
