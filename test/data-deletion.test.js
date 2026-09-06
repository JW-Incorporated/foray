/* "Delete my data", end to end (#42 / MP8).
 *
 * WHY THIS SUITE EXISTS, AND WHAT IT IS WRITTEN TO CATCH
 * A delete control is the one feature where a green test and a working feature
 * come apart badly: everything can look right while a listener is told their
 * data is gone and it is not. This repo has already produced that shape of bug
 * five times in one day — a guard suite that passed with the mechanism it
 * guarded entirely removed. So the assertions here are deliberately about
 * OBSERVABLE STATE (are the tiers empty, was a DELETE really issued, does the
 * status line say "not deleted") rather than about internal bookkeeping, and the
 * key list is DERIVED from the source rather than typed in.
 *
 * Four properties, in the order they matter:
 *
 *   1. ENUMERATION, NOT A LIST. The audit behind docs/legal/privacy-policy.md
 *      found 20 `cp_` keys where every earlier count said 11. A hard-coded list
 *      in the control would rot the same way, so the control enumerates the
 *      tiers — and this suite scans the shipped source for `cp_` literals and
 *      requires every family it finds to be cleared, and to be documented in the
 *      policy. Add a 21st key and this suite fails until both are true.
 *   2. BOTH TIERS. localStorage and IndexedDB. Clearing one is not clearing.
 *   3. NO FALSE SUCCESS. A remote failure must surface, must leave the device
 *      untouched (its token is the only way back to those rows), and must not
 *      produce success wording.
 *   4. THE CONFIRMATION IS REAL. Neither a stray click nor a direct call can
 *      delete anything — the disabled button and the guard inside the function
 *      are asserted separately, because a mutation that removes either one alone
 *      must still fail.
 *
 * No dependencies: node:test + node:vm, a hand-rolled DOM with a real parent/
 * child tree (app.js appends the control to the drawer and the sheet to <body>,
 * so a flat id-registry stub would not see them), the REAL DurableStore over a
 * fake localStorage and a fake IndexedDB tier, and a fake `fetch`. Nothing here
 * touches the network or the real Supabase project.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ---------- the key families, derived from the code ---------- */

/** Comments stripped before scanning: this repo's files discuss `cp_` keys at
    length in prose, and prose is not a code path (the same trick
    test/app-security.test.js uses on `localStorage`). */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
}

/** Every shipped file that could name a storage key. `*.test.js` is excluded:
    a key that exists only in a test is not a key a listener has. */
function shippedSources() {
  const files = ["app.js", "search-engine.js", "sw.js"];
  for (const f of fs.readdirSync(path.join(ROOT, "player"))) {
    if (f.endsWith(".js") && !f.endsWith(".test.js")) files.push(`player/${f}`);
  }
  return files.filter((f) => fs.existsSync(path.join(ROOT, f)));
}

/**
 * The `cp_` key families the shipped code actually uses.
 *
 * A patterned key comes back with its colon (`cp_pos:`), because
 * `` `cp_pos:${id}` `` is a family rather than a key and the control has to find
 * every instance of it. The bare prefix `"cp_"` — `startsWith("cp_")`,
 * `DEFAULT_PREFIX` — is dropped: it is the namespace, not a row.
 */
