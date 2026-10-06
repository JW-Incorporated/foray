# Skeptic review of the judge calibration (2026-10-05)

Question: is round 1's 14/14 evidence that the judge can separate designs by
taste at the margins Phase 2 needs, or only that it spots gross breakage?

## Verdict: trustworthy with fixes

- **Round 1 proved little.** Every pair could be decided without design
  judgement (table below). It showed the judges can tell a shipped app's store
  image from a dev render, and a broken page from a working one.
- **The hard set (round 2) is real evidence.** Fresh Opus judges, blind, with
  every pair shown in both orders, got **36 of 36** near-miss judgements right
  across six subtle single-defect types. They showed **no position bias** (0 of
  24 pairs followed the letter) and **no frame halo** (same-UI framed vs raw:
  4 of 4 ties after a fix, see below).
- **What is still unproven:** how the judges weigh trade-offs between two
  *different* polished designs. No answer key exists for that. The protocol now
  treats Phase 2 2-1 outcomes as leans, and leaves the final call to the owner.

## Round 1, pair by pair

All images are in `data-local/redesign/` (gitignored). "Tell" means a way to
reach the expected answer without weighing design.

| Pair | Expected won by | Tell |
|---|---|---|
| rt-1 | Spotify store image | Marketing frame: caption "FIND PODCASTS YOU LOVE", pink backdrop, tilted phone; 1284px wide vs our 786px |
| rt-2 | Overcast store image | **"App Store Editors' Choice" laurel and "The best podcast app – The Verge" quote** sit above the UI |
| rt-3 | Apple Podcasts store image | Frame: caption, device, shadow |
| rt-4 | Tide Guide store image | Frame: caption; also a different domain (charts vs a list) |
| rt-5 | Pocket Casts store image | Frame; our side is the *stress* fixture (150-character title), so the deck was stacked against us |
| rt-6 | Moonlitt store image | **Five stars and a review quote** ("If you love the Moon...") in the frame |
| td-1, td-3, td-5 | today | degrader 1: Impact, Courier and Times mixed, 1-3px gutters, clipped text. A non-designer calls it broken |
| td-2, td-4, td-6 | today | degrader 2: green page, magenta cards, dashed outlines, rotated cards, wavy underlines. Broken on sight |
| rd-1, rd-2 | store image | Both tells at once: frame vs gross breakage |

What round 1 got right: the expected side alternated between `a` and `b`, and
every expected winner won once from each display position. So position bias was
ruled out; the pairs were simply too easy. I could not verify that judges got
neutral filenames (the report does not say). The hard set used neutral copies.

## Round 2, the hard set

**Construction** (`hard-pairs.json`; images under `data-local/redesign/shots/hard/`):

- **18 near-miss pairs.** Today's screen vs the same screen with *one* subtle
  defect. Each defect is a CSS file in `degraders/subtle/`, injected by
  `shoot.mjs`, and all renders come from one session:
  - S1 spacing rhythm: 2px/18px alternating gaps.
  - S2 contrast: secondary text at 4.52:1 (just AA), primary text dimmed to 7.4:1.
  - S3 type scale flattened: ratio 2.0 down to 1.37.
  - S4 misalignment: 5-8px edge offsets.
  - S5 mixed radii.
  - S6 accent overuse.

  Each defect is applied to three of six screens. Pixel diff ranges from 0.26%
  (radii) to 26% (type scale).
- **4 frame pairs.** f1 and f2 put the same render framed against unframed
  (expected: tie). f3 and f4 put a subtly degraded render, framed, against
  today's raw render (expected: raw).
- **3 reference-vs-reference pairs**, both sides framed, with no award text.
  rr1 has a soft key (Apple Podcasts Home over Overcast's dense search
  mosaic). rr2 and rr3 have no key and are scored for consistency only.
- **Blinding.** `tools/ui-lab/judge-set.mjs` copies each pair to neutral
  `j<k>/<nn>/A.png, B.png` folders. Every pair goes out in both orders to two
  different judges, and no judge sees two pairs of the same screen (otherwise
  the untouched image recurs and gives the answer away). The key is moved out
  of the judges' folder.
- **Judges.** Six fresh Opus agents, 8-9 pairs each. Each had only `rubric.md`
  and its own folder.

**Results:**

