/* player/kokoro-probe.js — K-01's instrument, and nothing else.
 *
 * ── What this is ──────────────────────────────────────────────────────────
 * `docs/bundled-voice-plan.md` K-01 is "measure Kokoro on real phones before
 * anything is built on it". Its acceptance gate is a real device, which no
 * agent in this repo has, so what CAN be built here is the instrument and the
 * whole path that carries its numbers off the phone: a hidden drawer control
 * (`app.js` § voiceProbeOn), a plugin method that either synthesizes the
 * passage or says honestly why it could not, this module's arithmetic, and a
 * `voiceProbe` row in the Playback-diagnostics record a founder already knows
 * how to copy out (HUMAN-ACTIONS.md #21's routine).
 *
 * ── The one rule ──────────────────────────────────────────────────────────
 * NOTHING HERE CHANGES HOW NARRATION IS SPOKEN. `queue-manager.js` does not
 * import this file, `_speakNarration` is untouched, and the engine option this
 * module passes (`engine: "kokoro-probe"`) is one `foray-tts.js` only ever
 * sees from here. A probe that could alter the shipping speech path would be
 * an experiment you cannot run twice.
 *
 * ── Inert when the model is absent, and inert LOUDLY ───────────────────────
 * Three separate things have to exist before a number is real: the Kokoro
 * weights in the app bundle, a runtime that can execute them, and a
 * PRE-PHONEMIZED passage (K-01: "ids computed offline and shipped as JSON; no
 * text front-end on device"). Today the third is null in
 * `tools/mobile/kokoro-probe-passage.json` — see that file's own `//shape`
 * note — and the first two are K-04's. So every path below refuses with a
 * NAMED reason rather than reporting a zero. A probe that answered "RTF 0.0,
 * model load 0 ms" because nothing ran is worse than one that answers "I could
 * not run": the first gets pasted into a decision.
 *
 * ── Pure, like `playback-rate.js` and `default-voice.js` ───────────────────
 * No storage, no DOM, no `Date` of its own, no bridge. `client.js` owns the
 * wire (`ForayPlayer.runVoiceProbe`), `app.js` owns the control, and the
 * diagnostic row is written by `diagnostic-log.js`'s `voiceProbe()`. This file
 * owns the arithmetic and the vocabulary, which is what makes both testable in
 * Node with no phone.
 *
 * ── Probe v2 (KV-R2, docs/kokoro-voices-in-app-plan.md §6a, D13) ──────────
 * One run is now TWO PASSES on iOS — `cpu` (ORT's CPU provider, 4 threads)
 * and `coreml` (the CoreML EP, MLProgram on all compute units) — over the fp32
 * model, each over the passage cut into sentence chunks (one inference per
 * chunk). The native half answers `{ ok: true, passes: [record, record] }`
 * and `summarizePasses` turns it into ONE RECORD PER PASS, each the shape
 * `summarizeProbe` always returned plus `pass` and `finite`; each becomes its
 * own `voiceProbe` row. Android runs one pass (`cpu`, q8f16) and says so.
 * A pass with a non-finite chunk is never a pass (`probeVerdict`).
 */

/** The engine name the probe asks `foray-tts.js` for. One string, exported,
    because three files have to agree on it (this module, the web half, and
    both native halves) and a typo would degrade silently into "the system
    voice spoke the passage", which is the one wrong answer this instrument
    can give. */
export const PROBE_ENGINE = "kokoro-probe";

/** K-01's go/no-go rule, WRITTEN BEFORE THE RUN as the card requires, so the
    numbers cannot be read generously after the fact:

      RTF ≤ 0.80 warm on the newest phone
      RTF ≤ 1.50 on the oldest phone tried
      peak resident memory ≤ 400 MB
      locked-screen synthesis completes for the whole passage

    Miss any and K-04 waits for a design change (fp16 vs q8, execution
    provider, chunking) or the runner-up engine (Pocket TTS — deck §3).
    Exported as data so `probeVerdict()` and the tests read the same numbers
    the card does. */
export const GO_RTF_NEWEST = 0.8;
export const GO_RTF_OLDEST = 1.5;
export const GO_PEAK_MEMORY_MB = 400;

/** THE OTHER END OF THE GO RULE, and the hole issue #685 fell through.
 *
 * The first real reading off the founder's phone (build 2026091316, #685) was
 *
 *     voiceProbe kokoro-probe/cpu  rtf cold 0.00 warm 0.00  load 467ms/388ms
 *
 * and 0.00 passes every ceiling above by two orders of magnitude. `probeVerdict`
 * already refuses to read an ABSENT reading as a pass (`rtf-not-measured`); it
 * had nothing to say about a reading of zero, which is the same failure wearing
 * a number. The gate was one-sided, and the side it was missing is the side a
 * broken measurement actually arrives on.
 *
 * WHY 0.01 AND NOT SOME OTHER NUMBER. Two independent arguments land on the
 * same place, which is why this is the floor rather than a guess:
 *
 *   1. No phone can do it. Kokoro-82M is an 82-million-parameter graph and RTF
 *      0.01 is a hundred times faster than real time — roughly what the model
 *      is reported to reach on a desktop discrete GPU. The same phone in this
 *      reading needed 467 ms merely to OPEN the graph. A device that loads the
 *      model in 467 ms and then renders 77 s of speech in 774 ms did not render
 *      it.
 *   2. The instrument cannot print it. Every RTF in this file and in
 *      `diagnostic-log.js` is formatted to two decimals, so ANY value below
 *      0.005 prints as `0.00` and every value below 0.01 is indistinguishable
 *      from a rounding artefact on the screen a founder reads it off. A number
 *      the report cannot render as distinct from zero is not a measurement, and
 *      the gate should say so rather than let the reader do the arithmetic.
 *
 * It is two orders of magnitude BELOW the tightest ceiling (0.80), so it can
 * never turn a genuine pass into a failure: there is no engine this instrument
 * would both believe and reject. */
