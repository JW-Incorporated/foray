/* Assemble the deployable static site into dist/.
   Used by the Vercel build; also the basis for Capacitor's webDir (#36).

   WHY A BUILD STEP FOR A NO-BUILD SITE
   The site's source IS the repo root, which is convenient for GitHub Pages and
   terrible for anything else: the same directory holds ~55 MB of pipeline
   inputs (`data/catalog-breadth.json` 12 MB, two .gz archives ~26 MB),
   `backend/` source, `ios/`, `tools/`, and the test files. Deploying the root
   would publish all of it and blow past sensible bundle sizes to serve a client
   that actually needs about 1.5 MB.

   So this copies the allowlist — nothing is excluded by pattern, because an
   exclude list silently ships whatever gets added next. The web deploy stays
   dependency-free and buildless in spirit: this script is plain Node, no
   bundler, no transform. Files land byte-identical.

   Usage:
     node tools/web/prepare-dist.mjs            # -> dist/
     node tools/web/prepare-dist.mjs --out X    # -> X/
*/

import { mkdirSync, rmSync, cpSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { POINTER_PATH } from "../ci/forays-directory.mjs";
import { stampBuild, stampedProblems, stampTimestamp } from "../ci/generate-manifest.mjs";
import { resolveOutDir, USAGE } from "./out-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
/* The output directory is deleted before the build, so it is validated first
   (round-3 audit, ci-release-15): never the checkout, an ancestor of it, or a
   directory holding a .git — see out-dir.mjs. */
const outDir = resolveOutDir(args, ROOT);
if (outDir.error) {
  console.error(`FATAL: ${outDir.error}\n${USAGE}`);
  process.exit(2);
}
const OUT = outDir.out;

/** Hard cap. The whole point is to not ship the 12 MB catalogue by accident, so
    failing loudly beats a slow deploy nobody looks at. */
const MAX_MB = 8;

/* The app shell. Kept explicit so a new root-level file has to be added here
   deliberately rather than riding along. */
const SHELL = [
  "index.html",
  "app.js",
  "search-engine.js",
  "styles.css",
  "sw.js",
  "manifest.json",
  "icon-180.png",
  "icon-512.png",
];

/* Exactly what app.js fetches at runtime — verified against its init(). Adding
   a fetch without adding it here means a 404 in production and a working
   localhost, which is the worst failure shape.

   `forays.json`, `segments.json`, `segment-sources.json` and
   `catalog-client.json` were missing from this list until M4 (#233
   remainder): `tools/ci/generate-manifest.mjs`'s cross-check against
   `dist/` (see below) caught that a Vercel deploy of this bundle would 404 on
   every one of them, since `app.js`'s `init()` fetches all four. */
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
  // Not fetched by app.js today, but small and already used by the backend
  // curation path; harmless to ship and avoids a redeploy when the client
  // starts reading them (personas surfacing, ladders — #25 and the R14 work).
  "personas.json",
  "ladders.json",
  "dai-classification.json",
  /* S-03 (docs/search-plan.md): the client-side show index. Listed HERE and
     deliberately NOT in tools/ci/generate-manifest.mjs's RUNTIME_DATA — it is
     served but not precached and not pinned, which is option B in
     tools/build-show-index.mjs's design comment. app.js fetches it with a bare
     `fetch()` on the first focus of the search box; a listener who never
     searches never pays for it, and a deploy does not re-download it. */
  "show-index.tsv",
];

/* The player modules (#23/#24/#33). Loaded as ES modules by the client once
   #25 wires them in; shipping them now keeps dist honest about what the app is.
   Test files are deliberately NOT shipped. */
