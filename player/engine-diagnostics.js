/* The engine half of 'Playback diagnostics → Copy' (docs/native-engine-plan.md
   §4.1, §10; card NE-26).

   WHAT THIS MODULE DOES. It asks the native engine for its diagnostics ring —
   ONE engineRead('diagnostics') per Copy, the whole 2,000-row file in one call
   (NE-20) — and hands it, with the page's engine decision and latest snapshot,
   to diagnostic-log.js's formatDiagnosticReport, which merges the rows into the
   page's record by wall clock and writes the engine header line. The
   formatting lives there because diagnostic-log.js imports nothing and every
   line of a paste is shaped in one file; the READ lives here because it is a
   bridge call, and a bridge call needs a bound.

   IT NEVER HANGS AND NEVER THROWS. Copy is pressed at the end of a drive, in a
   car, by someone who will not press it twice. A bridge that never answers
   (a WebView resumed mid-call, a binary without the method) must still yield
   the page's own record, so the read is bounded (ENGINE_READ_TIMEOUT_MS) and
   every failure becomes a `readError` the header prints — "engine rows not
   read (timeout)" is a finding; a spinner is not.

   WHO PLAYED, WHEN THE PAGE HAS NOT SAID. Until NE-22 wires the page's engine
   client through `engineModeReady`, and before its hello settles, there is no
   decision to report. The two answers that need no hello are the contract's
   own (decideMode: `not-ios`, `no-method`); anything else is `undecided`,
   which is exactly what it is. */

import { decideMode } from "./engine-contract.js";
import { ENGINE_PLUGIN } from "./native-engine.js";
import { formatDiagnosticReport } from "./diagnostic-log.js";

/** How long Copy waits for the engine's ring before printing the page's record
    without it. The ring is a local file read on the main thread (NE-20), a few
    hundred KB at most; three seconds is a bridge that is not answering, not a
    slow disk. */
export const ENGINE_READ_TIMEOUT_MS = 3000;

const REAL_SCHEDULER = Object.freeze({
  schedule(ms, fn) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
});

function platformOf(capacitor) {
  try { return typeof capacitor?.getPlatform === "function" ? capacitor.getPlatform() : null; } catch (_) { return null; }
}

/** Is there an engine to ask? The iOS shell with the ForayAudio plugin on the
    bridge — the same test native-engine.js's bridge makes before a hello. */
export function engineBridgePresent(capacitor) {
  if (platformOf(capacitor) !== "ios" || typeof capacitor?.nativePromise !== "function") return false;
  try {
    return typeof capacitor.isPluginAvailable === "function" ? capacitor.isPluginAvailable(ENGINE_PLUGIN) !== false : true;
  } catch (_) { return false; }
}

/** The page's engine decision for the header: the client's own when it has
    decided, else the contract's answer where no hello is needed, else
    `undecided`. */
export function pageEngineDecision({ engine = null, capacitor = null } = {}) {
  if (engine?.decision) return engine.decision;
  const platform = platformOf(capacitor);
  if (platform !== "ios" || !engineBridgePresent(capacitor)) {
    const { mode, reason } = decideMode({ platform, methodPresent: engineBridgePresent(capacitor) });
    return { mode, reason, hello: null };
  }
  return { mode: "js", reason: "undecided", hello: null };
}

/** The engine view formatDiagnosticReport takes, from what the page holds
    without asking the engine anything: the synchronous report the sheet shows
    the moment it opens. */
export function pageEngineView({ engine = null, capacitor = null } = {}) {
  let snapshot = null;
  try { snapshot = engine?.latest?.()?.snapshot ?? null; } catch (_) { snapshot = null; }
  return { decision: pageEngineDecision({ engine, capacitor }), snapshot };
}

/**
 * Read the engine's ring, once, bounded.
 *
 * @returns {Promise<{rows: object[]|null, readError: string|null}>}
 *   `rows` is the ring, or null with `readError` saying why not.
 */
export function readEngineDiagnostics({ engine, timeoutMs = ENGINE_READ_TIMEOUT_MS, scheduler = REAL_SCHEDULER } = {}) {
  if (!engine || typeof engine.read !== "function") return Promise.resolve({ rows: null, readError: "no-engine" });
  return new Promise((resolve) => {
    let done = false;
    let cancel = () => {};
    const finish = (v) => { if (!done) { done = true; cancel(); resolve(v); } };
    cancel = scheduler.schedule(timeoutMs, () => finish({ rows: null, readError: "timeout" }));
    let pending;
    try { pending = Promise.resolve(engine.read("diagnostics")); } catch (_) { pending = Promise.resolve(null); }
    pending.then(
      /* native-engine.js `read` answers null for a bridge that threw or a reply
         the contract refused; either way the ring was not read. */
      (reply) => finish(Array.isArray(reply?.rows) ? { rows: reply.rows, readError: null } : { rows: null, readError: "failed" }),
      () => finish({ rows: null, readError: "failed" }),
    );
  });
}

/**
 * The whole Copy text: the engine read once, then the page's record read AFTER
 * it, so the page rows are at least as fresh as the engine's.
 *
 * @param {object} opts
 * @param {() => object} opts.record  the page's ring (DiagnosticLog.read)
 * @param {object|null} opts.engine   a native-engine.js client, or null when there
 *                                    is no engine to ask (the web, Android)
 * @param {object|null} opts.capacitor window.Capacitor, for the decision
 * @returns {Promise<string>}
 */
export async function engineDiagnosticReport({
  record, engine = null, capacitor = null, timeoutMs = ENGINE_READ_TIMEOUT_MS, scheduler = REAL_SCHEDULER,
} = {}) {
  const view = pageEngineView({ engine, capacitor });
  if (engine) {
    const { rows, readError } = await readEngineDiagnostics({ engine, timeoutMs, scheduler });
    view.rows = rows;
    view.readError = readError;
  }
  /* NOT caught: a page ring that cannot be read rejects, and app.js falls back
     to the synchronous report, whose own catch says "could not be read" —
     an empty record here would say "nothing happened" instead. */
  const rec = typeof record === "function" ? record() : record;
  return formatDiagnosticReport(rec, view);
}
