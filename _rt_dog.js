const { summarize, run } = require("./_rt_lib.js");

const { interp, results } = run("dog training tips");
console.log("interp groups:", interp.groups.map(g=>({tok:g.token,broad:g.broad,thin:g.thin,hasConceptExpansion:g.hasConceptExpansion,df:g.df})));
console.log("total results:", results.length);
for (const r of results) {
  console.log(r.sum.toFixed(2), "matched="+r.matched, "primaryMatched="+r.primaryMatched, "|", r.i.show, "|", r.i.title.slice(0,80));
}
