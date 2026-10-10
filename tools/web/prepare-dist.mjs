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

import { mkdirSync, rmSync, cpSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { POINTER_PATH } from "../ci/forays-directory.mjs";
import {
  SHELL,
  fontSources,
  playerSources,
  runtimeData,
  stampBuild,
  stampedProblems,
  stampTimestamp,
} from "../ci/generate-manifest.mjs";
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

/* WHAT DIST SHIPS IS NOT DECIDED HERE (CH2-18; T2-03, T2-18 in
   docs/roadmap/code-health-2.md). This file used to keep its own SHELL and
   RUNTIME_DATA, "kept in sync by design" with tools/ci/generate-manifest.mjs's
   and pinned equal by nothing. Now every list is generate-manifest's — the one
   the deploy id hashes and the SW precaches — plus three web-only additions
   (`sw.js`, `show-index.tsv` and WELL_KNOWN below), and
   tools/ci/ship-lists.test.mjs pins the built dist to exactly that:
     - the shell: generate-manifest's SHELL plus `sw.js` (the native bundle
       refuses the worker; the manifest hashes the stamped copy separately);
     - the brand faces (round-2 audit, perf-5: the Vercel dist once shipped
       none and every @font-face 404'd): `fontSources()`;
     - the player modules (#23/#24/#33; CH-07, P2-04): `playerSources()`, the
       import closure of player/client.js — what index.html modulepreloads;
     - the runtime data: `runtimeData()`, generate-manifest's RUNTIME_DATA plus
       anything app.js `fetchJson`s that it lacks, so a new fetch can no longer
       work on localhost and 404 in production; plus `show-index.tsv` (S-03,
       docs/search-plan.md), served but deliberately neither precached nor
       pinned — option B in tools/build-show-index.mjs's design comment. app.js
       fetches it with a bare `fetch()` on the first focus of the search box.

   NOTHING FROM OUTSIDE THE APP SHIPS (round-3 audit, security-11). There is no
   "extras" list any more: docs/ux/foray-m3-prototype.html used to ride along
   because a link to it had been shared, but it has no CSP, inline scripts and
   unescaped innerHTML interpolation, and served from here it shares the app's
   origin, where the Supabase session lives. A prototype that needs a public URL
   gets its own origin. pages.yml removes docs/ux/*.html from the Pages artifact
   too (round-3 review, L4); until the HUMAN-ACTIONS #110 settings flip the
   legacy branch deploy still serves it, so security-11 is closed on Vercel and
   only partly on Pages until then. */
const DIST_SHELL = [...SHELL, "sw.js"];
const DIST_DATA = [...runtimeData(ROOT), "show-index.tsv"];

/* The site-association files (#1071): what lets a shared
   https://foray-web-seven.vercel.app/#/<route> link open in the app instead of
   the browser. iOS fetches /.well-known/apple-app-site-association (no
   extension; vercel.json gives it Content-Type application/json, which Apple
   requires) from the root of the share origin, so it has to be in dist at that
   exact path. Missing is FATAL, like runtime data: a deploy without it does
   not break the site, it quietly turns every universal link back into a web
   page, and nothing on the page would show it. Android's assetlinks.json joins
   this list once the Play signing fingerprint exists (HUMAN-ACTIONS). */
const WELL_KNOWN = [".well-known/apple-app-site-association"];

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

for (const rel of [...DIST_SHELL, ...fontSources(), ...playerSources(ROOT), ...WELL_KNOWN]) {
  const r = copy(rel);
  (r.missing ? missing : copied).push(r);
}
for (const f of DIST_DATA) {
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
const missingWellKnown = missing.filter((m) => WELL_KNOWN.includes(m.rel));
if (missingWellKnown.length) {
  console.error("FATAL: site-association file missing: " + missingWellKnown.map((m) => m.rel).join(", "));
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
