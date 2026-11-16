# Bridge Implementation Templates

Use these templates when adding a specialist agent that is not a plain Hermes profile (another CLI or a script) to the team connector in `hermes-mcp/`.

## 1. Roster entry (venom.agents.json)

Every agent, bridged or not, has one entry in the roster file:

```json
{
  "id": "new_agent",
  "name": "New Agent",
  "kind": "specialist",
  "role": "Clear, one-sentence description of what this agent does and when to pick it."
}
```

## 2. Runner (hermes-mcp/runner.mjs)

### Environment function example

If the agent needs its own environment variables, or must not see the supervisor's keys:

```javascript
function newAgentEnv() {
  const env = childEnv(); // inherits the base process environment
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC|CLAUDE)/i.test(k)) delete env[k];
  }
  // Add agent-specific variables if needed:
  // env.SOME_SPECIFIC_SETTING = 'value';
  return env;
}
```

### Execution logic example

If the agent uses a different program or arguments:

```javascript
const isNewAgent = agent === 'new_agent';
const exe = isNewAgent ? 'path/to/new_exe' : HERMES;
const args = isNewAgent
  ? ['--flag', 'value', '-q', task]
  : ['-p', agent, 'chat', '-q', task, '-Q', '--source', 'tool'];

const child = spawn(exe, args, {
  cwd: WORKDIR,
  env: isNewAgent ? newAgentEnv() : childEnv(),
  windowsHide: true
});
```

## 3. Verification template (selftest.mjs)

Always check the agent through the real connector:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const agent = process.argv[2]
const task = process.argv[3] ?? 'Agent online.'
const client = new Client({ name: 'selftest', version: '1.0.0' })

await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url))]
}))

const res = await client.callTool({
  name: 'ask_agent',
  arguments: { agent, task }
})

console.log(res.content.map((c) => c.text).join('\n'))
await client.close()
```

Venom OS already ships this script as `hermes-mcp/selftest.mjs`.
