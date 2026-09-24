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
 *     stop the player. That is why the notification carries a visible Stop
 *     button: it is the one-press exit. It sends `CLOSE_ACTION`, not `stop`, and
 *     that routes to `stopAndClose`, which clears the metadata, which stops the
 *     service. Without that button this trade would not be available. (A `stop`
 *     from a Media3 controller — a car, a Bluetooth stack — is a PAUSE since the
 *     2026-09-22 audit; only the notification's own button closes. See
 *     `CLOSE_ACTION`.)
 *
 * If this file never installs — because `navigator.mediaSession` turned out to
 * exist, or because `client.js` failed — `loaded` is never reported and the shell
 * behaves exactly as #244 built it. The fallback is the old behaviour, not a hang.
 *
 * ── iOS: THE SAME FILE, A DIFFERENT JOB (L-02, then the 2026-09-23 tee) ──────
 *
 * WKWebView HAS a live `navigator.mediaSession`, and WebKit publishes to the
 * lock screen from the `<audio>` element on its own, through a MediaRemote client
 * of its own that no public API silences. So on iOS there are two publishers for
 * a tape segment -- WebKit's entry and `ForayAudioPlugin`'s `MPNowPlayingInfoCenter`
 * -- and exactly one for a narration line, where no element exists. The model
 * this file ships (`docs/ios-lock-screen.md` §8):
 *
 *   - `install()` takes over `navigator.mediaSession` so the page's writes reach
 *     the plugin, AND tees every write onto WebKit's real object
 *     (`captureLiveSession`) so WebKit's own entry says the same three strings and
 *     routes its presses to the page. Whichever client iOS shows, the display is
 *     the page's and a press is the page's.
 *   - A press may therefore arrive through two doors; `deliver()` applies it once
 *     (`REMOTE_DUPLICATE_WINDOW_MS`) and the record says which door and whether
 *     a copy was dropped.
 *   - The seek pair is `player/media-session.js`'s alone: this file copies it
 *     into the payload (`seekBackMs`/`seekForwardMs`), the natives read it from
 *     there, and the page ignores whatever `seekOffset` a platform sends back.
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

/** M-03 (founder feedback F16 / #548). The event native raises when the SYSTEM
 *  changes something under the player rather than asking for something: an
 *  `AVAudioSession` interruption, a route change, a media-services reset, the
 *  app entering background or foreground. Payload
 *  `{ kind, reason, producer, at }`; `ForayAudioPlugin.swift`'s and
 *  `ForayTtsPlugin.swift`'s `SESSION_EVENT` are the writers, and
 *  `player/diagnostic-log.js`'s `sessionEvent()` is the reader. */
export const SESSION_EVENT = "session";

/** How a `SESSION_EVENT` reaches `player/client.js`.
 *
 *  A DOM EVENT AND NOT A DIRECT CALL, for the two reasons this file's own
 *  auto-install block already states for `onLoadedChange`: `player/` may not
 *  import a Capacitor plugin's web half (`player/tts-bridge.js`'s header is the
 *  long form of why — the module lives at a different URL per host), and the
 *  two scripts are independent module tags in which neither may assume the
 *  other has run. `window` is the one object both of them are guaranteed to
 *  find. Namespaced so nothing else on the page can collide with it. */
export const SESSION_DOM_EVENT = "foray:session";

/** How a native `TRANSPORT_EVENT` reaches the RECORD, as distinct from the page's
 *  handler (founder, 2026-09-23: "got in my car, then my car resumed Spotify").
 *
 *  `dispatch()` below hands the press to the handler `client.js` installed, and the
 *  handler writes its own `transport … from remote` row — so a press that reached the
 *  plugin and found NO handler, or one the page was too asleep to act on, left no
 *  row at all, and "the car's play did nothing" and "the car's play never came" read
 *  the same. Every native transport event is therefore re-broadcast here as well,
 *  with what the plugin saw (`command`, `origin`, `at`) and what this file did with
 *  it (`action`, `handled`), for `player/diagnostic-log.js`'s `remoteCommand()`. Same
 *  channel and same reasons as `SESSION_DOM_EVENT`. */
export const REMOTE_DOM_EVENT = "foray:remote";

/** The origin a press carries when it came through WEBKIT'S OWN `MediaSession`
 *  rather than through the plugin -- the tee's door (see `captureLiveSession`).
 *  One of `REMOTE_ORIGINS` in `player/diagnostic-log.js`; `shell-invariants`
 *  pins that, because a door the record does not admit is a door it drops. */
export const WEBKIT_ORIGIN = "webkit";

/** ONE PRESS, DELIVERED ONCE (founder, 2026-09-23: "Both should be 15/30", and
 *  a 15 delivered twice is 30).
 *
 *  On iOS a lock-screen or car press can reach the page through TWO doors at
 *  once: WebKit's own MediaRemote client, which calls the handler the tee put on
 *  WebKit's `MediaSession`, and `ForayAudioPlugin`'s `MPRemoteCommandCenter`
 *  target, which arrives as a `transport` event. Whether iOS delivers to one or
 *  both is not a thing a Simulator can show (`docs/ios-lock-screen.md` §8), so
 *  the page does not bet on it: `deliver()` applies one remote action of a kind
 *  per window ACROSS origins, and drops the second copy with a `remote` row
 *  saying so (`deduped`). Same-origin repeats are never dropped -- two presses
 *  of the same button on the same surface are two presses. The window is longer
 *  than any plausible double delivery (the second door is one bridge hop behind
 *  the first, tens of milliseconds) and shorter than any deliberate second
 *  press from a different surface. */
