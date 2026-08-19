/* The Android half of #27: implement `navigator.mediaSession` — the API Android
 * WebView switches OFF — and let the native side be the browser.
 *
 * ── WHY THIS SHAPE, AND NOT ANY OTHER ────────────────────────────────────────
 *
 * `player/media-session.js` (600 lines) already decides everything #27 asks: what
 * the three metadata fields say and why, that previous/next are SEGMENTS, that the
 * position is the FORAY's clock rather than the episode's, that the 2.0 s seam beat
 * reports "playing", and how artwork degrades. Every one of those decisions is
 * argued in that file's header and pinned by `player/media-session.test.js`.
 *
 * On Android none of it runs. `aw_main_delegate.cc` appends
 * `switches::kDisableMediaSessionAPI` — *"WebView does not support MediaSession API
 * since there's no UI for media metadata and controls"* — so
 * `navigator.mediaSession` is absent, `createMediaSession()` returns its inert
 * bridge, and the lock screen is blank
 * (`docs/research/mp1-background-audio.md` §5.4; still source-derived, not measured).
 *
 * The two obvious answers are both wrong:
 *
 *   - **Re-decide the mapping natively.** Then the lock screen says one thing in
 *     the Android app and another in mobile Chrome, and the argument in
 *     `media-session.js`'s header governs one of them. Two opinions about what a
 *     Foray is, diverging at the first edit.
 *   - **Change `player/` to call native.** Not ours (this change touches nothing
 *     under `player/`), and it would put a platform branch inside the module whose
 *     whole design is that it is pure and platform-free.
 *
 * So: **this file supplies the missing `navigator.mediaSession`**, and native plays
 * the part of the browser behind it. `player/client.js` finds an object where the
 * spec says one should be, writes metadata, position and playback state to it
 * exactly as it does in mobile Chrome, and registers the same action handlers. We
 * forward those writes to a Media3 `MediaSession`, and route the OS's transport
 * presses back into the handlers the player registered. **The player is the source
 * of truth and does not know this file exists.**
 *
 * That is also why the payload below is not a redesign: it is the spec's own
 * `MediaMetadata` + `MediaPositionState` + `playbackState`, flattened, plus which
 * actions the player installed. Everything interesting was decided upstream.
 *
 * ── WHAT IS OURS TO DECIDE, AND IT IS THREE THINGS ───────────────────────────
 *
 * 1. **The write rate.** `client.js` calls `syncMediaSession()` from `render()`,
 *    which runs on `timeupdate` — 4 Hz. `media-session.js` already dedupes to
 *    0.1 s granularity, so ~4 position writes a second arrive here. Four bridge
 *    round-trips a second for an hour is not a thing to do to a phone, and it is
 *    not needed: Media3 extrapolates the playhead from the last report and the
 *    rate (`SimpleBasePlayer.PositionSupplier.getExtrapolating`), which is the
 *    same extrapolation `media-session.js` §4 already accounts for. So writes are
 *    coalesced per microtask turn (one `update()` is three property writes and
 *    becomes ONE call) and a position-only change is rate-limited to
 *    `POSITION_MIN_INTERVAL_MS`. Anything that changes what the display SAYS —
 *    title, artist, album, artwork, transport state, duration, rate, which actions
 *    exist — is sent immediately, because those are the writes a listener can see.
 *
 * 2. **Where artwork lives.** The player hands us a URL that is correct INSIDE the
 *    WebView, and for the app's own icon that is `icon-512.png` relative to
 *    `https://localhost` — an origin served by Capacitor's `WebViewLocalServer`
 *    inside the WebView and by nothing else in the process. A native bitmap loader
 *    asked for that URL gets a connection refused. `assetUri()` rewrites a
 *    same-origin URL to `file:///android_asset/public/…`, which is where
 *    `cap copy` puts the same bytes. An `https:` URL is passed through untouched
 *    and a `data:` URI likewise. Nothing else is passed at all —
 *    `media-session.js`'s `artworkUrl()` has already refused everything else, and
 *    this is the second gate rather than the first.
 *
 * 3. **When the native session may go away**, which is the one place this file
 *    reaches into `foray-audio-shell.js`. See `onLoadedChange` below.
 *
 * ── THE SESSION MUST OUTLIVE THE AUDIO, AND THAT CHANGES THE FGS's LIFETIME ──
 *
 * #244 stops the foreground service 25 s after the last element goes silent, and
 * the Media3 `MediaSession` lives in that service. Left alone, that produces a
 * defect on the exact surface this file exists to build: pause from the lock
 * screen, wait 25 seconds, and the controls you paused with disappear — leaving no
 * way to resume without unlocking the phone and finding the app.
 *
 * So the service's lifetime becomes **"the transport can act on something"** rather
 * than **"audio is sounding"** — `isTransportable`, which is playing or paused and
 * nothing else. This file owns that signal because it is the only thing that can see
 * it: `media.release()` (which `client.js` calls from `stopAndClose` and nowhere
 * else) sets `metadata = null`, and that is unambiguous — the player has been closed,
 * not paused. `onLoadedChange(false)` then lets the shell stop the service AT ONCE
 * rather than 25 s later.
 *
 * **A FINISHED FORAY IS NOT LOADED, and getting that wrong was a blocking review
 * finding.** An earlier version said "anything but idle", which made a finished Foray
 * keep the service alive — with `acceptsTransport()` false on the native side, that
 * is an indefinite foreground service behind a notification with NO BUTTONS ON IT,
 * including no stop. Every session ends in that state. `isTransportable` is the same
 * rule on both sides of the bridge, so the surface with no controls is also the
 * surface that does not hold a service open.
 *
 * Two things that follow, both worth stating:
 *
 *   - **It is also fewer stop/start cycles, not more.** Under #244 every seam and
 *     every pause armed a stop; a Foray that stayed loaded now arms none. Every
 *     stop avoided is a `startForegroundService` avoided, and a background one of
 *     those is what Android 12+ refuses.
 *   - **The cost is a notification that can outlive interest.** A listener who
 *     pauses mid-Foray and walks away keeps an ongoing notification until they
 *     stop the player. That is why `stop` is exposed as a transport control and
 *     given a visible button: it is the one-press exit, and it routes to
 *     `stopAndClose`, which clears the metadata, which stops the service. Without
 *     a stop control this trade would not be available.
 *
 * If this file never installs — because `navigator.mediaSession` turned out to
 * exist, or because `client.js` failed — `loaded` is never reported and the shell
 * behaves exactly as #244 built it. The fallback is the old behaviour, not a hang.
 *
 * ── WHAT HAS BEEN OBSERVED: NOTHING ──────────────────────────────────────────
 *
 * No WebView has run this file and no lock screen has rendered anything from it.
 * `tools/mobile/foray-media-session.test.mjs` drives every path in Node against a
 * fake bridge, which proves the state machine and proves nothing about Android.
 * See `docs/android-native-code.md` § what is measured.
 */

