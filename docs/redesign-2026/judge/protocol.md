# Design judge protocol

How a pairwise comparison is run, so every verdict in Redesign 2026 is produced
the same way. The instrument is `rubric.md`; this file is how it is applied.

## The unit: one pair

A pair is two single screenshots plus the rubric. Nothing else reaches the
judge:

- **No provenance.** The judge never learns which image is 4a, a prototype, a
  reference app or a degraded variant. File names are replaced by `A.png` and
  `B.png` (copy the files to a neutral temp directory before handing them over);
  the brief never says "ours", "current", "reference", "baseline" or the name of
  any direction.
- **No history.** A judge has not seen earlier verdicts, other pairs, the
  expected answer, or the other judges' output.
- **Same screen where possible.** When comparing two versions of 4a (today vs a
  direction, today vs degraded) both images are the same route, state and
  viewport from `tools/ui-lab/shoot.mjs`. Cross-app pairs (reference vs 4a) are
  necessarily different screens; the rubric tells the judge to set subject
  matter aside.

## Order randomisation

For every pair and **every judge independently**, a fair coin decides which
image is shown as A. Record the mapping (`A = <path>`) outside the judge's
context so the verdict can be mapped back. This cancels the known first-position
bias of model judges; with two or three judges per pair, at least one usually
sees the opposite order.

## Judges per pair

- **Three judges** for anything that informs a decision: calibration, the
  direction ranking in Phase 2, and any screen a build loop is about to accept.
- **Two judges** are acceptable inside a build loop's quick iterations. If the
  two disagree (one says A, the other B), add a third.
- Judges are separate agent runs (Opus per `PLAN.md`'s roster), each with a
  fresh context holding only the two images and the rubric.

## Aggregation: majority vote, ties allowed

Map each verdict back to the real files, then:

| Votes | Outcome |
|---|---|
| a strict majority for one side (2 of 2 is unanimous; 2 or 3 of 3) | that side wins |
| 2 judges split, or 3 judges with no side reaching 2 (for example A, B, tie) | **tie** |
| a tie verdict counts as a vote for neither side | |

Report the outcome with its vote split (`B 2-1`, `tie 1-1-1`) and keep every
judge's `decisive_reasons`; the reasons are what a designer acts on.

## Calibration (the rubric is untrusted until this passes)

The calibration set is 14 pairs with known expected winners: reference apps over
today's 4a, today's 4a over its degraded variants (same screen and state), and
reference apps over degraded variants. The expected winner sits on side `a` in
some pairs and `b` in others, before the per-judge coin flip.

- Degraded variants come from `degraders/*.css`, injected with
  `node tools/ui-lab/shoot.mjs --target app --css <file>`; renders live in
  `data-local/redesign/shots/degraded-1/` and `degraded-2/` (gitignored).
- Reference screenshots are App Store listing images in
  `data-local/redesign/refs/<app>/` (gitignored, never committed: third-party
  imagery in a public repo).
- **Pass bar:** at least 12 of 14 pairs decided for the expected side, and none
  of the today-vs-degraded pairs decided for the degraded side. A miss is read
  through its `decisive_reasons` before the rubric is changed; if the rubric
  changes, re-run the whole set, not just the misses.
- Known confound: reference images are marketing frames (captions, backdrops,
  device bezels); ours are raw renders. The rubric tells judges to ignore the
  frame, and calibration measures whether they manage to.

## Recording

Each run of the protocol writes one JSON line per judge per pair (pair id,
which path was A, the verdict object from the rubric) and a short report with
the aggregated outcome per pair. Calibration results go in
`docs/redesign-2026/judge/calibration.md`; screenshots are referenced by
their `data-local/` path, never embedded or committed.
