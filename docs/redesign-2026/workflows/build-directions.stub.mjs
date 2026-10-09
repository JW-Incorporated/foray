// Stub dry run of build-directions.workflow.js: fake agent() keyed on label.
import fs from 'node:fs'
const src = fs.readFileSync(process.argv[2], 'utf8').replace('export const meta', 'const meta')
const DEAD = process.env.STUB_DEAD === '1'
const LOWDISK = process.env.STUB_LOWDISK === '1'
const EXTRA = process.env.STUB_EXTRA === '1'
const prompts = {}
const calls = []
const counters = {}
const plan = d => ({ foundation: d, screens: [{ id: 's1', name: 'screen one', acceptance: ['a'] }, { id: 's2', name: 'screen two', acceptance: ['b'] }, { id: 's1-x', name: 'screen one variant', acceptance: ['c'] }].concat(LOWDISK ? [3, 4, 5, 6, 7].map(n => ({ id: 't' + n, name: 'screen ' + n, acceptance: ['x'] })) : []) })
async function agent(prompt, o) {
  const l = o.label; calls.push(l); prompts[l] = prompt; counters[l.split(':')[0]] = (counters[l.split(':')[0]] || 0) + 1
  if (l === 'cleanup:disk') return { freeGB: LOWDISK ? 2 : 50, removed: 1, summary: 'ok' }
  if (l.startsWith('baseline')) return { ok: true, summary: 'ok' }
  if (l.startsWith('plan:')) { if (!l.endsWith('from-file')) throw new Error('re-planned with Fable: ' + l); return plan(l.split(':')[1]) }
  if (l.startsWith('build:') && DEAD && l.startsWith('build:ambient:s')) return null
  if (l === 'build:tactile:s2') return { ok: false, summary: 'continue: CSS and tests remain' }
  if (l.startsWith('build:')) return l.includes('p3-tokens') ? { ok: true, alreadyMerged: true, summary: 'already merged' } : { ok: true, sha: 'x', summary: 'built' }
  if (l.startsWith('check:')) return { hardPass: true, testsPass: true, gatesPass: true, summary: 'ok', implShot: 'i.png', protoShot: 'p.png', todayShot: 't.png', sideBySide: 'sbs.png' }
  if (l.startsWith('fidelity:')) return l.includes('tactile:s2') ? null : { faithful: true, deviations: [] } // tactile s2: fidelity never comes back
  if (l.startsWith('judge:')) return { winner: l.endsWith(':a') ? 'FIRST' : 'SECOND', reasons: 'r' }
  if (l.startsWith('review:')) {
    if (l.endsWith(':opus')) return { verdict: 'merge', blocking: [], nits: [] }
    if (l.includes('ambient-s1#')) return { verdict: 'fix', blocking: ['CODEX_REVIEW_INCOMPLETE: forced'], nits: [] } // -> Opus fallback
    const n = calls.filter(c => c.startsWith('review:') && c.split('#')[0] === l.split('#')[0] && !c.endsWith(':opus')).length
    if (l.includes('tactile-s1#')) return n < 3 ? { verdict: 'fix', blocking: ['bug ' + n], nits: [] } : { verdict: 'merge', blocking: [], nits: [] } // merges on round 3
    if (l.includes('ambient-s2')) return { verdict: 'fix', blocking: ['never fixed'], nits: [] } // 3 rounds, not merged
    return { verdict: 'merge', blocking: [], nits: [] }
  }
  if (l.startsWith('fix:') || l.startsWith('merge:') || l.startsWith('lab:') || l.startsWith('progress:') || l.startsWith('qa:')) return l.startsWith('qa:') ? { issues: [] } : { ok: true, summary: 'ok' }
  if (o.model === 'fable') return { ok: true }
  throw new Error('unexpected label ' + l)
}
const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
async function pipeline(items, ...stages) { return Promise.all(items.map(async (it, i) => { let r = it; for (const [k, s] of stages.entries()) { try { r = await s(k === 0 ? it : r, it, i) } catch (e) { console.log('STAGE THREW', e.message); return null } } return r })) }
const logs = []
const fn = new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'return (async()=>{' + src + '})()')
const out = await fn(Object.assign({ directions: ['tactile', 'ambient'], plansFile: 'plans.json' }, EXTRA ? { extraUnits: [{ direction: 'ambient', id: 'p5-ci-fixes', name: 'CI fixes', acceptance: ['ci green'] }], rulings: { 'tactile/s2': 'budget may rise to 16 KB' }, skipQA: true } : {}), agent, parallel, pipeline, () => {}, m => logs.push(m))
const byId = (d, id) => out.results.find(r => r && r.direction === d)[id === 'p3' ? 'foundation' : 'screens']
const scr = d => Object.fromEntries(byId(d, 's').map(s => [s.id, s]))
if (EXTRA) {
  const lastScreen = Math.max(...calls.map((c, i) => /^build:ambient:s/.test(c) ? i : -1))
  const ec = [['extra unit runs after the screens', calls.indexOf('build:ambient:p5-ci-fixes') > lastScreen], ['extra unit only in its direction', !calls.includes('build:tactile:p5-ci-fixes')], ['ruling reaches the implementer', /ORCHESTRATOR RULING \(binding\): budget may rise/.test(prompts['build:tactile:s2'] || '')], ['ruling reaches the reviewer', Object.keys(prompts).some(k => k.startsWith('review:tactile:redesign/tactile-s2#') && /budget may rise/.test(prompts[k]))], ['skipQA: no QA agents', !calls.some(c => c.startsWith('qa:'))], ['skipQA: final lab builds still dispatched', calls.includes('lab:tactile:final') && calls.includes('lab:ambient:final')]]
  for (const [n, ok] of ec) console.log(ok ? 'ok  ' : 'FAIL', n)
  process.exit(ec.every(c => c[1]) ? 0 : 1)
}
if (LOWDISK) {
  const firstClean = calls.indexOf('cleanup:disk')
  const buildsAfter = calls.slice(firstClean + 1).filter(c => /^build:w+:s/.test(c))
  const lc = [['cleanup runs after a screen', firstClean > 0], ['low disk: later screens never start', !calls.includes('build:tactile:t7') && !calls.includes('build:ambient:t7')], ['low disk: QA skipped in both directions', !calls.some(c => c.startsWith('qa:'))], ['low disk logged', logs.some(m => m.includes('LOW DISK'))]]
  for (const [n, ok] of lc) console.log(ok ? 'ok  ' : 'FAIL', n)
  process.exit(lc.every(c => c[1]) ? 0 : 1)
}
if (DEAD) {
  const amb = out.results.find(r => r && r.direction === 'ambient')
  const dc = [['dead direction stops after 3 implementer deaths', amb.stopped === true && amb.screens.length === 3], ['dead direction skips QA and final lab', !calls.some(c => c.startsWith('qa:ambient') || c === 'lab:ambient:final')], ['live direction still runs QA', calls.some(c => c.startsWith('qa:tactile'))]]
  for (const [n, ok] of dc) console.log(ok ? 'ok  ' : 'FAIL', n)
  process.exit(dc.every(c => c[1]) ? 0 : 1)
}
const t = scr('tactile'), a = scr('ambient')
const ix = l => calls.indexOf(l)
const checks = [
  ['turn budget: unfinished build hands over to a fresh agent and merges', calls.includes('build:tactile:s2:c2') && scr('tactile').s2.unjudged !== undefined],
  ['same family waits: s1-x builds after s1 merges', ix('build:tactile:s1-x') > ix('merge:tactile:redesign/tactile-s1') && ix('merge:tactile:redesign/tactile-s1') >= 0],
  ['other family in parallel: s2 builds before s1 merges', ix('build:tactile:s2') >= 0 && ix('build:tactile:s2') < ix('merge:tactile:redesign/tactile-s1')],
  ['every screen reported', scr('tactile')['s1-x'] && scr('ambient')['s1-x']],
  ['no Fable re-plan', !calls.some(c => c.startsWith('plan:') && !c.endsWith('from-file'))],
  ['tokens skipped as already merged', byId('tactile', 'p3').find(f => f.id === 'p3-tokens').skipped === true],
  ['tactile s1 merges after 3 review rounds', t.s1.merged && calls.filter(c => c.startsWith('review:tactile:redesign/tactile-s1#')).length === 3],
  ['ambient s1 Codex failure -> Opus review -> merged', a.s1.merged && calls.some(c => c.startsWith('review:ambient:redesign/ambient-s1#') && c.endsWith(':opus'))],
  ['ambient s2 blocked after 3 reviews, not merged', !a.s2.merged && a.s2.reason === 'review blocking' && calls.filter(c => c.startsWith('review:ambient:redesign/ambient-s2')).length === 3],
  ['tactile s2 missing fidelity -> UNJUDGED', t.s2.unjudged === true && logs.some(m => m.includes('UNJUDGED'))],
  ['tactile s1 judged, not unjudged', t.s1.unjudged === false],
]
for (const [n, ok] of checks) console.log(ok ? 'ok  ' : 'FAIL', n)
console.log(`${calls.length} agent calls`)
process.exit(checks.every(c => c[1]) ? 0 : 1)
