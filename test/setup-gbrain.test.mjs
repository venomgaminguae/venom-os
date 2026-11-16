// scripts/setup-gbrain.mjs: the optional long-term memory stage of the setup
// wizard, and scripts/fake-gbrain.mjs, its stand-in program.
//
// Nothing here reaches the real GBrain, the real home folder or port 3131:
// every home is a temp folder, `gbrain` is scripts/fake-gbrain.mjs (run
// through child_process), `hermes` is an in-memory stub, and the only real
// server is the fake one on an OS-assigned free port.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GBRAIN_PORT,
  GBRAIN_SOURCE,
  GBRAIN_URL,
  HERMES_ENV_KEY,
  Q_GBRAIN,
  bunInstallCommand,
  findBun,
  findGbrain,
  gbrainPaths,
  gbrainPrereq,
  gbrainStage,
  hasGbrainRow,
  parseToken,
  setEnvLine,
  startScript,
} from '../scripts/setup-gbrain.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = join(ROOT, 'scripts', 'fake-gbrain.mjs')
const HERMES = 'fake-hermes'
const PLATFORM = process.platform
const EXE = (name) => (PLATFORM === 'win32' ? `${name}.exe` : name)
const letters = (n) => 'abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n)
const fakeTokenText = () => ['gbrain', letters(64)].join('_')

/** A free port chosen by the OS (never 3131). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** The process environment minus every switch these programs read. */
function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(FAKE_GBRAIN_|GBRAIN_|BUN_EXE|VENOM_GBRAIN)/.test(k)) delete env[k]
  return { ...env, ...extra }
}

const runFake = (args, env) => spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', env, timeout: 30000 })
const isGbrain = (cmd) => /^gbrain(\.exe)?$/.test(basename(String(cmd))) || cmd === 'fake-gbrain'

/** A Hermes stub: profiles with flat config keys, mcp list/test, env-path. */
function hermesStub(dir, { mcpTest = 0, setFails = false } = {}) {
  const profiles = {}
  const calls = []
  const get = (p) => (profiles[p] ??= { config: {} })
  const run = (args) => {
    calls.push(args)
    const [, p, cmd, sub, ...rest] = args
    const prof = get(p)
    if (cmd === 'mcp' && sub === 'list') {
      const url = prof.config['mcp_servers.gbrain.url']
      if (!url) return { code: 0, stdout: '\n  No MCP servers configured.\n', stderr: '' }
      return { code: 0, stdout: `\n  MCP Servers:\n\n  ${'gbrain'.padEnd(16)} ${url.padEnd(30)} ${'all'.padEnd(12)} ✓ enabled\n`, stderr: '' }
    }
    if (cmd === 'config' && sub === 'env-path') return { code: 0, stdout: join(dir, 'hermes', p, '.env') + '\n', stderr: '' }
    if (cmd === 'config' && sub === 'set') {
      if (setFails) return { code: 1, stdout: '', stderr: 'refused' }
      prof.config[rest[0]] = rest[1]
      return { code: 0, stdout: `Set ${rest[0]}\n`, stderr: '' }
    }
    if (cmd === 'mcp' && sub === 'test') {
      if (!prof.config['mcp_servers.gbrain.url']) return { code: 3, stdout: "  ✗ Server 'gbrain' not found in config.\n", stderr: '' }
      return { code: mcpTest, stdout: mcpTest ? '  ✗ Connection failed\n' : '  ✓ Connected (5ms)\n', stderr: '' }
    }
    return { code: 64, stdout: '', stderr: 'unknown' }
  }
  return { profiles, calls, run }
}

/**
 * A temp world for the stage: a home folder, the fake gbrain behind `run`,
 * a Hermes stub, and a server that is "up" once startDetached was called.
 */
