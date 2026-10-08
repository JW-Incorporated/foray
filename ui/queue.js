/* ui/queue.js — Up Next page (#/queue): the page, its two gestures, and nothing else.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Up Next page (#/queue), Redesign 2026, ambient ("Afterglow") ----------

   The page is Library's Up Next section given the whole screen (docs/redesign-2026/directions/ambient/BUILD-PLAN.md
   screen 13): the SAME QueueRow, the SAME row menu (Move up, Move down, Play next, Remove), the SAME Toast with Undo and
   the SAME five writers. It does not draw them a second time. ui/library.js owns `libQueueRowHtml`, `libOpenMenu`,
   `libMenuAct`, `libRemoveRow`, `libUndo`, `libSlideRows` and `repaintLibraryUpNext`; this page asks each of them, with
   one flag (`page`) that lifts the ten-row cap, swaps the section head for the page's own, and puts the two gestures on
   the rows. So a change to a QueueRow, the menu or the Toast is made once, and Library and this page cannot drift
   (they did before: the page had its own row with four arrow buttons).

   WHAT THIS OVERTURNS (named, as test-classification.md asks): the page's own row (a numbered `.ep-row` with ▶, ☆,
   a ⋮⋮ handle, Next, ↑, ↓ and ✕ in a wrapped row of controls) and the "N queued" sub-line; "card anatomy" (the row
   numbers go: the order is the order on screen, and a move says its new place aloud). The founder's two gestures stay
   (#762, PQ-04 drag to reorder, PQ-06 swipe to remove: both KEEP behaviour in test-classification.md) and so do their
   rules (player/queue-drag.js, player/queue-swipe.js); only what they are bound to changed.

   THE PAGE IS A LIVE VIEW (audit round 2, p-impatient-6). Every write of `cp_queue` goes through `saveQueueIds`, which
   repaints the section in place (app.js `repaintQueuePage` -> `repaintLibraryUpNext`, which reads the section's
   `data-lb-page`): the menu, the Toast, the scroll and the focus are not rebuilt under a press, and the playing row
   is redrawn when playback moves. Reorder and remove live HERE and in the Library section, not on the rows that add to
   the queue (docs/listening-queue-plan.md §1 Q3, the control-density note). */

function renderQueue() {
  libTeardown(); // the last paint's poll, Toast timer and open menu
  setBodyClass("view-library"); // the same shell as Library: no legacy top bar, the page paints Dusk's ground
  fullPool(); // populate itemIndex/poolIds so a live queued item can play in-app
  libUi.currentId = libCurrentId();
  $("#view").innerHTML = `
    <div class="ag lb-page qp-page is-settling">
      ${libCastHtml()}
      <section class="lb-section qp-section" data-lb-section="upnext" data-lb-page="queue">${libUpNextInnerHtml(true)}</section>
      ${libToastHtml()}
    </div>`;
  const view = $("#view");
  /* LIGHT FIRST, as Library does: the page's Glow is the playing item's, set in the same task as the markup. */
  libApplyGlow(view);
  bindLibrary(view);
  bindQueuePage(view);
  libSettle(view);
  libStartPoll();
}

/** The page's head: Back (to Library, where Up Next lives), the title, how many are queued, and Clear. `count` is the
    rows drawn (the playing row included); `queued` is what cp_queue holds, and Clear is offered for more than one. */
function queuePageHeadHtml(count, queued) {
  return `<header class="lb-head qp-head">
    <a class="back qp-back ag-btn ag-btn-icon" href="#/library" aria-label="Back">${agIcon("chevron-left", 24)}</a>
    <h2 class="t-title" tabindex="-1">Up Next</h2>
    ${count ? `<span class="t-caption qp-count">${esc(`${count} queued`)}</span>` : ""}
    ${count ? '<p class="sr-only" id="up-next-drag-hint">Drag to move this episode. Its menu has Move up and Move down.</p>' : ""}
    ${queued > 1 ? `<button type="button" class="ag-btn ag-btn-quiet up-next-clear" id="up-next-clear">Clear</button>` : ""}
  </header>`;
}

/** Everything the page adds to Library's section: Clear, the drag handles and the swipe. Bound again after every
    repaint of the section (repaintLibraryUpNext), each element once (`_bound`). */
function bindQueuePage(scope) {
  bindUpNextClear(scope);
  bindUpNextDrag(scope);
  bindUpNextSwipe(scope);
}

/* AFTER A DRAG OR A SWIPE, THE LISTENER IS STILL WHERE THEY WERE (audit 2026-09-22: two a11y findings and a persona,
   one cause). The section is repainted in place, so the pressed control is not destroyed, but a row that moved is a
   different row under the same thumb: focus goes to the same episode's handle in its new place, the page scrolls by
   exactly how far the handle moved so it lands back under the finger, and the new position is announced. A removal
   focuses the menu button of the row that took its place. (The menu's own Move up / Move down / Remove do the same in
   ui/library.js `libMenuAct`.) */
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
  const m = libUpNextModel();
  const pos = m.rest.indexOf(id) + 1;
  const target = queueButtonFor("data-drag-handle", id) || queueButtonFor("data-lb-menu", id);
  const topAfter = buttonTop(target);
  if (topBefore != null && topAfter != null && topAfter !== topBefore && typeof window.scrollBy === "function") {
    window.scrollBy(0, topAfter - topBefore);
  }
  focusQuietly(target);
  if (pos > 0) announce(`Moved to position ${pos} of ${m.rest.length}.`);
}

