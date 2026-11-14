// The microphone policy decides which input VENOM listens on. Fenced off here:
// taking whatever Chrome ranks first (a near-silent headset microphone while
// the real one is another device), trusting the "default" and
// "communications" aliases, leaving a working microphone in a quiet room, and
// a HUD that says nothing when the input in use carries no sound.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  realInputs,
  shortLabel,
  chooseMic,
  loudest,
  switchTarget,
  nextMic,
  createSilenceWatch,
  micLine,
  meterFill,
  DEFAULT_MIC_PREFER,
  SILENT_RMS,
  SILENT_AFTER_MS,
} from '../src/lib/micPolicy.ts'

// A desk with a headset and a separate microphone, as Chrome lists it.
const DESK = [
  { deviceId: 'default', label: 'Default - Microphone (Headset Mic)' },
  { deviceId: 'communications', label: 'Communications - Microphone (Headset Mic)' },
  { deviceId: 'a', label: 'Microphone (Headset Mic)' },
  { deviceId: 'b', label: 'Microphone (Studio Mic)' },
]
const THREE = [
  { deviceId: 'default', label: 'Default - Mic One' },
  { deviceId: 'x', label: 'Mic One' },
  { deviceId: 'y', label: 'Mic Two' },
  { deviceId: 'z', label: 'Mic Three' },
]

// ---------- realInputs ----------

test('realInputs: drops the default and communications aliases', () => {
  assert.deepEqual(realInputs(DESK).map((d) => d.deviceId), ['a', 'b'])
})

test('realInputs: keeps the aliases when they are all there is', () => {
  const only = [{ deviceId: 'default', label: 'Default - Mic' }]
  assert.deepEqual(realInputs(only), only)
  assert.deepEqual(realInputs([]), [])
})

// ---------- shortLabel ----------

test('shortLabel: strips the USB id and the Microphone (...) wrapper', () => {
  assert.equal(shortLabel('Microphone (Studio Mic) (abcd:ef01)'), 'Studio Mic')
  assert.equal(shortLabel('Microphone (Headset Mic)'), 'Headset Mic')
})

test('shortLabel: strips the Default - and Communications - prefixes', () => {
  assert.equal(shortLabel('Default - Microphone (Headset Mic)'), 'Headset Mic')
  assert.equal(shortLabel('Communications - Microphone (Headset Mic)'), 'Headset Mic')
})

test('shortLabel: plain labels pass through, empty ones get a name', () => {
  assert.equal(shortLabel('Mic Two'), 'Mic Two')
  assert.equal(shortLabel(''), 'unnamed microphone')
  assert.equal(shortLabel('   '), 'unnamed microphone')
})

// ---------- chooseMic ----------

const PREFER = 'Studio Mic'

test('chooseMic: no preference by default; Chrome\'s aliases are still skipped', () => {
  assert.equal(DEFAULT_MIC_PREFER, '')
  // Unmeasured: the first real input, not the "default" alias.
  assert.deepEqual(chooseMic({ inputs: DESK }), {
    deviceId: 'a',
    label: 'Microphone (Headset Mic)',
    why: 'default',
  })
  // Measured: the input carrying sound.
  assert.deepEqual(chooseMic({ inputs: DESK, levels: { a: 0.0002, b: 0.01 } }), {
    deviceId: 'b',
    label: 'Microphone (Studio Mic)',
    why: 'loudest',
  })
})

test('chooseMic: a preference picks that input, not Chrome\'s first, why preferred', () => {
  assert.deepEqual(chooseMic({ inputs: DESK, prefer: PREFER }), {
    deviceId: 'b',
    label: 'Microphone (Studio Mic)',
    why: 'preferred',
  })
})

test('chooseMic: a saved label wins over the preferred one', () => {
  const c = chooseMic({ inputs: DESK, saved: 'Microphone (Headset Mic)', prefer: PREFER })
  assert.equal(c.deviceId, 'a')
  assert.equal(c.why, 'saved')
})

