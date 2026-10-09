/* WHAT THE APP SHIPS HAS ONE OWNER (CH2-18; T2-03, T2-18 in
 * docs/roadmap/code-health-2.md).
 *
 * Three deploy paths ship the app: Vercel (`tools/web/prepare-dist.mjs` ->
 * `dist/`), GitHub Pages (`generate-manifest.mjs --stamp` over a checkout) and
 * the native bundle (`tools/mobile/prepare-webdir.mjs` -> `mobile/www`). They
 * used to keep three hand-synced copies of "the shell", "the runtime data" and
 * "the fonts", and nothing pinned them equal, so the failure shapes were:
 *   (a) a fourth woff2 with an `@font-face`: the web hashes and precaches it,
 *       the native bundle (CSP `font-src 'self'`) silently draws the fallback;
 *   (b) a new `fetchJson("data/new.json")` in app.js: the native bundle picks
 *       it up by scan, the deploy id ignores it and prepare-dist 404s it.
 *
 * `tools/ci/generate-manifest.mjs` is the owner. prepare-dist imports its lists;
 * prepare-webdir keeps its three font literals (they are the native
 * bundle-budget guard: a stray face must not ship silently) and its app.js scan
 * (now generate-manifest's `runtimeDataFiles`), and both are ASSERTED equal
 * here rather than derived.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  SHELL,
  RUNTIME_DATA,
  GENERATED,
  computeManifest,
  fontSources,
  listedFiles,
  playerSources,
  runtimeData,
  runtimeDataFiles as gmRuntimeDataFiles,
} from "./generate-manifest.mjs";
import { SHELL_FILES, runtimeDataFiles } from "../mobile/prepare-webdir.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const posix = (rel) => rel.split(path.sep).join("/");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* The data the web deploys ship though app.js fetches neither: the backend
   curation path reads ladders.json, and dai-classification.json is joined into
   catalog-client.json at build time (tools/build-catalog-client.mjs). Named
   here so the only allowed difference between the explicit list and the scan
   is a stated one. */
const SHIPPED_UNFETCHED = ["dai-classification.json", "ladders.json"];

test("the web dist ships exactly generate-manifest's lists, plus sw.js, the unpinned show index, the site association and the stamp", () => {
  /* Builds a real dist into a temp directory (prepare-dist deletes and
     rewrites only that). KILLED BY: dropping a file from generate-manifest's
     SHELL or RUNTIME_DATA (dist stops shipping it), re-adding a private list
     to prepare-dist that names one more file, or putting anything into the
     copy loop (a docs/ page included). */
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ship-lists-dist-"));
  const out = path.join(parent, "dist");
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "web", "prepare-dist.mjs"), "--out", out], {
      cwd: ROOT, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const shipped = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else shipped.push(posix(path.relative(out, abs)));
      }
    };
    walk(out);
    const expected = [
      ...SHELL,
      "sw.js",
      ...fontSources(ROOT).map(posix),
      ...playerSources(ROOT).map(posix),
      ...RUNTIME_DATA.map((f) => `data/${f}`),
      "data/show-index.tsv",
      ".well-known/apple-app-site-association",
      ...GENERATED,
    ];
    assert.ok(fs.existsSync(path.join(ROOT, "data", "show-index.tsv")), "premise: the unpinned show index exists");
    assert.deepEqual(shipped.sort(), [...new Set(expected)].sort());
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the native bundle's font literals are exactly generate-manifest.fontSources()", () => {
  /* The three literals stay (the native bundle-budget guard); this pin is
     what makes them safe. KILLED BY: a fourth .woff2 added to fonts/ (the web
     lists it, the bundle would not ship it), or a literal dropped from
     prepare-webdir's SHELL_FILES. */
  const nativeFonts = SHELL_FILES.filter((f) => f.endsWith(".woff2")).sort();
  assert.equal(nativeFonts.length, 3, "premise: the three brand faces");
  assert.deepEqual(nativeFonts, fontSources(ROOT).map(posix).sort());
});

test("the native bundle's shell files are exactly generate-manifest's SHELL", () => {
  /* sw.js is the web-only addition (prepare-webdir refuses it by name). KILLED
     BY: a root file added to one SHELL and not the other. */
  assert.deepEqual(SHELL_FILES.filter((f) => !f.endsWith(".woff2")).sort(), [...SHELL].sort());
  assert.ok(!SHELL.includes("sw.js"), "sw.js is added by prepare-dist, never listed in the shared SHELL");
});

test("app.js's fetchJson scan is inside RUNTIME_DATA, and the only data shipped unfetched is the named pair", () => {
  /* KILLED BY: a `fetchJson("data/new.json")` added to app.js without a
     RUNTIME_DATA entry (red here), or a RUNTIME_DATA entry app.js stops
     fetching (the difference grows past the named pair). */
  const scanned = runtimeDataFiles(read("app.js")).map((rel) => rel.replace(/^data\//, ""));
  assert.ok(scanned.length >= 6, "premise: the scan still finds app.js's fetches");
  for (const f of scanned) assert.ok(RUNTIME_DATA.includes(f), `app.js fetches data/${f}, which RUNTIME_DATA does not list`);
  assert.deepEqual(RUNTIME_DATA.filter((f) => !scanned.includes(f)).sort(), SHIPPED_UNFETCHED);
});

test("a fetchJson app.js adds joins the deploy id without a list edit, and RUNTIME_DATA stays the floor", () => {
  /* T2-03 (b): the native bundle picked a new fetch up by scan while the
     deploy id ignored it and prepare-dist 404'd it. Now the web's data list is
     runtimeData(): RUNTIME_DATA plus the scan. KILLED BY: listedFiles reading
     RUNTIME_DATA alone again (data/new.json is unlisted and its bytes do not
     move the id), or runtimeData dropping RUNTIME_DATA (a stub app.js that
     fetches nothing would list no session.json). */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-lists-derive-"));
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  try {
    for (const rel of SHELL) put(rel, `/* ${rel} */\n`);
    put("player/client.js", "export const x = 1;\n");
    for (const f of RUNTIME_DATA) put(`data/${f}`, "{}\n");
    const listed = () => listedFiles(dir).map(posix);

    assert.deepEqual(runtimeData(dir), RUNTIME_DATA, "a stub app.js that fetches nothing still ships the whole floor");

    put("app.js", 'const n = await fetchJson("data/new.json");\n');
    put("data/new.json", '{"v":1}\n');
    assert.deepEqual(runtimeData(dir), [...RUNTIME_DATA, "new.json"]);
    assert.ok(listed().includes("data/new.json"), "the new fetch is a listed (hashed, precached, copied) file");
    const before = computeManifest(dir);
    assert.ok("data/new.json" in before.files);
    put("data/new.json", '{"v":2}\n');
    assert.notEqual(computeManifest(dir).deploy_id, before.deploy_id, "its bytes move the deploy id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare-webdir reads app.js with generate-manifest's scanner, not a copy", () => {
  /* One scanner for both deploys. KILLED BY: a private runtimeDataFiles in
     prepare-webdir.mjs again (a different function object). */
  assert.equal(runtimeDataFiles, gmRuntimeDataFiles);
});
