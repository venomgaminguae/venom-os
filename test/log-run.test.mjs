// The backfill script (scripts/log-run.mjs): one finished run appended to the
// activity log for a job done outside the connector. Every test writes to its
// own temp folder; nothing touches the real ~/.venom.
// Starter roster, never the owner's venom.agents.json (must stay the first import).
import './fixtures/no-roster.mjs'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activityConfig, SUMMARY_CAP, TASK_CAP } from '../hermes-mcp/activity.mjs'
import { emptyTeam, recentRuns, reduceTeam } from '../bridge/team.mjs'
import { attachRun, logRun, parseArgs, summaryFrom } from '../scripts/log-run.mjs'
import { hasRunFile, readRunFile, runFilePath } from '../hermes-mcp/runfiles.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/log-run.mjs', import.meta.url))

let dir
let cfg
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'venom-logrun-'))
  cfg = activityConfig({ VENOM_AGENTS_DIR: dir })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const lines = () => (existsSync(cfg.file) ? readFileSync(cfg.file, 'utf8').split('\n').filter(Boolean) : [])
const events = () => lines().map((l) => JSON.parse(l))
const fold = () => events().reduce((s, e) => reduceTeam(s, e).state, emptyTeam())

// An hour ago, on a whole second, so it is never "in the future".
const ENDED = Math.floor((Date.now() - 3_600_000) / 1000) * 1000
const base = { agent: 'researcher', task: 'example.com audit', summary: 'Twelve fixes, three urgent.', endedAt: ENDED }

test('logRun: two lines, start then end, in the documented shape', () => {
  const res = logRun({ ...base, minutes: 20 }, { cfg })
  const evs = events()
  assert.equal(evs.length, 2)
  const [s, e] = evs
  assert.deepEqual(Object.keys(s).sort(), ['agent', 'id', 'pid', 't', 'task', 'ts'])
  assert.deepEqual(Object.keys(e).sort(), ['full', 'id', 'ms', 'ok', 'summary', 't', 'ts'])
  assert.equal(s.t, 'start')
  assert.equal(e.t, 'end')
  assert.equal(s.id, e.id)
  assert.equal(s.id, res.id)
  assert.equal(s.agent, 'researcher')
  assert.equal(s.task, base.task)
  assert.ok(Number.isInteger(s.pid))
  assert.equal(s.ts, ENDED - 20 * 60_000)
  assert.equal(e.ts, ENDED)
  assert.equal(e.ms, 20 * 60_000)
  assert.equal(e.ok, true)
  assert.equal(e.summary, base.summary)
  assert.deepEqual(res, { id: s.id, startedAt: ENDED - 20 * 60_000, endedAt: ENDED })
})

test('logRun: the team reducer folds it into one done run', () => {
  logRun({ ...base, minutes: 5 }, { cfg })
  const runs = recentRuns(fold())
  assert.equal(runs.length, 1)
  assert.equal(runs[0].state, 'done')
  assert.equal(runs[0].agent, 'researcher')
  assert.equal(runs[0].endedAt, ENDED)
  assert.equal(runs[0].startedAt, ENDED - 5 * 60_000)
  assert.equal(runs[0].summary, base.summary)
})

test('logRun: minutes default to 0; ok:false is a failed run', () => {
  logRun({ ...base, ok: false }, { cfg })
  const [s, e] = events()
  assert.equal(s.ts, ENDED)
  assert.equal(e.ms, 0)
  assert.equal(e.ok, false)
  assert.equal(recentRuns(fold())[0].state, 'failed')
})

test('logRun: secrets in the task and summary are written as [redacted]', () => {
  const key = `sk-${'a1B2'.repeat(6)}`
  logRun({ ...base, task: `use api key: ${key} please`, summary: `password is hunter2 and ${key}` }, { cfg })
  const raw = readFileSync(cfg.file, 'utf8')
  assert.ok(!raw.includes(key))
  assert.ok(!raw.includes('hunter2'))
  assert.match(events()[0].task, /^use \[redacted\] please$/)
  assert.match(events()[1].summary, /\[redacted\]/)
})

