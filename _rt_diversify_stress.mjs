import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".");
const require = createRequire(import.meta.url);
const SE = require(join(ROOT, "search-engine.js"));

// Construct candidates: ShowA has 8 eps all scoring higher than ShowB/C/D/E's single eps.
// If ShowA's excess (beyond perShowCap=2) gets backfilled ahead of shows that were never
// picked at all, ShowA can end up dominating the final 10 even though 4 OTHER shows exist
// in the candidate set and were shut out entirely.
const cands = [];
for (let e = 0; e < 8; e++) cands.push({ i: { id: `A-ep${e}`, show: "ShowA" }, sum: 100 - e, matched: 2 });
for (const s of ["B","C","D","E"]) cands.push({ i: { id: `${s}-ep0`, show: `Show${s}` }, sum: 10, matched: 2 });

const picks = SE.diversify(cands, { cap: 10, perShowCap: SE.PER_SHOW_CAP, listenedShows: new Set() });
const counts = {};
picks.forEach(p => counts[p.i.show] = (counts[p.i.show]||0)+1);
console.log("candidates: ShowA x8 (high score) + ShowB/C/D/E x1 each (low score)");
console.log("picks:", picks.map(p=>p.i.id));
console.log("show counts in final picks:", JSON.stringify(counts));
console.log("distinct shows available in candidate pool:", 5, "distinct shows actually picked:", Object.keys(counts).length);
