const { run } = require("./_rt_lib.js");
function check(q, relatedRegex) {
  const { interp, cls } = run(q);
  if (cls.status === "empty") { console.log(q, "-> empty"); return; }
  let related = 0, unrelated = 0;
  for (const p of cls.picks) {
    const blob = (p.i.title + " " + (p.i.hook||"")).toLowerCase();
    if (relatedRegex.test(blob)) related++; else unrelated++;
  }
  console.log(q, `-> status=${cls.status} picks=${cls.picks.length} related=${related} unrelated=${unrelated}`);
}
// test other high-df concept words that are common show-title words like "design"
check("cheese startups", /\bcheese\b/); // startups is concept-expansion word too
check("dog startups", /\bdogs?\b/);
check("bee history", /\bbee|honey/);
check("fish history", /\bfish\b/);
check("dog history", /\bdogs?\b/);
check("goat comedy", /\bgoat/);
check("shark comedy", /\bshark/);
check("dog comedy", /\bdogs?\b/);
check("wine comedy", /\bwine\b/);
check("garden comedy", /\bgarden/);
check("garden history", /\bgarden/);
check("chicken history", /\bchicken/);
