// GBrain helpers for the setup wizard (scripts/setup-lib.mjs): the optional
// long-term memory stage. GBrain is a memory server that runs only on this PC
// (MIT, by Garry Tan). This stage offers to install Bun and GBrain, creates
// the local store, saves two access tokens (one for Venom OS, one for the
// Hermes agents), writes the start script, starts the server and connects the
// Hermes profiles to it as the MCP server `gbrain`.
//
// Every side effect is injected through `deps` (ask, say, run, runInherit,
// startDetached, fetchStatus, sleep, exists, readFile, writeFile, mkdir), as in
// setup-hermes.mjs, so test/setup-gbrain.test.mjs drives it with stubs and
// scripts/fake-gbrain.mjs. This module prints nothing itself.
//
// Tokens: a token goes from GBrain's answer straight into its file. It never
// goes to say(), a note, an error or a returned value, and never onto a
// command line. Hermes gets its token through the profile's own .env file
// (the MCP_GBRAIN_API_KEY line), and config.yaml holds only the placeholder
// `Bearer ${MCP_GBRAIN_API_KEY}`, which is exactly what `hermes mcp add
// --auth header` itself writes (hermes_cli/mcp_config.py). `mcp add` cannot
// be used here: it asks questions on the terminal and reads the token from a
// password prompt.
import { dirname, join } from 'node:path'

export const GBRAIN_SOURCE = 'github:garrytan/gbrain#stable'
export const GBRAIN_PORT = 3131
export const GBRAIN_URL = 'https://github.com/garrytan/gbrain'
export const BUN_DOCS = 'https://bun.sh/docs/installation'

/** The Hermes .env variable that holds the token for the `gbrain` MCP server (Hermes's own naming). */
export const HERMES_ENV_KEY = 'MCP_GBRAIN_API_KEY'

export const Q_GBRAIN = {
  install: 'Install long-term memory (GBrain)? (Y/n)',
  bun: 'Install Bun now? (y/N)',
  gbrain: 'Install GBrain now? (y/N)',
}

const TOKEN_RE = /^\s*(gbrain_[A-Za-z0-9_-]+)\s*$/m
const ANY_TOKEN_RE = /gbrain_[A-Za-z0-9_-]{8,}/g
const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const yes = (a) => /^y(es)?$/i.test(String(a ?? '').trim())
const yesByDefault = (a) => !String(a ?? '').trim() || yes(a)
const exe = (platform, name) => (platform === 'win32' ? `${name}.exe` : name)
const lines = (text) =>
  String(text ?? '')
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())

/** Mask anything token-shaped (a second guard; tokens are never passed here on purpose). */
const mask = (text) => String(text ?? '').replace(ANY_TOKEN_RE, 'gbrain_***')

// ------------------------------------------------------------------ pure helpers

/**
 * Bun's official install command for this platform (https://bun.sh/docs/installation).
 * `shown` is the line a person could type; `command`/`args` how setup runs it.
 * @returns {{ command: string, args: string[], shown: string }}
 */
export function bunInstallCommand(platform) {
  if (platform === 'win32') {
    const script = 'irm bun.sh/install.ps1 | iex'
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      shown: `powershell -c "${script}"`,
    }
  }
  const script = 'curl -fsSL https://bun.sh/install | bash'
  return { command: 'bash', args: ['-c', script], shown: script }
}

function findProgram(name, envName, { platform, env = {}, exists, which, home }) {
  const given = String(env[envName] ?? '').trim()
  if (given) return exists(given) ? given : ''
  const onPath = which(name)
  if (onPath) return onPath
  if (home) {
    const p = join(home, '.bun', 'bin', exe(platform, name))
    if (exists(p)) return p
  }
  return ''
}

/** The Bun program: BUN_EXE, else `bun` on PATH, else <home>/.bun/bin/bun(.exe). '' when missing. */
export function findBun(o) {
  return findProgram('bun', 'BUN_EXE', o)
}

/** The GBrain program: GBRAIN_EXE, else `gbrain` on PATH, else <home>/.bun/bin/gbrain(.exe). '' when missing. */
export function findGbrain(o) {
  return findProgram('gbrain', 'GBRAIN_EXE', o)
}

