import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SECRET } from './secrets.mjs'

/**
 * VENOM's memory, in two halves.
 *
 *   1. Shared with Hermes. MEMORY.md (the assistant's notes) and USER.md (who
 *      the owner is) in Hermes's own memory folder. Hermes injects both into
 *      its prompt and edits them with its own tool, so VENOM reads and writes
 *      the very same files in the very same format: entries separated by a
 *      line holding only `§`, CRLF on Windows, sizes counted the way Hermes
 *      counts them (the entries joined by "\n§\n", in characters).
 *   2. VENOM's own conversation log. One line per finished turn — what the
 *      owner said and what VENOM answered, text only. Never tool inputs, tool
 *      results, pages, files, images or camera frames: keeping those out is
 *      why the SDK's session transcripts are off, and this must not undo it.
 *
 * Every path comes from the environment at call time, so tests point it at
 * temp folders and never touch the real files.
 */

const DELIM = '\n§\n'
const FIELD_CAP = 4000
const TARGETS = ['user', 'memory']

/** The settings, read fresh on every call. */
export function memoryConfig(env = process.env) {
  const hermesHome =
    env.HERMES_HOME || join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes')
  const num = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  return {
    enabled: env.VENOM_MEMORY !== '0',
    hermesDir: env.VENOM_HERMES_MEMORY_DIR || join(hermesHome, 'memories'),
    logDir: env.VENOM_MEMORY_DIR || join(homedir(), '.venom', 'memory'),
    limits: {
      memory: num(env.VENOM_MEMORY_LIMIT, 2200),
      user: num(env.VENOM_USER_LIMIT, 1375),
    },
    days: num(env.VENOM_MEMORY_DAYS, 365),
  }
}

export const memoryEnabled = () => memoryConfig().enabled

// ---------------------------------------------------------------------------
// Hermes's memory files
// ---------------------------------------------------------------------------

const fileFor = (target, cfg) => join(cfg.hermesDir, target === 'user' ? 'USER.md' : 'MEMORY.md')

/** Characters as Python counts them (code points), not UTF-16 units. */
const chars = (s) => [...s].length

/**
 * The raw file: { text, crlf, ok }. Missing is empty and fine. Unreadable or
 * not valid UTF-8 is `ok: false`, which every write refuses — writing back a
 * lossy view would wipe what Hermes had there.
 */
