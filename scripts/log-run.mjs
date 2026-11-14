/**
 * Record one finished agent run that happened outside the team connector (a
 * job done straight in the Hermes desktop chat, say), so the team dock shows
 * it among that agent's latest jobs, or attach the full result to a run the
 * log already has.
 *
 *   node scripts/log-run.mjs --agent researcher --task "example.com audit" \
 *     --summary "12 fixes, 3 urgent." --ended "2026-11-10T11:17:00+04:00" \
 *     [--minutes 20] [--failed] [--file report.md]
 *
 *   node scripts/log-run.mjs --attach <run id> --file report.md [--agent researcher] [--replace]
 *
 * The first form appends one start and one end event to the activity log
 * (hermes-mcp/activity.mjs: same shapes, same secret redaction, same caps,
 * same VENOM_AGENTS_DIR and VENOM_AGENT_ACTIVITY). With --file the file's
 * text is kept as the run's full result (runs/<id>.md, see
 * hermes-mcp/runfiles.mjs) and --summary may be left out: the summary is then
 * taken from the file's first lines of prose.
 *
 * The second form appends nothing: it keeps the file as the full result of a
 * run that is already in the log (checked, with its agent when --agent is
 * given), and will not replace a result that is already kept unless told to
 * with --replace.
 *
 * It never edits or deletes an existing line. Note the connector drops events
 * and results older than 14 days when it starts, so a run logged further back
 * than that will not stay.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { activityConfig, startRun } from '../hermes-mcp/activity.mjs'
// The roster (venom.agents.json). An invalid one stops this script before it
// writes anything, with what to fix on stderr and exit code 1.
import { AGENT_IDS } from '../hermes-mcp/agents.mjs'
import { fullResult, hasRunFile, RUN_ID, writeRunFile } from '../hermes-mcp/runfiles.mjs'

const FUTURE_SLACK_MS = 60_000

export const USAGE =
  'usage: node scripts/log-run.mjs --agent <id> --task "<task>" [--summary "<result>"] --ended "<YYYY-MM-DDTHH:MM[:SS][+04:00]>" [--minutes <n>] [--failed] [--file <result.md>]\n' +
  '       node scripts/log-run.mjs --attach <run id> --file <result.md> [--agent <id>] [--replace]\n' +
  '       (--summary is required unless --file is given)'

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

/** A result file's text (UTF-8, BOM dropped). Throws when unreadable or empty. */
export function readResultFile(path) {
  if (!nonEmpty(path)) throw new Error('--file needs a path')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read --file "${path}": ${err?.code ?? err?.message ?? err}`)
  }
  text = text.replace(/^\uFEFF/, '')
  if (!text.trim()) throw new Error(`--file "${path}" is empty`)
  return text
}

/**
 * A summary from a result: its first lines of prose, skipping headings,
 * fences, rules and table rows, joined on one line. activity.mjs cuts it to
 * SUMMARY_CAP; this only stops collecting once there is more than enough.
 */
export function summaryFrom(text, room = 1200) {
  const prose = []
  let size = 0
  let fenced = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || !line) continue
    if (/^#{1,6}(\s|$)/.test(line)) continue // heading
    if (/^([-*_]\s*){3,}$/.test(line) || /^=+$/.test(line)) continue // rule / underline
    if (line.startsWith('|')) continue // table row
    const t = line.replace(/^(>\s*)+/, '').replace(/^([-*+]|\d+[.)])\s+/, '').trim()
    if (!t) continue
    prose.push(t)
    size += t.length + 1
    if (size >= room) break
  }
  if (prose.length) return prose.join(' ')
  // Nothing but headings: the first one, without its marks.
  const first = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)
  return first ?? ''
}

/**
 * Append one finished run. `full` (optional) is the complete result to keep
 * with it; with `full`, `summary` may be left out and is taken from it.
 * Returns `{ id, startedAt, endedAt }`; throws a plain Error on bad input,
 * before anything is written.
 */
export function logRun({ agent, task, summary, endedAt, minutes = 0, ok = true, full } = {}, { cfg = activityConfig() } = {}) {
  if (!AGENT_IDS.includes(agent)) throw new Error(`unknown agent "${agent}" (one of: ${AGENT_IDS.join(', ')})`)
  if (!nonEmpty(task)) throw new Error('task must be a non-empty string')
  if (full !== undefined && !nonEmpty(full)) throw new Error('the full result must be a non-empty string')
  if (summary === undefined && full !== undefined) summary = summaryFrom(full)
  if (!nonEmpty(summary)) throw new Error('summary must be a non-empty string')
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt) || endedAt <= 0) {
    throw new Error('endedAt must be a time (ms since 1970)')
  }
  if (endedAt > Date.now() + FUTURE_SLACK_MS) throw new Error('endedAt is in the future')
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    throw new Error('minutes must be a number of minutes, 0 or more')
  }
  if (!cfg.enabled) throw new Error('activity recording is off')

  const startedAt = Math.round(endedAt - minutes * 60_000)
  let t = startedAt
  const run = startRun({ agent, task, live: false }, { cfg, now: () => t, timers: false, pid: process.pid })
  if (!run.id) throw new Error('could not write the activity log')
  t = endedAt
  run.end({ ok: Boolean(ok), text: summary, full })
  return { id: run.id, startedAt, endedAt }
}

/** The `start` event of run `id` in the log or its `.1`, or null. */
function findStart(id, cfg) {
  for (const file of [cfg.file, `${cfg.file}.1`]) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes(id)) continue
      try {
        const ev = JSON.parse(line)
        if (ev?.t === 'start' && ev.id === id) return ev
      } catch {
        // A torn or foreign line.
      }
    }
  }
  return null
}

/**
 * Keep `text` (or the text of `file`) as the full result of run `id`, which
 * must already be in the activity log (as `agent`'s, when given). Appends no
 * event. An existing result is only replaced with `replace`. Returns
 * `{ id, bytes }`; throws a plain Error before writing anything on bad input.
 */
export function attachRun({ id, file, text, agent, replace = false } = {}, { cfg = activityConfig() } = {}) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error(`"${id}" is not a run id`)
  if (agent !== undefined && !AGENT_IDS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (one of: ${AGENT_IDS.join(', ')})`)
  }
  const body = text !== undefined ? text : readResultFile(file)
  if (!nonEmpty(body)) throw new Error('the full result must be a non-empty string')
  if (!cfg.enabled) throw new Error('activity recording is off')
  const start = findStart(id, cfg)
  if (!start) throw new Error(`no run "${id}" in the activity log`)
  if (agent !== undefined && start.agent !== agent) {
    throw new Error(`run "${id}" belongs to ${start.agent}, not ${agent}`)
  }
  if (hasRunFile(id, cfg) && !replace) {
    throw new Error(`run "${id}" already has a full result; pass --replace to overwrite it`)
  }
  if (!writeRunFile(id, body, cfg)) throw new Error('could not write the full result')
  return { id, bytes: Buffer.byteLength(fullResult(body), 'utf8') }
}