function playerSources() {
  return readdirSync(join(ROOT, "player"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map((f) => join("player", f));
}

/* The brand faces (round-2 audit, perf-5): the Vercel dist shipped none, so
   the web deploy 404'd every @font-face and drew the fallback typeface for
   good. Derived from the directory, like playerSources(). */
function fontSources() {
  const dir = join(ROOT, "fonts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".woff2"))
    .map((f) => join("fonts", f));
}

/* Joey's UX prototype. Already shared as a live link, so the Vercel deploy has
   to keep serving it or an outward-facing URL breaks. */
const EXTRAS = ["docs/ux/foray-m3-prototype.html"];

function copy(rel) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) return { rel, bytes: 0, missing: true };
  const dst = join(OUT, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  return { rel, bytes: statSync(src).size, missing: false };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const copied = [];
const missing = [];

for (const rel of [...SHELL, ...fontSources(), ...playerSources(), ...EXTRAS]) {
  const r = copy(rel);
  (r.missing ? missing : copied).push(r);
}
for (const f of RUNTIME_DATA) {
  const r = copy(join("data", f));
  (r.missing ? missing : copied).push(r);
}
const totalBytes = copied.reduce((n, r) => n + r.bytes, 0);
const mb = totalBytes / 1024 / 1024;

copied.sort((a, b) => b.bytes - a.bytes);
console.log(`dist -> ${relative(ROOT, OUT)}`);
for (const r of copied.slice(0, 8)) {
  console.log(`  ${(r.bytes / 1024).toFixed(0).padStart(7)} KB  ${r.rel}`);
}
if (copied.length > 8) console.log(`  ... and ${copied.length - 8} smaller files`);
console.log(`total: ${mb.toFixed(2)} MB across ${copied.length} files`);

// index.html is the entry point; without it the deploy is a 404 farm.
if (!existsSync(join(OUT, "index.html"))) {
  console.error("FATAL: index.html missing from dist");
  process.exit(1);
}

// A missing runtime data file is a production 404 that works fine locally.
const missingData = missing.filter((m) => m.rel.startsWith("data" + sep));
if (missingData.length) {
  console.error("FATAL: runtime data missing: " + missingData.map((m) => m.rel).join(", "));
  process.exit(1);
}
if (missing.length) {
  console.warn("WARN not found (skipped): " + missing.map((m) => m.rel).join(", "));
}

/* THE DEPLOY STAMP (issue #701): deploy-manifest.json, the Foray directory
   pointer (data/forays-directory.json) and sw.js's BUILD_ID, written INTO dist/
   from the bytes dist/ actually holds. None of the three is committed any more —
   they changed on every merge to main and so conflicted with every open PR; see
   tools/ci/generate-manifest.mjs's header.

   Computed from dist rather than the source tree, which is the stronger claim:
   sw.js verifies every file it fetches against these hashes at install time, so
   a manifest that described files dist does not contain (this script's
   allowlist omitting something generate-manifest.mjs lists) would fail in
   production, not here. `stampBuild` throws on exactly that ("listed file is
   missing on disk"), and `stampedProblems` then re-derives everything from disk
   so a torn stamp cannot ship.

   `built_at` is the committer date of the newest commit that touched a stamp
   input (`stampTimestamp`), NOT HEAD's: this build is skipped for commits that
   touch nothing served, and the phone's bundled seed (built from such a commit)
   must carry the same date this deploy does. It moves forward with main, a
   revert included, and two builds of the same content agree. The phones order
   pointers by it (player/foray-directory.js, STATUS.OLDER). A shallow clone can
   only make it later, which is the safe direction for a live pointer. */
{
  const stamp = stampTimestamp(ROOT);
  let r;
  try {
    r = stampBuild(OUT, { builtAt: stamp.builtAt });
  } catch (err) {
    console.error(`FATAL: could not stamp the deploy: ${err.message}`);
    process.exit(1);
  }
  const problems = stampedProblems(OUT);
  if (problems.length) {
    console.error("FATAL: the stamped dist does not verify — sw.js would refuse this deploy:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `deploy stamp: ${r.deployId} (${Object.keys(r.manifest.files).length} files, verified against dist); ` +
      `${POINTER_PATH} built_at ${r.pointer.built_at} (from ${stamp.source})`
  );
}

if (mb > MAX_MB) {
  console.error(`FATAL: dist is ${mb.toFixed(1)} MB, over the ${MAX_MB} MB cap. ` +
    `Something large got into the allowlist — check data/ entries.`);
  process.exit(1);
}
