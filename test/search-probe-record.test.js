/* The field record's WIRING for search (S-01, docs/search-plan.md, kanban
 * t_46366383) — the real `app.js`, a real search, and the real
 * `window.forayRecordSearch` bridge `renderShowSearchResults` calls.
 *
 * WHY THIS IS ITS OWN SUITE, SEPARATE FROM test/show-search.test.js
 * That suite proves the SEARCH RESULT is correct (ranking, dedup, the
 * empty state). It does not touch the diagnostics call site at all. This
 * suite exists so a change that silently drops, mis-shapes, or — the one
 * that matters most — starts logging the RAW QUERY TEXT instead of its
 * length, goes red here even though every result-painting assertion in
 * show-search.test.js would stay green. That is exactly the split
 * player/diagnostic-log.test.js vs player/diagnostic-record.test.js already
 * uses in this repo, applied to a different call site.
 *
 * Harness: a fresh, minimal node:vm DOM stub, deliberately NOT shared with
 * show-search.test.js's or diagnostics-surface.test.js's own copies — see
 * either file's header for why a shared harness is how one suite silently
 * stops covering anything.
 *
 * Every test names the mutation it kills, per CLAUDE.md's own rule.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

function makeEl(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: null, className: "", innerHTML: "", textContent: "", value: "",
    hidden: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(k) { this.children.push(k); return k; },
    append(...k) { this.children.push(...k); },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, select() {}, click() {},
    remove() {},
  };
}

const PAGE_IDS = [
  "view", "drawer", "drawer-overlay", "drawer-playlists", "family-toggle",
  "player-toggle", "menu-btn", "refresh-btn", "banner-slot", "pl-form",
  "pl-input", "pl-note", "tab-topics", "tab-shows", "sh-form", "sh-input",
  "sh-note", "sh-results", "browse-all-link", "pl-search-results",
];

function mockFetch(handler) {
  return (url) => {
    const res = handler(String(url));
    return res === undefined ? new Promise(() => {}) : Promise.resolve(res);
  };
}
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function mount({ fetchImpl = () => new Promise(() => {}) } = {}) {
  const byId = new Map(PAGE_IDS.map((id) => {
    const el = makeEl("div");
    el.id = id;
    return [id, el];
  }));
  const body = makeEl("body");
  /* Spies on the one bridge this suite cares about. Not installed via
     addEventListener/DOM plumbing -- `window.forayRecordSearch` is a plain
     global function, exactly like `window.forayNoteTapFailure`, so the spy
     is just the function itself. */
  const recordedCalls = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchImpl,
    localStorage: {
      get length() { return 0; },
      key: () => null, getItem: () => null, setItem() {}, removeItem() {},
    },
    document: {
      body, documentElement: body, readyState: "complete",
      addEventListener() {}, createElement: (t) => makeEl(t),
      querySelector: (sel) => {
        const s = String(sel);
        return s.startsWith("#") ? byId.get(s.slice(1)) ?? null : null;
      },
      querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
    performance: { now: () => Date.now() },
    forayRecordSearch: (fields) => { recordedCalls.push(fields); return true; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, byId, recordedCalls, state: evalIn("state") };
}

function withSubmittable(el) {
  let handler = null;
  el.addEventListener = (type, fn) => { if (type === "submit") handler = fn; };
  el.submit = (evt) => { if (handler) handler(evt || { preventDefault() {} }); };
  return el;
}

function seed(m) {
  m.state.catalog = { shows: [{ show_id: "lex-fridman-podcast", title: "Lex Fridman Podcast", artwork_url: null }] };
  m.state.discover = { items: [] };
  m.state.cardSlots = [];
  m.state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
}

async function drain(n = 2) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ==================================================================== */
/* 1. one call per completed search                                     */
/* ==================================================================== */

test("a submitted search fires exactly one window.forayRecordSearch call", async () => {
  // MUTATION: call recordSearch from both the paint() and the .then() —
  // this asserts exactly one, not "at least one".
  const m = mount({
    fetchImpl: mockFetch((url) => (url.includes("api/shows/search") ? jsonResponse({ shows: [], degraded: false }) : undefined)),
  });
  seed(m);
  const shForm = withSubmittable(m.byId.get("sh-form"));
  m.byId.get("sh-input").value = "fridman";
  m.ctx.renderAllShows();
  shForm.submit();
  await drain();
  assert.equal(m.recordedCalls.length, 1);
});

