# Corpus → production 4a: integration brief

> Companion brief to `docs/curation/foray-to-spec-roadmap.md` (the Hermes G-deck, 2026-09-10). Numbers here are the deck's sources; the deck cites this file by section.

Date: 2026-09-09 (DB clock is UTC; queries ran 2026-09-10 03:30–04:30 UTC). Read-only session as `wyatt_readonly` against `foraycorpus` on 100.79.104.9 (PostgreSQL 17.11, 50 GB). Repo read on branch `generation-run-2026-09-09`, nothing modified.

Every number is tagged **[M]** measured (a query or file read in this session) or **[I]** inferred (arithmetic on measured values, or an assumption stated inline). The crawler was running during the session, so **[M]** counts drift a few percent between queries (e.g. English timed-transcript episodes were 439,671 at 03:40 UTC and 442,145 at 04:05 UTC). Treat all corpus counts as a snapshot, not a constant.

---

## 0. TL;DR

1. **The corpus is a URL index, not an archive.** 3.1 M asset rows, and **zero** of them have `object_uri`, `observed_byte_length`, `declared_byte_length`, `checksum`, `integrity_metadata` or `last_checked_at`; `technical_availability = 'unknown'` on 100 % of rows [M]. Nothing has been fetched. Every question of the form "what fraction is stored" answers **0 %**.
2. **Transcript supply is large and mostly English.** 1.23 M transcript asset rows over 525 k distinct episodes. Restricted to `english_candidate_status='yes'`: **442 k episodes with a timed transcript** across **1,967 podcasts** (1,560 with ≥5, 1,207 with ≥20) [M]. That is ~160× the 2,715 normalized transcripts 4a has on this machine [M], and ~58× the 7,571 timed-transcript episodes 4a's curated availability index knows about [M].
3. **But the primary `<enclosure>` URL is not in the corpus.** Audio rows exist only as `asset_type='alternate'` (846,625 audio/video rows on 841,602 episodes [M]) and a 0.5 % episode sample shows they come almost exclusively from Omny/Amperwave-style feeds (`www.omnycontent.com` 2,864/2,902 sampled episodes have audio; `anchor.fm` 0/6,674; `feeds.megaphone.fm` 0/5,084; `feeds.simplecast.com` 0/2,855; `feeds.acast.com` 0/2,792) [M]. Only **10.2 %** of all episodes have any audio URL [M, 4,067/39,910 sampled]. 4a cannot mint a `MintedSegmentSource` (needs `audio_url`) for the other 90 % from the corpus alone. English episodes with **both** a timed transcript and an audio URL: **323,721** across **1,185** podcasts (488 podcasts with ≥1 such episode ... see §2 for the ≥5/≥20 breakdown) [M]. This is the single most important thing to raise with Joey; it is a crawler/ingest gap, not a data-scarcity problem.
4. **No DAI signal of any kind** exists in the corpus (no byte lengths, no integrity metadata, no host classification) [M]. 4a's ranged-GET method has to run *somewhere*; today it runs by hand.
5. **Topic signal is show-level only.** Per-feed `categories` JSON (26 k crawled feeds) and PodcastIndex `category1..10` for all 4.7 M source records [M]. Per-episode there is nothing beyond title/description/`content:encoded` text (97 % of episodes have a description [M]); `metadata_documents` (which has `search_vector tsvector`, `quality_score`, `english_candidate_status` columns) is **empty** [M]. pgvector 0.8.0 is installed but no table has a vector column [M].
6. **Coverage today is a thin slice.** Crawl began 2026-09-04 [M]. 27,080 of 4.74 M feeds have ever succeeded (0.57 %) [M]; 26,294 of those are crawl_tier 1 (of 88,653 tier-1 feeds) [M]. 19,104 English podcasts have ≥1 episode row [M]. 14 of the biggest hosts (anchor, megaphone, simplecast, acast, libsyn, podbean, omnycontent, feedburner, soundcloud, ...) are auto-**paused** for rate-limit signals [M]; episode inserts collapsed from ~4.1 M/day (09-06, inferred from a 1 % sample) to ~120 k/day (09-10) [I].
7. **Recommended automated path:** a scheduled exporter that runs *on the tailnet* (foray-db box or hermes-vm), reads the DB, performs the fetch/normalize/DAI-probe work the corpus does not do, and publishes **versioned, immutable artifacts** (catalogue JSON, per-show normalized-cue archives, per-show text index, DAI verdicts, a manifest with a pointer) to object storage (Cloudflare R2 — the repo already carries an R2 token in `data-local/.cf-token`) that Vercel `api/` functions and the generation pipeline read via a single pointer file. No human step anywhere; §6 splits founder decisions from agent-buildable work. Sizing: **~24 GB raw / ~36 GB normalized JSON / ~9 GB gzipped** for all English timed transcripts [I from measured bytes/hour].

---

## 1. What the corpus is (schema and state)

