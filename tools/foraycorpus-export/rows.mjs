/* The corpus export's shared row helpers (CH2-30, docs/roadmap/code-health-2.md
   T1-20): one copy each of what catalogue, catalog-adapter, show-map,
   wave-candidates, overlap and export used to carry privately. */
import { readFileSync } from "node:fs";

export class JsonlError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "JsonlError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** The rows of a catalogue-shaped document: the document itself when it is
    an array, else its `shows` array, else []. */
export function rowsOf(doc) {
  if (Array.isArray(doc)) return doc;
  return Array.isArray(doc?.shows) ? doc.shows : [];
}

/** An id as a comparable string, or null when absent / blank. pg returns
    int8 as a string and the catalogue files carry numbers. */
export function idKey(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** The parsed rows of a JSONL file. Blank lines (and a CRLF line end) are
    skipped; a line that is not JSON throws JsonlError MALFORMED_ROW naming
    `<path>:<line>`. */
export function readJsonl(path) {
  const rows = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new JsonlError("MALFORMED_ROW", `${path}:${i + 1}`);
    }
  });
  return rows;
}
