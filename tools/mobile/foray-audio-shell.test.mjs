/* The web half of `foray-audio`: the state machine that starts and stops the
 * native `mediaPlayback` foreground service.
 *
 * WHAT THIS SUITE IS WORTH, STATED FIRST. It drives the real
 * `mobile/plugins/foray-audio/web/foray-audio-shell.js` against a fake bridge, a
 * fake `HTMLMediaElement.prototype` and a fake clock, in Node. So it proves the
 * STATE MACHINE and it proves nothing whatsoever about Android: no WebView ran, no
 * foreground service started, and `docs/android-native-code.md` § what is measured
 * says so in the same words. A green run here is compatible with the service never
 * starting on a device.
 *
 * WHAT IT IS DESIGNED TO CATCH, which is the part a fake CAN catch:
 *
 *   1. THE THREE RULES THE WRAPPER OWES THE PLAYER. It patches
 *      `HTMLMediaElement.prototype.play`, which `player/html-audio-backend.js`
 *      calls at every out-point, so: it calls through exactly once, it returns the
 *      original's return value by IDENTITY, and it never touches that value. The
 *      third is checked with a thenable that records whether `.then` was read —
 *      attaching a handler to a `play()` promise would mark a rejection handled and
 *      silently delete a console warning the player's author relies on.
 *   2. A THROW IN OUR BOOKKEEPING MUST NOT COST A `play()`. Two independent
 *      injected failures (a listener registration that throws, a clock that
 *      throws), and in both the real `play` still runs.
 *   3. THE SEAM. A stop at the top of a hidden seam would be followed by a start
 *      Android is allowed to refuse, so the settle window must survive a pause
 *      followed by a play. Tested as the sequence, not as a constant.
 *   4. THE REFUSED PLAY. An autoplay-blocked `play()` leaves `paused === true` and
 *      fires no event, so the element must be pruned and the service must never
 *      start. Deleting the prune makes the service run forever, and this is the
 *      test that says so.
 *
 * ADVERSARIAL PASS, and every hole below is now a named test. Each of these is a
 * one-line deletion that left an earlier draft of the suite green:
 *   - deleting `cancelStop()` from `reconcile` — the service still stopped mid-seam,
 *     because nothing asserted the ARMED TIMER goes away when playback resumes.
 *   - deleting the `paused || ended` prune in `activeCount` — no test played an
 *     element that refused to start.
 *   - `serviceRunning = true` unconditionally in the `start` handler — nothing
 *     exercised a start that Android REFUSED, so nothing noticed that the next
 *     `play()` no longer retried.
 *   - returning a fresh promise from the wrapper instead of the original's value —
 *     an equality assertion on the resolved value passed; an identity assertion on
 *     the returned object does not.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createForayAudioShell,
  shellApplies,
  PLUGIN_NAME,
  STOP_SETTLE_MS,
  RELEASE_EVENTS,
  ACQUIRE_EVENTS,
} from "../../mobile/plugins/foray-audio/web/foray-audio-shell.js";

/* ------------------------------------------------------------------- fakes */

/** A fake `HTMLMediaElement.prototype`. `play()` does what a real one does that we
 *  care about: it flips `paused` to false SYNCHRONOUSLY before returning. Every
 *  prune in the shell depends on that ordering being real. */