export const REMOTE_DUPLICATE_WINDOW_MS = 500;

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

/** The page's actions that are NOT mirrored onto WebKit's own session on the
 *  iOS takeover (see `captureLiveSession`). Only `seekto`, and for one reason:
 *  WebKit's `MediaElementSession::clientCharacteristicsChanged` rewrites the
 *  page's position state with `element->currentTime()` on every tick, so the
 *  timeline WebKit's client shows is the `<audio>` ELEMENT's — the segment's —
 *  while the page's `seekto` handler is on the Foray's clock
 *  (`player/media-session.js` §3). A scrub on WebKit's bar would land at
 *  "1:00 of the Foray" when the listener meant "1:00 of this clip". The
 *  mirrored set therefore drops `SeekToPlaybackPosition` from what WebKit's
 *  client advertises (its set becomes ours ∪ {play, pause}); the Foray-clock
 *  scrub lives on `ForayAudioPlugin`'s client, which is built for it. */
/** AND THE TRACK PAIR (audit round 2, p-impatient-3; founder question 1: the lock
 *  screen shows the SKIP pair, always). WebKit's remote-command listener enables
 *  `nextTrackCommand`/`previousTrackCommand` on the shared command centre for
 *  every handler the page installs on its session, and iOS draws ⏮/⏭ in place of
 *  ↺15/30↻ whenever those are enabled — so with anything in Up Next the founder's
 *  15/30 became ⏭, and flipped back mid-drive as Up Next drained. The track pair
 *  is the plugin's alone now: `ForayAudioPlugin.swift` enables it only while a
 *  headset, Bluetooth or car route is present (`trackCommandsAllowed`), which is
 *  where next/previous are pressed without looking. `docs/DECISIONS.md`
 *  2026-09-23 (the platform contract) records the ruling and the device check. */
export const UNMIRRORED_ACTIONS = Object.freeze(["seekto", "nexttrack", "previoustrack"]);

/** The notification's own Stop button (and its swipe, from Android 14), and
 *  nothing else. NOT a spec action and deliberately not in `ROUTABLE_ACTIONS`: no
 *  page registers a handler for it. `dispatch` delivers it to the page's `stop`
 *  handler with `{ close: true }` in the details.
 *
 *  WHY A SEPARATE NAME. A remote `stop` is a pause (audit 2026-09-22): a head unit's
 *  square or a Bluetooth hang-up gesture used to tear the whole player down
 *  mid-drive. But on Android 24-33 a foreground-service notification cannot be
 *  swiped away, so the notification's Stop button is the listener's ONE exit, and
 *  a pause there left a paused listener with a notification nothing could close.
 *  The two presses arrive through different doors — the button is a PendingIntent
 *  to our own service, a car's stop is a Media3 `handleStop` — so the Java names
 *  them differently and the page can tell them apart. */
export const CLOSE_ACTION = "close";

/** The page ACTION a press became -> the platform COMMAND the record's `remote`
 *  row admits (`REMOTE_COMMANDS` in `player/diagnostic-log.js`: dashed tokens,
 *  spelled the same by both natives).
 *
 *  WHY THIS TABLE EXISTS (review of the 2026-09-23 branch). The record admits a
 *  closed vocabulary and DROPS a row whose command is outside it, and two of the
 *  three doors named a press by its spec action instead: WebKit's tee'd handler
 *  (`mirrorHandler`) sent `command: name` -- `nexttrack`, `seekforward` -- and
 *  Android's `ForayAudioPlugin.java` puts the Media3 action in `command` because
 *  on that side the action IS the platform's name. Only play/pause/stop happen to
 *  be spelled the same in both vocabularies, so every lock-screen skip through
 *  WebKit's door and every next/previous/skip/scrub from Android left no `remote`
 *  row, the header's `remote commands N` undercounted, and the one reading the row
 *  was added for ("arrived and did nothing" vs "never arrived") could not be made.
 *  `remoteCommandFor` maps at the ONE seam every door passes through, so a native
 *  side may keep naming the action. `shell-invariants.test.mjs` pins every value
 *  here into `REMOTE_COMMANDS`, and every action the Java can send into the keys. */
export const REMOTE_COMMAND_FOR_ACTION = Object.freeze({
  play: "play",
  pause: "pause",
  stop: "stop",
  previoustrack: "previous-track",
  nexttrack: "next-track",
  seekbackward: "skip-backward",
  seekforward: "skip-forward",
  seekto: "change-position",
});

/** A command word as a native side or the tee spelled it -> the record's word.
 *  An action spelling is mapped; anything else (`toggle-play-pause`, `close`, a
 *  dashed token the Swift already chose) passes through unchanged. */
export function remoteCommandFor(word) {
  const w = str(word);
  return Object.prototype.hasOwnProperty.call(REMOTE_COMMAND_FOR_ACTION, w) ? REMOTE_COMMAND_FOR_ACTION[w] : w;
}

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

