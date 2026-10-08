/* ui/foray-player.js — Foray player surface: the segment strip, transport bindings, rate menu, paintForay.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* The strip is the signature element (#128) and it is BUILT IN THE PLAYER
   MODULE, `player/segment-strip.js` — show colours, the capsule per source
   episode, the gap that makes a cross-episode seam visible, the narrator
   bridges and the accessible label all live there, and the Now Playing sheet
   (#133) will mount the same component rather than a second copy of it.

   No position is passed. The bars this page renders are handed straight over to
   `paintForay`/`paintSegFill`, which repaint past/current/upcoming four times a
   second from the live clock; mounting with a position too would mean two
   writers for one set of classes, disagreeing for one frame on every load.

   The fallback is not defensive noise. `renderForay` reaches this line only
   because `player.resolve` answered, so the module IS evaluated — but app.js
   and the module are separate cache entries and a page can be paired with an
   older module that has no `stripInto`. That one gets the template's plain bars
   and the sizing this function has always done — proportional, uncoloured and
   uncapsuled, which is what shipped before this change, rather than an empty
   strip. `.fy-seg`'s fallback tone in styles.css exists for exactly those bars:
   they carry no tone class, and the bordered grey they used to be would now be
   invisible, since the coloured bar has no border. */
function mountForayStrip(r, player) {
  const strip = $("#fy-strip");
  if (!strip) return;
  /* A Foray with nothing playable still draws its shape (the unavailable page, BUILD-NOTES 4.6: "strip
     still drawn"): the strip takes the authored entries, which it reads in either shape (isNarration in
     player/segment-strip.js). Nothing is bound to that strip, so nothing seeks on it. */
  const items = r.playable.length ? r.playable : (r.entries || []);
  if (typeof player?.stripInto === "function") {
    player.stripInto(strip, items, { size: "lg" });
    return;
  }
  sizeForayStrip(r);
}

/* Each segment's share of the strip is its share of the runtime. Set as a DOM
   property, never as a style attribute — the page CSP is style-src 'self'. */
function sizeForayStrip(r) {
  const strip = $("#fy-strip");
  if (!strip) return;
  (r.playable.length ? r.playable : (r.entries || [])).forEach((item, i) => {
    const seg = strip.children[i];
    if (!seg) return;
    seg.style.flexGrow = String(Math.max(1, Math.round(segLenOf(item))));
  });
}

/* A queue item's authored length, which has to be THE SAME length
   `player/foray-resolve.js` measures the Foray's clock in — that agreement is
   what keeps the bar's width, the bar's fill and a click's destination pointing
   at the same second. `stripElapsedAt` below maps a click onto `r.totalSec`, so
   any item this measures differently from `itemRuntimeSec` puts a click in the
   wrong place by the difference.

   It therefore asks the player, which owns the rule. `app.js` is a classic
   browser script and cannot `import` from `player/`, so the bridge carries it;
   the local arithmetic below is a fallback for the case where the player module
   has not booted, and it mirrors `itemRuntimeSec` branch for branch —
   INCLUDING the `duration_sec` fallthrough a narration item relies on, because
   a bridge measured as 0 s here would size to a 1px bar while occupying real
   seconds of the clock the click is mapped onto. */
function segLenOf(item) {
  const player = typeof window !== "undefined" ? window.ForayPlayer : null;
  if (typeof player?.itemLen === "function") return player.itemLen(item);
  // `isNum`, not `??`: `??` passes NaN straight through, so an
  // `authored_end_sec: NaN` would measure 0 here and its real length in
  // foray-resolve.js — the exact drift this shared helper exists to prevent.
  const num = (n) => typeof n === "number" && Number.isFinite(n);
  const end = num(item?.authored_end_sec) ? item.authored_end_sec : item?.end_sec;
  const start = item?.start_sec;
  if (num(start) && num(end) && end > start) return end - start;
  return num(item?.duration_sec) && item.duration_sec > 0 ? item.duration_sec : 0;
}

/* Where in the WHOLE Foray a click on the strip landed, in seconds, or null
   when the geometry cannot answer (no pointer coordinates, a strip with no
   width yet). Null is a real answer here, not a failure — the caller falls back
   to the segment that was hit, which is what the strip did before it could
   scrub.

   THE BARS ARE MEASURED, not assumed to tile the row evenly. This used to be a
   flat `frac * totalSec`, justified by a comment saying the gaps between the
   bars were "a fraction of a second". That was true of a uniform 2px gap and
   stopped being true with #128: a cross-episode seam is a wider break than a
   within-episode one and the seams fall where the EPISODES change, so the error
   no longer cancels along the row. Measured on `capital-types-1` at a 362px
   strip, separators are 20% of the width and a flat map lands up to 120 s from
   the pointer — far enough to be a different segment, in a control whose whole
   contract is "the position under the pointer is the position you get".

   So: find the bar the pointer is over and take the position INSIDE it. A click
   in a seam resolves to the boundary, which is the honest reading of a gap. */
function stripElapsedAt(e, r) {
  const strip = $("#fy-strip");
  if (!strip || typeof strip.getBoundingClientRect !== "function") return null;
  const x = e && typeof e.clientX === "number" ? e.clientX : null;
  return stripElapsedAtX(x, strip.getBoundingClientRect(), stripBarBoxes(strip), r);
}

/* The same question for a clientX and boxes the CALLER measured — at the click
   for a tap, or before the zoom for a held gesture (bindStripZoomScrub), whose
   release must not read the live rects: by then the zoom transform is being
   removed, and under reduced motion the strip is drawn un-zoomed while the
   finger is still in zoomed space (audit round 2, touch-1). One answer for
   both, so the two commits cannot drift. */
function stripElapsedAtX(x, rect, boxes, r) {
  if (x == null || !Number.isFinite(x) || !rect || !(rect.width > 0) || !r) return null;
  const measured = stripElapsedFromBoxes(boxes, x, rect, r);
  if (measured != null) return measured;
  if (!Number.isFinite(r.totalSec)) return null;
  const frac = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  return frac * r.totalSec;
}

/** The bars' boxes, or null when any bar cannot report one. */
function stripBarBoxes(strip) {
  const bars = strip && strip.children ? [...strip.children] : [];
  const boxes = [];
  for (const bar of bars) {
    if (typeof bar.getBoundingClientRect !== "function") return null;
    const box = bar.getBoundingClientRect();
    if (!box || !(box.width > 0)) return null;
    boxes.push(box);
  }
  return boxes;
}

/* The same question answered from the bars' own boxes, or null when they cannot
   answer it — a strip that has not been laid out, a bar count that disagrees
   with the queue, or a DOM whose elements do not report distinct geometry. Null
   rather than a confident wrong answer: the caller still has the flat map, which
   is approximate but never nonsense. */
