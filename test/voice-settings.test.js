/* V-01 — the narration voice picker: drawer item, Audition, persisted choice.
 *
 * `docs/ios-controls-and-voice-plan.md` V-01. Same technique as
 * `test/diagnostics-surface.test.js`: mount `app.js` for real in a `node:vm`
 * over a hand-rolled DOM, with a scripted `window.ForayPlayer` bridge (the
 * shape `player/client.js` exports), and drive the drawer button and the
 * sheet's rows exactly as a listener's tap would.
 *
 * WHAT THIS SUITE PROVES THAT THE `player/queue-manager.test.js` VOICE TESTS
 * CANNOT: those cover the manager's own `_speakNarration`/`setVoice` logic in
 * isolation, with no page at all. Nothing there can see whether the drawer
 * actually carries the control, whether `listVoices()`'s installed/greyed
 * split renders as two different row kinds, or whether tapping a row calls
 * `setNarrationVoice`/`auditionVoice` at all. That gap is `app.js`, and this
 * is its suite — same split `diagnostics-surface.test.js`'s own header names
 * between `player/diagnostic-log.test.js` (mechanism) and itself (surface).
 *
 * MUTATION TEST NAMED BY THE CARD: drop the `voice` option from
 * `_speakNarration`'s `speak()` call in `player/queue-manager.js` — covered
 * by `player/queue-manager.test.js`'s own "MUTATION GUARD" test, not
 * duplicated here. This file's own mutation guards are named at each test.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/* ---------- a DOM with a tree (same minimal harness as diagnostics-surface) ---------- */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.id = null;
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.type = "";
    this.disabled = false;
    this.hidden = false;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._on = new Map();
    this._c = new Set();
    this.classList = {
      add: (c) => this._c.add(c),
      remove: (c) => this._c.delete(c),
      contains: (c) => this._c.has(c),
      toggle: (c, on) => {
        const want = on ?? !this._c.has(c);
        if (want) this._c.add(c); else this._c.delete(c);
        return want;
      },
    };
  }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn) {
    if (!this._on.has(t)) this._on.set(t, new Set());
    this._on.get(t).add(fn);
  }
  removeEventListener(t, fn) { this._on.get(t)?.delete(fn); }
  /** Returns whatever the handlers returned, so an async one can be awaited. */
  click() {
    const out = [];
    for (const fn of [...(this._on.get("click") ?? [])]) out.push(fn({ stopPropagation() {}, preventDefault() {} }));
    return Promise.all(out);
  }
  closest() { return null; }
  querySelector(sel) { return findIn(this, sel); }
  querySelectorAll(sel) { return findAllIn(this, sel); }
  get classes() { return [...new Set(String(this.className).split(/\s+/).filter(Boolean)), ...this._c]; }
  tree() { return [this, ...this.children.flatMap((c) => c.tree())]; }
}

function matches(el, sel) {
  const s = String(sel).trim();
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return el.classes.includes(s.slice(1));
  return el.tagName === s.toUpperCase();
}
function findIn(root, sel) { return root.tree().find((e) => e !== root && matches(e, sel)) ?? null; }
function findAllIn(root, sel) { return root.tree().filter((e) => e !== root && matches(e, sel)); }

/* ---------- the mount ---------- */

/**
 * Mount app.js with a scripted `window.ForayPlayer` (the surface
 * `player/client.js` exports for V-01: `listVoices`, `currentVoice`,
 * `setNarrationVoice`, `auditionVoice`, `lastVoiceFallback`).
 *
 * @param {object} [opts]
 * @param {object} [opts.listVoicesResult]  what `listVoices()` resolves to.
 *   Defaults to two installed voices, best-first, as the card's acceptance
 *   fixture specifies ("a fake bridge returning two installed voices").
 * @param {string|null} [opts.selected]  what `currentVoice()` returns.
 * @param {Function} [opts.onSetVoice]  spy for `setNarrationVoice`.
 * @param {Function} [opts.onAudition]  spy for `auditionVoice`; return a
 *   promise resolving to the `speak()`-shaped result.
 */
