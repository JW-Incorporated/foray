#!/usr/bin/env node
/* The Android playback scenarios (A-04, `docs/plans/android-assessment.md` §5.3):
 * play, background, controls, the notification, and a first-launch screenshot,
 * run against the real app on the CI emulator over Chrome DevTools and adb.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * The iPhone plays episodes and Forays on the native engine now, so nothing on
 * hardware exercises the JS player lane any more, and Android is that lane. Per
 * D-A3 no person tests Android until its own native engine is operational
 * (after A-42), so until then this file and the job that runs it,
 * `.github/workflows/android-playback.yml`, are the only witnesses that Android
 * playback works. `webview-probe.mjs` answers "did the app start". This file
 * answers "does it play, keep playing with the screen off, and obey the lock
 * screen, the headset keys and the notification".
 *
 * ── HOW IT DRIVES THE APP ────────────────────────────────────────────────────
 *
 * Through the page's own player. It builds a three-clip Foray over the committed
 * NE-25a click tracks and hands it to `window.ForayPlayer.playForay`, the call
 * the Foray page's play button makes. So the audio goes through `client.js`,
 * `queue-manager.js`, `html-audio-backend.js`, the `foray-media-session.js`
 * polyfill, `ForayAudioPlugin`, `PlaybackKeepAliveService` and Media3. A-03
 * played a bare `<audio>` element and said that was not this.
 *
 * The click tracks are copied into the debug APK's web assets at `/a04/` by the
 * job, so Capacitor serves them at `https://localhost/a04/…`, the app's own
 * origin. The card asked for them to be served over `adb reverse`. That cannot
 * reach this page: its CSP admits `media-src https:` only, the WebView refuses
 * cleartext for an app targeting API 26+ (and `mobile/` does not opt in), and
 * `https://localhost` is Capacitor's own origin, so a reversed port on it is
 * never asked. An HTTPS server on a reversed port would need a certificate the
 * emulator trusts. Bundling is what A-03 measured working, and it serves the
 * files from the same origin the app's real bundled content comes from.
 *
 * Two things are observed without being changed: `HTMLMediaElement.prototype.play`
 * is wrapped so the scenarios can read the element's `currentTime` (the backend
 * builds its elements with `new Audio()` and never puts them in the DOM), and a
 * `foray:remote` listener counts the transport presses the polyfill delivered.
 * Neither alters what the player does.
 *
 * ── ONE SCENARIO PER INVOCATION ──────────────────────────────────────────────
 *
 *   node tools/mobile/android-playback.mjs <scenario> --art DIR
 *        [--endpoint http://127.0.0.1:9222] [--pkg ai.jwlabs.foura]
 *
 * Scenarios: `first-launch` (e), `play` (a), `background` (b), `transport` (c),
 * `notification` (d); A-05's `seams` (f), `doze` (g), `focus` (h), `call` (i),
 * `kill` (j), `airplane` (k) and `back-home` (l); and the two bookkeeping ones,
 * `collect` (the evidence the card asks to upload) and `summary` (the table for
 * the run's summary). A-05 RECORDS first and gates only where its card says so:
 * (g), (k) and (l) are gated; (f), (h), (i) and (j) fail only when there was
 * nothing to record (the screen stayed on, the helper got no focus, the call
 * never rang, the force-stop control did not hold). The
 * workflow runs each as its own named step, so each has its own verdict. Every
 * scenario prints its verdict as JSON, writes it to `DIR/verdict-<scenario>.json`,
 * and exits 0 (pass), 1 (the verdict failed) or 2 (it could not run).
 *
 * The pure half (fixtures, parsers, verdicts) is exported and pinned by
 * `android-playback.test.mjs` against real `dumpsys` output from A-03's run. The
 * live half needs a device and runs only in CI.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluate, expectedTitle, listTargets, pickPage, probe as launchProbe } from "./webview-probe.mjs";
import { LOAD_SETTLE_TIMEOUT_MS } from "../../player/deck-policy.js";
import { NARRATION_DEADLINE_FACTOR, NARRATION_DEADLINE_MARGIN_SEC } from "../../player/queue-manager.js";

export const PKG = "ai.jwlabs.foura";
/** `PlaybackKeepAliveService`, as `dumpsys activity services` names it. */
export const SERVICE = "PlaybackKeepAliveService";
/** `ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK`. */
export const FGS_TYPE_MEDIA_PLAYBACK = 0x2;

/* ───────────────────────────── the fixture ───────────────────────────── */

/** Where the job copies the click tracks inside the APK's web assets. */
export const FIXTURE_PATH = "/a04/";
export const FIXTURE_ORIGIN = "https://localhost";
export const SHOW = "4a CI fixtures";
export const FORAY_ID = "a04-ci-playback";
export const FORAY_TITLE = "A-04 playback";

/** Three clips, 85 s each of a 90 s track, so every one has an out-point the
 *  player must honour. Three rather than two so a "next" always has somewhere to
 *  go after the scenarios before it have moved the playhead. The episode is the
 *  (d) fixture: a single episode is what the ↺15 / 30↻ pair exists for. */
export const CLIPS = Object.freeze([
  Object.freeze({ file: "click-cbr.mp3", title: "A-04 click one", endSec: 85 }),
  Object.freeze({ file: "click-vbr-xing.mp3", title: "A-04 click two", endSec: 85 }),
  Object.freeze({ file: "click-vbr-notoc.mp3", title: "A-04 click three", endSec: 85 }),
]);
export const EPISODE = Object.freeze({ file: "click-cbr.mp3", title: "A-04 single episode" });

/** The three documents `ForayPlayer.resolve` joins, in the shapes
 *  `player/foray-resolve.js` reads from `data/`. */
export function fixtureDocs(origin = FIXTURE_ORIGIN) {
  const url = (file) => `${origin}${FIXTURE_PATH}${file}`;
  return {
    forays: {
      forays: [
        {
          id: FORAY_ID,
          title: FORAY_TITLE,
          status: "published",
          items: CLIPS.map((c, i) => ({ type: "segment", segment_id: `a04-seg-${i + 1}`, label: c.title })),
        },
      ],
    },
    segments: {
      segments: CLIPS.map((c, i) => ({
        id: `a04-seg-${i + 1}`,
        item_id: `a04-ep-${i + 1}`,
        start_sec: 0,
        end_sec: c.endSec,
      })),
    },
    sources: {
      sources: CLIPS.map((c, i) => ({
        id: `a04-ep-${i + 1}`,
        title: c.title,
        show: SHOW,
        audio_url: url(c.file),
        duration_sec: 90,
      })),
    },
    episode: { id: "a04-episode", title: EPISODE.title, show: SHOW, audio_url: url(EPISODE.file), duration_sec: 90 },
  };
}

/* ─────────────────────── A-05: the fixtures ─────────────────────── */

/** Where the job puts the rendered-narration fixtures inside the APK. */
export const NARRATION_PATH = "/a05/";

/** Three rendered-narration lines, made in the job by ffmpeg at the render
 *  profile's encode (`tools/narration/render-profile.json` `render.encode`:
 *  AAC in .m4a, 64 kbps, mono, 24 kHz, faststart), because narration now ships
 *  as `audio_url` files (DECISIONS 2026-09-28, PR #867). A tone, not a voice:
 *  (f) measures the FILE seam, and what the samples say cannot change it. No
 *  audio is committed; `android-playback-workflow.test.mjs` pins the job's
 *  ffmpeg lines to these names and lengths. */
export const NARRATION_LINES = Object.freeze([
  Object.freeze({ file: "a05-line-1.m4a", sec: 5, hz: 220, script: "The first line between two clips." }),
  Object.freeze({ file: "a05-line-2.m4a", sec: 6, hz: 247, script: "The second line, after the second clip." }),
  Object.freeze({ file: "a05-line-3.m4a", sec: 7, hz: 262, script: "The third line, before the last clip." }),
]);

/** (k): a rendered line in the shape a real one has, on the render profile's
 *  public base, whose file cannot load because the phone is in airplane mode.
 *  The path names no object, so if airplane mode ever failed to engage the
 *  load would still fail (a 404), and (k) says which of the two it saw. */
export const UNREACHABLE_NARRATION_URL = "https://audio.jwlabs.ai/n/a05-ci/unreachable.m4a";
export const UNREACHABLE_SCRIPT = "This line was rendered, and the network is gone.";

/** A Foray from a list of clips and narration lines, in the three documents
 *  `ForayPlayer.resolve` joins. Each clip is its own source, so every clip
 *  boundary is a cross-episode load, the seam kind #239's deadline is about. */
export function buildForay({ id, title, items, origin = FIXTURE_ORIGIN }) {
  const forayItems = [];
  const segments = [];
  const sources = [];
  items.forEach((it, i) => {
    if (it.clip) {
      const seg = `${id}-seg-${i}`;
      const ep = `${id}-ep-${i}`;
      forayItems.push({ type: "segment", segment_id: seg, label: it.clip.title });
      segments.push({ id: seg, item_id: ep, start_sec: it.startSec ?? 0, end_sec: it.endSec });
      sources.push({ id: ep, title: it.clip.title, show: SHOW, audio_url: `${origin}${FIXTURE_PATH}${it.clip.file}`, duration_sec: 90 });
      return;
    }
    const line = it.line ?? {};
    forayItems.push({
      type: "narration",
      id: `${id}-line-${i}`,
      audio_url: it.url ?? `${origin}${NARRATION_PATH}${line.file}`,
      script: it.script ?? line.script,
      duration_sec: it.sec ?? line.sec,
    });
  });
  return {
    id,
    forays: { forays: [{ id, title, status: "published", items: forayItems }] },
    segments: { segments },
    sources: { sources },
  };
}

/** (f): clip, line, clip, line, clip, line, clip. Six file seams, all with the
 *  screen off. Each clip is 22 s, over the 20 s floor below which the web
 *  lane's narration warm (PR #867) does not start, so the seams are the ones a
 *  real Foray has. */
export const SEAMS_FORAY = buildForay({
  id: "a05-seams",
  title: "A-05 hidden seams",
  items: [
    { clip: CLIPS[0], endSec: 22 },
    { line: NARRATION_LINES[0] },
    { clip: CLIPS[1], endSec: 22 },
    { line: NARRATION_LINES[1] },
    { clip: CLIPS[2], endSec: 22 },
    { line: NARRATION_LINES[2] },
    { clip: CLIPS[0], startSec: 30, endSec: 52 },
  ],
});

/** (g): six 85 s clips, 510 s, so five minutes of Doze never reaches its end. */
export const DOZE_FORAY = buildForay({
  id: "a05-doze",
  title: "A-05 doze",
  items: [...CLIPS, ...CLIPS].map((clip) => ({ clip, endSec: 85 })),
});

/** (h), (i), (j), (l): three 85 s clips, started fresh by each scenario. */
export const LONG_FORAY = buildForay({
  id: "a05-long",
  title: "A-05 long",
  items: CLIPS.map((clip) => ({ clip, endSec: 85 })),
});

/** (k): a 6 s clip, the line that cannot load, and a clip to land on. */
export const AIRPLANE_FORAY = buildForay({
  id: "a05-airplane",
  title: "A-05 airplane",
  items: [
    { clip: CLIPS[0], endSec: 6 },
    { url: UNREACHABLE_NARRATION_URL, script: UNREACHABLE_SCRIPT, sec: 4 },
    { clip: CLIPS[1], endSec: 60 },
  ],
});

/** The helper app (h) installs: `tools/mobile/a05-focus-helper/`, built by the
 *  job into the evidence directory under this name. */
export const HELPER_PKG = "ai.jwlabs.a05focus";
export const HELPER_ACTIVITY = `${HELPER_PKG}/.FocusActivity`;
export const HELPER_APK = "a05-focus-helper.apk";
export const HELPER_TAG = "A05Focus";

/* ───────────────────────────── the gates ───────────────────────────── */

/** Every number a scenario gates on. The card's own where it gives one. */
export const GATES = Object.freeze({
  /** (a): "`currentTime` advances by at least 3 s over 5 s". */
  playWindowMs: 5000,
  playMinAdvanceSec: 3,
  /** (b): "position still advances 60 s later". Half the wall time, so a seam or
   *  a slow sample cannot fail it, while a player frozen by the screen going off
   *  (which advances 0) cannot pass. The measured number is printed beside it. */
  backgroundWaitMs: 60000,
  backgroundMinAdvanceSec: 30,
  /** (c), (d): how long a press has to show up in the page's state. */
  pressTimeoutMs: 10000,
  /** (c): "previous" moves the Foray clock back by at least this much. */
  previousMinRewindSec: 1,
  /** (c): wait this long on a new clip before pressing previous, so the press
   *  is unambiguous whichever of the two things previous means it does. */
  previousSettleMs: 3000,

  /* ── A-05. Record first, gate only where the card says so: (g), (k), (l). ── */
  /** (f): how often the hidden Foray is looked at, and the most it may take. */
  seamsPollMs: 10000,
  seamsMaxWaitMs: 300000,
  /** (f): give up on a Foray that has stood still, not running, this long. */
  seamsStallMs: 60000,
  /** (f): D-A4's line, recorded not gated: p95 over 4 s on the emulator ships
   *  the JS-lane stopgap A-15 (`docs/plans/android-assessment.md` §6). */
  seamP95TriggerMs: 4000,
  /** (g): "Playback continues for 5 min". The clock must cover 4 of them, so
   *  a seam or a slow sample cannot fail it while a frozen player cannot pass. */
  dozeWaitMs: 300000,
  dozeSampleMs: 20000,
  dozeMinAdvanceSec: 240,
  /** (g): `STANDBY_BUCKET_RARE`. */
  bucketRare: 40,
  /** (h), (i): how long after the event before reading, and the window over
   *  which "still playing" is measured. */
  settleMs: 4000,
  windowMs: 4000,
  /** (h), (i), (j), (l): at least this much clock over `windowMs` is "playing". */
  playingMinAdvanceSec: 2,
  /** (k): "within the deadline". The line's file gets the backend's load
   *  deadline (10 s, visible), and the fallback is decided when it fails;
   *  5 s over that is slack for the poll and the bridge, not for the load. */
  airplaneDecisionMs: LOAD_SETTLE_TIMEOUT_MS + 5000,
  /** (k): once spoken, the line has the manager's own speech deadline
   *  (runtime x 1.5 + 10 s) to end, and the next clip 10 s to load. */
  airplaneAfterLineMs: Math.round((4 * NARRATION_DEADLINE_FACTOR + NARRATION_DEADLINE_MARGIN_SEC) * 1000) + LOAD_SETTLE_TIMEOUT_MS,
  /** (l): Back is pressed at most this many times to get from wherever the
   *  page is to Home and then out of the app. */
  backMaxPresses: 5,
});

