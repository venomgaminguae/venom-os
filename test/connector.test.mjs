// The Hermes team connector's pure parts (hermes-mcp/runner.mjs and
// agents.mjs): argument building, environments, answers, and the roster.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { loadRoster } from '../hermes-mcp/roster.mjs'

// Never the owner's venom.agents.json: a roster file that does not exist
// means the starter set. Set before agents.mjs and runner.mjs load it.
process.env.VENOM_ROSTER_FILE = join(tmpdir(), `venom-no-roster-${process.pid}`, 'venom.agents.json')
const {
  agentCommand,
  childEnv,
  claudeAnswer,
  claudeArgs,
  claudeExeProblem,
  claudeSessionName,
  geminiAnswer,
  geminiEnv,
  hermesAnswer,
  AGY,
  CLAUDE,
  CLAUDE_ALLOW,
  CLAUDE_DENY,
  HERMES,
  PROFILE_IDS,
  PROJECT_DIRS,
  PROJECTS_ROOT,
} = await import('../hermes-mcp/runner.mjs')
const { AGENTS, AGENT_IDS, rosterLines } = await import('../hermes-mcp/agents.mjs')

test('roster: loaded from the roster file (here the starter set); kinds, roles and maps follow the entries', () => {
  assert.deepEqual(AGENTS, loadRoster({ file: process.env.VENOM_ROSTER_FILE }).agents)
  assert.deepEqual(AGENT_IDS, AGENTS.map((a) => a.id))
  assert.deepEqual(AGENT_IDS, ['researcher', 'coder', 'operator', 'writer'])
  for (const a of AGENTS) {
    assert.ok(['specialist', 'project', 'advisor'].includes(a.kind), a.id)
    assert.ok(a.role && !a.role.includes('\n'), a.id)
  }
  // Every project lead has a folder, and every folder belongs to a project lead.
  assert.deepEqual(AGENTS.filter((a) => a.kind === 'project').map((a) => a.id), Object.keys(PROJECT_DIRS))
  for (const id of Object.keys(PROFILE_IDS)) assert.ok(AGENT_IDS.includes(id), id)
  assert.equal(rosterLines().split('\n').length, AGENTS.length)
  assert.equal(rosterLines().split('\n')[0], `- ${AGENTS[0].id}: ${AGENTS[0].role}`)
})

test('the connector takes its tool description and enum from the shared roster', () => {
  const src = readFileSync(new URL('../hermes-mcp/server.mjs', import.meta.url), 'utf8')
  assert.match(src, /z\.enum\(AGENT_IDS\)/)
  assert.match(src, /rosterLines\(\)/)
})

test('Hermes arguments: profile, quiet single query, tool source', () => {
  const c = agentCommand('writer', 'Draft a reply.')
  assert.equal(c.exe, HERMES)
  assert.equal(c.isGemini, false)
  assert.deepEqual(c.args, ['-p', 'writer', 'chat', '-q', 'Draft a reply.', '-Q', '--source', 'tool'])
})

