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
