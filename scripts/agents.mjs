#!/usr/bin/env node
// npm run agents              shows the team: each agent, the Hermes profile it runs
//                             on, and whether it answers a one-line test question.
// npm run agents -- --quick   the same without asking the agents.
// The logic is in scripts/agents-lib.mjs.
import { loadRoster } from '../hermes-mcp/roster.mjs'
import { listAgents, realDeps } from './agents-lib.mjs'

if (!process.stdin.isTTY) {
  console.log('npm run agents is meant for a terminal window, not a pipe: open a terminal and run it there.')
  process.exit(1)
}

// Where the two bridges' programs are, as the runner sees them. The runner
// reads the team list when it loads, so it is loaded only when that list is
// usable (otherwise listAgents explains what is wrong with it).
let bridgeExe = {}
try {
  loadRoster()
  const { CLAUDE, AGY } = await import('../hermes-mcp/runner.mjs')
  bridgeExe = { claude: CLAUDE, gemini: AGY }
} catch {
  bridgeExe = {}
}
process.exit(await listAgents(realDeps({ quick: process.argv.slice(2).includes('--quick'), bridgeExe })))
