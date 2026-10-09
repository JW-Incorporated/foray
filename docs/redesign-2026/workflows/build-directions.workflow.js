export const meta = {
  name: 'redesign-2026-build-directions',
  description: 'Redesign 2026 phases 3-5 for the directions the owner picked: foundation, screen-by-screen build loops, lab builds, QA',
  whenToUse: 'After the Phase 2 checkpoint: Workflow({scriptPath: <this file>, args: {directions: ["tactile", "ambient"]}})',
  phases: [
    { title: 'Plan', detail: 'per direction: ordered screen list + acceptance criteria' },
    { title: 'Foundation', detail: 'tokens+motion, icon sprite, primitives, gallery baseline' },
    { title: 'Screens', detail: 'implement, gates, fidelity, judge, fix, review, merge' },
    { title: 'Lab', detail: 'lab-build.yml per direction branch' },
    { title: 'QA', detail: 'adversarial QA, perf budget, fixes' },
  ],
}

// args: { directions: ['tactile', 'ambient'], maxIters?: 4, skipScreens?: [], prep?: [{ direction, instruction }] }
// prep runs first, one agent each, and must commit+push to the trunk; a failed prep stops the run.
// Relaunch in a NEW session is safe: a unit already merged into its direction branch is skipped.
// Every agent follows docs/redesign-2026/build-loop.md; this script only fixes
// order, gating and who merges what. Resume: same args -> cached prefix.
const DIRS = (args && args.directions) || []
if (!DIRS.length) throw new Error('args.directions is required, e.g. ["tactile","ambient"]')
const MAX_ITERS = (args && args.maxIters) || 4
const SCREEN_CONC = (args && args.screenConcurrency) || 4 // screens in flight per direction
const MERGE_CHAIN = {} // per direction: merges into feature/redesign-2026-<d> one at a time

// Disk hygiene (2026-10-08: the disk filled overnight, ~2.4 GB/h of leftover agent worktrees,
// and every step started failing). After each screen, one cleanup agent at a time removes
// finished workflow worktrees and stale test temp dirs; under 4 GB free, no new screens start.
let LOW_DISK = false
let cleanupChain = Promise.resolve()
const DISK = { type: 'object', properties: { freeGB: { type: 'number' }, removed: { type: 'integer' }, summary: { type: 'string' } }, required: ['freeGB', 'summary'] }
const cleanup = () => (cleanupChain = cleanupChain.catch(() => null).then(() => agent(`Free disk space left behind by finished workflow agents. Do not touch anything else. Work from the trunk checkout ${WT}.\n1. Note free space on C: (PowerShell: (Get-PSDrive C).Free/1GB).\n2. git worktree list --porcelain. Candidates: worktrees whose folder is directly under ${WT.replace(/\\redesign-2026$/, '')} and whose name starts with "wf_", whose folder was created more than 3 hours ago, and whose HEAD commit is on origin (git branch -r --contains <sha> prints something). For each candidate run git worktree remove "<literal path>" (one plain command per worktree, the literal path written out: no variables, loops, xargs or -C, because this session's guard refuses computed git arguments; never --force). Git refuses worktrees with modified or untracked files: leave those alone.\n3. In %TEMP%, delete folders older than 3 hours whose names start with uilab-, foray-webdir-, foray-inject-models- or playwright_chromiumdev_profile- (test scratch dirs; nothing else).\n4. Return free GB after, the number of worktrees removed, and a one-line summary.`, { label: 'cleanup:disk', phase: 'Screens', schema: DISK, model: 'sonnet', effort: 'low' }).then(c => { if (c && c.freeGB < 4) { LOW_DISK = true; log(`LOW DISK: ${c.freeGB} GB free after cleanup; no new screens will start`) } return c })))
const WT = 'C:\\Users\\Fourtys\\Documents\\Claude\\Projects\\foray\\.claude\\worktrees\\redesign-2026'
const ROOT = `${WT}\\data-local\\redesign`
const TRUNK = 'feature/redesign-2026'
const dirBranch = d => `${TRUNK}-${d}`

