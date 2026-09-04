const { run } = require("./_rt_lib.js");
// Show full detail for the worst case: "coffee design"
const { interp, results, cls } = run("coffee design");
console.log("groups:", interp.groups.map(g=>`${g.token}(broad=${g.broad},thin=${g.thin},hasConceptExpansion=${g.hasConceptExpansion},df=${g.df})`));
console.log("total results", results.length, "status", cls.status);
console.log("--- all 10 picks (in order) ---");
for (const p of cls.picks) console.log(p.sum.toFixed(2), "|", p.i.show, "|", p.i.title.slice(0,75));
