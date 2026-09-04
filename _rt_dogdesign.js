const { run } = require("./_rt_lib.js");
const { interp, results, cls } = run("dog design");
console.log("groups", interp.groups.map(g=>({tok:g.token,broad:g.broad,thin:g.thin,df:g.df})));
console.log("total", results.length, "status", cls.status, "picks", cls.picks.length);
for (const r of results.slice(0,15)) console.log(r.sum.toFixed(2), r.matched, r.primaryMatched, "|", r.i.show, "|", r.i.title.slice(0,70));
console.log("--- picks ---");
for (const p of cls.picks) console.log(p.sum.toFixed(2), "|", p.i.show, "|", p.i.title.slice(0,70));
