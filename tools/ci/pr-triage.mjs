#!/usr/bin/env node
/* PR triage: the silently-stuck class, and the batched founder queue.
 *
 * WHY THIS FILE EXISTS (measured on 2026-08-15/16, not hypothetical)
 *
 *   #173 sat CONFLICTING/DIRTY for hours and never merged. GitHub's auto-merge
 *   only acts on a MERGEABLE PR, so a dirty PR is silently indistinguishable
 *   from one still waiting on checks: same "Auto-merge enabled" badge, same
 *   pending look, no notification, no red check. It was only fixed because a
 *   human went looking. Nothing in the repo would ever have said so.
 *
 *   Separately, a branch that falls behind `main` can re-block after its checks
 *   have already passed — most often by becoming conflicting when another
 *   content PR lands on the same generated JSON.
 *
 * So this module plans two kinds of action per PR:
 *   - BEHIND and mergeable  -> update the branch from `main`, then re-run CI on
 *     the new head (see the dispatch note below).
 *   - CONFLICTING           -> label it, and say so ONCE.
 *
 * EXACTLY ONE COMMENT. EVER. The comment carries a marker
 * (CONFLICT_MARKER) and the planner refuses to plan a second one if any
 * existing comment contains it. A bot that comments every sweep is the same
 * disease as the self-armed check-in loops CLAUDE.md § Never babysit your own
 * PR was written to kill — ~69% of all scheduled agent token spend in Swift2 —
 * and "it is only a comment" is exactly how that started. The LABEL is the
 * live signal: it appears and disappears on its own with no further noise.
 *
 * WHY THE CI RE-DISPATCH IS NOT OPTIONAL. Updating a branch changes the PR's
 * head SHA, and `protect-main`'s required checks (`backend`, `data-and-site`)
 * are matched against THAT SHA. Pushes made with the automatic GITHUB_TOKEN do
 * not create new workflow runs — a deliberate GitHub anti-recursion rule — so
 * an auto-updated PR would sit forever with "Expected — waiting for status to
 * be reported", i.e. this fix would have manufactured the exact silent stall it
 * exists to remove. `workflow_dispatch` and `repository_dispatch` are the two
 * documented exceptions to that rule, which is why `ci.yml` gained a
 * `workflow_dispatch` trigger in the same change and why every `update-branch`
 * action below is paired with a `dispatch-ci` action.
 *
 * THE BATCHED FOUNDER QUEUE (item 5)
 * Anything that still needs a human collects under one label
 * (`needs-founder`), applied and removed automatically from the same
 * path-policy decision the auto-merge path uses, and renders as a
 * marker-delimited block in `HUMAN-ACTIONS.md`. Set semantics make it
 * idempotent: re-running produces the same labels and byte-identical markdown,
 * so there is no duplicate-entry failure mode to guard against.
 *
 * HONEST LIMIT ON WRITING THAT FILE. The scheduled workflow cannot commit the
 * refreshed block to `main` itself: `main` is protected with zero bypass, and a
 * PR opened with GITHUB_TOKEN does not trigger `pull_request` workflows, so its
 * required checks would never run and it could never merge. Adding a PAT to fix
 * that would break "this repo's cloud automation is deliberately keyless"
 * (CLAUDE.md, decision-authority item 2), which is not a trade worth making for
 * a list. So: the workflow renders the block into its run summary every sweep
 * (always current), and any session refreshes the committed copy with
 * `node tools/ci/pr-triage.mjs waiting --write` — which now auto-merges,
 * because HUMAN-ACTIONS.md was added to ALLOWED_PREFIXES in the same change.
 *
 * Every decision here is a pure function over plain data. The workflow does the
 * `gh` calls and executes the planned actions; nothing in this file talks to a
 * network. That is what makes it testable, and it is the split that the YAML
 * heredoc version made impossible.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { automergeDecision, FOUNDER_QUEUE_LABEL } from "./path-policy.mjs";

export const CONFLICT_LABEL = "merge-conflict";
export const CONFLICT_MARKER = "<!-- foray:pr-triage:merge-conflict -->";
export const QUEUE_LABEL = FOUNDER_QUEUE_LABEL;

/* The block in HUMAN-ACTIONS.md that this module owns end to end. Anything
 * between these two markers is generated; anything outside them is a human's.
 * Replacing between markers is what makes a re-run idempotent instead of
 * appending a second copy of the list every time. */
