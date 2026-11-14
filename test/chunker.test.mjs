// The speech chunker sits between the model's token stream and the TTS queue.
// It must start speaking on the first clause, yet never cut a number, time,
// price, URL or abbreviation — whatever way the stream happens to be split.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChunker } from '../src/lib/chunker.ts'

/** Feed deltas through one chunker and return every chunk it released. */
function run(deltas, opts) {
  const c = createChunker(opts)
  const out = []
  for (const d of deltas) out.push(...c.push(d))
  out.push(...c.flush())
  return out
}

const squash = (s) => s.replace(/\s+/g, '')

/** Tiny deterministic PRNG for the random-split fuzz. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * Run `text` as one delta, check the chunk invariants, then prove the same
 * chunks come out when the text is split at every position, character by
 * character, and at random places with empty deltas mixed in.
 */
function check(text, opts) {
  const base = run([text], opts)
  for (const chunk of base) {
    assert.ok(chunk.length > 0, 'no empty chunk')
    assert.equal(chunk, chunk.trim(), 'chunks are trimmed')
    assert.match(chunk, /[\p{L}\p{N}]/u, `punctuation-only chunk: ${JSON.stringify(chunk)}`)
  }
  assert.equal(squash(base.join('')), squash(text), 'text is reproduced exactly')
  for (let i = 1; i < text.length; i++) {
    assert.deepEqual(run([text.slice(0, i), text.slice(i)], opts), base, `split at ${i}`)
  }
  assert.deepEqual(run([...text], opts), base, 'character by character')
  const r = rng(text.length)
  for (let n = 0; n < 20; n++) {
    const parts = []
    let i = 0
    while (i < text.length) {
      const k = 1 + Math.floor(r() * 7)
      parts.push(text.slice(i, i + k))
      if (r() < 0.2) parts.push('')
      i += k
    }
    assert.deepEqual(run(parts, opts), base, 'random split')
  }
  return base
}

test('a decimal is not a sentence end', () => {
  const out = check('It weighs 3.5 kilograms. Next sentence.')
  assert.deepEqual(out, ['It weighs 3.5 kilograms.', 'Next sentence.'])
})

test('a time stays whole and ", sir." stays on its clause', () => {
  const out = check('Your meeting is at 10:30 tomorrow, sir. Shall I move it?')
  assert.deepEqual(out, ['Your meeting is at 10:30 tomorrow, sir.', 'Shall I move it?'])
})

test('a price with currency, thousands and decimals is one piece', () => {
  const out = check('The total comes to USD 6,635.01 including VAT. Shall I send it?')
  assert.deepEqual(out, ['The total comes to USD 6,635.01 including VAT.', 'Shall I send it?'])
})

test('decimals split across deltas', () => {
  assert.deepEqual(run(['1,562.', '45 dollars. Next.']), ['1,562.45 dollars.', 'Next.'])
  check('1,562.45 dollars. Next.')
  assert.deepEqual(run(['6,6', '35.0', '1 total. Ok.']), ['6,635.01 total.', 'Ok.'])
})

test('the forced cut never separates a model from its number', () => {
  // Filler so that the 220 limit lands exactly between "RTX" and "5090".
  const filler = 'words ' + 'word '.repeat(42)
  const text = `${filler}RTX 5090 and then many more words keep coming without any stop at all here and there and on`
  assert.equal(text.indexOf('RTX'), 216)
  assert.equal(text[219], ' ')
  assert.ok(text.length >= 300, String(text.length))
  const out = check(text)
  assert.ok(out.length >= 2, 'the long run was cut')
  assert.ok(out[0].length <= 220)
  assert.deepEqual(out[0], filler.trim())
  assert.ok(out.some((c) => c.startsWith('RTX 5090')), JSON.stringify(out))
})

test('the forced cut keeps price, units and times together', () => {
  const pad = 'a '.repeat(100) // 200 chars
  for (const glue of ['USD 6,635.01', '24 GB', '10:30 pm', 'Samsung 9100 Pro', '5 percent', '$ 1,299']) {
    // Put the glue's first inner space as the last space at or before 220.
    const lead = 220 - glue.indexOf(' ')
    const prefix = ('b '.repeat(120)).slice(0, lead - 1).replace(/ ?$/, ' ').padStart(lead, 'c')
    const text = prefix + glue + ' ' + pad
    assert.equal(text.indexOf(glue), lead)
    assert.equal(text.lastIndexOf(' ', 220), lead + glue.indexOf(' '))
    const out = check(text)
    assert.ok(out.length >= 2)
    assert.ok(out.some((c) => c.includes(glue)), `${glue} split: ${JSON.stringify(out)}`)
  }
})

