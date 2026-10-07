#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const WT = path.resolve(path.dirname(SCRIPT), '..', '..', '..')
const REAL_ROOT = path.join(WT, 'data-local', 'redesign')
const REAL_WORKTREES = path.join(os.homedir(), 'fw')
const TRUNK = 'feature/redesign-2026'
const REPO = 'JW-Incorporated/foray'
const DRIVER_VERSION = 1
const CLAUDE_COOLDOWN_MS = 30 * 60 * 1000
const FABLE_MODEL = 'fable'
const COST_RULES = `Codex cost rules: run only the targeted suites while iterating; run the wider suite at most once, at the end. Summarise command output instead of echoing verbose logs. Do not re-read large files you have already read. Before doing anything else, read the repo's CLAUDE.md once for repository conventions.`

const STATUS = { type: 'object', properties: { ok: { type: 'boolean' }, alreadyMerged: { type: 'boolean' }, branch: { type: 'string' }, sha: { type: 'string' }, summary: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'summary'] }
const PLAN = { type: 'object', properties: { screens: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } } }, required: ['id', 'name', 'acceptance'] } }, foundation: { type: 'string' } }, required: ['screens', 'foundation'] }
const CHECK = { type: 'object', properties: { hardPass: { type: 'boolean' }, testsPass: { type: 'boolean' }, gatesPass: { type: 'boolean' }, newDebt: { type: 'array', items: { type: 'string' } }, baselineRegressions: { type: 'array', items: { type: 'string' } }, fidelity: { type: 'string' }, implShot: { type: 'string' }, protoShot: { type: 'string' }, todayShot: { type: 'string' }, sideBySide: { type: 'string' }, summary: { type: 'string' } }, required: ['hardPass', 'testsPass', 'gatesPass', 'summary'] }
const VERDICT = { type: 'object', properties: { winner: { type: 'string', enum: ['FIRST', 'SECOND', 'TIE'] }, confidence: { type: 'integer' }, reasons: { type: 'string' } }, required: ['winner', 'reasons'] }
const FIDELITY = { type: 'object', properties: { faithful: { type: 'boolean' }, deviations: { type: 'array', items: { type: 'string' } } }, required: ['faithful', 'deviations'] }
const REVIEW = { type: 'object', properties: { verdict: { type: 'string', enum: ['merge', 'fix'] }, blocking: { type: 'array', items: { type: 'string' } }, nits: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'blocking'] }
const QA = { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, where: { type: 'string' }, what: { type: 'string' }, repro: { type: 'string' } }, required: ['severity', 'what'] } } }, required: ['issues'] }

const FOUNDATION = [
  { id: 'p3-tokens', name: 'design tokens including motion tokens and the single reduced-motion block' },
  { id: 'p3-icons', name: 'SVG icon sprite (CSP-safe <use> references) shown in the gallery; screens swap their Unicode glyphs for it in Phase 4' },
  { id: 'p3-primitives', name: 'primitives (buttons, rows, cards, sheets, tab bar, artwork frame) on the tokens, shown in the gallery; screens adopt them in Phase 4' },
  { id: 'p3-gallery', name: 'component gallery at #/gallery behind the lab flag, recorded as the gallery baseline' },
]

const dirBranch = d => `${TRUNK}-${d}`
const safeLabel = value => String(value).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'step'
const iso = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const out = { command, directions: [], skipScreens: [], maxIters: 4, dryRun: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--directions') out.directions = String(rest[++i] || '').split(',').filter(Boolean)
    else if (arg === '--skip-screens') out.skipScreens = String(rest[++i] || '').split(',').filter(Boolean)
    else if (arg === '--max-iters') out.maxIters = Number(rest[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(out.maxIters) || out.maxIters < 1) throw new Error('--max-iters must be a positive integer')
  return out
}

function usage() {
  return [
    'Usage:',
    '  node docs/redesign-2026/workflows/build-directions.codex.mjs run --directions tactile,ambient [--skip-screens id,id] [--max-iters 4] [--dry-run]',
    '  node docs/redesign-2026/workflows/build-directions.codex.mjs status',
    '  node docs/redesign-2026/workflows/build-directions.codex.mjs selftest-worktree',
  ].join('\n')
}

function common(root) {
  return `You work on the 4a Redesign 2026 effort in the foray repo. Before anything else read, in the trunk checkout ${WT}: docs/redesign-2026/PLAN.md and docs/redesign-2026/build-loop.md, and follow build-loop.md exactly (it names every command, flag and path; pass --root ${root} where it says so, because your own worktree's data-local/ is empty). Rules that bite: never push to main, never open a PR into main, never push v* tags, never dispatch release.yml/pages.yml/android-release.yml; git add explicit paths only; never git restore / checkout -- / clean / reset --hard / bare stash; never commit screenshots or podcast artwork (renders stay under ${root}); every interpolation via esc(), every href/src via safeUrl(), strict CSP (no inline style=/script), localStorage only via the shim with cp_ keys; 44px tap targets, one reduced-motion block, WCAG AA; copy rules (why <=18 words, hooks <=16, banned words, no we/us/our, "subject" not "topic"); a new test names and runs its mutation, a new suite gets a floor in test/suite-integrity.test.js. Owner decisions recorded at the top of a direction's DIRECTION.md are final. Shoot every direction in its primary colour scheme with an explicit --scheme (build-loop.md). The owner is asleep: you and the direction's art director make every decision. Don't ask questions: decide, write it down, keep going.\n\n${COST_RULES}`
}

function validate(value, schema, at = '$') {
  if (!schema) return null
  if (schema.enum && !schema.enum.includes(value)) return `${at} is not one of ${schema.enum.join(', ')}`
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at} is not an object`
    for (const key of schema.required || []) if (!(key in value)) return `${at}.${key} is required`
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) {
        const error = validate(value[key], child, `${at}.${key}`)
        if (error) return error
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at} is not an array`
    for (let i = 0; i < value.length; i++) {
      const error = validate(value[i], schema.items, `${at}[${i}]`)
      if (error) return error
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${at} is not an integer`
  } else if (schema.type && typeof value !== schema.type) return `${at} is not a ${schema.type}`
  return null
}

function codexSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (schema.type === 'object') {
    const properties = Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, codexSchema(value)]))
    return { ...schema, properties, required: Object.keys(properties), additionalProperties: false }
  }
  if (schema.type === 'array') return { ...schema, items: codexSchema(schema.items) }
  return { ...schema }
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
}

function extractJson(text) {
  const clean = stripAnsi(text).trim()
  if (!clean) throw new Error('empty output')
  try { return JSON.parse(clean) } catch {}
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) } catch {}
  }
  for (let start = clean.indexOf('{'); start >= 0; start = clean.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') quoted = false
      } else if (ch === '"') quoted = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(clean.slice(start, i + 1)) } catch { break }
      }
    }
  }
  throw new Error('no JSON object found')
}

function cmdQuote(arg) {
  const value = String(arg)
  if (!/[\s"&|<>^()%!]/.test(value)) return value
  return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`
}

function spawnPortable(command, args, options) {
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    const line = [cmdQuote(command), ...args.map(cmdQuote)].join(' ')
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], options)
  }
  return spawn(command, args, options)
}

class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve()
  }

  async runExclusive(action) {
    let release
    const turn = new Promise(resolve => { release = resolve })
    const previous = this.tail
    this.tail = previous.then(() => turn, () => turn)
    await previous
    try { return await action() } finally { release() }
  }
}

function samePath(a, b) {
  const normalize = value => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(a) === normalize(b)
}

async function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const child = spawn('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      child.once('error', resolve)
      child.once('close', resolve)
    })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch {}
  }
}

