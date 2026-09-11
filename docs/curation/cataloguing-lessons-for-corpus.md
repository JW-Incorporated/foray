# Cataloguing lessons from the Foray generation effort — brief for Joey

> Companion brief to `docs/curation/foray-to-spec-roadmap.md` (the Hermes G-deck, 2026-09-10). Numbers here are the deck's sources; the deck cites this file by section.

*Draft 2026-09-10, mined from `foray` branch `generation-run-2026-09-09` (read-only). Founder framing (Wyatt): "what have we learned about cataloging? if the shows were organized better ahead of time, would that have resulted in a notable speed up? … triage speed-ups first on the order of hours, then minutes, then seconds … if there are lessons learned that we can feed into Joey's cataloging efforts, capture them and communicate them to Joey."*

**Labelling.** Every claim below is tagged **MEASURED** (a number taken from a run, a scan or the data files on this branch, with the source cited) or **INFERRED** (a conclusion drawn from measured facts, or a recommendation). Finding ids `F-nn` / `I-nn` are from `docs/curation/generation-run-2026-09-09.md` and `docs/curation/generation-findings-tracker.md`; `WS-x` are workstreams in `docs/curation/generation-fix-plan-2026-09-09.md`; `§n.n` is `docs/curation/foray-generation-requirements.md` unless another file is named.