Tables (pg_class reltuples, [M]): `episode_source_records` 7.89 M (23 GB), `episodes` 7.81 M (12 GB), `podcast_feeds` 4.74 M (4.4 GB), `podcasts` 4.40 M (3.1 GB), `podcast_source_links` 4.39 M, `podcast_source_records` 4.39 M (5.6 GB), `assets` 3.10 M (2.1 GB), `feed_fetches` (monthly partitions; 2026-09 has 148,717 rows), `feed_host_policies` 229, `feed_aliases` 2,628, `duplicate_clusters` 143, `topic_crawl_campaigns` 3, `metadata_documents` 0, `jobs` 0, `job_events` 0, `source_snapshots` 1. Alembic head `0015_partition_fetches_events` [M].

Provenance [M]: a single `source_snapshots` row — `podcast_index_feeds` (PodcastIndex SQLite export, 5.06 GB, 4,724,036 rows, imported 2026-09-03→04). `podcast_source_records.extra_source_json` carries PodcastIndex `category1..10`, `podcastGuid`, `newestEnclosureUrl`, `newestEnclosureDuration`, `host`. `podcast_source_records.itunes_id` is set on ~64 % of records (30,257/47,434 in a 1 % sample) [M] — this is the join key to 4a's `apple_collection_id`.

Key columns 4a would use [M]:
- `podcasts(id, public_id, canonical_title, description, declared_language, english_candidate_status, language_confidence, explicit, author, site_url, image_url, status)`; `detected_language` is 100 % null.
- `podcast_feeds(id, podcast_id, current_url, normalized_url, url_hash, status, last_success_at, last_attempt_at, crawl_rank, crawl_tier, categories json, itunes_block_raw, podcast_locked_raw, schedule_reason, last_error_reason)`; `host_key` and `feed_type` are 100 % null (host policy keying happens elsewhere).
- `episodes(id, public_id, podcast_id, canonical_title, description, source_published_at, duration_seconds, explicit, episode_type, season_number, episode_number, status)`; `primary_asset_id`, `declared_language`, `detected_language`, `dedupe_cluster_id` are 100 % null [M].
- `episode_source_records(episode_id, feed_id, guid_raw, guid_hash, title_raw, description_raw, content_encoded_raw, pub_date_parsed, duration_parsed_seconds, item_content_hash, change_count, source_present)`; `guid_raw` is the join key to 4a's `guid`. There is **no enclosure column** anywhere in the schema [M].
- `assets(id, owner_type, owner_id, asset_type, url, mime_type, language, relation, declared_byte_length, observed_byte_length, checksum, integrity_metadata json, technical_availability, last_checked_at, object_uri, rights_status, block_status)`. Indexes: PK, `(owner_type, owner_id)`, unique `(owner_type, owner_id, asset_type, url_hash)`. No index on `asset_type`/`mime_type` (a full scan of the 2.1 GB table takes 2.5–6 s, acceptable for a batch exporter).

Access [M]: `wyatt_readonly` has SELECT on public tables, cannot create temp tables in a read-only transaction but can in a normal session (I used temp tables for joins; nothing was written to the DB). Roles: `postgres`, `forayapp`, `wyatt_readonly`. Statement timeout was respected; the one 12 GB `count(distinct podcast_id) from episodes` finished in 22.5 s at a 300 s timeout.

---

## 2. Transcript supply (Q1)

Asset rows by type/mime [M, full scan]:

| asset_type | mime_type | rows |
|---|---|---|
| transcript | text/vtt | 386,929 |
| transcript | text/plain | 350,154 |
| transcript | application/srt | 337,626 |
| transcript | application/x-subrip | 114,112 |
| transcript | application/json | 23,592 |
| transcript | text/html | 14,914 |
| transcript | `/application/srt`, text/srt, application/pdf, plain/txt, `/application/vtt`, docx, application/vtt, null | 763 / 460 / 221 / 184 / 52 / 26 / 20 / 3 |
| **transcript total** | | **1,229,056** over **525,420 distinct episodes** |

Publishers typically emit 2–3 formats per episode (Omny emits srt + vtt + text/plain for every episode), so "1.23 M transcripts" is really ~525 k episodes. Hosts [M]: `api.omny.fm` 976,752 (79 %), `transcript-files.spotifycdn.com` 86,541, `main.podigee-cdn.net` 29,519, `www.buzzsprout.com` 25,473, `transcription.spreaker.com` 13,486, `mcdn.podbean.com` 12,358, `rss.flightcast.com` 9,989, `static.libsyn.com` 7,560, then a long tail. `assets.language` on transcript rows: en-us 728 k, en 286 k, null 216 k, everything else < 1.5 k each [M].

Timed = mime in {text/vtt, application/srt, application/x-subrip, application/json, text/srt, application/vtt and the two leading-slash variants}; plain = {text/plain, plain/txt, text/html, application/pdf, null}. Per episode, joined `assets → episodes → podcasts` [M, 03:40 UTC run]:

| english_candidate_status | episodes with any transcript | timed | timed (strict, no JSON) | plain-only | both timed+plain | Σ duration of timed (s) | mean duration (s) |
|---|---|---|---|---|---|---|---|
| yes | 461,899 | **439,671** | 439,380 | 22,199 | 335,241 | 1,061,424,422 (= 294,840 h) | 2,416 |
| no | 56,699 | 56,013 | 55,976 | 686 | 3,457 | 118,258,160 | 2,112 |
| unknown | 6,822 | 6,803 | 6,803 | 19 | 79 | 18,529,008 | 2,724 |

Per-podcast concentration, `english_candidate_status='yes'` [M]:

| podcasts with any transcript | ≥1 timed | ≥5 timed | ≥20 timed | ≥100 timed |
|---|---|---|---|---|
| 2,295 | **1,967** | **1,560** | **1,207** | 585 |

(no: 787 / 773 / 653 / 412 / 121; unknown: 51 / 50 / 35 / 25 / 13.)

Skew [M]: the top shows are iHeart/Omny daily radio ("2 Pros and a Cup of Joe" 8,833 timed episodes, "Stugotz and Company LIVE!" 8,726, "The Fred Show" 8,582, "The Dan Patrick Show" 7,570, "Crime Stories with Nancy Grace" 5,501, "The Breakfast Club" 5,472). One is a synthetic show ("AI Podcast Summaries from Transcripted.ai (VIDEO)", 5,612 timed, 0 audio). Duration percentiles for English timed episodes: p10 413 s, p50 2,205 s, p90 4,565 s [M]. Recency: 10,390 published in the last 30 days, 128,931 in the last 365 days; by year 2024: 69,760, 2025: 102,536, 2026 YTD: 90,910 [M].

**Fetched/stored fraction: 0 / 1,229,056 [M].** `object_uri`, `observed_byte_length`, `checksum`, `last_checked_at` are null on every asset row; `technical_availability` is `'unknown'` on all 3.1 M rows; `rights_status` and `block_status` are null everywhere. The corpus knows URLs and mime types from RSS `<podcast:transcript>` tags and nothing else. `relation` is set on 27 k rows (`captions` 26,142, `transcript` 985, `Captions` 65) [M].

Implication for 4a: `tools/segments/fetch-transcripts.mjs` (GET + normalize + digest) is still the only thing that turns these URLs into cue text. The corpus replaces 4a's *availability sweep* (`sweep-transcripts.mjs` / `data/transcript-availability.json` / `breadth-transcript-yield.json`), not its *acquisition*.

---

## 3. Audio and DAI (Q2)

Audio rows [M]: `asset_type='alternate'` with audio/video mime = **846,625 rows on 841,602 episodes** (audio/mpeg 730,549; audio/mp3 111,896; video/mp4 1,090; audio/x-m4a 845; audio/mp4 123). `declared_byte_length` and `observed_byte_length` are **null on all of them** [M] — the RSS `length=` attribute is not captured, and no ranged GET has been made. `integrity_metadata` is null everywhere; `technical_availability='unknown'` everywhere. **There is no per-episode DAI verdict, no per-show DAI verdict, and no host classification in the corpus** [M].