function stripElapsedFromBoxes(boxes, x, rect, r) {
  const count = Array.isArray(r.playable) ? r.playable.length : -1;
  if (!boxes || boxes.length !== count || boxes.length === 0) return null;

  let spanned = 0;
  for (const box of boxes) spanned += box.width;
  // The bars have to actually TILE the row: each one starting at or after the
  // end of the last, and the whole set no wider than the strip. Anything else
  // is a DOM that is not laying out (or a stub reporting one box for every
  // element), and a per-bar answer read off it would be wrong with confidence.
  if (spanned > rect.width + 1) return null;
  for (let i = 1; i < boxes.length; i++) {
    if (boxes[i].left + 0.5 < boxes[i - 1].left + boxes[i - 1].width) return null;
  }

  let acc = 0;
  for (let i = 0; i < boxes.length; i++) {
    const len = segLenOf(r.playable[i]);
    if (x < boxes[i].left) return acc;                     // in the seam before it
    if (x <= boxes[i].left + boxes[i].width) {
      return acc + ((x - boxes[i].left) / boxes[i].width) * len;
    }
    acc += len;
  }
  return acc;                                               // past the last bar
}

/* The floating magnifier bubble itself (V2). ONE element for the whole page,
   built lazily on first use and reused across gestures/strips — a Foray page
   can be re-rendered mid-session (`paintForay`) and a bubble tied to a stale
   strip element would leak. Appended to `document.body` (not `#fy-strip` or
   `#foray-player`) because `position: fixed` coordinates are viewport-
   relative and a `transform: scale()` ancestor (the zooming strip itself)
   would otherwise warp them — the exact trap `zoomOriginPercent`'s own
   header calls out for the strip's own rect. */
let bubbleEls = null;

