/* `tools/mobile/prepare-webdir.mjs` — the native bundle's assembly (issue #36).
 *
 * What is actually at stake here, in order:
 *
 *   1. THE BUNDLE MUST CONTAIN EVERY FILE THE CLIENT FETCHES. Miss one and the
 *      app 404s on a device, where nobody is watching a console.
 *   2. THE BUNDLE MUST NOT CONTAIN `data/`'s PIPELINE INPUTS. They are 60 MB;
 *      `breadth-classification.json` alone is 16 MB.
 *   3. THE DERIVATION MUST NOT FAIL GREEN. The data list is read out of app.js
 *      rather than written down, so the interesting failure is not "wrong file"
 *      but "no files, small bundle, exit 0". Two tests below attack exactly that.
 *   4. THERE MUST BE NO SECOND COPY OF THE PLAYER. Everything is copied at build
 *      time from the real files; the closure test is what notices a player module
 *      the plan would have missed.
 *
 * Most tests run against a synthetic repo in a temp directory, so they assert the
 * script's behaviour rather than today's file list. The two that use the REAL
 * repo are marked, and they are the regression signal for the size cap.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT, DEFAULT_OUT, MAX_BYTES, SHELL_FILES, EXCLUDED_FROM_BUNDLE,
  MIN_DERIVED_DATA_FILES, runtimeDataFiles, playerFiles, buildPlan, prepare,
  SHELL_ONLY_FILES, shellOnlyPlan, shellScriptTags, injectShellScripts,
  assertShellScriptsPresent, WebDirError,
} from "./prepare-webdir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/* ───────────────────────────── the derivation ───────────────────────────── */

test("every fetchJson(data/...) call in the real app.js is derived", () => {
  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const derived = runtimeDataFiles(src);
  /* Cross-checked against an independent count of the call sites, so this does
     not simply re-run the same regex and agree with itself. `fetchJson(` also
     matches the function's own declaration, which is not a call — subtracting it
     is what makes the two counts comparable. */
  const callSites =
    (src.match(/fetchJson\(/g) || []).length - (src.match(/function fetchJson\(/g) || []).length;
  assert.equal(derived.length, callSites, "some fetchJson call was not derived into the plan");
  assert.ok(derived.includes("data/session.json"), "the session document must be in the bundle");
  assert.ok(derived.length >= MIN_DERIVED_DATA_FILES);
  for (const f of derived) assert.match(f, /^data\/[^/]+\.json$/);
});

test("data/ paths that are only mentioned, never fetched, stay out of the bundle", () => {
  const src = [
    '  forays: null,             // data/forays.json   — may be absent',
    '/* see the data/app-links.json research */',
    'const x = "data/catalog-breadth.json";',
    'await fetchJson("data/session.json");',
  ].join("\n");
  assert.deepEqual(runtimeDataFiles(src), ["data/session.json"]);
});

test("quote style does not change the derivation, and duplicates collapse", () => {
  const src = `fetchJson('data/a.json') fetchJson("data/b.json") fetchJson(\`data/c.json\`) fetchJson("data/a.json")`;
  assert.deepEqual(runtimeDataFiles(src), ["data/a.json", "data/b.json", "data/c.json"]);
});

test("a broken derivation is a hard error, not a small bundle", () => {
  /* THE FAILS-GREEN CASE, and the reason MIN_DERIVED_DATA_FILES exists. If
     fetchJson is renamed, the regex matches nothing; without this guard the
     script would cheerfully emit a shell with no session document, pass the size
     cap, and exit 0. The app would launch to an error card. */
  const fake = makeFakeRepo({ appSrc: 'await loadJson("data/session.json");' });
  assert.throws(() => buildPlan(fake), /Derived only 0 runtime data file/);
});

test("a fetched file that is not on disk fails the build", () => {
  const fake = makeFakeRepo({ extraFetches: ["data/not-generated-yet.json"] });
  assert.throws(() => buildPlan(fake), /not on disk/);
});

/* ────────────────────────────── the copy plan ───────────────────────────── */

test("the plan carries the shell, the player and nothing else from the root", () => {
  const plan = buildPlan(ROOT);
  for (const f of SHELL_FILES) assert.ok(plan.includes(f), `${f} missing from the plan`);
  assert.ok(plan.includes("player/client.js"));
  assert.ok(plan.includes("index.html"), "without index.html it is not a valid webDir");
});

test("no test file and no service worker is ever in the plan", () => {
  const plan = buildPlan(ROOT);
  const tests = plan.filter((f) => f.includes(".test."));
  assert.deepEqual(tests, [], "test suites must not ship to devices");
  for (const bad of EXCLUDED_FROM_BUNDLE) {
    assert.ok(!plan.includes(bad), `${bad} must never be bundled — the shell does not register it`);
  }
  assert.ok(!plan.includes("sw.js"));
});

test("no pipeline input is in the plan", () => {
  /* The named enemies. These are the files whose accidental inclusion is the
     whole reason the size cap exists. */
  const plan = buildPlan(ROOT);
  for (const big of [
    "data/breadth-classification.json",
    "data/catalog-breadth.json",
    "data/catalog-breadth-intl.json.gz",
    "data/episode-archive.json.gz",
    "data/transcript-availability.json",
  ]) {
    assert.ok(!plan.includes(big), `${big} is a pipeline input, not client data`);
  }
});

test("the plan is closed under the player's own imports", () => {
  /* The anti-fork test. `playerFiles` takes "every non-test .js in player/",
     which is correct only while the player is a flat directory of siblings. The
     day a module moves into `player/backends/`, this fails instead of shipping an
     app whose very first import 404s. */
  const plan = new Set(buildPlan(ROOT));
  const missing = [];
  for (const rel of plan) {
    if (!rel.startsWith("player/")) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (!plan.has(target)) missing.push(`${rel} imports ${m[1]} -> ${target}, which is not bundled`);
    }
  }
  assert.deepEqual(missing, []);
});

test("index.html's own script and style references are all bundled", () => {
  const plan = new Set(buildPlan(ROOT));
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|json|png))"/g)) {
    assert.ok(plan.has(m[1]), `index.html references ${m[1]} but the bundle does not carry it`);
  }
});

