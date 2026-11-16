// The bridge starts the GBrain start script for real: the script lives in the
// person's home folder, and a home folder may hold a space.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetGbrainAutostart, ensureGbrainServer } from '../bridge/gbrain.mjs'

const WIN = process.platform === 'win32'
const CRLF = String.fromCharCode(13, 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('autostart: a real start script in a folder with a space runs', { skip: !WIN && 'Windows only' }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'venom-autostart-')), 'home with space', '.gbrain')
  mkdirSync(dir, { recursive: true })
  const marker = join(dir, 'started.txt')
  const script = join(dir, 'start-gbrain-server.cmd')
  writeFileSync(script, `@echo off${CRLF}echo started> "${marker}"${CRLF}`)
  _resetGbrainAutostart()
  const r = await ensureGbrainServer(
    { enabled: true, autostart: true, baseUrl: 'http://127.0.0.1:9', startCmd: script },
    {
      env: {},
      fetchImpl: async () => {
        throw new Error('not answering')
      },
    },
  )
  assert.deepEqual(r, { started: true, why: 'started' })
  for (let i = 0; i < 50 && !existsSync(marker); i++) await sleep(100)
  assert.ok(existsSync(marker), 'the start script ran')
  _resetGbrainAutostart()
})
