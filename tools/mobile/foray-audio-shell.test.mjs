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
 *   - deleting the `inFlight` dedupe in `callAndRecord`. The test for it checked the
 *     dispatch list while the first `start` was still UNANSWERED, where a duplicate
 *     sits in the queue undispatched and invisible. Draining the queue first is what
 *     makes a second `start` observable.
 *   - dropping the rejection handler from the queue's clear link. A rejected `queue`
 *     is PERMANENT — every later `.then` is skipped and the shell stops talking to
 *     native for the rest of the session, silently. Two tests now reject through it:
 *     a bridge that rejects, and a `log` that throws (it is the embedder's function,
 *     `console.warn` in a browser, and it is called from that very handler).
 *
 * ONE OF THOSE TWO TESTS WAS ALSO WRONG FIRST, in a way worth naming because it is
 * the commonest fake-test bug here: it played a SECOND element and left the first
 * still playing, so `activeCount` never reached zero, no settle window was ever
 * armed, and it failed for a reason that had nothing to do with what it was testing.
 *
 * AND ONE MUTATION THAT SURVIVED BECAUSE THE CODE WAS WRONG, NOT THE TEST.
 * `requestStop` also set `serviceRunning = false` at dispatch, under a comment
 * calling it a bug fix. Deleting that line kept every test green — correctly, because
 * `wanted` alone decides `ensureStarted`'s guard and it already goes false at
 * dispatch. The line was removed rather than given a test, and the shell's comment
 * records the false alarm. A surviving mutant is not always a missing test.
 *
 * ── WHAT A HUMAN REVIEW PASS FOUND THAT NONE OF THE ABOVE DID (section 8) ─────
 *
 * Four defects, none of which any fake in this file could see, because in each case
 * the fake agreed with the code:
 *
 *   1. THE GATE READ A RACE. `ForayAudioPlugin.start()` reported `running` from a read
 *      taken right after `startForegroundService`, which only asks ActivityManager —
 *      the service's `onStartCommand` runs later on the main thread, so that field was
 *      false on every first start. `ensureStarted` gated on it, so its short-circuit
 *      could never fire and EVERY play() re-issued a start, including the one across a
 *      hidden seam: a background foreground-service start, which is the one call the
 *      settle window exists to avoid. The fixture returned `running: true`, so the
 *      fake was the only place the code worked.
 *   2. `error` DID NOT RELEASE AN ELEMENT. Only the media load algorithm sets
 *      `paused = true`, so a fatal error mid-playback leaves `paused === false`. The
 *      parameterised RELEASE_EVENTS test set `paused = true` before emitting, so it
 *      passed for `error` without exercising the real element state.
 *   3. THE VISIBILITY NET CANCELLED LIVE SETTLE WINDOWS, not just frozen ones —
 *      reintroducing the background start it was written to prevent.
 *   4. `uninstall()` RESTORED BLINDLY, deleting any later patch of
 *      `HTMLMediaElement.prototype.play` — the mirror image of rule 1 above.
 *
 * The lesson for anyone extending this file: a fake that is written from the same
 * mental model as the code cannot falsify that model. `DEFAULT_ANSWERS` exists so the
 * bridge protocol lives in ONE place here, and `shell-invariants.test.mjs` asserts
 * those field names against the Java rather than against this file.
 *
 * ── AND A SECOND REVIEW PASS FOUND FIVE MORE (section 9) ──────────────────────
 *
 * Against this suite at 51 tests with 21 caught mutations. The one that matters most is
 * §5.4 finding 1's re-issue loop arriving by a different route: `inFlight` held the bare
 * method NAME, so across a start/stop/start interleave an earlier call's clear link
 * nulled a later call's marker and let a redundant background start through. It is now
 * a monotonic token per call.
 *
 * **AND TWO OF THE TESTS IN THIS FILE WERE VACUOUS IN THE SAME WAY, TWICE.** The
 * `inFlight` dedupe test, and then the interleave test written to catch the bug above,
 * both asserted the dispatch list WHILE A CALL WAS STILL IN FLIGHT — where a redundant
 * call sits in the queue undispatched and therefore invisible. Both now drain the queue
 * with `settleNext()` and assert `pending.length === 0` before reading the list.
 *
 * SO THE RULE, FOR ANYONE ADDING A TEST HERE: an assertion about what native was asked
 * is only true once nothing is in flight. That is the specific way an async fake lies —
 * the bug is queued, and the assertion is on what was sent.
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

/** What `ForayAudioPlugin.java` answers on the happy path, kept in one place so the
 *  fakes cannot drift from the real protocol independently of each other.
 *
 *  NOTE WHAT IS *NOT* HERE: no `running` on `start` or `stop`. The Java deliberately
 *  does not report it, because `startForegroundService` and `stopService` are both
 *  asynchronous and the service's own flag has not moved yet — the field it used to
 *  return was a race that answered false on every first start.
 *  `shell-invariants.test.mjs` asserts these field names against the Java. */
const DEFAULT_ANSWERS = {
  start: { started: true, alreadyRunning: false, reason: "" },
  stop: { stopped: true, wasRunning: true, reason: "" },
  state: { running: true, platform: "android" },
  /* #27. The happy answer is "already granted", which is what an Android 12 device and
     a second launch both report — so a test that wants the DENIED path has to ask for
     it, and the denied path is where the interesting behaviour is. */
  requestNotifications: { requested: false, granted: true, reason: "" },
};

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
        : DEFAULT_ANSWERS[method];
      if (typeof answer === "function") return answer();
      return Promise.resolve(answer);
    };
  }
  return bridge;
}

/** Timers AND a clock, because the shell now needs both: the settle window is a
 *  timer, and the visibility net compares elapsed time against it to tell a FROZEN
 *  timer from one still legitimately counting. `advance` moves the clock WITHOUT
 *  firing anything, which is exactly what a frozen page does. */
