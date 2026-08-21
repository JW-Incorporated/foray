# Nightly refresh — cloud topology

How Foray's content refresh runs in the cloud after the migration. Two stages,
split by whether they need credentials or judgment (the Swift2 two-tier model).

```
┌─────────────────────────── GitHub Actions (keyless, deterministic) ──────────────────────────┐
│  nightly-refresh.yml  @ 06:40 UTC  (moved off 09:40 in #46 — see the file's header)             │
│    checkout main → npm ci (backend) → restore state from refresh-digest                        │
│    → scan.mjs (RSS)  → resolve.mjs (iTunes)                                                     │
│    → watch-nightly.mjs --mode overwrite   (STOPS HERE if last night never merged — #290)        │
│    → publish resolved.json + refresh-state.json to the `refresh-digest` branch                 │
└───────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                 │ (credential-free digest)
┌────────────────────────── Claude Cloud scheduled agent (judgment) ───────────────────────────┐
│  foray-nightly runner  @ ~11:40 UTC                                                            │
│    read resolved.json from refresh-digest → author edits.json (hooks + tags)                   │
│    → merge.mjs → copy-rule + pool-integrity tests → open PR to main                            │
└───────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                 │
                    auto-merge on green checks (automerge-nightly.yml) → main
                                                 │
                                    GitHub Pages deploys the site

┌────────────────────────────── nightly-watch.yml  @ 21:40 UTC ─────────────────────────────────┐
│  watch-nightly.mjs --mode absence: a digest older than 12h with no nightly/<date> PR is RED.   │
│  Nothing else in the system watches for an absence, which is why #290 was invisible.           │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Why this shape

- **Secrets stay in Actions, judgment stays in the agent.** The Action needs no
  API key (RSS + iTunes only) and the agent needs no repo secret (its enrichment
  is its own reasoning). Nothing that can touch `main` holds a credential.
- **`main` is protected**; the Action writes only to `refresh-digest`, the agent
  only proposes via PR. No bot ever pushes to `main`.
- **State survives ephemeral runners** by living on `refresh-digest`. Even if it
  is lost, `resolve.mjs` dedups against published `discover.json`, so a duplicate
  can never reach the site.

## Branches

| Branch | Written by | Protected | Contents |
|--------|-----------|-----------|----------|
| `main` | humans / merged PRs | yes | the app + published data |
| `refresh-digest` | the Action | no | `resolved.json`, `refresh-state.json` (regenerated nightly) |
| `nightly/<date>` | the Cloud agent | no | one night's `discover.json`/`item-tags.json` change, via PR |

## Failure behavior

- Action fails to publish → job goes red (visible), no digest that night, agent
  no-ops. Nothing corrupts.
- Agent can't produce a clean merge → it leaves the PR unmerged with a note; a
  daytime human picks it up. Skipped nights are cheap.
- **Agent doesn't run at all** → see below. This is the one the shape of the
  system did not cover, and it cost a day of content.
- The old local Windows task (`scripts/nightly-refresh.cmd`) remains as a manual
  fallback until Phase 4 cutover.

## Watching for an absence (issue #290)

Every bullet above describes something going **red**. On 2026-08-20 and
2026-08-21 nothing went red: the agent's account hit a weekly usage limit, so the
judgment half simply did not run. The Action succeeded both nights and logged
*"published digest: 29 resolved episodes"* both nights. Every scheduled run in
the window was `success` and the product got nothing.

Two halves that don't know about each other cannot report on each other, and
neither half was wrong. What was missing was anything at all that watched for the
**absence** of a PR — so the failure was invisible in exactly the place anyone
would look, the workflow list.

The gap is closed from both sides, on the same 12-hour clock. **The checker
landed first and the workflow wiring is a separate PR** — `.github/` is a
governed path, so wiring it needs a founder label, and parking the whole fix
behind that label would have left nothing watching in the meantime. Until that
second PR merges, the two `watch-nightly.mjs` rows below are a command a human
can run, not a schedule:

| guard | lives in | says |
|---|---|---|
| digest freshness | `docs/agents/runner-prompts/foray-nightly.md` step 2 | the agent refuses a digest older than 12h — *the Action did not run* |
| digest absence | `tools/refresh/watch-nightly.mjs --mode absence` | a digest older than 12h with no `nightly/<date>` PR is red — *the agent did not run* |
| overwrite | `tools/refresh/watch-nightly.mjs --mode overwrite` | the Action stops **before publishing** if it is about to replace a digest that never merged |

One number, two directions: **a digest must be consumed within 12 hours of being
made.** 12h is roughly double the worst healthy latency anyone has measured here
(the Action can start 85 minutes late under GitHub's scheduling load, and the
agent runs later still), which is what keeps it from becoming an alarm people
learn to ignore.

### Why the third row is the important one

`resolved.json` is **replaced** on the digest branch each night, not appended,
and `scan.mjs` marks every episode it emits as seen. So a digest that is
overwritten before it merges takes its episodes out of the pipeline for good —
they are neither in the pool nor in any future scan. That is not a delay, it is
data loss, and it needs two consecutive missed nights to happen:

> 2026-08-19 ended up holding **10** episodes against the previous Wednesday's
> **30**. A deliberate 72-hour re-scan (#293) recovered 17 of them.

The overwrite guard runs inside the Action, before the scan, so a night it fires
leaves `resolved.json` and `refresh-state.json` exactly as they were. Nothing has
to be recovered — detection is prevention.

**One missed night is survivable. Two consecutive misses destroy data.**

### Clearing a red overwrite guard

The guard fails the job before anything else runs, so while it is red the
pipeline publishes nothing. That is the correct trade against silent loss and it
is only safe because the way out is written down rather than inferred. The red
run's own summary prints all of this, computed from the stuck digest:

1. **Do not run the runner against the digest on the branch.** By the time the
   guard fires that digest is over 12h old, so the runner's step-2 staleness
   guard refuses it. The two guards agree; trying it first only costs a cycle.
2. **Re-cut the digest**: clear the local seen-guid state and re-scan with a
   window wide enough to reach back past it (the report computes the number —
   72h is right for a one-day-old digest and too small for one stranded over a
   weekend).
3. **Name the branch after the DIGEST's date**: `nightly/<digest-date>-recovery`.
   That is the string the guard looks for. A branch named after the day the work
   happened matches nothing and the guard stays red. #293 got this right.
4. **If the episodes are genuinely gone from the feeds**, re-run
   `nightly-refresh` from the Actions tab with the `overwrite_unmerged_digest`
   input set. That is the only way past the guard, and it is deliberately a
   decision someone makes on purpose, with their name on the run.