async function world(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'venom-setup-gbrain-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const fakeLog = join(dir, 'fake-gbrain.log')
  const w = {
    dir,
    home,
    fakeLog,
    port: await freePort(),
    said: [],
    asked: [],
    answers: [],
    runCalls: [],
    inherit: [],
    started: [],
    sleeps: 0,
    up: false,
    hermes: hermesStub(dir, o.hermes),
    env: cleanEnv({ FAKE_GBRAIN_LOG: fakeLog, ...(o.env ?? {}) }),
    present: new Set(o.present ?? ['gbrain']), // programs on "PATH"
    startWorks: o.startWorks ?? true,
  }
  w.deps = () => ({
    ask: async (q) => {
      w.asked.push(q)
      return w.answers.length ? w.answers.shift() : ''
    },
    say: (line) => w.said.push(String(line)),
    run: async (cmd, args, opts = {}) => {
      w.runCalls.push({ cmd, args, env: opts.env })
      if (cmd === HERMES) return w.hermes.run(args)
      assert.ok(isGbrain(cmd), `unexpected program: ${cmd}`)
      const r = runFake(args, opts.env)
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    },
    runInherit: async (cmd, args) => {
      w.inherit.push({ cmd, args })
      // The installers "install" by creating the program in <home>/.bun/bin.
      const bin = join(home, '.bun', 'bin')
      mkdirSync(bin, { recursive: true })
      if (args.includes(GBRAIN_SOURCE)) writeFileSync(join(bin, EXE('gbrain')), '')
      else writeFileSync(join(bin, EXE('bun')), '')
      return { code: 0 }
    },
    startDetached: (cmd, args) => {
      w.started.push({ cmd, args })
      if (w.startWorks) w.up = true
    },
    fetchStatus: async (url) => {
      assert.ok(!url.includes(':3131/'), 'never the real port')
      return w.up ? 200 : 0
    },
    sleep: async () => {
      w.sleeps++
    },
    exists: (p) => existsSync(p),
    which: (name) => (w.present.has(name) ? `fake-${name}` : ''),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, text) => writeFileSync(p, text),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    platform: PLATFORM,
    env: w.env,
    home,
    hermes: HERMES,
    profiles: ['venom', 'coder'],
    port: w.port,
    now: () => new Date(),
  })
  w.paths = gbrainPaths({ home, env: w.env, platform: PLATFORM })
  w.fakeCalls = () => (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
  w.stage = () => gbrainStage(w.deps())
  return w
}

/** Every token in the world's files, and the check that none of them leaked. */
function assertNoToken(w, result) {
  const tokens = [w.paths.appToken, w.paths.hermesToken]
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8').trim())
  const seen = [
    ...w.said,
    ...w.asked,
    JSON.stringify(result),
    JSON.stringify(w.runCalls.map((c) => c.args)),
    JSON.stringify(w.hermes.calls),
    JSON.stringify(w.hermes.profiles),
    JSON.stringify(w.inherit),
    JSON.stringify(w.started),
    existsSync(w.fakeLog) ? readFileSync(w.fakeLog, 'utf8') : '',
  ].join('\n')
  for (const t of tokens) {
    assert.match(t, /^gbrain_[A-Za-z0-9_-]{20,}$/)
    assert.ok(!seen.includes(t), 'a token leaked into output, a result, a command line or a log')
  }
  assert.doesNotMatch(seen, /gbrain_[A-Za-z0-9_-]{20,}/)
  return tokens
}

// ------------------------------------------------------------------ pure helpers

test('constants', () => {
  assert.equal(GBRAIN_SOURCE, 'github:garrytan/gbrain#stable')
  assert.equal(GBRAIN_PORT, 3131)
  assert.equal(GBRAIN_URL, 'https://github.com/garrytan/gbrain')
})

test('bunInstallCommand: the official commands', () => {
  const win = bunInstallCommand('win32')
  assert.equal(win.shown, 'powershell -c "irm bun.sh/install.ps1 | iex"')
  assert.equal(win.args.at(-1), 'irm bun.sh/install.ps1 | iex')
  const nix = bunInstallCommand('linux')
  assert.equal(nix.shown, 'curl -fsSL https://bun.sh/install | bash')
  assert.deepEqual([nix.command, ...nix.args], ['bash', '-c', 'curl -fsSL https://bun.sh/install | bash'])
  assert.equal(bunInstallCommand('darwin').shown, nix.shown)
})

