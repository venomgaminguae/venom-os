#!/usr/bin/env node
// npm run add-agent              asks a few questions and adds an agent to the team:
//                                its Hermes profile (copied from the supervisor), its
//                                job brief (SOUL.md) and its line in venom.agents.json.
// npm run add-agent -- --no-alias  Hermes creates no per-profile command for it.
// The logic is in scripts/agents-lib.mjs.
import { addAgent, realDeps } from './agents-lib.mjs'

if (!process.stdin.isTTY) {
  console.log('npm run add-agent asks you questions, so run it in a terminal window, not through a pipe.')
  process.exit(1)
}
process.exit(await addAgent(realDeps({ noAlias: process.argv.slice(2).includes('--no-alias') })))