test('e.g. is not a sentence end', () => {
  const out = check('Use a faster drive, e.g. the Samsung 9100 Pro, for the build. Done.')
  assert.deepEqual(out, ['Use a faster drive,', 'e.g. the Samsung 9100 Pro, for the build.', 'Done.'])
  assert.deepEqual(run(['Use a fast drive e.', 'g. the Samsung 9100 Pro. Done.']), [
    'Use a fast drive e.g. the Samsung 9100 Pro.',
    'Done.',
  ])
})

test('URLs, e-mails and file names are never cut', () => {
  const out = check('See https://example.com/build.v2?id=3.5 for details. Thanks.')
  assert.deepEqual(out, ['See https://example.com/build.v2?id=3.5 for details.', 'Thanks.'])
  const out2 = check('Mail hello@example.com or edit server.mjs on 192.168.1.1 with v2.5 now. Done.')
  assert.equal(out2.length, 2)
  assert.ok(out2[0].includes('hello@example.com') && out2[0].includes('server.mjs') && out2[0].includes('192.168.1.1'))
  // a URL that ends the sentence still cuts after its full stop
  assert.deepEqual(check('Go to example.com. Then log in.'), ['Go to example.com.', 'Then log in.'])
})

test('first clause is released early, the price is never split', () => {
  const out = check('Certainly, sir. The RTX 5090 is in stock at three sellers, and the cheapest is USD 9,499.')
  assert.equal(out[0], 'Certainly, sir.')
  assert.ok(out.some((c) => c.includes('USD 9,499.')))
  const out2 = check('Right now the store has twelve orders waiting, and three of them are late.')
  assert.deepEqual(out2, ['Right now the store has twelve orders waiting,', 'and three of them are late.'])
})

test('the first chunk is released as soon as the clause is proven', () => {
  const c = createChunker()
  assert.deepEqual(c.push('Right now the store has twelve orders waiting,'), [])
  assert.deepEqual(c.push(' '), [])
  assert.deepEqual(c.push('a'), ['Right now the store has twelve orders waiting,'])
  assert.equal(c.pending(), 'a')
})

test('short or later clauses are not cut at every comma', () => {
  // first chunk needs 18 chars and 3 words
  assert.deepEqual(check('Yes, sir, right away. Done.'), ['Yes, sir, right away.', 'Done.'])
  // later chunks need 60 chars before a comma counts
  const out = check('Done. The build has three parts, a case, and a board. Then a much longer clause that keeps going on and on and on and on, until it finally ends.')
  assert.deepEqual(out, [
    'Done.',
    'The build has three parts, a case, and a board.',
    'Then a much longer clause that keeps going on and on and on and on,',
    'until it finally ends.',
  ])
})

test('a name or vocative ending the sentence stays on its clause', () => {
  assert.deepEqual(check('I have finished the report you asked for, Tony. Anything else?'), [
    'I have finished the report you asked for, Tony.',
    'Anything else?',
  ])
  assert.deepEqual(check("All three backups completed without errors, ma'am. Rest easy."), [
    "All three backups completed without errors, ma'am.",
    'Rest easy.',
  ])
  // a capitalised word that is not followed by punctuation does not block
  assert.deepEqual(check('The order shipped this morning from Paris, Tony says it is fine.'), [
    'The order shipped this morning from Paris,',
    'Tony says it is fine.',
  ])
})

test('semicolons, colons and spaced dashes are clause boundaries', () => {
  assert.deepEqual(check('There are two options here; the first is cheaper.'), [
    'There are two options here;',
    'the first is cheaper.',
  ])
  assert.deepEqual(check('Here is the short answer — it ships tomorrow.'), [
    'Here is the short answer —',
    'it ships tomorrow.',
  ])
  assert.deepEqual(check('The ratio we want here: 16:9 at 10:30 sharp.'), [
    'The ratio we want here:',
    '16:9 at 10:30 sharp.',
  ])
})