async function runChild(command, args, { cwd, input = '', timeoutMs, stdoutPath, stderrPath, env = process.env }) {
  await fs.mkdir(path.dirname(stdoutPath), { recursive: true })
  const stdoutFile = createWriteStream(stdoutPath)
  const stderrFile = createWriteStream(stderrPath)
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let child
  try {
    child = spawnPortable(command, args, {
      cwd,
      env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    stdoutFile.end(); stderrFile.end()
    return { code: null, error, stdout, stderr, timedOut }
  }
  child.stdout.on('data', chunk => { stdoutFile.write(chunk); stdout = (stdout + chunk).slice(-1024 * 1024) })
  child.stderr.on('data', chunk => { stderrFile.write(chunk); stderr = (stderr + chunk).slice(-1024 * 1024) })
  const result = await new Promise(resolve => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }
    const timer = setTimeout(async () => {
      timedOut = true
      await killTree(child.pid)
      try { child.kill('SIGKILL') } catch {}
      finish({ code: null, signal: 'timeout' })
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); finish({ code: null, error }) })
    child.once('close', (code, signal) => { clearTimeout(timer); finish({ code, signal }) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
  await Promise.all([
    new Promise(resolve => { stdoutFile.once('error', resolve); stdoutFile.end(resolve) }),
    new Promise(resolve => { stderrFile.once('error', resolve); stderrFile.end(resolve) }),
  ])
  return { ...result, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut, pid: child.pid }
}

async function capture(command, args, { cwd = WT, timeoutMs = 10 * 60 * 1000, allowFailure = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foray-capture-'))
  try {
    const result = await runChild(command, args, { cwd, timeoutMs, stdoutPath: path.join(dir, 'out'), stderrPath: path.join(dir, 'err') })
    if (!allowFailure && (result.timedOut || result.code !== 0)) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error || result.code}`)
    return result
  } finally {
    await fs.rm(dir, { recursive: true })
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function createState(args) {
  return {
    version: DRIVER_VERSION,
    startedAt: iso(),
    updatedAt: iso(),
    completedAt: null,
    args: { directions: args.directions, skipScreens: args.skipScreens, maxIters: args.maxIters },
    currentSteps: {},
    directions: Object.fromEntries(args.directions.map(d => [d, { currentSteps: {}, units: {}, blocked: null, consecutiveImplementNulls: 0 }])),
    claudeDownUntil: null,
    fableCount: 0,
    labUrls: Object.fromEntries(args.directions.map(d => [d, []])),
  }
}

class Driver {
  constructor(args, options = {}) {
    this.args = args
    this.dry = !!args.dryRun
    this.root = options.root || REAL_ROOT
    this.driverDir = path.join(this.root, 'codex-driver')
    this.stepsDir = path.join(this.driverDir, 'steps')
    this.worktreesDir = this.dry ? path.join(this.driverDir, 'wt') : REAL_WORKTREES
    this.statePath = path.join(this.driverDir, 'state.json')
    this.logPath = path.join(this.driverDir, 'run.log')
    this.lockPath = path.join(this.driverDir, 'driver.lock')
    this.plansPath = path.join(this.driverDir, 'plans.json')
    this.summaryPath = path.join(this.driverDir, 'summary.json')
    this.state = createState(args)
    this.seq = 0
    this.writeChain = Promise.resolve()
    this.trunkChain = Promise.resolve()
    this.trunkGitMutex = new AsyncMutex()
    this.keepAwake = null
    this.activeChildren = new Set()
    this.fake = options.fake || null
    this.transcript = []
    this.reviewCounts = new Map()
    this.lockOwned = false
  }

  async initialise() {
    await fs.mkdir(this.stepsDir, { recursive: true })
    await fs.mkdir(this.worktreesDir, { recursive: true })
    await this.acquireLock()
    const old = await this.readJson(this.statePath)
    if (old && old.version === DRIVER_VERSION) {
      this.state = old
      this.state.startedAt = iso()
      this.state.completedAt = null
      this.state.args = { directions: this.args.directions, skipScreens: this.args.skipScreens, maxIters: this.args.maxIters }
      this.state.currentSteps = {}
      for (const d of this.args.directions) {
        this.state.directions[d] ||= { currentSteps: {}, units: {}, blocked: null, consecutiveImplementNulls: 0 }
        this.state.directions[d].currentSteps = {}
        this.state.labUrls[d] ||= []
      }
    }
    await this.persist()
    if (!this.dry) this.startKeepAwake()
  }

  async readJson(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }

  async acquireLock() {
    const body = JSON.stringify({ pid: process.pid, startedAt: iso() }, null, 2) + '\n'
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await fs.open(this.lockPath, 'wx')
        await handle.writeFile(body)
        await handle.close()
        this.lockOwned = true
        return
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = await this.readJson(this.lockPath)
        if (existing && pidAlive(existing.pid)) throw new Error(`driver already running as PID ${existing.pid} (started ${existing.startedAt})`)
        if (existing) await this.log(`taking over stale lock from PID ${existing.pid}`)
        await fs.unlink(this.lockPath).catch(unlinkError => { if (unlinkError.code !== 'ENOENT') throw unlinkError })
      }
    }
    throw new Error('could not acquire driver lock after stale-lock takeover')
  }

  async releaseLock() {
    if (!this.lockOwned) return
    const lock = await this.readJson(this.lockPath)
    if (lock?.pid === process.pid) await fs.unlink(this.lockPath).catch(() => {})
    this.lockOwned = false
  }

  startKeepAwake() {
    if (process.platform !== 'win32') return
    const parent = process.pid
    const ps = `$sig='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'; Add-Type -MemberDefinition $sig -Name Native -Namespace Foray; [Foray.Native]::SetThreadExecutionState(0x80000001) | Out-Null; try { while (Get-Process -Id ${parent} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 } } finally { [Foray.Native]::SetThreadExecutionState(0x80000000) | Out-Null }`
    this.keepAwake = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, stdio: 'ignore' })
    this.keepAwake.on('error', error => { this.log(`keep-awake helper failed: ${error.message}`) })
  }

  async stopKeepAwake() {
    if (this.keepAwake?.pid) await killTree(this.keepAwake.pid)
  }

  async log(line) {
    const rendered = `[${iso()}] ${line}`
    this.transcript.push(line)
    if (this.dry) console.log(line)
    await fs.mkdir(this.driverDir, { recursive: true })
    await fs.appendFile(this.logPath, rendered + '\n')
  }

  persist() {
    this.state.updatedAt = iso()
    const snapshot = JSON.stringify(this.state, null, 2) + '\n'
    const temp = `${this.statePath}.${process.pid}.tmp`
    this.writeChain = this.writeChain.then(async () => {
      await fs.writeFile(temp, snapshot)
      await fs.rename(temp, this.statePath)
    })
    return this.writeChain
  }

  async createStep(label, direction, unitId, prompt, schema) {
    const seq = ++this.seq
    const dir = path.join(this.stepsDir, `${String(seq).padStart(4, '0')}-${safeLabel(label)}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'prompt.md'), prompt)
    await fs.writeFile(path.join(dir, 'schema.json'), JSON.stringify(codexSchema(schema), null, 2) + '\n')
    return { seq, dir, label, direction, unitId }
  }

  async setCurrent(step, worktree = null) {
    const current = { label: step.label, direction: step.direction || null, startedAt: iso(), worktree }
    this.state.currentSteps[step.seq] = current
    if (step.direction && this.state.directions[step.direction]) this.state.directions[step.direction].currentSteps[step.seq] = current
    await this.persist()
  }

  async clearCurrent(step) {
    delete this.state.currentSteps[step.seq]
    if (step.direction && this.state.directions[step.direction]) delete this.state.directions[step.direction].currentSteps[step.seq]
    await this.persist()
  }

  async git(args, options = {}) {
    const cwd = options.cwd || WT
    const invoke = () => this.fake
      ? this.fake.git(args, { ...options, cwd })
      : capture('git', args, { cwd, allowFailure: options.allowFailure, timeoutMs: options.timeoutMs })
    if (samePath(cwd, WT) && !options.trunkLockHeld) return this.withTrunkGitLock(invoke)
    return invoke()
  }

  withTrunkGitLock(action) {
    return this.trunkGitMutex.runExclusive(action)
  }

  async createWorktree(step, baseRef) {
    await fs.mkdir(this.worktreesDir, { recursive: true })
    const seq = String(step.seq).padStart(4, '0')
    const tag = safeLabel(step.label).slice(0, Math.max(1, 24 - seq.length - 1))
    const worktree = path.join(this.worktreesDir, `${seq}-${tag}`)
    if (this.fake) {
      await fs.mkdir(worktree, { recursive: true })
      await this.log(`${step.label}: worktree ${worktree}`)
      return worktree
    }
    const fetched = await this.git(['fetch', 'origin'], { allowFailure: true })
    if (fetched.code !== 0) throw new Error(`git fetch origin failed before worktree creation: ${fetched.stderr || fetched.stdout}`)
    const result = await this.git(['-c', 'core.longpaths=true', 'worktree', 'add', '--detach', worktree, `origin/${baseRef}`], { allowFailure: true })
    if (result.code !== 0) throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`)
    await this.log(`${step.label}: worktree ${worktree}`)
    return worktree
  }

  async cleanupWorktree(worktree) {
    if (!worktree) return
    if (this.fake) return
    const status = await this.git(['status', '--porcelain'], { cwd: worktree, allowFailure: true })
    if (status.code === 0 && !status.stdout.trim()) {
      const removed = await this.git(['worktree', 'remove', worktree], { allowFailure: true })
      if (removed.code !== 0) await this.log(`could not remove clean worktree ${worktree}: ${removed.stderr || removed.stdout}`)
    } else {
      await this.log(`left worktree with uncommitted or unreadable state: ${worktree}`)
    }
  }

  async codexAttempt(step, attempt, { cwd, prompt, schema, effort, timeoutMs, images = [], model = 'gpt-5.6-sol' }) {
    if (this.fake) return this.fake.codexAttempt({ step, attempt, cwd, prompt, schema, effort, timeoutMs, images, model, driver: this })
    const last = path.join(step.dir, `last-message.attempt-${attempt}.txt`)
    const args = ['exec', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-C', cwd, '--output-schema', path.join(step.dir, 'schema.json'), '--output-last-message', last]
    for (const image of images.filter(Boolean)) args.push('-i', image)
    args.push('-')
    const result = await runChild('codex.cmd', args, {
      cwd,
      input: prompt,
      timeoutMs,
      stdoutPath: path.join(step.dir, `stdout.attempt-${attempt}.log`),
      stderrPath: path.join(step.dir, `stderr.attempt-${attempt}.log`),
    })
    if (result.timedOut || result.code !== 0) return { ok: false, reason: result.timedOut ? 'timeout' : `exit ${result.code}`, result }
    let text
    try { text = await fs.readFile(last, 'utf8') } catch { return { ok: false, reason: 'missing last-message', result } }
    try {
      const value = extractJson(text)
      const error = validate(value, schema)
      if (error) return { ok: false, reason: `invalid output: ${error}`, result }
      await fs.writeFile(path.join(step.dir, 'last-message.json'), JSON.stringify(value, null, 2) + '\n')
      return { ok: true, value, result }
    } catch (error) { return { ok: false, reason: `unparseable output: ${error.message}`, result } }
  }

  async codexStep({ label, direction, unitId, prompt, schema, effort, timeoutMs, baseRef, images = [], model }) {
    const fullPrompt = `${common(this.root)}\n\n${prompt}`
    const step = await this.createStep(label, direction, unitId, fullPrompt, schema)
    let worktree = null
    try {
      worktree = await this.createWorktree(step, baseRef || (direction ? dirBranch(direction) : TRUNK))
      await this.setCurrent(step, worktree)
      for (let attempt = 1; attempt <= 2; attempt++) {
        const outcome = await this.codexAttempt(step, attempt, { cwd: worktree, prompt: fullPrompt, schema, effort, timeoutMs, images, model })
        if (outcome.ok) return outcome.value
        await this.log(`${label}: Codex attempt ${attempt} failed (${outcome.reason})${attempt === 1 ? '; retrying' : ''}`)
      }
      return null
    } catch (error) {
      await this.log(`${label}: ${error.message}`)
      return null
    } finally {
      await this.clearCurrent(step)
      await this.cleanupWorktree(worktree)
    }
  }

  async claudeCall({ label, direction, unitId, prompt, schema, model }) {
    const step = await this.createStep(label, direction, unitId, prompt, schema)
    await this.setCurrent(step, null)
    try {
      if (this.fake) return this.fake.claudeCall({ step, prompt, schema, model, driver: this })
      const cwd = path.join(os.tmpdir(), 'foray-judge-cwd')
      await fs.mkdir(cwd, { recursive: true })
      const schemaInstruction = `\n\nReply only with a JSON object matching this schema:\n${JSON.stringify(schema)}`
      const claudeCommand = process.platform === 'win32' ? 'claude.exe' : 'claude'
      const result = await runChild(claudeCommand, ['-p', '--model', model, '--output-format', 'json', '--allowedTools', 'Read', '--add-dir', WT], {
        cwd,
        input: prompt + schemaInstruction,
        timeoutMs: 15 * 60 * 1000,
        stdoutPath: path.join(step.dir, 'stdout.log'),
        stderrPath: path.join(step.dir, 'stderr.log'),
      })
      const combined = `${result.stdout}\n${result.stderr}`
      if (result.timedOut || result.code !== 0 || /rate.?limit|usage.?limit|quota|you.ve hit your limit/i.test(combined)) return { ok: false, reason: result.timedOut ? 'timeout' : 'CLI/usage failure' }
      try {
        const outer = extractJson(result.stdout)
        const innerText = typeof outer?.result === 'string' ? outer.result : JSON.stringify(outer?.result ?? outer)
        const value = extractJson(innerText)
        const error = validate(value, schema)
        if (error) return { ok: false, reason: error }
        await fs.writeFile(path.join(step.dir, 'last-message.json'), JSON.stringify(value, null, 2) + '\n')
        return { ok: true, value }
      } catch (error) { return { ok: false, reason: error.message } }
    } finally {
      await this.clearCurrent(step)
    }
  }

  claudeAvailable() {
    return !this.state.claudeDownUntil || Date.now() >= Date.parse(this.state.claudeDownUntil)
  }

  async markClaudeDown(reason) {
    this.state.claudeDownUntil = new Date(Date.now() + CLAUDE_COOLDOWN_MS).toISOString()
    await this.persist()
    await this.log(`Claude unavailable (${reason}); using Codex until ${this.state.claudeDownUntil}`)
  }

  async judgment({ label, direction, unitId, prompt, schema, images, fidelity = false }) {
    if (this.claudeAvailable()) {
      if (fidelity) {
        const fable = await this.claudeCall({ label: `${label}:fable`, direction, unitId, prompt, schema, model: FABLE_MODEL })
        if (fable?.ok) {
          this.state.fableCount++
          await this.persist()
          return { value: fable.value, engine: 'claude-fable' }
        }
        await this.log(`${label}: Fable failed (${fable?.reason || 'unknown'}); trying Opus`)
        const opus = await this.claudeCall({ label: `${label}:opus`, direction, unitId, prompt, schema, model: 'opus' })
        if (opus?.ok) return { value: opus.value, engine: 'claude-opus' }
        await this.markClaudeDown(opus?.reason || fable?.reason || 'invalid response')
      } else {
        const opus = await this.claudeCall({ label: `${label}:opus`, direction, unitId, prompt, schema, model: 'opus' })
        if (opus?.ok) return { value: opus.value, engine: 'claude-opus' }
        await this.markClaudeDown(opus?.reason || 'invalid response')
      }
    } else {
      await this.log(`${label}: Claude cooling down; using Codex`)
    }
    const value = await this.codexStep({ label: `${label}:codex`, direction, unitId, prompt: `${prompt}\nReturn only the requested JSON object.`, schema, effort: 'high', timeoutMs: 60 * 60 * 1000, baseRef: dirBranch(direction), images })
    return value ? { value, engine: 'codex' } : null
  }

  async mergedOnDirection(d, work) {
    if (this.fake) return this.fake.mergedOnDirection(d, work)
    const fetched = await this.git(['fetch', 'origin'], { allowFailure: true })
    if (fetched.code !== 0) throw new Error(`git fetch origin failed: ${fetched.stderr || fetched.stdout}`)
    const found = await this.git(['log', `origin/${dirBranch(d)}`, '--merges', '--oneline', '--grep', `Merge ${work} into`], { allowFailure: true })
    if (found.code !== 0) throw new Error(`git log failed: ${found.stderr || found.stdout}`)
    return !!found.stdout.trim()
  }

  async resumableWork(d, work) {
    if (this.fake) return this.fake.resumableWork(d, work)
    const exists = await this.git(['rev-parse', '--verify', `refs/remotes/origin/${work}`], { allowFailure: true })
    if (exists.code !== 0) return false
    const count = await this.git(['rev-list', '--count', `origin/${dirBranch(d)}..origin/${work}`], { allowFailure: true })
    return count.code === 0 && Number(count.stdout.trim()) > 0
  }

  async verifyMerge(d, work) {
    if (this.fake) return this.fake.verifyMerge(d, work)
    const fetched = await this.git(['fetch', 'origin'], { allowFailure: true })
    if (fetched.code !== 0) return false
    const found = await this.git(['log', `origin/${dirBranch(d)}`, '--merges', '--oneline', '--grep', `Merge ${work} into`], { allowFailure: true })
    return found.code === 0 && !!found.stdout.trim()
  }

  async recordUnit(d, result) {
    this.state.directions[d].units[result.id] = result
    await this.persist()
    const outcome = result.skipped ? 'skipped' : result.merged ? 'merged' : `NOT merged (${result.reason})`
    const engines = result.engines?.length ? result.engines.join('+') : 'none'
    const line = `${d}/${result.id}: ${outcome}, iterations ${result.iterations || 0}, judged by ${engines}${result.unjudged ? ', UNJUDGED' : ''}${result.escalated ? ', escalated' : ''}`
    await this.log(line)
    await this.progress(line)
  }

  progress(line) {
    this.trunkChain = this.trunkChain.then(() => this.writeProgress(line)).catch(async error => { await this.log(`PROGRESS write failed: ${error.message}`) })
    return this.trunkChain
  }

  async writeProgress(line) {
    if (this.fake) { this.fake.progressLines.push(line); return }
    return this.withTrunkGitLock(async () => {
      const rel = 'docs/redesign-2026/PROGRESS.md'
      const file = path.join(WT, ...rel.split('/'))
      const git = (args, options = {}) => this.git(args, { ...options, cwd: WT, trunkLockHeld: true })
      await git(['fetch', 'origin', TRUNK])
      await git(['merge', '--ff-only', `origin/${TRUNK}`])
      const text = await fs.readFile(file, 'utf8')
      if (text.lastIndexOf('## Log') < 0) throw new Error('PROGRESS.md has no ## Log section')
      const prefix = text.endsWith('\n') ? '' : '\n'
      await fs.writeFile(file, `${text}${prefix}- ${new Date().toISOString().slice(0, 10)} — ${line}\n`)
      await git(['add', rel])
      await git(['commit', '-m', `docs: log redesign driver progress (${safeLabel(line).slice(0, 48)})`])
      let pushed = await git(['push', 'origin', TRUNK], { allowFailure: true })
      if (pushed.code !== 0) {
        await git(['fetch', 'origin', TRUNK])
        await git(['rebase', `origin/${TRUNK}`])
        pushed = await git(['push', 'origin', TRUNK], { allowFailure: true })
        if (pushed.code !== 0) throw new Error(`push rejected after one rebase: ${pushed.stderr || pushed.stdout}`)
      }
    })
  }

  async ensureBaseline() {
    return this.codexStep({
      label: 'baseline-trunk-app', unitId: 'trunk-app', schema: STATUS, effort: 'medium', timeoutMs: 60 * 60 * 1000, baseRef: TRUNK,
      prompt: `In this isolated worktree (do not modify tracked files), run node tools/ui-lab/baseline.mjs list --root ${this.root}. If no baseline named trunk-app exists, record one of the trunk's current app per build-loop.md (record --name trunk-app --target app --no-remote-images --root ${this.root}). Return ok=true when it exists.`,
    })
  }

  async loadPlans() {
    let plans = await this.readJson(this.plansPath) || {}
    for (const d of this.args.directions) {
      if (plans[d]) continue
      const extracted = await this.codexStep({
        label: `plan-extract-${d}`, direction: d, unitId: 'plan', schema: PLAN, effort: 'low', timeoutMs: 60 * 60 * 1000, baseRef: dirBranch(d),
        prompt: `Read docs/redesign-2026/directions/${d}/BUILD-PLAN.md on origin/${dirBranch(d)}. Extract its foundation summary and ordered screen list exactly. Each screen needs id, name, and every testable acceptance criterion. Do not modify files.`,
      })
      if (!extracted) throw new Error(`could not extract plan for ${d}`)
      plans = { ...plans, [d]: extracted }
      await fs.writeFile(this.plansPath, JSON.stringify(plans, null, 2) + '\n')
    }
    return plans
  }

  async review(d, work, unit, kind, second = false) {
    return this.codexStep({
      label: `review-${d}-${unit.id}${second ? '-second' : ''}`, direction: d, unitId: unit.id, schema: REVIEW, effort: 'high', timeoutMs: 60 * 60 * 1000, baseRef: dirBranch(d),
      prompt: `Code-review origin/${work} against origin/${dirBranch(d)} (git fetch origin; git diff origin/${dirBranch(d)}...origin/${work}), read-only. ${second ? 'Second look after fixes. ' : ''}It builds ${kind} "${unit.name}" for direction ${d}. Blocking = a hard-limit breach (security/CSP/esc/safeUrl, cp_ keys, a11y, copy rules, product principles), a correctness bug, a test that pins nothing (apply its named mutation in a scratch directory outside the repo and run it), a behaviour change to the current app outside the lab/redesign path, or committed images. Everything else is a nit. verdict=merge only with zero blocking items.`,
    })
  }

  async mergeWork(d, work, unit) {
    const result = await this.codexStep({
      label: `merge-${d}-${unit.id}`, direction: d, unitId: unit.id, schema: STATUS, effort: 'medium', timeoutMs: 30 * 60 * 1000, baseRef: dirBranch(d),
      prompt: `You are in an isolated git worktree. Run git fetch origin && git checkout -B ${dirBranch(d)} origin/${dirBranch(d)} && git merge --no-ff origin/${work} -m "Merge ${work} into ${dirBranch(d)}: ${unit.name}". If it conflicts, resolve keeping both sides' intent and say so. Run node --test test/suite-integrity.test.js and the suites the change touches (build-loop.md lists them). Push ${dirBranch(d)}. Then, per build-loop.md, re-record the rolling app baseline (and the gallery baseline if the gallery changed) with --root ${this.root}. Return ok=false only if the merge could not be pushed.`,
    })
    const verified = await this.verifyMerge(d, work)
    if (!verified) await this.log(`${d}/${unit.id}: merge not present on origin/${dirBranch(d)} (model said ${result?.ok ? 'ok' : 'not ok'})`)
    return verified
  }

  async buildUnit(d, unit, kind, phaseName, taste = true) {
    const work = `redesign/${d}-${unit.id}`
    const base = { id: unit.id, name: unit.name, phase: phaseName, engines: [], iterations: 0, unjudged: false, escalated: false }
    try {
      if (await this.mergedOnDirection(d, work)) {
        this.state.directions[d].consecutiveImplementNulls = 0
        await this.persist()
        return { ...base, merged: true, skipped: true }
      }
    } catch (error) {
      this.state.directions[d].consecutiveImplementNulls = 0
      await this.persist()
      return { ...base, merged: false, reason: `git preflight failed: ${error.message}` }
    }
    const resume = await this.resumableWork(d, work)
    const checkout = resume
      ? `A previous attempt pushed work to origin/${work}. Run git fetch origin && git checkout -B ${work} origin/${work}. Check the existing work against every acceptance criterion, finish whatever is missing, commit, and push ${work}. Never commit to ${dirBranch(d)} directly.`
      : `You are in an isolated git worktree. Run git fetch origin && git checkout -B ${work} origin/${dirBranch(d)}. Commit there and push with git push -u origin ${work} (force-push only this work branch if you must redo it). Never commit to ${dirBranch(d)} directly.`
    let impl = await this.codexStep({
      label: `implement-${d}-${unit.id}`, direction: d, unitId: unit.id, schema: STATUS, effort: 'high', timeoutMs: 120 * 60 * 1000, baseRef: dirBranch(d),
      prompt: `${checkout}\nDirection: ${d} (docs/redesign-2026/directions/${d}/DIRECTION.md, prototype in prototype/, screens.json). Build ${kind} "${unit.name}" per build-loop.md. Acceptance criteria:\n- ${unit.acceptance.join('\n- ')}\nRun the targeted tests and gates yourself before pushing. Return branch and sha.`,
    })
    const dirState = this.state.directions[d]
    if (!impl) dirState.consecutiveImplementNulls = (dirState.consecutiveImplementNulls || 0) + 1
    else dirState.consecutiveImplementNulls = 0
    await this.persist()
    if (!impl) return { ...base, merged: false, reason: 'implementer failed', implementNull: true, resumed: resume }
    if (!impl.ok) return { ...base, merged: false, reason: 'implementer failed', detail: impl.summary, resumed: resume }

    let last = null
    const allEngines = []
    const allVerdicts = []
    let everUnjudged = false
    for (let it = 1; it <= this.args.maxIters; it++) {
      const chk = await this.codexStep({
        label: `check-${d}-${unit.id}-it${it}`, direction: d, unitId: unit.id, schema: CHECK, effort: 'medium', timeoutMs: 60 * 60 * 1000, baseRef: dirBranch(d),
        prompt: `Verify origin/${work} (head ${impl.sha || 'latest'}) for ${kind} "${unit.name}" of direction ${d}, read-only except data-local renders. In this isolated worktree: git fetch origin && git checkout --detach origin/${work}. Run, per build-loop.md: the test suites the change touches, gates.mjs with the known-debt allow list (new debt = any violation not in it), baseline compare (rolling app + gallery): diffs outside "${unit.name}" are regressions UNLESS they come from shared components this unit deliberately changed per its acceptance criteria or the direction's BUILD-PLAN.md (e.g. tab bar, mini player, tokens); list those as intended in the summary, never as baselineRegressions, and fidelity.mjs for this screen against the prototype. Save renders under ${this.root}\\loop\\${d}\\${unit.id}\\it${it}\\ and return absolute paths to the implementation shot, the prototype shot, today's app shot of the same screen (if today has one) and the fidelity side-by-side. hardPass = tests pass AND no new gate debt AND no baseline regressions.`,
      })
      if (!chk) { last = { it, hardPass: false, error: 'checker died', faithful: true, beatsToday: true, unjudged: false, chk: null }; break }

      const requested = []
      if (taste && chk.sideBySide) {
        const prompt = `You are the art director for direction ${d}, checking that the build realises your design. Read ${WT}\\docs\\redesign-2026\\judge\\rubric.md and docs/redesign-2026/directions/${d}/DIRECTION.md in ${WT}. Look at the side-by-side ${chk.sideBySide} (left = the direction's prototype, right = the implementation), and the full shots ${chk.protoShot || ''} and ${chk.implShot || ''}. List only deviations that change the design's intent or quality (type, spacing rhythm, colour, hierarchy, motion cues, iconography, imagery treatment); real-data differences (titles, artwork) are not deviations. faithful=false if any such deviation exists. Do not modify files.`
        requested.push(this.judgment({ label: `fidelity-${d}-${unit.id}-it${it}`, direction: d, unitId: unit.id, prompt, schema: FIDELITY, images: [chk.sideBySide, chk.protoShot, chk.implShot], fidelity: true }).then(r => r && { ...r, kind: 'fidelity', order: null }))
      }
      if (taste && chk.implShot && chk.todayShot) {
        const compare = (first, second, order) => {
          const prompt = `You are a design judge. Read the rubric at ${WT}\\docs\\redesign-2026\\judge\\rubric.md and follow ${WT}\\docs\\redesign-2026\\judge\\protocol.md. Compare two screens of the same app (FIRST = ${first}, SECOND = ${second}). Judge the design as a whole. Return FIRST, SECOND or TIE, confidence 1-5, and the 2-3 decisive reasons in at most 50 words. Do not modify files.`
          return this.judgment({ label: `judge-${d}-${unit.id}-it${it}-${order}`, direction: d, unitId: unit.id, prompt, schema: VERDICT, images: [first, second] }).then(r => r && { ...r, kind: 'better', order, better: r.value.winner === (order === 'a' ? 'FIRST' : 'SECOND') })
        }
        requested.push(compare(chk.implShot, chk.todayShot, 'a'))
        requested.push(compare(chk.todayShot, chk.implShot, 'b'))
      }
      const judgments = (await Promise.all(requested)).filter(Boolean)
      for (const judgment of judgments) {
        allEngines.push(judgment.engine)
        allVerdicts.push({ iteration: it, kind: judgment.kind, order: judgment.order, engine: judgment.engine })
      }
      const fid = judgments.find(x => x.kind === 'fidelity')
      const better = judgments.filter(x => x.kind === 'better')
      const unjudged = requested.length > judgments.length
      everUnjudged ||= unjudged
      if (unjudged) await this.log(`${d}/${unit.id} iteration ${it}: UNJUDGED (${requested.length - judgments.length} requested verdict(s) unavailable)`)
      const faithful = !fid || fid.value.faithful
      const beatsToday = better.length === 0 || better.every(x => x.better)
      last = { it, hardPass: chk.hardPass, faithful, beatsToday, unjudged, chk, fid: fid?.value, better }
      const ds = this.state.directions[d]
      ds.iteration = { unit: unit.id, iteration: it, hardPass: chk.hardPass, faithful, beatsToday, unjudged, engines: [...new Set(allEngines)], verdicts: allVerdicts }
      await this.persist()
      if (chk.hardPass && (unjudged || (faithful && beatsToday))) break
      if (it === this.args.maxIters) break
      const feedback = [
        !chk.testsPass && `Tests fail: ${chk.summary}`,
        !chk.gatesPass && `New gate debt: ${(chk.newDebt || []).join('; ')}`,
        (chk.baselineRegressions || []).length && `Baseline regressions outside this screen: ${chk.baselineRegressions.join('; ')}`,
        !faithful && `Fidelity deviations: ${(fid?.value.deviations || []).join('; ')}`,
        !beatsToday && `Judges did not prefer it over today in both orders: ${better.map(x => x.value.reasons).join(' | ')}`,
      ].filter(Boolean).join('\n')
      impl = await this.codexStep({
        label: `fix-${d}-${unit.id}-it${it + 1}`, direction: d, unitId: unit.id, schema: STATUS, effort: 'high', timeoutMs: 120 * 60 * 1000, baseRef: dirBranch(d),
        prompt: `You are in an isolated git worktree. Run git fetch origin && git checkout -B ${work} origin/${work}. Fix ${kind} "${unit.name}" of direction ${d} (iteration ${it + 1} of ${this.args.maxIters}). Findings to address:\n${feedback}\nRe-run the targeted tests and gates, commit, push ${work}. Return the new sha.`,
      }) || impl
    }
    const engines = [...new Set(allEngines)]
    if (!last?.hardPass) return { ...base, merged: false, reason: last?.error || `hard checks failing after ${this.args.maxIters} iterations`, detail: last?.chk?.summary, iterations: last?.it || 0, engines, verdicts: allVerdicts, unjudged: everUnjudged, resumed: resume }

    let rv = await this.review(d, work, unit, kind)
    if (rv?.verdict === 'fix') {
      await this.codexStep({
        label: `fix-${d}-${unit.id}-review`, direction: d, unitId: unit.id, schema: STATUS, effort: 'high', timeoutMs: 120 * 60 * 1000, baseRef: dirBranch(d),
        prompt: `You are in an isolated git worktree. Run git fetch origin && git checkout -B ${work} origin/${work}. Fix these blocking review items, re-run the targeted tests and gates, commit, push ${work}:\n- ${rv.blocking.join('\n- ')}`,
      })
      rv = await this.review(d, work, unit, kind, true)
    }
    if (!rv || rv.verdict !== 'merge') return { ...base, merged: false, reason: 'review blocking', detail: rv?.blocking || 'reviewer died', iterations: last.it, engines, verdicts: allVerdicts, unjudged: everUnjudged, escalated: everUnjudged || !(last.faithful && last.beatsToday), resumed: resume }
    const merged = await this.mergeWork(d, work, unit)
    return { ...base, merged, reason: merged ? undefined : 'merge not verified on origin', iterations: last.it, engines, verdicts: allVerdicts, unjudged: everUnjudged, escalated: everUnjudged || !(last.faithful && last.beatsToday), judged: { faithful: last.faithful, beatsToday: last.beatsToday }, resumed: resume }
  }

  async dispatchLab(d, milestone) {
    let url = null
    if (this.fake) url = this.fake.lab(d, milestone)
    else {
      const run = await capture('gh', ['workflow', 'run', 'lab-build.yml', '--repo', REPO, '--ref', 'main', '-f', `ref=${dirBranch(d)}`, '-f', 'platforms=both'], { cwd: WT, allowFailure: true })
      if (run.code !== 0) { await this.log(`${d}: lab dispatch failed (${run.stderr || run.stdout})`); return null }
      await sleep(2000)
      const listed = await capture('gh', ['run', 'list', '--repo', REPO, '--workflow', 'lab-build.yml', '--limit', '1', '--json', 'url'], { cwd: WT, allowFailure: true })
      if (listed.code === 0) {
        try { url = JSON.parse(listed.stdout)[0]?.url || null } catch {}
      }
    }
    this.state.labUrls[d].push({ milestone, url, dispatchedAt: iso() })
    await this.persist()
    const line = `${d}: lab build dispatched (${milestone}) for ${dirBranch(d)}${url ? ` — ${url}` : ''}`
    await this.log(line)
    await this.progress(line)
    return url
  }

  async blockDirection(d) {
    const reason = '3 consecutive units returned null at the implement step'
    this.state.directions[d].blocked = { at: iso(), reason }
    await this.persist()
    await this.log(`${d}: BLOCKED — ${reason}`)
    await this.progress(`${d}: BLOCKED — ${reason}`)
  }

  async runDirection(d, plan, foundationList) {
    const found = []
    for (const f of foundationList) {
      const unit = { ...f, acceptance: [`Matches the ${d} decisions in docs/redesign-2026/directions/${d}/BUILD-PLAN.md`, 'Screens are not changed yet: the foundation adds the system and the gallery, and the app screens stay pixel-identical to the trunk-app baseline (they adopt the system screen by screen in Phase 4)', 'All suites the change touches pass; new tests carry executed mutations'] }
      const result = await this.buildUnit(d, unit, 'the foundation step', 'Foundation', false)
      found.push(result); await this.recordUnit(d, result)
      if (this.state.directions[d].consecutiveImplementNulls >= 3) { await this.blockDirection(d); return { direction: d, branch: dirBranch(d), foundation: found, screens: [], qa: null, blocked: true } }
    }
    await this.progress(`${d}: Phase 3 foundation ${found.filter(x => x.merged).length}/${foundationList.length} merged into ${dirBranch(d)}`)

    const skip = new Set(this.args.skipScreens)
    const screens = []
    let firstLab = this.state.labUrls[d].some(x => x.milestone === 'first-screen')
    for (const screen of plan.screens.filter(x => !skip.has(x.id))) {
      const result = await this.buildUnit(d, screen, 'the screen', 'Screens', true)
      screens.push(result); await this.recordUnit(d, result)
      if (!firstLab && result.merged) { await this.dispatchLab(d, 'first-screen'); firstLab = true }
      if (this.state.directions[d].consecutiveImplementNulls >= 3) { await this.blockDirection(d); return { direction: d, branch: dirBranch(d), foundation: found, screens, qa: null, blocked: true } }
    }
    await this.progress(`${d}: Phase 4 screens ${screens.filter(x => x.merged).length}/${screens.length} merged; escalated: ${screens.filter(x => x.escalated).map(x => x.id).join(', ') || 'none'}`)

    const lenses = ['security and CSP (esc/safeUrl, inline style, javascript:, cp_ keys)', 'accessibility (focus in sheets, 44px, reduced motion, contrast, screen reader labels)', 'behaviour parity with the current app (playback, queue, offline, onboarding, search) and the product principles', 'performance budget per build-loop.md (bundle size, first paint, long tasks on a mid-range phone profile)']
    const qaResults = await Promise.all(lenses.map((lens, i) => this.codexStep({
      label: `qa-${d}-${i}`, direction: d, unitId: `qa-${i}`, schema: QA, effort: 'high', timeoutMs: 60 * 60 * 1000, baseRef: dirBranch(d),
      prompt: `Adversarial QA of origin/${dirBranch(d)} through the lens: ${lens}. Read-only (scratch outside the repo). Use the harness (tools/ui-lab) and the test suites. Report only issues you reproduced, with repro steps.`,
    })))
    const issues = qaResults.filter(Boolean).flatMap(x => x.issues).filter(x => /block|high|critical/i.test(x.severity))
    let qaFix = null
    if (issues.length) {
      qaFix = await this.buildUnit(d, { id: 'p5-qa-fixes', name: 'QA fixes', acceptance: issues.map(x => `${x.where || ''}: ${x.what} (repro: ${x.repro || 'see QA'})`) }, 'the QA fix set', 'QA', false)
      await this.recordUnit(d, qaFix)
    }
    await this.dispatchLab(d, 'final')
    await this.progress(`${d}: Phase 5 QA ${issues.length} high-severity issues, fixes ${qaFix ? (qaFix.merged ? 'merged' : 'not merged') : 'not needed'}; final lab build dispatched`)
    return { direction: d, branch: dirBranch(d), foundation: found, screens, qa: { high: issues.length, fixes: qaFix } }
  }

  async run() {
    await this.initialise()
    try {
      await this.log(`driver start: directions=${this.args.directions.join(',')} maxIters=${this.args.maxIters}${this.dry ? ' DRY-RUN' : ''}`)
      const plans = this.fake ? this.fake.plans : await this.loadPlans()
      const baseline = await this.ensureBaseline()
      if (!baseline?.ok) await this.log('trunk baseline step did not report success; directions will continue')
      const foundation = this.fake?.foundation || FOUNDATION
      const results = await Promise.all(this.args.directions.map(async d => {
        try { return await this.runDirection(d, plans[d], foundation) }
        catch (error) { await this.log(`${d}: direction crashed: ${error.stack || error.message}`); return { direction: d, branch: dirBranch(d), error: error.message } }
      }))
      await this.trunkChain
      const summary = { results, fableCalls: this.state.fableCount, engines: Object.fromEntries(this.args.directions.map(d => [d, Object.values(this.state.directions[d].units).map(x => ({ id: x.id, engines: x.engines, unjudged: x.unjudged }))])), labUrls: this.state.labUrls }
      await fs.writeFile(this.summaryPath, JSON.stringify(summary, null, 2) + '\n')
      this.state.completedAt = iso(); await this.persist()
      const merged = results.flatMap(x => [...(x.foundation || []), ...(x.screens || []), ...(x.qa?.fixes ? [x.qa.fixes] : [])]).filter(x => x.merged && !x.skipped).length
      const unjudged = results.flatMap(x => [...(x.foundation || []), ...(x.screens || []), ...(x.qa?.fixes ? [x.qa.fixes] : [])]).filter(x => x.unjudged).length
      await this.progress(`Codex driver complete: ${merged} units merged, ${unjudged} unjudged; summary ${this.summaryPath}`)
      await this.trunkChain
      await this.log(`driver complete: ${merged} merged, ${unjudged} unjudged`)
      return summary
    } finally {
      await this.stopKeepAwake()
      await this.releaseLock()
    }
  }
}

