import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The GBrain provider for VENOM's long-term memory.
 *
 * GBrain is a memory server that runs on this PC (127.0.0.1:3131). VENOM
 * writes every finished spoken turn into it as one page under venom-os/ and
 * reads it back with a recall search and the owner's entity card. Plain
 * fetch against its MCP endpoint (one JSON-RPC tools/call per request, the
 * answer comes back as a server-sent event), no SDK.
 *
 * It is used only when VENOM_GBRAIN=1. bridge/settings.mjs (applyMemorySetting)
 * sets that from "gbrain": true in venom.config.json when the variable is not
 * set at all; VENOM_GBRAIN=0 in the environment switches it off.
 *
 * This file knows only GBrain. The bridge never calls it directly: it goes
 * through bridge/longmemory.mjs, like the Honcho provider.
 *
 * The token lives only in the config object. It is never logged, never put
 * in an error message and never returned by anything else here. It is only
 * ever sent to a server on this PC.
 */

export const GBRAIN_REAL_PORT = 3131

const DEFAULT_URL = `http://127.0.0.1:${GBRAIN_REAL_PORT}`
const MAX_CONTENT = 25000
const MAX_QUERY = 4000
const MAX_HITS = 20
const MAX_CARD = 12
const HEALTH_MS = 1500
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')

/** The real token file in the home folder of whoever runs the bridge. */
const defaultTokenFile = () => join(homedir(), '.gbrain', 'tokens', 'venom-os.token')

/** The first non-empty line of the token file, or ''. Never throws. */
function readToken(path) {
  try {
    const body = stripBom(readFileSync(path, 'utf8'))
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim()
      if (line) return line
    }
  } catch {}
  return ''
}

const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** The settings, read at call time (never at module load). Never throws. */
export function gbrainConfig(env = process.env) {
  const selected = env.VENOM_GBRAIN === '1'
  let baseUrl = str(env.VENOM_GBRAIN_URL) || DEFAULT_URL
  baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/mcp$/i, '').replace(/\/+$/, '')
  let url = null
  try {
    url = new URL(baseUrl)
  } catch {}
  const port = url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : 0
  const t = Number(env.VENOM_GBRAIN_TIMEOUT_MS)
  const cfg = {
    selected,
    enabled: false,
    why: '',
    baseUrl,
    port,
    tokenFile: str(env.VENOM_GBRAIN_TOKEN_FILE) || defaultTokenFile(),
    token: '',
    owner: str(env.VENOM_GBRAIN_OWNER) || 'owner',
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 3000,
    startCmd: str(env.VENOM_GBRAIN_START_CMD) || join(homedir(), '.gbrain', 'start-gbrain-server.cmd'),
    // The start script starts the server on its usual port: it is not run
    // for another address unless a script was named for it.
    autostart: port === GBRAIN_REAL_PORT || Boolean(str(env.VENOM_GBRAIN_START_CMD)),
  }

  if (!selected) cfg.why = 'VENOM_GBRAIN not set'
  else if (!url || !LOOPBACK.has(url.hostname)) cfg.why = 'GBrain URL is not on this PC'
  else if (env.NODE_TEST_CONTEXT && !testRunAllowed(env, url, cfg.tokenFile)) cfg.why = 'test run'
  else {
    cfg.token = readToken(cfg.tokenFile)
    if (!cfg.token) cfg.why = 'no token file'
  }
  cfg.enabled = selected && cfg.why === ''
  return cfg
}

/**
 * A `node --test` run may only talk to a fake server: an explicit URL whose
 * port is set and is not the real one, and an explicit token file that is
 * not the real one.
 */
function testRunAllowed(env, url, tokenFile) {
  if (!str(env.VENOM_GBRAIN_URL)) return false
  if (!url.port || Number(url.port) === GBRAIN_REAL_PORT) return false
  if (!str(env.VENOM_GBRAIN_TOKEN_FILE)) return false
  if (samePath(tokenFile, defaultTokenFile())) return false
  return true
}

