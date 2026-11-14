import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { watchTeam } from '../lib/bridge'
import { usePinnedRuns } from './pinnedRuns'
import { AgentTiles } from './AgentTiles'
import { allRuns, elapsed, onTeamFrame } from './teamData'

/**
 * The agent team on screen, so the owner can watch the team work instead of
 * waiting through a silent `ask_agent`.
 *
 * One tile per roster agent, always shown (AgentTiles.tsx): state, live step,
 * latest job. A tile opens that agent's full-screen view with every run and
 * its full result (AgentView.tsx). A shows or hides all the tiles.
 *
 * The data comes from the Hermes team connector's activity log, which every
 * run passes through wherever it was started (voice, the desktop chat,
 * scripts); the bridge tails it and pushes runs here (see bridge/team.mjs).
 * The frames are shape-checked in teamData.ts.
 *
 * Everything an agent wrote is untrusted. It is rendered as React text only,
 * never as markup.
 */

/** A blade listing one agent's recent runs (the older 'team' blades). Reads the stores, so it stays live. */
export function TeamRuns({ agent }: { agent?: string }) {
  const runs = useStore((s) => s.runs)
  const team = useStore((s) => s.team)
  const [now, setNow] = useState(() => Date.now())
  // An agent's latest jobs may have left the main store (it keeps the newest
  // runs of the whole team); the kept-runs store still has them.
  const kept = usePinnedRuns((s) => s.runs)
  const mine = allRuns(runs, kept).filter((r) => r.agent === agent)
  const busy = mine.some((r) => r.state === 'working')

  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [busy])

  const info = team.find((a) => a.id === agent)
  return (
    <div className="tr-list">
      {info && <p className="tr-role">{info.role}</p>}
      {!mine.length && <p className="bl-note">No runs recorded yet.</p>}
      {mine.map((r) => (
        <article key={r.id} className={`tr-run tr-${r.state}`}>
          <header className="tr-head">
            <span className="tr-state">{r.state}</span>
            <span className="tr-when">{new Date(r.startedAt).toLocaleString()}</span>
            <span className="tr-dur">
              {elapsed(r.state === 'working' ? now - r.startedAt : (r.ms ?? (r.endedAt ?? now) - r.startedAt))}
            </span>
          </header>
          <p className="tr-task">{r.task}</p>
          {r.steps.length > 0 && (
            <ol className="tr-steps">
              {r.steps.map((s, i) => (
                <li key={`${s.ts}-${i}`}>{s.text}</li>
              ))}
            </ol>
          )}
          {r.summary && <p className="tr-summary">{r.summary}</p>}
        </article>
      ))}
    </div>
  )
}

export function TeamDock() {
  // Registered here rather than with the other watchers in App's powerOn: the
  // tiles are mounted from first paint, so this is in place before the socket
  // opens and the snapshot cannot be missed.
  useEffect(() => watchTeam(onTeamFrame), [])

  // A shows or hides all the tiles (D is diagnostics, E/X/[/] are blades, F
  // is full screen).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'a' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        useStore.getState().toggleTeamDock()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return <AgentTiles />
}