/**
 * Where GBrain keeps its things. GBRAIN_HOME (the PARENT of .gbrain) wins over
 * the home folder. `platform` (optional, defaults to this machine's) only picks
 * the start script's name: .cmd on Windows, .sh elsewhere.
 */
export function gbrainPaths({ home, env = {}, platform = process.platform }) {
  const gbrainHome = String(env.GBRAIN_HOME ?? '').trim() || home
  const dir = join(gbrainHome, '.gbrain')
  const tokensDir = join(dir, 'tokens')
  return {
    gbrainHome,
    dir,
    config: join(dir, 'config.json'),
    tokensDir,
    appToken: join(tokensDir, 'venom-os.token'),
    hermesToken: join(tokensDir, 'hermes.token'),
    startCmd: join(dir, platform === 'win32' ? 'start-gbrain-server.cmd' : 'start-gbrain-server.sh'),
    log: join(dir, 'serve-http.log'),
  }
}

/** The token in the output of `gbrain auth create <name>`, or ''. */
export function parseToken(stdout) {
  return TOKEN_RE.exec(String(stdout ?? ''))?.[1] ?? ''
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** The text of the script that starts the server (CRLF .cmd on Windows, a sh script elsewhere). */
export function startScript({ gbrainExe, gbrainHome, port = GBRAIN_PORT, log, platform }) {
  const serve = `serve --http --port ${port} --surface full --advertise verbs --suppress-bootstrap-token`
  if (platform === 'win32') {
    return ['@echo off', `set "GBRAIN_HOME=${gbrainHome}"`, `"${gbrainExe}" ${serve} >> "${log}" 2>&1`, ''].join('\r\n')
  }
  return ['#!/bin/sh', `export GBRAIN_HOME=${shQuote(gbrainHome)}`, `exec ${shQuote(gbrainExe)} ${serve} >> ${shQuote(log)} 2>&1`, ''].join('\n')
}

/** Lines for the wizard's prerequisite list. GBrain is optional: this never fails the wizard. */
export function gbrainPrereq({ platform, env = {}, exists, which, home }) {
  const o = { platform, env, exists, which, home }
  const bun = findBun(o)
  const gbrain = findGbrain(o)
  const out = []
  if (gbrain) out.push(`[ok] GBrain (long-term memory, optional): ${gbrain}`)
  else if (bun) out.push('[optional] GBrain (long-term memory) is not installed. Setup offers it later; Bun is already here.')
  else out.push('[optional] GBrain (long-term memory) is not installed. Setup offers it later; it needs Bun, which setup can install too.')
  if (String(env.GBRAIN_EXE ?? '').trim() && !gbrain) out.push(`  GBRAIN_EXE is set to ${env.GBRAIN_EXE}, but nothing is there. Fix or remove it.`)
  if (String(env.BUN_EXE ?? '').trim() && !bun) out.push(`  BUN_EXE is set to ${env.BUN_EXE}, but nothing is there. Fix or remove it.`)
  return { bun, gbrain, lines: out }
}

/** The text of a .env file with KEY=value set (replacing an existing line), line endings kept. */
export function setEnvLine(text, key, value) {
  const body = String(text ?? '')
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const rows = body ? body.split(/\r?\n/) : []
  if (rows.length && rows[rows.length - 1] === '') rows.pop()
  const line = `${key}=${value}`
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`)
  const i = rows.findIndex((r) => re.test(r))
  if (i === -1) rows.push(line)
  else rows[i] = line
  return rows.join(eol) + eol
}

/** Whether `hermes mcp list` output has a `gbrain` row. */
export function hasGbrainRow(output) {
  return lines(output).some((l) => /^\s*gbrain\s/.test(l))
}

// ------------------------------------------------------------------ the stage

/**
 * The long-term memory stage. Re-running it is safe: every step that is
 * already done is skipped with one line. Never throws.
 * @returns {Promise<{ status: 'on' | 'declined' | 'failed' | 'skipped', why: string, notes: string[] }>}
 */
export async function gbrainStage(deps) {
  const notes = []
  const env = deps?.env ?? {}
  const port = deps?.port ?? GBRAIN_PORT
  const done = (status, why = '') => ({ status, why: mask(why), notes: notes.map(mask) })
  // A test must never touch the real server or the real store.
  if (port === GBRAIN_PORT && env.NODE_TEST_CONTEXT) return done('failed', 'test run on the real port')
  try {
    return await stage(deps, env, port, notes, done)
  } catch (err) {
    deps.say(mask(`Long-term memory setup stopped: ${err?.message ?? err}`))
    return done('failed', 'unexpected error')
  }
}

async function stage(deps, env, port, notes, done) {
  const { ask, run, exists, platform, home } = deps
  const say = (...l) => l.forEach((x) => deps.say(mask(x)))
  const red = (t) => mask(typeof deps.redact === 'function' ? deps.redact(t) : t)
  const P = gbrainPaths({ home, env, platform })
  const find = { platform, env, exists, which: deps.which ?? (() => ''), home }
  const healthUrl = `http://127.0.0.1:${port}/health`
  const healthy = async () => {
    try {
      return (await deps.fetchStatus(healthUrl, 2000)) === 200
    } catch {
      return false
    }
  }
  const gbEnv = { ...env, GBRAIN_HOME: P.gbrainHome }
  const note = (n) => {
    notes.push(n)
    say(n)
  }

  // 1. Already set up and running.
  if (exists(P.appToken) && exists(P.config) && (await healthy())) {
    say('[ok] Long-term memory (GBrain) is already set up and running.')
    const gbrain = findGbrain(find)
    if (!exists(P.hermesToken) && gbrain) {
      const t = await makeToken({ run, gbrain, gbEnv, deps, name: 'hermes', file: P.hermesToken, tokensDir: P.tokensDir, say })
      if (t) note(t)
    }
    await connectHermes({ deps, P, port, say, note })
    return done('on')
  }

  // 2. Ask once.
  say(
    '',
    'Long-term memory (optional): GBrain is a memory server that runs only on this PC, so Venom OS can remember past conversations.',
    `It is free and open source (MIT licence), made by Garry Tan: ${GBRAIN_URL}`,
    'It needs Bun (a JavaScript runtime). Venom OS works fine without it.',
  )
  if (!yesByDefault(await ask(Q_GBRAIN.install))) {
    say('Long-term memory stays off. To add it later, run npm run setup again.')
    return done('declined', 'memory declined')
  }

  // 3 + 4. Bun and GBrain (Bun is only needed to install GBrain).
  let gbrain = findGbrain(find)
  if (gbrain) say(`[ok] GBrain is installed: ${gbrain}`)
  else {
    let bun = findBun(find)
    if (bun) say(`[ok] Bun is installed: ${bun}`)
    else {
      const b = bunInstallCommand(platform)
      say(
        'Bun is not installed. The official install command:',
        `  ${b.shown}`,
        `It comes from Bun's installation guide (${BUN_DOCS}) and installs Bun into your own user folder.`,
      )
      if (!yes(await ask(Q_GBRAIN.bun))) {
        say('Long-term memory stays off. To add it later, install Bun and run npm run setup again.')
        return done('declined', 'Bun install declined')
      }
      const r = await safeInherit(deps, b.command, b.args, env)
      if (r.code !== 0) {
        say(`The Bun installer stopped (exit code ${r.code}); its own messages are above. Long-term memory stays off.`)
        return done('failed', 'Bun installer failed')
      }
      bun = findBun(find)
      if (!bun) {
        say(
          'Bun was installed, but this window cannot find it yet.',
          'Open a new terminal and run npm run setup again (it is safe to repeat).',
        )
        return done('failed', 'Bun not found after install; a new terminal may be needed')
      }
      say(`[ok] Bun installed: ${bun}`)
    }
    say('GBrain is not installed. It installs with Bun:', `  bun add -g ${GBRAIN_SOURCE}`)
    if (!yes(await ask(Q_GBRAIN.gbrain))) {
      say('Long-term memory stays off. To add it later, run npm run setup again.')
      return done('declined', 'GBrain install declined')
    }
    const r = await safeInherit(deps, bun, ['add', '-g', GBRAIN_SOURCE], env)
    if (r.code !== 0) {
      say(`Installing GBrain stopped (exit code ${r.code}); Bun's messages are above. Long-term memory stays off.`)
      return done('failed', 'GBrain install failed')
    }
    gbrain = findGbrain(find)
    if (!gbrain) {
      say(
        'GBrain was installed, but this window cannot find it yet.',
        'Open a new terminal and run npm run setup again (it is safe to repeat).',
      )
      return done('failed', 'GBrain not found after install; a new terminal may be needed')
    }
    say(`[ok] GBrain installed: ${gbrain}`)
  }

  // 5. The store. An existing one holds the person's memory: never init again.
  if (exists(P.config)) say(`[ok] The memory store is already there (${P.dir}); kept as it is.`)
  else {
    const r = await safeRun(run, gbrain, ['init', '--pglite', '--non-interactive', '--no-embedding'], { env: gbEnv, timeoutMs: 180000 })
    if (r.code !== 0) {
      const tail = lines(r.stderr).slice(-3)
      say(`GBrain could not create the memory store (exit code ${r.code}).`, ...tail.map((l) => `  ${red(l.trim())}`))
      return done('failed', 'memory store not created')
    }
    say(`[ok] Memory store created in ${P.dir}`)
  }

  // 6. Tokens.
  const wanted = [
    ['venom-os', P.appToken],
    ['hermes', P.hermesToken],
  ].filter(([, file]) => !exists(file))
  if (!wanted.length) say('[ok] The access tokens are already there; kept.')
  for (const [name, file] of wanted) {
    const problem = await makeToken({ run, gbrain, gbEnv, deps, name, file, tokensDir: P.tokensDir, say })
    if (problem) {
      say(problem)
      return done('failed', problem)
    }
  }

  // 7. Start script and server.
  if (exists(P.startCmd)) say(`[ok] The start script is already there (${P.startCmd}); kept.`)
  else {
    deps.writeFile(P.startCmd, startScript({ gbrainExe: gbrain, gbrainHome: P.gbrainHome, port, log: P.log, platform }))
    say(`[ok] Start script written: ${P.startCmd}`)
  }
  if (await healthy()) say('[ok] GBrain is already running.')
  else {
    say('Starting GBrain (this takes up to half a minute)...')
    try {
      if (platform === 'win32') deps.startDetached('cmd.exe', ['/d', '/c', P.startCmd], { env: gbEnv })
      else deps.startDetached('sh', [P.startCmd], { env: gbEnv })
    } catch (err) {
      say(`GBrain could not be started: ${mask(err?.message ?? err)}`)
      return done('failed', 'server not started')
    }
    let up = false
    for (let i = 0; i < 30 && !up; i++) {
      await deps.sleep(1000)
      up = await healthy()
    }
    if (!up) {
      say(`GBrain did not answer within 30 seconds. Its log is here: ${P.log}`)
      return done('failed', `server not answering; log: ${P.log}`)
    }
    say('[ok] GBrain is running.')
  }

  // 8. Hermes (a problem here is a note: Venom OS reads GBrain directly).
  await connectHermes({ deps, P, port, say, note })
  return done('on')
}

async function safeRun(run, cmd, args, opts) {
  try {
    const r = await run(cmd, args, opts)
    return { code: r?.code ?? 1, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? '') }
  } catch (err) {
    return { code: 127, stdout: '', stderr: String(err?.message ?? err) }
  }
}

