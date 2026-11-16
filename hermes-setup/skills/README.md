# Bundled Hermes skills

This folder holds skills for the Hermes agent team behind Venom OS. A skill is a
folder with a `SKILL.md` (and sometimes `references/`, `templates/` or
`scripts/`) that teaches an agent a procedure. `manifest.json` lists every
folder here, where it comes from, its licence and how many `SKILL.md` files it
contains.

## How they are installed

`npm run setup` offers to copy these folders into the `skills` folder of each
Hermes profile it sets up. It never overwrites a skill that is already there:
a folder with the same name is left as it is.

To copy one by hand, copy its folder into the profile's skills folder, for
example (git-bash):

```bash
cp -r hermes-setup/skills/briefing-agents "$HERMES_HOME/skills/"
```

where `HERMES_HOME` is the profile's folder (on Windows by default
`%LOCALAPPDATA%\hermes\profiles\<profile>`; `hermes -p <profile> config path`
prints the config file inside it). Start a new session afterwards: a running
agent does not see new skills mid-task. `hermes -p <profile> skills list`
confirms the skill is found.

Hermes already ships its own bundled skills (and a Skills Hub for more); they
are not repeated here.

## What is here

| Name | Source | Licence | Status | What it is for |
|---|---|---|---|---|
| `briefing-agents` | in-house | MIT | shipped | Turning a request into a seven-part brief for an agent, sending it through the team connector, checking the report, stopping a run |
| `agent-team-expansion` (with nested `roster-management`) | in-house | MIT | shipped | Adding specialist agents, bridging non-Hermes CLIs, the lifecycle of one agent from profile to dock |
| `agent-skill-scout` | in-house | MIT | shipped | Finding and installing Skills Hub skills that fill gaps in each agent's job |
| `obsidian-vault-management` | in-house | MIT | shipped | An Obsidian vault with one hub note per project, plus templates |
| `deep-uninstallation-and-cleanup` | in-house | MIT | shipped | Removing a program or config completely, in reversible stages |
| `market-intelligence` | in-house | MIT | shipped | Verifying prices and listings from live pages |
| `desktop-app-engineering` | in-house | MIT | shipped | Building, packaging and safely testing Electron apps |
| `project-templating` | in-house | MIT | shipped | Making a clean, shareable copy of a project |
| `agent-skills` (25 skills) | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT | shipped, unmodified (see `agent-skills/SOURCE.md`) | Engineering workflow: specs, planning, TDD, code review, debugging, security, shipping |
| `graphify` | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) (formerly safishamsi/graphify) (PyPI `graphifyy`) | Apache-2.0 | install from source | Turns a codebase and its docs into a queryable knowledge graph |

### graphify

graphify is a Python program; its skill is useless without it, and its own
installer writes the skill. Following its README (needs Python 3.10+ and `uv`
or `pipx`):

```bash
uv tool install graphifyy                 # or: pipx install graphifyy
graphify install --platform hermes        # registers the skill for Hermes
```

Then type `/graphify .` in a project. Check the upstream README for changes
before installing.