export const BLOCK_BEGIN = "<!-- BEGIN generated:waiting-on-you -->";
export const BLOCK_END = "<!-- END generated:waiting-on-you -->";

/* ------------------------------------------------------------- normalising */

/* GitHub reports mergeability in two vocabularies and this repo's evidence
 * mentions both (#173 was "CONFLICTING/DIRTY"):
 *   GraphQL (`gh pr view`):  mergeable = MERGEABLE|CONFLICTING|UNKNOWN,
 *                            mergeStateStatus = CLEAN|BEHIND|DIRTY|BLOCKED|...
 *   REST (`gh api .../pulls/N`): mergeable = true|false|null,
 *                            mergeable_state = clean|behind|dirty|blocked|...
 * The workflow uses REST (no GraphQL scope needed, works on a read-only token),
 * but accepting both means a future caller cannot get this subtly wrong. */
const MERGEABLE_FROM_BOOL = { true: "MERGEABLE", false: "CONFLICTING" };

/** One PR, from either API shape, as the flat record every planner takes. */
export function normalizePr(raw = {}) {
  const labels = (raw.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);

  let mergeable = raw.mergeable;
  if (typeof mergeable === "boolean") mergeable = MERGEABLE_FROM_BOOL[String(mergeable)];
  if (mergeable === null || mergeable === undefined || mergeable === "") mergeable = "UNKNOWN";
  mergeable = String(mergeable).toUpperCase();

  const state = String(
    raw.state ?? raw.mergeStateStatus ?? raw.mergeable_state ?? "unknown"
  ).toLowerCase();

  return {
    number: Number(raw.number),
    title: raw.title ?? "",
    url: raw.url ?? raw.html_url ?? "",
    headRefName: raw.headRefName ?? raw.head?.ref ?? "",
    baseRefName: raw.baseRefName ?? raw.base?.ref ?? "",
    draft: Boolean(raw.draft ?? raw.isDraft),
    crossRepo: Boolean(
      raw.crossRepo ?? raw.isCrossRepository ?? (raw.head?.repo?.full_name && raw.base?.repo?.full_name
        ? raw.head.repo.full_name !== raw.base.repo.full_name
        : false)
    ),
    mergeable,
    state,
    labels,
    files: raw.files ?? [],
    comments: raw.comments ?? [],
    author: raw.author?.login ?? raw.user?.login ?? "",
    createdAt: raw.createdAt ?? raw.created_at ?? null,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? null,
  };
}

/** True if this bot has already said "you are conflicting" on this PR. */
export function hasConflictComment(pr) {
  return (pr.comments ?? []).some((c) =>
    String(typeof c === "string" ? c : (c.body ?? "")).includes(CONFLICT_MARKER)
  );
}

/** The one comment. Written once, never repeated, and it says so. */
export function conflictComment(pr) {
  return [
    CONFLICT_MARKER,
    `**This PR conflicts with \`main\` and cannot merge as it stands.**`,
    "",
    "Auto-merge only acts on a mergeable PR, so a conflicting one looks exactly " +
      "like one still waiting on checks — same badge, no red check, no " +
      "notification. PR #173 sat that way for hours on 2026-08-16 and was only " +
      "found because a human went looking. This comment exists so that cannot " +
      "happen quietly again.",
    "",
    `Merge \`main\` in (or rebase) and push. The \`${CONFLICT_LABEL}\` label ` +
      "clears itself on the next hygiene sweep, and if the branch is merely " +
      "behind rather than conflicting it gets updated automatically.",
    "",
    "**This is the only comment this bot will post about it.** The label is the " +
      "live signal; it appears and disappears on its own. Nothing here polls, " +
      "re-comments or wakes up to check on you (CLAUDE.md § Never babysit your " +
      "own PR).",
  ].join("\n");
}

