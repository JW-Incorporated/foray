# Foray Research Dossier: A Curated Source Library for Building a Podcast Clip-Stitching App

> Saved from the claude.ai artifact: https://claude.ai/public/artifacts/11f81452-11dc-4ee1-b9e6-4a55506c3c7d

## READ FIRST — The 15 Highest-Value Sources

1. **Podcast Namespace spec (`podcast:transcript`, `podcast:chapters`)** — https://podcasting2.org/docs/podcast-namespace/tags/transcript — the canonical RSS extension spec you'll ingest.
2. **Podcast Index API (OpenAPI docs)** — https://podcastindex-org.github.io/docs-api/ — your primary free corpus/discovery backend.
3. **WhisperX paper (Bain et al., INTERSPEECH 2023)** — https://arxiv.org/abs/2303.00747 — the exact ASR + forced-alignment + VAD architecture you propose.
4. **pyannote.audio (GitHub)** — https://github.com/pyannote/pyannote-audio — SOTA open diarization.
5. **IAB Podcast Technical Measurement Guidelines v2.2 / v2.3** — https://iabtechlab.com/wp-content/uploads/2024/02/PodcastMeasurement_v2.2_pc.pdf — defines the "download," the 60-second rule, and how your range-request client gets counted (or not).
6. **TREC 2020 Podcasts Track Overview (Jones et al.)** — https://arxiv.org/abs/2103.15953 — the definitive academic baseline for podcast segment retrieval + summarization.
7. **TreeSeg: Hierarchical Topic Segmentation of Large Transcripts** — https://arxiv.org/pdf/2407.12028 — modern segmentation directly applicable to your ingest-time segmentation.
8. **Spotify: Recommending Podcasts for Cold-Start Users** — https://arxiv.org/abs/2007.13287 — first-party cold-start recommender research.
9. **Podcast Namespace Issue #254 (DAI breaks timestamps)** — https://github.com/Podcastindex-org/podcast-namespace/issues/254 — the single biggest technical threat to fixed offsets.
10. **Hunley v. Instagram (9th Cir. 2023, official opinion)** — https://cdn.ca9.uscourts.gov/datastore/opinions/2023/07/17/22-15293.pdf — the "server test" and its erosion; core to your legal risk.
11. **Goldman v. Breitbart analysis (Loeb & Loeb)** — https://www.loeb.com/en/insights/publications/2018/02/goldman-v-breitbart-news-network-llc — rejects the server test; the contradicting authority.
12. **AES TD1004.1.15-10 (Loudness for streaming/network playback)** — https://www.aes.org/technical/documents/AESTD1004_1_15_10.pdf — the -16 LUFS normalization standard you must apply across stitched segments.
13. **Apple AVFoundation Editing Guide (AVMutableComposition)** — https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/AVFoundationPG/Articles/03_Editing.html — the composition API for multi-source assembly.
14. **NotebookLM Audio Overviews (Google blog)** — https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews/ — the closest shipped prior art for AI-narrated audio synthesis.
15. **Chromaprint / AcoustID** — https://acoustid.org/chromaprint — acoustic fingerprinting for realigning offsets against DAI drift.

## TL;DR

- Foray is buildable, and most of its pipeline rests on mature, well-documented components — WhisperX, pyannote, the Podcast Index, neural topic segmentation, hybrid retrieval, and AVFoundation composition are all production-grade with primary docs.
- Two assumptions are materially risky. First, dynamic ad insertion (DAI) means your stored segment offsets drift per request, so "stream a fixed byte range from the publisher CDN" will frequently grab the wrong audio unless you realign at playback time. Second, the "playlist of pointers into others' audio" model is legally weaker for audio than for images: the image-embedding "server test" defends the display right, but streaming audio implicates the public performance right, which courts treat differently.
- Prior art is a graveyard of exits and pivots (Breaker, Airr, Stitcher, Google Podcasts, Shuffle), and the surviving clip apps (Snipd, Overcast) deliberately clip within a single episode and share short excerpts — none rehost or restitch multi-publisher audio into a new product, which is a signal about both technical friction (DAI) and publisher tolerance.

## Key Findings

