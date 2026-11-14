// Import this FIRST in a test file whose imports load hermes-mcp/agents.mjs
// (directly or through runner.mjs, bridge/team.mjs or scripts/log-run.mjs).
// It points VENOM_ROSTER_FILE at a file that does not exist, so the roster is
// the starter set and the test never reads the owner's venom.agents.json.
// Imports run in source order, so this runs before agents.mjs reads the env.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const NO_ROSTER_FILE = join(tmpdir(), `venom-no-roster-${process.pid}`, 'venom.agents.json')
process.env.VENOM_ROSTER_FILE = NO_ROSTER_FILE