/** The `@CapacitorPlugin(name = …)` on `ForayAudioPlugin.java`, and the same
 *  constant `foray-audio-shell.js` exports. `shell-invariants.test.mjs` asserts all
 *  three agree by reading the Java: if they disagree the bridge answers "plugin not
 *  implemented", the lock screen stays blank, and every test stays green. */
export const PLUGIN_NAME = "ForayAudio";

/** The one method this file calls. Native's whole contract is "here is everything
 *  the now-playing surface should say"; it holds no opinion of its own. */
export const SET_METHOD = "setNowPlaying";

/** The event native raises when the OS, a Bluetooth button or a car head unit asks
 *  for something. Its payload is `{ action, positionMs?, offsetMs? }`. */
export const TRANSPORT_EVENT = "transport";

/** Every action we can route, which is exactly `MEDIA_ACTIONS` in
 *  `player/media-session.js`. An action outside this set THROWS from
 *  `setActionHandler`, which is what Chromium does and therefore what
 *  `media-session.js`'s per-action `attempt()` guards are written against — see its
 *  §6. Answering "fine" to an action we cannot deliver would put a button on a car
 *  display that does nothing. */
export const ROUTABLE_ACTIONS = Object.freeze([
  "play", "pause", "stop", "previoustrack", "nexttrack",
  "seekbackward", "seekforward", "seekto",
]);

/** `04_VOICE_AUDIO_SPEC.md`'s ±30/15 s, and the numbers `player/media-session.js`
 *  exports as `SEEK_BACKWARD_SEC`/`SEEK_FORWARD_SEC` and puts on the in-page
 *  buttons. Duplicated here rather than imported: this file is copied into the
 *  bundle's root by `prepare-webdir.mjs` and must not depend on `player/`'s module
 *  graph resolving from there, and the Node suite imports it with no `player/`
 *  alongside. `foray-media-session.test.mjs` READS `player/media-session.js` and
 *  asserts both numbers match, which is the same trick `shell-invariants.test.mjs`
 *  uses to keep `PLUGIN_NAME` honest against the Java. */
export const SEEK_BACKWARD_SEC = 15;
export const SEEK_FORWARD_SEC = 30;

/** Position-only writes are rate-limited to this. See decision 1 in the header.
 *  1 s is chosen against the thing that consumes it: Media3 extrapolates between
 *  reports, and `media-session.js` §4 already documents a bounded drift of
 *  `SEAM_GAP_SEC x rate` (up to 4.0 s) from the seam beat — so a report interval an
 *  order of magnitude under that adds nothing measurable to the error and takes
 *  three quarters of the bridge traffic away. */
export const POSITION_MIN_INTERVAL_MS = 1000;

/** Where `cap copy` puts `mobile/www/` inside the APK. `AssetDataSource` resolves
 *  `file:///android_asset/<path>` and Media3's default `DataSourceBitmapLoader`
 *  goes through `DefaultDataSource`, which routes that prefix to it. */
export const ASSET_BASE = "file:///android_asset/public/";

/* ------------------------------------------------------------------ helpers */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const str = (s) => (typeof s === "string" ? s : s == null ? "" : String(s));

