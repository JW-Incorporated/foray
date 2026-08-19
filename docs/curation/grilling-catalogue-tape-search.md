# Catalogue tape search — buying tape for the empty chain beats

A sourcing proposal for `grilling-history-1`, searched against the **recommendation
catalogue** rather than the ASR work order. Companion to
`grilling-history-coverage.md` §5 and §10, which say what each beat needs, and to
`grilling-beat-cut-plan.md` §3a, which says what closing one is worth.

**Status:** proposed. **Nothing was transcribed, no segment was cut, and
`data/forays.json`, `data/segments.json` and `data/segment-sources.json` are
untouched.** `data/` was read and not written. The only files this pass changes are
this document and `grilling-asr-manifest.json`.

**The governing rule, quoted rather than paraphrased**, from the founder on #226:

> "if we have content that is irrelevant, don't distort the narrative just to use
> more podcast content. Keep it mostly on topic"

Everything below is scored against a specific beat's claim, never against
"barbecue". Where a row is on the Foray's subject and does not advance a beat, it is
labelled and left in the catalogue — **label, never exclude**. Nothing here is
dropped from `data/discover.json`, and several of the rejections below are good
episodes that a playlist should keep.

**A note on the quotations, because one of them is load-bearing twice over.** Every
title, hook and tag quoted below was checked back against `data/discover.json` and
`data/item-tags.json` programmatically, and every quotation from the spine, the
coverage report and the cut plan was checked back against those files the same way.
Nothing is repaired, normalised or tidied: where a hook is ungrammatical or a title
carries three exclamation marks, it is reproduced as the data holds it. The only
liberty taken is the ordinary one of lowering a quoted sentence's initial capital when
it sits inside a sentence of ours.

---

## 0. The finding, stated first because it is a refusal

> **The catalogue does not contain the tape for Act IV. Not one of its seven empty
> chain beats can be closed from these 1,534 items, and the reason is not that the
> search was too narrow — it is that the catalogue holds no American barbecue
> history of any kind.**

Measured, with word boundaries, over the whole pool: `barbacoa` **0**, `taino` **0**,
`carolina` **0**, `stockyard` **0**, `juneteenth` **0**, `emancipation` **0**,
`twitty` **0**, `hog` **0**, `swine` **0**. `memphis` returns **one** item and it is
a cycling travelogue; `kansas` returns **one** and it is an amusement-park story;
`migration` returns **one** and it is about the settlement of Aotearoa. §3 works
through each beat.

Two rows are worth buying and neither is in Act IV: **Gastropod's refrigeration
episode for beat 31**, which the ASR manifest already named and which turns out to
be sitting in `data/discover.json` with its metadata, and **The BBQ Central Show's
Jess Pryles episode for beat 3**, which `grilling-beat-cut-plan.md` §3b predicted
would be on-brief and which is. A third row settles a pending spine amendment
without moving a beat.

**What that does to the arithmetic, precisely.** §3a of the cut plan needs **five**
closed holes to buy back the nine chain links its 22-beat plan cuts. The catalogue
offers at most **two**, so it cannot fund that. What two closures do buy is the
hard ceiling: the 31-beat stage-one Foray goes from **35.15 %**, over the line, to
about **30.2 %**, under it — see §8. **The ceiling becomes reachable and the target
does not.**

**So the answer to "keep transcribing or buy the material" is: buy or make it.**
Act IV's prologue, its West African inheritance and its entire regional stretch are
not in this catalogue at any priority, and no re-sort of the queue changes that.

---

## 1. What was searched, and with what instrument

| Handle | Size | What it gave |
|---|---|---|
| `data/discover.json` | **1,534 items**, built 2026-08-18T11:43:23.489Z | the pool every judgement below is made over |
| `data/item-tags.json` | 1,561 tagged ids | the tag vocabulary, matched per hyphen segment |
| `data/catalog.json` | 213 shows | show-level register and editorial notes |
| `data/taxonomy.json` | 109 topic nodes in use | the topic filter |
| `search-engine.js` | — | `hitText` and `hitTag`, used as the matcher |

**The matcher is the shipped one, deliberately.** `hitText` and `hitTag` are
imported from `search-engine.js` rather than reimplemented, so every count in this
document is the same predicate the product ranks on after #270, and a term that
would collide in a hand-rolled matcher collides here or nowhere. The engine's
multi-token query path was also run and is not the instrument used for counts: its
proper-noun AND gate returns zero for a query like `pit barbecue history` while
`barbecue` alone returns six, which is engine behaviour and not a finding about
barbecue.

### 1a. The substring trap, measured on this catalogue

The previous round was misled by a vocabulary table built with substring matching,
where `pit` matched "despite" and `fire` matched "firearms". The same collision
class, re-measured here over these 1,534 items:

| term | naive `includes()` | word boundary | overstatement |
|---|---|---|---|
| `pit` | **52** | **1** | **52x** |
| `fire` | 21 | 13 | 1.6x |
| `smoke` | 1 | 1 | — |
| `grill` | 7 | 7 | — |
| `bbq` | 8 | 8 | — |

