const { run } = require("./rt_harness.js");
const { freshCtx, SE, discover } = require("./rt_harness.js");
const ctx = freshCtx();

// Single-word show-name query test: pick 15 distinct one-word show names
// from the discover pool and query the bare name via the TOPIC search path.
const shows = new Set(discover.items.map(i => i.show));
const oneWord = [...shows].filter(s => /^[A-Za-z0-9]+$/.test(s.replace(/\s+/g,'')) && s.split(/\s+/).length === 1);
console.log("one-word shows found:", oneWord.length, oneWord.slice(0,30));

for (const show of oneWord.slice(0, 20)) {
  const q = show;
  const interp = SE.interpretQuery(q, ctx);
  const { results } = SE.searchWithRelaxation(discover.items, interp, 2, null, () => 0.5);
  const cls = SE.classifyResults(results, {});
  const countInPool = discover.items.filter(i => i.show === show).length;
  console.log(`${show.padEnd(20)} poolCount=${countInPool} status=${cls.status} picks=${cls.picks.length} thin=${interp.groups[0]?.thin}`);
}
