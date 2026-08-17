# Coverage report — the history of barbecue (`grilling-history-1`)

Stage 2 of #226. The spine (`docs/curation/grilling-history-spine.md`, 40 beats in
five acts) was written source-blind by stage 1. This document scores the available
tape against it, beat by beat and independently, and reports where the tape fits
the spine — including, at length, where it does not.

**Status:** proposed. This is a coverage report, not a playlist. Nothing here
assembles the Foray, and `data/forays.json` is untouched. Stage 4 assembles, after
a human has read this.

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
| Anchor-validated passages in `grilling-foray-passages.json` | 8 (501 s), never merged into the pool | Yes, as documented candidates |
| Episodes in `grilling-asr-manifest.json` | 24, of which **none** is transcribed | No — content unverifiable at beat level |

Two facts about this table do most of the work below.

**The local ASR transcripts are gone.** Every existing segment carries
`transcript_source: "asr-local"`, and `data-local/` holds no `.asr.json` — it
holds the engineering research corpus only. So for seven of the nine source
episodes I can score the cuts that exist but cannot make new ones, because I
cannot see the words between them. That is a real ceiling on this pass and it is
worth fixing before stage 4: the same episodes would yield better cuts if they
were re-transcribed, and `bbqrn-argentina-open-fire` in particular is likely
under-cut for beat 14.

**Two transcripts are readable, and both were worth reading.** `bbqc-moss-school`
publishes a `<podcast:transcript>` SRT, which I fetched and read end to end; its
timestamps match the existing ASR cut points to within a cue (checked on three
anchors — `#2941` at 2941.51, `#1881`'s out at 1944.65, `#3315`'s out at 3395.68),
so cuts proposed against it are safe to mint. Only the 2537–3441 s band is on
plot; the first hour is hot-dog-eating coverage, knives and griddle gear.
`moreish-jerk-jamaica` publishes an untimed plain-text transcript, enough to
confirm what the two existing cuts contain but not to time new ones.

**A note on the quotations below.** Everything quoted from `bbqc-moss-school` comes
from a machine transcript and is lightly cleaned for punctuation and obvious
recognition errors. The wording is indicative, not verbatim, and anyone writing
narration against it should listen to the audio at the timestamp given. The
`moreish-jerk-jamaica` transcript is publisher-edited prose and its quotations are
exact.

**Nothing new was sourced in this pass, deliberately.** The catalogue-broadening
pass already searched 4.71M feeds (`docs/curation/catalogue-broadening.md`) and its
negative results are answers, not gaps: braai, tandoor, mangal/kebab and Filipino
lechon have no usable source at any budget. I re-ran only targeted checks against
the recommendation pool for the beats that looked empty, so as not to under-report
coverage. Those checks are in §6.

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

**What is missing.** Collagen converting to gelatin, the two clocks the cook runs at
once, the evaporative stall and what wrapping does about it, Maillard and the bark,
why smoke deposits on a moist surface. §5 predicted this beat would be
**over-supplied**. It is empty — see §5 of this report.

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

**What narration still owes.** The beat's second clause, that availability rather
than preference explains the world map, is not in the tape. One sentence of
narration on the way into Act III closes it, and the fan then supplies the evidence.

**Note against §5's prediction.** The spine predicted this beat would be hard —
"partial tape from many traditions is likely; tape that states the rule is not."
The prediction was right about the second half and the beat is carried anyway,
because the tape states the *mechanism* clearly enough that the rule can be
narrated on top of it.

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

**What is missing.** All of the economics: fuel and labour arithmetic for a whole
carcass, why slaughter was an event, why the feast is the storage technology when
you cannot preserve everything, how many people a hog feeds and what happens to the
leftovers. Beat 6 is the load-bearing middle term of the through-line and it should
be narrated properly rather than gestured at.

### Beat 7 — feeding a crowd is a claim to authority — **empty**