function keyFamiliesInSource() {
  const out = new Map();
  for (const rel of shippedSources()) {
    const src = codeOnly(read(rel));
    for (const m of src.matchAll(/["'`](cp_[A-Za-z0-9_]*)(:?)/g)) {
      const family = m[1] + (m[2] || "");
      if (family === "cp_") continue;
      if (!out.has(family)) out.set(family, new Set());
      out.get(family).add(rel);
    }
  }
  return out;
}

/** The keys the privacy policy's §1 table promises to hold, normalised to the
    same family shape (`cp_foray:<id>` -> `cp_foray:`). */
function keyFamiliesInPolicy() {
  const table = read("docs/legal/privacy-policy.md");
  const found = new Set();
  for (const m of table.matchAll(/^\|\s*`(cp_[^`]+)`\s*\|/gm)) {
    found.add(m[1].replace(/<[^>]+>$/, ""));
  }
  return found;
}

/** The `cp_` keys a fixture seeded, for "nothing was touched" assertions. */
const seededKeys = (seed) => Object.keys(seed).filter((k) => k.startsWith("cp_"));

/** One concrete key per family, so a patterned family is exercised with real
    instances rather than with its own stem. */
function sampleKeys(families) {
  const keys = [];
  for (const family of families) {
    if (family.endsWith(":")) keys.push(`${family}alpha-1`, `${family}beta-2`);
    else keys.push(family);
  }
  return keys;
}

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
  append(...kids) {
    for (const k of kids) { k.parent = this; this.children.push(k); }
  }
  appendChild(k) { this.append(k); return k; }
  addEventListener(type, fn) {
    if (!this._on.has(type)) this._on.set(type, []);
    this._on.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._on.get(type);
    if (l) this._on.set(type, l.filter((f) => f !== fn));
  }
  listeners(type = "click") { return (this._on.get(type) ?? []).length; }
  /** Fire a real click through whatever app.js bound. */
  async click() {
    const ev = { preventDefault() {}, stopPropagation() {}, target: this };
    for (const fn of [...(this._on.get("click") ?? [])]) await fn(ev);
  }
  /** Type into a field the way a listener does: set the value, fire `input`.
      Named `enter` rather than `type`, which is an <input> PROPERTY here. */
  async enter(text) {
    this.value = String(text);
    for (const fn of [...(this._on.get("input") ?? [])]) await fn({ target: this });
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  closest() { return null; }
  querySelector(sel) { return findIn(this, sel); }
  querySelectorAll(sel) { return findAllIn(this, sel); }
  get classes() { return [...new Set(String(this.className).split(/\s+/).filter(Boolean)), ...this._c]; }
  /** Every element under this one, self included. */
  tree() {
    const out = [this];
    for (const k of this.children) out.push(...k.tree());
    return out;
  }
}

function matches(el, sel) {
  const s = sel.trim();
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return el.classes.includes(s.slice(1));
  return el.tagName === s.toUpperCase();
}
function findIn(root, sel) { return root.tree().find((e) => e !== root && matches(e, sel)) ?? null; }
function findAllIn(root, sel) { return root.tree().filter((e) => e !== root && matches(e, sel)); }

/* ---------- the fakes ---------- */

/** A localStorage-shaped Map, enumerable the way the real one is. */
function fakeLocal(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  return {
    map,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/**
 * An async "durable" tier standing in for IndexedDB, with the two failure modes
 * that decide whether this feature can be trusted:
 *   `deaf: true`     — accepts `remove` and keeps the row (a silent no-op).
 *   `unreadable: true` — cannot be enumerated at all.
 */
function fakeIdb(seed = {}, { deaf = false, unreadable = false, log = null } = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  return {
    name: "idb", sync: false, durable: true, data,
    async readAll(prefix) {
      if (unreadable) throw new Error("InvalidStateError: database is closed");
      const out = new Map();
      for (const [k, v] of data) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async write(k, v) { data.set(k, String(v)); },
    async remove(k) {
      if (log) log.push({ kind: "idb-remove", key: k });
      if (!deaf) data.delete(k);
    },
  };
}

const SB_URL = "https://qjdllvqdcgacvujhclny.supabase.co";

/** A session token shaped like the one `ensureAnonSession` stores. */
function sessionRow({ expired = false, refresh = "rt-1" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    user_id: "uid-abc", access_token: "at-1", refresh_token: refresh,
    expires_at: expired ? now - 120 : now + 3600,
  });
}

/**
 * Mount app.js with the real durable store and a scripted `fetch`.
 *
 * @param {object} opts
 * @param {object} [opts.seed]  rows placed in BOTH tiers before mounting
 * @param {object} [opts.localOnly] rows only localStorage has
 * @param {object} [opts.idbOnly]   rows only the durable tier has
 * @param {Function} [opts.reply]   (url, method) -> {status} | {status, json} | Error
 * @param {object} [opts.tier]      fakeIdb options (deaf / unreadable)
 * @param {boolean} [opts.noStore]  publish no DurableStore at all (a page whose
 *   player module never loaded), so only raw localStorage is reachable
 */
async function mount({
  seed = {}, localOnly = {}, idbOnly = {}, reply = null, tier = {},
  noStore = false, player = undefined, boot = false, noLocalStorage = false,
} = {}) {
  const { createDurableStore } = await import("../player/durable-store.js");
  const log = [];

  const local = fakeLocal({ ...seed, ...localOnly });
  const idb = fakeIdb({ ...seed, ...idbOnly }, { ...tier, log });
  const store = noStore ? null : createDurableStore({ localStorage: local, idbTier: idb });

  const fetchImpl = (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    /* The page's own `data/*.json` requests NEVER settle, which parks `init()` at
       its first await exactly as test/app-security.test.js and
       player/foray-playback.test.js do. It is not a shortcut: letting them
       resolve with a stub document runs the whole home-screen build, and
       `buildCards()` writes `cp_recent_branches` and `cp_seen` — the harness would
       be putting two of the 20 keys back while asserting they are gone. */
    if (!String(url).startsWith(SB_URL)) {
      log.push({ kind: "page-fetch", url: String(url) });
      /* `boot: true` is the exception, and it exists for one test: that `init()`
         REACHES the control. It serves the real committed documents off disk, so
         the page boots the way it does in a browser — cards dealt, home screen
         rendered, drawer wired. Nothing else uses it, because a booted page writes
         `cp_recent_branches` and `cp_seen` as a matter of course. */
      if (!boot) return new Promise(() => {});
      const rel = String(url);
      const file = path.join(ROOT, rel);
      return Promise.resolve({
        ok: fs.existsSync(file),
        status: fs.existsSync(file) ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
      });
    }
    log.push({ kind: "fetch", method, url: String(url), headers: opts.headers || {}, body: opts.body });
    const out = reply ? reply(String(url), method) : { status: 204 };
    // A rejected promise, not a synchronous throw: that is what a real `fetch`
    // does when the network fails, and the difference matters to a caller that
    // only wraps the `await`.
    if (out instanceof Error) return Promise.reject(out);
    const status = out.status ?? 204;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.json ?? {},
    });
  };

  const dom = { body: new El("body") };
  for (const id of ["view", "drawer", "drawer-overlay", "drawer-playlists",
    "family-toggle", "player-toggle", "autoadvance-toggle", "menu-btn", "refresh-btn",
    // The home screen's own vocabulary, needed only under `boot`.
    "banner-slot", "pl-form", "pl-input", "pl-note",
    "tab-topics", "tab-shows", "sh-form", "sh-input", "sh-note", "sh-results",
    "browse-all-link",
    "pl-remove", "banner-done"]) {
    const el = new El("div");
    el.id = id;
    dom.body.append(el);
  }

  const playerBridge = player === undefined
    ? {
      stopForDataDeletion: async () => { log.push({ kind: "player-stop" }); return true; },
      /* Enough of the bridge for a real `renderHome()` under `boot`. Empty lists
         rather than fakes: this test is about the drawer, and a home screen with
         no Forays on it is the shipped state for a visitor with no `?foray=`. */
      listForays: () => [],
      forayResumeList: () => [],
      canPlay: () => false,
      fmtClock: (s) => String(Math.round(s)),
      fmtSpan: (s) => `${Math.round(s)}s`,
    }
    : player;

  const ctx = {
    console: { ...console, warn() {}, error() {} },
    fetch: fetchImpl,
    ...(noLocalStorage ? {} : { localStorage: local }),
    ...(store ? { forayStorage: store } : {}),
    document: {
      body: dom.body,
      documentElement: dom.body,
      readyState: "complete",
      addEventListener() {},
      createElement: (t) => new El(t),
      querySelector: (s) => findIn(dom.body, s),
      querySelectorAll: (s) => findAllIn(dom.body, s),
    },
    navigator: { userAgent: "node" },
    /* `window.addEventListener` exists because `init()` ends by binding
       `hashchange` — and because `waitForStorage()` treats its ABSENCE as "no store
       is ever arriving". Both harnesses publish the store before app.js evaluates,
       so the wait still resolves on its first check. */
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
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  if (playerBridge) ctx.window.ForayPlayer = playerBridge;

  // Hydration is what pulls the durable-only rows into memory; app.js awaits it
  // in init(), which is parked on its never-settling fetch here.
  if (store) await store.hydrate();

  if (boot) {
    /* `init()` does the binding in a browser, so under `boot` the harness must
       NOT — that is the whole assertion. Give the real boot sequence a few turns
       of the loop to finish its fetches, its render and its wiring. */
    for (let i = 0; i < 40 && !findIn(dom.body, "#delete-data"); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  } else {
    ctx.bindDeleteControl();
  }
  const openBtn = findIn(dom.body, "#delete-data");
  const sheet = findIn(dom.body, "#dd-sheet");
  const ui = {
    openBtn, sheet,
    input: findIn(dom.body, "#dd-confirm"),
    go: findIn(dom.body, ".dd-go"),
    cancel: findIn(dom.body, ".fy-sheet-cancel"),
    scrim: findIn(dom.body, ".fy-scrim"),
    deviceOnly: findIn(dom.body, ".dd-device-only"),
    status: findIn(dom.body, "#dd-status"),
  };

  /** Open the sheet and type the confirmation, the way a listener does. */
  const arm = async (word = "DELETE") => {
    await openBtn.click();
    await ui.input.enter(word);
  };
  const cpKeys = () => ({
    local: [...local.map.keys()].filter((k) => k.startsWith("cp_")).sort(),
    idb: [...idb.data.keys()].filter((k) => k.startsWith("cp_")).sort(),
  });
  const deletes = () => log.filter((e) => e.kind === "fetch" && e.method === "DELETE");

  return { ctx, dom, ui, log, local, idb, store, arm, cpKeys, deletes };
}

/* ================= 1. enumeration, not a list ================= */

test("the shipped source names exactly the 21 cp_ key families the audit found", () => {
  /* The count is pinned deliberately. 20-not-11 is the whole reason this control
     enumerates instead of carrying a list, and a new key is a privacy-policy
     change as much as a code change — see the next test.

     20 -> 21 on 2026-08-18: `cp_diag`, the local field record (#264). It arrived
     the way this check is written to make sure a key arrives — the count failed,
     then the policy check failed, and both stayed red until
     `docs/legal/privacy-policy.md` §1 documented the row.

     21 -> 22 on 2026-08-31: `cp_queue`, the Up Next list
     (docs/listening-queue-plan.md Stage 1, kanban card t_f4da81f5). Same
     mechanism: this count failed first, then the "documented in the privacy
     policy" test below failed, until privacy-policy.md §1 got the row.

     22 -> 23 on 2026-08-31: `cp_autoadvance`, the Up Next auto-advance
     per-device toggle (docs/listening-queue-plan.md §8 addendum, kanban card
     t_b9880844). Same mechanism again.

     23 -> 21 on 2026-09-01 (M3, kanban card t_c7199b13): `cp_events` and
     `cp_synced_ts` retired. The outbound event queue moved off this store into
     its own IndexedDB database (`player/event-log.js`) — it is not resumable
     per-user state, so it was never the kind of key this enumeration exists to
     protect, and it no longer names a `cp_` string anywhere in the shipped
     source. See `docs/legal/privacy-policy.md` §1's note on the queue.

     21 -> 22 on 2026-09-02: `cp_starred_shows`, the starred-shows list
     (Q2's follow-lite answer, kanban card t_7cc5eaa5) — a per-device map of
     starred show ids, same storage pattern as every other resumable-state
     key here. */
  const families = [...keyFamiliesInSource().keys()].sort();
  assert.strictEqual(
    families.length, 22,
    `expected 22 cp_ key families, found ${families.length}:\n${families.join("\n")}`
  );
  assert.ok(families.includes("cp_foray:"), "the patterned Foray resume key must be found as a family");
  assert.ok(families.includes("cp_pos:"), "the patterned episode-position key must be found as a family");
  assert.ok(families.includes("cp_storage_health"), "the diagnostic key is a key too");
  /* Both diagnostic keys, named individually. They are the two rows a reader is
     most likely to assume are not "user data" and therefore exempt from the
     delete promise — and the whole point is that they are not exempt. */
  assert.ok(families.includes("cp_diag"), "the field record (#264) is a key too");
});

test("every key family in the code is documented in the privacy policy, and vice versa", () => {
  const inCode = [...keyFamiliesInSource().keys()].sort();
  const inPolicy = [...keyFamiliesInPolicy()].sort();
  const undocumented = inCode.filter((k) => !inPolicy.includes(k));
  const stale = inPolicy.filter((k) => !inCode.includes(k));
  assert.deepStrictEqual(
    undocumented, [],
    "these keys exist in the code and are missing from docs/legal/privacy-policy.md §1:\n" +
      undocumented.join("\n")
  );
  assert.deepStrictEqual(
    stale, [],
    "these keys are in the policy table and no longer in the code:\n" + stale.join("\n")
  );
});

test("every documented key family is cleared from BOTH tiers", async () => {
  const keys = sampleKeys([...keyFamiliesInSource().keys()]);
  const seed = Object.fromEntries(keys.map((k) => [k, JSON.stringify({ v: k })]));
  const { arm, ui, cpKeys } = await mount({ seed });
  const before = cpKeys();
  assert.ok(before.local.length >= 20 && before.idb.length >= 20, "the fixture must seed both tiers");

  await arm();
  await ui.go.click();

  const after = cpKeys();
  assert.deepStrictEqual(after.local, [], "localStorage still holds Foray keys");
  assert.deepStrictEqual(after.idb, [], "IndexedDB still holds Foray keys");
});

test("a key nobody wrote a list for is cleared too — enumeration, not a list", async () => {
  const seed = {
    cp_interests: "{}",
    cp_a_key_invented_tomorrow: "1",
    "cp_foray:brand-new-foray": "{}",
  };
  const { arm, ui, cpKeys } = await mount({ seed });
  await arm();
  await ui.go.click();
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] });
});

