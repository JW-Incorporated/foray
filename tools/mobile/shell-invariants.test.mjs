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
 * ON THE SHAPE OF THESE TESTS. Each of these five is checked through more than
 * one mechanism, because a guard that one edit can satisfy is not a guard. The
 * service-worker rule in particular is asserted by EXECUTING the real `app.js` in
 * six different environments rather than by grepping it: deleting the guard fails
 * some, deleting the registration fails another, and adding a user-agent sniff —
 * the likelier accident than any deletion — fails a third.
 *
 * Where a value is pinned literally (the app id, the size cap, the derivation
 * floor), that is deliberate friction: those are decisions, and changing one
 * should require editing a test and saying why.
 *
 * AN ADVERSARIAL PASS ON 2026-08-17 DEFEATED SIX OF THESE IN ONE EDIT EACH, and
 * every one of those holes is now closed by a named test. Read that list before
 * relaxing anything here, because each entry is a real single-line change that
 * broke real behaviour with the suite green:
 *   - `MAX_BYTES = 30 * 1024 * 1024` — the size cap was only ever compared
 *     against itself. Now pinned.
 *   - `"KeepRunning": 0` — the guard rejected only the literal string `false`,
 *     but Cordova's `Boolean.parseBoolean` reads `0`/`no`/`off` as false too.
 *     Now an allowlist: it must be `true`.
 *   - `img-src 'self'` (dropping `https: data:`) — the new directive was pinned
 *     and the two pre-existing, load-bearing ones were not. Every piece of cover
 *     art and the favicon would have gone blank. Now all three are pinned.
 *   - a `/Android|iPhone/` test inside `shouldRegisterServiceWorker` — the
 *     harness hardcoded `userAgent: "node"`, so a UA sniff that switched the
 *     offline shell off for the entire real audience passed. Now parameterised.
 *   - a bridge whose `isNativePlatform()` THROWS — both signals shared one
 *     `try`, so the guard failed open and registered inside the shell. Fixed in
 *     `app.js`; two tests cover it.
 *   - a second `capacitor.config.json` at the repo root — invariant 2 only ever
 *     looked inside `mobile/`, so `cap add ios` from the root would still land on
 *     the SwiftUI scaffold. Now the whole repo is checked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { MAX_BYTES, MIN_DERIVED_DATA_FILES } from "./prepare-webdir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MOBILE = path.join(ROOT, "mobile");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const rootPkg = readJson(path.join(ROOT, "package.json"));
const capConfig = readJson(path.join(MOBILE, "capacitor.config.json"));

/* ───────────────────────────── 1. the root stays clean ───────────────────── */

for (const field of [
  "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
  /* `workspaces` belongs in this list and is the one that does not look like a
     dependency. Adding `"workspaces": ["mobile"]` here passes every other
     assertion in this section and yet makes a root `npm install` create root
     `node_modules` and a root lockfile — the exact thing the whole section
     exists to prevent. */
  "workspaces",
]) {
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

test("mobile/ is the only place a Capacitor config lives", () => {
  /* Invariant 2 used to resolve `ios.path` against `mobile/` and stop there,
     which meant it could not see a SECOND config elsewhere. A
     `capacitor.config.json` at the repo root — and #36's own text says to run
     `npx cap add ios`, which people run from the root — generates into
     `<root>/ios`, straight on top of the SwiftUI scaffold, with the old test
     green. `ios/project.yml` declares `sources: - path: App`, so XcodeGen would
     then absorb Capacitor's generated `ios/App/` tree into the SwiftUI target.

     THIS TEST WENT RED THE MOMENT A PLATFORM WAS GENERATED, on the one machine
     doing the work. `cap copy` writes a COPY of the config into each platform's
     native bundle (`@capacitor/cli`'s `tasks/copy.js` → `copyCapacitorConfig`), so
     `npm run add:android` alone made the walk return two paths and failed a green
     suite for doing exactly what `mobile/README.md` instructs (issue #37).

     The generated platforms are therefore skipped, and their paths are DERIVED
     from the real config's own `ios.path`/`android.path` rather than hardcoded, so
     the skip cannot drift onto a directory this config does not own. Nothing about
     the hazard is lost: the failure this guards is a config somewhere `cap` would
     pick it up as a PROJECT root — the repo root above all — and a copy inside a
     platform's own tree is never read that way. The next test is what keeps the
     skip honest. */
  const generatedPlatforms = new Set(
    ["ios", "android"].map((p) => path.resolve(MOBILE, capConfig[p]?.path ?? p))
  );
  const configs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "www" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!generatedPlatforms.has(full)) walk(full);
      } else if (/^capacitor\.config\.(json|ts|js)$/.test(e.name)) {
        configs.push(path.relative(ROOT, full));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(
    configs.map((p) => p.split(path.sep).join("/")),
    ["mobile/capacitor.config.json"],
    "A Capacitor config outside mobile/ makes `cap` generate somewhere nobody checked."
  );
});