- The podcast open ecosystem gives you the ingestion primitives for free. The Podcast Namespace and Podcast Index API provide transcripts, chapters, GUIDs, and a searchable corpus without scraping.
- Your ASR/alignment/diarization stack is essentially WhisperX + pyannote, which is the current open-source consensus and has published benchmarks. WhisperX improves word-segmentation precision/recall over vanilla Whisper's own timestamps — on the Switchboard corpus it reports 93.2% precision / 65.4% recall vs Whisper's 85.4% / 62.8%, and on AMI meeting audio 84.1% / 60.3% vs 78.9% / 52.1% (Bain et al., INTERSPEECH 2023, Table 2). Practitioners commonly cite word timing accuracy of roughly ±50 ms with wav2vec2 forced alignment versus ±500 ms for vanilla Whisper.
- Topic segmentation has both classic (TextTiling/C99) and modern neural/LLM baselines; TreeSeg and the TREC Podcasts Track are the most directly relevant.
- Hybrid retrieval (BM25 + dense vectors fused with Reciprocal Rank Fusion) is the settled best practice. RRF is the default fusion mechanism shipped by Elasticsearch's `rrf` retriever, OpenSearch hybrid search, Weaviate, Qdrant, and Azure AI Search, all citing Cormack, Clarke & Büttcher (SIGIR 2009), whose paper shows RRF "consistently yields better results than any individual system, and better results than the standard method Condorcet Fuse," using a smoothing constant of k=60.
- Loudness normalization is non-negotiable for stitched audio — different publishers master to different levels, and without per-segment normalization to ~-16 LUFS the transitions will be jarring.
- DAI is the technical Achilles' heel and is explicitly documented by the podcast standards community as breaking every timestamp-dependent feature.
- The legal posture of manifest playback of third-party audio is unsettled and trending against you.

## Details by Research Area

### 1. Podcast Infrastructure

- **Podcast Namespace — Chapters tag** — https://podcasting2.org/docs/podcast-namespace/tags/chapters — Official spec for `<podcast:chapters>` linking to an external JSON chapters file. *Why it matters for Foray:* chapters are pre-segmented topic boundaries you can exploit as free candidate segment cues.
- **Podcast Namespace — Transcript tag** — https://podcasting2.org/docs/podcast-namespace/tags/transcript — Spec for `<podcast:transcript>`, supporting multiple formats including time-coded captions (SRT/VTT/JSON). *Why it matters:* when publishers ship transcripts you can skip ASR and use forced alignment instead — cheaper and more accurate.
- **Podcast Namespace GitHub repo** — https://github.com/Podcastindex-org/podcast-namespace — CC0-licensed full spec with all tags (soundbite, person, season, value, etc.). *Why it matters:* `<podcast:soundbite>` is a publisher-sanctioned clip primitive.
- **Podcast Index API (OpenAPI docs)** — https://podcastindex-org.github.io/docs-api/ — Free, open API for search, episodes-by-feed, recent additions; Amazon-style request auth with key+secret. *Why it matters:* your primary corpus discovery and metadata backbone for 300-500 curated shows.
- **IAB Podcast Measurement Technical Guidelines v2.2** — https://iabtechlab.com/wp-content/uploads/2024/02/PodcastMeasurement_v2.2_pc.pdf — Defines an IAB download as ≥60 seconds requested, server-log-based, with bot filtering (AWS IPs excluded). *Why it matters:* your range-request client behavior determines whether the publisher's analytics count you as a listener — an ethical and relationship issue with publishers.
- **IAB Podcast Technical Measurement Guidelines v2.3 (public comment)** — https://podnews.net/press-release/iab-tech-lab-v23-public — July 2026 update clarifying server-side log measurement for RSS and apps. *Why it matters:* current direction of measurement standards; note "most podcast applications do not provide client-side playback confirmation yet."
- **Dynamic Ad Insertion mechanics (Castos)** — https://castos.com/dynamic-ad-insertion-for-podcasts/ — Explains DAI and confirms timestamps differ per listener: what happens at 15:35 for one listener happens at 15:57 for another. *Why it matters:* directly quantifies the offset-drift problem for your stored segment boundaries.

### 2. Speech Processing

