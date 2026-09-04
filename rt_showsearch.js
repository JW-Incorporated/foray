const fs = require("fs");
const path = require("path");
const SE = require("./search-engine.js");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "data/catalog.json"), "utf8"));
const shows = catalog.shows || catalog;
console.log("shows count:", Array.isArray(shows) ? shows.length : Object.keys(shows).length);
console.log("sample:", JSON.stringify(Array.isArray(shows) ? shows[0] : Object.values(shows)[0], null, 1));

function test(q) {
  const r = SE.searchShows(q, Array.isArray(shows) ? shows : Object.values(shows));
  console.log(`q=${JSON.stringify(q)} -> ${r.length} results: ${r.slice(0,5).map(s=>s.title).join(" | ")}`);
}
test("the");           // stopword-shaped but this IS a substring engine
test("a");
test("");
test("   ");
test("THE DAILY");
test("daily");
test("crime");
test("lex fridman");
test("lex");
test("radio");
test("'");
test("podcast");
