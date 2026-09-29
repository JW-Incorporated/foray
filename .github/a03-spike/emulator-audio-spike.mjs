#!/usr/bin/env node
/* A-03 SPIKE (docs/plans/android-assessment.md §5.3) — THROWAWAY, never merged.
 *
 * Can the CI emulator play audio at all? Over Chrome DevTools, this plays a
 * clip BUNDLED into the debug APK (served by Capacitor at https://localhost/a03/,
 * which the page's CSP `media-src https:` admits), samples `<audio>.currentTime`
 * for ~10 s, publishes a media-session state through the app's own polyfill,
 * and then reads `dumpsys media_session` and `dumpsys audio` while it is still
 * playing. The workflow runs it once per emulator audio flag.
 *
 * It measures; it does not gate. It exits 0 when it reached the page and took
 * its samples, whatever they say, and 1 only when it could not measure.
 *
 * USAGE
 *   node .github/a03-spike/emulator-audio-spike.mjs --endpoint http://127.0.0.1:9222 \
 *        --flag "-no-audio" --pkg ai.jwlabs.foura --out-dir DIR
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listTargets, pickPage } from "../../tools/mobile/webview-probe.mjs";

const CLIP_URL = "https://localhost/a03/click-cbr.mp3";
const SAMPLES = 11; // t0 .. t10, one per second
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PLAY_EXPRESSION = `(async () => {
  let a = document.getElementById('a03-spike');
  if (!a) {
    a = document.createElement('audio');
    a.id = 'a03-spike';
    a.preload = 'auto';
    a.src = ${JSON.stringify(CLIP_URL)};
    document.body.appendChild(a);
  }
  const out = { src: a.src };
  try { await a.play(); out.play = 'resolved'; }
  catch (e) { out.play = 'rejected: ' + (e && (e.name + ': ' + e.message)); }
  try {
    const ms = navigator.mediaSession;
    out.hasMediaSession = !!ms;
    out.forayPolyfill = !!(ms && ms.forayPolyfill);
    if (ms) {
      const md = { title: 'A-03 spike', artist: '4a CI', album: 'emulator audio' };
      ms.metadata = (typeof MediaMetadata === 'function') ? new MediaMetadata(md) : md;
      ms.playbackState = 'playing';
      if (typeof ms.setPositionState === 'function' && isFinite(a.duration) && a.duration > 0) {
        ms.setPositionState({ duration: a.duration, position: a.currentTime, playbackRate: 1 });
      }
    }
  } catch (e) { out.mediaSessionError = String((e && e.message) || e); }
  return out;
})()`;

export const SAMPLE_EXPRESSION = `(() => {
  const a = document.getElementById('a03-spike');
  if (!a) return null;
  return {
    at: Date.now(), t: a.currentTime, paused: a.paused, ended: a.ended,
    readyState: a.readyState, networkState: a.networkState, duration: a.duration,
    error: a.error ? { code: a.error.code, message: a.error.message } : null
  };
})()`;

/** One Runtime.evaluate with `userGesture: true`, so the WebView's autoplay
 *  rule (mediaPlaybackRequiresUserGesture) cannot be the reason nothing plays. */
async function evaluate(wsUrl, expression, timeoutMs = 30000) {
  const ws = new globalThis.WebSocket(wsUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`evaluate timed out after ${timeoutMs} ms`)), timeoutMs);
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("websocket error")); });
      ws.addEventListener("close", (ev) => { clearTimeout(timer); reject(new Error(`socket closed (${ev?.code})`)); });
      ws.addEventListener("open", () => ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      })));
      ws.addEventListener("message", (ev) => {
        let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        const r = msg.result ?? {};
        if (r.exceptionDetails) return reject(new Error(JSON.stringify(r.exceptionDetails)));
        resolve(r.result?.value ?? null);
      });
    });
  } finally { try { ws.close(); } catch { /* never opened */ } }
}

