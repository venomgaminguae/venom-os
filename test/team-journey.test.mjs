// One person's whole first session with the team, in order, on ONE fake Hermes
// state folder, ONE temp roster file and ONE temp repo/config:
//   npm run setup (coder and writer only) -> npm run add-agent (Analyst) ->
//   npm run agents -> npm run remove-agent analyst (profile kept) -> npm run agents
// Every hermes call goes to scripts/fake-hermes.mjs; the real create-profiles.sh
// runs through bash with HERMES_EXE pointing at a shim for the fake.
//
// Set VENOM_JOURNEY_TRANSCRIPT=<file> to have it write the whole screen (every
// printed line, every question with the answer typed after it, and a heading
// line before each command) to that file, with temp paths made anonymous.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Q, wizard } from '../scripts/setup-lib.mjs'
import { Q as QA, addAgent, listAgents, removeAgent, roleLine } from '../scripts/agents-lib.mjs'
import { ENV_Q_DONE } from '../scripts/setup-env.mjs'
import { Q_SKILLS } from '../scripts/setup-skills.mjs'
import { Q_GBRAIN } from '../scripts/setup-gbrain.mjs'
import { createServer } from 'node:net'

// A free port for GBrain (the memory question is declined here; the real port is never used).
const GBRAIN_TEST_PORT = await new Promise((resolve, reject) => {
  const s = createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})
import { BRIDGE_AGENTS, STARTER_AGENTS } from '../hermes-mcp/roster.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KIT = join(ROOT, 'hermes-setup').replace(/\\/g, '/')
const FAKE = join(ROOT, 'scripts', 'fake-hermes.mjs')
const NODE = process.execPath
const WIN = process.platform === 'win32'
const fwd = (p) => String(p).replace(/\\/g, '/')

// On Windows `bash` on PATH may be WSL's, which cannot see this folder: use Git's.
const BASH = WIN
  ? [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean).map((r) => join(r, 'Git', 'bin', 'bash.exe')).find((p) => existsSync(p)) ?? ''
  : (spawnSync('which', ['bash'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n')[0]

const JOB =
  'Reads the monthly sales and expense reports, compares them with earlier months, explains in plain words what changed and why it matters, and never guesses a number it cannot find.'

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'venom-journey-'))
  const w = {
    dir,
    repo: join(dir, 'repo'),
    state: join(dir, 'state'),
    agents: join(dir, 'agents'),
    home: join(dir, 'home'),
    projects: join(dir, 'projects'),
    roster: join(dir, 'venom.agents.json'),
  }
  for (const d of [join(w.repo, 'hermes-mcp'), w.state, join(dir, 'bin'), w.home, w.projects]) mkdirSync(d, { recursive: true })
  writeFileSync(join(w.repo, 'hermes-mcp', 'server.mjs'), '// stand-in\n')
  writeFileSync(join(w.repo, 'venom.config.json'), '{}\n')
  w.config = join(w.repo, 'venom.config.json')
  // One shim for both the wizard and bash: a sh script that runs the fake.
  w.hermes = fwd(join(dir, 'bin', 'hermes'))
  writeFileSync(w.hermes, `#!/bin/sh\nexec "${fwd(NODE)}" "${fwd(FAKE)}" "$@"\n`, { mode: 0o755 })
  return w
}

