/* The JVM's books: player/parity/jvm-pending.json (card A-22, retired to
   "runs" only by A-63; docs/plans/android-assessment.md §5.4 and §5.7).

   The Android engine's core is a Java port of ForayEngineCore
   (mobile/plugins/foray-audio/android/foray-engine-core-jvm), held to the SAME
   fixtures as the Swift one by a JVM ParitySuite that android-build.yml runs.

   Until A-63 this file was a burn-down list in two grains, "families" (a
   whole family no JVM runner ran yet, owed to the Android card that ports it)
   and "cases" (one case owed inside a family the JVM ran), and record.mjs
   handed a JS rule change to a card with --jvm-card. A-63 ported the last
   owed family (manager-remainder) and the last owed case, and retired owing,
   as NE-39s retired swift-pending.json and unported.json for Swift:

     "runs": [ "<family>", ... ]   the families the JVM HAS a runner for
                                   (JvmFamilies.ALL; the JVM suite fails when
                                   the two disagree). Since A-63 that is EVERY
                                   recorded family that is not jsOnly.

   What `record.mjs --check` (ci.yml, every PR) holds from then on:
     - the file has no "families" and no "cases" key (an empty one included:
       a book that comes back would owe again);
     - every recorded family that is not jsOnly is in "runs", and "runs" names
       only recorded, non-jsOnly families.
   So a JS change that records a new family carries its JVM runner (and its
   "runs" entry) in the same change, and a re-recorded case in a family the
   JVM runs is held by the JVM runner (android-build) until its port lands in
   that same change. record.mjs refuses --jvm-card. The JVM loader
   (ParityData.load) refuses a tree whose jvm-pending.json owes anything. */

import fs from "node:fs";
import path from "node:path";

export const JVM_PENDING_FILE = "jvm-pending.json";

/** An Android card id: A-22, A-40, A-23b. The JVM ParitySuite checks the same shape. */
export const JVM_CARD_RE = /^A-\d{2}[a-z]?$/;

/** The two keys A-63 retired: nothing may be owed to the JVM any more. */
export const RETIRED_JVM_KEYS = Object.freeze(["families", "cases"]);

/** Why --jvm-card is refused (record.mjs), and what a retired key back in the file says (--check). */
export const JVM_OWING_RETIRED =
  "A-63 retired owing to the JVM: it runs every recorded family, so a JS rule change carries its JVM port in the same change";

/** Read the books. `{runs, comments, problems}`; a missing file is an error the caller reports. */
export function loadJvmPending(root, parityDir = "player/parity") {
  const doc = JSON.parse(fs.readFileSync(path.join(root, parityDir, JVM_PENDING_FILE), "utf8"));
  const problems = [];
  for (const k of Object.keys(doc)) {
    if (k.startsWith("//") || k === "runs") continue;
    if (RETIRED_JVM_KEYS.includes(k)) {
      problems.push(`jvm-pending: "${k}" is back: ${JVM_OWING_RETIRED}. Delete the key (even an empty one)`);
    } else {
      problems.push(`jvm-pending: unknown key ${JSON.stringify(k)}`);
    }
  }
  let runs = doc.runs;
  if (!Array.isArray(runs) || !runs.every((f) => typeof f === "string")) {
    problems.push(`jvm-pending: "runs" must be an array of family names (the families the JVM has a runner for)`);
    runs = [];
  }
  for (const f of new Set(runs.filter((x, i) => runs.indexOf(x) !== i))) problems.push(`jvm-pending: "runs" lists ${f} twice`);
  const comments = Object.fromEntries(Object.entries(doc).filter(([k]) => k.startsWith("//")));
  return { runs: [...new Set(runs)], comments, problems };
}

/**
 * --check's view of the books. `families`: every recorded family;
 * `jsOnlyFamilies`: the families whose rule the page computes (never run).
 * Every recorded family that is not jsOnly must be in "runs" (nothing may be
 * owed since A-63), and "runs" names only recorded, non-jsOnly families.
 */
export function checkJvmPending(jvm, { families, jsOnlyFamilies }) {
  const problems = [...(jvm.problems ?? [])];
  const runs = new Set(jvm.runs ?? []);
  for (const family of [...families].sort()) {
    if (jsOnlyFamilies.has(family) || runs.has(family)) continue;
    problems.push(`jvm-pending: family ${family} is recorded but the JVM does not run it: ${JVM_OWING_RETIRED}. ` +
      `Register its JVM runner (JvmFamilies.ALL) and list it in "runs" in this change`);
  }
  for (const family of [...runs].sort()) {
    if (!families.has(family)) problems.push(`jvm-pending: "runs" lists family ${family}, which is not recorded`);
    else if (jsOnlyFamilies.has(family)) problems.push(`jvm-pending: "runs" lists family ${family}, which is jsOnly; the JVM never runs it`);
  }
  return problems;
}
