/**
 * The pinned agents: the ones the owner always sees on the team dock, with
 * their latest jobs spelled out. Shared, like the roster, by the bridge (which
 * must keep their history when busier agents would push it out of the recent
 * runs) and by the HUD (which draws it). Pure functions only: no I/O, no
 * clock of their own.
 *
 * A "run" here is the shape bridge/team.mjs folds out of the activity log:
 *   { id, agent, task, state, startedAt, endedAt, ms, steps: [{ text, ts }], summary }
 * Every string in a run was written by an agent or about one. Nothing here
 * turns it into markup; the HUD renders what comes back as text.
 */

/** How many of each pinned agent's latest runs are kept and shown. */
export const PINNED_JOBS = 3
export const HEADLINE_CAP = 80
export const LINE_CAP = 160

const byNewest = (a, b) => (b.startedAt || 0) - (a.startedAt || 0)

/**
 * Which runs to keep, newest first: the `max` most recent of all, plus the
 * `perPinned` most recent of each agent id in `pinned` (the caller's list; none
 * by default). So the result never exceeds `max + pinned.length * perPinned`,
 * and those agents' last jobs survive however many runs the rest make.
 */
export function keepRuns(runs, max, pinned = [], perPinned = PINNED_JOBS) {
  const sorted = [...runs].sort(byNewest)
  const keep = new Set(sorted.slice(0, Math.max(0, max)))
  for (const id of pinned) {
    let n = 0
    for (const r of sorted) {
      if (r.agent !== id) continue
      if (n++ >= perPinned) break
      keep.add(r)
    }
  }
  return sorted.filter((r) => keep.has(r))
}

const oneLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')
const cut = (s, cap) => (s.length > cap ? `${s.slice(0, cap - 1).trimEnd()}…` : s)

/** A task as a headline: its first sentence, on one line, at most `cap` long. */
export function headline(task, cap = HEADLINE_CAP) {
  const t = oneLine(task)
  const stop = t.search(/[.!?:](?:\s|$)/)
  return cut(stop > 0 ? t.slice(0, stop) : t, cap) || 'Untitled job'
}

/** A summary (or step) as one line, at most `cap` long. */
export const summaryLine = (text, cap = LINE_CAP) => cut(oneLine(text), cap)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * When something ended, for the dock: "just now", "5m ago", "2h ago", and past
 * a day the date in local time ("10 Nov", with the year when it is not this
 * one). A time in the future (clock skew) reads as "just now".
 */
export function when(ts, now) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
  const m = Math.floor((now - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`
  const d = new Date(ts)
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${d.getFullYear()}`
}

/**
 * One pinned agent's latest jobs, newest first, at most `limit`:
 *   { id, state, headline, when, line, startedAt }
 * `state` is the run's own (working / done / failed / lost). A finished job's
 * `when` is when it ended and its `line` one line of the result summary. A
 * working job has `when: 'now'` and its latest step as `line`.
 */
export function jobsFor(runs, agent, now, limit = PINNED_JOBS) {
  return runs
    .filter((r) => r && r.agent === agent)
    .sort(byNewest)
    .slice(0, limit)
    .map((r) => {
      const working = r.state === 'working'
      const steps = Array.isArray(r.steps) ? r.steps : []
      return {
        id: r.id,
        state: r.state,
        headline: headline(r.task),
        when: working ? 'now' : when(r.endedAt ?? r.startedAt, now),
        line: working ? summaryLine(steps[steps.length - 1]?.text) || 'Working' : summaryLine(r.summary),
        startedAt: r.startedAt,
      }
    })
}
