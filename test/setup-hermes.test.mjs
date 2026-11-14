// scripts/setup-hermes.mjs: the install offer, the health check, the Claude
// Code status and the end-of-setup link test.
//
// Nothing here reaches the network, the real Hermes home or ~/.venom: every
// hermes command goes to scripts/fake-hermes.mjs (state in a temp folder),
// the installer is a stand-in script in a temp folder, activity goes to a temp
// VENOM_AGENTS_DIR, and `claude` is a stub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINKS } from '../scripts/setup-lib.mjs'
import {
  LINK_TOKEN_PREFIX,
  Q_INSTALL,
  claudeStatus,
  healthCheck,
  healthFix,
  installCommand,
  isBlockingDoctorIssue,
  linkPrompt,
  linkTask,
  linkTest,
  offerInstall,
  parseDoctor,
  teamRow,
} from '../scripts/setup-hermes.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = join(ROOT, 'scripts', 'fake-hermes.mjs')
const HERMES = 'fake-hermes'
const fwd = (p) => p.replace(/\\/g, '/')

/** A temp world: fake Hermes state, a temp home and a temp activity folder. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'venom-setup-hermes-'))
  const w = { dir, state: join(dir, 'state'), home: join(dir, 'home'), agents: join(dir, 'agents'), repo: join(dir, 'repo') }
  for (const d of [w.state, w.home, w.repo]) mkdirSync(d, { recursive: true })
  return w
}

/** Environment for the fake: no inherited VENOM_AGENTS_DIR, home pointed at the temp one. */
function fakeEnv(w, extra = {}) {
  const env = { ...process.env, FAKE_HERMES_STATE: w.state, HOME: w.home, USERPROFILE: w.home }
  for (const k of ['VENOM_AGENTS_DIR', 'FAKE_HERMES_DOCTOR', 'FAKE_HERMES_LINK', 'FAKE_HERMES_MCP_TEST', 'FAKE_HERMES_NEED_KEY', 'FAKE_HERMES_FAIL']) {
    delete env[k]
  }
  return { ...env, ...extra }
}
const fake = (w, args, extra) => spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', env: fakeEnv(w, extra) })

/** A `run` that sends the fake hermes command to fake-hermes.mjs and records calls. */
function fakeRun(w, extra = {}) {
  const calls = []
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts })
    assert.equal(cmd, HERMES, `unexpected program: ${cmd}`)
    const r = fake(w, args, extra)
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  return { run, calls }
}

/** A real `run` built on child_process.spawn (output captured, not shown). */
function spawnRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// ------------------------------------------------------------------ installCommand

