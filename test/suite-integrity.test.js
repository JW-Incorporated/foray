/* Guard on the guards.
 *
 * WHY THIS EXISTS
 * `test/` and `player/` are in the auto-merge allowlist
 * (.github/workflows/automerge-nightly.yml), so an agent-authored PR touching
 * them can land with no human read. That creates one specific hole the path
 * allowlist cannot close by itself: a PR that DELETES or GUTS a test suite
 * still passes CI, because a suite with nothing in it passes trivially. The
 * attack (or, far more likely, the accident) is two steps — weaken the gate in
 * PR 1, land the thing it would have caught in PR 2 — and nothing between those
 * two steps involves a human.
 *
 * So: every suite carries a committed floor. Removing tests fails the build.
 *
 * ADDING tests is always fine and never requires touching this file. Raising a
 * floor is encouraged when a suite grows meaningfully. LOWERING one is the
 * deliberate act this file exists to make visible — do it in a PR that says why,
 * and note that this file is itself allowlisted, so the honest protection here
 * is that gutting the gate now requires editing two files instead of one, in a
 * diff that the weekly merge audit surfaces.
 *
 * This is a floor, not a coverage metric. It cannot tell a real test from
 * `test("x", () => {})`. It only makes deletion loud.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/* suite -> minimum number of top-level test() declarations. */
const FLOORS = {
  "player/html-audio-backend.test.js": 22,
  "player/queue-manager.test.js": 26,
  "player/queue-state.test.js": 43,
  "player/seek-policy.test.js": 17,
  "test/app-security.test.js": 18,
  // tools/ is allowlisted for auto-merge too (T3 in automerge-nightly.yml),
  // so suites under it need the same floor. The discovery check below still
  // only walks player/ and test/ — the older tools/refresh suites predate this
  // guard and are not floored yet.
  "tools/segments/transcript-normalize.test.mjs": 24,
  "tools/segments/merge-segments.test.mjs": 39,
};

for (const [rel, floor] of Object.entries(FLOORS)) {
  test(`${rel} still exists and has >= ${floor} tests`, () => {
    const full = path.join(ROOT, rel);
    assert.ok(
      fs.existsSync(full),
      `${rel} is missing. Deleting a suite is not a valid way to make CI pass.`
    );
    const src = fs.readFileSync(full, "utf8");
    const count = (src.match(/^\s*test\(/gm) || []).length;
    assert.ok(
      count >= floor,
      `${rel} has ${count} tests but the committed floor is ${floor}. ` +
        `If you removed tests on purpose, lower the floor in test/suite-integrity.test.js ` +
        `in the same PR and say why.`
    );
  });
}

test("every suite on disk is covered by a floor", () => {
  // A new suite that nobody floors is a gate that can be silently deleted
  // later. Catch it at the moment it is added, which is the only cheap moment.
  const found = [
    ...fs.readdirSync(path.join(ROOT, "player")).filter((f) => f.endsWith(".test.js")).map((f) => `player/${f}`),
    ...fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js")).map((f) => `test/${f}`),
  ].filter((f) => f !== "test/suite-integrity.test.js");

  const unfloored = found.filter((f) => !(f in FLOORS));
  assert.deepStrictEqual(
    unfloored, [],
    "these suites have no committed floor — add them to FLOORS:\n" + unfloored.join("\n")
  );
});
