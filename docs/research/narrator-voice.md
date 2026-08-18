# Narrator voice — what the evidence supports

Part A.1 and A.3 of #247: what voice the narrator should have, whether there
should be more than one of them, what a listener actually notices, and which
provider to buy it from.

**Scope, so this does not collide with its siblings.** This document decides the
*voice*. `docs/curation/narration-craft.md` decides what the narrator *says* —
register, depth, segues, ratio. `docs/narrator-pipeline.md` decides how the audio
gets *made and served* — adapter, hosting, cost. Where a voice decision forces a
pipeline decision, this document states the constraint and stops; it does not
price anything.

**No paid API was called to produce this.** Nothing here was heard. Every claim
about how a voice sounds is either somebody else's documented claim or an
inference, and is labelled as such. The one thing this document does measure, it
measures on our own text.

## How to read the labels

The charter for this document asks for three kinds of statement kept apart,
because two agents had to retract claims this week for mixing them:

- **Measured** — a number this document produced by counting something we own.
  Reproducible from the repo with no network and no vendor.
- **Documented** — somebody else asserts it, with a URL. Their claim, their
  reliability. Vendor marketing is documented, not measured, even when it comes
  with numbers.
- **Judgement** — an inference or a recommendation. Load-bearing, but arguable,
  and flagged so it can be argued with.

A sentence with no label inherits the label of its heading. Anywhere the
distinction actually decides something, the label is inline.

---

## 1. The corpus did not answer the question it was built to answer

The research dossier put a TTS quality benchmark in the corpus specifically so
that a narrator-voice decision would not have to rest on vendor copy. It did not
survive the fetch.

**Documented, from our own corpus.** `docs/research/corpus/digests.md` § 37 on
TTS Arena V2 (`https://huggingface.co/spaces/TTS-AGI/TTS-Arena-V2`):
"Effectively nothing usable was captured, and a real-browser render doesn't fix
that here" — the Arena app runs in a cross-origin sandboxed iframe on a separate
`*.hf.space` origin, and the leaderboard requires an interactive click per
comparison before any model name or score appears at all. The digest is explicit
about what the entry is worth: "this entry is a pointer, not evidence about any
specific TTS system's quality." The captured extraction is roughly sixty
characters of Hugging Face's loading chrome.

So there is **no crowd-ranked quality evidence in this repo**, and any document
that cites source 37 as a leaderboard is citing a loading spinner. The corpus was
honest about this at ingest time; the failure is that the dossier's summary line
was not updated to match.

**The claim that has to be withdrawn.** `docs/research/foray-research-dossier.md`
§ 6 describes ElevenLabs as "best naturalness and prosody". Nothing in the corpus
supports that. Source 37 was the only entry that could have, and it is empty. It
should be read as an assumption the dossier carried in, not a finding — and it
happens to be the assumption that the founder's "I'll provide an ElevenLabs key"
also rests on. That does not make it wrong. It makes it untested, which is a
different thing, and §6 below says how to test it for nothing.

**A second dossier figure, which turns out to be right for a reason the corpus
cannot see.** § 6 gives ElevenLabs as "~$0.05-0.10 per 1K characters effective".
Recomputing from the pricing page actually captured in the corpus (source 40)
gives $0.165 to $0.20 per 1K characters — apparently a factor of two worse. The
discrepancy is real and it is not the dossier's error: **source 40 captured the
ElevenCreative subscription page, and ElevenLabs sells the API as a separate
product line at a separate price.** `https://elevenlabs.io/pricing/api` states
"$0.05" per 1K characters for Flash and Turbo and "$0.10" per 1K for Multilingual
v2 and v3 — exactly the dossier's range.

That is worth stating loudly because it points the other way from the usual
caution. The credit arithmetic on the Creative page — Creator at $22 for 121,000
credits is $0.182 per 1K, Pro at $99 for 600,000 is $0.165 per 1K, and
multilingual models bill one credit per character — makes the **subscription line
1.65 to 1.8× more expensive per character than the API line for the same model**.
Anyone costing narration off source 40 alone will over-state it by that much, and
anyone who buys the wrong product line will pay it. Which line to buy belongs to
`docs/narrator-pipeline.md`; the finding is recorded here because this is where it
surfaced.

