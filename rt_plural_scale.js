const { run } = require("./rt_harness.js");
const { freshCtx, SE, discover, semantic } = require("./rt_harness.js");
const ctx = freshCtx();

// Quantify: for each singular-only "gap" term (has plural variant NOT in
// vocabulary as its own term but IS the exact base minus trailing s of a
// term), compare classifyResults status singular vs plural.
const pairs = [
  ["satellite","satellites"], ["astronaut","astronauts"], ["drone","drones"],
  ["algorithm","algorithms"], ["transistor","transistors"], ["entrepreneur","entrepreneurs"],
  ["fusion","fusions"], ["energy","energies"], ["culture","cultures"],
  ["computer","computers"], ["soldier","soldiers"], ["gladiator","gladiators"],
  ["pyramid","pyramids"], ["recipe","recipes"], ["nomad","nomads"],
];
for (const [sing, plural] of pairs) {
  const i1 = SE.interpretQuery(sing, ctx);
  const r1 = SE.searchWithRelaxation(discover.items, i1, 2, null, () => 0.5).results;
  const c1 = SE.classifyResults(r1, {});
  const i2 = SE.interpretQuery(plural, ctx);
  const r2 = SE.searchWithRelaxation(discover.items, i2, 2, null, () => 0.5).results;
  const c2 = SE.classifyResults(r2, {});
  console.log(`${sing.padEnd(14)} status=${c1.status.padEnd(6)} picks=${c1.picks.length}   |   ${plural.padEnd(14)} status=${c2.status.padEnd(6)} picks=${c2.picks.length}`);
}
