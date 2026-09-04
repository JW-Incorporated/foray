const { run } = require("./_rt_lib.js");
for (const q of ["something under 20 minutes about cooking", "short episodes about space", "long episode about ai safety", "cheese under 5 minutes"]) {
  const { interp } = run(q);
  console.log(q, "-> filters:", JSON.stringify(interp.filters));
}
