#!/usr/bin/env node
// Kokoro -> Whisper round trip: speaks ten fixed sentences with Kokoro (voice
// bm_george), turns each into the 16 kHz mono 16-bit WAV the page sends, feeds it
// through createLocalStt().transcribe() (the code path behind POST /stt), and
// checks that every content word came back. Also times transcribe().
//
//   node scripts/speech-roundtrip.mjs [--runs 10] [--json out.json] [--keep-wav dir]
//
// Offline only: remote model loading is switched off and fetch() is blocked, so a
// missing model is reported ("SKIPPED: ...") instead of downloaded.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resample } from '../bridge/wav.mjs';
import { createLocalStt, localSttConfig } from '../bridge/stt-local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SENTENCES = [
  'What is the price of the RTX 5090 today?',
  'Remind me at 10:30 to call the supplier.',
  'Open the warehouse inventory and show low stock.',
  'Hey Venom, what are my agents doing?',
  'The total is 6,635 dollars including VAT.',
  'Ask the researcher to compare three sellers.',
  'Stop. Cancel that.',
  'Send the result to my Telegram.',
  'How much is the Samsung 9100 Pro two terabyte?',
  "Good morning, give me today's briefing.",
];
export const VOICE = 'bm_george';
export const SPEED = 0.92;
export const KOKORO_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// ---- comparison ---------------------------------------------------------------
export const STOP_WORDS = new Set(('a an the of is to me my at and are what how much ' +
  'in on for it be with by from as or').split(' '));

const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Spoken number words -> digit tokens. A tens/unit word that cannot extend the
 * current number ("fifty ninety", "ten thirty") starts a new one. */
function wordsToNumbers(tokens) {
  const out = [];
  let cur = null; // { total, part }
  const flush = () => { if (cur) out.push(String(cur.total + cur.part)); cur = null; };
  for (const t of tokens) {
    if (t in UNITS || t in TENS) {
      const v = UNITS[t] ?? TENS[t];
      if (t === 'oh' && !cur) { out.push(t); continue; } // "oh" alone is a word
      if (cur) {
        const p = cur.part % 100;
        const fits = v < 10 ? p % 10 === 0 && !(p >= 10 && p < 20) : p === 0;
        if (!fits) flush();
      }
      if (!cur) cur = { total: 0, part: 0 };
      cur.part += v;
    } else if (t === 'hundred' && cur) {
      cur.part = (cur.part || 1) * 100;
    } else if (t === 'thousand' && cur) {
      cur.total += (cur.part || 1) * 1000; cur.part = 0;
    } else { flush(); out.push(t); }
  }
  flush();
  return out;
}

/** Lowercased word tokens with numbers as digits; adjacent numbers are joined
 * ("10 30" -> "1030", "50 90" -> "5090"). */
export function normalise(text) {
  let s = String(text ?? '').toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 6,635 -> 6635
    .replace(/(\d):(\d\d)\b/g, '$1 $2') // 10:30 -> 10 30
    .replace(/(\d)\s*tb\b/g, '$1 terabyte') // 2tb / 2 tb -> 2 terabyte
    .replace(/'s\b/g, '') // today's -> today
    .replace(/[^a-z0-9\s]+/g, ' '); // punctuation and hyphens -> space
  const toks = wordsToNumbers(s.split(/\s+/).filter(Boolean));
  const joined = [];
  for (const t of toks) {
    if (/^\d+$/.test(t) && joined.length && /^\d+$/.test(joined.at(-1))) joined[joined.length - 1] += t;
    else joined.push(t);
  }
  return joined;
}

export const contentWords = (text) => normalise(text).filter((w) => !STOP_WORDS.has(w));

/** PASS only when every content word of `expected` is in `heard`. */
export function compare(expected, heard) {
  const want = contentWords(expected);
  const got = new Set(normalise(heard));
  const missing = want.filter((w) => !got.has(w));
  return { pass: missing.length === 0, missing, want };
}

// ---- audio --------------------------------------------------------------------
/** Float samples -> 16-bit PCM mono WAV. */
export function encodeWav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return buf;
}

/** Windowed-sinc low-pass (cutoff in Hz) so 24 -> 16 kHz does not alias. */
function lowpass(x, rate, cutoff, taps = 63) {
  const h = new Float32Array(taps); const m = (taps - 1) / 2; const fc = cutoff / rate; let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - m;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    h[i] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1))); sum += h[i];
  }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) { const j = i + k - m; if (j >= 0 && j < x.length) acc += x[j] * h[k]; }
    y[i] = acc / sum;
  }
  return y;
}

/** Kokoro float audio at any rate -> 16 kHz mono 16-bit WAV with `padSeconds` of silence each side. */
export function toSttWav(samples, sampleRate, padSeconds = 0.3) {
  const pcm = sampleRate === 16000 ? samples : resample(lowpass(samples, sampleRate, 7600), sampleRate, 16000);
  const pad = Math.round(padSeconds * 16000);
  const out = new Float32Array(pcm.length + 2 * pad);
  out.set(pcm, pad);
  return { wav: encodeWav(out, 16000), seconds: out.length / 16000 };
}

// ---- model locations ----------------------------------------------------------
export function whisperDir(env = process.env) {
  const c = localSttConfig({ ...env, VENOM_LOCAL_STT: '1' });
  return path.join(c.modelDir, ...c.model.split('/'));
}
export const kokoroModelFile = () =>
  path.join(ROOT, 'node_modules', '@huggingface', 'transformers', '.cache', ...KOKORO_ID.split('/'), 'onnx', 'model.onnx');

