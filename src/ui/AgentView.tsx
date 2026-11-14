import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { formatResult, mergeRuns, type LinkPart } from '../../hermes-mcp/tiles.mjs'
import { useAgentView } from './agentViewStore'
import { usePinnedRuns } from './pinnedRuns'
import { useRunResults } from './runResults'
import { allRuns, elapsed, text, toHistoryRun, type TeamRun } from './teamData'

/**
 * One agent, full screen: every run in the log, newest first, each with its
 * full task, its steps and its full result.
 *
 * Opened from a tile; Close (top right) or Esc closes it. Esc is taken in the
 * CAPTURE phase on window and stopped there, so it never reaches App's
 * bubble-phase handler (where Esc stands the assistant down). Every other key
 * passes through. The voice loop and the 3D scene keep running underneath.
 *
 * History: GET /team/runs?agent=<id> (up to 200 runs, 100 steps each),
 * merged with the live runs in the stores and fetched again whenever one of
 * this agent's runs starts or ends. Result texts: GET /team/run?id=<id>,
 * lazily as each card nears the view (runResults.ts). Without the endpoint
 * (an older bridge, or no bridge) it shows the runs the stores have.
 *
 * Results are untrusted: they go through formatResult/linkParts and render as
 * React text; the only links are http(s) hrefs, opened in a new tab with
 * noopener noreferrer.
 */

const MAX_RUNS = 200

type History = { state: 'loading' | 'ok' | 'fallback'; runs: TeamRun[] }

const stamp = (ts: number | null) =>
  ts
    ? new Date(ts).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

/** Keeps Space and Enter on the view's own buttons from also reaching the talk key. */
const keepKeys = (e: ReactKeyboardEvent) => {
  if (e.key === ' ' || e.key === 'Enter' || e.code === 'Space') e.stopPropagation()
}

