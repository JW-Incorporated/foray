/* ui/tabbar.js — the Dock: three tabs, the mini player and Discover's field, one surface.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- THE DOCK (Redesign 2026, direction "ambient", Phase 4 screen "dock") ----------

   WHAT THIS REPLACES. The four-tab bar (U-02) plus the drawer's navigation, the
   full-width mini bar stacked on top of it, and the Search page's floating
   pill: four separate fixed bars. DIRECTION.md "Information architecture"
   overturns the rulings they pinned (named so the tests that follow can say
   which fell): "4 tabs + drawer" becomes THREE tabs and no drawer; dark-only is
   not touched here (tokens.css owns it).

   WHAT IT IS. One floating Veil surface (`.dock.veil`, tokens.css), inset by the
   gutter and 12px above the safe area, holding up to three rows, top to bottom:

     #dock-field   Discover only, 48. The page's own #sh-compose, ADOPTED: the
                   Search render still writes it into #view (its handlers bind
                   there), and syncDock() moves the node into this row once the
                   render is done, so the Dock is the field's only home.
     #dock-mini    64, while something is loaded (body.fp-open). player/client.js
                   builds the mini bar and hands it over through dockMountMini().
     #tab-bar      64, or 44 receded (the labels go, the row does not): Today `#/`, Discover `#/shows`, Library
                   `#/library`. `#tab-bar` and `.tab-btn` keep their names - the
                   harness (tools/ui-lab) waits on them.

   The rows are divided by the 1px rim tokens.css draws between non-hidden
   siblings, with no gap, so the veil never shows the page through a seam. THAT
   RULE READS THE `hidden` ATTRIBUTE, so a row is hidden with the attribute
   (syncDock), never with a class or an author `display`: a row hidden only by
   CSS would still be a "non-hidden sibling" and draw a stray rim line on the row
   below it.

   BEHIND AND AROUND IT, two decorations that live outside the Dock's box:
   `.dock-fade` (content fades to the page colour behind the Dock, solid from
   12px above its bottom edge, so its rounded corners never slice a line of text)
   and `#dock-cast` (a Glow radial rising from its top edge, only while
   something is loaded). Both are `aria-hidden`; neither takes a tap.

   STATE LIVES ON <body> AS CLASSES, not on the Dock, because the page's bottom
   padding, the cast and the fade all have to agree with it from CSS alone
   (ui/dock.css): `fp-open` (set by the player), `sh-compose` and `sh-searching`
   (the Search page), `kb-open` (the keyboard), and `dock-receded` (set here).
   setBodyClass() rewrites <body>'s class wholesale on every render, so
   renderTabBar() - which the router calls after each page paints - writes the
   receded class back, and drops it when the page changed (a new page starts at
   the top, and a tall tab row).

   NOT AN `.ag` SUBTREE, ON PURPOSE: the layer carries its own scope (`--text`, `--gutter`, a
   font, the button and icon resets) and declares its transitions only for `no-preference`
   (ui/dock.css sections 2 and 8), so it is instant under reduced motion and gates.mjs's
   reduced-motion gate reads 0 on it. BUILD-NOTES section 16 has the argument.

   NOT BUILT HERE: the Glow itself. Everything tinted reads `--glow` on <html>;
   until the Now Playing unit writes it per item, the Dock wears the warm default.

   APPENDED, NOT `hidden`-TOGGLED, for the reason U-02 gave and test/home-layout.test.js
   BUG 3 pins: `[hidden]` is a UA rule and any author `display` beats it. The
   layer is created once and kept; rows inside it use `hidden`, and ui/dock.css
   puts `[hidden] { display: none }` back above every author display it declares. */
