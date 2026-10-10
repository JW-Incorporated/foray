/* The web half of ForayDownloads: how the page asks the phone to fetch an
 * episode's audio into the app's own files directory, and how the phone tells
 * the page what happened.
 *
 * Issue #29, Store/Policy; docs/roadmap/player-features.md PQ-17. The rules
 * about the RECORD — what a download is in, who is evicted, what the player
 * opens — are `download-store.js`'s (PQ-16) and are not restated here. This
 * file is the WIRE and nothing else: six calls into the native plugin, three
 * events out of it (replayed from `list()` once at subscription, CH3-05), and
 * the one promise it makes to its callers, which is that nothing here ever
 * rejects.
 *
 * HOW IT REACHES NATIVE. Through `window.Capacitor.nativePromise(plugin,
 * method, options)`, the same call `durable-store.js`'s `vaultTier` makes to
 * ForayVault and `foray-tts.js` makes to its plugin: the page needs no import
 * and no bundle (there is no bundler in this repo), because the plugin is
 * compiled into the app by `cap sync` from `mobile/package.json`. Like
 * `foray-vault/package.json` says of itself (`//no-js-entry`), the plugin has
 * no JS entry on purpose — THIS file is its web half. Both native halves
 * exist and `mobile/package.json` declares the plugin (PQ-21): the iOS half (a
 * background `URLSession` store, PQ-20) is
 * `mobile/plugins/foray-downloads/ios/Sources/ForayDownloadsPlugin/`, the
 * Android half (the system `DownloadManager`, PQ-22) is
 * `mobile/plugins/foray-downloads/android/src/main/java/ai/jwlabs/foura/downloads/`.
 * The `{ ok: false }` deadline path below is for a bridge that hangs, or a
 * shell built without the plugin: every call answers through it, and the
 * page shows "Download failed" rather than a spinner that never ends.
 *
 * WHEN THERE IS NO BRIDGE. `createDownloadBridge` returns `null`, and the page
 * draws no Download control at all (PQ-18: a web build never downloads —
 * CORS, #29 — so the honest UI is no button, not a disabled one). The test is
 * `typeof bridge?.nativePromise === "function"`, the shell rule from
 * `foray-audio-shell.js`: NOT `isNativePlatform()`, which
 * `shell-invariants.test.mjs` once recorded throwing on a real bridge. One
 * fewer call on somebody else's object is one fewer way to be wrong.
 *
 * WHY EVERY CALL RACES A DEADLINE. A native method that never answers — a
 * plugin missing from this binary, a bridge wedged mid-navigation — would
 * otherwise leave an `await` hanging in `deleteMyData` (PQ-18 step 7 purges
 * the files before the keys) or in a click handler. Ten seconds is long
 * enough for a file-system walk on a slow phone and short enough that the
 * listener sees an answer. Every outcome, including a throw, becomes a
 * resolved `{ ok: false, reason }`: callers branch on `ok`, never on `catch`.
 *
 * EVENTS. The plugin emits `downloadProgress {id, bytes, total}`,
 * `downloadDone {id, path, bytes}` and `downloadFailed {id, reason, status}`;
 * each is subscribed through `native-engine.js`'s `listenTo` (imported, one
 * copy for both plugins — code-health CH-12), per event name:
 * `Capacitor.addListener` when the bridge has it, else its thinner primitive
 * `nativeCallback(plugin, "addListener", { eventName })`, else nothing (a
 * page with no event path still hears the boot replay below). Every event
 * reaches the caller as `onEvent(name, payload)`, untouched;
 * `download-store.js`'s `reportFromEvent(name, payload)` turns it into the
 * record status `applyProgress` keys on (`downloadFailed`'s own `status` is
 * the HTTP one).
 *
 * THE NATIVE INDEX IS THE ONE TRUTH (CH3-05, R4-02/R4-04). The page's
 * `cp_downloads` is a copy fed by these events, and two things a live event
 * cannot carry make it lie: iOS MOVES the app's container on every update, so
 * a stored absolute path goes stale (ForayDownloadsPlugin.swift's header: the
 * page should take paths from `list()`); and a transfer that finished, or that
 * the plugin flipped to `interrupted` at load, emitted its event before the
 * page subscribed. So the moment a listener subscribes (app.js's
 * `bootDownloads`, once per page), the bridge asks `list()` once and replays
 * every row to it AS the event the page already handles (`listReplay`): a
 * `done` row is `downloadDone` with TODAY's path, a `failed` /
 * `unplayable-here` one is `downloadFailed`, a `downloading` one is
 * `downloadProgress`. The record's own rules then apply unchanged: a row the
 * page never asked for is dropped by app.js, a late tick never un-finishes a
 * file, and a replay that changes nothing is `applyProgress`'s identity — no
 * write, no repaint, no "Downloaded." — so a reconcile at every boot rewrites
 * only what moved. The bridge hears no app lifecycle, so the reconcile runs
 * at subscription only, not on resume: the container moves only across a
 * relaunch, and an event that lands while the page is alive reaches it live.
 *
 * THE FOURTH EVENT IS FOR THE RECORD, NOT THE PAGE (#29, 29-part). The iOS
 * plugin also emits `downloadAttempt { reqHost, finalHost, status, expected,
 * received, outcome, at }`, once per download attempt: the HOST asked for
 * (the episode's original `audio_url`), the host the last response came from
 * after redirects, its HTTP status, the bytes announced and received, and how
 * it ended. It is not a record status, so it never reaches `onEvent`. It goes
 * to the diagnostics record instead, as a `foray:session` event on `window`
 * (`ATTEMPT_DOM_EVENT`) — the channel `player/client.js` already feeds into
 * `diag.sessionEvent` for the audio plugin's M-03 rows — with kind
 * `downloadAttempt` and producer `downloads`. `player/diagnostic-log.js`
 * admits each field by its closed set or shape (hosts by
 * `audioHostTokenOf`: never a path or a query) and drops the rest. The
 * device check (docs/downloads-device-check.md step 6) reads that row.
 *
 * THE USER AGENT. Downloads leave the WebView, so the request would otherwise
 * carry whatever `URLSession`/`DownloadManager` sends by default. The plugin
 * is told to send `4a/<build> (+https://jw-incorporated.github.io/foray/)`: a
 * podcast host reading its logs sees the app's name and a URL that explains
 * it, which is the courtesy every well-behaved podcast client extends.
 *
 * WHERE THE BUILD COMES FROM (integration review, 2026-10-04). The plan named
 * a `window.__forayBuild` global; nothing in this repo sets one, so reading it
 * was a path that could only ever answer "dev". The app's real build arrives
 * ASYNCHRONOUSLY, from `@capacitor/app`'s `getInfo` (`player/build-stamp.js`),
 * after this module has evaluated — so a constant cannot carry it. Hence
 * `userAgentFor(build)`: the caller that enqueues (PQ-18) passes the build
 * build-stamp read, and `USER_AGENT` is only the default, `4a/dev`. */

