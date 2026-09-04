const s = require("./data/semantic-index.json");
const allTerms = new Set();
for (const c of Object.values(s.concepts)) (c.terms||[]).forEach(t => allTerms.add(t));

// find plural-looking terms (end in 's', not 'ss') whose singular (strip 's')
// is NOT itself in the vocabulary -- i.e. asymmetric plural-only coverage.
const gaps = [];
for (const t of allTerms) {
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) {
    const sing = t.slice(0, -1);
    if (sing.length >= 3 && !allTerms.has(sing)) gaps.push(`${sing} (missing) -> ${t} (present)`);
  }
}
console.log(`total concept terms: ${allTerms.size}`);
console.log(`plural-only gaps: ${gaps.length}`);
console.log(gaps.slice(0, 60).join("\n"));
