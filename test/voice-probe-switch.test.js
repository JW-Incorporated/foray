/* K-01's founder switch: the drawer half of the bundled-voice measurement.
 *
 * `docs/bundled-voice-plan.md` K-01 asks for the probe to reach a phone
 * "behind the same `withDiagnosticUnlock` discipline #29 used" — a hidden
 * affordance, not a product feature. `app.js` § voiceProbeOn follows the shape
 * `showDraftsOn` established, so this suite follows
 * `test/draft-forays-switch.test.js`'s: prove the OFF state is indistinguishable
 * from an app with no switch at all, prove the ON state does exactly one thing,
 * and prove the durable key is documented.
 *
 * THE PROPERTY THIS SUITE PROTECTS. A probe control that appeared in a
 * listener's drawer, or one that could be tapped by accident, would be a
 * 90-second CPU burn on somebody's commute. Off by default, not rendered at all
 * while off, and two deliberate taps to run.
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
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, "player/client.js"), "utf8");
const POLICY = fs.readFileSync(path.join(ROOT, "docs/legal/privacy-policy.md"), "utf8");

/* ---------- the smallest DOM that boots app.js ---------- */

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
  constructor(seed = {}) { this.map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)])); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
process.on("unhandledRejection", () => {});

/**
 * @param {object} [opts]
 * @param {object} [opts.seed]     `cp_` keys to pre-store
 * @param {string} [opts.appSrc]   a mutated app.js, for the byte-identical pin
 * @param {object} [opts.probe]    what `ForayPlayer.runVoiceProbe` resolves
 * @param {boolean} [opts.noPlayer] boot with no `window.ForayPlayer` at all
 */
async function mount({ seed = {}, appSrc = APP_SRC, probe = null, noPlayer = false } = {}) {
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
  const probeCalls = [];
  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchFn,
    localStorage: new FakeStorage(seed),
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
  vm.runInContext(appSrc, ctx, { filename: "app.js" });
  if (!noPlayer) {
    ctx.window.ForayPlayer = {
      resolve: () => null, listForays: () => [], foraysUsingShow: () => [],
      fmtClock: () => "0:00", fmtSpan: () => "0:00", itemLen: () => 1,
      forayResume: () => null, forayDriftIsClean: () => true, forayResumeList: () => [],
      clearForayResume() {}, async playForay() { return { queued: 0, skipped: [] }; },
      watchForay: () => null, forayToggle() {}, forayNext() {}, forayPrevious() {},
      forayJump() {}, foraySeek() {}, onEpisodeEnded() {}, stopForDataDeletion() {},
      listVoices: () => [], canPlay: () => false, segmentAt: () => null,
      async runVoiceProbe() {
        probeCalls.push(Date.now());
        return probe ?? { engine: "kokoro-probe", ok: false, reason: "model-absent" };
      },
      formatVoiceProbe(record) {
        return record && record.ok
          ? { text: "voice probe: kokoro-probe", verdict: { go: true, failures: [] } }
          : { text: "voice probe: could not measure", verdict: { go: false, failures: ["rtf-not-measured"] } };
      },
    };
  }
  for (let i = 0; i < 200 && !vm.runInContext("state.ready", ctx); i++) await tick();
  assert.ok(vm.runInContext("state.ready", ctx), "the page never booted");

  const h = { ctx, body, store: ctx.localStorage, probeCalls };
  h.fn = (name) => vm.runInContext(name, ctx);
  h.openDrawer = () => h.fn("openDrawer")(true);
  h.drawer = () => findIn(body, "#drawer");
  h.toggle = () => findIn(body, "#voice-probe-toggle");
  h.run = () => findIn(body, "#voice-probe-run");
  h.status = () => findIn(body, "#diag-status");
  h.sheet = () => findIn(body, "#diag-sheet");
  /** The drawer's controls in order, which is what "the probe never lands
      below Delete my data" is asserted against. */
  h.drawerIds = () => h.drawer().children.map((c) => c.id).filter(Boolean);
  h.settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick(); };
  return h;
}

/* ==================================================================== */
/* OFF — the default                                                    */
/* ==================================================================== */

test("off by default: the run control does not exist, on a fresh device", async () => {
  /* MUTATION: default `voiceProbeOn()` to true — every assertion here goes
     red, and a 90-second CPU burn appears in a listener's drawer. */
  const h = await mount();
  h.openDrawer();
  assert.strictEqual(h.fn("voiceProbeOn")(), false);
  assert.strictEqual(h.run(), null, "no run button while the switch is off");
  assert.ok(h.toggle(), "the switch itself is always there, like #drafts-toggle");
  assert.strictEqual(h.toggle().textContent, "Voice engine probe: off");
});