test('Hermes arguments: a project lead runs its mapped profile inside its project folder', () => {
  // The shipped roster has no project leads; a fixture one ('myapp') checks the mechanism.
  const maps = { projectDirs: { myapp: join(PROJECTS_ROOT, 'myapp') }, profileIds: { myapp: 'my-app' } }
  const c = agentCommand('myapp', 'Fix it.', maps)
  assert.equal(c.args[1], 'my-app')
  assert.equal(c.cwd, maps.projectDirs.myapp)
  assert.match(c.cwd.replace(/\\/g, '/'), /\/myapp$/)
  // Others keep their own profile name and the default folder.
  const w = agentCommand('writer', 't', maps)
  assert.equal(w.args[1], 'writer')
  assert.notEqual(w.cwd, maps.projectDirs.myapp)
  // Shipped defaults: no mappings, and a neutral projects root.
  assert.deepEqual(PROJECT_DIRS, {})
  assert.deepEqual(PROFILE_IDS, {})
  assert.equal(agentCommand('coder', 't').cwd, agentCommand('writer', 't').cwd)
  assert.equal(PROJECTS_ROOT, process.env.PROJECTS_ROOT || join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Projects'))
  // An inherited property name is not a mapping.
  assert.equal(agentCommand('constructor', 't').args[1], 'constructor')
})

test('Gemini arguments: Antigravity, JSON output, plan (read-only) mode, a model only when AGY_MODEL names one', () => {
  const c = agentCommand('gemini', 'Compare two GPUs.')
  assert.equal(c.exe, AGY)
  assert.equal(c.isGemini, true)
  assert.deepEqual(c.args.slice(0, 8), ['-p', 'Compare two GPUs.', '--output-format', 'json', '--mode', 'plan', '--print-timeout', '15m'])
  // No model is named by default; AGY_MODEL (read when the module loads) pins one.
  assert.deepEqual(c.args.slice(8), process.env.AGY_MODEL ? ['--model', process.env.AGY_MODEL] : [])
})

test('a task is one argument, whatever it contains', () => {
  const task = 'Line one\nline "two" --mode act; & echo hi'
  assert.equal(agentCommand('coder', task).args[4], task)
  assert.equal(agentCommand('gemini', task).args[1], task)
})

// ------------------------------------------------------------ Claude Code

test('Claude Code arguments: headless JSON in the projects root, the task on stdin only', () => {
  const task = '--dangerously-skip-permissions\nFix "it" & echo hi; --permission-mode bypassPermissions'
  const c = agentCommand('claude', task)
  assert.equal(c.exe, CLAUDE)
  assert.equal(c.kind, 'claude')
  assert.equal(c.isGemini, false)
  assert.equal(c.cwd, PROJECTS_ROOT)
  assert.equal(c.stdin, task)
  // The task is no argument. Its first words appear in one place only, the
  // session name, which is the value of --name and starts with "VENOM: ", so
  // nothing in a task can become a flag.
  assert.ok(!c.args.includes(task))
  const name = c.args.indexOf('--name') + 1
  assert.ok(!c.args.some((a, i) => i !== name && (a.includes('dangerously') || a.includes('bypassPermissions') || a.includes('echo hi'))))
  const flags = c.args.filter((a) => a.startsWith('-'))
  assert.deepEqual(flags, ['-p', '--output-format', '--permission-mode', '--permission-prompts', '--name', '--allowedTools', '--disallowedTools'])
  assert.deepEqual(c.args.slice(0, 7), ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none'])
  assert.equal(c.args[7], '--name')
  assert.match(c.args[8], /^VENOM: /)
  // The other kinds keep their task as an argument and get no stdin.
  assert.equal(agentCommand('coder', 't').stdin, undefined)
  assert.equal(agentCommand('coder', 't').kind, 'hermes')
  assert.equal(agentCommand('gemini', 't').kind, 'gemini')
})

test('Claude Code permissions: accept edits, no prompts, never a bypass', () => {
  const args = claudeArgs('Do the job.')
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none')
  for (const a of args) assert.ok(!/dangerously|bypass/i.test(a), a)
  assert.ok(!args.includes('--add-dir') && !args.includes('--settings') && !args.includes('--bare'))
  // Each rule is its own argument, the allow list then the deny list, to the end.
  const allow = args.indexOf('--allowedTools')
  const deny = args.indexOf('--disallowedTools')
  assert.deepEqual(args.slice(allow + 1, deny), CLAUDE_ALLOW)
  assert.deepEqual(args.slice(deny + 1), CLAUDE_DENY)
})

test('Claude Code allow list: checking work, the web, two MCP servers, nothing broad', () => {
  assert.deepEqual(CLAUDE_ALLOW, [
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
  ])
  for (const r of CLAUDE_ALLOW) {
    // No whole shell, no wildcard before the subcommand, no file tools beyond the mode's own.
    assert.ok(!/^(Bash|PowerShell|Edit|Write|Read|mcp__\*|\*)(\(\*\))?$/.test(r), r)
    assert.ok(!/^(Bash|PowerShell)\(\s*\*/.test(r), r)
    assert.ok(!/^(Bash|PowerShell)\((git|npm|npx|node) \*/.test(r), r)
  }
})

test('Claude Code deny list: push, hard reset, deleting, the account connectors', () => {
  for (const rule of [
    'Bash(git push *)',
    'Bash(git * push *)',
    'Bash(git reset --hard *)',
    'Bash(git * reset --hard *)',
    'PowerShell(git push *)',
    'PowerShell(git reset --hard *)',
    'Bash(rm -*)',
    'Bash(rm * -*)',
    'Bash(rmdir *)',
    'Bash(del *)',
    'PowerShell(Remove-Item *)',
    'mcp__claude_ai_*',
    'mcp__plugin_github_github__*',
    'mcp__linear__*',
    'mcp__plugin_playwright_playwright__*',
  ]) {
    assert.ok(CLAUDE_DENY.includes(rule), rule)
  }
  // Nothing is both allowed and denied, and no rule could split on a comma.
  for (const r of CLAUDE_ALLOW) assert.ok(!CLAUDE_DENY.includes(r), r)
  for (const r of [...CLAUDE_ALLOW, ...CLAUDE_DENY]) assert.ok(!r.includes(','), r)
})

test('Claude Code deny list: any claude.ai connector tool is denied, none allowed', () => {
  // A rule's `*` matches any run of characters (Claude Code's MCP wildcard).
  const glob = (rule) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  const hit = (rules, tool) => rules.some((r) => glob(r).test(tool))
  for (const tool of [
    'mcp__claude_ai_Example__create_item',
    'mcp__claude_ai_Another_Service__send_message',
    'mcp__claude_ai_X__y',
  ]) {
    assert.ok(hit(CLAUDE_DENY, tool), tool)
    assert.ok(!hit(CLAUDE_ALLOW, tool), tool)
  }
  // No connector is named one by one: the shared prefix covers them all.
  assert.deepEqual(CLAUDE_DENY.filter((r) => r.startsWith('mcp__claude_ai_')), ['mcp__claude_ai_*'])
})

test('claudeSessionName: "VENOM: " and the first words, one line, capped', () => {
  assert.equal(claudeSessionName('Review the bridge.\nThen report.'), 'VENOM: Review the bridge. Then report.')
  assert.equal(claudeSessionName('one two three four five six seven eight nine ten'), 'VENOM: one two three four five six seven eight')
  assert.equal(claudeSessionName('  --model\tx\u0000y  '), 'VENOM: --model x y')
  assert.equal(claudeSessionName(''), 'VENOM:')
  const long = claudeSessionName('x'.repeat(500))
  assert.equal(long.length, 'VENOM: '.length + 60)
  assert.ok(!/[\r\n]/.test(claudeSessionName('a\r\nb')))
})

test('claudeAnswer: the result, then the session line; errors and junk fail', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const line = `Claude Code session: ${id} (open in the Claude app: claude --desktop --resume ${id})`
  const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '  claude link OK  ', session_id: id })
  assert.deepEqual(claudeAnswer(ok), { ok: true, text: `claude link OK\n\n${line}` })
  // The session line is the last line.
  assert.equal(claudeAnswer(ok).text.split('\n').pop(), line)
  // Something printed before the result, and the verbose array form.
  assert.deepEqual(claudeAnswer(`warning: x\n${ok}\n`), { ok: true, text: `claude link OK\n\n${line}` })
  assert.deepEqual(claudeAnswer(JSON.stringify([{ type: 'system', subtype: 'init' }, JSON.parse(ok)])), { ok: true, text: `claude link OK\n\n${line}` })
  // An error result, an error subtype, an empty answer.
  assert.deepEqual(
    claudeAnswer(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', session_id: id })),
    { ok: false, text: `Claude Code ended with an error.\nNot logged in\n${line}` },
  )
  assert.deepEqual(
    claudeAnswer(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, session_id: id })),
    { ok: false, text: `Claude Code ended with error_max_turns.\n${line}` },
  )
  assert.deepEqual(claudeAnswer(JSON.stringify({ type: 'result', subtype: 'success', result: '', session_id: id })), { ok: false, text: `Claude Code returned no answer.\n${line}` })
  // A session id that is not a UUID is never echoed into the command hint.
  assert.deepEqual(claudeAnswer(JSON.stringify({ result: 'Hi', session_id: 'x; calc.exe' })), { ok: true, text: 'Hi' })
  // No result object: a failure, with whatever was printed.
  assert.deepEqual(claudeAnswer('not json at all '), { ok: false, text: 'not json at all' })
  assert.deepEqual(claudeAnswer('   '), { ok: false, text: '' })
  assert.deepEqual(claudeAnswer('[]'), { ok: false, text: '[]' })
})