function makeClock({ throwOnSet = false, start = 1_000_000 } = {}) {
  let nextId = 1;
  let t = start;
  const timers = new Map();
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
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
      return [...timers.values()].map((x) => x.ms);
    },
    fireAll() {
      for (const id of [...timers.keys()]) {
        const timer = timers.get(id);
        timers.delete(id);
        timer.fn();
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
    now: clock.now,
    settleMs: opts.settleMs,
    /* OFF unless a test asks for it, and the reason is the same one `settleMs` is
       overridable: the notification request fires on the first accepted start, so
       leaving it on would append a `requestNotifications` to the recorded call list in
       every one of the thirty tests below that assert an exact sequence about the
       SERVICE. That would be thirty assertions carrying a fact none of them is about.
       The default is `true` and §"the permission" asserts that separately, on a shell
       built with no options at all — the same shape as the settle window's own
       "the real default is what an unconfigured shell uses". */
    askNotifications: opts.askNotifications === true,
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

test("installing twice does not wrap play twice", async () => {
  const { shell, proto, capacitor } = setup();
  assert.equal(shell.install(), true);
  const patched = proto.play;
  assert.equal(shell.install(), false);
  assert.equal(proto.play, patched);
  const el = makeElement(proto);
  el.play();
  assert.equal(el.playCalls, 1, "the real play ran more than once, so it was wrapped twice");
  await flush();
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

test("a shell with no document still installs, and treats visibility as unknown", async () => {
  /* Unknown must mean "hidden", because hidden is the branch that takes the slow,
     safe path. A shell that assumed visible would stop the service mid-seam. */
  const { shell, proto, clock, capacitor } = setup({ doc: null });
  assert.equal(shell.install(), true);
  const el = makeElement(proto);
  el.play();
  await flush();
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
    now: clock.now,
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
            ? { started: false, reason: "ForegroundServiceStartNotAllowedException: nope" }
            : DEFAULT_ANSWERS.start
        );
      },
    },
  });
  const { shell, proto, logs } = setup({ capacitor });
  shell.install();
  const a = makeElement(proto);
  a.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, false);
  assert.match(shell.inspect().lastReason, /ForegroundServiceStartNotAllowed/);
  assert.ok(logs.some((l) => /refused to start/.test(l.m)), "a refused start was not reported anywhere");

  makeElement(proto).play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "start"]);
  assert.equal(shell.inspect().startAccepted, true);
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
  assert.equal(shell.inspect().startAccepted, false);
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
  assert.equal(shell.inspect().startAccepted, false);
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
  assert.equal(shell.inspect().startAccepted, true);
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

test("becoming visible with an OVERDUE settle timer stops the service immediately", async () => {
  /* THE UNFREEZE NET. Blink freezes a hidden, silent page 30 s after audio stops, so a
     settle timer that has not fired by then may never fire and the service would still
     be up when the user came back. Becoming visible is both the proof and the safest
     moment to fix it: a restart from the foreground is always permitted.

     THE CLOCK IS ADVANCED WITHOUT FIRING ANYTHING, which is exactly what a frozen page
     does to a pending timer, and it is what makes this test about FROZEN rather than
     about "visible and silent" — see the next test for the difference. */
  const { shell, proto, capacitor, clock, doc } = setup({ visibility: "hidden" });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  assert.equal(shell.inspect().stopPending, true);

  clock.advance(STOP_SETTLE_MS + 1);
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

/* ─────────── 7. the transition window, which is where this got it wrong ─────── */

/** A bridge whose calls can be resolved by the test, one at a time, so a `stop` and
 *  the `start` behind it can be held mid-flight on purpose. */
function makeDeferredCapacitor({ platform = "android" } = {}) {
  const calls = [];
  const pending = [];
  return {
    calls,
    pending,
    getPlatform: () => platform,
    nativePromise(name, method) {
      calls.push({ name, method });
      return new Promise((resolve) => {
        pending.push({
          method,
          settle(answer) {
            resolve(answer || DEFAULT_ANSWERS[method]);
          },
        });
      });
    },
    /** Answer the oldest unanswered call.
     *
     *  Flushes FIRST, because `callAndRecord` dispatches through a promise chain, so
     *  a call asked for during a synchronous `play()` is only handed to the bridge a
     *  microtask later. (On a device that delay is inside the same task as the user's
     *  gesture, which is what matters for Android's foreground-start rule.) */
    async settleNext(answer) {
      await flush();
      const next = pending.shift();
      assert.ok(next, "settleNext with nothing in flight");
      next.settle(answer);
      await flush();
      return next.method;
    },
  };
}

test("A PLAY WHILE A STOP IS IN FLIGHT STILL STARTS THE SERVICE", async () => {
  /* THE BUG THIS SECTION EXISTS FOR, found by re-reading rather than by a failure.
     `requestStop` used to leave `serviceRunning` true until native answered, so a
     play() in that window hit ensureStarted's `wanted && serviceRunning` guard,
     returned early, and never asked for a start — audio playing with the service
     off, and nothing left to retry it until the next pause. The window is small and
     entirely reachable: the settle timer fires, and the listener taps play. */
  const capacitor = makeDeferredCapacitor();
  const { shell, proto, clock } = setup({ capacitor });
  shell.install();

  const el = makeElement(proto);
  el.play();
  await capacitor.settleNext();
  assert.equal(shell.inspect().startAccepted, true);

  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"], "the stop was not dispatched");

  /* The stop is dispatched and UNANSWERED. Play again. */
  el.paused = false;
  el.play();
  await flush();

  /* The intention is recorded straight away. With the old code this was the whole
     bug: `serviceRunning` was still true, so `ensureStarted`'s `wanted &&
     serviceRunning` guard returned early and no start was ever queued. */
  assert.equal(shell.inspect().wanted, true, "the shell no longer wants the service");

  /* The start is not DISPATCHED yet, because the queue holds it behind the
     unanswered stop — that ordering is the other half of this fix and has its own
     test. Answering the stop must release it. */
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
  await capacitor.settleNext();
  assert.deepEqual(
    methods(capacitor),
    ["start", "stop", "start"],
    "a play during an in-flight stop never asked for the service back"
  );
  await capacitor.settleNext();
  assert.equal(shell.inspect().startAccepted, true, "audio is playing with the service off");
});

test("a stop and the start behind it reach native in that order", async () => {
  /* Capacitor dispatches plugin calls on a thread pool, so two calls issued
     milliseconds apart are not ordered by the bridge. Out of order the start lands
     first and the stop switches the service off underneath live audio. The chain in
     callAndRecord is what prevents it, and this is the test of the chain: the second
     call must not be dispatched at all until the first has been answered. */
  const capacitor = makeDeferredCapacitor();
  const { shell, proto, clock } = setup({ capacitor });
  shell.install();

  const el = makeElement(proto);
  el.play();
  await capacitor.settleNext();

  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();

  el.paused = false;
  el.play();
  await flush();
  assert.equal(capacitor.pending.length, 1, "both calls were in flight at once");
  assert.equal(capacitor.pending[0].method, "stop", "the start overtook the stop");

  await capacitor.settleNext();
  assert.equal(capacitor.pending.length, 1);
  assert.equal(capacitor.pending[0].method, "start");
  await capacitor.settleNext();
  assert.deepEqual(methods(capacitor), ["start", "stop", "start"]);
  assert.equal(shell.inspect().startAccepted, true);
});

test("two plays before the first start is answered ask native once", async () => {
  /* THE ASSERTION HAS TO COME AFTER THE FIRST CALL SETTLES, and an earlier version of
     this test did not — it checked the dispatch list while the first start was still
     unanswered, where a duplicate would be sitting in the queue undispatched and
     invisible. The mutation harness deleted the `inFlight` dedupe outright and this
     test stayed green. Draining the queue is what makes a second start observable. */
  const capacitor = makeDeferredCapacitor();
  const { shell, proto } = setup({ capacitor });
  shell.install();
  makeElement(proto).play();
  makeElement(proto).play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"], "an unanswered start was dispatched twice");
  await capacitor.settleNext();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"], "a duplicate start was queued behind the first");
  assert.equal(capacitor.pending.length, 0, "something is still in flight");
  assert.equal(shell.inspect().startAccepted, true);
});

test("a refused start is still retried after it settles, so the dedupe is not a latch", async () => {
  /* The other side of `inFlight`: it is cleared when the call SETTLES, not when it is
     dispatched. Clearing it at dispatch would dedupe nothing; never clearing it would
     make a single refusal permanent for the session. */
  const capacitor = makeDeferredCapacitor();
  const { shell, proto } = setup({ capacitor });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await capacitor.settleNext({ started: false, reason: "ForegroundServiceStartNotAllowedException" });
  assert.equal(shell.inspect().startAccepted, false);
  makeElement(proto).play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "start"]);
});

