// A stand-in for the `gbrain` CLI, for test/setup-gbrain.test.mjs. It never
// touches a real GBrain store: it works only inside GBRAIN_HOME (the parent of
// .gbrain, as the real program reads it) and refuses to run without it.
//
// Understood, as the real CLI spells them:
//   --version                          prints "gbrain <version>"
//   init --pglite ...                  creates .gbrain/config.json and .gbrain/brain.pglite/
//                                      (keeps an existing config, like the real one)
//   auth create <name>                 the real output layout, with a fake token made
//                                      at run time (never stored, never logged)
//   auth list                          a table with a Name column
//   serve --http --port <n> ...        a tiny HTTP server on 127.0.0.1:<n>; GET /health
//                                      answers 200 until the process is killed.
//                                      Refuses port 3131 (the real server's).
//
// Switches:
//   FAKE_GBRAIN_INIT=fail     init prints an error on stderr and exits 1
//   FAKE_GBRAIN_AUTH=garbled  auth create exits 0 without a token line
//   FAKE_GBRAIN_SERVE=fail    serve exits 1 at once
//   FAKE_GBRAIN_LOG=<file>    each invocation's argv is appended as one JSON line
//   FAKE_GBRAIN_PIDFILE=<file> serve appends its pid there (one per line); without
//                             it, to <GBRAIN_HOME>/.gbrain/fake-serve.pids, so a
//                             test can always find and kill the detached server
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import process from 'node:process'

const argv = process.argv.slice(2)
if (process.env.FAKE_GBRAIN_LOG) appendFileSync(process.env.FAKE_GBRAIN_LOG, JSON.stringify(argv) + '\n')

const out = (s) => process.stdout.write(s + '\n')
const fail = (msg, code = 1) => {
  process.stderr.write(msg + '\n')
  process.exit(code)
}
const opt = (flag) => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const [cmd, sub, ...rest] = argv
if (cmd === '--version') {
  out(['gbrain 0', '60', '717', '0'].join('.'))
  process.exit(0)
}

const home = process.env.GBRAIN_HOME
if (!home) fail('fake-gbrain: GBRAIN_HOME is not set (the fake never uses the real home folder)', 70)
const dir = join(home, '.gbrain')
const namesFile = join(dir, 'fake-token-names.json')

/** A fake token, built from parts at run time: "gbrain" + "_" + 64 letters. */
function fakeToken() {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const bytes = randomBytes(64)
  let body = ''
  for (const b of bytes) body += letters[b % letters.length]
  return ['gbrain', body].join('_')
}

if (cmd === 'init') {
  if (process.env.FAKE_GBRAIN_INIT === 'fail') {
    out('Initialising GBrain (PGLite)...')
    process.stderr.write('Loading PGLite...\nError: could not open the database\n  at open (pglite)\n  cause: disk is read-only\n')
    process.exit(1)
  }
  mkdirSync(join(dir, 'brain.pglite'), { recursive: true })
  const config = join(dir, 'config.json')
  if (existsSync(config)) out(`Config already exists at ${config}; kept.`)
  else writeFileSync(config, JSON.stringify({ engine: 'pglite', embedding: argv.includes('--no-embedding') ? 'none' : 'default' }, null, 2) + '\n')
  out('Initialising GBrain (PGLite)...')
  for (let i = 1; i <= 8; i++) out(`  migration ${i} applied`)
  out('Brain ready.')
} else if (cmd === 'auth' && sub === 'create') {
  const name = rest[0]
  if (!name) fail('usage: gbrain auth create <name>', 2)
  mkdirSync(dir, { recursive: true })
  const names = existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf8')) : []
  names.push(name)
  writeFileSync(namesFile, JSON.stringify(names) + '\n')
  if (process.env.FAKE_GBRAIN_AUTH === 'garbled') {
    out(`Token created for "${name}". See the dashboard for its value.`)
  } else {
    out(`Token created for "${name}" (takes_holders=["world"], scopes=full access (grandfathered — pass --scopes read,write to narrow)):`)
    out('')
    out(`  ${fakeToken()}`)
    out('')
    out('Save this token — it will not be shown again.')
    out(`Revoke with: gbrain auth revoke ${name}`)
    out(`Change its grants: gbrain auth grant ${name} --scopes read,write`)
  }
} else if (cmd === 'auth' && sub === 'list') {
  const names = existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf8')) : []
  out(`${'Name'.padEnd(20)} ${'Scopes'.padEnd(14)} Created`)
  for (const n of names) out(`${n.padEnd(20)} ${'full'.padEnd(14)} today`)
} else if (cmd === 'serve') {
  if (process.env.FAKE_GBRAIN_SERVE === 'fail') fail('Error: could not start the server')
  const port = Number(opt('--port'))
  if (!Number.isInteger(port) || port <= 0) fail('serve: --port is required', 2)
  if (port === 3131) fail('fake-gbrain: refusing the real port 3131', 64)
  const pidFile = process.env.FAKE_GBRAIN_PIDFILE || join(dir, 'fake-serve.pids')
  mkdirSync(dirname(pidFile), { recursive: true })
  appendFileSync(pidFile, `${process.pid}\n`)
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(port, '127.0.0.1', () => out(`GBrain listening on http://127.0.0.1:${port}`))
} else {
  fail(`fake-gbrain: unknown command ${argv.join(' ')}`, 64)
}
