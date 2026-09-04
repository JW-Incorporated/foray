const fs = require("fs");
const path = require("path");
const { freshCtx, SE, discover, itemTags } = require("./rt_harness.js");

// Find content tokens with df in (THIN_ANCHOR_DF, THIN_ANCHOR_DF*3] i.e.
// "just barely not thin" -- specific but real words that ALSO have no
// concept expansion (so scoreMatch can't get tag/topic bonuses for them
// beyond literal text), paired with a genuinely broad word like history/science.
const ctx = freshCtx();
const candidateWords = ["taxidermy","beekeeping","falconry","calligraphy","origami","astrology",
  "blacksmithing","bonsai","whittling","pottery","chess","knitting","fermentation","cheese",
  "kayaking","cartography","numismatics","philately","spelunking","archery","fencing","juggling",
  "yodeling","bagpipes","ventriloquism","puppetry","macrame","quilting","upholstery","glassblowing",
  "welding","masonry","carpentry","plumbing","roofing","landscaping","beer","wine","coffee","tea",
  "chocolate","spices","herbs","mushrooms","foraging","birdwatching","astronomy","meteorology",
  "geology","volcanology","paleontology","entomology","mycology","herpetology","ornithology"];

for (const w of candidateWords) {
  const df = SE.corpusDF(w, ctx);
  const hasConcept = Object.values(ctx.semantic?.concepts||{}).some(c => c.terms?.includes(w));
  console.log(`${w}: corpusDF=${df.toFixed(5)} hasConceptExpansion=${hasConcept} thin=${!hasConcept && df < 0.002}`);
}
