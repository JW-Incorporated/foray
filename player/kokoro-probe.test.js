/* K-01's instrument, tested for the one property that makes an instrument
 * worth having: it never reports a number it did not measure.
 *
 * `docs/bundled-voice-plan.md` K-01. The card's acceptance gate is a founder's
 * phone, which nothing here can be. What CAN be settled in Node is everything
 * around the measurement — the arithmetic, the refusal vocabulary, the go/no-go
 * rule written before the run, and the guarantee that a probe with no model
 * present is inert rather than optimistic.
 *
 * EVERY TEST NAMES ITS MUTATION. The class of bug this suite exists to catch is
 * a probe that answers "RTF 0.00, 0 MB, locked screen fine" because nothing
 * ran — a record that gets pasted into a decision. Most of the mutations below
 * are exactly that: a guard replaced by a default that looks like a pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROBE_ENGINE, PROBE_REASONS, SYNTH_REASONS, CHARS_PER_SEC, RTF_FLOOR,
  GO_RTF_NEWEST, GO_RTF_OLDEST, GO_PEAK_MEMORY_MB,
  passageSeconds, passageProblem, realTimeFactor, rtfIsPlausible, toMegabytes,
  probeVerdict, summarizeProbe, formatProbeReport, runKokoroProbe,
  ORT_CODES, ORT_STAGES, LINE_OUTCOMES, KOKORO_MODEL_PINS, nameOf,
  PROBE_PASSES, KILLED_STAGES, PROVIDER_BASES, summarizePasses, finiteOf,
  V3_PASSES, BACKGROUND_SAFE_PASSES, COREML_PASSES, PROBE_SPEEDS, TARGET_CONTENT_RTF, BREAK_EVEN_CONTENT_RTF,
  COREML_DECISION_RTF, CML_CODES, CML_STAGES, KEEP_ALIVE_STATES, SCREEN_STATES, SPEED_VERDICTS,
  screenOf, speedVerdict, passVerdicts, formatProbeTable, wavPasses, playProbeWav, summarizeSoak, formatSoakReport,
  stopProbeSoak,
} from "./kokoro-probe.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PASSAGE = JSON.parse(
  fs.readFileSync(path.join(REPO, "tools/mobile/kokoro-probe-passage.json"), "utf8"));

/** The passage as it will be once `phonemize.py` has filled it in. Built from
    the real file rather than invented, so a line added to the passage is
    exercised here the day it lands. */
const phonemized = () => ({
  ...PASSAGE,
  lines: PASSAGE.lines.map((l, i) => ({ ...l, ids: [1, 2, 3, i + 4] })),
});

/* ---------- the passage ---------- */

test("the shipped passage is four lines, ~90 seconds, and carries six lexicon terms", () => {
  /* §6's passage: the disclosure, two narration beats, and the pronunciation
     fixture. MUTATION: drop a line from the JSON — the count and the duration
     both go red, and they fail for different reasons on purpose. */
  assert.equal(PASSAGE.lines.length, 4);
  const sec = passageSeconds(PASSAGE);
  assert.ok(sec > 60 && sec < 110, `passage is ${sec.toFixed(1)} s, expected roughly 90`);
  assert.equal(PASSAGE.lexicon_terms.length, 6);
  const fixture = PASSAGE.lines.find((l) => l.kind === "fixture");
  for (const term of PASSAGE.lexicon_terms) {
    assert.ok(fixture.text.includes(term), `the fixture line must actually say "${term}"`);
  }
});

test("every lexicon term in the passage is a term the lexicon knows", () => {
  /* A fixture testing six words the plugin has never heard of would measure
     nothing about pronunciation control. MUTATION: change one term in the
     passage to a word that is not in `hard-terms.json`. */
  const lex = JSON.parse(fs.readFileSync(
    path.join(REPO, "mobile/plugins/foray-tts/lexicon/hard-terms.json"), "utf8"));
  const known = new Set(lex.entries.map((e) => e.term.toLowerCase()));
  for (const term of PASSAGE.lexicon_terms) {
    assert.ok(known.has(term.toLowerCase()), `"${term}" is not in hard-terms.json`);
  }
});

test("the passage's char counts and est_sec agree with the 17 chars/s planning rate", () => {
  /* `est_sec` is the RTF denominator until an engine reports real rendered
     length, so a wrong one silently scales every RTF in the record.
     MUTATION: change one `est_sec` by 10% — this goes red. */
  for (const l of PASSAGE.lines) {
    assert.equal(l.chars, l.text.length, `${l.id}: chars must be the real length`);
    assert.ok(Math.abs(l.est_sec - l.chars / CHARS_PER_SEC) < 0.05,
      `${l.id}: est_sec ${l.est_sec} is not chars/${CHARS_PER_SEC}`);
  }
});

test("the shipped passage IS phonemized, so the probe can reach the phone's engine", () => {
  /* THIS TEST WAS INVERTED ON 2026-09-12, and the inversion is the point of
     the PR that did it. It used to assert `passage-unphonemized`, which was
     the honest state while `ids` was null — and it is exactly the string
     Wyatt's phone printed on build 2026091212 instead of a number:

         voiceProbe kokoro-probe could not measure: passage-unphonemized

     `tools/narration/phonemize.py --passage ... --in-place` filled it. The
     ids' correctness is not asserted here but in
     `tools/mobile/kokoro-vocab.test.mjs`, which decodes every one of them back
     through the model's own table — because "there is an array here" and "the
     array says what the text says" are different claims and only the second
     one is worth anything.
     MUTATION: null one chunk's `ids` — the passage refuses again and the probe
     goes back to answering `passage-unphonemized`.

     KV-R2: the ids live on each line's SENTENCE CHUNKS now (one inference per
     chunk), and the line-level `ids` is gone. */
  assert.equal(passageProblem(PASSAGE), null);
  for (const l of PASSAGE.lines) {
    assert.ok(Array.isArray(l.chunks) && l.chunks.length > 0, `${l.id}: no chunks`);
    for (const c of l.chunks) assert.ok(Array.isArray(c.ids) && c.ids.length > 0, `${l.id}: a chunk with no ids`);
    assert.ok(!("ids" in l), `${l.id}: a whole-line ids array is the inference nothing should run`);
    assert.ok(typeof l.phonemes === "string" && l.phonemes.length > 0, `${l.id}: no phonemes`);
  }
  assert.match(PASSAGE.vocab, /^sha256:[0-9a-f]{16}$/,
    "the passage must carry the id table's sha, so the player can refuse a mismatch");
});

test("passageProblem separates missing, empty and unphonemized", () => {
  /* Three different actions for a founder: "the fetch 404ed", "the file is
     broken", "the pipeline has not run yet". MUTATION: collapse any two into
     one string — a reader is then told to fix the wrong artefact. */
  assert.equal(passageProblem(null), "passage-missing");
  assert.equal(passageProblem("not an object"), "passage-missing");
  assert.equal(passageProblem({ lines: [] }), "passage-empty");
  assert.equal(passageProblem({}), "passage-empty");
  assert.equal(passageProblem({ lines: [{ ids: [] }] }), "passage-unphonemized");
  assert.equal(passageProblem(phonemized()), null);
  /* KV-R2: chunks count, and one chunk with no ids is the whole line refused.
     MUTATION: accept a line whose chunks are present but empty of ids. */
  assert.equal(passageProblem({ lines: [{ chunks: [{ ids: [0, 1, 0] }, { ids: [0, 2, 0] }] }] }), null);
  assert.equal(passageProblem({ lines: [{ chunks: [{ ids: [0, 1, 0] }, { ids: [] }] }] }), "passage-unphonemized");
  assert.equal(passageProblem({ lines: [{ chunks: [] }] }), "passage-unphonemized");
});

test("passageSeconds falls back to chars/17 for a line with no est_sec", () => {
  /* MUTATION: return 0 when `est_sec` is absent — every RTF computed from a
     hand-edited passage becomes null, and the probe silently reports nothing. */
  assert.equal(passageSeconds({ lines: [{ chars: 170 }] }), 10);
  assert.equal(passageSeconds({ lines: [{ text: "x".repeat(34) }] }), 2);
  assert.equal(passageSeconds(null), 0);
});

/* ---------- the arithmetic ---------- */

test("realTimeFactor is synthesis wall time over audio produced", () => {
  assert.equal(realTimeFactor(5000, 10), 0.5);
  assert.equal(realTimeFactor(15000, 10), 1.5);
});

test("realTimeFactor answers null — never 0, never Infinity — for a missing reading", () => {
  /* THE CENTRAL MUTATION OF THIS FILE. `synthMs / audioSec` with no guard
     gives `Infinity` for a zero-length passage and `0` for a synthesis that
     never happened; both format as numbers and both read as findings.
     MUTATION: drop either guard and return the bare division. */
  assert.equal(realTimeFactor(5000, 0), null, "no audio measured is not RTF 0");
  assert.equal(realTimeFactor(null, 10), null);
  assert.equal(realTimeFactor(undefined, 10), null);
  assert.equal(realTimeFactor(NaN, 10), null);
  assert.equal(realTimeFactor(5000, null), null);
  assert.equal(realTimeFactor(-1, 10), null);
});

test("toMegabytes is 1024-based and null for an absent reading", () => {
  /* MUTATION: divide by 1e6 — a 400 MB ceiling then passes a phone at 419
     MiB, which is the wrong side of K-01's memory gate. */
  assert.equal(toMegabytes(1024 * 1024), 1);
  assert.equal(toMegabytes(400 * 1024 * 1024), 400);
  assert.equal(toMegabytes(null), null);
  assert.equal(toMegabytes(NaN), null);
});

/* ---------- the go/no-go rule ---------- */

test("K-01's go rule is the card's numbers, not a recomputed one", () => {
  /* Written before the run, by the card, so the numbers cannot be read
     generously afterwards. MUTATION: change any of the three. */
  assert.equal(GO_RTF_NEWEST, 0.8);
  assert.equal(GO_RTF_OLDEST, 1.5);
  assert.equal(GO_PEAK_MEMORY_MB, 400);
});

test("a passing record is a go on both device ages", () => {
  const rec = { rtfWarm: 0.55, peakMemoryMb: 310, lockedScreenCompleted: true };
  assert.equal(probeVerdict(rec, "newest").go, true);
  assert.equal(probeVerdict(rec, "oldest").go, true);
});

test("the RTF ceiling depends on which phone this is", () => {
  /* 1.1 is a pass on the oldest phone tried and a fail on the newest — the
     card says so explicitly. MUTATION: use one ceiling for both; one of the
     two assertions goes red. */
  const rec = { rtfWarm: 1.1, peakMemoryMb: 200, lockedScreenCompleted: true };
  assert.equal(probeVerdict(rec, "newest").go, false);
  assert.equal(probeVerdict(rec, "oldest").go, true);
  assert.equal(probeVerdict(rec, "newest").ceiling, 0.8);
});

