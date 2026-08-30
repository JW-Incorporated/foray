/* `tools/mobile/webview-probe.mjs` — the verdict logic behind the launch check.
 *
 * BE HONEST ABOUT WHAT THIS FILE CAN AND CANNOT DO. It cannot start an emulator,
 * so it cannot tell you the app launches — only the `android-smoke` job can, and
 * `android-release.yml` is where that lives. What it CAN do is pin the part of
 * the probe that decides PASS or FAIL, and that part is the whole risk: a probe
 * whose verdict is too generous reports a launch for a page that never loaded,
 * which is worse than no check at all because it comes with a green tick and a
 * JSON report.
 *
 * THE FIXTURE IS THE HAZARD HERE, TOO. CLAUDE.md § "A green test is not evidence
 * until you have broken it" records five suites where the fake answered the way
 * the real thing cannot — #269's Android fixture answering `running: true` is the
 * closest relative of this file. So the negative fixtures below are the shapes a
 * BROKEN launch actually produces, taken from what the platform really does:
 * `about:blank` before the load, `chrome-error://chromewebdata/` for a failed
 * one, an intact document with an EMPTY `#view` when scripts do not run, and a
 * bridge that rejects rather than one that is absent.
 *
 * EVERY TEST NAMES THE ONE-LINE MUTATION THAT BREAKS IT, AND ALL WERE RUN.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EXPECTED_HOST,
  PROBE_EXPRESSION,
  evaluate,
  expectedTitle,
  parseArgs,
  pickPage,
  titleOf,
  verdict,
} from "./webview-probe.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** What a HEALTHY launch reports. Every negative case below is this, with one
 *  field changed — so a test that fails is naming exactly one defect. */
const HEALTHY = {
  url: "https://localhost/",
  title: "4a",
  readyState: "complete",
  viewPresent: true,
  viewChildren: 3,
  viewText: "Today",
  hasCapacitor: true,
  plugins: ["App", "ForayAudio", "Preferences", "SplashScreen", "StatusBar"],
  bridge: { running: false, platform: "android", sessionActive: false },
};

const opts = { expectedTitle: "4a" };

test("a healthy launch passes, and passes for the right reasons", () => {
  /* MUTATION: change `verdict` to always return `{ok:false}` -> fails.
     The positive case is asserted first so every negative case below means "this
     one field flipped the verdict" rather than "the verdict is always false". */
  const v = verdict(HEALTHY, opts);
  assert.deepEqual(v.failures, []);
  assert.equal(v.ok, true);
});

test("about:blank is a FAILURE, not a launch", () => {
  /* MUTATION: delete the hostname check from `verdict` -> fails.
     THE SINGLE MOST LIKELY FALSE PASS. A WebView exposes a DevTools target as
     soon as it exists, which is BEFORE the page loads, so a probe that connects
     early and asks no questions gets a perfectly healthy answer from
     `about:blank`. Every other field on that page is also innocuous — no title,
     no `#view`, no Capacitor — so several checks fire at once, which is the
     point: this failure is over-determined by design. */
  const v = verdict({ ...HEALTHY, url: "about:blank", title: "", viewPresent: false, hasCapacitor: false, bridge: null }, opts);
  assert.equal(v.ok, false);
  assert.match(v.failures.join(" "), /about:blank/);
});

test("a WebView error page is a FAILURE", () => {
  /* MUTATION: accept any URL whose hostname is non-empty -> fails.
     `chrome-error://chromewebdata/` is what a failed load shows, and it is the
     symptom of a webDir that copied nothing — which is a real failure mode here,
     because `mobile/www/` is deleted and rebuilt by `prepare-webdir.mjs` on
     every build. */
  const v = verdict({ ...HEALTHY, url: "chrome-error://chromewebdata/" }, opts);
  assert.equal(v.ok, false);
  assert.match(v.failures.join(" "), /chrome-error/);
});