test('findBun / findGbrain: env wins, then PATH, then ~/.bun/bin', () => {
  const home = join(tmpdir(), 'h')
  const has = (...ps) => (p) => ps.includes(p)
  const none = () => ''
  const which = (n) => `/usr/bin/${n}`
  assert.equal(findBun({ platform: 'linux', env: { BUN_EXE: '/x/bun' }, exists: has('/x/bun'), which, home }), '/x/bun')
  assert.equal(findBun({ platform: 'linux', env: { BUN_EXE: '/x/bun' }, exists: has(), which, home }), '')
  assert.equal(findBun({ platform: 'linux', env: {}, exists: has(), which, home }), '/usr/bin/bun')
  assert.equal(findBun({ platform: 'win32', env: {}, exists: has(join(home, '.bun', 'bin', 'bun.exe')), which: none, home }), join(home, '.bun', 'bin', 'bun.exe'))
  assert.equal(findBun({ platform: 'linux', env: {}, exists: has(), which: none, home }), '')
  assert.equal(findGbrain({ platform: 'linux', env: { GBRAIN_EXE: '/g' }, exists: has('/g'), which, home }), '/g')
  assert.equal(findGbrain({ platform: 'linux', env: {}, exists: has(), which, home }), '/usr/bin/gbrain')
  assert.equal(findGbrain({ platform: 'linux', env: {}, exists: has(join(home, '.bun', 'bin', 'gbrain')), which: none, home }), join(home, '.bun', 'bin', 'gbrain'))
  assert.equal(findGbrain({ platform: 'win32', env: {}, exists: has(join(home, '.bun', 'bin', 'gbrain.exe')), which: none, home }), join(home, '.bun', 'bin', 'gbrain.exe'))
})

test('gbrainPaths: GBRAIN_HOME is the parent of .gbrain and wins over home', () => {
  const home = join(tmpdir(), 'h')
  const p = gbrainPaths({ home, env: {}, platform: 'win32' })
  assert.equal(p.gbrainHome, home)
  assert.equal(p.dir, join(home, '.gbrain'))
  assert.equal(p.config, join(home, '.gbrain', 'config.json'))
  assert.equal(p.tokensDir, join(home, '.gbrain', 'tokens'))
  assert.equal(p.appToken, join(home, '.gbrain', 'tokens', 'venom-os.token'))
  assert.equal(p.hermesToken, join(home, '.gbrain', 'tokens', 'hermes.token'))
  assert.equal(p.startCmd, join(home, '.gbrain', 'start-gbrain-server.cmd'))
  assert.equal(p.log, join(home, '.gbrain', 'serve-http.log'))
  const other = join(tmpdir(), 'other')
  assert.equal(gbrainPaths({ home, env: { GBRAIN_HOME: other } }).dir, join(other, '.gbrain'))
  assert.equal(gbrainPaths({ home, env: {}, platform: 'linux' }).startCmd, join(home, '.gbrain', 'start-gbrain-server.sh'))
})

test('parseToken: the real layout, and nothing from anything else', () => {
  const token = fakeTokenText()
  assert.equal(token.length, 71)
  const out = [
    'Token created for "venom-os" (takes_holders=["world"], scopes=full access (grandfathered — pass --scopes read,write to narrow)):',
    '',
    `  ${token}`,
    '',
    'Save this token — it will not be shown again.',
    'Revoke with: gbrain auth revoke venom-os',
    'Change its grants: gbrain auth grant venom-os',
  ].join('\r\n')
  assert.equal(parseToken(out), token)
  assert.equal(parseToken('Token created for "x". See the dashboard.'), '')
  assert.equal(parseToken(''), '')
  assert.equal(parseToken(undefined), '')
})

