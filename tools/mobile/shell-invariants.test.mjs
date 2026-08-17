/* The native shell's invariants (issue #36, MP2).
 *
 * Five things this repo would silently break, and what each costs:
 *
 *   1. THE ROOT STAYS DEPENDENCY-FREE WITH NO BUILD STEP. That property is what
 *      lets the keyless Action deploy the static site from `main`'s root. A
 *      dependency at the root is not a style violation; it is a broken deploy.
 *   2. THE GENERATED iOS PROJECT MUST NOT COLLIDE WITH `ios/`. The repo already
 *      has a SwiftUI scaffold + ForayKit at `ios/`, and CI's `ios-kit` job runs
 *      `swift test --package-path ios/ForayKit`. Capacitor's DEFAULT output path
 *      is `ios`. Two iOS codebases in one directory is the failure this scaffold
 *      exists to avoid.
 *   3. THE SERVICE WORKER MUST NOT REGISTER IN THE SHELL — and must still
 *      register on the web. A cache-first worker in front of local files is the
 *      "app won't update after a store release" bug.
 *   4. `KeepRunning` MUST NEVER BE `false`. It calls the process-global
 *      `WebView.pauseTimers()`, which stops every JavaScript out-point firing.
 *      A missed out-point is a 936.5 s median overrun — 15.6 minutes of the
 *      wrong episode (`docs/research/mp1-background-audio.md` §3).
 *   5. THE CSP MUST COVER THE APP'S OWN BUNDLE. The iOS shell's origin is
 *      `capacitor://localhost`, which matches neither `https:` nor `data:`.
 *
 * ON THE SHAPE OF THESE TESTS. Three of these five are checked through more than
 * one mechanism, because a guard that one edit can satisfy is not a guard. The
 * service-worker rule in particular is asserted by EXECUTING the real `app.js`
 * in three different environments rather than by grepping it: deleting the guard
 * fails two of them, deleting the registration fails the third, and there is no
 * single line whose removal leaves all three green. Where a value is pinned
 * literally (the app id, the size cap), that is deliberate friction — those are
 * decisions, and changing one should require editing a test and saying why.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MOBILE = path.join(ROOT, "mobile");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const rootPkg = readJson(path.join(ROOT, "package.json"));
const capConfig = readJson(path.join(MOBILE, "capacitor.config.json"));

/* ───────────────────────────── 1. the root stays clean ───────────────────── */

for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  test(`root package.json declares no ${field}`, () => {
    const got = Object.keys(rootPkg[field] || {});
    assert.deepEqual(
      got,
      [],
      `The repo root must stay dependency-free — it is what lets GitHub Pages deploy ` +
        `the static site from main's root with no build. Found ${field}: ${got.join(", ")}. ` +
        `Dependencies belong in a directory that owns them (mobile/, backend/, tools/corpus/).`
    );
  });
}

test("root package.json has no build step and no install-time lifecycle script", () => {
  /* Deliberately an exact allowlist rather than a denylist of known-bad names.
     A denylist has to predict `prepare`, `prepack`, `postinstall`, `preinstall`,
     `prepublishOnly` and whatever npm adds next; this cannot be out-guessed.
     Widening it is a one-line edit — but a VISIBLE one, in a PR, which is the
     whole point. */
  assert.deepEqual(
    Object.keys(rootPkg.scripts || {}).sort(),
    ["test"],
    `The root may only carry the convenience test script. Anything else — a build, ` +
      `or any npm lifecycle hook — reintroduces a root build step. The native bundle's ` +
      `build lives in mobile/ and in tools/mobile/prepare-webdir.mjs.`
  );
});

test("no lockfile or node_modules at the repo root", () => {
  for (const f of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "node_modules"]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, f)),
      false,
      `${f} exists at the repo root. A root lockfile means root dependencies, and ` +
        `node_modules at the root would be served by Pages.`
    );
  }
});

test("the Capacitor project keeps its dependencies inside mobile/", () => {
  const deps = Object.keys(capPkg().dependencies || {});
  assert.ok(deps.length > 0, "mobile/package.json should declare the Capacitor deps");
  for (const d of deps) {
    assert.ok(
      d.startsWith("@capacitor/"),
      `Unexpected dependency ${d} in mobile/. Anything beyond Capacitor itself deserves ` +
        `a line in docs/mobile-shell.md saying why the shell needs it.`
    );
  }
});

function capPkg() {
  return readJson(path.join(MOBILE, "package.json"));
}

/* ─────────────────────── 2. no second iOS codebase, ever ─────────────────── */

