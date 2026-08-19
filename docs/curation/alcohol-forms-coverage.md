# Coverage report — all the forms of alcohol (`alcohol-forms-1`)

Stage 2 of #226. The spine (`docs/curation/alcohol-forms-spine.md`, 63 beats in six
acts) was written source-blind by stage 1. This document scores the available tape
against it, beat by beat and independently, and reports where the tape fits the
spine — which, in this subject, is almost nowhere.

**Status:** proposed. This is a coverage report, not a playlist.

**Measured at `main` = `8d2636c`.** `data/discover.json` is being changed by a
concurrent mobile-bundle pass, so every count taken over it is stated against that
commit: 1,534 items, `built_at` 2026-08-18T11:43:23.489Z, 1,770,685 bytes.

**Nothing was cut, nothing was transcribed, and `data/forays.json`,
`data/segments.json` and `data/segment-sources.json` are untouched.** `data/` was
read and not written. The only file this pass adds is this one. Sixteen candidate
spans are specified below precisely enough for a later stage to mint them through
`merge-segments.mjs`; none is minted here.

---

## 0. The finding, stated first, because it is mostly a refusal

> **Sixty-three beats were searched. One comes back strong, fifteen come back thin,
> and forty-seven come back empty — and thirty of those forty-seven empty beats are
> chain beats. The whole of Act I, which is the education the founder actually asked
> for, has no strong tape at all: sixteen consecutive chain beats, thirteen of them
> empty. The catalogue cannot support this subject as the spine defines it.**

That is not a judgement about the spine. It is a measurement of a catalogue that
holds, in its curated form, exactly **three** shows on drink or fermentation of any
kind — Craft Beer & Brewing Magazine Podcast, Experimental Brewing and FermUp — all
three on beer or food fermentation, none on wine, spirits, sake, cider or the
fortified wines, and **none of the three carrying a publisher transcript**. There is
no wine show, no whisky show, no distilling show, no East Asian brewing show. The
vocabulary sweep in §2b is the blunt form of the same fact: across 1,534 discover
items and 73,719 archived episodes, `koji` returns 0, `agave` 0, `mezcal` 0, `pulque`
0, `sorghum` 0, `cassava` 0, `arrack` 0, `kumis` 0, `chicha` 0, `phylloxera` 0,
`solera` 0, `madeira` 0, `vermouth` 0, `grappa` 0, `azeotrope` 0, `congener` 0,
`thujone` 0, `gentian` 0.

**The second finding is that the one readable body of material fails the beats
rather than the search.** Stuff You Should Know ships timed transcripts on 2,850 of
its 2,858 episodes and has a genuine drinks cluster — beer, champagne, gin, absinthe,
amaro, whisky, moonshine. Thirteen of those transcripts were fetched and read in this
pass. They carry a large amount of on-subject material and they repeatedly assert
exactly the things the beats were written to correct: beat 28's error about lager
fermenting near freezing, which the spine's own §8 records removing; beat 20's monk
myth, asserted; beat 11's "the alcohol boils off first", asserted twice; and beat
13's claim inverted outright, since the only tape on the subject says people die from
drinking badly made moonshine, which is the folklore beat 13 exists to refuse.

**The third finding is the useful one for whoever schedules work next.** The best tape
in this pass is not from a drinks show at all. It is an engineering-careers podcast
interviewing a chemist who spent two and a half years as a production brewer, and it
produces the report's only **strong** verdict, on beat 26. The pattern that
generalises: in this catalogue, process-at-mechanism-depth turns up where a
technically trained person is being asked about their old job, not where a drinks
show is talking about drink.

**So the answer to "can this Foray be built" is: not from this catalogue.** §11 sets
out what would change that, and it is a catalogue action rather than a transcription
action — the podcast ecosystem is full of the right shows and this catalogue holds
almost none of them. `data/catalog-breadth.json` alone lists **81** drinks-shaped
shows, from `I'll Drink to That! Wine Talk` (504 episodes) to `Inside Winemaking`
(222) to `Cider Chat` (511) to `Spirits & Distilling Podcast`, and **80 of the 81
have `in_curated: false`**.

---

## 1. The rule this document was written under

From the founder, on #226:

> "if we have content that is irrelevant, don't distort the narrative just to use
> more podcast content. Keep it mostly on topic"

Operationally: a segment earns its place by advancing the claim of the beat it is
assigned to, not by being about drink, or fermentation, or history, or a distillery.
Good tape that does not advance its beat is rejected. A beat that comes back empty
stays empty.

Four consequences that shaped the work.

- **A beat is covered by one strong segment.** §4a of the spine derives a cut budget
  of at most 75 segments for a 150-minute Foray and says plainly that hunting for
  more per beat is what manufactures fill pressure. Each beat below records the best
  candidate and, where one exists, a credible alternate. **Exactly one beat in this
  report carries two segments** — beat 14, which is one of the twelve beats §4a
  nominates for a second — and it carries two because the two halves advance
  different parts of one claim.
