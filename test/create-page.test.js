/* U-06's Create screen (docs/ui-transition-plan.md D7+D8, kanban card
 * t_bd3f749a): the mockup's Create screen, restyled, with the Foray |
 * Playlist toggle rendered but Foray permanently DISABLED with honest copy.
 * Playlist mode is today's buildPlaylist() flow in the new chrome.
 *
 * WHAT THIS PROVES, in order:
 *  1. route() dispatches #/create to renderCreate().
 *  2. The Foray | Playlist toggle renders both options.
 *  3. The Foray option carries a real `disabled` attribute — not merely a
 *     dimmed style — so it is not focusable as a control (the card's own
 *     acceptance line, checked directly rather than assumed from CSS).
 *     MUTATION (named per card ask): remove `disabled` from the Foray
 *     button -> this test goes red.
 *  4. Honest copy ("Custom Forays aren't available yet") is on the page.
 *  5. The mockup's ~20/~40/~75 Foray-specific length options are NOT shown
 *     here (D8: they have no meaning for a playlist of whole episodes).
 *  6. Submitting the subject field calls the real buildPlaylist() and, on
 *     success, navigates to the SAME #/playlist/:id destination the old
 *     #/playlists page's own form produces — i.e. building from Create
 *     produces the same cp_playlists entry as building from Playlists (the
 *     card's acceptance line).
 *  7. A subject with no match shows the honest empty-state note, matching
 *     bindPlaylistFormSubmit's own copy rules.
 *  8. Clicking a suggested subject pill fills the input.
 *  9. The Create tab (U-02) now routes at #/create — covered together with
 *     the rest of the tab-bar suite in test/tab-bar.test.js; not duplicated
 *     here.
 *
 * Every test names the mutation that kills it, per CLAUDE.md.
 *
 * HARNESS: the same real-DOM-with-parent/child-tracking + tiny selector
 * engine as test/tab-bar.test.js, because renderCreate() creates real
 * elements, wires real addEventListener click handlers (the subject pills),
 * and this suite drives clicks/submits against them — a flat by-id stub
 * cannot answer "what happened when this button was clicked".
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "", className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {},
    children: [], parent: null, _attrs: {},
    href: undefined,
    classList: {
      add(...cs) { el.className = [...new Set([...(el.className ? el.className.split(/\s+/) : []), ...cs])].join(" "); },
      remove(...cs) { el.className = el.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" "); },
      toggle(c, on) {
        const has = el.className.split(/\s+/).includes(c);
        const want = on === undefined ? !has : !!on;
        if (want && !has) el.classList.add(c);
        if (!want && has) el.classList.remove(c);
      },
      contains: (c) => el.className.split(/\s+/).includes(c),
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    _fire(type, evt) {
      for (const fn of listeners.get(type) || []) fn(evt || { preventDefault() {}, currentTarget: el });
    },
    appendChild(k) { k.parent = el; el.children.push(k); return k; },
    append(...ks) { for (const k of ks) { k.parent = el; el.children.push(k); } },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    querySelector(sel) { return matchAll(el, sel)[0] || null; },
    querySelectorAll(sel) { return matchAll(el, sel); },
  };
  return el;
}

/* Enough of a selector engine for what renderCreate()'s markup + wiring
   needs: #id, .class, [data-x], and "tag[type='...']" for the real <input>/
   <button> elements set via `.innerHTML =` below (parsed by parseInto). */
