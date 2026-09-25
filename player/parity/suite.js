/* The assertion half of a suite that READS its fixtures (plan §6.3; NE-08).

   The new suites — position-store, transport-policy, and continuation after
   them — do not restate their expectations in JS. Each top-level test() runs
   every fixture case whose `covers[]` names it, against the real module, and
   compares with the recorded `expect`. So one file is both the JS assertion and
   the Swift case, and the two cannot drift: a JS change that moves a rule turns
   the test red until `record.mjs` re-records it, and re-recording hands the
   changed ids to swift-pending.json for the Swift port.

   A test that no case covers FAILS rather than passing empty: a top-level test
   with nothing behind it would read as coverage and assert nothing. The
   coverage guard (coverage.test.js) checks the other direction — every test is
   covered, excluded or owed. */

import assert from "node:assert/strict";
import { loadFixtures, runCase } from "./runner.js";
import { compare, formatDiffs } from "./compare.js";

/**
 * An assertion for the tests of suite `stem`, over fixture family `family`.
 * Call it with the test's context: `test("name", (t) => cases(t))`. The name
 * is read from the context, so the covers[] key and the test name are one
 * string and cannot disagree.
 * @returns {(t: {name: string}) => Promise<number>} resolves to the case count
 */
export function fixtureCases(family, stem) {
  const fixtures = loadFixtures(undefined, { family });
  return async function assertCases(t) {
    const key = `${stem}::${t.name}`;
    const cases = [];
    for (const fx of fixtures) {
      for (const c of fx.doc.cases) if (c.covers?.includes(key)) cases.push([fx, c]);
    }
    assert.ok(cases.length > 0, `no ${family} fixture case covers ${JSON.stringify(key)}`);
    for (const [fx, c] of cases) {
      assert.ok("expect" in c, `${c.id} has never been recorded — run tools/parity/record.mjs --family ${family} --port-card <card>`);
      const actual = await runCase(c, fx);
      const diffs = compare(c.expect, actual, { family, tolerance: c.tolerance });
      assert.equal(diffs.length, 0, `${c.id}${c.authored ? " (AUTHORED)" : ""}: the JS no longer matches the fixture\n${formatDiffs(diffs)}`);
    }
    return cases.length;
  };
}
