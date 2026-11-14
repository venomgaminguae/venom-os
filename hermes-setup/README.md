# Hermes setup kit for Venom OS

Venom OS's voice brain hands real work to a team of agents. Each agent is a
profile of **Hermes Agent** (open source, by Nous Research). This kit
recreates that team on your own machine from generic templates:

| Profile | Role |
|---|---|
| `<supervisor>` | Supervisor. Delegates to the specialists on the team through the team connector, checks their reports, answers you (Hermes desktop, terminal, Telegram). |
| `researcher` | Web research with links; verifies prices and facts on the live page. |
| `coder` | Writes, fixes, reviews and runs code; proves it with tests. |
| `operator` | This computer: files, documents, spreadsheets, PDFs, installs, routine tasks. |
| `writer` | Drafts emails, posts, documents and replies. Drafts only, never sends. |

`<supervisor>` is the name you give the supervisor profile. The default is
`venom`; every command below that says `<supervisor>` means that name. Whatever
it is called, it runs the job brief `souls/venom.SOUL.md`.

The four specialists are the starter team: `npm run setup` asks which of them
to create, and `npm run add-agent` adds agents of your own later (see
[../docs/adding-an-agent.md](../docs/adding-an-agent.md)). The team the app
uses is listed in `venom.agents.json` in the repository folder.

Optional, not Hermes profiles: `claude` (Claude Code CLI) and `gemini`
(Google Antigravity CLI `agy`). See step 8.

Every agent has a **brain** model (it plans, decides and checks) and **workers**
(Hermes subagents started with `delegate_task`, up to 5 at once, on a worker
model). You pick both models; nothing here assumes a provider. OpenAI,
Anthropic, Google and a local model (Ollama or LM Studio) all work the same way.

The brain you pick applies to the Hermes team only. The voice app in the
browser talks to the Claude Agent SDK, so it still needs Claude Code installed
and signed in, whatever brain the team uses (see the main README).

Nothing in this kit holds a key, a login or anyone's data. You bring your own
model account.

Tested: the wizard and both scripts are tested end to end against a stub
Hermes (`scripts/fake-hermes.mjs`, in `test/setup-brain.test.mjs`), not yet
against a real Hermes install or real provider accounts.

```
hermes-setup/
  README.md                          this file
  create-profiles.ps1                Windows (PowerShell 7) setup script
  create-profiles.sh                 bash setup script (Linux, macOS, WSL, git-bash)
  souls/<profile>.SOUL.md            job briefs (the supervisor uses venom.SOUL.md)
  config/model-settings.example.yaml brain + worker model keys
  config/fallback-chain.example.yaml fallback chain shape
  config/mcp-team.example.md         team connector registration, both places
```

## Quick setup: the wizard

You need:
- Node.js 22.12 or newer and Google Chrome,
- Hermes Agent: if it is missing, the wizard shows the official install
  command and offers to run it (or install it yourself, step 1),
- on Windows, PowerShell 7 (`pwsh`) or Git for Windows (its bash); elsewhere, bash,
- for a local brain, Ollama or LM Studio running with at least one model,
- for the voice app, Claude Code installed and signed in (the wizard reports
  whether it is).

From the repository root, in a real terminal window (not through a pipe):

```sh
npm ci
npm run setup
```

The wizard offers to install Hermes if it is missing and runs `hermes doctor`.
After the brain question it asks, for GPT and Claude, whether to sign in with
your subscription in Hermes's own picker (`hermes -p <supervisor> model`) or
to paste an API key. In that case it adds an empty line for the key to the supervisor
profile's `.env` (after a dated backup), opens that file in Notepad or your
editor, and checks the line without printing the key; Gemini goes straight
to the API key. It ends with a link test: the supervisor hands one agent a
one-line task through the team connector and must get the reply back. The
full list of steps is in the main README, under "Install and first run".

It saves `brain`, `worker`, `supervisorProfile` and `appModel` in
`venom.config.json` in the repository root (git-ignored; other keys in it are
kept). Running it again is safe.

Variants: `npm run setup -- --no-alias` (Hermes writes no per-profile
command), `npm run setup -- --check` (read-only preflight, changes nothing).

Then check the result with step 10 and, for the voice app, steps 6 and 7. The
rest of this file is the manual path, and what the wizard does under the hood.

