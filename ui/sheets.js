/* ui/sheets.js — Sheet infrastructure: openSheet / closeSheet, focus management, inert, slide motion, drag.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/** Explanation + consent, not an interview, then an optional Preferences
    pane — the mockup's Welcome and Preferences screens (docs/ux/foray-
    mockup.jsx, `WelcomeScreen`/`PrefsScreen`) as ONE modal sheet with two
    panes swapped in place, per D2 / card U-09 (docs/ui-transition-plan.md,
    #132). SKIPPABLE AT EVERY STEP:

      Step 1 (Welcome) — two value props, the M3 prototype's `finishOnb`/
      `skipOnb` preference-INTERVIEW step has no counterpart here and this
      still does not build one (see the test that pins that). The second
      prop is illustrated with a live, non-interactive SegmentStrip
      (player/segment-strip.js's segmentStripHtml, U-04) over the first
      listable Foray, when one exists — degrades to nothing otherwise, the
      same "no Foray, no strip" rule the component already guarantees.
      "Skip for now" dismisses immediately, with no interest write. "Get
      started" advances to step 2 WITHOUT dismissing yet.

      Step 2 (Preferences) — the taxonomy chip grid (PREFS_CHIP_IDS) plus
      the mockup's tucked-away "Or type a subject yourself…" field. Neither
      the mockup's account-connector buttons ("Continue with Apple/Google")
      nor "Import subscriptions/listening history" are built here —
      connector features, explicitly out of scope per D2/C5. "Skip" dismisses
      with no interest write (Generalist: today's taxonomy defaults stand).
      "Show my picks" applies the picks via applyOnboardingPicks() — the
      FIXED U-07 write path (taxonomyNodes() includes roots, so a root-level
      chip actually persists) — then dismisses, and when something was
      written re-deals Home's card slots and repaints, so the FIRST Home the
      listener lands on already ranks by the picks (the card's third
      acceptance line; see redealAfterOnboardingPicks()).

    Both steps' exits set the SAME cp_intro_dismissed flag showIntroPopupOnce()
    already uses, so this flow and the older popup can never both show on the
    same visit and neither shows again after. */
/* ---------- ONE OWNER FOR "A MODAL IS OPEN" (audit 2026-09-22, theme E) ----------

   Before this, nothing in the app owned the question. Eight sheets — the
   first-run explainer, the intro popup, the Foray feedback sheet, both speed
   pickers, Delete my data, Narration voice, Playback diagnostics — each
   declared `role="dialog"` + `aria-modal="true"` and then implemented none of
   what those attributes promise: focus stayed behind the scrim, Tab walked the
   covered page, Escape did nothing, and a screen reader kept reading the page
   underneath. Each one also wrote `body.fy-sheet-open` with its own add/remove
   pair, so the Foray speed menu could stack two copies (and one Cancel took the
   lock off with a sheet still up), and a back gesture over the feedback sheet —
   which lives inside #view and dies with it — left `overflow: hidden` on
   <body> with no sheet on screen. The full-screen Now Playing sheet had no
   dialog semantics at all.

   The fix the audit asked for, at the level the defect is at: ONE owner, and
   every sheet opens and closes through it.

     openSheet(wrap, opts)  remember what had focus; take the rest of the page
                            out of reach (`inert` on every sibling up the tree
                            from the sheet, except `keepReachable`); move focus
                            into the panel; keep Tab inside it; route Escape to
                            the sheet's own close; single instance per element
                            and per id; derive the body class from the stack.
     closeSheet(wrap)       undo exactly what open did, hand focus back, and
                            re-derive the body class. Idempotent.
     closeAllSheets() /     ASK each sheet to close through its own handler (a
     closeSheetsWithin(el)  sheet may refuse — Delete my data never vanishes
                            mid-delete), for navigation and for a page render
                            that is about to destroy the sheet's DOM.

   THE BODY CLASS IS A FUNCTION OF THE STACK, not a flag toggled by eight
   callers. `setBodyClass()` asks `sheetBodyClasses()` instead of carrying
   `fy-sheet-open` forward blindly, and an entry whose element has left the
   document is dropped first — so a sheet that died with #view can no longer
   leave the page scroll-locked.

   `--kb-inset` is the other half of theme E and lives in styles.css: every
   `.fy-panel` sits on the keyboard's top edge, so a sheet with a text field
   (feedback note, "Type DELETE") is no longer stranded behind it.

   Focus goes to the PANEL, not its first control: the panel carries the
   dialog's name, so a screen reader announces the dialog, and focusing a text
   field would throw a soft keyboard over the sheet the instant it opened.

   player/client.js is an ES module and cannot import from this classic
   script, so the owner is published as `window.ForaySheets` for the Now
   Playing sheet and the mini player's speed picker. app.js runs first (the
   module is deferred), so it is always there by the time either can open. */
