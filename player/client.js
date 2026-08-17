/* Client bootstrap — the only file that connects the player to the page (#25).

   app.js is a classic script; everything under player/ is ES modules. So this
   module owns the wiring and exposes a tiny surface on `window.ForayPlayer`,
   which app.js calls lazily on click. Module scripts are deferred, so app.js
   must never assume this exists at parse time — only at interaction time.

   This file also owns its own DOM (mini-player + Now Playing sheet), built with
   createElement/textContent rather than HTML strings. Episode titles come from
   third-party RSS, and DOM construction is safe by default in a way string
   concatenation is not. There is a strict CSP with no inline styles or scripts;
   all styling lives in styles.css.

   ── Forays (#128) ─────────────────────────────────────────────────────────
   A Foray is one queue of 32 segments, so it needs a second entry point next
   to `play(item)`: `playForay(resolved)`. Everything below the surface is
   unchanged — the same manager, the same backend, the same out-point watch. Two
   things are different above it, and both exist because a segment is a slice of
   somebody else's episode:

     - POSITION IS FORAY POSITION. The audio element's `currentTime` for segment
       20 is ~31 minutes, which is a fact about a stranger's podcast. Everything
       displayed and everything scrubbed goes through `forayElapsed` /
       `segmentAtElapsed` (player/foray-resolve.js, tested) so the listener only
       ever sees the Foray's own clock.
     - THE SKIP BUTTONS MOVE BETWEEN SEGMENTS. ±15/30 s inside a 90-second
       segment would mostly leave it, and leaving a segment is what `next` is
       for.

   The resolution itself — forays.json + segments.json + segment-sources.json —
   is NOT done here. app.js needs the same running order to render, so it lives
   in the pure module and both callers use it through `ForayPlayer.resolve`.

   ── Resuming across sessions ──────────────────────────────────────────────
   `PositionStore` already persists a position per QUEUE ITEM, and for a Foray
   that is 32 rows none of which is the Foray's own clock. So a Foray's resume
   point is written separately, by `player/foray-progress.js`, in the only unit a
   listener recognises: elapsed across the whole thing. This file is where the
   live playhead meets that store — on every tick (throttled), and forced at the
   two moments the next tick may never come, pause and page-hide.

   ── Durable storage (#40) ─────────────────────────────────────────────────
   This module owns the ONE `DurableStore` the whole app shares. It is built
   here, not in app.js, for a mechanical reason: app.js is a classic script and
   cannot import an ES module, and `index.html` is outside the auto-merge
   allowlist so a third `<script>` tag is not available. So the store is created
   at module evaluation and published on `window.forayStorage` alongside
   `window.ForayPlayer`; app.js's `lsGet`/`lsSet` pick it up and fall back to raw
   `localStorage` until it appears (and forever, if this module fails to load).

   Two consequences worth knowing before changing anything here:
     - `hydrate()` is started immediately and is what app.js awaits before its
       first write. Reading `cp_interests` or `cp_sb_session` before it finishes
       is how a RESTORED profile gets overwritten by a fresh one — the fix
       causing the defect it fixes.
     - `navigator.storage.persist()` is requested once, and a refusal is
       recorded rather than treated as an error. Nothing below branches on it.
*/

import { PlayerQueueManager } from "./queue-manager.js";
import { HtmlAudioBackend } from "./html-audio-backend.js";
import { PositionStore } from "./position-store.js";
import { SINGLE_ITEM } from "./queue-strategy.js";
import { seekPrecision, formatTimestamp, EXACT, OWN } from "./seek-policy.js";
import {
  resolveForay, indexSegments, indexSources, findForay, listableForays,
  forayElapsed, segmentAtElapsed, fmtClock, fmtSpan, progressSegments,
} from "./foray-resolve.js";
import {
  ForayProgressStore, resumePoint, remainingLabel, percentDone,
  DRIFT_EXACT, DRIFT_UNVERIFIED, DRIFT_UNANCHORED,
} from "./foray-progress.js";
import { forayCredits, collectionIdsByShow, creditsSummary } from "./foray-sources.js";
import { createDurableStore } from "./durable-store.js";
import { makeIdbTier } from "./idb-tier.js";

const SEEK_BACK = 15;
const SEEK_FWD = 30;
const RATES = [1, 1.25, 1.5, 1.75, 2];

let manager = null;
let backend = null;
let positions = null;
let ui = null;

/* ---------- durable storage (#40) ----------

   Built before anything else in this module, because everything below it stores
   something. `createDurableStore` drops any tier it cannot have, so a browser
   with no IndexedDB gets a localStorage-only store and a browser with neither
   gets one that works for the session and says so in `health()`. */