/** The iOS mirror of `ASSET_BASE` (L-02). There is no WebView-served origin to
 *  translate on iOS the way `assetUri` translates `https://localhost/…` on
 *  Android — the app's own icon is just a file inside `Bundle.main`. A bare
 *  scheme rather than a real one (`https:`, `data:`, `file:`) is deliberate:
 *  it must be visibly NOT a network or same-device-filesystem URL, so nothing
 *  downstream mistakes it for one and tries to fetch it, and it must survive
 *  `new URL()` parsing the same way `file:` does. The Swift side resolves the
 *  path against `Bundle.main` — this file's job is only the address-space
 *  MARKING, the same division of labour `ASSET_BASE` already has with
 *  `AssetDataSource` on Android: one place decides the scheme, the native side
 *  decides what it means. A `bundle:` URI the native side does not yet resolve
 *  degrades to no artwork (`artworkItem(for:)` already returns nil for any URL
 *  it cannot load) rather than a crash — the same silent degrade every failed
 *  artwork load on either platform already gets. */
export const IOS_ASSET_BASE = "bundle://public/";

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
  /* A STALL IS PLAYING WITH THE CLOCK STOPPED (audit round 2, p-car-8).
     `media-session.js` reports a network stall as `playbackRate: 0` with the state
     still playing — Apple's rule — and until now this clamp turned that 0 into 1, so
     the lock screen and the car counted on over silence and snapped back when the
     audio returned. Neither native side can take a zero SPEED (Media3's
     `PlaybackParameters` throws; iOS's default rate must be positive), so the speed
     keeps the clamp and the stall travels as its own flag: iOS writes rate 0,
     Android reports `STATE_BUFFERING`. Only an explicit 0 on a playing transport is
     a stall — a missing rate is not. */
  const stalled = state === "playing" && positionState?.playbackRate === 0;

  return {
    state,
    title: str(metadata?.title),
    artist: str(metadata?.artist),
    album: str(metadata?.album),
    artworkUri: assetUri(artSrc, uri),
    durationMs,
    positionMs,
    playbackRate: rate,
    stalled,
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
    payload.durationMs, payload.playbackRate, payload.stalled,
    payload.canPlay, payload.canPause, payload.canStop,
    payload.hasNext, payload.hasPrevious,
    payload.canSeekBack, payload.canSeekForward, payload.canSeekTo,
    payload.seekBackMs, payload.seekForwardMs,
  ].join(KEY_SEPARATOR);
}

/** Every platform this file may install on. Android: the API is absent
 *  (MP1 §5.4) and this file supplies it from nothing. iOS: measured, not
 *  inferred (`docs/ios-lock-screen.md` §0, run 34043193990) — the API IS
 *  present and WebKit is actively publishing to it from the `<audio>`
 *  element, so `install()` on iOS takes over rather than fills a gap. Both
 *  platforms are listed here, together, because this is the one place that
 *  decides which platforms the polyfill runs on at all; `install()` decides
 *  the DIFFERENT thing each of those two platforms then needs. */
const SUPPORTED_PLATFORMS = Object.freeze(["android", "ios"]);

/**
 * Is this a platform this file is for? Same test, same reasoning and the same
 * deliberate omission of `isNativePlatform()` as `foray-audio-shell.js`'s
 * `shellApplies` — see the comment there.
 */
export function mediaSessionApplies(capacitor) {
  try {
    if (!capacitor) return false;
    if (typeof capacitor.getPlatform !== "function") return false;
    if (!SUPPORTED_PLATFORMS.includes(capacitor.getPlatform())) return false;
    return typeof capacitor.nativePromise === "function";
  } catch (e) {
    return false;
  }
}

/** `capacitor.getPlatform()`, defensively — the same posture `mediaSessionApplies`
 *  takes, needed a second time because `install()` must know WHICH supported
 *  platform it is on, not just that it is on one. */
