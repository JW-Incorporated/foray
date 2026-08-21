/* The field record's SURFACE (#264) — a drawer item and a sheet, on a phone.
 *
 * WHY THIS IS A THIRD SUITE
 * `player/diagnostic-log.test.js` covers the mechanism and
 * `player/diagnostic-record.test.js` covers the wiring, but both live under
 * `player/` and neither can see `app.js` — which is a classic browser script and
 * cannot be imported from an ES module. And the surface is not a detail here: the
 * entire argument of #264 is that the numbers already existed and went to
 * `console.warn`, "a console line nobody has open", true of a phone in a car. A
 * record nobody can reach is the bug, not the fix.
 *
 * So this file mounts the real `app.js` in a `node:vm` over a hand-rolled DOM with
 * a real parent/child tree — the sheet is appended to `<body>` and the drawer item
 * to `#drawer`, so a flat id registry would not see the relationship this suite
 * asserts. Same technique as `test/data-deletion.test.js`; its harness is not
 * exported and is deliberately not shared, because coupling two suites through one
 * harness is how one of them silently stops covering anything.
 *
 * WHAT EACH TEST WOULD CATCH is named in the test. The two properties that are
 * only assertable here:
 *
 *   - the control is REACHABLE (in the drawer, above the one control that cannot
 *     be undone) and its text is COPYABLE;
 *   - opening, copying and clearing it touch NO NETWORK and never put the record
 *     into `cp_events`. "We forgot to add it to the sync" and "it must never be in
 *     the sync" look identical in a diff, so the second one is written down.
 *
 * No dependencies: node:test + node:vm only, matching the suites above.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/* ---------- a DOM with a tree ---------- */

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
    this.focused = false;
    this.selected = false;
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
    for (const fn of [...(this._on.get("click") ?? [])]) out.push(fn({}));
    return Promise.all(out);
  }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  closest() { return null; }
  querySelector(sel) { return findIn(this, sel); }
  querySelectorAll(sel) { return findAllIn(this, sel); }
  tree() { return [this, ...this.children.flatMap((c) => c.tree())]; }
}

function matches(el, sel) {
  const s = String(sel).trim();
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return String(el.className).split(/\s+/).includes(s.slice(1));
  return el.tagName === s.toUpperCase();
}
function findIn(root, sel) { return root.tree().find((e) => e !== root && matches(e, sel)) ?? null; }
function findAllIn(root, sel) { return root.tree().filter((e) => e !== root && matches(e, sel)); }

/* ---------- the mount ---------- */

/**
 * Mount app.js with a scripted player bridge.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.report]  what `window.forayDiagnosticReport()` returns.
 *   `null` publishes no bridge at all — the page whose player module never loaded.
 * @param {Error} [opts.reportThrows]  make the bridge throw.
 * @param {boolean} [opts.clipboard]   whether `navigator.clipboard.writeText` exists.
 * @param {boolean} [opts.clipboardRefuses] make it reject, as a WebView does.
 * @param {boolean} [opts.boot] let the REAL `init()` wire the drawer, serving the
 *   committed `data/*.json` off disk. Without this the harness calls the bind
 *   functions itself, which is fast and covers the sheet — but it cannot see
 *   whether `init()` calls them at all, or in which order. A mutation round proved
 *   that mattered: deleting `bindDiagnosticsControl()` from `init()` left every
 *   other test in this file green. Only one test uses it, because a booted page
 *   also writes `cp_recent_branches` and `cp_seen` as a matter of course.
 */
