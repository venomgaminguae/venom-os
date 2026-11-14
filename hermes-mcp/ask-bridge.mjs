// Talks to a running VENOM bridge like the browser does, minus the voice.
// Manual tool, not a test: it asks the LIVE bridge (ws://localhost:8787) a real
// question, so the answer lands in ~/.venom/memory. Keep this name out of
// Node's test-file patterns (see test/no-stray-tests.test.mjs).
// Usage: node hermes-mcp/ask-bridge.mjs "question"
import WebSocket from 'ws'

const text = process.argv[2] ?? 'Which model are you? One sentence.'
const ws = new WebSocket('ws://localhost:8787', { headers: { Origin: 'http://localhost:5173' } })
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
let answer = ''
ws.on('open', () => {
  console.log(stamp(), 'connected')
  ws.send(JSON.stringify({ type: 'ask', id: 'test-1', text }))
})
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.type === 'delta' || m.type === 'text') answer += m.text ?? m.delta ?? ''
  else if (m.type === 'ready') console.log(stamp(), 'ready; servers:', JSON.stringify(m.servers ?? m.mcp ?? m).slice(0, 300))
  else if (m.type === 'tool') console.log(stamp(), 'tool:', m.name)
  else if (m.type === 'done' || m.type === 'end' || m.type === 'result') {
    console.log(stamp(), m.type, JSON.stringify(m).slice(0, 300))
    console.log('ANSWER:', answer.trim())
    ws.close()
  } else console.log(stamp(), m.type, JSON.stringify(m).slice(0, 200))
})
ws.on('error', (e) => console.log('error', e.message))
ws.on('close', () => process.exit(0))
setTimeout(() => { console.log('timeout; partial answer:', answer); process.exit(1) }, 10 * 60 * 1000)