test('startScript: the three-line .cmd with CRLF, and a sh script elsewhere', () => {
  const home = join(tmpdir(), 'h')
  const text = startScript({ gbrainExe: join(home, '.bun', 'bin', 'gbrain.exe'), gbrainHome: home, port: 3131, log: join(home, '.gbrain', 'serve-http.log'), platform: 'win32' })
  const rows = text.split('\r\n')
  assert.equal(rows.length, 4)
  assert.equal(rows[3], '')
  assert.equal(rows[0], '@echo off')
  assert.equal(rows[1], `set "GBRAIN_HOME=${home}"`)
  assert.equal(
    rows[2],
    `"${join(home, '.bun', 'bin', 'gbrain.exe')}" serve --http --port 3131 --surface full --advertise verbs --suppress-bootstrap-token >> "${join(home, '.gbrain', 'serve-http.log')}" 2>&1`,
  )
  const sh = startScript({ gbrainExe: "/h/it's/gbrain", gbrainHome: '/h', port: 4000, log: '/h/.gbrain/serve-http.log', platform: 'linux' })
  assert.ok(!sh.includes('\r'))
  assert.match(sh, /^#!\/bin\/sh\n/)
  assert.match(sh, /export GBRAIN_HOME='\/h'/)
  assert.match(sh, /exec '\/h\/it'\\''s\/gbrain' serve --http --port 4000 /)
})

test('gbrainPrereq: optional lines, never a failure', () => {
  const home = join(tmpdir(), 'h')
  const none = () => ''
  const a = gbrainPrereq({ platform: 'linux', env: {}, exists: () => false, which: (n) => (n === 'gbrain' ? '/b/gbrain' : ''), home })
  assert.equal(a.gbrain, '/b/gbrain')
  assert.match(a.lines[0], /^\[ok\] GBrain/)
  const b = gbrainPrereq({ platform: 'linux', env: {}, exists: () => false, which: none, home })
  assert.deepEqual([b.bun, b.gbrain], ['', ''])
  assert.match(b.lines[0], /optional/i)
  assert.match(b.lines[0], /Bun/)
  const c = gbrainPrereq({ platform: 'linux', env: { GBRAIN_EXE: '/nope' }, exists: () => false, which: none, home })
  assert.ok(c.lines.some((l) => /GBRAIN_EXE is set/.test(l)))
})

test('setEnvLine and hasGbrainRow', () => {
  assert.equal(setEnvLine('', 'K', 'v'), 'K=v\n')
  assert.equal(setEnvLine('A=1\r\nK=old\r\n', 'K', 'v'), 'A=1\r\nK=v\r\n')
  assert.equal(setEnvLine('A=1', 'K', 'v'), 'A=1\nK=v\n')
  assert.ok(hasGbrainRow(`  ${'gbrain'.padEnd(16)} http://127.0.0.1:1/mcp   all  ✓ enabled`))
  assert.ok(!hasGbrainRow('  No MCP servers configured.'))
  assert.ok(!hasGbrainRow('  gbrainx  x'))
})

// ------------------------------------------------------------------ the stage

test('stage: the whole happy path on a fresh home', async () => {
  const w = await world()
  const r = await w.stage()
  assert.equal(r.status, 'on', w.said.join('\n'))
  assert.deepEqual(w.asked, [Q_GBRAIN.install])
  assert.ok(existsSync(w.paths.config))
  assert.ok(existsSync(join(w.paths.dir, 'brain.pglite')))
  const [app, herm] = assertNoToken(w, r)
  assert.notEqual(app, herm)
  // The start script points at the found program and the test port.
  const script = readFileSync(w.paths.startCmd, 'utf8')
  assert.ok(script.includes(`--port ${w.port} `))
  assert.ok(script.includes('fake-gbrain'))
  assert.equal(w.started.length, 1)
  const calls = w.fakeCalls()
  assert.deepEqual(calls, [
    ['init', '--pglite', '--non-interactive', '--no-embedding'],
    ['auth', 'create', 'venom-os'],
    ['auth', 'create', 'hermes'],
  ])
  // gbrain ran with GBRAIN_HOME set to the temp home.
  for (const c of w.runCalls.filter((c) => c.cmd !== HERMES)) assert.equal(c.env.GBRAIN_HOME, w.home)
  // Each profile: the token in its .env, the placeholder in its config.
  for (const p of ['venom', 'coder']) {
    const cfg = w.hermes.profiles[p].config
    assert.equal(cfg['mcp_servers.gbrain.url'], `http://127.0.0.1:${w.port}/mcp`)
    assert.equal(cfg['mcp_servers.gbrain.headers.Authorization'], `Bearer \${${HERMES_ENV_KEY}}`)
    assert.equal(cfg['mcp_servers.gbrain.enabled'], 'true')
    assert.equal(cfg['mcp_servers.gbrain.connect_timeout'], '60')
    const envText = readFileSync(join(w.dir, 'hermes', p, '.env'), 'utf8')
    assert.equal(envText, `${HERMES_ENV_KEY}=${herm}\n`)
  }
  assert.ok(w.hermes.calls.some((a) => a.join(' ') === '-p venom mcp test gbrain'))
  assert.ok(w.said.some((l) => /Hermes reaches GBrain/.test(l)))
  assert.deepEqual(r.notes, [])
})

test('stage: a second run skips what is done (server down, then up)', async () => {
  const w = await world()
  assert.equal((await w.stage()).status, 'on')
  const tokens = assertNoToken(w, {})
  const scriptBefore = readFileSync(w.paths.startCmd, 'utf8')
  writeFileSync(w.paths.startCmd, scriptBefore + 'rem edited by hand\r\n')
  // Second run, server down: everything kept, only the server started.
  w.up = false
  w.said.length = 0
  const r2 = await w.stage()
  assert.equal(r2.status, 'on')
  assert.equal(w.fakeCalls().length, 3, 'no init and no auth create again')
  for (const re of [/memory store is already there/, /access tokens are already there/, /start script is already there/, /profile venom already has GBrain/, /profile coder already has GBrain/]) {
    assert.ok(w.said.some((l) => re.test(l)), `missing: ${re}`)
  }
  assert.ok(readFileSync(w.paths.startCmd, 'utf8').endsWith('rem edited by hand\r\n'))
  // Third run, server up: one line, no question.
  w.said.length = 0
  w.asked.length = 0
  const r3 = await w.stage()
  assert.equal(r3.status, 'on')
  assert.deepEqual(w.asked, [])
  assert.match(w.said[0], /already set up and running/)
  assert.equal(w.fakeCalls().length, 3)
  assert.deepEqual(assertNoToken(w, [r2, r3]), tokens)
})

test('stage: declined at the first question (Enter is yes, n is no)', async () => {
  const w = await world()
  w.answers.push('n')
  const r = await w.stage()
  assert.equal(r.status, 'declined')
  assert.ok(w.said.some((l) => /stays off/.test(l) && /npm run setup/.test(l)))
  assert.ok(w.said.some((l) => l.includes(GBRAIN_URL) && /MIT/.test(l) && /Garry Tan/.test(l)))
  assert.ok(w.said.some((l) => /Bun/.test(l)) && w.said.some((l) => /works fine without it/.test(l)))
  assert.equal(w.fakeCalls().length, 0)
  assert.ok(!existsSync(w.paths.dir))
})

test('stage: declined at the Bun question, then at the GBrain question', async () => {
  const w = await world({ present: [] })
  w.answers.push('', '')
  const r = await w.stage()
  assert.equal(r.status, 'declined')
  assert.deepEqual(w.asked, [Q_GBRAIN.install, Q_GBRAIN.bun])
  assert.ok(w.said.some((l) => l.includes(bunInstallCommand(PLATFORM).shown)))
  assert.equal(w.inherit.length, 0)

  const w2 = await world({ present: ['bun'] })
  w2.answers.push('y', 'no')
  const r2 = await w2.stage()
  assert.equal(r2.status, 'declined')
  assert.deepEqual(w2.asked, [Q_GBRAIN.install, Q_GBRAIN.gbrain])
  assert.ok(w2.said.some((l) => l.includes(`bun add -g ${GBRAIN_SOURCE}`)))
  assert.equal(w2.inherit.length, 0)
})

test('stage: Bun missing, then installed, then GBrain installed', async () => {
  const w = await world({ present: [] })
  w.answers.push('', 'y', 'y')
  const r = await w.stage()
  assert.equal(r.status, 'on', w.said.join('\n'))
  const b = bunInstallCommand(PLATFORM)
  assert.deepEqual(w.inherit[0], { cmd: b.command, args: b.args })
  assert.deepEqual(w.inherit[1], { cmd: join(w.home, '.bun', 'bin', EXE('bun')), args: ['add', '-g', GBRAIN_SOURCE] })
  assert.ok(w.said.some((l) => /\[ok\] Bun installed/.test(l)))
  assert.ok(readFileSync(w.paths.startCmd, 'utf8').includes(join(w.home, '.bun', 'bin', EXE('gbrain'))))
  assertNoToken(w, r)
})

test('stage: Bun installer runs but Bun is still not found', async () => {
  const w = await world({ present: [] })
  w.answers.push('', 'y')
  const d = w.deps()
  d.runInherit = async () => ({ code: 0 })
  const r = await gbrainStage(d)
  assert.equal(r.status, 'failed')
  assert.match(r.why, /new terminal/)
  assert.ok(w.said.some((l) => /new terminal/.test(l)))
})

test('stage: init fails, the last stderr lines are shown, nothing else runs', async () => {
  const w = await world({ env: { FAKE_GBRAIN_INIT: 'fail' } })
  const d = w.deps()
  d.redact = (t) => String(t).replace('read-only', '[redacted]')
  const r = await gbrainStage(d)
  assert.equal(r.status, 'failed')
  assert.match(r.why, /memory store/)
  const i = w.said.findIndex((l) => /could not create the memory store \(exit code 1\)/.test(l))
  assert.ok(i >= 0)
  assert.deepEqual(w.said.slice(i + 1), ['  Error: could not open the database', '  at open (pglite)', '  cause: disk is [redacted]'])
  assert.deepEqual(w.fakeCalls(), [['init', '--pglite', '--non-interactive', '--no-embedding']])
  assert.ok(!existsSync(w.paths.appToken))
})

test('stage: a garbled auth answer fails without saving anything', async () => {
  const w = await world({ env: { FAKE_GBRAIN_AUTH: 'garbled' } })
  const r = await w.stage()
  assert.equal(r.status, 'failed')
  assert.match(r.why, /not understood/)
  assert.ok(w.said.some((l) => /not understood/.test(l)))
  assert.ok(!existsSync(w.paths.appToken))
  assert.ok(!existsSync(w.paths.tokensDir))
  assertNoToken(w, r)
})

test('stage: the server never answers', async () => {
  const w = await world({ startWorks: false })
  const r = await w.stage()
  assert.equal(r.status, 'failed')
  assert.ok(r.why.includes(w.paths.log))
  assert.equal(w.sleeps, 30)
  assert.ok(w.said.some((l) => l.includes(w.paths.log) && /30 seconds/.test(l)))
  assert.equal(w.hermes.calls.length, 0)
  assertNoToken(w, r)
})

test('stage: Hermes mcp test fails: still on, with a note', async () => {
  const w = await world({ hermes: { mcpTest: 1 } })
  const r = await w.stage()
  assert.equal(r.status, 'on')
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0], /Hermes could not reach GBrain/)
  assert.match(r.notes[0], /mcp test gbrain/)
  assertNoToken(w, r)
})

