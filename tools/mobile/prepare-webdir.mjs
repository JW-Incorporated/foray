#!/usr/bin/env node
/* Assemble the native app's `webDir` from the SAME files the web site serves.
 *
 * WHY THIS EXISTS (issue #36, MP2)
 * Capacitor bundles exactly one directory. Foray's web root IS the repo root,
 * and the repo root also holds ~62 MB of pipeline inputs under `data/`
 * (`breadth-classification.json` 16 MB, `catalog-breadth.json` 12 MB, two `.gz`
 * archives at 13 MB each). The client fetches ~2.2 MB of that. So the native
 * bundle needs a curated copy, and the copy needs to be a committed script
 * rather than a hand-assembled directory (CLAUDE.md rule 6).
 *
 * THE ONE THING THAT MATTERS MOST HERE: DO NOT FORK THE PLAYER.
 * Every file in the bundle is COPIED from the repo root at build time. There is
 * no second `index.html`, no second `app.js`, no second `player/`. A second copy
 * is how the app and the web silently diverge — one gets a fix, the other does
 * not, and the difference surfaces as "it works on the website" three weeks
 * later. If you are ever tempted to edit something under the output directory,
 * you are editing a build artefact: it is gitignored and the next run overwrites
 * it.
 *
 * THE DATA LIST IS DERIVED, NOT WRITTEN DOWN.
 * #36 listed the runtime data files by hand and then said to "verify against the
 * `fetchJson` calls in `app.js`'s `init()` rather than trusting this list". A
 * list that must be manually verified against code is a list that will drift, so
 * this script reads the calls out of `app.js` instead (see `runtimeDataFiles`).
 * Add a `fetchJson("data/new-thing.json")` to `app.js` and the next bundle
 * carries it, with no edit here.
 *
 * That inverts one risk into another, and the guard matters: a regex that stops
 * matching would produce an EMPTY data list and a bundle that is small, silent
 * and broken — the exact "fails green" shape `tools/ci/run-suites.mjs`'s header
 * warns about. So an empty or implausibly short derivation is a hard error, and
 * a derived file that is not on disk is a hard error too.
 *
 * WHAT IS DELIBERATELY NOT COPIED
 *   - `sw.js`. The shell must not register a service worker (#36 §2: the assets
 *     are already local, so it adds a stale-cache layer in front of local files
 *     and becomes a classic "the app won't update" bug). `app.js` gates
 *     registration on not-being-in-a-native-shell, and this script additionally
 *     refuses to place the file in the bundle at all. Two independent mechanisms
 *     because one edit should not be able to undo this.
 *   - `*.test.js` under `player/`. Test code is not shipped to devices.
 *   - Everything else in `data/`. The pipeline inputs are not client data.
 *
 * USAGE
 *   node tools/mobile/prepare-webdir.mjs               # writes mobile/www
 *   node tools/mobile/prepare-webdir.mjs --out <dir>   # writes somewhere else
 *   node tools/mobile/prepare-webdir.mjs --list        # print the plan, copy nothing
 * Any other argument is an error, not an ignored flag (same rule as run-suites).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location (tools/mobile/). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Where the bundle goes, repo-relative. Matches `webDir` in
 *  `mobile/capacitor.config.json`; `shell-invariants.test.mjs` asserts the two
 *  agree, so this is not a comment that can rot. */
export const DEFAULT_OUT = path.join("mobile", "www");

/** The hard ceiling. #36 asks for "under ~3 MB" and asks that exceeding it FAIL
 *  rather than warn — that guard is the only thing standing between the bundle
 *  and the 16 MB classification file. Today's real total is ~2.3 MB, so the
 *  headroom is thin on purpose: `discover.json` (1.7 MB) is the file that grows,
 *  and a bundle creeping toward the cap is a signal worth getting, not noise. */
export const MAX_BYTES = 3 * 1024 * 1024;

/** Files served from the repo root that the app shell needs verbatim.
 *  `index.html` is what makes a directory a valid `webDir` at all. */
export const SHELL_FILES = [
  "index.html",
  "app.js",
  "search-engine.js",
  "styles.css",
  "manifest.json",
  "icon-180.png",
  "icon-512.png",
];

/** Never in the bundle, whatever else changes. See the header. */
export const EXCLUDED_FROM_BUNDLE = ["sw.js"];

/* --------------------------------------------------------------- derivation */

/** Every `data/*.json` path `app.js` actually fetches, in source order.
 *
 *  Matches `fetchJson("data/x.json")` and the double/single/backtick variants.
 *  Deliberately NOT a general "any string starting with data/" scan: `app.js`
 *  mentions `data/app-links.json` in a comment and `data/forays.json` in the
 *  `state` declaration, and neither is a fetch. Anchoring on the call is what
 *  keeps prose out of the bundle plan. */
