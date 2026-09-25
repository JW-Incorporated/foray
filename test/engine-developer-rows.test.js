/* The engine's four Developer rows (card NE-22d; docs/native-engine-plan.md
 * NE-16, NE-17, NE-24, NE-25c): the drawer half.
 *
 * docs/native-engine-m1-car-test.md drives four engine commands from the
 * page's Developer group: "Playback engine: Automatic / Native / Web (applies
 * after restart)" (setModeOverride), "Pause hold: forever / none"
 * (setHoldPolicy), "Simulate system termination" (simulateTermination) and the
 * session probe (probeSession). app.js draws them; player/client.js decides
 * which exist (`ForayPlayer.engineDeveloperStatus`) and is their only sender
 * (`ForayPlayer.engineDeveloperSend`, over the NE-21 engine client).
 * player/native-mode.test.js pins that half against the reference engine;
 * this suite pins the drawer against a recording ForayPlayer.
 *
 * THE PROPERTIES. No rows and no send where there is no engine (the web,
 * Android, an older player module). Where there is one, the rows sit in the
 * Developer group above "Playback diagnostics", follow the drawer's control
 * conventions, and paint what the ENGINE answered, not what was tapped.
 *
 * Every test names the mutation that turns it red.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

/* ---------- the smallest DOM that boots app.js (voice-probe-switch's) ---------- */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parent = null; this.id = null; this.className = "";
    this.textContent = ""; this._html = ""; this.value = ""; this.type = "";
    this.disabled = false; this.hidden = false; this.attributes = {};
    this.style = {}; this.dataset = {}; this._on = new Map(); this._c = new Set();
    this.classList = {
      add: (c) => this._c.add(c), remove: (c) => this._c.delete(c),
      contains: (c) => this._c.has(c),
      toggle: (c, on) => { const w = on ?? !this._c.has(c); if (w) this._c.add(c); else this._c.delete(c); return w; },
    };
  }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    const re = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\sid="([^"]+)"/g;
    let m;
    while ((m = re.exec(this._html))) { const k = new El(m[1]); k.id = m[2]; this.appendChild(k); }
  }
  append(...kids) { for (const k of kids) this.appendChild(k); }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  insertBefore(k, ref) {
    k.parent = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(k); else this.children.splice(i, 0, k);
    return k;
  }
  removeChild(k) { this.children = this.children.filter((c) => c !== k); k.parent = null; return k; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  get parentNode() { return this.parent; }
  get nextSibling() {
    if (!this.parent) return null;
    const i = this.parent.children.indexOf(this);
    return this.parent.children[i + 1] ?? null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn) { if (!this._on.has(t)) this._on.set(t, new Set()); this._on.get(t).add(fn); }
  removeEventListener(t, fn) { this._on.get(t)?.delete(fn); }
  click() {
    const out = [];
    for (const fn of [...(this._on.get("click") ?? [])]) out.push(fn({ target: this, stopPropagation() {}, preventDefault() {} }));
    return Promise.all(out);
  }
  focus() {} select() {} closest() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  querySelector(sel) { return findIn(this, sel); }
  querySelectorAll(sel) { return findAllIn(this, sel); }
  tree() { return [this, ...this.children.flatMap((c) => c.tree())]; }
}
function matches(el, sel) {
  const s = String(sel).trim();
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return String(el.className).split(/\s+/).includes(s.slice(1));
  if (s.startsWith("[")) return false;
  return el.tagName === s.toUpperCase();
}
function findIn(root, sel) { return root.tree().find((e) => e !== root && matches(e, sel)) ?? null; }
function findAllIn(root, sel) { return root.tree().filter((e) => e !== root && matches(e, sel)); }

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** A value from the vm realm, as plain data (deepStrictEqual compares prototypes). */
const plain = (x) => JSON.parse(JSON.stringify(x));
process.on("unhandledRejection", () => {});

const ROW_IDS = ["engine-mode-override", "engine-hold-policy", "engine-simulate-termination", "engine-session-probe"];
const ALL = ["setModeOverride", "setHoldPolicy", "simulateTermination", "probeSession"];

/**
 * A ForayPlayer whose engine half records every send and answers like the
 * engine: `status` is what `engineDeveloperStatus` returns (null = no
 * engine), and `answer(cmd, args)` is the reply, applied to `status` when ok
 * (the engine confirmed it), exactly as client.js reads back.
 */
