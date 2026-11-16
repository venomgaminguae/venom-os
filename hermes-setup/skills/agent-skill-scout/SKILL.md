---
name: agent-skill-scout
description: "Use when equipping agents. Finds and installs best skills."
version: 0.1.0
author: Venom OS contributors
license: MIT
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [skills, agents, team, skills-hub, profiles]
    related_skills: [agent-team-expansion, hermes-agent]
---

# Agent Skill Scout

Finds the skills that best fit each specialist agent's job and installs them into that agent's own Hermes profile. It only installs from the Skills Hub; it does not write new skills (use `skill_manage` for that) and does not add agents (use `agent-team-expansion`).

## When to Use

- The user asks to equip, upgrade or "find the best skills for" one agent or the whole team.
- A new agent was just added and has only the bundled skills.
- An agent's report fell short because it lacked a procedure a hub skill provides.
- Don't use for: the supervisor's own profile (install directly), or agents that are not Hermes profiles (e.g. `gemini`, which runs through `agy` and has no Hermes skills).

## Quick Reference

All commands run through `terminal`. `-p <agent>` targets that agent's profile.

```
hermes skills search "<query>" --source <source> --limit 40 --json
hermes skills inspect <identifier>
hermes -p <agent> skills list --enabled-only
hermes -p <agent> skills install <identifier> --yes
hermes -p <agent> skills uninstall <name>
```

Sources by trust, highest first: `official` (ships with Hermes), then trusted publishers (`anthropic`, `openai`, `nvidia`, `huggingface`), then community (`skills-sh`, `clawhub`, `github`, `lobehub`).

## Procedure

1. **Read the roster.** Get each agent's job from the team roster (in Venom OS: `venom.agents.json`, or `npm run agents -- --quick`) and from the profile's `SOUL.md`. Done when every Hermes-profile agent has a one-line job statement.
2. **List what each agent has.** Run `hermes -p <agent> skills list --enabled-only`. Done when you can say, per agent, which parts of its job have no skill.
3. **Search by gap, not by agent name.** Query for the missing capability ("rss feeds", "api debugging"), `official` first, then trusted publishers, with `--json`. Search community sources only for a gap the first two tiers left open. Done when each gap has candidates or is recorded as "nothing found".
4. **Inspect every candidate** with `hermes skills inspect`. Reject it when it duplicates an installed skill, needs an API key or paid service the user lacks, is not for this OS, or relies on a tool the user has ruled out. Done when each surviving candidate has a one-line reason tied to the agent's job.
5. **Cap at three new skills per agent per run.** Every installed skill adds a line to that agent's prompt on every turn, so a long list costs tokens and blurs skill choice.
6. **Install.** `official` and trusted-publisher skills: install with `--yes`. Community skills: show the user the identifier, source and install count and install only after they agree, because a skill is instructions the agent will follow with file and shell access. Never pass `--force`; a blocked scan verdict means skip it and report it.
7. **Verify, then report.** Confirm each install (see Verification) and give the user one table: agent, skill, source, why it fits, plus the gaps where nothing suitable was found.

## Pitfalls

- **Install counts are not quality.** Community search results carry only an install count as description; read the skill with `inspect` before judging it.
- **Same skill, several publishers.** `pdf`, `docx`, `skill-creator` and others exist in bundled, Anthropic and OpenAI versions. Installing a second copy shadows or duplicates the first; keep the one already installed.
- **Skills that need setup are not finished at install.** If `inspect` shows a CLI install or env var, do that setup in the same run or tell the user it is pending. An installed skill whose tool is missing fails at the moment the agent needs it.
- **Empty result is a valid result.** When no trusted skill fits a gap, say so. Do not pad an agent with loosely related skills to make the table look full.
- **GitHub rate limit.** Unauthenticated hub calls are limited to 60 per hour; an install costs about two. On a rate-limit error, stop and resume later or set `GITHUB_TOKEN` in the Hermes `.env`.
- **Running agents do not see new skills mid-task.** A skill appears in the agent's next session.

## Verification

- `hermes -p <agent> skills list --source hub` lists each newly installed skill.
- The profile's `skills/.hub/lock.json` has an entry with the source identifier for each one.
- For one installed skill per agent, give the agent a small real task that should trigger it through `ask_agent` and check that the report shows the skill's procedure was followed.
