/* Redesign 2026, ambient direction ("Afterglow"), phase 4: ONBOARDING (the first-run Room).
 *
 * docs/redesign-2026/directions/ambient/BUILD-NOTES.md §4.7 and §11.2 are the specification; ui/onboarding.js
 * (openOnboardingRoom and friends) and ui/onboarding.css are the build. The Room replaces the two-step first-run
 * sheet (#first-time-sheet, retired); test/first-time-onboarding.test.js, onboarding-sheet-once.test.js and the
 * onboarding tests in modal-and-focus.test.js keep the gate, the once-per-visit rule and the dialog contract,
 * rewritten for the Room. THIS suite pins what the Room adds, one acceptance line at a time:
 *
 *   1   the copy, word for word, in the styles the acceptance names, and inside the copy rules
 *   2   hostile data: show names and art URLs never reach markup or a style unescaped
 *   3   which four shows light the Room: the first foray's, in running order, then the pool's
 *   4   the strip: built from the foray's segments, condensed past 14 bars, one bar playing
 *   5   the strip's colours are numbers only, in the scheme's lightness band, and nudged apart
 *   6   the Room cycles its artworks (6s), holds still under Reduce Motion, and stops with the Room
 *   7   "Show my picks": sets the flag through the shim, the strip travels to the hero collage, the Room lets go,
 *       and Today takes focus; under Reduce Motion nothing travels
 *   8   "Skip for now": the flag, no travel, no sheet left behind
 *   9   Escape and a navigation park the Room and write nothing; Settings' "What 4a does" reopens it for anyone
 *   10  the stylesheet's own rules: scoped, one Reduce Motion owner, token durations, the pixel contract
 *   11  the head scrim holds through the wordmark, so the mark keeps 3:1 over any art in both schemes
 *   12  the Room is wired: index.html, the drawer, the harness state, screens.json, every shipping list
 *
 * Every test names the one-line mutation that makes it fail, and each was run (the PR lists them). A green test is
 * not evidence until you have broken it (CLAUDE.md).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ok = require("./helpers/oklab.js");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const ONB_JS = read("ui/onboarding.js");
const ONB_CSS = strip(read("ui/onboarding.css"));

process.on("unhandledRejection", () => {});

/* ---------------------------------------------------------------- the CSS reader */
function cssRules(css) {
  const out = [];
  const stack = [];
  let buf = "";
  for (const ch of css) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") {
      const prelude = stack.pop();
      if (buf.trim() && prelude !== undefined) out.push({ prelude, body: buf.trim(), atRules: stack.filter((p) => p.startsWith("@")) });
      buf = "";
      continue;
    }
    buf += ch;
  }
  return out;
}
function selectorsOf(prelude) {
  const out = []; let depth = 0; let cur = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim().replace(/\s+/g, " ")); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}
const decls = (body) => Object.fromEntries(body.split(";").map((d) => { const c = d.indexOf(":"); return c < 0 ? null : [d.slice(0, c).trim(), d.slice(c + 1).trim()]; }).filter(Boolean));
function ruleOf(css, sel, { atRule = null } = {}) {
  let got = null;
  for (const r of cssRules(css)) {
    if (r.prelude.startsWith("@")) continue;
    if (atRule ? !r.atRules.some((a) => a.includes(atRule)) : r.atRules.length) continue;
    if (selectorsOf(r.prelude).includes(sel)) got = { ...(got || {}), ...decls(r.body) };
  }
  return got;
}
const ONB_RULES = cssRules(ONB_CSS);

