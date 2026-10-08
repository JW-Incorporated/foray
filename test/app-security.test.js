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
const { readAppSource, runAppSource } = require("./helpers/app-source.js");
// The href/src census lives in a helper so ui/search.js can be pointed at it too.
const { interpolatedUrlAttrs, unguardedInterpolatedUrlAttrs } = require("./helpers/url-attr-census.js");

const APP_PATH = path.join(__dirname, "..", "app.js");
const SRC = readAppSource();

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
    setAttribute: noop, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
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
  runAppSource(SRC, ctx);
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

test("safeUrl passes exactly the icon sprite's own fragments and refuses every other fragment", () => {
  /* Icon <use href>s go through safeUrl like every other href (third review of
     redesign/tactile-p3-primitives: a second, non-safeUrl guard for sprite
     refs was a breach of the hard limit). So safeUrl passes "#" + a symbol id
     from app.js SPRITE_IDS, verbatim, and nothing else that starts with "#"
     except an in-app route (the next test): not an element id, not an unknown
     or hostile id.
     ui/downloads.js no longer reads "#" as its only refusal (it tests for
     http(s); test/downloads.test.js pins that).
     MUTATION: delete the SPRITE_IDS line from safeUrl -> "#ph-play" comes back
     "#" and the first assertion fails (and every icon would draw nothing).
     MUTATION 2: widen it to `if (/^#[A-Za-z0-9/]/.test(u)) return u;` -> the
     refusals below fail. */
  assert.strictEqual(app.safeUrl("#ph-play"), "#ph-play");
  assert.strictEqual(app.safeUrl("#knob"), "#knob");
  for (const bad of ["#ep-1", "#ph-nope", "#PH-PLAY", "#ph-play ", '#ph-play" onload="x', "##ph-play", "#"]) {
    assert.strictEqual(app.safeUrl(bad), "#", `${bad} is not a sprite symbol`);
  }
});