class DryFake {
  constructor() {
    this.foundation = FOUNDATION.slice(0, 2)
    this.plans = {
      tactile: { foundation: 'dry tactile', screens: [
        { id: 'screen-pass', name: 'Pass first try', acceptance: ['passes'] },
        { id: 'screen-hard-fail', name: 'Hard checks fail', acceptance: ['never passes hard checks'] },
        { id: 'screen-review-fix', name: 'Review fixes and unjudged', acceptance: ['review fix then merge'] },
      ] },
      ambient: { foundation: 'dry ambient', screens: [
        { id: 'screen-null-1', name: 'Null implement one', acceptance: ['scripted null'] },
        { id: 'screen-null-2', name: 'Null implement two', acceptance: ['scripted null'] },
        { id: 'screen-null-3', name: 'Null implement three', acceptance: ['scripted null'] },
      ] },
    }
    this.progressLines = []
    this.calls = []
    this.merges = new Set()
    this.reviewCalls = new Map()
    this.labCalls = []
    this.claudeCalls = []
    this.gitEvents = []
  }

  async git(args) {
    const command = args.join(' ')
    this.gitEvents.push(`enter ${command}`)
    await sleep(5)
    this.gitEvents.push(`exit ${command}`)
    return { code: 0, stdout: '', stderr: '' }
  }
  async mergedOnDirection(d, work) { return d === 'tactile' && work.endsWith('-p3-tokens') }
  async resumableWork(d, work) { return d === 'tactile' && work.endsWith('-p3-icons') }
  async verifyMerge(d, work) { return this.merges.has(`${d}:${work}`) }
  lab(d, milestone) { const url = `https://example.invalid/${d}/${milestone}`; this.labCalls.push({ d, milestone }); return url }

