/**
 * The agent tiles' rules: which order the tiles come in, what each one
 * says, how they are laid out around the core for a given window, and how an
 * agent's result text is turned into blocks the HUD can render as plain text.
 * Shared so node --test covers them; the HUD (src/ui/AgentTiles.tsx,
 * src/ui/AgentView.tsx) draws what comes back. Pure functions only: no I/O,
 * no DOM, no clock of their own.
 *
 * Everything an agent wrote is untrusted. Nothing here produces markup:
 * formatResult only classifies lines, and linkParts only ever hands back an
 * href that parsed as an absolute http(s) URL.
 */
import { headline, summaryLine, when } from './pinned.mjs'

// ------------------------------------------------------------------- order

/**
 * The roster with its pinned entries (`pinned: true`) leading, then the rest,
 * each in roster order. Given `first` ids, those lead instead, in that order.
 */
export function tileOrder(roster, first) {
  const list = Array.isArray(roster) ? roster.filter((a) => a && typeof a.id === 'string') : []
  if (!Array.isArray(first)) return [...list.filter((a) => a.pinned === true), ...list.filter((a) => a.pinned !== true)]
  const lead = first.map((id) => list.find((a) => a.id === id)).filter(Boolean)
  return [...lead, ...list.filter((a) => !first.includes(a.id))]
}

// -------------------------------------------------------------------- tile

const byNewest = (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
const lastStep = (run) => {
  const steps = Array.isArray(run?.steps) ? run.steps : []
  return summaryLine(steps[steps.length - 1]?.text)
}

/**
 * What one agent's tile shows, from all the runs known (any agent, any order):
 *   { status, working, run, step, job }
 * working if any of its runs is; failed / lost if its newest run is; done for
 * `doneHoldMs` after a successful end; otherwise idle. The latest job is shown
 * whatever the status (null only when the agent has no runs).
 */
export function tileFor(runs, agentId, now, doneHoldMs = 8000) {
  const mine = (Array.isArray(runs) ? runs : []).filter((r) => r && r.agent === agentId).sort(byNewest)
  const live = mine.filter((r) => r.state === 'working')
  const last = mine[0] ?? null
  let status = 'idle'
  let run = last
  if (live.length) {
    status = 'working'
    run = live[0]
  } else if (last && (last.state === 'failed' || last.state === 'lost')) {
    status = last.state
  } else if (last && last.endedAt && now - last.endedAt < doneHoldMs) {
    status = 'done'
  }
  const step = status === 'working' ? lastStep(run) : ''
  let job = null
  if (run) {
    const working = run.state === 'working'
    job = {
      id: run.id,
      state: run.state,
      headline: headline(run.task),
      when: working ? 'now' : when(run.endedAt ?? run.startedAt, now),
      line: working ? lastStep(run) || 'Working' : summaryLine(run.summary),
    }
  }
  return { status, working: live.length, run, step, job }
}

// ------------------------------------------------------------------ layout

/*
 * Where the tiles go, from the window size. The core is the 3D ring
 * (src/scene/Core.tsx): its diameter is FIT = 0.60 of the shorter viewport
 * side, centred. Measured in headless Chrome from screenshots (bright pixels
 * on the centre row and column), its glow reaches 0.616 of the shorter side
 * (1920x1080: x 632-1297, y 213-867). RING_FIT = 0.66 adds a margin for the
 * glow and the camera drift. So the ring's left edge is (width - ring) / 2:
 * 2560x1440: 805, 1920x1080: 604, 1400x850: 420, 1150x800: 311, 900x700: 219.
 *
 *   columns  Two columns at the outer edges (EDGE = 92px, the same inset as
 *            the top bar), the first half (the pinned four first) on the
 *            left. Column width clamp(300px, 20vw, 480px). Used when a column
 *            plus a GAP of 48px still ends before the ring and the window is
 *            at least 640px tall: 1920x1080 needs 92+384+48 = 524 <= 604,
 *            2560x1440 needs 92+480+48 = 620 <= 805. 1400x850 needs 440 > 420,
 *            so roughly below 1450px wide it is one column instead.
 *   column   One right-hand column of compact tiles, COLUMN_EDGE = 40px from
 *            the edge, width min(280, ringLeft - 40 - 24) when that is at
 *            least 160px (1400x850: 280; 1150x800: 247).
 *   strip    Anything smaller (900x700: 155 < 160): one-line chips in the
 *            space that is left, at least 120px wide.
 *
 * compact: the tiles drop the job lines (name, state, one line). Always so in
 * column/strip; in columns when the height per tile, (height - 112 top - 260
 * kept for the rails at the bottom) / tiles per column, is under 104px.
 */
export const LAYOUT = {
  EDGE: 92,
  GAP: 48,
  COLUMN_EDGE: 40,
  COLUMN_GAP: 24,
  TOP: 112,
  BOTTOM: 260,
  MIN_COLUMNS_HEIGHT: 640,
  MIN_FULL_TILE: 104,
  MIN_COLUMN: 160,
  MAX_COLUMN: 280,
  MIN_STRIP: 120,
  RING_FIT: 0.66,
}

/** The core ring's diameter (with its glow and a margin) for a window. */
export const ringSize = (width, height) => LAYOUT.RING_FIT * Math.min(width, height)

export function tileLayout(width, height, count) {
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const h = Number.isFinite(height) && height > 0 ? height : 0
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0))
  const ringLeft = (w - ringSize(w, h)) / 2
  const L = LAYOUT

  const colW = Math.round(Math.min(480, Math.max(300, 0.2 * w)))
  if (L.EDGE + colW + L.GAP <= ringLeft && h >= L.MIN_COLUMNS_HEIGHT) {
    const left = Math.ceil(n / 2)
    const perTile = (h - L.TOP - L.BOTTOM) / Math.max(1, left)
    return { mode: 'columns', left, right: n - left, compact: perTile < L.MIN_FULL_TILE, tileWidth: colW }
  }
  const one = Math.floor(Math.min(L.MAX_COLUMN, ringLeft - L.COLUMN_EDGE - L.COLUMN_GAP))
  // A compact tile takes 44px (40 + a 4px gap), a chip 32px (30 + 2). When the
  // column's room (height - 100 top - 256 bottom) cannot hold them all, they
  // become the strip's one-line chips at the column's width; when one column
  // of chips cannot hold them either, a second column of the same width opens
  // on the left (the core is centred, so it has the same room), compact tiles
  // again if they fit two to a row. None is scrolled away below 2 x 12 chips
  // at 1366x768.
  const room = h - 356
  const fits = n * 44 <= room
  if (one >= L.MIN_COLUMN && fits) return { mode: 'column', left: 0, right: n, compact: true, tileWidth: one }
  const chips = n * 32 - 2 <= room
  const half = Math.ceil(n / 2)
  const split = (mode, tileWidth) => ({ mode, left: half, right: n - half, compact: true, tileWidth })
  if (one >= L.MIN_COLUMN) {
    if (chips) return { mode: 'strip', left: 0, right: n, compact: true, tileWidth: one }
    return split(half * 44 <= room ? 'column' : 'strip', one)
  }
  const chip = Math.max(L.MIN_STRIP, Math.floor(ringLeft - 28 - 12))
  if (chips) return { mode: 'strip', left: 0, right: n, compact: true, tileWidth: chip }
  return split('strip', chip)
}

