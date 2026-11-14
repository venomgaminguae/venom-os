import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from './secrets.mjs'

/**
 * VENOM's long-term memory, shared with Hermes through an outside service.
 *
 * This layer knows nothing about the service itself: it takes a provider
 * object ({ name, label, describe, ping, writeTurn, search, profile }) and
 * adds what the bridge needs around it:
 *
 *   - storeTurn never waits for the network and never throws. Turns go into a
 *     queue that is sent in the background, one at a time, oldest first, with
 *     backoff while the service is down, and kept in an outbox file so a
 *     restart does not lose them.
 *   - A turn can be held: the owner may cut the spoken answer short after the
 *     turn was stored, and the service should get what he actually heard.
 *   - recall is bounded in time, so the memory_recall tool can never hang.
 *   - profileText hands back a cached snapshot of what is known about the
 *     owner for the prompt, refreshed in the background.
 */

const OFF_MESSAGE = 'Long-term memory is off.'
const MIN_PROFILE_RETRY_MS = 60_000

/** One line per hit, the whole profile, and the error text cut to these. */
const HIT_CHARS = 600
const PROFILE_CHARS = 1200

const clip = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t
}

const errText = (err) => clip(String(err?.message ?? err ?? 'unknown error').replace(/\s+/g, ' ').trim(), 300)

/**
 * Temp file plus rename in the same folder, so a crash leaves the old outbox
 * or the new one, never half of either. Windows refuses a rename onto a file
 * someone has open for a moment, so that one error is retried briefly.
 */
