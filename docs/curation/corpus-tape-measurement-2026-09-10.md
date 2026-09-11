# G-18 · Does the corpus hold more tape for the two fixed prompts? (measured)

> Card G-18 of `docs/curation/foray-to-spec-roadmap.md` §4. Companion to `docs/curation/corpus-integration-brief.md` (schema, supply and crawl-health numbers). Read-only session as `wyatt_readonly` against `foraycorpus` on 100.79.104.9 (PostgreSQL 17.11), DB clock UTC, queries ran **2026-09-11 05:22–06:15 UTC** (the roadmap is dated 2026-09-10; the crawler was running throughout, so counts drift ~0.01 % between passes — e.g. 1,167,041 → 1,167,148 episode rows with a timed transcript or audio asset across four passes). Nothing was written to the DB (session-local temp tables only). No transcript bodies were fetched; no model call was made.

Every number is tagged **[measured]** (a query result), **[sampled]** (a random draw the reader can re-run), **[judged]** (my reading of a sampled description) or **[inferred]** (arithmetic or an assumption stated inline).

---

## 0. TL;DR — the answer to D0's "≥ 3 shows with ≥ 20 timed+audio episodes per prompt node"

| prompt | today's tape | corpus, transcript-only | corpus, transcript **and** audio URL | verdict |
|---|---|---|---|---|
| **1 · AI systems built and deployed** (`engineering/ai-robotics`) | Practical AI, 63 bodies | **≥ 6 human-hosted shows with ≥ 20 on-topic timed episodes** (Data Engineering Podcast 514, Agentic Conversations/MLOps.community 392, AI Engineering Podcast 74, Industrial AI 64, Microsoft Mechanics 30, Generative AI Meetup 25, NEJM AI Grand Rounds 20 — strict-term timed counts [measured]) plus 4–5 synthetic/AI-generated shows the pipeline should exclude | **0 shows** where ≥ 25 % of episodes match and ≥ 20 of those carry an audio URL [measured]. The only audio-bearing hits are Bloomberg/iHeart business-news shows where AI is a market story (Stock Movers 47, Better Offline 40, Bloomberg Tech 23, Odd Lots 22 strict timed+audio) — judged 0/10 on-topic for "how ML gets deployed" | **No** as the corpus stands; **Yes (≥ 6 shows) the day the primary `<enclosure>` is captured**, because every one of those shows publishes audio — the gap is the crawler's, not the publishers' |
| **2 · engineering disasters / what actually broke** (`engineering/disasters`) | Causality, 12 bodies + pool segments | PreAccident Investigation Podcast 164 timed (safety science, not disaster narrative), Safe As 83, Causality 12 — all 0 audio | **1 show**: *Cautionary Tales with Tim Harford* — 232 timed+audio on Omny; ≈ 5 of 12 sampled episodes are engineering-relevant failure narratives [judged] → ≈ 100 usable episodes [inferred] | **No.** The known disaster shows are either absent (*Well There's Your Problem*, *Black Box Down* 0 episodes, *Mayday: Air Disaster* 0) or transcript-less (*Disaster Area* 288 episodes / 0 timed, *Swindled* 161 / 0, *American Scandal* 163 / 0). Enclosure capture would not change this answer |

Two corpus facts that frame both rows: **Practical AI has 0 episodes in the corpus** (two `podcasts` rows, ids 374254 and 4365945, both `english_candidate_status='yes'`, neither feed crawled) [measured], so the corpus is not a superset of today's tape for prompt 1; and `episodes.primary_asset_id` is null on **all** 7.81 M episodes (re-verified, 44 s count) and on all 88,043 episodes of the 50 top-25 shows below [measured] — "has audio" throughout this doc means an `<podcast:alternateEnclosure>` row, which only Omny/iHeart/Audacy-style feeds publish (audio hosts `podtrac.com`, `traffic.omny.fm`, `mgln.ai`, `p.podderapp.com`, `pdst.fm`). DAI tier for those is **unknown** (G-19 measures it).

**Recommendation for D0.** Keep the "≥ 3 shows with ≥ 20 timed+audio episodes" target for prompt 1 but make it conditional on G-10 capturing `<enclosure>` (or on 4a fetching the ≥ 6 shows' feeds itself, which `sweep-transcripts.mjs` already does for 220 shows); **waive or rewrite the target for prompt 2** — the corpus route yields one show, so Phase 1 does not change prompt 2's supply, and a hand-curated feed list (Cautionary Tales + PreAccident + Causality + the transcript-less disaster shows via ASR) is the realistic path.

---

## 1. Frame — what was searched

- **Candidate shows:** English (`podcasts.english_candidate_status='yes'`) podcasts with **≥ 5 episodes carrying a timed transcript** (`assets.asset_type='transcript'`, mime in text/vtt, application/srt, application/x-subrip, application/json, text/srt, application/vtt and the two leading-slash variants). **2,086 shows** [measured]; 1,549 of them have ≥ 20 timed, **441 have ≥ 20 timed + audio**. Σ timed episodes 496,441; Σ timed+audio 343,543. (The corpus brief counted 1,560 / 1,207 / 409 on 2026-09-10 03:40 UTC; the crawl has grown since — with no floor the English ≥ 1-timed count is now 2,749 shows vs 1,967 then.)
- **Episode text:** `episodes.canonical_title || ' ' || left(episodes.description, 4000)` for every episode of those shows — **775,654 episodes**, 770,083 with a non-empty description, 496,441 with a timed transcript, 343,543 timed + audio [measured]. `episodes` is indexed by `podcast_id`, so this was an index fetch, not a scan; `assets` (no index on `asset_type`) was scanned once (~7 s).
- **Show-level signal:** `podcast_feeds.categories` (iTunes tree) and PodcastIndex `category1..10` from `podcast_source_records.extra_source_json` via `podcast_source_links.podcast_source_record_id`. All 2,086 candidate shows carry at least one; **186 carry "Technology"**, 15 of those have ≥ 20 timed+audio [measured]. Category is far too coarse to pick either prompt's node (Technology ⊃ crypto, Apple tips, gadgets), so it is reported per show, not used as a filter.
- **Term lists.** `data/taxonomy.json` nodes carry **no `terms[]`** (the card assumed they do; nodes have `id, parent, label, apple_anchor, weight, confidence, last_evidence_at` only). The vocabulary therefore came from `data/semantic-index.json` concepts mapped to the nodes — `ai`, `llms`, `data-centers`, `robotics` → `engineering/ai-robotics`; `engineering-failures` → `engineering/disasters` — widened with the obvious phrase forms. Three tiers, all case-insensitive PostgreSQL regexes with `\m…\M` word boundaries (multi-word phrases, so `ai` never matches inside "said"):
  - **strict** (the prompt's core): P1 = machine learning, deep learning, MLOps, ML engineering/platform, data engineering, data pipeline(s), feature store(s), model training, training data, fine-tun(e/ed/ing), inference, model deployment, deploy(ing) a model/LLM, Kubernetes, retrieval-augmented, vector database(s), embeddings, foundation model(s), large language model(s), LLM(s), neural network(s), computer vision, reinforcement learning, AI agent(s), agentic, GPU(s), MLflow, PyTorch, TensorFlow, Hugging Face (32 terms). P2 = engineering failure(s)/disaster(s), bridge/building collapse, structural failure/collapse, OceanGate, Titan submersible, design flaw(s), safety engineering, failure analysis, root cause, post-mortem, derailment, crash investigation, air/plane crash, dam failure/break/burst, nuclear accident, reactor meltdown, Chernobyl, Three Mile Island, Fukushima, Deepwater Horizon, Hyatt Regency, Tacoma Narrows, 737 MAX, Boeing, Challenger disaster, space shuttle, Columbia disaster, NTSB, Chemical Safety Board, Bhopal, Grenfell, Piper Alpha, industrial accident, mine disaster, levee, incident report, what went wrong, why it failed, failed bridge/dam/reactor/design, human factors, safety culture (43 terms).
  - **strong** (strict + brand and topic words that also occur in general news): P1 adds artificial intelligence, ChatGPT, OpenAI, Anthropic, generative AI, data science, transformers, diffusion models, self-driving, autonomous vehicle(s), robotics, Nvidia; P2 adds collapse(d), submersible, derail(ed), meltdown, catastroph(e/ic), explosion/exploded, recall(s), outage, investigation, Challenger, Columbia.
  - **any** = strong ∪ weak single words (P1: ai, robot(s), automation, data center(s), cloud, compute, algorithm(s); P2: failure(s), failed, crash(es/ed), disaster(s), accident(s), outage(s), safety, maintenance, malfunction, broke). Reported only as an upper bound.
- **Cost:** the six regexes over 775,654 rows took 40–81 s each at `statement_timeout = 120000` (one combined statement timed out and was split); everything else is sub-second on temp tables. Full SQL in the appendix.

---

## 2. Totals per prompt [measured]

| | prompt 1 · AI systems | prompt 2 · engineering disasters |
|---|---|---|
| episodes matching **strict** | **6,607** in **541** shows | **3,112** in **691** shows |
| … of which with a timed transcript | 4,528 | 2,086 |
| … of which timed **and** audio URL | **346** | **1,386** |
| episodes matching **strong** | 17,802 in 1,076 shows (timed 12,357; timed+audio 3,829) | 18,954 in 1,413 shows (timed 13,370; timed+audio 8,848) |
| episodes matching **any** (upper bound) | 46,269 in 1,550 shows | 54,138 in 1,849 shows |

**Depth per show** (the D0 question), strict tier [measured]:

| | prompt 1 | prompt 2 |
|---|---|---|
| shows with ≥ 20 strict-matching **timed** episodes | 45 | 19 |
| shows with ≥ 20 strict-matching **timed + audio** episodes | 4 | 15 |
| … and ≥ 25 % of the show's episodes match (i.e. the show is *about* the node) — timed | 21 | 1 (The Root Cause Rx — a functional-medicine show; false positive on "root cause") |
| … ≥ 25 % — timed + audio | **0** | **0** |
| … ≥ 50 % — timed / timed + audio | 8 / 0 | 1 / 0 |
| same four rows on the **strong** tier (≥ 20 timed / ≥ 20 timed+audio / ≥ 50 % timed / ≥ 50 % timed+audio) | 122 / 33 / 28 / 0 | 139 / 100 / 1 / 0 |

Reading: the audio-bearing half of the corpus is iHeart/Bloomberg/Audacy daily radio on Omny (485 of the 2,086 candidate shows, holding 343,299 of the 496,441 timed episodes — 69 % [measured]); topic words land there as headlines, not as subject. The subject-matter shows for both prompts sit on Spotify-for-Podcasters, Podhome, Podbean, Libsyn, Podigee — hosts whose feeds carry `<podcast:transcript>` but no `alternateEnclosure`, so the corpus records their transcripts and no audio.

Transcript hosts of the candidate shows [measured]: api.omny.fm 485 shows / 343,299 timed; transcript-files.spotifycdn.com 443 shows / 48,569 timed; mcdn.podbean.com 268 shows / 14,173 timed; static.libsyn.com 232 shows / 13,345 timed; www.buzzsprout.com 130 shows / 10,022 timed; rss.flightcast.com 75 shows / 14,246 timed; transcripts.blubrry.com 63 shows / 4,166 timed; data-1.podcastai.com 29 shows / 5,820 timed.

---

## 3. Prompt 1 — top 25 shows by strict-matching timed episodes [measured]

"strong timed" is the wider tier for comparison; "% strict" = strict hits ÷ all episodes of the show (how much the show is *about* the node). Host column: transcript host, tagged omny/other; audio host where an `alternateEnclosure` exists. DAI tier is unknown for every row.

| # | show (podcast_id) | episodes | timed | timed+audio | strict hits | strict timed | strict timed+audio | strong timed | % strict | transcript host / audio host | feed categories | PI cats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Data Engineering Podcast (339647) | 516 | 514 | 0 | 516 | 514 | 0 | 514 | 100.0 | other (assets.podhome.fm) | Education; Technology | education,technology |
| 2 | AI Podcast Summaries from Transcripted.ai (VIDEO) (4401380) | 5612 | 5612 | 0 | 418 | 418 | 0 | 791 | 7.4 | other (img.transcripted.ai) | News>Daily News | daily,news |
| 3 | Agentic Conversations (formally mlops.community) (23485) | 548 | 394 | 0 | 545 | 392 | 0 | 393 | 99.5 | other (transcript-files.spotifycdn.com) | Technology | technology |
| 4 | AI Post Transformers (4343749) | 891 | 394 | 0 | 802 | 371 | 0 | 384 | 90.0 | other (podcast.do-not-panic.com) | Technology | technology |
| 5 | The Automated Daily - AI News Edition (3665327) | 107 | 107 | 0 | 105 | 105 | 0 | 107 | 98.1 | other (theautomateddaily.com) | Technology | technology |
| 6 | Run the Numbers (3722470) | 318 | 263 | 0 | 103 | 101 | 0 | 130 | 32.4 | other (transcript-files.spotifycdn.com) | Business>Management | business |
| 7 | The Automated Daily - Hacker News Edition (3652855) | 106 | 106 | 0 | 85 | 85 | 0 | 94 | 80.2 | other (theautomateddaily.com) | Technology | technology |
| 8 | AGI Dreams – Open, Uncensored, & Local - AI News Digest (4517764) | 298 | 150 | 0 | 187 | 78 | 0 | 90 | 62.8 | other (agidreams.us) | Technology | technology |
| 9 | AI Engineering Podcast (3210524) | 79 | 74 | 0 | 79 | 74 | 0 | 74 | 100.0 | other (assets.podhome.fm) | Education; Technology | education,technology |
| 10 | Best of LinkedIn: Strategic B2B Marketing (4245523) | 232 | 187 | 0 | 71 | 66 | 0 | 110 | 30.6 | other (main.podigee-cdn.net) | Business>Management; Business>Marketing; Technology | business,management,marketing,technology |
| 11 | Industrial AI Podcast (663916) | 352 | 110 | 0 | 128 | 64 | 0 | 78 | 36.4 | other (main.podigee-cdn.net) | Business>Management; Science>Natural Sciences; Technology | business,management,natural,science,tech |
| 12 | Models & Agents (4584443) | 168 | 152 | 0 | 79 | 63 | 0 | 115 | 47.0 | other (nerranetwork.com) | News>Tech News; Technology | news,technology |
| 13 | Transform NOW (300909) | 515 | 150 | 0 | 99 | 56 | 0 | 80 | 19.2 | other (transcript-files.spotifycdn.com) | Business | business |
| 14 | The Feed & The Thread (4495695) | 241 | 241 | 0 | 53 | 53 | 0 | 71 | 22.0 | other (castopod.gogomito.com) | Arts>Design; Business; News>Tech News | arts,business,design,news |
| 15 | Bankless (300054) | 1334 | 1124 | 0 | 58 | 51 | 0 | 89 | 4.3 | other (rss.flightcast.com) | News>Tech News; Technology | news,technology |
| 16 | Stock Movers (4152642) | 2973 | 2970 | 2970 | 47 | 47 | 47 | 797 | 1.6 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | business,news |
| 17 | .NET Rocks! (590529) | 2012 | 182 | 0 | 84 | 44 | 0 | 54 | 4.2 | other (transcription.spreaker.com) | Technology>Software How-To | how to,technology |
| 18 | The Automated Daily - Space News Edition (4190599) | 100 | 100 | 0 | 43 | 43 | 0 | 44 | 43.0 | other (theautomateddaily.com) | Science>Astronomy | astronomy,science |
| 19 | Better Offline (3761410) | 269 | 269 | 269 | 40 | 40 | 40 | 134 | 14.9 | omny (api.omny.fm) / audio via podtrac.com | Technology | technology |
| 20 | The Delphi Podcast (970126) | 486 | 486 | 0 | 39 | 39 | 0 | 54 | 8.0 | other (www.buzzsprout.com) | Technology | technology |
| 21 | Deep Dive (3974850) | 407 | 404 | 0 | 36 | 36 | 0 | 42 | 8.8 | other (podcast.safeserver.de) | Technology | technology |
| 22 | Bitcoin Audible (845405) | 1402 | 1402 | 0 | 36 | 36 | 0 | 42 | 2.6 | other (feeds.fountain.fm) | Technology | technology |
| 23 | The AI News Daily Brief (3997496) | 252 | 252 | 0 | 36 | 36 | 0 | 169 | 14.3 | other (data-1.podcastai.com) | News>Tech News; Technology | news,technology |
| 24 | AI Visibility Podcast with Jason T Wade of BackTier (4279371) | 216 | 105 | 0 | 72 | 35 | 0 | 65 | 33.3 | other (transcript-files.spotifycdn.com) | Technology | technology |
| 25 | Elon Musk Podcast (667203) | 1508 | 1330 | 0 | 59 | 35 | 0 | 216 | 3.9 | other (transcript-files.spotifycdn.com) | Technology | technology |

Notes on the table [judged from show descriptions in `podcasts.description`]: *AI Podcast Summaries from Transcripted.ai*, *AI Post Transformers* ("AI-generated podcast where hosts Hal Turing and Dr. Ada Shannon…"), *Deep Dive* ("LLM-generated podcast episodes"), *The Automated Daily* (three editions), *The AI News Daily Brief* / *The OpenAI Daily Brief* / *The Anthropic AI Daily Brief* (podcastai.com) and *AGI Dreams* are synthetic or narrated-digest feeds — high term density, zero audio, and not tape a Foray should quote as a human voice. Excluding them leaves, in strict-timed order: Data Engineering Podcast 514, Agentic Conversations (mlops.community) 392, Run the Numbers 101 (CFO/finance-ops, borderline), AI Engineering Podcast 74, Best of LinkedIn 66 (marketing, off-node), Industrial AI Podcast 64, Models & Agents 63, Transform NOW 56, The Feed & The Thread 53, Bankless 51 (crypto), .NET Rocks! 44, Better Offline 40 (audio), The Delphi Podcast 39 (crypto), Bitcoin Audible 36, Tech Lead Journal 35, Redefining AI 34, Python Bytes 34, Talk Python 33, Microsoft Mechanics 30.

**Same ranking restricted to timed + audio** [measured] — the rows a Foray could actually play today:

| # | show (podcast_id) | episodes | timed | timed+audio | strict hits | strict timed | strict timed+audio | strong timed | % strict | transcript host / audio host | feed categories | PI cats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Stock Movers (4152642) | 2973 | 2970 | 2970 | 47 | 47 | 47 | 797 | 1.6 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | business,news |
| 2 | Better Offline (3761410) | 269 | 269 | 269 | 40 | 40 | 40 | 134 | 14.9 | omny (api.omny.fm) / audio via podtrac.com | Technology | technology |
| 3 | Bloomberg Tech (3045263) | 1137 | 1135 | 1135 | 23 | 23 | 23 | 363 | 2.0 | omny (api.omny.fm) / audio via podtrac.com | News>Tech News | news |
| 4 | Odd Lots (2443222) | 1269 | 1265 | 1265 | 22 | 22 | 22 | 70 | 1.7 | omny (api.omny.fm) / audio via podtrac.com | Business>Investing; News>News Commentary | business,investing,news |
| 5 | Bloomberg Talks (3478356) | 3184 | 3173 | 3173 | 16 | 16 | 16 | 170 | 0.5 | omny (api.omny.fm) / audio via podtrac.com | Business; News>Business News | business,news |
| 6 | Unsupervised Learning (658258) | 547 | 128 | 128 | 30 | 13 | 13 | 31 | 5.5 | omny (api.omny.fm) / audio via mgln.ai | Technology | technology |
| 7 | Unsupervised Learning (Member Edition) (2673799) | 100 | 100 | 100 | 12 | 12 | 12 | 28 | 12.0 | omny (api.omny.fm) / audio via mgln.ai | Technology | technology |
| 8 | FEAR & GREED \| Business News (851991) | 5536 | 3013 | 3013 | 11 | 11 | 11 | 133 | 0.2 | omny (api.omny.fm) / audio via p.podderapp.com | Business>Investing; News>Business News | business,investing,news |
| 9 | What's Your Problem? (2838271) | 208 | 208 | 208 | 11 | 11 | 11 | 30 | 5.3 | omny (api.omny.fm) / audio via podtrac.com | Business>Entrepreneurship; Technology | business,entrepreneurship,technology |
| 10 | Rich On Tech (183412) | 550 | 550 | 550 | 10 | 10 | 10 | 69 | 1.8 | omny (api.omny.fm) / audio via podtrac.com | News>Tech News; Technology | news,technology |
| 11 | Stuff To Blow Your Mind (398419) | 3197 | 3195 | 3195 | 9 | 9 | 9 | 36 | 0.3 | omny (api.omny.fm) / audio via podtrac.com | Science>Life Sciences | science |
| 12 | Soul Sessions with Amanda Rieger Green (3469382) | 193 | 193 | 193 | 9 | 9 | 9 | 9 | 4.7 | omny (api.omny.fm) / audio via podtrac.com | Education>Self-Improvement; Religion & Spirituality>Spirituality | education,religion,self improvement,spir |

---

## 4. Prompt 2 — top 25 shows by strict-matching timed episodes [measured]

| # | show (podcast_id) | episodes | timed | timed+audio | strict hits | strict timed | strict timed+audio | strong timed | % strict | transcript host / audio host | feed categories | PI cats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | The Odd Couple with Rob Parker & Kelvin Washington (470188) | 8005 | 8000 | 8000 | 74 | 74 | 74 | 240 | 0.9 | omny (api.omny.fm) / audio via podtrac.com | News>Sports News; Sports>Football | news,sports |
| 2 | Stock Movers (4152642) | 2973 | 2970 | 2970 | 73 | 73 | 73 | 91 | 2.5 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | business,news |
| 3 | The John Kobylt Show (673681) | 3566 | 3103 | 3103 | 72 | 56 | 56 | 182 | 2.0 | omny (api.omny.fm) / audio via podtrac.com | News>Politics | news,politics |
| 4 | Dallas Cowboys Podcasts (635649) | 6658 | 6641 | 6641 | 44 | 44 | 44 | 67 | 0.7 | omny (api.omny.fm) / audio via podtrac.com | News | news |
| 5 | Stugotz and Company LIVE! (348446) | 8732 | 8729 | 8729 | 41 | 41 | 41 | 157 | 0.5 | omny (api.omny.fm) / audio via podtrac.com | Comedy; Sports>Football | comedy,football,sports |
| 6 | Bloomberg Daybreak: US Edition (2512935) | 1782 | 1780 | 1780 | 40 | 40 | 40 | 80 | 2.2 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | news |
| 7 | The Daily Zeitgeist (351805) | 4276 | 4274 | 4274 | 34 | 34 | 34 | 253 | 0.8 | omny (api.omny.fm) / audio via podtrac.com | Comedy; News; Society & Culture | comedy,culture,news,society |
| 8 | Breaking Points with Krystal and Saagar (2348279) | 1668 | 1664 | 1664 | 34 | 34 | 34 | 163 | 2.0 | omny (api.omny.fm) / audio via podtrac.com | Government; News>Politics; Society & Culture>Philosophy | culture,government,news,philosophy,polit |
| 9 | Fitzy, Wippa & Kate (260592) | 5849 | 5848 | 5848 | 33 | 33 | 33 | 98 | 0.6 | omny (api.omny.fm) / audio via p.podderapp.com | Comedy; Music | comedy,music |
| 10 | Body Bags with Joseph Scott Morgan (2546601) | 580 | 580 | 580 | 32 | 32 | 32 | 149 | 5.5 | omny (api.omny.fm) / audio via podtrac.com | True Crime | true crime |
| 11 | First Date Follow Up - The Jubal Show (1312327) | 764 | 764 | 764 | 30 | 30 | 30 | 43 | 3.9 | omny (api.omny.fm) / audio via podtrac.com | Comedy; Society & Culture>Relationships | comedy,culture,relationships,society |
| 12 | Bloomberg Surveillance (2443176) | 4683 | 4674 | 4674 | 24 | 24 | 24 | 61 | 0.5 | omny (api.omny.fm) / audio via podtrac.com | Business>Investing; News>Business News | business,investing,news |
| 13 | Bloomberg Daybreak: Europe Edition (2512936) | 1216 | 1215 | 1215 | 24 | 24 | 24 | 97 | 2.0 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | news |
| 14 | Well Beyond 40 (625273) | 1366 | 1366 | 0 | 24 | 24 | 0 | 34 | 1.8 | other (rss.flightcast.com) | Health & Fitness>Fitness; Health & Fitness>Nutrition | fitness,health,nutrition |
| 15 | Stuff They Don't Want You To Know (267297) | 2097 | 2093 | 2093 | 23 | 23 | 23 | 122 | 1.1 | omny (api.omny.fm) / audio via podtrac.com | Society & Culture | culture,society |
| 16 | Elevate Construction (30228) | 1682 | 1188 | 0 | 22 | 21 | 0 | 51 | 1.3 | other (static.libsyn.com) | Education; Education>How To | education,how to |
| 17 | Crime Stories with Nancy Grace (44958) | 5560 | 5501 | 5501 | 21 | 21 | 21 | 797 | 0.4 | omny (api.omny.fm) / audio via podtrac.com | News; True Crime | news,true crime |
| 18 | AI Podcast Summaries from Transcripted.ai (VIDEO) (4401380) | 5612 | 5612 | 0 | 21 | 21 | 0 | 453 | 0.4 | other (img.transcripted.ai) | News>Daily News | daily,news |
| 19 | The Root Cause Rx (4424616) | 30 | 24 | 0 | 25 | 20 | 0 | 20 | 83.3 | other (transcript-files.spotifycdn.com) | Health & Fitness>Alternative Health | alternative,fitness,health |
| 20 | PreAccident Investigation Podcast (144953) | 600 | 164 | 0 | 23 | 19 | 0 | 82 | 3.8 | other (mcdn.podbean.com) | Government & Organizations | government |
| 21 | Apple News Today (559493) | 1641 | 545 | 0 | 44 | 17 | 0 | 77 | 2.7 | other (news-assets.apple.com) | News>Daily News | daily,news |
| 22 | Elon Musk Podcast (667203) | 1508 | 1330 | 0 | 17 | 16 | 0 | 63 | 1.1 | other (transcript-files.spotifycdn.com) | Technology | technology |
| 23 | Odd Lots (2443222) | 1269 | 1265 | 1265 | 15 | 15 | 15 | 88 | 1.2 | omny (api.omny.fm) / audio via podtrac.com | Business>Investing; News>News Commentary | business,investing,news |
| 24 | The Jesse Kelly Show (346225) | 5077 | 4581 | 4581 | 15 | 15 | 15 | 77 | 0.3 | omny (api.omny.fm) / audio via podtrac.com | News>News Commentary | news |
| 25 | Data Engineering Podcast (339647) | 516 | 514 | 0 | 15 | 15 | 0 | 25 | 2.9 | other (assets.podhome.fm) | Education; Technology | education,technology |

The strict list is sports "what went wrong", Boeing stock moves and talk-radio crime; the strong tier (not shown; 40 rows in `g18-results2.json`) is the same shows plus Nancy Grace. Neither tier surfaces a disaster-narrative show, because those shows' descriptions do not use the vocabulary (see §6). Audio-restricted top 12 [measured]:

| # | show (podcast_id) | episodes | timed | timed+audio | strict hits | strict timed | strict timed+audio | strong timed | % strict | transcript host / audio host | feed categories | PI cats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | The Odd Couple with Rob Parker & Kelvin Washington (470188) | 8005 | 8000 | 8000 | 74 | 74 | 74 | 240 | 0.9 | omny (api.omny.fm) / audio via podtrac.com | News>Sports News; Sports>Football | news,sports |
| 2 | Stock Movers (4152642) | 2973 | 2970 | 2970 | 73 | 73 | 73 | 91 | 2.5 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | business,news |
| 3 | The John Kobylt Show (673681) | 3566 | 3103 | 3103 | 72 | 56 | 56 | 182 | 2.0 | omny (api.omny.fm) / audio via podtrac.com | News>Politics | news,politics |
| 4 | Dallas Cowboys Podcasts (635649) | 6658 | 6641 | 6641 | 44 | 44 | 44 | 67 | 0.7 | omny (api.omny.fm) / audio via podtrac.com | News | news |
| 5 | Stugotz and Company LIVE! (348446) | 8732 | 8729 | 8729 | 41 | 41 | 41 | 157 | 0.5 | omny (api.omny.fm) / audio via podtrac.com | Comedy; Sports>Football | comedy,football,sports |
| 6 | Bloomberg Daybreak: US Edition (2512935) | 1782 | 1780 | 1780 | 40 | 40 | 40 | 80 | 2.2 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | news |
| 7 | Breaking Points with Krystal and Saagar (2348279) | 1668 | 1664 | 1664 | 34 | 34 | 34 | 163 | 2.0 | omny (api.omny.fm) / audio via podtrac.com | Government; News>Politics; Society & Culture>Philosophy | culture,government,news,philosophy,polit |
| 8 | The Daily Zeitgeist (351805) | 4276 | 4274 | 4274 | 34 | 34 | 34 | 253 | 0.8 | omny (api.omny.fm) / audio via podtrac.com | Comedy; News; Society & Culture | comedy,culture,news,society |
| 9 | Fitzy, Wippa & Kate (260592) | 5849 | 5848 | 5848 | 33 | 33 | 33 | 98 | 0.6 | omny (api.omny.fm) / audio via p.podderapp.com | Comedy; Music | comedy,music |
| 10 | Body Bags with Joseph Scott Morgan (2546601) | 580 | 580 | 580 | 32 | 32 | 32 | 149 | 5.5 | omny (api.omny.fm) / audio via podtrac.com | True Crime | true crime |
| 11 | First Date Follow Up - The Jubal Show (1312327) | 764 | 764 | 764 | 30 | 30 | 30 | 43 | 3.9 | omny (api.omny.fm) / audio via podtrac.com | Comedy; Society & Culture>Relationships | comedy,culture,relationships,society |
| 12 | Bloomberg Daybreak: Europe Edition (2512936) | 1216 | 1215 | 1215 | 24 | 24 | 24 | 97 | 2.0 | omny (api.omny.fm) / audio via podtrac.com | News>Business News | news |

---

## 5. Judged samples — how many matches are on-topic

Each draw is `order by md5(episode_id::text) limit 10` over the stated set, so it is reproducible from the appendix SQL. Descriptions were read in full (up to 700 chars); the verdicts are mine.

**Prompt 1, strict ∧ timed, from the top-25 shows** (n = 10 [sampled]): **6 on-topic, 2 borderline, 2 off** [judged]. On-topic: Data Engineering Podcast "Designing and deploying IoT analytics at Vopak"; .NET Rocks! "Constraining agents for software development"; MLOps.community "GraphBI: GenAI + graph + visual analytics"; AI Post Transformers × 3 ("Splitwise: phase-split LLM inference", "Learning facts at scale with Active Reading", "Computation-bandwidth-memory trade-offs for AI infrastructure") — the three best fits to "engineering behind deploying ML" are from the AI-generated show. Borderline: two news digests (Automated Daily HN "AI agent supply-chain warning & why local LLMs drift"; AGI Dreams daily). Off: Transcripted.ai "How the like button remade attention"; AI Visibility "AI in politics".

**Prompt 1, strict ∧ timed, all 541 shows** (n = 10 [sampled]): **2 on-topic, 2 borderline, 6 off** [judged]. On-topic: Generative AI Meetup "Longcat 1.6T model without US GPUs / Huawei Ascend / OpenAI's inference chip"; Data Engineering Podcast "ScyllaDB". Borderline: Microsoft Mechanics "Azure Copilot Observability Agent"; Bankless "AI alignment at Zuzalu". Off: Gig Gab (a guitar de-feedback plugin — "neural network" in passing), Bitcoin Audible essay, Bloomberg Tech live event, Free Cities freelancing, Stock Movers, Transcripted.ai cosmology summary.

**Prompt 1, strict ∧ timed ∧ audio, all shows** (n = 10 [sampled], the 346-episode playable set): **0 on-topic, 2 borderline, 8 off** [judged]. Borderline: Unsupervised Learning (Member Edition) "Matt Muller from Tines — automation and AI in security operations"; Bloomberg Tech "IBM CEO on managing enterprise AI agents". Off: The Fred Show, Main Street Matters (FreeSpoke vs Big Tech), Stock Movers (Nvidia buys Hugging Face), The Daily Zeitgeist, John Hope Bryant (Juanita AI launch), This Podcast Will Kill You (antibiotics — "training data" in a sponsor read), Ryan Bridge TODAY (NZ orgs depend on LLMs; description empty), Rich On Tech.

**Prompt 2, strict ∧ timed, top-25 shows** (n = 10 [sampled]): **0 on-topic, 1 borderline, 9 off** [judged]. Borderline: Odd Lots "A longtime aerospace analyst questions Boeing's future" (business, not the engineering). Off: Mona Vale light-plane crash witness (breakfast radio), Stock Movers × 2 (Boeing shares), John Kobylt × 2 (talk radio; "300 Boeing planes have a potential fatal flaw" is a headline), The Odd Couple × 2 (Harbaugh firing; Nuggets choke), Stugotz (Colts), First Date Follow Up (ghosting — "what went wrong").

**Prompt 2, strict ∧ timed, all 691 shows** (n = 10 [sampled]): **0 on-topic, 1 borderline, 9 off** [judged]. Borderline: Elon Musk Podcast "SpaceX faces another big Starship problem" (feed-line resonance, TPS tiles — YouTube-style news, no transcript-worthy depth). Off: Microsoft Mechanics observability, sports × 5, Joseph Carlson (Nvidia bubble; "Boeing pleads guilty" chapter), Most Dramatic Podcast Ever (Nascar plane crash headline), Ryan Seacrest (Amazon plane crash, description empty).

**Prompt 2, strict ∧ timed ∧ audio, all shows** (n = 10 [sampled], the 1,386-episode playable set): **0 on-topic, 1 borderline, 9 off** [judged]. Borderline: #RolandMartinUnfiltered "FBI Baltimore bridge collapse probe" (one segment of a news hour). Off: Stock Movers (Boeing cash flow), Odd Couple × 2, Fan Morning Show, ZM's Fletch Vaughan & Hayley ("Hayley in a plane crash fact of the day"), Odd Lots (Embraer origin story — the closest to engineering), Talkin' Cowboys, Bloomberg Talks (Emirates fleet), Best of Both Worlds ("family vacation postmortem").

**Precision summary [judged]:** prompt 1 strict ≈ 40–60 % on-topic when the show is a technology show, ≈ 0–20 % when it is business news; prompt 2 strict ≈ 0–10 % everywhere, because "what went wrong", "Boeing", "root cause", "plane crash" are ordinary news and sports vocabulary. Episode-description term matching **cannot** locate disaster tape; it has to come from show identity (§6).

---

## 6. Show-level pass — searching `podcasts.canonical_title || description` instead [measured]

Over the 2,749 English shows with ≥ 1 timed transcript (no ≥ 5 floor):

- **AI/ML show regex** (machine learning, deep learning, MLOps, ML/AI engineering, data engineering, data science, LLM(s), large language model(s), artificial intelligence, neural network(s), generative AI, AI agent(s), agentic, robotics): **41 shows**; 26 with ≥ 20 timed; **2 with ≥ 20 timed + audio** — and those two are *Smart Talks with IBM* (30, Malcolm Gladwell / IBM marketing) and *Shell Game* (20, a voice-clone documentary). Human-hosted, on-node, transcript-only: Data Engineering Podcast 514, Agentic Conversations 394, Industrial AI 110, AI Engineering Podcast 74, Microsoft Mechanics 72, NEJM AI Grand Rounds 45, Generative AI Meetup 44, AI Infrastructure 42, The AI Engineering Podcast (jellypod, synthetic) 35, AI Master Group 25, Context Window 21.

| show (podcast_id) | timed | timed+audio | transcript host | show description (first 120 chars) |
|---|---|---|---|---|
| Data Engineering Podcast (339647) | 514 | 0 | assets.podhome.fm | This show goes behind the scenes for the tools, techniques, and difficulties associated with the discipline of data engi |
| Python Bytes (863281) | 495 | 0 | pythonbytes.fm | Python Bytes is a weekly podcast hosted by Michael Kennedy and Calvin Hendryx-Parker. The show is a short discussion on  |
| Deep Dive (3974850) | 404 | 0 | podcast.safeserver.de | Kictive, LLM-generated podcast episodes about topics we love. |
| Agentic Conversations (formally mlops.community) (23485) | 394 | 0 | transcript-files.spotifycdn.com | Relaxed conversations and technical deep dives around AI Agents. This Show is brought to you by the Agentic AI Foundatio |
| AI Post Transformers (4343749) | 394 | 0 | podcast.do-not-panic.com | AI-generated podcast where hosts Hal Turing and Dr. Ada Shannon discuss the latest research papers and reports in machin |
| The AI News Daily Brief (3997496) | 252 | 0 | data-1.podcastai.com | A daily news update on the latest in artificial intelligence, covering advancements in AI technology, industry partnersh |
| AGI Dreams – Open, Uncensored, & Local - AI News Digest (4517764) | 150 | 0 | agidreams.us | Listen to regular narrative synthesis and authoritative curation on AI models, open LLMs, and the reasoning future. Each |
| Redefining AI: Leadership, Ethics & the Future of Artif (2882162) | 121 | 0 | transcript-files.spotifycdn.com | Redefining AI is a practical AI podcast for leaders navigating artificial intelligence, from AI leadership and ethics to |
| Industrial AI Podcast (663916) | 110 | 0 | main.podigee-cdn.net | The Industrial AI Podcast reports weekly on the latest developments in AI and machine learning for the engineering, robo |
| AI Engineering Podcast (3210524) | 74 | 0 | assets.podhome.fm | This show is your guidebook to building scalable and maintainable AI systems. You will learn how to architect AI applica |
| Microsoft Mechanics Podcast (44496) | 72 | 0 | static.libsyn.com | Made for tech enthusiasts and IT professionals. Expanded coverage of your favorite technologies across Microsoft; includ |
| Intelligence Snacks (4183834) | 53 | 0 | transcript-files.spotifycdn.com | Intelligence Snacks is a low-fi dialogue with Pete Winn and Andy David. Each week, we share our everyday experiences wor |
| 10 Minute Teacher Podcast with Cool Cat Teacher (705853) | 51 | 0 | static.libsyn.com | A teacher podcast for busy educators—about 10 minutes, every week. Stay current on artificial intelligence in education  |
| AI Daily Briefing (4664359) | 50 | 0 | www.lanternpodcasts.com | AI Daily Briefing is your sharpest weekday source for artificial intelligence news that actually matters to people who b |
| In The Loop (4107896) | 48 | 0 | transcript-files.spotifycdn.com | Stay in the loop with the biggest stories in AI—without the noise and nonsense.Each week, Jack Houghton (CPO at Mindset  |
| NEJM AI Grand Rounds (3210601) | 45 | 0 | mcdn.podbean.com | NEJM AI Grand Rounds, hosted by Arjun (Raj) Manrai, Ph.D. and Andrew Beam, Ph.D., features informal conversations with a |
| The Generative AI Meetup Podcast (3740294) | 44 | 0 | mcdn.podbean.com | Hosted by Mark and Shashank, software engineers and organizers in Silicon Valley. Get their grounded perspective each we |
| AI Infrastructure (4489158) | 42 | 0 | dabase.com | A podcast about Infrastructure & AI engineering techniques |
| Revelizations (3980745) | 39 | 0 | mcdn.podbean.com | Revelizations is a podcast where I will sit down with interesting people about interesting topics and have interesting c |
| The AI Engineering Podcast (4694257) | 35 | 0 | auth.jellypod.ai | A highly-technical, daily show covering all that happened in the world of AI Engineering. Curated from around the intern |
| Chalkboard Chatter Podcast with Candice Nicholson (Jack (4528615) | 31 | 0 | auth.jellypod.ai | Welcome to Chalkboard Chatter, the go-to podcast for K–5 educators, instructional leaders, and curriculum decision-maker |
| Smart Talks with IBM (1227419) | 30 | 30 | api.omny.fm | Join Malcolm Gladwell, author and host of Revisionist History, for Smart Talks with IBM as he speaks with visionaries wh |

- **Disaster/failure show regex** (disaster(s), catastroph-, engineering failure(s), failure(s), accident(s), mayday, black box, air/plane crash, crash investigation, what went wrong, why things fail, well there's your problem, safety, forensic engineering, root cause, incident, meltdown, collapse, explosion, wreck, derail): **52 shows**, 24 with ≥ 20 timed, 6 with ≥ 20 timed + audio, 8 with any audio — but nearly all are false positives (The Jubal Show, It Could Happen Here, a bodybuilding show, D&D actual-plays, a Second Amendment show). The genuine node members:

| show (podcast_id) | episodes | timed | timed+audio | transcript host | P2 strict hits / loose hits† | what it is [judged] |
|---|---|---|---|---|---|---|
| Cautionary Tales with Tim Harford (80677) | 232 | 232 | **232** | api.omny.fm (audio podtrac.com) | 8 / 58 | Narrative "what went wrong" — Costa Concordia, Goiânia radiological accident, AF447 automation, Chuck Yeager's NF-104, V2 rocket, plus frauds, serial killers and crossovers. Of 12 sampled titles [sampled], ≈ 5 are engineering-relevant [judged] |
| PreAccident Investigation Podcast (144953) | 600 | 164 | 0 | mcdn.podbean.com | 23 / 120 | Todd Conklin, human performance and safety culture — discussion, not disaster narrative; many 3-minute "Safety Moment" shorts |
| Safe As Podcast (4245564) | 97 | 83 | 0 | spotifycdn | 14 / 25 | Safety-science paper discussion |
| Causality (742069) | 66 | 12 | 0 | engineered.network | 32 / 58 | Today's tape; the corpus has the same 12 timed episodes and no audio |
| The Industrial Security Podcast (972243) | 148 | 43 | 0 | spreaker | 0 / 2 | ICS security, adjacent |
| Disaster Area (799743) / Swindled (795771) / American Scandal (335368) | 288 / 161 / 163 | 0 / 0 / 0 | 0 | — | — | Present with episodes, **no transcript URL** |
| Black Box Down (619269), Mayday: Air Disaster (3257362), Cautionary Tales (3196760 dup), Failure to Launch × 2 | 0 | 0 | 0 | — | — | `podcasts` row exists, feed never crawled |
| Well There's Your Problem | — | — | — | — | — | No `podcasts` row found by exact title |

† loose = disaster(s), catastroph-, failure(s), failed, accident(s), crash-, collapse-, explosion, sank/sinking, fire, wreck, went wrong, meltdown — over title + full description of every episode of that show [measured].

---

## 7. What this means for the roadmap

1. **Prompt 1 is a supply problem the corpus can solve only after the `<enclosure>` gap closes.** ≈ 1,100 human-hosted, on-node, timed episodes across ≥ 6 shows exist as transcript URLs today [measured: 514 + 392 + 74 + 64 + 30 + 25 + 20 = 1,119 strict-timed]; none has an audio URL in the corpus, all certainly have one in their RSS. Either G-10 asks Joey to store `<enclosure>` (a one-line ingest change per corpus brief §3), or 4a keeps its own `sweep-transcripts.mjs` path for a hand-picked list of these feeds. Until then Practical AI (absent from the corpus) stays the only playable AI-systems show, and M4's 25 % single-show cap fails by arithmetic exactly as F-70 says.
2. **Prompt 2 is not a supply problem the corpus can solve at all.** One audio-bearing show (Cautionary Tales, ≈ 100 relevant episodes [inferred]), three transcript-only safety-discussion shows, and the actual disaster-narrative shows either uncrawled or transcript-less. The path is ASR on a curated list (Disaster Area 288, Swindled 161, American Scandal 163 episodes are already in the corpus as URLs — once enclosures exist) — i.e. the transcript-farm route, not the corpus route. D0 should waive or rewrite prompt 2's "≥ 3 shows" half.
3. **Synthetic feeds need a flag before any corpus backfill.** At least 9 of the prompt-1 top-40 are AI-generated or narrated digests [judged from show descriptions]; they are the densest term matches and would dominate a naive BM25 sourcing pass. `podcasts.description` self-declares most of them ("AI-generated", "LLM-generated", "daily brief"); the exporter (G-10) should carry a `synthetic_suspected` flag from a description regex plus the `podcastai.com` / `jellypod.ai` / `transcripted.ai` / `theautomateddaily.com` / `lanternpodcasts.com` transcript-host list.
4. **Topic depth cannot be measured from descriptions for narrative shows.** Cautionary Tales' descriptions never say "disaster"; they say "an enormous cruise ship is tilting". Per-episode topic assignment (#547) needs transcript text or an LLM pass over descriptions — the corpus's empty `metadata_documents` table is the right landing place, as the corpus brief §4 says.

---

## Appendix — the queries (as run; temp tables are session-local)

```sql
set statement_timeout = 120000;

-- 1. episode flags from a single assets scan
create temp table t_ep as
select a.owner_id as episode_id,
  bool_or(a.asset_type='transcript' and a.mime_type in ('text/vtt','application/srt','application/x-subrip','application/json','text/srt','application/vtt','/application/srt','/application/vtt')) as timed,
  bool_or(a.asset_type='alternate' and a.mime_type like 'audio/%') as audio,
  min(case when a.asset_type='transcript' and a.mime_type in (...same list...) then substring(a.url from '^https?://([^/]+)') end) as thost,
  min(case when a.asset_type='alternate' and a.mime_type like 'audio/%' then substring(a.url from '^https?://([^/]+)') end) as ahost
from assets a
where a.owner_type='episode' and ((a.asset_type='transcript' and a.mime_type in (...)) or (a.asset_type='alternate' and a.mime_type like 'audio/%'))
group by 1;
create index on t_ep(episode_id);

-- 2. attach podcast_id; English shows with >= 5 timed
create temp table t_ep2 as select t.episode_id, e.podcast_id, t.timed, t.audio, t.thost, t.ahost from t_ep t join episodes e on e.id=t.episode_id;
create temp table t_show as
select e.podcast_id, p.canonical_title,
  count(*) filter (where e.timed) as timed_n, count(*) filter (where e.timed and e.audio) as timed_audio_n,
  mode() within group (order by e.thost) as thost, mode() within group (order by e.ahost) as ahost
from t_ep2 e join podcasts p on p.id=e.podcast_id
where p.english_candidate_status='yes' group by 1,2 having count(*) filter (where e.timed) >= 5;

-- 3. episode text (index on episodes.podcast_id)
create temp table t_text as
select e.id as episode_id, e.podcast_id, coalesce(e.canonical_title,'') as title, left(coalesce(e.description,''),4000) as descr, e.source_published_at
from episodes e where e.podcast_id in (select podcast_id from t_show);

-- 4. term flags (one statement per pair of regexes; the six-regex version exceeded 120 s)
create temp table t_flag1 as select t.episode_id, (t.title||' '||t.descr) ~* $P1_STRONG as p1s, (t.title||' '||t.descr) ~* $P1_WEAK as p1w from t_text t;
create temp table t_flag2 as select t.episode_id, (t.title||' '||t.descr) ~* $P2_STRONG as p2s, (t.title||' '||t.descr) ~* $P2_WEAK as p2w from t_text t;
create temp table t_flag3 as select t.episode_id, (t.title||' '||t.descr) ~* $P1_STRICT as p1x, (t.title||' '||t.descr) ~* $P2_STRICT as p2x from t_text t;
create temp table t_flag as
select t.episode_id, t.podcast_id, a.p1s, a.p1w, b.p2s, b.p2w, d.p1x, d.p2x, coalesce(x.timed,false) as timed, coalesce(x.audio,false) as audio
from t_text t join t_flag1 a using (episode_id) join t_flag2 b using (episode_id) join t_flag3 d using (episode_id) left join t_ep2 x on x.episode_id=t.episode_id;

-- 5. per-show aggregates, categories, top-N, depth, samples
create temp table t_agg as
select s.podcast_id, s.canonical_title, s.timed_n, s.timed_audio_n, s.thost, s.ahost, count(*) as eps,
  count(*) filter (where f.p1x) as p1x_eps, count(*) filter (where f.p1x and f.timed) as p1x_timed, count(*) filter (where f.p1x and f.timed and f.audio) as p1x_timed_audio,
  count(*) filter (where f.p2x) as p2x_eps, count(*) filter (where f.p2x and f.timed) as p2x_timed, count(*) filter (where f.p2x and f.timed and f.audio) as p2x_timed_audio
  -- (same three columns for p1s/p2s and p1a/p2a)
from t_show s join t_flag f on f.podcast_id=s.podcast_id group by 1,2,3,4,5,6;
create temp table t_cat_pi as
select l.podcast_id, string_agg(distinct v, ',') as pi_cats from (
  select l.podcast_id, psr.extra_source_json->>k as v
  from podcast_source_links l join podcast_source_records psr on psr.id=l.podcast_source_record_id
  cross join unnest(array['category1','category2','category3','category4','category5','category6','category7','category8','category9','category10']) k
  where l.podcast_id in (select podcast_id from t_agg)) l where v is not null and v<>'' group by 1;
create temp table t_cat_feed as
select pf.podcast_id, string_agg(distinct coalesce(c->>'category','')||coalesce('>'||nullif(c->>'subcategory',''),''), '; ') as feed_cats
from podcast_feeds pf, json_array_elements(case when json_typeof(pf.categories)='array' then pf.categories else '[]'::json end) c
where pf.podcast_id in (select podcast_id from t_agg) group by 1;
-- top 25:   select ... from t_agg a left join t_cat ... where a.p1x_eps>0 order by a.p1x_timed desc limit 25;   (p2x for prompt 2; order by *_timed_audio for the audio tables)
-- depth:    count(*) filter (where p1x_timed>=20), filter (where p1x_timed_audio>=20), filter (where p1x_timed>=20 and p1x_eps*4>=eps), ... from t_agg
-- samples:  select ... from t_flag f join t_text t using (episode_id) where f.p1x and f.timed [and f.audio] [and f.podcast_id in (top-25)] order by md5(f.episode_id::text) limit 10;
-- enclosure: select count(*) filter (where primary_asset_id is not null), count(*) from episodes where podcast_id in (top-25 ids of both prompts);  -- 0 / 88,043
-- reference: select id, canonical_title, (select count(*) from episodes e where e.podcast_id=p.id) from podcasts p where id in (374254, 4365945, 742069);
-- show-level pass (§6): same t_ep/t_ep2, then t_show1 with having >= 1 and left(p.description,1500), regex over canonical_title||' '||pdesc.
```

Regex tiers are spelled out in §1; the runnable Python wrappers (`g18b.py`, `g18c.py`, psycopg 3, password from `pgpass.conf`) and the raw result JSON live in the session scratchpad, not in the repo.
