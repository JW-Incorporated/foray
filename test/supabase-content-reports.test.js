/* supabase/0005_content_reports.sql: the Report sheet's table, pinned.
 *
 * WHY THIS EXISTS (PH2-10, docs/roadmap/listener-forays-sharing.md §3)
 * App Store Guideline 1.2 needs "a mechanism to report offensive content". The
 * reports land in `content_reports` (docs/curation/ugc-moderation-runbook.md
 * §2). A listener's anonymous session may file a report as itself and delete
 * its own reports (Delete my data, PH2-12); no client may read or change one.
 * Each of those is one line of SQL, and none of them fails loudly when wrong:
 * a stray select policy leaks every report, a missing one makes Delete my
 * data a 204 that deleted nothing.
 *
 * The plan said "no select policy". That breaks the filtered DELETE app.js
 * sends (`?user_id=eq.<uid>`): Postgres applies SELECT policies to a DELETE
 * whose WHERE reads a column, and with RLS on and no SELECT policy every row
 * fails that check (test/supabase-rls-verbs.test.js says the same for 0003).
 * So 0005 has select-own, and column grants keep reports unreadable: a client
 * may select `user_id` only. Test 4 pins that trade both ways.
 *
 * Static: no database. Applying supabase/ migrations is HUMAN-ACTIONS #116.
 *
 * Mutations that kill it (each run by hand on the PH2-10 branch):
 *   - delete the `enable row level security` line             -> tests 1, 2
 *   - note cap 280 -> 2800                                      -> test 1
 *   - add `create policy x on public.content_reports for update to authenticated using (true);`
 *                                                               -> test 3
 *   - add `create policy x on public.content_reports for select to anon, authenticated using (true);`
 *                                                               -> tests 3, 4
 *   - add `create policy content_reports_read on public.content_reports using (true);`
 *     (no FOR = FOR ALL, no TO = TO PUBLIC)                     -> test 3
 *   - add `create policy x on public.content_reports as permissive for select to anon using (true);`
 *                                                               -> tests 3, 4
 *   - add `create policy x on public.content_reports for select to authenticated;`
 *     (no USING: unparseable, caught by the raw count)          -> test 3
 *   - insert-own `with check (true)` instead of the uid match   -> test 3
 *   - delete the select-own policy                              -> tests 3, 4
 *   - `grant select on public.content_reports to authenticated;` (whole table)
 *                                                               -> test 4
 *   - add `status` to the insert column grant                   -> test 5
 *   - drop `revoke all ... from anon, authenticated`            -> test 5
 *   - drop the (status, created_at) index                       -> test 6
 *   - drop the review query from the README                     -> test 7
 *   - drop 0005 from HUMAN-ACTIONS #116                         -> test 7
 *   - remove the #116 card from HUMAN-ACTIONS.md with no ledger line
 *                                                               -> test 7
 *   (and #116 closed in the ledger with its card gone passes test 7)
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SUPA = "backend/migrations/supabase";
const FILE = `${SUPA}/0005_content_reports.sql`;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sqlOnly = (src) => src.replace(/--[^\n]*/g, "");
const flat = (s) => s.replace(/\s+/g, " ");

const SQL = flat(sqlOnly(read(FILE)));
const UID = "\\(\\(select auth\\.uid\\(\\)\\) = user_id\\)";

/** Every `create policy` on content_reports in ANY supabase/ file: a later
    migration cannot widen the table without these tests seeing it. `as`,
    `for` and `to` are all optional in Postgres: no FOR means FOR ALL, no TO
    means TO PUBLIC, so a bare `... on public.content_reports using (true);`
    parses as verb "all", roles ["public"] and fails the role/verb checks.
    `raw` counts every `create policy` on the table however it is written, so
    a policy this parser cannot read still breaks `raw === parsed.length`. */