/**
 * A WebView-correct artwork URL -> a URL the NATIVE process can load, or `""`.
 *
 * Pure, and the second gate rather than the first: `media-session.js`'s
 * `artworkUrl()` has already refused `http:`, protocol-relative, control
 * characters and every non-image `data:` URI, so what arrives here is https, a
 * `data:image/` URI, or a relative path. This function's whole job is the change of
 * ADDRESS SPACE — the WebView's origin is served by Capacitor's local server and
 * exists nowhere else in the process.
 *
 * @param {string} url
 * @param {object} [env]
 * @param {string} [env.baseUrl]   `document.baseURI` — what a relative path is
 *   relative to.
 * @param {string} [env.origin]    `location.origin`; a URL on it is a bundled asset.
 * @param {string} [env.assetBase]
 * @returns {string} a loadable URI, or `""` meaning "no artwork" (never a guess)
 */
export function assetUri(url, { baseUrl = "", origin = "", assetBase = ASSET_BASE } = {}) {
  /* A STRING OR NOTHING, and the suite found this hole: `String(7)` resolves against
     the base to a same-origin URL and came back as
     `file:///android_asset/public/7` — a confident asset path for an asset that
     cannot exist. Coercing a non-string here would be inventing a URL, which is the
     one thing this function must not do. */
  if (typeof url !== "string") return "";
  const raw = url.trim();
  if (!raw) return "";
  /* A `data:` URI carries its own bytes and has no address space to translate.
     Checked BEFORE `new URL`, because a long base64 image is pointless to parse and
     `URL.origin` for `data:` is the string "null", which would fall through to the
     refusal below and silently drop artwork the player had approved. */
  if (/^data:image\//i.test(raw)) return raw;
  let u;
  try {
    u = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch (e) {
    /* Not resolvable — which for a relative path means we were given no base. No
       artwork is the right answer; a made-up one is not. */
    return "";
  }
  if (origin && u.origin === origin) {
    /* `pathname` and nothing else: a query or a fragment on a bundled asset path
       would become part of the FILENAME an asset loader looks for. */
    return assetBase + u.pathname.replace(/^\/+/, "");
  }
  if (u.protocol === "https:") return u.href;
  return "";
}

/**
 * The transport state native should report, from the spec's `playbackState` plus
 * whether anything is loaded at all.
 *
 * `media-session.js` §4 deliberately reports `"none"` for a FINISHED Foray — *"a
 * car display offering a play button that does nothing is worse than no display at
 * all"* — and `clear()` reports `"none"` for a CLOSED player. Those are different
 * things and Media3 has different states for them, so the discriminator is the one
 * the spec gives us: `metadata` survives the first and is nulled by the second.
 *
 * @returns {"playing"|"paused"|"ended"|"idle"}
 */
export function transportState({ metadata = null, playbackState = "none" } = {}) {
  if (!metadata) return "idle";
  if (playbackState === "playing") return "playing";
  if (playbackState === "none") return "ended";
  /* Anything else, `"paused"` included, is paused. An engine that invents a fifth
     value should not be able to make this throw. */
  return "paused";
}

/**
 * Everything native needs, in one flat object. Pure.
 *
 * The three strings are `media-session.js`'s, unexamined and unimproved — §1 of
 * that file is the argument and this function must not hold a second opinion. What
 * is added is only what a native session needs and a browser session did not: an
 * address-space-corrected artwork URI, milliseconds instead of seconds (Android's
 * unit everywhere), and which actions the player installed, so the native side can
 * declare exactly the matching `Player` commands and let the OS grey out the rest.
 *
 * @param {object} view
 * @param {object|null} view.metadata      the object `client.js` assigned, or null
 * @param {object|null} view.positionState the last `setPositionState` argument
 * @param {string} view.playbackState
 * @param {Iterable<string>} view.actions  installed action names
 * @param {object} [view.uri]              `assetUri` env
 */
export function nowPlayingPayload({
  metadata = null, positionState = null, playbackState = "none", actions = [], uri = {},
} = {}) {
  const installed = new Set(actions);
  const state = transportState({ metadata, playbackState });
  const artwork = Array.isArray(metadata?.artwork) ? metadata.artwork : [];
  /* The FIRST entry, not the largest. `mediaArtworkList` returns exactly one image
     — the publisher's square when we have it, ours when we do not — and its comment
     says offering both is "a coin flip over whose mark shows". Picking by size here
     would reintroduce the coin flip. */
  const artSrc = artwork.length ? str(artwork[0]?.src) : "";

  const durationMs = isNum(positionState?.duration) && positionState.duration > 0
    ? Math.round(positionState.duration * 1000)
    : 0;
  const positionMs = isNum(positionState?.position) && positionState.position >= 0
    ? Math.round(positionState.position * 1000)
    : 0;
  const rate = isNum(positionState?.playbackRate) && positionState.playbackRate > 0
    ? positionState.playbackRate
    : 1;

  return {
    state,
    title: str(metadata?.title),
    artist: str(metadata?.artist),
    album: str(metadata?.album),
    artworkUri: assetUri(artSrc, uri),
    durationMs,
    positionMs,
    playbackRate: rate,
    canPlay: installed.has("play"),
    canPause: installed.has("pause"),
    canStop: installed.has("stop"),
    /* `hasNext`/`hasPrevious` rather than `canNext`: on the native side they decide
       how many windows the timeline has, because Media3 answers "is there a next
       item" from the timeline and not from a command flag. */
    hasNext: installed.has("nexttrack"),
    hasPrevious: installed.has("previoustrack"),
    canSeekBack: installed.has("seekbackward"),
    canSeekForward: installed.has("seekforward"),
    canSeekTo: installed.has("seekto"),
    seekBackMs: SEEK_BACKWARD_SEC * 1000,
    seekForwardMs: SEEK_FORWARD_SEC * 1000,
  };
}

/** Is this a state the transport can act on — and therefore one the native session
 *  and its foreground service should exist for?
 *
 *  PLAYING OR PAUSED, and deliberately NOT "anything but idle". A review pass found
 *  two ways `"ended"` arrives: a genuinely finished Foray, and `mediaPlaybackState`'s
 *  `!hasItem` branch (an out-of-range queue index), which reports the spec's `"none"`
 *  with the metadata object still in place. Treating either as "loaded" left the
 *  shell's settle window a permanent no-op — an ongoing notification with no buttons
 *  and a foreground service nothing in JS would stop. And an ended Foray has no
 *  transport to offer anyway (`NowPlaying.acceptsTransport` on the native side is the
 *  same rule), so "the service lives while the transport is usable" is both simpler
 *  and the thing actually wanted. */
export function isTransportable(payload) {
  return payload.state === "playing" || payload.state === "paused";
}

/** The part of a payload a listener can SEE. Everything except the playhead, which
 *  native extrapolates on its own — so a change here is sent at once and a change
 *  in `positionMs` alone waits for the rate limit.
 *
 *  JOINED WITH A NUL, not with nothing, and a review pass is why: `join("")` makes
 *  `{title:"ab", artist:"c"}` and `{title:"a", artist:"bc"}` the same key, so a real
 *  change would fall through to the position-only branch — delayed by up to a second,
 *  or never sent at all if the playhead happened to be still. A separator that cannot
 *  occur in any of these fields removes the class rather than making it unlikely.
 *  See `KEY_SEPARATOR` below for which character, and for the two ways writing it
 *  went wrong before it was written this way. */
/** The separator between `identityKey`'s fields.
 *
 *  ASCII 31, the unit separator, built with `fromCharCode` rather than written as a
 *  literal or as an escape. Both alternatives went wrong here in one sitting: an
 *  earlier draft carried the invisible byte in the source, which is a byte nobody can
 *  review, and the escape form was silently flattened to an EMPTY STRING by the tool
 *  that replaced it — which would have restored the exact collision this constant
 *  exists to remove, with every test still green. `player/media-session.js`'s
 *  `CONTROL` class keeps its own bytes as escapes for the first reason; this goes one
 *  step further because of the second.
 *
 *  It cannot occur in any field being joined: `artworkUrl()` upstream refuses any URL
 *  containing a control character, and the rest is podcast metadata. */
const KEY_SEPARATOR = String.fromCharCode(31);

export function identityKey(payload) {
  return [
    payload.state, payload.title, payload.artist, payload.album, payload.artworkUri,
    payload.durationMs, payload.playbackRate,
    payload.canPlay, payload.canPause, payload.canStop,
    payload.hasNext, payload.hasPrevious,
    payload.canSeekBack, payload.canSeekForward, payload.canSeekTo,
    payload.seekBackMs, payload.seekForwardMs,
  ].join(KEY_SEPARATOR);
}

/**
 * Is this the one platform this file is for? Same test, same reasoning and the same
 * deliberate omission of `isNativePlatform()` as `foray-audio-shell.js`'s
 * `shellApplies` — see the comment there.
 */
export function mediaSessionApplies(capacitor) {
  try {
    if (!capacitor) return false;
    if (typeof capacitor.getPlatform !== "function") return false;
    if (capacitor.getPlatform() !== "android") return false;
    return typeof capacitor.nativePromise === "function";
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------- factory */

/**
 * Build the polyfill. Nothing happens until `install()`.
 *
 * @param {object} env
 * @param {object} env.capacitor       `window.Capacitor`, or a fake
 * @param {object} env.nav             the object to hang `mediaSession` on
 * @param {Function} [env.schedule]    runs a coalescing callback; a microtask by
 *   default, injected so a test does not have to await one
 * @param {Function} [env.now]
 * @param {Function} [env.setTimeout]   for the trailing position write; see `flush`
 * @param {Function} [env.clearTimeout]
 * @param {Function} [env.onNativeAnswer] handed every `setNowPlaying` result, so the
 *   shell can notice a foreground service that went away underneath it
 * @param {Function} [env.onLoadedChange] told whether media is loaded — the seam
 *   with `foray-audio-shell.js`; see the header
 * @param {number} [env.positionMinIntervalMs]
 * @param {string} [env.baseUrl]
 * @param {string} [env.origin]
 * @param {Function} [env.log]
 */
export function createForayMediaSession(env) {
  const capacitor = env.capacitor;
  const nav = env.nav;
  const now = typeof env.now === "function" ? env.now : Date.now;
  const schedule = typeof env.schedule === "function"
    ? env.schedule
    : (fn) => Promise.resolve().then(fn);
  const onLoadedChange = typeof env.onLoadedChange === "function" ? env.onLoadedChange : null;
  const onNativeAnswer = typeof env.onNativeAnswer === "function" ? env.onNativeAnswer : null;
  const setTimer = typeof env.setTimeout === "function" ? env.setTimeout : null;
  const clearTimer = typeof env.clearTimeout === "function" ? env.clearTimeout : null;
  const minInterval = isNum(env.positionMinIntervalMs)
    ? env.positionMinIntervalMs
    : POSITION_MIN_INTERVAL_MS;
  const uriEnv = { baseUrl: env.baseUrl || "", origin: env.origin || "", assetBase: ASSET_BASE };
  const log = typeof env.log === "function" ? env.log : function () {};

  /** Action name -> the handler `client.js` installed. */
  const handlers = new Map();
  let metadata = null;
  let playbackState = "none";
  let positionState = null;

  let installed = false;
  /** The object we put on `navigator`, so `uninstall` can tell whether it is still
   *  the one there — the same care `foray-audio-shell.js`'s `uninstall` takes over
   *  the `play` prototype patch, for the same reason. */
  let session = null;
  /** What `navigator.mediaSession` was before we touched it. `undefined` is the
   *  expected value on Android and is restored as an absent property. */
  let hadOwn = false;
  let previous;
  let subscription = null;

  let flushQueued = false;
  let lastIdentity = null;
  let lastPositionMs = null;
  let lastSentAt = 0;
  let lastLoaded = null;
  /** A position write the rate limit refused, still waiting to be sent. See `flush`. */
  let deferredTimer = null;
  let sends = 0;
  let lastReason = "";
  /** Serialises bridge calls so two `setNowPlaying`s cannot land out of order and
   *  leave the lock screen showing the older one. The same chain, for the same
   *  reason, as `foray-audio-shell.js`'s — Capacitor dispatches plugin calls on a
   *  thread pool. */
  let queue = Promise.resolve();

  /* ---------------------------------------------------------------- sending */

  function send(payload) {
    sends += 1;
    queue = queue.then(function () {
      let p;
      try {
        p = capacitor.nativePromise(PLUGIN_NAME, SET_METHOD, payload);
      } catch (e) {
        lastReason = String((e && e.message) || e);
        log("foray-media-session: " + SET_METHOD + " threw", e);
        return undefined;
      }
      if (!p || typeof p.then !== "function") return undefined;
      /* BOTH handlers, always. A rejected `queue` is permanent — every later `.then`
         is skipped — and this surface would then silently stop updating for the rest
         of the session with the lock screen frozen on one segment's title. */
      return p.then(
        function (result) {
          if (!onNativeAnswer) return;
          try {
            /* `setNowPlaying` answers with the service's own `running` flag, and this is
               the only regular traffic to native while a Foray plays — so it is also the
               cheapest possible health check. The shell uses it to notice a foreground
               service that went away without being asked (Android killing it under
               memory pressure, a native stop) and to re-ask on the next play. Without
               it, its own `wanted && startAccepted` gate stays true and NOTHING ever
               re-starts the service for the rest of the session. */
            onNativeAnswer(result || {});
          } catch (e) {
            log("foray-media-session: handling the " + SET_METHOD + " answer failed", e);
          }
        },
        function (e) {
          lastReason = String((e && e.message) || e);
          /* THE RECORD OF WHAT WE SENT IS TORN UP, and a review pass is why. `flush`
             commits `lastIdentity` before the write is dispatched, so a rejected write
             leaves us believing native knows something it does not. A position write
             normally repairs that within a second because each carries the whole
             payload — but not while PAUSED, where the playhead never moves again: the
             lock screen would sit on "playing" with a pause button for the whole pause.
             Clearing the key makes the next write unconditional. */
          lastIdentity = null;
          log("foray-media-session: " + SET_METHOD + " failed", e);
        }
      );
    });
  }

  /**
   * Decide whether to write, and write. Runs once per coalescing turn.
   *
   * THE RATE LIMIT APPLIES TO THE PLAYHEAD AND NOTHING ELSE, and the ordering here
   * is the whole mechanism: `identityKey` is compared first and sends unconditionally,
   * so a title change at a seam is never delayed by a position write half a second
   * earlier. Only when the visible part is unchanged does the interval gate the
   * write.
   */
  function flush() {
    flushQueued = false;
    if (!installed) return;
    const payload = nowPlayingPayload({
      metadata, positionState, playbackState, actions: handlers.keys(), uri: uriEnv,
    });
    const loaded = isTransportable(payload);
    const identity = identityKey(payload);
    const identityChanged = identity !== lastIdentity;
    const t = now();
    if (!identityChanged) {
      if (payload.positionMs === lastPositionMs) return;
      if (t - lastSentAt < minInterval) {
        /* DEFERRED, NOT DROPPED, and a review pass found the difference on a real
           sequence: scrub from the lock screen WHILE PAUSED. The identity does not
           change, the write lands inside the interval, and with a bare `return` nothing
           ever re-arms — paused means no further `timeupdate`, and Media3 only
           extrapolates while playing, so the lock-screen playhead sticks at the
           pre-seek position until playback resumes. A trailing timer costs one timeout
           per dropped write and makes the last position always arrive. */
        deferPositionWrite(minInterval - (t - lastSentAt));
        return;
      }
    }
    cancelDeferred();
    lastIdentity = identity;
    lastPositionMs = payload.positionMs;
    lastSentAt = t;
    send(payload);
    /* AFTER the send is queued, and the order matters. Reporting "not loaded"
       lets the shell stop the foreground service, and the service owns the
       MediaSession — so telling it first would tear the session down before the
       payload that says "idle" had been queued behind it, and native would answer
       a `setNowPlaying` for a session that no longer exists. Harmless, but it would
       log an error for a sequence we control. */
    if (loaded !== lastLoaded) {
      lastLoaded = loaded;
      if (onLoadedChange) {
        try {
          onLoadedChange(loaded);
        } catch (e) {
          log("foray-media-session: onLoadedChange failed", e);
        }
      }
    }
  }

  /**
   * Arm a trailing flush for a position write the rate limit refused.
   *
   * ONE TIMER AT A TIME: a 4 Hz repaint would otherwise arm four a second. The pending
   * one is always for the earliest moment a write is allowed, so re-arming would only
   * ever push it later.
   *
   * If no timer was injected and the platform has none, the write is dropped as before
   * — degraded, not broken, and the reason this is not simply assumed to exist.
   */
  function deferPositionWrite(delay) {
    if (deferredTimer !== null) return;
    if (!setTimer) return;
    try {
      deferredTimer = setTimer(function () {
        deferredTimer = null;
        scheduleFlush();
      }, Math.max(0, delay));
    } catch (e) {
      deferredTimer = null;
      log("foray-media-session: could not defer a position write", e);
    }
  }

  function cancelDeferred() {
    if (deferredTimer === null) return;
    const timer = deferredTimer;
    deferredTimer = null;
    if (!clearTimer) return;
    try {
      clearTimer(timer);
    } catch (e) {
      log("foray-media-session: clearing the deferred write failed", e);
    }
  }

  function scheduleFlush() {
    if (!installed || flushQueued) return;
    flushQueued = true;
    try {
      schedule(function () {
        try {
          flush();
        } catch (e) {
          flushQueued = false;
          log("foray-media-session: flush failed", e);
        }
      });
    } catch (e) {
      flushQueued = false;
      log("foray-media-session: could not schedule a flush", e);
    }
  }

  /* -------------------------------------------------------------- receiving */

  /**
   * One transport press from the OS -> the handler the player installed.
   *
   * The details objects are the SPEC's, not ours: `seekOffset` in seconds for
   * `seekbackward`/`seekforward`, `seekTime` in seconds for `seekto`. That is what
   * makes `media-session.js`'s handlers — written for a browser — run unmodified,
   * and it is why `offsetOf(details, fallback)` in that file honours a head unit's
   * own number: on Android the number IS ours, sent back so the page applies the
   * same ±15/30 the in-page buttons use.
   *
   * `fastSeek` is deliberately never sent. Whether a seek may be approximate is
   * `player/seek-policy.js`'s decision (ADR-0007/0008) and `media-session.js` drops
   * the field on purpose; inventing it here would smuggle a head unit's opinion in.
   */
  function dispatch(event) {
    if (!installed) return false;
    const action = str(event?.action);
    const handler = handlers.get(action);
    if (!handler) {
      /* Not an error worth shouting about: native declares commands from the same
         action set, so this means a press raced a `setActions()` that removed one —
         switching from a Foray to a single episode removes `nexttrack`. */
      log("foray-media-session: no handler for " + (action || "(none)"));
      return false;
    }
    let details;
    if (action === "seekto") {
      const ms = event?.positionMs;
      /* A scrub with no time is not a seek to zero, which is the same refusal
         `media-session.js`'s `seekto` handler makes on `seekTime`. Refused HERE too,
         so a native bug cannot send the playhead to the start of the Foray. */
      if (!isNum(ms) || ms < 0) return false;
      details = { seekTime: ms / 1000 };
    } else if (action === "seekbackward" || action === "seekforward") {
      const ms = event?.offsetMs;
      details = isNum(ms) && ms > 0 ? { seekOffset: ms / 1000 } : {};
    }
    try {
      /* Never awaited, and a rejection is swallowed rather than left to become an
         unhandled rejection inside a bridge callback — `media-session.js` takes the
         identical posture where the browser calls it. */
      const returned = handler(details);
      if (returned && typeof returned.then === "function") returned.then(undefined, function () {});
    } catch (e) {
      log("foray-media-session: the " + action + " handler threw", e);
      return false;
    }
    return true;
  }

  function subscribe() {
    /* `addListener` is on the injected bridge itself (`native-bridge.js`'s
       `initEvents`), so this needs no `@capacitor/core` proxy — the same reason
       `foray-audio-shell.js` uses `nativePromise` directly. `nativeCallback` is the
       fallback because `addListener` is a thin wrapper over exactly that call, and
       one of the two is present in every bridge that has plugins at all. */
    try {
      if (typeof capacitor.addListener === "function") {
        return capacitor.addListener(PLUGIN_NAME, TRANSPORT_EVENT, dispatch);
      }
      if (typeof capacitor.nativeCallback === "function") {
        capacitor.nativeCallback(PLUGIN_NAME, "addListener", { eventName: TRANSPORT_EVENT }, dispatch);
        return { remove: function () {} };
      }
    } catch (e) {
      log("foray-media-session: could not subscribe to " + TRANSPORT_EVENT, e);
    }
    return null;
  }

  /* ------------------------------------------------------- the fake session */

  /**
   * The object `client.js` will find at `navigator.mediaSession`.
   *
   * Every member exists because `player/media-session.js` touches it: `metadata`
   * and `playbackState` as assignable properties, `setPositionState` with and
   * without an argument (the no-argument form is the spec's "clear"), and
   * `setActionHandler` with a null handler to remove one. Nothing else is
   * implemented, because nothing else is called — `createMediaSession`'s bridge is
   * the only writer.
   */
  function buildSession() {
    return {
      /** So a device pass at `chrome://inspect` can tell our object from a real one
       *  in a single expression: `navigator.mediaSession.forayPolyfill`. */
      forayPolyfill: true,

      get metadata() {
        return metadata;
      },
      set metadata(value) {
        /* Stored as a PLAIN SNAPSHOT rather than by reference. `client.js` passes
           `window.MediaMetadata` when it exists, and if a WebView ever exposes that
           constructor while keeping `mediaSession` switched off, the instance's
           `artwork` is a live platform list. Copying the four fields we read means
           this file behaves identically either way, which is the difference between
           one code path and two. */
        metadata = value == null ? null : {
          title: str(value.title),
          artist: str(value.artist),
          album: str(value.album),
          artwork: Array.isArray(value.artwork)
            ? Array.from(value.artwork, (a) => ({
              src: str(a?.src), sizes: str(a?.sizes), type: str(a?.type),
            }))
            : [],
        };
        scheduleFlush();
      },

      get playbackState() {
        return playbackState;
      },
      set playbackState(value) {
        playbackState = str(value) || "none";
        scheduleFlush();
      },

      setPositionState(state) {
        /* No argument clears it, per spec — which is what `clear()` calls. */
        positionState = state == null ? null : {
          duration: state.duration,
          position: state.position,
          playbackRate: state.playbackRate,
        };
        scheduleFlush();
      },

      setActionHandler(action, handler) {
        const name = str(action);
        /* THROWS on an action we cannot route, because that is what Chromium does
           and `media-session.js`'s §6 guards are written for it: it wraps every
           `setActionHandler` in its own `attempt()` and keeps an `installed` set from
           the ones that did not throw. Answering "fine" to an action we cannot
           deliver would put it in that set, and then on a car display there would be
           a button that does nothing. */
        if (!ROUTABLE_ACTIONS.includes(name)) {
          throw new TypeError("foray-media-session: unsupported action " + name);
        }
        if (typeof handler === "function") handlers.set(name, handler);
        else handlers.delete(name);
        scheduleFlush();
      },
    };
  }

  /* ------------------------------------------------------------- lifecycle */

  function install() {
    if (installed) return false;
    if (!mediaSessionApplies(capacitor)) return false;
    if (!nav || typeof nav !== "object") return false;
    /* IF THE ENGINE ALREADY HAS ONE, LEAVE IT ALONE. The whole premise is that
       Android WebView switches the API off (MP1 §5.4), and that premise is
       source-derived rather than measured — so if a WebView is ever shipped with it
       on, the real implementation must win. A polyfill that overwrites a working
       platform API is how a fix becomes a regression on the next OS release. */
    if (nav.mediaSession) return false;

    session = buildSession();
    hadOwn = Object.prototype.hasOwnProperty.call(nav, "mediaSession");
    previous = nav.mediaSession;
    try {
      /* `defineProperty` rather than assignment: `Navigator.prototype` may carry an
         accessor for this name even with the feature disabled, and a plain assignment
         to an inherited getter-only property fails silently in sloppy mode and
         throws in strict — and this module is strict, being a module. */
      Object.defineProperty(nav, "mediaSession", {
        value: session, writable: true, configurable: true, enumerable: true,
      });
    } catch (e) {
      log("foray-media-session: could not define navigator.mediaSession", e);
      session = null;
      return false;
    }

    installed = true;
    subscription = subscribe();
    return true;
  }

  function uninstall() {
    if (!installed) return false;
    installed = false;
    /* Tell the shell first: an uninstalled polyfill will never report `idle`, and
       leaving `mediaLoaded` true would leave the foreground service with no JS able
       to stop it — the same hole `foray-audio-shell.js`'s `uninstall` closes by
       stopping the service before restoring the prototype. */
    if (lastLoaded === true && onLoadedChange) {
      lastLoaded = false;
      try {
        onLoadedChange(false);
      } catch (e) {
        log("foray-media-session: onLoadedChange failed", e);
      }
    }
    try {
      if (subscription && typeof subscription.remove === "function") subscription.remove();
    } catch (e) {
      log("foray-media-session: could not remove the transport listener", e);
    }
    subscription = null;
    /* ONLY IF OURS IS STILL THE ONE THERE. If something replaced it after we
       installed, restoring blindly would delete that — the mirror of the care
       `foray-audio-shell.js` takes over the `play` patch. */
    try {
      if (nav.mediaSession === session) {
        if (hadOwn) {
          Object.defineProperty(nav, "mediaSession", {
            value: previous, writable: true, configurable: true, enumerable: true,
          });
        } else {
          delete nav.mediaSession;
        }
      } else {
        log("foray-media-session: navigator.mediaSession was replaced; leaving it alone");
      }
    } catch (e) {
      log("foray-media-session: could not restore navigator.mediaSession", e);
    }
    session = null;
    handlers.clear();
    metadata = null;
    positionState = null;
    playbackState = "none";
    cancelDeferred();
    /* THE DEDUPE STATE GOES TOO, and a review pass found what happens when it does not.
       After an uninstall/install cycle the same metadata at the same position hashes
       equal, so `flush` returns BEFORE reporting `loaded` — the shell's `mediaLoaded`
       stays false, and its next settle window tears down the session under a Foray that
       is loaded and playing. One line, and it is the same class as `active.clear()` in
       `foray-audio-shell.js`'s own uninstall. */
    lastIdentity = null;
    lastPositionMs = null;
    lastSentAt = 0;
    return true;
  }

  /** State, for the suite and for a device probe. `sends` is the one number a
   *  device pass should read twice a minute apart: four a second means the rate
   *  limit is not working, and zero while audio plays means this file is not
   *  reaching native at all. */
  function inspect() {
    return {
      installed,
      actions: [...handlers.keys()],
      state: transportState({ metadata, playbackState }),
      title: str(metadata?.title),
      loaded: lastLoaded,
      deferred: deferredTimer !== null,
      sends,
      lastReason,
      positionMs: lastPositionMs,
    };
  }

  /** The payload that WOULD be sent right now. No side effects, and the honest
   *  thing to read from `chrome://inspect` when the lock screen says something
   *  unexpected: it answers "what did we tell Android" without waiting for a write. */
  function peek() {
    return nowPlayingPayload({
      metadata, positionState, playbackState, actions: handlers.keys(), uri: uriEnv,
    });
  }

  return { install, uninstall, inspect, peek, dispatch, flush: scheduleFlush };
}

/* ------------------------------------------------------------- auto-install */

/* Guarded on `window` so importing this module in Node installs nothing, exactly as
 * `foray-audio-shell.js` is. In a browser that is not the Android shell,
 * `install()` returns false and `navigator` is never touched — which is what makes
 * shipping this file to iOS and to the web harmless, and it is also why it is
 * shipped to both rather than gated at copy time: one file, one behaviour, decided
 * at run time by the platform it is on. */
if (typeof window !== "undefined") {
  try {
    const session = createForayMediaSession({
      capacitor: window.Capacitor,
      nav: typeof navigator !== "undefined" ? navigator : null,
      baseUrl: typeof document !== "undefined" ? document.baseURI : "",
      origin: typeof location !== "undefined" ? location.origin : "",
      /* The seam with the foreground service, looked up LAZILY on every call rather
         than captured: the two scripts are independent module tags and neither may
         assume the other has run. If the shell is absent this is a no-op and the
         session simply lives as long as the service does. */
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      onLoadedChange: function (loaded) {
        const shell = window.ForayAudioShell;
        if (shell && typeof shell.setMediaLoaded === "function") shell.setMediaLoaded(loaded);
      },
      /* The same lazy lookup, for the same reason: neither script may assume the other
         has run. */
      onNativeAnswer: function (result) {
        const shell = window.ForayAudioShell;
        if (shell && typeof shell.noteServiceRunning === "function") {
          shell.noteServiceRunning(result.running === true);
        }
      },
      log: function (message, error) {
        if (window.console && window.console.warn) window.console.warn(message, error || "");
      },
    });
    /* Exposed for the same reason the shell is: `HUMAN-ACTIONS.md`'s Android device
       pass reads `window.ForayMediaSession.peek()` off `chrome://inspect` to see
       what the lock screen was told, without a build. */
    window.ForayMediaSession = session;
    session.install();
  } catch (e) {
    /* A polyfill that cannot install must not take the page down with it. Without
       this, a throw here would stop `player/client.js` from ever being reached and
       cost the whole player to gain a lock screen. */
    if (typeof console !== "undefined" && console.warn) console.warn("foray-media-session: install failed", e);
  }
}