/* ---------------------------------------------------------------- a DOM with a tree, focus and a markup reader */
function makeDocument() {
  const doc = { activeElement: null, _keydown: [] };
  function matchCompound(el, sel) {
    let s = sel.trim();
    const nots = [];
    s = s.replace(/:not\(([^)]*)\)/g, (_m, inner) => { nots.push(inner); return ""; });
    const tag = /^[a-z][\w-]*/i.exec(s);
    if (tag && el.tagName !== tag[0].toUpperCase()) return false;
    for (const m of s.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
    for (const m of s.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(m[1])) return false;
    for (const m of s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const v = el.getAttribute(m[1]);
      if (v == null) return false;
      if (m[2] !== undefined && v !== m[2]) return false;
    }
    for (const n of nots) if (matchCompound(el, n)) return false;
    return true;
  }
  /** One level of descendant combinator: `.a .b`. */
  const matches = (el, sel) => String(sel).split(",").some((part) => {
    const bits = part.trim().split(/\s+/);
    if (!matchCompound(el, bits[bits.length - 1])) return false;
    let anc = el.parentElement;
    for (let i = bits.length - 2; i >= 0; i--) {
      while (anc && !matchCompound(anc, bits[i])) anc = anc.parentElement;
      if (!anc) return false;
      anc = anc.parentElement;
    }
    return true;
  });
  const VOID = new Set(["img", "br", "input", "hr", "meta", "link"]);
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentElement = null;
      this._attrs = new Map();
      this._cls = new Set();
      this._on = new Map();
      this._styles = new Map();
      this._html = "";
      this.dataset = {};
      this.rect = { top: 0, left: 0, width: 0, height: 0 };
      this.textContent = "";
      const self = this;
      this.style = { setProperty: (k, v) => self._styles.set(k, String(v)), getPropertyValue: (k) => self._styles.get(k) || "", removeProperty: (k) => self._styles.delete(k) };
      this.classList = {
        add: (...c) => c.forEach((x) => self._cls.add(x)),
        remove: (...c) => c.forEach((x) => self._cls.delete(x)),
        contains: (c) => self._cls.has(c),
        toggle(c, force) {
          const on = force === undefined ? !self._cls.has(c) : !!force;
          if (on) self._cls.add(c); else self._cls.delete(c);
          return on;
        },
      };
    }
    get className() { return [...this._cls].join(" "); }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get id() { return this._attrs.get("id") || ""; }
    set id(v) { this._attrs.set("id", String(v)); }
    get hidden() { return this._attrs.has("hidden"); }
    set hidden(v) { if (v) this._attrs.set("hidden", ""); else this._attrs.delete("hidden"); }
    get isConnected() { let n = this; while (n) { if (n === doc.body) return true; n = n.parentElement; } return false; }
    setAttribute(k, v) { this._attrs.set(k, String(v)); }
    getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
    hasAttribute(k) { return this._attrs.has(k); }
    removeAttribute(k) { this._attrs.delete(k); }
    appendChild(k) { if (k.parentElement) k.remove(); k.parentElement = this; this.children.push(k); return k; }
    append(...ks) { ks.forEach((k) => this.appendChild(k)); }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement = null;
    }
    contains(o) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; }
    matches(sel) { return matches(this, sel); }
    closest(sel) { for (let n = this; n; n = n.parentElement) if (matches(n, sel)) return n; return null; }
    tree() { return this.children.flatMap((c) => [c, ...c.tree()]); }
    querySelectorAll(sel) { return this.tree().filter((e) => matches(e, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    /* A markup string becomes a real tree, so the Room's own selectors (`.ob-sleeve .ag-art`) are read as they are
       in a browser. Void tags close themselves; text between tags is kept on the element. */
    set innerHTML(v) {
      this.children.forEach((c) => { c.parentElement = null; });
      this.children = [];
      this._html = String(v);
      const stack = [this];
      for (const m of this._html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
        const top = stack[stack.length - 1];
        if (m[4] !== undefined) { top.textContent += m[4]; continue; }
        if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
        const k = new El(m[2]);
        for (const a of m[3].matchAll(/([\w:-]+)="([^"]*)"/g)) {
          if (a[1] === "class") k.className = a[2]; else k.setAttribute(a[1], a[2]);
        }
        top.appendChild(k);
        if (!VOID.has(m[2].toLowerCase()) && !/\/\s*$/.test(m[3])) stack.push(k);
      }
    }
    get innerHTML() { return this._html; }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    getBoundingClientRect() { return this.rect; }
    addEventListener(t, fn) { if (!this._on.has(t)) this._on.set(t, []); this._on.get(t).push(fn); }
    removeEventListener() {}
    fire(type, props = {}) {
      const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...props };
      return (this._on.get(type) || []).map((fn) => fn(ev));
    }
    click() { return this.fire("click"); }
    setPointerCapture() {}
    releasePointerCapture() {}
  }
  doc.body = new El("body");
  doc.documentElement = new El("html");
  doc.documentElement.appendChild(doc.body);
  doc.createElement = (t) => new El(t);
  doc.querySelector = (s) => doc.body.querySelector(s);
  doc.querySelectorAll = (s) => doc.body.querySelectorAll(s);
  doc.getElementById = (id) => doc.body.querySelectorAll(`#${id}`)[0] || null;
  doc.addEventListener = (t, fn) => { if (t === "keydown") doc._keydown.push(fn); };
  doc.removeEventListener = () => {};
  doc.readyState = "complete";
  doc.key = (key) => { let prevented = false; const ev = { key, preventDefault() { prevented = true; } }; doc._keydown.forEach((fn) => fn(ev)); return prevented; };
  return { doc, El };
}

/** The app in a node:vm over that DOM, with timers the test turns by hand. `reduced` answers prefers-reduced-motion;
    `vars` answers getComputedStyle (the live --glow-l token picks Dusk or Dawn). */
function mount({ seed = {}, reduced = false, vars = {}, hash = "#/", forayPlayer = null } = {}) {
  const { doc, El } = makeDocument();
  const add = (tag, id, cls) => { const el = doc.createElement(tag); if (id) el.id = id; if (cls) el.className = cls; doc.body.appendChild(el); return el; };
  const topbar = add("header", null, "topbar");
  const menu = doc.createElement("button"); menu.id = "menu-btn"; topbar.appendChild(menu);
  const drawer = add("nav", "drawer"); drawer.hidden = true;
  const view = add("main", "view");
  const tabBar = add("nav", null, "tab-bar");
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const timeouts = [], intervals = [], cleared = [];
  const location = { hash, search: "", pathname: "/", href: "https://x.test/" };
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    document: doc, navigator: { userAgent: "node" },
    getComputedStyle: () => ({ getPropertyValue: (p) => vars[p] || "" }),
    matchMedia: (q) => ({ matches: reduced && /reduced-motion/.test(String(q)) }),
    addEventListener() {}, removeEventListener() {},
    location, history: { scrollRestoration: "auto", back() {}, replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) }, URL, URLSearchParams, Math, Date, JSON, Promise,
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms, at: null }); return timeouts.length; },
    clearTimeout: (id) => { if (timeouts[id - 1]) timeouts[id - 1].fn = null; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, live: true }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].live = false; cleared.push(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    encodeURIComponent, decodeURIComponent, scrollY: 0, scrollTo() {}, scrollBy() {},
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  if (forayPlayer) ctx.ForayPlayer = forayPlayer;
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  ctx.setBootChrome(true);
  const evalIn = (src) => vm.runInContext(src, ctx);
  /** Runs every timer queued so far (a settled transition), oldest first. */
  const flushTimers = () => { const q = timeouts.splice(0); q.forEach((t) => t.fn && t.fn()); };
  return { ctx, doc, El, store, view, drawer, topbar, tabBar, location, evalIn, state: evalIn("state"), timeouts, intervals, cleared, flushTimers, add };
}

/** The player bridge the Room reads: a foray of `shows`, a narration bridge between each, and a stripModel that
    reports each item's length. */
