// The pinned agents' rules (hermes-mcp/pinned.mjs): which runs are kept, and
// how a job reads on the dock. Pure functions: no files, no real clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  headline,
  jobsFor,
  keepRuns,
  summaryLine,
  when,
  HEADLINE_CAP,
  LINE_CAP,
  PINNED_JOBS,
} from '../hermes-mcp/pinned.mjs'
import * as pinnedModule from '../hermes-mcp/pinned.mjs'

const run = (id, agent, startedAt, extra = {}) => ({
  id, agent, task: `task ${id}`, state: 'done', startedAt, endedAt: startedAt + 10, ms: 10, steps: [], summary: '', ...extra,
})

// The agents to keep are always the caller's (the roster's ids); made up here.
const PINNED = ['researcher', 'coder']

// ---------------------------------------------------------------- keepRuns

test('pinned: three jobs each, and no built-in list of pinned agents', () => {
  assert.equal(PINNED_JOBS, 3)
  assert.equal('PINNED_IDS' in pinnedModule, false)
})

test('keepRuns: the max most recent of all plus each given agent\'s latest, newest first', () => {
  const runs = [
    ...Array.from({ length: 10 }, (_, i) => run(`w${i}`, 'writer', 100 + i)),
    ...Array.from({ length: 5 }, (_, i) => run(`c${i}`, 'coder', 1 + i)),
    run('r0', 'researcher', 0),
    run('o0', 'operator', 50),
  ]
  const before = JSON.stringify(runs)
  const kept = keepRuns(runs, 3, PINNED)
  assert.deepEqual(kept.map((r) => r.id), ['w9', 'w8', 'w7', 'c4', 'c3', 'c2', 'r0'])
  // Not given: no extra for operator or the older writer runs.
  assert.ok(!kept.some((r) => r.agent === 'operator'))
  assert.ok(kept.length <= 3 + PINNED.length * PINNED_JOBS)
  // The input is left as it was (same order, same objects).
  assert.equal(JSON.stringify(runs), before)
  // No ids given: only the max most recent.
  assert.deepEqual(keepRuns(runs, 3).map((r) => r.id), ['w9', 'w8', 'w7'])
})

test('keepRuns: a pinned run already among the most recent is not counted twice', () => {
  const runs = [run('r0', 'researcher', 10), run('r1', 'researcher', 20), run('w0', 'writer', 15)]
  assert.deepEqual(keepRuns(runs, 2, PINNED).map((r) => r.id), ['r1', 'w0', 'r0'])
  assert.deepEqual(keepRuns(runs, 10, PINNED).map((r) => r.id), ['r1', 'w0', 'r0'])
  assert.deepEqual(keepRuns([], 5, PINNED), [])
  assert.deepEqual(keepRuns(runs, 0, ['researcher'], 1).map((r) => r.id), ['r1'])
})

test('keepRuns: the size stays bounded whatever the history, for 1, 5 and 12 agents', () => {
  for (const n of [1, 5, 12]) {
    const ids = Array.from({ length: n }, (_, i) => `a${i + 1}`)
    const agents = ['outsider', ...ids]
    const runs = Array.from({ length: 500 }, (_, i) => run(`x${i}`, agents[i % agents.length], i))
    const kept = keepRuns(runs, 30, ids)
    assert.ok(kept.length <= 30 + ids.length * PINNED_JOBS, `n=${n}`)
    for (const id of ids) assert.ok(kept.filter((r) => r.agent === id).length >= PINNED_JOBS, id)
    assert.deepEqual(kept.map((r) => r.startedAt), [...kept.map((r) => r.startedAt)].sort((a, b) => b - a))
    // Max 0 (the HUD's kept-runs store): exactly each agent's newest PINNED_JOBS.
    assert.equal(keepRuns(runs, 0, ids).length, ids.length * PINNED_JOBS, `n=${n} max 0`)
  }
})

// ---------------------------------------------------------- headline, line

test('headline: first sentence, one line, capped, never empty', () => {
  assert.equal(headline('Fix the meta tags. Then report back.'), 'Fix the meta tags')
  assert.equal(headline('Audit the site! Now'), 'Audit the site')
  assert.equal(headline('  Check\n\n  the   titles  '), 'Check the titles')
  assert.equal(headline('example.com audit'), 'example.com audit')
  assert.equal(headline('Audit example.org. Then fix it.'), 'Audit example.org')
  const long = headline('word '.repeat(60))
  assert.equal(long.length, HEADLINE_CAP)
  assert.ok(long.endsWith('…'))
  assert.equal(headline(''), 'Untitled job')
  assert.equal(headline('   '), 'Untitled job')
  assert.equal(headline(null), 'Untitled job')
  assert.equal(headline(undefined), 'Untitled job')
})