const storage = createDurableStore({
  localStorage: typeof localStorage !== "undefined" ? localStorage : null,
  idbTier: makeIdbTier({}),
  onFault: (fault, health) => {
    // The player cannot fix a dead tier. What it must not do is hide one.
    console.warn("[storage]", fault.tier, fault.op, fault.key ?? "", fault.error);
    if (typeof window.forayLogEvent === "function") {
      window.forayLogEvent("storage_fault", {
        tier: fault.tier, op: fault.op, key: fault.key, error: fault.error,
        durable_tiers: health.durableTiers, persisted: health.persisted,
      });
    }
  },
});

/* Started immediately, awaited by app.js before its first write. Rejection is
   impossible by construction (every tier failure is caught into `health()`), but
   an unhandled rejection here would take the module down, so it is attached. */
const storageReady = storage.hydrate().catch(() => storage);

/* A request, not a setting: Chromium may grant it silently, Firefox may prompt,
   Safari does not meaningfully honour it, and a refusal changes nothing about
   how this store behaves. Fired and forgotten — the answer lands in `health()`.
   Deliberately NOT awaited before hydration: exempting storage from eviction has
   nothing to do with reading what is already in it. */
storage.requestPersistence(typeof navigator !== "undefined" ? navigator : null).catch(() => {});

/* app.js is a classic script and cannot import this module, so the store is
   handed over the same way the event pipeline is. Published BEFORE any await so
   that app.js, whose `init()` parks on its first fetch, sees it. */
window.forayStorage = storage;
window.forayStorageReady = storageReady;
/** For a founder or a tester with a console open: the whole failure record. */
window.forayStorageHealth = () => storage.health();

/* Resume points are readable with nothing booted: the home screen asks for them
   before anything has been played, and booting an <audio> element to answer a
   question about storage would be absurd. */
const forayProgress = new ForayProgressStore({ storage });

/* ---------- DOM ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildUI() {
  const root = el("div", "fp");
  root.id = "foray-player";
  root.hidden = true;

  /* mini bar */
  const bar = el("div", "fp-bar");
  const art = el("img", "fp-art");
  art.alt = "";
  const info = el("button", "fp-info");
  info.type = "button";
  info.setAttribute("aria-label", "Open player");
  const title = el("span", "fp-title");
  const show = el("span", "fp-show");
  info.append(title, show);

  const playBtn = el("button", "fp-play", "▶");
  playBtn.type = "button";
  playBtn.setAttribute("aria-label", "Play");

  const closeBtn = el("button", "fp-close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Stop and close player");

  const progress = el("div", "fp-progress");
  const fill = el("div", "fp-fill");
  progress.append(fill);

  bar.append(art, info, playBtn, closeBtn);
  root.append(progress, bar);

  /* expanded sheet */
  const sheet = el("div", "fp-sheet");
  sheet.hidden = true;
  const sTitle = el("h2", "fp-s-title");
  const sShow = el("p", "fp-s-show");
  const sWhy = el("p", "fp-s-why");

  const scrub = el("input", "fp-scrub");
  scrub.type = "range";
  scrub.min = "0";
  scrub.max = "1000";
  scrub.value = "0";
  scrub.setAttribute("aria-label", "Seek");

  const times = el("div", "fp-times");
  const tNow = el("span", "fp-now", "0:00");
  const tLeft = el("span", "fp-left", "--:--");
  times.append(tNow, tLeft);

  const row = el("div", "fp-row");
  const backBtn = el("button", "fp-btn", `↺ ${SEEK_BACK}`);
  backBtn.type = "button";
  backBtn.setAttribute("aria-label", `Back ${SEEK_BACK} seconds`);
  const bigPlay = el("button", "fp-btn fp-big", "▶");
  bigPlay.type = "button";
  bigPlay.setAttribute("aria-label", "Play");
  const fwdBtn = el("button", "fp-btn", `${SEEK_FWD} ↻`);
  fwdBtn.type = "button";
  fwdBtn.setAttribute("aria-label", `Forward ${SEEK_FWD} seconds`);
  row.append(backBtn, bigPlay, fwdBtn);

  const row2 = el("div", "fp-row2");
  const rateBtn = el("button", "fp-rate", "1×");
  rateBtn.type = "button";
  rateBtn.setAttribute("aria-label", "Playback speed");
  const openLink = el("a", "fp-openep", "Open episode ↗");
  openLink.target = "_blank";
  openLink.rel = "noopener";
  /* The bar already survives navigation — it lives on <body>, not inside
     #view — but until now there was no way BACK. Leaving the Foray page to look
     at something else meant the running order, the segment you were on and the
     thumbs were all gone until you found the URL again. This is that way back,
     and it is an in-app hash route, never an external link. */
  const forayLink = el("a", "fp-openep fp-toforay", "Back to the Foray");
  forayLink.hidden = true;
  const collapse = el("button", "fp-collapse", "Close");
  collapse.type = "button";
  row2.append(rateBtn, openLink, forayLink, collapse);

  const note = el("p", "fp-note");

  sheet.append(sTitle, sShow, sWhy, scrub, times, row, row2, note);
  root.append(sheet);
  document.body.append(root);

  return {
    root, bar, art, title, show, playBtn, closeBtn, fill, sheet,
    sTitle, sShow, sWhy, scrub, tNow, tLeft, bigPlay, backBtn, fwdBtn,
    rateBtn, openLink, forayLink, collapse, info, note,
  };
}

