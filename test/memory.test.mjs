// The memory module: Hermes's memory files and VENOM's conversation log.
// Every path points at a temp folder through the environment, so nothing here
// reads or writes the real memory.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetEntry,
  logTurn,
  memoryContext,
  memoryServer,
  pruneLog,
  readEntries,
  recentTurns,
  saveEntry,
  searchLog,
  updateEntry,
} from '../bridge/memory.mjs'
import { checkToolUse, decideTool, fileRoots } from '../bridge/policy.mjs'

let hermes
let logs

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'venom-memory-'))
  hermes = join(root, 'hermes')
  logs = join(root, 'log')
  mkdirSync(hermes)
  process.env.VENOM_HERMES_MEMORY_DIR = hermes
  process.env.VENOM_MEMORY_DIR = logs
  delete process.env.VENOM_MEMORY
  delete process.env.VENOM_MEMORY_LIMIT
  delete process.env.VENOM_USER_LIMIT
  delete process.env.VENOM_MEMORY_DAYS
})

const mem = () => join(hermes, 'MEMORY.md')
const usr = () => join(hermes, 'USER.md')
const raw = (p) => readFileSync(p, 'utf8')
const dayFiles = () => {
  try {
    return readdirSync(join(logs, 'conversations'))
  } catch {
    return []
  }
}

// --- reading ---------------------------------------------------------------

test('reads entries from a CRLF file', () => {
  writeFileSync(mem(), 'first note\r\n§\r\nsecond\r\nline two\r\n§\r\nthird')
  assert.deepEqual(readEntries('memory'), ['first note', 'second\nline two', 'third'])
})

test('reads entries from an LF file, and strips a BOM', () => {
  writeFileSync(usr(), '\ufeffOwner is Ali\n§\nLives in Paris\n')
  assert.deepEqual(readEntries('user'), ['Owner is Ali', 'Lives in Paris'])
})

test('a missing file is an empty list', () => {
  assert.deepEqual(readEntries('memory'), [])
  assert.deepEqual(readEntries('user'), [])
})

// --- saving ----------------------------------------------------------------

test('save adds an entry and creates the file', () => {
  const r = saveEntry('user', '  Prefers metric units  ')
  assert.equal(r.ok, true)
  assert.deepEqual(readEntries('user'), ['Prefers metric units'])
})

test('save refuses an empty entry and an exact duplicate, ignoring case', () => {
  saveEntry('memory', 'The store runs on WordPress')
  assert.equal(saveEntry('memory', '   ').reason, 'empty')
  const dup = saveEntry('memory', 'the STORE runs on wordpress')
  assert.equal(dup.ok, false)
  assert.equal(dup.reason, 'duplicate')
  assert.deepEqual(readEntries('memory'), ['The store runs on WordPress'])
})

test('save refuses past the limit, counted as Hermes counts, and reports what is there', () => {
  process.env.VENOM_USER_LIMIT = '20'
  assert.equal(saveEntry('user', 'aaaaaaaa').ok, true) // 8
  assert.equal(saveEntry('user', 'bbbbbbbbb').ok, true) // 8 + 3 + 9 = 20, exactly the limit
  const r = saveEntry('user', 'c')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'full')
  assert.deepEqual(r.entries, ['aaaaaaaa', 'bbbbbbbbb'])
  assert.equal(r.used, 20)
  assert.equal(r.limit, 20)
  assert.deepEqual(readEntries('user'), ['aaaaaaaa', 'bbbbbbbbb'])
})

test('save refuses obvious secrets', () => {
  assert.equal(saveEntry('memory', 'API key: sk-abcdefghijklmnopqrstuv').reason, 'secret')
  assert.equal(saveEntry('memory', 'Card 4111 1111 1111 1111').reason, 'secret')
  assert.equal(saveEntry('memory', 'The wifi password is hunter2').reason, 'secret')
  assert.deepEqual(readEntries('memory'), [])
})

test('a write keeps the § separators and CRLF endings, and leaves no temp file', () => {
  writeFileSync(mem(), 'one\r\n§\r\ntwo')
  assert.equal(saveEntry('memory', 'three').ok, true)
  assert.equal(raw(mem()), 'one\r\n§\r\ntwo\r\n§\r\nthree')
  assert.equal(updateEntry('memory', 'two', 'TWO\nlines').ok, true)
  assert.equal(raw(mem()), 'one\r\n§\r\nTWO\r\nlines\r\n§\r\nthree')
  assert.deepEqual(readdirSync(hermes), ['MEMORY.md'])
})

test('an LF file stays LF', () => {
  writeFileSync(mem(), 'one\n§\ntwo')
  saveEntry('memory', 'three')
  assert.equal(raw(mem()), 'one\n§\ntwo\n§\nthree')
})

