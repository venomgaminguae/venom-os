import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memoryConfig } from './memory.mjs'

/**
 * What the HUD's memory section shows: one row per memory source, each with
 * its true state from a check made when asked (GET /memory/sources).
 *
 * Status and counts only. A row never carries a file's text, a path, a key or
 * an error message: every `detail` is built from numbers and fixed words.
 * Every path is read from `env` at call time.
 */

export const SOURCE_IDS = ['honcho', 'notes', 'skills', 'vault', 'graph', 'log']

const LABELS = {
  honcho: 'Honcho',
  notes: 'Hermes notes',
  skills: 'Agent skills',
  vault: 'Obsidian vault',
  graph: 'Knowledge graph',
  log: 'Conversation log',
}

const CACHE_MS = 60_000
const DETAIL_MAX = 48
const SKILL_DEPTH = 5

const STATES = new Set(['connected', 'read-only', 'offline', 'not found', 'off'])
const LEVELS = new Set(['ok', 'warn', 'bad', 'quiet'])

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0)

const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null)

const part = (state, level, detail, updated = null) => ({ state, level, detail, updated })

const FAILED = () => part('not found', 'warn', 'check failed')

// --- caches (module level; resetMemorySourcesCache() empties them) ---------

let checks = new WeakMap() // long -> { at, promise }
let skillsCache = new Map() // root -> { at, value }
let graphCache = new Map() // path -> { key, nodes }
let logCache = new Map() // file -> { key, turns }

/** Forget every cached answer (tests). */
export function resetMemorySourcesCache() {
  checks = new WeakMap()
  skillsCache = new Map()
  graphCache = new Map()
  logCache = new Map()
}

async function statOrNull(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function dirents(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return null
  }
}

// --- 1. Honcho ---------------------------------------------------------------

/** long.check(), at most once a minute per long-memory object. */
function cachedCheck(long, now) {
  const t = now()
  const hit = checks.get(long)
  if (hit && t - hit.at < CACHE_MS) return hit.promise
  const promise = (async () => {
    try {
      if (typeof long.check === 'function') {
        const r = await long.check()
        return { ok: Boolean(r?.ok) }
      }
      return { ok: long.status?.()?.state === 'ok' }
    } catch {
      return { ok: false }
    }
  })()
  checks.set(long, { at: t, promise })
  return promise
}

export async function honchoRow(long, { now = Date.now } = {}) {
  if (!long || long.enabled === false) return part('off', 'quiet', 'off')
  const c = await cachedCheck(long, now)
  let st = {}
  try {
    st = long.status?.() ?? {}
  } catch {
    st = {}
  }
  const queued = count(st.queued)
  const sent = count(st.sent)
  const updated = iso(st.lastOkAt)
  if (!c.ok) return part('offline', 'warn', queued > 0 ? `${queued} waiting` : 'not answering', updated)
  if (st.writeFault === true) {
    const s = Number(st.lastStatus)
    const why = s === 402 ? 'out of credits' : s === 401 || s === 403 ? 'key refused' : 'writes failing'
    return part('read-only', 'warn', `${queued} waiting · ${why}`, updated)
  }
  if (!sent && !queued) return part('connected', 'ok', 'no write tried yet', updated)
  return part('connected', 'ok', `${sent} sent${queued > 0 ? ` · ${queued} waiting` : ''}`, updated)
}

// --- 2. Hermes notes -----------------------------------------------------------

/** Non-empty entries in one Hermes memory file (entries split by a line holding only `§`). */
export function countEntries(text) {
  return String(text ?? '')
    .replace(/^\ufeff/, '')
    .replace(/\r\n/g, '\n')
    .split('\n§\n')
    .filter((e) => e.trim()).length
}

export async function notesRow({ allowWrites = false, env = process.env } = {}) {
  const cfg = memoryConfig(env)
  if (!cfg.enabled) return part('off', 'quiet', 'off')
  let found = 0
  let entries = 0
  let newest = 0
  for (const name of ['MEMORY.md', 'USER.md']) {
    const path = join(cfg.hermesDir, name)
    const s = await statOrNull(path)
    if (!s?.isFile()) continue
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    found++
    entries += countEntries(text)
    newest = Math.max(newest, s.mtimeMs)
  }
  if (!found) return part('not found', 'warn', 'no notes files')
  return part(allowWrites ? 'connected' : 'read-only', 'ok', `${entries} entries`, iso(newest))
}

// --- 3. Agent skills ---------------------------------------------------------

/** The Hermes root: a profile's HERMES_HOME (<root>/profiles/<name>) points two levels up (see honcho.mjs). */
export function hermesRoot(env = process.env) {
  if (env.VENOM_HERMES_ROOT) return env.VENOM_HERMES_ROOT
  const home = env.HERMES_HOME || join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
  return basename(dirname(home)).toLowerCase() === 'profiles' ? dirname(dirname(home)) : home
}

/** SKILL.md files under `dir` (depth <= 5, dot folders skipped): { n, newest }. */
export async function countSkills(dir, depth = 0) {
  const out = { n: 0, newest: 0 }
  const list = await dirents(dir)
  if (!list) return out
  for (const d of list) {
    if (d.isFile() && d.name === 'SKILL.md') {
      const s = await statOrNull(join(dir, d.name))
      out.n++
      if (s) out.newest = Math.max(out.newest, s.mtimeMs)
    } else if (d.isDirectory() && !d.name.startsWith('.') && depth < SKILL_DEPTH) {
      const sub = await countSkills(join(dir, d.name), depth + 1)
      out.n += sub.n
      out.newest = Math.max(out.newest, sub.newest)
    }
  }
  return out
}

