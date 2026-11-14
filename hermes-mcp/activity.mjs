/**
 * The team activity log: what every agent run is doing, for the HUD's team
 * dock. The connector is the one place every run passes through (the voice
 * brain, the Hermes desktop chat and scripts all call it), so it records here
 * and the bridge only reads.
 *
 * One JSON object per line in `activity.jsonl` under VENOM_AGENTS_DIR
 * (default ~/.venom/agents):
 *   { t: 'start', id, agent, task, ts, pid }
 *   { t: 'step',  id, text, ts }
 *   { t: 'end',   id, ok, ms, summary, ts, full? }
 * `pid` is this connector's process: while it lives, an end can still come.
 * `full: true` says the run's complete answer was kept in runs/<id>.md
 * (runfiles.mjs). The file is written before the end event, so a reader that
 * sees the flag finds the file.
 *
 * Steps are short headlines only. With -Q, the one thing Hermes prints while
 * it works is the diff of each file edit: a header line naming the file, then
 * the hunks. Only the file name is kept ("Editing notes.txt"); diff bodies,
 * file contents, command output and page text never are. When nothing
 * trustworthy has come for 15 seconds a heartbeat ("Working, 45s") is written
 * instead of a guess. Gemini prints one JSON envelope at the end, so it gets
 * start, heartbeats and end.
 *
 * Every string passes the shared secret check first. Recording must never
 * break or slow a run: every error is caught, logged as one stderr line, and
 * the run carries on. VENOM_AGENT_ACTIVITY=0 turns it off.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { redactSecrets } from '../bridge/secrets.mjs'
import { activityConfig, ANSI, dropFramed, KEEP_DAYS, writeRunFile } from './runfiles.mjs'

// The settings and the retention live in runfiles.mjs (which must not import
// this module); re-exported so callers keep importing them from here.
export { activityConfig, KEEP_DAYS }

export const TASK_CAP = 300
export const SUMMARY_CAP = 600
export const STEP_CAP = 160
export const STEP_GAP_MS = 1000
export const HEARTBEAT_MS = 15_000
export const ROTATE_BYTES = 2 * 1024 * 1024

const warn = (what, err) => {
  try {
    process.stderr.write(`[hermes-mcp] activity ${what} failed: ${err?.message ?? err}\n`)
  } catch {
    // stderr itself is gone; nothing left to tell.
  }
}

// The box-drawing / block characters Hermes frames its output with. ANSI (the
// escape sequences) comes from runfiles.mjs.
const BOX = /[\u2500-\u259f]/g

/** Plain one-line text: no ANSI, no box drawing, whitespace collapsed. */
export const plain = (s) =>
  String(s ?? '').replace(ANSI, '').replace(BOX, ' ').replace(/\s+/g, ' ').trim()

/** Plain, redacted, and cut to `cap` characters. */
export const clip = (s, cap) => {
  const t = redactSecrets(plain(s))
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t
}

/** A path as its last two segments ("work\notes.txt"): names the file without
 *  spelling out the whole folder tree, and fits a dock row. */
const shortPath = (p, room) => {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  const tail = parts.length > 2 ? parts.slice(-2).join(p.includes('\\') ? '\\' : '/') : p
  return tail.length <= room ? tail : `…${tail.slice(-(room - 1))}`
}

/**
 * Hermes's answer as a summary: the framed lines (`│ ...`, the edit diffs
 * Hermes prints while it works) are dropped, so no diff body or file content
 * reaches the log.
 */
export const answerText = (out) => dropFramed(out)

/**
 * The headline in one line of Hermes stdout, or null.
 *
 * Hermes -Q frames a file edit as `│ <file>` followed by hunk lines
 * `│ @@ ... @@`, `│ +added`, `│ -removed` and `│  context` (note the second
 * space). So a framed line whose text starts with none of `@ + -` or a space,
 * and that looks like a path, is the file header. Everything else is either
 * body text or the final answer, and is not a step.
 */
export function stepFromLine(raw) {
  const rawLine = String(raw ?? '')
  // In colour, the header is the one framed line printed in bold; hunk lines
  // are coloured but never bold. Without colour, the shape test below decides.
  if (rawLine.includes('\x1b[') && !rawLine.includes('\x1b[1m')) return null
  const line = rawLine.replace(ANSI, '').replace(/\r$/, '')
  const m = /^\s*[│┃]\s(\S.*)$/.exec(line)
  if (!m) return null
  const name = m[1].trimEnd()
  if (name.length > 400 || /^[@+-]|^\.\.|^…/.test(name)) return null
  // A path: path characters only, ending in a file extension or after a separator.
  if (!/^(?:[A-Za-z]:)?[\w~.\\/()\- ]+$/.test(name)) return null
  if (!/\.[A-Za-z0-9]{1,10}$/.test(name) && !/[\\/][\w.-]+$/.test(name)) return null
  return `Editing ${shortPath(name, STEP_CAP - 8)}`
}

/** The headlines in a block of stdout, in order. Used by tests and the recorder. */
export const stepsFromText = (text) =>
  String(text ?? '')
    .split(/\n/)
    .map(stepFromLine)
    .filter(Boolean)