const SHEET_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const sheetStack = [];
const SHEET_KEEPS_PLAYER_CLASS = "fy-sheet-keeps-player";
const sheetManagedClasses = new Set(["fy-sheet-open", SHEET_KEEPS_PLAYER_CLASS]);
let sheetKeysBound = false;

function sheetIsLive(entry) {
  /* `isConnected` is undefined on the node:vm DOM stubs several suites use;
     only an explicit `false` means the element has left the document. */
  return !!entry && !!entry.wrap && entry.wrap.isConnected !== false;
}

function sheetFocusables(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return [...root.querySelectorAll(SHEET_FOCUSABLE)].filter(
    (el) => !el.hidden && !(typeof el.closest === "function" && el.closest("[hidden]")),
  );
}

function focusQuietly(el) {
  if (!el || typeof el.focus !== "function") return;
  try { el.focus({ preventScroll: true }); } catch (_) { /* a detached node */ }
}

/* Every sibling of the sheet, and of each of its ancestors up to <body>, is
   taken out of reach — the page, the tab bar, the mini player, another sheet
   underneath. `inert` (not only `aria-hidden`) because it removes pointer AND
   keyboard AND assistive-technology access in one attribute. Only elements
   this call actually changed are recorded, so closing restores exactly what
   opening did and never un-inerts something another sheet still needs. */
function inertOutside(wrap, keepReachable) {
  const changed = [];
  const keep = (el) => keepReachable.some((sel) => typeof el.matches === "function" && el.matches(sel));
  let node = wrap;
  while (node && node.parentElement && node !== document.body) {
    const parent = node.parentElement;
    for (const sib of [...(parent.children || [])]) {
      if (sib === node || keep(sib)) continue;
      const tag = String(sib.tagName || "").toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      if (typeof sib.hasAttribute === "function" && sib.hasAttribute("inert")) continue;
      if (typeof sib.setAttribute !== "function") continue;
      sib.setAttribute("inert", "");
      changed.push(sib);
    }
    node = parent;
  }
  return changed;
}

function releaseInert(entry) {
  for (const el of entry.inerted) {
    if (typeof el.removeAttribute === "function") el.removeAttribute("inert");
  }
  entry.inerted = [];
  /* Hand back what this sheet LIFTED from a sheet below it (see liftInertFrom),
     if that sheet is still open. */
  for (const { el, owner } of entry.lifted || []) {
    if (!sheetStack.includes(owner) || typeof el.setAttribute !== "function") continue;
    el.setAttribute("inert", "");
    owner.inerted.push(el);
  }
  entry.lifted = [];
}

/**
 * A SHEET OPENED OVER ANOTHER MAY ALREADY BE INERT (review 2026-09-23).
 * The voice, diagnostics and delete sheets are built at startup as hidden
 * <body> children, so expanding Now Playing inerts them with everything else;
 * the drawer stays reachable over Now Playing (F17) and opens them, and
 * `openSheet` only un-hid the wrap. The new sheet came up inert — its scrim,
 * Close and rows ignored every tap — over a drawer and topbar it had just
 * inerted itself: on a phone with no Escape key, the app was stuck.
 * So an `inert` on the wrap or its ancestors that a sheet BELOW set is lifted
 * for as long as this one is open, and handed back when it closes.
 */