function bubbleDomEl(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function ensureBubbleEls() {
  if (bubbleEls) return bubbleEls;
  const bubble = bubbleDomEl("div", "fy-strip-bubble");
  bubble.hidden = true;
  const viewport = bubbleDomEl("div", "fy-strip-bubble__viewport");
  const marker = bubbleDomEl("div", "fy-strip-bubble__marker");
  bubble.append(viewport, marker);
  document.body.append(bubble);
  bubbleEls = { bubble, viewport };
  return bubbleEls;
}

/* Press-and-hold zoom-to-scrub on #fy-strip (V1 in-place zoom + V2 floating
   bubble).

   Joey, live iPhone testing: "a brief click just jumps ahead to that
   location; if I press and hold then there's a bubble view that pops up
   showing a zoomed-in portion of the timeline and the location of the
   scrubber/where I'm trying to jump to" — the iOS text-cursor-magnifier
   pattern. V1 shipped the in-place scaled strip; this also floats a small
   bubble ABOVE the touch point (never under the thumb) showing a genuinely
   magnified crop of the strip around it, tracking the finger as it drags.

   THE STATE MACHINE IS NOT HERE. player/strip-scrub-gesture.js decides tap
   vs hold vs drag as pure data, and now also the bubble's position/content-
   offset arithmetic (`bubblePosition`, `bubbleContentOffset`); this function
   only owns the real pointerdown/pointermove/pointerup listeners and the
   real setTimeout, and translates the module's state into DOM.

   THE SEEK IS THE CALLER'S, THROUGH `commit`. A plain tap still commits in
   `#fy-strip`'s `click` handler (bound just above this call site); a gesture
   that entered zoom commits HERE, on `pointerup`, through the same
   `commitStripSeek` the click handler uses — one implementation of "where did
   they drop it", two entry points. This file shipped believing a `click`
   follows every release; it does for a mouse, and WebKit and Chrome on
   Android both withhold it once a touch has moved past tap slop (and WebKit
   again once the touchmove below is cancelled), so on a phone the whole
   gesture — zoom, bubble, marker — ended in nothing (audit round 2, touch-1).
   The release position is read against the PRE-zoom rect and bar boxes,
   mapped through the origin the zoom was drawn with (`unzoomedX`), never
   from a rect measured at release — see `stripElapsedAtX`. A mouse does still
   deliver the click after a committed release, and `_seekCommitted` tells the
   click handler that one has been answered.

   `setPointerCapture` keeps events routed to the strip even though scaling
   moves it visually out from under the finger mid-gesture — without it a
   drag toward the zoomed edge would silently stop delivering pointermove. */
function bindStripZoomScrub(r, player, commit = null) {
  const strip = $("#fy-strip");
  const gest = player?.scrubGesture;
  if (!strip || !gest) return;

  let gesture = null;
  let holdTimer = null;
  let pointerId = null;
  let preZoomRect = null;
  let preZoomBoxes = null;
  let zoomOriginPct = null;

  const clearHoldTimer = () => {
    if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }
  };

  /* `preZoomRect` (and the bars' boxes with it) is captured once, before any
     zoom transform exists — re-measuring mid-zoom would feed the origin math a
     box already distorted by the previous frame's scale() (see
     zoomOriginPercent's own header). It is cleared on release so the next
     gesture measures fresh. */
  const measurePreZoom = () => {
    if (preZoomRect) return;
    preZoomRect = strip.getBoundingClientRect();
    preZoomBoxes = stripBarBoxes(strip);
  };
  const applyZoomVisual = (clientX) => {
    measurePreZoom();
    const pct = gest.originPercent(clientX, preZoomRect);
    if (pct == null) return;
    zoomOriginPct = pct;
    // CSSOM, not a style attribute — the page CSP is style-src 'self', same
    // rule segment-strip.js and paintSegFill already live under.
    strip.style.setProperty("--zoom-origin", `${pct}%`);
    strip.style.setProperty("--zoom-scale", String(gest.ZOOM_SCALE));
    strip.classList.add("is-zooming");
  };

  /* Where a zoomed release lands in the hour, from what was measured BEFORE
     the zoom. A bridge without `unzoomedX` (an older cached module) gets the
     finger's own x, which is what the mapping returns whenever the origin was
     anchored under the finger — every move re-anchors it there. */
  const zoomedElapsedAt = (clientX) => {
    if (!preZoomRect) return null;
    const x = typeof gest.unzoomedX === "function"
      ? gest.unzoomedX(clientX, preZoomRect, zoomOriginPct, gest.ZOOM_SCALE)
      : clientX;
    return stripElapsedAtX(x, preZoomRect, preZoomBoxes, r);
  };

  /* The bubble's cloned content is built ONCE per gesture, at the moment it
     first opens — not per-frame — because it is a snapshot of the strip's
     bars (fill widths included), not a live mirror; a gesture is at most a
     few seconds and the underlying Foray position does not repaint the
     strip during a hold (the pointer has captured input). Re-cloning every
     pointermove would be wasted DOM churn for no visible difference. */
  const openBubble = (clientX, clientY) => {
    measurePreZoom();
    const { bubble, viewport } = ensureBubbleEls();
    viewport.replaceChildren();
    const clone = strip.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.remove("is-zooming");
    clone.style.setProperty("width", `${preZoomRect.width}px`);
    clone.style.setProperty("height", `${preZoomRect.height}px`);
    clone.style.setProperty("transform-origin", "0 0");
    viewport.append(clone);
    bubble.hidden = false;
    updateBubble(clientX, clientY);
  };

  const updateBubble = (clientX, clientY) => {
    if (!preZoomRect || !bubbleEls || bubbleEls.bubble.hidden) return;
    const { bubble, viewport } = bubbleEls;
    const clone = viewport.firstElementChild;
    if (!clone) return;
    const viewportBox = { width: window.innerWidth, height: window.innerHeight };
    const pos = gest.bubblePosition(clientX, clientY, viewportBox);
    if (pos) {
      bubble.style.setProperty("width", `${pos.width}px`);
      bubble.style.setProperty("height", `${pos.height}px`);
      bubble.style.setProperty("left", `${pos.left}px`);
      bubble.style.setProperty("top", `${pos.top}px`);
    }
    const offset = gest.bubbleContentOffset(clientX, preZoomRect, gest.BUBBLE_WIDTH, gest.BUBBLE_SCALE);
    if (offset != null) {
      clone.style.setProperty(
        "transform",
        `translateX(${offset}px) scale(${gest.BUBBLE_SCALE})`,
      );
    }
  };

  const closeBubble = () => {
    if (!bubbleEls) return;
    bubbleEls.bubble.hidden = true;
    bubbleEls.viewport.replaceChildren();
  };

  const clearZoomVisual = () => {
    strip.classList.remove("is-zooming");
    strip.style.removeProperty("--zoom-origin");
    strip.style.removeProperty("--zoom-scale");
    preZoomRect = null;
    preZoomBoxes = null;
    zoomOriginPct = null;
    closeBubble();
  };

  const finish = () => {
    clearHoldTimer();
    gesture = gest.end(gesture);
    clearZoomVisual();
    pointerId = null;
  };

  strip.addEventListener("pointerdown", (e) => {
    // One gesture at a time; a second finger touching the strip mid-hold is
    // not a scrub, and letting it interrupt the first would jump the preview.
    if (pointerId != null) return;
    // Right/middle-click never means "press and hold" on desktop; only the
    // primary pointer starts a gesture.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    /* A new press is a new question: whatever the LAST gesture turned out to
       be must not swallow this one's click. (Reset here rather than in the
       click handler because a touch scroll that the browser takes over never
       produces a click at all, so a flag cleared only by a click would sit
       armed and eat the next genuine tap.) */
    strip._scrollGesture = false;
    strip._seekCommitted = false;
    pointerId = e.pointerId;
    gesture = gest.start(e.clientX, e.clientY);
    if (typeof strip.setPointerCapture === "function") {
      try { strip.setPointerCapture(pointerId); } catch { /* unsupported in some test DOMs; degrades to normal bubbling */ }
    }
    clearHoldTimer();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      gesture = gest.holdTimeout(gesture);
      if (gesture.zooming) { applyZoomVisual(e.clientX); openBubble(e.clientX, e.clientY); }
    }, gest.HOLD_MS);
  });

  strip.addEventListener("pointermove", (e) => {
    if (pointerId == null || e.pointerId !== pointerId || !gesture) return;
    const wasZooming = gesture.zooming;
    gesture = gest.move(gesture, e.clientX, e.clientY);
    /* The finger went mostly VERTICAL before a scrub began: the listener is
       scrolling the running order, not aiming at a second of the hour
       (audit 2026-09-22 — the sticky strip sits in the path of every scroll
       flick, and this used to end in a seek). Let go of the pointer so the
       page can have it, and arm the click handler to ignore the click a
       mouse release would still deliver. `touch-action: pan-y` in
       styles.css is what lets a touch flick actually scroll. */
    if (gesture.scrolled) {
      strip._scrollGesture = true;
      if (typeof strip.releasePointerCapture === "function") {
        try { strip.releasePointerCapture(pointerId); } catch { /* already released */ }
      }
      finish();
      return;
    }
    if (gesture.zooming) {
      // Entered zoom by dragging past tolerance rather than by waiting out
      // the hold timer — the timer would otherwise still fire later and flip
      // the visual back on (harmlessly, since holdTimeoutGesture is a no-op
      // once already zooming, but there is no reason to let it run).
      if (!wasZooming) clearHoldTimer();
      applyZoomVisual(e.clientX);
      if (!wasZooming) openBubble(e.clientX, e.clientY);
      else updateBubble(e.clientX, e.clientY);
    }
  });

  strip.addEventListener("pointerup", (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    /* Read BEFORE finish(): it clears the pre-zoom measurements. A gesture
       that never zoomed is a tap, and a tap's click commits it. */
    const at = gesture && gesture.zooming ? zoomedElapsedAt(e.clientX) : null;
    finish();
    if (at == null) return;
    strip._seekCommitted = true;
    if (typeof commit === "function") commit(at);
  });
  strip.addEventListener("pointercancel", (e) => {
    if (pointerId == null || e.pointerId !== pointerId) return;
    finish();
  });
  /* A ZOOMED SCRUB KEEPS THE FINGER (review 2026-09-23). `touch-action: pan-y`
     is read once, at pointerdown, so the browser owns every vertical pan even
     after the hold has entered zoom: a thumb that drifted down or diagonally
     before moving sideways started a page scroll, the browser fired
     pointercancel, and `finish()` dropped the zoom and the bubble with no seek.
     Cancelling the touchmove while zoomed is the one way `pan-y` still allows
     to keep the page still. NON-passive, or the browser ignores the cancel.
     A still-pending gesture is left alone, so a flick still scrolls. */
  strip.addEventListener("touchmove", (e) => {
    if (gesture && gesture.zooming && e.cancelable !== false && typeof e.preventDefault === "function") e.preventDefault();
  }, { passive: false });
}

/* The fill inside the bar the listener is currently inside — the one thing on
   this page that has to move continuously, and the reason it is painted above
   `paintForay`'s segment-change guard.

   It also makes the seam beat visible: for the 0.5 s between two segments the
   fill sits still at a boundary, so the pause you hear is a pause you can see.

   Which bar to fill comes from the CLOCK, not from the caller's index: the two
   agree (`forayPosition()` reports a segment's start until that segment is the
   one actually loaded), and deriving it from the same `segmentAtElapsed` the
   scrubber uses is what stops the bar and the click destination from drifting
   apart. `started` is only a gate — with nothing played and nothing stored,
   every bar stays empty rather than filling the first one to 0%.

   Widths are DOM properties, never style attributes (CSP `style-src 'self'`). */
