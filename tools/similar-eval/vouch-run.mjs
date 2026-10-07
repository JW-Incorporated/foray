#!/usr/bin/env node
/* The "Shows 4a vouches for" eval runner (#560 item 8, the half #1042 left open).

   `app.js:showsWeVouchFor` feeds the "Shows 4a vouches for" row on #/shows
   (`vouchForHtml`). It is an editorial rotation, not a ranking: every show
   with a non-empty `editorial_note` is eligible, sorted by show_id, shuffled
   by an LCG seeded from the UTC calendar day, cut to `limit` (8). There is no
   seed show and no "right answer" per day, so this does not reuse
   ./eval-set.json. It measures the row over a fixed calendar year instead:

     (a) eligible set     shows that pass the editorial_note filter, over the
                          catalogue the client loads (data/catalog-client.json)
     (b) rotation         how many of those shows surface at least once in the
                          window, and how often each one does
     (c) row integrity    every row is `limit` distinct eligible shows, and the
                          same set all day (00:00 and 23:59 UTC agree); plus
                          the top-level taxonomy branches each row spans
     (d) Family Mode      slots filled by a show `familyAllows` rejects, in
                          the row a listener with Family Mode ON sees.
                          showsWeVouchFor filters with familyAllows (since
                          2026-10-06, #560), so this is 0; plus that row's own
                          eligible set, coverage and integrity (every slot
                          still fills)
     (e) label_scope      slots filled by a `label_scope: "general"` show
                          (showsWeVouchFor applies no label_scope filter)

   TWO RUNS, ONE PER MODE. (a), (b), (c) and (e) are measured with Family
   Mode OFF, the row most listeners see, over the whole curated catalogue;
   (d) is measured with it ON. One run cannot carry both: with the filter in
   place the ON row's eligible set is only the shows familyAllows passes, so
   coverage of the catalogue is a question for the OFF run.

   THE FUNCTIONS ARE app.js's OWN TEXT, NOT A MIRROR. Each declaration named in
   APP_DECLARATIONS is lifted out of app.js at run time and evaluated in a vm
   context, so an edit to app.js changes what this measures with no copy to
   update -- and then `--check` reports the committed block stale and the
   floors and ceilings in test/vouch-eval.test.js say whether the edit helped.
   The harness supplies only what app.js reads from outside those functions:
     state.catalog   data/catalog-client.json (app.js `fetchJson`)
     state.discover  data/discover.json (read by showHasExplicitEpisodes)
     state.session   null. With no session, showHasExplicitEpisodes reads
                     discover.items directly instead of fullPool(). That is
                     the same set of explicit-rated items, because
                     data/session.json's episodes carry no `explicit` key;
                     test/vouch-eval.test.js pins that, so the shortcut
                     cannot quietly diverge.
     familyMode()    returns false for the OFF run and true for the ON run;
                     the rejected set is always read with it true, since
                     (d) asks "what does Family Mode hide".

     node tools/similar-eval/vouch-run.mjs          rewrite the generated block
     node tools/similar-eval/vouch-run.mjs --check  exit 1 if the committed block is stale
     node tools/similar-eval/vouch-run.mjs --json   print the aggregates

   No network, no app boot. The block lives in
   docs/research/similar-shows-eval-2026-10.md, after the similarShows block
   (./run.mjs), between its own markers; each runner leaves the other's block
   alone. */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const APP_PATH = "app.js";
export const CATALOG_PATH = "data/catalog-client.json";
export const DISCOVER_PATH = "data/discover.json";
export const REPORT_PATH = "docs/research/similar-shows-eval-2026-10.md";
export const BEGIN = "<!-- BEGIN GENERATED: node tools/similar-eval/vouch-run.mjs -->";
export const END = "<!-- END GENERATED: vouch-run.mjs -->";

/** The window: one fixed calendar year of UTC days. Fixed, not "the next 365
 *  days", so the committed block does not go stale with the calendar. */
