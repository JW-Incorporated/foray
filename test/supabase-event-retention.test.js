/* supabase/0006_event_retention.sql, pinned (founder ruling HA #13, 2026-09-30).
 *
 * WHY THIS EXISTS
 * The privacy policy promises: event rows are deleted 90 days after they were
 * recorded; anonymous auth.users shells with no events and no linked identity
 * are pruned after 90 days; derived state lives as long as the account. The
 * migration is the only thing that makes any of that true, and every clause
 * of it is a way to be quietly wrong: a 30 where a 90 should be silently
 * erases history the learner needs, a missing identity check deletes a
 * person's real signed-in account, a missing REVOKE hands the delete to the
 * public anon key as /rest/v1/rpc/prune_empty_anonymous_users.
 *
 * Static, like supabase-rls-verbs.test.js: no database. The SQL is read with
 * comments stripped (the header discusses these clauses at length, and a
 * comment must not satisfy an assertion). Applying 0006 to the live project
 * is a human action.
 *
 * HOW EACH TEST WAS BROKEN (run on the real file, then restored):
 *   T1 pg_cron/schedule  -> delete the `create extension if not exists pg_cron;` line
 *                           or change a job name in cron.schedule(...)
 *   T2 90-day events     -> change `ts < now() - interval '90 days'` to '30 days'
 *   T3 shell guards      -> delete `and not exists (select 1 from auth.identities ...)` (identity)
 *                           or `where u.is_anonymous` (anonymous-only)
 *                           or `not exists (select 1 from public.events ...)` (events)
 *   T4 derived state     -> delete the `public.user_interests` not-exists line
 *   T5 not client-callable -> delete a `revoke execute on function ...` line, or the
 *                           `security definer` / `set search_path` of a function
 *   T6 idempotent/rollback -> change `create or replace function` to `create function`,
 *                           or drop a cron.unschedule name from the header
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FILE = "backend/migrations/supabase/0006_event_retention.sql";
const RAW = fs.readFileSync(path.join(ROOT, FILE), "utf8");
const SQL = RAW.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

const JOBS = ["foray-prune-events-90d", "foray-prune-anon-shells-90d"];
const FUNCS = ["prune_events_older_than_90d", "prune_empty_anonymous_users"];

/** The body of one function, so a clause cannot be satisfied by the other. */
function body(fn) {
  const m = new RegExp(`function public\\.${fn}\\(\\)(.*?)\\$\\$;`).exec(SQL);
  assert.ok(m, `${fn}: function body not found`);
  return m[1];
}

test("pg_cron is enabled and both jobs are scheduled by name, daily, calling their function", () => {
  assert.match(SQL, /create extension if not exists pg_cron;/);
  for (const [i, job] of JOBS.entries()) {
    const re = new RegExp(`select cron\\.schedule\\('${job}', '(\\d+) (\\d+) \\* \\* \\*', \\$\\$select public\\.${FUNCS[i]}\\(\\);\\$\\$\\);`);
    assert.match(SQL, re, `${job}: must be a daily named job that calls ${FUNCS[i]}()`);
  }
  assert.strictEqual((SQL.match(/cron\.schedule\(/g) || []).length, JOBS.length, "no unnamed or extra job");
});

test("events older than 90 days are deleted by server-stamped ts, and nothing younger", () => {
  const b = body(FUNCS[0]);
  assert.match(b, /delete from public\.events where ts < now\(\) - interval '90 days';/);
  assert.doesNotMatch(b, /interval '(?!90 days)/, "no other interval in the events pruner");
});

test("an anonymous shell needs ALL of: anonymous, 90 days idle, no events, no linked identity", () => {
  const b = body(FUNCS[1]);
  assert.match(b, /where u\.is_anonymous /, "anonymous only: a permanent account is never pruned");
  assert.match(b, /not exists \(select 1 from auth\.identities i where i\.user_id = u\.id\)/, "a linked identity protects the account");
  assert.match(b, /not exists \(select 1 from public\.events e where e\.user_id = u\.id\)/, "any event protects the account");
  assert.match(b, /u\.created_at < now\(\) - interval '90 days'/);
  assert.match(b, /coalesce\(u\.last_sign_in_at, u\.created_at\) < now\(\) - interval '90 days'/);
  assert.match(b, /a\.last_seen_at is null or a\.last_seen_at < now\(\) - interval '90 days'/);
  assert.doesNotMatch(b, /interval '(?!90 days)/);
});

test("derived state keeps its account alive: interests, taxonomy, saved items, sessions, subscriptions", () => {
  const b = body(FUNCS[1]);
  for (const t of ["user_interests", "taxonomy_nodes", "saved_items", "sessions", "subscriptions"]) {
    assert.match(b, new RegExp(`not exists \\(select 1 from public\\.${t} x where x\\.user_id = u\\.id\\)`), `${t}: rows must protect the account`);
  }
  // The pruner deletes only the shell's own rows, never derived-state tables.
  for (const t of ["user_interests", "taxonomy_nodes", "saved_items", "sessions", "subscriptions", "events"]) {
    assert.doesNotMatch(b, new RegExp(`delete from public\\.${t}\\b`), `${t}: the shell pruner must not delete it`);
  }
});

test("both functions are SECURITY DEFINER with a pinned search_path and are not callable by anon/authenticated", () => {
  for (const fn of FUNCS) {
    const m = new RegExp(`create or replace function public\\.${fn}\\(\\) returns bigint language plpgsql security definer set search_path = public, pg_temp as`).exec(SQL);
    assert.ok(m, `${fn}: must be security definer with set search_path = public, pg_temp`);
    assert.match(SQL, new RegExp(`revoke execute on function public\\.${fn}\\(\\) from anon, authenticated, public;`), `${fn}: must be revoked from the client roles`);
  }
});

test("idempotent re-run, and the header documents the rollback for every job and function", () => {
  assert.doesNotMatch(SQL, /create function|create table|create trigger|create policy/, "only `or replace` / `if not exists` forms");
  for (const job of JOBS) assert.match(RAW, new RegExp(`select cron\\.unschedule\\('${job}'\\);`), `${job}: rollback line missing`);
  for (const fn of FUNCS) assert.match(RAW, new RegExp(`drop function if exists public\\.${fn}\\(\\);`), `${fn}: rollback line missing`);
  assert.match(RAW, /NOT APPLIED TO PRODUCTION/);
});