test("a page on the right host but the wrong path fails", () => {
  /* MUTATION: delete the pathname check -> fails.
     Capacitor serves the whole bundle, so `https://localhost/player/foo.html` is
     a real reachable URL on the right host. A probe that only checked the
     hostname would certify a launch that landed on a sub-page. `/index.html` is
     accepted alongside `/` because both are the bundled entry point. */
  assert.equal(verdict({ ...HEALTHY, url: "https://localhost/player/probe-seam.html" }, opts).ok, false);
  assert.equal(verdict({ ...HEALTHY, url: "https://localhost/index.html" }, opts).ok, true);
});

test("index.html parsed but app.js never ran is a FAILURE", () => {
  /* MUTATION: delete the `viewChildren > 0` check -> fails.
     THE CHECK THAT SEES A LOADED-BUT-DEAD PAGE, and the reason it is worth
     having separately from the URL check. `<main id="view">` is EMPTY in the
     committed `index.html`; only `app.js` fills it. A CSP that blocked
     `script-src 'self'` inside the shell, a webDir missing `app.js`, or a throw
     during boot all leave the URL right, the title right, the markup intact and
     this count at zero — a page that looks launched and does nothing. */
  const v = verdict({ ...HEALTHY, viewChildren: 0, viewText: "" }, opts);
  assert.equal(v.ok, false);
  assert.match(v.failures.join(" "), /app\.js never rendered/);
  /* And a document with no `#view` at all is a different failure with its own
     message: that is not this app's index.html. */
  const w = verdict({ ...HEALTHY, viewPresent: false, viewChildren: -1 }, opts);
  assert.match(w.failures.join(" "), /not in the document/);
});

test("a missing window.Capacitor is a FAILURE", () => {
  /* MUTATION: delete the `hasCapacitor` check -> fails.
     `docs/mobile-shell.md`'s top open risk is whether our strict CSP blocks
     Capacitor's injected bridge, and `docs/android-shell-build.md` §3 says the
     Android verdict is INFERRED FROM SOURCE with nothing executed. This field is
     the executed version of that question, so it has to be able to answer no. */
  const v = verdict({ ...HEALTHY, hasCapacitor: false }, opts);
  assert.equal(v.ok, false);
  assert.match(v.failures.join(" "), /window\.Capacitor is absent/);
});

test("the bridge must answer from OUR Java, not merely answer", () => {
  /* MUTATION: change the bridge check to `if (!bridge) failures.push(...)`
     -> fails.
     `platform: "android"` IS SET IN `ForayAudioPlugin.java` AND NOWHERE ELSE.
     That is what makes this an assertion about the round trip rather than about
     the shape of a reply: a Capacitor stub, a web fallback, or a plugin that
     resolved an empty object would all satisfy "something came back". This is
     the closest relative in the repo of #269, where an Android fixture answered
     `running: true` and the fake was the only place the code worked. */
  assert.equal(verdict({ ...HEALTHY, bridge: {} }, opts).ok, false);
  assert.equal(verdict({ ...HEALTHY, bridge: { platform: "web" } }, opts).ok, false);
  assert.equal(verdict({ ...HEALTHY, bridge: null }, opts).ok, false);
  const rejected = verdict({ ...HEALTHY, bridge: { error: "ForayAudio does not have a state method" } }, opts);
  assert.equal(rejected.ok, false);
  assert.match(rejected.failures.join(" "), /does not have a state method/);
  /* `running: false` is a PASS. The service is not started at launch, so a
     verdict that required `running: true` would be the #269 fixture again, in
     the other direction — a check that only the fake can satisfy. */
  assert.equal(verdict({ ...HEALTHY, bridge: { platform: "android", running: false } }, opts).ok, true);
});

test("the expected title comes from the repo's own index.html", () => {
  /* MUTATION: hardcode `"4a"` in `expectedTitle` -> fails the day the app is
     renamed, which is the point.
     "The WebView shows a page called 4a" and "the WebView shows THIS repo's
     index.html" are different claims, and only the second one is worth a
     40-minute emulator boot. Reading the title out of the source also means a
     deliberate rename does not turn the smoke test red in a PR that never
     touched the shell. */
  const real = expectedTitle(ROOT);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.equal(real, titleOf(html));
  assert.ok(real.length > 0);
  assert.equal(titleOf("<html><head></head></html>"), null);
  assert.equal(titleOf("<title>  spaced  </title>"), "spaced");
  /* A DIFFERENT TITLE MUST FAIL, or reading it from the source bought nothing. */
  assert.equal(verdict(HEALTHY, { expectedTitle: "something else" }).ok, false);
});

