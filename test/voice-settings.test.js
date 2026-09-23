/* V-01 — the narration voice picker: drawer item, Audition, persisted choice.
 *
 * `docs/ios-controls-and-voice-plan.md` V-01, revised 2026-09-10 by founder
 * decision ("those voices were all so bad. Samantha was the least worst"):
 * the picker now renders a CURATED allowlist in a fixed order, hides every
 * other installed voice (Apple's novelty and Eloquence catalogue above all),
 * defaults to Samantha's best installed tier, and auditions a count to ten.
 *
 * Same technique as `test/diagnostics-surface.test.js`: mount `app.js` for
 * real in a `node:vm` over a hand-rolled DOM, with a scripted
 * `window.ForayPlayer` bridge (the shape `player/client.js` exports), and
 * drive the drawer button and the sheet's rows exactly as a listener's tap
 * would.
 *
 * WHAT THIS SUITE PROVES THAT THE `player/queue-manager.test.js` VOICE TESTS
 * CANNOT: those cover the manager's own `_speakNarration`/`setVoice` logic in
 * isolation, with no page at all. Nothing there can see whether the drawer
 * actually carries the control, whether a novelty voice the bridge reports
 * reaches a row, which row is painted as chosen, or whether tapping a row
 * calls `setNarrationVoice`/`auditionVoice` at all. That gap is `app.js`,
 * and this is its suite. The default RULE itself lives in
 * `player/default-voice.js` (its own suite); the tests here that need it
 * import the REAL module into the fake bridge's `defaultVoice`, so the page
 * and narration cannot drift apart without one of the two suites going red.
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
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/** The real default rule, loaded once. `player/` is ESM; this file is CJS. */
const loadDefaultVoice = (() => {
  let p = null;
  return () => (p ??= import(pathToFileURL(path.join(ROOT, "player", "default-voice.js")).href));
})();

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
      // A class set through `className` (ddEl's way) counts too, as in a browser.
      contains: (c) => this._c.has(c) || String(this.className).split(/\s+/).includes(c),
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
  /* Focus and ancestry, added 2026-09-22 for the "a rebuild must not throw
     focus out of the sheet" tests at the end of this file: `focus()` moves
     the mounted document's activeElement, and `contains`/`closest` walk the
     real parent links (`[data-voice-id]` is the one attribute selector the
     page asks about). */
  focus() { if (CURRENT_DOC) CURRENT_DOC.activeElement = this; }
  contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; }
  closest(sel) {
    const data = /^\[data-([\w-]+)\]$/.exec(String(sel).trim());
    for (let n = this; n; n = n.parent) {
      if (data) {
        const key = data[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        if (key in n.dataset) return n;
      } else if (matches(n, sel)) return n;
    }
    return null;
  }
  querySelector(sel) { return findIn(this, sel); }
  querySelectorAll(sel) { return findAllIn(this, sel); }
  get classes() { return [...new Set(String(this.className).split(/\s+/).filter(Boolean)), ...this._c]; }
  tree() { return [this, ...this.children.flatMap((c) => c.tree())]; }
  /** `innerHTML = ""` is how `paintVoiceList` clears the list. */
  set innerHTML(v) { if (v === "") this.children = []; }
  get innerHTML() { return ""; }
}

/** The document the most recent mount() built, so `El.focus()` can move its
    activeElement. One mount per test, so a module-level pointer is enough. */
let CURRENT_DOC = null;

function matches(el, sel) {
  const s = String(sel).trim();
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return el.classes.includes(s.slice(1));
  return el.tagName === s.toUpperCase();
}
function findIn(root, sel) { return root.tree().find((e) => e !== root && matches(e, sel)) ?? null; }
function findAllIn(root, sel) { return root.tree().filter((e) => e !== root && matches(e, sel)); }

/* ---------- the fixture: what an iOS 17+ phone with one download reports ---------- */

const v = (identifier, name, language, quality) => ({ identifier, name, language, quality });

/** Samantha at two tiers, Ava premium (a download the founder REMOVED from
    the list), three of Apple's novelty/Eloquence voices at Samantha's own
    `default` tier, Daniel compact, and one non-English voice. This is the
    catalogue that made the founder say "they were all so bad". */
