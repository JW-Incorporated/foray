# DAI package plan — ad-inserted shows (G-40 ad-pad tier, G-41 locate step, ADR-0008 amendment) — revision 2

Repo: `C:/Users/wjduv/Desktop/Vibe Coding/foray`, planned against `origin/main` @ `ecb6bfa3` (2026-09-25; #839 on top of the reviewer's `9442bba7`). Every path, function and line number below was re-checked with `git show origin/main:<path>` / `git grep` on that commit. Line numbers drift; function names do not — grep for the name when a number is off. Suite floors are given as **current committed value + delta**, never as absolutes: read the value on your branch's `test/suite-integrity.test.js` and add the delta.

**Machine-load rule (founder, 2026-09-25: "we likely have a bit too much running in parallel … throttle yourself / some agents").** This revision was produced with no sub-agents and no worktrees. The package runs **one agent at a time** (not three, not two): the orchestrator dispatches the next task only after the previous agent's PR is open and its worktree is idle. Inside a task: one `node --test <file>` at a time; `node tools/ci/run-suites.mjs` at most once per PR and only while holding the lockfile `%LOCALAPPDATA%\Temp\claude\foray-run-suites.lock` (create it with `New-Item`, delete it when the run ends; if it exists, wait — do not run). No browser tabs are opened by any task except DAI-09's one manual check. The cap lifts only on a new founder message; §4 says which pairs may then overlap.

## 1. Goal, done-definition, dependencies, founder questions

**Goal.** Make ADR-0008's PADDABLE tier shippable end to end on the JS player behind ONE switch that the founder's D5 ruling flips; give the pad an honest data path (per-episode denominators on `data/segment-sources.json` → a committed probe ledger → per-episode `ad_pad_sec` on the source row → hydrated into the queue); code the HUMAN-ACTIONS #24 finding ("a ranged GET can be lied to as well") into `tools/transcribe/ad-inflation.mjs` so no pad is ever sized from a spoofable probe; land the pure, testable halves of the G-41 locate step (window arithmetic, fuzzy anchor match) as the JS reference the native engine will port; run the one feasibility measurement D5's OQ1 needs; and write the locate-step design, including how a located or padded out-point feeds the native engine's three-layer out-point (`docs/native-engine-plan.md` line 198: `forwardPlaybackEndTime = end (+ stopPad)`).

**Done when.** (a) `AD_PAD_SHIPPED` exists in `player/seek-policy.js` (default `false`) and both `player/client.js` paths (`resolve()` at ~4653 → `resolveForay` at 4656; `playForay()` at ~5018 → `manager.setQueueFromForay` at 5061, plus its `again()` re-entry) forward `allowAdPad` through one exported helper, so the D5 flip is a one-constant PR; (b) `tools/segments/ad-pad.mjs` computes `pad = delta_max + spread` over N ≥ 2 same-episode probes, refuses N < 2, refuses ranged-GET probes on `RANGED_GET_UNTRUSTED_HOSTS`, and `tools/segments/stamp-ad-pad.mjs --check` reproduces every committed stamped field from `data/ad-pad-probes.json`; (c) `player/foray-resolve.js` hydrates `ad_pad_sec` from the source row and `tools/foray/check-forays.mjs` refuses a malformed pad and a LOCATE-REQUIRED source in a published Foray; (d) `player/locate-window.js` and `tools/transcribe/anchor-match.mjs` exist with floored suites; (e) `docs/curation/locate-step-feasibility-2026-09.md` carries time-to-locate, hit/miss per anchor and bytes fetched with device and model named; (f) `docs/curation/locate-step-design.md` exists; (g) the ADR-0008 amendment PR is open as DRAFT requesting `founder-decision`, and HUMAN-ACTIONS #24 is answerable.

**What is true on main today (measured on `ecb6bfa3`).** `data/segment-sources.json`: 98 rows; 33 `dai_suspected` (hosts `pscrb.fm` ×17 Practical AI, `www.buzzsprout.com` ×16 Being an Engineer — both measured ad-free per `data/dai-classification.json`); 19 rows carry `audio_bytes`; **zero rows are both DAI and carry `audio_bytes`** (so a collector keyed on `audio_bytes` probes nothing until DAI-04a backfills it); every DAI row has `duration_sec > 0`; 8 rows carry the hand-authored `ad_*` set, which is SIX fields: `ad_free_ratio, ad_delta_sec, ad_delta_probes, ad_delta_spread_sec, ad_pad_sec, ad_tier` (`ad_free_ratio` is a legacy field from the ad-inflation scan — see the rule in DAI-02/03/06); 5 rows carry `feed_declared_duration_sec`. `data/discover.json` (2,167 items with `audio_url, audio_bytes, duration_sec, dai_suspected`) joins to only **6 of the 33** DAI source rows by `audio_url`; the other 27 have no discover row, so the denominator for them must come from the two shows' RSS feeds (DAI-04a). `player/foray-resolve.js:334` reads `seg.ad_pad_sec` only. `allowAdPad` is consumed at `player/foray-queue.js:263,389` and `player/queue-manager.js:719,2435`, forwarded by `player/foray-resolve.js:433-441`, and passed by nothing: `player/client.js` imports seek-policy at line 98, calls `resolveForay(` only at 4656 and `setQueueFromForay(` only at 5061, and `playForay`'s `again()` (5025) re-enters with `{ startIndex, startElapsedSec, onChange, discoverDoc }` only. `resolveForay` returns `playable: report.items` (foray-resolve.js:486) and each queue item carries `ad_pad_applied_sec` (foray-queue.js:439) — so `resolveForay(...).playable[0].ad_pad_applied_sec` is a real field (reviewer's "does not exist" is rejected on that point; the reachability point is accepted: `client.js` is DOM-bound and no node test can call its `resolve()`/`playForay()`). Native: `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Engine/EngineCore.swift` refuses `playForay` until M2; the contract decoder is `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Contract/ContractDecoding.swift`; the deck is `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/AVDeck.swift`; `ios/App/Player/PlayerBackend.swift` is the pre-M1 path and is not touched. Python deps live at `tools/transcribe/requirements.txt` (there is no root `requirements.txt`). `tools/parity/record.mjs --classify` WRITES `player/parity/unported.json` (usage text, record.mjs:29-33) — it prints no suggestions. `tools/ci/run-suites.mjs` does not invoke `generate-manifest.mjs`; the manifest globs `player/*.js` at `tools/ci/generate-manifest.mjs:220` and lists only the `data/*.json` files `app.js` fetches, so a new data file cannot trip it.

**Dependencies.**
- Founder: D5 (`docs/curation/foray-to-spec-roadmap.md` G-41 at line 724; §"Measurable first step" at 737) gates only DAI-09 (the flip) and the funding of the locate step after DAI-13. HUMAN-ACTIONS #24 answers gate the final wording of DAI-15 (defaults proposed).
- Other packages: native deck NE-28j/NE-28s/NE-32 (`docs/native-engine-plan.md` table rows 776-785) own the Swift pad and out-point. Any test added to a parity-covered suite (`player/parity/coverage.js:40-57` `COVERED_SUITES`; `seek-policy` NE-28j/seek-policy at :44, `queue-manager` NE-14j/manager-episode at :54, `foray-playback` NE-30j/manager-foray at :57) must be classified by `node tools/parity/record.mjs --classify` or `player/parity/coverage.test.js` goes red. G-12 (`data/dai-measurements.json`) is NOT required.
- Credentials: none. Network: DAI-04a fetches two RSS feeds; DAI-08 runs 2-byte ranged GETs through `tools/segments/politeness.mjs` — never in CI, manual on the PC, one request in flight. Binaries: DAI-12 needs whisper.cpp (`tools/transcribe/bench_whispercpp.py` documents `whisper-cli` + `ggml-*.bin`) or a Mac for `SFSpeechRecognizer`; nothing needs the founder's phone.

**Open founder questions (true product/spend calls; default proposed for each).**
1. D5/OQ2 — does the playback pad ship before the locate step? Default: yes; DAI-09 flips `AD_PAD_SHIPPED` once DAI-08's data is on main. (Today no committed source injects, so the flip changes no outcome; it is still the ruling `seek-policy.js` waits on.)
2. D5/OQ1 — on-device windowed ASR or Chromaprint first? Default: ASR (option D of `docs/curation/dai-playback-brief-2026-09-10.md` §3); the timed-transcript supply is publisher-transcript, which fingerprinting cannot serve.
3. D5/OQ3–OQ4 — margin = observed spread, N stays 2, ceiling stays 120 s? Default: keep all three until two more Gastropod probes exist.
4. HA #24 — Q1 amend ADR-0008? Default: yes, orchestrator drafts (DAI-15), Wyatt applies `founder-approved`. Q3 distrust the ranged GET host-only or everywhere? Default: host-only (`RANGED_GET_UNTRUSTED_HOSTS` = the two flightcast hosts). Q2 spend two ~60 MB decodes per show on the four unresolved flightcast shows? Default: no. Q4 Around the House (313 s undeclared)? Default: stays `unknown`.
5. Native-only acceptance — "DAI shows play in the app, skip on the web"? Default: yes; the PWA stays skip.
6. Cellular budget for the locate prefetch (up to ~14 min of audio per SYSK segment)? Default: Wi-Fi-only until DAI-12 measures bytes.
7. Spend: decode-and-compare (two full downloads) on 5-4 (RedCircle) now? Default: not until 5-4 is a segment-source candidate.
8. Machine load: may the orchestrator run two agents at once again, and when? Default: one agent until Wyatt says otherwise.

## 2. Task table

| id | title | executor | why-opus | depends-on | size |
|---|---|---|---|---|---|
| DAI-01 | `rangedGetTrusted()` + `RANGED_GET_UNTRUSTED_HOSTS` in ad-inflation.mjs | qwen | — | — | XS |
| DAI-02 | `tools/segments/ad-pad.mjs`: pad arithmetic from a probe ledger (pure) + ledger file | qwen | — | DAI-01 | S |
| DAI-03 | `tools/segments/stamp-ad-pad.mjs`: write stamped fields onto segment-sources rows, `--check`, README | qwen | — | DAI-02 | S |
| DAI-04a | Backfill `audio_bytes` on the 33 DAI source rows from the two RSS feeds | opus | live feed fetch, field data judgement (length="0", URL drift), commits `data/` evidence | — | S |
| DAI-04 | `tools/segments/probe-ad-pad.mjs`: append same-episode ranged-GET probes to the ledger | qwen | — | DAI-02 | XS |
| DAI-05 | foray-resolve hydrates `ad_pad_sec` from the source row | qwen | — | — | XS |
| DAI-06 | check-forays invariants for `ad_*` fields and LOCATE-REQUIRED in a published Foray | qwen | — | — | XS |
| DAI-07a | `AD_PAD_SHIPPED` switch + `forayQueueOptions()` helper in foray-resolve.js | qwen | — | — | S |
| DAI-07b | client.js calls the helper at both Foray sites (+ `again()`), source-text test | qwen | — | DAI-07a | XS |
| DAI-08 | Run the probes on the PC (2 rounds ≥ 24 h apart), stamp, commit the evidence | opus | network politeness, reading field records, judgement on refused rows | DAI-03, DAI-04, DAI-04a, DAI-06 | S |
| DAI-09 | The D5 flip: one browser check, `AD_PAD_SHIPPED = true`, DECISIONS entry | opus | `docs/DECISIONS.md` is DENIED; records a founder ruling; manual browser check | DAI-07b, DAI-08, founder Q1 | XS |
| DAI-10 | `player/locate-window.js`: search-window and located-bounds arithmetic (pure) | qwen | — | — | S |
| DAI-11 | `tools/transcribe/anchor-match.mjs`: fuzzy anchor match over ASR cues (pure) | qwen | — | — | S |
| DAI-12 | Locate-step feasibility measurement on one SYSK episode + doc | opus | local ASR binaries, hand-authored anchors, measurement judgement | DAI-10, DAI-11 | S |
| DAI-13 | `docs/curation/locate-step-design.md` incl. native out-point interaction | opus | product/UX + native protocol design | DAI-10, DAI-11, DAI-12 | S |
| DAI-14 | Rewrite HUMAN-ACTIONS #24 into an answerable v2 item | qwen | — | — | XS |
| DAI-15 | ADR-0008 amendment PR ("a ranged GET can be lied to as well") | opus | `docs/adr/` is DENIED; ADR wording | DAI-01 | S |
| DAI-16 | ad-inflation.mjs header + transcribe README pointer to the trust rule | qwen | — | DAI-01 | XS |
| DAI-17 | queue-manager load-time tests: padded copy plays with the padded out-point; over-pad copy skips | qwen | — | — (sequenced after DAI-07a) | S |

19 tasks; 6 opus (DAI-04a, 08, 09, 12, 13, 15).

## Conventions every task follows (stated once, binding everywhere)

- Worktree, LF: `git -C "C:/Users/wjduv/Desktop/Vibe Coding/foray" fetch origin main` then `git -C "C:/Users/wjduv/Desktop/Vibe Coding/foray" -c core.autocrlf=false worktree add "C:/Users/wjduv/Desktop/Vibe Coding/foray-<task-id>" -b <branch> origin/main`. Remove the worktree when the PR is open (`git worktree remove`) — idle worktrees cost the machine nothing, but a second agent must never start while yours is still running tests. Never run `format:write` repo-wide. If every file shows modified, it is CRLF, not a diff — do not "clean up".
- Never commit `deploy-manifest.json` or `data/forays-directory.json`; `sw.js` keeps `BUILD_ID = "unstamped"` (build outputs, DECISIONS 2026-09-24 #701).
- A new `*.test.js`/`*.test.mjs` suite needs a `FLOORS` entry in `test/suite-integrity.test.js` in the same PR (value = number of top-level `test(` calls). A grown suite raises its floor by exactly the tests added: read the committed value on your branch first, add the delta the task states, and append a trailing `// <task-id>: <reason>; <old> -> <new>` comment in the file's existing style. Tests that name a Foray by id read `tools/foray/fixtures/frozen/data/*.json`, never live `data/`.
- Parity-covered suites (`COVERED_SUITES`, `player/parity/coverage.js:40-57`): after adding a `test(` to one, run `node tools/parity/record.mjs --classify` — it WRITES the `player/parity/unported.json` entries with the suite's default card/family (seek-policy → NE-28j/seek-policy; queue-manager → NE-14j/manager-episode; foray-playback → NE-30j/manager-foray). Do not hand-edit `unported.json`; commit what `--classify` wrote; then `node --test player/parity/coverage.test.js` and `node tools/parity/record.mjs --check` must be green. If `coverage.test.js` names a suite you did not expect to be covered (e.g. `foray-resolve`), run `--classify` again and commit; if it demands a fixture (the suite is in `RECORDED_SUITES`, `coverage.test.js:115`), stop. Never edit `player/parity/fixtures/**`.
- One test process at a time, sequentially. `node tools/ci/run-suites.mjs` once, before opening the PR, holding the lockfile named in the header.
- Commit messages end with the harness's attribution trailer lines (`Co-Authored-By: …` and `Claude-Session: …`); PR bodies end with the harness's attribution block. PRs open as **DRAFT** with the title given in the task. Do not apply labels; do not self-merge.
- Path policy (`tools/ci/path-policy.mjs`): allowlisted = `data/`, `docs/`, `player/`, `tools/`, `test/`, `backend/test/`, `mobile/`, `app.js`, `styles.css`, `search-engine.js`, `STATE.md`, `HUMAN-ACTIONS.md`, `HUMAN-ACTIONS-DONE.md`. DENIED (human merge) = `.github/`, `.claude/`, `CLAUDE.md`, `docs/DECISIONS.md`, `docs/adr/`, `docs/roles.md`, `docs/agents/routine-invariants.md`, `backend/src/`, `tools/ci/`, `tools/test-search.mjs`, `tools/validate-semantic-index.mjs`. `ios/App/**` is unlisted (human merge). A qwen task that finds it must edit a DENIED path stops.
- Stop-and-escalate applies to every task: a test outside the files the task names fails; a DENIED path would need editing; the data does not match the shape stated; `node tools/ci/run-suites.mjs` reports a suite the task did not touch red.

## 3. Task sections

### DAI-01 · `rangedGetTrusted()` and `RANGED_GET_UNTRUSTED_HOSTS` — qwen, XS

**Executor:** qwen.

**Context (read first).**
- `tools/transcribe/ad-inflation.mjs` lines 1-57 (header; "HEAD REQUESTS LIE" at 16), `parseContentRangeTotal` (66), `MIN_PLAUSIBLE_BYTES`/`isPlausibleAudioSize` (78-82), `AD_FREE_FLOOR` (119), `classify` (149), `probeEpisode` (~221-336), `selectTargets` (338).
- `tools/transcribe/README.md` §"THE FINDING THAT MATTERS MOST — a ranged GET can lie too" (~lines 522-600).
- `tools/transcribe/ad-inflation.test.mjs` lines 1-60 (imports, style).
- `test/suite-integrity.test.js:2057` `"tools/transcribe/ad-inflation.test.mjs": 43` (current value; you add +3).

**Exact change.**
1. Directly after `AD_FREE_FLOOR` add `export const RANGED_GET_UNTRUSTED_HOSTS = Object.freeze(["atelier.flightcast.com", "episode.flightcast.com"]);` with a doc comment citing README §"a ranged GET can lie too" and HUMAN-ACTIONS #24: on these origins a ranged request is served the ad-free master's length, so a `Content-Range` total from them is a declaration, not a measurement.
2. Add `export function rangedGetTrusted(urlOrHost)`. Rule, in order: (a) not a string, or empty after `trim()` → `false`. (b) Let `s = input.trim().toLowerCase()`. If `s` contains `://` parse `new URL(s)`; otherwise parse `new URL("https://" + s)` (this handles a bare host and a `host:port`). A throw → `false`. (c) `host = url.hostname`; it must match `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/` else `false` (this refuses `"not a url ::"`, a trailing dot, an IP-less single label). (d) `false` when `host` equals an entry of `RANGED_GET_UNTRUSTED_HOSTS` or ends with `"." + entry`; else `true`. Pure, no network. Ports are stripped by the URL parse; IPv6 literals are refused by the regex (state this in the comment).
3. Change no verdict: `classify`, `summariseShow`, `applyVerdicts` untouched.

**Tests to add** (`tools/transcribe/ad-inflation.test.mjs`, append):
- `'rangedGetTrusted admits an ordinary CDN host'` — `true` for `"https://media.transistor.fm/a/b.mp3"` and for `"www.buzzsprout.com"`. Mutation: return `false` unconditionally → red.
- `'rangedGetTrusted refuses the flightcast origins, by URL, bare host, host:port and subdomain'` — `false` for `"https://episode.flightcast.com/x.mp3"`, `"atelier.flightcast.com"`, `"episode.flightcast.com:443"`, `"cdn.atelier.flightcast.com"`. Mutation: drop the `endsWith` branch → red; empty the list → red.
- `'rangedGetTrusted refuses what it cannot name'` — `false` for `""`, `null`, `"not a url ::"`, `"localhost"`. Mutation: default to `true` on parse failure → red; drop the regex → red on `"localhost"`.
- Floor: +3 (`43 -> 46` if unchanged on your branch), comment `// DAI-01: the ranged-GET trust rule (HUMAN-ACTIONS #24); 43 -> 46`.

**Commands** (worktree root, one at a time): `node --test tools/transcribe/ad-inflation.test.mjs` → 46 pass; `node --test test/suite-integrity.test.js` → pass; `node --test tools/segments/measure-suspects.test.mjs` → 57 pass (it imports this module).

**Do not touch:** `tools/segments/**`, `data/**`, README files (DAI-16), `docs/adr/`.

**Stop and escalate if:** `measure-suspects.test.mjs` fails after the change; an export name already exists (`git grep -n "rangedGetTrusted\|RANGED_GET_UNTRUSTED" origin/main` must print nothing).

**Definition of done:** three commands green; DRAFT PR `feat(transcribe): rangedGetTrusted — the ranged GET is not trusted on flightcast origins (HUMAN-ACTIONS #24)`.

### DAI-02 · `tools/segments/ad-pad.mjs` + `data/ad-pad-probes.json` — qwen, S

**Executor:** qwen.

**Context.**
- `docs/adr/0008-ad-tolerance-and-timestamp-precision.md` §"The pad must be an UPPER BOUND on the delta" (277-358: `delta_max` over N ≥ 2 probes of the SAME episode; `pad = delta_max + margin`, `margin >= observed spread`; admit if `pad <= 120`), §"What we can do today" (413-466), §"Decision" (629-664).
- `tools/segments/merge-segments.mjs:130` `export const ANCHOR_TIME_TOLERANCE_SEC = 120` (import it; never restate 120). Note it imports `../../backend/src/copy/rules.js` (line 100) — that works under plain node (measure-suspects does it).
- `tools/segments/measure-suspects.mjs` `impliedDeltaSec` (~913), `maxDeltaSec` (~934: why cross-episode max is NOT `delta_max`), `adrTier` (~966: tier vocabulary). Reuse the arithmetic; do not import the file.
- `tools/transcribe/ad-inflation.mjs`: `isPlausibleAudioSize` (80), `AD_FREE_FLOOR` (119), `rangedGetTrusted` (DAI-01).
- `data/segment-sources.json` rows `ss-inlaw-investors`, `yc-how-fundraising-works`: the committed `ad_*` shape is SIX fields — `ad_free_ratio, ad_delta_sec, ad_delta_probes, ad_delta_spread_sec, ad_pad_sec, ad_tier`. **`ad_free_ratio` is legacy** (from the ad-inflation scan): this module never reads it, DAI-03 never writes or removes it, DAI-06 never validates it.
- `test/suite-integrity.test.js` `FLOORS` (new entry); `tools/segments/measure-suspects.test.mjs` lines 1-40 for style.

**Exact change.**
1. Create `data/ad-pad-probes.json`: `{ "version": 1, "notes": "<one paragraph: what a probe row is; N >= 2 rows per item_id are needed; rows are appended by tools/segments/probe-ad-pad.mjs and consumed by tools/segments/stamp-ad-pad.mjs; a ranged-get row on an untrusted host is evidence of the declaration only>", "probes": [] }`. LF, 2-space JSON, trailing newline. A probe row is `{ item_id, probed_at (ISO), method: "ranged-get"|"decode", host, status, attempts, declared_bytes, delivered_bytes }` or for decode `{ item_id, probed_at, method: "decode", decoded_duration_sec }`.
2. Create `tools/segments/ad-pad.mjs` exporting:
   - `PROBE_METHODS = Object.freeze(["ranged-get", "decode"])`.
   - `probeDeltaSec(probe, referenceDurationSec)` → `{ delta_sec }` or `{ unusable: string }`. `ranged-get`: `declared_bytes > 0` else `unusable: "no denominator"`; `isPlausibleAudioSize(delivered_bytes)` else `"implausible delivered length"`; `!rangedGetTrusted(probe.host)` → `"ranged-get on an untrusted host"`; else `delta_sec = referenceDurationSec * (delivered_bytes / declared_bytes - 1)`. `decode`: finite `decoded_duration_sec > 0` else `"no decoded duration"`; `delta_sec = decoded_duration_sec - referenceDurationSec`. Other method → `"unknown method"`. Deltas rounded to 0.1 s (`Math.round(x * 10) / 10`).
   - `padFromProbes(probes, { referenceDurationSec })` → exactly one of: `{ refused: "ranged-get on an untrusted host" }` (checked FIRST: any probe unusable for that reason poisons the set — the others from that host are equally spoofed); `{ refused: "n<2", n }` (fewer than 2 usable deltas); `{ refused: "undersized", n }` (any usable delta `< -(1 - AD_FREE_FLOOR) * referenceDurationSec`); else `{ n, delta_max_sec, delta_min_sec, spread_sec, pad_sec, tier, method, measured_at, unusable: string[] }` with `spread_sec = delta_max - delta_min`, `pad_sec = max(0, delta_max) + spread_sec` (0.1 s), `tier = pad_sec <= ANCHOR_TIME_TOLERANCE_SEC ? "PADDABLE" : "LOCATE-REQUIRED"`, `method` = the single method when all usable probes share one else `"mixed"`, `measured_at` = latest `probed_at` among usable probes. Throws `TypeError("probes span more than one item_id")` when `item_id`s differ; throws `TypeError` when `referenceDurationSec` is not a finite positive number.
   - `groupProbesByItem(ledger)` → `Map<item_id, probe[]>` from `ledger.probes`, each group sorted by `probed_at` ascending.
3. No CLI; pure.

**Tests to add** — new suite `tools/segments/ad-pad.test.mjs` (add its `FLOORS` entry = its test count; ≥ 10):
- `"a ranged-get probe's delta is the bitrate-implied seconds, rounded to 0.1"` — declared 40,000,000, delivered 42,000,000, reference 2,400 → `120`. Mutation: drop the `- 1` → red.
- `"a decode probe's delta is decoded minus reference"` — 2,466.1 − 2,400 → `66.1`. Mutation: swap operands → red.
- `"a ranged-get probe on a flightcast origin is unusable"` (host `atelier.flightcast.com`). Mutation: remove the `rangedGetTrusted` call → red.
- `"one probe bounds nothing: n<2 is refused"`. Mutation: `< 2` → `< 1` → red.
- `"the pad reproduces ADR-0008's Gastropod arithmetic"` — decode probes +66.1 and +32.7 → `delta_max_sec 66.1, spread_sec 33.4, pad_sec 99.5, tier "PADDABLE"`. Mutation: `pad = delta_max` → red.
- `"a pad of exactly the ceiling is PADDABLE; one 0.1 s over is LOCATE-REQUIRED"` — deltas such that pad = 120.0 → PADDABLE, pad = 120.1 → LOCATE-REQUIRED; import `ANCHOR_TIME_TOLERANCE_SEC` and assert both against it. Mutation: `<=` → `<` → red.
- `"an undersized delivery refuses rather than pads"` — deltas −60/−58 on reference 2,400 → `refused: "undersized"`. Mutation: clamp negatives → red.
- `"a poisoned set is refused even when a trusted probe is present"` — one untrusted + two trusted → `refused: "ranged-get on an untrusted host"`. Mutation: filter instead of refuse → red.
- `"probes from two item_ids throw"`. `"groupProbesByItem sorts each group by probed_at"`. `"a non-positive reference throws"`.

**Commands:** `node --test tools/segments/ad-pad.test.mjs` → all pass; `node --test test/suite-integrity.test.js` → pass; `node -e "JSON.parse(require('fs').readFileSync('data/ad-pad-probes.json','utf8'))"` → no output, exit 0. The new data file is not in the app manifest (`tools/ci/generate-manifest.mjs` lists only `data/*.json` that `app.js` fetches), so no manifest step applies. (Reviewer's point accepted: the earlier stop condition citing `run-suites.mjs` is deleted.)

**Do not touch:** `data/segment-sources.json`, `data/segments.json`, `tools/segments/measure-suspects.mjs`, `tools/transcribe/**` (import only).

**Stop and escalate if:** importing `merge-segments.mjs` fails under plain node in your worktree.

**Definition of done:** commands green; DRAFT PR `feat(segments): ad-pad.mjs — ADR-0008 pad arithmetic over a same-episode probe ledger`.

### DAI-03 · `tools/segments/stamp-ad-pad.mjs` — qwen, S

**Executor:** qwen.

**Context.** DAI-02's module and ledger; `data/segment-sources.json` top-level shape `{version, built_at, notes, provenance, sources: [...]}` and the 8 rows carrying the six-field `ad_*` set (`ad_free_ratio` is legacy: never written, never removed, ignored by `--check`); `tools/foray/check-forays.mjs:686-695` (source `duration_sec` must agree with every segment's `reference_duration_sec` within 2 s — so `duration_sec` on the source row IS the reference the pad is measured against); `tools/segments/merge-segments.mjs` CLI tail (~613-640, env-path style); `tools/segments/README.md`; `tools/transcribe/ad-inflation.mjs:543` (the `import.meta.url === pathToFileURL(process.argv[1]).href` main guard).

**Exact change.**
1. Create `tools/segments/stamp-ad-pad.mjs` with the main guard above. Paths from env with defaults: `AD_PAD_LEDGER` → `data/ad-pad-probes.json`, `SEGMENT_SOURCES` → `data/segment-sources.json`.
2. `export const STAMPED_FIELDS = Object.freeze(["ad_delta_sec","ad_delta_probes","ad_delta_spread_sec","ad_pad_sec","ad_tier","ad_pad_method","ad_pad_measured_at"])` (seven; `ad_free_ratio` is deliberately absent).
3. `export function stampSources(sourcesDoc, ledger)` → `{ doc, stamped: string[], refused: {item_id, reason}[], untouched: string[] }`. For each `item_id` in `groupProbesByItem(ledger)` with a row in `sourcesDoc.sources`: if `!(row.duration_sec > 0)` → refused `"no duration_sec"`; else `padFromProbes(probes, { referenceDurationSec: row.duration_sec })`; on success set exactly `ad_delta_sec = delta_max_sec`, `ad_delta_probes = n`, `ad_delta_spread_sec = spread_sec`, `ad_pad_sec = pad_sec`, `ad_tier = tier`, `ad_pad_method = method`, `ad_pad_measured_at = measured_at` (existing keys keep their position; new keys append at the row's end); on refusal leave the row untouched and list it. Ledger `item_id`s with no row are ignored (listed under `untouched`). Rows not in the ledger are untouched (the 8 hand-authored rows keep every value, including `ad_free_ratio`). The writer serialises `JSON.stringify(doc, null, 2) + "\n"`.
4. `export function checkSources(sourcesDoc, ledger)` → `[]` or `[{ item_id, field, committed, recomputed }]` for each of the seven fields that differs (numbers compared after rounding to 0.1; `ad_pad_measured_at` string-equal). Rows absent from the ledger are skipped.
5. CLI flags: `--dry-run` (print, write nothing), `--check` (exit 1 and print each drift; exit 0 silent when none), default = write. Lines: `stamped <id> pad=<n>s tier=<tier> n=<n>` / `refused <id>: <reason>`.
6. `tools/segments/README.md`: add subsection "`ad_*` fields on `data/segment-sources.json`": the seven stamped fields with units (seconds, 0.1 s) and the ISO timestamp; the N ≥ 2 rule; the untrusted-host refusal; `stamp-ad-pad.mjs` is the only writer; `ad_free_ratio` is a legacy read-only field from the ad-inflation scan that nothing in `tools/segments/` writes or validates; the consumers of the trust rule are `ad-pad.mjs` and `probe-ad-pad.mjs`.

**Tests to add** — new suite `tools/segments/stamp-ad-pad.test.mjs` (add its `FLOORS` entry):
- `"a source with two usable probes gets the seven stamped fields and nothing else changes"` (deep-equal the row minus the seven fields against the input; a legacy `ad_free_ratio: 1` on the input row survives). Mutation: write `ad_pad_sec = delta_max` → red.
- `"a source with one probe is listed as refused and its row is deep-equal to the input"`. Mutation: stamp on n=1 → red.
- `"a ledger item_id with no source row is ignored, not invented"`. Mutation: push a new row → red.
- `"a row without duration_sec is refused with reason no duration_sec"`.
- `"checkSources reports a drifted spread and is silent on a faithful row"`. Mutation: compare only `ad_pad_sec` → red.
- `"the writer preserves key order and the trailing newline"` (call the exported `serialise(doc)`; `Object.keys` order equal; last char `\n`).
- `"the CLI --dry-run writes nothing"` — spawn `node tools/segments/stamp-ad-pad.mjs --dry-run` with `AD_PAD_LEDGER`/`SEGMENT_SOURCES` pointing at temp copies under `os.tmpdir()` (a two-probe ledger and a one-row sources file); assert file contents unchanged and exit 0. This spawn does no network.

**Commands:** `node --test tools/segments/stamp-ad-pad.test.mjs`; `node --test test/suite-integrity.test.js`; `node tools/segments/stamp-ad-pad.mjs --check` → prints nothing (empty ledger), exit 0.

**Do not touch:** `data/segments.json`, `data/segment-sources.json` (the run is DAI-08); `player/**`; `tools/foray/**`.

**Stop and escalate if:** the live sources doc fails to parse or `sources` is not an array.

**Definition of done:** commands green; DRAFT PR `feat(segments): stamp-ad-pad.mjs — write ADR-0008 pads onto segment-sources from the probe ledger`.

### DAI-04a · Backfill `audio_bytes` on the 33 DAI source rows — opus, S

**Executor:** opus. Reason: two live RSS fetches, joining feed enclosures to committed rows by URL/guid with drift judgement, and committing `data/` evidence a later pad is sized from.

**Context.** `data/segment-sources.json` (33 DAI rows: 17 `practical-ai--*` at `pscrb.fm`, 16 Being an Engineer at `www.buzzsprout.com`; none has `audio_bytes`; each carries a guid field — print `Object.keys` of one DAI row first to name it); `data/discover.json` items (`audio_url, audio_bytes, duration_sec`; joins only 6 of the 33 by `audio_url` — accepted as a cross-check, not the source); `tools/transcribe/ad-inflation.mjs:338-347` `selectTargets` (the denominator the scan reads is `it.audio_bytes` = the feed enclosure `length`); `git grep -l "enclosure" origin/main -- tools/` to find the repo's feed parser (reuse it if one exists; otherwise a minimal regex over `<enclosure url="…" length="…"`); `tools/segments/politeness.mjs`; `data/dai-classification.json` (the two shows' feed URLs, if recorded there; otherwise the `provenance` block of segment-sources).

**Exact change.** (1) Fetch each show's RSS once (two requests). (2) For each DAI row, find the enclosure by exact `audio_url`, falling back to guid; record `audio_bytes = Number(length)` when `length > 0`. (3) Rows with `length="0"`/absent or no matching enclosure: leave the row unchanged and list them in the PR table as `un-probeable (decode only)` / `no enclosure match`. (4) Where a discover.json item exists for the same `audio_url`, its `audio_bytes` must equal the feed's; a mismatch is reported, and the feed value wins. (5) Write with `JSON.stringify(doc, null, 2) + "\n"`; no other field changes. Write a throwaway `tools/segments/backfill-audio-bytes.mjs` (NOT a test; no floor) that does 1-5 given `--feed <url> --show <prefix>`, so the run is reproducible.

**Tests:** none new. `node tools/foray/check-forays.mjs` → exit 0; `node --test tools/foray/check-forays.test.mjs` → pass ("the committed data passes with zero errors"); `node --test player/foray-playback.test.js` → pass.

**Commands:** the three above, then `node tools/ci/run-suites.mjs` once under the lockfile.

**Do not touch:** any other `data/` file; `tools/transcribe/**`.

**Stop and escalate if:** either feed returns non-200 twice; fewer than 10 of the 33 rows gain a denominator (then DAI-08's N is too small to be evidence — report and let the orchestrator decide before DAI-04 is dispatched); a matched enclosure's URL differs from the committed `audio_url` (report; do not rewrite `audio_url`).

**Definition of done:** DRAFT PR `data(segments): audio_bytes on the DAI source rows from the feed enclosures (denominator for the ADR-0008 pad probes)` with a table: id, host, feed length, discover length (or —), status; the count of rows with a denominator stated in the first line (DAI-08 reads it).

### DAI-04 · `tools/segments/probe-ad-pad.mjs` (the collector) — qwen, XS

**Executor:** qwen.

**Context.** `tools/transcribe/ad-inflation.mjs` `probeEpisode(url, declaredBytes, { fetchImpl, gate, retryWait, sleep, now })` (~221-336; returns `{ratio, declared_bytes, delivered_bytes, status, attempts, error}`), its fake-fetch tests in `ad-inflation.test.mjs` (~142-176, ~270-296); `tools/segments/politeness.mjs` (the gate lives there; do NOT add a private throttle); `data/segment-sources.json` row fields `id, audio_url, audio_bytes, dai_suspected`; DAI-02's ledger shape.

**Exact change.**
1. Create `tools/segments/probe-ad-pad.mjs`. Export `selectRows(sourcesDoc, { ids = [], all = false })` → `{ rows, skipped: {id, reason}[] }`: candidates = rows whose `id` is in `ids` when `ids` is non-empty, else rows with `dai_suspected === true` (or every row when `all`); a candidate without `audio_url` → `skipped: "no audio_url"`; without `audio_bytes > 0` → `skipped: "no audio_bytes"`.
2. Export `probeRow(row, { probe = probeEpisode, now = () => new Date() })` → `{ item_id: row.id, probed_at: now().toISOString(), method: "ranged-get", host: new URL(row.audio_url).hostname, status, attempts, declared_bytes, delivered_bytes }` or `null` when `delivered_bytes` is null (a failed probe is not evidence; return the `error` via a second field on a wrapper if you prefer, but the ledger row is exactly the shape above — no `ratio`).
3. Export `appendProbes(ledger, probes, { minGapHours = 24 })` → `{ ledger, appended: probe[], tooSoon: {item_id, last}[] }`: a probe whose `item_id` already has a ledger probe within `minGapHours` of its `probed_at` (strictly less than the gap) is refused; otherwise pushed. Returns a NEW ledger object; never mutates the input.
4. Export `async function run({ sourcesDoc, ledger, ids = [], all = false, minGapHours = 24, dryRun = false, probe = probeEpisode, now, log = console.log })` → `{ ledger, appended, tooSoon, skipped, failed }`; sequential, one row at a time; when `dryRun` the returned `ledger` is the input object unchanged. `main()` parses `--id ID` (repeatable), `--all`, `--min-gap-hours N`, `--dry-run`, reads `AD_PAD_LEDGER` (default `data/ad-pad-probes.json`) and `SEGMENT_SOURCES`, calls `run`, and writes the ledger unless `dryRun`. Lines: `probed <id> <delivered>/<declared> host=<host>` / `too soon <id> (last <ISO>)` / `skipped <id>: <reason>` / `failed <id>: <error>`; final count line.

**Tests to add** — new suite `tools/segments/probe-ad-pad.test.mjs` (add its `FLOORS` entry), no network, no spawn, injected `probe` fakes only:
- `"selectRows takes DAI rows with a denominator and names the rest"`. Mutation: drop the `audio_bytes` check → red.
- `"probeRow records the evidence, not a verdict"` — fake `probe` returning delivered 44,961,612 / declared 35,549,607 → fields exact, `"ratio" in row === false`. Mutation: store `ratio` → red.
- `"a probe with no delivered length is not appended"`.
- `"a second probe inside the gap is refused, one outside it is appended"` — 23 h → tooSoon, 25 h → appended. Mutation: gap → 0 → red.
- `"run with dryRun returns the input ledger object untouched"` — `run({..., dryRun: true, probe: fake})` → `result.ledger === ledger` and `ledger.probes.length` unchanged; the same call without `dryRun` appends. Mutation: write on dry run → red.

**Commands:** `node --test tools/segments/probe-ad-pad.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `tools/transcribe/ad-inflation.mjs`, `politeness.mjs`, live `data/**` (the run is DAI-08).

**Stop and escalate if:** `probeEpisode`'s injectable options differ from those named (read its signature first).

**Definition of done:** commands green; DRAFT PR `feat(segments): probe-ad-pad.mjs — append same-episode ranged-GET probes to the pad ledger`.

### DAI-05 · foray-resolve hydrates `ad_pad_sec` from the source row — qwen, XS

**Executor:** qwen.

**Context.** `player/foray-resolve.js:255-346` (`hydrateForayItems`; `ad_pad_sec: seg.ad_pad_sec ?? null` at 334; `src` is the source row from the sources index), `player/foray-queue.js:387-389` (positive numbers only, and only when `episode.dai_suspected`), `player/foray-resolve.test.js:27-60` (`seg`, `src`, `item`, `fixture()` helpers), 201 (`"hydrate fills timestamps from segments and the show from sources"`), `test/suite-integrity.test.js:148` `"player/foray-resolve.test.js": 69` (you add +3).

**Exact change.** Line 334 becomes `ad_pad_sec: isNum(seg.ad_pad_sec) ? seg.ad_pad_sec : (isNum(src?.ad_pad_sec) ? src.ad_pad_sec : null)` where `isNum = (v) => typeof v === "number" && Number.isFinite(v)` (use the file's existing helper if one exists; else define it once at module top), with a two-line comment: the pad is per EPISODE (ADR-0008 decision 2), so its home is the source row; a segment-level value, if ever written, wins.

**Tests to add** (`player/foray-resolve.test.js`, after the test at line 201), final expectations only:
- `"hydrate carries the source row's ad_pad_sec when the segment has none"` — source `ad_pad_sec: 99.5` → item `ad_pad_sec === 99.5`. Mutation: revert line 334 → red.
- `"a segment-level ad_pad_sec wins over the source's"` — seg 40, src 99.5 → `40`. Mutation: swap precedence → red.
- `"a source pad hydrates by type: 0 stays 0, a string is null, NaN is null"` — three fixtures: source `ad_pad_sec: 0` → `0`; `"7"` → `null`; `NaN` → `null`. Mutation: `??` instead of `isNum` → red on `NaN`.
- Floor: +3 (`69 -> 72`).

**Commands:** `node --test player/foray-resolve.test.js` (72 pass); `node --test player/foray-queue.test.js` (44 pass, unchanged); `node --test player/parity/coverage.test.js` (if it names the new tests, `node tools/parity/record.mjs --classify`, commit, rerun); `node --test test/suite-integrity.test.js`.

**Do not touch:** `player/foray-queue.js`, `player/client.js`, `app.js`.

**Stop and escalate if:** `player/foray-playback.test.js` fails — a live source row would be carrying a positive pad that changes a committed Foray's queue; report which.

**Definition of done:** commands green; DRAFT PR `fix(player): the per-episode ad pad on segment-sources reaches the Foray queue`.

### DAI-06 · check-forays invariants for `ad_*` and LOCATE-REQUIRED — qwen, XS

**Executor:** qwen.

**Context.** `tools/foray/check-forays.mjs`: `err`/`warn` helpers (633-634) used by the per-source loop (649-695; message form `segment-sources "<id>": …` at 655-670); `E`/`W` helpers (709-710) used by the per-Foray/per-item loop; the existing `const src = sources.get(seg.item_id);` at 1171 inside the per-item loop (do NOT redeclare it); `ACCEPTED_SHAPES` (289-310; `"source.dai_suspected"` at 303) and the rule at 526-528 (every enumerated value must be carried by committed data — LOCATE-REQUIRED is carried by nothing, so `ad_tier` does NOT go into `ACCEPTED_SHAPES`); `tools/foray/check-forays.test.mjs:79-95` (`live`, `fixture`, `frozen`, `fx()`), 131 (`"the committed data passes with zero errors"`); `tools/segments/merge-segments.mjs:130` (`ANCHOR_TIME_TOLERANCE_SEC`, import it); `test/suite-integrity.test.js:1364` `"tools/foray/check-forays.test.mjs": 168` (you add +5). `ad_free_ratio` is legacy and is not validated.

**Exact change.**
1. Export `AD_TIERS = Object.freeze(["PADDABLE", "LOCATE-REQUIRED"])` as a standalone constant (not in `ACCEPTED_SHAPES`).
2. In the per-source loop, using `err(...)` and the `segment-sources "${s.id}": …` form: when `s.ad_pad_sec !== undefined`: error unless finite number ≥ 0; when `s.ad_pad_sec > 0`: error unless `Number.isInteger(s.ad_delta_probes) && s.ad_delta_probes >= 2`; error unless finite `s.ad_delta_sec`; error unless finite `s.ad_delta_spread_sec >= 0`; error unless `Math.abs(s.ad_pad_sec - (Math.max(0, s.ad_delta_sec) + s.ad_delta_spread_sec)) <= 0.05`; error unless `AD_TIERS.includes(s.ad_tier)` and `s.ad_tier === (s.ad_pad_sec <= ANCHOR_TIME_TOLERANCE_SEC ? "PADDABLE" : "LOCATE-REQUIRED")`. A zero pad (the 8 committed rows) requires only `ad_tier` ∈ `AD_TIERS` when present.
3. In the per-item loop, directly under the existing `const src = sources.get(seg.item_id);` (1171): if `src?.ad_tier === "LOCATE-REQUIRED"`, `E(...)` when the Foray's `status === "published"` (`item <label> draws on LOCATE-REQUIRED source <id> — it would be skipped at play while locateStep() is unimplemented (ADR-0008 decision 5)`), else `W(...)` with the same text.

**Tests to add** (`tools/foray/check-forays.test.mjs`, mutate `fx()` clones; a source row in the fixture gets the fields): `"a pad that is not delta + spread is refused"`; `"a positive pad with one probe is refused"`; `"a pad's tier must follow the ceiling"` (pad 121, tier PADDABLE → error; pad 120, tier PADDABLE → no `ad_` error); `"a zero pad with a legacy ad_free_ratio passes"` (row with the committed six-field zero shape → no `ad_` error); `"a published Foray on a LOCATE-REQUIRED source is an error; a draft is a warning"`. Each mutation: remove the corresponding check → red. Floor: +5 (`168 -> 173`).

**Commands:** `node --test tools/foray/check-forays.test.mjs` (173); `node tools/foray/check-forays.mjs` → exit 0 on live data; `node --test test/suite-integrity.test.js`.

**Do not touch:** `data/**`, `player/**`, `ACCEPTED_SHAPES`.

**Stop and escalate if:** live data fails the new check (report the row; do not edit data); a test asserts every exported vocabulary is in `ACCEPTED_SHAPES`.

**Definition of done:** commands green; DRAFT PR `feat(foray): check-forays refuses a malformed ad pad and a LOCATE-REQUIRED source in a published Foray`.

### DAI-07a · `AD_PAD_SHIPPED` + `forayQueueOptions()` — qwen, S

**Executor:** qwen.

**Context.** `player/seek-policy.js` 57-77 (why `allowAdPad` is off), constants 86-109 (`AD_PAD_CEILING_SEC` at 109), `seekPrecision` 130-207 (`load > adPadSec` at 195); `player/foray-resolve.js:411-441` (`resolveForay` opts; `allowAdPad` default false at 433); `player/foray-queue.js:254-263`; `player/seek-policy.test.js` (style; the `FOREIGN`/`APPROXIMATE`/`PADDED` imports); `player/foray-resolve.test.js` helpers 27-60; `player/parity/unported.json` `"seek-policy"` object; `test/suite-integrity.test.js:254` (`seek-policy` 33, +1) and `:148` (`foray-resolve` 69 — +3 on top of DAI-05's +3 if it merged first; read the current value).

**Exact change.**
1. `player/seek-policy.js`, after `AD_PAD_CEILING_SEC`: `export const AD_PAD_SHIPPED = false;` with a comment: the one switch for ADR-0008's pad tier; `false` until `docs/DECISIONS.md` records the founder's answer to ADR-0008 open question 2 (D5); flipping it is DAI-09's one-line PR; the native M2 `playForay` command's `allowAdPad` must be sent from this constant too (`player/engine-contract.js`, `allowAdPad`).
2. `player/foray-resolve.js`: import `AD_PAD_SHIPPED` from `./seek-policy.js` (check the file's existing imports; add to them). Export `forayQueueOptions(resolved, opts = {})` → `{ resolveItem: (itemId) => resolved.sources.get(itemId) ?? null, isLocalFile: Boolean(opts.isLocalFile), allowAdPad: typeof opts.allowAdPad === "boolean" ? opts.allowAdPad : AD_PAD_SHIPPED }`; and export `forayResolveOptions(opts = {})` → `{ allowAdPad: typeof opts.allowAdPad === "boolean" ? opts.allowAdPad : AD_PAD_SHIPPED }` (the piece client.js spreads into `resolveForay`'s opts). Do not change `resolveForay`'s own default (false) — the helper is where the constant enters.
3. No client.js change here (DAI-07b).

**Tests to add.**
- `player/seek-policy.test.js` (covered): `"AD_PAD_SHIPPED is the one switch and it is off until D5"` — `AD_PAD_SHIPPED === false` and `seekPrecision(<stitched DAI item>, { source: FOREIGN, adPadSec: 100, allowAdPad: AD_PAD_SHIPPED }).precision === APPROXIMATE` (copy the item shape from the file's existing pad test). Then `node tools/parity/record.mjs --classify` writes its `unported.json` entry (NE-28j/seek-policy); commit. Floor +1.
- `player/foray-resolve.test.js`: `"forayQueueOptions defaults allowAdPad to AD_PAD_SHIPPED and resolves items from the join"` (mutation: default to `true` → red); `"an explicit allowAdPad wins over the switch"` (`{allowAdPad: true}` → true; `{allowAdPad: false}` → false; mutation: ignore opts → red); `"the padded join: with allowAdPad the queue item carries ad_pad_applied_sec, without it 0"` — `resolveForay(fixtureForay, { segments, sources, ...forayResolveOptions({ allowAdPad: true }) }).playable[0].ad_pad_applied_sec === 100` for a source `{ dai_suspected: true, ad_pad_sec: 100 }` and a segment with `reference_duration_sec`; with `forayResolveOptions({})` → `0` (mutation: drop `allowAdPad` from the helper → red). Floor +3.

**Commands** (sequential): `node --test player/seek-policy.test.js` (34); `node --test player/foray-resolve.test.js`; `node --test player/foray-queue.test.js`; `node tools/parity/record.mjs --classify` then `node --test player/parity/coverage.test.js`; `node tools/parity/record.mjs --check`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `player/client.js`, `app.js`, `player/queue-manager.js`, `player/foray-queue.js`, `player/parity/fixtures/**`, `mobile/**`.

**Stop and escalate if:** `seek-policy.js` importing into `foray-resolve.js` creates a cycle (`git grep -n "foray-resolve" origin/main -- player/seek-policy.js` must print nothing); `record.mjs --check` reports ids changed.

**Definition of done:** commands green; DRAFT PR `feat(player): AD_PAD_SHIPPED — one switch for ADR-0008's pad, and the helper both Foray paths will call (off)`.

### DAI-07b · client.js wiring through the helper — qwen, XS

**Executor:** qwen.

**Context.** DAI-07a merged. `player/client.js:98` (seek-policy import — not needed here), `resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, unlocked, showDrafts })` at ~4653 with `return resolveForay(doc, { segments: indexSegments(segmentsDoc), sources: indexSources(sourcesDoc), ... })` at 4656; `playForay(resolved, { startIndex, startElapsedSec, onChange, discoverDoc })` at ~5018, its `again` closure at ~5025, and `manager.setQueueFromForay(resolved.hydrated, { resolveItem: (itemId) => resolved.sources.get(itemId) ?? null, ... })` at 5061-5063 (verify with `git grep -n "setQueueFromForay(\|resolveForay(\|const again" origin/main -- player/client.js`); the `./foray-resolve.js` import line in client.js; `player/foray-playback.test.js` (imports `fs`, `path`, `vm` at 6-9 — it already reads source text).

**Exact change.**
1. Extend client.js's `./foray-resolve.js` import with `forayQueueOptions, forayResolveOptions`.
2. `resolve(...)`: add option `allowAdPad` (no default) to the destructure; spread `...forayResolveOptions({ allowAdPad })` into the `resolveForay(doc, {...})` object.
3. `playForay(resolved, {...})`: add option `allowAdPad`; the `again` closure passes `allowAdPad` too; replace the `setQueueFromForay` options object with `forayQueueOptions(resolved, { isLocalFile: false, allowAdPad })` (keep any other keys the object currently carries by spreading them after the helper's result — read the object first).
4. `app.js` unchanged.

**Tests to add** (`player/foray-playback.test.js`, covered suite): `"client.js sends both Foray paths through the seek-policy switch"` — read `player/client.js` with `fs`; assert `/resolveForay\(doc,\s*\{[^}]*\.\.\.forayResolveOptions\(/s` matches once and `/setQueueFromForay\([^;]*forayQueueOptions\(/s` matches once, and that the string `again = () => ForayPlayer.playForay(` line contains `allowAdPad`. Mutation: delete `forayQueueOptions(` at 5061 → red. Run `--classify` (NE-30j/manager-foray), commit. Floor +1 (`91 -> 92`).

**Commands:** `node --check player/client.js`; `node --test player/foray-playback.test.js` (92); `node tools/parity/record.mjs --classify`; `node --test player/parity/coverage.test.js`; `node tools/parity/record.mjs --check`; `node --test test/suite-integrity.test.js`; `node --check app.js`.

**Do not touch:** `app.js`, `player/queue-manager.js`, `player/foray-queue.js`, `player/seek-policy.js`, `player/parity/fixtures/**`.

**Stop and escalate if:** either call site is not at the expected shape (a second `setQueueFromForay(` or `resolveForay(` exists in client.js).

**Definition of done:** commands green; DRAFT PR `feat(player): client.js forwards allowAdPad on both Foray paths through forayQueueOptions (off)`. No runtime test covers client.js, so DAI-09 includes one manual browser check before the flip.

### DAI-08 · Run the probes, stamp, commit the evidence — opus, S

**Executor:** opus. Reason: live network against publisher CDNs under the politeness gate, two rounds ≥ 24 h apart on the founder's PC, and judgement on refused/undersized rows before they become committed evidence.

**Context.** DAI-03, DAI-04, DAI-04a, DAI-06 merged; DAI-04a's PR table (the first line states how many DAI rows have a denominator — call it K; if K = 0 this task is blocked and says so); `tools/foray/verify-source-audio.mjs` header (its 206/`Content-Range` check is the same probe); `tools/transcribe/README.md` §522-600; `STATE.md` header (post a workstream entry: owned files `data/ad-pad-probes.json`, `data/segment-sources.json`).

**Exact change.** Day 1: `node tools/segments/probe-ad-pad.mjs --all` (sequential, ≤ 33 requests, the gate paces them; run when no other agent is active) → commit the ledger on branch `data/ad-pad-probes-r1`. Day 2 (≥ 24 h later): rerun; commit. Then `node tools/segments/stamp-ad-pad.mjs` and `node tools/segments/stamp-ad-pad.mjs --check` → commit `data/segment-sources.json`. Expected: the K rows stamp at `pad ≈ 0`, tier PADDABLE (both shows measured ad-free); rows `refused: undersized` or 403/404 are reported in the PR body with the host, not "fixed"; rows without a denominator are listed; no denominator is invented (a decode is the only instrument, `tools/transcribe/decode-compare.mjs`, out of budget here).

**Tests:** none new; `node tools/foray/check-forays.mjs`, `node --test tools/foray/check-forays.test.mjs` and `node --test player/foray-playback.test.js` must pass on the stamped data.

**Commands:** the three above plus `node tools/ci/run-suites.mjs` once under the lockfile.

**Do not touch:** any `.mjs`; `data/segments.json`.

**Stop and escalate if:** a stamped pad is `> 0` on a source a **published** Foray uses (a supposedly ad-free show now injects — founder-visible); any host returns 429 twice (stop the run).

**Definition of done:** the ledger holds ≥ 2 probes ≥ 24 h apart for every DAI row with a denominator; `--check` prints nothing; DRAFT PR `data: first ADR-0008 pad probes (N=2, 24 h apart) stamped onto segment-sources` with a table of stamped/refused/skipped rows; STATE.md entry moved to completed.

### DAI-09 · The D5 flip — opus, XS

**Executor:** opus. Reason: `docs/DECISIONS.md` is DENIED; the entry records a founder ruling; one manual browser check (the only browser use in this package).

**Context.** Founder Q1 answered; `player/seek-policy.js` `AD_PAD_SHIPPED`; `docs/DECISIONS.md` top (newest first; the 2026-09-25 entry's format); `docs/curation/dai-playback-brief-2026-09-10.md` §4 (what the pad costs).

**Exact change.** (0) Before any edit, with no other agent running: serve the PWA locally, open one Foray in ONE Chrome tab, confirm the console shows the queue built with `allowAdPad: false` (add a one-line `console.debug` locally if needed, do not commit it), close the tab (memory rule, 2026-09-07). (1) One PR: `AD_PAD_SHIPPED = true` (comment cites the DECISIONS entry by date); `player/seek-policy.test.js`'s DAI-07a test flips its expectation to `PADDED`; DAI-07a's `forayQueueOptions` default test flips to `true`; a DECISIONS entry "## 2026-xx-xx (ADR-0008 open question 2: the pad ships before the locate step)" quoting Wyatt verbatim, stating what flips (`AD_PAD_SHIPPED`), what does not (`DRIFT_TOLERANCE_SEC` stays 30; the web still skips LOCATE-REQUIRED), and what reverses it. If the founder says no: no code change; the entry records the "no".

**Commands:** `node --test player/seek-policy.test.js`; `node --test player/foray-resolve.test.js`; `node --test player/foray-playback.test.js`; `node --test player/queue-manager.test.js`; `node tools/parity/record.mjs --check`.

**Do not touch:** `player/client.js`, `app.js`.

**Definition of done:** DRAFT PR `feat(player): ship ADR-0008's pad tier (D5/OQ2) + DECISIONS entry`, `founder-decision` requested in the body; not merged by the agent.

### DAI-10 · `player/locate-window.js` — qwen, S

**Executor:** qwen.

**Context.** ADR-0008 §"What a large delta costs, and what recovers it" (359-412: the window is `delta_max + margin` wide) and Decision (629-664); `docs/curation/dai-playback-brief-2026-09-10.md` §3 (the seek lands EARLY; a located end may be later than authored by up to the window because mid-rolls inside a segment play, never cut); `player/seek-policy.js:230-236` (`locateStep()` stays `{ implemented: false }` — untouched); `player/foray-queue.js:241-243` (`itemRuntimeSec` reads `authored_end_sec`); `tools/ci/generate-manifest.mjs:220` (`:(glob)player/*.js` ships every non-test player module, so this file is dependency-free ES and small); `test/suite-integrity.test.js` (new floor).

**Exact change.** Create `player/locate-window.js` exporting:
- `LOCATED_SPAN_TOLERANCE_SEC = 2`.
- `locateWindow({ start_sec, end_sec, delta_max_sec, spread_sec, margin_sec = spread_sec, lead_sec = 0 })` → validates (all finite; `start_sec >= 0`; `end_sec > start_sec`; `delta_max_sec >= 0`; `spread_sec >= 0`; `lead_sec >= 0`; else `RangeError` naming the field; `margin_sec < spread_sec` → `RangeError("margin below the observed spread (ADR-0008 decision 3)")`) and returns `{ fetch_start_sec: Math.max(0, start_sec - lead_sec), fetch_end_sec: end_sec + delta_max_sec + margin_sec, span_sec: fetch_end_sec - fetch_start_sec, search_start: { from_sec: start_sec, to_sec: start_sec + delta_max_sec + margin_sec }, search_end: { from_sec: end_sec, to_sec: end_sec + delta_max_sec + margin_sec } }`.
- `windowBytes(span_sec, bitrate_bps)` → `Math.ceil(span_sec * bitrate_bps / 8)`; non-finite or non-positive input → `null`.
- `locatedBounds({ start_hit_sec, end_hit_sec, authored: { start_sec, end_sec }, window })` → `{ start_sec: start_hit_sec, end_sec: end_hit_sec, shift_start_sec: start_hit_sec - authored.start_sec, shift_end_sec: end_hit_sec - authored.end_sec }` or `{ refused: reason }` when: a hit is not finite (`"hit not a number"`); a hit lies outside its `window.search_*` range (`"start hit outside its search range"` / `"end hit outside its search range"`); `end_hit_sec <= start_hit_sec` (`"end before start"`); located span shorter than authored span by more than `LOCATED_SPAN_TOLERANCE_SEC` (`"located span shorter than authored"`); longer than `authored span + (window.search_end.to_sec - window.search_end.from_sec)` (`"located span longer than the window allows"`).

**Tests to add** — new suite `player/locate-window.test.js` (floor at count, ≥ 9): the brief's SYSK example (start 600, end 720, delta_max 534, spread 80 → `fetch_end_sec 1334`, `span_sec 734`) — mutation: forget the margin → red; `"the margin may not be below the spread"` throws — mutation: drop the check → red; `"lead never goes negative"`; `"windowBytes at 96 kbps for 734 s is 8,808,000"` — mutation: drop `/ 8` → red; `"a hit outside the search range is refused"`; `"a located end before the located start is refused"`; `"a located span shorter than authored by more than 2 s is refused, longer by a mid-roll is accepted"` — mutation: symmetric tolerance → red; `"shifts are reported per end"`; `"junk input refuses or throws, never NaN"`.

**Commands:** `node --test player/locate-window.test.js`; `node --test test/suite-integrity.test.js`; `node --test player/parity/coverage.test.js` (the new suite is not covered; it must not disturb it).

**Do not touch:** `player/seek-policy.js`, `player/foray-queue.js`, `player/queue-manager.js`, `player/parity/**`.

**Stop and escalate if:** `coverage.test.js` names the new suite.

**Definition of done:** commands green; DRAFT PR `feat(player): locate-window.js — ADR-0008 search-window and located-bounds arithmetic (JS reference for the locate step)`.

### DAI-11 · `tools/transcribe/anchor-match.mjs` — qwen, S

**Executor:** qwen.

**Context.** `tools/segments/merge-segments.mjs`: `MIN_ANCHOR_WORDS = 4` (125), `canonical` (146), `buildTranscriptIndex(cues)` → `{tokens, startTimes, endTimes, first}` (168), `findAnchorOccurrences` (197, exact whole-word match); `tools/transcribe/decode-compare.mjs` `transcriptCues` (the `{text, start_sec, end_sec}` cue shape; grep for the name); `docs/adr/0007-segment-anchoring.md` §anchors (8-12 verbatim words); `tools/transcribe/bench_whispercpp.py` header (whisper-cli JSON is segments with timestamps — the caller normalises to cues; this module never reads ASR formats). `test/suite-integrity.test.js:1901` `merge-segments` 39 (unchanged).

**Exact change.** Create `tools/transcribe/anchor-match.mjs` (imports `canonical`, `buildTranscriptIndex`, `MIN_ANCHOR_WORDS` from `../segments/merge-segments.mjs`) exporting:
- `wordEditDistance(a, b)` — Levenshtein over two string arrays.
- `MIN_MATCH_SCORE = 0.75`.
- `anchorMatch(cues, anchorText, { minScore = MIN_MATCH_SCORE, from_sec = -Infinity, to_sec = Infinity } = {})` → `{ hit, score, start_sec, end_sec, index, words, candidates }`: `words = canonical(anchorText).split(" ").filter(Boolean)`; fewer than `MIN_ANCHOR_WORDS` → `{ hit: false, reason: "anchor too short", words }`; empty cues → `{ hit: false, reason: "no cues" }`; index the cues; consider every token window of length `L-1`, `L`, `L+1` (L = words.length; lengths < 1 skipped) whose first token's `startTimes[i]` lies in `[from_sec, to_sec]`; `score = 1 - wordEditDistance(window, words) / L` (floor at 0); best = highest score, ties → earliest `i`; `hit = score >= minScore`; `start_sec = startTimes[i]`, `end_sec = endTimes[i + len - 1]`; `candidates` = windows scored. When no window qualifies → `{ hit: false, reason: "no window in range", candidates: 0 }`.

**Tests to add** — new suite `tools/transcribe/anchor-match.test.mjs` (floor, ≥ 8): exact match scores 1 and returns the cue times (mutation: off-by-one in `end_sec` → red); one substituted word in a 10-word anchor scores 0.9 and hits (mutation: `minScore` 0.95 → red); a dropped word hits via the `L-1` window (mutation: only `L` windows → red); an anchor straddling two cues takes `start_sec` from the first and `end_sec` from the second; two occurrences → earliest wins (mutation: latest → red); `from_sec/to_sec` exclude a match outside the window; a 3-word anchor is refused; `wordEditDistance(["a","b"],["a","c","b"]) === 1`.

**Commands:** `node --test tools/transcribe/anchor-match.test.mjs`; `node --test tools/segments/merge-segments.test.mjs` (39, unchanged); `node --test test/suite-integrity.test.js`.

**Do not touch:** `merge-segments.mjs`, `decode-compare.mjs`, any `.py`.

**Stop and escalate if:** importing `merge-segments.mjs` fails under plain node in your worktree.

**Definition of done:** commands green; DRAFT PR `feat(transcribe): anchor-match.mjs — fuzzy anchor location over ASR cues (locate step, pure half)`.

### DAI-12 · Locate-step feasibility measurement — opus, S

**Executor:** opus. Reason: local binaries (whisper.cpp via `tools/transcribe/bench_whispercpp.py`, ffmpeg or PyAV from `tools/transcribe/requirements.txt`), hand-authored ADR-0007 anchors, measurement judgement. Run only when no other agent is active: whisper.cpp is the heaviest process in this package.

**Context.** `docs/curation/foray-to-spec-roadmap.md:724-743` (G-41; "Measurable first step" at 737); ADR-0008 OQ1 (710+); DAI-10/DAI-11 modules; `docs/curation/dai-playback-brief-2026-09-10.md` §3 table (SYSK worst implied delta 534 s); `tools/transcribe/fetch-audio.mjs` and `decode-compare.mjs` headers (download discipline: `data-local/`, delete after); `tools/transcribe/README.md` (whisper.cpp setup); `docs/ios-native-engine-measurements.md` ("Measured" section style). Post a STATE.md entry (owned: the doc + `tools/transcribe/locate-feasibility.mjs`).

**Exact change.** (1) Find one SYSK episode in `data-local/` (2026-08-15 downloads) or download exactly one via `fetch-audio.mjs`; fetch its publisher transcript (`data/transcript-availability.json`). (2) Author three anchors (8-12 verbatim words) at ~10 %, ~50 %, ~90 % of program time. (3) Per anchor: `locateWindow({ start_sec, end_sec: start_sec + 120, delta_max_sec: 534, spread_sec: 80 })`; cut `[fetch_start_sec, fetch_end_sec]` with `ffmpeg -ss … -to … -c copy`; run whisper.cpp `tiny.en` then `base.en` on the cut (never both at once); normalise JSON to cues; `anchorMatch(cues, anchor, { from_sec, to_sec })`. Record wall time, hit/miss and score, `windowBytes(span, bitrate)`, CPU/GPU. (4) Write throwaway `tools/transcribe/locate-feasibility.mjs` (NOT `*.test.mjs`) that does step 3 given `--audio --cues --anchors-json`. (5) Publish `docs/curation/locate-step-feasibility-2026-09.md`: the numbers per anchor and model, device, model file, whisper-cli version, the cut command, and a one-paragraph reading. Delete the audio.

**Commands:** `node --test player/locate-window.test.js` and `node --test tools/transcribe/anchor-match.test.mjs` unchanged; `node tools/ci/run-suites.mjs` once under the lockfile (the script must not be discovered as a suite).

**Do not touch:** `player/**`, `data/**` (except gitignored `data-local/`), `mobile/**`.

**Stop and escalate if:** no whisper.cpp binary and no Mac (the doc records "not measured" and why); the SYSK transcript is not fetchable (use any Triton-class episode on the PC and say so).

**Definition of done:** the doc exists with all numbers and names; DRAFT PR `docs(curation): locate-step feasibility on one SYSK episode (G-41 first step)`; STATE.md entry completed.

### DAI-13 · `docs/curation/locate-step-design.md` — opus, S

**Executor:** opus. Reason: product/UX judgement, native protocol design, out-point interaction with the native deck.

**Context.** `docs/curation/foray-to-spec-roadmap.md:744-752` (G-41 "After D5"); `docs/native-engine-plan.md` §4 (~184-202; three-layer out-point at 198: `forwardPlaybackEndTime = end (+ stopPad)`), cards table 776-785 (NE-25a, NE-28j, NE-28s), NE-32 (grep `NE-32`); `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/AVDeck.swift` (`setOutPoint` → `forwardPlaybackEndTime`; zero-tolerance gate seek — grep both); `mobile/plugins/foray-audio/foray-engine-core/Sources/ForayEngineCore/Engine/EngineCore.swift` (`playForay` capability refusal) and `.../ForayEngineCore/Contract/ContractDecoding.swift` (`allowAdPad`); `player/seek-policy.js:32-55` (the ladder; rung 4 is the locate step), 230-236; `player/foray-queue.js:387-445` (`end_sec = authoredEnd + appliedPad`, `authored_end_sec`, `ad_pad_applied_sec`); `player/queue-manager.js:2435` (`allowAdPad` at the load gate); DAI-10/11/12 outputs; `docs/curation/dai-playback-brief-2026-09-10.md` §3 option D.

**Exact change.** Write the doc with nine sections: (1) **Where the locate result lives** — per-item `located: { start_sec, end_sec, method: "asr-window", score, copy_duration_sec, located_at }` computed natively at Foray open; at load the deck seeks to `located.start_sec` and arms `setOutPoint(located.end_sec)`; `ad_pad_applied_sec` is 0 for a located item; `stopPad` (NE-25a) stays additive and orthogonal; `authored_end_sec` still drives the Foray clock. (2) **Precedence at load** — local file → static → rung 3 exact → located (rung 4) → padded → skip; `seekPrecision` gains a `located` input; the web stays skip. (3) **Cache** — key `(item_id, copy_duration_sec rounded to 1 s)`; invalidate on drift > `DRIFT_TOLERANCE_SEC`; never across devices. (4) **When** — at Foray open, never at tap; a `locating…` state; Wi-Fi-only default pending Q6. (5) **Protocol** — `locateForay {forayId, items[]}` command, a `locate` event/snapshot field, a `locate` diag row `{item, bytes, ms, hit, score}` for `player/parity/vocabulary.json`. (6) **ASR** — `SFSpeechRecognizer` + `requiresOnDeviceRecognition`, `supportsOnDeviceRecognition` check, file-URL window (ranged GET → temp file; mid-stream MP3 slice decodability is a device check); Android deferred. (7) **Cards proposed for the native deck** (NE-4x with sizes) — this doc does NOT edit `docs/native-engine-plan.md`. (8) **Acceptance** — a `locate` parity family whose JS reference is DAI-10 + DAI-11 + the precedence rule. (9) **Feasibility numbers** from DAI-12 and founder Q2/Q5/Q6 with defaults.

**Commands:** `node --test test/*.test.js` only if STATE.md was edited (one process).

**Do not touch:** `docs/native-engine-plan.md`, `player/**`, `mobile/**`.

**Definition of done:** the nine sections exist and cite the files above by full path; DRAFT PR `docs(curation): locate-step design — on-device windowed ASR and the native out-point (G-41)`.

### DAI-14 · Rewrite HUMAN-ACTIONS #24 to be answerable — qwen, XS

**Executor:** qwen.

**Context.** `HUMAN-ACTIONS.md` lines 288-304 on `ecb6bfa3` (heading at 288, `<!-- ha filed=2026-09-11 kind=default -->` at 289, body truncated mid-sentence, placeholder Worked-if; `## #22` follows at 305); `.claude/skills/human-actions/SKILL.md` (format v2: Why ≤ 300 chars, ≤ 10 steps each ≤ 200 chars, one Worked-if ≤ 200 chars, whole item ≤ 1,500 bytes, no other `**Label:**`, order by N descending, never renumber; read-only — `.claude/` is DENIED); `test/human-actions-integrity.test.js` (6 tests: numbering + no retired Foray; it does NOT check the v2 length limits, so the command below is the only check of them).

**Exact change.** Replace the body of item #24 (keep the heading line and the `<!-- ha … -->` comment unchanged) with exactly:

```
**Why:** ADR-0008 adopted the 2-byte ranged GET because HEAD lies. On atelier.flightcast.com the ranged GET is lied to the same way (tools/transcribe/README.md, "a ranged GET can lie too"): 5,461 timed transcripts sit behind that instrument and the ADR still calls it honest.
**Steps:**
1. Reply `amend` or `leave`: the orchestrator drafts the ADR-0008 amendment PR (docs/adr/ is governed; you apply `founder-approved`). Default: amend.
2. Reply `host-only` or `everywhere`: distrust the ranged GET only on hosts the probe grid caught varying (RANGED_GET_UNTRUSTED_HOSTS in tools/transcribe/ad-inflation.mjs), or on every host. Default: host-only.
3. Reply `decode` or `wait` for the four unresolved flightcast shows (two ~60 MB downloads per show, run by hand). Default: wait; none is a segment source.
4. Reply `unknown` or `probe` for Around the House with Eric G (313 s of undeclared audio, 301 transcripts). Default: stays unknown.
**Worked if:** one line per step is recorded in docs/DECISIONS.md and #24 is closed by `ha close` or a `done` reply.
```
Keep one blank line before `## #22`. Then run exactly: `node -e "const t=require('fs').readFileSync('HUMAN-ACTIONS.md','utf8');const s=t.indexOf('## #24');const e=t.indexOf('\n## #',s+1);const b=Buffer.byteLength(t.slice(s,e));if(b>1500){console.error('too long',b);process.exit(1)}console.log(b)"` → prints a number ≤ 1500, exit 0. Do not touch any other item; do not add a `**Decision:**` line.

**Tests:** none new. **Commands:** the byte check above; `node --test test/human-actions-integrity.test.js` (6 pass); `node --test test/*.test.js` (one process).

**Do not touch:** `HUMAN-ACTIONS-DONE.md`, item numbering, `.claude/**`.

**Stop and escalate if:** the items are not already in descending order (do not reorder others); the byte check prints more than 1500.

**Definition of done:** DRAFT PR `docs(human-actions): #24 rewritten so it can be answered — the ranged-GET finding and four replies`.

### DAI-15 · ADR-0008 amendment PR — opus, S

**Executor:** opus. Reason: `docs/adr/` is DENIED (human merge, `founder-approved`); amends an accepted ADR's evidence and decisions.

**Context.** `docs/adr/0008-ad-tolerance-and-timestamp-precision.md`: Status (3), §"What is actually measured, and how" (37-64; "No conclusion in this ADR rests on a HEAD request" at 45), §"What we can do today" (413-466), Decision (629-664), Open questions (710+); `tools/transcribe/README.md` §522-600; `data/decode-and-compare.json` (`results[]` rows `flightcast-doac`, `flightcast-bare`: `downloaded_bytes`, `probe_grid`, decode/transcript durations); `data/flightcast-settle-regrid.json`, `data/breadth-clean-regrid.json` (2 flightcast shows vary, 4 stable; 23/24 clean shows stable); DAI-01's `RANGED_GET_UNTRUSTED_HOSTS`; DAI-14's four questions and defaults; DECISIONS 2026-09-25 entry style.

**Exact change.** (1) Under Status add `**Amended 2026-xx-xx** — see §"A ranged GET can be lied to as well" (HUMAN-ACTIONS #24).`; (2) a new subsection after "What is actually measured, and how" with the DOAC grid table (probe/client × ranged/unranged: 67,510,022 ×3, 68,884,898 on client-unranged; +114.6 s at 96 kbps; two full downloads byte-identical), the "not a platform verdict" finding, and the consequence: every flightcast byte figure in this repo is a master length; (3) Decision item 7: "A delta measured by ranged GET sizes a pad only on hosts the probe grid has not caught varying; `RANGED_GET_UNTRUSTED_HOSTS` in `tools/transcribe/ad-inflation.mjs` is that list, and `tools/segments/ad-pad.mjs` refuses to pad from a probe on it. On those hosts only a decode (`tools/transcribe/decode-compare.mjs`) sizes a pad."; (4) Open question 5 = HA #24 Q2 and Q4 as DAI-14 words them, with defaults; (5) nothing else changes. Keep the measured/inferred voice; cite line-numbered sources.

**Commands:** `node --test test/*.test.js` (one process; the legal/citation suites must stay green).

**Do not touch:** any code; `docs/DECISIONS.md`.

**Definition of done:** DRAFT PR `docs(adr): ADR-0008 amendment — a ranged GET can be lied to as well (HUMAN-ACTIONS #24)`, body requests `founder-decision` and, on `amend`, `founder-approved`.

### DAI-16 · ad-inflation.mjs header and transcribe README pointer — qwen, XS

**Executor:** qwen.

**Context.** `tools/transcribe/ad-inflation.mjs:16-20` ("HEAD REQUESTS LIE" paragraph), `tools/transcribe/README.md:522-600`. (Reviewer's point accepted: the `tools/segments/README.md` edit is dropped from this task — DAI-03 documents the consumers there — so DAI-16 and DAI-03 no longer share a file.)

**Exact change.** (1) After the "HEAD REQUESTS LIE" paragraph add a comment paragraph: "A RANGED GET CAN BE LIED TO AS WELL. `atelier.flightcast.com` serves the master's length to ranged requests and the assembled file to unranged client requests (README §"a ranged GET can lie too", HUMAN-ACTIONS #24). `rangedGetTrusted()` below is the rule; nothing that sizes a pad may read a `Content-Range` total from a host on `RANGED_GET_UNTRUSTED_HOSTS`." (2) In `tools/transcribe/README.md`, at the end of that section, one paragraph naming `RANGED_GET_UNTRUSTED_HOSTS`/`rangedGetTrusted` and the consumers (`tools/segments/ad-pad.mjs`, `tools/segments/probe-ad-pad.mjs`). Comments and docs only.

**Tests:** none. **Commands:** `node --test tools/transcribe/ad-inflation.test.mjs` (count unchanged from your branch); `node --test test/suite-integrity.test.js`.

**Do not touch:** code lines; `tools/segments/README.md`; `docs/adr/`.

**Definition of done:** DRAFT PR `docs(transcribe): the ranged-GET trust rule is named where the probe is documented`.

### DAI-17 · queue-manager load-time tests for the pad — qwen, S

**Executor:** qwen.

**Context.** `player/queue-manager.test.js:24-57` (`FakeBackend` with `durationById`, `setOutPoint` at 49 recording `outPoint:<n>`), 617-640 (`CATALOGUE`: `ep-stitched` is `dai_suspected: true, duration_sec: 2501`; `fseg` start 100 / end 210; `fdai` = stitched with `reference_duration_sec: 2501`; `foray(items)`), the ladder-at-load block (header comment at 1463; tests at ~1466-1495 using `make({ backend: { durationById: { "foray-1#0": 2510 } } })`, `m.playForay(foray([...]), { resolveItem })`, `log`); `player/queue-manager.js:719` (`_forayOptions` from `opts.allowAdPad`), 2435 (`allowAdPad` at the gate); `player/seek-policy.js:175-207` (`load > adPadSec` at 195; message "beyond the … the pad bounds"); `player/foray-queue.js:387-445`; `test/suite-integrity.test.js:217` `queue-manager` 175 (you add +3).

**Exact change.** Tests only; no production code. Append after the ladder-at-load block:
- `"a padded DAI segment whose copy stays inside the pad plays with the PADDED out-point"` — `durationById: { "foray-1#0": 2561 }` (load 60 ≤ pad 100), `m.playForay(foray([fdai({ ad_pad_sec: 100 })]), { resolveItem, allowAdPad: true })` → `m.state.type === "playing"`, `backend.calls.includes("outPoint:310")`, log matches `/padded/i`. Mutation: `foray-queue.js:437` `end_sec: authoredEnd` → red.
- `"a padded DAI segment whose copy carries more ad load than the pad is skipped at load"` — `2701` (load 200 > 100) → skipped at load, log matches `/the pad bounds/`, no `outPoint:310`. Mutation: delete the `load > adPadSec` block → red.
- `"with the pad off, the same segment is skipped and the pad is never applied"` — `allowAdPad` omitted, `2561` → skipped at load, `!backend.calls.includes("outPoint:310")`. Mutation: default `allowAdPad` to `true` at `queue-manager.js:719` → red.
Then `node tools/parity/record.mjs --classify` (writes NE-14j/manager-episode entries); commit. Floor +3 (`175 -> 178`).

**Commands:** `node --test player/queue-manager.test.js` (178); `node tools/parity/record.mjs --classify`; `node --test player/parity/coverage.test.js`; `node tools/parity/record.mjs --check`; `node --test test/suite-integrity.test.js`.

**Do not touch:** any non-test file; `player/parity/fixtures/**`.

**Stop and escalate if:** the first test fails on main as written (the pad path is already broken — report, do not patch production code); the skip is not observable the way the neighbouring ladder tests observe it (copy their assertion form exactly).

**Definition of done:** commands green; DRAFT PR `test(player): the ADR-0008 pad at load — padded out-point, over-pad skip, off by default`.

## 4. Sequencing

**Concurrency: one agent at a time** (founder, 2026-09-25). The queue below is strictly serial; each step starts only after the previous PR is open and its worktree idle. Smallest and most independent first, so the machine is never holding a heavy task and a queue.

1. DAI-01 (XS) → 2. DAI-14 (XS, docs only) → 3. DAI-05 (XS) → 4. DAI-06 (XS) → 5. DAI-16 (XS, after DAI-01) → 6. DAI-02 (S) → 7. DAI-10 (S) → 8. DAI-11 (S) → 9. DAI-07a (S) → 10. DAI-07b (XS) → 11. DAI-17 (S; after 07a so `unported.json` classifies once) → 12. DAI-03 (S) → 13. DAI-04 (XS) → 14. DAI-04a (opus; two feed fetches; run in an idle window) → 15. DAI-08 day 1 → (≥ 24 h) DAI-08 day 2 + stamp → 16. DAI-15 (opus, docs; may run during the DAI-08 wait since it touches no code and no tests beyond `test/*.test.js`) → 17. DAI-12 (opus; whisper.cpp — alone on the machine) → 18. DAI-13 (opus, docs) → 19. DAI-09 (founder-gated: after DAI-07b, DAI-08 and Q1).

Merge order does not matter within steps 1-4 (disjoint files; each bumps its own `test/suite-integrity.test.js` line — rebase on `origin/main` before opening the PR). Dependencies that must be MERGED, not just open: DAI-01 before DAI-02/15/16; DAI-02 before DAI-03/04; DAI-07a before DAI-07b; DAI-03 + DAI-04 + DAI-04a + DAI-06 before DAI-08; DAI-10 + DAI-11 before DAI-12.

**If the founder lifts the cap to two (Q8):** the only pairs that touch disjoint files and are both light are (DAI-14, DAI-05), (DAI-06, DAI-16), (DAI-10, DAI-11), (DAI-03, DAI-04). Never pair an opus task with anything; never run two `run-suites.mjs` (the lockfile enforces it).

**Rejected reviewer points, with reasons.** (a) "`resolve(...).playable[0].ad_pad_applied_sec` does not exist" — it does (`foray-resolve.js:486` returns `playable: report.items`; `foray-queue.js:439` sets the field); the join test stays, moved to `foray-resolve.test.js` where `resolveForay` is reachable. The reachability half of the point is accepted (DAI-07 split, source-text test). (b) "Backfill `audio_bytes` from `data/discover.json`" — measured: it joins only 6 of 33 DAI rows, so DAI-04a reads the two RSS feeds and uses discover only as a cross-check. (c) "Cap at two agents" — tightened to one, per the founder's message that triggered this revision.
