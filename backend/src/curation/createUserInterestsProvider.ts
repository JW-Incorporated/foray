import { env } from "../config/env";
import type { UserInterestsProvider } from "./userInterests";
import { InMemoryUserInterestsProvider } from "./userInterests";

/**
 * Selects the in-memory provider when no database is wired in, a real
 * Postgres-backed provider otherwise — same env-gated shape as
 * src/enrich/createEnricher.ts (StubEnricher vs AnthropicEnricher).
 *
 * There is no PostgresUserInterestsProvider yet: the Supabase project is
 * provisioned and 0001-0013 + RLS are live (ADR-0005), but backend DB
 * credentials are not yet wired into src/config/env.ts, so this branch is
 * intentionally unreachable in practice today. It's written now so wiring
 * credentials later is "add the file, done" — no call site changes, exactly
 * how createEnricher.ts's AnthropicEnricher swap-in works.
 */
export function createUserInterestsProvider(): UserInterestsProvider {
  if (env.databaseUrl === undefined) {
    return new InMemoryUserInterestsProvider();
  }
  throw new Error(
    "createUserInterestsProvider: DATABASE_URL is set but PostgresUserInterestsProvider does not exist yet " +
      "(personalization-and-depth-plan.md Step A follow-on). Unset DATABASE_URL to use the in-memory provider, " +
      "or implement backend/src/curation/PostgresUserInterestsProvider.ts and lazily require it here."
  );
}
