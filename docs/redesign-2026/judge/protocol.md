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

## Order: both orders, not a coin flip

For calibration and the Phase 2 ranking, **every pair is shown in both orders,
each order to a different judge** (with three judges, at least one sees each
order). Inside a build loop's quick iterations a fair coin per judge is enough.
Record the mapping (`A = <path>`) outside the judge's context so the verdict can
be mapped back. `tools/ui-lab/judge-set.mjs` does the assignment, the neutral
`A.png`/`B.png` copies and the key.

**Order check.** For every pair with two non-tie verdicts in opposite orders,
report whether the verdicts follow the image (same image wins both times) or the
letter (A both times, or B both times). Letter-following above 20% of a run's
pairs means position is driving verdicts: the run is void, not averaged.

**One judge, several pairs.** A judge may take a batch of pairs, but never two
pairs that show the same screen: the untouched image recurs across the pairs and
gives the answer away. `judge-set.mjs` enforces this (`group`).

**Measuring is allowed and recorded.** Judges may sample colours or measure
offsets (round 2's judges quoted hex values and pixel insets; one wrote crop
scripts). Measured reasons are more actionable, but the verdict stays holistic.
Note in the run record whether judges had tools, so calibration and use stay
comparable.

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

**The 14-pair set above is a smoke test, not the trust bar** (skeptic review,
`skeptic-review.md`). Every pair in it had a wide gap or a non-design tell: a
marketing frame at a different resolution, two of them carrying an Editors'
Choice laurel or a five-star review quote, and degraders a non-designer would
call broken. The trust bar is the **hard set**, `hard-pairs.json`, built with
`node tools/ui-lab/judge-set.mjs --pairs docs/redesign-2026/judge/hard-pairs.json --out data-local/redesign/judge-hard`:

- 18 near-miss pairs: today's screen against itself with **one** subtle defect
  from `degraders/subtle/` (spacing rhythm, contrast at just-AA, flattened type
  scale, a 5-8px misaligned edge, mixed radii, accent overuse), three screens per
  defect;
- 4 frame pairs: the same render framed and unframed (expected: tie), and a
  subtly degraded render framed against today raw (expected: raw);
- 3 reference-vs-reference pairs (both framed), scored for order consistency;
- every pair in both orders, two judges per pair, one per order (an exception
  to "three judges for calibration": agreement across opposite orders is the
  stronger test, and a third vote cannot overturn a 2-0).

Pass bar: at least 16 of 18 near-miss pairs decided for today's side and none
2-0 for the degraded side; no same-UI frame pair won by the framed side; order
check at or under 20%. Re-run the hard set whenever the rubric changes.
Reference images used anywhere in calibration must not carry award, rating or
press text in the frame.

## What calibration cannot certify (read before Phase 2)

Both sets have a known answer because one side is today's screen or a broken
copy of it. Phase 2 compares **different polished designs**, where no answer
key exists. Calibration shows the judges catch single-dimension craft
regressions and are not swayed by position or framing; it cannot show their
weighting of trade-offs between two good directions matches the owner's. So in
the Phase 2 ranking: three judges per pair with both orders represented, a 3-0
outcome is a win, **a 2-1 outcome is reported as a lean**, and an
order-following pair is a tie. The ranking narrows the field; the owner's pick
decides between leans.

## Recording

Each run of the protocol writes one JSON line per judge per pair (pair id,
which path was A, the verdict object from the rubric) and a short report with
the aggregated outcome per pair. Calibration results go in
`docs/redesign-2026/judge/calibration.md`; screenshots are referenced by
their `data-local/` path, never embedded or committed.
