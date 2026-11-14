/**
 * Recorded segment -> 16 kHz mono 16-bit PCM WAV.
 *
 * The local transcriber in the bridge runs in Node, which has no decoder for
 * the browser's WebM/Opus recording; the browser decodes its own recording for
 * free. 16 kHz mono is exactly what Whisper wants, so nothing bigger than
 * needed crosses the socket.
 */

const RATE = 16000

/** One decoding context for the life of the page; browsers cap how many exist. */
let ctx: AudioContext | null = null

export async function toWav16k(blob: Blob): Promise<Blob> {
  ctx ??= new AudioContext()
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())

  // Rendering through a one-channel offline context resamples and downmixes in one pass.
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const samples = (await offline.startRendering()).getChannelData(0)

  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