function Parts({ parts }: { parts: LinkPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

function ResultText({ value }: { value: string }) {
  const blocks = useMemo(() => formatResult(value), [value])
  return (
    <div className="av-result">
      {blocks.map((b, i): ReactNode => {
        switch (b.type) {
          case 'heading': {
            const H = (['h3', 'h4', 'h5', 'h6'] as const)[b.level - 1]
            return (
              <H key={i} className={`av-h av-h${b.level}`}>
                <Parts parts={b.parts} />
              </H>
            )
          }
          case 'bullet':
            return (
              <p key={i} className="av-li" style={{ marginLeft: `${b.depth * 1.4}em` }}>
                <span className="av-bullet" aria-hidden="true">
                  •
                </span>
                <span>
                  <Parts parts={b.parts} />
                </span>
              </p>
            )
          case 'code':
            return (
              <pre key={i} className="av-code">
                {b.text}
              </pre>
            )
          case 'rule':
            return <hr key={i} className="av-rule" />
          default:
            return (
              <p key={i} className="av-p">
                <Parts parts={b.parts} />
              </p>
            )
        }
      })}
    </div>
  )
}

/** A run's result: the full text when the bridge kept it, else the summary. */
function RunResult({ run, near, history }: { run: TeamRun; near: boolean; history: History['state'] }) {
  const entry = useRunResults((s) => s.entries[run.id])
  const load = useRunResults((s) => s.load)
  // Only finished runs have a result, only when the history endpoint exists
  // (an older bridge has no /team/run either), and not when the bridge said
  // the text was not kept.
  const wanted = near && run.state !== 'working' && history === 'ok' && run.full !== false
  useEffect(() => {
    if (wanted) load(run.id)
  }, [wanted, run.id, load])

  if (run.state === 'working') return null
  const summary = run.summary ? <p className="av-summary">{run.summary}</p> : <p className="av-note">No result recorded.</p>
  if (history !== 'ok') return summary
  if (run.full === false || entry?.status === 'missing')
    return (
      <>
        {summary}
        <p className="av-note">Full text was not kept for this run.</p>
      </>
    )
  if (entry?.status === 'ok') return <ResultText value={entry.text} />
  if (entry?.status === 'error')
    return (
      <>
        {summary}
        <p className="av-note">The full text could not be loaded.</p>
      </>
    )
  return (
    <>
      {summary}
      <p className="av-note">Loading the full result…</p>
    </>
  )
}

function RunCard({ run, first, now, history, root }: { run: TeamRun; first: boolean; now: number; history: History['state']; root: HTMLElement | null }) {
  const ref = useRef<HTMLElement>(null)
  const [near, setNear] = useState(first)
  useEffect(() => {
    if (near || !ref.current || !root) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true)
      },
      { root, rootMargin: '600px 0px' },
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [near, root])

  const working = run.state === 'working'
  const dur = working ? now - run.startedAt : (run.ms ?? (run.endedAt ?? run.startedAt) - run.startedAt)
  const look = run.state === 'lost' ? 'failed' : run.state
  return (
    <article ref={ref} className={`av-run av-${look}`}>
      <header className="av-run-head">
        <span className="av-badge">{run.state}</span>
        <span>Started {stamp(run.startedAt)}</span>
        <span>{working ? 'Running' : `Ended ${stamp(run.endedAt)}`}</span>
        <span className="av-dur">{elapsed(dur)}</span>
      </header>
      <p className="av-task">{run.task || 'Untitled job'}</p>
      {run.steps.length > 0 && (
        <ol className="av-steps">
          {run.steps.map((s, i) => (
            <li key={`${s.ts}-${i}`}>{s.text}</li>
          ))}
        </ol>
      )}
      <RunResult run={run} near={near} history={history} />
    </article>
  )
}

function OpenView({ agent }: { agent: string }) {
  const close = useAgentView((s) => s.close)
  const info = useStore((s) => s.team.find((a) => a.id === agent))
  const main = useStore((s) => s.runs)
  const kept = usePinnedRuns((s) => s.runs)
  const live = useMemo(() => allRuns(main, kept).filter((r) => r.agent === agent), [main, kept, agent])
  const [history, setHistory] = useState<History>({ state: 'loading', runs: [] })
  const [now, setNow] = useState(() => Date.now())
  const closeRef = useRef<HTMLButtonElement>(null)
  const [body, setBody] = useState<HTMLDivElement | null>(null)

  // Fetch again when one of this agent's runs starts or ends.
  const sig = live.map((r) => `${r.id}:${r.state === 'working' ? 'w' : 'e'}`).join(',')
  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`${BRIDGE_HTTP_URL}/team/runs?agent=${encodeURIComponent(agent)}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const b = (await res.json()) as Record<string, unknown> | null
        if (!b || typeof b !== 'object' || !Array.isArray(b.runs)) throw new Error('shape')
        const runs = b.runs
          .slice(0, MAX_RUNS)
          .map((r) => toHistoryRun(r, agent))
          .filter((r): r is TeamRun => !!r)
        if (!ctrl.signal.aborted) setHistory({ state: 'ok', runs })
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setHistory((h) => ({ state: 'fallback', runs: h.state === 'ok' ? h.runs : [] }))
      })
    return () => ctrl.abort()
  }, [agent, sig])

  const runs = useMemo(() => mergeRuns(history.runs, live).slice(0, MAX_RUNS), [history.runs, live])
  const busy = runs.some((r) => r.state === 'working')
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [busy])

  // Focus the close button on open, give it back on close; abort result fetches on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => {
      useRunResults.getState().abortAll()
      const back =
        before && before.isConnected && before !== document.body
          ? before
          : document.querySelector<HTMLElement>(`.tile[data-agent="${CSS.escape(agent)}"] .tile-main`)
      back?.focus()
    }
  }, [agent])

  // Esc closes the view and goes no further (App's Esc would stand VENOM
  // down); PgUp/PgDn scroll the runs wherever the focus is. Capture phase on
  // window, so this runs before every other key handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        close()
        return
      }
      if ((e.key === 'PageDown' || e.key === 'PageUp') && body && !body.contains(e.target as Node)) {
        e.preventDefault()
        body.scrollBy({ top: (e.key === 'PageDown' ? 0.9 : -0.9) * body.clientHeight })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close, body])

  const tile = (() => {
    const w = runs.find((r) => r.state === 'working')
    if (w) return 'working'
    return runs[0] ? (runs[0].state === 'lost' ? 'lost' : runs[0].state === 'failed' ? 'failed' : 'idle') : 'idle'
  })()
  const name = text(info?.name, 40) || agent

  return (
    <div className="agent-view" role="dialog" aria-modal="true" aria-labelledby="av-title">
      <header className="av-head">
        <div className="av-head-main">
          <h2 id="av-title" className="av-title">
            <span className={`av-light av-light-${tile === 'lost' ? 'failed' : tile}`} />
            {name}
            <span className="av-state">{tile}</span>
          </h2>
          {info?.role && <p className="av-role">{info.role}</p>}
        </div>
        <span className="av-count">
          {runs.length} {runs.length === 1 ? 'run' : 'runs'}
        </span>
        <button ref={closeRef} type="button" className="av-close" onClick={close} onKeyDown={keepKeys}>
          <span aria-hidden="true">✕</span> Close
        </button>
      </header>
      <div className="av-body" ref={setBody} tabIndex={0}>
        <div className="av-inner">
          {history.state === 'fallback' && (
            <p className="av-fallback">Showing recent runs only. Full history needs the bridge restarted.</p>
          )}
          {history.state === 'loading' && !runs.length && <p className="av-note">Loading runs…</p>}
          {history.state !== 'loading' && !runs.length && <p className="av-note">No jobs yet.</p>}
          {runs.map((r, i) => (
            <RunCard key={r.id} run={r} first={i === 0} now={now} history={history.state} root={body} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function AgentView() {
  const agent = useAgentView((s) => s.agent)
  if (!agent) return null
  return <OpenView key={agent} agent={agent} />
}