const PHONE = [
  v("com.apple.speech.synthesis.voice.Albert", "Albert", "en-US", "default"),
  v("com.apple.voice.premium.en-US.Ava", "Ava", "en-US", "premium"),
  v("com.apple.eloquence.en-US.Eddy", "Eddy", "en-US", "default"),
  v("com.apple.ttsbundle.Samantha-compact", "Samantha", "en-US", "default"),
  v("com.apple.voice.enhanced.en-US.Samantha", "Samantha", "en-US", "enhanced"),
  v("com.apple.speech.synthesis.voice.Zarvox", "Zarvox", "en-US", "default"),
  v("com.apple.ttsbundle.Daniel-compact", "Daniel", "en-GB", "default"),
  v("com.apple.ttsbundle.Amelie-compact", "Amélie", "fr-FR", "default"),
];

/** The names the page must show, in this order, and nothing else. Pinned
    here as a copy ON PURPOSE: a change to `VOICE_ALLOWLIST` in app.js is a
    product decision that should have to be made twice. */
const EXPECTED_ORDER = [
  "Samantha", "Allison", "Susan", "Joelle", "Tom", "Nicky", "Aaron",
  "Daniel", "Serena", "Karen", "Moira", "Tessa", "Rishi",
];

/* ---------- the mount ---------- */

/**
 * Mount app.js with a scripted `window.ForayPlayer` (the surface
 * `player/client.js` exports for V-01: `listVoices`, `currentVoice`,
 * `setNarrationVoice`, `auditionVoice`, `lastVoiceFallback`, and since
 * 2026-09-10 `defaultVoice`).
 *
 * @param {object} [opts]
 * @param {object} [opts.listVoicesResult]  what `listVoices()` resolves to.
 *   Defaults to the PHONE catalogue above, on the native path.
 * @param {string|null} [opts.selected]  what `currentVoice()` returns.
 * @param {Function} [opts.defaultVoice]  the bridge's `defaultVoice(voices)`;
 *   omitted means an older client with no such method.
 * @param {Function} [opts.onSetVoice]  spy for `setNarrationVoice`.
 * @param {Function} [opts.onAudition]  spy for `auditionVoice`; return a
 *   promise resolving to the `speak()`-shaped result.
 */
function mount({
  listVoicesResult = { ok: true, path: "native", voices: PHONE },
  selected = null,
  defaultVoice,
  onSetVoice = () => {},
  onAudition = async () => ({ ok: true }),
} = {}) {
  const setVoiceCalls = [];
  const auditionCalls = [];
  const listCalls = [];
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
  CURRENT_DOC = ctx.document;
  vm.createContext(ctx);
  process.on("unhandledRejection", () => {});
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });

  ctx.window.ForayPlayer = {
    listVoices: async (opts) => { listCalls.push(opts); return listVoicesResult; },
    currentVoice: () => selected,
    setNarrationVoice: (id) => { setVoiceCalls.push(id); onSetVoice(id); return id; },
    auditionVoice: (text, id) => { auditionCalls.push({ text, id }); return onAudition(text, id); },
    lastVoiceFallback: () => null,
    ...(defaultVoice ? { defaultVoice } : {}),
  };
  ctx.bindVoiceControl();

  const ui = {
    open: findIn(body, "#voice-open"),
    sheet: findIn(body, "#voice-sheet"),
    list: findIn(body, "#voice-list"),
    notice: findIn(body, "#voice-notice"),
    close: findIn(body, ".fy-sheet-cancel"),
    scrim: findIn(body, ".fy-scrim"),
    sub: findIn(body, ".fy-sheet-sub"),
  };
  return { ctx, body, ui, setVoiceCalls, auditionCalls, listCalls };
}

/** Drain pending microtasks — `openVoiceSheet` kicks off an async
    `refreshVoiceList()` that this suite needs to have landed before reading
    the list. */
const tick = () => new Promise((r) => setImmediate(r));

const rowsOf = (ui) => findAllIn(ui.list, ".voice-row");
const nameOf = (row) => findIn(row, ".voice-row-name").textContent;
const subOf = (row) => findIn(row, ".voice-row-sub").textContent;
const installedRows = (ui) => rowsOf(ui).filter((r) => !r.classes.includes("voice-row-missing"));
/* The radio inside an installed row (audit 2026-09-22, qa row 81): the row is a
   plain container now, holding the radio and its Preview button as SIBLINGS. */
const choiceOf = (row) => findIn(row, ".voice-row-choice");
const missingRows = (ui) => rowsOf(ui).filter((r) => r.classes.includes("voice-row-missing"));

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
/* 2. the curated list: allowlist only, fixed order, best tier per name   */
/* ==================================================================== */

