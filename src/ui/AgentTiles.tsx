import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore, type AgentInfo } from '../store'
import { tileFor, tileLayout, tileOrder, LAYOUT, type TileLayout } from '../../hermes-mcp/tiles.mjs'
import { usePinnedRuns } from './pinnedRuns'
import { useAgentView } from './agentViewStore'
import { allRuns, elapsed, type TeamRun } from './teamData'

/**
 * One tile per roster agent, always on screen (A hides or shows them all):
 * name, a state light and word, the elapsed time and current step while it
 * works, ×N when several of its runs are live, and its latest job (headline,
 * when, one line of the result). The roster entries marked `pinned` come
 * first (tileOrder, hermes-mcp/tiles.mjs).
 *
 * Where they go comes from tileLayout (hermes-mcp/tiles.mjs, thresholds
 * documented there): two columns at the outer edges when the core leaves room
 * (full screen at 1920x1080 and up), else one compact right-hand column, else
 * a strip of one-line chips. The mode, the tile width and the room the tiles
 * take on each side are published on <html> (data-tiles, --tile-w,
 * --tiles-reserve) so the rails and the transcript in index.css can move out
 * of their way.
 *
 * Tiles sit in the HUD with z-index auto, before <Blades />, so an open blade
 * (z-index 6) paints over them. Agent text is plain React text.
 */

/** How long a finished run shows as done before the tile settles to idle. */
const DONE_HOLD_MS = 8000

function useTileLayout(count: number, shown: boolean): TileLayout {
  const measure = () => tileLayout(window.innerWidth, window.innerHeight, count)
  const [layout, setLayout] = useState(measure)
  useEffect(() => {
    const on = () => setLayout(tileLayout(window.innerWidth, window.innerHeight, count))
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [count])

  useEffect(() => {
    const root = document.documentElement
    if (!shown) {
      delete root.dataset.tiles
      delete root.dataset.tilesLeft
      root.style.removeProperty('--tile-w')
      root.style.removeProperty('--tiles-reserve')
      return
    }
    const edge = layout.mode === 'columns' ? LAYOUT.EDGE + LAYOUT.GAP : layout.mode === 'column' ? LAYOUT.COLUMN_EDGE + LAYOUT.GAP : 40
    root.dataset.tiles = layout.mode
    // A left-hand column outside 'columns' mode (many agents, small window) moves SYSTEMS too (index.css).
    if (layout.left > 0 && layout.mode !== 'columns') root.dataset.tilesLeft = ''
    else delete root.dataset.tilesLeft
    root.style.setProperty('--tile-w', `${layout.tileWidth}px`)
    root.style.setProperty('--tiles-reserve', `${layout.tileWidth + edge}px`)
  }, [layout, shown])

  useEffect(
    () => () => {
      const root = document.documentElement
      delete root.dataset.tiles
      delete root.dataset.tilesLeft
      root.style.removeProperty('--tile-w')
      root.style.removeProperty('--tiles-reserve')
    },
    [],
  )
  return layout
}

/** Space and Enter on a tile's buttons activate the button and nothing else (Space is also the talk key). */
const keepKeys = (e: ReactKeyboardEvent) => {
  if (e.key === ' ' || e.key === 'Enter' || e.code === 'Space') e.stopPropagation()
}

function AgentTile({ agent, runs, now, compact }: { agent: AgentInfo; runs: TeamRun[]; now: number; compact: boolean }) {
  const open = useAgentView((s) => s.open)
  const t = tileFor(runs, agent.id, now, DONE_HOLD_MS)
  const look = t.status === 'lost' ? 'failed' : t.status
  const working = t.status === 'working' && t.run
  const state = working ? `working · ${elapsed(now - t.run!.startedAt)}` : t.status
  const now_ = working ? `now: ${t.step || 'Working'}` : ''
  const job = t.job
  // The one line a compact tile has: the live step, else the latest job.
  const line = working ? now_ : job ? job.headline : 'No jobs yet'

  return (
    <article className={`tile tile-${look}${compact ? ' tile-compact' : ''}`} data-agent={agent.id}>
      <button
        type="button"
        className="tile-main"
        onClick={() => open(agent.id)}
        onKeyDown={keepKeys}
        title={agent.role}
      >
        <span className="tile-head">
          <span className="td-light" />
          <span className="tile-name">{agent.name}</span>
          {t.working > 1 && <span className="tile-count">×{t.working}</span>}
          <span className="tile-state">{state}</span>
        </span>
        {compact ? (
          <span className={`tile-line${line === 'No jobs yet' ? ' tile-none' : ''}`}>{line}</span>
        ) : (
          <>
            {working && <span className="tile-now">{now_}</span>}
            {job ? (
              <span className={`tile-job tile-job-${job.state === 'lost' ? 'failed' : job.state}`}>
                <span className="tile-job-head">
                  <span className="tile-job-task">{job.headline}</span>
                  {!working && <span className="tile-job-when">{job.when}</span>}
                </span>
                {!working && job.line && <span className="tile-job-line">{job.line}</span>}
              </span>
            ) : (
              <span className="tile-none">No jobs yet</span>
            )}
          </>
        )}
      </button>
      <button
        type="button"
        className="tile-expand"
        aria-label={`Open ${agent.name} full screen`}
        title={`Open ${agent.name} full screen`}
        onClick={() => open(agent.id)}
        onKeyDown={keepKeys}
      >
        ⤢
      </button>
    </article>
  )
}

export function AgentTiles() {
  const team = useStore((s) => s.team)
  const main = useStore((s) => s.runs)
  const kept = usePinnedRuns((s) => s.runs)
  const shown = useStore((s) => s.teamDock)
  const [now, setNow] = useState(() => Date.now())

  // The clock for elapsed times, "done" holds and "2m ago".
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const agents = useMemo(() => tileOrder(team), [team])
  const runs = useMemo(() => allRuns(main, kept), [main, kept])
  const layout = useTileLayout(agents.length, shown)
  if (!shown) return null

  const left = agents.slice(0, layout.left)
  const right = agents.slice(layout.left)
  const column = (list: AgentInfo[], side: 'left' | 'right') => (
    <section className={`tiles tiles-${side} tiles-${layout.mode}`} aria-label={side === 'left' ? 'Agents' : layout.left ? 'More agents' : 'Agents'}>
      {list.map((a) => (
        <AgentTile key={a.id} agent={a} runs={runs} now={now} compact={layout.compact} />
      ))}
    </section>
  )

  return (
    <>
      {left.length > 0 && column(left, 'left')}
      {right.length > 0 && column(right, 'right')}
    </>
  )
}
