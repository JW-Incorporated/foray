/* Dossier markdown → the sources manifest.
 *
 * The dossier (docs/research/foray-research-dossier.md) IS the manifest —
 * titles, URLs, areas and why-notes are parsed out of it verbatim, never
 * hand-copied (kickoff rule). Two shapes carry sources:
 *
 *   ## READ FIRST …           numbered:  N. **Title** — URL — note
 *   ### N. Area Name          bulleted:  - **Title** — URL — note
 *
 * Everything else (TL;DR, Key Findings, Recommendations, Caveats) contains
 * prose links but no source entries, and is ignored. Entries are deduped by
 * URL; the READ FIRST flag ORs onto the area entry.
 */

import fs from "node:fs";

const AREA_RE = /^###\s+(\d)\.\s+(.+?)\s*$/;
const READ_FIRST_RE = /^##\s+READ FIRST/i;
const SECTION_RE = /^##\s+/;
/* **Title** — URL — everything after is the verbatim why-note. The em-dash
 * separators are how the dossier is written; both — and -- accepted. */
const ENTRY_RE = /^(?:\d+\.|-)\s+\*\*(.+?)\*\*\s+(?:—|--)\s+(https?:\/\/\S+?)\s+(?:—|--)\s+(.+)$/;

const TYPE_RULES = [
  [/arxiv\.org/, "paper"],
  [/trec\.nist\.gov|aclanthology\.org|ijcai\.org|cormack\.uwaterloo\.ca|fordhamlawreview\.org|sciencedirect\.com|research\.atspotify\.com/, "paper"],
  [/github\.com\/[^/]+\/[^/]+\/issues\//, "issue"],
  [/github\.com\/[^/]+\/[^/]+\/?$/, "repo"],
  [/uscourts\.gov/, "court-opinion"],
  [/iabtechlab\.com|aes\.org|podcasting2\.org/, "standard"],
  [/developer\.apple\.com\/forums|community\.openai\.com/, "forum"],
  [/developer\.apple\.com|podcastindex-org\.github\.io|acoustid\.org|wiki\.creativecommons\.org/, "docs"],
  [/wikipedia\.org/, "reference"],
  [/huggingface\.co/, "reference"],
];

export function inferSourceType(url) {
  for (const [re, type] of TYPE_RULES) if (re.test(url)) return type;
  return "blog";
}

/** Strip trailing punctuation the markdown syntax glued onto a bare URL. */
function cleanUrl(url) {
  return url.replace(/[).,;]+$/, "");
}

/**
 * @param {string} markdown dossier content
 * @returns {Array<{area, area_name, title, url, source_type, why_it_matters, read_first}>}
 */
export function parseDossier(markdown) {
  const byUrl = new Map();
  let mode = null; // 'read-first' | {area, name} | null

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();

    const areaMatch = line.match(AREA_RE);
    if (areaMatch) {
      mode = { area: Number(areaMatch[1]), name: areaMatch[2] };
      continue;
    }
    if (READ_FIRST_RE.test(line)) { mode = "read-first"; continue; }
    if (SECTION_RE.test(line)) { mode = null; continue; }
    if (!mode) continue;

    const m = line.match(ENTRY_RE);
    if (!m) continue;
    const [, title, rawUrl, note] = m;
    const url = cleanUrl(rawUrl);

    if (mode === "read-first") {
      const existing = byUrl.get(url);
      if (existing) {
        existing.read_first = 1;
      } else {
        // READ FIRST entry not (yet) seen in an area section; park it with
        // area unknown — a later area entry fills it in.
        byUrl.set(url, {
          area: null, area_name: null,
          title: title.trim(), url,
          source_type: inferSourceType(url),
          why_it_matters: note.trim(),
          read_first: 1,
        });
      }
    } else {
      const existing = byUrl.get(url);
      if (existing) {
        // Area entry wins for area/title/note (it's the richer record).
        existing.area = mode.area;
        existing.area_name = mode.name;
        existing.title = title.trim();
        existing.why_it_matters = note.trim();
      } else {
        byUrl.set(url, {
          area: mode.area, area_name: mode.name,
          title: title.trim(), url,
          source_type: inferSourceType(url),
          why_it_matters: note.trim(),
          read_first: 0,
        });
      }
    }
  }

  const entries = [...byUrl.values()];
  const orphans = entries.filter((e) => e.area === null);
  if (orphans.length) {
    // READ FIRST sources that never appeared in an area section would violate
    // the sources.area NOT NULL — surface loudly instead of guessing.
    throw new Error(
      `dossier parse: ${orphans.length} READ FIRST entr${orphans.length === 1 ? "y" : "ies"} missing from area sections: ` +
      orphans.map((o) => o.url).join(", ")
    );
  }
  return entries;
}

export function parseDossierFile(filePath) {
  return parseDossier(fs.readFileSync(filePath, "utf8"));
}

/** Idempotent manifest load: insert new URLs, refresh mutable fields on
 * existing ones, never renumber ids (documents/chunks hang off them). */
export function loadManifest(db, entries) {
  const upsert = db.prepare(`
    INSERT INTO sources (area, area_name, title, url, source_type, why_it_matters, read_first)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      area = excluded.area,
      area_name = excluded.area_name,
      title = excluded.title,
      source_type = excluded.source_type,
      why_it_matters = excluded.why_it_matters,
      read_first = excluded.read_first
  `);
  db.exec("BEGIN");
  try {
    for (const e of entries) {
      upsert.run(e.area, e.area_name, e.title, e.url, e.source_type, e.why_it_matters, e.read_first);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return entries.length;
}
