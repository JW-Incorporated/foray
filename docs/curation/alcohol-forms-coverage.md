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

- **A beat is covered by one strong segment.** §4a of the spine derives a cut budget of at
  most 75 segments for a 150-minute Foray and rules that *"a second segment on a beat is
  legitimate; a pile is not"*; the sharper framing — that hunting for more per beat is
  itself what manufactures fill pressure — is `grilling-history-coverage.md` §1's. Each beat below records the best
  candidate and, where one exists, a credible alternate. **Exactly one beat in this
  report carries two segments** — beat 14, which is one of the twelve beats §4a
  nominates for a second — and it carries two because the two halves advance
  different parts of one claim.
- **"Thin" does not mean covered.** A thin beat is a **narration beat** that happens
  to have a partial supporting cut available. Every thin verdict below states what is
  missing so that stage 4's narration can supply it.
- **Empty is a result.** Forty-seven times below, the answer is nothing, and in
  fourteen of those cases the spine's §5 predicted it. §9c scores the predictions.
- **Label, never exclude.** Nothing is dropped from the catalogue. §10b lists every
  stop with its reason, and several are good episodes a playlist should keep — the Odd
  Lots white-oak episode most of all.

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

Test 2 is what caps this report at one strong beat. Of the seventeen transcripts read,
**fourteen are Stuff You Should Know or a home-improvement show's whiskey hour**, and
those cannot reach strong however squarely they hit — the grilling report set that
precedent deliberately and reversing it here would be reversing it silently. Three
readable sources pass test 2: a chemist-brewer on Being an Engineer, two
epidemiologists on This Podcast Will Kill You, and a forest-health researcher on Odd
Lots. The whiskey hour is counted with the fourteen, and its one genuinely precise
passage — a building-materials specialist who turns out to know the cask trade — is
used only as a second segment on a beat that stays thin without it.

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
| `data/discover.json` | 1,534 items; **21** reach a beat closely enough to score | Only where a transcript can be read — and none of the 21 can be |
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
have a drinks-shaped episode with a transcript; four turned out to be usable. Of the
recommendation pool's twenty-one on-plot items, **twenty have no publisher transcript at
all** — Craft Beer & Brewing 0 of 497, Experimental Brewing 0 of 386, FermUp 0 of 100,
Gastropod 0 of 293, The Rest Is History 0 of 713. The exception is the twenty-first,
`around-the-house-eric-g--the-whiskey-hour-single-casks-sherry`, whose show ships SRT on
301 of its 828 episodes and HTML on 592, and reading it is what produced beat 14's second
segment. Every other on-plot row is an ASR purchase, which is what §10 is a queue of.

**Transcript bodies were fetched, and nothing was stored in `data/`.** Seventeen
publisher transcripts were fetched to a scratch directory outside the repository and
read. `transcript-availability.json`'s own policy line —
*"availability index only — transcript bodies are never fetched or stored (issue
#104)"* — is a rule about that index file, not a prohibition on reading a publisher's
transcript; `grilling-history-coverage.md` §2b established the practice, and its §9 ranks
reading a transcript that already exists above buying ASR as *"the cheapest action in the
list"*. It was again: one fetch per episode, and it is the reason this report has verdicts
rather than guesses.

**Every readable source is DAI-suspected.** All five sources that produced a verdict sit
behind dynamic ad insertion, on the `enclosure_host` each declares: SYSK, Odd Lots and
This Podcast Will Kill You on three different `mc.tritondigital.com` hosts, Being an
Engineer on `buzzsprout.com`, Around the House on `captivate.fm`, all five with
`dai_suspected: true`. SYSK's transcripts come from `omny.fm`, which is its transcript API
rather than its audio host. Under `ADR-0008` that makes every span below
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

**And that rule was checked mechanically rather than asserted, because the first draft
broke it eighteen times.** Every quotation in this document was extracted
programmatically — the rule is any italic span opening with a quotation mark, which is how
every source quotation here is set — and matched back against the transcripts, the spine,
the length rules, #226 and the data files, word for word with punctuation and case ignored.
The count is deliberately not quoted as a total, because the total changes whenever a
sentence is edited and a stale total is worse than none. Eighteen
failed, and every one failed the same way: a dropped *um*, a dropped doubled word — the
transcripts are full of *"it's it's"* and *"they're they're"* — or a full stop where the
source has a comma. All eighteen are now the source's words. **The check now reports zero unverified.** The
check has to account for one property of these files that is easy to miss: SYSK's cues
*overlap*, each one repeating the tail of the last, so a naive flatten duplicates words
and a correct quotation fails to match. Two of the eighteen were caused by reading a
duplicated phrase as the speaker saying it twice.

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
inside three SYSK episodes — wormwood in the amaro and absinthe hours, cinchona in the
amaro and gin hours — and are counted there, not here, because
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
  the sake of", twelve of them in The Bible in a Year and two inside Stuff You Should
  Know itself. On this catalogue
  the sense collision, not the family overlap, is what would have produced a false
  East Asian coverage claim.
- **Names and brands wearing drink words.** `dunder` returns 2, both Dunder Mifflin.
  `flor` returns 13, all surnames — Flores, Dan Flores. `perry` returns 131, mostly
  Rick Perry and Katy Perry. `marc` returns 131, mostly Marc Maron and Marc
  Andreessen. `millet` returns 1 and it is Millet's *Angelus*. `adjunct` returns 13
  and every one is an adjunct professor. `cider` returns 2, of which one is Netflix's
  *Apple Cider Vinegar* and the other is Behind the Bastards on Cider Riot, a Portland
  taproom — so the only two cider hits in 73,719 episodes are a wellness fraud and a
  street fight.

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

**A note on that Length column, since it mixes two conventions.** The four non-SYSK rows
take `duration_sec` from `transcript-availability.json`; the thirteen SYSK rows take the
end of the transcript's last cue, which runs 5 to 47 s short of the declared duration. Both
are stated as the source gives them and neither is used for arithmetic — §9d's figures come
from cue timestamps only.

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
nitrogen, but nitrogen isn't absorbed into the beer like carbon dioxide is. So it it has
the same pressure of just a regular beer, but it has a lot less CO two, and so it's
not as physy"*, and nitrogen *"forms smaller bubbles and more stable bump bubbles"*. That
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
`Brettanomyces`, the lactose-fermenting yeasts beat 25 needs. `pasteur` returns eleven hits
across the readable pool and **not one is the man**: five in the honey episode and four in
the kombucha episode about pasteurising, one in the Guinness episode about pasteurised beer
and one in the brewing episode about pasteurising a fermenter. `saccharomyces` returns **zero** across every source
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
`nuruk` 0, `makgeolli` 0, `huangjiu` 0. The word `mold` returns three hits in the honey
episode, all about mould spoiling honey, and the beer episode has only *"moldy"*, which the
matcher's `(?:s|es|ing)?` inflection set does not even reach. There is no
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
nasty taste that you needed to cover up with stuff like um. Botanicals or sugar or
turpentine um."*

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
it is beat 13's claim inverted: *"And these impurities are called congeners, right,
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
band **321.60 → 398.80 (77.2 s)**. In on *"The reason you have to use white oak, you can
use a lot of like wood to make barrels"*; out on *"…the barrels are expensive and very
good."*

**Why it advances beat 14.** A forest-health researcher gives the physical reason the
species is not interchangeable, which is a real mechanism and one the beat's evidence
list asks for: *"wood fibers are just like long straws, and if you put liquids in those
straws, you can actually drink through straw the straws … But if you try to use white
oak as a straw, it doesn't work because white oak has these little Bubbles in the wood
that just develop after the tree is done using those straws to move water up and down
the tree, and so those bubbles prevent liquid from escaping from the barrel itself."*
He then names the three woods that can hold a long-aged spirit — *"There's French yoak,
Hungarian oak, and white oak"* — and *"quercus elbow"* for *Quercus alba*, and closes
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

**The in-point is 321.60 rather than the start of the answer, and the reason matters.**
The same speaker introduces bourbon at 308.88 → 316.08 as *"fifty one percent corn that's
distilled three times and put into barrels at eighty proof"*. Bourbon has no
triple-distillation rule and its maximum barrel entry strength is 125 proof, not 80. An
earlier draft of this entry proposed a band opening at 302.64 and claimed to start *after*
that sentence; it did not — the error sits six seconds inside it, and beat 39 cites the
same passage as a rejected candidate at 302.64 → 320.00. The band now opens at the next
sentence, which costs 19 s and keeps the cut in the target band at 77.2 s.

### Beat 15 — refusing to mature, and other vessels — **empty**

**Nothing.** §5 ranked this fourteenth-hardest on the grounds that it needs a producer
arguing against wood, "a real position but a quiet one". In this catalogue it is a
nearly silent one. `stainless` returns two hits across every transcript read: one in the
cleaning-chemistry span at 538.31 → 585.74 that beat 26 deliberately leaves uncut, about
sodium hydroxide in a fermenter, and one in the champagne episode at 1150.48, which is the
closest thing to this beat anywhere in the pool — *"they put
it in stainless steel vats unless you're super old world. I guess, uh some people do
use wood still, but yeah, that you're allowed to use for the for the initial
fermentation."* That is the choice named and then dropped: what stainless does and does
not permit is exactly what the beat asks for and the sentence is a permission rather
than a mechanism, and at 12 s it is well under the floor. `qvevri`, `tinaja`, `amphora`
and `concrete` return zero. The whiskey-hour episode argues the opposite position at
length.

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

---

## 4. Act II — sugar that was already sweet (fan of families, beats 17–25)

**No strong tape, one thin, eight empty.** The wine chain 17 to 21 is a chain inside
the fan and four of its five beats are empty; the fan stops 22 to 25 are all four
empty. This is the act where the catalogue's shape shows most plainly: it holds three
beer shows and no wine show, so the family the spine gives five beats to has one
supporting cut, and it is about the bottle rather than the wine.

### Beat 17 — the grape as the ideal fermentable — **empty**

**Nothing.** `winemaking`, `viticulture`, `brix`, `oechsle`, `chaptalisation` and
`must` all return zero across every source read. The two wine-shaped rows in the
catalogue are both rejected on subject, not on quality: SYSK How Wine Fraud Works
(2,857 s) is counterfeiting and collecting from end to end — §6b names *"collecting
and investment"* — and `the-rest-is-history--wine-civilisation` (4,543 s) is
*"How wine built civilization — from Homer's Odyssey to Julius Caesar's conquests"*,
which is a history of drinking rather than an account of ripeness setting alcohol.

**What is missing.** Sugar accumulation and acid falling as sugar rises, potential
alcohol calculated from must weight, the picking date as the winemaker's main control
over final strength, and the honest separation of measurable terroir variables from
marketing.

### Beat 18 — red and white is a contact decision — **empty**

**Nothing.** `maceration` returns one hit across the readable pool and it is in the
amaro episode, about steeping botanicals in spirit. `skins`, `punchdown`, `pumpover`
and `rosé` return zero. There is no tape in this catalogue about what happens in a
fermenting vat of grapes.

### Beat 19 — the decisions after the ferment — **empty**