function fakeEngine({ status = null, answer = () => ({ ok: true }), hold = false } = {}) {
  const sends = [];
  const eng = { status, sends, release: null };
  eng.player = {
    engineDeveloperStatus: () => eng.status,
    async engineDeveloperSend(cmd, args) {
      sends.push({ cmd, args });
      if (hold) await new Promise((r) => { eng.release = r; });
      const reply = answer(cmd, args);
      if (reply && reply.ok && eng.status) {
        if (cmd === "setHoldPolicy") eng.status = { ...eng.status, holdPolicy: args.policy };
        if (cmd === "setModeOverride") eng.status = { ...eng.status, override: args.mode };
      }
      return reply;
    },
    whenEngineReady: async () => (eng.status && eng.status.lane) || "js",
  };
  return eng;
}

const nativeStatus = (over = {}) => ({ lane: "native", override: "auto", holdPolicy: "forever", commands: [...ALL], ...over });

/**
 * @param {object} [opts]
 * @param {object|null} [opts.engine]  fakeEngine(); null boots the older ForayPlayer with no engine half
 */
async function mount({ engine = null } = {}) {
  const body = new El("body");
  for (const id of ["view", "drawer", "drawer-overlay", "drawer-playlists",
    "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
    "banner-slot", "pl-form", "pl-input", "pl-note", "tab-topics", "tab-shows",
    "sh-form", "sh-input", "sh-note", "sh-results", "browse-all-link", "pl-remove", "banner-done"]) {
    const el = new El("div"); el.id = id; body.append(el);
  }
  const fetchFn = async (url) => {
    const u = String(url).split("?")[0];
    if (/^https?:/.test(u)) throw new TypeError("network down");
    const file = path.join(ROOT, u);
    if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
  };
  const docListeners = new Map();
  const document = {
    body, documentElement: body, readyState: "complete", hidden: false,
    addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(fn); },
    removeEventListener(t, fn) { docListeners.get(t)?.delete(fn); },
    createElement: (t) => new El(t),
    querySelector: (s) => findIn(body, s),
    querySelectorAll: (s) => findAllIn(body, s),
  };
  const events = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchFn,
    localStorage: new FakeStorage(),
    forayEventLog: { rows: events, append(row) { events.push(row); }, async unsynced() { return events; }, async markSynced() {}, async pruneToRetention() {}, health() { return { ok: true }; } },
    document,
    location: { hash: "#/", search: "", pathname: "/", href: "https://x.test/", protocol: "https:", reload() {} },
    navigator: { userAgent: "node" },
    history: { replaceState() {}, pushState() {}, back() {} },
    addEventListener() {}, removeEventListener() {},
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Date, JSON, Promise, clearTimeout, queueMicrotask,
    Math, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  ctx.window.ForayPlayer = {
    resolve: () => null, listForays: () => [], foraysUsingShow: () => [],
    fmtClock: () => "0:00", fmtSpan: () => "0:00", itemLen: () => 1,
    forayResume: () => null, forayDriftIsClean: () => true, forayResumeList: () => [],
    clearForayResume() {}, async playForay() { return { queued: 0, skipped: [] }; },
    watchForay: () => null, forayToggle() {}, forayNext() {}, forayPrevious() {},
    forayJump() {}, foraySeek() {}, onEpisodeEnded() {}, stopForDataDeletion() {},
    listVoices: () => [], canPlay: () => false, segmentAt: () => null,
    ...(engine ? engine.player : {}),
  };
  for (let i = 0; i < 200 && !vm.runInContext("state.ready", ctx); i++) await tick();
  assert.ok(vm.runInContext("state.ready", ctx), "the page never booted");

  const h = { ctx, body };
  h.fn = (name) => vm.runInContext(name, ctx);
  h.openDrawer = () => h.fn("openDrawer")(true);
  h.drawer = () => findIn(body, "#drawer");
  h.row = (id) => findIn(body, "#" + id);
  h.devIds = () => (findIn(body, "#drawer-dev")?.children ?? []).map((c) => c.id).filter(Boolean);
  h.engineIds = () => h.drawer().tree().map((e) => e.id).filter((id) => ROW_IDS.includes(id));
  h.settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };
  return h;
}

