// The team roster as data (hermes-mcp/roster.mjs): fixture rosters under
// test/fixtures/rosters load or fail by the rules, with sentences that name
// the entry. Nothing here reads a real venom.agents.json: every call names a
// fixture or a temp file, and child processes get VENOM_ROSTER_FILE.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  agentIds,
  BRIDGE_AGENTS,
  BRIDGE_IDS,
  ID_PATTERN,
  KINDS,
  loadRoster,
  MAX_TESTED_AGENTS,
  pinnedIds,
  profileIds,
  profileOf,
  projectDirs,
  publicRoster,
  RESERVED_IDS,
  ROSTER_FILE_NAME,
  RosterError,
  rosterLines,
  rosterPath,
  saveRoster,
  STARTER_AGENTS,
  validateRoster,
} from '../hermes-mcp/roster.mjs'
import { teamPrompt } from '../bridge/team-prompt.mjs'

const FIX = fileURLToPath(new URL('./fixtures/rosters/', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const fixture = (name) => join(FIX, name)
const read = (name) => JSON.parse(readFileSync(fixture(name), 'utf8'))

let tmp
let projects
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'venom-roster-'))
  projects = join(tmp, 'Projects')
  // twelve.json's project lead names its folder relatively: it lives under PROJECTS_ROOT.
  mkdirSync(join(projects, 'myapp'), { recursive: true })
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const load = (name) => loadRoster({ file: fixture(name), env: { PROJECTS_ROOT: projects } })

// ------------------------------------------------------------ the rules

test('constants follow the contract', () => {
  assert.equal(ROSTER_FILE_NAME, 'venom.agents.json')
  assert.equal(MAX_TESTED_AGENTS, 12)
  assert.deepEqual(KINDS, ['specialist', 'project', 'advisor'])
  assert.deepEqual(BRIDGE_IDS, ['claude', 'gemini'])
  for (const id of RESERVED_IDS) assert.ok(ID_PATTERN.test(id), id)
  assert.deepEqual(agentIds(STARTER_AGENTS), ['researcher', 'coder', 'operator', 'writer'])
  assert.deepEqual(pinnedIds(STARTER_AGENTS), ['researcher', 'coder'])
  assert.deepEqual(agentIds(BRIDGE_AGENTS), BRIDGE_IDS)
  assert.ok(validateRoster({ agents: [...STARTER_AGENTS, ...BRIDGE_AGENTS] }).ok)
})

test('every valid fixture loads, in file order, with derived maps that follow the entries', () => {
  for (const [name, n] of [['one.json', 1], ['five.json', 5], ['twelve.json', 12]]) {
    const r = load(name)
    assert.equal(r.source, 'file', name)
    assert.equal(r.agents.length, n, name)
    assert.deepEqual(agentIds(r.agents), read(name).agents.map((a) => a.id), name)
    assert.equal(rosterLines(r.agents).split('\n').length, n, name)
    for (const [i, line] of rosterLines(r.agents).split('\n').entries()) assert.equal(line, `- ${r.agents[i].id}: ${r.agents[i].role}`)
    assert.deepEqual(r.warnings, [], name)
    const pub = publicRoster(r.agents)
    assert.deepEqual(pub.map((a) => Object.keys(a).sort()), pub.map(() => ['id', 'kind', 'name', 'pinned', 'role']))
    for (const a of pub) assert.equal(typeof a.pinned, 'boolean')
    assert.deepEqual(pub.filter((a) => a.pinned).map((a) => a.id), pinnedIds(r.agents))
  }
  const twelve = load('twelve.json').agents
  assert.deepEqual(projectDirs(twelve, projects), { myapp: resolve(projects, 'myapp') })
  assert.deepEqual(profileIds(twelve), { myapp: 'my-app' })
  assert.equal(profileOf(twelve.find((a) => a.id === 'myapp')), 'my-app')
  assert.equal(profileOf(twelve[0]), twelve[0].id)
  assert.deepEqual(pinnedIds(twelve), ['researcher', 'coder', 'myapp'])
  for (const id of BRIDGE_IDS) assert.ok(agentIds(twelve).includes(id))
  assert.deepEqual(projectDirs(load('five.json').agents, projects), {})
  assert.deepEqual(profileIds(load('one.json').agents), {})
})

