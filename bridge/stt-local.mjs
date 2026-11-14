// Local speech-to-text for the bridge's /stt route: Whisper (transformers.js +
// onnxruntime-node) in a forked worker so model inference never blocks the
// bridge's event loop. The page sends 16 kHz mono 16-bit WAV.
// Off unless VENOM_LOCAL_STT=1. With no model folder on disk start() is a quiet
// no-op and status().error says why.

import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav, resample } from './wav.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER = path.join(HERE, 'stt-worker.mjs');

export const DEFAULT_STT_MODEL = 'onnx-community/whisper-base.en';
// 'dml' = encoder on DirectML (GPU), decoder on cpu; falls back to cpu by itself.
export const DEFAULT_STT_DEVICE = 'dml';
export const DEFAULT_STT_DTYPE = 'fp32';

const SAMPLE_RATE = 16000;
const MIN_SECONDS = 0.25;
const MAX_SECONDS = 30;
const REQUEST_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 180_000;
const MAX_RESTARTS = 3;
const STABLE_MS = 5 * 60_000; // ready this long -> the restart budget is refilled
// Peak below this (about -50 dBFS) is treated as silence without asking the
// model, which otherwise answers pure silence with "you".
const SILENCE_PEAK = 0.003;

/** Read at call time so tests (and the desktop shell) can set env first. */
export function localSttConfig(env = process.env) {
  const deviceFromEnv = env.VENOM_STT_DEVICE?.trim();
  return {
    enabled: env.VENOM_LOCAL_STT === '1',
    modelDir: env.VENOM_STT_MODEL_DIR || path.join(HERE, '..', 'desktop', 'models'),
    model: env.VENOM_STT_MODEL || DEFAULT_STT_MODEL,
    device: deviceFromEnv || DEFAULT_STT_DEVICE,
    dtype: env.VENOM_STT_DTYPE || DEFAULT_STT_DTYPE,
    // Only the built-in default silently falls back; an explicit device is honoured.
    fallback: deviceFromEnv ? '' : DEFAULT_STT_DEVICE === 'cpu' ? '' : 'cpu',
  };
}

