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
  /** `innerHTML = ""` is how `paintVoiceList` clears the list. */
  set innerHTML(v) { if (v === "") this.children = []; }
  get innerHTML() { return ""; }
}

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
    assert.ok(findIn(row, ".voice-row-audition"), `${nameOf(row)} must offer Audition`);
    assert.strictEqual(row.getAttribute("role"), "radio");
  }

  const missing = missingRows(ui);
  assert.strictEqual(missing.length, EXPECTED_ORDER.length - 2);
  for (const row of missing) {
    const sub = subOf(row);
    assert.match(sub, /Not downloaded/);
    assert.match(sub, /Settings.*Accessibility.*Spoken Content.*Voices.*English/,
      `missing row did not carry the exact Settings path: ${sub}`);
    assert.ok(!findIn(row, ".voice-row-open"), "no dead Open Settings button — @capacitor/app has no such method (see app.js's own comment)");
    assert.ok(!findIn(row, ".voice-row-audition"), "a greyed row must not offer Audition — nothing installed to speak");
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

  const checked = installedRows(ui).filter((r) => r.getAttribute("aria-checked") === "true");
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

  const checked = installedRows(ui).filter((r) => r.getAttribute("aria-checked") === "true");
  assert.deepStrictEqual(checked.map(nameOf), ["Daniel"]);
});

test("an older client with no `defaultVoice` still renders, with nothing selected", async () => {
  const { ui } = mount({ selected: null });
  await ui.open.click();
  await tick();
  assert.strictEqual(installedRows(ui).filter((r) => r.getAttribute("aria-checked") === "true").length, 0);
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
});

test("a device with voices but none on the list says so, rather than 'no voices reported'", async () => {
  const { ui } = mount({
    listVoicesResult: { ok: true, path: "web-speech", voices: [{ identifier: "x", name: "Google US English", language: "en-US", quality: "unknown" }] },
  });
  await ui.open.click();
  await tick();
  assert.strictEqual(rowsOf(ui).length, 0);
  assert.match(findIn(ui.list, ".voice-loading").textContent, /trial voices/);
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

  await installedRows(ui)[0].click(); // Samantha
  assert.deepStrictEqual(setVoiceCalls, ["com.apple.voice.enhanced.en-US.Samantha"]);
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