- **WhisperX paper (arXiv 2303.00747)** — https://arxiv.org/abs/2303.00747 — Time-accurate long-form ASR with VAD cut-and-merge + forced phoneme alignment, ~70x real-time batched; word-segmentation benchmarks in Table 2 (Switchboard 93.2%/65.4%, AMI 84.1%/60.3%). *Why it matters:* this is essentially your ingest ASR pipeline described in a paper.
- **WhisperX GitHub** — https://github.com/m-bain/whisperx — Reference implementation with diarization via pyannote. *Why it matters:* the code your coding agent will actually adapt.
- **pyannote.audio GitHub** — https://github.com/pyannote/pyannote-audio — Neural diarization building blocks; community-1 open model + precision-2 premium API. *Why it matters:* speaker labels let you cut on speaker turns and attribute segments.
- **MURMUR: Efficient Inference for Long-Form ASR (arXiv 2606.01483)** — https://arxiv.org/pdf/2606.01483 — Benchmarks WhisperX large-v3 on long-form audio. *Why it matters:* a recent competitive baseline and cost/latency comparison for batch ASR at scale.
- **Chromaprint / AcoustID (official)** — https://acoustid.org/chromaprint — Open-source acoustic fingerprinting; ~100ms to fingerprint a 2-minute file into 2.5KB. *Why it matters:* fingerprinting a stable landmark near your segment lets you realign offsets when DAI shifts them. *Caveat:* tuned for near-identical/music matching, may need adaptation for short spoken clips.
- **How Chromaprint works (creator blog)** — https://oxygene.sk/2011/01/how-does-chromaprint-work/ — Author's own explanation of chroma-feature extraction and bit-error-rate comparison. *Why it matters:* primary technical reference for building offset realignment.

### 3. Topic Segmentation

- **TREC 2020 Podcasts Track Overview (arXiv 2103.15953)** — https://arxiv.org/abs/2103.15953 — Segment retrieval + summarization tasks on 100k+ Spotify episodes. *Why it matters:* the definitive academic framing of your exact problem (retrieving 2-min segments answering a query).
- **TREC Podcasts Track site** — https://trecpodcasts.github.io/ — Task definitions, data description; notes the Spotify dataset is no longer distributed as of Dec 2023. *Why it matters:* task design and evaluation methodology to reuse.
- **Spotify at TREC 2020: Segment Retrieval (NIST)** — https://trec.nist.gov/pubs/trec29/papers/Spotify.P.pdf — BM25/QL + BERT reranking baselines with Pyserini/Anserini. *Why it matters:* concrete first-party retrieval recipes for podcast segments.
- **TreeSeg (arXiv 2407.12028)** — https://arxiv.org/pdf/2407.12028 — Hierarchical topic segmentation of large transcripts, building on embedding-based TextTiling variants (BertSeg, HyperSeg). *Why it matters:* your ingest-time segmentation into self-contained 3-15 min candidates.
- **Recent Trends in Linear Text Segmentation: A Survey (ACL 2024)** — https://aclanthology.org/2024.findings-emnlp.174.pdf — Survey from TextTiling through neural approaches. *Why it matters:* one-stop literature map for choosing a segmentation approach.
- **SEGBOT (IJCAI 2018)** — https://www.ijcai.org/proceedings/2018/0579.pdf — Neural pointer-network segmentation outperforming C99/TextTiling on the Choi dataset. *Why it matters:* a strong supervised baseline if you fine-tune.
- **Spotify: What Makes a Good Podcast Summary?** — https://research.atspotify.com/publications/what-makes-a-good-podcast-summary — Studies correlation of automatic metrics with human judgments of podcast summaries. *Why it matters:* informs your LLM-as-judge evaluation of bridge quality.
- **Spotify: Genre-Aware Abstractive Podcast Summarization (arXiv 2104.03343)** — https://arxiv.org/abs/2104.03343 — Genre + named-entity-aware summarization. *Why it matters:* narrative-arc curation and bridge generation.

### 4. Retrieval & Recommendation