- **"Thin" does not mean covered.** A thin beat is a **narration beat** that happens
  to have a partial supporting cut available. Every thin verdict below states what is
  missing so that stage 4's narration can supply it.
- **Empty is a result.** Forty-seven times below, the answer is nothing, and in
  nineteen of those cases the spine's §5 predicted it. §9c scores the predictions.
- **Label, never exclude.** Nothing is dropped from the catalogue. §10c lists every
  rejection with its reason, and several rejections are good episodes a playlist
  should keep — the Odd Lots white-oak episode most of all.

### 1a. What "strong" was allowed to mean, because it decides the headline number

This matters more here than it did for barbecue, so the gate is written down before
any verdict uses it. A beat is **strong** only where all four hold:

1. the passage was **read** in a transcript, not inferred from a title, hook or tag;
2. the speaker has **sourced expertise** in the thing being claimed — the authority
   gate this project has applied since `grilling-history-coverage.md` §2b, where
   Stuff You Should Know was admitted on relevance and graded thin on authority, and
   where Gurmelik Denemeleri was rejected for "hosts riffing with no sourced
   expertise";
3. the passage advances the **beat's claim**, not one clause of it;
4. it is **cuttable** inside the 75–180 s band without double-booking a passage that
   another beat is already using.

Test 2 is what caps this report at one strong beat. Of the eighteen transcripts read,
**fourteen are Stuff You Should Know or a home-improvement show's whiskey hour**, and
those cannot reach strong however squarely they hit — the grilling report set that
precedent deliberately and reversing it here would be reversing it silently. Four
readable sources pass test 2: a chemist-brewer on Being an Engineer, two
epidemiologists on This Podcast Will Kill You, a forest-health researcher on Odd
Lots, and — on one narrow point — a building-materials specialist who turns out to
know the cask trade.

**Whether a general-interest show of the SYSK register belongs in this Foray at all
is a founder call, not mine**, and it is worth making explicitly, because it moves
the counts. If the register is ruled **out**, eleven of the fifteen thin verdicts go
back to empty and the report reads **1 strong / 4 thin / 58 empty**. If it is ruled
**in** as thin tape, the counts stand as reported. Nothing in this report grades it
strong under either ruling.

---

## 2. What "available" turned out to mean

| Source of material | Size at `8d2636c` | Scoreable at beat level? |
|---|---|---|
| Segments in `data/segments.json` on drink subjects | **0** of 69 | n/a — there is no alcohol tape in the pool |
| `data/segment-sources.json` | 19 sources, **0** on drink | n/a |
| `data/discover.json` | 1,534 items; **20** reach a beat closely enough to score | Only where a transcript can be read — and none of the 20 can be |
| `data/catalog.json` | 213 shows; **3** on drink or fermentation | show-level register only |
| `data/transcript-availability.json` | 213 shows, 8,191 episode rows (its own summary counts 8,012 with a transcript) | **Yes** — this is the readable pool, and it is where every verdict that moved came from |
| `data/episode-archive.json.gz` | 98 shows, 73,719 episodes with descriptions | Title and description only; two rows worth buying |
| `data/catalog-breadth.json` | 19,787 shows, show-level only | **No** — no episode lists. §11's recommendation lives here |
| `data/catalog-breadth-intl.json.gz` | 121,786 shows, show-level only | **No**, same reason |

Four facts about that table do most of the work below.

**There is no alcohol tape in the pool at all.** All 69 segments in
`data/segments.json` belong to the grilling and capital Forays. So unlike barbecue's
stage 2, which had 36 existing cuts to score, this pass starts from zero and every
candidate below is a *proposed* span in an unminted source. That is the single
biggest structural difference between the two reports and it is why §9's runtime
figures are all conditional.

**The readable pool is much larger than the recommendation pool, and it is the one
that mattered.** Searching `transcript-availability.json` rather than
`discover.json` is what found every candidate in this report except one. Nine shows
have a drinks-shaped episode with a transcript; four turned out to be usable. The
recommendation pool's twenty on-plot items, by contrast, have **zero** publisher
transcripts between them — Craft Beer & Brewing 0 of 497, Experimental Brewing 0 of
386, FermUp 0 of 100, Gastropod 0 of 293, The Rest Is History 0 of 713. Every one of
them is an ASR purchase, which is what §10 is a queue of.

**Transcript bodies were fetched, and nothing was stored in `data/`.** Eighteen
publisher transcripts were fetched to a scratch directory outside the repository and
read. `transcript-availability.json`'s own policy line —
*"availability index only — transcript bodies are never fetched or stored (issue
#104)"* — is a rule about that index file, not a prohibition on reading a publisher's
transcript; `grilling-history-coverage.md` §2b established the practice and called it
the cheapest action available. It was again: one fetch per episode, and it is the
reason this report has verdicts rather than guesses.

**Every readable source is DAI-suspected.** All four sources that produced a verdict
sit behind dynamic ad insertion — SYSK on `omny.fm`, Odd Lots and This Podcast Will
Kill You on `tritondigital.com`, Being an Engineer on `buzzsprout.com`, all with
`dai_suspected: true`. Under `ADR-0008` that makes every span below
**authorable now and playable once the locate step exists**, exactly as SYSK was for
barbecue. **Nothing in this report can be played today.** Timestamps are against the
publisher's own transcript timeline.

