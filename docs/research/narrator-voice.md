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

**A second dossier figure that does not hold up.** § 6 gives ElevenLabs as
"~$0.05-0.10 per 1K characters effective". Recomputed from the official pricing
page actually in the corpus (source 40), the real range is **$0.082 to $0.20 per
1K characters** depending on plan and model — see § 6. The dossier's own Caveats
section already warned that "several TTS price points ... were sourced partly
from third-party trackers and should be verified against official vendor pricing
pages"; this is that verification, and the low end of its range was optimistic by
roughly a factor of two.

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
