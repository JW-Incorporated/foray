/* ui/mini.js — Dial mini-player presentation.
 *
 * Playback remains owned by player/client.js. This file only arranges the
 * player-owned nodes into the Tactile mini: one body button (art + copy) and
 * two sibling keycaps, Play then +30 (BUILD-NOTES 3.12, the prototype's
 * order), the 3px band line along the top edge, and the swipe-down dismiss.
 * Listener data reaches markup only through tactileBand() (esc() inside) and
 * textContent.
 */

function dialMiniIcon(id) {
  return typeof tactileIcon === "function" ? tactileIcon(id) : "";
}

function dialDecorateMiniPlayer(parts) {
  if (!parts || !parts.root || !parts.bar || !parts.info) return;
  parts.root.classList.add("dial-mini");
  parts.root.setAttribute("role", "region");
  parts.bar.classList.add("mini");
  parts.info.classList.add("mini__body");
  parts.title.classList.add("mini__title");
  parts.show.classList.add("mini__show");
  parts.art.classList.add("mini__art");
  parts.art.setAttribute("width", "44");
  parts.art.setAttribute("height", "44");
  parts.art.setAttribute("decoding", "async");
  parts.info.insertBefore(parts.art, parts.info.firstChild);

  parts.playBtn.className = "fp-play keycap keycap--md keycap--persimmon keycap--round";
  /* The bar's nudge stays BACK 15 (transport-controls' ruling, visual pass
     2026-09-23). BUILD-NOTES 3.12 draws a forward-30 key here; overturning
     that ruling belongs to the mini-player screen's own PR, which rewrites
     transport-controls on purpose. Now Playing only borrows the mini's art. */
  parts.skipBtn.className = "fp-skip keycap keycap--sm keycap--paper";
  parts.skipBtn.setAttribute("aria-label", "Forward 30 seconds");
  parts.skipBtn.innerHTML = dialMiniIcon("skip-30");
  /* Play first, then +30: the keycaps are the body button's SIBLINGS, in the
     order the prototype draws them. The bar was built art, info, skip, play. */
  if (parts.playBtn.parentNode === parts.bar && parts.skipBtn.parentNode === parts.bar) {
    parts.bar.insertBefore(parts.playBtn, parts.skipBtn);
  }
  dialWireMiniSwipe(parts);
}

function dialPaintMiniPlayer(parts, data) {
  if (!parts || !parts.root) return;
  var d = data || {};
  var label = "Now playing: " + (d.title || "") + (d.show ? ", " + d.show : "");
  parts.root.setAttribute("aria-label", label);
  parts.playBtn.innerHTML = dialMiniIcon(d.running ? "ph-pause-fill" : "ph-play-fill");
  parts.playBtn.setAttribute("aria-label", d.running ? "Pause" : "Play");
  dialPaintMiniLine(parts, d.model);
  /* Something started playing while the undo toast was up (a row's Play, the
     lock screen, a new item): the listener changed their mind, so the pending
     close is dropped rather than stopping what they just started. The grace
     covers the pause the dismiss itself requested, which lands a beat later. */
  var pending = dialMiniPending;
  if (pending && pending.parts === parts && Date.now() - pending.at > 800 && (d.running || (d.title || "") !== pending.title)) {
    dialSettleMiniDismiss();
  }
}

/* ---------- the 3px line (BUILD-NOTES 3.12) ----------

   The foray's enamels, one bar per item with narration as a solid tick, or one
   persimmon bar for a single episode; the played part at full strength, the
   rest at 40%. Painted with the band primitive (`kind: "line"`), so it is the
   same geometry the Now Playing scrub band draws and the line can stretch into
   it. Rebuilt only when WHAT is playing changes (`dialMiniLineKey`); between
   rebuilds a tick moves one attribute, the progress clip's width, instead of
   re-rendering an SVG of up to a few hundred bars four times a second. */
var DIAL_MINI_LINE_INSET = 22; /* px in from each side of the deck (prototype) */

