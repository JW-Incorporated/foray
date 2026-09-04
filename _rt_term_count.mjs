import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));

const ctx = { semantic, itemTags, discover };

// Count how many DISTINCT terms end up needing a tagDF/corpusDF scan for one
// single-word query, to explain the multi-second cold latency measured above.
let calls = 0;
const origTagCount = SE.tagCount;
// Monkeypatch-free: just count via ctx memo map sizes before/after.
const before = () => ({
  dfMemo: ctx._dfMemo ? ctx._dfMemo.size : 0,
  corpusMemo: ctx._corpusDfMemo ? ctx._corpusDfMemo.size : 0,
});
const b = before();
const t0 = Date.now();
const interp = SE.interpretQuery("philosophy", ctx);
const t1 = Date.now();
const a = before();
console.log("interpretQuery('philosophy') on FRESH ctx:", t1 - t0, "ms");
console.log("new tagDF-memoized terms:", a.dfMemo - b.dfMemo);
console.log("new corpusDF-memoized terms:", a.corpusMemo - b.corpusMemo);
console.log("groups[0].terms.size (final term set for this one word):", interp.groups[0].terms.size);