test("a rejected bridge call does not poison the queue for the rest of the session", async () => {
  /* A rejected `queue` is PERMANENT: every later `.then` is skipped and the shell
     stops talking to native for good, with no error anywhere. The bridge rejects here
     and a later play must still reach native. */
  let attempt = 0;
  const capacitor = makeCapacitor({
    results: {
      start: () => {
        attempt++;
        return attempt === 1
          ? Promise.reject(new Error("androidBridge went away"))
          : Promise.resolve(DEFAULT_ANSWERS.start);
      },
    },
  });
  const { shell, proto } = setup({ capacitor });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, false);

  makeElement(proto).play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "start"], "the queue stopped dispatching after a rejection");
  assert.equal(shell.inspect().startAccepted, true);
});

test("a log function that throws does not poison the queue either", async () => {
  /* `log` is the EMBEDDER's function, not ours — in the browser it is
     `console.warn`. It is called from the queue's rejection handler, so a throw there
     would reject `queue` itself. */
  const capacitor = makeCapacitor({
    results: { start: () => Promise.reject(new Error("bridge gone")) },
  });
  const proto = makeProto();
  const clock = makeClock();
  let logCalls = 0;
  const shell = createForayAudioShell({
    capacitor,
    mediaProto: proto,
    doc: makeDoc("hidden"),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    log: () => {
      logCalls++;
      throw new Error("the console exploded");
    },
  });
  shell.install();
  /* ONE element for the whole test. An earlier version played a second one and left
     the first still "playing", so `activeCount` never reached zero, no settle window
     was ever armed, and the test failed for a reason that had nothing to do with the
     queue. */
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.ok(logCalls > 0, "the failure was never reported");

  /* And the shell is still alive: a stop is still dispatched when playback settles. */
  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  assert.ok(methods(capacitor).includes("stop"), "the queue died with the throwing log");
});

/* ───── 8. the four things a review pass found that the fakes had not ────────── */

test("A FATAL MEDIA ERROR MID-PLAYBACK RELEASES THE ELEMENT", async () => {
  /* The parameterised RELEASE_EVENTS test above sets `paused = true` before emitting,
     so it passed for `error` without ever exercising the real element state. Only the
     media LOAD algorithm sets `paused = true` — which is what makes `emptied` and
     `abort` safe — so a fatal decode or network error mid-playback leaves
     `paused === false` and `ended === false`. Without `el.error` in the prune the
     element stays in `active` forever, `reconcile` keeps calling `ensureStarted`, and
     the service and its notification stay up for the rest of the session with no
     audio: the exact leak the prune exists to prevent. */
  const { shell, proto, capacitor, clock } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.equal(shell.inspect().active, 1);

  /* Exactly what a fatal error looks like on a real element: `error` is set, `paused`
     is still false, `ended` is still false. */
  el.error = { code: 3, message: "MEDIA_ERR_DECODE" };
  el.emit("error");
  assert.equal(shell.inspect().active, 0, "a fatally errored element was still counted as playing");
  assert.equal(shell.inspect().stopPending, true, "no settle window opened after a fatal error");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
});

test("readyState 0 does NOT release an element, because that is every seam's first moment", async () => {
  /* `el.readyState === 0` was suggested alongside `el.error` and is deliberately not
     used. A brand-new element has readyState 0 for the whole gap between `play()` and
     its first metadata — which is precisely the incoming element at a seam — so
     pruning on it would drop the one element the service is being started for. */
  const { shell, proto, capacitor } = setup();
  shell.install();
  const el = makeElement(proto);
  el.readyState = 0;
  el.play();
  await flush();
  assert.equal(shell.inspect().active, 1, "the incoming element of a seam was pruned before it loaded");
  assert.deepEqual(methods(capacitor), ["start"]);
});

test("BECOMING VISIBLE MID-SEAM DOES NOT CANCEL A SETTLE WINDOW THAT IS STILL COUNTING", async () => {
  /* The visibility net used to stop the service on ANY visible-and-silent transition.
     A hidden cross-episode seam measures 9–11 s and #239 allows it 20 s, so a user
     foregrounding the app mid-load cancelled a window that was still legitimately
     counting — and if they backgrounded it again before the seam's `play()` landed,
     that `play()` issued a BACKGROUND startForegroundService, which Android 12+
     refuses. The failure the window exists to prevent, reintroduced by the net meant
     to protect it. */
  const { shell, proto, capacitor, clock, doc } = setup({ visibility: "hidden" });
  shell.install();
  const outgoing = makeElement(proto);
  outgoing.play();
  await flush();

  outgoing.paused = true;
  outgoing.emit("pause");
  assert.equal(shell.inspect().stopPending, true);

  /* Ten seconds into a twenty-five second window: a slow hidden load, not a frozen
     timer. The user brings the app to the front. */
  clock.advance(10_000);
  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  await flush();
  assert.deepEqual(methods(capacitor), ["start"], "the settle window was cancelled mid-seam");
  assert.equal(shell.inspect().stopPending, true, "the settle timer was disarmed mid-seam");

  /* And the seam completes, as it would have. */
  const incoming = makeElement(proto);
  incoming.play();
  await flush();
  assert.equal(shell.inspect().stopPending, false);
  assert.deepEqual(methods(capacitor), ["start"], "the service was restarted across a seam");
});