## 1. Install Hermes

Official sources:
- Docs: <https://hermes-agent.nousresearch.com/docs/>
- Installation: <https://hermes-agent.nousresearch.com/docs/getting-started/installation>
- Windows (native) guide: <https://hermes-agent.nousresearch.com/docs/user-guide/windows-native>
- Source code: <https://github.com/NousResearch/hermes-agent>

Windows, in PowerShell (no admin rights needed; installs to
`%LOCALAPPDATA%\hermes\` and adds `hermes` to your user PATH):

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Linux, macOS or WSL2:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

The installation page also offers a desktop package (`.appinstaller` on
Windows). Open a **new** terminal afterwards, then:

```sh
hermes --version
hermes doctor
```

Venom OS's team connector looks for Hermes at
`%LOCALAPPDATA%\hermes\bin\hermes.exe`, which is where the Windows source
installer puts it. With any other install, set `HERMES_EXE` (step 6).

You also need Node.js 22.12 or newer and the repository's dependencies:
run `npm ci` in the repository root (see the main README).

## 2. Create the supervisor and sign it in

Use your own account or API key. Create the supervisor profile, then run the
picker for it, choose a provider, sign in, and choose a default model:

```sh
hermes profile create <supervisor> --description "Supervisor of the Venom OS team"
hermes -p <supervisor> model
```

Keys and logins stay in Hermes's own `.env` / auth store, never in
`config.yaml`, never in this repository. Doing this before step 3 matters:
the script creates the specialists as clones of the supervisor, so an API key
in the supervisor's `.env` carries over to them. Account sign-ins (for example
a ChatGPT or Claude account login) are stored per profile and are not copied;
for those, run `hermes -p <name> model` in each profile that fails its test.

Write down two model ids and their providers exactly as Hermes shows them
(`hermes -p <supervisor> config get model.default` and `... model.provider`
read them back):
- **brain model** and its provider: used by every agent,
- **worker model** and its provider: used by their subagents (can be the same or a cheaper one).

## 3. Create the profiles

The scripts take everything as parameters; there is nothing to edit in them.

| `create-profiles.ps1` | `create-profiles.sh` | Default | Meaning |
|---|---|---|---|
| `-Supervisor <name>` | `--supervisor <name>` | `venom` | Name of the supervisor profile |
| `-Agents <list>` | `--agents <list>` | all four | Starter specialists to create, comma-separated, any order, each once: a subset of `researcher,coder,operator,writer` |
| `-BrainModel <id>` | `--brain-model <id>` | none, required | Model every agent runs on |
| `-BrainProvider <name>` | `--brain-provider <name>` | none, required | Provider of the brain model |
| `-WorkerModel <id>` | `--worker-model <id>` | the brain model | Model for the workers |
| `-WorkerProvider <name>` | `--worker-provider <name>` | the brain provider | Provider of the worker model |
| `-MaxWorkers <n>` | `--max-workers <n>` | `5` | Workers per agent in parallel |
| `-RepoPath <path>` | `--repo-path <path>` | none: connector step skipped | Venom OS repository; registers the team connector |
| `-CloneFrom <profile>` | `--clone-from <profile>` | the supervisor | Profile the new specialists are cloned from; `none` creates them empty |
| `-NoAlias` | `--no-alias` | off | Passes `--no-alias` to `hermes profile create` (no per-profile command) |
| `-Browser`, `-NotesDir`, `-Market` | `--browser`, `--notes-dir`, `--market` | generic text | Filled into the SOUL templates |
| `-Log <file>` | `--log <file>` | a new file in the system temp folder | The full output (every `hermes` command and its output) is appended here |
| `-ShowCommands` | `--show-commands` | off | Also prints the full output on screen |
| `-WhatIf` | `--dry-run` (or `-n`) | off | Prints every command and file copy, runs nothing |

Model ids and provider names are written exactly as `hermes model` shows them.
An unknown, repeated or empty `-Agents` / `--agents` entry stops the script
(exit code 64) before anything is created. More agents, including your own,
are added later with `npm run add-agent` (see
[../docs/adding-an-agent.md](../docs/adding-an-agent.md)); their job brief
comes from `souls/agent.SOUL.md`, which these scripts do not use (its own
placeholders: `{{AGENT_NAME}}`, `{{AGENT_JOB}}`, and `{{PROJECT_FOLDER_SECTION}}`,
which is empty or a section that starts with a blank line and ends with a
newline).

The scripts are quiet: one line per profile (for example
`coder: created, job brief written, models set`, or `exists, job brief up to
date, models set` on a second run), then the team connector, the next step
and, last, `Full output: <path>` (the log). A failing command and its output
are always shown on screen. A dry run prints every command, as before.

The bash script also accepts `--option=value` and prints its usage with
`--help`; the PowerShell script's help is `Get-Help ./hermes-setup/create-profiles.ps1 -Full`.

Preview first, then run (`<MODEL_ID>`, `<PROVIDER>` and the others are your
own values):

```powershell
# Windows, PowerShell 7
pwsh -File ./hermes-setup/create-profiles.ps1 -BrainModel <MODEL_ID> -BrainProvider <PROVIDER> -WhatIf
pwsh -File ./hermes-setup/create-profiles.ps1 -BrainModel <MODEL_ID> -BrainProvider <PROVIDER> -RepoPath "<REPO_PATH>"

# A supervisor called boss, cheaper workers
pwsh -File ./hermes-setup/create-profiles.ps1 -Supervisor boss -BrainModel <MODEL_ID> -BrainProvider <PROVIDER> -WorkerModel <WORKER_MODEL_ID> -RepoPath "<REPO_PATH>"
```

```sh
# bash
bash hermes-setup/create-profiles.sh --brain-model <MODEL_ID> --brain-provider <PROVIDER> --dry-run
bash hermes-setup/create-profiles.sh --brain-model <MODEL_ID> --brain-provider <PROVIDER> --repo-path "<REPO_PATH>"

# A supervisor called boss, workers on another provider, 3 at a time
bash hermes-setup/create-profiles.sh --supervisor boss --brain-model <MODEL_ID> --brain-provider <PROVIDER> \
  --worker-model <WORKER_MODEL_ID> --worker-provider <WORKER_PROVIDER> --max-workers 3 --repo-path "<REPO_PATH>"
```

`<REPO_PATH>` is the absolute path of your Venom OS checkout, with forward
slashes (for example `C:/code/venom-os`). It is optional; without it the
script skips the team connector (step 6).

The scripts refuse to run (exit code 2) when:
- the brain model or provider is missing or still a `<PLACEHOLDER>`
  (a dry run only warns and carries on with the placeholders),
- the supervisor name is not lowercase letters, digits, `-` and `_`, or is one
  of the specialist names (`researcher`, `coder`, `operator`, `writer`) or a
  name Hermes reserves (`default`, `hermes`, `test`, `tmp`, `root`, `sudo`).

They stop with exit code 3 when Hermes is not found. They look for it in
`HERMES_EXE`, then on the PATH, then at `%LOCALAPPDATA%\hermes\bin\hermes.exe`.

What the script does, supervisor first, then the chosen specialists:
1. runs `hermes profile create <name> --description "<role>"`, unless
   `hermes profile show <name>` already finds it. The specialists are created
   with `--clone-from <supervisor>` (or your `-CloneFrom` / `--clone-from`
   profile), which copies the supervisor's `config.yaml`, `.env`, `SOUL.md` and
   skills, so an API key stored in the supervisor's `.env` carries over.
   Account sign-ins stored by Hermes are per profile and are **not** copied.
   A profile that already exists is not recreated, so nothing is cloned into it.
   With an explicit clone source, a missing supervisor is cloned from it too,
2. writes the SOUL template to the profile's `SOUL.md` (the folder of
   `hermes -p <name> config path`): `souls/venom.SOUL.md` for the supervisor,
   whatever it is called, and `souls/<name>.SOUL.md` for each specialist, with
   `{{BRAIN_MODEL}}`, `{{WORKER_MODEL}}`, `{{MAX_WORKERS}}`, `{{BROWSER}}`,
   `{{NOTES_DIR}}` and `{{MARKET}}` filled in. An existing, different `SOUL.md`
   is kept as `SOUL.md.bak-<timestamp>`, except in a profile this run has
   just created,
3. sets the models:

```sh
hermes -p <name> config set model.default         <BRAIN_MODEL>
hermes -p <name> config set model.provider        <BRAIN_PROVIDER>
hermes -p <name> config set delegation.model      <WORKER_MODEL>
hermes -p <name> config set delegation.provider   <WORKER_PROVIDER>
hermes -p <name> config set delegation.oneshot_max_children 5
```

4. for a specialist, removes a `team` connector it copied from the supervisor
   (`hermes -p <name> mcp remove team`, only if `mcp list` shows it): a
   specialist that can call the team can start loops.

Last, with a repo path, it registers the team connector on the supervisor
(step 6), unless `hermes -p <supervisor> mcp list` already shows it.

Running it again changes nothing that is already right. To do it by hand,
run the same commands and copy the SOUL files yourself, replacing the
`{{...}}` placeholders. Key names: `config/model-settings.example.yaml`.

Then test each agent (step 10). If one has no credentials, run
`hermes -p <name> model` in that profile and sign in there.

Unless you pass `--no-alias`, each profile also becomes its own command
(`researcher chat`, `coder doctor`, ...), per the profiles docs.

## 4. Edit the job briefs (optional)

`souls/*.SOUL.md` are the agents' standing instructions: role, the
brain/worker method (delegate real work, check every worker report against
the real thing before using it), learning (save skills), and safety (ask before
anything irreversible or outward-facing, never enter passwords, payment details
or API keys; one browser of your choice). Add your own context to the copy in
each profile folder, not to secrets-bearing files.

## 5. Fallback models (optional)

When the brain model is rate-limited or down, Hermes can switch to the next
entry of a fallback chain. The wizard offers this for the supervisor. Per
profile:

```sh
hermes -p <name> fallback add     # interactive picker, same as `hermes model`
hermes -p <name> fallback list
```

The chain lives in `config.yaml`, so specialists cloned after you add it to the
supervisor should start with a copy; check with `fallback list` and add it
to profiles that already existed. Shape of the result:
`config/fallback-chain.example.yaml`. Docs:
<https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers>

## 6. Register the team connector in Hermes

The team connector is `hermes-mcp/server.mjs` in this repository: a stdio MCP
server with one tool, `ask_agent(agent, task)`, which runs
`hermes -p <agent> chat -q <task> -Q --source tool` and returns the agent's
answer. Register it on the **supervisor profile only** (the script does this
as its last step when given the repo path, after every specialist exists):

```sh
hermes -p <supervisor> mcp add team --command node --args "<REPO_PATH>/hermes-mcp/server.mjs"
hermes -p <supervisor> mcp list
hermes -p <supervisor> mcp test team
```

`--args` must be the last option. With a non-default Hermes location, add
`--env HERMES_EXE=<PATH_TO_HERMES>` before `--args`. `hermes mcp add` starts
the server to discover its tools and may ask which to enable: keep
`ask_agent`. Resulting config block: `config/mcp-team.example.md`.

## 7. Connect Venom OS's bridge (the MCP server named `hermes`)

The Venom OS bridge does **not** read Hermes's configuration. From
`bridge/server.mjs` (`configuredServers()`): it reads the MCP servers in
Claude Code's `~/.claude.json` (the top-level `mcpServers` block and the
`projects` entry for your home folder), keeps those named in
`VENOM_MCP_SERVERS` (`Venom.cmd` sets `hermes,context7,firecrawl,sequential-thinking`),
and passes them to the brain. The team instructions are added to the brain's
prompt only when a server named exactly **`hermes`** is among them. That
`hermes` server is the same team connector, `node <REPO_PATH>/hermes-mcp/server.mjs`.

Add it with the Claude Code CLI at user scope:

```sh
claude mcp add --scope user hermes -- node "<REPO_PATH>/hermes-mcp/server.mjs"
claude mcp get hermes
```

The entry that must exist in `~/.claude.json`:

```json
"mcpServers": {
  "hermes": {
    "type": "stdio",
    "command": "node",
    "args": ["<REPO_PATH>/hermes-mcp/server.mjs"],
    "env": {}
  }
}
```

Put optional connector variables (`HERMES_EXE`, `HERMES_WORKDIR`,
`HERMES_TIMEOUT_MS`, `VENOM_AGENTS_DIR`, and step 8's) in `env`, or add them
with `claude mcp add ... -e KEY=VALUE`. If you leave `VENOM_MCP_SERVERS` unset
the bridge passes every configured server; if you set it, include `hermes`.

What is confirmed and what is not: the file, keys, server name and the
`VENOM_MCP_SERVERS` filter are read from the bridge code. That
`--scope user` writes the top-level `mcpServers` block is Claude Code's
documented behaviour, not something this kit tested; check with
`claude mcp get hermes` or by opening `~/.claude.json`.

## 8. Optional bridges: `claude` and `gemini`

These two roster entries are not Hermes profiles; the connector runs their
CLIs directly (`hermes-mcp/runner.mjs`). Skip them and the Hermes
agents still work.

**`claude`: Claude Code.** Install Claude Code with its official installer
and sign in with your own account. The connector needs the real executable,
not a `.cmd` shim, and runs it headless
(<https://code.claude.com/docs/en/headless>) with fixed permissions
(edits inside the projects folder; no push, no deleting folders; see the
repository README).

| Variable | Default | Effect |
|---|---|---|
| `TEAM_CLAUDE_EXE` | `~/.local/bin/claude.exe` | Path of the Claude Code executable |
| `TEAM_CLAUDE_MODEL` | Claude Code's own setting | Pins its model |
| `PROJECTS_ROOT` | see `runner.mjs` | Folder Claude Code works in; set it to your projects folder |

**`gemini`: Google Antigravity CLI (`agy`).** Install it and sign in with your
own Google account (headless mode:
<https://antigravity.google/docs/cli/headless/>, as linked from `runner.mjs`).
It runs read-only (plan mode). The connector removes Gemini/Google API-key
variables from its environment so it uses your sign-in.

| Variable | Default | Effect |
|---|---|---|
| `AGY_EXE` | `%LOCALAPPDATA%\agy\bin\agy.exe` | Path of the `agy` executable |
| `AGY_MODEL` | none (Antigravity picks) | Model slug, e.g. `<model-slug>` (list them with `agy models`) |

Set these where the connector runs: in the `env` of the `hermes` entry in
`~/.claude.json` (Venom OS), in `--env` of the Hermes `team` registration,
or in your user environment.

## 9. Optional: Telegram through Hermes

Hermes has its own messaging gateway; Venom OS is not involved. Follow the
official guide: <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram>.
In short: create a bot with @BotFather, then configure the supervisor profile
(it is the one that holds the team connector):

```sh
hermes -p <supervisor> gateway setup     # interactive; choose Telegram
```

It stores, in the supervisor profile's `.env`:

```
TELEGRAM_BOT_TOKEN=<TELEGRAM_BOT_TOKEN>
TELEGRAM_ALLOWED_USERS=<YOUR_TELEGRAM_USER_ID>
```

Always set the allowed users; a bot without an allowlist answers anyone.
Run it in the foreground with `hermes -p <supervisor> gateway run`, or see the
Windows guide for running it in the background. Never put the token in
this repository. Set the gateway up on the supervisor only: two profiles
holding one bot token collide (per `hermes profile create --help`, a clone
leaves messaging bot tokens behind unless `--clone-channels` is given, and the
scripts never pass it).

## 10. Verify

```sh
hermes profile list                       # <supervisor> and the agents you chose
hermes -p writer config get model.default
hermes -p writer config get delegation.model
hermes -p researcher chat -q "Reply with exactly: Agent online." -Q
hermes -p <supervisor> mcp test team
```

From the repository root, the connector self-test starts
`hermes-mcp/server.mjs` over stdio exactly as Venom OS does, lists its tools
and gives one agent one task (defaults: agent `writer`, task
`Reply with exactly: Agent online.`; it can take minutes):

```sh
node hermes-mcp/selftest.mjs
node hermes-mcp/selftest.mjs researcher "Reply with exactly: Agent online."
```

Expect `tools: ask_agent`, then `isError=false` and the agent's reply.
Finally start Venom OS (`Venom.cmd`): its log prints
`[venom] MCP servers from config: ...`, which must include `hermes`.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `hermes` not found | Open a new terminal after installing (PATH changed). Or set `HERMES_EXE` / call it by full path. |
| `npm run setup` says it is an interactive wizard | It was started through a pipe or a non-terminal; run it in a terminal window. |
| Wizard: "Neither PowerShell 7 (pwsh) nor bash was found" | Windows: install PowerShell 7 or Git for Windows, then run it again. |
| Script: "Still placeholders" | Pass `-BrainModel`/`-BrainProvider` (`--brain-model`/`--brain-provider`), or run `npm run setup`. |
| Script: "-Supervisor ... is not usable" | Pick another name: lowercase, not a specialist name or one Hermes reserves. |
| `config set` refuses a key | Your Hermes version names it differently: compare with `hermes -p <name> config show` and the docs; `--force` exists but writes unknown keys blindly. |
| Agent answers "no credentials" / auth errors | That profile has no login for the provider (account sign-ins are not cloned): `hermes -p <name> model`. Check `hermes -p <name> doctor`. |
| Self-test: agent not found / Hermes not found | The connector looks at `%LOCALAPPDATA%\hermes\bin\hermes.exe`; set `HERMES_EXE`. Each agent in `venom.agents.json` needs a Hermes profile named after its id (or its `profile` field): `npm run agents` shows which one is missing. |
| Self-test: `Cannot find module '@modelcontextprotocol/sdk'` | Run `npm ci` in the repository root. |
| A specialist can call `ask_agent` | It holds a copied `team` connector: `hermes -p <name> mcp remove team` (the script does this). |
| Venom OS never uses the team | No `hermes` entry in `~/.claude.json`, or `VENOM_MCP_SERVERS` does not list `hermes`. Check the boot log line. |
| `hermes mcp add` fails | It starts the server to discover tools: run `node <REPO_PATH>/hermes-mcp/server.mjs` by hand to see the error (it then waits on stdin; Ctrl+C). Use forward slashes in the path. |
| A run times out | Default limit 20 minutes; raise `HERMES_TIMEOUT_MS` in the connector's environment. |
| `claude` agent refuses to start | `TEAM_CLAUDE_EXE` points at a `.cmd` shim; point it at the real executable. |
| `gemini` agent uses an API key instead of your plan | It should not (the connector strips the key variables); check `AGY_EXE` points at your signed-in `agy`. |
| Two agents share memory or settings | Never point two profiles at one Hermes home; each profile is its own folder. |
| Anything else | `hermes doctor`, `hermes logs`, and <https://hermes-agent.nousresearch.com/docs/llms.txt> (index of every docs page). |

## Where each command comes from

Checked against Hermes Agent v0.23.1 help output and the docs pages linked above.

| Command | Source |
|---|---|
| `hermes profile create <name> --description --clone-from --no-alias`, `profile show`, `profile list` | `hermes profile --help`, `hermes profile create --help` |
| `hermes config set/get/path` (`--force`) | `hermes config --help`, `hermes config set --help` |
| `hermes mcp add <name> --command --args --env`, `mcp list`, `mcp test`, `mcp remove` | `hermes mcp add --help`, `hermes mcp --help`, `hermes mcp remove --help` |
| `hermes chat -q ... -Q --source tool` (`-m`, `--provider`) | `hermes chat --help`; same arguments as `hermes-mcp/runner.mjs` |
| `hermes model`, `hermes setup`, `hermes doctor`, `hermes fallback add/list/remove/clear`, `hermes gateway setup/run` | `hermes --help` and each subcommand's `--help` |
| `-p <profile>` (global profile flag) | Profiles docs and the connector's own use; not listed in `hermes --help` |
| Install one-liners | Installation docs page |
| `claude mcp add --scope user <name> -- <command> [args]`, `claude mcp get` | `claude mcp add --help`, `claude mcp --help` |
| Script parameters | `create-profiles.ps1` (`param` block) and `create-profiles.sh` (option parser) |

Not confirmed, check with `--help` on your version: whether
`delegation.oneshot_max_children` is accepted by `config set` on releases other
than the one above (the key name comes from a working config), and the exact
prompts `hermes model`, `hermes mcp add` and `hermes gateway setup` show.

## Do not copy someone else's Hermes folder

A Hermes home (`%LOCALAPPDATA%\hermes` or `~/.hermes`) holds keys (`.env`,
`auth.json`), sessions, memories and a state database. Build your own with
this kit instead of copying one, and never commit any of those files.
