/* ONE DEADLINE — "race a promise against a clock" and the real timer behind it
   (code-health CH-40, P2-05).

   The player asks a lot of things that may never answer: a bundle file, the
   native bridge, a Capacitor plugin wedged after a resume, an IndexedDB write
   in a backgrounded WKWebView, the directory's network. Each of those calls is
   bounded, and the bound used to be written out at every site — eight hand-
   rolled races and three copies of the same `REAL_SCHEDULER` — with semantics
   that had already drifted (some swallowed the inner rejection, some did not;
   some cleared their timer, one could not be told to). The next deadline fix
   would have landed in one copy and not the other seven.

   So the race is `withinMs`, and what each caller gets on the clock is an
   ARGUMENT, never a copy:
     - `fallback` (default `null`) is the value the race RESOLVES with when the
       bound passes first: `null` (id3-chapters, client.js's voice lookup),
       `false` (client.js's storageReady, durable-store's purge wait),
       `{ ok: false, reason: "timeout" }` (download-bridge),
       `{ ok: false, code: "timeout" }` (foray-directory), and so on. An object
       fallback is the caller's own, built per call, so no two answers share it.
     - `reject` (a function answering an Error) makes the bound REJECT instead:
       durable-store's `TimeoutError`, which its caller's catch records as that
       tier's fault and the circuit breaker counts. A resolve-null there would
       read a hung write as a success.
     - `onTimeout` runs when the clock wins, and only then (foray-directory
       aborts its request there); a throw from it is swallowed.
     - `scheduler` is `{ schedule(ms, fn) -> cancel }`, so a suite drives the
       clock by hand instead of sleeping (`REAL_SCHEDULER` below by default).

   What `withinMs` does NOT do is swallow the inner promise's rejection: it
   propagates, exactly as `Promise.race` would. A caller whose contract is
   "never rejects" maps the rejection itself, before the race
   (`promise.then(ok, () => fallback)`), so whether a site swallows is visible
   at the site rather than buried in a flag.

   Always, on every settle — answer, rejection or clock — the timer is
   cancelled, so a call that answered in 40 ms does not hold a ten-second
   timer open (one per `list()` on every resume, once). A scheduler that
   throws when arming means NO bound rather than a lost answer (a host with no
   timer still gets the plugin's answer), and a cancel that throws is
   swallowed: the timer it could not clear only fires into a settled race.

   A bound that is not a finite positive number is NO bound: the promise is
   handed back as it is. `Infinity` is how a caller says "unbounded"
   (build-stamp.js's own documented use), and 0, a negative or NaN is a
   misconfiguration that must not become an instant timeout.

   build-stamp.js keeps its own small copy of the null-on-the-clock shape: it
   is reached by the release signing jobs (tools/ci/path-policy.test.mjs walks
   tools/mobile/prepare-webdir.mjs's imports), and this module also carries
   the scheduler moved out of files that are not on that walk. deadline.test.js
   pins that copy to `withinMs` so the two cannot drift.

   No imports: a leaf, so anything in the player graph can use it. */

/**
 * The wall clock and its timers, for every module that takes an injected
 * scheduler (queue-manager.js, native-engine.js, engine-diagnostics.js, and
 * `withinMs` here). `nowMs` is `Date.now()`; `schedule(ms, fn)` arms a real
 * `setTimeout` and answers its own cancel, so no caller tracks timer ids.
 *
 * The timer is NEVER unref'd, and that is a finding rather than an oversight
 * (PR #610's first CI run; LOAD_SETTLE_TIMEOUT_MS in html-audio-backend.js
 * carries the same lesson). Something always awaits these timers. An unref'd
 * timer cannot keep Node's event loop alive, so when the only other pending
 * work is the call that never answers — exactly the case a bound exists for —
 * the loop drains, the await is abandoned, and node:test cancels the test and
 * every test after it ("Promise resolution is still pending but the event loop
 * has already resolved"). Windows masked it with another live handle; Linux
 * did not. A browser has no `unref` anyway, and every caller cancels the
 * timer the moment it settles, so it never outlives its own bound.
 */
export const REAL_SCHEDULER = Object.freeze({
  nowMs: () => Date.now(),
  schedule(ms, fn) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
});

/**
 * `promise`, or the deadline's answer once `ms` has passed, whichever is first.
 *
 * @template T, F
 * @param {Promise<T>|T} promise  what is being waited on; its rejection propagates
 * @param {number} ms             the bound; not a finite positive number = no bound
 * @param {object} [opts]
 * @param {F} [opts.fallback=null]         resolved on the clock
 * @param {() => Error} [opts.reject]      when given, the clock rejects with its answer instead
 * @param {() => void} [opts.onTimeout]    runs when the clock wins, never for an answered race
 * @param {{schedule(ms: number, fn: Function): Function}} [opts.scheduler]
 * @returns {Promise<T|F>}
 */
export function withinMs(promise, ms, { fallback = null, reject = null, onTimeout = null, scheduler = REAL_SCHEDULER } = {}) {
  if (!(Number.isFinite(ms) && ms > 0)) return Promise.resolve(promise);
  return new Promise((resolve, rejectRace) => {
    let settled = false;
    let cancel = null;
    const settle = (answer, value) => {
      if (settled) return;
      settled = true;
      if (typeof cancel === "function") {
        try { cancel(); } catch (_) { /* a timer we cannot clear only fires into a settled race */ }
      }
      answer(value);
    };
    try {
      cancel = scheduler.schedule(ms, () => {
        if (settled) return;
        if (typeof onTimeout === "function") {
          try { onTimeout(); } catch (_) { /* the clock's answer stands */ }
        }
        if (typeof reject === "function") settle(rejectRace, reject());
        else settle(resolve, fallback);
      });
    } catch (_) {
      cancel = null; /* a host with no timer: no bound, never a lost answer */
    }
    /* A scheduler that fired inside schedule() settled before its cancel
       existed; cancel it now. */
    if (settled && typeof cancel === "function") {
      try { cancel(); } catch (_) { /* as above */ }
    }
    Promise.resolve(promise).then((v) => settle(resolve, v), (err) => settle(rejectRace, err));
  });
}