function bridge(shows, { lengths = null } = {}) {
  const playable = [];
  shows.forEach((s, i) => {
    playable.push({ id: `s${i}`, show: s, type: "segment", artwork_url: null, len: lengths ? lengths[i] : 300 });
    if (i < shows.length - 1) playable.push({ id: `n${i}`, type: "narration", len: 20 });
  });
  return {
    playable,
    player: {
      listForays: () => [{ id: "f1", title: "A foray", status: "published" }],
      resolve: (_doc, opts) => (opts.id === "f1" ? { playable, totalSec: playable.reduce((t, p) => t + p.len, 0) } : null),
      stripModel: (items) => ({ segments: items.map((p) => ({ kind: p.type === "narration" ? "narration" : "segment", show: p.show || "", lengthSec: p.len })) }),
      forayStatus: () => ({ running: false, playing: false, loading: false, gap: false, ended: false }),
    },
  };
}
function withForay(m, shows, opts) {
  const b = bridge(shows, opts);
  m.ctx.ForayPlayer = b.player;
  m.state.forays = { forays: [{ id: "f1", status: "published" }] };
  return b;
}
const room = (m) => m.doc.body.querySelector("#onboarding-room");
const pool = (m, names) => { m.state.discover = { items: names.map((n, i) => ({ id: `d${i}`, show: n, title: `T${i}`, artwork_url: `https://is1-ssl.mzstatic.com/image/thumb/P/v4/${i}/600x600bb.jpg` })) }; };

/* ================================================================== 1. the copy */
test("1. the Room says 'Hear things outside your lane.' in --t-display and the body in --t-body, with 'Show my picks' (Primary) and 'Skip for now' (Secondary)", () => {
  /* MUTATION: change a word of either sentence or either label; swap t-display for t-title; swap ag-btn-primary and
     ag-btn-secondary between the two buttons -> red. */
  const m = mount();
  const html = m.evalIn("onboardingRoomHtml([], 0)");
  assert.match(html, /<h2 class="t-display ob-title" id="onboarding-title">Hear things outside your lane\.<\/h2>/);
  assert.match(html, /<p class="t-body ob-body">4a picks a few podcasts a day and says why\. No account\.<\/p>/);
  assert.match(html, /<button type="button" class="ag-btn ag-btn-primary" id="onboarding-go">Show my picks<\/button>/);
  assert.match(html, /<button type="button" class="ag-btn ag-btn-secondary" id="onboarding-skip">Skip for now<\/button>/);
  assert.ok(html.indexOf("onboarding-go") < html.indexOf("onboarding-skip"), "Primary above Secondary");
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  const title = m.evalIn("ONBOARDING_TITLE"), body = m.evalIn("ONBOARDING_BODY");
  assert.ok(words(title) <= 16 && words(body) <= 18, "inside the hook and why-line budgets");
  for (const t of [title, body]) assert.doesNotMatch(t, /\b(we|us|our|ours|topic|topics|fascinating|deep dive|delve|delves|explores)\b/i, `copy rules: ${t}`);
});