test("the generated iOS project cannot land on top of the repo's ios/ scaffold", () => {
  /* Capacitor resolves ios.path/android.path relative to the directory holding
     capacitor.config.json — mobile/ — so the default `ios` already means
     mobile/ios. It is written out explicitly anyway, because the cost of getting
     this wrong is two iOS codebases in one directory and the default is the
     dangerous value. */
  const iosPath = path.resolve(MOBILE, capConfig.ios?.path ?? "ios");
  const androidPath = path.resolve(MOBILE, capConfig.android?.path ?? "android");
  const repoIos = path.resolve(ROOT, "ios");

  assert.notEqual(iosPath, repoIos, "capacitor.config.json's ios.path resolves to the repo's ios/ scaffold.");
  for (const [name, p] of [["ios.path", iosPath], ["android.path", androidPath]]) {
    const rel = path.relative(MOBILE, p);
    assert.ok(
      rel && !rel.startsWith("..") && !path.isAbsolute(rel),
      `${name} resolves to ${p}, which is outside mobile/. Everything Capacitor generates ` +
        `must stay in mobile/ so the repo has exactly one native-iOS build target.`
    );
  }
});

test("the SwiftUI scaffold and ForayKit are still intact at ios/", () => {
  /* CI's `ios-kit` job runs `swift test --package-path ios/ForayKit`, and #28/#33
     reference this tree as their design source. If a future `cap add ios` is ever
     pointed at the repo root, this is what notices. */
  for (const f of [
    "ios/ForayKit/Package.swift",
    "ios/ForayKit/Sources/ForayKit/PlayerQueueState.swift",
    "ios/ForayKit/Sources/ForayKit/IntentGrammar.swift",
    "ios/project.yml",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing — CI's ios-kit job runs against this tree.`);
  }
  const proj = fs.readFileSync(path.join(ROOT, "ios", "project.yml"), "utf8");
  assert.ok(
    !/capacitor/i.test(proj),
    "ios/project.yml mentions Capacitor. The XcodeGen scaffold and the Capacitor shell are " +
      "separate projects; if they are being merged, that is a founder decision, not a config edit."
  );
});

test("the app id is pinned, because it is permanent once published", () => {
  /* Changing the bundle id after a store release means a NEW listing and a lost
     install base. This assertion is not doing engineering work — it is making
     the change impossible to do by accident. If a founder rules differently,
     edit this line in the same PR. */
  assert.equal(capConfig.appId, "com.jwincorporated.foray");
  assert.equal(capConfig.appName, "Foray");
});

/* ─────────── 3. the service worker: off in the shell, on in the web ──────── */

const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/** Evaluate the REAL app.js the way a page does, and report whether it tried to
 *  register the service worker. `init()` suspends on its first await because
 *  `fetch` never settles (the same trick player/foray-playback.test.js uses), so
 *  nothing beyond the top-level statements runs. */
function runAppShell({ capacitor = undefined, protocol = "https:" } = {}) {
  const registered = [];
  const store = new Map();

  /* Any property, any depth, callable — so app.js cannot fail this harness by
     touching a DOM member nobody predicted. `navigator` is NOT built this way:
     app.js asks `"serviceWorker" in navigator`, and a proxy that answers `has`
     with true would make that question meaningless. */
  const auto = () => new Proxy(function () {}, {
    get: (_t, p) => (p === "then" || p === Symbol.toPrimitive || p === Symbol.iterator ? undefined : auto()),
    set: () => true,
    apply: () => auto(),
  });

  const ctx = {
    console: { ...console, log() {}, warn() {}, error() {} },
    fetch: () => new Promise(() => {}),
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: {
      userAgent: "node",
      serviceWorker: { register: (p) => { registered.push(p); return Promise.resolve(); } },
    },
    location: { protocol, hash: "#/", search: "", pathname: "/", href: `${protocol}//x.test/` },
    document: {
      body: auto(), documentElement: auto(),
      addEventListener() {}, createElement: () => auto(),
      querySelector: () => auto(), querySelectorAll: () => [],
    },
    history: { replaceState() {}, pushState() {} },
    addEventListener() {},
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, Math, Date, JSON, Promise, clearTimeout,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    encodeURIComponent, decodeURIComponent,
  };
  if (capacitor !== undefined) ctx.Capacitor = capacitor;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP_SRC, ctx, { filename: "app.js" });
  return { registered, ctx };
}

test("on the web, app.js still registers the service worker", () => {
  /* The direction that is easy to lose by over-tightening the guard. Without
     this test, "never register" would pass every other assertion here and the
     offline shell — the founding "sessions survive cell dead zones" constraint —
     would be silently gone from the website. */
  const { registered } = runAppShell();
  assert.deepEqual(registered, ["sw.js"]);
});

test("inside the Capacitor shell, app.js does not register the service worker", () => {
  const { registered } = runAppShell({ capacitor: { isNativePlatform: () => true } });
  assert.deepEqual(registered, [], "sw.js was registered inside the native shell.");
});

test("the capacitor:// origin alone is enough to suppress the service worker", () => {
  /* Second, independent signal. If `window.Capacitor` is ever absent or injected
     late on iOS, the origin still gives the right answer. */
  const { registered } = runAppShell({ protocol: "capacitor:" });
  assert.deepEqual(registered, []);
});

test("a Capacitor bridge reporting the web platform still gets a service worker", () => {
  /* `isNativePlatform()` is false when Capacitor's own web target is in use.
     Treating "window.Capacitor exists" as "we are native" would be wrong here,
     and this is the case that tells the two apart. */
  const { registered } = runAppShell({ capacitor: { isNativePlatform: () => false } });
  assert.deepEqual(registered, ["sw.js"]);
});

