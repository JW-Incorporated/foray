/* ui/queue.js — Up Next page (#/queue): rows, reorder, drag and swipe.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* The count printed here is `resolveParts(p).length` — the SAME call
   renderPlaylistDetail maps into rows, deliberately, so "7 parts" and five rows
   cannot come apart again (#276). It is a saved-length question, not a pool
   question, so this view needs no catalogue to answer it honestly. */
/* ---------- Up Next page (#/queue, docs/listening-queue-plan.md Stage 1) ----------

   Reachable from the drawer nav in the same place "Playlists" lives today
   (plan §1 Q4). Reuses the ep-row/gone visual language resolveParts/epRow/
   archivedRow already establish, per the plan's "same UI affordances,
   separate storage" rule (§2) — this page does not read or write
   cp_playlists, only cp_queue via queueRows().

   Reorder + remove live HERE, not on the row controls that add to the queue
   (epRow/archivedRow/renderEpisode/renderShow) — the plan's control-density
   note (§1 Q3) rules out stacking a fourth/fifth icon onto rows that already
   sit at their mobile-width ceiling. Play uses the existing single-episode
   playBtn/epRow-style playback; what plays after it is continuous playback's
   decision (§ continuous playback), and Up Next comes first there. */
function renderQueue() {
  setBodyClass("view-page");
  fullPool(); // populate itemIndex/poolIds so a live queued item can play in-app
  const rows = queueRows();
  $("#view").innerHTML = `
    <div class="page">
      <div class="page-head">
        <a class="back" href="#/">‹</a>
        <div><h2>Up Next</h2>${rows.length ? `<p class="sub">${rows.length} queued</p><p class="sr-only" id="up-next-drag-hint">Drag to move this episode. Move up and Move down still move it one step.</p>` : ""}</div>
        ${rows.length > 1 ? `<button type="button" class="up-next-clear" id="up-next-clear">Clear</button>` : ""}
      </div>
      ${rows.length
        ? rows.map((r, i) => upNextRow(r, i, rows.length)).join("")
        : `<p class="note">Nothing in Up Next yet — add an episode from any row's "+ Up Next" button.</p>`}
    </div>`;

  bindPickLogging($("#view"));
  bindStars($("#view"));
  bindPlay($("#view"));
  bindUpNextReorder($("#view"));
  bindUpNextDrag($("#view"));
  bindUpNextSwipe($("#view"));
}

/* One row: the SAME playable shape epRow/archivedRow already give (so a
   queued row looks and behaves like every other episode row in the app), plus
   up/down reorder controls and a remove control this page owns exclusively
   (see renderQueue's header comment for why those do not live on the add-side
   controls). `unnamed` (an id with neither a live pool entry nor a saved
   snapshot) still gets a row — a count that disagrees with what is on screen
   is the #276 defect this whole file works to avoid — just with no title,
   no play, no star, matching the `unnamed` branch resolveParts already draws
   for a playlist part with nothing to name it. */
function upNextRow(r, idx, total) {
  const { item, id, state } = r;
  const named = state !== "unnamed";
  const playable = state === "live";
  /* `UP_NEXT_CTX` on the ▶, so bindPlay knows a play from THIS page moves its
     row to the top (the Up Next model, § continuous playback). */
  const inApp = playable ? playBtn(item, UP_NEXT_CTX) : "";
  const title = named ? esc(item.title) : "Episode no longer available";
  /* The same "Played" / "NN min left" mark every other episode row carries
     (audit round 2, honesty-5): a half-finished queued episode looked fresh. */
  const prog = playable ? rowProgress(item) : null;
  const progHtml = prog && prog.label
    ? `<span class="ep-progress${prog.state === "played" ? " is-played" : ""}">${esc(prog.label)}</span>`
    : "";
  /* One sentence for the unnamed state, and it is about THIS page (copy-9): it
     used to say "Removed from your history", on a page that is not History,
     about an id that is still right there in the list. */
  const sub = state === "live"
    ? joinMeta(esc(item.show || ""), fmtDur(episodeMinutes(item)), progHtml)
    : state === "archived"
      ? joinMeta(esc(item.show || ""), fmtDur(episodeMinutes(item)), "not available right now")
      : "4a no longer has this episode's details";
  /* `.is-current` names the row the bar is on — playing OR paused — which the
     ❚❚ glyph alone signalled before (p-impatient-6). Repainted by
     `noteQueuePlaybackMoved` when playback moves. */
  let isCurrent = false;
  try { isCurrent = !!window.ForayPlayer?.isCurrent?.(id); } catch (_) { /* no player yet */ }
  /* Play next (#762, PQ-02) is disabled where it would change nothing: on the
     playing row, on the row already right after it (or row 1 with nothing
     playing) — `playNextOrder` returns the list unchanged for exactly those —
     and on a row 4a cannot play, which `playNextInQueue` refuses. */
  const ids = queueIds();
  const cur = currentPlayingId();
  const curIdx = cur ? ids.indexOf(cur) : -1;
  const playNextDisabled = !playable || isCurrent || id === cur || (curIdx >= 0 ? ids[curIdx + 1] === id : idx === 0);
  return `<div class="ep-row up-next-row ${playable ? "" : "gone"}${isCurrent ? " is-current" : ""}"${isCurrent ? ' aria-current="true"' : ""}>
    <span class="q-num">${idx + 1}</span>
    <div class="info" data-swipe-id="${esc(id)}">
      <div class="t">${title}</div>
      <div class="s">${sub}</div>
    </div>
    ${inApp}${named ? starBtn(item.id) : ""}
    <div class="up-next-reorder">
      <button type="button" class="reorder drag-handle" data-drag-handle="${esc(id)}" aria-label="Drag to reorder" aria-describedby="up-next-drag-hint">⋮⋮</button>
      <button type="button" class="reorder playnext" data-playnext="${esc(id)}" ${playNextDisabled ? "disabled" : ""} aria-label="Play next">Next</button>
      <button class="reorder up" data-reorder-up="${esc(id)}" ${idx === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
      <button class="reorder down" data-reorder-down="${esc(id)}" ${idx === total - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
    </div>
    <button class="up-next-remove" data-dequeue="${esc(id)}" aria-label="Remove from Up Next">✕</button>
    <span class="swipe-under" aria-hidden="true">Remove</span>
  </div>`;
}

/* AFTER A REORDER OR A REMOVE, THE LISTENER IS STILL WHERE THEY WERE (audit
   2026-09-22: two a11y findings and a persona, one cause). Every press used to
   end in `renderQueue()` and nothing else: the pressed button was destroyed, so
   focus fell to <body> and a keyboard or screen-reader user had to tab in from
   the top of the document for every single step; nothing announced the new
   position; and on a phone the row moved out from under the thumb, so the ↑
   now under it belonged to the episode that had just moved DOWN — three fast
   taps shuffled three different episodes one place each.

   The render is `saveQueueIds`'s now (the page is a live view of the list, see
   `repaintQueuePage`); what follows it is this. Focus goes to the same episode's button in its new row
   (the other arrow once it reaches an end, where its own is disabled), the
   page scrolls by exactly how far that button moved so it lands back under
   the finger, and the new position is announced. A remove focuses the ✕ of
   the row that took its place. */
function queueButtonFor(attr, id) {
  const view = $("#view");
  if (!view) return null;
  return [...view.querySelectorAll(`[${attr}]`)].find((b) => b.getAttribute(attr) === id) || null;
}

function buttonTop(btn) {
  if (!btn || typeof btn.getBoundingClientRect !== "function") return null;
  const r = btn.getBoundingClientRect();
  return r && Number.isFinite(r.top) ? r.top : null;
}

function afterQueueMove(id, dir, topBefore) {
  const ids = queueIds();
  const pos = ids.indexOf(id) + 1;
  const same = dir < 0 ? "data-reorder-up" : "data-reorder-down";
  const other = dir < 0 ? "data-reorder-down" : "data-reorder-up";
  let target = queueButtonFor(same, id);
  if (!target || target.disabled) target = queueButtonFor(other, id);
  const topAfter = buttonTop(target);
  if (topBefore != null && topAfter != null && topAfter !== topBefore && typeof window.scrollBy === "function") {
    window.scrollBy(0, topAfter - topBefore);
  }
  focusQuietly(target);
  if (pos > 0) announce(`Moved to position ${pos} of ${ids.length}.`);
}

function afterQueueRemove(index) {
  const view = $("#view");
  const left = view ? [...view.querySelectorAll("[data-dequeue]")] : [];
  focusQuietly(left[Math.min(index, left.length - 1)] || (view && view.querySelector("h2")));
  announce(left.length ? "Removed from Up Next." : "Removed from Up Next. Up Next is empty.");
}

function bindUpNextReorder(scope) {
  scope.querySelectorAll("[data-reorder-up]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.reorderUp;
      const top = buttonTop(btn);
      /* The repaint is `saveQueueIds`'s (the page is a live view of the list);
         these handlers only write, then put the listener back where they were. */
      moveQueueItem(id, -1);
      afterQueueMove(id, -1, top);
    });
  });
  scope.querySelectorAll("[data-reorder-down]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.reorderDown;
      const top = buttonTop(btn);
      moveQueueItem(id, 1);
      afterQueueMove(id, 1, top);
    });
  });
  scope.querySelectorAll("[data-dequeue]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const index = queueIds().indexOf(btn.dataset.dequeue);
      removeFromQueue(btn.dataset.dequeue);
      afterQueueRemove(Math.max(0, index));
    });
  });
  /* Play next (#762, PQ-02): a move like ↑, so the same after-step — focus on
     the row's arrow in its new place, the row kept under the finger, the new
     position announced. Nothing changed (already next) runs no after-step. */
  scope.querySelectorAll("[data-playnext]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.playnext;
      const top = buttonTop(btn);
      if (playNextInQueue(id)) afterQueueMove(id, -1, top);
    });
  });
  /* Clear: `saveQueueIds` repaints the page (it is a live view of the list), so
     this only says what happened and puts focus on the heading — the Clear
     button itself is gone once one row or none is left. */
  scope.querySelectorAll("#up-next-clear").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const n = clearQueue();
      announce(n === 1 ? "Removed 1 episode from Up Next." : `Removed ${n} episodes from Up Next.`);
      const view = $("#view");
      focusQuietly(view && typeof view.querySelector === "function" ? view.querySelector("h2") : null);
    });
  });
}

/* DRAG TO REORDER (#762, PQ-04). Each row's ⋮⋮ handle carries the row to
   another slot. The ARITHMETIC — which slot the finger is over, whether the
   press has become a drag, whether the release means it — is
   `player/queue-drag.js` (PQ-03), published as `window.forayQueueDrag` by
   player/client.js; this binder only reads the layout once at the press, feeds
   it pointer samples and paints what it answers. "The arrows remain"
   (DECISIONS 2026-09-23, lane L3, the Up Next model): a drag is the quick
   way, not the only one.

   COMMIT ON RELEASE (DECISIONS 2026-09-23, lane L2): the move is written in
   `pointerup` through the one writer, `saveQueueIds`, with the order
   `player/queue-order.js` `moveTo` gives — never on the click a release may be
   followed by, and nothing at all for a press that never passed the 6 px lock
   or a gesture the system cancelled. Then the arrows' own after-step: focus
   on the row in its new place, the row kept under the finger, the new
   position announced.

   THE LIST SCROLLS UNDER A HELD FINGER (integration review, 2026-10-04): the
   scroll offset goes with every sample, and the slot is asked for again after
   each autoscroll nudge, so a row carried past the screen's edge lands where
   the finger is in the LIST, not where it was on the glass.

   `topBefore` for `afterQueueMove` is the handle's on-screen top at release,
   transform included — the same kind of number the arrows hand it
   (`buttonTop`), so the row lands back under the finger after the repaint. */
function queueDragRules() {
  const r = window.forayQueueDrag;
  return r && typeof r.startRowDrag === "function" ? r : null;
}

function bindUpNextDrag(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  const scrollOffset = () => (typeof window.scrollY === "number" ? window.scrollY : 0);
  scope.querySelectorAll("[data-drag-handle]").forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    let drag = null;
    let pointer = null;
    let row = null;
    let rows = [];
    const unmark = () => rows.forEach((r) => { r.classList.remove("drop-before"); r.classList.remove("drop-after"); });
    /* Under the lock nothing moves: the press may still be a tap. Past it the
       row follows the finger and the row it would land beside is marked —
       above that row when it moves up, below it when it moves down. */
    const paint = (g) => {
      if (!drag || !row || !g.claimsTouch(drag)) return;
      if (row.style) row.style.transform = `translateY(${drag.offsetPx}px)`;
      unmark();
      const target = drag.over !== drag.fromIndex ? rows[drag.over] : null;
      if (target) target.classList.add(drag.over < drag.fromIndex ? "drop-before" : "drop-after");
    };
    const reset = () => {
      unmark();
      if (row) {
        row.classList.remove("is-dragging");
        if (row.style) row.style.transform = "";
      }
      drag = null;
      pointer = null;
      row = null;
      rows = [];
    };
    btn.addEventListener("pointerdown", (e) => {
      const g = queueDragRules();
      if (!g || pointer != null) return;
      if (typeof e.button === "number" && e.button !== 0) return; // primary button only
      const own = typeof btn.closest === "function" ? btn.closest(".up-next-row") : null;
      const all = [...scope.querySelectorAll(".up-next-row")];
      const index = all.indexOf(own);
      if (!own || index < 0) return;
      const rowTops = all.map((r) => {
        const b = typeof r.getBoundingClientRect === "function" ? r.getBoundingClientRect() : null;
        return b && Number.isFinite(b.top) ? b.top : 0;
      });
      row = own;
      rows = all;
      pointer = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* capture is best-effort */ }
      drag = g.startRowDrag({ index, y: e.clientY, t: e.timeStamp, rowTops, scrollY: scrollOffset() });
      row.classList.add("is-dragging");
    });
    btn.addEventListener("pointermove", (e) => {
      const g = queueDragRules();
      if (!drag || !g || e.pointerId !== pointer) return;
      drag = g.moveRowDrag(drag, e.clientY, e.timeStamp, scrollOffset());
      paint(g);
      /* Only a claimed drag scrolls the page: a press near the bottom edge
         that is still a tap must not nudge the list. */
      const vh = window.innerHeight;
      const d = g.claimsTouch(drag) && Number.isFinite(vh) ? g.autoscrollDelta(e.clientY, vh) : 0;
      if (d && typeof window.scrollBy === "function") {
        window.scrollBy(0, d);
        drag = g.moveRowDrag(drag, e.clientY, e.timeStamp, scrollOffset());
        paint(g);
      }
    });
    /* NON-passive, or the cancel is ignored: once the drag owns the finger the
       page under it must not pan (the sheet drag's rule, touch-2). */
    btn.addEventListener("touchmove", (e) => {
      const g = queueDragRules();
      if (drag && g && g.claimsTouch(drag) && e.cancelable !== false && typeof e.preventDefault === "function") e.preventDefault();
    }, { passive: false });
    btn.addEventListener("pointerup", (e) => {
      const g = queueDragRules();
      if (!drag || e.pointerId !== pointer) return;
      const r = g ? g.endRowDrag(drag) : { commit: false };
      const top = buttonTop(btn);
      const id = btn.dataset.dragHandle;
      reset();
      const order = window.forayQueueOrder;
      if (!r.commit || !order || typeof order.moveTo !== "function") return;
      const before = queueIds();
      const next = order.moveTo(before, id, r.to);
      if (next === before) return;
      saveQueueIds(next);
      afterQueueMove(id, r.to < r.from ? -1 : 1, top);
    });
    const cancel = (e) => {
      if (!drag || e.pointerId !== pointer) return;
      reset();
    };
    btn.addEventListener("pointercancel", cancel);
    /* Capture lost without a pointerup is a cancel; after a pointerup the drag
       is already over, so the release that follows finds nothing to undo. */
    btn.addEventListener("lostpointercapture", cancel);
  });
}

/* SWIPE LEFT TO REMOVE (#762, PQ-06). A row's text block, pulled left, takes
   the row out of Up Next. The ARITHMETIC — the 8 px direction lock (a
   vertical start is the list scrolling, for good), only leftward travel
   counts, how far or how fast a release must be, the rubber band past 160 px —
   is `player/queue-swipe.js` (PQ-05), published as `window.forayQueueSwipe` by
   player/client.js and read here lazily, null-guarded, when a gesture starts:
   no rules (app.js loaded without the player) means no swipe, and the ✕ still
   removes.

   ON THE TEXT BLOCK, NOT THE BUTTONS: the listeners sit on `.up-next-row >
   .info`, so a press on ▶, ☆, ⋮⋮ (its own drag), Next, ↑/↓ or ✕ is that
   control's and never starts a swipe. styles.css gives `.info` `touch-action:
   pan-y`, so the browser keeps the vertical scroll and hands the horizontal
   travel to these listeners.

   COMMIT ON RELEASE (DECISIONS 2026-09-23, lane L2): the removal is
   `removeFromQueue` in `pointerup`, never on the click that may follow, and
   then the ✕'s own after-step (`afterQueueRemove`: focus on the ✕ that took
   the row's place, "Removed from Up Next." said politely). A release short of
   the threshold, a scroll, or a gesture the system cancelled springs the row
   back and writes nothing. The playing row may be swiped away, as its ✕ may. */
function queueSwipeRules() {
  const r = window.forayQueueSwipe;
  return r && typeof r.startSwipe === "function" ? r : null;
}

function bindUpNextSwipe(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll(".up-next-row > .info").forEach(info => {
    if (info._swipeBound) return;
    info._swipeBound = true;
    let swipe = null;
    let pointer = null;
    let row = null;
    const reset = () => {
      if (row) {
        row.classList.remove("swiping");
        if (row.style) row.style.transform = "";
      }
      swipe = null;
      pointer = null;
      row = null;
    };
    info.addEventListener("pointerdown", (e) => {
      const g = queueSwipeRules();
      if (!g || pointer != null) return;
      if (typeof e.button === "number" && e.button !== 0) return; // primary button only
      const own = typeof info.closest === "function" ? info.closest(".up-next-row") : null;
      if (!own) return;
      row = own;
      pointer = e.pointerId;
      try { info.setPointerCapture(e.pointerId); } catch (_) { /* capture is best-effort */ }
      swipe = g.startSwipe(e.clientX, e.clientY, e.timeStamp);
    });
    info.addEventListener("pointermove", (e) => {
      const g = queueSwipeRules();
      if (!swipe || !g || e.pointerId !== pointer) return;
      swipe = g.moveSwipe(swipe, e.clientX, e.clientY, e.timeStamp);
      /* A vertical start is the list scrolling: let it go entirely. */
      if (swipe.rejected) { reset(); return; }
      if (!swipe.claimed) return; // under the lock: it may still be a tap
      row.classList.add("swiping");
      if (row.style) row.style.transform = `translateX(-${g.swipeOffset(swipe)}px)`;
    });
    /* NON-passive, or the cancel is ignored: once the swipe owns the finger
       the page under it must not pan (the sheet drag's rule, touch-2). */
    info.addEventListener("touchmove", (e) => {
      if (swipe && swipe.claimed && !swipe.rejected && e.cancelable !== false && typeof e.preventDefault === "function") e.preventDefault();
    }, { passive: false });
    info.addEventListener("pointerup", (e) => {
      const g = queueSwipeRules();
      if (!swipe || e.pointerId !== pointer) return;
      const r = g ? g.endSwipe(swipe) : { remove: false };
      const id = info.dataset ? info.dataset.swipeId : null;
      reset();
      if (!r.remove || !id) return;
      const index = queueIds().indexOf(id);
      if (index < 0) return;
      removeFromQueue(id);
      afterQueueRemove(index);
    });
    const cancel = (e) => {
      if (!swipe || e.pointerId !== pointer) return;
      reset();
    };
    info.addEventListener("pointercancel", cancel);
    info.addEventListener("lostpointercapture", cancel);
  });
}
