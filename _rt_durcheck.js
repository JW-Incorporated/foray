const { run } = require("./_rt_lib.js");
const { results, cls } = run("something under 20 minutes about cooking");
console.log("status", cls.status, "picks", cls.picks.length);
for (const p of cls.picks) console.log(p.i.duration_min, "min |", p.i.show, "|", p.i.title.slice(0,70));