**Nothing.** `bfh-medieval-meals-manners#944` (rank at a medieval table measured in
distance from the salt cellar) is hierarchy at a dinner table, and beat 7 says in
terms that *"a lavish dinner party is not this beat."* Rejected. This is precisely
the boundary the previous Foray crossed.

**Chain hole.** Without beat 7, the through-line's second clause — that who tends
the fire is a question about power — arrives for the first time inside the American
act, where it will read as a grievance imported into the story rather than as a
pattern the story is an instance of. Narrate it.

**What is missing.** Sacrifice and distribution, hospitality obligation,
aristocratic patronage through meat, or the 19th-century American campaign barbecue
treated as a machine for assembling voters. The claim to look for is reciprocity —
the crowd owes something for the meat.

### Beat 8 — the steppe as the control case — **empty** (fan)

**Nothing**, and §5 predicted it. The recommendation pool's only steppe material is
`Fall of Civilizations — The Mongols: Terror of the Steppe` (241 min), which is
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
a narrow fire, the vertical spit and its 1970s German reinvention. This is not a
sourcing failure to be retried — `grilling-asr-manifest.json` and
`catalogue-broadening.md` §4 both record mangal/kebab as **unsourceable** after a
4.71M-feed search, the one candidate having failed the content gate. Per the
founder's rule that is the correct outcome for the beat, and beat 9 keeps its 3.5 %
as narration with a satay cut inside it.

**I did not mint the satay passage.** Its anchors were validated against a
transcript body I cannot see, and its episode has no entry in
`data/segment-sources.json`, so adding it would mean asserting an anchor I have not
personally checked and minting a new source at the same time. Documented here for
stage 4 instead.

### Beat 10 — the tandoor as a third technology — **empty** (fan)

**Nothing**, and §5 ranked this the beat most likely to come back empty. Confirmed
independently: `catalogue-broadening.md` §4 records two genuinely on-brief candidates
(Naan Curry's 67-minute kebab episode, olive's Maunika Gowardhan tandoori episode)
and both are ad-injected — 1.0470 measured, and a bitrate-implied ~1.02 on a feed
declaring `length="0"`. ADR-0008 admits the second in principle, but admitted is not
shippable: it requires N ≥ 2 probes of the same episode and no episode in this repo
has ever been probed twice.

**Fan hole — safe.** Costs the Foray its only beat that adds a technology rather
than a tradition, and all South Asian coverage.

### Beat 11 — yakitori as thrift made precise by fuel — **empty under the English rule** (fan)

**Nothing in English.** The only explanatory yakitori source found in 4.71M feeds is
`火上料理人：The Meat Nerds` (Taiwan, Mandarin). Under #226's English-only
constraint this beat is empty; it is **not unsourceable**. The distinction matters,
and it is a founder decision, not a sourcing one — see §6.

### Beat 12 — Korea puts the fire on the table — **empty under the English rule** (fan)

**Nothing that passes.** `Heritage Food Stories — How Japanese Colonization Tried to
Erase Korean Food` (946 s, English, priority 1 in the ASR manifest, untranscribed)
is the only English candidate, and on its stated subject it does not advance this
beat: erasure of a national cuisine under colonisation is a different claim from
table-top grilling, the diner as cook, and the recent economics of pork belly.
Transcribing it would probably not fill beat 12. The two Korean-language sources
would.

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

**No beat in this act has strong tape. Two are thin and thirteen are empty.** This
is the most important finding in the report and it is stated before the beats
because reading them one at a time understates it: Act IV is a fifteen-beat
chronological chain from 1492 to about 1970, it is 36.5 % of the spine's runtime,
and the tape available today carries none of it.

The act is also where the spine says the editorial test of the whole document lies,
and where beats 20, 21, 22 and 30 — 12 % of runtime, the honest weight of the
authorship argument — are all empty at once.