  async codexAttempt({ step, attempt, prompt, schema }) {
    this.calls.push({ label: step.label, attempt, prompt })
    const label = step.label
    let value = null
    if (label === 'baseline-trunk-app') value = { ok: true, summary: 'baseline exists' }
    else if (label.startsWith('implement-ambient-screen-null-')) value = null
    else if (label.startsWith('implement-')) value = { ok: true, summary: 'implemented', branch: 'dry', sha: 'deadbeef' }
    else if (label.includes('screen-hard-fail') && label.startsWith('check-')) value = { hardPass: false, testsPass: false, gatesPass: true, newDebt: [], baselineRegressions: [], summary: 'scripted hard failure', implShot: 'impl.png', protoShot: 'proto.png', todayShot: 'today.png', sideBySide: 'side.png' }
    else if (label.startsWith('check-')) value = { hardPass: true, testsPass: true, gatesPass: true, newDebt: [], baselineRegressions: [], summary: 'clean', implShot: 'impl.png', protoShot: 'proto.png', todayShot: 'today.png', sideBySide: 'side.png' }
    else if (label.startsWith('fix-')) value = { ok: true, summary: 'fixed', sha: 'feedface' }
    else if (label.startsWith('review-')) {
      const key = label.replace('-second', '')
      const seen = this.reviewCalls.get(key) || 0
      this.reviewCalls.set(key, seen + 1)
      value = label.includes('screen-review-fix') && !label.endsWith('-second') ? { verdict: 'fix', blocking: ['scripted blocker'], nits: [] } : { verdict: 'merge', blocking: [], nits: [] }
    } else if (label.startsWith('merge-')) {
      const [, d, ...rest] = label.split('-')
      const unit = rest.join('-')
      this.merges.add(`${d}:redesign/${d}-${unit}`)
      value = { ok: true, summary: 'merged' }
    } else if (label.startsWith('qa-tactile-0')) value = { issues: [{ severity: 'high', where: 'dry', what: 'scripted QA issue', repro: 'always' }] }
    else if (label.startsWith('qa-')) value = { issues: [] }
    else if (label.includes(':codex')) {
      if (label.includes('screen-review-fix') && label.startsWith('fidelity-')) value = null
      else if (schema === FIDELITY) value = { faithful: true, deviations: [] }
      else value = { winner: label.endsWith('-b:codex') ? 'SECOND' : 'FIRST', confidence: 5, reasons: 'scripted Codex verdict' }
    }
    if (value === null) return { ok: false, reason: attempt === 1 ? 'scripted failure' : 'scripted terminal failure' }
    const error = validate(value, schema)
    return error ? { ok: false, reason: error } : { ok: true, value }
  }