function mount({
  listVoicesResult = {
    ok: true, path: "native",
    voices: [
      { identifier: "v-premium", name: "Ava", language: "en-US", quality: "premium" },
      { identifier: "v-enhanced", name: "Samantha", language: "en-US", quality: "enhanced" },
    ],
  },
  selected = null,
  onSetVoice = () => {},
  onAudition = async () => ({ ok: true }),
} = {}) {
  const setVoiceCalls = [];
  const auditionCalls = [];
  const body = new El("body");
  for (const id of ["view", "drawer", "drawer-overlay", "drawer-playlists",
    "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn"]) {
    const el = new El("div");
    el.id = id;
    body.append(el);
  }

  const store = new Map();
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
    forayEventLog: (() => {
      const rows = [];
      return {
        rows,
        append(row) { rows.push(row); },
        async unsynced() { return rows; },
        async markSynced() {},
        async pruneToRetention() {},
        health() { return { ok: true, backend: "memory", pending: 0, ringSize: rows.length, faults: [] }; },
      };
    })(),
    document: {
      body,
      documentElement: body,
      readyState: "complete",
      addEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => findIn(body, s),
      querySelectorAll: (s) => findAllIn(body, s),
    },
    navigator: { userAgent: "node" },
    addEventListener() {},
    removeEventListener() {},
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  process.on("unhandledRejection", () => {});
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  ctx.window.ForayPlayer = {
    listVoices: async () => listVoicesResult,
    currentVoice: () => selected,
    setNarrationVoice: (id) => { setVoiceCalls.push(id); onSetVoice(id); return id; },
    auditionVoice: (text, id) => { auditionCalls.push({ text, id }); return onAudition(text, id); },
    lastVoiceFallback: () => null,
  };
  ctx.bindVoiceControl();

  const ui = {
    open: findIn(body, "#voice-open"),
    sheet: findIn(body, "#voice-sheet"),
    list: findIn(body, "#voice-list"),
    notice: findIn(body, "#voice-notice"),
    close: findIn(body, ".fy-sheet-cancel"),
    scrim: findIn(body, ".fy-scrim"),
  };
  return { ctx, body, ui, setVoiceCalls, auditionCalls };
}

/** Drain pending microtasks — `openVoiceSheet` kicks off an async
    `refreshVoiceList()` that this suite needs to have landed before reading
    the list. */
const tick = () => new Promise((r) => setImmediate(r));

/* ==================================================================== */
/* 1. reachable, in the drawer                                           */
/* ==================================================================== */

test("the drawer carries a Narration voice item", () => {
  // MUTATION: drop `drawer.appendChild(btn)` in `bindVoiceControl`. The
  // control becomes unreachable and this fails.
  const { ui } = mount();
  assert.ok(ui.open, "no #voice-open in the drawer");
  assert.strictEqual(ui.open.textContent, "Narration voice");
  assert.strictEqual(ui.open.parent.id, "drawer", "it has to be IN the drawer");
});

/* ==================================================================== */
/* 2. the acceptance fixture: 2 installed + N greyed rows                */
/* ==================================================================== */

test("2 installed voices render as 2 selectable rows, best-first", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const rows = findAllIn(ui.list, ".voice-row");
  const installed = rows.filter((r) => !r.classes.includes("voice-row-missing"));
  assert.strictEqual(installed.length, 2, `expected 2 installed rows, got ${installed.length}`);
  // best-first: the plugin already sorts, so the FIRST row must be the
  // FIRST voice `listVoices()` returned, not re-sorted by this page.
  assert.match(findIn(installed[0], ".voice-row-name").textContent, /Ava/);
  assert.match(findIn(installed[1], ".voice-row-name").textContent, /Samantha/);
});

test("the recommended-but-missing names render greyed, minus any already installed", async () => {
  // MUTATION: drop the recommended-names loop in `paintVoiceList`. The
  // greyed section disappears and this fails.
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const rows = findAllIn(ui.list, ".voice-row");
  const missing = rows.filter((r) => r.classes.includes("voice-row-missing"));
  const names = missing.map((r) => findIn(r, ".voice-row-name").textContent);
  // Ava and Samantha are INSTALLED in this fixture, so neither must also
  // appear greyed — only Evan, Nathan and Zoe are missing.
  assert.deepStrictEqual(names.sort(), ["Evan", "Nathan", "Zoe"].sort());
});

test("each greyed row names the exact Settings path (and offers no dead Open Settings button)", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const missing = findAllIn(ui.list, ".voice-row-missing");
  assert.ok(missing.length > 0);
  for (const row of missing) {
    const sub = findIn(row, ".voice-row-sub").textContent;
    assert.match(sub, /Settings.*Accessibility.*Spoken Content.*Voices.*English/,
      `missing row did not carry the exact Settings path: ${sub}`);
    assert.ok(!findIn(row, ".voice-row-open"), "no dead Open Settings button — @capacitor/app has no such method (see app.js's own comment)");
    assert.ok(!findIn(row, ".voice-row-audition"), "a greyed row must not offer Audition — nothing installed to speak");
  }
});