**There is exactly one identified English source for the core of this act**, and it
is untranscribed: `The Grill Coach — Adrian Miller and The History of BBQ` (3,306 s),
in `grilling-asr-manifest.json` at **priority 3**. Its published description states
that the interview covers barbecue's indigenous roots, the shift to what we now call
barbecue, the significant contribution of African Americans to the culture, and the
current state and future of it — which is beats 18, 20, 21, 22 and 38, including the
Foray's load-bearing beat. Miller is named in the spine itself as the archetype of
the register wanted. I checked for a transcript on the feed, on the show's episode
page and on three Buzzsprout transcript endpoints: there is none, so its content
cannot be verified at beat level and no cut can be proposed from it. **The single
highest-value action available to this project is to transcribe that episode.** See
§6.

### Beat 16 — the word named a frame — **empty**

**Nothing.** `moreish-jerk-jamaica#555` glosses *barbacoa* as the Spanish word behind
barbecue, but it is committed to beat 15 and it carries none of what beat 16 claims:
the Taíno attestation for a raised wooden framework, the 1620s English usage as a
structure against the 1661 cooking sense, or the explicit rejection of "barbe à
queue".

**Chain hole, and it is the first link.** Act IV opens on the assertion that the
technique and its name are indigenous American, and that assertion is the first half
of the authorship argument. Narrate it; the beat exists partly because it gives the
listener a small checkable correction early, and narration does that as well as tape.

### Beat 17 — barbacoa as living practice — **empty**

**Nothing in English.** Three Spanish sources exist and are weakly authoritative
(8:08, 14:51, 3:34 — `catalogue-broadening.md` §3 assesses them as together worth
perhaps one 90-second segment). §5 predicted this beat would be hard because the
continuity argument is the hard part; that is confirmed.

**Chain hole.** Without it, beat 16's word-origin note never becomes a lineage with
living practitioners, and beat 18's raised grate and this beat's buried pit have no
fork to be two branches of.

### Beat 18 — the adopted indigenous apparatus — **empty**

**Nothing.** The Adrian Miller episode is the only identified source and is
untranscribed.

**Chain hole.** This is the transmission event that connects the Caribbean word to
the mainland. Without it the act jumps from a Taíno word to a Southern pork
tradition across a two-century gap.

### Beat 19 — pork won the South for ecological reasons — **empty**

**Nothing.** No segment or identified source addresses semi-feral swine husbandry,
the corn-and-hog complex, or the contrast with cattle.

**Chain hole.** It is beat 5's logic applied to the animal, and it is what makes
beats 27 and 28 explicable rather than merely regional.

### Beat 20 — the West African inheritance — **empty**

**Nothing**, and §5 ranked this third most likely to be empty. The nearest miss is
`dis-a-fi-mi-moreish-flavours` 1361.1 → 1422.8 (62 s, in the passages file):
Caribbean dishes carrying indigenous, enslaved, indentured and colonial imprints at
once. That is a general statement of blending with no technique in it and no
mechanism of transfer, which is exactly what beat 20 says to reject. `The Moreish
Podcast — Caribbean Food History with Dr. Candice Goucher` (3,466 s, English,
priority 2, untranscribed, no publisher transcript) is the most promising unread
candidate given Goucher's work on African and Caribbean transmission.

**Chain hole, and it weakens the Foray's central argument.** Without beat 20 the
act's causal story is indigenous technique plus European livestock plus Black
labour, and authorship then rests only on hours worked. The spine added this beat in
revision specifically to prevent that.

### Beat 21 — slavery as the labour system, and the enslaved as authors — **empty**

**Nothing.** This is the load-bearing beat of the Foray, 4 % of runtime, and there
is no tape for it in the pool or in any readable transcript.