| Measure | Result |
|---|---|
| Near-miss judgements for today's side | **36 / 36** (25 high, 9 medium, 2 low confidence) |
| Near-miss pairs decided for today's side | **18 / 18**, all 2-0 across opposite orders |
| Per defect | spacing 6/6, contrast 6/6, type scale 6/6, alignment 6/6, radii 6/6, accent 6/6 |
| Order check (same letter picked in both orders) | **0 / 24** pairs; A picked 24 of 49 times |
| Degraded but framed vs today raw (f3, f4) | 4 / 4 for raw (in both runs) |
| Same UI, framed vs raw (f1, f2), fixed frame | **4 / 4 tie** |
| Ref vs ref order consistency | 3 / 3 pairs (6/6 judgements); rr1 soft key 2/2 |
| Misses by defect type | none |

**My own blind pass (a primed ceiling).** I built the degraders, so I know what
to look for. I judged the 18 near-miss pairs from composites with shuffled
sides and numbering, and scored them only afterwards: 17/18. My one miss is
S3 on Now Playing. There I preferred the flatter scale because the title fits
on two lines and the controls move up. Both fresh judges chose today's version
instead, and one named exactly that trade-off ("a one-word widow... a smaller
cost than A's flattened scale"). That key is debatable; it is kept.

**A frame bug I introduced, and the re-run.** The first frame put the render
straight under a camera cut-out, which clipped the header. Judges picked the
raw side because of that real clip (f1 2-0, f2 1-0-1), not because of the frame.
I fixed the frame (status-bar and home-indicator insets, nothing covered) and
re-ran the four frame pairs with two new judges, eyes only: f1 and f2 tied in
all 4 judgements, and f3 and f4 went to raw in 4/4. So the frame neither
helped nor hurt; the judges looked through it.

**Caveats:**

- **Same-layout pairs are easier than Phase 2.** A judge can find the one
  difference first and then decide whether it is a defect. Judges also
  measured: they quoted exact hex values (#AFAAA9) and pixel insets, and one
  wrote crop and diff scripts. That instrument is fine for build loops. It does
  not cover two directions that differ everywhere.
- **No history was not fully met.** Each judge saw 8-9 pairs in one context,
  which deviates from the protocol's no-history rule. The one-screen-per-judge
  rule closes the one leak that matters.
- **Two judges per pair, one per order**, not three. A third vote cannot
  overturn a 2-0.

## Changes made

- **`rubric.md`, "What to ignore":** added two bullets.
  - Award laurels, press quotes, star ratings, review quotes and download
    counts carry zero weight.
  - A frame's camera cut-out or bezel is not the app's clipping.
- **`protocol.md`:**
  - The coin flip is replaced by both orders, each to a different judge
    (calibration and Phase 2).
  - Added an order check: letter-following above 20% voids a run.
  - Added a batching rule: no judge gets two pairs of one screen.
  - Tool use by judges is allowed and recorded.
  - The 14-pair set is demoted to a smoke test. The hard set is the trust bar:
    at least 16/18 near-miss pairs, none 2-0 for the degraded side, no
    same-UI frame pair won by the framed side, order check at or under 20%. It
    is re-run on every rubric change.
  - Reference images used in calibration must not carry award, rating or
    press text.
  - New section "What calibration cannot certify": in the Phase 2 ranking a
    3-0 is a win, a 2-1 is a lean, and an order-following pair is a tie.
- **`calibration.md`:** a note under round 1's verdict pointing here.
- **New files:**
  - `degraders/subtle/*.css`
  - `hard-pairs.json`
  - `tools/ui-lab/judge-set.mjs` (blind set builder; README updated)

The rubric changes add no new judging dimension, so the hard set was not re-run
for them. The frame pairs were re-run after the frame fix.

## Reproduce

```
node tools/ui-lab/shoot.mjs --target app --states returning,player,search --viewports 393x852 --out data-local/redesign/shots/hard/base
node tools/ui-lab/shoot.mjs ... --css docs/redesign-2026/judge/degraders/subtle/s1-spacing-rhythm.css --out data-local/redesign/shots/hard/s1   # s1..s6
node tools/ui-lab/judge-set.mjs --pairs docs/redesign-2026/judge/hard-pairs.json --out data-local/redesign/judge-hard --judges 6
```

Verdicts and keys from this run are in the trunk checkout's
`data-local/redesign/judge-hard*/` (gitignored).
