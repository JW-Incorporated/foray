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

// args: { directions: ['tactile', 'ambient'], maxIters?: 4, skipScreens?: [] }
// Every agent follows docs/redesign-2026/build-loop.md; this script only fixes
// order, gating and who merges what. Resume: same args -> cached prefix.
const DIRS = (args && args.directions) || []
if (!DIRS.length) throw new Error('args.directions is required, e.g. ["tactile","ambient"]')
const MAX_ITERS = (args && args.maxIters) || 4
const WT = 'C:\\Users\\Fourtys\\Documents\\Claude\\Projects\\foray\\.claude\\worktrees\\redesign-2026'
const ROOT = `${WT}\\data-local\\redesign`
const TRUNK = 'feature/redesign-2026'
const dirBranch = d => `${TRUNK}-${d}`

const COMMON = `You work on the 4a Redesign 2026 effort in the foray repo. Before anything else read, in the trunk checkout ${WT}: docs/redesign-2026/PLAN.md and docs/redesign-2026/build-loop.md, and follow build-loop.md exactly (it names every command, flag and path; pass --root ${ROOT} where it says so, because your own worktree's data-local/ is empty). Rules that bite: never push to main, never open a PR into main, never push v* tags, never dispatch release.yml/pages.yml/android-release.yml; git add explicit paths only; never git restore / checkout -- / clean / reset --hard / bare stash; never commit screenshots or podcast artwork (renders stay under ${ROOT}); every interpolation via esc(), every href/src via safeUrl(), strict CSP (no inline style=/script), localStorage only via the shim with cp_ keys; 44px tap targets, one reduced-motion block, WCAG AA; copy rules (why <=18 words, hooks <=16, banned words, no we/us/our, "subject" not "topic"); a new test names and runs its mutation, a new suite gets a floor in test/suite-integrity.test.js. Don't ask questions: decide, write it down, keep going.`

const inWorktree = (d, work) => `You are in an isolated git worktree. Run: git fetch origin && git checkout -B ${work} origin/${dirBranch(d)} . Commit there and push with git push -u origin ${work} (force-push only this work branch if you must redo it). Never commit to ${dirBranch(d)} directly.`

const STATUS = { type: 'object', properties: { ok: { type: 'boolean' }, branch: { type: 'string' }, sha: { type: 'string' }, summary: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'summary'] }
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

const review = (d, work, what) => agent(`${COMMON}\nCode-review origin/${work} against origin/${dirBranch(d)} (git fetch origin; git diff origin/${dirBranch(d)}...origin/${work}), read-only. ${what}. Blocking = a hard-limit breach (security/CSP/esc/safeUrl, cp_ keys, a11y, copy rules, product principles), a correctness bug, a test that pins nothing (apply its named mutation in a scratch copy under C:\\Users\\Fourtys\\.claude\\jobs and run it), a behaviour change to the current app outside the lab/redesign path, or committed images. Everything else is a nit. verdict=merge only with zero blocking items.`, { label: `review:${d}:${work}`, phase: 'Screens', schema: REVIEW, model: 'opus', effort: 'high' })