function liftInertFrom(wrap) {
  const lifted = [];
  for (let n = wrap; n && n !== document.body; n = n.parentElement) {
    if (typeof n.hasAttribute !== "function" || !n.hasAttribute("inert")) continue;
    const owner = sheetStack.find((s) => s.inerted.includes(n));
    if (!owner) continue; // someone else's inert is not ours to lift
    n.removeAttribute("inert");
    owner.inerted = owner.inerted.filter((x) => x !== n);
    lifted.push({ el: n, owner });
  }
  return lifted;
}

/**
 * An element added to <body> while a sheet is open joins what the top sheet
 * took out of reach (review 2026-09-23). `inertOutside` runs once, when the
 * sheet opens, and the first-run explainer opens from Home's render BEFORE
 * `renderTabBar` creates the tab bar on a first visit — so the first modal a
 * new listener saw left the four tab links live behind it, where assistive
 * tech that ignores aria-modal could reach them (and a tab navigation
 * dismisses onboarding for good). Kept-reachable chrome stays reachable.
 */
function inertUnderOpenSheet(el) {
  pruneDeadSheets();
  const top = sheetStack[sheetStack.length - 1];
  if (!top || !el || typeof el.setAttribute !== "function") return;
  if (typeof top.wrap.contains === "function" && top.wrap.contains(el)) return;
  if (typeof el.hasAttribute === "function" && el.hasAttribute("inert")) return;
  if ((top.keep || []).some((sel) => typeof el.matches === "function" && el.matches(sel))) return;
  el.setAttribute("inert", "");
  top.inerted.push(el);
}

/** Drop entries whose element has left the document (a sheet that lived in
    #view and died with a render), releasing what they held. */
function pruneDeadSheets() {
  for (let i = sheetStack.length - 1; i >= 0; i--) {
    if (sheetIsLive(sheetStack[i])) continue;
    releaseInert(sheetStack[i]);
    sheetStack.splice(i, 1);
  }
}

/** The body classes the open sheets imply. Read by setBodyClass(), so a page
    render keeps a lock that is still true and drops one that is not. */
function sheetBodyClasses() {
  pruneDeadSheets();
  const out = new Set(sheetStack.map((s) => s.bodyClass));
  /* A sheet that keeps the PLAYER reachable lifts it over its scrim (audit
     round 2 review of p-first-5) — only while the TOP sheet is such a one, so
     a modal opened over it covers the bar again. */
  const top = sheetStack[sheetStack.length - 1];
  if (top && (top.keep || []).includes("#foray-player")) out.add(SHEET_KEEPS_PLAYER_CLASS);
  return [...out];
}

function syncSheetBodyClasses() {
  const want = new Set(sheetBodyClasses());
  for (const cls of sheetManagedClasses) document.body.classList.toggle(cls, want.has(cls));
}

/** The one document keydown listener for every overlay. Bound lazily by the
    first `openSheet` and by `bindSettingsChrome`, whichever comes first. */
function bindOverlayKeys() {
  if (sheetKeysBound || typeof document.addEventListener !== "function") return;
  document.addEventListener("keydown", onSheetKeydown);
  sheetKeysBound = true;
}