**Nothing.** `malolactic` 0, `lees` 0 in the wine sense, `sulphur`/`sulfur` 0 in the
winemaking sense, `fining` 0, `filtration` 0 in the wine sense. §5 predicted this beat
would be **over**-supplied on the grounds that the wine podcast world is large. The
wine podcast world is large and none of it is in this catalogue: §11 counts 25 wine
shows in `catalog-breadth.json`, none of them curated.

### Beat 20 — sparkling wine as contained pressure — **thin**

**Chosen:** SYSK How Champagne Works, band **1846.84 → 2017.12 (170.3 s)**. In on
*"the towards the front of the neck, you now have one of the last steps called gourge
mont or disgorgement"*; out on *"…then they put that final cork in place"* — the band's
final cue trails into pouring, so the out-point wants trimming to that sentence at
mint time.

**Why it advances beat 20.** It is the most elaborate production sequence in the
readable pool and it is the beat's own list, in the beat's own order: riddling as
*"a pretty thankless job"* taking *"about four to six weeks"* with the bottle *"stored
upside down"* and *"a little chalk mark on each one"*; disgorgement as *"it's just a
thing of sediment … accumulated at the neck and you put it in an ice bath"*, contrasted
with the older method where *"they would pop open a bottle, decant it, filter it, and um
they would uh pour it back"*; the CO2 doing the work — *"there's you know, carbon dioxide
gas in there at this point and it forces that plug out"* — and the dosage as the
sweetness dial, *"maybe a little brandy, little sugar, a little white wine back in."*
**The pressure figure sits just outside the band**, at 2044.96 → 2078.20: *"If you want
about five or six atmospheres of pressure or about I think sixty to seventy square or
pounds per square inch of pressure in a bottle of wine."* Reaching it means running the
cut to 2078.20, which is 231 s and over the 180 s band, so it is a trade: the sequence
without the number inside the band, or the number with a `needs_review` length.

**Second, if a shorter cut is wanted:** **1594.08 → 1696.28 (102.2 s)**, the second
fermentation itself — *"you're gonna start that second fermentation process by adding
sugar and yeast. Then you drop the temperature on your cooler … well you can also do
this in the tank. Like they're different methods, but right, that's the that's called
the shar Met method"* — which is the one place in the readable pool where the tank method is
distinguished from the traditional one at all.

**Why it is thin, and what is missing.** Register, and three gaps the beat names
explicitly. There is no time on lees and no autolytic bready character: the episode
gets as far as *"structure of yeast cells, and you want to get that out"* and stops.
The ancestral single-fermentation method is absent. And the beat's stated strong signal
— the enabling technologies named as English glass and cork *"with the monk credited as
the tradition's own account rather than as fact"* — is inverted: the episode credits
Dom Pérignon with *"the idea of using cork stoppers in thicker English type bottles"*
and dates the disgorgement method to *"eighteen thirteen when the widow clicko came up
with it."* Narration has to carry the correction, and beat 20's reject line already
says so.

### Beat 21 — phylloxera and the grafted vineyard — **empty**

**Nothing.** `phylloxera` 0 and `rootstock` 0 in both catalogue pools and in every
transcript read. The only adjacent material is beat 59's second span, where the
absinthe episode has the French wine industry joining the temperance movement — the
downstream consequence the spine says beat 21 sets up — without the blight that caused
it.

### Beat 22 — cider, perry and the fruit wines — **empty**

**Nothing.** `cider` returns 0 in discover and 2 in the archive: Netflix's *Apple Cider
Vinegar* and a Behind the Bastards episode that mentions Cider Riot, a Portland taproom.
Neither is about making cider. `keeving` 0, `perry` in the drink sense 0 across
131 archive hits that are all people's surnames, `sorbitol` 0. `Cider Chat` exists,
with 511 episodes, and it is in `catalog-breadth.json` uncurated — see §11.

### Beat 23 — mead and the nitrogen problem — **empty**

**Nothing**, and the near-miss is instructive. SYSK Honey: Nature's Wonder Sugar
(3,245 s) is a full episode about the feedstock that contains no mead process at all.
Its one mention is 2533.76 → 2552.68: *"mold in particular can cause honey to ferment
slightly. Again, nothing wrong with that, It's totally fine. You basically just have a
free little mini shot of mead right there in your honey."* Its account of honey's
stability is antimicrobial rather than physical — *"it is acidic, it has antibacterial
properties, so that means honey will last you a long long time"* — where beat 23's
claim turns on water activity, which the episode never reaches even though it repeatedly
describes dehydration.

**What is missing.** Water activity as the reason undiluted honey is microbiologically
stable, and then the whole beat: yeast-assimilable nitrogen, staggered nutrient
additions, and the fusel harshness a starved ferment produces. `nitrogen` returns **20**
hits in the readable pool, nineteen of them the Guinness widget. The twentieth is the one
nitrogen sentence in the pool that is about a ferment, in the kombucha episode at 1887.20:
the culture uses caffeine and *"convert it into nitrogen, which they use for all sorts of
stuff during the fermentation project process."* It is rejected because the beat's claim is
that honey has almost none and the maker must add it, and because kombucha is §6a's dropped
low-alcohol ferment — but it is the nearest thing to nutrient management anywhere in the
pool and it is worth naming rather than absorbing into a total.

### Beat 24 — sap drinks that cannot be shipped — **empty**

**Nothing cuttable.** `pulque`, `palm wine` and `aguamiel` return 0 across both catalogue
pools, and `toddy`'s three archive hits are all hot toddies in Christmas specials. There is exactly one naming in a read transcript, in the
world-survey passage at `this-podcast-will-kill-you` 3943.32 → 3950.68: *"In Mexico
people made pulke from the fermented sap of the agave plant."* That is one clause of a
sixty-seven-second list of local ferments — Orkney barley, Tasmanian gum sap, Victorian
honey and gum, African banana beer and palm wine, Mexican pulque, Southeast Asian
cassava — whose whole content is that the drinks existed. **The list is considered and
rejected at four beats — 24, 34, 51 and 63 — for the same reason each time: it names
the drinks and never says how any of them is made.** Beat 24's claim is about the
few-hour timeline and the impossibility of shipping, and neither is in it. §5 ranked
this beat twelfth-hardest and expected partial coverage; a name in a list is less than
that.

### Beat 25 — the milk alcohols — **empty**

**Nothing.** `kumis` 0, `airag` 0, `kefir` 0, `lactose` 0. §5 ranked this
fourth-hardest and predicted the same outcome as barbecue's steppe beat, which came
back empty too. The comparison holds: two Forays, two steppe beats, two empties, and in
this catalogue there is not even travel-shaped material to reject.

---

## 5. Act III — sugar that had to be unlocked (fan of families, beats 26–35)

**The only strong beat in the report is here, and so is the report's sharpest
contrast.** One strong, two thin, seven empty. The beer chain 26 to 30 has the strong
beat at its head, a thin beat at 27 that depends on 26's carrier, two empty beats in
its middle, and a thin beat at 30. Everything outside the European beer lineage —
sorghum, sake, the koji family, the chewed brews, and the industrial lager most of the
world actually drinks — is empty.

### Beat 26 — beer, the sequence in order — **strong**

**Chosen:** `being-an-engineer` — S1E33 Beer, Kenya, & DIY Chemistry Experiments |
Jorge de Freitas, band **385.59 → 485.34 (99.8 s)**. In on *"It's a very linear process
that starts with sugar starts with extracting sugars from malt"*; out on *"…this yeast
molecule that is converting sugars into alcohol and carbon dioxide."*

**Why it advances beat 26.** The speaker is a chemist who spent two and a half years
as a production brewer at two breweries, he is asked *"I know nothing about brewing or
the brewing process, walk us through what that process is"*, and he answers with the
sequence and its reasons rather than its steps — which is exactly what the beat asks
for and refuses to accept a substitute for. The sequence: *"It's a very linear process
that starts with … extracting sugars from malt, or barley, or malted barley … From
there, you extract the sugar, you make work. So with the sugar water, the extraction is
called wart, you boil it, you add flavoring which is where you would add your hops for
bittering."* Then the beat's actual claim — that each step destroys the conditions the
previous one required — arrives as the cold-side argument: *"it's not called beer until
it's in the fermenter. And there's yeast on it … and that happens on the cold side, or
what we would call cold side, anything on that side is susceptible to infection. And so
there's a large need for sterilization and sanitation procedures in your vessels,
because you're competing with wild bacteria and wild yeast that could potentially
ferment the sugars."* The host's own reaction is the register check: *"I have never
heard beer explained on such a scientific level."*

**Why this is the report's one strong verdict.** It passes all four of §1a's tests: it
was read; the speaker's expertise is in the thing claimed; it advances the claim rather
than a clause; and at 99.8 s it sits mid-band and double-books nothing.

**What it does not have, so narration knows.** Neither of beat 26's two named strong
signals: the enzymes' fate is never stated, so the one-way nature of the mash
temperature decision is missing, and the brewer is never asked which step he would
change first if the beer came out wrong. Mash thickness and temperature, lautering and
the grain bed as its own filter, hot and cold break, and pitching rate are all absent.
A second segment at **538.31 → 585.74 (47.4 s)** covers cleaning chemistry — caustic
then acid sanitiser, *"pasteurize it with heat and then sanitize it with some type of
acid"* — and is **deliberately not taken**: the beat is carried, and adding to a
carried beat is how a Foray starts bloating.

**One caveat that travels with both spans from this episode.** The transcript's cues
in this stretch run 21 to 68 seconds each, so cut points can only be placed at cue
boundaries. Both bands above are cue-aligned. Sub-cue trimming would need the audio.

### Beat 27 — hops, preservative then flavour — **thin, by dependency**

**The mechanism exists and it is inside beat 26's carrier.** The same speaker gives
beat 27's central chemistry in one sentence: *"Traditionally, like IPA or an India Pale
Ale would have a lot of hops added to the start of the boil. Because there's a chemical
conversion that happens there. There's a heat assisted isomerization of a specific
compound and hops that go from non soluble to soluble, then once they're soluble, they
can be adding bitterness to your to your beer."* That is alpha-acid isomerisation
during the boil, which is the first half of the beat's trade, from someone who ran it.

**And it cannot be cut separately.** The sentence sits in the middle of the single cue
running 403.26 → 471.09, inside the span beat 26 takes. Splitting it out would require
sub-cue timing this transcript does not provide, and double-cutting one passage across
two beats would put the same voice making the same point twice. This is the same
outcome barbecue's beat 2 reached against beat 15's carrier, and the same reasoning:
**treat beat 27 as a narration beat with a dependency recorded**, and if the episode is
ever re-transcribed with word timestamps, revisit this beat first.

**The alternate, and why it is not used.** SYSK How Beer Works, 1525.68 → 1552.40
(26.7 s), has the preservation-before-flavour ordering and the shipping story: *"they
added a lot more hops because hot sex is a preservative. Thus India pale ale."* It is
below the 30 s floor, the hosts disclaim it themselves in the next breath — *"that's
the story I got. I'm gonna be really embarrassed"* — and beat 27's reject line is *"IPA
origin folklore asserted without the shipping and hopping-rate evidence"*.

**What is missing either way.** The other half of the trade: that the aromatic oils
boil away while the bittering compounds form, and therefore why late, whirlpool and
dry-hop additions exist. Also the antimicrobial action against Gram-positive bacteria
specifically, the displacement of the earlier herb mixtures, and the 1516 statute
described accurately — SYSK has the statute at 920.44 → 953.60 and describes it as
*"the oldest non religious legal standard of food production and the oldest consumer
protection law on the planet"*, which is the heritage boast the beat rejects, wrapped
around an argument between the hosts about whether it names three ingredients or four.