/* ──────────────────────────────── the output ────────────────────────────── */

test("prepare copies the plan and reports its size", () => {
  const fake = makeFakeRepo();
  const r = prepare({ root: fake, out: "www" });
  assert.ok(fs.existsSync(path.join(fake, "www", "index.html")));
  assert.ok(fs.existsSync(path.join(fake, "www", "data", "session.json")));
  assert.ok(fs.existsSync(path.join(fake, "www", "player", "client.js")));
  assert.equal(fs.existsSync(path.join(fake, "www", "sw.js")), false, "sw.js was copied into the bundle");
  assert.equal(fs.existsSync(path.join(fake, "www", "player", "client.test.js")), false);
  assert.equal(fs.existsSync(path.join(fake, "www", "data", "huge-pipeline-input.json")), false);
  assert.equal(r.total, r.files.reduce((n, f) => n + f.bytes, 0));
});

test("prepare rebuilds from scratch, so a removed file does not linger", () => {
  /* A stale file in a build artefact is how "we deleted that months ago" ends up
     on a device. */
  const fake = makeFakeRepo();
  prepare({ root: fake, out: "www" });
  fs.writeFileSync(path.join(fake, "www", "ghost.js"), "// left over");
  prepare({ root: fake, out: "www" });
  assert.equal(fs.existsSync(path.join(fake, "www", "ghost.js")), false);
});

test("exceeding the size cap fails loudly and names the biggest files", () => {
  /* #36 asks for this specifically: the cap must FAIL, not warn. */
  const fake = makeFakeRepo({ bigDataBytes: 400 * 1024 });
  assert.throws(
    () => prepare({ root: fake, out: "www", maxBytes: 100 * 1024 }),
    (e) => /exceeds the/.test(e.message) && /Largest files/.test(e.message) && /data\/session\.json/.test(e.message)
  );
});

test("prepare refuses an output directory it should not be deleting", () => {
  const fake = makeFakeRepo();
  /* `prepare` starts by recursively deleting its output. A typo'd --out is then a
     data-loss bug, so the path is constrained twice: inside the repo, and named
     `www`. CLAUDE.md § Never discard uncommitted work. */
  assert.throws(() => prepare({ root: fake, out: path.join("..", "www") }), /inside the repo/);
  assert.throws(() => prepare({ root: fake, out: "player" }), /named "www"/);
  assert.ok(fs.existsSync(path.join(fake, "player", "client.js")), "the guard let a real directory be deleted");
});

/* ─────────────────────── the real repo, today's numbers ─────────────────── */

test("REAL REPO: today's bundle is under the 3 MB cap", () => {
  /* Deliberately not mocked. This is the early-warning signal for the file that
     will actually push the bundle over: discover.json, 1.63 MB and growing. If
     this fails, the fix is a smaller client payload, not a bigger cap. */
  const plan = buildPlan(ROOT);
  const total = plan.reduce((n, rel) => n + fs.statSync(path.join(ROOT, rel)).size, 0);
  assert.ok(
    total <= MAX_BYTES,
    `the bundle is ${(total / 1024 / 1024).toFixed(2)} MB, over the ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB cap`
  );
  assert.ok(total > 512 * 1024, `the bundle is only ${(total / 1024).toFixed(0)} KB — the plan has probably collapsed`);
});