const COMMON = `You work on the 4a Redesign 2026 effort in the foray repo. Before anything else read, in the trunk checkout ${WT}: docs/redesign-2026/PLAN.md and docs/redesign-2026/build-loop.md, and follow build-loop.md exactly (it names every command, flag and path; pass --root ${ROOT} where it says so, because your own worktree's data-local/ is empty). Rules that bite: never push to main, never open a PR into main, never push v* tags, never dispatch release.yml/pages.yml/android-release.yml; git add explicit paths only; never git restore / checkout -- / clean / reset --hard / bare stash; never commit screenshots or podcast artwork (renders stay under ${ROOT}); every interpolation via esc(), every href/src via safeUrl(), strict CSP (no inline style=/script), localStorage only via the shim with cp_ keys; 44px tap targets, one reduced-motion block, WCAG AA; copy rules (why <=18 words, hooks <=16, banned words, no we/us/our, "subject" not "topic"); a new test names and runs its mutation, a new suite gets a floor in test/suite-integrity.test.js. Owner decisions recorded at the top of a direction's DIRECTION.md are final. Shoot every direction in its primary colour scheme with an explicit --scheme (build-loop.md). The owner is asleep: you and the direction's art director make every decision. Don't ask questions: decide, write it down, keep going.\nCONTEXT BUDGET (owner, 2026-10-08: one night cost 45% of the weekly plan, almost all of it agents re-reading huge contexts every turn): never Read a whole large file (styles.css, app.js, anything over ~300 lines) - grep for what you need and Read only those line ranges; pipe test, gate and build output through tail -40 or a grep for failures, never print full logs; do not re-read a file you already read; look at a screenshot only when deciding something visual; read build-loop.md once, only the sections your step needs.`

// Build and fix agents stop after ~100 tool calls, push WIP and hand over to a fresh agent
// (context resets), instead of running 300+ turns with a 400k context (2026-10-08 audit:
// builders were 65% of all tokens at ~316 turns each).
const CHUNK = `\nTURN BUDGET: after about 100 tool calls, stop: commit and push what you have (WIP is fine) and return ok=false with a summary that starts with "continue:" and lists exactly what remains; a fresh agent continues from your pushed branch.`
const chunked = work => async (prompt, opts) => {
  let r = await agent(prompt + CHUNK, opts)
  for (let c = 2; c <= 4 && r && r.ok === false && /^continue:/i.test(r.summary || ''); c++) {
    r = await agent(`${COMMON}\nYou are in an isolated git worktree. git fetch origin && git checkout -B ${work} origin/${work} . A previous agent used its turn budget and handed over (chunk ${c} of 4). What remains, in its words: ${r.summary.replace(/^continue:\s*/i, '')}\nIts original task, for reference:\n${prompt.slice(COMMON.length).slice(0, 4000)}${CHUNK}`, { ...opts, label: `${opts.label}:c${c}` })
  }
  return r
}

// A previous attempt (an interrupted Claude run or the overnight Codex driver) may have pushed
// work to the unit's branch: continue it instead of starting over, and address the blocking
// review items the Codex driver recorded for it.
const inWorktree = (d, work) => `You are in an isolated git worktree. Run git fetch origin. If origin/${work} exists and has commits that are not in origin/${dirBranch(d)} (git log --oneline origin/${dirBranch(d)}..origin/${work}), a previous attempt pushed work there: git checkout -B ${work} origin/${work}, merge origin/${dirBranch(d)} into it if it is behind, then check what is there against the acceptance criteria and finish what is missing rather than starting over. Also look in ${ROOT}\\codex-driver\\state.json for this unit (units -> "${work.replace(`redesign/${d}-`, '')}" under direction ${d}): if a review there listed blocking items, each one must be fixed and covered by a test. Otherwise: git checkout -B ${work} origin/${dirBranch(d)} . Commit there and push with git push -u origin ${work} (force-push only this work branch if you must redo it). Never commit to ${dirBranch(d)} directly.`

let FABLE = 0
// Art-director calls go to Fable; if Fable fails, Opus takes the same prompt.
const ad = (prompt, o) => agent(prompt, { ...o, model: 'fable' }).then(r => { if (r) { FABLE++; return r } return agent(prompt, { ...o, label: o.label + ':opus', model: 'opus' }) })

