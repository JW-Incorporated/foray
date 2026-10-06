/* player/deadline.js — the one "race a promise against a deadline" and the one
   REAL_SCHEDULER (code-health CH-40, P2-05).

   What is pinned here: the helper's own contract, with a hand-driven
   scheduler (fallback vs reject on the clock, onTimeout before the settle, the
   inner rejection propagated, the bound cancelled on EVERY settle, no bound for
   a bound that is not a finite positive number, a scheduler that cannot arm or
   cancel never costing the answer); the real scheduler; build-stamp.js's local
   copy pinned equal to it; and that the copies stay gone. Each site's own
   visible contract is pinned in its own suite (the eight "CH-40
   characterization" tests, which landed before this module did).

   Every test names the one-line mutation that turns it red; each was run. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withinMs, REAL_SCHEDULER } from "./deadline.js";
import { withinMs as buildStampWithinMs } from "./build-stamp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A scheduler driven by hand: nothing fires until `fire()`; `live` counts the
    timers armed and neither fired nor cancelled. */
function handScheduler() {
  const pending = [];
  return {
    armed: [],
    schedule(ms, fn) {
      const entry = { ms, fn, dead: false };
      pending.push(entry);
      this.armed.push(ms);
      return () => { entry.dead = true; };
    },
    fire() {
      for (const e of [...pending]) {
        if (e.dead) continue;
        e.dead = true;
        e.fn();
      }
    },
    get live() { return pending.filter((e) => !e.dead).length; },
  };
}

const settleTurns = () => new Promise((r) => setImmediate(r));
const never = () => new Promise(() => {});

test("on the clock the race RESOLVES with the fallback (null by default), and an answer first wins", async () => {
  /* MUTATION: resolve the clock with `undefined` instead of `fallback` -> the
     first two assertions fail. */
  const s1 = handScheduler();
  const p1 = withinMs(never(), 50, { scheduler: s1 });
  s1.fire();
  assert.equal(await p1, null);

  const s2 = handScheduler();
  const fb = { ok: false, reason: "timeout" };
  const p2 = withinMs(never(), 50, { fallback: fb, scheduler: s2 });
  s2.fire();
  assert.equal(await p2, fb, "the caller's own object, as given");

  const s3 = handScheduler();
  const p3 = withinMs(Promise.resolve("answer"), 50, { fallback: "late", scheduler: s3 });
  assert.equal(await p3, "answer");
  s3.fire();
  assert.equal(await p3, "answer", "a clock after the answer changes nothing");
  assert.deepEqual(s1.armed, [50]);
});

test("`reject` makes the clock REJECT with the factory's error, built only when the clock fires", async () => {
  /* durable-store's TimeoutError shape. MUTATION: ignore `reject` (resolve the
     fallback) -> the race resolves null and `assert.rejects` fails. */
  let built = 0;
  const reject = () => { built += 1; return Object.assign(new Error("idb did not answer within 50 ms"), { name: "TimeoutError" }); };
  const s = handScheduler();
  const p = withinMs(never(), 50, { reject, scheduler: s });
  assert.equal(built, 0, "not built before the clock");
  s.fire();
  await assert.rejects(p, { name: "TimeoutError", message: "idb did not answer within 50 ms" });
  assert.equal(built, 1);

  const answered = handScheduler();
  assert.equal(await withinMs(Promise.resolve(7), 50, { reject, scheduler: answered }), 7);
  assert.equal(built, 1, "an answered race never builds the error");
});

test("onTimeout runs when the clock wins and only then, and its throw is swallowed", async () => {
  /* foray-directory aborts its request here. MUTATIONS: drop the onTimeout
     call -> `calls` is 0 after the clock; drop its try -> the race never
     settles and the clock's answer is lost. */
  let calls = 0;
  const s = handScheduler();
  const p = withinMs(never(), 50, { fallback: "fb", scheduler: s, onTimeout: () => { calls += 1; throw new Error("abort threw"); } });
  try { s.fire(); } catch (_) { /* the mutation without the try throws here */ }
  const out = await Promise.race([p, settleTurns().then(() => "unsettled")]);
  assert.equal(out, "fb", "the clock's answer stands");
  assert.equal(calls, 1);

  let answeredCalls = 0;
  const s2 = handScheduler();
  await withinMs(Promise.resolve(1), 50, { scheduler: s2, onTimeout: () => { answeredCalls += 1; } });
  s2.fire();
  assert.equal(answeredCalls, 0, "never for an answered race");
});

