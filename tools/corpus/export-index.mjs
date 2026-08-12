/* export-index — turn the local-only corpus into a committable artifact.
 *
 * The corpus DB and its archives live in data-local/corpus/ (gitignored), so
 * they exist only on the machine that ran the ingestion. This module exports
 * what CAN be published from a PUBLIC repo:
 *
 *   - facts about each source (url, hash, chunk/token counts, fetch status)
 *   - a digest and key facts WE wrote (docs/research/corpus/digests.md)
 *   - the per-source redistribution verdict with its evidence
 *
 * It never exports scraped text. That is a legal constraint, not a size one:
 * republishing third-party prose from a public repo is publication, and the
 * product principle is "legally boring" (CLAUDE.md). The digests file is the
 * authored input — same pattern as the dossier being the ingestion manifest —
 * and this module is the only thing that turns it into JSON.
 */

const REQUIRED_FIELDS = ["url", "redistribution", "license", "license-evidence", "verified"];
const REDISTRIBUTION = new Set(["allow", "deny"]);
const VERIFIED = new Set(["web", "inferred"]);

/* Structural guard: a digest is our summary, never a pasted body. These caps
 * are deliberately far below article length so that "someone pasted the source
 * text in" fails the parse instead of quietly shipping. Mirrors the
 * transcript-availability rule that CI rejects body-sized strings. */
export const MAX_DIGEST_CHARS = 2500;
export const MAX_FACT_CHARS = 400;

export const INDEX_SCHEMA = "foray.research-corpus-index/1";

const HEADING_RE = /^##\s+(\d+)\.\s+(.+?)\s*$/;
const FIELD_RE = /^-\s+([a-z-]+):\s*(.*?)\s*$/;
const BULLET_RE = /^-\s+(.*?)\s*$/;

function fail(id, message) {
  throw new Error(`digests.md: source ${id}: ${message}`);
}

/**
 * Parse the authored digests markdown into structured entries.
 * Fail-closed: anything missing, unrecognised, or oversized throws rather than
 * silently producing an entry with a permissive default.
 */
export function parseDigests(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      current = { id: Number(m[1]), title: m[2], body: [] };
      sections.push(current);
    } else if (/^#{1,6}\s/.test(line) || /^-{3,}\s*$/.test(line)) {
      /* Any other heading or rule (the per-area headings, the preamble) ends
       * the entry — otherwise its text would be read as a key fact. */
      current = null;
    } else if (current) {
      current.body.push(line);
    }
  }

  const entries = [];
  const seen = new Set();
  for (const section of sections) {
    if (seen.has(section.id)) fail(section.id, "duplicate entry");
    seen.add(section.id);
    entries.push(parseSection(section));
  }
  if (!entries.length) throw new Error("digests.md: no `## <id>. <title>` entries found");
  return entries;
}

