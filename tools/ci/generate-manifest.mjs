#!/usr/bin/env node
/* The deploy stamp: `deploy-manifest.json`, `data/forays-directory.json` and
 * `sw.js`'s `BUILD_ID` — generated INTO A BUILT TREE, never committed.
 *
 * WHAT THE STAMP IS (#233 remainder, M4; FD-02)
 * `sw.js` stages and atomically promotes one content-addressed generation per
 * deploy. It needs three things that are pure functions of the shipped bytes:
 *   - `deploy-manifest.json` — sha256 per shipped file and a `deploy_id` derived
 *     from all of them together (first 16 hex of sha256 over the sorted
 *     "path:filehash\n" lines — `deployIdFrom` in `forays-directory.mjs`).
 *     Content-derived, so it changes iff a listed file's CONTENT changes.
 *   - `sw.js`'s `BUILD_ID` set to that id, because a browser only re-runs a
 *     worker's `install()` (and so only re-reads the manifest) when the fetched
 *     `sw.js` bytes differ from the registered copy. An `app.js`-only deploy
 *     would otherwise leave every returning visitor on the old generation.
 *   - `data/forays-directory.json`, the Foray directory pointer the native shell
 *     reads from the live origin (`forays-directory.mjs`). It names the deploy id
 *     and is listed in the manifest, so it cannot feed the id itself.
 *
 * WHY IT IS NO LONGER COMMITTED (issue #701, 2026-09-24)
 * These three used to be committed, generated on every PR by
 * `manifest-autofix.yml`, and checked by `--check`. Because the deploy id is a
 * hash over every shipped file, ANY two PRs that change any shipped file
 * disagree on the manifest's `deploy_id`, on `sw.js`'s `BUILD_ID` line and on the
 * pointer's `version` — so every merge to `main` made every other open PR
 * conflict, and PRs merged one at a time with a hand resolution each (six for
 * four PRs on 2026-09-14; native-engine PRs into `engine/m1` on 2026-09-24).
 * No committed form can avoid that: a content hash over files two branches both
 * change is a conflict by construction, and GitHub's merge does not run custom
 * merge drivers. So the stamp is computed where the bytes are actually shipped:
 *
 *   - Vercel (the origin the phones read the pointer from, `app.js`'s
 *     `API_ORIGIN`): `vercel.json`'s `buildCommand`, `tools/web/prepare-dist.mjs`,
 *     copies the allowlist into `dist/` and calls `stampBuild(dist)`.
 *   - GitHub Pages: `.github/workflows/pages.yml` checks out `main`, runs
 *     `--stamp .` on that throwaway checkout and deploys it — the same tree the
 *     legacy "deploy from branch" build served, plus the stamp.
 *   - The native bundle (`tools/mobile/prepare-webdir.mjs`): no worker and no
 *     manifest, but it carries the deploy id (`build-stamp.json`) and the seed's
 *     pointer, both computed in memory by `sourceStamp(root)`.
 *
 * The committed `sw.js` carries `BUILD_ID = "unstamped"` forever, and
 * `.gitignore` names the other two. `--check` (the required `data-and-site`
 * gate) fails if either generated file is tracked or `sw.js` carries a stamp,
 * so the conflict magnet cannot come back through a stray `git add`.
 *
 * WHY NOT `manifest.json` — THAT NAME IS TAKEN
 * `manifest.json` is the PWA web-app manifest `index.html` links. This file is
 * `deploy-manifest.json` specifically to avoid clobbering it.
 *
 * WHICH FILES ARE LISTED
 * Exactly what sw.js needs for one complete generation: the app shell (also
 * `tools/web/prepare-dist.mjs`'s SHELL — this SHELL additionally covers
 * `manifest.json`), the brand faces, every player module the client loads, and
 * the runtime `data/*.json` app.js's `init()` fetches (kept in sync with
 * prepare-dist's RUNTIME_DATA by design), plus the pointer. The manifest never
 * lists itself (circular) and never feeds the pointer into `deploy_id`.
 *
 * USAGE
 *   node tools/ci/generate-manifest.mjs --check        # CI: nothing generated is committed
 *   node tools/ci/generate-manifest.mjs --stamp <dir>  # stamp a built tree in place (Pages)
 *   node tools/ci/generate-manifest.mjs --verify <dir> # re-derive a built tree's stamp and diff it
 *
 * `--stamp` and `prepare-dist.mjs` both REFUSE A CRLF TREE (`crlf-guard.mjs`):
 * the hashes must describe the LF bytes the deploys serve.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { crlfOffenders, crlfFatalMessage } from "./crlf-guard.mjs";
import { POINTER_PATH, DIRECTORY_FILES, deployIdFrom, buildPointer, pointerText, pointerProblems, buildTimestamp } from "./forays-directory.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MANIFEST_FILE = "deploy-manifest.json";
export const SW_FILE = "sw.js";
/** The two files a build writes and the tree must never track. */
export const GENERATED = [MANIFEST_FILE, POINTER_PATH];
/** What the committed `sw.js` says. Never a hex id, so it can never be mistaken
    for a stamp (`player/build-stamp.js`'s `deployIdOf` refuses it by shape). */
