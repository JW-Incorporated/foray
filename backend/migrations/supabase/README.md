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