- **Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009)** — https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf — Rank-based fusion of multiple retrieval lists (k=60 default, no tuning); shows RRF "consistently yields better results than any individual system, and better results than the standard method Condorcet Fuse." *Why it matters:* the fusion algorithm for your hybrid retrieval, and the citation every vector DB uses.
- **Hybrid Search reference (Digital Applied)** — https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026 — Complete reference on BM25 + dense + RRF + cross-encoder reranking, noting RRF is the default in Elasticsearch, OpenSearch, Weaviate, Qdrant, and Azure AI Search. *Why it matters:* an implementation checklist for hybrid retrieval.
- **Spotify: Recommending Podcasts for Cold-Start Users (arXiv 2007.13287)** — https://arxiv.org/abs/2007.13287 — Uses music-listening behavior to infer podcast preferences for new users; Nazari et al. report "significant improvements in consumption of up to 50% for both offline and online experiments" across "more than 200k podcasts." *Why it matters:* cold-start onboarding strategy.
- **Spotify: Optimizing for the Long-Term Without Delay** — https://research.atspotify.com/2023/07/optimizing-for-the-long-term-without-delay — Uses intermediate outcomes to address item cold-start when long-term signals are delayed. *Why it matters:* how to learn from implicit signals faster.
- **Spotify: Cold-Starting Podcast Ads and Promotions with Multi-Task Learning (arXiv 2601.02306)** — https://arxiv.org/html/2601.02306 — Multi-task/transfer learning to mitigate cold-start. *Why it matters:* modern architecture for your recommendation engine.

### 5. Audio Assembly & Playback

- **Apple AVFoundation Editing Guide** — https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/AVFoundationPG/Articles/03_Editing.html — AVMutableComposition composes tracks from multiple assets; AVMutableAudioMix for per-track volume. *Why it matters:* the core API for stitching multi-source segments client-side.
- **Apple Developer Forum — AVQueuePlayer gapless playback** — https://developer.apple.com/forums/thread/111413 — Practitioners note small gaps between remote MP3s in AVQueuePlayer. *Why it matters:* warns that naive queueing produces audible gaps; you likely need composition or buffered rendering.
- **Apple Developer Forum — Multiple AVPlayer instances + AirPlay 2** — https://developer.apple.com/forums/thread/105877 — Only one player can play through AirPlay 2; must mix via AVMutableComposition or AVSampleBufferAudioRenderer. *Why it matters:* a concrete architectural constraint for bridge+segment mixing.
- **StreamingKit (GitHub)** — https://github.com/asurasunil/StreamingKit — Gapless audio streaming library supporting HTTP progressive download and differing formats. *Why it matters:* an alternative to AVFoundation for gapless streaming of heterogeneous CDN sources.
- **AES TD1004.1.15-10 — Loudness for streaming/network playback** — https://www.aes.org/technical/documents/AESTD1004_1_15_10.pdf — Recommends target between -16 and -20 LUFS, -1 dBTP limiter, and explicitly to "avoid loudness jumps when external material is inserted." *Why it matters:* the standard you apply per-segment so stitched clips don't jar.
- **AES Loudness Normalization overview** — https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/ — Explains upward/downward normalization workflows for batch processing. *Why it matters:* batch-normalize segments at ingest. *Note:* Apple Podcasts targets -16 LUFS stereo / -19 LUFS mono; Spotify normalizes to ~-14 LUFS.

### 6. TTS & AI Narration

- **NotebookLM Audio Overviews (Google blog)** — https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews/ — Two AI hosts generate a conversational "deep dive" from uploaded sources. Google states the feature "is still experimental and has limitations, such as inaccuracies and the inability to interrupt the AI hosts," and by December 2024 reported users had generated "more than 350 years worth of Audio Overviews." *Why it matters:* the leading shipped prior art for AI-narrated audio, and a model for disclosure language.
- **TTS Arena V2 (Hugging Face)** — https://huggingface.co/spaces/TTS-AGI/TTS-Arena-V2 — Crowdsourced blind Elo leaderboard for TTS naturalness, with V2 adding conversational/podcast-style content. *Why it matters:* the open benchmark for picking a narrator voice model.
- **Amazon Polly pricing (official)** — https://aws.amazon.com/polly/pricing/ — Standard $4, Neural $16, Generative $30, Long-Form $100 per 1M characters. *Why it matters:* cheapest scalable option for bridges.
- **OpenAI TTS pricing** — https://community.openai.com/t/new-tts-api-pricing-and-gotchas/1150616 — tts-1 $15/1M chars, tts-1-hd $30/1M, gpt-4o-mini-tts token-based (~$0.60/1M input tok + $12/1M audio-out tok, ≈$0.015/min) with steerable tone via an instructions parameter. *Why it matters:* mid-tier with instruction-based prosody control for narrator style.
- **ElevenLabs pricing (official)** — https://elevenlabs.io/pricing — Subscription/credit model, ~$0.05-0.10 per 1K characters effective, best naturalness and prosody. *Why it matters:* premium option where bridge quality matters most.

