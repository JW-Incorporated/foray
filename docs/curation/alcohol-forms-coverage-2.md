# Coverage re-score after the catalogue action — `alcohol-forms-1` (#279)

`alcohol-forms-coverage.md` (#278) scored the alcohol spine's 63 beats at
**1 strong / 15 thin / 47 empty** and closed with a recommendation rather than a
purchase: its §11.1 said the Foray is *"a curation problem before it is a sourcing
problem"* and named ten drinks shows sitting uncurated in
`data/catalog-breadth.json`. This document is what happened when seven of them were
curated. **It reuses #278's gate verbatim — §1a of that document, restated in §2
below — and does not invent a second methodology.** #278's counts stay as they are;
they are the *before*, and a re-score is only meaningful against an unedited baseline.

**Status:** measurement. Nothing is cut, nothing is transcribed, and
`data/forays.json`, `data/segments.json` and `data/segment-sources.json` are
untouched. Eleven publisher transcripts were fetched to a scratch directory outside
the repository and read; none is stored.

**Measured at `main` = `81f7179`**, against `data/discover.json` at 1,651 items after
this change (1,623 before) and `data/catalog.json` at 220 shows (213 before).

> **Re-measured twice, after two rebases.** This pass was originally taken at
> `main` = `6d163c5` with `data/discover.json` at 1,564 items. Nightly refreshes #284,
> #291 and the #290 recovery in #293 have since added 89 episodes, so every figure below
> that is a function of the whole pool — the bundle sizes in §6 and both halves of the
> tag-DF check in §7 — was re-run against `81f7179`. **The beat verdicts in §3 are not
> affected**: they are readings of specific passages in specific episodes, and no
> nightly touches those. Nor is §6's marginal cost, which is a per-show quantity.
> **What the re-runs did change is §7's multiplier count, three times, and §7(a) now
> says so instead of quoting one night's number as though it were a property of this
> change.**

---

## 0. The finding, stated first

> **Curation closed part of the gap and it closed it in the wrong act.** Seven
> drinks shows are now curated. Seven beats moved: one from empty to **strong**
> (beat 19, the post-fermentation decisions — the first strong beat this Foray has
> outside beer) and six from empty to thin. The counts go from
> **1 / 15 / 47** to **2 strong / 21 thin / 40 empty**.
>
> **Act I still has no strong tape.** It goes from 0/3/13 to 0/7/9 — better, and
> still a narration-led derivation from end to end. **Acts IV, V and VI did not
> move at all**, and the reason is not judgement, it is arithmetic: the three shows
> that would serve them — WhiskyCast, Bourbon Pursuit, Spirits & Distilling — publish
> **zero transcripts across 2,431 episodes between them**, so nothing in them is
> scoreable at beat level today at any price short of ASR.
>
> **Of 4,652 episodes across the seven new shows, 33 carry a transcript. That is
> 0.7 %, and 31 of the 33 belong to one show.**

So the honest answer to the question #279 was opened to settle — does curation close
the gap, or does narration have to — is **narration still has to, and curation bought a
foothold**. In wine and cider it bought real tape: one strong beat and several thin ones,
playable today. Whisky, the spirits fan, and the fortification chain are now *identified*
rather than *available*: the shows exist, the episodes are named, and every one of them
is an ASR purchase. **Seven beats of sixty-three moved and Act I still has no strong
tape**, so this does not change the product-mode question #287 measured and
`HUMAN-ACTIONS.md` #22 is waiting on — see §11.

---

## 1. What entered the catalogue

Seven shows, appended to `data/catalog.json`, every field verified fresh against
`https://itunes.apple.com/lookup` on 2026-08-19. **Nothing was removed to make room**
— per the standing rule, shows come in labelled and nothing already curated goes out.

| Show | id | Episodes | Apple genre | DAI | `taxonomy_node_ids` | #278's predicted beats |
|---|---|---|---|---|---|---|
| Basic Brewing Radio | 75092679 | 978 | Food | no | `food/fermentation`, `food/drinks` | 7, 26, 29, 30 |
| WhiskyCast | 93465727 | 1,176 | Food | no | `food/drinks` | — (not in §11's table) |
| I'll Drink to That! Wine Talk | 538210866 | 505 | Food | **yes** (art19) | `food/drinks` | 17, 18, 19, 21, 52, 54 |
| Inside Winemaking | 906249753 | 224 | Food | no | `food/drinks`, `food/fermentation` | 17, 18, 19 |
| Cider Chat | 1054230417 | 514 | Places & Travel | no | `food/fermentation`, `food/drinks` | **22** |
| Bourbon Pursuit | 975392298 | 1,207 | Food | **yes** (Megaphone) | `food/drinks` | 14, 37, 38, 39, 61, 62 |
| Spirits & Distilling Podcast | 1734460262 | 47 | Crafts | no | `food/drinks` | **11, 12, 13** |

`food/drinks` had **zero** items in `data/discover.json` before this change. It is now
the spine node for all seven shows, which is also why the bundle cost came in on
projection — see §6.

### 1a. The ambiguous show, resolved by hand

#278 named *"Spirits & Distilling"*. The string `spirits|distill` matches **five** rows
in the breadth catalogue and **four of them are the wrong sense of the word**:

| breadth row | id | genre | verdict |
|---|---|---|---|
| Animal Spirits Podcast | 1310192007 | Investing | **no** — finance |
| The Lord of Spirits | 1531206254 | Christianity | **no** — demonology |
| HEY SPIRITS | 1674466647 | Soccer | **no** — a team nickname |
| Spirits Beside Us | 1738328573 | Spirituality | **no** — the paranormal |
| **Spirits & Distilling Podcast** | **1734460262** | **Crafts** | **this one** |

Four wrong senses out of five is a worse hit rate than `gin` or `ale` managed in
#278's §2b substring table, and it is the same failure class: a shipped substring
match would have curated a finance show into a drinks Foray. Resolved by reading
`apple_genre` and the feed, not by matching.

### 1b. Three of the seven were misclassified in `data/breadth-classification.json`, and two of those are somebody else's show

Recorded because it is a live data defect, not a footnote. The classification agent's
existing entries for these shows:

| Show | recorded `topics` | recorded blurb |
|---|---|---|
| I'll Drink to That! Wine Talk | `personal-journals`, `culture/performing-arts` | *"Short stories and personal essays on everyday life."* |
| Bourbon Pursuit | `health/mental` | *"Bedtime stories designed to become progressively boring and induce sleep."* |
| Cider Chat | `sports/endurance` at 0.90 confidence, ahead of `food/fermentation` at 0.85 | (blurb is correct) |

The first two are not wrong labels on the right show — they are **another show's
classification wearing this show's title**, both at `"confidence": "high"` and
`"needs_review": false`. None of the three was reused here; all seven shows were
labelled by hand from their own feeds. **The classifications themselves are left
untouched** — rewriting them is `tools/classify/`'s job and a different change — but
any pass that reasons about the drinks holding from `breadth-classification.json`
will be reading two sleep-podcast rows and an endurance-sports row.

---

## 2. The gate, and the one measurement that decides everything below

The gate is #278 §1a's, unchanged. A beat is **strong** only where all four hold:

1. the passage was **read** in a transcript, not inferred from a title, hook or tag;
2. the speaker has **sourced expertise** in the thing being claimed;
3. the passage advances the **beat's claim**, not one clause of it;
4. it is **cuttable** inside the 75–180 s band without double-booking a passage another
   beat is already using.

**Thin** is a narration beat with a partial supporting cut. **Empty is a result.**

Test 1 is what caps this pass, and it is worth stating as bluntly as #278 stated its
own cap. **A show cannot be scored at beat level because it is curated. It can be
scored because somebody can read it.** So the first thing measured after the seven
shows landed was transcript availability, using the shipped sweep
(`tools/segments/sweep-transcripts.mjs --all-episodes`) rather than a new script:

| Show | Episodes | With transcript | Timed | Formats | DAI |
|---|---|---|---|---|---|
| **Cider Chat** | 514 | **31** | **31** | 26 vtt, 5 srt | no |
| **Inside Winemaking** | 224 | **2** | **2** | 1 vtt, 1 srt | no |
| Basic Brewing Radio | 978 | 0 | 0 | — | no |
| WhiskyCast | 1,178 | 0 | 0 | — | no |
| I'll Drink to That! Wine Talk | 505 | 0 | 0 | — | yes |
| Bourbon Pursuit | 1,206 | 0 | 0 | — | yes |
| Spirits & Distilling Podcast | 47 | 0 | 0 | — | no |
| **total** | **4,652** | **33 (0.7 %)** | **33** | | |

**The episode counts in this table are RSS-measured and §1's are iTunes `trackCount`,
and the two disagree by a handful on two shows** (WhiskyCast 1,178 against 1,176;
Bourbon Pursuit 1,206 against 1,207). `data/catalog.json`'s own `notes` field claims
iTunes provenance for every `itunes_verified` row, so that is what §1 carries; the sweep
counts `<item>` elements in the feed, so that is what this table carries. Neither is
used for arithmetic beyond the totals, and stating both beats silently picking one.

Three things follow and they shape the whole re-score.

- **Five of the seven shows are unscoreable today.** Not weak, not off-subject —
  unreadable. 2,431 of those 4,652 episodes are whisky and spirits, which is precisely
  Acts IV and VI plus Act I's distillation beats 11–13.
- **One of Inside Winemaking's two transcripts is a stub.** `Inside_Winemaking_Tommaso_Martignon_Transcript.vtt`
  is 399 bytes: a single cue running `00:00:00.000 --> 99:59:59.999` carrying a header
  block, one line of the host's greeting, and then the literal line
  `[Transcript continues exactly as delivered in Step 1]`. It is a publishing artefact,
  not a transcript. So Inside Winemaking ships **one** readable episode, not two, and
  any future sweep that counts `episodes_with_timed_transcript` will keep reporting two.
- **Cider Chat is the first non-DAI drinks source ever to produce a SCOREABLE verdict
  here — not the first non-DAI drinks show in the catalogue.** The stronger claim was in
  an earlier draft of this document and it is false: `fermup`, `experimental-brewing`
  and `craft-beer-and-brewing-magazine-podcast` are all `dai: false` in
  `data/dai-classification.json` and were curated long before #279. What is true, and is
  the point, is that every one of the five sources that produced a verdict in #278 was
  DAI-suspected, which under `ADR-0008` made all sixteen of its spans
  authorable-and-unplayable. Cider Chat declares `delivery-edge.libsyn.com` and Inside
  Winemaking `content.libsyn.com`, both static. **Every span in this document is
  playable today**, which is the largest qualitative difference between this pass and
  #278.

**Eleven transcripts were read end to end** — nine Cider Chat, one Inside Winemaking,
plus the stub confirmed as a stub. Quotations are reproduced **as the transcripts hold
them, garbles included** ("Handin" for tannin, "maleic" for malic, "cleve" for cleave,
"glass cowboy" for glass carboy, "Sandy" for sanitiser); nothing is repaired, per
#278 §2a, because the quoted text is what an anchor check would have to match.

---

## 3. The beats that moved

Seven of sixty-three. Each verdict names its source, its band, and what is missing.

### Beat 19 — the decisions after the ferment — **empty → STRONG**

The one beat in this pass that clears all four tests, and the first strong beat this
Foray has outside beer. #278 recorded *"`malolactic` 0, `lees` 0 in the wine sense,
`sulphur`/`sulfur` 0 in the winemaking sense, `fining` 0, `filtration` 0"* and
predicted the beat would be over-supplied because the wine podcast world is large.
The wine podcast world was large and uncurated; it is now partly curated.

**Chosen:** `cider-chat` 495 (Cider Barrels Speak | Bâtonnage & Barrel Aging), band
**00:13:33.206 → 00:15:32.856 (119.7 s)**. In on *"And malolactic fermentation . Can we
the synopsis of malolactic fermentation"*; out on *"it can get a little too creamy."*

**Speaker.** The episode's own outro identifies the two voices: *"That was Cider Maker
Ryan Monkman, a field bird, cider and winemaker"* / *"Lee Baker, recorded in June of
2018"*. The barrel material is Lee Baker's, a working winemaker (Keint-He at recording,
Rose Hall Run Vineyard now) who elsewhere in the episode refers to *"at it back in my
university days"*. The transcript is **undiarized**, so attribution inside the cut is
by context — but test 2 passes on either speaker, because both are sourced producers
talking about their own cellar.

**Why it is strong rather than thin.** Beat 19's evidence spec asks for *"malolactic
conversion, the organism responsible, the diacetyl it produces and how it is encouraged
or blocked; lees contact and autolysis; ... blending as a deliberate compositional act
rather than a compromise"*, and flags as a strong signal *"a producer explaining a
decision they take against the default"*. The passage delivers the organism
(*"there's a bacteria strains that can"* / *"basically eat Malic acid and poop out
something called lactic acid"*), the correction that makes the beat worth its runtime
(*"And like say chardonnay, right?"* / *"It's not coming from the oak aging, which a lot
of people think it is."* / *"It's actually a byproduct of the malolactic fermentation."*),
and the cider-specific consequence (*"But with apples, because almost all the acid in
apples is malick."* / *"it can get a little too creamy."*). That is the beat's centre,
not one clause of it.

**Second segment, and it is the twelfth-of-twelve case §4a of the spine allows.**
Band **00:35:41 → 00:38:18 (157 s)**: blending as composition —
*"the purpose of the blending process of choosing which barrels"* / *"Is to figure out
who make the best dance partners"*, closing on lees autolysis with a timescale,
*"the autolysis really ramps up."* Two halves of one claim, the same reason beat 14
carries two.

**Three alternates, deliberately not counted toward runtime**, on #278 §9d's rule:
- 495 **00:18:39 → 00:20:17 (~98 s)** — blocking malolactic against the default with
  cold cellar, sulphur, pH and the primary yeast's own SO₂ output. This is the beat's
  "decision against the default" in its purest form and a reviewer may prefer it to
  the blending cut.
- `cider-chat` 489 **01:05:07 → 01:05:29** — Haritz Rodriguez with the numbers:
  *"maleic acid."* / *"Usually it's like 6.2 or six gram"* / *"per liter in the Basque
  apple juice"*, and *"the pH after the malolactic"* / *"fermentation rises from"* /
  *"3.3 to 3.7"*.
- `cider-chat` 497 **00:19:55 → 00:22:00 (~125 s)** — Ben Calvi, director of cider
  making, on sterile filtration *"down to 0.45 micron"*, DMDC, sorbate, and the flat
  myth-kill *"Sulfites are not a stabilizer, so they're"* / *"not gonna stop yeast
  fermentation"*, with Eleanor Leger's practitioner's reply that sterile filtration is
  *"theoretically"* / *"possible, but practically don't do it"*.

**What is still missing:** fining, and free-versus-bound SO₂ as such.

### Beat 4 — yeast as a domesticated organism — **empty → thin**

**Chosen:** `cider-chat` 497, band **00:28:48 → 00:30:05 (77 s)**. Eleanor Leger,
founder of Eden Specialty Ciders, on strain choice as a production decision with two
species named and a real commercial consequence: *"So I would say pick any saccharomyces"*
/ *"cerevisiae yeast, you'll be fine."* and *"Saccharomyces bayanus , stay away from"* /
*"it 'cause it's impossible to kill."* / *"It's like it'll come back."*

**Missing: the whole first half of the beat** — domestication, pure culture, Pasteur,
Hansen 1883, *pastorianus* as a hybrid. There is no genetics anywhere in the eleven
transcripts. This is strain **selection**, which is the beat's second clause.

### Beat 5 — the ABV ceiling — **empty → thin**

**Chosen:** `cider-chat` 497, band **00:30:06 → 00:31:26 (80 s)**, Eleanor Leger
enumerating the three routes to a stopped ferment — *"You can throw a ton of sulfites"*,
*"You can cross flow, filter"*, *"Or you can cold, which what"* / *"we do is just cold
crash the tank."* — with the temperature (*"Bring the temperature down to 27"* /
*"degrees Fahrenheit 30 around there."*) and the reason it holds (*"'cause it's high
alcohol."* / *"It's high sugar, still high acid."*).

**Second candidate, and it needs a bridge that says what it is:** the same episode's
freeze-concentration passage, **00:31:27 → 00:33:04 (97 s)**, is mechanism with numbers
— *"the advantage of outdoor natural cold weather"* / *"concentration is actually the
fluctuation."* … *"and it's that up"* / *"and down that helps separate out the"* /
*"super, all the sugars and the flavors."* **But ice cider concentrates the JUICE before
fermentation to raise sugar, not the finished drink to raise alcohol.** It is the same
physics at the opposite end from applejack and eisbock, and any assembly that lets the
tape imply otherwise would be getting the chemistry wrong in Act I, which is the one
place #278 says the Foray cannot afford it.

**Missing: the beat itself.** No ceiling stated as a number, no ethanol toxicity, no
enumeration of the four routes *above* the ceiling. This is the beat's *"Also strong"*
clause — the reverse case, a producer who wants the yeast to stop — and nothing else.

### Beat 10 — the flavour is in the by-products — **empty → thin**

**Chosen:** `cider-chat` 497, band **00:58:38 → 01:01:02 (144 s)**. Three production
heads — Tim Godfrey (Golden State Cider), Ben Calvi (Vermont Hard Cider), Eleanor Leger
— on temperature as the lever, quantitatively: *"Low and slow."*, *"We have a jacketed
tank, we usually"* / *"set a differential of two degrees."*, the thermal-gradient caveat
*"If you have a big boxy tank, that"* / *"means in the middle of that tank,"* / *"it's a
lot warmer than where your"* / *"temperature probe is on the edge."*, the range
*"So by low we mean 60, or some"* / *"people go in the fifties."*, and the ramp
*"We really find that we're trying"* / *"to lower temperature at the beginning."* /
*"We're actually starting to raise it at the end."*

**Missing the half the beat is named after: not one compound is named in this cut.**
The only compound-naming tape in the eleven transcripts is Richard Yi's
*"that's why you're able to, I get isoamyl"* / *"acetate, I get a ton of banana"*
(489, 00:47:49–00:47:54), which is 74 s and mechanistically about CO₂ retention rather
than temperature. A strong beat 10 needs both cues, from two episodes, and the second
one is a second below the 75 s floor on its own.

### Beat 15 — refusing to mature, and other vessels — **empty → thin**

Two independent candidates, neither strong, and they do not overlap:

- `cider-chat` 497, **00:35:14 → 00:36:40 (86 s)** — plastic against stainless as a
  process decision, on thermal behaviour and a fermentation-safe / storage-unsafe split:
  *"Some people will use plastic"* / *"instead of stainless steel"* / *"in fermentation or
  storage."*, *"you are gonna"* / *"get a lot of heat spikes from the"* / *"exothermic part
  of the fermentation."*, *"And the last thing is not good for"* / *"storage, like
  fermentation's fine, but"* / *"you don't want a store cider in them."* That last clause
  *is* the oxygen-permeability point, and **they never say oxygen**.
- `cider-chat` 495, **00:24:02 → 00:25:22 (80 s)** — a producer reducing oak's
  contribution to oxygen alone and asserting a glass vessel does the same work, on
  surface-area grounds: *"the vessel with lees, with lees contact, the vessel, doesn't
  matter. It does matter because if you, if you have a long, short one, you'll get more
  contact."* … *"There's, there's nothing that the oak is giving us, is what I'll say."*

**Missing:** clay, concrete, qvevri, reductive bottle ageing, and — the beat's own
framing — anybody who *stopped* using wood. Son of Man runs foeders alongside its
stainless. Working against the beat, in the same episode: *"Cleaning carboys is
terrible."* / *"You gonna break them all. Just work with oak. It's way more fun."*

### Beat 17 — the grape as the ideal fermentable — **empty → thin**

**Chosen:** `inside-winemaking` 209, band **00:13:32 → 00:15:36 (124.6 s)**. Andrea
Card, Director of Winemaking at Francis Ford Coppola Winery, demonstrating the
picking-date-to-finished-alcohol link rather than stating it: *"they are a portion of the
wine"* / *"is actually picked early, at 15"* / *"or 16 bricks, so much earlier"* / *"than
we would normally pick the"*, landing on *"we're talking about an 8%"* / *"alcohol
wine"*, with the acid consequence named (*"it's very vibrant because it's picked so"* /
*"early, so lots of natural acidity"*).

**Missing:** the arithmetic. Brix is never converted to expected ABV aloud, the yield
ratio never appears, and the general principle is never stated — it has to be inferred
from one product decision. Also absent: the grape's other gifts (skin tannin and colour,
wild flora, acidity as spoilage protection), chaptalisation, acidification.

### Beat 22 — cider, perry and the fruit wines — **empty → thin**

#278: *"`cider` returns 0 in discover and 2 in the archive"* — a Netflix wellness-fraud
series and a Portland taproom. There are now 514 curated cider episodes and 31 readable
ones.

**Chosen:** `cider-chat` 489 (Natural Cider Production Seminar, CiderCon 2025), band
**00:51:31 → 00:53:08 (97 s)**. Jasper Smith of Son of Man on the raw material as the
constraint: *"you can't make cider"* / *"like this with culinary apples."* … *"But if
you're buying"* / *"Fuji Gala, honey Crisp."* / *"This process doesn't work."*, then the
blend as composition-by-design — *"The idea was to make a blend of must that"* / *"we
didn't have to adjust any capacity."* / *"And this is actually the"* / *"highest Handin
blend we make."* — with proportions. **"Handin" is the transcript's garble of "tannin"
and is left as written.**

**Second cut, on the beat's own "honest account of concentrate-based industrial cider":**
489 **00:56:02 → 00:57:26 (84 s)**, *"we pay a farmer"* / *"directly 30 to 40 times per
pound."* / *"What concentrate costs"*.

**Third, from `cider-chat` 424** (Master Class on Apple Phenotyping), band
**00:56:00 → 00:58:03 (123 s)** — John Bunker of Super Chilly Farm, forty years
identifying apples, on classification by sugar and acid with named exemplars, and the
raw-material failure case: *"You have an insipid cider with no acidity."*

**What keeps this thin, and it is the beat's centrepiece: keeving.** It is *named twice*
in 489 and never explained — *"Somebody mentioned yesterday, I"* / *"think during the,
the keeving panel"*. No pectin, no added calcium, no brown cap, no arrested ferment.
Also missing: the sugar and nitrogen deficits stated as comparisons, tannin explained
as structure rather than used as a tasting word (Bunker's *"bitter sharp"* and
*"bittersweet"* are identification categories), **perry** (present only as brand names
and a can of "Giggle Juice"), and **sorbitol** (never said). The four-way
sharp/bittersweet/bittersharp classification does exist verbatim — *"Traditionally,
cider apples are"* / *"often grouped into four categories."* / *"Sweet, sharp,
bittersweet, and bittersharp"* — but as host narration in episode 500 with no mechanism
and no numbers, which is the "cider style guides" the beat explicitly rejects.

**Where the missing centre almost certainly is:** episode 121, *"Keeving Perry, Tieton
Cider Works"*, referenced inside 497's own guest introduction. It is one of the 483
Cider Chat episodes with no transcript. §8 ranks it.

### 3a. One verdict deliberately withheld, and the disagreement is recorded

**Beat 18 — red and white is a contact decision — stays EMPTY**, against a reading that
called it thin. Inside Winemaking 209 has the misconception's edge from a winemaker —
*"I always thought it was so weird"* / *"that Pinot Grigio was clear in a"* / *"bottle
when it's not a white"* / *"grape, really."* — but the span is **34.6 s**, less than half
the 75 s floor, and it cannot be lengthened: immediately before is a list of white
varieties and immediately after is *"What other whites are we doing?"* **Gate test 4
says cuttable in band, so a 34.6 s fragment is not a cut, and a beat with no cut is
empty.** Recording it as thin would have inflated the headline by one and hidden the
fact that maceration is never discussed as a clock anywhere in these eleven transcripts.

The nearby teinturier aside — *"like, Whoa, those grapes are"* / *"cool. They're red on
the inside."* — is 6 s and 25 minutes away.

---

## 4. Counts

### 4a. Against #278

| Verdict | #278 | now | change |
|---|---|---|---|
| **Strong** | **1** (26) | **2** (19, 26) | **+1** |
| **Thin** | **15** | **21** | **+6** |
| **Empty** | **47** | **40** | **−7** |

2 + 21 + 40 = 63.

**Moved empty → strong:** 19.
**Moved empty → thin:** 4, 5, 10, 15, 17, 22.
**Already thin, better tape, no count change:** 3 (a producer's vent-or-trap decision
in one tank at `cider-chat` 489 01:05:30 → 01:06:55, ~85 s, with a CO₂ figure —
*"When we hit about a half of a brick, we'll close the tank and let it finish."* /
*"Anaerobically and, and carbonate itself, we get 2.9 volumes"* / *"of CO2, something
like that."* — replacing two hosts on a Guinness widget); 14 (a reserve cut at 495
00:40:31 → 00:41:57, 86 s, oak provenance and oxygen micro-dosing, which does **not**
displace either segment beat 14 already carries because it has neither char subtraction
nor loss arithmetic); 20 (Andrea Card on the tank method she personally ran, 209
00:47:32 → 00:49:24, 111.8 s, including a regulation working as a mechanism — sucrose
in a sparkling base makes it legally unblendable into still wine, so a pressure-losing
tank is a total loss rather than a downgrade — but the traditional method is absent
entirely and the monk is never mentioned); 30 (unchanged, and see §5).

**Weighted by the spine's own share column**, which #278 calls the more honest measure:

| | #278 | now |
|---|---|---|
| strong | 2.0 % | **3.5 %** |
| thin | 25.8 % | **35.2 %** |
| empty | **72.2 %** | **61.3 %** |

Shares sum to 100.0 on both sides, which is the check that the three groups partition
the spine. Eleven points of intended runtime moved out of "nothing".

### 4b. By act — and this is where the result is uneven

| Act | Beats | #278 (S/T/E) | now (S/T/E) |
|---|---|---|---|
| **I — one molecule, four questions** | 1–16 | 0 / 3 / **13** | **0 / 7 / 9** |
| II — sugar already sweet | 17–25 | 0 / 1 / 8 | **1 / 3 / 5** |
| III — sugar unlocked | 26–35 | 1 / 2 / 7 | 1 / 2 / 7 |
| IV — concentration | 36–51 | 0 / 5 / 11 | 0 / 5 / 11 |
| V — made by addition | 52–60 | 0 / 3 / 6 | 0 / 3 / 6 |
| VI — the rules and the coda | 61–63 | 0 / 1 / 2 | 0 / 1 / 2 |

**Act I, stated plainly because it is the education the founder asked for.** Four of
its thirteen empties closed — 4, 5, 10 and 15 — and **not one of its sixteen beats has
strong tape.** #278 called it *"a broken derivation from end to end"*; it is now a
derivation with four partial supports and nine holes, which is a better narration brief
and the same product. The four that moved are all yeast-and-vessel beats served by one
Q&A session at CiderCon 2019, and the beats that carry Act I's argument — 1 (why
ethanol), 2 (the pathway), 6 (the free-sugar fork), 7–9 (the three conversion routes),
11–13 (distillation, the still, the cuts), 16 (the key) — are untouched. **Beat 2 is the
most important still-empty beat in the document**, and §5 says why it survived a direct
search.

**Chain versus fan**, on #278 §9b's split: of 40 chain beats, chain empties fall from
**30 to 24**. **The movement is overwhelmingly in the CHAIN, not the fan** — six of the
seven beats that moved are chain beats, including beat 19, the strong one, which sits
inside the wine chain. The wine chain now reads 3 empty / 1 thin / 1 strong against
4 empty / 1 thin. (An earlier draft of this line said the fan was where the strong beat
landed and then corrected itself inside its own parenthesis; the parenthesis was the
true half.)

### 4c. Beats still empty — all forty, named

**1, 2, 6, 7, 8, 9, 11, 13, 16, 18, 21, 23, 24, 25, 28, 29, 31, 32, 33, 34, 35, 37, 38,
40, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 60, 62, 63.**

Six of those are worth a sentence each, because a reader will assume the new shows
covered them:

- **2 (fermentation as yeast metabolism)** — still empty, and it was searched hard.
  Gravity *is* used as a working instrument: *"a happy yeast fermentation is usually
  somewhere between one to four points of specific gravity drop a day"*, clarified to
  *"1.001 to 1.004"* (497, 01:00:37 and 01:00:56). **The conversion to expected alcohol
  is never done aloud in any of the eleven transcripts.** Episode 500 hits the beat's
  reject line exactly: *"Cider is simply made by pressing apples to extract juice, and
  then you ferment that juice with yeast to produce alcohol."*
- **6 (free sugar versus locked starch)** — the fork is never drawn. The nearest miss is
  a distiller listing substrates: *"We had to figure out how to make agave pulp ferment.
  It's not beer. It doesn't have the same nutrients. It doesn't respond to beer yeast. We
  had to figure out how to make potatoes ferment."* (504, ~35 s) — nutrients and yeast
  selection, never free sugar against polymer, no enzymes.
- **21 (phylloxera and the grafted vineyard)** — `phylloxera`, `rootstock` and `graft`
  do not appear. Two passages in 209 mention vine **virus** in old blocks and will read
  as false positives on a keyword sweep; leafroll-type virus depressing ripeness is a
  different problem.
- **23 (mead)** — mead appears three times across the two long files, every one inside a
  patron read-out. No honey, no water activity, no assimilable nitrogen.
- **52–55 (the fortification chain)** — four for four empty, unchanged. #278 identified
  `I'll Drink to That!` as the source for 52 and 54; it is now curated and publishes
  **zero transcripts across 505 episodes**, so the chain moved from "no source" to
  "identified source, unreadable". That is progress of a kind and it is not coverage.
- **62 (proof and the 40 % minimum)** — Bourbon Pursuit 579 is literally a proof debate
  and is now curated. Zero transcripts.

---

## 5. What curation did not fix, and why that is the useful half of this result

**Three shows, 2,431 episodes, zero transcripts, and they hold Acts IV and VI plus
Act I's distillation beats.** WhiskyCast (1,178), Bourbon Pursuit (1,206) and
Spirits & Distilling (47) publish no `<podcast:transcript>` of any kind. #278's §11
table predicted Bourbon Pursuit would reach beats 14, 37, 38, 39, 61 and 62 and
Spirits & Distilling beats 11, 12 and 13 — **the three Act I distillation beats.** Those
predictions are neither confirmed nor falsified by this pass; they are now testable for
the price of an ASR job each, and §8 ranks them.

**#278's over-supply record stays bad, and this pass adds a data point in the same
direction.** Its §9c scored 15 of 15 on narration predictions and 0 of 5 on over-supply.
The same asymmetry held here: the two shows whose titles most directly promise Act I —
`How Cider Is Made | Lessons from 500 Episodes` and Basic Brewing Radio's twenty years
of technique episodes — produced, respectively, **nothing** (host narration plus
unattributed 5–30 s archive drop-ins, failing test 2 wherever it matters) and **nothing
scoreable at all** (no transcripts). Meanwhile the beat that came back strong, 19, was
in nobody's forecast for this pass; two independent readings landed on it unprompted.
**The lesson is #278's own, now with a third data point: reasoning about the medium is
reliable, reasoning about what a specific episode contains is not, and only reading
settles it.**

**Beat 30 is the sharpest "good tape, wrong beat" case in the document.** Episode 489
holds first-rate mixed-fermentation material — Richard Yi's deliberately maintained raw
tank, *"it's"* / *"chockfull of different bacteria."* / *"Probably a little acetobacter,"*
/ *"lactic acid bacteria, and a bunch of"* / *"different you know, yeast strains"*, kept
cold *"because, we want to"* / *"control how, how far it kind of gets"* and then used as
inoculum, plus an honest failure account from the natural wine world
(*"all of a sudden you've got mousy"* / *"wine wines with tons of VA"*). **Beat 30 as
written is a beer beat** — lambic, coolship, seasonal restriction, *Brettanomyces*,
*Pediococcus* — and awarding cider tape to it would be exactly the stretch #226 exists
to stop. It stays thin on its existing segment. §7 proposes the amendment.

---

## 6. What it cost the mobile bundle

Measured with the shipped tool, before and after, on this branch:

```
before:  webDir ready: mobile\www  (35 files, 2.01 MB of 3.00 MB)
           sliced: data/discover.json  682.0 KB of 800.0 KB
after:   webDir ready: mobile\www  (35 files, 2.02 MB of 3.00 MB)
           sliced: data/discover.json  704.5 KB of 800.0 KB
```

| | before (`81f7179`) | after |
|---|---|---|
| slice | 624 items / 213 shows / **682.0 KB** | 645 items / 220 shows / **704.5 KB** |
| per-show marginal cost | (projected 3.20 KB) | **3.21 KB measured** |
| headroom to the 800 KB budget | ~36 shows | **~29 shows** |
| whole bundle | 2.01 MB of 3.00 | 2.03 MB of 3.00 |

**The marginal cost is the stable quantity and it is the one the budget argument rests
on.** Across three different `main` baselines (`6d163c5`, `9b1374b`, `81f7179`, spanning
89 nightly episodes) the slice measured 681.3 -> 703.9, then 682.0 -> 704.5, then
682.0 -> 704.5 KB: **3.23, 3.21 and 3.21 KB per show**. The slice is
`BUNDLED_ITEMS_PER_SHOW` items per show, so a nightly that adds episodes to shows the
catalogue already has does not move it — only a nightly that adds a SHOW would, and
those go through curation. That is why seven shows can be costed at all.

**The budget was not raised and did not need to be.** #274 chose 800 KB on the reasoning
that *"a bundle creeping toward the cap is a signal worth getting, not noise"*, and this
change is the signal working as intended: seven shows cost 22.5 KB and the number to
watch went from 36 to 29.

**The projection held, and the reason it held is worth recording because it was the
open question.** `discoverSlice` is not purely 3-per-show: after the per-show pass it
tops up to keep every topic represented, and 10 shows currently carry more than 3 items
for that reason. Drinks shows introduced exactly **one** new topic — `food/drinks`,
which went from 0 items to 28 — and the per-show pass covered it on its own, because
**every one of the 28 new items carries `food/drinks`**. So the top-up did not fire:
the per-show distribution is unchanged in shape — shows carrying 1/2/3/4/6 slice items
go **2/28/181/8/2** against **2/28/174/8/2** before, so the only bucket that moves is
the 3-item one, +7, one per new show — and all 21 new slice items are the plain
3-per-show allocation. (Pre-rebase the 1-item bucket held one show rather than two; the
nightly added the other.)
A future block of shows spread across *several* new topics would not be this cheap.

**One product-level outcome outside the Foray, from the regenerated
`data/topic-coverage-report.json`:** two of the taxonomy's 155 topics moved from
`absent` to `deep` — `wine-cocktails` (tag_count 1 → 11) and `coffee` — taking the
report's `absent` count from 50 to 48 and its priority-2 count from 46 to 48. The
report is a generated artefact and was regenerated because this change is exactly the
kind that makes it stale.

---

## 7. The `item-tags.json` trim check, re-run

#275 made `tagDF` a fraction, so adding shows should no longer re-rank search; #275
also found that it did **not** make the `COPIED_WHOLE` trim of `item-tags.json` safe,
because the 3-per-show slice is topically skewed. A block of drinks shows is exactly
that kind of skew, so both halves were re-measured over the 1,366-term vocabulary
(`semantic-index.json` concept terms plus `ALIASES`), reading the rules from the engine
(`expansionBucket`, `dfMultiplier`) rather than mirroring them.

**(a) Growth — the whole map, `main` (`81f7179`, 1,650 entries) against this branch
(1,678).**

**0 expansion buckets move, and that is the answer to the question #279 was asked to
settle.** Nothing crosses `TAG_DF_TOO_BROAD` 0.10 or `TAG_DF_COMMON` 0.02 — the two
thresholds that delete a term from query expansion or cut its weight to 0.4x. That held
on every baseline this was measured against. #275's fix absorbed the addition, which is
what it was for. The nearest term to either line is `comedy` at 10.43 %, already above
0.10 on both sides, and `markets`/`market` at 2.15 %, already above 0.02 on both sides.

**Three score multipliers move, all across `TAG_DF_RARE` 0.008, all downward, and all
three are genuinely ours:**

| term | main | branch | multiplier | tag count |
|---|---|---|---|---|
| `fermentation` | 0.61 % | 1.13 % | 1.35 → 1 | 10 → **19** |
| `food-history` | 0.73 % | 0.83 % | 1.35 → 1 | 12 → **14** |
| `craft-beer` | 0.79 % | 0.83 % | 1.35 → 1 | 13 → **14** |

Those are three drinks terms becoming less rare because the catalogue now holds more
drinks. That is the ranker working as designed, not drifting.

> **THE MULTIPLIER COUNT IS A NIGHTLY-SCALE QUANTITY AND SHOULD NOT BE QUOTED.** This
> was measured against three `main` baselines during the life of this branch and read
> **3, then 13, then 3**. The 13 was not a different effect: eleven of those terms sat
> at exactly 13/1,617 = 0.804 % and fell to 13/1,645 = 0.790 % with **no change to their
> tag count at all** — the denominator moved and the numerator did not. Which terms
> happen to be sitting on the 0.008 line depends on what the nightlies did last week,
> not on what this branch did. **The stable finding is the pair above it: zero expansion
> buckets, and every crossing at `TAG_DF_RARE` only.** Re-measure rather than cite:
> `tools/mobile/prepare-webdir.test.mjs`'s "REAL REPO" test carries the code.

**(b) Sampling — whole map against the bundled slice, the divergence the
`COPIED_WHOLE` refusal rests on. It does not get worse.**

| | expansion buckets | score multipliers |
|---|---|---|
| `main` (`81f7179`) | 18 | 70 |
| this branch | **17** | **75** |

**No term ENTERS the divergence set; one leaves it (`family`).** The seventeen are
`careers`, `comedy`, `economics`, `founder`, `founders`, `market`, `markets`,
`materials`, `neuroscience`, `physics`, `sports-science`, `stories`, `story`, `tools`,
`true-crime`, `world-war`, `world-war-2`. **Not one drinks term is in it**, at any
threshold: `beer` 1.13 %, `wine` 0.66 %, `cider` 0.24 %, `whisky` 0.12 %,
`whiskey` 0.48 %, `distilling` 0.66 %, `bourbon` 0.36 % — all "full", all far below
`TAG_DF_COMMON`. `comedy` is still the sharp one at 10.43 % whole against 8.18 % slice.

Same caveat as (a): the SIZE of this set is a nightly-scale quantity — it read 14, then
14, then 18 on `main` across the three baselines. **The finding that survives all three
is directional and it is the one the refusal needs: the divergence does not get worse
when these seven shows are added, and no drinks term is ever in it.**

**One thing to flag rather than bury: `main` measures 18/70, not the 12/62
`prepare-webdir.test.mjs` records.** The test's own comment predicted exactly this —
*"a sampling residue of 12 terms on a slice the nightly rebuilds, so one refresh could
take it to 0 without anybody having decided anything"* — and the drift is nightlies, not
this change. It has drifted UP, which is the safe direction for the refusal. The
assertions still pass on this branch (`moved` 17 > 0, and 17 × 2 = 34 < 75 under the
pre-#275 absolute rule), so `item-tags.json` stays copied whole and the ~181 KB stays
unbought. **This change is not evidence for or against trimming it.** Re-run it with the
test's own code path rather than by quotation:
`node --test tools/mobile/prepare-webdir.test.mjs`.

---

## 8. The ranked queue this pass creates, and it is much longer than #278's

#278's §10 had *"five rows worth buying and then a wall"*. **The wall moved; it did not
go.** What replaces it is a queue of **named episodes in curated shows** whose only
obstacle is that nobody has read them — a purchase decision rather than a search
problem, which is a better kind of obstacle and still an obstacle. On the count that
matters it reaches seven closed beats against #278's six (§11), not sixteen. Ordered
by beats moved per job, with the hypothesis stated falsifiably so the next pass can
score it the way #278 §9c scored §5.

**1. `cider-chat` 121, "Keeving Perry, Tieton Cider Works".** Target: **beat 22's
centrepiece**, the only thing keeping it from strong, plus **perry**, which appears
nowhere else in either pool. Non-DAI, so playable immediately. No transcript.
*Hypothesis:* a cider maker asked about keeving describes pectin, added calcium, the
brown cap and the arrested ferment. *How it fails:* keeving is discussed as a style
rather than a mechanism, as it is in 489.

**2. `spirits-and-distilling` 45, "John Angus Explores the Science and Chemistry of
Spirits Flavor" (47 min).** Target: **beats 10 and 13**, both empty, both Act I. An
analytical chemist on the reactions that build flavour is the register beat 10 needs and
beat 13's cuts-and-methanol claim sits inside the same chemistry. Non-DAI.
*Hypothesis:* congeners are named as compounds with their origins. *How it fails:* it
stays at the level of "flavour is complicated" without naming a compound, which is what
happened to beat 10's temperature cut.

**3. `spirits-and-distilling` 39, "Jarrad Huckshold of The Cask Takes a Winemaker's
Approach to Whiskey Maturation and Blending" (60 min).** Target: **beats 14 and 38**,
and the show's own framing — that whisky's *"now-enshrined methods were born of
efficiency considerations and political realities more than quality concerns"* — is
beat 14's four-processes claim and beat 61's category-law claim in one sentence.
Non-DAI.

**4. `spirits-and-distilling` 34 (sotol) and 25 (California agave).** Target: **beats 44
and 51**, both empty. #278's vocabulary sweep returned **`agave` 0 and `sotol` 0 across
75,253 items and episodes**; both are now curated, named in episode titles, non-DAI. Two
jobs, and 51 is the beat that proves the classification key works on the margins.

**5. `inside-winemaking` 211, "Heat and Cold Stabilization of wines with Leigh
Meyering".** Target: **beat 19's missing clauses** (fining, what each treatment removes)
and possibly **beat 15**. Protein haze and tartrate instability explained by a
consulting enologist is mechanism by construction. Non-DAI, and the show ships one real
transcript out of 224, so this is ASR.

**6. `basic-brewing-radio` — three rows, all non-DAI, all ASR.** *Deconstructing
Partigyles* for **beat 26/29**; *Cask Beer Care with CAMRA* for **beat 3** (the
retain-or-vent decision, on the one serving tradition that answers it differently) and
**beat 15**; *Rhubarb Wine* for **beat 22's fruit-wine half**, which no other row
reaches. Twenty years of technique episodes behind them and not one transcript.

**7. `whiskycast` — the Act IV block.** *Making Single Malt Whisky on Scotland's
Ballindalloch Estate* (beat 37), *Glengoyne Mizunara Oak* (beats 14, 15),
*From Bloody Butcher to Bruce's Blue: Heirloom Grains at Jeptha Creed* (beat 39),
*Distilling the Artisan Way* (beat 12, and the mash-bill half of 39). Non-DAI, 1,178
episodes, zero transcripts. **This is the largest single block of identified-but-unread
tape in the project.**

**8. `bourbon-pursuit` 579 for beat 62, 571 for beats 38–39.** DAI-suspected
(Megaphone), so cuts are authorable-and-unplayable under `ADR-0008` until the locate
step exists. Rank last for that reason, not for content.

**9. `ill-drink-to-that-wine-talk`, 505 episodes, DAI (art19), zero transcripts.**
#278 named it for beats 17, 18, 19, 21, 52 and 54, and 18, 21, 52 and 54 are still
empty. Episode 500, *"Richard Sanford and the Hot Tub Time Machine Wine Fermenters"*, is
the most promising single row for **beat 18**. Same DAI caveat as 8.

**Two conditional stops, named so the list is auditable.** `cider-chat` 501
(*How to Taste Cider*) and 490 (*Let Cider Lead*) are read and moved nothing: 501 is a
host-solo sensory monologue, which is what beat 10 rejects, and 490 is an industry
editorial. 503 (*UK Blossom Time Tour*) is 72 minutes of guest testimonial with no
sourced production mechanism, and 504's recoopering passage is real
previous-contents-as-a-variable material carrying no mechanism at all. **Four of eleven
transcripts read moved nothing** — 36.4 %, against #278's six of seventeen, 35.3 %. That
is very slightly **worse**, not better, and an earlier draft of this line claimed the
opposite. The honest reading is that the two rates are indistinguishable at this sample
size, which is itself the finding: curating better-targeted shows did not raise the hit
rate per transcript read. Same finding as #278, in kind and in size.

---

## 9. Spine gaps found, recorded rather than acted on

Three, in the shape of #278 §11.2's cask-supply finding. **The spine is untouched by
this pass.**

**1. Low- and no-alcohol wine has real mechanistic tape and no beat.** Inside Winemaking
209 carries it from a working winemaker: the deliberate early pick to land at 8 %,
residual-sugar correction because low alcohol tastes *"very watery"*, industrial
de-alcoholisation as a send-out service (*"used to send it to cone tech, it"* / *"would
come back at 4% alcohol"*), and an honest verdict from someone doing the R&D —
*"Yeah, it's been our experience"* / *"that it's very, very difficult"* / *"to find no
alcohol wine that"* / *"tastes good."* **Beat 5 is the nearest neighbour and runs the
opposite way** (routes *above* the ceiling). This is the fastest-moving segment in the
category and the spine has no slot for it. §6b of the spine should say whether that is
deliberate.

**2. Beat 30 should either widen to "wild and mixed fermentation" or grow a cider
sibling.** See §5. As written it is a beer beat and cannot hold the best
mixed-fermentation tape now in the catalogue.

**3. Two more pieces of good tape no beat can hold**, both from `cider-chat` 489:
regulated organoleptic gatekeeping (**00:40:05 → 00:41:27** — a Basque origin label
requiring both a physical-chemical analysis and an independent trained tasting panel,
*"then"* / *"they will punish that cider and they"* / *"won't go to the market"*), and
the living-product logistics problem (**00:49:04 → 00:51:29** — an unstabilised bottle
with a ten-month best-before and rolling batch bottling so every bottle reaches the
shelf fresh). Shelf life as a production constraint on a whole class of drinks appears
in no beat. And one that is audio-native enough to be worth an interstitial:
**00:15:35 → 00:17:44 in 495 (129 s)**, makers putting a microphone to a bung and using
the sound as a diagnostic — *"You'll hear carbon dioxide bubbles being cleaved off the
Malic acid and being released into the air."*, Rice Krispies for malolactic, popcorn for
vigorous primary, and a real fault test on the sound changing while sugar remains.

---

## 10. Two things that are now stale, named so they are not rediscovered

**`in_curated` in `data/catalog-breadth.json` reads `false` for all seven shows and is
now wrong.** The field is written only by `tools/harvest-catalog.mjs` and read by no
code in the repository, and the file is a single 12 MB line, so correcting seven
booleans would produce an unreviewable whole-file diff. It is left alone deliberately.
A `harvest-catalog.mjs` run restores it. **Until then, #278 §11.1's "exactly one is
curated" is stale by seven, and any pass that recounts the drinks holding from that
field will under-report it.**

**`data/transcript-availability.json` does not cover the seven new shows.** It indexes
the catalogue as it was at 213 shows. The measurement in §2 was taken with
`sweep-transcripts.mjs --catalog <scratch> --out <scratch>` and **not** committed,
because a partial index is worse than a stale one. `node tools/segments/sweep-transcripts.mjs`
re-sweeps all 220 and is the right way to fold them in; it is a several-hour run and is
not part of this change.

---

## 11. Can this catalogue support this subject now

**Closer, and still no — with the refusal now located in one specific place.**

#278's answer was *"No, and the honest answer is not close"*, on three grounds. Two of
them have changed:

- **It was not a search failure then and it is not one now**, but the pool is different:
  the 42 hand-picked technical terms that returned zero across 75,253 rows were being
  asked of a catalogue with three drink shows in it — all three on beer or food
  fermentation. It now has ten, and **six** of them are on wine, cider or spirits — the
  seventh new show, Basic Brewing Radio, is beer, which the catalogue already had: 514
  curated cider episodes where there were none, 729 on wine, 2,431 on whisky and spirits.
- **"It is not fixable by transcription" is less true than it was, and the number that
  says so is 6 -> 7, not 6 -> 16.** #278's queue would have moved six beats. §8's queue
  is nine ranked rows spanning seven shows, five of them non-DAI, and *touches* beats
  3, 10, 12, 13, 14, 15,
  19, 22, 26, 29, 37, 38, 39, 44, 51 and 62 — but **only seven of those sixteen are
  currently empty**, and those seven are **13, 29, 37, 38, 44, 51 and 62** (§4c's list
  of the forty). Of the other nine, 19 and 26 are strong (§4a) and 3, 10, 12, 14, 15, 22
  and 39 are thin, so transcribing the queue would *deepen* those and *close* seven. An
  earlier draft quoted the sixteen as though all of them were closures and called it
  "the change this issue bought"; it is not, and a first correction of that draft named
  the wrong nine. What this issue bought is that the queue is **nine named episodes in
  curated shows** rather than a search that returns nothing — a purchase decision
  instead of a sourcing problem. That is real and worth having. On beats closed it is
  one more than #278's queue.
- **The failure is still in the chain**, and Act I is still the chain that matters.
  24 of 40 chain beats are empty, nine of them in Act I, and Act I has no strong tape at
  all. **The derivation the founder asked for — "walk me through the production process
  for each" — is still narration with tape as illustration.**

So the three options #278 named are still the three options, with the second one partly
spent and now cheaper to finish. What is different is that `alcohol-forms-1` has moved
from *"a Foray about beer, absinthe and bourbon with a chapter on prohibition"* to a
Foray that can demonstrate, with playable tape from people who do the work, how a
fermentation is stopped on purpose, what a winemaker decides after the yeast finishes,
why cider apples are inedible, and what a barrel is actually doing. **That is four beats
of mechanism, and by this document's own gate only one of the four — beat 19 — is
strong; the other three are thin.** It is not sixteen. (§0 originally read *"curation
bought the wine and cider families outright"*, which is too strong for what one strong
beat and six thin ones buy; it now reads "a foothold", and this note stays so the
correction is not made twice.)

**And none of it changes the product-mode question.** #287 landed after this pass and
measured the alcohol Foray at **72.9 % narrator written in full**, against the 40 % line
`narration-craft.md` calls *"an essay with clips. Not a Foray."* That verdict — the
catalogue cannot fund this Foray as a **tape-led** product — is filed as
`HUMAN-ACTIONS.md` **#22** and is still open. #22's arithmetic was computed against
1 / 15 / 47; **nobody has re-run it against 2 / 21 / 40, and this document does not
claim to have.** Six more thin beats and one strong one in Acts I and II do not
plausibly close a thirty-point gap, but that is a judgement and #22 wants a measurement.
Read §11 as *"the catalogue action was worth doing and did not answer the funding
question"*, which is what #279 was scoped to find out.

**One inheritance to declare.** The headline 2 / 21 / 40 rests on #278 §9a's undecided
founder call: the SYSK register decides 11 of the 15 thin verdicts this pass inherits,
and under a SYSK-out reading the same gate gives roughly **2 / 12 / 49**. #278 recorded
that as open and it is still open, so the counts here carry it too.

---

## 12. Revision note

This document is stage 2b of #226, opened by #279. It supersedes nothing in
`alcohol-forms-coverage.md`: that document's counts are the baseline this one is
measured against and its §3–§8 beat entries remain the record for the 56 beats this
pass did not touch. Where the two disagree, they disagree about a **different
catalogue**, and both say which one they measured.