test('stage: Hermes config set fails, or no Hermes: still on, with notes', async () => {
  const w = await world({ hermes: { setFails: true } })
  const r = await w.stage()
  assert.equal(r.status, 'on')
  assert.ok(r.notes.some((n) => /config set failed/.test(n)))
  assert.ok(r.notes.some((n) => /not in Hermes profile venom/.test(n)))
  assertNoToken(w, r)

  const w2 = await world()
  const d = w2.deps()
  d.hermes = ''
  const r2 = await gbrainStage(d)
  assert.equal(r2.status, 'on')
  assert.match(r2.notes[0], /Hermes was not found/)
})

test('stage: refuses the real port during a test run, touching nothing', async () => {
  const boom = () => {
    throw new Error('must not be called')
  }
  const deps = {
    ask: boom, say: boom, run: boom, runInherit: boom, startDetached: boom, fetchStatus: boom, sleep: boom,
    exists: boom, readFile: boom, writeFile: boom, mkdir: boom,
    platform: PLATFORM, env: { NODE_TEST_CONTEXT: 'child-v8' }, home: tmpdir(), hermes: HERMES, profiles: ['venom'], port: GBRAIN_PORT,
  }
  assert.deepEqual(await gbrainStage(deps), { status: 'failed', why: 'test run on the real port', notes: [] })
  const { port: _p, ...noPort } = deps
  assert.equal((await gbrainStage(noPort)).why, 'test run on the real port')
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under node --test')
})