test('installCommand: Windows runs the official line through Windows PowerShell', () => {
  const c = installCommand({ platform: 'win32', env: { SystemRoot: 'D:\\Win' } })
  assert.equal(c.shown, LINKS.hermesWin)
  assert.equal(c.cmd, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(c.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', LINKS.hermesWin])
  assert.equal(installCommand({ platform: 'win32', env: {} }).cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
})

test('installCommand: Linux and macOS pipe the official script to bash', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(installCommand({ platform, env: {} }), { shown: LINKS.hermesSh, cmd: 'bash', args: ['-c', LINKS.hermesSh] })
  }
})

test('installCommand: VENOM_SETUP_INSTALL_CMD overrides, honouring double quotes', () => {
  const line = '"C:\\Program Files\\nodejs\\node.exe" "C:\\a dir\\install.mjs" --flag x'
  const c = installCommand({ platform: 'win32', env: { VENOM_SETUP_INSTALL_CMD: line } })
  assert.equal(c.shown, line)
  assert.equal(c.cmd, 'C:\\Program Files\\nodejs\\node.exe')
  assert.deepEqual(c.args, ['C:\\a dir\\install.mjs', '--flag', 'x'])
})

// ------------------------------------------------------------------ offerInstall

function installDeps({ answer = 'y', platform = 'linux', env = {}, run, exists = () => false, which = () => '' } = {}) {
  const log = []
  const asked = []
  const runs = []
  return {
    log,
    asked,
    runs,
    deps: {
      platform,
      env,
      log: (l) => log.push(String(l)),
      ask: async (q) => {
        asked.push(q)
        return answer
      },
      run: async (cmd, args, opts = {}) => {
        runs.push({ cmd, args, opts })
        return run ? run(cmd, args, opts) : { code: 0, stdout: '', stderr: '' }
      },
      exists,
      which,
    },
  }
}

test('offerInstall: declined never runs anything and explains the manual way', async () => {
  for (const [platform, where] of [['win32', 'in PowerShell'], ['linux', 'in a terminal']]) {
    const t = installDeps({ answer: '', platform })
    const r = await offerInstall(t.deps)
    assert.deepEqual(r, { status: 'declined', hermes: '' })
    assert.deepEqual(t.asked, [Q_INSTALL])
    assert.equal(Q_INSTALL, 'Install Hermes now? (y/N)')
    assert.equal(t.runs.length, 0)
    const out = t.log.join('\n')
    assert.match(out, /not installed/)
    assert.ok(out.includes(LINKS.hermesDocs))
    assert.ok(out.includes(where))
    assert.ok(out.includes(platform === 'win32' ? LINKS.hermesWin : LINKS.hermesSh))
    assert.ok(out.includes('then run: npm run setup'))
  }
})

test('offerInstall: a real stand-in installer (spawned) drops hermes in ~/.local/bin; found by full path', async () => {
  const w = world()
  const target = join(w.home, '.local', 'bin', 'hermes')
  const script = join(w.dir, 'stand in installer.mjs')
  writeFileSync(
    script,
    "import { mkdirSync, writeFileSync } from 'node:fs'\nimport { dirname } from 'node:path'\n" +
      'const t = process.argv[2]\nmkdirSync(dirname(t), { recursive: true })\nwriteFileSync(t, "#!/bin/sh\\n")\nconsole.log("installed")\n',
  )
  const env = { HOME: fwd(w.home), VENOM_SETUP_INSTALL_CMD: `"${process.execPath}" "${script}" "${target}"` }
  const t = installDeps({ env, run: spawnRun, exists: (p) => existsSync(p) })
  const r = await offerInstall(t.deps)
  assert.equal(t.runs.length, 1)
  assert.equal(t.runs[0].cmd, process.execPath)
  assert.equal(t.runs[0].opts.interactive, true)
  assert.ok(existsSync(target), 'the stand-in installer ran')
  assert.deepEqual(r, { status: 'installed', hermes: `${fwd(w.home)}/.local/bin/hermes` })
  const out = t.log.join('\n')
  assert.match(out, /installed at .*\.local\/bin\/hermes/)
  assert.match(out, /new terminal/)
  assert.match(out, /full path/)
})

test('offerInstall: Windows install location found, not on PATH yet -> full path and the new-terminal note', async () => {
  const exe = 'C:/Users/x/AppData/Local/hermes/bin/hermes.exe'
  const t = installDeps({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, exists: (p) => p === exe })
  const r = await offerInstall(t.deps)
  assert.deepEqual(r, { status: 'installed', hermes: exe })
  assert.match(t.runs[0].cmd, /powershell\.exe$/)
  assert.match(t.log.join('\n'), /cannot see the `hermes` command by name until you open a new terminal/)
})

test('offerInstall: found on PATH -> installed without the note', async () => {
  const t = installDeps({ answer: 'yes', which: (n) => (n === 'hermes' ? '/usr/local/bin/hermes' : '') })
  const r = await offerInstall({ ...t.deps, findHermes: ({ which }) => which('hermes') })
  assert.deepEqual(r, { status: 'installed', hermes: '/usr/local/bin/hermes' })
  assert.doesNotMatch(t.log.join('\n'), /new terminal/)
})

test('offerInstall: installed but found nowhere -> the four numbered steps', async () => {
  const t = installDeps({ env: { HOME: '/home/x', INIT_CWD: '/home/x/venom' } })
  const r = await offerInstall(t.deps)
  assert.deepEqual(r, { status: 'new-terminal', hermes: '' })
  const out = t.log.join('\n')
  assert.match(out, /1\. Close this terminal window/)
  assert.match(out, /2\. Open a new one/)
  assert.match(out, /3\. .*cd "\/home\/x\/venom"/)
  assert.match(out, /4\. Run `npm run setup` again \(it starts from the top and is safe to repeat\)/)
})

test('offerInstall: installer exit 3 -> failed, pointing at its own messages', async () => {
  const t = installDeps({ run: async () => ({ code: 3, stdout: '', stderr: '' }) })
  const r = await offerInstall(t.deps)
  assert.deepEqual(r, { status: 'failed', hermes: '' })
  const out = t.log.join('\n')
  assert.ok(out.includes('The installer stopped with exit code 3; its own messages are above.'))
  assert.ok(out.includes(LINKS.hermesDocs))
})

// ------------------------------------------------------------------ doctor

test('parseDoctor: clean output', () => {
  assert.deepEqual(parseDoctor('\x1b[1mHermes Doctor\x1b[0m\n  ✓ Python\n\n  All checks passed! 🎉\n'), {
    passed: true,
    issues: [],
    blocking: [],
    notes: [],
    tip: '',
    finished: true,
  })
})

test('parseDoctor: garbage', () => {
  const empty = { passed: false, issues: [], blocking: [], notes: [], tip: '', finished: false }
  assert.deepEqual(parseDoctor('\x1b[31m%%% \u0000 1. not an issue\n'), empty)
  assert.deepEqual(parseDoctor(undefined), empty)
})

// Fixtures reconstructed from the Hermes source (test/fixtures/hermes/README.md).
const FIX = join(ROOT, 'test', 'fixtures', 'hermes')
// Line ends are normalised: a Windows checkout may hand the fixtures back as CRLF.
const fixture = (name) => readFileSync(join(FIX, name), 'utf8').replace(/\r\n/g, '\n')
const CRLF = String.fromCharCode(13, 10)
const FRESH_NOTES = ["Run 'hermes setup' to configure API keys", "Run 'hermes setup' to configure missing API keys for full tool access"]
const TIP = "Tip: run 'hermes doctor --fix' to auto-fix what's possible."
const DOCTOR_EXPECT = {
  'doctor-healthy.txt': { passed: true, issues: [], blocking: [], notes: [], tip: '', finished: true },
  'doctor-fresh-install.txt': { passed: false, issues: FRESH_NOTES, blocking: [], notes: FRESH_NOTES, tip: TIP, finished: true },
  'doctor-fresh-install.ansi.txt': { passed: false, issues: FRESH_NOTES, blocking: [], notes: FRESH_NOTES, tip: TIP, finished: true },
  'doctor-blocking.txt': {
    passed: false,
    issues: ['Repair OpenAI SDK: Run `hermes pm repair`, then restart Hermes', ...FRESH_NOTES],
    blocking: ['Repair OpenAI SDK: Run `hermes pm repair`, then restart Hermes'],
    notes: FRESH_NOTES,
    tip: TIP,
    finished: true,
  },
}

for (const [name, expected] of Object.entries(DOCTOR_EXPECT)) {
  test(`parseDoctor fixture ${name} (LF and CRLF)`, () => {
    const text = fixture(name)
    assert.deepEqual(parseDoctor(text), expected)
    assert.deepEqual(parseDoctor(text.split('\n').join(CRLF)), expected)
  })
}

test('parseDoctor: the connectivity status line overwritten with carriage returns is not an issue', () => {
  const text = fixture('doctor-fresh-install.txt')
  assert.ok(text.includes('connectivity checks in parallel'))
  assert.equal(parseDoctor(text).issues.length, 2)
})

test('isBlockingDoctorIssue: fixes for a broken install block, everything else is a note', () => {
  for (const line of [
    'Upgrade Python to 3.10+',
    'Repair HTTPX: Run `hermes pm repair`, then restart Hermes',
    'Repair or reinstall the Hermes launcher through the installation owner',
    'Run `hermes pm repair`, then restart Hermes',
    "Config backend 'remote' cannot serve config for /x",
    'Resolve security advisory ADV-1: uninstall pkg==1 and rotate credentials, then run `hermes doctor --ack ADV-1`.',
    'Free disk space on the filesystem holding /x/cron',
  ]) assert.equal(isBlockingDoctorIssue(line), true, line)
  for (const line of [
    ...FRESH_NOTES,
    "Run 'hermes setup' to create .env",
    "Run 'hermes doctor --fix' or 'hermes setup' to migrate config",
    'Repair the dashboard dependencies: `hermes pm repair`, then restart Hermes',
    'Add ~/.local/bin to your PATH',
    'Check network connectivity',
    'Something Hermes adds in a later release',
  ]) assert.equal(isBlockingDoctorIssue(line), false, line)
})

test('healthCheck against fake-hermes: ok', async () => {
  const w = world()
  const { run, calls } = fakeRun(w, { FAKE_HERMES_DOCTOR: 'ok' })
  assert.deepEqual(await healthCheck({ hermes: HERMES, run }), {
    ok: true,
    issues: [],
    blocking: [],
    notes: [],
    broken: false,
    tip: '',
    detail: '',
  })
  assert.deepEqual(calls[0].args, ['doctor'])
  assert.ok(!calls[0].opts.interactive)
  await healthCheck({ hermes: HERMES, run, profile: 'venom' })
  assert.deepEqual(calls[1].args, ['-p', 'venom', 'doctor'])
})

test('healthCheck against fake-hermes: a fresh install has notes only (not blocked)', async () => {
  const w = world()
  const { run } = fakeRun(w, { FAKE_HERMES_DOCTOR: 'fresh' })
  const r = await healthCheck({ hermes: HERMES, run })
  assert.equal(r.ok, false)
  assert.equal(r.broken, false)
  assert.deepEqual(r.blocking, [])
  assert.deepEqual(r.notes, FRESH_NOTES)
  assert.match(r.tip, /hermes doctor --fix/)
  assert.equal(r.detail, '')
})

test('healthCheck against fake-hermes: blocking, and the sentence names the fix', async () => {
  const w = world()
  const { run } = fakeRun(w, { FAKE_HERMES_DOCTOR: 'blocking' })
  const r = await healthCheck({ hermes: HERMES, run })
  assert.equal(r.ok, false)
  assert.equal(r.broken, false)
  assert.deepEqual(r.blocking, ['Repair OpenAI SDK: Run `hermes pm repair`, then restart Hermes'])
  assert.equal(r.notes.length, 2)
  assert.match(healthFix(r), /^Setup stops here because Hermes itself needs a repair\..*hermes pm repair.*then run npm run setup again\.$/)
})

test('healthCheck against fake-hermes: crash keeps the output in detail and counts as broken', async () => {
  const w = world()
  const { run } = fakeRun(w, { FAKE_HERMES_DOCTOR: 'crash' })
  const r = await healthCheck({ hermes: HERMES, run })
  assert.equal(r.ok, false)
  assert.equal(r.broken, true)
  assert.deepEqual(r.issues, [])
  assert.match(r.detail, /Traceback: something broke/)
  assert.match(healthFix(r), /did not finish.*Install Hermes again/)
})

// ------------------------------------------------------------------ mcp formats

test('teamRow: the real mcp list layouts', () => {
  assert.deepEqual(teamRow(fixture('mcp-list-empty.txt')), { listed: false, enabled: false })
  assert.deepEqual(teamRow(fixture('mcp-list-with-team.txt')), { listed: true, enabled: true })
  assert.deepEqual(teamRow(fixture('mcp-list-with-team.ansi.txt')), { listed: true, enabled: true })
  const off = fixture('mcp-list-with-team.txt').replace(/(\n {2}team .*)✓ enabled/, '$1✗ disabled')
  assert.deepEqual(teamRow(off), { listed: true, enabled: false })
  // A server whose path merely contains "team" is not the team row.
  assert.deepEqual(teamRow('  docs             node C:/x/team/s.mjs           all          ✓ enabled\n'), { listed: false, enabled: false })
})

test('the create-profiles has_team pattern matches the real mcp list rows', () => {
  const re = /^[ \t]*team[ \t]/m // create-profiles.sh: grep -qE '^[[:space:]]*team[[:space:]]'
  assert.ok(re.test(fixture('mcp-list-with-team.txt')))
  assert.ok(!re.test(fixture('mcp-list-empty.txt')))
})

test('fake-hermes prints the reconstructed mcp list / mcp test output', () => {
  const w = teamWorld()
  const list = fake(w, ['-p', 'venom', 'mcp', 'list'])
  assert.equal(list.status, 0)
  assert.deepEqual(teamRow(list.stdout), { listed: true, enabled: true })
  const head = fixture('mcp-list-with-team.txt').split('\n').slice(0, 5).join('\n')
  assert.ok(list.stdout.startsWith(head), list.stdout)
  const ok = fake(w, ['-p', 'venom', 'mcp', 'test', 'team'])
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /^ {2}✓ Connected \(\d+ms\)$/m)
  assert.match(fixture('mcp-test-ok.txt'), /^ {2}✓ Connected \(\d+ms\)$/m)
  const bad = fake(w, ['-p', 'venom', 'mcp', 'test', 'team'], { FAKE_HERMES_MCP_TEST: 'fail' })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^ {2}✗ Connection failed \([\d.]+s\): /m)
  assert.match(fixture('mcp-test-fail.txt'), /^ {2}✗ Connection failed \([\d.]+s\): /m)
  const missing = fake(w, ['-p', 'venom', 'mcp', 'test', 'nope'])
  assert.equal(missing.status, 3)
  assert.equal(missing.stdout.split('\n')[0], fixture('mcp-test-not-found.txt').split('\n')[0].replace("'team'", "'nope'"))
  const w2 = world()
  assert.equal(fake(w2, ['profile', 'create', 'venom', '--no-alias']).status, 0)
  const none = fake(w2, ['-p', 'venom', 'mcp', 'list'])
  assert.equal(none.stdout, fixture('mcp-list-empty.txt'))
})

