/* Strip comments and whitespace from the JavaScript and CSS the native bundle
 * ships. Identifiers are kept; nothing is renamed, folded or rewritten.
 *
 * WHY THIS EXISTS (docs/mobile-shell-bundle-reduction.md, 2026-09-04)
 * The code half of the bundle went 109 KB -> 1,098 KB in 39 days — +25 KB a day,
 * five times the rate of the one data file everybody was watching — and, measured
 * with a parser rather than a regex, 72% of those bytes were comments and the
 * formatting around them. This repo's commenting culture is a strength in git and
 * a cost on a phone; those are different places. Stripping both takes the shipped
 * code from 1,098 KB to ~303 KB and bends the growth curve by the same 72%.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - Mangle names. `minifyIdentifiers` stays off so a stack trace copied out of
 *     `player/diagnostic-log.js` by a founder in a car still names the function
 *     that threw. Measured: full minification buys a further 47 KB on top of the
 *     794 KB this buys, and costs every readable name in a field record.
 *   - Rewrite syntax. `minifySyntax` stays off too: no constant folding, no
 *     `a(),b()` sequencing, no dropped `debugger`. What runs on the device is the
 *     source with its prose removed, not a different program that behaves the same.
 *   - Inline anything. The page has a strict CSP (`script-src 'self'`, no
 *     `unsafe-inline`) and this transform is one file in, one file out. `esc()` and
 *     `safeUrl()` ship as written; only the whitespace around them goes.
 *   - Touch the web. This is called from `prepare-webdir.mjs` on the way INTO the
 *     bundle. The repo root stays dependency-free and no-build, GitHub Pages keeps
 *     serving the fully commented source, and `prepare-webdir.test.mjs` asserts the
 *     source tree is byte-identical before and after a build.
 *
 * WHY A PARSER AND NOT A REGEX. `//` and `/*` inside template literals and regex
 * literals (`search-engine.js` has both) make a dependency-free comment stripper
 * unsafe without a parser, and this repo has paid for "the fixture was more
 * forgiving than the thing" five times (CLAUDE.md § A green test is not evidence).
 * So the dependency is real — esbuild, pinned exactly in `tools/mobile/package.json`
 * — and it lives HERE rather than at the repo root because the root's freedom from
 * dependencies is what keeps the keyless Pages deploy a plain checkout of `main`.
 *
 * WHY IT IS LOADED LAZILY. `prepare-webdir.mjs --list`, `buildPlan()` and the
 * slice functions need no minifier, and a static `import "esbuild"` would make every
 * one of them fail with ERR_MODULE_NOT_FOUND on a checkout that has not run `npm ci`
 * here — an error about a dependency, raised by code that does not use it. (No
 * root-group suite imports this module: `tools/brand/build-icons.test.mjs` reads
 * `prepare-webdir.mjs` as TEXT, checked rather than assumed, so the runner's group
 * order is not what this protects.) So esbuild is required at the first call, and a
 * missing install is a named error rather than a silent verbatim copy: a bundle
 * that quietly shipped unminified would be bigger, not broken, but CI would then be
 * measuring a bundle nobody installs — the "alarms on a quantity nobody ships"
 * failure the real-repo tests exist to prevent.
 *
 * The research this implements, `docs/mobile-shell-bundle-reduction.md`, is on
 * PR #468's branch (`research/mobile-bundle-reduction`), open and held — not on
 * `main` at the time of writing. `docs/mobile-shell.md` §3.4 carries the numbers.
 */

import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export class MinifyError extends Error {}

/** Which shipped file types are minified, and the esbuild loader for each. JSON is
 *  NOT here: data files are re-serialised by `prepare-webdir.mjs` with
 *  `JSON.stringify`, which needs no parser beyond Node's own. HTML is not here
 *  either — `index.html` is 3.9 KB, and it is the file the shell-only `<script>`
 *  tags are injected into by string position, so it stays a verbatim copy. */
export const MINIFY_LOADERS = Object.freeze({ ".js": "js", ".css": "css" });

/** The esbuild loader for `rel`, or null if the file is copied rather than minified. */
export function minifyLoader(rel) {
  return MINIFY_LOADERS[path.posix.extname(rel)] ?? null;
}

