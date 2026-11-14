// The setup wizard's newer paths, run for real: every program it starts is
// spawned (scripts/fake-hermes.mjs for `hermes`, scripts/fake-editor.mjs as the
// editor, the real create-profiles script through pwsh or bash, stand-in
// installers written into the temp folder). Nothing reaches the network, the
// real Hermes home, a real .env or a window.
//
// Set VENOM_SETUP_TRANSCRIPT=<file> to have the whole-run test write what the
// person would see, in order, to that file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINKS, NO_TEAM_LINE, Q, SPECIALISTS, shownPath, wizard } from '../scripts/setup-lib.mjs'
import { Q_INSTALL } from '../scripts/setup-hermes.mjs'
import { ENV_HINT, ENV_Q_DONE } from '../scripts/setup-env.mjs'
import { BRIDGE_AGENTS, STARTER_AGENTS } from '../hermes-mcp/roster.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KIT = join(ROOT, 'hermes-setup').replace(/\\/g, '/')
const FAKE = join(ROOT, 'scripts', 'fake-hermes.mjs')
const EDITOR = join(ROOT, 'scripts', 'fake-editor.mjs')
const NODE = process.execPath
const WIN = process.platform === 'win32'
// Built at run time so no key-shaped literal sits in the repository.
const KEY = 's' + 'k-proj-' + ['WIZARDfake', '0a1b2c3d4e5f6g7h8i9j'].join('')
const fwd = (p) => String(p).replace(/\\/g, '/')

/** The team question answered with Enter four times: all four starters. */
const TEAM = STARTER_AGENTS.map((a) => [Q.agent(a), ''])
/** The team question answered yes only for the given starter ids. */
const teamOf = (...ids) => STARTER_AGENTS.map((a) => [Q.agent(a), ids.includes(a.id) ? '' : 'n'])
const BRIDGE = Object.fromEntries(BRIDGE_AGENTS.map((b) => [b.id, b]))
const rosterFile = (w) => join(w.dir, 'venom.agents.json')
const rosterIds = (w) => JSON.parse(readFileSync(rosterFile(w), 'utf8')).agents.map((a) => a.id)
const scriptRun = (r) => r.runs.find((x) => x.args.some((a) => /create-profiles\.(ps1|sh)$/.test(a)))
const argAfter = (args, ...names) => args[args.findIndex((a) => names.includes(a)) + 1]

function realWhich(name) {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8' })
  if (r.status !== 0) return ''
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? ''
}
const PWSH = realWhich('pwsh')
// On Windows `bash` on PATH may be WSL's, which cannot see this folder: use Git's.
const BASH = WIN
  ? [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean).map((r) => join(r, 'Git', 'bin', 'bash.exe')).find((p) => existsSync(p)) ?? ''
  : realWhich('bash')
const SHELL_OK = WIN ? Boolean(PWSH) : Boolean(BASH)
const FULL = { skip: !SHELL_OK && 'no pwsh/bash' }

/** The text of the two hermes shims, both pointing at fake-hermes.mjs. */
const shimText = () => ({
  cmd: `@"${NODE}" "${FAKE}" %*\r\n`,
  sh: `#!/bin/sh\nexec "${fwd(NODE)}" "${fwd(FAKE)}" "$@"\n`,
})

/** A temp world: repo root, fake Hermes state, agents folder, and (unless `shims: false`) the hermes shims. */
function world({ shims = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'venom-wizard-'))
  const repo = join(dir, 'repo')
  const state = join(dir, 'state')
  const bin = join(dir, 'bin')
  const agents = join(dir, 'agents')
  for (const d of [repo, join(repo, 'hermes-mcp'), state, bin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(repo, 'hermes-mcp', 'server.mjs'), '// stand-in\n')
  writeFileSync(join(repo, 'venom.config.json'), JSON.stringify({ ownerName: 'Test Owner' }, null, 2))
  const cmdShim = join(bin, 'hermes.cmd')
  const shShim = join(bin, 'hermes')
  if (shims) {
    writeFileSync(cmdShim, shimText().cmd)
    writeFileSync(shShim, shimText().sh, { mode: 0o755 })
  }
  return { dir, repo, state, bin, agents, cmdShim, shShim, hermes: WIN ? cmdShim : shShim }
}

