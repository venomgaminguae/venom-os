/**
 * The team roster, shared by the connector (tool description and enum), the
 * runner (project folders and profile names), the bridge (the HUD's team
 * dock and the brain's prompt) and scripts/log-run.mjs. It is data now:
 * `venom.agents.json` in the repo root (or VENOM_ROSTER_FILE), read once at
 * import by roster.mjs, which has the rules; without the file the four
 * starter agents are used. Never rename an id: the brain, the activity log
 * and the HUD all key on it. How to add an agent: `npm run add-agent`
 * (docs/adding-an-agent.md).
 *
 * An invalid roster stops the importing program here, with the plain
 * sentences that say what to fix on stderr and exit code 1, so the connector,
 * the bridge and log-run never start on a team they cannot route.
 */
import { writeSync } from 'node:fs'
import process from 'node:process'
import { agentIds, loadRoster, RosterError, rosterLines as linesOf } from './roster.mjs'

let loaded
try {
  loaded = loadRoster()
} catch (err) {
  if (!(err instanceof RosterError)) throw err
  writeSync(2, `The team list cannot be used:\n${err.message}\n`)
  process.exit(1)
}
for (const w of loaded.warnings) writeSync(2, `Team list: ${w}\n`)

export const AGENTS = loaded.agents

/** The ids, in roster order: the connector's `agent` enum. */
export const AGENT_IDS = agentIds(AGENTS)

/** 'file' when venom.agents.json was read, 'starter' when the starter set is in use. */
export const ROSTER_SOURCE = loaded.source

/** One line per agent, as the connector's tool description lists them. */
export const rosterLines = () => linesOf(AGENTS)