async function safeInherit(deps, cmd, args, env) {
  try {
    const r = await deps.runInherit(cmd, args, { env })
    return { code: r?.code ?? 1 }
  } catch {
    return { code: 127 }
  }
}

/** Create one token and save it. Returns '' or a plain sentence (never containing the token). */
async function makeToken({ run, gbrain, gbEnv, deps, name, file, tokensDir, say }) {
  const r = await safeRun(run, gbrain, ['auth', 'create', name], { env: gbEnv, timeoutMs: 60000 })
  if (r.code !== 0) return `GBrain could not create the access token for ${name} (exit code ${r.code}).`
  const token = parseToken(r.stdout)
  if (!token) return `GBrain's answer to creating the access token for ${name} was not understood, so nothing was saved.`
  deps.mkdir(tokensDir)
  deps.writeFile(file, `${token}\n`)
  say(`[ok] Access token for ${name} saved in ${file}`)
  return ''
}

/** The first non-empty line of a token file, or ''. */
function readTokenFile(deps, file) {
  try {
    if (!deps.exists(file)) return ''
    const body = String(deps.readFile(file)).replace(/^\uFEFF/, '')
    return body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  } catch {
    return ''
  }
}

/**
 * Connect each Hermes profile to GBrain without a prompt:
 *   the token goes into the profile's .env (path from `config env-path`) as
 *   MCP_GBRAIN_API_KEY, and four `config set` calls write the server entry
 *   with the placeholder header. Then `mcp test gbrain` on the supervisor.
 */