/* THE FIELD'S WORDS BELONG TO THE DOCK, not to the page that rendered it. The Search page writes its own field
   ("Search shows and episodes..."); once that node is the Dock's top row it is Create's field as well (a subject
   named here builds a playlist, DIRECTION "Information architecture": "the one-field interaction was Create's good
   part"), and the placeholder has to say both halves or the second is undiscoverable. Applied when the node is
   adopted, so it holds for every render of Discover without that page's unit having to know. The accessible name
   matches the visible words (WCAG label-in-name). */
const DOCK_FIELD_COPY = "Search, or name a subject";

const TAB_ROUTES = [
  { key: "today", label: "Today", hash: "#/", icon: "house", fill: "house-fill" },
  { key: "discover", label: "Discover", hash: "#/shows", icon: "compass", fill: "compass-fill" },
  { key: "library", label: "Library", hash: "#/library", icon: "books", fill: "books-fill" },
];

/* How far the page must have scrolled DOWN before the tab row recedes (BUILD-NOTES §6:
   "after 80px of downward scroll, restores on any upward scroll"). */
const DOCK_RECEDE_AFTER_PX = 80;

let dockReceded = false;      // the tab row is at 44, not 64
let dockHash = null;          // the hash the receded state belongs to
let dockLastY = 0;            // the scroll offset the last scroll event saw
let dockFocusField = false;   // `#/create` was opened: Discover's field is owed focus once it is in the Dock
let dockFieldNode = null;     // the Search page's #sh-compose while it lives in the Dock's field row

/** Which tab a hash belongs to, for highlighting `aria-current`. EVERY ROUTE
    LIGHTS EXACTLY ONE TAB (audit 2026-09-22, kept): shows, show pages, browse
    pills, categories, a search-born subject and an episode reached from either
    belong to Discover; everything the listener keeps - Library itself, Up Next,
    Forays and a Foray's own page, Playlists and a playlist's page - to Library;
    Today, Tuning (it lives behind Settings, which hangs off Today) and anything
    the router renders as Today to Today. The two fallbacks used to disagree by
    construction (an unrecognised hash showed Today under a bar that said
    nowhere), so there is one default and it is Today's. The folded routes
    (`#/create`, `#/starred-shows`, `#/interests`) are aliased by currentHash()
    before they get here. */
