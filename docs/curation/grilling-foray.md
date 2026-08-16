# Foray #1 — THE HISTORY OF GRILLING

The first complete Foray. **32 segments, 61 min 13 s of tape**, assembled in
listening order across six arc slots, drawn from nine ad-free episodes of five
shows. Batch `seg-2026-08-16-grilling-foray-b` added 27 segments to the 9 that
batch `seg-2026-08-16-bfh-hearth-a` had already merged
(`docs/curation/grilling-foray-batch-1.md`); the pool in `data/segments.json`
now holds **36**, of which 32 are in this running order — §7 says which four are
held back and why.

Constrained by `docs/curation/segment-length-rules.md` (how long, how often),
`docs/adr/0007-segment-anchoring.md` (what a boundary is) and
`tools/segments/README.md` (the batch/results contract and the verbatim-anchor
rule). Every segment was authored against a transcript we produced ourselves
with `tools/transcribe/bench.py`; every source episode was measured **ad-free at
ratio 1.000**, so `start_sec`/`end_sec` are the listener's own timeline and the
anchors are the durability backstop ADR-0007 asks for rather than a workaround
for drift.

---

## 0. TL;DR

| | |
|---|---|
| Segments in the running order | **32** |
| Tape runtime | **3,673.0 s — 61 min 13 s** |
| Playback runtime incl. bridges | ~63–65 min at 4–8 s of narration per cut |
| Segments in the pool after this batch | **36** (27 merged here, 0 rejected) |
| Mean / median segment | **114.8 s / 102.1 s** |
| Shortest / longest | 51.2 s / 237.9 s |
| Interquartile range | 57.8 s (R-7 / Tukey); 62.3 s (exclusive) |
| Source tape read | **10 ASR transcripts, 23,901.7 s = 6 h 38 m 22 s** |
| Episodes used | **9 of 10** — one dropped whole (§6) |
| Topic ids | **5 nodes** — `food/grilling-bbq` 15, `food/food-history` 13, `food/cuisines` 4, `food/cooking-science` 2, `food/baking` 2. See §8 |
| `transcript_source` | **`asr-local`** everywhere |
| `dai_suspected` | **false** everywhere |
| `needs_review` | **false** on all 36 |
| Global rules missed | **None outright.** D1 passes with the budget exactly met; D5 passes on its pairwise reading and three triples violate a stricter reading of the same sentence. §5. |

**The honest headline: this is a 61-minute Foray, not a 100–160 minute one.**
6 h 38 m of tape yielded 47 min 47 s of merged segments — a **12.0 % yield** —
and that is after reading all of it. The shortfall is not caution; §6 lists what
was rejected and why, and one of the ten episodes turned out not to be about
grilling at all. Padding to 100 minutes would have meant taking host chatter,
sponsor-adjacent product talk and personal reminiscence, which the brief forbids
and which is exactly what the rejected material is.

**The 12.0 % yield is the number to keep.** It says what a Foray costs in source
hours: roughly **eight hours of ad-free tape, read end to end, per hour of
Foray.** That is the input to every future scoping decision, and it is measured
rather than estimated.

---

## 1. Sources

Five shows, nine episodes.

| `item_id` | Show / episode | True duration | In pool | In Foray | Runtime in Foray | Share of episode |
|---|---|---|---|---|---|---|
| `origin-stories-cooking-human` | Origin Stories — *Ep 09: Did Cooking Make Us Human? (Re-release)* | 1,522.9 s | 3 | 3 | 419.6 s | 27.6 % |
| `bfh-griddle-bakestone` | The British Food History Podcast — *Griddle & Bakestone Cookery* | 2,764.5 s | 5 | 4 | 509.6 s | 18.4 % |
| `bfh-medieval-meals-manners` | The British Food History Podcast — *Medieval Meals & Manners* | 2,209.5 s | 4 | 4 | 472.0 s | 21.4 % |
| `bfh-18c-tavern-briggs` | The British Food History Podcast — *18th Century Tavern Cooking with Marc Meltonville* | 2,557.2 s | 4 | 4 | 288.6 s | 11.3 % |
| `bbqc-moss-school` | The BBQ Central Show — barbecue school with Meathead and Robert Moss | 3,733.7 s | 5 | 4 | 459.9 s | 12.3 % |
| `bbqrn-santa-maria-grillzilla` | BBQ Radio Network — *Grillzilla: From Santa Maria Smoke to Backyard Paradise* | 2,575.7 s | 1 | 1 | 101.8 s | 4.0 % |
| `moreish-jerk-jamaica` | The Moreish Podcast — *The History of Jerk in Jamaica* | 1,445.0 s | 2 | 2 | 321.9 s | 22.3 % |
| `bbqrn-argentina-open-fire` | BBQ Radio Network — *Argentina Open Fire Cooking with Al Frugoni* | 2,414.2 s | 8 | 7 | 775.8 s | 32.1 % |
| `bbqc-traeger-history` | The BBQ Central Show — the history of Traeger with Wes Wright | 3,733.4 s | 4 | 3 | 323.9 s | 8.7 % |

The **20 % relative cap (L5) is per segment**, and the largest single segment
takes 16.5 % of its own episode (JERK-1, 237.9 s of a 24-minute episode). The
episode-share column is the Foray total and is recorded because it matters at
assembly time, where the binding rule is M4 (§5).

Every one of these nine is now registered in `data/segment-sources.json` with
its publisher enclosure URL, feed, byte length and true duration, which is what
lets a segment's `start_sec` resolve to audio. All nine were re-verified on
2026-08-16 with a 2-byte ranged GET (`tools/foray/verify-source-audio.mjs`):
HTTP 206 on all nine, ad-free ratio 1.0000 on eight and 1.0001 on
`bbqc-moss-school`.

Two `item_id`s are worth pinning down: `bbqc-moss-school` and
`bbqc-traeger-history` reuse the ids the transcription workstream already put on
the ASR files. The rest follow the `<show-slug>-<episode-slug>` shape
`docs/curation/grilling-foray-passages.json` uses.

---

## 2. The running order

**This table is no longer the only copy.** It is migrated verbatim into
`data/forays.json` (`forays[0].items`, in order), where each entry carries the
`segment_id`, the label used here and its arc slot — so the `ORI-1` →
`origin-stories-cooking-human#147` mapping is recorded rather than re-derivable
only by matching durations. `tools/foray/check-forays.test.mjs` re-derives it
anyway on every CI run and fails if the two disagree, which is what stops this
table and the data drifting apart.

Times are cumulative **tape** positions; real playback shifts later by the
narration bridge at each cut. Every claim in the right-hand column is inside its
own segment's boundaries.

