/**
 * What the owner actually heard.
 *
 * The model finishes writing long before the voice finishes speaking, so on a
 * barge-in the conversation holds a whole answer of which he may have heard
 * one sentence. Anything he did not hear must not be treated as said: the next
 * answer would refer back to things he never knew. This keeps the truth, chunk
 * by chunk, as each sentence sounds.
 *
 * Pure and import-free so the tests can load it straight from src.
 */

export type HeardLog = {
  /** A chunk of the answer starts sounding. */
  begin(text: string): void
  /** 0..1 of the current chunk has sounded. Only ever moves forward. */
  progress(fraction: number): void
  /** Characters of the current chunk sounded so far (a boundary charIndex). */
  charIndex(i: number): void
  /** The current chunk sounded completely. */
  finish(): void
  /** The current chunk was cut: keep only the part that sounded. */
  abandon(): void
  /** Everything heard so far, single spaces. */
  text(): string
  /** Whether a chunk was cut short rather than ending on its own. */
  interruptedMidChunk(): boolean
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The words of `text` that had fully sounded once `fraction` of it played.
 *
 * Only whole words count: a word whose last character lies beyond the cut is
 * dropped entirely. Splitting on whitespace alone keeps "6,635.01", "10:30"
 * and "USD 9,499" style tokens whole, so a cut inside a number drops the
 * number rather than leaving "6," in the record as if it had been said.
 */
export function cutToFraction(text: string, fraction: number): string {
  const t = squash(text)
  if (!t || !(fraction > 0)) return ''
  if (fraction >= 1) return t
  const at = fraction * t.length
  const kept: string[] = []
  let pos = 0
  for (const word of t.split(' ')) {
    const end = pos + word.length
    if (end > at) break
    kept.push(word)
    pos = end + 1
  }
  return kept.join(' ')
}

export function createHeardLog(): HeardLog {
  const done: string[] = []
  let current: { text: string; fraction: number } | null = null
  let cut = false

  const abandon = () => {
    if (!current) return
    const part = cutToFraction(current.text, current.fraction)
    if (part !== squash(current.text)) cut = true
    if (part) done.push(part)
    current = null
  }

  const progress = (fraction: number) => {
    if (!current || !Number.isFinite(fraction)) return
    current.fraction = Math.max(current.fraction, Math.min(1, Math.max(0, fraction)))
  }

  return {
    begin(text) {
      // A new chunk with the old one still open means its end was never
      // reported; count only what was measured rather than all of it.
      abandon()
      current = { text, fraction: 0 }
    },
    progress,
    charIndex(i) {
      if (!current || !current.text.length) return
      progress(i / current.text.length)
    },
    finish() {
      if (!current) return
      const t = squash(current.text)
      if (t) done.push(t)
      current = null
    },
    abandon,
    text() {
      const live = current ? cutToFraction(current.text, current.fraction) : ''
      return squash([...done, live].join(' '))
    },
    interruptedMidChunk: () => cut,
  }
}