### Beat 28 — ale, lager and refrigeration — **empty**, and the one candidate is wrong

**Nothing**, and this rejection is worth stating precisely because the spine's own
revision note predicted the error. SYSK How Beer Works, 1590.20 → 1638.52, is the only
account of the ale/lager split in the readable pool: *"If you are making a logger which
in Germany, which in German is a verb meaning to store, um you're going to it's gonna
take a few months, um and you're going to store this stuff. You're gonna let it ferment um
at near freezing temperatures and it's gonna ferment at the bottom."*

The spine's §8 records: *"Beat 28 had lager fermenting near freezing, which is the
conditioning stage."* A reviewer removed that error from the spine, and the only
available tape asserts it. The episode then explains lager's origin as a summer
spoilage problem solved by cold caves, which is half of the beat's history, and never
reaches refrigeration, Linde, 1873, or 1883.

**What is missing.** The biology: two species rather than two techniques,
*S. pastorianus* as a hybrid with *S. eubayanus* rather than a variety, the seven to
thirteen degree working range and the near-freezing *conditioning* that follows it.
Then the enabling conditions stated as jointly necessary and dated in the right order,
which is the beat's strong signal and the thing that makes pale lager's global
dominance explicable at all.

**The identified fix.** `craft-beer-and-brewing-magazine-podcast--episode-497-todd-malloy-and-robin`
(4,877 s), *"on brewing medal-winning lagers on a small pub system"*, is the
catalogue's only lager-technique row. §10 ranks it fifth and states the risk: a
brewpub-system interview may well be recipe and equipment talk rather than the two
yeasts and the cold chain.

### Beat 29 — the style map is a water map — **empty**

**Nothing.** `burton`, `burtonisation`, `sulphate`/`sulfate`, `gypsum`, `carbonate`,
`pilsen` and `mash ph` all return zero across every transcript read. SYSK's beer
episode says `water` seven times and every one is an ingredient mention. This is the
best "reason it yourself" beat in Act III, the direct analogue of the barbecue spine's
fuel beat — which came back **strong** on its own catalogue — and here there is nothing
at all.

### Beat 30 — wild and mixed fermentation — **thin**

**Chosen:** `being-an-engineer`, band **601.41 → 742.74 (141.3 s)**. In on *"Right and
I'm saying two years from like a barrel aging program"*; out on *"…I'm sure breweries
have to deal with that every day when they're managing these these extensive barrel
programs."*

**Why it advances beat 30.** It delivers two of the beat's named evidence items from a
practitioner. The barrel as habitat rather than as flavour: *"you could put the same
batch or the same lot of beer into 12 different barrels, and the environment in that
barrel, and what I mean by environment, it could be the different concentration of
yeast, bacteria, or anything that's in the wood in particular, could have a different
effect on on your beer."* And then the beat's own stated strong signal, which is
*"an honest account of the failure rate and of barrels that have to be dumped"*: *"if
there's one that is just completely off, because maybe the chemistry was off, or maybe
there was too much of a concentration of a specific bacteria that gives you an
undesirable flavor. You would have to just throw that barrel away."*

**Why it is thin.** It is not about the older branch. Beat 30's claim is that the wild
and mixed traditions deliberately give back the control beats 26 to 29 spend
themselves acquiring, and this is a modern brewery's barrel programme, where
unpredictability is a cost being managed rather than a technique being chosen. Missing:
the coolship and the seasonal restriction, the succession of organisms over months,
*Brettanomyces* and what it metabolises, *Pediococcus* and *Lactobacillus*, and
blending young and old beer to trigger a bottle refermentation. `lambic` returns 0 in
both catalogue pools; SYSK's beer episode mentions it four times, at
1772.44 → 1825.16, and gets the claim's core right — *"lambics are um a type of
spontaneously fermented brew … they're they're basically just leaving their stuff out to
be exposed to wild yeast that grows in the area"* — before landing on *"I don't care for it
a whole lot. It's kind of has a sour aftertaste"*, which is the tasting reaction the
beat rejects.

### Beat 31 — the sorghum and millet beers — **empty**, and the tempting row is the clearest stop

**Nothing.** `sorghum` 0, `millet` 1 and it is Millet's *Angelus*, `burukutu` 0,
`tella` 0, `kvass` 0.

**And the catalogue contains exactly one West African grain row, which is why this beat
needs its rejection written down.** `experimental-brewing--episode-207-fonio-fonio-what-the-heck-are-you-fonio`
(3,900 s), hook *"An obscure West African grain gets the experimental-homebrewing
treatment."* It is the only row in 1,534 items that touches African grain and beer at
once, beat 31 is empty, and taking it would be precisely the move the governing rule
forbids. Two homebrew authors experimenting with a novel grain is not a brewing
tradition that is *"thick, unfiltered, still actively fermenting when it is drunk,
deliberately soured by lactic bacteria"*; the beat's claim is about a design decision
made across a continent, and §6b excludes home brewing as a how-to. **Stop, not a low
priority.** It would move no beat and it would look like it had.

### Beat 32 — sake — **empty**

**Nothing, and the negative is unusually clean.** `sake` in the drink sense returns
**zero** across 1,534 discover items and 73,719 archived episodes. All 25 archive hits
are "for the sake of", twelve of them in The Bible in a Year and two inside Stuff You
Should Know itself. `koji`,
`tōji`, `polishing ratio` and `milling` in this sense are all zero. A two-thousand-word
process beat, one of §4's twelve at 2.0 %, with no tape of any kind.

### Beat 33 — the koji family beyond sake — **empty**

**Nothing.** `huangjiu` 0, `makgeolli` 0, `nuruk` 0, `qu` unmeasurable as a two-letter
token but `rhizopus` 0 and `shaoxing` 0. Settled by the same absence as beat 8.

### Beat 34 — chewed, sprouted and tuber brews — **empty**

**Nothing cuttable.** `chicha` 0, `jora` 0, `cassava` 0, `masticat` 0 across both
catalogue pools. The single naming is beat 24's world-survey list again —
*"in Southeast Asia people made to pie from fermented cassava"* — which is a drink named
and a process not described, and cassava's detoxification, the only actively poisonous
raw material in the Foray, is absent. §5 ranked this beat thirteenth-hardest and
suggested checking whether one candidate could serve both this beat and beat 9 without
double-counting. The check is moot: the one candidate serves neither.

### Beat 35 — the industrial adjunct lager — **empty**, and its near-miss is an advocacy passage

**Nothing.** The one adjunct passage in the readable pool is SYSK How Beer Works,
2283.24 → 2319.68, and it is the prosecution rather than the engineering: *"they
changed it in a really lazy, cost efficient way. Instead of malt, they used corn,
syrup, high fruit toast corn syrup. Such a bad idea … So you had this really weird
tasting chunky style beer."* Beat 35 asks for *"an even-handed account that states the
engineering rationale rather than prosecuting it"* and rejects *"craft-versus-macro
advocacy in either direction, and brand history."* This is both.

**What is missing.** Adjunct rates and what maize and rice contribute beyond cost,
cereal cooking, diastatic power as what caps the adjunct rate and purchased enzymes as
what lifts the cap, and high-gravity fermentation with dilution afterwards —
genuinely the most surprising piece of process in the act, and absent. `high gravity`
and `deaerated` return zero; `gravity` appears five times in the beer episode and is
defined once, incorrectly, as *"gravity is how much alcohol is in your beer."*

---

## 6. Act IV — concentration: the spirits (chain link, then a fan by feedstock, beats 36–51)

**No strong tape, five thin, eleven empty.** The five thin verdicts — 36, 39, 41, 42 and
43 — come from four episodes, and two of the five come from one of them: SYSK's gin hour
carries 41 and 42, and lent beat 12 its column as well. Everything the column still did
*not* create is empty: agave, brandy, the fruit distillates, baijiu, soju and shochu,
aquavit, arrack and the margins are nine consecutive empty beats, and the whisky chain
loses three of its four.

**The act's shape is the inverse of what §5 predicted.** §5 named whisky 37 to 40 as
*"the single most podcast-covered subject in drinks, and the place this Foray will
bloat first"*. On this catalogue whisky is three-quarters empty and its one thin beat
rests on a thirteen-minute Short Stuff. §9c takes that up.

### Beat 36 — where distillation came from — **thin**

**Chosen:** `this-podcast-will-kill-you` Ep 85, band **4448.80 → 4548.76 (100.0 s)**.
In on *"I'm excited for this. Distillation is a fairly old concept with fairly old
technology"*; out on *"…rum would also be added to water barrels on boats"* — the tail
drifts into naval ration colour, so the out-point wants pulling back to *"far superior
to wine or beer for long distance travel"* at about 4540.

**Why it advances beat 36.** It is the beat's claim with the beat's own hedging
discipline. The antiquity and the geographic spread: *"Experimental distillation was
practiced in ancient China, India, Egypt, Mesopotamia, and Greece, with the technology
most probably originating in the area around the border between modern Pakistan and
India, but it wasn't really until the thirteenth century in China and the sixteenth
through the eighteenth centuries in Europe that it became widespread."* Then the
sequencing that makes spirits younger than drinking: *"Brandy distilled from wine was
the first spirit produced in large quantities in Europe, and then there was whiskey,
gin, vodka and others that followed."* **The "most probably" is the strong signal** —
beat 36 asks for *"a speaker who marks the contested attributions as contested —
including the genuinely open question of independent early distillation in China and
South Asia"* — and this speaker does exactly that, and names no inventor.

**Why it is thin.** Two PhD epidemiologists reading from Rod Phillips and Edward
Slingerland are not the historian of science, medicine or drink the beat asks for, and
the medicine half of the beat is entirely absent from this span: no alembic, no
etymology of *alcohol* or *alembic*, no *aqua vitae*, no Salerno, no monastic or
apothecary channel. Since beats 57 and 58 collect on that medicine framing, the
narration for this beat has to supply it or the payoff at 58 arrives unprepared.

**Second candidate, and it is a better fit for the missing half:** SYSK That's Amaro!,
**1694.40 → 1803.80 (109.4 s)**, which carries the medical lineage this beat needs —
*"They were medicinal drinks, but it didn't take them very long to figure out it gives
you a pretty pretty good buzz too, and by the sixteenth century, I believe people were
like, just just give me that"*, then *"this tradition that they'd gotten from their Arab
friends of making these medicinal liqueur"*, then *"by the nineteenth, eighteenth and
nineteenth centuries, apothecaries and pharmacists were like, give me those, I'm going
to start selling these."* Taking it means two segments on a 2.0 % beat, which §4a
permits, and means the amaro episode carries three cuts.

### Beat 37 — malt whisky, and peat at the kiln — **empty**

**Nothing.** `peat` returns 0 in discover and 5 in the archive, none about whisky.
`lyne arm`, `reflux`, `wash still`, `spirit still` and `phenol` all return zero across
every transcript read. The one whisky-production source in the readable pool is the
whiskey hour, whose entire technical content is cask finishing and is committed to beat
14.