function makeProto(overrides = {}) {
  const proto = {
    play() {
      this.playCalls++;
      this.playArgs.push([...arguments]);
      this.paused = false;
      return this.playReturns;
    },
    addEventListener(name, fn) {
      if (this.throwOnAddListener) throw new Error("addEventListener exploded");
      (this._listeners[name] = this._listeners[name] || []).push(fn);
    },
    removeEventListener(name, fn) {
      const list = this._listeners[name] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
  };
  return Object.assign(proto, overrides);
}

function makeElement(proto, { playReturns = { ok: true } } = {}) {
  const el = Object.create(proto);
  el.paused = true;
  el.ended = false;
  el.playCalls = 0;
  el.playArgs = [];
  el.playReturns = playReturns;
  el._listeners = {};
  el.emit = function (name) {
    for (const fn of [...(this._listeners[name] || [])]) fn({ type: name, target: this });
  };
  return el;
}

/** A bridge that records every call. `results` maps a method name to what native
 *  answers with; the defaults are the happy path. */
function makeCapacitor({ platform = "android", results = {}, throwOnGetPlatform = false, omitNativePromise = false } = {}) {
  const calls = [];
  const bridge = {
    calls,
    getPlatform() {
      if (throwOnGetPlatform) throw new Error("bridge not ready");
      return platform;
    },
  };
  if (!omitNativePromise) {
    bridge.nativePromise = (name, method) => {
      calls.push({ name, method });
      const answer = Object.prototype.hasOwnProperty.call(results, method)
        ? results[method]
        : method === "start"
          ? { started: true, running: true, reason: "" }
          : { stopped: true, running: false, reason: "" };
      if (typeof answer === "function") return answer();
      return Promise.resolve(answer);
    };
  }
  return bridge;
}

function makeClock({ throwOnSet = false } = {}) {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      if (throwOnSet) throw new Error("setTimeout exploded");
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    ids() {
      return [...timers.keys()];
    },
    delays() {
      return [...timers.values()].map((t) => t.ms);
    },
    fireAll() {
      for (const id of [...timers.keys()]) {
        const t = timers.get(id);
        timers.delete(id);
        t.fn();
      }
    },
  };
}