| # | at | id | Dur | Role | Source | What it contributes |
|---|---|---|---|---|---|---|
| | | **SLOT 1 — fire and the origins of cooking** (3 segments, 7:00) | | | | |
| 1 | 0:00 | ORI-1 | 152.5 s | explanation | Origin Stories | The hypothesis stated: regular cooked food favoured smaller teeth, mouths and guts. Chimps hand raw food back and wait for it cooked; every animal tested prefers cooked food, down to cockroaches. Two million years ago body and brain grew while chewing capacity shrank — chimps chew four to six hours a day, we chew under one. |
| 2 | 2:33 | ORI-2 | 181.4 s | explanation | Origin Stories | The German study of 572 raw foodists: BMI falls with time on the diet and **half of women of reproductive age stop cycling** — survivable, not sustainable. Then *Homo erectus* as the first species adapted to cooking and *habilis* as the one that started using fire; the first step was stone tools, not heat; and heat gives more energy two distinct ways (more of the nutrient digested in the small intestine, and digested faster for less bodily cost). Lands on how it plausibly began: bush fire, volcano, lightning. |
| 3 | 5:34 | ORI-3 | 85.7 s | explanation | Origin Stories | The counterweight: sites as recent as 40,000 years old show no trace of fire at all. Wonderwerk Cave in South Africa puts controlled fire a million years back, deep enough inside that environmental disturbance cannot explain it — while conceding the burned bones may be fuel, not food. Closes on a quarter of everything we eat going to the brain. |
| | | **SLOT 2 — the pre-modern hearth, griddle and spit** (12 segments, 21:10) | | | | |
| 4 | 7:00 | GRID-1 | 125.2 s | explanation | BFH griddle | The open hearth was where British cooking happened until the mid-19th century; no home oven, so you asked the butcher or the baker. Why an implement survives: utility plus attractiveness. |
| 5 | 9:05 | GRID-2 | 69.1 s | explanation | BFH griddle | Households that could not afford a bakestone cooked on bare stones, or on soaked wood. Poverty and access, not shame. |
| 6 | 10:14 | MED-1 | 102.5 s | explanation | BFH medieval | Walking into a feast: raised top table, hands washed in water that may carry petals but not soap, a shared dish and cup, your own spoon and knife. |
| 7 | 11:56 | MED-2 | 100.2 s | explanation | BFH medieval | Rank measured as distance from the salt cellar — jewelled and set high for the great, carved out of bread for the lesser guest. |
| 8 | 13:37 | GRID-4 | 141.3 s | explanation | BFH griddle | What a Welsh cake is, a minute or two a side, and that in the Newport valleys the cakes themselves were called *bakestones*, after the thing they cooked on. |
| 9 | 15:58 | TAV-1 | 88.7 s | explanation | BFH tavern | The cost of cooking indoors on charcoal. Richard Briggs's burial record, found at St Bride's and dated **1792, four years after his book**: name, *"Cook, Globe Tavern"*, cause *"decline"*. Carbon monoxide off a charcoal stove in a small kitchen stops red blood cells carrying oxygen, and repeated doses do not repair. |
| 10 | 17:27 | GRID-5 | 174.0 s | explanation | BFH griddle | Bannocks: oats, barley or pea flour, wheat only arriving in the 20th century; the Orkney custom of one giant pea-flour bannock per household member, split for breakfast and the midday *piece*. |
| 11 | 20:21 | TAV-2 | 51.2 s | quote | BFH tavern | Hannah Glasse prints the words *Yorkshire pudding* first; before her they were dripping puddings. Hers is a pan of batter under the roast dripping **in front of the fire, not in an oven**, turned so every side crisps. Briggs improves it by cutting it into inch squares so all the corners crisp. |
| 12 | 21:12 | MED-3 | 113.9 s | explanation | BFH medieval | Why squires carved: knighthood is service, and young men learn manners by watching them up close. Then the carving vocabulary — you *lift* a swan, you *wing* a quail. |
| 13 | 23:06 | TAV-3 | 74.0 s | explanation | BFH tavern | A recipe that says *"take a Welsh dish"* means a Buckley, North Wales vessel — not thrown, because the clay carries so much sand that throwing would be like pulling up sandpaper. Pressed from one slab into a mould, and the sand tempers it once fired, so it survives a wood-fired oven. |
| 14 | 24:20 | MED-4 | 155.3 s | explanation | BFH medieval | The lady of the house as the logistics of a feast: no refrigeration, so market days and spice arrivals set the plan — and linen, dishes and napkins could be **rented**. |
| 15 | 26:55 | TAV-4 | 74.7 s | explanation | BFH tavern | **The hinge of the whole Foray.** *Broiling* — grilling over bars, heat from one side or both — is the older English word the British dropped and Americans kept, along with *baked chicken* and *sidewalk*, which 18th-century London used. American English here is older English, not a corruption of it. |
| | | **SLOT 3 — American barbecue's birth and westward spread** (3 segments, 6:16) | | | | |
| 16 | 28:10 | MOSS-1 | 151.3 s | explanation | BBQ Central / Moss | Barbecue was found up and down the eastern seaboard but **took root in Virginia** in the late 18th and early 19th century, then moved west with the settlers — Alabama, Tennessee, Texas — and there were southern-style whole-animal pit barbecues in California **at the time of the gold rush**; by the 1850s a standard feature of the Fourth of July and campaign season. The meccas form as immigrants put their own spin on it; one 1850s California barbecue gave its speeches in four languages. |
| 17 | 30:41 | MOSS-2 | 97.9 s | explanation | BBQ Central / Moss | Real cross-cultural fusion is a phenomenon of the last ten years, not the 19th century. Barbecue stands were eclipsed after the Second World War by fast food and chains, and only in the 1990s and 2000s did anyone go back for the roots. Then a debunking: German immigrants did not bring mustard to Carolina sauce — people of German descent arrived 200 years before mustard sauce was a thing. |
| 18 | 32:19 | MOSS-3 | 126.7 s | explanation | BBQ Central / Moss | **The boomerang, and the best single passage in the batch.** Barbecue reached California in the 1840s–50s, got absorbed into a romanticised Mexican-rancho vision of ranch life, and by the 1920s was a defined California style. New York lifestyle magazines then sold a *"California-style backyard barbecue"* to a suburbanising Northeast — instructions for digging trenches, cuts of beef instead of whole animals — and those led directly to brazier grills lifting the coals out of the ground, then Kingsford charcoal, then Weber kettles, and so to *"what we call grilling today"*. |
| | | **SLOT 4 — US regional divergence** (1 segment, 1:42) | | | | |
| 19 | 34:26 | SM-1 | 101.8 s | explanation | BBQ Radio Network | Santa Maria: on a typical weekend the streets, Broadway in particular, were lined with barbecue pits cooking tri-tip — trailer rigs on an axle that hook to the back of a truck. Tri-tip is a triangular sirloin with **two grains**, one end north-south and the other east-west, so it has to be cut across each. |
| | | **SLOT 5 — world traditions** (10 segments, 19:42) | | | | |
| 20 | 36:07 | MOSS-4 | 84.0 s | explanation | BBQ Central / Moss | The export, as a bridge out of America: a bookshop with a barbecue section **two shelves deep and no American author on it**, whose flagship British title opens with *"forget the gas — what is charcoal"* and runs to kebabs, burgers and steaks. That is what Americans were putting on their new grills in the 1950s, so Britain is *"about 50 years behind us"*. |
| 21 | 37:31 | JERK-1 | 237.9 s | exchange | The Moreish Podcast | Three communities claim jerk — Maroons, Taínos, Africans — and each owns part of the origin. It began as **preservation, not seasoning**: wild hogs hunted by the Maroons, wood ash standing in for scarce salt, a dug pit, and smoke from pimento wood, native to Jamaica and what Americans call allspice. Then the drift from pit and wood to metal grates, and from a cooking style to a flavour profile. |
| 22 | 41:29 | JERK-2 | 84.0 s | explanation | The Moreish Podcast | *Barbacoa*, the Spanish word that becomes *barbecue*, is the root of the Taíno claim — the Spanish reached Jamaica before the British. Taínos and Maroons blended, Africans brought their own smoked-meat traditions, and pimento is the one constant through all of it. |
| 23 | 42:53 | ARG-1 | 148.5 s | explanation | BBQ Radio Network | Growing up in Argentina you do not choose asado. It is how people socialise — a game, a wedding, a baptism, all excuses — and it runs four, five, six hours or more. Every evening you can smell charcoal; the parrillas are lit every night. |
| 24 | 45:22 | ARG-2 | 100.9 s | explanation | BBQ Radio Network | The open-fire family: the Argentine grill, which is a Santa Maria grill **with a firebox at the side**; the classic Santa Maria; fire tables; the *asador* cross you stake an animal on; hanging. You burn in the box and cook only once the embers drop and glow red, controlling heat by raising the grill or adding and removing coal. |
| 25 | 47:03 | ARG-3 | 127.7 s | explanation | BBQ Radio Network | A gauge is useless over open fire — the wind changes it in two minutes. Hold your hand above the grate and count: **two or three seconds is searing heat, five or six is medium** for picanha or pork ribs, ten to twelve is low for beef ribs, a small pig or a lamb. Then you have to keep making embers for the whole cook. |
| 26 | 49:11 | ARG-4 | 79.1 s | explanation | BBQ Radio Network | Over open fire the species of wood matters far less than how it burns and what size ember it leaves. Semi-hardwood — oak, mesquite — because you cook on the ember, so wood flavour is much weaker than in smoking; fruit-wood embers die before the coal bed can be maintained. |
| 27 | 50:30 | ARG-5 | 126.8 s | exchange | BBQ Radio Network | An asado is never one piece of meat. It opens with the *achuras*: choripán; blood sausage; *mollejas*, the thymus gland from neck or heart; *chinchulines*, the intestines. Sweetbreads are a delicacy and cost more per pound in Argentina than beef tenderloin. |
| 28 | 52:36 | ARG-6 | 96.1 s | explanation | BBQ Radio Network | Argentina was colonised by Spain but populated largely by Italians, which is why provoleta, pizza and gelato are Argentine foods. Argentine chorizo is a plain pork sausage with no heat, nothing like Mexican chorizo, and *choripán* is literally chorizo plus *pan*. |
| 29 | 54:13 | ARG-7 | 96.6 s | explanation | BBQ Radio Network | The two traditions measured against each other: a brisket cooked asado-style over open fire took **nine hours**, where a fifty-pound pig takes five. It burned a great deal of wood and demanded constant attention; juicy, good crust, no smoke ring — and he would still rather smoke a brisket. |
| | | **SLOT 6 — the modern backyard era** (3 segments, 5:24) | | | | |
| 30 | 55:49 | TRA-1 | 150.6 s | explanation | BBQ Central / Traeger | Jeremy Andrews came to Traeger from Skullcandy and moved the company from Oregon to Utah when the workforce resisted the turnaround. Through 2020 the brand became **synonymous with pellet grills the way Xerox is with copying**, and rode that into a 2021 IPO — alongside Weber and Solo Brands going public and Middleby buying Masterbuilt, Char-Griller and Kamado Joe. The industry crashed back in 2022, and grill buying turns out to track house buying. |
| 31 | 58:20 | TRA-2 | 105.2 s | explanation | BBQ Central / Traeger | The four-thousand-dollar Timberline launched in spring 2022, exactly as the market turned. The strategy behind a grill nobody can afford is stated outright — *"here's the Corvette but you can't afford this so you're going to buy a Malibu"* — and its innovations trickle down the range until you reset at the top again. |
| 32 | 60:05 | TRA-3 | 68.1 s | explanation | BBQ Central / Traeger | In the golden era of barbecue, ten or fifteen years ago, a wave of charcoals arrived that were genuinely better than Kingsford. **None of them solved distribution** — specialty stores only, regional availability, punishing shipping, half a bag arriving as dust. Kingsford won on the shelf, not on the product. |
### Why the order inside slot 2 alternates rather than running chronologically

