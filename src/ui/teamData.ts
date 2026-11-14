import { useStore, type AgentInfo, type AgentRun } from '../store'
import type { TeamFrame } from '../lib/bridge'
import { isRunId } from '../../hermes-mcp/tiles.mjs'
import { usePinnedRuns } from './pinnedRuns'

/**
 * The team's data as it arrives from the bridge, shape-checked and capped.
 * Shared by the tiles (AgentTiles.tsx), the expanded agent view (AgentView.tsx)
 * and the older 'team' blade (TeamRuns in TeamDock.tsx). Not a component file,
 * so the components keep their Fast Refresh boundary.
 *
 * Every string in a run was written by an agent or about one: untrusted. It is
 * rendered as React text only, never as markup.
 */

/** A run as the HUD keeps it: the store's shape plus whether its full result text was kept. */
export type TeamRun = AgentRun & { full?: boolean }

const STATES = new Set(['working', 'done', 'failed', 'lost'])
const KINDS = new Set(['specialist', 'project', 'advisor'])
export const text = (v: unknown, cap: number) => (typeof v === 'string' ? v.slice(0, cap) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

type Caps = { id: number; task: number; step: number; steps: number; summary: number }
/** What the live feed keeps (as before): enough for a tile. */
const LIVE: Caps = { id: 80, task: 300, step: 160, steps: 5, summary: 600 }
/** What the history endpoint may send: the whole run, still bounded. */
const HISTORY: Caps = { id: 80, task: 20000, step: 400, steps: 100, summary: 4000 }

function shape(v: unknown, caps: Caps): TeamRun | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id || r.id.length > caps.id) return null
  if (typeof r.agent !== 'string' || !STATES.has(r.state as string)) return null
  const run: TeamRun = {
    id: r.id,
    agent: r.agent.slice(0, 40),
    task: text(r.task, caps.task),
    state: r.state as AgentRun['state'],
    startedAt: num(r.startedAt) ?? 0,
    endedAt: num(r.endedAt),
    ms: num(r.ms),
    steps: (Array.isArray(r.steps) ? r.steps.slice(-caps.steps) : [])
      .map((s) => ({
        text: text((s as Record<string, unknown>)?.text, caps.step),
        ts: num((s as Record<string, unknown>)?.ts) ?? 0,
      }))
      .filter((s) => s.text),
    summary: text(r.summary, caps.summary),
  }
  if (typeof r.full === 'boolean') run.full = r.full
  return run
}

/** A run from the live feed, or null if it is not one. */
export const toRun = (v: unknown) => shape(v, LIVE)

/** A run from GET /team/runs: the id must be a real run id and the agent the one asked for. */
export function toHistoryRun(v: unknown, agent: string): TeamRun | null {
  const run = shape(v, HISTORY)
  return run && isRunId(run.id) && run.agent === agent ? run : null
}

export function toAgent(v: unknown): AgentInfo | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  if (typeof a.id !== 'string' || typeof a.name !== 'string') return null
  return {
    id: a.id.slice(0, 40),
    name: text(a.name, 40),
    role: text(a.role, 400),
    kind: (KINDS.has(a.kind as string) ? a.kind : 'specialist') as AgentInfo['kind'],
    pinned: a.pinned === true,
  }
}

/** Feeds the main store and the kept-runs store, with shape-checked runs only. */
export function onTeamFrame(frame: TeamFrame) {
  const s = useStore.getState()
  const kept = usePinnedRuns.getState()
  if (frame.kind === 'snapshot') {
    const roster = (Array.isArray(frame.roster) ? frame.roster : []).slice(0, 50).map(toAgent).filter((a): a is AgentInfo => !!a)
    const runs = (Array.isArray(frame.runs) ? frame.runs : []).slice(0, 500).map(toRun).filter((r): r is TeamRun => !!r)
    s.setTeam(roster, runs)
    // A snapshot replaces the kept runs too, as it does the team's.
    kept.setAll(runs)
  } else {
    const run = toRun(frame.run)
    if (run) {
      s.upsertRun(run)
      kept.upsert(run)
    }
  }
}

/** 45s · 3m 05s · 1h 02m */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The newest run per id from both stores (the main store's copy wins), newest first. */
export function allRuns(main: TeamRun[], kept: TeamRun[]): TeamRun[] {
  const seen = new Set(main.map((r) => r.id))
  return [...main, ...kept.filter((r) => !seen.has(r.id))].sort((a, b) => b.startedAt - a.startedAt)
}
