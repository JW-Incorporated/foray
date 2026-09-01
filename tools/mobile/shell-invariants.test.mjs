/* The native shell's invariants (issue #36, MP2).
 *
 * Six things this repo would silently break, and what each costs:
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
 *   6. ANDROID'S HAND-WRITTEN NATIVE CODE MUST BE COMMITTED, AND THE GENERATED
 *      PLATFORM MUST NOT BE. Android needs native code — no `navigator.mediaSession`
 *      at any price, and a `mediaPlayback` foreground service for backgrounded
 *      playback — and #37 left it nowhere to live. It now lives in
 *      `mobile/plugins/foray-audio/`. The failure mode is quiet in both directions:
 *      an over-broad ignore rule drops the .java files from the repo while the
 *      machine that built the APK still has them, and a plugin name that disagrees
 *      with the Java's annotation means the service is simply never started.
 *      Section 6, and docs/android-native-code.md. Since the 2026-08-25 package
 *      rename that section ALSO pins the four places the Java package is named
 *      (the `package` line, the source layout, the Gradle `namespace` and the
 *      manifest's service class), because three of those four could previously be
 *      read only by a real Gradle build on a machine with an Android SDK.
 *
 * ONE EXCEPTION TO THAT, since #37, and it is stated here so the header does not
 * over-promise: `KeepRunning`'s SECOND mechanism — parsing the generated Cordova
 * `config.xml` — is live only on a machine that has generated a platform, because
 * `mobile/android/` and `mobile/ios/` are now regenerated rather than committed. In
 * CI it matches nothing. The reasoning, and why the vector went away with the file,
 * is on that test and in `docs/android-shell-build.md` §1.5.
 *
 * ON THE SHAPE OF THESE TESTS. Each of these five is checked through more than
 * one mechanism, because a guard that one edit can satisfy is not a guard. The
 * service-worker rule in particular is asserted by EXECUTING the real `app.js` in
 * six different environments rather than by grepping it: deleting the guard fails
 * some, deleting the registration fails another, and adding a user-agent sniff —
 * the likelier accident than any deletion — fails a third.
 *
 * Where a value is pinned literally (the app id, the size cap, the derivation
 * floor, the catalogue slice's per-file budgets), that is deliberate friction:
 * those are decisions, and changing one should require editing a test and saying
 * why.
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
 *     art would have gone blank. Now all three are pinned. (`data:` was there
 *     for the favicon when this was written. The favicon is icon-180.png since
 *     the logo landed, and `data:` is held up by media-session artwork now.)
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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  MAX_BYTES, MIN_DERIVED_DATA_FILES, PROJECTED_DATA, BUNDLED_ITEMS_PER_SHOW,
  discoverSlice, assertDiscoverSliceComplete, sliceBytes,
  referencedSegmentIds, segmentSlice, segmentSourceSlice, assertForaySliceComplete,
} from "./prepare-webdir.mjs";
import { artworkUrlsByShow, collectionIdsByShow } from "../../player/foray-sources.js";
import { hydrateForayItems, indexSegments, indexSources } from "../../player/foray-resolve.js";
import { PLUGIN_NAME } from "../../mobile/plugins/foray-audio/web/foray-audio-shell.js";
import {
  PLUGIN_NAME as MEDIA_PLUGIN_NAME, SET_METHOD, TRANSPORT_EVENT, ROUTABLE_ACTIONS,
} from "../../mobile/plugins/foray-audio/web/foray-media-session.js";

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

/* THE "only @capacitor/* dependencies" TEST USED TO LIVE HERE, and it has moved to
   section 6 rather than been deleted — see "mobile/'s only non-Capacitor dependency
   is our own plugin". It fired for real when `foray-audio` was added, which is what
   it was for; its failure message asked for a line in the docs saying why, and it
   got one. What it protects (no third-party JavaScript in the shell) is intact and
   is now checked more precisely: a non-Capacitor entry must be a `file:` path
   resolving inside `mobile/`, and every `@capacitor/*` entry must still be a
   registry range. Left as a pointer because a reader looking for this rule will look
   here first. */

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
  assert.equal(capConfig.appId, "ai.jwlabs.foura");
  /* `appName` is NOT in the same class and this test used to imply it was. The
     bundle id is permanent once published; the display name is just the label
     under the icon and can change any time. The app was renamed to **4a** on
     2026-08-21 (founder instruction) while the bundle id was deliberately left
     alone — renaming that WOULD cost the listing and the install base, and it is
     still the open ruling in HUMAN-ACTIONS #15. Keeping the id on `foray` is the
     correct outcome, not an oversight. */
  assert.equal(capConfig.appName, "4a");
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

