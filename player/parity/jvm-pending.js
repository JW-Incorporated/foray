/* The JVM burn-down books: player/parity/jvm-pending.json (card A-22,
   docs/plans/android-assessment.md §5.4).

   The Android engine's core is a Java port of ForayEngineCore
   (mobile/plugins/foray-audio/android/foray-engine-core-jvm), held to the SAME
   fixtures as the Swift one by a JVM ParitySuite that android-build.yml runs.
   swift-pending.json keeps the Swift books; this file keeps the JVM's, in two
   grains because the JVM starts with almost nothing ported:

     "families": { "<family>": "A-23" }   the whole family is owed: no JVM runner
                                          yet, so every id it has or will have is
                                          owed, and a JS PR that adds a case to it
                                          owes the JVM nothing new.
     "cases":    { "<id>": "A-23" }        one case owed inside a family the JVM
                                          DOES run (a partial port, or a JS rule
                                          change the port has not caught up with).

   The JVM runner fails when a case not owed fails, when an owed case passes
   (stale: burn the entry down), and when a manifest id is neither run nor owed.
   record.mjs keeps these books from the JS side exactly as it keeps
   swift-pending's: a new or changed case in a family the JVM runs, or a brand-new
   family, is handed to the Android card named by --jvm-card, so a JS rule change
   never turns android-build red; it hands the JVM card a list.

   A family that unported.json says covered-suite tests will be recorded into may
   be owed here before it has a fixture (the JS side owes those tests first), so
   the card that records it needs no --jvm-card. */

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
    if (!k.startsWith("//") && k !== "families" && k !== "cases") problems.push(`jvm-pending: unknown key ${JSON.stringify(k)}`);
  }
  const obj = (k) => {
    const v = doc[k];
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      problems.push(`jvm-pending: "${k}" must be an object`);
      return {};
    }
    return v;
  };
  const comments = Object.fromEntries(Object.entries(doc).filter(([k]) => k.startsWith("//")));
  return { families: { ...obj("families") }, cases: { ...obj("cases") }, comments, problems };
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
  for (const [family, card] of Object.entries(jvm.families)) {
    if (!families.has(family) && !unported.has(family)) {
      problems.push(`jvm-pending: family ${family} is neither recorded nor named in unported.json: delete the entry`);
    }
    if (jsOnlyFamilies.has(family)) problems.push(`jvm-pending: family ${family} is jsOnly; no JVM card can owe it`);
    if (!JVM_CARD_RE.test(card)) problems.push(`jvm-pending: family ${family} is tagged ${JSON.stringify(card)}, not an Android card id`);
  }
  for (const [id, card] of Object.entries(jvm.cases)) {
    const family = familyOf.get(id);
    if (family === undefined) problems.push(`jvm-pending: ${id} names no fixture case`);
    else if (jsOnlyFamilies.has(family)) problems.push(`jvm-pending: ${id} is in a jsOnly family; no JVM card can owe it`);
    else if (family in jvm.families) problems.push(`jvm-pending: ${id} is owed on its own and with its whole family ${family}: keep one entry`);
    if (!JVM_CARD_RE.test(card)) problems.push(`jvm-pending: ${id} is tagged ${JSON.stringify(card)}, not an Android card id`);
  }
  return problems;
}

/**
 * What a record run owes the JVM. `affected`: [{id, family}] new or changed, not
 * jsOnly; `knownFamilies`: the families recorded BEFORE this run. Returns
 * `{families, cases}` to add: a brand-new family is owed whole, and a new or
 * changed id is owed on its own only when its family is not already owed whole
 * (nor the id already owed). Nothing here needs a card when both are empty.
 */
export function jvmOwedBy(jvm, affected, knownFamilies) {
  const families = new Set();
  const cases = new Set();
  for (const { id, family } of affected) {
    if (family in jvm.families) continue;
    if (!knownFamilies.has(family)) families.add(family);
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
  return { doc: { ...jvm.comments, cases: sorted(cases), families: sorted(families) }, dropped };
}
