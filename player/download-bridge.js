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
 * no JS entry on purpose — THIS file is its web half. The iOS half (a
 * background `URLSession` store) is PQ-20; the Android half (the system
 * `DownloadManager`) is PQ-22; neither exists yet, so on a shell built before
 * them every call answers `{ ok: false }` through the same deadline that
 * guards a hung one, and the page shows "Download failed" rather than a
 * spinner that never ends.
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
 * each is subscribed with the `listen` shape from `native-engine.js` lines
 * 116–124, copied exactly, per event name: `Capacitor.addListener` when the
 * bridge has it, else its thinner primitive `nativeCallback(plugin,
 * "addListener", { eventName })`, else nothing (a page with no event path
 * still works — it can `list()` on resume). Every event reaches the caller as
 * `onEvent(name, payload)`, so `download-store.js`'s `applyProgress` sees the
 * event name it already keys on.
 *
 * THE USER AGENT. Downloads leave the WebView, so the request would otherwise
 * carry whatever `URLSession`/`DownloadManager` sends by default. The plugin
 * is told to send `4a/<build> (+https://jw-incorporated.github.io/foray/)`: a
 * podcast host reading its logs sees the app's name and a URL that explains
 * it, which is the courtesy every well-behaved podcast client extends. The
 * build is `window.__forayBuild` when a host sets it, else `"dev"`. */

/** The plugin's registered name on both platforms (PQ-20 iOS, PQ-22 Android). */
export const DOWNLOADS_PLUGIN = "ForayDownloads";

/** The one deadline every native call races (ms). */
export const CALL_TIMEOUT_MS = 10_000;

/** The three events the plugin emits, forwarded by name to `onEvent`. */
export const DOWNLOAD_EVENTS = Object.freeze(["downloadProgress", "downloadDone", "downloadFailed"]);

/** The page the UA points a curious host at. */
export const SITE_URL = "https://jw-incorporated.github.io/foray/";

function buildToken() {
  try {
    const b = typeof window !== "undefined" ? window.__forayBuild : undefined;
    const s = typeof b === "string" ? b.trim() : typeof b === "number" && Number.isFinite(b) ? String(b) : "";
    return s || "dev";
  } catch (_) {
    return "dev";
  }
}

/** `4a/<build> (+https://jw-incorporated.github.io/foray/)` — build from
    `window.__forayBuild`, else `"dev"`. */
export const USER_AGENT = `4a/${buildToken()} (+${SITE_URL})`;

/** Subscribe `fn` to one plugin event — the `listen(fn)` helper of
    `native-engine.js` (lines 116–124), copied exactly, parameterised by name.
    Returns whatever `addListener` returns (a handle with `remove()` on a real
    bridge), or `null` when the thinner primitive or no path was used. */
function listen(cap, eventName, fn) {
  try {
    if (typeof cap?.addListener === "function") return cap.addListener(DOWNLOADS_PLUGIN, eventName, fn);
    if (typeof cap?.nativeCallback === "function") {
      cap.nativeCallback(DOWNLOADS_PLUGIN, "addListener", { eventName }, fn);
      return null;
    }
  } catch (_) { /* a page with no event path still works: it can list() on resume */ }
  return null;
}

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
export function createDownloadBridge({ bridge, onEvent, setTimeoutFn = setTimeout } = {}) {
  if (typeof bridge?.nativePromise !== "function") return null;

  /** One native call, raced against the deadline; resolves, never rejects. */
  function call(method, options) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        setTimeoutFn(() => settle({ ok: false, reason: "timeout" }), CALL_TIMEOUT_MS);
      } catch (_) { /* a host with no timer still gets the plugin's answer */ }
      Promise.resolve()
        .then(() => bridge.nativePromise(DOWNLOADS_PLUGIN, method, options))
        .then(
          (result) => settle(result && typeof result === "object" ? result : { ok: true, result }),
          (err) => settle({ ok: false, reason: String(err?.message ?? err) }),
        );
    });
  }

  const forward = typeof onEvent === "function" ? onEvent : () => {};
  const handles = DOWNLOAD_EVENTS.map((name) => listen(bridge, name, (payload) => {
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
