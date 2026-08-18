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

---

## 5. What breaks the illusion first

Ranked by expected frequency on *our* copy, not in general. The basis for each
rank is stated, because the ranking is the useful part and it is mostly
judgement resting on measured density.

### 5.1 First: mispronounced proper nouns and loanwords

**Measured.** 46 % of beats contain at least one term from the audited lexicon;
103 occurrences across the two spines; 22 tokens carry non-ASCII diacritics.

**Documented, and the mechanism is worse than it looks.** ElevenLabs supports
pronunciation dictionaries in IPA and CMU Arpabet, uploaded as `.PLS` files and
attached per request via `pronunciation_dictionary_locators`, with "up to 3
locators per request". But: "Pronunciation dictionary phoneme tags only work with
eleven_flash_v2 and eleven_v3 models", and on every other model "Other models skip
dictionary phoneme tags and use the default pronunciation." **The failure is
silent** — no error, just the wrong word. That single sentence eliminates
`eleven_multilingual_v2` from consideration for this product no matter what else
recommends it, and `eleven_multilingual_v2` is the model ElevenLabs' own model page
calls "Most stable on long-form generations".

There is a second constraint pointing the same way: "If you want to use IPA and
CMU pronunciations in languages other than English, you will have to switch to the
eleven_v3 model." Our copy is English prose containing Japanese, Korean, Chinese,
Quechua, Georgian, Nahuatl and Māori words. Whether the dictionary treats those as
"languages other than English" is not documented, and the safe reading is that it
does.

**Documented, and this is the number to hold on to.** For v3's native IPA support:
"V3's IPA support achieves 80-90% pronunciation consistency. While significantly
more reliable than v2's XML phoneme tags, it is not 100% consistent."

**Measured against that documented rate.** 103 risk-term occurrences at 80–90 %
consistency is **10 to 21 audible mispronunciations across the two Forays even
with a complete, correct pronunciation dictionary in place.** That is the honest
ceiling. Pronunciation is not a problem this stack solves; it is a problem this
stack reduces, and the residue has to be caught by listening.

### 5.2 Second: wrong emphasis, because nothing controls it

**Measured.** The claim text contains 62 contrastive constructions — `rather
than` (40), `is/are/was not` (13), `not just`/`not only` (2), `instead of` (1),
`the real`/`the actual`/`the whole` (6) — one per 136 words, in **50 % of beats**.
Separately, the authors marked emphasis by hand 53 times using single-asterisk
italics, in 33 beats.

**Judgement.** These are the sentences where meaning lives in which word carries
the stress. "Malting is tricking the grain into digesting *itself*" means something
different with the stress elsewhere, and § 3.2's control table has no knob for it —
not in v2's settings and not in v3's audio tags, which cue *manner* (`[whispers]`)
rather than *focus*. Two consequences, and the second is the one people miss.

- Emphasis is a property of the script, so the only lever is writing sentences
  whose stress pattern is unambiguous from syntax. That is `narration-craft.md`'s
  problem, and it should know that 50 % of beats hand it one.
- **The 53 italic spans are emphasis instructions that markdown-stripping will
  silently discard.** An author already told us which word to stress, 53 times,
  and a naive script generator will throw all 53 away and no reviewer reading the
  script will notice, because the script will look right on the page.

### 5.3 Third: uniform prosody across the whole work

**Documented.** `stability` trades range against consistency, and the vendor's own
word for the high end is "monotonous". v3's Robust mode is "less responsive to
directional prompts".

**Documented precedent, in this repo.** `segment-length-rules.md` grades
"Anti-uniformity — no 3 consecutive segments within ±20 % of each other" as
**evidenced**, having concluded that "Uniform segment length is itself a defect"
because the founder's complaint was "repeatedly".

**Judgement.** The same defect is available to narration and is easier to fall
into, because every narration item comes from one voice at one setting. § 2
measures the mean claim at 489 characters — if 34 narration beats are all one
paragraph, one length, one rate and one shape, the uniformity *is* the synthetic
tell, and it will read as robotic even if every individual item sounds fine in
isolation. Whoever tunes settings should be tuning against the whole work, not
against a sample.

### 5.4 Fourth: prosody at chunk boundaries — and why it matters less here

**Documented.** ElevenLabs offers two continuity mechanisms: `previous_text` /
`next_text`, and request stitching via `previous_request_ids` / `next_request_ids`
to "maintain voice prosody over multiple chunks". Stitching carries real limits:
"A maximum of 3 request_ids can be send", "The request IDs should be no older than
two hours", it requires `enable_logging` to be on, and — decisively — "Request
stitching is not available for the `eleven_v3` model". Per-request character caps
are 5,000 for v3, 10,000 for multilingual v2, 40,000 for Flash v2.5.