/** The shared screen and the side effects every command uses. */
function session(w, envExtra = {}) {
  const events = [] // ['head', cmd] | ['log', line] | ['out', line] | ['ask', question, answer]
  let queue = []
  let picks = []
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HERMES_EXE: w.hermes,
    ProgramFiles: join(w.dir, 'pf'),
    // Where the wizard looks for Git's bash on Windows (no pwsh offered here).
    ProgramW6432: WIN ? dirname(dirname(dirname(BASH))) : undefined,
    LOCALAPPDATA: join(w.dir, 'localappdata'),
    VENOM_AGENTS_DIR: w.agents,
    VENOM_ROSTER_FILE: w.roster,
    PROJECTS_ROOT: w.projects,
    GBRAIN_HOME: join(w.dir, 'gbrain-home'),
    VENOM_SETUP_GBRAIN_PORT: String(GBRAIN_TEST_PORT),
    ...envExtra,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  const chrome = `${fwd(env.ProgramFiles)}/Google/Chrome/Application/chrome.exe`
  const run = (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      const isHermes = cmd === w.hermes
      const pick = isHermes && args[0] === '-p' && args[2] === 'model' ? { FAKE_HERMES_PICK: picks.shift() ?? '' } : {}
      const [file, argv] = isHermes ? [NODE, [FAKE, ...args]] : [cmd, args]
      const child = spawn(file, argv, {
        env: { ...process.env, ...env, ...opts.env, ...pick, FAKE_HERMES_STATE: w.state },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }))
      child.on('close', (code) => {
        if (opts.interactive) for (const l of `${stdout}\n${stderr}`.split(/\r?\n/)) if (l.trim()) events.push(['out', l])
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  const deps = {
    platform: process.platform,
    env,
    log: (l) => events.push(['log', String(l)]),
    async ask(q) {
      if (q === ENV_Q_DONE) {
        events.push(['ask', q, ''])
        return ''
      }
      const next = queue.shift()
      assert.ok(next, `unexpected question: ${q}`)
      const [want, answer] = next
      if (want instanceof RegExp) assert.match(q, want)
      else assert.ok(q.startsWith(want), `expected question "${want}", got "${q}"`)
      events.push(['ask', q, answer])
      return answer
    },
    run,
    exists: (p) => fwd(p) === chrome || existsSync(p),
    which: (name) => (name === 'bash' && !WIN ? BASH : name === 'google-chrome' ? '/fake/google-chrome' : ''),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, text) => writeFileSync(p, text),
    copyFile: (src, dest) => copyFileSync(src, dest),
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    now: () => new Date(),
    nowMs: () => Date.now(),
    randomHex: () => randomBytes(4).toString('hex'),
    fetchJson: async (url) => {
      throw new Error(`no network in tests: ${url}`)
    },
    fetchText: async (url) => {
      throw new Error(`no network in tests: ${url}`)
    },
    homedir: w.home,
  }
  /** Run one command with its scripted answers; returns its exit code and its own screen lines. */
  async function step(heading, fn, { answers = [], pick = [], extra = {} } = {}) {
    queue = [...answers]
    picks = [...pick]
    const from = events.length
    events.push(['head', `$ ${heading}`])
    const code = await fn({ ...deps, ...extra })
    assert.equal(queue.length, 0, `${heading}: questions not asked: ${queue.map((q) => q[0]).join(' | ')}`)
    const mine = events.slice(from)
    return { code, out: mine.filter((e) => e[0] === 'log' || e[0] === 'out').map((e) => e[1]).join('\n'), lines: mine.filter((e) => e[0] === 'log').map((e) => e[1]) }
  }
  function transcript() {
    let t = events
      .map((e) => (e[0] === 'head' ? `\n${e[1]}` : e[0] === 'ask' ? `${e[1]} ${e[2]}`.trimEnd() : e[1]))
      .join('\n')
      .replace(/^\n/, '')
    for (const [from, to] of [[w.dir, '<TEMP>'], [ROOT.replace(/[\\/]+$/, ''), '<REPO>']]) {
      for (const v of new Set([from, fwd(from)])) t = t.split(v).join(to)
    }
    return t.replace(/\d{8}-\d{6}/g, '<STAMP>') + '\n'
  }
  return { step, transcript, events }
}

const state = (w) => JSON.parse(readFileSync(join(w.state, 'state.json'), 'utf8'))
const profiles = (w) => Object.keys(state(w).profiles).sort()
const rosterIds = (w) => JSON.parse(readFileSync(w.roster, 'utf8')).agents.map((a) => a.id)
const SKIP = { skip: !BASH && 'bash not found' }
/** npm run setup in this world: Claude by subscription, the supervisor venom, then `team` answers. */
const setup = (s, w, team) =>
  s.step('npm run setup', (d) => wizard({ ...d, nodeVersion: process.versions.node, repoRoot: w.repo, kitDir: KIT }), {
    answers: [[Q.brain, '2'], [Q.access, '1'], [Q.supervisor, ''], ...team, [/^Use a cheaper model/, ''], [Q.fallback, ''], [Q.appModel, ''], [Q_SKILLS, 'n'], [Q_GBRAIN.install, 'n']],
    pick: ['anthropic/test-claude-model'],
  })
const row = (r, id) => r.lines.find((l) => l.startsWith(`  ${id} `))?.trim().split(/\s{2,}/)

test('the journey: setup with coder and writer, add Analyst, list, remove it (profile kept), list', SKIP, async () => {
  const w = world()
  const s = session(w)
  const agentDeps = { repoRoot: ROOT, rosterFile: w.roster, configFile: w.config, bridgeExe: {} }

  try {
    // (1) npm run setup: Claude by subscription, the supervisor venom, coder and writer only.
    const first = await s.step('npm run setup', (d) => wizard({ ...d, nodeVersion: process.versions.node, repoRoot: w.repo, kitDir: KIT }), {
      answers: [
        [Q.brain, '2'],
        [Q.access, '1'],
        [Q.supervisor, ''],
        ...STARTER_AGENTS.map((a) => [Q.agent(a), ['coder', 'writer'].includes(a.id) ? 'y' : 'n']),
        [/^Use a cheaper model/, ''],
        [Q.fallback, ''],
        [Q.appModel, ''], [Q_SKILLS, 'n'], [Q_GBRAIN.install, 'n'],
      ],
      pick: ['anthropic/test-claude-model'],
    })
    assert.equal(first.code, 0, first.out)
    assert.deepEqual(profiles(w), ['coder', 'venom', 'writer'])
    assert.deepEqual(rosterIds(w), ['coder', 'writer'])
    assert.equal(JSON.parse(readFileSync(w.config, 'utf8')).supervisorProfile, 'venom')

    // (2) npm run add-agent: Analyst, a general specialist.
    const add = await s.step('npm run add-agent', addAgent, {
      answers: [[QA.name, 'Analyst'], [QA.job, JOB], [QA.kind, '1']],
      extra: agentDeps,
    })
    assert.equal(add.code, 0, add.out)
    assert.deepEqual(profiles(w), ['analyst', 'coder', 'venom', 'writer'])
    assert.equal(state(w).profiles.analyst.clonedFrom, 'venom')
    assert.deepEqual(rosterIds(w), ['coder', 'writer', 'analyst'])
    const analyst = JSON.parse(readFileSync(w.roster, 'utf8')).agents.at(-1)
    assert.equal(analyst.role, roleLine(JOB))
    assert.equal(analyst.kind, 'specialist')

    // (3) npm run agents: all three exist and answer.
    const list = await s.step('npm run agents', listAgents, { extra: agentDeps })
    assert.equal(list.code, 0, list.out)
    for (const [id, name] of [['coder', 'Coder'], ['writer', 'Writer'], ['analyst', 'Analyst']]) {
      assert.deepEqual(row(list, id), [id, name, 'specialist', id, 'exists', 'yes'], list.out)
    }
    assert.match(list.out, /No problems found\./)

    // (4) npm run remove-agent: off the team, profile kept.
    const remove = await s.step('npm run remove-agent', removeAgent, {
      answers: [[QA.which, 'analyst'], [QA.remove('Analyst'), 'y'], [QA.deleteProfile('analyst'), 'n']],
      extra: agentDeps,
    })
    assert.equal(remove.code, 0, remove.out)
    assert.deepEqual(rosterIds(w), ['coder', 'writer'])
    assert.ok(state(w).profiles.analyst, 'the analyst profile is kept')
    assert.match(remove.out, /hermes profile delete analyst/)

    // (5) npm run agents: coder and writer only.
    const again = await s.step('npm run agents', listAgents, { extra: agentDeps })
    assert.equal(again.code, 0, again.out)
    assert.ok(row(again, 'coder') && row(again, 'writer'))
    assert.equal(row(again, 'analyst'), undefined)
    assert.match(again.out, /The team \(2 agents\):/)
  } finally {
    if (process.env.VENOM_JOURNEY_TRANSCRIPT) writeFileSync(process.env.VENOM_JOURNEY_TRANSCRIPT, s.transcript())
  }
})

// ------------------------------------------------------------- later setup runs

test('a later setup keeps what is on the team list when Enter is pressed: starters on it, the Claude Code bridge', SKIP, async () => {
  const w = world()
  const claudeExe = join(w.dir, 'claude-bin', 'claude.exe')
  mkdirSync(dirname(claudeExe), { recursive: true })
  writeFileSync(claudeExe, '')
  const claude = BRIDGE_AGENTS.find((b) => b.id === 'claude')
  const kept = STARTER_AGENTS.filter((a) => ['coder', 'writer'].includes(a.id)).map((a) => ({ ...a }))
  writeFileSync(w.roster, JSON.stringify({ agents: [...kept, { ...claude }] }, null, 2))
  const s = session(w, { TEAM_CLAUDE_EXE: claudeExe })
  const modes = { researcher: 'offer', coder: 'keep', operator: 'offer', writer: 'keep' }
  const r = await setup(s, w, [...STARTER_AGENTS.map((a) => [Q.agent(a, modes[a.id]), '']), [Q.bridge(claude, true), '']])
  assert.equal(r.code, 0, r.out)
  assert.match(Q.agent(STARTER_AGENTS[0], 'offer'), /Add it\? \(y\/N\)$/)
  assert.match(Q.agent(STARTER_AGENTS[1], 'keep'), /Keep it on the team\? \(Y\/n\)$/)
  assert.match(Q.bridge(claude, true), /^Keep Claude Code as an agent .*\(Y\/n\)$/)
  assert.deepEqual(rosterIds(w), ['coder', 'writer', 'claude'])
  assert.deepEqual(profiles(w), ['coder', 'venom', 'writer'])
  assert.match(r.out, /^ {2}Team: Coder, Writer, Claude Code$/m)
})

test('a later setup: a starter not on the team list is added on y; the bridge goes on n', SKIP, async () => {
  const w = world()
  const claudeExe = join(w.dir, 'claude-bin', 'claude.exe')
  mkdirSync(dirname(claudeExe), { recursive: true })
  writeFileSync(claudeExe, '')
  const claude = BRIDGE_AGENTS.find((b) => b.id === 'claude')
  writeFileSync(w.roster, JSON.stringify({ agents: [{ ...STARTER_AGENTS[1] }, { ...claude }] }, null, 2))
  const s = session(w, { TEAM_CLAUDE_EXE: claudeExe })
  const answers = { researcher: ['offer', 'y'], coder: ['keep', ''], operator: ['offer', ''], writer: ['offer', ''] }
  const r = await setup(s, w, [...STARTER_AGENTS.map((a) => [Q.agent(a, answers[a.id][0]), answers[a.id][1]]), [Q.bridge(claude, true), 'n']])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(rosterIds(w), ['researcher', 'coder'])
})

test('a later setup keeping an invalid team list: the summary says it was left as it is, no Team line that contradicts it', SKIP, async () => {
  const w = world()
  const bad = readFileSync(join(ROOT, 'test', 'fixtures', 'rosters', 'invalid-bad-id.json'), 'utf8')
  writeFileSync(w.roster, bad)
  const s = session(w)
  const r = await setup(s, w, [...STARTER_AGENTS.map((a) => [Q.agent(a), a.id === 'coder' ? '' : 'n']), [Q.replaceRoster, '']])
  assert.equal(r.code, 0, r.out)
  assert.equal(readFileSync(w.roster, 'utf8'), bad, 'the file is untouched')
  assert.match(r.out, /^ {2}Team: the team list was left as it is; it needs fixing before Venom OS starts$/m)
  assert.doesNotMatch(r.out, /^ {2}Team: Coder/m)
  assert.match(r.out, /Team list: .*\(not changed: fix it before starting Venom OS\)/)
})