  async claudeCall({ step, model }) {
    this.claudeCalls.push({ label: step.label, model })
    if (step.label.includes('fidelity-tactile-screen-pass') && model === FABLE_MODEL) return { ok: false, reason: 'scripted Fable failure' }
    if (step.label.includes('fidelity-tactile-screen-pass') && model === 'opus') return { ok: true, value: { faithful: true, deviations: [] } }
    if (step.label.includes('judge-tactile-screen-pass') && step.label.includes('-a:opus')) return { ok: false, reason: 'scripted Claude outage' }
    if (step.label.includes('fidelity-') && model === FABLE_MODEL) return { ok: true, value: { faithful: true, deviations: [] } }
    return { ok: true, value: { winner: step.label.includes('-b:') ? 'SECOND' : 'FIRST', confidence: 5, reasons: 'scripted Claude verdict' } }
  }
}

function assertDry(condition, message, assertions) {
  if (!condition) throw new Error(`DRY-RUN ASSERTION FAILED: ${message}`)
  assertions.push(message)
  console.log(`ASSERT ok: ${message}`)
}

async function dryRun(args) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foray-codex-driver-dry-'))
  const fake = new DryFake()
  const dryArgs = { ...args, directions: ['tactile', 'ambient'], dryRun: true }
  const driver = new Driver(dryArgs, { root: path.join(temp, 'redesign'), fake })
  try {
    const summary = await driver.run()
    const assertions = []
    const tactile = summary.results.find(x => x.direction === 'tactile')
    const ambient = summary.results.find(x => x.direction === 'ambient')
    const allTactile = [...tactile.foundation, ...tactile.screens, ...(tactile.qa?.fixes ? [tactile.qa.fixes] : [])]
    const get = id => allTactile.find(x => x.id === id)
    assertDry(get('p3-tokens')?.skipped, 'already-merged unit is skipped by the driver', assertions)
    assertDry(get('p3-icons')?.resumed && fake.calls.some(x => x.label === 'implement-tactile-p3-icons' && x.prompt.includes('previous attempt pushed work')), 'interrupted work branch uses the resume prompt', assertions)
    assertDry(get('screen-pass')?.merged && get('screen-pass').iterations === 1, 'screen passes on iteration 1', assertions)
    assertDry(!get('screen-hard-fail')?.merged && get('screen-hard-fail').iterations === args.maxIters, 'hard checks failing through max iterations do not merge', assertions)
    assertDry(get('screen-review-fix')?.merged && fake.calls.some(x => x.label === 'fix-tactile-screen-review-fix-review'), 'review fix is applied, reviewed again, and merged', assertions)
    assertDry(fake.claudeCalls.some(x => x.model === FABLE_MODEL) && fake.claudeCalls.some(x => x.label.includes('fidelity-tactile-screen-pass') && x.model === 'opus'), 'Fable failure falls back to Claude Opus', assertions)
    assertDry(get('screen-pass')?.engines.includes('codex') && driver.state.claudeDownUntil, 'Claude failure marks cooldown and falls back to Codex', assertions)
    assertDry(!fake.claudeCalls.some(x => x.label.includes('screen-review-fix')), 'later judges skip Claude during cooldown', assertions)
    assertDry(get('screen-review-fix')?.unjudged, 'a verdict unavailable from every engine is marked UNJUDGED', assertions)
    assertDry(fake.labCalls.filter(x => x.d === 'tactile' && x.milestone === 'first-screen').length === 1, 'exactly one first-screen lab dispatch occurs', assertions)
    assertDry(tactile.qa.high === 1 && tactile.qa.fixes?.merged, 'high QA issue creates and merges a QA-fix unit', assertions)
    assertDry(ambient.blocked && ambient.screens.length === 3 && ambient.screens.every(x => x.implementNull), 'three consecutive implement nulls block only that direction', assertions)
    assertDry(!tactile.blocked, 'the other direction continues after its peer is blocked', assertions)
    assertDry(fake.progressLines.some(x => x.includes('UNJUDGED')) && fake.progressLines.some(x => x.includes('BLOCKED')), 'progress records UNJUDGED and BLOCKED outcomes', assertions)
    fake.gitEvents = []
    const gitSequence = name => driver.withTrunkGitLock(async () => {
      await driver.git([`dry-${name}-1`], { cwd: WT, trunkLockHeld: true })
      await driver.git([`dry-${name}-2`], { cwd: WT, trunkLockHeld: true })
    })
    await Promise.all([gitSequence('sequence-a'), gitSequence('sequence-b')])
    const entered = fake.gitEvents.filter(event => event.startsWith('enter ')).map(event => event.match(/sequence-[ab]/)?.[0])
    assertDry(entered.join(',') === 'sequence-a,sequence-a,sequence-b,sequence-b' || entered.join(',') === 'sequence-b,sequence-b,sequence-a,sequence-a', 'concurrent trunk git sequences never interleave', assertions)
    console.log(`DRY-RUN PASS: ${assertions.length} scenario assertions; ${fake.calls.length} Codex attempts; ${fake.claudeCalls.length} Claude calls; ${fake.labCalls.length} lab dispatches`)
    return summary
  } finally {
    const resolved = path.resolve(temp)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error(`refusing to remove unexpected temp path: ${resolved}`)
    await fs.rm(resolved, { recursive: true })
  }
}