test("a row only the durable tier has — one localStorage never saw — is found and cleared", async () => {
  const { arm, ui, cpKeys, idb, store } = await mount({ localOnly: { cp_interests: "{}" } });
  // Written straight into the tier AFTER hydration, so memory has never seen it:
  // exactly the row an eviction leaves behind, and the row a control that walks
  // `length`/`key(i)` cannot see.
  idb.data.set("cp_pos:ep-99", JSON.stringify({ seconds: 12 }));
  assert.ok(!Array.from({ length: store.length }, (_, i) => store.key(i)).includes("cp_pos:ep-99"));

  await arm();
  await ui.go.click();
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] });
});

test("cp_storage_health is cleared even though the facade deliberately hides it", async () => {
  const { arm, ui, cpKeys, store } = await mount({ seed: { cp_storage_health: "{}", cp_seen: "[]" } });
  const facade = Array.from({ length: store.length }, (_, i) => store.key(i));
  assert.ok(
    !facade.includes("cp_storage_health"),
    "premise gone: the facade now lists the health key, so this trap no longer exists"
  );
  await arm();
  await ui.go.click();
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] });
});

/* ================= 2. both tiers ================= */

test("a durable tier that swallows removes is reported, not called a success", async () => {
  const { arm, ui, cpKeys, ctx } = await mount({
    seed: { cp_interests: "{}", cp_seen: "[]" },
    tier: { deaf: true },
  });
  await arm();
  const result = await ctx.deleteMyData();

  assert.strictEqual(result.ok, false, "a tier that kept the rows is not a success");
  assert.deepStrictEqual(cpKeys().local, [], "localStorage was still cleared");
  assert.ok(cpKeys().idb.length > 0, "fixture premise: the deaf tier keeps its rows");
  assert.ok(result.local.remaining.length > 0, "the rows that survived must be named");
  assert.match(ui.status.textContent, /NOT fully clear/);
});

