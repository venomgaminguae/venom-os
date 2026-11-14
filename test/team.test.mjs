// The team dock's reducer and the activity log tail (bridge/team.mjs).
// Starter roster, never the owner's venom.agents.json (must stay the first import).
import './fixtures/no-roster.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTeamFeed,
  emptyTeam,
  isLost,
  recentRuns,
  reduceTeam,
  runsForAgent,
  LOST_AFTER_MS,
  MAX_RUNS,
  MAX_STEPS,
} from '../bridge/team.mjs'
import { PINNED_JOBS } from '../hermes-mcp/pinned.mjs'
import { AGENTS, AGENT_IDS } from '../hermes-mcp/agents.mjs'
import { pinnedIds } from '../hermes-mcp/roster.mjs'

// The roster's pinned agents (the starter set pins researcher and coder).
const PINNED_IDS = pinnedIds(AGENTS)

const fold = (events, state = emptyTeam()) => events.reduce((s, e) => reduceTeam(s, e).state, state)
const start = (id, ts, extra = {}) => ({ t: 'start', id, agent: 'coder', task: `task ${id}`, ts, pid: 7, ...extra })

// ---------------------------------------------------------------- reducer

test('reducer: start, steps and end make one run with the documented shape', () => {
  const s = fold([
    start('a', 1000),
    { t: 'step', id: 'a', text: 'Editing x.txt', ts: 2000 },
    { t: 'end', id: 'a', ok: true, ms: 5000, summary: 'Done.', ts: 6000 },
  ])
  const [run] = recentRuns(s)
  assert.deepEqual(
    { ...run, pid: undefined },
    {
      id: 'a', agent: 'coder', task: 'task a', state: 'done', startedAt: 1000, endedAt: 6000, ms: 5000,
      steps: [{ text: 'Editing x.txt', ts: 2000 }], summary: 'Done.', full: false, pid: undefined,
    },
  )
})

test('reducer: a failed end is failed; steps keep only the last five', () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({ t: 'step', id: 'a', text: `s${i}`, ts: 1000 + i }))
  const s = fold([start('a', 1000), ...steps, { t: 'end', id: 'a', ok: false, ms: 9, summary: 'boom', ts: 2000 }])
  const run = s.runs.a
  assert.equal(run.state, 'failed')
  assert.equal(run.steps.length, MAX_STEPS)
  assert.deepEqual(run.steps.map((x) => x.text), ['s3', 's4', 's5', 's6', 's7'])
})

test('reducer: unknown ids, malformed events, a second start and anything after the end are ignored', () => {
  let s = emptyTeam()
  for (const ev of [
    { t: 'step', id: 'ghost', text: 'x', ts: 1 },
    { t: 'end', id: 'ghost', ok: true, ts: 1 },
    { t: 'start', ts: 1 },
    null,
    'nonsense',
    { t: 'bogus', id: 'a' },
  ]) {
    const r = reduceTeam(s, ev)
    assert.equal(r.run, null)
    s = r.state
  }
  assert.deepEqual(s, emptyTeam())

  s = fold([start('a', 10), start('a', 99, { agent: 'writer' }), { t: 'end', id: 'a', ok: true, ms: 1, summary: 'first', ts: 20 }])
  assert.equal(reduceTeam(s, { t: 'end', id: 'a', ok: false, summary: 'second', ts: 30 }).run, null)
  assert.equal(reduceTeam(s, { t: 'step', id: 'a', text: 'late', ts: 31 }).run, null)
  assert.equal(s.runs.a.agent, 'coder')
  assert.equal(s.runs.a.summary, 'first')
})

test('reducer: runs are listed newest first whatever order they started in the file', () => {
  const s = fold([start('b', 2000), start('a', 1000), start('c', 3000)])
  assert.deepEqual(recentRuns(s).map((r) => r.id), ['c', 'b', 'a'])
})