test("MUTATION GUARD: a novelty voice the bridge reports is NOT rendered — only allowlisted names reach a row", async () => {
  // MUTATION: in `curateVoices`, return one entry per voice the bridge
  // listed instead of one per allowlist name. Albert/Eddy/Zarvox appear
  // and this fails. That is the exact screen the founder called "all so
  // bad": `ForayTtsPlugin.swift` does not filter `isNoveltyVoice`.
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const names = rowsOf(ui).map(nameOf);
  for (const hidden of ["Albert", "Eddy", "Zarvox", "Amélie"]) {
    assert.ok(!names.includes(hidden), `${hidden} must never reach a row, got ${names}`);
  }
  assert.deepStrictEqual(names, EXPECTED_ORDER, "every allowlisted name, in the fixed order, and nothing else");
});

test("Ava, Evan, Nathan and Zoe are gone — an INSTALLED Ava premium is hidden too", async () => {
  // MUTATION: put "Ava" back in `VOICE_ALLOWLIST`. The premium Ava in the
  // fixture renders and this fails. Founder decision 2026-09-10: only
  // Samantha survives the first cut's five.
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const names = rowsOf(ui).map(nameOf);
  for (const removed of ["Ava", "Evan", "Nathan", "Zoe"]) {
    assert.ok(!names.includes(removed), `${removed} was removed by founder decision, got ${names}`);
  }
});

test("the same name at several tiers renders ONE row carrying the best tier's identifier and label", async () => {
  // MUTATION: in `curateVoices`, drop the `voiceQualityRank(...) >` compare
  // (keep the first match). The row carries the compact identifier and the
  // "default" label, and both asserts fail.
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const samanthas = rowsOf(ui).filter((r) => nameOf(r) === "Samantha");
  assert.strictEqual(samanthas.length, 1, "one Samantha row, not one per tier");
  // The tier label is the middle `·`-separated field (description · tier ·
  // language); the description itself says "the default", so match the field.
  const sub = subOf(samanthas[0]);
  assert.ok(sub.includes("· enhanced ·"), `expected the enhanced tier's label, got: ${sub}`);
  assert.ok(!sub.includes("· default ·"), `the compact tier must not be the one shown: ${sub}`);
});

test("installed allowlisted voices are selectable rows with Audition; the rest are greyed with the Settings path and no dead button", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();

  assert.deepStrictEqual(installedRows(ui).map(nameOf), ["Samantha", "Daniel"]);
  for (const row of installedRows(ui)) {
    assert.ok(findIn(row, ".voice-row-audition"), `${nameOf(row)} must offer Preview`);
    assert.strictEqual(choiceOf(row).getAttribute("role"), "radio");
    /* MUTATION: append the Preview button to the choice instead of the row. */
    assert.strictEqual(findIn(choiceOf(row), ".voice-row-audition"), null,
      "Preview must be beside the radio, never inside it — a control nested in a control");
    assert.strictEqual(row.getAttribute("role"), null, "the row itself is not a radio any more");
  }

  const missing = missingRows(ui);
  assert.strictEqual(missing.length, EXPECTED_ORDER.length - 2);
  for (const row of missing) {
    const sub = subOf(row);
    assert.match(sub, /Not downloaded/);
    assert.match(sub, /Settings.*Accessibility.*Spoken Content.*Voices.*English/,
      `missing row did not carry the exact Settings path: ${sub}`);
    assert.ok(!findIn(row, ".voice-row-open"), "no dead Open Settings button — @capacitor/app has no such method (see app.js's own comment)");
    assert.ok(!findIn(row, ".voice-row-audition"), "a greyed row must not offer Preview — nothing installed to speak");
    assert.strictEqual(row.getAttribute("role"), null, "no orphan listitem role outside a list");
  }
});

test("every row carries its one-line description (accent · gender · tier), and unconfirmed names say so", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const byName = Object.fromEntries(rowsOf(ui).map((r) => [nameOf(r), subOf(r)]));
  assert.match(byName.Samantha, /American/);
  assert.match(byName.Daniel, /British/);
  assert.match(byName.Karen, /Australian/);
  assert.match(byName.Moira, /Irish/);
  assert.match(byName.Tessa, /South African/);
  assert.match(byName.Rishi, /Indian/);
  // Nicky and Aaron could not be confirmed against any listing of the
  // Settings → Voices screen (app.js's own note); the row must say so
  // rather than pass a guess off as a fact.
  assert.match(byName.Nicky, /unverified name/);
  assert.match(byName.Aaron, /unverified name/);
});

