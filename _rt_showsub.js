const fs = require("fs");
const SE = require("./search-engine.js");
const catalog = JSON.parse(fs.readFileSync("data/catalog.json", "utf8"));
const shows = catalog.shows;
function testShows(q) {
  const r = SE.searchShows(q, shows);
  console.log("q="+JSON.stringify(q), "->", r.length, "results:", r.slice(0,8).map(s=>s.title));
}
// substring false-positive hunt: short/common substrings matching unrelated show names
testShows("ai"); // could match many unrelated shows containing "ai" substring
testShows("on");
testShows("the");
testShows("show");
testShows("a");
testShows("i");
