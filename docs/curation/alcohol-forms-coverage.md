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
