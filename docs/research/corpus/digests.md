# Research corpus — source digests

What each of the 54 sources in `../foray-research-dossier.md` actually says, in
our own words, plus the licensing verdict that decides whether its text could
ever be republished here.

Machine-readable companion: `corpus-index.json` — same content plus fetch
facts (content hashes, chunk/token counts), generated from this file by
`node tools/corpus/corpus.mjs export-index --write`. Edit this file, then
re-run that. Coverage and failures: `coverage.md`, `dead-links.md`.

## Why this file exists instead of the corpus itself

The corpus is 37MB of raw fetched bytes plus 1.1MB of cleaned markdown in
`data-local/corpus/`, which is gitignored — so it exists only on the machine
that built it, and Wyatt's checkout and the cloud runners cannot see it.

This repo is **public**. Committing the cleaned text of 54 third-party works to
a public repo is republication, not private archiving, and for most of these
works no license permits it. So we commit what we may: verifiable facts about
each source, and our own writing about what it establishes. That is the same
call this repo already made for podcast transcripts (`docs/DECISIONS.md`,
2026-08-12): **store the index, never the bodies**.

## How to read an entry

- **redistribution: allow** — a specific license permitting third-party
  redistribution was found, named in `license`, with the page it was seen on.
  Even for these, the source text is not committed today; the verdict only
  records that it could be, if the founders ever want that.
- **redistribution: deny** — no such license found. This is the default, and
  "in doubt" resolves to deny.
- **verified: web** — the license page was checked online on 2026-08-12.
  **verified: inferred** — reasoned from the source type without a live check;
  treat it as the weaker claim.

Digests and key facts are ours: written from the archived extraction, not
copied out of it. Facts — numbers, dates, holdings, API shapes — are not
copyrightable; sentences are, so the sentences here are ours. Nothing in the
legal-area digests is legal advice.

---

# Area 1 — Podcast Infrastructure

## 1. Podcast Namespace — Transcript tag

- url: https://podcasting2.org/docs/podcast-namespace/tags/transcript
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://podcasting2.org/docs/podcast-namespace/tags/transcript — Site-wide footer on this exact page reads that all content is licensed under CC BY 4.0, linking creativecommons.org/licenses/by/4.0/ with rel="license"; confirmed in the raw HTML this session.
- verified: web

A single spec page defining how an RSS item advertises machine-readable transcripts. The element is repeatable, so one episode can point at several parallel files. Two attributes are mandatory: a URL and a MIME type, with recognized types spanning plain text, HTML, WebVTT, JSON and SubRip. Two optional attributes matter for pipeline logic: a language code that falls back to the feed's own declared language, and a rel flag which, when set to captions, promises the file carries time codes regardless of what its MIME type says. For a curation product this is the cheapest possible ingest shortcut. When a publisher already ships a time-coded caption file, the pipeline can skip ASR entirely and either trust the publisher timings or run forced alignment against them, which is both faster and more accurate than transcribing from scratch. The page also tallies adoption across podcast apps, hosting tools and other services, indicating the tag is widely implemented rather than aspirational.

**Key facts**

- Element is <podcast:transcript>, parent <item>, cardinality Multiple (several transcripts per episode allowed)
- Required attributes: url and type; documented MIME types include text/plain, text/html, text/vtt, application/json, application/x-subrip
- Optional language attribute defaults to the value of the feed's RSS <language> element
- rel="captions" signals the linked file contains time codes irrespective of its declared MIME type
- Adoption tallies on the page: 33 podcast apps/services, 38 publishing/hosting tools, 11 miscellaneous

## 2. Podcast Index API (OpenAPI docs)

- url: https://podcastindex-org.github.io/docs-api/
- redistribution: allow
- license: MIT
- license-evidence: https://github.com/Podcastindex-org/docs-api/blob/master/LICENSE — GitHub licenses API for Podcastindex-org/docs-api returns spdx_id MIT with LICENSE at repo root, and this URL is that repo's GitHub Pages deployment.
- verified: web

This page is a RapiDoc-rendered OpenAPI browser (a custom element that builds its UI inside a shadow DOM after load), so the original static fetch captured only loading chrome. Recovered via a real-browser render of the narrative front matter — the prose sections, not the per-endpoint parameter/schema tables RapiDoc generates from the spec file. It establishes the shape of the API rather than the full reference: PodcastIndex.org is a free, developer-facing index maintained by Podcast Index LLC under an MIT-licensed docs repo, offering search, feed and episode lookups without requiring the caller to crawl RSS feeds directly. Authentication is an Amazon-style signed-request scheme — a free API key plus secret, with four required headers per call (User-Agent, X-Auth-Date, X-Auth-Key, Authorization) rather than a bearer token alone. The page also points at first- and third-party client libraries in a dozen-plus languages and a maintained Postman collection, both useful shortcuts for a prototype integration. The exhaustive per-endpoint schema (query parameters, response shapes for search/by-feed/by-episode/trending calls) is not captured here — that detail lives in the live rendered page or the OpenAPI spec file the docs repo publishes, not in this digest.

**Key facts**

- PodcastIndex.org API is maintained by Podcast Index LLC; the docs repository and this generated site are MIT-licensed.
- Auth scheme: register a free API key, sign each request Amazon-style, and send four required headers — User-Agent, X-Auth-Date, X-Auth-Key, Authorization.
- Client libraries are community-maintained across a dozen-plus languages/ecosystems (Java, .NET, Node.js, PHP, Python, Ruby, Swift, Kotlin, Go, and more), linked from the docs page rather than published by Podcast Index itself.
- A Postman collection and environment file are published for exploring the API without writing a signing client first.
- Endpoint-level detail (query parameters, response schemas per operation) lives only in the live rendered page / OpenAPI spec file, not in this digest or the archived capture.
- Original fetch (before 2026-08-13) captured only page-load chrome (~79 characters) because the docs render client-side; recovered via a browser capture per `tools/corpus/README.md#rendered-html-route`.

---

# Area 2 — Speech Processing

## 3. WhisperX paper (arXiv 2303.00747)

- url: https://arxiv.org/abs/2303.00747
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://arxiv.org/abs/2303.00747 — The arXiv abstract page carries a Creative Commons Attribution 4.0 license line rather than the default arXiv distribution license; verified by reading creativecommons.org/licenses/by/4.0/ out of the raw abs page HTML this session.
- verified: web

An INTERSPEECH 2023 system paper from Oxford's Visual Geometry Group describing how to make Whisper usable on hours-long recordings. The core observation is that Whisper's utterance timestamps drift badly and its buffered long-audio mode is inherently sequential, so it cannot be batched. The authors bolt three stages around the model: voice-activity detection to locate speech; a cut-and-merge step that splits over-long active regions at the point of lowest voice-activity score and then recombines neighbours up to roughly the model's 30-second training window; and forced alignment of the resulting text against an external phoneme classifier, using dynamic time warping to recover per-word start and end times. Chunk boundaries therefore land in silence rather than mid-word. Evaluation spans TED-LIUM, Kincaid46, AMI and Switchboard, reporting both word error rate and word-segmentation precision and recall at a fixed timing tolerance. For a segmentation product this is effectively the reference ingest architecture: word-accurate timing is the prerequisite for cutting clean segment boundaries, and batching makes back-catalogue transcription affordable.

**Key facts**

- Architecture: VAD pre-segmentation, min-cut and merge into ~30s chunks, batched Whisper, then wav2vec2 forced phoneme alignment via DTW
- Table 2 results: WhisperX 11.8x speed and 9.7 WER on TED-LIUM; AMI word segmentation precision 84.1 / recall 60.3; Switchboard 93.2 / 65.4
- Word-segmentation true positives scored with a 200 millisecond collar
- VAD plus batching yields roughly twelvefold speedup; batching without VAD collapses quality (78.78 WER on TED-LIUM at batch size 32)
- Default configuration: pyannote VAD (onset 0.767, offset 0.377), Whisper large-v2 greedy decoding, wav2vec2.0 BASE 960H phoneme model
- Forced-alignment overhead measured at under roughly 10% of runtime; arXiv v2 dated 11 July 2023

## 4. pyannote.audio GitHub

- url: https://github.com/pyannote/pyannote-audio
- redistribution: allow
- license: MIT
- license-evidence: https://github.com/pyannote/pyannote-audio/blob/main/LICENSE — GitHub licenses API for pyannote/pyannote-audio returns spdx_id MIT with a LICENSE file at the repository root, which governs the README that was captured.
- verified: web

README for the PyTorch-based open-source speaker diarization toolkit, now positioned alongside a commercial service from the same team. It documents two paths: an open pipeline that runs locally but is gated behind accepting model conditions on Hugging Face and supplying an access token, and a premium hosted pipeline that sends audio to the vendor's servers in exchange for an API key. Both expose the same short Python surface, where you load a pipeline, apply it to an audio file, and iterate over turn and speaker pairs carrying float start and stop times in seconds. A twelve-dataset benchmark table gives diarization error rates for the legacy pipeline, the current open one, and the premium one, plus throughput figures measured on an H100. An opt-in telemetry channel and its disable switches are documented. For a curation product the practical points are that speaker turns arrive as timestamped intervals that can be intersected with word timings to attribute segments, that the local path avoids shipping publisher audio to a third party, and that error rates on conversational material remain substantial.

**Key facts**

- MIT-licensed Python/PyTorch toolkit; pretrained pipelines and models distributed through Hugging Face
- Two pipelines: community-1 (open, runs locally, needs an HF token and accepted user conditions) and precision-2 (pyannoteAI hosted API)
- Diarization error rates as of 2025-09: AMI IHM 18.8 legacy / 17.0 community-1 / 12.9 precision-2; CALLHOME 28.5 / 26.7 / 16.6; VoxConverse v0.3 11.2 / 11.2 / 8.5
- Self-hosted throughput on an NVIDIA H100: community-1 about 31s per hour of audio on AMI IHM, precision-2 about 14s, roughly 2.2x faster
- Output shape is a sequence of (turn.start, turn.end, speaker_label) triples with times in seconds
- Telemetry is optional and controlled via the PYANNOTE_METRICS_ENABLED environment variable or Python setters

---

# Area 1 — Podcast Infrastructure

## 5. IAB Podcast Measurement Technical Guidelines v2.2

- url: https://iabtechlab.com/wp-content/uploads/2024/02/PodcastMeasurement_v2.2_pc.pdf
- redistribution: deny
- license: none-found
- license-evidence: https://iabtechlab.com/standards/podcast-measurement-guidelines/ — The standards landing page carries only an all-rights-reserved style copyright notice for IAB Technology Laboratory with no Creative Commons or redistribution grant, and the PDF's own front matter is a copyright notice plus liability and patent disclaimers rather than any license.
- verified: web

The IAB Tech Lab's public-comment draft of the technical rules defining what counts as a podcast download, aimed at publishers, hosting platforms and measurement vendors seeking certification. It prescribes a five-step server-log process (filter, apply file thresholds, aggregate uniques, generate metrics, audit) computed over either a fixed calendar day or a rolling twenty-four hour window, with the choice disclosed in a corporate methodology document. The filtering rules are where any automated client is directly implicated: tiny probe range requests are discarded outright, HEAD and not-modified responses are never counted, and partial-content responses count only when reassembled requests cover a full minute of playable content, deduplicated by address and user agent. Requests originating from data centres and cloud providers are classed as invalid traffic and filtered. The draft also separates general from sophisticated invalid traffic and deliberately withholds detection specifics for the latter. The consequence for a server-side ingest fetcher is concrete: it will be filtered out of publisher analytics rather than inflating them.

**Key facts**

- Valid download threshold: header bytes plus enough podcast content to play for one minute must have been transferred
- Measurement runs over a 24-hour window, either fixed or rolling; the method chosen must be disclosed in a document of methodology (DOM)
- HTTP handling: HEAD excluded, GET 200 counted, GET 206 counted only if the one-minute rule is met with IP/user-agent dedup, GET 304 not counted
- Two-byte range requests (Range: 0-1) used to probe byte-range support are explicitly disregarded
- Data-centre and AWS IP addresses are filtered as invalid traffic; known-safe IP inclusion lists must be re-validated at least every 90 days
- Distinguishes general invalid traffic (GIVT) from sophisticated invalid traffic (SIVT) and withholds SIVT detection specifics from the public draft; v2.2 additions include patent-diligence disclaimer language and clarification of URL-prefix versus full server-log measurement (28 pages, copyright 2024)

---

# Area 3 — Topic Segmentation

## 6. TREC 2020 Podcasts Track Overview (arXiv 2103.15953)

- url: https://arxiv.org/abs/2103.15953
- redistribution: deny
- license: arXiv.org perpetual non-exclusive license v1.0
- license-evidence: https://arxiv.org/abs/2103.15953 — The abs page shows only the default arXiv non-exclusive distribution license (link to arxiv.org/licenses/nonexclusive-distrib/1.0), which grants arXiv distribution rights and not third-party redistribution.
- verified: web

Organizers' report on the first TREC podcast evaluation, run by Spotify with Dublin City University and CLARIN. Two shared tasks ran over a corpus of roughly 100,000 English episodes shipped with audio, machine transcripts (Google STT, early 2020) and creator RSS metadata. Task one framed retrieval at sub-episode granularity: candidates are fixed two-minute windows beginning on each minute and overlapping their neighbours by a minute, yielding about 3.4 million candidates averaging some 340 words. NIST judges graded each on a five-point entry-point scale, scored primarily by mean nDCG. Task two asked for a short readable episode summary, judged against filtered creator descriptions plus manual grading. For Foray the useful result is the ablation showing transcript indexing roughly doubles retrieval quality over title-and-description indexing, and that relevance was defined as being a good place for a listener to start, not merely topical overlap. Caveats: only one team used audio at all, participation was far below registration, and the underlying dataset is no longer distributed.

**Key facts**

- Corpus: just over 100,000 English-language episodes with audio, ASR transcripts and RSS metadata; transcripts carry word timestamps at 0.1s granularity
- Segment definition produced ~3.4M two-minute overlapping candidates, average word count 340 +/- 70
- 8 training topics plus 50 test topics in three types: topical, refinding, known-item; graded Perfect/Excellent/Good/Fair/Bad
- Best submitted retrieval run 0.67 mean nDCG (UMD) vs BM25 and QL baselines at 0.52; BERT reranking baselines led on precision@10 (0.57)
- Episode-level ablation: transcript text 0.58 nDCG vs episode title+description 0.36; both combined 0.61
- Participation: 7 teams / 24 runs in retrieval, 8 teams / 22 runs in summarization; summarization ground-truth proxy was a 66,245-description filtered subset

## 7. TreeSeg (arXiv 2407.12028)

- url: https://arxiv.org/pdf/2407.12028
- redistribution: allow
- license: CC BY-SA 4.0
- license-evidence: https://arxiv.org/abs/2407.12028 — The abs page carries the CC BY-SA 4.0 license badge (icon by-sa-4.0.png) linking to creativecommons.org/licenses/by-sa/4.0/, which permits third-party redistribution with attribution and share-alike on derivatives.
- verified: web