**Chain hole, and the one that decides whether the Foray is worth shipping.** The
spine is explicit that if this beat is thin, the sanitised version of barbecue
history is the one that ships. It is not thin, it is empty, so the beat is entirely
narration — and narration is an acceptable answer here only if it is written to the
beat's standard: the tasks named specifically, the overnight shift as labour
extracted on top of field work, the documented valuation and hiring-out of skilled
pit cooks, and the decisions the cuisine consists of attributed to the people who
made them. The Adrian Miller episode is the source that would let tape carry it.

### Beat 22 — the record preserves the labour and erases the labourer — **empty**

**Nothing**, and §5 predicted it, on the correct reasoning that the beat needs a
historian discussing method.

**Chain hole.** Beat 22 is what stops beat 21 being a claim taken on trust, and
without it beat 38's revival has nothing whose loss was ever explained.

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

**A separate finding about this segment — the spine, not the tape, has the gap.**
`#2572`'s actual subject is the 19th-century westward diffusion of Southern
barbecue, and **the spine has no beat for it.** Beat 25 covers the 20th-century
Black Migration only. This is the strongest single piece of American tape in the
pool and there is no beat it fits squarely. See §8.

### Beat 24 — emancipation into enterprise — **empty**

**Nothing, and I rejected a tempting near-miss.** In the Moss transcript at roughly
2876–2941 s he dates the earliest barbecue stands to "just on either side of 1900"
and the permanent barbecue restaurants of Lexington, Lockhart and Owensboro to the
early 20th century. That is beat 24's chronology of the move to fixed premises with
the *entire* claim removed: nothing about who, nothing about pit skill being capital
that freedpeople already owned, nothing about the absence of credit. Cutting it
would produce precisely the failure beat 21 warns against — the history arriving as
a date while the authorship is dropped. Not cut.

**Chain hole.** This is the causal link between beat 21 and every commercial beat
after it, and the beat that makes the act a history of agency rather than only of
extraction. Juneteenth and Emancipation Day barbecues are lost with it.

### Beat 25 — the style map as Black migration — **empty**

**Nothing.** No tape addresses the Great Migration, the routes, or forms that exist
only in the destination.

**Chain hole.** It is the mechanism behind beats 28 and 29, and without it Kansas
City and Chicago read as spontaneous local inventions.

### Beat 26 — Texas is four traditions — **empty**

**Nothing.** No segment, and no identified source, covers the butcher-shop lineage,
East Texas, the Rio Grande or West Texas, or dates brisket's rise.

**Chain hole in the internal fan.** §5 predicted beat 26 would be **over-supplied**
and named it a bloat risk. It is empty — see §5 of this report.

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

### Beat 30 — policy produced the invisibility — **empty**

**Nothing**, and §5 predicted it, correctly noting the material lives in urban
history rather than food podcasting.

**Chain hole, and it is the act's endpoint.** Without beat 30 the listener is left
to invent an answer to the question the act has been building — if Black cooks
authored this, why does the famous map not look like it — and Act V's revival has
nothing specific to be a revival from.

---

## 6. Act V — the re-pricing (chain, beats 31–40)

### Beat 31 — refrigeration ended the necessity — **empty**

**Nothing usable, and one identified candidate.** The recommendation pool contains
`Gastropod — The Birth of Cool: How Refrigeration Changed Everything` (49 min),
which is this beat's subject exactly. It is blocked twice over:
`grilling-asr-manifest.json` excludes Gastropod by instruction, and its measured ad
ratio of 1.080 on a 49-minute episode is roughly 235 s of injection, well past
ADR-0008's 120 s threshold. It publishes no transcript at the URL I checked.

**Rejected near-miss:** `bfh-medieval-meals-manners#1543` mentions that without
refrigeration the lady of the house planned feasts far ahead. That is medieval feast
logistics, it is drift material, and it advances nothing about smoked food surviving
as a taste after its function ended.

**Chain hole, and it is the act's hinge.** The spine added beat 31 in revision
precisely because beat 2 argues smoke is infrastructure and Act V assumes it stopped
being so, with nothing narrating the transition. With both beat 2 and beat 31 empty,
the Foray's central irony is asserted and never explained at either end.

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

