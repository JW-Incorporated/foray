#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";
import { env, envPresenceSummary } from "../config/env";
import { TaxonomyFileSchema } from "../types/taxonomy";
import { buildKnownNodeMap } from "../curation/interestLearning";
import { PostgresEventStore } from "../curation/eventStore";
import { PostgresLearningCursorStore } from "../curation/learningCursor";
import { PostgresTaxonomyRepository, PostgresInterestAuditRepository } from "../curation/learningRepository";
import { runLearningJobForUser } from "../curation/learningJob";

/**
 * `npm run learn-interests` — the interest-learning job's CLI entry point
 * (personalization-and-depth-plan.md Step C). Reads unprocessed rows from
 * `events`, derives node-weight deltas per 03_CURATION_SPEC.md's "Learning
 * from signals" table, and writes `taxonomy_nodes` (current weight) +
 * `user_interests` (audit log) — see curation/interestLearning.ts for the
 * rules and curation/learningJob.ts for the per-user run loop.
 *
 * Degrades gracefully when DATABASE_URL is unset (same convention as
 * cli/migrate.ts and cli/buildSession.ts): prints what it would do and
 * exits 0, so `npm test` never needs a live Postgres instance.
 *
 * Usage:
 *   npm run learn-interests
 *   npm run learn-interests -- --user <uuid> [--user <uuid> ...]
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// Same seeded placeholder used by cli/buildSession.ts pending real auth.uid()
// wiring (ADR-0005 "what's next" #4).
const SEEDED_USER_ID = "00000000-0000-0000-0000-000000000001";

function parseUsers(argv: string[]): string[] {
  const users: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--user" && argv[i + 1]) {
      users.push(argv[i + 1]!);
      i += 1;
    }
  }
  return users.length > 0 ? users : [SEEDED_USER_ID];
}

function loadKnownNodes() {
  const taxonomyPath = path.join(REPO_ROOT, "data", "taxonomy.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- hardcoded repo-relative path built from __dirname; not external input.
  const raw = fs.readFileSync(taxonomyPath, "utf-8");
  const taxonomy = TaxonomyFileSchema.parse(JSON.parse(raw));
  return buildKnownNodeMap(taxonomy);
}

async function main(): Promise<void> {
  const users = parseUsers(process.argv.slice(2));

  console.log("Foray interest-learning job");
  console.log("  env:", envPresenceSummary());

  if (!env.databaseUrl) {
    console.log("DATABASE_URL is not set — dry-run only. Would process events for:", users);
    console.log("Set DATABASE_URL in the repo-root .env to actually run against a live events table.");
    return;
  }

  const knownNodes = loadKnownNodes();
  console.log(`  known taxonomy nodes: ${knownNodes.size}`);

  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    const eventStore = new PostgresEventStore(client);
    const cursorStore = new PostgresLearningCursorStore(client);
    const taxonomyRepo = new PostgresTaxonomyRepository(client);
    const auditRepo = new PostgresInterestAuditRepository(client);

    for (const userId of users) {
      const result = await runLearningJobForUser(userId, {
        eventStore,
        cursorStore,
        applyDeps: { taxonomyRepo, auditRepo, knownNodes }
      });

      const appliedDurable = result.outcomes.flatMap((o) => o.applied).filter((a) => a.durable).length;
      const audited = result.outcomes.flatMap((o) => o.applied).filter((a) => !a.durable).length;
      const skipped = result.outcomes.flatMap((o) => o.skipped).length;

      console.log(
        `  user ${userId}: ${result.eventsProcessed} event(s) processed, ${appliedDurable} durable weight update(s), ${audited} context-only audit row(s), ${skipped} skipped (unknown node)`
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("learn-interests failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
