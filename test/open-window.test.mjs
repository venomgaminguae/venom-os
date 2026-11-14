// The app-window launcher (scripts/open-window.mjs) and the start script's
// --window flag. Chrome is never started here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, constants as fsConstants, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROME, chromeArgs, openWindow, waitForPorts, windowAlreadyOpen } from '../scripts/open-window.mjs'

const START = fileURLToPath(new URL('../scripts/start.mjs', import.meta.url))

test('CHROME is Google Chrome, not Edge', () => {
  assert.equal(CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  assert.doesNotMatch(CHROME, /edge/i)
})

test('chromeArgs: an app window on its own profile, full screen unless asked otherwise', () => {
  const url = 'http://localhost:5173'
  const profile = 'C:\\Users\\x\\.venom\\chrome-app'
  assert.deepEqual(chromeArgs({ url, profile }), [
    `--user-data-dir=${profile}`,
    `--app=${url}`,
    '--start-fullscreen',
    '--no-first-run',
    '--no-default-browser-check',
  ])
  assert.deepEqual(chromeArgs({ url, profile, fullscreen: false }), [
    `--user-data-dir=${profile}`,
    `--app=${url}`,
    '--window-size=1400,850',
    '--no-first-run',
    '--no-default-browser-check',
  ])
  assert.match(chromeArgs({ url }).find((a) => a.startsWith('--user-data-dir=')), /[\\/]\.venom[\\/]chrome-app$/)
})

test('windowAlreadyOpen: no profile or no lock file is false; a free lock file is false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-window-'))
  try {
    assert.equal(windowAlreadyOpen(join(dir, 'missing')), false)
    assert.equal(windowAlreadyOpen(dir), false)
    writeFileSync(join(dir, 'lockfile'), '')
    assert.equal(windowAlreadyOpen(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('windowAlreadyOpen: a lock file held open exclusively is true (Windows)', { skip: process.platform !== 'win32' && 'Windows lock semantics' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-window-'))
  const lock = join(dir, 'lockfile')
  // Chrome opens its lockfile without sharing; libuv's UV_FS_O_EXLOCK flag
  // (0x10000000 on Windows; not every Node exports the constant) does the same.
  const { O_RDWR } = fsConstants
  const EXLOCK = fsConstants.UV_FS_O_EXLOCK ?? 0x10000000
  let fd = null
  try {
    writeFileSync(lock, '')
    fd = openSync(lock, O_RDWR | EXLOCK)
    assert.equal(windowAlreadyOpen(dir), true)
    closeSync(fd)
    fd = null
    assert.equal(windowAlreadyOpen(dir), false) // Chrome gone: the file stays, the lock does not
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('openWindow: no Chrome at the path is "no-chrome", without throwing', () => {
  const saved = process.env.VENOM_CHROME
  const dir = mkdtempSync(join(tmpdir(), 'venom-window-'))
  process.env.VENOM_CHROME = join(dir, 'no-such-chrome.exe')
  try {
    assert.equal(openWindow({ url: 'http://localhost:5173', profile: join(dir, 'profile') }), 'no-chrome')
  } finally {
    if (saved === undefined) delete process.env.VENOM_CHROME
    else process.env.VENOM_CHROME = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('waitForPorts: true once every port accepts, false on timeout', async () => {
  const server = createServer((s) => s.destroy())
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    assert.equal(await waitForPorts([port], 2000), true)
    // A port nobody listens on: the one we just had, closed.
    const spare = createServer()
    await new Promise((r) => spare.listen(0, '127.0.0.1', r))
    const dead = spare.address().port
    await new Promise((r) => spare.close(r))
    assert.equal(await waitForPorts([port, dead], 600, 100), false)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('start.mjs parses', () => {
  const r = spawnSync(process.execPath, ['--check', START], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