function afterQueueRemove(index) {
  const view = $("#view");
  const left = view ? [...view.querySelectorAll("[data-lb-menu]")] : [];
  focusQuietly(left[Math.min(index, left.length - 1)] || (view && view.querySelector("h2")));
  /* "Removed from Up Next." was said by libRemoveRow; the empty list is the one thing to add. */
  if (!left.length) announce("Up Next is empty.");
}

/* Clear: `saveQueueIds` repaints the section (the page is a live view of the list), so this only says what
   happened and puts focus on the heading: the Clear button itself is gone once one row or none is left. */
function bindUpNextClear(scope) {
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

/* DRAG TO REORDER (#762, PQ-04). Each row's handle carries the row to
   another slot. The ARITHMETIC — which slot the finger is over, whether the
   press has become a drag, whether the release means it — is
   `player/queue-drag.js` (PQ-03), published as `window.forayQueueDrag` by
   player/client.js; this binder only reads the layout once at the press, feeds
   it pointer samples and paints what it answers. "The menu remains"
   (DECISIONS 2026-09-23, lane L3, the Up Next model; it was the arrows): a
   drag is the quick way, not the only one.

   COMMIT ON RELEASE (DECISIONS 2026-09-23, lane L2): the move is written in
   `pointerup` through the one writer, `saveQueueIds`, with the order
   `player/queue-order.js` `moveTo` gives — never on the click a release may be
   followed by, and nothing at all for a press that never passed the 6 px lock
   or a gesture the system cancelled. Then the after-step: focus on the row in
   its new place, the row kept under the finger, the new position announced.

   THE ROWS ON SCREEN ARE THE LIST THE FINGER IS OVER. The playing row is drawn first, and is in cp_queue only when it
   was queued; so the move is made on the DRAWN order (`data-lb-q` of each row), the playing row stays first (a slot
   above it is the slot below it, as Move up on the second row is disabled), and an unqueued playing row is taken back
   out before the list is written.

   THE LIST SCROLLS UNDER A HELD FINGER (integration review, 2026-10-04): the
   scroll offset goes with every sample, and the slot is asked for again after
   each autoscroll nudge, so a row carried past the screen's edge lands where
   the finger is in the LIST, not where it was on the glass.

   `topBefore` for `afterQueueMove` is the handle's on-screen top at release,
   transform included, so the row lands back under the finger after the repaint. */
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
      const own = typeof btn.closest === "function" ? btn.closest(".qp-row") : null;
      const all = [...scope.querySelectorAll(".qp-row")];
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
      const shown = rows.map((el) => (el.dataset ? el.dataset.lbQ : null)).filter(Boolean);
      reset();
      const order = window.forayQueueOrder;
      if (!r.commit || !order || typeof order.moveTo !== "function") return;
      const m = libUpNextModel();
      /* The playing row is first on screen and stays first. */
      const pinned = m.current ? m.cur : null;
      const to = Math.max(pinned ? 1 : 0, r.to);
      const next = order.moveTo(shown, id, to);
      if (next === shown) return;
      saveQueueIds(pinned && !m.queued.includes(pinned) ? next.filter((x) => x !== pinned) : next);
      afterQueueMove(id, to < r.from ? -1 : 1, top);
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

/* SWIPE LEFT TO REMOVE (#762, PQ-06). A row, pulled left, takes the row out of
   Up Next. The ARITHMETIC — the 8 px direction lock (a vertical start is the
   list scrolling, for good), only leftward travel counts, how far or how fast
   a release must be, the rubber band past 160 px — is `player/queue-swipe.js`
   (PQ-05), published as `window.forayQueueSwipe` by player/client.js and read
   here lazily, null-guarded, when a gesture starts: no rules (app.js loaded
   without the player) means no swipe, and the menu's Remove still removes.

   ON THE ROW'S COVER, NOT THE BUTTONS: a QueueRow is a button laid over the whole row (`.lb-cover`, a tap plays it)
   with the handle and the menu above it, so the listeners sit on the cover, and a press on the handle or the menu
   is that control's and never starts a swipe. queue.css gives the cover `touch-action: pan-y`, so the browser keeps
   the vertical scroll and hands the horizontal travel to these listeners. The click a release is followed by is the
   gesture's end, not a tap to play: a claimed swipe tells the cover's click to stand down (`_lbSwallow`).

   COMMIT ON RELEASE (DECISIONS 2026-09-23, lane L2): the removal is
   `libRemoveRow` (the menu's Remove, so it has the same Toast and Undo) in `pointerup`, never on the click that may
   follow, and then the after-step (`afterQueueRemove`: focus on the menu of the row that took its place, "Removed
   from Up Next." said politely). A release short of the threshold, a scroll, or a gesture the system cancelled springs
   the row back and writes nothing. The playing row may be swiped away only if it is queued. */
function queueSwipeRules() {
  const r = window.forayQueueSwipe;
  return r && typeof r.startSwipe === "function" ? r : null;
}

function bindUpNextSwipe(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll(".qp-row > .lb-cover").forEach(info => {
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
      const own = typeof info.closest === "function" ? info.closest(".qp-row") : null;
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
      /* A claimed swipe is followed by a click on this button; it is not a tap to play. */
      if (swipe.claimed) {
        info._lbSwallow = true;
        if (typeof setTimeout === "function") setTimeout(() => { info._lbSwallow = false; }, 50);
      }
      reset();
      if (!r.remove || !id) return;
      const at = libUpNextModel().rest.indexOf(id);
      if (queueIds().indexOf(id) < 0) return;
      libRemoveRow(id);
      afterQueueRemove(Math.max(0, at));
    });
    const cancel = (e) => {
      if (!swipe || e.pointerId !== pointer) return;
      reset();
    };
    info.addEventListener("pointercancel", cancel);
    info.addEventListener("lostpointercapture", cancel);
  });
}
