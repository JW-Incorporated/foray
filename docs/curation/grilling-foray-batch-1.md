# Grilling Foray — segment batch 1: the first non-empty `data/segments.json`

Batch `seg-2026-08-16-bfh-hearth-a`. **9 segments, 17 min 19 s**, cut from two
episodes of The British Food History Podcast and merged by
`tools/segments/merge-segments.mjs`. Before this batch the file held zero
segments, so #128 (SegmentStrip), #133 (player strip) and #111 (out-point seek)
had nothing to render.

Constrained by `docs/curation/segment-length-rules.md` (how long, how often),
`docs/adr/0007-segment-anchoring.md` (what a boundary is) and
`tools/segments/README.md` (the batch/results contract and the verbatim-anchor
rule). Sits behind `docs/curation/grilling-foray-passages.md`, which inventoried
candidates from publisher transcripts. That pass named this show in its Scope
note and deliberately left it out — *"The American and British halves of the arc
are being transcribed by another workstream and are deliberately absent"* — so
BFH is not in its ASR queue either. This batch is that other workstream's
output, and it is the first material from the British half of the arc.

---

## 0. TL;DR

| | |
|---|---|
| Segments merged | **9** (0 rejected by the validator) |
| Total runtime | **1,038.7 s — 17 min 19 s** |
| Median / mean duration | **113.9 s / 115.4 s** (B1 target band 75–180 s; D3 mean floor 90 s) |
| Shortest / longest | 57.1 s (`quote`) / 174.0 s (`explanation`) |
| Topic id | **`food`** — see §5 |
| Arc slot | **pre-modern hearth / spit / griddle cookery** |
| `transcript_source` | **`asr-local`** on every record |
| `dai_suspected` | **false** on both episodes |
| `needs_review` | **false** on all 9 |

## 1. Sources

Both from The British Food History Podcast (Dr Neil Buttery), transcribed by us
with `tools/transcribe/bench.py` (`base.en`, word timestamps, 0 suspect word
times). Both measured ad-free at ratio **1.000**, so the ASR timeline is the
same timeline the listener's copy has and `start_sec`/`end_sec` are usable
directly; the anchors are the durability backstop ADR-0007 asks for, not a
workaround for drift.

| `item_id` | Episode | True duration | Segments | Runtime taken |
|---|---|---|---|---|
| `bfh-griddle-bakestone` | Griddle & Bakestone Cookery with Peter Gilchrist & Ross Clarke | 2,764.5 s (46.1 min) | 5 | 566.7 s (20.5 %) |
| `bfh-medieval-meals-manners` | Medieval Meals & Manners with Danièle Cybulskie | 2,209.5 s (36.8 min) | 4 | 472.0 s (21.4 %) |

The 20 % relative cap (L5) is **per segment**, and the largest share any one
segment takes of its own episode is 7.0 % (MED-4; the longest segment, GRID-5 at
174.0 s, is 6.3 %). The episode-share figures above are the batch total and
are recorded because they matter at assembly time: M4 caps any one `item_id` at
25 % of a Foray's segments and runtime, and a two-episode pool obviously cannot
satisfy that on its own. **This batch is a pool contribution, not a Foray.**

## 2. What was selected

Every anchor was copied verbatim out of our own ASR JSON and then resolved back
against the real `buildTranscriptIndex()` / `findAnchorOccurrences()` — 18 of 18
anchors resolve exactly once, all ≥ 9 words, all inside
`ANCHOR_TIME_TOLERANCE_SEC`. `start_sec`/`end_sec` are taken from the *word*
timestamps of the anchor text itself, so the timeline cache and the anchor
cannot disagree by construction.

**The `role` column below is the only record of these roles.** The field is
proposed in `segment-length-rules.md` §9 but is not part of the schema
`merge-segments.mjs` writes, so it is dropped at merge time — which means L2, L3
and D4 cannot be re-checked from the committed file by anyone reading it later.
Roles were authored in the results file and are reproduced here so the
judgement is at least written down somewhere.

### `bfh-griddle-bakestone`