test('healthCheck redacts what it returns', async () => {
  const secret = 's' + 'k-' + 'abcdefghij1234567890'
  const run = async () => ({ code: 1, stdout: `boom ${secret}\n`, stderr: '' })
  const r = await healthCheck({ hermes: HERMES, run })
  assert.ok(!r.detail.includes(secret))
  assert.match(r.detail, /boom sk-\*\*\*/)
})

// ------------------------------------------------------------------ claude

test('claudeStatus: not installed, signed in, signed out, unparsable; never leaks the account', async () => {
  const email = 'owner@example.test'
  const runWith = (stdout, code = 0) => {
    const calls = []
    return { calls, run: async (cmd, args) => (calls.push({ cmd, args }), { code, stdout, stderr: '' }) }
  }
  const which = (n) => (n === 'claude' ? '/bin/claude' : '')

  const none = runWith('')
  assert.deepEqual(await claudeStatus({ run: none.run, which: () => '' }), { installed: false, signedIn: false })
  assert.equal(none.calls.length, 0)

  const inn = runWith(JSON.stringify({ loggedIn: true, email, orgName: 'Org' }))
  const r1 = await claudeStatus({ run: inn.run, which })
  assert.deepEqual(r1, { installed: true, signedIn: true })
  assert.deepEqual(inn.calls[0], { cmd: '/bin/claude', args: ['auth', 'status', '--json'] })
  assert.ok(!JSON.stringify(r1).includes(email))

  const out = runWith(JSON.stringify({ loggedIn: false, email }), 1)
  assert.deepEqual(await claudeStatus({ run: out.run, which }), { installed: true, signedIn: false })

  assert.deepEqual(await claudeStatus({ run: runWith('not json at all').run, which }), { installed: true, signedIn: null })
  const thrower = async () => {
    throw new Error('spawn failed')
  }
  assert.deepEqual(await claudeStatus({ run: thrower, which }), { installed: true, signedIn: null })
})

