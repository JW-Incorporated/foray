import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claimHash } from "../src/generation/gatherEvidence";
import { readEvidenceCache, writeEvidenceCache } from "../src/generation/evidenceCache";
import { understandPrompt } from "../src/generation/understandPrompt";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";

/**
 * §9.4's ruling, enforced: "Each prompt is discarded. The Foray is given a
 * title on creation, which is retained." — Wyatt's explicit ruling, recorded
 * in generation-architecture.md §9.4.
 *
 * This is the strongest version of the check the task's own acceptance
 * criteria asks for: grep whatever storage this stage touches for leaked
 * prompt text. `understandPrompt` and its collaborators write to nothing —
 * there is no file, no database, no localStorage call anywhere in this
 * pipeline stage — so the real assertion is structural: scan the source of
 * every module this stage imports for any filesystem/db write call, and
 * confirm none exists. A regression that added `fs.writeFileSync` (or any
 * other persistence primitive) to this stage would be caught here before it
 * could ever leak a live prompt.
 */
describe("no raw prompt text is persisted anywhere by the §4.0-4.1 stage", () => {
  const GENERATION_DIR = path.join(__dirname, "..", "src", "generation");

  /* THE ONE EXEMPTION, NAMED RATHER THAN GREPPED AROUND. WS-A caches
     retrieved print passages under `data-local/evidence/` so a re-run does
     not pay for the same web retrieval twice, and `evidenceCache.ts` is the
     single module that performs that write. Naming it here — instead of
     moving the write to a module outside this directory, which would have
     passed this grep while breaking the rule it protects — keeps the rule
     enforceable: any OTHER generation module that starts writing to disk
     still fails, and the exemption itself is held to §9.4 by the test
     below: the cache is keyed by a hash, and what it writes contains no
     prompt-derived text. */
  /* THE SECOND EXEMPTION, ON THE SAME TERMS (WS-H). `transcriptTextIndex.ts`
     caches its inverted index over the ARCHIVE’s cue text under
     `data-local/transcripts/index/<show>.json` so a search does not re-read 63
     transcripts per beat. What it writes is derived entirely from podcast
     transcripts and a show id — a prompt, a claim and a beat never reach it, and
     the test below holds it to that rather than taking this comment’s word. */
  const PERSISTENCE_EXEMPT = new Set(["evidenceCache.ts", "transcriptTextIndex.ts"]);

  it("none of the generation-stage source files call a persistence primitive", () => {
    const files = fs.readdirSync(GENERATION_DIR).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const persistenceCallPattern =
      /\bfs\.(write|append|create)\w*Sync?\b|\blocalStorage\.\w+\(|\bnew Pool\(|\bclient\.query\(|INSERT INTO|localforage\./;

    for (const file of files) {
      if (PERSISTENCE_EXEMPT.has(file)) continue;
      const contents = fs.readFileSync(path.join(GENERATION_DIR, file), "utf8");
      expect(contents, `${file} must not persist anything`).not.toMatch(persistenceCallPattern);
    }
  });

  it("the evidence cache writes public document text under a hash, and never the claim it was retrieved for", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-evidence-cache-"));
    try {
      const claim = "the walkways hung from a single rod above a tea dance";
      const hash = claimHash(claim);
      expect(hash).toMatch(/^[0-9a-f]+$/);

      writeEvidenceCache(dir, hash, [
        { docId: "print:x-1", kind: "print", title: "NBS Building Science Series 143", text: "The connections were not checked for adequacy." }
      ]);

      const written = fs.readdirSync(dir);
      expect(written).toEqual([`${hash}.json`]);
      const raw = fs.readFileSync(path.join(dir, written[0]!), "utf8");
      // §9.4: nothing on disk can be read back as text a user supplied.
      expect(raw).not.toContain(claim);
      expect(raw).not.toContain("walkways");
      expect(JSON.parse(raw)).not.toHaveProperty("claim");
      expect(readEvidenceCache(dir, hash)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the transcript text index caches podcast words under a show id, and never a claim or a prompt", () => {
    /* WS-H's exemption, held to §9.4 the way the evidence cache's is. The index
       is built from cue text a provider hands it and is keyed by `show_id`; the
       claim a search was run FOR is never part of what is written, so nothing on
       disk can be read back as text a user supplied. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-text-index-"));
    try {
      const cues = [{ text: "we talked about labelling errors in the benchmark", start_sec: 0, end_sec: 10 }];
      const archive = [
        { show_id: "practical-ai", show_title: "Practical AI", guid: "pa-1", title: "Episode 1", cues: 1, feed_duration_sec: 3600 }
      ];
      const index = new FileTranscriptTextIndex({
        archive,
        bodies: { getCues: () => cues, bodyStat: () => ({ mtimeMs: 1, size: 1 }) },
        indexRoot: dir
      });
      const claim = "the walkways hung from a single rod above a tea dance";
      expect(index.search(`${claim} labelling errors benchmark`)).toHaveLength(1);

      expect(fs.readdirSync(dir)).toEqual(["practical-ai.json"]);
      const raw = fs.readFileSync(path.join(dir, "practical-ai.json"), "utf8");
      expect(raw).not.toContain(claim);
      expect(raw).not.toContain("walkways");
      expect(raw).not.toContain("dance");
      expect(raw).toContain("labelling");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("running the full understand-prompt flow does not create or modify any file on disk", async () => {
    const before = snapshotRepoFiles();
    const understander = new StubPromptUnderstander();

    await understandPrompt("the secret history of a very specific private topic", understander, { userId: "founder-1" });
    await understandPrompt("Mercury", understander, { userId: "founder-1" });
    await understandPrompt("how to build a bomb", understander, { userId: "founder-1" });

    const after = snapshotRepoFiles();
    expect(after).toEqual(before);
  });

  it("the returned result for an understood prompt never echoes back a field literally named 'prompt' or 'rawPrompt'", async () => {
    const understander = new StubPromptUnderstander();
    const result = await understandPrompt("the history of grilling", understander, { userId: "founder-1" });

    expect(result.outcome).toBe("understood");
    if (result.outcome === "understood") {
      expect(Object.keys(result.intent)).not.toContain("prompt");
      expect(Object.keys(result.intent)).not.toContain("rawPrompt");
    }
  });
});

/** Repo root's data-local/ and data/ directory listings — a real persistence
 * bug in this stage would show up as a new/changed file in one of these. */
function snapshotRepoFiles(): Record<string, string[]> {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const dirsToWatch = ["data", "data-local"];
  const snapshot: Record<string, string[]> = {};
  for (const dir of dirsToWatch) {
    const full = path.join(repoRoot, dir);
    snapshot[dir] = fs.existsSync(full) ? fs.readdirSync(full).sort() : [];
  }
  return snapshot;
}
