/**
 * Streaming speech chunker.
 *
 * Sits between the model's token stream and the TTS queue. Text arrives in
 * deltas that can split anywhere (inside "6,635.01", right after "1,562.",
 * inside "e.g."), and every released chunk becomes one utterance, so a cut in
 * the wrong place is audible: "USD 6 ... 635" or "Mr ... Stark".
 *
 * The core trick: punctuation is only a candidate boundary when it is followed
 * by whitespace AND the first non-space character after that whitespace has
 * arrived. That alone keeps decimals, times, thousands separators, URLs,
 * e-mails and file names intact (their punctuation is never followed by a
 * space), and it makes the result independent of how the stream was split.
 * Every decision is either final ("cut"/"keep") or "wait" for more text; a
 * final decision is only taken once all the text it depends on has arrived.
 *
 * Judgement calls (see test/chunker.test.mjs):
 *  - A known abbreviation ("Mr.", "e.g.", "Inc.", "U.S.") never ends a
 *    sentence, except a.m./p.m./etc. followed by a capitalised word
 *    ("5 p.m. Then we leave." is two chunks).
 *  - "No." is only an abbreviation before a digit ("No. 5"); otherwise it is
 *    the word "no" ending a sentence.
 *  - A number + "." always ends a sentence unless the next word is lowercase
 *    ("The price is 3.5. That is all." is two chunks).
 *  - Single capital initials ("J. R. R. Tolkien") and dotted acronyms never cut.
 *  - An ellipsis, '!' or '?' cuts only when the next word is not lowercase
 *    ("Then (finally!) we left" is one sentence).
 *  - A clause cut (, ; : or spaced dash) needs firstMin chars and 3 words for
 *    the first chunk, clauseMin chars for later ones, and is refused when the
 *    next word is a vocative ("sir", "madam") or a capitalised single word
 *    directly followed by punctuation (", sir." / ", Tony.").
 *  - The next chunk may not start with closing punctuation; such a cut is
 *    refused so the stray ")" or "”" stays with the text before it.
 *  - A run with no whitespace at all is never force-cut (it is almost always a
 *    URL or garbage); it waits for whitespace or flush().
 */

export type Chunker = {
  push(delta: string): string[]
  flush(): string[]
  pending(): string
}

type Verdict = 'cut' | 'keep' | 'wait'

const CLOSERS = '"\')]}”’»'
const OPENERS = '"\'([{“‘«'
/** A chunk may not start with these: they belong to the text before. */
const BAD_START = ')]}”’»,.;:!?…'
const DASHES = new Set(['-', '--', '–', '—'])

const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'vs.', 'etc.',
  'e.g.', 'i.e.', 'approx.', 'inc.', 'ltd.', 'co.', 'no.', 'vol.', 'fig.',
  'dept.', 'est.', 'min.', 'max.', 'hr.', 'hrs.', 'a.m.', 'p.m.', 'u.s.',
  'u.k.', 'u.a.e.',
])
/** Abbreviations that commonly end a sentence: cut when a capital follows. */
const SENTENCE_FINAL = new Set(['a.m.', 'p.m.', 'etc.'])
/** Words that, right after a comma and before punctuation, are a vocative. */
const VOCATIVES = ['sir', 'madam', "ma'am", 'ma’am']

/** Words that belong to the number before them (units, model suffixes). */
const UNITS = new Set([
  'percent', 'per', 'pm', 'am', 'p.m', 'a.m', 'tb', 'gb', 'mb', 'kb', 'hz',
  'ghz', 'mhz', 'khz', 'kg', 'g', 'mg', 'lb', 'lbs', 'km', 'm', 'cm', 'mm',
  'w', 'kw', 'v', 'mah', 'fps', 'ms', 's', 'sec', 'secs', 'seconds',
  'minutes', 'mins', 'min', 'hours', 'hrs', 'hr', 'days', 'years', 'usd',
  'dollars', 'euros', 'pro', 'max', 'ultra', 'plus',
  'mini', 'ti', 'super', 'xt', 'x3d', 'k', 'inch', 'inches', 'gen', 'cores',
  'threads',
])

