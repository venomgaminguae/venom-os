// Full results kept per run (hermes-mcp/runfiles.mjs). Every test works in its
// own temp folder; nothing touches the real ~/.venom.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activityConfig,
  fullResult,
  hasRunFile,
  pruneRunFiles,
  readRunFile,
  runFilePath,
  runsDir,
  writeRunFile,
  KEEP_DAYS,
  RESULT_CAP_BYTES,
  RUN_ID,
} from '../hermes-mcp/runfiles.mjs'

const CRLF = String.fromCharCode(13, 10)
const ESC = String.fromCharCode(27)
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 10, 12)
const idAt = (ms, hex = '0123abcd') => `${ms.toString(36)}-${hex}`
const ID = idAt(NOW - 1000)

let dir
let cfg
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'venom-runfiles-'))
  cfg = activityConfig({ VENOM_AGENTS_DIR: dir })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('RUN_ID matches the ids startRun makes and nothing else', () => {
  assert.match(ID, RUN_ID)
  assert.match(idAt(Date.now(), 'deadbeef'), RUN_ID)
  for (const bad of ['', 'abc', '../x', 'a/b', 'a\\b', `${ID}/..`, `../${ID}`, ID.toUpperCase(), `${ID}0`, `x${'1'.repeat(12)}-0123abcd`, `${ID}.md`, `${ID}%2f`]) {
    assert.doesNotMatch(bad, RUN_ID, bad)
  }
})

test('runFilePath: <dir>/runs/<id>.md for a run id, null for anything else', () => {
  assert.equal(runsDir(cfg), join(dir, 'runs'))
  assert.equal(runFilePath(ID, cfg), join(dir, 'runs', `${ID}.md`))
  for (const bad of ['../x', 'a/b', '..', `../../${ID}`, null, undefined, 42, {}]) assert.equal(runFilePath(bad, cfg), null)
})

test('writeRunFile / readRunFile / hasRunFile round trip', () => {
  assert.equal(hasRunFile(ID, cfg), false)
  assert.equal(readRunFile(ID, cfg), null)
  assert.equal(writeRunFile(ID, '# Report\n\nAll good.\n', cfg), true)
  assert.equal(hasRunFile(ID, cfg), true)
  assert.equal(readRunFile(ID, cfg), '# Report\n\nAll good.')
  assert.equal(readFileSync(join(dir, 'runs', `${ID}.md`), 'utf8'), '# Report\n\nAll good.')
  // A second write replaces the first, and leaves no temp file behind.
  assert.equal(writeRunFile(ID, 'Second.', cfg), true)
  assert.equal(readRunFile(ID, cfg), 'Second.')
  assert.deepEqual(readdirSync(join(dir, 'runs')), [`${ID}.md`])
})