function paintSegFill(started, elapsedSec) {
  const strip = $("#fy-strip");
  const player = window.ForayPlayer;
  if (!strip || !state.foray || !started) return;
  if (typeof player?.segmentAt !== "function") return;
  const at = player.segmentAt(state.foray.playable, elapsedSec);
  if (!at) return;
  const fill = fillOf(strip, at.index);
  if (!fill) return;
  const len = segLenOf(state.foray.playable[at.index]);
  const pct = len > 0 ? Math.max(0, Math.min(100, (at.into / len) * 100)) : 0;
  fill.style.width = `${pct}%`;
}

function fillOf(strip, i) {
  const seg = strip.children ? strip.children[i] : null;
  return seg && seg.children ? seg.children[0] : null;
}

const FORAY_IDLE = { index: -1, playing: false, ended: false, elapsedSec: 0 };

/* THE TWO THINGS A FAILED START MAY SAY, and there are only two because only
   two can be acted on.

   Autoplay refusal is not a fault. The browser is holding audio back until it is
   certain a person asked for it, which is a rule we live under rather than a bug
   — so it gets a plain instruction and the play button beneath it is the
   affordance, never a red line about an error. Everything else is a segment that
   did not arrive, where the connection is the first thing to check.

   Matched on the player's telemetry STRING rather than a structured field on
   purpose: app.js and player/client.js are cached and refreshed independently by
   the service worker (see the note in `renderForay`), so this page is regularly
   paired with a module of a different vintage. `NotAllowedError` is a DOM
   exception name — it is stable in both directions across that skew. */
/* WORDED FOR BOTH HOMES OF THIS FILE (audit 2026-09-22, qa row 141). The same
   bytes run in a browser tab and inside the Capacitor shell, where there is no
   visible browser and no reload button, so "your browser" and "reload the page"
   were instructions a phone listener could not follow. */
const FY_AUTOPLAY_HINT = "4a couldn't start the audio on its own — press play again and it will start.";
const FY_START_FAILED = "That clip couldn't load. Check the connection, then press play.";
/* A control that threw while the Foray was already running is a third thing, and
   it must not claim a segment failed to load: nothing did, the audio is still
   going, and the honest report is that the button did not take. */
const FY_TAP_FAILED = "That didn't register. Try it again, or restart 4a if it keeps happening.";

const FY_VOICE_FALLBACK = "Your chosen voice isn't installed; using the best available.";

function forayFailureCopy(signal) {
  return /NotAllowedError/.test(String(signal ?? "")) ? FY_AUTOPLAY_HINT : FY_START_FAILED;
}

/** Say it on the page. `signal` is whatever evidence there is — the player's own
    error line, or a caught exception — and null clears the line. */
function paintForayFailure(signal) {
  const copy = signal ? forayFailureCopy(signal) : "";
  // A browser being careful about audio is not an error, and must not be dressed
  // as one. styles.css tones `.is-hint` down to a note.
  paintForayNotice(copy, copy === FY_AUTOPLAY_HINT);
}

/** The one writer of the Foray page's notice line. It is a live region, so an
    unchanged message is not written again — see setStatusText. */
function paintForayNotice(text, hint) {
  const err = $("#fy-error");
  if (!err) return;
  err.hidden = !text;
  setStatusText(err, text);
  err.classList.toggle("is-hint", Boolean(text) && Boolean(hint));
}

/* Every tap on this page's transport goes through one of these two (#225).

   The click handlers are `async`, so a call that threw became an unhandled
   promise rejection: a console line, and a page that did not move a pixel. On a
   phone there is no console, which makes that outcome indistinguishable from a
   dead app — the founder's report was "starting it was difficult, not sure why".

   THEY DIFFER IN WHAT THEY MAY ASSUME, which is why they are two functions.
   A start that threw got nowhere, so the "this Foray is live" flag that the
   intent-paint set is a lie and has to go, or the next press of the main button
   means pause instead of another attempt. A control that threw while the Foray
   was ALREADY running is the opposite: the audio is still going, the player's own
   state is still the truth, and clearing the page's flags would leave a button
   labelled "Pause" that means "start" — the very confusion this issue is about.
   That one says so and touches nothing; the next tick owns the state. */
/* The record's copy of a failed tap (#225), and the only evidence that outlives
   the message on screen.

   A console line is not evidence on a phone — that is the whole reason #225 was
   reported as "several errors" with no error in it. `cp_diag` already holds the
   browser's side of a refusal (`play.rejected` becomes a `stop/autoplay` entry);
   this is the page's side, the exception that actually came back out of
   `playForay`, which nothing else in the record can see.

   WRAPPED, AND THE WRAP IS THE POINT. This runs inside the two guards that are
   this page's last defence against an unhandled rejection. A diagnostic that
   threw here would take the on-screen message down with it and restore the exact
   failure mode the issue is about: a tap that does nothing and says nothing.
   `record()` and `save()` are both written never to throw — but the function on
   `window` comes from a module the service worker refreshes independently of this
   file (see the vintage note in `renderForay`), so "never throws" is a property
   of a version, not of this call. Checked, and caught anyway.

   THE NAME, NEVER THE MESSAGE. `err.message` carries URLs and prose, and this
   record is built to be pasted into an issue. `player/diagnostic-log.js` drops
   anything that is not a bare identifier, so a message would be discarded there
   regardless; sending only the name means the rule is visible on both sides. */
function noteTapFailure(phase, err) {
  /* READ THE NAME IN ITS OWN GUARD. `err` is whatever was thrown, and reading a
     property off it can itself throw — a Proxy, a getter, an object from another
     realm. Folded into the guard below, a failure here would skip the write
     entirely, so the one error too strange to describe would also be the one that
     left no trace. `null` is a worse answer than `TypeError` and a far better one
     than silence. */
  let name = null;
  try { name = err?.name ?? null; } catch (_) { name = null; }
  try {
    if (typeof window.forayNoteTapFailure === "function") {
      window.forayNoteTapFailure(phase, name);
    }
  } catch (_) {
    /* A record that will not write is not a reason to lose the line on screen. */
  }
}