// -------------------------------------------------------------------- runs

export const RUN_ID = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/
export const isRunId = (s) => typeof s === 'string' && RUN_ID.test(s)

const stepsOf = (r) => (Array.isArray(r?.steps) ? r.steps : [])
/** The fetched text when it is a longer version of the live one (the live copy is capped). */
const longer = (live, fetched) =>
  typeof fetched === 'string' && fetched.length > (live?.length ?? 0) && fetched.startsWith(live ?? '') ? fetched : live

/**
 * The fetched history and the live runs as one list, newest first. A live run
 * replaces the fetched one with the same id (its state is newer), but keeps
 * the fetched run's longer steps list (plus any live steps newer than it), the
 * fetched task and summary when they are longer versions of the live ones (the
 * live copies are capped), and counts the full result as kept when either copy says it is.
 */
export function mergeRuns(fetched, live) {
  const out = new Map()
  for (const r of Array.isArray(fetched) ? fetched : []) if (r && typeof r.id === 'string') out.set(r.id, r)
  for (const r of Array.isArray(live) ? live : []) {
    if (!r || typeof r.id !== 'string') continue
    const old = out.get(r.id)
    if (!old) {
      out.set(r.id, r)
      continue
    }
    const merged = { ...r }
    const a = stepsOf(old)
    const b = stepsOf(r)
    if (a.length > b.length) {
      const lastTs = a.length ? a[a.length - 1].ts || 0 : 0
      merged.steps = [...a, ...b.filter((s) => (s.ts || 0) > lastTs)]
    }
    merged.task = longer(r.task, old.task)
    merged.summary = longer(r.summary, old.summary)
    // Kept if either side says so: the fetched flag is whether the file is
    // there now (a result attached later counts), the live one comes from the
    // run's end event, which older runs do not carry.
    if (typeof r.full === 'boolean' || typeof old.full === 'boolean') merged.full = r.full === true || old.full === true
    out.set(r.id, merged)
  }
  return [...out.values()].sort(byNewest)
}

// ------------------------------------------------------------------- links

