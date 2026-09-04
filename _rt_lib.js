const fs = require("fs");
const path = require("path");
const ROOT = __dirname;
const SE = require(path.join(ROOT, "search-engine.js"));

const discover = JSON.parse(fs.readFileSync(path.join(ROOT, "data/discover.json"), "utf8"));
const itemTags = JSON.parse(fs.readFileSync(path.join(ROOT, "data/item-tags.json"), "utf8"));
const semantic = JSON.parse(fs.readFileSync(path.join(ROOT, "data/semantic-index.json"), "utf8"));

function freshCtx() {
  return { semantic, itemTags, discover };
}

function run(q, opts={}) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(q, ctx);
  const { results, relaxed } = SE.searchWithRelaxation(discover.items, interp, opts.minScore ?? 2, itemTags, opts.rankFallback);
  const cls = SE.classifyResults(results, {});
  return { interp, results, relaxed, cls };
}

function summarize(label, q, opts) {
  console.log("\n=== " + label + " :: q=" + JSON.stringify(q) + " ===");
  try {
    const { interp, results, relaxed, cls } = run(q, opts);
    console.log("groups:", interp.groups.map(g => ({ tok: g.token, broad: g.broad, thin: g.thin, hasConceptExpansion: g.hasConceptExpansion, df: +g.df.toFixed(4) })));
    console.log("properNounQuery:", interp.properNounQuery, "hasPrimary:", interp.hasPrimary, "thinAnchorCount:", interp.thinAnchorCount);
    console.log("relaxed:", relaxed, "resultCount:", results.length, "status:", cls.status, "picks:", cls.picks.length);
    console.log("top5:", results.slice(0,5).map(r => `${r.i.show} | ${r.i.title.slice(0,60)} (sum=${r.sum.toFixed(2)}, matched=${r.matched}, primaryMatched=${r.primaryMatched})`));
  } catch (e) {
    console.log("ERROR:", e.message);
    console.log(e.stack);
  }
}

module.exports = { run, summarize, freshCtx };
