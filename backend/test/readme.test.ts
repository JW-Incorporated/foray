import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * CH2-37 (B2-19, docs/roadmap/code-health-2.md): backend/README.md is the file
 * the next agent is briefed from, and it had drifted from the backend that
 * exists — six of twelve claimed commands, a literal model id three
 * generations old, "164 tests". These pins hold the two facts that drift
 * fastest to their sources of truth, so the next drift is a red `backend`
 * check rather than a wrong brief.
 */

const BACKEND = path.resolve(__dirname, "..");
const README = fs.readFileSync(path.join(BACKEND, "README.md"), "utf8");
const PKG = JSON.parse(fs.readFileSync(path.join(BACKEND, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** `npm run <name>` → `src/cli/<file>.ts` for every script that runs a CLI through tsx. */
function tsxScripts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, cmd] of Object.entries(PKG.scripts)) {
    const m = /^tsx\s+(\S+\.ts)\b/.exec(cmd);
    if (m?.[1]) out.set(name, m[1]);
  }
  return out;
}

/** The README section between `## <title>` and the next `## ` heading. */
function section(title: string): string {
  const start = README.indexOf(`\n## ${title}\n`);
  expect(start, `backend/README.md has no "## ${title}" section`).toBeGreaterThanOrEqual(0);
  const rest = README.slice(start + title.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("backend/README.md describes the backend that exists", () => {
  it("lists exactly package.json's tsx CLI scripts, each with its source file", () => {
    const scripts = tsxScripts();
    // Sanity: the parse found the CLIs at all (eight when this pin was written).
    expect(scripts.size).toBeGreaterThan(0);

    const rows = [...section("CLI scripts").matchAll(/^\|\s*`npm run ([a-z0-9-]+)`\s*\|\s*`([^`]+)`/gm)];
    const listed = new Map(rows.map((r) => [r[1], r[2]]));

    expect([...listed.keys()].sort()).toEqual([...scripts.keys()].sort());
    for (const [name, file] of scripts) {
      expect(listed.get(name), `README row for npm run ${name}`).toBe(file);
    }
  });

  it("sends the reader to src/config/models.ts for the model, and writes no model id itself", () => {
    expect(README).toContain("src/config/models.ts");
    expect(README).toMatch(/modelFor\("haiku"\)/);
    // A literal id in prose is the drift this card fixed (`claude-haiku-4-5`
    // stayed in the README after models.ts moved every tier on).
    expect(README).not.toMatch(/claude-(opus|sonnet|haiku)-\d/);
  });

  it("states no test count", () => {
    expect(README).not.toMatch(/\b\d+ tests\b/);
  });
});