export const WINDOW_START = "2026-01-01";
export const WINDOW_DAYS = 365;

/** Every app.js top-level declaration the measurement runs, in the order they
 *  are evaluated. `function` entries are lifted from `function NAME(` to the
 *  closing column-0 brace; `let`/`const` entries are the single statement. */
export const APP_DECLARATIONS = [
  ["function", "dayOfYearSeed"],
  ["function", "seededShuffle"],
  ["function", "showsWeVouchFor"],
  ["const", "TITLE_ALIASES"],
  ["let", "catalogShowIndex"],
  ["function", "catalogShowForItem"],
  ["function", "branchOf"],
  ["function", "showIsComedy"],
  ["let", "explicitShowsIndex"],
  ["function", "showHasExplicitEpisodes"],
  ["function", "familySafe"],
  ["function", "familyAllows"],
];

function readText(rel, root) {
  return fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
}

function readJson(rel, root) {
  return JSON.parse(readText(rel, root));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One top-level declaration's source text out of app.js. Throws, naming the
 *  declaration, when it cannot be found: a renamed helper must stop the eval,
 *  never let it measure a stand-in. */
export function extractDeclaration(src, kind, name) {
  const n = escapeRe(name);
  const re =
    kind === "function"
      ? new RegExp(`^function ${n}\\([^\\n]*\\{\\n[\\s\\S]*?\\n\\}\\n`, "m")
      : kind === "const"
        ? new RegExp(`^const ${n} = \\{\\n[\\s\\S]*?\\n\\};\\n`, "m")
        : new RegExp(`^let ${n} = [^\\n]*;\\n`, "m");
  const m = re.exec(src);
  if (!m) throw new Error(`${APP_PATH}: top-level ${kind} ${name} could not be located`);
  return m[0];
}

/** The vm-evaluated app.js functions, bound to `catalog` / `discover`, with
 *  Family Mode ON or OFF (`familyMode`, default ON). */
export function loadAppFunctions(appSource, catalog, discover, { familyMode = true } = {}) {
  const body = APP_DECLARATIONS.map(([kind, name]) => extractDeclaration(appSource, kind, name)).join("\n");
  const ctx = vm.createContext({ state: { catalog, discover, session: null } });
  return vm.runInContext(
    `function familyMode() { return ${familyMode === true}; }\n${body}\n({ showsWeVouchFor, familyAllows });`,
    ctx
  );
}

/** UTC midnight of day `i` of the window, as a Date. */
export function windowDay(i, start = WINDOW_START) {
  const [y, m, d] = start.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + i));
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const branchesOf = (show) => new Set((show.taxonomy_node_ids || []).map((n) => String(n).split("/")[0]));

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Why `familyAllows` rejects a catalogue show. The count comes from app.js;
 *  this only labels it, in familySafe's own order. */
export function familyReason(show) {
  if (show.explicit === true) return "rated explicit";
  if (branchesOf(show).has("comedy")) return "comedy branch";
  if (show.explicit !== false) return "unrated";
  return "other";
}

/**
 * Pure aggregation. `catalog` is the parsed client catalogue, `eligibleIds`
 * the shows that pass the row's own filter, `rows` an array of
 * `{ date, ids, lateIds }` (lateIds: the same day's row at 23:59 UTC),
 * `limit` the row's slot count, `unsafeIds` the shows familyAllows rejects.
 */
