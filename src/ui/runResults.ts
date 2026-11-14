import { create } from 'zustand'
import { BRIDGE_HTTP_URL } from '../config'
import { isRunId, RESULT_CAP } from '../../hermes-mcp/tiles.mjs'

/**
 * Full result texts for the expanded agent view, fetched lazily per run from
 * GET /team/run?id=<id> -> { id, text } (404: the text was not kept) and
 * cached for the session. The text is untrusted: it is only ever handed to
 * formatResult and rendered as React text.
 */
export type ResultEntry =
  | { status: 'loading' }
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'error' }

type RunResultsState = {
  entries: Record<string, ResultEntry>
  /** Fetch one run's text unless it is cached or on its way. */
  load: (id: string) => void
  /** Abort every fetch in flight (the view closed); they load again next time. */
  abortAll: () => void
}

const inflight = new Map<string, AbortController>()
/** At most this many texts are kept; the oldest go first. */
const MAX_CACHED = 300

export const useRunResults = create<RunResultsState>((set, get) => ({
  entries: {},
  load: (id) => {
    if (!isRunId(id)) {
      set((s) => ({ entries: { ...s.entries, [id]: { status: 'missing' } } }))
      return
    }
    const have = get().entries[id]
    if (have && have.status !== 'error') return
    const ctrl = new AbortController()
    inflight.set(id, ctrl)
    const put = (entry: ResultEntry | null) =>
      set((s) => {
        const entries = { ...s.entries }
        if (entry) entries[id] = entry
        else delete entries[id]
        const keys = Object.keys(entries)
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CACHED))) delete entries[k]
        return { entries }
      })
    put({ status: 'loading' })
    fetch(`${BRIDGE_HTTP_URL}/team/run?id=${encodeURIComponent(id)}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 404) return put({ status: 'missing' })
        if (!res.ok) return put({ status: 'error' })
        const body: unknown = await res.json()
        const b = body as Record<string, unknown> | null
        if (!b || typeof b !== 'object' || b.id !== id || typeof b.text !== 'string') return put({ status: 'error' })
        put({ status: 'ok', text: b.text.slice(0, RESULT_CAP) })
      })
      .catch(() => {
        // Aborted (view closed): forget it so it loads next time. Anything
        // else: an error the card shows quietly, retried on the next open.
        put(ctrl.signal.aborted ? null : { status: 'error' })
      })
      .finally(() => {
        if (inflight.get(id) === ctrl) inflight.delete(id)
      })
  },
  abortAll: () => {
    for (const c of inflight.values()) c.abort()
    inflight.clear()
  },
}))