/* ───────────────────────── what runs inside the page ───────────────────────── */

/** Installed once. Observes; changes nothing the player does. */
export const INSTRUMENT_EXPRESSION = `(() => {
  const A = window.__a04 || (window.__a04 = { remote: [], elements: [] });
  if (!A.hooked) {
    A.hooked = true;
    window.addEventListener('foray:remote', (e) => {
      const d = (e && e.detail) || {};
      A.remote.push({ at: Date.now(), action: d.action || null, command: d.command || null,
        origin: d.origin || null, handled: d.handled === true, deduped: d.deduped === true });
    });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!A.elements.includes(this)) A.elements.push(this);
      return play.apply(this, arguments);
    };
  }
  /* A-05 (f): when each element started and ended sounding, whatever it is,
     so a seam can be split into the interlude jingle (queue-manager.js §13,
     on by default, which the diagnostics ring does not record) and silence.
     Its own guard for the same reason as the speech hook below. */
  if (!A.mediaLogHooked) {
    A.mediaLogHooked = true;
    A.media = A.media || [];
    const name = (el) => {
      const src = String(el.currentSrc || el.src || '');
      try { const u = new URL(src); return u.host + '/' + u.pathname.split('/').pop(); } catch (_) { return src.slice(-40); }
    };
    const log = (type, el) => {
      A.media.push({ at: Date.now(), type, src: name(el) });
      if (A.media.length > 400) A.media.splice(0, A.media.length - 400);
    };
    const play2 = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!this.__a05logged && typeof this.addEventListener === 'function') {
        this.__a05logged = true;
        const el = this;
        el.addEventListener('playing', () => log('playing', el));
        el.addEventListener('ended', () => log('ended', el));
        el.addEventListener('pause', () => log('pause', el));
      }
      return play2.apply(this, arguments);
    };
  }
  /* A-05 (k): every call into the on-device speech plugin, and what it
     answered. Guarded on its own, because a page A-04 already instrumented has
     'hooked' set. Passes every call through unchanged. */
  const cap = window.Capacitor;
  if (!A.ttsHooked && cap && typeof cap.nativePromise === 'function') {
    A.ttsHooked = true;
    A.tts = A.tts || [];
    const np = cap.nativePromise;
    cap.nativePromise = function (plugin, method) {
      const p = np.apply(this, arguments);
      if (plugin === 'ForayTts' && (method === 'speak' || method === 'stop')) {
        const row = { at: Date.now(), method, ok: null, error: null };
        A.tts.push(row);
        Promise.resolve(p).then(
          (r) => { row.ok = true; row.settledAt = Date.now(); row.voice = (r && r.voice) || null; },
          (e) => { row.ok = false; row.settledAt = Date.now(); row.error = String((e && e.message) || e); }
        );
      }
      return p;
    };
  }
  return true;
})()`;

/** Start the fixture Foray through the page's own player. */
export function startForayExpression(docs = fixtureDocs(), id = docs.id ?? FORAY_ID) {
  return `(async () => {
  ${INSTRUMENT_EXPRESSION};
  const P = window.ForayPlayer;
  if (!P || typeof P.playForay !== 'function') return { ok: false, error: 'window.ForayPlayer.playForay is missing' };
  const resolved = P.resolve(${JSON.stringify(docs.forays)}, {
    id: ${JSON.stringify(id)},
    segmentsDoc: ${JSON.stringify(docs.segments)},
    sourcesDoc: ${JSON.stringify(docs.sources)},
    unlocked: [${JSON.stringify(id)}],
  });
  if (!resolved) return { ok: false, error: 'ForayPlayer.resolve returned null' };
  const out = { playable: resolved.playable.length, unplayable: resolved.unplayable.map((u) => u.reason) };
  try {
    await P.playForay(resolved, { startIndex: 0 });
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  }
  return out;
})()`;
}

/** Start the single episode through `ForayPlayer.play`, the episode rows' call. */
export function startEpisodeExpression(docs = fixtureDocs()) {
  return `(async () => {
  ${INSTRUMENT_EXPRESSION};
  const P = window.ForayPlayer;
  if (!P || typeof P.play !== 'function') return { ok: false, error: 'window.ForayPlayer.play is missing' };
  try {
    const ok = await P.play(${JSON.stringify(docs.episode)});
    return { ok: ok === true, answered: ok };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})()`;
}

/** Jump the Foray to a clip, the running-order row's call. */
export function jumpExpression(index) {
  return `(async () => { await window.ForayPlayer.forayJump(${Number(index)}); return true; })()`;
}

/** Everything a verdict reads about the page, in one round trip. */
export const STATE_EXPRESSION = `(() => {
  const A = window.__a04 || { remote: [], elements: [] };
  const ours = A.elements.filter((e) => [${JSON.stringify(FIXTURE_PATH)}, ${JSON.stringify(NARRATION_PATH)}]
    .some((p) => String(e.currentSrc || e.src || '').includes(p)));
  const live = ours.filter((e) => !e.paused);
  const el = live[live.length - 1] || ours[ours.length - 1] || null;
  const P = window.ForayPlayer;
  let s = null;
  try { s = P && P.forayStatus ? P.forayStatus() : null; } catch (_) { s = null; }
  const shim = window.ForayMediaSession;
  let payload = null;
  let inspect = null;
  try { payload = shim && shim.peek ? shim.peek() : null; } catch (_) { payload = null; }
  try { inspect = shim && shim.inspect ? shim.inspect() : null; } catch (_) { inspect = null; }
  const ms = navigator.mediaSession;
  return {
    at: Date.now(),
    visibility: document.visibilityState,
    forayPolyfill: !!(ms && ms.forayPolyfill === true),
    element: el ? { src: String(el.currentSrc || el.src), t: el.currentTime, paused: el.paused, ended: el.ended,
      readyState: el.readyState, error: el.error ? el.error.code : null } : null,
    elements: ours.length,
    foray: s ? { index: s.index, playing: s.playing, running: s.running, loading: s.loading, gap: s.gap,
      ended: s.ended, elapsedSec: s.elapsedSec, totalSec: s.totalSec, error: s.error } : null,
    episodePlaying: !!(P && P.isPlaying && P.isPlaying('a04-episode')),
    payload: payload ? { state: payload.state, title: payload.title, artist: payload.artist, album: payload.album } : null,
    shim: inspect ? { installed: inspect.installed, actions: inspect.actions, sends: inspect.sends, state: inspect.state } : null,
    remote: A.remote.slice(),
    tts: (A.tts || []).map((r) => Object.assign({}, r)),
  };
})()`;

/** The safe-area insets and viewport the first screen was laid out with. */
export const INSETS_EXPRESSION = `(() => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);' +
    'padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = { top: cs.paddingTop, bottom: cs.paddingBottom, left: cs.paddingLeft, right: cs.paddingRight,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
    screenHeight: screen.height, visualViewportHeight: window.visualViewport ? window.visualViewport.height : null };
  probe.remove();
  return out;
})()`;

/** What the diagnostics sheet's Copy copies: the record with the engine's ring
 *  merged in (`forayDiagnosticReportWithEngine`), or the page's record alone. */
export const DIAGNOSTICS_EXPRESSION = `(async () => {
  try {
    if (typeof window.forayDiagnosticReportWithEngine === 'function') {
      return String(await window.forayDiagnosticReportWithEngine());
    }
  } catch (_) { /* fall through to the page's own record */ }
  return typeof window.forayDiagnosticReport === 'function' ? String(window.forayDiagnosticReport()) : '(no diagnostics report on window)';
})()`;

/** (f): the element events the instrument logged since `sinceMs`. */
export function mediaLogExpression(sinceMs = 0) {
  return `(() => {
  const A = window.__a04 || {};
  return (A.media || []).filter((e) => e.at >= ${Number(sinceMs)});
})()`;
}

/** The row types (f) and (k) read back out of the ring. */
export const RING_TYPES = Object.freeze(["seam", "narration", "stop", "outPoint"]);

/** The diagnostics ring's rows written after `sinceSeq`, read from its own
 *  durable copy (`cp_diag`, `player/diagnostic-log.js`), which is what the
 *  sheet's Copy formats. Read-only. `seq` comes back either way, so a call
 *  with a huge `sinceSeq` is how a scenario marks where it started. */
export function ringExpression(sinceSeq = 0) {
  return `(() => {
  let raw = null;
  try { raw = localStorage.getItem(${JSON.stringify("cp_diag")}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  if (!raw) return { ok: false, error: 'no cp_diag in localStorage' };
  let rec = null;
  try { rec = JSON.parse(raw); } catch (_) { return { ok: false, error: 'cp_diag is not JSON' }; }
  const entries = Array.isArray(rec.entries) ? rec.entries : [];
  const types = ${JSON.stringify(RING_TYPES)};
  return { ok: true, seq: rec.seq, dropped: rec.dropped,
    entries: entries.filter((e) => e && e.seq > ${Number(sinceSeq)} && types.includes(e.type)) };
})()`;
}

/* ───────────────────────────── parsers ───────────────────────────── */

/** Our foreground service, from `dumpsys activity services <pkg>`.
 *
 *  API 34 prints `isForeground=true foregroundId=… types=00000002` on the
 *  service record (A-03's run, verbatim in the test fixture), not the words
 *  `foregroundServiceType=mediaPlayback` the card quotes. Both spellings are
 *  read, and `types` is a hex bit mask whose 0x2 is mediaPlayback. */
