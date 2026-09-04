const fs = require("fs");
const path = require("path");
const { freshCtx, SE, discover } = require("./rt_harness.js");
const ctx = freshCtx();

// Find "design"-like tokens: primary (non-broad, corpusDF<0.10) but with
// meaningfully high df (frequently a show-title word), which could carry a
// query away from a co-occurring thin/rare specific term.
const vocab = new Set();
for (const item of discover.items) {
  const text = [item.title, item.hook, item.show, ...(item.topics||[])].join(" ").toLowerCase();
  text.split(/[^a-z0-9]+/).forEach(w => { if (w.length>=4) vocab.add(w); });
}
const rows = [];
for (const w of vocab) {
  const df = SE.corpusDF(w, ctx);
  if (df >= 0.02 && df < 0.10) {
    const hasConcept = Object.values(ctx.semantic?.concepts||{}).some(c => c.terms?.includes(w));
    rows.push({ w, df, hasConcept });
  }
}
rows.sort((a,b) => b.df - a.df);
console.log(rows.slice(0, 60).map(r => `${r.w}: df=${r.df.toFixed(4)} hasConcept=${r.hasConcept}`).join("\n"));