test("the shell gates on `started`, not on whether native says the service is running", async () => {
  /* THE HIGH-SEVERITY FINDING. `startForegroundService` only asks ActivityManager; the
     service's `onStartCommand` runs later on the main thread, so a `running` read in
     the same plugin method answers false on every first start. Gating on it meant
     `ensureStarted`'s short-circuit could never fire and EVERY play() re-issued a
     start — including the one across a hidden seam, which is a background
     foreground-service start and the one call the settle window exists to avoid.

     So a native answer that reports `started: true` while the service has not come up
     yet — which is the NORMAL answer — must still short-circuit the next play. */
  const capacitor = makeCapacitor({
    results: { start: { started: true, alreadyRunning: false, reason: "" } },
  });
  const { shell, proto } = setup({ capacitor });
  shell.install();
  const a = makeElement(proto);
  a.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, true);
  assert.equal(shell.inspect().lastKnownRunning, null, "nothing has asked native for the real state yet");

  /* Five more plays, exactly as a Foray's seams would. Not one of them may re-ask. */
  for (let i = 0; i < 5; i++) {
    const el = makeElement(proto);
    el.play();
    await flush();
  }
  assert.deepEqual(methods(capacitor), ["start"], "a start was re-issued while one was already accepted");
});

test("refresh() is the only thing that reports whether the service is really running", async () => {
  const capacitor = makeCapacitor({ results: { state: { running: true, platform: "android" } } });
  const { shell, proto } = setup({ capacitor });
  shell.install();
  makeElement(proto).play();
  await flush();
  assert.equal(shell.inspect().lastKnownRunning, null);

  await shell.refresh();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "state"]);
  assert.equal(shell.inspect().lastKnownRunning, true);
});

test("refresh() reports and logs a service that was accepted but never came up", async () => {
  /* The failure only `state()` can see: `startForegroundService` succeeded, and then
     the service's own `startForeground()` threw — an API 34 service-type mismatch, or
     a missing FOREGROUND_SERVICE_MEDIA_PLAYBACK permission — so it called `stopSelf`.
     `start` answered `started: true` and was right to. */
  const capacitor = makeCapacitor({ results: { state: { running: false, platform: "android" } } });
  const { shell, proto, logs } = setup({ capacitor });
  shell.install();
  makeElement(proto).play();
  await flush();
  await shell.refresh();
  await flush();
  assert.equal(shell.inspect().startAccepted, true, "the start really was accepted");
  assert.equal(shell.inspect().lastKnownRunning, false);
  assert.ok(
    logs.some((l) => /accepted but is not running/.test(l.m)),
    "a service that never came up was not reported anywhere"
  );
});

test("uninstall does not delete somebody else's later patch of play()", async () => {
  /* The mirror image of rule 1 in this file's header. If another Capacitor plugin or an
     injected script patches HTMLMediaElement.prototype.play after we do, restoring
     blindly silently removes THEIR wrapper. */
  const { shell, proto, logs } = setup();
  const original = proto.play;
  shell.install();
  const ours = proto.play;

  let theirCalls = 0;
  const theirs = function somebodyElsesPlay() {
    theirCalls++;
    return ours.apply(this, arguments);
  };
  proto.play = theirs;

  assert.equal(shell.uninstall(), true);
  assert.equal(proto.play, theirs, "uninstall deleted a wrapper installed after ours");
  assert.notEqual(proto.play, original);
  assert.ok(logs.some((l) => /patched again/.test(l.m)), "the refusal to restore was not reported");

  /* And theirs still works, calling through to ours, which calls through to the real
     one. Nothing in the chain was broken. */
  const el = makeElement(proto);
  el.play();
  assert.equal(theirCalls, 1);
  assert.equal(el.playCalls, 1);
});

test("uninstall still restores when ours IS the one on the prototype", async () => {
  /* The other direction, so the guard above cannot be satisfied by never restoring. */
  const { shell, proto } = setup();
  const original = proto.play;
  shell.install();
  assert.notEqual(proto.play, original);
  assert.equal(shell.uninstall(), true);
  assert.equal(proto.play, original, "uninstall stopped restoring the original play");
});

test("a refresh() that fails does not invalidate an accepted start", async () => {
  /* Found on a re-read, not by a failing test. The rejection handler cleared the gate
     for ANY method, so a `state()` call that did not arrive made the next play()
     re-issue a start — the redundant-background-start behaviour section 8's first
     finding was about, arriving through the error path instead. */
  const capacitor = makeCapacitor({
    results: { state: () => Promise.reject(new Error("bridge busy")) },
  });
  const { shell, proto, logs } = setup({ capacitor });
  shell.install();
  makeElement(proto).play();
  await flush();
  assert.equal(shell.inspect().startAccepted, true);

  await shell.refresh();
  await flush();
  assert.ok(logs.some((l) => /state failed/.test(l.m)), "the failed diagnostic was not reported");
  assert.equal(shell.inspect().startAccepted, true, "a failed diagnostic cleared the start gate");

  makeElement(proto).play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "state"], "a failed state() caused a redundant start");
});

test("a NON-state call that fails DOES clear the gate, so the exemption is not a blanket skip", async () => {
  /* THE OTHER DIRECTION, and the first version of this test was vacuous — the mutation
     harness said so. It had a `start` reject on the first attempt and then asserted the
     gate was false, which it already was: the gate starts false, and a rejected start
     never runs the handler that would set it true. `if (false) startAccepted = false;`
     passed it.

     Catching that mutant needs the gate to be TRUE first, so the sequence is: a start
     that succeeds, then a `stop` that REJECTS, whose only path to clearing the gate is
     the error handler under test. */
  const capacitor = makeCapacitor({
    results: { stop: () => Promise.reject(new Error("bridge gone")) },
  });
  const { shell, proto, clock } = setup({ capacitor });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, true, "the gate was never set, so this proves nothing");

  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
  assert.equal(
    shell.inspect().startAccepted,
    false,
    "a failed stop left the gate set, so the shell still believes it holds a service"
  );
});

/* ── 9. a second review pass, and the interleave the first one's tests missed ─── */

