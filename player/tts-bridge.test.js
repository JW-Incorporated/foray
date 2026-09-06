/* player/tts-bridge.test.js — the wire between the page and on-device speech.
 *
 * WHAT THIS SUITE COVERS AND WHY IT IS WORTH HAVING. `PlayerQueueManager` has
 * accepted a `tts` option, and `_speakNarration` has been complete, since #382.
 * Nothing ever passed one, so `this._tts` was null in every build and the
 * narration path could only ever throw "no on-device TTS plugin wired". A
 * mechanism nothing calls passes every unit test it has, which is exactly the
 * failure mode CLAUDE.md's "a green test is not evidence" section lists five
 * times — so the last test in this file is deliberately a source-level guard on
 * `client.js`'s call site, not on the module in isolation.
 *
 * WHY THE CALL SITE IS ASSERTED FROM SOURCE. `player/client.js` is an ES module
 * that builds DOM and installs `window` listeners at import time, and this repo
 * is dependency-free at the root — there is no jsdom to import it into, and the
 * `vm` harness the `test/*.test.js` suites use for `app.js` works because app.js
 * is a CLASSIC script. So the honest options were "assert the one line from
 * source" or "assert nothing", and the line in question is precisely the one
 * whose absence went unnoticed for months. It is a weak test by construction and
 * it is labelled as one; everything else here is behavioural.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTtsBridge, inShell, SHELL_FIRST, SITE_FIRST } from "./tts-bridge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Node has no `window`. Every test that needs one installs and removes it,
    rather than leaving a global behind for the next file in the same process. */
function withWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const prev = globalThis.window;
  globalThis.window = win;
  try { return fn(); } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

/** A stand-in for the real `foray-tts.js` module: same `speak()` contract
    (resolves, never throws), recording what it was handed. */
function fakeModule() {
  const calls = [];
  return {
    calls,
    speak: async (text, opts) => { calls.push({ text, opts }); return { ok: true, path: "native" }; },
  };
}

/* ---------------------------------------------------------------- inShell */

// TO SEE IT FAIL: make `inShell` return `true` unconditionally.
test("inShell: false in a plain browser tab, true when Capacitor injected a bridge", () => {
  assert.equal(inShell(undefined), false);
  assert.equal(inShell({}), false);
  assert.equal(inShell({ Capacitor: { nativePromise() {} } }), true);
});

// The default argument matters: `client.js` calls `inShell()` with no argument
// on every visibility question, so the no-arg path is the one that ships.
// TO SEE IT FAIL: change the default parameter to `win = undefined`.
test("inShell: reads the ambient window when called with no argument", () => {
  withWindow({ Capacitor: {} }, () => assert.equal(inShell(), true));
  withWindow({}, () => assert.equal(inShell(), false));
});

/* ------------------------------------------------------- which path first */

// The shell and the website hold this module at different URLs — see
// tts-bridge.js's header. Trying them in the wrong order costs a 404 in the one
// place the log is the only evidence anyone has.
// TO SEE IT FAIL: swap the two entries in `SHELL_FIRST`.
test("the shell tries the bundle's flattened copy first; the website tries the plugin's own path first", () => {
  assert.equal(SHELL_FIRST[0], "../foray-tts.js");
  assert.equal(SITE_FIRST[0], "../mobile/plugins/foray-tts/web/foray-tts.js");
  assert.deepEqual([...SHELL_FIRST].sort(), [...SITE_FIRST].sort());
});

// TO SEE IT FAIL: in `loadModule`, replace the ternary with `SITE_FIRST`.
test("the candidate order is chosen from the live window, not baked in at import", async () => {
  const tried = [];
  const load = async (p) => { tried.push(p); return fakeModule(); };

  await withWindow({ Capacitor: {} }, async () => {
    await createTtsBridge({ load }).speak("hi");
  });
  assert.equal(tried[0], SHELL_FIRST[0]);

  tried.length = 0;
  await withWindow({}, async () => {
    await createTtsBridge({ load }).speak("hi");
  });
  assert.equal(tried[0], SITE_FIRST[0]);
});

/* -------------------------------------------------------------- speaking */

// TO SEE IT FAIL: in `speak()`, call `mod.speak(text)` without `opts`.
test("speak: forwards the text AND the options through to the module, and returns its answer", async () => {
  const mod = fakeModule();
  const bridge = createTtsBridge({ load: async () => mod, candidates: ["x"] });

  const out = await bridge.speak("a long line", { rate: 1.5 });

  assert.deepEqual(mod.calls, [{ text: "a long line", opts: { rate: 1.5 } }]);
  assert.deepEqual(out, { ok: true, path: "native" });
});

// A Foray may carry several bridges. Resolving the module once per line would
// mean one network round trip (or one 404) per line spoken.
// TO SEE IT FAIL: move `pending = loadModule()` inside `speak` unconditionally
// (i.e. drop the `if (!pending)` guard).
test("speak: the module is resolved once per bridge, however many lines it speaks", async () => {
  let loads = 0;
  const mod = fakeModule();
  const bridge = createTtsBridge({
    load: async () => { loads += 1; return mod; },
    candidates: ["x"],
  });

  await bridge.speak("one");
  await bridge.speak("two");
  await bridge.speak("three");

  assert.equal(loads, 1);
  assert.equal(mod.calls.length, 3);
});