Industry paper from Augmend proposing an unsupervised way to cut long ASR transcripts into nested topics. Rather than scanning for local similarity dips like TextTiling and its embedding-era descendants, it embeds sliding blocks of utterances (each utterance plus a fixed window of preceding ones) with an off-the-shelf embedding model, then recursively splits the timeline by minimising within-segment squared distance to segment means. Splits are chosen greedily across current leaves via a min-heap, producing a binary partition tree, so a caller can pick segmentation granularity after the fact instead of committing to a segment count up front. Evaluation covers ICSI and AMI meeting corpora plus a 21-transcript in-house set, scored with Pk and WindowDiff at each annotation depth against the ground-truth segment count. It beats BertSeg, HyperSeg and random/equidistant baselines everywhere. For Foray this is directly usable at ingest: one hyperparameter, no training, and the hierarchy maps naturally onto choosing 3-15 minute candidate clips. Limitations: results rest on one embedding model, corpora are meetings rather than podcasts, and the segment count must still be supplied.

**Key facts**

- Method: block-wise utterance embeddings (text-embedding-ada-002 in the paper) plus divisive one-dimensional clustering into a binary partition tree; single hyperparameter (block width W)
- No trainable components; minimum segment size enforced, sub-threshold segments merged forward
- Datasets: ICSI (75 annotated transcripts, up to 4 annotation levels), AMI (139 at level 1, up to 3 levels), and TinyRec, a new 21-transcript self-recorded corpus released with the paper
- Averaged Pk: 0.31 (ICSI), 0.355 (AMI), 0.367 (TinyRec) vs BertSeg 0.388 / 0.443 / 0.473 and random baseline ~0.46
- Averaged WindowDiff: 0.353 / 0.396 / 0.382 vs BertSeg 0.432 / 0.480 / 0.486
- arXiv v1 posted June 2024; stated limitations are single-embedding-model evaluation and no comparison against M3Seg (no public code)

---

# Area 4 — Retrieval & Recommendation

## 8. Spotify: Recommending Podcasts for Cold-Start Users (arXiv 2007.13287)

- url: https://arxiv.org/abs/2007.13287
- redistribution: deny
- license: arXiv.org perpetual non-exclusive license 1.0 (plus ACM copyright on the published version)
- license-evidence: https://arxiv.org/abs/2007.13287 — The arXiv abs page links to http://arxiv.org/licenses/nonexclusive-distrib/1.0/, which grants arXiv distribution rights only, and the PDF's first page carries the standard ACM notice requiring prior permission to republish or post on servers.
- verified: web

Spotify's SIGIR 2020 paper on user cold-start: infer podcast taste for a listener who has never played a podcast by transferring their music history across domains. The model is an MLP trained as extreme multi-class classification (each show is a class) with softmax plus importance-sampled negatives, fed three grades of source representation: self-reported demographics, aggregated music metadata (top artists, genres, meta-genres, micro-genres), and dense playlist co-occurrence embeddings learned word2vec-style. Data: 17M podcast-following users, 700M playlists, a catalog above 200k shows. Offline, every cross-domain variant beat popularity baselines; the cheap metadata representation matched the expensive latent embedding, so the costly playlist model largely was not worth its compute. A one-week online test on 800k podcast-naive users showed roughly 50% lifts in listening minutes and shows followed. For Foray the transferable lessons are the onboarding architecture (bootstrap taste from an adjacent signal rather than a questionnaire) and the honest caveat: Spotify owned a rich in-house music graph, and the authors themselves flag bias propagation from music into podcast recommendations.

**Key facts**

- Nazari et al., SIGIR 2020; arXiv 2007.13287 submitted 27 Jul 2020; DOI 10.1145/3397271.3401101
- Training data: 17M users following at least one podcast, mean 2.9 follows per user; ~200k users held out for test
- Music-taste embeddings: 40-dimensional track vectors from ~700M user playlists (word2vec skip-gram); metadata covers 1.3M artists, 40 genres, 3,855 micro-genres
- Offline nDCG@10: country popularity 0.12256, country+demographic popularity 0.15310, cross-domain CF 0.19029, demo+CF+metadata 0.22009
- Online A/B: 800,000 users with no podcast history, one week, ~50% more podcast minutes and >50% more shows followed vs the demographic popularity baseline
- Precision@10 upper bound is only ~0.29 because users follow 2.9 podcasts on average

---

# Area 8 — Legal / Policy Landscape

## 9. Podcast Namespace Issue #254 — DAI breaks timestamps

- url: https://github.com/Podcastindex-org/podcast-namespace/issues/254
- redistribution: deny
- license: Third-party user content — not covered by the repository license
- license-evidence: https://github.com/Podcastindex-org/podcast-namespace/issues/254 — The repository's open license covers the specification files, not issue bodies and comments, which are authored by many individual third parties under GitHub's terms and carry no redistribution grant.
- verified: inferred

GitHub issue #254 on the Podcast Namespace repository, opened 26 May 2021 by AdrianMachado (then at Facebook) and closed 4 March 2026 in a bulk cleanup that redirected old issues to Discussions. The proposal was a <podcast:dynamic-ads-adjusted> tag with an isAdjusted value of true, false, or not-applicable, so consumers could tell whether timestamped namespace data — transcripts, chapters, soundbites — still matches the delivered audio. The premise, stated flatly, is that inserting ads of varying length shifts every downstream timestamp, differently for each rendition. The thread is the authoritative technical record of offset drift: NPR noted it uses dynamic insertion for editorial content and cross-promos, not only ads; Castamatic noted the enclosure length declared in the feed rarely matches the delivered file. Alternatives floated included ID3-embedded insertion points so players could shift metadata themselves, and expressing shares as chapter-relative offsets; the recurring objection was that publishing insertion points enables ad-skipping. Two exchanges matter legally: James Cridland argued a shared clip is a transformative work of copyrighted material requiring the owner's agreement and earning the podcaster no download credit; AdrianMachado replied that Facebook capped clips at 30 seconds on a fair-use belief and upsold the full episode from every clip.

**Key facts**

- Issue #254, Podcastindex-org/podcast-namespace, opened 26 May 2021 by AdrianMachado; closed 4 March 2026 in a bulk issue cleanup.
- Proposed tag: <podcast:dynamic-ads-adjusted isAdjusted="true|false|not-applicable"> to signal whether timestamped metadata survives ad insertion.
- NPR (staceygoers) confirmed dynamic insertion is used for editorial content and cross-promos, not only advertising.
- Castamatic (francosolerio) reported the RSS enclosure length almost never matches the actually delivered file under DAI.
- James Cridland argued a shared clip is a transformative work of copyrighted material needing the rights holder's agreement, and generates no download credit for the podcaster.
- AdrianMachado stated Facebook capped clips at 30 seconds on a fair-use rationale and upsold the full episode alongside every clip.

## 10. Hunley v. Instagram (9th Cir. 2023, official opinion)

- url: https://cdn.ca9.uscourts.gov/datastore/opinions/2023/07/17/22-15293.pdf
- redistribution: allow
- license: US federal judicial opinion — no copyright
- license-evidence: https://cdn.ca9.uscourts.gov/datastore/opinions/2023/07/17/22-15293.pdf — Opinion of a US federal court served from the Ninth Circuit's own CDN; under the government edicts doctrine (Banks v. Manchester, reaffirmed in Georgia v. Public.Resource.Org, 590 U.S. 255 (2020)) judicial opinions and the court-prepared syllabus are not copyrightable, and 17 U.S.C. 105 bars copyright in federal government works — the PDF carries no publisher headnotes or annotations, only the court's own text plus a court-staff summary it labels as no part of the opinion.
- verified: web

Ninth Circuit opinion, No. 22-15293, argued 6 February 2023 and filed 17 July 2023, by Judge Bybee (panel: Bybee, Bumatay, Bennett of D. Md. by designation), on appeal from Judge Breyer in N.D. Cal. Two photographers sued Instagram for secondary infringement, alleging that letting Time and BuzzFeed embed their public posts violated their display right under 17 U.S.C. 106(5). The panel affirmed dismissal: under Perfect 10 v. Amazon, 508 F.3d 1146 (9th Cir. 2007), embedding does not display a copy because the file stays on the host's server; the Server Test is not confined to search engines; and Aereo did not overrule it. The doctrinal core is the split the panel drew explicitly. Infringing the display right requires an underlying copy, since the statute defines display as showing a copy. The performance right carries no copy requirement, which is why Aereo imposed liability without any copy analysis. The Server Test is therefore anchored to the display right and does not automatically extend to audio, which is performed rather than displayed. The panel limited its holding to embedding in its current form, and acknowledged that district courts in McGucken, Nicklen, Goldman and Leader's Institute have rejected or narrowed the test.

**Key facts**

- Hunley v. Instagram, LLC, No. 22-15293 (9th Cir.), argued 6 Feb 2023, filed 17 July 2023; opinion by Judge Bybee.
- Affirmed dismissal: embedding is not display of a copy under Perfect 10 v. Amazon, 508 F.3d 1146 (9th Cir. 2007); Server Test reaffirmed and not limited to search engines.
- The panel expressly distinguished the two rights: the display right requires an underlying copy, while the public performance right does not — which is why Aereo (573 U.S. 431 (2014)) did not disturb Perfect 10.
- The court limited the Server Test to embedding in its current technological format and declined to foreclose relief for future retransmission designs.
- It acknowledged district courts rejecting or limiting the test: McGucken v. Newsweek (S.D.N.Y. 2022), Nicklen v. Sinclair (S.D.N.Y. 2021), Goldman v. Breitbart (S.D.N.Y. 2018), Leader's Institute v. Jackson (N.D. Tex. 2017).
- Risk for a playlist-of-pointers audio model: it sits on the performance side of the line the court drew, where the Server Test provides no equivalent shelter.

## 11. Goldman v. Breitbart analysis (Loeb & Loeb)

- url: https://www.loeb.com/en/insights/publications/2018/02/goldman-v-breitbart-news-network-llc
- redistribution: deny
- license: All rights reserved (law firm publication, no license grant)
- license-evidence: https://www.loeb.com/en/insights/publications/2018/02/goldman-v-breitbart-news-network-llc — Law-firm insight article authored by named firm attorneys as client marketing; no Creative Commons badge or reuse permission appears on the page, so default copyright applies.
- verified: inferred

A law-firm client alert summarizing Goldman v. Breitbart News Network, LLC, 302 F. Supp. 3d 585 (S.D.N.Y. 2018). A photograph of Tom Brady with Celtics GM Danny Ainge, posted to the plaintiff's Snapchat in July 2016, spread to Twitter; news outlets then embedded tweets containing it, retrieving the image from Twitter's servers without storing it themselves. The court granted the photographer partial summary judgment on the display right and refused to apply the Server Test. Its reasoning rests on statutory text — public display includes transmission by any device or process, covering processes now known or later developed — and on legislative history reaching every method by which images are conveyed. Writing the embed code into the page design was itself the process. The court invoked Aereo for the proposition that technical distinctions invisible to the user should not determine liability, and distinguished Perfect 10 factually: a search engine the user navigates through differs from an image appearing unbidden on a page. Fair use, public-domain release and innocent infringement were left for later stages, with fair use described as strong. The lesson is venue-dependence: outside the Ninth Circuit, never hosting a copy may not defeat even a display-right claim.

**Key facts**

- Goldman v. Breitbart News Network, LLC, 302 F. Supp. 3d 585 (S.D.N.Y. 15 February 2018), partial summary judgment for the plaintiff.
- Court rejected the Ninth Circuit's Server Test as inconsistent with the Copyright Act's text, legislative history, and Supreme Court precedent.
- Defendants never stored the photo; browsers retrieved it from Twitter — the court held that embedding was itself a 'process' of transmission under 17 U.S.C. 101/106(5).
- Aereo was cited for rejecting form-over-function analysis: user-invisible technical distinctions should not decide liability.
- The court distinguished Perfect 10 on facts — a user-navigated search engine differs from content appearing unbidden on a page.
- Fair use, public-domain release, and innocent-infringer defenses were left open; the court called fair use a strong defense here.

---

# Area 5 — Audio Assembly & Playback

## 12. AES TD1004.1.15-10 — Loudness for streaming/network playback

- url: https://aes.org/wp-content/uploads/2024/01/AESTD1004_1_15_10.pdf
- redistribution: deny
- license: All rights reserved (AES)
- license-evidence: https://aes.org/community/technical-council/aestd1004-recommendation-for-loudness-of-audio-streaming-and-network-file-playback-2015/ — AES technical documents carry no redistribution grant; the landing page and PDF both display standard AES copyright with no Creative Commons or reuse mark.
- verified: web

Recovered: the original URL 301-redirected into a 404 because AES restructured its technical-document tree in 2024; the PDF now lives under `aes.org/wp-content/uploads/`, linked from a landing page that itself states this document "was superseded by AES TD1008 ... published on September 24, 2021" — so this is a 2015 recommendation AES itself now points past, not the association's current guidance. With that caveat, TD1004 (edited by Bob Katz for the AES Study Group on Streaming Loudness) is the source of the -16 to -20 LUFS target range the dossier cites: it defines target loudness as the desired level for a stream in LUFS, distinguishes it from *absolute* loudness (measured in LUFS relative to full scale) and *relative* loudness (measured in LU relative to a reference), and states the core motivation plainly — mismatched levels between a streamed track and surrounding content, or between a streamed asset and inserted material, are audible as jarring jumps that TD1004 exists to prevent. For Foray this is the primary-document backing for normalizing every stitched segment (and any AI-narrated bridge) to a common target before assembly, rather than trusting individual publishers' mastering levels.

**Key facts**

- Superseded: the AES landing page states TD1004 "was superseded by AES TD1008 ... published on September 24, 2021" — TD1008 is the association's current recommendation; TD1004 is retained as the historical 2015 document.
- Defines target loudness as the desired/intended loudness of a stream, expressed in LUFS, and separately defines absolute loudness (LUFS relative to full scale) versus relative loudness (LU relative to a reference level).
- States the document's core rationale in its own terms: loudness mismatches between a stream and surrounding content, or where external material is spliced in, are perceived as jarring jumps — the reason per-segment/per-track normalization matters.
- Archived PDF is 10 pages, edited by Bob Katz for the AES Study Group on Streaming Loudness, originally published October 19, 2015 (Version 1.0).
- Companion overview page (source 36, `aes.org/resources/audio-topics/loudness-project/loudness-normalization/`) cites TD1008's newer numeric targets rather than TD1004's; the two documents should not be conflated when citing a specific LUFS figure.

## 13. Apple AVFoundation Editing Guide

- url: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/AVFoundationPG/Articles/03_Editing.html
- redistribution: deny
- license: All rights reserved
- license-evidence: https://www.apple.com/legal/internet-services/terms/site.html — Apple's website Terms of Use state that no part of the site and no content may be copied, reproduced, republished, posted, transmitted or distributed to any other server or website without Apple's express prior written consent; no such consent exists here.
- verified: web

This is the archived AVFoundation Programming Guide chapter on editing, and it is the canonical description of how Apple expects an app to assemble one timeline out of several separate media assets. The model it lays out is: a composition is a container of tracks; you add one mutable track per media type and then insert time ranges from source asset tracks into that track at explicit times, which is precisely the operation Foray needs to place a sequence of podcast segments (and AI-narrated bridges) end to end without re-encoding or rehosting the source audio. The guide is explicit that you should keep one composition track per media type where possible, and that same-type material presented serially belongs on the same track. Alongside that it covers the audio-processing layer, which is where per-source gain lives, and the export path that flattens a composition plus its mix into a file. Most of the chapter is video-oriented (orientation transforms, render size, frame duration, Core Animation overlays); the audio-relevant portion is a smaller slice. Note it is an archived document, so class-level detail should be re-confirmed against current AVFoundation reference docs before implementation.

