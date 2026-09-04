const { run } = require("./_rt_lib.js");
for (const q of ["not about politics", "anything but comedy", "no politics please"]) {
  const { interp, results, cls } = run(q);
  console.log(q, "-> groups:", interp.groups.map(g=>g.token), "status:", cls.status, "picks:", cls.picks.length);
  for (const p of cls.picks.slice(0,5)) console.log("   ", p.i.show, "|", p.i.title.slice(0,70));
}