const SPEAKABLE = /[\p{L}\p{N}]/u
const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r' || /\s/.test(c)
const isLower = (c: string): boolean => /\p{Ll}/u.test(c)
const isUpper = (c: string): boolean => /\p{Lu}/u.test(c)
const isDigit = (c: string): boolean => c >= '0' && c <= '9'

/**
 * Must these two neighbouring tokens stay in one chunk? Used by the forced
 * cut only: "USD 6,635.01", "RTX 5090", "Ryzen 7 9800X3D", "10:30 pm", "2 TB".
 */
function together(prev: string, next: string): boolean {
  if (prev === '' || next === '') return false
  if (/[,.;:!?…)\]"”’]$/.test(prev) && !/^\p{L}(\.\p{L})*\.$/u.test(prev)) return false
  // word/code/symbol + number: "USD 500", "RTX 5090", "$ 5", "iPhone 16"
  if (/^[$£€¥]?\d/.test(next) || /^[$£€¥]$/.test(prev)) return true
  // number + unit / percent / am-pm / model suffix
  if (/\d$/.test(prev)) {
    if (next[0] === '%') return true
    const w = next.toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '')
    return UNITS.has(w)
  }
  return false
}

export function createChunker(
  opts: { firstMin?: number; clauseMin?: number; maxUnspoken?: number } = {},
): Chunker {
  const firstMin = opts.firstMin ?? 18
  const clauseMin = opts.clauseMin ?? 60
  const maxUnspoken = opts.maxUnspoken ?? 220
  const MIN_FORCED = 40

  let buf = ''
  /** Everything before this index has been judged "keep" for good. */
  let scanFrom = 0
  let released = 0

  function emit(out: string[], end: number, next: number): void {
    out.push(buf.slice(0, end).trim())
    buf = buf.slice(next)
    scanFrom = 0
    released++
  }

  /** Can the next chunk start at `e`? (`e` is a non-space character.) */
  function startVerdict(e: number): 'ok' | 'bad' | 'wait' {
    const c = buf[e]
    if (BAD_START.includes(c)) return 'bad'
    if (OPENERS.includes(c) && e + 1 >= buf.length) return 'wait'
    return 'ok'
  }

  /** First significant character of the next word (skipping one opener). */
  function nextChar(e: number): string {
    const c = buf[e]
    return OPENERS.includes(c) ? buf[e + 1] : c
  }

  function sentenceDot(core: string, e: number): Verdict {
    const nc = nextChar(e)
    let bare = core
    while (bare.length > 0 && OPENERS.includes(bare[0])) bare = bare.slice(1)
    const lower = bare.toLowerCase()
    // Ellipsis: "Well... let me see" keeps going; "Hmm... Okay." cuts.
    if (bare.endsWith('…') || bare.endsWith('...')) return isLower(nc) ? 'keep' : 'cut'
    if (ABBREVIATIONS.has(lower)) {
      if (lower === 'no.') return isDigit(nc) ? 'keep' : 'cut'
      if (SENTENCE_FINAL.has(lower) && isUpper(nc)) return 'cut'
      return 'keep'
    }
    if (/^\p{Lu}\.$/u.test(bare)) return 'keep' // initial: "J. R. R. Tolkien"
    if (/^(\p{L}\.){2,}$/u.test(bare)) return 'keep' // dotted acronym
    if (isDigit(bare[bare.length - 2] ?? '')) return isLower(nc) ? 'keep' : 'cut'
    return 'cut'
  }

  function clause(chunk: string, e: number): Verdict {
    if (released === 0) {
      if (chunk.length < firstMin || chunk.split(/\s+/).length < 3) return 'keep'
    } else if (chunk.length < clauseMin) return 'keep'
    // Vocative / name closing the clause: ", sir." / ", Tony." stays attached.
    let j = e
    while (j < buf.length && !isSpace(buf[j])) j++
    const t = buf.slice(e, j)
    const m = /^([\p{L}'’-]+)(.*)$/su.exec(t)
    if (!m) return 'cut'
    const word = m[1]
    const rest = m[2]
    if (rest === '') {
      if (j < buf.length) return 'cut' // complete word, no punctuation after it
      const lw = word.toLowerCase()
      const could = isUpper(word[0]) || VOCATIVES.some((v) => v.startsWith(lw))
      return could ? 'wait' : 'cut'
    }
    const vocative = VOCATIVES.includes(word.toLowerCase()) || /^\p{Lu}\p{Ll}*$/u.test(word)
    return vocative && /^[.!?,;:…]/.test(rest) ? 'keep' : 'cut'
  }

  /** Judge the whitespace run [ws, e); buf[e] exists and is not a space. */
  function judge(ws: number, e: number, newlines: number): Verdict {
    const chunk = buf.slice(0, ws).trim()
    if (!SPEAKABLE.test(chunk)) return 'keep'
    const start = startVerdict(e)
    if (start !== 'ok') return start === 'wait' ? 'wait' : 'keep'
    if (newlines >= 2) return 'cut' // blank line: paragraph break
    let ts = ws
    while (ts > 0 && !isSpace(buf[ts - 1])) ts--
    const tok = buf.slice(ts, ws)
    let k = tok.length
    while (k > 0 && CLOSERS.includes(tok[k - 1])) k--
    if (k === 0) {
      // A detached closer ("done. )") rides with the sentence it closes.
      let b = ts - 1
      while (b > 0 && isSpace(buf[b])) b--
      return '.!?…'.includes(buf[b]) ? 'cut' : 'keep'
    }
    const core = tok.slice(0, k)
    const p = core[k - 1]
    // "Then (finally!) we left" goes on; a lowercase word means no new sentence.
    if (p === '!' || p === '?') return isLower(nextChar(e)) ? 'keep' : 'cut'
    if (p === '.' || p === '…') return sentenceDot(core, e)
    if (p === ',' || p === ';' || p === ':') return clause(chunk, e)
    if (DASHES.has(tok) && ts > 0) return clause(chunk, e) // spaced dash
    return 'keep'
  }

  /**
   * No accepted boundary within maxUnspoken characters: cut at the last space
   * at or before the limit that keeps units together. `beyond` is the first
   * whitespace run past the limit, so every token before it is complete.
   */
  function force(out: string[], beyond: number): void {
    let fallback = -1
    for (let s = Math.min(maxUnspoken, buf.length - 1); s >= MIN_FORCED; s--) {
      if (!isSpace(buf[s]) || isSpace(buf[s - 1])) continue
      let r = s
      while (r < buf.length && isSpace(buf[r])) r++
      let ts = s
      while (ts > 0 && !isSpace(buf[ts - 1])) ts--
      let ne = r
      while (ne < buf.length && !isSpace(buf[ne])) ne++
      if (!together(buf.slice(ts, s), buf.slice(r, ne))) {
        emit(out, s, r)
        return
      }
      if (fallback < 0) fallback = s
    }
    let at = fallback >= 0 ? fallback : beyond
    if (!SPEAKABLE.test(buf.slice(0, at))) at = beyond
    // Measured from the final cut: taken before the line above, the skipped
    // whitespace belonged to the other position and text was repeated.
    let r = at
    while (r < buf.length && isSpace(buf[r])) r++
    emit(out, at, r)
  }

  function drain(out: string[]): void {
    for (;;) {
      let i = scanFrom
      let cut = false
      while (!cut) {
        while (i < buf.length && !isSpace(buf[i])) i++
        if (i >= buf.length) return
        const ws = i
        let e = i
        let newlines = 0
        while (e < buf.length && isSpace(buf[e])) {
          if (buf[e] === '\n') newlines++
          e++
        }
        if (ws > maxUnspoken) {
          force(out, ws)
          cut = true
          break
        }
        if (e >= buf.length) {
          scanFrom = ws
          return
        }
        const v = judge(ws, e, newlines)
        if (v === 'wait') {
          scanFrom = ws
          return
        }
        if (v === 'cut') {
          emit(out, ws, e)
          cut = true
        } else {
          i = e
          scanFrom = e
        }
      }
    }
  }

  return {
    push(delta: string): string[] {
      const out: string[] = []
      if (!delta) return out
      buf += delta
      drain(out)
      return out
    },
    flush(): string[] {
      const rest = buf.trim()
      buf = ''
      scanFrom = 0
      released = 0
      // A punctuation-only remainder has nothing to speak.
      return SPEAKABLE.test(rest) ? [rest] : []
    },
    pending(): string {
      return buf
    },
  }
}