### 2a. A note on the quotations, because several are load-bearing

Every transcript read here is machine-generated and undiarized or lightly diarized.
Quotations are reproduced **as the transcript holds them, garbles included** — "Rheine
Heights boat" for Reinheitsgebot, "the ver moot" for Wermut, "Chinchona" for
cinchona, "mass rating" for macerating, "through jone" for thujone, "wart" for wort,
"quircus alba" for *Quercus alba*. Nothing is repaired. An agent this week silently
tidied an ASR garble inside a block quote that was the evidence for a spine
amendment, and the rule that prevents it is that the quoted text is the text an
anchor check would have to match. Where wording matters to a verdict I have said so;
anyone writing narration against these passages should listen at the timestamp given.

The only liberty taken is the ordinary one of lowering a quoted sentence's initial
capital when it sits inside a sentence of ours.

### 2b. The matcher, the substring trap, and the vocabulary sweep

**The matcher is the shipped one.** `hitText` and `hitTag` are imported from
`search-engine.js` rather than reimplemented, and inputs are lowercased before
matching the way `scoreMatch` lowercases them — a harness that skips that step reads
every capitalised drink name as absent. The full query path
(`interpretQuery` → `searchWithRelaxation` → `classifyResults`) was **not** used for
any count here, because a ranked, tiered result list answers a different question
than "which items contain this word".

**One property of the shipped matcher had to be worked around and it is worth
recording.** `LONG_INFLECTIONS` is `(?:s|es|ing)?`, so `hitText` matches `malting`
and `malts` but **not** `malted`; `ferment` does not match `fermented` or
`fermentation`; `distil` does not match `distilled` or `distillation`. Every sweep
below therefore searches a **family of surface forms** per concept rather than a
stem, and the families are listed where a count is load-bearing. A single-stem sweep
of this subject would have under-reported it badly.

**The substring trap, re-measured on this catalogue.** The previous round was misled
by a table built with `includes()`, where `pit` matched "despite" and `fire` matched
"firearms". The same collision class on this subject's vocabulary, over the 1,534
discover items:

| term | naive `includes()` | word boundary | overstatement |
|---|---|---|---|
| `gin` | **304** | **0** | ∞ — "engine", "engineering", "imagined", "original", "bringing", "forging" |
| `ale` | 111 | 0 | ∞ — "scale", "whale", "female", "tales", "lauderdale", "alexander" |
| `port` | 136 | 2 | 68× — "report", "sports", "airport", "portfolio", "portugal", and both survivors are seaports |
| `rum` | 32 | 0 | ∞ — "trump", "truman", "drum", "spectrum", "serum", "rumination" |
| `still` | 24 | **20** | 1.2× — and see below, because this is the one that word boundaries cannot save |
| `beer` | 16 | 16 | — |

**`gin`, `ale` and `rum` are the `pit` of this subject**, and all three come back to
zero on this catalogue after word boundaries. A vocabulary table built the old way
would have reported three hundred and four gin items, and every one of them would
have been a mirage — `gin` alone would have overstated this catalogue's drinks
holding by more than the whole of its real food and drink holding.

**`still` is the harder case and it deserves its own line, because it is the term a
distillation search most wants.** Word boundaries reduce 24 naive hits to 20, and
**all 20 are the adverb**: "why it still matters", "what waterlogged textiles can
still tell us", "why Airtable's sale is still a win". There is no fix for this inside
the matcher, because the adverb *is* the word — the only defence is reading, and the
20 were read. The distilling sense appears zero times.

**The sweep itself.** Word-boundary counts, families collapsed to their headline
term, over discover (1,534 items) and the episode archive (73,719 episodes):

| term | discover | archive | term | discover | archive |
|---|---|---|---|---|---|
| `koji` | 0 | 0 | `phylloxera` | 0 | 0 |
| `baijiu` | 0 | 0 | `rootstock` | 0 | 0 |
| `soju` | 0 | 0 | `malolactic` | 0 | 0 |
| `shochu` | 0 | 0 | `solera` | 0 | 0 |
| `huangjiu` | 0 | 0 | `estufagem` | 0 | 0 |
| `makgeolli` | 0 | 0 | `madeira` | 0 | 0 |
| `agave` | 0 | 0 | `vermouth` | 0 | 0 |
| `mezcal` | 0 | 0 | `aquavit` | 0 | 0 |
| `sotol` | 0 | 0 | `grappa` | 0 | 0 |
| `pulque` | 0 | 0 | `slivovitz` | 0 | 0 |
| `arrack` | 0 | 0 | `calvados` | 0 | 0 |
| `kumis` | 0 | 0 | `pisco` | 0 | 0 |
| `chicha` | 0 | 0 | `armagnac` | 0 | 0 |
| `cassava` | 0 | 0 | `azeotrope` | 0 | 0 |
| `sorghum` | 0 | 0 | `congener` | 0 | 0 |
| `keeving` | 0 | 0 | `thujone` | 0 | 0 |
| `qvevri` | 0 | 0 | `gentian` | 0 | 0 |
| `lambic` | 0 | 0 | `cinchona` | 0 | 0 |
| `gruit` | 0 | 0 | `wormwood` | 0 | 0 |
| `diastatic` | 0 | 0 | `disgorgement` | 0 | 0 |
| `maltster` | 0 | 0 | `riddling` | 0 | 0 |

