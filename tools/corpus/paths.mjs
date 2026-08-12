/* Archive path construction, with the one property that matters: no input —
 * however hostile a fetched title or URL is — can produce a path outside
 * data-local/corpus/. Titles come from scraped pages, so they are untrusted.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* tools/corpus/ → repo root → data-local/corpus */
export const CORPUS_ROOT = path.resolve(HERE, "..", "..", "data-local", "corpus");
export const RAW_DIR = path.join(CORPUS_ROOT, "raw");
export const MARKDOWN_DIR = path.join(CORPUS_ROOT, "markdown");
export const DB_PATH = path.join(CORPUS_ROOT, "corpus.db");

/** Untrusted string → filesystem-safe slug (lowercase ascii, dashes). */
export function slugify(input, maxLen = 60) {
  const s = String(input ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return s || "untitled";
}

/**
 * Build an archive path for a source artifact and prove it stays inside the
 * intended directory. `ext` is chosen by our own code (never user input) but
 * is sanitized anyway.
 */
export function archivePath(dir, sourceId, slugSource, ext) {
  const id = Number(sourceId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`bad source id: ${sourceId}`);
  const safeExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const name = `${String(id).padStart(3, "0")}-${slugify(slugSource)}.${safeExt}`;
  const full = path.resolve(dir, name);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`archive path escaped its directory: ${full}`);
  }
  return full;
}

/** Repo-relative display form (stable across machines, for DB storage). */
export function relToCorpusRoot(fullPath) {
  return path.relative(CORPUS_ROOT, fullPath).split(path.sep).join("/");
}
