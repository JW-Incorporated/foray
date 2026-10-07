/* The emulator plumbing both Android playback lanes drive the device with
 * (code-health CH2-20, T2-07): `android-playback.mjs` (the JS lane, A-04/A-05)
 * and `android-native-playback.mjs` (the native engine, A-26). One copy, so a
 * fix to how a lane wakes the screen, dumps the UI, reads the shade or waits on
 * its state reaches both lanes, and `android-playback.yml`'s summary compares
 * two gatherers that measure alike.
 *
 * What differs between the lanes is only how each reads its own state (the page
 * over DevTools, or the engine's service dump) and how it pauses for a shade
 * read. A lane says that once, as a LANE object, and `device()` binds the shared
 * helpers to it:
 *
 *   lane.read(ctx)          -> the lane's state now (sync or async)
 *   lane.pauseForShade(ctx) -> pause, so a busy media panel goes idle for
 *                              `uiautomator`
 *   lane.isPaused(s)        -> that pause has landed
 *   lane.press              -> how a transport press reads the state (pressDone)
 *
 * Node builtins only, and nothing from either lane, so neither import cycles.
 * Everything that talks to the device takes its `adb` and its `sleep` from
 * `device({ run, wait })`, which is how the suites pin it with a fake adb.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** The app under test: the package every adb call names. */
export const PKG = "ai.jwlabs.foura";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const num = (n) => typeof n === "number" && Number.isFinite(n);

/** One adb call, bounded. Never throws: the caller reads `status`. */
export function adb(args, { binary = false, timeoutMs = 60000 } = {}) {
  const r = spawnSync("adb", args, {
    encoding: binary ? "buffer" : "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? (binary ? Buffer.alloc(0) : ""), stderr: String(r.stderr ?? ""), error: r.error ? String(r.error.message) : null };
}

export function pidOf(pkg = PKG) {
  return String(adb(["shell", "pidof", pkg]).stdout).trim().split(/\s+/)[0] || null;
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

/** PNG signature and IHDR size, or null. */
export function pngInfo(buf) {
  if (!buf || buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

/** The state a transport press waits for, read through the lane's `press` view:
 *    view(s)      -> the part of the state the press moves (or null: not yet)
 *    resumed(a)   -> a play press has landed
 *    settled(a)   -> playing again after a skip or a rewind
 *    position(a)  -> seconds into the item
 *    sameItem(a, b) -> a previous press rewound the item it started on */
export function pressDone(kind, before, press, minRewindSec) {
  return (s) => {
    const a = press.view(s);
    if (!a) return false;
    if (kind === "pause") return a.running === false;
    if (kind === "play") return press.resumed(a);
    const b = press.view(before);
    if (kind === "next") return a.index === (b?.index ?? -2) + 1 && press.settled(a);
    const at = press.position(a);
    const from = b ? press.position(b) : undefined;
    return press.sameItem(a, b) && num(at) && num(from) && at <= from - minRewindSec && press.settled(a);
  };
}

/** The device helpers, bound to one lane. `gates` is `GATES` (windowMs,
 *  previousMinRewindSec); `helperTag` the A-05 focus helper's log tag. */
export function device({ lane, gates, helperTag, run = adb, wait = sleep }) {
  const shell = (...args) => run(["shell", ...args]).stdout;

  function save(ctx, name, content) {
    fs.writeFileSync(path.join(ctx.art, name), content);
    return name;
  }

  function dumpTo(ctx, name, ...args) {
    const out = shell(...args);
    save(ctx, name, out);
    return out;
  }

  function wakeAndUnlock() {
    shell("input", "keyevent", "KEYCODE_WAKEUP");
    shell("wm", "dismiss-keyguard");
  }

  function killReason(pid, pkg) {
    return pid ? killLine(run(["logcat", "-d", "-b", "system"]).stdout, pid, pkg) : null;
  }

  async function waitFor(ctx, pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let s = await lane.read(ctx);
    while (!pred(s) && Date.now() < deadline) {
      await wait(500);
      s = await lane.read(ctx);
    }
    return s;
  }

  /** Two state reads `windowMs` apart. */
  async function window2(ctx) {
    const a = await lane.read(ctx);
    await wait(gates.windowMs);
    const b = await lane.read(ctx);
    return [a, b];
  }

  async function dumpUi(ctx, name) {
    const attempts = [];
    for (let i = 0; i < 2; i += 1) {
      const r = run(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], { timeoutMs: 45000 });
      const said = `${r.stdout}${r.stderr}`.trim();
      attempts.push(said.slice(0, 200));
      if (/dumped to/i.test(said)) {
        const xml = shell("cat", "/sdcard/window_dump.xml");
        save(ctx, name, xml);
        return { xml, attempts };
      }
      await wait(1000);
    }
    return { xml: null, attempts };
  }

  /** Read one shade layout. A PLAYING media panel animates its progress bar and
   *  `uiautomator dump` refuses a screen that never goes idle ("could not get
   *  idle state", every time on run 36549143331), so the fallback reads it paused
   *  (`lane.pauseForShade`) and the caller resumes: the play button is then
   *  where pause will be. */
  async function readShade(ctx, how, log) {
    shell("cmd", "statusbar", how);
    await wait(2500);
    const shot = run(["exec-out", "screencap", "-p"], { binary: true });
    if (pngInfo(shot.stdout)) save(ctx, `d-shade-${how}.png`, shot.stdout);
    let dump = await dumpUi(ctx, `d-window-${how}.xml`);
    log.push({ how, dump: dump.attempts });
    let paused = false;
    if (!dump.xml) {
      lane.pauseForShade(ctx);
      await waitFor(ctx, lane.isPaused, gates.pressTimeoutMs);
      dump = await dumpUi(ctx, `d-window-${how}-paused.xml`);
      log.push({ how, pausedDump: dump.attempts });
      paused = true;
    }
    return { how, paused, xml: dump.xml };
  }

  /** The A-05 focus helper's own log lines (`mode=…`, `focusChange=…`), tag stripped. */
  function helperLog() {
    const strip = new RegExp(`^.*?${helperTag}\\s*:\\s*`);
    return String(run(["logcat", "-d", "-s", helperTag]).stdout)
      .split(/\r?\n/)
      .filter((l) => l.includes(helperTag) && /mode=|focusChange=/.test(l))
      .map((l) => l.replace(strip, "").trim());
  }

  return {
    shell,
    save,
    dumpTo,
    wakeAndUnlock,
    killReason,
    waitFor,
    window2,
    dumpUi,
    readShade,
    helperLog,
    pressDone: (kind, before) => pressDone(kind, before, lane.press, gates.previousMinRewindSec),
  };
}