function makeDoc(visibilityState = "hidden") {
  const listeners = {};
  return {
    visibilityState,
    addEventListener(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    removeEventListener(name, fn) {
      const list = listeners[name] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    listenerCount(name) {
      return (listeners[name] || []).length;
    },
    emit(name) {
      for (const fn of [...(listeners[name] || [])]) fn({ type: name });
    },
  };
}

/** The shell talks to native through promises, so every assertion about a native
 *  call's RESULT has to come after the microtask queue drains. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(opts = {}) {
  const proto = makeProto(opts.protoOverrides);
  const capacitor = opts.capacitor || makeCapacitor(opts.bridge);
  const clock = makeClock(opts.clock);
  const doc = opts.doc === null ? null : opts.doc || makeDoc(opts.visibility);
  const logs = [];
  const shell = createForayAudioShell({
    capacitor,
    mediaProto: proto,
    doc,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    settleMs: opts.settleMs,
    log: (m, e) => logs.push({ m, e }),
  });
  return { proto, capacitor, clock, doc, logs, shell };
}

const methods = (capacitor) => capacitor.calls.map((c) => c.method);

/* -------------------------------------------------- 1. where it applies at all */

test("shellApplies only on Android, and only with a bridge that can reach native", () => {
  assert.equal(shellApplies(makeCapacitor()), true);
  assert.equal(shellApplies(makeCapacitor({ platform: "ios" })), false, "iOS needs no native call — MP1 §7.3");
  assert.equal(shellApplies(makeCapacitor({ platform: "web" })), false);
  assert.equal(shellApplies(makeCapacitor({ omitNativePromise: true })), false);
  assert.equal(shellApplies(undefined), false);
  assert.equal(shellApplies({}), false);
});

test("a bridge whose getPlatform throws fails closed instead of throwing", () => {
  /* shell-invariants.test.mjs records a real bridge whose isNativePlatform() threw
     and took a guard with it. Same class of hazard, one object further along. */
  assert.equal(shellApplies(makeCapacitor({ throwOnGetPlatform: true })), false);
  const { shell, proto } = setup({ capacitor: makeCapacitor({ throwOnGetPlatform: true }) });
  const before = proto.play;
  assert.equal(shell.install(), false);
  assert.equal(proto.play, before, "the prototype was patched by a shell that could not tell the platform");
});

test("on iOS and on the web the prototype is never touched and native is never called", () => {
  for (const platform of ["ios", "web"]) {
    const { shell, proto, capacitor } = setup({ bridge: { platform } });
    const before = proto.play;
    assert.equal(shell.install(), false, `installed on ${platform}`);
    assert.equal(proto.play, before);
    /* The file SHIPS to iOS and to the web — prepare-webdir puts it in one bundle
       and the bundle is used for both platforms. Being inert there is the property
       that makes that safe. */
    assert.deepEqual(methods(capacitor), []);
  }
});

test("installing twice does not wrap play twice", () => {
  const { shell, proto, capacitor } = setup();
  assert.equal(shell.install(), true);
  const patched = proto.play;
  assert.equal(shell.install(), false);
  assert.equal(proto.play, patched);
  const el = makeElement(proto);
  el.play();
  assert.equal(el.playCalls, 1, "the real play ran more than once, so it was wrapped twice");
  assert.deepEqual(methods(capacitor), ["start"]);
});

test("uninstall restores the original play and drops the visibility listener", () => {
  const { shell, proto, doc } = setup();
  const original = proto.play;
  shell.install();
  assert.notEqual(proto.play, original);
  assert.equal(doc.listenerCount("visibilitychange"), 1);
  assert.equal(shell.uninstall(), true);
  assert.equal(proto.play, original);
  assert.equal(doc.listenerCount("visibilitychange"), 0);
  assert.equal(shell.uninstall(), false, "uninstalling twice should be a no-op");
});

test("a shell with no document still installs, and treats visibility as unknown", () => {
  /* Unknown must mean "hidden", because hidden is the branch that takes the slow,
     safe path. A shell that assumed visible would stop the service mid-seam. */
  const { shell, proto, clock, capacitor } = setup({ doc: null });
  assert.equal(shell.install(), true);
  const el = makeElement(proto);
  el.play();
  el.paused = true;
  el.emit("pause");
  assert.equal(clock.ids().length, 1, "no settle window was armed with no document to ask");
  assert.deepEqual(methods(capacitor), ["start"]);
});

/* ------------------------------------------ 2. the contract with the player */

test("the wrapper calls the real play exactly once and forwards its arguments", () => {
  const { shell, proto } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play("a", 2);
  assert.equal(el.playCalls, 1);
  assert.deepEqual(el.playArgs, [["a", 2]]);
});

test("the wrapper returns the original's value BY IDENTITY", () => {
  /* An equality assertion on a resolved value would pass for a wrapper that
     returned a fresh promise. Identity is the property the player actually needs:
     `html-audio-backend.js` attaches its own handlers to that exact object. */
  const returned = { thisExactObject: true };
  const { shell, proto } = setup();
  shell.install();
  const el = makeElement(proto, { playReturns: returned });
  assert.equal(el.play(), returned);
});

test("the wrapper never observes the returned promise", () => {
  /* THE RULE WITH NO OTHER WAAY TO CHECK IT. Reading `.then` on a play() promise
     marks a rejection handled and removes a console warning the player relies on.
     A thenable that records the read proves the shell never does. */
  let thenRead = 0;
  const thenable = {
    get then() {
      thenRead++;
      return () => {};
    },
  };
  const { shell, proto } = setup();
  shell.install();
  const el = makeElement(proto, { playReturns: thenable });
  assert.equal(el.play(), thenable);
  assert.equal(thenRead, 0, "the shell touched the promise the player returned");
});

test("a throw while registering listeners still lets the play through", () => {
  const { shell, proto, logs } = setup();
  shell.install();
  const el = makeElement(proto);
  el.throwOnAddListener = true;
  assert.doesNotThrow(() => el.play());
  assert.equal(el.playCalls, 1, "our bookkeeping cost the player a play()");
  assert.ok(logs.some((l) => /could not watch/.test(l.m)), "the failure was swallowed silently");
});

test("a clock that throws still lets the play and the pause through", () => {
  const { shell, proto, logs } = setup({ clock: { throwOnSet: true } });
  shell.install();
  const el = makeElement(proto);
  assert.doesNotThrow(() => el.play());
  assert.equal(el.playCalls, 1);
  el.paused = true;
  assert.doesNotThrow(() => el.emit("pause"), "a broken clock reached the player through an event handler");
  assert.ok(logs.some((l) => /reconcile failed/.test(l.m)));
});

/* ------------------------------------------------ 3. starting the service */

test("the first play starts the service, by that plugin name", async () => {
  const { shell, proto, capacitor } = setup();
  shell.install();
  makeElement(proto).play();
  await flush();
  assert.deepEqual(capacitor.calls, [{ name: PLUGIN_NAME, method: "start" }]);
});

test("a second element and a repeated play do not start it again", async () => {
  const { shell, proto, capacitor } = setup();
  shell.install();
  const a = makeElement(proto);
  const b = makeElement(proto);
  a.play();
  await flush();
  a.play();
  b.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"]);
  assert.equal(shell.inspect().active, 2);
});

test("A REFUSED PLAY NEVER STARTS THE SERVICE", async () => {
  /* An autoplay-policy refusal leaves `paused === true`, rejects the promise and
     fires NO event. Without the prune in activeCount the element sits in the active
     set for the rest of the session and the foreground service — and its
     notification — never goes away. The rejected promise is pre-handled here so the
     test does not depend on Node's unhandled-rejection behaviour; the shell itself
     never reads it. */
  const blocked = Promise.reject(new Error("NotAllowedError"));
  blocked.catch(() => {});
  const proto = makeProto({
    play() {
      this.playCalls++;
      return this.playReturns;
    },
  });
  const capacitor = makeCapacitor();
  const clock = makeClock();
  const shell = createForayAudioShell({
    capacitor,
    mediaProto: proto,
    doc: makeDoc("hidden"),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  shell.install();
  const el = makeElement(proto, { playReturns: blocked });
  el.play();
  await flush();
  assert.equal(el.playCalls, 1, "the refused play did not reach the element");
  assert.deepEqual(methods(capacitor), [], "the service was started for a play that never made a sound");
  assert.equal(shell.inspect().active, 0);
  assert.equal(shell.inspect().stopPending, false, "nothing was playing, so there was nothing to settle");
});

test("a start Android REFUSES is retried on the next play", async () => {
  /* `running: false` is the honest answer `ForayAudioPlugin` gives when
     startForegroundService threw, or when the service's own startForeground() did.
     Treating the call as success would leave the app unprotected for the whole
     session with nothing to notice. */
  let attempt = 0;
  const capacitor = makeCapacitor({
    results: {
      start: () => {
        attempt++;
        return Promise.resolve(
          attempt === 1
            ? { started: false, running: false, reason: "ForegroundServiceStartNotAllowedException: nope" }
            : { started: true, running: true, reason: "" }
        );
      },
    },
  });
  const { shell, proto, logs } = setup({ capacitor });
  shell.install();
  const a = makeElement(proto);
  a.play();
  await flush();
  assert.equal(shell.inspect().serviceRunning, false);
  assert.match(shell.inspect().lastReason, /ForegroundServiceStartNotAllowed/);
  assert.ok(logs.some((l) => /not running/.test(l.m)), "a refused start was not reported anywhere");

  makeElement(proto).play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "start"]);
  assert.equal(shell.inspect().serviceRunning, true);
});

test("a bridge that throws synchronously does not take the play down with it", async () => {
  const capacitor = makeCapacitor();
  capacitor.nativePromise = (name, method) => {
    capacitor.calls.push({ name, method });
    throw new Error("androidBridge is gone");
  };
  const { shell, proto, logs } = setup({ capacitor });
  shell.install();
  const el = makeElement(proto);
  assert.doesNotThrow(() => el.play());
  await flush();
  assert.equal(el.playCalls, 1);
  assert.equal(shell.inspect().serviceRunning, false);
  assert.ok(logs.some((l) => /start failed/.test(l.m)));
});

/* -------------------------------------------- 4. stopping, and the seam */

test("the last pause arms the settle window rather than stopping at once", async () => {
  const { shell, proto, capacitor, clock } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  assert.deepEqual(methods(capacitor), ["start"], "the service was stopped the instant playback paused");
  assert.deepEqual(clock.delays(), [STOP_SETTLE_MS]);
  assert.equal(shell.inspect().stopPending, true);
});

test("the settle window elapsing with nothing playing stops the service", async () => {
  const { shell, proto, capacitor, clock } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
  assert.equal(shell.inspect().serviceRunning, false);
  assert.equal(shell.inspect().wanted, false);
});

test("A SEAM DOES NOT STOP THE SERVICE: pause, then a play on a different element", async () => {
  /* The sequence the whole settle window exists for. Stopping here would be
     followed by a start Android is allowed to refuse from the background
     (ForegroundServiceStartNotAllowedException, API 31+), which is why this is
     tested as a sequence and not as a constant. */
  const { shell, proto, capacitor, clock } = setup();
  shell.install();
  const outgoing = makeElement(proto);
  outgoing.play();
  await flush();

  outgoing.paused = true;
  outgoing.emit("pause");
  assert.equal(shell.inspect().stopPending, true);

  const incoming = makeElement(proto);
  incoming.play();
  await flush();

  assert.equal(shell.inspect().stopPending, false, "the armed settle timer survived the incoming play");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"], "the service was stopped or restarted across a seam");
  assert.equal(shell.inspect().serviceRunning, true);
});

test("pausing one of two elements does not arm anything", async () => {
  const { shell, proto, clock } = setup();
  shell.install();
  const a = makeElement(proto);
  const b = makeElement(proto);
  a.play();
  b.play();
  await flush();
  a.paused = true;
  a.emit("pause");
  assert.deepEqual(clock.ids(), [], "a settle window opened while an element was still playing");
  assert.equal(shell.inspect().active, 1);
});

test("the settle window does not fire a stop if something started playing again", async () => {
  const { shell, proto, capacitor, clock } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  /* Resumed WITHOUT a play() call — a stall recovering — so `playing` is the only
     signal. The timer is still armed from the pause; firing it must find the
     element live and change nothing. */
  el.paused = false;
  el.emit("playing");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"]);
});

test("stop is asked for once, not once per event", async () => {
  const { shell, proto, capacitor, clock } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  el.emit("pause");
  el.emit("emptied");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
});

test("after a stop, playing again starts the service again", async () => {
  const { shell, proto, capacitor, clock } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  el.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop", "start"]);
});

for (const event of RELEASE_EVENTS) {
  test(`"${event}" releases an element as much as a pause does`, async () => {
    /* Parameterised over the exported list so adding an event to the shell without
       thinking about it still gets a test, and removing one from the list fails
       here. `emptied` and `abort` matter specifically because `load()` — which is
       what a seam does — fires them and does not always fire `pause`. */
    const { shell, proto, capacitor, clock } = setup();
    shell.install();
    const el = makeElement(proto);
    el.play();
    await flush();
    el.paused = true;
    el.emit(event);
    assert.equal(shell.inspect().stopPending, true, `${event} did not release the element`);
    clock.fireAll();
    await flush();
    assert.deepEqual(methods(capacitor), ["start", "stop"]);
  });
}

for (const event of ACQUIRE_EVENTS) {
  test(`"${event}" re-acquires an element that had been released`, async () => {
    const { shell, proto, capacitor, clock } = setup();
    shell.install();
    const el = makeElement(proto);
    el.play();
    await flush();
    el.paused = true;
    el.emit("pause");
    el.paused = false;
    el.emit(event);
    assert.equal(shell.inspect().stopPending, false);
    clock.fireAll();
    await flush();
    assert.deepEqual(methods(capacitor), ["start"]);
  });
}

/* ------------------------------------------------------- 5. the visibility net */

test("becoming visible with nothing playing stops the service immediately", async () => {
  /* THE UNFREEZE NET. Blink freezes a hidden, silent page 30 s after audio stops,
     so a settle timer that has not fired by then may never fire and the service
     would still be up when the user came back. Becoming visible is both the proof
     and the safest moment to fix it: a restart from the foreground is always
     permitted. */
  const { shell, proto, capacitor, clock, doc } = setup({ visibility: "hidden" });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  assert.equal(shell.inspect().stopPending, true);

  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
  assert.equal(shell.inspect().stopPending, false, "the settle timer was left armed after the stop");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"], "the stale timer fired a second stop");
});

test("becoming visible while audio is playing changes nothing", async () => {
  const { shell, proto, capacitor, doc } = setup({ visibility: "hidden" });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  await flush();
  assert.deepEqual(methods(capacitor), ["start"]);
});

test("visibility changes with no service wanted call nothing", async () => {
  const { shell, capacitor, doc } = setup({ visibility: "hidden" });
  shell.install();
  for (const state of ["visible", "hidden", "visible"]) {
    doc.visibilityState = state;
    doc.emit("visibilitychange");
  }
  await flush();
  assert.deepEqual(methods(capacitor), []);
});

/* -------------------------------------------------- 6. the window's two bounds */

test("the settle window sits strictly between #239's hidden deadline and Blink's grace", () => {
  /* NOT a restatement of the constant — the two numbers it is checked against come
     from somewhere else entirely, and either of them moving is what should fail
     here.
       FLOOR 20 000 ms: the deadline #239 gives a HIDDEN media load, after which the
       segment is dropped. A settle window at or below it fires mid-seam.
       CEILING 30 000 ms: `kRecentAudioDelay` in Blink's `page_scheduler_impl.h` —
       "A page cannot be throttled or frozen 30 seconds after playing audio". At or
       past it, the timer that stops the service can be frozen before it fires.
     If these ever cross, the fix is a native stop timer, not a bigger number. */
  const HIDDEN_LOAD_DEADLINE_MS = 20000;
  const BLINK_RECENT_AUDIO_DELAY_MS = 30000;
  assert.ok(
    STOP_SETTLE_MS > HIDDEN_LOAD_DEADLINE_MS,
    `the settle window (${STOP_SETTLE_MS} ms) must outlast a hidden segment load (${HIDDEN_LOAD_DEADLINE_MS} ms) or it fires mid-seam`
  );
  assert.ok(
    STOP_SETTLE_MS < BLINK_RECENT_AUDIO_DELAY_MS,
    `the settle window (${STOP_SETTLE_MS} ms) must fire inside Blink's ${BLINK_RECENT_AUDIO_DELAY_MS} ms grace or it can be frozen first`
  );
});

test("the settle window is pinned at 25 s, because it is a decision", () => {
  /* Deliberate friction, the same shape as MAX_BYTES and MIN_DERIVED_DATA_FILES in
     shell-invariants.test.mjs: the bounds test above is satisfied by anything in
     (20 000, 30 000), so without this line the value could drift within the range
     with no PR ever saying why. */
  assert.equal(STOP_SETTLE_MS, 25000);
});

test("the real default settle window is what an unconfigured shell uses", () => {
  /* `settleMs` is an override for the tests, and an override with no assertion that
     the DEFAULT is the exported constant is how a suite ends up proving something
     about a number the app never uses. */
  const { shell } = setup({ settleMs: undefined });
  shell.install();
  assert.equal(shell.inspect().settleMs, STOP_SETTLE_MS);
});
