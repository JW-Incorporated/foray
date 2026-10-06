/* The split of app.js into a core plus per-screen classic scripts (Redesign
 * 2026, phase 0d) — the invariants that keep it a split and not a mess.
 *
 * WHAT CAN GO WRONG, AND WHICH TEST OWNS IT
 *   1. A screen file on disk that index.html never loads (the screen silently
 *      stops working), or loaded twice, or loaded before app.js, or after
 *      boot.js (init() would run before the screens it renders exist).
 *   2. The same top-level name declared in two files. A duplicate `function`
 *      silently takes the later one; a duplicate `const` throws at load.
 *   3. A file the page loads but a shipping path forgets: the deploy manifest
 *      and dist (the web), the Capacitor bundle plan (the apps), the allow-list.
 *   4. A syntax error in a file (each is its own script, so one bad file takes
 *      out only its screens — which is exactly the failure that is easy to miss).
 *
 * Load-time ordering (a `const` in a later file read by an earlier one) is
 * proven by the ~77 suites that run the real files, one script per file in
 * index.html order, through test/helpers/app-source.js's runAppSource — a
 * ReferenceError at load fails every one of them.
 *
 * MUTATIONS (each run, each red):
 *   - delete one `<script src="ui/…">` tag from index.html        -> (1) names it
 *   - move `<script src="ui/boot.js">` above another ui tag        -> (1) boot last
 *   - paste a copy of any top-level function into a second ui file -> (2) names it
 *   - leave an unclosed brace at the end of any ui file            -> (4) names it
 *   - drop uiSources() from generate-manifest's listedFiles        -> (3) names the file
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { appFiles, readAppFile, ROOT } = require("./helpers/app-source.js");

const onDisk = fs.readdirSync(path.join(ROOT, "ui")).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).sort().map((f) => `ui/${f}`);

test("index.html loads app.js first, every ui/*.js exactly once, and ui/boot.js last", () => {
  const loaded = appFiles();
  assert.strictEqual(loaded[0], "app.js", "app.js is the core and loads first");
  assert.strictEqual(loaded[loaded.length - 1], "ui/boot.js", "ui/boot.js starts init(), so it loads after every screen");
  assert.deepStrictEqual([...new Set(loaded)], loaded, "no script is loaded twice");
  assert.deepStrictEqual([...loaded.slice(1)].sort(), onDisk, "the ui/ files on disk and the tags in index.html are the same set");
  assert.ok(onDisk.length >= 10, `fixture assumption: the split produced per-screen files (${onDisk.length})`);
});

test("only ui/boot.js calls init(), and it does so at its top level", () => {
  for (const f of appFiles()) {
    const calls = readAppFile(f).match(/^init\(\);/gm) || [];
    assert.strictEqual(calls.length, f === "ui/boot.js" ? 1 : 0, `${f}: top-level init() calls`);
  }
});

test("no top-level name is declared in two files", () => {
  const seen = new Map();
  const dupes = [];
  for (const f of appFiles()) {
    const src = readAppFile(f).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    for (const m of src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1] || m[2];
      if (seen.has(name) && seen.get(name) !== f) dupes.push(`${name} (${seen.get(name)} and ${f})`);
      else seen.set(name, f);
    }
  }
  assert.deepStrictEqual(dupes, [], "a name declared in two files");
  assert.ok(seen.size > 800, `fixture assumption: the scan sees the app's top-level declarations (${seen.size})`);
});

test("every file is a script that parses on its own", () => {
  for (const f of appFiles()) {
    assert.doesNotThrow(() => new vm.Script(readAppFile(f), { filename: f }), `${f} does not parse`);
  }
});

test("the web deploy ships every ui file: the manifest hashes it and dist copies it", async () => {
  const gm = await import(pathToFileURL(path.join(ROOT, "tools", "ci", "generate-manifest.mjs")).href);
  const listed = gm.listedFiles(ROOT).map((p) => p.split(path.sep).join("/"));
  for (const f of onDisk) assert.ok(listed.includes(f), `${f} is not in the deploy manifest's file list`);
  const dist = fs.readFileSync(path.join(ROOT, "tools", "web", "prepare-dist.mjs"), "utf8");
  assert.match(dist, /\buiSources\(\)/, "prepare-dist copies ui/*.js");
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  assert.ok(vercel.headers.some((h) => h.source === "/ui/(.*)" && /must-revalidate/.test(JSON.stringify(h.headers))), "vercel.json revalidates /ui/*.js like app.js");
});

test("the Capacitor bundle plan ships every ui file", async () => {
  const pw = await import(pathToFileURL(path.join(ROOT, "tools", "mobile", "prepare-webdir.mjs")).href);
  const plan = pw.buildPlan(ROOT);
  for (const f of onDisk) assert.ok(plan.includes(f), `${f} is not in the native bundle plan`);
  assert.ok(plan.includes("app.js"), "app.js is still in the plan");
});

test("path policy treats ui/ as app code beside app.js", async () => {
  const pp = await import(pathToFileURL(path.join(ROOT, "tools", "ci", "path-policy.mjs")).href);
  assert.ok(pp.ALLOWED_PREFIXES.includes("ui/"), "ui/ is on the allow-list on this branch");
  assert.ok(pp.ALLOWED_PREFIXES.includes("app.js"));
});