function parseSection({ id, title, body }) {
  const fields = new Map();
  let i = 0;
  /* Field block: the leading bullet list, ended by the first prose line. */
  for (; i < body.length; i++) {
    const line = body[i];
    if (!line.trim()) { if (fields.size) break; else continue; }
    const m = FIELD_RE.exec(line);
    if (!m) break;
    if (fields.has(m[1])) fail(id, `duplicate field "${m[1]}"`);
    fields.set(m[1], m[2]);
  }

  for (const f of REQUIRED_FIELDS) {
    if (!fields.get(f)) fail(id, `missing field "${f}"`);
  }

  const rest = body.slice(i);
  const factsAt = rest.findIndex((l) => /^\*\*Key facts\*\*\s*$/.test(l));
  if (factsAt === -1) fail(id, "missing **Key facts** block");

  const digest = rest.slice(0, factsAt).join("\n").trim();
  if (!digest) fail(id, "empty digest");
  if (digest.length > MAX_DIGEST_CHARS) {
    fail(id, `digest is ${digest.length} chars (max ${MAX_DIGEST_CHARS}) — digests are our summary, not the source text`);
  }

  const keyFacts = [];
  for (const line of rest.slice(factsAt + 1)) {
    if (!line.trim()) continue;
    const m = BULLET_RE.exec(line);
    if (!m) fail(id, `unexpected line in the key-facts block: ${JSON.stringify(line.slice(0, 60))}`);
    if (m[1].length > MAX_FACT_CHARS) fail(id, `key fact is ${m[1].length} chars (max ${MAX_FACT_CHARS})`);
    keyFacts.push(m[1]);
  }
  if (!keyFacts.length) fail(id, "no key facts");

  const url = fields.get("url");
  if (!/^https?:\/\//.test(url)) fail(id, `url must be http(s): ${url}`);

  const redistribution = fields.get("redistribution");
  if (!REDISTRIBUTION.has(redistribution)) {
    fail(id, `redistribution must be allow|deny, got ${JSON.stringify(redistribution)}`);
  }
  const verified = fields.get("verified");
  if (!VERIFIED.has(verified)) fail(id, `verified must be web|inferred, got ${JSON.stringify(verified)}`);

  const [evidenceUrl, ...noteParts] = fields.get("license-evidence").split(" — ");
  const license = fields.get("license");
  if (redistribution === "allow") {
    if (!/^https?:\/\//.test(evidenceUrl)) {
      fail(id, `redistribution "allow" needs a license-evidence URL (got ${JSON.stringify(evidenceUrl)})`);
    }
    if (/^(unknown|none|none-found)$/i.test(license)) {
      fail(id, `redistribution "allow" needs a named license, got ${JSON.stringify(license)}`);
    }
  }

  return {
    id,
    title,
    url,
    digest,
    key_facts: keyFacts,
    license: {
      id: license,
      redistribution,
      evidence_url: /^https?:\/\//.test(evidenceUrl) ? evidenceUrl : null,
      note: noteParts.join(" — ").trim() || (/^https?:\/\//.test(evidenceUrl) ? "" : evidenceUrl),
      verified,
    },
  };
}

/** Latest fetch per source, joined to chunk counts — the mechanical half. */
export function indexRows(db) {
  return db.prepare(`
    SELECT s.id, s.area, s.area_name, s.title, s.url, s.source_type, s.read_first,
           s.why_it_matters,
           d.fetched_at, d.http_status, d.content_hash, d.raw_path, d.markdown_path,
           d.token_count, d.fetch_notes,
           (SELECT COUNT(*) FROM chunks c JOIN documents d2 ON c.document_id = d2.id
             WHERE d2.source_id = s.id) AS chunk_count
    FROM sources s
    LEFT JOIN documents d ON d.id = (
      SELECT id FROM documents WHERE source_id = s.id
      ORDER BY fetched_at DESC, id DESC LIMIT 1
    )
    ORDER BY s.area, s.id
  `).all();
}

/**
 * Build the committable index: DB facts + authored digests.
 * Throws if the two disagree — a source without a digest, a digest without a
 * source, or a digest whose url has drifted from the dossier.
 */
export function buildIndex(db, entries, { generatedAt = new Date().toISOString() } = {}) {
  const rows = indexRows(db);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const missing = rows.filter((r) => !byId.has(r.id)).map((r) => r.id);
  if (missing.length) {
    throw new Error(`digests.md is missing entries for source(s) ${missing.join(", ")} — every source needs a digest before the index can be exported`);
  }
  const orphans = entries.filter((e) => !rows.some((r) => r.id === e.id)).map((e) => e.id);
  if (orphans.length) throw new Error(`digests.md has entries for unknown source(s) ${orphans.join(", ")}`);

  const sources = rows.map((r) => {
    const e = byId.get(r.id);
    if (e.url !== r.url) {
      throw new Error(`source ${r.id}: digests.md url ${e.url} does not match the dossier url ${r.url}`);
    }
    const ok = r.http_status >= 200 && r.http_status < 300 && r.chunk_count > 0;
    return {
      id: r.id,
      area: r.area,
      area_name: r.area_name,
      title: r.title,
      url: r.url,
      source_type: r.source_type,
      read_first: Boolean(r.read_first),
      why_it_matters: r.why_it_matters ?? null,
      fetch: {
        status: ok ? "ingested" : r.http_status === null ? "unfetched" : "failed",
        fetched_at: r.fetched_at ?? null,
        http_status: r.http_status ?? null,
        content_sha256: r.content_hash ?? null,
        estimated_tokens: r.token_count ?? null,
        chunks: r.chunk_count ?? 0,
        notes: r.fetch_notes ?? null,
      },
      local_archive: r.markdown_path
        ? { raw: r.raw_path, markdown: r.markdown_path, root: "data-local/corpus/ (gitignored, never committed)" }
        : null,
      license: e.license,
      digest: e.digest,
      key_facts: e.key_facts,
    };
  });

  const ingested = sources.filter((s) => s.fetch.status === "ingested");
  return {
    schema: INDEX_SCHEMA,
    generated_at: generatedAt,
    generator: "node tools/corpus/corpus.mjs export-index --write",
    policy:
      "Index + our own digests only. No third-party source text is committed to this public repo: " +
      "the corpus's raw bytes and markdown extractions stay in data-local/corpus/ (gitignored). " +
      "license.redistribution records, per source, whether republishing that source's text would be permitted.",
    regeneration: {
      note: "Any machine can rebuild the full corpus from the committed dossier plus the network; content_sha256 lets you check your rebuild against this snapshot.",
      commands: [
        "cd tools/corpus && npm install",
        "node tools/corpus/corpus.mjs init",
        "node tools/corpus/corpus.mjs load-manifest",
        "node tools/corpus/corpus.mjs ingest --all",
        "node tools/corpus/corpus.mjs export-index --write",
      ],
    },
    totals: {
      sources: sources.length,
      ingested: ingested.length,
      chunks: sources.reduce((n, s) => n + s.fetch.chunks, 0),
      estimated_tokens: sources.reduce((n, s) => n + (s.fetch.estimated_tokens ?? 0), 0),
      redistribution_allowed: sources.filter((s) => s.license.redistribution === "allow").length,
      redistribution_denied: sources.filter((s) => s.license.redistribution === "deny").length,
    },
    sources,
  };
}

export function serializeIndex(index) {
  return JSON.stringify(index, null, 2) + "\n";
}

/* ------------------------------------------------ the "our own words" guard
 *
 * A digest is only publishable because we wrote it. That claim is worth
 * checking mechanically rather than trusting: this flags any run of
 * VERBATIM_RUN words shared between a digest and its own archived extraction.
 *
 * The stopword floor is what makes it usable. Listing five MIME types or five
 * model names in the right order is a fact, and any n-gram check will match it
 * — those runs carry almost no function words. A run that carries several is a
 * SENTENCE, and a shared sentence is the thing we actually forbid.
 */
export const VERBATIM_RUN = 10;
export const VERBATIM_STOPWORD_FLOOR = 4;

const STOPWORDS = new Set(
  ("a an and are as at be been but by can for from had has have if in into is it its may must not of on or " +
   "should so than that the their then there these they this to was were which while who with would you your")
    .split(" ")
);

const words = (text) => String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

function proseRuns(text) {
  const toks = words(text);
  const runs = new Map();
  for (let i = 0; i + VERBATIM_RUN <= toks.length; i++) {
    const run = toks.slice(i, i + VERBATIM_RUN);
    if (run.filter((w) => STOPWORDS.has(w)).length < VERBATIM_STOPWORD_FLOOR) continue;
    runs.set(run.join(" "), true);
  }
  return runs;
}

/**
 * @param {{digest: string, key_facts: string[]}} entry
 * @param {string} sourceText the archived extraction for that source
 * @returns {string[]} verbatim runs shared by both (empty = clean)
 */
export function verbatimRuns(entry, sourceText) {
  const source = proseRuns(sourceText);
  if (!source.size) return [];
  const found = new Set();
  for (const text of [entry.digest, ...(entry.key_facts ?? [])]) {
    for (const run of proseRuns(text).keys()) if (source.has(run)) found.add(run);
  }
  return [...found];
}

/**
 * Run the guard across every entry whose archive is available locally.
 * `readSourceText(entry)` returns the extraction, or null when this machine
 * has no archive for it (cloud checkouts — nothing to check against).
 */
export function checkVerbatimOverlap(entries, readSourceText) {
  const problems = [];
  let checked = 0;
  for (const e of entries) {
    const text = readSourceText(e);
    if (text == null) continue;
    checked++;
    /* One problem per source: a lifted paragraph produces dozens of
     * overlapping runs, and the fix is the same for all of them. */
    const runs = verbatimRuns(e, text);
    if (runs.length) {
      problems.push(
        `source ${e.id}: digest reuses ${runs.length} ${VERBATIM_RUN}-word run(s) of the source text, e.g. "${runs[0]}"`
      );
    }
  }
  return { checked, problems };
}

/**
 * Consistency check that needs no DB: does a committed index still match the
 * authored digests? Returns a list of human-readable mismatches (empty = ok).
 */
export function diffIndexAgainstDigests(index, entries) {
  const problems = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const s of index.sources ?? []) {
    const e = byId.get(s.id);
    if (!e) { problems.push(`source ${s.id} (${s.title}) is in the index but not in digests.md`); continue; }
    if (e.url !== s.url) problems.push(`source ${s.id}: url differs (index ${s.url} vs digests ${e.url})`);
    if (e.digest !== s.digest) problems.push(`source ${s.id}: digest text differs — re-run export-index`);
    if (e.license.redistribution !== s.license.redistribution) {
      problems.push(`source ${s.id}: redistribution verdict differs (index ${s.license.redistribution} vs digests ${e.license.redistribution})`);
    }
    if (e.license.id !== s.license.id) problems.push(`source ${s.id}: license differs — re-run export-index`);
    if (e.key_facts.length !== s.key_facts.length) problems.push(`source ${s.id}: key-fact count differs — re-run export-index`);
  }
  for (const e of entries) {
    if (!(index.sources ?? []).some((s) => s.id === e.id)) {
      problems.push(`source ${e.id} is in digests.md but not in the index — re-run export-index`);
    }
  }
  return problems;
}
