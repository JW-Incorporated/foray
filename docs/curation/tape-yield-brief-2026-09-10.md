# Tape yield brief — why beats collapse to narration (attempt 6, run 2026-09-09)

> Companion brief to `docs/curation/foray-to-spec-roadmap.md` (the Hermes G-deck, 2026-09-10). Numbers here are the deck's sources; the deck cites this file by section.

Checkpoint: `out-2/how-ai-systems-really-get-built-and-put-bf672763.checkpoint.json` (written 18:43).
Code read on `generation-run-2026-09-09` (note: `sourceBeats.ts` was recommitted at 21:03 for F-69 (#572), after the checkpoint; the gate logic analysed here is unchanged by that commit).
Replay script + window dumps (`replay.js`, `replay-rows.json`, `refused-windows.txt`, `accepted-windows.txt`) were kept outside the repo; the method is in the Appendix.

**Labels:** MEASURED = computed from the checkpoint / archive / a faithful re-implementation of the scorer (13 of 17 refused rows reproduce the trace's window and weightedShare exactly; the other 4 differ only because the trace reports the first candidate that reached the window gate after the M4 ledger skipped a higher-ranked episode — see §4). JUDGED = my reading of the cue text.

---

## 0. Headline

**The floor is not the problem. The unseeded search path yields zero at any floor, and every recoverable beat is a seeded beat lost to three mechanical bugs.**

- 32 beats: 14 seeded by WS-L, 18 unseeded. 11 tape, 21 narration (17 `tier2:window-overlap`, 4 `skipped:argument` — the checkpoint says 17/4, not 18/3). MEASURED.
- Of the 11 tape beats, 10 are seeded tier-2 windows and all 10 are on-claim (JUDGED). The 11th is a **tier-1 pool segment about the Hyatt Regency walkway collapse playing under an agent-engineering claim — wrong tape, the product's worst failure — and it pre-empted an on-claim seed window.** MEASURED + JUDGED.
- Of the 14 unseeded beats that were searched, **none** has an on-claim window anywhere in the 63 Practical AI episodes (best weighted share median 0.141, max 0.289; zero windows with ≥3 rare words). Lowering the floor to 0.20 admits no unseeded beat; at 0.15 the first two unseeded beats admitted are both off-claim. MEASURED + JUDGED.
- The 3 seeded refusals are (a) a research-map quote/seed boundary bug (2 beats, plus 4 more that only survived by luck), and (b) the M4 one-segment-per-episode cap refusing a seed window at weightedShare 0.746 while the trace blamed `window-overlap` on a different episode. MEASURED.
- Fixing the three mechanical bugs takes this run from 11 tape / 1 wrong to ~14 tape / 0 wrong with the floor untouched. Raising the seeded share of the spine is the only lever with large headroom.

---

## 1. The 17 `window-overlap` refusals (MEASURED numbers, JUDGED verdict)

`ws` = windowWeightedShare (the gated number, floor 0.35); `share` = plain term share; `rare/matched of N` = distinctive terms (floor 3) / matched terms / claim content terms; `len` = window length. `S` = seeded beat.

| beat | claim (first 80) | best episode (trace window) | ws | share | rare/matched of N | len | verdict on the refused window |
|---|---|---|---|---|---|---|---|
| 0/0/2 | Degradation, not crashing, is the signature production fault: storage volumes runn | Are we in an AI bubble? 2752–2809 | 0.056 | 0.045 | 1/1 of 22 | 57 s | **off** — human "brain degradation" from AI dependence. Best-in-show CoreWeave 392–463 (ws 0.101, GPU/storage slowdowns) is *adjacent* but that episode was M4-capped. |
| 0/0/3 S | The closest existing discipline to an ML incident review is commercial aviation cra | AI hot takes: Autonomy 693–820 | 0.336 | 0.333 | 3/7 of 21 | 127 s | **on-claim (partial)** — the Mayday sentence (cue 781–820) is the verbatim source; the first 90 s is combat-ethics. Refused by 0.014. The seed (820–911) excludes the source cue → seed window ws 0 (§4 bug A). |
| 0/0/4 | Most ML outages are not model outages — the model keeps returning confident-looki | Surviving the New Economics 618–721 | 0.173 | 0.118 | 2/2 of 17 | 102 s | **off** — China's open models as a "fallback strategy"; "quietly" in the news. |
| 0/1/1 S | Neoclouds compete by specializing toward AI workloads and their specific compute, | Mythos / Allbirds 672–740 | 0.388 | 0.588 | 2/10 of 17 | 68 s | **on-claim, verbatim.** Refused only for having 2 rare words ("neoclouds" is never matched: tape says "Neo Cloud"). The seed (740–837) excludes the source cue 672–740 (§4 bug A). |
| 0/1/2 | Training and serving are different engineering problems with different contracts | AI at the Edge 887–958 | 0.143 | 0.188 | 1/3 of 16 | 71 s | **off** — edge latency requirements (microseconds vs seconds). |
| 0/1/3 | GPU scarcity turned cluster scheduling into an org-political function: who gets | Groq 280–337 | 0.115 | 0.158 | 1/3 of 19 | 57 s | **off** — compiler op scheduling. Best-in-show CoreWeave Slurm-on-Kubernetes 2186–2292 (0.139) is *adjacent*. |
| 0/1/4 | Checkpoint frequency is an economic decision, not a technical one: checkpoint too | Finding Nemotron 1538–1636 | 0.134 | 0.105 | 2/2 of 19 | 98 s | **off** — model sizes per node, inference throughput. |
| 1/0/0 S | Before anyone can run a federated experiment or a training run, someone has to se | Federated learning part 1 259–355 | 0.270 | 0.235 | 2/4 of 17 | 96 s | **adjacent** — OpenFL aggregator/collaborator setup (same subject, other framework). The **seed window (part 2, 1925–2020) is on-claim verbatim at ws 0.746 / 4 rare words and was never opened**: part 2 was already used by 0/1/0 and the M4 cap is 1 segment/episode until 8 are placed (§4 bug B). |
| 1/0/2 | Training-serving skew is the most common silent production bug in ML: the batch | Inside an AI-Run Company 1821–1859 | 0.100 | 0.087 | 1/2 of 23 | 38 s | **off** — "silent co-founder", "posted a job". Best-in-show GenAI risks 1000–1069 (Citadel AI: TFX training+serving pipelines, drift monitoring; 0.141) is *adjacent*. |
| 1/0/3 | Labeling is a procurement problem before it is a machine-learning problem: it run | Groq 2023–2117 | 0.106 | 0.238 | 1/5 of 21 | 94 s | **off** — removing vendor-specific GPU code. |
| 1/0/5 | Most tickets filed as 'the model is wrong' close as something else entirely: a br | Open source AI to tackle your backlog 506–628 | 0.093 | 0.200 | 0/4 of 20 | 122 s | **off** — Copilot completing a "class name"; "six to twelve months". |
| 1/1/2 | A model artifact needs the same provenance discipline as a shipped binary: a vers | AI in the shadows 1713–1850 | 0.120 | 0.200 | 2/5 of 25 | 137 s | **off** — Anthropic's blackmail study: "binary choice", "commit blackmail". |
| 1/1/4 | Quantization is a production decision wearing a research costume: the accuracy p | Controlling AI Models from the Inside 1751–1898 | 0.289 | 0.300 | 1/6 of 20 | 147 s | **adjacent** — quantization to fit an edge device, latency, cost, in service of a guardrail-model pitch. Not the claim's trade-off. |
| 2/0/2 | An ML system needs three independent monitoring layers — infrastructure health ( | Zero Trust for AI Agents 2255–2351 | 0.087 | 0.121 | 1/4 of 33 | 97 s | **off** — agent security controls; "health" is a body-temperature analogy. |
| 2/0/3 | The single most valuable observability artifact in a production ML system is a s | IBM Granite 844–879 | 0.117 | 0.143 | 1/3 of 21 | 35 s | **off** — mixture of experts, "linear regression". |
| 3/0/3 | The team that owns the data pipeline is almost never the team that owns the model | How is AI shaping democracy? 607–746 | 0.174 | 0.158 | 2/3 of 19 | 139 s | **off** — ER doctors, TikTok feed ("neither", "nobody", "turns"). |
| 3/0/4 | Mature production ML looks aggressively boring from the outside — a job schedule | Building Durable AI Agents 2521–2671 | 0.175 | 0.231 | 1/6 of 26 | 150 s | **adjacent** — the 2021 MLOps tool explosion, harness/infra/deployment; not "four boring pieces". |

Tally of refused windows (JUDGED): **2 on-claim (both seeded), 3 adjacent, 12 off-claim.** The gate refused nothing it should have accepted on the unseeded path.

## 2. Control: the 11 accepted tape beats

`seed ws/rare` = the seed window's own numbers (share-only floor per F-72). "fallback" = the seed window failed and the whole-episode search found the tape.

| beat | claim (short) | segment | len | seed ws/rare | verdict |
|---|---|---|---|---|---|
| 0/0/0 | first failure mode of a production agent: not a millisecond REST request | durable-agents #1552 (1552–1586) | 35 s | 0.510 / 5 | **on**, verbatim |
| 0/0/1 | CoreWeave GPU straggler detection | coreweave #960 (960–1062) | 102 s | 0.501 / 3 | **on**, verbatim |
| 0/1/0 | "friendly framework" filed under prototyping | federated-2 #1428 (1428–1593) | 165 s | 0.582 / 3 | **on**, verbatim |
| 1/0/1 | Thunderbird: encrypted on device, decrypted in a confidential enclave | thunderbird #2513 (2513–2723) | 211 s | 0.832 / 6 | **on**, verbatim; last ~70 s drifts to the Thunderbird Pro roadmap |
| 1/1/0 | closed model runs on vendor side; open weights land on Hugging Face | model-wars #785 (785–918) | 133 s | 0.429 / 5 | **on**, verbatim — source cue 785–817 sits *before* the seed start 817 (bug A); recovered by claim-overlap growth |
| 1/1/1 | edge = ISPs and specialised processing; push the most efficient model to the device | edge #2022 (2022–2206) | 185 s | 0.144 / 0 → fallback | **on**, verbatim (source cue 2096–2129 precedes seed start 2129, bug A). Side note: the claim misreads "ISPs" (image signal processors) as something you "serve"; tape is fine. |
| **2/0/0** | questions that dominate agent engineering are operational: tool-call timeouts, skip the re-ranker, cheaper model | **TIER 1: causality Hyatt Regency #2047 (2047–2171)** | 124 s | n/a | **OFF-CLAIM — WRONG TAPE.** Personnel churn on a 1981 walkway collapse. Tier-1 overlap = 4 words (`engineering, good, enough, step`) against a bar of 4 (`ceil(15 × 0.25)`); family gate admits `engineering/disasters` for an `engineering/ai-robotics` Foray. The seed window (durable-agents 1769–1911: "what if the tool calls time out? What if I don't use a re-ranker? Can I use a cheaper model") is verbatim on-claim and was never consulted because tier 1 runs before tier 2. |
| 2/0/1 | StackLock exposed its KM systems to Claude through a tunnel | mcp-k8s #623 (623–703) | 79 s | 0.674 / 3 | **on**, verbatim |
| 3/0/0 | computing power drives AI progress; semiconductor shortage delayed cars and dishwashers | ai-policy #826 (826–921) | 95 s | 0.236 / 1 → fallback | **on**, verbatim — source cue 826–846 precedes seed start 846 (bug A) |
| 3/0/1 | companies funnel budget into mitigating AI risk; "not a blip" | post-agentic #558 (558–767) | 209 s | 0.000 / 0 → fallback | **on** at 721–767 (verbatim), but the first 160 s is adjacent budget-diversion talk — an F-62-class lead-in. Source cue 721–767 precedes seed start 767 (bug A). |
| 3/0/2 | higher education is changing the way industry is; students want skills to translate | educating #124 (124–257) | 133 s | 0.757 / 6 | **on**, verbatim |

Control tally (JUDGED): 10 on-claim, 1 wrong tape (tier 1). Of the 10, 7 cleared on the seed window itself and 3 survived only because the whole-episode fallback re-found the cue the seed bounds had excluded.

## 3. Floor simulation (MEASURED walk, JUDGED verdicts)

Faithful re-run of tier 2 per refused beat: seed episode first, then BM25 top-8, with the M4 ledger (`cap = max(1, floor((placed+1) × 0.25))`) applied in beat order exactly as the run did; first candidate that clears is taken. Seed windows are judged on share alone, everything else on share AND rare-word count.

| floor (share / rare words) | extra beats admitted | which (verdict) | on / adjacent / off |
|---|---|---|---|
| **0.35 / 3 (current)** | 0 | — | 0 / 0 / 0 |
| 0.30 / 3 | +1 | 0/0/3 Mayday (on, partial) | 1 / 0 / 0 |
| 0.25 / 3, 0.20 / 3 | +1 | same — no unseeded window anywhere has ≥3 rare words | 1 / 0 / 0 |
| 0.35 / 2 | +1 | 0/1/1 Neoclouds (on) | 1 / 0 / 0 |
| 0.30 / 2, 0.25 / 2 | +2 | 0/0/3, 0/1/1 — both seeded | 2 / 0 / 0 |
| 0.20 / 2 | +3 | + 1/0/0 via Thunderbird 1513–1589 (Flower's federated SDK mentioned in passing: adjacent/off) | 2 / 1 / 0 |
| 0.15 / 2 | +5 | + 0/0/4 (off), 3/0/3 (off); 1/0/0 now via "Inside an AI-Run Company" (off) | 2 / 0 / 3 |
| 0.10 / 2 | +9 | + 0/1/4, 1/0/2, 1/1/2, 2/0/2 (all off) | 2 / 0 / 7 |
| 0.35 / 3 with M4 cap lifted | +1 | 1/0/0 seed window ws 0.746 (on, verbatim) | 1 / 0 / 0 |

Reading: **no floor value admits a single on-claim unseeded window.** Everything a lower floor recovers is seeded, and the moment the floor reaches an unseeded beat (0.15) the admissions are off-claim. The tracker's calibration (0.257 worst false positive, 0.349 nearest miss) still holds on this run: the only two windows between 0.30 and 0.40 are the two seeded on-claim ones.

## 4. Diagnosis — what actually collapses beats (ranked by beats lost)

### Cause 1 — the archive does not say the unseeded claims (14 beats). MEASURED + JUDGED
The unseeded claims are deepen-written MLOps lore ("provenance discipline", "pager rotation", "procurement problem", "training-serving skew", "checkpoint frequency"). Practical AI is an interview show and, across 63 episodes, does not say them:
- mean 21.5 content terms per unseeded claim; 2.3 of them per claim are **never spoken anywhere in the corpus** (e.g. `throttled, procurement, provenance, timezone, replayed`) and carry weight 1.0 in the denominator, so ~20 % of each claim's weighted mass is unmatchable by construction;
- best window in the whole show: median ws 0.141, max 0.289; **0 of 14** have any window with ≥3 rare words; BM25 rank-0 textScore averages 13.6 vs 25–30 for seeded claims whose episode actually says them;
- by reading: 0 on-claim best windows, 4 adjacent (0/0/2, 0/1/3, 1/0/2, 3/0/4 / 1/1/4).
This is not a lexical-vs-semantic problem: there is no on-claim passage for a better scorer to find. Semantic scoring would raise the *adjacent* ones — i.e. it would raise risk, not yield. It is also not a query-rewriting problem: when the archive does say the claim (all 3 seeded refusals), BM25 ranks the right episode 0th or 1st.

### Cause 2 — research-map quote / seed boundary bug (2 beats lost; 4 rescued by luck; 1 lead-in). MEASURED
`cueWindowText(cues, startSec, endSec)` (transcriptArchiveLookup.ts:1104) keeps any cue with `end_sec >= startSec`. Cues are contiguous, so the cue that ENDS at the window's `startSec` is always prepended to the quote. `researchShape.ts:266` quotes that text into the spine prompt with the window's own `startSec/endSec`; the spine writes the claim from the first sentence it reads (frequently that leading cue), copies the bounds faithfully (all 14 seeds match a listed window exactly), and `sourceBeats` then searches `within` those bounds with a 1 s tolerance that excludes the very cue the claim came from.
Checked on 8 seeds: 7 quotes begin with the previous cue's text. Claims written from that excluded cue: **6 of 14** — 0/0/3 and 0/1/1 lost (seed windows ws 0.000 / 0.016; fallback windows 0.336 / 0.388 then failed the archive-search floor by 0.014 and by one rare word); 1/1/1, 3/0/0, 3/0/1 rescued only because the whole-episode fallback re-found the same cue and it cleared both conditions; 1/1/0 partially. This is the F-68 rounding class again, on the quoting side.

### Cause 3 — M4 cap refuses the seed before its body is opened (1 beat lost; the trace lies about why). MEASURED
`m4ShareAllows` runs before `getCues`; with `M4_ITEM_SHARE_MAX = 0.25` the cap is **1 segment per episode until 8 tape segments are placed**. The spine seeded federated-part-2 twice (0/1/0 and 1/0/0) and building-durable-agents twice (0/0/0 and 2/0/0); the research map lists 32 windows over 23 episodes with 8 episodes duplicated. 1/0/0's seed window (ws 0.746) was skipped at `m4-share`, and because `furtherOf` reports the candidate that got furthest, the trace says `window-overlap` on part 1 at 0.27 — which is the "weak reason" the founder read. The same ledger explains all 4 rows where my replay's first candidate differs from the trace (0/0/2 CoreWeave, 1/0/2 Thunderbird, 1/1/2 durable-agents: each already placed).

### Cause 4 — tier 1 runs before the seed and its bar admits generic words (1 wrong tape + 1 on-claim seed lost). MEASURED + JUDGED
The pool has 0 Practical AI segments and 35 Causality (engineering-disaster) segments the family gate admits for `engineering/ai-robotics`. Tier-1 coverage is unweighted (`TIER1_WINDOW_COVERAGE = 0.25` on plain token count), so `engineering, good, enough, step` cleared a 15-token claim. The seeded window that should have played (durable-agents 1769–1911) is verbatim on-claim. This is run 1's Chernobyl-for-Hyatt class of failure reappearing in the accepted set.

### Cause 5 — argument beats (4 beats, by design). MEASURED
`skipped:argument` ×4 (0/0/5, 1/0/4, 1/1/3, 2/0/4). Correctly not searched.

Not a cause: the M3 order rule (never the furthest gate here), the D-tier length rules (no `d*` gates in the trace), the rare-word floor on seed windows (F-72 fixed it; no `seedFloor` refusals).

## 5. Recommendations, ranked by expected tape-yield gain

| # | change | yield (this run) | cost | wrong-tape risk |
|---|---|---|---|---|
| **R1** | **Quote exactly the window's cues** — `cueWindowText` uses `end_sec > startSec` (strict) or `researchShape` quotes `cues[firstCue..lastCue]` and reports their bounds. Add a test: the seed window of a claim written from the quote must score ≥ the quote's own share. | **+2 beats** (0/0/3, 0/1/1), and 4 beats stop depending on the fallback (MEASURED) | one line + a fixture | none — strictly narrows to what the spine read |
| **R2** | **Seeded beats consult the seed window before tier 1**, or tier 1 adopts the idf-weighted share + rare-word floor (its 4-of-15 unweighted coverage is the bar run 1 was supposed to have retired). | **−1 wrong tape, +1 on-claim beat** (2/0/0) (MEASURED) | small; the tier-2 seed path already exists | none; removes the only wrong tape in the run |
| **R3** | **Make the M4 cap visible to seeding**: the research map / spine prompt must not seed one episode twice until the Foray will carry ≥8 segments (or the ledger admits a seeded window as the 2nd of an episode once ≥4 placed). And in the trace, report the seed's own gate (`m4-share`) alongside the furthest one — the founder is reading the wrong reason. | **+1 beat** (1/0/0) (MEASURED); trace stops lying | prompt line + `tier2TraceFor` field | none if the cap is enforced at spine time; small if the ledger is relaxed |
| **R4** | **Seed more of the spine from tape.** Unseeded search yield is 0/14 at every floor; seeded yield is 10/14 now and ~13/14 after R1–R3. The map already lists 32 windows over 23 episodes and the spine used 14. Ask for a seed on every `account` beat that has a window (leave `argument` beats narrated). | JUDGED: each extra seed ≈ +0.9 tape beat; 20–24 tape beats per Foray is plausible against 11 now | prompt change; more research windows per subtopic (`RESEARCH_TAPE_WINDOWS_PER_SUBTOPIC` 4 → 6) | low — seeds are the spine writing what the tape says; watch claim faithfulness (1/1/1 "ISPs") with the existing spot-check |
| R5 | Tokeniser compound normalisation (`neo cloud`→`neocloud`, `re ranker`→`reranker`, `hyper scaler`) | +0–1 (0/1/1 would clear the rare-word count) | tiny | none |
| R6 | Wider archive (MLOps Community, Data Engineering Podcast, Software Engineering Daily): the unseeded claims are generic production-ML lore that an interview show never states but practitioner shows do. | unknown; the only lever for unseeded beats | transcription throughput (the ASR box), digest + index rebuild | low with the current floor — the floor's calibration transferred cleanly to this run |
| R7 | Accept **adjacent** windows with a narration bridge ("what the tape does say is …"), gated by an LLM on-claim judge, not by share. | JUDGED: +3–5 beats here (0/0/2, 0/1/3, 1/0/2, 1/1/4, 3/0/4) | judge call per candidate; a new beat kind; product decision | **medium** — this is the tape-that-isn't-about-the-claim failure by construction; needs the bridge to be honest |
| R8 | Semantic scoring (embeddings over cue windows) instead of / alongside lexical share | JUDGED: +0 on-claim on this run (no on-claim passage exists to find); it would surface the same adjacent set as R7 | cheap index (63 × ~400 cues); a second floor to calibrate from scratch | **highest** — lexical share fails safe (off-claim windows score 0.05–0.17); embeddings score "about the same subject" highly, which is exactly the wrong tape |
| R9 | Claim → query rewriting | ≈0 — BM25 already ranks the right episode 0th/1st whenever it exists | — | — |

Sequence: R1 + R2 + R3 are a day's work and take this Foray to ~14/32 tape with zero wrong tape at the current floor; R4 is the lever with headroom; leave the floor at 0.35/3. Do not lower the floor to buy yield: at 0.15 the gains are all off-claim (§3).

## 6. Answer to the founder's question

"The reasons for collapsing seem weak" — they are weak because the trace prints the *furthest* candidate's gate, not the seed's: 1/0/0 collapsed on an M4 cap at ws 0.746 and was reported as `window-overlap (0.27)` on another episode; 0/0/3 and 0/1/1 collapsed because the seed bounds excluded the cue the spine quoted. Those three plus the Hyatt mis-fire are fixable without touching the gate. The other 14 collapses are real: the archive genuinely does not say those claims, and reading the refused windows confirms the gate was right 12 times out of 14 and "adjacent" twice.

## Appendix — method and caveats

- Scorer re-implemented from `catalogueLookup.ts` (`tokenizeForSourcing` + stopwords), `transcriptTextIndex.ts` (BM25 k1 1.2 / b 0.75, idf over the 63-doc Practical AI index), `transcriptArchiveLookup.ts` (`selectTapeWindow`, `betterWindow`, `tapeWindowIsRelevant`, `within` tolerance 1 s). Corpus for idf assumed to be Practical AI only; the exact reproduction of 13/17 rows (ws to 3 decimals, start/end to the cue) supports that.
- Trace counts: 17 `window-overlap` + 4 `skipped:argument` = 21 rows; tapeRelevance 11 rows (10 tier 2, 1 tier 1).
- M4 arithmetic checked against the run: at 1/0/0, placed = 3 → cap 1 → part 2 (used 1) refused; at 0/0/2 CoreWeave (used 1, cap 1) refused; at 1/0/2 Thunderbird and at 1/1/2 durable-agents likewise. All four match the trace's `textRank: 1`.
- Judged verdicts are mine, from the full cue text of each window (`refused-windows.txt`, `accepted-windows.txt`). "Adjacent" = same subject, does not state the claim; "on-claim" = the claim can be heard in the window.
- The tier-1 overlap for 2/0/0 was recomputed from `data/segments.json` + the Causality transcript (`…episode-47-hyatt-regency--4ad77c0279.json`): 4 shared tokens of 15, bar 4.