**`pit` is a 52-fold overstatement on this pool**, which is worse than the ratio the
last round met, and the one surviving whole-word hit is `the-archaeology-show--hominin-structures`
— *"476,000-year-old worked wood, new Pompeii remains, and Peru's 5,200 aligned
pits"* — where the pits are archaeological features in Peru and have nothing to do
with cooking. So on this catalogue the term with the strongest apparent signal for
Act IV yields, after word boundaries and after reading, **nothing at all**.

### 1b. The neighbouring-beat trap, checked and found not to apply here

Coverage §5's beat 20 entry records that beats 15 and 20 share almost all their
nouns, so a high fire-term count can be evidence for the neighbour. That trap
cannot fire on this catalogue for the simple reason that the vocabulary is absent
in both directions: `jerk` **0**, `maroon` **0**, `allspice` **0**, `pimento` **0**,
`vinegar` **0**. There is no Caribbean fire tape here to mistake for American fire
tape. **The trap that does fire on this catalogue is the title-and-hook mismatch**, and
it has three distinct shapes here, all recorded below: a title that matches while the
hook corroborates nothing (`the-moth--soul-searching-soul-food-and-the`); a hook that
describes its sibling episode rather than itself
(`the-bbq-central-show--embedded-correspondents-july-2026`); and a hook that describes
the wrong half of its own episode, where the payload is in the title and the hook is
about cigars (`the-bbq-central-show--cigar-wrapper-talk-with-mr-j`). The third is a
ranked row rather than a stop, which is the point: the mismatch cuts both ways and
neither direction can be trusted without reading.

---

## 2. The complete on-plot inventory, which is smaller than the pool suggests

The catalogue is a general recommendation pool, not a food pool. Its entire food and
nutrition holding is **56 items** across `food/cooking-science` (16),
`food/fermentation` (17) and `health/nutrition` (23), and most of that is brewing,
supplements and diet science. The `food-history` tag reaches **12 items**.

**Every item in the catalogue whose subject touches fire, barbecue or food history is
in this table.** Eight of the seventeen are one show and four are another, which is most
of what is wrong here. §7 adds the adjacent rows a keyword pass surfaces — the rail
history, the Reconstruction legal history — which are on the Foray's territory without
being on its subject.

| id | show | length | first beat considered | verdict |
|---|---|---|---|---|
| `the-bbq-central-show--jess-pryles-is-not-here-to` | The BBQ Central Show | 3,967 s | **3** | **candidate, ranked 2** |
| `the-bbq-central-show--cigar-wrapper-talk-with-mr-j` | The BBQ Central Show | 3,776 s | 27 | **spine amendment, ranked 3** |
| `the-bbq-central-show--steven-raichlen` | The BBQ Central Show | 3,627 s | 3 | conditional second shot, ranked 4 |
| `the-bbq-central-show--grant-pinkerton` | The BBQ Central Show | 3,774 s | 26 | **stop** |
| `the-bbq-central-show--embedded-correspondents-july-2026` | The BBQ Central Show | 3,622 s | 3, 36 | **stop** — same broadcast as the Pryles row |
| `the-bbq-central-show--pitmasters-contestants-connie-desousa-and-john` | The BBQ Central Show | 3,741 s | 36 | **stop** |
| `the-bbq-central-show--sam-tours-japan-with-guests-ali` | The BBQ Central Show | 4,165 s | 11 | **stop** |
| `the-bbq-central-show--best-moments-meathead` | The BBQ Central Show | 563 s | 3 | **stop**, and it carries a lead — §9 |
| `gastropod--refrigeration` | Gastropod | 2,955 s | **31** | **candidate, ranked 1** |
| `gastropod--bringing-home-the-bacon` | Gastropod | 2,890 s | 2, 19 | **stop** |
| `gastropod--sushi` | Gastropod | 2,729 s | 2 | **stop** |
| `gastropod--salad-days-a-story-of-science` | Gastropod | 2,671 s | 33 | **stop** |
| `odd-lots--how-a-sardine-gets-from-the` | Odd Lots | 3,467 s | 37 | **stop** |
| `hardcore-history--blitz-human-resources` | Dan Carlin's Hardcore History | 20,352 s | 20, 21 | **stop** |
| `the-moth--soul-searching-soul-food-and-the` | The Moth | 2,968 s | 20 | **stop** — title-only match |
| `cbc-ideas--fear-of-fire` | CBC Ideas | 3,248 s | 1 | **stop** |
| `engines-of-our-ingenuity--the-engines-of-our-ingenuity-1615` | Engines of Our Ingenuity | 227 s | 5 | **stop** |

**Seventeen rows scored: two worth buying, one worth reading for a spine question, one
conditional on the first, and thirteen stops.** That ratio is the finding, not a
disappointment: it is what a catalogue built for general listening looks like when
it is asked a fifteen-beat question about the American South. §7's stop table has
sixteen entries rather than thirteen because three of them group several ids each.

---

## 3. Act IV first — the seven empty chain beats, each scored

Act IV is a fifteen-beat chronological chain carrying 36.5 % of intended runtime, and
coverage §7 records the remaining holes as **16 and 17 at the opening, 20, and 25,
26, 28 and 29 across the whole regional stretch**. A hole here reads as a missing
link. This is where the search started and it is where it found least.