/* ---------------------------------------------------------------- planning */

/**
 * Actions to keep PRs mergeable, and to alert on the ones that are not.
 *
 * -> { actions: [...], notes: [string] }
 *
 * Action kinds, all idempotent by construction (a label already present is not
 * re-added; a comment already posted is not re-posted):
 *   { kind: "add-label",    pr, label }
 *   { kind: "remove-label", pr, label }
 *   { kind: "comment",      pr, body }
 *   { kind: "update-branch",pr }
 *   { kind: "dispatch-ci",  pr, ref }   always paired with update-branch
 */
export function planMergeability(prs, opts = {}) {
  const { autoUpdate = true } = opts;
  const actions = [];
  const notes = [];

  for (const raw of prs ?? []) {
    const pr = normalizePr(raw);
    if (pr.draft) {
      notes.push(`#${pr.number}: draft — skipped`);
      continue;
    }
    if (pr.baseRefName && pr.baseRefName !== "main") {
      notes.push(`#${pr.number}: targets ${pr.baseRefName}, not main — skipped`);
      continue;
    }

    const labelled = pr.labels.includes(CONFLICT_LABEL);

    if (pr.mergeable === "CONFLICTING" || pr.state === "dirty") {
      if (!labelled) actions.push({ kind: "add-label", pr: pr.number, label: CONFLICT_LABEL });
      if (!hasConflictComment(pr)) {
        actions.push({ kind: "comment", pr: pr.number, body: conflictComment(pr) });
      } else {
        notes.push(`#${pr.number}: conflicting, already told once — label only`);
      }
      continue;
    }

    if (pr.mergeable === "UNKNOWN") {
      // GitHub computes mergeability asynchronously, so UNKNOWN right after a
      // push is normal and means "ask again", not "fine". Doing nothing is the
      // fail-safe choice: the next sweep sees the settled value. Guessing
      // MERGEABLE here would auto-update a branch that is actually conflicting.
      notes.push(`#${pr.number}: mergeability not computed yet — will re-check next sweep`);
      continue;
    }

    if (labelled) actions.push({ kind: "remove-label", pr: pr.number, label: CONFLICT_LABEL });

    // WHEN THIS ACTUALLY FIRES, which is worth knowing before you debug its
    // silence. GitHub reports `behind` only when being behind BLOCKS the merge
    // — i.e. when the branch ruleset requires branches to be up to date. As of
    // 2026-08-16 `protect-main` has `strict_required_status_checks_policy:
    // false`, so a behind-but-clean PR reads `clean` and merges on its own, and
    // this branch is correctly quiet.
    //
    // That is deliberate, not an oversight. Detecting behind-ness ourselves
    // (via the compare API) and updating regardless would re-run full CI —
    // including the macOS `ios-kit` job — on every open PR every time anything
    // lands on `main`, and would reset the green checks of PRs that were about
    // to merge. The cost is real and the benefit today is nil: the conflict
    // path below already catches the case that actually bit us (#173), because
    // a stale branch's failure mode here is a CONFLICT, not staleness.
    //
    // The moment `strict` is turned on — or a merge queue is enabled — being
    // behind starts blocking, GitHub starts reporting `behind`, and this fires
    // without anyone editing it.
    if (pr.state === "behind") {
      if (!autoUpdate) {
        notes.push(`#${pr.number}: behind main — auto-update disabled`);
      } else if (pr.crossRepo) {
        // A fork's head branch is not ours to push to.
        notes.push(`#${pr.number}: behind main but the head is on a fork — cannot update`);
      } else if (pr.labels.includes("hold")) {
        // `hold` means a human is mid-thought on this branch. Rewriting their
        // branch under them is the wrong kind of helpful.
        notes.push(`#${pr.number}: behind main but held — leaving the branch alone`);
      } else {
        actions.push({ kind: "update-branch", pr: pr.number });
        // Required checks live on the head SHA and GITHUB_TOKEN pushes do not
        // trigger workflows. Without this, updating the branch replaces a green
        // PR with one whose checks never report. See the header.
        actions.push({ kind: "dispatch-ci", pr: pr.number, ref: pr.headRefName });
      }
    }
  }
  return { actions, notes };
}

