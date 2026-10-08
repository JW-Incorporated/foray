// Token audit of a workflow run: per role and per unit, from subagent transcripts.
import fs from 'node:fs'
import path from 'node:path'
const dir = process.argv[2]
const roles = {}, units = {}, models = {}
let tot = { in: 0, cw: 0, cr: 0, out: 0, agents: 0, turns: 0 }
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.meta.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const tf = path.join(dir, f.replace('.meta.json', '.jsonl'))
  if (!fs.existsSync(tf)) continue
  const u = { in: 0, cw: 0, cr: 0, out: 0, turns: 0 }
  for (const line of fs.readFileSync(tf, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const us = e.message && e.message.usage; if (!us) continue
    u.in += us.input_tokens || 0; u.cw += us.cache_creation_input_tokens || 0; u.cr += us.cache_read_input_tokens || 0; u.out += us.output_tokens || 0; u.turns++
  }
  const label = meta.description || '?'
  const role = label.split(':')[0] + (label.endsWith(':opus') ? ':opus' : '')
  const m = label.match(/^\w+:(tactile|ambient):(?:redesign\/\w+-)?([\w-]+?)(?::|#|$)/)
  const unit = m ? m[1] + '/' + m[2] : '(other)'
  for (const [bag, key] of [[roles, role], [units, unit], [models, meta.model || '?']]) {
    const b = bag[key] || (bag[key] = { in: 0, cw: 0, cr: 0, out: 0, agents: 0, turns: 0 })
    b.in += u.in; b.cw += u.cw; b.cr += u.cr; b.out += u.out; b.agents++; b.turns += u.turns
  }
  tot.in += u.in; tot.cw += u.cw; tot.cr += u.cr; tot.out += u.out; tot.agents++; tot.turns += u.turns
}
const M = n => (n / 1e6).toFixed(1)
// "weight" ~ fresh input + cache writes + output*5 + cache reads/10 (a relative yardstick only)
const w = b => b.in + b.cw + b.out * 5 + b.cr / 10
const show = (title, bag, n) => {
  console.log(`\n${title} (M tokens: fresh-in / cache-write / cache-read / out; weight share)`)
  const T = w(tot)
  for (const [k, b] of Object.entries(bag).sort((a, b) => w(b[1]) - w(a[1])).slice(0, n))
    console.log(`  ${k.padEnd(34)} ${String(b.agents).padStart(4)} ag ${String(Math.round(b.turns / b.agents)).padStart(4)} turns/ag  ${M(b.in).padStart(6)} ${M(b.cw).padStart(7)} ${M(b.cr).padStart(8)} ${M(b.out).padStart(6)}  ${(100 * w(b) / T).toFixed(1).padStart(5)}%`)
}
console.log(`TOTAL ${tot.agents} agents, ${tot.turns} turns: fresh-in ${M(tot.in)}M, cache-write ${M(tot.cw)}M, cache-read ${M(tot.cr)}M, out ${M(tot.out)}M`)
show('By role', roles, 20)
show('By model', models, 5)
show('Top units', units, 14)