test("a durable tier that cannot be read forces an honest failure", async () => {
  // "I could not look" is not "it is empty" — the distinction the store draws in
  // hydration, and the one that decides whether this control may claim success.
  const { arm, ui, ctx } = await mount({
    seed: { cp_interests: "{}" },
    tier: { unreadable: true },
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, false);
  assert.ok(result.local.unverified.length > 0, "the tier it could not read must be named");
  assert.match(ui.status.textContent, /NOT fully clear/);
});

test("with no durable store published, the control says so instead of claiming success", async () => {
  // app.js and player/client.js deploy independently through the service worker,
  // so a page with no store is real. localStorage is reachable; IndexedDB is not.
  const { arm, ui, ctx, local } = await mount({
    noStore: true,
    seed: { cp_interests: "{}", cp_seen: "[]" },
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.local.reason, "no-durable-tier");
  assert.deepStrictEqual([...local.map.keys()].filter((k) => k.startsWith("cp_")), []);
  assert.match(ui.status.textContent, /reload and try again/i);
});

/* ================= 3. the server rows ================= */

test("the table list is the RLS migration's list of per-user tables", () => {
  /* Pinned against the migration so a new per-user table cannot appear there
     without this failing — the deletion has to grow with the schema, and nothing
     else in CI would notice. */
  const sql = read("backend/migrations/supabase/0001_auth_and_rls.sql");
  const block = /foreach t in array array\[([\s\S]*?)\]/.exec(sql);
  assert.ok(block, "the RLS migration's table array could not be parsed");
  const inSql = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const inApp = [...codeOnly(APP_SRC).matchAll(/const SB_USER_TABLES = \[([\s\S]*?)\];/g)]
    .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]))
    .sort();
  assert.deepStrictEqual(
    inApp, inSql,
    "app.js's SB_USER_TABLES and the RLS migration disagree about which tables " +
      "hold per-user rows. A table in the migration and not in app.js is data a " +
      "deletion silently leaves behind."
  );
});

test("one authenticated DELETE per table, filtered to this account's own uid", async () => {
  const { arm, ui, deletes } = await mount({ seed: { cp_sb_session: sessionRow() } });
  await arm();
  await ui.go.click();

  const calls = deletes();
  assert.strictEqual(calls.length, 8, "every per-user table must be asked");
  for (const c of calls) {
    assert.ok(c.url.startsWith(`${SB_URL}/rest/v1/`), c.url);
    assert.ok(c.url.includes("user_id=eq.uid-abc"), `unfiltered delete: ${c.url}`);
    assert.strictEqual(c.headers.Authorization, "Bearer at-1", "the row owner's token must be sent");
    assert.ok(c.headers.apikey, "the publishable key is required by the REST endpoint");
  }
  assert.ok(calls[0].url.includes("/events?"), "events is the table the promise rests on — delete it first");
});

test("the events rows are deleted before the local token that reaches them", async () => {
  const { arm, ui, log } = await mount({ seed: { cp_sb_session: sessionRow() } });
  await arm();
  await ui.go.click();
  const firstDelete = log.findIndex((e) => e.kind === "fetch" && e.method === "DELETE");
  const firstRemove = log.findIndex((e) => e.kind === "idb-remove");
  assert.ok(firstDelete >= 0 && firstRemove >= 0, "both halves must have run");
  assert.ok(
    firstDelete < firstRemove,
    "local storage was cleared before the server call — that destroys the only " +
      "credential that can delete those rows"
  );
});

test("a network error surfaces, and NOTHING is deleted", async () => {
  const keys = sampleKeys([...keyFamiliesInSource().keys()]);
  const seed = Object.fromEntries(keys.map((k) => [k, "{}"]));
  seed.cp_sb_session = sessionRow();
  const { arm, ui, ctx, cpKeys } = await mount({
    seed,
    reply: () => new Error("Failed to fetch"),
  });
  await arm();
  const result = await ctx.deleteMyData();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state, "remote-failed");
  assert.match(ui.status.textContent, /NOT deleted/);
  assert.ok(!/^Done/.test(ui.status.textContent), "a failure must never open with a success word");
  const after = cpKeys();
  assert.ok(after.local.includes("cp_sb_session"), "the token must survive so a retry is possible");
  assert.deepStrictEqual(after.local, seededKeys(seed).sort(), "no local key may be cleared on this path");
  assert.deepStrictEqual(after.idb, seededKeys(seed).sort(), "no durable key may be cleared on this path");
});

