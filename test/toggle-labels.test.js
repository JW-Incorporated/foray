/* A control's words and its name move together (audit 2026-09-22,
 * docs/audit/qa-synthesis.md theme D, "two names for one truth").
 *
 * WHY THIS EXISTS. `aria-label` REPLACES a button's text for a screen reader.
 * Seven controls set it once at build time and then changed the text underneath:
 *
 *   - the show star read "★ Starred" and announced "Star show" (inverted after
 *     one tap), and the episode star announced "Save" in both states;
 *   - every play button showed ❚❚ and announced "Play <title>";
 *   - the Foray's main button read "Loading…" / "▶ Resume" and announced "Play";
 *   - the mini bar's title button was named "Open player", which hid WHAT was
 *     playing, and still said "Open" while it closed the sheet;
 *   - the down-vote reason chips showed selection by tint alone;
 *   - the running order's playing / played state was a CSS glyph in an
 *     aria-hidden span, so twelve rows all announced "Play …".
 *
 * THE STANDING RULE, pinned at the bottom of this file: in app.js and
 * player/client.js a control's text changes only through `setControlLabel` /
 * `setToggleLabel` (app.js) or `paintControl` (client.js), which write the name
 * in the same call. Any other `.textContent =` must be on an element this file
 * lists as not-a-control, so a new toggler that bypasses the helper fails here
 * by name rather than in a screen reader.
 *
 * Harness: app.js in a node:vm context (as test/library-screen.test.js does),
 * with elements that keep real attributes; client.js functions are lifted out of
 * the module source by name and run against the same fake elements, because the
 * module itself cannot evaluate outside a browser.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const APP_SRC = read("app.js");
const CLIENT_SRC = read("player/client.js");
const SEARCH_SRC = read("search-engine.js");

process.on("unhandledRejection", () => {});

/* An element with real attributes, text, classes and dataset — the minimum a
   label assertion needs to be about the element and not about a fake. */
function makeEl(tag = "button", attrs = {}) {
  const a = new Map(Object.entries(attrs));
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(), textContent: "", hidden: false, disabled: false, dataset: {}, style: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : on; if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => a.set(k, String(v)),
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    removeAttribute: (k) => a.delete(k),
    hasAttribute: (k) => a.has(k),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    append() {}, appendChild(k) { return k; }, closest: () => null, focus() {},
  };
  return el;
}

function mountApp({ seed = {}, buttons = [] } = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const view = makeEl("main");
  view.innerHTML = "";
  const body = makeEl("body");
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
      querySelector: (sel) => (sel === "#view" ? view : null),
      querySelectorAll: (sel) => buttons.filter((b) => b.matches(sel)),
    },
    navigator: { userAgent: "node" },
    addEventListener() {}, removeEventListener() {},
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
  vm.runInContext(SEARCH_SRC, ctx, { filename: "search-engine.js" });
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  const state = vm.runInContext("state", ctx);
  state.catalog = { shows: [{ show_id: "s-1", title: "Show One" }] };
  state.discover = { items: [] };
  state.taxonomy = { nodes: [] };
  state.session = { session_id: "s-1", builder: "test", episodes: {}, cards: [] };
  return { ctx, state };
}

/* Parse the one attribute a label test cares about out of built markup. */
const attrOf = (html, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};
const textOf = (html) => (/>([^<]*)<\/button>/.exec(html) || [])[1];

/* A fake button that answers the selector its toggler queries with. */
function selectable(attr, value) {
  const b = makeEl("button");
  b.matches = (sel) => sel === `[${attr}="${value}"]`;
  return b;
}

/* ------------------------------------------------------------------ */
/* The helper                                                          */
/* ------------------------------------------------------------------ */

/* MUTATION: drop the `removeAttribute` branch — a plain-text control keeps a
   stale name. MUTATION 2: always set the label — a text button gets a name
   identical to its text, which is redundant but harmless, so the first
   assertion is the one that guards the stale-name case. */
test("setControlLabel writes the text and the name together, and drops a name equal to the text", () => {
  const { ctx } = mountApp();
  const b = makeEl();
  b.setAttribute("aria-label", "Stale");
  ctx.setControlLabel(b, "Show more", null);
  assert.strictEqual(b.textContent, "Show more");
  assert.strictEqual(b.getAttribute("aria-label"), null, "a text-only control speaks its own text");
  ctx.setControlLabel(b, "▶", "Play Odd Lots");
  assert.strictEqual(b.textContent, "▶");
  assert.strictEqual(b.getAttribute("aria-label"), "Play Odd Lots");
  ctx.setControlLabel(b, null, "Now playing: X");
  assert.strictEqual(b.textContent, "▶", "a null text leaves the text alone");
  assert.strictEqual(b.getAttribute("aria-label"), "Now playing: X");
});