test('chooseMic: a saved label matches by short name when the USB id differs', () => {
  const c = chooseMic({ inputs: DESK, saved: 'Microphone (Headset Mic) (1a2b:3c4d)' })
  assert.equal(c.deviceId, 'a')
  assert.equal(c.why, 'saved')
})

test('chooseMic: a saved device that is unplugged falls through to the preferred one', () => {
  const c = chooseMic({ inputs: DESK, saved: 'Microphone (Old Mic)', prefer: PREFER })
  assert.equal(c.deviceId, 'b')
  assert.equal(c.why, 'preferred')
})

test('chooseMic: the preferred fragment is case-insensitive and overridable', () => {
  assert.equal(chooseMic({ inputs: DESK, prefer: 'HEADSET' }).deviceId, 'a')
  assert.equal(chooseMic({ inputs: THREE, prefer: 'three' }).deviceId, 'z')
})

test('chooseMic: no preferred match picks the loudest measured input', () => {
  const c = chooseMic({ inputs: THREE, levels: { x: 0.0002, y: 0.01, z: 0.003 } })
  assert.equal(c.deviceId, 'y')
  assert.equal(c.why, 'loudest')
})

test('chooseMic: an empty prefer does not match everything', () => {
  const c = chooseMic({ inputs: THREE, prefer: '  ', levels: { z: 0.01 } })
  assert.equal(c.deviceId, 'z')
  assert.equal(c.why, 'loudest')
})

test('chooseMic: all silent or unmeasured gives the first real input, why default', () => {
  const silent = chooseMic({ inputs: THREE, levels: { x: 0.0001, y: 0.0002, z: 0 } })
  assert.deepEqual(silent, { deviceId: 'x', label: 'Mic One', why: 'default' })
  assert.equal(chooseMic({ inputs: THREE }).why, 'default')
})

test('chooseMic: no inputs at all is null', () => {
  assert.equal(chooseMic({ inputs: [] }), null)
  assert.equal(chooseMic({ inputs: [], saved: 'Mic One' }), null)
})

// ---------- loudest ----------

test('loudest: the highest level above SILENT_RMS, aliases ignored', () => {
  const levels = { default: 0.5, a: 0.001, b: 0.02 }
  assert.equal(loudest(DESK, levels).deviceId, 'b')
})

test('loudest: null when every input is at or under SILENT_RMS', () => {
  assert.equal(loudest(DESK, { a: SILENT_RMS, b: 0.0001 }), null)
  assert.equal(loudest(DESK, {}), null)
})

// ---------- switchTarget ----------

test('switchTarget: null while the current input has signal', () => {
  assert.equal(switchTarget(DESK, 'a', { a: 0.002, b: 0.05 }), null)
})

test('switchTarget: null in a quiet room where every input is quiet', () => {
  assert.equal(switchTarget(DESK, 'b', { a: 0.0003, b: 0.0002 }), null)
  assert.equal(switchTarget(DESK, 'b', {}), null)
})

test('switchTarget: moves from a silent input to the one carrying sound', () => {
  // The headset reads 0.0002, the other microphone has speech.
  assert.equal(switchTarget(DESK, 'a', { a: 0.0002, b: 0.01 }).deviceId, 'b')
})

test('switchTarget: never offers the current input or an alias', () => {
  assert.equal(switchTarget(DESK, 'a', { a: 0.0001, default: 0.5, communications: 0.5 }), null)
})

// ---------- nextMic ----------

test('nextMic: cycles through real inputs and wraps', () => {
  assert.equal(nextMic(THREE, 'x').deviceId, 'y')
  assert.equal(nextMic(THREE, 'y').deviceId, 'z')
  assert.equal(nextMic(THREE, 'z').deviceId, 'x')
})

test('nextMic: skips the aliases; from an unknown or alias id starts at the first real input', () => {
  assert.equal(nextMic(DESK, 'b').deviceId, 'a')
  assert.equal(nextMic(DESK, 'default').deviceId, 'a')
  assert.equal(nextMic(DESK, 'gone').deviceId, 'a')
})