| # | start → end | Dur | Role | Conf | What it teaches |
|---|---|---|---|---|---|
| GRID-1 | 739.9 → 865.1 | 125.2 s | explanation | medium | The open hearth was the place of cookery across Wales, Scotland and much of England until the mid-19th century; no home oven, so you asked the local butcher or baker. Then why an implement survives at all — utility plus attractiveness — with mid-19th-century decorative bakestones that pressed a pattern into the loaf, and drop scones as the utility that kept the girdle in use. |
| GRID-2 | 967.9 → 1037.1 | 69.1 s | explanation | high | Households that could not afford a bakestone cooked on bare stones, or on soaked wood. Poverty and access, not shame: within living memory of starvation, the implement was an object of affection. |
| GRID-3 | 1360.3 → 1417.4 | 57.1 s | quote | high | Reading a bakestone's heat without a thermometer: people run them far too hot, bring the heat up slowly, and throw flour on to time how fast it browns. |
| GRID-4 | 1691.2 → 1832.4 | 141.3 s | explanation | high | What a Welsh cake actually is — rubbed-in fat, currants, contested mixed spice, a minute or two a side — and that in the Newport valleys the cakes themselves were called *bakestones*, after the thing they were cooked on. |
| GRID-5 | 1970.9 → 2144.9 | 174.0 s | explanation | high | Bannocks: oats, barley or pea flour, with wheat arriving only in the 20th century; 100-plus written varieties; and the Orkney custom of one giant pea-flour bannock per household member, split for breakfast and for the midday "piece" — the word that replaced *sandwich* in Scots. Ends on the cottage dairy cycle that supplied the buttermilk. |

### `bfh-medieval-meals-manners`

| # | start → end | Dur | Role | Conf | What it teaches |
|---|---|---|---|---|---|
| MED-1 | 673.3 → 775.8 | 102.5 s | explanation | high | Walking into a feast: top table on a raised platform, benches facing inward, hands washed on arrival in water that might carry flower petals but not soap — soap was for baths — then a shared dish and cup, but your own spoon and knife. |
| MED-2 | 943.8 → 1044.0 | 100.2 s | explanation | high | Rank measured as distance from the salt cellar. Above the salt and below it; the grand ones jewelled and set high to be seen, while a lesser guest got a salt cellar carved out of bread. Lands on the observation that wedding seating still works this way. |
| MED-3 | 1325.9 → 1439.9 | 113.9 s | explanation | high | Why squires served and carved: knighthood is service, the king is carved for by someone of rank, and young men learn manners by watching them up close. Then the carving vocabulary — each animal had its own word, you *lift* a swan and *wing* a quail. |
| MED-4 | 1543.3 → 1698.6 | 155.3 s | explanation | high | The lady of the house as the logistics of a feast: without refrigeration you plan far ahead, market days and spice arrivals constrain you, and linen, dishes and napkins could be **rented**, because everything was handmade and stacks of it were beyond most budgets. |

### Batch-level shape (§9's B-tier)

- **B1 median 113.9 s**, inside the 75–180 s target band.
- Mean 115.4 s, above the 90 s whole-Foray floor.
- Durations run 57.1 s to 174.0 s. **The interquartile range does not clear
  D5's 45 s floor under the usual definition, and this is reported as a miss,
  not a pass.** It is **41.0 s** under Tukey hinges and under R-7 linear
  interpolation (NumPy's and R's default, Excel `QUARTILE.INC`), and **63.6 s**
  only under the exclusive definition that drops the median from both halves
  (Excel `QUARTILE.EXC`). D5 names no definition; on these nine numbers the
  choice decides the verdict, so it should.
- **D5's other clause does have something to say here, and it binds the
  assembler, not this batch.** MED-1, MED-2 and MED-3 are 102.5 s, 100.2 s and
  113.9 s — all within 13.7 % of one another. Played consecutively they would
  break "no 3 consecutive durations within ±20 %". D5 is a tier-A rule, so it
  cannot fire on a pool; whoever assembles a Foray from these must not order
  those three adjacently.
