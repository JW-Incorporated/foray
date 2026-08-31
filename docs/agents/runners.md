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
| **foray-nightly-enrich** | Claude Cloud routine | Daily ~11:40 UTC (≥2h after the Action) | Sonnet | Wyatt's account | `runner-prompts/foray-nightly.md` | live — **step 4 changed 2026-08-21 (#292)**: `edits.json` gained an optional per-episode `topics` field, and the "no schema changes" constraint now names it as in scope. Without that edit the fix would have been inert on the pipeline it was built for — topics were assigned per show, and the agent had no way to say otherwise. |
| **foray-classify-shard0–5** | Claude Cloud routines (6) | Every 8h, staggered 40 min apart — see below | Sonnet | Wyatt's account | `runner-prompts/classify-batch.md` | live — **push to `reclassify-<N>`, open NO PR** (see below) |
| **nightly-watch** | GitHub Actions (`.github/workflows/nightly-watch.yml`) | Daily 21:40 UTC | — (deterministic) | Actions minutes | workflow file → `tools/refresh/watch-nightly.mjs` | **checker landed, workflow pending a founder merge** — `.github/` is governed (#290) |

> ### `nightly-watch` exists because a green workflow list is not evidence (issue #290)
>
> `foray-nightly-enrich` runs on Wyatt's account. On 2026-08-20 and 2026-08-21 it
> hit a weekly usage limit and did not run at all. The Action kept succeeding and
> kept logging *"published digest: 29 resolved episodes"*; every scheduled run in
> the window was `success`; nothing reached `main` for two days. The only symptom
> was an **absence**, and until this row existed nothing in the system watched for
> one.
>
> It is not a second content pipeline. It reads the digest branch and the PR list
> and asks one question — *did the night the digest belongs to produce a
> `nightly/<date>` PR?* — with a 12-hour grace window, the same number the runner
> prompt uses for the mirror-image refusal.
>
> **A billing failure in a Cloud routine is silent by construction.** Any runner
> in the table above whose absence would be invisible needs the same treatment;
> the six classify shards deliberately open no PR, so "nothing on `main`" cannot
> be the signal for them either (see the note below).

> ### The six classify shards open no pull request. Do not read "nothing on `main`" as "the fleet is dead."
>
> **This cost two weeks and one wrong conclusion, so it is written down here.**
> The six routines run `prepare-batch.mjs --batch-size 60 --shard N/6`, merge
> the results, and commit to **`origin/reclassify-<N>`** — six long-lived
> branches, each created from `origin/reclassify`. They never open a PR and
> never touch `main`. §8 of `runner-prompts/classify-batch.md` tells them to
> `git switch -c classify/<date>-<batch_id>` and `gh pr create`; **the live
> routine configuration in the cloud does not do that.** The committed prompt
> and the running routines disagree, and the routines win.
>
> ### 2026-08-31 reconcile: the "39 problems" were a stale shard key, not new drift
>
> The 2026-08-17 reconciliation below assumed every branch's committed
> `tools/classify/prepare-batch.mjs` would pick up PR #203's shard-key fix
> (`Number(id) % N` → `fnv1a32(String(id)) % N`) the moment #203 merged, and
> `reconcile-shards.mjs`'s `keyForRow()` used a single cutover timestamp on
> that assumption. **False for five of the six branches.**
> `origin/reclassify-0,1,2,4,5` never merged or rebased onto `main` after
> forking from `origin/reclassify` on 2026-07-25 — their committed
> `prepare-batch.mjs` is still the pre-#203 file, computing
> `Number(id) % shardCount` unconditionally, with no cutover logic. Every row
> those five branches have ever produced, whatever its `classified_at`, is
> legacy-keyed. (`origin/reclassify-3` is the one exception — its tree has
> #203's code, copied in some out-of-band way rather than merged, which is
> why `git merge-base --is-ancestor <#203 commit> origin/reclassify-3` reads
> false despite the files matching main's.) That mismatch produced the
> 2026-08-31 dry-run's "39 problems": 604 rows correctly partitioned under the
> legacy key by code that never updated, misread as off-lane/unsharded work by
> a checker that assumed the key changed everywhere at once.
>
> **The fix, in `reconcile-shards.mjs` (code, not a data patch — see rules 3b
> and 4 in the file's own header for the full reasoning):**
> - The lane check now tries BOTH shard keys per row and accepts either match
>   (`keysForRow()`), rather than picking one key from the row's timestamp.
>   Disjointness (below) is unchanged and still catches a genuinely unsharded
>   run — this only recognizes that a branch's code, not a row's clock, decides
>   which key it used.
> - The ~30 real cross-shard double-claims (all produced by the same
>   legacy/hashed split) are resolved by rule 3b: newest `classified_at` wins,
>   same tie-break rule already used for agent-vs-incumbent conflicts (rule 3)
>   — not a new decision, the existing rule applied a second time. Every
>   resolved pair is recorded in the merge's `cross_shard_conflicts`
>   provenance for audit.
> - The "inherited, exempt from the lane check" comparison now also checks a
>   row against the branches' common fork point (`origin/reclassify`), not
>   only against `main` — `main` and the shard branches are separate lineages
>   past 2026-07-25, so a row genuinely inherited from the fork point could
>   legitimately differ from `main`'s own independent history for the same id.
> - **The root cause is NOT fixed by this change** — it is a reconciliation
>   fix, not a shard-branch fix. `reclassify-0,1,2,4,5` are cloud routines this
>   repo's agents cannot push to or reconfigure; they will keep producing
>   legacy-keyed rows on every future run until a human either rebases those
>   branches onto `main` (picking up #203) or the cloud routine config is
>   changed to run against updated code. Filed as a `HUMAN-ACTIONS.md` entry.
>   The `keysForRow()` fix means this is not urgent — every future run
>   continues to reconcile cleanly under the current key mix — but it is real
>   technical debt: the fleet is running two shard keys in parallel
>   indefinitely, not just during a short cutover window.
> - Reconciled 2026-08-31: 19,278 → 19,677 agent-classified shows (+399 new,
>   1,368 refreshed by a newer pass, 33 cross-shard conflicts resolved). 110
>   shows still have no agent pass at all (down from 509 — the earlier "509"
>   count was measured before this reconcile, not stale data this reconcile
>   invalidated).
>
> The visible symptoms, all of which read as a dead fleet and none of which are:
> no classify PR open, no new `classify/*` branch since 2026-08-03, and
> `data/breadth-classification.json` on `main` frozen at 1,851 agent-classified
> shows of 19,787. PR #198 drew exactly that conclusion in its own body and
> filed it as an owner action.
>
> **What was actually happening:** all six were running fine and had produced
> **17,427 classifications** nobody had merged — the agent-classified count went
> **1,851 → 19,278, a 10.4× multiple**. Reconciled onto `main` 2026-08-17 by
> `tools/classify/reconcile-shards.mjs`, which is committed and re-runnable
> precisely because this will recur every time the fleet runs.
>
> **So: to see what the classify fleet has done, look at the branches.**
> `git fetch origin 'refs/heads/reclassify-*:refs/remotes/origin/reclassify-*'`
> then `node tools/classify/reconcile-shards.mjs --dry-run`. Never judge the
> fleet by `main` or by open PRs.
>
> **The standing fix is a routine-configuration change, not a doc change** —
> either point the routines at the PR flow the prompt already describes, or
> schedule a reconciliation run. Until one of those happens, every shard batch
> accumulates off `main`. Filed as `HUMAN-ACTIONS.md` **#10**.
>
> **Two corrections this evidence forces**, both recorded in `HUMAN-ACTIONS.md`
> (note #4 is created by PR #198 and does not exist on `main` yet — if #198
> lands, its #4 needs the same update block before anyone acts on it):
>
> - **Sharding works.** Each shard's own work is a clean slice of
>   `Number(id) % 6` — 0 off-lane, 0 double-claimed across 17,427 rows and 24
>   active days. So #5's "five of every six runs are duplicate work" is refuted,
>   and acting on it would edit six correct configs through a flag that fails
>   open. What the git record shows is the *partition*, not which flag produces
>   it; that is enough to not touch them.
> - **All six are alive**, so #4's question is answered: yes. Per-branch tips
>   are staggered, not uniform — s0 08-15, s1 08-16, s2 08-17, s3 08-16, s4
>   **08-13**, s5 08-15 — and s4's three-day gap is not a fault: the fleet is
>   running out of work. Only **509** shows still have no agent pass, which is
>   also why #10 is a 509-show problem, not a 17,000-show one. (Careful quoting
>   per-lane remainders — they differ by key. Retired `Number(id) % 6`:
>   38/41/335/40/21/34. Hashed key #203 shipped, which every future run uses:
>   87/87/80/70/86/99.)

~19 runs/day, which as of 2026-07-25 was the majority of all agent spend across
Foray and Swift2 combined (~19 of ~32). That is not a problem by itself — it is
just where the money is, so it is the first place to look when trimming.
Wyatt's standing decision is to leave the cadence as-is.

### The six classify routines — arguments and phase

**This table is the intended configuration, not an observed one, and it is not a
new decision.** It records what `HUMAN-ACTIONS.md` #5 — filed by the fleet
review, PR #198 — already asks the owner to set; it lives here too because this
file's own header requires updating it in the same change that changes a runner,
and the shard argument changed. The arguments and the phase live in each
routine's config on Wyatt's account, which no session can read or write. Until
#5 is done, this table documents intent and the auditor is truth (see the warning
at the top of this file).

Every routine keeps a **3-runs/day, 8-hour period** — the cadence is unchanged.
Only the phase differs, so that no two classify runs overlap: two concurrent
classify PRs conflict by construction, because `merge-results.mjs` rewrites
`built_at` and the whole `provenance` block on lines 3 and 7–8 of the same
184k-line file. Minimum separation is 40 minutes.

| Routine | Cron (UTC) | Argument |
|---|---|---|
| `foray-classify-shard0` | `10 0,8,16 * * *` | `--shard 0/6 --batch-size 60 --mode fresh --progress data/classify-progress.json` |
| `foray-classify-shard1` | `50 0,8,16 * * *` | `--shard 1/6 --batch-size 60 --mode fresh --progress data/classify-progress.json` |
| `foray-classify-shard2` | `10 2,10,18 * * *` | `--shard 2/6 --batch-size 60 --mode fresh --progress data/classify-progress.json` |
| `foray-classify-shard3` | `50 2,10,18 * * *` | `--shard 3/6 --batch-size 60 --mode fresh --progress data/classify-progress.json` |
| `foray-classify-shard4` | `10 4,12,20 * * *` | `--shard 4/6 --batch-size 60 --mode fresh --progress data/classify-progress.json` |
| `foray-classify-shard5` | `50 4,12,20 * * *` | `--shard 5/6 --batch-size 60 --mode fresh --progress data/classify-progress.json` |

Three things about that table that are easy to get wrong:

- **`--shard` is 0-indexed. `6/6` is invalid** and, as of this change, exits
  with an error. It used to fail *open* — a malformed value silently ran the
  full unsharded catalogue, which is exactly the six-way duplicate work the flag
  exists to prevent.
- **The shard key is `fnv1a32(String(apple_collection_id)) % N`**, not
  `Number(id) % N`. The modulo key is **2.20x** unbalanced over the **17,936
  shows still needing a pass** (shard0 1,514 against shard3 3,334) and would idle
  a sixth of the fleet from around day 12. Do not "simplify" it back;
  `tools/classify/shard.test.mjs` measures both against the real catalogue.
  (`fleet-review-2026-08.md` §4 quotes 1,504 / 2.21x for the same key over the
  slightly smaller **17,875 eligible** set — both are correct, over different
  sets, so name the set whenever you quote either.)
- **12:10 and 12:50 fall 30 and 70 minutes after `foray-nightly-enrich`
  (11:40).** The two touch disjoint files so this is fine, but if the nightly
  starts running long, move shard4/5 to `10 5,13,21` / `50 5,13,21`.

Expected throughput at this configuration: ~774 shows/day, ~24 days for the
~17,900 shows still needing a pass, at **no increase in run count and no extra
token spend**. Derivation and the failure modes:
`docs/agents/fleet-review-2026-08.md` §4.

## Planned (not yet registered)

| Runner | Purpose | Gate |
|--------|---------|------|
| **foray-segment-extract** | Segment proposal from free transcripts — see `docs/curation/segment-extraction-pipeline.md` Lane C | #64 ruling + ADR-0007 (accepted) + the merge validator existing first + a prompt that points at `docs/research/corpus/digests.md` (segment boundaries and DAI drift are the research corpus's strongest area; the corpus DB is machine-local, so the prompt must cite the digests, never the CLI) |

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