test('nextMic: null with no inputs, itself with one', () => {
  assert.equal(nextMic([], 'x'), null)
  assert.equal(nextMic([{ deviceId: 'x', label: 'Mic One' }], 'x').deviceId, 'x')
})

// ---------- createSilenceWatch ----------

test('silenceWatch: silent only after SILENT_AFTER_MS without sound', () => {
  assert.equal(SILENT_AFTER_MS, 8000)
  const w = createSilenceWatch()
  assert.equal(w.note(0, 1000), false)
  assert.equal(w.note(0, 8999), false)
  assert.equal(w.note(0, 9000), true)
})

test('silenceWatch: any sound restarts the clock', () => {
  const w = createSilenceWatch(1000, 0.01)
  assert.equal(w.note(0, 0), false)
  assert.equal(w.note(0, 900), false)
  assert.equal(w.note(0.02, 950), false)
  assert.equal(w.note(0, 1900), false)
  assert.equal(w.note(0, 1950), true)
})

test('silenceWatch: reset restarts the clock (after a switch)', () => {
  const w = createSilenceWatch(1000)
  w.note(0, 0)
  assert.equal(w.note(0, 1000), true)
  w.reset(1000)
  assert.equal(w.note(0, 1500), false)
  assert.equal(w.note(0, 2000), true)
})

// ---------- micLine ----------

const LIVE = { state: 'live', label: 'Microphone (Studio Mic)', why: 'preferred', count: 2, honoured: true }

test('micLine: live and honoured names the short label, why, and the M key', () => {
  assert.deepEqual(micLine(LIVE), { text: 'mic · Studio Mic (preferred) · M changes it', level: 'ok' })
  assert.equal(micLine({ ...LIVE, count: 1, why: '' }).text, 'mic · Studio Mic')
})

test('micLine: silent is bad and starts NO MIC SIGNAL', () => {
  const l = micLine({ ...LIVE, state: 'silent', label: 'Microphone (Headset Mic)' })
  assert.equal(l.level, 'bad')
  assert.ok(l.text.startsWith('NO MIC SIGNAL'))
  assert.match(l.text, /Headset Mic/)
  assert.match(l.text, /press M/)
  assert.doesNotMatch(micLine({ ...LIVE, state: 'silent', count: 1 }).text, /press M/)
})

test("micLine: not honoured warns and names Chrome", () => {
  const l = micLine({ ...LIVE, honoured: false })
  assert.equal(l.level, 'warn')
  assert.match(l.text, /Chrome/)
})

test('micLine: a note (switched) is a warning that keeps the name', () => {
  const l = micLine({ ...LIVE, why: 'switched', note: 'switched from Headset Mic: no signal' })
  assert.equal(l.level, 'warn')
  assert.match(l.text, /Studio Mic · switched from Headset/)
})

test('micLine: denied, none and starting', () => {
  assert.equal(micLine({ ...LIVE, state: 'denied' }).level, 'bad')
  assert.match(micLine({ ...LIVE, state: 'denied' }).text, /BLOCKED/)
  assert.deepEqual(micLine({ ...LIVE, state: 'none' }), { text: 'NO MICROPHONE FOUND', level: 'bad' })
  assert.equal(micLine({ ...LIVE, state: 'starting' }).level, 'busy')
})

// ---------- meterFill ----------

test('meterFill: empty at or under -60 dBFS and for junk, full at -12 dBFS and above', () => {
  for (const v of [0, -1, NaN, 0.0001, 0.001]) assert.equal(meterFill(v), 0)
  assert.equal(meterFill(10 ** (-12 / 20)), 1)
  assert.equal(meterFill(1), 1)
  assert.equal(meterFill(5), 1)
})

test('meterFill: stays within 0..1 and never falls as the level rises', () => {
  let prev = -1
  for (let db = -80; db <= 10; db += 2) {
    const f = meterFill(10 ** (db / 20))
    assert.ok(f >= 0 && f <= 1)
    assert.ok(f >= prev)
    prev = f
  }
  const mid = meterFill(10 ** (-36 / 20))
  assert.ok(Math.abs(mid - 0.5) < 1e-9)
})
