# Narrator voice — what the evidence supports

Part A.1 and A.3 of #247: what voice the narrator should have, whether there
should be more than one of them, what a listener actually notices, and which
provider to buy it from.

**Scope, so this does not collide with its siblings.** This document decides the
*voice*. `docs/curation/narration-craft.md` decides what the narrator *says* —
register, depth, segues, ratio. `docs/narrator-pipeline.md` decides how the audio
gets *made and served* — adapter, hosting, cost. Both are being written in
parallel with this one under the same charter and neither exists in the tree yet,
so every reference to them below is a deliberate hand-off, not a citation.

**No paid API was called to produce this.** Nothing here was heard. Every claim
about how a voice sounds is either somebody else's documented claim or an
inference, and is labelled as such. The one thing this document does measure, it
measures on our own text.

## How to read the labels

The charter for this document asks for three kinds of statement kept apart,
because two agents had to retract claims this week for mixing them:

- **Measured** — a number this document produced by counting something we own.
  Reproducible from the repo with no network and no vendor.
- **Documented** — somebody else asserts it, with a URL or a DOI. Their claim,
  their reliability. Vendor marketing is documented, not measured, even when it
  comes with numbers, and so is peer-reviewed literature: it is evidence, but it
  is not our measurement.
- **Judgement** — an inference or a recommendation. Load-bearing, but arguable,
  and flagged so it can be argued with.

A sentence with no label inherits the label of its heading. Anywhere the
distinction actually decides something, the label is inline.

**Two provenance notes, because they were nearly mistakes.** First, some corpus
sources are quoted here from their captured markdown in `data-local/corpus/`,
which is **gitignored** — a reader with only the repo can check
`docs/research/corpus/digests.md` but not the underlying capture. Those quotes are
marked *(capture, not committed)*. Second, roughly a third of the literature below
was retrieved by a delegated researcher rather than read here; where a finding
carries weight in the recommendation it was re-fetched and verified directly, and
where it was not, it says so.

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
specific TTS system's quality."

So there is **no crowd-ranked quality evidence in this repo.** The corpus was
honest about this at ingest time and the digest says exactly what the entry does
and does not establish; the gap is only that the dossier's one-line summary of
source 37 reads like a live leaderboard to anyone who does not open the digest.

**The claim that has to be withdrawn.** `docs/research/foray-research-dossier.md`
§ 6 describes ElevenLabs as "best naturalness and prosody". Nothing in the corpus
supports that. Source 37 was the only entry that could have, and it is empty. It
should be read as an assumption the dossier carried in, not a finding — and it
happens to be the assumption that the founder's "I'll provide an ElevenLabs key"
also rests on. That does not make it wrong. It makes it untested, and § 6 both
tests it and finds against it.

**A second dossier figure, which turns out to be right for a reason the corpus
cannot see.** § 6 gives ElevenLabs as "~$0.05-0.10 per 1K characters effective".
Recomputing from the pricing page captured as source 40 gives $0.165 to $0.20 per
1K characters — apparently a factor of two worse. The discrepancy is real and it is
not the dossier's error: **source 40 captured `elevenlabs.io/pricing`, the
subscription/credit page, and ElevenLabs sells API access as a separate product
line at a separate price.** `https://elevenlabs.io/pricing/api` states "$0.05" per
1K characters for Flash and Turbo and "$0.10" per 1K for Multilingual v2 and v3 —
exactly the dossier's range.

The credit arithmetic on the subscription page — Starter at $6 for 30,000 credits
is $0.20 per 1K, Creator at $22 for 121,000 is $0.182, Pro at $99 for 600,000 is
$0.165, and multilingual models bill one credit per character — makes the
**subscription line 1.65 to 2.0× more expensive per character than the API line
for the same model.** Anyone costing narration off source 40 alone will over-state
it by that much, and anyone who buys the wrong product line will pay it. Which
line to buy belongs to `docs/narrator-pipeline.md`; the finding is recorded here
because this is where it surfaced.

In fairness to the dossier, its own Caveats section already flagged this class of
error — "several TTS price points (Azure, ElevenLabs, Gemini) were sourced partly
from third-party trackers and should be verified against official vendor pricing
pages" — so this is the verification it asked for, and it vindicated the number.

This correction is also the honest example of why this document carries labels.
The paragraph above originally read "optimistic by roughly a factor of two" and
was committed to this branch that way. It was wrong: two documented sources
disagreed, and instead of resolving them the first draft picked the one already in
the corpus and called the other one careless. Resolving it took one fetch.

**What the corpus did answer**, and answered well: pricing (sources 38 and 40),
loudness normalisation practice (12, 36), and disclosure prior art (14,
NotebookLM's "experimental / may contain inaccuracies" framing). Source 39 is the
weak one — it is a community forum thread, not OpenAI's pricing page, and its
opening contributor writes "I am not 100% sure on how pricing works" *(capture, not
committed)*. Treat every OpenAI number downstream of it as unverified.

**And the corpus answered one question it was not filed under, before this
document got there.** Digest 38 already records the conversion this document leans
on in § 3.1: "1 million characters is approximately 23 hours 8 minutes of speech --
so roughly 720 characters per minute of audio." That is the corpus's finding, not
this document's; § 3.1 adds only the ElevenLabs side and the words-per-minute
conversion.

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

\* the sum of the two columns, not their union — `American`, `European`, `Japan`,
`Andes`, `French` and a handful of others occur in both.

Proper-noun candidates are capitalised tokens in non-sentence-initial position,
excluding a small stop list (`I`, `A`, `The`, `And`, `But`, `It`, `This`, `That`,
`There`, `So`, `Act`, `Beat`). It is a proxy and it over-counts — `American`,
`Black` and `European` are adjectives and account for 37 of the 229 — but it
under-counts far more than it over-counts, because **the hard words in this
material are lowercase**.

**Measured, the number that matters.** A hand-audited lexicon of 81 entries a
general-purpose English voice has no reason to have learned was assembled by
reading a dump of every distinct token in the claim text. 80 of the 81 appear in
claim text, 103 times, spread across **47 of the 103 beats — 46 %.**

Three ways to read that, all of them true and only one of them alarming in the
right way:

- **~1.0 hard term per beat** on average across the whole work.
- **2.2 hard terms per affected beat**, because they cluster.
- **46 % of beats affected** — not "one beat in two", which is the rounding this
  document used in an earlier draft and which understates the clustering.

The list is in the appendix, and the appendix is honest that 81 entries is nearer
**76 distinct words** once `fructan`/`fructans`, the two spellings of
`binchōtan`, and the bare species epithets of three binomials are folded together.
The shape of it: East Asian fermentation vocabulary (`koji`, `nuruk`, `huangjiu`,
`makgeolli`, `shochu`, `soju`, `baijiu`, `awamori`), Latin binomials
(*Saccharomyces cerevisiae*, *S. pastorianus*, *S. eubayanus*, *Aspergillus
oryzae*, *Brettanomyces*, *Artemisia*), physical chemistry (`azeotrope`,
`acetaldehyde`, `diacetyl`, `anethole`, `fructan`, `vanillin`), drinks and vessels
from a dozen languages (`aguamiel`, `arrack`, `arkhi`, `airag`, `qvevri`,
`tinajas`, `pulque`, `destilados`, `quinquinas`, `genever`, `akvavit`, `ouzo`,
`raki`, `pastis`, `sambuca`, `lambic`, `eisbock`, `keeving`, `jora`, `burukutu`,
`pito`, `tella`, `kumis`, `chicha`, `mezcal`, `barbacoa`, `asado`, `asador`,
`braai`, `mangal`, `döner`, `binchōtan`), and proper nouns whose pronunciation is
not guessable from spelling (`Taíno`, `Quechua`, `Aeneas Coffey`, `Bérard`,
`Cellier-Blumenthal`, `Commandaria`, `Bénédictine`, `Armagnac`, `Calvados`,
`Marsala`, `Meiji`).

**Measured, with the population stated precisely because an earlier draft got it
wrong.** Across the two spine documents *in full*, 22 distinct tokens carry a
non-ASCII letter, spanning nine languages' diacritics: `binchōtan`, `tōji`,
`hāngī`, `Taíno`, `piña`, `cachaça`, `taquería`, `Provençal`, `Édouard`, `Bérard`,
`Baumé`, `rosé`, `döner`, `entrepôt`, `consommé`, `armagnaçais`, `țuică`,
`pálinka`, `żubrówka`, `poitín`, `Bénédictine`, `à`. **In claim text — the only
population the narrator will read — just 7 of those 22 occur:** `binchōtan`,
`Taíno`, `Édouard`, `rosé`, `döner`, `entrepôt`, `Bénédictine`. The larger number
is a fact about the documents; the smaller one is the fact about the narrator, and
mixing them was exactly the population error this document criticises elsewhere.
Either way, each is a place an ASCII-normalising step will produce something
audibly wrong.

**Measured, and useful later.** The claim text runs 5.97 characters per word
including spaces. That is the conversion factor for every characters-per-minute
figure a vendor publishes, and § 3.1 uses it.

**Judgement.** Two conclusions follow, and they are the spine of everything
below. First, **pronunciation is not a polish item for this product, it is the
primary risk** — a hard term per beat, clustered, and of exactly the kind a
general-purpose model has never seen. Second, the two spines have visibly
different lexical characters — barbecue's difficulty is proper nouns at one per
25.5 words, alcohol's is technical vocabulary and Latin — which is the first real
argument anyone has offered for topic-specific voices. § 4 takes that argument
seriously and then rejects it, on narrower grounds than an earlier draft claimed.

---

## 3. Voice characteristics, one at a time

### 3.1 Pace, and the finding that beats every pace target

**Measured, from documented vendor figures.** Both pricing pages publish a
character-to-duration conversion. ElevenLabs' subscription page lists included
minutes against included credits at every tier — ~10 min / 10k credits, ~30 / 30k,
~121 / 121k, ~600 / 600k, ~1,800 / 1.8M, ~6,000 / 6M *(capture, not committed;
the digest carries the credit ladder but not the minutes column)* — which is
1,000 credits per minute at every tier, and at the multilingual rate of one credit
per character, 1,000 characters per minute. Digest 38 gives Polly at 720
characters per minute. At the 5.97 characters per word measured in § 2:

| source | characters/min | implied words/min |
|---|---|---|
| ElevenLabs included-minutes table | 1,000 | 168 |
| Amazon Polly pricing example | 720 | 121 |

Neither is a measurement of a voice; both are billing-page conveniences that
disagree by 39 %. What they are good for is one planning constant — because
ElevenLabs bills per character, the conversion only matters when turning a runtime
target into a character budget, and their own 1,000 characters per minute is both
the vendor's figure and the conservative one. That belongs to
`docs/narrator-pipeline.md`.

**Documented, and it reframes the whole question.** Human speech production sits
at about 150 wpm and comprehension does not break down until far above it. Murphy,
Hoover & Castel (2023), *Memory* 31(6), `https://pmc.ncbi.nlm.nih.gov/articles/PMC10330257/`:
"Humans generally speak at a rate of 150 words per minute (Peelle & Davis, 2012)"
and "speech comprehension begins to decline at around 275 words per minute (see
Foulke & Sticht, 1969)". The 1969 original is paywalled and was not read; the
275 figure is quoted from a peer-reviewed paper citing it.

