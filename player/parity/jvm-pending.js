/* The JVM burn-down books: player/parity/jvm-pending.json (card A-22,
   docs/plans/android-assessment.md §5.4).

   The Android engine's core is a Java port of ForayEngineCore
   (mobile/plugins/foray-audio/android/foray-engine-core-jvm), held to the SAME
   fixtures as the Swift one by a JVM ParitySuite that android-build.yml runs.
   swift-pending.json kept the Swift books until NE-39s (M3) burned them to
   nothing and deleted them; this file keeps the JVM's, and STAYS (A-63 retires
   it), in two grains because the JVM starts with almost nothing ported:

     "families": { "<family>": "A-23" }   the whole family is owed: no JVM runner
                                          yet, so every id it has or will have is
                                          owed, and a JS PR that adds a case to it
                                          owes the JVM nothing new.
     "cases":    { "<id>": "A-23" }        one case owed inside a family the JVM
                                          DOES run (a partial port, or a JS rule
                                          change the port has not caught up with).
     "runs":     [ "<family>", ... ]      the families the JVM HAS a runner for
                                          (JvmFamilies.ALL; the JVM suite fails
                                          when the two disagree).

   Every recorded family that is not jsOnly is in exactly one of "runs" and
   "families", and `record.mjs --check` (ci.yml, which runs on every PR) holds
   that partition. Without "runs" the JS side could not tell a family the JVM
   runs from one nobody owes, so a family recorded on a branch cut before this
   file existed would merge green and turn only the (non-required) android-build
   job red, on whichever Android PR came next.

   The JVM runner fails when a case not owed fails, when an owed case passes
   (stale: burn the entry down), and when a manifest id is neither run nor owed.
   record.mjs keeps these books from the JS side exactly as it kept
   swift-pending's: a new or changed case in a family the JVM runs, or a brand-new
   family, is handed to the Android card named by --jvm-card, so a JS rule change
   never turns android-build red; it hands the JVM card a list.

   Until NE-39s a family that unported.json said covered-suite tests would be
   recorded into could be owed here ahead of its fixtures. unported.json is
   retired, so that set is always empty (`unportedFamilies({})`); the parameter
   stays so a book written before the retirement is still judged the same way. */

import fs from "node:fs";
import path from "node:path";

export const JVM_PENDING_FILE = "jvm-pending.json";

/** An Android card id: A-22, A-40, A-23b. The JVM ParitySuite checks the same shape. */
export const JVM_CARD_RE = /^A-\d{2}[a-z]?$/;

/** Read the books. `{families, cases, comment}`; a missing file is an error the caller reports. */
export function loadJvmPending(root, parityDir = "player/parity") {
  const doc = JSON.parse(fs.readFileSync(path.join(root, parityDir, JVM_PENDING_FILE), "utf8"));
  const problems = [];
  for (const k of Object.keys(doc)) {
    if (!k.startsWith("//") && k !== "families" && k !== "cases" && k !== "runs") problems.push(`jvm-pending: unknown key ${JSON.stringify(k)}`);
  }
  const obj = (k) => {
    const v = doc[k];
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      problems.push(`jvm-pending: "${k}" must be an object`);
      return {};
    }
    return v;
  };
  let runs = doc.runs;
  if (!Array.isArray(runs) || !runs.every((f) => typeof f === "string")) {
    problems.push(`jvm-pending: "runs" must be an array of family names (the families the JVM has a runner for)`);
    runs = [];
  }
  for (const f of new Set(runs.filter((x, i) => runs.indexOf(x) !== i))) problems.push(`jvm-pending: "runs" lists ${f} twice`);
  const comments = Object.fromEntries(Object.entries(doc).filter(([k]) => k.startsWith("//")));
  return { families: { ...obj("families") }, cases: { ...obj("cases") }, runs: [...new Set(runs)], comments, problems };
}

/** The families unported.json says tests will be recorded into. */
export function unportedFamilies(unported) {
  const out = new Set();
  for (const [stem, tests] of Object.entries(unported ?? {})) {
    if (stem.startsWith("//") || tests === null || typeof tests !== "object") continue;
    for (const v of Object.values(tests)) if (typeof v?.family === "string") out.add(v.family);
  }
  return out;
}

/**
 * --check's view of the books. `familyOf`: case id -> family, for every recorded
 * case; `families`: every recorded family; `jsOnlyFamilies`: the families whose
 * rule the page computes (never owed); `unported`: unportedFamilies().
 */