export async function skillsRow({ env = process.env, now = Date.now } = {}) {
  const root = hermesRoot(env)
  const hit = skillsCache.get(root)
  if (hit && now() - hit.at < CACHE_MS) return hit.value
  let value
  const rootSkills = join(root, 'skills')
  if (!(await statOrNull(rootSkills))?.isDirectory()) {
    value = part('not found', 'warn', 'no skills folder')
  } else {
    const main = await countSkills(rootSkills)
    let inProfiles = 0
    let profiles = 0
    let newest = main.newest
    for (const d of (await dirents(join(root, 'profiles'))) ?? []) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const c = await countSkills(join(root, 'profiles', d.name, 'skills'))
      if (!c.n) continue
      inProfiles += c.n
      profiles++
      newest = Math.max(newest, c.newest)
    }
    const tail = inProfiles ? ` · ${inProfiles} in ${profiles} ${profiles === 1 ? 'profile' : 'profiles'}` : ''
    value = part('read-only', 'ok', `${main.n} skills${tail}`, iso(newest))
  }
  skillsCache.set(root, { at: now(), value })
  return value
}

// --- 4. Obsidian vault -------------------------------------------------------

/** VENOM_VAULT_DIR, or null: there is no default vault, so none is looked for. */
export const vaultDir = (env = process.env) => env.VENOM_VAULT_DIR || null

export async function vaultRow({ env = process.env } = {}) {
  const dir = vaultDir(env)
  if (!dir) return part('not found', 'warn', 'no vault')
  const list = await dirents(dir)
  if (!list) return part('not found', 'warn', 'no vault')
  const notes = list.filter((d) => d.isFile() && /\.md$/i.test(d.name))
  if (!notes.some((d) => d.name.toLowerCase() === 'home.md')) return part('not found', 'warn', 'no home note')
  let newest = 0
  for (const d of notes) {
    const s = await statOrNull(join(dir, d.name))
    if (s) newest = Math.max(newest, s.mtimeMs)
  }
  return part('read-only', 'ok', `${notes.length} notes`, iso(newest))
}

// --- 5. Knowledge graph --------------------------------------------------------

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** VENOM_GRAPH_FILE, else this project's own graphify-out/graph.json. */
export function graphFile(env = process.env) {
  if (env.VENOM_GRAPH_FILE) return env.VENOM_GRAPH_FILE
  return join(PROJECT_ROOT, 'graphify-out', 'graph.json')
}

export async function graphRow({ env = process.env } = {}) {
  const path = graphFile(env)
  const s = await statOrNull(path)
  if (!s?.isFile()) return part('not found', 'warn', 'no graph')
  const key = `${s.mtimeMs}:${s.size}`
  let hit = graphCache.get(path)
  if (!hit || hit.key !== key) {
    let nodes = -1
    try {
      const data = JSON.parse((await readFile(path, 'utf8')).replace(/^\ufeff/, ''))
      if (Array.isArray(data?.nodes)) nodes = data.nodes.length
    } catch {
      nodes = -1
    }
    hit = { key, nodes }
    graphCache.set(path, hit)
  }
  if (hit.nodes < 0) return part('read-only', 'warn', 'unreadable', iso(s.mtimeMs))
  return part('read-only', 'ok', `${hit.nodes} nodes`, iso(s.mtimeMs))
}

// --- 6. Conversation log -------------------------------------------------------

export const countLines = (text) => String(text ?? '').split('\n').filter((l) => l.trim()).length

export async function logRow({ env = process.env } = {}) {
  const cfg = memoryConfig(env)
  if (!cfg.enabled) return part('off', 'quiet', 'off')
  const dir = join(cfg.logDir, 'conversations')
  const list = await dirents(dir)
  if (!list) return part('connected', 'ok', '0 turns') // made on the first turn
  let turns = 0
  let newest = 0
  for (const d of list) {
    if (!d.isFile() || !/\.jsonl$/i.test(d.name)) continue
    const file = join(dir, d.name)
    const s = await statOrNull(file)
    if (!s) continue
    const key = `${s.mtimeMs}:${s.size}`
    let hit = logCache.get(file)
    if (!hit || hit.key !== key) {
      let n = 0
      try {
        n = countLines(await readFile(file, 'utf8'))
      } catch {
        n = 0
      }
      hit = { key, turns: n }
      logCache.set(file, hit)
    }
    turns += hit.turns
    newest = Math.max(newest, s.mtimeMs)
  }
  return part('connected', 'ok', `${turns} turns`, iso(newest))
}

// --- all six -----------------------------------------------------------------

/** One row in the response shape; anything unexpected is clamped, never passed through. */
function finish(id, r) {
  const state = STATES.has(r?.state) ? r.state : 'not found'
  const level = LEVELS.has(r?.level) ? r.level : 'warn'
  const detail = String(r?.detail ?? '').slice(0, DETAIL_MAX)
  const updated = typeof r?.updated === 'string' && Number.isFinite(Date.parse(r.updated)) ? r.updated : null
  return { id, label: LABELS[id], state, level, detail, updated }
}

/** GET /memory/sources: `{ at, rows }`, all six rows in order. Never throws. */
export async function memorySources({ long, allowWrites = false, env = process.env, now = Date.now } = {}) {
  const checksFor = {
    honcho: () => honchoRow(long, { now }),
    notes: () => notesRow({ allowWrites, env }),
    skills: () => skillsRow({ env, now }),
    vault: () => vaultRow({ env }),
    graph: () => graphRow({ env }),
    log: () => logRow({ env }),
  }
  const results = await Promise.all(
    SOURCE_IDS.map(async (id) => {
      try {
        return finish(id, await checksFor[id]())
      } catch {
        return finish(id, FAILED())
      }
    }),
  )
  let at
  try {
    at = new Date(now()).toISOString()
  } catch {
    at = new Date().toISOString()
  }
  return { at, rows: results }
}
