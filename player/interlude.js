/* The interlude jingle — a short musical sting the player sounds when a Foray
   moves INTO a tape segment on its own (founder request, 2026-09-10: a Foray
   must carry "the little jingle that we want to use as an interlude between
   podcasts").

   ── Two things live here, deliberately separable ──────────────────────────

     1. THE RULE — `interludeEligible()`. Pure. Which transitions get the
        jingle. Same shape and same reasons as `seam-gap.js`'s `seamGapSec()`:
        one screen, one answer, testable without a player.

     2. THE PLAYER — `createInterludePlayer()`. One private media element that
        plays one fixed asset at 1.0x and can be stopped. `PlayerQueueManager`
        drives it and owns the clock; this object knows nothing about the
        queue.

   ── THE RULE, in one paragraph ────────────────────────────────────────────
   The jingle plays when the queue ADVANCES ON ITS OWN from a previous item
   into a SEGMENT: segment -> segment and narration -> segment. Never before
   the first item (nothing to mark off from), never after the last (nothing
   follows), never into narration — so never between two narration items, and
   never segment -> narration, where the narration is the marker. Never on a
   skip, a row tap, a scrub or a resume: the listener named a destination, and
   a 3 s sting on a button press is a stall (`seam-gap.js` § "What is NOT a
   seam" — the same rule, for the same reason). And never straight after an
   authored `JINGLE` item (`foray-queue.js`): one mark per seam.

   ── Why it is NOT a queue item, and what that buys ────────────────────────
   `foray-queue.js` already defines a `JINGLE` item KIND for a jingle the
   GENERATOR places (generation-architecture.md §4.8) — an authored decision
   carried in `data/forays.json`, counted in `runtime_sec`, validated by
   `tools/foray/check-forays.mjs`. Since F-90 (2026-09-11) generated Forays carry them and
   they play this same placeholder asset. This module is the other thing: a
   PLAYER-SIDE mark that needs no data change, so every Foray already on disk —
   including the one the founder listens to today — gets it without a
   regeneration. The two coexist by one clause in the rule above.

   Because it is not a queue item it is NOT part of the Foray's runtime.
   `forayRuntimeSec`, `progressSegments`, `forayElapsed`, position persistence
   and `check-forays`' D1 budget are untouched: the jingle is wall clock the
   manager spends at a seam, exactly as the 2.0 s beat is (`seam-gap.js`
   § "THE GAP IS NOT AUDIO"). It REPLACES that beat rather than adding to it —
   generation-architecture.md §4.8: "a bridge and a gap are alternatives,
   never both" — and the manager's seam deadline becomes the jingle's own
   length, with the beat as the floor if the jingle stops short and
   `INTERLUDE_CEILING_SEC` as the ceiling if it never reports ending.

   ── Which backend this covers ─────────────────────────────────────────────
   The WebView path: `player/html-audio-backend.js` under the PWA and under
   the Capacitor shell that ships to TestFlight/Play (CLAUDE.md § Layout —
   `mobile/` is the shipping app; `ios/App/Player/PlayerBackend.swift` is
   uncompiled reference code with no counterpart to this). The jingle rides
   its own `<audio>` element, so the backend's element, out-point watch and
   prefetch machinery are untouched; `mobile/plugins/foray-audio`'s
   `HTMLMediaElement.prototype.play` wrapper sees this element's `play()` like
   any other and keeps the foreground service up across it.

   ── Why the asset is an ABSOLUTE https URL ────────────────────────────────
   `index.html`'s CSP says `media-src https:` and nothing else. On the website
   the origin is https, so a relative `player/assets/...` would do; in the iOS
   shell the origin is `capacitor://localhost` (docs/mobile-shell.md §3, the
   same reason `img-src` needed `'self'`), which `https:` does not match, so a
   bundled copy would be blocked outright. Widening `media-src` to `'self'` is
   a one-token `index.html` change that needs a founder merge (CLAUDE.md §
   Workflow rule 7 — `index.html` is unlisted). Until then the jingle is
   fetched from the live site over https on every host, which the existing
   policy already allows everywhere, and the element preloads it from the
   first tap so it is buffered long before the first seam. Cost: no jingle
   while offline. TODO(founder): once `media-src` carries `'self'`, point this
   at the bundled copy and add the file to `tools/mobile/prepare-webdir.mjs`.

   ── THE ASSET IS A PLACEHOLDER ────────────────────────────────────────────
   Synthesised by `tools/audio/make-interlude-placeholder.py`, not designed.
   `docs/curation/narration-craft.md` § "The interlude jingle (placeholder)"
   says how to swap in the founders' real one.
*/

import { AUTO_ADVANCE, isSegment } from "./seam-gap.js";
import { JINGLE } from "./foray-queue.js";

