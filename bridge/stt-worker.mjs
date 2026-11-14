// Local Whisper worker. Started by bridge/stt-local.mjs with child_process.fork
// (serialization 'advanced'). Loads one model from local files only, warms it up,
// then answers {type:'transcribe', id, pcm: Float32Array @16 kHz} one at a time.
//
// Env (set by the parent):
//   VENOM_STT_MODEL_DIR  folder holding <org>/<name>/ in the transformers.js layout
//   VENOM_STT_MODEL      model id, e.g. onnx-community/whisper-base.en
//   VENOM_STT_DEVICE     'cpu' | 'dml' (DirectML) | ...
//   VENOM_STT_DTYPE      'fp32', 'q8', or '<encoder>/<decoder>' such as 'fp32/q8'
//   VENOM_STT_FALLBACK   'cpu' to retry on cpu when the device fails to load
//   VENOM_STT_CACHE_DIR  writable dir for transformers' cache (never node_modules)

import os from 'node:os';
import path from 'node:path';

if (!process.send) {
  console.error('stt-worker must be started with child_process.fork');
  process.exit(2);
}

// Never outlive the parent: the IPC channel closing means the bridge is gone.
process.on('disconnect', () => process.exit(0));

const send = (msg) => { try { process.send(msg); } catch { process.exit(0); } };

const modelDir = process.env.VENOM_STT_MODEL_DIR;
const model = process.env.VENOM_STT_MODEL;
const device = process.env.VENOM_STT_DEVICE || 'cpu';
const [encDtype, decDtype = encDtype] = (process.env.VENOM_STT_DTYPE || 'fp32').split('/');
const fallback = process.env.VENOM_STT_FALLBACK || '';

let asr = null;
let activeDevice = device;

// 'dml' runs the encoder (the heavy part) on DirectML and keeps the merged
// decoder on cpu: with onnxruntime-node 1.21 the merged decoder on DirectML
// produces no tokens ("token_ids must be a non-empty array").
const deviceMap = (dev) => (dev === 'dml' ? { encoder_model: 'dml', decoder_model_merged: 'cpu' } : dev);

async function load(T, dev) {
  return T.pipeline('automatic-speech-recognition', model, {
    device: deviceMap(dev),
    dtype: { encoder_model: encDtype, decoder_model_merged: decDtype },
    local_files_only: true,
    // Measured on this PC (i9-14900K, 8 fast + 16 slow cores): with the default
    // spinning thread pool a transcription drifts from ~240 ms to ~620 ms after a
    // few runs; with spinning off it holds at about 340 ms.
    session_options: { extra: { session: { intra_op: { allow_spinning: '0' } } } },
  });
}

// English-only (.en) checkpoints reject a language/task option, so only pass
// them to multilingual models.
const english = /\.en$/i.test(model || '') ? {} : { language: 'english', task: 'transcribe' };

async function run(pcm) {
  const out = await asr(pcm, { return_timestamps: false, ...english });
  return String((Array.isArray(out) ? out[0]?.text : out?.text) ?? '');
}

async function init() {
  const t0 = performance.now();
  if (!modelDir || !model) throw new Error('VENOM_STT_MODEL_DIR and VENOM_STT_MODEL must be set');
  const T = await import('@huggingface/transformers');
  T.env.allowRemoteModels = false;
  T.env.allowLocalModels = true;
  T.env.localModelPath = modelDir.endsWith(path.sep) || modelDir.endsWith('/') ? modelDir : modelDir + '/';
  T.env.cacheDir = process.env.VENOM_STT_CACHE_DIR || path.join(os.tmpdir(), 'venom-stt-cache');
  T.env.useFSCache = false;
  try {
    asr = await load(T, device);
    await run(new Float32Array(16000)); // warm-up: first run compiles kernels
  } catch (err) {
    if (!fallback || fallback === device) throw err;
    send({ type: 'log', message: `device ${device} failed (${err?.message || err}); falling back to ${fallback}` });
    activeDevice = fallback;
    asr = await load(T, fallback);
    await run(new Float32Array(16000));
  }
  send({ type: 'ready', loadMs: Math.round(performance.now() - t0), device: activeDevice, rss: process.memoryUsage().rss });
}

let chain = Promise.resolve();
process.on('message', (msg) => {
  if (!msg || msg.type !== 'transcribe') return;
  chain = chain.then(async () => {
    const t0 = performance.now();
    try {
      if (!asr) throw new Error('model not loaded');
      const pcm = msg.pcm instanceof Float32Array ? msg.pcm : new Float32Array(msg.pcm);
      const text = await run(pcm);
      send({ type: 'result', id: msg.id, text, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      send({ type: 'error', id: msg.id, message: String(err?.message || err) });
    }
  });
});

init().catch((err) => {
  send({ type: 'fatal', message: String(err?.message || err) });
  setTimeout(() => process.exit(1), 50);
});