const STATUS = { type: 'object', properties: { ok: { type: 'boolean' }, alreadyMerged: { type: 'boolean' }, branch: { type: 'string' }, sha: { type: 'string' }, summary: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'summary'] }
const PLAN = { type: 'object', properties: { screens: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } } }, required: ['id', 'name', 'acceptance'] } }, foundation: { type: 'string' } }, required: ['screens', 'foundation'] }
const CHECK = { type: 'object', properties: { hardPass: { type: 'boolean' }, testsPass: { type: 'boolean' }, gatesPass: { type: 'boolean' }, newDebt: { type: 'array', items: { type: 'string' } }, baselineRegressions: { type: 'array', items: { type: 'string' } }, fidelity: { type: 'string' }, implShot: { type: 'string' }, protoShot: { type: 'string' }, todayShot: { type: 'string' }, sideBySide: { type: 'string' }, summary: { type: 'string' } }, required: ['hardPass', 'testsPass', 'gatesPass', 'summary'] }
const VERDICT = { type: 'object', properties: { winner: { type: 'string', enum: ['FIRST', 'SECOND', 'TIE'] }, confidence: { type: 'integer' }, reasons: { type: 'string' } }, required: ['winner', 'reasons'] }
const FIDELITY = { type: 'object', properties: { faithful: { type: 'boolean' }, deviations: { type: 'array', items: { type: 'string' } } }, required: ['faithful', 'deviations'] }
const REVIEW = { type: 'object', properties: { verdict: { type: 'string', enum: ['merge', 'fix'] }, blocking: { type: 'array', items: { type: 'string' } }, nits: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'blocking'] }
const QA = { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, where: { type: 'string' }, what: { type: 'string' }, repro: { type: 'string' } }, required: ['severity', 'what'] } } }, required: ['issues'] }

// PROGRESS.md lives on the trunk; serialise every trunk write through one chain.
let trunkChain = Promise.resolve()
const progress = (line) => {
  trunkChain = trunkChain.then(() => agent(`In the trunk checkout ${WT} on branch ${TRUNK}: git pull --ff-only, then add this line to the Log of docs/redesign-2026/PROGRESS.md (and update the Phase status table row for phases 3-5 if it changes): "${line.replace(/"/g, "'")}". Commit only that file (explicit path), push; if the push is rejected, pull --rebase once and push again. Touch nothing else.`, { label: `progress:${line.slice(0, 40)}`, phase: 'Lab', schema: STATUS, model: 'sonnet', effort: 'low' })).catch(() => null)
  return trunkChain
}

const mergeWork = (d, work, what) => agent(`${COMMON}\nYou are in an isolated git worktree. git fetch origin && git checkout -B ${dirBranch(d)} origin/${dirBranch(d)} && git merge --no-ff origin/${work} -m "Merge ${work} into ${dirBranch(d)}: ${what}". If it conflicts, resolve keeping both sides' intent and say so. Run node --test test/suite-integrity.test.js and the suites the change touches (build-loop.md lists them). Push ${dirBranch(d)}. Then, per build-loop.md, re-record the rolling app baseline (and the gallery baseline if the gallery changed) with --root ${ROOT}. Return ok=false only if the merge could not be pushed.`, { label: `merge:${d}:${work}`, phase: 'Screens', schema: STATUS, model: 'sonnet', effort: 'medium', isolation: 'worktree' })

// Code review is Codex's job (owner, 2026-10-07: "continue to use codex for code reviews").
// A thin Claude agent hands the brief to `codex exec` and returns its schema-checked verdict.
let REVIEWS = 0
const review = (d, work, what) => {
  const n = ++REVIEWS
  const dir = `${ROOT}\\codex-reviews\\${d}-${work.split('/').pop()}-${n}`
  const brief = `${COMMON}\nCode-review origin/${work} against origin/${dirBranch(d)} (git fetch origin; git diff origin/${dirBranch(d)}...origin/${work}), read-only: do not commit or push. ${what}. Blocking = a hard-limit breach (security/CSP/esc/safeUrl, cp_ keys, a11y, copy rules, product principles), a correctness bug, a test that pins nothing (apply its named mutation in a scratch copy and run it), a behaviour change to the current app outside the lab/redesign path, or committed images. Everything else is a nit. verdict=merge only with zero blocking items. Run only the suites the diff touches; summarise command output instead of echoing it.`
  return agent(`You hand one code review to Codex and return its verdict. Do not review anything yourself.\n1. You are in an isolated git worktree; note its absolute path (pwd -W). Create the directory ${dir}.\n2. Write this JSON Schema, exactly, to ${dir}\\schema.json: ${JSON.stringify({ ...REVIEW, additionalProperties: false, required: ['verdict', 'blocking', 'nits'] })}\n3. Write the review brief between the markers below, verbatim, to ${dir}\\brief.md.\n4. With the Bash tool and run_in_background: true, run: codex exec -m gpt-5.6-sol -c model_reasoning_effort="high" -C "<your worktree path>" --output-schema "${dir.replace(/\\/g, '/')}/schema.json" -o "${dir.replace(/\\/g, '/')}/verdict.json" - < "${dir.replace(/\\/g, '/')}/brief.md" > "${dir.replace(/\\/g, '/')}/codex.log" 2>&1\n   It takes 10-30 minutes. Wait for its completion notification; never use foreground sleep and never start a second Codex run while one is running.\n5. When it has exited, read ${dir}\\verdict.json and return exactly its verdict, blocking and nits. If Codex exited non-zero or verdict.json is missing or invalid, run step 4 once more; if it fails again, return verdict "fix" with blocking ["CODEX_REVIEW_FAILED: <one-line reason from codex.log>"].\n----- BRIEF START -----\n${brief}\n----- BRIEF END -----`, { label: `review:${d}:${work}#${n}`, phase: 'Screens', schema: REVIEW, model: 'sonnet', effort: 'low', isolation: 'worktree' })
    .then(rv => {
      const failed = !rv || (rv.blocking || []).some(b => /^CODEX_REVIEW_/.test(b))
      if (!failed) return rv
      log(`review ${d}/${work}#${n}: Codex review failed (${rv ? rv.blocking.join('; ') : 'wrapper died'}), Opus reviews instead`)
      return agent(brief.replace('Run only the suites', 'Scratch copies go under C:\\Users\\Fourtys\\.claude\\jobs. Run only the suites'), { label: `review:${d}:${work}#${n}:opus`, phase: 'Screens', schema: REVIEW, model: 'opus', effort: 'high' })
    })
}