/** Trim and drop Whisper's non-speech markers: [BLANK_AUDIO], (silence), [Music], *noise* ... */
export function cleanTranscript(text) {
  return String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isWavType = (ct) => !ct || /wav|wave/i.test(ct) || /octet-stream/i.test(ct);

/**
 * @param {ReturnType<typeof localSttConfig>} config
 * @param {{ workerPath?: string }} [opts]
 */
export function createLocalStt(config, { workerPath = DEFAULT_WORKER } = {}) {
  const cfg = { ...config };
  const st = { ready: false, error: null, loadMs: null, count: 0, lastMs: null, device: cfg.device, rssMb: null };
  let child = null;
  let stopped = false;
  let restarts = 0;
  let restartTimer = null;
  let loadTimer = null;
  let stableTimer = null;
  let nextId = 1;
  let queue = Promise.resolve();
  const pending = new Map(); // id -> { resolve, reject, timer }
  let stderrTail = '';

  function rejectAll(err) {
    for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(err); }
  }

  function spawnWorker() {
    clearTimeout(restartTimer); restartTimer = null;
    st.ready = false;
    stderrTail = '';
    const proc = fork(workerPath, [], {
      serialization: 'advanced',
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      env: {
        ...process.env,
        VENOM_STT_MODEL_DIR: cfg.modelDir,
        VENOM_STT_MODEL: cfg.model,
        VENOM_STT_DEVICE: cfg.device,
        VENOM_STT_DTYPE: cfg.dtype || DEFAULT_STT_DTYPE,
        VENOM_STT_FALLBACK: cfg.fallback || '',
        VENOM_STT_CACHE_DIR: process.env.VENOM_STT_CACHE_DIR || path.join(os.tmpdir(), 'venom-stt-cache'),
      },
    });
    child = proc;
    let fatal = null;
    proc.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
    loadTimer = setTimeout(() => {
      if (child === proc && !st.ready) { st.error = `STT worker did not become ready within ${LOAD_TIMEOUT_MS / 1000} s`; proc.kill(); }
    }, LOAD_TIMEOUT_MS);
    loadTimer.unref?.();

    proc.on('message', (msg) => {
      if (child !== proc || !msg) return;
      if (msg.type === 'ready') {
        clearTimeout(loadTimer);
        st.ready = true; st.error = null; st.loadMs = msg.loadMs ?? null;
        if (msg.device) st.device = msg.device;
        st.rssMb = typeof msg.rss === 'number' ? Math.round(msg.rss / 1048576) : null;
        stableTimer = setTimeout(() => { restarts = 0; }, STABLE_MS);
        stableTimer.unref?.();
      } else if (msg.type === 'fatal') {
        fatal = String(msg.message || 'model failed to load');
      } else if (msg.type === 'log') {
        if (process.env.VENOM_STT_DEBUG) console.error('[stt]', msg.message);
      } else if (msg.type === 'result' || msg.type === 'error') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.type === 'result') p.resolve({ text: String(msg.text ?? ''), ms: msg.ms ?? 0 });
        else p.reject(new Error(`Local STT failed: ${msg.message}`));
      }
    });
    proc.on('error', (err) => { if (child === proc) st.error = `STT worker error: ${err.message}`; });
    proc.on('exit', (code, signal) => {
      clearTimeout(loadTimer); clearTimeout(stableTimer);
      if (child !== proc) return;
      child = null;
      st.ready = false;
      rejectAll(new Error('Local STT worker exited'));
      if (stopped) return;
      if (fatal) { st.error = `Local STT model failed to load: ${fatal}`; return; }
      const why = `STT worker exited (${signal || `code ${code}`})${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''}`;
      if (restarts >= MAX_RESTARTS) { st.error = `${why}; gave up after ${MAX_RESTARTS} restarts`; return; }
      restarts += 1;
      st.error = `${why}; restarting (${restarts}/${MAX_RESTARTS})`;
      restartTimer = setTimeout(spawnWorker, 250 * 2 ** (restarts - 1));
      restartTimer.unref?.();
    });
  }

  function send(pcm) {
    return new Promise((resolve, reject) => {
      const proc = child;
      if (!proc || !st.ready) return reject(new Error('Local STT is not ready'));
      const id = nextId++;
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(`Local STT timed out after ${REQUEST_TIMEOUT_MS / 1000} s`));
        proc.kill(); // a stuck worker would block every later request; restart it
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try { proc.send({ type: 'transcribe', id, pcm }); } catch (err) {
        pending.delete(id); clearTimeout(timer); reject(new Error(`Local STT send failed: ${err.message}`));
      }
    });
  }

  async function transcribeNow(buffer, contentType) {
    if (!st.ready) throw new Error(st.error ? `Local STT is not ready: ${st.error}` : 'Local STT is not ready');
    if (!isWavType(contentType)) throw new Error(`Local STT expects audio/wav, got ${contentType}`);
    let decoded;
    try { decoded = decodeWav(buffer); } catch (err) { throw new Error(`Local STT expects WAV audio: ${err.message}`); }
    let pcm = resample(decoded.samples, decoded.sampleRate, SAMPLE_RATE);
    if (pcm.length < MIN_SECONDS * SAMPLE_RATE) return { text: '', ms: 0 };
    if (pcm.length > MAX_SECONDS * SAMPLE_RATE) pcm = pcm.slice(0, MAX_SECONDS * SAMPLE_RATE);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    if (peak < SILENCE_PEAK) return { text: '', ms: 0 };
    const r = await send(pcm);
    st.count += 1; st.lastMs = r.ms;
    return { text: cleanTranscript(r.text), ms: r.ms };
  }

  return {
    start() {
      if (!cfg.enabled || child) return;
      const dir = path.join(cfg.modelDir, ...String(cfg.model).split('/'));
      if (!fs.existsSync(path.join(dir, 'config.json'))) {
        st.error = `Local STT model folder missing: ${dir}`;
        return;
      }
      stopped = false; restarts = 0; st.error = null;
      spawnWorker();
    },
    ready: () => st.ready,
    status: () => ({
      enabled: !!cfg.enabled, ready: st.ready, model: cfg.model, device: st.device,
      error: st.error, loadMs: st.loadMs, count: st.count, lastMs: st.lastMs, rssMb: st.rssMb,
    }),
    /** Serialised: requests run one at a time, in arrival order. */
    transcribe(buffer, contentType) {
      const run = queue.then(() => transcribeNow(buffer, contentType));
      queue = run.catch(() => {});
      return run;
    },
    /** Kills the worker; resolves once it has exited. */
    stop() {
      stopped = true;
      clearTimeout(restartTimer); clearTimeout(loadTimer); clearTimeout(stableTimer);
      st.ready = false;
      const proc = child;
      child = null;
      rejectAll(new Error('Local STT stopped'));
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        proc.once('exit', () => resolve());
        try { proc.disconnect(); } catch {}
        proc.kill();
      });
    },
  };
}