test("pickPage prefers the page on our host over anything else exposed", () => {
  /* MUTATION: change `pickPage` to `targets[0]` -> fails.
     A WebView host exposes more than one DevTools target — a service worker, and
     an `about:blank` shell that exists before the load. PICKING THE FIRST ONE is
     how a probe ends up interrogating the blank page and reporting whatever that
     page says, which is the vacuity this whole suite is arranged around. */
  const targets = [
    { type: "service_worker", url: "https://localhost/sw.js", webSocketDebuggerUrl: "ws://sw" },
    { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
    { type: "page", url: "https://localhost/", webSocketDebuggerUrl: "ws://app" },
  ];
  assert.equal(pickPage(targets).webSocketDebuggerUrl, "ws://app");
  /* WITH NO TARGET ON OUR HOST IT STILL RETURNS A PAGE, deliberately: the
     verdict above then reports "the WebView is on about:blank", which is a
     diagnosis. Returning null there would report "no target", which is the same
     message whether the app crashed or the page simply has not loaded yet. */
  assert.equal(pickPage(targets.slice(0, 2)).webSocketDebuggerUrl, "ws://blank");
  assert.equal(pickPage([targets[0]]), null, "a service worker is not a page");
  assert.equal(pickPage([]), null);
  assert.equal(pickPage(null), null);
  /* A page with no websocket URL cannot be evaluated, so it is not a candidate. */
  assert.equal(pickPage([{ type: "page", url: "https://localhost/" }]), null);
});

test("garbage in is a failure, not a crash", () => {
  /* MUTATION: delete the `typeof observed !== "object"` guard -> fails with a
     TypeError instead of a verdict.
     `Runtime.evaluate` returns `null` when the page is gone mid-probe, which is
     exactly the case where a readable message matters most: the alternative is a
     stack trace from the probe standing in for a diagnosis of the app. */
  for (const bad of [null, undefined, "", 42]) {
    const v = verdict(bad, opts);
    assert.equal(v.ok, false);
    assert.equal(v.failures.length, 1);
  }
});

test("the injected expression still asks for everything the verdict judges", () => {
  /* MUTATION: delete the `bridge` assignment from PROBE_EXPRESSION -> fails.
     THE TWO HALVES CAN DRIFT APART SILENTLY AND THE DRIFT IS INVISIBLE: if the
     expression stops collecting a field, `observed.bridge` is `undefined`, and
     `verdict` then reports a failure — so this would go RED rather than green,
     which is survivable. The dangerous direction is a field quietly renamed on
     both sides into something the real page does not have. Pinning the names
     here is what keeps the two files describing the same measurement.
     ASSERTED AGAINST THE EXPRESSION, NOT THE FILE: the module's header discusses
     every one of these fields by name, so a whole-file search would be satisfied
     by the prose that explains them. */
  for (const field of ["url", "title", "viewPresent", "viewChildren", "hasCapacitor", "bridge"]) {
    assert.ok(PROBE_EXPRESSION.includes(`${field}:`), `the probe no longer collects ${field}`);
  }
  assert.ok(
    PROBE_EXPRESSION.includes("nativePromise('ForayAudio', 'state', {})"),
    "the bridge call must be ForayAudio.state — the one plugin method with no side effects"
  );
  assert.ok(PROBE_EXPRESSION.includes("#view"), "the render check must read #view");
  /* AND IT MUST NOT THROW ITS WAY OUT OF THE MEASUREMENT. A bridge that rejects
     has to become a reported failure, not an exception that loses the other five
     fields — the report of a broken launch is the most valuable one there is. */
  assert.ok(PROBE_EXPRESSION.includes("catch"), "a rejecting bridge must be caught and reported");
});

test("a Node with no global WebSocket says so, instead of failing as a dead app", async (t) => {
  /* MUTATION: delete the `typeof globalThis.WebSocket !== "function"` guard
     -> fails (with a TypeError from `new undefined(...)` rather than a verdict).
     THE ONE ENVIRONMENTAL ASSUMPTION IN THE WHOLE PROBE. Node has provided a
     global `WebSocket` since 22, and `android-release.yml` asks for 22 — but a
     runner image change, or a future workflow edit that drops the node version to
     match something else, would take the evaluate path away. Without the guard
     that surfaces at the end of a forty-minute emulator job as a stack trace,
     which reads exactly like a crashed app: the difference between "we could not
     ask" and "the app did not answer" is the entire value of the run.
     THE REST OF `evaluate()` IS NOT COVERED and this is where that is said: the
     socket handshake and the CDP message loop need a live DevTools endpoint, and
     the honest place they are exercised is the smoke job itself. */
  const saved = globalThis.WebSocket;
  t.after(() => {
    if (saved === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = saved;
  });
  delete globalThis.WebSocket;
  await assert.rejects(() => evaluate("ws://127.0.0.1:9222/x", "1+1"), /no global WebSocket/);
});

test("a bad --timeout-ms is refused, instead of silently reporting a dead app", () => {
  /* MUTATION: delete the `Number.isFinite(out.timeoutMs)` check -> fails.
     THE SUBTLEST FAILURE IN THIS FILE, and a reviewer found it. `Number("soon")`
     is NaN, `Date.now() < NaN` is false on the FIRST evaluation, so the probe
     loop never runs once: it exits 1 with `attempts: 0` and "the probe never
     reached the page". At the end of a forty-minute emulator job that is
     indistinguishable from an app that died on launch — and preserving exactly
     that distinction is what this whole module is for. A flag with no value has
     the same shape: `--endpoint` last makes `endpoint` undefined, and the
     failure arrives much later wearing a different face. */
  assert.equal(parseArgs(["--timeout-ms", "1000"]).timeoutMs, 1000);
  assert.throws(() => parseArgs(["--timeout-ms", "soon"]), /positive number/);
  assert.throws(() => parseArgs(["--timeout-ms", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--timeout-ms", "-5"]), /positive number/);
  assert.throws(() => parseArgs(["--endpoint"]), /--endpoint needs a value/);
  assert.throws(() => parseArgs(["--out", "--timeout-ms", "10"]), /--out needs a value/);
  assert.throws(() => parseArgs(["--wat"]), /unknown argument --wat/);
  /* And the defaults are the ones the workflow relies on. */
  const d = parseArgs([]);
  assert.equal(d.endpoint, "http://127.0.0.1:9222");
  assert.ok(d.timeoutMs > 0);
});

test("a socket that closes without answering fails immediately, not on the timer", async () => {
  /* MUTATION: delete the `close` listener from `evaluate` -> this test times out
     rather than resolving, which node:test reports as a failure.
     A DESTROYED WEBVIEW TARGET CLOSES CLEANLY — no `error` event. The page
     navigated, the activity was recreated, `adb forward` dropped: all of them
     land here, and without the listener the promise sits until the 30 s timer
     and the report says "Runtime.evaluate timed out", which is a wrong diagnosis
     of a real event. The fake below is deliberately the HOSTILE shape — it opens
     and then closes, answering nothing — because a fake that answers is the one
     that makes this test vacuous. */
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => {
        this.listeners.open?.();
        queueMicrotask(() => this.listeners.close?.({ code: 1006 }));
      });
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    send() {}
    close() {}
  };
  try {
    await assert.rejects(() => evaluate("ws://127.0.0.1:9222/x", "1+1", 60000), /closed before answering/);
  } finally {
    globalThis.WebSocket = saved;
  }
});

test("the expected host is the one Capacitor actually serves from on Android", () => {
  /* MUTATION: change EXPECTED_HOST to "capacitor" (the iOS scheme's host)
     -> fails.
     `CapConfig`'s defaults are hostname `localhost` and androidScheme `https`,
     and `mobile/capacitor.config.json` overrides neither — index.html's own CSP
     comment records that the two platforms differ here, which is exactly the
     kind of detail that gets copied from the wrong side. */
  assert.equal(EXPECTED_HOST, "localhost");
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile/capacitor.config.json"), "utf8"));
  assert.equal(config.server?.hostname ?? "localhost", EXPECTED_HOST);
});