/** A stand-in installer: a node script in the temp folder that may drop the hermes shims. */
function installer(w, { createsShims }) {
  const file = join(w.dir, 'install.mjs')
  const t = shimText()
  writeFileSync(
    file,
    createsShims
      ? `import { writeFileSync } from 'node:fs'\n` +
          `writeFileSync(${JSON.stringify(w.cmdShim)}, ${JSON.stringify(t.cmd)})\n` +
          `writeFileSync(${JSON.stringify(w.shShim)}, ${JSON.stringify(t.sh)}, { mode: 0o755 })\n`
      : '// installs nothing\n',
  )
  return `"${NODE}" "${file}"`
}

const profileEnv = (w, profile) => join(w.state, 'profiles', profile, '.env')
const calls = (w) =>
  existsSync(join(w.state, 'calls.jsonl'))
    ? readFileSync(join(w.state, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * Run the wizard with real child processes. `answers` is a list of [expected
 * question (string prefix or RegExp), answer]; the editor's "press Enter"
 * question is answered by itself. `picks` is what each `hermes model` chooses.
 * `which` entries may be functions (looked up at call time).
 */
async function drive(w, { answers, picks = [], env: envExtra = {}, which: whichExtra = {} }) {
  const events = [] // ['log', line] | ['out', line] | ['ask', question, answer]
  const queue = [...answers]
  const pickQueue = [...picks]
  const runs = []
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HERMES_EXE: w.hermes,
    ProgramFiles: join(w.dir, 'pf'),
    LOCALAPPDATA: join(w.dir, 'localappdata'),
    VENOM_AGENTS_DIR: w.agents,
    VENOM_SETUP_EDITOR: `"${NODE}" "${EDITOR}"`,
    FAKE_EDITOR_MODE: 'fill',
    FAKE_EDITOR_KEY: KEY,
    VENOM_ROSTER_FILE: rosterFile(w),
    ...envExtra,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  const chromeWin = `${fwd(env.ProgramFiles)}/Google/Chrome/Application/chrome.exe`
  const whichMap = {
    pwsh: WIN ? PWSH : '',
    bash: WIN ? '' : BASH,
    'google-chrome': '/fake/google-chrome',
    claude: '',
    hermes: '',
    ...whichExtra,
  }
  const run = (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      runs.push({ cmd, args, interactive: Boolean(opts.interactive) })
      const isHermes = cmd === w.cmdShim || cmd === w.shShim
      const pick = isHermes && args[0] === '-p' && args[2] === 'model' ? { FAKE_HERMES_PICK: pickQueue.shift() ?? '' } : {}
      const [file, argv] = isHermes ? [NODE, [FAKE, ...args]] : [cmd, args]
      let child
      try {
        child = spawn(file, argv, {
          env: { ...process.env, ...env, ...opts.env, ...pick, FAKE_HERMES_STATE: w.state },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) })
        return
      }
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }))
      child.on('close', (code) => {
        // What an interactive program shows goes straight to the person's screen.
        if (opts.interactive) for (const l of `${stdout}\n${stderr}`.split(/\r?\n/)) if (l.trim()) events.push(['out', l])
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  const deps = {
    platform: process.platform,
    env,
    nodeVersion: process.versions.node,
    repoRoot: w.repo,
    kitDir: KIT,
    homedir: w.dir,
    log: (l) => events.push(['log', String(l)]),
    ask: async (q) => {
      if (q === ENV_Q_DONE) {
        events.push(['ask', q, ''])
        return ''
      }
      const next = queue.shift()
      assert.ok(next, `unexpected question: ${q}`)
      const [want, answer] = next
      if (want instanceof RegExp) assert.match(q, want)
      else assert.ok(q.startsWith(want), `expected question "${want}", got "${q}"`)
      events.push(['ask', q, answer])
      return answer
    },
    run,
    fetchJson: async (url) => {
      throw new Error(`no network in tests: ${url}`)
    },
    fetchText: async (url) => {
      throw new Error(`no network in tests: ${url}`)
    },
    exists: (p) => p === chromeWin || existsSync(p),
    which: (name) => {
      const v = whichMap[name]
      return (typeof v === 'function' ? v() : v) ?? ''
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, text) => writeFileSync(p, text),
    copyFile: (src, dest) => copyFileSync(src, dest),
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    now: () => new Date(),
    nowMs: () => Date.now(),
    randomHex: () => randomBytes(4).toString('hex'),
  }
  const code = await wizard(deps)
  assert.equal(queue.length, 0, `questions not asked: ${queue.map((q) => q[0]).join(' | ')}`)
  const shown = events.filter((e) => e[0] !== 'ask').map((e) => e[1])
  return { code, events, out: shown.join('\n'), asked: events.filter((e) => e[0] === 'ask').map((e) => e[1]), runs }
}

/** What the person saw, in order, with the temp folder and the repo path made anonymous. */
function transcript(w, events) {
  const text = events.map((e) => (e[0] === 'ask' ? `${e[1]} ${e[2]}`.trimEnd() : e[1])).join('\n')
  let t = text
  for (const [from, to] of [[w.dir, '<TEMP>'], [ROOT.replace(/[\\/]+$/, ''), '<REPO>']]) {
    for (const v of new Set([from, fwd(from)])) t = t.split(v).join(to)
  }
  return t + '\n'
}

const editorRuns = (r) => r.runs.filter((x) => x.cmd === NODE && x.args[0] === EDITOR)

// ------------------------------------------------------------- Hermes missing

test('Hermes missing, install declined: exit 1, the official command shown, nothing run', async () => {
  const w = world({ shims: false })
  const r = await drive(w, { answers: [[Q_INSTALL, 'n']], env: { HERMES_EXE: undefined } })
  assert.equal(r.code, 1)
  assert.ok(r.out.includes(WIN ? LINKS.hermesWin : LINKS.hermesSh), r.out)
  assert.deepEqual(r.runs, [], 'the installer never ran')
})

test('Hermes missing, stand-in installer drops hermes: the wizard carries on with it', async () => {
  const w = world({ shims: false })
  const r = await drive(w, {
    answers: [[Q_INSTALL, 'y'], [Q.brain, '2'], [Q.access, '1'], [Q.supervisor, 'boss'], ...TEAM],
    picks: [''],
    env: { HERMES_EXE: undefined, VENOM_SETUP_INSTALL_CMD: installer(w, { createsShims: true }) },
    which: { hermes: () => (existsSync(w.hermes) ? w.hermes : '') },
  })
  assert.equal(r.code, 1, r.out) // stops at the empty pick: getting there is the point
  assert.equal(r.runs[0].cmd, NODE, 'the stand-in installer ran first')
  assert.match(r.out, /\[ok\] Hermes installed/)
  assert.match(r.out, /\[ok\] Hermes health check passed \(hermes doctor\)\./)
  assert.match(r.out, /No model was chosen in the picker/)
})

test('Hermes missing, installer succeeds but nothing is found: exit 1 with the four new-terminal steps', async () => {
  const w = world({ shims: false })
  const r = await drive(w, {
    answers: [[Q_INSTALL, 'y']],
    env: { HERMES_EXE: undefined, VENOM_SETUP_INSTALL_CMD: installer(w, { createsShims: false }) },
  })
  assert.equal(r.code, 1)
  for (const step of ['  1. Close this terminal window.', '  2. Open a new one.', '  3. Go back to this folder:', '  4. Run `npm run setup` again']) {
    assert.ok(r.out.includes(step), `missing step: ${step}\n${r.out}`)
  }
  assert.ok(!r.asked.includes(Q.brain))
})

// ------------------------------------------------------------- health check

test('hermes doctor with notes only (fresh install): one short block, setup goes on', async () => {
  const w = world()
  const env = { FAKE_HERMES_DOCTOR: 'fresh' }
  const r = await drive(w, { answers: [[Q.brain, '2'], [Q.access, '1'], [Q.supervisor, 'boss'], ...TEAM], picks: [''], env })
  assert.equal(r.code, 1) // the empty pick
  assert.match(r.out, /\[ok\] Hermes health check \(hermes doctor\): nothing blocks setup\. Notes for later:/)
  assert.match(r.out, /^ {2}- Run 'hermes setup' to configure API keys$/m)
  assert.ok(!r.out.includes('[problem]'))
  assert.ok(!r.asked.includes(Q.doctorGo), 'no question for notes')
  assert.ok(r.asked.includes(Q.brain), 'went on to the brain question')
})

test('hermes doctor with a blocking finding: setup stops and says what to do', async () => {
  const w = world()
  const r = await drive(w, { answers: [], env: { FAKE_HERMES_DOCTOR: 'blocking' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /\[problem\] Hermes's own health check \(hermes doctor\) reports:/)
  assert.match(r.out, /^ {2}1\. Repair OpenAI SDK: Run `hermes pm repair`, then restart Hermes$/m)
  assert.match(r.out, /Setup stops here because Hermes itself needs a repair\. .*hermes pm repair.*then run npm run setup again\./)
  assert.ok(!r.out.includes("configure API keys"), 'notes are not mixed into the stop message')
  assert.ok(!r.asked.includes(Q.brain))
})

// ------------------------------------------------------------- routes

test('subscription route (Claude): the Max / Pro facts, no editor, no .env', async () => {
  const w = world()
  const r = await drive(w, { answers: [[Q.brain, '2'], [Q.access, '1'], [Q.supervisor, 'boss'], ...TEAM], picks: [''] })
  assert.equal(r.code, 1) // the empty pick
  assert.match(r.out, /a subscription sign-in uses your plan; API keys are billed per use by the provider/)
  assert.match(r.out, /only with a Claude Max plan that has purchased extra-usage credits/)
  assert.match(r.out, /Claude Pro cannot use this: with Pro, choose 2\./)
  assert.match(r.out, /Sign in only inside Hermes's own prompt\. This setup never sees it\./)
  assert.deepEqual(editorRuns(r), [], 'no editor started')
  assert.ok(!existsSync(profileEnv(w, 'boss')), 'no .env created')
  assert.ok(!calls(w).some((a) => a.includes('env-path')), 'the key route was not taken')
})

test('Gemini: no subscription sign-in, straight to the key route without the access question', async () => {
  const w = world()
  const r = await drive(w, { answers: [[Q.brain, '3'], [Q.voiceGo, ''], [Q.supervisor, 'boss'], ...TEAM], picks: [''] })
  assert.equal(r.code, 1) // the empty pick
  assert.match(r.out, /Google Gemini has no subscription sign-in in Hermes, so setup continues with an API key\./)
  assert.ok(!r.asked.includes(Q.access))
  assert.match(r.out, /Hermes reads this key from the variable GOOGLE_API_KEY\./)
  assert.equal(editorRuns(r).length, 1)
  assert.ok(readFileSync(profileEnv(w, 'boss'), 'utf8').includes(`GOOGLE_API_KEY=${KEY}`))
})

const gptKey = [[Q.brain, '1'], [Q.voiceGo, ''], [Q.access, '2']]
const rest = [[/^Use a cheaper model/, ''], [Q.fallback, ''], [Q.appModel, '']]

test('key route, editor leaves the line empty: "No key was found"; declining to reopen exits 1', async () => {
  const w = world()
  const r = await drive(w, { answers: [...gptKey, [Q.supervisor, 'boss'], ...TEAM, [Q.reopenEnv, 'n']], env: { FAKE_EDITOR_MODE: 'empty' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /No key was found after OPENAI_API_KEY= in the file\./)
  assert.match(r.out, /run npm run setup again/)
  assert.ok(!calls(w).some((a) => a.includes('model') && a[0] === '-p'), 'the picker never opened')
})

test('key route, key pasted with quotes and spaces: tidied on request, then READY passes', FULL, async () => {
  const w = world()
  const r = await drive(w, {
    answers: [...gptKey, [Q.supervisor, 'boss'], ...TEAM, [Q.tidy, ''], ...rest],
    picks: ['openai-api/test-gpt-model'],
    env: { FAKE_EDITOR_MODE: 'quotes', FAKE_HERMES_NEED_KEY: 'OPENAI_API_KEY' },
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /The OPENAI_API_KEY line has quotes around the key, spaces around the key or the = sign\./)
  assert.match(r.out, /\[pass\] boss answered: READY/)
  assert.ok(readFileSync(profileEnv(w, 'boss'), 'utf8').split(/\r?\n/).includes(`OPENAI_API_KEY=${KEY}`))
})

test('key route, editor saves a stale copy: the lost lines come back from the backup', async () => {
  const w = world()
  mkdirSync(join(w.state, 'profiles', 'boss'), { recursive: true })
  const original = 'ALPHA_ONE=first\nBETA_TWO=second\nGAMMA_THREE=third\n'
  writeFileSync(profileEnv(w, 'boss'), original)
  const stale = join(w.dir, 'stale.env')
  writeFileSync(stale, `${ENV_HINT}\nOPENAI_API_KEY=\n`)
  const r = await drive(w, {
    answers: [...gptKey, [Q.supervisor, 'boss'], ...TEAM],
    picks: [''],
    env: { FAKE_EDITOR_MODE: 'stale', FAKE_EDITOR_STALE_FILE: stale },
  })
  assert.equal(r.code, 1) // the empty pick
  assert.match(r.out, /Backup of the file as it was: .*\.env\.backup-\d{8}-\d{6}/)
  assert.match(r.out, /The saved file had lost these lines; they were put back from the backup: ALPHA_ONE, BETA_TWO, GAMMA_THREE/)
  const lines = readFileSync(profileEnv(w, 'boss'), 'utf8').split(/\r?\n/)
  for (const l of ['ALPHA_ONE=first', 'BETA_TWO=second', 'GAMMA_THREE=third', `OPENAI_API_KEY=${KEY}`]) assert.ok(lines.includes(l), `${l} in the .env`)
  assert.ok(!r.out.includes('first') && !r.out.includes('second'), 'values are never printed')
})

// ------------------------------------------------------------- voice app

test('voice-app notice: GPT asks to go on and N stops cleanly; Claude only gets the status line', async () => {
  const w = world()
  const stop = await drive(w, { answers: [[Q.brain, '1'], [Q.voiceGo, 'n']] })
  assert.equal(stop.code, 0)
  assert.match(stop.out, /\[note\] Claude Code is not installed \(https:\/\/docs\.claude\.com\/en\/docs\/claude-code\): the talking interface needs it\./)
  assert.match(stop.out, /The agent team will use OpenAI GPT\. The talking interface \(the voice app\) does not follow that choice/)
  assert.match(stop.out, /Stopped\. Nothing was changed\./)
  assert.ok(!calls(w).some((a) => a[0] === 'profile' && a[1] === 'create'), 'no profile created')

  const claude = await drive(w, { answers: [[Q.brain, '2'], [Q.access, '1'], [Q.supervisor, 'boss'], ...TEAM], picks: [''] })
  assert.match(claude.out, /\[note\] Claude Code is not installed/)
  assert.ok(!claude.asked.includes(Q.voiceGo))
  assert.ok(!claude.out.includes('does not follow that choice'))
})

// ------------------------------------------------------------- link test

test('link test failing (supervisor answers by itself): reported with a Fix line, config still written, exit 1', FULL, async () => {
  const w = world()
  const r = await drive(w, {
    answers: [[Q.brain, '2'], [Q.access, '1'], [Q.supervisor, 'boss'], ...TEAM, ...rest],
    picks: ['anthropic/test-claude-model'],
    env: { FAKE_HERMES_LINK: 'self' },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /\[link FAILED\] boss answered, but no run of researcher was recorded/)
  assert.match(r.out, /^Fix: node hermes-mcp\/selftest\.mjs researcher$/m)
  assert.match(r.out, /^Then check again with: npm run setup$/m)
  assert.match(r.out, /Link test: FAILED \(see above\)/)
  const cfg = JSON.parse(readFileSync(join(w.repo, 'venom.config.json'), 'utf8'))
  assert.equal(cfg.supervisorProfile, 'boss')
  assert.deepEqual(cfg.brain, { family: 'claude', provider: 'anthropic', model: 'test-claude-model' })
})

// ------------------------------------------------------------- the whole run

test('whole run, GPT on the API-key route: key file, picker, team, agents, link OK, final lines; the key never leaks', FULL, async () => {
  const w = world()
  const r = await drive(w, {
    answers: [...gptKey, [Q.supervisor, ''], ...TEAM, ...rest],
    picks: ['openai-api/test-gpt-model'],
    env: { FAKE_HERMES_NEED_KEY: 'OPENAI_API_KEY' },
  })
  if (process.env.VENOM_SETUP_TRANSCRIPT) writeFileSync(process.env.VENOM_SETUP_TRANSCRIPT, transcript(w, r.events))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Hermes reads this key from the variable OPENAI_API_KEY/)
  assert.match(r.out, /\[ok\] A key is saved for OPENAI_API_KEY\./)
  assert.match(r.out, /\[pass\] venom answered: READY/)
  for (const n of SPECIALISTS) assert.match(r.out, new RegExp(`\\[pass\\] ${n}: READY`))
  assert.match(r.out, /\[link OK\] researcher replied: LINK-OK-[0-9a-f]{8}$/m)
  const lines = r.out.split('\n')
  assert.deepEqual(lines.slice(-6), [
    '1. Start Venom OS: npm start   then open the printed address (http://localhost:5173) in Google Chrome.',
    '2. You should see a ring with the word INITIALISE: click it, allow the microphone and say "Hey Venom".',
    '3. Change the team any time:',
    '   add your own agent: npm run add-agent',
    '   see the team: npm run agents',
    '   remove one: npm run remove-agent',
  ])
  assert.ok(!r.out.includes('README.md, section'), 'the old README pointer is gone')

  // The team: all four by Enter, no bridge offered (none installed), the roster matches.
  assert.match(r.out, /^Your team: the supervisor venom plus the starter agents you choose\. You can add your own later with: npm run add-agent$/m)
  assert.ok(!r.asked.some((q) => q.startsWith('Also add')), 'no bridge offered when none is installed')
  assert.deepEqual(rosterIds(w), SPECIALISTS)
  const roster = JSON.parse(readFileSync(rosterFile(w), 'utf8')).agents
  assert.deepEqual(roster.filter((a) => a.pinned).map((a) => a.id), ['researcher', 'coder'])
  assert.match(r.out, /^ {2}Team: Researcher, Coder, Operator, Writer$/m)
  assert.ok(r.out.includes(`  Team list: ${rosterFile(w)}`), r.out)
  const script = scriptRun(r)
  assert.equal(argAfter(script.args, '--agents', '-Agents'), 'researcher,coder,operator,writer')
  const log = argAfter(script.args, '--log', '-Log')
  assert.match(fwd(log), /\/logs\/setup-profiles-\d{8}-\d{6}\.log$/)
  assert.ok(fwd(log).startsWith(fwd(w.repo)), log)
  assert.ok(existsSync(log), 'the script wrote its full output to the log')
  const relative = shownPath(fwd(log).slice(fwd(w.repo).length + 1), process.platform)
  assert.ok(r.out.includes(`[ok] Team created. If you need the details later, they are in ${relative} in this folder.`), r.out)
  assert.ok(r.out.includes('Full output: '), 'the script names its log as well')
  assert.ok(script.args.includes('--no-next') || script.args.includes('-NoNext'), 'the script leaves out its own Next line')
  assert.ok(!r.out.includes('Next: sign in'), 'no README pointer from the script inside the wizard')

  // Secrecy: the key is in the profile's .env and nowhere else.
  const envFile = profileEnv(w, 'venom')
  assert.ok(readFileSync(envFile, 'utf8').includes(`OPENAI_API_KEY=${KEY}`))
  for (const e of r.events) assert.ok(!e.join(' ').includes(KEY), `shown to the person: ${e[1]}`)
  for (const f of walk(w.dir)) {
    if (f === envFile) continue
    assert.ok(!readFileSync(f, 'utf8').includes(KEY), `${f} holds the key`)
  }
  for (const argv of calls(w)) assert.ok(!argv.join(' ').includes(KEY), 'the key was passed in an argv')
  for (const x of r.runs) assert.ok(!x.args.join(' ').includes(KEY), 'the key was passed in an argv')
})

// ------------------------------------------------------------- the team question

const claudeRest = [[/^Use a cheaper model/, ''], [Q.fallback, ''], [Q.appModel, '']]
const claudeStart = [[Q.brain, '2'], [Q.access, '1'], [Q.supervisor, 'boss']]
const profilesMade = (w) => Object.keys(JSON.parse(readFileSync(join(w.state, 'state.json'), 'utf8')).profiles ?? {}).sort()

test('team: only Writer chosen, plus Claude Code (installed): one specialist, roster of two, link test on writer', FULL, async () => {
  const w = world()
  const claudeExe = join(w.dir, 'claude-bin', 'claude.exe')
  mkdirSync(dirname(claudeExe), { recursive: true })
  writeFileSync(claudeExe, '')
  const r = await drive(w, {
    answers: [...claudeStart, ...teamOf('writer'), [Q.bridge(BRIDGE.claude), 'y'], ...claudeRest],
    picks: ['anthropic/test-claude-model'],
    env: { TEAM_CLAUDE_EXE: claudeExe },
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.asked.includes(Q.bridge(BRIDGE.gemini)), 'Gemini not offered: Antigravity is not installed')
  assert.deepEqual(profilesMade(w), ['boss', 'writer'])
  assert.equal(argAfter(scriptRun(r).args, '--agents', '-Agents'), 'writer')
  assert.deepEqual(rosterIds(w), ['writer', 'claude'])
  assert.match(r.out, /\[pass\] writer: READY/)
  assert.ok(!/\[pass\] researcher/.test(r.out), 'only the chosen agent is tested')
  assert.match(r.out, /\[link OK\] writer replied: LINK-OK-/)
  assert.match(r.out, /^ {2}Team: Writer, Claude Code$/m)
  assert.match(r.out, /Agents tested: 1 of 1 passed/)
})

test('team: Gemini offered only when Antigravity is installed, added on yes', FULL, async () => {
  const w = world()
  const agy = join(w.dir, 'localappdata', 'agy', 'bin', 'agy.exe')
  mkdirSync(dirname(agy), { recursive: true })
  writeFileSync(agy, '')
  const r = await drive(w, {
    answers: [...claudeStart, ...teamOf('researcher'), [Q.bridge(BRIDGE.gemini), 'y'], ...claudeRest],
    picks: ['anthropic/test-claude-model'],
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.asked.includes(Q.bridge(BRIDGE.claude)), 'Claude Code not offered: not installed')
  assert.deepEqual(rosterIds(w), ['researcher', 'gemini'])
})

test('team: no to all four twice stops with exit 1; nothing is created', async () => {
  const w = world()
  const none = teamOf()
  const r = await drive(w, { answers: [...claudeStart, ...none, ...none] })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /Venom OS needs at least one agent to hand work to/)
  assert.equal(r.out.split('\n').filter((l) => l.startsWith('Venom OS needs at least one agent')).length, 1, 'said once, between the two rounds')
  assert.equal(r.out.trim().split('\n').pop(), NO_TEAM_LINE)
  assert.ok(!calls(w).some((a) => a[0] === 'profile' && a[1] === 'create'), 'no profile created')
  assert.ok(!r.runs.some((x) => x.args.some((a) => /create-profiles/.test(a))), 'the profile script never ran')
  assert.ok(!existsSync(rosterFile(w)), 'no roster file')
})

test('team: an existing roster keeps the person\'s own agent; the starter answers are applied', FULL, async () => {
  const w = world()
  copyFileSync(join(ROOT, 'test', 'fixtures', 'rosters', 'one.json'), rosterFile(w))
  // A team list exists without the starters, so each defaults to no: y adds it.
  const offered = STARTER_AGENTS.map((a) => [Q.agent(a, 'offer'), ['researcher', 'coder'].includes(a.id) ? 'y' : ''])
  const r = await drive(w, { answers: [...claudeStart, ...offered, ...claudeRest], picks: ['anthropic/test-claude-model'] })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /also has your own agents: Helper\. They stay as they are\./)
  assert.deepEqual(rosterIds(w), ['researcher', 'coder', 'helper'])
  assert.deepEqual(profilesMade(w), ['boss', 'coder', 'researcher'])
  assert.match(r.out, /^ {2}Team: Researcher, Coder, Helper$/m)
})

test('team: an invalid roster is shown and kept when the person says no', FULL, async () => {
  const w = world()
  const bad = readFileSync(join(ROOT, 'test', 'fixtures', 'rosters', 'invalid-bad-id.json'), 'utf8')
  writeFileSync(rosterFile(w), bad)
  const r = await drive(w, {
    answers: [...claudeStart, ...TEAM, [Q.replaceRoster, ''], ...claudeRest],
    picks: ['anthropic/test-claude-model'],
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /cannot be used:\n {2}- Agent 5 \("Bad Id"\)/)
  assert.match(r.out, /The file stays as it is\. Venom OS will not start until it is fixed/)
  assert.equal(readFileSync(rosterFile(w), 'utf8'), bad, 'the file is untouched')
  assert.match(r.out, /Team list: .*\(not changed: fix it before starting Venom OS\)/)
  assert.match(r.out, /^ {2}Team: the team list was left as it is; it needs fixing before Venom OS starts$/m)
})

// ------------------------------------------------------------- --check

test('npm run setup -- --check reports the team list and stays read-only', () => {
  const home = mkdtempSync(join(tmpdir(), 'venom-check-home-'))
  const fixtures = join(ROOT, 'test', 'fixtures', 'rosters')
  const check = (roster) => {
    const env = {
      SystemRoot: process.env.SystemRoot,
      PATH: dirname(process.execPath),
      HOME: home,
      USERPROFILE: home,
      HERMES_EXE: join(home, 'no-hermes-here.exe'),
      VENOM_ROSTER_FILE: roster,
    }
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--check'], { encoding: 'utf8', env, input: '' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  assert.match(check(join(fixtures, 'one.json')), /Team: .*one\.json lists 1 agent\./)
  assert.match(check(join(fixtures, 'five.json')), /Team: .*five\.json lists 5 agents\./)
  assert.match(check(join(home, 'none.json')), /Team: no team list at .*none\.json yet, so the four starter agents are used\./)
  const bad = check(join(fixtures, 'invalid-bad-id.json'))
  assert.match(bad, /Team: .*invalid-bad-id\.json cannot be used: Agent 5 .*which is not allowed\.$/m)
  assert.ok(!existsSync(join(home, 'none.json')), 'nothing written')
  assert.deepEqual(readdirSync(home), [], 'the check wrote nothing')
})
