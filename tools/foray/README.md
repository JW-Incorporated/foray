# Foray assembly (`tools/foray/`)

Issue #182 / #134. `data/segments.json` is a **pool**; `data/forays.json` is a
**sequence**. This directory is what keeps the second one honest.

| File | Role | Network? |
|---|---|---|
| `check-forays.mjs` | Structural integrity + the tier-A ordering rules (D1–D5, M3, M4) and, because `role` is recorded here, the per-role bounds L2/L3/L4 | no |
| `check-forays.test.mjs` | Runs the checker over the committed data — **this is the CI gate** — and breaks each rule on purpose to prove it fires | no |
| `verify-source-audio.mjs` | Re-verifies every `audio_url` with a 2-byte ranged GET | **yes — manual only** |

Dependency-free ESM, like the rest of `tools/`. No install step.

## The two data files

### `data/forays.json`

```jsonc
{
  "version": 1,
  "forays": [{
    "id": "grilling-history-1",
    "kind": "deep-dive",            // #134
    "title": "The history of grilling",
    "topic": "food/grilling-bbq",   // a data/taxonomy.json node
    "status": "draft",              // only "published" may reach a listener
    "summary": "...",
    "runtime_sec": 3673.03,         // pinned to the sum of the items
    "source_doc": "docs/curation/grilling-foray.md",
    "label_prefixes": { "ORI": "origin-stories-cooking-human", ... },
    "slots": [{ "id": "fire-origins", "title": "Fire and the origins of cooking" }, ...],
    "items": [
      { "type": "segment", "slot": "fire-origins", "label": "ORI-1",
        "segment_id": "origin-stories-cooking-human#147", "role": "explanation" },
      ...
    ]
  }]
}
```

`items` **is** the running order — the array index is the listening position,
and no `position` field exists because a second expression of the same fact is
a second thing that can be wrong. Narration bridges enter the same list as
`{ "type": "narration", "id": "...", "script": "..." }` (#134's shape); none are
authored yet, and the checker accepts and skips them so a Foray that grows one
does not have to change this directory.

**Nothing here duplicates `data/segments.json`.** A segment is referenced by id,
so a corrected segment fixes every Foray using it. Three fields look like
exceptions and are not:

- `label` — the `ORI-1` / `GRID-3` names `docs/curation/grilling-foray.md` §2
  uses. There was no committed mapping between those and segment ids; it was
  re-derived by matching on (source episode, duration), which is unique to
  0.1 s. Recording it means nobody re-derives it again, and `label_prefixes`
  makes the recording checkable rather than decorative.
- `role` — `quote` / `explanation` / `exchange` / `narrative`. Proposed in
  `docs/curation/segment-length-rules.md` §9 but **not** part of the schema
  `merge-segments.mjs` writes, so today it can only live here. Without it D2 and
  D4 are permanently uncheckable. The checker reads the segment's own `role`
  first and only falls back to the Foray's copy, and it errors if the two ever
  disagree — so the day the pool schema gains the field, this copy can be
  deleted with no other change. Recording it also makes **L2, L3, L4 and D4**
  checkable for the first time; `grilling-foray.md` §4 lists all four as
  unverifiable from the committed data, and for a Foray's segments they no
  longer are.
- `runtime_sec` — derived, and asserted equal to the sum of the items. A derived
  field pinned by a check is a drift detector, which is the same job
  `estimated_total_min` does for a ladder.

### `data/segment-sources.json`

The episode-level companion to the segment pool, keyed by the same `item_id` a
segment carries. Without it a segment's `start_sec` resolves to nothing: `app.js`
gives an item a play button only when it has an `audio_url`.

It is **not** `data/discover.json`, and that is deliberate:

1. `discover.json` is machine-owned. `tools/refresh/merge.mjs` rewrites it
   wholesale (its own comment in `backfill-audio.mjs` says so), so a hand-added
   row survives until the next nightly and no longer.
2. Worse, `resolve.mjs` mints ids from the show slug, so the nightly would
   eventually re-add the same episode under a *different* id — the exact "one
   episode under two ids splits user state" failure `ci.yml`'s dupe invariant
   exists to catch, and it could not catch it (our rows carry no
   `apple_track_id`).
3. `discover.json` is the **recommendation pool**: `fullPool()` in `app.js`
   feeds scoring, the ~30 % exploration floor, the semantic index and
   `item-tags.json` from it. Nine hand-picked curation sources are inputs to a
   Foray, not things to recommend.

The cost is that `ci.yml`'s data invariants name `discover.json` and
`session.json` and therefore skip this file. So the ones that matter — https
scheme, no tokened URL, a boolean `dai_suspected` — are re-asserted by
`check-forays.mjs`, and `.github/` is a denied path for auto-merge anyway.

## Running it

```
node tools/foray/check-forays.mjs           # human output, exit 1 on violation
node tools/foray/check-forays.mjs --json    # machine-readable
node --test "tools/foray/*.test.mjs"        # what CI runs
node tools/foray/verify-source-audio.mjs    # live 206 check, manual
```

CI reaches the checker through the test file, not through `ci.yml`:
`tools/ci/run-suites.mjs` discovers `tools/**/*.test.mjs`, so this suite ran the
day it landed without a workflow edit.

## D5 is ambiguous, and this is the reading that is gated

`segment-length-rules.md` §9 says "no 3 consecutive durations within ±20 %" and
`grilling-foray.md` §5 records that the sentence has two readings and does not
choose between them:

| reading | a triple violates when | on Foray #1 |
|---|---|---|
| **pairwise** (gated) | `max/min ≤ 1.2` | 0 violations |
| mean-deviation (warned) | all three within ±20 % of the triple's own mean | 3 violations |

**Pairwise is the gate.** "Within ±20 % of *each other*" is a statement about
the members of the triple; the mean is a fourth quantity the rule never
mentions, and reading it in makes the rule strictly stronger than its own words.
It is also the reading that serves the rule's purpose: 97.9 / 126.7 / 101.8 s is
a mean-deviation violation, and a segment 29 % longer than its neighbour does
not sound metronomic. The stricter reading is still computed and printed as a
warning, so the three triples §5 names stay visible instead of being quietly
resolved in our favour.

## D1 counts starts; the doc counts gaps

`grilling-foray.md` §5 reports "the tightest run of six spanning 620.5 s". That
span is `start[i] → start[i+6]` — seven starts and six gaps. `maxStartsInWindow`
counts starts inside a half-open 600 s window, which is what the rule's text
says. Both agree on Foray #1: at most **6** starts in any window, against a
budget of **6** for a 45–120 minute Foray. The budget is met exactly, which is
why §5's "it was fixed rather than reported" matters — one more segment and this
goes red.