export const RTF_FLOOR = 0.01;

/** Why a probe could not produce a measurement. A CLOSED VOCABULARY, the same
    discipline `diagnostic-log.js`'s `data` entry applies to its own `why=`
    codes: these strings are read off a phone screen and pasted into an issue,
    so they must mean exactly one thing each and never be a sentence somebody
    rewrote.

      no-bridge              nothing to ask — a browser tab, or a shell with no
                             plugin. Expected, not a fault.
      passage-missing        the passage JSON was not handed to the probe.
      passage-empty          it parsed but carries no lines.
      passage-unphonemized   lines exist, `ids` is null on at least one of them.
                             TODAY'S STATE — see the passage file's own note.
      model-absent           the native half found no Kokoro weights bundled.
      engine-absent          weights present, no runtime registered to run them
                             (K-04's job; the probe's own seam is in place).
      synthesis-failed       weights present, runtime loaded, and NOT ONE LINE
                             produced audio. #685's zero, said out loud: the
                             native half carries its own `detail` (which of
                             `session-absent`, `inference-threw`, `no-output`,
                             `zero-samples`, `non-finite`, `silent` fired
                             first) so the next run names the fault instead of
                             implying a miracle.
      refused                the native half answered `ok: false` for a reason
                             of its own, carried through verbatim.
      threw                  the call rejected. Carries the error's NAME
                             (`nameOf`: `TypeError`, a Capacitor code) and
                             never its message. A Capacitor `UNIMPLEMENTED`
                             is not `threw`: it is an older shell with no
                             probe method, which `foray-tts.js` reports as
                             `engine-absent`.
      coreml-unavailable     KV-R2's pass B only: this ORT build could not
                             register the CoreML execution provider at all
                             (none compiled in, or the append threw), so the
                             pass did not run. `loadErr` carries ORT's code
                             when the append threw. The CPU pass is unaffected. */
export const PROBE_REASONS = Object.freeze([
  "no-bridge", "passage-missing", "passage-empty", "passage-unphonemized",
  "model-absent", "engine-absent", "synthesis-failed", "refused", "threw",
  "coreml-unavailable",
]);

/** KV-R2's passes, in the order a run makes them: ORT's CPU provider, then
    the CoreML EP (MLProgram, all compute units). Each record's `pass` is one
    of these; iOS's `KokoroProbePass` holds the same two words. */
export const PROBE_PASSES = Object.freeze(["cpu", "coreml"]);

/** Where a run the system KILLED had got to (KV-R2's stop rule), as the next
    run reports it: `load` while the pass's session was being built (the
    CoreML pass compiles the graph there), `synth` once it was open. */
export const KILLED_STAGES = Object.freeze(["load", "synth"]);

/** How much a record's `provider` knows. `requested`: the EP was asked for
    and the runtime cannot report which nodes it took (iOS's `coreml` pass on
    ORT 1.20.0). A provider with no basis is the one that ran. */
export const PROVIDER_BASES = Object.freeze(["requested"]);

/** Why ONE line produced no audio, as the native halves name it. A closed set
    for the same reason `PROBE_REASONS` is one — it is read off a screen — but
    a separate one, because these are sub-findings of a run that otherwise
    worked, not reasons the run could not happen.

      session-absent   the engine loaded no ONNX session; every line was
                       skipped before any stopwatch started. This is the one
                       that costs nothing and therefore reads as zero.
      inference-threw  ORT raised. The message is in the device log, which the
                       founder cannot read — so the CODE has to travel.
      no-output        the graph ran and named no output tensor.
      zero-samples     the output tensor was empty, or an unexpected shape the
                       sample counter refused to guess at.
      non-finite       the graph ran and returned samples, and at least one of
                       them was NaN or Infinity (L04). A GitHub macos-14 run of
                       this model did exactly that on two lines of four; a
                       sample COUNT would have called it audio.
      silent           every finite sample's magnitude was below 1e-4: a
                       buffer of the right length that says nothing (L04).

    A `non-finite` or `silent` line counts as a synthesis failure and adds 0 s
    of audio, so an RTF is never computed over garbage. */
export const SYNTH_REASONS = Object.freeze([
  "session-absent", "inference-threw", "no-output", "zero-samples", "non-finite", "silent",
]);

/** WHY ORT FAILED, as a token (L03, L36). The ORT C API's `OrtErrorCode`
    values 1..11, in that order, plus the two a phone can hit that ORT does
    not number: `oom` (Android's OutOfMemoryError) and `other` (anything else,
    or a code outside 1..11). Both native halves map the runtime's own code to
    one of these and NEVER carry the message: an ORT file error can embed the
    app-container path, and a path is not something this record holds.

    The same set answers `loadErr` — the cold `makeSession()` failing is the
    same runtime saying the same things, one step earlier. */