Playback-speed studies converge on the same tolerance. Murphy, Hoover,
Agadzhanyan, Kuehn & Castel (2022), *Applied Cognitive Psychology* 36, DOI
`10.1002/acp.3899`: "minimal costs incurred by increasing video speed from 1x to
1.5x, or 2x speed, but performance declined beyond 2x speed" — with the authors'
own limitation, which is the direct answer to our density question: "these trends
may differ for videos with different speech rates, complexity or difficulty, and
audiovisual overlap."

**Judgement.** So the repo's ~170 wpm estimate for podcast speech, and
ElevenLabs' implied 168, are nowhere near a comprehension ceiling. **The case for
slowing the narrator down is not that 168 wpm is too fast to understand.** It is
narrower and it is about register: a narrator arriving at exactly the rate of the
tape it is spliced between has given up the cheapest signal that the work has
changed levels. 150 wpm is the documented human production rate and a defensible
target for that reason. The widely repeated "155 wpm / 9,300 words per finished
hour is the Audible standard" is **practitioner convention, secondhand** — traced
to a working narrator's blog (`https://karencommins.com/2011/06/some_simple_math_about_audiobo.html`),
with no ACX, Audible or Audio Publishers Association document stating any
words-per-minute figure. Do not cite it as a platform standard.

**Documented, and this is the strongest actionable finding in the entire
review.** O'Leary, Neukam, Hansen, Kinney, Capach, Svirsky & Wingfield (2023),
*Trends in Hearing*, DOI `10.1177/23312165231203514`,
`https://pmc.ncbi.nlm.nih.gov/articles/PMC10637151/`. Narratives recorded at "an
average speech rate of 173.4 words per minute" were compressed to "60% of their
original playing time, equivalent to a mean speech rate of 288.71 wpm", then had
silences "inserted into the narratives at clause and sentence boundaries", with
"the durations of the silent periods added at sentence boundaries ... set at twice
the duration of the silent periods added at clause boundaries". The result:
"time-restoration (TR) raised the level of recall accuracy for otherwise
time-compressed speech 95% of the way back to baseline", and pupillometry showed
"the effortful demand on resources reduced with time restoration".

**Judgement, and it changes the recommendation.** The recoverable variable is
**processing time at syntactic boundaries, not articulation rate** — and the
concrete spec is sentence-boundary pauses at roughly twice clause-boundary pauses.
That is more defensible than any words-per-minute target, and for copy carrying a
hard term per beat it is the intervention most likely to matter. Caveat honestly:
Experiment 1 was 27 normal-hearing young adults, the manipulation was
*restoration* of time removed by compression rather than addition to normal
speech, and nothing here tested a synthetic voice.

**And the catch, which § 3.2 makes concrete.** ElevenLabs' only documented pause
control is a v2-model feature. The model this document ends up recommending does
not have it.

### 3.2 What a 2026 voice can actually be told to do

The useful way to ask "which characteristics can TTS deliver" is not to listen to
demos — we are not allowed to — but to read the control surface. A vendor exposes
knobs for what it can do and stays quiet about what it cannot.

**Documented.** Sources are ElevenLabs' API reference
(`https://elevenlabs.io/docs/api-reference/text-to-speech/convert`), its controls
guide (`https://elevenlabs.io/docs/best-practices/prompting/controls`) and its v3
prompting guide (`https://elevenlabs.io/docs/best-practices/prompting/eleven-v3`).
The `speed` range, the v3 stability modes, the IPA-consistency figure and the
audio-tag caveat below were each re-fetched and verified directly for this
document.

| characteristic | control | documented range | documented catch |
|---|---|---|---|
| speaking rate | `speed` | "to a minimum of 0.7 ... to a maximum of 1.2", default 1.0 | "Extreme values may affect the quality of the generated speech." |
| expressive range (v2) | `stability` | default 0.5 | "Lower values introduce broader emotional range"; "Higher values can result in a monotonous voice" |
| style intensity | `style` | default 0 | "style exaggeration of the voice"; numeric bounds not documented |
| pauses | `<break time="x.xs" />` | up to 3 s, **v2 models only** | "Using too many break tags in a single generation can cause instability. The AI might speed up, or introduce additional noises or audio artifacts." |
| delivery cues (v3) | inline `[whispers]`-style audio tags | open vocabulary | "The voice you choose and its training samples will affect tag effectiveness. Some tags work well with certain voices while others may not." |
| expressive range (v3) | three-mode `stability` | Creative / Natural / Robust | Creative: "More emotional and expressive, but prone to hallucinations." Natural: "Closest to the original voice recording—balanced and neutral." Robust: "Highly stable, but less responsive to directional prompts but consistent, similar to v2." |

**Judgement, and it is the important read of that table.** Pace is a real,
bounded, documented dial and nothing else in the list is. Everything else is a
*tendency* control with a documented failure mode on both sides: turn stability
down and you get range plus randomness, turn it up and the vendor's own word for
the result is "monotonous". There is no knob for warmth, none for breathiness, and
no documented way to ask for a specific pitch. Those are properties of the **voice
you pick**, not settings you apply afterwards — which makes selection the decision
and parameter tuning the afterthought.

