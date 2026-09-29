/* index.html names the deploy it belongs to (round-3 audit, app-3-3).
 *
 * The worker broadcasts "generation-changed" to every open page when it
 * promotes a deploy, and app.js used to show "4a updated in the background, so
 * what you're looking at is one version behind" to all of them, including a
 * page that had just loaded that very deploy live. The page could not tell,
 * because it did not know which deploy it was running. The deploy build now
 * stamps `<meta name="foray-deploy-id">` in index.html next to sw.js's
 * BUILD_ID (tools/ci/generate-manifest.mjs), and app.js compares.
 *
 * The meta lives inside index.html, whose bytes feed the deploy id, so the id
 * is computed with that attribute read as "unstamped". This suite pins that the
 * stamp is self-consistent: stamping does not move the id, the manifest lists
 * the stamped bytes sw.js will fetch and verify, and --verify catches a meta
 * that disagrees. The app.js half is in test/sw-generation.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const gm = import("../tools/ci/generate-manifest.mjs");
const fd = import("../tools/ci/forays-directory.mjs");

const META_UNSTAMPED = '<meta name="foray-deploy-id" content="unstamped">';
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* A scratch tree holding every file the generator lists, with tiny LF bodies,
   and the real directory documents (the pointer builder validates them). */
async function scratchTree({ withMeta = true } = {}) {
  const { listedFiles } = await gm;
  const { DIRECTORY_FILES } = await fd;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-id-meta-"));
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const directory = new Set(Object.values(DIRECTORY_FILES));
  for (const rel of listedFiles(ROOT).map((f) => f.split(path.sep).join("/"))) {
    if (rel === "index.html") {
      put(rel, `<!doctype html><html><head>\n${withMeta ? META_UNSTAMPED + "\n" : ""}<title>4a</title></head></html>\n`);
    } else if (directory.has(rel)) {
      put(rel, fs.readFileSync(path.join(ROOT, rel)));
    } else if (rel.endsWith(".png") || rel.endsWith(".woff2")) {
      put(rel, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    } else {
      put(rel, `/* ${rel} */\n`);
    }
  }
  put("sw.js", 'const CACHE_PREFIX = "foray-gen-";\nconst BUILD_ID = "unstamped";\n');
  return dir;
}

const BUILT_AT = "2026-09-25T12:00:00.000Z";

test("the build stamps index.html's deploy-id meta with the same id it stamps into sw.js", async () => {
  /* MUTATION: drop the stampDeployMeta call in stampBuild — the page keeps
     "unstamped" and can never recognise its own deploy. */
  const { computeManifest, stampBuild, stampedProblems, readDeployMeta } = await gm;
  const dir = await scratchTree();
  try {
    const sourceId = computeManifest(dir).deploy_id;
    const r = stampBuild(dir, { builtAt: BUILT_AT });
    assert.equal(r.deployId, sourceId, "stamping must not move the id it stamps (the meta is read as unstamped)");
    assert.equal(readDeployMeta(dir), sourceId);
    const sw = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
    assert.match(sw, new RegExp(`const BUILD_ID = "${sourceId}";`));
    assert.deepEqual(stampedProblems(dir), [], "a freshly stamped tree verifies");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the manifest lists the STAMPED index.html bytes, which is what sw.js fetches and verifies", async () => {
  /* MUTATION: compute the manifest before stamping the meta and keep it — the
     listed hash is the unstamped one, and every install would fail as torn. */
  const { stampBuild } = await gm;
  const dir = await scratchTree();
  try {
    const r = stampBuild(dir, { builtAt: BUILT_AT });
    const onDisk = fs.readFileSync(path.join(dir, "index.html"));
    assert.ok(onDisk.toString("utf8").includes(`content="${r.deployId}"`), "premise: index.html is stamped");
    assert.equal(r.manifest.files["index.html"], "sha256:" + sha(onDisk));
    const written = JSON.parse(fs.readFileSync(path.join(dir, "deploy-manifest.json"), "utf8"));
    assert.equal(written.files["index.html"], "sha256:" + sha(onDisk));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--verify catches an index.html whose deploy-id meta disagrees with the tree", async () => {
  /* MUTATION: drop the meta check in stampedProblems — a hand-edited meta
     ships, and pages compare against a deploy that does not exist. */
  const { stampBuild, stampedProblems } = await gm;
  const dir = await scratchTree();
  try {
    const r = stampBuild(dir, { builtAt: BUILT_AT });
    const abs = path.join(dir, "index.html");
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace(`content="${r.deployId}"`, 'content="0000000000000000"'));
    const problems = stampedProblems(dir);
    assert.ok(problems.some((p) => /foray-deploy-id meta is "0000000000000000"/.test(p)), problems.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a source tree carrying a stamped deploy-id meta is refused, like a stamped BUILD_ID", async () => {
  const { sourceProblems } = await gm;
  const dir = await scratchTree();
  try {
    const abs = path.join(dir, "index.html");
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace('content="unstamped"', 'content="abcdef0123456789"'));
    const problems = sourceProblems(dir);
    assert.ok(problems.some((p) => /foray-deploy-id meta carries "abcdef0123456789"/.test(p)), problems.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed index.html carries the meta, unstamped", async () => {
  const { readDeployMeta } = await gm;
  assert.equal(readDeployMeta(ROOT), "unstamped");
});

test("a tree whose index.html has no deploy-id meta hashes exactly as before", async () => {
  /* Fixtures (and any tree built before this change) keep deploy_id ===
     deployIdFrom(files): nothing about the id derivation moved for them. */
  const { computeManifest, readDeployMeta } = await gm;
  const { deployIdFrom } = await fd;
  const dir = await scratchTree({ withMeta: false });
  try {
    const m = computeManifest(dir);
    assert.equal(readDeployMeta(dir), null);
    assert.equal(m.deploy_id, deployIdFrom(m.files));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
