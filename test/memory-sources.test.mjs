// GET /memory/sources, the logic (bridge/memorysources.mjs): one row per
// memory source, status and counts only. Every folder is a temp dir passed in
// through env; the Honcho layer is a fake object, so nothing reaches the
// network and nothing real is read.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countEntries,
  hermesRoot,
  memorySources,
  resetMemorySourcesCache,
  SOURCE_IDS,
  vaultRow,
} from '../bridge/memorysources.mjs'

const MARK = 'ZZ-SECRET-MARKER-7731'
const LABELS = ['Honcho', 'Hermes notes', 'Agent skills', 'Obsidian vault', 'Knowledge graph', 'Conversation log']

const dirs = []
afterEach(() => {
  resetMemorySourcesCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const put = (path, body) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body, 'utf8')
}

/** A full fixture: notes, skills (root + 2 profiles), vault, graph, log. */
function fixture({ notes = true, skills = true, vault = true, graph = 'ok', log = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'venom-memsrc-'))
  dirs.push(root)
  const env = {
    VENOM_HERMES_MEMORY_DIR: join(root, 'hermes', 'memories'),
    VENOM_MEMORY_DIR: join(root, 'venom-memory'),
    VENOM_HERMES_ROOT: join(root, 'hermes'),
    VENOM_VAULT_DIR: join(root, 'vault'),
    VENOM_GRAPH_FILE: join(root, 'graph', 'graph.json'),
  }
  if (notes) {
    put(join(env.VENOM_HERMES_MEMORY_DIR, 'MEMORY.md'), `first ${MARK}\r\n§\r\nsecond\r\n§\r\n\r\n§\r\nthird`)
    put(join(env.VENOM_HERMES_MEMORY_DIR, 'USER.md'), `Name: ${MARK}\n§\nLives in Spain`)
  }
  if (skills) {
    const s = join(env.VENOM_HERMES_ROOT, 'skills')
    put(join(s, 'a', 'SKILL.md'), MARK)
    put(join(s, 'cat', 'b', 'SKILL.md'), MARK)
    put(join(s, 'cat', 'c', 'SKILL.md'), MARK)
    put(join(s, '.hidden', 'd', 'SKILL.md'), MARK) // skipped
    put(join(s, '1', '2', '3', '4', '5', '6', 'SKILL.md'), MARK) // too deep
    put(join(env.VENOM_HERMES_ROOT, 'profiles', 'venom', 'skills', 'x', 'SKILL.md'), MARK)
    put(join(env.VENOM_HERMES_ROOT, 'profiles', 'venom', 'skills', 'y', 'SKILL.md'), MARK)
    put(join(env.VENOM_HERMES_ROOT, 'profiles', 'work', 'skills', 'z', 'SKILL.md'), MARK)
    mkdirSync(join(env.VENOM_HERMES_ROOT, 'profiles', 'empty', 'skills'), { recursive: true })
  }
  if (vault) {
    put(join(env.VENOM_VAULT_DIR, 'Home.md'), `# Home ${MARK}`)
    put(join(env.VENOM_VAULT_DIR, 'Projects.md'), MARK)
    put(join(env.VENOM_VAULT_DIR, 'image.png'), MARK)
    put(join(env.VENOM_VAULT_DIR, 'sub', 'Deep.md'), MARK)
  }
  if (graph === 'ok') put(env.VENOM_GRAPH_FILE, JSON.stringify({ nodes: [{ id: MARK }, { id: 'b' }, { id: 'c' }], links: [] }))
  if (graph === 'bad') put(env.VENOM_GRAPH_FILE, `{ "nodes": [ ${MARK}`)
  if (log) {
    const c = join(env.VENOM_MEMORY_DIR, 'conversations')
    put(join(c, '2026-11-13.jsonl'), `{"q":"${MARK}"}\n{"q":"b"}\n\n`)
    put(join(c, '2026-11-14.jsonl'), `{"q":"c"}\n`)
    put(join(c, 'notes.txt'), `${MARK}\n`)
  }
  return { root, env }
}

function fakeLong({ ok = true, enabled = true, ...status } = {}) {
  const long = {
    enabled,
    checks: 0,
    async check() {
      long.checks++
      return { ok, ms: 2 }
    },
    status: () => ({
      provider: 'honcho',
      label: 'Honcho',
      state: ok ? 'ok' : 'offline',
      queued: 0,
      held: 0,
      sent: 0,
      dropped: 0,
      lastOkAt: null,
      lastError: `boom ${MARK} hch_secretkey`,
      writeFault: false,
      lastStatus: 0,
      ...status,
    }),
  }
  return long
}