export const ORT_CODES = Object.freeze([
  "fail", "invalid-argument", "no-such-file", "no-model", "engine-error", "runtime-exception",
  "invalid-protobuf", "model-loaded", "not-implemented", "invalid-graph", "ep-fail", "oom", "other",
]);

/** Where in one line's inference the first failure happened: building the
    three input tensors, `session.run`, or reading the output tensor back. */
export const ORT_STAGES = Object.freeze(["input", "run", "output"]);

/** One token per CHUNK since KV-R2 (per line before it), in passage order
    (L05). `threw` is `inference-threw`, `zero` is `zero-samples`, `nan` is
    `non-finite`, `skip` is `session-absent`; the others are their own
    reason. Short on purpose — the ring line prints them comma-joined, fifteen
    of them to the chunked passage. The native key keeps its name
    (`lineOutcomes`, `nonFiniteLines`, `lines`): each "line" is now a chunk. */
export const LINE_OUTCOMES = Object.freeze(["ok", "threw", "no-output", "zero", "nan", "silent", "skip"]);

/** `ProcessInfo.thermalState` / `PowerManager.getCurrentThermalStatus()`,
    folded to iOS's four words (L10). */
export const THERMAL_STATES = Object.freeze(["nominal", "fair", "serious", "critical"]);

/** The model each platform's probe bundles, as `tools/mobile/fetch-models.mjs`
    pins it (D13): the streamed length and the first 8 hex digits of its
    SHA-256 (L08). iOS carries the fp32 export since KV-R2, Android q8f16. A
    phone that reports anything else loaded a different file than the one
    every other number here was measured against — the Android cache check is
    length-only, so this is where a stale extraction would first show. A test
    reads each platform's bundled model pin and holds the two in step. */
export const KOKORO_MODEL_PINS = Object.freeze({
  ios: Object.freeze({ bytes: 325532232, sha8: "8fbea51e" }),
  android: Object.freeze({ bytes: 86033585, sha8: "04c658ae" }),
});

/** An error's NAME, never its message (L12). Takes `e.code` (Capacitor's
    `UNIMPLEMENTED`, `UNAVAILABLE`) and then `e.name` (`TypeError`), and
    admits one only if it is a bare ASCII identifier of at most 40 characters
    — the same shape discipline `diagnostic-log.js`'s `errorNameOf` applies.
    Anything else is `null`: a message that happens to be one word is still
    not admitted by accident, because a message carries spaces or punctuation
    long before it carries a secret. */
export const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export function nameOf(e) {
  if (!e || (typeof e !== "object" && typeof e !== "function")) return null;
  for (const v of [e.code, e.name]) {
    if (typeof v === "string" && ERROR_NAME_RE.test(v)) return v;
  }
  return null;
}

/* ---------- the passage ---------- */

/** The passage's total audio seconds at narration-craft.md §2a's planning rate
    — the denominator of RTF until the engine reports a real rendered length.
    Sums `est_sec`, falling back to `chars / 17` for a line that carries none,
    so a hand-edited passage cannot silently produce an RTF divided by zero. */
export const CHARS_PER_SEC = 17;

export function passageSeconds(passage) {
  const lines = (passage && Array.isArray(passage.lines)) ? passage.lines : [];
  let total = 0;
  for (const l of lines) {
    if (!l) continue;
    if (Number.isFinite(l.est_sec) && l.est_sec > 0) { total += l.est_sec; continue; }
    const chars = Number.isFinite(l.chars) ? l.chars : (typeof l.text === "string" ? l.text.length : 0);
    if (chars > 0) total += chars / CHARS_PER_SEC;
  }
  return total;
}

/**
 * Why this passage cannot be probed, or `null` when it can.
 *
 * ORDER MATTERS AND IS PART OF THE CONTRACT: "no passage at all" and "a
 * passage nobody has phonemized" are different findings and a founder reading
 * the record has to be able to tell them apart. `passage-unphonemized` is
 * checked LAST because it is the expected answer today, and a reader who sees
 * it knows the file was found, parsed, and is simply waiting on
 * `tools/narration/phonemize.py`.
 */
export function passageProblem(passage) {
  if (!passage || typeof passage !== "object") return "passage-missing";
  const lines = Array.isArray(passage.lines) ? passage.lines : null;
  if (!lines || lines.length === 0) return "passage-empty";
  for (const l of lines) {
    if (!l) return "passage-unphonemized";
    /* KV-R2: a line is phonemized when it carries sentence `chunks`, every
       one with ids (the shipped passage), or, from before KV-R2, a whole-line
       `ids` — the same two shapes both native halves accept. */
    if (Array.isArray(l.chunks) && l.chunks.length > 0) {
      if (!l.chunks.every((c) => c && Array.isArray(c.ids) && c.ids.length > 0)) return "passage-unphonemized";
      continue;
    }
    if (!Array.isArray(l.ids) || l.ids.length === 0) return "passage-unphonemized";
  }
  return null;
}

/* ---------- shapes ---------- */

/* Every field below that is not a number the page computed is admitted BY
   SHAPE or from a closed set, and is `null` otherwise. The native halves are
   written to send only these shapes; this is the second lock, because the
   record is pasted into an issue and a path or a device name that slipped
   through a native change would be pasted with it. */
const TOKEN_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ORT_OP_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ORT_VERSION_RE = /^[0-9][0-9.]{0,15}$/;
const SHA8_RE = /^[0-9a-f]{8}$/;
const SYNTH_REASON_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_LINE_OUTCOMES = 32; // fifteen chunks on the KV-R2 passage, with room

