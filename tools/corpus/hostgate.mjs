/* Cross-process host gate.
 *
 * Workstream C runs one ingestion process per dossier area in parallel. The
 * in-process rate limiter (fetcher.mjs) can't see sibling processes, and
 * several hosts appear in multiple areas (arxiv.org is in three). Without a
 * shared gate, N processes could hit one host in the same instant — exactly
 * the "aggressive parallel hammering" the scraping rules forbid.
 *
 * Design: one JSON state file per host under data-local/corpus/hostgate/,
 * guarded by a lock DIRECTORY (fs.mkdirSync is atomic on every platform —
 * the classic portable mutex). A process reserves the next send slot by
 * advancing nextAllowedAt under the lock, then sleeps out its wait outside
 * the lock. Locks older than STALE_MS are broken (crashed process).
 */

import fs from "node:fs";
import path from "node:path";
import { CORPUS_ROOT } from "./paths.mjs";

const STALE_MS = 60_000;
const LOCK_POLL_MS = 50;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHostGate({
  dir = path.join(CORPUS_ROOT, "hostgate"),
  sleep = sleepReal,
  now = () => Date.now(),
} = {}) {
  fs.mkdirSync(dir, { recursive: true });

  // Hosts come from URLs we constructed, but sanitize as if hostile anyway:
  // strip anything path-like, and never allow dot-runs ("..").
  const safeHost = (host) =>
    host.toLowerCase().replace(/[^a-z0-9.-]/g, "_").replace(/\.{2,}/g, "_");

  async function withLock(host, fn) {
    const lockDir = path.join(dir, `${safeHost(host)}.lock`);
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        try {
          const age = now() - fs.statSync(lockDir).mtimeMs;
          if (age > STALE_MS) {
            fs.rmdirSync(lockDir); // break a dead process's lock
            continue;
          }
        } catch {
          continue; // lock vanished between check and stat — retry
        }
        await sleep(LOCK_POLL_MS);
      }
    }
    try {
      return fn();
    } finally {
      try { fs.rmdirSync(lockDir); } catch { /* already broken as stale */ }
    }
  }

  /**
   * Reserve the next send slot for `host`, spacing reservations by
   * `delayMs`. Returns after any required wait — the caller may send
   * immediately on return.
   */
  async function reserve(host, delayMs) {
    const stateFile = path.join(dir, `${safeHost(host)}.json`);
    const myTurnAt = await withLock(host, () => {
      let nextAllowedAt = 0;
      try {
        nextAllowedAt = JSON.parse(fs.readFileSync(stateFile, "utf8")).nextAllowedAt ?? 0;
      } catch { /* first reservation for this host */ }
      const turn = Math.max(now(), nextAllowedAt);
      fs.writeFileSync(stateFile, JSON.stringify({ nextAllowedAt: turn + delayMs }));
      return turn;
    });
    const wait = myTurnAt - now();
    if (wait > 0) await sleep(wait);
  }

  return { reserve };
}