function tabForHash(hash) {
  const h = currentHash(hash);
  if (/^#\/(shows($|\/)|show\/|category\/|subject\/|episode\/)/.test(h)) return "discover";
  if (/^#\/(library$|queue$|forays$|foray\/|playlists$|playlist\/)/.test(h)) return "library";
  return "today";
}

function onTabBarClick(e) {
  const a = e.target && typeof e.target.closest === "function" ? e.target.closest(".tab-btn") : null;
  if (!a) return;
  const href = currentHash(a.getAttribute("href"));
  const here = currentHash();
  if (href === here) { e.preventDefault(); scrollPageTo(0); return; }
  /* THE LIT DISCOVER TAB GOES BACK TO THE SEARCH, NOT TO AN EMPTY PAGE (audit
     round 2, search-5). The tab's href is the bare root; from a result the
     listener opened (`#/show/<id>`, an episode) or from the results themselves
     (`#/shows/q/<q>`) that differs, so the browser navigated to `#/shows` and
     the query, the rows and the scroll went with it — round 1 taught ‹ to
     keep the query and not the tab. On the results page the tap is the
     same-tab gesture: to the top. From a pushed page it pops to the search
     that was left, which is what Apple's active tab does; a tab that was
     left at its root still pops to the root, by the ordinary navigation. */
  if (href === "#/shows" && tabForHash(here) === "discover") {
    if (/^#\/shows\/q\//.test(here)) { e.preventDefault(); scrollPageTo(0); return; }
    if (lastSearchTabHash !== "#/shows") { e.preventDefault(); location.hash = lastSearchTabHash; }
  }
}

/** The page's scroll offset; 0 where there is no window (the suites' fake documents). */
function dockScrollY() {
  return typeof window === "undefined" ? 0 : Math.max(0, window.scrollY || window.pageYOffset || 0);
}

function dockEl(tag, cls, id) {
  const n = document.createElement(tag);
  n.className = cls;
  if (id) n.id = id;
  return n;
}

/** The tab bar: three links, each with BOTH glyphs - Regular for inert, Fill for the
    current tab - so a tab change is a change of glyph, visible in greyscale, and
    crossfades (opacity only) instead of swapping. Every interpolation is esc()'d.
    Returns the nav and its links. */
function dockTabBar() {
  const bar = dockEl("nav", "tab-bar", "tab-bar");
  bar.setAttribute("aria-label", "Primary");
  const tabs = [];
  for (const t of TAB_ROUTES) {
    const a = dockEl("a", "tab-btn");
    a.href = t.hash;
    a.dataset.tabKey = t.key;
    a.innerHTML = `<span class="tab-glyphs" aria-hidden="true"><span class="tab-glyph tab-glyph-off">${agIcon(t.icon, 28)}</span>` +
      `<span class="tab-glyph tab-glyph-on">${agIcon(t.fill, 28)}</span></span><span class="tab-label">${esc(t.label)}</span>`;
    bar.append(a);
    tabs.push(a);
  }
  /* TAPPING THE TAB YOU ARE ON TAKES YOU TO THE TOP (audit 2026-09-22) — the
     standard gesture in every iOS app. Assigning the hash that is already
     current fires no hashchange, so route() never ran and the tap did
     nothing at all. Delegated once, on the bar that lives for the page. */
  bar.addEventListener("click", onTabBarClick);
  return { bar, tabs };
}

/* The Dock's elements, held rather than re-queried: everything that touches the Dock
   goes through here, so no selector has to find a row inside another element. */
let dockRefs = null;

/** The Dock and its two decorations, created once. Returns the refs. */
function ensureDock() {
  if (dockRefs && dockRefs.layer.isConnected !== false) return dockRefs;
  /* `?posture=car` is the harness's way into car posture (BUILD-PLAN §0.4; the
     Bluetooth observer is Native and not built). The real way in is a 600ms
     long press on the mini bar (player/client.js). */
  try {
    if (/[?&]posture=car(&|$)/.test(location.search)) document.documentElement.setAttribute("data-posture", "car");
  } catch (_) { /* a stub location */ }
  const cast = dockEl("div", "dock-cast", "dock-cast");
  cast.setAttribute("aria-hidden", "true");
  cast.dataset.state = "idle";
  const layer = dockEl("div", "dock-layer", "dock-layer");
  const fade = dockEl("div", "dock-fade");
  fade.setAttribute("aria-hidden", "true");
  const dock = dockEl("div", "dock veil", "dock");
  const field = dockEl("div", "dock-field", "dock-field");
  field.hidden = true;
  const mini = dockEl("div", "dock-mini", "dock-mini");
  mini.hidden = true;
  const { bar, tabs } = dockTabBar();
  dock.append(field);
  dock.append(mini);
  dock.append(bar);
  layer.append(fade);
  layer.append(dock);
  document.body.append(cast);
  document.body.append(layer);
  dockRefs = { layer, cast, dock, field, mini, bar, tabs };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("scroll", onDockScroll, { passive: true });
  }
  /* Created under an open sheet (the first-run explainer on a first visit):
     out of reach like everything else behind it. */
  inertUnderOpenSheet(layer);
  return dockRefs;
}

/** player/client.js hands the mini bar (its progress line and the bar) to the Dock's
    mini row. True when the Dock took it; the player keeps its own copy when there is
    no Dock (its test harness loads none). */
function dockMountMini(progress, bar) {
  const { mini } = ensureDock();
  mini.append(progress);
  mini.append(bar);
  syncDock();
  return true;
}

/** Bring the Dock's rows in line with the page: the mini row follows `body.fp-open`
    (the player toggles it and calls this), the field row follows the Search page
    (`body.sh-compose`), and the cast follows the mini row. Idempotent. */
function syncDock() {
  if (!dockRefs) return;
  const { cast, field, mini } = dockRefs;
  const body = document.body;
  const playing = body.classList.contains("fp-open");
  mini.hidden = !playing;
  if (body.classList.contains("sh-compose")) {
    /* The Search render wrote a fresh #sh-compose into #view; move it up. #view comes
       before the Dock in the document, so the first #sh-compose is the new one while
       the old one still sits in the field row. A moved node loses focus, so this
       runs before the focus owed to `#/create`. */
    const compose = $("#sh-compose");
    if (compose && compose !== dockFieldNode) {
      if (typeof field.replaceChildren === "function") field.replaceChildren(compose);
      else { field.innerHTML = ""; field.append(compose); }
      dockFieldNode = compose;
      const fieldInput = typeof compose.querySelector === "function" ? compose.querySelector("#sh-input") : null;
      if (fieldInput && typeof fieldInput.setAttribute === "function") {
        fieldInput.setAttribute("placeholder", DOCK_FIELD_COPY);
        fieldInput.setAttribute("aria-label", DOCK_FIELD_COPY);
      }
    }
  } else if (dockFieldNode) {
    if (typeof field.replaceChildren === "function") field.replaceChildren();
    else field.innerHTML = "";
    dockFieldNode = null;
  }
  field.hidden = !dockFieldNode;
  if (dockFocusField && dockFieldNode) {
    const input = typeof dockFieldNode.querySelector === "function" ? dockFieldNode.querySelector("#sh-input") : null;
    if (input && typeof input.focus === "function") {
      dockFocusField = false;
      try { input.focus({ preventScroll: true }); } catch (_) { /* focus is best-effort */ }
    }
  }
  cast.dataset.state = playing ? "playing" : "idle";
}

/** `#/create` was opened: Discover's field is focused as soon as it is in the Dock. */
function dockFocusFieldNext() {
  dockFocusField = true;
}

/** Recede or restore the tab row: 64 to 44 with the labels fading, 280ms ease-out (ui/dock.css). */
function setDockReceded(on) {
  dockReceded = !!on;
  document.body.classList.toggle("dock-receded", dockReceded);
}

/** The scroll rule. Recede after 80px of DOWNWARD scroll; restore on ANY upward scroll
    (which includes the browser clamping the page back to the top). A scroll that does not
    move, or moves down inside the first 80px, changes nothing. */
function onDockScroll() {
  const y = dockScrollY();
  const dy = y - dockLastY;
  dockLastY = y;
  if (dy > 0 && y > DOCK_RECEDE_AFTER_PX) { if (!dockReceded) setDockReceded(true); }
  else if (dy < 0) { if (dockReceded) setDockReceded(false); }
}

/** Renders the Dock to match the page, and syncs which tab reads as current. Called
    from renderCurrentPage() so every navigation - real or a settings-toggle
    refresh - keeps it in sync. */
function renderTabBar() {
  const { tabs } = ensureDock();
  const active = tabForHash(location.hash);
  for (const a of tabs) {
    if (a.dataset.tabKey === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  syncDock();
  /* A NEW PAGE STARTS AT THE TOP, WITH A TALL TAB ROW; a repaint of the same page
     keeps whatever the listener's scrolling made of it. setBodyClass() has just
     dropped the class either way, so it is written back. */
  const h = currentHash();
  if (h !== dockHash) {
    dockHash = h;
    dockReceded = false;
    dockLastY = dockScrollY();
  }
  document.body.classList.toggle("dock-receded", dockReceded);
  /* THE LIBRARY TAB'S UP NEXT COUNT, on every page and from a cold start: nothing else writes cp_queue at boot, so without this
     the badge only appears after the first queue write or an Episode page. syncLibraryBadge lives in ui/episode.js, which loads
     after this file, hence the typeof guard (it is best-effort chrome and never throws). */
  if (typeof syncLibraryBadge === "function") syncLibraryBadge();
}