**Two gaps in that table that the recommendation has to live with.** The pause
control is documented for v2 models and § 5.1 eliminates the v2 line, so the model
this document recommends has **no documented pause mechanism** — the v3 guide
directs authors to punctuation and ellipses instead, which is a scripting lever
rather than a numeric one. Given § 3.1, that is the single most awkward
consequence of the model choice, and it is why boundary-pause control passes to
`docs/curation/narration-craft.md` as a *writing* constraint. Separately, `speed`
is documented on the general controls page without a per-model support matrix; that
it applies to v3 is an assumption, and a cheap one to check on the first call.

**Documented, and it constrains selection harder than anything else here.**
ElevenLabs' voices capability page
(`https://elevenlabs.io/docs/overview/capabilities/voices.md`, verified directly):
"All our Default voices will expire on December 31, 2026, and they will no longer
be accessible after this date", alongside "Our Default voices are being replaced
with new voices that you will be able to use in perpetuity."

**Judgement.** That is four months away and it disqualifies an entire class of
choice. A Foray back catalogue is an archive: beats get edited, claims get
corrected, and a corrected beat has to be re-voiced *in the same voice as the
other ninety-nine* or the repair is audible. **So the voice must be one documented
as usable in perpetuity, and its identity must be pinned in the repo by ID, not by
name** — names are display strings, and this vendor has just demonstrated it will
retire the things they point at.

**Documented.** The Voice Library "contains over 10,000 voices shared by the
ElevenLabs community", is filterable by gender (Male / Female / Neutral), age
(Young / Middle Aged / Old) and use case — where "Narration" and "Educational" are
both first-class categories — and is "not available via the API to free tier
users". No official catalogue of named voices with per-voice descriptors is
currently documented; the pages that used to hold one return 404. So selection is a
library filter plus an ear, and that ear requires the key.

### 3.3 Pitch, accent, age, gender — where the evidence says to stop trying

This is the part of the charter's question 1 that the literature answers most
clearly, and the answer is deflationary.

**Documented, and directly on point because the stimuli were synthetic.**
Shiramizu, Lee et al. (2022), *Scientific Reports*, DOI
`10.1038/s41598-022-27124-8`, `https://pmc.ncbi.nlm.nih.gov/articles/PMC9797498/`,
manipulated pitch in 46 synthetic voices. Verified directly: lowered pitch was
judged "significantly more dominant" (p = 0.002) and more aggressive (p = 0.037),
but there was "no significant effect of pitch manipulation" on **trustworthiness
(p = 0.298) or competence (p = 0.732)**.

**Judgement.** For a synthetic narrator, then, the pitch lever buys dominance —
which is not what an educational narrator wants — and does not buy the two things
it does want. The human-voice literature on low pitch and leadership (Klofstad,
Anderson & Peters 2012, *Proc R Soc B*, DOI `10.1098/rspb.2012.0311`) points the
same way on trust: it reports listeners preferring lower-pitched leaders while
finding that "neither men nor women found the lower- or higher-pitched male voices
to be more trustworthy". **Do not specify a pitch.**

**Documented, on accent.** The retrievable literature is framed as standard versus
non-standard varieties, not as British versus American. Spence, Hornsey,
Stephenson & Imuta (2022), *PSPB*, DOI `10.1177/01461672221130595`, meta-analyses
"139 effect sizes (N = 4,576)" and finds "Standard-accented candidates were
considered more hireable than non-standard-accented candidates (d = 0.47) — a bias
that was stronger for high communication jobs", with comprehensibility *not* a
significant moderator. Not verified directly here; abstract retrieved via Crossref.

**And a folklore claim to kill.** Two independent retrieval passes found **no
peer-reviewed evidence that American listeners rate British-accented speakers as
more authoritative, intelligent or credible for educational content.** The
standard-versus-non-standard framing predicts the opposite for a US audience,
since the in-group standard is General American. If the narrator gets a British
accent, it should be because somebody liked it, and the document should say so
rather than dress it as evidence.

**Documented, on age and gender: mostly absent.** No evidence was found for a
perceived-age-of-voice effect on credibility. On gender, the one retrieved study
in an instructional setting reports a null — Schrader, Seufert & Zander (2021),
*Frontiers in Psychology* 12, DOI `10.3389/fpsyg.2021.655720`, "speaker gender and
speaker–learner gender similarity had no impact on learning gains, situational
interest, and cognitive load types" — at N = 95, which is underpowered for a null
and was not verified directly. **A recommendation of "male for authority" would be
unsupported by anything retrievable.**

**Documented, on voice quality as distinct from voice identity, and this is the
one to act on.** Walter-Terrill, Ongchoco & Scholl (2025), *PNAS*, DOI
`10.1073/pnas.2415254122`, `https://pmc.ncbi.nlm.nih.gov/articles/PMC12002274/`,
verified directly. Clear versus tinny audio, with transcription accuracy held
constant, moved higher-level social judgements — and the synthetic-voice conditions
showed the largest effects: credibility 66.90 → 63.46 (d = 0.16), intelligence
73.01 → 69.70 (d = 0.20), and hireability for a computer-synthesised male voice
69.30 → 59.57, t(1198) = 7.38, **d = 0.43**. Comprehension was unaffected
(99.50 % vs 99.00 % transcription accuracy); the judgement moved anyway. A
converging result: Schiller, Aspöck & Schlittmeier (2023), *Frontiers in
Psychology*, DOI `10.3389/fpsyg.2023.1243249`, found a hoarse voice left recall
statistically unchanged while raising annoyance (d = 1.34) and perceived listening
effort (d = 0.62). Neither was verified beyond the PNAS fetch.

**Judgement, and it reorders the whole characteristic question.** Encoding
quality, level and delivery move perceived credibility by effect sizes comparable
to or larger than anything pitch, accent, age or gender buys for a synthetic
voice — and unlike those, they are entirely under our control. **Spend the
attention there.** The corollary for § 7 is uncomfortable but honest: the third
characteristic in any voice specification should be a short list of things *not* to
optimise.

---

## 4. Several voices, mapped to topics — no, but on narrower grounds than it first appeared

The founder raised this and it deserves a real answer. An earlier draft of this
section claimed the answer was already measured in this repo. **That claim was
wrong twice over and is withdrawn**: the evidence is third-party literature rather
than our measurement, and the argument built on it mis-modelled when a
topic-mapped voice would actually change.

### 4.1 The case for several voices, put properly

It is not a weak case.

- **§ 2 measured it.** The two spines have genuinely different lexical characters:
  barbecue is proper-noun dense at one per 25.5 words and its subject is labour,
  credit and race; alcohol is technical vocabulary and Latin binomials and its
  subject is process engineering.
- **Documented.** The Voice Library's own taxonomy treats "Narration" and
  "Educational" as *different* use-case categories, which is the vendor conceding
  that one voice does not cover both jobs.
- **Documented, and it cuts for multiplicity in an educational context.** The
  high-variability training literature finds that "stimuli produced by multiple
  talkers ... often result in better retention of the learned information"
  (Fuhrmeister & Myers 2020, *Atten Percept Psychophys* 82, PMID 31970707) —
  though the same paper concludes "variability may come at a cost in phonetic
  learning", and other studies in that line report the predicted benefit failing
  to appear. Not verified directly.
- **Documented, and it is the strongest principled objection to one voice.** A
  single authoritative narrator concentrates epistemic authority, and the one
  open-access source using "voice of God" about educational film uses it as a
  criticism: "the male 'voice of God' narration often pronounces meaning that is
  inaccurate or disrespectful" (Dollman, Sorrell & Jenkins 2021, *KULA* 5(1), DOI
  `10.18357/kula.133`). For the barbecue spine in particular — whose subject is
  who did the work and who got the credit — a single unplaced voice narrating
  other people's history is a real editorial concern, not a technical one.
- **A practical one.** Voices differ in how they handle hard words. Per-domain
  voices let each be chosen against the vocabulary it will face.

### 4.2 The case against, stated at the strength the evidence actually supports

**First, the mis-modelling that has to be corrected.** Each spine is one Foray.
So a voice mapped to *subject domain* changes at **Foray boundaries** — between
works, not inside one. The within-work switch cost that an earlier draft made
central would simply not occur. It only occurs if the mapping is finer than a
Foray: per act, or per beat, in a work like the alcohol spine that spans
microbiology, chemistry, history and geography. **That distinction decides which
evidence is even relevant, and the answer differs by granularity:**