test("THE IN-FLIGHT MARKER SURVIVES A START, STOP, START INTERLEAVE", async () => {
  /* Found by a review pass with a dispatch trace, and it is §5.4 finding 1's re-issue
     loop reached by a different route. `inFlight` used to be the bare method NAME, so
     with two starts outstanding and a stop between them, start#1's clear link ran while
     the marker already belonged to start#2 and nulled it — leaving start#2 in flight
     but unmarked, so the next play() queued a redundant third start. Hidden, Android
     12+ refuses that start, which clears the gate WHILE THE SERVICE IS UP, and every
     later play() re-issues a refused start.

     The two existing dedupe tests could not see it: they cover two starts with nothing
     in between. The trigger is exactly the seam sequence the design is built around. */
  const capacitor = makeDeferredCapacitor();
  const { shell, proto, clock } = setup({ capacitor });
  shell.install();

  const a = makeElement(proto);
  a.play(); // start#1
  await flush();

  a.paused = true;
  a.emit("pause");
  clock.fireAll(); // stop
  await flush();

  const b = makeElement(proto);
  b.play(); // start#2, queued behind the stop
  await flush();

  await capacitor.settleNext(); // answer start#1 — must NOT clear start#2's marker
  await capacitor.settleNext(); // answer stop
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop", "start"]);

  /* start#2 is dispatched and unanswered. A release event now reconciles, and with the
     old name-only marker this is where the fourth, redundant start appeared. */
  b.paused = true;
  b.emit("pause");
  b.paused = false;
  b.emit("playing");
  await flush();

  /* AND THE QUEUE HAS TO BE DRAINED BEFORE ASSERTING, which the first version of this
     test did not do — the same mistake that made the original `inFlight` dedupe test
     vacuous. A redundant start queued behind the unanswered start#2 is undispatched and
     therefore invisible; answering start#2 is what lets it through, or proves there
     never was one. */
  await capacitor.settleNext();
  await flush();
  assert.deepEqual(
    methods(capacitor),
    ["start", "stop", "start"],
    "a stale clear from start#1 let a redundant start through while start#2 was in flight"
  );
  assert.equal(capacitor.pending.length, 0, "something is still in flight, so the list above is incomplete");
});

test("a stop native reports as FAILED does not claim the service is down", async () => {
  /* `lastKnownRunning` is the instrument docs/android-native-code.md §6.4 points a
     device pass at, and it read `wasRunning` — native's truthful PRE-call read, always
     present — so it went false even when `stopService` threw and the service and its
     notification were still up. The field claiming more than it knows is the same
     defect as §5.4 finding 1, in the one place the doc says to trust. */
  const capacitor = makeCapacitor({
    results: {
      state: { running: true, platform: "android" },
      stop: { stopped: false, wasRunning: true, reason: "SecurityException: not allowed" },
    },
  });
  const { shell, proto, clock } = setup({ capacitor });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  await shell.refresh();
  await flush();
  assert.equal(shell.inspect().lastKnownRunning, true);

  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "state", "stop"]);
  assert.equal(
    shell.inspect().lastKnownRunning,
    true,
    "a failed stop reported the service as down while it was still up"
  );
  assert.match(shell.inspect().lastReason, /SecurityException/);
});

test("a stop native reports as SUCCEEDED does mark the service down", async () => {
  /* The other direction, so the guard above cannot be satisfied by never updating. */
  const capacitor = makeCapacitor({ results: { state: { running: true, platform: "android" } } });
  const { shell, proto, clock } = setup({ capacitor });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  await shell.refresh();
  await flush();
  assert.equal(shell.inspect().lastKnownRunning, true);

  el.paused = true;
  el.emit("pause");
  clock.fireAll();
  await flush();
  assert.equal(shell.inspect().lastKnownRunning, false);
});

test("UNINSTALL DOES NOT STRAND THE FOREGROUND SERVICE", async () => {
  /* `uninstall` is on `window.ForayAudioShell`, which is the object §6.4 tells a device
     pass to drive from chrome://inspect. It used to leave `wanted: true` and no JS path
     back — the prototype is restored, so no future play() reaches the shell, and only
     stopWithTask or the Activity's destruction would ever clear the service. A
     diagnostic that strands a foreground service and its notification for the life of
     the process is worse than no diagnostic. */
  const { shell, proto, capacitor } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"]);

  assert.equal(shell.uninstall(), true);
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"], "uninstall left the service running");
  assert.equal(shell.inspect().wanted, false);
});

test("uninstall with nothing running asks for no stop", async () => {
  /* So the fix above is not "always call stop", which would be a bridge round-trip on
     every teardown and a stop for a service nobody started. */
  const { shell, capacitor } = setup();
  shell.install();
  assert.equal(shell.uninstall(), true);
  await flush();
  assert.deepEqual(methods(capacitor), []);
});

test("an event on a watched element after uninstall does not resurrect it into the active set", async () => {
  /* `reconcile` checked `installed`, but `acquire` mutated the Set FIRST. So after
     uninstall a `playing` event put a discarded element back into `active`, where
     nothing prunes it any more — a strong reference outliving the shell, and a
     re-installed shell starting dirty at `active: 1`. */
  const { shell, proto } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  shell.uninstall();
  await flush();
  assert.equal(shell.inspect().active, 0);

  el.paused = false;
  el.emit("playing");
  assert.equal(shell.inspect().active, 0, "an uninstalled shell took a reference to a discarded element");

  shell.install();
  assert.equal(shell.inspect().active, 0, "the re-installed shell started with a stale active element");
});

/* ---------------------------------------------------- 10. #27: a loaded Foray

   The service now lives for as long as a Foray is LOADED rather than as long as
   audio is SOUNDING, because the Media3 `MediaSession` — the lock screen's metadata
   and its buttons — lives in the service. Stopping it 25 s after a pause took the
   controls away from the listener who had just used them.

   THE ADVERSARIAL PASS ON THIS SECTION, because three of these are one-line
   deletions that left it green when it was three tests instead of nine:
     - dropping `!mediaLoaded` from the SETTLE TIMER's callback. Caught only by
       asserting no `stop` is dispatched after the window elapses — asserting
       `stopPending` is false is not enough, because the timer clears itself either
       way.
     - dropping `!mediaLoaded` from `onVisibilityChange`'s guard. Caught only by a
       test that goes overdue AND becomes visible, which is the frozen-timer path.
     - reading `mediaLoaded` at ARM time rather than at FIRE time. Caught by
       "a Foray closed DURING the settle window". */

