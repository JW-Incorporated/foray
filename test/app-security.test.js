/* Security invariants for app.js (Tier 4 auto-merge gate).
 *
 * WHY THIS EXISTS
 * Until 2026-08-11 the only CI coverage of app.js was `node --check` — a syntax
 * check. It would pass an XSS regression, a CSP violation, or a javascript:
 * URL without complaint. That was fine while every app.js change was read by a
 * human; it is not fine now that `app.js` is in the auto-merge allowlist
 * (.github/workflows/automerge-nightly.yml). This file is what replaces the
 * human read for the class of bug that actually matters here.
 *
 * WHAT IT DOES NOT DO — read this before trusting it
 * These are *security and convention* invariants, not behavioural coverage of
 * rendering. A change that makes the home page render blank while keeping every
 * invariant below intact will pass. Full render coverage needs a real DOM, and
 * jsdom is a dependency this repo deliberately does not have (root
 * package.json: "NO dependencies and NO build step"). The smoke test at the
 * bottom closes part of that gap with a hand-rolled DOM stub — deliberately
 * minimal, and honest about its limits.
 *
 * No dependencies: node:test + node:vm only, matching player/*.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = fs.readFileSync(APP_PATH, "utf8");

/* ---------- harness ----------
   app.js is a classic browser script that calls init() at top level. init() is
   async and awaits fetchJson() first, so a fetch that never settles parks it at
   the first await — the function declarations are all hoisted and reachable,
   and no DOM work happens. That is the whole trick that makes this dependency
   free. */
function loadApp() {
  const noop = () => {};
  const el = () => ({
    addEventListener: noop, removeEventListener: noop, appendChild: noop,
    setAttribute: noop, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop },
    style: {}, dataset: {}, children: [], hidden: false,
    innerHTML: "", textContent: "", className: "",
    querySelector: () => el(), querySelectorAll: () => [],
  });

  const store = new Map();
  const ctx = {
    console,
    // Never settles: parks init() at its first await.
    fetch: () => new Promise(() => {}),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body: el(), documentElement: el(),
      addEventListener: noop, createElement: el,
      querySelector: () => el(), querySelectorAll: () => [],
    },
    navigator: { userAgent: "node" },
    location: { hash: "#/", href: "https://example.test/" },
    history: { replaceState: noop, pushState: noop },
    CSS: { escape: (s) => String(s) },
    URL, Math, Date, JSON, Promise, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  // Unhandled rejection from the parked init() must not kill the test run.
  process.on("unhandledRejection", noop);
  vm.runInContext(SRC, ctx, { filename: "app.js" });
  return ctx;
}

const app = loadApp();

/* ---------- esc(): the HTML-escaping primitive ---------- */

test("esc is reachable and is a function", () => {
  assert.strictEqual(typeof app.esc, "function");
});

test("esc escapes every character that can break out of an HTML context", () => {
  assert.strictEqual(app.esc("&"), "&amp;");
  assert.strictEqual(app.esc("<"), "&lt;");
  assert.strictEqual(app.esc(">"), "&gt;");
  assert.strictEqual(app.esc('"'), "&quot;");
  assert.strictEqual(app.esc("'"), "&#39;");
});