- **Finer than a Foray (per act or per beat): reject firmly.** Here the switch
  lands inside a work, and § 4.3's costs apply.
- **Per Foray: reject, but on continuity-of-catalogue grounds only**, which is a
  weaker and more contestable argument.

**Second, the literature is weaker than it is usually reported.** The
talker-variability tradition (Mullennix, Pisoni & Martin 1989, *JASA* 85, DOI
`10.1121/1.397688`; Martin et al. 1989, *JEP:LMC* 15, DOI
`10.1037/0278-7393.15.4.676`) is about **isolated words and short lists with the
voice changing trial to trial**. Three things undercut extrapolating it to a
narrator changing between chapters:

- **A pre-registered replication failed.** Luthra, Saltzman, Myers & Magnuson
  (2021), *Atten Percept Psychophys* 83, DOI `10.3758/s13414-021-02317-x`: "In
  contrast to the previous study, we did not observe multitalker processing costs
  in either of our groups ... Our data suggest that the previous findings of
  Magnuson and Nusbaum (2007) be regarded with skepticism." Note
  `docs/curation/segment-length-rules.md` § 2a independently flagged this same
  failed replication and told readers not to build on it.
- **The effect reverses when encoding time is ample.** Goldinger, Pisoni & Logan
  (1991), *JEP:LMC* 17(1), PMID 1826729, report a strong interaction with
  presentation rate: "At slow presentation rates, words in early serial positions
  produced by multiple talkers were actually recalled more accurately than words
  produced by a single talker." A narrated work at 150 wpm is far closer to the
  ample-encoding regime than to the rapid word-list regime where the penalty
  appears. Not verified directly.
- **There is no evidence at our scale at all.** Targeted searches for
  talker-change effects on continuous discourse comprehension returned nothing.
  **No study establishes that switching narrators at chapter or work boundaries
  costs comprehension or memory.** Extrapolating millisecond-scale normalisation
  costs to a once-per-Foray handoff is not licensed by the literature, and this
  document will not do it.

### 4.3 What actually survives, and it is enough

**Documented, and it is the one repo-grade finding that transfers.** Wang et al.
2019 (*Journal of Cognition*), via `segment-length-rules.md` § 2a, measured the
cardiac orienting response to an instantaneous voice change in radio content over
a 6–10 s window and found it **did not habituate across five repetitions** when
listeners were doing something else. The repo's gloss: "Every cut pays full price.
The listener does not get used to it." Foray's listening context is driving and
chores — and the Audio Publishers Association's own consumer survey reports
multitasking as the dominant reason people listen, which is that same distracted
condition.

**Judgement, and it must price the first narrator as well as the second.** An
honest version of this argument admits that inserting a narrator at a bridged seam
creates *two* voice changes where there was one hard cut — guest, narrator, guest.
The narrator is not free. What buys it is that `player/seam-gap.js` returns 0 for
`bridged` because "Narration is a better marker than silence": the narration is
doing orientation work that the alternative, 2.0 s of silence, does less well. So
the first narrator earns its switches by explaining the edit. **A second narrator,
mapped to subject, explains nothing** — it adds switches without adding
orientation.

**Documented, on the mechanism that favours one voice.** Nygaard, Sommers & Pisoni
(1994), *Psychological Science* 5(1), PMID 21526138: "the ability to identify a
talker's voice improved intelligibility of novel words produced by that talker ...
perceptual learning of aspects of the vocal source facilitates the subsequent
phonetic analysis of the acoustic signal." Caveat plainly: training was nine days
and explicit, tested on noise-masked items. Not verified directly. It is
mechanistically suggestive for a long single-voice catalogue, not a measured effect
at our scale — but it is the right shape of argument, and it is the one that
compounds with catalogue size.

**Documented, on industry convention, which is unanimous and unargued.**

- Netflix's Audio Description Style Guide v2.1: "The same voice talent should be
  used across all episodes and seasons of a series, as well as movie sequels when
  possible", with the exception carved out for anthology — genuinely discontinuous
  — content. It also asks that "The narrator's voice must be distinguishable from
  other voices in the content, but it should not be distracting or
  over-animated", which is unusually apt for a work assembled from other people's
  tape. Label it precisely: this governs accessibility audio description, asserts
  the rule without argument, and is not documentary practice.
- The Audio Publishers Association's Audies categories separate three solo
  narration awards from a single "Ensemble Performance" category "for excellence
  in a title which includes multiple narrators" — convention, with no selection
  criteria offered.
- **Every documented industry reason for multiple narrators is about character,
  not comprehension.** ACX's own guidance on dual and duet narration frames it
  around point of view and intimacy in romance fiction — "it's not just about what's
  being said—it's about who is saying it, and how". An expository educational work
  has no points of view to differentiate, so the industry's own trigger condition
  is absent.

None of the above was verified directly beyond the retrieval report.

### 4.4 The decision, and where the multi-voice instinct is actually pointing

**One voice. Across all topics, all Forays, and the whole catalogue.** The honest
basis is: no evidence supports splitting, the convention is unanimous against it,
the familiarity mechanism compounds in its favour, and a second narrator adds
orienting costs without adding orientation. That is a weaker case than "the repo
measured it", and it is the true one.

**Judgement.** The founder's instinct is not wrong, it is aimed at the wrong
layer. What differs between the two spines is not the voice that should read them
but the *register* of what gets written — how much is explained, how much authority
the narrator claims, whether it is telling a story about labour or walking through
a mechanism. Register lives in the words, one voice can deliver both, and it
belongs to `docs/curation/narration-craft.md`.

**Two legitimate exceptions, neither of them topic-mapped.** A *functional* second
voice marking a distinct speech act — a disclosure that a beat has no tape behind
it, or a correction — is honest rather than decorative, and worth one voice-change's
cost per occurrence. And § 4.1's voice-of-God objection deserves an answer in
craft: a narrator that attributes rather than pronounces. Neither should be built
first; establish that there is a narrator before qualifying who is talking.

---

## 5. What breaks the illusion first

**Read the whole of this section as Judgement about ranking.** Two independent
retrieval passes found **no study asking listeners what cues them that long-form
narration is synthetic**, and none measuring quality decay against passage
duration. The engineering literature diagnoses system limitations; nobody has
measured listener detection. So the ordering below is a hypothesis grounded in
measured density on our own copy plus documented system limitations — not a finding.

**One documented result governs all five, and it is the reason this ranking
matters more for us than for a general product.** Ralston, Pisoni, Lively, Greene
& Mullennix (1991), *Human Factors* 33(4),
`https://pmc.ncbi.nlm.nih.gov/articles/PMC3518837/`: "the increase observed in
monitoring latency for difficult texts was larger for synthetic speech than for
natural speech." **The synthetic penalty scales with text difficulty**, and § 2
measured our text as difficult. Caveat that this is 1991 formant synthesis, not
neural TTS — the classic Pisoni-lab work concerns DECtalk-era systems, and § 6.1
covers what modern evaluation says about whether the penalty persists.

### 5.1 First: mispronounced proper nouns and loanwords

**Measured.** ~1.0 hard term per beat, 2.2 per affected beat, 46 % of beats
affected, 7 diacritic-bearing tokens in claim text.

**Documented, and the mechanism is worse than it looks.** ElevenLabs supports
pronunciation dictionaries in IPA and CMU Arpabet, uploaded as `.PLS` files and
attached per request via `pronunciation_dictionary_locators`, "up to 3 locators per
request". But from
`https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries`
(verified directly): "Pronunciation dictionary phoneme tags only work with
eleven_flash_v2 and eleven_v3 models", and on every other model "Other models skip
dictionary phoneme tags and use the default pronunciation." **The failure is
silent** — no error, just the wrong word. That eliminates `eleven_multilingual_v2`
no matter what else recommends it, and `eleven_multilingual_v2` is the model
ElevenLabs' own model page calls "Most stable on long-form generations".