test('reducer: keeps the 30 most recent runs', () => {
  const evs = Array.from({ length: MAX_RUNS + 5 }, (_, i) => start(`r${i}`, 1000 + i))
  const s = fold(evs)
  assert.equal(Object.keys(s.runs).length, MAX_RUNS)
  assert.ok(!s.runs.r0 && !s.runs.r4 && s.runs.r5 && s.runs[`r${MAX_RUNS + 4}`])
  // An event for a run that has aged out is an unknown id now.
  assert.equal(reduceTeam(s, { t: 'end', id: 'r0', ok: true, ts: 1 }).run, null)
})

// A pinned agent's last runs, then 40 newer runs by one busy agent.
const pinnedHistory = () => [
  ...['s0', 's1', 's2', 's3'].flatMap((id, i) => [
    start(id, 1000 + i * 10, { agent: 'researcher' }),
    { t: 'end', id, ok: true, ms: 5, summary: `researcher ${id}`, ts: 1005 + i * 10 },
  ]),
  ...Array.from({ length: 40 }, (_, i) => start(`c${i}`, 2000 + i)),
]

test('reducer: a pinned agent keeps its last three runs however many newer runs others make', () => {
  const s = fold(pinnedHistory())
  const ids = recentRuns(s).map((r) => r.id)
  for (const id of ['s1', 's2', 's3']) {
    assert.ok(s.runs[id], id)
    assert.ok(ids.includes(id), id)
  }
  assert.equal(s.runs.s3.state, 'done')
  assert.equal(s.runs.s3.summary, 'researcher s3')
  // The fourth researcher run and the oldest coder runs are gone.
  assert.ok(!s.runs.s0 && !ids.includes('s0'))
  for (let i = 0; i < 10; i++) assert.ok(!s.runs[`c${i}`], `c${i}`)
  assert.ok(s.runs.c10 && s.runs.c39)
  assert.equal(recentRuns(s).filter((r) => r.agent === 'coder').length, MAX_RUNS)
  assert.ok(Object.keys(s.runs).length <= MAX_RUNS + PINNED_IDS.length * PINNED_JOBS)
  assert.ok(ids.length <= MAX_RUNS + PINNED_IDS.length * PINNED_JOBS)
  // Newest first: the coder runs, then the kept researcher runs.
  assert.deepEqual(ids.slice(-3), ['s3', 's2', 's1'])
  // An event for the dropped one is an unknown id now.
  assert.equal(reduceTeam(s, { t: 'step', id: 's0', text: 'late', ts: 9 }).run, null)
})

test('feed: a fresh feed over the log has the pinned runs again (survives a bridge restart)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-team-'))
  const file = join(dir, 'activity.jsonl')
  writeFileSync(file, pinnedHistory().map((o) => `${JSON.stringify(o)}\n`).join(''))
  const feed = createTeamFeed({ file, alive: () => true, now: () => 3000, pollMs: 60_000, sweepMs: 60_000 }).start()
  try {
    const snap = feed.snapshot()
    assert.deepEqual(snap.filter((r) => r.agent === 'researcher').map((r) => [r.id, r.state]), [['s3', 'done'], ['s2', 'done'], ['s1', 'done']])
    assert.equal(snap.filter((r) => r.agent === 'coder').length, MAX_RUNS)
    assert.ok(snap.length <= MAX_RUNS + PINNED_IDS.length * PINNED_JOBS)
  } finally {
    feed.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lost: a working run whose connector is gone, or older than 25 minutes', () => {
  const run = fold([start('a', 1000)]).runs.a
  assert.equal(isLost(run, 2000, () => true), false)
  assert.equal(isLost(run, 2000, () => false), true)
  assert.equal(isLost(run, 1000 + LOST_AFTER_MS, () => true), true)
  const done = fold([start('b', 1000), { t: 'end', id: 'b', ok: true, ms: 1, ts: 2 }]).runs.b
  assert.equal(isLost(done, 1e12, () => false), false)
})

// -------------------------------------------------------------------- feed

const line = (o) => `${JSON.stringify(o)}\n`