test('claudeExeProblem: a .cmd or .bat shim is refused, never run through a shell', () => {
  assert.equal(claudeExeProblem('C:/Users/x/.local/bin/claude.exe'), '')
  assert.equal(claudeExeProblem('/usr/local/bin/claude'), '')
  assert.match(claudeExeProblem('C:/Users/x/AppData/Roaming/npm/claude.cmd'), /shim/)
  assert.match(claudeExeProblem('C:/x/claude.BAT'), /TEAM_CLAUDE_EXE/)
  const src = readFileSync(new URL('../hermes-mcp/runner.mjs', import.meta.url), 'utf8')
  assert.ok(!/shell:\s*true/.test(src))
})

test('child environments: Claude variables out, unbuffered UTF-8 in; Gemini also loses Google keys', () => {
  const base = { PATH: 'p', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_ENTRYPOINT: 'y', CLAUDECODE: '1', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'k' }
  const h = childEnv(base)
  assert.equal(h.PATH, 'p')
  assert.equal(h.PYTHONIOENCODING, 'utf-8')
  assert.equal(h.PYTHONUNBUFFERED, '1')
  assert.ok(!('ANTHROPIC_API_KEY' in h) && !('CLAUDE_CODE_ENTRYPOINT' in h) && !('CLAUDECODE' in h))
  assert.equal(h.GEMINI_API_KEY, 'g')
  const g = geminiEnv(base)
  assert.ok(!('GEMINI_API_KEY' in g) && !('GOOGLE_API_KEY' in g) && !('ANTHROPIC_API_KEY' in g))
})