/** Repo-relative path of the asset — what the generator writes and the live
    site serves at the same path (GitHub Pages deploys the repo root verbatim). */
export const INTERLUDE_ASSET_PATH = "player/assets/interlude-placeholder.wav";

/** The live site root. See the header for why the URL is absolute. */
export const SITE_ROOT = "https://jw-incorporated.github.io/foray/";

export const INTERLUDE_ASSET_URL = SITE_ROOT + INTERLUDE_ASSET_PATH;

/** The asset's length. PINNED to the committed file by `player/interlude.test.js`,
    which reads the WAV header and fails if the two drift. Not read from the
    element's `duration` at runtime: the manager does not need it to play the
    jingle (it waits for `ended`), only tests and docs do. */
export const INTERLUDE_DURATION_SEC = 3.0;

/** The longest the manager will hold a seam for the jingle. A media element
    that never fires `ended` — a stalled fetch, a decoder that gave up silently,
    a WebView that paused it behind our back — must not hold the next segment
    forever. 1.5 s over the asset covers the start-up latency of a `play()`
    call on a buffered element with room to spare; anything slower is a jingle
    that was not ready, which `start()` already refuses below. */
export const INTERLUDE_CEILING_SEC = INTERLUDE_DURATION_SEC + 1.5;

/** Always. The jingle is a fixed asset at a level and pace we chose — the
    same argument `resetRateForTTS` makes for narration (corner case #18). */
export const INTERLUDE_RATE = 1.0;

/** `cp_` prefix like every other key (CLAUDE.md § Conventions). Absent means
    ON; the only value that turns it off is the literal "off". */
export const INTERLUDE_KEY = "cp_interlude";

/* ---------- the rule ---------- */

/**
 * Does this transition get the jingle?
 *
 * @param {object}  seam
 * @param {object}  [seam.from]   the queue item that just finished
 * @param {object}  [seam.to]     the queue item about to load
 * @param {string}  [seam.cause]  AUTO_ADVANCE | USER_ACTION
 * @returns {boolean}
 */
export function interludeEligible({ from, to, cause = AUTO_ADVANCE } = {}) {
  if (cause !== AUTO_ADVANCE) return false;
  if (!from || !to) return false;
  if (!isSegment(to)) return false;
  if (from.kind === JINGLE) return false;
  return true;
}

/** One human sentence about the decision, for telemetry. Beside the rule so
    the log line cannot describe a decision this module did not make. */
export function describeInterlude({ from, to, cause = AUTO_ADVANCE } = {}) {
  if (interludeEligible({ from, to, cause })) return `jingle: ${from.id} -> ${to.id}`;
  if (cause !== AUTO_ADVANCE) return `no jingle (${cause}-driven): the listener named where to go`;
  if (!from) return "no jingle: nothing before this item";
  if (!to) return "no jingle: nothing follows this item";
  if (!isSegment(to)) return `no jingle: ${to.id} is not a tape segment`;
  return `no jingle: ${from.id} is already a jingle`;
}

/* ---------- the setting ---------- */

/** The stored preference, or ON. Same injection and same posture as
    `playback-rate.js`'s `readRate`: a throwing or absent store is the ordinary
    case, not an error. */
export function readInterludePref(storage) {
  if (!storage || typeof storage.getItem !== "function") return true;
  try {
    return storage.getItem(INTERLUDE_KEY) !== "off";
  } catch (_) {
    return true;
  }
}

/** Write the preference down. Returns whether it stuck. */
export function writeInterludePref(storage, on) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(INTERLUDE_KEY, on ? "on" : "off");
    return true;
  } catch (_) {
    return false;
  }
}

/* ---------- the player ---------- */

const HAVE_FUTURE_DATA = 3;

/**
 * One element, one asset, the manager's clock.
 *
 * Contract the manager relies on (and `queue-manager.test.js` fakes):
 *
 *   prime()            spend a user gesture on the element and kick its
 *                      preload; safe to call on every tap, does the work once
 *   start() -> bool    begin the jingle from 0 at 1.0x. `false` means it could
 *                      not (no element, not buffered, already sounding) and
 *                      the seam should keep its ordinary beat. A `true` is
 *                      followed by exactly one `onEnded(reason)`, unless
 *                      `stop()` arrives first.
 *   stop()             silence it now; no `onEnded` follows
 *   onEnded = fn(reason)   assigned by the manager. "ended" | "error" |
 *                      "rejected"
 *   get active         `true` between a successful `start()` and its end
 *   release()          drop the element's buffer
 *
 * @param {object}  [opts]
 * @param {string}  [opts.url]       defaults to INTERLUDE_ASSET_URL
 * @param {object}  [opts.element]   an `<audio>`-shaped object (tests); default
 *                                   `new Audio()` where one exists, else null
 *                                   and every method is an inert no-op
 * @param {Function} [opts.telemetry]
 */
