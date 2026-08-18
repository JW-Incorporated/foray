/* The lock screen, the car head unit, and the headphone pinch (issue #27).

   `navigator.mediaSession` is the browser's half of MPNowPlayingInfoCenter +
   MPRemoteCommandCenter, which `docs/brief/04_VOICE_AUDIO_SPEC.md` calls "the
   baseline hands-free interface [that] must be flawless before any voice work."
   A Foray is 51-61 minutes and is listened to with the screen off, in a pocket,
   in a car. Until this module existed, all of that surface was blank: no title,
   no publisher, no controls, and a hardware pause button that did nothing.

   Everything here is PURE — no DOM, no `navigator`, no timers. The live objects
   arrive as arguments, which is what lets the whole mapping be tested under
   `node --test` and is the same contract `seam-gap.js` and `foray-queue.js`
   keep. `player/client.js` owns the wiring and nothing else.

   ── 1. WHAT THE LOCK SCREEN SAYS, AND WHY ─────────────────────────────────

   A normal podcast app has one episode and three fields. A Foray has 22-32
   segments drawn from up to nine episodes of nine different shows, so the three
   fields have to carry three DIFFERENT facts rather than one fact spelled three
   ways. The mapping:

     title   the SOURCE EPISODE's title — the thing that is sounding right now.
     artist  the SOURCE SHOW's name — the publisher credit.
     album   the FORAY's title, plus `part N of M`.

   Three reasons that order and not another:

     a. THE FIELDS ARE NOT EQUALLY VISIBLE. `title` and `artist` are rendered by
        every platform that renders anything; `album` is the one a narrow
        notification or an older head unit drops first. So the two facts a
        listener cannot do without — what is playing, whose it is — go in the two
        fields that always survive, and the one they can reconstruct (which
        Foray they pressed play on: they pressed it) goes in the field that
        might not.

     b. PUBLISHERS DESERVE THE CREDIT, in the field the OS labels "artist".
        Product principle 3 means every second of this is a download against the
        publisher's own feed and their own numbers; the "Where this came from"
        block (`player/foray-sources.js`) is the same argument on the page. A
        Foray that showed only "Foray — The history of grilling" for an hour
        would take nine publishers' work and put our name on it.

     c. IT HAS TO CHANGE AT EVERY SEAM. A car display whose text never moves for
        51 minutes tells the listener nothing and reads as frozen. Because
        `title`/`artist` are the segment's, the display refreshes 31 times — at
        exactly the moments the audio changes — and the OS treats each as a new
        track, which is what makes the change legible without a glance.

   `album` carries `part 12 of 32` because that is the one fact a display can add
   for free, and it is worded exactly as the mini bar words it (`client.js`'s
   `forayNowPlaying`) so the two surfaces cannot drift.

   Narration items (`kind === "tts"`) take `title = "Up next: <episode>"`,
   verbatim from `04_VOICE_AUDIO_SPEC.md` line 11, and `artist = "Foray"` —
   we wrote that audio, and putting a publisher's name on a line they did not
   record would be the one credit error this module must not make. No Foray
   ships narration yet, which is exactly why the branch is tested.

   Nothing is ever invented: a missing show yields an empty `artist`, never a
   guess. See `mediaMetadata`.

   ── 2. PREVIOUS / NEXT ARE SEGMENTS ───────────────────────────────────────

   `04_VOICE_AUDIO_SPEC.md`: "nextTrack = next queue item, prevTrack = restart
   item / previous". The queue item IS the segment, and the segment is the unit
   the listener experiences — a 51-minute Foray has no other boundaries.

   They are not re-implemented here. `mediaSessionActions` takes a surface of
   plain callbacks and `client.js` fills them with the SAME functions the
   in-page transport buttons call (`forayNext`, `forayPrevious`), so the lock
   screen inherits `forayPrevious`'s restart-vs-previous window rather than
   holding a second opinion about it. The two cannot disagree because there is
   only one of each.

   ── 3. POSITION IS THE FORAY'S CLOCK, NOT THE EPISODE'S ───────────────────

   `setPositionState` reports position and duration across the WHOLE Foray, the
   same number the in-page scrubber shows (#196) and the same one
   `foray-resolve.js` was written to compute. The alternative — the current
   segment — loses on three counts:

     - The audio element's `currentTime` for segment 20 is ~31 minutes into
       somebody else's episode. It is not a position this listener has any
       relationship with.
     - A car's progress bar would fill and reset every ~110 seconds, 31 times.
       That does not read as 31 segments; it reads as a broken app.
     - `seekto` from a car head unit hands back a time IN THE TIMELINE WE
       REPORTED. Report the segment and a car scrub can only ever move inside
       110 seconds. Report the Foray and a scrub to 30:00 lands at 30:00 of the
       Foray, routed through `foraySeek` — the scrubber's own path, so the
       car and the page land in the same place by construction.

   Single-episode playback (`ForayPlayer.play`) reports the episode, because
   there the episode is the whole thing.

   ── 4. THE SEAM BEAT REPORTS "PLAYING" ────────────────────────────────────

   `seam-gap.js` puts 2.0 s of silence between two unbridged segments. The
   element is genuinely paused for it, so the honest-looking answer is
   `playbackState = "paused"`. That is the wrong answer, deliberately:

     - The listener did not pause. Nothing they did caused it. The beat is an
       edit WE authored — the audiobook section break of
       `docs/curation/segment-length-rules.md` §6b — which makes it content, not
       an interruption.
     - It would flicker to paused and back 31 times an hour, roughly every two
       minutes, on a display the listener glances at while driving. A transport
       state that blinks is how an app stops feeling native.

   So `mediaPlaybackState` widens "playing" by exactly one state, and it is the
   same widening `client.js`'s `isRunning()` already applies to the in-page
   buttons — one definition of "the Foray is running", not two.

   THE COST, NAMED. While the OS believes we are playing it extrapolates
   position forward from the last report using `playbackRate` and wall clock. So
   during a beat the reported elapsed runs ahead of the truth, and snaps back
   once when audio resumes. Reporting zero rate instead is not available: the
   spec makes a zero `playbackRate` a `TypeError`. We took a bounded drift over
   a state that blinks.

   **THE BOUND IS `SEAM_GAP_SEC x playbackRate`, NOT 2.0 s** — restated when the
   speed control shipped (#242), because the original text said "up to
   `SEAM_GAP_SEC` (2.0 s)" and that was only true at 1x. The beat is 2.0 s of WALL
   clock and does not scale with rate (`seam-gap.js`, and the decision is pinned in
   `player/foray-playback.test.js`), while the OS extrapolates in CONTENT seconds
   at the rate we reported — so a beat costs 2.0 s of apparent progress at 1x and
   4.0 s at 2x, which is the top of the ladder and therefore the bound.

   Still the right trade, and the arithmetic barely moves: 4.0 s is 0.11% of a
   51-minute bar against 0.065%, it is bounded by the beat rather than growing, it
   self-corrects on the next tick, and it lands at the one moment the display is
   redrawing its title anyway. What matters is that the number is stated
   correctly — a documented bound that is quietly wrong at 2x is worse than a
   larger one that is right.

   A FINISHED Foray reports `"none"`, not `"paused"`. A car display offering a
   play button that does nothing is worse than no display at all.

   ── 5. ARTWORK ────────────────────────────────────────────────────────────

   MediaSession artwork is fetched by the browser on the OS's behalf, so it is
   subject to our CSP. `index.html` sets `img-src https: data:`, which permits
   any https artwork and needs NO policy change — verified before writing this,
   because widening the CSP for a picture would be a bad trade.

   The DATA is the limit, not the policy. `data/segment-sources.json` carries no
   artwork field at all, and joining our shows against `data/discover.json` by
   name covers 1 of the 12 shows the two shipped Forays draw on. So artwork is
   a two-tier answer, exactly like `foray-sources.js`'s show link: the show's
   own square when we have one, and the app's own icon when we do not, so the
   lock screen is never a blank grey box. `mediaArtwork` refuses anything that
   is not https, a `data:image/` URI, or a same-origin relative path — the same
   allow-or-replace posture as app.js's `safeUrl()`, applied where the fetch
   actually happens.

   ── 6. ABSENCE MUST NEVER THROW ───────────────────────────────────────────

   Desktop Safari has no `playbackState`, older Safari no `setPositionState`,
   and plenty of browsers throw on an action they do not implement. Every one of
   those is normal, none of them is an error, and a player that dies on the
   lock-screen layer has traded working audio for a nicer notification. So
   `createMediaSession` returns an inert bridge when there is nothing to talk
   to, and guards every single call into the API individually.
*/