test('geminiAnswer: success, failure status, preamble before the JSON, and plain text', () => {
  assert.deepEqual(geminiAnswer('{"status":"SUCCESS","response":"  Hello.  "}'), { ok: true, text: 'Hello.' })
  assert.deepEqual(geminiAnswer('Loading...\n{"status":"SUCCESS","response":"Hi"}'), { ok: true, text: 'Hi' })
  assert.deepEqual(geminiAnswer('{"status":"ERROR","error":"quota"}'), { ok: false, text: 'Antigravity ended with status ERROR: quota' })
  assert.deepEqual(geminiAnswer('{"status":"SUCCESS","response":""}'), { ok: false, text: '' })
  assert.deepEqual(geminiAnswer('{"response":"no status"}'), { ok: true, text: 'no status' })
  assert.deepEqual(geminiAnswer('not json at all '), { ok: true, text: 'not json at all' })
  assert.deepEqual(geminiAnswer('   '), { ok: false, text: '' })
})

test('hermesAnswer drops the session bookkeeping lines', () => {
  assert.equal(hermesAnswer('Resumed session x\r\nAgent online.\r\nsession_id: local-1\r\n'), 'Agent online.')
  assert.equal(hermesAnswer('Normalized model\nA\nB\n'), 'A\nB')
})
