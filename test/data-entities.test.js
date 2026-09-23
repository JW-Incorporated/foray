/* No HTML entity survives in data/*.json (visual pass 1 review, 2026-09-23).
 *
 * WHY THIS EXISTS
 * "Vibe Coding &#038; Linux", "Fedor &#038; Football" and "Grant &#038; Lee"
 * shipped in data/discover.json exactly like that, and app.js's `esc()` —
 * correctly — turned the `&` into `&amp;`, so every episode row on the Show,
 * Episode and Search pages showed the literal "&#038;". The data was the
 * defect, not the renderer: text is decoded once, where it ENTERS data/
 * (tools/refresh/entities.mjs, wired into the feed scan, the show backfill and
 * the classification merge), and this test is what keeps the next nightly
 * from re-introducing one. It reads the decoder's own ENTITY_RE so the two
 * halves cannot disagree about what an entity is.
 *
 * MUTATION: put `&#038;` back into one title in data/discover.json -> red,
 * naming the file, the key and the value.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");

/** Every JSON string value in the file's text, with its line and the key it
    sits under — a text scan, so a 20k-show file is not parsed and re-walked. */
function stringValues(src) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ key: m[1], value: m[2], line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

test("no string value in any data/*.json carries an HTML entity", async () => {
  const { ENTITY_RE } = await import(pathToFileURL(path.join(ROOT, "tools/refresh/entities.mjs")).href);
  const bad = [];
  for (const f of fs.readdirSync(DATA).filter((x) => x.endsWith(".json")).sort()) {
    const src = fs.readFileSync(path.join(DATA, f), "utf8");
    ENTITY_RE.lastIndex = 0;
    if (!ENTITY_RE.test(src)) continue; // the fast path for the files that are clean
    for (const { key, value, line } of stringValues(src)) {
      ENTITY_RE.lastIndex = 0;
      const hit = ENTITY_RE.exec(value);
      if (hit) bad.push(`data/${f}:${line} "${key}": …${value.slice(Math.max(0, hit.index - 20), hit.index + 20)}…`);
    }
  }
  assert.deepStrictEqual(bad.slice(0, 10), [],
    `${bad.length} entity-encoded value(s) in data/ — decode at ingest (tools/refresh/entities.mjs), never in the renderer`);
});

test("the ingest points that write listener-facing text all decode through the one module", () => {
  /* MUTATION: drop the `decodeEntities(` around a title in tools/refresh/scan.mjs -> red. */
  const uses = (rel, re) => assert.match(fs.readFileSync(path.join(ROOT, rel), "utf8"), re, rel);
  uses("tools/refresh/scan.mjs", /import \{ decodeEntities \} from "\.\/entities\.mjs";[\s\S]*const title = decodeEntities\(text\(it\.title\)\);/);
  uses("tools/refresh/backfill-show.mjs", /import \{ decodeEntities \} from "\.\/entities\.mjs";[\s\S]*const title = decodeEntities\(text\(it\.title\)\);/);
  uses("tools/classify/merge-results.mjs", /import \{ decodeEntities \} from "\.\.\/refresh\/entities\.mjs";[\s\S]*blurb: typeof raw\.blurb === "string" \? decodeEntities\(raw\.blurb\)/);
});