test("nothing under either generated platform is TRACKED, which is what makes skipping them safe", () => {
  /* The skip above is only honest while those two directories hold no COMMITTED
     file. Not committing them is a decision (issue #37: the platforms are
     regenerated by `npm run add:android` / `add:ios` — ~100 generated files with no
     reviewer, in a tree `cap add` rewrites), and this is the assertion that ties
     the two halves together.

     ASSERTED ON THE INDEX, NOT ON `.gitignore`, and the first version of this test
     got that wrong in a way worth recording. It checked that `mobile/.gitignore`
     contained the literal line `android/`, on the reasoning that an ignored
     directory "can never hold a committed file". An ignore RULE does not give you
     that, and a reviewer defeated it two ways in one edit each:
       - appending `!android/` re-includes the directory while the literal line it
         looked for is still present, so the test stayed green while the walk skipped
         a directory that now holds tracked files;
       - `git add -f mobile/android/local.properties` succeeds regardless of any
         rule, and an already-tracked file keeps being tracked no matter what is
         added to `.gitignore`.
     It also failed on `ios`, `/ios` and `ios/**`, all of which ignore the directory
     perfectly well — over-strict in one direction and defeatable in the other.

     `git ls-files` is the actual invariant and has none of those problems. It reads
     the INDEX, so it is not fooled by negations, force-adds or pattern spelling, and
     being index-only it behaves identically in a worktree, a shallow clone and CI —
     which was the stated reason the first version avoided git, and does not apply
     here.

     THE PLATFORM PATHS COME FROM THE SAME PLACE THE SKIP DOES — `capacitor.config.json`
     — and not from a second hardcoded pair, because that is how the two halves
     drift: rename `android.path` and a hardcoded test keeps checking the old name,
     still passes, and leaves the walk skipping a directory nothing asserts is
     untracked. */
  const targets = ["ios", "android"].map((p) => ({
    platform: p,
    rel: `mobile/${(capConfig[p]?.path ?? p).replace(/\\/g, "/").replace(/\/+$/, "")}`,
  }));

  const res = spawnSync("git", ["ls-files", "--", ...targets.map((t) => t.rel)], {
    cwd: ROOT,
    encoding: "utf8",
  });

  /* A missing git, or a source tree that is not a checkout, must fail loudly rather
     than skip. A guard that silently passes when it could not look is the shape of
     bug this whole file exists to prevent. */
  assert.equal(
    res.status,
    0,
    `could not read the git index (${res.error?.message ?? res.stderr?.trim() ?? `exit ${res.status}`}). ` +
      `This invariant is about what is COMMITTED, so it cannot be checked without one.`
  );

  const tracked = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(
    tracked,
    [],
    `these files under a generated native platform are tracked by git:\n  ${tracked.join("\n  ")}\n` +
      `The "only one Capacitor config" test SKIPS those directories, so anything committed inside ` +
      `them is skipped too. Either stop tracking them, or narrow that skip — and if the repo has ` +
      `decided to commit the generated platform after all, say so in mobile/.gitignore and in ` +
      `docs/mobile-shell.md §0, and revisit what the skip is hiding.`
  );
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

test("the sliced files' per-file budgets are pinned, all three of them", () => {
  /* THE THIRD INSTANCE OF THE SAME SELF-REFERENTIAL SHAPE, added with the budgets
     themselves rather than after somebody defeated them. `prepare-webdir` only fails
     when a slice EXCEEDS its own `maxBytes`, so raising `maxBytes` satisfies both
     sides of the comparison — the identical hole that `MAX_BYTES = 30 * 1024 * 1024`
     opened in the size cap.

     These numbers are the tight alarm for a slice having stopped being bounded,
     which the 3 MB cap is too loose to notice quickly: the whole bundle is 2.10 MB.
     Raising one is a decision, and it should cost an edit here and a sentence about
     what the new number guards.

     THEY MEAN TWO DIFFERENT THINGS, which is why they are pinned as a table rather
     than as one constant. `data/discover.json`'s budget watches CATALOGUE growth,
     which the nightly refresh causes whether or not anybody decided anything. The
     two Foray documents' budgets watch PRODUCT growth: a new Foray is a deliberate
     act, so they sit further above today's number — about four more Forays the size
     of today's three combined — but they must still fire long before the segment
     pool's unbounded growth could get back into the bundle (#327). */
  assert.deepEqual(PROJECTED_DATA.map((p) => [p.rel, p.maxBytes]), [
    ["data/discover.json", 800 * 1024],
    ["data/segments.json", 100 * 1024],
    ["data/segment-sources.json", 40 * 1024],
  ]);
  /* And the knob is a small integer, not a number large enough to make the slice the
     whole catalogue again. */
  assert.ok(Number.isInteger(BUNDLED_ITEMS_PER_SHOW) && BUNDLED_ITEMS_PER_SHOW >= 1);
  assert.ok(BUNDLED_ITEMS_PER_SHOW <= 6, "a per-show cap this high is not a bounded slice any more");
});

test("the bundled segment slice is exactly what today's Forays reference, and the join agrees", () => {
  /* DELIBERATELY A SECOND, INDEPENDENT SUITE, for the same reason the catalogue slice
     has one below: `prepare-webdir.test.mjs` covers this in detail against a fixture,
     and this asserts it against TODAY'S REAL documents, from the file that owns the
     shell's invariants. The failure it guards is invisible — a Foray that opens in
     the app and resolves to an empty running order, playing fine on the website. */
  const forays = readJson(path.join(ROOT, "data", "forays.json"));
  const segments = readJson(path.join(ROOT, "data", "segments.json"));
  const sources = readJson(path.join(ROOT, "data", "segment-sources.json"));

  const slice = segmentSlice(segments, forays);
  const srcSlice = segmentSourceSlice(sources, segments, forays);

  /* It really is slicing the real documents, or nothing below means anything. */
  assert.ok(segments.segments.length > slice.segments.length, "the slice is not slicing the real pool");
  assert.ok(sources.sources.length > srcSlice.sources.length, "the slice is not slicing the real registry");

  /* EXACTLY the referenced set — no top-up, because nothing in the app browses the
     pool. `discover.json` needs one only because app.js routes #/subject/<topic> off
     it; a segment's `topic` has no such reader. */
  const referenced = referencedSegmentIds(forays);
  assert.ok(referenced.size > 0, "today's Forays reference no segments at all");
  assert.deepEqual(new Set(slice.segments.map((s) => s.id)), referenced);

  assert.equal(
    assertForaySliceComplete(forays, { segments, sources }, { segments: slice, sources: srcSlice }),
    true
  );
  /* Re-asserted here directly rather than only through that call, so deleting the
     join re-run inside the guard fails in two suites. */
  const hydrate = (docs) =>
    forays.forays.map((f) =>
      hydrateForayItems(f, { segments: indexSegments(docs.segments), sources: indexSources(docs.sources) })
    );
  const before = hydrate({ segments, sources });
  const played = before.reduce((n, h) => n + h.items.filter((i) => i.type === "segment").length, 0);
  assert.ok(played >= 50, `the real documents resolve to only ${played} segment entries — the comparison is vacuous`);
  assert.deepEqual(hydrate({ segments: slice, sources: srcSlice }), before);

  /* Inside their budgets, with the headroom the budgets claim. */
  for (const [rel, doc] of [["data/segments.json", slice], ["data/segment-sources.json", srcSlice]]) {
    const budget = PROJECTED_DATA.find((p) => p.rel === rel).maxBytes;
    const bytes = sliceBytes(doc);
    assert.ok(bytes < budget, `the real ${rel} slice is ${(bytes / 1024).toFixed(1)} KB, over its budget`);
    assert.ok(bytes > budget * 0.2, `${rel}'s budget is loose enough that it would not notice a quadrupling`);
  }
});

test("the bundled catalogue slice keeps every show, and both of the Foray joins", () => {
  /* DELIBERATELY A SECOND, INDEPENDENT SUITE for this one mechanism.
     `prepare-webdir.test.mjs` covers it in detail against a fixture; this asserts it
     against TODAY'S REAL `data/discover.json`, from the file that owns the shell's
     invariants, because it is the property whose failure is invisible: a Foray's
     lock-screen artwork (#27) and its publisher credit link are joined onto
     `discover.json` by show name, and both take the first item per show in document
     order. A slice that drops or reorders that item still has every show, every
     topic, and a passing size budget. */
  const source = readJson(path.join(ROOT, "data", "discover.json"));
  const slice = discoverSlice(source);

  assert.ok(source.items.length > slice.items.length, "the slice is not slicing the real document");
  assert.equal(assertDiscoverSliceComplete(source, slice), true);
  /* Re-asserted here directly rather than only through that call, so deleting the
     join checks inside `assertDiscoverSliceComplete` fails in two suites. */
  assert.deepEqual([...artworkUrlsByShow(slice)], [...artworkUrlsByShow(source)]);
  assert.deepEqual([...collectionIdsByShow(slice)], [...collectionIdsByShow(source)]);
  assert.ok(artworkUrlsByShow(slice).size > 0, "the real document yielded no artwork at all");

  /* And it is inside its budget with the headroom the budget claims, measured on the
     bytes the slice would be written as. */
  const budget = PROJECTED_DATA.find((p) => p.rel === "data/discover.json").maxBytes;
  const bytes = sliceBytes(slice);
  assert.ok(bytes < budget, `the real slice is ${(bytes / 1024).toFixed(1)} KB, over its budget`);
  assert.ok(bytes > budget * 0.5, "the budget is loose enough that it would not notice a doubling");
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
  /* `cap add` generates a Cordova-compat `config.xml` in each platform, and THAT is
     the file someone would edit to "save battery".

     THIS COMMENT USED TO SAY the opposite of what is now true, and the correction
     matters because it changes what this test is worth. It said "nothing matches
     today because no platform is generated" and that `mobile/.gitignore`
     deliberately does NOT ignore the Android `res/xml/config.xml`, so that this
     test could check it — an ignored file cannot be checked.

     Since #37 both halves of that are false. The platform IS generated (so this
     walk really does read a real `config.xml`, which is why it is no longer
     instant), and `mobile/.gitignore` now ignores `android/` and `ios/` in FULL,
     because the platforms are regenerated rather than committed
     (`docs/android-shell-build.md` §1.5).

     SO BE CLEAR ABOUT THE COVERAGE THIS STILL HAS. On a machine that has generated
     a platform — which is any machine that can build the APK — it reads the real
     file and this guard is live. In CI, which checks out no platform, it matches
     nothing and is vacuous. That is an accepted loss rather than an oversight: the
     vector went away with the file, because `KeepRunning="false"` can no longer be
     COMMITTED if the file it would live in cannot be, and `cap add` regenerates it
     from a template that sets no `<preference>` at all. The half that still runs in
     CI is the sibling test over the parsed `capacitor.config.json`.

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

test("img-src still allows remote artwork and data: artwork URIs", () => {
  /* PINNED IN BOTH DIRECTIONS, because the first version of this suite pinned
     only the token it had just added. Narrowing `img-src 'self' https: data:` to
     `img-src 'self'` left every test in the repo green while blanking every piece
     of cover art on the site and in the app: app.js renders remote artwork from
     ~41 podcast CDNs. A guard that protects only the newest change is how the
     older, load-bearing thing dies.

     `data:` is NOT here for the favicon any more -- that is icon-180.png since
     the logo landed. It is held up by artwork instead: `player/media-session.js`
     and the plugin's `foray-media-session.js` both accept a `data:image/` artwork
     URI and hand it to the OS. Dropping the token blanks lock-screen art there. */
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
/* ────────── 6. the native code has a home, and it is not the generated one ──── */

/* SIXTH INVARIANT, added with the foreground service (#27's Android half, on #37):
 * ANDROID'S HAND-WRITTEN NATIVE CODE IS COMMITTED AND THE GENERATED PLATFORM IS
 * NOT. `navigator.mediaSession` is switched off in Android WebView at the engine
 * level (docs/research/mp1-background-audio.md §5.4) and a backgrounded Foray needs
 * a `mediaPlayback` foreground service (§5.3), so Android needs native code —
 * which #37 correctly left nowhere to live when it stopped committing
 * `mobile/android/`. It now lives in `mobile/plugins/foray-audio/`, and these tests
 * are what keep the two halves of that decision from drifting into each other.
 * docs/android-native-code.md is the reasoning. */

const PLUGIN_DIR = path.join(MOBILE, "plugins", "foray-audio");
const PLUGIN_REL = "mobile/plugins/foray-audio";

const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

test("mobile/.gitignore ignores the GENERATED platform and not our own android/ directory", () => {
  /* THE TRAP THIS TEST EXISTS TO REMEMBER, and it was live for the length of one
     commit. `mobile/.gitignore` said `android/` with no leading slash, and an
     unanchored gitignore pattern matches a directory of that name AT ANY DEPTH — so
     it silently ignored `plugins/foray-audio/android/`, and `git add mobile/plugins`
     staged the package.json and the web half while dropping every .java file, the
     build.gradle and the manifest without a word.

     Asserted through `git check-ignore` rather than by grepping the file for a
     leading slash, for the same reason the tracked-files test above gives: a rule's
     spelling is not the invariant, its EFFECT is, and `check-ignore` is the code path
     `git add` itself uses. `--no-index` so the answer is about the rules and not
     about what happens to be tracked right now. */
  const cases = [
    ["mobile/android/local.properties", true, "the generated Android platform must stay ignored"],
    ["mobile/ios/App/Podfile", true, "the generated iOS platform must stay ignored"],
    ["mobile/www/index.html", true, "the generated webDir must stay ignored"],
    [PLUGIN_REL + "/android/build.gradle", false, "our own plugin's Gradle module must be committable"],
    [
      PLUGIN_REL + "/android/src/main/java/ai/jwlabs/foura/audio/ForayAudioPlugin.java",
      false,
      "the foreground service's plugin class must be committable",
    ],
    [PLUGIN_REL + "/android/src/main/AndroidManifest.xml", false, "the service declaration must be committable"],
    /* THE MIRROR OF THE SAME MISTAKE, and it also cost a real failure. The plugin's
       android/ IS a Gradle library module, so Gradle writes a build/ tree into it —
       and none of the `android/build/` rules cover it, because a gitignore pattern
       containing a slash is anchored to mobile/ and so means `mobile/android/build/`
       and nothing else. `git add -A` died with "Filename too long" on a .dex path
       under it; a shorter hash would have committed several hundred build artefacts
       into a diff nobody reads file-by-file. (Said "a directory that auto-merges
       with no post-merge review window" until 2026-08-18; `mobile/` is not
       auto-mergeable — docs/android-native-code.md §8. The hazard is unchanged.) */
    [PLUGIN_REL + "/android/build/intermediates/whatever.dex", true, "the plugin's Gradle build output must be ignored"],
    [PLUGIN_REL + "/android/.gradle/8.14.3/checksums/checksums.lock", true, "the plugin's Gradle cache must be ignored"],
    [PLUGIN_REL + "/android/local.properties", true, "a machine-absolute sdk.dir must never be committable"],
  ];
  for (const [rel, shouldBeIgnored, why] of cases) {
    const res = git(["check-ignore", "-q", "--no-index", rel]);
    assert.ok(
      res.status === 0 || res.status === 1,
      "git check-ignore could not answer for " +
        rel +
        " (" +
        (res.error?.message ?? res.stderr?.trim() ?? "exit " + res.status) +
        ")"
    );
    assert.equal(res.status === 0, shouldBeIgnored, rel + ": " + why);
  }
});

test("every file the Android plugin needs is TRACKED by git", () => {
  /* The other half of the same hazard, asserted on the INDEX. Without this, a
     re-broadened ignore rule takes the native code out of the repo while the machine
     that generated the platform still has the files on disk — so the build passes
     there and fails for everyone else, which is the worst place to find out. */
  const needed = [
    "package.json",
    "android/build.gradle",
    "android/src/main/AndroidManifest.xml",
    "android/src/main/res/values/strings.xml",
    "android/src/main/java/ai/jwlabs/foura/audio/ForayAudioPlugin.java",
    "android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java",
    "web/foray-audio-shell.js",
    /* #27's Android half. Native code and its web half are useless separately: the
       polyfill with no Java answers "plugin not implemented" on every write, and the
       Java with no polyfill is a MediaSession nothing ever populates. */
    "web/foray-media-session.js",
    "android/src/main/java/ai/jwlabs/foura/audio/NowPlaying.java",
    "android/src/main/java/ai/jwlabs/foura/audio/NowPlayingHub.java",
    "android/src/main/java/ai/jwlabs/foura/audio/WebViewPlayer.java",
  ];
  const res = git(["ls-files", "--", PLUGIN_REL]);
  assert.equal(res.status, 0, "could not read the git index; this invariant is about what is COMMITTED");
  const tracked = new Set(res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  for (const rel of needed) {
    assert.ok(
      tracked.has(PLUGIN_REL + "/" + rel),
      PLUGIN_REL + "/" + rel + " is not tracked by git. A fresh clone cannot build the Android shell."
    );
  }
  /* And the repo really does have native sources now, which is the state #37 left it
     unable to reach: `git ls-files` used to contain zero .java and zero .kt files. */
  const natives = [...tracked].filter((f) => /\.(java|kt)$/.test(f));
  assert.ok(natives.length >= 5, "expected the plugin's Java to be tracked, found " + natives.length);
});

test("mobile/'s only non-Capacitor dependency is our own plugin, by a file: path inside mobile/", () => {
  /* This test used to require every dependency to start with `@capacitor/`, and its
     failure message asked for "a line in docs/mobile-shell.md saying why the shell
     needs it". That is what happened, and it is worth saying why the relaxation is
     not a climb-down: Capacitor's CLI discovers plugins by reading this dependency
     list (`@capacitor/cli`'s `getDependencies`), so a local plugin has to be declared
     here or `cap sync` never wires it into the generated project.

     RELAXED NARROWLY. The rule that matters is not "only Capacitor" — it is that the
     shell pulls in NO third-party JavaScript. So a non-Capacitor entry is allowed
     only as a `file:` specifier resolving inside `mobile/`, which is this repo's own
     code by construction. A registry range, a git URL, a tarball, or a `file:` path
     pointing out of the tree all still fail. */
  const deps = Object.entries(capPkg().dependencies || {});
  assert.ok(deps.length > 0, "mobile/package.json should declare the Capacitor deps");
  const local = [];
  for (const [name, spec] of deps) {
    if (name.startsWith("@capacitor/")) {
      assert.match(spec, /^[\^~]?\d/, name + " should come from the registry, got " + spec);
      continue;
    }
    assert.ok(
      spec.startsWith("file:"),
      "Unexpected dependency " +
        name +
        "@" +
        spec +
        " in mobile/. The shell takes no third-party JavaScript; anything that is not a " +
        "@capacitor/* package must be a file: path to code in this repo, and deserves a line " +
        "in docs/mobile-shell.md saying why."
    );
    const target = path.resolve(MOBILE, spec.slice("file:".length));
    const rel = path.relative(MOBILE, target);
    assert.ok(
      rel && !rel.startsWith("..") && !path.isAbsolute(rel),
      name + " resolves to " + target + ", which is outside mobile/."
    );
    assert.ok(
      fs.existsSync(path.join(target, "package.json")),
      name + " points at " + target + ", which has no package.json"
    );
    local.push({ name, target });
  }
  /* Pinned at exactly two, because "how many local plugins does the shell have" is a
     decision and today's answer is two. `foray-tts` is the second, added by this
     card (docs/research/on-device-tts.md) — say so here, in the PR that adds the
     next one, same as this comment already asked of the PR that added this one. */
  assert.equal(local.length, 2, "expected exactly two local plugins, found: " + (local.map((l) => l.name).join(", ") || "none"));
  assert.deepEqual(
    local.map((l) => l.name).sort(),
    ["foray-audio", "foray-tts"]
  );
});

test("the plugin name the web half calls is the name the Java registers", () => {
  /* IF THESE DISAGREE, NOTHING FAILS. The bridge answers "ForayAudio does not have a
     method called start" on a WebView console nobody is reading, the foreground
     service is never started, and the app plays perfectly until the screen locks.
     No other check in the repo would notice. */
  const java = fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/ForayAudioPlugin.java"),
    "utf8"
  );
  const annotated = /@CapacitorPlugin\s*\(\s*name\s*=\s*"([^"]+)"/.exec(java);
  assert.ok(annotated, "ForayAudioPlugin.java has no @CapacitorPlugin(name = ...) annotation");
  assert.equal(annotated[1], PLUGIN_NAME, "the Java's plugin name and the web half's PLUGIN_NAME disagree");

  /* And every method the web half calls must exist as a @PluginMethod, DERIVED from
     the Java rather than from a list written down here, so renaming one in either
     place fails.

     The `call`/`callAndRecord` names are the shell's two internal wrappers around
     `nativePromise`, and coupling to them is deliberate: this test is about names
     CROSSING THE BRIDGE, so it has to know where they cross. Rename a wrapper and
     `called` comes back too small, which the size assertion below turns into a
     failure rather than a silent pass. */
  const declared = new Set(
    [...java.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(\s*PluginCall/g)].map((m) => m[1])
  );
  const shellSrc = fs.readFileSync(path.join(PLUGIN_DIR, "web/foray-audio-shell.js"), "utf8");
  const called = new Set([...shellSrc.matchAll(/\bcall(?:AndRecord)?\(\s*"(\w+)"/g)].map((m) => m[1]));
  assert.ok(called.size >= 2, "expected the shell to call at least start and stop, found " + [...called].join(", "));
  for (const method of called) {
    assert.ok(declared.has(method), "the shell calls ForayAudio." + method + "(), which is not a @PluginMethod");
  }

  /* #27's half calls the same plugin by the same name, from a SECOND web file — so
     there are now three places one rename breaks silently. `SET_METHOD` is checked
     against the @PluginMethod set for the same reason `start` is: a typo there means
     the lock screen is never populated and nothing anywhere goes red. */
  assert.equal(MEDIA_PLUGIN_NAME, PLUGIN_NAME, "the two web halves disagree about the plugin's name");
  assert.ok(
    declared.has(SET_METHOD),
    "foray-media-session.js calls ForayAudio." + SET_METHOD + "(), which is not a @PluginMethod"
  );
  /* And the EVENT name, which is the only thing crossing the bridge in the other
     direction. If these disagree, `notifyListeners` posts to an event nobody
     subscribed to: every transport press is dropped, in silence, on a surface whose
     whole purpose is those presses. */
  const javaEvent = /static final String TRANSPORT_EVENT = "(\w+)"/.exec(java);
  assert.ok(javaEvent, "ForayAudioPlugin.java no longer declares TRANSPORT_EVENT");
  assert.equal(javaEvent[1], TRANSPORT_EVENT, "the Java's transport event name and the web half's disagree");
});

test("the Java package, the source layout, the Gradle namespace and the manifest's service all name the same thing", () => {
  /* ADDED BY THE FIRST 2026-08-25 PACKAGE RENAME (`com.jwincorporated.foray.audio`
     -> `dev.jwlabs.foura.audio`) and EXERCISED FOR REAL BY THE SECOND THE SAME DAY
     (-> `ai.jwlabs.foura.audio`, when `jwlabs.ai` became the company's primary
     domain; both in docs/DECISIONS.md). It exists because that refactor touches four
     places that must agree and NOTHING IN THIS REPO COULD READ THREE OF THEM. The
     only checks that would have noticed a half-finished rename live in
     `.github/workflows/android-build.yml` and need a real Gradle build and an
     Android SDK, so the feedback was a CI round trip away — and `mobile/android/` is
     not committed, so no other suite can reach the generated project either.

     THE COMPARISONS ARE DERIVED from the Java's own `package` line rather than from
     a second literal, so the namespace and manifest checks below cannot be satisfied
     by editing this file. BE HONEST ABOUT THE LIMIT, THOUGH: `serviceRel` IS a
     pinned path, so the NEXT rename does have to edit this test — it just cannot
     edit it into agreement with a half-finished rename, which is the property that
     matters. A review pass caught the first version of this comment claiming
     otherwise. The five things and what each one breaks:

     1. `namespace` in build.gradle == the `package` declaration. This one is a
        COMPILE invariant even though Android permits the two to differ in general:
        PlaybackKeepAliveService references `R.string.foray_playback_channel_name`
        and friends with NO `import <namespace>.R;`, so `R` resolves only while the
        class sits in the namespace's own package. Diverge them and the module dies
        with `cannot find symbol: R` — a failure that reads as a missing resource.
     2. The source directory == the package, segment for segment. javac's own rule,
        and the reason `git mv` of the tree and the `package` edit are one change.
     3. The manifest's `<service android:name>` == the real FQCN. THE SILENT ONE:
        AGP merges whatever string is there, the APK builds, and the service fails
        to start at run time with a ClassNotFoundException nobody is watching for --
        which on this app means background audio dies at the lock screen and the
        foreground playback that came before it looked perfect.
     4. NO TRACKED .java SURVIVES OUTSIDE THE PACKAGE DIRECTORY, and this one was
        added by a review pass that broke the first version of this test. Checking
        only the files INSIDE the new directory misses the failure an incomplete
        `git mv` actually produces: the old tree still committed alongside the new
        one. The reviewer re-added all five classes under
        `com/jwincorporated/foray/audio/` with their old `package` lines and the
        whole suite stayed green — two classes carrying
        `@CapacitorPlugin(name = "ForayAudio")` in one APK, one of them silently
        winning. Nothing else catches it: the "TRACKED by git" test above is a
        subset allowlist whose only breadth check is `natives.length >= 5`, and
        android-build.yml's `grep -qF` passes on one occurrence or two.
     5. The plugin's registered NAME is not part of any of this and must not move
        with it. That pair is the test above; it is asserted separately on purpose,
        because the package and the name are different things and the bridge finds
        the plugin by the name.

     MUTATION (run each; the first three and the fifth fail on a named assertion,
     and the fourth — moving the directory — fails as an ENOENT on `serviceRel`
     rather than on an assertion, which is loud but is not the message the layout
     check would print): change `namespace =` in
     `mobile/plugins/foray-audio/android/build.gradle` to
     `"ai.jwlabs.foura.audioo"`; or `android:name` in the library manifest to
     `ai.jwlabs.foura.PlaybackKeepAliveService`; or the `package` line in any one of
     the five .java files; or `git mv` the `audio/` directory one level up. */
  const serviceRel = "android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java";
  const serviceSrc = fs.readFileSync(path.join(PLUGIN_DIR, serviceRel), "utf8");
  const declared = /^package\s+([\w.]+)\s*;/m.exec(serviceSrc);
  assert.ok(declared, "PlaybackKeepAliveService.java has no package declaration");
  const pkg = declared[1];

  /* 2. The layout. Compared as the path the package IMPLIES, so a directory that
        drifts from the declaration fails here rather than at javac on a machine that
        has an Android SDK. */
  assert.equal(
    path.dirname(serviceRel),
    "android/src/main/java/" + pkg.split(".").join("/"),
    "the source directory and the `package` declaration disagree; javac requires them to match"
  );

  /* And EVERY .java file in the package agrees, not just the service — a stray file
     left on the old package compiles fine and is then invisible to the class the
     manifest names. Read from disk rather than listed here so a sixth file is
     covered the day it lands. */
  const dir = path.join(PLUGIN_DIR, path.dirname(serviceRel));
  const javaFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".java"));
  assert.ok(javaFiles.length >= 5, "expected at least five .java files in the package, found " + javaFiles.length);
  for (const f of javaFiles) {
    const m = /^package\s+([\w.]+)\s*;/m.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.ok(m, f + " has no package declaration");
    assert.equal(m[1], pkg, f + " declares package " + m[1] + ", but it sits in " + pkg);
  }

  /* 4. AND NOTHING IS LEFT BEHIND. Asserted on the INDEX and in the OUTWARD
        direction — every tracked .java under the plugin must live in the package
        directory — because the loop above reads only the new directory and so cannot
        see the old one still being committed beside it. That is the actual shape of a
        half-finished `git mv`, and it is the one this test shipped blind to until a
        review pass re-added the old tree and watched the suite stay green.

        The direction matters: this does NOT require a brand-new .java to be staged
        before the suite passes (the "TRACKED by git" test above owns that question),
        it only requires that no COMMITTED .java sits outside the package. */
  const pkgDirRel = PLUGIN_REL + "/" + path.dirname(serviceRel);
  const ls = git(["ls-files", "--", PLUGIN_REL]);
  assert.equal(ls.status, 0, "could not read the git index; this half of the invariant is about what is COMMITTED");
  /* M5 (full-repo-review-report.md, 2026-08-31) added a real `src/test/java/...`
     tree (Robolectric unit tests) alongside `src/main/java/...`. Those test
     classes legitimately live under their own package directory outside
     `src/main/java` — a second, separate JVM source root Gradle already knows
     about, not a stray leftover from an incomplete rename. Scope this check to
     production sources only (`src/main/java`) so it keeps catching the one
     failure mode it exists for (an old src/main package tree left behind by a
     half-finished `git mv`) without flagging every legitimate test file. */
  const mainJavaRoot = PLUGIN_REL + "/android/src/main/java/";
  const trackedJava = ls.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((f) => f.endsWith(".java") && f.startsWith(mainJavaRoot));
  assert.ok(trackedJava.length >= 5, "expected at least five tracked .java files, found " + trackedJava.length);
  for (const f of trackedJava) {
    assert.ok(
      f.startsWith(pkgDirRel + "/"),
      f + " is tracked but sits outside " + pkgDirRel +
        ". An incomplete package rename leaves the old tree committed beside the new one, which puts two classes " +
        "annotated @CapacitorPlugin(name = \"ForayAudio\") in one APK and lets whichever Capacitor finds first win."
    );
  }

  /* 1. The Gradle namespace. */
  const gradle = fs.readFileSync(path.join(PLUGIN_DIR, "android/build.gradle"), "utf8");
  const ns = /^\s*namespace\s*=?\s*["']([\w.]+)["']/m.exec(gradle);
  assert.ok(ns, "the plugin's build.gradle no longer declares a namespace");
  assert.equal(
    ns[1],
    pkg,
    "build.gradle's namespace is " + ns[1] + " but the Java is in " + pkg +
      "; `R` is generated into the namespace and the Java imports no R, so this will not compile"
  );

  /* 3. The manifest's service class. Scoped to the `<service` element with
        `[^>]*` rather than a lazy `[\s\S]*?`, so the capture cannot wander into a
        later element's `android:name` if the service ever loses its own. */
  const manifest = fs.readFileSync(path.join(PLUGIN_DIR, "android/src/main/AndroidManifest.xml"), "utf8");
  const svc = /<service\b[^>]*android:name="([^"]+)"/.exec(manifest);
  assert.ok(svc, "the library manifest no longer declares a <service> with an android:name");
  assert.equal(
    svc[1],
    pkg + ".PlaybackKeepAliveService",
    "the manifest names " + svc[1] + ", which is not the class that exists; the service would fail to start at run time"
  );
});

/** Java source with its comments removed, so scanning for call sites cannot be fooled
 *  by a doc comment that names one. These files carry more prose than code and the
 *  prose quotes method names on purpose. */
function stripJavaComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** JavaScript source with its comments removed. Same job as `stripJavaComments`, and
 *  needed for the same reason: these files carry more prose than code and the prose
 *  quotes the very call sites being searched for. */
function stripJsComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/[^\n]*/gm, " ");
}

