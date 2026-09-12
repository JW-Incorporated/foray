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
  PROBE_ENGINE, PROBE_REASONS, CHARS_PER_SEC,
  GO_RTF_NEWEST, GO_RTF_OLDEST, GO_PEAK_MEMORY_MB,
  passageSeconds, passageProblem, realTimeFactor, toMegabytes,
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

test("the shipped passage is UNPHONEMIZED, and that is the reported state", () => {
  /* THE HONESTY TEST. Nothing in this repo can run misaki, so every `ids` is
     null — and the probe must SAY so rather than synthesize something else.
     MUTATION: put a plausible id array into the JSON. This goes red, and so
     does the claim in the file's own `//shape` note. */
  assert.equal(passageProblem(PASSAGE), "passage-unphonemized");
  for (const l of PASSAGE.lines) assert.equal(l.ids, null);
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

/* ---------- the run ---------- */

const fakeTts = (answer) => ({ kokoroProbe: async () => answer });

test("the run refuses before touching the bridge when the passage is unphonemized", () => {
  /* ORDER IS THE CONTRACT. Asking a plugin to synthesize nulls would produce
     whatever that plugin does with nulls. MUTATION: check the passage after
     the call — `called` becomes true. */
  let called = false;
  const tts = { kokoroProbe: async () => { called = true; return { ok: true }; } };
  return runKokoroProbe({ tts, passage: PASSAGE }).then((rec) => {
    assert.equal(called, false);
    assert.equal(rec.reason, "passage-unphonemized");
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