/* ---------- state -> DOM ---------- */

let current = null;
let scrubbing = false;

/** The Foray being played, or null for ordinary single-episode playback.
    `{ resolved, index, onChange, error }`.

    `index` is the segment the LISTENER is on, which is not the same as the one
    the backend has finished loading — the same distinction the manager keeps as
    `_targetIndex` vs `currentIndex`. It matters here for a plain reason: a load
    can take a second (or hit its ten-second deadline), and a running order that
    only highlights the new row once the bytes arrive looks broken. Intent is
    painted immediately; a divergence is reconciled by `syncForaySegment`. */
let foray = null;

function isPlaying() {
  return manager?.state?.type === "playing";
}

/** Is the Foray RUNNING, as a listener would say it?
 *
 *  Wider than `isPlaying()` by exactly one state: the 2.0 s seam beat between
 *  two unbridged segments (`player/seam-gap.js`). Structurally that is
 *  `loadingItem`, so `isPlaying()` is false — but nobody has pressed anything,
 *  the Foray is advancing on its own, and the only sane meaning for the main
 *  button during those two seconds is STOP.
 *
 *  Every play/pause control goes through this. The first draft changed the
 *  Foray page's LABEL to "❚❚ Pause" during a beat while `forayToggle` still
 *  branched on `isPlaying()` — so the button said Pause and started audio. */
function isRunning() {
  return isPlaying() || manager?.inSeamGap === true;
}

/** Where we are, in the Foray's own seconds. The playhead only counts when the
    segment we are showing is the one actually loaded; mid-jump, the honest
    answer is that segment's start. */
function forayPosition() {
  if (!foray || foray.index < 0) return 0;
  const loaded = manager?.currentIndex === foray.index;
  return forayElapsed(foray.resolved.playable, foray.index, loaded ? (backend?.currentTime ?? null) : null);
}

/**
 * Move the listener to `index`: now-playing, the page and the position all
 * follow from this one call, whether the move was a click or an out-point.
 *
 * `pendingFrom` records where the manager was when we asked. Until the manager
 * either arrives at `index` or lands somewhere else entirely, `syncForaySegment`
 * must leave our intent alone — the first draft did not, and the nested render
 * inside `setNowPlaying` immediately reconciled every jump straight back to the
 * segment we were leaving. Prev and next looked completely dead.
 */
function setForayIndex(index, { pending = true } = {}) {
  if (!foray) return;
  foray.index = index;
  foray.pendingFrom = pending ? (manager?.currentIndex ?? -1) : null;
  const item = foray.resolved.playable[index];
  if (item) setNowPlaying(forayNowPlaying(item, index), item.why);
  else notifyForay();
}

/** Reconcile with the manager when IT moved us — the out-point path, where the
    backend reports an end and the manager loads the next segment with nothing
    in this file involved. Called from render(), which every relevant media
    event already drives, so no new callback is needed on the manager. */
function syncForaySegment() {
  if (!foray) return;
  const index = manager?.currentIndex ?? -1;
  if (index < 0) return;
  if (index === foray.index) { foray.pendingFrom = null; return; }
  // A jump we asked for is still in flight and the manager has not moved yet.
  // Leave it; the load will land or fail, and either way we hear about it.
  if (foray.pendingFrom != null && index === foray.pendingFrom) return;
  foray.error = null;
  setForayIndex(index, { pending: false });
}

/** The mini-player wants a catalogue-shaped item; a queue item is close but
    names the episode rather than the segment.

    The bar leads with the FORAY's title, not the source episode's — the mockup's
    `MiniPlayer` does the same, and for the same reason: the episode title
    changes nine times over the hour and is not the thing being listened to. The
    show is on the second line, which is where the mockup puts it too
    (`Now: <show name>`), extended with the part number because a Foray's second
    line has room and "part 12 of 32" is the one fact a mini bar can add. */
function forayNowPlaying(item, index) {
  const total = foray.resolved.playable.length;
  const show = item.show ? `Now: ${item.show}` : "Now playing";
  return {
    id: item.id,
    title: foray.resolved.title || item.title || "",
    show: `${show} · part ${index + 1} of ${total}`,
    duration_sec: null,
    dai_suspected: Boolean(item.dai_suspected),
  };
}

