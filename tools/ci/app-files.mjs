/* Which files make up the web client, for the tools that read its source.
 *
 * app.js was split (Redesign 2026, phase 0d) into a core `app.js` plus
 * per-screen classic scripts under `ui/`. index.html's `<script src>` tags, in
 * order, are the definition of "the app"; this reads them so a tool that scans
 * client code (a function lifted into a vm, a fetch list, a copy scan) sees all
 * of it and cannot miss a screen that moved. The suites have the same thing in
 * `test/helpers/app-source.js`; keep the two parsing the same tags.
 */
import fs from "node:fs";
import path from "node:path";

const TAG_RE = /<script\b[^>]*\bsrc="((?:app|ui\/[A-Za-z0-9_.-]+)\.js)(?:\?[^"]*)?"[^>]*>/g;

/** ["app.js", "ui/...", ..., "ui/boot.js"] in the order index.html loads them. */
export function appScriptFiles(root) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const files = [...html.matchAll(TAG_RE)].map((m) => m[1]);
  if (files[0] !== "app.js") throw new Error(`index.html must load app.js first; saw ${JSON.stringify(files)}`);
  return files;
}

/** Every client script's text, LF-normalised, concatenated in load order. */
export function readAppText(root) {
  return appScriptFiles(root)
    .map((rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n"))
    .join("\n");
}