function currentPlatform(capacitor) {
  try {
    return capacitor && typeof capacitor.getPlatform === "function" ? capacitor.getPlatform() : "";
  } catch (e) {
    return "";
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
 * @param {Function} [env.onPlayingChange] told when the transport starts or stops
 *   SOUNDING (the payload's state crossing `"playing"`), on the transition only.
 *   The second seam with the shell (audit round 2, native-2): a narration-first
 *   Foray plays its opening minute through `ForayTtsPlugin` with no element, so
 *   this is the only signal that can start the foreground service for it
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
  const onPlayingChange = typeof env.onPlayingChange === "function" ? env.onPlayingChange : null;
  const onNativeAnswer = typeof env.onNativeAnswer === "function" ? env.onNativeAnswer : null;
  const setTimer = typeof env.setTimeout === "function" ? env.setTimeout : null;
  const clearTimer = typeof env.clearTimeout === "function" ? env.clearTimeout : null;
  const minInterval = isNum(env.positionMinIntervalMs)
    ? env.positionMinIntervalMs
    : POSITION_MIN_INTERVAL_MS;
  const uriEnv = {
    baseUrl: env.baseUrl || "",
    origin: env.origin || "",
    /* Android's `AssetDataSource` prefix, or iOS's `bundle:` marker — decided
     * ONCE, here, from the platform this session is actually running on,
     * exactly as the plan asks ("decide in one place and test it"). Every
     * other reader of `uriEnv` (`nowPlayingPayload` inside `flush`/`peek`)
     * stays platform-blind; this is the one place the branch exists. */
    assetBase: currentPlatform(capacitor) === "ios" ? IOS_ASSET_BASE : ASSET_BASE,
  };
  const log = typeof env.log === "function" ? env.log : function () {};

  /** Action name -> the handler `client.js` installed. */
  const handlers = new Map();
  let metadata = null;
  let playbackState = "none";
  let positionState = null;

  let installed = false;
  /** The object we put on `navigator`, so `uninstall` can tell whether it is still
   *  the one there — the same care `foray-audio-shell.js`'s `uninstall` takes over
   *  the `play` prototype patch, for the same reason. On a "wrap" takeover (see
   *  below) this is the SAME object as `previous`: there is nothing else to put
   *  there, only methods to intercept on the object already there. */
  let session = null;
  /** What `navigator.mediaSession` was before we touched it. `undefined` is the
   *  expected value on Android and is restored as an absent property. On iOS it
   *  is WebKit's own live object (measured, `docs/ios-lock-screen.md` §0) and is
   *  restored AS that object, not as absent. */
  let hadOwn = false;
  let previous;
  /** The members of the live session we took over on iOS, captured BEFORE any
   *  wrapping so they still reach WebKit — `null` when there was nothing to
   *  take over (Android, always). See `captureLiveSession`. */
  let mirror = null;
  /** The actions currently registered on WebKit's own session through `mirror`,
   *  so `uninstall` can take exactly those back and `inspect` can show them. */
  const mirrored = new Set();
  let subscription = null;
  /** M-03's own handle, kept separately from `subscription` above: `session`
   *  events are diagnostics and `transport` events are the lock screen's
   *  buttons, so a bridge that refuses one must not cost the other. */
  let sessionSubscription = null;
  /** How `install()` took the property, so `uninstall()` knows how to give it
   *  back: `"replace"` swapped the whole `navigator.mediaSession` property (the
   *  Android path, and the iOS path when the existing property is configurable);
   *  `"wrap"` left WebKit's object in place and intercepted its own methods
   *  instead, for the one case the plan calls out — a non-configurable existing
   *  property. `null` before `install()` has run. */
  let takeoverMode = null;
  /** Only set in `"wrap"` mode: each wrapped property's ORIGINAL own descriptor,
   *  or `null` for a property that had none (an inherited accessor, the normal
   *  shape for a real `MediaSession` IDL object) — the same "was it there at all"
   *  distinction `hadOwn` makes for the whole-property case, kept per-property
   *  because a wrap touches several. */
  let wrappedDescriptors = null;

  let flushQueued = false;
  let lastIdentity = null;
  let lastPositionMs = null;
  let lastSentAt = 0;
  let lastLoaded = null;
  /** Whether the last flushed payload said `"playing"`; see `onPlayingChange`. */
  let lastPlaying = false;
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
    /* AFTER the loaded report, for the same ordering reason: the shell's start
       for a narration-first Foray must follow the "loaded" it depends on. */
    const playing = payload.state === "playing";
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      if (onPlayingChange) {
        try {
          onPlayingChange(playing);
        } catch (e) {
          log("foray-media-session: onPlayingChange failed", e);
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

  /** The last remote action delivered per name -- `{ origin, at }` -- so
   *  `deliver` can tell one press arriving through two doors from two presses.
   *  See `REMOTE_DUPLICATE_WINDOW_MS`. */
  const lastDelivered = new Map();

  /**
   * ONE press -> the handler the player installed, whichever door it came in by.
   *
   * Both doors end here, and that is the point: `dispatch` (the plugin's
   * `transport` event -- Android's Media3 session and notification, iOS's
   * `MPRemoteCommandCenter`) and the tee's wrapper on WebKit's own `MediaSession`
   * (`mirrorHandler`, iOS only) both call this with the spec-shaped `details`, a
   * `command`/`origin`/`at` for the record, and nothing else. A duplicate -- the
   * same action from a DIFFERENT origin inside `REMOTE_DUPLICATE_WINDOW_MS` -- is
   * dropped here and recorded as `deduped`, so the page applies one remote
   * action of a kind per press however many clients iOS chose to deliver it to.
   *
   * The record row (`REMOTE_DOM_EVENT`) is written BEFORE the handler runs and
   * whether or not one exists -- see that constant. Returns whether the handler
   * ran, for `dispatch`'s callers and the suite.
   */
  function deliver({ action, details, command, origin, at }) {
    const handler = handlers.get(action);
    const t = now();
    const previous = lastDelivered.get(action);
    const duplicate = Boolean(
      previous && previous.origin !== origin && t - previous.at >= 0 && t - previous.at < REMOTE_DUPLICATE_WINDOW_MS
    );
    dispatchRemote({
      command: command,
      action: action,
      origin: origin,
      at: at,
      handled: Boolean(handler) && !duplicate,
      deduped: duplicate,
    });
    if (duplicate) {
      /* Not re-stamped: a third copy inside the same window is still the same
         press, and a genuine second press from the OTHER surface a moment later
         must be measured from the press that landed, not from the copy that did
         not. */
      return false;
    }
    if (!handler) {
      /* Not an error worth shouting about: native declares commands from the same
         action set, so this means a press raced a `setActions()` that removed one --
         switching from a Foray to a single episode removes `nexttrack`. */
      log("foray-media-session: no handler for " + (action || "(none)"));
      return false;
    }
    lastDelivered.set(action, { origin: origin, at: t });
    try {
      /* Never awaited, and a rejection is swallowed rather than left to become an
         unhandled rejection inside a bridge callback -- `media-session.js` takes the
         identical posture where the browser calls it. */
      const returned = handler(details);
      if (returned && typeof returned.then === "function") returned.then(undefined, function () {});
    } catch (e) {
      log("foray-media-session: the " + action + " handler threw", e);
      return false;
    }
    return true;
  }

  /**
   * One transport press from the PLUGIN -> `deliver`.
   *
   * The details objects are the SPEC's, not ours: `seekOffset` in seconds for
   * `seekbackward`/`seekforward`, `seekTime` in seconds for `seekto`. That is what
   * makes `media-session.js`'s handlers -- written for a browser -- run unmodified.
   * The offset is forwarded as DATA about the press: that file steps by its own
   * ±15/30 whatever number arrives (founder, 2026-09-23 -- the lock screen's 10 s
   * was WebKit's interval, honoured), and native's `offsetMs` is ours anyway.
   *
   * `fastSeek` is deliberately never sent. Whether a seek may be approximate is
   * `player/seek-policy.js`'s decision (ADR-0007/0008) and `media-session.js` drops
   * the field on purpose; inventing it here would smuggle a head unit's opinion in.
   */
  function dispatch(event) {
    if (!installed) return false;
    const sent = str(event?.action);
    /* The notification's Stop is the page's `stop` handler, told it may close. */
    const closing = sent === CLOSE_ACTION;
    const action = closing ? "stop" : sent;
    let details;
    if (closing) {
      details = { close: true };
    } else if (action === "seekto") {
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
    return deliver({
      action: action,
      details: details,
      /* `command` defaults to the action for a native side that sends none (an older
         plugin), and the notification's close is its own command. Either way it
         goes through `remoteCommandFor`: Android names the command by the Media3
         ACTION, and the record admits only the dashed platform tokens. */
      command: remoteCommandFor(str(event?.command) || (closing ? CLOSE_ACTION : action)),
      origin: str(event?.origin),
      at: event?.at,
    });
  }

  function subscribe() {
    return subscribeTo(TRANSPORT_EVENT, dispatch);
  }

  /** M-03. One native `session` event -> one `SESSION_DOM_EVENT` on `window`.
   *
   *  FORWARDED VERBATIM AND JUDGED NOWHERE HERE. The vocabulary belongs to
   *  `player/diagnostic-log.js`, which admits a fixed set of `kind`s and drops
   *  everything else; a second filter in this file would be two answers to one
   *  question, and the one that lives beside the record is the one that can
   *  keep the record's own no-prose rule. */
  function dispatchSession(event) {
    const detail = event && typeof event === "object" ? event : {};
    try {
      if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
      const Ctor = window.CustomEvent;
      if (typeof Ctor !== "function") return;
      window.dispatchEvent(new Ctor(SESSION_DOM_EVENT, { detail: detail }));
    } catch (e) {
      /* A native event that cannot be re-broadcast must not take the transport
         down with it: this whole channel is diagnostics, and the lock screen's
         buttons are not. */
      log("foray-media-session: could not re-broadcast " + SESSION_EVENT, e);
    }
  }

  function subscribeSession() {
    return subscribeTo(SESSION_EVENT, dispatchSession);
  }

  /** One native transport event -> one `REMOTE_DOM_EVENT` on `window`, for the
   *  record. Forwarded as data and judged nowhere here, exactly as `dispatchSession`
   *  is: `player/diagnostic-log.js` admits the command and origin vocabularies and
   *  drops the rest. Total, because it runs on the transport's own path and a
   *  diagnostic must never cost a press. */
  function dispatchRemote(detail) {
    try {
      if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
      const Ctor = window.CustomEvent;
      if (typeof Ctor !== "function") return;
      window.dispatchEvent(new Ctor(REMOTE_DOM_EVENT, { detail: detail }));
    } catch (e) {
      log("foray-media-session: could not re-broadcast a remote command", e);
    }
  }

  /* `addListener` is on the injected bridge itself (`native-bridge.js`'s
     `initEvents`), so this needs no `@capacitor/core` proxy — the same reason
     `foray-audio-shell.js` uses `nativePromise` directly. `nativeCallback` is the
     fallback because `addListener` is a thin wrapper over exactly that call, and
     one of the two is present in every bridge that has plugins at all. */
  function subscribeTo(eventName, handler) {
    try {
      if (typeof capacitor.addListener === "function") {
        return capacitor.addListener(PLUGIN_NAME, eventName, handler);
      }
      if (typeof capacitor.nativeCallback === "function") {
        capacitor.nativeCallback(PLUGIN_NAME, "addListener", { eventName: eventName }, handler);
        return { remove: function () {} };
      }
    } catch (e) {
      log("foray-media-session: could not subscribe to " + eventName, e);
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
        /* The ORIGINAL value, not the snapshot: in the shell it is a real
           `MediaMetadata` (client.js passes `window.MediaMetadata`), which is the
           only thing WebKit's setter accepts. */
        mirrorMetadata(value == null ? null : value);
        scheduleFlush();
      },

      get playbackState() {
        return playbackState;
      },
      set playbackState(value) {
        playbackState = str(value) || "none";
        mirrorPlaybackState(playbackState);
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
        const fn = typeof handler === "function" ? handler : null;
        if (fn) handlers.set(name, fn);
        else handlers.delete(name);
        mirrorHandler(name, fn);
        scheduleFlush();
      },
    };
  }

  /* ------------------------------------------- the mirror onto WebKit's own */

  /**
   * Capture the live session's own members BEFORE `install()` replaces or wraps
   * it, so the page's writes can be repeated onto WebKit's object as well as
   * ours. Returns `null` when the object has no `setActionHandler` — then it
   * is not a session at all and nothing is mirrored.
   *
   * WHY THIS IS A TEE AND NOT A TAKEOVER (founder, 2026-09-23, build 2026092326,
   * iPhone; `docs/ios-lock-screen.md` §8). Two reports from one drive, verbatim:
   * "My lock screen and car still displays the song/ artist/ album as 4a/
   * unknown/ unknown" and "In the app, I can jump back 15s and forward 30s. On
   * the lock screen, it's 10s in both directions." Neither string is ours:
   * `player/media-session.js` never emits "4a" as an artist and nothing in this
   * repo says 10. Both are WEBKIT'S. For every playing `<audio>` element WebKit
   * publishes a Now Playing entry of its own, through its own MediaRemote
   * client, titled from `document.title` -- which is "4a" -- with an empty
   * artist and album, and registers its own command set with a skip interval
   * of its choosing (`RemoteCommandListenerCocoa.mm`, `defaultCommands()`).
   * That entry, not the plugin's `MPNowPlayingInfoCenter` write, is what the
   * lock screen and the car were showing during tape. No public API silences
   * it. L-02's takeover made it worse than it had to be: replacing
   * `navigator.mediaSession` SEVERED WebKit's real object from the page, so
   * WebKit's entry was left with the document title, no artist, no album and
   * NO ACTION HANDLERS -- and a press on WebKit's client then fell to
   * `HTMLMediaElement`'s default (`MediaElementSession` ->
   * `MediaSession::callActionHandler` only when the page registered one on
   * WEBKIT'S object): a raw element seek by WebKit's interval, past the Foray
   * clock, the seek policy and the nudge.
   *
   * So the page's writes go to BOTH: ours (-> the plugin, which is the ONLY
   * writer during narration, when there is no element and WebKit clears its
   * entry) and WebKit's real object (-> WebKit's entry, which is what shows
   * during tape). `metadata` is forwarded as the ORIGINAL object -- the page's
   * artwork URLs (https, `data:`, or `icon-512.png` relative to the document),
   * which WebKit fetches inside the WebView; the `bundle://` rewrite in
   * `assetUri` is for the Swift side alone and never reaches WebKit.
   * `playbackState` rides along. Handlers are mirrored as `deliver` wrappers
   * (`mirrorHandler`), so whichever client the OS routes a press to, the page
   * runs the same handler ONCE. Position state is NOT forwarded and `seekto` is
   * not mirrored -- `UNMIRRORED_ACTIONS` says why.
   *
   * Every mirrored write is best-effort and never throws out of the page's
   * write: WebKit refusing a mirror must not cost the plugin its payload.
   */
  function captureLiveSession(target) {
    if (!target || typeof target !== "object") return null;
    const setActionHandler = typeof target.setActionHandler === "function"
      ? target.setActionHandler
      : null;
    if (!setActionHandler) return null;
    /* An accessor's SETTER, from wherever on the chain it lives — for a real
       `MediaSession` that is the IDL prototype — so the mirror still reaches
       WebKit after "wrap" mode shadows the property with our own accessor. A
       data property is never mirrored: in "wrap" mode our shadow sits on top
       of it, and an assignment would come straight back into our own setter —
       a loop, not a mirror. Only a test fake has one; WebKit's does not. */
    const setterOf = (prop) => {
      for (let o = target; o; o = Object.getPrototypeOf(o)) {
        const d = Object.getOwnPropertyDescriptor(o, prop);
        if (!d) continue;
        return typeof d.set === "function" ? (v) => d.set.call(target, v) : null;
      }
      return null;
    };
    return {
      setActionHandler: (name, fn) => setActionHandler.call(target, name, fn),
      metadata: setterOf("metadata"),
      playbackState: setterOf("playbackState"),
    };
  }

  /** Put the page's handler for `name` on WebKit's object too -- as a WRAPPER
   *  through `deliver`, not the page's function itself, so a press WebKit routes
   *  here is recorded (`REMOTE_DOM_EVENT`, origin `WEBKIT_ORIGIN`) and
   *  de-duplicated against the same press arriving from the plugin. The wrapper
   *  looks the handler up at call time, so `handlers` stays the one place a
   *  handler lives and a removal takes effect on both doors at once. WebKit's own
   *  details (`seekOffset`, `seekTime`) pass through untouched, exactly as
   *  `dispatch` passes the plugin's. The COMMAND is the record's word for the
   *  action (`REMOTE_COMMAND_FOR_ACTION`), never the spec name: WebKit has no
   *  platform command of its own to report, and `nexttrack` as a command was a row
   *  the record dropped. */
  function mirrorHandler(name, fn) {
    if (!mirror || UNMIRRORED_ACTIONS.includes(name)) return;
    const wrapper = fn
      ? function (details) {
        return deliver({
          action: name, details: details, command: remoteCommandFor(name), origin: WEBKIT_ORIGIN, at: now(),
        });
      }
      : null;
    try {
      mirror.setActionHandler(name, wrapper);
      if (wrapper) mirrored.add(name);
      else mirrored.delete(name);
    } catch (e) {
      log("foray-media-session: WebKit's session refused the mirrored " + name + " handler", e);
    }
  }

  function mirrorMetadata(value) {
    if (!mirror || !mirror.metadata) return;
    try {
      mirror.metadata(value);
    } catch (e) {
      log("foray-media-session: WebKit's session refused the mirrored metadata", e);
    }
  }

  function mirrorPlaybackState(value) {
    if (!mirror || !mirror.playbackState) return;
    try {
      mirror.playbackState(value);
    } catch (e) {
      log("foray-media-session: WebKit's session refused the mirrored playbackState", e);
    }
  }

  /** Take back everything the mirror put on WebKit's object. Each member is
   *  attempted even if one fails, as `uninstall` does for the wrapped ones. */
  function unmirror() {
    if (!mirror) return;
    for (const name of [...mirrored]) mirrorHandler(name, null);
    mirrorMetadata(null);
    mirrorPlaybackState("none");
    mirrored.clear();
    mirror = null;
    lastDelivered.clear();
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Intercept an EXISTING session object's methods in place, for the one case
   *  the plan names as conditional: the property is not configurable, so
   *  `Object.defineProperty(nav, "mediaSession", …)` cannot replace it — measured
   *  as a real possibility (`docs/ios-lock-screen.md` §0 leaves it open which of
   *  the two this run's WebKit is), not merely a defensive branch nobody expects
   *  to take.
   *
   *  Each intercepted member is redefined as an OWN property on the target,
   *  shadowing whatever accessor/method WebKit's `MediaSession` IDL binding put
   *  on its prototype — the same trick `client.js`'s one-time read at init relies
   *  on: whatever is found AT `navigator.mediaSession` when it is read wins,
   *  regardless of whether it lives on the instance or the prototype chain.
   *  `built` (a normal `buildSession()`) is the single source of truth for state;
   *  the wrapped members are thin forwarders so every other function in this file
   *  — `flush`, `peek`, `inspect` — keeps reading `built`'s closure state exactly
   *  as it does in "replace" mode, unaware which mode is active.
   *
   *  Returns `null` (never throws) if even ONE member cannot be redefined — a
   *  half-wrapped session is worse than none, because it would silently mix
   *  WebKit's stale reads with our fresh writes.
   */
  function wrapExistingSession(target) {
    const built = buildSession();
    const props = ["metadata", "playbackState", "setPositionState", "setActionHandler"];
    const originals = {};
    for (const prop of props) {
      originals[prop] = Object.prototype.hasOwnProperty.call(target, prop)
        ? Object.getOwnPropertyDescriptor(target, prop)
        : null;
    }
    try {
      Object.defineProperty(target, "metadata", {
        configurable: true,
        enumerable: true,
        get() { return built.metadata; },
        set(value) { built.metadata = value; },
      });
      Object.defineProperty(target, "playbackState", {
        configurable: true,
        enumerable: true,
        get() { return built.playbackState; },
        set(value) { built.playbackState = value; },
      });
      Object.defineProperty(target, "setPositionState", {
        configurable: true,
        enumerable: true,
        writable: true,
        value(state) { return built.setPositionState(state); },
      });
      Object.defineProperty(target, "setActionHandler", {
        configurable: true,
        enumerable: true,
        writable: true,
        value(action, handler) { return built.setActionHandler(action, handler); },
      });
      /* So a device pass can tell, exactly as in "replace" mode — see
         `buildSession`'s own comment. Also an own property here, for the same
         shadow-the-prototype reason as the four members above. */
      Object.defineProperty(target, "forayPolyfill", {
        configurable: true, enumerable: true, writable: true, value: true,
      });
    } catch (e) {
      log("foray-media-session: could not wrap the existing navigator.mediaSession", e);
      /* Best-effort unwind of whatever DID get redefined before the throw, so a
         failed wrap does not leave the real session half-shadowed. */
      for (const prop of props.concat(["forayPolyfill"])) {
        const original = originals[prop];
        try {
          if (original) Object.defineProperty(target, prop, original);
          else if (Object.prototype.hasOwnProperty.call(target, prop)) delete target[prop];
        } catch (undoError) {
          log("foray-media-session: could not undo a partial wrap of " + prop, undoError);
        }
      }
      return null;
    }
    wrappedDescriptors = originals;
    return target;
  }

  function install() {
    if (installed) return false;
    if (!mediaSessionApplies(capacitor)) return false;
    if (!nav || typeof nav !== "object") return false;

    const ios = currentPlatform(capacitor) === "ios";
    const existing = nav.mediaSession;

    /* ANDROID: IF THE ENGINE ALREADY HAS ONE, LEAVE IT ALONE. The whole premise
       is that Android WebView switches the API off (MP1 §5.4), and that premise
       is source-derived rather than measured — so if a WebView is ever shipped
       with it on, the real implementation must win. A polyfill that overwrites a
       working platform API is how a fix becomes a regression on the next OS
       release.

       iOS is the opposite, and MEASURED rather than assumed
       (`docs/ios-lock-screen.md` §0, run 34043193990): WKWebView exposes a live
       `navigator.mediaSession` and WebKit is actively publishing to it from the
       `<audio>` element. Leaving it alone on iOS would mean this file NEVER
       installs there, and the lock screen would stay on WebKit's version forever
       — populated once from the element and never refreshed (F7). So on iOS this
       function's job flips from "fill an absence" to "take over a live one". */
    if (existing && !ios) return false;

    hadOwn = Object.prototype.hasOwnProperty.call(nav, "mediaSession");
    previous = existing;
    /* BEFORE the takeover below touches it: "wrap" mode shadows the very
       members the mirror needs to keep. Only ever non-null on iOS — Android
       returned above when anything was there. */
    mirror = existing ? captureLiveSession(existing) : null;

    if (!existing) {
      /* The ordinary case on both platforms: nothing there yet (Android always;
         iOS only if a future WebKit ever ships the API off, or a non-WebKit iOS
         engine). Same "replace" path as before this card. */
      session = buildSession();
      try {
        /* `defineProperty` rather than assignment: `Navigator.prototype` may carry
           an accessor for this name even with the feature disabled, and a plain
           assignment to an inherited getter-only property fails silently in
           sloppy mode and throws in strict — and this module is strict, being a
           module. */
        Object.defineProperty(nav, "mediaSession", {
          value: session, writable: true, configurable: true, enumerable: true,
        });
      } catch (e) {
        log("foray-media-session: could not define navigator.mediaSession", e);
        session = null;
        return false;
      }
      takeoverMode = "replace";
    } else {
      /* The iOS takeover. Prefer replacing the whole property — simpler, and it
         means every member of `session` is genuinely ours rather than a
         forwarder — and fall back to wrapping the existing object's own methods
         only when the property itself refuses to be redefined. Which of the two
         a real WKWebView needs is exactly what M-01's run did not (and could not,
         short of trying it) settle; this is that trial, at install time, on
         whichever shell actually runs it. */
      const descriptor = Object.getOwnPropertyDescriptor(nav, "mediaSession");
      const configurable = !descriptor || descriptor.configurable !== false;
      if (configurable) {
        session = buildSession();
        try {
          Object.defineProperty(nav, "mediaSession", {
            value: session, writable: true, configurable: true, enumerable: true,
          });
        } catch (e) {
          log("foray-media-session: could not take over navigator.mediaSession", e);
          session = null;
          return false;
        }
        takeoverMode = "replace";
      } else {
        session = wrapExistingSession(existing);
        if (!session) return false;
        takeoverMode = "wrap";
      }
    }

    installed = true;
    subscription = subscribe();
    // M-03. A SECOND, INDEPENDENT SUBSCRIPTION — see `sessionSubscription`.
    sessionSubscription = subscribeSession();
    return true;
  }

  function uninstall() {
    if (!installed) return false;
    installed = false;
    /* Tell the shell first: an uninstalled polyfill will never report `idle`, and
       leaving `mediaLoaded` true would leave the foreground service with no JS able
       to stop it — the same hole `foray-audio-shell.js`'s `uninstall` closes by
       stopping the service before restoring the prototype. */
    lastPlaying = false;
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
    try {
      if (sessionSubscription && typeof sessionSubscription.remove === "function") {
        sessionSubscription.remove();
      }
    } catch (e) {
      log("foray-media-session: could not remove the session listener", e);
    }
    sessionSubscription = null;
    /* WebKit's object first, while `mirror` still reaches it: a mirrored
       handler left behind would keep WebKit's client advertising buttons that
       call into a page that has moved on. */
    unmirror();
    /* ONLY IF OURS IS STILL THE ONE THERE. If something replaced it after we
       installed, restoring blindly would delete that — the mirror of the care
       `foray-audio-shell.js` takes over the `play` patch. In "wrap" mode "ours"
       means the SAME object as before (we never replaced the property), so this
       check still answers the right question: has something ELSE since replaced
       the whole property out from under our wrap. */
    try {
      if (nav.mediaSession === session) {
        if (takeoverMode === "wrap") {
          /* Restore each member to its ORIGINAL descriptor — or delete it, if it
             had none of its own and was reaching the prototype's accessor. Every
             member is attempted even if one fails, so a single stubborn property
             cannot leave the rest wrapped. */
          const descriptors = wrappedDescriptors || {};
          for (const prop of Object.keys(descriptors)) {
            try {
              const original = descriptors[prop];
              if (original) Object.defineProperty(session, prop, original);
              else if (Object.prototype.hasOwnProperty.call(session, prop)) delete session[prop];
            } catch (e) {
              log("foray-media-session: could not restore wrapped " + prop, e);
            }
          }
          try {
            if (Object.prototype.hasOwnProperty.call(session, "forayPolyfill")) {
              delete session.forayPolyfill;
            }
          } catch (e) {
            log("foray-media-session: could not remove the forayPolyfill marker", e);
          }
        } else if (hadOwn) {
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
    takeoverMode = null;
    wrappedDescriptors = null;
    handlers.clear();
    lastDelivered.clear();
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
      /** Whether the tee has a target: WebKit's own `MediaSession` was captured
       *  at install (iOS only; always `false` on Android, where there is
       *  nothing to tee onto). `probe-bridge.js` reads it and `ios-ci.mjs`
       *  fails section 3d on a taken-over live object with no tee -- that is
       *  L-02's severed state, the one the founder's phone showed as "4a". */
      tee: mirror !== null,
      /** The actions also registered on WebKit's own session (iOS only). A
       *  device pass reading `[]` here while a Foray plays on iOS means the
       *  lock screen's skips are WebKit's raw element seek again. */
      mirrored: [...mirrored],
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
      /* The narration-first start (audit round 2, native-2), same lazy lookup. */
      onPlayingChange: function (playing) {
        const shell = window.ForayAudioShell;
        if (shell && typeof shell.noteTransportPlaying === "function") shell.noteTransportPlaying(playing);
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
