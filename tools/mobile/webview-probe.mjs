#!/usr/bin/env node
/* Ask a RUNNING Foray WebView what it is showing, over Chrome DevTools.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * Until this existed, the Android half of the shell had never been executed.
 * `docs/android-shell-build.md` §3 says it outright: §2's conclusion that our
 * strict CSP does not block Capacitor's injected Android bridge is INFERRED FROM
 * SOURCE, with nothing ever run in a WebView, and
 * `docs/research/mp1-background-audio.md` §6.2 records the emulator attempt that
 * produced no data at all. `android-build.yml`'s own header says "A BUILD IS NOT
 * A LAUNCH" four times over.
 *
 * This is the launch half, and it answers by MEASUREMENT four things a build
 * cannot:
 *
 *   1. the WebView is on the app's own bundled `index.html` — not `about:blank`,
 *      not `chrome-error://chromewebdata/`, not a 404 from a webDir that copied
 *      nothing;
 *   2. `app.js` RAN inside the shell, under the real CSP. `<main id="view">` is
 *      empty in the committed HTML and is filled only by `app.js`, so a non-zero
 *      child count is script execution, not markup;
 *   3. `window.Capacitor` exists — the injected bridge survived
 *      `script-src 'self'`, which is `docs/mobile-shell.md`'s top open risk;
 *   4. the bridge round-trips into OUR OWN Java. `ForayAudio.state` is
 *      side-effect free and returns `platform: "android"` from
 *      `ForayAudioPlugin.java` — the plugin's own javadoc names this exact call as
 *      the thing a device pass should make. Nothing else in the repo can see it:
 *      `mobile/android/` is not committed, so there is no file for a unit test to
 *      read, and the APK-level check in `android-build.yml` proves only that the
 *      class was REGISTERED.
 *
 * ── WHY DEVTOOLS RATHER THAN A PROBE INJECTED INTO THE PAGE ──────────────────
 *
 * `tools/mobile/probe/install-probe.mjs` patches a built bundle's web assets so
 * the page can report on itself, which is the right tool for the iOS out-point
 * and seam MEASUREMENTS: those need instrumentation the app does not carry.
 * A launch check is the opposite case. The claim is "the app a human installs
 * starts", so the artefact under test must be the unmodified one — patching it
 * first would make the thing that launched not the thing being shipped.
 * DevTools observes without modifying.
 *
 * ── THE LIMIT, STATED HERE RATHER THAN DISCOVERED LATER ──────────────────────
 *
 * DevTools is reachable only on a DEBUGGABLE build. Capacitor's `CapConfig`
 * defaults `webContentsDebuggingEnabled` to the app's `FLAG_DEBUGGABLE`, so this
 * can read a debug APK and cannot read a release one. What it proves therefore
 * transfers to the release build exactly as far as the two configurations share
 * code — Capacitor's template sets `minifyEnabled false` for release, so today
 * they do, and the workflow ASSERTS that rather than assuming it.
 *
 * USAGE
 *   node tools/mobile/webview-probe.mjs --endpoint http://127.0.0.1:9222 \
 *        --out probe.json [--timeout-ms 60000]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The host Capacitor serves the bundle from on Android.
 *  `CapConfig`'s defaults are hostname `localhost` and androidScheme `https`,
 *  and `mobile/capacitor.config.json` overrides neither. */
export const EXPECTED_HOST = "localhost";

/** The expression evaluated inside the page.
 *
 *  ONE ROUND TRIP, and everything it reads is either the DOM or the bridge.
 *  Exported so the test can assert its content — a probe that quietly stopped
 *  asking for `bridge` would still produce a green-looking report. */
export const PROBE_EXPRESSION = `(async () => {
  const view = document.querySelector('#view');
  const out = {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewPresent: !!view,
    viewChildren: view ? view.childElementCount : -1,
    viewText: view ? (view.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : '',
    hasCapacitor: !!window.Capacitor,
    plugins: (window.Capacitor && window.Capacitor.Plugins) ? Object.keys(window.Capacitor.Plugins).sort() : [],
    bridge: null
  };
  try {
    const c = window.Capacitor;
    if (c && typeof c.nativePromise === 'function') {
      out.bridge = await c.nativePromise('ForayAudio', 'state', {});
    } else {
      out.bridge = { error: 'window.Capacitor.nativePromise is not a function' };
    }
  } catch (e) {
    out.bridge = { error: String((e && e.message) || e) };
  }
  return out;
})()`;

