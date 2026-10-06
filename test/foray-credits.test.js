/* A narration beat's "Sources" join their shows exactly the way a tape beat's
 * credit does (code-health CH-39, A3-06).
 *
 * `citesHtml` re-implemented `forayShowId`'s two-step show join inline (the
 * catalogue by id, then the exact title through the catalogue and the show
 * index), rendered an unlinked tape cite as bare text, and
 * `joinForayCreditsToShowIndex` asked "is any credit unlinked?" of the tape
 * beats only. So a narrated Foray whose tape beats all joined the curated
 * catalogue, but whose `cites` named a show only the index knows, never
 * fetched the index, and the cite stayed plain text for the life of the page —
 * while the beats beside it relink the moment the index arrives.
 *
 * Now: one join (`forayShowId`) for both; an unlinked cite is the same
 * `<span class="fy-credit" data-credit-show=…>` an unlinked credit is, so the
 * one relink pass (`relinkForayCredits`) upgrades both; and the index is asked
 * for when a cite needs it, not only when a credit does.
 *
 * The row credits' own half (catalogue, index, exact-and-unique titles) is
 * pinned in test/foray-surfaces.test.js (p-foray-2); this suite is the cites.
 *
 * Harness: the REAL app.js and search-engine.js in a node:vm, the shared
 * small DOM (test/helpers/fake-dom.js) for #view, a synthetic Foray (no
 * committed Foray carries `cites` yet — player/foray-resolve.js says so), and
 * a synthetic show index served for `data/show-index.tsv`.
 *
 * Every test names the mutation that turns it red; each was run red once.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { El } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");

process.on("unhandledRejection", () => {});

/* Four tab-separated columns, sorted by lowercased title, as
   tools/build-show-index.mjs emits: one breadth row the curated set does not
   have (the cite's show), and the curated show itself. */
const INDEX_TSV = [
  "Curated Show\tcurated-show\t\t1",
  "Index Only Show\t1000009\t5\t0",
  "",
].join("\n");

function mount() {
  const body = new El("body");
  const view = new El("main"); view.id = "view"; body.appendChild(view);
  const fetched = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      const u = String(url);
      fetched.push(u);
      if (u.includes("show-index.tsv")) return Promise.resolve({ ok: true, status: 200, text: async () => INDEX_TSV });
      return new Promise(() => {});
    },
    localStorage: { get length() { return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body, documentElement: body, readyState: "complete", hidden: false,
      addEventListener() {}, removeEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => (String(s).trim() === "#view" ? view : body.querySelector(s)),
      querySelectorAll: (s) => body.querySelectorAll(s),
    },
    navigator: { userAgent: "node", onLine: true },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/foray/f-cites", search: "", pathname: "/", href: "https://x.test/", protocol: "https:" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout, queueMicrotask,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  state.catalog = { shows: [{ show_id: "curated-show", title: "Curated Show", artwork_url: null }] };
  return { ctx, state, view, fetched };
}

async function settle(n = 10) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }

const cite = (show, show_id) => ({ kind: "tape", show, show_id, episode_title: "Ep 9" });
const credit = (show, show_id) => ({ type: "segment", playable: true, show, show_id, why: "a beat" });

/** A narrated Foray whose ONE tape beat joins the curated catalogue, and whose
    narration cites one show only the index knows (and one print source). */
function narratedForay() {
  return {
    id: "f-cites",
    entries: [
      credit("Curated Show", "curated-show"),
      {
        type: "narration", playable: true, ord: 2, script: "A short line from the narrator.",
        cites: [cite("Index Only Show", "index-only-show"), { kind: "print", publication: "The Paper", url: null }],
      },
    ],
  };
}

/** The href a piece of markup links its show to, or null when it does not. */
const hrefOf = (html) => (/href="(#\/show\/[^"]+)"/.exec(html) || [])[1] || null;

