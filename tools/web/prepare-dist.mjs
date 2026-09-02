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

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const OUT = join(ROOT, args.includes("--out") ? args[args.indexOf("--out") + 1] : "dist");

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
  "deploy-manifest.json",
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
];

/* The player modules (#23/#24/#33). Loaded as ES modules by the client once
   #25 wires them in; shipping them now keeps dist honest about what the app is.
   Test files are deliberately NOT shipped. */
function playerSources() {
  return readdirSync(join(ROOT, "player"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map((f) => join("player", f));
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

for (const rel of [...SHELL, ...playerSources(), ...EXTRAS]) {
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

/* Stamp deploy-manifest.json's deploy_id, freshly, against what dist ACTUALLY
   contains.

   Before M4 (#233 remainder) sw.js's `CACHE` name was hand-bumped and the
   Vercel build stamped a content hash into it directly, because there was no
   other place to put a version. sw.js now derives its generation identity
   entirely from `deploy-manifest.json` (see tools/ci/generate-manifest.mjs and
   sw.js's header), which is generated from the SOURCE tree and already
   committed — normally that committed copy is exactly right, since dist is a
   byte-identical copy of the same files it hashes.

   This step exists for the one case where it would not be: this script's own
   allowlist can omit or rename something relative to what generate-manifest.mjs
   listed, and a manifest that describes files dist does not actually contain
   would let sw.js's install-time verification fail against production, not
   locally. So dist gets its OWN manifest, recomputed from what actually landed
   in dist, rather than trusting the copy that shipped from the source tree. */
{
  const distManifestPath = join(OUT, "deploy-manifest.json");
  if (!existsSync(distManifestPath)) {
    console.error("FATAL: deploy-manifest.json missing from dist — cannot verify deploy identity.");
    process.exit(1);
  }
  const sourceManifest = JSON.parse(readFileSync(join(ROOT, "deploy-manifest.json"), "utf8"));
  const distFiles = {};
  for (const rel of Object.keys(sourceManifest.files)) {
    const f = join(OUT, rel);
    if (!existsSync(f)) {
      console.error(`FATAL: deploy-manifest.json names ${rel}, which is not in dist. ` +
        `Add it to prepare-dist.mjs's allowlist or regenerate the manifest.`);
      process.exit(1);
    }
    distFiles[rel] = "sha256:" + createHash("sha256").update(readFileSync(f)).digest("hex");
  }
  const lines = Object.keys(distFiles).sort().map((p) => `${p}:${distFiles[p]}`).join("\n") + "\n";
  const distDeployId = createHash("sha256").update(lines).digest("hex").slice(0, 16);
  writeFileSync(distManifestPath, JSON.stringify({ deploy_id: distDeployId, files: distFiles }, null, 2) + "\n");
  console.log(`deploy manifest: ${distDeployId} (${Object.keys(distFiles).length} files, verified against dist)`);
}

if (mb > MAX_MB) {
  console.error(`FATAL: dist is ${mb.toFixed(1)} MB, over the ${MAX_MB} MB cap. ` +
    `Something large got into the allowlist — check data/ entries.`);
  process.exit(1);
}
