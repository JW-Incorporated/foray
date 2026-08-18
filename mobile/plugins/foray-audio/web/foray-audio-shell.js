/* The web half of `foray-audio`: tell the native `mediaPlayback` foreground
 * service when the WebView starts and stops making sound.
 *
 * SHIPS ONLY INSIDE THE NATIVE SHELL. `tools/mobile/prepare-webdir.mjs` copies
 * this file into `mobile/www/` and adds one `<script type="module">` tag to the
 * COPY of `index.html` that the bundle carries. It is not referenced by the
 * website's `index.html` and is not served by Pages.
 *
 * WHY IT PATCHES A PROTOTYPE INSTEAD OF LISTENING ON THE DOCUMENT
 * The obvious implementation is `document.addEventListener("play", …, true)`,
 * which catches non-bubbling media events at the capture phase. It does not work
 * here: `player/html-audio-backend.js` builds its element with `new Audio()`, and
 * a DETACHED element's events never reach `document` — the propagation path stops
 * at its own detached root. So the only reliable hook is
 * `HTMLMediaElement.prototype.play`, and the shell wraps it.
 *
 * That is an intrusive thing to do to somebody else's player, so the wrapper obeys
 * three rules absolutely:
 *   1. it calls through, always, and returns exactly what the original returned;
 *   2. every piece of our own bookkeeping is inside a `try`, so a bug here can
 *      cost the foreground service and can never cost a `play()`;
 *   3. it does not observe the returned promise. Attaching a handler to it would
 *      mark a rejection as handled and silently remove a console warning the
 *      player's own author is relying on.
 *
 * `player/` IS NOT TOUCHED, deliberately: #224 is open there and PR #241 owns
 * `sw.js`. Nothing in the player knows this file exists.
 *
 * ── THE SETTLE WINDOW IS THE ONLY INTERESTING DECISION HERE ──────────────────
 *
 * Stopping the service the instant the last element pauses would be a crash. A
 * cross-episode seam pauses one element, loads, and plays another, and from
 * Android 12 `startForegroundService` throws
 * `ForegroundServiceStartNotAllowedException` when the app is in the background.
 * So a stop at the top of a hidden seam would be followed by a start we are not
 * allowed to make.
 *
 * The window has a floor and a ceiling, and both are numbers this repo already
 * measured or read out of an engine:
 *
 *   FLOOR — a hidden seam. `docs/research/mp1-background-audio.md` §4.4 measured
 *   hidden-page media loads at 9–11 s even for a small LOCAL bundled file, because
 *   each step of the HTML media load algorithm is a queued task delivered ~3 s
 *   apart while the page is hidden. #239 therefore gives a hidden load **20 s**
 *   before it gives up. The window must outlast that or it fires mid-seam.
 *
 *   CEILING — Blink's own grace period. `page_scheduler_impl.h`:
 *   "A page cannot be throttled or frozen 30 seconds after playing audio"
 *   (`kRecentAudioDelay`). Our settle timer runs in a page that has just gone
 *   SILENT, so it is inside that 30 s window — and only inside it. A window at or
 *   past 30 s is a timer that can be frozen before it fires, which would leak the
 *   service until the app came back to the foreground.
 *
 * 20 s < 25 s < 30 s. The window is tight because the two constants it sits
 * between are not ours, and if #239's hidden deadline ever rises past ~28 s these
 * two requirements stop being satisfiable at the same time — at which point the
 * answer is a native stop timer, not a bigger number here.
 *
 * WHAT IT COSTS, stated because it is a real defect and not a rounding error: a
 * user who deliberately pauses sees "Playback active" for up to 25 more seconds.
 * The window cannot be shortened by telling a deliberate pause apart from a seam,
 * because from JS they are the same event — and #227's own safety nets could not
 * tell an autoplay refusal, an audio-focus denial and an unexplained pause apart
 * either (MP1 §5.2). What fixes it is #27's Android half: once a pause can come
 * from a transport control, a pause the app ISSUED is attributable and can stop the
 * service at once.
 *
 * NOTHING IN THIS FILE HAS BEEN OBSERVED IN A WEBVIEW. The suite in
 * `tools/mobile/foray-audio-shell.test.mjs` drives every path against a fake
 * bridge and a fake media prototype in Node, which proves the state machine and
 * proves nothing about Android. See `docs/android-native-code.md` § what is
 * measured.
 */