**Key facts**

- AVMutableComposition holds AVMutableCompositionTrack objects; tracks are created with addMutableTrackWithMediaType and a preferred track ID, and kCMPersistentTrackID_Invalid auto-assigns a unique ID.
- Segments are placed by calling insertTimeRange:ofTrack:atTime:error: on a composition track, so sequential concatenation is expressed as explicit CMTime offsets rather than a playlist.
- AVMutableAudioMix carries AVMutableAudioMixInputParameters per track; documented audio capability is limited to a maximum volume and volume ramps (setVolumeRampFromStartVolume:toEndVolume:timeRange:) -- no LUFS-aware loudness processing.
- mutableTrackCompatibleWithTrack: lets you query an existing composition track for compatibility, and Apple advises unifying compatible asset tracks onto one track to minimize resource usage.
- AVAssetExportSession takes the composition plus an audioMix and/or videoComposition to render an output file; it exposes shouldOptimizeForNetworkUse and an async completion handler.
- Archived Apple documentation: samples are Objective-C and reference deprecated APIs such as ALAssetsLibrary and UIAlertView.

---

# Area 6 — TTS & AI Narration

## 14. NotebookLM Audio Overviews (Google blog)

- url: https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews/
- redistribution: deny
- license: All rights reserved
- license-evidence: https://policies.google.com/terms — Google's Terms of Service state that Google retains the intellectual property rights in its own content and grant no Creative Commons or general redistribution license; blog.google posts carry no separate open-license mark.
- verified: web

Google's launch post for NotebookLM Audio Overviews, dated September 11, 2024 and written by a Google Labs product manager. It announces a one-click feature that turns a user's uploaded sources -- documents, slides, charts, web URLs -- into a two-host synthetic conversation that summarizes the material, draws connections across it and can be downloaded for offline listening. For Foray this is the most prominent shipped precedent for AI-narrated audio built on top of someone else's source material, and it is most useful as a model for framing and disclosure rather than for engineering detail: Google states plainly that the generated discussion reflects only the uploaded sources and is not a comprehensive or objective account of the topic, and it enumerates the feature's limitations in the launch post itself rather than burying them. The named limitations are directly relevant to interstitial generation at scale -- generation latency measured in minutes for large inputs, English-only hosts, occasional inaccuracies, and no ability to interrupt the hosts. The capture is the complete launch post (recovered via a browser render per `tools/corpus/README.md#rendered-html-route`, replacing an earlier partial static-fetch extraction); it still contains no usage statistics and no technical description of the generation stack, because the post itself never discloses either.

**Key facts**

- Audio Overviews launched September 11, 2024, generating a two-host synthetic discussion from a user's uploaded NotebookLM sources with one click; output is downloadable.
- Google's stated caveat in the post: the generated discussion reflects only the uploaded sources and is not a comprehensive or objective view of the topic -- a usable template for interstitial disclosure copy.
- Enumerated limitations at launch: generation can take several minutes for large notebooks, hosts speak English only, they sometimes introduce inaccuracies, and the listener cannot interrupt them.
- NotebookLM's surrounding features were built on Gemini 1.5 multimodal capabilities; the post states user data is not used to train NotebookLM.
- The post gives no pricing, no API, no latency figures beyond several minutes, and no detail on the TTS or dialogue-generation stack.
- Extraction is thin (one chunk) and is the September 2024 launch post only -- later usage statistics attributed to this feature are not in the captured text.

---

# Area 2 — Speech Processing

## 15. Chromaprint / AcoustID (official)

- url: https://acoustid.org/chromaprint
- redistribution: deny
- license: none-found
- license-evidence: https://acoustid.org/chromaprint — Fetched the page this session and searched its markup for any Creative Commons link, license statement or copyright line and found none; the footer only credits the author and host, so there is no grant permitting third-party republication of the page text.
- verified: web

The project's official landing page for the fingerprinting library underpinning AcoustID. It is a distribution and integration page rather than an algorithm description: current release number and dated source tarball, prebuilt command-line binaries for Linux, macOS and Windows across several architectures, build instructions requiring a C++ toolchain and CMake, and pointers to the Python binding. The most operationally important statement is a scoping limitation. The library consumes only raw uncompressed samples and performs no container or codec handling whatsoever, so any caller must supply its own decoding layer; the page recommends the bundled command-line utility with JSON output as the simplest path for callers that only need fingerprints. For a product trying to realign timestamps after ad insertion shifts them, this defines the shape of the component: decode a short window of episode audio, fingerprint it, compare. It also flags a real cost, since a full decode dependency sits in front of any fingerprint-based offset recovery.

**Key facts**

- Chromaprint is the fingerprint-extraction library behind AcoustID; latest release listed as 1.6.1, dated 2026-07-28
- Exposes a C API declared in chromaprint.h; accepts only raw uncompressed audio and does no file-format or codec handling
- The fpcalc utility emits JSON and is the recommended integration route when only fingerprints are needed; FFmpeg is required to build it
- Prebuilt fpcalc binaries published for linux-arm64, linux-x86_64, macos-arm64, macos-x86_64, macos-universal and windows-x86_64
- pyacoustid provides a Python wrapper plus higher-level file-to-fingerprint helpers
- Building the library requires a C++ compiler and CMake

---

# Area 1 — Podcast Infrastructure

## 16. Podcast Namespace — Chapters tag

- url: https://podcasting2.org/docs/podcast-namespace/tags/chapters
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://podcasting2.org/docs/podcast-namespace/tags/chapters — Same site-wide podcasting2.org footer grant observed on this page's sibling: all content licensed under CC BY 4.0 with a rel="license" link to creativecommons.org/licenses/by/4.0/, confirmed in raw HTML this session.
- verified: web

Spec page for the element that points an episode at an externally hosted chapter file. Cardinality is one per item, unlike the transcript element, and both attributes are required: the file location and its MIME type, with a JSON-flavoured type preferred. The rationale section is the genuinely useful part. Keeping chapters in a side file rather than embedded in audio metadata frames means they can be corrected after publication without re-encoding the enclosure, they can be rendered by clients that cannot read embedded tags at all (browsers in particular), and chapter artwork can be fetched lazily at playback instead of inflating the audio file. The data model is described as compatible with conventional embedded chapter tags, so publishers incur no extra authoring work. For a segmentation product, publisher-supplied chapters are free, human-authored topic boundaries that can seed or validate automatic segmentation, and the adoption counts on the page suggest a meaningful minority of shows already ship them.

**Key facts**

- Element is <podcast:chapters>, parent <item>, cardinality Single (one chapters file per episode)
- Required attributes: url and type; preferred MIME type is application/json+chapters
- Chapter data lives in an external file, so it is editable after publication without touching the audio
- Stated benefits: rendering by clients with no ID3 access such as web browsers, and images retrieved at playback rather than embedded in the enclosure
- Data model described as compatible with normal ID3 chapter tags, requiring no extra publisher work
- Adoption tallies on the page: 34 podcast apps/services, 25 publishing/hosting tools, 11 miscellaneous

## 17. Podcast Namespace GitHub repo

- url: https://github.com/Podcastindex-org/podcast-namespace
- redistribution: allow
- license: CC0-1.0
- license-evidence: https://github.com/Podcastindex-org/podcast-namespace/blob/main/COPYING.txt — GitHub licenses API returns spdx_id CC0-1.0 pointing at COPYING.txt, and the captured README itself states the namespace is dedicated to the public domain using CC0 v1.0.
- verified: web

Top-level README for the community-run RSS namespace maintained by the Podcasting 2.0 project. It sets out governance more than syntax. Tags advance through numbered comment phases; adoption requires either demonstrated real-world usage or a commitment from at least one hosting company and one app; nothing is adopted while open questions remain, and delaying a tag to a later phase is treated as the normal, encouraged outcome. The project explicitly disclaims standards-body status and cites Dave Winer's rules for standards makers as its philosophy. Stated design goals are eliminating redundancy across competing podcast namespaces, keeping required tags and attributes minimal, and preserving existing conventions rather than reinventing them. The README enumerates every formalized element by phase. Two things matter for a curation product. First, the namespace is dedicated to the public domain, which removes licensing friction from building on it. Second, the element list includes a soundbite tag beside transcript and chapters, meaning some publishers already declare sanctioned excerpt ranges in the feed itself.

**Key facts**

- The namespace is dedicated to the public domain under CC0 v1.0, recorded in the repository's COPYING.txt
- Adoption bar: consensus on usefulness plus commitment from at least one host and one app, or recognition that a tag is already used in the wild
- Phase timeline runs from Phase 1 (comment closed 2020-11-15, 5 tags) through Phase 7 (closed 2024-07-01, 2 tags); Phase 8 is open
- Formalized elements include podcast:transcript, podcast:chapters, podcast:soundbite, podcast:person, podcast:season, podcast:guid, podcast:alternateEnclosure and podcast:liveItem
- podcast:images is marked DEPRECATED in the element list
- Project self-describes as a community-driven open-source effort rather than a standards body, with discussion on podcastindex.social

## 18. IAB Podcast Technical Measurement Guidelines v2.3 (public comment)

- url: https://podnews.net/press-release/iab-tech-lab-v23-public
- redistribution: deny
- license: none-found
- license-evidence: https://podnews.net/press-release/iab-tech-lab-v23-public — The page carries a Podnews LLC copyright notice (2017-2026) in both the footer and its structured-data copyrightNotice field, with no open license; the underlying text is also a third-party IAB Tech Lab press release that Podnews states it may edit.
- verified: web

A press release, republished by a podcast-industry newsletter, announcing that IAB Tech Lab opened version 2.3 of its podcast measurement guidelines for public comment in July 2026, with a thirty-day window. The substance is a change list rather than the standard itself. Terminology moves away from framing the counted party as a listener toward a consumer-oriented term, and new guidance covers URL-prefix measurement, changes to enclosure URLs in feeds, invalid-traffic considerations, and how the different measurement-window approaches should be applied. It also signals a roadmap, with a 3.0 revision aimed at streaming video podcasts planned for the following year. The release restates the structural fact underlying the entire framework: measurement rests on server-side log analysis because podcast clients generally do not report playback back to publishers. For a curation product this dates the current standards baseline and confirms that enclosure-URL churn is now a recognised measurement problem, which is simultaneously an ingest problem for stored episode references.

**Key facts**

- IAB Tech Lab announced Podcast Technical Measurement Guidelines v2.3 on 21 July 2026, open for public comment 30 days until 19 August 2026
- v2.3 changes terminology from listener to podcast consumer
- New guidance covers URL prefix measurement, RSS enclosure URL changes, invalid traffic considerations, and measurement window approaches
- A v3.0 focused on streaming video podcasts is in development by the Podcast Technical Working Group, targeted at 2027
- Stated rationale: most podcast applications still offer no client-side playback confirmation, so server-side log data remains the basis of measurement
- Quoted participants include IAB Tech Lab CEO Anthony Katsur, Hugo Martel of Triton Digital, and Robert Freeland of Podtrac

## 19. Dynamic Ad Insertion mechanics (Castos)

- url: https://castos.com/dynamic-ad-insertion-for-podcasts/
- redistribution: deny
- license: none-found
- license-evidence: https://castos.com/dynamic-ad-insertion-for-podcasts/ — Page footer reads as a Castos, Inc. 2026 copyright with all rights reserved and no open license anywhere in the markup; it is a company marketing blog post.
- verified: web

A vendor explainer covering how dynamic ad insertion works and why publishers adopt it. It distinguishes two delivery mechanisms: pre-rendered episode variants selected per request by a decision engine keyed on signals like geography, cookies and link parameters, versus true request-time stitching where the creative is assembled into the delivered file as the download is served. The piece is commercially motivated and lists the author's own product beside competing platforms, but its drawbacks section contains the fact a segment-boundary product needs. Because inserted creatives differ in length between listeners, a byte or time position in one listener's file does not correspond to the same content in another's, and the article gives a worked example where the same moment lands about twenty-two seconds apart for two people. That is the offset-drift problem stated plainly by an industry participant. It also asserts dynamic delivery has long since become dominant, so drift cannot be treated as an edge case affecting a small slice of the catalogue.

**Key facts**

- Two DAI mechanisms described: multiple pre-stitched episode versions selected by a decision engine, and real-time stitching at download
- Ads can be placed pre-roll, mid-roll or post-roll, and can be inserted into back-catalogue episodes long after publication
- Worked drift example: a moment occurring at 15 minutes 35 seconds for one listener occurs at 15 minutes 57 seconds for another, a 22 second shift
- Cites an IAB study putting dynamic ads at almost 42% of podcast ads as far back as 2017, with dominance since
- Named DAI platforms: Castos Ads and Campaigns, Art19, Podbean, Megaphone
- Notes NPR has used dynamic ad insertion since at least 2008

---

# Area 2 — Speech Processing

## 20. WhisperX GitHub

- url: https://github.com/m-bain/whisperx
- redistribution: allow
- license: BSD-2-Clause
- license-evidence: https://github.com/m-bain/whisperX/blob/main/LICENSE — GitHub licenses API returns spdx_id BSD-2-Clause and the raw LICENSE file opens with a BSD 2-Clause header copyright Max Bain 2024, permitting redistribution with notice retention.
- verified: web

The reference implementation README for the system described in the WhisperX paper, and the more practically useful of the two artifacts for actually building an ingest pipeline. It documents the runtime rather than the method: install from PyPI, a CUDA toolkit prerequisite for GPU use, a faster-whisper and CTranslate2 backend that fits the large model into modest VRAM at a moderate beam size, and a CPU fallback via integer compute. The three-stage Python surface is spelled out explicitly, namely batched transcription, loading a language-specific alignment model and aligning, then running diarization and assigning speaker labels onto individual words. Alignment models are language-specific, with defaults for a handful of languages and Hugging Face fallbacks beyond them. The limitations section is the honest part and directly bounds what a product can promise: tokens outside the alignment model's character inventory receive no timing at all, overlapping speech is handled poorly, and the maintainer describes diarization as far from perfect.

**Key facts**

- BSD 2-Clause licensed; claims roughly 70x realtime transcription using Whisper large-v2 with batched inference
- Pipeline stages: batched Whisper transcription, wav2vec2 forced alignment, pyannote diarization, then word-level speaker assignment
- Requires CUDA toolkit 12.8 for GPU acceleration; large-v2 needs under 8GB GPU memory at beam_size=5; CPU path via --compute_type int8 --device cpu
- Diarization uses the pyannote speaker-diarization-community-1 model and requires a Hugging Face read token plus accepted user agreement
- Default alignment models provided for en, fr, de, es, it via torchaudio pipelines, with many other languages via Hugging Face
- Documented limitations: tokens lacking characters in the alignment dictionary (e.g. numerals, currency amounts) get no timestamps, and overlapping speech and diarization quality are weak; runs with condition_on_prev_text False and without timestamps during batching to curb hallucination

## 21. MURMUR: Efficient Inference for Long-Form ASR (arXiv 2606.01483)