/** Null when both models are on disk, else the reason to skip. */
export function missingModels(env = process.env) {
  if (!fs.existsSync(path.join(whisperDir(env), 'config.json'))) return `Whisper model not found at ${whisperDir(env)}`;
  if (!fs.existsSync(kokoroModelFile())) return `Kokoro model not cached at ${kokoroModelFile()}`;
  return null;
}

// ---- runner -------------------------------------------------------------------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const worst = (a) => (a.length ? Math.max(...a) : NaN);
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Synthesises the sentences with Kokoro (offline). Returns [{ text, wav, seconds }]. */
export async function synthesize(sentences = SENTENCES, { log = () => {} } = {}) {
  const T = await import('@huggingface/transformers');
  T.env.allowRemoteModels = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`network blocked by speech-roundtrip: ${url}`); };
  try {
    const { KokoroTTS } = await import('kokoro-js');
    const t0 = performance.now();
    const tts = await KokoroTTS.from_pretrained(KOKORO_ID, { dtype: 'fp32', device: 'cpu' });
    log(`Kokoro loaded in ${Math.round(performance.now() - t0)} ms`);
    const out = [];
    for (const text of sentences) {
      const audio = await tts.generate(text, { voice: VOICE, speed: SPEED });
      out.push({ text, ...toSttWav(audio.audio, audio.sampling_rate) });
    }
    return out;
  } finally { globalThis.fetch = realFetch; }
}

/** Starts local STT on the given env; resolves with the handle once ready. Caller must stop() it. */
export async function startStt(env = process.env, timeoutMs = 180_000) {
  const stt = createLocalStt(localSttConfig({ ...env, VENOM_LOCAL_STT: '1' }));
  stt.start();
  const end = Date.now() + timeoutMs;
  while (!stt.ready()) {
    const e = stt.status().error;
    if (e && /missing|failed to load|gave up/.test(e)) break;
    if (Date.now() > end) break;
    await sleep(50);
  }
  return stt;
}

export async function runRoundTrip({ runs = 10, keepWav = null, log = console.log } = {}) {
  const skip = missingModels();
  if (skip) return { skipped: skip };
  const clips = await synthesize(SENTENCES, { log });
  if (keepWav) {
    fs.mkdirSync(keepWav, { recursive: true });
    clips.forEach((c, i) => fs.writeFileSync(path.join(keepWav, `sentence-${i + 1}.wav`), c.wav));
  }
  const stt = await startStt();
  try {
    const status = stt.status();
    if (!stt.ready()) throw new Error(`local STT did not become ready: ${status.error}`);
    log(`Whisper ${status.model} ready on ${status.device} in ${status.loadMs} ms, worker RSS ${status.rssMb} MB`);
    const rows = [];
    for (const [i, c] of clips.entries()) {
      const t0 = performance.now();
      const { text } = await stt.transcribe(c.wav, 'audio/wav');
      const ms = performance.now() - t0;
      rows.push({ n: i + 1, expected: c.text, heard: text, ms: Math.round(ms), seconds: +c.seconds.toFixed(2), ...compare(c.text, text) });
    }
    // Latency sentence: the one closest to ten words (first on a tie).
    const li = SENTENCES.reduce((b, s, i) => (Math.abs(wordCount(s) - 10) < Math.abs(wordCount(SENTENCES[b]) - 10) ? i : b), 0);
    const times = [];
    if (runs > 0) {
      await stt.transcribe(clips[li].wav, 'audio/wav'); // warm-up
      for (let r = 0; r < runs; r++) {
        const t0 = performance.now();
        await stt.transcribe(clips[li].wav, 'audio/wav');
        times.push(performance.now() - t0);
      }
    }
    return {
      rows, pass: rows.filter((r) => r.pass).length, total: rows.length,
      stt: stt.status(),
      latency: {
        sentence: li + 1, words: wordCount(SENTENCES[li]), audioSeconds: +clips[li].seconds.toFixed(2), runs,
        medianMs: Math.round(median(times)), worstMs: Math.round(worst(times)),
        allMedianMs: Math.round(median(rows.map((r) => r.ms))), allWorstMs: Math.round(worst(rows.map((r) => r.ms))),
      },
    };
  } finally { await stt.stop(); }
}

function parseArgs(argv) {
  const a = { runs: 10, json: null, keepWav: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') a.runs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (argv[i] === '--json') a.json = argv[++i];
    else if (argv[i] === '--keep-wav') a.keepWav = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const res = await runRoundTrip({ runs: args.runs, keepWav: args.keepWav });
  if (res.skipped) { console.log(`SKIPPED: ${res.skipped}`); return; }
  console.log('\n#  | expected | heard | result');
  for (const r of res.rows) {
    console.log(`${String(r.n).padStart(2)} | ${r.expected} | ${r.heard} | ${r.pass ? 'PASS' : `FAIL (missing: ${r.missing.join(', ')})`}`);
  }
  console.log(`\nPassed ${res.pass}/${res.total}`);
  const L = res.latency;
  console.log(`Latency, sentence ${L.sentence} (${L.words} words, ${L.audioSeconds} s audio incl. 0.6 s padding), ${L.runs} runs after warm-up: median ${L.medianMs} ms, worst ${L.worstMs} ms`);
  console.log(`Latency across all ten sentences (one pass each): median ${L.allMedianMs} ms, worst ${L.allWorstMs} ms`);
  console.log(`STT: model ${res.stt.model}, device ${res.stt.device}, load ${res.stt.loadMs} ms, worker RSS at ready ${res.stt.rssMb} MB`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(res, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('speech-roundtrip failed:', err?.stack || err); process.exitCode = 1; });
}
