import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readPartialCandidate } from "../src/generation/generationStatus";
import type { PartialCandidate } from "../src/generation/partialCandidate";
import { partialOnlyScope } from "../src/generation/partialProjection";

/**
 * WS-D2's status-read path, unit-tested against plain fixture files rather
 * than a live pipeline run — `readPartialCandidate` is pure I/O + an
 * authorization check, and `generateForays.test.ts` already proves the
 * WRITE side produces exactly this shape.
 */

function candidate(overrides: Partial<PartialCandidate> = {}): PartialCandidate {
  return {
    id: "the-history-of-grilling-2026-09-08",
    title: "The history of grilling",
    topic: "food/grilling-bbq",
    summary: "s",
    status: "partial",
    visibility: "private",
    authorId: "founder-1",
    acts: [
      { index: 0, title: "Act 1", status: "ready" },
      { index: 1, title: "Act 2", status: "pending" }
    ],
    slots: [],
    items: [],
    runtimeSec: 120,
    ttlA1Ms: 4200,
    builtAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:05.000Z",
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    ruleScope: partialOnlyScope("partial-only"),
    ...overrides
  };
}

describe("readPartialCandidate", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-status-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns not-found when no partial file matches the id", () => {
    const out = readPartialCandidate(dir, "does-not-exist", "founder-1");
    expect(out).toEqual({ found: false });
  });

  it("finds a partial candidate by its Foray id, not by filename", () => {
    /* MUTATION THAT KILLS THIS: match on filename instead of parsed `id`.
       The status endpoint is asked for a Foray id (the thing a listener/
       player knows), not the prompt-derived slug+hash filename
       (`partialCandidateFilename`) — those are deliberately different
       strings. Ran it — red. */
    fs.writeFileSync(path.join(dir, "some-unrelated-slug-abcd1234.partial.json"), JSON.stringify(candidate()));
    const out = readPartialCandidate(dir, "the-history-of-grilling-2026-09-08", "founder-1");
    expect(out.found).toBe(true);
    if (!out.found) return;
    expect(out.authorized).toBe(true);
    if (!out.authorized) return;
    expect(out.candidate.status).toBe("partial");
    expect(out.candidate.acts).toHaveLength(2);
  });

  it("refuses to serve a candidate to anyone but its requesting listener (visibility: private)", () => {
    /* MUTATION THAT KILLS THIS: drop the authorId comparison and always
       return the candidate. This is the ONE enforcement point for D2's
       "serves the partial candidate to the requesting listener only" —
       a regression here is a privacy leak, not a cosmetic bug. Ran it —
       red (a stranger's userId got the candidate back). */
    fs.writeFileSync(path.join(dir, "x.partial.json"), JSON.stringify(candidate({ authorId: "founder-1" })));
    const out = readPartialCandidate(dir, "the-history-of-grilling-2026-09-08", "someone-else");
    expect(out).toEqual({ found: true, authorized: false });
  });

  it("ignores non-.partial.json files and unparseable JSON without throwing", () => {
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ not: "a candidate" }));
    fs.writeFileSync(path.join(dir, "garbage.partial.json"), "{not valid json");
    fs.writeFileSync(path.join(dir, "real.partial.json"), JSON.stringify(candidate()));
    const out = readPartialCandidate(dir, "the-history-of-grilling-2026-09-08", "founder-1");
    expect(out.found).toBe(true);
  });
});