/* ==================================================================== */
/* no engine: no rows, nothing sent                                     */
/* ==================================================================== */

test("web/Android (status null): no engine row exists and nothing is sent", async () => {
  /* KILLING MUTATION: build the rows unconditionally in syncEngineDevRows
     (drop the `cmds.includes(row.cmd)` gate) — four rows appear on the web. */
  const eng = fakeEngine({ status: null });
  const h = await mount({ engine: eng });
  h.openDrawer();
  await h.settle();
  assert.deepStrictEqual(h.engineIds(), []);
  /* Even a direct call of the tap handler sends nothing without an engine. */
  for (const row of h.fn("ENGINE_DEV_ROWS")) await h.fn("tapEngineDevRow")(row);
  assert.deepStrictEqual(eng.sends, [], "the bridge-facing sender was never called");
});

test("an older player module with no engine half: no rows, no throw", async () => {
  /* KILLING MUTATION: drop the `typeof ... === "function"` checks in
     engineDevStatus — renderDrawer throws and the whole drawer goes blank. */
  const h = await mount({ engine: null });
  h.openDrawer();
  assert.deepStrictEqual(h.engineIds(), []);
  assert.ok(h.devIds().includes("diag-open"), "the rest of the Developer group is intact");
});

test("no engine is byte-identical to an app without the rows", async () => {
  /* KILLING MUTATION: create a placeholder row that is merely `hidden` when
     there is no engine — the drawer's id list diverges. */
  const paint = async (engine) => {
    const h = await mount({ engine });
    h.openDrawer();
    return h.drawer().tree().map((e) => e.id).filter(Boolean);
  };
  const a = await paint(fakeEngine({ status: null }));
  const b = await paint(null);
  assert.ok(a.includes("diag-open") && a.includes("delete-data"), "the drawer is not empty");
  assert.deepStrictEqual(a, b, "an engine that is absent = a player with no engine half");
});

/* ==================================================================== */
/* the native lane                                                      */
/* ==================================================================== */

test("native lane: four rows, in the Developer group, above Playback diagnostics, in the car-test order", async () => {
  /* KILLING MUTATION: `group.appendChild(btn)` always — the rows land below
     "Playback diagnostics", and the script's "Developer -> Pause hold" is
     hunted for under the Copy button. */
  const h = await mount({ engine: fakeEngine({ status: nativeStatus() }) });
  h.openDrawer();
  const dev = h.devIds();
  const at = (id) => dev.indexOf(id);
  assert.deepStrictEqual(ROW_IDS.map(at).every((i) => i >= 0), true, `all four are in the group: ${dev.join(",")}`);
  assert.deepStrictEqual([...ROW_IDS].sort((x, y) => at(x) - at(y)), ROW_IDS, "in order");
  assert.ok(at("engine-session-probe") < at("diag-open"), "above Playback diagnostics");
  const ids = h.drawer().children.map((c) => c.id).filter(Boolean);
  assert.strictEqual(ids[ids.length - 1], "delete-data", "Delete my data stays last");
});

test("the rows follow the drawer's control conventions: 44px buttons that keep the drawer open", async () => {
  /* KILLING MUTATION: build the rows with a bare class — no `.drawer-item`
     min-height, so each is a ~20px target. Or drop `drawerStay` — a tap
     closes the drawer before the answer is painted. */
  const h = await mount({ engine: fakeEngine({ status: nativeStatus() }) });
  h.openDrawer();
  for (const id of ROW_IDS) {
    const b = h.row(id);
    assert.strictEqual(b.tagName, "BUTTON");
    assert.strictEqual(b.type, "button");
    const cls = String(b.className).split(/\s+/);
    assert.ok(cls.includes("drawer-item") && cls.includes("as-btn") && cls.includes("drawer-wrap"), `${id}: ${b.className}`);
    assert.strictEqual(b.dataset.drawerStay, "1");
  }
  assert.match(CSS, /\.drawer-item \{[^}]*min-height: 44px;/, ".drawer-item is the 44px target");
  assert.match(CSS, /\.drawer-item\.drawer-wrap \{[^}]*white-space: normal;/, "the engine's answer wraps, never an ellipsis");
  const hold = h.row("engine-hold-policy");
  assert.strictEqual(hold.getAttribute("role"), "switch");
});