function readRaw(path) {
  let buf
  try {
    buf = readFileSync(path)
  } catch (err) {
    return { text: '', crlf: process.platform === 'win32', ok: err?.code === 'ENOENT' }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return { text: '', crlf: true, ok: false }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const crlf = text.includes('\r\n') || (!text.includes('\n') && process.platform === 'win32')
  return { text: text.replace(/\r\n/g, '\n'), crlf, ok: true }
}

const parse = (text) =>
  text
    .split(DELIM)
    .map((e) => e.trim())
    .filter(Boolean)

/** One Hermes memory list. A missing file is an empty list, never an error. */
export function readEntries(target, cfg = memoryConfig()) {
  return parse(readRaw(fileFor(target, cfg)).text)
}

/**
 * Temp file plus rename, so a crash leaves either the old file or the new one,
 * never half of either. Windows refuses a rename onto a file someone has open
 * for a moment, so that one error is retried briefly.
 */
function writeAtomic(path, entries, crlf) {
  let body = entries.join(DELIM)
  if (crlf) body = body.replace(/\n/g, '\r\n')
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

/**
 * Things that must never land in a file injected into every Hermes prompt.
 * The prompt says so too; this is the backstop for the obvious cases. The
 * pattern (SECRET) lives in secrets.mjs, shared with the team activity log.
 */

const describe = (target) => (target === 'user' ? 'the owner list' : 'the notes list')

/** Summary handed back with a refusal, so the model can tell the owner what is there. */
function usage(target, entries, cfg) {
  return {
    entries,
    used: chars(entries.join(DELIM)),
    limit: cfg.limits[target],
  }
}

function checkTarget(target) {
  if (!TARGETS.includes(target)) throw new Error(`unknown memory target ${target}`)
}

/**
 * Re-read, change, write — with the re-read immediately before the write,
 * since Hermes may have edited the file at any point before this call.
 */
function mutate(target, cfg, change) {
  checkTarget(target)
  if (!cfg.enabled) return { ok: false, reason: 'off', message: 'Memory is switched off.' }
  const path = fileFor(target, cfg)
  const raw = readRaw(path)
  if (!raw.ok) {
    return { ok: false, reason: 'unreadable', message: `Not changed: ${describe(target)} could not be read safely.` }
  }
  const entries = parse(raw.text)
  const out = change(entries)
  if (!out.ok) return out
  const used = chars(out.entries.join(DELIM))
  if (used > cfg.limits[target]) {
    return {
      ok: false,
      reason: 'full',
      message: `Not saved: ${describe(target)} would be ${used} of ${cfg.limits[target]} characters.`,
      ...usage(target, entries, cfg),
    }
  }
  mkdirSync(cfg.hermesDir, { recursive: true })
  writeAtomic(path, out.entries, raw.crlf)
  return { ok: true, message: out.message, ...usage(target, out.entries, cfg) }
}

/** Add one entry to `user` or `memory`. */
export function saveEntry(target, content, cfg = memoryConfig()) {
  const entry = String(content ?? '').trim()
  if (!entry) return { ok: false, reason: 'empty', message: 'Not saved: the entry was empty.' }
  if (SECRET.test(entry)) {
    return { ok: false, reason: 'secret', message: 'Not saved: it looks like a password, key, card number or code.' }
  }
  return mutate(target, cfg, (entries) => {
    if (entries.some((e) => e.toLowerCase() === entry.toLowerCase())) {
      return { ok: false, reason: 'duplicate', message: 'Already remembered.', ...usage(target, entries, cfg) }
    }
    return { ok: true, entries: [...entries, entry], message: 'Saved.' }
  })
}

/** The single entry containing `needle`, or a refusal. */
function locate(entries, needle) {
  const n = String(needle ?? '').trim().toLowerCase()
  if (!n) return { ok: false, reason: 'empty', message: 'Nothing to match: the text to find was empty.' }
  const hits = entries.map((e, i) => (e.toLowerCase().includes(n) ? i : -1)).filter((i) => i >= 0)
  if (hits.length === 0) return { ok: false, reason: 'none', message: 'No entry contains that text.' }
  if (hits.length > 1) {
    return {
      ok: false,
      reason: 'several',
      message: `${hits.length} entries contain that text; give a longer, unique piece of the one to change.`,
      matches: hits.map((i) => entries[i]),
    }
  }
  return { ok: true, index: hits[0] }
}

/** Replace the one entry containing `oldText` with `content`. */
export function updateEntry(target, oldText, content, cfg = memoryConfig()) {
  const entry = String(content ?? '').trim()
  if (!entry) return { ok: false, reason: 'empty', message: 'Not changed: the new entry was empty.' }
  if (SECRET.test(entry)) {
    return { ok: false, reason: 'secret', message: 'Not saved: it looks like a password, key, card number or code.' }
  }
  return mutate(target, cfg, (entries) => {
    const at = locate(entries, oldText)
    if (!at.ok) return at
    if (entries.some((e, i) => i !== at.index && e.toLowerCase() === entry.toLowerCase())) {
      return { ok: false, reason: 'duplicate', message: 'Another entry already says that.' }
    }
    const next = [...entries]
    next[at.index] = entry
    return { ok: true, entries: next, message: 'Updated.' }
  })
}

/** Remove the one entry containing `oldText`. */
export function forgetEntry(target, oldText, cfg = memoryConfig()) {
  return mutate(target, cfg, (entries) => {
    const at = locate(entries, oldText)
    if (!at.ok) return at
    return { ok: true, entries: entries.filter((_, i) => i !== at.index), message: 'Forgotten.' }
  })
}

// ---------------------------------------------------------------------------
// The conversation log
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/

const convDir = (cfg) => join(cfg.logDir, 'conversations')
const cap = (s) => {
  const t = String(s ?? '').trim()
  return t.length > FIELD_CAP ? `${t.slice(0, FIELD_CAP)}…` : t
}

/**
 * Append one finished turn. Text only, by construction: the caller passes the
 * owner's words and VENOM's final answer and nothing else. A turn missing
 * either side (an interrupt, a turn that was all tool calls) is not a turn
 * worth recalling and is skipped. Returns whether a line was written.
 */
export function logTurn({ session, user, assistant, ts = new Date() }, cfg = memoryConfig()) {
  if (!cfg.enabled) return false
  const u = cap(typeof user === 'string' ? user : '')
  const a = cap(typeof assistant === 'string' ? assistant : '')
  if (!u || !a) return false
  const when = ts instanceof Date ? ts : new Date(ts)
  const dir = convDir(cfg)
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify({ ts: when.toISOString(), session: String(session ?? ''), user: u, assistant: a })
  appendFileSync(join(dir, `${localDate(when)}.jsonl`), line + '\n', 'utf8')
  return true
}

/**
 * Replace VENOM's side of the turn just logged, for when the owner cut the
 * spoken answer short after it had already been logged in full (the usual
 * case: the model finishes writing long before the voice finishes speaking).
 *
 * Touches only the final line of today's file, and only when that line is
 * this session's turn for this same question; anything else means another
 * turn has landed since, and rewriting it would corrupt the record, so it does
 * nothing. Atomic (temp file + rename) so a crash cannot tear the day.
 * Returns whether the line was changed.
 */
export function amendLastTurn({ session, user, assistant, now = new Date() }, cfg = memoryConfig()) {
  if (!cfg.enabled) return false
  const u = cap(typeof user === 'string' ? user : '')
  const a = cap(typeof assistant === 'string' ? assistant : '')
  if (!u || !a) return false
  const path = join(convDir(cfg), `${localDate(now instanceof Date ? now : new Date(now))}.jsonl`)
  let body
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const lines = body.split('\n')
  let last = lines.length - 1
  while (last >= 0 && !lines[last].trim()) last--
  if (last < 0) return false
  let turn
  try {
    turn = JSON.parse(lines[last])
  } catch {
    return false
  }
  if (turn?.session !== String(session ?? '') || turn?.user !== u) return false
  lines[last] = JSON.stringify({ ...turn, assistant: a })
  // One "entry" holding the whole file: writeAtomic joins nothing.
  writeAtomic(path, [lines.join('\n')], false)
  return true
}

/** Day files, newest first, optionally only those on or after `since` (a local date string). */
function dayFiles(cfg, since) {
  let names
  try {
    names = readdirSync(convDir(cfg))
  } catch {
    return []
  }
  return names
    .filter((n) => DAY_FILE.test(n) && (!since || n.slice(0, 10) >= since))
    .sort()
    .reverse()
}

function readDay(cfg, name) {
  let text
  try {
    text = readFileSync(join(convDir(cfg), name), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const t = JSON.parse(line)
      if (typeof t?.user === 'string' && typeof t?.assistant === 'string') out.push(t)
    } catch {
      /* a torn line from a crash mid-append; skip it */
    }
  }
  return out
}

/** Delete day files older than VENOM_MEMORY_DAYS. Returns how many went. */
export function pruneLog(cfg = memoryConfig(), now = new Date()) {
  if (!cfg.enabled) return 0
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - cfg.days)
  const keepFrom = localDate(cutoff)
  let removed = 0
  for (const name of dayFiles(cfg)) {
    if (name.slice(0, 10) < keepFrom) {
      try {
        rmSync(join(convDir(cfg), name))
        removed++
      } catch {
        /* in use or gone; next start will try again */
      }
    }
  }
  return removed
}

const STOPWORDS = new Set(
  'a an and are as at be but by did do does for from had has have how i in is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your about yesterday today talk talked said say discuss discussed decide decided'.split(' '),
)

const queryWords = (q) => {
  const all = [
    ...new Set(
      String(q ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ]
  const kept = all.filter((w) => !STOPWORDS.has(w))
  return kept.length ? kept : all
}

/** ~`width` characters of `text` around the first matching word. */
function snippet(text, words, width = 300) {
  if (text.length <= width) return text
  const lower = text.toLowerCase()
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), Infinity)
  const centre = Number.isFinite(at) ? at : 0
  const start = Math.max(0, Math.min(centre - Math.floor(width / 3), text.length - width))
  return `${start > 0 ? '…' : ''}${text.slice(start, start + width)}${start + width < text.length ? '…' : ''}`
}

/**
 * Search the log. Each turn scores the number of distinct query words it
 * contains; ties go to the newest. Files are read newest first and the scan
 * stops once `limit` full-score turns are in hand, since nothing older can
 * outrank them — a year of logs costs only the days it needs.
 */
export function searchLog(query, { days, limit = 8, now = new Date() } = {}, cfg = memoryConfig()) {
  if (!cfg.enabled) return []
  const words = queryWords(query)
  if (!words.length) return []
  const max = Math.max(1, Math.min(20, Math.floor(Number(limit)) || 8))
  let since = null
  let cutoffMs = -Infinity
  if (days !== undefined && days !== null && Number(days) > 0) {
    const c = new Date(now)
    c.setDate(c.getDate() - Number(days))
    since = localDate(c)
    cutoffMs = c.getTime()
  }
  const hits = []
  let full = 0
  for (const name of dayFiles(cfg, since)) {
    for (const t of readDay(cfg, name)) {
      const when = Date.parse(t.ts)
      if (Number.isFinite(when) && when < cutoffMs) continue
      const hay = `${t.user}\n${t.assistant}`.toLowerCase()
      const score = words.filter((w) => hay.includes(w)).length
      if (!score) continue
      if (score === words.length) full++
      hits.push({ t, score, when: Number.isFinite(when) ? when : 0 })
    }
    if (full >= max) break
  }
  hits.sort((a, b) => b.score - a.score || b.when - a.when)
  return hits.slice(0, max).map(({ t, score, when }) => {
    const d = new Date(when)
    return {
      date: localDate(d),
      time: localTime(d),
      score,
      user: snippet(t.user, words),
      assistant: snippet(t.assistant, words),
    }
  })
}

/**
 * The last few turns from earlier sessions, oldest first, within `maxChars`.
 * Each side is clipped so one long answer cannot crowd out the rest.
 */
export function recentTurns({ excludeSession, maxChars = 1500, maxTurns = 6 } = {}, cfg = memoryConfig()) {
  if (!cfg.enabled) return []
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)
  const picked = []
  let used = 0
  outer: for (const name of dayFiles(cfg).slice(0, 7)) {
    const turns = readDay(cfg, name)
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      if (excludeSession && t.session === excludeSession) continue
      const d = new Date(t.ts)
      const line = `${Number.isNaN(d.getTime()) ? name.slice(0, 10) : localDate(d)}: Owner: ${clip(t.user, 160)} / Venom: ${clip(t.assistant, 200)}`
      if (used + line.length > maxChars || picked.length >= maxTurns) break outer
      picked.push(line)
      used += line.length + 1
    }
  }
  return picked.reverse()
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