/* ================================================================== 2. hostile data */
test("2. hostile show names and art URLs reach neither the markup nor a style unescaped", () => {
  /* MUTATION: build onboardingCssUrl from artUrl(src, 400) without safeUrl(), or drop its quote encoding, or give the
     sleeve's name to agArtwork through a raw template -> red. */
  const m = mount();
  const evil = '"><img src=x onerror=alert(1)><b>';
  const html = m.evalIn(`onboardingRoomHtml([{ name: ${JSON.stringify(evil)}, src: "javascript:alert(1)" }, { name: "Fine", src: "https://is1-ssl.mzstatic.com/a/600x600bb.jpg" }], 3)`);
  assert.ok(!html.includes("<img src=x"), "the name is escaped");
  const probe = m.doc.createElement("div");
  probe.innerHTML = html;
  const all = probe.tree();
  assert.ok(all.every((e) => !e.hasAttribute("onerror")), "no attribute breakout: no element carries the handler");
  assert.ok(all.every((e) => e.tagName !== "B"), "and the name opened no element");
  assert.ok(!/javascript:/i.test(html), "a javascript: art URL is dropped by safeUrl");
  assert.strictEqual(m.evalIn('onboardingCssUrl("javascript:alert(1)")'), "none");
  assert.strictEqual(m.evalIn('onboardingCssUrl("")'), "none");
  const u = m.evalIn(`onboardingCssUrl('https://a.test/x.jpg"); background: red; ("')`);
  assert.match(u, /^url\("[^"]*"\)$/, `a quote in the URL cannot end the CSS string: ${u}`);
  assert.ok(!/background/.test(u.replace(/%20|%3B|%22|%28|%29/g, "")) || u.indexOf('"', 5) === u.length - 2, "and nothing follows it");
  assert.strictEqual(m.evalIn('onboardingCssUrl("https://is1-ssl.mzstatic.com/a/600x600bb.jpg")'), 'url("https://is1-ssl.mzstatic.com/a/400x400bb.jpg")');
});

/* ================================================================== 3. which shows */
test("3. four shows light the Room: the first foray's in running order, then the pool's; narration never; distinct; never five", () => {
  /* MUTATION: drop the `out.length >= 4` cap -> five sleeves; read the pool before the foray -> the order is red;
     stop skipping narration (`p.type !== "narration"`) -> a nameless sleeve; drop the distinct check -> red. */
  const m = mount();
  pool(m, ["Pool A", "Pool B", "Foray Two", "Pool C", "Pool D"]);
  const r = { playable: [{ show: "Foray One", type: "segment" }, { type: "narration", show: "Narrator" }, { show: "Foray Two", type: "segment" }, { show: "Foray One", type: "segment" }, { kind: "tts", show: "Voice" }] };
  const shows = [...m.evalIn("onboardingShows")(r)].map((s) => s.name);
  assert.deepStrictEqual(shows, ["Foray One", "Foray Two", "Pool A", "Pool B"], "foray first, in order, then the pool; four, once each");
  const none = [...m.evalIn("onboardingShows")(null)].map((s) => s.name);
  assert.deepStrictEqual(none, ["Pool A", "Pool B", "Foray Two", "Pool C"], "no foray: the pool alone fills the Room");
  const withArt = [...m.evalIn("onboardingShows")(r)];
  assert.ok(withArt.find((s) => s.name === "Pool A").src.includes("mzstatic"), "a pool show carries its artwork");
  assert.deepStrictEqual([...m.evalIn("onboardingShows")({ playable: [{ show: "  ", type: "segment" }, null, { show: 5, type: "segment" }] })].map((s) => s.name).slice(0, 1), ["5"], "blank and malformed rows are skipped, never thrown on");
});

/* ================================================================== 4. the strip */
test("4. the strip is built from the foray's segments, condensed past 14 bars, with exactly one bar playing", () => {
  /* MUTATION: delete the condense branch -> thirty bars in 343px; set ONBOARDING_PLAYED to 0 -> no bar is playing;
     drop the stripModel guard -> a missing player throws; mark every bar `cur` -> red. */
  const m = mount();
  const small = withForay(m, ["A", "B", "C"]);
  const bars = [...m.evalIn("onboardingBars")(m.evalIn("onboardingForay()"))];
  assert.strictEqual(bars.length, 5, "three shows and two bridges, as drawn");
  assert.deepStrictEqual(bars.map((b) => b.s), ["A", null, "B", null, "C"]);
  assert.strictEqual(bars.filter((b) => b.cur).length, 1, "exactly one bar is playing");
  const cur = bars.findIndex((b) => b.cur);
  bars.forEach((b, i) => assert.strictEqual(b.f, i < cur ? 1 : i === cur ? b.f : 0, `bar ${i}: lit before the playing one, dark after`));
  assert.ok(bars[cur].f > 0 && bars[cur].f < 1, "and the playing bar is part-lit");
  void small;
  const many = mount();
  withForay(many, Array.from({ length: 16 }, (_, i) => `Show ${i % 5}`));
  const condensed = [...many.evalIn("onboardingBars")(many.evalIn("onboardingForay()"))];
  assert.ok(condensed.length >= 9 && condensed.length <= 12, `at most nine bars and a narration light after every third (neighbours that name one show are one bar), got ${condensed.length}`);
  assert.ok(condensed.filter((b) => b.s === null).length >= 3, "the lights are there");
  assert.strictEqual(condensed.filter((b) => b.cur).length, 1);
  assert.ok(condensed.every((b) => b.s === null || /^Show \d$/.test(b.s)), "every bar is named for a real show or is a light");
  const bare = mount();
  assert.deepStrictEqual([...bare.evalIn("onboardingBars")(null)], [], "no foray: no strip");
  bare.ctx.ForayPlayer = {};
  assert.deepStrictEqual([...bare.evalIn("onboardingBars")({ playable: [{ show: "A" }] })], [], "no stripModel: no strip, no throw");
});

test("4b. no two neighbouring bars share a show and no two lights touch, so the strip is lanterns, not a smear", () => {
  /* MUTATION: delete the `bars.reduce` merge in onboardingBars (the "One lantern per run" block) -> the same-show pair and
     the doubled lights come back and every assertion below is red. */
  const m = mount();
  /* two episodes of A back to back, then B */
  const b = bridge(["A", "A", "B"]);
  b.playable.splice(1, 1);   /* drop the bridge between the two A's: nothing separates them */
  m.ctx.ForayPlayer = b.player;
  m.state.forays = { forays: [{ id: "f1", status: "published" }] };
  const small = [...m.evalIn("onboardingBars")(m.evalIn("onboardingForay()"))];
  assert.deepStrictEqual(small.map((x) => x.s), ["A", null, "B"], "two A segments draw as one bar");
  assert.strictEqual(small[0].d, 600, "and it holds both lengths");
  for (const shows of [["A", "A", "A", "B", "B", "B", "C", "C"], Array.from({ length: 30 }, (_, i) => `Show ${Math.floor(i / 6)}`)]) {
    const many = mount();
    withForay(many, shows);
    const bars = [...many.evalIn("onboardingBars")(many.evalIn("onboardingForay()"))];
    assert.ok(bars.length >= 3, "fixture: the strip has several bars");
    bars.slice(1).forEach((x, i) => assert.notStrictEqual(x.s, bars[i].s, `bars ${i} and ${i + 1} are both ${JSON.stringify(x.s)}`));
    assert.strictEqual(bars.filter((x) => x.cur).length, 1, "still exactly one bar playing");
  }
});

test("4c. the bars are 4px apart so neighbouring lanterns read as separate", () => {
  /* MUTATION: set the .ob-strip gap back to `calc(var(--s-1) / 2)` (2px) -> red. */
  const strip = ONB_RULES.find((r) => r.prelude === ".ob-room .ob-strip");
  assert.ok(strip, "fixture: the strip rule exists");
  assert.strictEqual(decls(strip.body).gap, "var(--s-1)", "4px of air between bars (--s-1)");
});

/* ================================================================== 5. the strip's colours */
test("5. bar colours are numbers only, at the scheme's lightness, and a hue within 24 degrees of one drawn is nudged 30", () => {
  /* MUTATION: interpolate the show's name into the colour; drop the nudge loop; read lightness 0.70 in Dawn -> red. */
  const m = mount({ vars: { "--glow-l": "0.66" } });
  m.evalIn("agPaletteFor = () => [100, 0.1]");
  const bars = [{ s: 'x"; background:url(//e)' }, { s: "B" }, { s: null }, { s: "C" }, { s: "D" }];
  const dusk = [...m.evalIn(`onboardingBarColours(${JSON.stringify(bars)})`)];
  assert.strictEqual(dusk[2], "", "a narration light has no colour of its own (it is Lamp)");
  for (const c of [dusk[0], dusk[1], dusk[3], dusk[4]]) assert.match(c, /^oklch\(0\.7 0\.13 \d{1,3}\)$/, `numbers only, Dusk band: ${c}`);
  const hues = [dusk[0], dusk[1], dusk[3], dusk[4]].map((c) => Number(/ (\d+)\)$/.exec(c)[1]));
  assert.deepStrictEqual(hues, [100, 130, 160, 190], "each next show is nudged 30 degrees off the hues already used");
  const dawn = mount({ vars: { "--glow-l": "0.56" } });
  dawn.evalIn("agPaletteFor = () => [100, 0.1]");
  assert.match(dawn.evalIn('onboardingBarColours([{ s: "A" }])')[0], /^oklch\(0\.52 0\.13 100\)$/, "Dawn reads the darker band");
});