**What narration owes.** The beat's briquette detail — mill waste sold as a 1920s
by-product — is named in the tape only as "Henry Ford and Kingsford charcoal came
along", so the origin story itself is a narration line.

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
publishes no transcript. Of 1,861 items in that feed only 12 carry a
`<podcast:transcript>` tag, and only one of those is on plot: the Moss BBQ School
episode already segmented here.

**Chain hole.** §5 predicted beat 36 would be over-supplied. It is empty — see §5 of
this report.

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

### Beat 38 — the authorship argument, unconcluded — **empty**

**Nothing.** The Adrian Miller episode is the identified source — *Black Smoke:
African Americans and the United States of Barbecue* is one of the works this beat's
argument runs through — and it is untranscribed.

**Chain hole, and it is the beat that makes the Foray current.** The spine warns that
the failure mode here is a single sentence of credit inside a segment about something
else. With the beat empty, the risk is worse: an entire Foray whose authorship
argument exists only in narration written by the same process that produced the
bakestone version. Beats 21, 22, 30 and 38 stand or fall together, and one
transcription would give all four a chance at tape.

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

| Verdict | Beats | Which |
|---|---|---|
| **Strong** | **6** | 1, 4, 5, 14, 15, 32 |
| **Thin** | **6** | 2, 6, 9, 23, 27, 37 |
| **Empty** | **28** | 3, 7, 8, 10, 11, 12, 13, 16–22, 24–26, 28–31, 33–36, 38, 39, 40 |

Beat 4's strong verdict depends on minting the proposed new cut. On the existing
`#3315` alone it is thin, which would make the counts 5 / 7 / 28.

### Where the holes fall — chain versus fan

This is the part of the report that matters most, and it inverts the spine's hope.

| Act | Structure | Strong | Thin | Empty |
|---|---|---|---|---|
| I (1–5) | chain | 3 | 1 | 1 |
| II (6–7) | chain | 0 | 1 | 1 |
| III (8–15) | **fan** | 2 | 1 | 5 |
| IV (16–30) | chain | **0** | 2 | **13** |
| V (31–40) | chain | 1 | 1 | 8 |

**Of the 28 empty beats, 23 are in chains and 5 are in the fan.** The spine
established that a fan break reads as a change of subject and a chain break reads as
a hole, and concluded that Act III is the safest place to come back thin and Act IV
the most dangerous. Both halves of that are now measured, and the news is bad in the
predicted direction:

- **Act IV is a fifteen-beat chain with no strong tape at all**, 36.5 % of the
  spine's runtime, and its four authorship beats — 20, 21, 22, 30, the 12 % the spine
  calls the honest weight — are empty simultaneously. As a listening experience this
  is not thirteen small holes; it is one hole where the act was.
- **Act V is a ten-beat chain with one strong beat**, and the empty beats include
  its hinge (31) and its peak (38).
- **Act III's five empty beats are the least of the problem**, exactly as designed,
  and three of them — 10 (tandoor), 13 (braai), and beat 9's mangal root — are
  *proven unsourceable* rather than merely unsourced. Those are answers. Two more,
  11 (yakitori) and 12 (Korea), are empty only under the English-only rule.
- **Act I holds up**, which matches the founder's field report that the content
  started good. Three of its five beats are strong and its one empty beat (3) is
  narratable.

### Projected runtime from the strong beats alone

| Beat | Segments | Seconds |
|---|---|---|
| 1 | `origin-stories-cooking-human#147` + `#678` | 239 |
| 4 | proposed `bbqc-moss-school` 3106.36 → 3215.23 | 109 |
| 5 | `bbqrn-argentina-open-fire#1437` | 79 |
| 14 | `bbqrn-argentina-open-fire#1205` + `#700` | 277 |
| 15 | `moreish-jerk-jamaica#266` + `#555` | 322 |
| 32 | `bbqc-moss-school#2941` | 127 |
| | **9 segments** | **1,153 s — 19.2 min** |