test("an unknown device age takes the LOOSER ceiling", () => {
  /* Guessing "this is a new phone" and failing it on 0.8 would be the
     instrument inventing a no-go. MUTATION: default to `newest`. */
  const rec = { rtfWarm: 1.1, peakMemoryMb: 200, lockedScreenCompleted: true };
  assert.equal(probeVerdict(rec).go, true);
  assert.equal(probeVerdict(rec, "banana").ceiling, GO_RTF_OLDEST);
});

test("an UNMEASURED reading fails the gate — it never reads as a pass", () => {
  /* THE DIRECTION THAT MATTERS. "We could not measure it" and "it met the bar"
     are the two answers most likely to be confused, and only one of them lets
     K-04 start.
     MUTATION: treat a null `rtfWarm` / `peakMemoryMb` as satisfied. */
  const v = probeVerdict({ lockedScreenCompleted: true });
  assert.equal(v.go, false);
  assert.deepEqual(v.failures, ["rtf-not-measured", "peak-memory-not-measured"]);
});

test("a locked-screen run that did not complete is a no-go on its own", () => {
  /* Narration must synthesize with the screen locked; a phone that is fast and
     frugal and stops when pocketed has failed the thing the card is about.
     MUTATION: drop the `lockedScreenCompleted !== true` clause. */
  const rec = { rtfWarm: 0.2, peakMemoryMb: 100, lockedScreenCompleted: false };
  const v = probeVerdict(rec, "newest");
  assert.equal(v.go, false);
  assert.deepEqual(v.failures, ["locked-screen-not-proven"]);
});

test("the memory ceiling fails at 401 MB and passes at 400", () => {
  /* MUTATION: use `>=` — a phone exactly at the documented ceiling fails for
     no reason the card gives. */
  const at = { rtfWarm: 0.2, peakMemoryMb: 400, lockedScreenCompleted: true };
  assert.equal(probeVerdict(at, "newest").go, true);
  assert.equal(probeVerdict({ ...at, peakMemoryMb: 401 }, "newest").go, false);
});

/* ---------- the record ---------- */

test("summarizeProbe flattens the native payload to named fields only", () => {
  /* The ring re-serialises itself on every write (diagnostic-log.js's cost
     note), so a nested native blob would be re-written 200 times.
     MUTATION: spread `native` into the record — `secretHugeField` appears. */
  const rec = summarizeProbe({
    native: { synthWarmMs: 3000, modelLoadColdMs: 1800, peakMemoryBytes: 300 * 1024 * 1024,
      provider: "coreml", model: "1.0", lockedScreenCompleted: true, secretHugeField: "x".repeat(1000) },
    elapsedMs: 4000, audioSec: 6,
  });
  assert.equal(rec.secretHugeField, undefined);
  assert.equal(rec.rtfWarm, 0.5);
  assert.equal(rec.peakMemoryMb, 300);
  assert.equal(rec.provider, "coreml");
  assert.equal(rec.ok, true);
  assert.equal(rec.engine, PROBE_ENGINE);
});

test("a record built from a refusal is not ok and carries the reason", () => {
  const rec = summarizeProbe({ reason: "model-absent", audioSec: 90 });
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, "model-absent");
  /* MUTATION: default the numeric fields to 0 instead of null — the refusal
     then formats as "RTF 0.00", which is the exact lie this file is about. */
  assert.equal(rec.rtfWarm, null);
  assert.equal(rec.peakMemoryMb, null);
  assert.equal(rec.lockedScreenCompleted, false);
});

test("formatProbeReport prints the refusal ALONE, not seven dashes", () => {
  /* MUTATION: format a refusal with the full seven-line table — the one thing
     a reader needs (why) is then buried under six em-dashes. */
  const text = formatProbeReport(summarizeProbe({ reason: "engine-absent" }));
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /could not measure \(engine-absent\)/);
});

test("formatProbeReport names every field K-01 asks for", () => {
  const text = formatProbeReport(summarizeProbe({
    native: { synthWarmMs: 3000, synthColdMs: 5000, modelLoadColdMs: 1800, modelLoadWarmMs: 120,
      peakMemoryBytes: 300 * 1024 * 1024, availableMemoryBytes: 900 * 1024 * 1024,
      provider: "cpu", model: "1.0", lockedScreenCompleted: true, batteryDeltaPct: -3, batteryWindowSec: 600 },
    audioSec: 6,
  }));
  /* The card's list: model load (cold and warm), RTF, peak memory, locked
     screen, battery. MUTATION: drop any line from the formatter. */
  for (const want of [/model load/, /synthesis/, /RTF/, /peak memory/, /locked screen/, /battery/]) {
    assert.match(text, want);
  }
  assert.match(text, /locked screen completed the passage/);
});

/* ==================================================================== */
/* #685: the probe returned a zero and the gate read it as a triumph     */
/* ==================================================================== */

/** The founder's first real reading, build 2026091316, as the native half
    actually shaped it — note what is NOT in it: no `audioColdSec`, no
    `audioWarmSec`, no `detail`. That absence is the bug. */
const READING_685 = Object.freeze({
  ok: true, provider: "cpu", model: "kokoro-82m-v1.0-q8f16",
  modelLoadColdMs: 467, modelLoadWarmMs: 388,
  synthColdMs: 0, synthWarmMs: 0,
  peakMemoryBytes: 290.9 * 1024 * 1024, lockedScreenCompleted: false, lines: 4,
});

test("#685's exact reading is a NO-GO, on both device ages", () => {
  /* THE REGRESSION THIS WHOLE CHANGE EXISTS FOR. Replayed verbatim, the line
     the founder pasted — `rtf cold 0.00 warm 0.00 ... peak 290.9MB` — used to
     clear every ceiling in the card by two orders of magnitude and would have
     been read as a spectacular pass on a build where synthesis never produced
     a sample.
     MUTATION: delete the `rtf-below-floor` branch in `probeVerdict`. The only
     remaining failure is `locked-screen-not-proven`, and a founder who locks
     his phone next time gets a `go` out of a probe that rendered no audio. */
  const rec = summarizeProbe({ native: READING_685, audioSec: passageSeconds(PASSAGE) });
  assert.equal(rec.rtfWarm, 0, "the record still carries the zero it was given");
  for (const age of ["newest", "oldest"]) {
    const v = probeVerdict(rec, age);
    assert.equal(v.go, false);
    assert.ok(v.failures.some((f) => f.startsWith("rtf-below-floor")),
      `the floor must fire on ${age}: ${v.failures.join(", ")}`);
  }
});

test("the floor can never fail a reading an engine could actually produce", () => {
  /* A floor set carelessly would be worse than no floor: it would reject the
     one measurement this card is waiting for. 0.01 is two orders of magnitude
     below the TIGHTEST ceiling, so there is no RTF this instrument both
     believes and rejects.
     MUTATION: raise RTF_FLOOR to anything at or above 0.8 — the passing record
     below stops being a go, and the assertion on the gap goes red first. */
  assert.ok(RTF_FLOOR * 50 < GO_RTF_NEWEST, "the floor must sit far below the tightest ceiling");
  assert.equal(rtfIsPlausible(RTF_FLOOR), true, "the floor itself is plausible; below it is not");
  assert.equal(rtfIsPlausible(RTF_FLOOR - 0.001), false);
  assert.equal(rtfIsPlausible(null), false, "absent was never plausible either");
  const good = summarizeProbe({
    native: { ...READING_685, synthColdMs: 60_000, synthWarmMs: 30_000,
      audioColdSec: 15, audioWarmSec: 62.4, lockedScreenCompleted: true },
    audioSec: passageSeconds(PASSAGE),
  });
  assert.equal(probeVerdict(good, "newest").go, true);
});

test("rendered seconds of zero make the RTF unmeasured, not zero", () => {
  /* THE CAUSE, not the symptom. Both native halves promised — in their own
     comments — that a `(0 ms, 0 s)` failure would reach the page as an
     unmeasured RTF. It did not, because the rendered seconds were computed on
     the device and never put on the wire, so this module divided by the
     passage's PLANNING ESTIMATE, which is positive whatever the engine did.
     MUTATION: make `summarizeProbe` fall back to the estimate when the native
     side reports `audioColdSec: 0` — `rtfWarm` becomes 0 again and this is
     red. */
  const rec = summarizeProbe({
    native: { ...READING_685, audioColdSec: 0, audioWarmSec: 0, synthFailures: 4, detail: "session-absent" },
    audioSec: passageSeconds(PASSAGE),
  });
  assert.equal(rec.rtfCold, null);
  assert.equal(rec.rtfWarm, null);
  assert.equal(rec.audioSec, 0, "the line says 0 s of audio, not 77.4");
  assert.equal(rec.audioFrom, "rendered");
  assert.equal(rec.passageSec, passageSeconds(PASSAGE), "the estimate is kept, just not used as the divisor");
  assert.equal(rec.synthReason, "session-absent");
  assert.ok(probeVerdict(rec, "oldest").failures.includes("rtf-not-measured"));
});

test("RTF is a ratio of two numbers measured over the SAME audio", () => {
  /* `synthWarmMs` is the sum over lines 2..N; it used to be divided by the
     whole passage including line 1, understating warm RTF by the cold line's
     share of the audio — about a quarter on the shipped four-line passage. A
     go rule stated on the warm figure alone cannot be fed a warm figure that
     is 25% optimistic.
     MUTATION: divide both by `audioColdSec + audioWarmSec` — `rtfWarm` lands
     at 0.4808 instead of 0.6 and this is red. */
  const rec = summarizeProbe({
    native: { ...READING_685, synthColdMs: 12_000, synthWarmMs: 36_000,
      audioColdSec: 15, audioWarmSec: 60 },
    audioSec: passageSeconds(PASSAGE),
  });
  assert.ok(Math.abs(rec.rtfCold - 0.8) < 1e-9, `cold: ${rec.rtfCold}`);
  assert.ok(Math.abs(rec.rtfWarm - 0.6) < 1e-9, `warm: ${rec.rtfWarm}`);
  assert.equal(rec.audioSec, 75);
});

test("a shell built before this fix still gets a record — and still fails the gate", () => {
  /* The founder's phone is carrying the OLD plugin until he installs a new
     build, and an instrument that answered nothing at all for it would be a
     second wasted trip. With no rendered seconds reported, the estimate is
     still the divisor and `audioFrom` says so — and the floor is what catches
     the zero on that path.
     MUTATION: make the rendered seconds mandatory (`audioColdSec ?? 0` with no
     `rendered` check) — `audioSec` becomes 0 for every old build and the
     record loses the one number it did have. */
  const rec = summarizeProbe({ native: READING_685, audioSec: passageSeconds(PASSAGE) });
  assert.equal(rec.audioFrom, "estimated");
  assert.equal(rec.audioSec, passageSeconds(PASSAGE));
  assert.equal(rec.rtfWarm, 0, "an old build still reports the zero — the floor is what rejects it");
  assert.equal(probeVerdict(rec, "newest").go, false);
});

