-- supabase/0004_rls_shows_catalog.sql  (Supabase project only — see README)
-- PKG-02 (S-09) review, PR #1045. Builds on 0001-0003; apply after them, in
-- filename order, and after the portable 0017-0019 (the tables must exist).
-- Idempotent: safe to re-run.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. It is part of gate G2 (apply
-- 0017-0019 to the database G1 points DATABASE_URL at): see the S-09 entry in
-- docs/DECISIONS.md and the S-09 block in STATE.md.
--
-- Why: 0017 (shows_catalog) and 0018 (show_id_map) create two new public
-- tables. Without RLS, Supabase's public anon key could write them, the same
-- hole 0003 closed for the 0016 catalogue (audit finding backend-rest-4).
-- test/supabase-rls-coverage.test.js fails if any table a portable migration
-- creates has no RLS in this folder.
--
-- The service role (load-postgres.mjs, the endpoint's pg connection, migrate)
-- bypasses RLS, so nothing on the server side changes.

-- 1. shows_catalog (0017): public breadth data (title, author, feed URL), so
--    public READ, never public WRITE. load-postgres.mjs is the only writer.
alter table public.shows_catalog enable row level security;
drop policy if exists public_read_shows_catalog on public.shows_catalog;
create policy public_read_shows_catalog on public.shows_catalog for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.shows_catalog from anon, authenticated;

-- 2. show_id_map (0018): pipeline bookkeeping (curated slug -> pi_id). No
--    client path reads or writes it: deny-all RLS (no policy) plus no write
--    grants, like 0003's pipeline tables.
alter table public.show_id_map enable row level security;
revoke insert, update, delete, truncate on public.show_id_map from anon, authenticated;