// TO SEE IT FAIL: `return` instead of `continue`-ing past a rejected candidate
// (i.e. drop the try/catch and let the first failure escape the loop).
test("speak: a candidate that 404s falls through to the next one", async () => {
  const mod = fakeModule();
  const bridge = createTtsBridge({
    candidates: ["gone", "here"],
    load: async (p) => { if (p === "gone") throw new Error("404"); return mod; },
    log: () => {},
  });

  const out = await bridge.speak("hello");

  assert.equal(out.ok, true);
  assert.deepEqual(mod.calls.map((c) => c.text), ["hello"]);
});

// The whole point of the `{ ok: false }` shape: `_speakNarration` turns it into
// the queue's ordinary load-failure path, so a Foray with one unspeakable line
// reports that line and keeps going. A THROW here would take the load path down
// a different, untested branch.
// TO SEE IT FAIL: `throw new Error(...)` instead of returning `{ ok: false }`
// when `mod` is null.
test("speak: nothing loadable at all resolves { ok: false } and never rejects", async () => {
  const bridge = createTtsBridge({
    candidates: ["a", "b"],
    load: async () => { throw new Error("no such module"); },
    log: () => {},
  });

  const out = await bridge.speak("hello");

  assert.equal(out.ok, false);
  assert.equal(out.path, "none");
  assert.match(out.reason, /could not be loaded/);
});

// A module that loads but does not export `speak()` is a wrong file, not a
// working plugin — treating it as one would call `undefined()` at the moment a
// listener is waiting for a voice.
// TO SEE IT FAIL: drop the `typeof mod.speak === "function"` clause.
test("speak: a module with no speak() is a miss, not a crash", async () => {
  const good = fakeModule();
  const bridge = createTtsBridge({
    candidates: ["wrong", "right"],
    load: async (p) => (p === "wrong" ? { somethingElse: 1 } : good),
    log: () => {},
  });

  const out = await bridge.speak("hello");

  assert.equal(out.ok, true);
  assert.equal(good.calls.length, 1);
});

// TO SEE IT FAIL: remove the try/catch around the `warn(...)` call in
// `loadModule` — `speak()` then rejects instead of resolving { ok: false }.
test("a throwing logger must not break the failure path", async () => {
  const bridge = createTtsBridge({
    candidates: ["a"],
    load: async () => { throw new Error("nope"); },
    log: () => { throw new Error("the logger is broken too"); },
  });

  const out = await bridge.speak("hi");

  assert.equal(out.ok, false);
  assert.equal(out.path, "none");
});

/* ------------------------------------------------------------- listVoices

   Threaded through this file because the module is resolved HERE — see
   `tts-bridge.js`'s own comment on the method. */

// TO SEE IT FAIL: in `listVoices()`, call `mod.listVoices()` with no argument.
// The `{ lang }` filter is dropped and a device report comes back listing every
// language the phone has, which is the wrong answer for the one question it is
// asked ("what do I have for English?").
test("listVoices: forwards options to the module and returns its answer", async () => {
  const seen = [];
  const mod = {
    speak: async () => ({ ok: true }),
    listVoices: async (opts) => { seen.push(opts); return { ok: true, voices: [{ identifier: "v1" }] }; },
  };
  const bridge = createTtsBridge({ load: async () => mod, candidates: ["x"] });

  const out = await bridge.listVoices({ lang: "en-US" });

  assert.deepEqual(seen, [{ lang: "en-US" }]);
  assert.equal(out.voices[0].identifier, "v1");
});

// The real case, not a hypothetical: `tools/mobile/prepare-webdir.mjs` copies a
// FLATTENED snapshot of `foray-tts.js` into the shell bundle at build time, so a
// shell built before `listVoices` existed loads a module that has `speak` and
// nothing else.
// TO SEE IT FAIL: delete the `typeof mod.listVoices !== "function"` guard —
// this throws a TypeError out of a method whose whole contract is that it
// resolves.
test("listVoices: an older module without the method reports that, rather than throwing", async () => {
  const bridge = createTtsBridge({ load: async () => fakeModule(), candidates: ["x"] });

  const out = await bridge.listVoices();

  assert.equal(out.ok, false);
  assert.deepEqual(out.voices, []);
  assert.match(out.reason, /listVoices/);
});

// TO SEE IT FAIL: in `listVoices()`, drop the `if (!mod)` branch — a page with
// no reachable module rejects instead of answering.
test("listVoices: an unreachable module resolves { ok: false }, never rejects", async () => {
  const bridge = createTtsBridge({
    candidates: ["a"],
    load: async () => { throw new Error("404"); },
    log: () => {},
  });

  const out = await bridge.listVoices();

  assert.equal(out.ok, false);
  assert.equal(out.path, "none");
});

/* ------------------------------------------------- the call site in client.js

   Not a behavioural test. See this file's header for why it is here anyway. */

// TO SEE IT FAIL: delete the `tts: createTtsBridge(),` line from client.js's
// `new PlayerQueueManager({ ... })` call. That deletion is the exact state
// `main` was in before this change, and no other test in this repo turns red
// for it.
test("client.js actually passes a TTS bridge into the queue manager", () => {
  const src = fs.readFileSync(path.join(HERE, "client.js"), "utf8");

  assert.match(src, /import \{[^}]*createTtsBridge[^}]*\} from "\.\/tts-bridge\.js";/,
    "client.js does not import createTtsBridge");

  const call = src.slice(src.indexOf("new PlayerQueueManager({"));
  assert.ok(call.startsWith("new PlayerQueueManager({"), "no `new PlayerQueueManager({` in client.js");
  const args = call.slice(0, call.indexOf("\n  });"));
  assert.match(args, /\btts:\s*createTtsBridge\(\)/,
    "the queue manager is built without a `tts` bridge — a script-only narration item cannot be spoken");
});
