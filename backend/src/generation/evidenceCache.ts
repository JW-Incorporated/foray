import * as fs from "fs";
import * as path from "path";
import type { EvidenceDoc } from "./gatherEvidence";

/**
 * The ONE place a generation-stage module writes to disk, isolated into
 * its own file so the rule it is an exception to stays enforceable.
 *
 * WHY IT EXISTS. WS-A retrieves print passages for every beat through the
 * web-search path; a Foray has ~30 beats and a run is re-attempted while
 * prompts and code are being tuned. Without a cache each re-run pays for
 * the same retrieval again, which is the fix plan's "cache by claim hash
 * under `data-local/evidence/` so re-runs are free".
 *
 * WHY IT DOES NOT BREAK §9.4 ("Each prompt is discarded"). Two rules,
 * both structural rather than promised:
 *
 *   1. The cache is keyed by a HASH of the claim and the file is NAMED by
 *      that hash. The claim text itself is never written — there is no
 *      field for it in `EvidenceCacheEntry`, so nothing on disk can be
 *      read back as a prompt, a beat purpose, or any other text a user
 *      supplied. A hash of a claim is not the claim.
 *   2. What IS written is `EvidenceDoc[]` — passages retrieved from
 *      published documents, plus their titles and urls. That is public
 *      text about the world, not text about the listener.
 *
 * `backend/test/promptNoPersistence.test.ts` names this file as the sole
 * generation-stage module permitted a filesystem write, and asserts both
 * rules above against what it actually writes.
 */

export interface EvidenceCacheEntry {
  cachedAt: string;
  docs: EvidenceDoc[];
}

/**
 * How long a retrieval that found NOTHING counts as a cache hit (F-60).
 *
 * Documents are cached forever: a passage retrieved yesterday is the same
 * passage today, and re-paying for it is the waste this file exists to
 * stop. An EMPTY result is not that kind of fact. It says one query, run
 * once, against a moving web, matched nothing — and run 2's act 1 p5 shows
 * what treating it as durable costs: `{"passages": []}` was cached, every
 * later run was served that emptiness for free, and the page went to the
 * writer unsourceable three times over. So emptiness expires, and a run a
 * day later asks again.
 */
export const EMPTY_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

/** Reads a cached retrieval, or `null` for any miss — a corrupt or
 * unreadable cache file is a miss, never an error: the worst case is
 * paying for one retrieval again. An entry holding NO documents is a miss
 * once it is older than `EMPTY_EVIDENCE_TTL_MS` (F-60). */
export function readEvidenceCache(dir: string, hash: string, now: () => Date = () => new Date()): EvidenceDoc[] | null {
  try {
    const file = cacheFile(dir, hash);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is caller-owned and hash is hex this pipeline computed.
    if (!fs.existsSync(file)) return null;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<EvidenceCacheEntry>;
    if (!Array.isArray(parsed.docs)) return null;
    const docs = parsed.docs as EvidenceDoc[];
    if (docs.length === 0 && emptyEntryIsStale(parsed.cachedAt, now)) return null;
    return docs;
  } catch {
    return null;
  }
}

/** An empty entry is a hit only while it is fresh. No timestamp at all, a
 * timestamp that does not parse, and one older than the TTL all mean the
 * same thing: ask again rather than serve nothing. */
function emptyEntryIsStale(cachedAt: string | undefined, now: () => Date): boolean {
  const at = Date.parse(String(cachedAt ?? ""));
  if (!Number.isFinite(at)) return true;
  return now().getTime() - at >= EMPTY_EVIDENCE_TTL_MS;
}

/** Writes one retrieval's documents. Never throws: a cache that cannot be
 * written must not take a generation run down with it. */
export function writeEvidenceCache(dir: string, hash: string, docs: EvidenceDoc[], now: () => Date = () => new Date()): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readEvidenceCache.
    fs.mkdirSync(dir, { recursive: true });
    const entry: EvidenceCacheEntry = { cachedAt: now().toISOString(), docs };
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readEvidenceCache.
    fs.writeFileSync(cacheFile(dir, hash), JSON.stringify(entry, null, 2), "utf8");
  } catch (err) {
    console.warn(`evidenceCache: could not write ${hash} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function cacheFile(dir: string, hash: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(hash)) throw new Error(`evidenceCache: "${hash}" is not a claim hash`);
  return path.join(dir, `${hash}.json`);
}