**What is missing.** Everything, including the beat's most valuable single move —
relocating peat from the still to the kiln. §5 predicted this beat would be
over-supplied. It is empty.

### Beat 38 — grain whisky, blending and the 1909 ruling — **empty**

**Nothing.** `royal commission` 0, `blender` 0 in this sense, `grain whisky` 0. The
whiskey hour talks about industry consolidation in passing — *"that's again why it was
like it's consolidation industry"* — which is §6b business material and does not touch
the ruling.

### Beat 39 — American whiskey's legal definition — **thin**, on a standard the tape misstates twice

**Chosen:** SYSK Short Stuff: Whisky or Bourbon?, band **218.44 → 331.00 (112.6 s)**.
In on *"So if you want to be bourbon, you have to be corn"*; out on *"…Congress declared
bourbon as quote America's native spirit."*

**Why it advances beat 39.** It does the beat's central move, which is to treat the
category as a production specification rather than a place: *"you might be saying, hey,
guys, you left out probably the most important part. It has to be made in Bourbon
County, Kentucky, or at least Kentucky. Well, friend, you'd be wrong on both parts,
because bourbon can be made anywhere in the States."* That is beat 39's own reject line
— *"any tape asserting bourbon must come from Kentucky"* — refuted rather than repeated.
It also has the distillation proof cap: *"it can't be distilled at anything higher than
one sixty proof … because remember we said one ninety for whiskey"*, the mandatory new
charred oak, and the "straight" designation distinguished from bourbon.

**Why it is thin, and this one is worse than register alone.** The beat's strong signal
is *"the regulation quoted or paraphrased accurately"*, and the tape gets two numbers
wrong: barrel entry is given as *"something like one forty"* where the standard is 125
proof, and the maturation minimum as *"I believe four years for bourbon"* where straight
bourbon is two. The 51 % maize threshold is never stated — *"you have to be corn"* is as
close as it gets. Sour mash is absent entirely, and so is bottled-in-bond, which §8 of
the spine had to relocate to this beat. The causal link from new-cask extraction to
flavour is not made; when it comes up the host says *"I believe it becomes brown from
the charred oak um aging process. I think that's right."*

**Also considered and rejected.** `odd-lots` at 302.64 → 321.40 — the cue run that beat 14 now
opens after — states the standard as
*"fifty one percent corn that's distilled three times and put into barrels at eighty
proof"* — the 51 % correct, the other two wrong. Two independent readable sources, two
misstatements of the same standard, in opposite directions. **Whatever this beat ends up
carrying, the narration has to state the rule itself.**

### Beat 40 — world whisky and climate — **empty**

**Nothing.** `angel` in the angels'-share sense 0, `evaporative loss` 0, `warehouse` 0
in this sense, `triple distill` appears once and it is the odd-lots misstatement about
bourbon. The Indian-molasses question — which the beat calls the same taxonomy problem
the 1909 commission answered — has no tape of any kind.

### Beat 41 — vodka, defined by subtraction — **thin**

**Chosen:** SYSK Everything You Ever Wanted to Know About Gin, band
**498.44 → 621.20 (122.8 s)**. In on *"and then you distill that further in the process
of … the presence of botanicals"*; out around *"no matter what you make it from You're
going to arrive at basically the same base neutral spirit"* at about 605, which is the
sentence the beat wants and a better out-point than the band's tail.

**Why it advances beat 41.** The beat's central claim is that the feedstock is rectified
out by design, and this states it twice and lists the feedstocks: *"because you're step you're
starting out with such a ridiculously high proof um alcohol like neutral alcohol. You can
use basically an old shoe to make that that neutral grain spirit. It's gonna taste
virtually the same as neutral grain spirit made from a neutral spirit made from barley or
from way, or from potatoes or grapes. It just is the the alcoholic essence of those things."* For a beat the spine
calls *"the most useful single debunk available in the whole subject"*, that is the debunk,
from the one episode in the catalogue that had reason to make it.

**Why it is thin.** Register, and then the absence of the legal half, which is what
turns the claim from an assertion into a production fact: neither the EU nor the US
definition is quoted or paraphrased, and the beat's point that both are *framed around
the absence of distinguishing character* is never made. Also missing: how many plates
rectification takes, what charcoal filtration does and does not remove, blind-tasting
evidence, and the beat's strong signal — a producer deliberately under-rectifying to
keep something.

### Beat 42 — gin as a flavouring operation — **thin**

**Chosen:** same episode, band **754.12 → 842.00 (87.9 s)**. In on *"the first way is
steeping"*; out on *"…it's got like kind of the tea of botanicals brewing and then's
just vaporizing through those other those last two."*

**Why it advances beat 42.** All three of the beat's methods, in the beat's order, with
a working example for each: steeping — *"you have your base spirit heating up and it
simmers, and then you have those botanicals right in there and the oils are releasing
and it's just infusing through the whole thing"*; vapour infusion — *"that is when you
have the botanicals in a basket hanging above the boiling spirit and that that vapor
rises"*; and the combination — *"they use the steeping method for most of the botanicals
and then they use the vapor method for I think like Douglas fur and bay Laurel leaves."*

**Second, and not counted toward §9d's total:** **954.96 → 1031.16 (76.2 s)**, which is
the legal half and the category's real boundary: *"distilled London dry gin"* against *"flavored vodkas which
you could literally put any flavor into this neutral spirit and call it gin. Distill gin
means it went through that process like we described before the break."*

**What is missing.** Juniper as the single legal requirement is implied by the whole
episode and never stated as the rule. Genever is present but as taste rather than as a
production route — *"sort of like the maltiness of a whiskey, but the botanicals of a
gin"* at 1267.28 — so the beat's key contrast, that genever is built on a malt-grain
distillate rather than a neutral base, is missing. What London Dry actually forbids is
never said. And the 18th-century panic is handled in both registers at once: the
licensing and taxation story the beat wants is at 1742.64 → 1771.96, *"really expensive
to have a license to selgon, really expensive to import neutral spirits"*, sitting a
few minutes after Judith Defour and the turpentine-and-sulphuric-acid material, which is
the moral spectacle the beat rejects.

### Beat 43 — rum, the by-product spirit — **thin**, on a 64-second clause

**Chosen:** SYSK Sugar: It Powers the Earth, band **939.80 → 1003.40 (63.6 s)**. In on
*"So chuck their byproducts to this whole process"*; out before the bagasse aside at
about 985, which would make the usable cut roughly 45 s.

**Why it advances beat 43.** It states the beat's premise, which is the economic reason
rum exists: *"Essentially, molasses is chief among them … it's a byproduct that comes
from boiling sugar"*, then *"the greatest byproduct of molasses is of course rum."* One
clause, correctly, from a sugar episode rather than a rum one.

**Why it is thin, and it is the thinnest verdict in the report.** Everything else in a
2.0 % beat is missing: the difference between molasses and fresh cane juice, dunder and
the muck pit and the ester chemistry, pot against column, the absence of a category
standard and its consequences, and cachaça under its own Brazilian definition. `dunder`
returns 2 in the archive and both are Dunder Mifflin; `rhum agricole`, `cachaça` and
`ester` return zero. The one piece of adjacent material worth naming is inside beat 36's
carrier, where the pharmacology episode explains molasses' availability through
plantation slavery — which is §6b's bounded case, admissible only as evidence for why
molasses was worthless, and it is committed to another beat in any case.

### Beat 44 — agave, and the oven that decides — **empty**

**Nothing.** `agave`, `mezcal`, `sotol`, `piña`, `fructan` and `tahona` all return 0
across both catalogue pools, and `tequila` returns 16 archive hits of which fifteen are
comedy or chat-show mentions and one is a Founder's Story interview about building an
agave-spirits brand in Jalisco — brand history, which §6b excludes, and the closest this
catalogue comes to the largest beat in Act IV. `agave` appears exactly once in a read transcript, inside
beat 24's world-survey list, as the plant pulque comes from. Nothing anywhere describes
cooking a piña. §5 predicted this beat would be
over-supplied because agave is currently fashionable. It is one of the emptiest beats in
the document, and it is one of §4's twelve at 2.0 %.

### Beat 45 — brandy, and shipping wine dry — **empty**

**Nothing.** `cognac` returns 1 archive hit, `armagnac` 0, `brouillis` 0, `charentais`
0, `pisco` 0. The word "brandy" appears inside beat 36's carrier — *"Brandy distilled
from wine was the first spirit produced in large quantities in Europe"* — and inside
beat 20's dosage passage, and neither is this beat. The Dutch freight explanation, which
the spine calls history doing §2c's work perfectly, has no tape.

### Beat 46 — the fruit distillates and pectin — **empty**

**Nothing.** `grappa` 0 in the catalogue pools, `slivovitz` 0, `rakia` 0, `pálinka` 0,
`kirsch` 0, `calvados` 0, `feni` 0, `stone fruit` 0 — and `pectin` 0, which is worth
stating separately because it is the beat's whole mechanism and it appears in none of the
seventeen transcripts read either. The amaro episode
mentions grappa twice as a base spirit — *"a lot of times It will be grappa, which is
great brandy"* — inside beat 57's carrier, which is a feedstock mention rather than the
pectin problem.

### Beat 47 — baijiu, the mash that is a solid — **empty**

**Nothing.** `baijiu` 0, `daqu` 0, `solid-state` 0, `sauce aroma` 0. §5 ranked this
tenth-hardest and expected tasting reactions. There are not even tasting reactions: the
world's best-selling spirit category appears nowhere in 75,253 items and episodes.

### Beat 48 — soju, shochu and the rice ban — **empty**

**Nothing.** `soju` 0, `shochu` 0, `awamori` 0, `honkaku` 0. The Korean rice ban, which
the spine calls the clearest case in the Foray of §2c's rule paying off, has no tape.

### Beat 49 — aquavit and the northern infusions — **empty**

**Nothing.** `aquavit` 0, `akvavit` 0, `caraway` 0, `żubrówka` 0, `bison grass` 0.
§7 of the spine already records this beat as one of the two whose why-it-belongs is
thinnest; this pass adds no reason to keep or cut it, since availability is not the
test §7 asks about.

### Beat 50 — arrack and the palm-sap spirits — **empty**

**Nothing.** `arrack` 0 and `arak` 0 in both pools. `toddy` returns **3** archive hits and
all three are hot toddies in Stuff You Should Know Christmas specials; `batavia` returns
**6**, of which four are Last Podcast On The Left's *Tragedy of the Batavia* shipwreck
series and two are comedy asides — the beat's Batavia arrack has no tape and the word does.
§5 ranked this sixth-hardest
and expected almost no English coverage that was not colonial-trade history or cocktail
revivalism. There is neither, which means even the material the beat would have rejected
is absent.

### Beat 51 — the margins of the taxonomy — **empty**

**Nothing.** `arkhi` 0, `whey spirit` 0, `destilado` 0, `birch sap` 0, `sugar beet` 0.
§5 ranked this third-hardest and named *arkhi* as *"the only candidate I would expect to
exist at all."* It does not. Beat 24's world-survey list is the one thing that reaches
this beat's territory and it is rejected here for the beat's own reason: its only
content is that the drinks exist, which is *"weird-booze listicles"* by another name, and
its drinks are fermented rather than distilled in any case.

---

## 7. Act V — made by addition (chain link, a short chain, then a fan, beats 52–60)