export function isMinified(rel) {
  return minifyLoader(rel) !== null;
}

/** Exactly what is asked of esbuild, in one place, because the bytes are measured
 *  against budgets and compared across runs. Every flag that would change the
 *  program rather than its whitespace is spelled out as `false` so the next reader
 *  sees the decision rather than a default.
 *
 *  `charset: "utf8"`: without it esbuild escapes every non-ASCII character as
 *  `\uXXXX`, which is bigger and is not what the source says. `index.html` declares
 *  `<meta charset="utf-8">`, so the WebView decodes the scripts the same way.
 *  `target: "esnext"`: no syntax lowering — the device runs what the website runs.
 *  `legalComments: "none"`: esbuild's default KEEPS `/*!`-style, `@license` and
 *  `@preserve` comments. None exist in the shipped files today; this makes "every
 *  comment goes" true by construction rather than by inspection. */
export const MINIFY_OPTIONS = Object.freeze({
  minifyWhitespace: true,
  minifySyntax: false,
  minifyIdentifiers: false,
  charset: "utf8",
  target: "esnext",
  legalComments: "none",
});

let esbuild = null;

/** The minifier, resolved from `tools/mobile/node_modules` on first use. */
export function loadMinifier() {
  if (esbuild) return esbuild;
  try {
    esbuild = require("esbuild");
  } catch (e) {
    throw new MinifyError(
      `esbuild is not installed under tools/mobile/, so the bundle's JavaScript and CSS ` +
        `cannot be minified. Run \`npm ci\` in tools/mobile/ (mobile/package.json's ` +
        `prepare:webdir script does this for you; tools/ci/run-suites.mjs does it in CI). ` +
        `This is a hard error rather than a verbatim copy so that a bundle nobody ` +
        `measured never ships. (${e.message})`
    );
  }
  return esbuild;
}

/**
 * Minify one shipped file's text. Comments and whitespace go; identifiers, syntax,
 * string contents and template literals stay exactly as written.
 *
 * A NOTE ON LINE ENDINGS, because the first draft normalised them here and the
 * mutation that removed the normalisation survived its test: esbuild normalises
 * line terminators itself, in JS (the spec's TV/TRV rule for template literals) and
 * in CSS (custom-property values included — measured). So a bundle built on a
 * Windows checkout (`core.autocrlf=true`) carries no `\r` in any minified file and
 * measures the same as CI's for those files. `minify.test.mjs` pins that as a
 * property of the dependency rather than of this code.
 *
 * THE OUTPUT IS RE-PARSED AND MUST BE A FIXED POINT. Minifying the minified text a
 * second time must reproduce it byte for byte. That is two guarantees for the price
 * of one transform: the emitted code parses (or the second pass throws), and the
 * transform is deterministic on its own output (or the bytes differ). It is the
 * in-process stand-in for `node --check` on every emitted file — which cannot be
 * run directly on the bundle's `player/*.js`, because outside `player/package.json`'s
 * `"type": "module"` Node would parse them as CommonJS and reject the `import`s.
 * `prepare-webdir.test.mjs` runs the real `node --check` over the real bundle
 * separately.
 *
 * @throws {MinifyError} if `rel` is not a minified type, or the output is not a
 *   fixed point of the transform.
 */
export function minifySource(rel, text) {
  const loader = minifyLoader(rel);
  if (!loader) throw new MinifyError(`${rel} is not a file this minifies (only ${Object.keys(MINIFY_LOADERS).join(", ")})`);
  const { transformSync } = loadMinifier();
  const opts = { ...MINIFY_OPTIONS, loader, sourcefile: rel };
  const { code } = transformSync(String(text), opts);
  const again = transformSync(code, opts).code;
  if (again !== code) {
    throw new MinifyError(
      `${rel}: minifying the minified output changed it (${code.length} -> ${again.length} chars). ` +
        `The transform is expected to be a fixed point; a difference means it is not ` +
        `deterministic, and a bundle that differs run to run makes "did the code change?" ` +
        `unanswerable.`
    );
  }
  return code;
}