// ------------------------------------------------------------------ link test

const TOKEN = `${LINK_TOKEN_PREFIX}0a1b2c3d`

test('linkTask and linkPrompt say it plainly', () => {
  assert.equal(linkTask(TOKEN), `Reply with exactly this and nothing else: ${TOKEN}`)
  const p = linkPrompt('coder', TOKEN)
  assert.match(p, /ask_agent tool of the team connector/)
  assert.ok(p.includes('"coder"'))
  assert.ok(p.includes(`"${linkTask(TOKEN)}"`))
  assert.match(p, /NOLINK/)
})

/** A supervisor and an agent with models; the team connector unless `team: false`. */
function teamWorld({ team = true } = {}) {
  const w = world()
  const ok = (args, extra) => assert.equal(fake(w, args, extra).status, 0, args.join(' '))
  ok(['profile', 'create', 'venom'])
  ok(['profile', 'create', 'coder'])
  ok(['-p', 'venom', 'model'], { FAKE_HERMES_PICK: 'openai/gpt-x' })
  ok(['-p', 'coder', 'model'], { FAKE_HERMES_PICK: 'openai/gpt-x' })
  ok(['-p', 'venom', 'config', 'set', 'agent.max_turns', '20'])
  if (team) ok(['-p', 'venom', 'mcp', 'add', 'team', '--command', 'node', '--args', `${fwd(w.repo)}/hermes-mcp/server.mjs`])
  return w
}

