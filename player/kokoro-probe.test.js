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
     MUTATION: null one line's `ids` — the passage refuses again and the probe
     goes back to answering `passage-unphonemized`. */
  assert.equal(passageProblem(PASSAGE), null);
  for (const l of PASSAGE.lines) {
    assert.ok(Array.isArray(l.ids) && l.ids.length > 0, `${l.id}: no ids`);
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

const IOS_PLUGIN = fs.readFileSync(
  path.join(REPO, "mobile/plugins/foray-tts/ios/Sources/ForayTtsPlugin/ForayTtsPlugin.swift"), "utf8");
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
  const suspects = new Set([...quoted(IOS_ENGINE), ...quoted(AND_ENGINE)]
    .filter((s) => /^(session|inference|no|zero)-/.test(s)));
  assert.ok(suspects.size >= 4, `expected the four synthesis codes, saw ${[...suspects]}`);
  for (const s of suspects) {
    assert.ok(SYNTH_REASONS.includes(s), `${s} is not in SYNTH_REASONS`);
  }
});

test("`cpu` is the whole implementation, not a fallback — and the probe says so", () => {
  /* The bundled-voice deck's viability estimates assume an accelerator. #685's
     `kokoro-probe/cpu` was never a CoreML attempt that fell back: no execution
     provider is appended on either platform, so ORT runs its CPU provider
     because nothing else was ever registered. The record reports that as a
     FACT (`acceleratorWired`) rather than leaving a reader to infer it from a
     provider string that reads like a fallback.
     MUTATION: append a CoreML or NNAPI provider without flipping
     `acceleratorWired` — the first half goes red and the deck keeps reading a
     CPU number as an accelerated one. */
  const appends = /appendCoreML|appendNnapi|addNnapi|CoreMLExecutionProvider|NNAPIExecutionProvider/;
  for (const [name, src] of [["ios", IOS_ENGINE], ["android", AND_ENGINE]]) {
    const wired = appends.test(src);
    const claims = /acceleratorWired[^\n]*\n?[^\n]*\btrue\b/.test(src);
    assert.equal(wired, claims,
      `${name}: the source and the flag disagree about whether an accelerator is wired`);
  }
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
  const broken = { ...PASSAGE, lines: PASSAGE.lines.map((l) => ({ ...l, ids: null })) };
  const tts = { kokoroProbe: async () => { called = true; return { ok: true }; } };
  return runKokoroProbe({ tts, passage: broken }).then((rec) => {
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
  return runKokoroProbe({ tts, passage: PASSAGE }).then((rec) => {
    assert.ok(seen, "the bridge was never asked");
    assert.equal(seen.passage.lines.length, 4);
    assert.equal(rec.reason, "model-absent", "the native half's own diagnosis wins");
  });
});

test("no bridge at all is `no-bridge`, not a crash and not a zero", async () => {
  const rec = await runKokoroProbe({ tts: null, passage: phonemized() });
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, "no-bridge");
  /* MUTATION: drop the `typeof tts.kokoroProbe === "function"` half — an older
     bridge object with no probe method throws a TypeError at a founder. */
  const stale = await runKokoroProbe({ tts: { speak: () => {} }, passage: phonemized() });
  assert.equal(stale.reason, "no-bridge");
});

test("a native refusal keeps the native's OWN code when it is one we know", async () => {
  /* `model-absent` (the build skipped the fetch) and `engine-absent` (no
     runtime compiled in) are different actions for a founder.
     MUTATION: always report `refused` — both diagnoses are lost. */
  for (const reason of ["model-absent", "engine-absent"]) {
    const rec = await runKokoroProbe({ tts: fakeTts({ ok: false, reason }), passage: phonemized() });
    assert.equal(rec.reason, reason);
  }
});

test("a native reason we do NOT know degrades to `refused`", async () => {
  /* The vocabulary is closed on purpose: a code the page has never heard of
     would flow into the record and into an issue as if it meant something.
     MUTATION: pass any string through — `whatever-i-felt-like` appears. */
  const rec = await runKokoroProbe({
    tts: fakeTts({ ok: false, reason: "whatever-i-felt-like" }), passage: phonemized() });
  assert.equal(rec.reason, "refused");
  assert.ok(PROBE_REASONS.includes(rec.reason));
});

test("an answer with no `ok` is a refusal, never a success", async () => {
  /* MUTATION: treat a missing `ok` as truthy-by-default. A plugin that returns
     `{}` then reports a complete measurement of nothing. */
  const rec = await runKokoroProbe({ tts: fakeTts({}), passage: phonemized() });
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, "refused");
});

test("a throwing bridge resolves `threw` — the run never rejects", async () => {
  /* This is driven from a drawer button; an unhandled rejection there is a
     console line nobody has open (#225's own lesson).
     MUTATION: remove the try/catch — this test fails with the raw error. */
  const tts = { kokoroProbe: async () => { throw new Error("boom"); } };
  const rec = await runKokoroProbe({ tts, passage: phonemized() });
  assert.equal(rec.reason, "threw");
  assert.equal(rec.ok, false);
});

test("a successful run computes RTF against the passage's own duration", async () => {
  const passage = phonemized();
  const audioSec = passageSeconds(passage);
  const rec = await runKokoroProbe({
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