import { listenTo } from "./native-engine.js";
import { withinMs } from "./deadline.js";

/** The plugin's registered name on both platforms (PQ-20 iOS, PQ-22 Android). */
export const DOWNLOADS_PLUGIN = "ForayDownloads";

/** The one deadline every native call races (ms). */
export const CALL_TIMEOUT_MS = 10_000;

/** The three events the plugin emits, forwarded by name to `onEvent`. */
export const DOWNLOAD_EVENTS = Object.freeze(["downloadProgress", "downloadDone", "downloadFailed"]);

const isStr = (v) => typeof v === "string" && v.length > 0;

/** One `list()` answer (`{ items: [row] }`, each row `{ id, status, bytes,
    total, reason, path }` — DownloadStore.swift/.java `answer`) as the events
    the page already handles, in the plugin's order: `[name, payload]` pairs
    for `onEvent` (CH3-05).

      done (with a path)        -> downloadDone {id, path, bytes}, TODAY's path
      failed / unplayable-here  -> downloadFailed {id, reason, status: null}
                                   (`unplayable-here` keeps its own name as the
                                   reason, which is how reportFromEvent knows it)
      downloading               -> downloadProgress {id, bytes, total}

    Nothing else is replayed: a `queued` row has nothing to say that the
    page's own `queued` row does not, and a native `missing` row (the file is
    gone) has no event — the play that finds it gone marks it (onMissing).
    A row with no id, a done row with no path, and an answer that is not a
    row list are skipped. Pure.
    MUTATION TO BREAK THIS: replay a `queued` row as downloadProgress ->
    `listReplay maps each native row` is red. */
export function listReplay(answer) {
  const rows = answer && Array.isArray(answer.items) ? answer.items : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || !isStr(row.id)) continue;
    const { id, status } = row;
    if (status === "done" && isStr(row.path)) out.push(["downloadDone", { id, path: row.path, bytes: row.bytes }]);
    else if (status === "failed" || status === "unplayable-here") {
      const reason = status === "unplayable-here" ? "unplayable-here" : (isStr(row.reason) ? row.reason : null);
      out.push(["downloadFailed", { id, reason, status: null }]);
    } else if (status === "downloading") out.push(["downloadProgress", { id, bytes: row.bytes, total: row.total ?? null }]);
  }
  return out;
}

