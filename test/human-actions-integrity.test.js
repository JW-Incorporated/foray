/* Guard on HUMAN-ACTIONS.md's own numbering rule.
 *
 * WHY THIS EXISTS. The file's own header says item numbers are stable IDs:
 * "never reused, never renumbered, so #1 means the same thing forever". A
 * full-repo review (2026-08-31, finding L3) found #26 reused for two
 * different actions ("Publish the Play Store listing" and "Back up the
 * Android upload key"), which is exactly the drift the rule exists to
 * prevent and which nothing here was catching. This test parses every
 * `### N. ...` heading in the file and fails if any numeric ID appears more
 * than once.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "HUMAN-ACTIONS.md");

function itemIds() {
  const text = fs.readFileSync(FILE, "utf8");
  const ids = [];
  for (const line of text.split("\n")) {
    const m = /^###\s+(\d+)\.\s/.exec(line);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

test("HUMAN-ACTIONS.md has at least one numbered item", () => {
  const ids = itemIds();
  assert.ok(ids.length > 0, "expected `### N. ...` headings in HUMAN-ACTIONS.md");
});

test("HUMAN-ACTIONS.md item numbers are never reused", () => {
  const ids = itemIds();
  const seen = new Map();
  const dupes = [];
  for (const id of ids) {
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) dupes.push(id);
  }
  assert.deepEqual(
    dupes,
    [],
    `HUMAN-ACTIONS.md reuses item number(s) ${dupes.join(", ")} — ` +
      "item numbers are stable IDs per the file's own header and must never " +
      "repeat; give the later block the next unused number instead."
  );
});