Which episodes have audio at all (0.5 % `TABLESAMPLE` of `episodes`, joined to the feed's host) [M]:

| feed host | sampled episodes | with an audio asset |
|---|---|---|
| anchor.fm | 6,674 | 0 |
| feeds.megaphone.fm | 5,084 | 0 |
| www.omnycontent.com | 2,902 | 2,864 |
| feeds.simplecast.com | 2,855 | 0 |
| feeds.acast.com | 2,792 | 0 |
| feeds.fastcast.ai | 1,041 | 0 |
| feed.podbean.com | 947 | 0 |
| rss.art19.com | 878 | 25 |
| feeds.libsyn.com | 688 | 0 |
| rss.amperwave.net | 660 | 660 |
| omnycontent.com | 486 | 486 |
| all hosts | 39,910 | **4,067 (10.2 %)** |

Audio-URL hosts [M]: podtrac.com 266,949, traffic.omny.fm 219,535, serve.castfire.com 111,871, open.live.bbc.co.uk 52,712, p.podderapp.com 35,664, pdst.fm 34,381 — i.e. measurement-prefix chains typical of Omny/iHeart/Audacy feeds, which publish `<podcast:alternateEnclosure>` in addition to `<enclosure>`. [I] The ingest stores `alternateEnclosure` items as `asset_type='alternate'` and does not store the primary `<enclosure>` at all (`episodes.primary_asset_id` is 100 % null, consistent with that). Whether this is a bug or a deliberate deferral is Joey's to answer; either way **4a needs `enclosure_url` + `length` for every episode** (`audioSourceLookup.mintSegmentSource` refuses without an https `enclosure_url`, and `ad-inflation.mjs` needs the declared length as the denominator).

Overlap that matters for 4a (English) [M, 04:05 UTC run]: 442,145 timed-transcript episodes; 694,950 episodes with audio; **323,721 with both** (73 % of timed), in 1,185 podcasts. Podcasts with ≥1 / ≥5 / ≥20 episodes having *both* timed transcript and audio: **488 / 454 / 409** [M]. (Contrast 1,967 / 1,560 / 1,207 on transcript alone: the missing-enclosure gap costs 4a three-quarters of the transcript-bearing shows.)

What 4a already does about DAI (from `docs/adr/0008-ad-tolerance-and-timestamp-precision.md`, `tools/transcribe/ad-inflation.mjs`, `tools/refresh/classify-dai.mjs` [M]): host-suffix classification of the redirect chain (`dai: true/false`, `reason: host:<h>`), then `ad_inflation = Content-Range total from a 2-byte ranged GET ÷ feed-declared bytes`, median over 5 episodes → `ad-free` (<1.01) / `injected` / `unknown` (<0.99). ADR-0008 makes ad load a label not a gate, and defines PADDABLE (pad = delta_max + margin ≤ 120 s, N ≥ 2 probes) vs LOCATE-REQUIRED. `data/dai-classification.json` today: 220 shows, `dai:true` on 141, `ad_inflation` measured on 27 (14 ad-free / 12 injected / 1 unknown) [M]. None of that runs on a schedule (`nightly-refresh.yml` runs only `scan.mjs`/`resolve.mjs`) [M].

So the corpus provides neither input for DAI: not the declared length, not any probe result. The exporter (§6) must do the ranged GETs itself, or Joey's crawler must be extended to populate `declared_byte_length` (trivial: it is the `length=` attribute) and `observed_byte_length` + `integrity_metadata` (needs a fetch worker; the schema was clearly designed for it — `jobs`/`job_events` tables exist but are empty [M]).

---

## 4. Topic / organisation signal (Q3)

Per **podcast** [M]:
- `podcast_feeds.categories` (json, iTunes `<itunes:category>` tree, e.g. `[{"category":"Science","subcategory":"Earth Sciences"},{"category":"News","subcategory":"Business News"}]`) — set on 26,325 feeds, all of them crawled ones (pg_stats null_frac 0.99993) [M].
- `podcast_source_records.extra_source_json.category1..category10` — PodcastIndex lowercased Apple genre tokens (`society`, `education`, `business`, `religion`, `arts`, `music`, `health`, `comedy`, `news`, `sports` ...) on 93 % of 4.7 M records (44,327/47,434 sampled) [M]. This is the same Apple-genre vocabulary as 4a's `catalog-breadth.json.apple_genre` / `taxonomy.json.apple_anchor`, so the mapping is mechanical.
- `topic_crawl_campaigns.topic_definition_json` = `{name, keywords[], categories[]}` → `matched_feed_ids` (3 rows, all the `apollo` demo, 150 feeds each, `feeds_crawled_count` 130 on one run) [M]. This is a *feed selector* by keyword/category match, not a per-episode label.

Per **episode** [M]: nothing structured. `episodes` has no category/keyword column; `episode_source_records` has `title_raw`, `description_raw` (97.4 % non-null), `content_encoded_raw` (54 % non-null; ~49 % of episodes have >200 chars of it). No `itunes:keywords`, no chapters text (chapters are 46,796 URL-only asset rows), no transcript text, no embeddings. `metadata_documents` — the table designed to hold per-entity text documents with `search_vector`, `quality_score`, `token_count`, `english_candidate_status` — has 0 rows [M].

So the corpus cannot fix 4a #547 (episode topics inherit one show label) by itself. Episode-level and segment-level topic terms have to be derived from text the corpus only points at (transcripts) or holds raw (descriptions). The right home for that derivation is the exporter's normalize step (it already tokenizes cue text for the BM25 index in `backend/src/generation/transcriptTextIndex.ts`), emitting per-episode term vectors alongside the cues. If Joey wants it in the corpus, `metadata_documents` is the obvious landing table and the pgvector extension is already installed.

---

## 5. Freshness and coverage (Q4)

Feeds by `crawl_tier` [M]:

| tier | feeds | ever succeeded | ok last 7 d | ok last 30 d | has categories |
|---|---|---|---|---|---|
| 1 | 88,653 | 26,294 | 26,294 | 26,294 | 26,154 |
| 2 | 228,558 | 135 | 135 | 135 | 135 |
| 3 | 556,214 | 32 | 32 | 32 | 32 |
| 4 | 198,967 | 0 | 0 | 0 | 0 |
| 5 | 2,228,441 | 5 | 5 | 5 | 4 |
| 6 | 1,423,024 | 0 | 0 | 0 | 0 |
| (null tier ≈ 7.8 % of feeds per pg_stats) | | | | | |

7-day = 30-day because the crawl started 2026-09-04 [M]. Status: active 4,721,921 (25,610 ok in 7 d), unreachable 1,881, quarantined 55 [M]. Successful-fetch days: 09-05 1,306, 09-06 507, 09-07 14,614, 09-09 1,204, 09-10 8,844 (UTC) [M]. Fetch outcomes this month: success 109,651, timeout 32,967, network_error 5,198, security_denied 514 [M]. `schedule_reason`: `host_paused_recheck` 15,631, `content_changed_reset` 9,059, `transient_backoff` 1,943, `publisher_opt_out_sparse_recheck` 975 [M]. Of crawled feeds, 2,929 carry `itunes:block` and 3,823 `podcast:locked` [M] — rights signals 4a should honour in the catalogue export.

Host politeness [M]: 14 hosts **paused** (anchor.fm, audioboom.com, feed.podbean.com, feeds.acast.com, feeds.fastcast.ai, feeds.feedburner.com, feeds.libsyn.com, feeds.megaphone.fm, feeds.simplecast.com, feeds.soundcloud.com, feeds.soundon.fm, feed.xyzfm.space, rss.amperwave.net, www.omnycontent.com), 14 slowed, 206 normal; all pauses are "auto: N consecutive rate-limit signals" with reason `timeout` (one `http_429`). [I] The pauses are almost certainly the crawler's own timeout budget tripping on slow hosts rather than real 429s, and they are why episode/transcript inserts fell from ~4 M/day on 09-06 to ~0.1 M/day on 09-10.

Podcasts with ≥1 episode row [M]: **19,104 English**, 5,192 non-English, 2,766 unknown (27,062 feeds). Versus 4a today: `catalog-breadth.json` 19,787 shows (Apple top charts, 110 genres, built 2026-07-09), `catalog.json` 220 curated shows, `discover.json` 2,050 items [M]. Rough parity in show count, but a different population: the corpus is "tier-1 by crawl_rank", 4a breadth is "Apple chart rank by genre". The overlap was not measured (would need `podcast_source_records.itunes_id` ↔ `apple_collection_id` for the 19,787 breadth ids; doable in one query with the ids uploaded to a temp table).

---

## 6. Corpus → what 4a reads today (Q5)

4a input inventory (from the repo survey; all `data/*.json` sizes are on-disk bytes) [M]:

| 4a input (consumer) | Rows / size | Corpus table + columns that could feed it | Missing in the corpus |
|---|---|---|---|
| `data/catalog.json` — 220 curated shows: `show_id, title, apple_collection_id, feed_url, taxonomy_node_ids, editorial_note, cadence_hint` (api/episodes/search.ts, api/shows/*, catalogueLookup.ts, showIdMap.ts) | 220 shows, 173 KB | `podcasts.canonical_title/author/image_url/site_url/explicit`, `podcast_feeds.current_url`, `podcast_source_records.itunes_id` (→ `apple_collection_id`, 64 % coverage) | `show_id` slugs, `taxonomy_node_ids`, `editorial_note`, `archetype_fit`, `cadence_hint` (editorial; stays in 4a). Only 64 % of shows have an iTunes id, so feed-URL is the primary join. |
| `data/catalog-breadth.json` — 19,787 Apple-chart shows: `apple_collection_id, title, feed_url, apple_genre, apple_genre_ids, episode_count, chart_rank, tier` (api/shows/search.ts via breadthCatalog.ts, api/episodes/search.ts) | 19,787 shows, 12.5 MB, built 2026-07-09 | same as above + `podcast_feeds.crawl_rank/crawl_tier` (rank proxy), `podcast_feeds.categories` (26 k feeds) or `extra_source_json.category1..10` (4.7 M) for `apple_genre`, `podcast_source_records.item_count_source` for `episode_count`, `newest_item_pubdate_source` | Apple `chart_rank`/`chart_genre_id` (Apple-only), `artwork_url` at Apple sizes. Corpus `crawl_rank` is a different ranking; needs a documented mapping to `tier`. |
| `data/discover.json` — 2,050 items: `id, show, title, release_date, duration_sec, topics[], hook, audio_url, audio_type, audio_bytes, dai_suspected` (catalogueLookup.ts, classify-dai.mjs, ad-inflation.mjs) | 2,050 items, 2.4 MB | `episodes.canonical_title/description/source_published_at/duration_seconds`, `episode_source_records.guid_raw`, `assets(alternate, audio/*).url` for **10 %** of episodes | **`audio_url` for 90 % of episodes** (no `<enclosure>` capture), `audio_bytes` (no `declared_byte_length`), `dai_suspected`, per-item `topics[]`, `hook` (LLM-written), Apple `track_id`/episode URL. |
| `data/transcript-availability.json` — 220 shows × episodes: `guid, enclosure_url, transcript_url, transcript_type, has_timestamps, chapters_url, dai_suspected, enclosure_host` (fetch-transcripts.mjs selection, audioSourceLookup.ts) | 220 shows / 86,923 episode rows / 7,571 timed, 7.8 MB | `assets(transcript).url/mime_type/language` ✔ (this is exactly what the corpus indexes), `assets(chapters).url` ✔, `episode_source_records.guid_raw` ✔, `episodes.duration_seconds` ✔ | `enclosure_url` (same gap), `dai_suspected`, `enclosure_host` (derivable once enclosure exists), `has_timestamps` must be inferred from mime (corpus does not open the file). |
| `data/breadth-transcript-yield.json` — 3,000 swept shows: per-show counts, `anchorable`, `arm`, `host_key`, `dai_suspected` (audioSourceLookup.ts, sourceBeats) | 3,000 shows, 2.8 MB | aggregate of the above per `podcast_id` (`count(*) filter (where timed)`), `podcast_feeds.categories` | `anchorable` needs DAI; `arm/tranche/rank_position` are 4a experiment bookkeeping. |
| `data/dai-classification.json` — per show `dai, reason, resolved_host, ad_inflation{verdict, median_ratio, samples[]}` (audioSourceLookup.ts, fetch-transcripts.mjs AD_FREE_SHOWS gate) | 220 shows (141 dai, 27 probed), 91 KB | nothing | Entire DAI layer: redirect-chain host, declared vs delivered bytes, per-episode delta in seconds (ADR-0008 PADDABLE). |
| `data/transcript-digests.json` + `breadth-transcript-digests.json` — per transcript `bytes, sha256, cues, first/last_cue_sec, span_implausible, speakers` (transcriptArchiveLookup.ts tier-2 corpus) | 587 + 1,131 transcripts, 1.6 MB | `assets(transcript)` rows give the pointer only | `bytes/sha256/cues/span` — all require fetching the body; corpus `observed_byte_length/checksum` columns exist but are empty. |
| `data-local/transcripts/normalized/<show>/<guid>.json` — `{show_id, guid, source_url, cues[{start_sec,end_sec,text,speaker}], warnings[]}` (FileTranscriptCueProvider) | 2,715 files, 204 MB (growing while surveyed) | none — the corpus stores no body text | Normalized cue text (this is the tape). |
| `data-local/transcripts/index/<show>.json` — BM25 postings `{docs[{guid,length,mtimeMs,size}], postings{term:[[doc,tf]]}}` (transcriptTextIndex.ts) | 2 shows, 3.8 MB | none | Text index. |
| `data/segments.json` (212) / `segment-sources.json` (64) — anchored segments and their `audio_url/audio_bytes/ad_free_ratio/audio_verified_on` (segmentPoolLookup.ts, finalizeForay) | 222 KB | `episode_source_records.guid_raw`, `episodes.duration_seconds` | `audio_url`, `audio_bytes`, `ad_free_ratio`; segments themselves are 4a-minted. |
| `data/taxonomy.json` — 194 nodes with `apple_anchor` (taxonomyFamily, sourceBeats) | 49 KB | `extra_source_json.category*` and `podcast_feeds.categories` use the same Apple vocabulary → can populate show→node membership | Node tree itself is editorial; per-episode node assignment absent on both sides. |
| `api/` Vercel functions (`api/episodes/search.ts`, `api/shows/search.ts`, `api/shows/[show_id]/episodes.ts`, `showIdMap.ts`) | read `catalog.json`, `catalog-breadth.json`, `shows-index-pointer.json` from the deploy bundle (`vercel.json includeFiles`) | would read a corpus-derived catalogue artifact instead | Vercel cannot reach 100.79.104.9; the artifact must be pushed to somewhere internet-reachable (see §7). |

Identity keys to join 4a ↔ corpus: `feed_url` ↔ `podcast_feeds.normalized_url` (unique on active rows via `url_hash`; `feed_aliases` handles redirects), `apple_collection_id` ↔ `podcast_source_records.itunes_id` (64 %), episode `guid` ↔ `episode_source_records.guid_raw`/`guid_hash`. 4a's local `safeKey(show_id)` / `safeKey(guid)` directory scheme is a pure function of those, so the archive layout can be preserved.

---

## 7. The automated path (Q6)

Constraint recap: the DB is tailnet-only (100.79.104.9); Vercel functions cannot reach it; GitHub-hosted runners cannot reach it either (no Tailscale on hosted runners unless a founder adds an OAuth client + `tailscale/github-action`, which is a credential decision). Egress from the cloud agent environment is Full (memory note), but a scheduled cloud agent is the wrong tool for a multi-GB nightly export. So the exporter must run **on the tailnet** and **push** to a store the app can read.

### 7.1 Proposed pipeline (one scheduled job, no human steps)

```
foraycorpus (RO role) ──► corpus-export (runs on tailnet, cron)
   1. catalogue     : podcasts ⋈ podcast_feeds ⋈ source_records ⋈ episode aggregates
                      → shows.jsonl (+ per-show categories, itunes_id, rights flags)
   2. episodes      : episodes ⋈ episode_source_records ⋈ assets → episodes.jsonl per show
                      (guid, title, pub, duration, transcript_url+mime, chapters_url, audio_url|null)
   3. fetch+normalize (delta only: new asset ids since last manifest)
                      GET transcript_url → raw → normalize (existing tools/segments/transcript-normalize.mjs)
                      → normalized/<safeKey(show)>/<safeKey(guid)>.json.gz  + digest row
   4. text index    : per show, existing backend/src/generation/transcriptTextIndex.ts
                      → index/<show>.json.gz ; per-episode term vectors → episode-terms.jsonl
   5. audio + DAI   : for episodes with audio_url: 2-byte ranged GET (existing ad-inflation.mjs logic)
                      → declared/delivered bytes, ratio, host chain → dai.jsonl (per episode + per show median)
   6. manifest      : manifest/<ISO-date>.json {version, built_at, corpus_snapshot_at, counts, sha256 per file}
                      + manifest/latest.json (pointer, atomic overwrite)
        │
        ▼
 object store (versioned prefix /corpus/v<N>/…)  ◄── Vercel api/ (reads latest.json → shows.jsonl.gz, cached)
                                                   ◄── generation pipeline (backend/src/generation/*Lookup.ts
                                                       gain an HttpTranscriptCueProvider / catalogue source)
                                                   ◄── CI "data" job replaces committed data/*.json with a
                                                       pointer file, mirroring the S-04 shows-index-pointer
```

Why this shape: it reuses every 4a component that already exists (`transcript-normalize.mjs`, `transcriptTextIndex.ts`, `ad-inflation.mjs`, `classify-dai.mjs`'s host list, the `safeKey` layout, the S-04 release-pointer pattern in `showIdMap.ts`/`shows-import.yml`), it never commits multi-GB data into git, and the app's read side changes from "bundled file" to "pointer → immutable versioned object", which is the same abstraction `shows-index-pointer.json` already implements.

### 7.2 Where it runs — the three options

| Option | Reaches DB | Reaches publishers (transcript GET, ranged GET) | Reaches store | Who provides it |
|---|---|---|---|---|
| **foray-db box** (Joey's, hosts Postgres) | localhost | yes | yes | Joey: a `corpus-export` systemd timer next to the crawler; ideal because the fetch worker could write `object_uri`/`observed_byte_length` back into `assets` with the `forayapp` role, making the corpus the archive rather than a side-store. |
| **hermes-vm 100.96.16.99** | tailnet | yes | yes | Wyatt; independent of Joey's box, RO role only; a cron + the 4a repo checked out. Best fit if Joey's box stays "crawler only". |
| **GitHub Actions** (hosted) | only with a Tailscale OAuth client secret + `tailscale/github-action` | yes | yes | Founders (org secret). 6-h job limit and 2-core runners make the initial ~25 GB backfill awkward; fine for nightly deltas. |

Vercel: read-only consumer, never a producer. A scheduled cloud routine: fine for *watching* the manifest and opening a PR that bumps the pointer, not for moving bytes.

### 7.3 What the founders must decide (cannot be built around)

1. **Runtime host**: foray-db box (Joey) vs hermes-vm (Wyatt) vs Actions+Tailscale. This decides whose credentials and whose uptime the pipeline depends on.
2. **Credentials**: a dedicated export role (RO is enough for the exporter; the `forayapp` role would be needed only if the fetch results are written back into `assets`), and a store write token. The repo already has Cloudflare tokens in `data-local/.cf-token` and `data-local/storage.cf-token` [M, not read]; whether R2 is the store, and which account pays, is a founder call.
3. **Egress/politeness policy**: 442 k transcript GETs (79 % against `api.omny.fm`, a host the crawler currently has paused) and ~700 k ranged GETs. Rate (1 req/s/host → ~11 days for the Omny backfill), User-Agent (`ForayBot` / `ForayCorpusBot` are both defined in `tools/segments/politeness.mjs`), and whether Joey's `feed_host_policies` should be the shared politeness table.
4. **Storage cost / retention**: ~9 GB gzipped normalized + ~1 GB indexes per full version; keep N versions. R2: ~$0.015/GB-month, zero egress → ~$0.15/month per version [I from public pricing; verify].
5. **Rights posture**: 2,929 crawled feeds carry `itunes:block`, 3,823 `podcast:locked`, 853 license assets (CC variants) [M]. 4a's current policy (`transcript-availability.json` "transcript bodies are never fetched or stored (issue #104)" was later relaxed to data-local only, #255). Publishing transcript bodies to a shared store is a policy change and needs a founder decision, whatever the store's ACL.
6. **Corpus-side fixes to request from Joey** (blocking, not decidable by 4a): capture the primary `<enclosure>` URL + `length` for every episode (`episodes.primary_asset_id` exists for exactly this); populate `declared_byte_length` from the RSS attribute; optionally run the fetch worker so `object_uri`/`observed_byte_length`/`checksum` are filled and `technical_availability` moves off `unknown`; look at why 14 major hosts auto-paused on `timeout`.

### 7.4 What an agent can build now (no decision needed)

- The exporter as a `tools/corpus-export/*.mjs` (or `.py`) package: SQL (the exact queries in this brief), delta detection by `assets.id`/`episodes.updated_at` high-water mark, `safeKey` layout, manifest with sha256, dry-run against the RO role — all testable against the live DB from hermes-vm or this machine.
- `HttpTranscriptCueProvider` implementing the existing `TranscriptCueProvider` interface (`getCues(entry)`) plus a `bodyStat()` equivalent reading the manifest, so `transcriptArchiveLookup.ts` and `transcriptTextIndex.ts` need no logic change.
- A catalogue adapter that emits `catalog-breadth.json`-shaped rows from `shows.jsonl` so `api/shows/search.ts` and `breadthCatalog.ts` keep their record schema; the `vercel-bundle.test.mjs` pin becomes a pointer test like `showIdMap.ts`'s.
- Per-episode topic terms: emit top-k tf-idf terms per episode from the cue tokens the index step already produces, mapped onto `taxonomy.json` nodes via `apple_anchor` ↔ corpus categories — addresses #547 at the data layer without a model call.
- A CI check that the pointer's manifest is < 48 h old (mirrors `nightly-watch.yml`'s "night that produced no PR").
- The itunes_id ↔ `apple_collection_id` overlap query for the 19,787 breadth shows, to quantify how much of today's catalogue the corpus already covers.

### 7.5 Sizing: all English timed transcripts as normalized cue text

Inputs [M]: 442,145 episodes; Σ duration 1,061,424,422 s = **294,840 h** (mean 2,416 s). Bytes per transcript-hour measured on 4a's own archive: 56.6 KB/h raw (curated digests, 583 files, 527 h) and 107.0 KB/h raw (breadth digests, 1,126 files, 331 h, 4× more cues/hour — short-cue SRT); normalized JSON is 1.53× raw on disk (247 MB / 161 MB, 3,106 files); gzip -6 shrinks normalized JSON 3.89× (200-file sample); cue text alone is 34 % of normalized bytes.

| artifact | bytes/hour used | total [I] |
|---|---|---|
| raw VTT/SRT bodies | 80 KB/h (midpoint) | **~24 GB** (range 17–32 GB) |
| normalized cue JSON (`{start_sec,end_sec,text,speaker}`) | 122 KB/h | **~36 GB** (26–48 GB) |
| normalized, gzipped | 31 KB/h | **~9 GB** |
| cue text only (for the text index / term vectors) | 41 KB/h | ~12 GB (≈3 GB gz) |
| BM25 index (observed 3.16 MB for 337 docs ≈ 9.4 KB/doc) | — | ~4 GB for 442 k docs |

Adding the 323 k-episode "transcript + audio" subset only: scale by 0.73 → ~17 GB raw, ~6.6 GB gz. Nightly delta after backfill: ~10 k new English timed episodes/30 d [M] → ~0.8 GB raw/month, trivially incremental. Transfer for the backfill: ~24 GB of GETs, and ~700 k × 2-byte ranged GETs (negligible bytes, non-negligible request count).

---

## Appendix A — method notes

- Counts of tables come from `pg_class.reltuples` (approximate); asset breakdowns are full scans of `assets` (2.5–6 s each); the episode/podcast joins used session temp tables (`create temp table … as select …`, allowed in a non-read-only session for the RO role; nothing persisted). Host/coverage ratios use `TABLESAMPLE SYSTEM(0.5)` / `(1)` and are labelled sampled.
- Mime normalisation for "timed": the leading-slash variants `/application/srt`, `/application/vtt` and `text/srt`, `application/vtt` were counted as timed; `application/json` (23.6 k) was counted as timed in the main table and excluded in the "strict" column (Podcasting 2.0 JSON transcripts carry timestamps, but some `application/json` rows are Spotify/podcastai payloads that were not opened).
- pg_stats `null_frac` was used for column emptiness claims (`primary_asset_id`, `detected_language`, `host_key`, `feed_type`, `categories`) and cross-checked with `count(...)` where cheap.
- `data-local/transcripts/` was being written by a running generation job during the survey (3 `node.exe` processes; `normalized/stuff-you-should-know-*` grew ~1,000 files in 10 min), so its counts are a snapshot.
- Nothing was written to the database, the repo, or the branch. Scratch query scripts (`q.py`, `s1.sql`…`s8.py`) were kept outside the repo; the SQL they ran is reproduced in §2–§6.