test("quality label comes from the plugin's own `quality` field, not re-derived", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();

  const subs = installedRows(ui).map(subOf);
  assert.ok(subs.some((s) => s.includes("enhanced")), `expected an "enhanced" label, got ${subs}`);
  assert.ok(subs.some((s) => s.includes("default")), `expected the plugin's own "default" label for Daniel, got ${subs}`);
});

/* ==================================================================== */
/* 3. the request covers every English locale                            */
/* ==================================================================== */

test("MUTATION GUARD: listVoices is asked for lang 'en', not 'en-US'", async () => {
  // MUTATION: change `VOICE_LIST_LANG` back to "en-US". Both native halves
  // match the exact locale FIRST AND ALONE, so Daniel/Karen/Moira/Tessa/
  // Rishi would never come back while Samantha compact is installed — and
  // it always is. This fails.
  const { ui, listCalls } = mount();
  await ui.open.click();
  await tick();
  assert.strictEqual(listCalls.length, 1);
  // Not deepStrictEqual: the object was built inside the vm context and has
  // that realm's Object.prototype, which strict comparison treats as a
  // different type.
  assert.deepEqual({ ...listCalls[0] }, { lang: "en" });
});

/* ==================================================================== */
/* 4. Samantha is the default; a stored choice wins                      */
/* ==================================================================== */

test("MUTATION GUARD: with nothing stored, Samantha's best installed tier is the selected row", async () => {
  // MUTATION: in `selectedVoiceId`, drop the `player.defaultVoice(...)`
  // fallback. Nothing is selected and this fails. The RULE is the real
  // `player/default-voice.js`, imported here, so a change to it that
  // stopped picking Samantha fails this test AND its own suite.
  const { pickDefaultVoice } = await loadDefaultVoice();
  const { ui } = mount({ selected: null, defaultVoice: pickDefaultVoice });
  await ui.open.click();
  await tick();

  const checked = installedRows(ui).filter((r) => choiceOf(r).getAttribute("aria-checked") === "true");
  assert.strictEqual(checked.length, 1, "exactly one row is selected");
  assert.strictEqual(nameOf(checked[0]), "Samantha");
  assert.ok(checked[0].classes.includes("voice-row-selected"));
});

test("a stored choice is never overridden by the default", async () => {
  // MUTATION: make `selectedVoiceId` prefer `defaultVoice` over
  // `currentVoice`. Samantha is painted selected over the listener's own
  // Daniel and this fails.
  const { pickDefaultVoice } = await loadDefaultVoice();
  const { ui } = mount({ selected: "com.apple.ttsbundle.Daniel-compact", defaultVoice: pickDefaultVoice });
  await ui.open.click();
  await tick();

  const checked = installedRows(ui).filter((r) => choiceOf(r).getAttribute("aria-checked") === "true");
  assert.deepStrictEqual(checked.map(nameOf), ["Daniel"]);
});

test("an older client with no `defaultVoice` still renders, with nothing selected", async () => {
  const { ui } = mount({ selected: null });
  await ui.open.click();
  await tick();
  assert.strictEqual(installedRows(ui).filter((r) => choiceOf(r).getAttribute("aria-checked") === "true").length, 0);
  assert.strictEqual(rowsOf(ui).length, EXPECTED_ORDER.length);
});

/* ==================================================================== */
/* 5. Web Speech: installed only, no greyed section, allowlist still applies */
/* ==================================================================== */

