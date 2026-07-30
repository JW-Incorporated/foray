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
  "icon-180.png",
  "icon-512.png",
];

/* Exactly what app.js fetches at runtime — verified against its init(). Adding
   a fetch without adding it here means a 404 in production and a working
   localhost, which is the worst failure shape. */
const RUNTIME_DATA = [
  "session.json",
  "taxonomy.json",
  "discover.json",
  "semantic-index.json",
  "item-tags.json",
  "validated-links.json",
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

if (mb > MAX_MB) {
  console.error(`FATAL: dist is ${mb.toFixed(1)} MB, over the ${MAX_MB} MB cap. ` +
    `Something large got into the allowlist — check data/ entries.`);
  process.exit(1);
}