test("each row paints what the engine says", async () => {
  /* KILLING MUTATION: paint the hold from a page-side variable set on tap
     rather than the status — the refusal test below goes red; here, drop
     `holdPolicyWord` and "until:60" paints raw. */
  const eng = fakeEngine({ status: nativeStatus() });
  const h = await mount({ engine: eng });
  h.openDrawer();
  assert.strictEqual(h.row("engine-mode-override").textContent, "Playback engine: Automatic (applies after restart) · now Native");
  assert.strictEqual(h.row("engine-hold-policy").textContent, "Pause hold: forever");
  assert.strictEqual(h.row("engine-hold-policy").getAttribute("aria-checked"), "true");
  assert.strictEqual(h.row("engine-hold-policy").getAttribute("aria-label"), "Pause hold forever");
  assert.strictEqual(h.row("engine-simulate-termination").textContent, "Simulate system termination");
  assert.strictEqual(h.row("engine-session-probe").textContent, "Session probe");

  eng.status = nativeStatus({ holdPolicy: "until:60", override: null });
  h.openDrawer();
  assert.strictEqual(h.row("engine-hold-policy").textContent, "Pause hold: 60 min");
  assert.strictEqual(h.row("engine-hold-policy").getAttribute("aria-checked"), "false");
  assert.strictEqual(h.row("engine-mode-override").textContent, "Playback engine: not known (applies after restart) · now Native");
});

test("Pause hold: a tap sends setHoldPolicy through the player and paints the engine's new value", async () => {
  /* KILLING MUTATION: send `{ policy: "forever" }` regardless — the car
     test's H-1b block ("Pause hold: none") is unreachable. */
  const eng = fakeEngine({ status: nativeStatus() });
  const h = await mount({ engine: eng });
  h.openDrawer();
  await h.row("engine-hold-policy").click();
  assert.deepStrictEqual(plain(eng.sends), [{ cmd: "setHoldPolicy", args: { policy: "none" } }]);
  assert.strictEqual(h.row("engine-hold-policy").textContent, "Pause hold: none");
  assert.strictEqual(h.row("engine-hold-policy").getAttribute("aria-checked"), "false");
  await h.row("engine-hold-policy").click();
  assert.deepStrictEqual(plain(eng.sends[1]), { cmd: "setHoldPolicy", args: { policy: "forever" } }, "and back");
  assert.strictEqual(h.row("engine-hold-policy").textContent, "Pause hold: forever");
});

test("Playback engine: a tap steps Automatic -> Native -> Web -> Automatic through setModeOverride", async () => {
  /* KILLING MUTATION: index the next mode off the tapped count instead of the
     engine's value — after a refusal the row and the engine disagree. */
  const eng = fakeEngine({ status: nativeStatus() });
  const h = await mount({ engine: eng });
  h.openDrawer();
  const row = () => h.row("engine-mode-override");
  await row().click();
  assert.strictEqual(row().textContent, "Playback engine: Native (applies after restart) · now Native");
  await row().click();
  assert.strictEqual(row().textContent, "Playback engine: Web (applies after restart) · now Native");
  await row().click();
  assert.strictEqual(row().textContent, "Playback engine: Automatic (applies after restart) · now Native");
  assert.deepStrictEqual(eng.sends.map((s) => s.args.mode), ["native", "web", "auto"]);
  assert.ok(eng.sends.every((s) => s.cmd === "setModeOverride"));
});

test("a refusal leaves the engine's value on the row, not the tapped one", async () => {
  /* KILLING MUTATION: paint the requested value optimistically on tap. */
  const eng = fakeEngine({ status: nativeStatus(), answer: () => ({ ok: false, reason: "bridge-error" }) });
  const h = await mount({ engine: eng });
  h.openDrawer();
  await h.row("engine-hold-policy").click();
  assert.strictEqual(eng.sends.length, 1);
  assert.strictEqual(h.row("engine-hold-policy").textContent, "Pause hold: forever");
});