function counts(direction) {
  const units = Object.values(direction?.units || {})
  return {
    merged: units.filter(x => x.merged && !x.skipped).length,
    skipped: units.filter(x => x.skipped).length,
    notMerged: units.filter(x => !x.merged).length,
    unjudged: units.filter(x => x.unjudged).length,
    codexJudged: units.filter(x => x.engines?.includes('codex')).length,
  }
}

async function status() {
  const dir = path.join(REAL_ROOT, 'codex-driver')
  const read = async name => { try { return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) } catch { return null } }
  const lock = await read('driver.lock')
  const state = await read('state.json')
  console.log(`Lock: ${lock ? `PID ${lock.pid}, ${pidAlive(lock.pid) ? 'alive' : 'stale'}, started ${lock.startedAt}` : 'none'}`)
  if (!state) console.log('State: none')
  else {
    const active = Object.values(state.currentSteps || {})
    console.log(`Current steps: ${active.length ? active.map(x => `${x.label} (${x.direction || 'global'}, since ${x.startedAt}, worktree ${x.worktree || 'none'})`).join('; ') : 'none'}`)
    for (const [d, value] of Object.entries(state.directions || {})) {
      const current = Object.values(value.currentSteps || {})
      console.log(`${d}: ${current.length ? current.map(x => `${x.label} (since ${x.startedAt}, worktree ${x.worktree || 'none'})`).join('; ') : 'idle'}`)
      const c = counts(value)
      console.log(`  merged=${c.merged} skipped=${c.skipped} not-merged=${c.notMerged} unjudged=${c.unjudged} codex-judged=${c.codexJudged}${value.blocked ? ' BLOCKED' : ''}`)
    }
    console.log(`Claude down-until: ${state.claudeDownUntil || 'not down'}`)
    console.log(`Fable successful calls: ${state.fableCount || 0}`)
    const urls = Object.entries(state.labUrls || {}).flatMap(([d, entries]) => entries.map(x => `${d}/${x.milestone}: ${x.url || '(URL unavailable)'}`))
    console.log(`Lab URLs: ${urls.length ? urls.join('; ') : 'none'}`)
  }
  console.log('Last 15 run.log lines:')
  try {
    const lines = (await fs.readFile(path.join(dir, 'run.log'), 'utf8')).trimEnd().split(/\r?\n/).slice(-15)
    console.log(lines.join('\n') || '(empty)')
  } catch { console.log('(no run.log)') }
}

