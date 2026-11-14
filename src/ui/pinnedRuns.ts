import { create } from 'zustand'
import { keepRuns } from '../../hermes-mcp/pinned.mjs'
import { useStore } from '../store'
import type { TeamRun } from './teamData'

/**
 * Every roster agent's latest runs, for the agent tiles (one per agent, always
 * on screen) and the expanded agent view.
 *
 * Kept apart from the main store on purpose. The main store keeps the 60
 * newest runs of the whole team, so a busy agent would push a quieter one's
 * last jobs off its tile; and the main store cannot be changed while the app
 * is live (editing it reloads the page and ends the owner's voice session).
 *
 * Holds ONLY each current roster agent's newest PINNED_JOBS (3) runs (keepRuns
 * with max 0 and the ids of the store's team, which comes from the bridge's
 * snapshot and is capped at 50 agents), newest first, so it is bounded at
 * team.length * 3. Fed by teamData's onTeamFrame with runs that already
 * passed its shape check, after setTeam. (The name is from when only four
 * agents were pinned; every agent has a tile now.)
 */
type PinnedRunsState = {
  runs: TeamRun[]
  /** A snapshot replaces what is here, like setTeam. */
  setAll: (runs: TeamRun[]) => void
  /** A run frame: replaces the run with the same id, or adds it. */
  upsert: (run: TeamRun) => void
}

/** The ids of the roster agents in the main store right now. */
const rosterIds = () => useStore.getState().team.map((a) => a.id)

export const usePinnedRuns = create<PinnedRunsState>((set) => ({
  runs: [],
  setAll: (runs) => set({ runs: keepRuns(runs, 0, rosterIds()) }),
  upsert: (run) => set((s) => ({ runs: keepRuns([run, ...s.runs.filter((r) => r.id !== run.id)], 0, rosterIds()) })),
}))
