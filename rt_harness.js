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

function run(q, label) {
  const ctx = freshCtx();
  const interp = SE.interpretQuery(q, ctx);
  const { results } = SE.searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
  const cls = SE.classifyResults(results, {});
  console.log(`\n=== ${label || q} === q=${JSON.stringify(q)}`);
  console.log(`groups=${interp.groups.map(g=>`${g.token}(broad=${g.broad},thin=${g.thin},hasConcept=${g.hasConceptExpansion},df=${g.df.toFixed(4)})`).join(', ')}`);
  console.log(`properNounQuery=${interp.properNounQuery} thinAnchorCount=${interp.thinAnchorCount} hasPrimary=${interp.hasPrimary}`);
  console.log(`resultCount(pre-classify)=${results.length} classifyStatus=${cls.status} picks=${cls.picks.length}`);
  console.log('top5:', results.slice(0,5).map(r => `${r.i.title} [show=${r.i.show}] sum=${r.sum.toFixed(2)} matched=${r.matched}/${interp.groups.length} primaryMatched=${r.primaryMatched}`).join('\n      '));
  return { interp, results, cls };
}

module.exports = { run, freshCtx, SE, discover, itemTags, semantic };