test('summaryLine: one line, capped with an ellipsis, empty for nothing', () => {
  assert.equal(summaryLine('Done.\n\nTwelve   fixes, three urgent.'), 'Done. Twelve fixes, three urgent.')
  const long = summaryLine('y'.repeat(500))
  assert.equal(long.length, LINE_CAP)
  assert.ok(long.endsWith('…'))
  assert.equal(summaryLine('y'.repeat(LINE_CAP)), 'y'.repeat(LINE_CAP))
  assert.equal(summaryLine(''), '')
  assert.equal(summaryLine(null), '')
})

// -------------------------------------------------------------------- when

// Local-time timestamps, so the dates read the same in every timezone.
const NOW = new Date(2026, 10, 10, 12).getTime()

test('when: relative inside a day, then the date, with the year when it differs', () => {
  assert.equal(when(NOW - 30_000, NOW), 'just now')
  assert.equal(when(NOW, NOW), 'just now')
  assert.equal(when(NOW - 5 * 60_000, NOW), '5m ago')
  assert.equal(when(NOW - 59 * 60_000, NOW), '59m ago')
  assert.equal(when(NOW - 60 * 60_000, NOW), '1h ago')
  assert.equal(when(NOW - 2 * 3_600_000, NOW), '2h ago')
  assert.equal(when(new Date(2026, 10, 8, 9).getTime(), NOW), '8 Nov')
  assert.equal(when(new Date(2025, 11, 31, 12).getTime(), NOW), '31 Dec 2025')
})

test('when: nothing for no time, "just now" for a time in the future', () => {
  assert.equal(when(null, NOW), '')
  assert.equal(when(undefined, NOW), '')
  assert.equal(when(0, NOW), '')
  assert.equal(when(NaN, NOW), '')
  assert.equal(when(NOW + 10 * 60_000, NOW), 'just now')
})

// ----------------------------------------------------------------- jobsFor

test('jobsFor: one agent\'s latest three, newest first, as the dock shows them', () => {
  const runs = [
    run('old', 'researcher', NOW - 9 * 3_600_000, { task: 'Too old to show', summary: 'gone' }),
    run('done', 'researcher', NOW - 3 * 3_600_000, { task: 'example.com audit. Full.', endedAt: NOW - 2 * 3_600_000, summary: 'Twelve fixes,\n three urgent.' }),
    run('work', 'researcher', NOW - 60_000, {
      state: 'working', endedAt: null, task: 'Check the site',
      steps: [{ text: 'Editing a.md', ts: 1 }, { text: 'Editing b.md', ts: 2 }],
    }),
    run('lost', 'researcher', NOW - 5 * 3_600_000, { state: 'lost', endedAt: null, task: 'Maps listing' }),
    run('other', 'coder', NOW, { task: 'Not mine' }),
  ]
  const jobs = jobsFor(runs, 'researcher', NOW)
  assert.deepEqual(jobs.map((j) => j.id), ['work', 'done', 'lost'])
  assert.deepEqual(jobs[0], { id: 'work', state: 'working', headline: 'Check the site', when: 'now', line: 'Editing b.md', startedAt: NOW - 60_000 })
  assert.deepEqual(jobs[1], {
    id: 'done', state: 'done', headline: 'example.com audit', when: '2h ago', line: 'Twelve fixes, three urgent.', startedAt: NOW - 3 * 3_600_000,
  })
  // Lost passes through as it is; with no end, the start time is used.
  assert.equal(jobs[2].state, 'lost')
  assert.equal(jobs[2].when, '5h ago')
  assert.equal(jobsFor(runs, 'researcher', NOW, 1).length, 1)
})

test('jobsFor: a working job with no steps says Working; nothing gives []', () => {
  const runs = [run('w', 'coder', NOW - 1000, { state: 'working', endedAt: null, steps: [] })]
  assert.equal(jobsFor(runs, 'coder', NOW)[0].line, 'Working')
  assert.deepEqual(jobsFor(runs, 'writer', NOW), [])
  assert.deepEqual(jobsFor([], 'researcher', NOW), [])
  assert.deepEqual(jobsFor([null, run('x', 'researcher', 1)], 'researcher', NOW).map((j) => j.id), ['x'])
})