test("`synthesis-failed` is a refusal that keeps the numbers it did produce", () => {
  /* The native halves now refuse outright when not one line rendered, rather
     than resolving `ok: true` with zeroes. But the model DID load on that
     path, so the load and memory figures are real — and they are the numbers
     PR #675 fought for. A refusal that threw them away would make the next
     failed probe less informative than #685's was.
     MUTATION: return early from `summarizeProbe` on a refusal without reading
     `native` — `modelLoadColdMs` goes null and this is red. */
  const rec = summarizeProbe({
    native: { ...READING_685, ok: false, reason: "synthesis-failed",
      detail: "inference-threw", synthFailures: 4, audioColdSec: 0, audioWarmSec: 0 },
    reason: "synthesis-failed",
    audioSec: passageSeconds(PASSAGE),
  });
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, "synthesis-failed");
  assert.equal(rec.synthReason, "inference-threw");
  assert.equal(rec.modelLoadColdMs, 467);
  assert.equal(rec.peakMemoryMb, 290.9);
  assert.ok(PROBE_REASONS.includes("synthesis-failed"), "the page must know the code the phone sends");
  assert.match(formatProbeReport(rec), /could not measure \(synthesis-failed\/inference-threw\)/);
});

test("the report SAYS a below-floor RTF is not a measurement, in words", () => {
  /* The drawer text is what a founder reads before he decides whether the run
     was worth anything. `RTF cold 0.00 warm 0.00` with no comment on it reads
     as a triumph; that is exactly how #685 got filed as a pass.
     MUTATION: drop the floor clause from `formatProbeReport`. */
  const text = formatProbeReport(summarizeProbe({ native: READING_685, audioSec: passageSeconds(PASSAGE) }));
  assert.match(text, /BELOW THE 0\.01 FLOOR/);
  assert.match(text, /of estimated audio/, "and it says the seconds were never rendered");
  assert.match(text, /CPU only — no accelerator wired/);
});

/* ---------- the three copies of one contract ---------- */

/* KV-R3 moved the pass loop, the matrix and the soak into
   KokoroProbeMatrix.swift, so "the iOS plugin" is both files, in that order
   (the probe section of the first runs on into the second). */
const IOS_PLUGIN = fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"), "utf8")
  + "\n" + fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroProbeMatrix.swift"), "utf8");
const IOS_COREML = fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroCoreMLEngine.swift"), "utf8");
const IOS_ENGINE = fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroOrtProbeEngine.swift"), "utf8");
const AND_PLUGIN = fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/ForayTtsPlugin.java"), "utf8");
const AND_ENGINE = fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/android/src/main/java/ai/jwlabs/foura/tts/KokoroOrtProbeEngine.java"), "utf8");

test("both native halves put the RENDERED audio seconds on the wire", () => {
  /* #685's root cause, asserted against source because nothing in Node can run
     either half. iOS summed the rendered seconds into a local it never wrote
     into `result`; Android never read `out[1]` at all. The engines measured
     the audio and the plugins dropped it, which is what left the page dividing
     by a planning estimate.
     MUTATION: delete either `audioColdSec` line from either plugin — this goes
     red, and the phone goes back to reporting 0.00 as a pass. */
  for (const [name, src] of [["ios", IOS_PLUGIN], ["android", AND_PLUGIN]]) {
    assert.match(src, /audioColdSec/, `${name} must report the cold line's rendered seconds`);
    assert.match(src, /audioWarmSec/, `${name} must report the warm lines' rendered seconds`);
    assert.match(src, /synthesis-failed/, `${name} must refuse when nothing rendered`);
  }
});

test("every synthesis failure the phones can name is one the page knows", () => {
  /* A closed vocabulary is only closed if both ends hold it. A code a native
     half invents and this module has never heard of arrives as an opaque
     string in a record somebody has to interpret over a phone call.
     MUTATION: write `"session-missing"` in either engine — this is red. */
  const quoted = (src) => (src.match(/"[a-z]+-[a-z]+"/g) ?? []).map((s) => s.slice(1, -1));
  /* `no-model` is an ORT error token (ORT_CODES), not a synthesis reason; it
     shares the `no-` prefix and is pinned by its own test below. */
  const suspects = new Set([...quoted(IOS_ENGINE), ...quoted(AND_ENGINE)]
    .filter((s) => /^(session|inference|no|zero|non)-/.test(s))
    .filter((s) => !ORT_CODES.includes(s)));
  assert.ok(suspects.size >= 5, `expected the five hyphenated synthesis codes, saw ${[...suspects]}`);
  for (const s of suspects) {
    assert.ok(SYNTH_REASONS.includes(s), `${s} is not in SYNTH_REASONS`);
  }
  /* L04: both engines can say the two new ones, and the page knows them.
     MUTATION: drop the finite/silence pass from either engine. */
  for (const [name, src] of [["ios", IOS_ENGINE], ["android", AND_ENGINE]]) {
    assert.match(src, /"non-finite"/, `${name} engine must be able to report non-finite output`);
    assert.match(src, /"silent"/, `${name} engine must be able to report silent output`);
  }
  assert.ok(SYNTH_REASONS.includes("non-finite") && SYNTH_REASONS.includes("silent"));
});

test("every ORT error token either phone can send is one the page knows (L03)", () => {
  /* The C API's OrtErrorCode 1..11 in order, then oom and other. Both engines
     spell the tokens out; a token only one side knows arrives as `null`.
     MUTATION: renumber the table in either engine, or add a token to one. */
  assert.deepEqual([...ORT_CODES], [
    "fail", "invalid-argument", "no-such-file", "no-model", "engine-error", "runtime-exception",
    "invalid-protobuf", "model-loaded", "not-implemented", "invalid-graph", "ep-fail", "oom", "other",
  ]);
  for (const [name, src] of [["ios", IOS_ENGINE], ["android", AND_ENGINE]]) {
    for (const code of ORT_CODES) {
      if (name === "ios" && code === "oom") continue; // no OutOfMemoryError to catch on iOS
      assert.ok(src.includes(`"${code}"`), `${name} engine never names "${code}"`);
    }
    for (const stage of ORT_STAGES) {
      assert.ok(src.includes(`"${stage}"`), `${name} engine never names stage "${stage}"`);
    }
  }
  /* iOS maps by the C API number; the 1..11 order IS the table. */
  const iosTable = IOS_ENGINE.match(/static let ORT_CODE_TOKENS[^[]*\[([^\]]+)\]/);
  assert.ok(iosTable, "the iOS engine keeps its code table as one array");
  const tokens = (iosTable[1].match(/"[a-z-]+"/g) ?? []).map((t) => t.slice(1, -1));
  assert.deepEqual(tokens, ORT_CODES.slice(0, 11), "index i is OrtErrorCode i+1");
});

test("both plugins put every Lane A key on the wire", () => {
  /* The keys `summarizeProbe` reads. Present in the source is the floor; the
     XCTest pins the iOS failure path end to end. MUTATION: drop any key. */
  const keys = ["ortCode", "ortOp", "ortStage", "loadErr", "lineOutcomes", "nonFiniteLines", "silentLines",
    "ortVersion", "intraThreads", "cores", "modelBytes", "modelSha8", "device", "os",
    "thermalStart", "thermalEnd", "lowPower", "memWarn", "bgAtFail", "baseMemoryBytes",
    "availableMemoryBytes", "lockedScreenCompleted", "batteryDeltaPct", "batteryWindowSec"];
  for (const [name, src] of [["ios", IOS_PLUGIN], ["android", AND_PLUGIN]]) {
    for (const k of keys) assert.ok(src.includes(`"${k}"`), `${name} plugin never sends ${k}`);
  }
  /* The DEFECT the brief names: phys_footprint and the native heap are
     CURRENT readings, not peaks. */
  assert.match(IOS_PLUGIN, /ledger_phys_footprint_peak/);
  assert.match(AND_PLUGIN, /getTotalPss\(\)/);
});

test("no plugin reads a device NAME, a vendor id or an error message into the result", () => {
  /* Rules 2 and 3 of the catalogue. MUTATION: record UIDevice.name, or put
     `localizedDescription` / `getMessage()` into a result key. */
  /* The probe's half of each plugin (the narration half is not this card's). */
  const iosProbe = IOS_PLUGIN.slice(IOS_PLUGIN.indexOf("// MARK: - K-01"));
  const andProbe = AND_PLUGIN.slice(AND_PLUGIN.indexOf("public void kokoroProbe(PluginCall call)"));
  assert.ok(iosProbe.length > 1000 && andProbe.length > 1000, "the probe sections are where this test looks");
  for (const [name, src] of [["ios", iosProbe + IOS_ENGINE], ["android", andProbe + AND_ENGINE]]) {
    assert.ok(!/UIDevice\.current\.name\b/.test(src), `${name}: UIDevice.name`);
    assert.ok(!/identifierForVendor|Build\.SERIAL|getSerial\(|ANDROID_ID/.test(src), `${name}: a device identifier`);
    assert.ok(!/result\[[^\]]+\]\s*=\s*[^\n]*(localizedDescription|getMessage\(\))/.test(src), `${name}: a message on the wire`);
    assert.ok(!/\.put\("[A-Za-z]+",[^\n]*getMessage\(\)/.test(src), `${name}: a message on the wire`);
  }
});

test("`acceleratorWired` tells the truth: the Core ML chain's ANE passes only, never ORT, nothing on Android", () => {
  /* #685's `kokoro-probe/cpu` was never a CoreML attempt that fell back: no
     execution provider was appended anywhere, and the record said so as a
     FACT (`acceleratorWired`) rather than leaving a reader to infer it from a
     provider string that reads like a fallback. KV-R2 wires the CoreML EP on
     iOS for the `coreml` pass ONLY; the flag must follow the append, not the
     pass name, and Android still appends nothing.
     MUTATION: hard-code `acceleratorWired` to `true` on iOS, or append NNAPI
     on Android without a flag — red. */
  const appends = /appendCoreML|appendNnapi|addNnapi|NNAPIExecutionProvider/;
  assert.ok(!appends.test(AND_ENGINE), "android: no accelerator is appended");
  assert.ok(!/acceleratorWired[^\n]*\n?[^\n]*\btrue\b/.test(AND_ENGINE), "android: the flag never claims one");
  /* KV-R3: the ORT CoreML-EP pass is gone (a dead end, doc §3 option 8), so
     iOS's ORT engine appends nothing and says so; the Core ML chain asks for
     the Neural Engine on `ane`/`ane-cputail` and not on `cml-cpu`.
     MUTATION: hard-code the Core ML engine's flag to `true`. */
  assert.ok(!appends.test(IOS_ENGINE), "ios ORT: no accelerator is appended");
  assert.match(IOS_ENGINE, /var acceleratorWired: Bool \{ false \}/, "ios ORT: the flag never claims one");
  assert.match(IOS_COREML, /var acceleratorWired: Bool \{ pass != \.cmlCpu \}/, "ios Core ML: ANE asked for on the ANE passes only");
  assert.match(IOS_COREML, /var providerBasis: String\? \{ pass == \.cmlCpu \? nil : "requested" \}/,
    "ios Core ML: ANE placement is requested, not confirmed");
  assert.equal(summarizeProbe({ native: READING_685, audioSec: 10 }).acceleratorWired, false);
});

test("the RTF floor is written once in kokoro-probe.js and mirrored nowhere else silently", () => {
  /* `diagnostic-log.js` imports NOTHING (its header's rule), so the floor it
     marks an impossible RTF with is a second copy of this module's constant.
     Drift would mean a line that prints a `!` at a threshold the gate does not
     use, or none at a threshold it does.
     MUTATION: change either number. */
  const diag = fs.readFileSync(path.join(REPO, "player/diagnostic-log.js"), "utf8");
  const m = diag.match(/const RTF_FLOOR = ([\d.]+);/);
  assert.ok(m, "diagnostic-log.js must name its floor");
  assert.equal(Number(m[1]), RTF_FLOOR);
});

/* ---------- the run ---------- */

const fakeTts = (answer) => ({ kokoroProbe: async () => answer });

test("the run refuses before touching the bridge when the passage is unphonemized", () => {
  /* ORDER IS THE CONTRACT. Asking a plugin to synthesize nulls would produce
     whatever that plugin does with nulls. MUTATION: check the passage after
     the call — `called` becomes true.

     Driven from a DELIBERATELY BROKEN copy of the shipped passage now that the
     real one is filled in: the rule being tested is "refuse before the bridge",
     and it has to keep being tested after the state that used to demonstrate
     it for free went away. */
  let called = false;
  const broken = { ...PASSAGE, lines: PASSAGE.lines.map((l) => ({ ...l, ids: null, chunks: null })) };
  const tts = { kokoroProbe: async () => { called = true; return { ok: true }; } };
  return runKokoroProbe({ tts, passage: broken }).then(([rec]) => {
    assert.equal(called, false);
    assert.equal(rec.reason, "passage-unphonemized");
  });
});

test("the shipped passage now reaches the bridge — the whole point of filling it in", () => {
  /* The other half of the inversion above, at the level the founder actually
     experiences: hand `runKokoroProbe` the REAL file and a bridge, and the
     bridge is called. On a phone the answer then comes from the native half
     (`model-absent`, `engine-absent`, or a measurement); in Node it comes from
     this fake. What matters is that the page no longer stops first.
     MUTATION: restore `ids: null` in the JSON — this goes red, and so does the
     founder's run. */
  let seen = null;
  const tts = { kokoroProbe: async (opts) => { seen = opts; return { ok: false, reason: "model-absent" }; } };
  return runKokoroProbe({ tts, passage: PASSAGE }).then(([rec]) => {
    assert.ok(seen, "the bridge was never asked");
    assert.equal(seen.passage.lines.length, 4);
    assert.equal(rec.reason, "model-absent", "the native half's own diagnosis wins");
  });
});

test("no bridge at all is `no-bridge`, not a crash and not a zero", async () => {
  const [rec] = await runKokoroProbe({ tts: null, passage: phonemized() });
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, "no-bridge");
  /* MUTATION: drop the `typeof tts.kokoroProbe === "function"` half — an older
     bridge object with no probe method throws a TypeError at a founder. */
  const [stale] = await runKokoroProbe({ tts: { speak: () => {} }, passage: phonemized() });
  assert.equal(stale.reason, "no-bridge");
});

