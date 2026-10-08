// Project-management watchdog for a running build workflow (added 2026-10-08 after one night
// cost 45% of the weekly plan and filled the disk with nobody watching).
//
// Run it in the background beside the workflow; it costs no model tokens. It checks every
// 60 s and EXITS with one line naming the problem the moment one appears, which wakes the
// orchestrating session to act (then re-arm it). Silence means healthy.
//
//   node pm-watchdog.mjs <workflow transcript dir> [--min-free-gb 8] [--max-turns 160]
//        [--max-unit-agents 30] [--stall-min 45] [--max-cache-read-m-per-h 125]
//
// Checks: disk free on C:, journal stalled (or the run finished), agent error streak, an agent
// past its turn budget (runaway context), a unit stuck in loops (too many agents), and token
// burn per hour (cache reads, the dominant cost: ~247M/h on 2026-10-07/08; the alarm is half that).
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir || !fs.existsSync(path.join(dir, 'journal.jsonl'))) { console.log('WATCHDOG: no journal.jsonl in ' + dir); process.exit(2) }
const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d }
const MIN_FREE = opt('min-free-gb', 8), MAX_TURNS = opt('max-turns', 160), MAX_UNIT = opt('max-unit-agents', 30)
const STALL_MIN = opt('stall-min', 45), MAX_CR_H = opt('max-cache-read-m-per-h', 125)
const offsets = new Map(), turns = new Map(), seen = new Set() // one transcript line per content block repeats a message's usage: count each message id once
const burn = [] // [timeMs, cumulative cache-read]
let cacheRead = 0

function scanTranscripts() {
  for (const f of fs.readdirSync(dir).filter(f => /^agent-.*\.jsonl$/.test(f))) {
    const p = path.join(dir, f), size = fs.statSync(p).size, from = offsets.get(f) || 0
    if (size <= from) continue
    const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd)
    const text = buf.toString('utf8'), cut = text.lastIndexOf('\n') + 1
    offsets.set(f, from + Buffer.byteLength(text.slice(0, cut)))
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line.includes('"usage"')) continue
      try { const msg = JSON.parse(line).message; if (seen.has(msg.id)) continue; seen.add(msg.id); cacheRead += msg.usage.cache_read_input_tokens || 0; turns.set(f, (turns.get(f) || 0) + 1) } catch {}
    }
  }
}
const label = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f.replace('.jsonl', '.meta.json')), 'utf8')).description } catch { return f } }
const fire = msg => { console.log('WATCHDOG: ' + msg); process.exit(0) }

function check() {
  const freeGB = (() => { const s = fs.statfsSync('C:/'); return s.bavail * s.bsize / 1e9 })()
  if (freeGB < MIN_FREE) fire(`DISK ${freeGB.toFixed(1)} GB free on C: (< ${MIN_FREE})`)
  const jp = path.join(dir, 'journal.jsonl')
  const idleMin = (Date.now() - fs.statSync(jp).mtimeMs) / 60000
  if (idleMin > STALL_MIN) fire(`STALL journal idle ${idleMin.toFixed(0)} min (run finished or hung)`)
  const J = fs.readFileSync(jp, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return {} } })
  const lastResults = J.filter(e => e.type === 'result' || e.type === 'error').slice(-6)
  if (lastResults.length >= 4 && lastResults.slice(-4).every(e => e.type === 'error')) fire('ERRORS last 4 agent results are errors (usage limit? disk?)')
  const perUnit = {}
  for (const e of J.filter(e => e.type === 'started' && e.label)) {
    const m = e.label.match(/^\w+:(tactile|ambient):(?:redesign\/\w+-)?([\w-]+?)(?::|#|$)/)
    if (m) perUnit[m[1] + '/' + m[2]] = (perUnit[m[1] + '/' + m[2]] || 0) + 1
  }
  for (const [u, n] of Object.entries(perUnit)) if (n > MAX_UNIT) fire(`STUCK ${u}: ${n} agents started (> ${MAX_UNIT}); consider args.skipScreens`)
  scanTranscripts()
  for (const [f, n] of turns) if (n > MAX_TURNS) { turns.delete(f); fire(`RUNAWAY ${label(f)}: ${n} turns (> ${MAX_TURNS}, ignoring its turn budget)`) }
  burn.push([Date.now(), cacheRead])
  while (burn.length && Date.now() - burn[0][0] > 3600000) burn.shift()
  if (burn.length > 1 && Date.now() - burn[0][0] > 1800000) {
    const perH = (burn.at(-1)[1] - burn[0][1]) / 1e6 / ((burn.at(-1)[0] - burn[0][0]) / 3600000)
    if (perH > MAX_CR_H) fire(`BURN ${perH.toFixed(0)}M cache-read tokens/hour (> ${MAX_CR_H}M)`)
  }
}
scanTranscripts() // baseline: count what already happened, alert only on what happens next
burn.length = 0; for (const f of turns.keys()) if (turns.get(f) > MAX_TURNS) turns.delete(f)
// A failing check must not kill the watchdog silently: log it and keep watching; a real crash says why.
process.on('uncaughtException', e => { console.log('WATCHDOG: CRASH ' + String(e && e.stack || e).split(/\r?\n/).slice(0, 2).join(' ')); process.exit(3) })
const safeCheck = () => { try { check() } catch (e) { console.error('watchdog check error: ' + (e && e.message)) } }
setInterval(safeCheck, 60000)
safeCheck()
