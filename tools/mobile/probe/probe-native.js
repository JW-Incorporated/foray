/* PHASE N — the NATIVE engine's lane, in the real shell (card NE-36).
 *
 * The other two phases measure the JS player and are pinned to the legacy lane
 * (`ForayEngine.modeOverride=web`). This one is launched with the override seeded
 * `native` and asks the questions only the native engine can answer on a
 * Simulator:
 *
 *   - the handshake: engineHello answers `native`, reason `override`;
 *   - the Foray: a committed 3-segment local-file Foray (`probe-native-foray.js`),
 *     built by the REAL `buildForayQueue` and sent as ONE `engineSend playForay`,
 *     so the page constructs no media element at all (its CSP has no media-src);
 *   - the WebContent kill (A-3): the workflow kills the web process mid-Foray
 *     while the app is backgrounded, WebKit reloads this page, and the reloaded
 *     page ATTACHES (engineHello again) to an engine that kept playing;
 *   - the reload clobber check (W-8): once the app is visible again the page
 *     pauses the engine, reads its shared rows (`engineRead rows`), and loads the
 *     REAL index.html — DurableStore and all — which must leave `cp_pos:*` and
 *     `cp_foray:*` exactly as they were. The workflow reads UserDefaults
 *     afterwards and `ios-ci.mjs` compares.
 *
 * THE REPORTING CHANNEL. The record goes to localStorage (for the next page on
 * this origin) AND to the Preferences plugin, i.e. `CapacitorStorage.
 * foray_probe_native` in UserDefaults — the same `defaults export` that carries
 * the rows carries the record, so the native pass needs no second WebKit
 * database read. `ios-ci.mjs native-rows` keeps only that key and the owned rows.
 *
 * NOTHING HERE PLAYS AUDIO AND NOTHING HERE TOUCHES NOW PLAYING. The engine owns
 * both; the assertions are that no WebKit publish line, no
 * `ForayAudio.setNowPlaying reached` and no HTMLMediaElement appear.
 */

import { createNativeEngine } from "./player/native-engine.js";
import { buildForayQueue } from "./player/foray-queue.js";
import { PROBE_FORAY_ID, probeForay, probeEpisode } from "./probe-native-foray.js";

const KEY = "foray_probe_native";
/** How long the page stays on the restored, visible app before the finale, so
    the attach has settled and a screenshot can see it. */
const SETTLE_MS = 4000;
/** Between the pause and the rows read: the pause's own row write lands first. */
const PAUSE_SETTLE_MS = 2000;
const TRAIL_MAX = 80;

/* ---- the media-element counter, installed before anything else runs ---- */
const media = { constructed: 0 };
try {
  const NativeAudio = window.Audio;
  if (typeof NativeAudio === "function") {
    const Counted = function (...args) { media.constructed++; return new NativeAudio(...args); };
    Counted.prototype = NativeAudio.prototype;
    window.Audio = Counted;
  }
  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (name, ...rest) {
    if (/^(audio|video)$/i.test(String(name))) media.constructed++;
    return create.call(this, name, ...rest);
  };
} catch (_) { /* the count then reads as unknown, never as zero */ media.constructed = null; }

function mediaCount() {
  if (media.constructed == null) return null;
  let inDom = 0;
  try { inDom = document.querySelectorAll("audio,video").length; } catch (_) {}
  return media.constructed + inDom;
}