const oneOf = (set, v) => (typeof v === "string" && set.includes(v) ? v : null);
const shaped = (re, v) => (typeof v === "string" && re.test(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);

/** The per-line outcomes as one comma-joined string, or `null`. The WHOLE
    list is refused if any entry is outside `LINE_OUTCOMES`: a list with a
    hole in it would print a passage of three lines as if it were four. */
function lineOutcomesOf(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const list = v.slice(0, MAX_LINE_OUTCOMES);
  if (!list.every((t) => LINE_OUTCOMES.includes(t))) return null;
  return list.join(",");
}

/** `ok` when both halves of the platform's pin match, `mismatch` when either
    one was reported and differs, `null` when neither was reported (an older
    shell). A record that names no platform is held to whichever pin it
    matches — it cannot say which it should have loaded. */
export function modelPinOf(modelBytes, modelSha8, platform = null) {
  const haveBytes = modelBytes != null;
  const haveSha = modelSha8 != null;
  if (!haveBytes && !haveSha) return null;
  const pins = KOKORO_MODEL_PINS[platform] ? [KOKORO_MODEL_PINS[platform]] : Object.values(KOKORO_MODEL_PINS);
  const matches = (pin) => (!haveBytes || modelBytes === pin.bytes) && (!haveSha || modelSha8 === pin.sha8);
  if (!pins.some(matches)) return "mismatch";
  return haveBytes && haveSha ? "ok" : null;
}

/** Whether a pass's audio was finite (KV-R2): `false` when any chunk held a
    NaN or an Infinity, `true` when audio was rendered and none did, `null`
    when nothing rendered or the shell did not count — "we could not tell" is
    never "yes". */
export function finiteOf(nonFiniteChunks, renderedSec) {
  if (Number.isInteger(nonFiniteChunks) && nonFiniteChunks > 0) return false;
  if (Number.isInteger(nonFiniteChunks) && Number.isFinite(renderedSec) && renderedSec > 0) return true;
  return null;
}

/* ---------- the arithmetic ---------- */

/**
 * Real-time factor: synthesis wall time over audio produced. 0.5 means the
 * phone renders twice as fast as a listener hears it; 1.0 is break-even; above
 * 1.0 the narration cannot keep up even with a full segment of lead.
 *
 * `null` — never 0, never Infinity — when either half is missing or
 * non-positive. Zero is a real RTF value (an impossibly fast render) and
 * Infinity formats as a number a reader will try to interpret; "we did not
 * measure this" has to be its own answer. Same reasoning
 * `diagnostic-log.js`'s `ms()` applies to a null duration.
 */
export function realTimeFactor(synthMs, audioSec) {
  if (!Number.isFinite(synthMs) || synthMs < 0) return null;
  if (!Number.isFinite(audioSec) || audioSec <= 0) return null;
  return (synthMs / 1000) / audioSec;
}

/**
 * Whether an RTF is a number an engine could have produced, or debris.
 *
 * `null` — the absent case — is NOT plausible and never was; `probeVerdict`
 * has failed it as `rtf-not-measured` since K-01. What is new here is the
 * bottom: see `RTF_FLOOR`. Anything at or below the floor is a failed
 * measurement wearing a number, and #685 is the proof that the difference
 * matters — `0.00` was reported as a reading, and 0.00 beats every ceiling
 * this card has.
 */
export function rtfIsPlausible(rtf) {
  return Number.isFinite(rtf) && rtf >= RTF_FLOOR;
}

/** Bytes as whole megabytes (1024-based, like every other size in this repo —
    `prepare-webdir.mjs`'s `MAX_BYTES`), or `null` for an absent reading. */
export function toMegabytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * K-01's go/no-go rule applied to a finished record.
 *
 * `age` is "newest" or "oldest" and picks the RTF ceiling; anything else is
 * treated as "oldest", the LOOSER bound, because guessing a device is new and
 * failing it on 0.8 would be the instrument inventing a no-go. The caller
 * (the founder, in the drawer) says which phone this is.
 *
 * A missing reading is NOT a pass. `rtfWarm == null` fails with
 * `rtf-not-measured`: "we could not measure it" must never read as "it met the
 * bar", which is exactly the direction a go/no-go rule is most likely to be
 * misread in.
 *
 * AND NEITHER IS AN IMPOSSIBLE ONE (#685). A reading at or below `RTF_FLOOR`
 * fails as `rtf-below-floor`. Until this was added the gate was one-sided: it
 * caught the reading that was missing and waved through the reading that was
 * zero, and zero is what a probe reports when synthesis never ran — the exact
 * case the gate exists for, arriving as the best score the card can record.
 */
export function probeVerdict(record, age = "oldest") {
  const r = record || {};
  const ceiling = age === "newest" ? GO_RTF_NEWEST : GO_RTF_OLDEST;
  const failures = [];
  if (!Number.isFinite(r.rtfWarm)) failures.push("rtf-not-measured");
  else if (!rtfIsPlausible(r.rtfWarm)) failures.push(`rtf-below-floor ${r.rtfWarm.toFixed(2)} <= ${RTF_FLOOR} — nothing rendered`);
  else if (r.rtfWarm > ceiling) failures.push(`rtf-warm ${r.rtfWarm.toFixed(2)} > ${ceiling}`);
  if (!Number.isFinite(r.peakMemoryMb)) failures.push("peak-memory-not-measured");
  /* The 400 MB ceiling is the q8f16 era's (K-01). A probe-v2 PASS record is
     judged by §6a instead, where peak memory is RECORDED, NOT GATED: fp32's
     325 MB of weights alone would fail it, and the reading sets KV-05's memory
     bound rather than being held to the old one. It still has to be measured. */
  else if (r.pass == null && r.peakMemoryMb > GO_PEAK_MEMORY_MB) failures.push(`peak-memory ${r.peakMemoryMb} MB > ${GO_PEAK_MEMORY_MB} MB`);
  if (r.lockedScreenCompleted !== true) failures.push("locked-screen-not-proven");
  /* KV-R2: A PASS WITH A NON-FINITE CHUNK IS NEVER A PASS, whatever its RTF.
     The finite chunks' RTF is real, but a voice that goes NaN on one sentence
     in fifteen is a voice that drops a sentence in fifteen (§6a: "only a
     finite pass counts"). */
  if (r.finite === false) {
    const k = Number.isInteger(r.nonFiniteLines) ? r.nonFiniteLines : "some";
    failures.push(`non-finite ${k} of ${r.lines ?? "?"} chunks`);
  }
  /* AND NEITHER IS A PASS THAT DROPPED A CHUNK ANY OTHER WAY. A chunk that
     threw, came back silent or empty is a sentence the listener would not
     hear; its audio is never counted (the natives zero it), so the RTF over
     the rest can look fine while the voice skips. Non-finite chunks are
     already named above and are not counted twice. */
  const dropped = (Number.isInteger(r.synthFailures) ? r.synthFailures : 0)
    - (Number.isInteger(r.nonFiniteLines) ? r.nonFiniteLines : 0);
  if (dropped > 0) failures.push(`chunks-failed ${dropped} of ${r.lines ?? "?"} (threw, silent or empty)`);
  return { go: failures.length === 0, ceiling, failures };
}

/* ---------- the record ---------- */

/**
 * Fold one native answer plus the page's own stopwatch into the flat record
 * the diagnostic ring stores and `formatProbeReport` prints.
 *
 * FLAT ON PURPOSE. `DiagnosticLog.record` serialises whatever it is given on
 * every write (see that file's cost note), so a nested native payload would be
 * re-serialised on each of the ring's next 200 writes. The native blob is
 * reduced here, once, to the named fields K-01 asks for and nothing else.
 *
 * `elapsedMs` is the PAGE's measurement — wall clock around the whole call —
 * and is kept even when the native side reports its own `synthMs`, because the
 * two answer different questions: the native number is synthesis, this one
 * includes the bridge hop a listener also waits through.
 *
 * ── THE DIVISOR, WHICH IS WHERE #685's ZERO CAME FROM ─────────────────────
 * Both native halves document their failure contract as "returns (0 ms, 0 s),
 * which `kokoro-probe.js` turns into an unmeasured RTF". That was FALSE, and
 * it is the whole bug. They each computed the rendered `audioSec` line by line
 * — and then dropped it on the floor: iOS summed it into a local that was
 * never written to the result, Android never even read `out[1]`. Neither
 * number ever crossed the bridge. So this function divided by the only
 * `audioSec` it had, `passageSeconds(passage)` — the PLANNING ESTIMATE, 77.4 s,
 * positive no matter what the engine did — and `realTimeFactor(0, 77.4)` is
 * not `null`, it is a perfectly good `0`. The zero was never the engine
 * claiming to be infinitely fast. It was the instrument dividing a synthesis
 * time of zero by an audio length that was never measured.
 *
 * So: RTF is computed against the RENDERED seconds whenever the native half
 * reports them, and PER PHASE. Zero rendered seconds now means `null`, which
 * `probeVerdict` has always failed. The estimate survives as `passageSec` and
 * is used as the divisor only for a shell whose plugin predates this change,
 * where `RTF_FLOOR` is the backstop instead.
 *
 * PER PHASE also fixes an arithmetic error that was quietly deflating every
 * warm number: `synthWarmMs` is the sum over lines 2..N, but it was divided by
 * the WHOLE passage including line 1 — understating warm RTF by the cold
 * line's share of the audio (about a quarter, on the shipped four-line
 * passage). A go rule stated on the warm figure alone cannot be fed a warm
 * figure that is 25% optimistic.
 */
export function summarizeProbe({ native = null, elapsedMs = null, audioSec = null, reason = null } = {}) {
  const n = native || {};
  const platform = oneOf(["ios", "android"], n.platform);
  const synthWarmMs = Number.isFinite(n.synthWarmMs) ? n.synthWarmMs : null;
  const synthColdMs = Number.isFinite(n.synthColdMs) ? n.synthColdMs : null;
  const passageSec = Number.isFinite(audioSec) ? audioSec : null;

  /* `Number.isFinite`, NOT `> 0`: a reported zero is the finding and must not
     fall back to the estimate. Absent — an older shell — falls back. */
  const reportedCold = Number.isFinite(n.audioColdSec) ? n.audioColdSec : null;
  const reportedWarm = Number.isFinite(n.audioWarmSec) ? n.audioWarmSec : null;
  const rendered = reportedCold != null || reportedWarm != null;
  const coldSec = rendered ? (reportedCold ?? 0) : passageSec;
  const warmSec = rendered ? (reportedWarm ?? 0) : passageSec;
  const totalSec = rendered ? (reportedCold ?? 0) + (reportedWarm ?? 0) : passageSec;

  return {
    engine: PROBE_ENGINE,
    ok: reason == null,
    reason: reason ?? null,
    provider: typeof n.provider === "string" ? n.provider : null,
    model: typeof n.model === "string" ? n.model : null,
    modelLoadColdMs: Number.isFinite(n.modelLoadColdMs) ? n.modelLoadColdMs : null,
    modelLoadWarmMs: Number.isFinite(n.modelLoadWarmMs) ? n.modelLoadWarmMs : null,
    synthColdMs,
    synthWarmMs,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    /* The seconds the RTFs below were actually divided by, and where they came
       from. `audioFrom` is not decoration: "over 77.4s" means one thing when
       the phone rendered 77.4 s and another when nobody counted a sample, and
       #685 is what it costs to print the two the same way. */
    audioSec: Number.isFinite(totalSec) ? totalSec : null,
    audioColdSec: Number.isFinite(coldSec) ? coldSec : null,
    audioWarmSec: Number.isFinite(warmSec) ? warmSec : null,
    audioFrom: rendered ? "rendered" : "estimated",
    passageSec,
    synthFailures: Number.isFinite(n.synthFailures) ? n.synthFailures : null,
    /* By shape: a closed sub-code, or an error NAME from a rejected call —
       never a sentence. */
    synthReason: shaped(SYNTH_REASON_RE, n.detail),
    rtfCold: realTimeFactor(synthColdMs, coldSec),
    rtfWarm: realTimeFactor(synthWarmMs, warmSec),
    peakMemoryMb: toMegabytes(n.peakMemoryBytes),
    availableMemoryMb: toMegabytes(n.availableMemoryBytes),
    lockedScreenCompleted: n.lockedScreenCompleted === true,
    /* K-01's estimates assumed an accelerator. `true` only on iOS's `coreml`
       pass (KV-R2), once its EP was appended — and even then `providerBasis`
       says `requested`, because ORT 1.20 cannot report how much of the graph
       CoreML took. Android appends no NNAPI EP, so its `provider: "cpu"` is
       NOT a fallback that fired, it is the only path compiled. Reported
       rather than inferred so nobody reads a CPU number as an accelerated one. */
    acceleratorWired: n.acceleratorWired === true,
    batteryDeltaPct: Number.isFinite(n.batteryDeltaPct) ? n.batteryDeltaPct : null,
    batteryWindowSec: Number.isFinite(n.batteryWindowSec) ? n.batteryWindowSec : null,
    lines: Number.isFinite(n.lines) ? n.lines : null,

    /* ── Lane A (docs/diagnostics/log-gaps-2026-09-26.md): WHY it failed and
       ON WHAT. Every key is optional to the reader and `null` when an older
       shell did not send it or sent it in a shape this file does not admit.
       `diagnostic-log.js`'s `voiceProbe()` renders these by name. */
    platform,
    // L03/L36: ORT's own code for the FIRST failing line, and where it failed.
    ortCode: oneOf(ORT_CODES, n.ortCode),
    ortOp: shaped(ORT_OP_RE, n.ortOp),
    ortStage: oneOf(ORT_STAGES, n.ortStage),
    loadErr: oneOf(ORT_CODES, n.loadErr),
    // L04/L05: what each line did, and how many produced garbage.
    lineOutcomes: lineOutcomesOf(n.lineOutcomes),
    nonFiniteLines: count(n.nonFiniteLines),
    silentLines: count(n.silentLines),
    // L07/L08/L09: the runtime, the file and the phone.
    ortVersion: shaped(ORT_VERSION_RE, n.ortVersion),
    intraThreads: count(n.intraThreads),
    cores: count(n.cores),
    modelBytes: count(n.modelBytes),
    modelSha8: shaped(SHA8_RE, n.modelSha8),
    modelPin: modelPinOf(count(n.modelBytes), shaped(SHA8_RE, n.modelSha8), platform),
    device: shaped(TOKEN_RE, n.device),
    os: shaped(TOKEN_RE, n.os),
    // L10/L11/L35: heat, power and memory pressure over the run.
    thermalStart: oneOf(THERMAL_STATES, n.thermalStart),
    thermalEnd: oneOf(THERMAL_STATES, n.thermalEnd),
    lowPower: bool(n.lowPower),
    memWarn: bool(n.memWarn),
    bgAtFail: bool(n.bgAtFail),
    baseMemoryMb: toMegabytes(n.baseMemoryBytes),

    /* ── KV-R2: which pass, and whether its audio was finite. `finite` is
       derived here from the chunk count, not taken from the native side, so
       both platforms answer it by the same rule. `processPeakMb` is the
       kernel's since-launch peak; `peakMemoryMb` is THIS pass's own. A run
       the system killed is reported by the next one's first record. */
    pass: oneOf(PROBE_PASSES, n.pass),
    finite: finiteOf(count(n.nonFiniteLines), rendered ? totalSec : null),
    processPeakMb: toMegabytes(n.processPeakBytes),
    prevKilledPass: oneOf(PROBE_PASSES, n.prevKilledPass),
    prevKilledStage: oneOf(KILLED_STAGES, n.prevKilledStage),
    prevKilledChunksDone: count(n.prevKilledChunksDone),
    prevKilledPeakMb: toMegabytes(n.prevKilledPeakBytes),
    /* `requested` when the record's provider was only ASKED for: ORT 1.20.0
       cannot say which nodes the CoreML EP actually took, and ORT runs the
       rest on the CPU without a word. Null when the provider is what ran. */
    providerBasis: oneOf(PROVIDER_BASES, n.providerBasis),
  };
}

/**
 * KV-R2: the native answer as ONE RECORD PER PASS, each the shape
 * `summarizeProbe` returns plus `pass`. A shell that ran passes answers
 * `{ ok: true, passes: [...] }`; each pass is summarized on its own, its own
 * `ok`/`reason` deciding whether it measured. A refusal before any pass ran
 * (`model-absent`, a passage problem) and an older shell with no `passes`
 * are ONE record, exactly as before.
 *
 * A pass's reason is admitted from `PROBE_REASONS` or becomes `refused`, the
 * rule `runKokoroProbe` applies to a whole answer. `elapsedMs` is the page's
 * clock around the whole call, so it is shared by every pass it covered.
 */
export function summarizePasses({ native = null, elapsedMs = null, audioSec = null, reason = null } = {}) {
  const passes = reason == null && native && Array.isArray(native.passes) ? native.passes : null;
  if (!passes || passes.length === 0) {
    return [summarizeProbe({ native, elapsedMs, audioSec, reason })];
  }
  return passes.map((p) => {
    const pass = p && typeof p === "object" ? p : {};
    const code = pass.ok === true
      ? null
      : (typeof pass.reason === "string" && PROBE_REASONS.includes(pass.reason) ? pass.reason : "refused");
    return summarizeProbe({ native: { platform: native.platform, ...pass }, elapsedMs, audioSec, reason: code });
  });
}

/** One line per field, in the order a founder reads them out. Used by the
    drawer's own status text; the ring's own one-liner is `lineFor`'s
    `voiceProbe` case in `diagnostic-log.js`, which is deliberately terser
    because it shares a screen with 199 other rows. */
export function formatProbeReport(record) {
  if (Array.isArray(record)) return record.map((r) => formatProbeReport(r)).join("\n\n");
  const r = record || {};
  const n = (v, unit = "") => (v == null ? "—" : `${v}${unit}`);
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
  if (!r.ok) {
    /* The sub-reason rides along when there is one: `synthesis-failed` is
       useless on its own and decisive as `synthesis-failed/session-absent`. */
    const detail = r.synthReason ? `/${r.synthReason}` : "";
    /* A refusal with nothing else to say stays ONE line (an `engine-absent`
       under six dashes buries the why). A refusal from a phone that loaded
       the model DOES have more to say — what ORT said, what each line did,
       on what hardware — and the 2026-09-26 paste's bare `inference-threw`
       with none of it is the reading Lane A exists for. */
    return [`voice probe${passTag(r)}: could not measure (${r.reason ?? "unknown"}${detail})`, ...probeContextLines(r)].join("\n");
  }
  /* "rendered" vs "estimated" is the difference between an RTF and a ratio
     (see `summarizeProbe`), so it is printed next to the seconds it qualifies
     rather than left for the reader to assume. */
  const from = r.audioFrom === "rendered" ? "rendered" : "estimated";
  return [
    `voice probe${passTag(r)}: ${r.engine} model ${n(r.model)} provider ${n(r.provider)}${basisTag(r)}` +
      (r.acceleratorWired ? "" : " (CPU only — no accelerator wired)"),
    `  model load    cold ${n(r.modelLoadColdMs, " ms")}  warm ${n(r.modelLoadWarmMs, " ms")}`,
    `  synthesis     cold ${n(r.synthColdMs, " ms")}  warm ${n(r.synthWarmMs, " ms")}  over ${n(r.audioSec, " s")} of ${from} audio`,
    `  RTF           cold ${f2(r.rtfCold)}  warm ${f2(r.rtfWarm)}` +
      (rtfIsPlausible(r.rtfWarm) ? "" : `  — BELOW THE ${RTF_FLOOR} FLOOR, not a measurement`),
    `  peak memory   ${n(r.peakMemoryMb, " MB")}  (headroom ${n(r.availableMemoryMb, " MB")})`,
    `  locked screen ${r.lockedScreenCompleted ? "completed the passage" : "did NOT complete"}`,
    `  battery       ${n(r.batteryDeltaPct, "%")} over ${n(r.batteryWindowSec, " s")}`,
    `  lines failed  ${n(r.synthFailures)}${r.synthReason ? ` (${r.synthReason})` : ""}`,
    ...probeContextLines(r),
  ].join("\n");
}

/** ` [cpu]` / ` [coreml]` after "voice probe", or nothing for a one-pass shell. */
function passTag(r) {
  return r.pass ? ` [${r.pass}]` : "";
}

/** ` (requested — …)` after a provider the runtime could not confirm. */
function basisTag(r) {
  return r.providerBasis === "requested"
    ? " (requested — ORT 1.20 cannot say which nodes it took; the rest ran on the CPU)"
    : "";
}

/** Where a killed run died, in words: `load` (the session was being built —
    the CoreML compile) or `after N chunks`. */
function killedWhere(stage, done) {
  if (stage === "load") return "during its load";
  return `after ${done ?? "?"} chunks`;
}

/** Lane A's lines for the drawer, each printed ONLY when its data arrived, so
    a record from an older shell prints exactly what it printed before. */
function probeContextLines(r) {
  const yn = (v) => (v === true ? "y" : v === false ? "n" : "—");
  const mb = (v) => (v == null ? "—" : `${v} MB`);
  const out = [];
  /* KV-R2: finiteness first — a non-finite pass is not a pass, whatever the
     numbers above it say. */
  if (r.finite != null) {
    out.push(r.finite
      ? `  finite        yes (no rendered chunk held NaN/Infinity)`
      : `  finite        NO — ${r.nonFiniteLines ?? "?"} of ${r.lines ?? "?"} chunks held NaN/Infinity`);
  }
  if (r.prevKilledPass != null) {
    out.push(`  LAST RUN KILLED in the ${r.prevKilledPass} pass, ${killedWhere(r.prevKilledStage, r.prevKilledChunksDone)}, peak ${mb(r.prevKilledPeakMb)}`);
  }
  if (r.ortVersion != null || r.cores != null || r.intraThreads != null) {
    const threads = r.intraThreads == null ? "—" : r.intraThreads === 0 ? "auto" : r.intraThreads;
    out.push(`  ORT           ${r.ortVersion ?? "—"} ${r.provider ?? "cpu"} threads=${threads} cores=${r.cores ?? "—"}`);
  }
  if (r.ortCode != null || r.loadErr != null) {
    const parts = [];
    if (r.ortCode != null) {
      parts.push(r.ortCode);
      if (r.ortOp != null) parts.push(`op=${r.ortOp}`);
      if (r.ortStage != null) parts.push(`at=${r.ortStage}`);
    }
    if (r.loadErr != null) parts.push(`load=${r.loadErr}`);
    if (r.bgAtFail != null) parts.push(`background=${yn(r.bgAtFail)}`);
    out.push(`  failure       ${parts.join(" ")}`);
  }
  if (r.lineOutcomes != null) {
    const bad = [];
    if (r.nonFiniteLines > 0) bad.push(`non-finite ${r.nonFiniteLines}`);
    if (r.silentLines > 0) bad.push(`silent ${r.silentLines}`);
    out.push(`  lines         ${r.lineOutcomes}${bad.length ? ` (${bad.join(", ")})` : ""}`);
  }
  if (r.modelBytes != null || r.modelSha8 != null) {
    const pin = r.modelPin === "ok" ? "ok" : r.modelPin === "mismatch" ? "MISMATCH" : "—";
    out.push(`  model file    ${r.modelBytes ?? "—"} B sha ${r.modelSha8 ?? "—"} (pin ${pin})`);
  }
  if (r.device != null || r.os != null || r.thermalStart != null || r.lowPower != null) {
    const osName = r.platform === "android" ? "Android" : r.platform === "ios" ? "iOS" : "";
    const os = [osName, r.os].filter(Boolean).join(" ") || "—";
    out.push(`  device        ${r.device ?? "—"} ${os}  thermal ${r.thermalStart ?? "—"}>${r.thermalEnd ?? "—"}  low power ${yn(r.lowPower)}`);
  }
  if (r.baseMemoryMb != null || r.memWarn != null) {
    out.push(`  memory        base ${mb(r.baseMemoryMb)}  peak ${mb(r.peakMemoryMb)}  headroom ${mb(r.availableMemoryMb)}  warning ${yn(r.memWarn)}`);
  }
  return out;
}

/* ---------- the run ---------- */

/**
 * Run the probe once and return ITS RECORDS, one per pass (KV-R2): two on an
 * iOS build that ran `cpu` and `coreml`, one on Android, and one for any
 * refusal that stopped the run before a pass began. Never throws and never rejects —
 * the same contract `foray-tts.js`'s `speak()` states, for the same reason:
 * this is driven from a drawer button, and an unhandled rejection there is a
 * console line nobody has open.
 *
 * @param {object} opts
 * @param {{kokoroProbe?: Function}} opts.tts  the bridge from `tts-bridge.js`
 * @param {object} opts.passage               the parsed passage JSON
 * @param {() => number} [opts.now]           injected clock (ms)
 */
export async function runKokoroProbe({ tts = null, passage = null, now = null } = {}) {
  const clock = typeof now === "function" ? now : () => 0;
  const audioSec = passageSeconds(passage);

  const bad = passageProblem(passage);
  if (bad) return [summarizeProbe({ reason: bad, audioSec })];
  if (!tts || typeof tts.kokoroProbe !== "function") {
    return [summarizeProbe({ reason: "no-bridge", audioSec })];
  }

  const startedAt = clock();
  let native = null;
  try {
    native = await tts.kokoroProbe({ passage, engine: PROBE_ENGINE });
  } catch (e) {
    /* The error's NAME travels, never its message (L12): `synthReason` then
       reads `threw/TypeError` instead of a bare `threw`. */
    return [summarizeProbe({ native: { detail: nameOf(e) }, reason: "threw", audioSec, elapsedMs: clock() - startedAt })];
  }
  const elapsedMs = clock() - startedAt;

  if (!native || native.ok !== true) {
    /* The native side's OWN code wins over a generic `refused`, because
       "model-absent" and "engine-absent" are the two answers a founder needs
       to act on differently — one is a build that did not fetch the weights,
       the other is a build with no runtime compiled in. */
    const code = typeof native?.reason === "string" && PROBE_REASONS.includes(native.reason)
      ? native.reason
      : "refused";
    return [summarizeProbe({ native, reason: code, audioSec, elapsedMs })];
  }
  return summarizePasses({ native, audioSec, elapsedMs });
}