/** Rotate when the log has passed ROTATE_BYTES: one `.1` is kept. */
function rotateIfBig(cfg) {
  try {
    if (statSync(cfg.file).size > ROTATE_BYTES) renameSync(cfg.file, `${cfg.file}.1`)
  } catch (err) {
    if (err?.code !== 'ENOENT') warn('rotate', err)
  }
}

/** Append one event: one write, one line. Never throws. */
export function appendEvent(event, cfg = activityConfig()) {
  if (!cfg.enabled) return false
  try {
    mkdirSync(cfg.dir, { recursive: true })
    rotateIfBig(cfg)
    appendFileSync(cfg.file, `${JSON.stringify(event)}\n`)
    return true
  } catch (err) {
    warn('write', err)
    return false
  }
}

/**
 * Drop events older than KEEP_DAYS from the log and its `.1`. Run at connector
 * start. Rewrites a file only when something was dropped, via a temp file and
 * a rename, so a reader never sees half a file. Returns how many went.
 */
export function pruneActivity(cfg = activityConfig(), now = Date.now()) {
  if (!cfg.enabled) return 0
  const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000
  let dropped = 0
  for (const file of [cfg.file, `${cfg.file}.1`]) {
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      const kept = lines.filter((l) => {
        try {
          return Number(JSON.parse(l).ts) >= cutoff
        } catch {
          return false
        }
      })
      if (kept.length === lines.length) continue
      dropped += lines.length - kept.length
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '')
      renameSync(tmp, file)
    } catch (err) {
      if (err?.code !== 'ENOENT') warn('prune', err)
    }
  }
  return dropped
}

/**
 * Start recording one run. Returns `{ id, feed(chunk), step(text), tick(), end(result) }`;
 * `end({ ok, text, full })` takes the summary from `text` and keeps the
 * complete answer (`full`, or `text` when there is none) in the run file.
 * none of them throws. `live: false` (gemini, claude) skips the stdout reader and
 * relies on heartbeats. `timers: false` and `now` are for tests, which drive
 * `tick()` by hand.
 */
export function startRun(
  { agent, task, live = true },
  { cfg = activityConfig(), now = Date.now, timers = true, pid = process.pid } = {},
) {
  const noop = { id: null, feed() {}, step() {}, tick() {}, end() {} }
  if (!cfg.enabled) return noop
  try {
    const id = `${now().toString(36)}-${randomUUID().slice(0, 8)}`
    const startedAt = now()
    appendEvent({ t: 'start', id, agent, task: clip(task, TASK_CAP), ts: startedAt, pid }, cfg)

    let lastText = null
    let lastAt = startedAt // a heartbeat is due HEARTBEAT_MS after the start
    let lastStepAt = 0
    let pending = null
    let partial = ''
    let ended = false
    let timer = null

    const write = (text) => {
      const t = clip(text, STEP_CAP)
      if (!t || t === lastText) return
      lastText = t
      lastStepAt = lastAt = now()
      appendEvent({ t: 'step', id, text: t, ts: lastAt }, cfg)
    }

    // At most one step a second; a newer headline replaces one still waiting.
    const step = (text) => {
      if (ended) return
      try {
        if (now() - lastStepAt >= STEP_GAP_MS) {
          pending = null
          write(text)
        } else {
          pending = text
        }
      } catch (err) {
        warn('step', err)
      }
    }

    const tick = () => {
      if (ended) return
      try {
        const t = now()
        if (pending && t - lastStepAt >= STEP_GAP_MS) {
          const p = pending
          pending = null
          write(p)
        } else if (t - lastAt >= HEARTBEAT_MS) {
          // Not deduplicated against the last step: the seconds change.
          lastText = null
          write(`Working, ${Math.round((t - startedAt) / 1000)}s`)
        }
      } catch (err) {
        warn('tick', err)
      }
    }

    const feed = (chunk) => {
      if (ended || !live) return
      try {
        const lines = (partial + String(chunk)).split('\n')
        partial = lines.pop() ?? ''
        if (partial.length > 8192) partial = '' // a runaway line is body text
        for (const l of lines) {
          const s = stepFromLine(l)
          if (s) step(s)
        }
      } catch (err) {
        warn('read', err)
      }
    }

    const end = ({ ok, text, full } = {}) => {
      if (ended) return
      ended = true
      try {
        if (timer) clearInterval(timer)
        if (pending && live) write(pending)
        const t = now()
        const summary = clip(answerText(text), SUMMARY_CAP)
        // The file first, so the flag is never ahead of it. A failed write
        // only costs the flag, never the end event.
        let kept = false
        try {
          kept = writeRunFile(id, full ?? text, cfg)
        } catch (err) {
          warn('run file', err)
        }
        const event = { t: 'end', id, ok: Boolean(ok), ms: t - startedAt, summary, ts: t }
        if (kept) event.full = true
        appendEvent(event, cfg)
      } catch (err) {
        warn('end', err)
      }
    }

    if (timers) {
      timer = setInterval(tick, 500)
      timer.unref?.()
    }
    return { id, feed, step, tick, end }
  } catch (err) {
    warn('start', err)
    return noop
  }
}