/* ---- the record ---- */
let rec;
try { rec = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { rec = null; }
if (!rec || typeof rec !== "object" || rec.phase !== "native") {
  rec = { phase: "native", v: 1, stage: "booting", boots: [], errors: [], trail: [], restarts: 0 };
}
const out = document.getElementById("out");

function save() {
  rec.savedAtWall = Date.now();
  const text = JSON.stringify(rec);
  try { localStorage.setItem(KEY, text); } catch (_) {}
  try { if (out) out.textContent = text.slice(0, 4000); } catch (_) {}
  try { console.log("FORAY_PROBE_NATIVE " + text.slice(0, 2000)); } catch (_) {}
  const cap = window.Capacitor;
  if (cap && typeof cap.nativePromise === "function") {
    return Promise.resolve()
      .then(() => cap.nativePromise("Preferences", "set", { key: KEY, value: text }))
      .catch((e) => { rec.prefsError = String((e && e.message) || e); });
  }
  return Promise.resolve();
}

function fail(where, e) {
  rec.errors.push({ where, message: String((e && e.message) || e).slice(0, 200), at: Date.now() });
  if (rec.errors.length > 20) rec.errors.splice(0, rec.errors.length - 20);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compact(s) {
  if (!s || typeof s !== "object") return null;
  return {
    at: Date.now(), seq: s.seq, mode: s.mode, index: s.index, itemId: s.itemId, state: s.state,
    running: s.running, inSeamGap: s.inSeamGap, pos: typeof s.positionSec === "number" ? Math.round(s.positionSec * 10) / 10 : null,
    ended: s.ended, session: s.session,
  };
}

function remember(s) {
  const c = compact(s);
  if (!c) return;
  const last = rec.trail[rec.trail.length - 1];
  if (last && last.seq === c.seq) return;
  rec.trail.push(c);
  if (rec.trail.length > TRAIL_MAX) rec.trail.splice(0, rec.trail.length - TRAIL_MAX);
  rec.lastSnapshot = c;
}

/* ---- visibility: the hidden window the verdict needs (> 90 s) ---- */
function onVisibility() {
  const hidden = document.visibilityState === "hidden";
  if (hidden && rec.hiddenAt == null && (rec.stage === "playing")) {
    rec.hiddenAt = Date.now();
    save();
  } else if (!hidden && rec.hiddenAt != null && rec.visibleAt == null) {
    rec.visibleAt = Date.now();
    save();
    maybeFinale();
  }
}
document.addEventListener("visibilitychange", onVisibility);

const engine = createNativeEngine({ pageBuild: "probe-native" });
engine.subscribe((ev) => { if (ev && ev.type === "snapshot") remember(ev.snapshot); });

function helloOf(d) {
  if (!d) return null;
  return { mode: d.mode, reason: d.reason, engine: d.engine || null, at: Date.now() };
}

async function start() {
  rec.audioBase = typeof window.FORAY_PROBE_AUDIO_BASE === "string" ? window.FORAY_PROBE_AUDIO_BASE : null;
  const d = await engine.hello();
  rec.hello = helloOf(d);
  const s0 = engine.latest();
  if (s0) remember(s0.snapshot);
  if (!d || d.mode !== "native") {
    rec.stage = "not-native";
    await save();
    return;
  }
  if (!rec.audioBase) {
    rec.stage = "no-audio-base";
    await save();
    return;
  }
  const report = buildForayQueue(probeForay(rec.audioBase), { isLocalFile: true, allowAdPad: false });
  const { items, ...buildReport } = report;
  rec.forayItems = items.length;
  rec.foraySkipped = report.skipped.length;
  const args = {
    forayId: report.id || PROBE_FORAY_ID, title: report.title, items, buildReport,
    isLocalFile: true, allowAdPad: false, voiceId: null,
  };
  const reply = await engine.send("playForay", args, { source: "tap" });
  rec.play = { cmd: "playForay", ok: reply.ok === true, reason: reply.reason || null, at: Date.now() };
  if (reply.snapshot) remember(reply.snapshot);
  if (!reply.ok && reply.reason === "capability-off") {
    /* This binary does not advertise `foray` yet (NE-37 flips it). Play one
       episode instead so the lane, Now Playing, A-3 and W-8 are still measured;
       the seam assertion reads no-coverage, never a pass. */
    const ep = await engine.send("playEpisode", probeEpisode(rec.audioBase), { source: "tap" });
    rec.fallback = { cmd: "playEpisode", ok: ep.ok === true, reason: ep.reason || null, at: Date.now() };
    if (ep.snapshot) remember(ep.snapshot);
  }
  rec.stage = "playing";
  await save();
  if (document.visibilityState === "hidden") onVisibility();
}

/* A reboot of THIS page with a Foray already running: WebKit reloaded it after
   the workflow killed the WebContent process (A-3). Attach, never restore. */
async function restarted() {
  rec.restarts = (rec.restarts || 0) + 1;
  rec.stage = "restarted";
  rec.restartedAt = Date.now();
  rec.restartVisibility = document.visibilityState;
  await save();
  const d = await engine.hello();
  rec.helloAfterRestart = helloOf(d);
  const s = engine.latest();
  if (s) {
    remember(s.snapshot);
    rec.snapshotAfterRestart = compact(s.snapshot);
  }
  await save();
  if (document.visibilityState === "visible" && rec.hiddenAt != null && rec.visibleAt == null) {
    rec.visibleAt = Date.now();
    await save();
  }
  maybeFinale();
}

let finaleStarted = false;
async function maybeFinale() {
  if (finaleStarted) return;
  if (document.visibilityState !== "visible" || rec.hiddenAt == null || rec.visibleAt == null) return;
  if (rec.stage !== "playing" && rec.stage !== "restarted") return;
  finaleStarted = true;
  await sleep(SETTLE_MS);
  try {
    const snap = await engine.read("snapshot");
    if (snap) { remember(snap); rec.snapshotBeforePause = compact(snap); }
    const p = await engine.send("pause", undefined, { source: "tap" });
    rec.pauseReply = { ok: p.ok === true, reason: p.reason || null, state: p.snapshot ? p.snapshot.state : null };
    await sleep(PAUSE_SETTLE_MS);
    const rows = await engine.read("rows");
    const kept = {};
    if (rows && rows.rows && typeof rows.rows === "object") {
      for (const [k, v] of Object.entries(rows.rows)) {
        if (k.startsWith("cp_pos:") || k.startsWith("cp_foray:")) kept[k] = v;
      }
      rec.rowsBeforeReload = kept;
    } else {
      rec.rowsBeforeReload = null;
      fail("rows", "engineRead rows answered nothing readable");
    }
  } catch (e) { fail("finale", e); }
  rec.mediaElementsProbe = mediaCount();
  rec.stage = "reload-requested";
  rec.reloadRequestedAt = Date.now();
  await save();
  /* The REAL page, from the top: probe-bridge.js sees `reload-requested` and
     stays on it instead of routing back here. */
  try { location.replace("index.html"); } catch (e) { fail("reload", e); save(); }
}

(async () => {
  rec.boots.push({ at: Date.now(), visibility: document.visibilityState });
  if (rec.boots.length > 10) rec.boots.splice(0, rec.boots.length - 10);
  try {
    if (rec.stage === "booting") await start();
    else if (rec.stage === "playing" || rec.stage === "restarted") await restarted();
    else {
      /* A stage past the finale (or one that stopped early): still SAY HELLO.
         Every foreground page load owes the engine one within 10 s, or it takes
         a page-health strike and downgrades (EngineOwnership.pageHealthMs) —
         which trial run 36176555294 showed, on a page that stayed silent. */
      rec.helloLate = helloOf(await engine.hello());
      await save();
    }
  } catch (e) {
    fail("boot", e);
    await save();
  }
  /* A slow heartbeat while visible: the trail is the page's view; the engine's
     own rows in the unified log are the hidden-window evidence. */
  setInterval(async () => {
    if (document.visibilityState !== "visible") return;
    try { const s = await engine.read("snapshot"); if (s) remember(s); } catch (_) {}
    rec.mediaElementsProbe = mediaCount();
    save();
  }, 5000);
})();