test("a native refusal keeps the native's OWN code when it is one we know", async () => {
  /* `model-absent` (the build skipped the fetch) and `engine-absent` (no
     runtime compiled in) are different actions for a founder.
     MUTATION: always report `refused` — both diagnoses are lost. */
  for (const reason of ["model-absent", "engine-absent"]) {
    const [rec] = await runKokoroProbe({ tts: fakeTts({ ok: false, reason }), passage: phonemized() });
    assert.equal(rec.reason, reason);
  }
});

test("a native reason we do NOT know degrades to `refused`", async () => {
  /* The vocabulary is closed on purpose: a code the page has never heard of
     would flow into the record and into an issue as if it meant something.
     MUTATION: pass any string through — `whatever-i-felt-like` appears. */
  const [rec] = await runKokoroProbe({
    tts: fakeTts({ ok: false, reason: "whatever-i-felt-like" }), passage: phonemized() });
  assert.equal(rec.reason, "refused");
  assert.ok(PROBE_REASONS.includes(rec.reason));
});

test("an answer with no `ok` is a refusal, never a success", async () => {
  /* MUTATION: treat a missing `ok` as truthy-by-default. A plugin that returns
     `{}` then reports a complete measurement of nothing. */
  const [rec] = await runKokoroProbe({ tts: fakeTts({}), passage: phonemized() });
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, "refused");
});

test("a throwing bridge resolves `threw` — the run never rejects", async () => {
  /* This is driven from a drawer button; an unhandled rejection there is a
     console line nobody has open (#225's own lesson).
     MUTATION: remove the try/catch — this test fails with the raw error. */
  const tts = { kokoroProbe: async () => { throw new Error("boom"); } };
  const [rec] = await runKokoroProbe({ tts, passage: phonemized() });
  assert.equal(rec.reason, "threw");
  assert.equal(rec.ok, false);
});

test("`threw` carries the error's NAME, never its message (L12)", async () => {
  /* MUTATION: pass `e.message` as detail, or drop `nameOf(e)` — the first
     leaks the path into the paste, the second leaves a bare `threw`. */
  const path = "/var/mobile/Containers/Data/Application/0000/Library/model.onnx";
  const tts = { kokoroProbe: async () => { throw new TypeError(`cannot open ${path}`); } };
  const [rec] = await runKokoroProbe({ tts, passage: phonemized() });
  assert.equal(rec.reason, "threw");
  assert.equal(rec.synthReason, "TypeError");
  assert.ok(!JSON.stringify(rec).includes("/var/mobile"));
  assert.match(formatProbeReport(rec), /could not measure \(threw\/TypeError\)/);
  /* A code wins over a name; neither is admitted unless identifier-shaped. */
  assert.equal(nameOf({ code: "UNAVAILABLE", name: "Error" }), "UNAVAILABLE");
  assert.equal(nameOf({ code: "has space", name: "RangeError" }), "RangeError");
  assert.equal(nameOf({ code: "/a/b", name: "a b" }), null);
  assert.equal(nameOf("string"), null);
  /* And a native `detail` that is a sentence is refused by shape. */
  assert.equal(summarizeProbe({ native: { detail: `cannot open ${path}` }, reason: "threw" }).synthReason, null);
});

/* ==================================================================== */
/* Lane A: why it failed, and on what (docs/diagnostics/log-gaps-2026-09-26.md) */
/* ==================================================================== */

/** The 2026-09-26 paste's failure as a Lane A phone would send it. The values
    are illustrative; the shapes are the contract. Its model facts are the
    fp32 file's, because an iOS record is held to iOS's pin since D13. */
const LANE_A_FAILURE = Object.freeze({
  ok: false, reason: "synthesis-failed", detail: "inference-threw", platform: "ios",
  provider: "cpu", model: "kokoro-82m-v1.0-fp32", modelLoadColdMs: 457, modelLoadWarmMs: 374,
  synthColdMs: 812, synthWarmMs: 2210, synthFailures: 4, lines: 4, audioColdSec: 0, audioWarmSec: 0,
  ortCode: "not-implemented", ortOp: "ConvTranspose", ortStage: "run",
  lineOutcomes: ["threw", "threw", "threw", "threw"], nonFiniteLines: 0, silentLines: 0,
  ortVersion: "1.20.0", intraThreads: 0, cores: 6, modelBytes: 325532232, modelSha8: "8fbea51e",
  device: "iPhone15.2", os: "18.6.2", thermalStart: "nominal", thermalEnd: "fair",
  lowPower: false, memWarn: false, bgAtFail: true,
  baseMemoryBytes: 142 * 1024 * 1024, peakMemoryBytes: 312 * 1024 * 1024, availableMemoryBytes: 1104 * 1024 * 1024,
  lockedScreenCompleted: false,
});

test("summarizeProbe passes every Lane A key through by name", () => {
  /* The output contract Lane C's `voiceProbe()` reads. MUTATION: drop any
     key from summarizeProbe — its assertion goes red by name. */
  const rec = summarizeProbe({ native: LANE_A_FAILURE, reason: "synthesis-failed" });
  const want = {
    platform: "ios", ortCode: "not-implemented", ortOp: "ConvTranspose", ortStage: "run", loadErr: null,
    lineOutcomes: "threw,threw,threw,threw", nonFiniteLines: 0, silentLines: 0,
    ortVersion: "1.20.0", intraThreads: 0, cores: 6, modelBytes: 325532232, modelSha8: "8fbea51e", modelPin: "ok",
    device: "iPhone15.2", os: "18.6.2", thermalStart: "nominal", thermalEnd: "fair",
    lowPower: false, memWarn: false, bgAtFail: true, baseMemoryMb: 142, peakMemoryMb: 312, availableMemoryMb: 1104,
  };
  for (const [k, v] of Object.entries(want)) assert.deepEqual(rec[k], v, k);
  assert.equal(summarizeProbe({ native: { loadErr: "no-such-file" } }).loadErr, "no-such-file");
  assert.equal(summarizeProbe({ native: { platform: "android" } }).platform, "android");
  /* The existing keys are untouched. */
  assert.equal(rec.synthReason, "inference-threw");
  assert.equal(rec.synthFailures, 4);
  assert.equal(rec.rtfWarm, null);
});

test("an older shell's record has every Lane A key, and every one is null", () => {
  /* MUTATION: default a boolean to false or a count to 0 — the record would
     then claim "no memory warning" for a phone that never said. */
  const rec = summarizeProbe({ native: READING_685, audioSec: 77.4 });
  for (const k of ["platform", "ortCode", "ortOp", "ortStage", "loadErr", "lineOutcomes", "nonFiniteLines",
    "silentLines", "ortVersion", "intraThreads", "cores", "modelBytes", "modelSha8", "modelPin", "device", "os",
    "thermalStart", "thermalEnd", "lowPower", "memWarn", "bgAtFail", "baseMemoryMb"]) {
    assert.ok(k in rec, `${k} is part of the record`);
    assert.equal(rec[k], null, k);
  }
});

test("summarizeProbe drops malformed Lane A values instead of storing them", () => {
  /* Admitted BY SHAPE or from a closed set, or not at all. MUTATION: relax
     any one sanitiser — the path, the comma, the ninth hex digit gets in. */
  const bad = summarizeProbe({ native: {
    ortCode: "segfault", ortOp: "/var/mobile/Containers/Data/model.onnx", ortStage: "load",
    loadErr: "Error: could not open", lineOutcomes: ["ok", "exploded", "ok"], nonFiniteLines: -1, silentLines: 1.5,
    ortVersion: "v1.20", intraThreads: "0", cores: NaN, modelBytes: -5, modelSha8: "04c658aec",
    device: "iPhone15,2", os: "18.6 beta", thermalStart: "hot", thermalEnd: "Nominal",
    lowPower: "false", memWarn: 1, bgAtFail: null, baseMemoryBytes: -1, platform: "windows",
  } });
  for (const k of ["ortCode", "ortOp", "ortStage", "loadErr", "lineOutcomes", "nonFiniteLines", "silentLines",
    "ortVersion", "intraThreads", "cores", "modelBytes", "modelSha8", "device", "os", "thermalStart",
    "thermalEnd", "lowPower", "memWarn", "bgAtFail", "baseMemoryMb", "platform"]) {
    assert.equal(bad[k], null, `${k} must be refused`);
  }
  assert.equal(summarizeProbe({ native: { ortOp: "A".repeat(32) } }).ortOp, "A".repeat(32));
  assert.equal(summarizeProbe({ native: { ortOp: "A".repeat(33) } }).ortOp, null, "32 characters at most");
  assert.equal(summarizeProbe({ native: { device: "Pixel-8a" } }).device, "Pixel-8a");
  assert.equal(summarizeProbe({ native: { device: "x".repeat(33) } }).device, null);
  /* The list is capped at 32 (fifteen chunks since KV-R2) and never partially admitted. */
  const many = summarizeProbe({ native: { lineOutcomes: Array(40).fill("ok") } }).lineOutcomes;
  assert.equal(many.split(",").length, 32);
  assert.equal(summarizeProbe({ native: { lineOutcomes: [] } }).lineOutcomes, null);
  for (const t of LINE_OUTCOMES) assert.equal(summarizeProbe({ native: { lineOutcomes: [t] } }).lineOutcomes, t);
});