test("EVERY TRANSPORT ACTION THE NATIVE SIDE CAN SEND IS ONE THE PAGE CAN ROUTE", () => {
  /* The other silent seam, and the sharper one: the action names are string literals in
     two Java files and a `Map` lookup in JavaScript. A `"nextTrack"` for a
     `"nexttrack"` compiles, installs, posts an event, finds no handler and does
     nothing — from a steering wheel, at 70 mph, with every test green.

     DERIVED from the Java by scanning both senders rather than listed here, so a new
     action added natively without a web handler fails. */
  const dir = path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio");
  const player = stripJavaComments(fs.readFileSync(path.join(dir, "WebViewPlayer.java"), "utf8"));
  const service = stripJavaComments(fs.readFileSync(path.join(dir, "PlaybackKeepAliveService.java"), "utf8"));
  /* THE WHOLE ARGUMENT LIST, not the first argument, and the first draft of this test
     was wrong in the way that matters: `send(playWhenReady ? "play" : "pause", …)` and
     `transportIntent(playing ? "pause" : "play", 2)` are ternaries, so a regex anchored
     to a leading string literal found six actions and missed play and pause — the two
     every other button is beside. It failed loudly only because of the count assertion
     below, which is why that assertion is there. */
  /* `[A-Za-z]`, NOT `[a-z]`, and a mutation is why. Scanning for lowercase-only
     literals made the one misspelling this test exists to catch — `"nextTrack"` for
     `"nexttrack"` — invisible, because a camelCase action simply did not match the
     pattern and so was never checked against the routable set. The test survived the
     exact mutation it is named after. */
  const sent = new Set(
    [...player.matchAll(/\bsend\(([^)]*)\)/g), ...service.matchAll(/transportIntent\(([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((q) => q[1]))
  );
  assert.ok(sent.size >= 7, "expected at least seven transport actions in the Java, found " + [...sent].join(", "));
  for (const action of sent) {
    assert.ok(
      ROUTABLE_ACTIONS.includes(action),
      "the Java sends the transport action " + action + ", which foray-media-session.js cannot route"
    );
  }
  /* Both halves of play/pause and both skips must be reachable, because each is a
     separate acceptance criterion in #27 and each is a separate button. */
  for (const action of ["play", "pause", "nexttrack", "previoustrack", "seekto"]) {
    assert.ok(sent.has(action), "nothing in the Java can send " + action);
  }
});

test("EACH NOTIFICATION BUTTON GETS ITS OWN PendingIntent REQUEST CODE", () => {
  /* `PendingIntent` equality IGNORES EXTRAS. Two of them differing only in an extra,
     with the same request code, are the SAME PendingIntent — and FLAG_UPDATE_CURRENT
     then rewrites the first one's extras. Share a code across these buttons and every
     control on the notification performs whichever action was built last: press
     previous, get stop.

     Nothing about that fails a build, a lint or any other test in this repo, and on a
     device it looks like a mis-wired remote rather than a bug in a number. */
  const service = fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java"),
    "utf8"
  );
  const uses = [...stripJavaComments(service).matchAll(/transportIntent\(([^)]*?),\s*(\d+)\s*\)/g)]
    .map((m) => ({
      /* Both literals when the argument is a ternary, joined — so play and pause sharing
         one request code is correct (they are one button) and reads as one entry here. */
      action: [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((q) => q[1]).join("/"),
      code: Number(m[2]),
    }));
  assert.ok(uses.length >= 5, "expected at least five transport intents, found " + uses.length);
  const byCode = new Map();
  for (const use of uses) {
    const existing = byCode.get(use.code);
    assert.ok(
      existing === undefined || existing === use.action,
      "request code " + use.code + " is shared by " + existing + " and " + use.action +
        ": PendingIntent equality ignores extras, so one of those buttons will do the other's job"
    );
    byCode.set(use.code, use.action);
  }
  /* And zero is the Activity launch intent's code, which is a getActivity rather than a
     getService — a collision there would replace "tap to open the app". */
  assert.ok(!byCode.has(0), "a transport intent reuses request code 0, which the launch intent holds");
});

test("the notification permission is declared, aliased, and asked for exactly once", () => {
  /* #244 deliberately did NOT declare POST_NOTIFICATIONS, on the correct grounds that a
     foreground service runs without it. #27 changes that: from Android 13 an
     unpermitted notification is not shown, and the notification IS the transport
     controls — so on most devices the deliverable does not exist until this is granted.

     Three things have to line up or the request is a no-op: the manifest declaration,
     the @Permission alias the plugin requests by, and the web half asking. */
  const manifest = fs.readFileSync(path.join(PLUGIN_DIR, "android/src/main/AndroidManifest.xml"), "utf8");
  assert.ok(
    manifest.includes("android.permission.POST_NOTIFICATIONS"),
    "POST_NOTIFICATIONS is not declared, so requesting it at runtime silently fails"
  );
  const java = fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/ForayAudioPlugin.java"),
    "utf8"
  );
  const alias = /static final String NOTIFICATIONS = "(\w+)"/.exec(java);
  assert.ok(alias, "the plugin no longer declares a notifications permission alias");
  assert.match(
    java,
    /@Permission\(alias = ForayAudioPlugin\.NOTIFICATIONS, strings = \{ Manifest\.permission\.POST_NOTIFICATIONS \}\)/,
    "the @Permission annotation must bind the alias to POST_NOTIFICATIONS"
  );
  assert.match(
    java,
    /requestPermissionForAlias\(NOTIFICATIONS, call, "notificationsResult"\)/,
    "the request must name a @PermissionCallback that exists"
  );
  assert.match(java, /@PermissionCallback\s+private void notificationsResult\(PluginCall call\)/);
  /* ONCE. A prompt on every play would be Android's own re-prompt limit doing our
     rate-limiting for us, which it only does twice. */
  const shellSrc = fs.readFileSync(path.join(PLUGIN_DIR, "web/foray-audio-shell.js"), "utf8");
  assert.match(shellSrc, /if \(notificationsAsked\) return;/, "the shell can ask more than once");
});

test("the web half of #27 depends on nothing under player/", () => {
  /* It is copied to the BUNDLE ROOT by prepare-webdir.mjs, so a relative import of
     `player/media-session.js` would resolve from a different depth there than in the
     repo — and the Node suite imports it with no `player/` alongside at all. The two
     duplicated constants are kept honest by reading the other file in
     foray-media-session.test.mjs instead. */
  const src = fs.readFileSync(path.join(PLUGIN_DIR, "web/foray-media-session.js"), "utf8");
  const imports = [...src.matchAll(/^\s*import[^\n]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, [], "foray-media-session.js must have no imports at all: " + imports.join(", "));
});

test("the service is declared as a mediaPlayback foreground service, with its permissions", () => {
  /* MP1 §5.3: `mediaPlayback` is the type with no runtime prerequisites and — unlike
     dataSync and mediaProcessing — NO RUNTIME TIMEOUT, which is the property a
     45-to-90-minute Foray needs. From Android 14 the type is mandatory, and so is
     the matching FOREGROUND_SERVICE_* permission: without it `startForeground`
     throws and the service dies at runtime with the build green. */
  const manifest = fs.readFileSync(path.join(PLUGIN_DIR, "android/src/main/AndroidManifest.xml"), "utf8");
  const service = /<service\b[\s\S]*?\/>/.exec(manifest);
  assert.ok(service, "the plugin's manifest declares no <service>");
  assert.match(service[0], /android:foregroundServiceType="mediaPlayback"/);
  assert.match(service[0], /android:exported="false"/, "the service must not be exported");
  assert.match(
    service[0],
    /android:stopWithTask="true"/,
    "a swiped-away app must not leave a foreground service running"
  );
  for (const perm of [
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  ]) {
    assert.ok(manifest.includes(perm), "the plugin's manifest does not request " + perm);
  }
  /* The declared class must be a class that exists. A manifest naming a missing
     Service compiles, installs, and throws ClassNotFoundException on the first play. */
  const named = /android:name="([^"]+)"/.exec(service[0]);
  assert.ok(named, "the <service> has no android:name");
  const javaPath = path.join(PLUGIN_DIR, "android/src/main/java", named[1].split(".").join("/") + ".java");
  assert.ok(
    fs.existsSync(javaPath),
    "the manifest declares " + named[1] + ", but " + path.relative(ROOT, javaPath) + " does not exist"
  );
});

