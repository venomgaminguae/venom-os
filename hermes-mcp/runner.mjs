/**
 * Running one agent task: the child process, its arguments and environment,
 * and turning its output into an answer. Split out of server.mjs so it can be
 * tested without starting the MCP server (importing this has no side effects).
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { startRun } from './activity.mjs'
import { AGENTS } from './agents.mjs'
import { profileIds, projectDirs } from './roster.mjs'

export const HERMES =
  process.env.HERMES_EXE ??
  join(process.env.LOCALAPPDATA ?? '', 'hermes', 'bin', 'hermes.exe')
const WORKDIR = process.env.HERMES_WORKDIR ?? process.cwd()
const TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS ?? 20 * 60 * 1000)

/**
 * Google Antigravity CLI (`agy`), signed in with the user's Google account so
 * it runs on their Google AI Pro plan rather than an API key. Headless mode:
 * https://antigravity.google/docs/cli/headless/
 * AGY_MODEL optionally pins a model slug (see `agy models`).
 */
export const AGY =
  process.env.AGY_EXE ?? join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe')
// No model is named unless AGY_MODEL is set: Antigravity then uses its own
// default. Antigravity also offers Claude and GPT-OSS; set a Gemini slug to pin it.
const AGY_MODEL = process.env.AGY_MODEL ?? ''

/**
 * Claude Code itself (`claude`), on the owner's Claude Code login, with his
 * plugins, subagents and hooks. Headless mode:
 * https://code.claude.com/docs/en/headless
 * The native installer puts a real claude.exe in ~/.local/bin (no .cmd shim).
 * TEAM_CLAUDE_EXE points somewhere else; TEAM_CLAUDE_MODEL pins a model (by
 * default Claude Code uses the model in the owner's own settings).
 */
export const CLAUDE =
  process.env.TEAM_CLAUDE_EXE ?? join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe')
const CLAUDE_MODEL = process.env.TEAM_CLAUDE_MODEL ?? ''

/**
 * Project leads (roster kind `project`) work inside their project folder, so
 * relative paths, git and the project's own instruction file (CLAUDE.md,
 * README.md) resolve there. Claude Code runs in PROJECTS_ROOT itself, so
 * every project is in reach. Everyone else runs in WORKDIR. PROJECTS_ROOT
 * overrides the default (~/Projects).
 *
 * PROJECT_DIRS maps a project lead's id to its folder: each roster entry of
 * kind `project` and its `folder` (venom.agents.json, see roster.mjs; a
 * relative folder is inside PROJECTS_ROOT).
 */
export const PROJECTS_ROOT = process.env.PROJECTS_ROOT || join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Projects')
export const PROJECT_DIRS = projectDirs(AGENTS, PROJECTS_ROOT)

/**
 * Agents whose Hermes profile has a different id from their team name, e.g.
 * `{ myapp: 'my-app' }`, from the roster's `profile` fields. Empty when every
 * profile is named after its agent.
 */
export const PROFILE_IDS = profileIds(AGENTS)

/**
 * What the Claude Code agent may do. It is reached by voice and from Telegram
 * with nobody at the keyboard, so nothing here is left to a prompt:
 *
 *   --permission-mode acceptEdits   file edits inside the working folder (and
 *                                   mkdir, touch, mv, cp, sed, rm, rmdir there)
 *                                   run; never bypassPermissions.
 *   --permission-prompts none       anything that would ask is refused.
 *   --allowedTools  CLAUDE_ALLOW    the few things beyond that which may run.
 *   --disallowedTools CLAUDE_DENY   refused whatever else says yes. Deny rules
 *                                   are checked first and win in every mode.
 *
 * Listing and reading (ls, cat, grep, read-only git) need no rule: Claude
 * Code runs its built-in read-only commands in every mode.
 *
 * Rule syntax: https://code.claude.com/docs/en/permissions . Tool names were
 * read from a headless session's own tool list on this PC (claude 2.1.321):
 * a server's tools are `mcp__<server name, each character outside
 * A-Z a-z 0-9 _ - replaced by _>__<tool>`, so "claude.ai Example" is
 * `mcp__claude_ai_Example__`.
 *
 * Never loosen this without the owner's say-so (test/connector.test.mjs
 * holds it in place).
 */
export const CLAUDE_ALLOW = [
  'WebSearch',
  'WebFetch',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(npm test *)',
  'Bash(npm run *)',
  'Bash(npx tsc *)',
  'Bash(node --check *)',
  'Bash(node --test *)',
  'mcp__context7__*',
  'mcp__plugin_context7_context7__*',
  'mcp__sequential-thinking__*',
]