async function guardForayStart(run) {
  try {
    return await run();
  } catch (err) {
    console.warn("[foray] start failed", err);
    state.forayPlaying = null;
    state.forayPainted = null;
    /* THE PAINT FIRST AND THE RECORD LAST, but the record lands either way.

       The order: the bridge comes from a module the service worker refreshes
       independently of this file, which is why it is wrapped at all. A `try`
       covers a throw and not a slow synchronous write, and every statement
       between the catch and the paint is one that can stand between a listener
       and the only thing on screen telling them what happened. #225 is a
       listener-facing bug, so the listener is served first.

       The `finally`: the argument to `paintForayFailure` is built before the call,
       and `String(err)` and both template reads throw on an exotic or hostile
       `err` — the same hazard `diagnostic-log.js`'s `asText` exists for. Without
       the `finally`, moving the record after the paint would mean that a failure
       to paint costs the record too, in exactly the case the evidence matters
       most: the surface did not appear, which IS this issue's literal symptom.

       And the signal is built in its own guard first, because that argument is
       evaluated BEFORE the call: `String(err)` and both template reads throw on a
       hostile `err`, and an exception raised here would escape this catch block
       and become the unhandled rejection the whole guard exists to prevent.
       "Error" is a poor description and it still reaches the listener as the
       ordinary load-failure line, which is the honest fallback — something failed
       and pressing play again is the thing to do. */
    let signal = "Error";
    try {
      signal = err?.name ? `${err.name}: ${err.message ?? ""}` : String(err);
    } catch (_) { /* an error too strange to describe is still an error */ }
    try {
      paintForayFailure(signal);
    } finally {
      noteTapFailure("start", err);
    }
    return null;
  }
}

async function guardForayTap(run) {
  try {
    return await run();
  } catch (err) {
    console.warn("[foray] control failed", err);
    paintForayNotice(FY_TAP_FAILED, false);
    // Last, for the reason given in `guardForayStart` above.
    noteTapFailure("control", err);
    return null;
  }
}

/** The ↺ / ↻ step sizes, from the player bridge so the Foray page, the Now
    Playing sheet and the mini bar name one number; the fallback is the same
    pair player/media-session.js exports, for a page paired with an older
    cached module. */
function forayNudgeSteps(player) {
  try {
    const s = player && typeof player.nudgeSteps === "function" ? player.nudgeSteps() : null;
    if (s && Number.isFinite(s.back) && Number.isFinite(s.fwd)) return { back: s.back, fwd: s.fwd };
  } catch (_) { /* fall through to the documented pair */ }
  return { back: 15, fwd: 30 };
}

function bindForayTransport(r, player) {
  const onChange = (s) => paintForay(s);
  const nudge = forayNudgeSteps(player);

  /* The discover pool is the only document we have that carries per-show
     artwork, and a lock screen wants a picture (#27). Passed from here rather
     than resolved inside the player because app.js is the side that owns the
     fetch; its absence costs the OS the publisher’s square and nothing else.
     Spread into all three entry points below so a new one cannot forget it. */
  const forayOpts = { onChange, discoverDoc: state.discover };

  /* Both funnels are a `guardForayStart`, and the call into the player is the
     FIRST thing inside it — no await, no lookup, nothing between the tap and
     `playForay`. Safari only lets audio start inside the gesture that asked for
     it, and the gesture is spent by the first thing that waits (#225). Clearing
     the failure line is cleared in the same breath, because the message from the
     last attempt is not evidence about this one — inside the guard, so even that
     cannot become the unhandled rejection this whole thing is about. */
  const start = (index) => guardForayStart(() => (paintForayFailure(null), player.playForay(r, { startIndex: index, ...forayOpts })));
  const startAt = (elapsedSec) => guardForayStart(() => (paintForayFailure(null), player.playForay(r, { startElapsedSec: elapsedSec, ...forayOpts })));
  /* The main button, pressed cold. With a stored position that means RESUME —
     the whole point of the feature — and an explicit index (a row, the strip)
     always wins, because the listener just named a segment. */
  /* FROM `state.forayResume`, NOT THE BIND-TIME `resume` (audit round 3,
     app-3-1). The closure was the point captured when the page rendered, so
     after play -> advance -> close the bar, Play restarted from that old point
     (or 0) and the player's next save overwrote the real one. paintForay
     re-reads the stored point when this Foray goes from live to cold. */
  const startOrResume = () => state.forayResume ? startAt(state.forayResume.elapsedSec) : start(0);

  /* Playback speed (#242, popup menu #349). Bound BEFORE the "nothing playable"
     bail-out below and labelled from the stored value, because neither depends
     on this Foray: the speed is global (one `cp_rate` for the app — a speed is
     a fact about the listener, not about the audio), it is settable before
     anything has started, and a Foray with no playable segments still leaves a
     listener who may want to set it for the next one. `paintForay` relabels it
     on every tick from the snapshot, so a change made in the mini-player's
     sheet shows up here too **while a Foray is live** — `notifyForay` has
     nothing to notify when the player is on a single episode, so in that one
     case this button keeps its label until the page is rendered again. Stated
     rather than fixed: the value itself is always right (it lives in
     `cp_rate`, which both controls read), the stale thing is a label on a page
     whose Foray is not the thing playing, and a rate-only broadcast channel is
     more machinery than that is worth.

     THE BUTTON USED TO CYCLE ON TAP — one press silently jumped straight to
     the next stop, with no way to see the other five without repeated taps or
     to tell where "next" would land. Every major podcast app (Apple, Spotify,
     Overcast, Pocket Casts) opens a menu naming every stop instead. Tapping
     `#fy-rate` now opens that menu; nothing changes until a stop is tapped. */
  const rateBtn = $("#fy-rate");
  if (rateBtn && typeof player.rateStops === "function" && typeof player.setPlaybackRate === "function") {
    paintRateButton(player, player.playbackRate());
    rateBtn.addEventListener("click", () => guardForayTap(() => {
      openRateMenu(player, (rate) => paintRateButton(player, rate));
    }));
  }

  // Nothing playable is not a disabled-looking button that still fires: say it
  // with the control's own state, so the page and the behaviour agree. (The ambient page replaces the
  // main button with "Find similar" then, so there may be nothing here to disable.)
  if (!r.playable.length) {
    ["#fy-play", "#fy-next", "#fy-prev", "#fy-back", "#fy-fwd"].forEach(sel => { const el = $(sel); if (el) el.disabled = true; });
    setControlLabel($("#fy-play"), "Nothing to play", null);
    return;
  }

  $("#fy-play").addEventListener("click", async () => {
    if (playerHasForay(r)) return guardForayTap(() => player.forayToggle());
    // Only the real start is an event. Logging a pause as a play is the kind of
    // small lie that makes a metric useless six months later.
    logEvent("foray_play", {
      foray_id: r.id, segments: r.playable.length,
      resumed_from_sec: state.forayResume ? Math.round(state.forayResume.elapsedSec) : null,
    });
    await startOrResume();
  });
  // Before anything has started, every transport button means "start it" — a
  // next that begins at segment 2 silently drops the opening of the Foray.
  $("#fy-next")?.addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.forayNext()) : startOrResume());
  $("#fy-prev")?.addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.forayPrevious()) : startOrResume());
  /* The nudges seek on the Foray's clock (`player.nudge`, the same function the
     sheet's ↺15 / 30↻ and the mini bar's ↺15 call); before anything has
     started they start it, like every other transport button here. */
  $("#fy-back")?.addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.nudge(-nudge.back)) : startOrResume());
  $("#fy-fwd")?.addEventListener("click", () => playerHasForay(r) ? guardForayTap(() => player.nudge(nudge.fwd)) : startOrResume());

  $("#view").querySelectorAll("[data-fy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const index = Number(btn.dataset.fy);
      if (playerHasForay(r)) await guardForayTap(() => player.forayJump(index));
      else await start(index);
    });
  });

  /* The strip is a scrubber, not 32 buttons.

     It looked like a scrubber from the day it shipped — a proportional bar of
     the whole hour — and behaved like a row of jump targets, snapping to the
     head of whichever segment you hit. Thirty-two minutes in, "back a bit" is
     the gesture people make, and there was no way to make it: `foraySeek` was
     implemented and tested in player/client.js and nothing on the page called
     it. Now the position under the pointer is the position you get, cold or
     playing, using the same `startElapsedSec` path the resume banner uses.

     The exact-segment jump did not go away — it is the running-order rows,
     which are also the keyboard-reachable half of this control. */
  /* ONE COMMIT for the strip: a tap's click and a zoomed gesture's release
     (bindStripZoomScrub, on pointerup) both land here. */
  const commitStripSeek = (at) => (playerHasForay(r) ? guardForayTap(() => player.foraySeek(at)) : startAt(at));
  $("#fy-strip").addEventListener("click", async (e) => {
    /* A gesture bindStripZoomScrub read as a SCROLL (mostly vertical, before
       any scrub began) is not a position in the hour. Without this, the click
       a release delivers seeked to wherever the finger happened to stop. */
    if (e.currentTarget && e.currentTarget._scrollGesture) {
      e.currentTarget._scrollGesture = false;
      return;
    }
    /* A zoomed gesture was committed on its release; the click a MOUSE still
       delivers after it must not seek a second time (a touch sends none). */
    if (e.currentTarget && e.currentTarget._seekCommitted) {
      e.currentTarget._seekCommitted = false;
      return;
    }
    /* Position FIRST, and only then look for a bar. The strip is 32 bars with a
       2px gap between each, which is roughly a fifth of its width — requiring a
       `[data-seg]` hit before reading the coordinate made every one of those
       gaps a dead zone, and "a click anywhere on it is a position in the hour"
       has to be true or the control is lying. */
    const at = stripElapsedAt(e, r);
    if (at != null) return commitStripSeek(at);
    // No coordinate to work from (a synthetic or assistive click). Fall back to
    // the bar that was hit, which is what the strip did before it could scrub.
    const seg = e.target.closest("[data-seg]");
    if (!seg) return;
    const index = Number(seg.dataset.seg);
    return playerHasForay(r) ? guardForayTap(() => player.forayJump(index)) : start(index);
  });

  bindStripZoomScrub(r, player, commitStripSeek);

  /* Re-entering the page mid-Foray must paint the segment that is actually
     audible, and route this page's callback at the live player — otherwise the
     old, detached DOM keeps getting the updates and this one never moves.

     With nothing live, the page opens on the STORED position rather than at
     zero: the clock reads where they left off and the rows behind it are already
     ticked. A resume offer that leaves the page looking untouched is a resume
     offer nobody believes. */
  const live = player.watchForay(onChange);
  paintForay(live && live.forayId === r.id ? live : FORAY_IDLE);
}

