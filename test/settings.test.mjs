// The voice app's model setting (bridge/settings.mjs): VENOM_MODEL over
// appModel in venom.config.json over no model at all, and only values that
// look like a model id. No real files: readFile is injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyMemorySetting, cleanModelId, loadAppModel, MODEL_ID, SETTINGS_FILE } from '../bridge/settings.mjs'

const noFile = () => {
  throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
}
const fileWith = (data) => () => (typeof data === 'string' ? data : JSON.stringify(data))
const collect = () => {
  const said = []
  return { said, warn: (m) => said.push(m) }
}

test('none: no environment and no file mean no model (Claude Code default)', () => {
  const { said, warn } = collect()
  assert.equal(loadAppModel({ env: {}, readFile: noFile, warn }), '')
  assert.deepEqual(said, [])
  assert.match(SETTINGS_FILE.replace(/\\/g, '/'), /\/venom\.config\.json$/)
})

test('file: appModel from venom.config.json', () => {
  assert.equal(loadAppModel({ env: {}, readFile: fileWith({ appModel: 'example-model-1' }) }), 'example-model-1')
  // The example config ships it empty, which is the same as not set.
  assert.equal(loadAppModel({ env: {}, readFile: fileWith({ appModel: '' }) }), '')
  assert.equal(loadAppModel({ env: {}, readFile: fileWith({ ownerName: 'Sam' }) }), '')
  let asked = ''
  loadAppModel({ env: {}, file: 'x/venom.config.json', readFile: (p) => ((asked = p), '{}') })
  assert.equal(asked, 'x/venom.config.json')
})

test('the example config names no model', () => {
  const text = readFileSync(new URL('../venom.config.example.json', import.meta.url), 'utf8')
  assert.equal(JSON.parse(text).appModel, '')
  assert.equal(loadAppModel({ env: {}, readFile: fileWith(text) }), '')
})

test('precedence: VENOM_MODEL wins over the file', () => {
  const read = fileWith({ appModel: 'file-model' })
  assert.equal(loadAppModel({ env: { VENOM_MODEL: 'env-model' }, readFile: read }), 'env-model')
  // Blank or invalid environment values fall through to the file.
  assert.equal(loadAppModel({ env: { VENOM_MODEL: '   ' }, readFile: read }), 'file-model')
  assert.equal(loadAppModel({ env: { VENOM_MODEL: 'bad model!' }, readFile: read }), 'file-model')
  // The file is not even read when the environment decides.
  assert.equal(loadAppModel({ env: { VENOM_MODEL: 'env-model' }, readFile: () => assert.fail('read') }), 'env-model')
})

test('broken file: not JSON, or not an object, warns and gives no model', () => {
  for (const text of ['{ not json', '[1,2]', '"model"', 'null']) {
    const { said, warn } = collect()
    assert.equal(loadAppModel({ env: {}, readFile: fileWith(text), warn }), '')
    assert.equal(said.length, 1, text)
  }
  // A byte-order mark is fine.
  assert.equal(loadAppModel({ env: {}, readFile: fileWith('\uFEFF{"appModel":"m-1"}') }), 'm-1')
})

test('values: non-strings and whitespace are not set; trimmed otherwise', () => {
  for (const appModel of [42, true, ['m'], { id: 'm' }]) {
    const { said, warn } = collect()
    assert.equal(loadAppModel({ env: {}, readFile: fileWith({ appModel }), warn }), '')
    assert.equal(said.length, 1)
    assert.match(said[0], /not a string/)
  }
  assert.equal(loadAppModel({ env: {}, readFile: fileWith({ appModel: null }) }), '')
  assert.equal(loadAppModel({ env: {}, readFile: fileWith({ appModel: ' \t\n ' }) }), '')
  assert.equal(loadAppModel({ env: {}, readFile: fileWith({ appModel: '  m-2  ' }) }), 'm-2')
})

test('memory setting: "gbrain": true in the file switches GBrain on when VENOM_GBRAIN is unset', () => {
  const env = {}
  assert.equal(applyMemorySetting({ env, readFile: fileWith({ gbrain: true }) }), 'config')
  assert.equal(env.VENOM_GBRAIN, '1')
  let asked = ''
  applyMemorySetting({ env: {}, file: 'x/venom.config.json', readFile: (p) => ((asked = p), '{}') })
  assert.equal(asked, 'x/venom.config.json')
})

test('memory setting: a test run never follows the file (the person may have GBrain on)', () => {
  const env = { NODE_TEST_CONTEXT: 'child-v8' }
  const read = () => assert.fail('the file must not be read during a test run')
  assert.equal(applyMemorySetting({ env, readFile: read }), 'off')
  assert.ok(!('VENOM_GBRAIN' in env))
  const chosen = { NODE_TEST_CONTEXT: 'child-v8', VENOM_GBRAIN: '1' }
  assert.equal(applyMemorySetting({ env: chosen, readFile: read }), 'env')
})

test('memory setting: false, missing, a string or no file leave VENOM_GBRAIN unset', () => {
  for (const data of [{ gbrain: false }, {}, { gbrain: 'true' }, { gbrain: 1 }, { gbrain: null }, '{ not json', '[1]']) {
    const env = {}
    assert.equal(applyMemorySetting({ env, readFile: fileWith(data) }), 'off', JSON.stringify(data))
    assert.ok(!('VENOM_GBRAIN' in env), JSON.stringify(data))
  }
  const env = {}
  assert.equal(applyMemorySetting({ env, readFile: noFile }), 'off')
  assert.deepEqual(env, {})
})

test('memory setting: any VENOM_GBRAIN in the environment wins, even blank or 0', () => {
  for (const v of ['0', '', '1', 'yes']) {
    const env = { VENOM_GBRAIN: v }
    const read = () => assert.fail('the file must not be read')
    assert.equal(applyMemorySetting({ env, readFile: read }), 'env')
    assert.equal(env.VENOM_GBRAIN, v)
  }
})

test('sanitising: only model-id shaped values pass, with a warning that does not echo the value', () => {
  for (const ok of ['a', 'vendor/model-1.5', 'model:tag', 'm_2-x.y', 'x'.repeat(100)]) {
    assert.equal(cleanModelId(ok), ok)
    assert.ok(MODEL_ID.test(ok))
  }
  for (const bad of ['two words', 'a;rm', 'm\nnext', 'x'.repeat(101), '--model=x y', 'm"q', 'm[1]']) {
    const { said, warn } = collect()
    assert.equal(cleanModelId(bad, { warn, source: 'VENOM_MODEL' }), '')
    assert.equal(said.length, 1, bad)
    assert.match(said[0], /^VENOM_MODEL does not look like a model id/)
    assert.ok(!said[0].includes(bad))
  }
})