/** A failed GBrain call. status 0 means network error or timeout. */
export class GbrainError extends Error {
  constructor(message, status = 0, code = '') {
    super(message)
    this.name = 'GbrainError'
    this.status = status
    this.code = code
    this.retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500
  }
}

/** A Date from a Date or an ISO string; now when missing or invalid. */
function toDate(ts) {
  if (ts === undefined || ts === null) return new Date()
  const d = ts instanceof Date ? new Date(ts.getTime()) : new Date(ts)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

const isoOrEmpty = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/** The ISO time, both sides cut to size, and the sha256 of all three. */
function turnParts({ user, assistant, ts } = {}) {
  const iso = toDate(ts).toISOString()
  const u = String(user ?? '').slice(0, MAX_CONTENT)
  const a = String(assistant ?? '').slice(0, MAX_CONTENT)
  const hash = createHash('sha256').update(`${iso}\n${u}\n${a}`).digest('hex')
  return { iso, user: u, assistant: a, hash }
}

/** The page text of one turn. */
export function turnContent(turn) {
  const p = turnParts(turn)
  return `# Venom OS voice turn ${p.iso}\n\nOwner: ${p.user}\n\nVenom: ${p.assistant}`
}

const slugOf = (p) =>
  `venom-os/${p.iso.slice(0, 10)}/t${p.iso.slice(11, 13)}${p.iso.slice(14, 16)}${p.iso.slice(17, 19)}-${p.hash.slice(0, 8)}`

/** 'venom-os/YYYY-MM-DD/tHHMMSS-<8 hex>' (UTC), stable for the same turn. */
export function turnSlug(turn) {
  return slugOf(turnParts(turn))
}

const TURN_RE = /^# Venom OS voice turn (\S+)\n\nOwner: ([\s\S]*?)\n\nVenom: ([\s\S]*)$/

/** Reads a page written by turnContent. { when, user, assistant } or null. */
export function parseTurn(text) {
  if (typeof text !== 'string') return null
  const m = TURN_RE.exec(stripBom(text).replace(/\r\n/g, '\n').trim())
  if (!m) return null
  return { when: isoOrEmpty(m[1]), user: m[2].trim(), assistant: m[3].trim() }
}

const WRAP_RE = /^\s*\[[^\]\n]*\][ \t]*\r?\n```[a-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/

/** The real text inside GBrain's "[quoted ... excerpt]" fence, or the text as is. */
function unwrap(text) {
  if (typeof text !== 'string') return ''
  const m = WRAP_RE.exec(text)
  return m ? m[1] : text
}

/** A short, safe code word from the server (never free text). */
const safeCode = (c) => {
  const s = String(c ?? '')
  return /^[\w.-]{1,40}$/.test(s) ? s : 'error'
}

/**
 * One fetch with a hard timeout (AbortController + race). Returns the
 * Response. Throws GbrainError status 0 on network failure or timeout.
 */
async function timedFetch(fetchImpl, url, init, ms, label, read) {
  const ctrl = new AbortController()
  let timer
  const late = () => new GbrainError(`GBrain unreachable: timeout after ${ms} ms`, 0)
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(late())
    }, ms)
  })
  try {
    const work = (async () => {
      let res
      try {
        res = await fetchImpl(url, { ...init, signal: ctrl.signal })
      } catch (err) {
        if (ctrl.signal.aborted) throw late()
        const code = err?.cause?.code || err?.code || err?.name || 'network error'
        throw new GbrainError(`GBrain unreachable: ${safeCode(code)} on ${label}`, 0)
      }
      let text = ''
      try {
        text = await res.text()
      } catch {
        if (ctrl.signal.aborted) throw late()
      }
      return read(res, text)
    })()
    // If the timeout wins, a late failure of `work` must not go unhandled.
    work.catch(() => {})
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The HTTP failure in words; the body is never copied. */
function httpError(status, label) {
  const what = status === 401 || status === 403 ? `GBrain refused the key (${status})` : `GBrain ${status}`
  return new GbrainError(`${what} on ${label}`, status)
}

/** The JSON-RPC envelope from an event stream (first data: line) or plain JSON. */
function parseEnvelope(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try {
      return JSON.parse(line.slice(5).trim())
    } catch {
      break
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The provider object the long-term memory layer drives. */
export function createGbrainProvider(cfg = gbrainConfig(), { fetchImpl = globalThis.fetch } = {}) {
  let rpcId = 0
  const msOf = (timeoutMs) => (Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeoutMs)

  /** GET /health. Resolves to the parsed body; throws GbrainError. */
  function health({ timeoutMs, label = 'health' } = {}) {
    return timedFetch(fetchImpl, `${cfg.baseUrl}/health`, { method: 'GET' }, msOf(timeoutMs), label, (res, text) => {
      if (!res || !res.ok) throw httpError(res?.status ?? 0, label)
      let body = null
      try {
        body = JSON.parse(text)
      } catch {}
      if (body?.status !== 'ok') throw new GbrainError(`GBrain not ready on ${label}`, 503)
      return body
    })
  }

  /**
   * One MCP tools/call. Returns the tool's own answer (the parsed inner
   * JSON). Throws GbrainError; the message never holds the token, the query
   * or any turn text.
   */
  function tool(name, args, { label = name, timeoutMs } = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    const init = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
    }
    return timedFetch(fetchImpl, `${cfg.baseUrl}/mcp`, init, msOf(timeoutMs), label, (res, text) => {
      if (!res || !res.ok) throw httpError(res?.status ?? 0, label)
      const env = parseEnvelope(text)
      if (!env || typeof env !== 'object') throw new GbrainError(`GBrain bad answer on ${label}`, 502)
      if (env.error) throw new GbrainError(`GBrain refused ${label} (rpc ${safeCode(env.error.code)})`, 400, 'rpc')
      const result = env.result || {}
      const raw = Array.isArray(result.content) ? result.content.find((c) => c?.type === 'text')?.text : undefined
      let inner = null
      try {
        inner = typeof raw === 'string' ? JSON.parse(raw) : null
      } catch {}
      if (result.isError === true) {
        const code = safeCode(inner?.code)
        const status =
          inner?.retryable === true ? 503 : /scope|forbidden|unauthori|permission|denied/i.test(code) ? 403 : 400
        throw new GbrainError(`GBrain refused ${label} (${code})`, status, code)
      }
      return inner
    })
  }

  return {
    name: 'gbrain',
    label: 'GBrain',

    /** A one-line summary, safe to log: no token, no path. */
    describe() {
      return `local server on port ${cfg.port} · pages under venom-os/`
    },

    /** Reachability check: /health, then whoami with the token. Never throws. */
    async ping({ timeoutMs } = {}) {
      const t0 = Date.now()
      try {
        await health({ timeoutMs, label: 'ping' })
        await tool('whoami', {}, { label: 'ping', timeoutMs })
        return { ok: true, ms: Date.now() - t0 }
      } catch (err) {
        const error = err instanceof GbrainError ? err.message : 'GBrain ping failed'
        return { ok: false, ms: Date.now() - t0, error }
      }
    },

    /** Stores one finished turn as one page. A retry sends the same slug and request id. */
    async writeTurn({ user, assistant, ts, session } = {}) {
      if (typeof user !== 'string' || !user.trim() || typeof assistant !== 'string' || !assistant.trim()) {
        throw new GbrainError('GBrain turn needs both sides', 400)
      }
      const p = turnParts({ user, assistant, ts })
      const slug = slugOf(p)
      const args = {
        content: `# Venom OS voice turn ${p.iso}\n\nOwner: ${p.user}\n\nVenom: ${p.assistant}`,
        slug,
        request_id: `venom-os-${p.hash.slice(0, 16)}`,
      }
      let duplicate = false
      try {
        await tool('capture', args, { label: 'capture' })
      } catch (err) {
        // The page is already there (an earlier try got through).
        if (err instanceof GbrainError && err.code === 'revision_required') duplicate = true
        else throw err
      }
      return { session: `venom-os-${p.iso.slice(0, 10)}`, ids: [slug], duplicate }
    },

    /** Recall over every page and saved fact. */
    async search(query, { limit = 8, timeoutMs } = {}) {
      const n = Math.min(MAX_HITS, Math.max(1, Math.floor(Number(limit)) || 1))
      const q = String(query ?? '').slice(0, MAX_QUERY)
      const data = await tool('recall', { query: q, question: q, limit: n }, { label: 'search', timeoutMs })
      const out = []
      for (const r of Array.isArray(data?.results) ? data.results : []) {
        const text = unwrap(r?.chunk)
        const slug = String(r?.slug ?? '')
        const turn = parseTurn(text)
        if (turn) {
          if (turn.user) out.push({ who: 'owner', text: turn.user, when: turn.when, session: slug })
          if (turn.assistant) out.push({ who: 'venom', text: turn.assistant, when: turn.when, session: slug })
        } else if (text.trim()) {
          out.push({ who: 'note', text, when: '', session: slug })
        }
      }
      for (const f of Array.isArray(data?.facts) ? data.facts : []) {
        const text = unwrap(f?.fact)
        if (!text.trim()) continue
        out.push({ who: 'saved fact', text, when: isoOrEmpty(f?.created_at), session: String(f?.entity_slug ?? '') })
      }
      return out.slice(0, MAX_HITS)
    },

    /** The owner's entity card. A miss is normal, not an error. */
    async profile({ query, timeoutMs } = {}) {
      const data = await tool('entity', { name: cfg.owner }, { label: 'profile', timeoutMs })
      if (data?.found !== true) return { card: [], representation: '' }
      const c = data.card || {}
      const card = (Array.isArray(c.identity_excerpt) ? c.identity_excerpt : [])
        .map((x) => x?.line)
        .filter((x) => typeof x === 'string' && x.trim())
        .slice(0, MAX_CARD)
      const representation = typeof c.summary === 'string' ? c.summary : ''
      return { card, representation }
    },
  }
}