export function createInterludePlayer({ url = INTERLUDE_ASSET_URL, element, telemetry = null } = {}) {
  const el = element !== undefined ? element : (typeof Audio !== "undefined" ? new Audio() : null);
  const emit = (m) => { if (typeof telemetry === "function") telemetry(`interlude.${m}`); };

  const player = {
    onEnded: null,
    _active: false,
    _primed: false,
    _released: false,
    get active() { return this._active; },
    get element() { return el; },
    get url() { return url; },
  };

  if (!el) {
    emit("unavailable: no media element on this host");
    player.prime = () => false;
    player.start = () => false;
    player.stop = () => {};
    player.release = () => {};
    return player;
  }

  /* Configured once. `preload="auto"` asks for the whole file up front —
     it is half a megabyte and the first seam is minutes away. No `crossorigin`
     attribute, for the same reason `html-audio-backend.js` sets none: a media
     element loads cross-origin fine without CORS, and the attribute would turn
     the shell's cross-origin fetch of the live site's copy into a hard failure
     if the header were ever missing. */
  try { el.preload = "auto"; } catch (_) { /* fine */ }
  try { el.src = url; } catch (_) { /* fine */ }

  const finish = (reason) => {
    if (!player._active) return;
    player._active = false;
    emit(reason);
    if (typeof player.onEnded === "function") {
      try { player.onEnded(reason); } catch (_) { /* the manager must never break the player */ }
    }
  };

  if (typeof el.addEventListener === "function") {
    el.addEventListener("ended", () => finish("ended"));
    el.addEventListener("error", () => finish("error"));
  }

  /** Spend the tap on this element too. `html-audio-backend.js`'s
      `notePlayGesture` explains the restriction: Safari lifts the autoplay
      block per ELEMENT, at the CALL of `play()` inside a gesture, and the seam
      that needs this element is minutes outside any tap. Muted while it runs
      so the priming itself is never audible, then rewound; a refusal is
      expected and costs nothing but the jingle at the next seam. Once per
      session — the restriction lifts once. */
  player.prime = () => {
    if (player._released || player._primed) return false;
    player._primed = true;
    try {
      el.muted = true;
      const p = el.play();
      const settle = () => {
        try { el.pause(); } catch (_) { /* fine */ }
        try { el.currentTime = 0; } catch (_) { /* not seekable yet; start() rewinds again */ }
        try { el.muted = false; } catch (_) { /* fine */ }
      };
      if (p && typeof p.then === "function") p.then(settle, settle);
      else settle();
    } catch (err) {
      try { el.muted = false; } catch (_) { /* fine */ }
      emit(`prime.threw ${err?.name ?? err}`);
      return false;
    }
    emit("primed");
    return true;
  };

  player.start = () => {
    if (player._released) return false;
    if (player._active) return false;
    /* Not buffered means not ready to be a 3 s mark: a `play()` on an element
       still fetching starts whenever the bytes land, which on a bad connection
       is a seam WORSE than the beat it replaces. Refuse, let the manager keep
       the 2.0 s beat, and let the element go on loading for the next seam. */
    const ready = typeof el.readyState === "number" ? el.readyState : HAVE_FUTURE_DATA;
    if (ready < HAVE_FUTURE_DATA) {
      emit(`notReady readyState=${ready}`);
      try { if (el.networkState === 3 /* NETWORK_NO_SOURCE */) el.load(); } catch (_) { /* fine */ }
      return false;
    }
    try { el.currentTime = 0; } catch (_) { /* fine */ }
    try { el.muted = false; } catch (_) { /* fine */ }
    try { el.playbackRate = INTERLUDE_RATE; } catch (_) { /* refused; still a jingle */ }
    player._active = true;
    let p;
    try {
      p = el.play();
    } catch (err) {
      player._active = false;
      emit(`play.threw ${err?.name ?? err}`);
      return false;
    }
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        emit(`play.rejected ${err?.name ?? err}`);
        finish("rejected");
      });
    }
    emit("started");
    return true;
  };

  player.stop = () => {
    const was = player._active;
    // Cleared FIRST, so the pause below cannot be mistaken for an end.
    player._active = false;
    try { el.pause(); } catch (_) { /* fine */ }
    try { el.currentTime = 0; } catch (_) { /* fine */ }
    if (was) emit("stopped");
  };

  player.release = () => {
    player.stop();
    player._released = true;
    try { el.removeAttribute("src"); el.load(); } catch (_) { /* fine */ }
  };

  return player;
}