test('bad ids, empty text and activity off write nothing', () => {
  for (const bad of ['../x', 'a/b', '..\\evil', `../${ID}`, ID.toUpperCase(), '']) {
    assert.equal(writeRunFile(bad, 'text', cfg), false, bad)
    assert.equal(readRunFile(bad, cfg), null, bad)
    assert.equal(hasRunFile(bad, cfg), false, bad)
  }
  assert.equal(writeRunFile(ID, '', cfg), false)
  assert.equal(writeRunFile(ID, `  ${CRLF}  `, cfg), false)
  assert.equal(writeRunFile(ID, null, cfg), false)
  const off = activityConfig({ VENOM_AGENTS_DIR: dir, VENOM_AGENT_ACTIVITY: '0' })
  assert.equal(writeRunFile(ID, 'text', off), false)
  assert.equal(existsSync(join(dir, 'runs')), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('writeRunFile never throws: an unwritable folder is one stderr line', () => {
  writeFileSync(join(dir, 'runs'), 'not a folder')
  const errs = []
  const orig = process.stderr.write
  process.stderr.write = (s) => (errs.push(String(s)), true)
  try {
    assert.equal(writeRunFile(ID, 'text', cfg), false)
  } finally {
    process.stderr.write = orig
  }
  assert.equal(errs.length, 1)
  assert.match(errs[0], /^\[hermes-mcp\] activity run file write failed: .*\n$/)
})

test('fullResult: frames and ANSI dropped, CRLF made LF, blank lines kept, trimmed', () => {
  const raw = [
    `${ESC}[2m│${ESC}[0m ${ESC}[1mnotes.txt${ESC}[0m`,
    `${ESC}[2m│${ESC}[0m ${ESC}[32m+secret diff line${ESC}[0m`,
    '┃ framed too',
    '',
    `${ESC}[1mTitle${ESC}[0m`,
    '',
    '',
    '  indented   line  with   spaces',
    '- item',
    '',
  ].join(CRLF)
  assert.equal(fullResult(raw), 'Title\n\n\n  indented   line  with   spaces\n- item')
  assert.ok(!fullResult(raw).includes('secret diff line'))
})

test('fullResult: secrets are redacted', () => {
  const key = `sk-${'abcdefghij'.repeat(2)}`
  const out = fullResult(`Key ${key} here.\npassword: hunter2secret\nfine line`)
  assert.ok(!out.includes(key))
  assert.ok(!out.includes('hunter2secret'))
  assert.match(out, /^Key \[redacted\] here\.\n\[redacted\]\nfine line$/)
})

test('fullResult: capped at 200 KB with a closing note, never inside a character', () => {
  const small = 'a'.repeat(RESULT_CAP_BYTES)
  assert.equal(fullResult(small), small) // exactly the cap: kept whole

  const big = 'b'.repeat(RESULT_CAP_BYTES + 5000)
  const cut = fullResult(big)
  assert.ok(cut.endsWith('\n\n[Result cut at 200 KB]'))
  assert.ok(Buffer.byteLength(cut, 'utf8') <= RESULT_CAP_BYTES)

  // Three-byte characters, offset so the cap falls inside one of them.
  for (const lead of ['', 'x', 'xx']) {
    const out = fullResult(lead + '€'.repeat(RESULT_CAP_BYTES / 2))
    assert.ok(out.endsWith('\n\n[Result cut at 200 KB]'))
    assert.ok(!out.includes('\uFFFD'), `lead ${lead.length}`)
    assert.ok(Buffer.byteLength(out, 'utf8') <= RESULT_CAP_BYTES)
    const body = out.slice(0, -'\n\n[Result cut at 200 KB]'.length)
    assert.equal(body, lead + '€'.repeat(body.length - lead.length))
  }

  writeRunFile(ID, big, cfg)
  assert.ok(statSync(runFilePath(ID, cfg)).size <= RESULT_CAP_BYTES)
})

test('readRunFile reads at most the cap plus a little, whatever is on disk', () => {
  mkdirSync(join(dir, 'runs'))
  writeFileSync(runFilePath(ID, cfg), 'z'.repeat(RESULT_CAP_BYTES * 3))
  const text = readRunFile(ID, cfg)
  assert.ok(text.length > RESULT_CAP_BYTES - 1)
  assert.ok(text.length <= RESULT_CAP_BYTES + 4096)

  // A multi-byte character cut by the read limit is dropped, not mangled.
  const other = idAt(NOW - 2000)
  writeFileSync(runFilePath(other, cfg), '€'.repeat(RESULT_CAP_BYTES))
  const euros = readRunFile(other, cfg)
  assert.ok(!euros.includes('\uFFFD'))
  assert.equal(euros, '€'.repeat(euros.length))
})

test('readRunFile and hasRunFile: a folder in the file\'s place is not a result', () => {
  mkdirSync(join(dir, 'runs', `${ID}.md`), { recursive: true })
  assert.equal(hasRunFile(ID, cfg), false)
  assert.equal(readRunFile(ID, cfg), null)
})

test('pruneRunFiles: by the start time in the id; other names left alone', () => {
  const runs = join(dir, 'runs')
  mkdirSync(runs)
  const old = idAt(NOW - (KEEP_DAYS + 1) * DAY)
  const edge = idAt(NOW - KEEP_DAYS * DAY + 60_000, 'aaaaaaaa')
  const fresh = idAt(NOW - DAY, 'bbbbbbbb')
  const oldTmp = `${old}.123.abcd1234.tmp`
  const newTmp = `${fresh}.123.abcd1234.tmp`
  for (const name of [`${old}.md`, `${edge}.md`, `${fresh}.md`, 'notes.md', 'README.txt', `${old}.txt`, oldTmp, newTmp]) {
    writeFileSync(join(runs, name), 'x')
  }
  const dayAgo = (NOW - 2 * DAY) / 1000
  utimesSync(join(runs, oldTmp), dayAgo, dayAgo)
  utimesSync(join(runs, newTmp), NOW / 1000, NOW / 1000)
  assert.equal(pruneRunFiles(cfg, NOW), 1)
  assert.deepEqual(readdirSync(runs).sort(), [`${edge}.md`, `${fresh}.md`, `${old}.txt`, newTmp, 'README.txt', 'notes.md'].sort())
  assert.equal(pruneRunFiles(cfg, NOW), 0)
})

test('pruneRunFiles: no folder, or activity off, is nothing to do', () => {
  assert.equal(pruneRunFiles(cfg, NOW), 0)
  const off = activityConfig({ VENOM_AGENTS_DIR: dir, VENOM_AGENT_ACTIVITY: '0' })
  mkdirSync(join(dir, 'runs'))
  const old = idAt(NOW - 30 * DAY)
  writeFileSync(join(dir, 'runs', `${old}.md`), 'x')
  assert.equal(pruneRunFiles(off, NOW), 0)
  assert.ok(existsSync(join(dir, 'runs', `${old}.md`)))
})
