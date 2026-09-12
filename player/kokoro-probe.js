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
      refused                the native half answered `ok: false` for a reason
                             of its own, carried through verbatim.
      threw                  the call rejected. Carries the message. */
export const PROBE_REASONS = Object.freeze([
  "no-bridge", "passage-missing", "passage-empty", "passage-unphonemized",
  "model-absent", "engine-absent", "refused", "threw",
]);

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
    if (!l || !Array.isArray(l.ids) || l.ids.length === 0) return "passage-unphonemized";
  }
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
 */
export function probeVerdict(record, age = "oldest") {
  const r = record || {};
  const ceiling = age === "newest" ? GO_RTF_NEWEST : GO_RTF_OLDEST;
  const failures = [];
  if (!Number.isFinite(r.rtfWarm)) failures.push("rtf-not-measured");
  else if (r.rtfWarm > ceiling) failures.push(`rtf-warm ${r.rtfWarm.toFixed(2)} > ${ceiling}`);
  if (!Number.isFinite(r.peakMemoryMb)) failures.push("peak-memory-not-measured");
  else if (r.peakMemoryMb > GO_PEAK_MEMORY_MB) failures.push(`peak-memory ${r.peakMemoryMb} MB > ${GO_PEAK_MEMORY_MB} MB`);
  if (r.lockedScreenCompleted !== true) failures.push("locked-screen-not-proven");
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
 */
export function summarizeProbe({ native = null, elapsedMs = null, audioSec = null, reason = null } = {}) {
  const n = native || {};
  const synthWarmMs = Number.isFinite(n.synthWarmMs) ? n.synthWarmMs : null;
  const synthColdMs = Number.isFinite(n.synthColdMs) ? n.synthColdMs : null;
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
    audioSec: Number.isFinite(audioSec) ? audioSec : null,
    rtfCold: realTimeFactor(synthColdMs, audioSec),
    rtfWarm: realTimeFactor(synthWarmMs, audioSec),
    peakMemoryMb: toMegabytes(n.peakMemoryBytes),
    availableMemoryMb: toMegabytes(n.availableMemoryBytes),
    lockedScreenCompleted: n.lockedScreenCompleted === true,
    batteryDeltaPct: Number.isFinite(n.batteryDeltaPct) ? n.batteryDeltaPct : null,
    batteryWindowSec: Number.isFinite(n.batteryWindowSec) ? n.batteryWindowSec : null,
    lines: Number.isFinite(n.lines) ? n.lines : null,
  };
}

/** One line per field, in the order a founder reads them out. Used by the
    drawer's own status text; the ring's own one-liner is `lineFor`'s
    `voiceProbe` case in `diagnostic-log.js`, which is deliberately terser
    because it shares a screen with 199 other rows. */
export function formatProbeReport(record) {
  const r = record || {};
  const n = (v, unit = "") => (v == null ? "—" : `${v}${unit}`);
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
  if (!r.ok) {
    return `voice probe: could not measure (${r.reason ?? "unknown"})`;
  }
  return [
    `voice probe: ${r.engine} model ${n(r.model)} provider ${n(r.provider)}`,
    `  model load    cold ${n(r.modelLoadColdMs, " ms")}  warm ${n(r.modelLoadWarmMs, " ms")}`,
    `  synthesis     cold ${n(r.synthColdMs, " ms")}  warm ${n(r.synthWarmMs, " ms")}  over ${n(r.audioSec, " s")} of audio`,
    `  RTF           cold ${f2(r.rtfCold)}  warm ${f2(r.rtfWarm)}`,
    `  peak memory   ${n(r.peakMemoryMb, " MB")}  (headroom ${n(r.availableMemoryMb, " MB")})`,
    `  locked screen ${r.lockedScreenCompleted ? "completed the passage" : "did NOT complete"}`,
    `  battery       ${n(r.batteryDeltaPct, "%")} over ${n(r.batteryWindowSec, " s")}`,
  ].join("\n");
}

/* ---------- the run ---------- */

/**
 * Run the probe once and return its record. Never throws and never rejects —
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
  if (bad) return summarizeProbe({ reason: bad, audioSec });
  if (!tts || typeof tts.kokoroProbe !== "function") {
    return summarizeProbe({ reason: "no-bridge", audioSec });
  }

  const startedAt = clock();
  let native = null;
  try {
    native = await tts.kokoroProbe({ passage, engine: PROBE_ENGINE });
  } catch (e) {
    return summarizeProbe({ reason: "threw", audioSec, elapsedMs: clock() - startedAt });
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
    return summarizeProbe({ native, reason: code, audioSec, elapsedMs });
  }
  return summarizeProbe({ native, audioSec, elapsedMs });
}