/** Is the player already inside THIS Foray? Pressing play on a Foray that is
    already loaded must resume it, not rebuild the queue from segment 1. */
function playerHasForay(r) {
  return Boolean(state.forayPlaying === r.id);
}

/** The speed button's visible label AND its accessible name, both from the
    bridge (#242). `aria-label` on a button REPLACES its text, so a screen reader
    is told only what this sets — which is why the value has to be in it. Written
    in one place rather than at each of the three call sites so a relabel cannot
    update one and forget the other. */
function paintRateButton(player, rate) {
  const btn = $("#fy-rate");
  /* BOTH label functions, for the same module-skew reason the binder checks both
     of its own. The bind-time call is NOT inside `guardForayTap`, so a module
     vintage carrying `rateLabel` but not `rateAriaLabel` would throw during
     `renderForay` — a blank page, from a missing accessible name. */
  if (!btn || typeof player?.rateLabel !== "function" || typeof player?.rateAriaLabel !== "function") return;
  const label = player.rateLabel(rate);
  const aria = player.rateAriaLabel(rate);
  /* The memo checks BOTH, and the second half is not symmetry — it is a bug this
     had. `paintForay` runs at 4 Hz for a value that changes once an hour, so the
     early return is worth having; but the markup ships `1×` as the button's text,
     so on the ordinary first bind at normal speed the label already MATCHED and the
     `aria-label` was never written. The button then kept the markup's bare
     "Playback speed", and a screen-reader user was told what the control does and
     never what it is set to — for every listener who had not changed the speed,
     which is most of them. */
  if (btn.textContent === label && btn.getAttribute("aria-label") === aria) return;
  setControlLabel(btn, label, aria);
}

/** The speed picker (#349): a modal listing every stop on the ladder, tap one
    to set it, tap outside or Cancel to leave the current speed alone. Same
    fy-sheet/fy-scrim/fy-panel skeleton as the intro popup and the down-vote
    sheet — one modal pattern for the whole app, not a third one-off.

    Built and torn down on open/close rather than kept in the markup, same
    choice showIntroPopupOnce made: this menu is opened rarely (compared to
    the 4 Hz paintForay tick) and its content (which stop is "current") is
    stale the instant it is left mounted across a rate change made elsewhere,
    so there is nothing to gain from keeping it around between opens. */
