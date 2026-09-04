const { freshCtx, SE, discover, itemTags } = require("./rt_harness.js");
const ctx = freshCtx();
const interp = SE.interpretQuery("circuit design", ctx);
const item = discover.items.find(i => i.title === "#141 - The Daylight Mistake");
console.log(JSON.stringify(item, null, 1));
console.log(SE.scoreMatch(item, interp, itemTags));
