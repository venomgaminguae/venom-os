// Local speech-to-text: WAV decoding, config read at call time, and the worker
// lifecycle (ready, ordered round trips, crash restart, no orphan child) using a
// fake worker, so no model is needed. One optional test uses the real model when
// VENOM_STT_TEST_CLIP points at a WAV and the model folder exists.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeWav, resample } from '../bridge/wav.mjs'
import { localSttConfig, createLocalStt, cleanTranscript, DEFAULT_STT_MODEL } from '../bridge/stt-local.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- WAV builder --------------------------------------------------------------
function wav({ rate = 16000, channels = 1, bits = 16, format = 1, frames, extensible = false, extraChunk = false, dataSize }) {
  const bytes = bits / 8
  const data = Buffer.alloc(frames.length * channels * bytes)
  frames.forEach((frame, i) => {
    for (let c = 0; c < channels; c++) {
      const v = Array.isArray(frame) ? frame[c] : frame
      const o = (i * channels + c) * bytes
      if (format === 3) data.writeFloatLE(v, o)
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), o)
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), o, 3)
      else if (bits === 8) data.writeUInt8(Math.round(v * 127 + 128), o)
    }
  })
  const fmt = Buffer.alloc(extensible ? 40 : 16)
  fmt.writeUInt16LE(extensible ? 0xfffe : format, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * channels * bytes, 8)
  fmt.writeUInt16LE(channels * bytes, 12)
  fmt.writeUInt16LE(bits, 14)
  if (extensible) { fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(format, 24) }
  const chunk = (id, body, size = body.length) => {
    const h = Buffer.alloc(8); h.write(id, 0, 'ascii'); h.writeUInt32LE(size, 4)
    return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const parts = [chunk('fmt ', fmt)]
  if (extraChunk) parts.push(chunk('LIST', Buffer.from('INFOjunk!')))
  parts.push(chunk('data', data, dataSize ?? data.length))
  const body = Buffer.concat([Buffer.from('WAVE'), ...parts])
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const tone = (n, amp = 0.5) => Array.from({ length: n }, (_, i) => amp * Math.sin(i / 5))

// ---- wav.mjs -----------------------------------------------------------------
test('decodes 16-bit mono PCM', () => {
  const { samples, sampleRate } = decodeWav(wav({ frames: [0, 0.5, -0.5, 1] }))
  assert.equal(sampleRate, 16000)
  assert.equal(samples.length, 4)
  near(samples[1], 0.5); near(samples[2], -0.5); near(samples[3], 1)
})

test('downmixes stereo, decodes float32, 24-bit, 8-bit and extensible', () => {
  const st = decodeWav(wav({ channels: 2, rate: 48000, frames: [[0.5, -0.5], [0.2, 0.4]] }))
  assert.equal(st.sampleRate, 48000); near(st.samples[0], 0); near(st.samples[1], 0.3)
  const f = decodeWav(wav({ format: 3, bits: 32, frames: [0.25, -0.75] }))
  near(f.samples[0], 0.25, 1e-6); near(f.samples[1], -0.75, 1e-6)
  near(decodeWav(wav({ bits: 24, frames: [0.5] })).samples[0], 0.5)
  near(decodeWav(wav({ bits: 8, frames: [0.5] })).samples[0], 0.5, 0.01)
  const ext = decodeWav(wav({ extensible: true, extraChunk: true, frames: [0.5, 0.25] }))
  near(ext.samples[0], 0.5); near(ext.samples[1], 0.25)
})

test('tolerates a streaming data chunk with size 0 or past the end', () => {
  assert.equal(decodeWav(wav({ frames: [0.1, 0.2, 0.3], dataSize: 0 })).samples.length, 3)
  assert.equal(decodeWav(wav({ frames: [0.1, 0.2, 0.3], dataSize: 0xffffffff })).samples.length, 3)
})

test('non-WAV input throws a clear error', () => {
  assert.throws(() => decodeWav(Buffer.from('OggS not a wav at all')), /Not a WAV/)
  assert.throws(() => decodeWav(Buffer.alloc(0)), /Not a WAV/)
  assert.throws(() => decodeWav('nope'), /expected a Buffer/)
})

test('resample keeps duration and passes matching rates through', () => {
  const x = new Float32Array(48000).fill(0.5)
  const y = resample(x, 48000, 16000)
  assert.equal(y.length, 16000); near(y[100], 0.5)
  assert.equal(resample(x, 16000, 16000), x)
  assert.equal(resample(new Float32Array(8000), 8000).length, 16000)
})

// ---- config ------------------------------------------------------------------
test('localSttConfig reads env at call time and is off unless VENOM_LOCAL_STT=1', () => {
  const c = localSttConfig({})
  assert.equal(c.enabled, false)
  assert.equal(localSttConfig({ VENOM_LOCAL_STT: '0' }).enabled, false)
  assert.equal(localSttConfig({ VENOM_LOCAL_STT: '1' }).enabled, true)
  assert.equal(c.model, DEFAULT_STT_MODEL)
  assert.equal(c.modelDir, path.join(ROOT, 'desktop', 'models'))
  const saved = process.env.VENOM_LOCAL_STT
  try {
    process.env.VENOM_LOCAL_STT = '1'
    assert.equal(localSttConfig().enabled, true)
    delete process.env.VENOM_LOCAL_STT
    assert.equal(localSttConfig().enabled, false)
  } finally { if (saved === undefined) delete process.env.VENOM_LOCAL_STT; else process.env.VENOM_LOCAL_STT = saved }
  const d = localSttConfig({ VENOM_LOCAL_STT: '1', VENOM_STT_MODEL_DIR: '/m', VENOM_STT_MODEL: 'a/b', VENOM_STT_DEVICE: 'cpu' })
  assert.deepEqual([d.enabled, d.modelDir, d.model, d.device, d.fallback], [true, '/m', 'a/b', 'cpu', ''])
})

test('blank markers are dropped, real phrases are kept', () => {
  for (const s of ['[BLANK_AUDIO]', ' (silence) ', '[ Silence ]', '[Music]', '(water running)', '♪♪']) assert.equal(cleanTranscript(s), '')
  assert.equal(cleanTranscript(' Thank you. '), 'Thank you.')
  assert.equal(cleanTranscript('[Music] Hey Venom'), 'Hey Venom')
})

// ---- worker lifecycle with a fake worker ------------------------------------
let tmp, fakeWorker
const FAKE = `
process.on('disconnect', () => process.exit(0))
const mode = process.env.VENOM_STT_MODEL.split('/')[1]
if (mode === 'die') process.exit(7)
if (mode === 'fatal') { process.send({ type: 'fatal', message: 'bad model' }); setTimeout(() => process.exit(1), 20) }
else setTimeout(() => process.send({ type: 'ready', loadMs: 5, device: process.env.VENOM_STT_DEVICE }), 20)
process.on('message', (m) => {
  if (m.type !== 'transcribe') return
  if (!(m.pcm instanceof Float32Array)) return process.send({ type: 'error', id: m.id, message: 'not f32' })
  if (m.pcm[0] > 0.9) process.exit(3)
  // reply slower for short clips: order must still match the request order
  setTimeout(() => process.send({ type: 'result', id: m.id, text: '  n=' + m.pcm.length + ' pid=' + process.pid + ' [BLANK_AUDIO] ', ms: 1 }), Math.max(1, 60 - m.pcm.length / 1000))
})
`
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venom-stt-test-'))
  fakeWorker = path.join(tmp, 'fake-worker.mjs')
  fs.writeFileSync(fakeWorker, FAKE)
  for (const m of ['normal', 'die', 'fatal']) {
    fs.mkdirSync(path.join(tmp, 'fake', m), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'fake', m, 'config.json'), '{}')
  }
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const cfg = (mode) => ({ ...localSttConfig({ VENOM_LOCAL_STT: '1', VENOM_STT_MODEL_DIR: tmp, VENOM_STT_MODEL: `fake/${mode}`, VENOM_STT_DEVICE: 'cpu' }) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 5000) {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(10) }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const pidOf = (text) => Number(/pid=(\d+)/.exec(text)[1])
const seconds = (s, amp = 0.5) => wav({ frames: tone(Math.round(s * 16000), amp) })

test('disabled or missing model folder: start() is a no-op', async () => {
  const off = createLocalStt(localSttConfig({ VENOM_LOCAL_STT: '0' }), { workerPath: fakeWorker })
  off.start()
  assert.equal(off.ready(), false)
  assert.equal(off.status().enabled, false)
  const missing = createLocalStt({ ...cfg('normal'), model: 'fake/nothere' }, { workerPath: fakeWorker })
  missing.start()
  assert.match(missing.status().error, /model folder missing/)
  await assert.rejects(missing.transcribe(seconds(1), 'audio/wav'), /not ready/)
})

test('ready, ordered round trips, short/silent/long audio, not-WAV rejected, stop kills the child', async () => {
  const stt = createLocalStt(cfg('normal'), { workerPath: fakeWorker })
  await assert.rejects(stt.transcribe(seconds(1), 'audio/wav'), /not ready/)
  stt.start()
  await until(() => stt.ready())
  assert.deepEqual({ ...stt.status(), lastMs: null }, { enabled: true, ready: true, model: 'fake/normal', device: 'cpu', error: null, loadMs: 5, count: 0, lastMs: null, rssMb: null })
  const lens = [3, 0.5, 2]
  const out = await Promise.all(lens.map((s) => stt.transcribe(seconds(s), 'audio/wav')))
  assert.deepEqual(out.map((r) => /n=(\d+)/.exec(r.text)[1]), lens.map((s) => String(s * 16000)))
  assert.ok(out.every((r) => !r.text.includes('BLANK') && r.text === r.text.trim()))
  // 48 kHz stereo is downmixed and resampled to 16 kHz
  const st = await stt.transcribe(wav({ rate: 48000, channels: 2, frames: tone(48000).map((v) => [v, v]) }), 'audio/wav')
  assert.match(st.text, /n=16000 /)
  assert.deepEqual(await stt.transcribe(seconds(0.1), 'audio/wav'), { text: '', ms: 0 })
  assert.deepEqual(await stt.transcribe(wav({ frames: new Array(16000).fill(0) }), 'audio/wav'), { text: '', ms: 0 })
  assert.match((await stt.transcribe(seconds(31), 'audio/wav')).text, /n=480000 /)
  await assert.rejects(stt.transcribe(Buffer.from('webm bytes'), 'audio/webm'), /expects audio\/wav/)
  await assert.rejects(stt.transcribe(Buffer.from('not a wav file at all'), 'audio/wav'), /expects WAV audio/)
  assert.equal(stt.status().count, 5)
  const pid = pidOf(out[0].text)
  assert.ok(alive(pid))
  await stt.stop()
  assert.equal(alive(pid), false)
  assert.equal(stt.ready(), false)
  await assert.rejects(stt.transcribe(seconds(1), 'audio/wav'), /not ready/)
})

test('a crashed worker is restarted; the in-flight request fails cleanly', async () => {
  const stt = createLocalStt(cfg('normal'), { workerPath: fakeWorker })
  stt.start()
  await until(() => stt.ready())
  const pid1 = pidOf((await stt.transcribe(seconds(1), 'audio/wav')).text)
  const crash = wav({ frames: [0.95, ...tone(16000)] })
  await assert.rejects(stt.transcribe(crash, 'audio/wav'), /worker exited/)
  assert.match(stt.status().error, /restarting \(1\/3\)/)
  await until(() => stt.ready())
  const pid2 = pidOf((await stt.transcribe(seconds(1), 'audio/wav')).text)
  assert.notEqual(pid1, pid2)
  assert.equal(alive(pid1), false)
  assert.equal(stt.status().error, null)
  await stt.stop()
  assert.equal(alive(pid2), false)
})

test('gives up after 3 restarts; a fatal load error is not retried', async () => {
  const stt = createLocalStt(cfg('die'), { workerPath: fakeWorker })
  stt.start()
  await until(() => /gave up after 3 restarts/.test(stt.status().error || ''), 8000)
  assert.equal(stt.ready(), false)
  await stt.stop()
  const bad = createLocalStt(cfg('fatal'), { workerPath: fakeWorker })
  bad.start()
  await until(() => /failed to load: bad model/.test(bad.status().error || ''))
  await bad.stop()
})

// ---- optional: the real model ----------------------------------------------
const realClip = process.env.VENOM_STT_TEST_CLIP
const realModel = path.join(process.env.VENOM_STT_MODEL_DIR || path.join(ROOT, 'desktop', 'models'), ...DEFAULT_STT_MODEL.split('/'), 'config.json')
test('real model transcribes a clip', { skip: !(realClip && fs.existsSync(realClip) && fs.existsSync(realModel)) && 'set VENOM_STT_TEST_CLIP and download the model', timeout: 120000 }, async () => {
  const stt = createLocalStt({ ...localSttConfig({ VENOM_LOCAL_STT: '1' }) })
  stt.start()
  try {
    await until(() => stt.ready() || /gave up|failed/.test(stt.status().error || ''), 110000)
    assert.ok(stt.ready(), stt.status().error)
    const r = await stt.transcribe(fs.readFileSync(realClip), 'audio/wav')
    assert.ok(r.text.length > 0)
    if (process.env.VENOM_STT_TEST_EXPECT) assert.match(r.text, new RegExp(process.env.VENOM_STT_TEST_EXPECT, 'i'))
  } finally { await stt.stop() }
})
