/**
 * The team dock's data: the agent activity log (written by the Hermes team
 * connector, see hermes-mcp/activity.mjs) folded into runs, and a tail on that
 * log so new events reach the HUD as they are appended.
 *
 * reduceTeam() is pure. Whether a run whose connector has died is `lost` is
 * decided here in the bridge (applyLost), from the recorded pid and the clock.
 *
 * Retention: the MAX_RUNS most recent runs of all, plus the last PINNED_JOBS
 * runs of every agent on the roster (keepRuns from hermes-mcp/pinned.mjs, given
 * AGENT_IDS as the agents to keep), so each agent's tile has its latest jobs
 * however many runs the rest of the team makes: at most MAX_RUNS +
 * AGENT_IDS.length * PINNED_JOBS runs. The feed rebuilds this from the log, so
 * it survives a bridge restart too. runsForAgent() reads one agent's whole
 * history (both log files) for the tile's job list, without that bound.
 */
import { closeSync, existsSync, openSync, readSync, readFileSync, statSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { keepRuns } from '../hermes-mcp/pinned.mjs'
import { AGENT_IDS } from '../hermes-mcp/agents.mjs'

export const MAX_RUNS = 30
export const MAX_STEPS = 5
export const LOST_AFTER_MS = 25 * 60 * 1000

export const emptyTeam = () => ({ runs: {} })

const str = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '')

/**
 * Fold one event into the state. Returns `{ state, run }`: the new state and
 * the run the event touched, or `run: null` when the event was ignored
 * (malformed, unknown id, a second start, anything after the end).
 *
 * `maxRuns` (default MAX_RUNS; Infinity keeps every run) and `maxSteps`
 * (default MAX_STEPS) are for runsForAgent, which wants a whole history.
 */
export function reduceTeam(state, ev, { maxRuns = MAX_RUNS, maxSteps = MAX_STEPS } = {}) {
  if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || !ev.id) return { state, run: null }
  const prev = state.runs[ev.id]
  let run = null

  if (ev.t === 'start') {
    if (prev || typeof ev.agent !== 'string') return { state, run: null }
    run = {
      id: ev.id,
      agent: ev.agent,
      task: str(ev.task, 300),
      state: 'working',
      startedAt: Number(ev.ts) || 0,
      endedAt: null,
      ms: null,
      steps: [],
      summary: '',
      full: false,
      pid: Number.isInteger(ev.pid) ? ev.pid : null,
    }
  } else if (ev.t === 'step') {
    if (!prev || prev.state !== 'working') return { state, run: null }
    const text = str(ev.text, 160)
    if (!text) return { state, run: null }
    run = { ...prev, steps: [...prev.steps, { text, ts: Number(ev.ts) || 0 }].slice(-maxSteps) }
  } else if (ev.t === 'end') {
    if (!prev || prev.state !== 'working') return { state, run: null }
    const endedAt = Number(ev.ts) || 0
    run = {
      ...prev,
      state: ev.ok ? 'done' : 'failed',
      endedAt,
      ms: Number.isFinite(ev.ms) ? ev.ms : Math.max(0, endedAt - prev.startedAt),
      summary: str(ev.summary, 600),
      full: Boolean(ev.full),
    }
  } else {
    return { state, run: null }
  }

  let runs = { ...state.runs, [run.id]: run }
  if (Object.keys(runs).length > maxRuns) {
    // Keep the most recent maxRuns by start time, plus every agent's latest
    // PINNED_JOBS; the rest go.
    const keep = new Set(keepRuns(Object.values(runs), maxRuns, AGENT_IDS).map((r) => r.id))
    runs = Object.fromEntries(Object.entries(runs).filter(([id]) => keep.has(id)))
    if (!keep.has(run.id)) return { state: { runs }, run: null }
  }
  return { state: { runs }, run }
}

/**
 * The runs, newest first: the `limit` most recent, plus every agent's latest
 * PINNED_JOBS (so at most `limit + AGENT_IDS.length * PINNED_JOBS`).
 */
export const recentRuns = (state, limit = MAX_RUNS) => keepRuns(Object.values(state.runs), limit, AGENT_IDS)

/** Is a process alive? EPERM means it exists but belongs to someone else. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * A working run with no end is lost when the connector that recorded it has
 * gone (no end can ever come) or after LOST_AFTER_MS, whichever is first.
 */
export function isLost(run, now = Date.now(), alive = pidAlive) {
  if (run.state !== 'working') return false
  if (now - run.startedAt >= LOST_AFTER_MS) return true
  return run.pid != null && !alive(run.pid)
}

/** The run as the HUD should see it. */
export const shown = (run, lost) => {
  const { pid: _pid, ...rest } = run
  return lost ? { ...rest, state: 'lost' } : rest
}

/** The parsed events of one log file, in order; torn or foreign lines skipped. */
function readEvents(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn or foreign line: skip it.
    }
  }
  return out
}

/**
 * One agent's runs from the whole log (its `.1`, then the log itself), newest
 * first, at most `limit`: every run, not only the ones the feed keeps, with
 * up to `maxSteps` steps each. A working run whose connector has gone (or
 * that is too old) is `lost`; the pid is not in what comes back. A pure read:
 * a missing log is no runs.
 */
