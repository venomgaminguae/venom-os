#!/usr/bin/env node
// npm run remove-agent [-- <id>]   takes an agent off the team (venom.agents.json).
//                                  Its Hermes profile is deleted only when you say
//                                  so in a separate question.
// The logic is in scripts/agents-lib.mjs.
import { realDeps, removeAgent } from './agents-lib.mjs'

if (!process.stdin.isTTY) {
  console.log('npm run remove-agent asks you to confirm, so run it in a terminal window, not through a pipe.')
  process.exit(1)
}
const target = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? ''
process.exit(await removeAgent(realDeps({ target })))
