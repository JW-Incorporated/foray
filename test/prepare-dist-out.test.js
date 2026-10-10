/* prepare-dist.mjs deletes its output directory before it builds, so `--out`
 * is validated first (round-3 audit, ci-release-15). `--out .` or `--out ..`
 * used to delete the checkout, uncommitted work included, and a bare `--out`
 * crashed with a TypeError instead of a usage error.
 *
 * The pure rule is tested on tools/web/out-dir.mjs. The script itself is only
 * ever run here from a SCRATCH COPY of itself and its imports, so a broken
 * guard deletes a temp directory, never this checkout.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const outDirModule = import("../tools/web/out-dir.mjs");

test("the default and a sibling or absolute build directory are accepted", async () => {
  const { resolveOutDir } = await outDirModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "out-dir-root-"));
  try {
    assert.equal(resolveOutDir([], root).out, path.join(root, "dist"));
    assert.equal(resolveOutDir(["--out", "build/site"], root).out, path.join(root, "build", "site"));
    const elsewhere = path.join(os.tmpdir(), "runner-temp", "dist");
    assert.equal(resolveOutDir(["--out", elsewhere], root).out, path.resolve(elsewhere));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the repo root, an ancestor of it, or a directory holding .git is refused", async () => {
  /* MUTATION: drop the ancestor check in resolveOutDir — `.`, `..` and `/`
     are accepted, and prepare-dist would rmSync the checkout. */
  const { resolveOutDir } = await outDirModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "out-dir-root-"));
  try {
    for (const bad of [".", "..", "../..", root, path.dirname(root), path.parse(root).root, "./"]) {
      const r = resolveOutDir(["--out", bad], root);
      assert.ok(r.error, `--out ${bad} must be refused`);
      assert.match(r.error, /refusing to delete/);
    }
    const other = path.join(root, "other-checkout");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    assert.match(resolveOutDir(["--out", other], root).error, /holds a \.git/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a bare or empty --out is a usage error, not a crash", async () => {
  const { resolveOutDir } = await outDirModule;
  assert.match(resolveOutDir(["--out"], ROOT).error, /needs a directory/);
  assert.match(resolveOutDir(["--out", ""], ROOT).error, /needs a directory/);
  assert.match(resolveOutDir(["--out", "--verbose"], ROOT).error, /needs a directory/);
});

/* A scratch tree with prepare-dist.mjs and the modules it imports, and a
   sentinel file standing in for somebody's uncommitted work. It sits one level
   inside its own temp parent, so even `--out ..` under a broken guard can only
   ever reach a directory this test created. */