test("the plugin declares an Android platform and no iOS one", () => {
  /* Not an omission. MP1 §7.3: WebKit sets the AVAudioSession category itself for an
     audible <audio> element, so iOS's whole background-audio requirement is the
     UIBackgroundModes key that tools/mobile/inject-background-audio.mjs writes.
     Native iOS code here would have nothing to do, and declaring an `ios` src that
     does not exist makes `cap sync` fail on a Mac. */
  const pkg = readJson(path.join(PLUGIN_DIR, "package.json"));
  assert.equal(pkg.capacitor?.android?.src, "android");
  assert.equal(pkg.capacitor?.ios, undefined, "the plugin claims an iOS platform it does not have");
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "android", "build.gradle")));
  assert.equal(pkg.private, true, "this plugin is not published; keep it private");
});

test("the plugin's Gradle dependencies are androidx only, and each is named in the header", () => {
  /* #244's version of this test required androidx.appcompat and nothing else, on the
     grounds that the native half then cost NO new Maven artefact. #27 spends that: a
     lock screen needs a `MediaSession`, and `navigator.mediaSession` is switched off in
     Android WebView at the engine level, so there is no cheaper way to get one.

     What the rule becomes is not "nothing new" — it is **androidx or Capacitor, and
     named in the build.gradle header with what calls it**. A random Maven coordinate, a
     Guava pinned by hand, a `com.github.*` fork all still fail, and each of those is a
     mutation this test catches. The header requirement is enforced literally: the
     artefact id has to appear in the comment block. */
  const gradle = fs.readFileSync(path.join(PLUGIN_DIR, "android", "build.gradle"), "utf8");
  const coords = [
    ...gradle.matchAll(/^\s*(?:implementation|api|compileOnly|runtimeOnly)\s+["']([^"']+)["']/gm),
  ].map((m) => m[1]);
  const allowed = [/^androidx\.appcompat:appcompat:/, /^androidx\.media3:media3-(session|common):/];
  const header = gradle.slice(0, gradle.indexOf("*/"));
  for (const c of coords) {
    assert.ok(
      allowed.some((re) => re.test(c)),
      "the plugin declares " + c + ". Name it and say why in the build.gradle header before adding it."
    );
    const artefact = c.split(":")[1];
    assert.ok(
      header.includes(artefact),
      "the plugin declares " + c + " and the build.gradle header does not mention " + artefact
    );
  }
  /* NOT exoplayer and NOT ui, which are the two easy mistakes: one puts a second real
     audio pipeline in a process whose whole design is that the page owns the only one,
     and the other is ~1 MB of PlayerView for a notification built with
     NotificationCompat. */
  for (const c of coords) {
    assert.ok(
      !/media3-(exoplayer|ui)/.test(c),
      "the plugin declares " + c + ": there is no player to build and no view to inflate here"
    );
  }
  /* A FIXED VERSION, not a range. `1.+` or `latest.release` makes the lock screen's
     behaviour a function of the day the APK was built, which is the one property a
     media surface must not have. */
  /* A PLAIN ASSIGNMENT, not a `hasProperty` lookup, and a review pass is why: the
     comment above it argued for a pin while the code inherited whatever the generated
     project might one day declare, and `-Pmedia3Version=…` on the command line made
     `hasProperty` true while the ext property did not exist, failing the build instead of
     honouring the override. */
  const media3 = /media3Version = '([^']+)'/.exec(gradle);
  assert.ok(media3, "the Media3 version is no longer a single pinned ext property");
  assert.match(media3[1], /^\d+\.\d+\.\d+$/, "the Media3 version must be exact, not a range: " + media3[1]);
  for (const c of coords.filter((x) => x.startsWith("androidx.media3:"))) {
    assert.ok(
      c.endsWith("$media3Version"),
      c + " pins its own Media3 version instead of using the one ext property"
    );
  }
  assert.ok(
    /implementation project\(':capacitor-android'\)/.test(gradle),
    "the plugin must depend on capacitor-android"
  );
  /* AND EACH REQUIRED ARTEFACT IS PRESENT, which the allow-list above cannot say. A
     mutation that replaced the appcompat line with a second media3-session line
     survived: every coordinate was allowed and named in the header, and appcompat —
     which is where `NotificationCompat`, `ServiceCompat` and `ContextCompat` come from
     — had silently gone. That build fails, so it is not the worst kind of hole; but a
     test whose whole subject is the dependency list should not need the compiler to
     notice a missing dependency. */
  for (const required of ["androidx.appcompat:appcompat:", "androidx.media3:media3-session:", "androidx.media3:media3-common:"]) {
    assert.ok(
      coords.some((c) => c.startsWith(required)),
      "the plugin no longer declares " + required + ", which it compiles against"
    );
  }
});