test("the run control is REMOVED, not hidden", async () => {
  /* `[hidden] { display: none }` is a UA-stylesheet rule and ANY author
     `display` declaration beats it (test/home-layout.test.js's BUG 3). A
     `hidden` control here would render the day `.drawer-item` got a display
     rule.
     MUTATION: set `run.hidden = true` instead of `run.remove()` — the element
     is then still in the tree and this goes red. */
  const h = await mount({ seed: { cp_voice_probe: true } });
  h.openDrawer();
  assert.ok(h.run(), "on: the button exists");
  h.store.setItem("cp_voice_probe", "false");
  h.openDrawer();
  assert.strictEqual(h.run(), null, "off: the button is gone from the tree entirely");
});

test("off is byte-identical to an app with no switch at all", async () => {
  /* Three apps, one drawer. (a) key absent; (b) key stored false; (c) the real
     app with `voiceProbeOn()` stubbed to `return false`.
     MUTATION: make `voiceProbeOn()` return true — (a) and (b) diverge from (c). */
  const stubbed = APP_SRC.replace(
    'function voiceProbeOn() { return lsGet("cp_voice_probe", false); }',
    "function voiceProbeOn() { return false; }",
  );
  assert.notStrictEqual(stubbed, APP_SRC, "the stub must have found voiceProbeOn() to replace");
  const paint = async (opts) => { const h = await mount(opts); h.openDrawer(); return h.drawerIds(); };
  const a = await paint({});
  const b = await paint({ seed: { cp_voice_probe: false } });
  const c = await paint({ appSrc: stubbed });
  assert.ok(a.includes("diag-open") && a.includes("delete-data"), "the drawer is not empty");
  assert.deepStrictEqual(b, a, "key stored as false = key absent");
  assert.deepStrictEqual(c, a, "the switch off = no switch in the source");
});

/* ==================================================================== */
/* ON                                                                   */
/* ==================================================================== */

test("flipping the switch writes the durable key and paints the run control", async () => {
  /* MUTATION: write the key but skip `renderDrawer()` — the button does not
     appear until the drawer is reopened, which reads as a broken switch. */
  const h = await mount();
  h.openDrawer();
  await h.toggle().click();
  assert.strictEqual(h.store.getItem("cp_voice_probe"), "true");
  assert.strictEqual(h.toggle().textContent, "Voice engine probe: on");
  assert.ok(h.run(), "the run control appears without reopening the drawer");
  await h.toggle().click();
  assert.strictEqual(h.store.getItem("cp_voice_probe"), "false");
  assert.strictEqual(h.run(), null);
});

test("the run control sits directly under its switch, never below Delete my data", async () => {
  /* "Delete my data" is the drawer's last item by `bindDeleteControl`'s rule —
     it is the one control that cannot be undone, and the last item is where a
     scrolled thumb lands. A probe button below it would take that place.
     MUTATION: `drawer.appendChild(run)` instead of `insertBefore`. */
  const h = await mount({ seed: { cp_voice_probe: true } });
  h.openDrawer();
  const ids = h.drawerIds();
  assert.strictEqual(ids[ids.indexOf("voice-probe-toggle") + 1], "voice-probe-run");
  assert.strictEqual(ids[ids.length - 1], "delete-data", "Delete my data stays last");
});

test("reopening the drawer does not stack a second run control or a second switch", async () => {
  /* MUTATION: drop the `if (existing) return;` guard in `syncVoiceProbeRun` —
     three opens give three buttons, each with its own listener, so one tap
     runs the probe three times. */
  const h = await mount({ seed: { cp_voice_probe: true } });
  h.openDrawer(); h.openDrawer(); h.openDrawer();
  assert.strictEqual(findAllIn(h.drawer(), "#voice-probe-run").length, 1);
  assert.strictEqual(findAllIn(h.drawer(), "#voice-probe-toggle").length, 1);
});

/* ==================================================================== */
/* The run                                                              */
/* ==================================================================== */

test("tapping run calls the player once and opens the copyable surface", async () => {
  /* The record has to land where a founder can copy it — the Playback
     diagnostics sheet, which is the one copyable surface on the phone
     (HUMAN-ACTIONS.md #21). A probe that painted its numbers into a toast
     would be unreadable by the time anyone asked for them.
     MUTATION: drop `openDiagSheet()` — the sheet stays hidden and the numbers
     are only in `cp_diag`, which nobody can reach without this sheet. */
  const h = await mount({ seed: { cp_voice_probe: true } });
  h.openDrawer();
  await h.run().click();
  await h.settle();
  assert.strictEqual(h.probeCalls.length, 1, "exactly one run per tap");
  assert.strictEqual(h.sheet().hidden, false, "the diagnostics sheet is open");
});