function scratchScriptTree() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-dist-guard-"));
  const dir = path.join(parent, "checkout");
  fs.mkdirSync(dir);
  for (const rel of [
    "tools/web/prepare-dist.mjs",
    "tools/web/out-dir.mjs",
    "tools/ci/generate-manifest.mjs",
    "tools/ci/entry.mjs",
    "tools/ci/forays-directory.mjs",
    "tools/ci/catalogue-directory.mjs",
    "tools/ci/crlf-guard.mjs",
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  fs.writeFileSync(path.join(dir, "UNCOMMITTED-WORK.txt"), "precious\n");
  return { parent, dir };
}

test("prepare-dist exits 2 with usage for --out . / .. / bare, and deletes nothing", () => {
  /* MUTATION: move the resolveOutDir guard below the rmSync (or delete it) —
     the scratch tree's sentinel is deleted and the exit code is not 2. */
  const { parent, dir } = scratchScriptTree();
  try {
    for (const args of [["--out", "."], ["--out", ".."], ["--out"]]) {
      const r = spawnSync(process.execPath, [path.join(dir, "tools", "web", "prepare-dist.mjs"), ...args], {
        cwd: dir, encoding: "utf8",
      });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /usage: node tools\/web\/prepare-dist\.mjs/);
      assert.ok(fs.existsSync(path.join(dir, "UNCOMMITTED-WORK.txt")), `${args.join(" ")} deleted the checkout`);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

/* One real dist, built into a temp directory (prepare-dist deletes and
   rewrites only that) and shared by the two tests that read it. */
let builtDist = null;
function realDist() {
  if (builtDist) return builtDist;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-dist-real-"));
  const out = path.join(parent, "dist");
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "web", "prepare-dist.mjs"), "--out", out], {
    cwd: ROOT, encoding: "utf8",
  });
  builtDist = { parent, out, status: r.status, stderr: r.stderr };
  return builtDist;
}
after(() => {
  if (builtDist) fs.rmSync(builtDist.parent, { recursive: true, force: true });
});

test("CH-07 (P2-04): the dist's player/ modules are exactly the ones its stamped manifest lists", async () => {
  /* Two lists decided what player code ships: prepare-dist.mjs copied one
     directory walk into dist/ and generate-manifest.mjs hashed another for the
     SW to precache. They must be one list. MUTATION: give prepare-dist.mjs its
     own `readdirSync(player)` walk again — dist ships modules the manifest
     does not list and this goes red. */
  const { playerSources } = await import("../tools/ci/generate-manifest.mjs");
  const { out, status, stderr } = realDist();
  assert.equal(status, 0, stderr);
  const shipped = fs.readdirSync(path.join(out, "player")).filter((f) => f.endsWith(".js")).map((f) => `player/${f}`).sort();
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "deploy-manifest.json"), "utf8"));
  const listed = Object.keys(manifest.files).filter((k) => k.startsWith("player/")).sort();
  assert.ok(listed.includes("player/client.js"), "premise: the manifest lists the player");
  assert.deepEqual(shipped, listed);
  assert.deepEqual(listed, playerSources(ROOT).map((p) => p.split(path.sep).join("/")).sort());
});

test("the dist ships nothing from docs/, so the UX prototype is not on the app's origin (security-11)", () => {
  /* docs/ux/foray-m3-prototype.html has no CSP, inline scripts and unescaped
     innerHTML interpolation. Deployed into dist it shared the app's origin,
     where cp_sb_session lives. It used to be kept out by an always-empty
     EXTRAS list in prepare-dist.mjs, which CH2-18 deleted (T2-18): what dist
     ships is now generate-manifest's lists, so this reads the BUILT dist.
     MUTATION: append "docs/ux/foray-m3-prototype.html" to prepare-dist's
     DIST_SHELL — dist/docs/ exists and this goes red. */
  const { out, status, stderr } = realDist();
  assert.equal(status, 0, stderr);
  assert.ok(fs.existsSync(path.join(ROOT, "docs", "ux", "foray-m3-prototype.html")), "premise: the prototype exists to leave out");
  assert.equal(fs.existsSync(path.join(out, "docs")), false, "dist ships a docs/ directory");
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "tools", "web", "prepare-dist.mjs"), "utf8"), /\bEXTRAS\b/,
    "the dead EXTRAS list is back — an invitation to re-add the prototype");
});

test("the GitHub Pages artifact leaves the UX prototypes out too (security-11, the Pages half)", () => {
  /* Round-3 review (L4): prepare-dist dropped the prototype from the Vercel
     dist, but pages.yml uploads the whole checkout (`path: .`), so the same
     CSP-less page was still published on the Pages origin, the production web
     origin where cp_sb_session lives. MUTATION: delete the `rm -f docs/ux/*.html`
     step, or move it after upload-pages-artifact. */
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "pages.yml"), "utf8");
  const rm = yml.search(/^\s*run:\s*rm -f docs\/ux\/\*\.html\s*$/m);
  const upload = yml.indexOf("actions/upload-pages-artifact");
  const stamp = yml.indexOf("run: node tools/ci/generate-manifest.mjs --stamp");
  assert.ok(rm >= 0, "pages.yml must remove docs/ux/*.html from the artifact");
  assert.ok(upload > rm, "the removal must run before the artifact is uploaded");
  assert.ok(stamp > rm, "and before the stamp, so the stamped tree is the uploaded tree");
  assert.ok(fs.readdirSync(path.join(ROOT, "docs", "ux")).some((f) => f.endsWith(".html")), "premise: a prototype page exists to leave out");
});
