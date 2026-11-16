// Copies VENOM's past spoken turns into the GBrain memory server.
//
//   node.exe scripts/gbrain-import.mjs [--memory-dir <dir>] [--report <file>] [--junk <regex>]...
//                                      [--write --url <base> --token-file <path> [--real-brain]]
//
// Dry run by default: reads the conversation log and the old Honcho outbox,
// sorts out junk and duplicates, prints counts and writes a report file. It
// sends nothing and never builds a provider. --write sends the turns one at a
// time; GBrain keys every page by its time and text, so a second run stores
// nothing new.
//
// The source files are only ever read. Stdout gets counts only: the owner's
// words go into the report file (in the temp folder) and nowhere else.
//
// What is read: this app's own memory folder and nothing else, i.e. the
// folder the bridge writes its conversation log to (memoryConfig in
// bridge/memory.mjs: VENOM_MEMORY_DIR, else ~/.venom/memory), or the folder
// named with --memory-dir. Inside it: conversations/YYYY-MM-DD.jsonl and
// outbox-honcho.json (turns that never reached Honcho), when they exist.
// --write uses the same VENOM_GBRAIN_URL / VENOM_GBRAIN_TOKEN_FILE settings
// as the bridge (see .env.example); the flags --url / --token-file win.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGbrainProvider, gbrainConfig, GBRAIN_REAL_PORT, GbrainError, turnSlug } from '../bridge/gbrain.mjs'
import { memoryConfig } from '../bridge/memory.mjs'

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/
const SAME_TURN_MS = 5000
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const text = (v) => (typeof v === 'string' ? v : '')
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/** The question in a form two copies of the same turn share. */
const norm = (s) => text(s).trim().replace(/\s+/g, ' ')

/** Milliseconds of a turn's time, or NaN. */
const msOf = (t) => new Date(t?.ts).getTime()

/** Day and time (local, like the log file names) of a turn. */
function whenOf(t) {
  const d = new Date(t?.ts)
  if (Number.isNaN(d.getTime())) return { day: t?.fileDay || 'unknown', time: '--:--:--' }
  return { day: localDate(d), time: localTime(d) }
}

/** The memory folder: the flag, else the app's own log folder (memoryConfig: VENOM_MEMORY_DIR, else ~/.venom/memory). */
export function memoryDirOf(flag, env = process.env) {
  return resolve(flag || memoryConfig(env).logDir)
}

/** Every file this script reads, so the final check can compare them. */
export function sourceFiles(memoryDir) {
  const out = []
  const outbox = join(memoryDir, 'outbox-honcho.json')
  if (existsSync(outbox)) out.push(outbox)
  const dir = join(memoryDir, 'conversations')
  try {
    for (const name of readdirSync(dir).sort()) if (DAY_FILE.test(name)) out.push(join(dir, name))
  } catch {}
  return out
}

/** (size, mtimeMs) of each file, keyed by path. */
export function snapshot(files) {
  const out = {}
  for (const f of files) {
    try {
      const s = statSync(f)
      out[f] = `${s.size}:${s.mtimeMs}`
    } catch {
      out[f] = 'missing'
    }
  }
  return out
}

/**
 * Reads the outbox and the day files (readFileSync only). A broken line is
 * listed in `unparsable`, never thrown. Missing files give empty lists.
 */
export function readSources(memoryDir) {
  const outbox = []
  const log = []
  const unparsable = []
  const outboxFile = join(memoryDir, 'outbox-honcho.json')
  if (existsSync(outboxFile)) {
    let data = null
    try {
      data = JSON.parse(stripBom(readFileSync(outboxFile, 'utf8')))
    } catch {
      unparsable.push({ file: outboxFile, line: 0 })
    }
    if (Array.isArray(data)) {
      data.forEach((t, i) => {
        if (t && typeof t === 'object') outbox.push({ ...t, source: 'outbox', file: outboxFile, line: i + 1 })
        else unparsable.push({ file: outboxFile, line: i + 1 })
      })
    } else if (data !== null) unparsable.push({ file: outboxFile, line: 0 })
  }
  const dir = join(memoryDir, 'conversations')
  let names = []
  try {
    names = readdirSync(dir).filter((n) => DAY_FILE.test(n)).sort()
  } catch {}
  for (const name of names) {
    const file = join(dir, name)
    let body = ''
    try {
      body = stripBom(readFileSync(file, 'utf8'))
    } catch {
      unparsable.push({ file, line: 0 })
      continue
    }
    body.split(/\r?\n/).forEach((raw, i) => {
      if (!raw.trim()) return
      try {
        const t = JSON.parse(raw)
        if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('not an object')
        log.push({ ...t, source: 'log', file, line: i + 1, fileDay: name.slice(0, 10) })
      } catch {
        unparsable.push({ file, line: i + 1 })
      }
    })
  }
  return { outbox, log, unparsable }
}