- One `quote` (11 % of segments, under D4's 20 % cap); the rest `explanation`,
  all between the 60 s floor and the 360 s ceiling. No segment exceeds the 240 s
  soft maximum, so no `long_reason` and no `needs_review` anywhere.
- Starts are placed ahead of the load-bearing claim (§3f), but **two of them are
  mid-clause rather than at a sentence boundary**: GRID-2 opens on "with bake
  stones, or did it manage to survive it" (the host's preceding words were "the
  same's happened with") and GRID-5 opens on "people think about most proudly".
  Both are sacrificial head, so nothing load-bearing is lost, but a listener
  hears a fragment for the first two seconds. GRID-2 is the weaker of the two
  and would be the first thing to re-cut.
- S1's cold-open test does not fire on any `start_anchor` as §7 writes it — no
  first word is in its enumerated list. **GRID-1 is a coin flip**: it opens on
  "I", which §9's gloss ("connective/pronoun") would catch even though §7's list
  does not contain it. Left without an override because the list is the testable
  half of the rule; flagged here because the gloss and the list disagree.
- S2's clean-out check passes on all nine: every `end_anchor` lands on a
  sentence terminal in the transcript, not mid-clause.

### Same-episode gaps (M1/M2)

No pair is inside the 45 s must-merge window. Four pairs fall in the 45–180 s
"should merge" band and are kept separate with a reason recorded in the results
file:

| Pair | Gap | Why not merged |
|---|---|---|
| GRID-1 → GRID-2 | 102.8 s | The elided span is the other guest answering a different question, about Welsh identity rather than hearth cookery. Merging lands at 297 s, past the soft maximum. |
| GRID-4 → GRID-5 | 138.5 s | A book recommendation plus a run of Welsh bakes the ASR renders too poorly to cut (see §3). |
| MED-1 → MED-2 | 168.0 s | A digression about gemellions and about inherited spoons as keepsakes — objects, not the table. |
| MED-3 → MED-4 | 103.4 s | Contains a stretch the ASR under-transcribes, plus an aside about film knives. Merging would produce a 372 s segment, past `explanation`'s 360 s ceiling. |

All four keep chronological order within their episode (rule M3 of the
length-rules table, an integrity rule rather than a taste one).

## 3. What was rejected, and why

**Nothing was rejected by the validator** — 9 authored, 9 merged. Everything
below was rejected *before* it was authored.

- **Both sponsor reads (Netherton Foundry).** 139–208 s of the griddle episode
  and the first 66 s of the medieval one. Never a boundary, never a segment;
  product principle #3 and #63 §3 both say a boundary is chosen editorially and
  that ads falling outside it stay incidental.
- **All housekeeping.** Season-10 postbag appeals, the 100th-episode countdown,
  social handles, the Food History Festival plug, sign-offs. Roughly 6 minutes
  of the griddle episode and 5 of the medieval one.
- **F. Marian McNeill and *The Silver Bough*** (griddle 2175–2273 s). Genuinely
  good historiography — *"the first time really that in our history that we have
  asked working class people what is on their plates"* — but a plug for the
  guest's own podcast sits about 26 s in (2200.9 s), and the passage is about a
  book rather than about cooking on fire. Held, not dismissed: it would earn a place in a Foray
  about food history's sources.
- **Welsh pancakes, *bara planc* and pikelets** (griddle ~1863–1928 s). On-brief
  — bread baked on the stone that rises when you do not expect it to, and
  pikelets as an unformed crumpet of Welsh origin — but the ASR mangles the
  payoff (`"which an un-unformed crumpet"`, `"crème pog"`), and it sits 31 s
  after GRID-4, inside the must-merge window. Taking it would have forced a
  237 s segment with 30 s of host transition in the middle. **Re-cut this if the
  episode is ever re-transcribed on a better model** — the content deserves it,
  the caption text does not.
- **Peter's heat physics** (griddle ~1585–1624 s): watch which fat you use and
  learn its smoke point, and remember that cold batter pulls the stone's
  temperature down, so turn it down a notch each round. A real mechanism, and
  the closest call in the batch. Dropped because taking it would have chained a
  third and fourth M2 flag around GRID-3 and GRID-4 for 40 s of tape; one
  heat-management segment is enough.
- **"A bakestone works on gas, electric or induction"** (griddle ~1120–1157 s).
  The hosts on their own kitchens. No claim, no mechanism.
- **"When did the Middle Ages end?"** (medieval 1236–1298 s). A clean, confident
  answer — the Protestant Reformation, the printing press, gunpowder, and 1500
  for neatness. Nothing to do with food or with fire. Wrong Foray.
- **Sharing, and mitigating it without germ theory** (medieval 1046–1160 s).
  Strong material: wipe your mouth before you drink so you leave no grease on
  the wine, do not drink with food in your mouth, and *"Medieval people didn't
  have germ theory… They did know that if something was dirty, it could cause
  disease or it was just disgusting."* Rejected on two counts — two stretches
  inside it are visibly under-transcribed, and it begins barely 2 s after MED-2,
  so it could only enter as a 216 s merge carrying that damage. (The line
  everyone would quote, *"you don't need germ theory to know that things are
  gross,"* is at 1206.5 s, past the end of the passage and past the point where
  the conversation has moved to turkey legs.)
- **The Goodman of Paris** (medieval 1698–1800 s). An older Parisian writing a
  manual for his teenage wife, who is expected to know the price of a side of
  beef, where in Paris to buy it, and how to get rid of fleas. Contiguous with
  MED-4, so it must merge, and the merge is 257 s — past the soft maximum for
  the sake of a passage that repeats MED-4's point.
- **Nothing failed the audio-only gate.** Both episodes are audio-native. The
  one visual moment — the host holding up a book on camera (*"Oh, there you are.
  Neil holding up the book there"*, 533.5 s of the griddle episode) — is nowhere
  near a chosen boundary.

## 4. Honest limits

- **GRID-1 carries a lossy stretch and is marked `confidence: medium` for it.**
  Between roughly 765 s and 780 s `base.en` under-transcribes: the words are
  dropped, not the audio, so the segment *plays* correctly and both anchors are
  clean and verbatim, but our written record of ~15 s inside it is incomplete. A
  reviewer reading the transcript will see a sentence that does not finish. It
  is kept because the load-bearing claim — the hearth as the place of cookery
  until the mid-19th century — is the single most on-slot line in either
  episode and is cleanly transcribed.
- **`base.en` mangles proper nouns throughout.** *Danièle Cybulskie* becomes
  "Donny Elsableski", *Lady Llanover* becomes "Lady Lanova", *bannock* becomes
  "banach", *aquamanile* becomes "aquaminial". Anchors are verbatim against
  **our** transcript, which is what A13 would re-resolve against, so this does
  not break anything today. It does mean an anchor here would not match a
  publisher transcript if one ever appears, and it is an argument for
  re-transcribing this show on a larger model before it carries more weight.
- **The slot is only half filled.** These two episodes give the *hearth* and the
  *table*. Neither describes spit-roasting, nor fuel choice, nor how a joint of
  meat was actually cooked over fire — the parts of the brief closest to
  grilling. The medieval episode is about dining rather than cooking; that is
  what it is, and pretending otherwise would be the wrong call. The gap is real
  and named here so the next sourcing pass can aim at it.

## 5. Topic id — `food`, deliberately, and provisionally

`merge-segments.mjs` hard-rejects a topic that is not a node in
`data/taxonomy.json`. On this branch the food branch is `food` and
`food/cooking-science` / `food/fermentation`. PR #175 adds `food/food-history`
and `food/grilling-bbq`; it is open, not merged, so those ids do not exist yet
and a segment carrying one would have been rejected.

`food/cooking-science` was considered and refused: this is food *history*, and
mis-topicing nine segments into a node about the science of cooking would make
them findable by the wrong query and unfindable by the right one. So all nine
carry `food`.

**These should be re-topiced to `food/food-history` (and `food/grilling-bbq`
where it fits) once #175 lands.** That is a one-line change per record through
the same merge, not a re-authoring.

## 6. Reproducing this

The batch and results files are deliberately **not committed** — the batch input
embeds the full transcript body, and this repo does not host source prose (see
`docs/DECISIONS.md`). Both are regenerable from the ASR JSON:

```
node tools/segments/merge-segments.mjs --batch <batch.json> --results <results.json>
node tools/segments/merge-segments.mjs --check
```

Re-running the same batch against the merged file writes nothing
("no change — segments file left untouched"), which is the idempotence property
`merge-segments.mjs` promises; it was verified for this batch.
