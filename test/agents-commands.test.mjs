// The team commands (scripts/agents-lib.mjs): `npm run add-agent`,
// `npm run agents` and `npm run remove-agent`.
//
// Nothing here touches the repository's own venom.agents.json or
// venom.config.json, or a real Hermes: every roster and config path is a
// temp file passed in explicitly, and every hermes command goes to
// scripts/fake-hermes.mjs with its state in a temp folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STARTER_AGENTS } from '../hermes-mcp/roster.mjs'
import { Q, addAgent, deriveId, listAgents, removeAgent, roleLine } from '../scripts/agents-lib.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = join(ROOT, 'scripts', 'fake-hermes.mjs')

/** A temp world: fake Hermes state, a roster path, a config, a home and a projects folder. */
function world({ config = { supervisorProfile: 'venom', brain: { model: 'fake-brain' }, worker: { model: 'fake-worker' } }, supervisor = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'venom-agents-'))
  const w = {
    dir,
    state: join(dir, 'state'),
    roster: join(dir, 'venom.agents.json'),
    configFile: join(dir, 'venom.config.json'),
    home: join(dir, 'home'),
    projects: join(dir, 'projects'),
  }
  for (const d of [w.state, w.home, w.projects]) mkdirSync(d, { recursive: true })
  if (config) writeFileSync(w.configFile, JSON.stringify(config, null, 2))
  if (supervisor) {
    fake(w, ['profile', 'create', 'venom'])
    fake(w, ['-p', 'venom', 'config', 'set', 'model.default', 'fake-model'])
    fake(w, ['-p', 'venom', 'mcp', 'add', 'team', '--command', 'node', '--args', 'server.mjs'])
  }
  return w
}