const listOf = (entries) =>
  entries.length ? entries.map((e) => `- ${e.replace(/\n/g, '\n  ')}`).join('\n') : '(nothing yet)'

/**
 * The two lists and the recent-conversation digest, read fresh each time so
 * anything Hermes saved since the last connection is already in here.
 * Empty string when memory is switched off.
 */
export function memoryContext({ session } = {}, cfg = memoryConfig()) {
  if (!cfg.enabled) return ''
  const parts = [
    `ABOUT THE OWNER (USER list):\n${listOf(readEntries('user', cfg))}`,
    `YOUR NOTES (MEMORY list):\n${listOf(readEntries('memory', cfg))}`,
  ]
  let recent = []
  try {
    recent = recentTurns({ excludeSession: session }, cfg)
  } catch {
    /* a bad log must not stop a session starting */
  }
  if (recent.length) parts.push(`RECENT CONVERSATIONS (earlier sessions, newest last):\n${recent.join('\n')}`)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: t }] })

const target = z
  .enum(['user', 'memory'])
  .describe('"user" for facts about the owner; "memory" for your own standing notes.')

function reply(result) {
  let body = result.message
  if (result.used !== undefined) body += ` (${result.used} of ${result.limit} characters used)`
  if (!result.ok && result.reason === 'full') {
    body += `\nCurrent entries:\n${result.entries.map((e) => `- ${e}`).join('\n')}`
  }
  if (!result.ok && result.matches) body += `\nMatches:\n${result.matches.map((e) => `- ${e}`).join('\n')}`
  return text(body, !result.ok)
}