test("start() and stop() do not claim to know whether the service is running", () => {
  /* THE HIGH-SEVERITY FINDING FROM THE REVIEW PASS, pinned so it cannot come back.
     `startForegroundService` only asks ActivityManager; the service's `onStartCommand`
     — which sets the flag — is dispatched later on the app's MAIN thread, while the
     plugin method runs on the bridge's worker pool. So a `result.put("running",
     isRunning())` after that call is a race that answers false on every first start.

     It was there, and the web half gated on it: `ensureStarted`'s short-circuit could
     never fire, so every play() re-issued a start — including the one across a hidden
     seam, which is a BACKGROUND foreground-service start and the exact call the settle
     window exists to avoid. Nothing failed; the app would simply have kept asking
     Android for something Android refuses.

     Asserted as the SET of fields each method resolves with, derived from the Java, so
     a re-added `running` fails here rather than on a device. */
  const java = fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/ForayAudioPlugin.java"),
    "utf8"
  );
  const bodyOf = (method) => {
    const at = java.indexOf(`public void ${method}(PluginCall call) {`);
    assert.ok(at > 0, `ForayAudioPlugin.java has no ${method}(PluginCall)`);
    const end = java.indexOf("\n    }", at);
    assert.ok(end > at, `could not find the end of ${method}()`);
    return java.slice(at, end);
  };
  /* A SET, because the success and failure branches both put `started`/`stopped` and
     `reason`. What is being asserted is which fields can appear at all. */
  const fieldsOf = (method) => [
    ...new Set([...bodyOf(method).matchAll(/result\.put\(\s*"(\w+)"/g)].map((m) => m[1])),
  ].sort();

  assert.deepEqual(
    fieldsOf("start"),
    ["alreadyRunning", "reason", "started"],
    "start() must report whether the REQUEST was accepted, and must not report a post-call `running` " +
      "— that read races the service's own onStartCommand and answers false on every first start."
  );
  assert.deepEqual(
    fieldsOf("stop"),
    ["reason", "stopped", "wasRunning"],
    "stop() must not report a post-call `running` either; stopService is asynchronous too."
  );
  assert.deepEqual(
    fieldsOf("state"),
    ["notificationPermission", "notificationsEnabled", "platform", "running", "sessionActive"],
    "state() is the ONLY method that may answer `running`, and it can because it is a separate call. " +
      "#27 added three diagnostics beside it, because \"the lock screen is blank\" has at least three " +
      "causes and only one of them is a bug in this code."
  );
  /* #27's own two, held to the same rule. `setNowPlaying` may report `running` and
     `sessionActive` because it reads them as FACTS ALONGSIDE its own answer rather than
     as the result of anything it just did — there is no asynchronous request behind
     them to race. */
  assert.deepEqual(
    fieldsOf("setNowPlaying"),
    ["ok", "reason", "running", "sessionActive"],
    "setNowPlaying() must report whether the state was accepted, and may report the service's own flags"
  );
  assert.deepEqual(
    fieldsOf("requestNotifications"),
    ["granted", "reason", "requested"],
    "requestNotifications() must distinguish `requested` (was a dialog shown) from `granted` (the answer)"
  );

  /* And the web half must gate on the field that is knowable. Checked on the source
     because the alternative — a test that mocks the bridge — is the suite in
     foray-audio-shell.test.mjs, and this is the seam between the two languages. */
  const shellSrc = fs.readFileSync(path.join(PLUGIN_DIR, "web/foray-audio-shell.js"), "utf8");
  assert.match(
    shellSrc,
    /startAccepted = !!result\.started;/,
    "the web half must set its gate from `started`, the only thing a synchronous bridge call knows."
  );
  /* AND NOTHING DERIVES THE START GATE FROM `running`, which is the rule that finding
     was really about. #27 gave the shell a second, legitimate consumer of a `running`
     value — `noteServiceRunning`, which recovers when the service goes away underneath
     us — so "only `lastKnownRunning` may read it" stopped being the right spelling of
     the invariant and started being a spelling that forbade a fix. What must never come
     back is `startAccepted` being computed from a raced read. */
  assert.match(
    shellSrc,
    /function noteServiceRunning\(running\) \{/,
    "the shell must have a single named place where native's `running` is consumed"
  );
  const startAssignments = [...shellSrc.matchAll(/startAccepted = ([^;]+);/g)].map((m) => m[1].trim());
  for (const rhs of startAssignments) {
    assert.ok(
      !/result\.running|\brunning\b/.test(rhs),
      "the start gate is being set from a `running` read (" + rhs + "), which races the service's own onStartCommand"
    );
  }
  assert.ok(
    startAssignments.includes("!!result.started"),
    "the start gate must still be set from `started`: " + startAssignments.join(" / ")
  );
});


/* --------------------------- 7. #27's four review findings, pinned in the source

   Every one of these was found by a human reading the Java, not by a failing test, and
   every one of them is invisible at runtime until a listener hits it. They are asserted
   over the source because there is no JVM test harness in this repo — which is a real
   limitation and the reason these are worded as narrowly as they are. */

test("THE STOP BUTTON IS NOT GATED ON acceptsTransport()", () => {
  /* THE BLOCKING FINDING. `acceptsTransport()` is false for a FINISHED Foray —
     correctly, because a play button that does nothing is worse than none — and the
     first version gated EVERY notification action on it, including stop. Every session
     ends in that state, so every session ended with an ongoing foreground-service
     notification carrying no buttons at all, exitable only by unlocking the phone and
     closing the player. The whole trade in `docs/android-lock-screen.md` §5.1 rests on
     stop being the one-press exit, so it has to exist wherever a notification can. */
  const service = fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java"),
    "utf8"
  );
  /* `[^{]`, not `[^)]`: the guard contains a call — `np.isLoaded()` — so a
     paren-excluding class cannot reach across it, and the first version of this test
     failed with "no conditional stop action" while looking straight at one. */
  const stopGuard = /if \(([^{]*?)&& np\.canStop\) \{/.exec(stripJavaComments(service));
  assert.ok(stopGuard, "the notification no longer has a conditional stop action");
  assert.ok(
    !/transport/.test(stopGuard[1]),
    "the stop action is gated on `transport` (" + stopGuard[1].trim() + "), so a finished Foray has no exit"
  );
  assert.match(stopGuard[1], /np\.isLoaded\(\)/, "stop should be offered whenever anything is loaded");
});

test("A NEW DOCUMENT IS ANNOUNCED FROM THE PAGE, NOT FROM A NATIVE PAGE HOOK", () => {
  /* THIS TEST USED TO ASSERT THE DEAD MECHANISM, which is the sharpest illustration in
     this branch of what a source-scanning test is worth. It checked that the plugin's
     `WebViewListener.onPageLoaded` compared the document URL rather than stopping
     unconditionally — and it passed, over a listener Capacitor SILENTLY DISCARDS:
     `Bridge`'s constructor runs `registerAllPlugins()` (where `load()` runs) and then
     `Bridge.Builder.create()` calls `setWebViewListeners(...)`, replacing the list with
     the Builder's own. So `onPageLoaded` could never fire, and this test asserted the
     shape of code that never ran.

     The page announces itself now — `foray-audio-shell.js`'s auto-install calls
     `newDocument()` — which is a path the Node suite drives end to end (§13 there). What
     is left for this test is the one line the suite cannot reach: the wiring in the
     auto-install block, which is guarded on `window` and so never executes in Node. */
  const plugin = stripJavaComments(fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/ForayAudioPlugin.java"),
    "utf8"
  ));
  assert.ok(
    !/WebViewListener/.test(plugin),
    "the plugin registers a WebViewListener again; Capacitor replaces that list after load() and it can never fire"
  );
  assert.match(
    plugin,
    /public void newDocument\(PluginCall call\)/,
    "there is no newDocument method for the page to announce itself to"
  );
  /* And it must clear the hub as well as stop the service, or the next play builds a
     session from the PREVIOUS document's title. */
  const body = /public void newDocument\(PluginCall call\) \{([\s\S]*?)call\.resolve\(result\);/.exec(plugin);
  assert.ok(body, "could not read newDocument's body");
  assert.match(body[1], /NowPlayingHub\.set\(NowPlaying\.EMPTY\)/, "newDocument leaves the hub stale");
  assert.match(body[1], /stopServiceQuietly\(\)/, "newDocument does not stop a leaked service");

  const shellSrc = fs.readFileSync(path.join(PLUGIN_DIR, "web/foray-audio-shell.js"), "utf8");
  assert.match(
    shellSrc,
    /shell\.newDocument\(\);/,
    "nothing calls newDocument() at install, so the reloaded-page hole is open again"
  );
});

test("the notification repaint is gated on what the notification SAYS", () => {
  /* The page reports the playhead ~1 Hz because Media3 extrapolates from it. Nothing on
     the notification depends on it, so re-posting there is ~3,600 identical
     notifications an hour — and `player/media-session.js`'s own header warns that
     writing at rate redraws the notification and visibly flickers on Android. */
  const service = stripJavaComments(fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java"),
    "utf8"
  ));
  assert.match(service, /private static String visibleKey\(/, "there is no visible-state key to compare");
  assert.match(
    service,
    /if \(key\.equals\(lastNotificationKey\)\) return;/,
    "onNowPlayingChanged does not short-circuit on an unchanged display"
  );
  /* And the key must not carry the playhead, or it would never match. */
  const key = /private static String visibleKey\(@NonNull NowPlaying np\) \{([\s\S]*?)\}/.exec(service);
  assert.ok(key, "could not read visibleKey's body");
  assert.ok(
    !/positionMs|durationMs/.test(key[1]),
    "visibleKey includes the playhead, so the gate can never match and the repaint is not gated at all"
  );
});

test("the session's owner is identity-checked, like the hub's listener and sink", () => {
  /* A stop and a start can overlap — the new instance's onCreate can run before the old
     one's onDestroy — so a plain boolean lets the OLD instance report "no session" while
     the NEW one is live. `state()` would then lie during exactly the restart a device
     pass is trying to diagnose, on a field the documentation tells it to trust. */
  const service = stripJavaComments(fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/PlaybackKeepAliveService.java"),
    "utf8"
  ));
  assert.match(
    service,
    /if \(sessionOwner == this\) sessionOwner = null;/,
    "releaseSession clears the session owner without checking it is still ours"
  );
  assert.ok(
    !/sessionActive = (true|false)/.test(service),
    "the session flag is a plain boolean again; overlapping instances will disagree"
  );
});

test("a millisecond value is clamped at both ends before it reaches Media3", () => {
  /* `WebViewPlayer` multiplies durationMs by 1000 for microseconds. Clamping only the
     sign leaves Long.MAX_VALUE reachable, and Long.MAX_VALUE * 1000 wraps NEGATIVE —
     which `MediaItemData.Builder.setDurationUs` rejects by throwing on the main thread
     inside getState(), the exact crash class the clamps exist to prevent. */
  const now = stripJavaComments(fs.readFileSync(
    path.join(PLUGIN_DIR, "android/src/main/java/ai/jwlabs/foura/audio/NowPlaying.java"),
    "utf8"
  ));
  assert.match(now, /private static long clampMs\(long ms\)/, "there is no magnitude clamp");
  assert.match(now, /return Math\.min\(ms, MAX_MS\);/, "clampMs does not bound the magnitude");
  for (const field of ["durationMs", "positionMs"]) {
    assert.match(
      now,
      new RegExp('clampMs\\(longOf\\(data, "' + field + '"\\)\\)'),
      field + " is not clamped through clampMs"
    );
  }
});

test("the permission prompt is not issued through the serialised bridge queue", () => {
  /* `callAndRecord` exists to order `start` against `stop`. `requestNotifications`
     resolves only when a human answers a dialog, so putting it in that chain blocks a
     `stop` behind a person — and if the Activity is torn down under the dialog, the chain
     never advances again and the shell can neither start nor stop for the session. */
  const shellSrc = stripJsComments(fs.readFileSync(path.join(PLUGIN_DIR, "web/foray-audio-shell.js"), "utf8"));
  assert.ok(
    !/callAndRecord\("requestNotifications"/.test(shellSrc),
    "requestNotifications goes through the serialised queue, where it blocks every call behind it"
  );
  assert.match(shellSrc, /call\("requestNotifications"\)\.then\(/);
});