**Documented, and it is a contradiction, not a fact.** A different official page,
`https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices`,
states that phoneme tags are "only compatible with the `eleven_flash_v2` model" —
**v3 excluded.** Two ElevenLabs pages disagree about whether the model this
document recommends honours dictionary phoneme tags. Both were reported by
independent retrieval passes. The only model all pages agree on is
`eleven_flash_v2`, which is documented English-only. **This contradiction is the
largest single risk to § 7's recommendation and it is cheap to resolve with one
dictionary call once a key exists.**

A second constraint points the same way: "If you want to use IPA and CMU
pronunciations in languages other than English, you will have to switch to the
eleven_v3 model." Our copy is English prose containing Japanese, Korean, Chinese,
Quechua, Georgian, Nahuatl and Māori words; whether the dictionary treats those as
"languages other than English" is not documented, and the safe reading is that it
does.

**Documented, verified directly, and the number people will quote.** From the v3
prompting guide: "V3's IPA support achieves 80-90% pronunciation consistency. While
significantly more reliable than v2's XML phoneme tags, it is not 100%
consistent."

**Judgement — and an earlier draft over-claimed here, so the caveats come first.**
Multiplying 103 occurrences by a 10–20 % failure rate gives an order of magnitude
of **roughly ten to twenty audible mispronunciations across the two Forays even
with a complete dictionary**. Treat that as an illustration, not a measurement,
for three reasons: the input is a vendor's assertion about *consistency*, which is
not the same quantity as per-token accuracy; independence across occurrences is
assumed and unjustified; and § 5.4 expects narration to be longer than the claim
text the 103 was counted on, so the true occurrence count is higher. The defensible
version of the point survives all three caveats: **pronunciation is not a problem
this stack solves, only one it reduces, and the residue has to be caught by
listening.**

**Documented, on why nobody can give us a better number.** The published
literature has no absolute proper-noun mispronunciation rate for neural TTS.
Apple's own work states the problem and reports only relative gains: "Despite great
progress in speech synthesis, the pronunciation accuracy of named entities in a
multi-lingual setting still has a large room for improvement" (Anantha et al. 2023,
`https://arxiv.org/abs/2303.00171`), improving accuracy "by ~6% compared to strong
phoneme-based and audio-based baselines". And the Blizzard Challenge organisers
found that "the evaluation of language-specific phenomena, such as the
pronunciation of homographs, better highlighted system limits compared to global
transcription tasks" (Perrotin et al. 2024, DOI `10.1016/j.csl.2024.101747`) —
i.e. **you only see pronunciation failures if you test for them specifically.**
That is the strongest external endorsement of § 5.7 available: measure it on our
own manuscript, because the number does not exist anywhere else.

### 5.2 Second: wrong emphasis, because nothing controls it

**Measured.** The claim text contains 62 contrastive constructions — `rather
than` (40), `is/are/was not` (13), `not just`/`not only` (2), `instead of` (1),
`the real`/`the actual`/`the whole` (6) — one per 136 words, in **50 % of beats**.
Separately, the authors marked emphasis by hand 53 times using single-asterisk
italics, in 33 beats.

**Documented, and it is measured by somebody, unlike most of this section.**
Turetzky, Dekel, Aronowitz, Hoory & Adi (2026), "Knowing What to Stress: A
Discourse-Conditioned Text-to-Speech Benchmark", `https://arxiv.org/abs/2604.10580`:
"we find a consistent gap: text-only language models reliably recover the intended
stress from context, yet TTS systems frequently fail to realize it in speech."
arXiv preprint, not peer-reviewed, not verified directly. Converging, and about
where errors land: Gutierrez, Oplustil-Gallegos & Lai,
`https://arxiv.org/abs/2107.02527`, found that on audiobook material "error marks
consistently cluster around words at major prosodic boundaries indicated by
punctuation", and that when information structure was controlled, "differences
emerge in the ability of neural TTS systems to generate context-appropriate
prosodic prominence."

**Judgement.** Contrast, correction and clarification are exactly what expository
prose does, and § 3.2's control table has no knob for focus — not in v2's settings
and not in v3's audio tags, which cue *manner* (`[whispers]`) rather than which
word carries the stress. Two consequences.

- Emphasis is a property of the script, so the only lever is writing sentences
  whose stress pattern is unambiguous from syntax. That is
  `narration-craft.md`'s problem, and it should know that half the beats hand it
  one.
- **The 53 italic spans are emphasis instructions that markdown-stripping will
  silently discard.** An author already told us which word to stress, 53 times, and
  a naive script generator will throw all 53 away — and no reviewer reading the
  script will notice, because the script will look right on the page.

### 5.3 Third: drift and uniformity across the whole work

**Documented.** `stability` trades range against consistency and the vendor's own
word for the high end is "monotonous"; v3's Robust mode is "less responsive to
directional prompts".

**Documented, on the specific artefact a long work exposes.** Li, Xing, Xing, Hu,
Lu & Xu (2025), `https://arxiv.org/abs/2508.14713`: "current approaches typically
convert text to speech at the sentence-level and concatenate the results to form
pseudo-paragraph-level speech. These methods overlook the contextual coherence of
paragraphs, leading to reduced naturalness and inconsistencies in style and timbre
across the long-form speech." arXiv, not verified directly.

**Documented precedent, in this repo.** `segment-length-rules.md` grades
"Anti-uniformity — no 3 consecutive segments within ±20 % of each other" as
**evidenced**, having concluded that "Uniform segment length is itself a defect"
because the founder's complaint was "repeatedly".

**Judgement.** The same defect is available to narration and easier to fall into,
because every narration item comes from one voice at one setting. On the barbecue
Foray the count is concrete: #247 reports 6 strong / 10 thin / 24 empty beats, so
**34 beats are narration beats.** If all 34 are one paragraph, one length, one rate
and one shape, the uniformity *is* the synthetic tell, and it will read as robotic
even where every individual item sounds fine in isolation. Tune against the whole
work, not against a sample.

### 5.4 Fourth: prosody at chunk boundaries — and why it matters less here

**Documented.** ElevenLabs offers `previous_text` / `next_text` and request
stitching via `previous_request_ids` / `next_request_ids` to "maintain voice prosody
over multiple chunks"
(`https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching`).
Stitching carries real limits: "A maximum of 3 request_ids can be send", "The
request IDs should be no older than two hours", it requires `enable_logging`, and —
decisively — "Request stitching is not available for the `eleven_v3` model".
Per-request character caps are 5,000 for v3, 10,000 for multilingual v2, 30,000 for
Flash v2 and 40,000 for Flash v2.5.

**Measured, and this is the Foray-specific finding.** The mean claim is 489
characters. Even with narration written several times longer than the claim it
serves, **a narration beat fits in a single v3 request under the 5,000-character
cap** — and the repo's existing brief is far more restrictive still:
`docs/brief/04_VOICE_AUDIO_SPEC.md` specifies "Between items: transition TTS ≤ 8 s",
which at 1,000 characters per minute is about 133 characters.

**Judgement.** That is what makes v3 usable despite having no request stitching.
Foray's narration is naturally chunked by beats, each chunk separated from the next
by *minutes of somebody else's tape*, and prosody continuity across a gap that
large is not something a listener can perceive. The constraint that would
disqualify v3 for an audiobook is close to irrelevant for this format. Note the
tension worth flagging to both sibling documents: the ≤ 8 s brief and #247's "34
narration beats carrying most of the product" cannot both be right, and a 489
character claim already reads for about 30 seconds.

### 5.5 Fifth: breath, and it is genuinely the least of it

**Judgement, and now explicitly unsupported.** Breath absence is the classic
folk answer, and two retrieval passes found **no evidence that absent breath drives
listener detection of synthetic narration** — the only retrieved work is a
synthesis paper showing breath-mark insertion improves naturalness ratings against
its own baseline. Our items are short — a 489 character claim is roughly 30 seconds
at the vendor's rate — and each is bounded by real tape and about 0.5 s of padding.
The pathology needs sustained duration to accumulate and this format does not give
it any. Ranked last, and worth no engineering.

### 5.6 The thing that is not a voice problem but will be blamed on the voice

