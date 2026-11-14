// Hermes-side helpers for the setup wizard (scripts/setup-lib.mjs): offer to
// install Hermes Agent when it is missing, run `hermes doctor` and summarise
// it, tell whether Claude Code is installed and signed in, and the end-of-setup
// link test (the supervisor hands a one-line task to an agent through the team
// connector, and the activity log proves the agent really ran it).
//
// Every side effect is injected (run, ask, log, readFile, exists, which), as in
// setup-lib.mjs, so test/setup-hermes.test.mjs drives it with stubs and
// scripts/fake-hermes.mjs. This module prints nothing itself, and every piece
// of Hermes output it returns goes through redact() first. It never asks for,
// reads or returns a key, and claudeStatus() returns only two booleans.
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'
import { LINKS, findHermes as defaultFindHermes, hermesAnswer, redact } from './setup-lib.mjs'

export const Q_INSTALL = 'Install Hermes now? (y/N)'
export const LINK_TOKEN_PREFIX = 'LINK-OK-'

const yes = (a) => /^y(es)?$/i.test(String(a ?? '').trim())
const slash = (p) => String(p).replace(/\\/g, '/')
// CSI sequences (colours, cursor) and OSC sequences (titles, links).
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  'g',
)
const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '')
const lastLines = (text, n = 12) =>
  stripAnsi(text)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n')
const both = (r) => `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`

// ------------------------------------------------------------------ install

/** Split a command line into words, honouring double quotes. */
function splitCommand(line) {
  const words = []
  for (const m of String(line).matchAll(/"([^"]*)"|(\S+)/g)) words.push(m[1] ?? m[2])
  return words
}

/**
 * The official Hermes install command for this platform: `shown` is what the
 * person reads (and can paste), `cmd`/`args` how setup runs it.
 * VENOM_SETUP_INSTALL_CMD replaces it (tests and stand-ins).
 * @param {{ platform: string, env?: Record<string, string | undefined> }} o
 * @returns {{ shown: string, cmd: string, args: string[] }}
 */