/**
 * Who still needs a founder, and why — from the same decision the auto-merge
 * path makes, so the queue cannot disagree with the gate.
 *
 * -> { queue: [{ number, title, url, reason, code, labels, updatedAt }],
 *      actions: [...] }
 */
export function planFounderQueue(prs, opts = {}) {
  const { freeze = "" } = opts;
  const queue = [];
  const actions = [];

  for (const raw of prs ?? []) {
    const pr = normalizePr(raw);
    if (pr.draft) continue;
    if (pr.baseRefName && pr.baseRefName !== "main") continue;

    const decision = automergeDecision({
      files: pr.files,
      labels: pr.labels,
      freeze,
      baseRef: pr.baseRefName || "main",
    });

    // A conflicting PR needs its AUTHOR, not a founder: the label and the one
    // comment are the whole alert, and putting it in the founder queue would
    // hand a human a task that resolving takes a git command.
    const conflicting = pr.mergeable === "CONFLICTING" || pr.state === "dirty";
    const wanted = decision.needsFounder && !conflicting;
    const labelled = pr.labels.includes(QUEUE_LABEL);

    if (wanted) {
      queue.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        reason: decision.reason,
        code: decision.code,
        labels: pr.labels,
        updatedAt: pr.updatedAt,
      });
      if (!labelled) actions.push({ kind: "add-label", pr: pr.number, label: QUEUE_LABEL });
    } else if (labelled) {
      actions.push({ kind: "remove-label", pr: pr.number, label: QUEUE_LABEL });
    }
  }
  queue.sort((a, b) => a.number - b.number);
  return { queue, actions };
}