test("REAL REPO: DEFAULT_OUT is the webDir capacitor.config.json declares", () => {
  /* The two would otherwise drift into "the script writes one directory and
     Capacitor bundles another", which produces an app running last week's code. */
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "mobile", "capacitor.config.json"), "utf8"));
  assert.equal(path.resolve(ROOT, DEFAULT_OUT), path.resolve(ROOT, "mobile", cfg.webDir));
});

test("REAL REPO: REPO_ROOT resolves to the repo, not to tools/mobile", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "CLAUDE.md")));
  assert.equal(path.resolve(REPO_ROOT), path.resolve(ROOT));
});

/* ──────────────────────────────── the fixture ───────────────────────────── */

/** A minimal repo shaped like this one: the shell files, a flat `player/` with
 *  one import between modules and one test file, and a `data/` holding both
 *  client data and a pipeline input. */
function makeFakeRepo({ appSrc = null, extraFetches = [], bigDataBytes = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-webdir-"));
  const fetches = [
    "data/session.json", "data/taxonomy.json", "data/discover.json",
    "data/item-tags.json", "data/forays.json", "data/segments.json",
    ...extraFetches,
  ];
  const src = appSrc ?? fetches.map((f) => `await fetchJson("${f}");`).join("\n");

  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write("app.js", src);
  for (const f of SHELL_FILES) if (f !== "app.js") write(f, `/* ${f} */`);
  /* index.html needs a REAL head, because `prepare` injects the shell-only script
     tags before `</head>` and refuses to guess when the anchor is missing. Written
     with the CSP meta in it so the ordering assertion — tags after the policy, not
     before it — has something to be about. */
  write(
    "index.html",
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'">\n' +
      "<title>Foray</title>\n</head>\n<body>\n<script src=\"app.js\"></script>\n</body>\n</html>\n"
  );
  /* The shell-only sources live outside the site's own tree, so they are not
     covered by the SHELL_FILES loop above. */
  for (const f of SHELL_ONLY_FILES) write(f.src, "/* the shell's foreground-service bridge */\n");
  write("sw.js", 'const CACHE = "foray-v4";');
  write("player/client.js", 'import { x } from "./queue-manager.js";');
  write("player/queue-manager.js", "export const x = 1;");
  write("player/client.test.js", "// a suite, must not ship");
  write("data/huge-pipeline-input.json", "{}");
  for (const f of fetches) {
    if (!fs.existsSync(path.join(root, f))) {
      write(f, f === "data/session.json" && bigDataBytes ? "x".repeat(bigDataBytes) : "{}");
    }
  }
  /* `extraFetches` names files that must be MISSING, so undo the loop for them. */
  for (const f of extraFetches) fs.rmSync(path.join(root, f), { force: true });
  return root;
}

/* ───────── the shell-only script, which is the one thing that is not a copy ──── */

test("the shell's foreground-service bridge really is on disk where the plan says", () => {
  /* REAL REPO. A missing source is a hard error rather than a skip, and this is the
     test that says the path in SHELL_ONLY_FILES is not a typo today. Rename the
     plugin's web/ directory and the bundle would otherwise lose its only link to
     the native foreground service while staying under the size cap, building,
     installing and playing. */
  const files = shellOnlyPlan(ROOT);
  assert.ok(files.length >= 1, "there is no shell-only file at all any more");
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f.src)), `${f.src} is missing`);
    assert.ok(!f.dest.includes("/"), `${f.dest} should sit at the bundle root`);
  }
});

test("a missing shell-only source is a hard error, not a smaller bundle", () => {
  const fake = makeFakeRepo();
  for (const f of SHELL_ONLY_FILES) fs.rmSync(path.join(fake, f.src), { force: true });
  assert.throws(
    () => prepare({ root: fake, out: path.join("mobile", "www") }),
    (e) => /shell-only files are missing/.test(e.message) && /background audio/.test(e.message)
  );
});