test('project folders: absolute, ~/ and relative; a folder that does not exist fails', () => {
  const lead = (folder) => ({ agents: [{ id: 'lead', name: 'Lead', kind: 'project', role: 'Leads one project.', folder }] })
  const opts = { projectsRoot: projects, home: tmp }
  assert.ok(validateRoster(lead(join(projects, 'myapp')), opts).ok)
  assert.ok(validateRoster(lead('~/Projects/myapp'), opts).ok)
  assert.ok(validateRoster(lead('myapp'), opts).ok)
  const r = validateRoster(lead('nowhere'), opts)
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /^Agent 1 \("lead"\) .*"nowhere", which does not exist/)
  // Only project leads have a folder.
  const odd = validateRoster({ agents: [{ id: 'helper', name: 'Helper', kind: 'specialist', role: 'r', folder: 'myapp' }] }, opts)
  assert.match(odd.errors.join('\n'), /Agent 1 \("helper"\) .*not a project lead/)
  // exists is injectable.
  assert.ok(validateRoster(lead('anything'), { projectsRoot: projects, exists: () => true }).ok)
})

const INVALID = {
  'invalid-bad-id.json': /^Agent 5 \("Bad Id"\) in invalid-bad-id\.json has the id "Bad Id", which is not allowed\./,
  'invalid-duplicate-id.json': /^Agent 5 \("coder"\) in .*uses the id "coder" again \(agent 2 has it\)/,
  'invalid-duplicate-name.json': /^Agent 5 \("analyst"\) in .*uses the name "WRITER" again \(agent 4 has it\)/,
  'invalid-unknown-kind.json': /^Agent 5 \("analyst"\) in .*has the kind "boss"\. Set "kind" to "specialist", "project" or "advisor"\./,
  'invalid-project-without-folder.json': /^Agent 5 \("myapp"\) in .*is a project lead but has no "folder"\./,
  'invalid-missing-role.json': /^Agent 5 \("analyst"\) in invalid-missing-role\.json has no role\. Add a one-line "role" that says what it is for\.$/m,
  'invalid-empty.json': /The "agents" list in invalid-empty\.json is empty\./,
  'invalid-broken.json': /invalid-broken\.json is not valid JSON/,
}

test('every invalid fixture fails with a sentence that names the entry and says how to fix it', () => {
  const names = readdirSync(FIX).filter((f) => f.startsWith('invalid-'))
  assert.deepEqual(names.sort(), Object.keys(INVALID).sort(), 'every invalid fixture has an expectation')
  for (const [name, pattern] of Object.entries(INVALID)) {
    let err
    assert.throws(() => load(name), (e) => ((err = e), e instanceof RosterError), name)
    assert.match(err.message, pattern, name)
    assert.match(err.message, /npm run agents/, name)
    assert.ok(err.errors.length >= 1, name)
    for (const s of err.errors) {
      assert.ok(!s.includes('\n'), `one sentence per line: ${s}`)
      if (!/empty|not valid JSON/.test(s)) assert.match(s, /^Agent \d+ /, name)
    }
  }
})

test('more rules: reserved ids, line breaks, lengths, profile, pinned, not an object', () => {
  const one = (extra) => validateRoster({ agents: [{ id: 'helper', name: 'Helper', kind: 'specialist', role: 'Does jobs.', ...extra }] })
  assert.match(one({ id: 'test' }).errors[0], /reserved/)
  assert.match(one({ role: 'two\nlines' }).errors[0], /line break in its role/)
  assert.match(one({ role: 'x'.repeat(401) }).errors[0], /longer than 400/)
  assert.ok(one({ role: 'x'.repeat(400) }).ok)
  assert.match(one({ name: 'n'.repeat(41) }).errors[0], /longer than 40/)
  assert.match(one({ name: '' }).errors[0], /has no name/)
  assert.match(one({ profile: 'Bad Profile' }).errors[0], /not a Hermes profile name/)
  assert.match(one({ pinned: 'yes' }).errors[0], /true or false/)
  assert.match(one({ kind: undefined }).errors[0], /has no "kind"/)
  assert.match(one({ extra: 1 }).warnings[0], /unknown field "extra"; it is ignored/)
  assert.equal(one({ extra: 1 }).agents[0].extra, undefined)
  assert.match(validateRoster([]).errors[0], /must hold an object with an "agents" list/)
  assert.match(validateRoster({ agents: ['x'] }).errors[0], /^Agent 1 in venom\.agents\.json is not an agent entry/)
  assert.equal(validateRoster({ agents: [{ id: 'a' }] }).ok, false) // one-letter id
})

