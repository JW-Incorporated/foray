/* Dossier parsing + chunker tests. The manifest suite parses the REAL
 * committed dossier — the parse IS the ingestion manifest, so the test
 * pinning its shape is what protects the whole pipeline's input.
 */

import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDossier, parseDossierFile, inferSourceType, loadManifest } from "./manifest.mjs";
import { chunkMarkdown, estTokens } from "./chunk.mjs";
import { openMigrated } from "./db.mjs";
import fs from "node:fs";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOSSIER = path.resolve(HERE, "..", "..", "docs", "research", "foray-research-dossier.md");
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-mtest-")), "t.db");

/* ------------------------------------------------------- dossier parse */

test("dossier: parses the real committed dossier without orphans", () => {
  const entries = parseDossierFile(DOSSIER);
  assert.ok(entries.length >= 50, `only ${entries.length} entries parsed`);
  for (const e of entries) {
    assert.ok(e.area >= 1 && e.area <= 9, `bad area for ${e.url}`);
    assert.ok(e.title.length > 0);
    assert.match(e.url, /^https:\/\//);
    assert.ok(e.why_it_matters.length > 0, `empty note for ${e.url}`);
  }
});

test("dossier: exactly 15 read-first sources, all deduped into areas", () => {
  const entries = parseDossierFile(DOSSIER);
  const rf = entries.filter((e) => e.read_first === 1);
  assert.equal(rf.length, 15);
  // Spot-check the two the kickoff calls out as smoke queries.
  assert.ok(entries.some((e) => e.url.includes("cormack.uwaterloo.ca")), "RRF paper present");
  assert.ok(entries.some((e) => e.url.includes("issues/254")), "DAI issue present");
});

test("dossier: all nine area names captured", () => {
  const entries = parseDossierFile(DOSSIER);
  const names = new Set(entries.map((e) => e.area_name));
  assert.equal(names.size, 9);
  assert.ok(names.has("Podcast Infrastructure"));
  assert.ok(names.has("LLM Pipeline Engineering"));
});

test("dossier: why-note is carried verbatim from the entry line", () => {
  const md = `### 3. Topic Segmentation

- **TreeSeg** — https://arxiv.org/pdf/2407.12028 — Hierarchical topic segmentation. *Why it matters:* your ingest-time segmentation.
`;
  const [e] = parseDossier(md);
  assert.equal(e.title, "TreeSeg");
  assert.equal(e.url, "https://arxiv.org/pdf/2407.12028");
  assert.match(e.why_it_matters, /^Hierarchical topic segmentation\. \*Why it matters:\* your ingest-time/);
});

test("dossier: read-first entry missing from all areas throws loudly", () => {
  const md = `## READ FIRST — sources

1. **Ghost** — https://ghost.example.com/x — never appears again.
`;
  assert.throws(() => parseDossier(md), /missing from area sections/);
});

test("dossier: duplicate URL across read-first and area is one source with the flag", () => {
  const md = `## READ FIRST — sources

1. **Spec** — https://spec.example.com/a — short note.

### 1. Podcast Infrastructure

- **Spec (full title)** — https://spec.example.com/a — the long verbatim note.
`;
  const entries = parseDossier(md);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].read_first, 1);
  assert.equal(entries[0].title, "Spec (full title)");
  assert.match(entries[0].why_it_matters, /long verbatim/);
});

test("inferSourceType: domain rules", () => {
  assert.equal(inferSourceType("https://arxiv.org/abs/2303.00747"), "paper");
  assert.equal(inferSourceType("https://github.com/pyannote/pyannote-audio"), "repo");
  assert.equal(inferSourceType("https://github.com/x/y/issues/254"), "issue");
  assert.equal(inferSourceType("https://cdn.ca9.uscourts.gov/opinion.pdf"), "court-opinion");
  assert.equal(inferSourceType("https://iabtechlab.com/x.pdf"), "standard");
  assert.equal(inferSourceType("https://developer.apple.com/forums/thread/111413"), "forum");
  assert.equal(inferSourceType("https://en.wikipedia.org/wiki/Perfect_10"), "reference");
  assert.equal(inferSourceType("https://castos.com/dai/"), "blog");
});