/* ================================================================== 6. the cycle */
test("6. the Room cycles four artworks every 6s with the lit sleeve and Glow, holds still under Reduce Motion or one artwork, and stops when it closes", () => {
  /* MUTATION: change ONBOARDING_CYCLE_MS; drop the `!reducedMotion()` guard; forget clearInterval in stop() -> red;
     swap which layer takes the next art -> the on/off assertions are red. */
  const m = mount();
  pool(m, ["One", "Two", "Three", "Four"]);
  m.evalIn("showFirstTimeExplainerOnce()");
  const wrap = room(m);
  assert.strictEqual(m.intervals.length, 1);
  assert.strictEqual(m.intervals[0].ms, 6000, "each artwork holds the Room for 6s");
  const layers = wrap.querySelectorAll(".ob-layer"), sleeves = wrap.querySelectorAll(".ob-sleeve");
  assert.strictEqual(sleeves.length, 4);
  assert.ok(layers[0].classList.contains("is-on") && !layers[1].classList.contains("is-on"), "the first art starts on the front layer");
  assert.match(layers[0].style.getPropertyValue("--ob-art"), /^url\("https:\/\/is1-ssl\.mzstatic\.com\/image\/thumb\/P\/v4\/0\/400x400bb\.jpg"\)$/);
  const glow0 = wrap.style.getPropertyValue("--glow");
  const tick = () => m.intervals[0].fn();
  tick();
  assert.ok(layers[1].classList.contains("is-on") && !layers[0].classList.contains("is-on"), "the next art fades in as the last fades out");
  assert.match(layers[1].style.getPropertyValue("--ob-art"), /\/v4\/1\//);
  assert.ok(sleeves[1].classList.contains("is-lit") && !sleeves[0].classList.contains("is-lit"), "the lit sleeve follows the art");
  assert.notStrictEqual(wrap.style.getPropertyValue("--glow"), glow0, "and the Room's Glow moves to the new show");
  tick(); tick(); tick();
  assert.ok(layers[0].classList.contains("is-on") && sleeves[0].classList.contains("is-lit"), "four artworks, then round again");
  assert.strictEqual(wrap.style.getPropertyValue("--glow"), glow0);
  wrap.querySelector("#onboarding-skip").click();
  assert.strictEqual(m.intervals[0].live, false, "the cycle stops the moment the Room is answered");

  const still = mount({ reduced: true });
  pool(still, ["One", "Two", "Three", "Four"]);
  still.evalIn("showFirstTimeExplainerOnce()");
  assert.strictEqual(still.intervals.length, 0, "Reduce Motion: the first art, held");
  const one = mount();
  pool(one, ["Only"]);
  one.evalIn("showFirstTimeExplainerOnce()");
  assert.strictEqual(one.intervals.length, 0, "one artwork has nothing to cycle to");
});

/* ================================================================== 7. Show my picks */
test("7. 'Show my picks' sets cp_intro_dismissed through the shim, sends the strip to the hero collage, lets the Room go over 420ms, then Today takes focus", () => {
  /* MUTATION: skip lsSet in dismiss(); drop `wrap.classList.add("is-travelling")`; compute dx from the wrong rects;
     close the sheet before the fade (no timer); drop landOnToday() -> red. */
  const m = mount();
  pool(m, ["One", "Two"]);
  withForay(m, ["One", "Two", "Three"]);
  const hero = m.add("div", null, "td-hero-art"); hero.rect = { left: 16, top: 90, width: 160, height: 160 };
  m.add("h1", null, "td-wordmark");
  m.evalIn("showFirstTimeExplainerOnce()");
  const wrap = room(m);
  const strip = wrap.querySelector(".ob-strip");
  assert.ok(strip, "the strip is drawn");
  strip.rect = { left: 16, top: 294, width: 343, height: 48 };
  assert.strictEqual(m.store.get("cp_intro_dismissed"), undefined, "nothing is written by opening");
  wrap.querySelector("#onboarding-go").click();
  assert.strictEqual(m.store.get("cp_intro_dismissed"), "true", "the flag, through the shim, at the press");
  assert.ok(wrap.classList.contains("is-leaving") && wrap.classList.contains("is-travelling"));
  assert.strictEqual(wrap.style.getPropertyValue("--ob-dx"), `${Math.round(16 + 80 - (16 + 171.5))}px`, "the strip's centre goes to the collage's centre, x");
  assert.strictEqual(wrap.style.getPropertyValue("--ob-dy"), `${Math.round(90 + 80 - (294 + 24))}px`, "and y");
  assert.strictEqual(wrap.style.getPropertyValue("--ob-k"), (160 / 343).toFixed(3), "scaled to the collage's width");
  assert.ok(room(m), "the Room is still up while it lets go");
  assert.ok(m.timeouts.some((t) => t.ms === 460), "closed after the 420ms trip and 40ms of slack");
  assert.ok(!m.timeouts.some((t) => t.ms === 320 || t.ms === 240), "and by no other clock");
  m.flushTimers();
  assert.strictEqual(room(m), null, "and then the Room is gone");
  assert.ok(m.doc.activeElement && m.doc.activeElement.classList.contains("td-wordmark"), "Today's wordmark takes focus");
  assert.ok(!m.doc.body.classList.contains("fy-sheet-open") && !m.view.hasAttribute("inert"), "no lock, nothing inert");
});

test("7b. under Reduce Motion nothing travels: the Room crossfades in 200ms and the strip stays where it is", () => {
  /* MUTATION: drop the `!reducedMotion()` guard on the travel -> the three vars are set; red. */
  const m = mount({ reduced: true });
  pool(m, ["One", "Two"]);
  withForay(m, ["One", "Two", "Three"]);
  const hero = m.add("div", null, "td-hero-art"); hero.rect = { left: 16, top: 90, width: 160, height: 160 };
  m.evalIn("showFirstTimeExplainerOnce()");
  const wrap = room(m);
  wrap.querySelector(".ob-strip").rect = { left: 16, top: 294, width: 343, height: 48 };
  wrap.querySelector("#onboarding-go").click();
  assert.ok(wrap.classList.contains("is-leaving") && !wrap.classList.contains("is-travelling"));
  assert.strictEqual(wrap.style.getPropertyValue("--ob-dx"), "");
  assert.ok(m.timeouts.some((t) => t.ms === 240) && !m.timeouts.some((t) => t.ms === 460), "a 200ms crossfade and 40ms of slack");
  m.flushTimers();
  assert.strictEqual(room(m), null);
});

/* ================================================================== 8. Skip for now */
test("8. 'Skip for now' sets the flag, fades without travelling, and leaves no sheet, no lock and no inert page", () => {
  /* MUTATION: pass travel=true from the skip handler; skip the lsSet; leave closeSheet out of the timer -> red. */
  const m = mount();
  pool(m, ["One", "Two"]);
  withForay(m, ["One", "Two", "Three"]);
  m.add("div", null, "td-hero-art").rect = { left: 16, top: 90, width: 160, height: 160 };
  m.evalIn("showFirstTimeExplainerOnce()");
  const wrap = room(m);
  wrap.querySelector(".ob-strip").rect = { left: 16, top: 294, width: 343, height: 48 };
  assert.ok(m.view.hasAttribute("inert"), "fixture: the page was out of reach");
  wrap.querySelector("#onboarding-skip").click();
  assert.strictEqual(m.store.get("cp_intro_dismissed"), "true");
  assert.ok(wrap.classList.contains("is-leaving") && !wrap.classList.contains("is-travelling"));
  assert.ok(m.timeouts.some((t) => t.ms === 320) && !m.timeouts.some((t) => t.ms === 460), "a plain fade over --m-ui and 40ms of slack");
  m.flushTimers();
  assert.strictEqual(room(m), null);
  assert.ok(!m.view.hasAttribute("inert") && !m.tabBar.hasAttribute("inert"), "nothing is left inert");
  assert.strictEqual(m.evalIn("showFirstTimeExplainerOnce()"), false, "and it does not come back");
  assert.strictEqual(room(m), null);
});

test("8b. a second press while the Room is leaving does nothing (one dismissal, one close)", () => {
  /* MUTATION: drop the `if (leaving) return` guards -> two timers are queued; red. */
  const m = mount();
  m.evalIn("showFirstTimeExplainerOnce()");
  const wrap = room(m);
  wrap.querySelector("#onboarding-go").click();
  wrap.querySelector("#onboarding-skip").click();
  m.doc.key("Escape");
  assert.strictEqual(m.timeouts.filter((t) => [460, 320, 240].includes(t.ms)).length, 1);
});

/* ================================================================== 9. park and replay */
test("9. Escape and a navigation park the Room and write nothing; Settings' 'What 4a does' reopens it for a returning listener and writes nothing", () => {
  /* MUTATION: gate showWhatFouraDoes on isGenuineFirstTimeUser(); write the flag in the replay's dismiss (the replay's
     listener has history and no flag, so the store would change); drop the replay's `location.hash = "#/"`; return early
     without the `$("#onboarding-room")` check -> red. */
  const m = mount();
  m.evalIn("showFirstTimeExplainerOnce()");
  m.doc.key("Escape");
  assert.strictEqual(room(m), null);
  assert.strictEqual(m.store.get("cp_intro_dismissed"), undefined);
  assert.strictEqual(m.evalIn("showFirstTimeExplainerOnce()"), true, "parked: the gate still reports the Room owns the visit");
  assert.strictEqual(room(m), null, "and it does not come back this visit");

  /* A returning listener who never answered the old popup: no cp_intro_dismissed. A replay must not answer it for them. */
  const back = mount({ seed: { cp_history: JSON.stringify(["played-before"]) }, hash: "#/library" });
  assert.strictEqual(back.evalIn("isGenuineFirstTimeUser()"), false, "fixture: a returning listener");
  back.evalIn("showWhatFouraDoes()");
  assert.ok(room(back), "the Room opens for them anyway");
  back.evalIn("showWhatFouraDoes()");
  assert.strictEqual(back.doc.body.querySelectorAll("#onboarding-room").length, 1, "once");
  const before = JSON.stringify([...back.store]);
  room(back).querySelector("#onboarding-go").click();
  assert.strictEqual(back.location.hash, "#/", "'Show my picks' takes a replay to Today");
  assert.strictEqual(JSON.stringify([...back.store]), before, "the replay writes nothing");
  back.flushTimers();
  assert.strictEqual(room(back), null);
  const again = mount({ seed: { cp_history: JSON.stringify(["x"]), cp_intro_dismissed: "true" } });
  again.evalIn("showWhatFouraDoes()");
  again.doc.key("Escape");
  again.evalIn("showWhatFouraDoes()");
  assert.ok(room(again), "a replay is not 'parked' for the visit: it can be asked for again");
});

/* ================================================================== 10. the stylesheet */
test("10. the stylesheet is scoped under .ob-room, carries no Reduce Motion block of its own, and draws durations from tokens", () => {
  /* MUTATION: add a bare `.ob-title {}`; add `@media (prefers-reduced-motion: reduce)`; write `animation: ob-bar-in
     280ms` -> red, naming the rule. */
  const heads = [/^\.room\.ob-room(?![\w-])/, /^\.ob-room(?![\w-])/];
  for (const r of ONB_RULES) {
    if (r.prelude.startsWith("@") || r.atRules.some((a) => a.startsWith("@keyframes"))) continue;
    for (const s of selectorsOf(r.prelude)) assert.ok(heads.some((h) => h.test(s)), `selector "${s}" escapes .ob-room`);
  }
  assert.ok(!/prefers-reduced-motion/.test(ONB_CSS), "one Reduce Motion owner: ui/tokens.css");
  assert.ok(!/@import|url\(|https?:|!important/.test(ONB_CSS), "no import, no url(), no origin, no !important");
  const timed = ONB_RULES.flatMap((r) => Object.entries(decls(r.body)).filter(([p]) => /^(transition|animation)/.test(p)).map(([p, v]) => `${r.prelude} { ${p}: ${v} }`));
  assert.ok(timed.length >= 4, `fixture: the file moves things (${timed.length})`);
  for (const t of timed) assert.ok(!/(^|[\s(])\d*\.?\d+m?s\b/.test(t.replace(/var\([^)]*\)/g, "")), `a raw duration: ${t}`);
  for (const t of timed) assert.ok(!/\b(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier)\b/.test(t), `a raw easing: ${t}`);
  for (const px of [/style=/, /\.style\.(?!setProperty)/]) assert.doesNotMatch(ONB_JS, px, "the Room never writes an inline style attribute");
  const tokens = read("ui/tokens.css");
  assert.strictEqual(tokens.split("prefers-reduced-motion").length - 1, 1, "and tokens.css still has exactly one block");
});

test("10b. the pixel contract: 176px sleeves 40 under the wordmark row, the strip 24 under them and 48 tall, the title 28 under it, buttons held to safe-bottom + 24", () => {
  /* MUTATION: change 176px, the 40px/24px/28px steps, the strip's 48px, or the bottom padding's `var(--s-6)`; give
     `.ob-actions .ag-btn` a height or a min-height (30px) -> red. */
  const px = (v) => (/^var\(--s-(\d+)\)$/.test(v) ? { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 }[/\d+/.exec(v)[0]] : parseInt(v, 10));
  const inner = ruleOf(ONB_CSS, ".ob-room .ob-inner");
  assert.strictEqual(inner.padding, "calc(var(--safe-top) + var(--s-6)) var(--gutter) calc(var(--safe-bottom) + var(--s-6))", "24 under the notch, 24 above the home bar");
  assert.strictEqual(px(ruleOf(ONB_CSS, ".ob-room .ob-mid")["padding-top"]), 40, "the sleeves start 40 under the wordmark row");
  assert.strictEqual(ruleOf(ONB_CSS, ".ob-room .ob-mid").flex, "1 0 auto", "the surplus is the flexible row, between the copy and the buttons");
  assert.strictEqual(ruleOf(ONB_CSS, ".ob-room .ob-mid")["justify-content"], "flex-start", "and never above the sleeves");
  assert.strictEqual(ruleOf(ONB_CSS, ".ob-room .ob-arts").height, "176px");
  assert.strictEqual(ruleOf(ONB_CSS, ".ob-room .ob-strip").height, "48px");
  assert.strictEqual(px(ruleOf(ONB_CSS, ".ob-room .ob-strip")["margin-top"]), 24);
  assert.strictEqual(ruleOf(ONB_CSS, ".ob-room .ob-title")["margin"], "28px 0 0");
  assert.strictEqual(px(ruleOf(ONB_CSS, ".ob-room .ob-arts + .ob-title")["margin-top"]), 24, "with no strip the title sits 24 under the sleeves");
  const wm = ruleOf(ONB_CSS, ".ob-room .ob-wordmark");
  assert.match(wm.font, /^italic 500 1\.625rem\/1\.875rem var\(--font-display\)$/, "26/30: the row ends at safe-top + 24 + 30 = 54");
  const actions = ruleOf(ONB_CSS, ".ob-room .ob-actions");
  assert.strictEqual(px(actions.gap), 12, "Primary and Secondary 12 apart");
  assert.strictEqual(actions["flex-direction"], "column");
  assert.deepStrictEqual(Object.keys(ruleOf(ONB_CSS, ".ob-room .ob-actions .ag-btn")), ["width"], "the Room widens the buttons and resizes nothing else: 48 and 44 are the primitives'");
  assert.strictEqual(ruleOf(ONB_CSS, ".ob-room .ob-actions .ag-btn").width, "100%");
  for (const r of ONB_RULES) {
    if (!selectorsOf(r.prelude).some((x) => /ag-btn/.test(x))) continue;
    for (const p of Object.keys(decls(r.body))) assert.ok(!/^(min-|max-)?(height)$/.test(p), `${r.prelude} must not set ${p}: a button's height is the primitive's`);
  }
  const prim = ruleOf(strip(read("ui/primitives.css")), ".ag .ag-btn-primary"), sec = ruleOf(strip(read("ui/primitives.css")), ".ag .ag-btn");
  assert.strictEqual(prim["min-height"], "calc(var(--tap) + var(--s-1))", "Primary is 48");
  assert.strictEqual(sec["min-height"], "var(--tap)", "and a button is 44 at least");
  assert.deepStrictEqual([1, 2, 3, 4].map((n) => ruleOf(ONB_CSS, `.ob-room .ob-sleeve:nth-child(${n})`)).map((r) => [r["--x"], r["--y"], r["--r"]]),
    [["2", "28", "-8"], ["24", "4", "4"], ["47", "34", "-3"], ["69", "8", "7"]], "four sleeves, rotations -8, 4, -3, 7");
  assert.strictEqual(ruleOf(ONB_CSS, ".ob-room .ob-sleeve .ag-art").width, "96px");
});

test("10c. the scrim's stops are pixels from the top: the head held to the wordmark's last pixel, bright to +248, mid at +272", () => {
  /* MUTATION: change a stop's px; remove the `var(--scrim-head) var(--ob-mark)` hold; move --ob-mark under 54 -> red. */
  const r = ruleOf(ONB_CSS, ".room.ob-room");
  assert.strictEqual(r["--ob-mark"], "calc(var(--safe-top) + 54px)");
  assert.strictEqual(r["--ob-head"], "calc(var(--safe-top) + 72px)");
  assert.strictEqual(r["--ob-bright"], "calc(var(--safe-top) + 248px)");
  assert.strictEqual(r["--ob-mid"], "calc(var(--safe-top) + 272px)");
  const after = ruleOf(ONB_CSS, ".room.ob-room::after").background.replace(/\s+/g, " ");
  assert.strictEqual(after, "linear-gradient(180deg, var(--scrim-head) 0, var(--scrim-head) var(--ob-mark), var(--scrim-top) var(--ob-head), var(--scrim-top) var(--ob-bright), var(--scrim-mid) var(--ob-mid), var(--scrim-low) 100%)");
  const wordmarkEnd = 24 + 30;
  assert.ok(parseInt(/\+ (\d+)px/.exec(r["--ob-mark"])[1], 10) >= wordmarkEnd, "the hold reaches the wordmark's bottom edge");
});

/* ================================================================== 11. contrast */
test("11. the wordmark keeps 3:1 over pure white or pure black art in Dusk and Dawn, and both buttons keep 4.5:1", () => {
  /* MUTATION: lower --scrim-head's alpha in ui/tokens.css, or hold it to a smaller --ob-mark, or colour the
     wordmark with --text-3 -> red. Large text (26px) needs 3:1; the buttons' labels are 14px and need 4.5:1. */
  const tokens = strip(read("ui/tokens.css"));
  const block = (head) => { const i = tokens.indexOf(head); return tokens.slice(i, tokens.indexOf("}", i)); };
  const dusk = block(":root, [data-theme=\"dusk\"] {");
  const dawn = block("[data-theme=\"dawn\"] {\n  --bg0");
  const tok = (b, name) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(b)[1];
  const rgba = (b, name) => { const m = new RegExp(`${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+) / ([\\d.]+)\\)`).exec(b); return { rgb: [m[1], m[2], m[3]].map((v) => Number(v) / 255), a: Number(m[4]) }; };
  const WHITE = [1, 1, 1], BLACK = [0, 0, 0];
  for (const [name, b] of [["Dusk", dusk], ["Dawn", dawn]]) {
    const text = ok.hexToRgb(tok(b, "--ag-text")), head = rgba(b, "--scrim-head");
    for (const [artName, art] of [["white", WHITE], ["black", BLACK]]) {
      const bg = ok.over(head.rgb, head.a, art);
      const c = ok.contrast(text, bg);
      assert.ok(c >= 3, `${name} wordmark over ${artName} art under the head scrim: ${c.toFixed(2)}:1`);
    }
    const emberInk = ok.contrast(ok.hexToRgb(tok(b, "--ember-ink")), ok.hexToRgb(tok(b, "--ember")));
    assert.ok(emberInk >= 4.5, `${name} Primary label on Ember: ${emberInk.toFixed(2)}:1`);
    const secondary = ok.contrast(text, ok.hexToRgb(tok(b, "--bg0")));
    assert.ok(secondary >= 4.5, `${name} Secondary label on the Room's floor: ${secondary.toFixed(2)}:1`);
  }
  assert.match(ruleOf(ONB_CSS, ".ob-room .ob-wordmark").color, /^var\(--text\)$/);
});

/* ================================================================== 12. wiring */
test("12. the Room is wired: the page links its stylesheet, the drawer reopens it, the harness reaches it, screens.json maps its rows, every shipping list carries it", async () => {
  /* MUTATION: drop the <link>, the drawer button or its binding, the `ready` selector, a screens.json row, or the
     file from any SHELL list -> red, naming it. */
  const html = read("index.html");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((x) => x[1]);
  assert.ok(links.includes("ui/onboarding.css") && links.indexOf("ui/onboarding.css") > links.indexOf("ui/tokens.css"), "linked after the tokens it reads");
  assert.match(html, /<button class="drawer-item as-btn" id="intro-replay" type="button">What 4a does<\/button>/, "Settings' entry");
  assert.match(read("ui/drawer.js"), /\$\("#intro-replay"\);\s*if \(intro\) intro\.addEventListener\("click", \(\) => showWhatFouraDoes\(\)\);/, "bound to the Room");
  const states = read("tools/ui-lab/lib/states.mjs");
  assert.match(states, /id: "first-run",[\s\S]*?ready: "#onboarding-room"/, "the harness waits for the Room");
  assert.doesNotMatch(states, /#first-time-sheet/, "and not for the retired sheet");
  const screens = JSON.parse(read("docs/redesign-2026/directions/ambient/screens.json")).screens;
  for (const id of ["onboarding", "onboarding-412", "onboarding-dawn"]) {
    assert.ok(screens[id], `screens.json has ${id}`);
    assert.deepStrictEqual(screens[id].app, { state: "first-run", step: "intro-sheet" });
    for (const r of ["room", "wordmark", "sleeves", "strip", "title", "body", "primary", "secondary"]) assert.ok(screens[id].regions[r], `${id} measures ${r}`);
    assert.strictEqual(screens[id].regions.primary.app, "#onboarding-go");
  }
  assert.strictEqual(new Set(Object.values(screens).map((s) => s.prototype.route)).size, Object.keys(screens).length, "every row has its own prototype route (fidelity keys on it)");
  assert.match(read("tools/ci/generate-manifest.mjs"), /const SHELL = \[[\s\S]*?"ui\/onboarding\.css"/, "the service worker's generation");
  assert.match(read("tools/web/prepare-dist.mjs"), /const SHELL = \[[\s\S]*?"ui\/onboarding\.css"/, "the web dist");
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  assert.ok(pw.SHELL_FILES.includes("ui/onboarding.css") && pw.buildPlan(ROOT).includes("ui/onboarding.css"), "the app bundle");
  assert.doesNotMatch(read("tools/ui-lab/lib/gates/config.mjs"), /#first-time-sheet/, "the gates' sheet list names the Room, not the sheet");
  assert.match(read("tools/ui-lab/lib/gates/config.mjs"), /dialog: "#onboarding-room"/);
});

test("12b. the retired sheet is gone from the client: no #first-time-sheet, no chip grid, no PREFS_CHIP_IDS", () => {
  /* MUTATION: put an id="first-time-sheet" or a PREFS_CHIP_IDS back into any ui/*.js -> red. */
  const code = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, "");   // comments may still tell the sheet's history
  for (const dead of ["first-time-sheet", "PREFS_CHIP_IDS", "renderPreferences", "renderWelcome", "ft-typed-input"]) {
    assert.ok(!code.includes(dead), `${dead} is still in the client's code`);
  }
});