test('a save re-reads the file first, so a Hermes edit in between survives', () => {
  saveEntry('user', 'from venom')
  writeFileSync(usr(), 'from venom\r\n§\r\nfrom hermes')
  saveEntry('user', 'from venom again')
  assert.deepEqual(readEntries('user'), ['from venom', 'from hermes', 'from venom again'])
})

test('a file that is not valid UTF-8 is never overwritten', () => {
  writeFileSync(mem(), Buffer.from([0x66, 0xff, 0xfe, 0x67]))
  assert.equal(saveEntry('memory', 'new').ok, false)
  assert.deepEqual([...readFileSync(mem())], [0x66, 0xff, 0xfe, 0x67])
})

// --- update and forget -------------------------------------------------------

test('update and forget with zero, one and several matches', () => {
  writeFileSync(mem(), 'GPU is a 5090\r\n§\r\nCPU is a 9950X\r\n§\r\nCase is white')
  assert.equal(updateEntry('memory', 'RAM', 'x').reason, 'none')
  const several = updateEntry('memory', ' is a ', 'x')
  assert.equal(several.reason, 'several')
  assert.equal(several.matches.length, 2)
  assert.equal(forgetEntry('memory', 'nothing like this').reason, 'none')
  assert.equal(forgetEntry('memory', 'is a').reason, 'several')
  assert.deepEqual(readEntries('memory'), ['GPU is a 5090', 'CPU is a 9950X', 'Case is white'])

  assert.equal(updateEntry('memory', '5090', 'GPU is a 6090').ok, true)
  assert.equal(forgetEntry('memory', 'white').ok, true)
  assert.deepEqual(readEntries('memory'), ['GPU is a 6090', 'CPU is a 9950X'])
  assert.equal(raw(mem()), 'GPU is a 6090\r\n§\r\nCPU is a 9950X')
})

test('update respects the size limit too', () => {
  process.env.VENOM_MEMORY_LIMIT = '10'
  saveEntry('memory', 'short')
  const r = updateEntry('memory', 'short', 'much much longer')
  assert.equal(r.reason, 'full')
  assert.deepEqual(readEntries('memory'), ['short'])
})

// --- the conversation log ----------------------------------------------------

test('a logged turn round-trips, text only', () => {
  const ts = new Date(2026, 10, 9, 14, 30)
  assert.equal(logTurn({ session: 's1', user: 'What about the AI site?', assistant: 'It launches Friday, sir.', ts }), true)
  assert.deepEqual(dayFiles(), ['2026-11-09.jsonl'])
  const line = JSON.parse(raw(join(logs, 'conversations', '2026-11-09.jsonl')).trim())
  assert.deepEqual(Object.keys(line).sort(), ['assistant', 'session', 'ts', 'user'])
  assert.equal(line.user, 'What about the AI site?')
  const [hit] = searchLog('ai site', { now: new Date(2026, 10, 10) })
  assert.equal(hit.date, '2026-11-09')
  assert.equal(hit.time, '14:30')
  assert.equal(hit.assistant, 'It launches Friday, sir.')
})

test('a turn with only tool output, or no question, is not logged', () => {
  assert.equal(logTurn({ session: 's', user: 'Show me the render', assistant: '' }), false)
  assert.equal(logTurn({ session: 's', user: 'Show me the render', assistant: undefined }), false)
  assert.equal(logTurn({ session: 's', user: '', assistant: 'Done.' }), false)
  assert.equal(logTurn({ session: 's', user: '  ', assistant: '  ' }), false)
  assert.deepEqual(dayFiles(), [])
})

test('each field is capped', () => {
  logTurn({ session: 's', user: 'q', assistant: 'x'.repeat(10_000), ts: new Date(2026, 0, 1) })
  const line = JSON.parse(raw(join(logs, 'conversations', '2026-01-01.jsonl')))
  assert.ok(line.assistant.length <= 4001)
})

test('search ranks by distinct words matched, then newest first', () => {
  const at = (d) => new Date(2026, 10, d, 12)
  logTurn({ session: 'a', user: 'wordpress theme colours', assistant: 'Noted.', ts: at(1) })
  logTurn({ session: 'a', user: 'the wordpress store', assistant: 'Fine.', ts: at(3) })
  logTurn({ session: 'b', user: 'new wordpress theme', assistant: 'Yes.', ts: at(5) })
  logTurn({ session: 'b', user: 'nothing relevant', assistant: 'Indeed.', ts: at(6) })
  const hits = searchLog('WordPress THEME', { now: at(7) })
  assert.deepEqual(hits.map((h) => h.date), ['2026-11-05', '2026-11-01', '2026-11-03'])
  assert.deepEqual(hits.map((h) => h.score), [2, 2, 1])
  assert.equal(searchLog('wordpress', { limit: 1, now: at(7) }).length, 1)
  assert.deepEqual(searchLog('zebra', { now: at(7) }), [])
})

