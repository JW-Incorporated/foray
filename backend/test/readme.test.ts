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

const REPO = path.resolve(BACKEND, "..");

/**
 * src/-relative file → the tools/ scripts that load it at runtime: a relative
 * import or `new URL(...)` of `../backend/src/...`, or a
 * `join(root, "backend", "src", ...)`. Prose that merely mentions a path
 * (`backend/src/x.ts`, unquoted or without the leading `../`) does not
 * match; tests are skipped.
 */
function toolsLoadsFromSrc(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (file: string, user: string) => {
    if (!out.has(file)) out.set(file, new Set());
    out.get(file)!.add(user);
  };
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules") walk(full);
        continue;
      }
      if (!/\.(mjs|cjs|js)$/.test(ent.name) || /\.test\.(mjs|cjs|js)$/.test(ent.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      const user = path.relative(REPO, full).split(path.sep).join("/");
      for (const m of src.matchAll(/["'](?:\.\.\/)+backend\/src\/([^"']+)["']/g)) if (m[1]) add(m[1], user);
      for (const m of src.matchAll(/"backend",\s*"src",((?:\s*"[^"]+",?)+)\s*\)/g)) {
        const parts = [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((p) => p[1]);
        add(parts.join("/"), user);
      }
    }
  };
  walk(path.join(REPO, "tools"));
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

  it("names every backend/src file a tools/ script loads, next to that script", () => {
    // B2-19 review: the README said everything outside the api/ table ran
    // only from CLIs or tests, while five tools/ scripts import copy/rules.js.
    const loads = toolsLoadsFromSrc();
    // Sanity: the scan found the copy/ importers at all.
    expect(loads.get("copy/rules.js")?.size ?? 0).toBeGreaterThan(0);

    const rows = new Map<string, string>();
    for (const line of section("Who calls this code in production").split("\n")) {
      if (!line.startsWith("| `")) continue;
      const cells = line.split("|");
      for (const m of (cells[1] ?? "").matchAll(/`([^`]+)`/g)) if (m[1]) rows.set(m[1], cells[2] ?? "");
    }
    for (const [file, users] of loads) {
      expect(rows.has(file), `README "Who calls this code in production" has no row for src/${file}`).toBe(true);
      for (const user of users) {
        expect(rows.get(file), `README row for src/${file} names ${user}`).toContain(`\`${user}\``);
      }
    }
  });

  it("states no test count", () => {
    expect(README).not.toMatch(/\b\d+ tests\b/);
  });
});