/* ------------------------------------------------------------------ */
/* Stars: Save (episode), Follow (show)                                */
/* ------------------------------------------------------------------ */

/* MUTATION: restore `aria-label="Save"` in starBtn, or drop the
   setToggleLabel call in toggleStar. The on-state name fails. */
test("the episode star is named by its state, at build time and after a tap", () => {
  const item = { id: "e-1", title: "T", show: "S", audio_url: "https://a.test/1.mp3", topics: [] };
  const btn = selectable("data-star", "e-1");
  const m = mountApp({ buttons: [btn] });
  m.state.itemIndex["e-1"] = item;

  const off = m.ctx.starBtn("e-1");
  assert.strictEqual(attrOf(off, "aria-label"), "Save episode");
  assert.strictEqual(textOf(off), "☆");

  btn.textContent = "☆";
  btn.setAttribute("aria-label", "Save episode");
  m.ctx.toggleStar("e-1");
  assert.strictEqual(btn.textContent, "★");
  assert.strictEqual(btn.getAttribute("aria-label"), "Saved", "the repaint must rename it, not only re-glyph it");
  assert.strictEqual(attrOf(m.ctx.starBtn("e-1"), "aria-label"), "Saved", "and a fresh build agrees with the repaint");

  m.ctx.toggleStar("e-1");
  assert.strictEqual(btn.getAttribute("aria-label"), "Save episode");
});

/* The inverted case: "★ Starred" on screen, "Star show" to a screen reader.
   MUTATION: restore toggleShowStar's bare `b.textContent = …` write. */
test("the show's Follow button never announces the opposite of what it shows", () => {
  const btn = selectable("data-show-star", "s-1");
  const m = mountApp({ buttons: [btn] });
  const off = m.ctx.showStarBtn("s-1");
  assert.strictEqual(textOf(off), "+ Follow");
  assert.strictEqual(attrOf(off, "aria-label"), "Follow show");

  m.ctx.toggleShowStar("s-1");
  assert.strictEqual(btn.textContent, "✓ Followed");
  assert.strictEqual(btn.getAttribute("aria-label"), "Followed");
  assert.strictEqual(attrOf(m.ctx.showStarBtn("s-1"), "aria-label"), "Followed");
});

/* ------------------------------------------------------------------ */
/* Play buttons — app.js builds them, client.js repaints them          */
/* ------------------------------------------------------------------ */