function onSheetKeydown(e) {
  pruneDeadSheets();
  const top = sheetStack[sheetStack.length - 1];
  if (!top) return;
  if (e.key === "Escape" || e.key === "Esc") {
    e.preventDefault();
    top.requestClose();
    return;
  }
  if (e.key !== "Tab") return;
  /* The trap is belt and braces behind `inert`: a WebView without `inert`
     support still keeps Tab inside the dialog. */
  const items = sheetFocusables(top.panel);
  const active = document.activeElement;
  const inside = !!(active && typeof top.panel.contains === "function" && top.panel.contains(active));
  /* WHAT THE SHEET KEEPS REACHABLE IS INSIDE THE TRAP (review 2026-09-23).
     The Now Playing sheet leaves the topbar and the drawer reachable (F17: the
     ☰ at every moment), but the trap only knew the panel: Tab wrapped from the
     sheet's last control to its first and never reached the ☰, and with the
     drawer opened by pointer the next Tab yanked focus out of the drawer back
     into the covered sheet. The kept chrome now sits in the cycle, in document
     order ahead of the sheet: … → last control → ☰ (→ the drawer's links, when
     it is open) → first control → … */
  const kept = keptFocusables(top);
  const inKept = !!(active && kept.includes(active));
  if (!items.length && !kept.length) { e.preventDefault(); focusQuietly(top.panel); return; }
  const cycle = [...kept, ...items];
  if (inKept || (kept.length && inside)) {
    const at = cycle.indexOf(active);
    if (at >= 0) {
      e.preventDefault();
      focusQuietly(cycle[(at + (e.shiftKey ? cycle.length - 1 : 1)) % cycle.length]);
      return;
    }
  }
  if (!items.length) { e.preventDefault(); focusQuietly(top.panel); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (!inside || active === first || active === top.panel)) {
    e.preventDefault(); focusQuietly(last);
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault(); focusQuietly(first);
  }
}

/** The focusable controls inside the chrome a sheet keeps reachable
    (`keepReachable`), in the order given — the ☰ first, then an open drawer's
    links. A closed drawer is `hidden`, so it contributes nothing. */
function keptFocusables(entry) {
  const out = [];
  for (const sel of entry.keep || []) {
    let roots = [];
    try { roots = typeof document.querySelectorAll === "function" ? [...document.querySelectorAll(sel)] : []; } catch (_) { roots = []; }
    for (const root of roots) {
      if (root.hidden) continue;
      for (const el of sheetFocusables(root)) if (!out.includes(el)) out.push(el);
    }
  }
  return out;
}

/**
 * Open `wrap` as THE modal. Returns its stack entry.
 * @param {Element} wrap  the sheet's outermost element (`.fy-sheet`, or the
 *   Now Playing `.fp-sheet`); appended to <body> if it is not in the document.
 * @param {object} [opts]
 * @param {Element} [opts.panel]  what focus goes to and Tab cycles within;
 *   default the `[role="dialog"]` inside `wrap`, else `wrap`.
 * @param {Function} [opts.onRequestClose]  what Escape / navigation call — the
 *   sheet's OWN close, which must end in closeSheet(wrap). Default: closeSheet.
 * @param {string} [opts.bodyClass]  the body lock this sheet implies.
 * @param {string[]} [opts.keepReachable]  selectors left out of `inert`.
 * @param {Element} [opts.returnFocus]  where focus goes on close when the
 *   element that opened the sheet is gone.
 */
function openSheet(wrap, opts = {}) {
  if (!wrap) return null;
  pruneDeadSheets();
  const already = sheetStack.find((s) => s.wrap === wrap);
  if (already) return already;
  /* SINGLE INSTANCE BY ID: a second, different element claiming the same id
     (the Foray speed menu, built fresh on each open) replaces the first
     rather than stacking over it with duplicate ids. */
  if (wrap.id) {
    const twin = sheetStack.find((s) => s.wrap.id === wrap.id);
    if (twin) closeSheet(twin.wrap, { removeIfOwned: true });
  }
  if (wrap.isConnected === false || !wrap.parentElement) document.body.appendChild(wrap);
  bindOverlayKeys();
  const panel = opts.panel
    || (typeof wrap.querySelector === "function" && wrap.querySelector('[role="dialog"]'))
    || wrap;
  const opener = document.activeElement || null;
  const entry = {
    wrap, panel,
    requestClose: typeof opts.onRequestClose === "function" ? opts.onRequestClose : () => closeSheet(wrap),
    bodyClass: opts.bodyClass || "fy-sheet-open",
    opener,
    returnFocus: opts.returnFocus || null,
    inerted: [],
    lifted: [],
    keep: opts.keepReachable || [],
  };
  sheetManagedClasses.add(entry.bodyClass);
  wrap.hidden = false;
  entry.lifted = liftInertFrom(wrap);
  entry.inerted = inertOutside(wrap, entry.keep);
  sheetStack.push(entry);
  syncSheetBodyClasses();
  if (typeof panel.getAttribute === "function" && panel.getAttribute("tabindex") == null
      && typeof panel.setAttribute === "function") {
    panel.setAttribute("tabindex", "-1");
  }
  focusQuietly(panel);
  bindPanelDrag(entry);
  return entry;
}

