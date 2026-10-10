import type { UserInterestsProvider } from "./userInterests";
import { InMemoryUserInterestsProvider } from "./userInterests";

/**
 * The provider `npm run build-session` uses: always the keyless in-memory one.
 *
 * DATABASE_URL does not choose a provider. It belongs to `npm run migrate` and
 * `npm run learn-interests`, and it used to make this factory throw, so
 * setting it for those two CLIs crashed build-session (CH2-05, B2-04). There
 * is no Postgres-backed provider; standing one up is an infra and privacy
 * change that needs its own decision (docs/DECISIONS.md, "Decided against
 * standing up a live per-user backend"; docs/legal/data-safety.md), not an
 * env var.
 */
export function createUserInterestsProvider(): UserInterestsProvider {
  return new InMemoryUserInterestsProvider();
}
