const { freshCtx, SE, discover } = require("./rt_harness.js");
const ctx = freshCtx();

const q = "volts";
const interp = SE.interpretQuery(q, ctx);
console.log("interp.groups:", JSON.stringify(interp.groups.map(g=>({token:g.token, thin:g.thin, broad:g.broad, hasConceptExpansion:g.hasConceptExpansion})), null, 1));

const voltsItems = discover.items.filter(i => i.show === "Volts");
console.log("Volts items in pool:", voltsItems.length);
for (const item of voltsItems.slice(0, 3)) {
  const score = SE.scoreMatch(item, interp, null);
  console.log(item.title, "->", JSON.stringify(score));
}