/** Everything a page needs to paint itself, in Foray terms. */
function forayStateSnapshot() {
  if (!foray) return null;
  return {
    forayId: foray.resolved.id,
    index: foray.index,
    loading: manager?.state?.type === "loadingItem",
    playing: isPlaying(),
    /* The 2.0 s seam beat between two unbridged segments (player/seam-gap.js).
       Structurally this is `loadingItem` too, but calling it "Loading…" on the
       page would be the app apologising for a silence it chose on purpose —
       and it is the one state where pressing the main button has to mean
       "stop", not "start". */
    gap: manager?.inSeamGap === true,
    ended: manager?.state?.type === "ended",
    elapsedSec: forayPosition(),
    totalSec: foray.resolved.totalSec,
    // A segment that would not load is the failure a listener actually meets,
    // and it is silent otherwise: the manager pauses and the page just sits
    // there. Hand it up so the surface can say what happened.
    error: foray.error ?? null,
  };
}

function notifyForay() {
  if (foray?.onChange) foray.onChange(forayStateSnapshot());
}

/**
 * Write down where the listener is, so closing the tab does not cost them the
 * hour they were part-way through.
 *
 * Called from `render()`, which every media event already drives, so there is no
 * second timer — the store throttles the 4 Hz tick down to one write per five
 * seconds of movement. `force` is for the moments where the next tick may never
 * arrive: pause, page-hide, and closing the bar.
 *
 * Reaching the end CLEARS the row rather than storing "100%". A finished Foray
 * that keeps offering "0 min left" on the home screen is worse than one that
 * quietly goes back to being unplayed.
 */
function persistForayProgress({ force = false } = {}) {
  if (!foray || foray.index < 0) return;
  const id = foray.resolved.id;
  if (manager?.state?.type === "ended") { forayProgress.clear(id); return; }
  /* Only write once the segment we are showing is the one actually loaded.
     Mid-jump — and on the first paint of a RESUME, which happens before the
     load — `forayPosition()` honestly reports the segment's start, and storing
     that would overwrite a precise resume point with a rounded-down one every
     time the listener re-opened the page. */
  if (manager?.currentIndex !== foray.index) return;
  /* A resume is TWO steps — load the segment at its in-point, then seek into it
     — and the load fires real media events in between. Without this the tick
     between them writes the segment's in-point over the precise position we are
     in the middle of restoring, and a resume that then failed (or a tab closed
     inside that second) would have quietly rounded the listener back by up to a
     whole segment, again on every attempt. */
  if (foray.resumeSeekPending) return;
  /* WHICH segment, not only which index (#40). `data/forays.json` is served
     network-first, so the document this row is read back against can have moved
     a segment or lost one — and an index is a position, which stops meaning
     anything the moment the order changes. The authored id plus the offset INTO
     the segment is what survives that; see `reconcileSegment`. */
  const elapsedSec = forayPosition();
  const seg = forayProgressSegments()[foray.index] ?? null;
  forayProgress.save({
    forayId: id,
    title: foray.resolved.title,
    elapsedSec,
    totalSec: foray.resolved.totalSec,
    index: foray.index,
    segmentId: seg ? seg.id : null,
    intoSec: seg ? Math.max(0, elapsedSec - seg.startSec) : 0,
    force,
  });
}

/** The live running order in the shape a stored row is reconciled against.
    Computed once per Foray, not once per tick: `render()` runs at 4 Hz and this
    walks all 32 segments. */
function forayProgressSegments() {
  if (!foray) return [];
  if (!foray.segments) foray.segments = progressSegments(foray.resolved);
  return foray.segments;
}

function render() {
  if (!ui || !current) return;
  syncForaySegment();
  // A seam beat reads as playing everywhere, or the mini bar shows "▶" while
  // the Foray page shows "❚❚ Pause" for the same two seconds.
  const running = isRunning();
  const glyph = running ? "❚❚" : "▶";
  ui.playBtn.textContent = glyph;
  ui.bigPlay.textContent = glyph;
  ui.playBtn.setAttribute("aria-label", running ? "Pause" : "Play");
  ui.bigPlay.setAttribute("aria-label", running ? "Pause" : "Play");

  // In a Foray the clock is the Foray's, not the source episode's: 31 minutes
  // into somebody else's podcast is not a position this listener recognises.
  const pos = foray ? forayPosition() : (backend?.currentTime ?? 0);
  const dur = foray ? foray.resolved.totalSec : (backend?.duration ?? current.duration_sec ?? null);

  if (!scrubbing && dur) {
    ui.scrub.value = String(Math.round((pos / dur) * 1000));
    ui.fill.style.width = `${Math.min(100, (pos / dur) * 100)}%`;
  }
  ui.tNow.textContent = foray ? fmtClock(pos) : formatTimestamp(pos, EXACT);
  ui.tLeft.textContent = dur
    ? `-${foray ? fmtClock(Math.max(0, dur - pos)) : formatTimestamp(Math.max(0, dur - pos), EXACT)}`
    : "--:--";
  syncCardButtons();
  if (foray) {
    persistForayProgress();
    notifyForay();
  }
}