test("a 500 from one table stops the whole run", async () => {
  const { arm, ui, ctx, cpKeys } = await mount({
    seed: { cp_sb_session: sessionRow(), cp_interests: "{}" },
    reply: (url) => (url.includes("/saved_items") ? { status: 500 } : { status: 204 }),
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.state, "remote-failed");
  assert.ok(cpKeys().local.includes("cp_interests"), "the device must be left alone");
});

test("a 401 is a refusal, not a success", async () => {
  const { arm, ctx } = await mount({
    seed: { cp_sb_session: sessionRow() },
    reply: () => ({ status: 401 }),
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.state, "remote-failed");
  assert.strictEqual(result.remote.failed.length, 8);
});

test("a 404 means the table is not in this project — no rows of ours, not a failure", async () => {
  const { arm, ctx, cpKeys } = await mount({
    seed: { cp_sb_session: sessionRow(), cp_interests: "{}" },
    reply: () => ({ status: 404 }),
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, true, "an absent table cannot hold your rows");
  assert.strictEqual(result.remote.deleted, 0);
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] });
});

test("deleting never signs up a new anonymous account", async () => {
  const { arm, ui, log, ctx } = await mount({ seed: { cp_interests: "{}" } });
  await arm();
  const result = await ctx.deleteMyData();
  assert.ok(
    !log.some((e) => e.kind === "fetch" && /\/auth\/v1\/signup/.test(e.url)),
    "creating an account in order to delete one would leave a fresh row behind"
  );
  assert.strictEqual(result.remote.attempted, false, "no token on the device means no rows to reach");
  assert.match(ui.status.textContent, /no account token/i);
  assert.strictEqual(result.ok, true);
});

test("an expired token is refreshed and the refreshed one is used to delete", async () => {
  const { arm, ui, log } = await mount({
    seed: { cp_sb_session: sessionRow({ expired: true }) },
    reply: (url) => (url.includes("/auth/v1/token")
      ? { status: 200, json: { access_token: "at-2", refresh_token: "rt-2", user: { id: "uid-abc" } } }
      : { status: 204 }),
  });
  await arm();
  await ui.go.click();
  const refresh = log.filter((e) => e.kind === "fetch" && /grant_type=refresh_token/.test(e.url));
  assert.strictEqual(refresh.length, 1, "a stale token is refreshed once, not per table");
  const dels = log.filter((e) => e.kind === "fetch" && e.method === "DELETE");
  assert.ok(dels.length > 0);
  assert.ok(dels.every((d) => d.headers.Authorization === "Bearer at-2"));
});

test("an expired token whose refresh fails is still tried, so the server's answer decides", async () => {
  const { arm, ctx, log } = await mount({
    seed: { cp_sb_session: sessionRow({ expired: true }) },
    reply: (url) => (url.includes("/auth/v1/token") ? { status: 400 } : { status: 204 }),
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.ok(log.some((e) => e.method === "DELETE" && e.headers.Authorization === "Bearer at-1"));
  assert.strictEqual(result.ok, true);
});

/* ================= 4. the confirmation ================= */

test("the confirm button is disabled until the word is typed", async () => {
  const { ui, arm } = await mount();
  await ui.openBtn.click();
  assert.strictEqual(ui.go.disabled, true, "the sheet must open with the destructive button dead");
  await arm("");
  assert.strictEqual(ui.go.disabled, true);
  await ui.input.enter("DELETE");
  assert.strictEqual(ui.go.disabled, false);
});

test("only the confirmation word enables it", async () => {
  const { ui } = await mount();
  await ui.openBtn.click();
  for (const wrong of ["", " ", "d", "DELET", "DELETE ME", "yes", "remove", "DELETEE"]) {
    await ui.input.enter(wrong);
    assert.strictEqual(ui.go.disabled, true, `"${wrong}" must not arm the control`);
  }
  for (const right of ["DELETE", "delete", "  DELETE  ", "Delete"]) {
    await ui.input.enter(right);
    assert.strictEqual(ui.go.disabled, false, `"${right}" is the confirmation`);
  }
});

test("a stray click on the drawer item and then the button deletes nothing", async () => {
  const { ui, cpKeys, deletes } = await mount({ seed: { cp_interests: "{}", cp_sb_session: sessionRow() } });
  await ui.openBtn.click();     // one stray tap opens a sheet, and that is all
  await ui.go.click();          // and another lands on the disabled confirm
  assert.deepStrictEqual(deletes(), [], "no DELETE may be issued without the confirmation");
  assert.ok(cpKeys().local.includes("cp_interests"), "nothing may be cleared");
  assert.ok(cpKeys().idb.includes("cp_interests"));
});

test("calling the deletion directly without the typed word refuses — the guard is not the disabled attribute", async () => {
  /* Asserted separately from the button state on purpose: a change that drops
     `go.disabled` must still not be able to delete anything, and a change that
     drops this guard must still be caught by the button test above. Neither test
     alone protects the control. */
  const { ctx, cpKeys, deletes, ui } = await mount({ seed: { cp_interests: "{}", cp_sb_session: sessionRow() } });
  await ui.openBtn.click();
  ui.go.disabled = false;                       // pretend the attribute was lost
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.state, "unconfirmed");
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(deletes(), []);
  assert.ok(cpKeys().local.includes("cp_interests"));
  assert.match(ui.status.textContent, /Type DELETE/);
});

test("a deletion refuses before the sheet has ever been opened", async () => {
  const { ctx, cpKeys, deletes } = await mount({ seed: { cp_interests: "{}" } });
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.state, "unconfirmed");
  assert.deepStrictEqual(deletes(), []);
  assert.ok(cpKeys().local.includes("cp_interests"));
});

test("dismissing the sheet clears the typed confirmation, so reopening starts disarmed", async () => {
  const { ui, arm, cpKeys } = await mount({ seed: { cp_interests: "{}" } });
  await arm();
  assert.strictEqual(ui.go.disabled, false);
  await ui.scrim.click();
  assert.strictEqual(ui.sheet.hidden, true, "the scrim closes the sheet");
  assert.strictEqual(ui.go.disabled, true, "the confirmation must not survive a dismissal");
  await ui.openBtn.click();
  await ui.go.click();
  assert.ok(cpKeys().local.includes("cp_interests"));
});

test("cancel closes and deletes nothing", async () => {
  const { ui, arm, cpKeys, deletes } = await mount({ seed: { cp_interests: "{}" } });
  await arm();
  await ui.cancel.click();
  assert.strictEqual(ui.sheet.hidden, true);
  assert.deepStrictEqual(deletes(), []);
  assert.ok(cpKeys().local.includes("cp_interests"));
});

