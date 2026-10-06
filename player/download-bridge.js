/* The web half of ForayDownloads: how the page asks the phone to fetch an
 * episode's audio into the app's own files directory, and how the phone tells
 * the page what happened.
 *
 * Issue #29, Store/Policy; docs/roadmap/player-features.md PQ-17. The rules
 * about the RECORD — what a download is in, who is evicted, what the player
 * opens — are `download-store.js`'s (PQ-16) and are not restated here. This
 * file is the WIRE and nothing else: seven calls into the native plugin, three
 * events out of it, and the one promise it makes to its callers, which is that
 * nothing here ever rejects.
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
 * page with no event path still works — it can `list()` on resume). Every event reaches the caller as
 * `onEvent(name, payload)`, untouched; `download-store.js`'s
 * `reportFromEvent(name, payload)` turns it into the record status
 * `applyProgress` keys on (`downloadFailed`'s own `status` is the HTTP one).
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
 * @returns {null | {
 *   enqueue(opts: {id: string, url: string, userAgent: string, allowCellular: boolean}): Promise<object>,
 *   cancel(opts: {id: string}): Promise<object>,
 *   remove(opts: {id: string}): Promise<object>,
 *   removeAll(): Promise<object>,
 *   list(): Promise<object>,
 *   usage(): Promise<object>,
 *   fileSrc(opts: {path: string}): string,
 * }}
 */
export function createDownloadBridge({ bridge, onEvent, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
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

  const forward = typeof onEvent === "function" ? onEvent : () => {};
  const handles = DOWNLOAD_EVENTS.map((name) => listenTo(bridge, DOWNLOADS_PLUGIN, name, (payload) => {
    try { forward(name, payload ?? {}); } catch (_) { /* a listener's bug is not the wire's */ }
  }));

  return {
    enqueue: ({ id, url, userAgent, allowCellular } = {}) => call("enqueue", { id, url, userAgent, allowCellular }),
    cancel: ({ id } = {}) => call("cancel", { id }),
    remove: ({ id } = {}) => call("remove", { id }),
    removeAll: () => call("removeAll", {}),
    list: () => call("list", {}),
    usage: () => call("usage", {}),
    /** The URL the WebView may open for a stored file: Capacitor's
        `convertFileSrc` (`https://localhost/_capacitor_file_/…` on Android,
        `capacitor://localhost/_capacitor_file_/…` on iOS) when the bridge has
        it, else the path as given. Synchronous — it rewrites a string, it
        asks the phone nothing. */
    fileSrc: ({ path } = {}) => {
      try {
        if (typeof bridge.convertFileSrc === "function") return bridge.convertFileSrc(path);
      } catch (_) { /* fall through to the raw path */ }
      return path;
    },
    /** The `addListener` handles, for a page that tears the bridge down. */
    handles,
  };
}
