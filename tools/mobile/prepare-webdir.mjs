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
 * THE ONE FILE THAT IS COPIED IN PART, AND WHY THAT IS NOT A FORK EITHER
 * `data/discover.json` and `data/item-tags.json` are the only two bundled files
 * whose size is a function of the CATALOGUE rather than of the product, and the
 * nightly refresh grows them. Measured over 2026-07-19..08-18, `discover.json`
 * grew 681 KB -> 1.70 MB, about 35 KB a night, and `item-tags.json` 162 KB ->
 * 302 KB, about 4 KB a night. At that rate the 3 MB cap below is not a ceiling a
 * human ever decides to cross; it is a date. It was going to fire on the next
 * refresh and it was going to look like the mobile build breaking.
 *
 * So the bundle stopped carrying the whole CATALOGUE and started carrying a BOUNDED
 * SLICE of it: `BUNDLED_ITEMS_PER_SHOW` items of every show — its join anchor plus the
 * newest of the rest — plus whatever else it takes to keep every topic represented
 * (`discoverSlice`). Not simply "the newest 3": document order is not recency order,
 * so for 111 of 213 shows one of those three slots goes to an older episode. Why that
 * slot is not negotiable is the § below on the join.
 *
 * THE SHAPE OF THAT NUMBER is what matters — it is O(shows x topics), NOT
 * O(episodes) — because shows have been flat at 213 since 2026-07-13 while episodes
 * went 764 -> 1534. A year of nightlies adds 8,000 episodes and ZERO bundle bytes to
 * it. One caveat, since the anchor is a PREFIX: a show with a long run of items both
 * joins skip keeps that whole run, so it goes O(episodes) until the run ends. All
 * 1,534 items are joinable today, and the per-file budget is the alarm if that
 * changes.
 *
 * `item-tags.json` is COPIED WHOLE and that is a deliberate, measured refusal, not
 * an oversight — see the § above `PROJECTED_DATA`. Trimming it is what makes the app
 * rank search results differently from the website.
 *
 * This is not the fork the header warns about, for the same reason the injected
 * script tag is not: there is one copy of the selection rule, it lives here, it
 * runs at build time, and the file it writes is a build artefact. The web keeps
 * fetching the whole document; nothing about `app.js` changes; the app just has
 * a smaller pool, and every field on every item it does have is byte-identical.
 * Trimming FIELDS instead was measured and rejected: every field except
 * `episode_guid` (1.9 KB of 1.70 MB) has a live reader in `app.js`,
 * `search-engine.js` or `player/`, and the largest droppable one
 * (`apple_episode_url`, 205 KB) buys six nights. Bounding buys every night.
 *
 * WHAT THE SLICE MUST NOT SILENTLY BREAK, and this is the guard that matters
 * most in the new code: `player/foray-sources.js` joins a Foray's segments onto
 * `discover.json` BY SHOW NAME to find lock-screen artwork (#27) and the
 * publisher credit link. Drop the wrong item and a car head unit shows the app
 * icon instead of the publisher's artwork, weeks later, on a device, with the
 * build green — the same failure shape as a missed script tag.
 *
 * The obvious rule, "keep each show's first item", is WRONG, and today's data
 * hides it: both joins skip an item carrying no artwork (or no valid collection
 * id) and take the next one that does, so the item they read is the first USABLE
 * one. All 1,534 items have both today, so the two rules agree — and the day one
 * artwork-less episode arrived, the nightly build would have failed, blaming the
 * slice. So the anchor is instead the shortest document-order prefix of each show
 * that the REAL join functions cannot tell from the whole show; the slice emits in
 * document order; and `assertDiscoverSliceComplete` re-runs the REAL
 * `artworkUrlsByShow` and `collectionIdsByShow` over both documents and demands
 * identical maps.
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

/* The PRODUCTION join, imported rather than reimplemented. The slice's whole
   correctness condition is "these two functions cannot tell the difference", and
   a second copy of them here would agree with itself while the app disagreed. */
import { artworkUrlsByShow, collectionIdsByShow } from "../../player/foray-sources.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location (tools/mobile/). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Where the bundle goes, repo-relative. Matches `webDir` in
 *  `mobile/capacitor.config.json`; `shell-invariants.test.mjs` asserts the two
 *  agree, so this is not a comment that can rot. */
export const DEFAULT_OUT = path.join("mobile", "www");

/** The hard ceiling. #36 asks for "under ~3 MB" and asks that exceeding it FAIL
 *  rather than warn — that guard is the only thing standing between the bundle
 *  and the 16 MB classification file. UNCHANGED, deliberately, and the number was
 *  re-argued rather than assumed when the catalogue slice landed.
 *
 *  What changed is what is on the other side of it. The cap was measured at 2.52 MB
 *  when this comment was written and reached 2.98 MB — 16 KB of headroom — by
 *  2026-08-18, entirely from nightly catalogue growth. Raising it then would have
 *  bought about six weeks and silenced the only alarm here. LOWERING it now that
 *  the slice brought the total to ~1.8 MB would have been the mirror-image
 *  mistake: the non-catalogue half of this bundle (`player/` grew 66 KB -> 480 KB
 *  in the fourteen days to 2026-08-18) would then trip it inside a month, and a
 *  cap that fires on ordinary work is the noise this comment warns about.
 *
 *  So the split is now by CAUSE, which is what makes each number a signal:
 *    - 3 MB here still means "something big got in that nobody chose" — a pipeline
 *      input, a fetch of `breadth-classification.json`. That is the failure that
 *      needs a hard stop, and it is unaffected by how the catalogue is sliced.
 *    - `PROJECTED_DATA`'s per-file budgets mean "the slice stopped being bounded",
 *      and they sit ~15% above today's slice, not 60%. That is the tight alarm.
 *  A bundle creeping toward either is a signal worth getting, not noise. */
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
  /* #27's Android half. ORDER MATTERS ONLY ONE WAY: both are module scripts in the
     head, so both run before `player/client.js` in the body — which is the ordering
     that matters, because `client.js` reads `navigator.mediaSession` once, at init,
     and the polyfill has to be there by then. Between these two it does not matter,
     and it deliberately must not: `foray-media-session.js` looks
     `window.ForayAudioShell` up lazily on every call rather than capturing it, so
     neither file may assume the other has run. The shell is listed first only because
     it is the one that existed first. */
  {
    src: "mobile/plugins/foray-audio/web/foray-media-session.js",
    dest: "foray-media-session.js",
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

/* --------------------------------------------------- the catalogue slice */

/** How many items of each show the bundle carries. THE ONE KNOB, and its units are
 *  worth stating: one unit costs 213 items and ~245 KB today, because there are 213
 *  shows. Three is the shipped value — 622 items, ~680 KB, 40% of the catalogue,
 *  and six times `app.js`'s `SEEN_WINDOW` of 100 so a listener refreshing all day
 *  does not walk off the end of the pool.
 *
 *  Lower it and the bundle shrinks proportionally with no code change; the guards
 *  below hold at every value, including 1. */
export const BUNDLED_ITEMS_PER_SHOW = 3;

const topicsOf = (item) =>
  (Array.isArray(item?.topics) ? item.topics : []).filter((t) => typeof t === "string" && t !== "");

/** Sort key for "newest". A missing or unparseable `release_date` sorts last rather
 *  than throwing: `app.js` orders the pool with `new Date(item.release_date || 0)`
 *  and treats a bad date as ancient, so the slice agrees with the app instead of
 *  inventing a stricter rule than the reader has. */
function releasedAt(item) {
  const t = Date.parse(item?.release_date ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The bundled subset of `data/discover.json`.
 *
 * Three properties, in the order they matter:
 *
 *   1. EVERY SHOW SURVIVES, and each show's FIRST ITEM IN DOCUMENT ORDER survives.
 *      That is not an aesthetic choice — `player/foray-sources.js` builds its
 *      show->artwork and show->collection-id maps by taking the first item per show
 *      in document order, so keeping that item and emitting in document order makes
 *      both maps identical to the full document's. See the header.
 *   2. EVERY TOPIC SURVIVES. `app.js` routes `#/subject/<topic>` and builds the
 *      interest menus from the taxonomy; a topic with no items left is a browse page
 *      that renders empty in the app and full on the web.
 *   3. The size is O(shows x topics), not O(episodes). This is the whole point.
 *
 * Deterministic: ties in `release_date` break by document order, because
 * `Array.prototype.sort` is stable and the input index list is in document order.
 * A bundle that differs run to run makes "did the slice change?" unanswerable.
 *
 * @throws {WebDirError} if the source document has no items — see the guard's note.
 */
export function discoverSlice(doc, { perShow = BUNDLED_ITEMS_PER_SHOW } = {}) {
  if (!Number.isInteger(perShow) || perShow < 1) {
    throw new WebDirError(`BUNDLED_ITEMS_PER_SHOW must be a positive integer, got ${perShow}`);
  }
  const items = doc?.items;
  /* THE FAILS-GREEN GUARD, and the reason it is here rather than only in the
     comparison below. If the pipeline renames `items`, every set-equality check
     downstream compares empty against empty and PASSES, and the bundle ships a
     discover document with no catalogue in it: small, silent, under every budget,
     and an app whose four cards are blank. Same shape as MIN_DERIVED_DATA_FILES. */
  if (!Array.isArray(items) || items.length === 0) {
    throw new WebDirError(
      `data/discover.json has no non-empty "items" array, so there is nothing to slice. ` +
        `Refusing to write an empty catalogue: it would pass every size budget in this ` +
        `file and give the app a blank home screen.`
    );
  }

  const byShow = new Map();
  items.forEach((item, i) => {
    const show = typeof item?.show === "string" && item.show !== "" ? item.show : "";
    if (!byShow.has(show)) byShow.set(show, []);
    byShow.get(show).push(i);
  });

  /* THE SECOND FAILS-GREEN GUARD, and it closes the same hole as the one above for
     the OTHER field this function cannot work without. `show` is the grouping key AND
     the join key, so if the pipeline renames it every item lands in one anonymous
     bucket, that bucket gets `perShow` slots, and the bundle ships 93 of 1,534
     episodes — under the per-file budget, under the 3 MB cap, with `lostShows` empty
     and both join maps comparing empty against empty. MEASURED, by renaming `show` to
     `show_name` in a copy of the real document: 93 items kept and
     `assertDiscoverSliceComplete` returned true.

     PROPORTIONAL rather than a fixed floor, deliberately. A count ("at least 50
     shows") has to be a parameter so fixtures can be small, and a parameter is a
     thing a future edit can pass 0 for. A share is scale-free: it holds for a 20-item
     fixture and for the real catalogue, and it distinguishes the case that matters —
     a WHOLESALE rename, where every item loses the field — from the case that must
     not break a nightly build, which is a handful of items legitimately missing one.
     All 1,534 items carry a `show` today. */
  const unshown = byShow.get("")?.length ?? 0;
  if (unshown > items.length * 0.05) {
    throw new WebDirError(
      `${unshown} of ${items.length} discover items have no usable "show", so grouping by show ` +
        `is meaningless and the slice would be a fraction of the size it should be — while ` +
        `passing every check in this file, because a document with no shows loses no shows. ` +
        `"show" is both the grouping key and the key player/foray-sources.js joins a Foray's ` +
        `artwork and credit links on. If the pipeline renamed it, fix that; if these items are ` +
        `genuinely show-less, they cannot be recommended anyway.`
    );
  }

  const keep = new Set();
  const artSource = artworkUrlsByShow(doc);
  const cidSource = collectionIdsByShow(doc);
  for (const [show, idxs] of byShow) {
    /* THE JOIN ANCHOR — property 1, and it is ASKED FOR rather than assumed.
       The obvious rule is "keep each show's first item", and it is wrong: both
       joins skip an item that carries no artwork (or no valid collection id) and
       take the next one that does, so the item the join actually reads is the
       first USABLE one, not the first one. Today every item in the catalogue has
       both, so the two rules agree and the difference is invisible — which is
       exactly why it would have surfaced as the nightly build failing on the day
       one artwork-less episode arrived, with a message blaming the slice.

       So the anchor is the shortest document-order prefix of this show that the
       REAL join functions cannot tell from the whole show. Normally that is one
       item; per-show independence in both functions is what makes it terminate,
       and keeping the whole show is the worst case. */
    const prefix = [];
    for (const i of idxs) {
      prefix.push(items[i]);
      keep.add(i);
      const doc_ = { items: prefix };
      const artDone = !artSource.has(show) || artworkUrlsByShow(doc_).get(show) === artSource.get(show);
      const cidDone = !cidSource.has(show) || collectionIdsByShow(doc_).get(show) === cidSource.get(show);
      if (artDone && cidDone) break;
    }
    const rest = idxs.filter((i) => !keep.has(i)).sort((a, b) => releasedAt(items[b]) - releasedAt(items[a]));
    for (const i of rest.slice(0, Math.max(0, perShow - prefix.length))) keep.add(i);
  }

  /* Property 2, as a top-up rather than a separate pass over the whole taxonomy:
     most topics are already covered by the per-show picks, and this only reaches
     for an item when a topic would otherwise be lost entirely. */
  const covered = new Set();
  for (const i of keep) for (const t of topicsOf(items[i])) covered.add(t);
  items.forEach((item, i) => {
    if (keep.has(i)) return;
    const own = topicsOf(item);
    if (!own.some((t) => !covered.has(t))) return;
    keep.add(i);
    for (const t of own) covered.add(t);
  });

  const sliced = [...keep].sort((a, b) => a - b).map((i) => items[i]);
  /* Spread the source's other top-level keys through rather than naming
     `version`/`built_at`: a key the pipeline adds next month should not be silently
     dropped by this function, and `items` is re-added last so the big array stays
     at the end of the file. */
  const { items: _dropped, ...rest } = doc;
  return {
    ...rest,
    /* Not decoration: a device showing 622 of 1534 items is indistinguishable from a
       device with a broken pool unless the file says which it is. */
    bundled_from: { items: items.length, per_show: perShow, kept: sliced.length },
    items: sliced,
  };
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

const missingFrom = (from, of_) => [...from].filter((v) => !of_.has(v));

/**
 * Prove the slice kept everything it promised.
 *
 * A SEPARATE, EXPORTED, TESTED FUNCTION for the reason `assertShellScriptsPresent`
 * gives above: without it every selection bug degrades to "wrote a smaller file and
 * reported success", and a smaller file is what this change is trying to produce, so
 * nothing else in the build can tell the two apart.
 *
 * The join checks are the ones that catch what counting cannot. Emitting the slice
 * sorted by recency instead of document order keeps every show, every topic and
 * every byte budget — and silently changes which artwork the lock screen gets for
 * any show whose artwork has ever changed (there are 461 distinct artwork URLs
 * across 213 shows, so that is not hypothetical).
 */
export function assertDiscoverSliceComplete(source, slice) {
  const items = slice?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new WebDirError(`the bundled discover slice is empty. See discoverSlice's guard.`);
  }
  /* Every check below asks "did the slice LOSE anything", which a completely
     unsliced document passes. So bound it from the other side too. Deliberately
     `>` and not `>=`: a document small enough that the slice is the whole thing
     is legitimate (it is what every fixture in the test suite looks like), and
     the REAL document is asserted to actually shrink in `shell-invariants`. */
  if (items.length > (source?.items?.length ?? 0)) {
    throw new WebDirError(
      `the discover slice has ${items.length} items and the source has ` +
        `${source?.items?.length ?? 0}. A slice cannot be larger than what it is a slice of, ` +
        `so this is not the document it claims to be derived from.`
    );
  }
  const showsOf = (d) =>
    new Set((d?.items ?? []).map((i) => i?.show).filter((s) => typeof s === "string"));
  const topicsIn = (d) => {
    const out = new Set();
    for (const i of d?.items ?? []) for (const t of topicsOf(i)) out.add(t);
    return out;
  };

  const lostShows = missingFrom(showsOf(source), showsOf(slice));
  if (lostShows.length) {
    throw new WebDirError(
      `the discover slice dropped ${lostShows.length} show(s) entirely, starting with ` +
        `${JSON.stringify(lostShows.slice(0, 3))}. Every show must keep at least its first ` +
        `item: the Foray credit link and the lock screen's artwork are joined onto this ` +
        `document by show name (player/foray-sources.js), and a dropped show loses both ` +
        `silently, on a device.`
    );
  }

  /* Same shape a third time: "every topic survived" is vacuously true of a document
     with no topics, which is what a renamed `topics` field produces. */
  if (topicsIn(source).size === 0) {
    throw new WebDirError(
      `no discover item carries a "topics" array, so "every topic survived the slice" is ` +
        `trivially true and means nothing. app.js routes #/subject/<topic> off this field.`
    );
  }
  const lostTopics = missingFrom(topicsIn(source), topicsIn(slice));
  if (lostTopics.length) {
    throw new WebDirError(
      `the discover slice left ${lostTopics.length} topic(s) with no items, starting with ` +
        `${JSON.stringify(lostTopics.slice(0, 3))}. app.js routes #/subject/<topic>, so each ` +
        `one is a browse page that would render empty in the app and populated on the web.`
    );
  }

  if (!sameMap(artworkUrlsByShow(slice), artworkUrlsByShow(source))) {
    throw new WebDirError(
      `artworkUrlsByShow() does not agree between the slice and the full document. The lock ` +
        `screen and a car head unit would show different artwork in the app than on the web ` +
        `— or the app icon instead of the publisher's. Keep each show's FIRST item in ` +
        `document order and emit in document order.`
    );
  }
  if (!sameMap(collectionIdsByShow(slice), collectionIdsByShow(source))) {
    throw new WebDirError(
      `collectionIdsByShow() does not agree between the slice and the full document. A Foray's ` +
        `publisher credits would fall back to an Apple search link for shows the website links ` +
        `straight to.`
    );
  }
  return true;
}

/* The one that is NOT sliced, and why, because "it is only tags" was the wrong
 * answer and a reviewer caught it.
 *
 * `data/item-tags.json` is the OTHER catalogue-proportional file: 302 KB, ~4 KB a
 * night, second only to `discover.json`. Trimming it to the bundled pool takes it to
 * 121 KB and looks completely safe — `search-engine.js` only ever looks a tag list
 * up by an item it is already scoring, so an entry for an absent item is dead weight.
 *
 * IT IS NOT DEAD WEIGHT. `search-engine.js`'s `tagDF()` walks `Object.values()` of
 * the whole map, so the SIZE and the COMPOSITION of the map are inputs to every
 * threshold in the query interpreter, not just a lookup table keyed by item.
 *
 * WHEN THIS WAS WRITTEN THE PROBLEM WAS ARITHMETIC. `tagDF` returned an absolute
 * count and `interpretQuery` compared it against absolute thresholds — `df > 60`
 * deleted a term from query expansion, `df > 25` cut its weight to 0.4x — while
 * `scoreMatch` bucketed a multiplier at 10 and 30. Cutting 1,561 entries to 649
 * scaled every df by ~0.42, and over the 1,366 terms `tagDF` can be called with
 * (the concept vocabulary plus ALIASES) **66 changed expansion bucket and 176
 * changed score multiplier**: `war` 72 -> 24, deleted as too broad on the website
 * and at full weight in the app; `ai` 94 -> 38, deleted -> 0.4x.
 *
 * #275 FIXED THAT HALF, AND THE REFUSAL STANDS ANYWAY — which is the part worth
 * reading, because the obvious reading of #275 is that it made this free. `tagDF` is
 * now a FRACTION of the map it walked, so a trim scales numerator and denominator
 * together and the whole arithmetic class of divergence is gone: `war` is 4.61% of
 * the whole map and 3.70% of the trimmed one, same bucket. What is left is SAMPLING.
 * The slice is three items per show plus every session episode — stratified by SHOW,
 * therefore skewed by TOPIC — so **12 terms still change expansion bucket and 62
 * change score multiplier**: `comedy` 10.70% -> 8.47% (the website deletes it, the
 * app would keep it at 0.4x), `world-war` 2.95% -> 1.69%. Smaller, better understood,
 * and the same failure in kind, bought for ~181 KB.
 *
 * So it is copied whole, and `prepare-webdir.test.mjs` asserts byte-identity to keep
 * it that way. WHAT THAT COSTS, stated rather than buried: the file is still
 * O(episodes), so the bundle still grows ~4 KB a night. From 1.96 MB that is about
 * 245 nights of headroom under the 3 MB cap, not a year.
 *
 * WHAT WOULD ACTUALLY BUY THE ~181 KB, named so the next attempt starts here: ship
 * the trimmed map PLUS a precomputed df table (term -> count, and the map size).
 * That is the second option #275 lists, and #275 is what makes it cheap — the
 * fraction is already the quantity search reads, so the sidecar is ~1,400 numbers
 * and the app and the website agree EXACTLY rather than approximately. It is a
 * bundle change, not a search-quality one, so unlike #275 it belongs in a PR like
 * this one.

/**
 * Which bundled data files are written as a slice rather than copied.
 *
 * A LIST OF ONE, and it stays a list because the next file whose size tracks the
 * catalogue rather than the product belongs here — with its own budget, which is
 * what makes a new entry hard to add carelessly.
 *
 * `maxBytes` is a PER-FILE budget and the tighter of this file's two alarms. It
 * answers a different question from `MAX_BYTES`: not "did something enormous get
 * in" but "did the slice stop being bounded". The two ways that happens are new
 * shows (each costs `perShow` items, ~3.4 KB at 3) and items getting individually
 * fatter, and both are deliberate changes somebody should hear about.
 *
 * Today's slice is 680 KB, so the budget sits ~17% above it: about 35 more shows, or
 * a 17% rise in the average item. Not a year of silence.
 */
export const PROJECTED_DATA = [
  {
    rel: "data/discover.json",
    maxBytes: 800 * 1024,
    project: (source, ctx) => discoverSlice(source, { perShow: ctx.perShow }),
    verify: (source, written) => assertDiscoverSliceComplete(source, written),
  },
];

/** Bundled files that must arrive BYTE-IDENTICAL, asserted rather than assumed.
 *  Everything not in `PROJECTED_DATA` is copied, so this list adds nothing mechanical
 *  — what it adds is a failing test for the one file somebody will reasonably try to
 *  trim next, with the reason attached. See the § above `PROJECTED_DATA`. */
export const COPIED_WHOLE = ["data/item-tags.json"];

/** Exactly how a slice is serialised, in one place, because the bytes are measured
 *  against a budget and compared across runs. Two spaces and a trailing newline is
 *  what `data/` already uses. */
export function serializeSlice(json) {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** The size a slice will be ON DISK. `String.length` is UTF-16 code units and the
 *  budget is enforced against `fs.statSync().size`, which is UTF-8 bytes — 130 bytes
 *  apart today and further with every non-ASCII episode title, so a dry run could
 *  report "under budget" for a build that then failed it. */
export function sliceBytes(json) {
  return Buffer.byteLength(serializeSlice(json), "utf8");
}

/** Build every slice, with the assertions that prove each one, and hand back the
 *  JSON to write. */
export function projectData(root = REPO_ROOT, { perShow = BUNDLED_ITEMS_PER_SHOW, plan = null } = {}) {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  if (plan) {
    const absent = PROJECTED_DATA.filter((p) => !plan.includes(p.rel)).map((p) => p.rel);
    if (absent.length) {
      throw new Error(
        `PROJECTED_DATA describes ${absent.join(", ")}, but app.js no longer fetches ` +
          `${absent.length > 1 ? "them" : "it"}. A slicing rule for a file nobody loads is a ` +
          `rule that has silently stopped being tested — delete the entry deliberately.`
      );
    }
  }

  const out = new Map();
  for (const spec of PROJECTED_DATA) {
    const source = read(spec.rel);
    const written = spec.project(source, { perShow });
    spec.verify(source, written);
    out.set(spec.rel, written);
  }
  return out;
}

/**
 * Re-read the slices OFF DISK and prove them again, after everything is written.
 *
 * Same reasoning as the `index.html` re-read above, and the same failure it is
 * about: a write that half-landed, or a `project` that was quietly bypassed, is
 * exactly the case an in-memory assertion cannot see. It is also where the per-file
 * budget is enforced, so the budget is measured on the bytes that ship.
 */
export function assertSlicesOnDisk(absOut, root = REPO_ROOT) {
  for (const spec of PROJECTED_DATA) {
    const abs = path.join(absOut, spec.rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`${spec.rel} is not in the bundle, but it is one of the sliced files.`);
    }
    const bytes = fs.statSync(abs).size;
    if (bytes > spec.maxBytes) {
      throw new Error(
        `the bundled ${spec.rel} is ${fmt(bytes)}, over its ${fmt(spec.maxBytes)} budget.\n` +
          `This budget is not the 3 MB bundle cap — it is the alarm for the slice having ` +
          `stopped being bounded. Three ways that happens: the catalogue gained shows or ` +
          `topics (each show costs BUNDLED_ITEMS_PER_SHOW items), the items got fatter, or a ` +
          `show grew a long run of items BOTH joins skip — no artwork and no valid collection ` +
          `id — which the anchor prefix has to keep walking. Lower BUNDLED_ITEMS_PER_SHOW, or ` +
          `raise this budget deliberately and say what it now guards.`
      );
    }
    spec.verify(
      JSON.parse(fs.readFileSync(path.join(root, spec.rel), "utf8")),
      JSON.parse(fs.readFileSync(abs, "utf8"))
    );
  }
  /* The file that is deliberately NOT sliced, asserted on the bytes that ship. See
     the § above PROJECTED_DATA: trimming this one silently re-ranks search in the app
     because `tagDF` reads the whole map: its SIZE is the denominator of every
     document-frequency threshold in the query interpreter, and after #275 its
     COMPOSITION is what a trim would change. */
  for (const rel of COPIED_WHOLE) {
    const a = fs.readFileSync(path.join(root, rel));
    const b = fs.readFileSync(path.join(absOut, rel));
    if (!a.equals(b)) {
      throw new Error(
        `the bundled ${rel} is not byte-identical to the source. It must be copied whole: ` +
          `search-engine.js's tagDF() reads the WHOLE map, so a trimmed one re-ranks 12 query ` +
          `expansions and 62 score multipliers in the app and not on the website — sampling ` +
          `skew since #275, arithmetic before it. See the comment above PROJECTED_DATA.`
      );
    }
  }
  return true;
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

export function prepare({
  root = REPO_ROOT,
  out = DEFAULT_OUT,
  maxBytes = MAX_BYTES,
  perShow = BUNDLED_ITEMS_PER_SHOW,
} = {}) {
  const absOut = path.resolve(root, out);
  assertSafeOut(absOut, root);

  const plan = buildPlan(root);
  const shellOnly = shellOnlyPlan(root);
  /* BEFORE the output directory is deleted. A slice that throws — a renamed `items`
     key, a lost show — must leave the last good bundle on disk rather than an empty
     `www/` that a later `cap sync` would happily package. */
  const slices = projectData(root, { perShow, plan });

  fs.rmSync(absOut, { recursive: true, force: true });

  const written = [];
  const put = (destRel, write) => {
    const dest = path.join(absOut, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    write(dest);
    written.push(destRel);
  };
  const copy = (src, destRel) => put(destRel, (dest) => fs.copyFileSync(src, dest));

  for (const rel of plan) {
    if (slices.has(rel)) put(rel, (dest) => fs.writeFileSync(dest, serializeSlice(slices.get(rel))));
    else copy(path.join(root, rel), rel);
  }
  for (const f of shellOnly) copy(path.join(root, f.src), f.dest);

  /* THE INJECTION, and then the re-read. Done before anything is measured so the
     reported size is the size that ships, and asserted against the bytes on disk
     rather than against the string we just built — a write that failed halfway is
     exactly the case a re-parse of an in-memory value cannot see. */
  const indexAbs = path.join(absOut, "index.html");
  const injected = injectShellScripts(fs.readFileSync(indexAbs, "utf8"), shellOnly);
  if (injected.changed) fs.writeFileSync(indexAbs, injected.html);
  assertShellScriptsPresent(fs.readFileSync(indexAbs, "utf8"), shellOnly);

  /* THE SLICES, RE-READ, for the same reason and in the same place. */
  assertSlicesOnDisk(absOut, root);

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
      const sliced = new Set(PROJECTED_DATA.map((p) => p.rel));
      console.log(`${plan.length + shellOnly.length} files would be copied to ${out}:`);
      for (const rel of plan) console.log(`  ${rel}${sliced.has(rel) ? "   (sliced, not copied)" : ""}`);
      for (const f of shellOnly) console.log(`  ${f.src}  ->  ${f.dest}   (shell only)`);
      console.log(`and these tags would be added to ${out}/index.html before </head>:`);
      for (const tag of shellScriptTags(shellOnly)) console.log(`  ${tag}`);
      console.log(`the sliced files carry ${BUNDLED_ITEMS_PER_SHOW} item(s) per show:`);
      for (const [rel, json] of projectData(REPO_ROOT, { plan })) {
        const spec = PROJECTED_DATA.find((p) => p.rel === rel);
        console.log(
          `  ${rel}  ${fmt(sliceBytes(json)).padStart(9)} of ${fmt(spec.maxBytes)}` +
            `   ${JSON.stringify(json.bundled_from)}`
        );
      }
    } else {
      const r = prepare({ out });
      console.log(`webDir ready: ${r.out}  (${r.files.length} files, ${fmt(r.total)} of ${fmt(r.maxBytes)})`);
      for (const spec of PROJECTED_DATA) {
        const f = r.files.find((x) => x.rel === spec.rel);
        console.log(`  sliced: ${spec.rel}  ${fmt(f.bytes)} of ${fmt(spec.maxBytes)}`);
      }
    }
  } catch (e) {
    console.error(`prepare-webdir failed: ${e.message}`);
    process.exit(1);
  }
}