// One unit of work: implement -> (checks -> judges -> fix)* -> review -> merge.
// taste=false (foundation): the current app must stay pixel-identical, so only
// hard checks apply; judging it against today would always tie.
async function buildUnit(d, unit, kind, phaseName, taste = true) {
  const work = `redesign/${d}-${unit.id}`
  const tag = `${d}:${unit.id}`
  let impl = await agent(`${COMMON}\n${inWorktree(d, work)}\nDirection: ${d} (docs/redesign-2026/directions/${d}/DIRECTION.md, prototype in prototype/, screens.json). Build ${kind} "${unit.name}" per build-loop.md. Acceptance criteria:\n- ${unit.acceptance.join('\n- ')}\nRun the targeted tests and gates yourself before pushing. Return branch and sha.`, { label: `build:${tag}`, phase: phaseName, schema: STATUS, model: 'sonnet', effort: 'high', isolation: 'worktree' })
  if (!impl || !impl.ok) return { id: unit.id, merged: false, reason: 'implementer failed', detail: impl && impl.summary }
  let last = null
  for (let it = 1; it <= MAX_ITERS; it++) {
    const chk = await agent(`${COMMON}\nVerify origin/${work} (head ${impl.sha || 'latest'}) for ${kind} "${unit.name}" of direction ${d}, read-only except data-local renders. In an isolated worktree: git fetch origin && git checkout --detach origin/${work}. Run, per build-loop.md: the test suites the change touches, gates.mjs with the known-debt allow list (new debt = any violation not in it), baseline compare (rolling app + gallery: diffs outside "${unit.name}" are regressions), and fidelity.mjs for this screen against the prototype. Save renders under ${ROOT}\\loop\\${d}\\${unit.id}\\it${it}\\ and return absolute paths to the implementation shot, the prototype shot, today's app shot of the same screen (if today has one) and the fidelity side-by-side. hardPass = tests pass AND no new gate debt AND no baseline regressions.`, { label: `check:${tag}:it${it}`, phase: phaseName, schema: CHECK, model: 'sonnet', effort: 'medium', isolation: 'worktree' })
    if (!chk) { last = { it, error: 'checker died' }; break }
    const judges = []
    if (taste && chk.sideBySide) judges.push(agent(`You are a design-fidelity critic. Read ${WT}\\docs\\redesign-2026\\judge\\rubric.md and docs/redesign-2026/directions/${d}/DIRECTION.md in ${WT}. Look at the side-by-side ${chk.sideBySide} (left = the direction's prototype, right = the implementation), and the full shots ${chk.protoShot || ''} and ${chk.implShot || ''} with the Read tool. List only deviations that change the design's intent or quality (type, spacing rhythm, colour, hierarchy, motion cues, iconography, imagery treatment); real-data differences (titles, artwork) are not deviations. faithful=false if any such deviation exists. Do not modify files.`, { label: `fidelity:${tag}:it${it}`, phase: phaseName, schema: FIDELITY, model: 'opus', effort: 'medium' }))
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
    last = { it, hardPass: chk.hardPass, faithful, beatsToday, chk, fid, better }
    if (chk.hardPass && faithful && beatsToday) break
    if (it === MAX_ITERS) break
    const feedback = [
      !chk.testsPass && 'Tests fail: ' + chk.summary,
      !chk.gatesPass && 'New gate debt: ' + (chk.newDebt || []).join('; '),
      (chk.baselineRegressions || []).length && 'Baseline regressions outside this screen: ' + chk.baselineRegressions.join('; '),
      !faithful && 'Fidelity deviations: ' + fid.deviations.join('; '),
      !beatsToday && 'Judges did not prefer it over today in both orders: ' + better.map(b => b.reasons).join(' | '),
    ].filter(Boolean).join('\n')
    impl = await agent(`${COMMON}\nYou are in an isolated git worktree. git fetch origin && git checkout -B ${work} origin/${work} . Fix ${kind} "${unit.name}" of direction ${d} (iteration ${it + 1} of ${MAX_ITERS}). Findings to address:\n${feedback}\nRe-run the targeted tests and gates, commit, push ${work}. Return the new sha.`, { label: `fix:${tag}:it${it + 1}`, phase: phaseName, schema: STATUS, model: 'sonnet', effort: 'high', isolation: 'worktree' }) || impl
  }
  if (!last || !last.hardPass) return { id: unit.id, merged: false, reason: 'hard checks failing after ' + MAX_ITERS + ' iterations', detail: last && last.chk && last.chk.summary }
  let rv = await review(d, work, `It builds ${kind} "${unit.name}" for direction ${d}`)
  if (rv && rv.verdict === 'fix') {
    await agent(`${COMMON}\nYou are in an isolated git worktree. git fetch origin && git checkout -B ${work} origin/${work} . Fix these blocking review items, re-run the targeted tests and gates, commit, push ${work}:\n- ${rv.blocking.join('\n- ')}`, { label: `fix:${tag}:review`, phase: phaseName, schema: STATUS, model: 'sonnet', effort: 'high', isolation: 'worktree' })
    rv = await review(d, work, `Second look after fixes. It builds ${kind} "${unit.name}" for direction ${d}`)
  }
  if (!rv || rv.verdict !== 'merge') return { id: unit.id, merged: false, reason: 'review blocking', detail: rv ? rv.blocking : 'reviewer died' }
  const m = await mergeWork(d, work, unit.name)
  const escalated = !(last.faithful && last.beatsToday)
  return { id: unit.id, merged: !!(m && m.ok), escalated, iterations: last.it, judged: { faithful: last.faithful, beatsToday: last.beatsToday } }
}

