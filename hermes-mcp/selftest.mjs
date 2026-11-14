// Calls the Hermes team connector the way VENOM would: start it over stdio,
// list its tools, give one agent one task.
// Usage: node hermes-mcp/selftest.mjs <agent> "task"
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const agent = process.argv[2] ?? 'writer'
const task = process.argv[3] ?? 'Reply with exactly: Agent online.'
const client = new Client({ name: 'selftest', version: '1.0.0' })
// Passes this process's environment on (the SDK otherwise hands the server
// only a short default list), so VENOM_AGENTS_DIR and friends reach it.
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env } }))
const { tools } = await client.listTools()
console.log('tools:', tools.map((t) => t.name).join(', '))
const t0 = Date.now()
const res = await client.callTool({ name: 'ask_agent', arguments: { agent, task } }, undefined, { timeout: 20 * 60 * 1000 })
console.log(`isError=${!!res.isError} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(res.content.map((c) => c.text).join('\n'))
await client.close()
