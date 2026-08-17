#!/usr/bin/env node
/* Assemble the native app's `webDir` from the SAME files the web site serves.
 *
 * WHY THIS EXISTS (issue #36, MP2)
 * Capacitor bundles exactly one directory. Foray's web root IS the repo root,
 * and the repo root also holds ~62 MB of pipeline inputs under `data/`
 * (`breadth-classification.json` 16 MB, `catalog-breadth.json` 12 MB, and `.gz`
 * archives at 13.1 MB and 12.2 MB). The client fetches 2.1 MB of that. So the native
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
 * THE ONE THING IN THE BUNDLE THAT IS NOT A COPY OF THE SITE (issue #27/#37)
 * `mobile/plugins/foray-audio/web/foray-audio-shell.js` is shell-only code — it
 * tells the native `mediaPlayback` foreground service when the WebView starts and
 * stops making sound, which is the one thing Android needs that cannot come from
 * the website (`docs/android-native-code.md`). It is copied into the bundle and one
 * `<script type="module">` tag is added to the bundle's COPY of `index.html`.
 *
 * That is not the fork this header warns about, and the distinction is worth being
 * precise about: the fork hazard is TWO COPIES OF THE SAME THING drifting apart.
 * This file exists in one place and ships to one target. What it does mean is that
 * the bundle's `index.html` is no longer byte-identical to the root's, so the
 * injection is (a) derived from `SHELL_ONLY_FILES` rather than written out twice,
 * (b) idempotent, and (c) RE-READ off disk and asserted afterwards. Without (c) a
 * missed injection is the worst failure shape available here: the app builds, it
 * installs, it plays, and audio dies in the background — silently, on a device,
 * weeks later. Same reasoning as `inject-background-audio.mjs`'s re-parse.
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
 *  and the 16 MB classification file. Today's real total is 2.52 MB, so the
 *  headroom is thin on purpose: `discover.json` (1.63 MB) is the file that grows,
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

/** Files that ship ONLY inside the native shell, with where each one lands.
 *
 *  `src` is repo-relative; `dest` is relative to the bundle root, and it is the
 *  `src` a `<script>` tag will point at, so the two cannot drift — `shellScriptTags`
 *  derives the tag from this list rather than restating the filename.
 *
 *  Deliberately flat at the bundle root rather than under a `mobile/` prefix: the
 *  bundle root is the app's origin root, and a shallow path is one fewer thing for
 *  the CSP's `script-src 'self'` to be interesting about. */
export const SHELL_ONLY_FILES = [
  {
    src: "mobile/plugins/foray-audio/web/foray-audio-shell.js",
    dest: "foray-audio-shell.js",
    module: true,
  },
];

/** The `<script>` tags the bundle's `index.html` needs for `SHELL_ONLY_FILES`.
 *
 *  `type="module"` so the file can `export` its factory and be imported directly by
 *  `foray-audio-shell.test.mjs` in Node — the same reason `player/client.js` is a
 *  module. Module scripts are deferred, which is correct here: the shell patches
 *  `HTMLMediaElement.prototype.play`, and nothing can call `play()` before the
 *  document has been parsed and a human has tapped something. */
export function shellScriptTags(files = SHELL_ONLY_FILES) {
  return files
    .filter((f) => f.dest.endsWith(".js"))
    .map((f) => `<script${f.module ? ' type="module"' : ""} src="${f.dest}"></script>`);
}

/** Where the tags go. Chosen so the injected script is governed by our CSP rather
 *  than ahead of it: the policy `<meta>` is on line 22 of `index.html` and this
 *  lands at the end of the head, so `script-src 'self'` really is what allows it.
 *  (Contrast Capacitor's own bridge, which inserts at `indexOf("<head>")` and
 *  therefore parses BEFORE the policy exists — `docs/android-shell-build.md` §2.2.
 *  Being on the governed side of that line is the point: this file is ours, it is
 *  same-origin, and it should have to satisfy the same policy the player does.) */
const HEAD_CLOSE = "</head>";

export class WebDirError extends Error {}

/**
 * Add the shell-only `<script>` tags to `html`, immediately before `</head>`.
 *
 * Idempotent — a tag already present is left where it is, because `cap sync` and CI
 * both re-run this and a script that only works once is a script somebody will run
 * twice.
 *
 * @returns {{html: string, changed: boolean, added: string[]}}
 * @throws {WebDirError} if the anchor is missing or ambiguous.
 */