test("the device-only escape hatch is hidden until a remote failure, and states the cost", async () => {
  const { arm, ui, ctx, cpKeys } = await mount({
    seed: { cp_sb_session: sessionRow(), cp_interests: "{}" },
    reply: () => new Error("offline"),
  });
  await ui.openBtn.click();
  assert.strictEqual(ui.deviceOnly.hidden, true, "it must not be offered before it is needed");

  await ui.input.enter("DELETE");
  await ctx.deleteMyData();
  assert.strictEqual(ui.deviceOnly.hidden, false);
  assert.ok(cpKeys().local.length > 0, "still nothing deleted at this point");

  const second = await ctx.deleteMyData({ deviceOnly: true });
  assert.strictEqual(second.ok, true);
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] });
  assert.match(ui.status.textContent, /left in place/, "it must say the server rows remain");
});

/* ================= 5. playback, and what the app does next ================= */

test("the player is stopped — without flushing — before anything is deleted", async () => {
  const { arm, ui, log } = await mount({ seed: { cp_sb_session: sessionRow(), "cp_foray:g1": "{}" } });
  await arm();
  await ui.go.click();
  const stop = log.findIndex((e) => e.kind === "player-stop");
  const firstDelete = log.findIndex((e) => e.kind === "fetch" && e.method === "DELETE");
  assert.ok(stop >= 0, "a running player writes a position every ~15 s and would undo the clear");
  assert.ok(stop < firstDelete, "stop first, then delete");
});

test("a player that throws on stop does not block the deletion", async () => {
  const { arm, ui, cpKeys } = await mount({
    seed: { cp_interests: "{}" },
    player: { stopForDataDeletion: async () => { throw new Error("no element"); } },
  });
  await arm();
  await ui.go.click();
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] });
});

test("an older player module with no stop method does not block the deletion", async () => {
  // app.js and player/client.js deploy independently; a missing method must cost
  // the flush guard, never the deletion.
  const { arm, ui, cpKeys } = await mount({ seed: { cp_interests: "{}" }, player: {} });
  await arm();
  await ui.go.click();
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] });
});

test("the deletion writes nothing back: no event row, no fresh profile id", async () => {
  /* logEvent() writes to window.forayEventLog (formerly cp_events) and mints
     cp_profile_id, and the next sync would create a NEW anonymous account —
     telling the server about a deletion by starting a fresh identity. So this
     action is the one the app does not log. */
  const { arm, ui, cpKeys, store } = await mount({
    seed: { cp_profile_id: '"p-1"', cp_interests: "{}" },
  });
  await arm();
  await ui.go.click();
  await store.flush();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] }, "something wrote a key back after the clear");
});

test("interests fall back to taxonomy defaults without writing anything", async () => {
  /* Updated for kanban t_1cb3688a: loadInterests() now seeds every taxonomy
     node, roots included (the root-node persistence bug fix), so the
     post-deletion default set includes the root "food" alongside its leaf
     "food.bbq" — not just the leaf, as before that fix. */
  const { arm, ui, ctx, cpKeys } = await mount({ seed: { cp_interests: '{"food":0.9}' } });
  vm.runInContext(
    'state.taxonomy = { nodes: [{ id: "food", parent: null, weight: 0.5 }, { id: "food.bbq", parent: "food", weight: 0.4 }] };',
    ctx
  );
  await arm();
  await ui.go.click();
  const interests = vm.runInContext("JSON.stringify(state.interests)", ctx);
  assert.deepStrictEqual(JSON.parse(interests), { food: 0.5, "food.bbq": 0.4 }, "the profile must be back to defaults, roots included");
  assert.deepStrictEqual(cpKeys(), { local: [], idb: [] }, "resetting must not write the defaults back");
});

test("a second click while a deletion is in flight is refused", async () => {
  const { arm, ctx, deletes } = await mount({
    seed: { cp_sb_session: sessionRow() },
    reply: () => ({ status: 204 }),
  });
  await arm();
  // Two runs started before either finished: one must be refused outright.
  const first = ctx.deleteMyData();
  const second = await ctx.deleteMyData();
  await first;
  assert.strictEqual(second.state, "busy", "two purges and two DELETE sweeps must not race one token");
  assert.strictEqual(deletes().length, 8, "exactly one sweep of the tables");
});

/* ================= 6. what the listener reads ================= */

test("every line of the sheet is inside the copy budget and uses no banned word", () => {
  const banned = /\b(fascinating|deep dive|delve|explores)\b/i;
  // The shipped array itself, evaluated out of app.js rather than copied here —
  // a copy would let the real copy drift past the budget while this stayed green.
  const covers = vm.runInNewContext(
    `${/const DD_COVERS = \[[\s\S]*?\];/.exec(APP_SRC)[0]}\nDD_COVERS`
  );
  assert.ok(covers.length >= 4, "the sheet has to say what it covers and what it cannot");
  for (const line of covers) {
    assert.ok(line.trim().split(/\s+/).length <= 18, `over 18 words: ${line}`);
    assert.ok(!banned.test(line), `banned copy: ${line}`);
  }
});

test("the sheet is honest about the two things the control cannot reach", () => {
  const covers = /const DD_COVERS = \[([\s\S]*?)\];/.exec(APP_SRC)[1];
  assert.match(covers, /account row stays/i, "the anonymous account row is not deletable from here");
  assert.match(covers, /IP/, "the publisher and ad hosts that saw the listener's IP cannot be reached");
});

test("Play's deletion answer is Yes in the data-safety declaration, and names the control", () => {
  const doc = read("docs/legal/data-safety.md");
  const q = /Do you provide a way for users to request that their data be deleted\?\*\*\s*([\s\S]*?)\n- \*\*Independent/.exec(doc);
  assert.ok(q, "the deletion question could not be found in docs/legal/data-safety.md");
  assert.match(q[1], /\*\*Yes/, "the answer must now be Yes — the control exists");
  assert.match(q[1], /Delete my data/, "the answer must name the in-app control");
  assert.ok(
    !/there is \*\*no in-app delete or reset control\*\*/.test(doc),
    "the old No answer is still in the file"
  );
});

test("the privacy policy's deletion section points at the button, not at browser settings only", () => {
  const doc = read("docs/legal/privacy-policy.md");
  const section = /## 7\. How to delete your data([\s\S]*?)\n## 8\./.exec(doc);
  assert.ok(section, "§7 could not be found");
  assert.match(section[1], /Delete my data/, "§7 must name the control");
  assert.ok(
    !/no in-app "clear my data" button/.test(doc),
    "the policy still says there is no button"
  );
  assert.match(section[1], /account row/i, "§7 must say what happens to the anonymous account");
});