import { TTS } from "./queue-state.js";

/** `navigator.mediaSession.playbackState` values, spelled once. */
export const NONE = "none";
export const PAUSED = "paused";
export const PLAYING = "playing";

/** `04_VOICE_AUDIO_SPEC.md`'s "±30/15 s seek", and the same numbers
    `player/client.js` puts on the in-page buttons. */
export const SEEK_BACKWARD_SEC = 15;
export const SEEK_FORWARD_SEC = 30;

/** Ours, and the fallback when a publisher's square is unknown. Relative on
    purpose: it resolves against the document, which is https on the live site
    and therefore inside `img-src https:`. */
export const APP_ARTWORK_URL = "icon-512.png";

/** Every action this module knows how to install, in the order it installs
    them. Exported so a test can assert the set rather than re-listing it. */
export const MEDIA_ACTIONS = Object.freeze([
  "play", "pause", "stop", "previoustrack", "nexttrack",
  "seekbackward", "seekforward", "seekto",
]);

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;
const clean = (s) => (nonEmpty(s) ? s.trim() : "");

/* ---------- artwork ---------- */

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/** A newline, a tab or a NUL inside a URL is how a blocked scheme sneaks past
    a naive check, and a raw space is simply not a URL. Refuse the whole string
    rather than strip it, and keep the class as escapes so this file carries no
    literal control bytes of its own. */
