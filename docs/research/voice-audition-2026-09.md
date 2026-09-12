# The founder voice audition — twelve in, three out

**Status:** kit built, **not yet rendered**. This document holds the slate, the
decision rule and the sealed label key. The result section at the bottom is
empty on purpose and is filled in by whoever runs the audition.

Companion to `docs/bundled-voice-plan.md` §6 and card K-03. The kit is
`tools/narration/render-audition.py`; the passage is
`tools/mobile/kokoro-probe-passage.json`, the same one K-01's on-phone probe
times, so the thing the founders rank is the thing the phone was measured on.

## 0. The brief, verbatim

Wyatt, 2026-09-06:

> "for the voices, the founders should try out a dozen first and choose our 3
> favorites, which are then selectable from within the app"

And the reason this matters now — Wyatt, 2026-09-11, on the platform voices:

> "those voices were all so bad. Samantha was the least worst"

which is what cut the narration voice picker down to Samantha alone as a
stopgap. This audition is how that stopgap ends.

## 1. What is being judged

**Not "is this a good voice".** Specifically:

1. **Does it sound like a person reading, over ninety seconds of real
   narration?** Not a demo sentence. The passage runs a disclosure, two
   narration beats and a pronunciation fixture, because a voice that is
   pleasant for ten seconds and wearing for ninety is the failure mode this
   product has already met once.
2. **Does it get the six hard words right?** `binchōtan`, `barbacoa`, `asado`,
   `braai`, `ch'arki`, `Taíno`. These are rendered from K-02's phonemes with
   the lexicon applied, so a voice that mangles them is mangling a phoneme
   string that is already correct — which is a fact about the voice, not about
   our pronunciation work.
3. **Does it survive 1.5× and 2.0×?** Long-form listeners live at the fast end
   of the ladder. A voice that is lovely at 1.0× and a chipmunk at 1.75× is not
   a voice this app can ship. This is the confirm round, and it is deliberately
   separate: it is not allowed to influence the blind ranking.

**What is deliberately NOT being judged:** the model card's own letter grades.
They are recorded in §2 because they chose the slate, and they are the reason
the labels are blind — a founder who can see that one clip is the model's own
A-grade voice is ranking the grade.

## 2. The slate

Twelve, in the order `render-audition.py`'s `SLATE` carries them. Grades are
from [Kokoro's VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
and are the publisher's own, not ours.

| Voice | Accent · gender | Publisher's grade |
|---|---|---|
| `af_heart` | American · female | A |
| `af_bella` | American · female | A- |
| `af_nicole` | American · female | B- |
| `bf_emma` | British · female | B- |
| `af_sarah` | American · female | — |
| `af_kore` | American · female | — |
| `af_aoede` | American · female | C+ |
| `am_michael` | American · male | — |
| `am_fenrir` | American · male | — |
| `am_puck` | American · male | C+ |
| `bm_george` | British · male | — |
| `bm_fable` | British · male | C |

Only two of the twenty English voices grade above B on the publisher's own
scale, which is why the slate reaches down to C+ and C rather than taking "the
top twelve": a grade is one listener's opinion of a demo sentence, and the
whole point of an audition is to replace it with ours.

**Blends are not on the slate.** Kokoro can average two style vectors; K-03 may
add up to two if a founder asks after hearing the twelve. The slate ships as
twelve so the ranking arithmetic below stays simple.

## 3. How the clips are made

Every clip comes from the **same ONNX graph and the same q8f16 weights the app
will bundle** — the ones `tools/mobile/fetch-models.mjs` pins by sha256, not a
hosted playground and not the fp32 demo. Deck §5 item 5 is the reason: the
model card says the model is "resilient to quantization" and nobody in this
repository has listened. The founders judge what listeners get.

Clips are rendered from K-02's **phonemes**, not from text, so the lexicon
overrides are in the audio.

Output paths are deterministic (`mobile/models/audition/<passage-sha>/<label>-<speed>.wav`),
so a re-render overwrites rather than accumulates and two runs are comparable.
**No audio is committed** — twelve 90-second clips are ~130 MB; they are a
release asset, like the model itself.

### Running it

```
node tools/mobile/fetch-models.mjs --check     # fill the sha256 pins first
node tools/mobile/fetch-models.mjs             # fetch the weights and voices
python tools/narration/phonemize.py --passage tools/mobile/kokoro-probe-passage.json --in-place
python tools/narration/render-audition.py --check
python tools/narration/render-audition.py --render --key-out /tmp/audition-key.json
```

`--check` prints exactly what is missing and the commands that fix it.
`--render` **refuses** rather than writing silence or a substitute voice, and
that is the kit's single most important behaviour: a founder ranking twelve
blind clips has no way to tell a fake one from a real one.

## 4. The decision rule — written before the listening

Agreed from deck §6, recorded here so the result is arithmetic rather than an
argument after the fact.

1. **Blind ranking round, 1.0× only.** Each founder listens to all twelve,
   labelled A–L, in any order they like, and writes down their **top five in
   order**. Nobody sees the key.
2. **Combined rank.** A voice's score is the sum of its positions across the
   founders' lists; a voice absent from a list scores 6 for that list (one
   worse than last place). **The three lowest combined ranks ship.** Ties are
   broken by the better single placement, then by the earlier label.
3. **Confirm round, 1.5× and 2.0×.** Only the three winners, only a short
   listen. This round can **veto** — a voice that falls apart at speed is
   replaced by the fourth-placed voice and the round repeats — but it cannot
   re-order the three.
4. **The default** is the winner of the combined rank, surviving the confirm
   round.
5. The key is unsealed only after both rounds are recorded below.

The three winners become `mobile/plugins/foray-tts/voices.json` and the picker's
rows (K-04, K-05); the decision is recorded in `docs/DECISIONS.md`.

## 5. The sealed key

**Not published here before the ranking.** `render-audition.py --key-out <path>`
writes the label→voice mapping to a file the audition page never reads; keep it
out of the room until §6 has both founders' lists in it. Paste it into §7 when
the ranking is recorded.

## 6. Results — the ranking

*(empty: the audition has not been run)*

| Founder | 1st | 2nd | 3rd | 4th | 5th |
|---|---|---|---|---|---|
| Wyatt | | | | | |
| Joey | | | | | |

Combined ranks:

| Label | Combined | Ships? |
|---|---|---|

Confirm round at 1.5× / 2.0×:

| Label | 1.5× | 2.0× | Verdict |
|---|---|---|---|

## 7. The key, unsealed

*(empty until §6 is filled in)*

## 8. What was not done here, and by whom

Written 2026-09-12 on a Windows machine with no ONNX runtime, no Kokoro weights
and no phonemizer. So:

- **No clip has been rendered**, and none is faked. `--render` refuses.
- **Nobody has heard a Kokoro voice for this product** since the original
  acceptance fixture (`self-hosted-tts.md` §2, `af_heart`) — which is the voice
  Wyatt liked, and the reason it leads the slate.
- **The grades in §2 are the publisher's**, quoted, not verified.