test("the one-shot rows say what the engine replied: armed, or why it refused", async () => {
  /* KILLING MUTATION: paint "armed" whenever the send resolves — a refused
     probe reads as armed and the founder locks the phone for nothing. */
  const eng = fakeEngine({
    status: nativeStatus(),
    answer: (cmd) => (cmd === "probeSession" ? { ok: true } : { ok: false, reason: "not-loaded" }),
  });
  const h = await mount({ engine: eng });
  h.openDrawer();
  await h.row("engine-session-probe").click();
  await h.row("engine-simulate-termination").click();
  assert.deepStrictEqual(eng.sends.map((s) => s.cmd), ["probeSession", "simulateTermination"]);
  assert.deepStrictEqual(eng.sends.map((s) => s.args), [undefined, undefined], "neither takes args");
  assert.strictEqual(h.row("engine-session-probe").textContent, "Session probe: armed. Lock the phone now; it speaks in 10 seconds");
  assert.strictEqual(h.row("engine-simulate-termination").textContent,
    "Simulate system termination: refused, play and pause an episode first");
  assert.strictEqual(findIn(h.body, "#a11y-status")?.textContent,
    "Simulate system termination: refused, play and pause an episode first", "and it is said");
});

test("a second tap while the first is in flight sends nothing", async () => {
  /* KILLING MUTATION: drop the `engineDevInFlight` guard — a double tap arms
     the probe twice (the second refused engine-busy and painted over the
     first's "armed"). */
  const eng = fakeEngine({ status: nativeStatus(), hold: true });
  const h = await mount({ engine: eng });
  h.openDrawer();
  const first = h.row("engine-session-probe").click();
  await h.settle(2);
  assert.strictEqual(h.row("engine-session-probe").disabled, true, "disabled while in flight");
  await h.row("engine-session-probe").click();
  assert.strictEqual(eng.sends.length, 1);
  eng.release();
  await first;
  assert.strictEqual(h.row("engine-session-probe").disabled, false);
});

/* ==================================================================== */
/* the JS lane, and a lane change                                       */
/* ==================================================================== */

test("JS lane over an engine that answered: only the engine setting, which is how Native is asked for", async () => {
  /* KILLING MUTATION: hide every row unless lane === "native" — a phone on
     the web player could never ask for the native engine. */
  const eng = fakeEngine({ status: { lane: "js", override: "auto", holdPolicy: null, commands: ["setModeOverride"] } });
  const h = await mount({ engine: eng });
  h.openDrawer();
  assert.deepStrictEqual(h.engineIds(), ["engine-mode-override"]);
  assert.strictEqual(h.row("engine-mode-override").textContent, "Playback engine: Automatic (applies after restart) · now Web");
  await h.row("engine-mode-override").click();
  assert.deepStrictEqual(plain(eng.sends), [{ cmd: "setModeOverride", args: { mode: "native" } }]);
  assert.strictEqual(h.row("engine-mode-override").textContent, "Playback engine: Native (applies after restart) · now Web");
});

test("a relinquish (native -> JS) removes the three native-only rows at the next paint", async () => {
  /* KILLING MUTATION: never remove a built row — after a Foray tap hands
     playback to the web player, "Session probe" stays and sends into a
     relinquished engine. */
  const eng = fakeEngine({ status: nativeStatus() });
  const h = await mount({ engine: eng });
  h.openDrawer();
  assert.strictEqual(h.engineIds().length, 4);
  eng.status = { lane: "js", override: "auto", holdPolicy: null, commands: ["setModeOverride"] };
  h.openDrawer();
  assert.deepStrictEqual(h.engineIds(), ["engine-mode-override"]);
  /* and a stale handler cannot send what the lane no longer takes */
  const probe = h.fn("ENGINE_DEV_ROWS").find((r) => r.cmd === "probeSession");
  await h.fn("tapEngineDevRow")(probe);
  assert.deepStrictEqual(eng.sends, []);
});

test("reopening the drawer never stacks a second row or a second listener", async () => {
  /* KILLING MUTATION: drop the `if (!btn)` guard — three opens, three rows,
     and one tap sends three commands. */
  const eng = fakeEngine({ status: nativeStatus() });
  const h = await mount({ engine: eng });
  h.openDrawer(); h.openDrawer(); h.openDrawer();
  for (const id of ROW_IDS) assert.strictEqual(findAllIn(h.drawer(), "#" + id).length, 1, id);
  await h.row("engine-session-probe").click();
  assert.strictEqual(eng.sends.length, 1);
});