**No strong tape, three thin, six empty.** The whole fortification chain — 52 as its
chain link and 53, 54 and 55 as the chain ordered by when the spirit goes in — is empty,
four for four. The three thin beats are 57, 58 and 59, all from two SYSK episodes, and
they are the liqueur-amari-absinthe cluster §5 predicted would be over-supplied *"because
they are cocktail-adjacent"*. They are the best-served cluster in the report, which is
the prediction half-holding: the tape exists, it is just two episodes deep rather than
abundant.

### Beat 52 — fortification is a valve — **empty**

**Nothing.** `fortified` returns 7 hits across the readable pool — five in the amaro
episode, one in the absinthe episode and one in the kombucha episode — and every one is
the word used as a category label. None explains the mechanism. `residual sugar` 0, `mutage` 0, `grape spirit` 0.

**This is the most structurally expensive empty beat in Act V.** The spine calls it *"the
most economical explanatory beat in the whole Foray"* — one mechanism, four famous
drinks — and it is also the last of beat 5's four routes past the ceiling to be
demonstrated. With 5 and 52 both empty, the Foray's enumeration of routes past the
ceiling is never opened and never closed.

### Beat 53 — port: early spirit, a race, two ages — **empty**

**Nothing readable, and one identified source that this report is the first to name.**
`port` returns 136 naive hits, 2 in discover and 52 in the archive after word boundaries,
and **50 of the 52 are seaports, airports and reports** — but two are the drink, and both
are The Rest Is History: **289: Drink** (3,360 s), which §10a ranks, and **12 Days: Port
wine and Darwin sets sail** (1,800 s), hook *"How the English's fondness for Portuguese
fortified wine began"*. The second is an episode about port's history against an empty
chain beat and it is ranked in §10a. Neither can be read: The Rest Is History ships zero
transcripts across 713 episodes. `lagares`, `treading` and `tawny` return zero. The one
drink-sense mention in a read transcript is the whiskey hour's *"Angels Envy decided to
start finishing in pork casks"* and *"even Jack Daniels did this. A port cask"*, which is
beat 14's cask trade.

**A note on how that near-miss was nearly missed.** An earlier draft of this entry called
all fifty-two archive hits seaports and airports, on the strength of the count alone. Two
of them were not, and the review that caught it is the reason §2c's warning about sense
collisions cuts both ways: a collision class is a reason to read the hits, not a reason to
dismiss them.

### Beat 54 — sherry: the flor and the solera — **empty**

**Nothing.** `solera` 0, `criadera` 0, `flor` in the yeast sense 0 across 13 archive
hits that are all surnames, `fino` 0, `oloroso` 1 and it is inside beat 14's
second segment as a cask type. The spine calls this *"the best single case study in the
entire Foray for question four"* and the one place where maturation is performed by a
living organism. There is no tape.

### Beat 55 — madeira: heat as maturation — **empty**

**Nothing.** `madeira` 0, `estufagem` 0, `canteiro` 0, `maillard` 0.

### Beat 56 — vermouth as stacked additions — **empty**

