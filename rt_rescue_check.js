const { freshCtx, SE, discover } = require("./rt_harness.js");
const ctx = freshCtx();

// Does the show-name RESCUE (search-engine.js ~L853) apply only when
// groups.length >= 2? Confirm single-token show queries can never rescue,
// regardless of thin-ness, by using a non-thin single word that IS a show name
// but has zero concept expansion and low text-body hit rate.
for (const q of ["radiolab", "gastropod", "spycast", "causality", "storycorps"]) {
  const interp = SE.interpretQuery(q, ctx);
  console.log(q, "groups.length=", interp.groups.length, "-> rescue eligible?", interp.groups.length >= 2);
}
