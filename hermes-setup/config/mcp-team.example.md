# Registering the team connector

The team connector is `hermes-mcp/server.mjs` in this repository: a stdio MCP
server (its own server name is `hermes`) with one tool, `ask_agent`, that runs
a task on one agent of the team: `venom.agents.json`, read by
`hermes-mcp/agents.mjs` (the starter agents chosen at setup, any you added
with `npm run add-agent`, and the optional `claude` and `gemini` bridges).
Each Hermes agent is started as
`hermes -p <agent> chat -q <task> -Q --source tool` (see `hermes-mcp/runner.mjs`).

Run `npm ci` in the repository first: the connector needs
`@modelcontextprotocol/sdk` and `zod` from `node_modules`.

It is registered in two places, for two different callers.

## 1. In Hermes, for the supervisor profile (name: `team`)

`<supervisor>` below is the name of your supervisor profile; the default is
`venom`. Easiest: `npm run setup` (or the `create-profiles` scripts with a
repo path, `-RepoPath` / `--repo-path`) registers it for you, as the last step,
after the four specialists exist, and removes a `team` connector a specialist
copied from the supervisor. The connector is the same whatever model or
provider the agents run on.

So that the supervisor in the Hermes desktop app, terminal or Telegram can call
`ask_agent`. Register it on the supervisor profile only, never on the
specialists (a specialist that can call the team can start loops).

```sh
hermes -p <supervisor> mcp add team --command node --args "<REPO_PATH>/hermes-mcp/server.mjs"
```

- `--command`, `--args` and `--env` are from `hermes mcp add --help`.
  `--args` must be the last option.
- `hermes mcp add` is "discovery-first": it starts the server to list its tools
  and may ask you to pick which tools to enable. Keep `ask_agent`.
- Use forward slashes in `<REPO_PATH>` (for example `C:/code/venom-os`).
- If Hermes is not at `%LOCALAPPDATA%\hermes\bin\hermes.exe` (any non-Windows
  install), pass its path to the connector, before `--args`:
  `--env HERMES_EXE=<PATH_TO_HERMES>`.

Check it: `hermes -p <supervisor> mcp list` and `hermes -p <supervisor> mcp test team`.
If a specialist shows `team` in its own `mcp list`, remove it there:
`hermes -p <name> mcp remove team`.

The block this leaves in the supervisor profile's `config.yaml` (same shape as
the other stdio servers there):

```yaml
mcp_servers:
  team:
    command: node
    args:
      - <REPO_PATH>/hermes-mcp/server.mjs
    # env:                      # only if you passed --env
    #   HERMES_EXE: <PATH_TO_HERMES>
    enabled: true
```

## 2. In Claude Code's `~/.claude.json`, for the Venom OS app (name: `hermes`)

The Venom OS bridge does not read Hermes's config. It reads the MCP servers in
`~/.claude.json` (the top-level `mcpServers` block, plus the block of the
`projects` entry for your home folder; see `configuredServers()` in
`bridge/server.mjs`), keeps the ones named in `VENOM_MCP_SERVERS`
(`Venom.cmd` sets `hermes,context7,firecrawl,sequential-thinking`) and hands
them to the brain. The team prompt is switched on only when a server named
exactly `hermes` is among them.

Add it at user scope with the Claude Code CLI (syntax from
`claude mcp add --help`):

```sh
claude mcp add --scope user hermes -- node "<REPO_PATH>/hermes-mcp/server.mjs"
```

With a non-default Hermes location:

```sh
claude mcp add --scope user -e HERMES_EXE=<PATH_TO_HERMES> hermes -- node "<REPO_PATH>/hermes-mcp/server.mjs"
```

Check it: `claude mcp get hermes`.

What must end up in `~/.claude.json`:

```json
{
  "mcpServers": {
    "hermes": {
      "type": "stdio",
      "command": "node",
      "args": ["<REPO_PATH>/hermes-mcp/server.mjs"],
      "env": {}
    }
  }
}
```

Optional variables the connector reads (put them in `env` above, or in the
environment that starts Venom OS): `HERMES_EXE`, `HERMES_WORKDIR`,
`HERMES_TIMEOUT_MS`, `VENOM_AGENTS_DIR`, `TEAM_CLAUDE_EXE`,
`TEAM_CLAUDE_MODEL`, `AGY_EXE`, `AGY_MODEL`, `PROJECTS_ROOT`. Their defaults
are in `hermes-mcp/runner.mjs` and the repository README.
