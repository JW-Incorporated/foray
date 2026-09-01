import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { understandPrompt } from "../src/generation/understandPrompt";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";

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

  it("none of the generation-stage source files call a persistence primitive", () => {
    const files = fs.readdirSync(GENERATION_DIR).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const persistenceCallPattern =
      /\bfs\.(write|append|create)\w*Sync?\b|\blocalStorage\.\w+\(|\bnew Pool\(|\bclient\.query\(|INSERT INTO|localforage\./;

    for (const file of files) {
      const contents = fs.readFileSync(path.join(GENERATION_DIR, file), "utf8");
      expect(contents, `${file} must not persist anything`).not.toMatch(persistenceCallPattern);
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