- url: https://arxiv.org/pdf/2606.01483
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://arxiv.org/abs/2606.01483 — The arXiv abstract page for 2606.01483 carries a Creative Commons Attribution 4.0 license line rather than the default arXiv distribution license; verified by reading creativecommons.org/licenses/by/4.0/ out of the raw abs page HTML this session.
- verified: web

A 2026 systems paper from the University of Washington arguing that the chunk-based approach to long-form speech recognition, with WhisperX as the named exemplar, trades accuracy for latency, while newer single-pass long-context speech models invert that trade. The authors measure both on meeting audio and show the gap is large in each direction: the chunked pipeline is roughly an order of magnitude faster but substantially worse on a metric that jointly penalises transcription errors, speaker misattribution and timing drift. Their system keeps chunking but treats chunk length as a tunable parameter rather than pinning it to the model's input window, finding an intermediate value that recovers most of the accuracy, then adds a sliding-window cache eviction policy exploiting the finding that speech tokens are extremely sparse in attention. For a curation product the value is an independent, current baseline: it quantifies what chunked pipelines actually cost in speaker and boundary quality, and shows one knob buys much of that back before changing models.

**Key facts**

- Reported on AMI-IHM: WhisperX at 22.5% WER, 23.6% DER, 35.5% tcpWER and 38.8s latency, versus single-pass VibeVoice-ASR at 19.2% / 9.4% / 25.7% / 370.7s
- MURMUR matches single-pass accuracy while cutting latency 4.2x; speech-token eviction adds further gains at under 1% relative tcpWER degradation
- Identifies a 300 second chunk size as the accuracy/latency balance point, versus the roughly 30 second windows used by chunk-based pipelines
- Attention sparsity finding: fewer than 25% of speech tokens retain 99% of total attention weight on 24 of 28 layers
- Primary metric is tcpWER (time-constrained minimum-permutation WER); evaluated on AMI, TED-LIUM 3 and Earnings21
- arXiv 2606.01483, submitted 31 May 2026; code released at github.com/uw-syfi/Murmur

## 22. How Chromaprint works (creator blog)

- url: https://oxygene.sk/2011/01/how-does-chromaprint-work/
- redistribution: deny
- license: none-found
- license-evidence: https://oxygene.sk/2011/01/how-does-chromaprint-work/ — Fetched the post this session; neither the page nor its footer states any copyright notice, Creative Commons license or terms of use, so there is no affirmative grant permitting republication and default all-rights-reserved copyright applies.
- verified: web

The library author's own walkthrough of how the fingerprint is computed, and the only place the pipeline is laid out end to end. Audio is downsampled and converted into a spectrogram by short-time Fourier transform, then frequency content is folded into twelve pitch-class bins so octave information is discarded and only note identity survives, a representation the author credits to earlier music-retrieval work. That image is then compressed: a small window slides across it one column at a time, a fixed set of learned filters compares summed intensity across regions of each sub-image, and each filter output is quantised to two bits, packing sixteen filters into a single 32-bit integer per window position. Fingerprints are compared by bit error rate. Robustness is illustrated with lossy-codec and instrumental-version examples. For an offset-realignment use case the limits are visible in the design itself: the representation is pitch-oriented and tuned for near-identical music matching, so applying it to short spoken passages is an adaptation rather than a drop-in use.

**Key facts**

- Input is resampled to 11025 Hz; STFT frame size is 4096 samples (about 0.371 seconds) with 2/3 overlap
- Spectrogram frequencies are folded into 12 chroma bins representing note classes, discarding octave information
- A 16x12 sliding window with 16 filters, each quantised to 2 bits via Gray code, yields one 32-bit sub-fingerprint per window position
- Filters and their quantisation coefficients were chosen by a machine learning algorithm over a training set of audio files
- Fingerprints are compared by bit error rate; FLAC versus 32 kbps MP3 of the same track differ far less than two different tracks
- Design derives from the Computer Vision for Music Identification work plus a pairwise-boosted audio fingerprint paper; post dated January 2011

---

# Area 3 — Topic Segmentation

## 23. TREC Podcasts Track site

- url: https://trecpodcasts.github.io/
- redistribution: deny
- license: none stated
- license-evidence: https://github.com/trecpodcasts/trecpodcasts.github.io — The GitHub Pages source repo has no LICENSE file and GitHub's About sidebar lists no license, and the site itself carries no license statement, so no redistribution grant exists.
- verified: web

The organizers' landing page for the TREC Podcasts Track, hosted on GitHub Pages. It is short but operationally dense: it states the track ran in 2020 and 2021, did not run in 2022, and that the Spotify English podcast dataset behind it stopped accepting access requests in December 2023, which means the benchmark is effectively unreproducible from scratch today. It gives the precise segment definition used for retrieval (two-minute chunks starting on the minute), the five-point relevance scale NIST assessors applied while consulting both transcript and audio, and the evolution of query types: 2020 used topical, known-item and refinding queries, while 2021 folded the latter two together and added non-topical intents like wanting something entertaining, opinionated, or discussion-heavy. It also states the summarization objective, framed as a snippet a listener reads while deciding whether to press play. Crucially it links the still-downloadable evaluation artifacts: topic files and qrels for 2020 train, 2020 test and 2021 test.

**Key facts**

- Track ran 2020 and 2021; skipped 2022; the Spotify dataset is unmaintained and closed to new access requests as of December 2023
- Segment unit: two-minute chunk starting on the minute; judged on Perfect/Excellent/Good/Fair/Bad, with Perfect reserved for target-item queries
- 2020 query types: topical, known-item, refinding; 2021 merged known-item and refinding and added entertaining / opinionated / discussion intents
- Downloadable artifacts remain: topics XML for queries 1-8 (train), 9-58 (2020 test), 59-108 (2021 test), plus matching qrels lists
- Summarization judged both by NIST assessors on a four-point scale and by ROUGE against creator-written episode descriptions
- Organizing team was predominantly Spotify, with Dublin City University and CLARIN ERIC

## 24. Spotify at TREC 2020: Segment Retrieval (NIST)

- url: https://trec.nist.gov/pubs/trec29/papers/Spotify.P.pdf
- redistribution: deny
- license: none stated (author copyright retained)
- license-evidence: https://trec.nist.gov/pubs/trec29/trec2020.html — The TREC 2020 proceedings index carries only a NIST disclaimer about endorsement and author opinions, with no copyright assignment or redistribution grant for the participant papers, which remain the corporate authors' work.
- verified: web

Spotify's own notebook paper describing the baseline and experimental retrieval systems it contributed to the 2020 podcast segment task. The stack is conventional and reproducible: Pyserini over Anserini/Lucene for BM25 and query-likelihood first-stage retrieval on transcript-only and transcript-plus-metadata indexes, then a BERT-large cross-encoder pretrained on MS MARCO reranking the top fifty candidates. The interesting part is three attempts at domain adaptation, all of which essentially failed to beat the untuned reranker: crowdsourced relevance labels on thirty extra development topics, synthetic query generation with docTTTTTquery over retrieved segments, and weak supervision derived from cleaned episode titles and descriptions. The authors attribute the flat results to a shallow rerank depth and a naive negative-sampling scheme. For Foray the takeaways are practical: neural reranking gives a large lift over lexical retrieval alone, verbose query descriptions do not raise the mean but do reduce variance across hard queries, and cheap synthetic fine-tuning is not a free win.

**Key facts**

- First stage: BM25 (k=0.9, b=0.4) and query likelihood (Dirichlet mu=1000) via Pyserini/Anserini with Porter stemming; top 1000 passages per topic
- Reranker: BERT-LARGE binary classifier fine-tuned on MS MARCO (400M triples), query truncated to 128 tokens, pair capped at 512 tokens, rerank depth 50
- Test results (50 topics): BM25 nDCG@20 0.386, QL 0.380, RERANK-QUERY 0.469, RERANK-DESC 0.469, best fine-tuned run BERT-DESC-S 0.473
- Fine-tuning data: 919 crowdsourced Excellent/Good/Fair/Bad labels over 30 new topics; docTTTTTquery synthetic questions (5 per segment); ~100K title/description-derived examples
- Document-level ablation: transcript 0.58 nDCG vs episode title 0.22 and title+description 0.36; transcript plus metadata 0.61
- Same segment definition as the track: 3.4M two-minute overlapping segments, average 340 +/- 70 words; NIST annotation depth 20

## 25. Recent Trends in Linear Text Segmentation: A Survey (ACL 2024)

- url: https://aclanthology.org/2024.findings-emnlp.174.pdf
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://aclanthology.org/2024.findings-emnlp.174/ — The ACL Anthology landing page shows the CC BY 4.0 badge linking to creativecommons.org/licenses/by/4.0/ and states that materials published in or after 2016 carry that license.
- verified: web

A current literature map of linear topic segmentation from Queen Mary University of London with a BBC R&D co-author, covering the arc from counting-based sliding windows through supervised transformers to early LLM prompting. It organizes the field by basic unit (word, sentence, speaker turn), then by approach family, and supplies two comparison tables that put published Pk numbers for representative systems side by side on written-text and dialogue benchmarks. Its most useful contribution for a builder is diagnostic rather than algorithmic: it argues the field has no agreed benchmark, that reported numbers rarely transfer to real deployments, that supervised systems may be memorizing domain-specific cue phrases rather than learning coherence, and that the dominant metric is known to be flawed yet still crowds out newer alternatives. It also flags spoken and media-domain data as the thinnest resource area and explicitly names podcast segmentation as a place new resources are needed. Limitations it declares: no multimodal, graph-based, or niche-domain coverage, and an English-centric view.

**Key facts**

- Published as Findings of EMNLP 2024, pages 3084-3095, November 2024
- Dataset table spans choi (920 docs), wiki-727k (727,746 docs), en_city (19,500), en_disease (3,600), ICSI (25), QMSUM (232), SuperDialSeg (9,468), Non-News BBC (54)
- Written-text Pk comparison: TextTiling 44 and C99 12 on Choi vs supervised Cross-segment BERT 0.04; on wiki-727k, TextSeg 22.13 vs Longformer+TSSP+CSSL 13.89
- Dialogue Pk comparison: TextTiling 38.2 on ICSI; on SuperDialSeg, TextTiling 44.1, TextTiling+BERT 49.9, zero-shot ChatGPT 31.8, supervised TextSeg 19.9
- Metric usage survey of post-2020 papers: Pk in 15 works, F1 in 11, WindowDiff in 5, Boundary Similarity in 3, SegReFree in 2
- Named open challenges: no standard benchmark dataset, documented flaws in Pk, and poor cross-domain generalizability of supervised models

## 26. SEGBOT (IJCAI 2018)

- url: https://www.ijcai.org/proceedings/2018/0579.pdf
- redistribution: deny
- license: none stated
- license-evidence: https://www.ijcai.org/proceedings/2018/579 — The IJCAI proceedings page for this paper shows no license terms at all, only a site-wide IJCAI copyright footer, so there is no open grant permitting third-party redistribution.
- verified: web

An NTU Singapore paper recasting text segmentation as sequence prediction with a pointer network instead of per-position boundary tagging. A bidirectional GRU encodes the input units; a unidirectional GRU decoder, fed the current segment's start unit, attends over remaining positions and points directly at the next boundary. That framing sidesteps two problems the authors identify with tagging approaches: boundary labels are extremely sparse, and the set of legal outputs changes with input length. The same architecture handles both granularities, with sentences as units for topic segmentation and words as units for discourse-unit segmentation, using pretrained embeddings and teacher forcing during training. Results are strong on both tasks. The catch for Foray is the evaluation data: the topic-segmentation benchmark is synthetic, built by concatenating unrelated document excerpts, so boundaries are lexically obvious in a way real conversational audio never is, and the model is supervised, requiring labeled boundaries in whatever domain you deploy it. Treat the near-zero error rate as a ceiling artifact, not a transfer estimate.

**Key facts**

- Architecture: bidirectional GRU encoder plus GRU decoder with a pointer/attention mechanism; GloVe 300d word vectors (kept frozen) and Arora et al. sentence embeddings; trained with teacher forcing and Adam
- Topic segmentation benchmark: Choi dataset, 700 documents each concatenating 10 excerpts from the Brown corpus
- Choi results (Pk %, lower is better): SEGBOT 0.33 and 0.11 in the two comparison groups vs TopicTiling 0.88, BiLSTM-CRF 0.67, C99 10.50, TextTiling 45.25
- Reported relative Pk reductions: 87.5% over TopicTiling and 83.6% over BiLSTM-CRF (p < 0.01)
- EDU segmentation on RST-DT (347 train articles / 38 test articles): F-score 92.2 vs F&R 90.5, DS 90.1, BiLSTM-CRF 88.5
- Freezing GloVe vectors beat fine-tuning them (F-score 92.2 vs 87.9); published at IJCAI-18, pages 4166 onward

## 27. Spotify: What Makes a Good Podcast Summary?

- url: https://research.atspotify.com/publications/what-makes-a-good-podcast-summary
- redistribution: deny
- license: proprietary, (c) Spotify AB
- license-evidence: https://research.atspotify.com/publications/what-makes-a-good-podcast-summary — The page footer reads copyright Spotify AB with standard Terms of Use and no open license, and the full text sits behind an ACM Digital Library DOI.
- verified: web

This is a publication landing page on Spotify's research site, not the paper itself; the extraction contains only the abstract and a link out to the ACM Digital Library version. The abstract describes a study that reuses the TREC 2020 podcast summarization outputs, pairing summaries generated by many different participant systems with the human quality judgments collected during that evaluation, then measuring how well automatic metrics agree with those judgments and what linguistic properties characterize summaries humans rated highly. The premise is that podcasts differ enough from news, the domain most summarization metrics were validated on, that the qualities of a good podcast summary are not yet established. For Foray this is a pointer to prior work on judging generated text about podcast content, which is the same evaluation problem as scoring segment bridges or hooks. Because only the abstract was captured, the actual correlation figures, metric list, and per-metric conclusions are not available from this source and would have to be read at the ACM version.

**Key facts**

- Landing page only: the captured extraction is the abstract plus an outbound link, roughly 1KB of text, not the full paper
- Full paper is hosted at ACM Digital Library, DOI 10.1145/3477495.3531802
- Study reuses summaries from multiple algorithms plus human quality judgments collected in the TREC 2020 Podcasts Track
- Research question: correlation between automatic summarization metrics and human judgments, plus linguistic traits of highly-rated summaries
- Framing claim: podcasts differ from news and other commonly studied summarization domains, so metric validity does not automatically transfer

## 28. Spotify: Genre-Aware Abstractive Podcast Summarization (arXiv 2104.03343)

- url: https://arxiv.org/abs/2104.03343
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://arxiv.org/abs/2104.03343 — The abs page shows the Creative Commons Attribution 4.0 International badge linking to creativecommons.org/licenses/by/4.0/, which permits redistribution with attribution.
- verified: web

Spotify's summarization entry to the same 2020 TREC podcast evaluation, arguing that summary style should follow show genre. Starting from BART already fine-tuned on news, the team continued training on filtered podcast transcripts, then tried two variants. The category-aware model simply prepends the show's iTunes-derived category labels to the transcript as special tokens, letting the decoder condition on genre; the second variant runs a TextRank-like extractive pass biased toward named-entity-dense chunks before abstractive generation. Genre conditioning worked and the extract-then-abstract pipeline did not: discontinuous extracted spans produced less coherent and more hallucinated output. The evaluation is instructive for anyone building generated copy over podcasts, because ROUGE against creator descriptions and NIST human grading disagree in places, and the human scores show the best model matched or beat the creators' own descriptions. Two limitations matter for Foray: the model reads only the first 1024 tokens of an episode, and the whole approach is supervised on creator descriptions, which are marketing copy rather than neutral summaries.

