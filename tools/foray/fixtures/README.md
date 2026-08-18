# The boundary fixture

`boundary/data/*.json` is a four-file checkout that `tools/foray/check-forays.mjs`
can be pointed at with `--root`, and that `loadFiles()` reads exactly as it reads
`data/`. It carries one Foray, `boundary-1`, and it exists for one reason:

> **Issue #236.** `data/forays.json` is live curation. It was also the fixture
> for the #182 acceptance proofs, which meant a curator could not change a Foray
> without a test migration — precisely backwards for the product's core activity.

Nothing here is listenable. `cdn.example` is never fetched: the checker's URL
checks are lexical and no test in this repo opens a socket. Nobody edits this
fixture editorially; it changes only when a proof needs a boundary it does not
yet have, and every number below is load-bearing.

## Why a purpose-built order was necessary, rather than a different Foray

Four of the #182 proofs are properties of an order that sits **exactly on** D1's
budget:

- D1 passes with the budget exactly met — no headroom.
- The tightest seven-start span exceeds the 600 s window, and by how little.
- Putting a held-back segment back breaks **D1 and nothing else**.
- One pair swap breaks **D5 and nothing else** — which is only a sharp proof
  when D1 has no slack to absorb the swap.

None of those is expressible in a Foray with D1 headroom. `grilling-history-2`
runs D1 6/8 with headroom and 0 D5 triples, so it cannot host them, and
rewriting them to fit whatever data exists would leave them green while
destroying what they prove.

## The construction

Thirty segments, durations built from one six-segment period:

```
[72, 148, 84, 168, 65, 88] s      sum 625 s
```

repeated five times, with **one 168 cut to 164** (period 3, position 4). Runtime
is therefore `5 × 625 − 4 = 3121 s = 52.02 min`.

Everything the proofs rest on falls out of that period:

| property | value | why the period gives it |
|---|---|---|
| D1 budget band | **6** | 52.0 min is inside §5c's 45–120 min band |
| D1 max starts in any 600 s window | **6 — met exactly** | every span of six consecutive durations is 625 s or 621 s, both ≥ 600, so no window holds seven starts; and every span of five is ≤ 560 s, so six always fit |
| tightest seven-start span | **621.0 s** | the six windows containing the cut 164 |
| D1 slack | **21 s** | 621 − 600. Enough for a ±16 s swap to keep D1 passing, which is what makes the D5-only swap possible at all |
| mean segment duration | **104.03 s** | 3121 / 30, over D3's 90 s floor |
| IQR (R-7) | **76.0 s** | quartiles land on 72 s and 148 s; over D5's 45 s floor |
| D5 pairwise triples | **0** | every three consecutive durations have max/min > 1.2; the closest is 88/65 = 1.354 |
| D5 mean-deviation triples | **4** | the stricter reading fires where the gated one does not, which is what keeps the warn-only ruling honest |
| D2 | never fires | no duration is under 60 s |
| M4 concentration | **16.7 % of segments, ≤ 17.9 % of tape** | six episodes, one per period position, assigned `episode = (period + position) mod 6` — a Latin square, so each episode gets five segments of five different lengths |
| M3 | holds | each episode's five segments carry `start_sec` 200 / 700 / 1200 / 1700 / 2200 s in play order |

### The held-back segment

`boundary-ep-held#150` is **120 s**, is in the pool, and is deliberately not in
the running order. Put it back at index 4 — between `D-1` and `E-1` — and the
five durations that follow are `[65, 88, 72, 148, 84] = 457 s`, the tightest
five-run in the period. `457 + 120 = 577 s < 600`, so a window holds **seven**
starts against a budget of 6: D1 fails. Nothing else moves — the new
neighbouring triples are 2.0, 2.6 and 1.8 (all clear of D5), the duration is a
legal `explanation`, its episode is 3.2 % of the Foray, and it is the only
segment of its episode so M3 is trivial.

`120` is the load-bearing number: below 143 s the window fails, and the smallest
six-run is 621 s, so `120 + 621 = 741 > 600` — the failure is seven starts, never
eight.

### The D5-only swap

Swap `A-1` (position 1, 72 s) with `F-1` (position 6, 88 s). Positions 5–7 become
`65 / 72 / 72`, max/min 1.108, and D5 fires once. Nothing else does:

- **D1 survives** because the swap moves 16 s and D1 has 21 s of slack: the
  lowest window sum becomes 609 s.
- **Slots survive** because both positions are in the same slot block.
- **M3 survives** because neither episode has another segment between positions 1
  and 6.
- **`runtime_sec` survives** because a swap does not change the sum — so unlike
  the live-data swap this replaces, the proof needs no other edit to be legal.

Of the 435 pair swaps of this order, exactly **two** isolate D5: this one and
`C-3 ↔ B-3` (positions 13 and 18), which is the same structural move one period
later. The suite searches all 435 rather than trusting this paragraph.

## Changing the fixture

Run the checker against it and expect nothing:

```
node tools/foray/check-forays.mjs --root tools/foray/fixtures/boundary
```

Then run `node --test tools/foray/check-forays.test.mjs`. Any change to a
duration, an episode assignment or a `start_sec` moves at least one number in the
table above, and the suite pins all of them — so a change that was meant to be
cosmetic cannot be.