let autostarted = false

/** Test only: forget that the server was started in this process. */
export function _resetGbrainAutostart() {
  autostarted = false
}

/**
 * Starts the local GBrain server with its start script when it is not
 * answering. Once per process, does not wait for it. Never throws.
 */
export async function ensureGbrainServer(
  cfg,
  { env = process.env, fetchImpl = globalThis.fetch, spawnImpl = spawn, existsImpl = existsSync } = {},
) {
  try {
    if (!cfg?.enabled) return { started: false, why: cfg?.why || 'GBrain off' }
    if (env.NODE_TEST_CONTEXT) return { started: false, why: 'test run' }
    if (process.platform !== 'win32') return { started: false, why: 'not Windows' }
    if (cfg.autostart === false) return { started: false, why: 'not the usual address' }
    if (autostarted) return { started: false, why: 'start already tried' }
    try {
      await timedFetch(fetchImpl, `${cfg.baseUrl}/health`, { method: 'GET' }, HEALTH_MS, 'health', (res) => {
        if (!res || res.status !== 200) throw httpError(res?.status ?? 0, 'health')
      })
      return { started: false, why: 'already running' }
    } catch {}
    if (!cfg.startCmd || !existsImpl(cfg.startCmd)) return { started: false, why: 'no start script' }
    autostarted = true
    const child = spawnImpl('cmd.exe', ['/d', '/s', '/c', `""${cfg.startCmd}""`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    child?.on?.('error', () => {})
    child?.unref?.()
    return { started: true, why: 'started' }
  } catch {
    return { started: false, why: 'start failed' }
  }
}