/** The `@CapacitorPlugin(name = …)` on `ForayAudioPlugin.java`. If these two ever
 *  disagree the bridge answers "plugin not implemented" and the service is never
 *  started, with everything still green — so `shell-invariants.test.mjs` asserts
 *  they match by reading the Java. */
export const PLUGIN_NAME = "ForayAudio";

/** See the header. Floor: #239's 20 s hidden load deadline. Ceiling: Blink's 30 s
 *  `kRecentAudioDelay`, past which our own timer can be frozen. */
export const STOP_SETTLE_MS = 25000;

/** Every event that can mean "this element is no longer making sound". `emptied`
 *  and `abort` matter as much as `pause`: `load()` on a live element fires them
 *  and does not always fire `pause`, and a seam is a `load()`. */
export const RELEASE_EVENTS = ["pause", "ended", "emptied", "abort", "error"];

/** `playing` as well as the patched `play()`, for playback that resumes after a
 *  stall without anybody calling `play()` again. */
export const ACQUIRE_EVENTS = ["playing"];

/**
 * Is this the one platform the shell is for?
 *
 * Android, with a bridge that can reach native. `isNativePlatform()` is NOT
 * consulted: `getPlatform() === "android"` already implies it, and
 * `shell-invariants.test.mjs` records a real bridge whose `isNativePlatform()`
 * threw — one fewer call on somebody else's object is one fewer way to be wrong.
 *
 * iOS is excluded on purpose rather than by omission. There is no native code to
 * call there: WebKit sets the `AVAudioSession` category itself for an audible
 * `<audio>` element, so iOS's whole requirement is the `UIBackgroundModes` key
 * (MP1 §7.3), which `tools/mobile/inject-background-audio.mjs` writes.
 */
export function shellApplies(capacitor) {
  try {
    if (!capacitor) return false;
    if (typeof capacitor.getPlatform !== "function") return false;
    if (capacitor.getPlatform() !== "android") return false;
    return typeof capacitor.nativePromise === "function";
  } catch (e) {
    /* A bridge that throws is a bridge we cannot use. Failing closed here means no
       foreground service; failing open would mean calling into a broken bridge on
       every play. */
    return false;
  }
}

/**
 * Build the shell. Nothing happens until `install()`.
 *
 * @param {object} env
 * @param {object} env.capacitor    `window.Capacitor`, or a fake.
 * @param {object} env.mediaProto   `HTMLMediaElement.prototype`, or a fake.
 * @param {object} [env.doc]        `document`, for `visibilityState` and its event.
 * @param {Function} env.setTimeout
 * @param {Function} env.clearTimeout
 * @param {number} [env.settleMs]   Overridable so tests do not sleep 25 s.
 * @param {Function} [env.log]
 */
