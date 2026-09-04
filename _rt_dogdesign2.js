const { run } = require("./_rt_lib.js");
// Confirm: how many of the 10 picks for "dog design" are genuinely about
// dogs vs. just "design" (game-design/industrial-design shows unrelated to dogs)?
const { cls } = run("dog design");
let dogRelated = 0, designOnly = 0;
for (const p of cls.picks) {
  const blob = (p.i.title + " " + (p.i.hook||"")).toLowerCase();
  const isDog = /\bdog\b|\bdogs\b|\bcanine\b|\bpuppy\b|\bpuppies\b/.test(blob);
  console.log(isDog ? "[DOG]" : "[design-only]", p.i.show, "|", p.i.title.slice(0,70));
  if (isDog) dogRelated++; else designOnly++;
}
console.log(`\n${dogRelated} dog-related / ${designOnly} design-only-unrelated-to-dogs out of ${cls.picks.length} picks`);

// Also test other words just above/below the 0.002 thin threshold paired with "design"
const { freshCtx } = require("./_rt_lib.js");
const SE = require("./search-engine.js");
const words = ["dog","apple","mercury","quantum","economy","tips"];
const ctx = freshCtx();
for (const w of words) {
  const df = SE.corpusDF ? null : null; // corpusDF not exported; infer via interpretQuery
}