### Beat 16 — the word named a frame — **nothing, and the register exists without the subject**

The beat wants *"a food historian, linguist or lexicographer on the etymology and its
earliest attestations, ideally naming a chronicler or a dated English usage, and
explicitly rejecting the 'barbe à queue' story"*, and rejects *"assertion of either
etymology with no source"*.

`barbacoa` **0 hits**. `taino` **0 hits**. The catalogue does hold the right
register — **The Allusionist**, eight items, tagged `etymology`, `lexicography`,
`dictionaries`, including *"225. Hues"*, whose hook is *"Lexicographers spent
decades failing to pin down how to define color names"* — and it holds no episode
on this word or on any food word's attestation. **A lexicography show with no
barbecue episode is not a candidate**, and there is nothing here to queue. Beat 16
stays the Carry that coverage §10e already found **writable with no new citation**,
which is why it is the cheapest of Act IV's holes to leave open.

### Beat 17 — barbacoa as living practice — **nothing, and nothing could change it**

Empty **by ruling**, not by shortage. The catalogue confirms it from its own side:
`barbacoa` 0. No English row exists and the Spanish rows the manifest already holds
are barred by the English-only ruling of 2026-08-16. Permanent narration beat.

### Beat 20 — the West African inheritance — **nothing, and the largest tempting row is the clearest reject**

Two English sources have already been spent on this beat and coverage §5 calls it
nearly closed. The catalogue adds nothing and removes nothing: `twitty` **0**,
`maroon` **0**, and no African fire-cookery episode of any kind.

**The one row a keyword pass would surface is `hardcore-history--blitz-human-resources`**
— 339 minutes, hook *"Centuries of human bondage, economics, and violence in the
Atlantic slave trade"*, tags `slavery`, `atlantic-slave-trade`, `economics`. It is
the largest single piece of tape in the catalogue on the Foray's adjacent territory
and it fails beat 20 on the beat's own reject line, which asks the question directly:
*"generic statements that African cooking influenced Southern food, with no technique
and no mechanism of transfer"*. There is no cooking in it at all — no fire, no
butchery, no seasoning lineage — so it does not reach even the generic version. It
also cannot serve beats 21, 22 or 24, which are strong on a historian's own argument
and which do not need a five-and-a-half-hour general history behind them.

`the-moth--soul-searching-soul-food-and-the` is the other one a keyword pass finds,
and it is a **title-only match**: the episode title contains "Soul Food" and its hook
is *"Storytellers share big risks, long goodbyes, and a reflection on the anatomy of a
straw"*. The title is a themed-hour conceit and the hook corroborates no food content
whatsoever. Stop.

### Beat 25 — the style map as Black migration — **nothing**

The beat wants *"a historian or a city-specific writer on barbecue and the
Migration: which routes fed which cities, what changed in the new setting"*, and
rejects *"city-by-city restaurant round-ups with no migration argument"*.

`migration` returns exactly **one** whole-word hit in 1,534 items:
`the-ancients--the-first-new-zealanders`, hook *"How East Polynesian voyagers reached
Aotearoa around 1300 and built a society in a few generations"*. `sharecropper`
returns one, a zydeco musician's family story. `juneteenth` and `emancipation` return
none. **There is no Great Migration content in this catalogue, with or without
barbecue.**

### Beat 26 — Texas is four traditions — **nothing, and the one Texas barbecue row is the reject the beat names**

`texas` returns **8** items and seven are place-name collisions of exactly the class
`tools/test-search.mjs` calibrates against — an industrial disaster, three true-crime
episodes, a death-row serial, a bikeable forest. The eighth is
`the-bbq-central-show--grant-pinkerton`, hook *"A Houston pitmaster on running one of
Texas's most respected barbecue joints"*, tags `bbq`, `barbecue`, `pitmasters`,
`texas`, `grilling`, `food`, `interview`.

Beat 26 asks for the butcher-shop lineage and its immigrant provenance, who the early
customers were, the separate East Texas and Rio Grande lineages named as such, and
*"anyone dating brisket's rise and explaining the supply-side change under it"*. Its
reject line is *"brisket technique content with no history, and origin claims that
credit one lineage with all four"*. A profile of a working restaurant is neither the
history nor the dating, and coverage §7 has already classed this exact row, by name,
as *"technique, restaurant and personality material of the kind beats 26, 36 and 37
explicitly reject"*. **Stop.** Re-deriving that verdict was worth the ten minutes it
cost, because the row is the single most plausible-looking one in the catalogue and it
is the one #226 exists to refuse.

### Beat 28 — Kansas City and Memphis as freight artefacts — **nothing**

`stockyard` **0**. `kansas` **1** — `this-american-life--443-amusement-park`.
`memphis` **1** — `the-war-on-cars--final-book-tour-dispatches`, hook *"Reports from
Atlanta, Memphis, Chicago, Montréal and more, plus reverse Copenhagenization"*, which
is a cycling-advocacy book tour.