test("loadManifest: idempotent, preserves ids, refreshes fields", () => {
  const db = openMigrated(tmpDb(), { create: true });
  const e = { area: 1, area_name: "A", title: "T1", url: "https://x.com/a", source_type: "docs", why_it_matters: "v1", read_first: 0 };
  loadManifest(db, [e]);
  const id1 = db.prepare("SELECT id FROM sources WHERE url = ?").get(e.url).id;
  loadManifest(db, [{ ...e, title: "T2", why_it_matters: "v2", read_first: 1 }]);
  const row = db.prepare("SELECT * FROM sources WHERE url = ?").get(e.url);
  assert.equal(row.id, id1, "id stable across reloads");
  assert.equal(row.title, "T2");
  assert.equal(row.why_it_matters, "v2");
  assert.equal(row.read_first, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sources").get().n, 1);
});

/* -------------------------------------------------------------- chunker */

test("chunk: estTokens is the documented chars/4 heuristic", () => {
  assert.equal(estTokens("abcd"), 1);
  assert.equal(estTokens("abcde"), 2);
});

test("chunk: short document is a single chunk", () => {
  const chunks = chunkMarkdown("# Title\n\nOne short paragraph.");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].ordinal, 0);
});

test("chunk: chunks stay within the token ceiling", () => {
  const md = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${"Sentence content here. ".repeat(30)}`).join("\n\n");
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.token_count <= 1000 + 60, `chunk ${c.ordinal} has ${c.token_count}`);
});

test("chunk: heading boundaries start new chunks once past the minimum", () => {
  const section = (h) => `## ${h}\n\n${"Body sentence for the section. ".repeat(50)}`;
  const chunks = chunkMarkdown(`# Doc\n\n${section("Alpha")}\n\n${section("Beta")}`);
  const paths = chunks.map((c) => c.heading_path);
  assert.ok(paths.some((p) => p.includes("Alpha")));
  assert.ok(paths.some((p) => p.includes("Beta")));
  assert.ok(!paths.some((p) => p.includes("Alpha") && p.includes("Beta")));
});

test("chunk: heading_path tracks the nesting stack", () => {
  const md = `# Top\n\n## Mid\n\n### Deep\n\n${"Content sentence. ".repeat(80)}`;
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.some((c) => c.heading_path === "Top > Mid > Deep"), chunks.map((c) => c.heading_path).join(" | "));
});

test("chunk: giant single paragraph splits at sentence boundaries", () => {
  const md = "One sentence of filler. ".repeat(400);
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.token_count <= 1060, `oversize chunk: ${c.token_count}`);
    assert.match(c.text, /\.\s*$|\.$/);
  }
});

test("chunk: fenced code blocks are never split mid-fence", () => {
  const code = "```js\n" + "const x = 1;\n".repeat(40) + "```";
  const md = `Intro paragraph.\n\n${code}\n\nOutro paragraph.`;
  const chunks = chunkMarkdown(md);
  const withCode = chunks.filter((c) => c.text.includes("```"));
  for (const c of withCode) {
    const fences = (c.text.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, `unbalanced fence in chunk ${c.ordinal}`);
  }
});

test("chunk: trailing sliver merges into its predecessor", () => {
  const md = `${"Full paragraph sentence. ".repeat(60)}\n\nTiny tail.`;
  const chunks = chunkMarkdown(md);
  assert.match(chunks[chunks.length - 1].text, /Tiny tail\./);
  assert.ok(chunks[chunks.length - 1].token_count > 60, "sliver did not stay alone");
});

test("chunk: skipped heading levels never turn siblings into ancestors", () => {
  const body = "Content sentence for this section. ".repeat(40);
  const md = `# A\n\n### B\n\n${body}\n\n### C\n\n${body}`;
  const chunks = chunkMarkdown(md);
  const cChunks = chunks.filter((c) => c.heading_path.includes("C"));
  assert.ok(cChunks.length >= 1);
  for (const c of cChunks) {
    assert.equal(c.heading_path, "A > C", `sibling leaked into path: ${c.heading_path}`);
  }
});

test("dossier: near-miss entry lines surface a warning instead of vanishing", () => {
  const md = `### 2. Speech Processing

- **Broken Entry** https://x.example.com/missing-dashes — note without the first dash.
- **Good Entry** — https://x.example.com/good — a proper note.
`;
  const warnings = [];
  const entries = parseDossier(md, { onWarn: (w) => warnings.push(w) });
  assert.equal(entries.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Broken Entry/);
});

test("chunk: ordinals are dense and start at zero", () => {
  const md = Array.from({ length: 12 }, (_, i) => `## H${i}\n\n${"text sentence. ".repeat(60)}`).join("\n\n");
  const chunks = chunkMarkdown(md);
  chunks.forEach((c, i) => assert.equal(c.ordinal, i));
});