// One unit of work: implement -> (checks -> judges -> fix)* -> review -> merge.
// taste=false (foundation): the current app must stay pixel-identical, so only
// hard checks apply; judging it against today would always tie.
async function buildUnit(d, unit, kind, phaseName, taste = true) {
  // args.rulings["<dir>/<unit id>"]: a binding orchestrator decision for this unit (e.g. a raised
  // budget). Builders, fixers and the reviewer all see it, so nobody re-litigates it.
  const ruling = (args && args.rulings && args.rulings[`${d}/${unit.id}`]) || ''
  if (ruling) unit = { ...unit, acceptance: [...unit.acceptance, `ORCHESTRATOR RULING (binding): ${ruling}`] }
  const work = `redesign/${d}-${unit.id}`
  const tag = `${d}:${unit.id}`
  let impl = await chunked(work)(`${COMMON}\nFIRST: git fetch origin; if \`git log origin/${dirBranch(d)} --merges --oneline --grep "Merge ${work} into ${dirBranch(d)}"\` prints anything (a merge of this branch into ANOTHER work branch does not count: on 2026-10-08 that false match skipped tactile now-playing and library), this unit is already merged: do nothing else and return ok=true, alreadyMerged=true, summary "already merged".\n${inWorktree(d, work)}\nDirection: ${d} (docs/redesign-2026/directions/${d}/DIRECTION.md, prototype in prototype/, screens.json). Build ${kind} "${unit.name}" per build-loop.md. Acceptance criteria:\n- ${unit.acceptance.join('\n- ')}\nRun the targeted tests and gates yourself before pushing. Return branch and sha.`, { label: `build:${tag}`, phase: phaseName, schema: STATUS, model: 'sonnet', effort: 'high', isolation: 'worktree' })
  if (impl && impl.alreadyMerged) { log(`${tag}: already merged, skipped`); return { id: unit.id, merged: true, skipped: true } }
  if (!impl || !impl.ok) return { id: unit.id, merged: false, reason: impl ? 'implementer unfinished after 4 chunks' : 'implementer failed', detail: impl && impl.summary }
  let last = null
  for (let it = 1; it <= MAX_ITERS; it++) {
    const chk = await agent(`${COMMON}\nVerify origin/${work} (head ${impl.sha || 'latest'}) for ${kind} "${unit.name}" of direction ${d}, read-only except data-local renders. In an isolated worktree: git fetch origin && git checkout --detach origin/${work}, then git merge --no-edit origin/${dirBranch(d)} locally (never push it) so you check this unit on top of everything merged since its branch was cut; if that merge conflicts, git merge --abort and return hardPass=false, testsPass=false with summary "needs a merge of ${dirBranch(d)}". Run, per build-loop.md: the test suites the change touches, PLUS the repo-wide checks CI runs that per-unit checks used to skip (2026-10-08: both direction branches went red on them): backend/test/publishSuites.test.ts with the backend's test runner (every new suite that reads data/*.json must be listed in REAL_DATA_SUITES), node --test tools/parity/gen-constants.test.mjs (if it fails, node tools/parity/gen-constants.mjs --write is the fix), and the Playwright specs that touch this screen's DOM (drawer-and-close, search-*, and any spec naming its selectors); a failure in any of these is testsPass=false, gates.mjs with the known-debt allow list (new debt = any violation not in it), baseline compare (rolling app + gallery): diffs outside "${unit.name}" are regressions UNLESS they come from shared components this unit deliberately changed per its acceptance criteria or the direction's BUILD-PLAN.md (e.g. tab bar, mini player, tokens); list those as intended in the summary, never as baselineRegressions, and fidelity.mjs for this screen against the prototype. Save renders under ${ROOT}\\loop\\${d}\\${unit.id}\\it${it}\\ and return absolute paths to the implementation shot, the prototype shot, today's app shot of the same screen (if today has one) and the fidelity side-by-side. hardPass = tests pass AND no new gate debt AND no baseline regressions.`, { label: `check:${tag}:it${it}`, phase: phaseName, schema: CHECK, model: 'sonnet', effort: 'medium', isolation: 'worktree' })
    if (!chk) { last = { it, error: 'checker died' }; break }
    const judges = []
    if (taste && chk.sideBySide) judges.push(ad(`You are the art director for direction ${d}, checking that the build realises your design. Read ${WT}\\docs\\redesign-2026\\judge\\rubric.md and docs/redesign-2026/directions/${d}/DIRECTION.md in ${WT}. Look at the side-by-side ${chk.sideBySide} (left = the direction's prototype, right = the implementation), and the full shots ${chk.protoShot || ''} and ${chk.implShot || ''} with the Read tool. List only deviations that change the design's intent or quality (type, spacing rhythm, colour, hierarchy, motion cues, iconography, imagery treatment); real-data differences (titles, artwork) are not deviations. faithful=false if any such deviation exists. Do not modify files.`, { label: `fidelity:${tag}:it${it}`, phase: phaseName, schema: FIDELITY, effort: 'medium' }))
    if (taste && chk.implShot && chk.todayShot) {
      const vs = (first, second, j) => agent(`You are a design judge. Read the rubric at ${WT}\\docs\\redesign-2026\\judge\\rubric.md and follow ${WT}\\docs\\redesign-2026\\judge\\protocol.md. Compare two screens of the same app (FIRST = ${first}, SECOND = ${second}; use the Read tool). Judge the design as a whole. Return FIRST, SECOND or TIE, confidence 1-5, and the 2-3 decisive reasons in at most 50 words. Do not modify files.`, { label: `judge:${tag}:it${it}:${j}`, phase: phaseName, schema: VERDICT, model: 'opus', effort: 'medium' })
      judges.push(vs(chk.implShot, chk.todayShot, 'a').then(v => v && { better: v.winner === 'FIRST', reasons: v.reasons }))
      judges.push(vs(chk.todayShot, chk.implShot, 'b').then(v => v && { better: v.winner === 'SECOND', reasons: v.reasons }))
    }
    const jr = (await parallel(judges.map(p => () => p))).filter(Boolean)
    const fid = jr.find(r => 'faithful' in r)
    const better = jr.filter(r => 'better' in r)
    const beatsToday = better.length === 0 || better.every(r => r.better) // both orders, ties fail
    const faithful = !fid || fid.faithful
    // A requested judgement that never came back is NOT a pass: flag it so it is re-judged.
    const unjudged = (taste && !!chk.sideBySide && !fid) || (taste && !!(chk.implShot && chk.todayShot) && better.length < 2)
    if (unjudged) log(`${tag} it${it}: UNJUDGED (a requested verdict did not come back)`)
    last = { it, hardPass: chk.hardPass, faithful, beatsToday, unjudged, chk, fid, better }
    if (chk.hardPass && faithful && beatsToday) break
    if (it === MAX_ITERS) break
    const feedback = [
      ruling && `Orchestrator ruling (binding): ${ruling}`,
      !chk.testsPass && 'Tests fail: ' + chk.summary,
      !chk.gatesPass && 'New gate debt: ' + (chk.newDebt || []).join('; '),
      (chk.baselineRegressions || []).length && 'Baseline regressions outside this screen: ' + chk.baselineRegressions.join('; '),
      !faithful && 'Fidelity deviations: ' + fid.deviations.join('; '),
      !beatsToday && 'Judges did not prefer it over today in both orders: ' + better.map(b => b.reasons).join(' | '),
    ].filter(Boolean).join('\n')
    impl = await chunked(work)(`${COMMON}\nYou are in an isolated git worktree. git fetch origin && git checkout -B ${work} origin/${work} , and git merge origin/${dirBranch(d)} into it if it is behind (other screens merge meanwhile; resolve conflicts keeping both sides). Fix ${kind} "${unit.name}" of direction ${d} (iteration ${it + 1} of ${MAX_ITERS}). Findings to address:\n${feedback}\nRe-run the targeted tests and gates, commit, push ${work}. Return the new sha.`, { label: `fix:${tag}:it${it + 1}`, phase: phaseName, schema: STATUS, model: 'sonnet', effort: 'high', isolation: 'worktree' }) || impl
  }
  if (!last || !last.hardPass) return { id: unit.id, merged: false, reason: 'hard checks failing after ' + MAX_ITERS + ' iterations', detail: last && last.chk && last.chk.summary }
  // Up to 3 Codex reviews with an Opus fix between each (overnight, one fix round left 4 of 8
  // foundation units blocked on items a second fix would have closed).
  let rv = await review(d, work, `It builds ${kind} "${unit.name}" for direction ${d}${ruling ? `. Orchestrator ruling that applies (binding, not a finding): ${ruling}` : ''}`)
  for (let round = 2; round <= 3 && rv && rv.verdict === 'fix'; round++) {
    await chunked(work)(`${COMMON}\nYou are in an isolated git worktree. git fetch origin && git checkout -B ${work} origin/${work} . Fix these blocking review items (each one, with a test that fails without the fix), re-run the targeted tests and gates, commit, push ${work}:\n- ${rv.blocking.join('\n- ')}`, { label: `fix:${tag}:review${round - 1}`, phase: phaseName, schema: STATUS, model: 'sonnet', effort: 'high', isolation: 'worktree' })
    rv = await review(d, work, `Review round ${round}, after fixes for: ${rv.blocking.join(' | ').slice(0, 1500)}. It builds ${kind} "${unit.name}" for direction ${d}`)
  }
  if (!rv || rv.verdict !== 'merge') return { id: unit.id, merged: false, reason: 'review blocking', detail: rv ? rv.blocking : 'reviewer died' }
  // Screens build in parallel; merges into a direction branch stay one at a time.
  const m = await (MERGE_CHAIN[d] = (MERGE_CHAIN[d] || Promise.resolve()).catch(() => null).then(() => mergeWork(d, work, unit.name)))
  const escalated = !(last.faithful && last.beatsToday)
  return { id: unit.id, merged: !!(m && m.ok), escalated, unjudged: !!last.unjudged, iterations: last.it, judged: { faithful: last.faithful, beatsToday: last.beatsToday } }
}