test("characterization: a cite links its show exactly where a credit for the same show does — by catalogue id, else by exact title", () => {
  /* The two joins agree today for every show the catalogue can answer; this
     pins that they keep agreeing once there is one join. MUTATION: drop the
     title step from citesHtml (`c.show_id && showById(c.show_id) ? c.show_id :
     null`) — the by-title row links as a credit and not as a cite, red. */
  const m = mount();
  const cases = [
    ["Curated Show", "curated-show", "#/show/curated-show"],     // catalogue, by id
    ["Curated Show", "renamed-upstream", "#/show/curated-show"], // catalogue, by exact title
    ["Nobody Knows This", "nobody", null],                       // no join at all
  ];
  for (const [show, id, want] of cases) {
    const c = hrefOf(m.ctx.citesHtml({ cites: [cite(show, id)] }));
    const k = hrefOf(m.ctx.forayCreditHtml(credit(show, id)));
    assert.strictEqual(k, want, `fixture: the credit for ${show}/${id}`);
    assert.strictEqual(c, k, `the cite for ${show}/${id} joins where the credit does`);
  }
});

test("A3-06: an unlinked cite is the same relinkable span an unlinked credit is", () => {
  /* Was: `esc(c.show)` — bare text, which no relink pass can find.
     MUTATION: put the bare `esc(c.show)` back for an unlinked tape cite — no
     span, red. */
  const m = mount();
  const html = m.ctx.citesHtml({ cites: [cite("Index Only Show", "index-only-show")] });
  assert.match(html, /<span class="fy-credit" data-credit-show="Index Only Show">Index Only Show<\/span> — Ep 9/, html);
  assert.strictEqual(
    m.ctx.forayCreditHtml(credit("Index Only Show", "index-only-show")),
    `<span class="fy-credit" data-credit-show="Index Only Show">Index Only Show</span>`,
    "the credit's span, the same markup",
  );
});

test("A3-06: a cite naming an index-only show asks for the index and links once it arrives, though every tape beat already joined", async () => {
  /* Was: the "anything unlinked?" test read tape beats only, so with every
     beat joined the index was never fetched and the cite stayed text.
     MUTATION: drop the cites from joinForayCreditsToShowIndex's unlinked test —
     no index fetch, red. MUTATION: skip `.fy-credit[data-credit-show]` inside
     `.fy-cites` in relinkForayCredits (or render the cite as text again) — the
     span is never replaced, red. */
  const m = mount();
  const r = narratedForay();
  m.state.foray = r;
  m.view.innerHTML = `${r.entries.map((e) => (e.type === "narration" ? m.ctx.citesHtml(e) : m.ctx.forayCreditHtml(e))).join("")}`;
  assert.strictEqual(m.view.querySelectorAll("a.fy-credit").length, 1, "fixture: the tape beat is linked at paint");
  const span = m.view.querySelector(".fy-cites .fy-credit[data-credit-show]");
  assert.ok(span, "fixture: the cite paints unlinked before the index");
  m.ctx.joinForayCreditsToShowIndex(r, {});
  await settle();
  assert.ok(m.fetched.some((u) => u.includes("show-index.tsv")), `the index was asked for: ${JSON.stringify(m.fetched)}`);
  assert.strictEqual(span.outerHTML, `<a class="fy-credit show-link" href="#/show/1000009">Index Only Show</a>`,
    "and the cite relinked in place, the way the beats do");
});

test("A3-06: a Foray with nothing unlinked — beats and cites — never asks for the index", async () => {
  /* The index is ~200 KB and off the boot path (the S-03 rules above
     loadShowIndex); widening the test to cites must not make it unconditional.
     MUTATION: return true from the unlinked test — the index is fetched, red. */
  const m = mount();
  const r = narratedForay();
  r.entries[1].cites = [cite("Curated Show", "curated-show")];
  m.state.foray = r;
  m.ctx.joinForayCreditsToShowIndex(r, {});
  await settle();
  assert.deepStrictEqual(m.fetched.filter((u) => u.includes("show-index")), []);
});
