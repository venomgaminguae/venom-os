/**
 * Interruption memory: what the owner heard before he cut VENOM off.
 *
 * The SDK session keeps whatever the model WROTE, and the model usually writes
 * the whole answer long before the voice has spoken it. After a barge-in the
 * session therefore believes the owner knows things he never heard. Its
 * history cannot be edited, so the correction travels with his next message
 * instead, as a short bracketed note in front of it. The conversation log, which
 * we do own, is corrected at the source.
 *
 * Pure: no I/O, no state. server.mjs decides when; this decides what.
 */

/** Plenty for several spoken sentences; a barge-in rarely lets more through. */
const SPOKEN_CAP = 2000

/**
 * The page's report of what sounded, made safe to quote into a prompt.
 *
 * It arrives over the socket, so treat it as untrusted text: control
 * characters out (they include the newlines that would let it open a new
 * paragraph of its own and pass for instructions), whitespace collapsed,
 * length capped. Anything that is not a string means "unknown" and is ''.
 */
export function cleanSpoken(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > SPOKEN_CAP ? flat.slice(0, SPOKEN_CAP).trimEnd() : flat
}

/** The bracketed note that goes in front of the owner's next message. */
export function interruptNote(spoken) {
  const heard = cleanSpoken(spoken)
  if (!heard) {
    return '[The owner interrupted before any of your previous answer was spoken. He heard none of it.]'
  }
  // Quoted with JSON rules so a quote mark inside his heard text cannot end
  // the quotation early and leave the rest reading as our own words.
  return (
    `[The owner interrupted your previous answer. He heard only this much of it: ${JSON.stringify(heard)} ` +
    'The rest was never spoken, so do not assume he knows it, and do not resume it unless asked.]'
  )
}

/** The note, a blank line, then what he actually said. */
export function withNote(note, text) {
  return note ? `${note}\n\n${text}` : text
}

/** Ends every answer in the conversation log that he cut short. */
export const INTERRUPTED_MARK = '[interrupted by the owner here]'

/** What the conversation log keeps as VENOM's answer to an interrupted turn. */
export function interruptedAnswer(spoken) {
  const heard = cleanSpoken(spoken)
  return heard ? `${heard} ${INTERRUPTED_MARK}` : INTERRUPTED_MARK
}