export function measureRows({ catalog, eligibleIds, rows, limit, unsafeIds }) {
  const byId = new Map(catalog.shows.map((s) => [s.show_id, s]));
  const eligible = new Set(eligibleIds);
  const unsafe = new Set(unsafeIds);
  const general = new Set(catalog.shows.filter((s) => s.label_scope === "general").map((s) => s.show_id));
  const appearances = new Map(eligibleIds.map((id) => [id, 0]));
  const integrity = { shortRows: [], duplicateRows: [], ineligibleRows: [], unstableDays: [] };
  const distinctBranches = [];
  const sameBranchMax = [];
  const family = { slots: 0, daysWithAny: 0, maxInOneRow: 0, shown: new Set() };
  const scope = { slots: 0, daysWithAny: 0, maxInOneRow: 0, shown: new Set() };

  for (const row of rows) {
    const { date, ids } = row;
    if (ids.length !== limit) integrity.shortRows.push(date);
    if (new Set(ids).size !== ids.length) integrity.duplicateRows.push(date);
    if (ids.some((id) => !eligible.has(id))) integrity.ineligibleRows.push(date);
    if (row.lateIds && row.lateIds.join("\n") !== ids.join("\n")) integrity.unstableDays.push(date);
    for (const id of ids) appearances.set(id, (appearances.get(id) || 0) + 1);

    const perBranch = new Map();
    for (const id of ids) for (const b of branchesOf(byId.get(id) || {})) perBranch.set(b, (perBranch.get(b) || 0) + 1);
    distinctBranches.push(perBranch.size);
    sameBranchMax.push(Math.max(0, ...perBranch.values()));

    for (const [acc, set] of [
      [family, unsafe],
      [scope, general],
    ]) {
      const hit = ids.filter((id) => set.has(id));
      acc.slots += hit.length;
      if (hit.length) acc.daysWithAny += 1;
      acc.maxInOneRow = Math.max(acc.maxInOneRow, hit.length);
      for (const id of hit) acc.shown.add(id);
    }
  }

  const counts = eligibleIds.map((id) => appearances.get(id));
  /* The first tenth of the eligible set in show_id (codepoint) order, the
     order the row sorts by before it shuffles. A uniform rotation gives it
     about a tenth of the slots. */
  const decile = eligibleIds.slice().sort().slice(0, Math.ceil(eligibleIds.length / 10));
  const decileSlots = decile.reduce((n, id) => n + appearances.get(id), 0);
  const finish = (acc, pool) => ({
    catalogueShows: pool.length,
    catalogueIds: pool,
    slots: acc.slots,
    slotShare: rows.length ? acc.slots / (rows.length * limit) : null,
    daysWithAny: acc.daysWithAny,
    maxInOneRow: acc.maxInOneRow,
    distinctShown: acc.shown.size,
  });
  return {
    days: rows.length,
    limit,
    catalogueShows: catalog.shows.length,
    eligible: eligibleIds.length,
    coverage: {
      surfaced: counts.filter((c) => c > 0).length,
      ratio: eligibleIds.length ? counts.filter((c) => c > 0).length / eligibleIds.length : null,
      never: eligibleIds.filter((id) => appearances.get(id) === 0),
      min: counts.length ? Math.min(...counts) : null,
      median: median(counts),
      max: counts.length ? Math.max(...counts) : null,
      expected: eligibleIds.length ? (rows.length * limit) / eligibleIds.length : null,
      firstDecileShows: decile.length,
      firstDecileShare: rows.length ? decileSlots / (rows.length * limit) : null,
      appearances: Object.fromEntries(eligibleIds.map((id) => [id, appearances.get(id)])),
    },
    integrity,
    branches: {
      meanDistinct: distinctBranches.length ? distinctBranches.reduce((a, b) => a + b, 0) / distinctBranches.length : null,
      minDistinct: distinctBranches.length ? Math.min(...distinctBranches) : null,
      maxSameBranch: sameBranchMax.length ? Math.max(...sameBranchMax) : null,
    },
    family: finish(family, [...unsafe].filter((id) => eligible.has(id)).sort()),
    scope: finish(scope, [...general].filter((id) => eligible.has(id)).sort()),
  };
}

/** The row over the window, in one Family Mode setting: its rows, its
 *  eligible set and its slot count, all read off the row itself. */
