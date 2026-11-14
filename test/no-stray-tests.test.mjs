// Keeps `npm test` (plain `node --test`) away from the live app.
//
// Node's runner picks up every file named like a test anywhere in the repo,
// not only under test/. A manual tool with such a name (hermes-mcp/ask-bridge.mjs
// used to be bridge-test.mjs) then runs on every `npm test`, asks the LIVE
// bridge a real question and adds a line to the owner's conversation log.
// Pure file reads: nothing is spawned, nothing is written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEST_DIR = join(ROOT, 'test')
const SKIP = new Set(['node_modules', '.git', 'dist', 'graphify-out', 'desktop', 'test'])

// Node's default patterns: **/*.test.*, **/*-test.*, **/*_test.*, **/test-*.*,
// **/test.*, and everything under a test/ folder (js, cjs, mjs; ts, cts, mts
// with type stripping).
const EXT = String.raw`\.(?:c|m)?[jt]s$`
const TEST_NAME = new RegExp(String.raw`(?:[.\-_]test${EXT})|(?:^test-.*${EXT})|(?:^test${EXT})`)

/** Repo-relative paths of files outside test/ that `node --test` would run. */
function strays(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) {
      if (dir === ROOT && SKIP.has(e.name)) continue
      if (SKIP.has(e.name) && e.name !== 'test') continue
      // A test/ folder anywhere but the root one is run whole by Node.
      if (e.name === 'test') {
        for (const f of walk(path)) if (new RegExp(EXT).test(f)) out.push(relative(ROOT, f))
        continue
      }
      strays(path, out)
    } else if (TEST_NAME.test(e.name)) {
      out.push(relative(ROOT, path))
    }
  }
  return out
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

test('no file outside test/ is named like a test', () => {
  const found = strays().map((p) => p.split(sep).join('/'))
  assert.deepEqual(
    found,
    [],
    `\`npm test\` runs \`node --test\`, which would run these files too: ${found.join(', ')}. ` +
      'Move real tests into test/ and rename manual tools (e.g. ask-bridge.mjs) so they match none of ' +
      '*.test.*, *-test.*, *_test.*, test-*.*, test.*',
  )
})

test('the pattern catches what Node would run and nothing else', () => {
  for (const name of ['a.test.mjs', 'bridge-test.mjs', 'x_test.js', 'test-a.mjs', 'test.mjs', 'b.test.ts'])
    assert.ok(TEST_NAME.test(name), name)
  for (const name of ['ask-bridge.mjs', 'selftest.mjs', 'latest.mjs', 'contest.mjs', 'test.md', 'testing.mjs'])
    assert.ok(!TEST_NAME.test(name), name)
})

// A connection from a test to the live bridge (8787) or the live page (5173).
// Narrow on purpose: only a ws:// URL, `new WebSocket(` or `fetch(` naming the
// port counts. policy.test.mjs passes an http://127.0.0.1:8787 URL as plain
// data to a policy function that must refuse it; that is not a connection.
const LIVE = /(?:ws:\/\/|new WebSocket\(|fetch\()[^\n]*?(?:localhost|127\.0\.0\.1|\[::1\]):(?:8787|5173)\b/

test('no test connects to the live bridge or page', () => {
  const hits = []
  for (const file of walk(TEST_DIR)) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (LIVE.test(line)) hits.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1}`)
      })
  }
  assert.deepEqual(hits, [], `tests must start their own bridge on port 0, never use the live one: ${hits.join(', ')}`)
})

test('the live-connection pattern', () => {
  assert.ok(LIVE.test(`new WebSocket('ws://localhost:${8787}')`))
  assert.ok(LIVE.test(`await fetch('http://127.0.0.1:${8787}/health')`))
  assert.ok(!LIVE.test(`allowed('WebFetch', { url: 'http://127.0.0.1:${8787}/file?path=/x.png' })`))
  assert.ok(!LIVE.test("new WebSocket(`ws://127.0.0.1:${bridge.port}`)"))
})