test('Mr. Stark and Dr. No', () => {
  assert.deepEqual(check('Mr. Stark is here. Dr. No called.'), ['Mr. Stark is here.', 'Dr. No called.'])
  assert.deepEqual(check('Order No. 5 has shipped. Thanks.'), ['Order No. 5 has shipped.', 'Thanks.'])
  assert.deepEqual(check('The answer was no. Then we left.'), ['The answer was no.', 'Then we left.'])
  assert.deepEqual(check('J. R. R. Tolkien wrote it in the U.K. last century. Yes.'), [
    'J. R. R. Tolkien wrote it in the U.K. last century.',
    'Yes.',
  ])
  // judgement call: a sentence ending in "Inc." does not cut before a capital
  assert.deepEqual(check('It is made by Apple Inc. They ship it.'), ['It is made by Apple Inc. They ship it.'])
})

test('5 p.m. Then — a.m./p.m./etc. may end a sentence before a capital', () => {
  assert.deepEqual(check('It arrives at 5 p.m. Then we leave.'), ['It arrives at 5 p.m.', 'Then we leave.'])
  assert.deepEqual(check('It arrives at 5 p.m. today.'), ['It arrives at 5 p.m. today.'])
  assert.deepEqual(check('Bring cables, fans etc. We start soon.'), ['Bring cables, fans etc.', 'We start soon.'])
})

test('a number ending a sentence cuts before a capital', () => {
  assert.deepEqual(check('The price is 3.5. That is all.'), ['The price is 3.5.', 'That is all.'])
  assert.deepEqual(check('Step 2. then step three.'), ['Step 2. then step three.'])
})

test('ellipsis', () => {
  assert.deepEqual(check('Well... let me think about that. Okay.'), ['Well... let me think about that.', 'Okay.'])
  assert.deepEqual(check('Hmm… Okay then.'), ['Hmm…', 'Okay then.'])
})

test('questions and exclamations with closing quotes', () => {
  assert.deepEqual(check('He asked, "Is it ready?" She said “Yes!” Then (finally!) we left.'), [
    'He asked, "Is it ready?"',
    'She said “Yes!”',
    'Then (finally!) we left.',
  ])
})

test('stray closing punctuation is not spoken alone', () => {
  assert.deepEqual(check('It is done. ) And more.'), ['It is done. )', 'And more.'])
})

test('a blank line is a paragraph break', () => {
  assert.deepEqual(check('First paragraph without a stop\n\nSecond one.'), [
    'First paragraph without a stop',
    'Second one.',
  ])
  assert.deepEqual(check('Here is the list:\n\n- one\n- two'), ['Here is the list:', '- one\n- two'])
})

test('flush returns the unterminated tail', () => {
  const c = createChunker()
  assert.deepEqual(c.push('Hello there. And then some'), ['Hello there.'])
  assert.equal(c.pending(), 'And then some')
  assert.deepEqual(c.flush(), ['And then some'])
  assert.deepEqual(c.flush(), [])
  check('Hello there. And then some')
  // a boundary waiting for lookahead is released by flush
  assert.deepEqual(run(['All good, sir.']), ['All good, sir.'])
})

test('empty and whitespace-only deltas', () => {
  const c = createChunker()
  assert.deepEqual(c.push(''), [])
  assert.deepEqual(c.push('   '), [])
  assert.deepEqual(c.push('\n'), [])
  assert.deepEqual(c.flush(), [])
  assert.deepEqual(run(['', ' ', 'Hi there. ', '', 'Bye.', ' ']), ['Hi there.', 'Bye.'])
  assert.deepEqual(run(['...']), [])
})

test('600 characters without a single space neither hangs nor loses text', () => {
  const blob = 'x'.repeat(300) + '.' + 'y'.repeat(299)
  const out = check(blob)
  assert.deepEqual(out, [blob])
  const out2 = check(`${blob} then words. Done.`)
  assert.equal(squash(out2.join('')), squash(`${blob} then words. Done.`))
})

test('a long unpunctuated run starts being spoken', () => {
  const text = 'and the next part goes on '.repeat(15).trim()
  const out = check(text)
  assert.ok(out.length >= 2)
  for (const c of out.slice(0, -1)) assert.ok(c.length >= 40 && c.length <= 220, String(c.length))
})

test('options are honoured', () => {
  assert.deepEqual(check('One, two, three, four.', { firstMin: 4, clauseMin: 4 }), ['One, two, three,', 'four.'])
})

test('a forced cut moved past an unspeakable run repeats nothing', () => {
  // Found in review: the cut position changed after the skip was measured, and
  // one character came out twice.
  const text = '$ '.repeat(130) + 'pay 5 now. ok'
  const c = createChunker()
  const out = [...c.push(text), ...c.flush()]
  assert.equal(out.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})
