/* Tactile `library` (Yours, Up Next): the chip strip and the queue rows.
 * Redesign 2026, docs/redesign-2026/directions/tactile/BUILD-PLAN.md 2.12 and
 * 2.16, BUILD-NOTES 3.9 and 4.5. Code: ui/library.js (renderLibrary and the
 * yours* helpers), app.js repaintQueuePage, styles.css "YOURS (TACTILE)".
 *
 * WHAT THIS PROVES
 *   1. The strip is a tablist of the six chips in the prototype's order, each a
 *      tab that controls one panel; the chosen chip carries the check and
 *      aria-selected, only its panel is shown, the Up Next badge exists only
 *      with something queued, and the page opens on Up Next with a queue and on
 *      Forays without one.
 *   2. The readout line: "5 queued · 4 hr 55 min", "0 queued" with no tail, and
 *      it follows a queue write.
 *   3. A queue row's anatomy: position, artwork, a two-line title, show and
 *      remaining time; the playing row is the soft fill with the needle in place
 *      of its number, a "Playing" tag, "· N min left" and NO show name; the
 *      trailing control is the bare icon button, never a keycap.
 *   4. The action row: Move up, Move down and Remove as real buttons carrying
 *      their words; the playing row offers only Remove; Move up is off on the
 *      row under the playing one.
 *   5. Reorder and Remove write cp_queue through the one writer and the page
 *      repaints in place (rows slide by translateY, never by height); the
 *      Yours badge and the readout tick down and back.
 *   6. Remove shows the undo toast for 4 seconds, holds it while touched, and
 *      Undo puts the episode back where it was.
 *   7. Clear asks first (a sheet with focus moved in, Escape and Keep leave the
 *      list alone, Clear empties it but for the playing row).
 *   8. Escaping: a title and an id with markup in them reach the page inert.
 *   9. The sheet's own rules: 36px chips 8 apart, a 64px row with a 20px
 *      position, one line of three keys, no height transition, every new
 *      transition and animation in the one reduced-motion block.
 *
 * WHAT IT CANNOT PROVE: how any of it looks (tools/ui-lab/fidelity.mjs measures
 * that in a real browser: the library screen's regions sit within 4px of the
 * prototype), or that a finger finds the 44px targets (test/tap-targets.test.js
 * walks them).
 *
 * HARNESS AUDIT (CLAUDE.md "a green test is not evidence until you have broken
 * it"). The real app.js and ui/*.js run in a node:vm over fake-dom's El, so the
 * page is parsed from the markup renderLibrary wrote and a click goes through
 * the handler the page bound. Three things the stub would otherwise answer too
 * kindly are patched to behave like a browser: `closest` walks parents (a
 * delegated handler that matched on the wrong element must miss), `focus` moves
 * document.activeElement (a repaint that loses focus must show), and timers are
 * HELD (a claim about the 4-second clock is made against the delay it was armed
 * with, not a wall clock). Each test names its mutation; all were run red.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
const { parseRules } = require("./helpers/dial-css.js");
const { El, matches } = require("./helpers/fake-dom.js");

const ROOT = path.join(__dirname, "..");
const APP_SRC = readAppSource();
const SEARCH_SRC = fs.readFileSync(path.join(ROOT, "search-engine.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

process.on("unhandledRejection", () => {});

/* fake-dom's El answers `closest` with null, has no `contains`, `parentElement`
   or `lastElementChild`, and focus() does nothing. The page uses all of them. */
let activeDoc = null;
El.prototype.closest = function closest(sel) {
  for (let n = this; n; n = n.parent) if (matches(n, sel)) return n;
  return null;
};
El.prototype.contains = function contains(other) {
  for (let n = other; n; n = n.parent) if (n === this) return true;
  return false;
};
Object.defineProperty(El.prototype, "parentElement", { get() { return this.parent; }, configurable: true });
Object.defineProperty(El.prototype, "lastElementChild", { get() { return this.children[this.children.length - 1] || null; }, configurable: true });
El.prototype.focus = function focus() { if (activeDoc) activeDoc.activeElement = this; };