/* Lift named functions out of the client module's source. */
function clientFn(name) {
  const start = CLIENT_SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `player/client.js has no function ${name}`);
  let depth = 0;
  for (let i = CLIENT_SRC.indexOf("{", start); i < CLIENT_SRC.length; i++) {
    if (CLIENT_SRC[i] === "{") depth++;
    else if (CLIENT_SRC[i] === "}" && --depth === 0) return CLIENT_SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function clientCtx(extra) {
  const ctx = { ...extra };
  vm.createContext(ctx);
  vm.runInContext(clientFn("paintControl"), ctx);
  return ctx;
}

/* MUTATION: restore `b.textContent = on ? "❚❚" : "▶";` in syncCardButtons.
   The playing card keeps "Play <title>". */
test("a playing card's button is renamed 'Pause <its title>', and back to 'Play' when it stops", () => {
  const { ctx: app } = mountApp();
  const html = app.playBtn({ id: "e-1", title: "Odd Lots: The Fed", audio_url: "https://a.test/1.mp3" });
  assert.strictEqual(attrOf(html, "aria-label"), "Play Odd Lots: The Fed");
  assert.strictEqual(attrOf(html, "data-title"), "Odd Lots: The Fed", "the repaint needs the row's own title");

  const card = makeEl();
  card.dataset = { play: "e-1", title: "Odd Lots: The Fed" };
  const other = makeEl();
  other.dataset = { play: "e-2", title: "Another" };
  let playing = true;
  const ctx = clientCtx({
    current: { id: "e-1" },
    isPlaying: () => playing,
    document: { querySelectorAll: () => [card, other] },
  });
  vm.runInContext(clientFn("syncCardButtons"), ctx);
  ctx.syncCardButtons();
  assert.strictEqual(card.textContent, "❚❚");
  assert.strictEqual(card.getAttribute("aria-label"), "Pause Odd Lots: The Fed");
  assert.strictEqual(other.getAttribute("aria-label"), "Play Another", "every other row keeps its own title");
  playing = false;
  ctx.syncCardButtons();
  assert.strictEqual(card.getAttribute("aria-label"), "Play Odd Lots: The Fed");
});

/* MUTATION: put back `info.setAttribute("aria-label", "Open player")` and drop
   paintInfoLabel — the name loses the title. MUTATION 2: drop the aria-expanded
   write — the open-sheet assertion fails. */
test("the mini bar's title button is named by what is playing and says whether the sheet is open", () => {
  const info = makeEl();
  const sheet = makeEl("div");
  sheet.hidden = true;
  const ui = { info, sheet, title: { textContent: "Dennis Whyte: Nuclear Fusion" }, show: { textContent: "Lex Fridman Podcast" } };
  const ctx = clientCtx({ ui });
  vm.runInContext(clientFn("paintInfoLabel"), ctx);
  ctx.paintInfoLabel();
  assert.strictEqual(info.getAttribute("aria-label"), "Now playing: Dennis Whyte: Nuclear Fusion, Lex Fridman Podcast");
  assert.strictEqual(info.getAttribute("aria-expanded"), "false");
  sheet.hidden = false;
  ctx.paintInfoLabel();
  assert.strictEqual(info.getAttribute("aria-expanded"), "true");
  assert.ok(!/info\.setAttribute\("aria-label", "Open player"\)/.test(CLIENT_SRC), "the static name must not come back");
  assert.match(clientFn("setNowPlaying"), /paintInfoLabel\(\)/, "a new episode must rename the bar");
});

/* MUTATION: remove the aria-valuetext write in render(). */
test("the scrub slider announces a time, not a 0-1000 fraction", () => {
  assert.match(clientFn("render"), /ui\.scrub\.setAttribute\("aria-valuetext"/);
});

/* ------------------------------------------------------------------ */
/* The Foray page                                                      */
/* ------------------------------------------------------------------ */

/* The four states of the main button, read straight out of paintForay's
   decision so a fifth cannot be added with a two-state name.
   MUTATION: restore `playBtn.setAttribute("aria-label", running ? "Pause" : "Play")`. */
test("the Foray main button's name has all four states its text has", () => {
  const body = APP_SRC.slice(APP_SRC.indexOf("const playBtn = $(\"#fy-play\");"), APP_SRC.indexOf("setControlLabel(playBtn, text, name);") + 40);
  const pairs = [...body.matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(pairs, [
    ["❚❚ Pause", "Pause"],
    ["Loading…", "Loading, please wait"],
    ["▶ Resume", "Resume"],
    ["▶ Play", "Play"],
  ]);
  for (const [text, name] of pairs) {
    assert.ok(text.includes(name.split(",")[0]), `the name "${name}" must contain the visible word of "${text}" (WCAG 2.5.3)`);
  }
});

/* MUTATION: drop the aria-current / label writes in paintForay's row loop. */
test("a running-order row says which clip is playing and which are played", () => {
  const { ctx } = mountApp();
  assert.strictEqual(ctx.forayJumpLabel("Odd Lots, the Fed", ""), "Play Odd Lots, the Fed");
  assert.strictEqual(ctx.forayJumpLabel("Odd Lots, the Fed", "playing"), "Now playing: Odd Lots, the Fed");
  assert.match(ctx.forayJumpLabel("Odd Lots, the Fed", "played"), /^Played\./);
  const loop = APP_SRC.slice(APP_SRC.indexOf('querySelectorAll("[data-fy]").forEach(row => {'));
  const head = loop.slice(0, 700);
  assert.match(head, /aria-current/, "the playing row must carry aria-current");
  assert.match(head, /forayJumpLabel\(row\.dataset\.fyName/, "and be renamed from the same comparison as its class");
});

/* MUTATION: revert the chip handler to `chip.classList.toggle("on")`. */
test("a down-vote reason chip carries aria-pressed, and a reopened sheet resets it", () => {
  const { ctx } = mountApp();
  const html = ctx.feedbackSheetHtml();
  const chips = html.match(/<button type="button" class="fy-chip"[^>]*>/g) || [];
  assert.ok(chips.length >= 2);
  for (const c of chips) assert.match(c, /aria-pressed="false"/);
  const chip = makeEl();
  ctx.setChipPressed(chip, true);
  assert.strictEqual(chip.getAttribute("aria-pressed"), "true");
  assert.ok(chip.classList.contains("on"));
  ctx.setChipPressed(chip, false);
  assert.strictEqual(chip.getAttribute("aria-pressed"), "false");
  assert.ok(/setChipPressed\(chip, chip\.getAttribute\("aria-pressed"\) !== "true"\)/.test(APP_SRC), "the click handler must go through setChipPressed");
});

/* qa row 66: the fallback hint was written into an aria-live region four times
   a second. MUTATION: make setStatusText write unconditionally; or restore the
   old clear-then-rewrite pair in paintForay. */
test("the Foray notice line is written once per change, not once per tick", () => {
  const line = makeEl("p");
  let writes = 0;
  let text = "";
  Object.defineProperty(line, "textContent", { get: () => text, set: (v) => { writes++; text = v; } });
  const m = mountApp();
  m.ctx.document.querySelector = (sel) => (sel === "#fy-error" ? line : null);
  for (let i = 0; i < 8; i++) m.ctx.paintForayNotice(m.ctx.FY_VOICE_FALLBACK || "Your chosen voice isn't installed; using the best available.", true);
  assert.strictEqual(writes, 1, "eight ticks of the same notice must be one write");
  const block = APP_SRC.slice(APP_SRC.indexOf("if (s.error) paintForayFailure(s.error);"), APP_SRC.indexOf("if (s.error) paintForayFailure(s.error);") + 200);
  assert.match(block, /else if \(s\.voiceFallback\) paintForayNotice\(FY_VOICE_FALLBACK, true\);\s*else paintForayFailure\(null\);/,
    "a tick decides the line's ONE message before writing it");
});

/* ------------------------------------------------------------------ */
/* THE STANDING RULE                                                   */
/* ------------------------------------------------------------------ */

/* Elements whose text may be written directly because they are NOT controls:
   status lines, clocks, titles. Adding a name here is a claim that the element
   is not a button — make it deliberately.  */
const NOT_CONTROLS = {
  "app.js": new Set([
    "pct", "el", "note", "$(\"#fy-total\")", "$(\"#fy-sheet-sub\")", "now", "ui.status", "ui.notice", "ddUi.status", "n",
    "link", // a drawer <a> with fixed text, written once
  ]),
  "player/client.js": new Set([
    "n", "ui.tNow", "ui.tLeft", "ui.title", "ui.show", "ui.sTitle", "ui.sShow", "ui.sWhy", "ui.sDesc", "ui.note",
  ]),
};
const HELPERS = { "app.js": ["setControlLabel", "setStatusText"], "player/client.js": ["paintControl"] };

function stripFns(src, names) {
  let out = src;
  for (const name of names) {
    const start = out.indexOf(`function ${name}(`);
    if (start < 0) continue;
    let depth = 0;
    for (let i = out.indexOf("{", start); i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}" && --depth === 0) { out = out.slice(0, start) + out.slice(i + 1); break; }
    }
  }
  return out;
}

/* MUTATION: write `b.textContent = "✓ Up Next";` back into bindUpNext (or any
   button's text by hand). This fails and names the receiver and the line. */
test("in app.js and player/client.js a control's text changes only through the label helpers", () => {
  for (const [file, src] of [["app.js", APP_SRC], ["player/client.js", CLIENT_SRC]]) {
    const body = stripFns(src, HELPERS[file]);
    const offenders = [];
    for (const m of body.matchAll(/([\w$.]+(?:\("[^"]*"\))?)\.textContent\s*=(?!=)/g)) {
      if (!NOT_CONTROLS[file].has(m[1])) {
        const line = body.slice(0, m.index).split("\n").length;
        offenders.push(`${m[1]} (≈line ${line})`);
      }
    }
    assert.deepStrictEqual(offenders, [], `${file}: a control's text written by hand, bypassing its accessible name: ${offenders.join(", ")}`);
  }
});

/* The other half of the rule: no hand-written static aria-label beside a
   state-dependent glyph in the builders this file covers. MUTATION: restore
   `aria-label="Save"` in starBtn. */
test("no builder pairs a ternary text with a hand-written aria-label", () => {
  for (const name of ["starBtn", "showStarBtn", "upNextBtn", "playBtn"]) {
    const start = APP_SRC.indexOf(`function ${name}(`);
    const body = APP_SRC.slice(start, APP_SRC.indexOf("\n}\n", start));
    assert.ok(!/aria-label="[^"$]*"/.test(body), `${name} writes a literal aria-label`);
  }
});