export function installCommand({ platform, env = {} }) {
  const override = String(env.VENOM_SETUP_INSTALL_CMD ?? '').trim()
  if (override) {
    const [cmd = '', ...args] = splitCommand(override)
    return { shown: override, cmd, args }
  }
  if (platform === 'win32') {
    return {
      shown: LINKS.hermesWin,
      cmd: `${env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', LINKS.hermesWin],
    }
  }
  return { shown: LINKS.hermesSh, cmd: 'bash', args: ['-c', LINKS.hermesSh] }
}

/**
 * Hermes is missing: explain the official installer, ask, and run it with the
 * person watching. Afterwards look for the command again; a fresh install is
 * often not on this window's PATH yet.
 * @param {{ platform: string, env?: object, ask: Function, run: Function, log: Function,
 *   exists: Function, which: Function, findHermes?: Function, cwd?: string }} o
 * @returns {Promise<{ status: 'installed' | 'declined' | 'failed' | 'new-terminal', hermes: string }>}
 */
export async function offerInstall({ platform, env = {}, ask, run, log, exists, which, findHermes = defaultFindHermes, cwd }) {
  const say = (...lines) => lines.forEach((l) => log(l))
  const { shown, cmd, args } = installCommand({ platform, env })
  const where = platform === 'win32' ? 'in PowerShell' : 'in a terminal'
  say(
    'Hermes Agent is not installed (the `hermes` command was not found).',
    `The official install command (${where}):`,
    `  ${shown}`,
    `It comes from the Hermes installation guide (${LINKS.hermesDocs})`,
    "and downloads Hermes into your own user account's folder.",
  )
  if (!yes(await ask(Q_INSTALL))) {
    say(
      '',
      `To install it by hand, run this ${where}:`,
      `  ${shown}`,
      'then run: npm run setup',
    )
    return { status: 'declined', hermes: '' }
  }

  let code
  try {
    code = (await run(cmd, args, { interactive: true }))?.code
  } catch (err) {
    say('', `The installer could not be started: ${redact(err?.message ?? err)}`, `Installation guide: ${LINKS.hermesDocs}`)
    return { status: 'failed', hermes: '' }
  }
  if (code !== 0) {
    say('', `The installer stopped with exit code ${code}; its own messages are above.`, `Installation guide: ${LINKS.hermesDocs}`)
    return { status: 'failed', hermes: '' }
  }

  let found = findHermes({ platform, env, exists, which })
  if (!found && platform !== 'win32' && env.HOME) {
    const p = `${slash(env.HOME)}/.local/bin/hermes`
    if (exists(p)) found = p
  }
  if (found) {
    if (which('hermes')) {
      say('', `[ok] Hermes installed: ${found}`)
    } else {
      say(
        '',
        `[ok] Hermes is installed at ${found}.`,
        'This window cannot see the `hermes` command by name until you open a new terminal;',
        'setup carries on now using the full path.',
      )
    }
    return { status: 'installed', hermes: found }
  }
  const folder = cwd || env.INIT_CWD
  say(
    '',
    'The installer finished, but this window cannot find Hermes yet. To carry on:',
    '  1. Close this terminal window.',
    '  2. Open a new one.',
    folder ? `  3. Go back to this folder: cd "${slash(folder)}"` : '  3. `cd` back to this project folder.',
    '  4. Run `npm run setup` again (it starts from the top and is safe to repeat).',
  )
  return { status: 'new-terminal', hermes: '' }
}

// ------------------------------------------------------------------ doctor

// Which `hermes doctor` findings stop setup. Read from the Hermes source
// (hermes_cli/doctor*.py, release 2026.9.24): every check prints rows (✓ ok,
// ⚠ warning, ✗ fail, → hint) and adds a FIX INSTRUCTION to the summary list;
// the summary is "Found N issue(s) to address:" + "  1. <fix>" lines, or
// "All checks passed!", and the exit code is 1 whenever that list is not
// empty. So exit 1 alone means nothing: a fresh install always has notes
// (no API keys yet, optional tools or keys missing, config to migrate).
//
// Rule: a summary line is BLOCKING only when it is one of the fixes the source
// gives for a broken install: Python too old, a required package / the
// launcher / the PM interpreter needing `hermes pm repair` (or a reinstall),
// TLS unusable, the config backend unable to serve config, a security
// advisory on an installed package, state.db structurally corrupt, a full
// disk. Everything else, unknown wording included, is a NOTE: the model,
// provider and key are set up by the next steps of this wizard. The one other
// blocking case is a run that did not finish: a non-zero exit with neither
// "Found N issue(s)" nor "All checks passed!" means doctor crashed (every
// completed run prints one of the two), i.e. the install itself is broken.
const BLOCKING_FIXES = [
  /^Upgrade Python to\b/i,
  /^Repair (?!the dashboard)\S/i, // "Repair <package>: ...", "Repair or reinstall the Hermes launcher ...", "Repair the PM store interpreter ..."
  /^Run `hermes pm repair`/i, // _python_repair_hint() on its own (manual issue)
  /\bif TLS still fails\b/i,
  /^Config backend\b.*\bcannot serve config\b/i,
  /^Resolve security advisory\b/i,
  /^state\.db structural corruption\b/i,
  /^Free disk space\b/i,
]

/** Whether one doctor summary line stops setup (see the rule above). */
export function isBlockingDoctorIssue(issue) {
  const t = String(issue ?? '').trim()
  return BLOCKING_FIXES.some((re) => re.test(t))
}

/**
 * Read `hermes doctor` output: whether it passed, the numbered issues after
 * "Found N issue(s)", split into `blocking` and `notes`, the Tip line, and
 * whether the closing summary was there at all (`finished`). Pure.
 * @param {string} output
 * @returns {{ passed: boolean, issues: string[], blocking: string[], notes: string[], tip: string, finished: boolean }}
 */
export function parseDoctor(output) {
  // The connectivity status line is overwritten with CR + spaces + CR:
  // keep only what follows the last carriage return of each line.
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((l) => l.slice(l.lastIndexOf('\x0d') + 1))
  const issues = []
  let tip = ''
  let inIssues = false
  let finished = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    const t = line.trim()
    if (/^All checks passed\b/i.test(t)) finished = true
    const tipMatch = /^Tip:\s*(.*)$/i.exec(t)
    if (tipMatch) {
      tip = t
      inIssues = false
      continue
    }
    if (/^Found\s+\d+\s+issues?(\(s\))?\b/i.test(t)) {
      inIssues = true
      finished = true
      continue
    }
    if (!inIssues) continue
    const item = /^(\d+)[.)]\s+(.*)$/.exec(t)
    if (item) issues.push(item[2].trim())
    else if (!t) {
      if (issues.length) inIssues = false
    } else if (issues.length && /^\s/.test(line) && !/^[─━═—-]{3,}$/.test(t)) {
      issues[issues.length - 1] += ` ${t}`
    } else if (issues.length) inIssues = false
  }
  const passed = !issues.length && lines.some((l) => /All checks passed/i.test(l))
  const blocking = issues.filter(isBlockingDoctorIssue)
  const notes = issues.filter((i) => !isBlockingDoctorIssue(i))
  return { passed, issues, blocking, notes, tip, finished }
}

/**
 * Run `hermes [-p profile] doctor` and summarise it. `issues` is every summary
 * line, split into `blocking` (setup must stop) and `notes` (shown, setup goes
 * on). `broken` is a run that did not finish (or could not start): then the
 * last lines of output are in `detail`, so nothing is hidden.
 * @param {{ hermes: string, run: Function, profile?: string }} o
 * @returns {Promise<{ ok: boolean, issues: string[], blocking: string[], notes: string[], broken: boolean, tip: string, detail: string }>}
 */
export async function healthCheck({ hermes, run, profile }) {
  const args = [...(profile ? ['-p', profile] : []), 'doctor']
  let r
  try {
    r = await run(hermes, args, {})
  } catch (err) {
    const detail = redact(`Could not run hermes doctor: ${err?.message ?? err}`)
    return { ok: false, issues: [], blocking: [], notes: [], broken: true, tip: '', detail }
  }
  const text = both(r)
  const parsed = parseDoctor(text)
  const issues = parsed.issues.map((i) => redact(i))
  const blocking = parsed.blocking.map((i) => redact(i))
  const notes = parsed.notes.map((i) => redact(i))
  const ok = r?.code === 0 && !issues.length
  const broken = r?.code !== 0 && !parsed.finished
  const detail = broken ? redact(lastLines(text)) || `(no output, exit code ${r?.code})` : ''
  return { ok, issues, blocking, notes, broken, tip: redact(parsed.tip), detail }
}

/** One plain sentence: what to do about a blocking health check. */
export function healthFix(health) {
  if (health?.blocking?.length) {
    return `Setup stops here because Hermes itself needs a repair. Do what Hermes says above (${health.blocking[0]}), then run npm run setup again.`
  }
  return `Setup stops here because hermes doctor did not finish, so the Hermes install looks broken. Install Hermes again with the official command (${LINKS.hermesDocs}), then run npm run setup again.`
}

/**
 * Whether `hermes mcp list` output has a `team` row, and whether it is on.
 * Real layout (hermes_cli/mcp_config.py cmd_mcp_list): a "Name / Transport /
 * Tools / Status" table, one row per server: two spaces, the name padded to
 * 16, ..., then "✓ enabled" or "✗ disabled". No servers: "No MCP servers
 * configured." Pure.
 * @returns {{ listed: boolean, enabled: boolean }}
 */
export function teamRow(output) {
  const row = stripAnsi(output)
    .split(/\r?\n/)
    .find((l) => /^\s*team\s/.test(l))
  return { listed: Boolean(row), enabled: Boolean(row) && !/✗\s*disabled\s*$/.test(row) }
}

// ------------------------------------------------------------------ claude

/**
 * Whether Claude Code is installed and signed in. Reads only the `loggedIn`
 * boolean of `claude auth status --json`; nothing else from it leaves here.
 * @param {{ run: Function, which: Function }} o
 * @returns {Promise<{ installed: boolean, signedIn: boolean | null }>}
 */
export async function claudeStatus({ run, which }) {
  const path = which('claude')
  if (!path) return { installed: false, signedIn: false }
  let signedIn = null
  try {
    const r = await run(path, ['auth', 'status', '--json'], {})
    const out = String(r?.stdout ?? '')
    let data
    try {
      data = JSON.parse(out)
    } catch {
      const m = /\{[\s\S]*\}/.exec(out)
      if (m) {
        try {
          data = JSON.parse(m[0])
        } catch {
          data = undefined
        }
      }
    }
    if (typeof data?.loggedIn === 'boolean') signedIn = data.loggedIn
  } catch {
    signedIn = null
  }
  return { installed: true, signedIn }
}

// ------------------------------------------------------------------ link test

/** The one-line task the agent gets in the link test. */
export function linkTask(token) {
  return `Reply with exactly this and nothing else: ${token}`
}

/** What the supervisor is asked in the link test, in plain words. */
export function linkPrompt(agent, token) {
  return (
    `Use the ask_agent tool of the team connector to give the agent "${agent}" this task: "${linkTask(token)}". ` +
    'Then answer with exactly what the agent replied and nothing else. ' +
    'If the tool is not available or fails, answer with the single word NOLINK followed by the reason.'
  )
}

/** The activity events of agent runs in a chunk of activity.jsonl. */
function readRuns(text, agent) {
  const starts = []
  const ends = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e?.t === 'start' && e.agent === agent) starts.push(e.id)
    else if (e?.t === 'end') ends.set(e.id, e.ok === true)
  }
  return {
    passed: starts.some((id) => ends.get(id) === true),
    failed: starts.some((id) => ends.get(id) === false),
  }
}

/**
 * The end-of-setup link test: the supervisor `sup` must hand a one-line task
 * to `agent` through the team connector, and the activity log must show that
 * agent's run. Never throws.
 * @param {{ hermes: string, run: Function, sup: string, agent: string, repoRoot: string,
 *   env?: object, readFile: Function, exists: Function, token: string, homedir?: string }} o
 * @returns {Promise<{ ok: boolean, stage: string, reply: string, detail: string, fix: string, note: string }>}
 */
export async function linkTest({ hermes, run, sup, agent, repoRoot, env = {}, readFile, exists, token, homedir }) {
  const result = (ok, stage, more = {}) => ({ ok, stage, reply: '', detail: '', fix: '', note: '', ...more })
  try {
    const H = (args) => run(hermes, ['-p', sup, ...args], {})
    const selftest = `node hermes-mcp/selftest.mjs ${agent}`

    const list = await H(['mcp', 'list'])
    const listed = stripAnsi(both(list))
    const team = teamRow(listed)
    const addTeam = `hermes -p ${sup} mcp add team --command node --args "${slash(repoRoot)}/hermes-mcp/server.mjs"`
    if (list?.code !== 0 || !team.listed) {
      return result(false, 'connector', {
        detail: list?.code !== 0 ? redact(lastLines(listed)) : '',
        fix: addTeam,
        note: `The team connector is not registered on profile ${sup}.`,
      })
    }
    if (!team.enabled) {
      return result(false, 'connector', {
        fix: `hermes -p ${sup} config set mcp_servers.team.enabled true`,
        note: `The team connector is registered on profile ${sup} but switched off (mcp list shows it as disabled).`,
      })
    }

    // Exit codes (hermes_cli/mcp_config.py cmd_mcp_test): 0 connected,
    // 1 connection failed, 3 no such server in the profile's config.
    const tested = await H(['mcp', 'test', 'team'])
    if (tested?.code === 3) {
      return result(false, 'connector', {
        detail: redact(lastLines(both(tested))),
        fix: addTeam,
        note: `The team connector is not registered on profile ${sup}.`,
      })
    }
    if (tested?.code !== 0) {
      return result(false, 'connector', {
        detail: redact(lastLines(both(tested))),
        fix: selftest,
        note: "The team connector did not start. This command shows the connector's own error.",
      })
    }

    const dir = String(env.VENOM_AGENTS_DIR ?? '').trim() || join(homedir ?? osHomedir(), '.venom', 'agents')
    const file = join(dir, 'activity.jsonl')
    const readLog = () => {
      try {
        return exists(file) ? String(readFile(file)) : ''
      } catch {
        return ''
      }
    }
    const before = readLog()

    const r = await H(['chat', '-q', linkPrompt(agent, token), '-Q', '--source', 'tool'])
    const answer = hermesAnswer(r?.stdout)
    const after = readLog()
    // The log may have been rotated in between: then all of it is new.
    const fresh = after.startsWith(before) ? after.slice(before.length) : after
    const runs = readRuns(fresh, agent)
    const tokenLine = answer.split(/\r?\n/).find((l) => l.includes(token))?.trim() ?? ''

    if (tokenLine && runs.passed) {
      return result(true, 'done', { reply: tokenLine, note: `${sup} handed the task to ${agent} and ${agent} answered.` })
    }
    const nolink = /^\s*NOLINK\b/i.test(answer)
    if (runs.failed || nolink || !answer || r?.code !== 0) {
      return result(false, 'handoff', {
        detail: redact(lastLines(answer || both(r))) || `(no answer, exit code ${r?.code})`,
        fix: runs.failed ? `hermes -p ${agent} model` : `hermes -p ${sup} model`,
        note: runs.failed
          ? `${sup} reached ${agent}, but ${agent}'s run failed (often its model or sign-in).`
          : `${sup} did not hand the task over.`,
      })
    }
    if (tokenLine) {
      return result(false, 'unproven', {
        reply: tokenLine,
        fix: selftest,
        note: `${sup} answered, but no run of ${agent} was recorded, so it may have answered by itself.`,
      })
    }
    return result(false, 'handoff', {
      detail: redact(lastLines(answer)),
      fix: `hermes -p ${sup} model`,
      note: `${sup} answered something other than ${agent}'s reply.`,
    })
  } catch (err) {
    return result(false, 'error', { detail: redact(err?.message ?? err) })
  }
}