/* ---------- a sheet moves, and every panel can be pulled down ----------

   Audit round 2, touch-4 and touch-8. Every `.fy-panel` in the app paints the
   same 38×4 handle the Now Playing sheet does — "so a fifth sheet cannot look
   like a different product" (client.js) — and only Now Playing answered a
   drag: eight false affordances, learned on the one sheet that taught the
   gesture. And no sheet had any motion at all: Now Playing appeared with a
   hard cut and, dismissed by a pull, vanished from mid-screen.

   THE OWNER BINDS THE GESTURE, because the owner is the one place every sheet
   already passes through: `openSheet` knows the panel and knows how to ask the
   sheet to close (`entry.requestClose`, the same path Escape takes). The
   decision — how far, what counts as a flick, and the rule that a pull
   started inside a scrolled body is a scroll — is player/sheet-drag-dismiss.js,
   read through `window.ForayPlayer.sheetDrag` (a classic script cannot import
   it), so the Now Playing sheet and these panels drag by one rule. Absent
   bridge (a harness, a page paired with an older cached module): no drag, and
   the handle is what it was.

   THE MOTION IS ONE FUNCTION PAIR for both sheet kinds: `slideIn` unhides a
   panel at its own height and releases it to 0 through the transition
   styles.css gives it; `slideOut` sends it to its height and reports when it
   has settled (`transitionend`, or a timer a beat longer than the transition,
   because a `display: none` mid-flight or a tab in the background fires no
   event). `prefers-reduced-motion` is honoured HERE, once, by not moving at
   all — styles.css switches the transitions off for the same query, and a
   caller that waited for a transition that never runs would hang on the
   timer. */
const SHEET_MOTION_MS = 220;   // styles.css: `.fp-sheet` and `.fy-panel` transitions are .22s

function reducedMotion() {
  try {
    return !!(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (_) { return false; }
}

/** Force a style flush so a property written before this and one written after
    it are two states the transition can run between. */
function reflow(el) {
  try { if (typeof el.getBoundingClientRect === "function") el.getBoundingClientRect(); } catch (_) { /* a stub */ }
}

function canSlide(el, px) {
  return !!(el && el.style && typeof el.style.setProperty === "function" && px > 0) && !reducedMotion();
}

/** Unhidden and off the bottom, then released to rest. `noMotionClass` is the
    caller's "no transition" class (the sheet's dragging class), put on for the
    first write so the panel jumps to its start rather than sliding there. */
function slideIn(el, prop, px, noMotionClass) {
  if (!canSlide(el, px)) return false;
  if (noMotionClass && el.classList) el.classList.add(noMotionClass);
  el.style.setProperty(prop, `${px}px`);
  reflow(el);
  if (noMotionClass && el.classList) el.classList.remove(noMotionClass);
  el.style.setProperty(prop, "0px");
  return true;
}

/** Sent to its full height from wherever it is; `done` runs once, when it has
    settled. Returns false — and runs nothing — when it cannot move, so the
    caller closes at once. */
function slideOut(el, prop, px, done) {
  if (!canSlide(el, px)) return false;
  let settled = false;
  let timer = null;
  const onEnd = (e) => { if (!e || e.target === el) finish(); };
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer != null) clearTimeout(timer);
    if (typeof el.removeEventListener === "function") el.removeEventListener("transitionend", onEnd);
    done();
  };
  if (typeof el.addEventListener === "function") el.addEventListener("transitionend", onEnd);
  timer = setTimeout(finish, SHEET_MOTION_MS + 80);
  reflow(el);
  el.style.setProperty(prop, `${px}px`);
  return true;
}