Twenty-one of those forty-two terms were chosen to try to **break** the finding
rather than to confirm it — `keeving`, `diastatic`, `maltster`, `rootstock`,
`malolactic`, `azeotrope`, `congener` and `disgorgement` are all terms a genuinely
technical drinks show would use in passing — and not one of them returns anything.
The two that do appear in a read transcript, `wormwood` and `cinchona`, appear only
inside the two SYSK episodes and are counted there, not here, because
`transcript-availability.json` indexes titles rather than bodies.

### 2c. The neighbouring-beat trap, which fires here harder than it did on barbecue

Barbecue's stage 2 was misled once by beats 15 and 20 sharing almost all their nouns.
This spine has whole families of adjacent beats and the trap fires four times, in
three different shapes. All four are recorded at the beat rather than hidden in a
count.

- **Two beats, one inseparable passage.** The chemist-brewer's 100-second walkthrough
  contains both beat 26's fixed sequence and beat 27's alpha-acid isomerisation, and
  the transcript's cue granularity in that stretch is 21 to 68 seconds, so the hops
  sentence cannot be timed out of the middle of it. Beat 26 takes the passage; **beat
  27 is thin by dependency**, which is the same outcome barbecue's beat 2 reached
  against beat 15's carrier.
- **A hit that is evidence for a region.** The amaro episode is evidence for
  {57, 58} and not for either specifically. Its extraction passage is beat 57's and
  its bitter-compound passage is beat 58's, and each beat's *own* distinguishing
  claim — the legal sugar minimum for 57, the real-versus-patent-medicine split for
  58 — is in neither.
- **The false friend the spine warned about.** Beat 50 names the eastern
  Mediterranean `arak` as a false friend of Sri Lankan `arrack`. Both are 0, so the
  trap cannot fire — but `sake` returns **25** archive hits and **every one** is "for
  the sake of", including four inside Stuff You Should Know itself. On this catalogue
  the sense collision, not the family overlap, is what would have produced a false
  East Asian coverage claim.
- **Names and brands wearing drink words.** `dunder` returns 2, both Dunder Mifflin.
  `flor` returns 13, all surnames — Flores, Dan Flores. `perry` returns 131, mostly
  Rick Perry and Katy Perry. `marc` returns 131, mostly Marc Maron and Marc
  Andreessen. `millet` returns 1 and it is Millet's *Angelus*. `adjunct` returns 13
  and every one is an adjunct professor. `cider` returns 2 and both are Netflix's
  *Apple Cider Vinegar*.

### 2d. The seventeen transcripts read, and what each was worth

| Transcript | Length | Register | Verdict |
|---|---|---|---|
| `being-an-engineer` — S1E33 Beer, Kenya & DIY Chemistry | 2,885 s | chemist, ex-production brewer | **The best source in the pass.** Beat 26 strong; beat 30 thin |
| `this-podcast-will-kill-you` — Ep 85 Alcohol: Beer for Thought | 6,568 s | two PhD epidemiologists | Beat 36 thin. Otherwise it is §6a's dropped pharmacology beat, at length |
| `odd-lots` — The White Oak Shortage… | 2,836 s | forest-health researcher | Beat 14 thin, on cooperage rather than maturation. A spine finding — §11 |
| `around-the-house-eric-g` — The Whiskey Hour | 1,493 s | enthusiast plus a trade guest | Beat 14's second segment, and nothing else |
| SYSK — Everything You Ever Wanted to Know About Gin | 2,922 s | two hosts, no guest | Beats 41, 42 and 12 thin. The most productive SYSK row |
| SYSK — How Champagne Works | 3,580 s | ditto | Beat 20 thin, and the monk myth asserted |
| SYSK — Short Stuff: Whisky or Bourbon? | 806 s | ditto | Beats 39 and 61 thin, with the standard misstated twice |
| SYSK — That's Amaro! | 3,226 s | ditto | Beats 57 and 58 thin |
| SYSK — The Myth of Absinthe | 3,020 s | ditto | Beat 59 thin, and better on the bans than on the chemistry |
| SYSK — Short Stuff: The Guinness Widget | 956 s | ditto | Beat 3 thin, on the third of its three moves |
| SYSK — SYSK Selects: How Beer Works | 2,903 s | ditto | **Nothing.** Fails beats 7, 26, 27, 28 and 35 on their own reject lines |
| SYSK — How Moonshine Works | 1,478 s | ditto | **Nothing**, and it inverts beat 13 |
| SYSK — Sugar: It Powers the Earth | 2,621 s | ditto | Beat 43 thin, on a 64 s clause |
| SYSK — Honey: Nature's Wonder Sugar | 3,245 s | ditto | **Nothing** for beat 23 |
| SYSK — How Wine Fraud Works | 2,857 s | ditto | **Nothing** — §6b collecting and investment, start to finish |
| SYSK — How Whiskey Runners Worked | 1,848 s | ditto | **Nothing** — §6b prohibition and crime |
| SYSK — Kombucha: Fizzy Goodness | 2,822 s | ditto | **Nothing** — §6a's dropped low-alcohol ferments |