**The freight half of the beat has plenty of tape and it is the wrong half.** The
catalogue holds a rail-history run — `the-roundhouse--civil-war-railroads` (*"How
railroads shaped Civil War logistics, with a rail-history society"*),
`the-roundhouse--canadian-pacific`, two `railway-mania` items,
`well-theres-your-problem--up-ns-merger` — and none of it touches food, let alone the
causal chain from a stockyard to a sauce recipe. Beat 28's reject line is *"best-of
restaurant lists"*; these rows fail earlier than that, on subject. Two of the four
American styles the founder explicitly required remain unsourced, which per the beat's
own coverage note is a gap to report rather than absorb.

### Beat 29 — the regional map is an economic map — **nothing, as designed**

By-design synthesis. The spine says *"if no tape makes the comparative argument, this
beat is narration, and it is one of the beats most worth narrating well"*, and coverage
§10e already finds it writable at the soft max. Nothing in the catalogue makes the
comparative argument across regions, and nothing was expected to. Recorded so the next
pass does not re-search it.

**Act IV verdict: zero of seven closable from this catalogue.** The act's prologue and
its whole regional stretch stay narration, and the five-consecutive-narration run at
beats 25 to 29 that the cut plan flags as an R6 breach is untouched by anything found
here.

---

## 4. Act I's mechanism beats, which is where the one real find is

### Beat 3 — the low-and-slow bargain — **one candidate, moderate confidence**

The beat wants *"a pitmaster or a food scientist naming the mechanism: collagen to
gelatin, connective tissue, rendering fat, the evaporative stall and what wrapping does
about it, Maillard and the bark"*, with the best case being *"a practitioner who
explains their own technique causally rather than as ritual"*, and rejects *"recipes,
temperature numbers with no reasoning, gear reviews"*.

**The mechanism vocabulary is absent from the catalogue's metadata entirely**:
`collagen` **0**, `gelatin` **0**, `maillard` **0**, `tenderness` **0**. That is a real
limit on how much a title-and-hook pass can promise here, and it is stated before the
candidate rather than after it.

**Candidate: `the-bbq-central-show--jess-pryles-is-not-here-to`** (3,967 s, released
2026-07-29). Title: *"Jess Pryles Is Not Here To Fu\*k Spiders!!"*. Hook: *"Jess Pryles
talks brisket science, BBQ myths, and the road to a $1M contest."* Tags: `barbecue`,
`bbq`, `grilling`, **`food-science`**, `competition`, `interview`.

**Why it is the best row in the catalogue.** It is the only item in 1,534 whose tags
carry both `barbecue` and `food-science`, and *"brisket science"* plus *"myths"* is the
one hook in the pool that promises mechanism rather than method — a myth about
barbecue is normally a claim about *why* something works, so the register is the
causal one the beat asks for. `grilling-beat-cut-plan.md` §3b reached the same row from
the other direction, naming beat 3 as *"the only empty beat for which this project's
own recommendation pool is on-brief"*.

**Confidence: moderate, and here is the honest downside.** Myth-busting can deliver a
beat's conclusion with none of its mechanism, which is precisely how SYSK's
tough-meat passage failed this beat at coverage §3. The hook's third clause — *"the
road to a $1M contest"* — points at a live competition thread that is not beat 3 and
is not beat 36 either, so an unknown share of a 66-minute broadcast is off-plot before
anyone reads it. I would put it at rather better than even that one legal cut states
the mechanism causally, and no higher.

**Second consideration, recorded because the beat is load-bearing.** If beat 3's cut
lands, this row does *not* also serve beat 37: `brisket` reaches only two items and
beat 37 needs *"brisket's price history and what changed it"* against a reject line of
*"technique interviews with no economics"*. A contest purse is not a price history.

### Beat 2 — smoke as preservation — **nothing that survives the beat's own test**

The beat rejects *"smoke-ring or bark chemistry with no preservation argument"* and
coverage §8's fourth finding sets the test in one line: **"The test is smoke. A source
that explains preservation *without* explaining what smoke does is not beat 2's
evidence, however good it is."**

`smokehouse` **0**, `biltong` **0**, `kipper` **0**, `curing` 1 (an immunotherapy
episode). The two rows that look like candidates both fail the test:

- **`gastropod--bringing-home-the-bacon`** (2,890 s), hook *"Why bacon was reviled for
  centuries before becoming America's favorite breakfast meat"*, tags `bacon`,
  `food-history`, `food-science`, `pork`, `culture`. Bacon is one of the three worked
  examples beat 2 names, and this is the only bacon episode in the catalogue, so the
  row deserves the paragraph rather than a line. It still fails: the declared subject
  is a **reputation** history — reviled, then beloved — and neither title, hook nor
  tags evidences smoke, water activity, the pellicle or the historical ordering. It
  fails beat 19 as well and for a second reason: beat 19 wants *"free-range and
  open-range husbandry, the corn-and-hog complex, seasonal slaughter before
  refrigeration"* in the colonial and antebellum South, and "from Shakespeare to the
  Baconator" is the wrong two continents and the wrong three centuries. **Stop**, and
  §7 records what would change that.
- **`gastropod--sushi`**, hook *"How sushi traveled from a fermented-fish preservation
  trick to gas-station counters worldwide"*. Preservation without smoke, which is the
  §8 test failing in its purest form. **Stop.**

Beat 2 stays the Carry that coverage §3 confirmed on the timed transcript, and its
dagger stays a food-science citation rather than a podcast.

---

## 5. Act V, because the catalogue's other real find lands there

### Beat 31 — refrigeration ended the necessity — **the one row that is already the plan's first pick**

**Candidate: `gastropod--refrigeration`** — *"The Birth of Cool: How Refrigeration
Changed Everything"*, 2,955 s, released 2024-06-11. Hook: *"How mechanical
refrigeration rewired what humans grow, ship, and eat."* Tags: `refrigeration`,
`food-science`, `food-history`, `technology`, **`cold-chain`**, `storytelling`,
`explainer`.

**This is the episode the ASR manifest already named**, in
`identified_not_yet_measured`, as *"The Birth of Cool: How Refrigeration Changed
Everything"* at an approximate 2,940 s. **The finding this pass adds is that it has
been sitting in `data/discover.json` the whole time**, with a real Apple track id, a
real enclosure URL and a duration of **2,955 s** rather than an approximation. §10
records what that does and does not license.

**Why it advances beat 31.** The beat's claim is *"the ice trade, then mechanical
refrigeration, refrigerated rail and finally the household fridge"*, and the hook
states the middle of that chain in the beat's own terms while the `cold-chain` tag
names the rail half. Beat 31's reject line is *"appliance history with no consequence
for food"*, and *"rewired what humans grow, ship, and eat"* is a consequence-for-food
framing rather than an appliance one.

**Confidence: moderate-to-good on the beat, with one specific reservation.** The
beat's *payload* is narrower than its subject: it wants *"specifically the consequence
for preserved and smoked foods — that they survived as tastes after their function was
gone"*, and the strong signal is *"a speaker who states the functional-to-decorative
transition outright"*. A general refrigeration episode may well never mention smoking.
So the realistic outcome is a cut that carries the mechanism and a Patch that supplies
the consequence — which still moves the beat off empty and still sheds a Carry.

**On register, and this is the reason to prefer it to the tape the report already
argues about.** Gastropod is two hosts working with named academic and industry guests
rather than two hosts working from an article, which is the distinction that put SYSK
in front of a founder. It is not the same call, and nothing here asks for it to be
re-opened.

**Blocked on two things, in order.** First **ad probes**: `dai_suspected` is `true`,
`audio_bytes` is `null` and the enclosure is a Megaphone file behind a Podtrac
redirect, so the byte method cannot size a pad and ADR-0008's N >= 2
decode-and-compare requirement applies. `grilling-foray-sourcing.md` §4 records
Gastropod as measured **PADDABLE** at +66.1 s and +32.7 s — but on a *different
episode*, and with the outstanding caveat that both probes were one client on one day.
Second **ASR**: `data/transcript-availability.json` records Gastropod at **0
transcripts on 293 episodes**, so there is nothing to read.

### Beats 34, 35, 36, 37, 39 — nothing

`briquette` **0**, `charcoal` **0** — so beat 34's gas-versus-charcoal split and beat
35's jar have no tape here. For beat 36, the two `competition`-tagged rows are
`the-bbq-central-show--jess-pryles-is-not-here-to` and
`the-bbq-central-show--pitmasters-contestants-connie-desousa-and-john`, and both are
current contests rather than the circuit's founding, the mechanics of the box or the
one-bite artefact; the beat rejects *"contest-day narrative with no argument"*. For
beat 37, see §7's sardine entry, which is the most interesting rejection in this
document.

---

## 6. The ranked sourcing proposal

**This is a sourcing proposal, not a transcription order.** Every row below still
needs the cheap checks first — ad probes where they apply, a transcript check before
any ASR — and nothing should be transcribed on this document's word alone.

| rank | row | beat it would serve | what it costs first | confidence |
|---|---|---|---|---|
| **1** | `gastropod--refrigeration` (2,955 s) | **31** — Act V chain hinge, empty, by-default open | N >= 2 ad probes, then ASR | **moderate-good** on the beat; lower on its payload clause |
| **2** | `the-bbq-central-show--jess-pryles-is-not-here-to` (3,967 s) | **3** — Act I chain pivot, empty, load-bearing | ad probe (the enclosure carries an `mgln.ai` prefix), then ASR | **moderate** |
| **3** | `the-bbq-central-show--cigar-wrapper-talk-with-mr-j` (3,776 s) | **no beat** — coverage §8's pending beat 27 amendment | ad probe, then ASR | **high** that it settles the amendment; **high** that it moves no beat |
| **4** | `the-bbq-central-show--steven-raichlen` (3,627 s) | **3**, second shot only | ad probe, then ASR | **low** — about one in four |

**Rank 3 is in the list on purpose and it is not a beat.** Coverage §8's first finding
recommends revising beat 27's German mustard trace to a disputed origin, on the
strength of Robert Moss saying on tape that he is skeptical of it, and it names this
exact episode as *"the place to check this before revising"*. The episode's title is
*"Cigar Wrapper Talk With Mr. J; Robert Moss Brings The Mustard Based TRUTH!!"* and its
hook is about cigar wrappers — so the Moss segment is a second-half item and the hook
is no guide to its length. **It will not move beat 27**, whose reason to belong is the
contested-custody half and which coverage §10e finds **unwritable**; a mustard-origin
segment does not touch custody. What it buys is a spine correction settled on the
Foray's own best available speaker, which the cut plan's §6a lists as pending. Ranked
third because a settled amendment is worth less than a closed beat and more than a
speculative cut.

**Rank 4 is conditional and should not be bought until rank 2 has been read.**
`the-bbq-central-show--steven-raichlen`, hook *"Barbecue Bible author Steven Raichlen
talks smoke, fire, and grilling technique on air"*, tags including `smoking` and
`technique`, is on beat 3's subject and coverage §7 has already classed Raichlen among
the technique-and-personality rows that beats 26, 36 and 37 reject. Beat 3 is the beat
that *wants* technique, provided it comes with mechanism, which is the only reason this
is a low priority rather than a stop — and the difference between it and the bacon row
in §7 is that Raichlen's declared subject is smoke and fire while the bacon row's is a
reputation.

---

## 7. Stops, and why each is a stop rather than a low priority

Coverage §9's own recommendation, arrived at after a seven-episode pass moved nothing:
**a row whose verdict is depth rather than rescue should be treated as "a stop, not a
low priority"**, because priority ordering is the wrong instrument for expressing "do
not buy this", and draining the tail of a correctly sorted queue is what cost 209
minutes of compute. Applied honestly, that makes most of this catalogue a stop.

| row | beat considered | why it is a stop |
|---|---|---|
| `the-bbq-central-show--grant-pinkerton` | 26 | Restaurant profile. Coverage §7 already names this row as what beat 26 rejects; §3 above re-derives it |
| `the-bbq-central-show--embedded-correspondents-july-2026` | 3, 36 | **Hour two of the same broadcast as rank 2** — `07282026_hourtwo.mp3` against `07282026_hourone.mp3` — and its hook, *"A two-hour BBQ double-header covers brisket secrets, myth-busting, and the road to the $1M World Cup"*, describes the **pair**, not itself. A hook that describes its sibling is not evidence about this episode. If rank 2 carries beat 3, this is depth on a beat that has just been carried |
| `the-bbq-central-show--pitmasters-contestants-connie-desousa-and-john` | 36 | Contestants on a television competition plus *"the economics of a premium cigar wrapper"*. Beat 36 wants the sanctioning bodies, the box and the one-bite artefact; its reject line is contest-day narrative with no argument |
| `the-bbq-central-show--sam-tours-japan-with-guests-ali` | 11 | Beat 11 is empty **by ruling on its source's language**, so an English Japan episode would not be barred — the reason this is still a stop is the hook, *"Four guests on the outdoor cooking business and ranking the ultimate fast-food burgers"*, which names a business discussion and a burger ranking rather than binchōtan, thrift or tare. Beat 11 is also a fan stop the cut plan drops, so the ceiling on its value is low even if it landed |
| `the-bbq-central-show--best-moments-meathead` | 3 | A nine-minute best-of reel of *"tips"*, which is beat 3's reject line almost verbatim. **It carries a lead worth more than the row** — §9 |
| `gastropod--bringing-home-the-bacon` | 2, 19 | Fails coverage §8's smoke test on its own metadata, and fails beat 19 on continent and century. §4 has the full reasoning. **One thing would change this**: if the founder rules the SYSK register out, beat 19 loses its only candidate and returns to empty, and this becomes the sole register-safe pork row in the catalogue — but it would still have to be read for antebellum Southern husbandry that its hook gives no reason to expect |
| `gastropod--sushi` | 2 | Preservation without smoke |
| `gastropod--salad-days-a-story-of-science` | 33 | Hook: *"How sexism and 'scientific housekeeping' turned salad into a strange, gendered category of food"*. This is beat 33's **claim shape** about a different subject — gendered food, not gendered fire. Beat 33 is the one unwritable empty beat in the spine and the cut plan drops it; admitting a salad episode to it would be inventing the beat's evidence out of an analogy |
| `odd-lots--how-a-sardine-gets-from-the` | 37 | The most instructive rejection here. Hook: *"Becca Millstein explains how canned sardines went from thrift-store staple to premium foodie obsession."* That is beat 37's claim — poverty food to luxury, stated outright — about the wrong food. It is a genuine economics interview and it would make the argument well. **Using it would be exactly the substitution the founder's rule forbids**, and a listener would hear a barbecue Foray explain barbecue's inversion with sardines |
| `hardcore-history--blitz-human-resources` | 20, 21 | §3 above. No cooking in five and a half hours |
| `the-moth--soul-searching-soul-food-and-the` | 20 | Title-only match; the hook corroborates no food content |
| `cbc-ideas--fear-of-fire` | 1 | Hook: *"Author John Vaillant on how fire shaped humanity — and how we're now reshaping fire."* Wildfire and climate, not cooking. Beat 1 is strong and deliberately capped at two segments in any case |
| `engines-of-our-ingenuity--the-engines-of-our-ingenuity-1615` | 5 | *"A short history of why humans took so long to learn to burn coal well"*, four minutes, industrial fuel. Beat 5 is strong |
| `the-roundhouse--civil-war-railroads`, `the-roundhouse--canadian-pacific`, `railway-mania--*` (2), `well-theres-your-problem--up-ns-merger`, `the-war-on-cars--final-book-tour-dispatches` | 28, 29 | Freight and rail history with no food in it |
| `criminal--125-acres`, `amicus-dahlia-lithwick--by-the-people-for-the-children`, `5-4-podcast--250-years-of-bad-decisions-scotus-the-civil-war-and-the-end-`, `lex-fridman-podcast--499-gary-gallagher-american-civil-war`, `99-percent-invisible--mosquito-hawks`, `the-ancients--how-slavery-built-the-roman-empire` | 20, 21, 22, 24 | American slavery, Reconstruction and Civil War history without food. Beats 21, 22 and 24 are already strong on a historian's own argument, so even a good row here would be depth |
| `The Allusionist` (show, 8 items) | 16 | Right register, no episode on the word |

**Every row above stays in `data/discover.json`.** Several are strong recommendations
for other subjects — the sardine economics, the Vaillant fire interview, the
Reconstruction legal history — and nothing in this document proposes removing any of
them from anything. They are labelled as not serving this Foray, which is all that a
coverage judgement is.

---

## 8. What two closed holes do to the cut plan, computed

`grilling-beat-cut-plan.md` §3a derives the exchange rate — *"One hole closed is worth
about two segments bought anywhere else"* — and its formula for closing `m` holes off
the stage-one 31-beat Foray is `narration = 1,484 − 73m` against
`tape = 2,737.4 + 180m`. Both catalogue candidates aim at empty beats, so they buy at
the better rate. Re-derived here rather than cited:

| holes closed | narration | tape | runtime | narrator share |
|---|---|---|---|---|
| 0 — today | 1,484 s | 2,737.4 s | 70.4 min | **35.15 %** — over the hard ceiling |
| **1** — beat 3 *or* beat 31 | 1,411 s | 2,917.4 s | 72.1 min | **32.60 %** |
| **2** — beat 3 *and* beat 31 | 1,338 s | 3,097.4 s | 73.9 min | **30.17 %** |
| 5 — what the target needs | 1,119 s | 3,637.4 s | 79.3 min | 23.53 % |

**So the catalogue can buy the ceiling and cannot buy the target.** One closure takes
the 31-beat Foray under 35 % with every chain link intact; two take it to about 30 %;
the 25 % target needs five and the catalogue holds two. The 22-beat plan's nine
chain-link cuts are not bought back by anything found here — including **beat 29**,
the one beat the spine explicitly forbids cutting, which stays cut.

**The table reproduces the cut plan's own figure where the two overlap**, which is the
check worth having: at five closures it lands on 79.3 minutes and 23.5 %, which is
§3a's published result to the digit. The rows above and below it are the same
arithmetic run at m values §3a did not publish.

**Three caveats, all pointing the same way.** The 180 s per closure is the cut plan's
own generous assumption at the top of the tape band; at the 75 s floor a closure buys
less than half as much. Both closures are moderate-confidence, not certainties, and a
Foray that plans on both and gets one lands at 32.6 %. And beats 3 and 31 are already
two of the four Carries the 22-beat plan funds, so closing them improves that plan's
arithmetic without adding a beat to it — the gain shows up in the 31-beat version,
which is the version that keeps the chain.

**What no amount of this buys.** Both closures are outside Act IV. The act's
five-consecutive-narration run at 25 to 29, which breaks the two-item consecutive cap
in the act the spine calls the most dangerous place for a hole, is exactly as broken
after this pass as before it.

---

## 9. Leads that are not rows, recorded so nobody invents metadata for them

The manifest's own convention is that inventing a guid or an enclosure URL is how the
wrong episode gets registered. These three are named without metadata for that reason.

1. **Meathead Goldwyn on The BBQ Central Show.** The only trace in the catalogue is
   `the-bbq-central-show--best-moments-meathead`, a nine-minute reel, hook *"A 2019
   flashback: Meathead recaps the NBBQA and shares tips that might get you lucky"* —
   a stop as a row. But Goldwyn is the author of the barbecue **food-science** book,
   which makes a full-length episode with him the best-shaped candidate for beat 3
   anywhere in this project's records, better than either row in §6. The feed is
   already known to the project and known to publish transcripts on 12 of 1,858
   episodes. **Check the feed for a full Goldwyn episode before buying rank 4.**
2. **Gastropod's smoke episode.** `grilling-foray-sourcing.md` §4 lists, in its
   *rejected* table, Gastropod's *"Where There's Smoke, There's… Whiskey, Fish, and
   Barbecue!"* — rejected on a **bitrate-implied 1.080** that the same section's
   header now says is superseded, on a show ADR-0008 has since measured as PADDABLE.
   Smoke, fish and barbecue in one title is beat 2's shape, and fish is one of beat
   2's three named worked examples. It is not in `data/discover.json`, so it needs a
   feed fetch to become a row. **This is the same stale-rejection mechanism the
   manifest already caught once on this show**, where the refrigeration episode sat
   under "already being transcribed", which is a workstream note and not a rejection.
3. **The History of American Food, episode 068.** Also from
   `grilling-foray-sourcing.md` §4, kept on file as ad-free at **1.000** across 221
   episodes, including *"068 Wood Part II — Charcoal, BBQ & Mellowed Spirits"*.
   Charcoal reaches **zero** items in the catalogue, and beat 34's charcoal-versus-gas
   split has no tape at all. Ad-free means no probe and no locate step, which makes it
   the cheapest unread lead in this document. Not in `data/discover.json`.

---

## 10. Three discrepancies found in passing, none of them this document's to resolve

**1. The manifest asserts a founder ruling on the SYSK register that no other document
records.** `grilling-asr-manifest.json` lists Stuff You Should Know under
`excluded_by_instruction` as *"EXCLUDED on the register"*, and its
`read_this_before_spending_cpu.spend_this_first` says *"and then the founder ruled the
register out"*. But `grilling-history-coverage.md` §2b says *"whether a show of this
register belongs in this Foray at all is a founder call, not mine"*, its §9 item 9
lists ruling on it as pending, `grilling-beat-cut-plan.md` §5 treats it as *"not a
sensitivity, it is a dependency"* still awaiting an answer, and **`docs/DECISIONS.md`
records no such ruling**. One of those is wrong and the difference is four beats and
491.3 s of tape. **Left as found**: this pass does not know which, and guessing would
be worse than reporting. The manifest rows are annotated, not rewritten.

**2. The BBQ Central Show's show-level exclusion is a workstream note, not a content
rejection, and it now hides five scoreable rows.** The manifest excludes the show
because it is *"already being transcribed by the American-arc workstream"* and notes
that only one of its 1,858 episodes was on plot. `data/discover.json` now holds
**eight** BBQ Central episodes, and §2 above scores five of them against specific
beats — one of which is the best beat 3 candidate in the pool and one of which
settles a pending spine amendment. This is precisely the correction the manifest
itself made for Gastropod: *"Previously sat in excluded_by_instruction as 'already
being transcribed', which is a workstream note, not a rejection."* Same mechanism,
same show-level shape, second occurrence.

**3. `identified_not_yet_measured`'s Gastropod row can be sharpened without being
promoted.** Its comment says *"Measure, then promote to a real row"*, and nothing here
measured anything: no audio was fetched and no probe was run. What this pass can
supply is metadata **sourced from `data/discover.json` rather than invented** — the
Apple collection and track ids, the enclosure URL, and a duration of 2,955 s against
the row's approximate 2,940 s. The row stays in `identified_not_yet_measured` with
`blocked_by` changed from `needs-asr` to `needs-ad-probes`, because
`dai_suspected: true` with `audio_bytes: null` means the byte method cannot size its
pad and ADR-0008 requires two decode-and-compare probes of the same episode first.

---

## 11. What changed in `grilling-asr-manifest.json`, so the two files can be checked against each other

**The headline is not the new rows. It is that the queue was already empty.** All nine
episodes that ever carried a priority have now been transcribed — two on 2026-08-17 and
seven on 2026-08-18 — so `queued_episodes` is **0** and there is no ASR work left in
that file at all. That is why this pass searched the catalogue instead of re-sorting the
work order, and it is the checkable version of "the manifest is exhausted".

- **`revision_2026_08_18`** and **`stop_convention`** are new, and the second one is the
  previous round's recommendation turned into a field: `stop: true` with
  `blocked_by: "stop"` means do not buy this row, and `blocked_by: "spent"` means it has
  already been bought. **All twenty-four rows in `episodes` now carry `stop: true`**, nine
  as spent and fifteen as barred, beatless or superseded.
- **Each of the nine spent rows gained an `outcome`** recording what it actually moved.
  Eight of the nine moved nothing, and each one's `outcome` says so in the terms its own
  `why_this_priority` used, so the queue's cost can be read against what it bought:
  **19,344 s of audio, about 11 CPU-hours at the observed rate, five beats, all from one
  episode.**
- **`totals`** is recomputed, with `by_priority` kept and marked superseded rather than
  deleted, per the scorecard convention the coverage report uses.
- **`identified_not_yet_measured` gained three rows and one was sharpened.** The three
  are the BBQ Central candidates; the sharpened one is Gastropod's refrigeration episode,
  which keeps its place in that block because **nothing here measured anything** — the
  rule is "measure, then promote to a real row", no audio was fetched and no probe was
  run. Its metadata is marked `metadata_source: "data/discover.json … not a feed fetch"`
  for the same reason, and its `blocked_by` moved from `needs-asr` to `needs-ad-probes`
  because the ad work now demonstrably comes first.
- **`catalogue_search_2026_08_18`** is new and carries the machine-readable residue: the
  pool, the instrument, the measured substring trap, the Act IV zero counts, the sixteen
  stops with reasons, the three leads that are deliberately not rows, and the three
  discrepancies of §10 left as found.
- **Nothing was deleted.** No row left the manifest, no episode left
  `data/discover.json`, and the two paragraphs this document disagrees with — the SYSK
  register ruling and the BBQ Central workstream exclusion — are annotated rather than
  rewritten.