function dialMiniLineSegments(model) {
  if (!model || !model.foray || !Array.isArray(model.segments)) return [];
  return model.segments.map(function (segment) {
    return { showId: segment.showId, show: segment.show, duration: segment.duration, narration: Boolean(segment.narration) };
  });
}

function dialMiniLineKey(model) {
  var segments = dialMiniLineSegments(model);
  if (!segments.length) return "episode";
  return "foray:" + segments.map(function (s) { return (s.narration ? "n" : s.showId) + "/" + Math.round(Number(s.duration) || 0); }).join("|");
}

function dialMiniLineProgress(model) {
  var position = Number(model && model.position) || 0;
  var duration = Number(model && model.duration) || 0;
  return duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
}

function dialPaintMiniLine(parts, model) {
  if (!parts || !parts.bar || typeof tactileBand !== "function") return;
  var key = dialMiniLineKey(model);
  var progress = dialMiniLineProgress(model);
  var state = parts.miniLine;
  if (!state || state.key !== key || !state.svg || state.svg.parentNode !== parts.bar) {
    var width = Math.max(1, (parts.bar.clientWidth || 361) - 2 * DIAL_MINI_LINE_INSET);
    var segments = dialMiniLineSegments(model);
    if (state && state.svg && state.svg.parentNode) state.svg.parentNode.removeChild(state.svg);
    parts.bar.insertAdjacentHTML("afterbegin", tactileBand({ kind: "line", segments: segments, progress: progress, renderWidth: width }));
    var svg = parts.bar.firstElementChild;
    var layout = tactileBandLayout(tactileBandSegments(segments.length ? segments : [{ showId: "episode", show: "Episode", duration: 1 }]), width, "line");
    state = parts.miniLine = { key: key, svg: svg, layout: layout, progress: progress };
    return;
  }
  if (Math.abs(state.progress - progress) < 0.0005) return;
  state.progress = progress;
  var clip = state.svg.querySelector(".band__progress");
  if (clip) clip.setAttribute("width", tactileBandX(state.layout, progress).toFixed(2));
}

/* ---------- swipe-down dismisses (BUILD-NOTES 3.12, 6) ----------

   A vertical drag on the body of more than 60px closes the player, with a
   HEAVY haptic and a 5s "Player closed · Undo" toast. Horizontal swipes do
   nothing: a drag that is more sideways than down is never a dismiss, and it
   never opens the sheet either (the tap that ends any drag is swallowed).

   THE CLOSE IS DEFERRED, NOT UNDONE. For the toast's five seconds the mini is
   hidden and playback paused; Undo puts both back exactly as they were (it
   resumes only what was playing). Only when the toast runs out does the
   player stop, through the same `stopAndClose` the sheet's Stop button uses
   (`ForayPlayer.stop()`), which keeps the resume point. So Undo never has to
   reconstruct a session, and a listener who swipes by accident loses nothing. */
var DIAL_MINI_DISMISS_PX = 60;
var DIAL_MINI_UNDO_MS = 5000;

/** The gesture's whole decision, pure: "dismiss" only for a mostly-vertical
    downward travel past the threshold; "tap" for no real movement; otherwise
    "none" (a sideways swipe, a short drag, an upward drag). */
function dialMiniSwipeVerdict(dx, dy) {
  var x = Math.abs(Number(dx) || 0);
  var y = Number(dy) || 0;
  if (x < 8 && Math.abs(y) < 8) return "tap";
  if (y > DIAL_MINI_DISMISS_PX && y > x) return "dismiss";
  return "none";
}

var dialMiniPending = null;

function dialMiniToast() {
  var host = document.getElementById("mini-toast");
  if (host) return host;
  host = document.createElement("div");
  host.id = "mini-toast";
  host.className = "deck-toast";
  host.innerHTML = tactileToast({ text: "Player closed", action: "Undo" });
  document.body.appendChild(host);
  var undo = host.querySelector(".textbtn");
  if (undo) undo.addEventListener("click", function () { dialUndoMiniDismiss(); });
  return host;
}