function policies() {
  const all = fs.readdirSync(path.join(ROOT, SUPA)).filter((n) => n.endsWith(".sql")).sort()
    .map((f) => flat(sqlOnly(read(`${SUPA}/${f}`)))).join(" ");
  const raw = (all.match(/create policy \w+ on public\.content_reports\b/g) || []).length;
  const parsed = [...all.matchAll(/create policy (\w+) on public\.content_reports(?: as (permissive|restrictive))?(?: for (\w+))?(?: to ([\w, ]+?))? (using|with check) (\(.*?\))(?: with check \(.*?\))?;/g)]
    .map(([, name, as, verb, roles, clause, expr]) => ({
      name,
      as: as || "permissive",
      verb: verb || "all",
      roles: (roles || "public").split(/,\s*/).sort(),
      clause,
      expr,
    }));
  return Object.assign(parsed, { raw });
}

test("the table: owner, target, reasons, a 280-character note, a status the founder sets", () => {
  const body = /create table if not exists public\.content_reports \((.*?)\); alter table/.exec(SQL);
  assert.ok(body, `${FILE}: create table public.content_reports is missing`);
  const cols = body[1];
  assert.match(cols, /id uuid primary key default gen_random_uuid\(\)/);
  assert.match(cols, /user_id uuid not null references auth\.users\(id\) on delete cascade/, "account deletion must take the reports with it");
  assert.match(cols, /created_at timestamptz not null default now\(\)/);
  assert.match(cols, /target_kind text not null check \(target_kind in \('foray', 'episode'\)\)/);
  assert.match(cols, /target_id text not null check \(char_length\(target_id\) <= 200\)/);
  assert.match(cols, /reasons text\[\] not null default '\{\}'/);
  const note = /note text check \(note is null or char_length\(note\) <= (\d+)\)/.exec(cols);
  assert.ok(note, "note must be nullable and length-capped");
  assert.strictEqual(note[1], "280", "the note cap is the Report sheet's maxlength (PH2-11)");
  assert.match(cols, /status text not null default 'open' check \(status in \('open', 'actioned', 'dismissed'\)\)/);
});

test("RLS is enabled on content_reports", () => {
  assert.match(SQL, /alter table public\.content_reports enable row level security;/);
});

test("insert-own and delete-own for authenticated; no update policy, no policy for anon, nothing for all", () => {
  const pol = policies();
  assert.strictEqual(pol.raw, pol.length, `${pol.raw} create policy statements on content_reports, but only ${pol.length} parse as name/for/to/using|with check: write any new one in that shape so these checks can see it`);
  for (const p of pol) {
    assert.deepStrictEqual(p.roles, ["authenticated"], `${p.name}: reports are for a signed-in owner only, never anon`);
    assert.ok(!["update", "all"].includes(p.verb), `${p.name}: no client changes a report (founder triage runs as postgres)`);
  }
  const ins = pol.filter((p) => p.verb === "insert");
  assert.strictEqual(ins.length, 1, "exactly one insert policy");
  assert.strictEqual(ins[0].name, "content_reports_insert_own");
  assert.strictEqual(ins[0].clause, "with check");
  assert.match(ins[0].expr, new RegExp(`^${UID}$`), "a listener files reports as itself only");
  const del = pol.filter((p) => p.verb === "delete");
  assert.strictEqual(del.length, 1, "exactly one delete policy");
  assert.strictEqual(del[0].name, "content_reports_delete_own");
  assert.strictEqual(del[0].clause, "using");
  assert.match(del[0].expr, new RegExp(`^${UID}$`), "a listener deletes its own reports only");
  assert.strictEqual(pol.length, 3, `expected insert-own, select-own, delete-own; got ${pol.map((p) => p.name).join(", ")}`);
});