async function link(w, extra = {}, more = {}) {
  const { run, calls } = fakeRun(w, { VENOM_AGENTS_DIR: w.agents, ...extra })
  const r = await linkTest({
    hermes: HERMES,
    run,
    sup: 'venom',
    agent: 'coder',
    repoRoot: w.repo,
    env: { VENOM_AGENTS_DIR: w.agents },
    readFile: (p) => readFileSync(p, 'utf8'),
    exists: existsSync,
    token: TOKEN,
    homedir: w.home,
    ...more,
  })
  return { r, calls }
}
const activity = (w) =>
  existsSync(join(w.agents, 'activity.jsonl'))
    ? readFileSync(join(w.agents, 'activity.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []

test('linkTest: pass, with the agent run recorded', async () => {
  const w = teamWorld()
  // An older run in the log must not count.
  mkdirSync(w.agents, { recursive: true })
  writeFileSync(join(w.agents, 'activity.jsonl'), JSON.stringify({ t: 'start', id: 'old', agent: 'coder', task: 'x', ts: 1, pid: 1 }) + '\n')
  const { r, calls } = await link(w)
  assert.deepEqual(r, { ok: true, stage: 'done', reply: TOKEN, detail: '', fix: '', note: r.note })
  assert.deepEqual(calls.map((c) => c.args.slice(0, 4)), [
    ['-p', 'venom', 'mcp', 'list'],
    ['-p', 'venom', 'mcp', 'test'],
    ['-p', 'venom', 'chat', '-q'],
  ])
  assert.deepEqual(calls[2].args.slice(4), [linkPrompt('coder', TOKEN), '-Q', '--source', 'tool'])
  const events = activity(w)
  assert.equal(events.length, 3)
  assert.deepEqual([events[1].t, events[1].agent, events[2].t, events[2].ok], ['start', 'coder', 'end', true])
})

test('linkTest: connector not registered -> the mcp add command', async () => {
  const w = teamWorld({ team: false })
  const { r, calls } = await link(w)
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'connector')
  assert.equal(r.fix, `hermes -p venom mcp add team --command node --args "${fwd(w.repo)}/hermes-mcp/server.mjs"`)
  assert.equal(calls.length, 1)
})

test('linkTest: mcp test failing -> the selftest command and the output tail', async () => {
  const w = teamWorld()
  const { r } = await link(w, { FAKE_HERMES_MCP_TEST: 'fail' })
  assert.equal(r.stage, 'connector')
  assert.equal(r.fix, 'node hermes-mcp/selftest.mjs coder')
  assert.match(r.detail, /Connection failed/)
  assert.deepEqual(activity(w), [])
})

test('linkTest: team row switched off -> the config set command, no mcp test', async () => {
  const w = teamWorld()
  const { r, calls } = await link(w, { FAKE_HERMES_MCP_DISABLED: 'team' })
  assert.equal(r.stage, 'connector')
  assert.equal(r.fix, 'hermes -p venom config set mcp_servers.team.enabled true')
  assert.match(r.note, /switched off/)
  assert.equal(calls.length, 1)
})

test('linkTest: mcp test exit 3 (not in the config) -> the mcp add command', async () => {
  const w = teamWorld()
  const listed = fixture('mcp-list-with-team.txt')
  const run = async (_cmd, args) =>
    args.includes('list') ? { code: 0, stdout: listed, stderr: '' } : { code: 3, stdout: fixture('mcp-test-not-found.txt'), stderr: '' }
  const r = await linkTest({ hermes: HERMES, run, sup: 'venom', agent: 'coder', repoRoot: w.repo, env: {}, readFile: () => '', exists: () => false, token: 'x', homedir: w.home })
  assert.equal(r.stage, 'connector')
  assert.equal(r.fix, `hermes -p venom mcp add team --command node --args "${fwd(w.repo)}/hermes-mcp/server.mjs"`)
  assert.match(r.detail, /not found in config/)
})

test("linkTest: 'self' (token but no run) -> unproven", async () => {
  const w = teamWorld()
  const { r } = await link(w, { FAKE_HERMES_LINK: 'self' })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'unproven')
  assert.equal(r.reply, TOKEN)
  assert.equal(r.fix, 'node hermes-mcp/selftest.mjs coder')
  assert.match(r.note, /may have answered by itself/)
})