function adb(args) {
  const r = spawnSync("adb", args, { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? "") + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
}

const PLAYBACK_STATES = { 0: "NONE", 1: "STOPPED", 2: "PAUSED", 3: "PLAYING", 4: "FAST_FORWARDING",
  5: "REWINDING", 6: "BUFFERING", 7: "ERROR", 8: "CONNECTING" };

/** The PlaybackState of every session our package owns, from `dumpsys media_session`. */
export function mediaSessionStates(dump, pkg) {
  const out = [];
  const lines = dump.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(`package=${pkg}`)) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
      if (/package=/.test(lines[j]) && j !== i) break;
      const m = /state=PlaybackState \{state=([A-Z_]+\()?(\d+)/.exec(lines[j]);
      if (m) { out.push(PLAYBACK_STATES[m[2]] ?? `state ${m[2]}`); break; }
    }
  }
  return out;
}

/** The lines of `dumpsys audio`'s focus stack. */
export function focusStack(dump) {
  const lines = dump.split(/\r?\n/);
  const i = lines.findIndex((l) => /Audio Focus stack entries/i.test(l));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (!lines[j].trim()) break;
    if (/^\S/.test(lines[j]) && out.length) break;
    out.push(lines[j].trim());
  }
  return out;
}

/** AudioPlaybackConfiguration lines for a uid (the players AudioService tracks). */
export function playersFor(dump, uid) {
  return dump.split(/\r?\n/).filter((l) => /AudioPlaybackConfiguration/.test(l) && uid && l.includes(`${uid}/`)).map((l) => l.trim());
}

function parseArgs(argv) {
  const o = { endpoint: "http://127.0.0.1:9222", flag: "", pkg: "ai.jwlabs.foura", outDir: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--endpoint") o.endpoint = argv[++i];
    else if (a === "--flag") o.flag = argv[++i] ?? "";
    else if (a === "--pkg") o.pkg = argv[++i];
    else if (a === "--out-dir") o.outDir = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function findPage(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no page target";
  while (Date.now() < deadline) {
    try {
      const t = pickPage(await listTargets(endpoint));
      if (t) return t;
    } catch (e) { lastErr = String(e.message ?? e); }
    await sleep(2000);
  }
  throw new Error(`no DevTools page target: ${lastErr}`);
}

async function main(argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  const target = await findPage(args.endpoint, 120000);
  // Let app.js finish booting before we touch the page.
  await sleep(5000);
  const played = await evaluate(target.webSocketDebuggerUrl, PLAY_EXPRESSION);
  const samples = [];
  for (let k = 0; k < SAMPLES; k += 1) {
    samples.push(await evaluate(target.webSocketDebuggerUrl, SAMPLE_EXPRESSION));
    if (k < SAMPLES - 1) await sleep(1000);
  }
  // Read the system while the element is (or should be) still playing.
  const mediaSessionDump = adb(["shell", "dumpsys", "media_session"]);
  const audioDump = adb(["shell", "dumpsys", "audio"]);
  const flingerDump = adb(["shell", "dumpsys", "media.audio_flinger"]);
  const uidLine = adb(["shell", "cmd", "package", "list", "packages", "-U", args.pkg]);
  const uid = (/uid:(\d+)/.exec(uidLine) || [])[1] ?? null;
  const after = await evaluate(target.webSocketDebuggerUrl, SAMPLE_EXPRESSION);
  fs.writeFileSync(path.join(args.outDir, "dumpsys-media_session.txt"), mediaSessionDump);
  fs.writeFileSync(path.join(args.outDir, "dumpsys-audio.txt"), audioDump);
  fs.writeFileSync(path.join(args.outDir, "dumpsys-audio_flinger.txt"), flingerDump);

  const valid = samples.filter((s) => s && Number.isFinite(s.t));
  const first = valid[0];
  const last = valid[valid.length - 1];
  const advancedSec = first && last ? +(last.t - first.t).toFixed(3) : null;
  const wallSec = first && last ? +((last.at - first.at) / 1000).toFixed(3) : null;
  const stack = focusStack(audioDump);
  const report = {
    flag: args.flag || "(default backend)",
    played,
    advancedSec,
    wallSec,
    currentTimeAdvances: advancedSec != null && advancedSec >= 3,
    samples,
    after,
    uid,
    mediaSessionStates: mediaSessionStates(mediaSessionDump, args.pkg),
    focusStack: stack,
    ourFocusEntries: (stack ?? []).filter((l) => l.includes(args.pkg) || (uid && l.includes(`uid: ${uid}`))),
    ourPlayers: playersFor(audioDump, uid),
  };
  const json = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(args.outDir, "audio-spike.json"), json + "\n");
  console.log(json);
  return first ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
}