test("the script tag is derived from the file list, so the two cannot drift", () => {
  /* Writing the filename twice is how a rename lands the file in the bundle and
     leaves the tag pointing at the old name — a 404 in the app and nothing else. */
  const tags = shellScriptTags([{ src: "a/b/c.js", dest: "c.js", module: true }]);
  assert.deepEqual(tags, ['<script type="module" src="c.js"></script>']);
  const classic = shellScriptTags([{ src: "a/b/c.js", dest: "c.js" }]);
  assert.deepEqual(classic, ['<script src="c.js"></script>']);
  for (const tag of shellScriptTags()) {
    const dest = /src="([^"]+)"/.exec(tag)[1];
    assert.ok(
      SHELL_ONLY_FILES.some((f) => f.dest === dest),
      `${tag} points at ${dest}, which is not in SHELL_ONLY_FILES`
    );
  }
});

test("the tags go inside the head, after the CSP meta rather than before it", () => {
  const html =
    '<!doctype html>\n<head>\n<meta charset="utf-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'">\n' +
    "</head>\n<body></body>\n";
  const out = injectShellScripts(html);
  assert.equal(out.changed, true);
  const tag = shellScriptTags()[0];
  const at = out.html.indexOf(tag);
  assert.ok(at > out.html.indexOf("Content-Security-Policy"), "the tag landed ahead of the policy that allows it");
  assert.ok(at < out.html.indexOf("</head>"), "the tag landed outside the head");
  assert.ok(at < out.html.indexOf("<body>"));
});

test("injection is idempotent, because cap sync and CI both re-run it", () => {
  const html = "<head>\n</head>\n<body></body>";
  const once = injectShellScripts(html);
  const twice = injectShellScripts(once.html);
  assert.equal(twice.changed, false);
  assert.equal(twice.html, once.html);
  const tag = shellScriptTags()[0];
  assert.equal(twice.html.split(tag).length - 1, 1, "the tag was added twice");
});

test("an index.html with no </head> is refused rather than guessed at", () => {
  assert.throws(() => injectShellScripts("<html><body>no head</body></html>"), WebDirError);
  assert.throws(() => injectShellScripts(""), WebDirError);
  assert.throws(
    () => injectShellScripts("<head></head><!-- </head> --><body></body>"),
    (e) => e instanceof WebDirError && /more than once/.test(e.message)
  );
});

test("assertShellScriptsPresent is a real guard and not decoration", () => {
  /* The anti-fails-green check, tested directly for the reason
     inject-background-audio.mjs's assertModePresent gives: an adversarial pass
     replaced that one's inline version with `if (false)` and the suite stayed
     green. Every failure mode in injectShellScripts degrades to "returned the
     input unchanged and reported success" without this. */
  const good = injectShellScripts("<head>\n</head><body></body>").html;
  assert.equal(assertShellScriptsPresent(good), true);
  assert.throws(() => assertShellScriptsPresent("<head></head><body></body>"), WebDirError);
  /* Present, but AFTER the head — CSP-governed markup order is the whole reason the
     position matters, so a tag in the body must fail too. */
  const tag = shellScriptTags()[0];
  assert.throws(
    () => assertShellScriptsPresent(`<head></head><body>${tag}</body>`),
    (e) => e instanceof WebDirError && /after <\/head>/.test(e.message)
  );
});

test("prepare copies the shell-only file and leaves the tag in the written index.html", () => {
  const fake = makeFakeRepo();
  const r = prepare({ root: fake, out: path.join("mobile", "www") });
  const outDir = path.join(fake, "mobile", "www");
  for (const f of SHELL_ONLY_FILES) {
    assert.ok(fs.existsSync(path.join(outDir, f.dest)), `${f.dest} is not in the bundle`);
    assert.ok(r.files.some((x) => x.rel === f.dest), `${f.dest} is not in the reported file list`);
  }
  /* Read off DISK, not out of the returned value: a write that did not land is the
     case an in-memory assertion cannot see. */
  const written = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.equal(assertShellScriptsPresent(written), true);
  assert.equal(r.total, r.files.reduce((n, f) => n + f.bytes, 0), "the injected bytes are not in the total");
});

test("the SITE's index.html is not modified — the injection is to the copy only", () => {
  /* The bundle's index.html differs from the root's by one line, and the direction
     that must never happen is the other one. A shell-only script tag in the file
     GitHub Pages serves would 404 for every real visitor. */
  const fake = makeFakeRepo();
  const before = fs.readFileSync(path.join(fake, "index.html"), "utf8");
  prepare({ root: fake, out: path.join("mobile", "www") });
  assert.equal(fs.readFileSync(path.join(fake, "index.html"), "utf8"), before);
});

test("REAL REPO: the site's index.html carries no shell-only tag", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const f of SHELL_ONLY_FILES) {
    assert.ok(
      !html.includes(f.dest),
      `index.html references ${f.dest}, which only exists inside the native bundle — ` +
        `the website would 404 on it.`
    );
  }
});