**Measured, and this is the Foray-specific finding.** The mean claim is 489
characters and the longest spine's mean is 536. Even with narration written
several times longer than the claim it serves, **a narration beat comfortably fits
in a single v3 request under the 5,000-character cap.** So the classic long-form
problem — stitching a chapter out of many chunks and hearing the joins — largely
does not arise for us. One beat is one request.

**Judgement.** That is what makes v3 usable despite having no request stitching,
and it is the load-bearing step in § 6's recommendation. Foray's narration is
naturally chunked by beats, each chunk is separated from the next by *minutes of
somebody else's tape*, and prosody continuity across a gap that large is not a
thing a listener can perceive. The constraint that would disqualify v3 for an
audiobook is close to irrelevant for this format.

### 5.5 Fifth: breath, and it is genuinely the least of it

**Judgement.** Breath absence is the classic tell in synthetic audiobook reading,
where a voice runs uninterrupted for forty minutes. Our items are short — a 489
character claim is roughly 30 seconds at the vendor's own rate — and each one is
bounded by real tape and, per `docs/brief/04_VOICE_AUDIO_SPEC.md`, about 0.5 s of
padding. The pathology needs sustained duration to accumulate, and this format
does not give it any. Ranked last, and worth no engineering.

### 5.6 The one thing that is not a voice problem but will be blamed on the voice

**Documented.** AES TD1004.1.15-10, via `segment-length-rules.md` § 2f, warns that
inserting externally-produced material into a programme can produce loudness jumps
"of up to 7 LU, which is outside the comfort zone of most" listeners.

**Judgement.** A narration item is exactly such an insertion, and it is the one
piece of audio in a Foray whose level we fully control. If narration lands louder
or quieter than the tape around it, every listener will describe it as the voice
sounding wrong, and no amount of voice selection will fix it. Level-matching
narration to the surrounding segments is a pipeline obligation
(`docs/narrator-pipeline.md`), noted here only so that a bad first listen is
diagnosed correctly instead of being blamed on the voice and answered by shopping
for another one.

### 5.7 The acceptance test, which is designed here and costs almost nothing

**Measured.** The audited lexicon is 81 terms. Put each in a short carrier
sentence and the whole fixture is roughly 4,500 characters — **which fits inside a
single v3 request under the documented 5,000-character cap.** One generation, one
listen, a pass/fail per term.

**Judgement.** That is the test that should gate the spend decision, and it should
run *before* anyone chooses a voice on how pleasant it sounds, because it
discriminates between voices on the axis § 2 says will actually break. Run it on
each shortlisted voice; the winner is the one needing the fewest dictionary
entries, not the one with the nicest timbre. The fixture belongs in the dry-run
adapter's test corpus (`tools/narrate/**`); the term list is in the appendix below
so that whoever builds it does not have to re-derive it.

---

## 6. Provider — and the benchmark the corpus was supposed to have

§ 1 established that the corpus's TTS quality benchmark captured nothing. A
substitute exists and is fetchable, so the quality question can be answered with
somebody's numbers rather than somebody's adjectives.

### 6.1 The leaderboard, and what it does not measure

**Documented**, from Artificial Analysis' Speech Arena leaderboard
(`https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice`), whose
stated method is an "Elo rating system derived from user votes in blind comparisons
in the Speech Arena", where listeners "listen to pairs of speech samples generated
from the same text and choose which sounds more natural". 95 rows.

| rank | model | creator | Elo | 95 % CI | samples | released | listed API price |
|---|---|---|---|---|---|---|---|
| 1 | Sonic 3.6 | Cartesia | 1,283 | ±17 | 1,579 | — | — |
| 2 | Qwen-Audio-3.0-TTS-Plus | Alibaba | 1,240 | ±14 | 2,058 | — | — |
| 3 | Simba 3.2 | Speechify | 1,240 | ±14 | 2,048 | — | — |
| 4 | Luna TTS | VUI Labs | 1,219 | ±14 | 2,159 | — | — |
| 5 | Gemini 3.1 Flash TTS | Google | 1,211 | ±12 | 3,425 | — | — |
| **11** | **Eleven v3** | **ElevenLabs** | **1,179** | **±11** | **4,365** | **Feb 2026** | **$100 / 1M chars** |
| 31 | Turbo v2.5 | ElevenLabs | 1,104 | ±10 | 7,320 | Jul 2024 | $50 / 1M |
| 32 | Multilingual v2 | ElevenLabs | 1,104 | ±10 | 7,768 | Aug 2023 | $100 / 1M |
| 38 | Flash v2.5 | ElevenLabs | 1,084 | ±11 | 5,967 | Dec 2024 | $50 / 1M |
| 95 | Polly Standard | Amazon | 817 | — | — | — | — |