test("a loaded Foray survives the settle window: the service is not stopped", async () => {
  const { shell, proto, clock, capacitor } = setup({ settleMs: 1000 });
  shell.install();
  shell.setMediaLoaded(true);
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"]);

  el.paused = true;
  el.emit("pause");
  await flush();
  assert.equal(shell.inspect().stopPending, true, "the pause should have armed a window");
  /* ADVANCE AND THEN FIRE, and both halves are needed: this fake clock's `advance`
     moves `now` only, so an earlier draft of this test asserted "no stop" against a
     timer that had never run. It would have passed with `mediaLoaded` deleted
     entirely, which is the definition of a vacuous test. */
  clock.advance(1000);
  clock.fireAll();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start"],
    "a pause with a Foray still loaded stopped the session the listener paused with"
  );
  assert.equal(shell.inspect().mediaLoaded, true);
});

test("an UNLOADED page still stops after the settle window, exactly as #244 had it", async () => {
  /* The fallback that makes `foray-media-session.js`'s absence cost nothing: with
     nothing ever reporting `loaded`, every path is the old one. */
  const { shell, proto, clock, capacitor } = setup({ settleMs: 1000 });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  await flush();
  clock.advance(1000);
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
});

test("CLOSING THE PLAYER STOPS THE SERVICE AT ONCE, with no settle window", async () => {
  /* The payoff #244's own header predicted: "once a pause can come from a transport
     control, a pause the app ISSUED is attributable and can stop the service at
     once". `setMediaLoaded(false)` is that attributable signal — `client.js` nulls the
     media session's metadata in `stopAndClose` and nowhere else. */
  const { shell, proto, clock, capacitor } = setup({ settleMs: 1000 });
  shell.install();
  shell.setMediaLoaded(true);
  const el = makeElement(proto);
  el.play();
  await flush();

  el.paused = true;
  el.emit("pause");
  await flush();
  assert.equal(shell.inspect().stopPending, true, "the pause should have armed a window");

  shell.setMediaLoaded(false);
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"], "a closed player did not stop the service");
  assert.equal(shell.inspect().stopPending, false, "the armed window outlived the stop that replaced it");
});

test("a Foray closed DURING the settle window is not stopped twice", async () => {
  /* And the reason `mediaLoaded` is read when the window FIRES rather than when it is
     armed. Armed while loaded, closed 200 ms later: the close stops the service, and
     the window must not then stop it again — a second `stop` is a bridge round-trip
     for a service already down, and it would clear `lastKnownRunning` for a call
     nobody needed. */
  const { shell, proto, clock, capacitor } = setup({ settleMs: 1000 });
  shell.install();
  shell.setMediaLoaded(true);
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  await flush();

  clock.advance(200);
  shell.setMediaLoaded(false);
  await flush();
  assert.equal(clock.ids().length, 0, "the close left the settle timer armed");
  clock.advance(1000);
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
});

test("BECOMING VISIBLE WITH A FORAY LOADED DOES NOT TEAR THE SESSION DOWN", async () => {
  /* The visibility net stops a service whose settle timer was FROZEN by Blink. With a
     Foray still loaded there is nothing to stop — and becoming visible is precisely
     when a listener is about to look at the notification. Without `!mediaLoaded` in
     that guard, foregrounding the app after a long pause destroyed the lock-screen
     session it was about to be used from. */
  const { shell, proto, clock, doc, capacitor } = setup({ settleMs: 1000, visibility: "hidden" });
  shell.install();
  shell.setMediaLoaded(true);
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  await flush();

  /* Past the window without the timer having run — which is what a frozen timer looks
     like from the outside. */
  clock.advance(1500);
  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  await flush();
  assert.deepEqual(methods(capacitor), ["start"], "the visibility net stopped a loaded Foray's session");
});

test("becoming visible with NOTHING loaded still stops a frozen window's service", async () => {
  /* So the guard above is not "never stop from the visibility net", which would
     reintroduce the leak that net exists for. */
  const { shell, proto, clock, doc, capacitor } = setup({ settleMs: 1000, visibility: "hidden" });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  await flush();
  clock.advance(1500);
  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);
});

test("setMediaLoaded(false) with audio still flowing stops nothing", async () => {
  /* Ordering safety. `client.js` clears the metadata inside `stopAndClose`, which
     awaits `manager.stop()` first — so in principle the clear can land before the
     element's `pause` event. Stopping the service while an element is still audible
     would be the exact failure the settle window exists to prevent, arriving from the
     new signal. */
  const { shell, proto, capacitor } = setup({ settleMs: 1000 });
  shell.install();
  shell.setMediaLoaded(true);
  const el = makeElement(proto);
  el.play();
  await flush();
  shell.setMediaLoaded(false);
  await flush();
  assert.deepEqual(methods(capacitor), ["start"], "the service was stopped underneath live audio");
});

test("setMediaLoaded is idempotent in both directions", async () => {
  const { shell, proto, capacitor } = setup({ settleMs: 1000 });
  shell.install();
  shell.setMediaLoaded(true);
  shell.setMediaLoaded(true);
  const el = makeElement(proto);
  el.play();
  await flush();
  el.paused = true;
  el.emit("pause");
  await flush();
  shell.setMediaLoaded(false);
  shell.setMediaLoaded(false);
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"], "a repeated close asked twice");
});

test("uninstall clears mediaLoaded, so a re-installed shell does not start dirty", async () => {
  /* Same hazard as the `active` set: a shell that came back believing a Foray from a
     previous life was loaded would make its first settle window a no-op and leave the
     service up with nothing playing. */
  const { shell } = setup({ settleMs: 1000 });
  shell.install();
  shell.setMediaLoaded(true);
  shell.uninstall();
  assert.equal(shell.inspect().mediaLoaded, false);
  shell.install();
  assert.equal(shell.inspect().mediaLoaded, false);
});

/* ------------------------------------------ 11. #27: the notification permission

   From Android 13 a notification the user has not permitted is not shown, and from
   #27 the notification IS the transport controls — so on most devices the lock screen
   stays blank until this is granted, with everything else working perfectly. */

test("the first accepted start asks for the notification permission, once", async () => {
  const { shell, proto, capacitor } = setup({ askNotifications: true });
  shell.install();
  const first = makeElement(proto);
  first.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "requestNotifications"]);

  first.paused = true;
  first.emit("pause");
  const second = makeElement(proto);
  second.play();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "requestNotifications"],
    "a second play asked for the permission again"
  );
  assert.equal(shell.inspect().notificationsGranted, true);
});