test('logRun: task and summary are capped like the connector caps them', () => {
  logRun({ ...base, task: 'x'.repeat(TASK_CAP + 200), summary: 'y'.repeat(SUMMARY_CAP + 400) }, { cfg })
  const [s, e] = events()
  assert.equal(s.task.length, TASK_CAP)
  assert.ok(s.task.endsWith('…'))
  assert.equal(e.summary.length, SUMMARY_CAP)
  assert.ok(e.summary.endsWith('…'))
})

test('logRun: bad input throws and writes nothing', () => {
  const bad = [
    [{ ...base, agent: 'nobody' }, /unknown agent/],
    [{ ...base, agent: undefined }, /unknown agent/],
    [{ ...base, task: '' }, /task/],
    [{ ...base, task: '   ' }, /task/],
    [{ ...base, summary: '' }, /summary/],
    [{ ...base, summary: 42 }, /summary/],
    [{ ...base, endedAt: NaN }, /endedAt/],
    [{ ...base, endedAt: '2026-11-10' }, /endedAt/],
    [{ ...base, endedAt: Date.now() + 10 * 60_000 }, /future/],
    [{ ...base, minutes: -1 }, /minutes/],
    [{ ...base, minutes: Infinity }, /minutes/],
  ]
  for (const [input, msg] of bad) assert.throws(() => logRun(input, { cfg }), msg)
  assert.equal(existsSync(cfg.file), false)

  const off = activityConfig({ VENOM_AGENTS_DIR: dir, VENOM_AGENT_ACTIVITY: '0' })
  assert.throws(() => logRun(base, { cfg: off }), /activity recording is off/)
  assert.equal(existsSync(cfg.file), false)
})

test('logRun: appends only; the lines already there are left as they were', () => {
  const before = `${JSON.stringify({ t: 'start', id: 'x', agent: 'coder', task: 'old', ts: 1, pid: 1 })}\nnot json at all\n`
  writeFileSync(cfg.file, before)
  logRun(base, { cfg })
  const raw = readFileSync(cfg.file, 'utf8')
  assert.ok(raw.startsWith(before))
  assert.equal(lines().length, 4)
})

// -------------------------------------------------------------------- CLI

test('parseArgs: the CLI flags as logRun input', () => {
  const ended = '2026-11-10T11:17:00+04:00'
  assert.deepEqual(
    parseArgs(['--agent', 'researcher', '--task', 'Audit', '--summary', 'Done.', '--ended', ended, '--minutes', '20']),
    { agent: 'researcher', task: 'Audit', summary: 'Done.', endedAt: Date.parse(ended), minutes: 20, ok: true },
  )
  const failed = parseArgs(['--failed', '--agent', 'coder', '--task', 't', '--summary', 's', '--ended', ended])
  assert.equal(failed.ok, false)
  assert.equal(failed.minutes, 0)
  assert.throws(() => parseArgs(['--agent', 'researcher', '--task', 't', '--summary', 's']), /--ended/)
  assert.throws(() => parseArgs(['--ended', '2026-11-10']), /date and a time/)
  assert.throws(() => parseArgs(['--ended', '2026-13-45T99:99']), /not a date-time/)
  assert.throws(() => parseArgs(['--ended', ended, '--minutes', 'soon']), /minutes/)
  assert.throws(() => parseArgs(['--ended', ended, '--bogus']), /unknown argument/)
  assert.throws(() => parseArgs(['--ended', ended, '--agent']), /needs a value/)
})

const cli = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, VENOM_AGENTS_DIR: dir, VENOM_AGENT_ACTIVITY: '1' },
    encoding: 'utf8',
  })