function syncCardButtons() {
  // Reflect play state on the originating card so the page and the bar agree.
  document.querySelectorAll("[data-play]").forEach((b) => {
    const on = current && b.dataset.play === current.id && isPlaying();
    if (on) b.dataset.playing = "1"; else delete b.dataset.playing;
    b.textContent = on ? "❚❚" : "▶";
  });
}

function setNowPlaying(item, why) {
  current = item;
  ui.root.hidden = false;
  document.body.classList.add("fp-open");
  ui.title.textContent = item.title || "";
  ui.show.textContent = item.show || "";
  ui.sTitle.textContent = item.title || "";
  ui.sShow.textContent = item.show || "";
  ui.sWhy.textContent = why || item.hook || "";
  if (item.artwork_url) {
    ui.art.src = item.artwork_url;
    ui.art.hidden = false;
  } else {
    ui.art.hidden = true;
  }
  if (item.apple_episode_url) {
    ui.openLink.href = item.apple_episode_url;
    ui.openLink.hidden = false;
  } else {
    ui.openLink.hidden = true;
  }
  if (foray) {
    // Our own route, built from our own id — the only interpolation here is
    // encodeURIComponent's output, so no scheme can be smuggled in.
    ui.forayLink.href = `#/foray/${encodeURIComponent(foray.resolved.id)}`;
    ui.forayLink.hidden = false;
  } else {
    ui.forayLink.hidden = true;
  }

  // Honest scrub affordance. On an ad-stitched feed our own playhead is
  // reliable for this listener (#22's corollary), so scrubbing is exact — but
  // any timestamp we might later show from chapters is not. Say nothing when
  // it's exact; say something plain when it isn't.
  const { precision } = seekPrecision(item, { isLocalFile: false, source: OWN });
  ui.note.textContent = precision === EXACT ? "" : "Timings on this show are approximate.";
  render();
}

/* ---------- wiring ---------- */

function bind() {
  const toggle = async () => {
    if (isRunning()) await manager.pause();
    else await manager.resume();
    render();
    // A pause may be the last thing that ever happens on this page load, so it
    // does not get to wait for the throttle window.
    persistForayProgress({ force: true });
  };
  ui.playBtn.addEventListener("click", toggle);
  ui.bigPlay.addEventListener("click", toggle);

  ui.closeBtn.addEventListener("click", async () => {
    // Closing the bar is not "I am done with this Foray", it is "get this off my
    // screen". Keep the resume point; the only thing that clears it is finishing.
    persistForayProgress({ force: true });
    await manager.stop();
    ui.root.hidden = true;
    ui.sheet.hidden = true;
    document.body.classList.remove("fp-open", "fp-expanded");
    current = null;
    // Same shape the live snapshot has, so the page never has to guess which
    // fields it got.
    const wasForay = foray;
    foray = null;
    if (wasForay?.onChange) {
      wasForay.onChange({
        forayId: wasForay.resolved.id, index: -1, loading: false, playing: false,
        ended: false, elapsedSec: 0, totalSec: wasForay.resolved.totalSec, error: null,
      });
    }
    syncCardButtons();
  });

  const setExpanded = (open) => {
    ui.sheet.hidden = !open;
    document.body.classList.toggle("fp-expanded", open);
  };
  ui.info.addEventListener("click", () => setExpanded(ui.sheet.hidden));
  ui.collapse.addEventListener("click", () => setExpanded(false));
  // Following the route with the sheet still open would leave the Foray page
  // rendered underneath a full-height overlay.
  ui.forayLink.addEventListener("click", () => setExpanded(false));

  // In a Foray these are previous/next SEGMENT, not ±15/30 s: a segment here is
  // often under two minutes, so a 30-second nudge mostly leaves it anyway, and
  // "leave this one" is what the button should mean.
  ui.backBtn.addEventListener("click", async () => {
    if (foray) return ForayPlayer.forayPrevious();
    await manager.seek(Math.max(0, (backend.currentTime ?? 0) - SEEK_BACK), { precise: true });
    render();
  });
  ui.fwdBtn.addEventListener("click", async () => {
    if (foray) return ForayPlayer.forayNext();
    await manager.seek((backend.currentTime ?? 0) + SEEK_FWD, { precise: true });
    render();
  });

  ui.scrub.addEventListener("input", () => { scrubbing = true; });
  ui.scrub.addEventListener("change", async () => {
    const frac = Number(ui.scrub.value) / 1000;
    scrubbing = false;
    if (foray) {
      await ForayPlayer.foraySeek(frac * foray.resolved.totalSec);
      return;
    }
    const dur = backend?.duration ?? current?.duration_sec;
    if (dur) await manager.seek(frac * dur, { precise: true });
    render();
  });

  ui.rateBtn.addEventListener("click", () => {
    const cur = Number(storage.getItem("cp_rate")) || 1;
    const next = RATES[(RATES.indexOf(cur) + 1) % RATES.length];
    // Throws only when NO tier accepted it — a rate that cannot be stored is
    // still a rate that should apply for this session.
    try { storage.setItem("cp_rate", String(next)); } catch (_) { /* health() has it */ }
    backend.setRate(next);
    ui.rateBtn.textContent = `${next}×`;
  });

  // Corner case #17: pocketing the phone must not lose the position. This is
  // the path that actually matters on mobile — beforeunload is unreliable there.
  const flush = () => {
    if (current && isPlaying()) manager._persistPosition();
    // Unconditional, unlike the line above: a Foray paused at 23:14 and then
    // backgrounded must still remember 23:14.
    persistForayProgress({ force: true });
    /* The durable write cannot be awaited here — `pagehide` has no way to hold
       the page open, and an IndexedDB commit is asynchronous. That is survivable
       and deliberately so: the localStorage tier is written SYNCHRONOUSLY by the
       line above, so the position is on disk before this handler returns, and the
       next `hydrate()` copies it down into IndexedDB. Kicking the queue costs
       nothing and often wins the race anyway. */
    storage.flush().catch(() => {});
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);
}

