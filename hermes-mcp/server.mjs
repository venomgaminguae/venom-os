#!/usr/bin/env node
/**
 * Hermes team connector for VENOM.
 *
 * A small stdio MCP server that lets the VENOM brain (Claude, via Claude Code)
 * hand a task to one of its specialist Hermes agents. Each agent is a Hermes
 * profile with its own model, job brief (SOUL.md), skills and memory, and its
 * own workers (Hermes subagents, set by delegation.* in that profile's
 * config.yaml). The agent's final answer comes back as text.
 *
 * Hermes's own `hermes mcp serve` only exposes messaging tools, which is why
 * this exists.
 *
 * The tool name has no read verb, so VENOM's policy (bridge/policy.mjs) only
 * lets it run when VENOM is started with --writes: agents can edit files and
 * run commands, so a call is treated as an action, not a lookup.
 *
 * The team itself is venom.agents.json, loaded by agents.mjs (an invalid one
 * stops the connector at start with what to fix on stderr), running
 * a task is in runner.mjs, and every run is recorded by activity.mjs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AGENT_IDS, rosterLines } from './agents.mjs'
import { pruneActivity } from './activity.mjs'
import { pruneRunFiles } from './runfiles.mjs'
import { runAgent } from './runner.mjs'

// Events and full results older than 14 days go at start. Never throws.
pruneActivity()
pruneRunFiles()

const server = new McpServer({ name: 'hermes', version: '2.0.0' })

server.registerTool(
  'ask_agent',
  {
    title: 'Give a task to one of your specialist agents',
    description:
      'Hand a self-contained task to one of your Hermes specialist agents. Each has its own job, ' +
      'model, skills and memory, and up to 5 workers of its own:\n' +
      rosterLines() +
      '\nWrite the task so it needs no follow-up: include paths, context, what done looks like and the ' +
      'answer format. Independent tasks for different agents can run at the same time. The agent ' +
      'returns a report; you are the supervisor, so check it before relying on it and send it back ' +
      'with corrections if it falls short. Takes seconds to many minutes.',
    inputSchema: {
      agent: z.enum(AGENT_IDS).describe('Which agent gets the task.'),
      task: z.string().min(1).describe('The complete task, written as a standalone instruction.'),
    },
  },
  async ({ agent, task }) => {
    const { ok, text } = await runAgent(agent, task)
    return { content: [{ type: 'text', text }], isError: !ok }
  },
)

await server.connect(new StdioServerTransport())
