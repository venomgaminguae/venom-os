// Minimal RIFF/WAVE decoder and resampler for the local speech-to-text path.
// Pure, no dependencies. Accepts PCM 8/16/24/32-bit integer and 32/64-bit float,
// any channel count (downmixed to mono), WAVE_FORMAT_EXTENSIBLE, extra chunks,
// and the "streaming" data chunk whose declared size is 0 or past end of file.

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('decodeWav: expected a Buffer, ArrayBuffer or typed array');
}

/**
 * @param {Buffer|ArrayBuffer|Uint8Array} input
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function decodeWav(input) {
  const buf = toBuffer(input);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file (missing RIFF/WAVE header)');
  }
  let fmt = null;
  let dataStart = -1;
  let dataEnd = -1;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new Error('WAV fmt chunk is truncated');
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bits = buf.readUInt16LE(body + 14);
      if (format === FORMAT_EXTENSIBLE) {
        // Sub-format GUID starts at offset 24 of the fmt body; its first two bytes are the real tag.
        if (size < 40 || body + 26 > buf.length) throw new Error('WAV extensible fmt chunk is truncated');
        format = buf.readUInt16LE(body + 24);
      }
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      dataStart = body;
      // Streaming writers leave size 0 (or 0xFFFFFFFF); take the rest of the file then.
      dataEnd = size === 0 || body + size > buf.length ? buf.length : body + size;
      break;
    }
    if (size === 0 && id !== 'fmt ') { pos = body; continue; }
    pos = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (dataStart < 0) throw new Error('WAV has no data chunk');
  const { format, channels, sampleRate, bits } = fmt;
  if (!channels || !sampleRate) throw new Error('WAV fmt chunk has 0 channels or 0 sample rate');
  const bytes = bits / 8;
  let read;
  if (format === FORMAT_PCM) {
    if (bits === 8) read = (o) => (buf[o] - 128) / 128;
    else if (bits === 16) read = (o) => buf.readInt16LE(o) / 32768;
    else if (bits === 24) read = (o) => buf.readIntLE(o, 3) / 8388608;
    else if (bits === 32) read = (o) => buf.readInt32LE(o) / 2147483648;
  } else if (format === FORMAT_FLOAT) {
    if (bits === 32) read = (o) => buf.readFloatLE(o);
    else if (bits === 64) read = (o) => buf.readDoubleLE(o);
  }
  if (!read) throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit)`);
  const frameBytes = fmt.blockAlign || bytes * channels;
  const frames = Math.floor((dataEnd - dataStart) / frameBytes);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const base = dataStart + i * frameBytes;
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(base + c * bytes);
    const v = sum / channels;
    samples[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return { samples, sampleRate };
}

/**
 * Linear-interpolation resampler. Returns the input untouched when rates match.
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} [toRate=16000]
 */
export function resample(samples, fromRate, toRate = 16000) {
  if (fromRate === toRate) return samples;
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error('resample: rates must be positive');
  const outLen = Math.max(0, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  const last = samples.length - 1;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    if (i0 >= last) { out[i] = samples[last] ?? 0; continue; }
    const t = x - i0;
    out[i] = samples[i0] * (1 - t) + samples[i0 + 1] * t;
  }
  return out;
}
