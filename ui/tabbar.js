/* ui/tabbar.js — the deck's tab row: three tabs, their active state, the Yours
   badge and the collapse-on-scroll.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- Tactile (Redesign 2026, Phase 4 group A `mini`): the deck ----------

   RULING THAT FELL HERE: D3, "4 tabs + drawer" (U-02/U-11). The Tactile
   direction the owner picked (2026-10-06) carries three tabs on a floating
   deck: Today, Find, Yours (docs/redesign-2026/directions/tactile/
   DIRECTION.md, "Information architecture and rulings overturned"). Create
   does not earn a tab: naming a subject becomes the Find field's second job,
   and a saved playlist is the listener's own, so it lives under Yours. The
   drawer's contents move behind the knob keycap on Today and Yours; that is
   the home and library screens' work, so the drawer itself is untouched here.

   The keys stay `home` / `search` / `library` (they are what every route maps
   to and what the rest of the app has always called these places); only the
   labels, the count and the look changed.

   Built and appended in JS, exactly like the diagnostics/delete-my-data
   controls: index.html is outside the auto-merge allowlist, so the bar cannot
   be a static element there.

   APPENDED, NEVER `hidden`-toggled. test/home-layout.test.js's own BUG 3
   documents why: `[hidden] { display: none }` is a UA-stylesheet rule, and ANY
   author `display` declaration beats it at any specificity. The badge below is
   the one `hidden` element here, and styles.css restates `[hidden]` for it.

   WHY THE TAB ROW AND THE MINI ARE TWO FIXED BOXES, NOT ONE `.deck` PARENT.
   `#foray-player` is the mini AND the Now Playing sheet. A parent with
   `backdrop-filter` (the deck's material) becomes the containing block of its
   fixed descendants, so the full-screen sheet inside the player would be
   trapped in a 361x129 box. So the deck is drawn as two fixed boxes that meet:
   the tab row at `bottom: safe-b + 12`, the mini stacked flush on top of it,
   one shadow cast by the tab row's `::after` around both (styles.css, "DIAL
   DECK"). */
const TAB_ROUTES = [
  { key: "home", label: "Today", hash: "#/", icon: "ph-sun-horizon" },
  { key: "search", label: "Find", hash: "#/shows", icon: "ph-magnifying-glass" },
  { key: "library", label: "Yours", hash: "#/library", icon: "ph-bookmarks" },
];

/** Which tab a hash belongs to, for highlighting `aria-current`. EVERY ROUTE
    LIGHTS EXACTLY ONE TAB (audit 2026-09-22, kept through the Tactile IA):
    Today; everything show/episode/category-shaped and the subject queues and
    Create's page (naming a subject is Find's second job) to Find; everything
    the listener keeps (Up Next, Forays, Followed shows, Interests, playlists)
    to Yours. Anything else is rendered as Today by the router, so it is Today
    here too: the two fallbacks used to disagree by construction. */