export function runsForAgent({ file, agent, limit = 200, maxSteps = 100, now = Date.now(), alive = pidAlive }) {
  if (typeof file !== 'string' || !file || typeof agent !== 'string' || !agent) return []
  const ids = new Set()
  let state = emptyTeam()
  for (const ev of [...readEvents(`${file}.1`), ...readEvents(file)]) {
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string') continue
    if (ev.t === 'start' && ev.agent === agent && !state.runs[ev.id]) ids.add(ev.id)
    if (!ids.has(ev.id)) continue
    state = reduceTeam(state, ev, { maxRuns: Infinity, maxSteps }).state
  }
  return Object.values(state.runs)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, Math.max(0, limit))
    .map((run) => shown(run, isLost(run, now, alive)))
}

/**
 * Tail the activity log: replay what is there, then report each appended
 * event. fs.watch on the folder plus a one-second poll, because Windows drops
 * some watch events. Only the bytes added since the last read are read. A
 * missing file, a rotation (new file identity) or a truncation (smaller than
 * what was read) starts again from the top of the new file; replayed starts
 * already known are ignored by the reducer, so nothing is counted twice.
 */
export function createTeamFeed({
  file,
  onRun = () => {},
  pollMs = 1000,
  sweepMs = 5000,
  now = Date.now,
  alive = pidAlive,
  log = (m) => console.error(m),
}) {
  let state = emptyTeam()
  const lost = new Set()
  let offset = 0
  let identity = null
  let partial = Buffer.alloc(0)
  let watcher = null
  let timers = []
  let reading = false

  const view = (run) => shown(run, lost.has(run.id))

  const apply = (ev) => {
    const r = reduceTeam(state, ev)
    state = r.state
    // An end after all (the connector outlived the check): the end wins.
    if (r.run && ev.t === 'end') lost.delete(r.run.id)
    if (r.run) onRun(view(r.run), ev)
  }

  // Bytes, not strings, until a whole line is in: a read can stop half way
  // through a multi-byte character.
  const consume = (bytes) => {
    let buf = partial.length ? Buffer.concat([partial, bytes]) : bytes
    let nl
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl).toString('utf8')
      buf = buf.subarray(nl + 1)
      if (!line.trim()) continue
      try {
        apply(JSON.parse(line))
      } catch {
        // A torn or foreign line: skip it.
      }
    }
    partial = Buffer.from(buf)
  }

  const readFrom = (path, from, to) => {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, to - from))
      let got = 0
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, from + got)
        if (!n) break
        got += n
      }
      return buf.subarray(0, got)
    } finally {
      closeSync(fd)
    }
  }

  const identityOf = (st) => `${st.dev}:${st.ino}:${st.birthtimeMs}`

  const poll = () => {
    if (reading) return
    reading = true
    try {
      let st
      try {
        st = statSync(file)
      } catch {
        offset = 0
        identity = null
        partial = Buffer.alloc(0)
        return
      }
      const id = identityOf(st)
      // Rewritten in place (same file, truncated and refilled past where we
      // were)? The bytes just before our offset are no longer what we read.
      let rewritten = false
      if (identity === id && offset > 0 && st.size >= offset) {
        const tail = partial.length ? partial : Buffer.from('\n')
        rewritten = !readFrom(file, offset - tail.length, offset).equals(tail)
      }
      if (identity !== id || st.size < offset || rewritten) {
        // Rotated: whatever was appended to the old file after the last read
        // is now at the end of the `.1`.
        if (identity && identity !== id) {
          try {
            const old = statSync(`${file}.1`)
            if (identityOf(old) === identity && old.size > offset) {
              consume(readFrom(`${file}.1`, offset, old.size))
            }
          } catch {
            // No rotated file: it was deleted or truncated instead.
          }
        }
        identity = id
        offset = 0
        partial = Buffer.alloc(0)
      }
      if (st.size > offset) {
        const bytes = readFrom(file, offset, st.size)
        offset += bytes.length
        consume(bytes)
      }
    } catch (err) {
      log(`[venom] team activity read failed: ${err?.message ?? err}`)
    } finally {
      reading = false
    }
  }

  const sweep = () => {
    const t = now()
    for (const run of Object.values(state.runs)) {
      if (!lost.has(run.id) && isLost(run, t, alive)) {
        lost.add(run.id)
        onRun(view(run), { t: 'lost', id: run.id, ts: t })
      }
    }
  }

  const watchDir = () => {
    if (watcher) return
    const dir = dirname(file)
    if (!existsSync(dir)) return
    try {
      watcher = watch(dir, (_type, name) => {
        if (!name || String(name).startsWith(basename(file))) poll()
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null
    }
  }

  return {
    start() {
      // The rotated half first, so a run that started before a rotation
      // still has its start when its end arrives in the new file.
      try {
        consume(Buffer.concat([readFileSync(`${file}.1`), Buffer.from('\n')]))
        partial = Buffer.alloc(0)
      } catch {
        // No rotated file yet.
      }
      poll()
      sweep()
      watchDir()
      timers = [
        setInterval(() => {
          watchDir()
          poll()
        }, pollMs),
        setInterval(sweep, sweepMs),
      ]
      for (const t of timers) t.unref?.()
      return this
    },
    poll,
    sweep,
    snapshot: (limit = MAX_RUNS) => recentRuns(state, limit).map(view),
    stop() {
      for (const t of timers) clearInterval(t)
      timers = []
      watcher?.close()
      watcher = null
    },
  }
}