function runMode({ showsWeVouchFor }, catalog, days, start) {
  /* The row's own default limit: vouchForHtml calls showsWeVouchFor() with
     no arguments, so the eval passes `undefined` and measures what renders. */
  const ids = (date) => Array.from(showsWeVouchFor(undefined, date), (s) => s.show_id);
  const rows = [];
  for (let i = 0; i < days; i++) {
    const date = windowDay(i, start);
    const late = new Date(date.getTime() + 24 * 3600 * 1000 - 60 * 1000); // 23:59 UTC, same day
    rows.push({ date: isoDay(date), ids: ids(date), lateIds: ids(late) });
  }
  /* Eligibility is read off the row itself, not re-implemented: a limit as
     large as the catalogue returns every show that passes its filters. */
  const eligibleIds = Array.from(showsWeVouchFor(catalog.shows.length + 1, windowDay(0, start)), (s) => s.show_id).sort();
  const limit = Array.from(showsWeVouchFor(undefined, windowDay(0, start))).length;
  return { rows, eligibleIds, limit };
}

/** Load the committed inputs and measure the shipped row over the window,
 *  once with Family Mode OFF ((a)-(c), (e)) and once with it ON ((d)). */
export function runVouchEval(root = ROOT, { days = WINDOW_DAYS, start = WINDOW_START } = {}) {
  const catalog = readJson(CATALOG_PATH, root);
  const discover = readJson(DISCOVER_PATH, root);
  const src = readText(APP_PATH, root);
  const offFns = loadAppFunctions(src, catalog, discover, { familyMode: false });
  const onFns = loadAppFunctions(src, catalog, discover, { familyMode: true });
  const unsafeIds = catalog.shows.filter((s) => !onFns.familyAllows(s)).map((s) => s.show_id);
  const off = runMode(offFns, catalog, days, start);
  const on = runMode(onFns, catalog, days, start);
  const result = measureRows({ catalog, eligibleIds: off.eligibleIds, rows: off.rows, limit: off.limit, unsafeIds });
  const fm = measureRows({ catalog, eligibleIds: on.eligibleIds, rows: on.rows, limit: on.limit, unsafeIds });
  /* (d): the rejected shows are the catalogue's (the OFF run's pool); the
     violations are what the ON row actually shows. */
  result.family = {
    ...result.family,
    slots: fm.family.slots,
    slotShare: fm.family.slotShare,
    daysWithAny: fm.family.daysWithAny,
    maxInOneRow: fm.family.maxInOneRow,
    distinctShown: fm.family.distinctShown,
  };
  const { appearances: onAppearances, ...onCoverage } = fm.coverage;
  result.familyOn = {
    limit: fm.limit,
    eligible: fm.eligible,
    coverage: onCoverage,
    appearances: onAppearances,
    integrity: fm.integrity,
    branches: fm.branches,
    /* Per rejected show, the days the ON row showed it anyway (read off
       the rows: the ON coverage counts only its own eligible set). */
    unsafeDays: Object.fromEntries(
      result.family.catalogueIds.map((id) => [id, on.rows.filter((row) => row.ids.includes(id)).length])
    ),
  };
  const byId = new Map(catalog.shows.map((s) => [s.show_id, s]));
  result.family.byReason = {};
  for (const id of result.family.catalogueIds) {
    const r = familyReason(byId.get(id));
    result.family.byReason[r] = (result.family.byReason[r] || 0) + 1;
  }
  result.window = { start, days, end: isoDay(windowDay(days - 1, start)) };
  result.rows = off.rows.map(({ date, ids: dayIds }) => ({ date, ids: dayIds }));
  result.familyRows = on.rows.map(({ date, ids: dayIds }) => ({ date, ids: dayIds }));
  return result;
}

const f3 = (x) => (x === null ? "n/a" : x.toFixed(3));
const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const list = (ids) => (ids.length ? ids.map((id) => `\`${id}\``).join(", ") : "none");