test('more than MAX_TESTED_AGENTS agents warns, never fails', () => {
  const agents = Array.from({ length: 14 }, (_, i) => ({ id: `agent${String.fromCharCode(97 + i)}`, name: `Agent ${String.fromCharCode(65 + i)}`, kind: 'specialist', role: 'Does jobs.' }))
  const r = validateRoster({ agents })
  assert.equal(r.ok, true)
  assert.match(r.warnings.join('\n'), /lists 14 agents\. Up to 12 are tested/)
  assert.deepEqual(validateRoster({ agents: agents.slice(0, 12) }).warnings, [])
})

test('missing file: the starter set; VENOM_ROSTER_FILE names the file', () => {
  const r = loadRoster({ file: join(tmp, 'none.json') })
  assert.equal(r.source, 'starter')
  assert.deepEqual(agentIds(r.agents), ['researcher', 'coder', 'operator', 'writer'])
  r.agents[0].name = 'changed'
  assert.equal(STARTER_AGENTS[0].name, 'Researcher', 'callers get copies')
  assert.equal(loadRoster({ env: { VENOM_ROSTER_FILE: join(tmp, 'none.json') } }).source, 'starter')
  assert.equal(rosterPath({ VENOM_ROSTER_FILE: fixture('one.json') }), resolve(fixture('one.json')))
  assert.equal(rosterPath({}), join(ROOT, 'venom.agents.json'))
  // An unreadable file is an error, not the starter set.
  assert.throws(() => loadRoster({ file: 'x.json', readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }), /cannot be read \(EACCES\)/)
})

test('the shipped example is the starter set and valid', () => {
  const ex = JSON.parse(readFileSync(join(ROOT, 'venom.agents.example.json'), 'utf8'))
  assert.deepEqual(ex.agents, STARTER_AGENTS.map((a) => ({ ...a })))
  assert.ok(validateRoster(ex).ok)
})