test("modelPin is ok, mismatch, or null — never a guess (L08)", () => {
  /* MUTATION: read "ok" when only the length matches — a stale Android
     extraction of the same size then passes. */
  const pin = (native) => summarizeProbe({ native }).modelPin;
  assert.equal(pin({ modelBytes: 86033585, modelSha8: "04c658ae" }), "ok");
  /* Per platform since D13 (KV-R2): iOS is held to fp32's pin and Android to
     q8f16's. MUTATION: hold every platform to one pin — iOS's right file then
     reads MISMATCH, or Android's wrong one reads ok. */
  assert.equal(pin({ platform: "ios", modelBytes: 325532232, modelSha8: "8fbea51e" }), "ok");
  assert.equal(pin({ platform: "ios", modelBytes: 86033585, modelSha8: "04c658ae" }), "mismatch",
    "q8f16 in the iOS app is the wrong file");
  assert.equal(pin({ platform: "android", modelBytes: 325532232, modelSha8: "8fbea51e" }), "mismatch",
    "fp32 in the APK is the wrong file");
  assert.equal(pin({ platform: "android", modelBytes: 86033585, modelSha8: "04c658ae" }), "ok");
  assert.equal(pin({ modelBytes: 86033585, modelSha8: "deadbeef" }), "mismatch");
  assert.equal(pin({ modelBytes: 1234, modelSha8: "04c658ae" }), "mismatch");
  assert.equal(pin({ modelBytes: 1234 }), "mismatch");
  assert.equal(pin({ modelSha8: "deadbeef" }), "mismatch");
  assert.equal(pin({ modelBytes: 86033585 }), null, "half a match proves nothing");
  assert.equal(pin({}), null);
  assert.equal(pin({ modelBytes: 86033585, modelSha8: "04C658AE" }), null, "an unshaped sha is absent, not a match");
});

test("KOKORO_MODEL_PINS are each platform's bundled model pin in fetch-models.mjs, not copies that can drift", async () => {
  /* MUTATION: re-pin a model in fetch-models.mjs without moving this — the
     phone would then report `pin MISMATCH` for the right file. */
  const { bundledPins } = await import("../tools/mobile/fetch-models.mjs");
  for (const platform of ["ios", "android"]) {
    const [model] = bundledPins(platform).filter((p) => p.kind === "model");
    assert.equal(KOKORO_MODEL_PINS[platform].bytes, model.bytes, platform);
    assert.equal(KOKORO_MODEL_PINS[platform].sha8, model.sha256.slice(0, 8), platform);
  }
  assert.deepEqual(Object.keys(KOKORO_MODEL_PINS).sort(), ["android", "ios"]);
});

test("the drawer report says why it failed and on what (Lane A)", () => {
  /* Each line fails by name if its field is dropped from the formatter.
     MUTATION: drop any line of probeContextLines. */
  const text = formatProbeReport(summarizeProbe({ native: LANE_A_FAILURE, reason: "synthesis-failed" }));
  assert.match(text, /^voice probe: could not measure \(synthesis-failed\/inference-threw\)$/m);
  assert.match(text, /^  ORT           1\.20\.0 cpu threads=auto cores=6$/m);
  assert.match(text, /^  failure       not-implemented op=ConvTranspose at=run background=y$/m);
  assert.match(text, /^  lines         threw,threw,threw,threw$/m);
  assert.match(text, /^  model file    325532232 B sha 8fbea51e \(pin ok\)$/m);
  assert.match(text, /^  device        iPhone15\.2 iOS 18\.6\.2  thermal nominal>fair  low power n$/m);
  assert.match(text, /^  memory        base 142 MB  peak 312 MB  headroom 1104 MB  warning n$/m);
  const mism = formatProbeReport(summarizeProbe({
    native: { ...LANE_A_FAILURE, modelSha8: "deadbeef", loadErr: "no-model" }, reason: "synthesis-failed" }));
  assert.match(mism, /\(pin MISMATCH\)/);
  assert.match(mism, / load=no-model/);
});

test("the drawer report on a success carries the same lines, garbage counts included", () => {
  /* MUTATION: print the Lane A lines only on a refusal. */
  const native = { ...LANE_A_FAILURE, ok: true, reason: "", detail: "non-finite", ortCode: undefined,
    ortOp: undefined, ortStage: undefined, bgAtFail: undefined, synthFailures: 2, audioColdSec: 3, audioWarmSec: 6,
    lineOutcomes: ["ok", "nan", "silent", "ok"], nonFiniteLines: 1, silentLines: 1, intraThreads: 4 };
  const text = formatProbeReport(summarizeProbe({ native }));
  assert.match(text, /^  lines         ok,nan,silent,ok \(non-finite 1, silent 1\)$/m);
  assert.match(text, /threads=4 cores=6/);
  assert.doesNotMatch(text, /^  failure/m, "no failure line when nothing named one");
  assert.match(text, /^  device        iPhone15\.2 iOS 18\.6\.2/m);
});

test("an older shell's drawer report is unchanged: no Lane A line appears", () => {
  /* MUTATION: print the new lines with dashes when their data is absent. */
  const text = formatProbeReport(summarizeProbe({ native: READING_685, audioSec: 77.4 }));
  assert.doesNotMatch(text, /^  (ORT|failure|lines {9}|model file|device|memory) /m);
  assert.equal(formatProbeReport(summarizeProbe({ reason: "engine-absent" })).split("\n").length, 1);
});

test("a successful run computes RTF against the passage's own duration", async () => {
  const passage = phonemized();
  const audioSec = passageSeconds(passage);
  const [rec] = await runKokoroProbe({
    tts: fakeTts({ ok: true, synthWarmMs: audioSec * 1000 * 0.4, synthColdMs: audioSec * 1000 * 0.9,
      modelLoadColdMs: 1500, modelLoadWarmMs: 90, peakMemoryBytes: 280 * 1024 * 1024,
      provider: "cpu", model: "1.0", lockedScreenCompleted: true, lines: 4 }),
    passage,
    now: (() => { let t = 0; return () => (t += 1000); })(),
  });
  assert.equal(rec.ok, true);
  assert.ok(Math.abs(rec.rtfWarm - 0.4) < 1e-9);
  assert.ok(Math.abs(rec.rtfCold - 0.9) < 1e-9);
  assert.equal(rec.audioSec, audioSec);
  /* The page's own stopwatch is kept ALONGSIDE the native figure — they answer
     different questions (one is synthesis, one includes the bridge hop).
     MUTATION: overwrite `elapsedMs` with `synthWarmMs`. */
  assert.equal(rec.elapsedMs, 1000);
  assert.equal(probeVerdict(rec, "newest").go, true);
});

/* ---------- KV-R2: probe v2, one record per pass ---------- */

/** What an iOS probe-v2 build answers: two passes over the fp32 model and
    the fifteen-chunk passage. The CPU pass measured and was finite; the
    CoreML pass rendered but two chunks came back NaN, and one threw. Values
    are illustrative; the shapes are the contract. */