**Seventeen transcripts, six of which moved nothing at all.** That ratio is the
finding rather than a disappointment: it is what a general-listening catalogue looks
like when it is asked a sixty-three-beat question about production mechanism.

**Two readable SYSK rows were deliberately not read**, and naming them is what makes
the list auditable: `Prohibition: Turns Out That America Loves to Drink` (2,377 s) and
`Marijuana Vs. Alcohol: Which Is Worse For You?` (3,102 s). Both are §6b by name —
prohibition and policy, and alcohol and health — and §6b's whole function is that the
boundary is decided in advance rather than after a fetch. Reading them could only
produce material for beats that do not exist. Three more were left unread on the same
grounds: `Short Stuff: Cleveland's Infamous 10-Cent Beer Night`, `The Guinness Book
of Records` and `SYSK Live: How Bars Work`.

---

## 3. Act I — one molecule, four questions (chain, beats 1–16)

The act the founder's request is actually for, and the act the spine predicted would
be thinnest. It is thinner than that. **Sixteen consecutive chain beats, no strong
tape, three thin, thirteen empty**, and the three thin ones are 3, 12 and 14 — the
gas, the column and the cask — which are the three most equipment-shaped beats in the
act. Everything that is chemistry rather than hardware is empty.

The spine's §2a says a hole here is "a broken explanation" and carries the highest
cost in the document. On this catalogue Act I is not holed, it is absent, and stage 4
should plan for it as sixteen narration beats with three supporting cuts rather than
as an act with gaps.

### Beat 1 — many alcohols, we drink one — **empty**

**Nothing.** The nearest candidate is `this-podcast-will-kill-you` Ep 85 at
536.92 → 561.56, which states the distinction and stops: *"Ethanol is the form of
alcohol that we drink. It's the form that's used for recreational purposes. So when
we say alcohol, that's what we're talking about in this context."* That is the beat's
first clause as a definition, with no second alcohol in it.

**Why the rest of the episode does not rescue it, and why that is worth recording.**
The episode says "alcohol dehydrogenase" thirteen times and it is never once about
methanol. It is about hepatic metabolism, acetaldehyde, the `ALDH` variant and the
flushing response, tolerance and upregulation, and the ten-million-year-old `ADH4`
mutation shared with chimpanzees, gorillas, fruit bats and koalas. **That is §6a's
dropped beat, at forty minutes' length** — the pharmacology beat the spine cut with
the note that it "is also the most dangerous available filler after prohibition,
because it would slot in beside beat 1 without looking wrong." The prediction is
exactly right, the tape exists, and it is not this beat. `methanol` appears once in
6,568 seconds, inside a sentence about Prohibition-era regulatory oversight.

**What is missing.** All of it: the hydroxyl group, ethanol against methanol against
isopropanol, one enzyme acting on all three, formaldehyde and formic acid as the
mechanism by which methanol blinds, and the 40/60/trace proportion the beat wants
stated plainly.

### Beat 2 — fermentation as yeast metabolism — **empty**

**Nothing**, and the near-miss is the exact thing the beat's reject line names. The
chemist-brewer on Being an Engineer says at 476.76 → 485.34: *"you have this living
organism, this yeast molecule that is converting sugars into alcohol and carbon
dioxide."* Beat 2 rejects *"'yeast turns sugar into alcohol' with no mechanism and no
numbers — that is a label, not this beat"*, and this is that sentence with "molecule"
in place of "organism" as a bonus error. The passage is also inside beat 26's carrier.

**What is missing.** The stoichiometry — one glucose to two ethanol and two CO2 — the
51 % theoretical yield and the 46 to 48 % real one, glycolysis through pyruvate and
acetaldehyde, and gravity or Brix used as a working instrument. No transcript in the
readable pool contains any of it: `glycolysis`, `pyruvate` and `brix` are zero across
every source read.

**The identified fix.** `fermup--93-researching-fermentation` (2,807 s), hook *"A
researcher explains what actually happens, chemically, when food ferments."* It is
§10's top-ranked purchase and the only row in the catalogue whose description promises
this beat.

### Beat 3 — the other product is a gas — **thin**

**Chosen:** `stuff-you-should-know` — Short Stuff: The Guinness Widget, band
**313.16 → 395.48 (82.3 s)**. In on *"glass right after this. All right, So where we
left off"*; out around *"…it forms smaller bubbles and more stable bump bubbles."*