const URLISH = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)|\bhttps?:\/\/[^\s<>"'`]+/gi
const TRAIL = /[).,;:!?'"\]}>]+$/

/** The href if `s` is an absolute http(s) URL, else null. */
function safeHref(s) {
  if (typeof s !== 'string' || !/^https?:\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    return u.href
  } catch {
    return null
  }
}

/**
 * A line of untrusted text as parts: [{ text }] or [{ text, href }]. Only
 * absolute http:// and https:// URLs become links (checked with new URL);
 * trailing punctuation stays outside a bare link; [label](https://x) becomes
 * { text: label, href }. Anything else (javascript:, data:, file:, mailto:,
 * //host) stays literal text.
 */
export function linkParts(line) {
  const s = typeof line === 'string' ? line : ''
  const parts = []
  const push = (text, href) => {
    if (!text) return
    const prev = parts[parts.length - 1]
    if (!href && prev && !prev.href) prev.text += text
    else parts.push(href ? { text, href } : { text })
  }
  let at = 0
  for (const m of s.matchAll(URLISH)) {
    const start = m.index
    if (m[1] !== undefined) {
      const href = safeHref(m[2])
      push(s.slice(at, start))
      if (href) push(m[1], href)
      else push(m[0])
      at = start + m[0].length
      continue
    }
    let url = m[0]
    // A closing paren that belongs to the URL ("wiki/Foo_(bar)") stays.
    let trail = ''
    const t = url.match(TRAIL)
    if (t) {
      trail = t[0]
      url = url.slice(0, -trail.length)
      if (trail.startsWith(')') && url.includes('(') && !url.includes(')')) {
        url += ')'
        trail = trail.slice(1)
      }
    }
    const href = safeHref(url)
    push(s.slice(at, start))
    if (href) push(url, href)
    else push(url)
    push(trail)
    at = start + m[0].length
  }
  push(s.slice(at))
  return parts
}

// ------------------------------------------------------------------ format

/** How much of a result is ever classified, and how many blocks at most. */
export const RESULT_CAP = 220000
export const MAX_BLOCKS = 4000

const FENCE = /^\s*(```|~~~)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^(\s*)(?:[-*+•]|\d{1,4}[.)])\s+(.*)$/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/
const TABLE = /^\s*\|.*\|\s*$/

/** "**Bold**" (the whole line) loses its markers; anything more involved stays as written. */
function unbold(s) {
  const m = s.match(/^\*\*([^*]+)\*\*(:?)$/) || s.match(/^__([^_]+)__(:?)$/)
  if (m) return m[1] + m[2]
  return s.replace(/\*\*([^*\n]{1,200})\*\*/g, '$1')
}

/**
 * Untrusted result text as blocks for plain-text rendering:
 *   { type: 'heading', level: 1..4, parts } | { type: 'bullet', depth, parts }
 *   | { type: 'para', parts } | { type: 'code', text } | { type: 'rule' }
 * parts come from linkParts. '#' headings, '-', '*', '1.' bullets, ``` fences
 * as code, '---' rules, blank lines between paragraphs, table rows as code
 * (monospace) lines. Consecutive plain lines join into one paragraph with
 * '\n' kept (the HUD renders them as line breaks). Input is capped at
 * RESULT_CAP characters and the output at `maxBlocks` blocks.
 */
export function formatResult(text, maxBlocks = MAX_BLOCKS) {
  const src = (typeof text === 'string' ? text : '').slice(0, RESULT_CAP).replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  const blocks = []
  let para = null
  let code = null
  let table = null
  const full = () => blocks.length >= maxBlocks
  const add = (b) => {
    if (!full()) blocks.push(b)
  }
  const endPara = () => {
    if (para !== null) add({ type: 'para', parts: linkParts(para) })
    para = null
  }
  const endTable = () => {
    if (table !== null) add({ type: 'code', text: table })
    table = null
  }

  for (const raw of lines) {
    if (full()) break
    if (code !== null) {
      if (FENCE.test(raw)) {
        add({ type: 'code', text: code.join('\n') })
        code = null
      } else code.push(raw)
      continue
    }
    if (FENCE.test(raw)) {
      endPara()
      endTable()
      code = []
      continue
    }
    const line = raw.replace(/\s+$/, '')
    if (TABLE.test(line)) {
      endPara()
      table = table === null ? line.trim() : `${table}\n${line.trim()}`
      continue
    }
    endTable()
    if (!line.trim()) {
      endPara()
      continue
    }
    if (RULE.test(line)) {
      endPara()
      add({ type: 'rule' })
      continue
    }
    const h = line.match(HEADING)
    if (h) {
      endPara()
      add({ type: 'heading', level: Math.min(4, h[1].length), parts: linkParts(unbold(h[2])) })
      continue
    }
    const b = line.match(BULLET)
    if (b) {
      endPara()
      const indent = b[1].replace(/\t/g, '  ').length
      add({ type: 'bullet', depth: Math.min(3, Math.floor(indent / 2)), parts: linkParts(unbold(b[2])) })
      continue
    }
    para = para === null ? unbold(line.trim()) : `${para}\n${unbold(line.trim())}`
  }
  if (code !== null) add({ type: 'code', text: code.join('\n') })
  endTable()
  endPara()
  return blocks
}
