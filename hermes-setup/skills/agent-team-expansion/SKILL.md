---
name: agent-team-expansion
description: Use when adding agents. Bridge CLIs and verify them.
version: 1.1.0
author: Venom OS contributors
license: MIT
---

# Agent Team Expansion

How to grow the supervisor's team with new specialist agents, including bridging non-standard command-line programs (such as `agy` for Gemini, `ollama`, `codex` or a custom script) into the Hermes team connector. The step-by-step lifecycle for one agent (profile, roster entry, dock, docs) is in the nested `roster-management` skill.

## When to Use

- Adding a new specialist agent to the team.
- Bridging a non-standard CLI into the team connector (`hermes-mcp/`).
- Configuring environment variables or authentication for a new agent.
- Troubleshooting why a new agent fails to authenticate or respond.

## Always-on Rules

- **One roster.** Every agent is listed in the team roster (in Venom OS: `venom.agents.json`, managed with `npm run add-agent`, `npm run agents`, `npm run remove-agent`) so it is reachable through `ask_agent`. Do not run agents from standalone scripts the supervisor cannot see.
- **Environment isolation.** For a provider that differs from the supervisor's, build the child environment in a dedicated function that strips the supervisor's keys (`ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` as applicable). Otherwise the child CLI may pick up the wrong credentials.
- **Read-only by default.** Agents meant for research, second opinions or observation start in plan mode or a read-only equivalent.
- **Verify before announcing.** Every new agent answers a low-stakes task through the connector (`node hermes-mcp/selftest.mjs <agent> "<task>"`) before it is reported as online. Tests must never assert a fixed number of agents.
- **Context in the soul.** Every new agent gets a `SOUL.md` with the user's context that matters for its job (who it works for, markets, customer types) and its operating limits ("drafts only", "never contact customers"). A generic agent gives generic answers.
- **Worker and checker.** The agent does the work; the supervisor (or a second agent) checks it before the user sees it. Pick the models for each role in the setup wizard or `hermes model`; do not hardcode model ids.
- **Pin the core.** The few agents the user relies on daily get `"pinned": true` in the roster so they stay visible on the team dock.

## Procedures

### 1. Role definition
- **Id**: a short, lowercase slug (e.g. `researcher`, `coder`).
- **Role**: one sentence that tells the supervisor when to pick this agent.
- **Model**: chosen per profile (`hermes -p <id> model`), not in code.

### 2. Bridge implementation (non-Hermes CLIs only)
- Map the agent id to its executable and arguments in the connector's runner (`hermes-mcp/runner.mjs`).
- For tools with JSON output, parse the envelope and return only the answer text.

### 3. Environment mapping
- Write a function that returns a clean environment object for that agent.
- Delete conflicting variables explicitly (for example `delete env.ANTHROPIC_API_KEY`).

### 4. Testing and verification
```bash
node hermes-mcp/selftest.mjs <agent_id> "<low-stakes task>"
```
Report success only once the response comes back with `isError=false`.

## Pitfalls

- **Legacy CLI trap**: older CLIs may not support subscription sign-in; use the provider's current agent CLI so the sign-in route the user pays for works.
- **Entitlement gaps**: a subscription does not automatically grant every model in an agent CLI; check which models the account can actually use.
- **Polluted environment**: forgetting to strip the supervisor's keys when spawning a sub-agent makes it authenticate with the wrong credentials (401/403 errors).

## References

- `references/bridge-implementation.md`: templates for a runner entry and a self-test script.
- `references/authentication-patterns.md`: decision table for OAuth, API keys, Vertex AI and local models.
- `roster-management/SKILL.md`: full lifecycle of one agent.