test("quality label comes from the plugin's own `quality` field, not re-derived", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const installed = findAllIn(ui.list, ".voice-row").filter((r) => !r.classes.includes("voice-row-missing"));
  const subs = installed.map((r) => findIn(r, ".voice-row-sub").textContent);
  assert.ok(subs.some((s) => s.includes("premium")), `expected a "premium" label, got ${subs}`);
  assert.ok(subs.some((s) => s.includes("enhanced")), `expected an "enhanced" label, got ${subs}`);
});

/* ==================================================================== */
/* 3. Web Speech: installed only, no greyed section, no Open Settings    */
/* ==================================================================== */

test("Web Speech (path: web-speech) shows installed voices only, no greyed section", async () => {
  // Design comment's own answer: `speechSynthesis.getVoices()` has no
  // install state at all, so there is nothing honest to grey out.
  const { ui } = mount({
    listVoicesResult: {
      ok: true, path: "web-speech",
      voices: [{ identifier: "Alex", name: "Alex", language: "en-US", quality: "unknown" }],
    },
  });
  await ui.open.click();
  await tick();

  const rows = findAllIn(ui.list, ".voice-row");
  assert.strictEqual(rows.length, 1, `expected exactly 1 row (no greyed section), got ${rows.length}`);
  assert.ok(!rows[0].classes.includes("voice-row-missing"));
  assert.match(findIn(rows[0], ".voice-row-sub").textContent, /voice/, "unknown quality reads as a bare noun");
});

/* ==================================================================== */
/* 4. selecting a row persists the choice                                */
/* ==================================================================== */

test("selecting an installed row calls setNarrationVoice with its identifier", async () => {
  // MUTATION: drop the `row.addEventListener("click", ...)` wiring in
  // `buildVoiceRow`. Tapping a row does nothing and this fails.
  const { ui, setVoiceCalls } = mount();
  await ui.open.click();
  await tick();

  const rows = findAllIn(ui.list, ".voice-row").filter((r) => !r.classes.includes("voice-row-missing"));
  await rows[1].click(); // Samantha, v-enhanced
  assert.deepStrictEqual(setVoiceCalls, ["v-enhanced"]);
});

/* ==================================================================== */
/* 5. Audition: the exact counting line, at the current rate             */
/* ==================================================================== */

test("Audition speaks the counting line — MUTATION GUARD: it must go 'one' through 'twenty'", async () => {
  // MUTATION: shorten AUDITION_LINE to stop at ten. This fails.
  const { ui, auditionCalls } = mount();
  await ui.open.click();
  await tick();

  const rows = findAllIn(ui.list, ".voice-row").filter((r) => !r.classes.includes("voice-row-missing"));
  const auditionBtn = findIn(rows[0], ".voice-row-audition");
  await auditionBtn.click();

  assert.strictEqual(auditionCalls.length, 1);
  assert.strictEqual(auditionCalls[0].id, "v-premium");
  assert.match(auditionCalls[0].text, /\bone\b/);
  assert.match(auditionCalls[0].text, /\btwenty\b/);
  assert.match(auditionCalls[0].text, /\bfifteen\b/, "the line must name every number, not just the tens");
});

test("a voiceFallback result shows the non-blocking notice", async () => {
  // MUTATION: drop the `if (result && result.voiceFallback)` branch in
  // `auditionVoiceRow`. The notice never appears and this fails.
  const { ui } = mount({ onAudition: async () => ({ ok: true, voiceFallback: true }) });
  await ui.open.click();
  await tick();

  const rows = findAllIn(ui.list, ".voice-row").filter((r) => !r.classes.includes("voice-row-missing"));
  await findIn(rows[0], ".voice-row-audition").click();

  assert.strictEqual(ui.notice.hidden, false);
  assert.match(ui.notice.textContent, /isn't installed/);
});

test("a clean audition (no fallback) clears any previous notice", async () => {
  const { ui } = mount({ onAudition: async () => ({ ok: true, voiceFallback: false }) });
  await ui.open.click();
  await tick();

  const rows = findAllIn(ui.list, ".voice-row").filter((r) => !r.classes.includes("voice-row-missing"));
  await findIn(rows[0], ".voice-row-audition").click();

  assert.strictEqual(ui.notice.hidden, true);
});

/* ==================================================================== */
/* 6. close controls                                                     */
/* ==================================================================== */

test("Close and the scrim both dismiss the sheet", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();
  assert.strictEqual(ui.sheet.hidden, false);

  await ui.close.click();
  assert.strictEqual(ui.sheet.hidden, true);

  await ui.open.click();
  await tick();
  await ui.scrim.click();
  assert.strictEqual(ui.sheet.hidden, true);
});