test("A STOP AND A FRESH PLAY DO NOT ASK A SECOND TIME", async () => {
  /* A MUTATION FOUND THIS GAP. Deleting `if (notificationsAsked) return;` left the
     suite green, because the test above proves "once" through a second play — and a
     second play short-circuits in `ensureStarted`'s own `wanted && startAccepted`
     guard, so the start callback never runs again and nothing would have asked twice
     anyway. The flag only earns its keep across a STOP: after one, `startAccepted` is
     false, the next play really does re-issue a start, and its callback really would
     prompt again. Two dialogs in one session is Android's own re-prompt limit doing
     our rate-limiting — and it only does it twice. */
  const { shell, proto, clock, capacitor } = setup({ askNotifications: true, settleMs: 1000 });
  shell.install();
  const first = makeElement(proto);
  first.play();
  await flush();
  first.paused = true;
  first.emit("pause");
  await flush();
  clock.advance(1000);
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "requestNotifications", "stop"]);

  const second = makeElement(proto);
  second.play();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "requestNotifications", "stop", "start"],
    "the play after a stop prompted for notifications a second time"
  );
});

test("A START ANDROID REFUSED DOES NOT ASK FOR NOTIFICATIONS", async () => {
  /* A refused start means no service, so no notification — so a system dialog with
     nothing behind it. The listener would be asked to permit something we could not
     show them. */
  const { shell, proto, capacitor } = setup({
    askNotifications: true,
    bridge: { results: { start: { started: false, reason: "ForegroundServiceStartNotAllowedException" } } },
  });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"]);
  assert.equal(shell.inspect().notificationsAsked, false);
});

test("a DENIED permission is logged and costs nothing else", async () => {
  const { shell, proto, capacitor, logs } = setup({
    askNotifications: true,
    bridge: { results: { requestNotifications: { requested: true, granted: false, reason: "denied" } } },
  });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.equal(shell.inspect().notificationsGranted, false);
  assert.equal(shell.inspect().startAccepted, true, "a denied notification permission invalidated the start");
  assert.match(logs.map((l) => l.m).join(" "), /lock-screen controls will not appear/);

  el.paused = true;
  el.emit("pause");
  await flush();
  assert.equal(shell.inspect().wanted, true);
  assert.deepEqual(methods(capacitor), ["start", "requestNotifications"]);
});

test("A FAILED requestNotifications DOES NOT CLEAR THE START GATE", async () => {
  /* The whitelist in `callAndRecord`'s rejection handler. It used to read
     `method !== "state"`, which was correct with three methods and silently wrong with
     four: a permission call that rejected would clear `startAccepted` while the
     service was up, and from there every `play()` re-issues a start — including the one
     across a hidden seam that Android 12+ refuses. That is §5.4 finding 1's re-issue
     loop, reached through the error path of a permission prompt. */
  const { shell, proto, capacitor } = setup({
    askNotifications: true,
    bridge: { results: { requestNotifications: () => Promise.reject(new Error("no activity")) } },
  });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, true, "a rejected permission call cleared the start gate");

  const second = makeElement(proto);
  second.play();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "requestNotifications"],
    "the next play re-issued a start it did not need"
  );
});

test("an unconfigured shell DOES ask — the default is on, not off", async () => {
  /* The default is the whole mechanism, and `setup()` turns it off so thirty tests
     about the service can assert exact call sequences. Asserted here on a shell built
     with no options at all, the same shape as the settle window's own default test, so
     the override cannot become a way to hide this from the suite. */
  const proto = makeProto();
  const capacitor = makeCapacitor();
  const clock = makeClock();
  const shell = createForayAudioShell({
    capacitor,
    mediaProto: proto,
    doc: makeDoc(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.deepEqual(capacitor.calls.map((c) => c.method), ["start", "requestNotifications"]);
});


/* ------------------------------ 12. #27: the service can vanish underneath us

   Every one of these is a state the shell used to be unable to leave. `wanted` and
   `startAccepted` both stay true when the service stops without being asked — Android
   killing it under memory pressure (it is START_NOT_STICKY, so nothing restarts it), a
   native stop, a `startForeground` that failed a moment after the start was accepted —
   and `ensureStarted`'s short-circuit then means NO later `play()` ever re-asks.
   Playback continues unprotected for the rest of the Foray with a blank lock screen.

   A review pass found the first route to it (a fragment navigation reaching native's
   page-load listener). `noteServiceRunning` closes all of them from the JS side, and it
   is fed by `setNowPlaying`'s own answer, so it costs no extra bridge traffic. */

test("A SERVICE THAT DIES IS NOTICED, AND THE NEXT PLAY RE-STARTS IT", async () => {
  const { shell, proto, capacitor } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start"]);
  assert.equal(shell.inspect().startAccepted, true);

  /* Native confirms it is up, then reports it gone — which is what a memory-pressure
     kill looks like from here. */
  shell.noteServiceRunning(true);
  shell.noteServiceRunning(false);
  assert.equal(shell.inspect().startAccepted, false, "a service that went away was not noticed");
  assert.equal(shell.inspect().lastKnownRunning, false);

  const second = makeElement(proto);
  second.play();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "start"],
    "the next play did not re-start the service"
  );
});

test("A running:false BEFORE THE SERVICE HAS EVER STARTED IS NOT A DEATH", async () => {
  /* The race this whole mechanism has to survive, and the reason for `sawServiceRunning`.
     `startForegroundService` only asks ActivityManager; the service's `onStartCommand`
     runs later on the MAIN thread, so a `running: false` in that window is normal. Acting
     on it would clear the gate and re-issue a start — §5.4 finding 1's re-issue loop,
     reached through the recovery meant to prevent a different failure. */
  const { shell, proto, capacitor } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  shell.noteServiceRunning(false);
  shell.noteServiceRunning(false);
  assert.equal(shell.inspect().startAccepted, true, "a start that had not landed yet was treated as a death");
  assert.deepEqual(methods(capacitor), ["start"]);
});

test("a fresh start re-arms the guard, so a stale running:true cannot be believed", async () => {
  /* Otherwise: service dies, next play starts it, and a `running: false` from a report
     that was in flight before that start would look like a second death. */
  const { shell, proto } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  shell.noteServiceRunning(true);
  shell.noteServiceRunning(false);
  assert.equal(shell.inspect().startAccepted, false);

  const second = makeElement(proto);
  second.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, true);
  assert.equal(shell.inspect().sawServiceRunning, false, "the new start inherited the old confirmation");
  shell.noteServiceRunning(false);
  assert.equal(shell.inspect().startAccepted, true, "a stale report invalidated a fresh start");
});

test("noteServiceRunning does nothing when we do not hold a service", async () => {
  const { shell, capacitor } = setup();
  shell.install();
  shell.noteServiceRunning(true);
  shell.noteServiceRunning(false);
  assert.equal(shell.inspect().wanted, false);
  assert.deepEqual(methods(capacitor), [], "the recovery started or stopped something on its own");
});

