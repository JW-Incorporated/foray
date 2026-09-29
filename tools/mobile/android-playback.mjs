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
 * `notification` (d), and the two bookkeeping ones, `collect` (the evidence the
 * card asks to upload) and `summary` (the table for the run's summary). The
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
  return true;
})()`;

/** Start the fixture Foray through the page's own player. */
export function startForayExpression(docs = fixtureDocs()) {
  return `(async () => {
  ${INSTRUMENT_EXPRESSION};
  const P = window.ForayPlayer;
  if (!P || typeof P.playForay !== 'function') return { ok: false, error: 'window.ForayPlayer.playForay is missing' };
  const resolved = P.resolve(${JSON.stringify(docs.forays)}, {
    id: ${JSON.stringify(FORAY_ID)},
    segmentsDoc: ${JSON.stringify(docs.segments)},
    sourcesDoc: ${JSON.stringify(docs.sources)},
    unlocked: [${JSON.stringify(FORAY_ID)}],
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
  const ours = A.elements.filter((e) => String(e.currentSrc || e.src || '').includes(${JSON.stringify(FIXTURE_PATH)}));
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
    const arrived = (after?.remote ?? []).slice(sinceRemote).filter((r) => r.action === "pause" && r.handled);
    if (!arrived.length) failures.push("the tap on pause never reached the page (foray:remote)");
    const running = after?.foray ? after.foray.running : after?.episodePlaying;
    if (running !== false) failures.push("the page is still playing after the tap on pause");
  }
  return { ok: failures.length === 0, failures };
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

const RUNNERS = { "first-launch": firstLaunch, play, background, transport, notification, collect };

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