/** The generated block's body (without the markers), deterministic. */
export function renderSection(r, catalog) {
  const byId = new Map(catalog.shows.map((s) => [s.show_id, s]));
  const out = [];
  out.push(
    `Window: ${r.window.start} to ${r.window.end} (${r.days} UTC days), ${r.limit} slots a day (showsWeVouchFor's default limit), ${r.days * r.limit} slots in all. Two runs: (a), (b), (c) and (e) with Family Mode OFF, (d) with it ON, through app.js's own \`familyAllows\`.`
  );
  const on = r.familyOn;
  out.push("");
  out.push("| Metric | Measured |");
  out.push("|---|---|");
  out.push(`| (a) eligible: shows with a non-empty \`editorial_note\` | ${r.eligible} of ${r.catalogueShows} (the whole curated catalogue) |`);
  out.push(`| (b) rotation coverage: eligible shows surfaced at least once | ${r.coverage.surfaced} of ${r.eligible} (${f3(r.coverage.ratio)}) |`);
  out.push(
    `| (b) appearances per show: min / median / max (expected ${r.coverage.expected === null ? "n/a" : r.coverage.expected.toFixed(2)}) | ${r.coverage.min} / ${r.coverage.median} / ${r.coverage.max} |`
  );
  out.push(
    `| (b) slots taken by the first ${r.coverage.firstDecileShows} shows in show_id order (a tenth of the eligible set) | ${pct(r.coverage.firstDecileShare)} |`
  );
  out.push(
    `| (c) rows that are not ${r.limit} distinct eligible shows | ${r.integrity.shortRows.length + r.integrity.duplicateRows.length + r.integrity.ineligibleRows.length} |`
  );
  out.push(`| (c) days whose 00:00 and 23:59 UTC rows differ | ${r.integrity.unstableDays.length} |`);
  out.push(
    `| (c) top-level branches per row: mean / min; most slots one branch takes | ${f3(r.branches.meanDistinct)} / ${r.branches.minDistinct}; ${r.branches.maxSameBranch} |`
  );
  out.push(
    `| (d) Family Mode violations: slots filled by a show familyAllows rejects | ${r.family.slots} (${pct(r.family.slotShare)}), on ${r.family.daysWithAny} of ${r.days} days, at most ${r.family.maxInOneRow} in one row |`
  );
  out.push(`| (d) catalogue shows familyAllows rejects / of them surfaced with Family Mode ON | ${r.family.catalogueShows} / ${r.family.distinctShown} |`);
  out.push(`| (d) Family Mode ON: eligible shows / surfaced at least once | ${on.eligible} / ${on.coverage.surfaced} (${f3(on.coverage.ratio)}) |`);
  out.push(
    `| (d) Family Mode ON: appearances per show, min / median / max (expected ${on.coverage.expected === null ? "n/a" : on.coverage.expected.toFixed(2)}); first ${on.coverage.firstDecileShows} shows' share | ${on.coverage.min} / ${on.coverage.median} / ${on.coverage.max}; ${pct(on.coverage.firstDecileShare)} |`
  );
  out.push(
    `| (d) Family Mode ON: rows that are not ${on.limit} distinct eligible shows; days whose 00:00 and 23:59 UTC rows differ | ${on.integrity.shortRows.length + on.integrity.duplicateRows.length + on.integrity.ineligibleRows.length}; ${on.integrity.unstableDays.length} |`
  );
  out.push(
    `| (e) label_scope leakage: slots filled by a \`label_scope: "general"\` show | ${r.scope.slots} (${pct(r.scope.slotShare)}), on ${r.scope.daysWithAny} of ${r.days} days, at most ${r.scope.maxInOneRow} in one row |`
  );
  out.push(`| (e) \`label_scope: "general"\` shows / of them surfaced | ${r.scope.catalogueShows} / ${r.scope.distinctShown} |`);
  out.push("");
  out.push("### (d) The shows Family Mode hides, and how often each row shows them");
  out.push("");
  const reasons = Object.entries(r.family.byReason).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  out.push(`By familySafe's reason: ${reasons.map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  out.push("");
  out.push("| Show | Reason | `explicit` | Days in the row, Family Mode OFF | Days, Family Mode ON |");
  out.push("|---|---|:-:|---:|---:|");
  for (const id of r.family.catalogueIds) {
    const s = byId.get(id);
    out.push(`| \`${id}\` | ${familyReason(s)} | ${String(s.explicit)} | ${r.coverage.appearances[id]} | ${on.unsafeDays[id]} |`);
  }
  out.push("");
  out.push('### (e) The `label_scope: "general"` shows, and how often the row shows them');
  out.push("");
  out.push("| Show | Days in the row |");
  out.push("|---|---:|");
  for (const id of r.scope.catalogueIds) out.push(`| \`${id}\` | ${r.coverage.appearances[id]} |`);
  out.push("");
  out.push("### (b) Rotation extremes");
  out.push("");
  out.push(`**Never surfaced in the window:** ${list(r.coverage.never)}`);
  out.push("");
  const at = (n) => Object.keys(r.coverage.appearances).filter((id) => r.coverage.appearances[id] === n);
  out.push(`**Fewest days (${r.coverage.min}):** ${list(at(r.coverage.min))}`);
  out.push("");
  out.push(`**Most days (${r.coverage.max}):** ${list(at(r.coverage.max))}`);
  out.push("");
  out.push("### The first seven rows of the window");
  out.push("");
  out.push("| Day | Family Mode | Shows |");
  out.push("|---|---|---|");
  r.rows.slice(0, 7).forEach((row, i) => {
    out.push(`| ${row.date} | off | ${list(row.ids)} |`);
    out.push(`| ${row.date} | on | ${list(r.familyRows[i].ids)} |`);
  });
  return out.join("\n");
}