The three pre-modern episodes are not on one timeline — the griddle episode
ranges over the 18th and 19th centuries, the medieval one over the 14th, the
tavern one sits in the 1780s — so a strict chronology is not actually available.
The order alternates between the *hearth-implement* thread and the *table*
thread instead, which §6d of the length rules positively wants (**vary the
texture**; prefer alternating speakers to repeating one), and which is also what
D5 forces: MED-1, MED-2 and MED-3 are 102.5 s, 100.2 s and 113.9 s, all within
13.7 % of one another, and batch 1 explicitly warned that they must not be
played adjacently. TAV-4 is pinned last in the slot because it hands the word
*barbecue* to slot 3.

The exact interleaving was then chosen by search rather than by taste, because
it is the only free variable left once the arc slots and per-episode chronology
are fixed, and it is what decides whether **D1** passes (§5). MED-1 and MED-2 do
sit adjacently here — at 102.5 s and 100.2 s they are within 2.3 % of each
other — which is legal (D5 forbids three in a row, not two) and is the price of
clearing the cut budget everywhere else.

---

## 3. What each slot got, and which stayed thin

| Slot | Segments | Runtime | Verdict |
|---|---|---|---|
| fire-origins | 3 | 7:00 | **Full.** One episode, but the right one — the hypothesis, its strongest evidence, and its weakest evidence. |
| pre-modern-hearth | 12 | 21:10 | **Over-full, and still missing the spit.** 35 % of the Foray. |
| american-birth-westward | 3 | 6:16 | **Thin, and it is the historical core.** See below. |
| us-regional-divergence | 1 | 1:42 | **Very thin. One segment.** See below. |
| world-traditions | 10 | 19:42 | **Full for Argentina and Jamaica, empty for everywhere else.** |
| modern-backyard | 3 | 5:24 | **Thin, and it is business history rather than mechanism.** See below. |

**The pre-modern slot is the fattest and the least about grilling.** Twelve
segments and 35 % of the runtime, and only three of them (GRID-1, TAV-1, TAV-2)
are about applying fire to food. The tavern episode narrowed the gap
batch 1 named — TAV-2 finally puts a dish in front of an open fire, TAV-4
supplies the vocabulary — but **nothing in the pool describes spit-roasting a
joint of meat.** The tavern episode says out loud that its chapters on roasting
were left out of the book *"because of things like spits — we're not gonna have a
spit roast anymore"* (566 s), which is precisely the material we wanted. The slot
is long because that is where the ad-free British food-history catalogue is deep,
not because the arc needed 22 minutes there.

**The American slot is three segments because it is one continuous answer.**
Robert Moss's history runs 2,572 s → 3,068 s of his episode without a pause:
**8 minutes 16 seconds** of unbroken speech. Every internal boundary is
therefore an elision inside one voice, and the length rules cap a single segment
at 480 s absolute. The three segments plus the two ~60-second elisions are the
most that arithmetic allows without a same-episode jump cut under 45 s. **This is
the slot to fix next**, and the fix is a second historian episode, not a better
cut of this one.