async function smokeCodex() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foray-codex-smoke-'))
  const args = { directions: [], skipScreens: [], maxIters: 1, dryRun: false }
  const driver = new Driver(args, { root: path.join(temp, 'redesign') })
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  const step = await driver.createStep('smoke-codex', null, 'smoke', 'Return only {"ok":true}.', schema)
  const model = process.env.CODEX_DRIVER_SMOKE_MODEL || 'gpt-5.3-codex-spark'
  const result = await driver.codexAttempt(step, 1, { cwd: WT, prompt: 'Return only {"ok":true}.', schema, effort: 'low', timeoutMs: 10 * 60 * 1000, model })
  console.log(JSON.stringify({ smoke: 'codex', model, ok: result.ok, value: result.value, reason: result.reason }))
  if (!result.ok) process.exitCode = 1
}

async function smokeClaude() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foray-claude-smoke-'))
  const args = { directions: [], skipScreens: [], maxIters: 1, dryRun: false }
  const driver = new Driver(args, { root: path.join(temp, 'redesign') })
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  for (const model of ['haiku', FABLE_MODEL, ...(FABLE_MODEL === 'fable' ? ['claude-fable-5-1'] : [])]) {
    const result = await driver.claudeCall({ label: `smoke-claude-${model}`, prompt: 'Return only {"ok":true}.', schema, model })
    console.log(JSON.stringify({ smoke: 'claude', model, ok: result?.ok, value: result?.value, reason: result?.reason }))
    if (model === 'haiku' && !result?.ok) process.exitCode = 1
    if (model === FABLE_MODEL && result?.ok) break
  }
}