test("both generated platforms are gitignored in full, which is what makes skipping them safe", () => {
  /* The skip above is only honest while those two directories can never hold a
     COMMITTED file. Ignoring them in full is a decision (issue #37: the platforms
     are regenerated by `npm run add:android` / `add:ios`, never committed — ~100
     generated files with no reviewer, in a directory that auto-merges), and this is
     the assertion that ties the two halves together: relax the ignore rule and this
     test says so, rather than the walk silently starting to skip real files.

     Asserted against the ignore FILE rather than by shelling out to `git`, so it
     behaves identically in a worktree, a shallow clone and CI. */
  const lines = fs.readFileSync(path.join(MOBILE, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
  for (const dir of ["ios", "android"]) {
    assert.ok(
      lines.includes(`${dir}/`) || lines.includes(`/${dir}/`),
      `mobile/.gitignore does not ignore ${dir}/ in full. The "only one Capacitor config" test ` +
        `skips that directory, so anything committed inside it would be skipped too. Either restore ` +
        `the ignore rule or narrow that skip — and if the repo has decided to commit the generated ` +
        `platform after all, say so here and in docs/mobile-shell.md §0.`
    );
  }
});

test("the repo's ios/ contains no Capacitor output", () => {
  /* The direct check on the thing that actually goes wrong, rather than only on
     the config that would cause it. */
  for (const artefact of ["App/App", "App/Podfile", "App/App.xcodeproj", "capacitor.config.json", "App/App/public"]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, "ios", artefact)),
      false,
      `ios/${artefact} exists — Capacitor has generated into the SwiftUI scaffold's directory.`
    );
  }
});

test("the webDir size cap is pinned at 3 MB", () => {
  /* WITHOUT THIS, THE CAP GUARDS NOTHING. The only test of today's bundle
     compares it against MAX_BYTES, so raising MAX_BYTES satisfies both sides of
     the comparison: `30 * 1024 * 1024` left the whole suite green while opening
     the bundle to the 16 MB classification file. A cap compared only against
     itself is not a cap. */
  assert.equal(MAX_BYTES, 3 * 1024 * 1024);
});

test("the derivation floor is pinned at 6 files", () => {
  /* Same self-referential shape: prepare-webdir only fails when FEWER than
     MIN_DERIVED_DATA_FILES files are derived, so lowering it to 1 would let a
     bundle with one data file build and pass. app.js fetches 9 today. */
  assert.equal(MIN_DERIVED_DATA_FILES, 6);
});

/* ─────────── 3. the service worker: off in the shell, on in the web ──────── */

const APP_SRC = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/** Evaluate the REAL app.js the way a page does, and report whether it tried to
 *  register the service worker. `init()` suspends on its first await because
 *  `fetch` never settles (the same trick player/foray-playback.test.js uses), so
 *  nothing beyond the top-level statements runs. */
function runAppShell({ capacitor = undefined, protocol = "https:", userAgent = "node" } = {}) {
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
      userAgent,
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

test("a phone browsing the real website still gets the offline shell", () => {
  /* THE LIKELIEST ACCIDENT, and the one the original suite could not see because
     it hardcoded `userAgent: "node"`. Someone debugging the Android shell adds
     `if (/Android|iPhone/.test(navigator.userAgent)) return false;` — every other
     service-worker test stays green, and the offline shell is switched off for
     essentially the entire real audience of a commute product, whose founding
     constraint is "sessions survive cell dead zones". */
  for (const ua of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36",
  ]) {
    const { registered } = runAppShell({ userAgent: ua });
    assert.deepEqual(registered, ["sw.js"], `a mobile web browser (${ua.slice(0, 24)}…) lost the offline shell`);
  }
});

test("a bridge that throws still suppresses the service worker on the iOS origin", () => {
  /* THE FAIL-OPEN CASE. Both signals used to live in one `try`, so an
     `isNativePlatform()` that threw skipped the origin check as well and
     registered the worker inside the shell — precisely the case the origin check
     was written to cover. A bridge can throw: it may not be ready, and a
     plugin-proxy getter is somebody else's code. */
  const throwing = { isNativePlatform: () => { throw new Error("bridge not ready"); } };
  const { registered } = runAppShell({ capacitor: throwing, protocol: "capacitor:" });
  assert.deepEqual(registered, [], "a throwing bridge let sw.js register inside the iOS shell");
});

