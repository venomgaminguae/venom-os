---
name: roster-management
description: Use when creating an agent. Profile, roster, dock, docs.
version: 1.2.0
---

# Agent Lifecycle and Roster Management

## Overview

Procedures for creating a new Hermes agent, giving it a profile and standing rules, and adding it to the Venom OS roster, team dock and team-wide context.

### 1. Profile and identity
- **Creation:** `hermes profile create <id> --clone-from <base> --no-alias` creates the profile folder, config and skills. Cloning copies the base profile's `.env` too.
- **The soul:** write the profile's `SOUL.md`: the agent's permanent job description, rules and safety limits. Be precise.
- **The team note (optional):** if you keep an Obsidian vault, create a hub note for the agent (for example `<your vault>/Team/<Agent Name>.md`) with Status, Next and Log, and link it from the agent's `SOUL.md`.

### 2. Roster and dock
- **Roster entry:** add the agent with `npm run add-agent` (or edit `venom.agents.json`): a unique `id`, `name`, `kind` (e.g. `specialist`), a one-sentence `role`, and `"pinned": true` if it should stay on the dock.
- **Check:** `npm run agents` lists the team and asks each agent a one-line test question.
- **Tests:** never assert a fixed number of agents; the roster is data and changes per user.

### 3. Team context
- **The supervisor's view:** the supervisor describes agents from their `role` text, so make that sentence say when to pick this agent.
- **Docs:** if the project README lists the team, add the agent there.
- **Layout:** after adding an agent, check the dock for overlap or clipping at your usual screen sizes.

### Pitfalls

- **Personality gap:** an agent in the roster without a precise `SOUL.md` or `role` exists but lacks the context its job needs.
- **Stale connector:** a running chat sees roster changes only after Hermes restarts its MCP servers.
- **Broken link:** a team note that is not linked from the agent's `SOUL.md` or the project hub leaves its work siloed.

## Verification Checklist

- [ ] **Profile:** `hermes -p <id> chat` works and follows the `SOUL.md`.
- [ ] **Roster:** `npm run agents` shows the agent and it answers.
- [ ] **Dock:** the agent has a tile on the team dock; no overlap or clipping.
- [ ] **Supervisor:** the supervisor names the agent correctly when asked who does what.