test("Web Speech (path: web-speech) shows installed allowlisted voices only, no greyed section", async () => {
  // Design comment's own answer: `speechSynthesis.getVoices()` has no
  // install state at all, so there is nothing honest to grey out. The
  // allowlist still applies: a browser's "Google US English" is not shown.
  const { ui } = mount({
    listVoicesResult: {
      ok: true, path: "web-speech",
      voices: [
        { identifier: "Google US English", name: "Google US English", language: "en-US", quality: "unknown" },
        { identifier: "Samantha", name: "Samantha", language: "en-US", quality: "unknown" },
      ],
    },
  });
  await ui.open.click();
  await tick();

  const rows = rowsOf(ui);
  assert.strictEqual(rows.length, 1, `expected exactly 1 row (no greyed section), got ${rows.length}`);
  assert.strictEqual(nameOf(rows[0]), "Samantha");
  assert.ok(!rows[0].classes.includes("voice-row-missing"));
  assert.match(subOf(rows[0]), /voice/, "unknown quality reads as a bare noun");
  /* REVIEW 2026-09-23: no dimmed rows, so no sentence about dimmed voices or a
     phone's Settings. MUTATION: put the sentence back in the fixed subtitle, or
     leave .voice-missing-note always visible. */
  const note = findIn(ui.sheet, ".voice-missing-note");
  assert.ok(!note || note.hidden, "the dimmed-voices note is not shown on the Web Speech path");
  assert.doesNotMatch(ui.sub.textContent, /Dimmed|phone's Settings/, "and the fixed subtitle does not say it");
});

test("REVIEW: on the native path with a voice to download, the dimmed-voices note is shown", async () => {
  const { ui } = mount();
  await ui.open.click();
  await tick();
  assert.ok(rowsOf(ui).some((r) => r.classes.includes("voice-row-missing")), "fixture: a dimmed row is shown");
  const note = findIn(ui.sheet, ".voice-missing-note");
  assert.ok(note && !note.hidden, "the note explains the dimmed rows");
  assert.match(note.textContent, /Dimmed voices are free to download/);
});

test("a device with voices but none on the list says so, rather than 'no voices reported'", async () => {
  const { ui } = mount({
    listVoicesResult: { ok: true, path: "web-speech", voices: [{ identifier: "x", name: "Google US English", language: "en-US", quality: "unknown" }] },
  });
  await ui.open.click();
  await tick();
  assert.strictEqual(rowsOf(ui).length, 0);
  assert.match(findIn(ui.list, ".voice-loading").textContent, /voices 4a suggests/);
});

/* ==================================================================== */
/* 6. selecting a row persists the choice                                */
/* ==================================================================== */

test("selecting an installed row calls setNarrationVoice with the best tier's identifier", async () => {
  // MUTATION: drop the `row.addEventListener("click", ...)` wiring in
  // `buildVoiceRow`. Tapping a row does nothing and this fails.
  const { ui, setVoiceCalls } = mount();
  await ui.open.click();
  await tick();

  await choiceOf(installedRows(ui)[0]).click(); // Samantha
  assert.deepStrictEqual(setVoiceCalls, ["com.apple.voice.enhanced.en-US.Samantha"]);
});

/* The group a screen reader and a keyboard can find (audit 2026-09-22, qa row
   81): the list is a named radiogroup, exactly one radio is a tab stop, and an
   arrow key selects the neighbour, as a native radio group's does.
   MUTATION 1: drop `list.setAttribute("role", "radiogroup")`.
   MUTATION 2: make every choice `tabIndex = 0` (all rows as tab stops again).
   MUTATION 3: drop the ArrowDown branch of the choice's keydown handler. */
test("the voices are one named radio group: one tab stop, arrows move the choice", async () => {
  const { ui, setVoiceCalls } = mount();
  await ui.open.click();
  await tick();

  assert.strictEqual(ui.list.getAttribute("role"), "radiogroup");
  assert.strictEqual(ui.list.getAttribute("aria-labelledby"), "voice-title");
  const choices = installedRows(ui).map(choiceOf);
  assert.ok(choices.length >= 2, "the fixture has two installed voices");
  assert.deepStrictEqual(choices.map((c) => c.tabIndex).filter((t) => t === 0).length, 1,
    "exactly one radio in the group is a tab stop");

  const keydown = (el, key) => { for (const fn of el._on.get("keydown") ?? []) fn({ key, preventDefault() {} }); };
  keydown(choices[0], "ArrowDown");
  assert.deepStrictEqual(setVoiceCalls, [choices[1].dataset.voiceId], "ArrowDown selects the next voice");
  /* REVIEW 2026-09-23: and announces it by name, as a click does. MUTATION:
     call `selectVoiceRow(next)` with one argument in moveVoiceChoice. */
  assert.strictEqual(ui.notice.hidden, false, "the choice is announced");
  assert.strictEqual(ui.notice.textContent, `${nameOf(installedRows(ui)[1])} selected.`);
  const preview = findIn(installedRows(ui)[0], ".voice-row-audition");
  assert.strictEqual(preview.getAttribute("aria-label"), `Preview ${nameOf(installedRows(ui)[0])}`,
    "each Preview names its voice");
});

/* ==================================================================== */
/* 7. Audition: exactly a count to ten, at the current rate              */
/* ==================================================================== */

test("MUTATION GUARD: Audition speaks exactly 'one' through 'ten' — no markers, nothing past ten", async () => {
  // MUTATION: restore the twenty-count line, or add a "Marker" phrase.
  // Founder, 2026-09-10: "reduce the script to just counting to ten, it
  // was so bad listening to them for so long."
  const { ui, auditionCalls } = mount();
  await ui.open.click();
  await tick();

  await findIn(installedRows(ui)[0], ".voice-row-audition").click();

  assert.strictEqual(auditionCalls.length, 1);
  assert.strictEqual(auditionCalls[0].id, "com.apple.voice.enhanced.en-US.Samantha");
  assert.strictEqual(auditionCalls[0].text, "one, two, three, four, five, six, seven, eight, nine, ten.");
});

test("the sheet's own copy describes the count to ten", () => {
  const { ui } = mount();
  assert.match(ui.sub.textContent, /count to ten/);
  assert.ok(!/twenty/.test(ui.sub.textContent));
});

test("a voiceFallback result shows the non-blocking notice", async () => {
  // MUTATION: drop the `if (result && result.voiceFallback)` branch in
  // `auditionVoiceRow`. The notice never appears and this fails.
  const { ui } = mount({ onAudition: async () => ({ ok: true, voiceFallback: true }) });
  await ui.open.click();
  await tick();

  await findIn(installedRows(ui)[0], ".voice-row-audition").click();

  assert.strictEqual(ui.notice.hidden, false);
  assert.match(ui.notice.textContent, /isn't installed/);
});

test("a clean audition (no fallback) clears any previous notice", async () => {
  const { ui } = mount({ onAudition: async () => ({ ok: true, voiceFallback: false }) });
  await ui.open.click();
  await tick();

  await findIn(installedRows(ui)[0], ".voice-row-audition").click();

  assert.strictEqual(ui.notice.hidden, true);
});

/* ==================================================================== */
/* 8. close controls                                                     */
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

/* ==================================================================== */
/* 9. a rebuild must not throw focus out of the sheet (audit 2026-09-22) */
/* ==================================================================== */

/* Every select and every Audition repaints the list, which destroyed the row
   or button that had just been activated: focus fell to <body>, behind the
   scrim, and a keyboard or screen-reader user had to find their way back into
   the dialog from the top of the document after every action. */

test("after selecting a voice, focus is on that voice's (new) row, and the choice is announced", async () => {
  /* MUTATION: delete the `if (focusVoice) { ... }` block at the end of
     paintVoiceList -> focus is left on a row that is no longer in the
     document; red. MUTATION: `paintVoiceNotice("")` in selectVoiceRow -> red. */
  const { ctx, ui } = mount();
  await ui.open.click();
  await tick();
  /* The radio, not the row, since L4 (integration): the row is a plain
     container holding the radio and Preview as siblings. */
  const before = choiceOf(installedRows(ui)[0]);
  before.focus();
  await before.click();
  const after = choiceOf(installedRows(ui)[0]);
  assert.notStrictEqual(after, before, "fixture assumption: the list really was rebuilt");
  assert.strictEqual(ctx.document.activeElement, after, "focus follows the voice into its rebuilt radio");
  assert.strictEqual(ui.notice.hidden, false);
  assert.match(ui.notice.textContent, /^Samantha selected\.$/);
});

test("after Audition, focus is back on that voice's Audition button", async () => {
  /* The button is rebuilt twice (disabled while it plays, then enabled);
     while it is disabled focus waits on the row, then returns to the button.
     MUTATION: drop `focusAudition` (always focus the row) -> red. */
  const { ctx, ui } = mount();
  await ui.open.click();
  await tick();
  const btn = findIn(installedRows(ui)[0], ".voice-row-audition");
  btn.focus();
  await btn.click();
  const rebuilt = findIn(installedRows(ui)[0], ".voice-row-audition");
  assert.notStrictEqual(rebuilt, btn, "fixture assumption: the button was rebuilt");
  assert.strictEqual(ctx.document.activeElement, rebuilt,
    "once it plays out, focus is back on the (rebuilt) Audition button — never on <body>");
});