export const UNSTAMPED_BUILD_ID = "unstamped";

const BUILD_ID_RE = /const BUILD_ID = "([^"]*)";/;

/* The modules that compute the stamp. `tools/web/vercel-should-build.mjs`'s
   STAMP_MODULES is the same list (a test pins the two equal); it is not
   imported from there because this module runs standalone in a scratch tree. */
export const STAMP_MODULE_FILES = [
  "tools/ci/generate-manifest.mjs",
  "tools/ci/forays-directory.mjs",
  "tools/ci/crlf-guard.mjs",
];

/* The app shell sw.js precaches on install. Kept explicit, same reasoning as
   prepare-dist.mjs's SHELL: a new root-level file must be added here
   deliberately. */
const SHELL = [
  "index.html",
  "app.js",
  "search-engine.js",
  "styles.css",
  "manifest.json",
  "icon-180.png",
  "icon-512.png",
];

/* Exactly what app.js fetches at runtime — kept in sync with
   tools/web/prepare-dist.mjs's RUNTIME_DATA by design (same derivation
   concern; see that script's header). */
const RUNTIME_DATA = [
  "session.json",
  "taxonomy.json",
  "discover.json",
  "semantic-index.json",
  "item-tags.json",
  "validated-links.json",
  "forays.json",
  "segments.json",
  "segment-sources.json",
  "catalog-client.json",
  "personas.json",
  "ladders.json",
  "dai-classification.json",
];

/* The player modules the client actually loads (#23/#24/#33). Test files are
   deliberately excluded — they never ship. */
