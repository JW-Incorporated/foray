# Bundled neural voice (Kokoro) — hand-off plan for the qwen fleet + opus seats (revision 2)

Package: `docs/bundled-voice-plan.md` K-01..K-08 (K-06/K-07 done), HUMAN-ACTIONS #45 (phone probe), native engine NE-42 (PcmNarrator seat), narration phonemes authored server-side. Revised 2026-09-25 against `origin/main` @ **`ecb6bfa3`** (`feat(playlists) #839`; three commits past the reviewer's `0b2b8f92`, which was itself stale). Every path, symbol and line number below was re-verified with `git show origin/main:<path> | grep -n <symbol>` at that commit.

**Standing instruction for every task (the reviewer's fix, adopted):** before editing, run `git fetch origin && git -c core.autocrlf=false show origin/main:<file> | grep -n <symbol>` for every file:line this plan cites in your task. A line number that no longer lands on the named symbol is a **stop condition**: re-anchor by symbol name if the symbol still exists in the same file, and say so in the PR; if the symbol is gone or moved files, stop and report.

**Disposition of the 12 reviewer problems:** all applied. Two were adjusted rather than copied: (a) the header is stamped to `ecb6bfa3`, not `0b2b8f92`, and the floors the reviewer confirmed have moved again since (`player/foray-queue.test.js` 38→44, `player/queue-manager.test.js` 163→175, `tools/foray/check-forays.test.mjs` 166→168, `tools/mobile/foray-tts.test.mjs` 66→74, `test/voice-settings.test.js` 24→26, `tools/mobile/shell-invariants.test.mjs` 109→111; `phonemize.test.mjs` 13, `kokoro-vocab.test.mjs` 7, `tts-bridge.test.js` 29, `kokoro-probe.test.js` 41, `render-audition.test.mjs` 12, `fetch-models.test.mjs` 18, `test/runPipeline.test.ts` 33 unchanged); (b) the reviewer's `node player/parity/record.mjs --classify` does not exist on main (`git ls-tree origin/main player/parity/` has no `record.mjs`; `coverage.js:35` names it in a comment only), so KV-06/KV-08 hand-edit `player/parity/unported.json` in the documented shape.

## 1. Goal, done-definition, dependencies, open founder questions

**Goal.** A Foray's narration is spoken by our own bundled Kokoro voice on the phone, from phonemes authored on the server at generation time, with the platform voice as an honest per-item fallback. **Done when:** (a) the generation pipeline stamps `phonemes` / `est_sec` / `tts: {engine:"kokoro", model, vocab}` on every narration page it can, and `node tools/foray/check-forays.mjs` is green on the result; (b) `foray-tts` on iOS and Android exposes `speakPhonemes` and `kokoroState`, synthesises chunk-by-chunk through a real audio path, and emits exactly one `finished` per item; (c) `player/queue-manager.js` routes a kokoro item to `speakPhonemes` and a legacy/mismatched item to today's `speak(script)` path, with one non-blocking notice on the first fallback; (d) the three audition-chosen voices are the ones bundled and selectable; (e) `docs/research/on-device-tts.md` §10 carries real phone numbers and a written go/no-go.

**Hard facts that shape every task (all verified at `ecb6bfa3`):**
- The K-02 stage exists (`backend/src/generation/phonemize.ts`) and since the round-3 audit carries a ready-made `phonemizeStage(items, phonemize, log)` (:139-149) and a logging `runPhonemizer` (:166-200, `PHONEMIZER_MAX_BUFFER` :152) — but `runPipeline.ts` still has **zero** occurrences of `phonemiz`; `data/forays.json` carries **0** `phonemes` fields across 157 narration items.
- **Latent defect:** `runPhonemizer` (`phonemize.ts:176-180`) spawns `phonemize.py --json -` and feeds stdin, but `phonemize.py:409-410` does `Path(args.json_in).read_text(...)`, so `-` is a missing file → traceback → exit 1 → the stage returns an empty map (now with a logged reason, still no phonemes). KV-01 fixes this first.
- The first phone reading (2026-09-13, build 2026091316) gave `load 467ms/388ms peak 290.9MB locked=n`; RTF instrument fault fixed in #685; locked-screen clause untested. HA #45 (`HUMAN-ACTIONS.md:102-148`) is open; 25 open items; highest id is **#118**, so the next free id is **#119**.
- 82 of the lexicon's 83 `ipa` fields are null (`mobile/plugins/foray-tts/lexicon/hard-terms.json`); only `sake` → `ˈsɑːkeɪ` is authored.
- NE-33 (SpeechNarrator) has **not** landed: `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/` has `PreviewSpeaker.swift`, `Seams.swift` (`Speaking` :201-210), `EngineBoot.swift`, `AudioSessionOwner.swift`; no `SpeechNarrator.swift`.
- The phoneme-id contract: `phonemize.py ids_for` (:325-360) returns **`[pad, ...ids, pad]`** and refuses when the **padded** length > `max_input_ids` (512); `tools/mobile/kokoro-probe-passage.json` `lines[].ids` are padded (asserted by `kokoro-vocab.test.mjs:109-131`); the style row is chosen by the **unpadded** count (`ids.length - 2`). Every `idsFor` in this plan returns the padded array.
- Parity coverage: `player/parity/coverage.js` `COVERED_SUITES` (:54 `"queue-manager": { card: "NE-14j", family: "manager-episode" }`, :56 `"tts-bridge": { card: "NE-31j", family: "speech-rate" }`); `foray-queue` is **not** covered (`coverage.test.js:98-102` lists the 15 covered stems). Any new test in a covered suite must be listed in `player/parity/unported.json` under its stem (`"queue-manager"` section :280, `"tts-bridge"` :490) as `"<exact test name>": { "card": "<card>", "family": "<family>" }` or `player/parity/coverage.test.js` goes red.
- The iOS plugin registers methods through a table: `ForayTtsPlugin.swift:74-83` `jsName = "ForayTts"`, `pluginMethods: [CAPPluginMethod]` (seven entries ending `kokoroProbe`). New methods must be appended there; the file is not DENIED.
- `tools/mobile/prepare-webdir.mjs:350-351` copies `mobile/plugins/foray-tts/web/foray-tts.js` alone to the webdir root: `foray-tts.js` must never import a sibling module.
- DENIED paths (`tools/ci/path-policy.mjs` `DENIED_PREFIXES` :61-, `DENIED_PATTERNS` :237-) this package touches: `docs/DECISIONS.md` (:65), `docs/adr/` (:66), `backend/src/` (:75), `tools/mobile/fetch-models.mjs` (:169), `tools/mobile/inject-models.mjs` (:170), `tools/mobile/prepare-webdir.mjs` (:218), `test/release-gates.test.js` (:228), any `mobile/**/*.gradle` (:240), any `mobile/**/Package.swift` (pattern block :237-). `STATE.md` (:362) and `HUMAN-ACTIONS.md` (:363) are ALLOWED. Tasks touching DENIED paths are opus and their PRs need `founder-approved` (never self-applied).
- Manifests by full path: `mobile/plugins/foray-tts/Package.swift` (:53 `onnxruntime-swift-package-manager`, :62 product `onnxruntime`); `mobile/plugins/foray-tts/android/build.gradle` (:28 `minSdkVersion ... : 24`, :79 `onnxruntime-android:1.20.0`); `mobile/plugins/foray-audio/Package.swift`. There is no `mobile/plugins/foray-tts/ios/Package.swift`.
- CI: `ios-kit` job (`.github/workflows/ci.yml:146`) builds `-scheme ForayAudio` (:230) and `-scheme ForayTts` (:250).

**Dependencies.** Founder: HA #45 phone record (blocks KV-20, gates the engine's go/no-go); the audition ranking H2 (blocks KV-19). Credentials/environment: a machine that can `pip install -r tools/narration/requirements.txt` plus system `espeak-ng` (the generation host) — needed to author phonemes (KV-01 run) and render audition clips (KV-18); a GitHub release upload for the clips (KV-18). Devices: a founder iPhone and Joey's Pixel 10 Pro for #45 and K-04 acceptance. Other packages: the native engine deck (NE-33 for NE-42's event vocabulary — KV-22 does not wait for it); L-03's `finished` contract is already in `queue-manager.js` (`_onTtsFinished`, used :2077).

**Open founder questions (defaults proposed; agents proceed on the default):**
1. **Where does the phonemizer run?** misaki + espeak-ng are not installed anywhere today. Default: the generation host / cloud env installs `tools/narration/requirements.txt` and `apt-get install espeak-ng`; CI never runs the backend; an absent phonemizer still publishes on the platform-voice path (the module's contract). Until `docs/DECISIONS.md` records an answer, records say "phonemizer host: pending (founder Q1, KV-24)".
2. **Who renders the audition and where do the clips live?** Default: an opus agent renders on the cloud env (weights via the DENIED-but-runnable `tools/mobile/fetch-models.mjs`), uploads the 12+6 clips to a **private** GitHub release, publishes the blind page as a private artifact; founders rank; KV-24 records the result.
3. **Lexicon IPA (82 nulls):** Default: accept espeak's guesses; author IPA only for terms a founder flags during the audition (each a one-line data PR).
4. **HA #45 re-run:** one more locked-phone run on the next build. If RTF passes and only the locked-screen clause fails, default: proceed with the ≤2-chunk buffer design (KV-12/KV-15) and re-test on that build.
5. **Minimum device:** if the oldest phone fails RTF ≤ 1.5, ship with a minimum-device line rather than switch engines. Default: confirm the deck's pre-answer.
6. **Android at the same time as iOS?** Default: yes, both platforms (the probe already exists on both).
7. **Spend on K-08 (CoreML/NNAPI):** Default: defer KV-21 until KV-20 has CPU numbers; skip it if CPU passes with ≥25% margin.
8. **Picker heading when the bundled voice is active:** the deck has no wording (§8 :242 is "Coordination with the other decks"). Default: keep today's heading unchanged; new copy, if wanted, is a one-line founder/opus item outside this package.

**Conventions every task inherits (state them in the PR):** LF worktree: `git -C "<repo>" -c core.autocrlf=false worktree add ../foray-<branch> -b <branch> origin/main`; never commit `deploy-manifest.json` or `data/forays-directory.json`; `sw.js` `BUILD_ID` stays `"unstamped"`; a new `tools/**/*.test.mjs` or `player/**/*.test.js` suite needs a floor in `test/suite-integrity.test.js` `FLOORS` (backend `.test.ts` in `BACKEND_FLOORS`) in the same PR, and a raised floor when adding tests to an existing suite; tests that name a Foray read `tools/foray/fixtures/frozen/data/*.json`, never live `data/`; PRs open as **DRAFT** with the title given per task; commit messages end with the trailer lines your harness supplies (`Co-Authored-By:` + session link); run **one test process at a time** (`node --test <one file>`; `cd backend && npx vitest run <one file>`); never repo-wide `format:write`.

## 2. Task table

| id | title | executor | why-opus | depends-on | size |
|---|---|---|---|---|---|
| KV-01 | `phonemize.py --json -` reads stdin; `phonemize-forays.mjs` batch re-author tool | qwen | — | — | S |
| KV-02 | Wire `phonemizeStage` into `runPipeline.ts` | opus | `backend/src/` is DENIED (human merge) | KV-01 | S |
| KV-03 | check-forays: lexicon-reflected mutation test (`sake`) | qwen | — | — | XS |
| KV-04 | Vocab generator: `player/kokoro-vocab.js`, `KokoroVocab.swift`, `KokoroVocab.java`, generated block in `foray-tts.js`; native pin suite seeded | qwen | — | — | S |
| KV-05 | `player/phoneme-chunks.js`: sentence chunker under the padded id limit | qwen | — | KV-04 | S |
| KV-06 | Web plugin + bridge: `speakPhonemes`, `kokoroState` delegates (+ parity entries) | qwen | — | KV-04 | S |
| KV-07 | `foray-queue.js` carries `phonemes`/`tts`; `est_sec` feeds `narrationDuration` | qwen | — | — | XS |
| KV-08 | `queue-manager.js`: route kokoro items, refuse-on-vocab, engine fallback flag (+ parity entries) | qwen | — | KV-05, KV-06, KV-07 | S |
| KV-09 | `client.js`/`app.js`: boot readiness, `engineFallback` snapshot, first-fallback notice, `ForayPlayer.speakPhonemes` | qwen | — | KV-08 | S |
| KV-10 | Voice picker re-scope: bundled voices with Audition (app.js + tests only) | qwen | — | KV-06, KV-09 | S |
| KV-11 | iOS: `KokoroOrtEngine` returns PCM; probe engine refactored onto it | opus | Swift, compiled only in CI | KV-04 | S |
| KV-12 | iOS: chunk pipeline + `AVAudioEngine` playback + `finished` | opus | Swift/audio session/device | KV-11 | M |
| KV-13 | iOS: `speakPhonemes`/`kokoroState` plugin methods + `pluginMethods` table; transport on the kokoro path | opus | Swift | KV-12 | S |
| KV-14 | Android: `KokoroOrtEngine` returns PCM; probe refactored | opus | Java, compiled only in CI | KV-04 | S |
| KV-15 | Android: chunk pipeline + `AudioTrack` playback + `finished` | opus | Java/audio focus/device | KV-14 | M |
| KV-16 | Android: `speakPhonemes`/`kokoroState` plugin methods | opus | Java | KV-15 | S |
| KV-17 | Audition page generator (blind labels, ranking form) | qwen | — | — | S |
| KV-18 | Render the 12 audition clips, upload privately, file the H2 human action (#119) | opus | credentials, environment, release upload | KV-17 | S |
| KV-19 | Bundle the three chosen voices; `voices.json`; `kokoroState` reports them | opus | `fetch-models.mjs` DENIED; founder decision input | KV-18 (H2 result), KV-13, KV-16 | S |
| KV-20 | HA #45 record → `on-device-tts.md` §10 + verdict | opus | diagnosing from field records | founder run of #45 | XS |
| KV-21 | K-08: CoreML EP on iOS, NNAPI measured on Android | opus | `Package.swift`/`build.gradle` DENIED patterns; device measurement | KV-20 | M |
| KV-22 | NE-42: `PcmNarrator` seat in foray-audio (sine-buffer XCTest, wired to nothing) | opus | Swift, audio session invariant | — (NE-33 optional) | M |
| KV-23 | Records: deck markers, §4.7a flip, plugin README API section, STATE, privacy policy | qwen | — | KV-02, KV-13, KV-16 | S |
| KV-24 | DECISIONS entries (stage wired; voices chosen; go/no-go) | opus | `docs/DECISIONS.md` DENIED | KV-19, KV-20 | XS |

Total 24 tasks: 11 qwen, 13 opus.

## 3. Task sections

### KV-01 · `phonemize.py --json -` reads stdin; `tools/narration/phonemize-forays.mjs` batch re-author tool — qwen — S

**Executor:** qwen. Pure `tools/` work, verifiable with `node --test` and `python`.

**Context (read first):**
- `tools/narration/phonemize.py` — `main()` :380-466; `--json` argument :384; `load_backend()` called at :395 (**before** the input is read today); the `--json` branch :409-425 (`doc = json.loads(Path(args.json_in).read_text(encoding="utf-8"))` at :410); `load_backend()` def :204; `phonemize_script()` :228 (returns `phonemes`, `overrides`, `espeak_fallback`, `est_sec`); `vocab_sha()` :295; `ids_for()` :325.
- `backend/src/generation/phonemize.ts` :166-200 — `runPhonemizer` spawns `[python, "<repo>/tools/narration/phonemize.py", "--json", "-"]` with `input: JSON.stringify({items:[{id,script}]})`, `maxBuffer: PHONEMIZER_MAX_BUFFER` (:152), and expects stdout `{"items":[{id, phonemes, est_sec, tts:{engine,model,vocab}}]}`; `Phonemized` :56; `phonemizeItem` :84 (unchanged items keep their reference).
- `tools/narration/phonemize.test.mjs` (13 tests, floor 13 at `test/suite-integrity.test.js:1787`) — "with no backend installed, --check reports what is missing and exits non-zero" :181 and "--text refuses rather than emitting phonemes nobody produced" :198 show how the suite spawns Python without misaki.
- `tools/foray/check-forays.mjs` `TTS_ENGINES` :158, `phonemeProblems` :199-240.
- `backend/src/generation/forayItems.ts` :181-186 — item shape (`phonemes` :184, `tts` :185, `est_sec` :186, all optional, strict).
- `tools/foray/fixtures/frozen/data/forays.json` — the fixture you test against.

**Exact change:**
1. `phonemize.py` `main()`: read the `--json` document **before** `load_backend()` (move the read above :395): when `args.json_in == "-"`, `doc = json.load(sys.stdin)`; otherwise `json.loads(Path(args.json_in).read_text(encoding="utf-8"))`. On any exception while reading/parsing: `print(f"phonemize: could not read --json input: {exc}", file=sys.stderr); return 2`. Then call `load_backend()` as today (a missing backend still exits 1 with its existing message). Output shape unchanged. Update the `--json` help string (:384) to `path, or "-" for stdin`.
2. New `tools/narration/phonemize-forays.mjs` (ESM, `node:` imports only):
   - CLI: `node tools/narration/phonemize-forays.mjs [--file data/forays.json] [--write] [--python <exe>] [--phonemizer <cmd> <args...>]`. Default is a dry run that prints `pages: N, already phonemized: A, to phonemize: T, phonemized now: P, refused: R` and exits 0; `--write` rewrites the file in place with 2-space indent + trailing newline.
   - Exports: `collectPages(forays) -> Array<{forayId, itemIndex, id, script}>` (items with `type === "narration"`, a non-empty trimmed `script`, and **no** `tts` key); `applyPhonemes(forays, Map<pageId,{phonemes,est_sec,tts}>) -> {forays, applied}` (pure: new objects only for changed items; unchanged items are the same reference); `runBatch(pages, {command, args}) -> Map` (one `spawnSync` for the whole file, JSON on stdin/stdout, `maxBuffer: 64 * 1024 * 1024`, **never throws**: non-zero exit, `error`, or unparsable stdout → empty Map and one stderr line quoting the first 400 chars of the subprocess's stderr).
   - Page ids: `${forayId}#${item.id}`; split on the first `#` on apply.
   - `applyPhonemes` writes exactly `phonemes` (string), `est_sec` (number), `tts` (`{engine:"kokoro", model, vocab}` verbatim). A row whose `phonemes`, `tts.model` or `tts.vocab` is empty/non-string is dropped and counted as refused.
   - Default command: `[process.env.FORAY_PYTHON || "python3", "<repo>/tools/narration/phonemize.py", "--json", "-"]`.
3. New fixture `tools/narration/fixtures/fake-phonemizer.mjs`: reads stdin JSON; answers every item with `phonemes: "fake " + script.length`, `est_sec: script.length/17`, `tts: {engine:"kokoro", model:"1.0", vocab:"sha256:fake"}`; appends one line to the file named by env `FAKE_PHONEMIZER_COUNT_FILE` per invocation; with env `FAKE_PHONEMIZER_FAIL=1` exits 3 with stderr `espeak-ng: not found`.

**Tests to add** (`tools/narration/phonemize-forays.test.mjs`, new; floor it at its test count):
- "collects only narration pages with a script and no tts block" — frozen fixture plus one injected item with `tts`; assert the `tts` item is skipped. Mutation: remove the `!("tts" in item)` guard → red.
- "apply leaves unchanged items as the SAME reference" — `Object.is`. Mutation: spread every item → red.
- "the batch runs ONE subprocess for the whole file" — `--phonemizer node tools/narration/fixtures/fake-phonemizer.mjs` against a temp copy of the frozen forays; count lines in `FAKE_PHONEMIZER_COUNT_FILE` = 1. Mutation: spawn per page → red.
- "a failing backend phonemizes nothing and the file is byte-identical" — `FAKE_PHONEMIZER_FAIL=1` with `--write`; bytes equal before/after; exit 0. Mutation: write on failure → red.
- "dry run never writes" — no `--write`; bytes unchanged. Mutation: drop the flag check → red.
- In `tools/narration/phonemize.test.mjs` add "--json - reads stdin and reports the backend, not a missing file" — spawn `python phonemize.py --json -` with stdin `{"items":[]}`; assert stderr does **not** contain `FileNotFoundError` or `Traceback`, and exit is 1 (backend missing) or 0. **This test is red on main only because the read is moved above `load_backend()`; if you did not move it, the mutation cannot be detected — verify by restoring `Path(args.json_in)` and watching `FileNotFoundError` appear in stderr.** Floor 13 → 14.

**Commands (repo root, one at a time):** `node --test tools/narration/phonemize-forays.test.mjs` (green); `node --test tools/narration/phonemize.test.mjs` (green, 14); `node --test test/suite-integrity.test.js` (green after the floor edits); `node tools/narration/phonemize-forays.mjs` (prints counts, exit 0, no write).

**Do not touch:** `backend/src/**`, `data/forays.json` contents (the real run happens on the generation host under KV-02's follow-up), `tools/mobile/kokoro-probe-passage.json`, `tools/narration/kokoro-vocab.json`.

**Stop and escalate if:** `phonemize.py` has grown a `sys.stdin` branch (grep it); the frozen fixture has narration items already carrying `tts`; any test outside the two named suites goes red.

**Definition of done:** the four commands green; DRAFT PR titled `feat(narration): phonemize.py reads stdin; batch re-author tool for forays.json (KV-01)`; PR body quotes the dry-run output and states that `data/forays.json` is untouched.

---

### KV-02 · Wire `phonemizeStage` into `runPipeline.ts` — opus — S

**Executor:** opus — `backend/src/` is DENIED (human merge) and the stage placement is a pipeline decision (`docs/curation/generation-architecture.md` §4.7a :532 "NOT WIRED: this stage does not run").

**Context:** `backend/src/generation/runPipeline.ts` — `RunPipelineDeps` :115-170 (`finalize?` at :170), `RefusedPartialError` :220, `StageTimingLog` :903, `timings.run` :939, `stageDetail` :956, `const stage = async <T>(name, parse, fn)` :962, `const finalize = deps.finalize ?? finalizeForay` :998, `runtimeSecFor` def :544, `const stitchedItems = stitcher.items()` :1702, `const items = [preludeItem(...), ...stitchedItems]` :1709, `const input: FinalizeForayInput = {` :1737 with `runtimeSec: runtimeSecFor(items, runtimePool)` :1744; `backend/src/generation/phonemize.ts` `Phonemizer` :64, `phonemizeItems` :107, `phonemizedCount` :114, `phonemizeStage` :139-149 (already logs its summary through `log`), `runPhonemizer` :166 (signature `(scripts, {repoRoot, python, log})`); `backend/test/runPipeline.test.ts` :97 (`finalize: recordingFinalize().fn`), the stage-order list :144 (`..., "narrate:0", "stitch:0", "finalize"`) and the timings note :242; `test/suite-integrity.test.js:2284` `"test/runPipeline.test.ts": 33`.

**Exact change:**
1. `RunPipelineDeps` gains `phonemizer?: Phonemizer | null` (doc comment: `null` disables the stage explicitly; `undefined` = production).
2. Production default: a closure built **once per run**: on first call it builds `scripts = items.filter(narration with script).map(i => ({id: i.id, script: i.script}))`, calls `runPhonemizer(scripts, {repoRoot: options.root, python: process.env.FORAY_PYTHON})`, keeps the Map; each call answers `map.get(<id of the item whose script matches>) ?? null`. Because `Phonemizer` is keyed by script text (`(script) => Phonemized | null`), build a second Map `script → Phonemized` from the id-keyed result; on an empty result every call answers `null` (items unchanged).
3. After :1709 and **before** :1737, insert `const phonemized = await stage("phonemize", ForayItemSchema.array(), async () => phonemizeStage(items, phonemizer, (line) => console.log(`  ${line}`)).items)` (use the same `stage` helper the neighbours use so `timings` records `phonemize` between the last `stitch:<n>` and `finalize`). Feed `phonemized` to `FinalizeForayInput.items` and to `runtimeSecFor(phonemized, runtimePool)` at :1744.
4. When `deps.phonemizer === null`, skip the call: `phonemized = items` and record the stage with 0 ms (or `markResumed`-style note if `StageTimingLog` allows a note; otherwise 0 ms). The stage never throws (module contract).

**Tests (`backend/test/runPipeline.test.ts`, 33 → 36):** "phonemize runs between the last stitch and finalize" (stage-order list at :144 gains `"phonemize"` after `"stitch:0"`; mutation: place it after finalize → red); "a phonemizer that answers stamps phonemes/est_sec/tts on every narration page reaching finalize" (inject `phonemizer: () => ({phonemes:"p", model:"1.0", vocab:"v"})` — match the `Phonemized` shape at :56 — and assert via the recording finalize's `input.items`; mutation: pass `items` instead of `phonemized` → red); "a refusing phonemizer leaves items the same references and the run still finalizes" (`phonemizer: () => null`, `Object.is` per item).

**Commands:** `cd backend && npx vitest run test/runPipeline.test.ts` (green); `cd backend && npx vitest run test/phonemize.test.ts` (green); `cd backend && npm run typecheck` (clean); `node --test test/suite-integrity.test.js` (green after `BACKEND_FLOORS` 33 → 36).

**Do not touch:** `phonemize.ts` behaviour (an exported helper that builds the script-keyed Map may be added), `tools/**`, `data/**`.

**Stop and escalate if:** `stage()`'s `parse` rejects `tts` (it must not — `ForayItemSchema` carries the optional fields at :184-186); the `RefusedPartialError` path would need to see phonemes (partials stay unphonemized).

**Definition of done:** commands green; DRAFT PR titled `feat(pipeline): phonemize stage wired between stitch and finalize (K-02, KV-02)`; label `needs-founder` (never `founder-approved`); PR body states the follow-up: run `node tools/narration/phonemize-forays.mjs --write` on the host where misaki is installed and open the data PR from that run.

---

### KV-03 · check-forays: lexicon-reflected mutation test — qwen — XS

**Executor:** qwen.

**Context:** `tools/foray/check-forays.mjs` `lexiconEntries(root)` :171, `phonemeProblems(item, lexiconEntries = [])` :199-240 (the lexicon loop :229-238; the `!phonemes.includes(entry.ipa)` branch :232-235); `tools/foray/check-forays.test.mjs` K-02 block :2840-2993 (eleven tests; the last is "K-02: the real lexicon loads, and is the file the plugin reads" :2981-2993 — it shows how the real lexicon is loaded in the suite); `mobile/plugins/foray-tts/lexicon/hard-terms.json` — the one authored entry `{"term":"sake","ipa":"ˈsɑːkeɪ"}`; floor `"tools/foray/check-forays.test.mjs": 168` at `test/suite-integrity.test.js:1364`.

**Exact change:** add two tests directly after :2993: (1) "K-02: a kokoro item whose script says 'sake' must carry the lexicon's ˈsɑːkeɪ in its phonemes" — item `{type:"narration", id:"p", script:"The sake was poured.", phonemes:"ðə seɪk wɒz pɔːd", tts:{engine:"kokoro", model:"1.0", vocab:"v"}}` with the REAL lexicon (`lexiconEntries()`), assert exactly one problem containing `says "sake"`; mutation: delete the `phonemes.includes(entry.ipa)` branch → red. (2) "K-02: the same item with ˈsɑːkeɪ present passes" — assert `[]`. Raise floor 168 → 170.

**Commands:** `node --test tools/foray/check-forays.test.mjs`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `check-forays.mjs` logic, the lexicon file.

**Stop and escalate if:** the real lexicon has more than one authored `ipa` (then use an injected `lexiconEntries` array and say so).

**Definition of done:** both commands green; DRAFT PR `test(check-forays): lexicon override must survive into phonemes (KV-03)`.

---

### KV-04 · Vocab generator: web constant + Swift/Java tables + generated block in `foray-tts.js`; native pin suite seeded — qwen — S

**Executor:** qwen. Node generator + node tests; Swift/Java files are data-only constants compiled by CI (`ios-kit` `-scheme ForayTts`, `.github/workflows/ci.yml:250`; `android-shell`).

**Context:** `tools/narration/kokoro-vocab.json` (`table`, `pad_id: 0`, `max_input_ids: 512`, provenance keys — read the whole file); `tools/mobile/kokoro-vocab.test.mjs` :57-145 — "the passage's vocab stamp is the sha of the committed table" :100 (copy its sha computation exactly and confirm against `phonemize.py vocab_sha` :295-320), "every line's ids decode back to exactly that line's phonemes" :109-131 (pads at both ends), "no line exceeds the graph's input_ids limit" :131-143 (unpadded count = `ids.length - 2`; the voice file holds 510 style rows); `tools/mobile/kokoro-probe-passage.json` top-level `model: "1.0"`, `vocab: "sha256:498414659c1db01e"`, `lines[].{phonemes, ids}`; `phonemize.py ids_for()` :325-360 (`out = [pad]`, per-character lookup raising `UnsingablePhoneme` on an unknown, `out.append(pad)`, refuse when `len(out) > max_input_ids`); `mobile/plugins/foray-tts/web/foray-tts.js` (:76 `PLUGIN_NAME`; place the generated block directly after the `export const FINISHED_EVENT` line :87); `tools/mobile/prepare-webdir.mjs:350-351` (read-only: `foray-tts.js` is copied alone); `test/release-gates.test.js:481-499` (the espeak gate scans native build inputs for `espeak`, `piper-phonemize`, `phonemizer` — generated files must not contain those words, including comments); `tools/mobile/shell-invariants.test.mjs` (the existing native grep-pin style, floor 111 at `suite-integrity:1502`); output directories `mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/` and `mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/`.

**Exact change:**
1. New `tools/mobile/gen-kokoro-vocab.mjs` with `--check` (exit 1 and a diff summary if any output differs) and default write mode. Header on every generated file/block: `// GENERATED by tools/mobile/gen-kokoro-vocab.mjs from tools/narration/kokoro-vocab.json — do not edit`. Keys emitted sorted by id so regeneration is byte-identical. Outputs:
   - `player/kokoro-vocab.js`: `export const KOKORO_VOCAB_SHA = "sha256:498414659c1db01e"`, `export const KOKORO_MODEL = "1.0"`, `export const KOKORO_PAD_ID = 0`, `export const KOKORO_MAX_INPUT_IDS = 512`, `export const KOKORO_TABLE` (frozen object char→id), `export function idsFor(phonemes) -> number[] | null`: returns the **padded** array `[KOKORO_PAD_ID, ...ids, KOKORO_PAD_ID]` exactly as Python does; `null` on any unknown code point or when the padded length `> KOKORO_MAX_INPUT_IDS`; never a partial array.
   - `mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroVocab.swift`: `enum KokoroVocab { static let sha: String; static let model: String; static let padId: Int; static let maxInputIds: Int; static let table: [Character: Int]; static func ids(for phonemes: String) -> [Int]? }` — same padded rule.
   - `mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/KokoroVocab.java`: `final class KokoroVocab { static final String SHA; static final String MODEL; static final int PAD_ID; static final int MAX_INPUT_IDS; static Integer idFor(int codePoint); static int[] idsFor(String phonemes) /* padded; null on unknown/too long */ }` using a `HashMap<Integer,Integer>` built in a static block over `codePoints()`.
   - A marked block inside `mobile/plugins/foray-tts/web/foray-tts.js` between `// BEGIN GENERATED (tools/mobile/gen-kokoro-vocab.mjs)` and `// END GENERATED` containing `export const KOKORO_VOCAB_SHA = "sha256:498414659c1db01e";` and `export const KOKORO_MODEL = "1.0";` (no table — the web plugin only compares the stamp). The generator rewrites only that block; `--check` compares only that block; if the markers are absent it inserts the block after the `FINISHED_EVENT` export line. **No fourth file; `foray-tts.js` never imports a sibling.**
2. Run the generator once and commit the four outputs.
3. Seed the native chain's pin suite: new `tools/mobile/foray-tts-native.test.mjs` with two `describe` blocks (`"iOS (Swift)"`, `"Android (Java)"`), each holding one pin for now: the generated `KokoroVocab.swift` declares `static func ids(for phonemes: String) -> [Int]?`; `KokoroVocab.java` declares `static int[] idsFor(String phonemes)`. Floor it at 2. Later native tasks (KV-11/13/14/15/16) add pins only to this suite, never to `tools/mobile/foray-tts.test.mjs`.

**Tests (`tools/mobile/kokoro-vocab.test.mjs`, 7 → 12):** "the generated outputs are byte-identical on regeneration" — run the generator to a temp dir (and the block to a temp copy of `foray-tts.js`) and compare with the committed files (mutation: change one id in `player/kokoro-vocab.js` → red); "KOKORO_VOCAB_SHA equals the passage's stamp, the test's own recomputation, and the block in foray-tts.js"; "idsFor decodes every passage line to exactly that line's padded ids" (`assert.deepEqual(idsFor(line.phonemes), line.ids)` over all `lines[]`; mutation: drop a pad → red); "idsFor refuses an unknown character and a padded length over 512 with null, never a partial array"; "no generated file or block contains the espeak gate's needles" (case-insensitive scan for the three strings).

**Commands:** `node tools/mobile/gen-kokoro-vocab.mjs --check` (exit 0); `node --test tools/mobile/kokoro-vocab.test.mjs`; `node --test tools/mobile/foray-tts-native.test.mjs`; `node --test tools/mobile/foray-tts.test.mjs` (still 74, green — the block adds exports only); `node --test test/suite-integrity.test.js` (floors 7 → 12, new suite 2); `node --check player/kokoro-vocab.js`.

**Do not touch:** `tools/narration/kokoro-vocab.json`, `tools/mobile/kokoro-probe-passage.json`, `mobile/plugins/foray-tts/Package.swift`, `mobile/plugins/foray-tts/android/build.gradle`, `tools/mobile/fetch-models.mjs`, `tools/mobile/prepare-webdir.mjs`, anything in `foray-tts.js` outside the generated block.

**Stop and escalate if:** `kokoro-vocab.json`'s `table` has a key longer than one code point (then the lookups need a trie — stop and report); any passage line's `ids` disagree with `[0, ...perChar, 0]`.

**Definition of done:** commands green; CI `ios-kit` and `android-shell` green on the PR; DRAFT PR `feat(kokoro): generated phoneme-id tables for web, Swift and Java (KV-04)`.

---

### KV-05 · `player/phoneme-chunks.js`: sentence chunker under the padded id limit — qwen — S

**Executor:** qwen.

**Context:** `player/kokoro-vocab.js` (KV-04) `idsFor` (padded), `KOKORO_MAX_INPUT_IDS`, `KOKORO_TABLE`; `tools/mobile/kokoro-probe-passage.json` `lines[].phonemes` (real misaki output: space-separated words; punctuation `.`, `,`, `?`, `!`, `;`, `:` kept as characters; `—` possible); `docs/bundled-voice-plan.md` K-04 (chunk by sentence; first audio < 1 s; ≤ 2 chunks buffered).

**Exact change:** new ESM module exporting `chunkPhonemes(phonemes, { maxIds = KOKORO_MAX_INPUT_IDS, idsFor } = {})` → `{ ok: true, chunks: string[] }` or `{ ok: false, reason: "unknown-symbol" | "unsplittable" | "empty" }`. `maxIds` is compared against the **padded** length `idsFor(x).length`. Algorithm (deterministic): (1) trim; empty → `empty`; (2) any code point not in `KOKORO_TABLE` → `unknown-symbol`; (3) split into sentences at `. ? ! ;` followed by a space or end (terminator stays with its sentence); (4) greedily merge consecutive sentences while `idsFor(merged).length <= maxIds` — **but** never merge past a sentence boundary once the running chunk's padded length exceeds `maxIds / 2` (keeps first-audio latency low); (5) a single sentence over `maxIds` is split at the last space before the limit, repeatedly; a single space-free run over `maxIds` → `unsplittable`; (6) chunks are trimmed, non-empty, every chunk satisfies `idsFor(chunk) !== null`, and `chunks.join(" ")` whitespace-collapsed equals the input whitespace-collapsed.

**Tests (`player/phoneme-chunks.test.js`, new; floor at count — `phoneme-chunks` is not in `COVERED_SUITES`, no parity entry needed):** "every passage line chunks and round-trips" (mutation: drop a terminator → red); "a two-sentence line under half the limit stays one chunk"; "sentences past half the limit split at the boundary" (mutation: remove the half rule → red); "an over-long sentence splits at spaces, never mid-word, and every chunk decodes"; "an unknown symbol refuses with unknown-symbol, an unbroken 600-symbol run with unsplittable"; "the same input yields the same chunks twice (deep-equal)".

**Commands:** `node --test player/phoneme-chunks.test.js`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `queue-manager.js`, native code, the passage file, `player/parity/**`.

**Stop and escalate if:** the passage's phonemes contain a sentence-ending character not in the set above (report it; do not widen the set silently).

**Definition of done:** both green; DRAFT PR `feat(player): phoneme sentence chunker for the bundled voice (KV-05)`.

---

### KV-06 · Web plugin + bridge: `speakPhonemes` and `kokoroState` delegates (+ parity entries) — qwen — S

**Executor:** qwen. JS only; the native methods arrive in KV-13/KV-16 and a missing method is a documented refusal.

**Context:** `mobile/plugins/foray-tts/web/foray-tts.js` — `PLUGIN_NAME` :76, `FINISHED_EVENT` :87, the KV-04 generated block right after it (`KOKORO_VOCAB_SHA`, `KOKORO_MODEL`), `shellApplies` :177, `speak` :211-370 (the `bridge.nativePromise(PLUGIN_NAME, "speak", {...})` shape and the never-throw contract), `PROBE_ENGINE` :460, `kokoroProbe` :474-520 (rejection → `{ok:false, path:"native", reason:"engine-absent"}`), `createForayTtsShell` :660-672; `player/tts-bridge.js` — `createTtsBridge` :79, `kokoroProbe` delegate :155-163 (`no-bridge` / `engine-absent`), `onFinished` :230-245; `tools/mobile/foray-tts.test.mjs` (imports :14-31; floor 74 at `suite-integrity:1552`; `readPlugin` :207); `player/tts-bridge.test.js` (floor 29 at :343); `player/parity/coverage.js:56` (`tts-bridge` is covered, card `NE-31j`, family `speech-rate`); `player/parity/unported.json` `"tts-bridge"` section :490 (entry shape `"<test name>": { "card": "NE-31j", "family": "speech-rate" }`); `player/parity/coverage.test.js` (the gate).

**Exact change:**
1. `foray-tts.js`: export `KOKORO_ENGINE = "kokoro"`; export `async function speakPhonemes({ chunks, voice = null, speed = 1, utteranceId, vocab, expectedVocab = KOKORO_VOCAB_SHA, bridge, log } = {})`: `{ok:false, path:"none", reason:"no-chunks"}` when `chunks` is not a non-empty array of non-empty strings; `{ok:false, path:"none", reason:"vocab"}` when `vocab !== expectedVocab` (checked **before** any bridge call); `!shellApplies(bridge)` → `{ok:false, path:"none", reason:"engine-absent"}` (doc comment: there is no Web Speech fallback for phonemes); otherwise `bridge.nativePromise(PLUGIN_NAME, "speakPhonemes", { engine: "kokoro", chunks, voice, speed, utteranceId, vocab })` → `{ok:true, path:"native", engine:"kokoro", voice: result.voice || voice || "", native: result}`; a rejection → `{ok:false, path:"native", reason: r}` where `r` is `err.data?.reason ?? err.message` if in `["engine-absent","vocab","voice-absent","busy"]`, else `"engine-absent"`. Export `async function kokoroState({bridge, log} = {})` → `bridge.nativePromise(PLUGIN_NAME, "kokoroState", {})` → `{ok:true, path:"native", ready: !!r.ready, engine:"kokoro", model: r.model||null, voices: Array.isArray(r.voices)? r.voices: [], warm: !!r.warm, vocab: r.vocab||null}`; no shell / rejection → `{ok:false, path:"none", ready:false, reason:"engine-absent"}`. Add both to `createForayTtsShell` (:660) beside `kokoroProbe` (:664).
2. `tts-bridge.js`: add `speakPhonemes(opts)` and `kokoroState(opts)` delegates with exactly the `kokoroProbe` shape (:155-163): module missing → `{ok:false, path:"none", reason:"no-bridge"}` (`ready:false` added for state); function missing → `reason:"engine-absent"`.
3. `player/parity/unported.json`: under `"tts-bridge"` add the four new test names below as `{ "card": "NE-31j", "family": "speech-rate" }` (alphabetical among the existing keys).

**Tests:** `tools/mobile/foray-tts.test.mjs` (74 → 82): "speakPhonemes: calls ForayTts.speakPhonemes with engine kokoro, chunks, voice, speed, utteranceId, vocab" (mutation: drop `vocab` from the payload → red); "speakPhonemes: a vocab that is not the build's refuses with reason vocab before touching the bridge" (fake bridge not called); "speakPhonemes: no shell → engine-absent, never Web Speech" (fake `speechSynthesis` present, not called); "speakPhonemes: a native rejection with data.reason voice-absent maps to voice-absent, an unknown one to engine-absent, and never rejects"; "speakPhonemes: empty chunks → no-chunks"; "kokoroState: reports ready/voices from native"; "kokoroState: no shell → ready:false engine-absent"; "foray-tts.js has no relative import of a sibling module" (regex over the source for `from "./` or `from "../`; mutation: add one → red). `player/tts-bridge.test.js` (29 → 33): "speakPhonemes: no module → no-bridge", "speakPhonemes: module without the function → engine-absent", "kokoroState: no module → no-bridge, ready false", "kokoroState: module without the function → engine-absent, ready false".

**Commands:** `node --test tools/mobile/foray-tts.test.mjs`; `node --test player/tts-bridge.test.js`; `node --test player/parity/coverage.test.js` (green — the four names are classified); `node --test test/suite-integrity.test.js`; `node tools/mobile/gen-kokoro-vocab.mjs --check`.

**Do not touch:** `speak()` :211-370 behaviour, the generated block, `queue-manager.js`, native sources, `tools/mobile/prepare-webdir.mjs` (DENIED), `player/parity/**` other than the four `unported.json` lines.

**Stop and escalate if:** `coverage.test.js` still reports an unclassified `tts-bridge` test after the entries (quote the message); the generated block is missing from `foray-tts.js` (KV-04 not merged).

**Definition of done:** commands green; DRAFT PR `feat(foray-tts): speakPhonemes and kokoroState on the web half and the bridge (KV-06)`.

---

### KV-07 · `foray-queue.js` carries `phonemes`/`tts`; `est_sec` feeds `narrationDuration` — qwen — XS

**Executor:** qwen.

**Context:** `player/foray-queue.js` — `NARRATION_CHARS_PER_SEC = 17` :153, `const toMs = (sec) => Math.round(sec * 1000) / 1000` :162 (a millisecond **rounding** helper, identity for integers — not a unit conversion), `DURATION_ESTIMATED` :180, `narrationDuration(item)` :206-220 (the `duration_sec` branch :207-215, the estimate `return { sec: toMs(script.length / NARRATION_CHARS_PER_SEC), source: DURATION_ESTIMATED }` :219), `buildForayQueue` :262, the pushed narration item with `duration_sec: dur.sec, duration_source: dur.source` :326; `player/foray-queue.test.js` (floor 44 at `suite-integrity:132`; `foray-queue` is **not** parity-covered — `coverage.test.js:98-102`); `tools/foray/check-forays.mjs` `phonemeProblems` :199-240.

**Exact change:** (1) `narrationDuration`: after the `duration_sec` branch (:207-215) and **before** the script estimate (:219), add `if (isNum(item?.est_sec) && item.est_sec > 0) return { sec: toMs(item.est_sec), source: DURATION_ESTIMATED };` with a comment: still an estimate (17 chars/s authored server-side), same label. Keep the pushed-item field names `duration_sec`/`duration_source` (:326) as they are. (2) In the pushed narration item (:326 block) add `phonemes: typeof raw.phonemes === "string" && raw.phonemes.trim() ? raw.phonemes : null` and `tts: raw.tts && typeof raw.tts === "object" && !Array.isArray(raw.tts) ? { engine: String(raw.tts.engine ?? ""), model: String(raw.tts.model ?? ""), vocab: String(raw.tts.vocab ?? "") } : null` (a copy, never the same reference).

**Tests (`player/foray-queue.test.js`, 44 → 47):** "est_sec wins over the character estimate and stays labelled estimated" (item with a 340-char `script` and `est_sec: 12` → `sec` equals `toMs(12)` which is `12`; `source === DURATION_ESTIMATED`; mutation: reorder branches → red); "a measured duration_sec still beats est_sec"; "phonemes and tts ride onto the queue item as copies; a legacy item carries null for both" (`assert.notStrictEqual(item.tts, raw.tts)` plus deep-equal; mutation: pass the reference → red).

**Commands:** `node --test player/foray-queue.test.js`; `node --test test/suite-integrity.test.js`.

**Do not touch:** `queue-manager.js`, `check-forays.mjs`, `foray-resolve.js`, `player/parity/**`.

**Stop and escalate if:** `foray-queue` appears in `player/parity/coverage.js` `COVERED_SUITES` (it does not at `ecb6bfa3`; if it does now, the three names need `unported.json` entries — stop and report).

**Definition of done:** green; DRAFT PR `feat(player): queue items carry phonemes/tts and honour est_sec (KV-07)`.

---

### KV-08 · `queue-manager.js`: route kokoro items, refuse-on-vocab, engine fallback flag (+ parity entries) — qwen — S

**Executor:** qwen. Pure-JS reducer/transport work with an existing fake-bridge test pattern.

**Context:** `player/queue-manager.js` — constructor `tts` wiring :484 (`this._tts = tts && typeof tts.speak === "function" ? tts : null`), `onFinished` subscription :492, `_speakSeq` :501, `_lastSpeakResult` :521, `setVoice` :1035, `get lastVoiceFallback` :1049, `_playTransitionBridge` call :1491 (bridges are script-only), `_isSynthNarration` :1734, `_speakNarration(item)` :1781-1791 (`_lastSpeakResult = result || null` :1791), `_beginSynthNarration` :1816 (`_speakSeq++` :1818), deadline `narrationDeadlineSec(this._currentItem(), NARRATION_RATE)` :2070, `_onTtsFinished` :2077 (a kokoro utterance ends through the same `finished` event — no second path); `player/queue-manager.test.js` `fakeTts` :832, `spokenRateAt` :906 and the 1x tests :918-920 (floor 175 at `suite-integrity:217`); `player/parity/coverage.js:54` (`queue-manager` is covered, card `NE-14j`, family `manager-episode`); `player/parity/unported.json` `"queue-manager"` section :280 (133 entries; shape `"<test name>": { "card": "...", "family": "..." }`); `player/phoneme-chunks.js` (KV-05); `player/kokoro-vocab.js` (KV-04); `player/tts-bridge.js` (KV-06 delegates).

**Exact change:**
1. Constructor: `this._kokoroReady = false; this._lastEngine = null;`. Add `setKokoroReady(flag)` (boolean-coerce, emit `voice.engine.ready=${flag}` through the existing emit path), getter `lastEngine` (`"kokoro" | "system" | null`) and getter `lastEngineFallback` (`true` when the last spoken item carried `tts.engine === "kokoro"` but was spoken by `"system"`; `false` otherwise; `null` before anything spoke).
2. New `_kokoroEligible(item)` → `true` iff `item.tts?.engine === "kokoro" && item.phonemes && item.tts.vocab === KOKORO_VOCAB_SHA && this._kokoroReady && typeof this._tts?.speakPhonemes === "function"`. Each false reason is emitted once per item: `tts.route item=<id> engine=system why=<not-kokoro|no-phonemes|vocab|engine-not-ready|no-speakPhonemes>`.
3. `_speakNarration(item)`: if `_kokoroEligible(item)`: `const c = chunkPhonemes(item.phonemes, { idsFor })`; if `!c.ok` → emit `tts.route ... why=chunks:<reason>` and fall through to the system path; else `result = await this._tts.speakPhonemes({ chunks: c.chunks, voice: this._voice, speed: 1, utteranceId: `${item.id}#${this._speakSeq + 1}`, vocab: item.tts.vocab })`; if `result.ok === false` and `result.reason` in `["engine-absent","vocab","voice-absent"]` → emit and fall through to the system path (one attempt, no retry); on success `_lastEngine = "kokoro"`. The system path is today's `speak` call unchanged, then `_lastEngine = "system"`. `_lastSpeakResult` semantics unchanged (holds whichever result was final).
4. `speed` is always `1` (DECISIONS 2026-09-24 :118: narration is 1x; never the listener's rate).
5. `player/parity/unported.json`: under `"queue-manager"` add the seven new test names as `{ "card": "NE-14j", "family": "manager-episode" }` (the suite default named in `coverage.js:35-39`).

**Tests (`player/queue-manager.test.js`, 175 → 182):** extend `fakeTts` (:832) with `speakPhonemes` recording `{chunks, voice, speed, utteranceId, vocab}` (returns `{ok:true}` unless a test sets `fake.phonemeReply`). Build a kokoro item from a `tools/foray/fixtures/frozen/data/forays.json` narration item plus `phonemes: <lines[0].phonemes of tools/mobile/kokoro-probe-passage.json>`, `tts: {engine:"kokoro", model:"1.0", vocab: KOKORO_VOCAB_SHA}`. Tests: "a ready engine speaks a kokoro item through speakPhonemes with the chosen voice and speed 1" (mutation: drop `voice` → red); "not ready → the same item speaks script through speak()"; "vocab mismatch → speak(script), lastEngineFallback true" (mutation: remove the vocab clause → red); "engine-absent from speakPhonemes → one system attempt, no second speakPhonemes call"; "a legacy item never calls speakPhonemes and lastEngineFallback is false"; "finished advances a kokoro item exactly once (the existing finish trigger)"; "a kokoro item's deadline comes from est_sec" (via KV-07's `duration_sec`).

**Commands:** `node --test player/queue-manager.test.js`; `node --test player/parity/coverage.test.js` (green — the seven names are classified); `node --test test/suite-integrity.test.js`.

**Do not touch:** `client.js`, `app.js`, native code, `player/parity/**` other than the seven `unported.json` lines.

**Stop and escalate if:** `coverage.test.js` still reports an unclassified `queue-manager` test after the entries; `_speakNarration` has grown a caller beyond the two on main (:1637-1674 region and the bridge path via :1491) — a bridge item without `tts` must still take the system path.

**Definition of done:** green; DRAFT PR `feat(player): the manager speaks phonemes on the bundled voice and falls back honestly (K-05, KV-08)`.

---

### KV-09 · `client.js`/`app.js`: boot readiness, `engineFallback` snapshot, first-fallback notice, `ForayPlayer.speakPhonemes` — qwen — S

**Executor:** qwen. Copy and behaviour are fixed by the deck (K-05: one non-blocking notice the first time a Foray falls back: "Using your phone's voice for this one."); no UX judgement remains.

**Context:** `player/client.js` — `const ttsBridge = createTtsBridge()` :197 (module-level; `client.js` has **no** test suite of its own and cannot be booted in Node), the snapshot line `voiceFallback: manager ? manager.lastVoiceFallback : null` :1664, `manager.setVoice(v)` :2570, the boot default `if (sessionDefaultVoice) manager.setVoice(sessionDefaultVoice)` :4041 (also :3932), `const ForayPlayer = {` :4128, `window.ForayPlayer = ForayPlayer` :5398; `app.js` — `const FY_VOICE_FALLBACK = "..."` :13515, the paint site `else if (s.voiceFallback) paintForayNotice(FY_VOICE_FALLBACK, true);` :14115 (the snapshot → paint path); `player/queue-manager.js` `setKokoroReady`/`lastEngineFallback` (KV-08); `player/tts-bridge.js` `kokoroState`/`speakPhonemes` (KV-06); `test/voice-settings.test.js` — `mount()` :179 (mounts the app.js sheet in a vm; never boots client.js), the source text-pin pattern at :595-612 (`assert.match(src, /import \{[^}]*\bNARRATION_RATE\b.../)`) — copy it; floor 26 at `suite-integrity:567`; DECISIONS 2026-09-23 :422 (the app speaks as "4a", never "we").

**Exact change:**
1. `client.js` boot: directly after :4041, `ttsBridge.kokoroState().then((s) => manager.setKokoroReady(s.ok === true && s.ready === true)).catch(() => manager.setKokoroReady(false));` and re-ask once per `visibilitychange` → visible (a model that warmed later), same expression.
2. `client.js` snapshot: beside :1664 add `engineFallback: manager ? manager.lastEngineFallback : null,` and `engine: manager ? manager.lastEngine : null,`.
3. `client.js` `ForayPlayer` (:4128): add `kokoroState: (opts) => ttsBridge.kokoroState(opts)` and `speakPhonemes: (opts) => ttsBridge.speakPhonemes({ ...opts, speed: 1 })` (KV-10 consumes both; KV-10 touches `app.js` + tests only).
4. `app.js` at :14115: add `else if (s.engineFallback === true && !engineFallbackNoticed) { paintForayNotice(FY_ENGINE_FALLBACK, true); engineFallbackNoticed = true; }` with `const FY_ENGINE_FALLBACK = "Using your phone's voice for this one.";` beside :13515 and `let engineFallbackNoticed = false;` (session-only, never persisted).
5. Diagnostics: where the existing narration diagnostics row is assembled from the snapshot (grep `voiceFallback` in `player/diagnostic-log.js` / `player/engine-diagnostics.js`), append `engine=<kokoro|system>` to that row; add no new row.

**Tests (`test/voice-settings.test.js`, 26 → 29):** "boot asks kokoroState and passes ready, not ok, into the manager" — text pin over `player/client.js` source: `/ttsBridge\.kokoroState\(\)[\s\S]{0,120}setKokoroReady\(s\.ok === true && s\.ready === true\)/` (mutation: `s.ok` alone → red); "the snapshot carries engineFallback from the manager" — text pin `/engineFallback: manager \? manager\.lastEngineFallback : null/`; "the first engine fallback paints the notice once per session" — via the vm harness if `paintForayNotice` and the snapshot consumer are reachable from `mount()` (two snapshots with `engineFallback: true`, one paint); if not reachable, a text pin over `app.js` for `/s\.engineFallback === true && !engineFallbackNoticed/` and the phrase `Using your phone's voice for this one.` (mutation: drop the flag → red), and say which form was used in the PR.

**Commands:** `node --test test/voice-settings.test.js`; `node --check app.js`; `node --check player/client.js`; `node --test "test/*.test.js"` (app.js copy/security invariants + suite-integrity).

**Do not touch:** `sw.js`, `styles.css` (reuse `paintForayNotice`), copy outside the one sentence, `queue-manager.js`.

**Stop and escalate if:** `paintForayNotice` or the `:14115` branch chain no longer exists (stop rather than invent a component); the `"we"` copy invariant test flags the sentence.

**Definition of done:** green; DRAFT PR `feat(app): bundled-voice readiness at boot and the one-time fallback notice (KV-09)`.

---

### KV-10 · Voice picker re-scope: bundled voices with Audition — qwen — S

**Executor:** qwen. The behaviour is fixed: list the bundled voices, keep `cp_voice`, keep Audition, drop the greyed "download in Settings" rows **only when the engine is ready**; otherwise today's picker stays. Heading copy is **unchanged** (founder question 8; no new copy is authored here).

**Context:** `app.js` — `VOICE_ALLOWLIST` :15966, `VOICE_LIST_LANG = "en"` :15991, the sheet root `root.id = "voice-sheet"` :16068, `refreshVoiceList()` :16293 with `player.listVoices({ lang: VOICE_LIST_LANG })` :16300; `player/default-voice.js`; `test/voice-settings.test.js` :285-760 (all 26 existing tests — they must keep passing on the not-ready path); KV-09's `ForayPlayer.kokoroState()` (`voices: [{id, name, about}]`) and `ForayPlayer.speakPhonemes()`; `player/phoneme-chunks.js` (KV-05) and `player/kokoro-vocab.js` (KV-04) — note `app.js` is a classic script: import nothing; pass pre-chunked phonemes from the passage line (the client already fetches `kokoro-probe-passage.json`, `client.js:212-217`; expose the fetched passage's `lines[0]` through the same `ForayPlayer` getter the probe uses, or accept an injected passage in `mount()`).

**Exact change:** (1) At picker open, `const ks = await player.kokoroState()`. If `ks.ready && ks.voices.length > 0`: render one radio row per bundled voice (`name`, `about` from native; `id` is the stored `cp_voice` value), no greyed section, no Open Settings button; an Audition button per row calling `player.speakPhonemes({ chunks: [passageLine0.phonemes], voice: id, vocab: passage.vocab, utteranceId: "audition" })` (a single chunk — the disclosure line is under the limit; `speed` is forced to 1 in KV-09's delegate); selection persists `cp_voice` through the existing setter; default selection = `ks.voices[0].id` when nothing is stored (native orders the winner first — KV-19). If not ready: today's code path, untouched. (2) Heading, count-to-ten Audition on the system path, and all copy: unchanged.

**Tests (`test/voice-settings.test.js`, 29 → 34):** "engine ready: the sheet lists exactly the bundled voices and no Settings path" (mutation: render the allowlist too → red); "engine not ready: the existing behaviours hold (Samantha row present)"; "Audition on a bundled row calls speakPhonemes with that voice id, never speak()"; "with nothing stored the first bundled voice is selected; a stored id is never overridden"; "selecting a bundled row persists cp_voice with the bundled id".

**Commands:** `node --test test/voice-settings.test.js`; `node --check app.js`; `node --test "test/*.test.js"`.

**Do not touch:** `player/default-voice.js`, `player/client.js` (KV-09 owns it), `docs/legal/privacy-policy.md` (KV-23), `sw.js`.

**Stop and escalate if:** the passage is not reachable without the network in the harness (inject it via `mount()` options; if `mount()` cannot carry it, stop); any of the existing 26 tests needs its assertion weakened.

**Definition of done:** green; DRAFT PR `feat(app): the voice picker lists the bundled voices when the engine is ready (V-01 re-scope, KV-10)`.

---

### KV-11 · iOS: `KokoroOrtEngine` returns PCM; the probe engine is refactored onto it — opus — S

**Executor:** opus — Swift, compiled only by CI `ios-kit`; a wrong ORT tensor shape is only observable in a run.

**Context:** `mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroOrtProbeEngine.swift` (275 lines): `KokoroModelFiles.modelURL()` :58, `voiceURL()` :69, `final class KokoroOrtProbeEngine: KokoroProbeEngine` :80, the guard :111, `load()` :134, `environment()` :148, `makeSession()` :154-170, `synthesize(ids:speed:)` :189 (counts and **drops** samples), `run(session:ids:speed:)` :203-268 (three tensors: `input_ids` int64 [1,N] padded, `style` float [1,256] row = unpadded count, `speed` float [1]), `timed` :270; `ForayTtsPlugin.swift` `protocol KokoroProbeEngine` :17-49, `kokoroProbe` :999-; `KokoroVocab.swift` (KV-04); `mobile/plugins/foray-tts/ios/Tests/ForayTtsPluginTests/ForayTtsPluginTests.swift` (CI runs `-scheme ForayTts`, `ci.yml:250`); `player/kokoro-probe.js` `SYNTH_REASONS` :137; `tools/mobile/foray-tts-native.test.mjs` (KV-04; the native pin suite — iOS `describe` block).

**Exact change:** (1) New `KokoroOrtEngine.swift`: `final class KokoroOrtEngine { init?(modelURL: URL, voiceURL: URL); func load() -> (coldMs: Double, warmMs: Double); func synthesize(ids: [Int], speed: Double) -> Result<[Float], KokoroSynthError>; static let sampleRate = 24_000 }`, `KokoroSynthError` cases exactly `SYNTH_REASONS`' strings (`session-absent`, `inference-threw`, `no-output`, `zero-samples`). `ids` are the **padded** array from `KokoroVocab.ids(for:)`; the style row is `ids.count - 2`. The output tensor is copied into `[Float]` before the `ORTValue` is released. (2) `KokoroOrtProbeEngine` becomes a thin adapter: `synthesize` calls the engine and returns `(synthMs, Double(samples.count)/24000, reason)` — behaviour identical, samples still discarded by the probe. (3) Thread options unchanged. (4) One XCTest in new `KokoroOrtEngineTests.swift`: with no model file present, `init?` returns nil and the adapter reports `engine-absent` (no real inference in CI).

**Tests:** the XCTest (mutation: return a non-nil engine without a model → red); the existing ForayTts XCTests green; in `tools/mobile/foray-tts-native.test.mjs` iOS block add: "KokoroOrtEngine.swift declares `func synthesize(ids: [Int], speed: Double) -> Result<[Float], KokoroSynthError>`" and "the probe adapter no longer runs the session itself (no `ORTSession` in KokoroOrtProbeEngine.swift)" (mutation: revert → red). Floor 2 → 4.

**Commands:** `node --test tools/mobile/foray-tts-native.test.mjs`; `node --test test/release-gates.test.js` (read-only run of the espeak gate; no edit); `node --test test/suite-integrity.test.js`; CI `ios-kit` green on the PR.

**Do not touch:** `mobile/plugins/foray-tts/Package.swift` (DENIED pattern), `tools/mobile/fetch-models.mjs`, `tools/mobile/foray-tts.test.mjs`, the Java side, `app.js`.

**Stop and escalate if:** the ORT Swift package's `ORTValue` API does not expose the output buffer without `tensorData()` copying (document the copy cost; do not change the ORT version).

**Definition of done:** CI green; DRAFT PR `refactor(foray-tts ios): a Kokoro engine that returns PCM; the probe rides on it (KV-11)`.

---

### KV-12 · iOS: chunk pipeline + `AVAudioEngine` playback + `finished` — opus — M

**Executor:** opus — audio session policy, background execution and gap measurement need a device.

**Context:** KV-11's engine; `ForayTtsPlugin.swift` `@objc func speak` :600 (session category/mode set today), `pause` :869, `resume` :877, `stop` :893, `stateWord(isSpeaking:isPaused:)` :919, `state` :929, and how `FINISHED_EVENT` is notified (grep `notifyListeners(` in the file); `docs/bundled-voice-plan.md` K-04; `docs/DECISIONS.md` 2026-09-24 :118 (seam 0.5 s; narration 1x); `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/AudioSessionOwner.swift` (the native engine owns the session on the native lane — do not fight it; foray-tts keeps today's policy on the legacy lane).

**Exact change:** new `KokoroNarrator.swift`: `final class KokoroNarrator { init(engine: KokoroOrtEngine); func speak(chunks: [[Int]], speed: Double, utteranceId: String); func pause(); func resume(); func stop(); var isSpeaking: Bool; var isPaused: Bool; var onFinished: ((String) -> Void)?; var onFailed: ((String, String) -> Void)? }`. One `AVAudioEngine` + `AVAudioPlayerNode`, 24 kHz mono float32. A serial `DispatchQueue` synthesises chunk `i+1` while chunk `i` plays; at most **2** rendered chunks waiting (semaphore); each chunk scheduled with `scheduleBuffer(_, completionCallbackType: .dataPlayedBack)`; `onFinished(utteranceId)` fires **once** after the last chunk's playback callback; `stop()` cancels synthesis, stops the node, never fires `finished` (matches `SpeechEnd.cancelled`); `pause()`/`resume()` pause the node only. A new `speak` while speaking stops the old utterance first (no finished for it). Mid-utterance synthesis errors: stop and report `onFailed(utteranceId, reason)`; the plugin maps it to a diagnostics row, not a `finished`.

**Tests:** `KokoroNarratorTests.swift` with a fake engine returning a 0.2 s sine per chunk: "finished fires once for three chunks" (mutation: fire per chunk → red); "stop before the end never fires finished"; "no more than two chunks are rendered ahead"; "a second speak cancels the first's finished". Device check (founder or opus with the phone): a narration-heavy Foray plays locked with no gap > 1 s at chunk boundaries — record in the PR. Pin in `tools/mobile/foray-tts-native.test.mjs` iOS block: "KokoroNarrator.swift schedules with `.dataPlayedBack`" (floor +1).

**Commands:** `node --test tools/mobile/foray-tts-native.test.mjs`; `node --test test/suite-integrity.test.js`; CI `ios-kit` green.

**Do not touch:** `mobile/plugins/foray-tts/Package.swift`, the AVSpeech path, session category constants, `tools/mobile/foray-tts.test.mjs`.

**Stop and escalate if:** `AVAudioEngine` cannot start while another engine holds the session in the same process (log the error code and stop — the NE-33/DV-9 question, needs the native-engine owner); AVAudioEngine tests cannot run on the CI simulator (gate them behind the same skip `SpeechSessionSmokeTests.swift` uses and keep the cancel/once-only logic tests unconditional).

**Definition of done:** CI green; DRAFT PR `feat(foray-tts ios): chunked Kokoro narrator over AVAudioEngine with one finished per line (K-04, KV-12)`.

---

### KV-13 · iOS: `speakPhonemes` / `kokoroState` plugin methods + `pluginMethods` table; transport on the kokoro path — opus — S

**Executor:** opus — Swift.

**Context:** `ForayTtsPlugin.swift` — `jsName = "ForayTts"` :74, `pluginMethods: [CAPPluginMethod]` :75-83 (**table-driven registration**: seven `CAPPluginMethod(name:returnType:)` entries; new methods must be appended here — this file is not DENIED), `speak` :600, `pause` :869, `resume` :877, `stop` :893, `stateWord` :919, `state` :929, `kokoroProbe` :999- (model/voice resolution: reuse `KokoroModelFiles.modelURL()/voiceURL()` and the `model-absent`/`engine-absent` reasons; the 522,240-byte voice-file check); `KokoroVocab.swift` (KV-04); KV-06's payload contract (`{engine, chunks: [String], voice, speed, utteranceId, vocab}` → resolve `{ok, engine, voice}` or reject with the code in the message **and** `data: ["reason": code]`).

**Exact change:** (1) `@objc func speakPhonemes(_ call)`: validate `vocab == KokoroVocab.sha` else `call.reject("vocab", "vocab", nil, ["reason": "vocab"])`; map each chunk via `KokoroVocab.ids(for:)` (padded), any nil → reject `vocab`; resolve the voice file by id from the bundle (`<id>.bin`, 522,240 bytes exactly), absent → reject `voice-absent`; engine constructed lazily once (`static var shared`); `narrator.speak(...)`, then `call.resolve(["ok": true, "engine": "kokoro", "voice": id])` on **accept** (same contract as `speak`); `onFinished` → `notifyListeners(FINISHED_EVENT, ["utteranceId": id, "engine": "kokoro"])`; `onFailed` → the existing diagnostics/log path. (2) `@objc func kokoroState(_ call)`: `["ok": true, "ready": modelPresent && engineLoads, "model": "1.0", "vocab": KokoroVocab.sha, "voices": bundledVoices, "warm": engineLoaded]` — `bundledVoices` from KV-19's `voices.json` when present, else the single entry `{id: "af_heart", name: "Heart", about: "American · female"}`; `ready` answered from a cached flag after a background warm-up kicked off at the first `kokoroState` call (never load on the main thread). (3) Append `CAPPluginMethod(name: "speakPhonemes", returnType: CAPPluginReturnPromise)` and `CAPPluginMethod(name: "kokoroState", returnType: CAPPluginReturnPromise)` to the table at :75-83. (4) `pause`/`resume`/`stop`/`state` consult the narrator when `activeEngine == .kokoro` (`stateWord` inputs from the narrator).

**Tests:** XCTests: "speakPhonemes with a foreign vocab rejects with reason vocab and never touches the engine" (mutation: skip the check → red); "an unknown symbol rejects vocab"; "kokoroState without weights answers ready:false, ok:true"; "the pluginMethods table names speakPhonemes and kokoroState". `tools/mobile/foray-tts-native.test.mjs` iOS block: "ForayTtsPlugin.swift declares `@objc func speakPhonemes` and `@objc func kokoroState` and lists both in pluginMethods" (mutation: rename or drop the table entry → red). Floor +1. **No README edit here** (KV-23 writes the API section once).

**Commands:** `node --test tools/mobile/foray-tts-native.test.mjs`; `node --test test/suite-integrity.test.js`; CI `ios-kit`.

**Do not touch:** `mobile/plugins/foray-tts/Package.swift`, `tools/mobile/fetch-models.mjs`, `tools/mobile/inject-models.mjs`, `mobile/plugins/foray-tts/README.md`, `app.js`, `tools/mobile/foray-tts.test.mjs`.

**Stop and escalate if:** a second registration table exists under a DENIED pattern (an `.m` file or `Package.swift` resource list) that the methods also need.

**Definition of done:** CI green; DRAFT PR `feat(foray-tts ios): speakPhonemes and kokoroState (KV-13)`.

---

### KV-14 · Android: `KokoroOrtEngine` returns PCM; probe refactored — opus — S

**Executor:** opus — Java, compiled only by CI `android-shell`.

**Context:** `mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/KokoroOrtProbeEngine.java`: `extractModel` :120, `readAsset` :141, `load()` :169, `makeSession()` :192 (no EP appended :197), `acceleratorWired()` :219, `synthesize(int[] ids, double speed)` :237, `run` :251, `countSamples` :312 (reads the tensor only to count); `ForayTtsPlugin.java` `kokoroProbe` :930-; `KokoroVocab.java` (KV-04); `tools/mobile/inject-models.mjs` (read-only; assets land at the Android assets root); `tools/mobile/foray-tts-native.test.mjs` Android `describe` block.

**Exact change:** mirror KV-11: `KokoroOrtEngine.java` with `float[] synthesize(int[] paddedIds, double speed) throws KokoroSynthException` (reason strings = `SYNTH_REASONS`), reading the output `float[][]`/`float[]` into a flat array; style row = `ids.length - 2`; `KokoroOrtProbeEngine` becomes the adapter (samples counted from the returned array's length). No test framework exists under `android/` (no `src/test`); pins go in the node suite.

**Tests:** `tools/mobile/foray-tts-native.test.mjs` Android block: "KokoroOrtEngine.java declares `float[] synthesize(`" and "KokoroOrtProbeEngine.java no longer contains `countSamples(`" (mutation: revert → red). Floor +2.

**Commands:** `node --test tools/mobile/foray-tts-native.test.mjs`; `node --test test/suite-integrity.test.js`; CI `android-shell` green.

**Do not touch:** `mobile/plugins/foray-tts/android/build.gradle` (DENIED pattern), iOS, `app.js`, `tools/mobile/foray-tts.test.mjs` (its existing Java pin at :968-980 about `close()` must stay green — keep `close()` semantics).

**Stop and escalate if:** ORT's Java `OnnxTensor.getValue()` returns a shape other than `[1][N]` or `[N]` (log the shape; do not guess a reshape).

**Definition of done:** CI green; DRAFT PR `refactor(foray-tts android): Kokoro engine returns PCM (KV-14)`.

---

### KV-15 · Android: chunk pipeline + `AudioTrack` playback + `finished` — opus — M

**Executor:** opus — audio focus, `AudioTrack` underrun behaviour and a locked screen need a device.

**Context:** KV-14's engine; `ForayTtsPlugin.java` `speak` :182-183 (audio focus / attributes today), `pause` :673-674 (README §"Android has no pause" :228), `resume` :712-713, `stop` :776-777, `state` :841-842, the `finished` notify (grep `notifyListeners("finished"`); `mobile/plugins/foray-tts/android/build.gradle:28` (`minSdkVersion` defaults to **24**, so float PCM is always available — no 16-bit branch); `docs/bundled-voice-plan.md` K-04.

**Exact change:** `KokoroNarrator.java`: one `AudioTrack` (`AudioAttributes` USAGE_MEDIA + CONTENT_TYPE_SPEECH, 24 kHz mono `ENCODING_PCM_FLOAT`, `MODE_STREAM`), a single-thread `ExecutorService` synthesising chunk `i+1` while chunk `i` is written (blocking `write`), at most 2 rendered chunks queued; `finished` once after the last write returns **and** `getPlaybackHeadPosition()` reaches the total frames (poll 50 ms, cap 2 s); `stop()` → `pause(); flush(); stop()` on the track, cancel pending work, no `finished`; `pause()`/`resume()` real on this path (`AudioTrack.pause()`/`play()`) and `state` reports it honestly; audio focus handled exactly as `speak` does today.

**Tests:** `tools/mobile/foray-tts-native.test.mjs` Android block: "KokoroNarrator.java exists and uses ENCODING_PCM_FLOAT"; "the kokoro path notifies finished exactly once (one `notifyListeners("finished"` in the narrator's completion path, none inside the chunk loop)" (mutation: fire per chunk → red). Floor +2. Device check: Joey's Pixel — a narration-heavy Foray locked; gaps < 1 s at chunk boundaries; recorded in the PR.

**Commands:** `node --test tools/mobile/foray-tts-native.test.mjs`; `node --test test/suite-integrity.test.js`; CI `android-shell`.

**Do not touch:** `mobile/plugins/foray-tts/android/build.gradle`, the platform TTS path, iOS, `tools/mobile/foray-tts.test.mjs`.

**Stop and escalate if:** `AudioTrack` construction throws for float PCM on the test device (log the exception; do not silently switch encodings).

**Definition of done:** CI green; DRAFT PR `feat(foray-tts android): chunked Kokoro narrator over AudioTrack with one finished per line (K-04, KV-15)`.

---

### KV-16 · Android: `speakPhonemes` / `kokoroState` plugin methods — opus — S

**Executor:** opus — Java.

**Context:** KV-13's contract (identical payloads and reasons); `ForayTtsPlugin.java` `kokoroProbe` :930- (asset checks for `model-absent`/`engine-absent`); `KokoroVocab.java`; the `@PluginMethod` annotation style at :182, :673, :712, :776, :841, :930.

**Exact change:** `@PluginMethod public void speakPhonemes(PluginCall call)` and `@PluginMethod public void kokoroState(PluginCall call)` with KV-13's validation order (vocab → ids → voice file → engine), `call.reject(reason, reason)` codes `vocab` / `voice-absent` / `engine-absent` / `busy` (put the code in the message; Capacitor Android surfaces it as the JS error message, which KV-06 maps); resolve on accept; `finished` via `notifyListeners` with `utteranceId` and `engine`. `kokoroState` answers from a cached readiness flag warmed on a background thread; `voices` from KV-19's `voices.json` asset when present, else the single `af_heart` entry. `pause`/`resume`/`stop`/`state` route to the narrator when it is active. **No README edit here.**

**Tests:** `tools/mobile/foray-tts-native.test.mjs` Android block: "ForayTtsPlugin.java declares `@PluginMethod` speakPhonemes and kokoroState" (mutation: rename → red). Floor +1.

**Commands:** `node --test tools/mobile/foray-tts-native.test.mjs`; `node --test test/suite-integrity.test.js`; CI `android-shell`.

**Do not touch:** `mobile/plugins/foray-tts/android/build.gradle`, iOS, `app.js`, `mobile/plugins/foray-tts/README.md`, `tools/mobile/foray-tts.test.mjs`.

**Stop and escalate if:** the `@CapacitorPlugin` annotation needs a permissions/alias change (it should not).

**Definition of done:** CI green; DRAFT PR `feat(foray-tts android): speakPhonemes and kokoroState (KV-16)`.

---

### KV-17 · Audition page generator — qwen — S

**Executor:** qwen. Static HTML from a manifest; no clips are needed to build or test it.

**Context:** `tools/narration/render-audition.py` — `OUT_DIR = mobile/models/audition` :58, `SLATE` :63 (twelve ids), `clip_path(label, speed, fingerprint)` :114, `label_key(slate)` :123 (blind A–L → voice id; the key is a separate sealed artefact); `docs/research/voice-audition-2026-09.md` (each founder ranks top five; combined rank picks three; then 1.5×/2.0× confirm); `tools/narration/render-audition.test.mjs` (12 tests; "no audition audio is committed to the repository" :196 — the page must not embed audio).

**Exact change:** new `tools/narration/audition-page.mjs`: `buildPage({ labels: ["A".."L"], clipUrl: (label, speed) => string, fingerprint, round: "rank" | "confirm" }) -> string` (pure) and CLI `node tools/narration/audition-page.mjs --base-url <release asset base> --fingerprint <sha> [--round rank|confirm] --out <file.html>`. One `<section>` per label with a native `<audio controls preload="none" src=...>`, a ranking form (five `<select>`s of labels, no duplicates enforced in inline JS, a "Ranker name" field) and a "Copy result" button producing `{"round":"rank","ranker":"<name>","top5":["C","A",...],"fingerprint":"<sha>"}` as pasteable JSON; the confirm round shows only three labels at 1.5× and 2.0×. Zero external scripts/styles; no voice id string anywhere in the output.

**Tests (`tools/narration/audition-page.test.mjs`, new; floor at count):** "twelve labels, twelve players, no voice id leaks" (scan for every `SLATE` id; mutation: print the key → red); "clip URLs come from clipUrl and the fingerprint is embedded once"; "the ranking form has five selects and the result JSON shape is pinned in the inline script"; "confirm round renders three labels × two speeds"; "the output is deterministic (same input → same bytes)".

**Commands:** `node --test tools/narration/audition-page.test.mjs`; `node --test tools/narration/render-audition.test.mjs` (still green); `node --test test/suite-integrity.test.js`.

**Do not touch:** `render-audition.py`, the audition doc's sealed key section, `mobile/models/**`.

**Stop and escalate if:** `SLATE` no longer has twelve entries.

**Definition of done:** green; DRAFT PR `feat(narration): blind audition page generator (K-03, KV-17)`.

---

### KV-18 · Render the audition clips, upload privately, file the H2 human action — opus — S

**Executor:** opus — needs a workstation/cloud env with Python deps, ~90 MB of weights via a DENIED script (run, not edited), a GitHub release upload (credentials), and a private artifact.

**Context:** `tools/narration/requirements.txt` (pinned: misaki[en]==0.9.4, kokoro-onnx==0.4.9, onnxruntime==1.20.1, numpy, soundfile); `tools/narration/render-audition.py` `--check`, `--render`, `--voices`, `--speeds`, `--key-out`; `tools/mobile/fetch-models.mjs` (fetches model + 12 voices + tokenizer into gitignored `mobile/models/`); `docs/research/voice-audition-2026-09.md` (fill its result section only after ranking); `HUMAN-ACTIONS.md` format (`## #<n> 🟡 [DECIDE] ... <!-- ha filed=YYYY-MM-DD kind=default -->`, Why/Steps/Worked if; highest id is #118 → file **#119**); KV-17's page.

**Exact change:** (1) `pip install -r tools/narration/requirements.txt`, `apt-get install espeak-ng` (server only), `node tools/mobile/fetch-models.mjs`, `python tools/narration/render-audition.py --check` then `--render --key-out <outside the repo>`; (2) the confirm render (`--voices <top3> --speeds 1.5,2.0`) is **deferred** until the ranking is in; (3) upload the 12 clips to a private GitHub release `audition-2026-09` (assets only); (4) build the page with KV-17 against that base URL and publish it as a private artifact; (5) file `HUMAN-ACTIONS.md` #119 "Rank the twelve audition voices (H2)" with the page link, the paste-back instruction (the JSON blob), and "Worked if: two pasted rankings"; (6) the sealed key stays out of the repo (private gist or the artifact's asset store; the HA item says "held by the agent").

**Tests:** none in-repo; acceptance is `render-audition.py`'s determinism — re-render one voice and `sha256sum` equal (quote both hashes in the PR).

**Commands:** the six above; `node --test tools/narration/render-audition.test.mjs` (still green — no audio committed).

**Do not touch:** `fetch-models.mjs`, `render-audition.py` (if `--render` refuses for a reason other than missing deps, stop), `docs/DECISIONS.md`.

**Stop and escalate if:** any wheel fails to install on the host's Python (report versions; do not unpin); the passage's `espeak_fallback_terms` changes between renders (non-determinism).

**Definition of done:** release asset exists (private), page link in HA #119, DRAFT PR `chore(human-actions): #119 rank the audition voices (KV-18)`.

---

### KV-19 · Bundle the three chosen voices; `voices.json`; `kokoroState` reports them — opus — S

**Executor:** opus — edits `tools/mobile/fetch-models.mjs` (DENIED) and consumes a founder decision.

**Context:** `tools/mobile/fetch-models.mjs` `PROBE_VOICE = "af_heart"` :95, `PINS` :97- (`bundle: true` for the model :106; `bundle: id === PROBE_VOICE` :129; tokenizer `bundle: false` :150), `bundledPins` :158, `bundledBytes` :164; `tools/mobile/inject-models.mjs` (copies every `bundle: true` pin); `test/release-gates.test.js` (DENIED; the size budget reads the pinned lengths — three voices add ~1.0 MiB); `docs/bundled-voice-plan.md` §6 :218 (the winner is the default) and K-03 (`mobile/plugins/foray-tts/voices.json`); KV-13/KV-16 `kokoroState.voices`; the H2 result (two pasted rankings).

**Exact change:** (1) combined rank from the two top-fives (Borda 5..1; ties broken by the founder's default named in DECISIONS — if none, stop); (2) `fetch-models.mjs`: `export const BUNDLED_VOICES = ["<winner>", "<2nd>", "<3rd>"]`, `bundle: BUNDLED_VOICES.includes(id)`, `PROBE_VOICE` = winner; (3) new `mobile/plugins/foray-tts/voices.json` `{ "default": "<winner>", "voices": [{ "id", "name", "about" }, ...] }` with the audition doc's display names, winner first; both native `kokoroState` implementations read it from the bundle/assets (iOS: if `mobile/plugins/foray-tts/Package.swift` needs a `resources:` entry, that is a DENIED-pattern edit in the same PR — say so and request `founder-approved` once); (4) `test/release-gates.test.js` budget re-derived from the new pinned bytes (under 150 MB); (5) the slate/pin-set tests stay true (bundling changes `bundle`, not the pin set).

**Tests:** `tools/mobile/fetch-models.test.mjs` (18 → 20): "exactly three voices are bundled and the default is among them" (mutation: bundle a fourth → red); "voices.json ids ⊆ pinned voice ids and default ∈ ids".

**Commands:** `node --test tools/mobile/fetch-models.test.mjs`; `node --test test/release-gates.test.js`; `node --test tools/narration/render-audition.test.mjs`; `node --test test/suite-integrity.test.js`; CI `ios-shell`/`android-shell` (weights injected).

**Do not touch:** `.github/**`; the probe passage.

**Stop and escalate if:** the two rankings disagree on all of the top three; `bundledBytes` pushes the universal APK (131.1 MiB measured) past 150 MiB.

**Definition of done:** CI green; DRAFT PR `feat(voice): bundle the three audition voices (K-03/K-04, KV-19)`; label `needs-founder`.

---

### KV-20 · HA #45 record → `on-device-tts.md` §10 + verdict — opus — XS

**Executor:** opus — diagnosing from a field record; failure codes need judgement.

**Context:** `HUMAN-ACTIONS.md` #45 :102-148 (a `voiceProbe` line per phone); `player/kokoro-probe.js` `GO_RTF_NEWEST = 0.8` :58, `GO_RTF_OLDEST = 1.5` :59, `SYNTH_REASONS` :137, `probeVerdict(record, age)` :240-251 (`locked-screen-not-proven` :249), `summarizeProbe` :295-347 (`lockedScreenCompleted` :336), `formatProbeReport` :353; `docs/research/on-device-tts.md` §10 :828 (the empty table :854-858); `docs/bundled-voice-plan.md` K-01 (go/no-go text) and K-08 (CPU-only finding).

**Exact change:** paste each record into the table (device, OS, provider `cpu (accelerator not wired)`, load cold/warm, RTF cold/warm with `audioFrom`, peak MB, locked screen y/n, battery if present); run `probeVerdict` for `newest`/`oldest` and write the verdict sentence under the table; if a record is `could not measure: synthesis-failed/<code>`, name the code and open the matching fix issue instead of a verdict; if `locked=n`, write "locked-screen clause untested — re-run required" and do not mark go. Move #45 to `HUMAN-ACTIONS-DONE.md` only when a go/no-go is written. Update the deck's K-01 status line and `STATE.md`.

**Tests:** none; quote the `node -e` output in the PR.

**Commands:** `node -e "import('./player/kokoro-probe.js').then(m=>console.log(m.probeVerdict({rtfWarm:<x>,peakMemoryMb:<y>,lockedScreenCompleted:<bool>},'newest')))"`.

**Do not touch:** `docs/DECISIONS.md` (KV-24), native code.

**Stop and escalate if:** RTF passes on the newest phone but fails on the oldest — founder question 5.

**Definition of done:** §10 filled; DRAFT PR `docs(voice): K-01 phone measurements and verdict (HA #45, KV-20)`.

---

### KV-21 · K-08: CoreML EP on iOS, NNAPI measured on Android — opus — M

**Executor:** opus — `mobile/plugins/foray-tts/Package.swift` / `mobile/plugins/foray-tts/android/build.gradle` are DENIED patterns; binary-dependency change and device measurement.

**Context:** `docs/bundled-voice-plan.md` K-08; `KokoroOrtProbeEngine.swift` `makeSession` :154-170 (no EP appended), `acceleratorWired`; `KokoroOrtProbeEngine.java` `makeSession` :192-, `acceleratorWired` :219; `mobile/plugins/foray-tts/Package.swift` :53 (`onnxruntime-swift-package-manager`), :62 (product `onnxruntime`); `mobile/plugins/foray-tts/android/build.gradle:79` (`onnxruntime-android:1.20.0`); KV-20's CPU baseline (required first); `player/kokoro-probe.test.js` (floor 41 at `suite-integrity:275`).

**Exact change:** iOS: determine whether the pinned SPM product carries the CoreML EP (`ORTSessionOptions.appendCoreMLExecutionProvider`); if it needs the full `onnxruntime-objc` pod/xcframework, that is the dependency change — one DENIED-pattern edit requested with `founder-approved`; append CoreML with `ORTCoreMLExecutionProviderOptions` (`useCPUOnly false`, `enableOnSubgraphs true`), fall back to CPU on throw, report the provider ORT actually used, set `acceleratorWired = true` only when the append succeeded. Android: append NNAPI in a **probe-only** path (`engine: "kokoro-probe"` with `accelerator: true` in the call payload), measure, record; adopt only if RTF improves ≥ 20% with equal peak memory. Both rows land in §10 beside the CPU rows from the same build.

**Tests:** XCTest: with the EP unavailable, `acceleratorWired` stays false and `provider == "cpu"` (mutation: set true unconditionally → red). `player/kokoro-probe.test.js` (41 → 42): `summarizeProbe` passes through `provider: "coreml"` and `acceleratorWired: true`.

**Commands:** `node --test player/kokoro-probe.test.js`; `node --test test/release-gates.test.js`; `node --test test/suite-integrity.test.js`; CI `ios-kit`, `ios-shell`, `android-shell`; a founder or opus probe run on both phones.

**Do not touch:** the narration path (`speakPhonemes`) until the measurement is in; the espeak gate inputs.

**Stop and escalate if:** the CoreML build raises the per-ABI runtime size by > 10 MiB; ORT 1.20.0 has no CoreML EP in the SPM product (founder decides on the pod).

**Definition of done:** two §10 rows per phone (cpu / accelerated); DRAFT PR `feat(foray-tts): CoreML execution provider behind a measured fallback (K-08, KV-21)`; label `needs-founder`.

---

### KV-22 · NE-42: `PcmNarrator` seat in foray-audio — opus — M

**Executor:** opus — Swift; the audible-start invariant is a session-policy property.

**Context:** `docs/native-engine-plan.md` (grep `NE-42` and `NE-33`; §12 "Card conventions" :670; NE-24 row :775); `mobile/plugins/foray-audio/ios/Sources/ForayAudioPlugin/Engine/Seams.swift` — `protocol SessionControlling` :65-72, `enum SpeechEnd` :193-199, `protocol Speaking` :201-210 (`onFinish` :206, `speak(text:voiceId:)` :208, `stopSpeaking()` :209); `Engine/PreviewSpeaker.swift` (the conformer — copy its `onFinish` main-thread discipline); `Engine/EngineBoot.swift:45` (`speaker: PreviewSpeaker(...)` — stays); `ios/Tests/ForayAudioPluginTests/Engine/RecordingSeams.swift` (fake session/speaker); `ios/Tests/ForayAudioPluginTests/SpeechSessionSmokeTests.swift` (how a real-audio smoke is gated); `mobile/plugins/foray-audio/Package.swift` (DENIED pattern — read-only); `tools/mobile/shell-invariants.test.mjs` (floor 111). NE-33 has **not** landed; there is no `NarratorEvents` type.

**Exact change:** (1) `Engine/PcmSpeaking.swift`: `protocol PcmSpeaking: Speaking { func enqueue(_ buffer: AVAudioPCMBuffer); func endOfUtterance(); func pauseSpeaking(); func continueSpeaking() }`. (2) `Engine/PcmNarrator.swift`: `final class PcmNarrator: NSObject, PcmSpeaking` over `AVAudioEngine` + `AVAudioPlayerNode`; `speak(text:voiceId:)` is **refused** (`assertionFailure` in debug, `onFinish?(.cancelled)` in release); `enqueue` schedules with `.dataPlayedBack`; `endOfUtterance` arms `onFinish?(.finished)` after the last completion; `stopSpeaking` → `.cancelled` once; `pause/continue` map to the node; the engine starts only on the first `enqueue`, never at init; the narrator never touches `SessionControlling`. (3) Wired to nothing: `EngineBoot.swift:45` keeps `PreviewSpeaker`. (4) NP-11 read APIs only if NE-24's snapshot type exists on main; otherwise a `// NE-42 read APIs: pending NE-24` marker.

**Tests (`ios/Tests/ForayAudioPluginTests/Engine/PcmNarratorTests.swift`):** "a generated 0.5 s sine in two buffers yields exactly one .finished" (mutation: fire per buffer → red); "stopSpeaking mid-buffer yields .cancelled and never .finished"; "speak(text:) is refused and does not start the engine"; "no SessionControlling call is made". `tools/mobile/shell-invariants.test.mjs` (111 → 112): grep pin — `PcmNarrator.swift` exists and `EngineBoot.swift` does not reference `PcmNarrator` (mutation: wire it → red).

**Commands:** `node --test tools/mobile/shell-invariants.test.mjs`; `node --test test/suite-integrity.test.js`; CI `ios-kit` (`-scheme ForayAudio`, `ci.yml:230`).

**Do not touch:** `EngineCore`, `foray-engine-core/**`, `mobile/plugins/foray-audio/Package.swift`, CarPlay anything.

**Stop and escalate if:** `AVAudioEngine` tests cannot run on the CI simulator — gate the two playback tests behind the same skip `SpeechSessionSmokeTests` uses and keep the refusal/session-invariant tests unconditional.

**Definition of done:** CI green; DRAFT PR `feat(foray-audio): PcmNarrator seat for the bundled voice, wired to nothing (NE-42, KV-22)`; opens with the `hold` label if §12 (:670) still requires it.

---

### KV-23 · Records: deck markers, §4.7a flip, plugin README API section, STATE, privacy policy — qwen — S

**Executor:** qwen. Docs under allowed paths; every sentence cites a merged PR number.

**Context:** `docs/bundled-voice-plan.md` §9 :262 (K-02 :334 "STILL PARTIAL", K-04, K-05) and §10 :510; `docs/curation/generation-architecture.md` §4.7a :532 (the "NOT WIRED" banner); `mobile/plugins/foray-tts/README.md` §"The API" :205, §"Android has no pause" :228, §"K-01" :281; `docs/legal/privacy-policy.md:144` (`cp_voice` — "an identifier the device's own voice list reported"); `STATE.md` (entry format :8-14: `## Active workstreams` / `### <date> — <branch>: <title>` / `Owned: ...`); `HUMAN-ACTIONS.md` #40 :169 (still open; K-07's soft spot); `docs/DECISIONS.md` (read-only: does an entry answer founder Q1?).

**Exact change:** after KV-02 merges: replace §4.7a's banner with one paragraph "wired <date> (#PR); runs between `stitch:<n>` and `finalize`; phonemizer host: <the DECISIONS answer to Q1>" — **if `docs/DECISIONS.md` has no entry answering Q1, write exactly "phonemizer host: pending (founder Q1, KV-24)" and do not name a host**; mark K-02 DONE with the PR and the count from the first real `--write` run (or "data re-author pending host install"). After KV-13/KV-16: README §"The API" gains `speakPhonemes` (payload, resolve shape, reject codes), `kokoroState` (shape), `finished{utteranceId, engine}`; §"Android has no pause" gains one sentence that the kokoro path pauses for real; K-04/K-05 markers. Privacy row :144: "`cp_voice` — your chosen narration voice: a bundled 4a voice id, or an identifier the device's own voice list reported". **If a test under `test/` pins the old `cp_voice` sentence (none does at `ecb6bfa3` — `git grep "device's own voice list" origin/main -- test/ tools/` is empty — but re-check), update only that expected string, never the test's structure, and name it in the PR.** Add a `STATE.md` entry for the fleet with owned paths. Do **not** close #40; add a line under K-07's soft spot pointing at KV-19.

**Tests:** `node --test "test/*.test.js"` (copy/legal invariants over docs).

**Commands:** `node --test "test/*.test.js"`.

**Do not touch:** `docs/DECISIONS.md`, `docs/adr/`, `CLAUDE.md`.

**Stop and escalate if:** a marker you are asked to flip has no merged PR to cite; a legal-citation test fails for a reason other than the one expected string.

**Definition of done:** DRAFT PR `docs(voice): records for the K-deck after the stage and engine landed (K-07, KV-23)`.

---

### KV-24 · DECISIONS entries — opus — XS

**Executor:** opus — `docs/DECISIONS.md` is DENIED.

**Context:** `docs/DECISIONS.md` top-of-file format (:1-16; newest entry 2026-09-25 :5), the 2026-09-24 narration-1x entry :118, the 2026-09-12 bundled-voice entry (grep `^## 2026-09-12`); KV-19's chosen voices and default; KV-20's verdict; KV-02's wiring.

**Exact change:** one entry per ruling, founder words verbatim where they exist: (1) "the phonemize stage runs in the pipeline; phonemizer host = <Q1 answer>"; (2) "the three bundled voices are <ids>, default <id> (audition 2026-xx, rankings by <founders>)"; (3) "K-01 go/no-go: <verdict>, minimum device <if any>". Each names the PRs. Separate PR (G-7 discipline).

**Commands:** `git diff --stat` shows only `docs/DECISIONS.md`.

**Definition of done:** DRAFT PR `docs(decisions): bundled voice — stage wired, voices chosen, K-01 verdict (KV-24)`; label `needs-founder`.

## 4. Sequencing

```
Wave 1 (parallel, disjoint files):
  qwen: KV-01 (tools/narration)   KV-03 (check-forays.test)   KV-04 (gen + player/kokoro-vocab.js + KokoroVocab.swift/.java + generated block in foray-tts.js + foray-tts-native.test.mjs seed)
        KV-07 (foray-queue)       KV-17 (audition-page)
  opus: KV-02 (runPipeline; after KV-01 merges so the stdin fix is real)   KV-18 (render + HA #119; after KV-17)   KV-22 (foray-audio PcmNarrator)
  founder: run HA #45 on the next build  ->  KV-20 (opus, XS) as soon as the record arrives
Wave 2 (after KV-04):
  qwen: KV-05 (phoneme-chunks)    KV-06 (foray-tts.js + tts-bridge.js + unported.json tts-bridge lines + foray-tts.test.mjs)
  opus: KV-11 (iOS engine PCM; iOS block of foray-tts-native.test.mjs)    KV-14 (Android engine PCM; Android block of the same suite)
Wave 3:
  qwen: KV-08 (queue-manager + unported.json queue-manager lines; after KV-05, KV-06, KV-07)  ->  KV-09 (client.js + app.js + voice-settings.test)  ->  KV-10 (app.js + voice-settings.test)
  opus: KV-12 -> KV-13 (iOS narrator, plugin methods + table)     KV-15 -> KV-16 (Android)     [KV-12/KV-15 also wait on KV-20's go]
Wave 4:
  opus: KV-19 (bundle 3 voices; after H2 rankings + KV-13/KV-16)   KV-21 (K-08; only if KV-20 says the CPU margin is thin)
  qwen: KV-23 (records + README API section; after KV-02, KV-13, KV-16)
  opus: KV-24 (DECISIONS; last)
```

File-disjointness within a wave: KV-01 (`tools/narration/*`), KV-03 (`tools/foray/check-forays.test.mjs`), KV-04 (`tools/mobile/gen-kokoro-vocab.mjs`, `player/kokoro-vocab.js`, two native constant files, the generated block in `foray-tts.js`, `tools/mobile/kokoro-vocab.test.mjs`, `tools/mobile/foray-tts-native.test.mjs`), KV-07 (`player/foray-queue.js` + test), KV-17 (`tools/narration/audition-page*`) — the only shared file is `test/suite-integrity.test.js` (floors), which every PR edits on its own line. Wave 2: KV-05 (`player/phoneme-chunks*`) and KV-06 (`foray-tts.js` outside the generated block, `tts-bridge.js`, `tools/mobile/foray-tts.test.mjs`, `tts-bridge.test.js`, `unported.json` tts-bridge section) share nothing; KV-11 and KV-14 touch different languages/directories and different `describe` blocks of `foray-tts-native.test.mjs`, colliding only on that suite's floor line. Wave 3: KV-08 → KV-09 → KV-10 are strictly serial (`queue-manager.js`, then `client.js`/`app.js`, then `app.js`); KV-08 and KV-06 both edit `unported.json` but in different sections and different waves. Native iOS (KV-11..13) and Android (KV-14..16) chains run in parallel; `tools/mobile/foray-tts.test.mjs` is edited by KV-06 alone; `mobile/plugins/foray-tts/README.md` is edited by KV-23 alone.