test("linkTest: 'agentfail' -> handoff, fix the agent's model", async () => {
  const w = teamWorld()
  const { r } = await link(w, { FAKE_HERMES_LINK: 'agentfail' })
  assert.equal(r.stage, 'handoff')
  assert.equal(r.fix, 'hermes -p coder model')
  assert.match(r.detail, /NOLINK the agent returned an error/)
})

test("linkTest: 'nolink' -> handoff, fix the supervisor's model", async () => {
  const w = teamWorld()
  const { r } = await link(w, { FAKE_HERMES_LINK: 'nolink' })
  assert.equal(r.stage, 'handoff')
  assert.equal(r.fix, 'hermes -p venom model')
  assert.match(r.detail, /NOLINK tool not available/)
})

test('linkTest never throws', async () => {
  const w = teamWorld()
  const run = async () => {
    throw new Error('spawn EPERM')
  }
  const r = await linkTest({ hermes: HERMES, run, sup: 'venom', agent: 'coder', repoRoot: w.repo, env: {}, readFile: () => '', exists: () => false, token: TOKEN, homedir: w.home })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'error')
  assert.match(r.detail, /EPERM/)
})

// ------------------------------------------------------------------ fake-hermes extras

test('fake-hermes: --version, config env-path, and no activity without VENOM_AGENTS_DIR', () => {
  const w = teamWorld()
  const v = fake(w, ['--version'], { FAKE_HERMES_INSTALL_DIR: 'X:/fake/install' })
  assert.equal(v.status, 0)
  assert.match(v.stdout, /v0\.0\.0 \(fake\)/)
  assert.match(v.stdout, /Install directory: X:\/fake\/install/)
  const e = fake(w, ['-p', 'venom', 'config', 'env-path'])
  assert.equal(e.stdout.trim(), join(w.state, 'profiles', 'venom', '.env'))
  assert.ok(!existsSync(e.stdout.trim()))
  const c = fake(w, ['-p', 'venom', 'chat', '-q', linkPrompt('coder', TOKEN), '-Q'])
  assert.equal(c.status, 0)
  assert.match(c.stdout, /^NOLINK/)
  assert.ok(!existsSync(w.agents))
  assert.ok(!existsSync(join(w.home, '.venom')))
})

test('fake-hermes: FAKE_HERMES_NEED_KEY checks the profile .env and never prints the value', () => {
  const w = teamWorld()
  const value = ['test', 'value', '42'].join('-')
  const envFile = join(w.state, 'profiles', 'venom', '.env')
  const chat = () => fake(w, ['-p', 'venom', 'chat', '-q', 'hi'], { FAKE_HERMES_NEED_KEY: 'OPENAI_API_KEY' })
  writeFileSync(envFile, `# OPENAI_API_KEY=${value}\nOTHER=1\n`)
  let r = chat()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no credentials \(set OPENAI_API_KEY in the profile \.env\)/)
  writeFileSync(envFile, `OPENAI_API_KEY="${value}"\n`)
  r = chat()
  assert.equal(r.status, 1)
  assert.ok(!(r.stdout + r.stderr).includes(value))
  writeFileSync(envFile, `OPENAI_API_KEY=${value}\r\n`)
  r = chat()
  assert.equal(r.status, 0)
  assert.match(r.stdout, /READY/)
  assert.ok(!(r.stdout + r.stderr).includes(value))
})
