/**
 * His name, and the only wake phrase — in one place, so the listener
 * (voice.ts) and the command trimmer (App.tsx) can never disagree.
 *
 * The alternates are not padding. Dictation models often return a near-miss
 * for a name (Venmo, Venum, Phenom, Benom) for a perfectly clear utterance, and
 * each of those used to be silently discarded, so the wake word "just didn't
 * work" with no indication why. Better a rare false wake than a name that does
 * not answer.
 *
 * Two tiers:
 *  - NAME: spellings close enough to wake him anywhere in an utterance, with
 *    or without a greeting.
 *  - LOOSE: wider mishearings (local Whisper wrote "Hey Vero" for "Hey Venom").
 *    These only count right after a greeting, or as the very first word of an
 *    utterance, so ordinary speech that happens to contain one does not wake
 *    him.
 */
export const NAME = '(?:venom|venum|venon|vennom|venim|venmo|vanom|benom|phenom)'

const GREETING = '(?:hey|hi|ok|okay|yo|hello)'
const PREFIX = `${GREETING}?`

/**
 * The sound of the name rather than a spelling: V (or the B / F / PH it is
 * heard as), a vowel, N or M, a vowel, N or M. Covers venam, vemon, fenom,
 * vinum, venem, benum and the like without listing each one. Real words are
 * kept out by the leading consonant and the word boundary: "lemon", "demon",
 * "woman", "phenomenal", "venomous" do not fit.
 */
const SOUNDS_LIKE = '(?:ph|[vbf])[aeiou]{1,2}(?:nn|mm|n|m)[aeiou]{1,2}[nm]'

/** Mishearings the sound rule cannot reach. "vero" is from the app's own log. */
const HEARD_AS = '(?:vero|verom|veno|venno)'

/** The name split in two by the transcriber. Only ever after a greeting. */
const SPLIT = '(?:ven\\s+(?:om|um|am)|the\\s+nom)'

/** The name with a stray s: Whisper wrote "Hey Venoms." Only ever after a greeting. */
const PLURAL = `${NAME}s`

/**
 * "Hi Venom" run together into one word: Whisper wrote "Ivanim, are you
 * there?". Only ever as the first word said. "Ivan", "Ivana" do not fit.
 */
const FUSED = 'iv[aeiou]{1,2}(?:nn|mm|n|m)[aeiou]{1,2}[nm]'

const LOOSE_WORD = `(?:${SOUNDS_LIKE}|${HEARD_AS})`
const LOOSE = `(?:${LOOSE_WORD}|${SPLIT}|${PLURAL})`

/** A greeting and a name, strict or loose: "hey venom", "Hey, Vero". */
const CALLED = `(?:${PREFIX}[\\s,]*${NAME}|${GREETING}[\\s,]+${LOOSE})`

const END = "\\b(?!['’]s)"

/**
 * Anywhere in an utterance. The optional prefix is genuinely optional: during an
 * answer "Venom" on its own is the natural way to cut in. The negative
 * lookahead keeps possessives ("Venom's job") from waking him. A loose
 * mishearing needs the greeting, or to be the first word said.
 */
export const WAKE = new RegExp(`(?:^\\W*(?:${LOOSE_WORD}|${FUSED})|\\b${CALLED})${END}`, 'i')

/** A bare vocative — "Venom", "hey venom" — with nothing asked. */
export const BARE_NAME = new RegExp(`^${CALLED}[\\s,.!?]*$`, 'i')

/** A leading vocative on a real command: "Venom, what's the weather". */
export const LEADING_NAME = new RegExp(`^${CALLED}\\b[\\s,.:!?-]*`, 'i')

/** Everything after the wake phrase, which is usually the actual command. */
export function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

const LEADING_GREETING = new RegExp(`^\\W*(?:${GREETING}\\b[\\s,]*)?`, 'i')

/**
 * The spelling of his name that matched, lower case ("venom", "vero",
 * "ven um"), or '' when nothing did. For the diagnostics line: the next
 * mishearing shows up there instead of being guessed at.
 */
export function wakeVariant(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  const name = m[0].replace(LEADING_GREETING, '')
  return (name || m[0]).toLowerCase().replace(/\s+/g, ' ').trim()
}