**Why it advances beat 3.** It is the one place in the readable pool where dissolved
gas is treated as a variable a producer chooses rather than a property a drink has:
nitrogen *"doesn't replace the CEO two. It's a mixture of the carbon dioxide and
nitrogen, but nitrogen isn't absorbed into the beer like carbon dioxide is. So it has
the same pressure of just a regular beer, but it has a lot less CO two, and so it's
not as physy"*, and nitrogen *"forms smaller bubbles and more stable bubbles"*. That
is the third of beat 3's three moves — inject the gas afterwards — with a real
solubility argument attached.

**Second, and it is the better half of the pair for the beat's history:** SYSK How
Champagne Works, **812.16 → 857.48 (45.3 s)**, which is beat 3's containment problem
stated as the historical constraint: *"bottles were very frequently explode, and
sellers were very dangerous places to be because one one of these stoppers came out,
it shoot across the room, hit another bottle, and that bottle stop would come out and
all of a sudden you have a chain reaction of these wooden stoppers like flying at your
head"*, resolved with *"cork stoppers in thicker English type bottles which could
withstand the pressure."* At 45 s it is a short supporting cut, above the 30 s floor
and below the band. **It carries a defect**: the passage attributes both the cork and
the English glass to Dom Pérignon, which is the tradition's own account asserted as
fact, and beat 3's reject line is *"champagne romance"*. If it is used, narration has
to correct it in the same breath.

**What is missing.** The CO2 accounting that ties the gas to beat 2's equation, the
five-or-six-atmosphere figure in a fermentation rather than a finished-bottle context,
and any account of what dissolved CO2 does to perceived acidity and aroma delivery.

### Beat 4 — yeast as a domesticated organism — **empty**

**Nothing.** The nearest candidate is `this-podcast-will-kill-you` at
3246.68 → 3272.84 (26 s), which contains the domestication clause and nothing else:
*"it's thought that some strains of yeast associated with wine and sake production
might have been domesticated over twelve thousand years ago."* At 26 s it is below the
hard floor, and the beat needs the other half — that domestication became *repeatable*
once the organism could be isolated.

**What is missing.** Pasteur, Hansen, 1883, pure culture as what changed production
from something that happened to something that could be repeated, and the species
distinctions the beat asks for by name — `cerevisiae`, `pastorianus` as a hybrid,
`Brettanomyces`, the lactose-fermenting yeasts beat 25 needs. `pasteur` returns five
hits in the honey episode, all about pasteurising honey, and one in the Guinness
episode about pasteurised beer. `saccharomyces` returns **zero** across every source
read and every catalogue pool.

**The identified fix.** `craft-beer-and-brewing-magazine-podcast--495-fermenting-expressive-hoppy-beers-with`
(3,913 s), *"How historic brewing yeasts and modern hop chemistry shape today's
expressive hoppy beers"*, recorded in partnership with White Labs. §10 ranks it third.

### Beat 5 — the ABV ceiling — **empty**

**Nothing**, and §5 of the spine ranked this fifth-hardest on the reasoning that
practitioners *"talk around it constantly … without ever naming the constant"*. That
is precisely what happened. `this-podcast-will-kill-you` at 4607.20 → 4646.36 gives
the strengths without the cause: *"Historically, beer and wine averaged maybe two to
four percent or six to twelve percent, respectively … But distilled spirits, like they
can be incredibly alcoholic … the range was typically twenty percent to one hundred
percent."* Two numbers on either side of a ceiling that is never mentioned.

**What is missing.** The whole claim: that ethanol is toxic to the organism making it,
that fermentations stall between 14 and 16 % whatever sugar remains, and the four
routes past it. `tolerance` appears five times in that episode and every one is human
tolerance. Nothing in the readable pool mentions freeze concentration, and nothing
mentions sake's staged ferment.

**This is the most expensive empty beat in the report.** Beat 5 is what makes Act IV a
consequence rather than a new topic, and §4 of the spine marks it as load-bearing and
small. It is narration, and the narration has to be right.

### Beat 6 — free sugar versus locked starch — **empty**

**Nothing.** The chemist-brewer's *"extracting sugars from malt, or barley, or malted
barley, barley being the grain, multi being the process of converting and roasting the
raw form of the grain into a processable form of the grain"* implies the lock without
stating the fork, and it is inside beat 26's carrier in any case. Nothing in the
readable pool contrasts a free-sugar feedstock with a locked one.

**What is missing.** The fork itself, which is what Acts II and III are organised on:
monosaccharides and disaccharides against starch as a polymer, why yeast lacks the
enzymes, and the accident framing — that damaged fruit ferments itself and a barley
field does not. Also missing is the agave third case beat 44 depends on; `agave`
returns 0 everywhere.

### Beat 7 — malting — **empty**, and the one candidate is wrong on the mechanism

**Nothing usable.** SYSK How Beer Works at 1387.68 → 1422.92 describes malting as
*"malted barley or malted grain, which is like dried and cracked and um heated so that
the sugars start to come out a little more. Um. I guess caramelized is another way to
put it."* Malting is enzymatic, not caramelising: the sugars do not "come out", they
are made by amylases the grain manufactures. The passage is beat 7's subject with beat
7's mechanism replaced by a wrong one, and beat 7's reject line is *"brewery-tour
narration of steps with no mechanism"*.

