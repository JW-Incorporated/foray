# Coverage report — the history of barbecue (`grilling-history-1`)

Stage 2 of #226. The spine (`docs/curation/grilling-history-spine.md`, 40 beats in
five acts) was written source-blind by stage 1. This document scores the available
tape against it, beat by beat and independently, and reports where the tape fits
the spine — including, at length, where it does not.

**Status:** proposed. This is a coverage report, not a playlist.

**Revised 2026-08-17** against two newly transcribed episodes — §2c is the entry point
for what changed, §5 carries the revised Act IV verdicts, and §5b records what the
assembly could actually play. Counts moved from 6 strong / 10 thin / 24 empty to
**11 / 9 / 20**. Unlike the first pass, this revision *did* touch
`data/forays.json`: beats 21 and 22 are now played by `grilling-history-2` as `GC-1` and
`GC-2`, which is recorded in `grilling-history-assembly.md` §2. That Foray stays
`draft`; publishing is a founder action.

---

## 1. The rule this document was written under

From the founder, on #226:

> "if we have content that is irrelevant, don't distort the narrative just to use
> more podcast content. Keep it mostly on topic"

Operationally: a segment earns its place by advancing the claim of the beat it is
assigned to, not by being about food, history, cooking or barbecue. Good tape that
does not advance its beat is rejected. A beat that comes back empty stays empty.

Three consequences that shaped the work, and the second one is the one a reader
should hold on to:

- **A beat is covered by one strong segment.** §4a of the spine derives a cut
  budget of about 75 segments for a 150-minute Foray, so hunting four candidates
  per beat is not diligence — it is the mechanism that manufactures fill pressure.
  Each beat below records the best candidate and, where one exists, a credible
  alternate. Beat 1 had three candidates and is deliberately capped at two.
- **"Thin" does not mean covered.** #226 dropped "mostly-related" as a tier to
  fill from. A thin beat is a **narration beat** that happens to have a partial
  supporting cut available. Stage 4 must not read thin as green. Every thin verdict
  below states what is missing so that the narration can supply it.
- **Label, never exclude.** Rejected segments stay in `data/segments.json` for
  playlists. §7 lists every rejection with its reason. This document labels what
  serves this Foray; it prunes nothing.

## 2. What "available" turned out to mean

The material that can actually be scored at beat level is smaller than the
catalogue suggests, and the shape of it explains most of this report.

| Source of material | Count | Scoreable at beat level? |
|---|---|---|
| Segments in `data/segments.json` on grilling subjects | 36 (32 of them in the current `grilling-history-1`) | Yes — `why` plus verbatim in/out anchors |
| Playable source episodes in `data/segment-sources.json` | 9 English grilling episodes | Only where a transcript can be read |
| Publisher transcripts readable today | **2 of the 9** — `bbqc-moss-school` (timed SRT), `moreish-jerk-jamaica` (plain text) | Yes, fully |
| Readable transcripts outside the 9, found in this pass | 1 — `Stuff You Should Know — A Lip-Smacking Look at Barbecue` (timed WebVTT, 3,052 s) | Yes, fully — see §2b |
| Anchor-validated passages in `grilling-foray-passages.json` | 8 (501 s), never merged into the pool | Yes, as documented candidates |
| Episodes in `grilling-asr-manifest.json` | 24, of which **none** is transcribed | No — content unverifiable at beat level |

Three facts about this table do most of the work below.