// ------------------------------------------------------------------ the real fake, through child_process

test('fake-gbrain: version, init, auth create/list, serve, and its switches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venom-fake-gbrain-'))
  const log = join(dir, 'calls.log')
  const env = cleanEnv({ GBRAIN_HOME: dir, FAKE_GBRAIN_LOG: log })
  assert.equal(runFake(['--version'], env).stdout.trim(), ['gbrain 0', '60', '717', '0'].join('.'))
  assert.equal(runFake(['init'], cleanEnv()).status, 70, 'refuses to run without GBRAIN_HOME')
  assert.equal(runFake(['init', '--pglite', '--non-interactive', '--no-embedding'], env).status, 0)
  assert.ok(existsSync(join(dir, '.gbrain', 'config.json')))
  const created = runFake(['auth', 'create', 'venom-os'], env)
  assert.equal(created.status, 0)
  const token = parseToken(created.stdout)
  assert.equal(token.length, 71)
  assert.match(created.stdout, /^Token created for "venom-os" \(takes_holders=\["world"\]/)
  assert.match(created.stdout, /Save this token — it will not be shown again\./)
  assert.notEqual(parseToken(runFake(['auth', 'create', 'x'], env).stdout), token)
  assert.match(runFake(['auth', 'list'], env).stdout, /^Name\s[\s\S]*venom-os/)
  assert.equal(parseToken(runFake(['auth', 'create', 'y'], { ...env, FAKE_GBRAIN_AUTH: 'garbled' }).stdout), '')
  const bad = runFake(['init'], { ...env, GBRAIN_HOME: join(dir, 'other'), FAKE_GBRAIN_INIT: 'fail' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /could not open the database/)
  assert.equal(runFake(['serve', '--http', '--port', '3131'], env).status, 64)
  assert.equal(runFake(['serve', '--http', '--port', '4999'], { ...env, FAKE_GBRAIN_SERVE: 'fail' }).status, 1)
  const logged = readFileSync(log, 'utf8')
  assert.ok(!logged.includes(token))
  assert.match(logged, /\["auth","create","venom-os"\]/)
})