/** The CLI flags as logRun's (or attachRun's) input. Throws on an unknown or incomplete flag. */
export function parseArgs(argv) {
  const out = { ok: true }
  const valueFlags = {
    '--agent': 'agent',
    '--task': 'task',
    '--summary': 'summary',
    '--ended': 'ended',
    '--minutes': 'minutes',
    '--file': 'file',
    '--attach': 'attach',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--failed') {
      out.ok = false
      out.failed = true
    } else if (a === '--replace') {
      out.replace = true
    } else if (a in valueFlags) {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      out[valueFlags[a]] = v
    } else {
      throw new Error(`unknown argument "${a}"`)
    }
  }

  if (out.attach !== undefined) {
    for (const f of ['task', 'summary', 'ended', 'minutes', 'failed']) {
      if (out[f] !== undefined) throw new Error(`--attach takes only --file, --agent and --replace (not --${f})`)
    }
    if (out.file === undefined) throw new Error('--attach needs --file')
    const res = { attach: out.attach, file: out.file }
    if (out.agent !== undefined) res.agent = out.agent
    if (out.replace) res.replace = true
    return res
  }
  if (out.replace) throw new Error('--replace only goes with --attach')

  if (out.ended === undefined) throw new Error('--ended is required')
  // A date alone ("2026-11-10") would be read as UTC midnight: insist on a time.
  if (!/\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(out.ended)) {
    throw new Error('--ended needs a date and a time, like 2026-11-10T11:17:00+04:00')
  }
  const endedAt = Date.parse(out.ended)
  if (!Number.isFinite(endedAt)) throw new Error(`--ended "${out.ended}" is not a date-time`)
  const minutes = out.minutes === undefined ? 0 : Number(out.minutes)
  if (out.minutes !== undefined && (out.minutes.trim() === '' || !Number.isFinite(minutes))) {
    throw new Error(`--minutes "${out.minutes}" is not a number`)
  }
  const res = { agent: out.agent, task: out.task, summary: out.summary, endedAt, minutes, ok: out.ok }
  if (out.file !== undefined) res.file = out.file
  return res
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.attach !== undefined) {
      const { id, bytes } = attachRun({ id: args.attach, file: args.file, agent: args.agent, replace: args.replace })
      process.stdout.write(`attached ${bytes} bytes to ${id}\n`)
    } else {
      const { file, ...input } = args
      // Read the file first: an unreadable or empty one stops it before
      // anything is written.
      if (file !== undefined) input.full = readResultFile(file)
      const { id, endedAt } = logRun(input)
      process.stdout.write(`logged ${id} for ${args.agent}, ended ${new Date(endedAt).toISOString()}\n`)
    }
    process.exitCode = 0
  } catch (err) {
    process.stderr.write(`log-run: ${err?.message ?? err}\n${USAGE}\n`)
    process.exitCode = 1
  }
}

// Run only when executed directly, so importing it (the tests) does nothing.
// Windows paths are case-insensitive (`c:` vs `C:`), so compare them that way.
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] && same(import.meta.url, pathToFileURL(process.argv[1]).href)) main()