function writeAtomic(path, body) {
  const tmp = `${path}.venom-${process.pid}-${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, body, 'utf8')
  for (let tries = 0; ; tries++) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      if (tries >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        try {
          unlinkSync(tmp)
        } catch {
          /* already gone */
        }
        throw err
      }
      const until = Date.now() + 25
      while (Date.now() < until) {
        /* brief spin; this path is rare and synchronous on purpose */
      }
    }
  }
}

/** A profile as plain text: card lines as `- ...`, then the representation. */
function profileToText(profile, maxChars) {
  if (!profile) return ''
  const card = Array.isArray(profile.card) ? profile.card.map((c) => String(c ?? '').trim()).filter(Boolean) : []
  const rep = String(profile.representation ?? '').trim()
  const parts = []
  if (card.length) parts.push(card.map((c) => `- ${c}`).join('\n'))
  if (rep) parts.push(rep)
  return clip(parts.join('\n'), maxChars)
}

const normProfile = (p) => ({
  card: Array.isArray(p?.card) ? p.card.map((c) => String(c ?? '')).filter((c) => c.trim()) : [],
  representation: typeof p?.representation === 'string' ? p.representation : '',
})

/**
 * The long-term memory the bridge talks to. See the file comment; every
 * timer goes through `setTimer`/`clearTimer` so tests drive time by hand, and
 * real timers are unref'd so they never keep the process alive.
 */
export function createLongMemory({
  provider,
  dir,
  log = console,
  holdMs = 90_000,
  maxQueue = 200,
  retryBaseMs = 5_000,
  retryMaxMs = 300_000,
  recallTimeoutMs = 4_000,
  profileTimeoutMs = 4_000,
  profileTtlMs = 30 * 60_000,
  profileMaxChars = 1200,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!provider || typeof provider.writeTurn !== 'function') throw new Error('createLongMemory needs a provider')

  const label = String(provider.label ?? provider.name ?? 'memory')
  const tag = `[longmemory ${label}]`
  const say = (msg) => {
    try {
      log?.log?.(`${tag} ${msg}`)
    } catch {
      /* a broken logger must not break memory */
    }
  }
  const shout = (msg) => {
    try {
      log?.error?.(`${tag} ${msg}`)
    } catch {
      /* same */
    }
  }

  const arm = (fn, ms) => {
    const t = setTimer(fn, Math.max(0, ms))
    t?.unref?.()
    return t
  }

  const outboxPath = dir ? join(dir, `outbox-${provider.name}.json`) : null

  /** @type {Array<{id:string, session:string, user:string, assistant:string, ts:string, held:boolean, sending?:boolean}>} */
  let queue = []
  const holdTimers = new Map()
  let counter = 0
  let loaded = false
  let diskWarned = false
  let stopped = false

  let state = 'unknown'
  let sent = 0
  let dropped = 0
  let lastOkAt = null
  let lastError = ''
  let failures = 0
  // The last send was refused or failed. A read that works (a recall, the
  // start-up check) must not call the service healthy while this is set.
  let writeFault = false
  // The HTTP status of the failed write behind writeFault, or 0.
  let lastStatus = 0

  let drainTimer = null
  let draining = null

  let snapshot = null // { card, representation, at }
  let refreshing = null
  let lastProfileTry = -Infinity

  function setState(next, error) {
    const prev = state
    state = next
    if (next === 'ok') {
      lastOkAt = now()
      lastError = ''
    } else if (next === 'offline') {
      lastError = errText(error)
    }
    if (prev !== next) {
      if (next === 'offline') shout(`offline: ${lastError}`)
      else if (next === 'ok') say(prev === 'offline' ? 'reachable again' : 'reachable')
    }
  }

  // --- the outbox ---------------------------------------------------------

  function readOutbox() {
    if (!outboxPath) return []
    let raw
    try {
      raw = readFileSync(outboxPath, 'utf8')
    } catch {
      return []
    }
    try {
      const data = JSON.parse(raw.replace(/^\ufeff/, ''))
      if (!Array.isArray(data)) return []
      return data
        .filter((t) => t && typeof t.user === 'string' && typeof t.assistant === 'string' && t.user && t.assistant)
        .map((t) => ({
          id: String(t.id ?? `${now()}-${++counter}`),
          session: String(t.session ?? ''),
          user: t.user,
          assistant: t.assistant,
          ts: typeof t.ts === 'string' && Number.isFinite(Date.parse(t.ts)) ? t.ts : new Date(now()).toISOString(),
          held: false, // whoever was holding it is gone
        }))
    } catch {
      return []
    }
  }

  /** Bring in whatever an earlier run left, before anything overwrites the file. */
  function ensureLoaded() {
    if (loaded) return
    loaded = true
    const known = new Set(queue.map((t) => t.id))
    const old = readOutbox().filter((t) => !known.has(t.id))
    if (old.length) {
      queue = [...old, ...queue]
      trim()
    }
  }

  function save() {
    if (!outboxPath) return
    try {
      if (!queue.length) {
        rmSync(outboxPath, { force: true })
      } else {
        mkdirSync(dir, { recursive: true })
        const body = queue.map(({ id, session, user, assistant, ts, held }) => ({ id, session, user, assistant, ts, held }))
        writeAtomic(outboxPath, JSON.stringify(body))
      }
      diskWarned = false
    } catch (err) {
      if (!diskWarned) {
        diskWarned = true
        shout(`could not save the outbox, keeping turns in memory only: ${err?.code || errText(err)}`)
      }
    }
  }

  function forget(id) {
    const t = holdTimers.get(id)
    if (t !== undefined) {
      clearTimer(t)
      holdTimers.delete(id)
    }
  }

  /** Drop the oldest turns past maxQueue (never the one on the wire). */
  function trim() {
    let over = queue.length - Math.max(1, maxQueue)
    if (over <= 0) return
    let n = 0
    queue = queue.filter((t) => {
      if (over > 0 && !t.sending) {
        over--
        n++
        forget(t.id)
        return false
      }
      return true
    })
    if (n) {
      dropped += n
      shout(`queue full (${maxQueue}): dropped the oldest ${n === 1 ? 'turn' : `${n} turns`}`)
    }
  }

  // --- sending --------------------------------------------------------------

  function scheduleDrain(ms = 0) {
    if (stopped || draining || drainTimer !== null) return
    drainTimer = arm(() => {
      drainTimer = null
      runDrain()
    }, ms)
  }

  function runDrain() {
    if (draining) return draining
    draining = drainLoop().finally(() => {
      draining = null
    })
    return draining
  }

  async function drainLoop() {
    while (!stopped) {
      const turn = queue.find((t) => !t.held)
      if (!turn) return
      turn.sending = true
      try {
        await provider.writeTurn({ session: turn.session, user: turn.user, assistant: turn.assistant, ts: turn.ts })
        turn.sending = false
        queue = queue.filter((t) => t !== turn)
        sent++
        failures = 0
        writeFault = false
        lastStatus = 0
        setState('ok')
        save()
      } catch (err) {
        turn.sending = false
        if (err?.retryable === false) {
          // The key was refused (401, 403) or the account is out of credit
          // (402): no turn will get through until the owner fixes it, so keep
          // them all and look again later rather than dropping them one by one.
          if (err.status === 401 || err.status === 402 || err.status === 403) {
            lastStatus = err.status
            failures++
            writeFault = true
            setState('offline', err)
            if (!stopped) drainTimer = arm(() => ((drainTimer = null), runDrain()), retryMaxMs)
            return
          }
          if (queue.includes(turn)) {
            queue = queue.filter((t) => t !== turn)
            dropped++
            shout(`dropped one turn the service refused${err.status ? ` (${err.status})` : ''}`)
            save()
          }
          continue
        }
        failures++
        writeFault = true
        setState('offline', err)
        lastStatus = Number.isInteger(err?.status) ? err.status : 0
        const wait = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1))
        if (!stopped) drainTimer = arm(() => ((drainTimer = null), runDrain()), wait)
        return
      }
    }
  }

  // --- the public face ------------------------------------------------------

  function storeTurn({ session, user, assistant, ts } = {}, { hold = false } = {}) {
    try {
      const u = typeof user === 'string' ? user.trim() : ''
      const a = typeof assistant === 'string' ? assistant.trim() : ''
      if (!u || !a) return null
      ensureLoaded()
      let when = ts === undefined || ts === null ? new Date(now()) : new Date(ts)
      if (!Number.isFinite(when.getTime())) when = new Date(now())
      const id = `${now()}-${++counter}`
      const turn = {
        id,
        session: String(session ?? ''),
        user: redactSecrets(u),
        assistant: redactSecrets(a),
        ts: when.toISOString(),
        held: Boolean(hold),
      }
      queue.push(turn)
      if (turn.held) holdTimers.set(id, arm(() => release(id), holdMs))
      trim()
      save()
      scheduleDrain(0)
      return queue.includes(turn) ? id : null
    } catch (err) {
      shout(`could not store a turn: ${errText(err)}`)
      return null
    }
  }

  function amend(id, assistant) {
    const turn = queue.find((t) => t.id === id)
    if (!turn || !turn.held || turn.sending) return false
    const a = typeof assistant === 'string' ? assistant.trim() : ''
    if (!a) return false
    turn.assistant = redactSecrets(a)
    save()
    return true
  }

  function release(id) {
    const turn = queue.find((t) => t.id === id)
    if (!turn || !turn.held) return false
    turn.held = false
    forget(id)
    save()
    scheduleDrain(0)
    return true
  }

  /** `p()` raced against its own timer: a provider that ignores timeoutMs still cannot hang us. */
  function bounded(p, ms, what) {
    let t = null
    const timeout = new Promise((_, reject) => {
      t = arm(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    })
    const work = new Promise((resolve) => resolve(p()))
    return Promise.race([work, timeout]).finally(() => clearTimer(t))
  }

  async function recall(query, { limit = 8 } = {}) {
    const n = Math.max(1, Math.min(20, Math.floor(Number(limit)) || 8))
    const q = String(query ?? '')
    try {
      const [s, p] = await Promise.allSettled([
        bounded(() => provider.search(q, { limit: n, timeoutMs: recallTimeoutMs }), recallTimeoutMs, 'search'),
        bounded(() => provider.profile({ query: q, timeoutMs: profileTimeoutMs }), profileTimeoutMs, 'profile'),
      ])
      const profile = p.status === 'fulfilled' ? normProfile(p.value) : null
      if (s.status !== 'fulfilled') return { ok: false, hits: [], profile, error: errText(s.reason) }
      if (!writeFault) setState('ok')
      const hits = (Array.isArray(s.value) ? s.value : [])
        .filter((h) => h && typeof h.text === 'string' && h.text.trim())
        .map((h) => ({ who: String(h.who ?? ''), text: h.text, when: String(h.when ?? ''), session: String(h.session ?? '') }))
      return { ok: true, hits, profile }
    } catch (err) {
      return { ok: false, hits: [], profile: null, error: errText(err) }
    }
  }

  function refreshProfile() {
    if (refreshing) return refreshing
    lastProfileTry = now()
    refreshing = (async () => {
      try {
        const p = await bounded(() => provider.profile({ timeoutMs: profileTimeoutMs }), profileTimeoutMs, 'profile')
        snapshot = { ...normProfile(p), at: now() }
      } catch (err) {
        say(`profile not refreshed: ${errText(err)}`)
      }
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  function profileText() {
    const t = now()
    const stale = !snapshot || t - snapshot.at > profileTtlMs
    if (stale && !refreshing && !stopped && t - lastProfileTry >= Math.min(profileTtlMs, MIN_PROFILE_RETRY_MS)) {
      refreshProfile()
    }
    return snapshot ? profileToText(snapshot, profileMaxChars) : ''
  }

  function status() {
    return {
      provider: String(provider.name ?? ''),
      label,
      state,
      queued: queue.length,
      held: queue.filter((t) => t.held).length,
      sent,
      dropped,
      lastOkAt,
      lastError,
      writeFault,
      lastStatus,
    }
  }

  /**
   * A bounded ping for the memory panel: `{ ok, ms }`, never an error text,
   * never throws. A failed write keeps the state where it is: a service that
   * answers but refuses writes is not healthy.
   */
  async function check() {
    const t0 = now()
    let ok = false
    let why = 'not reachable'
    try {
      const r = await bounded(() => provider.ping({ timeoutMs: recallTimeoutMs }), recallTimeoutMs, 'ping')
      ok = Boolean(r?.ok)
      if (!ok) why = r?.error ?? why
    } catch (err) {
      why = err
    }
    try {
      if (ok && !writeFault) setState('ok')
      else if (!ok) setState('offline', why)
    } catch {
      /* the answer below does not depend on it */
    }
    const ms = now() - t0
    return { ok, ms: Number.isFinite(ms) && ms >= 0 ? ms : 0 }
  }

  async function start() {
    stopped = false
    ensureLoaded()
    save()
    const t0 = now()
    let result
    try {
      const r = await provider.ping()
      result = { ok: Boolean(r?.ok), ms: Number.isFinite(r?.ms) ? r.ms : now() - t0 }
      if (!result.ok) result.error = errText(r?.error ?? 'not reachable')
    } catch (err) {
      result = { ok: false, ms: now() - t0, error: errText(err) }
    }
    if (result.ok) setState('ok')
    else setState('offline', result.error)
    refreshProfile()
    scheduleDrain(0)
    return result
  }

  /** Send everything that is not held, now, ignoring any backoff. */
  async function flush() {
    try {
      ensureLoaded()
      if (drainTimer !== null) {
        clearTimer(drainTimer)
        drainTimer = null
      }
      if (draining) await draining
      if (drainTimer !== null) {
        clearTimer(drainTimer)
        drainTimer = null
      }
      await runDrain()
    } catch {
      /* drainLoop handles its own errors */
    }
  }

  function stop() {
    stopped = true
    if (drainTimer !== null) clearTimer(drainTimer)
    drainTimer = null
    for (const t of holdTimers.values()) clearTimer(t)
    holdTimers.clear()
  }

  return {
    name: provider.name,
    label: provider.label,
    enabled: true,
    storeTurn,
    amend,
    release,
    recall,
    profileText,
    refreshProfile,
    status,
    check,
    start,
    flush,
    stop,
  }
}

/** The same shape with nothing behind it, for when long-term memory is off. */
export function disabledLongMemory(why = '') {
  return {
    name: 'none',
    label: 'off',
    enabled: false,
    storeTurn: () => null,
    amend: () => false,
    release: () => false,
    recall: async () => ({ ok: false, hits: [], profile: null, error: OFF_MESSAGE }),
    profileText: () => '',
    refreshProfile: async () => {},
    status: () => ({
      provider: 'none',
      label: 'off',
      state: 'off',
      why,
      queued: 0,
      held: 0,
      sent: 0,
      dropped: 0,
      lastOkAt: null,
      lastError: '',
      writeFault: false,
      lastStatus: 0,
    }),
    check: async () => ({ ok: false, ms: 0 }),
    start: async () => ({ ok: false, ms: 0, error: why }),
    flush: async () => {},
    stop: () => {},
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0')

/** `YYYY-MM-DD HH:MM` in local time, or the raw value when it is not a date. */
function localStamp(when) {
  const d = new Date(when)
  if (!when || Number.isNaN(d.getTime())) return String(when ?? '') || 'unknown time'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const whoName = (who) => (who === 'owner' ? 'Owner' : who === 'venom' ? 'Venom' : String(who ?? '') || 'Unknown')

/** The text memory_recall hands the model. */
export function formatRecall(result, { maxChars = 3500 } = {}) {
  if (!result?.ok) {
    return clip(
      `Long-term memory could not be reached (${result?.error || 'unknown error'}). Use memory_search for spoken conversations on this PC.`,
      maxChars,
    )
  }
  const about = profileToText(result.profile, PROFILE_CHARS)
  const hits = Array.isArray(result.hits) ? result.hits : []
  if (!hits.length && !about) return 'Nothing found in long-term memory.'
  const parts = []
  if (about) parts.push(`What is known about the owner:\n${about}`)
  if (hits.length) {
    const lines = hits.map(
      (h) =>
        `${localStamp(h.when)} · ${h.session || 'unknown session'} · ${whoName(h.who)}: ${clip(String(h.text ?? '').replace(/\s+/g, ' ').trim(), HIT_CHARS)}`,
    )
    parts.push(`Past messages (all of the owner's conversations, chat and voice):\n${lines.join('\n')}`)
  }
  return clip(parts.join('\n\n'), maxChars)
}

const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] })

/** The in-process MCP server, `venom_recall`, with its one read-only tool. */
export function longMemoryServer(mem) {
  return createSdkMcpServer({
    name: 'venom_recall',
    version: '1.0.0',
    tools: [
      tool(
        'memory_recall',
        'Search the long-term memory you share with Hermes, the owner\'s chat assistant: everything he has said to either of you, by voice here or in the chat, plus what is known about him. Use it when he refers to something from before that memory_search (spoken conversations on this PC) does not find, something he told the chat assistant, or asks what you know or remember about him. Pass a short question or a few keywords. It takes a second or two: never call it for an ordinary question.',
        {
          query: z.string(),
          limit: z.number().optional(),
        },
        async (args) => {
          const result = await mem.recall(args.query, { limit: args.limit })
          return text(formatRecall(result), !result.ok)
        },
      ),
    ],
  })
}