async function selftestWorktree() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foray-worktree-selftest-'))
  const args = { directions: [], skipScreens: [], maxIters: 1, dryRun: false }
  const driver = new Driver(args, { root: path.join(temp, 'redesign') })
  driver.seq = 1000 + Math.floor(Date.now() / 1000) % 8000
  const step = await driver.createStep('selftest-worktree', null, 'selftest', 'Worktree path self-test.', STATUS)
  let worktree = null
  try {
    worktree = await driver.createWorktree(step, TRUNK)
    const deep = path.join(worktree, 'mobile', 'plugins', 'foray-audio', 'android', 'foray-engine-core-jvm', 'src', 'main', 'java', 'ai', 'jwlabs', 'foura', 'engine')
    const stat = await fs.stat(deep)
    if (!stat.isDirectory()) throw new Error(`deep path is not a directory: ${deep}`)
    await driver.cleanupWorktree(worktree)
    try {
      await fs.access(worktree)
      throw new Error(`clean worktree still exists after removal: ${worktree}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    console.log(JSON.stringify({ selftest: 'worktree', ok: true, worktree, deepPath: deep, removedWithoutForce: true }))
  } finally {
    const resolved = path.resolve(temp)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error(`refusing to remove unexpected temp path: ${resolved}`)
    await fs.rm(resolved, { recursive: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'status') return status()
  if (args.command === 'smoke-codex') return smokeCodex()
  if (args.command === 'smoke-claude') return smokeClaude()
  if (args.command === 'selftest-worktree') return selftestWorktree()
  if (args.command !== 'run') { console.log(usage()); if (args.command !== 'help') process.exitCode = 2; return }
  if (!args.dryRun && !args.directions.length) throw new Error('--directions is required')
  if (args.dryRun) return dryRun(args)
  const driver = new Driver(args)
  const shutdown = async signal => {
    await driver.log(`received ${signal}; stopping active process trees`)
    for (const pid of driver.activeChildren) await killTree(pid)
    await driver.stopKeepAwake()
    await driver.releaseLock()
    process.exit(130)
  }
  process.once('SIGINT', () => { shutdown('SIGINT') })
  process.once('SIGTERM', () => { shutdown('SIGTERM') })
  await driver.run()
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
