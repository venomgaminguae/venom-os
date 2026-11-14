import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * The Honcho provider for VENOM's long-term memory.
 *
 * Honcho is the memory service Hermes (the owner's chat assistant) already
 * uses. VENOM writes every finished spoken turn into the same workspace, so
 * both assistants share one memory, and reads it back with a search and a
 * profile of the owner. Plain fetch against the HTTP API v3, no SDK.
 *
 * This file knows only Honcho. The bridge never calls it directly: it goes
 * through bridge/longmemory.mjs, so this provider can be swapped for another
 * one with the same shape later.
 *
 * The API key lives only in the config object. It is never logged, never put
 * in an error message and never returned by anything else here.
 */

const DEFAULT_URL = 'https://api.honcho.dev'
const MAX_CONTENT = 25000
const MAX_QUERY = 4000
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/** Every character outside [a-zA-Z0-9_-] becomes '-', the way Hermes does it. */
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '-')

/** The HONCHO_API_KEY line of a .env file, or ''. Never throws. */
function keyFromEnvFile(path) {
  let body
  try {
    body = stripBom(readFileSync(path, 'utf8'))
  } catch {
    return ''
  }
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?HONCHO_API_KEY\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[1].trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1)
    return v.trim()
  }
  return ''
}

/** hosts.hermes from honcho.json, or {} when missing or unreadable. */
function hermesHost(path) {
  try {
    const j = JSON.parse(stripBom(readFileSync(path, 'utf8')))
    const h = j?.hosts?.hermes
    return h && typeof h === 'object' ? h : {}
  } catch {
    return {}
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')

function isLoopback(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** The settings, read at call time (never at module load). Never throws. */
export function honchoConfig(env = process.env) {
  const hermesHome =
    env.HERMES_HOME || join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
  // A Hermes profile (<root>/profiles/<name>) keeps the shared settings and
  // the key in the root, so a bridge started from a profile's shell looks
  // there too. Any other folder is taken as it is.
  const homes = [hermesHome]
  if (basename(dirname(hermesHome)).toLowerCase() === 'profiles') homes.push(dirname(dirname(hermesHome)))
  let host = {}
  for (const h of homes) {
    host = hermesHost(join(h, 'honcho.json'))
    if (Object.keys(host).length) break
  }

  let baseUrl = str(env.VENOM_HONCHO_URL) || DEFAULT_URL
  baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v3$/, '').replace(/\/+$/, '')

  const apiKey =
    str(env.VENOM_HONCHO_API_KEY) ||
    str(env.HONCHO_API_KEY) ||
    homes.map((h) => keyFromEnvFile(join(h, '.env'))).find(Boolean) ||
    ''

  const t = Number(env.VENOM_HONCHO_TIMEOUT_MS)
  const cfg = {
    enabled: false,
    why: '',
    baseUrl,
    apiKey,
    workspace: sanitize(str(env.VENOM_HONCHO_WORKSPACE) || str(host.workspace) || 'hermes'),
    aiPeer: sanitize(str(env.VENOM_HONCHO_AI_PEER) || str(host.aiPeer) || 'venom'),
    userPeer: sanitize(str(env.VENOM_HONCHO_USER_PEER) || str(host.peerName) || 'owner'),
    sessionPrefix: 'venom-os',
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 8000,
  }

  if (env.VENOM_HONCHO === '0') cfg.why = 'VENOM_HONCHO=0'
  else if (env.NODE_TEST_CONTEXT && !isLoopback(baseUrl)) cfg.why = 'test run'
  else if (!apiKey) cfg.why = 'no API key'
  cfg.enabled = cfg.why === ''
  return cfg
}

const pad = (n) => String(n).padStart(2, '0')

/** 'venom-os-YYYY-MM-DD' for the LOCAL date of `date`. */
export function sessionIdFor(date = new Date(), prefix = 'venom-os') {
  const d = date instanceof Date ? date : new Date(date)
  return `${prefix}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A failed Honcho call. status 0 means network error or timeout. */
export class HonchoError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'HonchoError'
    this.status = status
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

const listOf = (data) => (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [])

/** The provider object the long-term memory layer drives. */
export function createHonchoProvider(cfg = honchoConfig(), { fetchImpl = globalThis.fetch } = {}) {
  const created = new Set()
  const ws = encodeURIComponent(cfg.workspace)
  const enc = encodeURIComponent

  /**
   * One HTTP call with a hard timeout. Returns the parsed JSON body (null when
   * there is none). Throws HonchoError; the message never holds the key, the
   * query string or any message text.
   */
  async function call(method, path, { body, query, label, timeoutMs } = {}) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeoutMs
    let url = `${cfg.baseUrl}/v3/workspaces/${ws}${path}`
    if (query) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      const s = qs.toString()
      if (s) url += `?${s}`
    }
    const ctrl = new AbortController()
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new HonchoError(`Honcho unreachable: timeout after ${ms} ms`, 0))
      }, ms)
    })
    try {
      const work = (async () => {
        let res
        try {
          res = await fetchImpl(url, {
            method,
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctrl.signal,
          })
        } catch (err) {
          if (ctrl.signal.aborted) throw new HonchoError(`Honcho unreachable: timeout after ${ms} ms`, 0)
          const code = err?.cause?.code || err?.code || err?.name || 'network error'
          throw new HonchoError(`Honcho unreachable: ${String(code).slice(0, 40)} on ${label}`, 0)
        }
        if (!res || !res.ok) {
          const status = res?.status ?? 0
          // Said in words where the owner has to act; the body is never copied.
          const what =
            status === 402 ? 'Honcho is out of credits (402)' : status === 401 || status === 403 ? `Honcho refused the key (${status})` : `Honcho ${status}`
          throw new HonchoError(`${what} on ${label}`, status)
        }
        try {
          const text = await res.text()
          return text ? JSON.parse(text) : null
        } catch {
          if (ctrl.signal.aborted) throw new HonchoError(`Honcho unreachable: timeout after ${ms} ms`, 0)
          return null
        }
      })()
      // If the timeout wins, a late failure of `work` must not go unhandled.
      work.catch(() => {})
      return await Promise.race([work, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async function ensureSession(id, timeoutMs) {
    if (created.has(id)) return
    await call('POST', '/sessions', {
      label: 'create session',
      timeoutMs,
      body: {
        id,
        metadata: { source: 'venom-os' },
        peers: {
          [cfg.userPeer]: { observe_me: true, observe_others: true },
          [cfg.aiPeer]: { observe_me: true, observe_others: true },
        },
      },
    })
    created.add(id)
  }

  return {
    name: 'honcho',
    label: 'Honcho',

    /** A one-line summary, safe to log: no key, no URL. */
    describe() {
      return `workspace ${cfg.workspace} · peers ${cfg.userPeer}/${cfg.aiPeer} · session ${sessionIdFor(new Date(), cfg.sessionPrefix)}`
    },

    /** Reachability check: reads the owner's peer card. Never throws. */
    async ping({ timeoutMs } = {}) {
      const t0 = Date.now()
      try {
        await call('GET', `/peers/${enc(cfg.aiPeer)}/card`, {
          label: 'ping',
          timeoutMs,
          query: { target: cfg.userPeer },
        })
        return { ok: true, ms: Date.now() - t0 }
      } catch (err) {
        const error = err instanceof HonchoError ? err.message : 'Honcho ping failed'
        return { ok: false, ms: Date.now() - t0, error }
      }
    },

    /** Stores one finished turn (owner, then VENOM) in the day's session. */
    async writeTurn({ user, assistant, ts, session } = {}) {
      if (typeof user !== 'string' || !user.trim() || typeof assistant !== 'string' || !assistant.trim()) {
        throw new HonchoError('Honcho turn needs both sides', 400)
      }
      const when = toDate(ts)
      const id = sessionIdFor(when, cfg.sessionPrefix)
      await ensureSession(id)
      const metadata = { source: 'venom-os', bridge_session: String(session ?? '') }
      const data = await call('POST', `/sessions/${enc(id)}/messages`, {
        label: 'create messages',
        body: {
          messages: [
            {
              peer_id: cfg.userPeer,
              content: user.slice(0, MAX_CONTENT),
              created_at: when.toISOString(),
              metadata: { ...metadata },
            },
            {
              peer_id: cfg.aiPeer,
              content: assistant.slice(0, MAX_CONTENT),
              created_at: new Date(when.getTime() + 1).toISOString(),
              metadata: { ...metadata },
            },
          ],
        },
      })
      const ids = listOf(data)
        .map((m) => m?.id)
        .filter((x) => x !== undefined && x !== null)
        .map(String)
      return { session: id, ids }
    },

    /** Searches every message in the workspace (chat and voice). */
    async search(query, { limit = 8, timeoutMs } = {}) {
      const n = Math.min(20, Math.max(1, Math.floor(Number(limit)) || 1))
      const data = await call('POST', '/search', {
        label: 'search',
        timeoutMs,
        body: { query: String(query ?? '').slice(0, MAX_QUERY), limit: n },
      })
      const out = []
      for (const m of listOf(data)) {
        const text = typeof m?.content === 'string' ? m.content : ''
        if (!text.trim()) continue
        const peer = String(m.peer_id ?? '')
        const who = peer === cfg.userPeer ? 'owner' : peer === cfg.aiPeer ? 'venom' : peer
        out.push({ who, text, when: isoOrEmpty(m.created_at), session: String(m.session_id ?? '') })
      }
      return out
    },

    /** What VENOM's peer knows about the owner. */
    async profile({ query, timeoutMs } = {}) {
      const q = { target: cfg.userPeer }
      if (typeof query === 'string' && query.trim()) q.search_query = query.slice(0, MAX_QUERY)
      const data = await call('GET', `/peers/${enc(cfg.aiPeer)}/context`, {
        label: 'profile',
        timeoutMs,
        query: q,
      })
      const card = Array.isArray(data?.peer_card) ? data.peer_card.filter((x) => typeof x === 'string') : []
      const representation = typeof data?.representation === 'string' ? data.representation : ''
      return { card, representation }
    },
  }
}
