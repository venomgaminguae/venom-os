/**
 * Full results: the complete answer of each agent run, one file per run, so
 * the HUD can show more than the 600-character summary in the activity log.
 *
 *   <VENOM_AGENTS_DIR>/runs/<run id>.md
 *
 * The run id (`<start time in base 36>-<8 hex>`, made by startRun in
 * activity.mjs) is the only thing a path is ever built from: runFilePath()
 * refuses anything that does not have exactly that shape, so no caller input
 * can name another file. The text is stored as the summary is, minus the cut:
 * framed Hermes lines (edit diffs) dropped, ANSI removed, secrets redacted,
 * and at most RESULT_CAP_BYTES of UTF-8.
 *
 * Writes go through a temp file and a rename, so a reader never sees half a
 * file. Like the log, nothing here ever throws: an error is one stderr line.
 * Files go after KEEP_DAYS, judged by the start time in the id.
 *
 * This module is imported by activity.mjs, so it must not import it back:
 * the bits both need (settings, the ANSI pattern, the framed-line filter)
 * live here and activity.mjs re-exports them.
 */
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { redactSecrets } from '../bridge/secrets.mjs'

export const RUN_ID = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/
export const RESULT_CAP_BYTES = 200 * 1024
export const KEEP_DAYS = 14
const CUT_NOTE = '\n\n[Result cut at 200 KB]'
const READ_MARGIN = 4096
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Settings, read at call time so tests can point them at a temp folder. */
export function activityConfig(env = process.env) {
  const dir = env.VENOM_AGENTS_DIR?.trim() || join(homedir(), '.venom', 'agents')
  return { enabled: env.VENOM_AGENT_ACTIVITY !== '0', dir, file: join(dir, 'activity.jsonl') }
}

const warn = (what, err) => {
  try {
    process.stderr.write(`[hermes-mcp] activity ${what} failed: ${err?.message ?? err}\n`)
  } catch {
    // stderr itself is gone; nothing left to tell.
  }
}

// ESC sequences (colour, cursor) Hermes decorates its output with.
// oxlint-disable-next-line no-control-regex -- matching ESC is the point
export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** A framed Hermes line (`│ ...`, `┃ ...`): edit diffs and their headers. */
export const isFramed = (line) => /^\s*[│┃]/.test(String(line).replace(ANSI, ''))

/** The text without its framed lines; other lines kept as they are. */
export const dropFramed = (out) =>
  String(out ?? '')
    .split(/\r?\n/)
    .filter((l) => !isFramed(l))
    .join('\n')

export const runsDir = (cfg = activityConfig()) => join(cfg.dir, 'runs')

/** `<runsDir>/<id>.md`, or null when `id` is not a run id. */
export function runFilePath(id, cfg = activityConfig()) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) return null
  return join(runsDir(cfg), `${id}.md`)
}

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutUtf8(text, max) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return text
  let end = max
  // Back off over continuation bytes (10xxxxxx) to the start of the character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/**
 * The complete answer as stored: framed lines dropped (as answerText does),
 * ANSI removed, CRLF made LF, line breaks and blank lines kept, secrets
 * redacted, trimmed. Over RESULT_CAP_BYTES it is cut (whole characters only)
 * and ends with a note saying so; the note is inside the cap, so a stored
 * file is never larger than RESULT_CAP_BYTES.
 */
export function fullResult(text) {
  const t = redactSecrets(dropFramed(text).replace(ANSI, '').replace(/\r\n?/g, '\n')).trim()
  if (Buffer.byteLength(t, 'utf8') <= RESULT_CAP_BYTES) return t
  const room = RESULT_CAP_BYTES - Buffer.byteLength(CUT_NOTE, 'utf8')
  return `${cutUtf8(t, room).trimEnd()}${CUT_NOTE}`
}

/**
 * Store a run's complete answer. Returns true when the file was written;
 * false (and nothing written) for a bad id, an empty answer or activity off.
 * Never throws.
 */
export function writeRunFile(id, text, cfg = activityConfig()) {
  let tmp = null
  try {
    if (!cfg?.enabled) return false
    const path = runFilePath(id, cfg)
    if (!path) return false
    const body = fullResult(text)
    if (!body) return false
    mkdirSync(runsDir(cfg), { recursive: true })
    tmp = join(runsDir(cfg), `${id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, path)
    tmp = null
    return true
  } catch (err) {
    warn('run file write', err)
    return false
  } finally {
    if (tmp) {
      try {
        unlinkSync(tmp)
      } catch {
        // Never made, or already gone.
      }
    }
  }
}

/** The path when it is a plain file (not a folder, not a link), else null. */
function plainFile(id, cfg) {
  const path = runFilePath(id, cfg)
  if (!path) return null
  try {
    return lstatSync(path).isFile() ? path : null
  } catch {
    return null
  }
}

/** Is a full result kept for this run? Never throws. */
export const hasRunFile = (id, cfg = activityConfig()) => plainFile(id, cfg) !== null

/**
 * A run's stored answer, or null for a bad id or no file. Reads at most
 * RESULT_CAP_BYTES plus a little, whatever size the file on disk has.
 * Never throws.
 */
export function readRunFile(id, cfg = activityConfig()) {
  const path = plainFile(id, cfg)
  if (!path) return null
  let fd = null
  try {
    fd = openSync(path, 'r')
    if (!fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(RESULT_CAP_BYTES + READ_MARGIN)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got)
      if (!n) break
      got += n
    }
    // stream: a character cut at the end of what was read is left out
    // rather than turned into a replacement character.
    return new TextDecoder('utf-8').decode(buf.subarray(0, got), { stream: got === buf.length })
  } catch (err) {
    if (err?.code !== 'ENOENT') warn('run file read', err)
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Already closed.
      }
    }
  }
}

/** When a run started, from its id (ms since 1970), or NaN. */
export const runStartedAt = (id) => (RUN_ID.test(id) ? parseInt(id.split('-')[0], 36) : NaN)

/**
 * Remove the files of runs that started more than KEEP_DAYS ago (the same
 * rule as the log), and temp files left over from a write that died more than
 * a day ago. Files with any other name are left alone. Returns how many run
 * files went. Never throws.
 */
export function pruneRunFiles(cfg = activityConfig(), now = Date.now()) {
  if (!cfg?.enabled) return 0
  const dir = runsDir(cfg)
  let names
  try {
    names = readdirSync(dir)
  } catch (err) {
    if (err?.code !== 'ENOENT') warn('run file prune', err)
    return 0
  }
  const cutoff = now - KEEP_DAYS * DAY_MS
  let removed = 0
  for (const name of names) {
    try {
      const path = join(dir, name)
      if (name.endsWith('.md')) {
        const id = name.slice(0, -3)
        if (!RUN_ID.test(id) || !(runStartedAt(id) < cutoff)) continue
        if (!lstatSync(path).isFile()) continue
        unlinkSync(path)
        removed++
      } else if (name.endsWith('.tmp') && RUN_ID.test(name.split('.')[0])) {
        const st = lstatSync(path)
        if (st.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) rmSync(path, { force: true })
      }
    } catch (err) {
      warn('run file prune', err)
    }
  }
  return removed
}