test('saveRoster: round-trips as pretty JSON through a temp file, refuses invalid data', () => {
  const file = join(tmp, 'saved', 'venom.agents.json')
  const agents = load('twelve.json').agents
  saveRoster(agents, { file, projectsRoot: projects })
  const text = readFileSync(file, 'utf8')
  assert.ok(text.endsWith('}\n'))
  assert.match(text, /^\{\n {2}"agents": \[\n {4}\{/)
  assert.deepEqual(loadRoster({ file, env: { PROJECTS_ROOT: projects } }).agents, agents)
  assert.deepEqual(readdirSync(join(tmp, 'saved')), ['venom.agents.json'], 'no temp file left')

  const before = readFileSync(file, 'utf8')
  for (const bad of [[], [{ ...agents[0], role: '' }], [agents[0], agents[0]]]) {
    assert.throws(() => saveRoster(bad, { file }), RosterError)
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'an invalid roster is never written')

  // A failed write leaves the old file and no temp file.
  assert.throws(() => saveRoster(agents.slice(0, 2), { file, projectsRoot: projects, rename: () => { throw new Error('disk full') } }), /disk full/)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.deepEqual(readdirSync(join(tmp, 'saved')), ['venom.agents.json'])
})

// ------------------------------------------------------------ the prompt

test('teamPrompt names exactly the agents present; the bridge paragraphs only with their bridge', () => {
  for (const name of ['one.json', 'five.json', 'twelve.json']) {
    const agents = load(name).agents
    const p = teamPrompt(agents)
    for (const a of agents) assert.ok(p.includes(`  - ${a.id} (${a.name}): ${a.role}\n`), `${name}: ${a.id}`)
    assert.equal((p.match(/^ {2}- /gm) || []).length, agents.length, name)
    const has = (id) => agents.some((a) => a.id === id)
    assert.equal(/Antigravity, read-only/.test(p), has('gemini'), name)
    assert.equal(/session line/.test(p), has('claude'), name)
    assert.equal(/\bgemini\b/.test(p), has('gemini'), name)
    assert.equal(/Claude Code/.test(p), has('claude'), name)
    assert.match(p, /^Your team:\n- You are the supervisor of specialist agents, reached with `ask_agent`:\n/)
    assert.match(p, /- "Show me what the team is doing" is answered by the dock: one short sentence\n {2}pointing to it, no blade\.\n\n$/)
  }
  const only = (id) => teamPrompt([...STARTER_AGENTS, BRIDGE_AGENTS.find((a) => a.id === id)])
  assert.match(only('gemini'), /Gemini is optional: if it is not installed/)
  assert.match(only('claude'), /Claude Code is optional: if it is not installed/)
  assert.match(teamPrompt([...STARTER_AGENTS, ...BRIDGE_AGENTS]), /Gemini and Claude Code are optional/)
})

// ------------------------------------------------------------ the programs

const childEnv = (rosterFile) => ({
  ...process.env,
  VENOM_ROSTER_FILE: rosterFile,
  PROJECTS_ROOT: projects,
  VENOM_AGENTS_DIR: join(tmp, 'agents'),
  VENOM_AGENT_ACTIVITY: '0',
})

test('connector: the ask_agent enum and description list every agent of the roster', async () => {
  for (const name of ['one.json', 'twelve.json']) {
    const agents = load(name).agents
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'hermes-mcp', 'server.mjs')],
      env: childEnv(fixture(name)),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'roster-test', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      const ask = tools.find((t) => t.name === 'ask_agent')
      assert.deepEqual(ask.inputSchema.properties.agent.enum, agentIds(agents), name)
      assert.ok(ask.description.includes(`\n${rosterLines(agents)}\n`), name)
    } finally {
      await client.close()
    }
  }
})

test('an invalid roster stops the connector, the bridge and log-run with the sentences, not a stack trace', () => {
  const programs = [
    [join(ROOT, 'hermes-mcp', 'server.mjs')],
    [join(ROOT, 'bridge', 'server.mjs')],
    [join(ROOT, 'scripts', 'log-run.mjs'), '--agent', 'coder', '--task', 't', '--summary', 's', '--ended', '2026-11-10T11:17:00+04:00'],
  ]
  for (const args of programs) {
    const r = spawnSync(process.execPath, args, {
      env: { ...childEnv(fixture('invalid-missing-role.json')), VENOM_BRIDGE_PORT: '0', VENOM_MCP_SERVERS: '', VENOM_LOCAL_STT: '0', VENOM_MEMORY: '0', VENOM_HONCHO: '0' },
      encoding: 'utf8',
      timeout: 30_000,
      input: '',
    })
    assert.equal(r.status, 1, `${args[0]}: ${r.stderr}`)
    assert.match(r.stderr, /Agent 5 \("analyst"\) in invalid-missing-role\.json has no role\./, args[0])
    assert.match(r.stderr, /npm run agents/)
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace')
  }
  assert.ok(!existsSync(join(tmp, 'agents', 'activity.jsonl')))
})

test('a roster over the tested size starts anyway, with the warning on stderr', () => {
  const file = join(tmp, 'big.json')
  const agents = Array.from({ length: 13 }, (_, i) => ({ id: `agent${String.fromCharCode(97 + i)}`, name: `Agent ${String.fromCharCode(65 + i)}`, kind: 'specialist', role: 'Does jobs.' }))
  writeFileSync(file, JSON.stringify({ agents }))
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'log-run.mjs'), '--agent', 'agentm', '--task', 't', '--summary', 's', '--ended', new Date(Date.now() - 3_600_000).toISOString()], {
    env: { ...childEnv(file), VENOM_AGENT_ACTIVITY: '1' },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /lists 13 agents/)
  assert.match(r.stdout, /for agentm/)
})