const rowOf = (res, id) => res.rows.find((r) => r.id === id)

function assertClean(res, root) {
  assert.deepEqual(res.rows.map((r) => r.id), SOURCE_IDS)
  assert.deepEqual(res.rows.map((r) => r.label), LABELS)
  const json = JSON.stringify(res)
  assert.ok(!json.includes(MARK), 'no file content or error text leaks')
  assert.ok(!json.includes('hch_secretkey'))
  for (const p of [root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\'), 'venom-memsrc-']) assert.ok(!json.includes(p), 'no path leaks')
  for (const r of res.rows) {
    assert.deepEqual(Object.keys(r), ['id', 'label', 'state', 'level', 'detail', 'updated'])
    assert.ok(r.detail.length <= 48, r.detail)
    assert.ok(r.updated === null || Number.isFinite(Date.parse(r.updated)))
  }
}

test('all six rows, in order, with counts from the fixture and nothing leaked', async () => {
  const { root, env } = fixture()
  const res = await memorySources({ long: fakeLong({ sent: 4, lastOkAt: Date.UTC(2026, 10, 14, 13, 19, 4) }), allowWrites: false, env })
  assertClean(res, root)
  assert.ok(Number.isFinite(Date.parse(res.at)))
  const pick = (id) => {
    const { state, level, detail } = rowOf(res, id)
    return { state, level, detail }
  }
  assert.deepEqual(pick('honcho'), { state: 'connected', level: 'ok', detail: '4 sent' })
  assert.equal(rowOf(res, 'honcho').updated, '2026-11-14T13:19:04.000Z')
  assert.deepEqual(pick('notes'), { state: 'read-only', level: 'ok', detail: '5 entries' })
  assert.deepEqual(pick('skills'), { state: 'read-only', level: 'ok', detail: '3 skills · 3 in 2 profiles' })
  assert.deepEqual(pick('vault'), { state: 'read-only', level: 'ok', detail: '2 notes' })
  assert.deepEqual(pick('graph'), { state: 'read-only', level: 'ok', detail: '3 nodes' })
  assert.deepEqual(pick('log'), { state: 'connected', level: 'ok', detail: '3 turns' })
  for (const id of ['notes', 'skills', 'vault', 'graph', 'log']) assert.ok(rowOf(res, id).updated, id)
})

test('notes are connected with writes on, off with VENOM_MEMORY=0 (log too)', async () => {
  const { env } = fixture()
  const on = await memorySources({ long: fakeLong(), allowWrites: true, env })
  assert.equal(rowOf(on, 'notes').state, 'connected')
  resetMemorySourcesCache()
  const off = await memorySources({ long: fakeLong({ enabled: false }), allowWrites: true, env: { ...env, VENOM_MEMORY: '0' } })
  for (const id of ['honcho', 'notes', 'log']) {
    assert.deepEqual([rowOf(off, id).state, rowOf(off, id).level, rowOf(off, id).detail], ['off', 'quiet', 'off'], id)
  }
})

test('the Honcho row: off, offline, read-only (402 / 401 / other), connected', async () => {
  const { root, env } = fixture()
  const run = async (long) => {
    resetMemorySourcesCache()
    const res = await memorySources({ long, env })
    assertClean(res, root)
    const { state, level, detail } = rowOf(res, 'honcho')
    return { state, level, detail }
  }
  assert.deepEqual(await run(fakeLong({ enabled: false })), { state: 'off', level: 'quiet', detail: 'off' })
  assert.deepEqual(await run(undefined), { state: 'off', level: 'quiet', detail: 'off' })
  assert.deepEqual(await run(fakeLong({ ok: false })), { state: 'offline', level: 'warn', detail: 'not answering' })
  assert.deepEqual(await run(fakeLong({ ok: false, queued: 2 })), { state: 'offline', level: 'warn', detail: '2 waiting' })
  assert.deepEqual(await run(fakeLong({ queued: 13, writeFault: true, lastStatus: 402 })), {
    state: 'read-only',
    level: 'warn',
    detail: '13 waiting · out of credits',
  })
  assert.equal((await run(fakeLong({ queued: 1, writeFault: true, lastStatus: 403 }))).detail, '1 waiting · key refused')
  assert.equal((await run(fakeLong({ queued: 1, writeFault: true, lastStatus: 500 }))).detail, '1 waiting · writes failing')
  assert.deepEqual(await run(fakeLong()), { state: 'connected', level: 'ok', detail: 'no write tried yet' })
  assert.equal((await run(fakeLong({ sent: 7, queued: 2 }))).detail, '7 sent · 2 waiting')
  const throwing = { enabled: true, check: async () => ({ ok: true }), status: () => { throw new Error(MARK) } }
  assert.equal((await run(throwing)).state, 'connected')
})

test('the Honcho check is cached for 60 s', async () => {
  const { env } = fixture()
  let t = 1_000_000
  const long = fakeLong()
  await memorySources({ long, env, now: () => t })
  t += 30_000
  await memorySources({ long, env, now: () => t })
  assert.equal(long.checks, 1)
  t += 31_000
  await memorySources({ long, env, now: () => t })
  assert.equal(long.checks, 2)
})

test('missing sources are not found; an unparseable graph is read-only and warns', async () => {
  const { root, env } = fixture({ notes: false, skills: false, vault: false, graph: 'none', log: false })
  const res = await memorySources({ long: fakeLong(), env })
  assertClean(res, root)
  for (const id of ['notes', 'skills', 'vault', 'graph']) {
    assert.equal(rowOf(res, id).state, 'not found', id)
    assert.equal(rowOf(res, id).level, 'warn', id)
    assert.equal(rowOf(res, id).updated, null, id)
  }
  assert.deepEqual([rowOf(res, 'log').state, rowOf(res, 'log').detail], ['connected', '0 turns'])

  const bad = fixture({ graph: 'bad' })
  const r2 = await memorySources({ long: fakeLong(), env: bad.env })
  assertClean(r2, bad.root)
  assert.deepEqual([rowOf(r2, 'graph').state, rowOf(r2, 'graph').level, rowOf(r2, 'graph').detail], ['read-only', 'warn', 'unreadable'])
})

test('a vault without Home.md is not found; skills without profiles drop the second half', async () => {
  const { root, env } = fixture()
  rmSync(join(env.VENOM_VAULT_DIR, 'Home.md'))
  rmSync(join(env.VENOM_HERMES_ROOT, 'profiles'), { recursive: true, force: true })
  const res = await memorySources({ long: fakeLong(), env })
  assertClean(res, root)
  assert.equal(rowOf(res, 'vault').state, 'not found')
  assert.equal(rowOf(res, 'skills').detail, '3 skills')
})

test('a row whose check throws becomes check failed; the rest still answer', async () => {
  const { root, env } = fixture()
  const long = { enabled: true, check: async () => ({ ok: true }), status: () => ({}) }
  // A getter that throws while the notes row reads env.
  const nasty = { ...env }
  Object.defineProperty(nasty, 'VENOM_HERMES_MEMORY_DIR', {
    enumerable: true,
    get() {
      throw new Error(`${MARK} ${root}`)
    },
  })
  const res = await memorySources({ long, env: nasty })
  assertClean(res, root)
  const notes = rowOf(res, 'notes')
  assert.deepEqual([notes.state, notes.level, notes.detail], ['not found', 'warn', 'check failed'])
  assert.equal(rowOf(res, 'vault').state, 'read-only')
})

test('helpers: entry counting and the Hermes root rule', () => {
  assert.equal(countEntries('a\n§\nb\r\n§\r\n  \n§\nc'), 3)
  assert.equal(countEntries(''), 0)
  assert.equal(hermesRoot({ VENOM_HERMES_ROOT: 'R' }), 'R')
  assert.equal(hermesRoot({ HERMES_HOME: join('X', 'hermes', 'profiles', 'venom') }), join('X', 'hermes'))
  assert.equal(hermesRoot({ HERMES_HOME: join('X', 'hermes') }), join('X', 'hermes'))
  assert.equal(hermesRoot({ LOCALAPPDATA: 'L' }), join('L', 'hermes'))
})

test('no VENOM_VAULT_DIR: the vault row is not found, nothing is looked for', async () => {
  assert.deepEqual(await vaultRow({ env: {} }), { state: 'not found', level: 'warn', detail: 'no vault', updated: null })
})