test('feed: replays the log, then reports appended events, lost runs, rotation and truncation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-team-'))
  const file = join(dir, 'activity.jsonl')
  const seen = []
  let alive = true
  const feed = createTeamFeed({ file, onRun: (run, ev) => seen.push([ev.t, run.id, run.state]), alive: () => alive, now: () => 5000 })
  try {
    // No file yet: nothing, and no error.
    feed.poll()
    assert.deepEqual(feed.snapshot(), [])

    writeFileSync(file, line(start('a', 1000)) + line({ t: 'end', id: 'a', ok: true, ms: 1, summary: 'ok', ts: 1001 }))
    feed.poll()
    assert.deepEqual(feed.snapshot().map((r) => [r.id, r.state]), [['a', 'done']])

    // Half a line, then the rest: one event, once.
    const half = line(start('b', 2000))
    appendFileSync(file, half.slice(0, 10))
    feed.poll()
    appendFileSync(file, half.slice(10))
    feed.poll()
    assert.deepEqual(seen.filter(([, id]) => id === 'b'), [['start', 'b', 'working']])
    assert.equal('pid' in feed.snapshot()[0], false) // the pid stays in the bridge

    // Its connector dies: lost on the next sweep, and an end still wins.
    alive = false
    feed.sweep()
    assert.deepEqual(seen.at(-1), ['lost', 'b', 'lost'])
    appendFileSync(file, line({ t: 'end', id: 'b', ok: true, ms: 3, summary: 'late', ts: 2003 }))
    feed.poll()
    assert.deepEqual(seen.at(-1), ['end', 'b', 'done'])
    alive = true

    // Rotation: the tail of the old file is read from .1, then the new file.
    appendFileSync(file, line(start('c', 3000)))
    renameSync(file, `${file}.1`)
    writeFileSync(file, line({ t: 'step', id: 'c', text: 'Editing c.txt', ts: 3001 }))
    feed.poll()
    const c = feed.snapshot().find((r) => r.id === 'c')
    assert.equal(c.state, 'working')
    assert.deepEqual(c.steps.map((s) => s.text), ['Editing c.txt'])

    // Truncation: starts again from the top; known runs are not duplicated.
    writeFileSync(file, line(start('d', 4000)))
    feed.poll()
    assert.deepEqual(feed.snapshot().map((r) => r.id), ['d', 'c', 'b', 'a'])
  } finally {
    feed.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('feed: a run started before a rotation is found in the .1 at start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-team-'))
  const file = join(dir, 'activity.jsonl')
  writeFileSync(`${file}.1`, line(start('old', 1000)))
  writeFileSync(file, line({ t: 'end', id: 'old', ok: false, ms: 5, summary: 'no', ts: 1005 }))
  const feed = createTeamFeed({ file, alive: () => true, now: () => 2000, pollMs: 60_000, sweepMs: 60_000 }).start()
  try {
    assert.deepEqual(feed.snapshot().map((r) => [r.id, r.state]), [['old', 'failed']])
  } finally {
    feed.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- full flag, retention

test('reducer: full is false until an end event says the full result was kept', () => {
  const s = fold([
    start('a', 1000),
    start('b', 1001),
    { t: 'end', id: 'a', ok: true, ms: 1, summary: 'kept', ts: 1100, full: true },
    { t: 'end', id: 'b', ok: true, ms: 1, summary: 'not kept', ts: 1101 },
  ])
  assert.equal(s.runs.a.full, true)
  assert.equal(s.runs.b.full, false)
  assert.equal(fold([start('c', 1)]).runs.c.full, false)
})

test('reducer: every agent, not only the pinned ones, keeps its last three runs', () => {
  const quiet = AGENT_IDS.find((id) => id !== 'coder' && !PINNED_IDS.includes(id))
  assert.ok(quiet, 'the roster has an agent that is not pinned')
  const s = fold([
    ...['q0', 'q1', 'q2', 'q3'].map((id, i) => start(id, 1000 + i, { agent: quiet })),
    ...Array.from({ length: 40 }, (_, i) => start(`c${i}`, 2000 + i)),
  ])
  const ids = recentRuns(s).map((r) => r.id)
  assert.deepEqual(ids.filter((id) => id.startsWith('q')), ['q3', 'q2', 'q1'])
  assert.ok(!s.runs.q0)
  assert.equal(ids.filter((id) => id.startsWith('c')).length, MAX_RUNS)
  assert.ok(Object.keys(s.runs).length <= MAX_RUNS + AGENT_IDS.length * PINNED_JOBS)
})

// ------------------------------------------------------------ runsForAgent

const withLog = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-team-'))
  try {
    return fn(join(dir, 'activity.jsonl'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('runsForAgent: every run of one agent from both files, newest first, past the 30-run bound', () => {
  withLog((file) => {
    const old = []
    const cur = []
    for (let i = 0; i < 45; i++) {
      const id = `s${i}`
      const target = i < 20 ? old : cur
      target.push(start(id, 1000 + i * 10, { agent: 'researcher' }), start(`o${i}`, 1001 + i * 10, { agent: 'writer' }))
      target.push({ t: 'end', id, ok: i % 2 === 0, ms: 5, summary: `researcher ${i}`, ts: 1005 + i * 10, ...(i === 44 ? { full: true } : {}) })
    }
    // A run started before the rotation and ended after it.
    old.push(start('across', 900, { agent: 'researcher' }))
    cur.unshift({ t: 'end', id: 'across', ok: true, ms: 1, summary: 'across', ts: 2000 })
    writeFileSync(`${file}.1`, old.map(line).join('') + 'torn {"t":"sta\n')
    writeFileSync(file, `not json\n${cur.map(line).join('')}`)

    const runs = runsForAgent({ file, agent: 'researcher', now: 5000, alive: () => true })
    assert.equal(runs.length, 46)
    assert.ok(runs.every((r) => r.agent === 'researcher'))
    assert.equal(runs[0].id, 's44')
    assert.equal(runs[0].full, true)
    assert.equal(runs[1].full, false)
    assert.equal(runs.at(-1).id, 'across')
    assert.equal(runs.at(-1).state, 'done')
    assert.deepEqual(runs.slice(0, 2).map((r) => r.state), ['done', 'failed'])
    assert.ok(runs.every((r) => !('pid' in r)))
    assert.equal(runsForAgent({ file, agent: 'researcher', limit: 5, now: 5000, alive: () => true }).length, 5)
    assert.equal(runsForAgent({ file, agent: 'writer', now: 5000, alive: () => true }).length, 45)
    assert.deepEqual(runsForAgent({ file, agent: 'nobody' }), [])
  })
})

test('runsForAgent: up to maxSteps steps per run (100 by default)', () => {
  withLog((file) => {
    const steps = Array.from({ length: 130 }, (_, i) => ({ t: 'step', id: 'a', text: `s${i}`, ts: 1001 + i }))
    writeFileSync(file, [start('a', 1000), ...steps, { t: 'end', id: 'a', ok: true, ms: 1, ts: 2000 }].map(line).join(''))
    const [run] = runsForAgent({ file, agent: 'coder', now: 3000, alive: () => true })
    assert.equal(run.steps.length, 100)
    assert.equal(run.steps.at(-1).text, 's129')
    const [few] = runsForAgent({ file, agent: 'coder', maxSteps: 3, now: 3000, alive: () => true })
    assert.deepEqual(few.steps.map((s) => s.text), ['s127', 's128', 's129'])
  })
})

test('runsForAgent: a working run whose connector is gone is lost; missing log is []', () => {
  withLog((file) => {
    assert.deepEqual(runsForAgent({ file, agent: 'coder' }), [])
    writeFileSync(file, line(start('w', 1000)) + line(start('x', 1001)))
    assert.deepEqual(runsForAgent({ file, agent: 'coder', now: 2000, alive: () => true }).map((r) => r.state), ['working', 'working'])
    assert.deepEqual(runsForAgent({ file, agent: 'coder', now: 2000, alive: () => false }).map((r) => r.state), ['lost', 'lost'])
    assert.deepEqual(runsForAgent({ file, agent: 'coder', now: 1001 + LOST_AFTER_MS, alive: () => true }).map((r) => r.state), ['lost', 'lost'])
  })
})