**Documented.** AES TD1004.1.15-10, via `segment-length-rules.md` § 2f, warns that
inserting externally-produced material into a program can produce loudness jumps
"of up to 7 LU, which is outside the comfort zone of most" listeners. And ACX's
audio submission requirements (`https://help.acx.com/s/article/acx-audio-submission-requirements`)
give the audiobook industry's delivery window in concrete numbers: "Volume is
between -23dB and -18dB RMS", "Peak levels are less than -3dB", "Noise floor is
less than -60dB RMS", with "between 1 and 5 seconds of room tone at the beginning
and end of each file". Note that ACX's dB RMS window is a different measure from
LUFS and the two must not be converted between; the coincidence of "-23" is a
coincidence.

**Judgement, and § 3.3 gives it teeth.** A narration item is exactly the insertion
AES warns about, and it is the one piece of audio in a Foray whose level and
encoding we fully control. The PNAS result in § 3.3 — credibility and intelligence
judgements moving at d = 0.16 to 0.43 on audio quality alone, with comprehension
held constant and the largest effects on synthetic voices — means **encoding and
level are a bigger credibility lever than any voice-trait choice available to us.**
If narration lands louder, quieter or thinner than the tape around it, every
listener will describe it as the voice sounding wrong, and no amount of voice
shopping will fix it. Implementation is the pipeline document's; the ranking is
this document's, and it says level-matching outranks voice selection.

### 5.7 The acceptance test, which is designed here and costs almost nothing

**Measured.** The audited lexicon is 81 entries, ~76 distinct words, plus
`ch'arki` (see appendix).

**Judgement.** Put each in a short carrier sentence and the fixture is on the
order of 4,500 characters — an estimate, not a measurement, of text that does not
exist yet — which should fit inside a single v3 request under the documented 5,000
character cap. If carrier sentences run long, split it in two; nothing depends on
one request.

This is the test that should gate the spend decision, and it should run *before*
anyone chooses a voice on how pleasant it sounds, because § 2 says pronunciation is
where this will break and § 5.1 says no published number can tell us in advance.
Run it on each shortlisted voice and on each candidate provider; the winner is the
one needing the fewest dictionary entries, not the one with the nicest timbre. It
also resolves the § 5.1 documentation contradiction as a side effect: if v3 honours
dictionary phoneme tags, the fixture will show it. The fixture belongs in the
dry-run adapter's test corpus (`tools/narrate/**`, the pipeline document's
territory); the term list is in the appendix so nobody has to re-derive it.

---

## 6. Provider — and the benchmark the corpus was supposed to have

§ 1 established that the corpus's TTS quality benchmark captured nothing. A
substitute exists and is fetchable, so the quality question can be answered with
somebody's numbers rather than somebody's adjectives.

### 6.1 The leaderboard, and what it does not measure

**Documented**, from Artificial Analysis' Speech Arena leaderboard
(`https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice`, fetched
directly), whose stated method is an "Elo rating system derived from user votes in
blind comparisons in the Speech Arena", where listeners "listen to pairs of speech
samples generated from the same text and choose which sounds more natural". 95
rows; columns "Rank | Creator | Model | Elo | 95% CI | Samples | Arena Voices |
Released | API Pricing".

| rank | model | creator | Elo | 95 % CI | samples |
|---|---|---|---|---|---|
| 1 | Sonic 3.6 | Cartesia | 1,283 | ±17 | 1,579 |
| 2 | Qwen-Audio-3.0-TTS-Plus | Alibaba | 1,240 | ±14 | 2,058 |
| 3 | Simba 3.2 | Speechify | 1,240 | ±14 | 2,048 |
| 4 | Luna TTS | VUI Labs | 1,219 | ±14 | 2,159 |
| 5 | Gemini 3.1 Flash TTS | Google | 1,211 | ±12 | 3,425 |
| **11** | **Eleven v3** | **ElevenLabs** | **1,179** | **±11** | **4,365** |
| 31 | Turbo v2.5 | ElevenLabs | 1,104 | ±10 | 7,320 |
| 32 | Multilingual v2 | ElevenLabs | 1,104 | ±10 | 7,768 |
| 38 | Flash v2.5 | ElevenLabs | 1,084 | ±11 | 5,967 |
| 95 | Polly Standard | Amazon | 817 | — | — |

The listed API pricing column gives Eleven v3 and Multilingual v2 at $100/1M
characters and Turbo/Flash v2.5 at $50/1M, matching § 1's API-line figures
independently.

**So the dossier's "best naturalness and prosody" is refuted, not merely
unsupported.** ElevenLabs' best model ranks eleventh, 104 Elo behind the leader,
and its long-form-recommended `multilingual_v2` ranks thirty-second.

Two caveats on how far that goes.

**A separate benchmark's methodology, kept separate.** TTS Arena — a *different*
project from Artificial Analysis — documents its method at
`https://docs.ttsarena.org/ranking` (fetched directly): it ranks "with a
Bradley–Terry model", centres ratings "around 1500", sorts by the lower confidence
bound so models "can't shoot to the top off a handful of lucky wins", requires "100
votes to appear on the board", and counts only "clean votes on first-use Random
prompts". Its introduction states prompts are "English-only for now, capped at
1,000 characters". **Those constraints describe TTS Arena, not the table above**,
and an earlier draft of this section applied them to the wrong leaderboard.
Artificial Analysis does not publish a prompt-length cap that this document
verified.

**Documented, on why any arena measures the wrong thing for us.** This is not a
hedge; the speech-synthesis field says it itself. Clark, Silen, Kenter & Leith
(2019), `https://arxiv.org/abs/1909.03965`: "to evaluate the quality of long-form
speech, the traditional way of evaluating sentences in isolation does not suffice,
and that multiple evaluations are required." Le Maguer, King & Harte (2023), DOI
`10.1016/j.csl.2023.101577`: "despite its origin as an absolute category rating,
MOS is a relative score ... we may have reached the end of a cul-de-sac by only
evaluating the overall quality with MOS." And Perrotin et al. (2024), DOI
`10.1016/j.csl.2024.101747`, report that sentence-level parity has already been
reached — synthetic speech "indistinguishable from natural speech in terms of
intelligibility in 2021 and ... perhaps even indistinguishable in naturalness" —
leaving "increasingly smaller and localised differences". None verified directly
beyond the retrieval report.

**Judgement.** Read together, that is the reconciliation this document needs.
Modern neural TTS wins at the sentence level, which is the level the arena
measures; the remaining deficits are small and localised, which is the profile a
two-to-three hour runtime multiplies. So a 104-Elo gap on "which of these two clips
sounds more natural" is real evidence that ElevenLabs is not the front-runner it
was assumed to be, and weak evidence about how it will read the alcohol spine. The
one long-form comparison retrieved still favours human narration — Rodero & Lucas
(2021), DOI `10.1177/14614448211024142`, report listeners enjoying, attending to
and remembering more from human-narrated audiobooks — and **no study was found
measuring effort or fatigue across a multi-hour synthetic narration at all.** Our
exact regime is unstudied.

### 6.2 The alternative the evidence actually points at

Fairness requires naming it, because the arena's top-ranked provider is not a toy.

**Documented**, Cartesia, fetched directly
(`https://docs.cartesia.ai/build-with-cartesia/capability-guides/custom-pronunciations`
and `https://docs.cartesia.ai/api-reference/tts/tts`): custom pronunciations accept
"An IPA pronunciation or a 'sounds-like' guidance" — so both `<<ˈ|b|ɑ|ˈ|j|u>>` and
respellings like `chop-uh-TOO-liss` — authored via API "or through our playground",
attached to any TTS request by `pronunciation_dict_id`, with matching
"case-sensitive, with one exception: a lowercase entry also matches its
sentence-start capitalized form". The documented `speed` range is [0.6, 1.5] and
`volume` [0.5, 2.0]; `locale` supports regional variants such as `en-GB`. No
per-request character limit is documented. Pricing is credit-based: Pro $5/month
for 100K credits, documented as approximately "~133" minutes; no per-character rate
is documented, so it is not directly comparable to § 1's figures.

**Judgement, three ways it is genuinely better for our problem.** The respelling
option means a curator can fix `binchōtan` without learning IPA, which matters when
~76 words need authoring and the people who know how they are pronounced are not
phoneticians. The wider speed range gives more room for § 3.1's slower read. And no
documented model restriction on the dictionary means no silent fallback of the kind
ElevenLabs documents — and no contradiction between pages about which models honour
it, which is § 5.1's live risk.