function ensureBooted() {
  if (manager) return;

  positions = new PositionStore({
    storage,
    onSave: (id, seconds, meta) => {
      // Ride the existing event pipeline; app.js owns it.
      if (typeof window.forayLogEvent === "function") {
        window.forayLogEvent("position", { episode_id: id, seconds, duration: meta.duration ?? null });
      }
    },
  });

  backend = new HtmlAudioBackend();
  manager = new PlayerQueueManager({
    backend,
    positionStore: positions,
    strategy: SINGLE_ITEM,
    /* A seam beat produces NO media events — the element is paused for the
       whole 2 s, so `timeupdate` has stopped and neither `play` nor `pause`
       fires. Without this hook the page keeps whatever frame it had when the
       out-point landed (which says "Loading…") and the `gap` flag never
       reaches it at all, so the beat is invisible and the main button still
       means "start". This is the only repaint during a beat, at both edges. */
    onSeamGapChange: () => render(),
    telemetry: (m) => {
      if (!/error|rejected|skipped/i.test(m)) return;
      console.warn("[player]", m);
      // A Foray that stops on a dead segment must SAY so. Without this the
      // manager pauses, the page keeps its highlight, and the only evidence is
      // a console line nobody has open.
      if (foray && /player\.error|segment\.skipped/i.test(m)) {
        foray.error = m;
        notifyForay();
      }
    },
  });

  ui = buildUI();
  bind();

  // Through the durable store, like every other cp_ key: a playback rate is
  // small, but "the app forgot I listen at 1.5x" is the same defect in miniature.
  const rate = Number(storage.getItem("cp_rate")) || 1;
  backend.setRate(rate);
  ui.rateBtn.textContent = `${rate}×`;

  backend.el.addEventListener("timeupdate", render);
  backend.el.addEventListener("play", render);
  backend.el.addEventListener("pause", render);
}

/* ---------- public surface ---------- */