/* ================= 7. the control is actually WIRED ================= */

test("BOOTING THE REAL PAGE puts the control in the drawer — nothing else asserts it exists", async () => {
  /* THE MOST IMPORTANT TEST IN THIS FILE, and it was missing until review proved
     why: deleting the single `bindDeleteControl();` line from `init()` left all 43
     suites green and the feature unreachable on every real page. Every other test
     here calls the binder itself. This one does not: it boots app.js against the
     REAL committed data documents and looks for the button a listener taps. */
  const { dom, ui } = await mount({ boot: true });
  const btn = findIn(dom.body, "#delete-data");
  assert.ok(btn, "init() never wired the control — there is no Delete my data item in the drawer");
  assert.strictEqual(btn.parent && btn.parent.id, "drawer", "the control must live in the menu");
  assert.ok(btn.listeners("click") > 0, "the drawer item is not clickable");
  assert.strictEqual(btn.textContent, "Delete my data");

  // And it works from that state: opening arms nothing, and the sheet is there.
  await btn.click();
  assert.ok(ui.sheet, "the confirmation sheet was never built");
  assert.strictEqual(ui.sheet.hidden, false);
  assert.strictEqual(ui.go.disabled, true);
});

test("booting twice does not stack two buttons or two listeners", async () => {
  const { dom, ctx, ui } = await mount({ boot: true });
  ctx.bindDeleteControl();
  ctx.bindDeleteControl();
  assert.strictEqual(findAllIn(dom.body, "#delete-data").length, 1);
  assert.strictEqual(findAllIn(dom.body, "#dd-sheet").length, 1);
  assert.strictEqual(ui.openBtn.listeners("click"), 1);
  assert.strictEqual(ui.go.listeners("click"), 1);
});

/* ================= 8. the failure paths review found ================= */

test("a browser with no storage at all is told so, not told it is clear", async () => {
  const { arm, ui, ctx } = await mount({ noStore: true, noLocalStorage: true });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, false, "there is no storage to have cleared");
  assert.strictEqual(result.local.reason, "no-storage");
  assert.match(ui.status.textContent, /NOT fully clear/);
  assert.match(ui.status.textContent, /taken storage away/);
});

test("a localStorage that throws on READ is handled, not left to throw mid-delete", async () => {
  /* The fallback path exists for a degraded browser, and `SecurityError` comes out
     of `length` and `getItem` as readily as out of `removeItem` — review found the
     reads unguarded, which would have thrown out of the whole deletion. */
  const { ctx, ui, arm, local } = await mount({ noStore: true, seed: { cp_interests: "{}" } });
  Object.defineProperty(local, "length", {
    get() { const e = new Error("blocked"); e.name = "SecurityError"; throw e; },
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.local.reason, "no-storage");
  assert.match(ui.status.textContent, /NOT fully clear/);
});

test("a store whose purge THROWS reports it, and the control still works afterwards", async () => {
  /* `ddBusy` gates the buttons AND blocks dismissal, so a throw with no `finally`
     left the sheet reading "Deleting…" with Cancel, the scrim and the confirm
     button all dead until a reload. Review drove exactly that. */
  const { ctx, ui, arm } = await mount({ seed: { cp_interests: "{}" } });
  ctx.window.forayStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
    purge: async () => { throw new Error("InvalidStateError"); },
  };
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.local.reason, "purge-failed");
  assert.match(ui.status.textContent, /NOT fully clear/);

  // The control is not bricked: it closes, reopens, and re-arms.
  await ui.cancel.click();
  assert.strictEqual(ui.sheet.hidden, true, "Cancel is dead — the sheet is stuck open");
  await ui.openBtn.click();
  await ui.input.enter("DELETE");
  assert.strictEqual(ui.go.disabled, false, "the confirm button never came back");
});

test("the sheet cannot be dismissed while a deletion is in flight", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctx, ui, arm } = await mount({
    seed: { cp_sb_session: sessionRow(), cp_interests: "{}" },
    reply: () => gate.then(() => ({ status: 204 })),
  });
  await arm();
  const running = ctx.deleteMyData();
  assert.strictEqual(ui.status.textContent, "Deleting…");
  await ui.cancel.click();
  await ui.scrim.click();
  assert.strictEqual(ui.sheet.hidden, false, "a run in flight must not be dismissed out from under itself");
  assert.strictEqual(ui.go.disabled, true, "and both destructive buttons are dead while it runs");
  assert.strictEqual(ui.deviceOnly.disabled, true);
  release();
  assert.strictEqual((await running).ok, true);
  // ...and it is dismissible again once it is done.
  await ui.cancel.click();
  assert.strictEqual(ui.sheet.hidden, true);
});

test("reopening the sheet disarms it — two stray taps must not delete anything", async () => {
  /* Closing cleared the field; reopening WITHOUT closing did not, so a listener
     who typed DELETE, wandered off, then tapped the drawer item and the confirm
     button would have deleted everything on two stray taps. */
  const { ui, arm, cpKeys, deletes } = await mount({
    seed: { cp_interests: "{}", cp_sb_session: sessionRow() },
  });
  await arm();
  assert.strictEqual(ui.go.disabled, false);
  await ui.openBtn.click();
  assert.strictEqual(ui.input.value, "", "the typed confirmation survived a reopen");
  assert.strictEqual(ui.go.disabled, true);
  await ui.go.click();
  assert.deepStrictEqual(deletes(), []);
  assert.ok(cpKeys().local.includes("cp_interests"));
});

test("the device-only clear needs the typed word too", async () => {
  // It is the same destructive clear with the server step skipped, and its button
  // only appears after a failure — which is when someone is jabbing at the sheet.
  const { ctx, ui, arm, cpKeys } = await mount({
    seed: { cp_sb_session: sessionRow(), cp_interests: "{}" },
    reply: () => new Error("offline"),
  });
  await arm();
  await ctx.deleteMyData();
  assert.strictEqual(ui.deviceOnly.hidden, false, "premise: the hatch is offered");

  await ui.input.enter("");                       // the word is gone
  assert.strictEqual(ui.deviceOnly.disabled, true, "an unarmed sheet must not offer a live button");
  const result = await ctx.deleteMyData({ deviceOnly: true });
  assert.strictEqual(result.state, "unconfirmed");
  assert.ok(cpKeys().local.includes("cp_interests"), "the device was cleared with no confirmation");
});

