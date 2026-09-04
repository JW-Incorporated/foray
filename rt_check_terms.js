const s = require("./data/semantic-index.json");
for (const [cid, c] of Object.entries(s.concepts)) {
  const terms = c.terms || [];
  if (terms.includes("startup") || terms.includes("startups")) console.log("startup concept:", cid, terms);
  if (terms.includes("energy") || terms.includes("energies")) console.log("energy concept:", cid, terms);
  if (terms.includes("culture") || terms.includes("cultures")) console.log("culture concept:", cid, terms);
  if (terms.includes("fusion") || terms.includes("fusions")) console.log("fusion concept:", cid, terms);
}