export function runtimeDataFiles(appSrc) {
  const re = /fetchJson\(\s*(["'`])(data\/[^"'`]+\.json)\1\s*\)/g;
  const out = [];
  for (const m of appSrc.matchAll(re)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

/* A floor on the derivation itself. If `fetchJson` is renamed or the call shape
 * changes, `runtimeDataFiles` returns [] or something tiny, and a bundle with no
 * session document would still build, still be under the size cap, and still
 * "succeed". This number is not a guess: `app.js` fetches 9 files today. Six is
 * "clearly still working"; anything at or below it means the derivation broke,
 * not that the app got simpler. If the app genuinely sheds data files, lower
 * this deliberately and say why in the PR. */
export const MIN_DERIVED_DATA_FILES = 6;

/** Runtime modules under `player/`, excluding test suites. The player is a flat
 *  directory of ES modules that only import each other (verified: every
 *  `import` in `player/*.js` is a `./` sibling), so "every non-test .js" is the
 *  whole graph and no bundler is needed. `player/package.json` is not copied: it
 *  exists to mark the directory as ESM for Node, and module-ness in the browser
 *  comes from `<script type="module">`. */
export function playerFiles(root = REPO_ROOT) {
  return fs
    .readdirSync(path.join(root, "player"))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .sort()
    .map((f) => path.posix.join("player", f));
}

/** The full copy plan as repo-relative POSIX paths. Throws if the plan is not
 *  trustworthy — see MIN_DERIVED_DATA_FILES and the missing-file check. */
export function buildPlan(root = REPO_ROOT) {
  const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const data = runtimeDataFiles(appSrc);

  if (data.length < MIN_DERIVED_DATA_FILES) {
    throw new Error(
      `Derived only ${data.length} runtime data file(s) from app.js, expected at least ` +
        `${MIN_DERIVED_DATA_FILES}. The fetchJson() call shape in app.js has probably ` +
        `changed, and a bundle with no data would otherwise build and look fine. ` +
        `Fix runtimeDataFiles() in tools/mobile/prepare-webdir.mjs.`
    );
  }

  const plan = [...SHELL_FILES, ...playerFiles(root), ...data];

  const missing = plan.filter((rel) => !fs.existsSync(path.join(root, rel)));
  if (missing.length) {
    throw new Error(
      `These files are in the bundle plan but not on disk: ${missing.join(", ")}. ` +
        `app.js fetches them, so the app would 404 on a device. If one is genuinely ` +
        `optional now, remove its fetchJson call or handle it explicitly here.`
    );
  }

  const banned = plan.filter((rel) => EXCLUDED_FROM_BUNDLE.includes(rel));
  if (banned.length) {
    throw new Error(
      `${banned.join(", ")} must never be in the native bundle — see the header. ` +
        `The shell does not register a service worker.`
    );
  }

  return plan;
}

/* ------------------------------------------------------------------- output */

/** Refuse to touch anything that is not a build artefact inside this repo.
 *  `prepare` deletes its output directory before writing, and a wrong `--out`
 *  would then delete real work. CLAUDE.md § Never discard uncommitted work. */
function assertSafeOut(absOut, root) {
  const rel = path.relative(root, absOut);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`--out must be inside the repo, got ${absOut}`);
  }
  if (path.basename(absOut) !== "www") {
    throw new Error(
      `--out must end in a directory named "www" (got ${path.basename(absOut)}). ` +
        `This directory is deleted and rebuilt on every run, so the name is a guard, ` +
        `not a preference.`
    );
  }
}

export function prepare({ root = REPO_ROOT, out = DEFAULT_OUT, maxBytes = MAX_BYTES } = {}) {
  const absOut = path.resolve(root, out);
  assertSafeOut(absOut, root);

  const plan = buildPlan(root);

  fs.rmSync(absOut, { recursive: true, force: true });
  const files = [];
  let total = 0;
  for (const rel of plan) {
    const src = path.join(root, rel);
    const dest = path.join(absOut, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    const bytes = fs.statSync(dest).size;
    files.push({ rel, bytes });
    total += bytes;
  }

  /* Checked AFTER copying so the failure message can name the actual offenders,
     and the half-built directory is left in place to be inspected. It is a build
     artefact; the next run clears it. */
  if (total > maxBytes) {
    const worst = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    throw new Error(
      `webDir is ${fmt(total)} which exceeds the ${fmt(maxBytes)} cap.\n` +
        `Largest files:\n` +
        worst.map((f) => `  ${fmt(f.bytes).padStart(10)}  ${f.rel}`).join("\n") +
        `\nEither the client started fetching something big, or a pipeline input ` +
        `got into the plan. Do not raise the cap to make this pass.`
    );
  }

  if (!fs.existsSync(path.join(absOut, "index.html"))) {
    throw new Error(`${out} has no index.html, so it is not a valid Capacitor webDir.`);
  }
  for (const bad of EXCLUDED_FROM_BUNDLE) {
    if (fs.existsSync(path.join(absOut, bad))) {
      throw new Error(`${bad} ended up in the bundle. See the header.`);
    }
  }

  return { out, absOut, files, total, maxBytes };
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* --------------------------------------------------------------------- main */

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  let out = DEFAULT_OUT;
  let listOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--list") listOnly = true;
    else if (argv[i] === "--out") {
      out = argv[++i];
      if (!out) { console.error("--out needs a directory"); process.exit(2); }
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      console.error("Usage: node tools/mobile/prepare-webdir.mjs [--out <dir>] [--list]");
      process.exit(2);
    }
  }

  try {
    if (listOnly) {
      const plan = buildPlan();
      console.log(`${plan.length} files would be copied to ${out}:`);
      for (const rel of plan) console.log(`  ${rel}`);
    } else {
      const r = prepare({ out });
      console.log(`webDir ready: ${r.out}  (${r.files.length} files, ${fmt(r.total)} of ${fmt(r.maxBytes)})`);
    }
  } catch (e) {
    console.error(`prepare-webdir failed: ${e.message}`);
    process.exit(1);
  }
}
