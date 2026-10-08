/* ui/drawer.js — Drawer: render, open/close, keyboard, action routing and the settings toggles.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- drawer ---------- */

function renderDrawer() {
  ensureInterestsDrawerLink();
  /* `|| ""` on both sides, same guard playlistsForYouHtml already carries: a
     playlist() backfills `created` on read, but this must not depend on that —
     a record that somehow still carries neither field must not throw
     `localeCompare` out of undefined and blank the drawer on every navigation
     (#558 item 1). */
  const recent = [...playlists()]
    .sort((a, b) => (b.last_played_at || b.created || "").localeCompare(a.last_played_at || a.created || ""))
    .slice(0, 5);
  $("#drawer-playlists").innerHTML = recent.map(p =>
    `<a class="drawer-item" href="#/${esc(playlistRoute(p))}">${esc(p.title)}</a>`).join("")
    || `<p class="drawer-empty">No playlists yet</p>`;
  /* Every switch's label, from the one registry `drawerToggle` fills. This was
     five ad-hoc lines — three unguarded, two guarded, each spelling its own
     on/off — and the sixth switch is what made that a shape rather than a
     list (finding 6, client audit 2026-09-12). */
  paintDrawerToggles();
  /* K-01: whether the RUN button exists at all. The toggle's own label is
     painted above with the others; this is the control that appears and
     disappears with it, which no label line can express. */
  syncVoiceProbeRun();
  /* NE-22d: the engine's Developer rows, which exist only where an engine
     answered (see § the engine's Developer rows). */
  syncEngineDevRows();
}

/* ---------- THE DRAWER IS A MODAL, WITH THE SAME CONTRACT AS A SHEET ----------

   Audit round 2, nav-5 (with touch-7 and a11y-4 folded in). The drawer is
   painted over everything (z 80/81) and behaved like a modal in no other
   sense: a drag on its scrim, or on the panel itself when its content fit the
   screen, scrolled the page behind it — close the drawer and you had lost
   your place; Escape did nothing; opening moved no focus and closing returned
   none; Tab walked out of it into the page; the ☰ said nothing about what it
   controls. Every sheet had all of that from the owner (`openSheet`) and the
   drawer, not being a sheet, had none.

   The same contract, from the same helpers: `body.drawer-open` locks the page
   scroll the way `body.fp-expanded` does (styles.css also gives the panel
   `overscroll-behavior: contain` and the scrim `touch-action: none`); the page,
   the tab bar and the player go `inert` through `inertOutside` — the topbar
   stays reachable (the ☰ must work at every moment, F17), so does the scrim
   (its tap closes the drawer) and so does the page's live region; focus moves
   to the first link on open. ON CLOSE, focus goes back to the ☰ only for a
   DISMISSAL (Escape, the scrim, hardware back): a link that navigates hands
   focus to the new page's heading through `landOnPage`, and a button that
   opens a sheet hands it to the ☰ through `openSheet`'s own drawer rule —
   returning it here first would make both of those think focus had survived.
   Not on the sheet stack, deliberately: the drawer is navigation chrome that
   sits OVER sheets (F17), never under them, and the one thing the stack would
   add — Escape — is `onDrawerKeydown`, which takes precedence while it is open
   (`onSheetKeydown` yields). */
const DRAWER_KEEPS_REACHABLE = [".topbar", "#drawer-overlay", "#a11y-status"];
let drawerInerted = [];

function drawerIsOpen() {
  const drawer = $("#drawer");
  return !!(drawer && !drawer.hidden);
}

/** The control that opens the drawer, and gets focus back from it. Today's knob
    (`#today-knob`, Tactile) IS the menu button while Home is on screen: the
    topbar's ☰ is hidden there, and focus handed to a hidden control is lost.
    Every other page keeps the ☰. */
function menuOpener() {
  const knob = $("#today-knob");
  return knob || $("#menu-btn");
}