**Key facts**

- Base model: BART-large fine-tuned from the CNN/Daily Mail checkpoint; input capped at 1024 transcript tokens, output constrained to 50-250 tokens
- Data: Spotify Podcast Dataset of 105,360 episodes filtered to 90,055; 88,055 used for training; official test set 1,027 episodes, 179 human-judged
- Category conditioning used 22 collapsed iTunes/RSS genre labels prepended as special tokens
- Human aggregate quality score: category-aware-2epochs 1.58 vs bartpodcasts baseline 1.49 and cleaned creator descriptions 1.49 (a 9% improvement); bartcnn 0.99, coarse2fine 1.30
- ROUGE-L F1 on the full test set: category-aware-2epochs 18.42, category-aware-1epoch 17.62, bartpodcasts 16.64, coarse2fine 13.59, bartcnn 11.30
- The named-entity-biased coarse2fine pipeline (top 7 segments by text centrality plus top 3 by entity centrality, ~60s each) raised entity counts but hurt coherence and induced hallucination

---

# Area 4 — Retrieval & Recommendation

## 29. Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009)

- url: https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
- redistribution: deny
- license: ACM copyright (2009), all rights reserved
- license-evidence: https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf — The PDF's own first-page notice states the 2009 ACM copyright and requires prior specific permission or a fee to republish or post on servers; the author's personal page hosting it is not a grant to third parties, and the ACM Digital Library record returned HTTP 403 when checked.
- verified: inferred

The two-page SIGIR 2009 note that gave hybrid search its default fusion rule. The authors wanted an untrained baseline against which to measure learning-to-rank methods and found the baseline kept winning. Their rule ignores the raw scores each retriever emits and sums reciprocals of rank position, damped by a constant, so a BM25 score and a cosine similarity never have to be made commensurable. Validation runs on four TREC collections plus submitted TREC participant runs and the LETOR 3 learning-to-rank corpus show it beating Condorcet Fuse, CombMNZ, and the best single input system by roughly four to five percent MAP, with sign tests establishing significance. For Foray this is the citation behind the fusion step every vector database ships, and the reason a lexical index over segment text and a dense index over segment embeddings can be merged with no tuning and no score normalization. Caveats worth carrying: gains are modest, one TREC run with a human in the loop still beat it, and CombMNZ narrowly edged it on LETOR.

**Key facts**

- Fusion score for a document is the sum over input rankings of 1/(k + rank), with k = 60
- k = 60 was chosen in a pilot and never retuned; pilot MAP is flat from k=10 (.2123) to k=100 (.2142), degrading at k=0 (.2072) and k=500 (.2098)
- TREC MAP: Robust .3686, TREC 3 .4350, TREC 5 .3394, TREC 9 .2830 — beating Condorcet and CombMNZ in nearly every case
- LETOR 3, 583,850 document-query pairs: RRF 0.6051 MAP vs ListNet 0.5846, RankSVM 0.5737, RankBoost 0.5622; CombMNZ 0.6107 was not significantly different (p ~ .2)
- Reported average margin over Condorcet, CombMNZ and the best individual system is 4-5%
- Ranks can be accumulated one system at a time, so no global state or full ranking must be held in memory

## 30. Hybrid Search reference (Digital Applied)

- url: https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026
- redistribution: deny
- license: All rights reserved
- license-evidence: https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026 — The page footer carries only a bare copyright line for Digital Applied dated 2026, with no Creative Commons mark or any stated reuse or republication permission anywhere on the page.
- verified: web

A consultancy's implementation reference for the full hybrid retrieval stack, published May 2026. Its useful contribution is not novel results but assembled defaults: BM25 parameter ranges and what they do, why naive weighted blending of BM25 and cosine scores collapses toward BM25 (unbounded versus bounded ranges), how rank-based fusion sidesteps that entirely, per-vendor implementation differences, and where a cross-encoder reranker belongs in the pipeline. It cites a third-party WANDS e-commerce benchmark showing lexical and dense retrieval statistically tied while fusion plus field boosting lifts NDCG meaningfully, and it flags its own single-dataset caveat. For Foray the directly actionable parts are the fusion constant and the staged pipeline shape (retrieve wide from both indexes, fuse on ranks, rerank a shortlist of roughly a hundred candidates), plus the warning that a Weaviate version upgrade silently changed the default fusion algorithm. Treat vendor-stated reranker accuracy numbers as marketing; the piece labels them as such. It is a checklist, not evidence.

**Key facts**

- BM25 parameters: k1 typically 1.2-2.0 (Lucene default 1.2), b default 0.75
- Rank fusion constant k = 60 is the default in Elasticsearch and most implementations; rank 1 contributes about 0.0164 per list, rank 100 about 0.00625
- WANDS benchmark NDCG means cited: BM25 0.6983, pure KNN 0.6953, basic fusion 0.7068, fusion + all-terms clause 0.7191, fusion + name boost 0.7497
- Weaviate changed its hybrid default from rankedFusion to relativeScoreFusion at v1.24; fusionType must be pinned explicitly to keep rank fusion
- SPLADE emits sparse vectors sized to the bert-base-uncased vocabulary (30,522 dims) and needs GPU inference, unlike inverted-index BM25
- Voyage rerank-2.5 (released 11 Aug 2025): 32K context, up to 1,000 documents per call, 600K total token limit; its comparison figures are vendor-run
- Published 26 May 2026, 11-minute read, self-described as sourced to 8 primary references

## 31. Spotify: Optimizing for the Long-Term Without Delay

- url: https://research.atspotify.com/2023/07/optimizing-for-the-long-term-without-delay
- redistribution: deny
- license: All rights reserved
- license-evidence: https://research.atspotify.com/2023/07/optimizing-for-the-long-term-without-delay — The page footer shows a 2026 Spotify AB copyright and links only to Spotify's user agreement, privacy and cookie policies; no Creative Commons or other open content license is stated for the post text.
- verified: web

Spotify's research blog summarizing its KDD 2023 Impatient Bandits work on item cold-start when the reward you actually care about arrives months late. The framing: optimizing for a long-horizon outcome (how many days a user keeps engaging with a newly discovered show over two months) creates an apparent choice between alignment and learning speed, because short-term proxies are fast but misaligned while the true reward is aligned but delayed. The fix is to stop treating the reward as a single delayed scalar and model it as a sequence of progressively revealed intermediate observations, folded into a per-action Bayesian filter that maintains a Gaussian belief over the expected sequence, with the filter's parameters learned from historical fully observed sequences of earlier content releases. Action selection is Thompson sampling over that belief. In simulation the approach lands much nearer a zero-delay oracle than the wait-and-see baseline. For Foray this maps onto rating a newly ingested episode from a handful of early listener signals rather than waiting weeks. Caveat: the study is non-contextual, so it says nothing about personalization.

**Key facts**

- Companion paper: Impatient Bandits: Optimizing for the Long-Term Without Delay, McDonald, Maystre, Lalmas, Russo and Ciosek, KDD 2023
- Reward definition in the podcast application: number of days a user engages with a newly discovered show across a 60-day window
- Intermediate observations (the 'trace') are combined via a per-action Bayesian filter maintaining a Gaussian belief, trained on full traces from prior content releases
- Roughly 10-20 days of partial trace suffices for accurate predictions of the 60-day reward
- Simulation pool was 200 podcast shows; the intermediate-outcome policy tracks close to a zero-delay oracle and far ahead of a 60-day-wait baseline
- Setting is explicitly non-contextual: recommendations are not personalized in this formulation
- Builds on Spotify's earlier RL work on long-term audio recommendation (arXiv 2302.03561)

## 32. Spotify: Cold-Starting Podcast Ads and Promotions with Multi-Task Learning (arXiv 2601.02306)

- url: https://arxiv.org/html/2601.02306
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://arxiv.org/abs/2601.02306 — The arXiv abstract page displays a Creative Commons Attribution 4.0 International license linking to creativecommons.org/licenses/by/4.0/, and the HTML full text itself carries a cc-license: by marker, so third-party redistribution with attribution is permitted.
- verified: web

Spotify's WSDM 2026 industry paper on collapsing separate ad-targeting and content-promotion models into one multi-task network so the data-rich channel can bootstrap the data-poor one. Architecture is a shared encoder over user, content, context and creative features feeding per-task MLP towers that predict five binary outcomes. Two training choices carry the result: a directional loss mask so ad impressions update only the ad towers while promotion impressions update everything, and mini-batches balanced roughly half and half across the two channels so the higher-volume source cannot dominate the gradient. Offline they report a small promotions gain and a large ads gain over a promotions-only baseline; a budget-split online test across many markets improved cost efficiency and stream rate simultaneously, with gains growing monotonically as show popularity falls. For Foray the transferable design is the shared-encoder, per-objective-tower shape for a curation ranker that must serve several objectives at once, and the empirical point that cross-objective transfer is exactly where cold-start items benefit most. Caveat: this is an advertising system, so its objectives are commercial, not curiosity-first.

**Key facts**

- WSDM 2026 (Boise, 22-26 Feb 2026), DOI 10.1145/3773966.3779388; arXiv 2601.02306 submitted 5 Jan 2026
- Five binary tasks over a shared encoder: PromotionStream, AdStream, Click, and Like/Follow
- Directional transfer via a loss mask (ad impressions update only ad towers) plus source-balanced sampling at roughly 50/50 promotions to ads; per-task loss weights all set to 1
- Offline Average Precision vs the promotions-only baseline: +4.5% on promotions, +50.2% on ads; ancillary click/like/follow heads raise ads-only AP from +27% to +46.5%
- Online budget-split A/B across 180+ markets: up to 22% effective cost-per-stream reduction and 18-24% higher podcast stream rates
- Less-streamed creators defined as shows under 5,000 streams; they see 22% eCPS reduction and 27% more streams
- Impression-to-stream gains scale with scarcity: about +7% at the highest stream tier up to about +60% at tier 5, with cost-per-stream down 17-38%
- Context given: Spotify over 700M users, over 400M ad-supported

---

# Area 5 — Audio Assembly & Playback

## 33. Apple Developer Forum — AVQueuePlayer gapless playback

- url: https://developer.apple.com/forums/thread/111413
- redistribution: deny
- license: All rights reserved
- license-evidence: https://www.apple.com/legal/internet-services/terms/site.html — Apple's site Terms of Use forbid republishing or distributing site content without express written consent, and forum posts are additionally authored by third-party developers who granted no redistribution license to us.
- verified: web

A short Apple Developer Forums thread (one original post, one reply, both from the same developer) in which a developer queues remote MP3 files in AVQueuePlayer and hears a very short gap at each track transition, with a noticeably worse delay (around a second) when routing to AirPlay. Its value to Foray is the diagnosis rather than the complaint: the poster reports that generated tone files in WAV played back seamlessly, while the same tones converted to MP3 acquired a comparable gap, and concludes the queue player itself is capable of gapless transitions when the underlying files genuinely are gapless. That points the blame at MP3 encoder/decoder padding rather than at the player class. For a product stitching third-party podcast enclosures -- which are overwhelmingly MP3 and were each encoded independently -- this is the warning that naive AVQueuePlayer queueing will expose encoder padding at every segment boundary, and that the fix has to address the audio data (composition, trimmed time ranges, or buffered rendering) rather than a player flag.

**Key facts**