test("a refresh response with no user object does not throw the deletion away", async () => {
  const { arm, ctx, log } = await mount({
    seed: { cp_sb_session: sessionRow({ expired: true }) },
    reply: (url) => (url.includes("/auth/v1/token")
      // A token with no `user`: not a shape we have seen, and reading through it
      // would be a TypeError out of the middle of a deletion.
      ? { status: 200, json: { access_token: "at-9" } }
      : { status: 204 }),
  });
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const dels = log.filter((e) => e.kind === "fetch" && e.method === "DELETE");
  assert.strictEqual(dels.length, 8);
  assert.ok(dels.every((d) => d.url.includes("user_id=eq.uid-abc")), "the id we already held is the right one");
  assert.ok(dels.every((d) => d.headers.Authorization === "Bearer at-9"));
});

/* ================= 9. every word, every state ================= */

test("EVERY status message the control can show is inside the copy budget", async () => {
  /* The first version of this test read only `DD_COVERS`, and review found two
     status lines over the budget behind it. This walks every state the control can
     reach, through the shipped function. */
  const banned = /\b(fascinating|deep dive|delve|explores)\b/i;
  const { ctx } = await mount();
  const states = [
    { state: "unconfirmed", remote: null, local: null },
    { state: "busy", remote: null, local: null },
    { state: "remote-failed", remote: { ok: false, attempted: true, failed: [{}], deleted: 0 }, local: null },
    { state: "done", remote: { ok: true, attempted: true, deleted: 8 }, local: { ok: true } },
    { state: "done", remote: { ok: true, attempted: false, deleted: 0 }, local: { ok: true } },
    { state: "done", remote: { ok: true, attempted: false, deviceOnly: true, deleted: 0 }, local: { ok: true } },
    { state: "local-incomplete", remote: { ok: true, attempted: true, deleted: 8 }, local: { ok: false, reason: "no-durable-tier" } },
    { state: "local-incomplete", remote: { ok: true, attempted: true, deleted: 8 }, local: { ok: false, reason: "no-storage" } },
    { state: "local-incomplete", remote: { ok: true, attempted: true, deleted: 8 }, local: { ok: false, reason: "purge-failed", error: "InvalidStateError" } },
    { state: "local-incomplete", remote: { ok: true, attempted: true, deleted: 8 }, local: { ok: false, remaining: ["cp_a", "cp_b"] } },
  ];
  for (const result of states) {
    const msg = ctx.deletionMessage(result);
    assert.ok(msg && msg.length > 0, `no message for ${JSON.stringify(result)}`);
    assert.ok(!banned.test(msg), `banned copy: ${msg}`);
    for (const sentence of msg.split(/(?<=[.!?])\s+/)) {
      const words = sentence.trim().split(/\s+/).filter(Boolean).length;
      assert.ok(words <= 18, `${words} words in "${sentence}" (the budget is 18)`);
    }
  }
});

test("a failure never borrows the wording of a success", async () => {
  const { ctx } = await mount();
  const failures = [
    { state: "remote-failed", remote: { ok: false, attempted: true, failed: [{}], deleted: 0 }, local: null },
    { state: "local-incomplete", remote: { ok: true, attempted: true, deleted: 8 }, local: { ok: false, reason: "no-storage" } },
  ];
  for (const result of failures) {
    const msg = ctx.deletionMessage(result);
    assert.ok(!/^Done/.test(msg), `a failure opens with a success word: ${msg}`);
    assert.match(msg, /NOT/, `a failure must say so plainly: ${msg}`);
  }
  const done = ctx.deletionMessage({ state: "done", remote: { ok: true, attempted: true, deleted: 8 }, local: { ok: true } });
  assert.match(done, /^Done\./);
});

test("no message claims a number the control did not measure", () => {
  /* A Supabase DELETE returns 204 whether or not a row matched, and this client
     only ever WRITES `events` — so "deleted from 8 tables" told every listener
     something we never observed about seven of them. Review caught it. */
  const section = /function deletionMessage\([\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.ok(!/remote\.deleted/.test(section), "the message is quoting a table count again");
});

test("no storage key is ever built by concatenating the prefix", () => {
  /* The source scan in this file finds `"cp_…"` literals, which is what makes the
     20-key count derivable — and it cannot see `"cp_" + name` or a template built
     from the bare prefix. Enumeration would still CLEAR such a key; what it would
     break is the pin that keeps the privacy policy's table honest. So the
     construction is banned outright, which is cheaper than a cleverer scanner. */
  const offenders = [];
  for (const rel of shippedSources()) {
    const src = codeOnly(read(rel));
    // `startsWith("cp_")` and the like are fine: a prefix TEST is not a key.
    for (const m of src.matchAll(/["'`]cp_["'`]\s*\+|`cp_\$\{/g)) {
      offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    "a storage key assembled from the bare prefix is invisible to the key scan in " +
      "this file, and therefore to the privacy-policy pin. Write the literal:\n" +
      offenders.join("\n")
  );
});

test("a localStorage that ACCEPTS a remove and keeps the row is reported, key by key", async () => {
  /* The silent no-op, one tier down: `removeItem` returns normally and the row is
     still there. The fallback path re-reads every key it removed for exactly this
     reason — a cleared mirror is not cleared storage, and neither is an uncleared
     one that said yes. */
  const { ctx, ui, arm, local } = await mount({
    noStore: true,
    seed: { cp_interests: "{}", cp_seen: "[]" },
  });
  local.removeItem = () => {};                 // yes, sir. (nothing happens)
  await arm();
  const result = await ctx.deleteMyData();
  assert.strictEqual(result.ok, false);
  // Spread first: the array was built inside the vm realm, so its prototype is
  // not this realm's Array and deepStrictEqual compares prototypes.
  assert.deepStrictEqual([...result.local.remaining].sort(), ["cp_interests", "cp_seen"]);
  assert.match(ui.status.textContent, /NOT fully clear/);
});