async function connectHermes({ deps, P, port, say, note }) {
  const hermes = deps.hermes
  const profiles = Array.isArray(deps.profiles) ? deps.profiles.filter(Boolean) : []
  if (!hermes || !profiles.length) {
    note('Hermes was not found, so the agents were not connected to GBrain. Venom OS itself still uses it.')
    return
  }
  const H = (args) => safeRun(deps.run, hermes, args, { env: deps.env, timeoutMs: 120000 })
  const url = `http://127.0.0.1:${port}/mcp`
  let token = ''
  for (const profile of profiles) {
    const list = await H(['-p', profile, 'mcp', 'list'])
    if (list.code === 0 && hasGbrainRow(list.stdout)) {
      say(`[ok] Hermes profile ${profile} already has GBrain.`)
      continue
    }
    if (!token) token = readTokenFile(deps, P.hermesToken)
    if (!token) {
      note(`The Hermes token file is missing (${P.hermesToken}), so profile ${profile} was not connected to GBrain.`)
      continue
    }
    const where = await H(['-p', profile, 'config', 'env-path'])
    const envPath = lines(where.stdout).pop()?.trim() ?? ''
    if (where.code !== 0 || !envPath) {
      note(`Hermes did not say where profile ${profile} keeps its .env file, so it was not connected to GBrain.`)
      continue
    }
    try {
      const before = deps.exists(envPath) ? String(deps.readFile(envPath)) : ''
      deps.mkdir(dirname(envPath))
      deps.writeFile(envPath, setEnvLine(before, HERMES_ENV_KEY, token))
    } catch {
      note(`The token could not be written into profile ${profile}'s .env file, so it was not connected to GBrain.`)
      continue
    }
    const sets = [
      ['mcp_servers.gbrain.url', url],
      ['mcp_servers.gbrain.connect_timeout', '60'],
      ['mcp_servers.gbrain.headers.Authorization', `Bearer \${${HERMES_ENV_KEY}}`],
      ['mcp_servers.gbrain.enabled', 'true'],
    ]
    let ok = true
    for (const [key, value] of sets) {
      if ((await H(['-p', profile, 'config', 'set', key, value])).code !== 0) {
        ok = false
        break
      }
    }
    if (ok) say(`[ok] Hermes profile ${profile} connected to GBrain.`)
    else note(`Hermes profile ${profile} could not be connected to GBrain (hermes config set failed).`)
  }
  const sup = profiles[0]
  const t = await H(['-p', sup, 'mcp', 'test', 'gbrain'])
  if (t.code === 0) say(`[ok] Hermes reaches GBrain (hermes -p ${sup} mcp test gbrain).`)
  else if (t.code === 3) note(`GBrain is not in Hermes profile ${sup}'s settings. Venom OS itself still uses it.`)
  else note(`Hermes could not reach GBrain yet (check with: hermes -p ${sup} mcp test gbrain). Venom OS itself still uses it.`)
}