test('CLI: logs one run into VENOM_AGENTS_DIR and exits 0; a bad agent exits 1', () => {
  const ended = new Date(ENDED).toISOString()
  const ok = cli(['--agent', 'researcher', '--task', 'Site audit', '--summary', 'Five fixes.', '--ended', ended, '--minutes', '15'])
  assert.equal(ok.status, 0, ok.stderr)
  const [s, e] = events()
  assert.equal(lines().length, 2)
  assert.equal(s.agent, 'researcher')
  assert.equal(e.ts, ENDED)
  assert.equal(e.ms, 15 * 60_000)
  assert.equal(ok.stdout.trim(), `logged ${s.id} for researcher, ended ${ended}`)

  const bad = cli(['--agent', 'nobody', '--task', 't', '--summary', 's', '--ended', ended])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /^log-run: unknown agent/)
  assert.match(bad.stderr, /usage: node scripts\/log-run\.mjs/)
  assert.equal(lines().length, 2)
})

// ------------------------------------------------------------ full results

const REPORT = '\uFEFF# Site audit\n\n## Summary\n\nTwelve fixes were found.\nThree are urgent.\n\n| page | issue |\n|---|---|\n| / | title |\n'
const writeReport = (text = REPORT, name = 'report.md') => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

test('summaryFrom: the first prose lines, skipping headings, rules, fences and tables', () => {
  assert.equal(summaryFrom(REPORT.slice(1)), 'Twelve fixes were found. Three are urgent.')
  assert.equal(summaryFrom('# Only\n## Headings'), 'Only')
  assert.equal(summaryFrom('```\ncode\n```\n---\n- first point\n> quoted'), 'first point quoted')
})

test('logRun with full: the file is kept, the summary is derived when not given', () => {
  const { id } = logRun({ ...base, summary: undefined, full: REPORT.slice(1) }, { cfg })
  const [, e] = events()
  assert.equal(e.summary, 'Twelve fixes were found. Three are urgent.')
  assert.equal(e.full, true)
  assert.equal(readRunFile(id, cfg), REPORT.slice(1).trim())

  const second = logRun({ ...base, summary: 'Given.', full: 'The whole thing.' }, { cfg })
  assert.equal(events().at(-1).summary, 'Given.')
  assert.equal(readRunFile(second.id, cfg), 'The whole thing.')
  assert.throws(() => logRun({ ...base, full: '   ' }, { cfg }), /full result/)
})

test('CLI --file: the file is the full result (BOM dropped, secrets redacted), summary optional', () => {
  const key = `sk-${'q'.repeat(24)}`
  const file = writeReport(`${REPORT}\nKey: ${key}\n`)
  const ended = new Date(ENDED).toISOString()
  const r = cli(['--agent', 'researcher', '--task', 'Audit', '--ended', ended, '--file', file])
  assert.equal(r.status, 0, r.stderr)
  const [s, e] = events()
  assert.equal(e.summary, 'Twelve fixes were found. Three are urgent. Key: [redacted]')
  const stored = readFileSync(runFilePath(s.id, cfg), 'utf8')
  assert.ok(stored.startsWith('# Site audit'))
  assert.ok(!stored.includes(key))
  assert.match(stored, /\[redacted\]/)
})

test('CLI --file: an unreadable or empty file is an error before anything is written', () => {
  const ended = new Date(ENDED).toISOString()
  for (const file of [join(dir, 'missing.md'), writeReport('\uFEFF  \n\n', 'empty.md')]) {
    const r = cli(['--agent', 'researcher', '--task', 'Audit', '--ended', ended, '--file', file])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^log-run: (cannot read|.*is empty)/)
  }
  assert.equal(existsSync(cfg.file), false)
  assert.equal(existsSync(join(dir, 'runs')), false)
  // Without --file the summary is still required.
  const r = cli(['--agent', 'researcher', '--task', 'Audit', '--ended', ended])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /summary/)
})