**Judgement, and why it does not win today.** Cartesia documents no reliability
figure for its dictionary, and an absent caveat is not a better caveat — ElevenLabs
at least says 80–90 %. Its long-form posture is undocumented where ElevenLabs
explicitly markets v3 for "long-form narration". Voice longevity is not addressed
either way, which after § 3.2 reads as an unanswered question rather than a
non-issue. And the founder is supplying an ElevenLabs key, which is not an argument
about audio but is a real constraint on what gets built this month.

### 6.3 Switching cost, stated honestly

The useful question is not "what would we rewrite" but "what could we not get
back".

| asset | portable? | why |
|---|---|---|
| beat-bound scripts | yes | ours, plain text, no vendor in them |
| the pronunciation lexicon | yes, **if authored in IPA** | IPA is a standard both candidates accept; `.PLS` is a W3C format; CMU Arpabet is the ElevenLabs-flavoured choice, so IPA is the portable one and Arpabet the lock-in one — even though ElevenLabs recommends Arpabet for v2 models |
| loudness normalisation, hosting, caching, player integration | yes | provider-independent, and the pipeline document's |
| tuned `stability` / `style` / `speed` values | no | not comparable between vendors; re-tune from scratch |
| **the narrator's voice identity** | **effectively not** | see below |

**Judgement.** That last row is the switching cost and it is not denominated in
dollars. Strictly, voice cloning exists — digest 40 records that Instant Voice
Cloning starts at ElevenLabs' $6 Starter tier — so "no provider can reproduce
another's voice" would be too strong, and an earlier draft said it. The real
barriers are that you would be cloning a synthetic voice you do not own, under
terms that were not written for that, at a quality nobody has promised. Treat the
identity as unportable in practice and for good reasons, not as physically
impossible.

Which means: **changing provider changes who the narrator is.** Every Foray already
narrated then either gets re-voiced or the catalogue acquires a second narrator,
which § 4 argues against. **So the cost of switching is linear in the size of the
narrated back catalogue, and today that catalogue is empty.** The switching cost is
at its lifetime minimum right now and rises monotonically. Two consequences:

- **The acceptance test in § 5.7 must run before the first Foray is narrated**, not
  after. It is the cheapest it will ever be to change our mind, and § 6.1 gives a
  live reason to consider it.
- **Nondeterminism means rendered audio cannot be patched.** ElevenLabs documents
  "The models are nondeterministic. For consistency, use the optional seed
  parameter, though subtle differences may still occur." So a repaired beat cannot
  be fixed at sentence granularity and spliced into existing audio; the whole item
  is re-rendered. What follows for storage design is the pipeline document's call —
  this document only notes the constraint that forces it.

**Documented, on the English-only instruction.** This choice does not paint us into
a corner: `eleven_v3` supports 70+ languages and native IPA "across 70+ languages".
The alternative phoneme-capable model, `eleven_flash_v2`, is documented
English-only — so of the two models whose pronunciation control might work, v3 is
also the one that leaves a non-English Foray possible. Noted in passing, not
scoped.

---

## 7. Recommendation

**One voice. Catalogue-wide. `eleven_v3`, pinned by voice ID, conditional on the
fixture in § 5.7 and on resolving the § 5.1 documentation contradiction.**

Not one voice per topic, not one per act, not one per register. § 4 reaches that on
narrower grounds than an earlier draft claimed: no evidence supports splitting at
the scale we would split at, industry convention is unanimous against it, the
voice-familiarity mechanism compounds in favour of one, and a second narrator adds
orienting cost without adding orientation.

### The three characteristics to specify

1. **Rate and pause structure, explicitly set — and pause is the more important
   half.** Set `speed` to about 0.9 within the documented 0.7–1.2 range, giving
   roughly 150 wpm against the ~170 wpm the repo estimates for the surrounding
   tape: audibly less hurried than the people it introduces, and at the documented
   human production rate. But § 3.1's evidence says the bigger lever is silence at
   syntactic boundaries, with sentence-boundary pauses about twice clause-boundary
   pauses. Since v3 has no documented `<break>` control, **that has to be delivered
   by punctuation in the script**, which makes it a joint constraint with
   `narration-craft.md` rather than a setting. It is the one recommendation here
   with a real experimental result behind it.

2. **Affect: low expressive range, deliberately — v3's "Natural", never
   "Creative".** Creative mode is documented "prone to hallucinations", and a
   hallucinating narrator in a factual educational work is exactly the #226 defect
   the spines exist to prevent: plausible, fluent, off-beat. Robust is "less
   responsive to directional prompts", which walks into § 5.3's uniformity tell.
   Natural — "balanced and neutral" — trades the least of either. The narrator does
   not need to be moved by the material; it needs to be right about it.

3. **Timbre: pick a plain one from the Narration or Educational filter, and then
   stop.** This characteristic is deliberately thin, because § 3.3 is the section
   with the most evidence in the document and it is almost entirely negative:
   manipulating pitch in synthetic voices moved dominance but **not**
   trustworthiness (p = 0.298) or competence (p = 0.732); there is no retrievable
   evidence for a perceived-age effect; the one instructional study on speaker
   gender reports a null; and "British sounds more authoritative to Americans" is
   folklore with no supporting study. The accent evidence that does exist favours
   the audience's own standard variety (d = 0.47 for standard over non-standard),
   which for a US audience is General American. **So: middle-aged, mid-to-low
   pitch, plain rather than charming — chosen because the narrator's job at a
   bridged seam is to be recognisably not one of the charming guests — and no
   further optimisation of pitch, gender or accent, because the evidence for those
   levers is null, contested or absent.** Spend that attention on encoding and
   level instead, where § 3.3 measures d = 0.16 to 0.43 on credibility with
   comprehension held constant.

**And the selection rule that overrides all three:** shortlist on the filters, then
choose the voice needing the **fewest pronunciation-dictionary entries** to pass the
§ 5.7 fixture — not the one that sounds nicest reading a demo sentence.

### What must be true operationally

- The voice must be documented as usable **in perpetuity** and recorded in the repo
  **by voice ID**. ElevenLabs' Default voices "will expire on December 31, 2026", so
  a default voice guarantees a forced re-voicing of the back catalogue within four
  months.
- The pronunciation lexicon is authored in **IPA**, not CMU Arpabet, because IPA is
  the notation both candidate vendors accept.
- Narration is level-matched to surrounding tape before anyone judges the voice.
  § 5.6 and § 3.3 together make this outrank voice selection.

### The single highest-risk assumption

**That the pronunciation problem is fixable by dictionary at all.**

Everything rests on it. It is why v3 was chosen over four higher-ranked models: not
because it sounds better — § 6.1 says it does not — but because it is documented to
accept a pronunciation dictionary, and § 2 says that is the axis our copy will break
on. If dictionary control does not actually work on our vocabulary, the entire basis
for preferring ElevenLabs over the arena leaders evaporates, and the choice should
be re-made on naturalness, price and pause control instead — where ElevenLabs loses
on all three.

The evidence for that assumption is thinner than the recommendation it carries:

- **Two official ElevenLabs pages contradict each other** about whether v3 honours
  dictionary phoneme tags (§ 5.1). The only model every page agrees on is
  English-only.
- The one reliability figure available is a **vendor claim about "consistency"**,
  at 80–90 %, which is not a per-token accuracy rate.
- **No published absolute mispronunciation rate for proper nouns exists** in any
  current neural TTS (§ 5.1), so there is no external benchmark to sanity-check
  against.
- The dictionary's behaviour on **loanwords inside English prose** — which is
  almost our entire lexicon — is not documented either way.

It is testable for the price of one generation, and § 5.7 is that test. **Nobody
should narrate a Foray before running it.** An earlier draft named a different
highest-risk assumption — that a beat fits in one request — which the repo's own
existing "transition TTS ≤ 8 s" brief makes comfortable rather than risky.

### What else would change this recommendation

- The fixture failing on every shortlisted ElevenLabs voice while Cartesia passes.
  § 6.1 makes this a live possibility, not a courtesy hedge.
- The `.PLS` dictionary turning out to have an undocumented rule limit below ~76, or
  the "languages other than English" clause silently disabling most of the lexicon.
- A decision that narration should carry non-English terms *as* non-English, which
  would make the `flash_v2` fallback unavailable and force the question back open.