function mount({
  report = "4a playback diagnostics — v1\nentries 2 of 200 (oldest dropped first)",
  reportThrows = null, clipboard = true, clipboardRefuses = false, seed = {}, boot = false,
} = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const fetches = [];
  const copied = [];
  const cleared = [];
  const body = new El("body");
  for (const id of ["view", "drawer", "drawer-overlay", "drawer-playlists",
    "family-toggle", "player-toggle", "menu-btn", "refresh-btn",
    // The home screen's own vocabulary, needed only under `boot`.
    "banner-slot", "home-intro", "intro-close", "pl-form", "pl-input", "pl-note",
    "pl-remove", "banner-done"]) {
    const el = new El("div");
    el.id = id;
    body.append(el);
  }

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    /* Never settles: parks `init()` at its first await, exactly as
       test/app-security.test.js and test/data-deletion.test.js do. Every entry
       recorded here is a request this surface must never make. */
    fetch: (url) => {
      fetches.push(String(url));
      if (!boot) return new Promise(() => {});
      const file = path.join(ROOT, String(url));
      const ok = fs.existsSync(file);
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
      });
    },
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      body,
      documentElement: body,
      readyState: "complete",
      addEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => findIn(body, s),
      querySelectorAll: (s) => findAllIn(body, s),
    },
    navigator: {
      userAgent: "node",
      ...(clipboard
        ? {
          clipboard: {
            writeText: async (t) => {
              if (clipboardRefuses) throw new Error("NotAllowedError");
              copied.push(t);
            },
          },
        }
        : {}),
    },
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

  if (report !== null || reportThrows) {
    ctx.window.forayDiagnosticReport = () => {
      if (reportThrows) throw reportThrows;
      return report;
    };
    ctx.window.forayDiagnosticClear = () => { cleared.push(true); return true; };
  }
  /* `init()` binds this in a browser. Under `boot` the harness must NOT — that is
     the whole assertion there. Otherwise `init()` is parked on its never-settling
     fetch and the harness calls the binders, the same shape
     test/data-deletion.test.js uses. */
  if (boot) {
    ctx.window.ForayPlayer = {
      listForays: () => [],
      forayResumeList: () => [],
      forayResume: () => null,
      forayDriftIsClean: () => true,
      canPlay: () => false,
      fmtClock: (n) => String(Math.round(n)),
      fmtSpan: (n) => `${Math.round(n)}s`,
      resolve: () => null,
    };
  } else {
    ctx.bindDiagnosticsControl();
    ctx.bindDeleteControl();
  }

  const ui = {
    open: findIn(body, "#diag-open"),
    sheet: findIn(body, "#diag-sheet"),
    text: findIn(body, "#diag-text"),
    copy: findIn(body, ".diag-copy"),
    clearBtn: findIn(body, ".diag-clear"),
    close: findIn(body, ".fy-sheet-cancel"),
    scrim: findIn(body, ".fy-scrim"),
    status: findIn(body, "#diag-status"),
  };
  return { ctx, body, ui, store, fetches, copied, cleared };
}