This correction is also the honest example of why this document carries labels.
The paragraph above originally read "optimistic by roughly a factor of two" and
was committed to this branch that way. It was wrong: two documented sources
disagreed, and instead of resolving them the first draft picked the one already in
the corpus and called the other one careless. Resolving it took one fetch.

**What the corpus did answer**, and answered well: the three pricing pages
(sources 38, 39, 40), loudness normalisation practice (12, 36), and disclosure
prior art (14, NotebookLM's "experimental / may contain inaccuracies" framing).
Source 39 deserves one caution: it is a community forum thread whose opening line
is "I am not 100% sure on how pricing works", not OpenAI's pricing page. Treat
every OpenAI number downstream of it as unverified.

**One thing the pricing pages answer that they were not filed under.** Both
vendors publish character-to-duration conversions, which makes them accidental
evidence about default speaking rate — see § 3.1.

---

## 2. What the narrator actually has to read

Before asking what voice suits the copy, measure the copy. Both shipped spines
are in the repo, so this needs no vendor and no network.

**Measured.** Method: extract the `**Claim.**` paragraph from every `#### N.`
beat heading in `docs/curation/grilling-history-spine.md` and
`docs/curation/alcohol-forms-spine.md`, strip markdown emphasis, and count. The
claim paragraph is used because it is the closest thing in the repo to the
sentence a narrator will actually have to say about a beat — the surrounding
"Why it belongs" and "Evidence that counts" prose is written for a curator, not
for a listener.

| | barbecue | alcohol | both |
|---|---|---|---|
| beats with a claim | 40 | 63 | 103 |
| words of claim text | 2,731 | 5,696 | 8,427 |
| characters of claim text | 16,551 | 33,772 | 50,323 |
| words per beat (mean) | 68 | 90 | 82 |
| characters per beat (mean) | 414 | 536 | 489 |
| distinct proper-noun candidates | 59 | 96 | 155 * |
| proper-noun occurrences | 107 | 122 | 229 |
| rate | 1 per 25.5 words | 1 per 46.7 words | 1 per 36.8 words |

\* the sum of the two columns, not their union — fourteen or so terms
(`American`, `European`, `Japan`, `Andes`, `French` and similar) occur in both.

Proper-noun candidates are capitalised tokens in non-sentence-initial position,
excluding a small stop list (`I`, `A`, `The`, `And`, `But`, `It`, `This`, `That`,
`There`, `So`, `Act`, `Beat`). It is a proxy and it over-counts — `American`,
`Black` and `European` are adjectives and account for 37 of the 229 — but it
under-counts far more than it over-counts, because **the hard words in this
material are lowercase**.

**Measured, the number that matters.** A hand-audited lexicon of 81 terms a
general-purpose English voice has no reason to have learned was assembled by
reading a dump of every distinct token in the claim text. 80 of the 81 appear in
claim text, 103 times, and they are spread across **47 of the 103 beats — 46 %**.
That is not a tail risk confined to a few exotic beats. It is one in every two
beats.

The full list is in the appendix. The shape of it: Japanese and Korean and Chinese
fermentation vocabulary (`koji`, `nuruk`, `qu`, `huangjiu`, `makgeolli`, `shochu`,
`soju`, `baijiu`, `awamori`), Latin binomials (*Saccharomyces cerevisiae*,
*S. pastorianus*, *S. eubayanus*, *Aspergillus oryzae*, *Brettanomyces*,
*Artemisia*), physical chemistry (`azeotrope`, `acetaldehyde`, `diacetyl`,
`anethole`, `fructan`, `vanillin`), drinks and vessels from a dozen languages
(`aguamiel`, `arrack`, `arkhi`, `airag`, `qvevri`, `tinajas`, `pulque`,
`destilados`, `quinquinas`, `genever`, `akvavit`, `ouzo`, `raki`, `pastis`,
`sambuca`, `lambic`, `eisbock`, `keeving`, `jora`, `burukutu`, `pito`, `tella`,
`kumis`, `chicha`, `mezcal`, `barbacoa`, `asado`, `asador`, `braai`, `mangal`,
`döner`, `binchōtan`, `ch'arki`), and proper nouns whose pronunciation is not
guessable from spelling (`Taíno`, `Quechua`, `Aeneas Coffey`, `Bérard`,
`Cellier-Blumenthal`, `Commandaria`, `Bénédictine`, `Armagnac`, `Calvados`,
`Marsala`, `Meiji`).

**Measured.** 22 distinct tokens across the two spines carry a non-ASCII letter,
spanning nine languages' diacritics: `binchōtan`, `tōji`, `hāngī`, `Taíno`,
`piña`, `cachaça`, `taquería`, `Provençal`, `Édouard`, `Bérard`, `Baumé`, `rosé`,
`döner`, `entrepôt`, `consommé`, `armagnaçais`, `țuică`, `pálinka`, `żubrówka`,
`poitín`, `Bénédictine`, `à`. Every one is a place a text-normalisation step that
strips to ASCII, or a voice that treats `ō` as noise, will produce something
audibly wrong.

**Measured, and useful later.** The claim text runs 5.97 characters per word
including spaces. That is the conversion factor for every characters-per-minute
figure a vendor publishes, and § 3.1 uses it.

**Judgement.** Two conclusions follow, and they are the spine of everything
below. First, **pronunciation is not a polish item for this product, it is the
primary risk**, because the density is measured at one hard term per two beats
and the terms are exactly the kind a general-purpose model has never seen.
Second, the two spines have visibly different lexical characters — the barbecue
spine's difficulty is proper nouns at one per 25.5 words, the alcohol spine's is
technical vocabulary and Latin — which is the first real argument anyone has
offered for topic-specific voices. § 4 takes that argument seriously and then
rejects it.

---

## 3. Voice characteristics, one at a time

### 3.1 Pace — the one characteristic the corpus already priced

**Measured, from documented vendor figures.** Both pricing pages in the corpus
publish a character-to-duration conversion, which makes them accidental evidence
about default speaking rate.

ElevenLabs (source 40) lists included minutes against included credits at every
tier: ~10 min / 10k, ~30 / 30k, ~121 / 121k, ~600 / 600k, ~1,800 / 1.8M, ~6,000 /
6M. That is exactly **1,000 credits per minute at every tier**, and at the
multilingual rate of one credit per character, 1,000 characters per minute.
Amazon Polly (source 38) works the other way, converting 1,000,000 characters to
"~23 hours, 8 min" — 1,388 minutes, or **720 characters per minute**.

At the 5.97 characters per word measured on our own claim text in § 2:

| source | characters/min | implied words/min |
|---|---|---|
| ElevenLabs included-minutes table | 1,000 | 168 |
| Amazon Polly pricing example | 720 | 121 |

**Judgement.** Neither number is a measurement of a voice; both are billing-page
conveniences, and they disagree by 39 %. What they are good for is bounding the
question. Two useful things fall out.

The first is a planning constant. Because ElevenLabs bills per character and not
per minute, the conversion only matters when turning a runtime target into a
character budget — and for that purpose their own 1,000 characters per minute is
both the vendor's figure and the conservative one, so anyone costing narration
should use it and will not be surprised. That belongs to
`docs/narrator-pipeline.md`; it is stated here only because this is where the
number was derived.

The second is a warning, and it is not the obvious one. 168 words per minute is
*not* anomalously fast for spoken audio — `docs/curation/segment-length-rules.md`
§ 2a already establishes 170 wpm as this repo's working estimate for podcast
speech, having chased the folklore "150 wpm average conversation" back to a single
non-peer-reviewed page and rejected it. So ElevenLabs' implied default lands
almost exactly on the rate of the tape it will be spliced between.

**Judgement.** That coincidence is the problem, not a comfort. Two things argue
for deliberately setting the narrator *below* the tape rather than accepting a
default that matches it.

- **Register.** The narrator's job is to be recognisably not-a-guest. A voice
  arriving at the same rate as the surrounding tape has given up the cheapest
  available signal that the work has changed levels. Slower is the direction that
  reads as authored rather than as one more talker.
- **Density.** § 2 measures a proper noun every 37 words and a term the listener
  has never heard in 46 % of beats. Podcast speech at 170 wpm is conversational
  and redundant; our copy is neither. The same rate carries much more per second.

So **speaking rate is an explicit setting, not an accepted default** — the
documented `speed` range is 0.7–1.2, which means a deliberate slow read is
available and cheap. It also has to be a setting we can prove is applied, because
it is the one voice parameter whose absence is invisible in a script review and
obvious in the ear.

### 3.2 What a 2026 voice can actually be told to do

The useful way to ask "which characteristics can TTS deliver" is not to listen to
demos — we are not allowed to — but to read the control surface. A vendor exposes
knobs for what it can do and stays quiet about what it cannot.

**Documented**, from ElevenLabs' own API and prompting references:

| characteristic | control | documented range | documented catch |
|---|---|---|---|
| speaking rate | `speed` | 0.7–1.2, default 1.0 | "extreme values may affect the quality of the generated speech" |
| expressive range | `stability` | default 0.5 | "Lower values introduce broader emotional range"; "Higher values can result in a monotonous voice" |
| style intensity | `style` | default 0 | "style exaggeration of the voice"; numeric bounds not documented |
| pauses (v2 models) | `<break time="x.xs" />` | up to 3 s | "Using too many break tags in a single generation can cause instability" |
| delivery cues (v3) | inline `[whispers]`-style audio tags | open vocabulary | "The voice you choose and its training samples will affect tag effectiveness" |
| v3 expressiveness | three-mode `stability` — Creative / Natural / Robust | — | Creative is "prone to hallucinations"; Robust is "less responsive to directional prompts" |

**Judgement, and it is the important read of that table.** Pace is a real,
bounded, documented dial and nothing else in the list is. Everything else is a
*tendency* control with a documented failure mode on both sides: turn stability
down and you get range plus randomness, turn it up and the vendor's own word for
the result is "monotonous". There is no knob for warmth, none for breathiness,
none for authority, and no documented way to ask for a specific pitch. Those
characteristics are properties of the **voice you pick**, not settings you apply
afterwards — which makes voice selection the decision and parameter tuning the
afterthought, the opposite of how it is usually approached.

**Documented, and it constrains selection harder than anything else in this
document.** ElevenLabs' voices capability page states: "All our Default voices
will expire on December 31, 2026, and they will no longer be accessible after this
date", alongside "Our Default voices are being replaced with new voices that you
will be able to use in perpetuity."

**Judgement.** That is four months away and it disqualifies an entire class of
choice. A Foray back catalogue is an archive: beats get edited, claims get
corrected, and a corrected beat has to be re-voiced *in the same voice as the
other ninety-nine* or the repair is audible. Picking a voice that stops existing
on 31 December 2026 means every Foray narrated before that date becomes
un-repairable after it. **So the voice must be one documented as usable in
perpetuity — a replacement default or a Voice Library voice — and the identity of
the chosen voice must be pinned in the repo by ID, not by name**, because names
are display strings and this vendor has just demonstrated it will retire the
things they point at.

**Documented.** The Voice Library "contains over 10,000 voices shared by the
ElevenLabs community", is filterable by gender (Male / Female / Neutral), age
(Young / Middle Aged / Old), and use case — where "Narration" and "Educational"
are both first-class categories — and is "not available via the API to free tier
users". No official catalogue of named voices with per-voice descriptors is
currently documented; the pages that used to hold one return 404. So the selection
process is a library filter plus an ear, not a documented shortlist, and that ear
requires the key.

---

## 4. Several voices, mapped to topics — no, and the repo already measured why

The founder raised this and it deserves a real answer rather than a preference.
The honest surprise is that the strongest evidence on the question was already in
this repo, filed under a different problem.

### 4.1 The case for several voices, put properly

It is not a weak case.

- **§ 2 measured it.** The two spines have genuinely different lexical characters:
  barbecue is proper-noun dense at one per 25.5 words and its subject is labour,
  credit and race; alcohol is technical vocabulary and Latin binomials at one per
  46.7 words and its subject is process engineering. A voice that suits a
  paragraph about who was made to stay up all night tending a pit is not obviously
  the voice that suits parallel starch conversion in a koji mash.
- **Documented.** The Voice Library's own taxonomy treats "Narration" and
  "Educational" as *different* use-case categories, which is the vendor conceding
  that one voice does not cover both jobs.
- **A catalogue argument.** If Forays eventually span a hundred subjects, one
  voice for all of them is a house style, and house styles get stale. Radio
  networks run more than one presenter for exactly that reason.
- **A practical one.** Voices differ in how they handle hard words. A voice that
  says `baijiu` acceptably might mangle `Taíno`. Per-domain voices let each one be
  chosen against the vocabulary it will actually face.

### 4.2 The case against, which is measured rather than argued

`docs/curation/segment-length-rules.md` § 2a assembled the perceptual literature
on voice changes in order to set a cut budget. Every finding in it applies with
equal force to a narrator change, and two of them are decisive.

**Documented, and the repo grades it "solid".** Wang et al. 2019 (*Journal of
Cognition*) measured the cardiac orienting response to an instantaneous voice
change in radio content over a 6–10 s post-onset window and found it **did not
habituate across five repetitions** when listeners were doing something else. The
repo's own gloss: "Every cut pays full price. The listener does not get used to
it." Foray's listening context is driving and chores, which is the distracted
condition that finding was measured in.

**Documented, and directly measured.** Lin & Carlile 2015 (*Frontiers in
Neuroscience*) found the comprehension cost of a talker switch lands almost
entirely on **the single sentence after the switch** — recall on that sentence
falls from 71.6 % to 51.9 %.

**Judgement, and this is the argument.** Put those two next to what a narration
item is *for*. A bridged seam gets no silence at all — `player/seam-gap.js`
returns 0 for `bridged`, because "Narration is a better marker than silence". So
the narration item **is** the transition, and its first sentence is the highest
value sentence in it: it closes the last clip and orients the listener into the
next beat. Lin & Carlile says a talker switch costs you precisely that sentence.
Wang says the cost recurs every single time. Splitting the narrator by topic
therefore spends the repo's most expensive measured currency on its most valuable
sentence, repeatedly, and buys tonal fit — a benefit nobody has measured at all.

Three more things stack on top.

- **The narrator is the only relief the format offers.** A Foray is already a work
  made of strangers: Foray #1 makes 31 hard cuts between different people, rooms
  and mic chains. Every one of those is an orienting response the listener pays
  for. The narrator is the one voice that recurs, and its recurrence is the only
  thing converting a playlist into a work. A second narrator does not add variety
  to a monotonous programme — it removes the single constant from an already
  fragmented one.
- **Familiarity compounds, and only for one voice.** § 2a puts adaptation to an
  unfamiliar voice at 12–18 sentences. One narrator across the whole catalogue
  means a returning listener is *permanently* adapted and pays that cost once,
  ever. Four narrators means paying it four times and re-paying whenever a domain
  has not come up lately. This is the one benefit of consistency that grows with
  the size of the catalogue, which is exactly the axis on which the case for
  several voices was strongest.
- **The topic axis is the worst available axis.** § 2a's McLaughlin et al. 2023
  finding is that switch costs are *additive*. A topic-mapped narrator changes
  voice at exactly the moment the subject also changes — so the listener eats a
  talker switch and a topic switch simultaneously, when the entire purpose of
  narration at that seam was to make the topic change legible. Of every axis one
  could split a narrator on, subject domain is the one that guarantees the two
  costs coincide.

### 4.3 Where the multi-voice instinct is actually pointing

**Judgement.** The founder's instinct is not wrong, it is aimed at the wrong
layer. What differs between the barbecue spine and the alcohol spine is not the
voice that should read them — it is the *register* of what gets written: how much
is explained, how much authority the narrator claims, whether it is telling a
story about labour or walking through a mechanism. That is a scripting decision,
and one voice can deliver both registers because register lives in the words. It
belongs to `docs/curation/narration-craft.md`, not here.

**One voice. Across all topics, all Forays, and the whole catalogue.**

**The one place a second voice would be legitimate**, and it is not a topic split:
a *functional* split, where a distinct voice marks a distinct kind of utterance —
a disclosure that a beat has no tape behind it, or a correction. That is a
different speech act, not a different subject, and marking it with a different
voice is honest rather than decorative. Even then, do not build it yet: it is
worth exactly one voice-change's worth of orienting cost per occurrence, and the
first version of a narrator should establish that there is a narrator before it
starts qualifying who is talking.
