import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const SE = require("./search-engine.js");
const discover = JSON.parse(readFileSync("data/discover.json", "utf8"));
const itemTags = JSON.parse(readFileSync("data/item-tags.json", "utf8"));
const semantic = JSON.parse(readFileSync("data/semantic-index.json", "utf8"));
const ctx = { semantic, itemTags, discover };

// Emoji-only / CJK / Arabic queries tokenize to zero content tokens (non-latin
// scripts and emoji get stripped by tokenize()'s [^a-z0-9]+ split), so
// interpretQuery returns groups=[] filters=[]. Confirm buildPlaylist's own
// early-return actually fires for this shape (empty groups AND empty filters)
// rather than falling through to classifyResults with the full un-scored pool.
for (const q of ["🎉🎉🎉", "武术历史", "تاريخ الفلسفة"]) {
  const interp = SE.interpretQuery(q, ctx);
  const wouldReturnEmptyInAppJs = !interp.groups.length && !interp.filters.length;
  console.log(`q="${q}": groups=${interp.groups.length} filters=${interp.filters.length} -> app.js buildPlaylist would return {status:"empty"} immediately: ${wouldReturnEmptyInAppJs}`);
}
