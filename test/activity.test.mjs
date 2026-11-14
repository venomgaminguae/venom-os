// The team activity log writer and the step headline extractor
// (hermes-mcp/activity.mjs). Every test writes to its own temp folder.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activityConfig,
  answerText,
  appendEvent,
  pruneActivity,
  startRun,
  stepFromLine,
  stepsFromText,
  HEARTBEAT_MS,
  ROTATE_BYTES,
  KEEP_DAYS,
} from '../hermes-mcp/activity.mjs'
import { hasRunFile, readRunFile, writeRunFile } from '../hermes-mcp/runfiles.mjs'

let dir
let cfg
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'venom-activity-'))
  cfg = activityConfig({ VENOM_AGENTS_DIR: dir })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const events = () =>
  existsSync(cfg.file)
    ? readFileSync(cfg.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []

/** A clock the test moves by hand (a real-looking time, so run ids have their real shape). */
const clock = (t = Date.UTC(2026, 10, 10)) => {
  const c = () => t
  c.add = (ms) => (t += ms)
  return c
}

// Captured from a real `hermes -p operator chat -q ... -Q` run (PYTHONUNBUFFERED=1):
// the stdout chunks of writing a three-line file and then patching one line.
const ESC = '\x1b'
const CAPTURED = [
  `${ESC}[2m│${ESC}[0m ${ESC}[1mfruit.txt${ESC}[0m\r\n`,
  `${ESC}[2m│${ESC}[0m ${ESC}[38;2;42;38;64m@@ -0,0 +1,3 @@${ESC}[0m\r\n${ESC}[2m│${ESC}[0m ${ESC}[38;2;255;255;255;48;2;22;123;44m+apple${ESC}[0m\r\n${ESC}[2m│${ESC}[0m ${ESC}[38;2;255;255;255;48;2;22;123;44m+banana${ESC}[0m\r\n${ESC}[2m│${ESC}[0m ${ESC}[38;2;255;255;255;48;2;22;123;44m+cherry${ESC}[0m\r\n`,
  `${ESC}[2m│${ESC}[0m ${ESC}[1mfruit.txt${ESC}[0m\r\n`,
  `${ESC}[2m│${ESC}[0m ${ESC}[38;2;42;38;64m@@ -1,3 +1,3 @@${ESC}[0m\r\n${ESC}[2m│${ESC}[0m ${ESC}[38;2;139;135;168m apple${ESC}[0m\r\n${ESC}[2m│${ESC}[0m ${ESC}[38;2;255;255;255;48;2;127;26;31m-banana${ESC}[0m\r\n${ESC}[2m│${ESC}[0m ${ESC}[38;2;255;255;255;48;2;22;123;44m+mango${ESC}[0m\r\n`,
  `${ESC}[2m│${ESC}[0m ${ESC}[38;2;139;135;168m cherry${ESC}[0m\r\n`,
  'Done.\r\n',
]

// ------------------------------------------------------------- extractor

test('extractor: real captured output yields only the file headers', () => {
  assert.deepEqual(stepsFromText(CAPTURED.join('')), ['Editing fruit.txt', 'Editing fruit.txt'])
})

test('extractor: diff bodies, hunk headers, context and answer text are never steps', () => {
  for (const line of CAPTURED.join('').split('\n')) {
    const s = stepFromLine(line)
    if (s) assert.equal(s, 'Editing fruit.txt')
  }
  assert.equal(stepFromLine(`${ESC}[2m│${ESC}[0m ${ESC}[38;2;255;255;255;48;2;22;123;44m+password.txt${ESC}[0m`), null)
  assert.equal(stepFromLine('│  context.txt'), null)
  assert.equal(stepFromLine('Done. I edited notes.txt'), null)
  assert.equal(stepFromLine('| table.md | 3 |'), null)
  assert.equal(stepFromLine('│ ... 12 more lines'), null)
})

test('extractor: a long Windows path is cut to its last two segments', () => {
  const s = stepFromLine(`${ESC}[2m│${ESC}[0m ${ESC}[1mC:\\Users\\Someone\\Projects\\site\\src\\theme.css${ESC}[0m`)
  assert.equal(s, 'Editing src\\theme.css')
  assert.equal(stepFromLine('│ src/app/main.tsx'), 'Editing app/main.tsx')
})

test('answerText drops the framed diff lines', () => {
  assert.equal(answerText(CAPTURED.join('')).trim(), 'Done.')
})

// ---------------------------------------------------------------- writer

test('a run writes start, steps and end with the documented fields', () => {
  const now = clock()
  const run = startRun({ agent: 'operator', task: 'Edit   the\nfruit list' }, { cfg, now, timers: false, pid: 4242 })
  for (const chunk of CAPTURED) {
    run.feed(chunk)
    now.add(1500)
  }
  run.end({ ok: true, text: CAPTURED.join('') })
  const ev = events()
  assert.deepEqual(ev.map((e) => e.t), ['start', 'step', 'end'])
  assert.deepEqual(Object.keys(ev[0]).sort(), ['agent', 'id', 'pid', 't', 'task', 'ts'])
  assert.equal(ev[0].task, 'Edit the fruit list')
  assert.equal(ev[0].pid, 4242)
  assert.equal(ev[1].text, 'Editing fruit.txt') // the second, equal header is skipped
  assert.deepEqual(Object.keys(ev[2]).sort(), ['full', 'id', 'ms', 'ok', 'summary', 't', 'ts'])
  assert.equal(ev[2].full, true)
  assert.equal(ev[2].ok, true)
  assert.equal(ev[2].summary, 'Done.')
  assert.equal(ev[2].ms, 9000)
  assert.ok(ev.every((e) => e.id === ev[0].id))
})

test('ids are unique per run', () => {
  const now = clock()
  const a = startRun({ agent: 'coder', task: 'a' }, { cfg, now, timers: false })
  const b = startRun({ agent: 'coder', task: 'b' }, { cfg, now, timers: false })
  assert.notEqual(a.id, b.id)
})

test('caps: task 300, step 160, summary 600 characters', () => {
  const now = clock()
  const run = startRun({ agent: 'writer', task: 'x'.repeat(1000) }, { cfg, now, timers: false })
  run.step(`Editing ${'y'.repeat(400)}`)
  run.end({ ok: true, text: 'z'.repeat(5000) })
  const [start, step, end] = events()
  assert.equal(start.task.length, 300)
  assert.equal(step.text.length, 160)
  assert.equal(end.summary.length, 600)
})

test('throttle: at most one step a second, the latest waiting one wins, repeats skipped', () => {
  const now = clock()
  const run = startRun({ agent: 'coder', task: 't' }, { cfg, now, timers: false })
  run.step('Editing a.txt') // written
  now.add(200)
  run.step('Editing b.txt') // waits
  now.add(200)
  run.step('Editing c.txt') // replaces b
  run.tick() // too soon
  now.add(700)
  run.tick() // c goes out
  now.add(1100)
  run.step('Editing c.txt') // same as the last: skipped
  run.end({ ok: true, text: 'ok' })
  assert.deepEqual(
    events().filter((e) => e.t === 'step').map((e) => e.text),
    ['Editing a.txt', 'Editing c.txt'],
  )
})

test('heartbeat every 15 s when nothing trustworthy arrives (and for gemini)', () => {
  const now = clock()
  const run = startRun({ agent: 'gemini', task: 't', live: false }, { cfg, now, timers: false })
  run.feed('{"status":"SUCCESS","response":"│ secret.txt"}\n') // not read when live is false
  now.add(HEARTBEAT_MS - 1)
  run.tick()
  now.add(1)
  run.tick()
  now.add(HEARTBEAT_MS)
  run.tick()
  now.add(HEARTBEAT_MS)
  run.tick()
  run.end({ ok: true, text: 'answer' })
  assert.deepEqual(
    events().filter((e) => e.t === 'step').map((e) => e.text),
    ['Working, 15s', 'Working, 30s', 'Working, 45s'],
  )
})

test('redaction: secrets in the task, steps and summary become [redacted]', () => {
  const now = clock()
  const key = `sk-${'a1B2'.repeat(6)}`
  const run = startRun({ agent: 'coder', task: `use api key: ${key} please` }, { cfg, now, timers: false })
  run.step(`Editing ghp_${'x'.repeat(30)}.txt`)
  run.end({ ok: false, text: `password is hunter2 and card 4111 1111 1111 1111 ${key}` })
  const raw = readFileSync(cfg.file, 'utf8')
  assert.ok(!raw.includes(key))
  assert.ok(!raw.includes('hunter2'))
  assert.ok(!raw.includes('4111 1111'))
  assert.ok(!raw.includes('ghp_xxx'))
  assert.match(raw, /\[redacted\]/)
  assert.match(events()[0].task, /^use \[redacted\] please$/)
})

test('rotation: past 2 MB the log moves to .1 and a fresh one starts', () => {
  writeFileSync(cfg.file, `${'x'.repeat(ROTATE_BYTES + 10)}\n`)
  assert.equal(appendEvent({ t: 'start', id: 'r1', agent: 'coder', task: '', ts: 1, pid: 1 }, cfg), true)
  assert.ok(statSync(`${cfg.file}.1`).size > ROTATE_BYTES)
  assert.deepEqual(events().map((e) => e.id), ['r1'])
})

test('pruning drops events older than 14 days from the log and its .1', () => {
  const now = Date.UTC(2026, 10, 10)
  const old = now - (KEEP_DAYS + 1) * 86_400_000
  const line = (id, ts) => JSON.stringify({ t: 'start', id, agent: 'coder', task: '', ts, pid: 1 })
  writeFileSync(cfg.file, `${line('old', old)}\n${line('new', now - 1000)}\nnot json\n`)
  writeFileSync(`${cfg.file}.1`, `${line('older', old - 5)}\n`)
  assert.equal(pruneActivity(cfg, now), 3)
  assert.deepEqual(events().map((e) => e.id), ['new'])
  assert.equal(readFileSync(`${cfg.file}.1`, 'utf8'), '')
  assert.equal(pruneActivity(cfg, now), 0) // nothing left to drop: not rewritten
})

test('off switch: VENOM_AGENT_ACTIVITY=0 writes nothing', () => {
  const off = activityConfig({ VENOM_AGENTS_DIR: dir, VENOM_AGENT_ACTIVITY: '0' })
  const run = startRun({ agent: 'coder', task: 't' }, { cfg: off, timers: false })
  run.feed(CAPTURED.join(''))
  run.end({ ok: true, text: 'x' })
  assert.equal(appendEvent({ t: 'x' }, off), false)
  assert.equal(existsSync(off.file), false)
})

test('recording never throws: an unwritable log folder is reported, not raised', () => {
  const blocked = join(dir, 'file-not-folder')
  writeFileSync(blocked, '')
  const bad = activityConfig({ VENOM_AGENTS_DIR: join(blocked, 'sub') })
  const errs = []
  const orig = process.stderr.write
  process.stderr.write = (s) => (errs.push(String(s)), true)
  try {
    const run = startRun({ agent: 'coder', task: 't' }, { cfg: bad, timers: false })
    run.step('Editing a.txt')
    run.end({ ok: true, text: 'x' })
  } finally {
    process.stderr.write = orig
  }
  assert.ok(errs.length >= 1)
  assert.ok(errs.every((e) => e.startsWith('[hermes-mcp] activity ') && e.endsWith('\n')))
})

test('the default folder is ~/.venom/agents', () => {
  const c = activityConfig({})
  assert.match(c.file.replace(/\\/g, '/'), /\/\.venom\/agents\/activity\.jsonl$/)
  assert.equal(c.enabled, true)
})

// ------------------------------------------------------------ full result

test('full result: end keeps the whole answer in runs/<id>.md and flags the end event', () => {
  const now = clock()
  const run = startRun({ agent: 'operator', task: 't' }, { cfg, now, timers: false })
  const CRLF = String.fromCharCode(13, 10)
  const answer = CAPTURED.join('') + ['Line one.', '', 'Line three, after a blank line.', 'w'.repeat(2000)].join(CRLF)
  run.end({ ok: true, text: answer })
  const end = events().at(-1)
  assert.equal(end.full, true)
  assert.equal(end.summary.length, 600)
  const stored = readRunFile(run.id, cfg)
  assert.equal(stored, `Done.\nLine one.\n\nLine three, after a blank line.\n${'w'.repeat(2000)}`)
  assert.ok(existsSync(join(dir, 'runs', `${run.id}.md`)))
})

test('full result: end({ text, full }) takes the summary from text and the file from full', () => {
  const now = clock()
  const run = startRun({ agent: 'researcher', task: 't', live: false }, { cfg, now, timers: false })
  run.end({ ok: true, text: 'Short summary.', full: '# Report\n\nThe whole report.' })
  assert.equal(events().at(-1).summary, 'Short summary.')
  assert.equal(readRunFile(run.id, cfg), '# Report\n\nThe whole report.')
})

test('full result: an empty answer keeps no file and sets no flag; activity off writes nothing', () => {
  const now = clock()
  const run = startRun({ agent: 'coder', task: 't' }, { cfg, now, timers: false })
  run.end({ ok: false, text: '' })
  assert.equal('full' in events().at(-1), false)
  assert.equal(hasRunFile(run.id, cfg), false)

  const off = activityConfig({ VENOM_AGENTS_DIR: dir, VENOM_AGENT_ACTIVITY: '0' })
  startRun({ agent: 'coder', task: 't' }, { cfg: off, now, timers: false }).end({ ok: true, text: 'x' })
  assert.equal(writeRunFile(`${now().toString(36)}-0123abcd`, 'x', off), false)
  assert.equal(existsSync(join(dir, 'runs')), false)
})

test('full result: a failed file write still writes the end event, without the flag', () => {
  const now = clock()
  writeFileSync(join(dir, 'runs'), 'a file where the folder should be')
  const errs = []
  const orig = process.stderr.write
  process.stderr.write = (s) => (errs.push(String(s)), true)
  try {
    startRun({ agent: 'coder', task: 't' }, { cfg, now, timers: false }).end({ ok: true, text: 'answer' })
  } finally {
    process.stderr.write = orig
  }
  const end = events().at(-1)
  assert.equal(end.t, 'end')
  assert.equal(end.summary, 'answer')
  assert.equal('full' in end, false)
  assert.ok(errs.some((e) => e.startsWith('[hermes-mcp] activity run file')))
})
