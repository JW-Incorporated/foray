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
export function relToCorpusRoot(fullPath, root = CORPUS_ROOT) {
  return path.relative(root, fullPath).split(path.sep).join("/");
}

/* The archive layout under ANY root. `RAW_DIR`/`MARKDOWN_DIR` above are just
 * these applied to the real corpus root.
 *
 * These exist because the ingestion path used to hard-code the module-level
 * constants, which meant a unit test calling `ingestSource` against a temp
 * DATABASE still wrote its fixtures into the real `data-local/corpus/`
 * archive — and, once `removeStaleArchives` landed, DELETED whatever real
 * artifact happened to share its source id. That is how `npm test` came to
 * destroy source 1's archived markdown on the machine that built the corpus.
 * The root is now a parameter, so a test that opens a temp DB gets a temp
 * archive too, and the two can no longer diverge. */
export const rawDirIn = (root) => path.join(root, "raw");
export const markdownDirIn = (root) => path.join(root, "markdown");