### 7. Prior Art & Postmortems

- **Snipd** — https://www.snipd.com/ — AI podcast player with in-episode "snips," transcripts, chapters. *Why it matters:* the leading surviving clip app — note it clips within one episode and its own blog admits "dynamic ads break transcript synchronization."
- **Snipd blog — Airr sunset & DAI problem** — https://www.snipd.com/blog/how-to-include-podcasts-in-pkm-workflow — Confirms Airr (first mover) shut down and that DAI misaligns audio-to-transcript timing. *Why it matters:* a competitor's own admission of the exact DAI risk to your product.
- **Overcast clip sharing (Marco Arment blog)** — https://marco.org/2019/04/27/overcast-clip-sharing — Founder announcing that "you can now share audio or video clips, up to a minute each, from any public podcast"; his stated rationale for the one-minute cap was "fair use," attention spans in social feeds, and matching Instagram's video limit. *Why it matters:* how a respected player deliberately scoped clipping to stay publisher-friendly and within fair use.
- **Podcast App Graveyard (Transistor)** — https://transistor.fm/podcast-apps-gone/ — Catalog of dead apps: Breaker, Stitcher, Google Podcasts, RadioPublic, Shuffle ("community-curated short clips"). *Why it matters:* pattern recognition — social/clip apps repeatedly failed.
- **Twitter acquires Breaker (TechCrunch)** — https://techcrunch.com/2021/01/04/twitter-acquires-social-podcasting-app-breaker-team-to-help-build-twitter-spaces/ — Breaker acqui-hired; app slated to shut down (later kept alive briefly under Maple Media). *Why it matters:* TechCrunch's read that "podcasting services and podcasting content only [have] so much value."

### 8. Legal / Policy Landscape

- **Hunley v. Instagram (9th Cir. 2023, official opinion)** — https://cdn.ca9.uscourts.gov/datastore/opinions/2023/07/17/22-15293.pdf — Reaffirms the server test in the 9th Circuit while noting district courts (Nicklen, Goldman, Leader's Institute) have rejected it, and distinguishes that "the performance of an audiovisual work does not require a copy." *Why it matters:* the current controlling authority — and its own acknowledgment that the display-right server test may not extend to the performance of audio/audiovisual works, which is exactly what streaming stitched clips does.
- **Perfect 10 v. Amazon (Wikipedia summary)** — https://en.wikipedia.org/wiki/Perfect_10,_Inc._v._Amazon.com,_Inc. — Origin of the server test: inline linking to third-party-hosted content is not direct infringement of the display right. *Why it matters:* the best-case precedent for a "pointers" model — but a display-right, not performance-right, case.
- **Goldman v. Breitbart analysis (Loeb & Loeb)** — https://www.loeb.com/en/insights/publications/2018/02/goldman-v-breitbart-news-network-llc — SDNY rejected the server test for embedded tweets. *Why it matters:* the leading contradicting authority — embedding third-party-hosted media can infringe even without hosting a copy.
- **Fordham Law Review — "Now on Display: In-Line Linking in the Age of the Server Test"** — https://fordhamlawreview.org/issues/now-on-display-in-line-linking-in-the-age-of-the-server-test/ — Scholarship critical of the server test, tracing how it has been "critiqued by scholars and copyright holders." *Why it matters:* rigorous framing of why the pointers model is legally contested.
- **Podcast Namespace Issue #254 — DAI breaks timestamps** — https://github.com/Podcastindex-org/podcast-namespace/issues/254 — Standards community documenting that DAI shifts all timestamps per download, breaking transcripts/chapters/soundbites ("all of the times might be shifted by the ads"). *Why it matters:* the authoritative technical statement of your offset-drift risk, plus a proposed reconstruction approach.
- **Pocket Casts Android Issue #2093 — chapters wrong under DAI** — https://github.com/Automattic/pocket-casts-android/issues/2093 — Real bug: chapters off by ~2 minutes, "different for every download." *Why it matters:* concrete proof the problem bites even mature apps.
- **Podnews — Megaphone added to ad-block lists** — https://podnews.net/update/megaphone-block-list — A major host blocked by ad-blockers (Brave, NextDNS, uBlock Origin) over data/ads. *Why it matters:* evidence of active ecosystem tension over ad-stripping and listener data.
- **Creative Commons Podcasting Legal Guide** — https://wiki.creativecommons.org/wiki/Podcasting_Legal_Guide — Fair use four-factor framework applied to podcasts. *Why it matters:* baseline fair-use analysis for excerpting.