function playerSources(root = ROOT) {
  return readdirSync(path.join(root, "player"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .sort()
    .map((f) => path.join("player", f));
}

/* The self-hosted brand faces styles.css's @font-face rules load (round-2
   audit, perf-5). Derived from the directory, like playerSources(), so a new
   face cannot be forgotten here. */
function fontSources(root = ROOT) {
  const dir = path.join(root, "fonts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".woff2"))
    .sort()
    .map((f) => path.join("fonts", f));
}

/** Every file whose hash feeds `deploy_id`, OS-separated, relative to `root`. */
function listedFiles(root = ROOT) {
  const files = [
    ...SHELL,
    ...fontSources(root),
    ...playerSources(root),
    ...RUNTIME_DATA.map((f) => path.join("data", f)),
  ];
  return [...new Set(files)].sort();
}

const posix = (rel) => rel.split(path.sep).join("/");

/**
 * The git pathspecs whose history dates a stamp (`buildTimestamp`'s `paths`):
 * every file the deploy id hashes, the directory files the pointer describes,
 * and the modules that compute both. The two derived directories are globbed
 * too, so a commit that DELETES a player module or a font face (and so changes
 * the deploy id) still dates the stamp. Test files are excluded: Vercel does not
 * build on them, and an input Vercel does not build on is exactly a date the
 * live pointer would not carry (PR #795 review, finding 1).
 */
function stampInputs(root = ROOT) {
  return [
    ...new Set([
      ...listedFiles(root).map(posix),
      ...Object.values(DIRECTORY_FILES),
      ...STAMP_MODULE_FILES,
      ":(glob)player/*.js",
      ":(glob)fonts/*.woff2",
    ]),
    ":(exclude,glob)player/*.test.js",
  ];
}

/** `buildTimestamp` over this tree's stamp inputs — what every stamper calls. */
function stampTimestamp(root = ROOT, opts = {}) {
  return buildTimestamp(root, { ...opts, paths: stampInputs(root) });
}

function sha256File(root, relPath) {
  const abs = path.join(root, relPath);
  if (!existsSync(abs)) {
    throw new Error(`generate-manifest: listed file is missing on disk: ${posix(relPath)}`);
  }
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/** The CRLF offenders among the files a stamp of `root` would hash. */
function crlfIn(root) {
  return crlfOffenders(root, listedFiles(root));
}

/* The manifest WITHOUT the pointer's entry: `deploy_id` over `listedFiles()`,
   which is the input set the pointer is derived from and must not join. */
function computeManifest(root = ROOT) {
  const files = {};
  for (const rel of listedFiles(root)) {
    /* Cache keys and sw.js fetches use forward slashes regardless of OS. */
    files[posix(rel)] = "sha256:" + sha256File(root, rel);
  }
  return { deploy_id: deployIdFrom(files), files };
}

/* Adds the pointer's hash as a manifest entry, keeping the listing sorted so a
   written manifest and a freshly computed one compare key-for-key. */
function withPointerEntry(root, manifest) {
  const files = { ...manifest.files, [POINTER_PATH]: "sha256:" + sha256File(root, POINTER_PATH) };
  const sorted = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k];
  return { deploy_id: manifest.deploy_id, files: sorted };
}

function readBuildId(root) {
  const abs = path.join(root, SW_FILE);
  if (!existsSync(abs)) return { id: null, error: `${SW_FILE} is missing` };
  const m = BUILD_ID_RE.exec(readFileSync(abs, "utf8"));
  if (!m) return { id: null, error: `${SW_FILE}'s BUILD_ID constant could not be located` };
  return { id: m[1], error: null };
}

/* Stamps sw.js's BUILD_ID in `root` with the deploy id — the half of the stamp
   that makes a manifest-only content change still change sw.js's own bytes. */
function stampBuildId(root, deployId) {
  const abs = path.join(root, SW_FILE);
  const src = readFileSync(abs, "utf8");
  if (!BUILD_ID_RE.test(src)) {
    throw new Error(`${SW_FILE}'s BUILD_ID constant could not be located — cannot stamp the deploy id.`);
  }
  writeFileSync(abs, src.replace(BUILD_ID_RE, `const BUILD_ID = "${deployId}";`));
}

/**
 * Stamp a BUILT tree in place: write the pointer, then the manifest that lists
 * it, then `sw.js`'s BUILD_ID — all three naming one deploy id computed from the
 * bytes `dir` actually holds. `dir` is `dist/` (prepare-dist) or a throwaway
 * checkout (the Pages workflow); never the working tree anybody commits from.
 *
 * `builtAt` is the pointer's `built_at` — pass `stampTimestamp(repoRoot).builtAt`
 * (the committer date of the newest commit to touch a stamp input). Throws on a
 * CRLF tree or a missing file.
 *
 * -> { deployId, manifest, pointer }
 */
function stampBuild(dir, { builtAt } = {}) {
  if (typeof builtAt !== "string" || !Number.isFinite(Date.parse(builtAt))) {
    throw new Error(`stampBuild needs an ISO-8601 builtAt, got ${JSON.stringify(builtAt)}`);
  }
  const bad = crlfIn(dir);
  if (bad.length) throw new Error(crlfFatalMessage(bad));
  const base = computeManifest(dir);
  /* Pointer first — its bytes are a manifest entry, so it has to be on disk in
     its final form before the manifest that names it is written. */
  const pointer = buildPointer(dir, base.deploy_id, new Date(builtAt));
  writeFileSync(path.join(dir, POINTER_PATH), pointerText(pointer));
  const manifest = withPointerEntry(dir, base);
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
  stampBuildId(dir, manifest.deploy_id);
  return { deployId: manifest.deploy_id, manifest, pointer };
}

/**
 * Everything wrong with the stamp in a BUILT tree: the manifest must be exactly
 * what the tree's bytes compute to (deploy id and every entry, the pointer's
 * included), the pointer must describe the tree under that id, and `sw.js` must
 * carry that id. Empty means the tree is safe to ship. A fresh re-derivation,
 * not a trust of what `stampBuild` returned: a build step that copied one more
 * file after stamping is exactly the torn deploy sw.js would refuse in production.
 */
function stampedProblems(dir) {
  const problems = [];
  const manifestAbs = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestAbs)) return [`${MANIFEST_FILE} is missing`];
  let written;
  try {
    written = JSON.parse(readFileSync(manifestAbs, "utf8"));
  } catch (err) {
    return [`${MANIFEST_FILE} is not valid JSON: ${err.message}`];
  }
  let base;
  try {
    base = computeManifest(dir);
  } catch (err) {
    return [err.message];
  }
  problems.push(...pointerProblems(dir, base.deploy_id).map((p) => `${POINTER_PATH}: ${p}`));
  if (existsSync(path.join(dir, POINTER_PATH))) {
    const expected = withPointerEntry(dir, base);
    if (written.deploy_id !== expected.deploy_id) {
      problems.push(`${MANIFEST_FILE} says deploy_id ${written.deploy_id} but the tree computes to ${expected.deploy_id}`);
    }
    const have = written.files || {};
    for (const k of Object.keys(expected.files)) {
      if (have[k] !== expected.files[k]) problems.push(`${MANIFEST_FILE} entry ${k} does not match the bytes on disk`);
    }
    for (const k of Object.keys(have)) {
      if (!(k in expected.files)) problems.push(`${MANIFEST_FILE} lists ${k}, which is not a shipped file`);
    }
  }
  const { id, error } = readBuildId(dir);
  if (error) problems.push(error);
  else if (id !== base.deploy_id) problems.push(`${SW_FILE}'s BUILD_ID is ${JSON.stringify(id)} but the tree computes to ${base.deploy_id}`);
  return problems;
}

/** `git <args>` in `root` -> stdout, or null on any failure. */
function gitOut(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (_) {
    return null;
  }
}

/**
 * Everything wrong with the SOURCE tree for the no-committed-stamp rule (#701):
 * a generated file tracked by git, a generated file git would not ignore, an
 * `sw.js` that carries a stamp, or a listed file missing (a stamp could not be
 * built at all). Empty means the tree is right. Fails CLOSED when git cannot
 * be read: this is the gate that keeps the conflict magnet out.
 */
function sourceProblems(root = ROOT) {
  const problems = [];
  const tracked = gitOut(root, ["ls-files", "--", ...GENERATED]);
  if (tracked === null) {
    problems.push("git ls-files could not be run, so whether a generated file is committed is unknown");
  } else {
    for (const rel of tracked.split("\n").map((l) => l.trim()).filter(Boolean)) {
      problems.push(`${rel} is committed. It is a build output (issue #701): \`git rm --cached ${rel}\``);
    }
  }
  /* `check-ignore` exits 1 when a path is NOT ignored, which execFileSync
     surfaces as a throw -> null. So null here means "not ignored" (or no git,
     already reported above). --no-index: answer from .gitignore alone, even for
     a path that happens to be tracked. */
  for (const rel of GENERATED) {
    const ignored = gitOut(root, ["check-ignore", "-q", "--no-index", "--", rel]);
    if (ignored === null && tracked !== null) {
      problems.push(`${rel} is not in .gitignore, so the next \`git add -A\` after a local build commits it`);
    }
  }
  const { id, error } = readBuildId(root);
  if (error) problems.push(error);
  else if (id !== UNSTAMPED_BUILD_ID) {
    problems.push(
      `${SW_FILE} carries BUILD_ID ${JSON.stringify(id)}; the committed file must say ${JSON.stringify(UNSTAMPED_BUILD_ID)}. ` +
        "The deploy builds stamp it (issue #701); a committed stamp is a merge conflict with every open PR."
    );
  }
  try {
    computeManifest(root);
  } catch (err) {
    problems.push(err.message);
  }
  return problems;
}

/**
 * The web's stamp for a SOURCE tree, computed in memory and written nowhere —
 * what `tools/mobile/prepare-webdir.mjs` bundles as the seed's pointer and the
 * build stamp. The deploy id equals the one the deploys compute for the same
 * commit, because they hash byte-identical copies of the same files.
 *
 * THE SEED'S `built_at` MUST NEVER BE LATER THAN THE LIVE POINTER'S for the same
 * content, or a phone reads the live pointer as OLDER than its own partial seed
 * and never fetches the whole set (PR #795 review, finding 1). `stampTimestamp`
 * gives every stamper the same date for the same content; the two cases where
 * this tree cannot know that date — a shallow clone whose depth does not reach
 * the newest input commit (`git-shallow`, which answers LATE) and no git at all
 * (`clock`) — return the deploy id with `pointer: null` and a `pointerReason`.
 * The bundle then carries no seed pointer, which the shell treats as unversioned
 * and re-fetches from (safe), rather than one that outranks the live deploy.
 *
 * -> { deployId, pointer, builtAt, pointerReason } or { deployId: null, reason }
 *    when a stamp for this tree would be wrong or impossible: a CRLF checkout
 *    (the id would name bytes no origin serves) or a tree missing a listed file
 *    (a fixture).
 */
function sourceStamp(root = ROOT, { env = process.env } = {}) {
  let base;
  try {
    base = computeManifest(root);
  } catch (err) {
    return { deployId: null, reason: err.message };
  }
  const bad = crlfIn(root);
  if (bad.length) {
    return { deployId: null, reason: `CRLF checkout (${bad.length} listed files) — its hashes are not the bytes the deploys serve` };
  }
  const { builtAt, source } = stampTimestamp(root, { env });
  if (source === "git-shallow" || source === "clock") {
    return {
      deployId: base.deploy_id,
      pointer: null,
      builtAt: null,
      pointerReason:
        source === "clock"
          ? "no git history, so the seed's built_at could be later than the live pointer's"
          : "shallow clone: the newest stamp-input commit is below its depth, so the seed's built_at could be later than the live pointer's — check out with fetch-depth: 0",
    };
  }
  return { deployId: base.deploy_id, pointer: buildPointer(root, base.deploy_id, new Date(builtAt)), builtAt, pointerReason: null };
}

function argAfter(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--write")) {
    console.error(
      "generate-manifest.mjs --write no longer exists (issue #701). deploy-manifest.json, " +
        "data/forays-directory.json and sw.js's BUILD_ID are build outputs now, never committed:\n" +
        "  - for a local site build:   node tools/web/prepare-dist.mjs   (stamps dist/)\n" +
        "  - to stamp a throwaway tree: node tools/ci/generate-manifest.mjs --stamp <dir>\n" +
        "There is nothing to regenerate in the working tree and nothing to commit."
    );
    process.exit(2);
  }

  if (argv.includes("--check")) {
    const problems = sourceProblems(ROOT);
    if (problems.length) {
      console.error("FATAL: the source tree carries a deploy stamp. These files are build outputs (issue #701):");
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    const { deploy_id } = computeManifest(ROOT);
    console.log(
      `ok — no generated deploy artefact is committed, sw.js is unstamped, ` +
        `and the ${listedFiles(ROOT).length} listed files are all present (this tree would ship as ${deploy_id})`
    );
    return;
  }

  const stampDir = argAfter(argv, "--stamp");
  if (argv.includes("--stamp")) {
    if (!stampDir) {
      console.error("usage: generate-manifest.mjs --stamp <dir>");
      process.exit(2);
    }
    const dir = path.resolve(stampDir);
    /* Stamping the working tree you commit from rewrites a tracked sw.js — the
       exact change `--check` then refuses. CI checkouts are throwaway. */
    if (!process.env.CI && realOrSelf(dir) === realOrSelf(ROOT)) {
      console.error(
        "FATAL: --stamp would rewrite this checkout's tracked sw.js. Stamp a copy " +
          "(node tools/web/prepare-dist.mjs builds and stamps dist/), or run it where CI=true on a throwaway checkout."
      );
      process.exit(1);
    }
    let r;
    try {
      r = stampBuild(dir, { builtAt: stampTimestamp(dir).builtAt });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const problems = stampedProblems(dir);
    if (problems.length) {
      console.error("FATAL: the freshly stamped tree does not verify:");
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log(
      `stamped ${path.relative(process.cwd(), dir) || "."} — deploy_id ${r.deployId}, ` +
        `${Object.keys(r.manifest.files).length} files, pointer built_at ${r.pointer.built_at}`
    );
    return;
  }

  const verifyDir = argAfter(argv, "--verify");
  if (argv.includes("--verify")) {
    if (!verifyDir) {
      console.error("usage: generate-manifest.mjs --verify <dir>");
      process.exit(2);
    }
    const problems = stampedProblems(path.resolve(verifyDir));
    if (problems.length) {
      console.error(`FATAL: ${verifyDir} is not a consistently stamped build:`);
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log(`${verifyDir} verifies — manifest, pointer and sw.js BUILD_ID agree with its bytes`);
    return;
  }

  console.error("usage: generate-manifest.mjs --check | --stamp <dir> | --verify <dir>");
  process.exit(2);
}

function realOrSelf(p) {
  let r;
  try { r = realpathSync(p); } catch (_) { r = path.resolve(p); }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/* Run only as a script, so a suite can import the helpers without triggering
   the CLI.

   REALPATH ON BOTH SIDES, CASE-FOLDED ON WINDOWS (round-2 review). Node
   realpaths the main module before it builds `import.meta.url`, but
   `process.argv[1]` is only made absolute — so from a symlinked checkout, a
   Windows junction, or a shell whose drive letter is cased differently, the
   two never matched and `--check` exited 0 WITHOUT CHECKING, letting a bad
   tree pass a local gate. */
function isEntryScript(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  return realOrSelf(argv1) === realOrSelf(fileURLToPath(metaUrl));
}

if (isEntryScript()) main();

export {
  computeManifest,
  listedFiles,
  playerSources,
  fontSources,
  isEntryScript,
  stampBuild,
  stampedProblems,
  sourceProblems,
  sourceStamp,
  stampInputs,
  stampTimestamp,
  SHELL,
  RUNTIME_DATA,
};