function matchAll(root, sel) {
  const s = String(sel).trim();
  const test1 = (node) => {
    if (s.startsWith("#")) return node.id === s.slice(1);
    if (s.startsWith(".")) return node.className.split(/\s+/).includes(s.slice(1));
    const dataAttr = /^\[data-([\w-]+)\]$/.exec(s);
    if (dataAttr) return Object.prototype.hasOwnProperty.call(node._attrs, `data-${dataAttr[1]}`);
    const typeSel = /^([a-z0-9]+)\[type='([^']+)'\]$/i.exec(s);
    if (typeSel) return node.tagName.toLowerCase() === typeSel[1].toLowerCase() && node._attrs.type === typeSel[2];
    const m = /^([a-z0-9]+)(\.[\w-]+)?$/i.exec(s);
    if (m) {
      const [, tag, cls] = m;
      if (node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      if (cls && !node.className.split(/\s+/).includes(cls.slice(1))) return false;
      return true;
    }
    return false;
  };
  const out = [];
  (function walk(node) {
    for (const c of node.children) {
      if (test1(c)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

/* Parses the small, known subset of HTML renderCreate() emits into real
   makeEl() nodes so #cr-form's real querySelector('input')/querySelector
   ('button') and the pill click-binding loop (`querySelectorAll
   ('[data-cr-subject]')`) all resolve against real elements, exactly the
   way $("#view").innerHTML = ...; $("#view").querySelectorAll(...) does in
   app.js against a real browser DOM. Deliberately narrow: it only has to
   parse renderCreate()'s own output, not arbitrary HTML. */
function parseInto(container, html) {
  container.children = [];
  const formMatch = /<form id="cr-form"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  if (formMatch) {
    const form = makeEl("form");
    form.id = "cr-form";
    container.appendChild(form);
    const inputMatch = /<input id="cr-input" type="text"[^>]*>/.exec(formMatch[1]);
    if (inputMatch) {
      const input = makeEl("input");
      input.id = "cr-input";
      input._attrs.type = "text";
      form.appendChild(input);
    }
    const btnMatch = /<button type="submit">/.exec(formMatch[1]);
    if (btnMatch) {
      const btn = makeEl("button");
      btn._attrs.type = "submit";
      btn.textContent = "Build";
      form.appendChild(btn);
    }
  }
  const noteMatch = /<p id="cr-note"([^>]*)>/.exec(html);
  if (noteMatch) {
    const note = makeEl("p");
    note.id = "cr-note";
    note.hidden = /hidden/.test(noteMatch[1]);
    container.appendChild(note);
  }
  const pillRe = /<button type="button" class="cr-pill" data-cr-subject="([^"]*)">/g;
  let pm;
  while ((pm = pillRe.exec(html))) {
    const pill = makeEl("button");
    pill.className = "cr-pill";
    pill._attrs["data-cr-subject"] = pm[1];
    pill.dataset.crSubject = pm[1];
    container.appendChild(pill);
  }
  const forayBtnMatch = /<button type="button" class="([^"]*)" data-cr-mode="foray"([^>]*)>/.exec(html);
  if (forayBtnMatch) {
    const btn = makeEl("button");
    btn.className = forayBtnMatch[1];
    btn._attrs["data-cr-mode"] = "foray";
    btn.disabled = /\bdisabled\b/.test(forayBtnMatch[2]);
    if (btn.disabled) btn._attrs.disabled = "disabled";
    container.appendChild(btn);
  }
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn", "banner-slot",
  "sh-form", "sh-input", "sh-note", "sh-results", "ep-search-results",
  "pl-form", "pl-input", "pl-note",
  "fy-sheet-note", "fy-scrim", "fy-sheet-cancel", "fy-sheet-go",
  "fy-play", "fy-next", "fy-prev", "fy-strip",
];

function mount({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const body = makeEl("body");
  const byId = new Map();
  for (const id of PAGE_IDS) {
    const el = makeEl("div");
    el.id = id;
    body.appendChild(el);
    byId.set(id, el);
  }
  const viewEl = byId.get("view");
  /* #view's innerHTML setter re-parses the markup into real child nodes,
     same contract a browser gives app.js — everything else here is a plain
     property. */
  Object.defineProperty(viewEl, "innerHTML", {
    get() { return viewEl._html || ""; },
    set(html) { viewEl._html = html; parseInto(viewEl, html); },
  });

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/", protocol: "https:" },
    history: { back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const evalIn = (src) => vm.runInContext(src, ctx);
  evalIn("state.ready = true; openDrawer = () => {};");
  return { ctx, evalIn, body, view: () => viewEl.innerHTML, viewEl };
}

/* A minimal real pool + search state so buildPlaylist() has something to
   match against — enough for both a hit ("watches") and a total miss
   ("zzz-nothing-matches-zzz"). */
function seedPool(m) {
  m.evalIn(`
    state.session = { session_id: "s", builder: "t", episodes: {}, cards: [] };
    state.discover = { items: [{
      id: "show-1--ep-1", show: "Time Show", title: "Physics, deep dive",
      apple_collection_id: 1, apple_track_id: 2,
      apple_episode_url: "https://podcasts.apple.com/us/podcast/x/id1?i=2",
      release_date: "2026-05-01", duration_min: 40, duration_sec: 2400,
      artwork_url: null, audio_url: "https://audio.test/1.mp3", audio_type: "audio/mpeg",
      topics: ["science/physics"], hook: "Why physics still matters."
    }, {
      id: "show-2--ep-1", show: "Another Show", title: "More physics",
      apple_collection_id: 3, apple_track_id: 4,
      apple_episode_url: "https://podcasts.apple.com/us/podcast/y/id3?i=4",
      release_date: "2026-05-02", duration_min: 35, duration_sec: 2100,
      artwork_url: null, audio_url: "https://audio.test/2.mp3", audio_type: "audio/mpeg",
      topics: ["science/physics"], hook: "More on physics."
    }] };
    state.taxonomy = { nodes: [] };
    state.itemIndex = {}; state.poolIds = new Set();
    state.semantic = { concepts: {} };
    state.itemTags = {};
    fullPool();
  `);
}

/* ==================================================================== */
/* 1. ROUTING                                                            */
/* ==================================================================== */

test("route() dispatches #/create to renderCreate", () => {
  /* MUTATION: remove the `#/create` branch in renderCurrentPage(). The hash
     falls through to renderHome() instead, and #view never gets the
     cr-toggle/cr-form markup. */
  const m = mount();
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  assert.ok(m.view().includes("cr-toggle"), "the #/create route must render the Create page");
  assert.ok(m.view().includes('id="cr-form"'), "the #/create route must render the playlist-build form");
});

/* ==================================================================== */
/* 2-3. THE FORAY | PLAYLIST TOGGLE, FORAY DISABLED                      */
/* ==================================================================== */

test("both toggle options render: Playlist and Foray", () => {
  /* MUTATION: drop the Foray button from createToggleHtml(). The affordance
     must be VISIBLE (D7/D8) even though it does nothing. */
  const m = mount();
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  const html = m.view();
  assert.ok(/data-cr-mode="playlist"/.test(html), "a Playlist toggle option must render");
  assert.ok(/data-cr-mode="foray"/.test(html), "a Foray toggle option must render");
});

test("the Foray toggle option carries a real disabled attribute (not focusable as a control)", () => {
  /* MUTATION (named by the card itself): enable the Foray option — remove
     `disabled` from its button markup. This is the card's own acceptance
     line, checked directly against the real attribute rather than assumed
     from a CSS class. */
  const m = mount();
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  const forayBtn = m.viewEl.children.find((c) => c._attrs && c._attrs["data-cr-mode"] === "foray");
  assert.ok(forayBtn, "a Foray-mode element must exist");
  assert.strictEqual(forayBtn.disabled, true, "the Foray option must carry a real disabled attribute");
});

test('honest copy — "Custom Forays aren\'t available yet" — appears on the page', () => {
  /* MUTATION: delete the honest-copy paragraph, or reword it to imply the
     feature works. The affordance must not promise something the pipeline
     cannot do (D8). */
  const m = mount();
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  assert.ok(m.view().includes("Custom Forays aren't available yet"), "honest disabled-Foray copy must be on the page");
});

/* ==================================================================== */
/* 4. NO FORAY-SPECIFIC LENGTH PICKER (D8)                               */
/* ==================================================================== */

test("the mockup's Foray-specific ~20/~40/~75 length options are not shown for playlists", () => {
  /* MUTATION: port the mockup's `lens` length-picker verbatim into
     renderCreate(). D8 excludes it: a playlist of whole episodes has no
     "~20 min" length knob, and showing one would imply it does something. */
  const m = mount();
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  const html = m.view();
  assert.ok(!/~20/.test(html) && !/~40/.test(html) && !/~75/.test(html),
    "no Foray-specific length option (~20/~40/~75) may appear on the Create page");
  assert.ok(!/Quick|Deep dive/.test(html), "the mockup's Foray length labels must not appear");
});

/* ==================================================================== */
/* 5-6. PLAYLIST MODE IS TODAY'S buildPlaylist(), SAME DESTINATION        */
/* ==================================================================== */

test("submitting a matching subject calls buildPlaylist() and navigates to #/playlist/:id, same as the old Playlists page", async () => {
  /* MUTATION: have bindCreateFormSubmit navigate anywhere other than
     "#/playlist/" + result.playlist.id (e.g. hardcode a different route, or
     never navigate at all). This is the card's acceptance line: building
     from Create must land in the SAME place building from #/playlists does.
     bindCreateFormSubmit defers the real work one tick (setTimeout(0), same
     load-bearing reason as bindPlaylistFormSubmit — see that function's
     header), so this awaits a tick before asserting. */
  const m = mount();
  seedPool(m);
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  const form = m.viewEl.querySelector("#cr-form");
  const input = form.querySelector("input");
  input.value = "physics";
  form._fire("submit", { preventDefault() {}, currentTarget: form });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(/^#\/playlist\//.test(m.ctx.location.hash), `expected navigation to a playlist detail page, got "${m.ctx.location.hash}"`);
  const saved = JSON.parse(m.ctx.localStorage.getItem("cp_playlists") || "[]");
  assert.strictEqual(saved.length, 1, "buildPlaylist() must have saved exactly one playlist to cp_playlists");
  assert.strictEqual(saved[0].query, "physics");
});

test("a subject with no match shows the honest empty-state note, and does not navigate", async () => {
  /* MUTATION: swallow the empty/sparse/unsaved statuses silently (never set
     the note, or navigate anyway on a non-ok status). A listener typing a
     subject with nothing behind it must be told, not sent to a blank page. */
  const m = mount();
  seedPool(m);
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  const originalHash = m.ctx.location.hash;
  const form = m.viewEl.querySelector("#cr-form");
  const input = form.querySelector("input");
  input.value = "zzz-nothing-matches-zzz";
  form._fire("submit", { preventDefault() {}, currentTarget: form });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(m.ctx.location.hash, originalHash, "a no-match subject must not navigate away from Create");
  const note = m.viewEl.querySelector("#cr-note");
  assert.ok(note, "the note element must exist");
  assert.strictEqual(note.hidden, false, "the empty-state note must be shown");
  assert.ok(note.textContent.length > 0, "the empty-state note must have real copy");
});

/* ==================================================================== */
/* 8. SUBJECT SUGGESTION PILLS FILL THE INPUT                            */
/* ==================================================================== */

test("clicking a suggested subject pill fills the subject input", () => {
  /* MUTATION: unbind the pill click handler (drop the
     querySelectorAll("[data-cr-subject]") wiring in renderCreate()). The
     pills would render but do nothing. */
  const m = mount();
  m.ctx.location.hash = "#/create";
  m.evalIn("route()");
  const pill = m.viewEl.children.find((c) => c.className === "cr-pill");
  assert.ok(pill, "at least one suggestion pill must render");
  const wantSubject = pill.dataset.crSubject;
  assert.ok(wantSubject, "the pill must carry its subject in data-cr-subject");
  pill._fire("click", {});
  const input = m.viewEl.querySelector("#cr-form").querySelector("input");
  assert.strictEqual(input.value, wantSubject, "clicking a pill must fill the subject input with its own subject text");
});