function tabForHash(hash) {
  const h = currentHash(hash);
  if (/^#\/(shows($|\/)|show\/|category\/|subject\/|create$)/.test(h)) return "search";
  if (/^#\/(library$|queue$|forays$|foray\/|starred-shows$|interests$|playlists$|playlist\/)/.test(h)) return "library";
  if (/^#\/episode\//.test(h)) return "search"; // reached from a show/search result
  return "home";
}

/* Haptics (BUILD-NOTES 6): a tab change is `selectionChanged`, the mini's
   swipe-dismiss is `impact HEAVY`. One shim for the deck. When the Now Playing
   module is loaded its shim is used instead, so the two share ONE 100ms
   throttle (BUILD-NOTES: "never twice in 100ms") rather than each keeping its
   own. No-op on the web build and when the OS has haptics off. */
let deckHapticAt = 0;
function deckHaptic(kind) {
  const np = typeof window !== "undefined" ? window.DialNowPlaying : null;
  if (np && typeof np.haptic === "function") { np.haptic(kind); return; }
  const now = Date.now();
  if (now - deckHapticAt < 100) return;
  deckHapticAt = now;
  try {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (!plugin) return;
    if (kind === "selection") plugin.selectionChanged();
    else plugin.impact({ style: kind === "heavy" ? "HEAVY" : kind === "medium" ? "MEDIUM" : "LIGHT" });
  } catch (_) { /* web build, or the OS said no: silent by design */ }
}

function onTabBarClick(e) {
  const a = e.target && typeof e.target.closest === "function" ? e.target.closest(".tab-btn") : null;
  if (!a) return;
  const href = currentHash(a.getAttribute("href"));
  const here = currentHash();
  if (href === here) { e.preventDefault(); scrollPageTo(0); return; }
  if ((a.dataset ? a.dataset.tabKey : null) !== tabForHash(here)) deckHaptic("selection");
  /* THE LIT FIND TAB GOES BACK TO THE SEARCH, NOT TO AN EMPTY PAGE (audit
     round 2, search-5). The tab's href is the bare root; from a result the
     listener opened (`#/show/<id>`, an episode) or from the results themselves
     (`#/shows/q/<q>`) that differs, so the browser navigated to `#/shows` and
     the query, the rows and the scroll went with it. On the results page the
     tap is the same-tab gesture: to the top. From a pushed page it pops to the
     search that was left, which is what Apple's active tab does. */
  if (href === "#/shows" && tabForHash(here) === "search") {
    if (/^#\/shows\/q\//.test(here)) { e.preventDefault(); scrollPageTo(0); return; }
    if (lastSearchTabHash !== "#/shows") { e.preventDefault(); location.hash = lastSearchTabHash; }
  }
}

/** One tab's markup: both icon weights stacked (Bold idle, Fill current; the
    CSS cross-fades them on --d-quick), the label, and on Yours the Up Next
    badge. Every string goes through esc(); the icons through tactileIcon(),
    whose href is safeUrl()'d. */
function tabMarkup(t) {
  const badge = t.key === "library" ? '<span class="tab__badge" hidden></span>' : "";
  return '<span class="tab__icon" aria-hidden="true">' +
    tactileIcon(t.icon).replace('class="i"', 'class="i i--bold"') +
    tactileIcon(t.icon + "-fill").replace('class="i"', 'class="i i--fill"') +
    badge + "</span>" +
    '<span class="tab__label">' + esc(t.label) + "</span>";
}

/** Up Next's length, for the Yours badge. `queueIds()` is app.js's one reader of
    `cp_queue`; a harness without it reads as empty, never as a throw. */
function upNextCount() {
  try { return typeof queueIds === "function" ? queueIds().length : 0; }
  catch (_) { return 0; }
}

/** The Yours badge (BUILD-NOTES 3.11: ultramarine, 18px, mono 11), present
    ONLY when Up Next is non-empty. The tab's accessible
    name carries the count, because the badge itself is inside the
    aria-hidden icon wrapper. Called on every route render and from
    saveQueueIds(), the one writer of cp_queue. */
function paintTabBadge(bar) {
  const host = bar || $("#tab-bar");
  if (!host) return;
  const yours = Array.from(host.querySelectorAll(".tab-btn")).find((a) => a.dataset.tabKey === "library");
  if (!yours) return;
  const badge = yours.querySelector(".tab__badge");
  const n = upNextCount();
  if (badge) {
    badge.hidden = n === 0;
    /* A count readout inside the aria-hidden icon wrapper, not a control: the
       tab's own aria-label (below) carries the name, so the text goes through
       app.js's `setStatusText` (written only when it changes) rather than a
       hand-written control label (test/toggle-labels.test.js). */
    setStatusText(badge, n > 99 ? "99+" : String(n));
  }
  if (n > 0) yours.setAttribute("aria-label", "Yours, " + n + " queued");
  else yours.removeAttribute("aria-label");
}

/* ---------- the deck collapses on scroll-down, returns on scroll-up ----------

   BUILD-NOTES 3.11: on scroll-down past 24px the labels fade and the tab row
   drops 64 -> 48; ANY scroll-up brings it back. A scroll-driven animation
   (`animation-timeline: scroll()`) maps a POSITION to a state, and this rule
   is about DIRECTION (the deck must return on the first upward flick, deep in
   a list), which a position timeline cannot express. So the plan's other
   branch is the mechanism everywhere: one passive listener, throttled to one
   evaluation per 100ms (with a trailing call so the last position always
   counts), and CSS does the motion on --d-quick. Decision recorded in
   docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.4.

   `deckCollapseStep` is the whole rule as a pure function, so the suite can
   drive it without a browser. `anchor` is where the current downward run
   began; it moves to wherever the listener turns around. */
const DECK_COLLAPSE_PX = 24;
function deckCollapseStep(state, y) {
  const s = state || { y: 0, anchor: 0, collapsed: false };
  const at = Math.max(0, Number(y) || 0);
  if (at <= 0) return { y: at, anchor: 0, collapsed: false };
  if (at < s.y) return { y: at, anchor: at, collapsed: false };
  return { y: at, anchor: s.anchor, collapsed: s.collapsed || at - s.anchor > DECK_COLLAPSE_PX };
}

let deckCollapseState = { y: 0, anchor: 0, collapsed: false };
let deckCollapseInstalled = false;
let deckLastHash = null;
function applyDeckCollapse() {
  const y = typeof window.scrollY === "number" ? window.scrollY : 0;
  const next = deckCollapseStep(deckCollapseState, y);
  deckCollapseState = next;
  if (document.body && document.body.classList) document.body.classList.toggle("deck-collapsed", next.collapsed);
}

function installDeckCollapse() {
  if (deckCollapseInstalled || typeof window.addEventListener !== "function") return;
  deckCollapseInstalled = true;
  let last = 0;
  let trailing = null;
  const run = () => { trailing = null; last = Date.now(); applyDeckCollapse(); };
  window.addEventListener("scroll", () => {
    const wait = 100 - (Date.now() - last);
    if (wait <= 0) run();
    else if (!trailing) trailing = setTimeout(run, wait);
  }, { passive: true });
}

/** Renders the tab row once and syncs which tab reads as current, the
    indicator's slot and the badge. Called from renderCurrentPage() so every
    navigation keeps it in sync. A navigation also brings a collapsed deck
    back: a new page starts at its top. */
function renderTabBar() {
  let bar = $("#tab-bar");
  if (!bar) {
    bar = document.createElement("nav");
    bar.className = "tab-bar";
    bar.id = "tab-bar";
    bar.setAttribute("aria-label", "Main");
    const indicator = document.createElement("span");
    indicator.className = "tab-bar__ind";
    indicator.setAttribute("aria-hidden", "true");
    bar.append(indicator);
    for (const t of TAB_ROUTES) {
      const a = document.createElement("a");
      a.className = "tab-btn";
      a.href = t.hash;
      a.dataset.tabKey = t.key;
      a.innerHTML = tabMarkup(t);
      bar.append(a);
    }
    /* TAPPING THE TAB YOU ARE ON TAKES YOU TO THE TOP (audit 2026-09-22): the
       standard gesture in every iOS app. Delegated once, on the bar that lives
       for the page. */
    bar.addEventListener("click", onTabBarClick);
    document.body.append(bar);
    /* Created under an open sheet (the first-run explainer on a first visit):
       out of reach like everything else behind it. */
    inertUnderOpenSheet(bar);
    installDeckCollapse();
  }
  const active = tabForHash(location.hash);
  const index = Math.max(0, TAB_ROUTES.findIndex((t) => t.key === active));
  bar.setAttribute("data-active", String(index));
  bar.querySelectorAll(".tab-btn").forEach((a) => {
    if (a.dataset.tabKey === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  paintTabBadge(bar);
  /* A NEW PAGE starts at its top, so the deck comes back with it; a repaint of
     the same page (a settings toggle re-renders in place) leaves it alone. */
  const hash = currentHash();
  if (hash !== deckLastHash) {
    deckLastHash = hash;
    deckCollapseState = { y: 0, anchor: 0, collapsed: false };
    if (document.body && document.body.classList) document.body.classList.remove("deck-collapsed");
  }
}
