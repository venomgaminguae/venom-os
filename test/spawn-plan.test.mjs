// scripts/spawn-plan.mjs: a .cmd program on Windows goes through cmd.exe with
// its arguments intact; everything else is started as it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBatchFile, spawnPlan } from '../scripts/spawn-plan.mjs'

const WIN = process.platform === 'win32'
const CRLF = String.fromCharCode(13, 10)

test('spawnPlan: only a batch file on Windows is wrapped', () => {
  assert.equal(isBatchFile('C:/x/hermes.cmd', 'win32'), true)
  assert.equal(isBatchFile('C:/x/HERMES.BAT', 'win32'), true)
  assert.equal(isBatchFile('C:/x/hermes.exe', 'win32'), false)
  assert.equal(isBatchFile('/usr/bin/hermes.cmd', 'linux'), false)
  assert.deepEqual(spawnPlan('C:/x/hermes.exe', ['-p', 'a b'], { platform: 'win32' }), {
    file: 'C:/x/hermes.exe',
    args: ['-p', 'a b'],
    options: {},
  })
  assert.deepEqual(spawnPlan('/bin/hermes', ['x'], { platform: 'linux' }), { file: '/bin/hermes', args: ['x'], options: {} })
  const plan = spawnPlan('C:/my folder/hermes.cmd', ['chat'], { platform: 'win32', comspec: 'C:/Windows/cmd.exe' })
  assert.equal(plan.file, 'C:/Windows/cmd.exe')
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(plan.options.windowsVerbatimArguments, true)
  assert.ok(plan.args[3].startsWith('"') && plan.args[3].endsWith('"'))
})

test('spawnPlan: a real .cmd shim in a folder with a space receives every argument unchanged', { skip: !WIN && 'Windows only' }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'venom-spawn-')), 'with space')
  mkdirSync(dir, { recursive: true })
  const echo = join(dir, 'echo.mjs')
  writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  const shim = join(dir, 'tool.cmd')
  writeFileSync(shim, `@"${process.execPath}" "${echo}" %*${CRLF}`)
  const args = [
    '-p',
    'venom',
    'chat',
    '-q',
    'Reply with the single word READY.',
    'a "quoted" word & an ampersand | pipe < > ^ caret (brackets) 100% done!',
    'C:\\folder with space\\file.txt',
    'trailing backslash\\',
    '',
  ]
  const plan = spawnPlan(shim, args)
  const r = spawnSync(plan.file, plan.args, { encoding: 'utf8', ...plan.options })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), args)
})
