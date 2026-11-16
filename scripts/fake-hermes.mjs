// A stand-in for the `hermes` CLI, for test/setup-brain.test.mjs. It runs the
// hermes-setup scripts end to end without touching a real Hermes home.
//
// State lives in FAKE_HERMES_STATE (a folder): state.json holds the profiles
// and their settings, calls.jsonl gets one line per invocation (its argv),
// and profiles/<name>/ is each profile's folder (config path points there, so
// the scripts can write SOUL.md into it).
//
// Understood, as the real CLI spells them:
//   profile show <name>            exit 0 when it exists, 1 otherwise
//   profile list
//   profile create <name> [--clone-from <src>] [--description <text>] [--no-alias]
//   profile delete <name> -y|--yes  removes it and its folder (without the flag
//                                   the real one asks to type the name: cancelled)
//   -p <name> config path | config get <key> | config set <key> <value>
//   -p <name> mcp list | mcp add <server> --command <cmd> --args <a...> | mcp remove <server>
//   -p <name> model                 sets FAKE_HERMES_PICK ("provider/model")
//   -p <name> chat -q <text> ... [-m <model>] [--provider <p>]
//                                   answers READY when the profile has a model
//                                   and FAKE_HERMES_FAIL does not name it
//   --version                       prints a version line and "Install directory:
//                                   <FAKE_HERMES_INSTALL_DIR or the state folder>"
//   [-p <name>] doctor              FAKE_HERMES_DOCTOR: unset/ok/healthy, issues/fresh
//                                   (notes only), blocking, crash: prints the
//                                   matching test/fixtures/hermes/doctor-*.txt
//                                   (exit 0 healthy, else 1); crash = a traceback
//                                   on stderr (exit 1)
//   -p <name> config env-path       prints profiles/<name>/.env (not created)
//   -p <name> mcp test <server>     the real layout: exit 0 "✓ Connected" when the
//                                   server is registered and FAKE_HERMES_MCP_TEST
//                                   is not "fail" (then exit 1), exit 3 when it
//                                   is not in the config
//   gbrain over HTTP                once `config set mcp_servers.gbrain.url <url>`
//                                   is done, `mcp list` shows a gbrain row and
//                                   `mcp test gbrain` answers "Transport: HTTP → <url>"
//   config path (no -p)             <FAKE_HERMES_STATE>/config.yaml, even when no
//                                   profile named default exists
//
// chat extras:
//   FAKE_HERMES_NEED_KEY=<NAME>     when profiles/<name>/.env exists, chat fails
//                                   unless it has an active NAME=<value> line
//                                   (no quotes or spaces). The value is never printed.
//   A question containing "ask_agent" is the setup link test. FAKE_HERMES_LINK:
//     unset/ok   needs `team` in the profile's mcp, appends a start and an end
//                (ok true) line for the named agent to
//                <VENOM_AGENTS_DIR>/activity.jsonl and prints the LINK-OK- token.
//                Without VENOM_AGENTS_DIR it writes nothing and answers NOLINK
//                (it must never touch a real home folder).
//     self       prints the token, records no run
//     agentfail  records start + end with ok false, answers NOLINK
//     nolink     answers "NOLINK tool not available"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const DIR = process.env.FAKE_HERMES_STATE
if (!DIR) {
  process.stderr.write('fake-hermes: FAKE_HERMES_STATE is not set\n')
  process.exit(70)
}
mkdirSync(DIR, { recursive: true })
const STATE = join(DIR, 'state.json')
const argv = process.argv.slice(2)
appendFileSync(join(DIR, 'calls.jsonl'), JSON.stringify(argv) + '\n')

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { profiles: {} })
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2))
const state = load()
const out = (s) => process.stdout.write(s + '\n')
const fail = (msg, code = 1) => {
  process.stderr.write(msg + '\n')
  process.exit(code)
}
const profileDir = (name) => join(DIR, 'profiles', name)
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