/** The reason a turn is not worth copying, or ''. Extra rules are RegExps or strings tested on the question. */
export function isJunk(turn, extraRegexes = []) {
  const user = text(turn?.user).trim()
  const assistant = text(turn?.assistant).trim()
  if (!user) return 'empty question'
  if (!assistant) return 'empty answer'
  if (/which model are you/i.test(user)) return 'asks which model'
  for (const r of extraRegexes) {
    const re = r instanceof RegExp ? r : new RegExp(String(r), 'i')
    if (re.test(user)) return `matches --junk ${re.source}`
  }
  return ''
}

const exactKey = (t) => JSON.stringify([text(t.ts), text(t.user), text(t.assistant)])

/**
 * Sorts the turns into what to copy, junk and duplicates. Log turns are
 * placed first so a turn in both keeps the log version (what the owner
 * heard); its outbox copy counts as a duplicate.
 */
export function planImport({ outbox = [], log = [] } = {}, { junk = [] } = {}) {
  const byTime = (a, b) => (msOf(a) || 0) - (msOf(b) || 0)
  const copy = []
  const skippedJunk = []
  const duplicates = []
  const kept = new Map() // normalised question -> kept turns
  const exact = new Set()
  for (const t of [...[...log].sort(byTime), ...[...outbox].sort(byTime)]) {
    const reason = isJunk(t, junk)
    if (reason) {
      skippedJunk.push({ ...t, reason })
      continue
    }
    const key = exactKey(t)
    if (exact.has(key)) {
      duplicates.push({ ...t, reason: 'exact repeat' })
      continue
    }
    const q = norm(t.user)
    const ms = msOf(t)
    const twin = (kept.get(q) || []).find((k) => Number.isFinite(ms) && Math.abs(msOf(k) - ms) <= SAME_TURN_MS)
    if (twin) {
      duplicates.push({ ...t, reason: twin.source === 'log' && t.source === 'outbox' ? 'also in the log' : 'same question within 5 s' })
      continue
    }
    exact.add(key)
    if (!kept.has(q)) kept.set(q, [])
    kept.get(q).push(t)
    copy.push(t)
  }
  copy.sort(byTime)
  return { copy, skippedJunk, duplicates }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Sends the plan's turns oldest first, one at a time. A retryable failure is
 * tried 3 more times with a pause; any failure left stops the run (nothing
 * is lost: a later run skips what is already there).
 */
export async function runImport(plan, provider, { pauseMs = 2000, retries = 3, onProgress = () => {} } = {}) {
  const res = { stored: 0, already: 0, failed: 0, error: '' }
  for (const t of plan.copy) {
    let attempt = 0
    for (;;) {
      try {
        const turn = { user: t.user, assistant: t.assistant, ts: t.ts, session: t.session }
        // A capture replayed with the same request id answers like a new
        // write, so the page is looked up first when the provider can.
        if (typeof provider.exists === 'function' && (await provider.exists(turn))) {
          res.already++
          break
        }
        const out = await provider.writeTurn(turn)
        if (out?.duplicate) res.already++
        else res.stored++
        break
      } catch (err) {
        if (err?.retryable && attempt < retries) {
          attempt++
          await sleep(pauseMs)
          continue
        }
        res.failed++
        res.error = err?.message ? String(err.message) : 'write failed'
        return res
      }
    }
    onProgress(res)
  }
  return res
}

/**
 * Whether the page of a turn is already in GBrain: one read-only get_page
 * by its slug. GBrain answers a replayed capture (same request id) exactly
 * like a fresh one, so this is the only way to count "already there".
 * Throws a GbrainError (never holding the token or any text) when the
 * server cannot answer.
 */
export function pageExists(cfg, { fetchImpl = globalThis.fetch } = {}) {
  let id = 0
  return async (turn) => {
    const slug = turnSlug(turn)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
    let res
    let body = ''
    try {
      res = await fetchImpl(`${cfg.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'get_page', arguments: { slug } } }),
        signal: ctrl.signal,
      })
      body = await res.text()
    } catch {
      throw new GbrainError(ctrl.signal.aborted ? `GBrain unreachable: timeout after ${cfg.timeoutMs} ms` : 'GBrain unreachable on lookup', 0)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const what = res.status === 401 || res.status === 403 ? `GBrain refused the key (${res.status})` : `GBrain ${res.status}`
      throw new GbrainError(`${what} on lookup`, res.status)
    }
    const data = body.split(/\r?\n/).find((l) => l.startsWith('data:'))
    let env = null
    try {
      env = JSON.parse(data ? data.slice(5).trim() : body)
    } catch {}
    const result = env?.result
    if (!result) throw new GbrainError('GBrain bad answer on lookup', 502)
    let inner = null
    try {
      inner = JSON.parse(result.content?.[0]?.text ?? '')
    } catch {}
    if (result.isError === true) {
      if (inner?.code === 'page_not_found') return false
      const code = /^[\w.-]{1,40}$/.test(String(inner?.code ?? '')) ? inner.code : 'error'
      throw new GbrainError(`GBrain refused lookup (${code})`, inner?.retryable === true ? 503 : 400, code)
    }
    return inner?.slug === slug
  }
}

const cut = (s, n) => {
  const t = norm(s)
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** Per-day counts for the table. */
export function dayTable(sources, plan) {
  const days = new Map()
  const row = (d) => {
    if (!days.has(d)) days.set(d, { log: 0, outbox: 0, copy: 0, junk: 0, dup: 0 })
    return days.get(d)
  }
  for (const t of sources.log) row(whenOf(t).day).log++
  for (const t of sources.outbox) row(whenOf(t).day).outbox++
  for (const t of plan.copy) row(whenOf(t).day).copy++
  for (const t of plan.skippedJunk) row(whenOf(t).day).junk++
  for (const t of plan.duplicates) row(whenOf(t).day).dup++
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/** The report text: every skipped line by day, then what would be copied. */
export function reportText(sources, plan, memoryDir) {
  const lines = [`# GBrain import report`, '', `Memory folder: ${memoryDir}`, `Made: ${new Date().toISOString()}`, '']
  const skipped = [
    ...plan.skippedJunk.map((t) => ({ ...t, why: `junk: ${t.reason}` })),
    ...plan.duplicates.map((t) => ({ ...t, why: `duplicate (${t.source}): ${t.reason}` })),
  ]
  lines.push(`## Skipped (${skipped.length})`, '')
  const byDay = new Map()
  for (const t of skipped) {
    const w = whenOf(t)
    if (!byDay.has(w.day)) byDay.set(w.day, [])
    byDay.get(w.day).push({ ...t, ...w })
  }
  for (const [day, list] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### ${day} (${list.length})`, '')
    list.sort((a, b) => a.time.localeCompare(b.time))
    for (const t of list) lines.push(`- ${day} ${t.time} | ${t.why} | ${cut(t.user, 120)}`)
    lines.push('')
  }
  if (sources.unparsable.length) {
    lines.push(`## Unparsable lines (${sources.unparsable.length})`, '')
    for (const u of sources.unparsable) lines.push(`- ${u.file} line ${u.line}`)
    lines.push('')
  }
  lines.push(`## Would copy (${plan.copy.length})`, '')
  for (const t of plan.copy) {
    const w = whenOf(t)
    lines.push(`- ${w.day} ${w.time} | ${t.source} | ${cut(t.user, 80)}`)
  }
  return lines.join('\n') + '\n'
}

const inside = (child, parent) => {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Flags. Throws on an unknown one. */
export function parseArgs(argv) {
  const o = { junk: [], write: false, realBrain: false, memoryDir: '', report: '', url: '', tokenFile: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--memory-dir') o.memoryDir = val()
    else if (a === '--report') o.report = val()
    else if (a === '--junk') o.junk.push(new RegExp(val(), 'i'))
    else if (a === '--url') o.url = val()
    else if (a === '--token-file') o.tokenFile = val()
    else if (a === '--write') o.write = true
    else if (a === '--real-brain') o.realBrain = true
    else throw new Error(`unknown flag ${a}`)
  }
  return o
}

async function main(argv) {
  let o
  try {
    o = parseArgs(argv)
  } catch (err) {
    console.log(`gbrain-import: ${err.message}`)
    return 2
  }
  const memoryDir = memoryDirOf(o.memoryDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const report = resolve(o.report || join(tmpdir(), `venom-gbrain-import-report-${stamp}.md`))
  for (const bad of [ROOT, join(homedir(), '.venom'), memoryDir]) {
    if (inside(report, bad)) {
      console.log(`gbrain-import: the report may not go inside ${bad}; pick a file in the temp folder`)
      return 2
    }
  }

  const files = sourceFiles(memoryDir)
  const before = snapshot(files)
  const sources = readSources(memoryDir)
  const plan = planImport(sources, { junk: o.junk })

  console.log(`memory folder: ${memoryDir}`)
  console.log(`found: outbox ${sources.outbox.length}, log ${sources.log.length}, unparsable ${sources.unparsable.length}`)
  console.log('')
  const head = ['day', 'in log', 'in outbox', 'would copy', 'junk', 'duplicate']
  const rows = dayTable(sources, plan).map(([d, r]) => [d, r.log, r.outbox, r.copy, r.junk, r.dup].map(String))
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const fmt = (r) => r.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(' | ')
  console.log(fmt(head))
  console.log(widths.map((w) => '-'.repeat(w)).join('-|-'))
  for (const r of rows) console.log(fmt(r))
  console.log('')
  const found = sources.outbox.length + sources.log.length
  console.log(
    `totals: found ${found} / would copy ${plan.copy.length} / skipped as junk ${plan.skippedJunk.length} / skipped as duplicate ${plan.duplicates.length}`,
  )
  writeFileSync(report, reportText(sources, plan, memoryDir), 'utf8')
  console.log(`report: ${report}`)

  let code = 0
  if (o.write) {
    const env = { ...process.env, VENOM_GBRAIN: '1' }
    delete env.NODE_TEST_CONTEXT
    if (o.url) env.VENOM_GBRAIN_URL = o.url
    if (o.tokenFile) env.VENOM_GBRAIN_TOKEN_FILE = o.tokenFile
    const cfg = gbrainConfig(env)
    if (cfg.port === GBRAIN_REAL_PORT && !o.realBrain) {
      console.log(`refused: port ${GBRAIN_REAL_PORT} is the real brain; add --real-brain to write there`)
      code = 2
    } else if (!cfg.enabled) {
      console.log(`refused: GBrain not usable (${cfg.why})`)
      code = 2
    } else {
      const provider = { ...createGbrainProvider(cfg), exists: pageExists(cfg) }
      console.log(`writing ${plan.copy.length} turns to ${provider.describe()}`)
      const res = await runImport(plan, provider, {
        onProgress: (r) => {
          const n = r.stored + r.already
          if (n % 25 === 0) console.log(`  ... ${n} of ${plan.copy.length}`)
        },
      })
      console.log(`stored ${res.stored} / already there ${res.already} / failed ${res.failed}`)
      if (res.failed) {
        console.log(`stopped: ${res.error}`)
        code = 1
      }
    }
  } else {
    console.log('dry run: nothing sent (add --write to copy)')
  }

  const after = snapshot(files)
  const same = files.every((f) => before[f] === after[f]) && sourceFiles(memoryDir).length === files.length
  console.log(`source files unchanged: ${same ? 'yes' : 'no'}`)
  return same ? code : code || 1
}

const isMain = (() => {
  try {
    return resolve(process.argv[1] || '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch {
    return false
  }
})()

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.log(`gbrain-import failed: ${err?.message || 'error'}`)
      process.exitCode = 1
    },
  )
}
