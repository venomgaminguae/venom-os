/**
 * Keeps the assistant's name right on screen and in the voice.
 *
 * The persona says Venom, but this interface began life as a film-assistant
 * pastiche and a model can still reach for that character's name or
 * introduction. This filter is the guarantee: every chunk of the answer passes
 * through it on its way to the transcript and the speaker, and "Jarvis" comes
 * out as "Venom OS" in the same capitalisation.
 *
 * Answers stream in small chunks, so the name can arrive split ("Jar" + "vis").
 * The filter holds back only a tail that could still grow into the name, and
 * releases it the moment the next chunk shows it is something else ("Japan").
 */

const NAME = 'jarvis'
const DOTTED = /J\.A\.R\.V\.I\.S\.?/gi
const WORD = /jarvis/gi

function swap(text: string): string {
  return text
    .replace(DOTTED, 'VENOM OS')
    .replace(WORD, (m) =>
      m === m.toUpperCase() ? 'VENOM OS' : m[0] === m[0].toUpperCase() ? 'Venom OS' : 'venom os',
    )
}

export type NameFilter = {
  /** Feed one chunk; returns the text that is safe to show and speak now. */
  push(delta: string): string
  /** End of the answer: returns whatever was still being held back. */
  flush(): string
}

export function createNameFilter(): NameFilter {
  let held = ''
  return {
    push(delta) {
      const text = swap(held + delta)
      // Hold back the longest tail that could still become the name.
      let keep = 0
      for (let n = Math.min(NAME.length - 1, text.length); n > 0; n--) {
        if (NAME.startsWith(text.slice(-n).toLowerCase())) {
          keep = n
          break
        }
      }
      held = text.slice(text.length - keep)
      return text.slice(0, text.length - keep)
    },
    flush() {
      const out = swap(held)
      held = ''
      return out
    },
  }
}

/** One-shot version for text that arrives whole. */
export function fixName(text: string): string {
  return swap(text)
}