### 9. LLM Pipeline Engineering

- **LLM-as-a-Judge complete guide (Evidently AI)** — https://www.evidentlyai.com/llm-guide/llm-as-a-judge — Treats building a judge as a small ML project starting from a labeled dataset. *Why it matters:* how to evaluate bridge quality and segment coherence at scale.
- **A Survey on LLM-as-a-Judge (ScienceDirect)** — https://www.sciencedirect.com/science/article/pii/S2666675825004564 — Taxonomy of judging methods, biases, and pipeline design. *Why it matters:* rigorous grounding for your evaluation harness.
- **LLM-as-a-Judge best practices (DeepEval)** — https://deepeval.com/blog/llm-as-a-judge — Covers prompt regression testing, CI/CD integration, G-Eval, DAG metrics. *Why it matters:* prompt regression testing for your segmentation/curation prompts.
- **Evaluating Scoring Bias in LLM-as-a-Judge (arXiv 2506.22316)** — https://arxiv.org/pdf/2506.22316 — Documents systematic biases in LLM judges. *Why it matters:* caveats when trusting automated quality scores.

## Recommendations

**Stage 1 — De-risk the two existential assumptions before building the full pipeline.**

- Build a DAI-realignment spike first. Ingest 20 shows known to use DAI, fingerprint a stable landmark near each segment boundary with Chromaprint, and measure how often you can recover the correct offset at playback time. Benchmark to change the plan: if you cannot reliably realign >95% of segments, pivot to caching/normalizing your own stored copy — which materially changes the legal analysis.
- Get a written legal opinion on the performance-right question specifically for audio, not images. Trigger to stop: if counsel concludes that streaming stitched third-party audio is a public performance requiring licenses, the "no re-hosting" architecture provides little protection and you should pursue publisher agreements. The Hunley opinion's own line that performance "does not require a copy" is the crux — the server test that protects image embedders may not save you.

**Stage 2 — Build ingestion and segmentation on proven components.** WhisperX + pyannote for ASR/diarization; prefer publisher transcripts + forced alignment when available (cheaper, more accurate, and lower legal friction than re-transcribing). Use TreeSeg-style embedding segmentation, snap to VAD silence, and store multiple candidate boundaries per topic.

**Stage 3 — Retrieval and curation.** Hybrid BM25 + dense with RRF (k=60 default); cross-encoder rerank the top ~100. Cold-start onboarding via explicit topic picks plus any music/behavioral priors per the Spotify cold-start work.

**Stage 4 — Assembly and playback.** Normalize every segment to -16 LUFS / -1 dBTP at ingest. Use AVMutableComposition (not naive AVQueuePlayer queueing) to avoid gaps and support AirPlay 2. Generate bridges with a mid-tier TTS (OpenAI gpt-4o-mini-tts or Polly Generative) and A/B against ElevenLabs on the segments that matter most.

**Stage 5 — Evaluation and disclosure.** Stand up an LLM-as-judge harness for segment self-containedness and bridge coherence, with prompt regression tests in CI. Clearly disclose AI narration, following NotebookLM's "experimental / may contain inaccuracies" framing.

**Publisher relations benchmark:** proactively engage 5-10 pilot publishers. If they object to your download/measurement footprint or clipping, treat that as a leading indicator and move to an opt-in/licensed model before scaling to 300-500 shows.

## Caveats

- Several TTS price points (Azure, ElevenLabs, Gemini) were sourced partly from third-party trackers and should be verified against official vendor pricing pages before you rely on them.
- The Spotify English-Language Podcast Dataset used by the TREC track is no longer distributed (as of December 2023), so those papers are methodologically useful but the data is not directly obtainable.
- The legal sources describe an unsettled and jurisdiction-dependent area; nothing here is legal advice, and the image-embedding "server test" precedent may not transfer to audio because streaming implicates the performance right, not the display right.
- Chromaprint is tuned for near-identical/music matching; its fit for short spoken-word clip realignment is unproven and flagged as a research task.
- Some cited engineering blogs and vendor explainers are secondary; primary court opinions, arXiv papers, official API docs, and standards documents should be treated as authoritative where they conflict.