**Nineteen minutes of tape, honestly on plot, across 6 of 40 beats.** Admitting the
thin beats' partial cuts underneath narration adds `#2572` (151 s) and `#2779` (98 s)
and, if the satay passage is minted, 80 s — **about 24.7 min across 12 segments**.
Neither figure is a runtime for the Foray: the other 28 beats are narration, and
narration length is stage 4's to estimate.

The cut budget is not a constraint at this size, which is worth stating because §4a
of the spine is written on the assumption that it would be. At a runtime under 45
minutes `d1Budget()` allows **8** starts per rolling 600 s, and twelve segments
across roughly 25 minutes averages about 4.8. D3's mean of ≥ 90 s passes
comfortably — 128 s on the strong beats alone, 124 s with the thin cuts added — and
D5's whole-Foray IQR of ≥ 45 s passes at about 63 s on the strong nine. **The spine
was sized for a scarcity of runtime and what it met was a scarcity of tape.**

### The 32 existing segments, scored

| Outcome | Count | Segments |
|---|---|---|
| Carries a strong beat | **8** | `origin#147`, `origin#678`, `bbqrn#1437`, `bbqrn#1205`, `bbqrn#700`, `moreish#266`, `moreish#555`, `moss#2941` |
| Carries a thin beat | **2** | `moss#2572` (23), `moss#2779` (37) |
| Credible alternate | **4** | `origin#448` (1), `moss#3315` (4), `bfh-18c#2011` (4), `bbqrn#1005` (14) |
| **Survives in some role** | **14** | |
| Rejected — off-beat | **18** | see below |

**14 of 32 survive; 10 of them are actually assigned to a beat.** The four
grilling segments outside the current Foray (`moss#1881`, `traeger#2457`,
`bbqrn#2292`, `bfh-griddle#1360`) all fail too, so of 36 grilling segments in the
pool, 14 survive.

The 18 rejections, with the beat each was scored against and the reason:

- `bfh-griddle-bakestone#740`, `#968`, `#1691`, `#1971` and `bfh-18c-tavern-briggs#940`,
  `#1484`, `#1871` — scored against beats 2, 3, 6 and 7. British hearth cookery,
  bakestones, Welsh cakes, bannocks, Yorkshire pudding and an 18th-century cook's
  cause of death. None advances a claim about fire, smoke, surplus or the labour of
  the pit. §6b of the spine names general food history as never having been a beat.
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
- `bbqrn-argentina-open-fire#2292` — scored against beat 5. Patagonian lamb tasting
  salty from sea spray on the grass is terroir colour, and at 59 s it is below the
  target band as well.
- `bbqc-traeger-history#1079`, `#1987`, `#2340`, `#2457` — scored against beats 34, 35
  and 39. Traeger's COVID boom and IPO, grill price tiers, boutique charcoal
  distribution, Kingsford's market share. §6b excludes equipment and gear history
  except where it carries a social argument, and none of these does.
- `bbqc-moss-school#1881` — scored against beats 3 and 4. Grill marks as Maillard
  browning is grilling technique inside a cast-iron gear discussion, and beat 3 is
  about the low-and-slow bargain.

**The `bfh-*` prediction held almost exactly.** Of the 13 `bfh-*` segments in the
pool — the griddle, bakestone, medieval-manners and 18th-century-tavern material the
founder identified as the drift — **exactly one survives**, `#2011`, and only as an
alternate. Each was scored against a beat rather than dismissed by reputation, and
the outcome is that reputation was right.

### How §5's predictions did

The spine recorded its predictions so that this report could check them, so:

**Likely-narration predictions: 10 of 13 correct.** Beats 10, 8, 20, 33, 29, 22, 30,
17, 31 and 13 all came back empty as predicted, and 40 was designed that way. Two
were inverted:

- **Beat 5 came back strong**, where §5 ranked it eighth-hardest. The reasoning was
  right — no tape states the rule — but a practitioner stating the mechanism turned
  out to be enough to carry the beat with one narration sentence.
- **Beat 9's halves swapped.** §5 predicted the kebab material would exist and the
  satay economics would not. In fact satay is the half that exists and the entire
  Ottoman root is unsourceable.

**Over-supply predictions: 1 of 5 correct.** §5 named beats 3, 26, 36, 37 and 1 as
the places the Foray would bloat if anyone let it. **Beat 1 is over-supplied and was
capped at two segments. Beats 3, 26 and 36 are empty and beat 37 is thin.**

This is the single most useful thing the predictions revealed, and it changes what
stage 4 should be defending against. The spine reasoned from what English-language
podcasting covers, which was sound, but the pool is not English-language podcasting
— it is nine hand-picked episodes plus a recommendation pool of 1,489 items with
almost no barbecue history in it. **The fill pressure the spine was designed to
resist does not exist here.** There is no pile of Texas or competition or brisket
tape waiting to bloat Act IV. The live risk is the opposite one: a Foray that is
mostly narration, in which the narration quietly becomes the place the drift
happens, because nobody is scoring prose against the beats the way this report
scored tape.

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
about it elsewhere. **Recommendation:** revise
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
Santa Maria — a style for which this project holds two sourced episodes and a
segment. That is defensible on runtime, and beat 29 arguably absorbs it in
principle, but the omission should be recorded in §6b so that the next sourcing pass
does not keep re-finding Santa Maria tape and wondering where it goes.

---

## 9. Recommended next actions, in value order

Not decisions — this report does not own them. Ordered by how many beats each moves.

1. **Transcribe `The Grill Coach — Adrian Miller and The History of BBQ` (3,306 s,
   English, ad-free, currently priority 3).** It is the only identified English
   source for beats 18, 20, 21, 22 and 38, including the Foray's load-bearing beat,
   and its own episode description commits it to indigenous roots, African American
   authorship and the present state of the argument. **The ASR work order's
   priorities are now wrong against the spine:** priority 1 holds sources for beats
   that are already strong from existing cuts (beat 1 from Origin Stories, beat 15
   from Moreish, beat 14 from the asado episode) and one — Santa Maria — for a beat
   that does not exist. The top of that queue buys almost nothing and the bottom
   buys Act IV.
2. **Transcribe `The Moreish Podcast — Caribbean Food History with Dr. Candice
   Goucher` (3,466 s, English, priority 2).** Best unread candidate for beat 20, and
   likely useful to beats 2 and 15.
3. **Re-transcribe `bbqrn-argentina-open-fire` and `origin-stories-cooking-human`.**
   Their local ASR is gone, they are the two episodes whose existing cuts already
   carry strong beats, and beat 14 is demonstrably under-cut — the asador as a social
   office is the thing beat 21's contrast needs and no existing cut contains it.
4. **Mint the beat 4 cut** specified in §3, through `merge-segments.mjs` with the
   published SRT as the transcript body, so the pool's anchor conventions stay
   consistent.
5. **Get a founder decision on mixed-language audio.** It is the only thing standing
   between the Foray and beats 11, 12 and 17, and `catalogue-broadening.md` §3 has
   been waiting on it since 2026-08-16. It is a product decision, not a sourcing one.
6. **Decide the three §8 questions** before stage 4 writes narration, because two of
   them change what the narration says.

One thing this report deliberately does not recommend: broadening the sourcing again
to close Act IV. The 4.71M-feed pass has already been run and its answers are
recorded. Act IV's holes are not a search problem, they are a transcription problem
for one episode and a narration problem for the rest — and the temptation to fill
them by widening the net until something fits is the exact mechanism #226 was opened
to stop.