function panelHeightPx(el) {
  try {
    const h = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect().height : 0;
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch (_) { return 0; }
}

/** Drag-to-dismiss on a `.fy-panel`, bound once per panel. The Now Playing
    sheet (`.fp-sheet`) binds its own in client.js against the same module;
    this is the same wiring for the panels the owner builds or is handed. */
function bindPanelDrag(entry) {
  const panel = entry && entry.panel;
  if (!panel || panel._dragBound || typeof panel.addEventListener !== "function") return;
  /* A `.fy-panel`, or any panel that opts in with `data-sheet-drag` (the Afterglow Sheets: the gear's, "What 4a
     does"). The offset is the same `--fy-panel-dy` either way, so a screen's own CSS reads it for its transform. */
  if (!panel.classList || typeof panel.classList.contains !== "function") return;
  const optedIn = typeof panel.hasAttribute === "function" && panel.hasAttribute("data-sheet-drag");
  if (!panel.classList.contains("fy-panel") && !optedIn) return;
  panel._dragBound = true;
  const gest = () => (window.ForayPlayer && window.ForayPlayer.sheetDrag) || null;
  let drag = null;
  let pointer = null;
  /* The property is named in full here, not through a constant: styles.css
     reads `--fy-panel-dy` and test/ui-tokens.test.js accepts a token nothing
     declares only when a `setProperty` names it. */
  const paint = (px) => {
    if (!panel.style || typeof panel.style.setProperty !== "function") return;
    panel.style.setProperty("--fy-panel-dy", `${px > 0 ? px : 0}px`);
    panel.classList.toggle("fy-panel-dragging", px > 0);
  };
  panel.addEventListener("pointerdown", (e) => {
    const g = gest();
    if (!g || pointer != null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const t = e.target;
    /* A press on a control is that control's — the same rule client.js keeps
       for the scrub thumb; `summary` because the Developer disclosure lives
       in a panel too. */
    if (t && typeof t.closest === "function" && t.closest("button, a, input, select, textarea, summary, label")) return;
    const fromHandle = !!(t && typeof t.closest === "function" && t.closest(".fy-grab"));
    drag = g.start(e.clientY, e.timeStamp, { fromHandle, atTop: (panel.scrollTop || 0) <= 0 });
    pointer = e.pointerId;
    /* CAPTURED (audit round 3, app-2-10), as the Foray strip's is: a mouse has
       no implicit capture, so a release over the scrim or outside the window
       never reached this panel and left the drag stuck — displaced, and
       ignoring every later press. */
    try { panel.setPointerCapture?.(e.pointerId); } catch (_) { /* capture is best-effort */ }
  });
  panel.addEventListener("pointermove", (e) => {
    const g = gest();
    if (!drag || !g || e.pointerId !== pointer) return;
    drag = g.move(drag, e.clientY, e.timeStamp);
    paint(g.offset(drag));
  });
  /* NON-passive, or the cancel is ignored: the panel is its own scroller and
     only a cancelled touchmove keeps a pull-down at scrollTop 0 from becoming
     a rubber-band scroll (touch-2, the same mechanism on the Now Playing
     sheet and the Foray strip). */
  panel.addEventListener("touchmove", (e) => {
    const g = gest();
    if (drag && g && g.claimsTouch(drag) && e.cancelable !== false && typeof e.preventDefault === "function") e.preventDefault();
  }, { passive: false });
  panel.addEventListener("pointerup", (e) => {
    const g = gest();
    if (!drag || !g || e.pointerId !== pointer) return;
    const { dismiss } = g.end(drag);
    drag = null;
    pointer = null;
    if (!dismiss) { paint(0); return; }
    /* The release transition applies from wherever the finger left it. Then
       the sheet's OWN close (Escape's path): a sheet that declines — Delete my
       data mid-delete — springs back, and one that closed is reset while
       hidden so its next open starts at rest. */
    panel.classList.remove("fy-panel-dragging");
    const finish = () => { entry.requestClose(); paint(0); };
    if (!slideOut(panel, "--fy-panel-dy", panelHeightPx(panel), finish)) finish();
  });
  const cancel = (e) => {
    if (!drag || e.pointerId !== pointer) return;
    drag = null;
    pointer = null;
    paint(0);
  };
  panel.addEventListener("pointercancel", cancel);
  /* Capture lost without a pointerup (the window lost focus, the element was
     hidden) is a cancel. After a pointerup the drag is already over, so the
     implicit release that follows it finds nothing to undo. */
  panel.addEventListener("lostpointercapture", cancel);
}

/** Close `wrap` if the owner holds it: lift what open did, hide it, hand focus
    back. Sheets above it close first — they were opened over it. Returns
    whether anything was open. `removeIfOwned` also removes the element (for
    sheets built fresh on each open). */
function closeSheet(wrap, { removeIfOwned = false } = {}) {
  const i = sheetStack.findIndex((s) => s.wrap === wrap);
  if (i === -1) return false;
  while (sheetStack.length - 1 > i) closeSheet(sheetStack[sheetStack.length - 1].wrap);
  const [entry] = sheetStack.splice(i, 1);
  releaseInert(entry);
  wrap.hidden = true;
  if (removeIfOwned && typeof wrap.remove === "function") wrap.remove();
  syncSheetBodyClasses();
  /* An opener inside a hidden subtree (a drawer button after the drawer
     closed) cannot take focus — `focus()` on it is a silent no-op and focus
     falls to <body>, which is the "where am I" a screen-reader user reports.
     Skip it so `returnFocus` gets its turn. */
  const back = [entry.opener, entry.returnFocus].find(
    (el) => el && el.isConnected !== false && typeof el.focus === "function" && el !== document.body
      && !inHiddenSubtree(el),
  );
  /* ONLY IF THE SHEET STILL HOLDS FOCUS (audit round 2, touch-8). A close can
     now settle a beat after it was asked — the sheet slides out first — and
     a navigation under Now Playing lands focus on the new page's heading in
     that beat (`landOnPage`). Handing it back to the opener then would take it
     off the page the listener just asked for. Focus that is inside the sheet,
     on <body>, or stranded in something hidden is the sheet's to return;
     focus that has moved on is left where it is. */
  const active = document.activeElement;
  const held = !active || active === document.body || inHiddenSubtree(active)
    || (typeof wrap.contains === "function" && wrap.contains(active));
  if (held) focusQuietly(back);
  return true;
}

/** Whether `el` or any ancestor carries `hidden` — a node that cannot be
    rendered, and therefore cannot be focused. */
function inHiddenSubtree(el) {
  for (let n = el; n; n = n.parentElement) if (n.hidden) return true;
  return false;
}

/** Ask every open sheet to close through its own handler, top first. A sheet
    that declines (Delete my data while it is deleting) stays. */
function closeAllSheets() {
  pruneDeadSheets();
  for (const entry of [...sheetStack].reverse()) {
    if (sheetStack.includes(entry)) entry.requestClose();
  }
}

/** The sheets living inside `root` — asked to close before a render replaces
    it, so the owner's stack and the body lock never outlive their DOM. */
function closeSheetsWithin(root) {
  if (!root || typeof root.contains !== "function") return;
  for (const entry of [...sheetStack].reverse()) {
    if (!sheetStack.includes(entry) || !root.contains(entry.wrap)) continue;
    entry.requestClose();
    if (sheetStack.includes(entry)) closeSheet(entry.wrap); // its DOM is about to go regardless
  }
}

function openSheetCount() {
  pruneDeadSheets();
  return sheetStack.length;
}

if (typeof window !== "undefined") {
  window.ForaySheets = { openSheet, closeSheet, closeAllSheets, openSheetCount, slideIn, slideOut };
}
