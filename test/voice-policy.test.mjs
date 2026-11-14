// The voice policy decides who speaks: Kokoro (neural, in the browser) or the
// system voice. Two bugs are fenced off here: Kokoro dropping to the system
// voice for the rest of the page after three slow clips (now a timed rest,
// judged only on clips long enough to judge), and `nativeBroken` routing every
// sentence to a cloud voice that was never configured, in front of Kokoro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createPacer,
  whyNotKokoro,
  voiceLine,
  pickLocalBackup,
  MIN_JUDGED_SECONDS,
} from '../src/lib/voicePolicy.ts'

const SLOW = [2.2, 3900] // judged, slower than realtime
const FAST = [2.2, 1500] // judged, faster than realtime
const SHORT_SLOW = [1.3, 1900] // too short to judge, slow

// ---------- createPacer ----------

test('pacer: clips shorter than MIN_JUDGED_SECONDS never rest, however slow', () => {
  assert.ok(1.3 < MIN_JUDGED_SECONDS)
  const p = createPacer()
  for (let i = 0; i < 10; i++) assert.equal(p.note(...SHORT_SLOW), 'ok')
  assert.equal(p.streak(), 0)
})

test('pacer: three judged slow clips in a row give ok, ok, rest', () => {
  const p = createPacer()
  assert.deepEqual([p.note(...SLOW), p.note(...SLOW), p.note(...SLOW)], ['ok', 'ok', 'rest'])
})

test('pacer: a fast judged clip in between resets the count', () => {
  const p = createPacer()
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...FAST), 'ok')
  assert.equal(p.streak(), 0)
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...SLOW), 'rest')
})

test('pacer: short slow clips between judged slow ones neither reset nor add', () => {
  const p = createPacer()
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...SHORT_SLOW), 'ok')
  assert.equal(p.streak(), 1)
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...SHORT_SLOW), 'ok')
  assert.equal(p.note(...SHORT_SLOW), 'ok')
  assert.equal(p.streak(), 2)
  assert.equal(p.note(...SLOW), 'rest')
})

test('pacer: nothing is permanent, after a rest it takes three more to rest again', () => {
  const p = createPacer()
  p.note(...SLOW)
  p.note(...SLOW)
  assert.equal(p.note(...SLOW), 'rest')
  assert.equal(p.streak(), 0)
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...SLOW), 'ok')
  assert.equal(p.note(...SLOW), 'rest')
})

test('pacer: audioSeconds 0 is ok', () => {
  const p = createPacer()
  assert.equal(p.note(0, 5000), 'ok')
  assert.equal(p.streak(), 0)
})

// ---------- whyNotKokoro ----------

const st = (over) => ({ state: 'ready', progress: 0, lastError: '', restWhy: '', restMs: 0, ...over })

test('whyNotKokoro: one phrase per state', () => {
  assert.equal(whyNotKokoro(st({ state: 'ready' })), '')
  assert.match(whyNotKokoro(st({ state: 'loading', progress: 0.43 })), /43%/)
  assert.match(whyNotKokoro(st({ state: 'warming' })), /warming up/)
  const resting = whyNotKokoro(st({ state: 'resting', restWhy: 'three slow clips', restMs: 12_300 }))
  assert.match(resting, /three slow clips/)
  assert.match(resting, /13s/)
  assert.match(whyNotKokoro(st({ state: 'failed', lastError: 'WebGPU lost' })), /WebGPU lost/)
  assert.match(whyNotKokoro(st({ state: 'off' })), /switched off/)
})

// ---------- voiceLine ----------

const line = (kOver, over = {}) =>
  voiceLine({
    kokoro: st(kOver),
    kokoroVoice: 'bm_george',
    engine: 'kokoro',
    systemVoice: 'Microsoft David',
    alarm: '',
    ...over,
  })

test('voiceLine: ready names Kokoro and the voice', () => {
  const l = line({ state: 'ready' })
  assert.equal(l.level, 'ok')
  assert.match(l.text, /Kokoro/)
  assert.match(l.text, /george/)
})