/**
 * The in-process MCP server, `venom_memory`. Like chromeServer, the changing
 * tools are only built when writes are allowed; policy.mjs gates them as well.
 */
export function memoryServer({ allowWrites = false } = {}) {
  const tools = [
    tool(
      'memory_search',
      'Search your past spoken conversations with the owner. Use it whenever they refer to an earlier ' +
        'conversation ("what did we decide about…", "last week you said…"). Pass a few keywords, not a ' +
        'sentence. Results come newest first among equals, with date and time.',
      {
        query: z.string().describe('Keywords to look for.'),
        days: z.number().optional().describe('Only look this many days back.'),
        limit: z.number().optional().describe('Most results to return, default 8, max 20.'),
      },
      async (args) => {
        const found = searchLog(args.query, { days: args.days, limit: args.limit })
        if (!found.length) return text('Nothing found in past conversations.')
        return text(
          found
            .map((r) => `${r.date} ${r.time}\nOwner: ${r.user}\nVenom: ${r.assistant}`)
            .join('\n\n'),
        )
      },
    ),
  ]
  if (allowWrites) {
    tools.push(
      tool(
        'memory_save',
        'Save one durable fact, shared with Hermes. Only who the owner is, preferences, standing ' +
          'decisions, stable facts about their business and machine. Never task progress, anything ' +
          'true for less than a week, or secrets. One short, self-contained sentence.',
        { target, content: z.string().describe('The entry to save.') },
        async (args) => reply(saveEntry(args.target, args.content)),
      ),
      tool(
        'memory_update',
        'Replace the one saved entry that contains `old_text` with `content`.',
        {
          target,
          old_text: z.string().describe('A unique piece of the entry to replace.'),
          content: z.string().describe('The new entry.'),
        },
        async (args) => reply(updateEntry(args.target, args.old_text, args.content)),
      ),
      tool(
        'memory_forget',
        'Remove the one saved entry that contains `old_text`.',
        { target, old_text: z.string().describe('A unique piece of the entry to remove.') },
        async (args) => reply(forgetEntry(args.target, args.old_text)),
      ),
    )
  }
  return createSdkMcpServer({ name: 'venom_memory', version: '1.0.0', tools })
}
