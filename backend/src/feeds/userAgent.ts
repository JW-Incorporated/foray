/**
 * Standalone User-Agent constant (S-02, kanban t_4bd3c0a3), split out of
 * `config/env.ts` so `conditionalGet.ts` no longer needs to import that
 * module. `config/env.ts` pulls in `dotenv` + `fs` + `zod`-adjacent
 * validation and reads the repo-root `.env` — none of which is declared in
 * `api/package.json`'s dependencies, and Vercel's `installCommand` (see
 * `vercel.json`) only installs that file's deps. Importing `config/env`
 * transitively from an `api/**` serverless function is exactly why
 * `GET /api/shows/:id/episodes` crashed with `FUNCTION_INVOCATION_FAILED` on
 * every request (module-load failure, before routing even runs).
 *
 * Zero imports, deliberately: this file must never grow a dependency that
 * would need to be added to `api/package.json`. `api/test/import-closure.test.mjs`
 * pins the whole `api/**` import graph against that package's declared deps;
 * this constant exists so `conditionalGet.ts` can sit on the safe side of
 * that boundary without behavior changing for its non-`api/` callers, which
 * keep passing their own `env.userAgent` explicitly.
 */
export const DEFAULT_FEED_USER_AGENT = "Foray/0.1 (personal podcast client; contact wjduvall@gmail.com)";
