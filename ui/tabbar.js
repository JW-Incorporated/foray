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
/* REDESIGN 2026, ambient (DIRECTION.md "Information architecture"): THREE tabs, Today, Discover, Library.
   The Create tab is gone (its one field lives in Discover); the ruling that fell is "Four tabs (Home,
   Search, Create, Library) + drawer menu" (test-classification.md section 0). The glyphs are the Phosphor
   sprite through agIcon(): the Regular drawing for an inert tab, the FILL drawing for the active one ("a
   state change is a fill, never only a colour"). The keys stay `home` / `search` / `library`: they are
   internal ids that tabForHash, the search-tab pop and the harness already speak, and renaming them would
   touch four suites for no listener-visible gain. */
const TAB_ROUTES = [
  { key: "home", label: "Today", hash: "#/", icon: "house" },
  { key: "search", label: "Discover", hash: "#/shows", icon: "compass" },
  { key: "library", label: "Library", hash: "#/library", icon: "books" },
];

/** One tab's glyph: Regular when inert, Fill when it is the current tab. */
function tabGlyph(t, on) {
  return agIcon(on ? t.icon + "-fill" : t.icon, 28);
}

/** Which tab a hash belongs to, for highlighting `aria-current`. EVERY ROUTE
    LIGHTS A TAB (audit 2026-09-22): Home; everything shows/episode/category-
    shaped to Search, including a browse pill's `#/shows/q/<label>` (the old
    `shows$` missed it, so tapping a pill ON the Search page un-lit Search);
    playlist/subject-queue-shaped (and Create's own page, which folded into Discover's field) to Discover; and everything the listener keeps —
    Library's own sections (Up Next, Forays, Followed shows) and their Interests
    — to Library. Anything else is rendered as Home by the router, so it is
    Home here too: the two fallbacks used to disagree by construction, and an
    unrecognised hash showed the Home screen under a bar that said nowhere. */
function tabForHash(hash) {
  const h = currentHash(hash);
  if (/^#\/(shows($|\/)|show\/|category\/)/.test(h)) return "search";
  if (/^#\/(playlists$|playlist\/|subject\/|create$)/.test(h)) return "search";
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
      a.dataset.tabGlyph = "regular";
      a.innerHTML = `${tabGlyph(t, false)}<span>${esc(t.label)}</span>`;
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
    const on = a.dataset.tabKey === active;
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    /* The glyph follows the state, and is rewritten only when it changed. */
    const t = TAB_ROUTES.find((r) => r.key === a.dataset.tabKey);
    const want = on ? "fill" : "regular";
    if (t && a.dataset.tabGlyph !== want) {
      a.innerHTML = tabGlyph(t, on) + "<span>" + esc(t.label) + "</span>";
      a.dataset.tabGlyph = want;
    }
  });
}