/** Both planners, one call. Actions are deduplicated and ordered stably. */
export function planTriage(prs, opts = {}) {
  const m = planMergeability(prs, opts);
  const q = planFounderQueue(prs, opts);
  const seen = new Set();
  const actions = [...m.actions, ...q.actions].filter((a) => {
    const key = `${a.kind}:${a.pr}:${a.label ?? a.ref ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { actions, notes: m.notes, queue: q.queue };
}

/* --------------------------------------------------------------- rendering */

/**
 * The "waiting on you" block. Byte-identical for identical input — no
 * timestamp, no run number, nothing that changes on a re-run — because a block
 * that always differs produces a commit every sweep and teaches everyone to
 * ignore it.
 */
export function renderWaitingBlock(queue, opts = {}) {
  const { repo = "JW-Incorporated/foray", queueLabel = QUEUE_LABEL } = opts;
  const filter = `https://github.com/${repo}/pulls?q=is%3Apr+is%3Aopen+label%3A${encodeURIComponent(queueLabel)}`;
  const lines = [
    BLOCK_BEGIN,
    "",
    "### Waiting on a founder (auto-maintained)",
    "",
    `Generated by \`node tools/ci/pr-triage.mjs waiting --write\`, and re-rendered`,
    `into the run summary of \`.github/workflows/pr-hygiene.yml\` on every sweep.`,
    `Live, always-current view: <${filter}>`,
    "",
    "Everything the merge machinery could not land on its own ends up here, so",
    "the residue is one batched glance instead of something anyone has to notice.",
    "",
  ];
  if (!queue.length) {
    lines.push("**Nothing is waiting on a founder right now.**", "");
  } else {
    lines.push("| PR | What it is | Why it needs you |", "| --- | --- | --- |");
    for (const item of queue) {
      const link = item.url ? `[#${item.number}](${item.url})` : `#${item.number}`;
      lines.push(`| ${link} | ${cell(item.title)} | ${cell(item.reason)} |`);
    }
    lines.push("");
    lines.push(
      "To let a whole category of these merge unread instead, add its path to",
      "`ALLOWED_PREFIXES` in `tools/ci/path-policy.mjs` — that is what #167/#168",
      "did for `STATE.md`, and it converts a recurring merge into a one-line diff.",
      ""
    );
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/** Make one line of text safe inside a markdown table cell. */
function cell(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Put `block` into `text`, replacing any previous copy.
 *
 * Idempotent by markers, not by diffing: splice(splice(t, b), b) === splice(t, b).
 * If the markers are absent the block is appended, so a hand-deleted block
 * comes back rather than silently staying gone. A file with a BEGIN and no END
 * (someone edited inside the block) is a hard error — guessing where the
 * generated region stops would eat their edit.
 */
export function spliceBlock(text, block) {
  const src = String(text ?? "");
  const start = src.indexOf(BLOCK_BEGIN);
  const end = src.indexOf(BLOCK_END);
  if (start === -1 && end === -1) {
    const sep = src === "" || src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : "\n\n";
    return `${src}${sep}${block}\n`;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `HUMAN-ACTIONS.md has an unbalanced generated block (BEGIN at ${start}, END at ${end}). ` +
        `Restore both markers — refusing to guess where the generated region ends.`
    );
  }
  return src.slice(0, start) + block + src.slice(end + BLOCK_END.length);
}

/* ------------------------------------------------------- gathering via gh */

/**
 * Read open PRs with the `gh` CLI.
 *
 * The workflow gathers in YAML and passes `--from`; this exists so the command
 * HUMAN-ACTIONS.md tells a session to run —
 * `node tools/ci/pr-triage.mjs waiting --write` — actually works on its own.
 * Without it, omitting `--from` would render an EMPTY queue and cheerfully
 * commit "nothing is waiting on a founder" over a real list. A refresher that
 * silently blanks the thing it refreshes is worse than no refresher.
 *
 * `exec` is injected so the shape of every call is pinned by tests without
 * spawning anything.
 */
export function gatherPrs(opts = {}) {
  const { repo, exec = defaultExec } = opts;

  const owner = repo || exec(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  if (!owner) throw new Error("could not determine the repository — pass --repo owner/name");

  const numbers = exec(["pr", "list", "--repo", owner, "--state", "open", "--limit", "100", "--json", "number", "--jq", ".[].number"])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  return numbers.map((n) => {
    const pr = JSON.parse(exec(["api", `repos/${owner}/pulls/${n}`]));
    // One JSON array per page, so parse per line and concatenate rather than
    // trusting a single document.
    const pages = (out) =>
      out
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .flatMap((l) => JSON.parse(l));
    pr.files = pages(exec(["api", "--paginate", `repos/${owner}/pulls/${n}/files`, "--jq", "[.[].filename]"]));
    pr.comments = pages(exec(["api", "--paginate", `repos/${owner}/issues/${n}/comments`, "--jq", "[.[].body]"]));
    return pr;
  });
}

function defaultExec(args) {
  const res = spawnSync(process.platform === "win32" ? "gh.exe" : "gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run gh: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${res.stderr?.trim()}`);
  return res.stdout ?? "";
}

/* --------------------------------------------------------------------- CLI */

const USAGE = `usage:
  node tools/ci/pr-triage.mjs plan    --from <prs.json> [options]
  node tools/ci/pr-triage.mjs waiting --from <prs.json> [--write|--print]

options:
  --from <path|->        PRs as a JSON array ("-" = stdin). Accepts the shape of
                        \`gh api repos/:owner/:repo/pulls\` with \`files\`,
                        \`labels\` and \`comments\` attached. OMIT IT to read the
                        open PRs with \`gh\` instead — never to mean "none".
  --freeze <value>       AUTOMERGE_FREEZE repo variable
  --no-auto-update       plan no update-branch/dispatch-ci actions
  --actions <path>       write planned actions as JSON lines here
  --summary <path>       append a markdown report here ($GITHUB_STEP_SUMMARY)
  --file <path>          (waiting) the file to splice, default HUMAN-ACTIONS.md
  --repo <owner/name>    (waiting) for the live filter URL
  --write                (waiting) write the file
  --print                (waiting) print the block, write nothing
  --check                (waiting) exit 1 if the file's block is stale`;

const VALUE_FLAGS = new Set([
  "--from",
  "--freeze",
  "--actions",
  "--summary",
  "--file",
  "--repo",
]);
const BOOL_FLAGS = new Set(["--no-auto-update", "--write", "--print", "--check"]);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "waiting"].includes(command)) {
    throw new Error(`unknown command: ${command ?? "(none)"}`);
  }
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (BOOL_FLAGS.has(a)) {
      opts[a.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new Error(`unknown option: ${a}`);
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return { command, opts };
}

const defaultIo = {
  readFile: (p) => fs.readFileSync(p, "utf8"),
  readStdin: () => fs.readFileSync(0, "utf8"),
  writeFile: (p, s) => fs.writeFileSync(p, s),
  append: (p, s) => fs.appendFileSync(p, s),
  exists: (p) => fs.existsSync(p),
  log: (s) => console.log(s),
  err: (s) => console.error(s),
};

export function runCli(argv, io = {}) {
  const $ = { ...defaultIo, ...io };
  let command, opts;
  try {
    ({ command, opts } = parseArgs(argv));
  } catch (err) {
    $.err(err.message);
    $.err(USAGE);
    return 2;
  }

  let prs = [];
  if (opts.from) {
    const text = opts.from === "-" ? $.readStdin() : $.readFile(opts.from);
    try {
      prs = JSON.parse(text);
    } catch (err) {
      $.err(`--from is not valid JSON: ${err.message}`);
      return 2;
    }
    if (!Array.isArray(prs)) {
      $.err("--from must contain a JSON array of pull requests");
      return 2;
    }
  } else {
    // No --from means "go and look". Never means "assume there is nothing".
    try {
      prs = gatherPrs({ repo: opts.repo, exec: $.exec });
    } catch (err) {
      $.err(`could not read open PRs: ${err.message}`);
      $.err("Pass --from <prs.json> if `gh` is not available here.");
      return 2;
    }
  }

  if (command === "plan") {
    const { actions, notes, queue } = planTriage(prs, {
      freeze: opts.freeze,
      autoUpdate: !opts.noAutoUpdate,
    });
    if (opts.actions) {
      $.writeFile(opts.actions, actions.map((a) => JSON.stringify(a)).join("\n") + (actions.length ? "\n" : ""));
    }
    const report = [
      "## pr-hygiene",
      "",
      `${prs.length} open PR(s) examined · ${actions.length} action(s) planned · ` +
        `${queue.length} waiting on a founder.`,
      "",
      ...(actions.length
        ? actions.map((a) => `- \`${a.kind}\` #${a.pr}${a.label ? ` \`${a.label}\`` : ""}${a.ref ? ` (${a.ref})` : ""}`)
        : ["- nothing to do"]),
      "",
      ...(notes.length ? ["Notes:", "", ...notes.map((n) => `- ${n}`), ""] : []),
      renderWaitingBlock(queue, { repo: opts.repo }),
    ].join("\n");
    $.log(report);
    if (opts.summary) $.append(opts.summary, report + "\n");
    return 0;
  }

  // waiting
  const { queue } = planFounderQueue(prs, { freeze: opts.freeze });
  const block = renderWaitingBlock(queue, { repo: opts.repo });
  const file = opts.file ?? "HUMAN-ACTIONS.md";

  if (opts.print || (!opts.write && !opts.check)) {
    $.log(block);
    return 0;
  }
  const current = $.exists(file) ? $.readFile(file) : "";
  let next;
  try {
    next = spliceBlock(current, block);
  } catch (err) {
    $.err(err.message);
    return 2;
  }
  if (opts.check) {
    if (next === current) {
      $.log(`${file} is up to date.`);
      return 0;
    }
    $.err(`${file}'s generated block is stale — run: node tools/ci/pr-triage.mjs waiting --write`);
    return 1;
  }
  if (next === current) {
    $.log(`${file} already up to date — nothing written.`);
    return 0;
  }
  $.writeFile(file, next);
  $.log(`${file} updated (${queue.length} item(s) waiting on a founder).`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(runCli(process.argv.slice(2)));
}