let profile = 'default'
const args = [...argv]
if (args[0] === '-p') {
  profile = args[1]
  args.splice(0, 2)
}
const need = (name) => state.profiles[name] ?? fail(`Profile '${name}' does not exist.`)

const [cmd, sub, ...rest] = args
if (cmd === '--version') {
  out('Hermes v0.0.0 (fake)')
  out(`Install directory: ${process.env.FAKE_HERMES_INSTALL_DIR || DIR}`)
} else if (cmd === 'doctor') {
  // Prints the reconstructed real output from test/fixtures/hermes/ (see its
  // README): ok/healthy = doctor-healthy (exit 0); issues/fresh =
  // doctor-fresh-install, notes only (exit 1); blocking = doctor-blocking
  // (exit 1); crash = a traceback on stderr and no summary (exit 1).
  const mode = process.env.FAKE_HERMES_DOCTOR || 'ok'
  if (mode === 'crash') fail('Traceback: something broke')
  const file = { ok: 'doctor-healthy', healthy: 'doctor-healthy', issues: 'doctor-fresh-install', fresh: 'doctor-fresh-install', blocking: 'doctor-blocking' }[mode]
  if (!file) fail(`fake-hermes: unknown FAKE_HERMES_DOCTOR ${mode}`, 64)
  process.stdout.write(readFileSync(new URL(`../test/fixtures/hermes/${file}.txt`, import.meta.url), 'utf8'))
  if (file !== 'doctor-healthy') process.exit(1)
} else if (cmd === 'profile') {
  if (sub === 'show') {
    if (!state.profiles[rest[0]]) fail(`Profile '${rest[0]}' does not exist.`)
    out(`Profile: ${rest[0]}`)
  } else if (sub === 'list') {
    for (const name of Object.keys(state.profiles)) out(`  ${name}  ${state.profiles[name].config['model.default'] ?? '-'}`)
  } else if (sub === 'create') {
    const name = rest[0]
    if (!NAME.test(name ?? '')) fail(`Invalid profile name: ${name}`, 2)
    if (state.profiles[name]) fail(`Profile '${name}' already exists.`)
    const opt = (flag) => {
      const i = rest.indexOf(flag)
      return i === -1 ? undefined : rest[i + 1]
    }
    const from = opt('--clone-from')
    if (from && !state.profiles[from]) fail(`Source profile '${from}' does not exist.`)
    const src = from ? state.profiles[from] : undefined
    state.profiles[name] = {
      description: opt('--description') ?? '',
      clonedFrom: from ?? null,
      noAlias: rest.includes('--no-alias'),
      config: src ? { ...src.config } : {},
      mcp: src ? { ...src.mcp } : {},
    }
    mkdirSync(profileDir(name), { recursive: true })
    if (from && existsSync(join(profileDir(from), 'SOUL.md'))) {
      writeFileSync(join(profileDir(name), 'SOUL.md'), readFileSync(join(profileDir(from), 'SOUL.md')))
    }
    save(state)
    out(`Profile '${name}' created.`)
  } else if (sub === 'delete') {
    // The real `profile delete <name> [-y|--yes]` asks "Type '<name>' to
    // confirm" without the flag; here that answer never comes, so it cancels.
    const name = rest.find((a) => !a.startsWith('-'))
    if (!state.profiles[name]) fail(`Error: Profile '${name}' does not exist.`)
    if (!rest.includes('-y') && !rest.includes('--yes')) fail('Cancelled.')
    delete state.profiles[name]
    rmSync(profileDir(name), { recursive: true, force: true })
    save(state)
    out(`Profile '${name}' deleted.`)
  } else fail(`fake-hermes: unknown profile command ${sub}`, 64)
} else if (cmd === 'config' && sub === 'path' && !argv.includes('-p')) {
  // Plain `config path`: the default home's config file, even with no profile named default.
  out(join(DIR, 'config.yaml'))
} else if (cmd === 'config') {
  const p = need(profile)
  if (sub === 'path') out(join(profileDir(profile), 'config.yaml'))
  else if (sub === 'env-path') out(join(profileDir(profile), '.env'))
  else if (sub === 'get') {
    if (!(rest[0] in p.config)) fail(`Config key not set: ${rest[0]}`)
    out(p.config[rest[0]])
  } else if (sub === 'set') {
    if (rest.length < 2) fail('usage: config set <key> <value>', 2)
    p.config[rest[0]] = rest[1]
    save(state)
    out(`Set ${rest[0]} = ${rest[1]}`)
  } else fail(`fake-hermes: unknown config command ${sub}`, 64)
} else if (cmd === 'mcp') {
  const p = need(profile)
  // An HTTP server written with `config set mcp_servers.<name>.url` (how the
  // GBrain stage connects a profile); only gbrain is recognised.
  const httpUrl = (name) => (name === 'gbrain' ? p.config['mcp_servers.gbrain.url'] : undefined)
  if (sub === 'list') {
    // The real table (hermes_cli/mcp_config.py cmd_mcp_list), uncoloured as
    // through a pipe; FAKE_HERMES_MCP_DISABLED=<name> shows that row as off.
    const servers = Object.entries(p.mcp)
    const gbrainUrl = httpUrl('gbrain')
    if (!servers.length && !gbrainUrl) {
      for (const l of ['', '  No MCP servers configured.', '', '  Add one with:', '    hermes mcp add <name> --url <endpoint>', '    hermes mcp add <name> --command <cmd> --args <args...>', '']) out(l)
    } else {
      out('')
      out('  MCP Servers:')
      out('')
      out(`  ${'Name'.padEnd(16)} ${'Transport'.padEnd(30)} ${'Tools'.padEnd(12)} ${'Status'.padEnd(10)}`)
      out(`  ${'─'.repeat(16)} ${'─'.repeat(30)} ${'─'.repeat(12)} ${'─'.repeat(10)}`)
      for (const [name, s] of servers) {
        let transport = [s.command, ...s.args.slice(0, 2)].join(' ')
        if (transport.length > 28) transport = transport.slice(0, 25) + '...'
        const status = process.env.FAKE_HERMES_MCP_DISABLED === name ? '✗ disabled' : '✓ enabled'
        out(`  ${name.padEnd(16)} ${transport.padEnd(30)} ${'all'.padEnd(12)} ${status}`)
      }
      if (gbrainUrl) out(`  ${'gbrain'.padEnd(16)} ${gbrainUrl.padEnd(30)} ${'all'.padEnd(12)} ✓ enabled`)
      out('')
    }
  } else if (sub === 'add') {
    const i = rest.indexOf('--command')
    const j = rest.indexOf('--args')
    p.mcp[rest[0]] = { command: rest[i + 1], args: rest.slice(j + 1) }
    save(state)
    out(`Added ${rest[0]}`)
  } else if (sub === 'remove' || sub === 'rm') {
    delete p.mcp[rest[0]]
    save(state)
    out(`Removed ${rest[0]}`)
  } else if (sub === 'test') {
    // Real wording and exit codes (cmd_mcp_test): 0 connected, 1 failed,
    // 3 not in the config. Everything goes to stdout, as Hermes prints it.
    const name = rest[0]
    const s = p.mcp[name]
    const url = httpUrl(name)
    if (!s && url) {
      out('')
      out(`  Testing '${name}'...`)
      out(`  Transport: HTTP → ${url}`)
      out('  Auth: header')
      if (process.env.FAKE_HERMES_MCP_TEST === 'fail') {
        out(`  ✗ Connection failed (0.3s): could not reach ${url}`)
        process.exit(1)
      }
      out('  ✓ Connected (14ms)')
      out('  ✓ Tools discovered: 3')
      out('')
      process.exit(0)
    }
    if (!s) {
      out(`  ✗ Server '${name}' not found in config.`)
      if (Object.keys(p.mcp).length) out(`  Available: ${Object.keys(p.mcp).join(', ')}`)
      process.exit(3)
    }
    out('')
    out(`  Testing '${name}'...`)
    out(`  Transport: stdio → ${s.command}`)
    out('  Auth: none')
    if (process.env.FAKE_HERMES_MCP_TEST === 'fail') {
      out(`  ✗ Connection failed (0.3s): missing executable '${s.command}'`)
      out(`  Install that command, or set mcp_servers.${name}.command in ~/.hermes/config.yaml to its full path.`)
      process.exit(1)
    }
    out('  ✓ Connected (12ms)')
    out('  ✓ Tools discovered: 1')
    out('')
    out(`    ${'ask_agent'.padEnd(36)} Hand a self-contained task to one of your Hermes specia...`)
    out('')
  } else fail(`fake-hermes: unknown mcp command ${sub}`, 64)
} else if (cmd === 'model') {
  const p = need(profile)
  // "provider/model" or "provider/model base_url"; empty = nothing chosen.
  const [pick = '', baseUrl] = (process.env.FAKE_HERMES_PICK ?? '').split(' ')
  const slash = pick.indexOf('/')
  if (slash > 0) {
    p.config['model.provider'] = pick.slice(0, slash)
    p.config['model.default'] = pick.slice(slash + 1)
    if (baseUrl) p.config['model.base_url'] = baseUrl
    save(state)
  }
} else if (cmd === 'chat') {
  const p = need(profile)
  const failing = (process.env.FAKE_HERMES_FAIL ?? '').split(',').filter(Boolean)
  if (!p.config['model.default'] || failing.includes(profile)) {
    fail(`Error: no credentials for provider ${p.config['model.provider'] ?? '(none)'} on profile ${profile}`)
  }
  const needKey = process.env.FAKE_HERMES_NEED_KEY
  const envFile = join(profileDir(profile), '.env')
  if (needKey && existsSync(envFile)) {
    const has = readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .some((l) => {
        const t = l.trim()
        if (t.startsWith('#') || !t.startsWith(`${needKey}=`)) return false
        const v = t.slice(needKey.length + 1)
        return v.length > 0 && !/["'\s]/.test(v)
      })
    if (!has) fail(`Error: no credentials (set ${needKey} in the profile .env)`)
  }
  const qi = args.indexOf('-q')
  const question = qi === -1 ? '' : String(args[qi + 1] ?? '')
  if (question.includes('ask_agent')) {
    const mode = process.env.FAKE_HERMES_LINK || 'ok'
    const token = /LINK-OK-[A-Za-z0-9_-]+/.exec(question)?.[0] ?? ''
    const agent = /give the agent ["'`]?([a-z0-9][a-z0-9_-]{0,63})/i.exec(question)?.[1] ?? ''
    const agentsDir = process.env.VENOM_AGENTS_DIR?.trim()
    if (mode === 'nolink') out('NOLINK tool not available')
    else if (mode === 'self') out(token)
    else if (!p.mcp.team) out('NOLINK the team connector is not registered')
    else if (!agentsDir) out('NOLINK VENOM_AGENTS_DIR is not set')
    else {
      const ok = mode !== 'agentfail'
      const id = `fake-${Date.now().toString(36)}-${process.pid}`
      const ts = Date.now()
      mkdirSync(agentsDir, { recursive: true })
      const file = join(agentsDir, 'activity.jsonl')
      appendFileSync(file, JSON.stringify({ t: 'start', id, agent, task: `Reply with exactly this and nothing else: ${token}`, ts, pid: process.pid }) + '\n')
      appendFileSync(file, JSON.stringify({ t: 'end', id, ok, ms: 5, summary: ok ? token : 'Error: no credentials', ts: ts + 5 }) + '\n')
      out(ok ? token : 'NOLINK the agent returned an error')
    }
  } else out('READY')
  out('session_id: fake-session')
} else {
  fail(`fake-hermes: unknown command ${argv.join(' ')}`, 64)
}