export function createForayAudioShell(env) {
  const capacitor = env.capacitor;
  const mediaProto = env.mediaProto;
  const doc = env.doc || null;
  const settleMs = typeof env.settleMs === "number" ? env.settleMs : STOP_SETTLE_MS;
  const setTimer = env.setTimeout;
  const clearTimer = env.clearTimeout;
  const log = typeof env.log === "function" ? env.log : function () {};
  /** A clock, only ever used for elapsed time — never for wall-clock meaning — so a
   *  test can drive it and `Date.now` is a fine default. */
  const now = typeof env.now === "function" ? env.now : Date.now;

  /** Elements that have been played and not yet released. A `Set` rather than a
   *  counter because `play()` on an already-playing element is legal and must not
   *  count twice. */
  const active = new Set();
  /** Elements already carrying our listeners, so a second `play()` does not add a
   *  second set. `WeakSet` so watching an element never keeps it alive. */
  const watched = new WeakSet();

  let installed = false;
  let originalPlay = null;
  /** The wrapper we installed, so `uninstall` can tell whether it is still the one
   *  on the prototype. */
  let patchedPlay = null;
  /** Have we asked for the service and not yet asked to stop it? */
  let wanted = false;
  /**
   * Did native ACCEPT our last start? Distinct from `wanted`: a start can be
   * refused — `ForegroundServiceStartNotAllowedException` — and then the next
   * `play()` must try again.
   *
   * DELIBERATELY NOT "is the service running". A review pass found this gated on
   * native's post-call read of the service's own flag, which is a race:
   * `startForegroundService` only asks ActivityManager, and the service's
   * `onStartCommand` runs later on the main thread, so that read answered false on
   * every first start — which made this guard never short-circuit and every
   * subsequent `play()` re-issue a start, including the one across a hidden seam
   * that the settle window exists to keep out of the background. `started` is the
   * strongest thing knowable synchronously, so it is what this tracks.
   */
  let startAccepted = false;
  /** Native's answer to the last `state()` call, which is the only call that can
   *  answer "is it running?" truthfully. `null` means nobody has asked. */
  let lastKnownRunning = null;
  let lastReason = "";
  let stopTimer = null;
  /** When the settle window was armed, so the visibility net can tell a frozen timer
   *  from one that is still legitimately counting. See `onVisibilityChange`. */
  let stopArmedAt = 0;
  let visibilityHandler = null;
  /** Serialises bridge calls, so a `stop` and the `start` behind it cannot land out
   *  of order. See `callAndRecord`. */
  let queue = Promise.resolve();
  /** The method dispatched and not yet answered, or null. */
  let inFlight = null;

  function call(method) {
    try {
      const p = capacitor.nativePromise(PLUGIN_NAME, method, {});
      return p && typeof p.then === "function" ? p : Promise.resolve(p);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Ask native for one thing, in order, and record what it answered.
   *
   * SERIALISED THROUGH A PROMISE CHAIN, because a seam can put a `stop` and a
   * `start` a few milliseconds apart and Capacitor dispatches plugin calls on a
   * thread pool. Out of order, the `start` lands first and the `stop` switches the
   * service off underneath live audio — a failure that looks exactly like the
   * problem this plugin was added to fix. The chain costs one round-trip of latency
   * on a call that happens a handful of times per Foray.
   *
   * `inFlight` dedupes an identical request that has not been answered yet: two
   * `play()` calls before the first `start` resolves are one intention. It is
   * cleared when the call SETTLES rather than when it is dispatched, which is what
   * still lets a refused start be retried by the next `play()`.
   *
   * Both handlers are always supplied, so this can never raise an unhandled
   * rejection inside a media event handler.
   */
  function callAndRecord(method, onResult) {
    if (inFlight === method) return;
    inFlight = method;
    queue = queue.then(function () {
      return call(method).then(
        function (result) {
          try {
            onResult(result || {});
          } catch (e) {
            log("foray-audio: handling the " + method + " result failed", e);
          }
        },
        function (e) {
          startAccepted = false;
          lastReason = String((e && e.message) || e);
          log("foray-audio: " + method + " failed", e);
        }
      );
    });
    /* BOTH handlers, so this link can never leave `queue` in a rejected state. A
       rejected `queue` is permanent: every later `.then` is skipped, and the shell
       would silently stop talking to native for the rest of the session. The `.then`
       above cannot reject today — `call(method).then(ok, err)` handles both sides —
       but `err` calls `log`, which is the embedder's function and not ours. One
       argument here is one whole class of dead shell. */
    const clearInFlight = function () {
      if (inFlight === method) inFlight = null;
    };
    queue = queue.then(clearInFlight, clearInFlight);
  }

  function ensureStarted() {
    if (wanted && startAccepted) return;
    wanted = true;
    callAndRecord("start", function (result) {
      startAccepted = !!result.started;
      lastReason = result.reason || "";
      if (!startAccepted) {
        /* The degraded case, and the one a device pass has to be able to see:
           playback continues, the process is merely no longer protected. */
        log("foray-audio: Android refused to start the foreground service — " + (lastReason || "no reason given"));
      }
    });
  }

  /**
   * Ask native whether the service is actually running, and remember the answer.
   *
   * A SEPARATE CALL ON PURPOSE, and never gated on. `start()` cannot answer it —
   * `startForegroundService` is asynchronous and the service's `onStartCommand` runs
   * later on the main thread — but by the time anything calls this, that dispatch has
   * happened. It is the honest instrument, and it is the one thing that can see a
   * service that started and then failed its own `startForeground()` (an API 34
   * service-type mismatch, a missing permission).
   *
   * Exposed as `window.ForayAudioShell.refresh()` so a device pass can read a real
   * answer off `chrome://inspect` rather than a guess.
   */
  function refresh() {
    callAndRecord("state", function (result) {
      lastKnownRunning = !!result.running;
      if (wanted && !lastKnownRunning) {
        log("foray-audio: the service was accepted but is not running — check logcat for startForeground");
      }
    });
    /* Resolves after everything already queued, which is what makes an awaited
       `refresh()` see the result of a start issued a moment earlier. */
    return queue;
  }

  function requestStop() {
    if (!wanted) return;
    /* `wanted` GOES FALSE AT DISPATCH, and that is what makes the window between
       asking for a stop and native answering safe. A `play()` in that window reaches
       `ensureStarted`, whose guard is `wanted && startAccepted` — false on the first
       term — so it queues a start rather than returning early.

       An earlier version of this function ALSO cleared the start flag here,
       with a comment calling it a bug fix. It was not: the mutation harness deleted
       the line and all 39 tests stayed green, because `wanted` alone already decides
       that guard. The line was removed rather than kept with a truer comment, since a
       second flag mid-transition is a second thing to reason about for no behaviour.
       Recorded because "I thought this was a defect and my own test proved it was
       not" is worth more written down than quietly dropped. */
    wanted = false;
    callAndRecord("stop", function (result) {
      /* `startAccepted` is about a START, so a stop clears it rather than reading
         anything back: whatever native says, we are no longer holding a service we
         asked for. `wasRunning` is native's truthful pre-call read and is kept only as
         diagnostics. */
      startAccepted = false;
      lastKnownRunning = result.wasRunning === undefined ? lastKnownRunning : false;
      lastReason = result.reason || "";
    });
  }

  /** True only when we can SEE that the page is visible. An unknown answer counts
   *  as hidden, because hidden is the branch that takes the safe, slow path. */
  function isVisible() {
    try {
      return !!doc && doc.visibilityState === "visible";
    } catch (e) {
      return false;
    }
  }

  /**
   * How many watched elements are still making sound, pruning the ones that
   * stopped without telling us.
   *
   * The pruning is load-bearing rather than tidiness. A `play()` blocked by the
   * autoplay policy leaves `paused === true` and fires no event at all, so the
   * element would otherwise sit in `active` forever and hold the service up for the
   * rest of the session. Reading `paused`/`ended` back off the element after the
   * real `play()` has run is what makes a refused play self-correcting.
   *
   * `el.error` IS PART OF THE TEST, and a review pass is why. Only the media LOAD
   * algorithm sets `paused = true` — which is what makes `emptied` and `abort` safe —
   * so a fatal decode or network error MID-PLAYBACK leaves `paused === false` and
   * `ended === false`. `error` is in `RELEASE_EVENTS`, but the event alone changed
   * nothing: the element stayed in `active`, `reconcile` kept calling
   * `ensureStarted`, and the service plus its notification stayed up for the rest of
   * the session with no audio — exactly the leak this prune exists to prevent. The
   * parameterised `RELEASE_EVENTS` test set `paused = true` before emitting, so it
   * passed for `error` without ever exercising the real element state.
   *
   * `el.readyState === 0` was suggested with it and is DELIBERATELY NOT USED. A
   * brand-new element has `readyState === 0` for the whole gap between `play()` and
   * its first metadata — which is precisely the incoming element at a seam — so
   * pruning on it would drop the one element the service is being started for.
   */
  function activeCount() {
    active.forEach(function (el) {
      let stopped = true;
      try {
        stopped = !!(el.paused || el.ended || el.error);
      } catch (e) {
        stopped = true;
      }
      if (stopped) active.delete(el);
    });
    return active.size;
  }

  function cancelStop() {
    if (stopTimer === null) return;
    try {
      clearTimer(stopTimer);
    } catch (e) {
      log("foray-audio: clearing the settle timer failed", e);
    }
    stopTimer = null;
  }

  function armStop() {
    if (!wanted) return;
    if (stopTimer !== null) return;
    stopArmedAt = now();
    stopTimer = setTimer(function () {
      stopTimer = null;
      if (activeCount() === 0) requestStop();
    }, settleMs);
  }

  function reconcile() {
    /* Guarded on `installed` because per-element listeners cannot be removed once
       an element is gone — `watch` registers them in a closure and `uninstall`
       restores the prototype, not the elements. Without this an uninstalled shell
       would keep calling native from events on elements it used to watch. */
    if (!installed) return;
    if (activeCount() > 0) {
      cancelStop();
      ensureStarted();
    } else {
      armStop();
    }
  }

  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    /* TWO HANDLERS, NOT ONE, and the difference is a bug the suite caught. An
       acquire has to put the element BACK in `active` before reconciling: the pause
       that preceded it pruned the element out (see `activeCount`), so a `playing`
       event that only reconciled would find nothing active, leave the settle timer
       armed, and stop the foreground service while audio was flowing. Both close
       over `el` rather than reading `event.target`, so a retargeted event cannot
       point them at the wrong element. */
    const acquire = function () {
      try {
        active.add(el);
        reconcile();
      } catch (e) {
        log("foray-audio: reconcile failed", e);
      }
    };
    const release = function () {
      try {
        reconcile();
      } catch (e) {
        log("foray-audio: reconcile failed", e);
      }
    };
    for (const name of RELEASE_EVENTS) el.addEventListener(name, release, false);
    for (const name of ACQUIRE_EVENTS) el.addEventListener(name, acquire, false);
  }

  /**
   * The visibility hook, which exists for exactly one failure mode: if the settle
   * timer was frozen by Blink before it fired, the service would still be running
   * when the user came back. Becoming visible with nothing playing is both the proof
   * that happened and the safest possible moment to fix it, because a restart from
   * the foreground is always permitted.
   *
   * THE ELAPSED-TIME CHECK IS THE WHOLE GUARD, and a review pass caught its absence.
   * Without it this stopped the service on ANY visible-and-silent transition — so a
   * user foregrounding the app in the middle of a hidden seam (9–11 s measured, 20 s
   * allowed by #239) cancelled a settle window that was still legitimately counting.
   * Background the app again before the seam's `play()` lands and that `play()` issues
   * a background `startForegroundService`, which Android 12+ refuses: the exact
   * failure the settle window exists to prevent, reintroduced by the net meant to
   * protect it.
   *
   * `now() - stopArmedAt >= settleMs` is precisely "this timer should already have
   * fired", which is the definition of frozen. A window still inside its own duration
   * is left alone, and its own timer stops the service on time.
   */
  function onVisibilityChange() {
    try {
      const overdue = stopTimer !== null && now() - stopArmedAt >= settleMs;
      if (isVisible() && wanted && activeCount() === 0 && overdue) {
        cancelStop();
        requestStop();
        return;
      }
      reconcile();
    } catch (e) {
      log("foray-audio: visibility reconcile failed", e);
    }
  }

  function install() {
    if (installed) return false;
    if (!shellApplies(capacitor)) return false;
    if (!mediaProto || typeof mediaProto.play !== "function") return false;

    originalPlay = mediaProto.play;
    /* A NAMED function expression, so this shows up as `forayAudioPlay` in a stack
       trace rather than as an anonymous frame inside somebody else's player. */
    patchedPlay = function forayAudioPlay() {
      const el = this;
      try {
        watch(el);
      } catch (e) {
        log("foray-audio: could not watch an element", e);
      }
      /* THE CALL-THROUGH. Before our own bookkeeping, because `paused` is only
         false once the real `play()` has run — which is what makes the refused-play
         case above prune itself — and because a throw in our code must not be able
         to swallow a play. */
      const returned = originalPlay.apply(el, arguments);
      try {
        active.add(el);
        reconcile();
      } catch (e) {
        log("foray-audio: bookkeeping after play failed", e);
      }
      /* Returned untouched and unobserved. See rule 3 in the header. */
      return returned;
    };
    mediaProto.play = patchedPlay;

    if (doc && typeof doc.addEventListener === "function") {
      visibilityHandler = onVisibilityChange;
      doc.addEventListener("visibilitychange", visibilityHandler, false);
    }

    installed = true;
    return true;
  }

  /** Undo everything. Exists for the test suite, and because a patch with no
   *  inverse is a patch nobody can bisect. */
  function uninstall() {
    if (!installed) return false;
    /* ONLY IF OURS IS STILL THE ONE ON THE PROTOTYPE. If anything patched
       `HTMLMediaElement.prototype.play` after we did — another Capacitor plugin, an
       injected script — restoring blindly would silently DELETE that wrapper, which is
       the mirror image of rule 1 in this file's header. Found by a review pass. */
    if (mediaProto.play === patchedPlay) {
      mediaProto.play = originalPlay;
    } else {
      log("foray-audio: play() was patched again after we installed; leaving it alone");
    }
    if (doc && visibilityHandler && typeof doc.removeEventListener === "function") {
      doc.removeEventListener("visibilitychange", visibilityHandler, false);
    }
    visibilityHandler = null;
    cancelStop();
    active.clear();
    installed = false;
    return true;
  }

  /**
   * State, for the suite and for a device probe that needs to report something better
   * than "the audio kept playing". No side effects except the pruning `activeCount`
   * does.
   *
   * READ THE FIELD NAMES LITERALLY, because two of them used to be one field that
   * claimed more than it knew. `startAccepted` is *our request was accepted*, which is
   * all a synchronous bridge call can establish. `lastKnownRunning` is *the service's
   * own answer, as of the last `refresh()`* — `null` until something asks. Nothing
   * here reports "the service is running now"; only `await refresh()` gets that.
   */
  function inspect() {
    return {
      installed,
      active: activeCount(),
      wanted,
      startAccepted,
      lastKnownRunning,
      lastReason,
      stopPending: stopTimer !== null,
      settleMs,
    };
  }

  return { install, uninstall, inspect, refresh };
}

/* ------------------------------------------------------------- auto-install */

/* Guarded on `window` so importing this module in Node — which the test suite does
 * — installs nothing. In a browser that is not the Android shell, `install()`
 * returns false and the prototype is never touched, which is what makes shipping
 * this file to iOS and to the web harmless. */
if (typeof window !== "undefined") {
  try {
    const shell = createForayAudioShell({
      capacitor: window.Capacitor,
      mediaProto: typeof window.HTMLMediaElement === "function" ? window.HTMLMediaElement.prototype : null,
      doc: typeof document !== "undefined" ? document : null,
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      log: function (message, error) {
        if (window.console && window.console.warn) window.console.warn(message, error || "");
      },
    });
    /* Exposed so `chrome://inspect` on a real device can read `inspect()` without a
       build, and `await window.ForayAudioShell.refresh()` before it, which is the only
       call that gets a truthful "is the service running". `HUMAN-ACTIONS.md`'s Android
       device pass is the reader. */
    window.ForayAudioShell = shell;
    shell.install();
  } catch (e) {
    /* A shell that cannot install must not take the page down with it. */
    if (typeof console !== "undefined" && console.warn) console.warn("foray-audio: install failed", e);
  }
}
