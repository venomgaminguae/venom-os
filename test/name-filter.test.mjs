// The assistant's name is Venom OS. Whatever the model writes, "Jarvis" must never
// reach the screen or the speaker, even when it arrives split across chunks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNameFilter } from '../src/lib/name-filter.ts'

/** Feed chunks through one filter and return everything it let out. */
function run(chunks) {
  const f = createNameFilter()
  return chunks.map((c) => f.push(c)).join('') + f.flush()
}

test('a whole name in one chunk is replaced', () => {
  assert.equal(run(['I am Jarvis, your assistant.']), 'I am Venom OS, your assistant.')
})

test('a name split across chunks is replaced', () => {
  assert.equal(run(['I am Jar', 'vis, sir.']), 'I am Venom OS, sir.')
  assert.equal(run(['I am J', 'a', 'r', 'v', 'i', 's.']), 'I am Venom OS.')
})

test('capitalisation is kept', () => {
  assert.equal(run(['JARVIS online. jarvis here.']), 'VENOM OS online. venom os here.')
})

test('the dotted acronym is replaced', () => {
  assert.equal(run(['Welcome to J.A.R.V.I.S. today']), 'Welcome to VENOM OS today')
})

test('ordinary text passes through unchanged and nothing is lost at the end', () => {
  assert.equal(run(['Prices are up. Ja']), 'Prices are up. Ja')
  assert.equal(run(['The render is complete, sir.']), 'The render is complete, sir.')
})

test('a held-back prefix is released as soon as it stops matching', () => {
  const f = createNameFilter()
  assert.equal(f.push('Ja'), '')
  assert.equal(f.push('pan'), 'Japan')
})