**So the dossier's "best naturalness and prosody" is not merely unsupported, it is
refuted.** ElevenLabs' best model ranks eleventh, 104 Elo behind the leader, and
its long-form-recommended `multilingual_v2` ranks thirty-second. Amazon Polly
Standard is dead last of 95, which retires the dossier's "cheapest scalable option
for bridges" idea on quality grounds rather than price.

**Documented, and it is the caveat that keeps this table in proportion.** Both
public arenas measure short-form naturalness preference on arbitrary prompts. TTS
Arena's own methodology documentation states "Prompts are English-only for now,
capped at 1,000 characters", ranks with "a Bradley–Terry model", sorts by the lower
confidence bound so models "can't shoot to the top off a handful of lucky wins",
requires "100 votes to appear on the board", and counts only "clean votes on
first-use Random prompts".

**Judgement.** Those are careful benchmarks of the wrong thing. Nobody is
measuring pronunciation accuracy on rare loanwords, consistency across a
three-hour work, or whether stress landed on the right word — the three failures
§ 5 ranks first, second and third. A 104-Elo gap on "which of these two clips
sounds more natural" is real evidence that ElevenLabs is not the front-runner it
was assumed to be, and weak evidence about how it will read the alcohol spine.

### 6.2 The alternative the evidence actually points at

Fairness requires naming it, because the arena's top-ranked provider is not a toy.

**Documented**, Cartesia: custom pronunciations accept "An IPA pronunciation or a
'sounds-like' guidance" — so both `<<ˈ|b|ɑ|ˈ|j|u>>` and respellings like
`chop-uh-TOO-liss` — authored via API "or through our playground", attached to any
TTS request by `pronunciation_dict_id`, with matching "case-sensitive, with one
exception: a lowercase entry also matches its sentence-start capitalized form". The
documented `speed` range is [0.6, 1.5] and `volume` [0.5, 2.0]; `locale` supports
regional variants such as `en-GB`. No per-request character limit is documented.
Pricing is credit-based: Pro $5/month for 100K credits, documented as
approximately "~133" minutes.

**Judgement, three ways it is genuinely better for our problem.** The respelling
option means a curator can fix `binchōtan` without learning IPA, which matters when
81 terms need authoring and the people who know how they are pronounced are not
phoneticians. The wider speed range gives more room for § 3.1's deliberately slow
read. And no documented model restriction on the dictionary means no silent
fallback of the kind ElevenLabs documents for `multilingual_v2`.

**Judgement, and why it does not win.** Cartesia documents no reliability figure
for its dictionary, and an absent caveat is not a better caveat — ElevenLabs at
least tells you 80–90 %. Its long-form posture is undocumented where ElevenLabs
explicitly markets v3 for "long-form narration". Voice longevity is not addressed
either way, which after § 3.2 should now read as an unanswered question rather
than a non-issue. And the founder is supplying an ElevenLabs key, which is not an
argument about audio but is a real constraint on what gets built this month.

### 6.3 Switching cost, stated honestly

The useful question is not "what would we rewrite" but "what could we not get
back".

**Judgement.** Almost everything is portable and one thing is not.

| asset | portable? | why |
|---|---|---|
| beat-bound scripts | yes | ours, plain text, no vendor in them |
| the pronunciation lexicon | yes, **if authored in IPA** | IPA is a standard both vendors accept; ElevenLabs' `.PLS` is a W3C format, and CMU Arpabet is the ElevenLabs-flavoured choice — so IPA is the portable one and Arpabet is the lock-in one, even though ElevenLabs recommends Arpabet for v2 models |
| loudness normalisation, hosting, caching, player integration | yes | provider-independent, and already the pipeline doc's |
| tuned `stability` / `style` / `speed` values | no | not comparable between vendors; re-tune from scratch |
| **the narrator's voice itself** | **no** | **no provider can reproduce another's voice** |

That last row is the entire switching cost and it is not denominated in dollars.
Changing provider changes who the narrator *is*. Every Foray already narrated then
either gets re-voiced or the catalogue acquires a second narrator — which § 4 just
spent a section arguing against. **So the cost of switching provider is linear in
the size of the narrated back catalogue, and today that catalogue is empty.** The
switching cost is at its lifetime minimum right now and rises monotonically from
here. Two consequences:

- **The acceptance test in § 5.7 must run before the first Foray is narrated**, not
  after. It is the cheapest it will ever be to change our mind, and § 6.1 says
  there is a live reason to consider it.
- **Nondeterminism means rendered audio is a cache, not a master.** ElevenLabs
  documents "The models are nondeterministic. For consistency, use the optional
  seed parameter, though subtle differences may still occur." So a repaired beat
  cannot be patched at sentence granularity and spliced into existing audio — the
  whole item is re-rendered. The durable assets are the script and the lexicon; the
  audio is derived. Design storage that way and a provider change is a re-render
  rather than a rebuild.

**Documented, on the English-only instruction.** This choice does not paint us
into a corner: `eleven_v3` supports 70+ languages and native IPA "across 70+
languages". The alternative phoneme-capable model, `eleven_flash_v2`, is documented
English-only — so of the two models whose pronunciation control actually works,
picking v3 is also the one that leaves a non-English Foray possible. Noted in
passing, not scoped.

---

## 7. Recommendation

**One voice. Catalogue-wide. `eleven_v3`, pinned by voice ID, conditional on the
81-term fixture.**

Not one voice per topic, not one per act, not one per register. The narrator is the
only continuous voice in a work made of strangers, and § 4.2 shows the perceptual
cost of changing it is measured, does not habituate, and lands on the single
sentence a narration item most needs to land. Tonal fit is a benefit nobody has
measured; continuity is a cost somebody has.

### The three characteristics to specify

1. **Rate: explicitly slower than default, and never the default.** Set `speed`
   around 0.85 within the documented 0.7–1.2 range, targeting roughly 145–155 wpm
   against the ~170 wpm the repo estimates for the surrounding tape. The narrator
   should be audibly less hurried than the people it introduces. This is the one
   characteristic that is a settable number rather than a property of the voice,
   so it is the one there is no excuse for getting wrong.

2. **Affect: low expressive range, deliberately — v3's "Natural", never
   "Creative".** Creative mode is documented "prone to hallucinations", and a
   hallucinating narrator in a factual educational work is exactly the #226 defect
   the spines exist to prevent: plausible, fluent, off-beat. Robust is documented
   "less responsive to directional prompts", which walks into § 5.3's uniformity
   tell. Natural — "balanced and neutral" — is the setting that trades the least of
   either. **The narrator does not need to be moved by the material. It needs to be
   right about it.**

3. **Persona: middle-aged, mid-to-low pitch, plain rather than warm.** In Voice
   Library filter terms: age "Middle Aged", use case "Narration" or "Educational".
   A lecturer's plainness, not a host's charm and not a documentary voice-of-god.
   The reason is structural rather than aesthetic — the narrator's job at a bridged
   seam is to be recognisably *not* one of the guests, and every guest in a podcast
   segment is being charming. Plainness is the contrast the format has left.

**And the selection rule that overrides all three:** shortlist on the filters,
then choose the voice that needs the **fewest pronunciation-dictionary entries** to
pass the 81-term fixture — not the one that sounds nicest reading a demo sentence.
§ 2 measured where this will break, and it is not timbre.

### What must be true operationally

- The voice must be documented as usable **in perpetuity**, and recorded in the
  repo **by voice ID**. ElevenLabs' Default voices "will expire on December 31,
  2026", so a default voice guarantees a forced re-voicing of the back catalogue
  inside four months.
- The pronunciation lexicon is authored in **IPA**, not CMU Arpabet, because IPA is
  the notation both candidate vendors accept.
- Rendered audio is treated as a **cache** and the script plus lexicon as the
  masters, because the models are documented nondeterministic and a beat cannot be
  patched at sentence granularity.

### The single highest-risk assumption

**That a narration beat fits in one request.**

The whole model choice rests on it. § 5.4 argues v3 is usable despite "Request
stitching is not available for the `eleven_v3` model", and the argument is that our
mean claim is 489 characters, so one beat is one request, so there are no chunk
joins to hear. If that holds, v3's biggest documented long-form weakness is
irrelevant to us and we get the eleventh-ranked model with working phoneme tags.

If it does not hold, the recommendation changes. **And it is not my assumption to
validate** — narration length per beat is being decided right now in
`docs/curation/narration-craft.md`, by someone else, and an empty beat carrying a
36.5 %-of-runtime act may well want narration many times the length of the claim it
serves. The threshold is sharp and checkable: **if narration for a single beat can
exceed roughly 5,000 characters, v3 must chunk with no stitching available**, and
the choice moves to `eleven_flash_v2` (phoneme tags, 30,000-character cap, but
documented English-only) or to Cartesia (no documented cap, no documented model
restriction). Nobody should discover this after a Foray is narrated.

