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
 * ── #27 CHANGED WHAT THE WINDOW IS FOR, AND IT IS WORTH READING TWICE ────────
 *
 * The service now also owns a Media3 `MediaSession` — the lock screen's metadata
 * and its transport buttons (`foray-media-session.js`). So stopping the service
 * stops the controls, and the paragraph above's "cost" turns into a defect on the
 * surface #27 exists to build: pause from the lock screen, wait 25 s, and the
 * buttons you paused with are gone.
 *
 * `setMediaLoaded()` is the fix, and the signal is not a guess: `client.js` calls
 * `media.release()` from `stopAndClose` and nowhere else, which nulls the session's
 * metadata, which `foray-media-session.js` reports here as "not loaded". So the
 * service's lifetime becomes **a Foray is loaded** rather than **audio is
 * sounding**:
 *
 *   - loaded and silent (paused, or mid-seam) — the settle window fires and does
 *     NOTHING. The session, the notification and the controls stay up.
 *   - not loaded — stop AT ONCE, no window. The page told us it closed the player,
 *     which is the attributable signal the paragraph above says would fix this.
 *
 * That is fewer `startForegroundService` calls than #244 made, not more, and every
 * one avoided is one Android 12+ cannot refuse. What it costs is a notification
 * that can outlive interest — a listener who pauses and walks away keeps it until
 * they stop the player, which is what the notification's stop button is for.
 *
 * **The fallback is the old behaviour.** `mediaLoaded` starts false and only
 * `setMediaLoaded` moves it, so if the polyfill never installs — a WebView that
 * ships `mediaSession` after all, a `client.js` that threw — every path here is
 * #244's, unchanged.
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
  /**
   * Ask for the notification permission on the first accepted start?
   *
   * TRUE BY DEFAULT, because on Android 13+ the lock-screen controls do not exist
   * without it — see `askForNotifications`. Overridable for the same reason
   * `settleMs` is: the suite's service-lifecycle tests assert the exact sequence of
   * native calls, and a permission request in the middle of every one of them would
   * be noise in thirty assertions about something else. The DEFAULT is asserted on
   * its own ("an unconfigured shell asks"), which is what stops this being a way to
   * hide the mechanism from the tests.
   */
  const askNotifications = env.askNotifications !== false;

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
  /**
   * Does the page still have a Foray loaded? See the header's #27 section.
   *
   * FALSE UNTIL SOMETHING SAYS OTHERWISE, which is what makes the absence of
   * `foray-media-session.js` cost nothing: every path below then reads exactly as
   * #244 wrote it.
   */
  let mediaLoaded = false;
  /** Has this session asked for the notification permission? Once is the whole
   *  policy — see `askForNotifications`. */
  let notificationsAsked = false;
  /** Native's answer, or `null` until it has been asked. `false` is the one value that
   *  explains a blank lock screen with everything else working. */
  let notificationsGranted = null;
  /**
   * Has native reported the service RUNNING at any point since our last start?
   *
   * The discriminator that makes `noteServiceRunning` safe. Without it, a
   * `running: false` arriving in the window between `startForegroundService` and the
   * service's own `onStartCommand` — which is a real window, on a different thread —
   * would look identical to a service that died, and clearing the gate there would
   * re-issue a start for no reason. That is §5.4 finding 1's re-issue loop, and this
   * flag is what keeps this recovery from becoming it.
   */
  let sawServiceRunning = false;
  /** Has this document announced itself to native? Once per document is the whole
   *  policy — see `newDocument`. */
  let documentAnnounced = false;
  /** Serialises bridge calls, so a `stop` and the `start` behind it cannot land out
   *  of order. See `callAndRecord`. */
  let queue = Promise.resolve();
  /** The method dispatched and not yet answered, or null. */
  let inFlight = null;
  /** Which dispatch `inFlight` belongs to. A bare name is not enough — see the clear
   *  link in `callAndRecord`, where an earlier call of the same method used to clear a
   *  later one's marker. */
  let inFlightToken = 0;
  let callSeq = 0;

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
    const token = ++callSeq;
    inFlight = method;
    inFlightToken = token;
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
          /* ONLY `start` AND `stop` TOUCH THE GATE, and the distinction is not
             fussiness. A failed `start` means we do not hold the service and the next
             `play()` should try again; a failed `stop` means we asked and cannot know,
             so false is right there too. The others must not: `state` is a DIAGNOSTIC
             and `requestNotifications` is about whether a notification is SHOWN, and
             clearing the gate because either of those did not arrive would make the
             next `play()` re-issue a start for no reason — the redundant
             background-start behaviour §5.4's first finding was about, reintroduced
             through the error path.

             SPELLED AS A WHITELIST rather than `method !== "state"`, AND THE MUTATION
             HARNESS SAYS THAT IS CURRENTLY A DISTINCTION WITHOUT A DIFFERENCE — recorded
             because the alternative is a reader concluding the test for it is vacuous.

             The blacklist form WAS wrong for a while: #27 added `requestNotifications`
             to this queue, and a prompt the user dismissed would have cleared the gate
             and put the shell back into the re-issue loop. A later review pass then took
             that call OUT of the queue entirely (it blocks every call behind a human —
             see `askForNotifications`), so `start`, `stop` and `state` are once again the
             only methods here and the two spellings agree on all three.

             Kept as a whitelist anyway, because the next method added to this queue
             should have to opt IN to clearing the gate rather than opt out, and because
             the failure mode of getting it wrong is silent. Swapping it back is a
             mutation that survives, and this paragraph is the reason. */
          if (method === "start" || method === "stop") startAccepted = false;
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
    /* CLEARED BY TOKEN, NOT BY NAME, and a review pass demonstrated why with a
       dispatch trace. `inFlight` used to be the bare method name, so with two `start`
       requests outstanding and a `stop` between them, start#1's clear link ran while
       `inFlight` already held start#2's marker and nulled it — leaving start#2 in
       flight but unmarked, so the next `play()` queued a third. That third is a
       redundant `startForegroundService`; hidden, Android 12+ refuses it, which sets
       `startAccepted = false` WHILE THE SERVICE IS ACTUALLY UP, and from there every
       `play()` re-issues a refused start. It is §5.4 finding 1's re-issue loop reached
       by a different route, and its trigger is the seam sequence this design is built
       around: settle fires, stop dispatched, next episode plays, any release event
       lands while that start is in flight. */
    const clearInFlight = function () {
      if (inFlightToken === token) {
        inFlight = null;
        inFlightToken = 0;
      }
    };
    queue = queue.then(clearInFlight, clearInFlight);
  }

  /**
   * Native says whether the service is running. Recover if it went away.
   *
   * WHY THIS EXISTS, and it is not defensive padding. The service can stop without the
   * page asking: Android killing it under memory pressure (it is `START_NOT_STICKY`, so
   * nothing restarts it), a native stop from the page-load listener, a
   * `startForeground` that failed a moment after the start was accepted. In every one
   * of those the shell's own gate — `wanted && startAccepted` — stays true, so
   * `ensureStarted` short-circuits and **no later `play()` ever re-asks**. Playback
   * continues unprotected for the rest of the Foray with a blank lock screen, silently.
   * A review pass found the first route to that state; this closes all of them.
   *
   * Clearing `startAccepted` is the whole recovery: the next `play()` — the next seam,
   * at most a couple of minutes away — re-issues a start. It does NOT start one from
   * here, deliberately: this can be called while the app is backgrounded, and a
   * background `startForegroundService` is the call Android 12+ refuses.
   */
  /**
   * Announce a freshly loaded document to native, once.
   *
   * Called by the auto-install block below, right after `install()`. It stops a service
   * a PREVIOUS document left running and clears native's stale now-playing state —
   * neither of which this page could otherwise reach, because `wanted` and
   * `mediaLoaded` both start false and `requestStop` refuses to act without `wanted`.
   *
   * THROUGH THE SERIALISED QUEUE, which is the one ordering that matters here: if the
   * listener presses play immediately, the `start` must land AFTER this stop, or the
   * page's own service is the one that gets torn down.
   */
  function newDocument() {
    if (!installed) return;
    if (documentAnnounced) return;
    documentAnnounced = true;
    callAndRecord("newDocument", function (result) {
      if (result.wasRunning) {
        /* Worth a line: it means a previous document leaked a foreground service, which
           is the failure this call exists to clean up after. A device pass seeing this
           has found a reload path worth naming. */
        log("foray-audio: a previous document had left the foreground service running");
      }
      lastReason = result.reason || "";
    });
  }

  function noteServiceRunning(running) {
    if (!installed) return;
    if (running) {
      sawServiceRunning = true;
      lastKnownRunning = true;
      return;
    }
    lastKnownRunning = false;
    if (!wanted || !startAccepted) return;
    /* See `sawServiceRunning`: without this, a start that has been accepted but not yet
       dispatched reads exactly like a service that died. */
    if (!sawServiceRunning) return;
    sawServiceRunning = false;
    startAccepted = false;
    log("foray-audio: the foreground service went away underneath us");
    /* AND RE-ASK NOW IF AUDIO IS ACTUALLY FLOWING, rather than waiting for a `play()`.
       A review pass found that waiting is not good enough twice over: while PAUSED the
       polyfill sends no writes at all, so a death is not noticed until after the resume
       `play()` has already short-circuited; and `episodeMediaSurface` has no `next`, so
       a single episode has exactly one `play()` in it and the next one never comes.

       Asking here can be refused — this may run while the app is backgrounded, and
       Android 12+ refuses a background `startForegroundService`. That is the right trade
       anyway: a refusal costs a log line and leaves us exactly where we already were,
       while not asking guarantees unprotected playback for the rest of the item. And it
       cannot loop: a refused start leaves `startAccepted` false, and the guard above
       needs it true, so this fires at most once per confirmed death. */
    if (activeCount() > 0) ensureStarted();
  }

  function ensureStarted() {
    if (wanted && startAccepted) return;
    wanted = true;
    /* Cleared at DISPATCH, so the recovery above cannot fire on the strength of a
       `running: true` from before this start. */
    sawServiceRunning = false;
    callAndRecord("start", function (result) {
      startAccepted = !!result.started;
      lastReason = result.reason || "";
      if (!startAccepted) {
        /* The degraded case, and the one a device pass has to be able to see:
           playback continues, the process is merely no longer protected. */
        log("foray-audio: Android refused to start the foreground service — " + (lastReason || "no reason given"));
        return;
      }
      askForNotifications();
    });
  }

  /**
   * Ask for the notification permission, once per session, and only after a start
   * Android accepted.
   *
   * WHY HERE AND NOT AT INSTALL. From Android 13 a notification the user has not
   * permitted is not shown, and from #27 the notification IS the transport controls —
   * so without this the lock screen stays blank on most devices with everything
   * working. The moment is chosen rather than convenient: this runs on the first
   * `play()` of a session, which is a user gesture with the app in the foreground and
   * the reason for the prompt one press old. At install time the app has just
   * launched and nothing would explain it; any later and the listener has already
   * locked the phone, which is when a system dialog is worst.
   *
   * ONCE, and native answers the rest: below API 33 it reports `requested: false` with
   * no dialog, and Android itself stops re-prompting after two denials. A denial is
   * not an error — the service runs and the audio plays; what is lost is the lock
   * screen, which is exactly what the log line says.
   */
  function askForNotifications() {
    if (!askNotifications) return;
    if (notificationsAsked) return;
    notificationsAsked = true;
    /* DELIBERATELY NOT `callAndRecord`, and a review pass found why. That helper
       serialises every call on one promise chain so a `stop` and the `start` behind it
       cannot land out of order — and `requestNotifications` resolves only after the user
       answers a system dialog. Put it in that chain and it is a head-of-line block: a
       `stop` issued while the dialog is up is queued and never dispatched, so the
       foreground service keeps running; and if the Activity is torn down under the
       dialog and the call is lost, the chain never advances again and the shell can
       neither start nor stop the service for the rest of the session.

       Ordering only ever mattered BETWEEN `start` and `stop`. This is neither, so it
       goes out on its own with both handlers supplied. */
    call("requestNotifications").then(
      function (result) {
        const answer = result || {};
        notificationsGranted = !!answer.granted;
        if (!notificationsGranted) {
          log(
            "foray-audio: notifications are not permitted, so the lock-screen controls will not appear — "
            + (answer.reason || "denied")
          );
        }
      },
      function (e) {
        /* Never touches `startAccepted`: whether a notification is SHOWN has nothing to
           do with whether we hold the service. Clearing the gate here would put the shell
           back into the re-issue loop §5.4 finding 1 was about, through a permission
           dialog. */
        lastReason = String((e && e.message) || e);
        log("foray-audio: requestNotifications failed", e);
      }
    );
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
      /* THROUGH `noteServiceRunning`, so the diagnostic and the recovery cannot
         disagree. It used to only log this case; logging a permanently unprotected
         Foray to a console nobody is reading is not a mechanism. */
      const running = !!result.running;
      if (wanted && !running) {
        log("foray-audio: the service was accepted but is not running — check logcat for startForeground");
      }
      noteServiceRunning(running);
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
    sawServiceRunning = false;
    callAndRecord("stop", function (result) {
      /* `startAccepted` is about a START, so a stop clears it either way: whatever
         native says, we are no longer holding a service we asked for. */
      startAccepted = false;
      /* GATED ON `stopped`, and a review pass found the version that was not. It read
         `wasRunning` — native's truthful PRE-call read — and set `lastKnownRunning`
         false whenever that field was present, which is always. So a stop that native
         reported as FAILED (`stopped: false`, e.g. a SecurityException from
         `stopService`) left the instrument saying the service was down while the
         service and its notification were still up. That is this field claiming more
         than it knows, which is the same defect as §5.4 finding 1 in the doc, in the
         one place the doc points a device pass at. */
      if (result.stopped) lastKnownRunning = false;
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
      /* `mediaLoaded` IS CHECKED HERE AND NOT AT ARM TIME, deliberately. A Foray can
         be closed during the window — a `stopAndClose` two seconds after a pause —
         and the state that matters is the one when the window ends. Checking at arm
         time would keep the service for 25 s after a close, and checking at arm time
         only would also mean a seam that started while loaded could stop the service
         if the flag flipped mid-window. */
      if (activeCount() === 0 && !mediaLoaded) requestStop();
    }, settleMs);
  }

  /**
   * Tell the shell whether the page still has media loaded.
   *
   * Called by `foray-media-session.js` — the ONLY caller, and the only thing that can
   * see the difference between "paused" and "closed": `client.js` nulls the media
   * session's metadata from `stopAndClose` and from nowhere else.
   *
   * A FALSE STOPS AT ONCE, with no settle window, and that is safe for the one
   * reason the window exists: the window protects a `startForegroundService` that
   * has to follow, and after a close there is no `play()` coming that the listener
   * did not ask for from a foreground screen. A TRUE cancels nothing and starts
   * nothing — the service is already up from the `play()` that preceded it.
   */
  function setMediaLoaded(loaded) {
    const next = !!loaded;
    if (next === mediaLoaded) return;
    mediaLoaded = next;
    if (mediaLoaded) return;
    if (!installed) return;
    if (activeCount() > 0) return;
    cancelStop();
    requestStop();
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
      /* THE GUARD IS AHEAD OF THE SET MUTATION, and a review pass found the version
         where it was not. `reconcile` checks `installed`, but `active.add(el)` ran
         first — so after `uninstall()` a `playing` event on a previously-watched
         element put it back into `active`, where nothing prunes it any more, holding a
         strong reference to a discarded media element and leaving a re-installed shell
         starting dirty at `active: 1`. */
      if (!installed) return;
      try {
        active.add(el);
        reconcile();
      } catch (e) {
        log("foray-audio: reconcile failed", e);
      }
    };
    const release = function () {
      if (!installed) return;
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
      /* `!mediaLoaded` BELONGS IN THIS GUARD TOO, and leaving it out was the first
         bug this section grew. The net's job is to stop a service whose settle timer
         was frozen — but with a Foray still loaded there is nothing to stop, and
         becoming visible is exactly when a listener is about to look at the
         notification. Without this term, foregrounding the app after a long pause
         tore down the lock-screen session it was about to be used from. */
      if (isVisible() && wanted && !mediaLoaded && activeCount() === 0 && overdue) {
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

  /** Undo everything, INCLUDING the foreground service.
   *
   *  Exists for the test suite, and because a patch with no inverse is a patch nobody
   *  can bisect — but it is also on `window.ForayAudioShell`, which is the object
   *  `docs/android-native-code.md` §6.4 tells a device pass to drive from
   *  `chrome://inspect`. A review pass found that it left the service running with
   *  `wanted: true` and no JS path back: the prototype is restored, so no future
   *  `play()` reaches the shell, and only `stopWithTask` or the Activity's destruction
   *  would ever clear it. So the service is asked to stop FIRST, while `wanted` still
   *  says we hold one. */
  function uninstall() {
    if (!installed) return false;
    if (wanted) requestStop();
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
    /* Cleared for the same reason `active` is: a re-installed shell must not start
       believing a Foray from a previous life is still loaded, which would make its
       first settle window a no-op and leave the service up with nothing playing. */
    mediaLoaded = false;
    sawServiceRunning = false;
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
      documentAnnounced,
      stopPending: stopTimer !== null,
      settleMs,
      mediaLoaded,
      notificationsAsked,
      notificationsGranted,
      sawServiceRunning,
    };
  }

  return { install, uninstall, inspect, refresh, setMediaLoaded, noteServiceRunning, newDocument };
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
    /* AFTER install, because `newDocument` refuses to act before it. This is the one
       line that closes the reloaded-page hole, and it is here rather than inside
       `install()` so that the suite's thirty exact-call-sequence tests are about the
       service and not about this. `shell-invariants.test.mjs` asserts the call exists,
       since a deleted line here fails nothing else. */
    shell.newDocument();
  } catch (e) {
    /* A shell that cannot install must not take the page down with it. */
    if (typeof console !== "undefined" && console.warn) console.warn("foray-audio: install failed", e);
  }
}