test("tactileSpriteRef only ever answers a fragment for an id in the sprite list", () => {
  /* Maps an icon id to its fragment before safeUrl gates it; an unknown id
     falls back to the radio glyph rather than an empty icon.
     MUTATION: return `"#" + id` unconditionally in tactileSpriteRef -> the
     hostile ids come back verbatim and this fails. */
  assert.strictEqual(app.tactileSpriteRef("ph-play"), "#ph-play");
  assert.strictEqual(app.tactileSpriteRef("knob"), "#knob");
  for (const bad of ['x" onload="alert(1)', "javascript:alert(1)", "/library", "", null, undefined, "ph-nope"]) {
    assert.strictEqual(app.tactileSpriteRef(bad), "#ph-radio", `${bad} falls back to the known radio glyph`);
  }
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

test("safeUrl passes an in-app route and refuses anything a route cannot be", () => {
  /* An in-app link is "#/" + an encoded path. It goes through safeUrl like every
     other href (no literal-#/ exemption: PLAN.md "Hard limits", and the census
     below), so safeUrl must pass a well-formed route and refuse everything that
     could break out of the attribute or smuggle a scheme.
     MUTATION: delete the route clause from safeUrl -> every route answers "#"
     and the first loop fails (every in-app link would go dead).
     MUTATION 2: widen the route pattern's class to `[^\s]` -> the quote, angle-bracket and
     backtick refusals below fail.
     MUTATION 3: replace `%[0-9A-Fa-f]{2}` with a bare `%` -> "#/a%zz" and the
     unterminated escapes fail. */
  for (const ok of [
    "#/", "#/library", "#/show/abc123", "#/episode/a%2Fb%23c%3Fd%25e", "#/playlist/gen-history%2Ftechnology%22%20onclick%3D%22x",
    "#/episode/javascript%3Aalert(1)", "#/shows/q/sleep%20well", "#/subject/Self-care",
  ]) assert.strictEqual(app.safeUrl(ok), ok, ok + " is a route");
  for (const bad of [
    '#/x" onclick="y', "#/x y", "#/x<script>", "#/x>", "#/x`", "#/x\"", "#/a%zz", "#/a%2", "#/a%", "#/a\nb", "#/a\\b", "#/a#b",
    "#library", "#/ ", "#/a{b}", "#/a|b", "#/a^b",
  ]) {
    assert.strictEqual(app.safeUrl(bad), "#", JSON.stringify(bad) + " is not a route");
  }
  const long = "#/" + "x".repeat(5000);
  assert.strictEqual(app.safeUrl(long), long, "a long route is matched in linear time");
});

test("the census sees an interpolation that does not open the attribute value", () => {
  /* The census must catch every shape that evaded the old opener-only regex.
     MUTATION: make interpolatedUrlAttrs report only values that START with ${
     (the old behaviour) -> the literal-prefix, mid-value, ternary and
     single-quote samples below stop being reported and this fails. */
  const unguarded = [
    'a href="#/${esc(playlistRoute(p))}"',
    'a href="#/episode/${esc(encodeURIComponent(item.id))}"',
    'a href="#/${on ? esc(r) : "playlists"}"',
    "a href='#/${esc(r)}'",
    'a href="${esc(url)}"',
    'img src="/art/${esc(id)}.jpg"',
    'a href="#/show/${encodeURIComponent(id)}" title="${esc(t)}"',
    "a href=${esc(u)}",
  ];
  for (const sample of unguarded) {
    assert.strictEqual(unguardedInterpolatedUrlAttrs(sample).length, 1, "should be flagged: " + sample);
  }
  const fine = [
    'a href="${esc(safeUrl("#/" + playlistRoute(p)))}"',
    'a href="#/library"',
    'a title="${esc(t)}" href="${esc(safeUrl(u))}"',
    'a href="${esc(safeUrl(on ? "#/" + esc(r) : "#/playlists"))}"',
  ];
  for (const sample of fine) {
    assert.deepStrictEqual(unguardedInterpolatedUrlAttrs(sample), [], "should pass: " + sample);
  }
  /* One bad interpolation among guarded ones is still reported. */
  assert.strictEqual(unguardedInterpolatedUrlAttrs('a href="${esc(safeUrl(a))}/${esc(b)}"').length, 1);
});

test("every template or classic-script concatenated href and src passes through safeUrl", () => {
  /* No exemptions: an icon sprite <use href> goes through safeUrl too (third
     review of redesign/tactile-p3-primitives removed the tactileSpriteRef
     exemption this scan used to carry), and so does an in-app "#/" route (review
     of redesign/tactile-search-typing removed the literal-prefix exemption: safeUrl
     now passes a well-formed route, see the route test above).
     MUTATION: replace `esc(safeUrl(tactileSpriteRef(id)))` in tactileIcon with
     `esc(tactileSpriteRef(id))` -> the concatenated <use href> is reported here.
     MUTATION 2: replace `esc(safeUrl(artUrl(d.url, px * 3)))` in tactileArtFrame with
     `esc(artUrl(d.url, px * 3))` -> the concatenated <img src> is reported here.
     MUTATION 3: in ui/search.js change the playlist card's href back to
     `href="#/${esc(playlistRoute(p))}"` -> reported here (the old census missed it). */
  const seen = interpolatedUrlAttrs(SRC);
  const concatenated = SRC.match(/\b(?:href|src)=["'][^"'`\n]*(?:'|")\s*\+\s*[^+\n]+/g) || [];
  assert.ok(seen.length > 0, "expected at least one template href/src to guard");
  assert.ok(concatenated.length > 0, "expected at least one classic-script concatenated href/src to guard");
  const unguarded = [...unguardedInterpolatedUrlAttrs(SRC), ...concatenated.filter((a) => !a.includes("safeUrl("))];
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

/* ---------- the Foray strip's tests are gone with the strip ----------

   `segLenOf`, `mountForayStrip` and `stripElapsedAt` measured and mounted the Foray
   page's scrubbable strip. Tactile `foray` replaced that strip with the Dial band
   (ui/foray.js, drawn by the `tactileBand` primitive, not a scrubber), so the code
   and the tests that pinned it (segLenOf agreeing with `itemRuntimeSec`, the strip
   being handed the playing queue, a click mapped onto the Foray's clock through
   the bars' measured boxes) were removed together. The band's own geometry is held
   by test/tactile-band.test.js and test/tactile-foray.test.js; the clock the
   player maps positions onto is held by player/foray-queue and player/seek-policy. */

/* ---------- smoke ----------
   Not a substitute for real render coverage; see the header. This only proves
   the escaping primitives compose the way the render path assumes. */

test("smoke: esc(safeUrl(x)) is the composition used at every href site", () => {
  const hostile = 'javascript:alert(1)"onload="alert(2)';
  const rendered = app.esc(app.safeUrl(hostile));
  assert.strictEqual(rendered, "#");
  assert.ok(!rendered.includes('"'));
});