- Distribution through a channel that forbids synthetic narration. ACX states:
  "Your submitted audiobook must be narrated by a human unless otherwise
  authorized: Unauthorized use of text-to-speech, AI, or automated recordings in
  ACX titles is prohibited." Foray does not distribute there today, and this is a
  product question rather than a voice one, but it would moot the whole document if
  it ever did.

---

## 8. What this document could not establish

Stated plainly, because a gap presented as a finding is the failure mode this
document was asked to avoid.

- **Nothing was heard.** Every quality statement is somebody else's vote or
  somebody else's marketing.
- **The § 5 ranking is a hypothesis, not a finding.** No study asks listeners what
  cues them that long-form narration is synthetic. The ordering rests on measured
  density in our copy plus documented system limitations.
- **Our exact regime is unstudied.** No research was found on listening effort,
  fatigue or attention decline across a multi-hour synthetic narration, and none
  measuring quality decay against passage duration.
- **No absolute proper-noun mispronunciation rate exists** for current neural TTS,
  which is precisely why § 5.7 exists.
- **Roughly a third of the literature cited was not read here.** Where a finding
  carries weight in § 7 it was re-fetched and verified directly — the ElevenLabs
  control surface, the voice-expiry date, the pronunciation-dictionary sentence, the
  80–90 % figure, the Speech Arena table, Cartesia's dictionary, the synthetic-pitch
  nulls and the audio-quality effect sizes. Everything else carries "not verified
  directly", and several classics (Foulke & Sticht 1969, Mullennix et al. 1989,
  Martin et al. 1989, Pellegrino et al. 2011) are paywalled and cited at second
  hand or on metadata alone. Two of those — Martin et al. on talker variability and
  recall, and the Fuertes et al. accent meta-analysis — would be worth an hour if
  § 4 or § 3.3 is ever challenged.
- **The audiobook pace convention has no primary source.** The 150–160 wpm figure
  traces to practitioner writing; ACX, Audible and the APA publish no
  words-per-minute standard.
- **Free-tier attribution requirements are unresolved** — the ElevenLabs help-centre
  article that would settle whether attribution is required returns 403 to
  automated fetches. It needs a human with a browser.

**One adjacent finding recorded because somebody will need it, and it is not a
voice decision.** Disclosure practice for synthetic narration now has an industry
convention and a regulatory floor. The Audio Publishers Association and UK
Publishers Association's October 2024 naming guidelines define "AI Voice" and
"Authorized Voice Replica", suggest the terms apply when "more than 10% of a voice
has been created using AI tools", and recommend displaying them "in the narrator
line of a title listing" — while stating "they are not requirements". Audible's
implementation is a factual credit, "Narrator: Virtual Voice". EU AI Act Article 50
applies from 2 August 2026 and puts machine-readable marking on *providers* while
scoping the deployer disclosure duty to deep fakes, with a carve-down for work that
"forms part of an evidently artistic, creative, satirical, fictional or analogous
work". None of that was verified against EUR-Lex, none of it is legal advice, and
all of it belongs to whoever owns product and distribution.

### The corpus additions this implies

Sources that earned their place and are not yet in
`docs/research/foray-research-dossier.md` § 6. Recorded here rather than added to
the manifest because ingesting them means running the scraper and regenerating the
committed index, which is a separate change:

- `https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice` — the
  fetchable substitute for the failed source 37, 95 ranked models.
- `https://docs.ttsarena.org/ranking` — TTS Arena's methodology, which source 37
  was supposed to supply and could not.
- `https://elevenlabs.io/pricing/api` — the API price line, without which source 40
  leads a reader to over-state cost by 1.65–2.0×.
- `https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries`
  and `https://elevenlabs.io/docs/overview/capabilities/voices.md` — the two
  documents that actually decide the model and the voice.
- `https://help.acx.com/s/article/acx-audio-submission-requirements` — the
  audiobook delivery window, and the human-narration rule.
- O'Leary et al. 2023 (DOI `10.1177/23312165231203514`) and Walter-Terrill et al.
  2025 (DOI `10.1073/pnas.2415254122`) — the two experimental results that most
  changed this document.

Also worth a correction pass in the dossier, all in § 6 and its Recommendations
section: "best naturalness and prosody" (refuted, § 6.1); the source 37 summary
line, which reads as though leaderboard data was captured; and the Recommendations
plan to "generate bridges with a mid-tier TTS ... and A/B against ElevenLabs",
which § 5.1 complicates — not because mid-tier models lack pronunciation control in
general, which this document did not check for OpenAI or Polly Generative, but
because within ElevenLabs' own line-up the cheaper models are documented to skip
dictionary phoneme tags silently. The dossier's Polly note is fine as written: it
names Polly Generative, and § 6.1's last-place row is Polly *Standard*, a different
tier.

---

## Appendix — the pronunciation acceptance lexicon

81 entries, hand-audited from a dump of every distinct token in the claim text of
both spines. 80 appear in claim text, 103 times, across 46 % of beats.

**Process, chemistry and organisms (23):** acetaldehyde, anethole, azeotrope,
cinchona, diacetyl, fructan, fructans, gentian, jora, keeving, koji, lactones,
nuruk, quebracho, vanillin, *Artemisia*, *Aspergillus*, *Brettanomyces*,
*Saccharomyces*, *cerevisiae*, *eubayanus*, *oryzae*, *pastorianus*.

**Drinks and vessels (31):** aguamiel, airag, akvavit, alembic, arak, arkhi,
arrack, awamori, baijiu, burukutu, chicha, destilados, eisbock, genever, huangjiu,
kumis, lambic, makgeolli, mezcal, ouzo, pastis, pito, pulque, quinquinas, qvevri,
raki, sambuca, shochu, soju, tella, tinajas.

**Fire and cooking (8):** asado, asador, barbacoa, binchotan, binchōtan, braai,
döner, mangal.

**Proper nouns whose pronunciation is not guessable from spelling (19):** Aeneas,
Angostura, Aperol, Armagnac, Batavia, Bénédictine, Bérard, Calvados,
Cellier-Blumenthal, Coffey, Commandaria, Fernet, Juneteenth, Marsala, Meiji,
Pilsen, Quechua, Taipei, Taíno.

**Three honest deductions from "81".** `fructan` and `fructans` are one word;
`binchotan` and `binchōtan` are the same word audited under both spellings on
purpose, which is why the accented form is the only one occurring and the
unaccented one is the single entry of the 81 absent from claim text; and
`Saccharomyces`, `cerevisiae`, `pastorianus`, `eubayanus` and `oryzae` are five
entries covering three binomials plus a genus, because bare species epithets were
counted separately. **The distinct-word count is nearer 76**, and any place this
document says "81" for fixture sizing should be read as an upper bound.

**One term missing from the count for a mechanical reason.** `ch'arki` appears in
the barbecue spine and is among the harder items in it, but its apostrophe breaks
the word-boundary matching the count relies on, so it was excluded rather than
counted unreliably. **Add it to the fixture; do not add it to the statistics.**

**The 7 diacritic-bearing tokens that occur in claim text**, additionally at risk
from any ASCII-normalising step: `binchōtan`, `Taíno`, `Édouard`, `rosé`, `döner`,
`entrepôt`, `Bénédictine`. Across the spine documents in full there are 22, the
other 15 appearing only in curator-facing prose the narrator will not read:
`tōji`, `hāngī`, `piña`, `cachaça`, `taquería`, `Provençal`, `Baumé`, `consommé`,
`armagnaçais`, `țuică`, `pálinka`, `żubrówka`, `poitín`, `Bérard`, `à`.

### Reproducing the measurements

Every number in § 2, § 5.2 and § 5.3 comes from parsing the `**Claim.**` paragraph
under each `#### N.` heading in the two spine documents and counting. No network,
no vendor, no key. The proper-noun proxy is capitalised tokens in
non-sentence-initial position minus the stop list named in § 2. The
contrastive-construction total is the five patterns enumerated in § 5.2. The risk
lexicon is the list above, matched case-insensitively on word boundaries. Markdown
emphasis is stripped before counting words and characters, but the 53-span italic
count in § 5.2 is taken *before* stripping, since the markers are the measurement.
The characters-per-word figure of 5.97 includes spaces and converts every vendor
characters-per-minute claim into words per minute.