/** The `<title>` of the committed `index.html`.
 *
 *  READ FROM THE REPO, NOT HARDCODED, and that is the difference between
 *  "the WebView shows a page called 4a" and "the WebView shows THIS repo's
 *  index.html". A literal would also turn a deliberate rename into a red smoke
 *  test in a PR that has nothing to do with the shell. */
export function titleOf(html) {
  const m = /<title>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

export function expectedTitle(root = REPO_ROOT) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const t = titleOf(html);
  if (!t) throw new Error("index.html has no <title> — cannot say what the WebView should be showing");
  return t;
}

/** Choose the DevTools target that is our page.
 *
 *  A WebView host can expose more than one target (a service worker, a
 *  `about:blank` shell created before the load). PICKING THE FIRST ONE is how a
 *  probe ends up certifying `about:blank` — so the page targets are preferred,
 *  and among them the one on the expected host. Returns null when there is no
 *  such target yet, which is a "keep waiting", not a failure. */
export function pickPage(targets, host = EXPECTED_HOST) {
  const list = Array.isArray(targets) ? targets : [];
  const pages = list.filter((t) => t && t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  const onHost = pages.find((t) => {
    try {
      return new URL(t.url).hostname === host;
    } catch {
      return false;
    }
  });
  if (onHost) return onHost;
  /* No target on the expected host. Fall back to ANY page so the verdict below
     can report what it actually found — `about:blank`, or a chrome error page —
     rather than the far less useful "no target". */
  return pages[0] ?? null;
}

/** Turn one observation into a verdict.
 *
 *  Pure, and every rule here is a separate way for a launch to be broken while
 *  the process is alive and the build was green. */
export function verdict(observed, opts = {}) {
  const host = opts.host ?? EXPECTED_HOST;
  const title = opts.expectedTitle;
  const failures = [];

  if (!observed || typeof observed !== "object") {
    return { ok: false, failures: ["the page returned nothing evaluable"] };
  }

  let parsed = null;
  try {
    parsed = new URL(String(observed.url));
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.hostname !== host) {
    failures.push(`the WebView is on ${JSON.stringify(observed.url)}, not the bundled app on ${host}`);
  } else if (parsed.pathname !== "/" && !parsed.pathname.endsWith("/index.html")) {
    failures.push(`the WebView is on path ${parsed.pathname}, not the bundled index.html`);
  }

  if (title != null && observed.title !== title) {
    failures.push(`document.title is ${JSON.stringify(observed.title)}, expected ${JSON.stringify(title)} from index.html`);
  }

  if (!observed.viewPresent) {
    failures.push("<main id=\"view\"> is not in the document — this is not the app's index.html");
  } else if (!(observed.viewChildren > 0)) {
    /* THE ONE THAT SEES A LOADED-BUT-DEAD PAGE. `#view` is empty in the committed
       HTML; only `app.js` fills it. A CSP that blocked `script-src 'self'`, a
       webDir missing `app.js`, or a throw during boot all leave the markup
       perfectly intact and this count at 0. */
    failures.push("<main id=\"view\"> is empty — index.html parsed but app.js never rendered into it");
  }

  if (!observed.hasCapacitor) {
    failures.push("window.Capacitor is absent — the injected bridge did not survive the page's CSP");
  }

  const bridge = observed.bridge;
  if (!bridge || typeof bridge !== "object") {
    failures.push("ForayAudio.state returned nothing");
  } else if (bridge.error) {
    failures.push(`ForayAudio.state failed: ${bridge.error}`);
  } else if (bridge.platform !== "android") {
    /* `platform` is set in ForayAudioPlugin.java and nowhere else, so this is the
       assertion that the call reached OUR Java rather than a Capacitor stub or a
       web fallback. */
    failures.push(`ForayAudio.state answered platform ${JSON.stringify(bridge.platform)}, not "android"`);
  }

  return { ok: failures.length === 0, failures };
}

/* ───────────────────────── the live half (needs a device) ─────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets(endpoint) {
  const res = await fetch(`${endpoint}/json/list`);
  if (!res.ok) throw new Error(`${endpoint}/json/list answered ${res.status}`);
  return res.json();
}

/** One `Runtime.evaluate` over the DevTools websocket. */
export async function evaluate(wsUrl, expression, timeoutMs = 30000) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error(
      "this Node has no global WebSocket (Node >= 22 provides one) — the DevTools evaluate cannot run"
    );
  }
  const ws = new globalThis.WebSocket(wsUrl);
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Runtime.evaluate timed out after ${timeoutMs} ms`)), timeoutMs);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`websocket error talking to ${wsUrl}`));
      });
      /* A CLEAN CLOSE IS AN ANSWER TOO, and without this it is a 30-second
         silence. A WebView target that is destroyed mid-probe — the page
         navigated, the activity recreated, `adb forward` dropped — closes the
         socket without an `error` event, so the promise would sit on the timer
         and the report would say "Runtime.evaluate timed out". That is the
         wrong diagnosis of a real event, at the end of a forty-minute job. */
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer);
        reject(new Error(`the DevTools socket closed before answering (code ${ev?.code ?? "?"})`));
      });
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          })
        );
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error) return reject(new Error(`DevTools error: ${JSON.stringify(msg.error)}`));
        const r = msg.result ?? {};
        if (r.exceptionDetails) return reject(new Error(`the page threw: ${JSON.stringify(r.exceptionDetails)}`));
        resolve(r.result?.value ?? null);
      });
    });
    return result;
  } finally {
    try {
      ws.close();
    } catch {
      /* closing a socket that never opened is not a failure of the probe */
    }
  }
}

async function probe({ endpoint, timeoutMs, title }) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, failures: ["the probe never reached the page"], observed: null };
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const target = pickPage(await listTargets(endpoint));
      if (target) {
        const observed = await evaluate(target.webSocketDebuggerUrl, PROBE_EXPRESSION, 30000);
        const v = verdict(observed, { expectedTitle: title });
        last = { ...v, observed, target: { url: target.url, title: target.title } };
        if (v.ok) break;
      } else {
        last = { ok: false, failures: [`no DevTools page target at ${endpoint} yet`], observed: null };
      }
    } catch (err) {
      last = { ok: false, failures: [String(err.message ?? err)], observed: null };
    }
    if (Date.now() >= deadline) break;
    await sleep(2000);
  }
  return { ...last, attempts };
}

/** ARGUMENTS ARE VALIDATED, AND THAT IS NOT TIDINESS. An unparseable
 *  `--timeout-ms` becomes NaN, `Date.now() < NaN` is false on the first
 *  evaluation, and the probe exits 1 with `attempts: 0` and "the probe never
 *  reached the page" — which at the end of a forty-minute emulator job is
 *  indistinguishable from an app that died on launch. Preserving that
 *  distinction is the entire job of this file, so a bad flag has to fail as a
 *  bad flag. Same for a flag given as the last argument, where `argv[++i]` is
 *  `undefined` and `fetch(undefined + "/json/list")` fails much later. */
export function parseArgs(argv) {
  const out = { endpoint: "http://127.0.0.1:9222", timeoutMs: 90000, out: null };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--endpoint") out.endpoint = value(++i, a);
    else if (a === "--out") out.out = value(++i, a);
    else if (a === "--timeout-ms") out.timeoutMs = Number(value(++i, a));
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive number, got ${JSON.stringify(out.timeoutMs)}`);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const title = expectedTitle();
  const result = await probe({ endpoint: args.endpoint, timeoutMs: args.timeoutMs, title });
  const report = { expectedTitle: title, endpoint: args.endpoint, ...result };
  const json = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(args.out, json + "\n", "utf8");
  console.log(json);
  if (!result.ok) {
    console.error("\nthe app did not launch into a usable state:");
    for (const f of result.failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`\nthe WebView is running the bundled app and ForayAudio answered from Java`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (err) => {
      /* WITHOUT THIS, a throw from `parseArgs` or a missing `index.html` is an
         unhandled rejection: a stack trace where every other failure in this
         file is a sentence, at the point a human is trying to tell "we could
         not ask" from "the app did not answer". */
      console.error(String(err?.message ?? err));
      process.exit(2);
    }
  );
}