function openDrawer(open, { toMenu = false } = {}) {
  const drawer = $("#drawer");
  const overlay = $("#drawer-overlay");
  const menu = menuOpener();
  const was = !!(drawer && !drawer.hidden);
  drawer.hidden = !open;
  overlay.hidden = !open;
  if (menu && typeof menu.setAttribute === "function") {
    menu.setAttribute("aria-expanded", open ? "true" : "false");
    if (typeof menu.getAttribute !== "function" || !menu.getAttribute("aria-controls")) menu.setAttribute("aria-controls", "drawer");
  }
  document.body.classList.toggle("drawer-open", !!open);
  if (open) {
    renderDrawer();
    if (was) return;                       // a re-render of an open drawer: nothing to take again
    drawerInerted = inertOutside(drawer, DRAWER_KEEPS_REACHABLE);
    const first = sheetFocusables(drawer)[0];
    if (!first && typeof drawer.setAttribute === "function"
        && (typeof drawer.getAttribute !== "function" || drawer.getAttribute("tabindex") == null)) {
      drawer.setAttribute("tabindex", "-1");
    }
    focusQuietly(first || drawer);
    return;
  }
  for (const el of drawerInerted) if (typeof el.removeAttribute === "function") el.removeAttribute("inert");
  drawerInerted = [];
  if (was && toMenu) focusQuietly(menu);
}

/** The drawer's half of the keyboard contract, reached through the one overlay
    listener (`onSheetKeydown`) while the drawer is open: Escape closes it and
    puts focus back on the ☰; Tab cycles the topbar and the drawer — the same
    belt-and-braces behind `inert` the sheets keep, for a WebView without it,
    and the reason a Tab from the ☰ walks into the open drawer rather than
    back into a covered sheet. */
function onDrawerKeydown(e) {
  if (!drawerIsOpen()) return;
  if (e.key === "Escape" || e.key === "Esc") {
    if (typeof e.preventDefault === "function") e.preventDefault();
    openDrawer(false, { toMenu: true });
    return;
  }
  if (e.key !== "Tab") return;
  const cycle = [];
  for (const root of [$(".topbar"), $("#drawer")]) {
    if (!root || root.hidden) continue;
    for (const el of sheetFocusables(root)) if (!cycle.includes(el)) cycle.push(el);
  }
  if (!cycle.length) return;
  if (typeof e.preventDefault === "function") e.preventDefault();
  const at = cycle.indexOf(document.activeElement);
  const next = at < 0
    ? (e.shiftKey ? cycle[cycle.length - 1] : cycle[0])
    : cycle[(at + (e.shiftKey ? cycle.length - 1 : 1)) % cycle.length];
  focusQuietly(next);
}

/* ---------- THE DRAWER LEAVES WHEN IT IS USED (founder, 2026-09-23) ----------

   "When I select Playback Diagnostics from the menu, the menu should
   automatically collapse but it does not." And the consequence, reported
   with it: "When I click outside the menu on the playback diagnostics, the
   menu does not collapse when it should. If I click above the playback
   diagnostics, where I can see a corner of the Home Screen, it will collapse
   both the menu and the playback diagnostics."

   WHAT WAS WRONG. The drawer closed for exactly one kind of item — a link,
   because `route()` closes it on navigation and the old click handler
   mirrored that for `<a>` — and for nothing else. Every button in it (Playback
   diagnostics, Narration voice, Delete my data, the probe's RUN) opened its
   sheet UNDER a drawer that stayed put: the sheet's `openSheet` then inerted
   the drawer and its overlay (both are outside the sheet), so the panel that
   paints on top of everything (z 81, over the sheet's 70) took no taps at
   all, and which of the two overlapping scrims a tap fell through to — the
   drawer's (inert) or the sheet's — is exactly the ambiguity the founder
   describes: nothing from most of the screen, both from one corner. Fixing
   the one item would leave the next button with the same bug.

   THE RULE, in one place: any control chosen from the drawer that has a
   DESTINATION — a page, a sheet — closes the drawer FIRST, in the capture
   phase, before the control's own handler runs. So a sheet never opens under
   the drawer, never inerts it, and its opener is already gone by the time
   `openSheet` records what to hand focus back to (that case is handled there:
   focus returns to the ☰). What STAYS open is declared on the control, not
   listed here: a settings switch flips in place (Joey, 2026-08-31 — the
   drawer must not close on a toggle; `drawerToggle` marks its buttons
   `data-drawer-stay`), and the Developer disclosure's <summary> only
   expands. A tap on the overlay closes the drawer and nothing else, whatever
   is under it — the Now Playing sheet keeps the drawer reachable (F17), so
   that is a real state; a tap on a sheet's scrim closes that sheet only.
   test/drawer-ownership.test.js pins each of these. */