**Speed-up classes** (the founder's triage): **HOURS** = the item would have avoided a failed run, a wasted attempt, or a manual re-source pass; **MINUTES** = it removes a pipeline stage or a search from a run; **SECONDS** = it trims a call, a load, or a join.

---

## 0. The one-paragraph answer

The corpus this pipeline ran against was organised as *shows with one topic label, episodes with titles, and a digest of which transcripts exist*. The pipeline needed *episodes with their own labels, transcript text it could search, 90–180 s windows it could quote, per-episode ad-load measurements, and a depth ledger per topic*. Every one of those gaps was discovered by a failed run and closed by pipeline code written under pressure (WS-H text index, WS-L tape windows, F-59/F-67 node terms, F-74 DAI rule). Roughly **1 hour of the ~8 hours of run wall-clock** in the last week is *directly* attributable to catalogue organisation, another **~3 hours** had catalogue gaps as a co-cause (every zero-tape attempt), and the majority (~5 hours) was narration/finalize logic that no catalogue fixes. But upstream of the run week, catalogue organisation cost **days to weeks**: a broken id join that read "zero transcripts" for ten days, an ad-load gate that rejected eleven shows on a per-host suspicion, and a whole Foray (alcohol) blocked because 442 of 443 relevant shows were never harvested. The requirements in §1 are the list Joey can build against.

---

## 1. Cataloguing requirements, numbered and triaged

Ordered by speed-up class (HOURS first), then by how cheap they are to do.

### HOURS class — each of these avoided a failed run or a manual re-source

#### R1. Store normalized, timed cue text per episode and a text index over 90–180 s windows — never rely on titles

- **Lesson.** Matching a claim against episode *titles* never reached the tape; matching against transcript *text* did, and quoting windows of that text to the spine is what finally produced tape beats.
- **Evidence (MEASURED).**
  - F-06 / F-49 → cause: tier 2 matched `show_title + title` only; on run 2's topic *Practical AI* had **63 of 63** transcript bodies on the machine and the best title scored **1** against a threshold of **3** for every one of 23 searching beats. Zero tape for 35 beats on the archive's richest subject (run doc §1, F-49 → resolved).
  - WS-H (#553): a BM25 index over normalized cue text reached real transcripts on all 23 beats (BM25 13–21, `foundBy: text-index`) — "the biggest yield lever" (§3.6.6b).
  - F-63: even with the text index, the spine was written from concept labels and item counts ("Ai: 761 items, tape: strong"), never a line of what the tape says; every account beat was refused at `tier2:window-overlap` (shares 0.08–0.20 vs 0.35). Three attempts, three matchers, zero tape.
  - WS-L (#566): research-shape quotes 3–4 windows per subtopic (90–180 s, ≤ 600 chars) into the spine prompt → **16 of 33** beats seeded (attempt 4b), tape yield **5 → 11** beats (attempts 4b → 5/6). `backend/src/generation/researchShape.ts:tapeWindowsFor`.
  - Cost of not having it: run 2 attempts 1–3 = 33 + ~40 + 76 min ≈ **2.5 h** of run wall with zero tape, plus PRs #552, #553, #565, #566, #568, #570 to build what a corpus could have shipped.
- **Store / compute.**
  - *Episode:* normalized cues `[{start_sec, end_sec, text, speaker}]` (the shape `tools/segments/transcript-normalize.mjs` already writes to `data-local/transcripts/normalized/`), plus `warnings[]`.
  - *Cue window (90–180 s, overlapping stride):* window text, start/end, matched-term vector, BM25-ready postings; **one idf computed across the whole corpus**, not per show (§3.6.6a — two BM25 scores from two corpora are not comparable).
  - *Index:* keyed by every body's mtime+size so a re-transcribed episode rebuilds it (`transcriptTextIndex.ts`); tokenizer and stopword list shared with the consumer (`catalogueLookup.ts:tokenizeForSourcing`, ~150 function words added after F-29 matched "have, one, people, would").
- **Speed-up:** **HOURS** (the zero-tape wall). Also **MINUTES** at run time: today the index is built lazily per show during the run (`data-local/transcripts/index/practical-ai.json`, 613 KB); prebuilt in the corpus it is a load, not a stage.

#### R2. Label topics per episode and per window with taxonomy node ids — never inherit one show-level label

- **Lesson.** A show carries one node; every episode inherits it; the lineage gate then either admits unrelated episodes (fusion playlist full of Civil War and psychopaths) or, when the Foray's node is resolved slightly wrong, refuses every episode of the only relevant show.
- **Evidence (MEASURED).**
  - GitHub #547: **1,688 of 2,047** `discover.json` items carry exactly their show's `taxonomy_node_ids` (re-verified on this branch: 1,688 / 2,047). `catalog.json`: **170** shows have exactly one node, **50** have two. Five shows carry `engineering/energy-fusion` as their *only* node: Lex Fridman Podcast, Titans of Nuclear, CleanTechies Podcast, Catalyst with Shayle Kann, CBC Ideas.
  - F-59: the same "magnet" node captured run 2's topic; every trace read `tier2:lineage` and the ~40-minute attempt 2 sourced nothing.
  - F-67: an 8-word subject paraphrase resolved to `architecture/infrastructure` on the single token *infrastructure*; the lineage gate closed on every *Practical AI* episode and WS-L went out with `tapeWindows: []`.
  - `taxonomyFamily.ts:familyGateAllows` **fails closed** when a candidate's nodes are unknown ("I could not tell" is not evidence the tape is on topic) — so an unlabelled episode is invisible to sourcing, and a mislabelled one is wrongly admitted or refused.
  - `docs/CATALOG-PIPELINE.md` §Classification layers: the breadth classification file is a layered overlay; the 2026-07 `llm-title-genre` layer (title + Apple genre only) is "distrusted" — Science Friday tagged `medicine/biology`.
- **Store / compute.**
  - *Episode:* `topics[]` of node ids with `confidence` and `source` (feed description + episode description + transcript excerpt, per the Tier-1/Tier-2 cascade in `docs/curation/breadth-classification-methodology-plan.md` §1); a `general: true` marker on broad shows (CBC Ideas, Lex Fridman) that the playlist/lineage code treats as "do not inherit" (#547 item 2).
  - *Window/segment candidate:* a node id per window where the episode spans topics (an hour of Lex Fridman is several nodes).
  - *Show:* keep the show label as a **prior only**; a regression check that no node's episode list contains an episode whose only claim to it is its show label (#547 item 3).
- **Speed-up:** **HOURS** (attempt 2 of run 2 + the F-59/F-67 fix cycle; #547 is live on Home for every listener).

#### R3. Give every taxonomy node — and every episode — a distinctive vocabulary

- **Lesson.** Topic resolution and claim matching are token overlap. With no advertised terms, the resolver scores nodes on their *labels* ("systems" made fusion the rarest word in the tree); with terms, it resolves correctly. This is the cheapest item on the list.
- **Evidence (MEASURED).**
  - `data/taxonomy.json`: **194** nodes; on the pre-fix branch **1** carried a `terms[]` list (`engineering/energy-fusion`, 11 terms); `engineering/ai-robotics` advertised nothing, and the shared tokenizer drops two-letter words so `ai` is not even a token (§3.4). F-59 fix (#554) added generic-token suppression and a distinctive-evidence rule; F-67 fix added `ai-robotics` terms. The tracker still says: "resolver is still token overlap; a classifier is the real fix".
  - `data/semantic-index.json`: 120 concepts, 361 multi-word terms mapped to nodes — the resolver was "the one matcher in the pipeline not reading that file" until #554.
  - F-69 (INFERRED lesson): the retrieval retry built a query from the claim's rarest words and got rotating-machinery papers for an on-call-rotation claim — distinctiveness has to be *relative to the corpus*, which is a catalogue statistic.
- **Store / compute.**
  - *Node:* `terms[]` (curated, multi-word allowed, no stems) for **all 194** nodes; a `generic_words` list the resolver must ignore (`system`, `general`, `modern`, `world`…).
  - *Episode:* top-k distinctive terms by tf-idf over cue text (the "distinctive-term vocabulary" for claim matching), plus named entities/guests.
  - *Corpus:* document frequency per term, so any consumer can tell "rare" from "common" without rebuilding the index (the repo's #275 found that catalogue growth silently moved 52 terms and 125 score multipliers in `tagDF`).
- **Speed-up:** **HOURS** (attempts 2 and 4a of run 2), and it is a day of curation, not a system.

#### R4. Record ad load per EPISODE as a measured delta in seconds — the per-host `dai_suspected` flag is a claim about the host and over-reports

- **Lesson.** `dai_suspected` says which host *could* stitch ads. Shows flagged DAI deliver byte-identical audio (Being an Engineer +0.3 s; Practical AI 1.0000 on 5 of 5 probes) and their timed transcripts are free anchors; a rule reading the flag alone refused every tier-2 segment of the first tape-bearing Foray.
- **Evidence (MEASURED).**
  - `docs/curation/transcription-scale-plan.md` §4: eight full downloads — SYSK +8.4/+10.0 min, Odd Lots +8.8/+10.7, TPWKY +8.0/+8.0, Being an Engineer **+0.3 s / +0.8 s** while flagged `dai_suspected: true`. "The flag records which host *could* insert ads, not which one *does*."
  - `data/dai-classification.json` on this branch: **141 of 220** shows `dai: true`; **27** measured; of those, **7** are `dai: true` *and* measured ad-free (Practical AI, Being an Engineer, Piano Tech Radio Hour, Tuned In, The Violin Chronicles, Lab to Market Leadership, TechSurge).
  - `data/transcript-availability.json`: **7,504 of 7,571** timed transcripts sit on DAI-flagged shows — the flag alone would discard 99 % of the free-transcript inventory.
  - F-74: `check-forays.mjs` rule #65 refused every tier-2 segment from a `dai_suspected` show (146 of 220 flagged, Practical AI included); attempt 5's first valid partial candidate was refused on it. Fixed by a founder-visible rule change (#571).
  - **HEAD lies.** The first scan used HEAD, reported 18/18 shows byte-stable, and was completely wrong (SYSK HEAD 35,549,607 vs GET 44,961,612). Use a **2-byte ranged GET** and read `Content-Range` (`tools/transcribe/ad-inflation.mjs`; ADR-0008 §"What is actually measured").
  - ADR-0008: the delta is a property of the **request**, not the episode — the same Gastropod episode probed twice, same day, same client: **+66.1 s vs +32.7 s** (33.4 s spread). N = 1 bounds nothing; the pad must be `max + spread` over N ≥ 2. Ratios are uncomputable where the feed declares `length="0"` (Megaphone); only a decode works there.
  - Breadth sweep (scale plan §8): "every anchorable show in the tranche carries `dai_reason: unknown`" — the host list was built from 220 curated shows and breadth produced origins it had never seen; `spreaker.com` (on the DAI list) redirects to an anonymous CloudFront host and the positive identification is lost (5 shows, 2,470 transcripts, 62 % of the tranche's "anchorable" haul); `adswizz.podigee-cdn.net` names an ad vendor and is unlisted.
  - Chart rank predicts injection: ranks 1–25 are **33 %** ad-free, ranks 26–200 **71 %** (χ² = 8.22, p < 0.01) — so a gate on the flag is a gate on fame, and it excluded SYSK (2,850 timed transcripts) and Odd Lots (1,251), half the inventory.
- **Store / compute.**
  - *Episode:* `probes[] {method: ranged-get | decode, declared_bytes, delivered_bytes, ratio, measured_at}`, `delta_max_sec`, `spread_sec`, `n_probes`, `pad_sec`, `tier: paddable | locate-required | unmeasured`; `feed_duration_sec`, `transcript_last_cue_sec` (the two agree within a minute on every measured row — both describe the ad-free master; use the transcript as the cross-check ADR-0008 asks for).
  - *Show:* `feed_host`, `enclosure_chain[]` (every redirect hop, not just the origin), `dai_prior` from the host list — **a prior, never a verdict**; `ad_free_measured` only from probes.
  - Keep the `1.01` ratio as a *label* ("can this publisher's transcript timeline be trusted verbatim?"), not a gate (ADR-0008 decision 4).
- **Speed-up:** **HOURS** — the F-74 refusal (attempt 5), and before the run week: eleven shows rejected on ratio (`grilling-foray-sourcing.md` §4, `catalogue-broadening.md` §3), later un-rejected by ADR-0008; the whole "route 2 is dead" detour.

#### R5. Record timed-transcript availability per episode with format and timestamp granularity — keyed by ids that actually join

- **Lesson.** "Has a transcript" is not "has a timeline"; plain text is the third most published format and cannot anchor. And the availability index and the episode catalogue keyed on different ids, so the coverage measurement read **zero** for ten days.
- **Evidence (MEASURED).**
  - `tools/segments/sweep-transcripts.mjs` header: format spread over 208 feeds — vtt 7,063, srt 6,848, **plain 6,632**, html 1,268, json 787, x-subrip 621. Route 1's honest count was 34 timed, not 46 (scale plan §3).
  - Scale plan §7: `discover.json` keys episodes on Apple ids, the availability index on feed `<guid>`; "every join — by guid, by track id, by show slug — matched nothing" and the headline read 0 of 1,672 when the truth was 158 (137 timed). Fixed by recording `enclosure_url`, the one field both files take verbatim from the feed (10/10 exact on Practical AI). The fuzzy backstop (title *or* duration) reported 7 more and **all 7 were different episodes** (two Geology Bites episodes 1 s apart; a BBQ Central re-cut of the same title at 303 s vs 563 s).
  - The digest carries `transcript_type`, `cues`, `first_cue_sec`, `last_cue_sec`, `span_implausible`, `sha256`, `speakers`, `warnings` (`data/transcript-digests.json`); one Inside Winemaking cue ends at 359,999.999 s (100 h) — `span_implausible` exists because a single degenerate file made the corpus total 24 % wrong.
  - This branch's archive: 1,718 digests → 1,708 usable (cues > 0, span plausible); bodies present for 1,713 on the founder's machine across **17** show directories (`data-local/transcripts/normalized/`).
- **Store / compute.**
  - *Episode:* `transcript_url`, `transcript_type` (MIME), `has_timestamps`, `granularity: word | cue | none`, `cue_count`, `first/last_cue_sec`, `span_implausible`, `sha256`, `bytes`, `fetched_at`; when several formats are offered, all of them (Practical AI offers vtt/srt/json/txt/html per episode).
  - *Keys on the same row:* `guid`, `enclosure_url` (normalised), `apple_track_id`, `apple_collection_id`, `feed_url` (normalised: scheme, case, trailing slash — the catalogue is 138,470 unique feeds after that, 138,480 before).
- **Speed-up:** **HOURS** (ten days of a wrong zero; a mismatch "produces a segment whose anchors point into different audio, and nothing downstream can detect it").

#### R6. Keep a depth ledger per topic node — anchorable episodes, distinct shows, minutes — and treat "tape available" as anchorable minutes with a body, not item counts

- **Lesson.** A Foray is assembled under show-concentration rules (M3 same-episode order, M4 ≤ 25 % of segments from one episode). With one relevant show in the archive those rules fail by arithmetic, and the research map's "strong tape" signal was counting metadata hits, not usable tape.
- **Evidence (MEASURED).**
  - F-70: attempt 4b (91 min) refused — one *Practical AI* episode was 40 % of segments / 42 % of runtime; two windows from it in one slot out of tape order. §3.6.1: an episode's *second* segment needs a Foray of ≥ 8 tape segments, its third ≥ 12. F-08: the keyless stub run failed M4 at 30.9 % on the 212-row pool.
  - The archive's shape on this branch: 1,718 digests over **15** show titles — Becker's Healthcare **995**, Being an Engineer 337, Geology Bites 120, Curious Goldfish 84, **Practical AI 63**, … Sigma Nutrition 2, Enormocast 2. Run 2's AI topic could draw tape from exactly one show.
  - F-11 / F-49: `queryTapeAvailability` counted items whose title/hook/tags contained a substring ("Ai: 761 items, tape: strong" on a bridge-collapse Foray; 761 items → 0 tape). `tapeSignalFor` thresholds are item counts (5 / 20).
  - #279: the alcohol Foray spine scored **1 strong / 15 thin / 47 empty** across 63 beats — 72 % of runtime empty — while **443** drinks-shaped shows sit in the breadth catalogue and **1** is curated. "This is a selection problem, not a discovery one." #114 asks Joey for exactly this cross (transcript-rich shows × starved topics).
  - `docs/curation/segment-length-rules.md` §0: same-episode segments must be chronological and should merge if the elided gap is < 45 s — rules that only a per-episode window ledger can pre-check.
- **Store / compute.**
  - *Node:* `anchorable_episodes`, `distinct_shows`, `anchorable_minutes`, `windows_available` (from R1), `last_computed_at`; a **thin/moderate/strong** signal defined on anchorable minutes across ≥ 3 episodes and ≥ 2 shows, not on item counts.
  - *Show:* `specialist | general` (from R2), episode count with bodies.
  - A pre-flight "can this subject clear M3/M4?" query (≥ 8 windows across ≥ 3 episodes) so a subject is chosen — or its harvest is commissioned — before any model call.
- **Speed-up:** **HOURS** (attempt 4b; the #278/#279 coverage passes were whole days each).

#### R7. Precompute candidate windows with tape-spoken anchors and record segment-length statistics per episode

- **Lesson.** The anchors that survive ad re-stitching are phrases the *tape* speaks (ADR-0007); a window cut from ~28 s cues grown symmetrically opens on off-claim audio; windows of one size fail the duration rules by construction.
- **Evidence (MEASURED).**
  - F-61: `resolveAnchorFromCues` demanded ≥ 4 of the *claim's* words spoken verbatim; across 63 bodies exactly one claim had such a run. Claims are prose, tape is speech. Fix (#565): pick the window by overlap, mint `startAnchor`/`endAnchor` from the first/last distinctive phrases *inside* it.
  - F-62: cues average ~28 s in this archive; symmetric growth to the 45 s floor pulled ~28 s of Underwriters Laboratories in front of the passage.
  - F-73: 60–120 s windows → every generated segment 60–120 s; attempt 5's partial had mean **76.1 s** (D3 floor 90) and IQR **15.6 s** (D5 floor 45) and was refused. #571 moved windows to 90–180 s and grows toward a length ladder (105/165/135/210 s), never across a > 5 s transcript gap. `segment-length-rules.md` §2d: **uniform length is itself a defect**.
  - Pool reference: 212 committed segments, min 50 s / median 125 s / max 260 s. ADR-0007: capturing the ~8–12 words at each edge "costs nothing extra" at authoring time.
- **Store / compute.**
  - *Episode:* `mean_cue_sec`, `max_gap_sec`, gap positions, speech density, `reference_duration_sec`.
  - *Window (candidate segment):* `start_sec`, `end_sec`, `start_anchor`, `end_anchor` (8 words from the boundary cues, canonicalised NFKC/lowercase/apostrophes-elided as `merge-segments.mjs:canonical()`), `duration_sec` on a varied ladder (not one size), `matched_terms`, `topic` (R2), `self_contained` hint (`segment-length-rules.md` §7).
- **Speed-up:** **HOURS** (attempt 5's refusal, attempt 6 relaunch) and **MINUTES** (the window search runs per beat today).

#### R8. Use chart rank as a quality prior — never as the harvest filter

- **Lesson.** Harvesting from top-200 charts selected *against* anchorable shows and *against* niche subjects; the shows a Foray needs were found only by topic-driven search of a much larger index.
- **Evidence (MEASURED).**
  - ADR-0008 (from `grilling-foray-sourcing.md` §5.2): ranks 1–25 **33 %** ad-free (9/27) vs ranks 26–200 **71 %** (30/42); survives restriction to the byte-ratio method (41 % vs 72 %).
  - `docs/CATALOG-PIPELINE.md`: the harvester is "Apple genre tree → per-genre top-200 charts"; `chart_rank`/`chart_genre_id` are stored as the "popularity prior" — that part is right.
  - `docs/curation/catalogue-broadening.md`: the PodcastIndex dump (4.71 M feeds, keyless, 1.8 GB, one index on `url`, **no episode table**) nominated 7,237 food/history feeds; **6,410 (88.6 %) were not in our 138,470-feed catalogue**; it opened churrasco, asado, yakitori, Korean BBQ and Mexican sources that charts never surfaced — and proved braai/tandoor/mangal/lechon are not sourceable (a negative worth as much as a positive). #279: 443 drinks shows in breadth, 1 curated.
  - Breadth sweep: transcripts cluster on big networks that inject ads; 178,191 timed transcripts → **3,952** anchorable as classified (a 45× haircut).
- **Store / compute.**
  - *Show:* keep `chart_rank`, `chart_genre_id`, `harvest_source`, `harvested_at`, `region`, `in_curated` (all already in `catalog-breadth.json`); add `harvest_reason` (chart | category-term | search | referral) so a topic-driven harvest is diffable from a chart one.
  - Harvest by **topic node** (PI dump categories + node `terms` from R3), build an FTS5 index over the dump once at download time (every `LIKE` scan is 11–30 min), set the User-Agent (403 otherwise), stream results to disk.
- **Speed-up:** **HOURS** (each coverage pass re-ran discovery from scratch; the alcohol Foray is blocked on it).

### MINUTES class — each removes a stage, a search or a manual read from a run

#### R9. Detect and store language per show and per episode (English detection)

- **Evidence (MEASURED).** `catalogue-broadening.md` §3: every new tradition source found was non-English (Spanish, Portuguese, Mandarin, Korean); the manifest carries `language` and `english_audio` and the English-only rule is a standing founder instruction (#279). `discover.json` on this branch: **0 of 2,050** items carry a language field. `breadth-classification-methodology-plan.md` §2: cross-lingual classification into an English taxonomy is untested; the 121,786-show international set is out of scope for that reason (#113).
- **Store.** *Show:* feed `<language>`; *episode:* detected language of the transcript text (not the feed tag — feeds lie) and `english_audio: boolean`.
- **Speed-up:** **MINUTES** per run (a filter); **HOURS** in a sourcing pass (hours were spent reading Korean and Mandarin candidates that cannot ship).

#### R10. Publisher-transcript quality flags — and keep publisher timestamps even when the words are bad

- **Lesson (founder note + MEASURED).** Publisher transcripts are often auto-generated and worse than local ASR on words, but their word-level timestamp alignment is excellent; the two properties should be recorded separately.
- **Evidence.** `grilling-history-coverage.md`: SYSK's transcript is "machine-generated and undiarized — 'Annabellum' for antebellum, 'melb J' for LBJ, 'booie' for buoy"; quotes graded thin, anchors keep the garbles "because that is what an anchor check would match against". `alcohol-forms-coverage.md`: "every transcript read here is machine-generated and undiarized or lightly diarized". Scale plan §4: the publisher transcript's last cue agrees with the feed duration within a minute on every measured row — it is a faithful timeline of the ad-free master. `tools/transcribe/README.md`: local `faster-whisper` word timestamps validated (start ≤ end, monotonic, within segment); 1.33× realtime on the laptop — a re-transcription is 46 min of compute per episode (scale plan §1), which is what a quality flag saves.
- **Store.** *Transcript:* `source: publisher | asr-local`, `generator` if declared, `diarized`, `speaker_count`, `granularity` (R5), `garble_score` (dictionary-hit / OOV rate over cue text), `quote_grade: clean | indicative`, `timeline_grade: exact | drift-suspected` (from R4).
- **Speed-up:** **MINUTES** (no re-listen to decide whether a quote is usable) and it defers ASR spend to where it is needed.

#### R11. Duplicate and re-release clusters

- **Evidence (MEASURED).** Scale plan §7: a BBQ Central episode published under one title at 563 s and as a 303 s re-cut; Geology Bites episodes 1 s apart in duration; feed-URL normalisation collapses 138,480 → 138,470. The pipeline keeps `usedSegmentIds` so a segment never plays twice (§3.6.1) — but only within one Foray, and only by id. Digests already carry `sha256`.
- **Store.** *Episode:* `content_hash` of normalized cue text, `canonical_episode_id`, `cluster_id` for re-cuts/reruns/cross-posts (same GUID re-used, same enclosure under two feeds, feed-drop compilations).
- **Speed-up:** **MINUTES** (avoids the same tape under two ids in one Foray and the "different cut, same title" mis-anchor).

#### R12. Episode-level speaker/guest and format metadata (the "someone is explaining something" content gate)

- **Evidence.** The content gate that rejected Gurmelik Denemeleri ("Idle Talk Institute"), Culinary Connections and Unlock Local is a human read per show today (`catalogue-broadening.md` §3); F-30/F-34: the writer needs to know *who* is on tape to say so, and the evidence pack now carries show + episode title for that reason (§3.7). **INFERRED:** guest names, roles and format are cheap per-episode fields and would turn the content gate into a filter.
- **Store.** *Episode:* `format: interview | monologue | panel | news | clip`, `guests[] {name, role}`, `explanatory_density` (a simple ratio of declarative content sentences, or a Tier-1 classifier field).
- **Speed-up:** **MINUTES** per candidate show during sourcing.

### SECONDS class — trims a load, a call or a join

#### R13. One canonical id per show and per episode, joinable across Apple / RSS / PodcastIndex — never join on title

- **Evidence (MEASURED).** §2.1.2: **0 of 212** pool segments' `item_id`s resolve against `discover.json` ids; **44 of 64** `segment-sources.json` show *titles* match `catalog.json` titles (the 20 misses are the smaller shows); `taxonomyFamily.ts` joins segment → show by title; `breadth-yield.mjs`'s `AD_FREE_SHOWS` is keyed on title ("a known weakness"); the breadth classification is keyed on Apple collection id, which curated `catalog.json` rows do not carry, so a **17 MB** file is lazily parsed only for numeric ids. Item ids are derived as `${show_id}--${slug(title)}` and segment ids as `${itemId}#${startSec}` with collision suffixes.
- **Store.** *Show:* `show_id` (ours), `apple_collection_id`, `feed_url_normalised`, `podcastindex_id` (reserved, null today); *episode:* `episode_id` (ours), `guid`, `enclosure_url_normalised`, `apple_track_id`. Every file that names a show or episode carries the canonical id, not the title.
- **Speed-up:** **SECONDS** per run (17 MB load, title lookups) — and **HOURS** when a title join silently drops the smaller shows.

#### R14. Freshness, provenance and integrity counts on every fact

- **Evidence (MEASURED).** I-24: `data-local/transcripts/normalized/` (1,713 bodies) was emptied mid-session by an unidentified process 62 s after the text index wrote its first cache; every later run would have sourced zero tape "from an archive that looked present"; found only because two offline tests failed; regenerated from `raw/` in ~2 h. Proposed guard: the cue provider reports how many bodies it can read at run start and the driver refuses to source against an archive whose body count fell below the digest's. `CATALOG-PIPELINE.md` already mandates `harvested_at` / `harvest_source`; the PI dump is a weekly snapshot ~7 days stale; the sweep records `swept_at`; the index cache is keyed on body mtime+size.
- **Store.** Per fact: `*_at` timestamp and `source`; per archive: a manifest `{expected_bodies, present_bodies, checksums, built_at}` and a documented one-line regeneration from raw; an audit log line on every writer under the archive.
- **Speed-up:** **SECONDS** at run start; **HOURS** if it ever fires (a 76-minute run against an empty archive).

#### R15. Tokenisation and stopwords as a published corpus contract

- **Evidence (MEASURED).** Three matchers drifted (F-29: "have, one, people, would" scored as four shared tokens; F-11: the two-letter term `ai` matched inside "ch-**ai**-ns"; F-33: two shared content words are noise inside one domain, threshold raised 2 → 3). §3.6.6a: the index uses the same tokenizer as the scorers "so content word means one thing in this pipeline".
- **Store.** The tokenizer version, stopword list and canonicalisation rule as a versioned artefact beside the index (`TRANSCRIPT_TEXT_INDEX_VERSION` already exists for this reason).
- **Speed-up:** **SECONDS** (no rebuild) and prevents a class of silent mis-matches.

---

## 2. Would better organisation have sped things up notably? An honest split of the week's lost time

### 2.1 Attempt history (MEASURED, from the run doc §2 and the findings table)

| # | Attempt | Wall | Died on | Primary cause class |
|---|---|---|---|---|
| 1 | Run 1 att 1 | ~3 min (2 Haiku calls) | I-04 cp1252 mojibake in the answer helper | **(c) harness** |
| 2 | Run 1 att 2 | 9 m 32 s | F-19 (Frame budget vs contested rule), F-16 uninformed retry, I-10 stale relay answer | **(b) pipeline** + (c) |
| 3 | Run 1 att 3 | 30 m 20 s (≈ 22 min of it orchestrator latency: relay wall 1,817 s vs agent compute 470 s) | F-17/F-31 no per-beat fallback, two attempts per page; 1 of 5 tape anchors correct (F-23/24/29 — matching on show-title tokens and an 18-word `why` note) | **(b)**, with (a) on the anchors, (c) on latency |
| 4 | Run 1 att 4 | 2 h 35 m (≈ 61 min orchestrator latency: 9,240 s relay vs 5,560 s agent) | F-46 writer quoted the beat purpose as a source; 4.2 narration calls/beat; 5 of 22 anchors on topic | **(b)** narration logic; (a) metadata-only matching; (c) latency |
| 5 | Run 2 att 1 | 33 m 07 s | F-50/F-51 (contradicted purpose, third rejection fatal); **0 tape of 35** (F-49: `argument` tagging + title-only tier 2) | **(b)**, (a) co-cause on tape |
| 6 | Run 2 att 2 | ~40 min | F-60 empty-evidence page fatal; **0 tape**, every trace `tier2:lineage` = F-59 topic resolved to `energy-fusion` | **(a) catalogue** (node vocabulary / magnet label) + (b) |
| 7 | Run 2 att 3 | 76 m 16 s | Completed narration; refused on F-64 (summary 26 words) and F-65 (**0 tape**: F-63 spine never reads the tape) | **(b)** finalize rule; (a) co-cause (no windows in the corpus) |
| 8 | Run 2 att 4a | ~5 min (2 Haiku calls) | F-67: 8-word subject → `architecture/infrastructure`; `tapeWindows: []` | **(a) catalogue** (node terms) |
| 9 | Run 2 att 4b | 91 m 29 s | First Foray with tape (5 of 33); refused on M3/M4 (F-70) and F-71 partial; F-68 deepen paraphrased 11 of 16 seeds | **(b)** ledger/plumbing; (a) co-cause (one show in the archive makes M4 arithmetic) |
| 10 | Run 2 att 5 | ~26 min, stopped after act 1 (first partial candidate at 18.1 min) | 11 tape; refused D2/D3/D5 (F-73 window sizes) and rule #65 (F-74 `dai_suspected`) | **(a)** for F-74; (b) for F-73 |
| 11 | Run 2 att 6 | ~10 min to end of sourcing, paused | 11 tape, 10 minted segments 35–211 s; I-25 session web-search budget exhausted | **(c) harness** |
| — | Between attempts | ~15 min | I-23 relay dedupe deadlock; I-15 shell killed for low memory (no work lost) | **(c)** |
| — | Between attempts | ~2 h (debugging + regeneration) | I-24 normalized archive wiped by an unknown process | **(a)** organisation/integrity |

Run wall-clock total ≈ **8.0 h** (3 + 9.5 + 30 + 155 + 33 + 40 + 76 + 5 + 91 + 26 + 10 min).

### 2.2 The split (MEASURED wall, INFERRED attribution)

| Cause class | Run wall attributable | What it was |
|---|---|---|
| **(a) catalogue / organisation** | **≈ 1 h direct** (att 2 of run 2 40 min, att 4a 5 min, the F-74 half of att 5 ~13 min) **+ ≈ 2 h off-run** (I-24) **+ co-cause in ≈ 2.8 h** (every zero-tape attempt: run 2 att 1–3) | topic labels/vocabulary (R2, R3), per-host DAI flag (R4), no text index or windows in the corpus (R1), one-show archive (R6), archive integrity (R14) |
| **(b) pipeline logic** | **≈ 5.3 h** (run 1 att 2–4 net of latency ≈ 1.8 h; run 2 att 1, 3, 4b and half of 5 ≈ 3.5 h) | evidence-first narration (F-14…F-46), fatal-page branches (F-17/F-51/F-60), finalize rules never mirrored in sourcing (F-64/F-70/F-73), deepen paraphrase (F-68) |
| **(c) harness / manual operation** | **≈ 1.8 h** (≈ 83 min orchestrator latency in run 1 att 3–4; I-04 3 min; I-23 15 min; att 6 ~10 min on I-25) | relay transport, agent-as-API latency, session search budget, host memory |

**Answer.** *Notable, yes; dominant, no.* Better organisation would not have saved 7 of the 11 attempts — they died on narration and finalize logic that no catalogue touches. What it would have done:

1. **Removed the zero-tape wall entirely.** The F-49 → F-06 → F-59 → F-63 → F-67 chain is, every link, "the corpus does not carry what the pipeline needs" (text, labels, terms, windows). With R1–R3 in the corpus, run 2's attempt 1 would still have failed on F-50, but *with tape*, and the four PRs that built WS-H/WS-L (#553, #554, #566 and the F-67 commit — roughly two of the fix fleet's three days) would not have been needed at all. That is the hours-class item.
2. **Turned two finalize refusals into non-events.** F-74 is wholly a catalogue fact (measured vs suspected DAI; R4); F-70's M4 arithmetic is half a catalogue fact (one relevant show; R6).
3. **Upstream of the run week, saved days to weeks**, which is where the founder's question really bites: the broken id join that read "zero transcripts" for ten days (R5, R13), the ad-ratio gate that rejected eleven shows and the "route 2 is dead" detour (R4), the two sourcing passes that re-ran discovery from scratch (R8), and an alcohol Foray blocked on curation with 442 relevant shows un-harvested (R6, R8).

What organisation *cannot* fix, stated so nobody over-promises: (b) is the majority of the run week; run 1's ~83 minutes of orchestrator latency was the transport; and the archive's *depth* on any one subject (one AI show, 63 episodes) is a harvesting and transcription decision, not a metadata one — R6's ledger makes the gap visible before a run, it does not fill it.

---

## 3. Cover note to Joey

Joey — the generation runs taught us that the corpus was organised for *browsing* (shows, one label, titles) and the pipeline needs it organised for *quoting* (episodes, windows, text). Five asks, in order of hours saved:

1. **Store normalized timed cue text per episode and build a text index over 90–180 s windows.** Titles never matched a single claim; transcript text matched all of them (F-06/F-49, WS-H, WS-L).
2. **Label per episode (and per window) with taxonomy node ids; never inherit one show label; give every node a distinctive term list.** 1,688 of 2,047 episodes inherit their show's label today (#547, F-59, F-67).
3. **Measure ad load per episode in seconds** (2-byte ranged GET, N ≥ 2, keep max + spread). `dai_suspected` is a host guess and over-reports: Practical AI is flagged and delivers clean (F-74, ADR-0008).
4. **Per-episode transcript availability with format, timestamp granularity and quality flags, keyed on guid + enclosure_url + Apple ids on the same row.** Never join on title — the last title join read "zero transcripts" for ten days.
5. **A depth ledger per topic node** (anchorable episodes, distinct shows, minutes): a Foray needs ≥ 8 windows across ≥ 3 episodes to clear the 25 % show cap. Harvest by topic, not chart rank; record language.

Full requirements with evidence: §1 of this brief.

---

## 4. Sources read (all in the `foray` repo, branch `generation-run-2026-09-09`)

- `docs/curation/generation-run-2026-09-09.md` (F-01…F-74, I-01…I-25, attempt tables)
- `docs/curation/generation-findings-tracker.md`
- `docs/curation/generation-fix-plan-2026-09-09.md` (WS-C, WS-H, WS-I, WS-L)
- `docs/curation/foray-generation-requirements.md` §2, §3.4, §3.6, §8
- `docs/adr/0007-segment-anchoring.md`, `docs/adr/0008-ad-tolerance-and-timestamp-precision.md`
- `docs/CATALOG-PIPELINE.md`, `docs/curation/catalogue-broadening.md`, `docs/curation/transcription-scale-plan.md`, `docs/curation/segment-length-rules.md`, `docs/curation/breadth-classification-methodology-plan.md`, `docs/curation/grilling-history-coverage.md` (SYSK transcript quality)
- GitHub issues #547, #279, #113, #114 (`gh issue view`)
- Code: `backend/src/generation/{catalogueLookup,taxonomyFamily,transcriptArchiveLookup,transcriptTextIndex,researchShape}.ts`; `tools/refresh/classify-dai.mjs`; `tools/segments/{breadth-yield,fetch-transcripts,sweep-transcripts}.mjs`; `tools/transcribe/README.md`
- Data measured directly on this branch: `data/taxonomy.json` (194 nodes), `data/catalog.json` (220 shows: 170 one-node, 50 two-node; 5 fusion-only), `data/discover.json` (2,050 items; 1,688/2,047 inherit show labels; 0 with a language field), `data/transcript-digests.json` + `data/breadth-transcript-digests.json` (1,718 entries, 15 show titles, Becker's 995 / Practical AI 63), `data/transcript-availability.json` (27 shows with timed transcripts, 7,571 timed, 7,504 on DAI-flagged shows), `data/dai-classification.json` (141/220 flagged; 27 measured; 7 flagged-but-clean), `data/segments.json` (212 segments, 50/125/260 s), `data-local/transcripts/normalized/` (17 show directories)