test("the inner rejection PROPAGATES; a caller that swallows does it before the race", async () => {
  /* build-stamp, durable-store and client.js's voice lookup rely on the
     rejection reaching their own catch. MUTATION: settle a rejection with the
     fallback -> `assert.rejects` fails. */
  const s = handScheduler();
  await assert.rejects(withinMs(Promise.reject(new Error("bridge gone")), 50, { fallback: "fb", scheduler: s }), /bridge gone/);
  assert.equal(s.live, 0, "a rejection cancels the bound too");
  const swallowed = withinMs(Promise.reject(new Error("x")).catch(() => "fb"), 50, { fallback: "fb", scheduler: handScheduler() });
  assert.equal(await swallowed, "fb");
});

test("no live timer after settle: the bound is cancelled on an answer, a rejection and the clock", async () => {
  /* MUTATION (the card's): forget the `cancel()` in `settle` -> `live` is 1
     after the answered and the rejected race. */
  const answered = handScheduler();
  await withinMs(Promise.resolve("a"), 50, { scheduler: answered });
  assert.equal(answered.live, 0, "answered");

  const rejected = handScheduler();
  await withinMs(Promise.reject(new Error("r")), 50, { scheduler: rejected }).catch(() => {});
  assert.equal(rejected.live, 0, "rejected");

  const clocked = handScheduler();
  const p = withinMs(never(), 50, { scheduler: clocked });
  assert.equal(clocked.live, 1, "armed while pending");
  clocked.fire();
  await p;
  assert.equal(clocked.live, 0, "fired");
});

test("a bound that is not a finite positive number is NO bound: nothing is armed and the promise comes back as it is", async () => {
  /* MUTATION: guard with `!(ms > 0)` alone -> Infinity arms a timer (Node
     clamps it to 1 ms: an instant timeout, not none). */
  for (const ms of [Infinity, 0, -5, NaN, undefined, "50"]) {
    const s = handScheduler();
    const inner = Promise.resolve("answer");
    const out = withinMs(inner, ms, { fallback: "fb", scheduler: s });
    assert.equal(out, inner, `${String(ms)}: the same promise`);
    assert.deepEqual(s.armed, [], `${String(ms)}: nothing armed`);
  }
  assert.equal(await withinMs(42, Infinity), 42, "a plain value is answered as a promise");
});

test("a scheduler that cannot arm means no bound, never a lost answer; a cancel that throws is swallowed", { timeout: 5000 }, async () => {
  /* download-bridge's injected timer pair. MUTATIONS: drop the try around
     `scheduler.schedule` -> the first race rejects; drop the try around
     `cancel()` -> the second never settles (the test's timeout is the red). */
  const noTimer = { schedule() { throw new Error("no timers here"); } };
  assert.equal(await withinMs(Promise.resolve("answer"), 50, { scheduler: noTimer }), "answer");
  const badCancel = { schedule() { return () => { throw new Error("cannot clear"); }; } };
  assert.equal(await withinMs(Promise.resolve("answer"), 50, { scheduler: badCancel }), "answer");
  /* A scheduler that fires inside schedule() (not setTimeout semantics, but a
     fake might) settles on the clock and still has its timer cancelled. */
  let cancelled = 0;
  const sync = { schedule(_ms, fn) { fn(); return () => { cancelled += 1; }; } };
  assert.equal(await withinMs(never(), 50, { fallback: "fb", scheduler: sync }), "fb");
  assert.equal(cancelled, 1);
});