function openRateMenu(player, onChange) {
  if (typeof player.rateStops !== "function") return;
  const stops = player.rateStops();
  const current = typeof player.playbackRate === "function" ? player.playbackRate() : null;

  const wrap = ddEl("div", "fy-sheet");
  wrap.id = "rate-sheet";

  const scrim = ddEl("div", "fy-scrim");
  const panel = ddEl("div", "fy-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const grab = ddEl("div", "fy-grab");
  grab.setAttribute("aria-hidden", "true");

  const title = ddEl("h3", null, "Playback speed");
  title.id = "rate-sheet-title";
  panel.setAttribute("aria-labelledby", "rate-sheet-title");

  const list = ddEl("div", "rate-options");
  for (const stop of stops) {
    const isCurrent = stop === current;
    const opt = ddEl("button", "rate-option" + (isCurrent ? " on" : ""),
      typeof player.rateLabel === "function" ? player.rateLabel(stop) : `${stop}×`);
    opt.type = "button";
    if (isCurrent) opt.setAttribute("aria-current", "true");
    opt.addEventListener("click", () => {
      const applied = player.setPlaybackRate(stop);
      onChange(applied);
      close();
    });
    list.append(opt);
  }

  const actions = ddEl("div", "fy-sheet-actions");
  const cancel = ddEl("button", "fy-sheet-cancel", "Cancel");
  cancel.type = "button";
  actions.append(cancel);

  panel.append(grab, title, list, actions);
  wrap.append(scrim, panel);

  /* ONE INSTANCE (audit 2026-09-22): this menu is built fresh on every open
     with a fixed id, and nothing stopped a second activation (a repeated
     Enter, key-repeat) mounting a second `#rate-sheet` over the first — two
     modals, duplicate ids, and one Cancel taking the scroll lock off with a
     sheet still up. openSheet() replaces an open sheet with the same id
     rather than stacking on it, the way the mini player's own picker always
     did (`closeRatePicker()` first). */
  const close = () => closeSheet(wrap, { removeIfOwned: true });
  openSheet(wrap, { panel, onRequestClose: close });
  scrim.addEventListener("click", close);
  cancel.addEventListener("click", close);
}

/** The only thing that changes 4x a second. Deliberately not a re-render: the
    running order is 32 rows and rebuilding it would fight the scroll position
    and drop focus. */
/** Which Foray the page last painted LIVE (app-3-1), so a cold tick can tell
    "just stopped" from "never started". Reset by every renderForay. */
let forayPaintedLive = null;

/** Re-read this Foray's stored resume point into `state.forayResume` and repaint
    the banner's words from it (app-3-1). A finished Foray has no resume point. */
function refreshForayResume() {
  const r = state.foray;
  const player = window.ForayPlayer;
  if (!r || !player || typeof player.forayResume !== "function") return;
  let point = null;
  try {
    point = player.forayResume(r.id, { totalSec: r.totalSec, itemCount: (r.playable || []).length, resolved: r, includeFinished: true });
  } catch (_) { point = null; }
  state.forayResume = point && !point.finished ? point : null;
  /* PLAYED TO THE END, THEN CLOSED (round-3 review, L2): the point reads finished and `forayResume` goes
     null. The main button then says "Play again" (paintForay reads `forayPlayed`) and starts from the top. */
  state.forayPlayed = Boolean(point && point.finished);
}

/** The main button's words, from the page's states, and the name it speaks. One function for the first
    paint (renderForay) and every tick (paintForay), so they cannot word a state two ways. "Resume" carries
    what is left, with a middle dot, never a comma ("Resume · 18 min left"); a Foray played to the end, or
    one that just ended, offers "Play again". The name starts with the visible words (label in name), so a
    voice-control "Resume" still matches. */
function forayPrimaryLabel({ running = false, loading = false, ended = false, started = false, finished = false, left = "" } = {}) {
  if (running) return ["Pause", "Pause"];
  if (loading) return ["Loading…", "Loading, please wait"];
  if (ended || finished) return ["Play again", "Play again"];
  if (started) return left ? [`Resume · ${left}`, `Resume, ${left}`] : ["Resume", "Resume"];
  return ["Play", "Play"];
}

/** What is left of a live Foray, worded the way its resume point words it: "18 min left", "about 18 min
    left" when part of the runtime is an estimate. "" under a minute (the button then says only "Resume"). */
function forayLeftLabel(r, elapsedSec) {
  const player = window.ForayPlayer;
  const remaining = (r?.totalSec || 0) - (elapsedSec || 0);
  if (!(remaining >= 60) || typeof player?.fmtSpan !== "function") return "";
  return `${r.estimated ? "about " : ""}${player.fmtSpan(remaining)} left`;
}

function paintForay(s) {
  if (!state.foray) return;
  /* SOMEBODY ELSE'S FORAY IS NOT THIS PAGE'S NEWS. `watchForay` points the live
     player's callback at whichever page rendered last, so with Foray A playing in
     the mini bar, opening Foray B's page (the home rail does exactly this) fed
     A's ticks into B's paint: B's button read "Pause" and pressing it paused A.
     The first paint has always been gated this way — `renderForay` compares
     `live.forayId === r.id` — and the ticks after it were not. `FORAY_IDLE`
     carries no id and must still get through: it is this page saying "nothing". */
  if (s.forayId && s.forayId !== state.foray.id) return;
  /* A START THAT FAILED IS NOT A LIVE FORAY (#225).

     `playForay` paints its intent before it awaits the load — deliberately, so a
     tapped row lights up immediately — which means an index arrives on this page
     a moment BEFORE the audio is known to exist. When the load or the play is
     then refused, that index was the only thing standing, and everything below
     read it as "playing": the resume banner hid itself, the button relabelled,
     and `state.forayPlaying` made the next press of the main button mean PAUSE
     rather than a retry. Two controls that had meant the same thing now meant
     different things, with nothing on screen to say why — which is the whole of
     the founder's report.

     An error with nothing playing, nothing loading and no beat running is a
     failed start, and the page goes back to being cold with a line that says so. */
  const failed = Boolean(s.error) && !s.playing && !s.loading && !s.gap;
  const live = s.index >= 0 && !failed;
  state.forayPlaying = live ? state.foray.id : null;
  /* LIVE -> COLD RE-READS THE STORED POINT (audit round 3, app-3-1). The resume
     point was read once, at render; after the listener played on and closed
     the bar, the cold page (clock, banner, and the Play the next press runs)
     fell back to that stale point, or to 0. */
  if (live) forayPaintedLive = state.foray.id;
  else if (forayPaintedLive === state.foray.id) {
    forayPaintedLive = null;
    refreshForayResume();
  }

  /* Nothing loaded — cold, or the mini bar was just closed. Fall back to the
     stored resume point rather than repainting the page as untouched: the
     banner above still says "Jump back in at 23:14" and the button still
     resumes there, so a clock reading 0:00 underneath it would be the page
     contradicting itself. */
  const resume = live ? null : state.forayResume;
  /* THE COLD CLOCK IS THE STORED POINT, AND ONLY THAT — the same expression the
     main button starts from, so the two cannot disagree.

     It used to read `s.elapsedSec` first, which is right while something is live
     and wrong the moment a start fails: `forayPosition()` answers with the failed
     segment's own start, so a refused jump to segment 20 left the clock reading
     37:31 over a button that goes to 19:40. A phantom position is worse than a
     stale one, because the listener can act on it. */
  const elapsed = live ? (s.elapsedSec || 0) : (resume?.elapsedSec || 0);

  const now = $("#fy-now");
  if (now && window.ForayPlayer) now.textContent = window.ForayPlayer.fmtClock(elapsed);

  /* Everything before this index is behind the listener. While something is
     playing that is the live segment; before anything has started it is the
     stored resume point, so a page opened cold shows the hour already half
     ticked off instead of pretending it was never touched. */
  const mark = live ? s.index : (resume?.index ?? -1);
  paintSegFill(mark >= 0, elapsed);

  const playBtn = $("#fy-play");
  if (playBtn) {
    // Three different "not playing" states, and they mean different things:
    // paused mid-segment, never started but with a stored position, and cold.
    //
    // A seam beat is a FOURTH, and it reads as playing: the Foray is running,
    // it is between two segments on purpose, and the button has to mean "stop"
    // for the half second the silence lasts. Labelling that half second
    // "Loading…" would be the app apologising for its own edit.
    //
    // `s.running` FIRST (audit 2026-09-22): it is the player's
    // `transportIsRunning()`, the same answer `forayToggle` decides the press
    // by. `playing || gap` is the belief alone, and in the #689 drift it said
    // "▶ Resume" over sound while the press paused. The fallback is for a
    // player module of an older vintage, which sends no `running`.
    //
    // A FINISHED Foray is a fifth state, not a paused one: there is nothing to
    // resume, the lock screen has already dropped its transport, and the press
    // starts it from the top (`setRunning`'s ended branch in player/client.js).
    const running = typeof s.running === "boolean" ? s.running : (s.playing || s.gap);
    const started = live || elapsed > 0;
    //
    // FIVE states, and the accessible name has all of them: it used to have
    // two, so the button read "Loading…" and announced "Play" — hiding the one
    // moment the app is asking the listener to wait — and a voice-control user
    // saying "Resume" matched nothing. The words are forayPrimaryLabel's.
    const left = live ? forayLeftLabel(state.foray, elapsed) : (state.forayResume ? state.forayResume.label : "");
    const [text, name] = forayPrimaryLabel({
      running, loading: Boolean(s.loading), ended: Boolean(s.ended), started,
      finished: !live && Boolean(state.forayPlayed), left,
    });
    setControlLabel(playBtn, text, name);
  }
  // The beat, for CSS: the strip holds still at a boundary for 0.5 s and this
  // is how a stylesheet can say so without the page inventing new copy.
  $("#fy-strip")?.classList.toggle("is-seam", Boolean(s.gap));
  /* Whether anybody is IN this Foray, for CSS. Without it the strip has no way
     to tell "nobody has started" from "every segment is still ahead of you",
     and the browsing state — the shape of the Foray, every bar at full
     opacity — would render as a strip dimmed to 0.28 from end to end. `mark` is the same
     index the row highlights use, so the strip and the running order agree
     about whether the listener is anywhere. */
  $("#fy-strip")?.classList.toggle("has-position", mark >= 0);

  /* The speed, relabelled from the snapshot (#242), so a change made in the
     mini-player's Now Playing sheet reaches this button too — there is one speed
     and two controls, and a stale label on either is the app disagreeing with
     itself about a value the listener just set.

     GUARDED, and the guard is the whole of it. app.js and the ES module are cached
     and refreshed independently by the service worker (see the note in
     `renderForay`), so this page is regularly paired with a module of a different
     vintage; an older one sends no `rate`, and `FORAY_IDLE` carries none either for
     the same reason it carries no id. Painting anyway would put "1×" on the button
     — `rateLabel` normalises `undefined` to normal speed — and silently contradict
     a listener who is at 1.5x. Skipping leaves the label it was bound with, which
     is still right, because the value lives in `cp_rate` rather than in the tick.

     A first draft also fell back to `window.ForayPlayer?.playbackRate?.()` here.
     That was dead code and a mutation test proved it: an older module has no
     `playbackRate` either, so the fallback is `undefined` in the one case it was
     written for, and removing it changed no test. */
  if (s.rate != null) paintRateButton(window.ForayPlayer, s.rate);

  // The player's own words are telemetry, not copy. Say the one thing a
  // listener can act on, and keep the detail in the console.
  /* V-01's live-narration notice shares the line: shown only when there is no
     real error claiming it — a load failure is the more urgent message, and
     this one is informational ("still working, just not with the exact voice
     you picked"). Checked here, ahead of the `forayPainted` gate below, because
     it has to show up (and clear) on the FIRST tick.

     ONE WRITE PER TICK, AND ONLY A CHANGE IS A WRITE (audit 2026-09-22, qa row
     66). `#fy-error` is an aria-live region and this runs at 4 Hz. It used to
     be two writes a tick — `paintForayFailure(null)` cleared the line, then
     the hint block wrote it back — so a screen reader re-announced the hint
     four times a second for as long as the Foray played, while a comment here
     claimed it was "painted only once per fallback". Now the line's one
     message is decided first and `paintForayNotice` skips an unchanged one. */
  if (s.error) paintForayFailure(s.error);
  else if (s.voiceFallback) paintForayNotice(FY_VOICE_FALLBACK, true);
  else paintForayFailure(null);

  /* The row and strip classes only change when the segment does, and this runs
     on every position tick. Guard it: 32 rows x 4 Hz of class churn for a value
     that changes once a minute is work nobody asked for.

     Keyed on the LIVE index, not the raw one: a start that failed at segment 12
     has to clear the highlight it painted a moment ago, and keying on `s.index`
     — which does not change when the load fails — would skip that repaint and
     leave a row lit under a message saying nothing is playing. */
  const liveIndex = live ? s.index : -1;
  if (state.forayPainted === liveIndex) return;
  state.forayPainted = liveIndex;

  $("#view").querySelectorAll("[data-fy]").forEach(row => {
    const i = Number(row.dataset.fy);
    const playing = i === liveIndex;
    const played = mark >= 0 && i < mark;
    row.classList.toggle("is-playing", playing);
    row.classList.toggle("is-played", played);
    if (playing) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
    if (row.dataset.fyName) {
      setControlLabel(row, null, forayJumpLabel(row.dataset.fyName, playing ? "playing" : played ? "played" : ""));
    }
  });
  const strip = $("#fy-strip");
  if (strip) {
    [...strip.children].forEach((seg, i) => {
      seg.classList.toggle("is-playing", i === liveIndex);
      /* WHERE THE LISTENER IS, which is not the same claim as "audio is
         running" and comes apart on a cold load: `mark` is then the STORED
         position and `liveIndex` is -1. The strip dims everything that is
         neither played nor here, and the fill inside a bar is only shown on the
         bar the listener is in, so without this the resume point rendered as a
         dim empty bar under a banner offering to jump back into it. */
      seg.classList.toggle("is-here", i === mark);
      seg.classList.toggle("is-played", mark >= 0 && i < mark);
      // A bar the listener has passed is full; one they have not reached is
      // empty. The bar they are INSIDE is left alone — paintSegFill already
      // set it this same tick, and clobbering it here would drop the fill to
      // zero for a quarter of a second at every segment change.
      if (mark >= 0 && i !== mark) {
        const fill = fillOf(strip, i);
        if (fill) fill.style.width = i < mark ? "100%" : "0%";
      }
    });
  }
}