export function injectShellScripts(html, files = SHELL_ONLY_FILES) {
  if (typeof html !== "string" || html.trim() === "") {
    throw new WebDirError("empty index.html source");
  }
  const first = html.indexOf(HEAD_CLOSE);
  if (first < 0) {
    throw new WebDirError(
      `index.html has no ${HEAD_CLOSE}, so there is nowhere to put the shell's script ` +
        `tags. Refusing to guess: a bundle without them builds, installs, plays, and ` +
        `loses background audio on a device.`
    );
  }
  if (html.indexOf(HEAD_CLOSE, first + HEAD_CLOSE.length) >= 0) {
    /* Two `</head>` means one of them is inside a comment or a string, and picking
       the wrong one puts the tag outside the head. A hard error rather than "the
       first one is probably right". */
    throw new WebDirError(
      `index.html contains ${HEAD_CLOSE} more than once. Which one closes the real head ` +
        `is not something this script should be guessing at.`
    );
  }

  const tags = shellScriptTags(files);
  const missing = tags.filter((t) => !html.includes(t));
  if (missing.length === 0) return { html, changed: false, added: [] };

  const block = missing.map((t) => `${t}\n`).join("");
  return {
    html: html.slice(0, first) + block + html.slice(first),
    changed: true,
    added: missing,
  };
}

/**
 * Assert that `html` really carries every shell tag, inside the head.
 *
 * A SEPARATE, EXPORTED, TESTED FUNCTION rather than an inline `if`, for the reason
 * `inject-background-audio.mjs`'s `assertModePresent` gives in its own comment: an
 * adversarial pass replaced that guard's inline version with `if (false)` and left
 * the whole suite green. Without this check every failure above degrades to
 * "returned the input unchanged and reported success".
 */
export function assertShellScriptsPresent(html, files = SHELL_ONLY_FILES) {
  const headEnd = html.indexOf(HEAD_CLOSE);
  if (headEnd < 0) {
    throw new WebDirError(`the bundled index.html has no ${HEAD_CLOSE} after injection.`);
  }
  for (const tag of shellScriptTags(files)) {
    const at = html.indexOf(tag);
    if (at < 0) {
      throw new WebDirError(
        `the bundled index.html does not carry ${tag}. The native shell would build and ` +
          `run with no bridge to the foreground service, and nothing else would notice.`
      );
    }
    if (at > headEnd) {
      throw new WebDirError(
        `${tag} is after ${HEAD_CLOSE} in the bundled index.html. It must be inside the ` +
          `head, after the CSP meta, so the policy that allows it is the one we ship.`
      );
    }
  }
  return true;
}

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

/** `SHELL_ONLY_FILES`, with every source proven to be on disk.
 *
 *  A HARD ERROR rather than a skip, and this is the guard that matters most in this
 *  file. Move or rename the plugin's `web/` directory and a silent skip would
 *  produce a bundle that is a few kilobytes smaller, under the size cap, with a
 *  valid `index.html`, that builds and installs and plays — and has no bridge to the
 *  foreground service. Nothing downstream can tell that apart from a working app
 *  except a phone in a pocket. */
export function shellOnlyPlan(root = REPO_ROOT) {
  const missing = SHELL_ONLY_FILES.filter((f) => !fs.existsSync(path.join(root, f.src)));
  if (missing.length) {
    throw new Error(
      `these shell-only files are missing: ${missing.map((f) => f.src).join(", ")}. ` +
        `They are the native shell's half of the foreground-service bridge ` +
        `(docs/android-native-code.md); a bundle without them loses background audio on ` +
        `Android and looks completely fine doing it.`
    );
  }
  return SHELL_ONLY_FILES;
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
  const shellOnly = shellOnlyPlan(root);

  fs.rmSync(absOut, { recursive: true, force: true });

  const written = [];
  const copy = (src, destRel) => {
    const dest = path.join(absOut, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    written.push(destRel);
  };

  for (const rel of plan) copy(path.join(root, rel), rel);
  for (const f of shellOnly) copy(path.join(root, f.src), f.dest);

  /* THE INJECTION, and then the re-read. Done before anything is measured so the
     reported size is the size that ships, and asserted against the bytes on disk
     rather than against the string we just built — a write that failed halfway is
     exactly the case a re-parse of an in-memory value cannot see. */
  const indexAbs = path.join(absOut, "index.html");
  const injected = injectShellScripts(fs.readFileSync(indexAbs, "utf8"), shellOnly);
  if (injected.changed) fs.writeFileSync(indexAbs, injected.html);
  assertShellScriptsPresent(fs.readFileSync(indexAbs, "utf8"), shellOnly);

  const files = [];
  let total = 0;
  for (const rel of written) {
    const bytes = fs.statSync(path.join(absOut, rel)).size;
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
      const shellOnly = shellOnlyPlan();
      console.log(`${plan.length + shellOnly.length} files would be copied to ${out}:`);
      for (const rel of plan) console.log(`  ${rel}`);
      for (const f of shellOnly) console.log(`  ${f.src}  ->  ${f.dest}   (shell only)`);
      console.log(`and these tags would be added to ${out}/index.html before </head>:`);
      for (const tag of shellScriptTags(shellOnly)) console.log(`  ${tag}`);
    } else {
      const r = prepare({ out });
      console.log(`webDir ready: ${r.out}  (${r.files.length} files, ${fmt(r.total)} of ${fmt(r.maxBytes)})`);
    }
  } catch (e) {
    console.error(`prepare-webdir failed: ${e.message}`);
    process.exit(1);
  }
}
