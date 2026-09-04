const { run } = require("./_rt_lib.js");
const { results, cls } = run("dog training tips");
console.log("status", cls.status, "picks", cls.picks.length);
for (const p of cls.picks) console.log(p.sum.toFixed(2), p.i.show, "|", p.i.title.slice(0,80));