test('stage end to end with the real fake-gbrain and a real fake server', async () => {
  const w = await world()
  const children = []
  const d = w.deps()
  d.startDetached = (cmd, args, { env }) => {
    w.started.push({ cmd, args })
    // What the start script does, with the fake as the program.
    const port = /--port (\d+)/.exec(readFileSync(w.paths.startCmd, 'utf8'))[1]
    const child = spawn(process.execPath, [FAKE, 'serve', '--http', '--port', port, '--surface', 'full'], { env, stdio: 'ignore' })
    children.push(child)
  }
  d.fetchStatus = async (url, ms) => {
    assert.ok(!url.includes(':3131/'))
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(ms) })).status
    } catch {
      return 0
    }
  }
  d.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 200)))
  try {
    const r = await gbrainStage(d)
    assert.equal(r.status, 'on', w.said.join('\n'))
    assert.equal((await d.fetchStatus(`http://127.0.0.1:${w.port}/health`, 2000)), 200)
    assertNoToken(w, r)
    // A second run finds it running.
    w.said.length = 0
    const r2 = await gbrainStage(d)
    assert.equal(r2.status, 'on')
    assert.match(w.said[0], /already set up and running/)
    assert.equal(children.length, 1)
  } finally {
    for (const c of children) c.kill()
  }
})