test("sw.js is still served to the web and still cache-first for the shell", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert.match(sw, /const CACHE = "foray-v\d+"/, "sw.js lost its versioned cache name.");
});

/* ────────────────────────── 4. the KeepRunning footgun ───────────────────── */

/** Every `KeepRunning`-ish key anywhere in a parsed config, at any depth. */
function findKeepRunning(node, trail = "") {
  const hits = [];
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const where = trail ? `${trail}.${k}` : k;
      if (/^keeprunning$/i.test(k)) hits.push({ where, value: v });
      hits.push(...findKeepRunning(v, where));
    }
  }
  return hits;
}

test("no Capacitor config sets KeepRunning to false", () => {
  /* THE ONE-LINE FOOTGUN. `Bridge.java:457` reads `KeepRunning` (default true);
     when false, `MockCordovaWebViewImpl.setPaused(true)` calls
     `webView.pauseTimers()`, which Android documents as global, "not restricted
     to just this WebView". Every out-point in the app would stop firing on every
     backgrounding, and the app would still play audio — so it would look fine
     and deliver 15 minutes of the wrong episode.
     Checked on the PARSED config, at any depth, case-insensitively, so
     `cordova.preferences.KeepRunning` and any other nesting are all covered. */
  for (const hit of findKeepRunning(capConfig)) {
    assert.notEqual(
      hit.value === false || String(hit.value).toLowerCase() === "false",
      true,
      `${hit.where} is false in mobile/capacitor.config.json. See docs/mobile-shell.md — ` +
        `this disables every JavaScript out-point in the app.`
    );
  }
});

test("no generated native config re-enables the KeepRunning footgun", () => {
  /* Arms for later: `cap add` generates a Cordova-compat `config.xml` in each
     platform, and THAT is the file someone would edit to "save battery". Nothing
     matches today because no platform is generated; this test is what makes that
     no longer true the day one is. */
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "www" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "config.xml" || /^capacitor\.config\.(json|ts|js)$/.test(e.name)) found.push(full);
    }
  };
  walk(MOBILE);
  for (const f of found) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(
      !/KeepRunning/i.test(src) || !/false/i.test(src),
      `${path.relative(ROOT, f)} mentions KeepRunning and false. Verify it is not being ` +
        `set false — that calls the process-global pauseTimers().`
    );
  }
});

/* ───────────────────────────────── 5. the CSP ────────────────────────────── */

const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

function cspDirectives() {
  const m = INDEX.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, "index.html has no Content-Security-Policy meta tag.");
  const out = {};
  for (const part of m[1].split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name] = vals;
  }
  return out;
}

test("the CSP lets the app load its own bundled assets", () => {
  const csp = cspDirectives();
  /* The iOS shell's origin is `capacitor://localhost` — a custom scheme, which
     WKWebView requires because you cannot register a handler for https. So a
     directive whose only source is `https:` blocks the app's OWN files there,
     while working perfectly on the web and on Android (`https://localhost`).
     img-src was exactly that, and the icons would have failed on iOS only. */
  for (const dir of ["script-src", "style-src", "img-src", "manifest-src"]) {
    assert.ok(
      csp[dir]?.includes("'self'"),
      `${dir} must include 'self' or the native shell cannot load its own bundle ` +
        `(origin capacitor://localhost matches neither https: nor data:).`
    );
  }
});

test("media-src is present, so audio does not fall back to default-src 'none'", () => {
  /* #24's regression, kept pinned: with `default-src 'none'` and no media-src,
     every <audio> load is blocked outright and the player is dead. */
  const csp = cspDirectives();
  assert.deepEqual(csp["default-src"], ["'none'"]);
  assert.ok(csp["media-src"]?.includes("https:"), "media-src must allow https: episode audio.");
});

test("the CSP still forbids inline script and style", () => {
  const csp = cspDirectives();
  const all = Object.values(csp).flat().join(" ");
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]) {
    assert.ok(!all.includes(bad), `${bad} appeared in the CSP. Never, in the shell or on the web.`);
  }
});

test("every locally-referenced asset in index.html is same-origin loadable", () => {
  /* Mechanical rather than a fixed list: pull the local hrefs/srcs out of the
     real markup and check the directive that governs each one. A future
     `<img src="hero.png">` is covered without anyone remembering to add it. */
  const csp = cspDirectives();
  const governs = { css: "style-src", js: "script-src", png: "img-src", jpg: "img-src", svg: "img-src", webmanifest: "manifest-src", json: "manifest-src" };
  const refs = [...INDEX.matchAll(/(?:href|src)="([^"#:]+\.[a-z]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4, "found suspiciously few local asset references in index.html");
  for (const ref of refs) {
    const ext = ref.split(".").pop().toLowerCase();
    const dir = governs[ext];
    if (!dir) continue;
    assert.ok(
      csp[dir]?.includes("'self'"),
      `${ref} is a local asset governed by ${dir}, which does not allow 'self'.`
    );
  }
});