export const CLAUDE_DENY = [
  // Publishing and throwing work away. The second form of each catches
  // options before the subcommand (`git -C folder push`).
  'Bash(git push *)',
  'Bash(git * push *)',
  'Bash(git reset --hard *)',
  'Bash(git * reset --hard *)',
  'PowerShell(git push *)',
  'PowerShell(git * push *)',
  'PowerShell(git reset --hard *)',
  'PowerShell(git * reset --hard *)',
  // Deleting. acceptEdits would approve `rm` inside the working folder, so
  // `rm` with any option at all is refused: that leaves plain `rm file`,
  // which cannot remove a folder. Remove-Item covers PowerShell's rm, del,
  // rmdir, rd, ri and erase aliases.
  'Bash(rm -*)',
  'Bash(rm * -*)',
  'Bash(rmdir *)',
  'Bash(del *)',
  'PowerShell(Remove-Item *)',
  // Every claude.ai account connector (they act on the owner's real
  // accounts), by the prefix they all share, so whichever ones the account
  // has, and any added later, are refused.
  'mcp__claude_ai_*',
  // Write-capable local and plugin servers.
  'mcp__plugin_github_github__*',
  'mcp__linear__*',
  'mcp__plugin_playwright_playwright__*',
]

/**
 * Environment for the Hermes child. Claude Code variables inherited from the
 * VENOM bridge are dropped so Hermes resolves its own Claude login instead of
 * picking up a session-scoped token or endpoint meant for the bridge.
 * PYTHONUNBUFFERED makes Hermes write its tool activity as it happens rather
 * than all at exit, which is what the activity log's live steps read.
 * The Claude Code agent gets the same environment, for the same reason: it
 * must run on the owner's own Claude Code login.
 */
export function childEnv(base = process.env) {
  const env = { ...base, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', PYTHONUNBUFFERED: '1' }
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC|CLAUDE)/i.test(k) || k === 'CLAUDECODE') delete env[k]
  }
  return env
}

/**
 * Environment for Antigravity: API-key variables are dropped so it always uses
 * the Google sign-in (the Pro plan), even if a Gemini key sits in the
 * environment for Hermes's voice.
 */
export function geminiEnv(base = process.env) {
  const env = childEnv(base)
  for (const k of Object.keys(env)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT)$/i.test(k)) delete env[k]
  }
  return env
}

/** A Claude Code session's display name: "VENOM: " and the task's first words, on one line. */
export function claudeSessionName(task) {
  const words = String(task ?? '').replace(/\p{Cc}+/gu, ' ').trim().split(/\s+/).slice(0, 8).join(' ')
  return `VENOM: ${words.slice(0, 60).trim()}`.trim()
}

/**
 * Claude Code's arguments. The task is not among them: it goes in on stdin
 * (see agentCommand), so no task text can be read as an option.
 */
export function claudeArgs(task) {
  return [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--name', claudeSessionName(task),
    ...(CLAUDE_MODEL ? ['--model', CLAUDE_MODEL] : []),
    '--allowedTools', ...CLAUDE_ALLOW,
    '--disallowedTools', ...CLAUDE_DENY,
  ]
}

/**
 * Why this Claude Code executable cannot be run, or '' when it can. A .cmd or
 * .bat shim only runs through cmd.exe, which would interpret the arguments;
 * the connector starts programs directly and never through a shell.
 */
export function claudeExeProblem(exe = CLAUDE) {
  return /\.(cmd|bat)$/i.test(exe)
    ? `Claude Code at ${exe} is a .cmd/.bat shim, which needs a shell. Point TEAM_CLAUDE_EXE at the real claude.exe.`
    : ''
}

/**
 * The executable, arguments and working folder for one task. `kind` is which
 * program runs it: `hermes`, `gemini` or `claude`. `stdin`, when set, is text
 * to write to the child's stdin before closing it. The third argument stands
 * in for PROJECT_DIRS and PROFILE_IDS (tests use it to check a project lead
 * without one in the roster).
 */
export function agentCommand(agent, task, { projectDirs = PROJECT_DIRS, profileIds = PROFILE_IDS } = {}) {
  if (agent === 'claude') {
    // `claude -p` with no prompt argument reads the prompt from stdin. That
    // keeps the task out of the command line: a task starting with `--` cannot
    // become a flag, and Windows's 32,767-character limit does not apply.
    return { exe: CLAUDE, args: claudeArgs(task), cwd: PROJECTS_ROOT, isGemini: false, kind: 'claude', stdin: task }
  }
  const isGemini = agent === 'gemini'
  // Antigravity runs in plan (read-only) mode: it may search and read, never edit or run commands.
  const args = isGemini
    ? ['-p', task, '--output-format', 'json', '--mode', 'plan', '--print-timeout', '15m',
       ...(AGY_MODEL ? ['--model', AGY_MODEL] : [])]
    : ['-p', Object.hasOwn(profileIds, agent) ? profileIds[agent] : agent, 'chat', '-q', task, '-Q', '--source', 'tool']
  const cwd = Object.hasOwn(projectDirs, agent) ? projectDirs[agent] : WORKDIR
  return { exe: isGemini ? AGY : HERMES, args, cwd, isGemini, kind: isGemini ? 'gemini' : 'hermes' }
}