export function foregroundService(dump, service = SERVICE) {
  const records = String(dump ?? "").split(/\r?\n(?= {2}\* ServiceRecord\{)/);
  const record = records.find((r) => /^\s*\* ServiceRecord\{/.test(r) && r.split(/\r?\n/)[0].includes(service));
  if (!record) return { found: false, isForeground: false, types: null, mediaPlayback: false };
  const fg = /\bisForeground=(true|false)\b/.exec(record);
  const types = /\btypes=(?:0x)?([0-9a-fA-F]+)\b/.exec(record);
  const named = /\bforegroundServiceType=([^\s]+)/.exec(record);
  const typeMask = types ? parseInt(types[1], 16) : null;
  const mediaPlayback =
    (typeMask != null && (typeMask & FGS_TYPE_MEDIA_PLAYBACK) !== 0) || (named ? /mediaPlayback/.test(named[1]) : false);
  return {
    found: true,
    isForeground: fg ? fg[1] === "true" : false,
    types: typeMask,
    typeName: named ? named[1] : null,
    mediaPlayback,
  };
}

const PLAYBACK_STATES = { 0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 4: "FAST_FORWARDING",
  5: "REWINDING", 6: "BUFFERING", 7: "ERROR", 8: "CONNECTING" };

/** Every session in `dumpsys media_session`'s stack, plus which one gets the
 *  media buttons. A record starts at a four-space line ending `(userId=N)`. */
export function mediaSessions(dump) {
  const text = String(dump ?? "");
  const buttonLine = /Media button session is (\S+)/.exec(text);
  const lines = text.split(/\r?\n/);
  const sessions = [];
  let cur = null;
  for (const line of lines) {
    if (/^ {4}\S.*\(userId=\d+\)\s*$/.test(line)) {
      cur = { name: line.trim(), package: null, state: null, description: null, customActions: null };
      sessions.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^ {0,3}\S/.test(line)) {
      cur = null;
      continue;
    }
    const pkg = /^\s+package=(\S+)/.exec(line);
    if (pkg) cur.package = pkg[1];
    const st = /state=PlaybackState \{state=(?:([A-Z_]+)\()?(\d+)/.exec(line);
    if (st && cur.state == null) cur.state = st[1] || PLAYBACK_STATES[st[2]] || `state ${st[2]}`;
    const ca = /custom actions=\[(.*?)\], active item id/.exec(line);
    if (ca && cur.customActions == null) cur.customActions = ca[1];
    const md = /^\s+metadata: .*?description=(.*)$/.exec(line);
    if (md) cur.description = md[1].trim();
  }
  return { mediaButtonSession: buttonLine ? buttonLine[1] : null, sessions };
}

/** `mWakefulness=` from `dumpsys power`: Awake, Asleep, Dreaming or Dozing. */
export function wakefulness(dump) {
  const m = /mWakefulness=(\w+)/.exec(String(dump ?? ""));
  return m ? m[1] : null;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Every node in a `uiautomator dump`, with its bounds as numbers. */
export function uiNodes(xml) {
  const out = [];
  for (const m of String(xml ?? "").matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? "");
    out.push({
      text: attrs.text ?? "",
      desc: attrs["content-desc"] ?? "",
      id: attrs["resource-id"] ?? "",
      pkg: attrs.package ?? "",
      cls: attrs.class ?? "",
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    });
  }
  return out;
}

export function center(bounds) {
  return { x: Math.round((bounds.x1 + bounds.x2) / 2), y: Math.round((bounds.y1 + bounds.y2) / 2) };
}

/** The media controls the shade drew for us: our title and show as text, the
 *  15/30 pair and the play/pause button by their spoken labels. The pair's
 *  labels are ours (`foray_action_seek_back` / `_forward`), carried to the
 *  system as the session's custom actions; play/pause are the system's. */
export function mediaControls(nodes, { title, artist }) {
  const visible = nodes.filter((n) => n.bounds && n.bounds.x2 > n.bounds.x1 && n.bounds.y2 > n.bounds.y1);
  const said = (n) => `${n.text} ${n.desc}`;
  const find = (pred) => visible.find(pred) ?? null;
  return {
    title: title ? find((n) => n.text === title || n.desc === title) : null,
    artist: artist ? find((n) => n.text === artist || n.desc === artist) : null,
    back15: find((n) => /\b15\b/.test(said(n)) && /back|rewind|replay/i.test(said(n))),
    forward30: find((n) => /\b30\b/.test(said(n)) && /forward|ahead/i.test(said(n))),
    pause: find((n) => /^pause$/i.test(n.desc.trim()) || /^pause$/i.test(n.text.trim())),
    play: find((n) => /^play$/i.test(n.desc.trim()) || /^play$/i.test(n.text.trim())),
  };
}

/** PNG signature and IHDR size, or null. */
export function pngInfo(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

/* ─────────────────────── A-05: parsers ─────────────────────── */

/** The audio focus stack from `dumpsys audio`, bottom first: the platform
 *  prints "last is top of stack". One entry per `source:` line, e.g. (run
 *  36551857323, verbatim in the fixture):
 *    source:… -- pack: ai.jwlabs.foura -- client: …AudioFocusDelegate@… --
 *    gain: GAIN -- flags:  -- loss: none -- notified: true -- … -- uid: 10192
 *    -- attr: AudioAttributes: usage=USAGE_MEDIA …
 *  and `In ring or call: true|false`, AudioService's own call flag. */
export function focusStack(dump) {
  const text = String(dump ?? "");
  const ring = /In ring or call: (true|false)/.exec(text);
  const inRingOrCall = ring ? ring[1] === "true" : null;
  const at = text.indexOf("Audio Focus stack entries");
  if (at < 0) return { found: false, entries: [], top: null, inRingOrCall };
  const entries = [];
  for (const line of text.slice(at).split(/\r?\n/).slice(1)) {
    if (!/^\s*source:/.test(line)) break;
    const field = (name) => {
      const m = new RegExp(`-- ${name}: ?(.*?)(?: --|$)`).exec(line);
      return m ? m[1].trim() : null;
    };
    const usage = /usage=(\w+)/.exec(line);
    entries.push({
      pack: field("pack"),
      client: field("client"),
      gain: field("gain"),
      loss: field("loss"),
      uid: field("uid") != null ? Number(field("uid")) : null,
      usage: usage ? usage[1] : null,
    });
  }
  return { found: true, entries, top: entries.length ? entries[entries.length - 1] : null, inRingOrCall };
}

/** Where a media key goes when nobody is holding one: `dumpsys media_session`'s
 *  "Media button session is …" and "Last MediaButtonReceiver: …". */
export function mediaButtonRoute(dump) {
  const text = String(dump ?? "");
  const session = /Media button session is (\S+)/.exec(text);
  const receiver = /Last MediaButtonReceiver: (.*)$/m.exec(text);
  const r = receiver ? receiver[1].trim() : null;
  /* "Media button session is null" once no session holds the keys. */
  const held = session && session[1] !== "null" ? session[1] : null;
  return {
    session: held,
    sessionPackage: held ? held.split("/")[0] : null,
    lastReceiver: r === "null" ? null : r,
  };
}

const CALL_STATES = { 0: "IDLE", 1: "RINGING", 2: "OFFHOOK" };

/** `mCallState=` from `dumpsys telephony.registry` (the first phone's). */
export function callState(dump) {
  const m = /mCallState=(\d)/.exec(String(dump ?? ""));
  return m ? CALL_STATES[m[1]] ?? `state ${m[1]}` : null;
}

/** The focused window from `dumpsys window`: its package, when it has one. */
export function currentFocus(dump) {
  const m = /mCurrentFocus=(?:Window\{\S+ u\d+ ([^}\s]+)\}|null)/.exec(String(dump ?? ""));
  if (!m) return { found: false, window: null, pkg: null };
  const window = m[1] ?? null;
  return { found: true, window, pkg: window && window.includes("/") ? window.split("/")[0] : null };
}

/** A number from a one-line shell answer (`am get-standby-bucket`), or null. */
export function intLine(out) {
  const m = /^\s*(-?\d+)\s*$/.exec(String(out ?? ""));
  return m ? Number(m[1]) : null;
}

/** The nearest-rank percentile of an ascending list. */
function rank(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** (f): the seams the ring measured, as the numbers D-A4 is decided on.
 *
 *  `observedGapMs` is the ring's own number: the wall clock from the boundary
 *  (the out-point, or a file's `ended`) to the next `playing`. A seam that
 *  never became audible has none, and it is not left out: it counts as longer
 *  than any gap (Infinity) in p50/p95, because leaving the worst seams out of a
 *  percentile is how a stall reads as a good number. A cut seam and the end of
 *  the queue are not seams a listener waited through, and are counted apart. */
/** How much of a seam the interlude jingle filled: the jingle's element went
 *  `playing` inside the seam, and sounded until its `ended` or the seam's end.
 *  0 when no jingle played in it. `media` is the instrument's element log. */
export function jingleIn(seamRow, media) {
  if (!num(seamRow?.observedGapMs) || !num(seamRow?.wall)) return 0;
  const start = seamRow.wall;
  const end = start + seamRow.observedGapMs;
  const isJingle = (e) => String(e.src).includes(INTERLUDE_MARK);
  const on = (media ?? []).find((e) => e.type === "playing" && isJingle(e) && e.at >= start - 100 && e.at <= end);
  if (!on) return 0;
  const off = (media ?? []).find((e) => (e.type === "ended" || e.type === "pause") && isJingle(e) && e.at >= on.at);
  return Math.max(0, Math.min(off ? off.at : end, end) - on.at);
}

/** The interlude jingle's asset (`player/interlude.js` INTERLUDE_ASSET_PATH). */
export const INTERLUDE_MARK = "interlude";

/** (f): the seams the ring measured, as the numbers D-A4 is decided on.
 *
 *  `observedGapMs` is the ring's own number: the wall clock from the boundary
 *  (the out-point, or a file's `ended`) to the next `playing`. A seam that
 *  never became audible has none, and it is not left out: it counts as longer
 *  than any gap (Infinity) in p50/p95, because leaving the worst seams out of a
 *  percentile is how a stall reads as a good number. A cut seam and the end of
 *  the queue are not seams a listener waited through, and are counted apart.
 *
 *  THE JINGLE IS NOT SILENCE. Advancing INTO a clip from anything but the same
 *  episode plays the 3 s interlude jingle (queue-manager.js §13, founder
 *  request 2026-09-10, on by default), and the seam lasts at least as long as
 *  it: sound the listener was meant to hear. The ring does not say whether one
 *  played, so `media` (the instrument's element log) is used to take the
 *  jingle's span out: `silenceMs` is the gap minus the jingle. Without `media`
 *  the silence is not known and is reported as the whole gap. */
export function seamStats(entries, media = null) {
  const seams = (entries ?? []).filter((e) => e && e.type === "seam" && e.endOfQueue !== true);
  const measured = seams.filter((e) => num(e.observedGapMs));
  const cut = seams.filter((e) => !num(e.observedGapMs) && e.cutBy != null);
  const never = seams.filter((e) => !num(e.observedGapMs) && e.cutBy == null);
  const gapsMs = measured.map((e) => e.observedGapMs).sort((a, b) => a - b);
  const jingleOf = (e) => (media ? jingleIn(e, media) : 0);
  const silencesMs = measured.map((e) => e.observedGapMs - jingleOf(e)).sort((a, b) => a - b);
  const ranked = [...gapsMs, ...never.map(() => Infinity)];
  const rankedSilence = [...silencesMs, ...never.map(() => Infinity)];
  const finite = (v) => (v === Infinity ? "never audible" : v);
  return {
    seams: seams.length,
    measured: measured.length,
    neverStarted: never.length,
    cut: cut.length,
    gapsMs,
    p50Ms: finite(rank(ranked, 0.5)),
    p95Ms: finite(rank(ranked, 0.95)),
    maxMs: finite(ranked.length ? ranked[ranked.length - 1] : null),
    media: !!media,
    withJingle: media ? measured.filter((e) => jingleOf(e) > 0).length : null,
    silencesMs,
    silenceP50Ms: finite(rank(rankedSilence, 0.5)),
    silenceP95Ms: finite(rank(rankedSilence, 0.95)),
    silenceMaxMs: finite(rankedSilence.length ? rankedSilence[rankedSilence.length - 1] : null),
    hiddenAtBoundary: seams.filter((e) => e.hiddenAtBoundary === true).length,
    rows: seams.map((e) => ({
      seq: e.seq, fromId: e.fromId ?? null, toId: e.toId ?? null, openedBy: e.openedBy ?? null,
      observedGapMs: e.observedGapMs ?? null, jingleMs: num(e.observedGapMs) && media ? jingleOf(e) : null,
      holdMs: e.holdMs ?? null, askedGapMs: e.askedGapMs ?? null,
      deadlineMs: e.deadlineMs ?? null, crossEpisode: e.crossEpisode ?? null, hiddenAtBoundary: e.hiddenAtBoundary ?? null,
      hiddenAtStart: e.hiddenAtStart ?? null, lastStage: e.lastStage ?? null, cutBy: e.cutBy ?? null,
      trail: (e.stages ?? []).slice(-6).map((s) => s.stage),
    })),
  };
}

/** D-A4 (§6): ship A-15 when the emulator's p95 hidden seam is over 4 s.
 *  Decided on the SILENCE: A-15's own acceptance (p50 <= 2 s) could never be
 *  met by a number that includes a 3 s jingle on every seam into a clip, so
 *  the jingle cannot be what the line is about. The whole gap is reported
 *  beside it. */
export function a15Trigger(stats) {
  const on = stats?.media ? "silence" : "gap";
  const p95 = stats?.media ? stats.silenceP95Ms : stats?.p95Ms;
  if (p95 == null) return { triggered: null, on, why: "no seam was measured" };
  if (p95 === "never audible") return { triggered: true, on, why: `p95 ${on} is a seam that never became audible` };
  return p95 > GATES.seamP95TriggerMs
    ? { triggered: true, on, why: `p95 ${on} ${p95} ms > ${GATES.seamP95TriggerMs} ms` }
    : { triggered: false, on, why: `p95 ${on} ${p95} ms <= ${GATES.seamP95TriggerMs} ms` };
}

/* ───────────────────────────── verdicts ───────────────────────────── */

const num = (n) => typeof n === "number" && Number.isFinite(n);

/** (a) one clip plays, in a foreground service, published to the system. */
export function verdictPlay({ started, first, last, service, sessions, expected = { title: CLIPS[0].title, artist: SHOW } }) {
  const failures = [];
  if (!started || started.ok !== true) failures.push(`the Foray did not start: ${JSON.stringify(started)}`);
  const t0 = first?.element?.t;
  const t1 = last?.element?.t;
  const advancedSec = num(t0) && num(t1) ? +(t1 - t0).toFixed(3) : null;
  const wallSec = num(first?.at) && num(last?.at) ? +((last.at - first.at) / 1000).toFixed(3) : null;
  if (advancedSec == null) failures.push("no fixture <audio> element was ever played, so there is no currentTime to read");
  else if (advancedSec < GATES.playMinAdvanceSec) {
    failures.push(`currentTime advanced ${advancedSec} s in ${wallSec} s; the gate is ${GATES.playMinAdvanceSec} s`);
  }
  if (!service?.found) failures.push(`no ${SERVICE} in dumpsys activity services`);
  else {
    if (!service.isForeground) failures.push(`${SERVICE} is not a foreground service`);
    if (!service.mediaPlayback) failures.push(`${SERVICE}'s foreground types ${service.types} do not include mediaPlayback`);
  }
  const payload = last?.payload ?? null;
  if (!payload) failures.push("the polyfill reported no payload (window.ForayMediaSession.peek())");
  else if (payload.title !== expected.title || payload.artist !== expected.artist) {
    failures.push(`our payload says ${JSON.stringify([payload.title, payload.artist])}, the fixture says ${JSON.stringify([expected.title, expected.artist])}`);
  }
  const ours = (sessions?.sessions ?? []).filter((s) => s.package === PKG);
  const playing = ours.find((s) => s.state === "PLAYING");
  if (!ours.length) failures.push(`dumpsys media_session lists no session for ${PKG}`);
  else if (!playing) failures.push(`our media session is ${ours.map((s) => s.state).join(", ")}, not PLAYING`);
  else if (!payload || !String(playing.description ?? "").startsWith(`${payload.title}, ${payload.artist}`)) {
    failures.push(`our media session describes ${JSON.stringify(playing.description)}, not our payload's title and artist`);
  }
  if (last?.forayPolyfill !== true) failures.push("navigator.mediaSession.forayPolyfill is not true: the polyfill stepped aside");
  return {
    ok: failures.length === 0,
    failures,
    measured: {
      advancedSec, wallSec, service, mediaButtonSession: sessions?.mediaButtonSession ?? null,
      ourSessions: ours, payload, forayPolyfill: last?.forayPolyfill ?? null,
    },
  };
}

/** (b) Home, then the screen off: still playing a minute later, same process. */
export function verdictBackground({ first, last, pidBefore, pidAfter, wake, service, killedBy = null }) {
  const failures = [];
  const e0 = first?.foray?.elapsedSec;
  const e1 = last?.foray?.elapsedSec;
  const advancedSec = num(e0) && num(e1) ? +(e1 - e0).toFixed(3) : null;
  const wallSec = num(first?.at) && num(last?.at) ? +((last.at - first.at) / 1000).toFixed(3) : null;
  if (!/^(Asleep|Dozing)$/.test(String(wake ?? ""))) {
    failures.push(`the screen did not go off: mWakefulness=${wake}, so this measured nothing about the background`);
  }
  if (advancedSec == null) failures.push("the Foray clock could not be read before and after");
  else if (advancedSec < GATES.backgroundMinAdvanceSec) {
    failures.push(`the Foray clock advanced ${advancedSec} s in ${wallSec} s with the screen off; the gate is ${GATES.backgroundMinAdvanceSec} s`);
  }
  if (!pidBefore) failures.push("no app process before the screen went off");
  else if (pidAfter !== pidBefore) {
    failures.push(`the pid changed from ${pidBefore} to ${pidAfter}: the app died or restarted${killedBy ? ` (${killedBy})` : ""}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    measured: {
      advancedSec, wallSec, wakefulness: wake, pidBefore, pidAfter, killedBy,
      visibility: last?.visibility ?? null, running: last?.foray?.running ?? null, service,
    },
  };
}

/** The page action a press becomes, as `foray:remote` names it. */
export const PRESS_ACTIONS = Object.freeze({ pause: "pause", play: "play", next: "nexttrack", previous: "previoustrack" });

/** (c) one press: did it reach the page, and did the page do the thing. */
export function verdictPress({ kind, before, after, sinceRemote = 0 }) {
  const failures = [];
  const action = PRESS_ACTIONS[kind];
  const arrived = (after?.remote ?? []).slice(sinceRemote).filter((r) => r.action === action);
  if (!arrived.length) failures.push(`no ${action} reached the page (foray:remote)`);
  else if (!arrived.some((r) => r.handled)) failures.push(`${action} reached the page but no handler ran`);
  const b = before?.foray;
  const a = after?.foray;
  /* THE STATE BEFORE MUST DIFFER FROM THE ONE THE PRESS MEANS. A pause sent to
     a page that was already paused (a set-up that failed) would otherwise pass
     on state with a handler that did nothing: "compare page state before and
     after", the card's words, needs a before that could have been different. */
  if (kind === "pause" && b?.running !== true) failures.push("the page was not running before pause, so the pause measured nothing");
  if (kind === "play" && b?.running !== false) failures.push("the page was already running before play, so the play measured nothing");
  if (!a) failures.push("no Foray state after the press");
  else if (kind === "pause" && a.running !== false) failures.push("the page is still running after pause");
  else if (kind === "play" && a.running !== true) failures.push("the page is not running after play");
  else if (kind === "next" && !(b && a.index === b.index + 1)) failures.push(`next moved the Foray from clip ${b?.index} to ${a.index}`);
  else if (kind === "previous" && !(b && num(b.elapsedSec) && num(a.elapsedSec) && a.elapsedSec <= b.elapsedSec - GATES.previousMinRewindSec)) {
    failures.push(`previous moved the Foray clock from ${b?.elapsedSec} to ${a.elapsedSec}, not back`);
  } else if (kind === "previous" && !(a.running === true && !a.loading)) {
    /* Previous is a restart or the clip before, and either way the Foray is
       meant to be PLAYING afterwards: a clock moved back onto silence is the
       listener's "the button did something and then nothing". */
    failures.push("the page is not running after previous");
  }
  return { ok: failures.length === 0, failures };
}

/** (d) the shade's media controls say what we sent, and their pause pauses us. */
export function verdictNotification({ controls, expected, tapped, after, sinceRemote = 0 }) {
  const failures = [];
  if (!controls) failures.push("the shade could not be read (uiautomator dump)");
  else {
    if (!controls.title) failures.push(`no control shows our title ${JSON.stringify(expected?.title)}`);
    if (!controls.artist) failures.push(`no control shows our show ${JSON.stringify(expected?.artist)}`);
    if (!controls.back15) failures.push("no back-15 button");
    if (!controls.forward30) failures.push("no forward-30 button");
  }
  if (!tapped) failures.push("no pause button was tapped");
  else {
    /* A tap on a page that was already paused measures nothing: it must have
       been playing for "the tap paused it" to mean anything. */
    if (tapped.playingBefore !== true) failures.push("the page was not playing before the tap, so the tap measured nothing");
    const arrived = (after?.remote ?? []).slice(sinceRemote).filter((r) => r.action === "pause" && r.handled);
    if (!arrived.length) failures.push("the tap on pause never reached the page (foray:remote)");
    const running = after?.foray ? after.foray.running : after?.episodePlaying;
    if (running !== false) failures.push("the page is still playing after the tap on pause");
  }
  return { ok: failures.length === 0, failures };
}

/* ─────────────────────── A-05: verdicts ─────────────────────── */

/** How far the element's clock moved between two page reads, or null. */
export function advanced(a, b) {
  const t0 = a?.element?.t;
  const t1 = b?.element?.t;
  return num(t0) && num(t1) && a.element.src === b.element.src ? +(t1 - t0).toFixed(3) : null;
}

/** Playing, as a listener would say it: the element's clock moved at least
 *  `playingMinAdvanceSec` between the two reads. A clock that crossed into a
 *  different file cannot be compared and reads as not measured (null). */
export function wasPlaying(a, b) {
  const d = advanced(a, b);
  return d == null ? null : d >= GATES.playingMinAdvanceSec;
}

const ASLEEP = /^(Asleep|Dozing)$/;

/** (f) RECORDED, NOT GATED (the card): a verdict fails only when there was
 *  nothing to record — the Foray did not start, the screen did not go off, or
 *  the ring holds no seam row for this Foray. A slow or silent seam is a value. */
export function verdictSeams({ started, wake, stats }) {
  const failures = [];
  if (!started || started.ok !== true) failures.push(`the seam Foray did not start: ${JSON.stringify(started)}`);
  if (!ASLEEP.test(String(wake ?? ""))) failures.push(`the screen did not go off: mWakefulness=${wake}, so no seam was hidden`);
  if (!stats) failures.push("the diagnostics ring could not be read");
  else if (stats.seams === 0) failures.push("the diagnostics ring holds no seam row for this Foray");
  return {
    ok: failures.length === 0,
    failures,
    recorded: stats
      ? {
          a15: a15Trigger(stats), measured: stats.measured, neverStarted: stats.neverStarted, withJingle: stats.withJingle,
          gap: { p50Ms: stats.p50Ms, p95Ms: stats.p95Ms, maxMs: stats.maxMs },
          silence: { p50Ms: stats.silenceP50Ms, p95Ms: stats.silenceP95Ms, maxMs: stats.silenceMaxMs },
        }
      : null,
  };
}

/** (g) GATED: forced Doze, unplugged, in the rare bucket, and five minutes
 *  later the Foray clock has moved at least four of them in the same process,
 *  with the service still in the foreground. */
export function verdictDoze({ first, last, wake, deep, bucket, pidBefore, pidAfter, service, killedBy = null }) {
  const failures = [];
  if (!ASLEEP.test(String(wake ?? ""))) failures.push(`the screen did not go off: mWakefulness=${wake}`);
  if (deep !== "IDLE") failures.push(`Doze was not entered: deviceidle's deep state is ${deep}, so this measured nothing about Doze`);
  if (bucket !== GATES.bucketRare) failures.push(`the standby bucket reads ${bucket}, not rare (${GATES.bucketRare})`);
  const e0 = first?.foray?.elapsedSec;
  const e1 = last?.foray?.elapsedSec;
  const advancedSec = num(e0) && num(e1) ? +(e1 - e0).toFixed(3) : null;
  const wallSec = num(first?.at) && num(last?.at) ? +((last.at - first.at) / 1000).toFixed(3) : null;
  if (advancedSec == null) failures.push("the Foray clock could not be read before and after");
  else if (advancedSec < GATES.dozeMinAdvanceSec) {
    failures.push(`the Foray clock advanced ${advancedSec} s in ${wallSec} s of Doze; the gate is ${GATES.dozeMinAdvanceSec} s`);
  }
  if (wallSec != null && wallSec * 1000 < GATES.dozeWaitMs - 5000) failures.push(`the page stopped answering after ${wallSec} s of the ${GATES.dozeWaitMs / 1000} s`);
  if (!pidBefore) failures.push("no app process before Doze");
  else if (pidAfter !== pidBefore) failures.push(`the pid changed from ${pidBefore} to ${pidAfter}: the app died in Doze${killedBy ? ` (${killedBy})` : ""}`);
  if (!service?.found || !service.isForeground || !service.mediaPlayback) {
    failures.push(`${SERVICE} is not a mediaPlayback foreground service after Doze`);
  }
  return { ok: failures.length === 0, failures, measured: { advancedSec, wallSec, wake, deep, bucket, pidBefore, pidAfter, killedBy } };
}

/** (h) one phase: another app asks for focus (`mode`), then abandons it.
 *  Pure: what the page and the focus stack said at each read. */
export function focusPhase({ mode, stackBefore, stackHeld, stackAfter, sPre, s0, s1, s2, s3, s4, helperLog }) {
  const ours = (stack) => (stack?.entries ?? []).filter((e) => e.pack === PKG);
  const helper = (stack) => (stack?.entries ?? []).filter((e) => e.pack === HELPER_PKG);
  const granted = (helperLog ?? []).some((l) => l.includes(`mode=${mode} result=1`));
  return {
    mode,
    helperGranted: granted,
    before: { playing: wasPlaying(sPre, s0), ourEntries: ours(stackBefore), top: stackBefore?.top?.pack ?? null },
    whileHeld: {
      top: stackHeld?.top?.pack ?? null,
      helperEntry: helper(stackHeld)[0] ?? null,
      ourEntries: ours(stackHeld),
      advancedSec: advanced(s1, s2),
      playing: wasPlaying(s1, s2),
      running: s2?.foray?.running ?? null,
      elementPaused: s2?.element?.paused ?? null,
    },
    afterAbandon: {
      top: stackAfter?.top?.pack ?? null,
      ourEntries: ours(stackAfter),
      advancedSec: advanced(s3, s4),
      playing: wasPlaying(s3, s4),
      running: s4?.foray?.running ?? null,
    },
    remote: (s4?.remote ?? []).slice((s0?.remote ?? []).length),
    helperLog: helperLog ?? [],
  };
}

/** (h) RECORDED: fails only when the helper could not take focus, which would
 *  make the phase measure nothing. */
export function verdictFocus({ phases }) {
  const failures = [];
  if (!phases?.length) failures.push("no focus phase ran");
  for (const p of phases ?? []) {
    if (!p.helperGranted) failures.push(`${p.mode}: the helper's AUDIOFOCUS request was not granted, so nothing took focus from us`);
  }
  const recorded = (phases ?? []).map((p) => ({
    mode: p.mode,
    playingBefore: p.before.playing,
    heldFocusBefore: p.before.ourEntries.length > 0,
    ourLossWhileHeld: p.whileHeld.ourEntries[0]?.loss ?? "(no entry)",
    pausedWhileHeld: p.whileHeld.playing === false,
    resumedAfterAbandon: p.afterAbandon.playing === true,
  }));
  return { ok: failures.length === 0, failures, recorded };
}

/** (i) RECORDED: fails only when the emulator's call did not ring, answer and
 *  hang up, which would make the phases measure nothing. */
export function verdictCall({ phases }) {
  const failures = [];
  const at = (name) => (phases ?? []).find((p) => p.name === name) ?? null;
  const want = [["ringing", "RINGING"], ["in-call", "OFFHOOK"], ["ended", "IDLE"]];
  for (const [name, state] of want) {
    const p = at(name);
    if (!p) failures.push(`the ${name} phase did not run`);
    else if (p.callState !== state) failures.push(`${name}: mCallState is ${p.callState}, not ${state}: the emulator's call did not do what the phase needs`);
  }
  const rec = (name) => {
    const p = at(name);
    return p ? { playing: p.playing, running: p.running, top: p.top, ourLoss: p.ourEntries?.[0]?.loss ?? "(no entry)", inRingOrCall: p.inRingOrCall } : null;
  };
  return {
    ok: failures.length === 0,
    failures,
    recorded: { before: rec("before"), ringing: rec("ringing"), inCall: rec("in-call"), ended: rec("ended"), endedLater: rec("ended+10s") },
  };
}

/** (j) RECORDED: which package a media play reaches once our process is gone.
 *  Fails only when the negative control does not hold: after `am force-stop`
 *  our process must be gone and stay gone through the press. */
export function verdictKill({ legs }) {
  const failures = [];
  const byName = (n) => (legs ?? []).find((l) => l.leg === n) ?? null;
  for (const n of ["am-kill", "force-stop"]) if (!byName(n)) failures.push(`the ${n} leg did not run`);
  const control = byName("force-stop");
  if (control) {
    if (control.pidAfterKill) failures.push(`am force-stop left our process running (pid ${control.pidAfterKill})`);
    if (control.pidAfterDispatch) failures.push(`a play after am force-stop brought our process back (pid ${control.pidAfterDispatch}): the control does not hold`);
  }
  const recorded = (legs ?? []).map((l) => ({
    leg: l.leg, killed: l.killed, buttonSession: l.routeBefore?.session ?? null, lastReceiver: l.routeBefore?.lastReceiver ?? null,
    receivedBy: l.receivedBy, ourProcessAfterPlay: !!l.pidAfterDispatch, restarted: !!(l.pidAfterDispatch && l.pidAfterDispatch !== l.pidBefore),
    pagePlaying: l.pagePlaying ?? null,
  }));
  return { ok: failures.length === 0, failures, recorded };
}

/** Who got the play, from what the system said after it: the package whose
 *  session is PLAYING, else the media button session's package. */
export function receiverOf(sessions, route) {
  const playing = (sessions?.sessions ?? []).filter((s) => s.state === "PLAYING" && s.package);
  if (playing.length) return { by: "a PLAYING session", pkg: [...new Set(playing.map((s) => s.package))].join(", ") };
  if (route?.sessionPackage) return { by: "the media button session (not playing)", pkg: route.sessionPackage };
  return { by: "nobody (no session is playing and none holds the media button)", pkg: null };
}

/** (k) GATED: in airplane mode, a rendered line that cannot load is spoken
 *  from its script or skipped, within the deadline, and the Foray goes on. */
export function verdictAirplane({ airplane, reachedLine, decision, landed, final }) {
  const failures = [];
  if (airplane !== true) failures.push("airplane mode did not engage (settings global airplane_mode_on is not 1)");
  if (!reachedLine) failures.push("the Foray never reached the narration line");
  else if (!decision) failures.push(`the line was neither spoken nor skipped within ${GATES.airplaneDecisionMs} ms`);
  else {
    if (decision.kind === "stopped") failures.push(`the Foray stopped at the line: ${JSON.stringify(decision.error ?? null)}`);
    else if (decision.ms > GATES.airplaneDecisionMs) failures.push(`the line was ${decision.kind} after ${decision.ms} ms; the deadline is ${GATES.airplaneDecisionMs} ms`);
    if (decision.kind !== "stopped" && !landed) {
      failures.push(`the Foray did not go on to the clip after the line within ${GATES.airplaneAfterLineMs} ms (index ${final?.foray?.index}, running ${final?.foray?.running})`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/** (l) GATED since A-07 (PR #874) is on main: Back on Home while playing
 *  leaves the app without stopping it: same process, clock still moving, the
 *  service still a mediaPlayback foreground service. */
export function verdictBack({ left, presses, pidBefore, pidAfter, first, last, service }) {
  const failures = [];
  if (!left) failures.push(`Back never left the app in ${presses} presses`);
  if (!pidBefore) failures.push("no app process before Back");
  else if (pidAfter !== pidBefore) failures.push(`the pid changed from ${pidBefore} to ${pidAfter}: Back ended the process`);
  const d = advanced(first, last);
  if (d == null) failures.push("the clock could not be read after Back");
  else if (d < GATES.playingMinAdvanceSec) failures.push(`the clock moved ${d} s in the ${GATES.windowMs / 1000} s after Back: the audio stopped`);
  if (!service?.found || !service.isForeground || !service.mediaPlayback) {
    failures.push(`${SERVICE} is not a mediaPlayback foreground service after Back`);
  }
  return { ok: failures.length === 0, failures, measured: { advancedSec: d, presses, pidBefore, pidAfter } };
}

/* ─────────────────────────── the live half ─────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One adb call, bounded. Never throws: the caller reads `status`. */
export function adb(args, { binary = false, timeoutMs = 60000 } = {}) {
  const r = spawnSync("adb", args, {
    encoding: binary ? "buffer" : "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? (binary ? Buffer.alloc(0) : ""), stderr: String(r.stderr ?? ""), error: r.error ? String(r.error.message) : null };
}

const shell = (...args) => adb(["shell", ...args]).stdout;

export function pidOf(pkg = PKG) {
  return String(shell("pidof", pkg)).trim().split(/\s+/)[0] || null;
}

/** What ActivityManager said when it ended our process, from the system log:
 *  the `Killing <pid>:<pkg> (adj …): <reason>` line, or its `has died` line. */
export function killLine(log, pid, pkg = PKG) {
  const lines = String(log ?? "").split(/\r?\n/);
  const hit =
    lines.find((l) => l.includes(`Killing ${pid}:${pkg}/`)) ??
    lines.find((l) => /has died/.test(l) && l.includes(`${pkg} (pid ${pid})`));
  return hit ? hit.replace(/^.*?ActivityManager: /, "").trim() : null;
}

function killReason(pid, pkg) {
  return pid ? killLine(adb(["logcat", "-d", "-b", "system"]).stdout, pid, pkg) : null;
}

/** Forward the page's DevTools socket (found, not name-assumed, as in
 *  `android-smoke.yml`) and return the page target. */
async function connect(ctx, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    const pid = pidOf(ctx.pkg);
    if (pid) {
      const unix = shell("cat", "/proc/net/unix");
      const socks = [...new Set(String(unix).match(/webview_devtools_remote_\d+/g) ?? [])];
      const sock = socks.find((s) => s.endsWith(`_${pid}`)) ?? socks[0] ?? `webview_devtools_remote_${pid}`;
      adb(["forward", "tcp:9222", `localabstract:${sock}`]);
      try {
        const target = pickPage(await listTargets(ctx.endpoint));
        if (target) return { pid, target };
        last = "no page target yet";
      } catch (e) {
        last = String(e.message ?? e);
      }
    } else {
      last = `no ${ctx.pkg} process`;
    }
    await sleep(2000);
  }
  throw new Error(`could not reach the page over DevTools: ${last}`);
}

async function page(ctx, expression, { gesture = false, timeoutMs = 30000 } = {}) {
  if (!ctx.target) ({ target: ctx.target } = await connect(ctx));
  try {
    return await evaluate(ctx.target.webSocketDebuggerUrl, expression, timeoutMs, { userGesture: gesture });
  } catch (e) {
    /* A dropped forward or a recreated target: find it again once. ONLY for a
       failure to reach the page. A timeout or a throw means the page got the
       expression, and running a start twice would start the Foray twice. */
    if (!/closed before answering|websocket error/.test(String(e?.message ?? e))) throw e;
    ({ target: ctx.target } = await connect(ctx));
    return evaluate(ctx.target.webSocketDebuggerUrl, expression, timeoutMs, { userGesture: gesture });
  }
}

const state = (ctx) => page(ctx, STATE_EXPRESSION);

async function waitFor(ctx, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let s = await state(ctx);
  while (!pred(s) && Date.now() < deadline) {
    await sleep(500);
    s = await state(ctx);
  }
  return s;
}

function save(ctx, name, content) {
  const file = path.join(ctx.art, name);
  fs.writeFileSync(file, content);
  return name;
}

function readRunState(ctx) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.art, "playback-state.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeRunState(ctx, patch) {
  fs.writeFileSync(path.join(ctx.art, "playback-state.json"), JSON.stringify({ ...readRunState(ctx), ...patch }, null, 2));
}

function wakeAndUnlock() {
  shell("input", "keyevent", "KEYCODE_WAKEUP");
  shell("wm", "dismiss-keyguard");
}

/* ───────────────────────────── scenarios ───────────────────────────── */

/** (e) The first screen after launch, as a PNG: the edge-to-edge evidence. */
async function firstLaunch(ctx) {
  await connect(ctx, { timeoutMs: 120000 });
  const launch = await launchProbe({ endpoint: ctx.endpoint, timeoutMs: 120000, title: expectedTitle() });
  const shot = adb(["exec-out", "screencap", "-p"], { binary: true });
  const png = pngInfo(shot.stdout);
  if (png) save(ctx, "first-launch.png", shot.stdout);
  let insets = null;
  try {
    insets = await page(ctx, INSETS_EXPRESSION);
  } catch (e) {
    insets = { error: String(e.message ?? e) };
  }
  const failures = [];
  if (!launch.ok) failures.push(`the app did not launch into a usable state: ${launch.failures.join("; ")}`);
  if (!png) failures.push(`screencap returned no PNG (${shot.stdout.length} bytes, ${shot.stderr.trim() || "no stderr"})`);
  writeRunState(ctx, { pidAtLaunch: pidOf(ctx.pkg) });
  return {
    ok: failures.length === 0,
    failures,
    measured: {
      screenshot: png ? { file: "first-launch.png", ...png } : null,
      insets,
      wmSize: shell("wm", "size").trim(),
      wmDensity: shell("wm", "density").trim(),
    },
    evidence: png ? ["first-launch.png"] : [],
  };
}

/** (a) Play a bundled clip through the real player. */
async function play(ctx) {
  const { pid } = await connect(ctx);
  writeRunState(ctx, { pid });
  const started = await page(ctx, startForayExpression(), { gesture: true, timeoutMs: 45000 });
  await waitFor(ctx, (s) => s.element && !s.element.paused && s.element.t > 0, 15000);
  const first = await state(ctx);
  await sleep(GATES.playWindowMs);
  const last = await state(ctx);
  /* The system side can trail the page by a message loop, so it is read up to
     three times. A service that never started stays red on every read. */
  let service = null;
  let sessions = null;
  let servicesDump = "";
  let sessionsDump = "";
  for (let i = 0; i < 3; i += 1) {
    servicesDump = shell("dumpsys", "activity", "services", ctx.pkg);
    sessionsDump = shell("dumpsys", "media_session");
    service = foregroundService(servicesDump);
    sessions = mediaSessions(sessionsDump);
    const ok = service.isForeground && service.mediaPlayback && sessions.sessions.some((s) => s.package === ctx.pkg && s.state === "PLAYING");
    if (ok) break;
    await sleep(1000);
  }
  save(ctx, "a-dumpsys-activity-services.txt", servicesDump);
  save(ctx, "a-dumpsys-media_session.txt", sessionsDump);
  let bridge = null;
  try {
    bridge = await page(ctx, "window.Capacitor.nativePromise('ForayAudio', 'state', {})");
  } catch (e) {
    bridge = { error: String(e.message ?? e) };
  }
  const v = verdictPlay({ started, first, last, service, sessions });
  return {
    ...v,
    measured: { ...v.measured, started, bridge, first: first.element, last: last.element },
    evidence: ["a-dumpsys-activity-services.txt", "a-dumpsys-media_session.txt"],
  };
}

/** (b) Home, then sleep; a minute later it is still playing in the same process. */
async function background(ctx) {
  const run = readRunState(ctx);
  const pidBefore = run.pid ?? pidOf(ctx.pkg);
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  shell("input", "keyevent", "KEYCODE_SLEEP");
  await sleep(2000);
  const powerDump = shell("dumpsys", "power");
  save(ctx, "b-dumpsys-power.txt", powerDump);
  const first = await state(ctx);
  const curve = [{ at: first.at, elapsedSec: first.foray?.elapsedSec ?? null, t: first.element?.t ?? null }];
  const end = Date.now() + GATES.backgroundWaitMs;
  let last = null;
  let lost = null;
  while (Date.now() < end) {
    await sleep(Math.min(10000, Math.max(0, end - Date.now())));
    try {
      const s = await state(ctx);
      curve.push({ at: s.at, elapsedSec: s.foray?.elapsedSec ?? null, t: s.element?.t ?? null, index: s.foray?.index ?? null });
      last = s;
    } catch (e) {
      /* The page stopped answering: a dead process is the likeliest reason,
         and the pid check below says so. Waiting out the minute adds nothing. */
      lost = String(e?.message ?? e);
      break;
    }
  }
  const pidAfter = pidOf(ctx.pkg);
  const killedBy = pidAfter === pidBefore ? null : killReason(pidBefore, ctx.pkg);
  const servicesDump = shell("dumpsys", "activity", "services", ctx.pkg);
  save(ctx, "b-dumpsys-activity-services.txt", servicesDump);
  const v = verdictBackground({
    first, last, pidBefore, pidAfter, wake: wakefulness(powerDump), service: foregroundService(servicesDump), killedBy,
  });
  return { ...v, measured: { ...v.measured, curve, lost }, evidence: ["b-dumpsys-power.txt", "b-dumpsys-activity-services.txt"] };
}

/** The two routes a press can take into the system: straight to the media
 *  button session (`cmd media_session dispatch`), and as a key event through the
 *  window manager (`input keyevent`), which is the headset's route. */
export const PRESSES = Object.freeze([
  { route: "dispatch", kind: "pause", args: ["cmd", "media_session", "dispatch", "pause"] },
  { route: "dispatch", kind: "play", args: ["cmd", "media_session", "dispatch", "play"] },
  { route: "dispatch", kind: "next", args: ["cmd", "media_session", "dispatch", "next"] },
  { route: "dispatch", kind: "previous", args: ["cmd", "media_session", "dispatch", "previous"] },
  { route: "keyevent", kind: "pause", args: ["input", "keyevent", "KEYCODE_MEDIA_PAUSE"] },
  { route: "keyevent", kind: "play", args: ["input", "keyevent", "KEYCODE_MEDIA_PLAY"] },
  { route: "keyevent", kind: "next", args: ["input", "keyevent", "KEYCODE_MEDIA_NEXT"] },
  { route: "keyevent", kind: "previous", args: ["input", "keyevent", "KEYCODE_MEDIA_PREVIOUS"] },
]);

function pressDone(kind, before) {
  return (s) => {
    const a = s?.foray;
    if (!a) return false;
    if (kind === "pause") return a.running === false;
    if (kind === "play") return a.running === true;
    if (kind === "next") return a.index === (before?.foray?.index ?? -2) + 1 && a.running === true && !a.loading;
    return num(a.elapsedSec) && num(before?.foray?.elapsedSec) && a.elapsedSec <= before.foray.elapsedSec - GATES.previousMinRewindSec
      && a.running === true && !a.loading;
  };
}

/** (c) Every transport press, by both routes, reaches the page.
 *
 *  Run with the app in the BACKGROUND (Home, screen on), which is where a lock
 *  screen, a headset or a car sends them from. Each press starts from a state
 *  the page itself set up (`ensureRunning`), so one failed press cannot make
 *  the next one meaningless: a Media3 player that believes it is paused ignores
 *  a pause, and that would read as the pause never arriving.
 *
 *  First, a FOREGROUND CONTROL: pause then play with the app on screen. It is
 *  gated like the rest, and it is what makes A04-F1 (below) a statement about
 *  the BACKGROUND: run 36550714726 resumed here and did not resume there. */
async function transport(ctx) {
  wakeAndUnlock();
  await sleep(1000);
  shell("am", "start", "-n", `${ctx.pkg}/.MainActivity`);
  await sleep(2000);
  await ensureRunning(ctx);
  const control = [];
  for (const p of PRESSES.filter((x) => x.route === "dispatch" && (x.kind === "pause" || x.kind === "play"))) {
    control.push(await press(ctx, p));
    await sleep(1500);
  }
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(2000);
  const presses = [];
  for (const p of PRESSES) {
    if (p.kind !== "play") await ensureRunning(ctx, { notLast: p.kind === "next" });
    if (p.kind === "previous") await sleep(GATES.previousSettleMs);
    presses.push(await press(ctx, p));
    await sleep(1500);
  }
  const failures = [
    ...control.filter((p) => !p.ok).map((p) => `foreground: ${p.press}: ${p.failures.join("; ")}`),
    ...presses.filter((p) => !p.ok).flatMap((p) => p.failures.map((f) => `${p.press}: ${f}`)),
  ];
  save(ctx, "c-dumpsys-media_session.txt", shell("dumpsys", "media_session"));
  return {
    ok: failures.length === 0,
    failures,
    measured: { foregroundControl: control, presses },
    evidence: ["c-dumpsys-media_session.txt"],
  };
}

/** One press, and what the page did with it. */
async function press(ctx, p) {
  const before = await state(ctx);
  const out = shell(...p.args);
  const after = await waitFor(ctx, pressDone(p.kind, before), GATES.pressTimeoutMs);
  const v = verdictPress({ kind: p.kind, before, after, sinceRemote: before.remote.length });
  return {
    route: p.route,
    kind: p.kind,
    press: p.args.join(" "),
    ok: v.ok,
    failures: v.failures,
    output: String(out).trim().slice(0, 200),
    visibility: after.visibility,
    before: before.foray,
    after: after.foray,
    element: after.element,
    remote: after.remote.slice(before.remote.length),
  };
}

/** Set up a press: the Foray running and not loading, moved by the page's own
 *  running-order call when it is not. A jump to a DIFFERENT clip, because a
 *  fresh load is the one thing measured to start reliably. */
async function ensureRunning(ctx, { notLast = false } = {}) {
  let s = await state(ctx);
  const ready = (x) => x.foray && x.foray.running && !x.foray.loading;
  if (ready(s) && !(notLast && s.foray.index >= CLIPS.length - 1)) return s;
  const from = s.foray ? s.foray.index : 0;
  const to = notLast ? (from + 1) % (CLIPS.length - 1) : (from + 1) % CLIPS.length;
  await page(ctx, jumpExpression(to), { gesture: true });
  s = await waitFor(ctx, (x) => ready(x) && x.foray.index === to, 15000);
  return s;
}

async function dumpUi(ctx, name) {
  const attempts = [];
  for (let i = 0; i < 2; i += 1) {
    const r = adb(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], { timeoutMs: 45000 });
    const said = `${r.stdout}${r.stderr}`.trim();
    attempts.push(said.slice(0, 200));
    if (/dumped to/i.test(said)) {
      const xml = shell("cat", "/sdcard/window_dump.xml");
      save(ctx, name, xml);
      return { xml, attempts };
    }
    await sleep(1000);
  }
  return { xml: null, attempts };
}

/** Read one shade layout. A PLAYING media panel animates its progress bar and
 *  `uiautomator dump` refuses a screen that never goes idle ("could not get
 *  idle state", every time on run 36549143331), so the fallback reads it paused
 *  and resumes: the play button is then where pause will be. */
async function readShade(ctx, how, log) {
  shell("cmd", "statusbar", how);
  await sleep(2500);
  const shot = adb(["exec-out", "screencap", "-p"], { binary: true });
  if (pngInfo(shot.stdout)) save(ctx, `d-shade-${how}.png`, shot.stdout);
  let dump = await dumpUi(ctx, `d-window-${how}.xml`);
  log.push({ how, dump: dump.attempts });
  let paused = false;
  if (!dump.xml) {
    shell("cmd", "media_session", "dispatch", "pause");
    await waitFor(ctx, (x) => x.episodePlaying === false, GATES.pressTimeoutMs);
    dump = await dumpUi(ctx, `d-window-${how}-paused.xml`);
    log.push({ how, pausedDump: dump.attempts });
    paused = true;
  }
  return { how, paused, xml: dump.xml };
}

/** (d) The shade's media controls: our title, our show, the 15/30 pair, and a
 *  pause that pauses the page.
 *
 *  With the app ON SCREEN and the shade pulled over it, the way a listener
 *  checks what is playing without leaving the app. The background path to the
 *  same session is (c)'s. */
async function notification(ctx) {
  wakeAndUnlock();
  await sleep(1000);
  shell("am", "start", "-n", `${ctx.pkg}/.MainActivity`);
  await sleep(2000);
  /* The single episode: its controls are ↺15, play/pause, 30↻ (the pair is
     what a lone episode gets instead of previous/next). */
  const started = await page(ctx, startEpisodeExpression(), { gesture: true, timeoutMs: 45000 });
  const s = await waitFor(ctx, (x) => x.episodePlaying && x.payload && x.payload.title === EPISODE.title, 15000);
  const expected = { title: s.payload?.title ?? EPISODE.title, artist: s.payload?.artist ?? SHOW };
  const log = [];
  let chosen = null;
  for (const how of ["expand-notifications", "expand-settings"]) {
    const read = await readShade(ctx, how, log);
    if (read.paused) {
      shell("cmd", "media_session", "dispatch", "play");
      await waitFor(ctx, (x) => x.episodePlaying === true, GATES.pressTimeoutMs);
    }
    if (!read.xml) continue;
    const controls = mediaControls(uiNodes(read.xml), expected);
    log.push({ how, found: Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, !!v])) });
    const usable = controls.title && (controls.pause || controls.play);
    const complete = usable && controls.back15 && controls.forward30;
    if (usable && (!chosen || complete)) chosen = { how, controls, paused: read.paused };
    if (complete) break;
  }
  let tapped = null;
  if (chosen) {
    shell("cmd", "statusbar", chosen.how);
    await sleep(2000);
    const button = chosen.controls.pause ?? chosen.controls.play;
    const before = await state(ctx);
    const at = center(button.bounds);
    shell("input", "tap", String(at.x), String(at.y));
    tapped = {
      how: chosen.how, at, label: button.desc || button.text, viaPausedDump: chosen.paused,
      sinceRemote: before.remote.length, playingBefore: before.episodePlaying,
    };
  }
  const after = tapped
    ? await waitFor(ctx, (x) => x.episodePlaying === false, GATES.pressTimeoutMs)
    : await state(ctx);
  shell("cmd", "statusbar", "collapse");
  const sessionsDump = shell("dumpsys", "media_session");
  save(ctx, "d-dumpsys-media_session.txt", sessionsDump);
  const ours = mediaSessions(sessionsDump).sessions.find((x) => x.package === ctx.pkg) ?? null;
  const controls = chosen?.controls ?? null;
  const v = verdictNotification({ controls, expected, tapped, after, sinceRemote: tapped?.sinceRemote ?? 0 });
  const found = controls
    ? Object.fromEntries(Object.entries(controls).map(([k, n]) => [k, n ? { text: n.text, desc: n.desc, id: n.id, bounds: n.bounds } : null]))
    : null;
  return {
    ...v,
    measured: {
      started, expected, found, tapped, log, sessionCustomActions: ours?.customActions ?? null,
      after: { episodePlaying: after.episodePlaying, visibility: after.visibility, remote: after.remote.slice(tapped?.sinceRemote ?? 0) },
    },
    evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("d-")),
  };
}

/** The evidence the card asks to upload. Never fails the job: it is what a
 *  human reads when a scenario above did. */
async function collect(ctx) {
  const tags = adb(["logcat", "-d", "-s", "Capacitor", "ForayAudio", "chromium"]);
  save(ctx, "logcat-Capacitor-ForayAudio-chromium.txt", tags.stdout);
  save(ctx, "logcat.txt", adb(["logcat", "-d"]).stdout);
  save(ctx, "final-dumpsys-media_session.txt", shell("dumpsys", "media_session"));
  save(ctx, "final-dumpsys-activity-services.txt", shell("dumpsys", "activity", "services", ctx.pkg));
  save(ctx, "final-dumpsys-audio.txt", shell("dumpsys", "audio"));
  let copy;
  try {
    copy = await page(ctx, DIAGNOSTICS_EXPRESSION, { timeoutMs: 20000 });
  } catch (e) {
    copy = `(the page could not be asked: ${String(e.message ?? e)})`;
  }
  save(ctx, "diagnostics-copy.txt", String(copy ?? ""));
  return {
    ok: true,
    failures: [],
    measured: { diagnosticsChars: String(copy ?? "").length, logcatTagLines: String(tags.stdout).split(/\n/).length },
    evidence: ["logcat-Capacitor-ForayAudio-chromium.txt", "logcat.txt", "diagnostics-copy.txt"],
  };
}

/* ─────────────────────── A-05: the live half ─────────────────────── */

/** The app on screen, awake and unlocked, and the DevTools target re-found if
 *  the process is a new one (after (j)'s kills). Returns the pid. */
async function prepare(ctx) {
  wakeAndUnlock();
  await sleep(800);
  shell("am", "start", "-W", "-n", `${ctx.pkg}/.MainActivity`);
  await sleep(1500);
  const pid = pidOf(ctx.pkg);
  if (pid !== ctx.pid) {
    ctx.target = null;
    ctx.pid = pid;
  }
  return pid;
}

/** Start one of the A-05 Forays through the page's own player, with the app
 *  on screen (a fresh load is what starts reliably, A-04 (c)), and wait for
 *  its clock to move. */
async function startFixture(ctx, fx) {
  const started = await page(ctx, startForayExpression(fx, fx.id), { gesture: true, timeoutMs: 45000 });
  const s = await waitFor(ctx, (x) => x.foray && x.foray.running && !x.foray.loading && x.element && !x.element.paused && x.element.t > 0, 15000);
  return { started, s };
}

/** Two page reads `windowMs` apart. */
async function window2(ctx) {
  const a = await state(ctx);
  await sleep(GATES.windowMs);
  const b = await state(ctx);
  return [a, b];
}

function dumpTo(ctx, name, ...args) {
  const out = shell(...args);
  save(ctx, name, out);
  return out;
}

/** (f) Hidden seam timing, RECORDED. A seven-item Foray (clip, rendered line,
 *  clip, …) played to its end with the app on Home and the screen off; the
 *  seam gaps are the diagnostics ring's own `observedGapMs` rows for it. */
async function seams(ctx) {
  await prepare(ctx);
  const mark = await page(ctx, ringExpression(Number.MAX_SAFE_INTEGER));
  const since = num(mark?.seq) ? mark.seq : 0;
  /* The page's clock, not this runner's: the log is stamped inside the page. */
  const sinceMs = (await state(ctx)).at;
  const { started } = await startFixture(ctx, SEAMS_FORAY);
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  shell("input", "keyevent", "KEYCODE_SLEEP");
  await sleep(2000);
  const wake = wakefulness(dumpTo(ctx, "f-dumpsys-power.txt", "dumpsys", "power"));
  const t0 = Date.now();
  const curve = [];
  let lost = null;
  let stillSince = null;
  let lastIndex = null;
  while (Date.now() - t0 < GATES.seamsMaxWaitMs) {
    await sleep(GATES.seamsPollMs);
    let s;
    try {
      s = await state(ctx);
    } catch (e) {
      lost = String(e?.message ?? e);
      break;
    }
    const f = s.foray;
    curve.push({ at: s.at, index: f?.index ?? null, running: f?.running ?? null, loading: f?.loading ?? null, elapsedSec: f?.elapsedSec ?? null, ended: f?.ended ?? null });
    if (!f || f.ended) break;
    /* A Foray that has stood still, not running, on one item for a minute is
       a finding, and waiting out the rest of five minutes adds nothing to it. */
    if (!f.running && f.index === lastIndex) {
      stillSince ??= s.at;
      if (s.at - stillSince >= GATES.seamsStallMs) break;
    } else {
      stillSince = null;
    }
    lastIndex = f.index;
  }
  let ring;
  try {
    ring = await page(ctx, ringExpression(since));
  } catch (e) {
    ring = { ok: false, error: String(e?.message ?? e) };
  }
  save(ctx, "f-ring.json", JSON.stringify(ring, null, 2));
  let media = null;
  try {
    media = await page(ctx, mediaLogExpression(sinceMs));
  } catch (_) {
    media = null;
  }
  save(ctx, "f-media.json", JSON.stringify(media, null, 2));
  const stats = ring?.ok ? seamStats(ring.entries, Array.isArray(media) ? media : null) : null;
  const v = verdictSeams({ started, wake, stats });
  return {
    ...v,
    measured: { started, wake, since, stats, curve, lost, ringError: ring?.ok ? null : ring?.error ?? null },
    evidence: ["f-dumpsys-power.txt", "f-ring.json", "f-media.json"],
  };
}

/** (g) Doze, GATED. Unplugged, forced into deep idle, in the rare bucket,
 *  screen off: the Foray keeps playing for five minutes. Everything the
 *  scenario forces is put back whatever happens, so (h) onward start clean. */
async function doze(ctx) {
  const pidBefore = await prepare(ctx);
  const { started } = await startFixture(ctx, DOZE_FORAY);
  const set = {};
  try {
    shell("input", "keyevent", "KEYCODE_HOME");
    await sleep(1500);
    set.unplug = shell("dumpsys", "battery", "unplug").trim();
    shell("input", "keyevent", "KEYCODE_SLEEP");
    await sleep(2000);
    /* An emulator image may ship with deep idle switched off
       (config_enableAutoPowerModes), and force-idle then answers "Unable to go
       deep idle; not enabled" and changes nothing. */
    set.enable = shell("dumpsys", "deviceidle", "enable").trim();
    set.forceIdle = shell("dumpsys", "deviceidle", "force-idle").trim();
    set.bucket = shell("am", "set-standby-bucket", ctx.pkg, "rare").trim();
    const wake = wakefulness(dumpTo(ctx, "g-dumpsys-power.txt", "dumpsys", "power"));
    const deep = shell("dumpsys", "deviceidle", "get", "deep").trim();
    const bucket = intLine(shell("am", "get-standby-bucket", ctx.pkg));
    const first = await state(ctx);
    const curve = [{ at: first.at, elapsedSec: first.foray?.elapsedSec ?? null, index: first.foray?.index ?? null, deep }];
    const end = Date.now() + GATES.dozeWaitMs;
    let last = null;
    let lost = null;
    while (Date.now() < end) {
      await sleep(Math.min(GATES.dozeSampleMs, Math.max(0, end - Date.now())));
      try {
        const s = await state(ctx);
        curve.push({ at: s.at, elapsedSec: s.foray?.elapsedSec ?? null, index: s.foray?.index ?? null, running: s.foray?.running ?? null,
          deep: shell("dumpsys", "deviceidle", "get", "deep").trim(), bucket: intLine(shell("am", "get-standby-bucket", ctx.pkg)) });
        last = s;
      } catch (e) {
        lost = String(e?.message ?? e);
        break;
      }
    }
    const pidAfter = pidOf(ctx.pkg);
    const killedBy = pidAfter === pidBefore ? null : killReason(pidBefore, ctx.pkg);
    const service = foregroundService(dumpTo(ctx, "g-dumpsys-activity-services.txt", "dumpsys", "activity", "services", ctx.pkg));
    dumpTo(ctx, "g-dumpsys-deviceidle.txt", "dumpsys", "deviceidle");
    const bucketAfter = intLine(shell("am", "get-standby-bucket", ctx.pkg));
    const v = verdictDoze({ first, last, wake, deep, bucket, pidBefore, pidAfter, service, killedBy });
    return {
      ...v,
      measured: { ...v.measured, started, set, bucketAfter, deepAfter: curve[curve.length - 1]?.deep ?? null, curve, lost },
      evidence: ["g-dumpsys-power.txt", "g-dumpsys-activity-services.txt", "g-dumpsys-deviceidle.txt"],
    };
  } finally {
    shell("dumpsys", "deviceidle", "unforce");
    shell("dumpsys", "battery", "reset");
    shell("am", "set-standby-bucket", ctx.pkg, "active");
  }
}

function helperLog() {
  return String(adb(["logcat", "-d", "-s", HELPER_TAG]).stdout)
    .split(/\r?\n/)
    .filter((l) => l.includes(HELPER_TAG) && /mode=|focusChange=/.test(l))
    .map((l) => l.replace(/^.*?A05Focus\s*:\s*/, "").trim());
}

/** (h) Audio focus, RECORDED. The focus stack while we play, then the helper
 *  app (`tools/mobile/a05-focus-helper/`) asks for AUDIOFOCUS_GAIN_TRANSIENT
 *  and then AUDIOFOCUS_GAIN, each abandoned after a window: does our audio
 *  pause, and does it come back? */
async function focus(ctx) {
  const apk = path.join(ctx.art, HELPER_APK);
  if (!fs.existsSync(apk)) throw new Error(`no helper APK at ${apk}: the job's helper build step did not run`);
  const install = adb(["install", "-r", apk], { timeoutMs: 120000 });
  const installOut = `${install.stdout}${install.stderr}`.trim();
  if (!/Success/.test(installOut)) throw new Error(`the helper APK did not install: ${installOut.slice(0, 200)}`);
  const phases = [];
  try {
    for (const mode of ["transient", "gain"]) {
      await prepare(ctx);
      const { started } = await startFixture(ctx, LONG_FORAY);
      const sPre = await state(ctx);
      await sleep(GATES.windowMs);
      const s0 = await state(ctx);
      const stackBefore = focusStack(dumpTo(ctx, `h-${mode}-0-before-dumpsys-audio.txt`, "dumpsys", "audio"));
      const logFrom = helperLog().length;
      shell("am", "start", "-W", "-n", HELPER_ACTIVITY, "--es", "mode", mode);
      await sleep(GATES.settleMs);
      const [s1, s2] = await window2(ctx);
      const stackHeld = focusStack(dumpTo(ctx, `h-${mode}-1-held-dumpsys-audio.txt`, "dumpsys", "audio"));
      shell("am", "start", "-W", "-n", HELPER_ACTIVITY, "--es", "mode", "abandon");
      await sleep(GATES.settleMs);
      const [s3, s4] = await window2(ctx);
      const stackAfter = focusStack(dumpTo(ctx, `h-${mode}-2-abandoned-dumpsys-audio.txt`, "dumpsys", "audio"));
      phases.push({ ...focusPhase({ mode, stackBefore, stackHeld, stackAfter, sPre, s0, s1, s2, s3, s4, helperLog: helperLog().slice(logFrom) }), started });
    }
  } finally {
    shell("am", "force-stop", HELPER_PKG);
  }
  const v = verdictFocus({ phases });
  return { ...v, measured: { phases }, evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("h-")) };
}

/** (i) A phone call, RECORDED: the emulator's modem rings us, the call is
 *  answered, then hung up. What the page did at each step, and the focus
 *  stack AudioService kept. */
async function call(ctx) {
  const number = "5550105";
  await prepare(ctx);
  const { started } = await startFixture(ctx, LONG_FORAY);
  shell("input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  const phases = [];
  const measure = async (name, settle) => {
    await sleep(settle);
    const [a, b] = await window2(ctx);
    const stack = focusStack(dumpTo(ctx, `i-${phases.length}-${name}-dumpsys-audio.txt`, "dumpsys", "audio"));
    phases.push({
      name,
      callState: callState(shell("dumpsys", "telephony.registry")),
      inRingOrCall: stack.inRingOrCall,
      top: stack.top?.pack ?? null,
      ourEntries: stack.entries.filter((e) => e.pack === ctx.pkg),
      advancedSec: advanced(a, b),
      playing: wasPlaying(a, b),
      running: b.foray?.running ?? null,
      elementPaused: b.element?.paused ?? null,
      remote: b.remote.slice(a.remote.length),
    });
  };
  const emu = {};
  try {
    await measure("before", 0);
    emu.call = `${adb(["emu", "gsm", "call", number]).stdout}`.trim();
    await measure("ringing", GATES.settleMs);
    emu.accept = `${adb(["emu", "gsm", "accept", number]).stdout}`.trim();
    await measure("in-call", GATES.settleMs);
    emu.cancel = `${adb(["emu", "gsm", "cancel", number]).stdout}`.trim();
    await measure("ended", 3000);
    await measure("ended+10s", 2000);
  } finally {
    adb(["emu", "gsm", "cancel", number]);
    shell("input", "keyevent", "KEYCODE_HOME");
  }
  const v = verdictCall({ phases });
  return { ...v, measured: { started, number, emu, phases }, evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("i-")) };
}

/** One kill leg of (j): kill our paused, backgrounded process one way, press
 *  play, and read who got it. */
async function killLeg(ctx, leg, kill) {
  const pidBefore = pidOf(ctx.pkg);
  const sessionsBefore = dumpTo(ctx, `j-${leg}-0-before-dumpsys-media_session.txt`, "dumpsys", "media_session");
  const routeBefore = mediaButtonRoute(sessionsBefore);
  const killOut = kill(pidBefore);
  await sleep(3000);
  const pidAfterKill = pidOf(ctx.pkg);
  const routeAfterKill = mediaButtonRoute(shell("dumpsys", "media_session"));
  /* When the kill did not take, the page is still there: read it before the
     press so the press's own foray:remote row can be told apart. */
  let pageBefore = null;
  if (pidAfterKill && pidAfterKill === ctx.pid) {
    try {
      pageBefore = await state(ctx);
    } catch (_) {
      pageBefore = null;
    }
  }
  const dispatch = shell("cmd", "media_session", "dispatch", "play").trim();
  await sleep(6000);
  const sessionsAfter = dumpTo(ctx, `j-${leg}-1-after-play-dumpsys-media_session.txt`, "dumpsys", "media_session");
  const parsed = mediaSessions(sessionsAfter);
  const routeAfter = mediaButtonRoute(sessionsAfter);
  const pidAfterDispatch = pidOf(ctx.pkg);
  let pagePlaying = null;
  let remote = null;
  let pageState = null;
  /* Only a process with a page can be asked: a service restarted on its own
     has no WebView, and DevTools would be waited on for a minute for nothing. */
  const hasPage = !!pidAfterDispatch && String(shell("cat", "/proc/net/unix")).includes(`webview_devtools_remote_${pidAfterDispatch}`);
  if (hasPage) {
    /* The same process the kill left, or a new one the press started: either
       way, is anything playing in it? */
    if (pidAfterDispatch !== ctx.pid) {
      ctx.target = null;
      ctx.pid = pidAfterDispatch;
    }
    try {
      const [a, b] = await window2(ctx);
      pagePlaying = wasPlaying(a, b);
      if (pageBefore) remote = b.remote.slice(pageBefore.remote.length);
      pageState = b.foray ? { running: b.foray.running, loading: b.foray.loading, readyState: b.element?.readyState ?? null } : null;
    } catch (_) {
      pagePlaying = null;
    }
  }
  return {
    leg, killOut: String(killOut ?? "").trim().slice(0, 200), pidBefore, pidAfterKill, killed: !!pidBefore && pidAfterKill !== pidBefore,
    routeBefore, routeAfterKill, dispatch: dispatch.slice(0, 200), routeAfter,
    receivedBy: receiverOf(parsed, routeAfter), ourSession: parsed.sessions.filter((s) => s.package === ctx.pkg).map((s) => s.state),
    pidAfterDispatch, hasPage, pagePlaying, remote, pageState,
  };
}

/** (j) Process kill, RECORDED. Paused and on Home, the process is ended three
 *  ways and a media play is pressed after each: `am kill` (what the card
 *  names; it only kills a process the system already considers cached), a
 *  SIGKILL from the app's own uid (what the low-memory killer does), and
 *  `am force-stop`, the negative control. */
async function kill(ctx) {
  const legs = [];
  const pausedOnHome = async () => {
    await prepare(ctx);
    await startFixture(ctx, LONG_FORAY);
    shell("cmd", "media_session", "dispatch", "pause");
    await waitFor(ctx, (x) => x.foray && x.foray.running === false, GATES.pressTimeoutMs);
    shell("input", "keyevent", "KEYCODE_HOME");
    await sleep(2000);
  };
  try {
    await pausedOnHome();
    legs.push(await killLeg(ctx, "am-kill", () => shell("am", "kill", ctx.pkg)));
    await pausedOnHome();
    legs.push(await killLeg(ctx, "sigkill", (pid) => (pid ? shell("run-as", ctx.pkg, "kill", "-9", pid) : "no pid")));
    await pausedOnHome();
    legs.push(await killLeg(ctx, "force-stop", () => shell("am", "force-stop", ctx.pkg)));
  } finally {
    /* A play that went to another media app leaves it playing over what comes
       next; the scenarios after this one start from a quiet device. */
    for (const l of legs) {
      for (const p of String(l.receivedBy?.pkg ?? "").split(", ")) {
        if (p && p !== ctx.pkg) shell("am", "force-stop", p);
      }
    }
    ctx.target = null;
  }
  const v = verdictKill({ legs });
  return { ...v, measured: { legs }, evidence: fs.readdirSync(ctx.art).filter((f) => f.startsWith("j-")) };
}

/** (k) Airplane-mode narration fallback, GATED. With the network off, the
 *  Foray reaches a rendered line whose file cannot load; the line is spoken
 *  from its script (or skipped) within the deadline, and the Foray goes on.
 *  With the app on screen, so the deadline is the visible one and (f) owns
 *  the hidden page. */
async function airplane(ctx) {
  const set = {};
  try {
    set.enable = shell("cmd", "connectivity", "airplane-mode", "enable").trim();
    await sleep(2000);
    const flag = shell("settings", "get", "global", "airplane_mode_on").trim();
    await prepare(ctx);
    const mark = await page(ctx, ringExpression(Number.MAX_SAFE_INTEGER));
    const since = num(mark?.seq) ? mark.seq : 0;
    const { started, s: first } = await startFixture(ctx, AIRPLANE_FORAY);
    const ttsFrom = first?.tts?.length ?? 0;
    /* Watched closely: the decision is a few seconds. */
    let reachedAt = null;
    let decision = null;
    let landedAt = null;
    let s = first;
    const cap = Date.now() + 20000 + GATES.airplaneDecisionMs + GATES.airplaneAfterLineMs;
    const trail = [];
    let idleSince = null;
    while (Date.now() < cap) {
      await sleep(250);
      s = await state(ctx);
      const f = s.foray;
      trail.push({ at: s.at, index: f?.index ?? null, running: f?.running ?? null, loading: f?.loading ?? null, error: f?.error ?? null, tts: s.tts.length - ttsFrom });
      if (!f) continue;
      /* Not running and not loading, held for 1.5 s: a stop, not a state the
         manager passes through between the file failing and the speech. */
      idleSince = !f.running && !f.loading ? idleSince ?? s.at : null;
      if (reachedAt == null && f.index >= 1) reachedAt = s.at;
      if (reachedAt == null) continue;
      if (!decision) {
        const spoke = s.tts.slice(ttsFrom).find((r) => r.method === "speak");
        if (spoke) decision = { kind: "spoken", ms: spoke.at - reachedAt, ok: spoke.ok, error: spoke.error };
        else if (f.index >= 2) decision = { kind: "skipped", ms: s.at - reachedAt };
        else if (f.error || f.ended || (idleSince != null && s.at - idleSince >= 1500)) decision = { kind: "stopped", ms: s.at - reachedAt, error: f.error ?? null };
        else if (s.at - reachedAt > GATES.airplaneDecisionMs) break;
        if (decision) decision.at = s.at;
      }
      if (decision && decision.kind !== "stopped" && f.index >= 2 && f.running && !f.loading && s.element && !s.element.paused) {
        landedAt = s.at;
        break;
      }
      if (decision && (decision.kind === "stopped" || s.at - decision.at > GATES.airplaneAfterLineMs)) break;
    }
    let ring;
    try {
      ring = await page(ctx, ringExpression(since));
    } catch (e) {
      ring = { ok: false, error: String(e?.message ?? e) };
    }
    save(ctx, "k-ring.json", JSON.stringify(ring, null, 2));
    save(ctx, "k-trail.json", JSON.stringify(trail, null, 2));
    const fallback = (ring?.entries ?? []).filter((e) => e.type === "narration");
    /* The boundary the deadline runs from is the first clip's out-point, as the
       ring stamped it, not the first poll that saw the index move: a 250 ms
       poll can see the speech before it sees the index. */
    const boundary = (ring?.entries ?? []).find((e) => e.type === "outPoint" && num(e.targetSec) && Math.abs(e.targetSec - AIRPLANE_FORAY.segments.segments[0].end_sec) < 1);
    if (decision && boundary && num(boundary.wall)) {
      const at = decision.kind === "spoken" ? s.tts.slice(ttsFrom).find((r) => r.method === "speak")?.at ?? decision.at : decision.at;
      decision = { ...decision, polledMs: decision.ms, ms: at - boundary.wall, from: "outPoint" };
    }
    if (decision && fallback[0] && boundary && num(fallback[0].wall)) decision.fallbackMs = fallback[0].wall - boundary.wall;
    /* A speak call the plugin then refused is a skip, not speech: the manager
       moves on past the line either way, and the record says which. */
    if (decision?.kind === "spoken") {
      const row = s.tts.slice(ttsFrom).find((r) => r.method === "speak");
      if (row) decision.ok = row.ok;
      if (row && row.ok === false) decision = { ...decision, kind: "skipped", why: `speech refused: ${row.error}` };
    }
    const v = verdictAirplane({ airplane: flag === "1", reachedLine: reachedAt != null, decision, landed: landedAt != null, final: s });
    return {
      ...v,
      measured: {
        started, airplaneModeOn: flag, set, decision, landedAfterDecisionMs: landedAt != null && decision ? landedAt - decision.at : null,
        fallbackRows: fallback, tts: s.tts.slice(ttsFrom), ttsPackages: shell("pm", "list", "packages", "tts").trim(),
        final: s.foray,
      },
      evidence: ["k-ring.json", "k-trail.json"],
    };
  } finally {
    set.disable = shell("cmd", "connectivity", "airplane-mode", "disable").trim();
  }
}

/** (l) Back on Home while playing, GATED (A-07, PR #874): Back is pressed
 *  until the app is no longer the focused window, and the Foray is still
 *  playing in the same process with its service in the foreground. */
async function backHome(ctx) {
  const pidBefore = await prepare(ctx);
  const { started } = await startFixture(ctx, LONG_FORAY);
  let presses = 0;
  let focusNow = currentFocus(shell("dumpsys", "window"));
  const log = [{ presses, focus: focusNow.window }];
  while (presses < GATES.backMaxPresses && focusNow.pkg === ctx.pkg) {
    shell("input", "keyevent", "KEYCODE_BACK");
    presses += 1;
    await sleep(1500);
    focusNow = currentFocus(shell("dumpsys", "window"));
    log.push({ presses, focus: focusNow.window });
  }
  /* A window with no package (a transition, the shade) is not an answer:
     read once more before deciding. Left means another app's window. */
  if (!focusNow.pkg) {
    await sleep(1500);
    focusNow = currentFocus(shell("dumpsys", "window"));
    log.push({ presses, focus: focusNow.window, reread: true });
  }
  const left = !!focusNow.pkg && focusNow.pkg !== ctx.pkg;
  await sleep(1500);
  const [first, last] = await window2(ctx);
  const pidAfter = pidOf(ctx.pkg);
  const service = foregroundService(dumpTo(ctx, "l-dumpsys-activity-services.txt", "dumpsys", "activity", "services", ctx.pkg));
  const v = verdictBack({ left, presses, pidBefore, pidAfter, first, last, service });
  return {
    ...v,
    measured: { ...v.measured, started, log, visibility: last.visibility, running: last.foray?.running ?? null },
    evidence: ["l-dumpsys-activity-services.txt"],
  };
}

/** PRODUCT DEFECTS THIS JOB FOUND, each reported as EXPECTED-FAIL instead of
 *  failing its step, so the job can guard everything else while the fix is
 *  its own card. An entry names the one failure sentence it covers and the run
 *  that showed it; any OTHER failure in the same scenario still fails the step.
 *  NOT STRICT: a known failure that stops reproducing is printed as a notice
 *  (the fix deletes the entry), because a strict one would turn red on a fix.
 *  `docs/android-emulator-measurements.md` §5 has the evidence for each. */
export const KNOWN_FAILURES = Object.freeze([
  Object.freeze({
    id: "A04-F1",
    scenario: "transport",
    match: /^(cmd media_session dispatch (play|previous)|input keyevent KEYCODE_MEDIA_(PLAY|PREVIOUS)): the page is not running after (play|previous)$/,
    what:
      "with the app in the BACKGROUND, a remote play after a pause, or a previous that restarts the clip, never plays: " +
      "the element falls to readyState 1 and the queue manager sits in loadingItem, while the same pause/play with the app " +
      "on screen resumes at once (run 36550714726); a lock screen, headset or car cannot resume the JS player",
  }),
  Object.freeze({
    id: "A04-F2",
    scenario: "notification",
    match: /^no (back-15|forward-30) button$/,
    what:
      "the system media controls (API 33+) draw no 15/30 buttons: our Media3 session publishes `custom actions=[]`, " +
      "so the media button preferences never reach the platform session (runs 36549143331, dumpsys media_session)",
  }),
]);

/** Split a scenario's failures into the known and the rest. Pure. */
export function applyKnown(scenario, failures, known = KNOWN_FAILURES) {
  const expectedFailures = [];
  const remaining = [];
  for (const f of failures ?? []) {
    const k = known.find((x) => x.scenario === scenario && x.match.test(f));
    if (k) expectedFailures.push({ id: k.id, failure: f });
    else remaining.push(f);
  }
  const knownNotReproduced = known
    .filter((k) => k.scenario === scenario && !expectedFailures.some((e) => e.id === k.id))
    .map((k) => k.id);
  return { ok: remaining.length === 0, failures: remaining, expectedFailures, knownNotReproduced };
}

/** The card's letters, in its order, for the run's summary. */
export const SCENARIOS = Object.freeze([
  ["play", "(a) play a bundled clip"],
  ["background", "(b) Home, then screen off, 60 s"],
  ["transport", "(c) media_session dispatch + KEYCODE_MEDIA_*"],
  ["notification", "(d) shade: title, show, 15/30, tap pause"],
  ["first-launch", "(e) first-launch screenshot"],
  ["seams", "(f) hidden seams, clip / rendered line / clip (recorded)"],
  ["doze", "(g) Doze, unplugged, rare bucket, 5 min (gated)"],
  ["focus", "(h) another app takes audio focus (recorded)"],
  ["call", "(i) a phone call rings, is answered, hangs up (recorded)"],
  ["kill", "(j) process kill, then a media play (recorded)"],
  ["airplane", "(k) airplane mode: a rendered line falls back in time (gated)"],
  ["back-home", "(l) Back on Home while playing (gated, A-07)"],
]);

/** A markdown table of the verdicts on disk. Pure, for the test. */
export function summaryMarkdown(verdicts) {
  const lines = ["| Scenario | Verdict | Failures |", "|---|---|---|"];
  for (const [id, label] of SCENARIOS) {
    const v = verdicts[id];
    const xf = (v?.expectedFailures ?? []).map((e) => e.id);
    const tail = xf.length ? ` (expected-fail: ${[...new Set(xf)].join(", ")})` : "";
    const verdict = !v ? "not run" : v.ok ? `**pass**${tail}` : `**FAIL**${tail}`;
    const why = v && !v.ok ? (v.failures ?? []).join("; ").replace(/\|/g, "\\|").slice(0, 400) : "";
    lines.push(`| ${label} | ${verdict} | ${why} |`);
  }
  return lines.join("\n");
}

function summary(ctx) {
  const verdicts = {};
  for (const [id] of SCENARIOS) {
    try {
      verdicts[id] = JSON.parse(fs.readFileSync(path.join(ctx.art, `verdict-${id}.json`), "utf8"));
    } catch {
      /* not run */
    }
  }
  console.log(summaryMarkdown(verdicts));
  return null;
}

const RUNNERS = {
  "first-launch": firstLaunch, play, background, transport, notification,
  seams, doze, focus, call, kill, airplane, "back-home": backHome,
  collect,
};

export function parseArgs(argv) {
  const [scenario, ...rest] = argv;
  if (!scenario || !(scenario in RUNNERS || scenario === "summary")) {
    throw new Error(`first argument must be one of ${[...Object.keys(RUNNERS), "summary"].join(", ")}; got ${JSON.stringify(scenario)}`);
  }
  const out = { scenario, endpoint: "http://127.0.0.1:9222", pkg: PKG, art: null };
  const value = (i, flag) => {
    const v = rest[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--endpoint") out.endpoint = value(++i, a);
    else if (a === "--pkg") out.pkg = value(++i, a);
    else if (a === "--art") out.art = value(++i, a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.art) throw new Error("--art DIR is required: every scenario writes its verdict and evidence there");
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.art, { recursive: true });
  const ctx = { ...args, target: null };
  if (args.scenario === "summary") {
    summary(ctx);
    return 0;
  }
  let result;
  let code;
  try {
    result = await RUNNERS[args.scenario](ctx);
    /* A scenario that RAN has its failures sorted into known and new; one
       that could not run (the catch below) is never excused. */
    result = { ...result, ...applyKnown(args.scenario, result.failures) };
    code = result.ok ? 0 : 1;
  } catch (e) {
    result = { ok: false, failures: [`the scenario could not run: ${String(e?.message ?? e)}`], error: String(e?.stack ?? e) };
    code = 2;
  }
  const verdict = { scenario: args.scenario, at: new Date().toISOString(), ...result };
  const json = JSON.stringify(verdict, null, 2);
  fs.writeFileSync(path.join(args.art, `verdict-${args.scenario}.json`), json + "\n");
  console.log(json);
  if (!verdict.ok) {
    console.error(`\n${args.scenario}: FAIL`);
    for (const f of verdict.failures) console.error(`  - ${f}`);
  } else {
    console.log(`\n${args.scenario}: pass`);
  }
  for (const e of verdict.expectedFailures ?? []) {
    const k = KNOWN_FAILURES.find((x) => x.id === e.id);
    console.log(`::warning title=${e.id} (expected-fail)::${args.scenario}: ${e.failure} (${k?.what ?? ""})`);
  }
  for (const id of verdict.knownNotReproduced ?? []) {
    console.log(`::notice title=${id} did not reproduce::${args.scenario} no longer shows ${id}; if its fix has landed, delete its KNOWN_FAILURES entry`);
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(2);
    }
  );
}