test("the recorded fields carry qLen equal to the query's length — never the query text itself", () => {
  // THE CARD'S OWN MUTATION (docs/search-plan.md S-01: "MUTATION: logging
  // the raw query string must go red"). This is the central assertion of
  // the whole suite: it fails if app.js is ever changed to pass `query`
  // (or any substring/derivative of it) instead of `query.length`.
  return (async () => {
    const m = mount({
      fetchImpl: mockFetch((url) => (url.includes("api/shows/search") ? jsonResponse({ shows: [], degraded: false }) : undefined)),
    });
    seed(m);
    const shForm = withSubmittable(m.byId.get("sh-form"));
    m.byId.get("sh-input").value = "fridman";
    m.ctx.renderAllShows();
    shForm.submit();
    await drain();

    const call = m.recordedCalls[0];
    assert.equal(call.qLen, "fridman".length);
    assert.equal(typeof call.qLen, "number");

    // Belt-and-braces on the exact mutation named in the card: scan every
    // string value handed to the bridge for the literal query text. A
    // regression that passed `query` as an extra field, or interpolated it
    // into `path`, is caught here even if it did not overwrite `qLen`.
    for (const [key, value] of Object.entries(call)) {
      if (typeof value === "string") {
        assert.ok(!value.includes("fridman"), `field "${key}" must not contain the raw query text, got: ${value}`);
      }
    }
  })();
});

test("qLen tracks a non-ASCII query's real character length", () => {
  // MUTATION: use `query.trim().length` (or any transform) instead of the
  // raw submitted value's length. Guards against a silent renormalisation
  // changing what "query length" means for the one class of title the
  // battery in tools/search-probe.mjs specifically exercises.
  return (async () => {
    const m = mount({
      fetchImpl: mockFetch((url) => (url.includes("api/shows/search") ? jsonResponse({ shows: [], degraded: false }) : undefined)),
    });
    seed(m);
    const q = "伊藤洋一のRound Up World Now！";
    const shForm = withSubmittable(m.byId.get("sh-form"));
    m.byId.get("sh-input").value = q;
    m.ctx.renderAllShows();
    shForm.submit();
    await drain();
    assert.equal(m.recordedCalls[0].qLen, q.length);
  })();
});

/* ==================================================================== */
/* 2. the other six fields                                              */
/* ==================================================================== */

test("localHits and netHits reflect the real result counts from each pass", () => {
  // MUTATION: swap localHits and netHits, or hardcode either to 0.
  return (async () => {
    const m = mount({
      fetchImpl: mockFetch((url) => (url.includes("api/shows/search")
        ? jsonResponse({ shows: [{ show_id: "999999", title: "Science Friday", artwork_url: null, tier: "breadth" }], degraded: false })
        : undefined)),
    });
    seed(m); // one curated show, "lex-fridman-podcast"
    const shForm = withSubmittable(m.byId.get("sh-form"));
    m.byId.get("sh-input").value = "fridman"; // matches the one curated show locally
    m.ctx.renderAllShows();
    shForm.submit();
    await drain();
    const call = m.recordedCalls[0];
    assert.equal(call.localHits, 1, "the curated 'fridman' match must be counted");
    assert.equal(call.netHits, 1, "the one breadth addition must be counted");
  })();
});

test("path is \"local-only\" when the network pass returns null (a failed/degraded fetch)", () => {
  // MUTATION: report "local+net" unconditionally regardless of whether data
  // resolved -- this is the field the doc's probe uses to tell a healthy
  // round trip from a degraded one, per §1.4's "absence is a real state".
  return (async () => {
    const m = mount({
      fetchImpl: mockFetch((url) => (url.includes("api/shows/search")
        ? { ok: false, status: 500, json: async () => { throw new Error("bad json"); } }
        : undefined)),
    });
    seed(m);
    const shForm = withSubmittable(m.byId.get("sh-form"));
    m.byId.get("sh-input").value = "fridman";
    m.ctx.renderAllShows();
    shForm.submit();
    await drain();
    assert.equal(m.recordedCalls[0].path, "local-only");
    assert.equal(m.recordedCalls[0].netHits, null);
  })();
});

