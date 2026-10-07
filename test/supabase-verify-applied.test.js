/* backend/migrations/supabase/verify-applied.sql stays in step with the
 * migrations it checks, and stays read-only.
 *
 * WHY THIS EXISTS (HUMAN-ACTIONS #116, issue #798 "Infrastructure, not checked")
 * Nobody can see from the repo which Supabase migrations are live: 0003-0006
 * each say "NOT APPLIED TO PRODUCTION", and #798 asks whether the portable
 * 0014/0015 ever reached the live database. verify-applied.sql answers that in
 * one paste into the SQL editor, one row per migration. It is only useful while
 * it checks every object each migration creates, so this suite reads the
 * migrations and fails when one of their tables, policies, RLS switches,
 * triggers, functions, revokes, indexes, extensions or cron jobs has no row in
 * the script under that migration's name, or when a new numbered migration
 * lands with no rows at all. And because a founder will run it on production
 * with full rights, it fails if the script ever holds a statement that writes.
 *
 * Static: no database. Running the script is the founder's step.
 *
 * Mutations that kill it (each run by hand, 2026-10-07):
 *   - delete the own_delete_events policy row from verify-applied.sql -> test 1;
 *   - move the content_reports_select_own row from 0005 to 0004 -> test 1;
 *   - delete the cron_job row for foray-prune-anon-shells-90d -> test 1;
 *   - delete every 0004 row -> tests 1 and 2;
 *   - add a numbered supabase/0007_x.sql holding `create table if not exists
 *     public.x (id int);` -> tests 1 and 2;
 *   - append `delete from public.events;` (or `drop table public.events;`) to
 *     verify-applied.sql -> test 3;
 *   - rename the kind 'policy_absent' to 'policy_gone' in one row only -> test 4;
 *   - break one row so the row parser cannot read it (drop its closing paren)
 *     -> tests 1 and 4;
 *   - drop the "Which migrations are applied?" section from the README -> test 5.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MIG = "backend/migrations";
const SUPA = `${MIG}/supabase`;
const VERIFY = `${SUPA}/verify-applied.sql`;
/* #798 names these two portable migrations; the rest of the portable set is
   applied by `npm run migrate` and checked by its schema_migrations rows. */
const PORTABLE = ["0014_persona_seed_source.sql", "0015_learning_cursor.sql"];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sqlOnly = (src) => src.replace(/--[^\n]*/g, "");
const flat = (s) => s.replace(/\s+/g, " ");

/** Migration labels as the script names them: relative to backend/migrations/. */
function migrations() {
  const supa = fs.readdirSync(path.join(ROOT, SUPA)).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
  return [...PORTABLE, ...supa.map((n) => `supabase/${n}`)];
}

/** Every object a migration creates, as {kind, tbl, name}. */
function createdBy(label) {
  const sql = flat(sqlOnly(read(`${MIG}/${label}`))).toLowerCase();
  const out = [];
  const add = (kind, tbl, name) => out.push({ kind, tbl: tbl || null, name: name || null });

  /* 0001/0002 build their RLS switches and own_rows_* policies in a
     `foreach t in array array[...]` loop: expand it. */
  const loop = /foreach t in array array\[([^\]]*)\]/.exec(sql);
  const loopTables = loop ? [...loop[1].matchAll(/'(\w+)'/g)].map((m) => m[1]) : [];
  if (loop && /format\('alter table public\.%i enable row level security;', t\)/.test(sql)) {
    for (const t of loopTables) add("rls", `public.${t}`);
  }
  if (loop && /create policy %i on public\.%i/.test(sql)) {
    const prefix = /'(\w+)' \|\| t, t/.exec(sql);
    assert.ok(prefix, `${label}: a looped create policy whose name this parser cannot read`);
    for (const t of loopTables) add("policy", `public.${t}`, prefix[1] + t);
  }

  for (const m of sql.matchAll(/create table if not exists (?:public\.)?(\w+)/g)) add("table", `public.${m[1]}`);
  for (const m of sql.matchAll(/alter table public\.(\w+) enable row level security/g)) add("rls", `public.${m[1]}`);
  for (const m of sql.matchAll(/create policy (\w+) on public\.(\w+)/g)) add("policy", `public.${m[2]}`, m[1]);
  for (const m of sql.matchAll(/create (?:or replace )?function (public\.\w+)\(\)/g)) add("function", null, `${m[1]}()`);
  for (const m of sql.matchAll(/revoke execute on function (public\.\w+)\(\) from anon, authenticated/g)) add("not_client_callable", null, `${m[1]}()`);
  for (const m of sql.matchAll(/create trigger (\w+) (?:before|after) \w+ on (\w+\.\w+)/g)) add("trigger", m[2], m[1]);
  for (const m of sql.matchAll(/create (?:unique )?index if not exists (\w+) on public\./g)) add("index", null, `public.${m[1]}`);
  for (const m of sql.matchAll(/create extension if not exists (\w+)/g)) add("extension", null, m[1]);
  for (const m of sql.matchAll(/cron\.schedule\('([^']+)'/g)) add("cron_job", null, m[1]);
  for (const m of sql.matchAll(/alter table (?:public\.)?(\w+) add constraint (\w+)/g)) add("check_allows", `public.${m[1]}`, m[2]);
  for (const m of sql.matchAll(/alter table (?:public\.)?(\w+) alter column (\w+) set default/g)) add("default", `public.${m[1]}`, m[2]);
  return out;
}