const DRAWER_STAYS_OPEN_FOR = "[data-drawer-stay], summary";

function onDrawerAction(e) {
  const t = e && e.target;
  const item = t && typeof t.closest === "function" ? t.closest("a, button, summary") : null;
  if (!item) return;
  if (typeof item.closest === "function" && item.closest(DRAWER_STAYS_OPEN_FOR)) return;
  openDrawer(false);
  sameHashTap(item, e);
}

/** The ☰, the overlay, the wordmark, Escape and the drawer's own leave rule.
    Bound once from init(). */
function bindDrawerChrome() {
  $("#menu-btn").addEventListener("click", () => openDrawer($("#drawer").hidden));
  $("#drawer-overlay").addEventListener("click", () => openDrawer(false, { toMenu: true }));
  /* CAPTURE, deliberately: the drawer closes before the item acts, not after —
     see the block comment above. */
  $("#drawer").addEventListener("click", onDrawerAction, true);
  bindOverlayKeys();
  const mark = $(".wordmark");
  if (mark) mark.addEventListener("click", (e) => sameHashTap(mark, e));
}

/* ---------- the drawer's switches, in ONE shape ----------

   Six of them now, and until the 2026-09-12 client audit there were five
   copies of one idea: three bound by hand in `init()` against markup in
   index.html, two injected by near-identical fifteen-line twins
   (`bindDraftsControl`, `bindVoiceProbeControl`), and five ad-hoc label lines
   in `renderDrawer` — three unguarded, two guarded, each spelling its own
   on/off. Disclosure and test coverage were good; the COST was the sixth
   switch, which is exactly what `cp_interlude` needed.

   So: one `drawerToggle(id, label, read, write)`. A switch declares where its
   state lives and what a tap does; the helper owns everything that was being
   copied — adopting the button from index.html or appending one, binding the
   click exactly once, and registering the label so `renderDrawer` paints it
   with the rest.

   APPENDED, NOT `hidden`-TOGGLED, for the reason `renderTabBar`'s comment
   states and `test/home-layout.test.js`'s BUG 3 established: any author
   `display` declaration beats the UA stylesheet's `[hidden]` rule.

   A TAP NEVER CLOSES THE DRAWER (`renderCurrentPage`, never `route()` —
   test/drawer-settings-toggle.test.js's rule), and `repaint` is what says
   whether the page behind it has to be redrawn at all. */
const drawerToggles = [];

/**
 * @param {string}   id      the element id, in index.html or appended here
 * @param {string}   label   the text before the colon, e.g. "Family mode"
 * @param {Function} read    () => boolean — the CURRENT state, read fresh
 * @param {Function} write   (next: boolean) => void — persist it, log it
 * @param {object}   [opts]
 * @param {string[]} [opts.words]    the two state words, `[off, on]`
 * @param {boolean}  [opts.repaint]  redraw the page behind the drawer too
 * @param {Element}  [opts.into]     the container to append to — the drawer,
 *   unless it is a founder switch, which goes in `drawerDevGroup()`
 */
