// Kokoro -> Whisper round trip. The comparison helpers always run; the real
// round trip runs only when the Whisper model folder and the Kokoro cache are on
// disk (it never downloads: remote loading is off and fetch() is blocked).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalise, compare, contentWords, encodeWav, toSttWav, SENTENCES, missingModels, runRoundTrip } from '../scripts/speech-roundtrip.mjs'
import { decodeWav } from '../bridge/wav.mjs'

test('ten sentences, as specified', () => {
  assert.equal(SENTENCES.length, 10)
  assert.equal(SENTENCES[3], 'Hey Venom, what are my agents doing?')
})

test('number forms normalise to the same digits', () => {
  const same = (a, b) => assert.deepEqual(normalise(a), normalise(b), `${a} vs ${b}`)
  same('at 10:30', 'at ten thirty')
  same('at 10:30', 'at 10.30')
  same('6,635 dollars', '6635 dollars')
  same('6,635 dollars', 'six thousand six hundred thirty five dollars')
  same('RTX 5090', 'RTX fifty ninety')
  same('Samsung 9100', 'Samsung ninety one hundred')
  same('two terabyte', '2 terabyte')
  same('two terabyte', '2TB')
  same('three sellers', '3 sellers')
  same("today's briefing", 'today briefing')
})

test('stop-words are ignored, content words are required', () => {
  assert.deepEqual(contentWords('What is the price of the RTX 5090 today?'), ['price', 'rtx', '5090', 'today'])
  assert.equal(compare('Hey Venom, what are my agents doing?', 'hey venom what are agents doing').pass, true)
  assert.equal(compare('Stop. Cancel that.', 'Stop cancel that!').pass, true)
})

test('real mishearings fail', () => {
  const venue = compare('Hey Venom, what are my agents doing?', 'Hey venue, what are my agents doing?')
  assert.equal(venue.pass, false); assert.deepEqual(venue.missing, ['venom'])
  assert.equal(compare('What is the price of the RTX 5090 today?', 'What is the price of the RTX 5080 today?').pass, false)
  assert.equal(compare('Remind me at 10:30 to call the supplier.', 'Remind me at 10:13 to call the supplier.').pass, false)
  assert.equal(compare('The total is 6,635 dollars including VAT.', 'The total is 6,535 dollars including VAT.').pass, false)
  assert.equal(compare('The total is 6,635 dollars including VAT.', 'The total is 6,635 Dolores, including VAT.').pass, false)
  assert.equal(compare('How much is the Samsung 9100 Pro two terabyte?', 'How much is the Samsung 9100 Pro 3 terabyte?').pass, false)
  assert.equal(compare('Ask the researcher to compare three sellers.', 'Ask the researcher to compare three cellars.').pass, false)
  assert.equal(compare('Stop. Cancel that.', '').pass, false)
})

test('WAV encoder: 16 kHz mono 16-bit, padded, decodable', () => {
  const tone = Float32Array.from({ length: 24000 }, (_, i) => 0.5 * Math.sin(i / 10))
  const { wav, seconds } = toSttWav(tone, 24000, 0.3)
  assert.equal(seconds, 1.6)
  const d = decodeWav(wav)
  assert.equal(d.sampleRate, 16000)
  assert.equal(d.samples.length, 25600)
  assert.equal(d.samples[100], 0) // leading silence
  assert.ok(Math.max(...d.samples.slice(4800, 20800).map(Math.abs)) > 0.4)
  assert.equal(encodeWav(new Float32Array([1, -1]), 16000).readInt16LE(46), -32768)
})

const skip = missingModels()
test('real Kokoro -> Whisper round trip: at least 9 of 10 sentences heard', { skip: skip || false, timeout: 600_000 }, async () => {
  // runRoundTrip stops the Whisper worker in its own finally.
  const res = await runRoundTrip({ runs: 0, log: () => {} })
  assert.ok(!res.skipped, res.skipped)
  const fails = res.rows.filter((r) => !r.pass).map((r) => `${r.n}: heard "${r.heard}" missing ${r.missing.join(',')}`)
  assert.ok(res.pass >= 9, `only ${res.pass}/10 passed\n${fails.join('\n')}`)
})