const ForayPlayer = {
  /** True when this item can play in-app. app.js uses it to decide whether to
      show a play button or fall back to the Apple Podcasts link (#25 note). */
  canPlay(item) {
    return Boolean(item && item.audio_url);
  },

  /** Play one episode. SINGLE_ITEM strategy: the queue is this episode and
      nothing follows it (CLAUDE.md principle 1 — no autoplay chains). */
  async play(item, { why = "" } = {}) {
    if (!this.canPlay(item)) return false;
    ensureBooted();
    // Leaving a Foray for a single episode must not cost the last few seconds
    // of it — this is the only place `foray` is dropped without a flush.
    persistForayProgress({ force: true });
    foray = null;
    setSkipButtonMode(false);
    setNowPlaying(item, why);
    manager.setQueueFromPick(item);
    await manager.play(0);
    render();
    return true;
  },

  isPlaying(id) {
    return isPlaying() && current?.id === id;
  },

  /* ---------- Forays (#128) ---------- */

  /** The three-document join, re-exported so app.js resolves the running order
      with exactly the code that builds the queue. app.js is a classic script and
      cannot import an ES module, which is the whole reason this bridge exists. */
  resolve(foraysDoc, { id, segmentsDoc, sourcesDoc, unlocked = [] } = {}) {
    const doc = findForay(foraysDoc, id, { unlocked });
    if (!doc) return null;
    return resolveForay(doc, {
      segments: indexSegments(segmentsDoc),
      sources: indexSources(sourcesDoc),
    });
  },

  /** Which Forays may be listed for this visitor (drafts only when named). */
  listForays(foraysDoc, { unlocked = [] } = {}) {
    return listableForays(foraysDoc, { unlocked });
  },

  fmtClock,
  fmtSpan,

  /** Which segment `elapsedSec` lands in, and how far into it — re-exported so
      the page paints the strip's fill with exactly the maths `foraySeek` uses
      to interpret a click on that same strip. A second implementation in
      app.js would be a scrubber whose bar and whose destination disagree. */
  segmentAt(playable, elapsedSec) {
    return segmentAtElapsed(playable, elapsedSec);
  },

  /**
   * Play a resolved Foray from `startIndex`, or from a position in the Foray's
   * own clock.
   *
   * @param {object} resolved  from `resolve()` above
   * @param {object} [opts]
   * @param {number} [opts.startIndex]
   * @param {number} [opts.startElapsedSec]  resume point, in FORAY seconds.
   *   Wins over `startIndex` when given, because it is strictly more specific:
   *   it names the segment AND the offset inside it. Seeking is a second step
   *   rather than a load offset on purpose — the manager loads a bounded segment
   *   at its in-point by contract (`queue-manager.js`'s `resumingInPlace`), and
   *   that contract is what keeps a Foray from starting mid-sentence in
   *   somebody else's episode.
   * @param {Function} [opts.onChange] called with `{ index, playing, ended,
   *   elapsedSec, totalSec }` on every position tick and every segment change —
   *   the page owns the running order, so it needs to be told, not to poll.
   * @returns the build report, or null when nothing is playable.
   */
  async playForay(resolved, { startIndex = 0, startElapsedSec = null, onChange = null } = {}) {
    if (!resolved || !resolved.playable.length) return null;
    ensureBooted();
    foray = { resolved, index: -1, pendingFrom: null, onChange, error: null };
    setSkipButtonMode(true);

    const report = manager.setQueueFromForay(resolved.hydrated, {
      resolveItem: (itemId) => resolved.sources.get(itemId) ?? null,
    });

    const at = Number.isFinite(startElapsedSec) && startElapsedSec > 0
      ? segmentAtElapsed(report.items, startElapsedSec)
      : null;
    foray.resumeSeekPending = Boolean(at);
    // Paint the intent before awaiting the load: a running order that only
    // highlights the row once the audio arrives reads as a dead button.
    setForayIndex(clampIndex(at ? at.index : startIndex, report.items.length));
    try {
      await manager.play(foray.index);
      if (at) {
        const item = report.items[foray.index];
        if (item) await manager.seek(item.start_sec + at.into, { precise: true });
      }
    } finally {
      // Even if the load threw, the window has to close or this Foray would
      // never write a position again.
      if (foray) foray.resumeSeekPending = false;
    }
    render();
    return report;
  },

  /* ---------- resume across sessions ---------- */

  /**
   * Where this Foray was left, or null when there is nothing worth offering.
   *
   * `totalSec` and `itemCount` should describe the LIVE Foray — the document can
   * have changed since the row was written, and a resume point past the end of
   * the Foray as it exists now is a stale row, not a position.
   *
   * `resolved` is the stronger form of the same idea and is what the Foray page
   * passes (#40): with the whole running order in hand the stored SEGMENT can be
   * looked up rather than trusting the stored index, so a Foray whose segments
   * moved resumes to the same audio, and one whose segment is gone degrades to a
   * clamped clock instead of seeking somewhere wrong. `drift` says which
   * happened; the home rail, which has no resolved document, gets "unverified".
   *
   * @returns {{ elapsedSec, index, remainingSec, percent, finished, drift,
   *             label, clock, title } | null}
   */
  forayResume(forayId, { totalSec = null, itemCount = null, resolved = null } = {}) {
    const record = forayProgress.get(forayId);
    const segments = resolved ? progressSegments(resolved) : null;
    const total = isFiniteNum(totalSec) ? totalSec : (resolved ? resolved.totalSec : null);
    const count = Number.isInteger(itemCount) ? itemCount : (resolved ? resolved.playable.length : null);
    const maxIndex = Number.isInteger(count) && count > 0 ? count - 1 : null;
    const point = resumePoint(record, { totalSec: total, maxIndex, segments });
    if (!point || point.finished) return null;
    return {
      ...point,
      title: record.title || "",
      clock: fmtClock(point.elapsedSec),
      label: remainingLabel(point.remainingSec),
    };
  },

  /** Whether the document is the one this row was written against.
      "Clean" includes the two cases that are not drift at all: nothing was
      checked (`unverified`, the home rail), and there was nothing to check with
      (`unanchored` — every row written before segment ids existed, which is all
      of them on the day this ships). Only `moved` and `dropped` are drift. */
  forayDriftIsClean(point) {
    if (!point) return true;
    return point.drift === DRIFT_EXACT
      || point.drift === DRIFT_UNVERIFIED
      || point.drift === DRIFT_UNANCHORED;
  },

  /** Every Foray with a resume point, most recent first — the home screen's
      "Jump back in" rail. The CALLER still has to apply the draft rule: a stored
      position is not permission to list an unpublished Foray. */
  forayResumeList() {
    return forayProgress.list().map((r) => {
      const point = resumePoint(r);
      return {
        id: r.foray_id,
        title: r.title || "",
        updated_at: r.updated_at,
        elapsedSec: r.elapsed_sec,
        totalSec: r.total_sec,
        index: r.index,
        percent: percentDone(r.elapsed_sec, r.total_sec),
        finished: Boolean(point?.finished),
        label: point && !point.finished ? remainingLabel(point.remainingSec) : "",
      };
    });
  },

  /** Forget a Foray's position. The listener saying "start it again" is the only
      thing besides finishing that may do this. */
  clearForayResume(forayId) {
    forayProgress.clear(forayId);
  },

  /* ---------- who it is made of ---------- */

  /** The publisher credit block for a resolved Foray: which shows and episodes
      it draws on, how much of the runtime each carries, and where to go and
      subscribe. `discoverDoc` is optional and only ever upgrades a link from an
      Apple search to the show's real page. */
  forayCredits(resolved, { discoverDoc = null } = {}) {
    const credits = forayCredits(resolved, { collectionIds: collectionIdsByShow(discoverDoc) });
    return { credits, summary: creditsSummary(credits) };
  },

  /** The live Foray's state, or null when none is loaded. A page that
      re-renders (navigating away and back) needs to paint the CURRENT segment
      rather than assume nothing is playing. */
  forayStatus() {
    return forayStateSnapshot();
  },

  /** Re-point the change callback at a freshly rendered page. */
  watchForay(onChange) {
    if (foray) foray.onChange = onChange;
    return this.forayStatus();
  },

  /** Play/pause the Foray without rebuilding it. */
  async forayToggle() {
    if (!foray) return;
    if (isRunning()) await manager.pause();
    else await manager.resume();
    render();
    // The page's own pause is the one a listener actually uses; it gets the same
    // forced write the mini bar's does.
    persistForayProgress({ force: true });
  },

  async forayJump(index) {
    if (!foray) return;
    foray.error = null;
    setForayIndex(clampIndex(index, foray.resolved.playable.length));
    await manager.play(foray.index);
    render();
  },

  async forayNext() {
    if (!foray) return;
    const last = foray.resolved.playable.length - 1;
    if (manager.currentIndex >= last) return;
    foray.error = null;
    setForayIndex(manager.currentIndex + 1);
    await manager.skipToNext();
    render();
  },

  /**
   * Previous means "restart this segment" while we are inside it, and "the one
   * before" when we have only just started it — the convention every podcast
   * player uses, and the only one that is usable when segments are 90 seconds
   * long. The threshold is measured against the segment's own start, not the
   * episode's.
   */
  async forayPrevious() {
    if (!foray) return;
    foray.error = null;
    const index = manager.currentIndex;
    const item = foray.resolved.playable[index];
    const into = item ? (backend.currentTime ?? 0) - item.start_sec : 0;
    if (index > 0 && into < RESTART_WINDOW_SEC) {
      setForayIndex(index - 1);
      await manager.play(foray.index);
    } else {
      await manager.skipToPrevious();
    }
    render();
  },

  /** Seek to a position in the WHOLE Foray: find the segment, then the offset
      inside its source episode. */
  async foraySeek(elapsedSec) {
    if (!foray) return;
    const at = segmentAtElapsed(foray.resolved.playable, elapsedSec);
    if (!at) return;
    const item = foray.resolved.playable[at.index];
    if (at.index !== manager.currentIndex) {
      foray.error = null;
      setForayIndex(at.index);
      await manager.play(at.index);
    }
    await manager.seek(item.start_sec + at.into, { precise: true });
    render();
  },
};

/** Below this many seconds into a segment, "previous" means the segment before. */
const RESTART_WINDOW_SEC = 4;

const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);

function clampIndex(index, length) {
  const n = Number.isInteger(index) ? index : 0;
  return Math.min(Math.max(0, n), Math.max(0, length - 1));
}

/** The ±15/30 s buttons become previous/next segment inside a Foray. */
function setSkipButtonMode(isForay) {
  if (!ui) return;
  ui.backBtn.textContent = isForay ? "‹‹" : `↺ ${SEEK_BACK}`;
  ui.fwdBtn.textContent = isForay ? "››" : `${SEEK_FWD} ↻`;
  ui.backBtn.setAttribute("aria-label", isForay ? "Previous segment" : `Back ${SEEK_BACK} seconds`);
  ui.fwdBtn.setAttribute("aria-label", isForay ? "Next segment" : `Forward ${SEEK_FWD} seconds`);
}

window.ForayPlayer = ForayPlayer;
/* app.js is a classic script and this is a deferred module, so app.js cannot
   assume the bridge exists when it renders. One event, once, rather than a
   poll. */
window.dispatchEvent(new Event("forayplayer:ready"));

export default ForayPlayer;