### What else would change this recommendation

- The 81-term fixture failing badly on every shortlisted ElevenLabs voice while
  Cartesia passes. § 6.1 makes this a live possibility, not a courtesy hedge.
- The `.PLS` dictionary turning out to have an undocumented rule limit below 81, or
  the "languages other than English" clause silently disabling entries for the
  loanwords, which is most of the list.
- A decision that Forays should carry non-English narration, which would make the
  `flash_v2` fallback unavailable and force the question back open.

---

## 8. What this document could not establish

Stated plainly, because a gap presented as a finding is the failure mode this
document was asked to avoid.

- **No evidence was obtained on pitch, breathiness, accent, perceived age or
  gender and their effect on perceived authority, warmth or credibility.** The
  session's web-search budget was exhausted before that literature could be
  reached. Characteristic 3 above is therefore **judgement resting on a structural
  argument** — the narrator must contrast with charming guests — and not on the
  psychoacoustic or social-perception literature it should rest on. It is the
  weakest of the three recommendations and should be the first thing a follow-up
  strengthens or overturns.
- **No audiobook-industry pace standard was verified.** § 3.1's rate argument runs
  entirely off vendor pricing arithmetic and this repo's own 170 wpm estimate. The
  ACX and Audio Publishers Association guidance was not read.
- **No listening-effort literature for modern neural TTS was consulted**, so the
  claim that synthetic long-form costs a listener more than human long-form is
  neither made nor refuted here.
- **Nothing was heard.** Every quality statement is somebody else's vote or
  somebody else's marketing.
- **Free-tier attribution requirements are unresolved** — the ElevenLabs
  help-centre article that would settle whether AI-generation disclosure or
  attribution is required returns 403 to automated fetches. It needs a human with
  a browser. It does not affect the voice choice; it may affect the product.

### The corpus additions this implies

Three URLs earned their place and are not yet in
`docs/research/foray-research-dossier.md` § 6. They are recorded here rather than
added to the manifest because ingesting them requires running the scraper and
regenerating the committed index, which is a separate change:

- `https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice` — the
  fetchable substitute for the failed source 37, with 95 ranked models.
- `https://docs.ttsarena.org/ranking` — TTS Arena's methodology, which source 37
  was supposed to supply and could not.
- `https://elevenlabs.io/pricing/api` — the API price line, without which source
  40 leads a reader to over-state cost by 1.65–1.8×.

Also worth a correction pass in the dossier: § 6's "best naturalness and prosody"
(refuted, § 6.1), "cheapest scalable option for bridges" for Polly (last of 95),
and § 4's stage-4 plan to "generate bridges with a mid-tier TTS ... and A/B against
ElevenLabs", which § 5.1 makes unworkable — mid-tier models are exactly the ones
that skip phoneme tags silently.

---

## Appendix — the pronunciation acceptance lexicon

81 terms, hand-audited from a dump of every distinct token in the claim text of
both spines. 80 appear in claim text, 103 times, across 46 % of beats. This is the
§ 5.7 fixture; each term needs a carrier sentence, and the whole set fits in one
5,000-character request.

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

`binchotan` and `binchōtan` are the same word audited under both spellings on
purpose — only the accented form occurs, which is what makes it the one term of
the 81 absent from claim text. One term that **should** be in the fixture is
missing from the count for a mechanical reason worth stating: **`ch'arki`** appears
in the barbecue spine and is one of the harder items in it, but its apostrophe
breaks the word-boundary matching the count relies on, so it was excluded from the
81 rather than counted unreliably. Add it to the fixture; do not add it to the
statistics.

**The 22 diacritic-bearing tokens across both spines**, which are additionally at
risk from any ASCII-normalising step in the pipeline: binchōtan, tōji, hāngī,
Taíno, piña, cachaça, taquería, Provençal, Édouard, Bérard, Baumé, rosé, döner,
entrepôt, consommé, armagnaçais, țuică, pálinka, żubrówka, poitín, Bénédictine, à.

### Reproducing the measurements

Every number in § 2 and § 5.2 comes from parsing the `**Claim.**` paragraph under
each `#### N.` heading in the two spine documents, stripping markdown emphasis, and
counting. No network, no vendor, no key. The proper-noun proxy is capitalised
tokens in non-sentence-initial position minus the stop list named in § 2; the
contrastive-construction count is the six patterns named in § 5.2; the risk lexicon
is the hand-audited list above, matched case-insensitively on word boundaries. The
characters-per-word figure of 5.97 includes spaces and is what converts every
vendor characters-per-minute claim into words per minute.
