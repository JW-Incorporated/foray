const fs = require("fs");
const SE = require("./search-engine.js");
const catalog = JSON.parse(fs.readFileSync("data/catalog.json", "utf8"));
const shows = catalog.shows;
console.log("num shows", shows.length);
console.log(shows.slice(0,3).map(s=>({title:s.title, show_id:s.show_id})));

function testShows(q) {
  const r = SE.searchShows(q, shows);
  console.log("q="+JSON.stringify(q), "->", r.length, "results:", r.slice(0,5).map(s=>s.title));
}
testShows("the daily");
testShows("daily");
testShows("lex");
testShows("lex fridman");
testShows("smartless");
testShows("SMARTLESS");
testShows("planet money");
testShows("huberman");
testShows("dog training tips"); // topic phrase in show box
testShows("comedy");
testShows("");
testShows("   ");