/** The diagnostics event (#29, 29-part): one per download attempt, iOS only
    for now (Android's half waits for its native engine, D-A3). Kept OUT of
    `DOWNLOAD_EVENTS`, which are the record-status events `onEvent` gets. */
export const DOWNLOAD_ATTEMPT_EVENT = "downloadAttempt";

/** The window event the attempt is re-broadcast as: the `SESSION_DOM_EVENT`
    of `mobile/plugins/foray-audio/web/foray-media-session.js`, which
    `player/client.js` hands to `diag.sessionEvent`. */
export const ATTEMPT_DOM_EVENT = "foray:session";

/** The `foray:session` detail for one `downloadAttempt` payload. The six
    fields are TAKEN, never spread, and `kind` and `producer` are forced:
    `foray:session` also reaches client.js's `onNativeSession`, which pauses
    on a `routeChange`, so a payload that could name its own kind could pause
    playback. The outcome travels as `reason`, the field a session row's
    header counts. Values are passed as they came: judging them is
    diagnostic-log.js's, beside the record (`DOWNLOAD_OUTCOMES`,
    `audioHostTokenOf`), so there is one answer to "what may be stored".
    MUTATION TO BREAK THIS: return `{ ...p, kind: "downloadAttempt",
    producer: "downloads" }` and `the attempt detail TAKES its six fields`
    fails. */
export function attemptSessionDetail(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const v = (x) => (x === undefined ? null : x);
  return {
    kind: "downloadAttempt",
    producer: "downloads",
    reason: v(p.outcome),
    at: v(p.at),
    reqHost: v(p.reqHost),
    finalHost: v(p.finalHost),
    status: v(p.status),
    expected: v(p.expected),
    received: v(p.received),
  };
}

/** The page the UA points a curious host at. */
export const SITE_URL = "https://jw-incorporated.github.io/foray/";

/** `4a/<build> (+https://jw-incorporated.github.io/foray/)` for the build
    `player/build-stamp.js` read (a string or a number), else `4a/dev`. A UA
    product token is one word, so anything outside `[A-Za-z0-9._-]` (the
    space and parentheses of a "1.4 (37)" version string) becomes one `-`,
    and a token left empty is `dev`.
    MUTATION TO BREAK THIS: return `4a/${String(build)} (+${SITE_URL})`
    unsanitised and `userAgentFor composes the build into one product token`
    fails. */
export function userAgentFor(build) {
  const raw = typeof build === "string" ? build : typeof build === "number" && Number.isFinite(build) ? String(build) : "";
  const token = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `4a/${token || "dev"} (+${SITE_URL})`;
}

/** The default UA, before the caller knows the build: `4a/dev (+…)`. */
export const USER_AGENT = userAgentFor(null);

/**
 * The web half of ForayDownloads, or `null` when this page has no bridge that
 * can reach native (a web build, a test without a fake).
 *
 * @param {object} args
 * @param {object|null} args.bridge        `window.Capacitor`, or a fake
 * @param {(name: string, payload: object) => void} [args.onEvent]
 *        receives `downloadProgress` / `downloadDone` / `downloadFailed`
 * @param {Function} [args.setTimeoutFn]   injected so a test can fire the
 *        deadline without waiting ten seconds
 * @param {Function} [args.clearTimeoutFn] its pair: the deadline is cleared
 *        the moment the plugin answers, so a call that settled in 40 ms does
 *        not hold a ten-second timer (one per `list()` on every resume)
 * @param {object|null} [args.win]        where `downloadAttempt` is
 *        re-broadcast as `foray:session` (`globalThis`, the page's `window`);
 *        injected so a test can read what was dispatched
 * @returns {null | {
 *   enqueue(opts: {id: string, url: string, userAgent: string, allowCellular: boolean}): Promise<object>,
 *   cancel(opts: {id: string}): Promise<object>,
 *   remove(opts: {id: string}): Promise<object>,
 *   removeAll(): Promise<object>,
 *   list(): Promise<object>,
 *   usage(): Promise<object>,
 *   webSrc(path: string): string,
 *   fileSrc(opts: {path: string}): string,
 *   reconciled: Promise<number>,
 * }}
 */