test("noteServiceRunning NEVER starts the service itself", async () => {
  /* It can be called while the app is backgrounded — the reports that feed it come from
     a 1 Hz write during playback — and a background `startForegroundService` is the one
     call Android 12+ refuses. Recovery is "let the next play re-ask", never "ask now". */
  const { shell, proto, capacitor } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  shell.noteServiceRunning(true);
  shell.noteServiceRunning(false);
  await flush();
  assert.deepEqual(methods(capacitor), ["start"], "the recovery issued a start of its own");
});

test("noteServiceRunning after uninstall does nothing", async () => {
  const { shell, proto } = setup();
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  shell.noteServiceRunning(true);
  shell.uninstall();
  await flush();
  shell.noteServiceRunning(false);
  assert.equal(shell.inspect().installed, false);
});

test("THE PERMISSION PROMPT DOES NOT BLOCK A STOP BEHIND IT", async () => {
  /* `callAndRecord` serialises calls so a `stop` and the `start` behind it cannot land
     out of order. `requestNotifications` resolves only when the user answers a system
     dialog, so putting it in that chain is a head-of-line block: the `stop` waits on a
     human. A review pass found it, and the fix is that the prompt goes out on its own
     chain — ordering only ever mattered between `start` and `stop`. */
  let answerDialog;
  const dialog = new Promise((resolve) => { answerDialog = resolve; });
  const { shell, proto, clock, capacitor } = setup({
    askNotifications: true,
    settleMs: 1000,
    bridge: { results: { requestNotifications: () => dialog } },
  });
  shell.install();
  const el = makeElement(proto);
  el.play();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "requestNotifications"]);

  /* The listener pauses while the dialog is still up. */
  el.paused = true;
  el.emit("pause");
  await flush();
  clock.advance(1000);
  clock.fireAll();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "requestNotifications", "stop"],
    "the stop was queued behind an unanswered permission dialog"
  );

  answerDialog({ requested: true, granted: true, reason: "" });
  await flush();
  assert.equal(shell.inspect().notificationsGranted, true);
});

test("a permission dialog that is never answered leaves the queue usable", async () => {
  /* The worse half of the same bug: if the Activity is torn down under the dialog the
     call is simply lost, and a chain waiting on it would never advance again — the shell
     could not start or stop the service for the rest of the session. */
  const { shell, proto, clock, capacitor } = setup({
    askNotifications: true,
    settleMs: 1000,
    bridge: { results: { requestNotifications: () => new Promise(() => {}) } },
  });
  shell.install();
  const first = makeElement(proto);
  first.play();
  await flush();
  first.paused = true;
  first.emit("pause");
  await flush();
  clock.advance(1000);
  clock.fireAll();
  await flush();
  const second = makeElement(proto);
  second.play();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "requestNotifications", "stop", "start"],
    "an unanswered dialog stopped the shell talking to native"
  );
});


test("A RETRIED START AFTER A REFUSAL DOES NOT INHERIT A CONFIRMATION", async () => {
  /* THE SEQUENCE THAT MAKES `ensureStarted`'s RESET LOAD-BEARING, and finding it took a
     surviving mutation and then a trace. `requestStop` also clears the flag, so any
     stop-then-start sequence is covered by that — which is why the obvious test for this
     line was vacuous. The uncovered path is a start Android REFUSED, with no stop in
     between:

       play    -> start refused, so `startAccepted` false and `wanted` still true
       native  -> reports the service running anyway (it can: `started: false` means the
                  REQUEST was refused, and a service that came up some other way is
                  exactly what `state()` exists to reveal)
       play    -> `ensureStarted` retries, because `startAccepted` is false

     Without the reset at that dispatch, the retry begins already "confirmed", so the
     ordinary `running: false` from its own startup race reads as a death, clears the
     gate, and the play after that issues a start that may be a background one. */
  const { shell, proto, capacitor } = setup({
    bridge: { results: { start: { started: false, reason: "ForegroundServiceStartNotAllowedException" } } },
  });
  shell.install();
  const first = makeElement(proto);
  first.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, false);
  assert.equal(shell.inspect().wanted, true, "a refused start still means we want the service");

  shell.noteServiceRunning(true);
  assert.equal(shell.inspect().sawServiceRunning, true);

  const second = makeElement(proto);
  second.play();
  await flush();
  assert.equal(
    shell.inspect().sawServiceRunning, false,
    "the retried start inherited a confirmation from before it"
  );
  shell.noteServiceRunning(false);
  const third = makeElement(proto);
  third.play();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "start", "start"],
    "the retry sequence issued more starts than it needed"
  );
});

test("A CONFIRMED SERVICE DOES NOT VOUCH FOR THE NEXT START", async () => {
  /* A MUTATION FOUND THIS GAP TOO, and the earlier test for it was vacuous: it asserted
     `sawServiceRunning === false` after a second start in a sequence where the flag was
     already false, so deleting the reset changed nothing observable.

     The sequence that needs it is a full stop and restart. Native confirms the service
     is up, the Foray is paused, the settle window stops it, and a later play starts a
     NEW one. Without clearing the flag at that dispatch, the new start arrives already
     "confirmed" — so the ordinary `running: false` from its own startup race reads as a
     death, clears the gate, and the play after that re-issues a start Android may refuse
     because it is a background one. That is §5.4 finding 1's re-issue loop reached
     through the recovery built to prevent a different failure. */
  const { shell, proto, clock, capacitor } = setup({ settleMs: 1000 });
  shell.install();
  const first = makeElement(proto);
  first.play();
  await flush();
  shell.noteServiceRunning(true);
  assert.equal(shell.inspect().sawServiceRunning, true);

  first.paused = true;
  first.emit("pause");
  await flush();
  clock.advance(1000);
  clock.fireAll();
  await flush();
  assert.deepEqual(methods(capacitor), ["start", "stop"]);

  const second = makeElement(proto);
  second.play();
  await flush();
  assert.equal(shell.inspect().startAccepted, true);
  assert.equal(
    shell.inspect().sawServiceRunning, false,
    "the new start inherited the previous service's confirmation"
  );

  /* The new service's own startup race must now be harmless. */
  shell.noteServiceRunning(false);
  assert.equal(
    shell.inspect().startAccepted, true,
    "a startup-race report invalidated a fresh start, which puts the shell back in the re-issue loop"
  );
  const third = makeElement(proto);
  third.play();
  await flush();
  assert.deepEqual(
    methods(capacitor), ["start", "stop", "start"],
    "a redundant start was issued"
  );
});