test("a bridge that throws on an https origin degrades to the web answer", () => {
  /* The other half, stated so the behaviour is a decision and not an accident:
     with no usable native signal and an ordinary web origin, registering is the
     right answer. This is Android's shell, where the origin is
     `https://localhost` and indistinguishable from the web — which is exactly why
     `window.Capacitor` must survive there. See docs/mobile-shell.md § the open
     risk on CSP and Capacitor's injected bridge. */
  const throwing = { isNativePlatform: () => { throw new Error("bridge not ready"); } };
  const { registered } = runAppShell({ capacitor: throwing, protocol: "https:" });
  assert.deepEqual(registered, ["sw.js"]);
});

test("app.js is the only file in the bundle that registers a service worker", () => {
  /* All the tests above execute app.js, so a `register()` added anywhere ELSE in
     the bundle — player/client.js and search-engine.js both ship — would put a
     service worker in the shell with every one of them green. */
  const offenders = [];
  const bundled = ["search-engine.js", ...fs.readdirSync(path.join(ROOT, "player"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map((f) => `player/${f}`)];
  for (const rel of bundled) {
    if (/serviceWorker\s*\.\s*register|serviceWorker\[/.test(fs.readFileSync(path.join(ROOT, rel), "utf8"))) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], "registration must stay in app.js, behind shouldRegisterServiceWorker()");
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
     `cordova.preferences.KeepRunning` and any other nesting are all covered.

     AN ALLOWLIST, NOT A DENYLIST, and that distinction was a real hole: the first
     version rejected `false` and the string `"false"`, but Cordova reads the
     preference with `Boolean.parseBoolean`, which returns false for ANYTHING that
     is not "true" — so `"KeepRunning": 0` disabled every out-point in the app with
     this test green. Requiring `true` cannot be out-guessed that way. */
  for (const hit of findKeepRunning(capConfig)) {
    assert.ok(
      hit.value === true || String(hit.value).toLowerCase() === "true",
      `${hit.where} is ${JSON.stringify(hit.value)} in mobile/capacitor.config.json. Cordova reads ` +
        `this with Boolean.parseBoolean, so anything other than true is FALSE, and false calls the ` +
        `process-global pauseTimers() — every JavaScript out-point in the app stops firing. ` +
        `See docs/mobile-shell.md § footguns.`
    );
  }
});

test("no generated native config re-enables the KeepRunning footgun", () => {
  /* Arms for later: `cap add` generates a Cordova-compat `config.xml` in each
     platform, and THAT is the file someone would edit to "save battery".
     Nothing matches today because no platform is generated.
     `mobile/.gitignore` deliberately does NOT ignore the Android
     `res/xml/config.xml` that Capacitor's own template ignores — this test is why:
     an ignored file cannot be checked, and the first version of this test walked
     for a filename its own sibling ignore rule guaranteed would never be there.

     Reads the PREFERENCE, rather than asking whether the words "KeepRunning" and
     "false" both appear somewhere in the file. Capacitor generates several
     unrelated `value="false"` preferences, so the loose version was a false
     positive waiting to happen AND never actually checked the value. */
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "www" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "config.xml") found.push(full);
    }
  };
  walk(MOBILE);
  for (const f of found) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/<preference\s+name="([^"]*)"\s+value="([^"]*)"/gi)) {
      if (!/^keeprunning$/i.test(m[1])) continue;
      assert.ok(
        m[2].toLowerCase() === "true",
        `${path.relative(ROOT, f)} sets KeepRunning="${m[2]}". Cordova parses anything but "true" ` +
          `as false, which calls the process-global pauseTimers() and stops every out-point.`
      );
    }
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

test("img-src still allows remote artwork and the data: favicon", () => {
  /* PINNED IN BOTH DIRECTIONS, because the first version of this suite pinned
     only the token it had just added. Narrowing `img-src 'self' https: data:` to
     `img-src 'self'` left every test in the repo green while blanking every piece
     of cover art on the site and in the app: app.js renders remote artwork from
     ~41 podcast CDNs, and index.html's favicon is a data: URI. A guard that
     protects only the newest change is how the older, load-bearing thing dies. */
  const csp = cspDirectives();
  for (const src of ["'self'", "https:", "data:"]) {
    assert.ok(csp["img-src"]?.includes(src), `img-src lost ${src}`);
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