test('the days argument limits how far back search looks', () => {
  logTurn({ session: 'a', user: 'budget for the launch', assistant: 'Ten thousand.', ts: new Date(2026, 9, 1, 12) })
  logTurn({ session: 'a', user: 'launch date', assistant: 'Friday.', ts: new Date(2026, 10, 8, 12) })
  const now = new Date(2026, 10, 10, 12)
  assert.equal(searchLog('launch', { now }).length, 2)
  const recent = searchLog('launch', { days: 7, now })
  assert.equal(recent.length, 1)
  assert.equal(recent[0].date, '2026-11-08')
})

test('old day files are pruned', () => {
  process.env.VENOM_MEMORY_DAYS = '30'
  const now = new Date(2026, 10, 10)
  logTurn({ session: 'a', user: 'old', assistant: 'old', ts: new Date(2026, 8, 1) })
  logTurn({ session: 'a', user: 'new', assistant: 'new', ts: new Date(2026, 10, 1) })
  writeFileSync(join(logs, 'conversations', 'notes.txt'), 'not a day file')
  assert.equal(pruneLog(undefined, now), 1)
  assert.deepEqual(dayFiles().sort(), ['2026-11-01.jsonl', 'notes.txt'])
})

test('the prompt block holds both lists and recent turns from other sessions', () => {
  writeFileSync(usr(), 'Owner is Ali\r\n§\r\nPrefers short answers')
  writeFileSync(mem(), 'The store runs on WordPress')
  logTurn({ session: 'old', user: 'remind me about the GPU order', assistant: 'It ships Monday.', ts: new Date(2026, 10, 8, 9) })
  logTurn({ session: 'old', user: 'and the case?', assistant: 'Tuesday.', ts: new Date(2026, 10, 8, 10) })
  logTurn({ session: 'now', user: 'current session', assistant: 'Here.', ts: new Date(2026, 10, 9, 9) })
  const block = memoryContext({ session: 'now' })
  assert.match(block, /Owner is Ali/)
  assert.match(block, /Prefers short answers/)
  assert.match(block, /The store runs on WordPress/)
  assert.match(block, /GPU order[\s\S]*the case\?/) // newest last
  assert.doesNotMatch(block, /current session/)
  assert.ok(block.indexOf('WordPress') < block.indexOf('GPU order'))
})

test('the recent digest stays under its character cap', () => {
  for (let i = 0; i < 40; i++) {
    logTurn({ session: 'x', user: `question ${i} ${'q'.repeat(150)}`, assistant: 'a'.repeat(300), ts: new Date(2026, 10, 1, 0, i) })
  }
  const turns = recentTurns({ maxChars: 1500 })
  assert.ok(turns.length > 0)
  assert.ok(turns.join('\n').length <= 1500)
  assert.match(turns.at(-1), /question 39/)
})

test('VENOM_MEMORY=0 writes nothing and adds nothing to the prompt', () => {
  process.env.VENOM_MEMORY = '0'
  writeFileSync(mem(), 'existing')
  assert.equal(memoryContext({ session: 's' }), '')
  assert.equal(saveEntry('memory', 'new fact').ok, false)
  assert.equal(logTurn({ session: 's', user: 'hi', assistant: 'Hello.' }), false)
  assert.deepEqual(searchLog('hi'), [])
  assert.equal(raw(mem()), 'existing')
  assert.equal(existsSync(logs), false)
})

// --- tools and policy ----------------------------------------------------------

const toolNames = (server) => Object.keys(server.instance?._registeredTools ?? {}).sort()

test('the changing tools are only built with writes on', () => {
  assert.deepEqual(toolNames(memoryServer({ allowWrites: false })), ['memory_search'])
  assert.deepEqual(toolNames(memoryServer({ allowWrites: true })), [
    'memory_forget',
    'memory_save',
    'memory_search',
    'memory_update',
  ])
})

test('policy: search is a read, save/update/forget need writes', () => {
  const name = (t) => `mcp__venom_memory__${t}`
  assert.equal(decideTool(name('memory_search')), true)
  assert.equal(decideTool(name('memory_search'), true), true)
  for (const t of ['memory_save', 'memory_update', 'memory_forget']) {
    assert.equal(decideTool(name(t)), false, `${t} must need writes`)
    assert.equal(decideTool(name(t), true), true, `${t} must run with writes`)
  }
  // Anything else on that server falls to the write gate too.
  assert.equal(decideTool(name('memory_wipe')), false)
  // The same names on any other server get no special treatment.
  assert.equal(decideTool('mcp__someserver__memory_search'), false)

  const ws = mkdtempSync(join(tmpdir(), 'venom-ws-'))
  const ctx = { allowWrites: false, cwd: ws, roots: fileRoots({ workspace: ws }) }
  assert.equal(checkToolUse(name('memory_search'), { query: 'x' }, ctx).allow, true)
  assert.equal(checkToolUse(name('memory_save'), { target: 'user', content: 'x' }, ctx).allow, false)
})