export function checkJvmPending(jvm, { familyOf, families, jsOnlyFamilies, unported }) {
  const problems = [...(jvm.problems ?? [])];
  const runs = new Set(jvm.runs ?? []);
  // The partition: every recorded family the JVM could run is either run or owed whole, never both, never neither.
  for (const family of [...families].sort()) {
    if (jsOnlyFamilies.has(family)) continue;
    const owed = family in jvm.families;
    if (runs.has(family) && owed) {
      problems.push(`jvm-pending: family ${family} is both in "runs" and owed whole: keep one`);
    } else if (!runs.has(family) && !owed) {
      problems.push(`jvm-pending: family ${family} is recorded but the JVM neither runs it nor owes it: ` +
        `owe it whole to the Android card that ports it ("families", or record.mjs --jvm-card A-xx), or list it in "runs" with its JVM runner`);
    }
  }
  for (const family of [...runs].sort()) {
    if (!families.has(family)) problems.push(`jvm-pending: "runs" lists family ${family}, which is not recorded`);
    else if (jsOnlyFamilies.has(family)) problems.push(`jvm-pending: "runs" lists family ${family}, which is jsOnly; the JVM never runs it`);
  }
  for (const [family, card] of Object.entries(jvm.families)) {
    if (!families.has(family) && !unported.has(family)) {
      problems.push(`jvm-pending: family ${family} is not recorded: delete the entry`);
    }
    if (jsOnlyFamilies.has(family)) problems.push(`jvm-pending: family ${family} is jsOnly; no JVM card can owe it`);
    if (!JVM_CARD_RE.test(card)) problems.push(`jvm-pending: family ${family} is tagged ${JSON.stringify(card)}, not an Android card id`);
  }
  for (const [id, card] of Object.entries(jvm.cases)) {
    const family = familyOf.get(id);
    if (family === undefined) problems.push(`jvm-pending: ${id} names no fixture case`);
    else if (jsOnlyFamilies.has(family)) problems.push(`jvm-pending: ${id} is in a jsOnly family; no JVM card can owe it`);
    else if (family in jvm.families) problems.push(`jvm-pending: ${id} is owed on its own and with its whole family ${family}: keep one entry`);
    else if (!runs.has(family)) problems.push(`jvm-pending: ${id} is owed on its own, but its family ${family} is not in "runs"`);
    if (!JVM_CARD_RE.test(card)) problems.push(`jvm-pending: ${id} is tagged ${JSON.stringify(card)}, not an Android card id`);
  }
  return problems;
}

/**
 * What a record run owes the JVM. `affected`: [{id, family}] new or changed, not
 * jsOnly. Returns `{families, cases}` to add: a family the JVM neither runs nor
 * owes (a brand-new one, or one recorded before these books existed) is owed
 * whole, and a new or changed id in a family the JVM runs is owed on its own
 * (unless already owed). Nothing here needs a card when both are empty.
 */
export function jvmOwedBy(jvm, affected) {
  const runs = new Set(jvm.runs ?? []);
  const families = new Set();
  const cases = new Set();
  for (const { id, family } of affected) {
    if (family in jvm.families) continue;
    if (!runs.has(family)) families.add(family);
    else if (!(id in jvm.cases)) cases.add(id);
  }
  return { families: [...families].sort(), cases: [...cases].sort() };
}

/**
 * The books after a record run: `owed` (jvmOwedBy's answer) tagged `card`, and
 * entries whose case or family no longer exists dropped (a family unported.json
 * still names is kept). Returns `{doc, dropped}`; `doc` is ready for stableJson.
 */
export function nextJvmPending(jvm, { owed, card, liveIds, liveFamilies, unported }) {
  const families = { ...jvm.families };
  const cases = { ...jvm.cases };
  for (const f of owed.families) families[f] = card;
  for (const id of owed.cases) cases[id] = card;
  const dropped = [];
  for (const f of Object.keys(families)) {
    if (!liveFamilies.has(f) && !unported.has(f)) { dropped.push(`family ${f}`); delete families[f]; }
  }
  for (const id of Object.keys(cases)) {
    if (!liveIds.has(id)) { dropped.push(id); delete cases[id]; }
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  // "runs" is kept as it is: a runner whose family is gone is the JVM suite's to report, and --check's.
  return { doc: { ...jvm.comments, cases: sorted(cases), families: sorted(families), runs: [...(jvm.runs ?? [])].sort() }, dropped };
}