**What is missing.** Alpha- and beta-amylase and the fact that one dies at the
temperature the other prefers, the kiln as the flavour and colour step, diastatic
power, and above all the mash-temperature dial explained causally and used to predict
a finished drink. `amylase` returns **zero** across every source read; `diastatic`
returns zero across both catalogue pools.

### Beat 8 — koji and the mould route — **empty**

**Nothing, and nothing in this catalogue could change it.** `koji` 0, `aspergillus` 0,
`nuruk` 0, `makgeolli` 0, `huangjiu` 0. The word `mold` returns three hits in the
honey episode, all about mould spoiling honey, and one in the beer episode. There is no
East Asian brewing material in the catalogue in any form, which also settles beats 32,
33, 47 and 48.

### Beat 9 — saliva, heat and bought enzymes — **empty**

**Nothing.** §5 ranked this second-hardest and the reasoning holds: three narrow
mechanisms with no natural interview home. `saliva` and `salivary` return zero across
every source read; `enzyme` returns eleven hits in the pharmacology episode, all about
human enzymes, and four in the honey episode, all about bee enzymes.

### Beat 10 — the flavour is in the by-products — **empty**

**Nothing.** The closest the readable pool comes is inside beat 30's carrier, where the
brewer says a barrel's resident organisms *"could have a different effect on on your
beer"* and can give *"an undesirable flavor"* — flavour from an organism rather than
from the ferment's conditions, and committed to another beat.

**What is missing.** Named compounds and their causes: isoamyl acetate and banana,
4-vinyl guaiacol and clove, diacetyl and what conditioning does to it, fusel alcohols
and temperature. `ester`, `diacetyl`, `fusel` and `phenol` return **zero** across every
source read. This is the beat that lets a listener predict flavour from process for the
rest of the Foray, and there is no tape for it at all.

### Beat 11 — distillation concentrates, and stops — **empty**, and this is §5's predicted near-miss

**Nothing**, and the two candidates both assert the picture the beat exists to correct.
SYSK How Moonshine Works, 543.52 → 565.84: *"the alcohol evaporates, pressure builds
up, and the alcohol steam is forced through an arm which is a caparm"*, then a tour of
the thump keg and the worm. SYSK's gin episode, 1886.56 → 1894.12: *"you boil your mash
uh and the alcohol boil that off."*

Beat 11 asks for *"a correction of the 'the alcohol boils off first' picture, since
that picture is wrong in a way that matters"* and rejects *"still tours"*. The catalogue
offers the wrong picture twice and a still tour once. §5 predicted this beat would
attract *"plenty of near-tape … which is the most dangerous kind of near-miss because
it will look like a hit."* It is the prediction this pass confirms most cleanly, and the
verdict is empty rather than thin because the near-tape is not partial — it is
opposite.

**What is missing.** Vapour composition rather than one liquid boiling and the other
not; the azeotrope, its approximate composition and what has to be done to pass it; and
freeze concentration as the contrast. `azeotrope` returns 0 in both catalogue pools and
0 in every transcript read.

### Beat 12 — pot versus column — **thin**

**Chosen:** SYSK Everything You Ever Wanted to Know About Gin, band
**1870.40 → 1985.72 (115.3 s)**. In on *"Flash forward to the eighteen hundreds
eighteen thirty and the invention of the continuous still came about"*; out on *"…which
meant that you could produce chin with a much purer gin. That eventually evolved into
London dry gin."*

**Why it advances beat 12.** All three of the beat's parts are in one span. The batch
limitation: *"a traditional copper pot still, which means that you you can do one thing
at a time … but then you gotta start all over again"*, with the consequence that
*"your a b V is going to be pretty low."* The stages mechanism, loosely but
recognisably: *"these continuous skills or coffee stills after the man who invented
them, it's like the spirit rises through increasingly higher up stages and it's
reheated and heated and heated, and so it becomes pure and pure the higher up it
goes."* And the economic consequence, which the beat calls plain: *"because you could
get pure alcohol um to use as the base spirit for gin, you had less of a funky, foul,
nasty taste that you needed to cover up with stuff like Botanicals or sugar or
turpentine."*

**Why it is thin and not strong.** Register first — two hosts working from an article.
Then the attribution: the beat asks for *"dates and attribution for the column with the
patents named"* and this gives one date and one name, Coffey, where the spine's own
account runs Adam and Bérard in 1801 and 1806, Cellier-Blumenthal's 1813 patent, then
Stein in 1826 and Coffey in 1830. Treating 1830 and Coffey as *the* invention is the
tidy version the spine's §8 corrected in the other direction. Also missing: reflux, the
lyne arm, plates as repeated condensation and re-evaporation stated as such, and hybrid
stills. The same span also contains beat 11's rejected sentence, which is a reason to
trim the in-point carefully.

### Beat 13 — cuts, methanol and the folklore — **empty**, and the only tape says the opposite

