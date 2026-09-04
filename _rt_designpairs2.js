const { run } = require("./_rt_lib.js");
function check(q, relatedRegex) {
  const { interp, cls } = run(q);
  console.log(q, "groups:", interp.groups.map(g=>`${g.token}(broad=${g.broad},thin=${g.thin},hasConceptExpansion=${g.hasConceptExpansion},df=${g.df.toFixed(4)})`).join(", "), "thinAnchorCount=", interp.thinAnchorCount, "properNounQuery=", interp.properNounQuery);
  if (cls.status === "empty") { console.log("  -> empty"); return; }
  let related = 0, unrelated = 0;
  for (const p of cls.picks) {
    const blob = (p.i.title + " " + (p.i.hook||"")).toLowerCase();
    if (relatedRegex.test(blob)) related++; else unrelated++;
  }
  console.log(`  -> status=${cls.status} picks=${cls.picks.length} related=${related} unrelated=${unrelated}`);
}
check("dog design", /\bdogs?\b|\bcanine\b|\bpupp/);
check("cat design", /\bcats?\b|\bfeline\b|\bkitten/);
check("horse design", /\bhorses?\b|\bequine\b/);
check("garden design", /\bgarden/);
check("wine design", /\bwine\b/);
check("coffee design", /\bcoffee\b/);
check("bird design", /\bbirds?\b/);