const FOUNDATION = [
  { id: 'p3-tokens', name: 'design tokens including motion tokens and the single reduced-motion block' },
  { id: 'p3-icons', name: 'SVG icon sprite (CSP-safe <use> references) shown in the gallery; screens swap their Unicode glyphs for it in Phase 4' },
  { id: 'p3-primitives', name: 'primitives (buttons, rows, cards, sheets, tab bar, artwork frame) on the tokens, shown in the gallery; screens adopt them in Phase 4' },
  { id: 'p3-gallery', name: 'component gallery at #/gallery behind the lab flag, recorded as the gallery baseline' },
]

// The foundation's "current app unchanged" check needs a baseline of today's
// app from the trunk. Record it once; skip if it already exists.
phase('Plan')
await agent(`${COMMON}\nIn the trunk checkout ${WT} (do not modify tracked files), run node tools/ui-lab/baseline.mjs list --root ${ROOT}. If no baseline named trunk-app exists, record one of the trunk's current app per build-loop.md (record --name trunk-app --target app --no-remote-images --root ${ROOT}). Return ok=true when it exists.`, { label: 'baseline:trunk-app', phase: 'Plan', schema: STATUS, model: 'sonnet', effort: 'low' })

for (const pr of ((args && args.prep) || [])) {
  const r = await agent(`${COMMON}\nThis is an assigned task from the orchestrator. ${pr.instruction}\nWhen done, commit with explicit paths only and push the trunk ${TRUNK} (git pull --ff-only first). Return ok=true only if it is pushed.`, { label: `prep:${pr.direction}`, phase: 'Plan', schema: STATUS, model: 'sonnet', effort: 'high' })
  if (!r || !r.ok) throw new Error(`prep for ${pr.direction} failed: ${r ? r.summary : 'agent died'}`)
  log(`prep ${pr.direction}: ${r.summary}`)
}

