import { defineConfig } from "vitest/config";

/**
 * Stryker-only test config (see stryker.config.json). Stryker sandboxes just
 * `backend/` (the directory it's run from), not the whole repo — so tests
 * that read files outside backend/ via `path.resolve(__dirname, "..", "..")`
 * (sessionBuilder.test.ts, dataSchemaCompliance.test.ts both read
 * `../../data/*.json`; politeness.test.ts and src/feeds/politeness.ts both
 * read `tools/refresh/dai-hosts.json`, code-health CH2-26) fail inside the
 * sandbox with ENOENT, aborting
 * Stryker's dry run before mutation testing even starts. Mutation is scoped
 * to src/curation/scoring.ts and src/identity/dedup.ts only (stryker
 * "mutate" config) — those two files are already exercised directly by
 * test/scoring.test.ts, test/dedup.test.ts, and test/property/*.test.ts, so
 * excluding the three repo-root-dependent tests from the Stryker run doesn't
 * cost mutation coverage on the files actually being mutated. `npm test`
 * (the real gate) still runs the full suite via vitest.config.ts unchanged.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/sessionBuilder.test.ts",
      "test/dataSchemaCompliance.test.ts",
      "test/politeness.test.ts"
    ],
    environment: "node",
    testTimeout: 10000,
    reporters: "default"
  }
});
