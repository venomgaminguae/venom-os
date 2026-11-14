/**
 * The HUD's long-term memory line, decided from the bridge's /health `memory`
 * field. Pure and import-free so node:test can load it directly.
 *
 * Missing, malformed or switched off -> null (nothing shown). The label is the
 * provider's display name, cut to 24 characters; it is rendered as plain text.
 */

export type MemoryLevel = 'ok' | 'warn' | 'quiet'
export type MemoryLine = { text: string; level: MemoryLevel }

const MAX_LABEL = 24

export function memoryLine(m: unknown): MemoryLine | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const o = m as { label?: unknown; state?: unknown; queued?: unknown }

  const raw = typeof o.label === 'string' ? o.label.trim() : ''
  const label = (raw === '' ? 'long-term' : raw).slice(0, MAX_LABEL)

  switch (o.state) {
    case 'ok':
      return { text: `memory · ${label} ok`, level: 'ok' }
    case 'offline': {
      const q = typeof o.queued === 'number' && Number.isFinite(o.queued) ? Math.floor(o.queued) : 0
      return { text: `memory · ${label} offline${q > 0 ? ` · ${q} waiting` : ''}`, level: 'warn' }
    }
    case 'unknown':
      return { text: `memory · ${label} checking`, level: 'quiet' }
    default:
      // 'off', or any state this build does not know: show nothing.
      return null
  }
}

/*
 * The memory section, decided from the bridge's GET /memory/sources: one row
 * per memory source with a state word and a count phrase. Everything here is
 * validated and cut to size; the strings are rendered as plain text.
 */

export type SourceId = 'honcho' | 'notes' | 'skills' | 'vault' | 'graph' | 'log'
export type SourceState = 'connected' | 'read-only' | 'offline' | 'not found' | 'off'
export type SourceLevel = 'ok' | 'warn' | 'bad' | 'quiet'
export type MemoryRow = {
  id: SourceId
  label: string
  state: SourceState
  level: SourceLevel
  detail: string
  age: string
}
export type MemorySummary = { text: string; level: SourceLevel }

const IDS: readonly SourceId[] = ['honcho', 'notes', 'skills', 'vault', 'graph', 'log']
const LABELS: Record<SourceId, string> = {
  honcho: 'Honcho',
  notes: 'Hermes notes',
  skills: 'Agent skills',
  vault: 'Obsidian vault',
  graph: 'Knowledge graph',
  log: 'Conversation log',
}
const SHORT: Record<SourceId, string> = {
  honcho: 'Honcho',
  notes: 'notes',
  skills: 'skills',
  vault: 'vault',
  graph: 'graph',
  log: 'log',
}
const STATES: readonly SourceState[] = ['connected', 'read-only', 'offline', 'not found', 'off']
const LEVELS: readonly SourceLevel[] = ['ok', 'warn', 'bad', 'quiet']
const RANK: Record<SourceLevel, number> = { quiet: 0, ok: 1, warn: 2, bad: 3 }
const MAX_DETAIL = 48
const MAX_SUMMARY = 110
// The source's own noun, dropped in the one-liner: `graph 1814 nodes` -> `graph 1814`.
const PLAIN_UNITS = new Set(['entries', 'skills', 'notes', 'nodes', 'turns'])

/** A short age for an ISO time: just now, 5 min ago, 3 h ago, 2 d ago; '' when unusable. */
export function ago(iso: unknown, now: number): string {
  if (typeof iso !== 'string' || iso === '' || !Number.isFinite(now)) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.floor((now - t) / 1000)
  if (s < 0) return ''
  if (s < 60) return 'just now'
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

/** Validates the /memory/sources JSON. Anything unusable -> []. Rows come back in the fixed order. */
export function memoryRows(payload: unknown, now: number): MemoryRow[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const list = (payload as { rows?: unknown }).rows
  if (!Array.isArray(list)) return []

  const seen = new Map<SourceId, MemoryRow>()
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const o = r as { id?: unknown; label?: unknown; state?: unknown; level?: unknown; detail?: unknown; updated?: unknown }
    const id = IDS.find((x) => x === o.id)
    if (!id || seen.has(id)) continue
    const rawLabel = typeof o.label === 'string' ? o.label.trim() : ''
    seen.set(id, {
      id,
      label: (rawLabel === '' ? LABELS[id] : rawLabel).slice(0, MAX_LABEL),
      state: STATES.find((x) => x === o.state) ?? 'not found',
      level: LEVELS.find((x) => x === o.level) ?? 'warn',
      detail: typeof o.detail === 'string' ? o.detail.trim().slice(0, MAX_DETAIL) : '',
      age: ago(o.updated, now),
    })
  }
  return IDS.flatMap((id) => {
    const row = seen.get(id)
    return row ? [row] : []
  })
}

function chip(r: MemoryRow): string {
  const first = r.detail.split(' · ')[0].trim()
  const counted = /^\d/.test(first)
  if (r.state === 'connected' || (r.state === 'read-only' && r.level === 'ok')) {
    if (!counted) return `${SHORT[r.id]} ok`
    const m = /^(\d+)\s+(\S+)$/.exec(first)
    return `${SHORT[r.id]} ${m && PLAIN_UNITS.has(m[2]) ? m[1] : first}`
  }
  // "not found" needs no second phrase ("no vault" says the same thing twice).
  const extra =
    r.state !== 'not found' && first !== '' && first !== r.state && first.length <= 16 ? ` ${first}` : ''
  return `${SHORT[r.id]} ${r.state}${extra}`
}

/** The compact one-liner over all rows; the worst level wins (bad > warn > ok > quiet). */
export function memorySummary(rows: readonly MemoryRow[]): MemorySummary {
  if (rows.length === 0) return { text: 'memory · no sources', level: 'quiet' }
  let level: SourceLevel = 'quiet'
  for (const r of rows) if (RANK[r.level] > RANK[level]) level = r.level
  let text = 'memory · ' + rows.map(chip).join(' · ')
  if (text.length > MAX_SUMMARY) text = text.slice(0, MAX_SUMMARY - 1).trimEnd() + '…'
  return { text, level }
}
