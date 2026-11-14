import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import {
  memoryLine,
  memoryRows,
  memorySummary,
  type MemoryLine,
  type MemoryRow,
} from '../lib/memoryLine'

/**
 * The memory section under the mic line. Reads the bridge's /memory/sources
 * (one row per memory source: state and counts only) on mount and every 30
 * seconds and shows one compact line; R toggles one row per source. A bridge
 * without that endpoint (404) falls back to the old /health `memory` line.
 * Every other failure is ignored and the last view kept.
 */

const POLL_MS = 30_000
const TIMEOUT_MS = 3_000

type View = { kind: 'rows'; rows: MemoryRow[] } | { kind: 'line'; line: MemoryLine } | null

function same(a: View, b: View): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'line' && b.kind === 'line') {
    return a.line.text === b.line.text && a.line.level === b.line.level
  }
  if (a.kind === 'rows' && b.kind === 'rows') return JSON.stringify(a.rows) === JSON.stringify(b.rows)
  return false
}

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, { signal })
  if (!res.ok) throw new Error(String(res.status))
  return (await res.json()) as unknown
}

export function MemoryStatus() {
  const [view, setView] = useState<View>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    let inflight: AbortController | null = null

    const poll = async () => {
      inflight?.abort()
      const ctl = new AbortController()
      inflight = ctl
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      try {
        let rows: MemoryRow[] = []
        try {
          rows = memoryRows(await getJson('/memory/sources', ctl.signal), Date.now())
        } catch {
          if (ctl.signal.aborted) return
        }
        let next: View
        if (rows.length > 0) {
          next = { kind: 'rows', rows }
        } else {
          // An older bridge (404) or an unusable answer: today's /health line.
          const h = await getJson('/health', ctl.signal)
          const line = memoryLine(h && typeof h === 'object' ? (h as { memory?: unknown }).memory : undefined)
          next = line ? { kind: 'line', line } : null
        }
        if (!alive) return
        setView((cur) => (same(cur, next) ? cur : next))
      } catch {
        // Bridge down, slow or not JSON: keep the last view.
      } finally {
        clearTimeout(timer)
        if (inflight === ctl) inflight = null
      }
    }

    void poll()
    const id = setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
      inflight?.abort()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'r' && e.key !== 'R') return
      if (typing(e.target) || typing(document.activeElement)) return
      e.preventDefault()
      setOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!view) return null

  if (view.kind === 'line') {
    return (
      <span
        className={'memory-status memory-' + view.line.level}
        title="Long-term memory shared with the chat assistant"
      >
        {view.line.text}
      </span>
    )
  }

  const sum = memorySummary(view.rows)
  return (
    <>
      {open && (
        <span className="memory-rows">
          {view.rows.map((r) => (
            <span className="memory-row" key={r.id}>
              <span className={'memory-' + r.level}>
                <span className="memory-dot" />
              </span>
              <span className="memory-cell">{r.label}</span>
              <span className={'memory-' + r.level}>{r.state}</span>
              <span className="memory-cell">{r.detail}</span>
              <span className="memory-cell">{r.age}</span>
            </span>
          ))}
        </span>
      )}
      <span
        className={'memory-status memory-' + sum.level}
        title="Memory sources: state and counts. Press R for one row per source."
      >
        {sum.text}
        {open ? ' · R hide' : ' · R details'}
      </span>
    </>
  )
}