function dialDismissMini(parts) {
  if (!parts || !parts.root || dialMiniPending) return false;
  var wasRunning = parts.playBtn.getAttribute("aria-label") === "Pause";
  if (typeof deckHaptic === "function") deckHaptic("heavy");
  var player = window.ForayPlayer;
  if (wasRunning && player && typeof player.togglePlayback === "function") player.togglePlayback();
  parts.root.classList.add("is-dismissed");
  document.body.classList.add("mini-dismissed");
  var toast = dialMiniToast();
  tactileSetToast(toast.querySelector(".toast"), true);
  dialMiniPending = {
    parts: parts,
    wasRunning: wasRunning,
    at: Date.now(),
    title: parts.title ? parts.title.textContent || "" : "",
    timer: setTimeout(dialCommitMiniDismiss, DIAL_MINI_UNDO_MS),
  };
  return true;
}

function dialSettleMiniDismiss() {
  var pending = dialMiniPending;
  dialMiniPending = null;
  if (!pending) return null;
  clearTimeout(pending.timer);
  pending.parts.root.classList.remove("is-dismissed");
  document.body.classList.remove("mini-dismissed");
  var toast = document.getElementById("mini-toast");
  if (toast) tactileSetToast(toast.querySelector(".toast"), false);
  return pending;
}

function dialUndoMiniDismiss() {
  var pending = dialSettleMiniDismiss();
  if (!pending) return false;
  var player = window.ForayPlayer;
  if (pending.wasRunning && player && typeof player.togglePlayback === "function") player.togglePlayback();
  if (pending.parts.info && typeof pending.parts.info.focus === "function") pending.parts.info.focus({ preventScroll: true });
  return true;
}

function dialCommitMiniDismiss() {
  var pending = dialSettleMiniDismiss();
  if (!pending) return false;
  var player = window.ForayPlayer;
  if (player && typeof player.stop === "function") player.stop();
  return true;
}

function dialWireMiniSwipe(parts) {
  var body = parts.info;
  if (!body || body.dataset.miniSwipe === "1") return;
  body.dataset.miniSwipe = "1";
  var start = null;
  var swallowClick = false;
  function reset() {
    start = null;
    parts.root.classList.remove("is-dragging");
    parts.bar.style.removeProperty("--mini-drag");
  }
  body.addEventListener("pointerdown", function (event) {
    if (event.button > 0 || dialMiniPending) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    swallowClick = false;
  });
  body.addEventListener("pointermove", function (event) {
    if (!start || event.pointerId !== start.id) return;
    var dx = event.clientX - start.x;
    var dy = event.clientY - start.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) swallowClick = true;
    /* The mini follows the finger down only (never sideways, never up). */
    if (dy > 0 && dy > Math.abs(dx)) {
      parts.root.classList.add("is-dragging");
      parts.bar.style.setProperty("--mini-drag", Math.min(dy, 120) + "px");
    } else parts.bar.style.removeProperty("--mini-drag");
  });
  body.addEventListener("pointerup", function (event) {
    if (!start || event.pointerId !== start.id) return;
    var verdict = dialMiniSwipeVerdict(event.clientX - start.x, event.clientY - start.y);
    reset();
    if (verdict === "dismiss") dialDismissMini(parts);
  });
  body.addEventListener("pointercancel", reset);
  /* Capture on the ROOT runs before the player's own click handler on the
     body button (which opens the sheet), so the click that ends a drag never
     opens it. */
  parts.root.addEventListener("click", function (event) {
    if (!swallowClick || !body.contains(event.target)) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);
}

window.DialMiniPlayer = {
  decorate: dialDecorateMiniPlayer,
  paint: dialPaintMiniPlayer,
  dismiss: dialDismissMini,
  undo: dialUndoMiniDismiss,
};
