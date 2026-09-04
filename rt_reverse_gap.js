const s = require("./data/semantic-index.json");
const allTerms = new Set();
for (const c of Object.values(s.concepts)) (c.terms||[]).forEach(t => allTerms.add(t));

// reverse: singular-only terms whose plural (+s) is NOT in vocabulary
let singOnly = 0;
const examples = [];
for (const t of allTerms) {
  if (/^[a-z-]+$/.test(t) && !t.endsWith("s")) {
    const plural = t + "s";
    if (!allTerms.has(plural)) { singOnly++; if (examples.length < 20) examples.push(t); }
  }
}
console.log("singular-only terms (plural +s not present):", singOnly, "of", allTerms.size);
console.log(examples.join(", "));
