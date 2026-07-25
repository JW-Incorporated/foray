# Nightly refresh — cloud topology

How Foray's content refresh runs in the cloud after the migration. Two stages,
split by whether they need credentials or judgment (the Swift2 two-tier model).

```
┌─────────────────────────── GitHub Actions (keyless, deterministic) ──────────────────────────┐
│  nightly-refresh.yml  @ 09:40 UTC                                                              │
│    checkout main → npm ci (backend) → restore state from refresh-digest                        │
│    → scan.mjs (RSS)  → resolve.mjs (iTunes)                                                     │
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
- The old local Windows task (`scripts/nightly-refresh.cmd`) remains as a manual
  fallback until Phase 4 cutover.