const results = await pipeline(DIRS,
  // Plan. args.plansFile (e.g. data-local/redesign/codex-driver/plans.json, written from the
  // first run's plan results) skips re-planning: the BUILD-PLANs are already merged.
  d => (args && args.plansFile) ? agent(`Read the JSON file ${args.plansFile} and return its "${d}" entry exactly as it is (screens with id, name and acceptance, in order, and foundation). Do nothing else.`, { label: `plan:${d}:from-file`, phase: 'Plan', schema: PLAN, model: 'sonnet', effort: 'low' }) : ad(`${COMMON}\nYou are the art director for direction ${d}. Create branch ${dirBranch(d)} from origin/${TRUNK} if it does not exist on origin (in an isolated worktree: git fetch origin; git push origin origin/${TRUNK}:refs/heads/${dirBranch(d)}). Then read docs/redesign-2026/directions/${d}/ (DIRECTION.md, BUILD-NOTES.md, critique-r3.md, screens.json, the prototype) and build-loop.md, and write docs/redesign-2026/directions/${d}/BUILD-PLAN.md on a work branch redesign/${d}-plan off ${dirBranch(d)}: the foundation decisions specific to ${d} (token values, type, motion, icon list) and the ordered screen list, Now Playing first, each with 3-6 testable acceptance criteria drawn from the prototype. Push the work branch, then merge it into ${dirBranch(d)} yourself (doc-only) and push. Return the same screen list. Skip screens with no app state today only if build-loop.md says so; otherwise include them and say they need a new state.`, { label: `plan:${d}`, phase: 'Plan', schema: PLAN, effort: 'high', isolation: 'worktree' }),
  // Foundation, sequential within a direction
  async (plan, d) => {
    if (!plan) return null
    const found = []
    for (const f of FOUNDATION) {
      const unit = { ...f, acceptance: [`Matches the ${d} decisions in docs/redesign-2026/directions/${d}/BUILD-PLAN.md`, 'Screens are not changed yet: the foundation adds the system and the gallery, and the app screens stay pixel-identical to the trunk-app baseline (they adopt the system screen by screen in Phase 4)', 'All suites the change touches pass; new tests carry executed mutations'] }
      found.push(await buildUnit(d, unit, 'the foundation step', 'Foundation', false))
    }
    await progress(`${d}: Phase 3 foundation ${found.filter(r => r.merged).length}/${FOUNDATION.length} merged into ${dirBranch(d)}`)
    return { plan, found }
  },
  // Screens, SCREEN_CONC at a time within a direction (plan order is the start order; merges are
  // serialised in buildUnit); first lab build after the first merged screen. Three implementer
  // deaths in a row (e.g. Claude's usage ran out) stop the direction instead of burning the list.
  async (prev, d) => {
    if (!prev) return null
    const skip = new Set((args && args.skipScreens) || [])
    const queue = prev.plan.screens.filter(s => !skip.has(s.id))
    const screens = []
    let dead = 0, labDone = false
    // Screens of one family (id prefix: now-playing, now-playing-paused, ...) touch the same
    // files, so a family builds one at a time; different families build in parallel.
    const fam = s => s.id.split('-')[0]
    const inFlight = new Set(), running = new Set()
    const next = () => { const i = queue.findIndex(s => !inFlight.has(fam(s))); return i < 0 ? null : queue.splice(i, 1)[0] }
    const worker = async () => {
      while (dead < 3 && !LOW_DISK) {
        const s = next()
        if (!s) { if (!queue.length || !running.size) return; await Promise.race(running); continue }
        inFlight.add(fam(s))
        const p = buildUnit(d, s, 'the screen', 'Screens').catch(e => ({ id: s.id, merged: false, reason: 'error: ' + (e && e.message) }))
        running.add(p)
        const r = await p
        running.delete(p); inFlight.delete(fam(s))
        screens.push(r)
        if (!r.skipped) await cleanup() // a skipped (already merged) screen left nothing behind
        dead = r.reason === 'implementer failed' ? dead + 1 : 0
        log(`${d}/${s.id}: ${r.merged ? 'merged' : 'NOT merged (' + r.reason + ')'}${r.escalated ? ', escalated (taste checks not met)' : ''}${r.unjudged ? ', UNJUDGED' : ''}`)
        if (r.merged && !labDone) {
          labDone = true
          await agent(`Dispatch a lab build of ${dirBranch(d)}: gh workflow run lab-build.yml --repo JW-Incorporated/foray --ref main -f ref=${dirBranch(d)} -f platforms=both . Return the run URL from gh run list --workflow lab-build.yml --limit 1. Do not wait for it.`, { label: `lab:${d}:first`, phase: 'Lab', schema: STATUS, model: 'sonnet', effort: 'low' })
        }
      }
    }
    await parallel(Array.from({ length: SCREEN_CONC }, () => worker))
    // args.extraUnits: [{direction, id, name, acceptance[], taste?}] - targeted fix sets (CI, QA
    // follow-ups) built after the screens, one at a time, with the same loop and review.
    for (const x of ((args && args.extraUnits) || []).filter(x => x.direction === d)) {
      if (LOW_DISK || dead >= 3) break
      const r = await buildUnit(d, x, x.kind || 'the fix set', 'Screens', !!x.taste)
      screens.push(r)
      log(`${d}/${x.id}: ${r.merged ? 'merged' : 'NOT merged (' + r.reason + ')'}`)
      if (!r.skipped) await cleanup()
    }
    if (dead >= 3) log(`${d}: stopped after 3 implementer deaths in a row; ${queue.length} screens not started: ${queue.map(s => s.id).join(', ')}`)
    await progress(`${d}: Phase 4 screens ${screens.filter(r => r.merged).length}/${screens.length} merged; escalated: ${screens.filter(r => r.escalated).map(r => r.id).join(', ') || 'none'}`)
    return { ...prev, screens, stopped: dead >= 3 || LOW_DISK, notStarted: queue.map(s => s.id) }
  },
  // QA + final lab build (skipped when the screens stopped early: QA of a half-built
  // direction, with agents that cannot run, reports a vacuous "0 issues")
  async (prev, d) => {
    if (!prev) return null
    if (args && args.skipQA && !prev.stopped) {
      await agent(`Dispatch a lab build of ${dirBranch(d)}: gh workflow run lab-build.yml --repo JW-Incorporated/foray --ref main -f ref=${dirBranch(d)} -f platforms=both . Return the run URL. Do not wait for it.`, { label: `lab:${d}:final`, phase: 'Lab', schema: STATUS, model: 'sonnet', effort: 'low' })
      return { direction: d, branch: dirBranch(d), foundation: prev.found, screens: prev.screens, qa: 'skipped (args.skipQA)' }
    }
    if (prev.stopped) { log(`${d}: QA and final lab build skipped, screens stopped early`); return { direction: d, branch: dirBranch(d), foundation: prev.found, screens: prev.screens, stopped: true, notStarted: prev.notStarted, qa: null } }
    const lenses = ['security and CSP (esc/safeUrl, inline style, javascript:, cp_ keys)', 'accessibility (focus in sheets, 44px, reduced motion, contrast, screen reader labels)', 'behaviour parity with the current app (playback, queue, offline, onboarding, search) and the product principles', 'performance budget per build-loop.md (bundle size, first paint, long tasks on a mid-range phone profile)']
    const found = await parallel(lenses.map((lens, i) => () => agent(`${COMMON}\nAdversarial QA of origin/${dirBranch(d)} through the lens: ${lens}. Read-only (scratch in C:\\Users\\Fourtys\\.claude\\jobs). Use the harness (tools/ui-lab) and the test suites. Report only issues you reproduced, with repro steps.`, { label: `qa:${d}:${i}`, phase: 'QA', schema: QA, model: 'opus', effort: 'high' })))
    const issues = found.filter(Boolean).flatMap(f => f.issues).filter(x => /block|high|critical/i.test(x.severity))
    let qaFix = null
    if (issues.length) {
      qaFix = await buildUnit(d, { id: 'p5-qa-fixes', name: 'QA fixes', acceptance: issues.map(x => `${x.where || ''}: ${x.what} (repro: ${x.repro || 'see QA'})`) }, 'the QA fix set', 'QA', false)
    }
    await agent(`Dispatch a lab build of ${dirBranch(d)}: gh workflow run lab-build.yml --repo JW-Incorporated/foray --ref main -f ref=${dirBranch(d)} -f platforms=both . Return the run URL. Do not wait for it.`, { label: `lab:${d}:final`, phase: 'Lab', schema: STATUS, model: 'sonnet', effort: 'low' })
    await progress(`${d}: Phase 5 QA ${issues.length} high-severity issues, fixes ${qaFix ? (qaFix.merged ? 'merged' : 'not merged') : 'not needed'}; final lab build dispatched`)
    return { direction: d, branch: dirBranch(d), foundation: prev.found, screens: prev.screens, qa: { high: issues.length, fixes: qaFix } }
  },
)

await trunkChain
return { results, fableCalls: FABLE }