test("select-own exists only for the filtered DELETE, and no client can read a report's contents", () => {
  /* The DELETE app.js sends filters on user_id, so Postgres applies SELECT
     policies to it: without select-own, Delete my data is a silent no-op. */
  const app = read("app.js");
  assert.match(app, /\/rest\/v1\/\$\{table\}\?user_id=eq\./, "sbDeleteOwnRows filters on user_id; if that changed, re-derive this policy");
  const sel = policies().filter((p) => p.verb === "select");
  assert.strictEqual(sel.length, 1, "exactly one select policy");
  assert.strictEqual(sel[0].name, "content_reports_select_own");
  assert.match(sel[0].expr, new RegExp(`^${UID}$`), "select-own sees the caller's rows only");
  /* ...and the column grants are what keep the contents unreadable. */
  const selGrants = [...SQL.matchAll(/grant select( \(([^)]*)\))? on public\.content_reports to ([\w, ]+);/g)];
  assert.strictEqual(selGrants.length, 1, "one select grant");
  assert.strictEqual(selGrants[0][2], "user_id", "a client may select user_id only: reasons, note, target and status stay unreadable");
  assert.strictEqual(selGrants[0][3], "authenticated");
});

test("column grants: a client inserts exactly the five fields it owns, deletes, and nothing else", () => {
  assert.match(SQL, /revoke all on public\.content_reports from anon, authenticated;/, "start from Supabase's default full grant and take it all back (TRUNCATE ignores RLS)");
  const ins = [...SQL.matchAll(/grant insert( \(([^)]*)\))? on public\.content_reports to ([\w, ]+);/g)];
  assert.strictEqual(ins.length, 1, "one insert grant");
  assert.deepStrictEqual(
    (ins[0][2] || "*").split(/,\s*/).sort(),
    ["note", "reasons", "target_id", "target_kind", "user_id"],
    "never status (a report filed as dismissed skips the review), created_at or id"
  );
  assert.strictEqual(ins[0][3], "authenticated");
  assert.match(SQL, /grant delete on public\.content_reports to authenticated;/);
  assert.doesNotMatch(SQL, /grant (all|update|truncate|references|trigger)\b[^;]* on public\.content_reports/);
  assert.doesNotMatch(SQL, /grant [^;]* on public\.content_reports to [^;]*\banon\b/, "anon gets nothing");
});

test("the daily review's index is on (status, created_at)", () => {
  assert.match(SQL, /create index if not exists \w+ on public\.content_reports \(status, created_at\);/);
});

test("the apply step and the review query are written down where a founder will find them", () => {
  const readme = read(`${SUPA}/README.md`);
  assert.match(readme, /\| `0005_content_reports\.sql` \|/, "README table row");
  assert.ok(
    readme.includes("select id, created_at, target_kind, target_id, reasons, note from public.content_reports where status = 'open' order by created_at;"),
    "README: the daily review query"
  );
  assert.match(flat(readme), /on delete cascade` removes a listener's reports/);
  /* HUMAN-ACTIONS #116 (apply the Supabase migrations) carries the 0005 apply
     step while it is open. When the founder replies `done` (or `skip`), the
     card leaves the open file for the ledger, so: an open #116 must still
     carry the steps; otherwise the ledger must record #116 as closed. Same
     shape as the #45 test in test/voice-probe-switch.test.js. */
  const ha = read("HUMAN-ACTIONS.md");
  const open = /^## #116 /m.exec(ha);
  if (open) {
    const rest = ha.slice(open.index + 1);
    const next = rest.search(/^## #/m);
    const item = next < 0 ? rest : rest.slice(0, next);
    assert.match(item, /backend\/migrations\/supabase\/0005_content_reports\.sql/, "#116 must carry the 0005 apply step");
    assert.match(item, /0004_rls_shows_catalog\.sql` is also unapplied/, "#116 must say 0004 is unapplied too (gate G2)");
  } else {
    const ledger = read("HUMAN-ACTIONS-DONE.md");
    assert.match(ledger, /^- #116 · \d{4}-\d{2}-\d{2} · (done|skip) · /m,
      "HUMAN-ACTIONS #116 left the open file, so the ledger must record it as closed");
  }
});
