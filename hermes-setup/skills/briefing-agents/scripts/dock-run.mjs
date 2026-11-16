// Run one agent task through the real team connector (so it is recorded and
// shows on the Venom OS team dock), with a longer limit than the 20-minute default.
// Usage: node dock-run.mjs <agent> <task> [minutes]
// The Venom OS folder is taken from VENOM_APP_DIR, else the current folder.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const app = process.env.VENOM_APP_DIR || process.cwd()
const sdk = (p) => pathToFileURL(join(app, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href
const { Client } = await import(sdk('client/index.js'))
const { StdioClientTransport } = await import(sdk('client/stdio.js'))

const [agent, task, minutes = '45'] = process.argv.slice(2)
if (!agent || !task) {
  console.error('Usage: node dock-run.mjs <agent> <task> [minutes]')
  process.exit(2)
}
const ms = Number(minutes) * 60 * 1000
const client = new Client({ name: 'dock-run', version: '1.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(app, 'hermes-mcp', 'server.mjs')],
  env: { ...process.env, HERMES_TIMEOUT_MS: String(ms) },
}))
const t0 = Date.now()
const res = await client.callTool({ name: 'ask_agent', arguments: { agent, task } }, undefined, { timeout: ms + 60000, maxTotalTimeout: ms + 60000 })
console.log(`isError=${!!res.isError} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(res.content.map((c) => c.text).join('\n'))
await client.close()