test('voiceLine: loading is busy, says he waits, and does not offer the system voice', () => {
  for (const state of ['idle', 'loading', 'warming']) {
    const l = line({ state, progress: 0.5 }, { engine: '' })
    assert.equal(l.level, 'busy')
    assert.match(l.text, /speaks when it is ready/)
    assert.doesNotMatch(l.text, /system voice|Microsoft David/)
  }
  assert.match(line({ state: 'loading', progress: 0.5 }).text, /50%/)
})

test('voiceLine: a real failure names the system voice that is speaking', () => {
  const l = line({ state: 'failed', lastError: 'no WebGPU' }, { engine: 'system' })
  assert.match(l.text, /Microsoft David/)
  assert.match(l.text, /no WebGPU/)
})

test('voiceLine: resting warns, failed is bad', () => {
  assert.equal(line({ state: 'resting', restWhy: 'slow', restMs: 5000 }).level, 'warn')
  assert.equal(line({ state: 'failed', lastError: 'boom' }).level, 'bad')
})

test('voiceLine: an alarm wins over everything', () => {
  for (const engine of ['kokoro', 'elevenlabs', 'system']) {
    const l = line({ state: 'ready' }, { alarm: 'nothing could speak', engine })
    assert.equal(l.level, 'bad')
    assert.ok(l.text.startsWith('VOICE FAILED'), l.text)
  }
})

test('voiceLine: engine elevenlabs says ElevenLabs', () => {
  assert.match(line({ state: 'loading' }, { engine: 'elevenlabs' }).text, /ElevenLabs/)
})

// ---------- pickLocalBackup ----------

const v = (name, lang, localService) => ({ name, lang, localService })
const DAVID = 'Microsoft David - English (United States)'
const MARK = 'Microsoft Mark - English (United States)'
const ZIRA = 'Microsoft Zira - English (United States)'
const THIS_PC = [
  v(DAVID, 'en-US', true),
  v(MARK, 'en-US', true),
  v(ZIRA, 'en-US', true),
  v('Google US English', 'en-US', false),
  v('Google UK English Female', 'en-GB', false),
  v('Google UK English Male', 'en-GB', false),
  v('Google Deutsch', 'de-DE', false),
]

test('pickLocalBackup: this PC picks a local male voice, never Zira or Google', () => {
  const b = pickLocalBackup(THIS_PC)
  assert.ok(b)
  assert.equal(b.localService, true)
  assert.ok([DAVID, MARK].includes(b.name), b.name)
})

test('pickLocalBackup: `not` skips the failed voice', () => {
  assert.equal(pickLocalBackup(THIS_PC, DAVID)?.name, MARK)
})

test('pickLocalBackup: nothing local means null', () => {
  assert.equal(pickLocalBackup([]), null)
  assert.equal(pickLocalBackup(THIS_PC.filter((x) => !x.localService)), null)
})

test('pickLocalBackup: a local en-GB voice wins over en-US', () => {
  const george = v('Microsoft George - English (United Kingdom)', 'en-GB', true)
  assert.equal(pickLocalBackup([...THIS_PC, george])?.name, george.name)
})

// ---------- source rules ----------

const src = (f) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8')
/** Drop block and line comments, so a comment recalling the old code does not count. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

test('tts.ts: a cloud voice is not chosen just because the system voice failed', () => {
  assert.ok(!code(src('tts.ts')).includes('caps().tts || nativeBroken'))
})

test('tts.ts: an unspoken sentence is counted and raised', () => {
  const t = src('tts.ts')
  assert.ok(t.includes('diag.silent++'))
  assert.ok(t.includes('diag.alarm ='))
})

test('kokoro.ts: no permanent switch, and the pacer comes from voicePolicy', () => {
  const k = src('kokoro.ts')
  assert.ok(!k.includes('the system voice from here on'))
  assert.match(k, /import\s*\{[^}]*\bcreatePacer\b[^}]*\}\s*from\s*'\.\/voicePolicy'/)
})