test("path is \"superseded\" when a faster retype supersedes this query's in-flight fetch", () => {
  // MUTATION: always report "local+net"/"local-only" even when the token
  // no longer matches -- the recorded path would then claim a fresher
  // result set was applied when it was actually discarded.
  return (async () => {
    let resolveFirst;
    const first = new Promise((r) => { resolveFirst = r; });
    let call = 0;
    const m = mount({
      fetchImpl: mockFetch((url) => {
        if (!url.includes("api/shows/search")) return undefined;
        call += 1;
        if (call === 1) return first.then(() => ({ ok: true, status: 200, json: async () => ({ shows: [], degraded: false }) }));
        return jsonResponse({ shows: [], degraded: false });
      }),
    });
    seed(m);
    const shForm = withSubmittable(m.byId.get("sh-form"));

    m.byId.get("sh-input").value = "fridman";
    m.ctx.renderAllShows();
    shForm.submit(); // first query, in flight

    m.byId.get("sh-input").value = "lex"; // supersedes before the first resolves
    shForm.submit();
    await drain();
    resolveFirst();
    await drain();

    const superseded = m.recordedCalls.find((c) => c.qLen === "fridman".length);
    assert.ok(superseded, "the superseded query must still be recorded once");
    assert.equal(superseded.path, "superseded");
  })();
});

test("paintedMs and localMs are both non-negative numbers on every recorded search", () => {
  // MUTATION: swap the start/end timestamps -- this is the same guard
  // tools/search-probe.test.mjs holds on its own timeReps().
  return (async () => {
    const m = mount({
      fetchImpl: mockFetch((url) => (url.includes("api/shows/search") ? jsonResponse({ shows: [], degraded: false }) : undefined)),
    });
    seed(m);
    const shForm = withSubmittable(m.byId.get("sh-form"));
    m.byId.get("sh-input").value = "fridman";
    m.ctx.renderAllShows();
    shForm.submit();
    await drain();
    const call = m.recordedCalls[0];
    assert.equal(typeof call.localMs, "number");
    assert.ok(call.localMs >= 0);
    assert.equal(typeof call.paintedMs, "number");
    assert.ok(call.paintedMs >= 0);
  })();
});

/* ==================================================================== */
/* 3. the bridge must never break search itself                         */
/* ==================================================================== */

test("a missing window.forayRecordSearch (an older bundle) does not break the search or throw", () => {
  // MUTATION: call window.forayRecordSearch(...) unguarded instead of
  // through the typeof-function check + try/catch -- matches the exact
  // guard forayNoteTapFailure already relies on in player/client.js.
  return (async () => {
    const m = mount({
      fetchImpl: mockFetch((url) => (url.includes("api/shows/search") ? jsonResponse({ shows: [], degraded: false }) : undefined)),
    });
    delete m.ctx.forayRecordSearch;
    seed(m);
    const shForm = withSubmittable(m.byId.get("sh-form"));
    m.byId.get("sh-input").value = "fridman";
    m.ctx.renderAllShows();
    assert.doesNotThrow(() => shForm.submit());
    await drain();
    const results = m.byId.get("sh-results");
    assert.equal(results.hidden, false, "search must still complete and paint normally");
  })();
});

test("a throwing window.forayRecordSearch does not break the search", () => {
  // MUTATION: same guard, the other failure direction -- a diagnostics
  // write that throws must not become the search outage it exists to
  // explain, matching this repo's "diagnostics never becomes the outage"
  // rule everywhere else in player/diagnostic-log.js.
  return (async () => {
    const m = mount({
      fetchImpl: mockFetch((url) => (url.includes("api/shows/search") ? jsonResponse({ shows: [], degraded: false }) : undefined)),
    });
    m.ctx.forayRecordSearch = () => { throw new Error("diag write failed"); };
    seed(m);
    const shForm = withSubmittable(m.byId.get("sh-form"));
    m.byId.get("sh-input").value = "fridman";
    m.ctx.renderAllShows();
    assert.doesNotThrow(() => shForm.submit());
    await drain();
    const results = m.byId.get("sh-results");
    assert.equal(results.hidden, false, "search must still complete and paint normally even if the diagnostics write throws");
  })();
});
