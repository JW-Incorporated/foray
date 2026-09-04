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

const queries = [
  ["10k char string", "a".repeat(10000)],
  ["100k char string", "b".repeat(100000)],
  ["html/xss img", "<img src=x onerror=alert(1)>"],
  ["script tag", "<script>alert(1)</script>"],
  ["sql injection", "'; DROP TABLE episodes; --"],
  ["sql injection2", "1' OR '1'='1"],
  ["emoji only", "🎉🎉🎉🎉🎉"],
  ["chinese", "武术历史"],
  ["arabic", "تاريخ الفلسفة"],
  ["null bytes/control chars", "\u0000\u0001\u0002abc"],
  ["empty string", ""],
  ["whitespace only", "     "],
  ["only punctuation", "!!!???...,,,"],
  ["mixed weird", "<svg onload=alert(1)>' OR 1=1 -- 你好 🎉"],
  ["very long repeated word", ("history " .repeat(3000))],
  ["unicode RTL override", "\u202Eevil\u202C"],
  ["template literal injection", "${alert(1)}"],
  ["prototype pollution shaped", "__proto__[polluted]"],
];

for (const [label, q] of queries) {
  const ctx = freshCtx();
  let interp, err = null;
  const t0 = Date.now();
  try {
    interp = SE.interpretQuery(q, ctx);
  } catch (e) {
    err = e;
  }
  const dt = Date.now() - t0;
  if (err) {
    console.log(`[CRASH] ${label}: ${err.message}`);
    continue;
  }
  let searchErr = null, results = null;
  try {
    const r = SE.searchWithRelaxation(discover.items, interp, 2, itemTags, () => 0.5);
    results = r.results;
  } catch (e) {
    searchErr = e;
  }
  console.log(`[OK] ${label}: dt=${dt}ms groups=${interp.groups.length} filters=${interp.filters.length} hasPrimary=${interp.hasPrimary} resultCount=${results ? results.length : 'ERR:'+searchErr?.message}`);
  // print any raw echoing of the term in groups (potential injection carrier)
  const tokenStrs = interp.groups.map(g => g.token);
  if (tokenStrs.some(t => t.includes("<") || t.includes("script"))) {
    console.log("   tokens containing suspicious chars:", JSON.stringify(tokenStrs));
  }
}