const VERIFY_SQL = sqlOnly(read(VERIFY));
const VALUE = "(null|'[^']*')(?:::text)?";
const ROW_RE = new RegExp(`\\(\\s*'([^']+)'\\s*,\\s*'(\\w+)'\\s*,\\s*${VALUE}\\s*,\\s*${VALUE}\\s*,\\s*${VALUE}\\s*\\)`, "g");
const unq = (v) => (v === "null" ? null : v.slice(1, -1));

/** The `expected` rows of verify-applied.sql: {migration, kind, tbl, name, alt}. */
function verifyRows() {
  return [...VERIFY_SQL.matchAll(ROW_RE)].map(([, migration, kind, tbl, name, alt]) => ({
    migration, kind, tbl: unq(tbl), name: unq(name), alt: unq(alt),
  }));
}

/** A policy created by 0001/0002 may be checked by either policy kind. */
const sameKind = (want, got) =>
  want === "policy" ? got === "policy" || got === "policy_authenticated" : want === got;

test("every object a migration creates has a row under that migration in verify-applied.sql", () => {
  const rows = verifyRows();
  const missing = [];
  for (const label of migrations()) {
    const objects = createdBy(label);
    assert.ok(objects.length > 0, `${label}: this parser found nothing it creates; teach createdBy() its shape`);
    for (const o of objects) {
      const hit = rows.some((r) => r.migration === label && sameKind(o.kind, r.kind) && r.tbl === o.tbl && r.name === o.name);
      if (!hit) missing.push(`${label}: ${o.kind} ${[o.tbl, o.name].filter(Boolean).join(" ")}`);
    }
  }
  assert.deepStrictEqual(missing, [], `verify-applied.sql has no row for:\n${missing.join("\n")}`);
});

test("verify-applied.sql reports exactly the numbered supabase/ migrations plus portable 0014/0015", () => {
  const labels = [...new Set(verifyRows().map((r) => r.migration))].sort();
  assert.deepStrictEqual(labels, migrations().sort());
  assert.ok(!/^\d{4}_/.test(path.basename(VERIFY)), "the check must not carry a migration number: it is not applied in filename order");
});

test("verify-applied.sql is one SELECT and writes nothing", () => {
  const writes = VERIFY_SQL.match(/\b(insert|update|delete|merge|upsert|alter|drop|create|truncate|grant|revoke|copy|comment|vacuum|reindex|cluster|lock|call|do)\b/gi);
  assert.strictEqual(writes, null, `verify-applied.sql must be read-only; found: ${writes && writes.join(", ")}`);
  assert.doesNotMatch(VERIFY_SQL, /\bcron\.(un)?schedule\b|\bset_config\b|\bpg_(terminate|cancel)_backend\b|\bnextval\b|\bsetval\b/i);
  const code = VERIFY_SQL.replace(/'(?:[^']|'')*'/g, "''").trim();
  assert.match(code, /^with expected\(/i, "one WITH ... SELECT statement");
  assert.strictEqual((code.match(/;/g) || []).length, 1, "exactly one statement");
  assert.ok(code.endsWith(";"));
});

test("every row parses, and every kind it uses is both checked and explained", () => {
  const values = /values\n([\s\S]*?)\n\),\nchecked as/.exec(VERIFY_SQL);
  assert.ok(values, "the expected(...) values block");
  const rowLines = values[1].split("\n").filter((l) => /^\s*\('/.test(l)).length;
  const rows = verifyRows();
  assert.strictEqual(rows.length, rowLines, "a row this suite cannot parse is a row it cannot check");
  for (const kind of new Set(rows.map((r) => r.kind))) {
    const arms = VERIFY_SQL.match(new RegExp(`when '${kind}' then`, "g")) || [];
    assert.strictEqual(arms.length, 2, `kind '${kind}': needs one arm in the ok case and one in the missing text`);
  }
  const keys = rows.map((r) => [r.migration, r.kind, r.tbl, r.name].join("|"));
  assert.deepStrictEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], "duplicate rows");
});

test("the README tells a founder to paste it, and lists it apart from the migrations", () => {
  const readme = flat(read(`${SUPA}/README.md`));
  assert.match(readme, /## Which migrations are applied\? \(`verify-applied\.sql`\)/);
  assert.match(readme, /SQL editor\*\*: paste `verify-applied\.sql`/);
  assert.match(readme, /`applied` is `yes`, `partial` or `no`/);
  assert.match(readme, /read-only/i);
  assert.doesNotMatch(readme, /\| `verify-applied\.sql` \|/, "not a row of the migration table: it is not applied");
});
