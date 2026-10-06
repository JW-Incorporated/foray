/* ui/tabbar.js — Tab bar: the four tabs and their active state.
   A CLASSIC script like app.js, not a module: it shares app.js's globals and
   is loaded by index.html after app.js, in the order listed in
   docs/redesign-2026/split-notes.md. Declarations only at the top level, so
   nothing here runs until app.js's boot (ui/boot.js) starts init(). */


/* ---------- U-02: the four-tab bar (docs/ui-transition-plan.md) ----------

   Built and appended in JS, exactly like the diagnostics/delete-my-data
   controls just above and for the identical reason stated on those: this
   card's owned files are app.js and styles.css (index.html is outside the
   auto-merge allowlist), so the bar cannot be a static element in
   index.html.

   APPENDED/REMOVED, NOT `hidden`-toggled. test/home-layout.test.js's own
   BUG 3 documents why: `[hidden] { display: none }` is a UA-stylesheet
   rule, and ANY author `display` declaration (which `.tab-bar { display:
   flex }` in styles.css necessarily is) beats it at any specificity. A
   `hidden` attribute on this element would therefore render anyway the
   moment its own display rule existed — exactly the bug that suite exists
   to catch. Appending only when the flag is on, and removing it the moment
   the flag goes off, sidesteps that cascade question entirely instead of
   relying on getting it right. */
const TAB_ROUTES = [
  { key: "home", label: "Home", hash: "#/",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>' },
  { key: "search", label: "Search", hash: "#/shows",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' },
  { key: "create", label: "Create", hash: "#/create",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>' },
  { key: "library", label: "Library", hash: "#/library",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 19V5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M15 3v5h5"/></svg>' },
];

/** Which tab a hash belongs to, for highlighting `aria-current`. EVERY ROUTE
    LIGHTS A TAB (audit 2026-09-22): Home; everything shows/episode/category-
    shaped to Search, including a browse pill's `#/shows/q/<label>` (the old
    `shows$` missed it, so tapping a pill ON the Search page un-lit Search);
    playlist/subject-queue-shaped to Create; and everything the listener keeps —
    Library's own sections (Up Next, Forays, Followed shows) and their Interests
    — to Library. Anything else is rendered as Home by the router, so it is
    Home here too: the two fallbacks used to disagree by construction, and an
    unrecognised hash showed the Home screen under a bar that said nowhere. */
function tabForHash(hash) {
  const h = currentHash(hash);
  if (/^#\/(shows($|\/)|show\/|category\/)/.test(h)) return "search";
  if (/^#\/(playlists$|playlist\/|subject\/|create$)/.test(h)) return "create";
  if (/^#\/(library$|queue$|forays$|foray\/|starred-shows$|interests$)/.test(h)) return "library";
  if (/^#\/episode\//.test(h)) return "search"; // reached from a show/search result
  return "home";
}

function onTabBarClick(e) {
  const a = e.target && typeof e.target.closest === "function" ? e.target.closest(".tab-btn") : null;
  if (!a) return;
  const href = currentHash(a.getAttribute("href"));
  const here = currentHash();
  if (href === here) { e.preventDefault(); scrollPageTo(0); return; }
  /* THE LIT SEARCH TAB GOES BACK TO THE SEARCH, NOT TO AN EMPTY PAGE (audit
     round 2, search-5). The tab's href is the bare root; from a result the
     listener opened (`#/show/<id>`, an episode) or from the results themselves
     (`#/shows/q/<q>`) that differs, so the browser navigated to `#/shows` and
     the query, the rows and the scroll went with it — round 1 taught ‹ to
     keep the query and not the tab. On the results page the tap is the
     same-tab gesture: to the top. From a pushed page it pops to the search
     that was left, which is what Apple's active tab does; a tab that was
     left at its root still pops to the root, by the ordinary navigation. */
  if (href === "#/shows" && tabForHash(here) === "search") {
    if (/^#\/shows\/q\//.test(here)) { e.preventDefault(); scrollPageTo(0); return; }
    if (lastSearchTabHash !== "#/shows") { e.preventDefault(); location.hash = lastSearchTabHash; }
  }
}

/** Renders (or removes) the tab bar to match the flag, and syncs which tab
    reads as current. Called from renderCurrentPage() so every navigation —
    real or a settings-toggle refresh — keeps it in sync, same as the
    drawer's own settings text. */
function renderTabBar() {
  let bar = $("#tab-bar");
  if (!bar) {
    bar = document.createElement("nav");
    bar.className = "tab-bar";
    bar.id = "tab-bar";
    for (const t of TAB_ROUTES) {
      const a = document.createElement("a");
      a.className = "tab-btn";
      a.href = t.hash;
      a.dataset.tabKey = t.key;
      a.innerHTML = `${t.icon}<span>${esc(t.label)}</span>`;
      bar.append(a);
    }
    /* TAPPING THE TAB YOU ARE ON TAKES YOU TO THE TOP (audit 2026-09-22) — the
       standard gesture in every iOS app. Assigning the hash that is already
       current fires no hashchange, so route() never ran and the tap did
       nothing at all. Delegated once, on the bar that lives for the page. */
    bar.addEventListener("click", onTabBarClick);
    document.body.append(bar);
    /* Created under an open sheet (the first-run explainer on a first visit):
       out of reach like everything else behind it. */
    inertUnderOpenSheet(bar);
  }
  const active = tabForHash(location.hash);
  bar.querySelectorAll(".tab-btn").forEach((a) => {
    if (a.dataset.tabKey === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}