/** Mount with the real `init()` doing the wiring, and wait for it to land. */
async function mountBooted() {
  const m = mount({ boot: true });
  for (let i = 0; i < 60 && !findIn(m.body, "#diag-open"); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  return m;
}

/* ==================================================================== */
/* 1. reachable, on a phone, without devtools                            */
/* ==================================================================== */

test("the drawer carries a Playback diagnostics item", () => {
  /* MUTATION: drop the `drawer.appendChild(btn)`. The record becomes unreachable
     without devtools, which is the exact failure #264 is about, and this fails. */
  const { ui } = mount();
  assert.ok(ui.open, "no #diag-open in the drawer");
  assert.strictEqual(ui.open.textContent, "Playback diagnostics");
  assert.strictEqual(ui.open.parent.id, "drawer", "it has to be IN the drawer");
});

test("THE REAL init() wires it, and leaves Delete my data as the drawer's LAST item", async () => {
  /* THE ONE TEST THAT BOOTS THE PAGE FOR REAL, and it exists because a mutation
     round proved it had to. Every other test in this file calls the bind functions
     itself, so deleting `bindDiagnosticsControl()` from `init()` — a control that
     exists, is tested, and is never wired — left them all green. That is the
     "passed with the mechanism removed" shape this repo keeps producing.

     The ORDER is not cosmetics either. The drawer's last item is where a scrolled
     thumb lands, and "Delete my data" is the one control in there that cannot be
     undone — `app.js`'s own comment says exactly that. A new control must go above
     it.

     MUTATION 1: remove `bindDiagnosticsControl()` from `init()`. This fails.
     MUTATION 2: move it below `bindDeleteControl()`. This fails. */
  const { body } = await mountBooted();
  const drawer = findIn(body, "#drawer");
  const ids = drawer.children.map((c) => c.id).filter(Boolean);
  assert.ok(ids.includes("diag-open"), `init() never wired the control: ${ids.join(", ")}`);
  assert.strictEqual(ids[ids.length - 1], "delete-data", `drawer order was ${ids.join(", ")}`);
  assert.ok(ids.indexOf("diag-open") < ids.indexOf("delete-data"));
});

test("binding twice does not stack a second button or a second listener", () => {
  /* MUTATION: remove the `if (!drawer || $("#diag-open")) return` guard. Two
     buttons appear and this fails. */
  const { ctx, body } = mount();
  ctx.bindDiagnosticsControl();
  ctx.bindDiagnosticsControl();
  assert.strictEqual(findAllIn(body, "#diag-open").length, 1);
  assert.strictEqual(findAllIn(body, "#diag-sheet").length, 1);
});

test("tapping it shows the record, in a readonly textarea, and copyable", () => {
  /* THE WHOLE POINT. A readonly <textarea> rather than a <pre>: Select All takes
     the entire record instead of the visible box, and it cannot be edited into
     something that misreports what was measured.

     MUTATION 1: set `ui.text.textContent` instead of `.value`. A textarea's value
     is what is selected and copied, so the box would look right and copy empty —
     the first assertion fails.
     MUTATION 2: drop the `readonly` attribute. The third fails. */
  const { ui } = mount({ report: "SEAM ROWS HERE" });
  assert.ok(ui.sheet.hidden, "closed until asked for");
  ui.open.click();
  assert.ok(!ui.sheet.hidden);
  assert.strictEqual(ui.text.value, "SEAM ROWS HERE");
  assert.strictEqual(ui.text.tagName, "TEXTAREA");
  assert.strictEqual(ui.text.getAttribute("readonly"), "readonly");
});

test("it is re-read every time it is opened, not snapshotted at boot", () => {
  /* The founder's loop is: open the app, look, drive, look again. A sheet built
     once at startup would show the state before the drive.
     MUTATION: move `refreshDiagSheet()` out of `openDiagSheet()` into
     `buildDiagSheet()`. This fails. */
  let n = 0;
  const { ctx, ui } = mount();
  ctx.window.forayDiagnosticReport = () => `read ${++n}`;
  ui.open.click();
  assert.strictEqual(ui.text.value, "read 1");
  ui.close.click();
  ui.open.click();
  assert.strictEqual(ui.text.value, "read 2");
});

test("the scrim and Close dismiss it", () => {
  const { ui } = mount();
  ui.open.click();
  ui.scrim.click();
  assert.ok(ui.sheet.hidden);
  ui.open.click();
  ui.close.click();
  assert.ok(ui.sheet.hidden);
});

/* ==================================================================== */
/* 2. it is never blank, and never silent                                */
/* ==================================================================== */

test("a page whose player module never loaded says so rather than showing a blank box", () => {
  /* A blank box reads as "nothing went wrong" when it can also mean "the module
     that records is not here". That ambiguity is the thing #264 exists to remove,
     so it must not be reintroduced by the surface.
     MUTATION: return "" when the bridge is absent. This fails. */
  const { ui } = mount({ report: null });
  ui.open.click();
  assert.match(ui.text.value, /player module has not loaded/i);
  assert.ok(ui.text.value.length > 20);
});

test("a bridge that throws is reported, not swallowed into an empty sheet", () => {
  /* MUTATION: wrap `diagText()`'s body in a try that returns "". This fails. */
  const { ui } = mount({ reportThrows: new Error("ring unreadable") });
  ui.open.click();
  assert.match(ui.text.value, /could not be read/i);
  assert.match(ui.text.value, /ring unreadable/);
});

test("Copy uses the clipboard and SAYS it did", async () => {
  /* MUTATION: drop the status line. A copy that silently did nothing is
     indistinguishable from one that worked, on a phone with no console. */
  const { ui, copied } = mount({ report: "ROWS" });
  ui.open.click();
  await ui.copy.click();
  assert.deepStrictEqual(copied, ["ROWS"]);
  assert.match(ui.status.textContent, /copied/i);
});

test("a refused clipboard falls back to selecting the whole record, and says so", async () => {
  /* WKWebView has historically refused the async Clipboard API, and it needs a
     secure context. A refusal is the expected case, not an error.
     MUTATION 1: remove the fallback `select()`. The listener's own copy gesture
     takes the visible box instead of the record, and the second assertion fails.
     MUTATION 2: let the rejection escape the try/catch. The click rejects and this
     fails. */
  const { ui } = mount({ report: "ROWS", clipboardRefuses: true });
  ui.open.click();
  await ui.copy.click();
  assert.ok(ui.text.selected, "the record has to be selected for a manual copy");
  assert.match(ui.status.textContent, /selected/i);
});

test("a browser with no clipboard API at all still gets the fallback", async () => {
  const { ui } = mount({ report: "ROWS", clipboard: false });
  ui.open.click();
  await ui.copy.click();
  assert.ok(ui.text.selected);
  assert.match(ui.status.textContent, /copy/i);
});

test("Clear empties the record through the bridge and repaints", () => {
  /* The founder's loop is clear, drive, copy: three earlier drives in a 200-entry
     ring make the drive under test hard to find.
     MUTATION: call the bridge without `refreshDiagSheet()`. The box still shows the
     cleared rows and the second assertion fails. */
  let text = "OLD ROWS";
  const { ctx, ui, cleared } = mount();
  ctx.window.forayDiagnosticReport = () => text;
  ctx.window.forayDiagnosticClear = () => { text = "Nothing recorded yet."; cleared.push(true); return true; };
  ui.open.click();
  assert.strictEqual(ui.text.value, "OLD ROWS");
  ui.clearBtn.click();
  assert.strictEqual(cleared.length, 1);
  assert.match(ui.text.value, /Nothing recorded yet/);
  assert.match(ui.status.textContent, /cleared/i);
});

test("Clear is a separate control from Copy, so a mis-hit is not destructive", () => {
  /* Copy is in `.fy-sheet-actions` beside Close; Clear is on its own line below.
     MUTATION: put Clear into the actions row. This fails. */
  const { ui } = mount();
  assert.notStrictEqual(ui.clearBtn.parent, ui.copy.parent);
  assert.ok(String(ui.copy.parent.className).includes("fy-sheet-actions"));
});

/* ==================================================================== */
/* 3. no network, and never in the transmitted pipeline                  */
/* ==================================================================== */

test("opening, copying and clearing the record make NO request", async () => {
  /* THE DESIGN, ASSERTED AT THE SURFACE. #264's original text said the `cp_events`
     pipeline has a consent gate; it does not — `trySyncEvents()` is called
     unconditionally at `app.js:664` and `:686`. So a richer record of a person's
     listening does not go anywhere, and the way to keep that true across future
     edits is to fail a test when it stops being true.

     MUTATION: add any `fetch` — a "send diagnostics" button, a beacon — to this
     path. This fails. */
  const { ui, fetches } = mount({ report: "ROWS" });
  const before = fetches.length;
  ui.open.click();
  await ui.copy.click();
  ui.clearBtn.click();
  ui.close.click();
  assert.deepStrictEqual(
    fetches.slice(before), [],
    `the diagnostics surface issued: ${fetches.slice(before).join(", ")}`
  );
});

test("nothing about the record enters cp_events", () => {
  /* MUTATION: call `logEvent("diagnostics_opened", …)` from `openDiagSheet` — the
     obvious "let us see if anyone uses it" change. It would be a NEW event type in
     an ungated pipeline, and this fails. */
  const { ui, store } = mount({ report: "ROWS" });
  ui.open.click();
  ui.close.click();
  const events = store.get("cp_events") ?? "[]";
  assert.ok(
    !/diag/i.test(events),
    `the diagnostics surface wrote to the transmitted buffer:\n${events}`
  );
});

test("clearing the device forgets the record, and the STOP does not", () => {
  /* THE DELETE PROMISE, and the ordering is the whole finding. `purge()` removes
     `cp_diag` from both tiers like any other `cp_` key, but the player module holds
     that ring in memory — so without a call the next `visibilitychange` writes every
     purged entry back under a key a listener just asked to be emptied.

     It has to be called from `clearLocalData()` and NOT from
     `stopForDataDeletion()`. The stop runs FIRST in `deleteMyData`, before the server
     step, and a remote failure returns early with the device deliberately untouched —
     "its token is the only way back to those rows". A clear in the stop destroyed the
     field record on exactly that path: someone offline who taps Delete, fails the
     call and declines device-only lost it silently.

     MUTATION 1: remove the `forayForgetDiagnostics()` call from `clearLocalData`. The
     first assertion fails.
     MUTATION 2: move it back into `stopForDataDeletion`. `player/diagnostic-record.test.js`
     fails on the same finding from the other side. */
  const forgot = [];
  const { ctx } = mount();
  ctx.window.forayForgetDiagnostics = () => { forgot.push(true); return true; };
  ctx.clearLocalData();
  assert.strictEqual(forgot.length, 1, "clearing the device must forget the record");

  const src = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  const stop = src.slice(src.indexOf("stopForDataDeletion"), src.indexOf("stopForDataDeletion") + 400);
  assert.ok(
    !/forayForgetDiagnostics|forayDiagnosticClear/.test(stop),
    "the stop must not clear it: a remote failure leaves the device untouched on purpose"
  );
});

test("a page whose player module never loaded still deletes cleanly", async () => {
  /* The call is guarded, because `clearLocalData` runs on a page where the ES module
     may have failed to load at all — and a missing diagnostic bridge is not a reason
     to refuse a deletion. `app.js`'s own comment on the `stopForDataDeletion` call
     makes the same argument.
     AWAITED, and that is not a formality: `clearLocalData` is `async`, so an unguarded
     call returns a REJECTED PROMISE rather than throwing. A synchronous
     `assert.doesNotThrow` passed with the guard removed — the mutation survived until
     the await went in, which is the vacuous-test shape this repo keeps producing.

     TWO GUARDS, and the test statement is about the OUTCOME rather than either one:
     the `typeof` check for the ordinary case (the module is simply not there) and the
     try/catch for a bridge that throws. Removing only the `typeof` check leaves the
     try/catch to absorb it, so that mutation is inert on purpose — belt and braces
     where the cost of a wrong answer is a deletion that refuses to run.

     MUTATION: remove BOTH. The promise rejects, the delete never reaches `purge()`,
     and this fails. */
  const { ctx } = mount({ report: null });
  delete ctx.window.forayForgetDiagnostics;
  const out = await ctx.clearLocalData();
  assert.ok(out && typeof out === "object", "the delete still returns a result");
});

test("the transmitted-row mapper has no case for anything diagnostic", () => {
  /* A source-level check, and it earns its place: the two tests above prove the
     SURFACE sends nothing, and this one proves the SYNC has no route for it even if
     a future caller buffered one. `toEventRow`'s `default: return null` is what
     makes an unknown type local-only, so what has to stay true is that no explicit
     case names the record.
     MUTATION: add `case "diagnostics":` to `toEventRow`. This fails. */
  const src = APP_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
  const mapper = src.slice(src.indexOf("function toEventRow"), src.indexOf("async function trySyncEvents"));
  assert.ok(mapper.length > 200, "the mapper has to be found, or this test is about nothing");
  assert.ok(!/cp_diag|diagnostic/i.test(mapper), "toEventRow must know nothing about the record");
  const sync = src.slice(src.indexOf("async function trySyncEvents"), src.indexOf("function leafNodes"));
  assert.ok(sync.length > 200, "trySyncEvents has to be found");
  assert.ok(!/cp_diag|diagnostic/i.test(sync), "trySyncEvents must not read the record");
});

test("the sheet is built with createElement and never assigns innerHTML", () => {
  /* The page CSP is strict, and this text — while all first-party — is rendered
     into a control a listener reads. The repo's rule is createElement/textContent
     for anything built in JS.
     MUTATION: build the panel from a template string. This fails. */
  const src = APP_SRC.slice(
    APP_SRC.indexOf("function buildDiagSheet"),
    APP_SRC.indexOf("function bindDeleteControl")
  );
  assert.ok(src.length > 500, "the block has to be found, or this test is about nothing");
  assert.ok(!/innerHTML/.test(src), "no innerHTML in the diagnostics surface");
  assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(src));
});