const FOUNDATION = [
  { id: 'p3-tokens', name: 'design tokens including motion tokens and the single reduced-motion block' },
  { id: 'p3-icons', name: 'SVG icon sprite replacing Unicode glyph icons, CSP-safe <use> references' },
  { id: 'p3-primitives', name: 'primitives (buttons, rows, cards, sheets, tab bar, artwork frame) on the tokens' },
  { id: 'p3-gallery', name: 'component gallery at #/gallery behind the lab flag, recorded as the gallery baseline' },
]

// The foundation's "current app unchanged" check needs a baseline of today's
// app from the trunk. Record it once; skip if it already exists.
phase('Plan')
await agent(`${COMMON}\nIn the trunk checkout ${WT} (do not modify tracked files), run node tools/ui-lab/baseline.mjs list --root ${ROOT}. If no baseline named trunk-app exists, record one of the trunk's current app per build-loop.md (record --name trunk-app --target app --no-remote-images --root ${ROOT}). Return ok=true when it exists.`, { label: 'baseline:trunk-app', phase: 'Plan', schema: STATUS, model: 'sonnet', effort: 'low' })

const results = await pipeline(DIRS,
  // Plan
  d => agent(`${COMMON}\nCreate branch ${dirBranch(d)} from origin/${TRUNK} if it does not exist on origin (in an isolated worktree: git fetch origin; git push origin origin/${TRUNK}:refs/heads/${dirBranch(d)}). Then read docs/redesign-2026/directions/${d}/ (DIRECTION.md, BUILD-NOTES.md, critique-r3.md, screens.json, the prototype) and build-loop.md, and write docs/redesign-2026/directions/${d}/BUILD-PLAN.md on a work branch redesign/${d}-plan off ${dirBranch(d)}: the foundation decisions specific to ${d} (token values, type, motion, icon list) and the ordered screen list, Now Playing first, each with 3-6 testable acceptance criteria drawn from the prototype. Push the work branch, then merge it into ${dirBranch(d)} yourself (doc-only) and push. Return the same screen list. Skip screens with no app state today only if build-loop.md says so; otherwise include them and say they need a new state.`, { label: `plan:${d}`, phase: 'Plan', schema: PLAN, model: 'opus', effort: 'high', isolation: 'worktree' }),
  // Foundation, sequential within a direction
  async (plan, d) => {
    if (!plan) return null
    const found = []
    for (const f of FOUNDATION) {
      const unit = { ...f, acceptance: [`Matches the ${d} decisions in docs/redesign-2026/directions/${d}/BUILD-PLAN.md`, 'Current app (no lab/redesign flag) is pixel-identical: baseline compare against the trunk app baseline is clean', 'All suites the change touches pass; new tests carry executed mutations'] }
      found.push(await buildUnit(d, unit, 'the foundation step', 'Foundation', false))
    }
    await progress(`${d}: Phase 3 foundation ${found.filter(r => r.merged).length}/${FOUNDATION.length} merged into ${dirBranch(d)}`)
    return { plan, found }
  },
  // Screens, sequential within a direction; first lab build after the first screen
  async (prev, d) => {
    if (!prev) return null
    const skip = new Set((args && args.skipScreens) || [])
    const screens = []
    for (const s of prev.plan.screens.filter(s => !skip.has(s.id))) {
      const r = await buildUnit(d, s, 'the screen', 'Screens')
      screens.push(r)
      log(`${d}/${s.id}: ${r.merged ? 'merged' : 'NOT merged (' + r.reason + ')'}${r.escalated ? ', escalated (taste checks not met)' : ''}`)
      if (screens.length === 1 && r.merged) {
        await agent(`Dispatch a lab build of ${dirBranch(d)}: gh workflow run lab-build.yml --repo JW-Incorporated/foray --ref main -f ref=${dirBranch(d)} -f platforms=both . Return the run URL from gh run list --workflow lab-build.yml --limit 1. Do not wait for it.`, { label: `lab:${d}:first`, phase: 'Lab', schema: STATUS, model: 'sonnet', effort: 'low' })
      }
    }
    await progress(`${d}: Phase 4 screens ${screens.filter(r => r.merged).length}/${screens.length} merged; escalated: ${screens.filter(r => r.escalated).map(r => r.id).join(', ') || 'none'}`)
    return { ...prev, screens }
  },
  // QA + final lab build
  async (prev, d) => {
    if (!prev) return null
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
return { results }