function drawerToggle(id, label, read, write, { words = ["off", "on"], repaint = false, into = null } = {}) {
  const drawer = $("#drawer");
  if (!drawer) return;
  if (!drawerToggles.some(t => t.id === id)) drawerToggles.push({ id, label, read, words });
  let btn = $("#" + id);
  if (!btn) {
    btn = ddEl("button", "drawer-item as-btn", "");
    btn.type = "button";
    btn.id = id;
    (into || drawer).appendChild(btn);
  }
  if (btn._drawerToggleBound) return; // init() runs once, but a re-bind must never stack handlers
  btn._drawerToggleBound = true;
  /* A SWITCH IS A SWITCH TO A SCREEN READER (audit round 2, a11y-8). These were
     plain buttons whose only state cue was the word after the colon, so
     VoiceOver read "Family mode: off, button" and, on activation, nothing —
     it does not re-read a focused button's changed text. `role="switch"` with
     `aria-checked` (painted with the label below) is what Settings' own
     toggles expose — "Family mode, switch, off" — and the flip is said. */
  btn.setAttribute("role", "switch");
  /* A switch flips IN the drawer and has nowhere to go, so the drawer stays
     (Joey, 2026-08-31). Declared on the control: `onDrawerAction` closes the
     drawer for everything that does not say this. */
  btn.dataset.drawerStay = "1";
  btn.addEventListener("click", () => {
    write(!read());
    renderDrawer();
    if (repaint) renderCurrentPage();
    /* NO announce() HERE (audit round 2 review). The switch stays focused and
       `paintDrawerToggles` flips its aria-checked in place, which VoiceOver and
       TalkBack already speak ("on"); a live-region line on top made every tap
       say it twice ("on", then "Family mode on"). Family mode's repaint
       redraws #view, not the drawer, so the focused switch survives it. */
  });
}

/** Every registered switch's label, read fresh. Guarded per element because a
    page can mount without one (a harness with a partial drawer) — the three
    unguarded lines this replaced threw on exactly that. The visible text keeps
    its "Family mode: off"; the NAME is the label alone, because the switch's
    own checked state already says on or off and "Family mode: off, switch, on"
    would say both. */
function paintDrawerToggles() {
  for (const t of drawerToggles) {
    const btn = $("#" + t.id);
    if (!btn) continue;
    const on = !!t.read();
    setControlLabel(btn, `${t.label}: ${t.words[on ? 1 : 0]}`, t.label);
    btn.setAttribute("aria-checked", String(on));
  }
}

/** The listener's three, in the drawer's reading order: two from index.html,
    the jingle appended. The founder's two are `bindDeveloperToggles`', which
    `init()` binds later so they land in the Developer group below the
    listener's settings. ("Open in", once a sixth switch, was deleted on
    2026-09-22 — it chose a link-out that no longer existed.) */
function bindDrawerToggles() {
  drawerToggle("family-toggle", "Family mode", familyMode, (on) => {
    lsSet("cp_family", on);
    logEvent("family_mode", { on });
    buildCards();
  }, { repaint: true });

  drawerToggle("autoadvance-toggle", "Continuous playback", autoAdvanceOn, (on) => {
    lsSet("cp_autoadvance", on);
    logEvent("autoadvance_pref", { on });
    /* The switch changes what the END of the playing episode does, so a
       player that was handed the plan ahead (the native engine's
       setContinuation) must hear it now, not at the next play (NE-13). */
    refreshEpisodeNavigation();
  });

  /* §13's jingle (player/interlude.js). THE CONTROL THE PRIVACY POLICY ALREADY
     PROMISED: `docs/legal/privacy-policy.md` lists `cp_interlude` as "On unless
     you turn it off", and until the 2026-09-12 client audit there was no way to
     turn it off — `writeInterludePref` and `PlayerQueueManager.setInterludeEnabled`
     were each called from their own test and nowhere else, and `client.js` read
     the key once at boot. A disclosed setting with no surface is a disclosure
     that is not true. */
  drawerToggle("interlude-toggle", "Jingle between clips", interludeOn, setInterludeOn);

  /* Downloads are Wi-Fi only unless the listener says otherwise (#29; roadmap
     README Q17, player-features §1 question 2: "a 'Download over cellular'
     switch, off"). Only where downloads exist at all: off the shell there is
     no bridge, no Download control, and so nothing for this to govern. Read
     at each enqueue, so it applies to the next download, not one in flight. */
  if (state.downloadBridge) {
    drawerToggle("downloads-cellular-toggle", "Download over cellular", downloadsCellularOn, setDownloadsCellular);
  }
}