- Reported symptom: millisecond-scale gaps between consecutive remote MP3 items in AVQueuePlayer, worsening to roughly one second over AirPlay.
- The audio session in the reported setup used AVAudioSession category .playback with policy .longForm.
- Poster's own test: WAV tone files played gaplessly; the same tones re-encoded to MP3 introduced a comparable gap, implicating MP3 encoder padding rather than AVQueuePlayer.
- Stated conclusion: AVQueuePlayer performs gapless playback correctly when the source files themselves contain no leading/trailing silence.
- Environment given is dated (Xcode 10.1, macOS 10.14.1, iOS 12.1), so behavior should be re-verified on current iOS.
- Capture recovered via a browser render per `tools/corpus/README.md#rendered-html-route`; both posts (OP + the OP's own follow-up) are attributed, replacing an earlier extraction that ran the two together.

## 34. Apple Developer Forum — Multiple AVPlayer instances + AirPlay 2

- url: https://developer.apple.com/forums/thread/105877
- redistribution: deny
- license: All rights reserved
- license-evidence: https://www.apple.com/legal/internet-services/terms/site.html — Apple's site Terms of Use prohibit republishing or distributing site content without express written consent, and the thread's substance is third-party developer posts that carry no redistribution grant.
- verified: web

An Apple Developer Forums thread about apps that play two audio streams simultaneously through separate AVPlayer instances -- the original poster describes a foreground voice stream over a background music stream -- and the finding that this pattern breaks on AirPlay 2 even though it worked on AirPlay 1. Multiple developers confirm the same behavior, including one building a gapless music player where two players briefly overlap during a crossfade, and one testing against a Sonos speaker; the consistent report is that only one stream survives the route. The most load-bearing reply is from an Apple engineer, who states the streams have to be mixed rather than played by parallel players, and names AVSampleBufferAudioRenderer or a single AVPlayer driving an AVMutableComposition as the two supported routes. A workaround is also reported: avoid the long-form audio policy and set the duckOthers option, which restores simultaneous streaming to AirPlay 2 devices at the cost of losing lock screen and Control Center transport controls. For Foray this is a hard architectural constraint on any design that plays an AI-narrated interstitial over or alongside a podcast segment.

**Key facts**

- Two concurrent AVPlayer instances play correctly over AirPlay 1, Bluetooth and AirPods, but only one stream reaches AirPlay 2 targets such as HomePod or Sonos.
- An Apple engineer's reply in-thread recommends mixing the streams, naming AVSampleBufferAudioRenderer or a single AVPlayer over an AVMutableComposition as the ways to do it.
- Reported workaround: set AVAudioSession category .playback with options [.duckOthers] and do not use the .longFormAudio policy -- both streams then reach AirPlay 2.
- Documented cost of that workaround: loss of lock screen / Control Center playback controls, which for a podcast app is effectively disqualifying.
- Community observation that at least one major meditation app also does not support AirPlay with simultaneous narration plus music.
- Capture recovered via a browser render per `tools/corpus/README.md#rendered-html-route`; all four posters (OP plus three named repliers, Mar–Apr 2021) are now individually attributed, replacing an earlier extraction that ran replies together.

## 35. StreamingKit (GitHub)

- url: https://github.com/asurasunil/StreamingKit
- redistribution: allow
- license: BSD-4-Clause
- license-evidence: https://raw.githubusercontent.com/asurasunil/StreamingKit/master/LICENSE — The repository's LICENSE file is the original 4-clause BSD license (Thong Nguyen, for Audjustable), which expressly permits redistribution of source and binary forms provided the copyright notice, condition list and disclaimer are retained -- and note the clause 3 advertising requirement to acknowledge software developed by Thong Nguyen must be honored if this text is reused.
- verified: web

README for StreamingKit (formerly Audjustable), an Objective-C audio playback and streaming library for iOS and macOS built directly on CoreAudio rather than on AVFoundation. Its stated design goal is to decouple the input data source from the player, so that where the bytes come from -- local file, plain HTTP progressive download, an auto-recovering HTTP source, or a custom source doing encryption or adaptive buffering -- is a pluggable concern. The headline claim, and the reason it is in this corpus, is gapless playback across queued items even when those items are in different formats; the README's own example queues an MP3 URL followed by an AAC URL. That maps almost exactly onto Foray's problem shape, where consecutive segments come from different publishers' CDNs at different bitrates and codecs, and where AVQueuePlayer is reported to expose encoder padding at each join. The library exposes two main types, an abstract data source and a queue-driven player, plus a PCM frame filter hook that would allow per-segment gain or metering to be applied in the render path. Caveats: it is an unmaintained-looking fork of an old project, the version referenced is 0.2.x, and the copyright line stops at 2014.

**Key facts**

- STKAudioPlayer is the queue-based player; STKDataSource is the abstract base for input sources, with Local, HTTP and AutoRecoveringHTTP sources shipped.
- Claims gapless playback between queued files of differing formats (README example queues an .mp3 followed by an .aac), which AVQueuePlayer does not natively guarantee.
- Built on CoreAudio; version 0.2.0 moved from AudioQueues to the AudioUnit API to allow real-time interception of raw PCM.
- appendFrameFilterWithName:block: exposes PCM frames just before playback -- a viable hook for per-segment gain, loudness normalization or metering.
- Includes a built-in equalizer (iOS 5.0+/OS X 10.9+) and power metering; README claims 0-1% CPU while streaming.
- Objective-C, distributed via CocoaPods or source copy; copyright line reads 2012-2014, Thong Nguyen, so treat as legacy code.

## 36. AES Loudness Normalization overview

- url: https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/
- redistribution: deny
- license: All rights reserved
- license-evidence: https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/ — The page footer reads Audio Engineering Society, Inc. All rights reserved, and the page carries no Creative Commons mark or any other statement granting third-party redistribution.
- verified: web

The AES Loudness Project's explainer on what loudness normalization actually is and how it is applied in file-based distribution. It defines normalization as measuring the integrated loudness of a whole asset in LUFS and applying a single static gain offset so that the measurement lands on a target -- upward if the content is quieter than target, downward if louder -- and stresses that the gain is set once, with no gain riding, so the producer's internal dynamics survive intact. That distinction matters for Foray: normalizing a stitched sequence is a per-segment measure-then-offset step at ingest, not a compressor in the playback path. The page also separates the assorted-content case (speech mixed with music and interstitials) from the music case, describes album versus track normalization and why album-relative gain preserves mastering intent, and surveys why targets differ across broadcast, OTT video and on-demand music. It closes on real-time correction: useful when file-based measurement is not possible, but it cannot see ahead in a live stream and can override intended dynamics, with recommended integration windows given. Concrete targets are cited to AES TD1008, which is a separate document not captured here.

**Key facts**

- Normalization is defined as measuring integrated loudness in LUFS across the full asset and applying one static gain offset to hit a target; no gain riding is performed.
- For assorted content with measurable speech, the page describes adjusting overall gain so the dialog integrated loudness sits at -18 LUFS; where speech is not reliably measurable, TD1008 is cited for normalizing overall content to -18 LUFS before encoding.
- For track normalization in radio-style production, the page cites TD1008 recommending roughly -16 LUFS as the best match with other online content.
- Album normalization applies one common gain to all tracks (recommended to be set by the loudest track) to preserve mastering intent; track normalization flattens all items to the same level.
- Broadcast TV standards including AES71 target about -23/-24 LUFS (LKFS); AES71 plus ANSI A/85 and EBU R128 underpin OTT guidelines, and ANSI/CTA-2075 covers device playback.
- For real-time correction, recommended rolling integration windows are 30 seconds to two minutes, with peak limiting applied because gain is being added; longer windows sound more natural.
- Specific target numbers live in AES TD1008, which this page only links to.

---

# Area 6 — TTS & AI Narration

## 37. TTS Arena V2 (Hugging Face)

- url: https://huggingface.co/spaces/TTS-AGI/TTS-Arena-V2
- redistribution: deny
- license: none-found
- license-evidence: https://huggingface.co/terms-of-service — Close call: Hugging Face's terms do grant each user a license to reproduce and distribute Content in public Repositories, but what was captured here is Hugging Face's own rendered platform chrome rather than repository Content, and the Space itself displays no license -- so no specific grant covers this text.
- verified: web

Effectively nothing usable was captured, and a real-browser render doesn't fix that here: confirmed 2026-08-13 that the Space's actual app runs inside a cross-origin, sandboxed iframe served from a separate `*.hf.space` subdomain, so neither a static fetch nor an in-page text/accessibility read from the parent `huggingface.co` document can see into it -- the parent page's own DOM shows only a loading placeholder ("Refreshing" / "docker space app"). The Arena tab additionally requires clicking "Synthesize" to reveal any pairing before a model or score is shown at all, so even a successful render of the iframe's current state would show a blank comparison screen, not leaderboard data -- this is genuinely interactive, session-driven content, not a JS-rendered static page. The Space's own README (checked at `huggingface.co/spaces/TTS-AGI/TTS-Arena-V2/blob/main/README.md`) carries no methodology text, only build metadata and a pointer to `github.com/TTS-AGI/TTS-Arena`, a different URL than the one in the dossier. Per corpus policy (`tools/corpus/README.md#rendered-html-route`: "if a page cannot be recovered honestly ... leave it thin, record why"), this stays thin rather than substituting a different URL's content under this source's citation. What the corpus entry establishes is therefore only positional: TTS Arena V2 is a crowdsourced blind pairwise-comparison leaderboard for TTS naturalness, and the obvious open benchmark to consult when choosing a narrator voice -- but any actual ranking data has to come from loading the Space interactively (or the maintainers' underlying results dataset), not from this corpus.

**Key facts**

- Extraction is empty of substance: one chunk of Hugging Face's own loading chrome (Docker metadata fetch notice plus a refresh indicator), roughly 60 characters.
- Confirmed 2026-08-13: the Arena app renders inside a cross-origin sandboxed iframe on a separate `*.hf.space` origin; the parent page's DOM and accessibility tree cannot see the iframe's content at all (not merely "not yet rendered").
- Even a successful iframe render requires an interactive "Synthesize" click per comparison before any model name or score appears -- session-driven, not a one-time static render.
- The Space's README points to a different URL (`github.com/TTS-AGI/TTS-Arena`) as its source repo; not substituted here per corpus policy of not silently swapping what a citation points at.
- No model names, Elo scores, vote counts, sample sizes or methodology were captured; this entry is a pointer, not evidence about any specific TTS system's quality.
- Space is maintained under the TTS-AGI org; usable as a pointer to the open TTS naturalness benchmark, not as a data source in its current captured form.

## 38. Amazon Polly pricing (official)

- url: https://aws.amazon.com/polly/pricing/
- redistribution: deny
- license: All rights reserved
- license-evidence: https://aws.amazon.com/terms/ — The AWS Site Terms state the site may not be reproduced, duplicated, copied or otherwise exploited for commercial purposes without express written consent; the CC-BY-SA-4.0 documentation exception applies to docs.aws.amazon.com, not to this marketing pricing page.
- verified: web

The official Amazon Polly pricing page, captured in full enough detail to cost out AI-narrated interstitials. Polly bills purely on characters submitted, with four voice tiers at very different price points, and the page is explicit on two points that matter for Foray's unit economics. First, generated speech may be cached and replayed at no additional cost -- so a bridge synthesized once and reused across listeners or sessions costs nothing further, which changes the calculation from per-listen to per-unique-script. Second, Speech Marks requests (the metadata used for timing and lip sync) bill at the same per-character rate as speech, so requesting them doubles the character cost for a given script. The page includes a worked table converting character counts into speech duration and cost per tier, plus free-tier allowances that differ by tier and mostly expire after twelve months. Separate, higher GovCloud rates are listed for the Standard and Neural tiers only. Positioned against the other TTS vendors in this corpus, Polly's Standard and Neural tiers are the cheap end and its Long-Form tier the expensive end.

**Key facts**

- Pricing observed 2026-08-12: Standard $4.00, Neural $16.00, Generative $30.00, and Long-Form $100.00 per 1 million characters, billed on characters submitted for speech or Speech Marks.
- Observed 2026-08-12: generated speech can be cached and replayed at no additional charge, so reused interstitials cost once, not per playback.
- Speech Marks requests are billed at the same per-character rate as speech, so requesting both roughly doubles cost for the same script (observed 2026-08-12).
- Page's own conversion, observed 2026-08-12: 1 million characters is approximately 23 hours 8 minutes of speech -- so roughly 720 characters per minute of audio.
- Free tier observed 2026-08-12: 5M chars/month Standard (ongoing), 1M/month Neural, 500k/month Long-Form and 100k/month Generative, the latter three for the first 12 months only.
- AWS GovCloud (US) rates observed 2026-08-12 are higher and cover only two tiers: Standard $4.80 and Neural $19.20 per 1M characters.

## 39. OpenAI TTS pricing

- url: https://community.openai.com/t/new-tts-api-pricing-and-gotchas/1150616
- redistribution: deny
- license: All rights reserved
- license-evidence: https://community.openai.com/faq — The community guidelines page displays no Creative Commons or redistribution grant and defers to OpenAI's general Terms of Use (which returned 403 to a direct fetch); the posts are in any case authored by third-party forum users, not by OpenAI.
- verified: web

An OpenAI developer-community thread from late March 2025 in which users try to reverse-engineer how the gpt-4o-mini-tts model actually bills, because the published pricing page separates input text tokens from output audio tokens without stating clearly that a quoted per-minute figure covers both. The participants converge on the reading that the per-minute estimate is combined and that output audio tokens dominate the bill -- one poster calculates that reaching the same cost from text alone would require an implausible volume of instruction tokens. The thread's real value to Foray is the operational failure mode reported alongside the arithmetic: a script of roughly one minute occasionally ran for over three minutes, with the tail being silence, and was billed for the full runaway duration. That is a concrete argument for validating generated interstitial audio before use -- checking duration against expected script length and trimming trailing non-speech -- rather than trusting the synthesis call. Treat every number here as user-reported rather than authoritative; this is a community forum, not OpenAI documentation, and participants explicitly note they are not affiliated with OpenAI.

**Key facts**

- User-reported gpt-4o-mini-tts rates as discussed in the thread (posts dated March 2025; corpus observed 2026-08-12): about $0.60 per 1M input text tokens, which includes the instructions, and about $12 per 1M audio output tokens.
- User-reported effective cost of roughly $0.015 per minute of generated audio, with the thread concluding this figure is combined across input and output rather than per side (observed 2026-08-12).
- Participants report the per-minute effective rate is unstable on short inputs, running around double the estimate, and stabilizes on roughly minute-long generations.
- Reported failure mode: a one-minute script generated over three minutes of audio with the last ~2.5 minutes silence, and was billed for the full duration -- argues for post-generation duration checks and silence trimming.
- Suggested mitigation in-thread is preprocessing/filtering out non-speech segments from the output until the API addresses it.
- All figures are unofficial user observations; the thread itself points to platform.openai.com/docs/pricing as the authority, and posters state they are not OpenAI-affiliated.
- Re-captured via a browser render (`tools/corpus/README.md#rendered-html-route`) covering all 9 posts, including a later tangent (not summarized above) where a different poster asks about Whisper transcription quality and is told results are comparable across models with some improvement on less-common languages.

## 40. ElevenLabs pricing (official)

- url: https://elevenlabs.io/pricing
- redistribution: deny
- license: All rights reserved
- license-evidence: https://elevenlabs.io/terms-of-use — ElevenLabs' Terms of Service state that the text, images and other content of the Services are owned by ElevenLabs or its licensors and that all rights not explicitly granted are reserved; users receive only a limited, revocable license to access and use the Services.
- verified: web

The ElevenLabs public pricing page, captured as a subscription ladder plus an unusually informative FAQ. ElevenLabs does not sell per-character units the way Polly does; it sells monthly credit bundles that are shared across every product the company offers, so text-to-speech competes for the same pool as speech-to-text, music, dubbing and voice changing. For text-to-speech the conversion is close to one credit per character on the multilingual models, with the faster Flash/Turbo variants discounted for API use, which makes it possible to compare against per-character vendors: the page's own effective per-minute figures fall by tier and flatten out at the higher plans. For Foray the important structural facts are the ones that determine whether the model is workable for bursty interstitial generation -- credits reset each billing cycle and roll over only to a capped ceiling, downgrading or cancelling forfeits them, and higher audio quality output is gated behind a specific plan tier rather than sold separately. Compared with the other TTS vendors in this corpus, ElevenLabs is the premium option, and its cost per minute of narration is roughly an order of magnitude above Polly's cheaper tiers.

**Key facts**

- Plan ladder observed 2026-08-12: Free $0 / 10k credits, Starter $6 / 30k, Creator $22 / 121k, Pro $99 / 600k, Scale $299 / 1.8M (3 seats), Business $990 / 6M (10 seats), Enterprise custom.
- Credit conversion observed 2026-08-12: text-to-speech costs about 1 credit per character on V2 Multilingual, with Flash/Turbo variants discounted to between 0.5 and 1 credit per character for API usage.
- Effective TTS cost per extra minute observed 2026-08-12: about $0.36 (Free) falling to $0.20 (Starter), $0.18 (Creator) and about $0.17 at Pro and above; the Business tier advertises low-latency TTS as low as 5 cents/minute.
- Audio quality is tier-gated (observed 2026-08-12): 128 kbps / 44.1 kHz below Pro; 192 kbps and 44.1 kHz PCM output via API from Pro upward.
- Credits are a single pool shared across all products and reset each billing cycle; unused credits roll over up to two months (balance capped at ~3x monthly quota) and are forfeited on downgrade or cancellation. Rollover does not apply to Free.
- Commercial License and Instant Voice Cloning start at the $6 Starter tier; Professional Voice Cloning starts at Creator (observed 2026-08-12).
- Annual billing is priced at 10x the monthly rate (two months free), and credits are charged per generation request rather than per download.

---

# Area 7 — Prior Art & Postmortems

## 41. Snipd

- url: https://www.snipd.com/
- redistribution: deny
- license: All rights reserved (company marketing site, no license grant)
- license-evidence: https://www.snipd.com/ — Commercial product marketing page with no Creative Commons or other open-license grant anywhere on the page; default all-rights-reserved copyright applies.
- verified: inferred

Marketing homepage for Snipd, an AI-assisted podcast player. The advertised feature set is essentially a full ingest stack exposed to end users: triple-tap the headphones to capture a moment, and the app produces an audio excerpt plus a transcript and an AI summary; separately it offers pre-listen episode summaries covering topics, guests and takeaways, AI-generated chapters, full-episode transcript search with speaker identification, guest bios with cross-show appearance links, extraction of books mentioned, and shareable quote cards. Scope extends past RSS podcasts to YouTube imports, Libro.fm audiobooks, and user-uploaded audio files, the latter gated behind a premium tier. Captured material exports to Readwise, Notion, Obsidian, Logseq, Bear, Glasp, and plain Markdown. AI features are claimed in 26 languages. For a curation product, the significant boundary is that every Snipd capture is scoped inside a single episode the user is already playing, and its outward-facing artifacts are text, images, links and short video clips rather than a continuous assembled stream of other people's audio.