**The local ASR transcripts are gone.** All 36 grilling segments carry
`transcript_source: "asr-local"` (9 of the 62 in the pool are `"publisher"`, all of
them on the capital Foray's episodes), and the main checkout's gitignored
`data-local/` holds no `.asr.json` — only the engineering research corpus. So for
seven of the nine source
episodes I can score the cuts that exist but cannot make new ones, because I
cannot see the words between them. That is a real ceiling on this pass and it is
worth fixing before stage 4: the same episodes would yield better cuts if they
were re-transcribed, and `bbqrn-argentina-open-fire` in particular is likely
under-cut for beat 14.

**Two transcripts are readable, and both were worth reading.** `bbqc-moss-school`
publishes a `<podcast:transcript>` SRT, which I fetched and read end to end. Its
time base matches the existing ASR cut points, checked three ways: `#2941`'s
start-anchor phrase begins in the cue at **2941.51** against a recorded
`start_sec` of 2941.37, a difference of 0.14 s; and the out-anchor phrases of
`#1881` and `#3315` begin at **1944.65** and **3395.68** against recorded
`end_sec` values of 1947.55 and 3398.97, roughly 3 s earlier in each case, which is
what the remainder of each anchor sentence occupies. So cuts proposed against this
SRT are safe to mint. Only the 2537–3441 s band is on plot; the first hour is
hot-dog-eating coverage, knives and griddle gear.
`moreish-jerk-jamaica` publishes an untimed plain-text transcript, enough to
confirm what the two existing cuts contain but not to time new ones.

**A note on the quotations below.** Everything quoted from `bbqc-moss-school` comes
from a machine transcript and is lightly cleaned for punctuation and obvious
recognition errors. The wording is indicative, not verbatim, and anyone writing
narration against it should listen to the audio at the timestamp given. The
`moreish-jerk-jamaica` transcript is publisher-edited prose and its quotations are
exact.

**Nothing new was sourced in this pass, deliberately.** The catalogue-broadening
pass already searched 4.71M feeds (`docs/curation/catalogue-broadening.md`), and I
re-ran only targeted checks against the recommendation pool and the source feeds for
the beats that looked empty, so as not to under-report coverage.

### 2a. Three tiers of empty, and the difference matters

`docs/adr/0008-ad-tolerance-and-timestamp-precision.md` (2026-08-16) removed the ad
gate that several earlier "unsourceable" verdicts rested on, and its §"what this
unlocks" table re-scores the arc slots. So an empty beat in this report means one of
three quite different things, and a reader should not read them as equivalent:

- **Unsourceable.** No source exists at any budget. After a 4.71M-feed search this
  is true of **braai** and **Filipino lechon** only, and `docs/DECISIONS.md` confirms
  both survive ADR-0008. These are answers, not gaps.
- **Identified but not playable yet.** A source exists and is named in ADR-0008's
  unlock table, and it is blocked on ad measurement, on the locate step, or on
  transcription — not on availability. **Tandoor is in this tier now, not the
  unsourceable one**: the earlier verdict turned on the ad gate and ADR-0008 reverses
  it. So is the core of Act IV.
- **Empty under the English-only ruling.** A source exists and is not in English.
  `docs/DECISIONS.md` records the English-only ruling (Wyatt, 2026-08-16) together
  with the narrator ruling: a non-Anglophone tradition is *described in English*
  rather than shipped as non-English tape. This is decided, not pending, so beats in
  this tier are permanently narration beats for this Foray.

Where a beat is empty for one of these reasons rather than another, the beat says so.

### 2b. A third readable transcript, found late, that changes four verdicts

A review pass on the first draft of this report pointed out that ADR-0008's
LOCATE-REQUIRED tier means *authored, not played* — extraction proceeds, and playback
waits for the locate step. Checking that against
`data/transcript-availability.json` turned up something the first draft had missed:
**Stuff You Should Know ships timed transcripts on 2,850 of its 2,858 episodes**, and
one of them is `A Lip-Smacking Look at Barbecue` (3,052 s), named in ADR-0008's
arc-slot notes against the American arc slot. I fetched the WebVTT and read it end to
end. It is the third readable transcript in this pass, and the only readable source
that reaches the **core** of Act IV — `bbqc-moss-school` is readable and reaches beats
23 and 27, but nothing in it touches beats 16 to 22.

**Two caveats have to travel with every cut proposed from it, and the second is the
one a human has to rule on.**

- **It is LOCATE-REQUIRED, so nothing from it plays yet.** SYSK measures +8 to +10
  minutes of ad insertion, far past ADR-0008's 120 s padding ceiling, so cuts are
  authorable now and playable once the locate step exists. Timestamps below are
  against the publisher's own transcript timeline.
- **It fails the content gate this project has applied to other shows, and the report
  does not pretend otherwise.** SYSK is two hosts working from a HowStuffWorks
  article, with no guest and no sourced expertise — the same register that got
  Gurmelik Denemeleri rejected for mangal ("hosts riffing with no sourced
  expertise"), and the same register `catalogue-broadening.md` §3 rejects repeatedly.
  It is loose where it matters: it has Columbus meeting the Taíno and de Soto both
  bringing pigs and reporting *barbacoa* back to Europe, it dates the first North
  American barbecue to Tupelo in 1540 on a "supposedly", and it drops a 200,000-year
  Israeli site into the same breath. It also contains, twenty seconds after its
  Jim Crow segregation passage, the line that barbecue "kind of transcends race and
  class" — which is the harmony version beat 23 exists to reject.

**A third caveat, smaller but practical.** SYSK's transcript is machine-generated and
undiarized — one speaker label throughout, "Annabellum" for antebellum, "melb J" for
LBJ, "booie" for buoy — so the same rule stated above for `bbqc-moss-school` applies:
quotations below are lightly cleaned and indicative, and the in-anchors preserve the
garbles because that is what an anchor check would match against.

**So the honest reading is that SYSK is admissible on relevance and weak on
authority.** Every cut below is graded **thin** and none is graded strong, however
squarely it hits its beat, and each would carry `confidence: low`. Where the beat's
own reject criteria exclude it, I have excluded it — beats 3, 16, 18 and 23 — rather
than taking the tape because it was the only tape. **Whether a show of this register
belongs in this Foray at all is a founder call, not mine**, and it is worth making
explicitly, because the alternative to these cuts is narration beats carrying the same
facts stated better.

**What it moves.** Seven cuts across seven beats. Four verdicts go from empty to thin —
**7, 19, 24 and 30** — which takes Act IV from thirteen empty beats to ten. Beat **6**
gains a short cut that states its economics, without changing its verdict. Beats **5**
and **32** gain second segments that close gaps narration would otherwise have had to
fill; note that if the register is ruled out, beat 5's availability-determines-tradition
clause and beat 32's briquette origin both go back to narration even though the beats
stay strong.

### 2c. Two ASR transcripts arrived, and one of them is the answer to Act IV

**Revision, 2026-08-17.** §9's items 1 and 4 were acted on: the two English episodes
this report named as the best unread candidates for the core of Act IV were
transcribed locally (`base.en`, word timestamps, measured drift −0.12 s median with
100 % inside 2 s, so anchor text plus timestamp is trustworthy at the tolerances
`ADR-0007` sets). Both were read end to end and scored beat by beat. **They did not
come back the same way, and the difference is the useful part of this revision.**

| Episode | Length | Ad status | Verdict |
|---|---|---|---|
| `The Grill Coach — Adrian Miller and The History of BBQ` | 3,306 s | ad-free, ratio 1.0; range-probed 206 with declared bytes exactly matched | **Six segments, five beats.** Moves 18, 21, 22 and 38 off empty and upgrades 24 |
| `The Moreish Podcast — Caribbean Food History with Dr. Candice Goucher` | 3,466 s | not measured; moot | **Nothing. No segments cut.** See §5, beat 20 |

**The Grill Coach delivers, and it delivers exactly where §9 predicted.** Miller is
named in the spine itself as the archetype of the register the authorship beats want,
and the episode's second half is a 37-minute interview in which he makes his argument
rather than being asked to summarise his book. It is the first source in this whole
pass that reaches beats 21 and 22 at all. Four things make it unusually easy to cut
against:

- **It is ad-free at ratio 1.0**, so it needs no locate step and no padding — the
  constraint that keeps SYSK unplayable does not apply. Nothing here is
  authored-but-unplayable.
- **The interview is a single unbroken block**, 937 s to 3,180 s. The house promo and
  the patron read are both in the first fifteen minutes (888–935 s), so no cut in
  this pass opens or closes near a read (`ADR-0008`).
- **The host chat is separable rather than interleaved.** The first fifteen minutes
  are the hosts' own weekend cooks, a listener question about garlic rub and a grilled
  potato salad. None of it is on plot, and none of it is inside the interview, so
  rejecting it costs nothing and required no judgement.
- **Miller is doing history out loud**, including the parts that cut against a tidy
  story: he opens the transmission answer with "not everybody agrees with this",
  and he declines the "these cooks have never been celebrated" framing on the evidence
  of his own newspaper research. That is the register beats 18 and 22 ask for, and it
  is what separates this tape from the SYSK passages the beats rejected.

**One caveat that travels with every quotation below.** This is a `base.en` machine
transcript and the wording is indicative, not verbatim; anyone writing narration
against it should listen at the timestamp given. The anchors, by contrast, are exact
against that transcript by construction — all six merged through
`merge-segments.mjs`, which verifies both anchors as whole-word subsequences and
rejects rather than repairs. Six authored, **zero rejected, zero flagged for
review**.

**What it moves.** Beats **18**, **21**, **22** and **38** go from empty to
**strong**, and beat **24** goes from thin-on-SYSK to **strong**. Beat **16** gains
material and stays **empty**, on its own criteria. Beat **30** gains material and
stays **thin**, on its own criteria. Those last two are in §5 and they are not
formalities — §5a explains why.

---

## 3. Act I — fire, smoke and the mechanism (chain, beats 1–5)

### Beat 1 — cooking is external digestion — **strong**

**Chosen:** `origin-stories-cooking-human#147` (147.20 → 299.70, 153 s).
In on *"Richard was Rachel's advisor at Harvard and they've worked together"*;
out on *"have been way better equipped for a raw food diet."*

**Second:** `origin-stories-cooking-human#678` (678.09 → 763.77, 86 s).
In on *"We remain very puzzled by the fact that you will"*; out on
*"of food supply that is made possible by cooked food."*

**Why it advances beat 1.** `#147` is the causal argument in the form the beat asks
for — cooked food raises energy return, and the consequence is visible in anatomy:
smaller teeth and guts, chimpanzees chewing up to six hours a day against our one.
`#678` is the better half of the pair for the beat's own standard, which prizes tape
that names the disagreement over tape that asserts the tidy version: it says
outright that controlled fire is hard to prove and puts Wonderwerk Cave against the
anatomical timeline. Together they are the claim and the contest over the claim.

**Capped deliberately.** `origin-stories-cooking-human#448` (447.62 → 629.00, 181 s
— raw-food diets suppressing ovulation, and the two ways cooking frees energy) is a
third strong candidate and is held as the **alternate**, not added. §5 of the spine
predicted beat 1 would be over-supplied and it is the only prediction of over-supply
that held. Three segments on the opening beat is how a Foray starts bloating.

### Beat 2 — smoke was preservation before it was flavour — **thin**

**Only candidate:** the preservation passage inside
`moreish-jerk-jamaica#266`, which states the historical ordering explicitly —
salt was not reliably available, so wood ash substituted for it, and *"historically
we've seen smoke as another form of preservation."*

**Why this is thin and not strong.** The candidate is already the carrier of beat
15, and it must stay there: it is the seam beat and this is its core content.
Double-cutting one passage across two beats would put the same voice making the same
point twice in a 150-minute programme. Treat beat 2 as a narration beat.

**What is missing.** The mechanism, which is the whole of the beat: water activity,
the surface pellicle, the antimicrobial and antioxidant action of phenols and
organic acids, and why salt plus smoke plus drying do together what none does
alone. Also missing are the worked examples the beat asks for — biltong, bacon,
kippers — and the distinction between drying, pounding and smoking that separates
pemmican from *boucan*. No tape in the pool contains any of it.

### Beat 3 — low and slow is a specific chemical bargain — **empty**

**Nothing.** The nearest candidate is
`bbqrn-argentina-open-fire#2018` (a brisket over open fire taking nine hours, a
fifty-pound pig five), and it is durations without a mechanism, which is exactly
what the beat says to reject.

**Chain hole, and a load-bearing one.** Slowness is the pivot of the whole
through-line — it is what forces the crowd (beat 6), the labour (beat 21) and the
vigil beat 39 interrogates. With beat 3 empty, the Foray asserts that barbecue is
slow without ever explaining why, and every later beat that depends on the
explanation is weaker.

**Also considered and rejected.** SYSK (§2b) has, at 607–617 s, the observation that
tough lean meat has to be cooked over low heat for a long time to become tender. That
is the beat's *conclusion* with none of its mechanism, and the passage is committed to
beat 19 in any case.

**What is missing.** Collagen converting to gelatin, the two clocks the cook runs at
once, the evaporative stall and what wrapping does about it, Maillard and the bark,
why smoke deposits on a moist surface. §5 predicted this beat would be
**over-supplied**. It is empty — see §7.

### Beat 4 — two technologies, one word — **strong** (on a proposed new cut)

**Chosen — a new cut, not yet minted.** `bbqc-moss-school`, **3106.36 → 3215.23
(108.9 s)**. In on *"At that time, there was 1 American Barbecue restaurant called
Bow"*; out on *"but that's about the extent of the barbecue there."* Anchors and
timings read off the publisher's own SRT, whose time base is confirmed to match the
existing cuts from this episode.

**Why it advances beat 4.** Robert Moss, a barbecue historian, makes the beat's
central observation from direct observation rather than from a definition:
American-style barbecue is now everywhere in London *"though it's not what we might
quite recognize as barbecue"*, and *"by and large, if you're seeing Barbecue,
they're talking grilling."* That is the beat's claim — the usage split follows
dialect rather than technique — stated by someone who has no stake in winning the
argument. He then supplies the concrete instance: a Thames-side venue called a
barbecue club whose menu is burgers, kebabs and chicken sandwiches. Claim plus
instance in one 109-second span, dead centre of the target band.

**Why I did not mint it.** `check-forays.mjs` documents `data/segments.json` as a
pool that `merge-segments.mjs` both writes and validates, and that "nobody may
hand-edit". Minting properly means running the merge tool with the transcript body,
and the anchor normalisation in this pool is ASR-derived (lower-cased, unpunctuated)
while mine is SRT-derived — mixing the two conventions into the pool by hand is how
a later anchor check fails for a reason nobody can find. The cut is specified above
precisely enough for stage 4 to mint it through the tool. Everything in this PR is
therefore docs-only.

**Alternates, if the new cut is not minted.** `bbqc-moss-school#3315` (3314.93 →
3398.97, 84 s — Britain's flagship barbecue book still explaining what charcoal is,
"fifty years behind us") is the same speaker in the same passage, and it carries
adoption lag rather than the dialect split, so it is the weaker read of the beat.
`bfh-18c-tavern-briggs#2011` (2011.18 → 2085.90, 75 s — broiling is the older
English word for grilling, Americans kept it and the British dropped it) is the
second alternate and **the only `bfh-*` segment in the pool that survives this
report's gate**. It advances one clause of the beat honestly: fire-cooking
vocabulary diverged by dialect rather than by technique. It is a weaker fit than
the Moss cut because the beat is about *barbecue's* two technologies, not about a
different word pair, and I record it as an alternate rather than a carrier for
exactly that reason.

### Beat 5 — fuel is the independent variable — **strong**

**Chosen:** `bbqrn-argentina-open-fire#1437` (1437.48 → 1516.54, 79 s).
In on *"And from a cooking perspective, Al, what woods work best"*; out on
*"that cold bed. So something like a good solid oak."*

**Why it advances beat 5.** Al Frugoni, an Argentine asador, is asked which woods
are best and answers against the grain of the question: for open fire the wood
matters less for flavour than for how long its embers last. That is a practitioner
explaining what a fuel does and why, mechanically, and comparing fuels on a
property rather than praising one — which is the beat's stated preference — and it
actively refuses the flavour poetry the beat says to reject. At 79 s it is at the
bottom of the target band, which suits a hinge beat that hands into the fan.

**Second, from SYSK (see §2b):** **1313.12 → 1358.12 (45.0 s)**. In on *"good advice,
But starting out, if you want to talk barbecue"*; out on *"apparently fruit wood is
good for things like chicken and seafood."* This is
the one thing §5 of the spine predicted no tape would contain — **the rule stated
outright**: hickory in the South, mesquite in Texas, *"and most of these regionally
were used because that obviously was the wood they had near there."* Availability
determining tradition, in one clause. At 45 s it is a short supporting cut, above the
30 s floor and below the target band, and it carries §2b's authority caveat.

**Note against §5's prediction, revised.** The spine ranked this beat eighth-hardest
on the reasoning that partial tape from many traditions would exist but tape stating
the rule would not. With `#1437` supplying the mechanism from inside a tradition and
the SYSK cut supplying the rule across traditions, the beat is carried and narration
owes it nothing. That is the prediction most clearly falsified in the optimistic
direction.

---

## 4. Act II and Act III

### Beat 6 — a whole animal needs a crowd — **thin**

**Candidate:** `bbqrn-argentina-open-fire#700` (699.72 → 848.26, 149 s — asado is
not a meal but a way of living, a four-to-six-hour party, every occasion). In on
*"Can you kind of give a high level of what"*; out on *"charcoal everywhere, like
parisias are cooking every night down there."*

**Why thin.** It establishes the occasion — the hours, the gathering, the fact that
this is a social form and not a cooking method — which is the beat's conclusion. It
does not contain the beat's argument, and the segment is also beat 14's best second
cut, so admitting it here competes with Act III.

**A better candidate for the argument, from SYSK (§2b):** roughly **1061 → 1097
(36 s)** states the economics the beat is actually about — slaughtering a pig was a big
deal, they used everything from snout to tail, *"so you had a lot of stuff and it was
way more than your family was going to eat. So it was an occasion for the whole
community, or at least all the neighbors, to be invited over"* — and it names the
consequence: that is where barbecue being a social gathering came from. Beat 6 says to
reject *"generic 'food brings people together' sentiment with no economics under it"*,
and this has the economics under it. At 36 s it is barely over the floor, so the useful
shape is probably this as a short cut ahead of `#700`, or its content folded into
narration.

**What is still missing.** Fuel and labour arithmetic for a whole carcass, the
explicit pre-refrigeration framing, and why the feast *is* the storage technology when
you cannot preserve everything. Beat 6 is the load-bearing middle term of the
through-line and it is still better narrated than assembled from two partial cuts.

### Beat 7 — feeding a crowd is a claim to authority — **thin**

**Candidate, from SYSK (see §2b):** **2278.08 → 2415.92 (137.8 s)**. In on *"That's
good stuff. Um. Politics has often has long been linked to barbecue"*; out on *"I want
you to sign this bill."*

**Why it advances beat 7.** It is the beat's American case with named specifics and,
more importantly, with the reciprocity claim stated rather than implied: politicians
found that a good way to get a lot of people together and talk to them was to promise
them food, and the hosts name it *"almost bribe them, both food and booze."* Beat 7
says the claim to look for is *reciprocity or obligation — the crowd owes something
for the meat*, and that is exactly what this says. It supplies the Fourth of July as
a barbecue-and-Declaration occasion, Daniel Webster's two-hour speech at a St. Louis
barbecue in 1836, William Henry Harrison campaigning the same way, and Lyndon
Johnson's "barbecue diplomacy" at the ranch — VIPs invited, and a bill to sign.

**What is missing.** Everything before America, which is most of the beat: sacrifice
and distribution in the ancient Mediterranean or Near East, hospitality obligation,
aristocratic patronage through meat. Beat 7 exists so that the power clause arrives
*before* the American act, and a cut consisting entirely of American electioneering
does not do that. Used as-is it would need narration ahead of it establishing the
pattern, and it will sit oddly early if it is 19th-century American material placed
before beat 8's fan.

**Rejected here:** `bfh-medieval-meals-manners#944` (rank at a medieval table measured
in distance from the salt cellar) is hierarchy at a dinner table, and beat 7 says in
terms that *"a lavish dinner party is not this beat."* This is precisely the boundary
the previous Foray crossed.

### Beat 8 — the steppe as the control case — **empty** (fan)

**Nothing**, and §5 predicted it. The recommendation pool's only steppe material is
`Fall of Civilizations — The Mongols: Terror of the Steppe (Part 1)` (241 min), which is
military and political history with no cooking in it. Rejected without further
checking, because the beat wants khorkhog, boodog, hot-stone cooking, dung and
scrub as fuel, and the Taipei provenance of the restaurant format.

**Fan hole — comparatively safe**, but this is the fan's control case, the one
tradition where the answer is neither a grill nor a pit, so losing it costs beat 5
its sharpest piece of evidence. Worth narrating rather than dropping.

### Beat 9 — the skewer family — **thin**

**Candidate, documented not minted:** `satay-okay-e01-satay-myth` 735.8 → 815.6
(80 s), recorded in `docs/curation/grilling-foray-passages.json` with anchors
already validated against a fetched transcript by the earlier pass. In on *"so many
Malaysians and Southeast Asians and Asians in general are so obsessed with food"*;
out on *"wherever humans have gone, they've probably put meat on a stick."*

**Why thin, and note which half survived.** This carries the beat's satay content —
three rival origin theories, and the point that skewered meat is close to universal,
which is the observation the beat's family rests on. It does not carry the beat's
root. **§5 predicted the inverse**: that the kebab material would exist and the
satay half would not. It is the other way round.

**What is missing.** The whole Ottoman and mangal root: the mangal as equipment and
as an occasion, the regional codification of named kebabs, charcoal management along
a narrow fire, the vertical spit and its 1970s German reinvention.

**Status of the root, stated precisely.** `grilling-asr-manifest.json` and
`catalogue-broadening.md` §4 record mangal/kebab as unsourceable after the 4.71M-feed
search, the one candidate having failed the *content* gate — hosts reminiscing, no
sourced expertise. ADR-0008 then adds one ad-gated candidate that the old gate had
excluded: The Delicious Legacy's "Kokoretsi: The Ultimate Easter Kebab!", now
authorable but **LOCATE-REQUIRED**, and the ADR cautions in terms against
over-claiming it. So the honest position is that the mangal root has no source that
passes the content gate, and one source that passes the content gate only if a
single Greek Easter offal dish is accepted as the Ottoman skewer tradition — which
on this beat's own standard it is not. Beat 9 keeps its 3.5 % as narration with a
satay cut inside it.

**I did not mint the satay passage.** Its anchors were validated against a
transcript body I cannot see, and its episode has no entry in
`data/segment-sources.json`, so adding it would mean asserting an anchor I have not
personally checked and minting a new source at the same time. Documented here for
stage 4 instead.

### Beat 10 — the tandoor as a third technology — **empty, but identified** (fan)

**Nothing playable today**, and §5 ranked this the beat most likely to come back
empty. But the beat is **not unsourceable, and this report corrects an earlier
verdict that said so.** `catalogue-broadening.md` §4 now carries a superseding note
of its own: the tandoor verdict turned on the ad gate, the ad gate is gone under
ADR-0008, and "tandoor content exists and we can use it." Two on-brief candidates:

- **olive's "Maunika Gowardhan on 10 things you need to know about tandoori
  cooking"** (45 min, a real Indian cookbook author) — PADDABLE on the screen and
  the better of the two. Its Megaphone feed declares `length="0"`, so the bitrate-
  implied ~1.02 cannot size a pad; it needs N ≥ 2 decode-and-compare probes first.
  ADR-0008's Gastropod section is the warning here — a bitrate-implied ratio
  overstated that show's load by 3–6× against what decoding actually found.
- **Naan Curry's 67-minute kebab episode** — measured 1.0470, LOCATE-REQUIRED.

**Also blocked on content, separately from ads.** Neither candidate is known to
supply what beat 10 actually claims: how a clay oven's radiant heat differs
mechanically from a grill's and from a pit's. A cookbook author on ten things to know
about tandoori cooking may well be the recipe-and-menu material the beat says to
reject. That cannot be settled without reading a transcript, and neither episode has
one.

**Fan hole — safe.** Costs the Foray its only beat that adds a technology rather
than a tradition, and all South Asian coverage.

### Beat 11 — yakitori as thrift made precise by fuel — **empty under the English rule** (fan)

**Nothing in English.** The only explanatory yakitori source found in 4.71M feeds is
`火上料理人：The Meat Nerds` (Taiwan, Mandarin), whose tare episode is real mechanism.
The beat is therefore empty but **not unsourceable**, and the distinction is settled
rather than open: `docs/DECISIONS.md` records the English-only ruling alongside the
narrator ruling, so a non-Anglophone tradition is described in English rather than
shipped as non-English tape. Beat 11 is a permanent narration beat for this Foray,
and no ASR or ad budget changes that.

### Beat 12 — Korea puts the fire on the table — **empty under the English rule** (fan)

**Nothing that passes.** `Heritage Food Stories — How Japanese Colonization Tried to
Erase Korean Food` (946 s, English, priority 1 in the ASR manifest, untranscribed)
is the only English candidate, and on its stated subject it does not advance this
beat: erasure of a national cuisine under colonisation is a different claim from
table-top grilling, the diner as cook, and the recent economics of pork belly.
Transcribing it would probably not fill beat 12. The two Korean-language sources
would, and under the English-only ruling they cannot be used.

**Fan hole.** Costs the fan its clearest demonstration of beat 6 running in reverse.

### Beat 13 — the braai asked to do political work — **empty** (fan)

**Nothing, and the negative is unusually clean.** Zero episode-level hits for
`braai`, `braaivleis`, `shisa nyama` or `potjie` across 7,237 crawled feeds; the
whole index holds ten Afrikaans food or history feeds with six or more episodes
active since 2022. There is no braai podcast to find. §5 predicted tourism-grade
material would dominate; in fact there is no material.

**Fan hole, and the most expensive one in Act III.** Beat 13 is where the
through-line's second clause is stated *outside* America, which is what stops Act IV
reading as parochial. Narration has to carry it, and carry it well: braai as
claimed national ritual and the Heritage Day campaign, honestly contested, with
shisa nyama and sosaties under the one word.

### Beat 14 — asado: abundance moves the craft into time — **strong**

**Chosen:** `bbqrn-argentina-open-fire#1205` (1204.72 → 1332.44, 128 s).
In on *"Let's jump right back into that. Al, how do you"*; out on *"that fire. You
are actually engaged in the cooking process."*

**Second:** `bbqrn-argentina-open-fire#700` (699.72 → 848.26, 149 s) — the occasion
and its four-to-six hours, as above.

**Why it advances beat 14.** `#1205` is the beat's consequent stated by the person it
is about: no thermometer, hold your hand over the grill and count, two seconds is
searing heat — and then the line that makes it the beat rather than a technique tip,
that you are *engaged in* the cooking. That is the craft having moved into fire
management, distance and patience, which is what the beat claims. `#700` supplies the
social form around it.

**What narration owes.** The beat's antecedent — pampas cattle abundance and the
19th-century export economy that removed scarcity as a constraint — is nowhere in the
tape, and neither is the asador named as a recognised social office, which is the
contrast beat 21 needs. One or two sentences of narration ahead of `#1205` closes
the first gap. The second is a real loss and should be flagged to stage 4.

**Alternate:** `bbqrn-argentina-open-fire#1005` (1005.42 → 1106.36, 101 s — the
parrilla's side firebox, and cooking only once the embers glow red) is the beat's
coal-management evidence and is the substitute if `#1205` is dropped.

**Under-cut, probably.** This is the episode where the missing ASR transcript costs
most: 2,414 s of an English-speaking asador, of which eight cuts exist and none is
the asador-as-office material the beat asks for. Re-transcribing it is the cheapest
available improvement to Act III.

### Beat 15 — jerk as Maroon synthesis, and the seam — **strong**

**Chosen:** `moreish-jerk-jamaica#266` (266.01 → 503.94, 238 s).
In on *"And it sounds to me like maybe there's a little"*; out on *"jerk was a
cooking style to now a flavor profile."*

**Second:** `moreish-jerk-jamaica#555` (554.64 → 638.62, 84 s).
In on *"So the claim is, and I do sometimes have a"*; out on *"the wood or the spice
is the constant throughout history."*

**Why it advances beat 15.** `#266` is the beat almost line for line, from a
researcher who works on Jamaican foodstuffs: jerk began as preservation of wild hog
by Maroons who had freed themselves and had to provision themselves; salt was
scarce so wood ash substituted; the pit was dug and the meat effectively smoked; and
pimento wood is the constant that makes it jerk. It carries the continuity argument
the beat asks for and it ends on the transition from cooking style to flavour
profile, which is the 20th-century commercial move. `#555` then states the
syncretism directly — Maroons, Taíno and Africans each claiming origin, *"they all
kind of do"* — and, crucially for this beat's evidence standard, says out loud that
**there is no direct evidence** for the transmission. The spine explicitly prizes a
speaker who says so over one who asserts it. This is the pairing that earns two
segments.

**Two corrections narration must carry.** First, the etymology: `#555` routes the
Taíno claim through Spanish *barbacoa*, and the spine's beat 15 holds that "jerk"
reaches English from Quechua *ch'arki* by way of Spanish, a dried-meat word with
nothing to do with *barbacoa*. Used unframed, `#555` will imply the lineage beat 15
exists to reject. Second, `#266` carries the tradition's own low-smoke account and it
must be framed as the tradition's account, per the beat. Both are narration
problems, not reasons to reject the tape.

**Seam intact.** Beat 15 is the fan's engineered exit into Act IV, and it is one of
only two fan beats with strong tape. It hands to beat 16, which is empty — see §5.

---

## 5. Act IV — the American case (chain, beats 16–30)

**Revised 2026-08-17: four beats in this act now have strong tape, where the first
draft of this report found none.** Beats 18, 21, 22 and 24 moved on The Grill Coach
(§2c), and 38 moved with them in Act V. The act now stands at **four strong, four thin,
seven empty**. The original finding is left stated below because it is what motivated
the transcription, and because the shape of the act has changed less than the count
suggests.

What changed is the part that mattered most. Of the four beats the spine calls the
honest weight of the authorship argument — 20, 21, 22 and 30, together 12 % of runtime
— **two are now strong on a historian's own argument, one is still thin on a single
Atlanta anecdote, and one is still empty.** Beats 21 and 22, which the spine calls
load-bearing and which the first draft found could not be served at all, are the two
that moved. That is the single most valuable change available to this Foray and it
came from one episode.

What did **not** change: beats 16, 17, 20, 25, 26, 28 and 29 are still empty, so Act IV
still opens on two narration beats and its whole regional stretch is still narration.
The act is no longer a hole where a chain should be; it is a chain with its middle
links in place and both ends missing.

*The original finding, 2026-08-16:* no beat in this act had strong tape — five thin
and ten empty. It was stated before the beats because reading them one at a time
understated it: Act IV is a fifteen-beat chronological chain from 1492 to about 1970,
it is 36.5 % of the spine's runtime, and no segment available then carried any part of
it well enough to be called strong. Of the four authorship beats, three were empty and
the fourth was thin on a single anecdote from a show with no sourced expertise.

**Four English sources for the core of this act are identified. One is readable, and
reading it moved three beats in this act off empty.** The act is thin rather than
covered because almost nothing has been transcribed, not because nothing exists — this
is the "identified but not playable yet" tier of §2a, and it is the most improvable
finding in the report.

| Source | Length | Ad status | What is known about its content |
|---|---|---|---|
| `The Grill Coach — Adrian Miller and The History of BBQ` | 3,306 s | **ad-free**, measured ratio 1.0. **Priority 3** in the ASR work order. No publisher transcript | The only one with a published description specific enough to map: indigenous roots, the shift to what we now call barbecue, African American contribution, present state and future — beats 18, 20, 21, 22, 38 |
| `A Taste of the Past — Black Smoke, the African American Roots of BBQ` | est. ~35–45 min | **PADDABLE** on one probe (implied 42–54 s); `delta_max` unknown, needs N ≥ 2 probes | Titled after Miller's book, so the authorship beats. Contents not verified |
| `Proof (America's Test Kitchen) — Barbecue Trailblazers`, 4 parts | est. ~30–40 min each | **TIGHT** — implied 50–67 s, already at Gastropod's measured maximum; bitrate-implied, needs N ≥ 2 probes. **Carries a transcript** | A four-part US-barbecue series. Which beats each part serves is unknown |
| `Stuff You Should Know — A Lip-Smacking Look at Barbecue` | 3,052 s (ADR-0008 records the *show* at 37–47 min) | **LOCATE-REQUIRED** (+8 to +10 min measured). **Ships a timed transcript** | Read in full — see §2b. Carries beats 19, 24 and 30 as thin; excluded on their own terms at 3, 16, 18 and 23 |

Rows two to four are named in ADR-0008's unlock table against exactly this arc slot,
"American barbecue's birth and westward spread". Adrian Miller is named in the spine
itself as the archetype of the register wanted, alongside Michael Twitty.

**Only SYSK's content is verified at beat level.** It ships a timed transcript, I read
it, and §2b records what it contains and the serious reservations that come with it: it
carries beats 19, 24 and 30 as thin, and it is excluded on those beats' own terms at 16,
18 and 23. For the other three, an episode description is not evidence that a
110-second span inside it advances a beat — that is the standard this whole report
applies, and it has to apply to promising sources as much as to disappointing ones. I
checked for a Grill Coach transcript on the feed, on the show's episode page and on
three Buzzsprout endpoints; there is none. **Act IV's remaining holes are a
transcription and ad-measurement problem rather than a sourcing one, and closing them
is the cheapest large improvement available to the project.** Two of the four sources
plausibly need no ASR at all — Proof is recorded as carrying a transcript, and SYSK
demonstrably does — which makes reading them the first thing to try. See §9.

### Beat 16 — the word named a frame — **empty**

**Nothing.** `moreish-jerk-jamaica#555` glosses *barbacoa* as the Spanish word behind
barbecue, but it is committed to beat 15 and it carries none of what beat 16 claims:
the Taíno attestation for a raised wooden framework, the 1620s English usage as a
structure against the 1661 cooking sense, or the explicit rejection of "barbe à
queue".

**Also considered and rejected.** SYSK (§2b) reaches this beat twice — the Taíno
green-sapling method at 977–1017 s, and at 2776–2811 s the claim that *barbacoa* is
"the word that De Soto reported back to Europe" and "a corrupted Taíno word", closing
on the observation that nobody thought to ask the Taíno before the Europeans killed
them all. The second half of that is the right register for beat 16 and the first half
is wrong on the record: it attributes the reporting to de Soto, offers no attestation
and no date, and does not touch the "barbe à queue" story the beat exists partly to
demolish. Beat 16 says *"reject: assertion of either etymology with no source"*, so
this is rejected on the beat's own terms rather than on register.

**Also considered and rejected, 2026-08-17 — and this one is a genuinely close call.**
The Grill Coach carries the etymology at 1640.34 → 1668.10 s, inside the span cut for
beat 18. Miller: Columbus and his crew were the first Europeans to see people cooking
this way, in the Caribbean islands; *"the word barbecue came from what the Spanish
people heard, the indigenous people calling the raised platform of sticks that had
iguanas, other meat and vegetables on it that was being slowly smoked"*; *"so it was
barbacoa in Spanish and the word barbecue is the English approximation of the Spanish.
So it's like a game of historical telephone."*

That is the right substance from the right kind of speaker — a raised frame, named by
the people who used it, before it named a method — and it is far better than the SYSK
version rejected above. **It still fails this beat, for three reasons, and the third is
the decisive one:**

1. **No attestation and no date.** Beat 16's claim is built on datable record — the
   early-16th-century chronicles, the 1620s English usage as a structure, the cooking
   sense around 1661. None of that is on the tape, and "Columbus and his crew" is a
   scene rather than a source.
2. **It never says Taíno**, and never rejects "barbe à queue" — and the beat exists
   partly to demolish that story. Beat 16's reject line is *"assertion of either
   etymology with no source"*, which this does not quite clear.
3. **Cutting it would mean cutting the beat 18 segment in two.** The etymology sits
   31 s inside a 182 s argument that runs continuously into the pit method. Isolating
   it yields **about 28 s** (1640.34 → 1668.10), which is under the 30 s hard floor, so
   it is not a legal segment at all — and padding it out to clear the floor would take
   the opening off the beat 18 cut, where *"not everybody agrees with this"* is doing
   real work. Trading a strong beat 18 for a partial beat 16 is a
   bad trade, and manufacturing two overlapping cuts from one span so that two beats
   both show green is precisely the fill behaviour §1 exists to stop.

**Verdict: still empty, still narration, and the tape is better than the verdict.**
This is the clearest case in the report of the difference between *relevant and
authoritative* and *sufficient for the beat*. The narration for beat 16 should be
written to the beat's standard — the chroniclers, the dates, the false etymology named
and dismissed — and it can now be written knowing that the Foray's own Miller segment
says the compatible thing about thirty seconds after Act IV's narration hands over.

**Chain hole, and it is the first link.** Act IV opens on the assertion that the
technique and its name are indigenous American, and that assertion is the first half
of the authorship argument. Narrate it; the beat exists partly because it gives the
listener a small checkable correction early, and narration does that as well as tape.

### Beat 17 — barbacoa as living practice — **empty**

**Nothing in English.** Three Spanish sources exist and are weakly authoritative
(8:08, 14:51, 3:34 — `catalogue-broadening.md` §4 assesses them as together worth
perhaps one 90-second passage), and ADR-0008 upgrades the Mexican slot further by
admitting El Mundo en un Bocado's 47-minute *Tacos al Pastor* as PADDABLE. All of it
is Spanish, so under the English-only ruling none of it reaches this Foray, and the
ad unlock is irrelevant here. §5 predicted this beat would be hard because the
continuity argument is the hard part; that is confirmed, and the language ruling
makes it moot.

**Chain hole.** Without it, beat 16's word-origin note never becomes a lineage with
living practitioners, and beat 18's raised grate and this beat's buried pit have no
fork to be two branches of.

### Beat 18 — the adopted indigenous apparatus — **strong** (was empty)

**Candidate, and the beat's best available tape:** `grill-coach-adrian-miller#1609`
(1608.86 → 1791.30, **182.4 s**). In on the host's *"But you, you talk about the
transition from Native Americans to African American slaves and how, you know, that
happened."*; out on *"So you could see the antecedents of it in Native American cooking
and European cooking and African cooking and smoking, but it starts to become something
different with that, with that interaction, you know, over the years."*

**Why it advances beat 18.** It is the beat's claim, argued rather than asserted, with
the apparatus described in enough detail to be checked. Miller gives the indigenous
method concretely — a shallow hand-dug pit filled with a mix of rocks and wood, set
alight, *"and it's ingenious, right? Because the heat of the rocks would continue
cooking long after the fire had gone out"*, with chunks of meat laid straight on the
coals. Then he gives the transmission as a change to that apparatus rather than as
influence: *"later when you get colonizing Europeans and enslaved Africans, they bring
their meat cooking traditions. And all of a sudden that shallow pit gets sticks set
across it so that you could lay meat above the cooking, the shallow pit becomes deeper
and then the European animals are cooked over this."* The raised grate arriving on top
of an existing indigenous pit is exactly the technology-transfer form the spine says
this beat wants, and the word "template" is his. The out-point is chosen so the segment
closes on the three-inheritance synthesis rather than on the tidier *"southern pit
barbecue"* sentence 14 s earlier — the fuller ending is the one that credits African and
European practice alongside the indigenous template, which is the spine's own framing.

**It also does the source-criticism the beat asks for, in Miller's first sentence.**
About 25 s in, once the host's question is done, he opens *"not everybody agrees with
this in the wrong, but barbecue starts with native Americans"* (1633.46) — the ASR garbles the clause, and the audio should be checked, but
the concession is unambiguous and it is what separates this from the slogan the beat
rejects. He states the pit-method claim as **his argument** (*"so my argument is that
the pit method that we talk about in the south was based on how Native Americans were
cooking meat"*), not as settled fact.

**What is missing.** Which peoples and which regions, and any dating; no engagement
with the counter-position that the "learned it from the Indians" story is itself
substantially a European construction, and no discussion of what the early engravings
do and do not show. So the beat is strong on the *claim* and the *apparatus* and thin
on the *provenance of the evidence*. Narration should supply the region and the
critical-source note, and it now has a segment to hang them on rather than carrying the
whole beat.

**Also considered.** The same span carries beat 16's etymology at 1640–1668 s, which is
why beat 16 is worth reading directly below rather than assumed to have moved with
this one.

**Previously (2026-08-16): empty.** The only tape was SYSK's single clause at
1132–1139 s — Native Americans *"eventually would make these wooden frames that they
would put the meat on"* — the apparatus with no region, no peoples, no date, no source
and no transmission, rejected on the beat's own terms. That verdict was correct and it
is what the transcription was bought to fix.

### Beat 19 — pork won the South for ecological reasons — **thin**

**Candidate, from SYSK (see §2b):** **563.36 → 624.48 (61.1 s)**. In on *"they were
originally cooking was pig. And the reason why they were cooking pig was because that's
what they had available to them"*; out on *"That's the origin of barbecue."*

**Why it advances beat 19.** It makes the beat's causal claim and then closes the loop
into technique, which is more than the beat asks for: the pigs were turned out into the
woods to fend for themselves, so they came back leaner and tougher with less fat, *"so
to cook that kind of food and make it tender, you have to cook it over low heat for a
very long time. And that's where barbecuing pig in the South originally came from."*
Free-range husbandry as the reason pork was available, and the animal's economics
determining the technique's shape — which is the beat's strong signal.

**What is missing.** The corn-and-hog complex, seasonal slaughter before
refrigeration, per-capita consumption figures, and the explicit contrast with cattle
needing land and management. On authority, note that the pork-primacy argument the cut
rests on is attributed on tape to a 2009 *Esquire* article, "My Pig Beats Your Cow" —
which is a source, but a magazine polemic about whether non-pork counts as barbecue
rather than an agricultural history. The segment is also 61 s, under the 75 s target floor,
because the passage immediately after it turns into a 200,000-year-old Israeli site
and cannot be included.

### Beat 20 — the West African inheritance — **still empty, and now for a settled reason**

**Revised 2026-08-17. The episode bought for this beat does not serve it, and the
negative is clean.** `The Moreish Podcast — Caribbean Food History with Dr. Candice
Goucher` (3,466 s) was transcribed specifically for beat 20 and read end to end. It
contains, in 6,920 words, **zero occurrences of barbecue, barbacoa, jerk, Maroon,
smoke, fire, grill, pit, charcoal, wood, butcher, allspice, pimento or vinegar.** The
single "roast" is *"roasting human flesh"* in a passage demolishing the Carib
cannibalism myth; the single "pepper" is *"chili peppers in parts of Europe"* in a
list of crop transfers. That is a word-level count over the whole episode, not an
impression.

**What the episode is actually about**, so the rejection is auditable rather than
asserted: Goucher's own training as an Africanist and archaeologist; the indigenous
Caribbean as a maritime culture; the cannibalism libel and why Europeans manufactured
it; the ecological damage of European livestock; creolization as a linguistic and
culinary process; the global circulation of crops and curry; shipboard provisioning
laws and how they manufactured a single "East Indian" identity in Trinidad and Guyana;
salt, and women's oral transmission of cooking rules inside African-derived religions.
It is a good episode and Goucher is exactly the authority the beat wanted.

**Why it is rejected anyway.** Beat 20's claim is about **technique**: West and Central
African live-fire cookery, whole-animal butchery, and the pepper-and-acid seasoning
lineage, plus how the transfer is traced. Its reject line is *"generic statements that
African cooking influenced Southern food, with no technique and no mechanism of
transfer."* The nearest thing the episode offers is 1647.52 → 1732.80 s, where Goucher
argues that *"food and cultural life was dominated by the African experience"* and that
*"slave owners were dependent on enslaved peoples for their day-to-day food"* — the
dependence stated structurally, with the enslaved dictating ingredients, bargaining in
the marketplace and growing the crops. That is real culinary-authorship material and it
is on the Foray's through-line. **It contains no fire, no butchery, no seasoning
lineage, and it is about the Caribbean rather than the American South.** Admitting it
would be admitting good tape because it is adjacent to the subject, which is the exact
mechanism #226 was opened to stop.

**No segments were cut from this episode, and it is not registered in
`data/segment-sources.json`.** The registry's contract is that every episode the pool
refers to must resolve to audio; an entry with no segments earns a checker warning and
would be recording a transcription, not a playable source. The passage above is
recorded here with its timestamps so a playlist pass can find it without re-reading
the episode — that is what "label, never exclude" means when nothing was minted.

**This is the second English-language source spent on beat 20 without result**, and it
was the best-described candidate in the pool. The beat's problem is now visible as a
*subject-matter* problem rather than an availability one: the argument lives in Twitty
and in Miller's own book, and the podcast form that carries it is a barbecue show
interviewing one of them, not a Caribbean food-history show. Note that The Grill Coach
touches the inheritance in one clause — *"European cooking and African cooking and
smoking"* — inside the beat 18 cut, which is a mention, not the beat.

**Recommendation, replacing §9 item 4:** stop buying general food-history episodes for
this beat. The remaining shots worth taking are `A Taste of the Past — Black Smoke`
(named after Miller's book, so likely to reach the inheritance directly) and any
episode where Michael Twitty is the guest. If neither lands, beat 20 is a narration
beat permanently and should be written as one rather than left open.

*Original assessment, 2026-08-16, retained:* nothing, and §5 ranked this third most
likely to be empty. The nearest miss is
`dis-a-fi-mi-moreish-flavours` 1361.1 → 1422.8 (62 s, in the passages file):
Caribbean dishes carrying indigenous, enslaved, indentured and colonial imprints at
once. That is a general statement of blending with no technique in it and no
mechanism of transfer, which is exactly what beat 20 says to reject. `The Moreish
Podcast — Caribbean Food History with Dr. Candice Goucher` (3,466 s, English,
priority 2, untranscribed, no publisher transcript) is the most promising unread
candidate given Goucher's work on African and Caribbean transmission, ahead of the
three Act IV sources in the table above, none of which is described as reaching back
across the Atlantic. **That prediction was wrong, and the paragraph above records why**
— which is worth leaving side by side, because it was a reasonable prediction from the
episode description and the guest's expertise, and it is the second time in this report
that an episode description has failed to survive contact with the transcript.

**Chain hole, and it weakens the Foray's central argument.** Without beat 20 the
act's causal story is indigenous technique plus European livestock plus Black
labour, and authorship then rests only on hours worked. The spine added this beat in
revision specifically to prevent that.

### Beat 21 — slavery as the labour system, and the enslaved as authors — **strong** (was empty)

**Candidate, and it is the most important cut in this report:**
`grill-coach-adrian-miller#1792` (1791.70 → 1962.90, **171.2 s**). In on the host's
*"Yeah. And another thing you mentioned in the book too, that you had instances where
slaves were allowed to sell barbecue."*; out on *"And because it was labor intensive and
they didn't want to pay people, they made enslaved African Americans do that work."*
**Played in `grilling-history-2` as `GC-1`.**

**Why it advances beat 21.** The beat asks for the argument in specifics rather than in
atmosphere, and it gets three specifics in order.

- **The tasks, named.** *"Somebody had to clear the field, somebody had to do all of
  that prep work, somebody had to serve the food, do the cleanup, and then provide the
  entertainment. And so that was Black people from A to Z."* The preceding beat 18 cut
  supplies the rest of the labour inventory — burning the wood down to coals, the
  butterflying, the person whose whole job is turning the meat, a second person keeping
  a separate fire to replenish cold spots, a third swabbing with vinegar and spices —
  and closes it with *"so this is very labor intensive"* (1716.16). The two segments are
  adjacent in the tape — `#1609` ends at 1791.30 and `#1792` starts at 1791.70 — but the
  two halves of the inventory are not continuous within them: about 220 s of pit method,
  transmission and the informal-economy passage sit between 1717 and 1938.
- **The coercion, named precisely rather than atmospherically.** The segment's last
  sentence is the causal claim with nothing softening it: the work was labour-intensive,
  *"they didn't want to pay people"*, so they made enslaved people do it. That is the
  register the spine asks for — the mechanism stated, no emotional amplification.
- **The expertise, recognised and monetised at the time.** The first half is the
  plantation informal economy: slaveholders who let enslaved people sell food in nearby
  towns and *"would take a cut of what the enslaved people sold"*, and barbecue sold at
  the plantation perimeter to neighbouring plantations, poor whites and Native
  Americans. This is the closest available tape to the beat's *"documented valuation and
  hiring-out of skilled cooks"*, and it does the work that valuation evidence does: it
  shows the skill was worth money to someone other than the person who had it.

**The authorship step is in the tape, in the hosts' voice as well as Miller's.** The
host reaches it independently, from craft rather than from history: the measure of a
pitmaster is *"the size of your ash pile"*, most people doing that work were enslaved,
*"and they are the ones that were building up that ash pile"*, learning *"the nuances of
all what it takes to put this together."* That is expertise as accumulated judgement,
which is the step the spine says makes this authorship rather than exertion. Miller
then states the conclusion outright: *"barbecue for most of our nation's history was a
Black experience."*

**What is missing.** The overnight shift as labour extracted *on top of* field work is
not stated as such; there is no named valuation or hiring-out document; and the
plantation barbecue as an instrument of the enslaver's public standing is present only
obliquely (*"they still got status from having slaves"*). Also absent, and the spine
asks for it separately and carefully: the place barbecue occupied in the lives of
enslaved people themselves. Narration should supply that fourth thing in particular,
because it is the part this segment leaves entirely open and the part most easily done
badly.

**On handling.** The spine names sanitising as the worse of two failure modes and
sensationalising as the other. This tape does neither, which is why it is graded strong:
it is a historian and two barbecue hosts talking about work, wages and skill, and the
coercion arrives as an economic fact in a sentence that does not flinch. Nothing in the
cut has been softened at the boundary — the out-point is chosen so the segment ends on
*"they made enslaved African Americans do that work"* rather than on the host's
*"Interesting."* one second later.

**Previously (2026-08-16): empty**, and the beat's own rejection criteria excluded both
near-misses. That assessment follows, unchanged.

**Nothing this beat can use.** This is the load-bearing beat of the Foray, 4 % of
runtime, and nothing in the pool touches it. Two passages in the readable SYSK
transcript come near it and neither serves it:

- **2512–2532 s** states that the plantation pitmaster role *"usually went to a slave"*
  and that such a cook knew how to cook well for a lot of people, *"both enslaved and
  not."* That is genuinely on this beat — but it is the opening of the passage committed
  to beat 24, and it is a single sentence of attribution rather than the argument beat
  21 asks for.
- **2421–2451 s** is the passage that shows why this beat's rejection criteria are
  written as they are. It has slavery appear as *"part of the sort of facade of treating
  slaves to a big barbecue as a reward for being slaves"*, then pivots within seconds to
  enslaved people planning the Nat Turner rebellion and underground-railroad escapes
  over barbecue, then to civil-rights-era restaurants, then to Jim Crow segregation.
  Beat 21 says to reject, hard, *"any segment where slavery appears as a single
  transitional sentence"*, and to reject material that substitutes intensity for what
  the sources say. This is four subjects in thirty seconds with no source behind any of
  them. **Rejected, and it is the clearest illustration in the whole pass of relevance
  without authority.**

**Chain hole, and the one that decides whether the Foray is worth shipping.** The
spine is explicit that if this beat is thin, the sanitised version of barbecue
history is the one that ships. It is not thin, it is empty, so the beat is entirely
narration — and narration is an acceptable answer here only if it is written to the
beat's standard: the tasks named specifically, the overnight shift as labour
extracted on top of field work, the documented valuation and hiring-out of skilled
pit cooks, and the decisions the cuisine consists of attributed to the people who
made them. Three of the four sources in the table above are described as carrying
this argument, and transcribing any one of them would give the beat a chance at tape
instead.

### Beat 22 — the record preserves the labour and erases the labourer — **strong** (was empty), and the tape refines the spine

**Candidate:** `grill-coach-adrian-miller#2668` (2667.52 → 2757.70, **90.2 s**). In on
the host's *"But I really appreciate like that your book dug down into the history and
try to put some shine like, especially where you have so many figures that were in
barbecue."*; out on *"So we get more foodie over time when you're looking at the
newspaper coverage."* **Played in `grilling-history-2` as `GC-2`.**

**Why it advances beat 22.** The beat asks for a historian talking about method and
sources, and this is that and almost nothing else. Miller names his own archive — *"a
lot of my research is based on going through historical newspapers"* — and then does
the thing the beat is actually about, which is to describe **what the record captures
at different dates**:

> before the mid 1800s, when it came to barbecues, they would probably note who hosted
> it. How many people showed up, there might be some references to what was consumed.
> By the time you get to the turn of the 20th century, they're telling you how many
> people came, you're often getting the name of the cook. The cook might even be
> interviewed a little bit. […] You get an exhaustive list of what was cooked.

That is a dated account of an archival silence and of its closing — the host is named
and the cook is not, until suddenly the cook is. It is source practice rather than a
general remark that history forgets people, which is precisely the distinction the
beat's reject line draws. The host's setup earns its place too: the figures are *"even
lost on somebody like me. And I've been hosting a barbecue show for the last couple
years"* — the erasure demonstrated on a practitioner rather than asserted.

**The refinement, and it should be read as a correction to the spine rather than a
weakness in the tape.** The spine's claim is that the individuals *"are named unevenly
and often not at all."* Miller pushes back on the strong version of that, on the
evidence of the newspapers:

> sometimes you hear people say, Oh, this country's so racist. These cooks have never
> been celebrated. You know, for the most part, I that has not been my experience. These
> cooks were celebrated in their time. Now granted, there was often a context of racism,
> right? There was a lot of condescension that went with it. But there's the skill was
> noted.

That is transcribed exactly as the ASR has it, garbles included — *"I that has not been
my experience"* and *"But there's the skill was noted"* are recognition errors, and the
sense is unambiguous. It is quoted unrepaired because it is the evidence for a proposed
spine amendment, and a cleaned quote is a worse basis for one. Listen at 2704–2719 s
before the amendment is made.

**This does not contradict the beat, it relocates its mechanism**, and the relocation is
more useful than the original. The loss was not primarily a failure to record; Miller's
own sentence for it is *"we just haven't been good about carrying on these stories. And
so they get lost."* So the archive is better than the received story and the
**transmission** is worse — which is a sharper claim, and it is checkable, and it makes
the recovery work in beat 38 legible as *reading the record again* rather than
*conjuring names from nothing*. It also strengthens beat 21 rather than weakening it:
contemporaries knew who the skilled cooks were, which is independent evidence that the
skill was recognised.

**Recommended spine amendment**, alongside the beat 27 one already in §8: beat 22's
claim should be restated so that the erasure sits in transmission and in the shift of
credit, not solely in the record's silence. As written, the beat and its best available
tape disagree on a point of fact, and the tape is a working historian describing his own
sources.

**What is missing.** Plantation records, runaway and sale advertisements and WPA-era
interviews are not mentioned; there are no named recovered figures used as worked
examples inside this cut; and how recovery is actually done is implied by *"going
through historical newspapers"* rather than described. Note that named figures do exist
elsewhere in the episode — the hosts raise one, and Miller's next book on Black street
vendors is discussed from 2980 s, with a striking archival detail at **3049–3056 s**:
newspapers printing street-cry sheet music as bars and scales, inside the article. None of
that is within this cut and none of it is beat 22's claim.

**Previously (2026-08-16): empty**, and §5 predicted it, on the correct reasoning that
the beat needs a historian discussing method. That reasoning was right and is what
identified the source.

**Chain hole, closed.** Beat 22 is what stops beat 21 being a claim taken on trust, and
the two now play consecutively as `GC-1` and `GC-2`, in the same voice, in tape order.

### Beat 23 — the political barbecue and its hierarchy — **thin**

**Candidate:** `bbqc-moss-school#2572` (2572.43 → 2723.73, 151 s).
In on *"and see where we go so i'll start with i"*; out on *"of immigrants who were
settling in california at that time."*

**Why thin.** Moss establishes the scale and the civic placement: barbecue is found
up and down the eastern seaboard, takes root in Virginia in the late 18th and early
19th century, rides west with the settlers as far as gold-rush California, and by
the 1850s is *"just sort of a standard feature of Fourth of July, of any kind of the
campaign season."* That is real evidence that the barbecue was a principal form of
American public assembly, which is the beat's first half.

**What is missing, and why this must not be read as covered.** The beat's second
half is the whole point of the beat — that a space which was one of the few
regularly biracial public spaces in a segregated society reproduced the hierarchy
inside it, with Black people cooking and serving and being fed separately or last.
The tape contains none of it. The spine says in terms: *"reject the harmony version
that omits the seating."* Admitting `#2572` as coverage would ship the harmony
version. It is admissible only *underneath* narration that supplies the seating,
and if stage 4 cannot write that, the segment should be dropped rather than
softened.

**The SYSK alternative, and why it does not resolve this.** SYSK's political-barbecue
passage (§2b) is better tape for beat 23's first half than `#2572` is, and it is
committed to beat 7 above. Worse for this beat, SYSK's two passages on the racial
arrangement are each bracketed by a harmony statement: the Jim Crow segregation of
barbecue restaurants runs within twenty seconds into *"barbecue kind of transcends race
and class"*, and the ninety seconds after the pitmaster passage are all stripes and
classes of people sitting side by side. The show supplies the seating and the harmony
version in the same breath, twice. Beat 23's whole editorial demand is
holding both halves at once, and neither available source does.

**A separate finding about this segment — the spine, not the tape, has the gap.**
`#2572`'s actual subject is the 19th-century westward diffusion of Southern
barbecue, and **the spine has no beat for it.** Beat 25 covers the 20th-century
Black Migration only. This is the strongest single piece of American tape in the
pool and there is no beat it fits squarely. See §8.

### Beat 24 — emancipation into enterprise — **strong** (was thin), and the authority problem is solved

**Preferred candidate, replacing the SYSK cut:** `grill-coach-adrian-miller#1964`
(1964.16 → 2032.00, **67.8 s**). In on the host's *"So I have a question. So this idea of
what we do now consider, you know, barbecue and its prominence"*; out on *"What does
start to change though, by the time you get to the turn of the 20th century, is you start
getting white men involved in barbecue."*

**Why it advances beat 24, and why it beats the SYSK cut on the one axis that
mattered.** The beat's strong signal is *"an explicit statement that the asset was
skill"*, and Miller gives it in the beat's own terms: after the Civil War the formerly
enslaved emerge *"with this very lucrative and marketable skill because people still want
to barbecue, but you know, Black people, the ones that made it."* He then supplies
something the beat did not ask for and clearly wants — the geography of that skill being
sold: *"they were put on trains, stage coaches and boats all across the country to bring
a taste of Southern barbecue to places that normally wouldn't get it."* Post-emancipation
barbecue as a portable, saleable expertise, stated by a historian.

**The SYSK cut is not withdrawn, and the two are complementary rather than
competing.** SYSK has what Miller lacks: the ladder in physical detail — sharecropping in
the week, pitmaster for the church at the weekend, a shack built around an existing pit,
a couple of stools and a window, then the car arrives and the joint becomes a
destination — which is the beat's low-capital mechanism made concrete. Miller has what
SYSK lacks: authority, and playability. §2b graded the SYSK passage thin because it is
hosts reconstructing a plausible sequence out of *"maybe"*, and it cannot play at all
until the locate step exists. **So the beat is strong because the claim is now carried by
a historian on ad-free tape; the SYSK cut remains the better illustration and the worse
evidence.** If the founder rules the SYSK register in, use both; if out, beat 24 keeps
this verdict rather than falling back to empty, which is a change to §7's sensitivity
note.

**What is still missing, and it is half the beat.** Named early proprietors and their
cities; the absence of credit stated as a constraint; and Emancipation Day and Juneteenth
barbecues as institutions with their own committees and finances — entirely absent from
both candidates. That last omission is the beat's whole civic half and it is narration.

**A note on the out-point**, because it is doing deliberate work. The segment ends on
white men entering barbecue at the turn of the century, one beat before Miller's
explanation of it (*"they see how lucrative it is"*, and they take the press and the
publicity *"even though most of them rely on all Black workforce"*, 2032–2050 s). That
follow-through is beat 22 and beat 38 material rather than beat 24's, so it is left out
of this cut. Whoever assembles a Foray that plays both this and a beat 38 segment should
know the connective sentence exists and is not in either.

*The original thin verdict on SYSK, retained in full:*

**Candidate, from SYSK (see §2b):** **2505.20 → 2583.28 (78.1 s)**. In on *"barbecue
joints were almost exclusively take out"*; out on *"And then that's how the barbecue
joints developed."*

**Why it advances beat 24.** This is the beat's argument, start to finish, in 78
seconds. The pitmaster role on a plantation *"usually went to a slave"*; after
emancipation *"all of a sudden you found yourself with extremely unique talent"* —
which is beat 24's strong signal, an explicit statement that the asset was skill; then
the ladder, in the order the beat claims it: sharecropping in the week, pitmaster for
the church at the weekend, then a shack built around the pit, a couple of stools and a
window, and then the car arrives and the joint becomes a destination. It even supplies
the low-capital mechanism the beat turns on, since a shack around an existing pit is
the whole capital requirement.

**What is missing.** Named early proprietors and the cities they worked in; the
absence of credit stated as a constraint rather than implied; and Emancipation Day and
Juneteenth barbecues as institutions with their own committees and finances, which are
half the beat and are absent entirely. The register caveat in §2b applies with force
here, because this is hosts reconstructing a plausible sequence — the passage is built
out of *"maybe"* — rather than a historian citing cases.

**Seam warning.** The out-point at 2583.28 is tight to four hundredths of a second:
the ninety seconds that follow are the harmony passage described at beat 30, and the
cut's own last words are the fragment *"Yeah, I think,"*. Of the three SYSK cuts with
seam risk this is the least forgiving.

**Also rejected here, and worth recording.** In the Moss transcript at roughly
2876–2941 s he dates the earliest barbecue stands to "just on either side of 1900" and
the permanent restaurants of Lexington, Lockhart and Owensboro to the early 20th
century. That is beat 24's chronology with the *entire* claim removed: nothing about
who, nothing about skill as capital, nothing about credit. Cutting it would produce
precisely the failure beat 21 warns against, the history arriving as a date while the
authorship is dropped. Not cut.

### Beat 25 — the style map as Black migration — **empty**

**Nothing.** No tape addresses the Great Migration, the routes, or forms that exist
only in the destination.

**Chain hole.** It is the mechanism behind beats 28 and 29, and without it Kansas
City and Chicago read as spontaneous local inventions.

### Beat 26 — Texas is four traditions — **empty**

**Nothing.** No segment, and no identified source, covers the butcher-shop lineage,
East Texas, the Rio Grande or West Texas, or dates brisket's rise.

**Chain hole in the internal fan.** §5 predicted beat 26 would be **over-supplied**
and named it a bloat risk. It is empty — see §7.

### Beat 27 — the Carolinas and contested custody — **thin**, and the tape contradicts the spine

**Candidate:** `bbqc-moss-school#2779` (2778.93 → 2876.79, 98 s), which is also beat
37's candidate — see below. In on *"that's actually a fairly recent thing um when i
first"*; out on *"that kind of cross cultural influence until much much later."*

**What the tape actually says about this beat.** Moss addresses one sub-claim of beat
27 and rejects it. The spine holds that the South Carolina mustard belt carries "a
German settlement trace". Moss, on tape, says that a lot of people talk about German
immigrants bringing mustard to the party in the Carolinas and that he is *"pretty
skeptical that that"* happened — there are people of German descent in the Carolinas,
but most of them arrived some 200 years before mustard sauce became a thing, and the
sauce looks to him locally developed.

**This is a spine correction, not coverage.** Beat 27's substance — whole hog over
its own coals, the vinegar-and-pepper dressing and its age, burning wood down and
shovelling coals, the sub-regional map, and above all the contested custody that
makes the Carolinas the on-ramp to beat 38 — is entirely absent. Verdict thin only
in the sense that one named sub-claim is addressed, and it is addressed *against*
the spine. See §8 for the recommended revision.

### Beat 28 — Kansas City and Memphis as freight artefacts — **empty**

**Nothing.** Two of the four American styles the founder explicitly required, so per
the beat's own coverage note this is a gap worth reporting rather than absorbing.

**Chain hole.** These are the two cities where beat 29's argument can be proved
rather than illustrated, and the named founding Black proprietors are beat 24's
economics arriving in the 20th century.

### Beat 29 — the regional map is an economic map — **empty**

**Nothing**, and §5 predicted it on the right reasoning: nobody says this in one
breath because it is the conclusion of an argument rather than a topic.

**Chain hole, but the least damaging kind.** The spine says do not cut this beat, and
that if runtime is short, shorten 26–28 and keep 29. With 26 and 28 empty and 27
thin, that instruction resolves cleanly: **narrate 29 well and let it carry the
region material on its own.** It is one of the beats most worth narrating.

### Beat 30 — policy produced the invisibility — **thin**

**Candidate, from SYSK (see §2b):** **2679.24 → 2764.20 (85.0 s)**. In on *"In
Atlanta, we had a very famous restaurant here"*; out on *"But yeah, it's a Walmart."*

**Why it advances beat 30.** The beat's strong signal is a specific city, a specific
road, a specific address, and this is one: Aleck's Barbecue Heaven in Atlanta, one of
the headquarters for Martin Luther King Jr, taken by eminent domain and now a Walmart —
with the coda that the commemoration was later removed because it did not represent
*"the brand in in the right way"* — the shrine was in the restaurant, and the hosts
think Walmart kept photographs of it for a while before taking them out, hedging three
times as they say so. A named barbecue business destroyed by a public taking, and the
memory of it removed afterwards, which is beat 30's mechanism and its archival pairing
in one anecdote. **One thing the cut does not say:** that Aleck's was Black-owned. It is
inferable from the King framing and from the Jim Crow discussion 200 s earlier, and it
is not in the tape, so narration has to supply it.

**What is missing, and it is most of the beat.** Lending and insurance discrimination,
the inability to capitalise or bequeath a business, the succession problem, and the
interstate and urban-renewal clearances as a *pattern* across cities rather than one
Atlanta case. The beat claims that the commercial invisibility of Black barbecue was
*produced by law and public works*, and one eminent-domain story illustrates that
claim without establishing it. §5 predicted this beat would be hard because the
material lives in urban history rather than food podcasting, and that is still right —
what turned up is an anecdote from a general-interest show, not the policy history.

**Considered and rejected, 2026-08-17 — The Grill Coach reaches this beat and does not
serve it.** Miller answers the host's *"I don't see a lot of black owned barbecue joints
even today"* with four mechanisms (2166–2258 s, cut for beat 38 — see below). Scored
against beat 30 specifically, they miss it in three different ways:

- **Succession**, but not the beat's succession. Miller's version is owners retiring or
  dying with *"very few people that want to do that"* hard work. Beat 30's version is the
  succession problem that *follows from not owning property* — a legal and financial
  constraint, not a labour-supply one. Different claim with the same name.
- **Gentrification, not urban renewal.** The neighbourhood joint becomes a destination
  joint as its customers disperse. That is a market process in the wrong direction of
  causation for a beat whose claim is that *law and public works* did this. The one
  genuinely regulatory lever in the answer is real and worth having — new white neighbours
  complain about the smoke *"and then all of a sudden you're getting all these
  violations"* — but nuisance enforcement is not the interstate-and-renewal clearances the
  beat is about, and it is one sentence.
- **The fourth mechanism is one the beat explicitly declines.** Miller's strongest
  point is that barbecue's defining aesthetic shifted from Black to white. Beat 30 says to
  reject *"anything that attributes the change to consumer preference without evidence"*,
  and a change in what barbecue is said to be is a preference claim, however well
  Miller frames it as imposed rather than chosen. It is a strong argument in the wrong
  beat, and its right beat is 38.

**So beat 30 stays thin on the Atlanta anecdote, and its gap is unchanged**: lending and
insurance discrimination, the inability to capitalise or bequeath, and the clearances as a
pattern across cities. This is the one authorship beat the transcription did not move, and
it is the clearest evidence in this pass that §5's prediction was right about *why* —
the material is in urban and policy history, and no barbecue podcast is going to supply
it. Recommend narration, and stop looking for tape.

**Two seam warnings for stage 4.** SYSK's Jim Crow segregation material (2461–2480 s,
about 200 s earlier) is also beat 30 material, and it is not included because twenty
seconds after it the show says barbecue *"kind of transcends race and class"* — a cut
that runs into that line ships the harmony version beat 23 exists to reject. Cutting
tightly around the segregation content alone is possible and needs care. Separately,
the ninety seconds immediately *before* this cut's in-point (2583–2674 s) are a second
harmony passage — all stripes and classes of people side by side, ending at a Falcons
tailgate — so the in-point at 2679.24 has to be exact, and a segment that opened even a
little early would land in the worst available material.

### 5a. Two beats gained good tape and did not move, and that is the report working

Beats **16** and **30** both received material in this pass from a historian, on
playable ad-free audio, squarely about their subject — and both keep their previous
verdict. It is worth naming that as a result rather than leaving it implicit in two long
beat entries, because it is the thing stage 2 was written to be able to do.

| Beat | What arrived | Why it does not move |
|---|---|---|
| 16 — the word named a frame | The Taíno-to-Spanish-to-English etymology, from Miller, inside the beat 18 cut | No attestation, no date, no "barbe à queue" rejection — and isolating it would break the beat 18 segment in two |
| 30 — policy produced the invisibility | Four mechanisms for the commercial thinning of Black barbecue | Succession-by-labour-supply not by property, gentrification not urban renewal, and a fourth mechanism the beat explicitly declines |

Neither rejection is about quality or authority. Both are about the beat's claim being
a narrower thing than its subject, which is founder rule 4 in #226 doing exactly the job
it was written for. Had "relevant, authoritative and adjacent" been the test, both would
have gone green and beat 16's segment would have been carved out of the middle of a
stronger one.

### 5b. What the assembly could actually play, and why it is two segments of six

Recorded here because the gap between what this report authored and what
`grilling-history-2` plays will otherwise read as an oversight.

**Six segments were authored from The Grill Coach. The Foray plays two.** The binding
constraint is **M4**, the concentration cap in `segment-length-rules.md` §6c and gated by
`tools/foray/check-forays.mjs`: no single `item_id` may exceed **25 % of a Foray's
segments or 25 % of its runtime**. Against the eight segments and 1,054.55 s
`grilling-history-2` already had, that permits **two segments and 351.5 s** — and a third
would have put the episode at 27.3 % of segments however short it was.

That is not a tooling accident and it should not be worked around. The rule's own
justification is that past 25 % *"we have made an edit of one episode and called it a
Foray, and the honest action is to recommend the episode"*. A single 55-minute interview
is exactly the shape that would trip it.

**Beats 21 and 22 were chosen**, for two reasons in this order:

1. **Editorial.** They are two of the four beats the spine calls the honest weight of
   the authorship argument, both were empty, and the spine designs them as interdependent
   — beat 22 is what stops beat 21 being a claim taken on trust. They also play
   consecutively, in the same voice, in tape order.
2. **Mechanical.** The obvious alternative pairing, beats 18 and 21, is unavailable
   either way, and this was checked rather than assumed. The beat 18 segment as authored
   is 182.4 s; 182.4 + 171.2 s is **25.1 % of the resulting runtime**, over M4 by a tenth
   of a point. Trimming beat 18 to the shorter *"southern pit barbecue"* out-point to fit
   costs the segment its synthesis ending and does not help: at 168.5 / 171.2 s the pair
   sits within 1.6 % of itself and forms a **D5 pairwise violation** with MOSS-1 at
   151.3 s (max/min 1.132). So the pairing fails M4 at its honest length and D5 at its
   trimmed one.

**The four held back — 18, 24, and both beat 38 cuts — stay in the pool**, and they are
named in `tools/foray/check-forays.test.mjs` as held-back ids so they cannot be quietly
played later without that being a visible change. They are authored, anchor-verified and
playable; what they lack is room. Any future re-assembly that lengthens this Foray, or
the rebuild of `grilling-history-1`, gains beats 18, 24 and 38 for no further sourcing
work at all — which makes this the cheapest coverage improvement now available to the
project, and it is already paid for.

---

## 6. Act V — the re-pricing (chain, beats 31–40)

### Beat 31 — refrigeration ended the necessity — **empty, but the closest thing to a free win in the report**

**Nothing usable today, and one strong identified candidate.** The recommendation
pool contains `Gastropod — The Birth of Cool: How Refrigeration Changed Everything`
(49 min), which is this beat's subject exactly.

**Correcting an error I nearly made.** The obvious reading is that Gastropod is
ad-blocked, on the strength of the `1.080 — injected` row in
`grilling-foray-sourcing.md` §4. That is wrong twice over, and ADR-0008 says so at
length. First, the 1.080 is **bitrate-implied and against a different episode**
("Where There's Smoke, There's… Whiskey, Fish, and Barbecue!"), so applying it here is
the exact axis error that ADR warns about. Second, Gastropod is **the one show in this
repo that has been probed twice** — +66.1 s and +32.7 s by decode-and-compare — which
makes it PADDABLE at a pad of about 100 s against the 120 s ceiling, and ADR-0008
calls it "the first candidate admitted on measured evidence under this ADR". The
bitrate-implied figure overstated the real load by 3–6×.

**What actually blocks it, then.** Two things, neither of them ads. It publishes no
timed transcript — `data/transcript-availability.json` records Gastropod at 0
transcripts across 293 episodes, and the episode page URL I tried 404s — so it needs
ASR. And `grilling-asr-manifest.json` excludes Gastropod under
`excluded_by_instruction`, where the stated reason is "already being transcribed",
which is a workstream note rather than a rejection. One outstanding caveat from the
ADR applies: both Gastropod probes were the same client on the same day, and the
margin exists to cover a different requester's copy, which has never been sampled.

**Rejected near-miss:** `bfh-medieval-meals-manners#1543` mentions that without
refrigeration the lady of the house planned feasts far ahead. That is medieval feast
logistics, it is drift material, and it advances nothing about smoked food surviving
as a taste after its function ended.

**Chain hole, and it is the act's hinge.** The spine added beat 31 in revision
precisely because beat 2 argues smoke is infrastructure and Act V assumes it stopped
being so, with nothing narrating the transition. With beat 2 only thin and beat 31
empty, the Foray's central irony is currently asserted at both ends and explained at
neither. Note that Gastropod is also ADR-0008's admitted candidate for beat 1's slot
("Out of the Fire, Into the Frying Pan"), which beat 1 does not need — so the show's
value to this Foray is concentrated here.

### Beat 32 — the manufactured backyard — **strong**

**Chosen:** `bbqc-moss-school#2941` (2941.37 → 3068.05, 127 s).
In on *"what i think is really curious is that you know"*; out on *"uh into what we
you know we're called grilling today."*

**Why it advances beat 32.** This is a historian dating the shift and attributing it
to marketing rather than to organic tradition, which is the beat's strong signal
stated outright. Moss traces the line: Southern barbecue reaches California in the
1840s and 1850s, is absorbed into a romantic Mexican rancho idea of ranch life, gets
codified as a California style by the 1920s, and is then sold *back* east by New
York lifestyle and country-living magazines as the "California style backyard
barbecue" — complete with instructions for digging a trench and cooking cuts instead
of whole animals. Then braziers come up out of the ground, Henry Ford and Kingsford
charcoal arrive, gas arrives, the Weber kettle arrives, and he names the whole thing
*"a direct line that you could trace from the old southern barbecue all the way out
to California, and then all the way back to New York and into what we call grilling
today."* It is the first re-pricing with a documented mechanism, and it is the only
strong beat in Act V.

**Second, from SYSK (see §2b):** **1139.28 → 1268.60 (129.3 s)**. In on *"And then in
a man named Elsworth, his warrior, patented the charcoal briquette"*; out on *"maybe it
was. This article is underwritten by Weber maybe."* This closes the exact gap `#2941`
leaves. Moss names
"Henry Ford and Kingsford charcoal came along" and moves on; SYSK supplies the origin
story the beat asks for — Kingsford was Henry Ford's cousin-in-law, Ford was looking for
a use for the stumps and sawdust left over from making running boards and dashboards
for the Model T, and so he began mass-producing briquettes — and then the 1950s Weber
kettle, a metalworker attaching legs to half a spherical nautical buoy and using the
other half as the lid. **Mill waste sold as a household product, which is beat 32's
briquette detail, from the one readable source that has it.** The out-point is set
deliberately past the Weber kettle to catch two lines that turn the cut back into beat
32's argument: that George Stephen was *"far from the first person to invent the
portable backyard grill"*, and then the hosts' own suspicion that the article they are
reading is underwritten by Weber. A segment about the manufactured backyard that ends
on its narrators noticing they may be inside the marketing is the best available
evidence for the beat's claim.

**What narration still owes.** The suburban backyard as a new domestic room, and the
advertising construction of the cookout as a ritual, are in neither cut.

### Beat 33 — gendered fire, inconsistent credit — **empty**

**Nothing**, and §5 predicted it. Comparative tape on the division of credit does not
exist in this pool, and neither does single-tradition tape that examines credit
rather than reporting custom.

**Chain hole, and a cross-cutting one.** Beat 33 is the act's deliberate step out of
the sequence, and it is the beat that keeps the authorship argument from being
available only in a racial register. Narration.

### Beat 34 — gas split the word — **empty**

**Nothing.** `bbqc-traeger-history#2457` (Kingsford at about 80 % of charcoal, owned
by Clorox) is fuel market structure, not the gas takeover, and it says nothing about
the consequence for vocabulary. Rejected.

**Chain hole.** Beat 34 closes beat 4's loop with a mechanism and sets up beat 39's
precedent. With beat 4 strong and beat 34 empty, the word confusion is raised and
never explained.

### Beat 35 — identity moved to the jar — **empty**

**Nothing.** No tape on bottled sauce as a supermarket category, a brand sold into a
large food company, or the chain-restaurant era.

**Chain hole.** It is the beat that explains the gap between what barbecue is in
Acts I–IV and what most listeners have actually eaten.

### Beat 36 — competition standardised the flavour — **empty**

**Nothing.** `The BBQ Central Show` has an episode titled "Robert Moss Talks Southern
BBQ Competition Beginnings" — the right speaker on the right subject — and it
publishes no transcript. `data/transcript-availability.json` records 1,858 episodes on that feed of which only 12 carry a
`<podcast:transcript>` tag, and only one of those is on plot: the Moss BBQ School
episode already segmented here.

**Chain hole.** §5 of the spine predicted beat 36 would be over-supplied. It is empty —
see §7.

### Beat 37 — poverty food to luxury — **thin**

**Candidate:** `bbqc-moss-school#2779` (2778.93 → 2876.79, 98 s), as above.

**Why thin.** Moss supplies the arc's shape and its dates: barbecue restaurants were
large before the war, faded afterwards as barbecue stands were eclipsed by fast food
and chains, and it was *"really only in the 1990s, early 2000s where people started
going back and rediscovering America's barbecue roots"*, at which point the craft
barbecue movement and Texas take off. That is the precondition for the inversion and
it dates it.

**What is missing.** The inversion itself, which is the beat: barbecue criticism
emerging as a beat, national awards, the queue as the story, and above all brisket's
price history read against what the cut cost when the tradition adopted it. Nobody
in the pool states the cheap-to-expensive inversion. §5 predicted over-supply here
too.

**Note:** `#2779` is assigned to beat 37 and not to beat 27, where its mustard content
sits, so that one segment is not double-booked. Beat 27's use of the same passage is
recorded as a spine correction in §8, which costs no runtime.

### Beat 38 — the authorship argument, unconcluded — **strong** (was empty), on two segments

This is the one beat in this pass given two segments rather than one, because its claim
is explicitly two-part — restoration *and* contest — and the two halves are 13 minutes
apart in the tape. §4a of the spine names beat 38 as one of the four beats that warrant
two or three. Two is the maximum taken, and neither is a second bite at the same
material.

**Best candidate — the restoration half:** `grill-coach-adrian-miller#1346` (1345.66 →
1427.90, **82.2 s**). In on *"And I think a seminal moment came when I was watching the
Food Network. And this was 2004."*; out on *"And so my book, Black Smoke is a thump on the
head to say, look, if you're going to talk about barbecue in the US, you have to include
African Americans."*

**Why it advances the beat.** It is the scholarship that reopened the record, described
by the person who did it, as a method rather than a sentiment. Miller sits down to watch
a Paula Deen barbecue special to find out *"who are the people that are being followed,
you know, getting the shine"*, and *"60 minutes later, when the credits were rolling, I
just realized that no black people were featured on that show."* He then does what a
researcher does with a single observation — doubts it, and widens the sample: *"So I
started looking at other media, TV shows, newspapers, magazines. And it was the same
thing, man. You know, black people were either pushed to the sidelines of barbecue
storytelling or left out altogether."* That is a small content audit with a stated year, a
stated finding and a stated remedy, and the remedy is the book this beat's argument runs
through. The cut ends on the book's purpose in his own words.

**Second candidate — the contest half:** `grill-coach-adrian-miller#2167` (2166.64 →
2257.20, **90.6 s**). In on *"So I might be jumping the gun here, but I don't see a lot of
black owned barbecue joints even today."*; out on *"So the way that white dudes are saying
barbecue should be made is now becoming the norm."*

**Why it advances the beat.** The beat asks for tape *"directly on the contested
questions — who is called a pitmaster, whose tradition it is said to be, who profits"*,
and for a speaker who states the argument as unresolved. This is the third of Miller's
three answers and the segment is cut to land on it:

> the third part is the shift in barbecue barbecue, where the people wanted to
> acknowledge it or not, was based on a black aesthetic. It was the way that these black
> people cooked it that defined barbecue. What's been happening in the last couple of
> decades is now barbecue has a white aesthetic.

Unrepaired again: the ASR doubles *"barbecue"* and reads *"where"* for what is almost
certainly *"whether"*. Neither affects the claim.

Whose tradition it is said to be, contested in the present tense, by a historian, with a
mechanism — not a claim about ownership but about which practice counts as the definition.
The beat's reject line is *"a single sentence of credit inside a segment about something
else"*, and the test is whether the authorship point is the segment's destination or its
decoration. Here it is the destination: the question is why Black-owned barbecue
businesses are scarce, the first two answers are commercial, and the third reframes the
first two. **Be honest about the proportion** — the aesthetic argument is about 22 of the
90 seconds (2234.72 to the out-point), and the first three-quarters is the
commercial-decline material that beat 30 above examines and rejects. A reader who thinks that proportion is too thin should
prefer `#1346` alone, in which case the beat is strong on one segment and loses the
present-tense half.

**What is missing from both.** Named practitioners receiving major recognition, and what
that recognition changed — no awards, no restaurants, no names other than Miller's own and
Aaron Franklin's, who appears later in the episode as a business lesson rather than as an
authorship case. So the beat has the argument and not its cast. Narration should supply
the names.

**A related passage, deliberately not cut.** At **2036.28 → 2046.40** Miller says that
when white men entered barbecue at the turn of the century *"they start getting the press
and the publicity for this, even though most of them rely on all Black workforce."* That
is the same argument at its historical origin and it is the single best sentence in the
episode for joining beat 22 to beat 38. It is not cut because it falls just **outside** the
beat 24 cut, which ends at 2032.00, and on its own it is 10.1 s — far below the 30 s
floor. It is recorded here because narration bridging Act IV to Act V should use it.

**Previously (2026-08-16): empty.** All four Act IV sources were relevant — *Black Smoke:
African Americans and the United States of Barbecue* is one of the works this beat's
argument runs through — and none was readable. The prediction that one transcription
would give beats 21, 22, 30 and 38 a chance at tape was three-quarters right: 21, 22 and
38 moved, and 30 did not.

### Beat 39 — automation as a real challenge — **empty**

**Nothing.** The Traeger material is company and market history — COVID demand, the
2021 IPO and the 2022 crash (`#1079`), the four-thousand-dollar grill as a Corvette
whose features trickle down (`#1987`) — and none of it takes a position on what
thermostatic control does and does not replace, or on whether attention is part of
the definition. That is the beat, and it is not in the tape. Rejected.

**Chain hole.** Without it the Foray ends in the past. Narration, and it is only
1.5 %.

### Beat 40 — coda: the invariants — **empty by design**

Designed as narration, and §5 says so. Nothing in the pool articulates the constant
across traditions rather than within one, which is the only tape that would serve.
No action.

---

## 7. Summary

### Counts

**Current, after the 2026-08-17 revision (§2c):**

| Verdict | Beats | Which |
|---|---|---|
| **Strong** | **11** | 1, 4, 5, 14, 15, **18**, **21**, **22**, **24**, 32, **38** |
| **Thin** | **9** | 2, 6, 7, 9, 19, 23, 27, 30, 37 |
| **Empty** | **20** | 3, 8, 10, 11, 12, 13, 16, 17, 20, 25, 26, 28, 29, 31, 33, 34, 35, 36, 39, 40 |

*Previously, 2026-08-16: 6 strong / 10 thin / 24 empty.* One transcription moved five
beats — four in Act IV and one in Act V — and every one of them is on the authorship
chain the spine says is the editorial test of the whole document.

Three caveats on those numbers, and they do not all push the same way.

**The SYSK sensitivity is smaller than it was.** Three of the nine thin verdicts — 7,
19 and 30 — still rest entirely on Stuff You Should Know, which passes the relevance
gate and fails the authority gate (§2b), and which cannot be played at all until the
locate step exists. A founder who rules that register out returns those three to empty
and the counts to **11 / 6 / 23**. Beat 24 used to be the fourth item in this list and is
no longer exposed: it is now carried by a historian on ad-free tape, so ruling SYSK out
costs it an illustration rather than its verdict.

**Beat 4's strong verdict depends on minting the proposed new cut.** On the existing
`#3315` alone it is thin, which would make the counts 10 / 10 / 20.

**Eleven strong beats is more than the assembly can play, and that is now the binding
problem.** §5b works through it for one episode: M4's 25 % concentration cap lets
`grilling-history-2` play two of the six Miller segments. The project's constraint has
moved from *finding tape for Act IV* to *having enough distinct episodes to distribute
it across* — which is a much better problem, and it changes what §9 should recommend.

### Where the holes fall — chain versus fan

This is the part of the report that matters most, and it inverted the spine's hope. The
2026-08-17 revision does not undo that, but it changes Act IV's row from the worst in the
table to a middling one.

| Act | Structure | Strong | Thin | Empty |
|---|---|---|---|---|
| I (1–5) | chain | 3 | 1 | 1 |
| II (6–7) | chain | 0 | 2 | 0 |
| III (8–15) | **fan** | 2 | 1 | 5 |
| IV (16–30) | chain | **4** (was 0) | 4 (was 5) | **7** (was 10) |
| V (31–40) | chain | 2 (was 1) | 1 | 7 (was 8) |

**Act IV's holes have changed shape, which matters more than the count.** The seven
remaining empty beats are not spread evenly: they are **16 and 17 at the opening**, **20**,
and **25, 26, 28 and 29 across the whole regional stretch**. So the act now reads as
a strong, continuous authorship argument — 18, 21, 22, 24 in chronological order, three of
them from one voice — with a missing prologue and a missing regional tour on either side of
it. The first draft's image of *"one hole where the act was, with a few planks laid across
it"* no longer holds. What does hold is that the act's geography is entirely unsourced,
and that beats 20 and 30 remain the two authorship beats without tape.

*Of the 24 empty beats in the original pass, 19 were in chains and 5 in the fan.* The spine
established that a fan break reads as a change of subject and a chain break reads as
a hole, and concluded that Act III is the safest place to come back thin and Act IV
the most dangerous. Both halves of that are now measured, and the news is bad in the
predicted direction:

- **Act IV's authorship spine is now sourced and its geography is not.** Of the four
  authorship beats — 20, 21, 22, 30, the 12 % the spine calls the honest weight — **21 and
  22 are strong**, on a historian making the argument rather than acknowledging it, and 20
  and 30 remain unsourced for reasons now settled rather than pending (§5, §5a). The act's
  remaining seven holes are its prologue (16, 17), beat 20, and its entire regional stretch
  (25, 26, 28, 29). **This bullet previously read "no strong tape at all", and that was the finding
  that bought the transcription.** For the record of what it cost to fix: one 55-minute
  episode, ad-free, no publisher transcript, transcribed locally.
- **Act V is a ten-beat chain with two strong beats**, and its peak (38) is now one of
  them. Its hinge (31) is still empty, and it is still the closest thing in this report to
  a free win.
- **Act III's five empty beats are the least of the problem**, exactly as designed,
  and they divide by the tiers in §2a rather than being one kind of hole. **13 (braai)**
  is unsourceable outright and the negative there is unusually clean. **11 (yakitori)**
  and **12 (Korea)** are empty under the English-only ruling, which is decided, so they
  are permanent narration beats. **10 (tandoor)** is identified-but-not-playable, with
  two candidates unlocked by ADR-0008 and awaiting probes and ASR. **8 (the steppe)** is
  the one Act III beat never resolved either way: no source has been found and none has
  been proven absent the way braai was, so it sits closest to plain unsourced. Of the
  five, **only beat 10 could be closed by measuring and transcribing.** Beat 9's mangal
  root is a sixth Act III hole, inside a thin beat, and it is a different case again — a
  candidate exists and fails the *content* gate, which neither ad measurement nor ASR
  fixes.
- **Act I holds up**, which matches the founder's field report that the content
  started good. Three of its five beats are strong and its one empty beat (3) is
  narratable.

### Projected runtime from the strong beats alone

Three figures, because no single one is honest on its own. They differ by how much has
to happen first, and the first is the only one that involves no further work at all.

**A. The strong beats from segments that exist in the pool today — 8 segments,
1,042 s, 17.4 min.**

| Beat | Segments | Seconds |
|---|---|---|
| 1 | `origin-stories-cooking-human#147` + `#678` | 239 |
| 4 | — nothing in the pool; thin on `#3315` alone | 0 |
| 5 | `bbqrn-argentina-open-fire#1437` | 79 |
| 14 | `bbqrn-argentina-open-fire#1205` + `#700` | 277 |
| 15 | `moreish-jerk-jamaica#266` + `#555` | 322 |
| 32 | `bbqc-moss-school#2941` | 127 |
| | **8 segments** | **1,042 s — 17.4 min** |

Note what beat 4 does to this table: on pool segments alone it is thin, not strong, so
the strong set is five beats and eight segments. Adding `#3315` as beat 4's thin carrier
would make it 9 segments and 1,126 s.

**B. The strong beats with the three proposed cuts minted — 11 segments, 1,325 s,
22.1 min.** Adds the `bbqc-moss-school` beat-4 cut (108.9 s), which makes beat 4 strong,
and the two SYSK second segments on beats 5 (45.0 s) and 32 (129.3 s). One of the three,
the SYSK material, cannot be played until the locate step exists.

**C. Everything admitted, thin tier included — 19 segments, 2,053 s, 34.2 min.** Adds
`#2572` (151 s), `#2779` (98 s), the satay passage (80 s) and the five SYSK thin cuts
(138 + 61 + 78 + 85 + 37 s). This is a **ceiling**, not a plan: it assumes the founder
admits both the SYSK register and the thin tier, and neither should be assumed.

**If only one number is quoted, quote A: 17.4 minutes of on-plot tape exists today,
across five of forty beats.**

None of the three is a runtime for the Foray. **Thirty-four of the forty beats are
narration beats** — the 24 empty ones plus the 10 thin ones, since §1 defines a thin
beat as a narration beat with a partial supporting cut — and narration length is stage
4's to estimate.

The cut budget is not a constraint at any of these sizes, which is worth stating
because §4a of the spine is written on the assumption that it would be. At a runtime
under 45 minutes `d1Budget()` allows **8** starts per rolling 600 s; nineteen segments
across 34.2 minutes averages 5.6, and eleven across 22.1 minutes averages 5.0. D3's
mean of ≥ 90 s passes in every configuration — 130 s on A, 121 s on B, 108 s on C — and
D5's whole-Foray IQR of ≥ 45 s passes at about 63 s on the strong set. **The spine was
sized for a scarcity of runtime and what it met was a scarcity of tape.**

### The 32 existing segments, scored

This table scores only the segments already in `data/segments.json`; the proposed new
cuts from `bbqc-moss-school` and SYSK are not pool segments yet and are excluded.

| Outcome | Count | Segments |
|---|---|---|
| Carries a strong beat | **8** | `origin#147`, `origin#678`, `bbqrn#1437`, `bbqrn#1205`, `bbqrn#700`, `moreish#266`, `moreish#555`, `moss#2941` |
| Carries a thin beat | **2** | `moss#2572` (23), `moss#2779` (37) |
| Credible alternate | **4** | `origin#448` (1), `moss#3315` (4), `bfh-18c#2011` (4), `bbqrn#1005` (14) |
| **Survives in some role** | **14** | |
| Rejected — off-beat | **18** | see below |

**14 of 32 survive; 10 of them are actually assigned to a beat.** The four
grilling segments that sit outside the current Foray (`moss#1881`, `traeger#2457`,
`bbqrn#2292`, `bfh-griddle#1360`) all fail too, so of the 36 grilling segments in the
pool, **14 survive and 22 are rejected** — 18 of those 22 being inside the Foray, as
the table above counts them.

All 22 rejections, with the beat each was scored against and the reason. The four
outside the Foray are marked †.

- `bfh-griddle-bakestone#740`, `#968`, `#1691`, `#1971` and `bfh-18c-tavern-briggs#940`,
  `#1484`, `#1871` — scored against beats 2, 3, 6 and 7. British hearth cookery,
  bakestones, Welsh cakes, bannocks, Yorkshire pudding and an 18th-century cook's
  cause of death. None advances a claim about fire, smoke, surplus or the labour of
  the pit. §6b of the spine names general food history as never having been a beat.
- `bfh-griddle-bakestone#1360` † — scored against beats 3 and 5. How to read a
  bakestone's heat, brought up slowly and tested with flour. It is genuinely about
  reading a fire, which is why it was scored rather than dismissed, but a bakestone is
  a baking surface and the beat it comes closest to (5) is about fuel determining a
  tradition. At 57 s it is also below the target band.
- `bfh-medieval-meals-manners#673`, `#944`, `#1326`, `#1543` — scored against beats 6
  and 7. Feast seating, distance from the salt cellar, carving vocabulary, feast
  logistics. Beat 7 says in terms that a lavish dinner party is not this beat.
- `bbqrn-santa-maria-grillzilla#134` — scored against beats 26 and 29. Santa Maria
  trailer pits and tri-tip grain direction. **No beat in the spine covers Santa
  Maria**, and the segment makes no causal claim that beat 29 could use. See §8.
- `bbqrn-argentina-open-fire#1571`, `#1796`, `#2018` — scored against beats 3, 6 and
  14. Offal ordering, Italian rather than Spanish settlement of Argentina, cooking
  durations. Cuisine detail and demography; none advances beat 14's claim about where
  the craft went.
- `bbqrn-argentina-open-fire#2292` † — scored against beat 5. Patagonian lamb tasting
  salty from sea spray on the grass is terroir colour, and at 59 s it is below the
  target band as well.
- `bbqc-traeger-history#1079`, `#1987`, `#2340` and `#2457` † — scored against beats
  34, 35 and 39. Traeger's COVID boom and IPO, grill price tiers, boutique charcoal
  distribution, Kingsford's market share. §6b excludes equipment and gear history
  except where it carries a social argument, and none of these does.
- `bbqc-moss-school#1881` † — scored against beats 3 and 4. Grill marks as Maillard
  browning is grilling technique inside a cast-iron gear discussion, and beat 3 is
  about the low-and-slow bargain.

**The `bfh-*` prediction held almost exactly.** Of the 13 `bfh-*` segments in the
pool — the griddle, bakestone, medieval-manners and 18th-century-tavern material the
founder identified as the drift — **exactly one survives**, `#2011`, and only as an
alternate. Each was scored against a beat rather than dismissed by reputation, and
the outcome is that reputation was right.

### How §5's predictions did

The spine recorded its predictions so that this report could check them, so:

**Likely-narration predictions: 11 of 13 correct.** Beats 10, 8, 20, 33, 29, 22, 30,
17, 31 and 13 all came back empty as predicted, and 40 was designed that way, which
is eleven. Two were inverted:

- **Beat 5 came back strong**, where §5 ranked it eighth-hardest. The reasoning was
  right — no tape states the rule — but a practitioner stating the mechanism turned
  out to be enough to carry the beat with one narration sentence.
- **Beat 9's halves swapped.** §5 predicted the kebab material would exist and the
  satay economics would not. In fact satay is the half that exists and the entire
  Ottoman root is unsourceable.

**Over-supply predictions: 1 of 5 correct.** §5 named beats 3, 26, 36, 37 and 1 as
the places the Foray would bloat if anyone let it. **Beat 1 is over-supplied and was
capped at two segments. Beats 3, 26 and 36 are empty and beat 37 is thin.**

**One prediction worth singling out as wrong in the useful direction.** §5 ranked beat
5 eighth-hardest on the reasoning that no tape would state the fuel rule. Two
independent sources state it — a practitioner from inside one tradition
(`bbqrn#1437`) and a general-interest show across traditions (the SYSK cut) — and beat
5 is the only beat in the report where narration ends up owing nothing.

This is the single most useful thing the predictions revealed, and it changes what
stage 4 should be defending against. The spine reasoned from what English-language
podcasting covers, which was sound, but **the pool is not English-language
podcasting** — it is nine hand-picked episodes plus a recommendation pool of 1,489
items. Barbecue tape in that pool exists but is not history: `data/discover.json`
holds Jess Pryles, Grant Pinkerton on Pinkerton's Barbecue and Steven Raichlen, all
of them technique, restaurant and personality material of the kind beats 26, 36 and
37 explicitly reject, and none of it transcribed.

So the fill pressure the spine was designed to resist does not exist **as tape**. The
live risk is the opposite one and it is worth naming plainly: a Foray that is 34 of its
40 beats narration, in which **the narration becomes the place the drift happens**, because
nobody is scoring prose against the beats the way this report scored tape. If stage 4
writes 34 narration beats without a gate on them, #226 recurs in a form that is harder
to hear, since narration always sounds on-topic.

---

## 8. Where the spine, not the tape, is the problem

Three findings that are not sourcing outcomes. Recording them rather than quietly
reshaping the spine, per the brief.

**1. Beat 27's German mustard trace is contradicted by the tape.** Beat 27 asserts
"a mustard belt in the South Carolina midlands with a German settlement trace".
Robert Moss — a barbecue historian and the author of a history of American barbecue —
says on tape that he is skeptical it happened, on the ground that people of German
descent in the Carolinas mostly arrived some two centuries before mustard sauce
became a thing, and that the sauce looks locally developed. He notes he has written
about it elsewhere, and `data/discover.json` holds a later BBQ Central episode
devoted to it — "Cigar Wrapper Talk With Mr. J; Robert Moss Brings The Mustard Based
TRUTH" (63 min) — which is the place to check this before revising, though it carries
no transcript. **Recommendation:** revise
beat 27 to carry the mustard belt as a *disputed* origin rather than a settlement
trace. This costs the beat nothing — a live dispute is better material than a tidy
derivation, by the spine's own standard — and it removes a claim the Foray's own
best available speaker rejects.

**2. The spine has no beat for the 19th-century westward diffusion of Southern
barbecue.** Act IV runs word → barbacoa → indigenous apparatus → pork → African
inheritance → slavery → archive → political barbecue → emancipation → migration →
regions. Beat 25 covers the Great Migration, which is 20th century and Black. There
is no beat for barbecue taking root in Virginia and travelling west with the
settlers into Tennessee, Alabama and Texas and out to gold-rush California by the
1850s — which happens to be **the strongest single piece of American tape in the
pool** (`moss#2572`, 151 s, high confidence). I am not proposing this be added
because tape exists for it; that is the reasoning #226 exists to forbid. I am
reporting that the spine's American chain has a chronological step between beat 19
and beat 23 that it does not narrate, and that a reader should decide on the merits
whether the diffusion is part of the argument. If it is not, `#2572` should be
rejected outright rather than used thin against beat 23.

**3. Santa Maria has no beat, and §6b does not acknowledge the omission.** §6b
honestly lists the traditions left out of the fan — Chinese roast meats, lechon, imu,
hāngī, contemporary West African grill cuisines. It does not mention that the
American act's regional coverage stops at Texas, the Carolinas, Kansas City and
Memphis, which are the four the founder named, and therefore excludes California and
Santa Maria — a style for which this project holds one playable sourced episode, a second in the ASR work order, and a
segment. That is defensible on runtime, and beat 29 arguably absorbs it in
principle, but the omission should be recorded in §6b so that the next sourcing pass
does not keep re-finding Santa Maria tape and wondering where it goes.

---

## 9. Recommended next actions, in value order

**Revision note, 2026-08-17.** Items **1** and **4** below have been done, and they are
left in place so the list can be read as a scorecard rather than rewritten into
hindsight. Item 1 (The Grill Coach) moved five beats and was the single most valuable
action in this report. Item 4 (Moreish/Goucher) moved none — see §5 beat 20 — and the
two together are the useful lesson: **an episode description predicted the outcome
correctly once out of twice**, and the difference was not the guest's expertise but
whether the episode was about fire.

Three things have changed about what should come next, and the first is new:

- **The binding constraint is now episode diversity, not tape.** Eleven beats are
  strong and `grilling-history-2` can play two segments per source episode at its current
  length (§5b). Transcribing a second long interview would author more held-back
  segments, not a longer Foray. The actions that now increase what a listener hears are
  the ones that add *distinct episodes* on beats that are still empty, and the ones that
  make the Foray longer so the 25 % cap admits more of what is already authored.
- **Beat 20 should be treated as nearly closed, not open.** Two English sources have
  been spent on it. §5's beat 20 entry names the only two shots left worth taking and
  recommends writing the narration if neither lands.
- **Beat 30 should be closed as narration now.** It is the one authorship beat the
  transcription did not move, and §5 records that the four mechanisms the tape offers are
  each the wrong claim. The material is in urban and policy history and no barbecue
  podcast will supply it.

Below, as originally written. Not decisions — this report does not own them. Ordered by
how many beats each moves.

1. **Transcribe `The Grill Coach — Adrian Miller and The History of BBQ` (3,306 s,
   English, measured ad-free at ratio 1.0, currently priority 3).** Of the four
   identified Act IV sources it is the only one that needs no ad work at all: it is
   ad-free, so it needs ASR and nothing else, where the other three need N ≥ 2 probes
   or the locate step first. It is described as covering beats 18, 20, 21, 22 and 38,
   including the Foray's load-bearing beat.
2. **Reprioritise the ASR work order against the spine.** Priority 1 currently holds
   sources for three beats that are *already strong* from existing cuts — beat 1
   (Origin Stories), beat 15 (Moreish jerk), beat 14 (the asado episode) — plus Santa
   Maria, for which no beat exists. Being fair to it: priority 1 also holds the
   English Korean episode for empty beat 12, and three non-English rows that the
   English-only ruling now makes unusable, which is itself a reason to re-sort. The
   ranking was built against the six old arc slots, and the spine's 40 beats are a
   different instrument.
3. **Read the two Act IV transcripts that may already exist, before buying any ASR.**
   Proof is recorded in ADR-0008 as carrying a transcript, and SYSK demonstrably ships
   one — reading SYSK is what produced §2b and four verdict changes for the cost of one
   fetch. `A Taste of the Past` should be checked the same way. This is the cheapest
   action in the list and it comes before items 1 and 2 on cost, if not on expected
   value.
4. **Transcribe `The Moreish Podcast — Caribbean Food History with Dr. Candice
   Goucher` (3,466 s, English, priority 2).** Best unread candidate for beat 20, and
   likely useful to beats 2 and 15.
5. **Probe Gastropod's "The Birth of Cool" and transcribe it.** Gastropod is already
   PADDABLE on two measured probes, so beat 31 — an Act V chain hinge — is closer to
   filled than any other empty beat. ADR-0008's outstanding caveat applies: sample a
   different requester's copy before relying on the pad.
6. **Re-transcribe `bbqrn-argentina-open-fire` and `origin-stories-cooking-human`.**
   Their local ASR is gone, they are the two episodes whose existing cuts already
   carry strong beats, and beat 14 is demonstrably under-cut — the asador as a social
   office is the thing beat 21's contrast needs and no existing cut contains it.
7. **Mint the beat 4 cut** specified in §3, through `merge-segments.mjs` with the
   published SRT as the transcript body, so the pool's anchor conventions stay
   consistent.
8. **Decide the three §8 questions** before stage 4 writes narration, because two of
   them change what the narration says.
9. **Rule on the SYSK register (§2b).** It is the only decision in this list that
   changes the verdict counts rather than the odds of improving them: in it, four Act IV
   beats are thin; out, they are empty and four more narration scripts are needed. It is
   also the decision most likely to recur, because general-interest shows with
   transcripts are abundant and food-history shows with transcripts are not.

**Not recommended: broadening the sourcing again to close Act IV.** The 4.71M-feed
pass has been run and its answers are recorded, and the temptation to widen the net
until something fits is the exact mechanism #226 was opened to stop. Act IV's holes
are a transcription and ad-measurement problem for four named episodes, and a
narration problem for everything those four do not reach.

**Also not recommended: treating the mixed-language question as open.** An earlier
draft of this report listed it as a pending founder decision. It is not —
`docs/DECISIONS.md` records the English-only ruling of 2026-08-16 together with the
narrator ruling, which together answer it: non-English tape is not shipped, and the
narrator describes those traditions in English instead. Note for whoever maintains
these documents that `catalogue-broadening.md` §3 still frames it as unresolved and
its §0 summary still calls tandoor unsourceable, both of which ADR-0008 and
`DECISIONS.md` have since overtaken. Reconciling those two paragraphs would stop the
next agent making the same mistake this one did.

---

## 10. The narration work list — mode, writability and budget

**Added 2026-08-18.** This section applies `narration-craft.md`'s vocabulary to the
verdicts above, and it answers that document's §6d ask directly: **carry `writable` /
`unwritable` as a second axis on empty beats, and record it at the same time as the
empty verdict rather than discovering it at script time.**

**Nothing below changes a coverage verdict.** Twenty beats are empty and nine are thin,
exactly as §7 records. What is added is three fields per beat — the **depth mode** its
narration would use, whether a script for it could pass the six-test rejection gate,
and what that script costs — for all twenty empty beats and all nine thin ones.

**Status:** proposed, and it is a work list rather than a script. No narration has been
written, no voice has been chosen and no API was called. The companion document
`grilling-beat-cut-plan.md` carries the consequence: which of these beats an assembly
can afford to attempt.

### 10a. The three fields, and how each was decided

**Mode** comes from `narration-craft.md` §2c — a thin beat takes a **Patch**, an empty
beat takes a **Carry**. Two corrections to that mapping fall out of this report's own
contents, and both cost money:

- **Three thin beats have no tape of their own in an assembly, so their mode is Carry
  and not Patch.** Beat 2's only candidate sits inside `moreish#266` and §3 keeps it on
  beat 15; beat 6's `#700` is beat 14's second cut; beat 27's `#2779` is assigned to
  beat 37 "so that one segment is not double-booked". A Patch supplies the part of a
  beat its tape misses, and a beat whose only candidate went to a neighbour has no tape
  for a Patch to supplement. **That is 780 characters becoming 1,360, three times over,
  and `narration-craft.md` §4d's per-beat cost model does not see it** — its thin
  constant assumes a thin beat plays tape.
- **Beat 29's Carry is not a standard one.** §5 tells it to "carry the region material
  on its own", which is a larger job than stating the beat's own claim, and with 26 and
  28 empty and 27 thin it is the only place that material can go.

**Carry provenance.** `narration-craft.md` §2d splits Carry two ways — **by-default**,
where sourcing could still close the beat, and **by-design**, where the claim is a
conclusion nobody states in one breath so no tape can exist. **Four of this Foray's
twenty empty beats fit neither**, and the reason is already in §2a above: they are empty
because of a ruling, or because sourcing has been proven not to help. The four-way split
the two documents imply together:

| provenance | meaning | beats |
|---|---|---|
| **by-default (open)** | tape could exist and the avenue is open | 3, 8, 10, 16, 25, 26, 28, 31, 34, 35, 36, 39 |
| **by-default (exhausted)** | the negative is clean and sourcing has been proven not to help | 13 |
| **by-ruling** | a source exists and a decision bars it — permanently, not pending | 11, 12, 17 |
| **by-design** | the claim is a synthesis, so no tape can exist | 29, 33, 40 |

The distinction is not cosmetic, because §2d's rejection posture turns on it: a
by-default Carry may be deferred to more sourcing or dropped, and a by-design Carry may
never be dropped. **A by-ruling Carry can be neither deferred nor treated as
provisional**, which makes it the most permanent narration in the Foray and the kind
most worth writing well. Recorded as an ask on `narration-craft.md` §2d, not an edit to
it.

**Budget** is `narration-craft.md` §4d's per-beat constant — **240 characters for a
strong beat, 780 for a thin one, 1,360 for a carried one** — with the two corrections
above applied where they bite, and with the §2c mode band recorded so a script author
can see which item is doing the spending.

### 10b. The writability test actually applied, because §6d's shorthand does not survive contact

§6d offers a heuristic: "an empty beat whose literature the report can name is writable;
an empty beat where the report cannot say what would be said is not." **Applied
literally that makes nineteen of twenty beats unwritable**, because this report names
literature for exactly one of them — beat 20, Twitty and Miller. That is not what the
rule means, and the sentence that says what it does mean is §6d's other one: the
material "genuinely is not in reach of anybody writing from what we have."

**From what we have** is the operative phrase and it is the test used below. A Carry or
Patch is **`writable`** if R3 can be satisfied — every factual assertion attributable to
a named source recorded in the script, and at least one source spoken on air — from one
of three places, none of which requires invention:

1. **Literature this report or the spine names.** Beat 20 is the only instance, and
   `narration-craft.md` §7b has already drafted the script to prove it.
2. **A datable public record the spine itself supplies** — an attestation, a date, a
   patent, a named campaign. Beat 16's 1620s structure sense against its 1661 cooking
   sense is the clearest case, and a Carry that names such a record is doing exactly the
   thing §5f says a narration beat can do better than tape.
3. **The Foray's own prior tape** — under R3's synthesis exception where the beat is
   genuinely a conclusion, and as corroboration where it is not. Beat 16 is corroborated
   by Miller's own etymology about thirty seconds into the beat 18 segment; beat 34's
   vocabulary split is stated on tape by Moss inside beat 4.

A beat is **`unwritable`** where none of the three reaches the beat's **reason to
belong** — not merely its subject. That distinction is §5a of this report doing its job
a second time: the same narrowness that stopped beats 16 and 30 moving on good tape is
what makes beats 23, 27 and 33 unwritable while their subjects stay perfectly
discussable.

**The result, and its shape matters more than the count.**

| | empty (20) | thin (9) |
|---|---|---|
| **writable** from what we have, no new citation | **3** — 16, 20, 40 | 0 |
| **writable†** — needs one source the corpus does not contain | **16** | **7** |
| **unwritable** | **1** — 33 | **2** — 23, 27 |

**Nineteen of the twenty empty beats are writable, and sixteen of those nineteen carry a
dagger.** The dagger is not a hedge. It means what §5f says an unfilled attribution slot
means — **a generation-blocking condition, not a warning** — so a dagger row is a
citation to obtain before a script can be voiced, and the sixteen of them together are
the largest single queue of work this report has produced. **The honest reading is that
this Foray's narration problem is not primarily a writing problem. It is sixteen
citations.**

### 10c. Acts I and II — four beats

| beat | verdict | structure | mode | provenance | writable | budget |
|---|---|---|---|---|---|---|
| **2** — smoke as preservation | thin | chain link | **Carry**, not Patch — its candidate stays on beat 15 | by-default (open) | writable† | **1,360** |
| **3** — the low-and-slow bargain | empty | chain link | Carry, 45–110 s | by-default (open) | writable† | 1,360 |
| **6** — a whole animal needs a crowd | thin | chain link | Patch **if** `#700` is assigned here rather than to beat 14; Carry if not | by-default (open) | writable† | 780 / **1,360** |
| **7** — feeding a crowd is authority | thin | chain link | Patch, placed **ahead** of the tape | — | writable† | 780 |

**What R3 would have to name.**

- **Beat 2.** The preservation mechanism is uncontested food science — water activity,
  the surface pellicle, the antimicrobial and antioxidant action of phenols and organic
  acids — and the spine supplies the worked examples plus the *boucan*-to-buccaneer
  record, which is datable. **No food-science source is named anywhere in this corpus**,
  so the on-air citation is the dagger. This beat and beat 3 are the two places where
  the missing source is a textbook rather than a scholar, which is the cheapest kind of
  dagger to clear.
- **Beat 3.** The same shape, and the mechanism is dense enough that R2 is safe by
  construction: collagen to gelatin, the two clocks, the evaporative stall, what
  wrapping does about it, Maillard and the bark, why smoke deposits on a moist surface.
  A script built from those cannot be relocated to another beat. `narration-craft.md`
  §5e uses this beat's own claim as its U1 exemplar — *"collagen converts to gelatin
  above about seventy degrees"* — and the clause that licenses U1 is "**and a named
  source supports it**", which is the half we do not have.
- **Beat 6.** Pre-refrigeration meat economics, the fuel and labour arithmetic of a
  whole carcass, and why the feast *is* the storage technology. The SYSK cut states the
  economics and states them well, but at low authority and LOCATE-REQUIRED, so a Patch
  that leans on it inherits both problems.
- **Beat 7.** The missing half is everything before America — sacrifice and
  distribution, hospitality obligation, patronage through meat — and the beat exists so
  that the power clause arrives *before* Act IV. So this is the one Patch in the report
  with a placement requirement as strict as its content requirement: written after the
  tape it is useless, because the tape is 19th-century American electioneering and the
  Patch is what stops that reading as the origin of the pattern rather than one instance
  of it.

### 10d. Act III — six beats, and the act where the consecutive cap breaks before the ratio does

| beat | verdict | structure | mode | provenance | writable | budget |
|---|---|---|---|---|---|---|
| **8** — the steppe control case | empty | fan stop | Carry, 45–110 s | by-default (open, unresolved) | writable† | 1,360 |
| **9** — the skewer family | thin | fan stop | Patch at the top of its band, or a Carry — see below | — | writable† | 780 |
| **10** — the tandoor | empty | fan stop | Carry | by-default (open, identified) | writable† | 1,360 |
| **11** — yakitori | empty | fan stop | Carry | **by-ruling** | writable† | 1,360 |
| **12** — Korea's table | empty | fan stop | Carry | **by-ruling** | writable† | 1,360 |
| **13** — the braai | empty | fan stop | Carry | **by-default (exhausted)** | writable† | 1,360 |

**What R3 would have to name.**

- **Beat 8.** The spine supplies khorkhog, boodog, hot-stone cooking, dung and scrub as
  fuel, and the Taipei provenance of the restaurant format — that last one a datable
  record and the beat's own on-the-record correction. R2 is safe. The dagger is one named
  ethnographer of steppe pastoral cooking, and §7's note that beat 8 "sits closest to
  plain unsourced" of the five Act III holes means the avenue is open rather than closed.
- **Beat 9.** The Patch here is unusual and it should be typed carefully. It is not
  supplementing a partial cut — the satay passage is a whole fan sub-tradition and the
  Patch has to carry **the entire Ottoman and mangal root**: the mangal as equipment and
  as an occasion, regional codification, charcoal management along a narrow fire, the
  19th-century turn of the spit from horizontal to vertical and its 1970s German
  reinvention. That is more than 765 characters of content, which is the top of §2c's
  Patch band, so **beat 9 is a Patch by mode and a Carry by size**. §4d's 780 is recorded
  above for comparability, and the honest figure is nearer 1,360. The dagger is
  unavoidable and it will not be cleared by sourcing: §4 records the mangal root as
  having no source that passes the content gate, and neither ASR nor ad measurement
  changes that.
- **Beat 10.** The radiant-wall mechanism is determinate physics — an enclosing wall,
  the fire at the bottom, the food suspended beside it, which is neither of beat 4's
  families — and the spine supplies the 1930s Peshawar invention of tandoori chicken
  *together with its live attribution dispute*, which is a U3 the narrator may state
  honestly. The dagger is a named source for the mechanism, and the two ADR-0008
  candidates are exactly the ones §4 warns "may well be the recipe-and-menu material the
  beat says to reject", so the dagger may be cleared by literature sooner than by tape.
- **Beat 11.** The most R2-safe Carry in Act III, because the beat's content is a
  sequence of specific facts that fit nowhere else: prohibitions that bore on quadrupeds
  while grilled wild birds continued, their Meiji-era lifting as the precondition for
  chicken specifically, binchōtan running hot with little smoke, whole-bird thrift and
  the named cuts, tare against salt. The Meiji record is datable. **The one source this
  project has found for the mechanism — `火上料理人：The Meat Nerds` — is barred as tape by
  the English-only ruling**, and the interesting question this raises is left open here:
  whether a Carry may *cite* a non-English source it may not play. It is a founder-facing
  question, it is small, and it recurs for beats 12 and 17.
- **Beat 12.** Determinate from the spine: the diner as the cook, the heat in the middle
  of the table, the older marinated court-cuisine lineage against the mid-century arrival
  of table-top equipment, the recent and economically explained rise of pork belly, ssam,
  and charcoal against gas in restaurants. The invented-tradition argument is the beat's
  reason to belong and it is the part most at risk of being written as colour.
- **Beat 13.** The one beat where this report has already written the work list itself:
  §4 says narration must carry "braai as claimed national ritual and the Heritage Day
  campaign, honestly contested, with shisa nyama and sosaties under the one word." The
  campaign is a named public campaign, which is a citable record. The dagger is one named
  source for the *contest*, and the beat cannot be written honestly without it — a Carry
  that asserts the ritual and omits the argument about who "we" are ships the
  tourism-grade version the beat exists to refuse, and it would do so in the house voice
  at the house length, which §6e is about.

**Two structural findings about this act that are not about writability at all.**

**Beats 10, 11, 12 and 13 are four consecutive empty beats, and that breaks R6 before any
ratio is computed.** `narration-craft.md` §2e caps consecutive narration items at **two**
after merging, and says a third "means the Foray has run out of tape for a stretch long
enough that the honest actions are the §4c ones: drop fan stops, or ship shorter." Four in
a row is that condition twice over. **So Act III forces cuts on a rule that has nothing to
do with the 25 % target**, and any plan that keeps all four is illegal on its face.

**And §2e's merge rule may not apply here, which makes it worse rather than better.** The
rule is written for "adjacent empty beats in the same **chain**", and Act III is a fan. The
letter of the rule therefore leaves 10 through 13 as four separate items; the spirit of it —
§2e's argument is about a listener hearing one continuous recording while the content jumps,
which is true regardless of structure — would merge them into one item of four traditions,
which is a strange artefact and would breach the 180 s hard max at 320 s besides.
**Recorded as an ask on `narration-craft.md` §2e: say whether the merge rule reaches a fan,
and if it does, say what happens when the merged item exceeds the hard max in a structure
whose stops are supposed to be announced separately.** Neither reading rescues the run.

### 10e. Act IV — eleven beats, and where both unwritable thin verdicts fall

Beats 18, 21, 22 and 24 are strong and are not in this table. **Beats 21 and 22 carry the
spine's load-bearing pair and they now have tape, so no narration decision in this
document touches them** beyond their share of the seams.

| beat | verdict | structure | mode | provenance | writable | budget |
|---|---|---|---|---|---|---|
| **16** — the word named a frame | empty | chain link, the act's first | Carry | by-default (open) | **writable**, no new source | 1,360 |
| **17** — barbacoa as living practice | empty | chain link | Carry | **by-ruling** | writable† (bounded) | 1,360 |
| **19** — pork won the South | thin | chain link | Patch | — | writable† | 780 |
| **20** — the West African inheritance | empty | chain link, load-bearing | Carry | by-default (nearly closed) | **writable**, demonstrated | 1,360 |
| **23** — the political barbecue and its hierarchy | thin | chain link | Patch | — | **unwritable** | — |
| **25** — the map as Black migration | empty | chain link | Carry | by-default (open) | writable† | 1,360 |
| **26** — Texas is four traditions | empty | **fan stop inside the chain** | Carry | by-default (open) | writable† | 1,360 |
| **27** — the Carolinas and contested custody | thin | **fan stop inside the chain** | Carry — its `#2779` is assigned to beat 37 | — | **unwritable** | — |
| **28** — Kansas City and Memphis | empty | **fan stop inside the chain** | Carry | by-default (open) | writable† | 1,360 |
| **29** — the regional map is economic | empty | chain link, the fan's closer | Carry at the **soft max** | by-design (synthesis) | writable, expanded scope | **~2,550** |
| **30** — policy produced the invisibility | thin | chain link | Patch | — | writable† | 780 |

**The three beats worth reading in full, because they are the ones the whole axis was
added for.**

**Beat 16 is the strongest writable case in the report, and it is writable for a reason
worth generalising.** Its claim is built entirely on datable record — the early-16th-century
chronicles, the 1620s English usage as a structure, the cooking sense around 1661, and the
"barbe à queue" story named and dismissed — and record of that kind is checkable rather
than asserted, so R3 is satisfied without any scholar being enrolled as an authority. On
top of that, §5's own note is that the beat "can now be written knowing that the Foray's
own Miller segment says the compatible thing about thirty seconds after Act IV's narration
hands over", which is in-Foray corroboration arriving immediately after the Carry. **The
generalisation: a beat whose claim is an attestation is a cheap Carry, because a date is
its own source.** That is the mirror image of §7b's finding that a Carry naming a book does
something tape cannot.

**Beat 20 is writable and it has already been demonstrated.** `narration-craft.md` §7b
drafts a 182-word Carry for it and runs all six tests, passing R1 through R5 with two R6
violations recorded rather than repaired. The literature is named by both the spine and
this report — Twitty's *The Cooking Gene*, Miller's *Black Smoke* — and §7b's third lesson
applies here specifically: the Carry hands directly to `GC-1`, so **carrying the beat on
the literature of the voice who speaks next** costs nothing and turns the whole item into
a Frame for beat 21. Nothing in this work list needs to be written for beat 20 that has not
been written. **Its provenance stays by-default, but §9 is right that it should be treated
as nearly closed rather than open**, and if the two remaining shots do not land it is a
narration beat permanently — which, given the above, is not a bad outcome.

**Beat 29 is writable at a larger scope than its claim, and this is where the budget model
breaks.** Its own claim is a synthesis, and R3's synthesis exception attributes "to the
Foray's own prior tape" — which works here only because two prior beats state the
availability rule on tape rather than in narration: beat 5's Frugoni cut on what a fuel
does, and beat 5's second cut plus beat 19's on availability determining what was used.
**But the exception is contingent.** Both of those supporting cuts are SYSK, so a founder
who rules that register out removes the prior tape the synthesis attributes to, and beat 29
falls back on a dagger. Separately, §5 instructs it to "carry the region material on its
own", so with 26 and 28 empty and 27 cut it is doing four beats' work: **that is a Carry at
or near the 150 s soft max, about 2,550 characters, and §2c requires such an item to state
what the extra minute buys.** Here the answer is legible — it buys the four lineages the
beats that would have carried them cannot.

**The two unwritable thin beats, and why unwritable is the right verdict rather than a
harsh one.**

**Beat 23 — the Patch cannot be written, and this report already said what follows.** The
beat's reason to belong is the second half of its claim: that one of the few regularly
biracial public spaces in a segregated society reproduced the hierarchy inside it, with
Black people cooking and serving and being fed separately or last. That is a specific
empirical claim about the documented record, and **nothing in this corpus sources it.**
`#2572` contains none of it; SYSK's two passages on the racial arrangement are each
bracketed by a harmony statement, twice, which §4 records in detail; Miller's tape reaches
the enslaver's status obliquely and the turn-of-century press asymmetry at 2036–2046 s, and
neither is the seating. So R3 has nothing to name, and a Patch that supplied the seating on
the narrator's own credit would be the worst sentence `narration-craft.md` §3f describes,
in the one place the spine says a harmony version must not ship. **The consequence is
already written in §4 and it is not a new recommendation: `#2572` "is admissible only
underneath narration that supplies the seating, and if stage 4 cannot write that, the
segment should be dropped rather than softened."** Stage 4 cannot write it. So the honest
outcome is that beat 23 loses its tape as well as its Patch, which costs the assembly the
151 s of `#2572` — **the report's own "strongest single piece of American tape in the
pool"** — and §8's second finding is the place that loss should be argued, because a beat
for the 19th-century westward diffusion would carry `#2572` squarely rather than thinly.

**Beat 27 — unwritable for a different reason, and its tape was never available anyway.**
Two things are true at once. Its `#2779` is assigned to beat 37 "so that one segment is not
double-booked", so beat 27 has no tape in an assembly and its mode is Carry rather than
Patch. And the beat's reason to belong is the contested-custody half — the spine's own
words are that it "is where beat 22's erasure becomes concrete and current", because the
leading whole-hog practitioners of the last generation include Black families whose work
was uncredited until very recently. **That is a claim about named living families and the
corpus names none of them.** The synthesis exception does not help: beat 38's tape is the
right material and it plays *later*, and R3's exception reaches only the Foray's own
**prior** tape. The technique half — whole hog over its own coals, the vinegar-and-pepper
dressing, shovelling coals, the pig-picking — is writable, and a Carry restricted to it
would be a Carry with the beat's reason to belong removed. **A second amendment
recommendation therefore joins the mustard one already pending in §8**, and both are
recommendations rather than edits: see `grilling-beat-cut-plan.md` §6.

**What R3 would have to name, for the rest.**

- **Beat 17.** The fork itself — an enclosed buried branch that Mexico kept against the
  raised-grate branch the Southeast took up — is the spine's own structure, and beat 18's
  tape shows the raised grate arriving on top of an existing pit, which corroborates the
  raised-grate half from inside the Foray. The pit and leaf wrap, steam rather than smoke,
  the Yucatecan and highland variants, the consommé and the Sunday pattern are all
  determinate. **The bound is the continuity claim from pre-contact practice**, which §4
  and §5 both call the hard part: it must run at U3 with the axis of the argument named,
  and its disputants are named nowhere here. The three Spanish sources and the *Tacos al
  Pastor* episode are barred as tape and raise the same citation question as beat 11.
- **Beat 19.** The corn-and-hog complex, seasonal slaughter before refrigeration,
  per-capita consumption, and the explicit contrast with cattle. One thing this Patch must
  do that no other must: **bound its own tape's authority rather than inherit it.** §5
  records that the pork-primacy argument on the SYSK cut is attributed on tape to a 2009
  *Esquire* article, "My Pig Beats Your Cow" — a magazine polemic about what counts as
  barbecue, not an agricultural history. Under §3f that is a Correction's job, placed after
  the tape, and it is cheaper than letting the Patch borrow the polemic's standing.
- **Beat 25.** The Migration's routes, what changed on arrival in cuts, equipment and
  storefront format, and named forms that exist only in the destination. Beat 24's Miller
  cut corroborates the mobility half from inside the Foray — the formerly enslaved "put on
  trains, stage coaches and boats all across the country" — but the destination-only forms
  are the beat's payload and the corpus names none, so the dagger is a named scholar of the
  Migration and barbecue together.
- **Beat 26.** Fully specified by the spine and among the most R2-safe rows here: four
  lineages named individually, the back-counter service of Mexican and Black customers at
  the meat markets, post oak, sauce's absence as an artefact rather than a doctrine, and
  brisket's rise dated against the supply-side change of feedlots, boxed beef and
  refrigerated trucking. No source is named for any of it. Note the direction this pushes
  beat 37: the inversion beat 37 measures is measured *against* this beat's supply story,
  so a cut beat 26 leaves beat 37's Patch to establish its own baseline.
- **Beat 28.** The freight-to-signature chain is stated in the spine tightly enough to be
  a single sentence — a stockyard city where every kind of meat came through cheaply, a
  river and cotton entrepôt — which is exactly why the spine calls these the two cities
  where beat 29's argument can be proved. **The named founding proprietors are the dagger**,
  and they matter more here than a citation usually does: they are beat 24's economics
  arriving in the 20th century, and a Carry that describes the freight and omits the people
  reproduces the erasure beat 22 is about.
- **Beat 30.** Lending and insurance discrimination, the inability to capitalise or
  bequeath a business, the succession problem that follows from not owning property, and
  the clearances as a pattern across cities rather than one Atlanta case. §9 is explicit
  that this is narration now and that no barbecue podcast will supply it, so the dagger is
  urban and policy history and it is the most clearly identified missing citation in the
  report. The Patch also owes one fact the tape omits and §5 flags: **that Aleck's was
  Black-owned**, which is inferable from the King framing and is not on the tape.
