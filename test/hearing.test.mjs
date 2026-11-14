import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFailureRun, wakeBreathCommand, wakeRouteFor } from '../src/lib/hearing.ts'

test('wake route: hybrid only for local hearing with Chrome available', () => {
  assert.equal(wakeRouteFor('local', 'browser', true), 'browser')
  assert.equal(wakeRouteFor('local', 'browser', false), 'local')
  assert.equal(wakeRouteFor('local', 'local', true), 'local')
  assert.equal(wakeRouteFor('elevenlabs', 'browser', true), 'n/a')
  assert.equal(wakeRouteFor('browser', 'local', true), 'browser')
})

test('the breath that woke him: the request is what followed his name', () => {
  assert.equal(wakeBreathCommand('Hey Venom, what is the weather?', true, 'what is the weather?'), 'what is the weather?')
  // Only the name: nothing to ask.
  assert.equal(wakeBreathCommand('Hey Venom.', true, ''), '')
  // Chrome caught the name, Whisper did not: keep the words.
  assert.equal(wakeBreathCommand(' what is the weather? ', false, ''), 'what is the weather?')
})

test('failure run fires once at the limit and resets on success', () => {
  const f = makeFailureRun(3)
  assert.equal(f.fail(), false)
  assert.equal(f.fail(), false)
  f.ok()
  assert.equal(f.count(), 0)
  assert.equal(f.fail(), false)
  assert.equal(f.fail(), false)
  assert.equal(f.fail(), true)
  assert.equal(f.fail(), false)
})
