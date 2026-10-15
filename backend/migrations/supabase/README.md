# Supabase-only migrations

These are **not** applied by `npm run migrate` (`migrate.ts` globs only top-level
`migrations/*.sql`, so this subfolder is skipped) — on purpose. They reference
the Supabase `auth` schema (`auth.uid()`, `auth.users`) which does not exist on a
bare local Postgres, and the portable set must keep running locally (ADR-0005,
`0001_extensions.sql`).

Apply these to the **Supabase project** after the portable set, via the project's
SQL editor or a dedicated deploy step, in filename order.

**Status: written to spec, NOT yet verified against a live project.** Review and
test before any real user data lands (ADR-0005 → Risks).

| File | What it does |
|------|--------------|
| `0001_auth_and_rls.sql` | Trigger to create an `app_users` row on (anonymous or permanent) sign-in; enables Row-Level Security + `auth.uid() = user_id` policies on the per-user tables. |
| `0002_linter_findings.sql` | Fixes the Supabase database linter's findings: enables deny-all RLS on `schema_migrations`/`learning_cursor`, revokes `anon`/`authenticated` EXECUTE on the two `SECURITY DEFINER` trigger functions, and rescopes the 8 `own_rows_*` policies `to authenticated` explicitly. |
| `0003_rls_least_privilege.sql` | Round-3 audit (backend-rest-4/-5, data-integrity-10): public read-only RLS on the shared catalogue (`catalog_show_episodes`, `catalog_show_feed_state`); deny-all RLS on the pipeline tables (`shows`, `episodes`, `episode_enrichment`, `cost_events`); splits every `own_rows_*` `for all` policy into per-verb policies (select + delete everywhere, insert on `events` only, update nowhere); adds `learning_cursor` own-rows select + delete so Delete my data reaches it; forces `events.ts` server-side with a BEFORE INSERT trigger. Pinned by `test/supabase-rls-verbs.test.js`. **Not applied to production** (founder Q3). |
| `0004_rls_shows_catalog.sql` | PKG-02 (S-09), PR #1045 review: public read-only RLS on `shows_catalog` (portable 0017); deny-all RLS on `show_id_map` (portable 0018). Apply after 0017-0019, as part of gate G2. `test/supabase-rls-coverage.test.js` fails if a table any portable migration creates has no RLS here. **Not applied to production.** |
| `0005_content_reports.sql` | PH2-10: the `content_reports` table behind the Report sheet (App Store Guideline 1.2). RLS: insert-own, select-own, delete-own for `authenticated`; no update policy; column grants so a client may insert only `user_id, target_kind, target_id, reasons, note` and select only `user_id`, so no client can read a report. Needs only 0001-0002, so it can be applied alone. Pinned by `test/supabase-content-reports.test.js`. **Not applied to production** (HUMAN-ACTIONS #116). |
| `0006_event_retention.sql` | Founder ruling HA #13 (retention): enables `pg_cron` and schedules two daily jobs by name. `foray-prune-events-90d` deletes `events` rows whose server-stamped `ts` is over 90 days old; `foray-prune-anon-shells-90d` removes anonymous `auth.users` rows (plus their `app_users`/`learning_cursor` rows) that are over 90 days idle with no events, no linked identity and no derived state (this retires HA #14). Both functions are `SECURITY DEFINER`, pinned `search_path`, revoked from `anon`/`authenticated`. Idempotent; rollback in the file header. Pinned by `test/supabase-event-retention.test.js`. Needs only 0001-0003, so it does not wait for 0004 or 0005. **Not applied to production** (HUMAN-ACTIONS #116). |
| `0007_generation_jobs.sql` | GV-59 (D9, `docs/roadmap/generation-v2.md`): the on-demand job row. `generation_jobs` (author_id → `auth.users` ON DELETE CASCADE; status queued/claimed/running/complete/failed/cancelled; tier; lane; prompt; snapshot jsonb, GV-44's `foray-job/1`; seq) plus the founder allowlist `generation_job_authors`. RLS: an author selects its own rows (never the prompt or worker columns), inserts a queued on-demand job only when allowlisted, and may update only `status`, only to `cancelled`; no delete. `claim_generation_job(text)` (SECURITY DEFINER, service role only) locks the oldest queued job with SKIP LOCKED, marks it claimed and returns the prompt while NULLing it in the same statement; a trigger and a CHECK keep a prompt off every non-queued row. Needs only 0001-0002. Pinned by `test/supabase-rls-coverage.test.js`, `test/supabase-rls-verbs.test.js` and `test/data-deletion.test.js`. **Not applied to production.** |

## Which migrations are applied? (`verify-applied.sql`)

Run this before applying anything (HUMAN-ACTIONS #116) and again after, and to
answer issue #798's question about the portable 0014/0015. Supabase dashboard →
the 4a project → **SQL editor**: paste `verify-applied.sql`, run it. It is
read-only: one `SELECT` over the catalog (`information_schema`, `pg_class`,
`pg_policies`, `pg_trigger`, `pg_proc`, `pg_constraint`, `pg_extension`, and
`cron.job` when pg_cron is installed), so it is safe on production and safe to
re-run. It is not a migration and has no number, so it is not in the table
above.

It returns one row per migration (`0014_persona_seed_source.sql`,
`0015_learning_cursor.sql` and every `supabase/` file): `applied` is `yes`,
`partial` or `no`, `checks_passed` counts the objects found (`9/9`), and
`missing` names each table, policy, RLS switch, trigger, function, revoke,
index, extension or cron job that is not there. `partial` means a file stopped
part way or was edited after it ran: re-running that file (they are all
idempotent) is the usual fix. `0004` reads `no` with "(table missing)" until
gate G2 creates the portable 0017-0019 tables. Paste the result into #116 when
you reply there.

`test/supabase-verify-applied.test.js` fails CI if a migration creates
something the script does not check, if a new numbered file lands with no rows
in it, or if the script ever contains a statement that writes.

## `content_reports` (0005): apply, review, delete

**Apply.** Supabase dashboard → the 4a project → **SQL editor**: paste
`0005_content_reports.sql`, read it, run it. It is idempotent, and it uses no
service-role key: nothing about applying it lives in the repo. It depends only on
0001-0002 (`auth.users`, the `authenticated` role), so it does not wait for gate G2
the way `0004_rls_shows_catalog.sql` does. Check: **Table editor** shows
`content_reports` with RLS **enabled** and three policies (insert, select, delete).
The step is on HUMAN-ACTIONS #116.

**Daily review** (a founder, in the SQL editor, which runs as `postgres` and so
sees every row; `docs/curation/ugc-moderation-runbook.md` §2 has the triage
updates and the SLA):

```sql
select id, created_at, target_kind, target_id, reasons, note from public.content_reports where status = 'open' order by created_at;
```

**Deletion.** `user_id ... references auth.users(id) on delete cascade` removes a
listener's reports when their account is deleted. The delete-own policy serves
the client's **Delete my data** (PH2-12), which sends the same filtered
`DELETE /rest/v1/content_reports?user_id=eq.<uid>` as every other per-user table.

**Why a select-own policy exists when no client may read a report.** Postgres
applies a table's SELECT policies to a DELETE whose `WHERE` reads a column, and
with RLS on and no SELECT policy that check fails for every row: delete-own alone
would make Delete my data's filtered DELETE match nothing and still answer 204,
the false success `test/supabase-rls-verbs.test.js` already guards against for
0003. So 0005 has a select-own policy, and keeps reports unreadable with column
grants instead: the only column a client may select is `user_id`, its own id.
Client writes must use `Prefer: return=minimal`; `return=representation` would
ask for columns the client cannot read and be refused (a loud 401/403, never a
silent success).

## Event retention (0006): apply, check, roll back

**Apply.** Supabase dashboard → the 4a project → **SQL editor**: paste
`0006_event_retention.sql`, read it, run it. It is idempotent and needs only
0001-0003 (it relies on 0003 forcing `events.ts` to server time), so it can go in
the same sitting as 0005. The step is on HUMAN-ACTIONS #116. Until it runs, no
event row is deleted automatically.

**Check.** `select jobname, active from cron.job where jobname like 'foray-prune-%';`
returns 2 rows, both `active = true`.

**Roll back.** The file header lists the `cron.unschedule` and `drop function`
statements. Rows already deleted do not come back.

## Generation jobs (0007): apply, allowlist, check

**Apply.** Supabase dashboard → the 4a project → **SQL editor**: paste
`0007_generation_jobs.sql`, read it, run it. It is idempotent and needs only
0001-0002. Then run `verify-applied.sql`: the `supabase/0007_generation_jobs.sql`
row reads `yes`. This is the founder's step (GV-59 live step); nothing in the
repo applies it.

**Allowlist (D9: founders first).** Only a listed author can queue a job:

```sql
insert into public.generation_job_authors (author_id, note) values ('<auth uid>', 'founder');
```

**The prompt.** It is held in the row only while the job is `queued`.
`claim_generation_job` hands it to the worker and NULLs it in the same
statement; the `generation_jobs_before_update` trigger NULLs it on any other
move out of `queued` (a cancel, a failure), and the
`generation_jobs_prompt_only_while_queued` CHECK makes a prompt on any other
status impossible. A client can never read the column back.

**The worker.** The Spark worker (GV-105) connects with the service-role key
(D8) and calls `rpc/claim_generation_job`; execute is revoked from `anon` and
`authenticated`. It writes snapshots through `backend/src/cli/supabaseJobSink.ts`,
one guarded PATCH per snapshot (`seq=lt.<n>`, status `claimed` or `running`),
so a stale snapshot or a cancelled job is never overwritten.

**Deletion.** `author_id ... references auth.users(id) on delete cascade` removes
an author's jobs and allowlist row when the account is deleted. Delete my data
(app.js `SB_USER_TABLES`) does not reach this table yet: app.js is UI-frozen and
no client writes the table; `test/data-deletion.test.js` holds that ledger.

**Roll back.** The file header lists the `drop` statements. Dropped jobs do not
come back.

## Portable `0023_events_follow_types.sql`: founder applies, NOT applied

RV-23 (`docs/roadmap/recommender-v1.md` D6, issue #1380) widens the `events`
type CHECK with `show_followed` and `show_unfollowed`. It is a portable
migration (`backend/migrations/0023_events_follow_types.sql`, not this folder),
but on Supabase it is applied **by the founder in the SQL editor**, the
HUMAN-ACTIONS #116 pattern: paste the file, read it, run it. It is idempotent
and needs only 0009. **It is NOT applied.** Until it is, the live CHECK rejects
the two types; nothing emits them either (app.js is untouched until the parked
RV-27, and the privacy wording is the founder's, RV-24 on #1163). Check after
applying: `select pg_get_constraintdef(oid) from pg_constraint where conname = 'events_type_check';`
lists both new types.
