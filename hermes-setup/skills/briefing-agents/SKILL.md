---
name: briefing-agents
description: Use when sending a task to an agent. Brief it first.
version: 1.1.0
author: Venom OS contributors
license: MIT
metadata:
  hermes:
    tags: [delegation, agents, briefs, prompts, team]
    related_skills: [agent-team-expansion, dispatching-parallel-agents]
---

# Briefing agents

## When to Use

- The user asks to send, ask, tell or hand something to an agent or project lead.
- The supervisor decides by itself to delegate a piece of work.
- A report came back short and the task is going back to the agent.

When the user says "send this to <agent>" (or "ask", "tell", "let <agent> do"), their words are the raw material, not the message. The agent starts with no context: it has not seen this chat, does not know why the user wants it, and will fill every gap with a guess. What reaches the agent is a brief the supervisor wrote after thinking the request through.

This holds for short requests too. A one-line ask still gets the goal, the limits and the output format written out.

## The brief

- **Worker and checker.** Real work is done by the agent (or its workers) and checked by the supervisor before it is presented to the user. A report stating "done" without a verification step is an incomplete report.
- **Seven parts, in this order:**

1. **Why**: who wants it and what they will use it for, in two or three sentences. This is what lets the agent make good judgement calls.
2. **Goal and done**: the result in one sentence, then what "finished" looks like.
3. **Scope**: the exact items, spelled out. Where the user's wording was loose (a nickname, a typo, "all", "best"), write the reading the supervisor chose and mark it as the supervisor's reading so the agent can push back.
4. **Method**: only what the agent would not work out alone: where to start, what is cheap and what is expensive, what earlier runs learned. Leave the rest to the agent and its own skills.
5. **Limits**: paid-tool budget as a number, a time cap, and what must not be touched (no purchases, logins, messages to outsiders, live-site changes).
6. **Output**: the file path and the format, down to table columns when rows will be compared or reused.
7. **Report back**: length and the fields the supervisor needs to check the work: what was done, what was verified, what could not be done, what it cost.

State once that a gap must be reported as a gap, never filled with an estimate.

Ask for status in five fixed words, and use them in what the user is told: **prepared** (written, not run), **tested** (ran in a test), **installed** (in place where it will be used), **running** (the live thing is using it), **verified** (the live result was observed). Each is a separate milestone; a report names the furthest one actually seen, because "done" hides the gap between tested and running.

For a job longer than one run, the brief asks for a handover record in the project's hub note or a work note: objective, what is actually completed, the remaining blocker, the next action and who owns it. The next run starts from that record, not from an old conversation.

## Before writing

- Find the goal behind the request and what the user will do with the result.
- Take stock of what already exists (finished results, parked branches, downloaded models, valid test evidence) and name it in the brief so the agent reuses it instead of rebuilding.
- Send a large change as phases, one capability at a time, each tested before the next starts; changes to something the user is running live are built in a git worktree, never in the folder the running app watches.
- Tell the agent to stop and report after two attempts at the same failure that make no progress, not to try a third variation.
- Settle what the request leaves open. Decide low-stakes points and record them in Scope. Ask the user first only when a wrong guess would waste the whole run or touch something irreversible.
- Read the agent's standing rules (`$HERMES_HOME/profiles/<agent>/SOUL.md`) and its skill for this kind of job, so the brief extends them and does not repeat or contradict them.
- Split independent parts into separate runs, to different agents or the same one, and send them together.
- Check what the job spends (for example scraping-service credits) and set the budget from the real balance.

## Sending

- Save the brief as a file in the scratch folder. The task text is then one line: read the brief at that path, carry it out, finish with the report it asks for. (A file also avoids multi-line arguments, which Windows cuts at the first newline.)
- Send through the team connector so the run is recorded and shows on the Venom OS team dock: `ask_agent` for jobs under 20 minutes; for longer ones run `node "$HERMES_HOME/skills/briefing-agents/scripts/dock-run.mjs" <agent> "<task>" <minutes>` in the background with notify (set `VENOM_APP_DIR` to the Venom OS folder, or run it from there).
- Tell the user in a few lines what was sent, to whom, and which readings the supervisor chose.

## When the report comes back

- Check a sample of the result against the real source before the user sees it, and say which parts were checked and which are the agent's word.
- If it falls short, send it back with specific corrections and tell the agent to update its skill.
- Deliver the result where the user asked for it.

## Stopping a run

A run sent to an agent executes inside the Hermes gateway. Killing the background job, `dock-run.mjs` or the `hermes` client only detaches from it: the agent and its workers keep editing files.

1. Find the session id: in `$HERMES_HOME/profiles/<profile>/logs/agent.log`, the `conversation turn: session=local-...` line whose `msg=` starts with the task text.
2. Interrupt it with `scripts/interrupt_session.py` (usage in its header).
3. Confirm `Turn ended: reason=interrupted_by_user` in that log, and that no line for that session follows.
4. Then look for what it left: `git status` in the project, processes and listening ports it started, shortcuts or files outside the project.

Never tell the user a run is stopped, or that it changed nothing, from the kill result or one `git status` alone. Say it only after step 3, and after a second look a minute later.

## Pitfalls

- When a change will be on by default, the brief's "done" must include one run in the real surface (the page in the browser, the live command), not only unit tests. Otherwise the report comes back honestly marked "prepared" and a second run is needed before go-live.
- Unattended runs (for example overnight): tell the agent that no sound may come out of the speakers, and never to relaunch a voice app unattended if it plays audio at start.
- The `claude` agent (Claude Code, headless) runs only a fixed list of commands (the allow list in `hermes-mcp/runner.mjs`). Tell it to `cd <project>` as its own command first, then run `git status`, `npm test`, `npx tsc` separately: chained commands such as `cd x && git status` may be refused. Anything not on the allow list is refused silently from its side, so do not brief it for work that needs it.
- A change to the team roster reaches this chat's `ask_agent` only after Hermes restarts its MCP servers. Until then send through `scripts/dock-run.mjs`, which starts a fresh connector.
- Before a brief names a file the agent must leave alone or must create (a shortcut, a config), check what exists on disk now. A brief that says "create X, leave Y alone" overwrites the user's X when another session renamed Y to X.
- When re-checking an agent's prices with `web_extract`: match each result to its request by the returned URL (a failed page shifts a batch out of order), and treat a mismatch as unproven until a live read confirms it, because extractors can serve cached pages and some shops hide prices from them.
- Tell agents and their workers never to click through a bot-check or CAPTCHA page; a blocked page is reported as blocked.
- Two browser jobs sent to the same agent at once can share one browser tab and corrupt each other's reads; give each its own browser session or run them one after the other.
- In git-bash on Windows, call `node.exe` rather than `node` and add `< /dev/null` for background jobs: a `node` wrapper can print "stdin is not a tty" and exit 1. With `dock-run.mjs` that exit is misleading: the connector it spawned can keep running, so the run continues but its result never comes back to you. After any such exit, check the activity log (`activity.jsonl` under `VENOM_AGENTS_DIR`, default `~/.venom/agents`) for a start event and fresh heartbeats before re-sending (a re-send would put two runs in one repo), then wait for the end event and read the full result from `runs/<run id>.md` in the same folder.
- The team connector stops a run at 20 minutes unless `HERMES_TIMEOUT_MS` is raised; `dock-run.mjs` raises it.
- Background runs are children of the Hermes gateway. A gateway restart kills them.
- An agent that started before a standing rule was added to its brief has not read that rule.
- Community prompt-writing skills exist in the Skills Hub. Show the user any you would install before installing it.