test('attach: keeps the file for an existing run and appends no event', () => {
  const { id } = logRun({ ...base, agent: 'coder' }, { cfg })
  // logRun keeps the summary as the run's result; start from a run without one.
  rmSync(join(dir, 'runs'), { recursive: true, force: true })
  const before = readFileSync(cfg.file, 'utf8')
  const res = attachRun({ id, file: writeReport(), agent: 'coder' }, { cfg })
  assert.equal(readFileSync(cfg.file, 'utf8'), before)
  assert.equal(res.id, id)
  assert.equal(res.bytes, Buffer.byteLength(readFileSync(runFilePath(id, cfg), 'utf8')))
  assert.ok(readRunFile(id, cfg).startsWith('# Site audit'))

  // Already kept: refused without replace, replaced with it.
  assert.throws(() => attachRun({ id, text: 'New.' }, { cfg }), /already has a full result.*--replace/)
  attachRun({ id, text: 'New.', replace: true }, { cfg })
  assert.equal(readRunFile(id, cfg), 'New.')
  assert.equal(readFileSync(cfg.file, 'utf8'), before)
})

test('attach: unknown id, bad id, wrong agent and a run only in the .1', () => {
  const { id } = logRun(base, { cfg })
  rmSync(join(dir, 'runs'), { recursive: true, force: true })
  assert.throws(() => attachRun({ id: `${id.split('-')[0]}-ffffffff`, text: 'x' }, { cfg }), /no run/)
  assert.throws(() => attachRun({ id: '../evil', text: 'x' }, { cfg }), /not a run id/)
  assert.throws(() => attachRun({ id, text: 'x', agent: 'coder' }, { cfg }), /belongs to researcher, not coder/)
  assert.throws(() => attachRun({ id, text: 'x', agent: 'nobody' }, { cfg }), /unknown agent/)
  assert.equal(hasRunFile(id, cfg), false)
  // After a rotation the run's start is in the .1.
  renameSync(cfg.file, `${cfg.file}.1`)
  attachRun({ id, text: 'From the rotated half.', agent: 'researcher' }, { cfg })
  assert.equal(readRunFile(id, cfg), 'From the rotated half.')
})

test('CLI --attach: prints the bytes; refuses an existing file without --replace', () => {
  const { id } = logRun(base, { cfg })
  const before = readFileSync(cfg.file, 'utf8')
  const file = writeReport('Full result text.\n')
  const refused = cli(['--attach', id, '--file', file])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /already has a full result/)
  const ok = cli(['--attach', id, '--file', file, '--agent', 'researcher', '--replace'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(ok.stdout.trim(), `attached ${Buffer.byteLength('Full result text.')} bytes to ${id}`)
  assert.equal(readRunFile(id, cfg), 'Full result text.')
  assert.equal(readFileSync(cfg.file, 'utf8'), before)

  const wrong = cli(['--attach', id, '--file', file, '--agent', 'coder', '--replace'])
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, /belongs to researcher/)
})

test('parseArgs: --file, --attach and --replace', () => {
  const ended = '2026-11-10T11:17:00+04:00'
  assert.deepEqual(parseArgs(['--agent', 'researcher', '--task', 't', '--ended', ended, '--file', 'r.md']), {
    agent: 'researcher', task: 't', summary: undefined, endedAt: Date.parse(ended), minutes: 0, ok: true, file: 'r.md',
  })
  assert.deepEqual(parseArgs(['--attach', 'abc', '--file', 'r.md']), { attach: 'abc', file: 'r.md' })
  assert.deepEqual(parseArgs(['--attach', 'abc', '--file', 'r.md', '--agent', 'researcher', '--replace']), {
    attach: 'abc', file: 'r.md', agent: 'researcher', replace: true,
  })
  assert.throws(() => parseArgs(['--attach', 'abc']), /--attach needs --file/)
  assert.throws(() => parseArgs(['--attach', 'abc', '--file', 'r.md', '--summary', 's']), /--attach takes only/)
  assert.throws(() => parseArgs(['--ended', ended, '--replace']), /--replace only goes with --attach/)
})