const MiB = 1024 * 1024;
const V2_ANSWER = Object.freeze({
  ok: true, reason: "", platform: "ios",
  passes: [
    { pass: "cpu", provider: "cpu", ok: true, reason: "", detail: "", platform: "ios", model: "kokoro-82m-v1.0-fp32",
      modelLoadColdMs: 2100, modelLoadWarmMs: 900, synthColdMs: 3000, synthWarmMs: 60000, audioColdSec: 3, audioWarmSec: 75,
      synthFailures: 0, lines: 15, lineOutcomes: Array(15).fill("ok"), nonFiniteLines: 0, silentLines: 0,
      intraThreads: 4, peakMemoryBytes: 900 * MiB, processPeakBytes: 900 * MiB, lockedScreenCompleted: true,
      acceleratorWired: false, modelBytes: 325532232, modelSha8: "8fbea51e" },
    { pass: "coreml", provider: "coreml", providerBasis: "requested", ok: true, reason: "", detail: "non-finite", platform: "ios", model: "kokoro-82m-v1.0-fp32",
      modelLoadColdMs: 41000, modelLoadWarmMs: 9000, synthColdMs: 2000, synthWarmMs: 30000, audioColdSec: 3, audioWarmSec: 60,
      synthFailures: 3, lines: 15, lineOutcomes: ["ok", "nan", "ok", "threw", "ok", "nan", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"],
      nonFiniteLines: 2, silentLines: 0, ortCode: "ep-fail", ortOp: "Conv", ortStage: "run",
      intraThreads: 4, peakMemoryBytes: 700 * MiB, processPeakBytes: 900 * MiB, lockedScreenCompleted: true,
      acceleratorWired: true, modelBytes: 325532232, modelSha8: "8fbea51e" },
  ],
});

test("one row per pass, carrying provider, warm RTF, peak, finite and error text", async () => {
  /* KV-R2's acceptance, read off the record: per pass (CPU, CoreML), warm RTF,
     peak memory, finite yes/no, and ORT's error tokens if a chunk threw.
     MUTATION: drop `finite` from summarizeProbe — both `finite` assertions
     go red. MUTATION: summarize the answer as ONE record — the length is 1. */
  const records = await runKokoroProbe({ tts: fakeTts(V2_ANSWER), passage: PASSAGE, now: () => 0 });
  assert.equal(records.length, 2, "one record per pass");
  const [cpu, coreml] = records;
  assert.deepEqual(records.map((r) => r.pass), ["cpu", "coreml"]);
  assert.deepEqual(records.map((r) => r.provider), ["cpu", "coreml"]);
  /* CoreML is REQUESTED, not confirmed: ORT 1.20 cannot say which nodes it
     took. MUTATION: drop `providerBasis` from summarizeProbe — red here and
     in the drawer text below. */
  assert.deepEqual(records.map((r) => r.providerBasis), [null, "requested"]);
  assert.ok(Math.abs(cpu.rtfWarm - 0.8) < 1e-9, "warm RTF is synthesis over audio for every chunk after the first");
  assert.ok(Math.abs(coreml.rtfWarm - 0.5) < 1e-9);
  assert.equal(cpu.peakMemoryMb, 900);
  assert.equal(coreml.peakMemoryMb, 700, "each pass's own peak, not the process's");
  assert.equal(coreml.processPeakMb, 900);
  assert.equal(cpu.finite, true);
  assert.equal(coreml.finite, false);
  assert.equal(coreml.nonFiniteLines, 2);
  assert.equal(coreml.ortCode, "ep-fail");
  assert.equal(coreml.ortOp, "Conv");
  assert.equal(coreml.ortStage, "run");
  assert.equal(cpu.ortCode, null);
  assert.equal(coreml.modelPin, "ok", "the fp32 file is iOS's pin");
  /* Both go into the drawer, each under its own pass. */
  const text = formatProbeReport(records);
  assert.match(text, /^voice probe \[cpu\]: kokoro-probe/m);
  assert.match(text, /^voice probe \[coreml\]: kokoro-probe/m);
  assert.match(text, /^  finite        yes \(no rendered chunk held NaN\/Infinity\)$/m);
  assert.match(text, /^voice probe \[coreml\]: kokoro-probe model \S+ provider coreml \(requested — /m);
  assert.doesNotMatch(text, /provider cpu \(requested/);
  assert.match(text, /^  finite        NO — 2 of 15 chunks held NaN\/Infinity$/m);
  assert.deepEqual([...PROBE_PASSES], ["cpu", "coreml", ...V3_PASSES]);
  /* diagnostic-log.js imports nothing, so it carries its own copy of the
     pass words; the two are held in step here. MUTATION: rename a pass in
     either — the ring then drops the pass of every row. */
  const diag = await import("./diagnostic-log.js");
  assert.deepEqual([...diag.PROBE_PASSES], [...PROBE_PASSES]);
  assert.deepEqual([...diag.PROBE_KILLED_STAGES], [...KILLED_STAGES]);
  assert.deepEqual([...diag.PROBE_PROVIDER_BASES], [...PROVIDER_BASES]);
  /* KV-R3's closed sets, held in step the same way. */
  assert.deepEqual([...diag.PROBE_CML_CODES], [...CML_CODES]);
  assert.deepEqual([...diag.PROBE_CML_STAGES], [...CML_STAGES]);
  assert.deepEqual([...diag.PROBE_SCREENS], [...SCREEN_STATES]);
  assert.deepEqual([...diag.PROBE_KEEP_ALIVE], [...KEEP_ALIVE_STATES]);
  assert.deepEqual([...diag.PROBE_SPEED_VERDICTS], [...SPEED_VERDICTS]);
});

test("a pass with a non-finite chunk is never a pass", () => {
  /* §6a: "only a finite pass counts". The CoreML pass above is FASTER than the
     CPU pass and would pass every other clause; a voice that goes NaN on two
     chunks in fifteen drops two sentences in fifteen.
     MUTATION: drop the `finite === false` clause from probeVerdict — the
     faster, broken pass reads GO. */
  const [cpu, coreml] = summarizePasses({ native: V2_ANSWER, audioSec: 77.4 });
  assert.equal(probeVerdict(cpu, "newest").go, true, "the finite pass under 0.8 is a pass");
  /* §6a: a v2 pass's peak is recorded, not gated — 900 MB is no failure here,
     and the K-01 record (no `pass`) keeps its 400 MB ceiling.
     MUTATION: gate v2 passes on 400 MB — the fp32 CPU pass above reads NO. */
  assert.equal(cpu.peakMemoryMb, 900);
  assert.ok(probeVerdict({ ...cpu, pass: null }, "newest").failures.some((x) => /^peak-memory 900 MB/.test(x)));
  const verdict = probeVerdict(coreml, "newest");
  assert.equal(verdict.go, false);
  assert.ok(verdict.failures.some((x) => /^non-finite 2 of 15 chunks$/.test(x)), verdict.failures.join("; "));
  /* Its third failed chunk THREW: named once, apart from the two NaN ones. */
  assert.ok(verdict.failures.some((x) => /^chunks-failed 1 of 15 /.test(x)), verdict.failures.join("; "));
  /* A FINITE pass that dropped a chunk is not a pass either: a chunk that
     threw or came back silent is a sentence the listener never hears.
     MUTATION: drop the `chunks-failed` clause — this reads GO. */
  const dropped = probeVerdict({ ...cpu, synthFailures: 1, lineOutcomes: "ok,silent" }, "newest");
  assert.equal(dropped.go, false);
  assert.deepEqual(dropped.failures, ["chunks-failed 1 of 15 (threw, silent or empty)"]);
  /* finiteOf's three answers: a count of garbage is "no", a clean count over
     rendered audio is "yes", and anything unmeasured is "unknown". */
  assert.equal(finiteOf(2, 60), false);
  assert.equal(finiteOf(0, 60), true);
  assert.equal(finiteOf(0, 0), null, "nothing rendered is not 'finite'");
  assert.equal(finiteOf(null, 60), null, "an older shell that did not count is not 'finite'");
});

test("coreml-unavailable is its own named pass, and the CPU pass beside it stands", () => {
  /* ORT 1.20.0 may be built without the CoreML EP; pass B then says so and
     pass A is untouched. MUTATION: drop `coreml-unavailable` from
     PROBE_REASONS — the pass degrades to `refused` and the reason is lost. */
  const native = { ok: true, platform: "ios", passes: [
    V2_ANSWER.passes[0],
    { pass: "coreml", provider: "coreml", ok: false, reason: "coreml-unavailable", loadErr: "ep-fail", platform: "ios" },
  ] };
  const [cpu, coreml] = summarizePasses({ native, audioSec: 77.4 });
  assert.equal(cpu.ok, true);
  assert.equal(coreml.ok, false);
  assert.equal(coreml.reason, "coreml-unavailable");
  assert.equal(coreml.loadErr, "ep-fail");
  assert.equal(coreml.finite, null, "nothing ran, so finiteness is unknown, not yes");
  assert.match(formatProbeReport(coreml), /^voice probe \[coreml\]: could not measure \(coreml-unavailable\)$/m);
  /* A pass reason outside the vocabulary is `refused`, as a whole answer's is. */
  const odd = summarizePasses({ native: { ok: true, passes: [{ pass: "cpu", ok: false, reason: "made-up" }] } });
  assert.equal(odd[0].reason, "refused");
});

test("a refusal, an Android answer and an older shell are each ONE record", async () => {
  /* Only a run that reached its passes has more than one thing to say.
     MUTATION: always map over `native.passes` — a refusal becomes zero rows
     and the founder's paste loses the only line that said why. */
  const [refusal, ...rest] = await runKokoroProbe({ tts: fakeTts({ ok: false, reason: "model-absent" }), passage: PASSAGE });
  assert.equal(refusal.reason, "model-absent");
  assert.equal(rest.length, 0);
  const android = await runKokoroProbe({
    tts: fakeTts({ ok: true, platform: "android", pass: "cpu", provider: "cpu", synthWarmMs: 1000, audioWarmSec: 2,
      nonFiniteLines: 1, lines: 15 }),
    passage: PASSAGE });
  assert.equal(android.length, 1);
  assert.equal(android[0].pass, "cpu");
  assert.equal(android[0].finite, false, "Android reports finiteness the same way (D13)");
  const older = await runKokoroProbe({ tts: fakeTts({ ok: true, synthWarmMs: 1000, audioWarmSec: 2 }), passage: PASSAGE });
  assert.equal(older.length, 1);
  assert.equal(older[0].pass, null);
});

test("a run the system killed is reported by the next run's first record", () => {
  /* The card's stop rule: "the app is killed during a pass (report the last
     logged peak)". The native half leaves a marker per chunk; the next run
     carries it. MUTATION: drop the prevKilled keys — the paste of the run
     after a kill is indistinguishable from a first run. */
  const native = { ...V2_ANSWER, passes: [
    { ...V2_ANSWER.passes[0], prevKilledPass: "coreml", prevKilledStage: "synth", prevKilledChunksDone: 6, prevKilledPeakBytes: 1400 * MiB },
    V2_ANSWER.passes[1],
  ] };
  const [first, second] = summarizePasses({ native, audioSec: 77.4 });
  assert.equal(first.prevKilledPass, "coreml");
  assert.equal(first.prevKilledStage, "synth");
  assert.equal(first.prevKilledChunksDone, 6);
  assert.equal(first.prevKilledPeakMb, 1400);
  assert.equal(second.prevKilledPass, null);
  assert.match(formatProbeReport(first), /^  LAST RUN KILLED in the coreml pass, after 6 chunks, peak 1400 MB$/m);
  /* A kill inside the CoreML LOAD (the graph compile) is the load's, not the
     CPU pass's last chunk. MUTATION: drop `prevKilledStage` — it reads as
     "after ? chunks", a synthesis that never started. */
  const [atLoad] = summarizePasses({ native: { ...V2_ANSWER, passes: [
    { ...V2_ANSWER.passes[0], prevKilledPass: "coreml", prevKilledStage: "load", prevKilledChunksDone: 0, prevKilledPeakBytes: 600 * MiB },
  ] }, audioSec: 77.4 });
  assert.equal(atLoad.prevKilledStage, "load");
  assert.match(formatProbeReport(atLoad), /^  LAST RUN KILLED in the coreml pass, during its load, peak 600 MB$/m);
});

/* ---------- the two copies of one string ---------- */

test("the engine name is identical in the player module and the plugin's web half", () => {
  /* A classic-script page and a plugin web half cannot import each other
     (tts-bridge.js's header carries the URL argument), so `PROBE_ENGINE` is
     written twice. A drift would not throw — it would degrade into the
     plugin's ordinary `speak` path and measure the SYSTEM voice while
     reporting a Kokoro number, which is the single worst failure this
     instrument can have.
     MUTATION: change either constant. */
  const web = fs.readFileSync(
    path.join(REPO, "mobile/plugins/foray-tts/web/foray-tts.js"), "utf8");
  const m = web.match(/export const PROBE_ENGINE = "([^"]+)"/);
  assert.ok(m, "the web half must export PROBE_ENGINE");
  assert.equal(m[1], PROBE_ENGINE);
});

test("the probe never reaches the narration path", () => {
  /* THE INERTNESS CLAIM, asserted against source rather than intent:
     `queue-manager.js` must not know this module exists, and `_speakNarration`
     must still speak `item.script`.
     MUTATION: import kokoro-probe.js into queue-manager.js. */
  const qm = fs.readFileSync(path.join(REPO, "player/queue-manager.js"), "utf8");
  assert.ok(!qm.includes("kokoro"), "queue-manager.js must not mention kokoro at all");
  assert.ok(qm.includes("this._tts.speak(item.script,"), "narration is still spoken from `script`");
});

/* ---------- KV-R3: probe v3 — Core ML vs ORT, speed 1.0 and 1.5, locked, soak ---------- */

const IOS_MATRIX = fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/KokoroProbeMatrix.swift"), "utf8");

/** One pass x speed as iOS's `measurePass` sends it. `synthWarmMs` over
    `contentWarmSec` is the content RTF; over `audioWarmSec`, the wall RTF. */
function v3Record(pass, speed, { rtf, ok = true, reason = "", nonFinite = 0, failures = 0, bg = 15, locked = 15, cpu = 1 } = {}) {
  const content = 60;
  const audio = content / speed;
  const coreml = ["ane", "ane-cputail", "cml-cpu"].includes(pass);
  return {
    platform: "ios", pass, speed, provider: coreml ? "coreml" : "cpu", ok, reason, detail: "",
    model: coreml ? "kokoro-82m-v1.0-coreml7" : "kokoro-82m-v1.0-fp32",
    modelLoadColdMs: 20000, modelLoadWarmMs: 300,
    synthColdMs: 1000, synthWarmMs: rtf * content * 1000, audioColdSec: 3 / speed, audioWarmSec: ok ? audio : 0,
    contentColdSec: 3, contentWarmSec: ok ? content : 0, cpuWarmSec: cpu * content,
    synthFailures: failures, nonFiniteLines: nonFinite, silentLines: 0, lines: 15,
    lineOutcomes: Array(15).fill("ok"), bgChunks: bg, lockedChunks: locked, keepAlive: "audio",
    peakMemoryBytes: (coreml ? 210 : 1100) * MiB, lockedScreenCompleted: bg === 15, hasWav: speed === 1.5 && ok,
    ...(coreml ? { route: pass === "ane" ? "ane,ane,ane,all,all,ane,all" : pass === "cml-cpu" ? "cpu,cpu,cpu,cpu,cpu,cpu,cpu" : "ane,ane,ane,cpu,cpu,ane,cpu",
      stageMs: [70, 40, 5, 60, 120, 300, 20], providerBasis: pass === "cml-cpu" ? undefined : "requested" }
      : { intraThreads: Number(pass.slice(-1)) }),
  };
}

const V3_ANSWER = {
  ok: true, platform: "ios", speeds: [1, 1.5],
  passes: [
    v3Record("ane", 1, { rtf: 0.05 }), v3Record("ane", 1.5, { rtf: 0.04 }),
    v3Record("ort-cpu-t2", 1, { rtf: 0.4, cpu: 0.7 }), v3Record("ort-cpu-t2", 1.5, { rtf: 0.3, cpu: 0.5 }),
    v3Record("ane-cputail", 1, { rtf: 0.08, cpu: 0.05 }), v3Record("ane-cputail", 1.5, { rtf: 0.06, cpu: 0.04 }),
    v3Record("ort-cpu-t3", 1, { rtf: 0.38, cpu: 0.9 }), v3Record("ort-cpu-t3", 1.5, { rtf: 0.6, cpu: 0.8 }),
    v3Record("cml-cpu", 1, { rtf: 0.3 }), v3Record("cml-cpu", 1.5, { rtf: 0.25, nonFinite: 1, failures: 1 }),
    v3Record("ort-cpu-t4", 1, { rtf: 0.9 }), v3Record("ort-cpu-t4", 1.5, { rtf: 0.8 }),
  ],
};

test("v3: twelve records, one per pass x speed, each with the content AND wall RTF (KV-R3)", async () => {
  /* The founder's run is the matrix: six passes, speed 1.0 and 1.5. The 1.5
     record's content RTF divides by the seconds the SAME text lasts at 1.0
     (60 s here), the wall RTF by its own 40 s.
     MUTATION: compute `rtfContentWarm` over `audioWarmSec` — the ane @1.5
     content reads 0.06, not 0.04. */
  const records = await runKokoroProbe({ tts: fakeTts(V3_ANSWER), passage: PASSAGE, now: () => 0 });
  assert.equal(records.length, 12);
  assert.deepEqual(records.map((r) => r.pass), V3_PASSES.flatMap((p) => [p, p]));
  assert.deepEqual(records.map((r) => r.speed), V3_PASSES.flatMap(() => [...PROBE_SPEEDS]));
  const ane15 = records[1];
  assert.ok(Math.abs(ane15.rtfContentWarm - 0.04) < 1e-9);
  assert.ok(Math.abs(ane15.rtfWarm - 0.06) < 1e-9, "the wall RTF is over the speed-1.5 audio");
  assert.ok(Math.abs(ane15.cpuPerContentSec - 1) < 1e-9);
  assert.deepEqual(ane15.stageMs, [70, 40, 5, 60, 120, 300, 20]);
  assert.equal(ane15.route, "ane,ane,ane,all,all,ane,all");
  assert.equal(ane15.screen, "locked");
  assert.equal(ane15.keepAlive, "audio");
  assert.equal(ane15.providerBasis, "requested");
  assert.equal(records[2].intraThreads, 2);
  assert.equal(records[2].route, null, "an ORT pass has no Core ML route");
  /* The WAVs are named by PASS only (§5 item 10); the drawer plays them
     natively, so no path is ever on the wire. MUTATION: read `hasWav` from
     the 1.0 record — no pass offers a play button. */
  assert.deepEqual(wavPasses(records), V3_PASSES);
  assert.deepEqual(wavPasses([{ pass: "ane", hasWav: "yes" }, { pass: "made-up", hasWav: true }]), []);
});

test("v3: a pass's WAV is played natively by NAME, never by path", async () => {
  /* MUTATION: send a path, or let an unknown pass through — the call below
     carries it. */
  let sent = null;
  const tts = { kokoroProbe: async (opts) => { sent = opts; return { ok: true, mode: "listen", durationSec: 51.2 }; } };
  assert.deepEqual(await playProbeWav({ tts, pass: "ane-cputail" }), { ok: true, durationSec: 51.2 });
  assert.deepEqual(sent, { engine: PROBE_ENGINE, mode: "listen", pass: "ane-cputail" });
  sent = null;
  assert.deepEqual(await playProbeWav({ tts, pass: "../etc" }), { ok: false, reason: "refused" });
  assert.equal(sent, null, "an unknown pass never reaches the bridge");
  assert.deepEqual(await playProbeWav({ tts: fakeTts({ ok: false, detail: "no-wav" }), pass: "ane" }), { ok: false, reason: "no-wav" });
  assert.deepEqual(await playProbeWav({ tts: null, pass: "ane" }), { ok: false, reason: "no-bridge" });
  const threw = await playProbeWav({ tts: { kokoroProbe: async () => { throw new TypeError("/a/path"); } }, pass: "ane" });
  assert.deepEqual(threw, { ok: false, reason: "threw", detail: "TypeError" });
});

test("v3: the verdict per pass against the 1.5x target, with the doc's margin", () => {
  /* ≤ 0.55 GO, ≤ 0.667 MARGINAL, above NO; a pass that garbled a chunk is NO
     whatever its speed. MUTATION: judge the 1.0 record instead of the 1.5 —
     ort-cpu-t3 reads GO on its 0.38. */
  assert.equal(TARGET_CONTENT_RTF, 0.55);
  assert.ok(Math.abs(BREAK_EVEN_CONTENT_RTF - 2 / 3) < 1e-12);
  const records = summarizePasses({ native: V3_ANSWER });
  const rows = passVerdicts(records);
  assert.deepEqual(rows.map((r) => r.pass), V3_PASSES);
  const by = Object.fromEntries(rows.map((r) => [r.pass, r]));
  assert.equal(by.ane.verdict, "go");
  assert.equal(by.ane.backgroundSafe, false, "ane may use the GPU, which iOS blocks while locked");
  assert.equal(by["ane-cputail"].verdict, "go");
  assert.equal(by["ane-cputail"].meetsCoreMLRule, true, "background-safe Core ML at ≤ 0.4 on speed 1.0");
  assert.equal(by.ane.meetsCoreMLRule, false, "fast, but not background-safe");
  assert.equal(by["ort-cpu-t2"].verdict, "go");
  assert.equal(by["ort-cpu-t2"].meetsCoreMLRule, false, "ORT is never the Core ML rule");
  assert.equal(by["ort-cpu-t3"].verdict, "marginal");
  assert.equal(by["cml-cpu"].verdict, "no");
  assert.match(by["cml-cpu"].reasons.join(";"), /non-finite 1 of 15 chunks/);
  assert.equal(by["ort-cpu-t4"].verdict, "no");
  assert.equal(speedVerdict({ ok: false, reason: "coreml-requires-ios17" }).verdict, "unmeasured");
  assert.equal(speedVerdict({ ok: true, rtfContentWarm: 0.001 }).verdict, "unmeasured", "below the floor nothing rendered");
  assert.equal(speedVerdict({ ok: true, rtfContentWarm: 0.2, synthFailures: 1, nonFiniteLines: 0, lines: 15 }).verdict, "no");
  assert.deepEqual([...BACKGROUND_SAFE_PASSES], V3_PASSES.filter((p) => p !== "ane"));
  assert.deepEqual([...COREML_PASSES], ["ane", "ane-cputail", "cml-cpu"]);
  assert.equal(COREML_DECISION_RTF, 0.4);
});

test("v3: the drawer's table, one verdict per pass, and the decision rule, readable aloud", () => {
  /* MUTATION: drop the decision line — the founder is left to apply §4 by hand. */
  const text = formatProbeTable(summarizePasses({ native: V3_ANSWER }));
  const lines = text.split("\n");
  assert.match(lines[0], /content RTF = synthesis ÷ the text's length at speed 1\.0; 1\.5x target ≤ 0\.55/);
  assert.match(text, /^ane-cputail +0\.08 +0\.06 +0\.09 +0\.04 +210 +y +locked +GO$/m);
  assert.match(text, /^ort-cpu-t3 +0\.38 +0\.60 +0\.90 +0\.80 +1100 +y +locked +MARGINAL$/m);
  assert.match(text, /^cml-cpu .* NO$/m);
  assert.match(text, /^  ane: GO at 1\.5x \(GPU route, may stall locked\)$/m);
  assert.match(text, /^  ane-cputail: GO at 1\.5x \(runs locked\); meets the Core ML rule \(≤ 0\.4 at 1\.0\) — soak it$/m);
  assert.match(text, /decision \(doc §4\): ane-cputail qualifies for Core ML as the iOS engine if the soak survives\./);
  /* No Core ML pass qualifying: the cheapest ORT pass that keeps up is named. */
  const ortOnly = summarizePasses({ native: { ...V3_ANSWER, passes: V3_ANSWER.passes.filter((p) => !p.route) } });
  assert.match(formatProbeTable(ortOnly), /ORT stays — ort-cpu-t2 is the cheapest that keeps up\./);
  /* A refused pass says why on its row. */
  const refused = summarizePasses({ native: { ok: true, platform: "ios", passes: [
    { pass: "ane", speed: 1, ok: false, reason: "coreml-requires-ios17", route: "ane,ane,ane,all,all,ane,all" },
    { pass: "ane", speed: 1.5, ok: false, reason: "coreml-requires-ios17" },
  ] } });
  assert.equal(refused[0].reason, "coreml-requires-ios17", "a v3 reason is admitted, not `refused`");
  assert.match(formatProbeTable(refused), /^ane .* could not run: coreml-requires-ios17$/m);
  assert.equal(formatProbeTable([]), "");
  /* The per-record report says which speed and prints the content RTF. */
  assert.match(formatProbeReport(summarizePasses({ native: V3_ANSWER })[1]), /^voice probe \[ane @1\.5x\]: /m);
  assert.match(formatProbeReport(summarizePasses({ native: V3_ANSWER })[1]), /^  content RTF   cold 0\.33  warm 0\.04 /m);
});

test("v3: the screen a record ran under, from its per-chunk samples", () => {
  /* The founder runs the matrix twice (unlocked, then locked); the record,
     not his memory, says which. A phone with no passcode never reads
     "locked", so all-background without it is `background`. */
  assert.equal(screenOf(0, 0, 15), "unlocked");
  assert.equal(screenOf(15, 15, 15), "locked");
  assert.equal(screenOf(15, 0, 15), "background");
  assert.equal(screenOf(7, 0, 15), "mixed");
  assert.equal(screenOf(null, null, 15), null);
  assert.deepEqual([...SCREEN_STATES], ["unlocked", "locked", "background", "mixed"]);
  assert.deepEqual([...KILLED_STAGES], ["load", "synth", "soak"]);
});

test("v3: a Core ML failure is named by code and stage, by closed set", () => {
  const [r] = summarizePasses({ native: { ok: true, platform: "ios", passes: [
    { ...v3Record("ane", 1, { rtf: 0.05 }), cmlCode: "cml-nan-duration", cmlStage: "postAlbert" },
    { ...v3Record("ane", 1.5, { rtf: 0.05 }), cmlCode: "cml-anything", cmlStage: "somewhere", route: "gpu,gpu" },
  ] } });
  assert.equal(r.cmlCode, "cml-nan-duration");
  assert.equal(r.cmlStage, "postAlbert");
  const second = summarizePasses({ native: { ok: true, platform: "ios", passes: [
    { ...v3Record("ane", 1.5, { rtf: 0.05 }), cmlCode: "cml-anything", cmlStage: "somewhere", route: "gpu,gpu" },
  ] } })[0];
  assert.equal(second.cmlCode, null);
  assert.equal(second.cmlStage, null);
  assert.equal(second.route, null);
  assert.match(formatProbeReport(r), /^  Core ML       cml-nan-duration at postAlbert$/m);
});

test("v3: the soak asks for `mode: soak`, and answers ONE record with its per-minute series", async () => {
  /* MUTATION: drop `mode` from the bridge call — the phone runs the matrix
     again instead of the 30-minute loop. */
  let sent = null;
  const tts = { kokoroProbe: async (opts) => { sent = opts; return {
    ok: true, mode: "soak", platform: "ios", pass: "ane-cputail", speed: 1.5, route: "ane,ane,ane,cpu,cpu,ane,cpu",
    soakMinutes: 30, soakLoops: 412, soakElapsedSec: 1805, soakRtfSeries: [0.05, -1, 0.07], soakThermalSeries: ["nominal", "", "serious"],
    soakRtfMin: 0.04, soakRtfMedian: 0.05, soakRtfMax: 0.07, soakPeakBytes: 214 * MiB, soakPeakFirstBytes: 212 * MiB,
    soakPeakLastBytes: 214 * MiB, soakBgLoops: 412, soakLockedLoops: 410, soakFailures: 0, soakNonFinite: 0,
    cpuPerContentSec: 0.03, soakVerdict: "go", thermalStart: "nominal", thermalEnd: "serious", keepAlive: "audio",
  }; } };
  const [soak, ...rest] = await runKokoroProbe({ tts, passage: PASSAGE, mode: "soak", soakMinutes: 30 });
  assert.equal(rest.length, 0);
  assert.equal(sent.mode, "soak");
  assert.equal(sent.soakMinutes, 30);
  assert.equal(soak.kind, "soak");
  assert.equal(soak.ok, true);
  assert.equal(soak.loops, 412);
  assert.deepEqual(soak.rtfSeries, [0.05, null, 0.07], "-1 is a minute with no loop: null, not a number");
  assert.deepEqual(soak.thermalSeries, ["nominal", null, "serious"]);
  assert.equal(soak.peakFirstMb, 212);
  assert.equal(soak.verdict, "go");
  const text = formatSoakReport(soak);
  assert.match(text, /^voice soak \[ane-cputail @1\.5x\]: 412 loops over 30\.1 min, verdict GO$/m);
  assert.match(text, /^  per minute    0\.05n —\? 0\.07s /m);
  assert.match(text, /^  screen        410 of 412 loops locked, 412 in the background  keep-alive audio$/m);
  /* A matrix call never carries a mode. */
  let matrixOpts = null;
  await runKokoroProbe({ tts: { kokoroProbe: async (o) => { matrixOpts = o; return V3_ANSWER; } }, passage: PASSAGE });
  assert.equal(matrixOpts.mode, undefined);
});

test("v3: a soak iOS ended is reported by the next run, and a refused soak says why", async () => {
  const killed = summarizeSoak({ native: { ok: false, mode: "soak", reason: "synthesis-failed", detail: "calibration",
    prevKilledPass: "ane-cputail", prevKilledStage: "soak", prevKilledChunksDone: 97, prevKilledPeakBytes: 230 * MiB } });
  assert.equal(killed.ok, false);
  assert.equal(killed.reason, "synthesis-failed");
  assert.match(formatSoakReport(killed), /could not run \(synthesis-failed\/calibration\)\n  LAST RUN KILLED in the ane-cputail soak after 97 loops, peak 230 MB$/);
  const [noBridge] = await runKokoroProbe({ tts: null, passage: PASSAGE, mode: "soak" });
  assert.equal(noBridge.kind, "soak");
  assert.equal(noBridge.reason, "no-bridge");
  const [threw] = await runKokoroProbe({ tts: { kokoroProbe: async () => { throw new TypeError("x /private/path"); } }, passage: PASSAGE, mode: "soak" });
  assert.equal(threw.reason, "threw");
  assert.equal(threw.synthReason, "TypeError");
  const [refused] = await runKokoroProbe({ tts: fakeTts({ ok: false, reason: "model-absent" }), passage: PASSAGE, mode: "soak" });
  assert.equal(refused.reason, "model-absent");
});

test("v3: the Swift half and this module hold the same passes, target and codes", () => {
  /* Two languages, one contract. MUTATION: reorder a Swift case, change the
     Swift target, or rename a Core ML code in either file. */
  const cases = [...IOS_MATRIX.matchAll(/^\s+case (\w+)(?: = "([a-z0-9-]+)")?$/gm)]
    .map((m) => m[2] ?? m[1])
    .filter((c) => V3_PASSES.includes(c));
  assert.deepEqual(cases, V3_PASSES, "KokoroProbePass's cases, in run order");
  assert.match(IOS_MATRIX, /static let TARGET_CONTENT_RTF = 0\.55\b/);
  assert.match(IOS_MATRIX, /static let SPEEDS: \[Double\] = \[1\.0, 1\.5\]/);
  const codes = IOS_COREML.match(/static let CODES = \[([^\]]+)\]/);
  assert.ok(codes, "the Core ML engine keeps its codes as one array");
  assert.deepEqual((codes[1].match(/"[a-z-]+"/g) ?? []).map((t) => t.slice(1, -1)), [...CML_CODES]);
  for (const stage of CML_STAGES) assert.ok(IOS_COREML.includes(stage), `Swift never names stage ${stage}`);
  /* Every refusal the matrix can write is one this module admits. */
  for (const reason of ["coreml-requires-ios17", "model-absent", "engine-absent", "coreml-unavailable", "synthesis-failed"]) {
    assert.ok(IOS_MATRIX.includes(`"${reason}"`) || IOS_PLUGIN.includes(`"${reason}"`), `Swift never sends ${reason}`);
    assert.ok(PROBE_REASONS.includes(reason), `${reason} is not in PROBE_REASONS`);
  }
});

test("v3 review: the soak can be STOPPED, and a stopped or failed soak says so and why", async () => {
  /* A 30-minute locked loop the founder cannot end is a phone he cannot use.
     MUTATION: drop `stopped` from summarizeSoak — a four-minute soak reads
     like one iOS cut short. MUTATION: drop the engine code — a soak that
     failed at the vocoder says only "failed 15". */
  let sent = null;
  const tts = { kokoroProbe: async (opts) => { sent = opts; return { ok: true, mode: "stop" }; } };
  assert.deepEqual(await stopProbeSoak({ tts }), { ok: true });
  assert.deepEqual(sent, { engine: PROBE_ENGINE, mode: "stop" });
  assert.deepEqual(await stopProbeSoak({ tts: null }), { ok: false, reason: "no-bridge" });
  assert.deepEqual(await stopProbeSoak({ tts: fakeTts({ ok: false }) }), { ok: false, reason: "refused" });
  assert.deepEqual(await stopProbeSoak({ tts: { kokoroProbe: async () => { throw new TypeError("x"); } } }),
    { ok: false, reason: "threw", detail: "TypeError" });

  const stopped = summarizeSoak({ native: {
    ok: true, mode: "soak", platform: "ios", pass: "ane-cputail", speed: 1.5, soakMinutes: 30, soakLoops: 3,
    soakElapsedSec: 240, soakStopped: true, soakRtfMedian: 0.05, soakVerdict: "go", soakFailures: 2, soakNonFinite: 0,
    detail: "inference-threw", cmlCode: "cml-predict", cmlStage: "vocoder", cpuPerContentSec: 0.03, keepAlive: "audio",
  } });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.cmlCode, "cml-predict");
  assert.equal(stopped.cmlStage, "vocoder");
  assert.equal(stopped.cpuPerContentSec, 0.03);
  const text = formatSoakReport(stopped);
  assert.match(text, /^voice soak \[ane-cputail @1\.5x\]: 3 loops over 4\.0 min, verdict GO \(stopped early by you\)$/m);
  assert.match(text, /^  failures      2 \(non-finite 0\) — Core ML cml-predict at vocoder$/m);
  assert.match(text, /CPU 0\.03 CPU-s per content second/);
  assert.equal(summarizeSoak({ native: { ok: true, soakLoops: 1 } }).stopped, false, "not stopped unless the phone says so");
  const ort = summarizeSoak({ native: { ok: false, mode: "soak", reason: "synthesis-failed", detail: "calibration",
    loadErr: "ep-fail", ortCode: "made-up", cmlCode: "cml-nope" } });
  assert.equal(ort.loadErr, "ep-fail");
  assert.equal(ort.ortCode, null, "an ORT code outside the set is dropped");
  assert.equal(ort.cmlCode, null);
  assert.match(formatSoakReport(ort), /could not run \(synthesis-failed\/calibration\) — ORT load ep-fail$/);
  /* The Swift half answers `stop` off the probe queue, and the soak reads it. */
  assert.match(IOS_PLUGIN, /if call\.getString\("mode"\) == "stop" \{\s+ProbeSoakStop\.shared\.request\(\)/);
  assert.ok(IOS_PLUGIN.indexOf('call.getString("mode") == "stop"') < IOS_PLUGIN.indexOf("Self.probeQueue.async"),
    "the stop is answered BEFORE the probe queue, where the soak itself runs");
  assert.match(IOS_MATRIX, /shouldStop: \(\) -> Bool = \{ ProbeSoakStop\.shared\.isRequested \}/);
});