/** `text` with the vouch block replaced by `section`. Throws if the markers
 *  are missing. Searches END only after BEGIN, so the similarShows block's
 *  own markers, earlier in the file, are never touched. */
export function spliceReport(text, section) {
  const norm = text.replace(/\r\n/g, "\n");
  const a = norm.indexOf(BEGIN);
  const b = a < 0 ? -1 : norm.indexOf(END, a + BEGIN.length);
  if (a < 0 || b < 0) throw new Error(`${REPORT_PATH} has lost its vouch GENERATED markers`);
  return norm.slice(0, a + BEGIN.length) + "\n" + section + "\n" + norm.slice(b);
}

function freshReport(root) {
  const text = readText(REPORT_PATH, root);
  return { text, next: spliceReport(text, renderSection(runVouchEval(root), readJson(CATALOG_PATH, root))) };
}

/** True when the committed report's vouch block matches a fresh run. */
export function reportIsCurrent(root = ROOT) {
  const { text, next } = freshReport(root);
  return next === text;
}

function main(argv) {
  if (argv.includes("--json")) {
    const r = runVouchEval();
    const { rows, familyRows, ...rest } = r;
    delete rest.coverage.appearances;
    delete rest.familyOn.appearances;
    console.log(JSON.stringify(rest, null, 2));
    return 0;
  }
  if (argv.includes("--check")) {
    if (reportIsCurrent()) {
      console.log(`${REPORT_PATH}: vouch generated block is current`);
      return 0;
    }
    console.error(`${REPORT_PATH}: vouch generated block is STALE -- run node tools/similar-eval/vouch-run.mjs`);
    return 1;
  }
  fs.writeFileSync(path.join(ROOT, REPORT_PATH), freshReport(ROOT).next);
  console.log(`wrote ${REPORT_PATH}`);
  return 0;
}

/* `pathToFileURL`, never a `file://${argv[1]}` template -- see
   tools/entrypoint-guards.test.mjs for the Windows failure that idiom causes. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