const CONTROL = /[\u0000-\u0020\u007f]/;

/**
 * The one URL gate on this surface. Allow or replace, never sanitise — app.js's
 * `safeUrl()` posture, applied here because this is where a URL leaves our
 * control: the browser fetches it for the OS.
 *
 * Permitted: `https:` (what the CSP allows), a `data:image/` URI (likewise), and
 * a relative path (our own icon, which inherits the document's https origin).
 * Refused: everything else, including `http:` — the CSP would block it anyway,
 * so handing it over would only produce a console error with our name on it —
 * and protocol-relative `//host/...`, which is a third-party fetch wearing a
 * relative path's clothes.
 *
 * @returns {string|null} the URL, or null when it may not be used
 */
export function artworkUrl(url) {
  if (!nonEmpty(url)) return null;
  const s = url.trim();
  if (CONTROL.test(s)) return null;
  if (s.startsWith("//")) return null;
  const m = SCHEME.exec(s);
  if (!m) return s;
  const scheme = m[1].toLowerCase();
  if (scheme === "https") return s;
  if (scheme === "data" && /^data:image\//i.test(s)) return s;
  return null;
}

/** `.../mza_1665.png/600x600bb.jpg` -> `600x600`. The OS picks from `sizes`, so
    an honest one is worth reading off the URL Apple already encodes it in; a
    guess is not, hence null rather than a default. */
function sizesOf(url) {
  const m = /(?:^|[/_-])(\d{2,4})x(\d{2,4})(?:[^/]*)$/.exec(url);
  return m ? `${m[1]}x${m[2]}` : null;
}

/** MIME from the extension, or null. Never guessed: an artwork entry with the
    wrong `type` is worse than one with none, because a platform may filter on
    it. */
function typeOf(url) {
  if (/^data:(image\/[a-z0-9.+-]+)/i.test(url)) return /^data:(image\/[a-z0-9.+-]+)/i.exec(url)[1].toLowerCase();
  const path = url.split(/[?#]/)[0];
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.webp$/i.test(path)) return "image/webp";
  if (/\.gif$/i.test(path)) return "image/gif";
  if (/\.svg$/i.test(path)) return "image/svg+xml";
  return null;
}

/**
 * One `MediaImage`, or null when the URL may not be used.
 *
 * @param {string} url
 * @param {object} [over]  `{ sizes, type }` when the caller knows better than
 *   the URL does (our own icon, whose size is not in its name)
 */
export function mediaArtwork(url, over = {}) {
  const src = artworkUrl(url);
  if (!src) return null;
  const image = { src };
  const sizes = nonEmpty(over.sizes) ? over.sizes.trim() : sizesOf(src);
  if (sizes) image.sizes = sizes;
  const type = nonEmpty(over.type) ? over.type.trim() : typeOf(src);
  if (type) image.type = type;
  return image;
}

/**
 * The artwork list for one item: the publisher's square when we have it, ours
 * when we do not, and an empty list when neither is usable.
 *
 * Deliberately not both: the OS picks by size, not by preference, so offering
 * our icon alongside a publisher's square is a coin flip over whose mark shows.
 */
export function mediaArtworkList({ showArtworkUrl = null, appArtworkUrl = APP_ARTWORK_URL } = {}) {
  const show = mediaArtwork(showArtworkUrl);
  if (show) return [show];
  const app = mediaArtwork(appArtworkUrl, { sizes: "512x512", type: "image/png" });
  return app ? [app] : [];
}

/* ---------- metadata ---------- */

/**
 * foray + segment + source -> the three strings and the artwork. §1 above is
 * the argument; this is the whole of the mechanism.
 *
 * Pure and total: every field has a defined value for every input, including
 * `null`, and no field is ever fabricated. A missing show gives `artist: ""`,
 * because an empty credit is recoverable and a wrong one is not.
 *
 * @param {object} [view]
 * @param {object} [view.item]      the queue item now loaded (see foray-queue.js)
 * @param {object} [view.nextItem]  the item after it — only read for narration,
 *   whose spec title is "Up next: <episode>"
 * @param {string} [view.forayTitle] "" for single-episode playback, which has no
 *   collection and therefore no album
 * @param {number} [view.index]     0-based position in the playable queue
 * @param {number} [view.total]     length of the playable queue; 0 suppresses
 *   the part counter
 * @param {string} [view.showArtworkUrl]
 * @param {string} [view.appArtworkUrl]
 * @returns {{ title: string, artist: string, album: string, artwork: object[] }}
 */
export function mediaMetadata({
  item = null, nextItem = null, forayTitle = "", index = 0, total = 0,
  showArtworkUrl = null, appArtworkUrl = APP_ARTWORK_URL,
} = {}) {
  const foray = clean(forayTitle);
  const narration = item?.kind === TTS;

  let title;
  let artist;
  if (narration) {
    // 04_VOICE_AUDIO_SPEC.md line 11, verbatim.
    const upNext = clean(nextItem?.title);
    // Deliberately NOT the narration item's own title when there is nothing
    // after it: an authored narration id is a slug (`bridge-3`), and a slug on a
    // car display is worse than the Foray's name, which is always a sentence.
    title = upNext ? `Up next: ${upNext}` : (foray || "Foray");
    // Our line, our name. Never a publisher's.
    artist = "Foray";
  } else {
    title = clean(item?.title) || foray || "Foray";
    artist = clean(item?.show);
  }

  return {
    title,
    artist,
    album: albumOf(foray, index, total),
    artwork: mediaArtworkList({
      // A narration line is ours; a publisher's square does not belong on it.
      showArtworkUrl: narration ? null : showArtworkUrl,
      appArtworkUrl,
    }),
  };
}

/** "The history of grilling · part 12 of 32". Worded as the mini bar words it. */
function albumOf(forayTitle, index, total) {
  const n = Number.isInteger(index) && index >= 0 && Number.isInteger(total) && total > 0
    ? `part ${Math.min(index, total - 1) + 1} of ${total}`
    : "";
  if (forayTitle && n) return `${forayTitle} · ${n}`;
  if (forayTitle) return forayTitle;
  if (n) return n.charAt(0).toUpperCase() + n.slice(1);
  return "";
}

/* ---------- position and playback state ---------- */

/**
 * A `MediaPositionState`, or null when there is nothing reportable.
 *
 * The spec throws a `TypeError` on a negative duration, a position outside
 * `[0, duration]`, or a zero rate, and a throw here would take the player's
 * render loop with it. So this validates and clamps rather than trusting the
 * caller, and returns null — "do not report" — for the cases no clamp can
 * rescue. §3 above is which clock these seconds are on.
 */
export function mediaPositionState({ durationSec = null, positionSec = 0, playbackRate = 1 } = {}) {
  if (!isNum(durationSec) || durationSec <= 0) return null;
  const duration = durationSec;
  const raw = isNum(positionSec) ? positionSec : 0;
  const position = Math.min(Math.max(0, raw), duration);
  // A zero or negative rate is a TypeError, and we never play backwards.
  const rate = isNum(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return { duration, position, playbackRate: rate };
}

/**
 * The transport state the OS should show. §4 above is the seam-gap argument.
 *
 * @param {object} [view]
 * @param {boolean} [view.hasItem]    something is loaded at all
 * @param {boolean} [view.playing]    the element is actually producing audio
 * @param {boolean} [view.inSeamGap]  the 2.0 s authored beat between segments
 * @param {boolean} [view.ended]      the Foray finished
 */
export function mediaPlaybackState({ hasItem = false, playing = false, inSeamGap = false, ended = false } = {}) {
  if (!hasItem) return NONE;
  // Checked before `playing` on purpose: a finished Foray is not a paused one,
  // and a play button that cannot do anything is worse than none.
  if (ended) return NONE;
  if (playing || inSeamGap) return PLAYING;
  return PAUSED;
}

/* ---------- the whole view ---------- */

/**
 * Everything the bridge needs, in one pure call, so `client.js` gathers live
 * values and decides nothing.
 *
 * @returns {{ metadata: object, positionState: object|null, playbackState: string }}
 */
export function mediaSessionView(view = {}) {
  return {
    metadata: mediaMetadata(view),
    positionState: mediaPositionState(view),
    playbackState: mediaPlaybackState({
      hasItem: Boolean(view.item),
      playing: Boolean(view.playing),
      inSeamGap: Boolean(view.inSeamGap),
      ended: Boolean(view.ended),
    }),
  };
}

/* ---------- actions ---------- */

/**
 * Action name -> handler, built from a surface of plain callbacks.
 *
 * An action whose surface method is ABSENT is not returned, and therefore never
 * registered, so the OS greys the button out. That is the honest rendering of
 * single-episode playback: the queue is one item (`SINGLE_ITEM`, product
 * principle 1 — no autoplay chains), so `nexttrack` has nowhere to go and a
 * button that silently does nothing is worse than a dim one.
 *
 * @param {object} surface  any subset of
 *   `{ play, pause, stop, next, previous, seekBy(offsetSec), seekTo(positionSec) }`
 * @param {object} [opts] `{ seekBackwardSec, seekForwardSec }`
 * @returns {Array<[string, Function]>} in MEDIA_ACTIONS order
 */
export function mediaSessionActions(surface = {}, {
  seekBackwardSec = SEEK_BACKWARD_SEC, seekForwardSec = SEEK_FORWARD_SEC,
} = {}) {
  const fn = (name) => (typeof surface?.[name] === "function" ? surface[name].bind(surface) : null);
  const play = fn("play");
  const pause = fn("pause");
  const stop = fn("stop");
  const next = fn("next");
  const previous = fn("previous");
  const seekBy = fn("seekBy");
  const seekTo = fn("seekTo");

  const out = [];
  if (play) out.push(["play", () => play()]);
  if (pause) out.push(["pause", () => pause()]);
  if (stop) out.push(["stop", () => stop()]);
  if (previous) out.push(["previoustrack", () => previous()]);
  if (next) out.push(["nexttrack", () => next()]);
  if (seekBy) {
    // `details.seekOffset` is the platform's own number when it has one — a
    // head unit may ask for 10 s. Honour it; fall back to the spec's ±15/30,
    // which are the numbers the in-page buttons use.
    out.push(["seekbackward", (details) => seekBy(-offsetOf(details, seekBackwardSec))]);
    out.push(["seekforward", (details) => seekBy(offsetOf(details, seekForwardSec))]);
  }
  if (seekTo) {
    out.push(["seekto", (details) => {
      const t = details?.seekTime;
      // A car scrub with no time is not a seek to zero. Ignore it.
      if (!isNum(t) || t < 0) return undefined;
      // `fastSeek` is deliberately dropped: whether a seek may be approximate is
      // `player/seek-policy.js`'s decision (ADR-0007/0008), never the head
      // unit's, and on a DAI source an approximate landing is a wrong one.
      return seekTo(t);
    }]);
  }
  return out;
}

function offsetOf(details, fallback) {
  const o = details?.seekOffset;
  return isNum(o) && o > 0 ? o : fallback;
}

/* ---------- the bridge ---------- */

/** Every call into the platform goes through this. A lock screen that throws
    must not be able to stop audio — see §6. */
function attempt(fn) {
  try { return fn(); } catch (_) { return undefined; }
}

/**
 * Wrap a live `navigator.mediaSession`, or return an inert stand-in.
 *
 * @param {object} [opts]
 * @param {object} [opts.nav]  a `navigator`, or anything with `.mediaSession`
 * @param {Function} [opts.MediaMetadata]  the constructor; a plain object is
 *   assigned when it is absent, which some engines accept and none break on
 * @returns {{
 *   supported: boolean,
 *   setActions(surface, opts): string[],   installed action names
 *   update(view): void,                    metadata + position + state
 *   clear(): void,                         no media is loaded any more
 *   release(): void,                       clear, and remove every handler
 * }}
 */
export function createMediaSession({ nav = null, MediaMetadata = null } = {}) {
  const ms = nav && typeof nav === "object" ? nav.mediaSession : null;
  if (!ms || typeof ms !== "object") return inertBridge();

  /** Which actions we have a handler installed for. Tracked so switching from a
      Foray to a single episode REMOVES `nexttrack` instead of leaving a stale
      handler pointed at a Foray that is no longer loaded. */
  const installed = new Set();
  /** Last values written, so a 4 Hz render loop does not reassign metadata 4
      times a second — on Android that redraws the notification and visibly
      flickers. */
  let lastMetaKey = null;
  let lastPositionKey = null;
  let lastState = null;

  const setHandler = (action, handler) => {
    // Unsupported actions THROW in Chromium rather than no-op, so each one is
    // guarded on its own: one unknown action must not cost us the other seven.
    const ok = attempt(() => { ms.setActionHandler(action, handler); return true; });
    if (ok && handler) installed.add(action);
    else if (ok) installed.delete(action);
    return Boolean(ok);
  };

  const clearHandlers = () => {
    for (const action of [...installed]) setHandler(action, null);
    installed.clear();
  };

  return {
    supported: true,

    setActions(surface, opts = {}) {
      if (typeof ms.setActionHandler !== "function") return [];
      const wanted = new Map(mediaSessionActions(surface, opts));
      // Remove first: an action the new surface does not offer must not keep a
      // handler bound to the old one.
      for (const action of [...installed]) if (!wanted.has(action)) setHandler(action, null);
      const out = [];
      for (const [action, handler] of wanted) {
        // Never awaited and never allowed to reject into the platform: an action
        // handler that throws is reported by the browser as a broken page.
        if (setHandler(action, (details) => { attempt(() => Promise.resolve(handler(details)).catch(() => {})); })) {
          out.push(action);
        }
      }
      return out;
    },

    update({ metadata = null, positionState = null, playbackState = null } = {}) {
      if (metadata) {
        const key = `${metadata.title} ${metadata.artist} ${metadata.album} ` +
          (metadata.artwork ?? []).map((a) => a.src).join(",");
        if (key !== lastMetaKey) {
          lastMetaKey = key;
          attempt(() => {
            ms.metadata = typeof MediaMetadata === "function" ? new MediaMetadata(metadata) : { ...metadata };
          });
        }
      }
      if (playbackState && playbackState !== lastState) {
        lastState = playbackState;
        attempt(() => { ms.playbackState = playbackState; });
      }
      if (positionState && typeof ms.setPositionState === "function") {
        // Tenth-of-a-second granularity: finer than any display renders, coarse
        // enough that a still playhead stops writing.
        const key = [positionState.duration, positionState.position, positionState.playbackRate]
          .map((n) => Math.round(n * 10)).join("/");
        if (key !== lastPositionKey) {
          lastPositionKey = key;
          attempt(() => ms.setPositionState(positionState));
        }
      }
    },

    clear() {
      lastMetaKey = null;
      lastPositionKey = null;
      lastState = NONE;
      attempt(() => { ms.metadata = null; });
      attempt(() => { ms.playbackState = NONE; });
      // No argument clears it, per spec. Older engines have no method at all.
      if (typeof ms.setPositionState === "function") attempt(() => ms.setPositionState());
    },

    release() {
      this.clear();
      clearHandlers();
    },
  };
}

/** No `navigator.mediaSession`: desktop Safari, an old browser, a test, Node.
    Everything still answers, nothing throws, `supported` says so out loud. */
function inertBridge() {
  return {
    supported: false,
    setActions() { return []; },
    update() {},
    clear() {},
    release() {},
  };
}