**The US-regional slot is one segment, and that is a sourcing failure, not a
curation choice.** The Santa Maria episode is a 43-minute interview with a
backyard cook about his nickname, his 27 years in the army, his wife's barbecue
sauce and his koi-pond business. The Santa Maria content is the 100 seconds at
2:14, and it survives on one vivid image (Broadway lined with trailer pits) plus
one mechanism (tri-tip's two grains). Everything else in that episode is
rejected in §6. **Kansas City, Memphis, the Carolinas and Texas have no segment
at all** — they are named once inside MOSS-1 and never described.

**The modern-backyard slot has no mechanism.** The Traeger episode never
explains how a pellet grill works: the words *auger*, *hopper* and *controller*
do not occur anywhere in 62 minutes, and it never tells the Joe Traeger origin
story either — the guest opens at the 2010s Jeremy Andrews era. What it has
instead is the *business* history of the pellet boom and bust, which is real
history and is what TRA-1 and TRA-2 carry, plus one segment on why Kingsford
owns the charcoal aisle. A future batch needs a source that explains the machine.

---

## 4. Per-segment rule compliance (tiers P and B)

- **L1/L2 floors.** Every segment ≥ 50.3 s. Role floors: four `quote` segments
  (57.1 / 51.2 / 58.6 / 50.3 s) clear 30 s; every `explanation` clears 60 s;
  both `exchange` segments clear 75 s. **The shortest `explanation` is TRA-3 at
  68.1 s *in the running order*** — across the whole pool of 36 it is MOSS-G at
  67.0 s, which §7 holds back. The distinction matters because
  `check-forays.mjs` can only evaluate L2/L3 for segments a Foray plays.
- **L3 ceilings.** Longest is JERK-1 at 237.9 s against the `exchange` maximum
  of 480 s. No `quote` exceeds 90 s.
- **L4 soft maximum.** **Nothing exceeds 240 s**, so no `long_reason` and no
  `needs_review` anywhere in the file. JERK-1 at 237.9 s is deliberately cut 2 s
  under the line rather than 2 s over it.
- **L5 relative cap.** Largest share of a source episode by a single segment is
  16.5 % (JERK-1). All 27 new segments are inside 20 %.
- **L6 roles.** All four values used are in the proposed enum. **`role` is still
  not part of the schema `merge-segments.mjs` writes** — but it is now recorded
  on each `data/forays.json` item, so for the 32 segments in the running order
  **L2, L3, L4 and D4 are machine-checked** by `tools/foray/check-forays.mjs`
  after all. The four pool segments held out of the Foray (§7) still have no
  committed role, and for those the §2 column remains the only record.
- **B1 median.** **96.6 s** across the 27 segments this batch authored (the pool
  of 36 is 100.6 s; the 32 in the running order are 102.1 s). All three sit inside
  the 75–180 s target band.
- **Anchors.** All 54 new anchors were built from the ASR word stream and then
  resolved back through the real `normalize()` → `buildTranscriptIndex()` →
  `findAnchorOccurrences()` path before merging: **every one resolves exactly
  once**, every one is ≥ 10 words (batch 1's 18 anchors go down to 9), and
  `start_sec`/`end_sec` are the word timestamps of the anchor text itself, so the
  timeline cache and the anchor cannot disagree by construction.

### S0 sacrificial head — and the seven starts that clip a word

Every start was placed ahead of the load-bearing claim, usually on the host's
question. **Seven starts nevertheless open on a word severed from the clause
before it**, which is a listener-facing defect the length rules' §3f warns about
and which batch 1 named as its own first thing to re-cut. **All seven boundaries
were moved during the reviewer pass**; five now open on a clean sentence and two
still open mid-clause. The full inventory:

| Segment | Opens on | Why it is left |
|---|---|---|
| TAV-1 | *"in 1792, so only four years after the book's published…"* | The orphan is the preposition only, and the date is the best available opening. |
| ARG-3 | *"Let's jump right back into that. Al, how do you gauge your temperatures…"* | Clean sentence; kept. |
| ARG-4 | *"And from a cooking perspective, Al, what woods work best…"* | Clean sentence; kept. |
| ARG-5 | *"So Al, when I was there in Argentina…"* | Clean sentence; kept. |
| TAV-3 | *"the other one that I thought was just vague and turned out not to be…"* | Mid-clause. The alternative start is 5 s later, on the claim itself. |
| MOSS-4 | *"every book under the sun and they actually have a barbecue section…"* | Mid-clause, but it is what makes "two shelves" land. |
| MOSS-G | *"I have never been a fan of cast iron grill grates…"* | Clean sentence; kept. Not in the running order (§7). |

So two mid-clause openings survive — **TAV-3 and MOSS-4** — and both are
throat-clearing rather than payload, which is what §3f asks the head to be. Both
were nonetheless moved from a worse position: TAV-3 previously opened on a bare
*"out"* and MOSS-4 on a bare *"maybe"*.
TAV-2 is a separate flag: it opens *"Mrs Glass is famous for one other thing"*
and the load-bearing claim (the first printed Yorkshire pudding) arrives about
4 s in, at the very edge of the head budget.

### S1 cold-open — ten anchors fire the lexical test, six unrescued

Ten of the 36 `start_anchor`s open on a word in §7's enumerated
connective/pronoun list. **Four** are rescued by the rule's own escape clause (a
proper noun inside the first 12 words): ORI-2 (*"But was **Richard**…"*), ARG-4
and ARG-5 (both name **Al** in word 2), and ARG-8 (*"…some **Australian**
lamb…"*). **Six fire unrescued** and would carry `cold_open_ok: true` if the
schema had the field:

| Segment | Opens on | First 12 words |
|---|---|---|
| MOSS-1 | *and* | "and see where we go so I'll start with I mean you can really" |
| MOSS-2 | *that's* | "that's actually a fairly recent thing um when I first started writing about" |
| JERK-1 | *and* | "And it sounds to me like maybe there's a little bit of confusion" |
| JERK-2 | *so* | "So the claim is, and I do sometimes have a hard time pronouncing" |
| ARG-7 | *because* | "because that is a long hard cook. Yes, it is. And again, that I" |
| TRA-1 | *yeah* | "Yeah, I'll forget some of the years all this happened" |

Two of the six are self-inflicted: **ARG-4 and ARG-5 only started tripping the
test because their boundaries were moved** to fix the clipped-word defect above,
and both landed on a clean sentence that happens to begin with *And* or *So*.
That is the trade in miniature — S0 wants a throwaway run-up, and a throwaway
run-up in spoken English usually starts with a connective. All six are
deliberate: in every case the alternative start was the money sentence itself.
S1 is flag-only, so none blocks the merge — but **six flags on 36 segments says
S0 and S1 pull against each other more often than §7 expects**, which is worth
knowing before anyone turns S1 into a gate.

### S2 clean-out — evaluable on six of nine episodes, and it passes on all six

The mechanical test (does `end_anchor` land on a sentence terminal in the
transcript?) needs a punctuated transcript, and `base.en` **did not produce one
for three of the nine episodes**:

| Episode | Words | Sentence-enders | One per |
|---|---|---|---|
| `bfh-18c-tavern-briggs` | 8,428 | 63 | 134 words |
| `bbqc-traeger-history` | 9,273 | 118 | 79 words |
| `bbqc-moss-school` | 10,302 | 116 | 89 words |
| the other six | 3,391–8,631 | 212–501 | 13–17 words |

On the six punctuated episodes **all 14 new `end_anchor`s land on a terminal**
(`.` or `?`), including the two that were re-cut during the review to stop
severing a speaker's trailing *"right?"* (ARG-2 and ARG-6). On the three
unpunctuated episodes the test returns "not a terminal" for every segment
including ones that plainly do end a sentence, so it is reported as
**unevaluable** rather than as nine failures. Judged by ear from the transcript
text, all nine land on a completed thought; MOSS-3 and MOSS-4 were both extended
during the review to stop mid-sentence.

### M1/M2 same-episode gaps

**No pair anywhere in the pool is inside the 45 s must-merge window**; the
tightest is 49.1 s (TRA-3 → TRA-4). **Eighteen pairs fall in the 45–180 s
"should merge" band** — fourteen from this batch, four inherited from batch 1 —
and all are kept separate with a reason. `merge-segments.mjs` does not persist
`keep_separate_reason`, so this table is the record.

| Pair | Gap | Why not merged |
|---|---|---|
| ORI-1 → ORI-2 | 147.9 s | The elision is Wrangham's Gombe chimp-diet anecdote — a story about him, not part of the argument. Merging lands at 481 s, past the hard maximum. |
| ORI-2 → ORI-3 | 49.1 s | The elision is an aside about sleeping on the ground away from predators. Merging lands at 316 s, past 20 % of a 25-minute episode. |
| TAV-3 → TAV-4 | 65.9 s | The elision is a digression about words painted in the bottom of museum dishes, and antique-shop talk. |
| MOSS-1 → MOSS-2 | 55.2 s | The elision is a list of 19th-century regional imports (tamales into Mississippi, chilli powder into Texas) that restates MOSS-1's melting-pot point. |
| MOSS-2 → MOSS-3 | 64.6 s | The elision dates the first permanent barbecue restaurants — a different question from the westward-and-back route, and the town names are badly transcribed. |
| JERK-1 → JERK-2 | 50.7 s | The elision is the four-item jerk-spice list and the host's question about the Taínos. Merging lands at 373 s, past 20 % of a 24-minute episode. |
| ARG-1 → ARG-2 | 157.2 s | The elision is the guest's personal biography — meeting his Texan wife, moving between Texas and Argentina. |
| ARG-2 → ARG-3 | 98.4 s | The elision is a mid-show break, station identification and the hosts' recap. |
| ARG-3 → ARG-4 | 105.0 s | The elision is the hosts working the hand test through a second time and comparing it with a kettle grill. |
| ARG-4 → ARG-5 | 54.7 s | The elision is the Spanish name of the Argentine charcoal wood, which the transcript mangles into *"Cabracho Blanco"*, plus host banter. |
| ARG-5 → ARG-6 | 97.4 s | The elision is a sponsor read, a station break and empanada talk. |
| ARG-6 → ARG-7 | 126.8 s | The elision is more empanada talk, including a competition win. |
| ARG-7 → ARG-8 | 176.5 s | The elision is the chimichurri discussion, which turns into a pitch for the guest's own seasoning product. |
| TRA-3 → TRA-4 | 49.1 s | **The one boundary chosen around a word rather than a topic.** The elision contains an unbleeped expletive and a straight product endorsement. Merging them would produce a well-shaped 167 s charcoal segment — and would put the expletive in the Foray. |
| GRID-1 → GRID-2 | 102.8 s | Batch 1: the other guest answering a different question, about Welsh identity. |
| GRID-4 → GRID-5 | 138.5 s | Batch 1: a book recommendation plus Welsh bakes the ASR renders too poorly to cut. |
| MED-1 → MED-2 | 168.0 s | Batch 1: a digression about gemellions and inherited spoons — objects, not the table. |
| MED-3 → MED-4 | 103.4 s | Batch 1: an under-transcribed stretch plus an aside about film knives. |

Every pair is in chronological order within its episode (M3), both as stored and
as played.

---

## 5. The global cut-frequency rules — checked against the assembled sequence

These are the tier-A rules from `segment-length-rules.md` §9. They are properties
of *this ordering*, not of the pool. **They are now machine-checked** — the
running order lives in `data/forays.json` and `tools/foray/check-forays.mjs`
evaluates D1, D2, D3, D4, D5, M3 and M4 against it on every CI run (#182 closed).
Every number in the table below was reproduced by that checker; where the
checker and this prose disagreed, the disagreement is named rather than
smoothed over (see D1 below). The Foray is 61:13, which puts it in the
**45–120 minute band, so N = 6** starts per rolling 600 s.

| Rule | Requirement | Measured | Verdict |
|---|---|---|---|
| **D1** | ≤ 6 segment starts per rolling 600 s | **6** — the budget is exactly met, with the tightest run of six spanning **620.5 s** and no run under 600 s | **pass** |
| D2 | ≤ 2 consecutive segments < 60 s; the next ≥ 150 s | only one segment in the Foray is under 60 s at all | pass |
| D3 | mean segment duration ≥ 90 s | **114.8 s** | pass |
| D4 | ≤ 20 % of segments are `quote`; ≤ 2 adjacent | 1 / 32 = **3.1 %** | pass |
| **D5** | no 3 consecutive durations within ±20 % | **0 violations** on the pairwise reading, **3** on a stricter reading of the same sentence — see below | pass / partial |
| D5 | whole-Foray IQR ≥ 45 s | **57.8 s** (R-7 / Tukey; 62.3 s exclusive) | pass |
| M3 | same-episode segments never out of chronological order | true for all nine `item_id`s | pass |
| M4 | ≤ 25 % of segments **and** runtime from one `item_id` | worst is `bbqrn-argentina-open-fire` at **21.9 % of segments, 21.1 % of runtime** | pass |
| L7 | payback: `duration ≥ 4 × (bridge + 1) + 4` | the shortest segment is 51.2 s, which permits a bridge up to 10.8 s, above the spec's 8 s cap, so **every segment satisfies L7 whatever the bridges say** | pass by construction |
| X1/X2/M5/M6 | seam marking and attribution | no bridge records exist yet | deferred |

**One correction from the checker: "the tightest run of six spanning 620.5 s"
counts gaps, not starts.** 620.5 s is `start[i] → start[i+6]`, which bounds
*seven* starts. The rule's own text is about starts inside a window, and by that
count the committed order's worst window holds **6**, exactly the budget. The
verdict is unchanged; the phrasing was one off, and
`tools/foray/check-forays.test.mjs` now pins both numbers so they cannot drift
apart again.

### D1 passes, and here is what it cost

The first assembly of this Foray **failed D1**: 35 segments over 63:59, with
eight runs of six consecutive segments spanning less than 600 s of tape, the
worst at 529.4 s. That is the rule that maps directly onto the founder's opening
complaint — *"if it jumps around repeatedly that's super annoying"* — so shipping
it as a documented failure would have shipped the specific defect the rules exist
to prevent. It was fixed rather than reported.

**Three segments were dropped from the running order** (they stay in the pool):

| Dropped | Dur | Why it was the weakest available |
|---|---|---|
| **TRA-4** | 50.3 s | The shortest segment in the Foray, and the second of two consecutive charcoal segments. TRA-3 already carries the argument (boutique charcoals lost on distribution, not on quality); TRA-4 adds the market-share figure and a paragraph of personal preference. |
| **ARG-8** | 58.6 s | Patagonian lamb — pure colour, from the source that was already the most over-represented in the Foray. Dropping it also pulls Argentina from 22.9 % of segments down to 21.9 %. |
| **GRID-3** | 57.1 s | Reading a bakestone's heat. Good craft, but it is technique rather than history, and the slot still carries GRID-1, GRID-2 and GRID-4 on bakestones. |

**What was tested before choosing those three.** Reordering alone cannot fix D1:
a search over 250,000 legal interleavings of the full 35 tops out at a tightest
run of 580.9 s. Dropping *one* segment does not fix it either, and neither does
dropping *two* — under an ordering that keeps the arc slots intact and the
Jamaica and Argentina blocks contiguous, **three is the minimum**, and there are
six three-segment sets that work. TRA-4 + ARG-8 + GRID-3 was picked over the
cheapest passing set (TRA-4 + ARG-8 + TAV-2, 6 s less runtime lost) because
TAV-2 is the only segment in the pre-modern slot that describes food cooking *in
front of a fire*, and the slot cannot spare it.

The trade: **2 min 46 s of runtime for the whole cut budget.** 61:13 that never
jumps beats 63:59 that jumps eight times.

Two segments that were considered for dropping and kept: **TAV-2** (above) and
**TRA-3**, whose distribution argument is the only explanation in the Foray of
why the charcoal market looks the way it does.

### D5's verdict still depends on how you read "within ±20 % of each other"

Two readings are available and the rule text does not choose:

- **Pairwise / max-over-min** (what is implemented): a triple violates if
  `max/min ≤ 1.2`. **No triple in this ordering violates**, and the tightest is
  **MOSS-2/MOSS-3/SM-1 at 1.2945 (+29.5 %)** — corrected 2026-08-16, having
  previously named ARG-5/ARG-6/ARG-7, which is 1.3204 (+32.0 %) and therefore
  *further* from violating, not closer. `check-forays.test.mjs` now pins the
  tightest triple so the prose cannot drift again.
- **Deviation from the triple's mean**: a triple violates if all three sit within
  ±20 % of their own mean. **Three triples violate**: MOSS-2/MOSS-3/SM-1
  (97.9/126.7/101.8, worst deviation 16.5 %), ARG-1/ARG-2/ARG-3
  (148.5/100.9/127.7, worst 19.7 %) and ARG-5/ARG-6/ARG-7 (126.8/96.1/96.6,
  worst 19.1 %).

This is the same class of ambiguity batch 1 reported for the IQR's quartile
definition, and it is reported the same way rather than resolved in our favour.

**The gate now picks one: pairwise.** "Within ±20 % of *each other*" is a
statement about the members of the triple, and the mean is a fourth quantity the
rule never mentions — reading it in makes the rule strictly stronger than its
own words. It is also the reading that serves the rule's purpose, since
97.9 / 126.7 / 101.8 s is not a metronomic run. `check-forays.mjs` still
computes the mean-deviation reading and prints the three triples below as
warnings, so nothing here is quietly resolved away; it just does not block a
merge. Full argument in `tools/foray/README.md`. Likewise the IQR is fixed at
**R-7** (NumPy's, R's and Excel `QUARTILE.INC`'s default), because that is the
definition anyone recomputing the number would reach for by accident.

**One of the four it was originally four, and the reordering that fixed D1 also
fixed the only one that was genuinely breakable.** ORI-3/GRID-1/MED-1 violated
the mean-deviation reading in the first assembly, and it spanned three episodes
and two arc slots, so nothing forced it — the search that fixed D1 dissolved it
as a side effect. The three that remain are all constrained:

- **ARG-1/ARG-2/ARG-3** and **ARG-5/ARG-6/ARG-7** are inside one episode, whose
  internal order M3 fixes as an integrity rule. Breaking them would mean
  interleaving Jamaica or Britain into the middle of the Argentina block, which
  buys a rule and loses the arc.
- **MOSS-2/MOSS-3/SM-1** can only be broken by moving MOSS-4 out of the world
  slot and into the American one. That ordering was tested and does reduce the
  count to two — at the cost of playing *"Britain is fifty years behind us"*
  before Santa Maria, which reads as the arc going abroad and then coming home
  again. The rule was not worth the sequence.

**A finding about the rules rather than about this Foray.** D1 and D5 pull against
each other whenever a Foray's mean segment length sits near its budget's implied
gap. N = 6 implies a mean gap of 100 s; the first assembly's mean was 109.7 s —
9.7 % of headroom — while D5 *requires* more than 20 % local variation, so no
ordering could keep every local window near the mean. Dropping three segments
lifted the mean to 114.8 s and bought 14.8 % of headroom, which is what made both
satisfiable at once. **That is the real lesson: the cut budget is a constraint on
how many segments a Foray may contain, not on how they are arranged.** A pool
whose mean is under ~110 s cannot fill a 60-minute Foray without either breaking
D1 or going uniform.

*(The ordering searches were throwaway scripts in the working directory, not
committed — the same call batch 1 made for its own sampling script. Parameters:
up to 600,000 uniform random interleavings of the per-episode chains within each
arc slot, scored on the minimum span of any six consecutive segments, rejecting
any candidate that violates D2, D4 or D5's pairwise reading.)*

---

## 6. What was rejected

### One whole episode

**`m-heritage-food-stories-how-japanese-colonizat.asr.json` — dropped
entirely (15.8 min).** *"How Japanese Colonization Tried to Erase Korean Food"*
was queued for the Korean-barbecue slot. Read in full: it is a well-made
narrated history of the 1910–1945 occupation — the annexation date, the March
1st Movement, the language ban, Sōshi-kaimei, 75,000 artefacts, the comfort
women — and **it contains no history of Korean grilling at all**. Searching the
whole 945.7 s episode for *grill*, *barbecue*, *bbq*, *charcoal*, *roast* and
*smoke* returns exactly two cues, at 12:40: *"Korean barbecue has become a global
social experience. The communal grill at the center of the table is a whole
vibe."* No origin, no mechanism, no date. There is nothing here to cut for a
Foray about fire, and cutting the colonial history into a grilling Foray would be
the wrong use of it. **The Korean slot is empty and stays empty.** The episode is
a strong candidate for a Foray about food and identity.

### Half an episode — excluded as briefed, and the drift starts earlier than briefed

`m-origin-stories-episode-09` is one of the nine episodes used, but only its
first two-thirds. Its "Being Human" bonus segment is a different speaker (a
clinical herbalist) on modern diet advice, IBS, blood sugar and the standard
American diet. **It begins at 17:18 (1,038 s), not at the 22-minute mark.** The
tail of that episode runs: credits 984–1,015 s, Being Human Initiative billboard
1,016–1,038 s, the bonus interview 1,044–~1,450 s, then the Leakey Foundation
donation appeal and a transcription-service credit ~1,450–1,523 s. Nothing past
1,010 s was considered. Worth recording precisely so the next session does not
re-derive it.

### Sponsor reads and housekeeping — never a boundary

Product principle #3 and the #64 ruling both say a boundary is chosen
editorially and that ads falling outside it stay incidental. These were excluded
before authoring, not cut around:

- **BFH tavern**: Netherton Foundry read 0–59 s; postbag appeal, social handles,
  subscriber tiers and Easter-egg plugs 100–228 s; events plugs and sign-off
  2,414–2,557 s.
- **BBQ Central / Moss** (62 min episode, ~24 min of it): Winners Products
  676–788 s, Cookin Pellet 820–875 s, Pits & Spits ~2,180–2,265 s, Fireboard 2
  ~2,300–2,330 s, Primo Grill 3,499–3,611 s; plus show rundown 95–342 s,
  Pitmaster Club membership pitch 985–1,187 s, a Cooking Guild knife segment
  1,187–1,385 s, and closing housekeeping 3,640–3,705 s.
- **BBQ Central / Traeger**: Primo 737–868 s, Fireboard 868–923 s, Big Poppa
  Smokers 2,689–2,780 s, Pit Barrel 2,808–2,836 s, McCallop Cigars 3,586–3,614 s.
- **BBQ Radio Network / Argentina**: Holstein Manufacturing 625–634 s and
  ~1,761–1,788 s, network opens and closes.
- **BBQ Radio Network / Santa Maria**: The Brand Influencers ~654–684 s and
  ~1,899–1,940 s, Center for Communication and Development ~1,263–1,302 s.

### On-topic passages rejected on quality

- **Wrangham's Gombe chimp-diet story** (Origin Stories 300–447 s). Vivid — he
  ate leaves, stems and the occasional monkey, and Jane Goodall made him keep a
  loincloth — and it does establish that a human cannot fill their stomach on
  chimp food. Dropped because it is a story about the researcher rather than a
  step in the argument, and because taking it would have forced a 300 s segment
  that pushed past the 20 % cap on a 25-minute episode.
- **Almost the entire Santa Maria episode.** The nickname's origin (90–118 s),
  27 years in the army and what it taught him about himself (710–870 s), cooking
  for friends and turning brisket into hockey pucks (873–950 s), Florida weather
  (1,067–1,124 s), the koi-pond business in detail (~1,302–1,430 s), the "grease
  fire" quickfire round (1,966–2,483 s: favourite wood, sauce on the side, three
  best sides, best grill to buy). Some of it is charming. None of it teaches
  anything about grilling, and two stretches are about ponds.
- **The Traeger stock story** (1,233–1,594 s). A clear explanation of what a
  1-for-50 reverse split is and why an exchange forces one, plus go-private
  speculation about Weber. It teaches — but it teaches corporate finance, it will
  be stale in a quarter, and the transcript contradicts itself on whether the
  notice came from the exchange (1,267 s) or the SEC (1,283 s). Wrong Foray.
- **The MEATER acquisition** (2,092–2,212 s). Wireless thermometers
  commoditised, and Traeger's own website now sells nothing at all — no rubs, no
  pellets — pushing buyers to Home Depot. Genuinely interesting retail news,
  contiguous with TRA-2 so it could only enter as a merge, and too of-the-moment
  for a history.
- **Reusing snuffed charcoal** (Traeger from ~2,508 s, immediately after TRA-4
  ends). A real technique — collect the snuffed coals in a chimney, light them
  there, sprinkle over unlit fuel — sitting inside chatty back-and-forth.
- **Pit Barrel lamb technique** (Traeger 3,196–3,273 s). Real method, but Pit
  Barrel is a paid sponsor in the same episode and the passage reads as
  endorsement.
- **Pork at 145 °F and the death of trichinosis** (Traeger 3,061–3,170 s).
  Strong teaching about a genuine shift in home cooking, and squarely the wrong
  slot. Held for a food-safety Foray.
- **The Adam Perry Lang / Epstein-files segment** (Traeger 3,273–3,561 s).
  Unverified allegations about a named living person, relayed second-hand, with
  the host's own framing contradicting itself. Not used in any slot, and it
  should not be.
- **Meathead on flat-top griddles and cast iron** (Moss 1,385–2,100 s). Twelve
  minutes of it. Two passages nearly made the cut — a wok on a half-full charcoal
  chimney runs as hot as a Chinese restaurant range (~1,501 s), and grill marks
  *are* the Maillard reaction, so the pale stripes between them carry no browning
  and no flavour (1,881–1,948 s). **The second was authored and merged, and is
  one of the four pool segments held out of the running order** — see §7. The
  rest is opinion about cleaning.
- **Moss on London and Amsterdam** (3,095–3,436 s). Big Green Eggs embedded in
  the picnic tables at Jimmy's Barbecue Club on the South Bank (~3,159–3,199 s);
  Rules, *"founded in 1798 as an oyster bar"* (~3,223 s); burger shops
  everywhere. Travel colour. MOSS-4 was kept from this stretch because it makes
  an argument; the rest does not.
- **The Argentina hosts' own trip report** (108–232 s). It states the distinction
  well — they cook on wood embers, not smoke, and use radiant heat — but the
  guest states it better and first-hand in ARG-2, and the middle 40 s is
  reminiscence about a goat at a charity cook. The one fact lost sits just
  outside it, at 239 s: Argentina has more cattle than people.
- **The braising listener question** (Argentina 309–561 s) and **the chimichurri
  recipe** (2,146–2,206 s). The first is off-topic; the second is half a product
  pitch for the guest's own dry mix.
- **Jerk's appropriation debate** (Moreish 640–1,445 s). Thoughtful, and about
  who may sell jerk rather than about how jerk is cooked.
- **The tavern as a Michelin-starred dining club** (BFH tavern 644–790 s). The
  Globe on Fleet Street, divided into little rooms with the kitchens below, the
  Wednesday Club with Dr Johnson, Wilkes and Oliver Goldsmith, and the Globe kept
  on a watch list by the Lord Mayor's office because of who drank there. **The
  closest call in the batch.** It is excellent and it is about dining rather than
  about fire, and the slot was already the fattest in the Foray. Held for a Foray
  about eating out.
- **The Goldsmith chops prank** (BFH tavern 2,092–2,196 s) and **Briggs's
  frontispiece** (423–508 s), same reason: good, and about publishing and
  practical jokes rather than about cooking on fire.

---

## 7. Four segments in the pool and not in the Foray

`data/segments.json` holds 36 segments; the running order uses 32. All four
held-back segments are valid, merged records that a future Foray can use — the
pool is a pool, not a playlist.

| Held back | Dur | Why |
|---|---|---|
| **TRA-4** `bbqc-traeger-history#2457` | 50.3 s | Dropped to bring D1 under budget (§5). Kingsford's ~80 % share and Clorox ownership; the argument it completes is already carried by TRA-3. |
| **ARG-8** `bbqrn-argentina-open-fire#2292` | 58.6 s | Dropped to bring D1 under budget (§5), and it relieves the M4 concentration on the Argentina episode. |
| **GRID-3** `bfh-griddle-bakestone#1360` | 57.1 s | Dropped to bring D1 under budget (§5). Technique rather than history, from the best-represented episode in the slot. |
| **MOSS-G** `bbqc-moss-school#1881` | 67.0 s | Held out for a different reason — see below. |

### Why MOSS-G is a rule problem rather than a pacing one

MOSS-G is Meathead on grill marks being the Maillard reaction, and it is the
single clearest mechanism about grilling in 6 h 38 m of tape. It is held out
for two reasons.

1. **M3.** It sits at 1,881 s of an episode whose other four segments start at
   2,572, 2,779, 2,941 and 3,315 s. Its natural home is the modern-backyard slot
   at the end of the Foray, which would play it after MOSS-1 to MOSS-4 —
   non-chronological within one `item_id`, which M3 treats as an integrity fault
   rather than a taste one. The mitigating fact is that MOSS-G is a *different
   speaker* from MOSS-1–4 (Meathead, not Robert Moss), so the specific harm M3
   guards against — making a speaker appear to answer a question they were never
   asked — does not arise. The rule as written is mechanical on `item_id`, so a
   checker would flag it, and this is recorded as a flag rather than argued away.
2. It is technique, not history, and this Foray is a history.

It stays in the pool because a future Foray about how grilling actually works
should start there. **Its topic is `food/cooking-science`, which is where it
belongs and where nothing else in this Foray needed to go.**

---

## 8. Topic ids — five nodes, and the batch-1 nine re-topiced in the same pass

PR #175 merged while this batch was being authored (commit `57ef4f2`), so
`data/taxonomy.json` now carries the real food branch and nothing has to pile
onto the root `food` any more. This branch was rebased onto it and every segment
carries the most specific node that fits what it actually teaches:

| Topic | Segments | Which, and why |
|---|---|---|
| `food/grilling-bbq` | **15** | TAV-4 (the word *broiling*), MOSS-1–4, SM-1, JERK-1 (pit, wood ash, pimento smoke), ARG-2/3/4/7 (grill types, the hand test, wood choice, brisket over fire), TRA-1–4. **Everything whose subject is barbecue or the open fire itself** — which deliberately spans practice (the hand test), history (Virginia to Weber kettles) and the trade (the pellet boom), because the taxonomy has no food-business node and splitting barbecue history away from barbecue would make the subject unsearchable. |
| `food/food-history` | **13** | ORI-1/3, GRID-1/2/5, MED-1–4, TAV-1/2/3, JERK-2. Claims about how people cooked and ate in the past. |
| `food/cuisines` | **4** | ARG-1 (asado as a way of living), ARG-5 (achuras), ARG-6 (Italian Argentina, chorizo), ARG-8 (Patagonian lamb). A cuisine's own tradition rather than a fire technique. |
| `food/cooking-science` | **2** | MOSS-G (grill marks are the Maillard reaction) and ORI-2, whose back half is digestion physiology — *"increase the proportion of the nutrient that actually gets digested in the small intestine… demands less of the body"* — the same class of claim. |
| `food/baking` | **2** | GRID-3 (getting a bakestone to temperature) and GRID-4 (what a Welsh cake is). Both are about baking on the stone rather than about the hearth's history. |

**The nine batch-1 segments were re-topiced in the same pass**, off the root
`food` and onto `food/food-history` (seven) and `food/baking` (two). It was done
by reconstructing that batch's results file from the committed records and
re-running `merge-segments.mjs` under its **original** `batch_id`
(`seg-2026-08-16-bfh-hearth-a`), so their provenance is unchanged and the only
field that moved is `topic` — verified field by field against
`origin/main`'s copy. Re-running it also re-validated all 18 of their anchors
against the transcripts, and none was rejected. `docs/curation/grilling-foray-batch-1.md`
§5 asked for exactly this and can now be read as closed.

Nodes considered and refused, plus two inconsistencies worth naming rather than
papering over:

- `food/restaurants-chefs` fits the tavern material that was *rejected* (§6's
  dining-club passage), not what was kept.
- `food/cooking-science` was refused for TAV-3, where the sand-tempered Buckley
  dish is genuinely a materials mechanism, because the segment is about an
  18th-century vessel and belongs with the foodways it comes from.
- **TAV-4 and JERK-2 are both etymologies and they land on different nodes.**
  *Broiling* → `food/grilling-bbq`, *barbacoa* → `food/food-history`. The split
  is defensible — TAV-4's payload is what the word means for cooking over bars
  today, JERK-2's is who reached Jamaica first — but it is a judgement, not a
  rule, and a future re-topic may want them together.
- **Argentina's tradition claims go to `food/cuisines` and Jamaica's equivalents
  do not.** ARG-1 and ARG-5 describe what an asado *is* socially; JERK-1 and
  JERK-2 describe how jerk is cooked and where it came from, which is why they
  sit on grilling-bbq and food-history. The asymmetry reflects what the two
  episodes actually say rather than a decision about the two cuisines.

## 9. Honest limits

- **`base.en` mangles proper nouns throughout, and in one place it inverts a
  meaning.** *Wonderwerk Cave* becomes "Vondervark", *Maillard* becomes "my
  hard", *quebracho blanco* becomes "Cabracho Blanco", *picanha* becomes
  "Pecania", *MEATER* becomes "meter", *Middleby* becomes "Middle B", *Lockhart*
  becomes "lok art". Inside TRA-1 at 1,212 s the transcript reads *"Has improved
  out to be true"* where the speaker certainly said *"hasn't proved out to be
  true"* — **the audio is right and the caption is backwards.** None of these
  are anchors, and anchors are verbatim against *our* transcript, which is what
  A13 would re-resolve against, so nothing breaks today. It does mean an anchor
  here would not match a publisher transcript if one ever appeared, and it is an
  argument for re-transcribing on a larger model before this pool carries more
  weight. The same model also produced three near-unpunctuated transcripts,
  which is what makes S2 unevaluable on a third of the episodes (§4).
- **`bbqrn-argentina-open-fire` is 21.9 % of the Foray's segments and 21.1 % of
  its runtime** — seven of the eight segments merged from it, after ARG-8 was
  held back. M4's cap is 25 %, so it passes with room, but seven segments from one
  hour-long radio interview is still more than any single source should carry. It
  happened because that episode is the only one in the batch where a practitioner
  explains mechanisms end to end.
- **Slot 5 is called "world traditions" and holds two traditions.** Jamaica and
  Argentina, plus one segment about Britain reading American barbecue books.
  Braai, tandoor, mangal, lechon, satay, yakitori and Korean barbecue have no
  segment, and slot 5 lost its shortest segment to the cut budget (§5). `docs/curation/catalogue-broadening.md` §4 already establishes that
  four of those have no usable source at any transcription budget; Korean had one
  and it turned out not to be about food-on-fire.
- **The role field is still lost at merge**, so `data/segments.json` alone
  cannot answer L2/L3/D4. It is now carried on each `data/forays.json` item as
  an interim home and checked there, which covers the 32 segments in this Foray
  but not the four held back in §7 — and it means a second Foray reusing a
  segment has to restate the role. The real fix is the additive `role` field
  §9 of the length rules proposes; `check-forays.mjs` already prefers the
  segment's own value and errors if the two disagree, so that day is a deletion.
- **`data/segments.json`'s `notes` field still names only batch 1.** The merge
  script rewrites `built_at` and the whole `provenance` block on every write —
  `provenance.last_batch_id` is now `seg-2026-08-16-grilling-foray-b` — but it
  carries `notes` through untouched and has no flag to update it, and the file
  must not be hand-edited. The note says the file was *first* populated by the
  hearth batch, which remains true, and now under-describes what follows.
- ~~**The running order exists only in this document.**~~ **Fixed (#182).** The
  order is now `data/forays.json` → `forays[0].items`, an ordered list of
  `segment_id`s carrying the `ORI-1` / `GRID-3` labels §2 uses, so the mapping
  between this document and the pool no longer has to be re-derived. D1, D2, D3,
  D4, D5, M3 and M4 are checked by `tools/foray/check-forays.mjs` on every CI
  run, and `tools/foray/check-forays.test.mjs` proves each one goes red by
  breaking it. The nine source episodes are registered in
  `data/segment-sources.json`, so a segment's timestamps now resolve to audio.
  **What is still not machine-checked:** L7, M5, M6, X1 and X2, all of which
  need bridge records that do not exist yet, and the per-segment S0/S1/S2
  judgements, which were never mechanical.
- **Nothing here has been heard.** Every number in this document is a property of
  timestamps and transcripts. The first person to listen to this end to end will
  find things no rule caught — and per `segment-length-rules.md` §10, that
  listening is the experiment that should move these numbers.

---

## 10. Reproducing this

The batch and results files are deliberately **not committed**: the batch input
embeds the full transcript body, and this repo does not host source prose (see
`docs/DECISIONS.md`). Both are regenerable from the ASR JSON.

```
# 1. the batch-1 re-topic, under its own original batch_id
node tools/segments/merge-segments.mjs --batch <legacy-batch.json> --results <legacy-results.json>
# 2. this batch
node tools/segments/merge-segments.mjs --batch <batch.json> --results <results.json>
node tools/segments/merge-segments.mjs --check
```

Order matters only for `provenance.last_batch_id`, which should end up naming
this batch.

Re-running the same batch against the merged file writes nothing
("no change — segments file left untouched"), which is the idempotence property
`merge-segments.mjs` promises; it was verified for this batch.