**Nothing**, and this is the clearest rejection in the report. SYSK How Moonshine
Works, 814.64 → 840.60, is the only passage in the readable pool about the hazard, and
it is beat 13's claim inverted: *"these these impurities are called congeners, right,
And what those are, it's it's just to catch all name for any impurity that's a complex
compound, like a polyphenol um or histamine, you know, those things that give you
allergic reactions. These can easily end up in your batch. And this is why people often
die from drinking moonshine."*

Beat 13's claim is that distillation *redistributes* methanol rather than removing it,
that the amount depends on the feedstock's pectin, and that *"the mass poisonings that
make the news are almost always industrial methanol added to a drink rather than a
badly run still."* The tape says people die from congeners in home-distilled spirit.
That is not a partial version of the beat, it is the folklore, and admitting it would
forfeit exactly the credibility §3 of the spine says Act I spends its runtime earning.

**What is missing.** The run profile and what comes over when, pectin methylesterase as
the origin of methanol in fruit washes, the legal limits per litre of pure alcohol for
stone-fruit spirits, and the ethanol-as-antidote mechanism. Beat 46 depends on all of
it, and beat 46 is empty too.

### Beat 14 — maturation is four processes — **thin**, on two segments, and neither is the four

**Chosen:** `odd-lots` — The White Oak Shortage That Could Ruin the Bourbon Industry,
band **302.64 → 398.80 (96.2 s)**. In on *"Yeah, so this is where it gets really fun"*;
out on *"…the barrels are expensive and very good."*

**Why it advances beat 14.** A forest-health researcher gives the physical reason the
species is not interchangeable, which is a real mechanism and one the beat's evidence
list asks for: *"wood fibers are just like long straws, and if you put liquids in those
straws, you can actually drink through straw the straws … But if you try to use white
oak as a straw, it doesn't work because white oak has these little Bubbles in the wood
that just develop after the tree is done using those straws to move water up and down
the tree, and so those bubbles prevent liquid from escaping from the barrel itself."*
He then names the three woods that can hold a long-aged spirit — *"There's French yoak,
Hungarian oak, and white oak"* — and *"quircus elbow"* for *Quercus alba*, and closes
the first-fill question: *"you can only use that barrel once. After they use the bourbon
barrel, they usually sell it off to other, you know, liquor distillers because the
barrels are expensive and very good."*

**Second segment:** `around-the-house-eric-g` — The Whiskey Hour, band
**557.91 → 646.09 (88.2 s)**. In on *"It Scotland, the Scotch whiskey industry wouldn't
exist if it weren't for the American bourbon industry"*; out on *"…expand our horizons
in the whiskey business."* This is the other half of the previous-contents variable, and
it is unexpectedly precise for a home-improvement show: ex-bourbon casks shipped
overseas because they cannot be reused domestically, then *"Oloroso sherry casks and PX
sherry casks and rum casks and you name it to add what's called a finishing cask. So it
spends 12 years in ex bourbon, then it goes for another two years in ex Caribbean rum
cask. And it picks up all of those flavors and nuances."* Beat 14 is one of §4a's twelve
two-segment beats and these two advance different parts of one claim, which is the
condition §4a sets. **It is the only two-segment beat in this report.**

**Why the beat is still thin.** Neither segment contains any of the four processes.
There is no extraction chemistry — `vanillin`, `lactone` and `tannin` return zero across
both — no oxidation through the staves, no subtractive role for char, and no evaporative
loss. The beat's own strong signal is *"the subtractive role of char stated explicitly,
because it is the one usually left out"*, and it is left out here too. Also absent:
surface-area-to-volume as the driver of speed, and the honest statement that maturation
has an optimum after which it degrades.

**One error travels with the first segment.** The same speaker introduces bourbon as
*"fifty one percent corn that's distilled three times and put into barrels at eighty
proof"*. Bourbon has no triple-distillation rule and its maximum barrel entry strength
is 125 proof. The band proposed above starts after that sentence, deliberately, and
anyone re-cutting this episode should keep it out.

### Beat 15 — refusing to mature, and other vessels — **empty**

**Nothing.** §5 ranked this fourteenth-hardest on the grounds that it needs a producer
arguing against wood, "a real position but a quiet one". In this catalogue it is a
silent one: `stainless` returns one hit, inside beat 30's carrier and about cleaning a
fermenter, and `qvevri`, `tinaja`, `amphora` and `concrete` return zero. The
whiskey-hour episode argues the opposite position at length.

### Beat 16 — the classification key — **empty by design**

**Nothing, correctly.** §5 ranked this first-hardest and called it *"designed as
narration … the most important beat in the Foray and almost certainly the least
sourceable."* Confirmed. Nothing in the readable pool classifies drinks by process
across families. The two candidates that come closest to cross-family talk are the
pharmacology episode, which classifies by strength, and the gin episode, which does
make beat 42's point that gin is a flavoured neutral spirit rather than a grain
distillate — and that sentence is committed to beat 42.

**This is a good outcome rather than a bad one**, and it is the cleanest vindication of
source-blindness in the report: the beat the whole Foray is for is the beat no tape
could supply, and an outliner who had read the catalogue first would never have written
it.
