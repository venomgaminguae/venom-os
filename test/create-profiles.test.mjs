// hermes-setup/create-profiles.sh against scripts/fake-hermes.mjs: the
// --agents choice, the quiet screen output with its log, --show-commands,
// --dry-run and a failing command. create-profiles.ps1 mirrors it; its
// end-to-end run lives in setup-brain.test.mjs (needs pwsh).
//
// Every run points HERMES_EXE at a shim for the fake and TMPDIR at the test's
// own temp folder, so neither the real Hermes nor the real temp folder is used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'hermes-setup', 'create-profiles.sh').replace(/\\/g, '/')
const FAKE = join(ROOT, 'scripts', 'fake-hermes.mjs')
const WIN = process.platform === 'win32'
const fwd = (p) => p.replace(/\\/g, '/')

function realWhich(name) {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8' })
  if (r.status !== 0) return ''
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? ''
}
// On Windows `bash` on PATH may be WSL's, which cannot see this folder: use Git's.
const BASH = WIN
  ? [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean).map((r) => join(r, 'Git', 'bin', 'bash.exe')).find((p) => existsSync(p)) ?? ''
  : realWhich('bash')
const skip = !BASH && 'bash not found'

const ALL = ['researcher', 'coder', 'operator', 'writer']

/** A temp world: fake Hermes state, a temp folder for the default log, a repo with the connector stand-in, shims. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'venom-profiles-'))
  const w = { dir, state: join(dir, 'state'), tmp: join(dir, 'tmp'), bin: join(dir, 'bin'), repo: join(dir, 'repo') }
  for (const d of [w.state, w.tmp, w.bin, join(w.repo, 'hermes-mcp')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(w.repo, 'hermes-mcp', 'server.mjs'), '// stand-in\n')
  const node = fwd(process.execPath)
  w.shim = join(w.bin, 'hermes')
  writeFileSync(w.shim, `#!/bin/sh\nexec "${node}" "${fwd(FAKE)}" "$@"\n`, { mode: 0o755 })
  // Same, but `config set delegation.model` fails with output on stderr.
  w.failShim = join(w.bin, 'hermes-fail')
  writeFileSync(
    w.failShim,
    `#!/bin/sh\ncase "$*" in *delegation.model*) echo "boom: cannot set" >&2; exit 7;; esac\nexec "${node}" "${fwd(FAKE)}" "$@"\n`,
    { mode: 0o755 },
  )
  return w
}

function run(w, args, { shim = w.shim } = {}) {
  const env = { ...process.env, HERMES_EXE: fwd(shim), FAKE_HERMES_STATE: w.state, TMPDIR: fwd(w.tmp) }
  const base = ['--brain-model', 'test-brain-model', '--brain-provider', 'custom', '--repo-path', fwd(w.repo)]
  const r = spawnSync(BASH, [SCRIPT, ...base, ...args], { encoding: 'utf8', env })
  const lines = r.stdout.replace(/\r/g, '').split('\n').filter(Boolean)
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, lines }
}

const profiles = (w) =>
  existsSync(join(w.state, 'state.json')) ? Object.keys(JSON.parse(readFileSync(join(w.state, 'state.json'), 'utf8')).profiles).sort() : []
const calls = (w) =>
  existsSync(join(w.state, 'calls.jsonl'))
    ? readFileSync(join(w.state, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
const logPath = (lines) => {
  const last = lines.at(-1) ?? ''
  assert.match(last, /^Full output: /, 'the last line names the log')
  return last.slice('Full output: '.length)
}

test('create-profiles.sh --agents coder,writer: only those and the supervisor, one line each, log in the temp folder', { skip }, () => {
  const w = world()
  const r = run(w, ['--agents', 'writer,coder'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.deepEqual(profiles(w), ['coder', 'venom', 'writer'])
  assert.deepEqual(r.lines.slice(0, -1), [
    '# Supervisor: venom. Agents: coder writer. Brain: custom/test-brain-model. Workers: custom/test-brain-model (up to 5).',
    'venom: created, job brief written, models set',
    'coder: created, job brief written, models set',
    'writer: created, job brief written, models set',
    'team connector: registered on venom',
    'Next: sign in to your provider for each profile if needed (hermes -p <name> model), then verify (README.md, "Verify").',
  ])
  assert.ok(!r.stdout.includes('> hermes'), 'no commands on screen')
  const log = logPath(r.lines)
  assert.equal(readdirSync(w.tmp).length, 1, 'one log file in the temp folder')
  const text = readFileSync(log, 'utf8')
  assert.match(text, /^> hermes profile create coder --clone-from venom /m)
  assert.match(text, /^> hermes -p writer config set delegation\.oneshot_max_children 5$/m)
  assert.match(text, /^> hermes -p venom mcp add team --command node --args /m)
  assert.ok(!text.includes('researcher'), 'no researcher step')
  assert.ok(!text.includes('FAKE_HERMES_STATE') && !text.includes('HERMES_EXE') && !text.includes(process.env.PATH ?? '\u0000'), 'no environment in the log')
  const soul = readFileSync(join(w.state, 'profiles', 'coder', 'SOUL.md'), 'utf8')
  assert.match(soul, /## Your job: Coder/)
})

test('create-profiles.sh: all four by default; a second run says exists and recreates nothing', { skip }, () => {
  const w = world()
  const first = run(w, [])
  assert.equal(first.code, 0, first.stdout + first.stderr)
  assert.deepEqual(profiles(w), [...ALL, 'venom'].sort())
  for (const name of ALL) assert.ok(first.lines.includes(`${name}: created, job brief written, models set`), name)

  const before = calls(w).length
  const second = run(w, [])
  assert.equal(second.code, 0, second.stdout + second.stderr)
  for (const name of ['venom', ...ALL]) assert.ok(second.lines.includes(`${name}: exists, job brief up to date, models set`), name)
  assert.ok(second.lines.includes('team connector: already registered on venom'))
  const again = calls(w).slice(before)
  assert.ok(!again.some((a) => a[0] === 'profile' && a[1] === 'create'), 'no profile created twice')
  assert.ok(!again.some((a) => a.includes('add')), 'connector not added twice')
})

test('create-profiles.sh: an unknown, repeated or empty --agents entry stops before anything is created', { skip }, () => {
  for (const [value, message] of [
    ['coder,wizard', /unknown agent 'wizard'/],
    ['coder,coder', /'coder' is listed more than once/],
    ['', /needs one or more of researcher, coder, operator, writer/],
    ['coder,', /no empty entries/],
    ['coder,,writer', /no empty entries/],
  ]) {
    const w = world()
    const r = run(w, ['--agents', value])
    assert.equal(r.code, 64, `${value}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, message, value)
    assert.equal(r.stderr.trim().split('\n').length, 1, `${value}: one line`)
    assert.equal(r.stdout, '', `${value}: nothing on stdout`)
    assert.deepEqual(calls(w), [], `${value}: hermes was never called`)
    assert.deepEqual(readdirSync(w.tmp), [], `${value}: no log written`)
  }
})

test('create-profiles.sh --no-next leaves out the closing Next line; the log line stays last', { skip }, () => {
  const w = world()
  const r = run(w, ['--agents', 'coder', '--no-next'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.deepEqual(r.lines.slice(0, -1), [
    '# Supervisor: venom. Agents: coder. Brain: custom/test-brain-model. Workers: custom/test-brain-model (up to 5).',
    'venom: created, job brief written, models set',
    'coder: created, job brief written, models set',
    'team connector: registered on venom',
  ])
  assert.ok(existsSync(logPath(r.lines)))
  assert.ok(!readFileSync(logPath(r.lines), 'utf8').includes('Next:'), 'not in the log either')
})

test('create-profiles.sh --dry-run prints the commands on screen and runs none', { skip }, () => {
  const w = world()
  const r = run(w, ['--agents', 'coder', '--dry-run'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^# Dry run \(--dry-run\)/m)
  assert.match(r.stdout, /^> hermes profile create coder --clone-from venom /m)
  assert.match(r.stdout, /^> hermes -p coder mcp remove team$/m)
  assert.ok(!r.stdout.includes('writer'), 'only the chosen specialist')
  assert.ok(!r.stdout.includes('Full output'), 'no log without --log')
  assert.deepEqual(calls(w), [])
  assert.deepEqual(readdirSync(w.tmp), [])
})

test('create-profiles.sh --log appends the full output to the given file; --show-commands puts it on screen', { skip }, () => {
  const w = world()
  const log = join(w.dir, 'setup.log')
  const first = run(w, ['--agents', 'researcher', '--log', fwd(log)])
  assert.equal(first.code, 0, first.stdout + first.stderr)
  assert.ok(existsSync(logPath(first.lines)))
  const second = run(w, ['--agents', 'researcher', '--log', fwd(log), '--show-commands'])
  assert.equal(second.code, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /^> hermes -p researcher config set model\.default test-brain-model$/m)
  assert.match(second.stdout, /^researcher: exists, job brief up to date, models set$/m)
  const text = readFileSync(log, 'utf8')
  assert.equal(text.match(/^# Supervisor: venom\./gm)?.length, 2, 'both runs appended')
  assert.match(text, /^> hermes profile create researcher --clone-from venom /m)
  assert.match(text, /^profile 'researcher' exists, not recreated$/m)
  assert.deepEqual(readdirSync(w.tmp), [], 'no temp log when --log is given')
})

test('create-profiles.sh: a failing command and its output reach the screen', { skip }, () => {
  const w = world()
  const r = run(w, ['--agents', 'coder'], { shim: w.failShim })
  assert.equal(r.code, 7, r.stdout + r.stderr)
  assert.match(r.stderr, /^> hermes -p venom config set delegation\.model test-brain-model$/m)
  assert.match(r.stderr, /boom: cannot set/)
  assert.match(r.stderr, /failed with exit code 7/)
  const text = readFileSync(logPath(r.lines), 'utf8')
  assert.match(text, /boom: cannot set/)
})