**Key facts**

- Snipd is the leading surviving AI podcast-clipping app; capture is triggered by a headphone triple-tap.
- Each capture bundles audio, an auto-transcript with speaker labels, and an AI summary.
- Clipping is scoped within one episode the user is already playing — no cross-show assembly of segments.
- Ingest beyond RSS: YouTube video import, Libro.fm audiobooks, and arbitrary uploaded audio (premium only).
- Exports to Readwise, Notion, Obsidian, Logseq, Bear, Glasp, and Markdown; AI features in 26 languages.
- Sharing outputs are text, quote-card images, links, and short video clips rather than stitched third-party audio.

## 42. Snipd blog — Airr sunset & DAI problem

- url: https://www.snipd.com/blog/how-to-include-podcasts-in-pkm-workflow
- redistribution: deny
- license: All rights reserved (company blog, no license grant)
- license-evidence: https://www.snipd.com/blog/how-to-include-podcasts-in-pkm-workflow — Corporate blog post carrying no Creative Commons badge or reuse grant; author is a competitor's employee writing marketing content, so default copyright applies.
- verified: inferred

Snipd company blog post (Kevin Smith, 12 September 2025) arguing that podcasts are the missing input to personal-knowledge-management stacks, which are otherwise built around text from Kindle, web clippers and PDFs. It walks through the capture flow — headphone triple-tap, background transcription and summarization, playback uninterrupted — then documents sync paths: Readwise as a hub feeding Obsidian, Logseq, Notion and Roam; a direct Notion database integration; an official Obsidian plugin with custom templates and filters for starred or edited captures only; plus Glasp, Bear and Markdown export. Two passages carry weight beyond marketing. First, competitive: the post states that Airr, the first app to attack this problem, has been sunset. Second, technical: it states plainly that dynamically inserted ads throw audio and transcript out of alignment, so a saved offset points at the wrong audio and a highlight captures the wrong part of the episode. Snipd claims an unspecified proprietary mechanism that re-syncs transcripts to audio when dynamic insertion is present — treating offset realignment as a differentiating capability, not a detail.

**Key facts**

- Published 12 September 2025 on the Snipd company blog, bylined Kevin Smith.
- Confirms Airr — the first mover in podcast highlight capture — has been shut down.
- States that dynamic ad insertion misaligns audio against transcript timing, so saved highlights land on the wrong content.
- Snipd claims a proprietary automatic re-sync of transcripts to audio when dynamic insertion is present; no mechanism is disclosed.
- Free tier allows unlimited listening with AI features on two episodes per week; uploads and YouTube import require Premium.

## 43. Overcast clip sharing (Marco Arment blog)

- url: https://marco.org/2019/04/27/overcast-clip-sharing
- redistribution: deny
- license: All rights reserved (personal blog, no license grant found)
- license-evidence: https://marco.org/ — Fetched marco.org looking for a footer license or reuse statement and found none — no Creative Commons badge and no terms page granting redistribution, so default copyright applies.
- verified: web

Marco Arment's 27 April 2019 post announcing clip sharing in Overcast 2019.4. Listeners can generate a clip of up to one minute from any public podcast, output either as audio or as portrait, landscape or square video rendered in the user's current app theme. Two design choices are notable. The duration cap is hard and self-imposed, applied uniformly across all shows rather than negotiated per publisher. And the branding is deliberately soft: the Overcast badge is optional, an Apple Podcasts badge can be added instead, and the public share pages were refreshed to show badges for competing apps and the raw RSS feed for any show listed in Apple Podcasts. Arment frames all of this as strengthening the open, standards-based ecosystem so that proprietary walled gardens cannot exploit podcasting's weak points, sharing being the most cited one. Worth flagging for the corpus: the fetched text does not actually contain a fair-use rationale for the one-minute limit — the post gives ecosystem and social-feed reasoning, not a legal justification.

**Key facts**

- Published 27 April 2019; feature shipped in Overcast version 2019.4.
- Clips are capped at one minute, from any public podcast, as audio or portrait/landscape/square video.
- Overcast branding on shared clips is optional; an Apple Podcasts badge can be substituted.
- Public Overcast share pages link competing apps and the show's RSS feed for non-logged-in visitors.
- Clip generation creates a new derived asset (rendered video/audio), which is a different posture from streaming a range of the original enclosure.
- Correction to the corpus note: the fetched post contains no explicit fair-use rationale for the one-minute cap.

## 44. Podcast App Graveyard (Transistor)

- url: https://transistor.fm/podcast-apps-gone/
- redistribution: deny
- license: All rights reserved — © 2026 Transistor Inc.
- license-evidence: https://transistor.fm/podcast-apps-gone/ — Fetched the page and confirmed the footer reads "© 2026 Transistor Inc. All rights reserved." with no Creative Commons or reuse grant.
- verified: web

A running catalogue maintained by Transistor of 23 podcast listening apps that have shut down, each with an approximate death date and a short account of what it tried to be. Recent entries: Google Podcasts (2 April 2024, folded into YouTube Music), RadioPublic (bought by Acast in 2021, dead 2024), Repod and Poddy (both 2024), Stitcher (closed by SiriusXM on 29 August 2023 after launching in 2008). Older entries run back through Acast's own app and Listen App (2022), Breaker, Bitcast, Synth, Swoot and Broadcast (2021), Tung.fm and Google Play Music podcasts (2020), Podcast 9 (2019), Bumpers and Otto Radio (2018), and Instacast (2015). The pattern the list makes visible is the useful part for a curation product, and it is a product risk rather than a legal one: nearly every entry led with social or short-form-clip framing. At least five — Shuffle's community-curated short-clip feed, Synth's 256-second soundbites, Bitcast's clip-and-comment waveform, Tung's clip-and-discuss model, and Podcast 9's transcript-preview snippet bookmarks — attempted some version of the segment premise and none survived.

**Key facts**

- 23 discontinued podcast apps catalogued; Google Podcasts ended 2 April 2024, Stitcher on 29 August 2023.
- Shuffle (offline 2022) pitched a TikTok-style feed of community-curated short podcast clips.
- Synth (offline 2021) built around 256-second soundbites; Bitcast (2021) offered clipping plus waveform comments.
- Tung.fm (gone ~2020) let users recommend, clip and discuss specific episodes; Podcast 9 (2019) offered transcript previews and snippet bookmarks.
- RadioPublic was acquired by Acast in 2021 and shut down in 2024; Acast closed its own listening app in 2022.
- Surviving apps are conventional players; the clip/social category has repeatedly failed to reach durable scale.

## 45. Twitter acquires Breaker (TechCrunch)

- url: https://techcrunch.com/2021/01/04/twitter-acquires-social-podcasting-app-breaker-team-to-help-build-twitter-spaces/
- redistribution: deny
- license: All rights reserved — republication expressly prohibited by TechCrunch Terms of Service
- license-evidence: https://techcrunch.com/terms-of-service/ — TechCrunch's Terms of Service expressly bar reproducing, republishing, distributing or creating derivative works from site material, permitting only a single personal, non-commercial copy.
- verified: web

TechCrunch report dated 4 January 2021 on Twitter's acquisition of Breaker, a social podcast app founded in 2016 by CEO Erik Berlin and CTO Leah Culver, the latter a co-author of the OAuth and oEmbed specifications. The deal was an acqui-hire: Berlin, Culver and designer Emma Lundin moved to Twitter to work on Twitter Spaces, its live-audio Clubhouse rival, then in beta. The app was announced as shutting down on 15 January 2021, with users directed to export OPML to move subscriptions elsewhere; an update appended to the article notes Maple Media instead took over operating Breaker's apps. Price was never disclosed. The article's analysis is the durable part: unlike the era's content deals, this one bought staff and technology rather than shows, and it lands in a pattern where podcast businesses exit near $300M (Stitcher to SiriusXM, Wondery to Amazon) — respectable personally but below venture-return thresholds, supporting the reading that podcast services and content carry capped value. For a curation layer that owns no content, that ceiling is the relevant signal.

**Key facts**

- Published 4 January 2021; Breaker founded 2016 by Erik Berlin (CEO) and Leah Culver (CTO, co-author of OAuth and oEmbed).
- Acqui-hire: team joined Twitter to build Twitter Spaces; acquisition price never disclosed.
- Breaker app was slated to shut down 15 January 2021; an article update says Maple Media took over operations instead.
- Users were told to export OPML to migrate subscriptions to Apple, Spotify, Stitcher, Overcast, Pocket Casts or Castro.
- TechCrunch's framing: podcast M&A repeatedly clusters near $300M (Stitcher/SiriusXM, Wondery/Amazon), implying capped upside for podcast-focused companies.

---

# Area 8 — Legal / Policy Landscape

## 46. Perfect 10 v. Amazon (Wikipedia summary)

- url: https://en.wikipedia.org/wiki/Perfect_10,_Inc._v._Amazon.com,_Inc
- redistribution: allow
- license: CC BY-SA 4.0 (Creative Commons Attribution-ShareAlike 4.0 International)
- license-evidence: https://en.wikipedia.org/wiki/Perfect_10,_Inc._v._Amazon.com,_Inc — Confirmed the article footer states text is available under the Creative Commons Attribution-ShareAlike 4.0 License; redistribution therefore requires attribution to Wikipedia contributors AND share-alike, which attaches to any derivative text we produce from it — and the footer's 'additional terms may apply' caveat means embedded images/media are not covered by this grant.
- verified: web

Encyclopedia article on Perfect 10, Inc. v. Amazon.com, Inc., 508 F.3d 1146 (9th Cir. 2007), argued 15 Nov 2006, decided 16 May 2007 (Ikuta, joined by Hall and Hawkins). An adult magazine sued Google over image search, Amazon being added on appeal for surfacing Google's thumbnails. The district court adopted the server test — liability for display and distribution turns on whether the defendant hosts and transmits the file — and rejected an 'incorporation test' keyed to what the user visually perceives; the Ninth Circuit affirmed that inline linking to third-party-hosted full-size images is not direct infringement. Separately it reversed on thumbnails, holding Google's own hosted copies a highly transformative fair use serving information retrieval rather than entertainment, following Kelly v. Arriba Soft. Contributory and vicarious claims failed since infringing sites predated Google and Google could not stop them. The article then tracks the ensuing split: Hunley reaffirmed the test in 2023, while Goldman (2018), Nicklen (2021) and McGucken (2022) in S.D.N.Y. rejected it, and Emmerich Newspapers v. Particle Media — over the NewsBreak app — reached the Fifth Circuit in 2026. For a pointers product this is the best-case precedent, but it is a display-right holding and actively contested.

**Key facts**

- Perfect 10, Inc. v. Amazon.com, Inc., 508 F.3d 1146 (9th Cir.), argued 15 Nov 2006, decided 16 May 2007; opinion by Judge Ikuta.
- Origin of the server test: inline linking to images hosted on third-party servers is not direct infringement of the display right.
- The district court expressly rejected an 'incorporation test' based on what the user visually sees, in favor of where the file is stored.
- Google's own hosted thumbnails were held a highly transformative fair use on appeal, following Kelly v. Arriba Soft.
- Contributory and vicarious claims failed: infringing sites predated Google Image Search and Google lacked power to stop them.
- The article documents the split — reaffirmed in Hunley (2023); rejected in Goldman (2018), Nicklen (2021), McGucken (2022); Emmerich Newspapers v. Particle Media argued in the Fifth Circuit in 2026.

## 47. Fordham Law Review — "Now on Display: In-Line Linking in the Age of the Server Test"

- url: https://fordhamlawreview.org/issues/now-on-display-in-line-linking-in-the-age-of-the-server-test/
- redistribution: deny
- license: All rights reserved — © 2023 Fordham Law Review
- license-evidence: https://fordhamlawreview.org/issues/now-on-display-in-line-linking-in-the-age-of-the-server-test/ — Fetched the page and found only a footer copyright notice reading FORDHAM LAW REVIEW ©2023, with no Creative Commons or open-access license declared for the Note's text.
- verified: web

Abstract page for a Fordham Law Review Note on in-line linking and the display right; the fetched content is the abstract only, not the Note itself. It traces the parallel histories of 17 U.S.C. 106(5) and the web, then characterizes the Server Test's reception since 2007: praised by search engines and web developers, criticized by scholars and rights holders, circumvented by the Seventh Circuit, and flatly rejected outright by federal district courts in Texas (N.D. Tex.) and in New York (S.D.N.Y.). The Note credits the test as a useful device for reasoning about in-line linking mechanics, but argues it locates the act of infringement at the wrong layer — the server. It proposes a three-step 'Display Test': what work is shown and where it is stored (the Server Test preserved as step one); to whom it is displayed and whether that audience is the public; and who caused the work to be displayed. It also urges narrow definitions of 'copy' and 'public' specific to the display right and distinct from the performance and reproduction rights. For a curation product the relevant risk is step three: a causation-focused test pushes liability toward whoever assembled the pointers.

**Key facts**

- Student Note in the Fordham Law Review; the fetched page contains only the abstract, not the full text.
- Argues the Server Test misplaces the act of infringement at the server layer despite being analytically useful.
- Proposes a three-step 'Display Test': what is shown and where stored; to whom and whether public; and who caused the display.
- Notes the Seventh Circuit circumvented the test and that N.D. Tex. and S.D.N.Y. district courts rejected it outright.
- Advocates defining 'copy' and 'public' narrowly and specifically for the display right, separate from the performance and reproduction rights.
- Relevance: a causation-based third step would point liability at the party assembling the pointers, i.e. the curation layer.

## 48. Pocket Casts Android Issue #2093 — chapters wrong under DAI

- url: https://github.com/Automattic/pocket-casts-android/issues/2093
- redistribution: deny
- license: Third-party user content — not covered by the repository license
- license-evidence: https://github.com/Automattic/pocket-casts-android/issues/2093 — Issue body and comments are authored by individual third parties (an external reporter and an Automattic maintainer) under GitHub's terms, not by the repository owner, and are not covered by the repository's source-code license.
- verified: inferred

Bug report opened 20 April 2024 by marvinweber against Pocket Casts for Android, now closed. It documents a regression introduced in version 7.61 after the app added support for chapters declared in the feed (Podcast Index and Podlove Simple Chapters formats). For shows using dynamic insertion, the chapter times published in the RSS feed no longer correspond to the chapters embedded in the MP3 the listener actually received. The evidence is concrete: for the German show Lage der Nation, episode 377, a chapter declared at 01:15:15.991 in the feed appears at 01:16:57.195 in the reporter's downloaded file — roughly a 100-second drift — and the reporter states the offset differs for every download. Full before-and-after chapter listings show the drift accumulating progressively as each ad break lands, so early chapters are nearly correct while late ones are badly wrong. He also notes that chapter images embedded only in the MP3 fail to render when feed chapters take priority, and proposes that file-embedded chapters should win with feed chapters as fallback. A maintainer acknowledged the report and escalated it internally. The lesson is that stored offsets must be validated against the bytes actually fetched, never trusted from metadata.

**Key facts**