/** Pull the answer out of Antigravity's `--output-format json` envelope; fall back to the raw text. */
export function geminiAnswer(out) {
  try {
    const start = out.indexOf('{')
    const data = JSON.parse(out.slice(start))
    if (data.status && data.status !== 'SUCCESS') {
      return { ok: false, text: `Antigravity ended with status ${data.status}: ${data.error ?? data.response ?? ''}`.trim() }
    }
    return { ok: Boolean(data.response), text: String(data.response ?? '').trim() }
  } catch {
    return { ok: Boolean(out.trim()), text: out.trim() }
  }
}

const parseJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Pull the answer out of Claude Code's `--output-format json` result (one
 * object with `result`, `is_error`, `subtype` and `session_id`; an array of
 * messages ending in it when verbose). The answer's last line names the
 * session, so the owner can open it in the Claude app. Output with no result
 * object is a failure: there is no session to point to.
 */
export function claudeAnswer(out) {
  const text = String(out ?? '').trim()
  let data = parseJson(text)
  if (data === undefined) {
    // Something was printed before the result: take the last line that parses.
    for (const line of text.split(/\r?\n/).reverse()) {
      if (!/^\s*[{[]/.test(line)) continue
      data = parseJson(line)
      if (data !== undefined) break
    }
  }
  if (Array.isArray(data)) data = data.filter((m) => m && m.type === 'result').pop()
  if (!data || typeof data !== 'object') return { ok: false, text }
  const id = typeof data.session_id === 'string' && SESSION_ID.test(data.session_id) ? data.session_id : ''
  const tail = id ? `Claude Code session: ${id} (open in the Claude app: claude --desktop --resume ${id})` : ''
  const body = typeof data.result === 'string' ? data.result.trim() : ''
  const failed = Boolean(data.is_error) || (typeof data.subtype === 'string' && data.subtype !== 'success')
  if (failed || !body) {
    const why = failed ? `Claude Code ended with ${data.subtype && data.subtype !== 'success' ? data.subtype : 'an error'}.` : 'Claude Code returned no answer.'
    return { ok: false, text: [why, body, tail].filter(Boolean).join('\n') }
  }
  return { ok: true, text: [body, tail].filter(Boolean).join('\n\n') }
}

/** Hermes's answer: its stdout minus the session bookkeeping lines. */
export function hermesAnswer(out) {
  return out
    .split(/\r?\n/)
    .filter((l) => !/^\s*(session_id:|Normalized |Resumed )/.test(l))
    .join('\n')
    .trim()
}

/**
 * Stop a child and everything it started. Hermes, Antigravity and Claude Code
 * each spawn their own children (tools, shells, workers); child.kill() on
 * Windows ends only the top process and leaves those running, so the whole
 * tree goes.
 */
export function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      k.on('error', () => child.kill())
    } catch {
      child.kill()
    }
  } else {
    child.kill('SIGKILL')
  }
}

const PROGRAMS = {
  hermes: () => `Hermes at ${HERMES}`,
  gemini: () => `Antigravity at ${AGY}`,
  claude: () => `Claude Code at ${CLAUDE}`,
}

/** Run one task and resolve with its cleaned-up answer. */
export function runAgent(agent, task) {
  return new Promise((resolve) => {
    const { exe, args, cwd, isGemini, kind, stdin } = agentCommand(agent, task)
    // Recording never throws and never blocks: see activity.mjs. Only Hermes
    // prints as it works; the other two print one JSON result at the end, so
    // they get heartbeats.
    const run = startRun({ agent, task, live: kind === 'hermes' })
    // A timeout or a failed spawn is followed by 'close'; only the first counts.
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      run.end(result)
      resolve(result)
    }
    const problem = kind === 'claude' ? claudeExeProblem(exe) : ''
    if (problem) {
      finish({ ok: false, text: problem })
      return
    }
    const child = spawn(exe, args, { cwd, env: isGemini ? geminiEnv() : childEnv(), windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
      run.feed(d)
    })
    child.stderr.on('data', (d) => (err += d))
    if (stdin !== undefined) {
      // A child that failed to start, or exited early, closes the pipe under the write.
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({ ok: false, text: `The ${agent} agent did not finish within ${Math.round(TIMEOUT_MS / 60000)} minutes and was stopped.` })
    }, TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, text: `Could not start ${PROGRAMS[kind]()}: ${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (isGemini) {
        const g = geminiAnswer(out)
        if (code === 0 && g.ok) finish(g)
        else finish({ ok: false, text: `The gemini agent exited with code ${code}.\n${g.text}\n${err.slice(-1500)}`.trim() })
        return
      }
      if (kind === 'claude') {
        const c = claudeAnswer(out)
        if (code === 0 && c.ok) finish(c)
        // The answer goes last, so its session line stays the last line.
        else finish({ ok: false, text: `The claude agent exited with code ${code}.\n${err.slice(-1500)}\n${c.text}`.trim() })
        return
      }
      const answer = hermesAnswer(out)
      if (code === 0 && answer) finish({ ok: true, text: answer })
      else finish({ ok: false, text: `The ${agent} agent exited with code ${code}.\n${answer}\n${err.slice(-2000)}`.trim() })
    })
  })
}