**Nothing**, and this is the beat where a raw count would most badly mislead.
`vermouth` returns 0 in both catalogue pools but **20 hits across three read
transcripts** — 11 in the amaro episode, 7 in the absinthe episode, 2 in the gin
episode — which looks like coverage and is not. Seven of the twenty are martini service
(*"it annoys me when asked for a dry martini when they just put their vermouth in, swish
it around, then dump it out"*), which is §6b cocktails and service. One is the
etymology, at absinthe 503.08 → 525.88: *"in German wormwood is called the ver moot …
Vermouth is a fortified wine that contains wormwood, among other things."* The best of
them is the amaro comparison at 1192.40, where vermouth *"is also infused with bitters
and botanicals and It is also a bitter sweet and used as a bitter sweetening agent in
cocktails. It is very wormwood forward."* That is two of the four layers, with the base
wine, its legal proportion and the fortification step all absent, and it is framed as a
cocktail ingredient, which the beat rejects by name. Beat 56's claim is the *stacking*,
and nothing here stacks. `artemisia` 0 and `quinquina` 0; `americano` returns **1** archive
hit and it is a Spanish-language true-crime episode title, not the aromatised wine.

### Beat 57 — liqueurs and how flavour is captured — **thin**

**Chosen:** SYSK That's Amaro!, band **393.88 → 470.00 (76.1 s)**. In on *"to make a
marrow is actually very easy"*; out on *"…most Italian amorrow is or amari is grappa,
yes, or wine."*

**Why it advances beat 57.** It is the only passage in the readable pool that treats
extraction as the variable: *"you just soak some some bittering agents and herbs,
whatever your proprietary blend is. You let it soak for a little while. Sometimes you
might redistill it with the herbs and botanicals in it, but a lot of people just
let it sit for a while … and then I think that's called mass rating or infusing … and
then you add a little sugar after you filter out the solids, and then you let it age for
several years."* Maceration against redistillation, plus the sugar, plus the base spirit
as a choice — *"that base alcohol can vary. A lot of times It will be grappa, which is
great brandy"* — is beat 57's construction, in a beat's-worth of one breath.

**Why it is thin.** The beat's actual distinguishing claim is that the category is
defined in law by a minimum sugar content and that everything else is extraction
technique, and neither the legal minimum nor the higher thresholds certain names require
appear anywhere. Two of the four techniques are missing — percolation for barks and
roots, and purchased essences at the industrial end — and so is what heat does to
delicate aromatics. Emulsion stability in cream liqueurs is absent. And the monastic
liqueurs are present in the wrong register: `chartreuse` returns 0 in both catalogue
pools and twice in this episode, at 2172.60 and 2210.52, as recipe secrecy and a
botanical count — *"only two of them know … there's one hundred and thirty two botanicals
in chartreuse"* — where the beat asks for *"the monastic-recipe secrecy handled as a
commercial convention rather than as mystique"*. `bénédictine` returns 0 everywhere. And see
§2c — this episode is evidence for the region {57, 58} rather than for either beat, so
the split between them is a judgement recorded rather than a fact found.

### Beat 58 — bitters, amari and real medicine — **thin**

**Chosen:** same episode, band **706.92 → 782.52 (75.6 s)**. In on *"There's no rules.
There are rules, and we'll get into him late"*; out on *"…you'll see on a label something
that says China."*

**Why it advances beat 58.** It names the bitter compounds and gives one of them a real
pharmacological lineage rather than a decorative one: wormwood as *"a classic bittering
agent"*, then *"sinchona, which … it's a bark of a tree in South America. It's where you
get quinine, which they used to treat malaria and is what gives tonic water. It's very
bitter taste. Yeah, so a lot of a lot of Amari use sinchona in it."* Quinine, the bark,
the antimalarial use and the tonic-water link in one span is the beat's medical-lineage
claim at its most concrete.

**Why it is thin.** Gentian is named earlier in the episode and only as a punchline —
*"here, gentiin meat, moonshine essentially"* — so the beat's leading bitter compound has
no account. The beat's strong signal is *"a distinction drawn between the products whose
medical claims were real pharmacology and those that were patent-medicine advertising"*,
and the episode instead hedges in one direction: *"I don't think it's some snake oil cure
all or anything, but I believe it's a legit digestive. Plus also, um, a lot of those herbs
are like hepato protective."* That is the opposite of the distinction. Also missing: how
bitterness is balanced against sugar, and any documented medicinal registration or patent
history. The aperitivo and digestivo split is present but as a serving convention rather
than as a preserved theory of digestion.

### Beat 59 — the anise family and a wrong ban — **thin**

**Chosen:** SYSK The Myth of Absinthe, band **2334.52 → 2450.48 (116.0 s)**. In on
*"But for the most part, if you wanted to get absinthe, it was very, very difficult"*;
out on *"…you can't import something labeled absinthe or any bottle that you know, shows
like people tripping."*

**Why it advances beat 59.** It is the beat's myth-correction, made as a correction: the
syndrome named, then withdrawn — *"Absinthe is um this UH syndrome, which was the
collection of maladies everything from m hallucination, sleeplessness, tremors,
convulsions, madness from drinking absinthe. And in retrospect historians say this didn't exist. Like
what this person was describing was excessive alcohol use, like all this stuff you can get
from drinking way too much high proof alcohol"* — with the mechanism of the panic named
explicitly: *"there was an accompanying made up syndrome to to give like a veneer of
science to the moral panic."* It closes with a number, the modern *"through jone free …
less than ten parts per million"* limit.

**Second, and it is the half the spine cares most about:** **2021.40 → 2071.24 (49.8 s)**,
the wine industry's role in the bans, which is beat 59's own claim that they tracked
temperance politics and a wine trade rebuilding rather than any toxin: *"And then wine
makers, which is sort of weird, got involved in the temperance movement in a way when they
said, yeah, absentthe is terrible and it's not like cognac … But this stuff is really bad
stuff. It's cheap and it's it's it's petty, and it's for the lower class. So we're going to join up
in the temperance movement ourselves to help get rid of it."* At 49.8 s it is above the
floor and below the band.

**Why it is thin.** The production half of the beat is almost absent and the physical
chemistry is entirely absent. There is no anethole and no louche: `anethole` 0 and
`louche` 0 across every source read, so the emulsion the beat calls *"a nice piece of
physical chemistry the listener can verify in a glass"* is unsourced. The family across
borders is missing — `ouzo`, `raki`, `pastis` and `sambuca` are all 0 — so the beat's
"one compound in many countries" framing has exactly one country. And the correction is
made against the modern legal limit rather than against *"the measured thujone content of
surviving pre-ban bottles"*, which is the evidence the beat asks for by name.

### Beat 60 — the additive frontier, both ways — **empty**

**Nothing.** `seltzer` returns 4 archive hits, of which the closest is Adam Carolla's
*"Hard Seltzer Taste Test"*; `dealcoholis`/`dealcoholiz` 0, `spinning cone` 0, `reverse
osmosis` 0, `vacuum distillation` 0, `ready-to-drink` 0.

**The nearest candidate is a stop and it is worth naming**, because it looks like a hit.
`craft-beer-and-brewing-magazine-podcast--the-post-s-nick-tedeschi-brews-flavorful-low-abv-beers-for-g`
(3,914 s), *"A brewer makes the case for flavorful, low-alcohol beer built for real
food"*, is the only low-alcohol row in the catalogue and beat 60's second half is about
low alcohol. But brewing a beer to a low strength and *removing* ethanol from a finished
drink are different operations with different physics, and the beat's claim is about the
second — *"a fifth question the four cannot answer"*. Brewing to 3 % is question two. **Stop.**

---

## 8. Act VI — the rules, and the coda (chain, beats 61–63)

**No strong tape, one thin, two empty.**

### Beat 61 — category law is production law — **thin**

**Chosen:** SYSK Short Stuff: Whisky or Bourbon?, band **62.52 → 198.00 (135.5 s)**. In
on *"So around the world, if you have Japanese whiskey"*; out on *"…it all has to come
from the same state as to be still distilled in the same state."* The out-point is 198.00
rather than 194.28 because the cue carrying the last four words of that anchor *starts* at
194.28 — a band that ends there ends mid-anchor, which is the kind of off-by-one-cue error
an anchor check would catch at mint time and a reader would not.

**Why it advances beat 61.** It states the beat's thesis as a comparison between
regulatory regimes rather than between drinks: *"when you get to America … we have like
the most strict, extensive laws detailing what can be considered a type of whiskey any of
anywhere in the world … it's very much regulated by the Alcohol and Tobacco Tax and Trade
Bureau"*, and then reads the specification off as a production mandate — new charred oak
containers, a grain percentage, two years, same-state distillation. That is a statute
functioning as a recipe, which is the beat's whole claim.

**Why it is thin.** The beat's strong signal is *"at least two jurisdictions contrasted
so that the arbitrariness is visible — the same liquid legal under one name and not
another"*, and the second jurisdiction here is a shrug: *"I don't believe there's too many
um like laws or anything restricting types of whiskey. I'm sure there are in Scotland. But
we're talking about America in this episode."* Geographical indication as a legal
mechanism is absent, so is cross-border enforcement and litigation, and so is the honest
account of what the rules genuinely preserve. The whiskey hour supplies one adjacent fact
that beat 61 could use and beat 14 is taking — that American single malt *"It's now a
defined brand whiskey category in the code of reference"* — which is a category coming
into existence, and the closest this catalogue gets to the beat's arbitrariness point.

### Beat 62 — proof, the hydrometer and 40 % — **empty**

**Nothing.** §5 ranked this eighth-hardest, needing *"a historian of measurement or
taxation"*, and the outcome is worse than absence: `proof` returns **33** hits across the
eight read transcripts that use it at all, and **every one is a number**, used as a unit
by speakers who never say what it measures. The Short Stuff uses it ten times without
defining it once; the
amaro episode manages *"Proof is double the percentage, right"*, which is the American
convention stated as arithmetic with no institution behind it. `hydrometer` 0,
`gunpowder test` 0, `minimum bottling strength` 0, `duty` 0 in this sense.

**What is missing.** The whole institutional half: proof spirit as a reference strength
for levying duty, hydrometers commissioned for revenue purposes, and the minimum legal
strengths and duty thresholds that are why so much of the world's spirit sits at 40 %.
The beat's specific instruction — that the gunpowder test is attested while its status as
the origin of the legal term is the traditional account — cannot be tested against tape
that never mentions either.

### Beat 63 — coda: four questions, open list — **empty by design**

**Nothing, correctly.** §5 ranked this fifteenth and last of its narration predictions
and called it designed as narration. Confirmed, on the same reasoning as beat 16:
nothing in the readable pool articulates the shared mechanism across families, and the
only cross-family speech in the pool sorts drinks by strength or by prestige.

**One candidate was considered and it is the closest miss in the report.** Beat 24's
world-survey passage, `this-podcast-will-kill-you` 3893.28 → 3960.04 (66.8 s), does
demonstrate half of this beat's claim — that alcohol was made from whatever sugar was
locally available, on six continents — and it even concedes the incompleteness the beat
wants: *"Much of the very early history of alcohol is a bit like guesswork."* It is
rejected because the other half is missing entirely. There is no molecule and no
organism in it, so it is a list of feedstocks rather than the shared mechanism, and beat
63's evidence line asks for *"a speaker articulating the shared mechanism across families
rather than within one."* A coda that lists is the thing a coda must not be.

---

## 9. Summary

### 9a. Counts

| Verdict | Beats | Which |
|---|---|---|
| **Strong** | **1** | 26 |
| **Thin** | **15** | 3, 12, 14, 20, 27, 30, 36, 39, 41, 42, 43, 57, 58, 59, 61 |
| **Empty** | **47** | 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 28, 29, 31, 32, 33, 34, 35, 37, 38, 40, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 60, 62, 63 |

1 + 15 + 47 = 63, and every beat has a heading in §3 to §8 so the three lists can be
checked against the document rather than against each other.

**By act:**

| Act | Beats | Structure | Strong | Thin | Empty |
|---|---|---|---|---|---|
| I — one molecule, four questions | 1–16 | **chain** | 0 | 3 | **13** |
| II — sugar already sweet | 17–25 | fan, chain inside wine | 0 | 1 | 8 |
| III — sugar unlocked | 26–35 | fan, chains inside beer and koji | **1** | 2 | 7 |
| IV — concentration | 36–51 | chain link, then fan | 0 | 5 | **11** |
| V — made by addition | 52–60 | chain link, chain, fan | 0 | 3 | 6 |
| VI — the rules and the coda | 61–63 | chain | 0 | 1 | 2 |

**Weighted by the spine's own share column, which is the more honest measure than a
beat count:** the strong beat is **2.0 %** of intended runtime, the fifteen thin beats
are **25.8 %**, and the forty-seven empty beats are **72.2 %**. The shares sum to
100.0, which is the check that the three groups partition the spine.

**Two sensitivities on those counts, and they point the same way.**

- **The SYSK register decides eleven of the fifteen thin verdicts.** Beats 3, 12, 20,
  39, 41, 42, 43, 57, 58, 59 and 61 rest entirely on Stuff You Should Know. If the
  founder rules that register out, the report reads **1 strong / 4 thin / 58 empty**
  and the thin tier's share falls from 25.8 % to **7.2 %** — beats 14, 27, 30 and 36 at
  2.0, 1.7, 1.5 and 2.0 per cent.
- **Nothing here is playable today.** Every source is DAI-suspected, so all sixteen
  spans are authorable-and-unplayable under `ADR-0008` until the locate step exists.
  The counts above are what could be *authored*, not what a listener could hear.

### 9b. Where the holes fall — chain versus fan

This is the part of the report that matters most, and it is worse than the spine's
worst case. The spine's §2a graded holes into three kinds and concluded that Act I is
the most dangerous place for one and the small family stops the safest. Both halves are
now measured, and the holes fell in the dangerous place.

**Of the 47 empty beats, 30 are chain beats and 17 are fan stops.** Nine of the fifteen
thin beats are chain beats too, so **39 of the spine's 40 chain beats have no strong
tape** — the exception is beat 26.

| Chain segment | Beats | Result |
|---|---|---|
| Act I, the derivation | 1–16 | **13 empty, 3 thin, 0 strong** |
| the wine chain | 17–21 | 4 empty, 1 thin |
| the beer chain | 26–30 | **1 strong**, 2 thin, 2 empty |
| the koji chain | 32–33 | 2 empty |
| the distillation chain link | 36 | thin |
| the whisky chain | 37–40 | 3 empty, 1 thin |
| the fortification chain link | 52 | empty |
| the fortification chain | 53–55 | **3 empty** |
| Act VI, the landing | 61–63 | 1 thin, 2 empty |

Four things follow, and the first is the one that decides whether this Foray is
buildable.

- **Act I is a broken derivation from end to end.** Not one of its sixteen beats has
  strong tape, and the three that have anything at all are about a nitrogen widget, a
  continuous still and an oak tree. The spine's §2a grades a hole here as *"a broken
  explanation"* and gives it the highest cost in the document; there is no hole here to
  cost, because there is no floor. **This is the finding that cannot be worked around by
  transcription**, since §10's entire queue would close at most three of the thirteen.
- **The fortification chain is four for four empty**, and it takes beat 5 with it. Beat 5
  enumerates four routes past the alcohol ceiling and beat 52 is the last of them to be
  demonstrated; with 5, 52, 53, 54 and 55 all empty, the Foray opens an enumeration in
  Act I and never closes it anywhere. Sherry's *flor* — which the spine calls the best
  single case study in the document for question four — has no tape of any kind.
- **The one strong beat is a chain beat, which is the only piece of luck in the
  report.** Beat 26 is the head of the beer chain and the worked example the founder's
  *"walk me through the production process"* most directly asks for. If exactly one beat
  in sixty-three were going to come back strong, this is close to the best one it could
  have been.
- **The fan is not the problem, and that inverts the usual complaint.** Seventeen empty
  fan stops would be a tolerable Foray if the chain held — the spine says a missing
  family stop *"reads as a change of subject"* and costs little once narration announces
  the boundary. Here the fan's empties are the cheap ones and the chain's are the
  expensive ones, which is exactly the distribution the spine hoped to avoid.

### 9c. How §5's predictions did

§5 recorded its predictions so this report could check them, and it did unusually well
in one direction and badly in the other.

**Likely-narration predictions: 15 of 15 correct.** §5's fifteen numbered items name
sixteen beats — 16, 9, 51, 25, 5, 50, 31, 62, 11 and 12 as one item, 47, 3, 24, 34, 15
and 63 — and every one of the sixteen came back empty or thin, which for a narration
prediction is the same answer. **Fourteen are empty and two are thin (3 and 12), and not
one was falsified.** Barbecue's equivalent
scorecard was 11 of 13, so this is a better result on a longer list, and the reason is
worth stating: §5 reasoned from what English-language podcasting covers at mechanism
depth, and that reasoning is sound in both catalogues.

**Over-supply predictions: 0 of 5 correct, and this is where the spine was most wrong.**

| §5 predicted over-supplied | Actual |
|---|---|
| beats 37–40, whisky — *"the place this Foray will bloat first"* | **3 empty, 1 thin.** One 13-minute Short Stuff |
| beat 42 gin, beats 57–59 liqueurs, amari, absinthe | **4 thin**, from three episodes — gin, amaro, absinthe. The best-served cluster in the report |
| beat 20 champagne, beat 19 winemaking choices | **20 thin on one episode, 19 empty** |
| beat 30 wild fermentation, beat 44 agave | **30 thin, 44 empty.** `agave` returns 0 |
| beat 36 the origin of distillation | **thin**, and it declined to name an inventor |

**The lesson is the same one barbecue's report reached, and it now has two data
points.** §5's reasoning about the *medium* was right and its reasoning about the *pool*
was wrong, because **the pool is not English-language podcasting** — it is 213 curated
shows plus a 1,534-item recommendation set, and neither was built for this subject. The
fill pressure the spine was designed to resist does not exist as tape. There is no
gin-and-absinthe bloat to defend against; there are two episodes.

**And the drift attractors behaved exactly as §5 said they would, which is the one place
the over-supply prediction did hold.** §5 named prohibition and temperance first, health
second, cocktails third. All three are present and all three are the *only* abundant
adjacent material: SYSK's Prohibition and Whiskey Runners episodes, Huberman's and This
Podcast Will Kill You's alcohol-and-health hours, and the martini and bar material inside
three of the episodes that did produce cuts. **Nothing from any of them entered a beat.**
The one place it came close is beat 56, where twenty `vermouth` hits turn out to be seven
parts martini service.

### 9d. An honest projected runtime, from the strong beats alone

**A. The strong beat alone — 1 segment, 99.8 s, 1.7 minutes.**

| Beat | Segment | Seconds |
|---|---|---|
| 26 | `being-an-engineer` 385.59 → 485.34 | 99.8 |
| | **1 segment** | **99.8 s — 1.7 min** |

That is the number to quote if only one is quoted. **One minute and forty seconds of
tape that meets the gate, across sixty-three beats**, and it cannot be played until the
locate step exists.

**B. Everything admitted, thin tier included — 16 segments, 1,664.3 s, 27.7 minutes.**
Sixteen rather than fifteen because beat 14 takes two segments and beat 27 takes none.
This is a **ceiling**, not a plan: it assumes the founder admits the SYSK register, which
§9a says would be eleven of these sixteen, and it assumes the locate step exists.

**B′. The same set with the out-points trimmed as the beat entries recommend — 1,622.8 s,
27.1 minutes.** Three bands trail into material their beats reject: beat 36's into naval
rations, beat 41's into a Bombay Sapphire aside, beat 43's into bagasse. Trimmed at the
nearest cue boundary in each case — 4540.64, 606.16 and 985.08, giving 91.8 s, 107.7 s and
45.3 s — that costs 8.12 + 15.04 + 18.32 = **41.5 s**, and it is the honest figure for what
a careful assembly would actually keep.

**A further 430.4 s across six alternates is specified in §3 to §8 and deliberately not
counted** — beat 3's exploding bottles, beat 20's second fermentation, beat 26's cleaning
chemistry, beat 36's medical lineage, beat 42's legal categories, beat 59's wine trade.
Some of them are better tape than the primaries they support. They are excluded because
counting a beat's alternate toward runtime is how a coverage report starts arguing for a
longer Foray than it can justify.

**None of these is a runtime for the Foray.** Sixty-two of the sixty-three beats are
narration beats — the 47 empty plus the 15 thin, since §1 defines a thin beat as a
narration beat with a partial supporting cut — and narration length is stage 4's to
estimate. For scale: at the spine's own 150-minute reference, 72.2 % of the runtime is
empty beats, which is about 108 minutes of narration.

**What the length rules say about set B, because it is not automatically legal.**

- **D1, the cut budget: passes with room.** Sixteen segments over any plausible runtime
  is 3.6 starts per rolling 600 s at 45 minutes and 1.8 at 90. The spine's §4a was
  written expecting the cut budget to bind. It is nowhere near binding.
- **D3, the whole-Foray mean ≥ 90 s: passes at 104.0 s.**
- **D5, the whole-Foray IQR ≥ 45 s: fails, at 36.6 s.** Under the interpolated
  convention Q1 is 81.0 and Q3 117.7; under the exclusive convention 79.8 and 119.4, for
  an IQR of 39.6. **Both are below the 45 s floor**, which matters because
  `segment-length-rules.md` §10 records the quartile convention as unresolved and this
  finding does not depend on resolving it. Fifteen of the sixteen spans sit inside the
  75–180 s band and eleven of them between 82 and 142 s, so the set is too uniform to
  ship as it stands.
- **The fix is the one the spine's §4a already names**, and it is now needed for a
  different reason than the one §4a anticipated: a share is a per-beat allowance and
  never a per-segment target, so assembly has to break uniformity deliberately. With
  sixteen segments and sixty-two narration beats, the variety will have to come from the
  narration lengths rather than from the tape, which is a fact stage 4 should have before
  it starts.

---

## 10. The ranked ASR proposal, and the stops

Not decisions — this report does not own them. Ordered by how many beats each row would
move, with the hypothesis stated falsifiably so the next pass can score it the way §9c
scored §5.

**The single most important thing about this queue is how short it is.** Barbecue's
report ended with a nine-item list of actions; this one has **five rows worth buying**
and then a wall. That is not a sorting problem, it is the catalogue. `data/discover.json`
holds **21** rows whose subject reaches an alcohol beat closely enough to score — ten
Craft Beer & Brewing, four Experimental Brewing, three FermUp, two Gastropod, one Rest Is
History and the whiskey hour. **Twenty of the twenty-one have no publisher transcript**;
the whiskey hour is the exception and has already produced beat 14's second segment. Of
the other twenty, four are ranked below, one is conditional, one is recorded as uncertain
and **the remaining fourteen are stops** for reasons ASR cannot change. §11 is where the actual recommendation lives.

**A note on cost, because it is the same for every row.** None of the five has a
publisher transcript of any kind, so each is a full local ASR job. Craft Beer & Brewing, Experimental
Brewing and FermUp are all `dai_suspected: false`, so cuts from them would be **playable
immediately** rather than blocked on the locate step — which is a real advantage over
every source that produced a verdict in this report, and it should weigh in the ranking.

### 10a. Worth buying, in value order

**1. `fermup--93-researching-fermentation` (2,807 s, non-DAI, no transcript).** Hook:
*"A researcher explains what actually happens, chemically, when food ferments."*
Target: **beat 2**, and possibly **beat 10**. Both are empty Act I chain beats and beat 2
is the foundation the whole spine rests on — §1 of the spine calls it *"the shared
chemistry the whole through-line rests on"*. This is the only row in 1,534 items whose
description promises the register beat 2 requires, and at 47 minutes it is the shortest
purchase in the queue.
**Falsifiable hypothesis:** the episode states the pathway or the yield ratio out loud.
**How it fails:** a researcher talking about *food* fermentation — kraut, miso, koji as a
culinary ingredient — never reaches ethanol stoichiometry, and beat 8's reject line
already names that failure mode. FermUp's two neighbouring rows are Sandor Katz and a
tofu-and-miso historian, which is evidence for the culinary reading.

**2. `craft-beer-and-brewing-magazine-podcast--brewing-scientists-shellhammer-chenot-older-hops`
(4,397 s, non-DAI).** *"Brewing scientists test what warehouse-aged hops can still do two
to four years after harvest."* Target: **beat 27**, which is currently thin only by
dependency on beat 26's carrier and would be the cheapest chain upgrade in the report.
Two named brewing scientists is the strongest register in the whole recommendation pool.
**Falsifiable hypothesis:** alpha acids, their isomerisation and the aroma-oil trade are
discussed as chemistry, since ageing hops *is* alpha-acid and oil degradation.
**How it fails:** it is a study-results interview about shelf life and stays on
measurement rather than on why bitterness and aroma are bought at opposite ends of the
kettle.

**3. `craft-beer-and-brewing-magazine-podcast--495-fermenting-expressive-hoppy-beers-with`
(3,913 s, non-DAI).** *"How historic brewing yeasts and modern hop chemistry shape
today's expressive hoppy beers"*, in partnership with White Labs. Target: **beat 4**
(domesticated yeast and pure culture, empty) and **beat 10** (esters and the temperature
lever, empty). A yeast-laboratory collaboration is where strain selection as a production
decision would be discussed if it is discussed anywhere in this catalogue.
**Falsifiable hypothesis:** "historic brewing yeasts" means strain provenance and
propagation, which is beat 4's second half.
**How it fails:** dry yeast as a *product* recommendation for homebrewers, with no
genetics and no consequence — which is beat 4's reject line verbatim.

**4. `The Rest Is History — 289: Drink` (3,360 s, DAI, no transcript) and its sibling
`12 Days: Port wine and Darwin sets sail` (1,800 s).** Description: *"Tom and Dominic are joined by author and alcohol
historian Henry Jeffreys to discuss some Christmassy tipples, from sherry to port,
champagne to clairet."* Target: the **fortification chain, 52 to 55**, all four empty,
and it is the **only identified source in either pool that names sherry and port as
drinks rather than as a surname and a harbour**. A named alcohol historian is the right
register for beat 52's mechanism and beat 54's *flor*.
**One cost, and one correction to an earlier draft of this section.** The Rest Is History
**is** in `data/catalog.json` and in `data/transcript-availability.json`, which is where
the 713 comes from; only these two *episodes* are absent from `data/discover.json`. So this
is an episode-and-ASR action, not the catalogue action §11 recommends, and an earlier draft
of this row said the opposite. The real cost is that the show ships **zero** transcripts
across 713 episodes, so both are ASR from scratch.

**The port-wine episode is the better of the two for beat 53 and the worse bet overall.**
At 1,800 s it is half the length and its hook is squarely on subject — *"How the English's
fondness for Portuguese fortified wine began"* — but it is a two-subject Christmas
"12 Days" episode whose other half is Darwin and the Beagle, and beat 53's claim is about
extraction against a clock rather than about how a trade began. Buy it second, after 289,
and only if 289 lands.
**Falsifiable hypothesis:** an alcohol historian asked about sherry says what the *flor*
is.
**How it fails, and the risk is high:** it is a Christmas special about what to drink,
the format is two hosts and a guest riffing on tipples, and the same episode's second
half is *"why certain drinks revealed your political leanings"* — which is §6b drinking
culture. Rank 4 rather than 1 because the expected value is high and the variance is
higher.

**5. `craft-beer-and-brewing-magazine-podcast--episode-497-todd-malloy-and-robin`
(4,877 s, non-DAI).** *"on brewing medal-winning lagers on a small pub system."* Target:
**beat 28**, an empty beer-chain beat whose only candidate is factually wrong.
**Falsifiable hypothesis:** brewers committed to lager discuss the cold chain, because on
a small system lagering time is the binding constraint on tank turnover.
**How it fails:** it is a brewpub-economics and recipe interview and the yeast is a
purchased input nobody discusses. Ranked last of the five for that reason.

**One conditional row, on the barbecue report's pattern of a "conditional second shot".**
`craft-beer-and-brewing-magazine-podcast--jake-watt-wet-hop` (4,998 s), *"Jake Watt's
gold-medal wet-hop IPAs change recipe every year, chasing a moving target"*, with hot-
and cold-side technique in the title. It targets the **aroma half of beat 27** that rank 2
may well not deliver, since ageing hops is a bitterness-and-degradation subject and
wet-hopping is an aroma one. **Buy it only if rank 2 lands and beat 27 still lacks the
other end of the kettle.** Two rows bought against one thin beat before the first is read
is depth rather than rescue, which is the thing barbecue's §9 says to stop doing.

**A sixth row is genuinely uncertain and is recorded as such rather than ranked.**
`craft-beer-and-brewing-magazine-podcast--mike-stein-and-pete-jones-of-lost-lagers-look-back-at-americ`
(4,485 s), *"Two brewers look back at 250 years of American beer history."* It could
serve **beat 35**, since historical-lager revivalists have to reconstruct pre-Prohibition
adjunct rates and that is beat 35's own subject, or it could be era-and-brand nostalgia,
which §6b excludes. I cannot separate those two readings from the metadata and I am not
willing to rank a row I cannot state a hypothesis for. If the top five are bought, buy
this sixth and score it; if only three are bought, leave it.

### 10b. Stops, not low priorities

Barbecue's last ASR round transcribed seven episodes and moved no beat, and the lesson its
§9 drew is that *"priority ordering is the wrong instrument for expressing "do not buy
this.""* — a row whose value is depth rather than rescue should be a stop, because
*"draining the tail of a correctly-sorted queue is what produced a seven-episode pass that
moved nothing."* So these are **stops**. Each is on the Foray's subject and each
would move no beat.

| Row | Length | Scored against | Why it is a stop |
|---|---|---|---|
| `experimental-brewing--episode-207-fonio-fonio-what-the-heck-are-you-fonio` | 3,900 s | 31 | The only West African grain row in the catalogue, against an empty beat, and it is two homebrew authors experimenting with a novel grain. §6b excludes home brewing as a how-to and beat 31's claim is a continent's design decision. **The most tempting stop in the list** |
| `gastropod--absinthe` | 2,714 s | 59 | Depth on a beat that is already thin, and Gastropod ships zero transcripts across 293 episodes. Barbecue's §9 lesson applies exactly: a row whose value is depth rather than rescue is a stop |
| `the-rest-is-history--wine-civilisation` | 4,543 s | 17–21 | *"How wine built civilization — from Homer's Odyssey to Julius Caesar's conquests"*, plus the Judgement of Paris. Ancient history and a tasting. No production claim in the five wine beats it would be scored against |
| `gastropod--beer-and-writing` | 3,358 s | 26 | Mesopotamian cuneiform and beer. Beat 26 is a process sequence; this is the archaeology beat §6a already dropped |
| `craft-beer-and-brewing-magazine-podcast--the-post-s-nick-tedeschi-brews-flavorful-low-abv-beers-for-g` | 3,914 s | 60 | Brewing *to* a low strength is question two; beat 60's claim is *removing* ethanol from a finished drink. Different operation, different physics. See §7 |
| `craft-beer-and-brewing-magazine-podcast--496-tonya-cornett-and-ian-larkin` | 4,618 s | 30, 35 | Collaboration and business across three breweries. §6b excludes the industry as a business |
| `craft-beer-and-brewing-magazine-podcast--494-patrick-raasch-of-sunriver-builds` | 4,586 s | 10, 26 | Medal-winning hop-forward beers and left-field culinary ingredients. Recipe and style |
| `craft-beer-and-brewing-magazine-podcast--498-andrew-sabatine-of-around-the` | 4,504 s | 28, 29 | Lagers and West Coast IPA without abandoning hazy fruited beers. Style positioning |
| `craft-beer-and-brewing-magazine-podcast--wynn-whisenhunt-of-wondrous-makes-better-beer-by-doing-less` | 4,368 s | 26, 29 | *"why doing less often makes for noticeably better beer"* — a philosophy interview |
| `experimental-brewing--episode-210-bob-and-denny-take-belgium-part-2` | 3,540 s | 30 | Belgian brewing tradition, part two of two, by homebrew authors. Beat 30 is already thin and lambic microbiology is not what a travel-and-tradition episode delivers |
| `experimental-brewing--episode-203-27-years-of-experience-in-norcal` | 3,803 s | 26 | A career retrospective |
| `experimental-brewing--episode-211-8211-homebrewcon-8211-asheville` | unknown | — | Live reflections from a homebrew convention. Also the only on-plot row in the pool with a null duration |
| Around the House's `From Mold to Whiskey` (3,642 s) and `Cleaning Tile and Grout and talking Whiskey` (2,383 s) | — | 14 | The other two whiskey-titled rows in that show, identified from `transcript-availability.json` rather than from `discover.json`, which holds neither. The one episode already read gave 88 s on cask finishing out of 1,493 s; these are home-improvement episodes with a whiskey tail |
| `fermup--101-sandor-katz` | 1,410 s | 2, 10 | Fermentation's best-known evangelist on technique during a residency. Kraut and koji as food, and at 23 minutes the shortest on-plot row in the pool |
| `fermup--100-bill-shurtleff` | 1,784 s | 2, 8 | The definitive tofu-and-miso reference author. Soy fermentation, and beat 8's reject line names koji-as-culinary-ingredient specifically |
| `this-podcast-will-kill-you` Ep 210 Histoplasmosis, Ep 188 Candida | 4,727 / 4,637 s | 4 | Both are `yeast` title hits and both are fungal pathogens. Beat 4 needs *Saccharomyces* |
| `odd-lots` — the two $200-a-barrel oil rows | 2,195 / 2,925 s | 14 | `barrel` title hits, and the barrels are oil |

**And one whole class of stop, stated once rather than fifteen times.** Every SYSK row in
§2d marked *"Nothing"*, plus the five left unread on §6b grounds, is a stop for the
purposes of this Foray and stays in the catalogue for playlists. The Prohibition episode
in particular is a good episode about a real subject that is not this one.

---

## 11. Where the spine, not the tape, is the problem — and the one action that would change everything

Four findings that are not sourcing outcomes. Recording them rather than quietly
reshaping the spine, per the brief. **The spine is untouched by this pass.**

**1. The recommendation is a catalogue action, not a transcription action, and this is
the report's most useful output after the counts.** §10's five purchases would, at
absolute best, move beats 2, 4, 10, 27, 28 and the fortification chain — and four of
those six are single hypotheses that could each fail. Meanwhile the material this Foray
needs demonstrably exists and is not in the catalogue. `data/catalog-breadth.json` holds
**81** drinks-shaped shows of which **exactly one is curated** (Craft Beer & Brewing),
and 37 of the 81 sit in Apple's Food genre:

| Show | Episodes | Beats it plausibly reaches |
|---|---|---|
| `I'll Drink to That! Wine Talk` | 504 | 17, 18, 19, 21, 52, 54 — a long-form winemaker interview show |
| `Inside Winemaking - the art and science of growing grapes and crafting wine` | 222 | 17, 18, 19 — the title is beat 17's own framing |
| `Cider Chat` | 511 | **22**, the only identified source for it anywhere |
| `Basic Brewing Radio` | 975 | 7, 26, 29, 30 |
| `The Brewing Network Presents \| Brew Strong` | 361 | 7, 10, 26, 28, 29 — a technique-only format |
| `Good Beer Hunting` | 743 | 30, 35 |
| `Bourbon Pursuit` | 1,191 | 14, 37, 38, 39, 61, 62 |
| `Spirits & Distilling Podcast` | 47 | **11, 12, 13** — the three Act I distillation beats |
| `Got Somme : Master Sommelier's Wine Podcast` | 150 | 17, 18, 19, 52, 54 |
| `Wine for Normal People` | 94 | 17, 18, 20, 52 |

`data/catalog-breadth-intl.json.gz` adds **257** more, including English-language rows
that reach beats nothing above does — `One Nation Under Whisky` (382 episodes),
`The Distillery Nation Podcast` (141), `UK Wine Show` (860), `Interpreting Wine` (602),
`Hop Forward: Getting You Ahead in the Brewing and Beer Business` (211).

**None of this is scoreable at beat level today**, because the breadth files carry
show-level metadata with no episode lists, so the table above is a set of hypotheses
rather than findings, and it is deliberately labelled as such. But the shape of the
answer is not in doubt: **this Foray is a curation problem before it is a sourcing
problem.** Adding five to ten of these shows to `data/catalog.json`, then running a
stage-2 pass against their episode lists, is the action with by far the highest expected
value in this document — and it is the action barbecue could not take, because barbecue's
equivalent search had already established that the tape does not exist anywhere. Here it
plainly does.

**2. The Odd Lots white-oak episode is good tape that no beat in the spine can hold, and
that is a spine gap rather than a rejection.** Its subject is that a hundred-year-growth
single species with an eighty-dollar-an-acre regeneration cost and a projected 70 % supply
decline is a hard constraint on an entire spirits category. Beat 14 takes 96 s of its
cooperage mechanism, and the constraint itself — the thing the episode is actually about —
has nowhere to go. §6a of the spine records dropping a cooperage beat and says explicitly
that *"a reviewer might reasonably reverse it: the sherry-cask supply chain in particular
is a hard economic constraint on whisky production, and if it is sourced it belongs inside
beat 14 as evidence rather than as a beat about equipment."* **It is now sourced, and it
does not fit inside beat 14, because beat 14's claim is a mechanism and this is an
economy.** Recommended amendment: extend beat 14's claim to name cask supply as a
production constraint, or restore the cooperage beat. Either is a founder-or-reviewer
call, not mine.

**3. Beat 27 should be re-scored the moment a word-timestamped transcript of the
Being an Engineer episode exists.** This is the one place in the report where a verdict
turns on transcript granularity rather than on content. The alpha-acid isomerisation
sentence is real, correct and inside a 68-second cue that beat 26 needs. A local ASR pass
with word timestamps on an episode that already has a publisher transcript sounds
redundant and is not: it would probably move beat 27 from thin to strong for the cost of
one job, and it is the cheapest beat upgrade available anywhere in this document. It is
not in §10's ranked list because it is not a new source.

**4. The catalogue's food and drink holding should be recorded as a known gap rather than
rediscovered.** `docs/curation/catalogue-broadening.md` §3 and `search-coverage-gaps.md`
are the natural homes. The two numbers worth writing down are that **56 items across
`food/cooking-science`, `food/fermentation` and `health/nutrition`** is the entire food and
drink holding of a 1,534-item pool, and that its drink half is **21 rows**: fourteen on beer
and brewing, three on food fermentation, one on beer and cuneiform, one on absinthe, one on
ancient wine and one home-improvement whiskey hour. Two Forays have now been commissioned
against a catalogue that cannot serve either of them, and the third will be too unless the
gap is written down where a commissioning agent will read it.

---

## 12. Can this catalogue support this subject

**No, and the honest answer is not close.**

Stated as plainly as the brief asks for: **one beat in sixty-three has tape that meets the
gate, and it runs for a hundred seconds.** Everything else is a narration beat. The
subject the founder asked for — *"what are all of them, walk me through the production
process for each"* — is a taxonomy-and-mechanism request, and this catalogue holds
essentially no production mechanism for any drink except beer, and for beer it holds one
usable answer from a chemist who no longer works in the industry.

Three things make that verdict firmer than a count.

- **It is not a search failure.** Forty-two hand-picked technical terms, twenty-one of them
  chosen to try to break the finding, return zero across 75,253 items and episodes. The
  substring trap was measured and eliminated, the sense collisions were read rather than
  counted, and the seventeen readable transcripts were read end to end rather than
  keyword-scanned. Widening the net further would produce more of §10b's stops, and
  widening the net until something fits is the mechanism #226 exists to stop.
- **It is not fixable by transcription.** §10's whole queue, if every hypothesis in it
  landed, would move six beats. Act I would still be eleven or twelve beats empty out of
  sixteen, and Act I is the education.
- **The failure is in the chain, not the fan.** Thirty of the forty-seven empty beats are
  chain beats. A Foray with seventeen missing family stops is a Foray with a short fan; a
  Foray with a missing derivation is a different product wearing this one's title.

**What can be built today, and it is worth saying because it is not nothing.** The spine's
§4c already anticipates this shape: *"The correct response to bad sourcing is narration on
the empty beats, or a shorter Foray with the beat count intact."* With sixteen authorable
segments and sixty-two narration beats, `alcohol-forms-1` is buildable **as a
narration-led programme with tape as illustration** — which is a real product and an honest
one, and the tape it has would land in the right places: the sequence of brewing, the
column still, the cask, the champagne bottle, the gin botanicals, the bitter barks, the
absinthe panic. What is not available is the thing the spine's §4c warns against
substituting: *"the short version is a substantively different product and should be
commissioned as one — not used as the fallback if sourcing goes badly."*

**So the decision this report exists to inform has three options and they should be named
as three.** Commission the narration-led version knowingly. Or spend the catalogue action
in §11 and re-run stage 2 against a pool that has wine, spirits and cider in it. Or shelve
`alcohol-forms-1` and put the sourcing effort somewhere it earns more — noting that
`grilling-history-coverage.md` §7 records *"Of the 24 empty beats in the original pass, 19
were in chains and 5 in the fan"*, and that this Foray's 30 chain empties out of 47 are the
same finding about the same catalogue, arrived at from a different subject.

**Whichever is chosen, the spine was worth writing first.** Beat 16 is the beat this Foray
exists to deliver and no tape in the catalogue could have supplied it. An outliner who had
read the catalogue before writing would have produced a spine about beer, absinthe and
bourbon with a chapter on prohibition, and it would have looked fully sourced.