test("esc neutralises a script-tag injection", () => {
  const out = app.esc('<script>alert(1)</script>');
  assert.ok(!out.includes("<script"), "raw <script must not survive escaping");
  assert.strictEqual(out, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("esc neutralises an attribute-breakout payload", () => {
  // The realistic feed-data attack: close the attribute, add a handler.
  const out = app.esc('" onerror="alert(1)');
  assert.ok(!out.includes('"'), "no raw double quote may survive");
  assert.strictEqual(out, "&quot; onerror=&quot;alert(1)");
});

test("esc escapes ampersands first, so entities are not double-decodable", () => {
  // If & were escaped last, "&lt;" would come back out as a literal "<".
  assert.strictEqual(app.esc("&lt;"), "&amp;lt;");
});

test("esc coerces null and undefined to empty string, not the words", () => {
  assert.strictEqual(app.esc(null), "");
  assert.strictEqual(app.esc(undefined), "");
});

test("esc stringifies non-strings rather than throwing", () => {
  assert.strictEqual(app.esc(42), "42");
  assert.strictEqual(app.esc(0), "0");
  assert.strictEqual(app.esc(false), "false");
});

/* ---------- safeUrl(): the URL-scheme gate ---------- */

test("safeUrl is reachable and is a function", () => {
  assert.strictEqual(typeof app.safeUrl, "function");
});

test("safeUrl passes through http and https unchanged", () => {
  assert.strictEqual(app.safeUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.strictEqual(app.safeUrl("http://example.com/"), "http://example.com/");
});

test("safeUrl rejects every scheme that can execute", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
  ]) {
    assert.strictEqual(app.safeUrl(bad), "#", `${bad} must be neutralised`);
  }
});

test("safeUrl rejects malformed and empty input rather than passing it through", () => {
  for (const bad of ["", "   ", "not a url", "//protocol-relative", null, undefined]) {
    assert.strictEqual(app.safeUrl(bad), "#");
  }
});

test("safeUrl does not attempt to sanitise — it either allows or replaces", () => {
  // A rejected URL must become exactly "#", never a partially-cleaned string
  // that a caller might mistake for safe.
  assert.strictEqual(app.safeUrl("javascript:alert(1)"), "#");
});

/* ---------- static invariants (CLAUDE.md § Conventions) ----------
   "All escaping in app.js goes through esc(); all href/src through safeUrl().
    The page has a strict CSP — no inline styles/scripts."
   Enforced by nothing until now. */

test("every interpolated href and src passes through safeUrl", () => {
  const attrs = SRC.match(/\b(?:href|src)\s*=\s*"\$\{[^}]*\}/g) || [];
  assert.ok(attrs.length > 0, "expected at least one interpolated href/src to guard");
  const unguarded = attrs.filter((a) => !a.includes("safeUrl("));
  assert.deepStrictEqual(
    unguarded, [],
    "these href/src interpolations bypass safeUrl():\n" + unguarded.join("\n")
  );
});

test("no inline style attribute — the CSP has style-src 'self'", () => {
  const hits = SRC.match(/\bstyle\s*=\s*["'`]/g) || [];
  assert.deepStrictEqual(hits, [], "inline style attributes are blocked by the page CSP");
});

test("no inline script tag is ever constructed", () => {
  const hits = SRC.match(/<script\b/gi) || [];
  assert.deepStrictEqual(hits, [], "the CSP is script-src 'self'; inline scripts cannot run");
});

test("no javascript: URL is constructed anywhere in the source", () => {
  const hits = SRC.match(/javascript\s*:/gi) || [];
  assert.deepStrictEqual(hits, []);
});

test("localStorage keys keep the legacy cp_ prefix", () => {
  // CLAUDE.md: renaming these wipes existing user state. A rename is a silent,
  // unrecoverable data loss for every current user, so it is worth a gate.
  const keys = [...SRC.matchAll(/\bls(?:Get|Set)\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, "expected localStorage usage to guard");
  const bad = keys.filter((k) => !k.startsWith("cp_"));
  assert.deepStrictEqual(bad, [], "localStorage keys must keep the cp_ prefix");
});

/* ---------- the storage shim is the only door (#40) ----------

   Durability is only durable if EVERYTHING goes through the shim. One direct
   `localStorage` write added later — by a hurried change or a bot PR on the
   auto-merge path — is a key that lives only in the evictable tier, is never
   migrated, and silently disappears for the listener who comes back next week.
   That is the original defect reintroduced one line at a time, and it is
   invisible in review because it looks exactly like the code that used to be
   correct.

   THIS TEST WAS WEAKER AND WAS DEFEATED. The first version matched dotted calls
   (`/\blocalStorage\s*\.\s*\w+\s*\(/`). Review broke it in one edit — a `RAW`
   alias plus `RAW["setItem"](…)` moved `cp_events` off the durable store, out of
   the `cp_` prefix gate above, and still scored a full green run. Computed member
   access, an alias and a destructure all walk past a call-shaped pattern, and
   tightening the pattern is a losing game.

   So the rule is inverted: `localStorage` may be NAMED in exactly one place, and
   that place is pinned verbatim. Anything else — dotted, computed, aliased,
   destructured, or a shape nobody has thought of — fails. */

/** Comments are stripped before the scan: the shim's own header discusses
    `localStorage` at length, and prose is not a code path. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
}

/** The one sanctioned reference in each file, verbatim. If a legitimate change
    reformats these, this test fails and the fix is to re-pin it here — which is
    the point: the diff has to say so. */
const SANCTIONED = {
  "app.js": `function storageBackend() {
  if (window.forayStorage) return window.forayStorage;
  return typeof localStorage !== "undefined" ? localStorage : null;
}`,
  "player/client.js": `  localStorage: typeof localStorage !== "undefined" ? localStorage : null,`,
};

for (const [rel, sanctioned] of Object.entries(SANCTIONED)) {
  test(`${rel} names localStorage in exactly one sanctioned place (#40)`, () => {
    /* Newlines normalised: this repo is developed on Windows against a
       Unix-normalised tree, so the same file is CRLF in one checkout and LF in
       another and a multi-line pin would be a coin flip (CLAUDE.md § Never
       discard uncommitted work names the same trap). */
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
    assert.ok(
      src.includes(sanctioned),
      `the sanctioned localStorage reference in ${rel} has changed. If that was ` +
        `deliberate, re-pin it in SANCTIONED in test/app-security.test.js.`
    );
    const stray = (codeOnly(src.replace(sanctioned, " ")).match(/\blocalStorage\b/g) || []);
    assert.deepStrictEqual(
      stray, [],
      `${rel} names localStorage ${stray.length} time(s) outside the shim. Every one ` +
        `of those bypasses the durable store (#40) — including an alias, a ` +
        `destructure or localStorage["setItem"], which a call-shaped check misses. ` +
        `Route it through lsGet/lsSet (app.js) or the injected store (player/).`
    );
  });
}

test("the shim prefers window.forayStorage, which is what makes cp_ state durable", () => {
  // The wiring, behaviourally: player/client.js publishes a DurableStore there,
  // and app.js has to actually use it. Falling back to localStorage when it is
  // absent is the other half — a 404 on the module must cost durability, never
  // the page.
  const written = new Map();
  app.window.forayStorage = {
    getItem: (k) => (written.has(k) ? written.get(k) : null),
    setItem: (k, v) => written.set(k, String(v)),
    removeItem: (k) => written.delete(k),
  };
  try {
    assert.strictEqual(app.lsSet("cp_interests", { a: 1 }), true);
    assert.strictEqual(written.get("cp_interests"), '{"a":1}');
    assert.deepStrictEqual(app.lsGet("cp_interests", null), { a: 1 });
    // A store that refuses everything must be reported, not swallowed.
    app.window.forayStorage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    assert.strictEqual(app.lsSet("cp_interests", { a: 2 }), false);
    assert.deepStrictEqual(app.lsGet("cp_interests", "fallback"), "fallback");
  } finally {
    delete app.window.forayStorage;
  }
  // And with no store published, the legacy path still works unchanged.
  assert.strictEqual(app.lsSet("cp_interests", { a: 3 }), true);
  assert.deepStrictEqual(app.lsGet("cp_interests", null), { a: 3 });
});

/* ---------- segLenOf: the Foray strip's only unit of measurement ----------

   Not a security invariant, and here anyway, because this is the only harness in
   the repo that can reach an app.js internal. `segLenOf` sizes each bar of the
   Foray strip and is the denominator of the fill inside the current bar, while
   `stripElapsedAt` maps a click onto `r.totalSec` — the player's clock. So a
   length this measures differently from `player/foray-queue.js`'s
   `itemRuntimeSec` puts a click somewhere the bar it landed on does not cover. */

test("segLenOf prefers the player's own itemRuntimeSec over its local copy", async () => {
  const { itemRuntimeSec } = await import("../player/foray-queue.js");
  const item = { kind: "tts", duration_sec: 40 };
  try {
    app.window.ForayPlayer = { itemLen: () => 12345 };
    assert.strictEqual(app.segLenOf(item), 12345, "the bridge is authoritative when present");
  } finally {
    delete app.window.ForayPlayer;
  }
  // And with no bridge published, the fallback must give the SAME answer the
  // player would — a fallback that disagrees is the drift, not the safety net.
  for (const probe of [
    { kind: "tts", duration_sec: 40 },
    { start_sec: 10, end_sec: 130 },
    { start_sec: 10, end_sec: 200, authored_end_sec: 130 },
    { start_sec: 10, end_sec: 130, duration_sec: 999 },
    // The case `segLenOf`'s own `isNum` comment exists to justify: `??` would
    // pass NaN through and measure 0 here while foray-resolve.js measured 190.
    { start_sec: 10, end_sec: 200, authored_end_sec: NaN },
    { start_sec: 10, end_sec: 5, duration_sec: 40 },
    {},
  ]) {
    assert.strictEqual(app.segLenOf(probe), itemRuntimeSec(probe), JSON.stringify(probe));
  }
});

test("segLenOf measures a narration bridge, so a strip click cannot land off its own bar", () => {
  /* THE DEFECT THIS CLOSES. `segLenOf` had no `duration_sec` branch, so a bridge
     measured 0 s and sized to the 1px floor while occupying real seconds of the
     clock a click is mapped onto. On s1(100 s) + bridge(40 s) + s2(60 s) the bars
     summed to 161 units against a 200 s Foray, and a click on the left edge of
     s2's bar resolved to 125.5 s — 14.5 s before s2 begins.

     Mutation: delete the `duration_sec` return in `segLenOf`'s fallback. The
     first assertion drops to 0 and the widths stop summing to the runtime. */
  const playable = [
    { kind: "episode", start_sec: 0, end_sec: 100 },
    { kind: "tts", duration_sec: 40 },
    { kind: "episode", start_sec: 300, end_sec: 360 },
  ];
  assert.strictEqual(app.segLenOf(playable[1]), 40);
  const units = playable.reduce((t, i) => t + app.segLenOf(i), 0);
  assert.strictEqual(units, 200, "the bars must sum to the clock a click is mapped onto");
});

/* ---------- the SegmentStrip bridge (#128) ----------

   The strip is built in `player/segment-strip.js` and reaches this page through
   `window.ForayPlayer.stripInto`, because app.js is a classic script and cannot
   import a module. That bridge is the seam where the signature element can go
   missing without anything turning red: `player/segment-strip.test.js` proves
   the component, `player/foray-playback.test.js` drives the page through a fake
   bridge that has no `stripInto` at all, and neither of them would notice
   `mountForayStrip` handing over the wrong list — or nothing.

   This harness is the only one in the repo that can reach an app.js internal
   directly, which is why the two tests live here rather than next to the
   component. */

test("mountForayStrip hands the PLAYING QUEUE to the component, not the entry list", () => {
  /* `r.playable` and `r.entries` are different lists the moment a segment fails
     to resolve — `entries` carries the unplayable one so the page can say so.
     A strip built from `entries` draws a bar for audio that never plays, and
     every index after it is off by one against `paintForay`, which walks
     `strip.children[i]` keyed on the QUEUE. The two lists are the same length
     on healthy data, so this is invisible until the day it matters.

     Mutation: `player.stripInto(strip, r.playable, …)` -> `r.entries`. The
     deepStrictEqual below fails on the id list. */
  const calls = [];
  const strip = { id: "fy-strip" };
  const resolved = {
    playable: [{ id: "q#0" }, { id: "q#1" }],
    entries: [{ id: "q#0" }, { id: "q#1" }, { id: "dropped", playable: false }],
  };
  const bridge = { stripInto: (el, items, opts) => calls.push({ el, items, opts }) };

  app.window.ForayPlayer = bridge;
  try {
    withStrip(strip, () => app.mountForayStrip(resolved, bridge));
  } finally {
    delete app.window.ForayPlayer;
  }

  assert.strictEqual(calls.length, 1, "the component was never mounted");
  assert.strictEqual(calls[0].el, strip, "mounted into something other than #fy-strip");
  assert.deepStrictEqual(calls[0].items.map((i) => i.id), ["q#0", "q#1"]);
  assert.strictEqual(calls[0].opts.size, "lg", "the player is the large size (#128)");
});

test("an older cached module costs the show colours, never the strip", () => {
  /* app.js and the ES module are separate cache entries, so a page can run
     against a module with no `stripInto`. The fallback is the sizing this page
     has always done over the bars its own template emitted — a strip with no
     capsules, which is what shipped before #128, rather than an empty bar.

     Mutation: delete the `sizeForayStrip(r)` fallback line in
     `mountForayStrip`. `flexGrow` stays undefined, and the transport renders a
     row of equal 3px slivers on every page paired with an older module. */
  const bars = [
    { style: {}, children: [{ style: {} }] },
    { style: {}, children: [{ style: {} }] },
  ];
  const strip = { id: "fy-strip", children: bars };
  const resolved = {
    playable: [
      { kind: "episode", start_sec: 0, end_sec: 120 },
      { kind: "tts", duration_sec: 40 },
    ],
  };

  withStrip(strip, () => app.mountForayStrip(resolved, { /* older bridge: no stripInto */ }));

  assert.deepStrictEqual(bars.map((b) => b.style.flexGrow), ["120", "40"]);
});

/* ---------- the strip is a scrubber, and #128 changed its geometry ----------

   `stripElapsedAt` used to be `frac * totalSec` over the whole row, which was
   defensible while every bar was separated by the same 2px. #128 spends a wider
   break on a CROSS-episode seam than on a within-episode one, and the seams fall
   where the episodes change rather than evenly along the row, so the error stopped
   cancelling. On `capital-types-1` at a 362px strip the separators are a fifth of
   the width and the flat map lands up to two minutes from the pointer — far enough
   to be a different segment, in a control whose stated contract is "the position
   under the pointer is the position you get".

   The fixture below is the real shape of that: three bars of very different
   lengths with a fat break before the third, i.e. exactly the geometry a flat map
   gets wrong. */

/** Every test below stubs `#fy-strip`; this puts the harness back afterwards so
    a test appended later does not silently inherit a strip fixture. */
function withStrip(strip, fn) {
  const real = app.document.querySelector;
  app.document.querySelector = (sel) => (sel === "#fy-strip" ? strip : null);
  try { return fn(); } finally { app.document.querySelector = real; }
}

function stripFixture(boxes) {
  const bars = boxes.map((box) => ({
    style: {}, children: [{ style: {} }],
    getBoundingClientRect: () => box,
  }));
  return {
    id: "fy-strip", children: bars,
    getBoundingClientRect: () => ({ left: 0, width: 300, top: 0, height: 12 }),
  };
}

test("a click on the strip lands where the pointer is, not where an even row would put it", () => {
  /* 100 s + 100 s + 100 s of audio in bars of 100px, 100px and 60px, with a 40px
     seam before the third — the shape a cross-episode break makes. Clicking the
     middle of the last bar is 250/300 = 83% of the ROW but 50% of the last
     SEGMENT, i.e. 250 s of a 300 s Foray. The flat map answers 250 s only by
     coincidence here, so the case that separates them is the START of that bar:
     the row says 80% (240 s), the bar says the segment begins (200 s).

     Mutation: delete the `stripElapsedFromBars` call in `stripElapsedAt`. The
     first two assertions come back 240 and 270. */
  const strip = stripFixture([
    { left: 0, width: 100 }, { left: 100, width: 100 }, { left: 240, width: 60 },
  ]);
  const r = {
    totalSec: 300,
    playable: [
      { kind: "episode", start_sec: 0, end_sec: 100 },
      { kind: "episode", start_sec: 0, end_sec: 100 },
      { kind: "episode", start_sec: 0, end_sec: 100 },
    ],
  };
  withStrip(strip, () => {
    assert.strictEqual(app.stripElapsedAt({ clientX: 240 }, r), 200, "the third segment starts where its bar does");
    assert.strictEqual(app.stripElapsedAt({ clientX: 270 }, r), 250, "halfway along the last bar is halfway through it");
    // A click inside the seam is the boundary, which is the honest reading of a gap.
    assert.strictEqual(app.stripElapsedAt({ clientX: 220 }, r), 200);
    // Both ends, and past both ends, stay inside the Foray. A scrub that leaves
    // the strip must clamp rather than seek somewhere that does not exist.
    assert.strictEqual(app.stripElapsedAt({ clientX: 0 }, r), 0);
    assert.strictEqual(app.stripElapsedAt({ clientX: -50 }, r), 0);
    assert.strictEqual(app.stripElapsedAt({ clientX: 300 }, r), 300);
    assert.strictEqual(app.stripElapsedAt({ clientX: 9999 }, r), 300);
  });
});

test("bars that cannot report their own geometry fall back to the flat map", () => {
  /* A DOM stub, a strip mid-layout, or a bar count that disagrees with the queue.
     A per-bar answer read off any of those would be wrong WITH CONFIDENCE, and
     the flat map is approximate but never nonsense. This is also what keeps the
     scrub tests in player/foray-playback.test.js meaningful: its stub answers one
     320px box for every element it owns.

     Mutation: drop the `spanned > rect.width + 1` guard in
     `stripElapsedFromBars`. Every overlapping box is then treated as bar 0 and
     the answer collapses to a position inside the first segment — 100 instead
     of 150. */
  const overlapping = stripFixture([
    { left: 0, width: 300 }, { left: 0, width: 300 }, { left: 0, width: 300 },
  ]);
  const r = {
    totalSec: 300,
    playable: [
      { kind: "episode", start_sec: 0, end_sec: 100 },
      { kind: "episode", start_sec: 0, end_sec: 100 },
      { kind: "episode", start_sec: 0, end_sec: 100 },
    ],
  };
  withStrip(overlapping, () => {
    assert.strictEqual(app.stripElapsedAt({ clientX: 150 }, r), 150, "half the row is half the Foray");
    // No coordinate is still null — the caller falls back to the bar that was hit.
    assert.strictEqual(app.stripElapsedAt({}, r), null);
  });

  // And a strip whose bar count no longer matches the queue is not measured either.
  const short = stripFixture([{ left: 0, width: 100 }]);
  withStrip(short, () => {
    assert.strictEqual(app.stripElapsedAt({ clientX: 150 }, r), 150);
  });

  /* Bars in the right ORDER that nonetheless do not fit the strip: a layout that
     has not settled, or content wider than its box. Ordering alone cannot see
     this, which is why the width guard is separate from the overlap guard.

     Mutation: drop `if (spanned > rect.width + 1) return null;`. The boxes below
     are perfectly ordered, so the overlap check waves them through and a click at
     x=150 is read as a position inside bar 0 — 50 instead of 150. */
  const oversized = stripFixture([
    { left: 0, width: 300 }, { left: 300, width: 300 }, { left: 600, width: 300 },
  ]);
  withStrip(oversized, () => {
    assert.strictEqual(app.stripElapsedAt({ clientX: 150 }, r), 150);
  });
});

/* ---------- smoke ----------
   Not a substitute for real render coverage; see the header. This only proves
   the escaping primitives compose the way the render path assumes. */

test("smoke: esc(safeUrl(x)) is the composition used at every href site", () => {
  const hostile = 'javascript:alert(1)"onload="alert(2)';
  const rendered = app.esc(app.safeUrl(hostile));
  assert.strictEqual(rendered, "#");
  assert.ok(!rendered.includes('"'));
});