export function createDownloadBridge({
  bridge, onEvent, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, win = globalThis,
} = {}) {
  if (typeof bridge?.nativePromise !== "function") return null;

  /* The injected timer pair as deadline.js's scheduler. A null handle is never
     handed to `clearTimeoutFn`; a pair that throws is deadline.js's to absorb
     (no timer: no deadline, never a lost answer). */
  const scheduler = {
    schedule(ms, fn) {
      const timer = setTimeoutFn(fn, ms);
      return () => { if (timer != null) clearTimeoutFn(timer); };
    },
  };

  /** One native call, raced against the deadline (deadline.js); resolves, never
      rejects: a rejection is mapped to `{ ok: false, reason }` before the race.
      MUTATION TO BREAK THE CLEAR: drop the `clearTimeoutFn(timer)` call in
      `scheduler` and `an answered call clears its deadline` fails. */
  function call(method, options) {
    return withinMs(
      Promise.resolve()
        .then(() => bridge.nativePromise(DOWNLOADS_PLUGIN, method, options))
        .then(
          /* A resolved nativePromise IS success (Capacitor rejects on error), so
             an answer with no `ok` of its own — a plugin that returns its rows or
             `{}` — reads as `ok: true`; one that says `ok: false` is believed. */
          (result) => (
            result && typeof result === "object"
              ? (result.ok === undefined ? { ok: true, ...result } : result)
              : { ok: true, result }
          ),
          (err) => ({ ok: false, reason: String(err?.message ?? err) }),
        ),
      CALL_TIMEOUT_MS,
      { fallback: { ok: false, reason: "timeout" }, scheduler },
    );
  }

  /** The URL the WebView may open for a stored file: Capacitor's
      `convertFileSrc` (`https://localhost/_capacitor_file_/…` on Android,
      `capacitor://localhost/_capacitor_file_/…` on iOS) when the bridge has
      it, else the path as given. Synchronous — it rewrites a string, it asks
      the phone nothing. Named for what it answers (a WebView URL, the
      record's `webSrc`), so it is not mistaken for the plugin's own
      `fileSrc` call (R4-10).
      MUTATION TO BREAK THIS: return `path` unconditionally -> `webSrc uses the
      bridge's convertFileSrc` is red. */
  function webSrc(path) {
    try {
      if (typeof bridge.convertFileSrc === "function") return bridge.convertFileSrc(path);
    } catch (_) { /* fall through to the raw path */ }
    return path;
  }

  const forward = typeof onEvent === "function" ? onEvent : () => {};
  const deliver = (name, payload) => {
    try { forward(name, payload ?? {}); } catch (_) { /* a listener's bug is not the wire's */ }
  };
  const handles = DOWNLOAD_EVENTS.map((name) => listenTo(bridge, DOWNLOADS_PLUGIN, name, (payload) => deliver(name, payload)));
  /* CH3-05: the boot reconcile (header). Only for a listener — with none there
     is nobody to tell — and after the subscriptions, so an event the plugin
     sends while `list()` is in flight is heard live as well. A failed or
     timed-out `list()` replays nothing: the record keeps what it had.
     Resolves with the number of events replayed; never rejects.
     MUTATION TO BREAK THIS: drop the `deliver` loop -> the CH3-05 path test
     in this suite and test/downloads.test.js are red. */
  const reconciled = typeof onEvent !== "function"
    ? Promise.resolve(0)
    : call("list", {}).then((answer) => {
      if (!answer || answer.ok === false) return 0;
      const events = listReplay(answer);
      for (const [name, payload] of events) deliver(name, payload);
      return events.length;
    });
  /* #29: the attempt row goes to the record, never to `onEvent`. No window,
     or one that throws, is a missing row: diagnostics never break a download. */
  const attemptHandle = listenTo(bridge, DOWNLOADS_PLUGIN, DOWNLOAD_ATTEMPT_EVENT, (payload) => {
    try {
      const Ctor = win?.CustomEvent;
      if (typeof Ctor !== "function" || typeof win.dispatchEvent !== "function") return;
      win.dispatchEvent(new Ctor(ATTEMPT_DOM_EVENT, { detail: attemptSessionDetail(payload) }));
    } catch (_) { /* the record is best-effort */ }
  });

  return {
    enqueue: ({ id, url, userAgent, allowCellular } = {}) => call("enqueue", { id, url, userAgent, allowCellular }),
    cancel: ({ id } = {}) => call("cancel", { id }),
    remove: ({ id } = {}) => call("remove", { id }),
    removeAll: () => call("removeAll", {}),
    list: () => call("list", {}),
    usage: () => call("usage", {}),
    webSrc,
    /** app.js's spelling of `webSrc` (`onDownloadEvent`, under the UI
        freeze). Not the plugin's `fileSrc` call, which the page never makes:
        the page takes today's paths from `list()` instead (CH3-05, R4-10).
        Goes when app.js calls `webSrc(path)`. */
    fileSrc: ({ path } = {}) => webSrc(path),
    /** The boot reconcile's outcome (CH3-05): the number of rows replayed. */
    reconciled,
    /** The `addListener` handles, for a page that tears the bridge down:
        one per `DOWNLOAD_EVENTS` entry, in order, and the attempt event's. */
    handles,
    attemptHandle,
  };
}
