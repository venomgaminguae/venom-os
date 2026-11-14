// A stand-in for the `claude` CLI, spawned by the Agent SDK when the bridge runs
// with VENOM_CLAUDE_EXECUTABLE pointing here. It speaks just enough of the
// stream-json protocol for test/interruption-bridge.test.mjs:
//
// - every stdin line is appended, untruncated, to FAKE_CLI_LOG;
// - control requests (initialize, interrupt, ...) get a success response;
// - a user message containing '#stock' is answered with the three sentences
//   below, streamed as text_delta events; with '#slow' as well it pauses
//   FAKE_CLI_PAUSE_MS (default 5000) after the first sentence, so a test can
//   interrupt mid-stream; anything else gets a one-word answer;
// - an interrupt during a turn stops it and ends it with a non-success result
//   (error_during_execution), as the real CLI does.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = process.env.FAKE_CLI_LOG
const PAUSE_MS = Number(process.env.FAKE_CLI_PAUSE_MS || 5000)
const SENTENCES = [
  'The RTX 5090 is in stock at three sellers.',
  ' The cheapest is 9,499 dollars.',
  ' Shall I open the listing?',
]

const log = (o) => LOG && appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
let n = 0
const uuid = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`

const delta = (text) =>
  out({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    session_id: 'fake',
    uuid: uuid(),
  })

const result = (subtype, text) =>
  out({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    ...(subtype === 'success' ? { result: text } : { errors: [] }),
    session_id: 'fake',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
  })

/** The turn being streamed, if any: its pending timer and the text so far. */
let turn = null

// '#money': three sentences streamed in small deltas that split inside a
// price, a time and a model number, for scripts/voice-proof.mjs (the clause
// chunker must never cut inside "USD 6,635.01", "10:30" or "RTX 5090").
const MONEY = ['Your balance is USD 6,', '635.', '01 today.', ' The RTX', ' 50', '90 ships at 10', ':', '30 tomorrow', '.', ' Shall I place the order?']
const MONEY_GAP_MS = Number(process.env.FAKE_CLI_DELTA_MS || 60)

function answer(q) {
  out({ type: 'system', subtype: 'init', session_id: 'fake', tools: [], mcp_servers: [], model: 'fake', permissionMode: 'default', apiKeySource: 'none', cwd: '.', slash_commands: [], output_style: 'default', uuid: uuid() })
  // FAKE_CLI_STOCK_ALL=1 (scripts/turn-proof.mjs): every user message is
  // answered as a '#stock' one, so a spoken request needs no tag.
  const stockAll = process.env.FAKE_CLI_STOCK_ALL === '1'
  if (q.includes('#money') && !stockAll) {
    turn = { timer: null, text: '' }
    const step = (i) => {
      if (!turn) return
      if (i === MONEY.length) {
        const text = turn.text
        turn = null
        result('success', text)
        return
      }
      delta(MONEY[i])
      turn.text += MONEY[i]
      turn.timer = setTimeout(() => step(i + 1), MONEY_GAP_MS)
    }
    step(0)
    return
  }
  if (!q.includes('#stock') && !stockAll) {
    delta('Noted.')
    result('success', 'Noted.')
    return
  }
  const slow = q.includes('#slow')
  turn = { timer: null, text: '' }
  const step = (i) => {
    if (i === SENTENCES.length) {
      const text = turn.text
      turn = null
      result('success', text)
      return
    }
    delta(SENTENCES[i])
    turn.text += SENTENCES[i]
    turn.timer = setTimeout(() => step(i + 1), slow && i === 0 ? PAUSE_MS : 5)
  }
  step(0)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  log({ stdin: line })
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'control_request') {
    if (msg.request?.subtype === 'interrupt' && turn) {
      clearTimeout(turn.timer)
      turn = null
      result('error_during_execution')
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
    return
  }
  if (msg.type === 'user') {
    const c = msg.message?.content
    answer(typeof c === 'string' ? c : '')
  }
})