test("a refusal is reported with its reason, not as a measurement", async () => {
  /* THE POINT OF THE WHOLE CARD. A build with no model must say so; anything
     that reads like a number would be pasted into a decision.
     MUTATION: paint `out.text` unconditionally — the refusal then shows the
     formatter's seven-line table full of dashes and no reason. */
  const h = await mount({ seed: { cp_voice_probe: true } });
  h.openDrawer();
  await h.run().click();
  await h.settle();
  const status = h.status().textContent;
  assert.match(status, /could not measure/);
  assert.match(status, /model-absent/, "the reason code is on screen");
  assert.ok(!/go\/no-go/.test(status), "a refusal carries no verdict — there is nothing to judge");
});

test("a successful run shows the numbers and the go/no-go verdict", async () => {
  /* K-01's rule is written before the run, so the founder reads a verdict
     rather than deciding what 0.61 means.
     MUTATION: drop the verdict from the status line. */
  const h = await mount({
    seed: { cp_voice_probe: true },
    probe: { engine: "kokoro-probe", ok: true, rtfWarm: 0.6, peakMemoryMb: 300, lockedScreenCompleted: true },
  });
  h.openDrawer();
  await h.run().click();
  await h.settle();
  const status = h.status().textContent;
  assert.match(status, /voice probe: kokoro-probe/);
  assert.match(status, /go\/no-go: GO/);
});

test("with no player module loaded the run says so instead of throwing", async () => {
  /* A blank or crashed drawer is the one answer this surface must never give
     (`diagText`'s own rule).
     MUTATION: call `player.runVoiceProbe()` without the typeof guard — this
     throws inside a click handler and the status line stays on "Running…". */
  const h = await mount({ seed: { cp_voice_probe: true }, noPlayer: true });
  h.openDrawer();
  await h.run().click();
  await h.settle();
  assert.match(h.status().textContent, /player module has not loaded/);
});

test("a rejecting player is caught and reported, never left as an unhandled rejection", async () => {
  /* #225's lesson: a rejected promise in a tap handler is a console line
     nobody has open.
     MUTATION: remove the try/catch in `runVoiceProbe`. */
  const h = await mount({ seed: { cp_voice_probe: true } });
  h.ctx.window.ForayPlayer.runVoiceProbe = async () => { throw new Error("boom"); };
  h.openDrawer();
  await h.run().click();
  await h.settle();
  assert.match(h.status().textContent, /The probe failed to run/);
});

/* ==================================================================== */
/* The key, and where it may be read                                    */
/* ==================================================================== */

test("the key goes through lsGet with a false default and is documented in the policy", async () => {
  /* `test/data-deletion.test.js` counts the families and demands a policy row;
     this pins the two properties that count depends on.
     MUTATION: read `localStorage` directly instead of through `lsGet` — the
     durable tier stops mirroring it and "Delete my data" stops enumerating it. */
  assert.ok(APP_SRC.includes('lsGet("cp_voice_probe", false)'), "read through lsGet with a false default");
  assert.match(POLICY, /^\|\s*`cp_voice_probe`\s*\|.*\| \*\*No\*\* \|$/m, "one row, and it never leaves the device");
});

test("player/ never reads the key — the page decides whether to OFFER a run", async () => {
  /* `player/` is pure (the rule `test/draft-forays-switch.test.js` states for
     `cp_show_drafts`). `runVoiceProbe()` takes no flag: whether to offer a
     90-second synthesis is a page decision, and a player that consulted
     storage for it could not be tested without one.
     MUTATION: read `cp_voice_probe` anywhere under `player/`. */
  const offenders = fs.readdirSync(path.join(ROOT, "player"))
    .filter((f) => f.endsWith(".js"))
    .filter((f) => fs.readFileSync(path.join(ROOT, "player", f), "utf8").includes("cp_voice_probe"));
  assert.deepStrictEqual(offenders, []);
  assert.ok(/async runVoiceProbe\(\) \{/.test(CLIENT_SRC), "the player's entry point takes no arguments");
});

test("nothing in the probe path touches how narration is spoken", async () => {
  /* THE INERTNESS CLAIM, from the page's side. `client.js`'s `runVoiceProbe`
     must not reach the manager, set a voice, or change the rate.
     MUTATION: route the probe through `manager`/`applyVoice` — this goes red. */
  const fn = CLIENT_SRC.slice(CLIENT_SRC.indexOf("async runVoiceProbe()"));
  const body = fn.slice(0, fn.indexOf("\n  },"));
  for (const forbidden of ["manager", "applyVoice", "applyRate", "setNarrationVoice"]) {
    assert.ok(!body.includes(forbidden), `runVoiceProbe must not mention ${forbidden}`);
  }
});