test("REAL_SCHEDULER is the wall clock with real, cancellable, never-unref'd timers, frozen, and withinMs's default", async () => {
  /* MUTATIONS: `nowMs: () => 0` -> the clock assertion fails; a no-op cancel
     -> the cancelled timer fires; `.unref()` the timer -> `unrefd` is true;
     default `scheduler` to anything else -> `armed` is empty. */
  assert.ok(Object.isFrozen(REAL_SCHEDULER));
  const before = Date.now();
  const at = REAL_SCHEDULER.nowMs();
  assert.ok(at >= before && at <= Date.now());

  const realSet = globalThis.setTimeout;
  const armed = [];
  let unrefd = false;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const h = realSet(fn, ms, ...args);
    armed.push(ms);
    const unref = h.unref.bind(h);
    h.unref = () => { unrefd = true; return unref(); };
    return h;
  };
  let fired = 0;
  try {
    const cancel = REAL_SCHEDULER.schedule(10, () => { fired += 1; });
    REAL_SCHEDULER.schedule(10, () => { fired += 10; });
    cancel();
    assert.equal(await withinMs(Promise.resolve("answer"), 4321), "answer");
  } finally { globalThis.setTimeout = realSet; }
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 10, "the cancelled timer did not fire; the other did");
  assert.deepEqual(armed, [10, 10, 4321], "withinMs arms through REAL_SCHEDULER by default");
  assert.equal(unrefd, false, "never unref'd");
});

test("build-stamp.js's local copy answers exactly what withinMs answers with its default fallback", { timeout: 5000 }, async () => {
  /* The copy is kept because build-stamp.js runs in the release signing jobs
     (deadline.js's header). This is what stops it drifting. MUTATIONS: make
     build-stamp's copy swallow a rejection, or answer `undefined` on the
     clock, or bound Infinity -> the row for that case differs. */
  const outcome = (p) => p.then((v) => ["resolved", v], (e) => ["rejected", e?.message ?? e]);
  const cases = [
    ["answers in time", () => Promise.resolve("answer"), 200],
    ["rejects in time", () => Promise.reject(new Error("no file")), 200],
    ["never answers", never, 15],
    ["answers after the bound", () => new Promise((r) => setTimeout(() => r("late"), 60)), 15],
    ["no bound (Infinity)", () => new Promise((r) => setTimeout(() => r("slow"), 30)), Infinity],
    ["no bound (0)", () => Promise.resolve("zero"), 0],
  ];
  for (const [name, make, ms] of cases) {
    const [ours, theirs] = await Promise.all([outcome(withinMs(make(), ms)), outcome(buildStampWithinMs(make(), ms))]);
    assert.deepEqual(theirs, ours, name);
  }
});

test("one owner: no player module defines its own REAL_SCHEDULER, and every swapped site imports deadline.js", () => {
  /* P2-05's failure mode is the next copy. MUTATIONS: paste a local
     `const REAL_SCHEDULER = ...` back into native-engine.js -> the owner list
     grows; put client.js's hand-rolled storageReady race back -> its pin fails. */
  const modules = fs.readdirSync(HERE).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
  const owners = modules.filter((f) => /\b(?:const|let|var)\s+REAL_SCHEDULER\s*=/.test(fs.readFileSync(path.join(HERE, f), "utf8")));
  assert.deepEqual(owners, ["deadline.js"]);
  const importers = [
    "client.js", "download-bridge.js", "durable-store.js", "engine-diagnostics.js", "foray-directory.js",
    "id3-chapters.js", "native-engine.js", "queue-manager.js",
  ];
  for (const f of importers) {
    assert.match(fs.readFileSync(path.join(HERE, f), "utf8"), /^import \{[^}]*\} from "\.\/deadline\.js";$/m, `${f} imports deadline.js`);
  }
  /* build-stamp.js must NOT: it would put deadline.js in the signing jobs. */
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, "build-stamp.js"), "utf8"), /from "\.\/deadline\.js"/);
  /* client.js's two bounds, which have no suite of their own: storageReady is
     `false` on the clock and `true` for a hydration that landed OR failed; the
     voice lookup is null on the clock and lets a rejection through. */
  const client = fs.readFileSync(path.join(HERE, "client.js"), "utf8");
  assert.match(client, /const storageReady = withinMs\(storageHydrated\.then\(\(\) => true, \(\) => true\), HYDRATE_WAIT_MS, \{ fallback: false \}\);/);
  assert.match(client, /return \(await withinMs\(resolveDefaultVoice\(\), VOICE_LOOKUP_BOUND_MS\)\) \?\? null;/);
});