const fake = (w, args, extra = {}) => spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', env: { ...process.env, FAKE_HERMES_STATE: w.state, ...extra } })
const hermesState = (w) => JSON.parse(readFileSync(join(w.state, 'state.json'), 'utf8'))
const calls = (w) => readFileSync(join(w.state, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const roster = (w) => JSON.parse(readFileSync(w.roster, 'utf8')).agents
const writeRoster = (w, agents) => writeFileSync(w.roster, JSON.stringify({ agents }, null, 2))
const soulOf = (w, p) => join(w.state, 'profiles', p, 'SOUL.md')
/** A profile that exists, has a model and an old job brief. */
function makeProfile(w, p, brief = 'old brief\n') {
  fake(w, ['profile', 'create', p])
  fake(w, ['-p', p, 'config', 'set', 'model.default', 'fake-model'])
  writeFileSync(soulOf(w, p), brief)
}
const entry = (id, name = id[0].toUpperCase() + id.slice(1), extra = {}) => ({ id, name, kind: 'specialist', role: `The ${name} agent.`, ...extra })

/**
 * Run one command. `answers` is a list of [question prefix or RegExp, answer];
 * when it runs out, every further question gets '' (as at the end of input).
 */
async function drive(w, fn, { answers = [], hermesEnv = {}, ...extra } = {}) {
  const log = []
  const asked = []
  const queue = [...answers]
  const deps = {
    log: (l) => log.push(l),
    async ask(q) {
      asked.push(q)
      const next = queue.shift()
      if (!next) return ''
      const [m, a] = next
      const ok = typeof m === 'string' ? q.startsWith(m) : m.test(q)
      if (!ok) throw new Error(`expected the question ${m}, got: ${q}`)
      return a
    },
    async run(cmd, args) {
      assert.equal(cmd, FAKE, 'only the fake Hermes may run')
      const r = fake(w, args, hermesEnv)
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    },
    env: { HERMES_EXE: FAKE, VENOM_ROSTER_FILE: w.roster, PROJECTS_ROOT: w.projects },
    platform: process.platform,
    repoRoot: ROOT,
    homedir: w.home,
    rosterFile: w.roster,
    configFile: w.configFile,
    exists: (p) => existsSync(p),
    which: () => '',
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, t) => writeFileSync(p, t),
    copyFile: (a, b) => copyFileSync(a, b),
    now: () => new Date(2026, 0, 2, 3, 4, 5),
    ...extra,
  }
  const code = await fn(deps)
  return { code, out: log.join('\n'), log, asked, left: queue.length }
}

const addAnswers = (name, job = 'Reads reports and explains the numbers plainly.', kind = '1', more = []) => [
  [Q.name, name],
  [Q.job, job],
  [Q.kind, kind],
  ...more,
]

test('deriveId and roleLine', () => {
  assert.equal(deriveId('Shop Site Lead!'), 'shop-site-lead')
  assert.equal(deriveId('  Ünïcode -- Agent  '), 'n-code-agent')
  assert.equal(deriveId('42 Things'), '')
  assert.equal(deriveId('X'), '')
  assert.equal(deriveId('a'.repeat(40)), 'a'.repeat(32))
  assert.equal(roleLine('  one   two\n three. '), 'one two three.')
  const long = roleLine(`${'First sentence here. '.repeat(30)}`)
  assert.ok(long.length <= 400 && long.endsWith('.'))
  assert.equal(roleLine('Builds it.', { name: 'Lead', folder: 'shop' }), 'Lead, project lead for the code in shop: Builds it.')
})

test('add a specialist: profile from the supervisor, job brief, roster line, READY', async (t) => {
  const w = world()
  const r = await drive(w, addAgent, { answers: addAnswers('Analyst', 'Reads   reports and\texplains the numbers plainly.  Never guesses.') })
  t.diagnostic(r.out)
  assert.equal(r.code, 0, r.out)
  const agents = roster(w)
  assert.deepEqual(agents.map((a) => a.id), [...STARTER_AGENTS.map((a) => a.id), 'analyst'])
  const a = agents.at(-1)
  assert.deepEqual(a, { id: 'analyst', name: 'Analyst', kind: 'specialist', role: 'Reads reports and explains the numbers plainly. Never guesses.' })
  const p = hermesState(w).profiles.analyst
  assert.equal(p.clonedFrom, 'venom')
  assert.equal(p.description, a.role)
  assert.equal(p.mcp.team, undefined, 'the copied team connector is removed')
  const soul = readFileSync(soulOf(w, 'analyst'), 'utf8')
  assert.match(soul, /## Your job: Analyst\r?\nReads reports and explains the numbers plainly\. Never guesses\.\r?\n\r?\n## Saving work/)
  assert.match(soul, /You run on fake-brain/)
  assert.match(soul, /running on fake-worker/)
  assert.doesNotMatch(soul, /\{\{/)
  assert.ok(calls(w).some((c) => c.join(' ') === `profile create analyst --clone-from venom --description ${a.role}`))
  assert.match(r.out, /Its id is "analyst"/)
  assert.match(r.out, /hermes -p analyst model/)
  assert.match(r.out, /\[pass\] Analyst answered: READY/)
  assert.match(r.out, /starter agents plus the new one/)
  assert.doesNotMatch(r.out, /API key (is|:)/)
  assert.match(r.log.at(-1), /^Restart Venom OS \(close it and run `npm start`\)/)
})

test('add a project lead: a bad folder is asked again, the brief names the folder', async () => {
  const w = world({ config: null })
  mkdirSync(join(w.projects, 'shop-site'))
  const r = await drive(w, addAgent, {
    answers: addAnswers('Shop Site Lead', 'Looks after the shop website code.', '2', [
      [/^Which folder\?/, 'no-such-folder'],
      [/^Which folder\?/, 'shop-site'],
    ]),
    noAlias: true,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /There is no folder at .*no-such-folder/)
  const a = roster(w).at(-1)
  assert.equal(a.id, 'shop-site-lead')
  assert.equal(a.kind, 'project')
  assert.equal(a.folder, 'shop-site')
  assert.equal(a.role, 'Shop Site Lead, project lead for the code in shop-site: Looks after the shop website code.')
  assert.equal(hermesState(w).profiles['shop-site-lead'].noAlias, true)
  const soul = readFileSync(soulOf(w, 'shop-site-lead'), 'utf8')
  assert.match(soul, /## Your project folder/)
  assert.match(soul, /`shop-site`/)
  assert.match(soul, /go-ahead/)
  assert.match(soul, /You run on the model chosen at setup/, 'no config: a neutral phrase')
})

test('a project folder that is wrong 3 times stops without changing anything', async () => {
  const w = world()
  const bad = [/^Which folder\?/, 'nope']
  const r = await drive(w, addAgent, { answers: addAnswers('Lead', 'Leads.', '2', [bad, bad, bad]) })
  assert.equal(r.code, 1)
  assert.match(r.out, /Nothing was changed/)
  assert.equal(existsSync(w.roster), false)
  assert.equal(hermesState(w).profiles.lead, undefined)
})

test('adding the same name twice is refused and nothing is duplicated', async () => {
  const w = world()
  assert.equal((await drive(w, addAgent, { answers: addAnswers('Analyst') })).code, 0)
  const before = readFileSync(w.roster, 'utf8')
  const r = await drive(w, addAgent, { answers: [[Q.name, 'analyst']] })
  assert.equal(r.code, 1)
  assert.match(r.out, /There is already an agent called Analyst/)
  assert.equal(readFileSync(w.roster, 'utf8'), before)
  assert.equal(roster(w).filter((a) => a.id === 'analyst').length, 1)
})

test('a name whose id belongs to another agent: no keeps everything, yes replaces entry and brief', async () => {
  const w = world()
  writeRoster(w, [entry('coder'), entry('analyst', 'Number Cruncher', { pinned: true })])
  makeProfile(w, 'analyst')
  const before = readFileSync(w.roster, 'utf8')
  const no = await drive(w, addAgent, { answers: [...addAnswers('Analyst'), [Q.replace, '']] })
  assert.equal(no.code, 0)
  assert.match(no.out, /already belongs to Number Cruncher/)
  assert.equal(readFileSync(w.roster, 'utf8'), before)
  assert.equal(readFileSync(soulOf(w, 'analyst'), 'utf8'), 'old brief\n')

  const yes = await drive(w, addAgent, { answers: [...addAnswers('Analyst'), [Q.replace, 'y']] })
  assert.equal(yes.code, 0, yes.out)
  assert.deepEqual(roster(w).map((a) => a.name), ['Coder', 'Analyst'])
  assert.equal(roster(w)[1].pinned, true)
  const baks = readdirSync(join(w.state, 'profiles', 'analyst')).filter((f) => /^SOUL\.md\.bak-\d+-\d+$/.test(f))
  assert.equal(baks.length, 1)
  assert.equal(readFileSync(join(w.state, 'profiles', 'analyst', baks[0]), 'utf8'), 'old brief\n')
  assert.match(readFileSync(soulOf(w, 'analyst'), 'utf8'), /## Your job: Analyst/)
  assert.ok(!calls(w).some((c) => c[0] === 'profile' && c[1] === 'create' && c[2] === 'analyst' && c.includes('--clone-from')), 'the existing profile is not recreated')
})

test('reserved, bridge and supervisor ids are refused and another is asked', async () => {
  const w = world()
  const r = await drive(w, addAgent, {
    answers: [...addAnswers('Test'), [Q.id, 'claude'], [Q.id, 'venom'], [Q.id, 'tester']],
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /"test" cannot be used: it is reserved/)
  assert.match(r.out, /"claude" cannot be used: it is kept for the Claude Code bridge/)
  assert.match(r.out, /"venom" cannot be used: it is the name of the supervisor profile/)
  assert.equal(roster(w).at(-1).id, 'tester')
})

test('a Hermes profile that exists but is not on the team: keep, replace the brief, or cancel', async () => {
  const pick = (choice) => [...addAnswers('Helper'), [Q.existing, choice]]

  const keep = world()
  makeProfile(keep, 'helper')
  const k = await drive(keep, addAgent, { answers: pick('1') })
  assert.equal(k.code, 0, k.out)
  assert.equal(roster(keep).at(-1).id, 'helper')
  assert.equal(readFileSync(soulOf(keep, 'helper'), 'utf8'), 'old brief\n')
  assert.doesNotMatch(k.out, /carried over/, 'nothing was copied')

  const brief = world()
  makeProfile(brief, 'helper')
  const b = await drive(brief, addAgent, { answers: pick('2') })
  assert.equal(b.code, 0, b.out)
  assert.match(readFileSync(soulOf(brief, 'helper'), 'utf8'), /## Your job: Helper/)
  const bak = readdirSync(join(brief.state, 'profiles', 'helper')).find((f) => f.startsWith('SOUL.md.bak-'))
  assert.equal(readFileSync(join(brief.state, 'profiles', 'helper', bak), 'utf8'), 'old brief\n')

  const cancel = world()
  makeProfile(cancel, 'helper')
  const c = await drive(cancel, addAgent, { answers: pick('') })
  assert.equal(c.code, 0)
  assert.match(c.out, /Cancelled\. Nothing was changed\./)
  assert.equal(existsSync(cancel.roster), false)
  assert.equal(readFileSync(soulOf(cancel, 'helper'), 'utf8'), 'old brief\n')
})

test('READY fails: the agent is kept and the sign-in command is given', async () => {
  const w = world()
  const r = await drive(w, addAgent, { answers: addAnswers('Analyst'), hermesEnv: { FAKE_HERMES_FAIL: 'analyst' } })
  assert.equal(r.code, 0)
  assert.equal(roster(w).at(-1).id, 'analyst')
  assert.match(r.out, /\[fail\] Analyst did not answer/)
  assert.match(r.out, /Analyst stays on the team\. Sign it in with: hermes -p analyst model/)
})

test('no supervisor profile: run setup first, nothing changed', async () => {
  const w = world({ supervisor: false })
  const r = await drive(w, addAgent, { answers: addAnswers('Analyst') })
  assert.equal(r.code, 1)
  assert.match(r.out, /The supervisor profile venom does not exist yet.*npm run setup/)
  assert.equal(r.asked.length, 0)
  assert.equal(existsSync(w.roster), false)
})

test('an agent whose profile went missing can be rebuilt by adding its name again', async () => {
  const w = world()
  writeRoster(w, [entry('coder'), entry('ghost')])
  const r = await drive(w, addAgent, { answers: [[Q.name, 'Ghost'], [Q.recreate, 'y'], [Q.job, 'Haunts the logs.'], [Q.kind, '']] })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(roster(w).map((a) => a.id), ['coder', 'ghost'])
  assert.equal(roster(w)[1].role, 'Haunts the logs.')
  assert.ok(hermesState(w).profiles.ghost)
})

test('more than 12 agents: a warning, not a failure', async () => {
  const w = world()
  writeRoster(w, Array.from({ length: 12 }, (_, i) => entry(`agent-${String.fromCharCode(97 + i)}`)))
  const r = await drive(w, addAgent, { answers: addAnswers('Analyst') })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /The team now has 13 agents\. Up to 12 are tested/)
})

test('agents: the table with a missing profile, a bridge, a failing answer, and --quick', async (t) => {
  const w = world()
  writeRoster(w, [entry('researcher'), entry('ghost'), entry('mute'), { ...entry('claude', 'Claude Code'), role: 'The Claude Code bridge.' }])
  makeProfile(w, 'researcher')
  makeProfile(w, 'mute')
  const bridgeExe = { claude: FAKE, gemini: join(w.dir, 'no-agy.exe') }
  const r = await drive(w, listAgents, { bridgeExe, hermesEnv: { FAKE_HERMES_FAIL: 'mute' } })
  t.diagnostic(r.out)
  assert.equal(r.code, 0)
  const row = (id) => r.log.find((l) => l.startsWith(`  ${id} `))?.trim().split(/\s{2,}/)
  assert.deepEqual(row('researcher'), ['researcher', 'Researcher', 'specialist', 'researcher', 'exists', 'yes'])
  assert.deepEqual(row('ghost'), ['ghost', 'Ghost', 'specialist', 'ghost', 'missing', '-'])
  assert.deepEqual(row('mute'), ['mute', 'Mute', 'specialist', 'mute', 'exists', 'no'])
  assert.deepEqual(row('claude'), ['claude', 'Claude Code', 'specialist', 'Claude Code', 'installed', '-'])
  assert.match(r.out, /Ghost: its Hermes profile ghost is missing\. Create it with `npm run add-agent`.*`npm run remove-agent`/)
  assert.match(r.out, /Mute did not answer the test question\. Sign it in with: hermes -p mute model/)
  assert.match(r.out, /The team list is stored in /)
  const chats = calls(w).filter((c) => c.includes('chat')).map((c) => c[1])
  assert.deepEqual(chats, ['researcher', 'mute'], 'existing Hermes profiles only, bridges never')

  const before = calls(w).length
  const q = await drive(w, listAgents, { bridgeExe, quick: true })
  assert.equal(q.code, 0)
  assert.equal(calls(w).slice(before).filter((c) => c.includes('chat')).length, 0)
  assert.match(q.log.find((l) => l.startsWith('  researcher ')), /exists\s+-$/)
})

test('agents without a roster file says the starter team is in use', async () => {
  const w = world()
  const r = await drive(w, listAgents, { quick: true })
  assert.equal(r.code, 0)
  assert.match(r.out, /No team list file exists yet, so the starter team is in use/)
  assert.equal(existsSync(w.roster), false)
})

test('an invalid roster file: plain sentences and exit 1 for all three commands', async () => {
  const w = world()
  writeFileSync(w.roster, JSON.stringify({ agents: [{ id: 'X', name: 'Bad' }] }))
  const before = readFileSync(w.roster, 'utf8')
  for (const fn of [listAgents, addAgent, removeAgent]) {
    const r = await drive(w, fn, { target: 'x' })
    assert.equal(r.code, 1, fn.name)
    assert.match(r.out, /The team list cannot be used:/)
    assert.match(r.out, /has the id "X", which is not allowed/)
    assert.match(r.out, /Nothing was changed/)
  }
  assert.equal(readFileSync(w.roster, 'utf8'), before)
})

test('remove: an unknown agent changes nothing', async () => {
  const w = world()
  const r = await drive(w, removeAgent, { answers: [[Q.which, 'nobody']] })
  assert.equal(r.code, 1)
  assert.match(r.out, /There is no agent "nobody" on the team\. Nothing was changed\./)
  assert.equal(existsSync(w.roster), false)
})

test('remove: the last agent is refused', async () => {
  const w = world()
  writeRoster(w, [entry('coder')])
  const r = await drive(w, removeAgent, { target: 'coder' })
  assert.equal(r.code, 1)
  assert.match(r.out, /only agent on the team/)
  assert.equal(roster(w).length, 1)
})

test('remove from the starter team, keeping the Hermes profile', async () => {
  const w = world()
  makeProfile(w, 'writer')
  const r = await drive(w, removeAgent, { answers: [[Q.which, 'Writer'], [Q.remove('Writer'), 'y'], [Q.deleteProfile('writer'), '']] })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(roster(w).map((a) => a.id), ['researcher', 'coder', 'operator'])
  assert.ok(hermesState(w).profiles.writer, 'the profile is kept')
  assert.match(r.out, /remaining starter agents/)
  assert.match(r.out, /hermes profile delete writer/)
  assert.match(r.log.at(-1), /^Restart Venom OS/)
})

test('remove and delete the Hermes profile', async () => {
  const w = world()
  writeRoster(w, [entry('coder'), entry('writer')])
  makeProfile(w, 'writer')
  const r = await drive(w, removeAgent, { target: 'writer', answers: [[Q.remove('Writer'), 'y'], [Q.deleteProfile('writer'), 'y']] })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(roster(w).map((a) => a.id), ['coder'])
  assert.equal(hermesState(w).profiles.writer, undefined)
  assert.ok(calls(w).some((c) => c.join(' ') === 'profile delete writer --yes'))
  assert.match(r.out, /Deleted the Hermes profile writer/)
})

test('remove: saying no changes nothing; a missing profile is not offered for deletion', async () => {
  const w = world()
  writeRoster(w, [entry('coder'), entry('ghost')])
  const before = readFileSync(w.roster, 'utf8')
  const no = await drive(w, removeAgent, { target: 'ghost', answers: [[Q.remove('Ghost'), 'n']] })
  assert.equal(no.code, 0)
  assert.equal(readFileSync(w.roster, 'utf8'), before)
  const r = await drive(w, removeAgent, { target: 'ghost', answers: [[Q.remove('Ghost'), 'y']] })
  assert.equal(r.code, 0)
  assert.ok(!r.asked.some((q) => q.startsWith('Also delete')))
  assert.deepEqual(roster(w).map((a) => a.id), ['coder'])
})

test('the three commands refuse to run through a pipe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-agents-pipe-'))
  for (const script of ['add-agent.mjs', 'agents.mjs', 'remove-agent.mjs']) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, HERMES_EXE: join(dir, 'no-hermes.exe'), VENOM_ROSTER_FILE: join(dir, 'venom.agents.json'), FAKE_HERMES_STATE: join(dir, 'state') },
    })
    assert.equal(r.status, 1, script)
    assert.match(r.stdout, /run it in a terminal window|meant for a terminal window/, script)
    assert.equal(r.stdout.trim().split('\n').length, 1, script)
  }
})
