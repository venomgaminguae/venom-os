// "Hey Venom" must wake him, including the usual dictation mishearings, and
// must not fire on ordinary speech or on the old name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAKE, BARE_NAME, LEADING_NAME, afterWake, wakeVariant } from '../src/lib/wake.ts'

test('the wake phrase and its mishearings all wake him', () => {
  for (const said of ['hey venom', 'Hey Venom', 'venom', 'ok venom', 'hey venmo', 'hey phenom', 'yo venum']) {
    assert.ok(WAKE.test(said), `should wake on "${said}"`)
  }
})

test('ordinary speech and the old name do not wake him', () => {
  for (const said of ['hey jarvis', 'venomous snake', "venom's job is done", 'the event is tomorrow', 'hey', 'phenomenal work']) {
    assert.ok(!WAKE.test(said), `should not wake on "${said}"`)
  }
})

test('the command after the wake phrase is kept', () => {
  assert.equal(afterWake("Hey Venom, what's the weather in Paris?"), "what's the weather in Paris?")
  assert.equal(afterWake('venom: compare GPU prices'), 'compare GPU prices')
  assert.equal(afterWake('hey venom'), '')
})

test('a bare name is recognised, a real command is trimmed', () => {
  assert.ok(BARE_NAME.test('Hey Venom.'))
  assert.ok(!BARE_NAME.test('Hey Venom, open the report'))
  assert.equal('Venom, open the report'.replace(LEADING_NAME, ''), 'open the report')
})

// What local Whisper wrote, twice, in the desktop app's log on 13 Nov 2026.
test('"Hey Vero" wakes him and the request survives', () => {
  const heard = "Hey Vero, how's the weather today?"
  assert.ok(WAKE.test(heard))
  assert.equal(afterWake(heard), "how's the weather today?")
  assert.equal(wakeVariant(heard), 'vero')
})

test('a greeting followed by a mishearing of the name wakes him', () => {
  const names = [
    'vero', 'venum', 'venam', 'vennom', 'venim', 'vemon', 'venon', 'benom', 'fenom', 'phenom',
    'vinum', 'ven um', 'the nom', 'veno', 'venem', 'vanum',
  ]
  for (const greeting of ['hey', 'Hi', 'ok', 'Okay', 'hello']) {
    for (const name of names) {
      const said = `${greeting} ${name}, open the report`
      assert.ok(WAKE.test(said), `should wake on "${said}"`)
      assert.equal(afterWake(said), 'open the report', `command after "${said}"`)
      assert.equal(wakeVariant(said), name, `variant in "${said}"`)
    }
  }
  assert.ok(WAKE.test('Hey, Vero. What time is it?'))
  assert.equal(afterWake('Hey, Vero. What time is it?'), 'What time is it?')
  assert.ok(WAKE.test('so I said hey venam what is next'))
})

test('a mishearing alone wakes him only as the first word said', () => {
  assert.ok(WAKE.test('Vero, what time is it?'))
  assert.equal(afterWake('Vero, what time is it?'), 'what time is it?')
  assert.ok(WAKE.test('Venam.'))
  assert.equal(afterWake('Venam.'), '')
  for (const said of ['it was in vero beach', 'the vinum was fine', 'a trip to benin next year', 'ven um is not a word', 'the nom de plume']) {
    assert.ok(!WAKE.test(said), `should not wake on "${said}"`)
  }
})

test('greetings in ordinary speech do not wake him', () => {
  const ordinary = [
    'hey there', 'hey very good', 'hey Vera can you', 'hey man', 'hey everyone', 'hey Vernon',
    'hey Vernon, are you coming?', 'hello everyone', 'ok then', 'okay very well', 'hi Ben', 'hey Benny',
    'hey Kevin', 'hey Venus', 'hey, the venue is booked', 'hey lemon', 'hey Simon', 'hey woman',
    'hey phenomenal work', 'hey venomous thing', "hey vero's place is nice", 'ok fine', 'hey the name is wrong',
    'hello Vivian', 'hey van', 'hi Vince',
  ]
  for (const said of ordinary) {
    assert.ok(!WAKE.test(said), `should not wake on "${said}"`)
    assert.equal(wakeVariant(said), '')
  }
})

test('the variant that matched is named', () => {
  assert.equal(wakeVariant('Hey Venom, hello'), 'venom')
  assert.equal(wakeVariant('Venom'), 'venom')
  assert.equal(wakeVariant('okay Ven  Um go'), 'ven um')
  assert.equal(wakeVariant('nothing here'), '')
})

test('a mishearing is trimmed as a vocative only after a greeting', () => {
  assert.ok(BARE_NAME.test('Hey Vero.'))
  assert.equal('Hey Vero, open the report'.replace(LEADING_NAME, ''), 'open the report')
  // Mid-conversation a request may really begin with such a word.
  assert.equal('Vero Beach weather'.replace(LEADING_NAME, ''), 'Vero Beach weather')
  assert.ok(!BARE_NAME.test('Benin'))
})

// What local Whisper wrote for synthetic voices played through the app's
// microphone path on 13 Nov 2026 (scripts/turn-proof.mjs).
test('"Hey Venoms" and "Ivanim" (Hi Venom run together) wake him', () => {
  const plural = "Hey Venoms. What's on my calendar tomorrow?"
  assert.ok(WAKE.test(plural))
  assert.equal(afterWake(plural), "What's on my calendar tomorrow?")
  assert.equal(wakeVariant('Hey Venoms!'), 'venoms')
  assert.ok(BARE_NAME.test('Hey Venoms.'))
  assert.equal('Hey Venoms, open the report'.replace(LEADING_NAME, ''), 'open the report')
  const fused = 'Ivanim, are you there?'
  assert.ok(WAKE.test(fused))
  assert.equal(afterWake(fused), 'are you there?')
  assert.equal(wakeVariant(fused), 'ivanim')
  const ordinary = [
    'venoms are dangerous', 'the venoms of two snakes', "hey venom's job is done", 'Ivan, are you there?',
    'Ivana is here', 'Ivanka called', 'I ran in the morning', 'so Ivanim said no', 'Evening, everyone',
    'I mean it', 'Okay then, stop.',
  ]
  for (const said of ordinary) {
    assert.ok(!WAKE.test(said), `should not wake on "${said}"`)
  }
  // Mid-conversation a request that begins with the run-together form is left alone.
  assert.equal('Ivanim is a name'.replace(LEADING_NAME, ''), 'Ivanim is a name')
})