- Issue #2093 on Automattic/pocket-casts-android, opened 20 April 2024 by marvinweber; state closed.
- Regression traced to version 7.61, which added parsing of feed-declared chapters (Podcast Index and Podlove Simple Chapters).
- Measured drift: Lage der Nation ep. 377 chapter at 01:15:15.991 in the feed sits at 01:16:57.195 in the delivered MP3 — about 100 seconds.
- Reporter states the offset differs for every individual download; drift accumulates across the episode as successive ad breaks land.
- MP3-embedded chapter images fail to display when feed chapters take precedence.
- Proposed fix: prefer chapters embedded in the media file, treating feed chapters only as fallback; maintainer escalated internally.

## 49. Podnews — Megaphone added to ad-block lists

- url: https://podnews.net/update/megaphone-block-list
- redistribution: deny
- license: All rights reserved — © Podnews LLC, reproduction prohibited
- license-evidence: https://podnews.net/about — Podnews's own about page states the website is copyright Podnews LLC and that reproduction is prohibited without their written permission; no Creative Commons or other open license is offered.
- verified: web

An edition of the Podnews daily podcast-industry newsletter dated around 6 January 2021. Its lead item reports that Megaphone — a major podcast hosting and ad-serving platform, at the time newly acquired by Spotify — had been added to several ad-blocking and tracker-blocking lists, so that users of the Brave browser, NextDNS and uBlock Origin were being blocked from reaching it. The blocks predated the Spotify purchase. Podnews cites a lime.link post and notes that Darknet Diaries host Jack Rhysider, who hosts on the platform, wanted to keep using it without sharing listener data with third parties. The remainder of the issue is unrelated industry briefs: Google Podcasts adding a web subscriptions view, a WNYC Studios co-founder joining Supercast, growth in Welsh-language podcasts, talkRADIO's removal from YouTube, and Amazon's Wondery purchase. The load-bearing point for a curation product is narrow but real: podcast delivery and measurement infrastructure is contested enough that consumer blocklists treat a major host as a tracker. The dispute is over listener data and advertising, not audio rights — but a product that fetches enclosures inherits both blocked-delivery failures and publisher sensitivity to anything resembling ad or tracking evasion.

**Key facts**

- Podnews issue dated 6 January 2021; lead item is Megaphone's addition to multiple ad-block and tracker-block lists.
- Brave, NextDNS and uBlock Origin were all blocking access to Megaphone; the blocks preceded Spotify's acquisition of the company.
- The stated grievance is listener-data sharing with third parties, not audio copyright.
- Darknet Diaries host Jack Rhysider, a Megaphone customer, is cited wanting to host there without sharing listener data.
- Implication for enclosure-fetching clients: blocked hosts can cause delivery failures, and the ecosystem is primed to read ad/tracking avoidance as hostile.

## 50. Creative Commons Podcasting Legal Guide

- url: https://wiki.creativecommons.org/wiki/Podcasting_Legal_Guide
- redistribution: deny
- license: CC BY-NC-SA 2.5 (Attribution-NonCommercial-ShareAlike 2.5) — NonCommercial clause blocks use here
- license-evidence: https://wiki.creativecommons.org/wiki/Podcasting_Legal_Guide — This page carries a banner and a 'License & Attribution' section stating that, unlike other articles on the wiki, the Guide is licensed under Attribution-NonCommercial-ShareAlike 2.5 — so it does NOT inherit the wiki's general license; the NonCommercial restriction makes republishing it in a commercial product's public repository the wrong call, hence deny despite an open license technically being present.
- verified: web

The Podcasting Legal Guide, subtitled Rules for the Revolution, a 2006 wiki-hosted guide written by Colette Vogele (Vogele & Associates) together with Mia Garlick, then at Creative Commons, and the Berkman Center's Clinical Program in Cyberlaw, produced under Stanford's Center for Internet and Society fellowship, with a foreword by Lawrence Lessig. It is limited to US law and states plainly that it is not legal advice and creates no attorney-client relationship. Structure: an overview of copyright, publicity-rights and trademark exposure when producing a podcast; five circumstances in which permission is not needed — facts, ideas, theories, slogans and short phrases; public domain works; US government works; fair use; and Creative Commons or otherwise 'podsafe' material. A substantial section on music explains that a song involves two separate works, the composition and the sound recording, each with distinct rights, so multiple licenses are typically required. A four-factor fair-use section addresses common misconceptions and gives podcast-specific examples. The distribution half covers implied versus express licenses and applying a CC license to one's own feed. For a segment-clipping product, the music analysis is the live hazard: a segment containing a licensed music bed or clip carries rights that the podcast's own permissions do not clear.

**Key facts**

- Authored 2006 by Colette Vogele (Vogele & Associates), Mia Garlick (Creative Commons) and the Berkman Center Clinical Program in Cyberlaw; foreword by Lawrence Lessig.
- Scope is US law only, and it expressly disclaims being legal advice or creating an attorney-client relationship.
- Identifies five categories where permission is unnecessary: facts/ideas/short phrases, public domain works, US government works, fair use, and CC-licensed or 'podsafe' content.
- Music section stresses that a song comprises two separate copyrighted works (composition and sound recording) with distinct rights, generally requiring multiple licenses.
- Applies the statutory four-factor fair-use test to podcasting with worked examples and two common misconceptions.
- Practical risk it surfaces for clipping: music inside a captured segment carries rights the podcast's own permissions do not clear.

---

# Area 9 — LLM Pipeline Engineering

## 51. LLM-as-a-Judge complete guide (Evidently AI)

- url: https://www.evidentlyai.com/llm-guide/llm-as-a-judge
- redistribution: deny
- license: All rights reserved
- license-evidence: https://www.evidentlyai.com/llm-guide/llm-as-a-judge — The page footer reads as a 2026 Evidently AI all-rights-reserved copyright with only privacy policy and terms-of-service links; the company's open-source library license covers code, not this article text.
- verified: web

A vendor-authored practitioner guide arguing that an LLM judge is not a metric but a small supervised-learning project whose artifact happens to be a prompt. It separates judge shapes (pairwise comparison, direct scoring against named criteria, reference-based checking against a ground-truth answer) and then gives a build loop: pick one narrow question, assemble a small but adversarially diverse dataset, hand-label it yourself before writing any prompt, write the evaluation prompt from what the labeling taught you, then score the judge against your labels with ordinary classification metrics and keep a held-out slice for the final prompt. Prompt advice favors binary or coarse decisions over fine numeric scales, splitting compound criteria into separate evaluators, and requesting reasoning for debuggability. It also notes that hand-grading changes your own standards mid-flight, citing published work on that effect. For Foray this is the operating manual for the copy quality gate: the manual-labeling step is the part teams skip and the part that makes the judge trustworthy. It is marketing-adjacent, so treat tooling claims separately from methodology.

**Key facts**

- Three judge shapes covered: pairwise comparison, evaluation by criteria (direct scoring), and reference-based evaluation
- Build loop is five steps: define the scenario, assemble a dataset, manually label it, write the evaluation prompt, then measure against labels and iterate, retaining a held-out set
- Judge quality is measured with standard classification metrics such as precision and recall against human labels
- Recommends binary or low-precision scoring and splitting multi-dimensional criteria into separate evaluators
- Cites Shankar et al. 2024, 'Who Validates the Validators?' (arXiv 2404.12272), for criteria drift during manual grading
- Notes prompts are not portable across judge models, so instructions must be retested per model
- Vendor context: Evidently is an open-source eval library with a claimed 25M+ downloads

## 52. A Survey on LLM-as-a-Judge (arXiv 2411.15594)

- url: https://arxiv.org/abs/2411.15594
- redistribution: allow
- license: CC0-1.0
- license-evidence: https://arxiv.org/abs/2411.15594 — The abstract page's "Rights to this article" link points at creativecommons.org/publicdomain/zero/1.0/ — the authors' own per-article choice, distinct from arXiv's site-wide metadata license; confirmed by reading the page's rendered links this session (2026-08-13).
- verified: web

Recovered by repointing this source at its open preprint: the dossier's original URL was the same paper's journal republication on ScienceDirect (Gu, Jiang, Shi et al., published in *The Innovation*, pii S2666675825004564), which bot-walls automated fetches. The arXiv preprint (v6, Oct 2025) carries identical authorship and abstract and is CC0-dedicated by the authors, so it is both the accessible copy and, being public domain, the licensing-safer one to cite — a real change from the ScienceDirect original, which would have been deny-by-default Elsevier copyright. The paper surveys "LLM-as-a-Judge" — using an LLM to evaluate another model's (or its own) output — and organizes the field around one question: how to make that evaluation reliable. It walks through the mechanics practitioners actually tune (in-context examples, which base model to use as judge, how to post-process a raw judge response into a score, and pipeline design), then a separate section on strategies to *improve* reliability (prompt design, giving the judge more capability such as tool use or multi-step reasoning, and output-stage fixes), then a section on how to *measure* whether a judge is reliable at all — agreement with human raters, documented bias types, adversarial robustness, and a critique of how the field currently does meta-evaluation. It closes with applications (ML research, plus domain-specific uses) and named open problems (interpretability of a judge's reasoning, temporal drift as backbone models change, ethical/social implications of automating evaluation). For Foray's evaluation harness (segment self-containedness, bridge coherence) this is the structural map: which of those levers we've implemented, which biases apply to our specific judging tasks, and which meta-evaluation traps to avoid when we score our own scorer.

**Key facts**

- Same paper as the dossier's original ScienceDirect citation (Gu, Jiang, Shi, Tan, Zhai, Xu et al.); this preprint (arXiv:2411.15594v6, revised Oct 2025) is CC0-dedicated by the authors — redistribution verdict changed from deny (ScienceDirect/Elsevier) to allow.
- Structures the field around one question — how to build a *reliable* LLM-as-a-Judge — and separates "how judges are built" (in-context learning, judge model choice, output post-processing, pipeline design) from "how to make them more reliable" (prompt design, capability enhancement, output-stage optimization).
- Devotes a full section to measuring judge reliability itself: agreement with human judgments, a taxonomy of biases, adversarial robustness, and a critique of common meta-evaluation practice.
- Proposes its own reliability-oriented benchmark for scoring LLM-as-a-Judge systems, alongside a companion resource site (`awesome-llm-as-a-judge.github.io`).
- Names open problems directly relevant to a product judge: interpretability of a judge's stated reasoning, drift as the underlying backbone model changes over time, and multimodal ("MLLM-as-a-Judge") extension.
- Recovered 2026-08-13 via `corpus repoint-url 52 <arxiv-url>` + `refetch` after the ScienceDirect URL 403'd; see `tools/corpus/README.md` for the repoint procedure. Prior coverage from sources 51, 53 and 54 remains complementary, not superseded.

## 53. LLM-as-a-Judge best practices (DeepEval)

- url: https://deepeval.com/blog/llm-as-a-judge
- redistribution: deny
- license: All rights reserved (article text); Apache 2.0 applies to the DeepEval software only
- license-evidence: https://deepeval.com/blog/llm-as-a-judge — The footer shows a 2026 Confident AI Inc. copyright; the only license named on the page is Apache 2.0 for the DeepEval library, and no license is extended to the blog article text.
- verified: web

A framework vendor's practitioner post that maps judging problems onto three implementation patterns and shows the API for each. G-Eval covers subjective single-output criteria you describe in natural language; a directed-acyclic-graph metric covers criteria that are really branching rules and where you want determinism rather than a model's holistic opinion; question-answer-generation style built-ins decompose an evaluation into closed-ended checks and back the standard retrieval and agent metrics. It also distinguishes single-output scoring from pairwise arena comparison, and reference-based from referenceless metrics purely by which test-case fields the metric reads. The operationally useful half is downstream: run judges as regression tests in CI before deploying a prompt change, evaluate agent traces at component and trajectory level, and monitor production with a deliberately small set of high-signal metrics because too many judges make monitoring noisy and expensive. For Foray this is the closest match to gating LLM-authored hooks and why-lines: loose criteria while exploring, explicit graded steps or a deterministic graph once the check guards a release.

**Key facts**

- Three judging techniques presented: G-Eval, DAG-based metrics, and QAG-style built-in metrics
- Single-output metrics return a score between 0 and 1; pairwise comparison uses a separate arena test case with named contestants
- Reference-based versus referenceless is determined only by which test-case fields the metric consumes (expected output, context, retrieval context, expected tools)
- Guidance: start from a free-text criteria string while exploring, move to explicit evaluation steps once the metric guards CI/CD or production monitoring
- Recommends a small number of high-signal metrics in production monitoring to avoid noisy, expensive, uninterpretable dashboards
- Debug surface per metric: score, reason, and an optional verbose mode
- Site footer credits Confident AI Inc. (2026); the DeepEval framework itself is Apache 2.0

## 54. Evaluating Scoring Bias in LLM-as-a-Judge (arXiv 2506.22316)

- url: https://arxiv.org/pdf/2506.22316
- redistribution: allow
- license: CC BY 4.0
- license-evidence: https://arxiv.org/abs/2506.22316 — The arXiv abstract page shows a Creative Commons license icon linking to creativecommons.org/licenses/by/4.0/, so redistribution with attribution is permitted.
- verified: web

An Ant Group study of a failure mode that matters more than the well-studied pairwise biases: when a judge assigns an absolute score, the score moves in response to changes in the scoring prompt that carry no information about the response being graded. The authors name three such perturbations - reordering the rubric, changing the symbols used for score levels, and including a reference answer pinned at a particular score - and quantify each with stability measures (how often a score flips and by how much), agreement with gold scores, and score distribution shift. They evaluate five judges across four public benchmarks at temperature zero, using recent frontier models rather than the benchmarks' original annotations as gold. Every judge shifts. Larger and stronger judges shift less but never stop shifting, and the reference-answer perturbation is by far the worst, flipping something like a third to a half of all scores. For Foray this is a hard constraint on any copy quality gate: absolute pass/fail thresholds are only stable relative to a frozen rubric, so rubric edits invalidate historical scores.

**Key facts**

- Three named biases: rubric order bias, score ID bias, and reference answer score bias; arXiv 2506.22316, submitted 27 Jun 2025, v4 dated 3 Feb 2026
- Judge models: GPT-4o, DeepSeek-V3-671B, Qwen3-32B, Qwen3-8B, Mistral-Small-24B-Instruct-2501, all run at temperature 0
- Benchmarks: BiGGen Bench (2,780 responses over 695 instances), FLASK (200 prompts, 12 rubrics, 2,001 responses), MT Bench and Vicuna Bench (80 prompts and 320 responses each)
- Metrics: flip rate and mean absolute deviation for stability, Spearman and Pearson correlation for accuracy, plus a scoring-tendency measure
- Gold scores come from GPT-4.1 majority vote over three runs; GPT-4.1 correlated with human labels at Spearman 0.6048 on BiGGen Bench and 0.6401 on FLASK, above the benchmarks' original GPT-4 scores
- Adding a reference answer scored 5 flips roughly 35-49% of scores; GPT-4o hit 45.54% flip rate and 0.5604 MAD on BiGGen Bench
- Symbol and order perturbations alone flip 16-52% of scores; Qwen3-8B reached 46.22% flip rate under a descending rubric while GPT-4o mostly stayed under 25% flip rate and 0.3 MAD
- Synthetic reference answers for scores 1-4 were built with a generate-then-review loop alternating GPT-4.1 and GPT-4o; dataset released at github.com/KMdsy/scoring_bias