function flatEl(id) {
  return {
    tagName: "DIV", id, className: "", innerHTML: "", textContent: "", value: "", hidden: false, disabled: false,
    dataset: {}, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild(k) { this.children.push(k); return k; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, select() {}, click() {}, remove() {},
  };
}

const PAGE_IDS = [
  "drawer", "drawer-overlay", "drawer-playlists", "family-toggle", "player-toggle", "autoadvance-toggle",
  "menu-btn", "refresh-btn", "banner-slot", "pl-form", "pl-input", "pl-note",
];

/** `timers` holds every setTimeout the page arms (ms, fn, id) and `cleared` every
    id it cancels, so the 4-second claim is read off the arming, not waited for. */
function mount({ seed = {}, boot = false } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const view = new El("main");
  view.id = "view";
  const body = new El("body");
  const byId = new Map(PAGE_IDS.map((id) => [id, flatEl(id)]));
  const timers = [];
  const cleared = [];
  const doc = {
    body, documentElement: body, readyState: "complete", activeElement: body, hidden: false,
    addEventListener() {}, removeEventListener() {}, createElement: (t) => new El(t),
    querySelector: (sel) => {
      const s = String(sel).trim();
      if (s === "#view") return view;
      if (s.startsWith("#view ")) return view.querySelector(s.slice(6));
      const id = /^#([\w-]+)$/.exec(s);
      if (id && byId.has(id[1])) return byId.get(id[1]);
      return view.querySelector(s) || body.querySelector(s) || null;
    },
    querySelectorAll: () => [],
  };
  activeDoc = doc;
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: (url) => {
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = String(url).startsWith("data/") && fs.existsSync(file);
      return Promise.resolve({ ok, status: ok ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) });
    },
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: doc,
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#/library", search: "", pathname: "/", href: "https://x.test/" },
    history: { replaceState() {}, pushState() {} },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise,
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, ms, fn }); return id; },
    clearTimeout: (id) => { cleared.push(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    encodeURIComponent, decodeURIComponent, scrollY: 0, scrollTo() {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  byId.set("view", view);
  vm.createContext(ctx);
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  runAppSource(APP_SRC, ctx);
  const evalIn = (src) => vm.runInContext(src, ctx);
  return { ctx, evalIn, store, body, view, doc, timers, cleared, state: evalIn("state"), html: () => view.innerHTML };
}

async function mountBooted(seed) {
  const m = mount({ seed, boot: true });
  /* Boot uses real timers for its own waits; ours are held, so let the held
     ones that are the boot's run while the page settles. */
  for (let i = 0; i < 400 && !m.state.ready; i++) {
    await new Promise((r) => setImmediate(r));
    while (m.timers.length) { const t = m.timers.shift(); try { t.fn(); } catch (_) { /* a boot timer */ } }
  }
  assert.ok(m.state.ready, "init() never finished against the committed data files");
  m.timers.length = 0;
  m.cleared.length = 0;
  return m;
}

/** A player that knows `cur` as the episode on the bar. */
function withPlayer(m, cur, extra = {}) {
  m.ctx.window.ForayPlayer = {
    isCurrent: (id) => id === cur,
    currentEpisodeId: () => cur,
    togglePlayback: async () => { (m.toggled = m.toggled || []).push("toggle"); },
    episodeProgress: (id) => (id === cur ? { state: "started", label: "42 min left" } : null),
    listForays: () => [],
    forayResumeList: () => [],
    ...extra,
  };
}

/** Queue the first `n` playable episodes (addToQueue refuses what 4a cannot play). */
function queue(m, n) {
  const items = readJson("data/discover.json").items.filter((it) => it.audio_url).slice(0, n);
  m.ctx.fullPool();
  for (const it of items) m.ctx.addToQueue(it.id);
  return items;
}

const q = (m, sel) => m.view.querySelectorAll(sel);
const one = (m, sel) => m.view.querySelector(sel);
const queueIds = (m) => [...m.ctx.queueIds()];
const textOf = (el) => el.textContent;

/** A click the way the browser delivers it: on the element, which the delegated
    handler resolves with closest(). */
function press(m, attrValue) {
  const target = q(m, "[data-action]").find((b) => b.getAttribute("data-action") === attrValue);
  assert.ok(target, `no control with data-action="${attrValue}"`);
  const panel = target.closest("#yours-panel-upnext");
  assert.ok(panel, "the control is in the Up Next panel");
  const fns = panel._on.get("click") || [];
  assert.ok(fns.length, "the Up Next panel has a click handler");
  if (!target.disabled) m.doc.activeElement = target; // a click focuses the control, as a browser does
  fns.forEach((fn) => fn({ target, preventDefault() {}, stopPropagation() {} }));
}

/* ==================================================================== */
/* 1. THE STRIP                                                          */
/* ==================================================================== */

test("the strip is a tablist of six chips in order; each tab controls a panel; one panel is shown", async () => {
  /* MUTATION 1: take `role="tablist"` off #yours-chips (yoursChipsHtml's host in
     renderLibrary) - the tablist assertion fails.
     MUTATION 2: swap two entries of yoursChipDefs() - the order assertion fails.
     MUTATION 3: render every panel without `hidden` - the one-panel assertion
     fails. */
  const m = await mountBooted();
  queue(m, 2);
  m.ctx.renderLibrary();
  const strip = one(m, "#yours-chips");
  assert.ok(strip, "the strip exists");
  assert.strictEqual(strip.getAttribute("role"), "tablist");
  const tabs = q(m, "[data-yours-chip]");
  assert.deepStrictEqual(tabs.map((t) => t.getAttribute("data-yours-chip")), ["forays", "shows", "saved", "playlists", "upnext", "history"]);
  assert.deepStrictEqual(tabs.map((t) => textOf(t.querySelector("span"))), ["Forays", "Shows", "Saved", "Playlists", "Up Next", "History"].map((s) => s));
  for (const t of tabs) {
    assert.strictEqual(t.getAttribute("role"), "tab");
    const panel = one(m, `#${t.getAttribute("aria-controls")}`);
    assert.ok(panel, `${t.id} controls a panel that exists`);
    assert.strictEqual(panel.getAttribute("role"), "tabpanel");
    assert.strictEqual(panel.getAttribute("aria-labelledby"), t.id);
  }
  const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
  assert.strictEqual(selected.length, 1, "exactly one chip is selected");
  assert.strictEqual(selected[0].getAttribute("data-yours-chip"), "upnext", "with a queue the page opens on Up Next");
  const shown = q(m, ".yours-panel").filter((p) => !p.hidden);
  assert.deepStrictEqual(shown.map((p) => p.id), ["yours-panel-upnext"], "only the chosen panel is shown");
  assert.ok(selected[0].querySelector("svg"), "the chosen chip carries the check");
  assert.strictEqual(tabs.filter((t) => t.querySelector("svg")).length, 1, "and only the chosen chip does");
  assert.strictEqual(selected[0].getAttribute("tabindex"), "0", "the chosen chip is in the Tab order");
  assert.ok(tabs.filter((t) => t !== selected[0]).every((t) => t.getAttribute("tabindex") === "-1"), "the others are reached by the arrows");
});

test("the page opens on Forays with nothing queued, remembers a chosen chip, and the Up Next badge exists only with a queue", async () => {
  /* MUTATION 1: default to "upnext" regardless (yoursActiveKey's last line) -
     the empty-queue half fails.
     MUTATION 2: drop `state.yoursChip = chip` in renderLibrary - the
     remembered-chip half fails.
     MUTATION 3: render the badge at 0 (`queued > 0` -> `queued >= 0`) - the
     badge half fails. */
  const m = await mountBooted();
  m.ctx.renderLibrary();
  assert.strictEqual(one(m, '[aria-selected="true"]').getAttribute("data-yours-chip"), "forays");
  assert.ok(!one(m, ".chip__count"), "no badge at 0 queued");
  queue(m, 3);
  m.state.yoursChip = null;
  m.ctx.renderLibrary();
  assert.strictEqual(one(m, ".chip__count").textContent, "3", "the badge counts the queue");
  assert.strictEqual(one(m, "#yours-chip-upnext").getAttribute("aria-label"), "Up Next, 3 queued", "and the chip's name says what it counts");
  m.ctx.renderLibrary("saved");
  assert.strictEqual(one(m, '[aria-selected="true"]').getAttribute("data-yours-chip"), "saved");
  m.ctx.renderLibrary();
  assert.strictEqual(one(m, '[aria-selected="true"]').getAttribute("data-yours-chip"), "saved", "a repaint keeps the chip the listener chose");
});

test("a chip press shows one panel and renders nothing; the arrows, Home and End move between chips", async () => {
  /* MUTATION 1: make selectYoursChip rebuild the panels (replace the hide/show
     loop with a renderLibrary(key) call) - the same-panel-element assertion
     fails, because the Saved panel is a new node.
     MUTATION 2: drop the ArrowRight branch - the keyboard half fails. */
  const m = await mountBooted();
  queue(m, 2);
  m.ctx.renderLibrary();
  const savedPanelBefore = one(m, "#yours-panel-saved");
  const strip = one(m, "#yours-chips");
  const click = strip._on.get("click")[0];
  click({ target: one(m, "#yours-chip-saved") });
  assert.strictEqual(one(m, "#yours-panel-saved"), savedPanelBefore, "the panel was shown, not rebuilt");
  assert.deepStrictEqual(q(m, ".yours-panel").filter((p) => !p.hidden).map((p) => p.id), ["yours-panel-saved"]);
  assert.match(textOf(one(m, "#yours-readout")), /saved episodes?$/, "the readout names the chosen chip's count");
  const key = strip._on.get("keydown")[0];
  let prevented = 0;
  key({ key: "ArrowRight", target: one(m, "#yours-chip-saved"), preventDefault() { prevented++; } });
  assert.strictEqual(one(m, '[aria-selected="true"]').getAttribute("data-yours-chip"), "playlists");
  key({ key: "End", target: one(m, "#yours-chip-playlists"), preventDefault() { prevented++; } });
  assert.strictEqual(one(m, '[aria-selected="true"]').getAttribute("data-yours-chip"), "history");
  key({ key: "ArrowRight", target: one(m, "#yours-chip-history"), preventDefault() { prevented++; } });
  assert.strictEqual(one(m, '[aria-selected="true"]').getAttribute("data-yours-chip"), "forays", "the arrows wrap");
  key({ key: "Home", target: one(m, "#yours-chip-forays"), preventDefault() { prevented++; } });
  assert.strictEqual(prevented, 4, "every handled key is kept from scrolling the page");
  assert.strictEqual(m.doc.activeElement.getAttribute("data-yours-chip"), "forays", "focus follows the chosen chip");
});

/* ==================================================================== */
/* 2. THE READOUT                                                        */
/* ==================================================================== */

test("the readout: '5 queued · 4 hr 55 min' to the word, '0 queued' with no tail, and it follows the queue", async () => {
  /* MUTATION 1: print the tail at 0 (drop the `d.queued ? ... : ""` guard) -
     "0 queued · " fails.
     MUTATION 2: stop repainting the readout in paintYoursChrome - the
     follows-the-queue half fails. */
  const m = await mountBooted();
  const ro = (d) => m.ctx.yoursReadoutText("upnext", d);
  assert.strictEqual(ro({ queued: 5, minutes: 295 }), "5 queued · 4 hr 55 min");
  assert.strictEqual(ro({ queued: 0, minutes: 0 }), "0 queued");
  assert.strictEqual(ro({ queued: 1, minutes: 60 }), "1 queued · 1 hr");
  assert.strictEqual(m.ctx.yoursReadoutText("forays", { forays: null }), "Forays", "an unknown Foray count says no number");
  assert.strictEqual(m.ctx.yoursReadoutText("forays", { forays: 1 }), "1 foray");
  assert.strictEqual(m.ctx.yoursReadoutText("history", { history: 3 }), "3 episodes played");
  const items = queue(m, 3);
  m.ctx.renderLibrary();
  const minutes = items.reduce((s, it) => s + m.ctx.episodeMinutes(it), 0);
  assert.strictEqual(textOf(one(m, "#yours-readout")), `3 queued · ${m.ctx.fmtDur(minutes)}`);
  m.ctx.removeFromQueue(items[1].id);
  assert.match(textOf(one(m, "#yours-readout")), /^2 queued · /, "a write ticks the readout down");
  assert.strictEqual(one(m, ".chip__count").textContent, "2", "and the badge with it");
  m.ctx.addToQueue(items[1].id);
  assert.match(textOf(one(m, "#yours-readout")), /^3 queued · /, "and back up");
});

/* ==================================================================== */
/* 3. THE ROW                                                            */
/* ==================================================================== */

test("a queue row: position, artwork, a two-line title, show and remaining time, and the bare ⋯ at the end", async () => {
  /* MUTATION 1: give the ⋯ a keycap class (`iconbtn` -> `keycap keycap--sm`) -
     the no-face assertion fails.
     MUTATION 2: drop the show name from a plain row's meta - the show
     assertion fails.
     MUTATION 3: number from 0 (`idx + 1` -> `idx`) - the position assertion
     fails. */
  const m = await mountBooted();
  const items = queue(m, 3);
  withPlayer(m, null);
  m.ctx.renderLibrary();
  const rows = q(m, ".yours-qwrap");
  assert.strictEqual(rows.length, 3);
  rows.forEach((li, i) => {
    assert.strictEqual(li.dataset.queueId, items[i].id);
    const row = li.querySelector(".row-queue");
    assert.ok(row, "each li holds a .row-queue");
    assert.strictEqual(textOf(row.querySelector(".row-queue__position")), String(i + 1), "the position is the 1-based place");
    assert.ok(row.querySelector(".row-queue__position").classList.contains("readout"), "in the mono readout");
    assert.ok(row.querySelector(".find-art--queue"), "artwork 48");
    assert.ok(row.querySelector(".row__title"), "a title");
    const meta = row.querySelector(".row__meta");
    assert.ok(meta.querySelector(".row__show"), "a plain row's meta names the show");
    assert.ok(meta.querySelector(".readout"), "and the length");
    const more = row.querySelectorAll("button").find((b) => (b.getAttribute("data-action") || "").startsWith("more:"));
    assert.ok(more, "a trailing ⋯");
    assert.ok(more.classList.contains("iconbtn"), "it is the icon button");
    assert.ok(!more.classList.contains("keycap"), "no face and no lip: keycaps are for playback and collection actions");
    assert.strictEqual(more.getAttribute("aria-expanded"), "false");
    assert.match(more.getAttribute("aria-label"), /^More for /);
    assert.strictEqual(row.querySelectorAll(".keycap").length, 0, "no keycap anywhere in a closed row");
  });
});

test("the playing row: the soft fill, the needle for its number, a Playing tag, '· N min left', no show name", async () => {
  /* MUTATION 1: draw the number on the playing row (`cur ? needle : idx + 1` ->
     `idx + 1`) - the needle assertion fails.
     MUTATION 2: keep the show name on the playing row's meta - the
     no-show-name assertion fails.
     MUTATION 3: drop aria-current from the playing article - the AT assertion
     fails. */
  const m = await mountBooted();
  const items = queue(m, 3);
  withPlayer(m, items[0].id);
  m.ctx.renderLibrary();
  const rows = q(m, ".row-queue");
  const cur = rows[0];
  assert.ok(cur.classList.contains("is-current"), "the playing row is .is-current (the --persimmon-soft fill)");
  assert.strictEqual(cur.getAttribute("aria-current"), "true");
  const pos = cur.querySelector(".row-queue__position");
  assert.ok(pos.querySelector("svg"), "the needle replaces the number");
  assert.strictEqual(textOf(pos), "", "and no digit is drawn: the cell holds an icon and no text");
  assert.strictEqual(pos.querySelector("use").getAttribute("href"), "#needle", "it is the needle icon");
  const tag = cur.querySelector(".tag--playing");
  assert.ok(tag, "a Playing tag");
  assert.strictEqual(textOf(tag.querySelector("span")), "Playing");
  assert.match(textOf(cur.querySelector(".row__meta")), /· 42 min left/, "the remaining time, from the player's own progress label");
  assert.ok(!cur.querySelector(".row__show"), "the playing row names no show");
  assert.ok(!rows.slice(1).some((r) => r.classList.contains("is-current")), "only one row is current");
  assert.strictEqual(textOf(rows[1].querySelector(".row-queue__position")), "2");
});

test("a row presses to play (through the Up Next context) or pause, and only a playable row is a button", async () => {
  /* MUTATION 1: start without UP_NEXT_CTX (pass `ctx: null`) - the context
     assertion fails, and with it the played-row-jumps-to-the-top rule.
     MUTATION 2: skip the isCurrent branch - the toggle assertion fails. */
  const m = await mountBooted();
  const items = queue(m, 3);
  withPlayer(m, items[0].id);
  const calls = [];
  m.ctx.startEpisodePlay = async (id, item, opts) => { calls.push({ id, ctx: opts.ctx }); };
  m.ctx.renderLibrary();
  press(m, `play:${items[2].id}`);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls, [{ id: items[2].id, ctx: "upnext" }], "a play from this list carries the Up Next context");
  press(m, `play:${items[0].id}`);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(m.toggled, ["toggle"], "the playing row pauses or resumes instead of restarting");
  assert.strictEqual(calls.length, 1, "and starts nothing");
  m.store.set("cp_queue", JSON.stringify([...queueIds(m), "gone-episode-id"]));
  m.ctx.renderLibrary();
  const gone = q(m, ".yours-qwrap").find((li) => li.dataset.queueId === "gone-episode-id");
  assert.ok(gone, "an episode 4a no longer has still has its row (a count that disagrees with its rows is #276)");
  assert.ok(!gone.querySelector("button.row-queue__main"), "but it is not a play button");
  assert.match(textOf(gone), /Episode no longer available/);
});

/* ==================================================================== */
/* 4 & 5. THE ACTION ROW, REORDER, REMOVE                                */
/* ==================================================================== */

test("⋯ opens a row of Move up, Move down and Remove as buttons with their words; the playing row offers only Remove", async () => {
  /* MUTATION 1: drop the visible words from Move up (`text: "Move up"`) - the
     words-on-the-keys assertion fails.
     MUTATION 2: drop the playing-row guard in yoursActionsHtml (`cur ? "" :`) -
     Move up appears on the playing row.
     MUTATION 3: let Move up stay enabled under the playing row - the disabled
     assertion fails. */
  const m = await mountBooted();
  const items = queue(m, 4);
  withPlayer(m, items[0].id);
  m.ctx.renderLibrary();
  assert.strictEqual(q(m, ".yours-qtools").length, 0, "closed by default");
  press(m, `more:${items[2].id}`);
  const tools = q(m, ".yours-qtools");
  assert.strictEqual(tools.length, 1, "one action row open");
  const buttons = tools[0].querySelectorAll("button");
  assert.deepStrictEqual(buttons.map((b) => textOf(b.querySelector(".keycap__label"))), ["Move up", "Move down", "Remove"], "the words are on the keys");
  assert.ok(buttons.every((b) => b.tagName === "BUTTON" && b.classList.contains("keycap--sm") && b.classList.contains("keycap--paper")), "real buttons, paper keycaps sm");
  assert.ok(buttons.every((b) => /^(Move up|Move down|Remove from Up Next): /.test(b.getAttribute("aria-label"))), "named for the episode, beginning with the visible words");
  assert.ok(buttons.every((b) => !b.disabled), "a middle row can move either way");
  assert.strictEqual(one(m, `[data-action="more:${items[2].id}"]`).getAttribute("aria-expanded"), "true");
  assert.strictEqual(tools[0].getAttribute("role"), "group");
  press(m, `more:${items[1].id}`);
  assert.strictEqual(q(m, ".yours-qtools").length, 1, "opening another closes the first");
  const second = q(m, ".yours-qwrap")[1].querySelectorAll(".yours-qtools button");
  assert.ok(second[0].disabled, "Move up is off on the row under the playing one (it would pass the episode that is playing)");
  assert.ok(!second[1].disabled);
  press(m, `more:${items[1].id}`);
  assert.strictEqual(q(m, ".yours-qtools").length, 0, "pressing ⋯ again closes it");
  press(m, `more:${items[0].id}`);
  const playing = q(m, ".yours-qwrap")[0].querySelectorAll(".yours-qtools button");
  assert.deepStrictEqual(playing.map((b) => textOf(b.querySelector(".keycap__label"))), ["Remove"], "the playing row offers only Remove");
  press(m, `more:${items[3].id}`);
  const last = q(m, ".yours-qwrap")[3].querySelectorAll(".yours-qtools button");
  assert.ok(last[1].disabled, "Move down is off on the last row");
});

test("Move up and Move down write the queue through the one writer and the page repaints; focus stays on the key", async () => {
  /* MUTATION 1: flip the sign (`yoursMove(id, -1)` -> `+1` in the dispatcher) -
     the order assertion fails.
     MUTATION 2: skip the focus restore (drop yoursFocusAfter in
     repaintYoursQueue) - the focus assertion fails.
     MUTATION 3: leave the repaint out of repaintQueuePage's #/library branch -
     the page-still-shows-the-old-order assertion fails. */
  const m = await mountBooted();
  const items = queue(m, 4);
  withPlayer(m, null);
  m.ctx.renderLibrary();
  press(m, `more:${items[2].id}`);
  press(m, `up:${items[2].id}`);
  assert.deepStrictEqual(queueIds(m), [items[0].id, items[2].id, items[1].id, items[3].id], "up swaps with the row above");
  assert.deepStrictEqual(q(m, ".yours-qwrap").map((li) => li.dataset.queueId), queueIds(m), "the page shows the new order without a navigation");
  assert.strictEqual(textOf(q(m, ".row-queue__position")[1]), "2");
  assert.strictEqual(m.doc.activeElement.getAttribute("data-action"), `up:${items[2].id}`, "the finger's key is under the finger again");
  assert.ok(q(m, ".yours-qtools").length === 1, "and the row's action row stayed open");
  press(m, `up:${items[2].id}`);
  assert.deepStrictEqual(queueIds(m).slice(0, 2), [items[2].id, items[0].id]);
  assert.strictEqual(m.doc.activeElement.getAttribute("data-action"), `down:${items[2].id}`, "at the top its Move up is disabled, so focus goes to its other arrow");
  press(m, `down:${items[2].id}`);
  assert.deepStrictEqual(queueIds(m).slice(0, 2), [items[0].id, items[2].id]);
});

test("Remove writes the queue, ticks the badge and readout down, focuses the row that took its place, and says so", async () => {
  /* MUTATION 1: remove the wrong id (use the NEXT row's) - the order assertion
     fails.
     MUTATION 2: skip announce() - the announcement assertion fails.
     MUTATION 3: focus the heading instead of a ⋯ (drop the `more:` branch in
     yoursFocusAfter) - the focus assertion fails. */
  const m = await mountBooted();
  const items = queue(m, 4);
  withPlayer(m, null);
  m.ctx.renderLibrary();
  const said = [];
  m.ctx.announce = (t) => said.push(t);
  press(m, `more:${items[1].id}`);
  press(m, `rm:${items[1].id}`);
  assert.deepStrictEqual(queueIds(m), [items[0].id, items[2].id, items[3].id]);
  assert.strictEqual(q(m, ".yours-qwrap").length, 3, "the row is gone");
  assert.match(textOf(one(m, "#yours-readout")), /^3 queued/);
  assert.strictEqual(one(m, ".chip__count").textContent, "3");
  assert.strictEqual(m.doc.activeElement.getAttribute("data-action"), `more:${items[2].id}`, "focus lands on the ⋯ of the row that took its place");
  assert.ok(said.some((t) => /^Removed from Up Next\./.test(t)), `announced: ${said.join(" | ")}`);
});

/* ==================================================================== */
/* 6. THE UNDO TOAST                                                     */
/* ==================================================================== */

test("Remove shows 'Removed from Up Next' with Undo for four seconds; Undo restores the row where it was", async () => {
  /* MUTATION 1: change YOURS_UNDO_MS to 5000 - the delay assertion fails.
     MUTATION 2: restore at the end (`ids.splice(Math.min(entry.index, ids.length), 0, ...)`
     -> `ids.push(entry.id)`) - the original-place assertion fails.
     MUTATION 3: never call tactileSetToast(..., true) - the visible assertion
     fails.
     MUTATION 4: drop hideYoursUndo from the timer - the timed-out assertion
     fails. */
  const m = await mountBooted();
  const items = queue(m, 4);
  withPlayer(m, null);
  m.ctx.renderLibrary();
  const before = queueIds(m);
  press(m, `more:${items[1].id}`);
  press(m, `rm:${items[1].id}`);
  const host = one(m, "#yours-toast") || m.body.querySelector("#yours-toast");
  assert.ok(host, "a toast host");
  const toast = host.querySelector(".toast");
  assert.strictEqual(toast.getAttribute("role"), "status");
  assert.ok(toast.classList.contains("is-visible"), "visible");
  assert.ok(!("inert" in toast.attrs), "and reachable: not inert while it is up");
  assert.strictEqual(textOf(toast.querySelector("span")), "Removed from Up Next");
  const undo = toast.querySelector(".textbtn");
  assert.strictEqual(textOf(undo), "Undo");
  const armed = m.timers.filter((t) => t.ms === 4000);
  assert.strictEqual(armed.length, 1, `the clock is armed for 4000 ms (armed: ${m.timers.map((t) => t.ms).join(", ")})`);
  undo._on.get("click")[0]();
  assert.deepStrictEqual(queueIds(m), before, "Undo puts the episode back at its original place");
  assert.strictEqual(q(m, ".yours-qwrap").length, 4, "and the row is back");
  assert.match(textOf(one(m, "#yours-readout")), /^4 queued/, "the readout ticks back up");
  assert.ok(!toast.classList.contains("is-visible"), "the toast goes");
  assert.ok("inert" in toast.attrs, "and is unreachable again");
  /* A removal nobody undoes is final once the clock runs out. */
  press(m, `more:${items[2].id}`);
  press(m, `rm:${items[2].id}`);
  assert.ok(toast.classList.contains("is-visible"));
  const run = m.timers.filter((t) => t.ms === 4000).pop();
  run.fn();
  assert.ok(!toast.classList.contains("is-visible"), "after four seconds the toast hides");
  assert.ok(!queueIds(m).includes(items[2].id), "and the removal stands");
});

test("the toast's clock stops while it is touched and runs again, with what was left, on release", async () => {
  /* MUTATION 1: drop the pointerdown listener - the cancelled-clock assertion
     fails.
     MUTATION 2: re-arm the full YOURS_UNDO_MS on release instead of what was
     left - the remaining-time assertion fails (fake time says 3 s were spent). */
  const m = await mountBooted();
  const items = queue(m, 3);
  withPlayer(m, null);
  m.ctx.renderLibrary();
  press(m, `more:${items[1].id}`);
  let now = 1_000_000;
  m.ctx.Date = class extends Date { static now() { return now; } };
  press(m, `rm:${items[1].id}`);
  const toast = m.body.querySelector("#yours-toast .toast");
  const first = m.timers.filter((t) => t.ms === 4000).pop();
  now += 3000;
  toast._on.get("pointerdown")[0]();
  assert.ok(m.cleared.includes(first.id), "a press cancels the running clock");
  now += 60_000;
  toast._on.get("pointerup")[0]();
  const resumed = m.timers[m.timers.length - 1];
  assert.ok(resumed.id > first.id, "release arms a new clock");
  assert.ok(resumed.ms <= 1000 && resumed.ms > 0, `with the second that was left, not another four (got ${resumed.ms} ms)`);
});

/* ==================================================================== */
/* 7. CLEAR                                                              */
/* ==================================================================== */

test("Clear is a paper keycap that asks first: the sheet takes focus, Keep and Escape leave the list alone, Clear keeps what is playing", async () => {
  /* MUTATION 1: clear without the sheet (call clearQueue() in the click
     handler) - the nothing-removed-yet assertion fails.
     MUTATION 2: let the secondary button also clear - the Keep assertion
     fails.
     MUTATION 3: do not hand the sheet to openSheet - the focus-in and
     stack-depth assertions fail.
     MUTATION 4: clear the playing row too (drop the playing id from
     clearOrder's call) - the keeps-what-is-playing assertion fails. */
  const m = await mountBooted();
  const items = queue(m, 4);
  withPlayer(m, items[0].id);
  m.ctx.window.forayQueueOrder = { clearOrder: (ids, playing) => ids.filter((x) => x === playing), playNextOrder: (ids) => ids };
  m.ctx.renderLibrary();
  const clear = q(m, "[data-action]").find((b) => b.getAttribute("data-action") === "clear");
  assert.ok(clear, "a Clear key");
  assert.ok(clear.classList.contains("keycap--sm") && clear.classList.contains("keycap--paper"), "paper keycap sm");
  assert.strictEqual(textOf(clear.querySelector(".keycap__label")), "Clear");
  assert.match(clear.getAttribute("aria-label"), /^Clear/);
  m.doc.activeElement = clear;
  press(m, "clear");
  assert.strictEqual(queueIds(m).length, 4, "nothing is removed by the press itself");
  const sheet = m.body.querySelector("#yours-clear-sheet");
  assert.ok(sheet, "a confirm sheet");
  assert.strictEqual(sheet.getAttribute("role"), "dialog");
  assert.strictEqual(sheet.getAttribute("aria-modal"), "true");
  assert.ok(!sheet.hidden, "open");
  assert.strictEqual(m.ctx.openSheetCount(), 1, "on the app's sheet stack, which traps Tab and closes on Escape");
  assert.strictEqual(m.doc.activeElement, sheet, "focus moved in");
  assert.match(textOf(sheet.querySelector("p")), /^This removes 3 episodes from Up Next\. What is playing stays\.$/);
  /* Keep leaves everything alone and gives focus back. */
  const keep = sheet.querySelector(".sheet__actions .textbtn");
  assert.strictEqual(textOf(keep), "Keep");
  keep._on.get("click")[0]();
  assert.strictEqual(queueIds(m).length, 4);
  assert.strictEqual(m.ctx.openSheetCount(), 0, "closed");
  assert.ok(!m.body.querySelector("#yours-clear-sheet"), "and removed from the document");
  assert.strictEqual(m.doc.activeElement, clear, "focus is back on the key that opened it");
  /* Escape is the stack's own request-close. */
  press(m, "clear");
  m.ctx.closeAllSheets();
  assert.strictEqual(queueIds(m).length, 4, "Escape (the stack's close) removes nothing");
  assert.strictEqual(m.ctx.openSheetCount(), 0);
  /* Clear goes through. */
  press(m, "clear");
  const primary = m.body.querySelector("#yours-clear-sheet .keycap");
  assert.strictEqual(textOf(primary.querySelector(".keycap__label")), "Clear");
  primary._on.get("click")[0]();
  assert.deepStrictEqual(queueIds(m), [items[0].id], "the playing row stays, the rest go");
  assert.ok(!q(m, "[data-action]").some((b) => b.getAttribute("data-action") === "clear"), "with nothing left to clear the key is gone");
  assert.strictEqual(m.ctx.openSheetCount(), 0);
});

/* ==================================================================== */
/* 8. ESCAPING                                                           */
/* ==================================================================== */

test("a title and an id with markup in them reach the page inert", async () => {
  /* MUTATION 1: interpolate the title without esc() in yoursQueueRowHtml - the
     raw-<b> assertion fails.
     MUTATION 2: interpolate the id without esc() in yoursActionKey's callers
     (data-action) - the quote-break assertion fails. */
  const m = await mountBooted();
  m.ctx.fullPool();
  const id = 'evil"><i id="pwn';
  const item = { id, title: "<b>x</b> & <img src=x onerror=alert(1)>", show: "<script>s</script> Show", audio_url: "https://example.test/a.mp3", duration_min: 30, show_id: "s" };
  m.state.itemIndex[id] = item;
  m.state.poolIds.add(id);
  m.store.set("cp_queue", JSON.stringify([id]));
  m.state.yoursOpenRow = id;
  withPlayer(m, null);
  m.ctx.renderLibrary();
  const html = m.html();
  assert.ok(!/<b>x<\/b>|<img src=x|<script>s/.test(html), "no markup from a title or a show name survives");
  assert.ok(html.includes(m.ctx.esc(item.title)), "the title is there, as text");
  assert.ok(!/id="pwn"|<i id=/.test(html), "an id cannot close the attribute it sits in");
  assert.strictEqual(q(m, "#pwn").length, 0);
  const keys = q(m, "[data-action]").map((b) => b.getAttribute("data-action"));
  assert.ok(keys.includes(`more:${id}`) || keys.some((k) => k.startsWith("more:")), "the control is still addressable");
});

/* ==================================================================== */
/* 9. THE SHEET'S OWN RULES                                              */
/* ==================================================================== */

const RULES = parseRules(CSS);
function decl(selector, prop) {
  let out;
  for (const r of RULES) {
    if (r.atRules.length || !r.selectors.includes(selector)) continue;
    for (const d of r.decls) if (d.prop === prop) out = d.value;
  }
  return out;
}
const TOKENS = { "--s-1": 4, "--s-2": 8, "--s-3": 12, "--s-4": 16, "--s-5": 20, "--s-6": 24, "--s-8": 32, "--tap": 44, "--row-queue": 64, "--art-queue": 48, "--lip": 3, "--gutter": 16 };
function px(v) {
  if (v == null) return null;
  const m = /^var\((--[\w-]+)\)$/.exec(v.trim());
  if (m) return TOKENS[m[1]] ?? null;
  const n = /^(-?[\d.]+)px$/.exec(v.trim());
  return n ? Number(n[1]) : null;
}

test("the strip is 36px chips 8px apart under a 16px gutter; the row is 64 with a 20px position and 48px art; the queue rows are 12 apart", () => {
  /* MUTATION 1: `.yours-chips { gap: var(--s-3) }` - the 8px assertion fails.
     MUTATION 2: `.yours-queue .row-queue__position { width: var(--s-4) }` - the
     20px assertion fails.
     MUTATION 3: `.yours-queue { gap: var(--s-2) }` - the pitch assertion fails
     (and with it the 8-10 rows at 852). */
  assert.strictEqual(px(decl(".yours-chips", "gap")), 8);
  assert.match(decl(".yours-chips", "padding"), /var\(--gutter\)/);
  assert.match(decl(".yours-chips", "overflow-x"), /auto/, "horizontal scroll");
  assert.match(decl(".chip", "height"), /var\(--s-8\) \+ var\(--s-1\)/, "32 + 4");
  assert.strictEqual(px(decl(".yours-queue .row-queue__position", "width")), 20);
  assert.strictEqual(px(decl(".yours-queue .row-queue", "min-height")), 64);
  assert.strictEqual(px(decl(".yours-queue .find-art--queue", "width")), 48);
  assert.strictEqual(px(decl(".yours-queue", "gap")), 12);
  /* 8-10 rows visible at 852: once the head has scrolled away, the list area is
     the screen less the deck (64), its 12px float and the home-indicator-free
     bottom; each row takes its 64 plus the 12px gap. */
  const area = 852 - (64 + 12 + 12);
  const rows = Math.floor(area / (64 + px(decl(".yours-queue", "gap"))));
  assert.ok(rows >= 8 && rows <= 10, `${rows} rows fit above the deck at 852`);
});

test("the Yours readouts close the mono space: '47 min' is one readout, not '47  min'", () => {
  /* MUTATION: delete `.page--yours .readout { word-spacing: -0.2em }` - the
     rule is gone and the assertion fails (a mono space is 0.6em wide, so the
     row's "47 min" renders with a hole in it). */
  assert.match(decl(".page--yours .readout", "word-spacing") || "", /^-0\.2em$/);
});

test("fitYoursChip: the chosen chip lands inside the gutter and a half-cut chip on the left is stepped past", async () => {
  /* The strip is a fake with real geometry: six chips of the app's widths, 8
     apart, in a 393px strip, chosen = the fifth ("Up Next"). A fake that answered with the
     scroll it was asked for would pass anything, so scrollLeft is plain data and
     getBoundingClientRect subtracts it, like a real scroller.
     MUTATION 1: delete the `for (let i = 0; i < chips.length; i++)` loop
     step-past - the left chip stays cut (box.left < 16) and the last assertion fails.
     MUTATION 2: delete `strip.scrollLeft = 0` - a strip already scrolled keeps
     its old offset and the first assertion fails. */
  const m = await mountBooted();
  const W = 393, GAP = 8, PAD = 16;
  const WIDTHS = [75, 70, 68, 92, 131, 81];   // Forays, Shows, Saved, Playlists, Up Next, History
  const mk = (selectedIdx, start) => {
    /* scrollLeft clamps to the content's end, as a browser's does */
    const max = PAD * 2 + WIDTHS.reduce((a, b) => a + b, 0) + GAP * (WIDTHS.length - 1) - W;
    let at = Math.min(start, max);
    const strip = { clientWidth: W };
    Object.defineProperty(strip, "scrollLeft", { get: () => at, set: (v) => { at = Math.min(Math.max(0, v), max); } });
    strip.getBoundingClientRect = () => ({ left: 0, right: W });
    const chips = WIDTHS.map((w, i) => {
      const x = PAD + WIDTHS.slice(0, i).reduce((a, b) => a + b + GAP, 0);
      return { getBoundingClientRect: () => ({ left: x - strip.scrollLeft, right: x + w - strip.scrollLeft }) };
    });
    strip.querySelector = () => chips[selectedIdx];
    strip.querySelectorAll = () => chips;
    return { strip, chips };
  };
  const { strip, chips } = mk(4, 170);
  m.ctx.fitYoursChip(strip);
  const sel = chips[4].getBoundingClientRect();
  assert.ok(sel.right <= W - PAD + 0.5 && sel.left >= PAD - 1, "the chosen chip is whole, inside both gutters");
  for (const c of chips) {
    const b = c.getBoundingClientRect();
    assert.ok(!(b.left < PAD - 1 && b.right > PAD), "no chip is cut by the left edge past the fade (at most the gap shows, inside the 16px mask)");
  }
  /* the strip is snapped, not parked at its end: Saved (the first chip left) sits
     at the gutter, and History runs into the right fade (the old fit parked
     flush at the end, History whole inside the gutter and a "…aved" stub on the left) */
  assert.strictEqual(Math.round(chips[2].getBoundingClientRect().left), PAD, "the first chip in view starts at the gutter");
  assert.ok(chips[5].getBoundingClientRect().right > W - PAD, "the last chip reaches the right fade: the strip goes on");
});

test("the three actions share one 48px line: no indent, compact keys, and the row is the keys' 44 plus 4", () => {
  /* MUTATION: put `padding-left: calc(var(--s-5) + var(--s-2) + var(--s-1))`
     back on .yours-qtools (the prototype's indent) - the no-indent assertion
     fails; at 393 the third key would wrap and the row would be 96 tall. */
  const padding = decl(".yours-qtools", "padding");
  assert.strictEqual(padding.trim(), "0 0 var(--s-1)", "no indent: 0 on the left, 4 below the 44px keys = 48");
  assert.strictEqual(px(decl(".yours-qtools .keycap .i", "width")), 20);
  /* The widest the three can be: the labels measured in a browser at 15/700 in
     the shipped text face (62, 85 and 59px) plus a 20px icon, a 4px gap and 8px
     sides on each key and 6px between keys, against the narrowest phone this app
     supports (375: 343px between the gutters). */
  assert.strictEqual(px(decl(".yours-qtools .keycap", "padding")?.split(" ")[1]), 8);
  assert.strictEqual(px(decl(".yours-qtools .keycap", "gap")), 4);
  assert.match(decl(".yours-qtools", "gap"), /var\(--s-1\) \+ var\(--s-1\) \/ 2/, "6px between keys");
  const labels = [62, 85, 59];
  const key = (w) => 8 + 20 + 4 + w + 8;
  const total = labels.map(key).reduce((a, b) => a + b, 0) + 2 * 6;
  assert.ok(total <= 375 - 32, `${total}px of keys fit the ${375 - 32}px between the gutters at 375`);
});

test("rows move by transform only: no height or max-height transition or animation anywhere in the Yours rules", () => {
  /* MUTATION: add `transition: height var(--d-settle)` to `.yours-qwrap` - the
     assertion fails. BUILD-PLAN 2.16: "Removal moves the following rows by
     translateY, never by animating height". */
  const start = CSS.indexOf("YOURS (TACTILE): the chip strip and the Up Next list");
  const end = CSS.indexOf("REDUCE MOTION: ONE BLOCK");
  assert.ok(start > 0 && end > start, "the Yours block is where this test looks");
  const yours = CSS.slice(start, end);
  const motion = [...yours.matchAll(/(?:transition|animation)[\w-]*\s*:[^;]+;/g)].map((m) => m[0]);
  assert.ok(motion.length >= 2, "fixture assumption: the block does animate (the rows' slide and the action row's rise)");
  for (const m of motion) assert.ok(!/\b(height|max-height|min-height|top|left|margin|padding)\b/.test(m), `non-transform motion: ${m}`);
  assert.match(yours, /\.yours-qwrap\.is-flipping \{ transition: transform var\(--d-settle\) var\(--spring-settle\); \}/, "rows slide on --spring-settle");
  assert.match(yours, /@keyframes yours-open \{ from \{ opacity: 0; transform: translateY\(/, "the action row rises on transform and opacity");
});

test("the rows' slide and the action row's rise are named in the ONE reduced-motion block", () => {
  /* MUTATION: take `.yours-qwrap` out of the block's transition list - the
     first assertion fails; take `.yours-qtools` out of the animation list - the
     second fails. */
  const at = CSS.indexOf("REDUCE MOTION: ONE BLOCK");
  assert.strictEqual(CSS.indexOf("@media (prefers-reduced-motion: reduce)", CSS.indexOf("@media (prefers-reduced-motion: reduce)") + 1) > at, false, "fixture assumption: the block after the banner is the only one");
  const block = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)", at));
  assert.match(block, /\.yours-qwrap\.is-flipping,[\s\S]*?\{ transition: none; \}/, "the slide is stilled");
  assert.match(block, /\.yours-qtools \{ animation: none; \}/, "the rise is stilled");
  assert.strictEqual((CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length, 1, "one block in the whole sheet");
});

/* ==================================================================== */
/* 10. FLIP, ON THE REAL FUNCTION                                        */
/* ==================================================================== */

test("yoursFlip puts a moved row back with translateY and releases it; an unmoved row is left alone", async () => {
  /* MUTATION 1: write `top` instead of `transform` - the translateY assertion
     fails.
     MUTATION 2: skip the release (drop the requestAnimationFrame callback) -
     the released assertion fails: the rows would stay where the old layout
     was. */
  const m = await mountBooted();
  const mk = (id, top) => ({
    dataset: { queueId: id }, style: { transform: "" }, classList: new Set(),
    getBoundingClientRect: () => ({ top }), addEventListener() {},
  });
  const a = mk("a", 200); const b = mk("b", 100); const c = mk("c", 300);
  for (const e of [a, b, c]) { const s = new Set(); e.classList = { add: (x) => s.add(x), remove: (x) => s.delete(x), contains: (x) => s.has(x), set: s }; }
  const panel = { querySelectorAll: () => [a, b, c] };
  const from = new Map([["a", 100], ["b", 200], ["c", 300]]);
  const seen = [];
  m.ctx.requestAnimationFrame = (fn) => { seen.push({ a: a.style.transform, b: b.style.transform, c: c.style.transform }); fn(); return 1; };
  m.ctx.yoursFlip(panel, from);
  assert.deepStrictEqual(seen, [{ a: "translateY(-100px)", b: "translateY(100px)", c: "" }], "before the release a moved row sits where it WAS, by transform; c did not move");
  assert.deepStrictEqual([a.style.transform, b.style.transform, c.style.transform], ["", "", ""], "released to its new place");
  assert.ok(a.classList.contains("is-flipping") && b.classList.contains("is-flipping") && !c.classList.contains("is-flipping"), "the transition class goes on the movers only");
});

/* ==================================================================== */
/* 11. THE KNOB, THE ROUTE, THE LEGACY PAGE                              */
/* ==================================================================== */

test("the knob is a 44px paper keycap that opens the drawer and says it controls it", async () => {
  /* MUTATION 1: bind nothing - the click assertion fails.
     MUTATION 2: label it "Menu" - the name assertion fails (the prototype's is
     "Settings and dials").
     MUTATION 3: drop aria-level="1" from the title - the level assertion fails
     (axe's page-has-heading-one: the hidden topbar was the page's only h1). */
  const m = await mountBooted();
  m.ctx.renderLibrary();
  const knob = one(m, "#yours-knob");
  assert.ok(knob.classList.contains("keycap--sm") && knob.classList.contains("keycap--paper"));
  assert.strictEqual(knob.getAttribute("aria-label"), "Settings and dials");
  assert.strictEqual(knob.getAttribute("aria-controls"), "drawer");
  const calls = [];
  m.ctx.openDrawer = (open) => calls.push(open);
  knob._on.get("click")[0]();
  assert.deepStrictEqual(calls, [true]);
  assert.strictEqual(knob.querySelector("use").getAttribute("href"), "#knob");
  assert.strictEqual(one(m, "h2").textContent, "Yours");
  assert.strictEqual(one(m, "h2").className, "display-xl", "display-xl on one line");
  assert.strictEqual(one(m, "h2").getAttribute("aria-level"), "1", "the page's level-one heading: the topbar's h1 is hidden here, and pageHeading() still finds an h2");
});

test("the page marks itself view-yours, repaints through repaintQueuePage on #/library, and leaves #/queue's own page alone", async () => {
  /* MUTATION 1: drop `document.body.classList.add("view-yours")` - the class
     assertion fails (and with it every rule in the Yours block).
     MUTATION 2: remove the #/library branch from repaintQueuePage - the
     live-repaint assertion fails.
     MUTATION 3: make the #/library branch return before it checks the hash
     (repaint on every page) - the other-page assertion fails. */
  const m = await mountBooted();
  const items = queue(m, 3);
  withPlayer(m, null);
  m.ctx.renderLibrary();
  assert.ok(m.body.classList.contains("view-yours"));
  m.ctx.removeFromQueue(items[0].id);
  assert.strictEqual(q(m, ".yours-qwrap").length, 2, "a write while Yours is on screen repaints its list");
  m.ctx.location.hash = "#/";
  let repainted = 0;
  m.ctx.repaintYoursQueue = () => { repainted++; };
  m.ctx.removeFromQueue(items[1].id);
  assert.strictEqual(repainted, 0, "a write on another page repaints nothing here");
  m.ctx.location.hash = "#/queue";
  let queuePage = 0;
  m.ctx.renderQueue = () => { queuePage++; };
  m.ctx.addToQueue(items[1].id);
  assert.strictEqual(queuePage, 1, "#/queue still repaints its own page");
  assert.strictEqual(repainted, 0);
});

test("Playing, the Up Next list and the toast keep the listener copy rules", async () => {
  /* The corpus-wide scanners (test/listener-copy.test.js) read the source; this
     reads what the page SAYS for the strings built at run time. MUTATION: add
     "deep dive" to the confirm sheet's copy - the banned-word assertion fails. */
  const m = await mountBooted();
  const items = queue(m, 3);
  withPlayer(m, items[0].id);
  m.ctx.renderLibrary();
  press(m, `more:${items[1].id}`);
  press(m, "clear");
  const sheet = m.body.querySelector("#yours-clear-sheet");
  m.ctx.closeAllSheets();
  const said = [textOf(m.view), sheet ? textOf(sheet) : ""].join(" ");
  for (const banned of [/\bfascinating\b/i, /\bdeep dive\b/i, /\bdelves?\b/i, /\bexplores\b/i, /\bwe\b/i, /\bour\b/i, /\btopics?\b/i, /\bsegments?\b/i, /\brunning order\b/i]) {
    assert.ok(!banned.test(said), `listener copy uses ${banned}`);
  }
  assert.ok(sheet && /Clear Up Next[?]/.test(textOf(sheet)), "fixture assumption: the sheet was read");
  assert.match(m.html(), /Plays in this order/);
});
