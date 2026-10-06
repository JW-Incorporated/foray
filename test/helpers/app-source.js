/* The ONE place the suites learn which files make up the web client.
 *
 * app.js was split (Redesign 2026, phase 0d) into a core `app.js` plus
 * per-screen classic scripts under `ui/`. index.html loads them with plain
 * `<script src>` tags, and THAT list, in that order, is the definition of
 * "the app": this helper reads it from index.html so a new `ui/*.js` file
 * cannot be loaded by the page and invisible to the suites (or the reverse).
 *
 *   appFiles()            ["app.js", "ui/browse.js", ..., "ui/boot.js"] in load order
 *   readAppSource()       every file's text, concatenated in load order, each
 *                         introduced by a one-line marker comment. Source-
 *                         scanning invariants (esc/safeUrl, no inline style, cp_
 *                         keys, copy rules) read THIS, so they cover all UI code.
 *   runAppSource(src, ctx[, filename])
 *                         runs that concatenation in a node:vm context as one
 *                         classic script PER FILE, in order, exactly the way the
 *                         browser does. Tests that patch the source first
 *                         (`src.replace(...)`) keep working: the markers survive
 *                         the patch and are what splits it back apart. A string
 *                         with no markers is run as one script.
 *
 * Why separate scripts rather than one big one: a function declared in a later
 * file is NOT hoisted into an earlier file's top level, and a `const` in a later
 * file is in its temporal dead zone. One concatenated script would hide both,
 * and the browser would not.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const MARK_RE = /^\/\*@@APP-FILE (\S+)@@\*\/$/gm;

/** Files that make up the client, in the order index.html loads them. */
function appFiles() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const files = [];
  const re = /<script\b[^>]*\bsrc="((?:app|ui\/[A-Za-z0-9_.-]+)\.js)(?:\?[^"]*)?"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) files.push(m[1]);
  if (files[0] !== "app.js") throw new Error("index.html must load app.js first; saw " + JSON.stringify(files));
  return files;
}

/** One file's text, LF-normalised. A Windows checkout (core.autocrlf=true) holds CRLF on
 *  disk while CI and the committed blobs are LF; the suites' regexes and slice
 *  boundaries (a function's closing brace on its own line) are written against
 *  LF, so read it that way everywhere. */
function readAppFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

/** The whole client as one string, in load order, with a marker before each file. */
function readAppSource() {
  return appFiles()
    .map((f) => `/*@@APP-FILE ${f}@@*/\n${readAppFile(f)}`)
    .join("\n");
}

/** Split a (possibly patched) concatenation back into [{ file, code }]. */
function splitAppSource(src) {
  const marks = [...src.matchAll(MARK_RE)];
  if (marks.length === 0) return [{ file: "app.js", code: src }];
  const parts = [];
  // Anything before the first marker (a test prepended a shim) rides with the first file.
  const head = src.slice(0, marks[0].index);
  marks.forEach((m, i) => {
    const start = m.index + m[0].length + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    parts.push({ file: m[1], code: (i === 0 ? head : "") + src.slice(start, end) });
  });
  return parts;
}

/** Run the client (or a patched copy of readAppSource()) in `ctx`, one script per file. */
function runAppSource(src, ctx) {
  for (const { file, code } of splitAppSource(src)) vm.runInContext(code, ctx, { filename: file });
}

module.exports = { ROOT, appFiles, readAppFile, readAppSource, splitAppSource, runAppSource };
