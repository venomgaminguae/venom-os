// The "choose your brain" wizard (scripts/setup-lib.mjs, `npm run setup`) and
// the hermes-setup scripts it drives.
//
// Nothing here reaches the network, the real Hermes home or the repository's
// own venom.config.json: questions, probes and output are stubs, every hermes
// command goes to scripts/fake-hermes.mjs (state in a temp folder), and the
// real create-profiles script (ps1 through pwsh, or sh through bash) runs
// against that stub through HERMES_EXE.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Q, TEST_QUESTION, SPECIALISTS, nodeSupported, redact, ollamaBase, probeLocal, wizard } from '../scripts/setup-lib.mjs'
import { STARTER_AGENTS } from '../hermes-mcp/roster.mjs'
import { LINK_TOKEN_PREFIX, Q_INSTALL, linkPrompt } from '../scripts/setup-hermes.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KIT = join(ROOT, 'hermes-setup').replace(/\\/g, '/')
const FAKE = join(ROOT, 'scripts', 'fake-hermes.mjs')
const EDITOR = join(ROOT, 'scripts', 'fake-editor.mjs')
const WIN = process.platform === 'win32'
// Built at run time so no key-shaped literal sits in the repository.
const FAKE_KEY = 's' + 'k-proj-' + ['FAKEab12CD34', 'ef56GH78ij90KL'].join('')
const FAKE_GOOGLE_KEY = 'AI' + 'za' + 'Sy' + ['FAKE', '1234567890abcdefghij', 'klmno'].join('')
// What the fake editor "types" into a .env in the key route.
const EDITOR_KEY = 'AI' + 'za' + 'Sy' + ['EDIT', '0987654321zyxwvutsrq', 'ponml'].join('')
const HEX = 'abcd1234'

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

/** A temp world: repo root, fake Hermes state, and hermes shims pointing at fake-hermes.mjs. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'venom-setup-'))
  const repo = join(dir, 'repo')
  const state = join(dir, 'state')
  const bin = join(dir, 'bin')
  for (const d of [repo, join(repo, 'hermes-mcp'), state, bin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(repo, 'hermes-mcp', 'server.mjs'), '// stand-in\n')
  writeFileSync(join(repo, 'venom.config.json'), JSON.stringify({ ownerName: 'Test Owner', city: 'Test City' }, null, 2))
  const node = process.execPath
  const cmdShim = join(bin, 'hermes.cmd')
  writeFileSync(cmdShim, `@"${node}" "${FAKE}" %*\r\n`)
  const shShim = join(bin, 'hermes')
  const fwd = (p) => p.replace(/\\/g, '/')
  writeFileSync(shShim, `#!/bin/sh\nexec "${fwd(node)}" "${fwd(FAKE)}" "$@"\n`, { mode: 0o755 })
  return { dir, repo, state, bin, cmdShim, shShim }
}

const fakeEnv = (w, extra = {}) => ({ ...process.env, FAKE_HERMES_STATE: w.state, ...extra })
const hermesState = (w) => JSON.parse(readFileSync(join(w.state, 'state.json'), 'utf8'))
const calls = (w) =>
  existsSync(join(w.state, 'calls.jsonl'))
    ? readFileSync(join(w.state, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
const fakeHermes = (w, args, extra) => spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', env: fakeEnv(w, extra) })

/**
 * Drive the wizard. `answers` is a list of [expected question (string prefix
 * or RegExp), answer]; `picks` the provider/model each `hermes model` run
 * chooses; `chat(profile, args, n)` may override a one-line test's result.
 */
async function drive(w, { answers, picks = [], chat, fetchJson, env: envExtra = {}, platform = process.platform, which: whichExtra = {}, nodeVersion = '22.12.0' }) {
  const log = []
  const asked = []
  const runs = []
  const queue = [...answers]
  const pickQueue = [...picks]
  const chats = {}
  const hermesExe = WIN ? w.cmdShim : w.shShim
  let clock = 0
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HERMES_EXE: hermesExe,
    ProgramFiles: join(w.dir, 'pf'),
    VENOM_AGENTS_DIR: join(w.dir, 'agents'),
    VENOM_SETUP_EDITOR: `"${process.execPath}" "${EDITOR}"`,
    FAKE_EDITOR_MODE: 'fill',
    FAKE_EDITOR_KEY: EDITOR_KEY,
    VENOM_ROSTER_FILE: join(w.dir, 'venom.agents.json'),
    ...envExtra,
  }
  const chromeWin = `${env.ProgramFiles.replace(/\\/g, '/')}/Google/Chrome/Application/chrome.exe`
  const whichMap = {
    pwsh: WIN ? PWSH : '',
    bash: WIN ? '' : BASH,
    'google-chrome': '/fake/google-chrome',
    claude: '',
    hermes: '',
    ...whichExtra,
  }
  const deps = {
    platform,
    env,
    nodeVersion,
    repoRoot: w.repo,
    kitDir: KIT,
    homedir: w.dir,
    log: (l) => log.push(String(l)),
    ask: async (q) => {
      asked.push(q)
      const next = queue.shift()
      assert.ok(next, `unexpected question: ${q}`)
      const [want, answer] = next
      if (want instanceof RegExp) assert.match(q, want)
      else assert.ok(q.startsWith(want), `expected question "${want}", got "${q}"`)
      return answer
    },
    run: async (cmd, args, opts = {}) => {
      runs.push({ cmd, args, interactive: Boolean(opts.interactive) })
      if (cmd === hermesExe) {
        const profile = args[0] === '-p' ? args[1] : ''
        if (args[2] === 'chat') {
          chats[profile] = (chats[profile] ?? 0) + 1
          const over = chat?.(profile, args, chats[profile])
          if (over) return over
        }
        const extra = args[2] === 'model' ? { FAKE_HERMES_PICK: pickQueue.shift() ?? '' } : {}
        const r = fakeHermes(w, args, { ...env, ...extra })
        return { code: r.status, stdout: r.stdout, stderr: r.stderr }
      }
      // The real create-profiles script, or the fake editor, against the fake Hermes.
      const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env, ...opts.env, FAKE_HERMES_STATE: w.state } })
      if (r.stdout || r.stderr) log.push(r.stdout, r.stderr)
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    },
    fetchJson: fetchJson ?? (async (url) => {
      throw new Error(`no network in tests: ${url}`)
    }),
    fetchText: async (url) => {
      throw new Error(`no network in tests: ${url}`)
    },
    exists: (p) => p === chromeWin || existsSync(p),
    which: (name) => whichMap[name] ?? '',
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, text) => writeFileSync(p, text),
    copyFile: (src, dest) => copyFileSync(src, dest),
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    now: () => new Date(2026, 10, 14, 12, 0, 0),
    // Each reading is 10 s later, so the editor never looks "too fast".
    nowMs: () => (clock += 10_000),
    randomHex: () => HEX,
  }
  const code = await wizard(deps)
  assert.equal(queue.length, 0, `questions not asked: ${queue.map((q) => q[0]).join(' | ')}`)
  return { code, log, out: log.join('\n'), asked, runs, hermesExe }
}

const SHELL_OK = WIN ? Boolean(PWSH) : Boolean(BASH)

/** The team question answered with Enter four times: all four starters. */
const TEAM = STARTER_AGENTS.map((a) => [Q.agent(a), ''])

/**
 * The brain choice and what follows it: the voice-app question (not for
 * Claude) and, for GPT and Claude, the subscription sign-in route.
 */
const brainAnswers = (choice) => [
  [Q.brain, choice],
  ...(choice === '2' ? [] : [[Q.voiceGo, '']]),
  ...(choice === '1' || choice === '2' ? [[Q.access, '1']] : []),
]

/** The answers for a plain run: family, supervisor name, then defaults. */
const plainAnswers = (choice, sup) => [
  ...brainAnswers(choice),
  [Q.supervisor, sup],
  ...TEAM,
  [/^Use a cheaper model for the workers\?/, ''],
  [Q.fallback, ''],
  [/^The voice app itself runs on Claude Code/, ''],
]

function assertTeam(w, sup, brain, worker) {
  const s = hermesState(w)
  for (const name of [sup, ...SPECIALISTS]) {
    const p = s.profiles[name]
    assert.ok(p, `profile ${name} exists`)
    assert.equal(p.config['model.default'], brain.model, `${name} model.default`)
    assert.equal(p.config['model.provider'], brain.provider, `${name} model.provider`)
    assert.equal(p.config['delegation.model'], worker.model, `${name} delegation.model`)
    assert.equal(p.config['delegation.provider'], worker.provider, `${name} delegation.provider`)
    assert.equal(p.config['delegation.oneshot_max_children'], '5', `${name} max workers`)
    assert.ok(existsSync(join(w.state, 'profiles', name, 'SOUL.md')), `${name} SOUL.md written`)
  }
  for (const name of SPECIALISTS) {
    assert.equal(s.profiles[name].clonedFrom, sup, `${name} cloned from ${sup}`)
    assert.deepEqual(Object.keys(s.profiles[name].mcp), [], `${name} has no team connector`)
  }
  assert.deepEqual(Object.keys(s.profiles[sup].mcp), ['team'])
  assert.match(s.profiles[sup].mcp.team.args.join(' '), /hermes-mcp\/server\.mjs$/)
  if (sup !== 'venom') assert.ok(!s.profiles.venom, 'no profile called venom was created')
  // The supervisor's SOUL comes from souls/venom.SOUL.md, filled in.
  const soul = readFileSync(join(w.state, 'profiles', sup, 'SOUL.md'), 'utf8')
  assert.ok(soul.includes(brain.model) && !soul.includes('{{BRAIN_MODEL}}'))
  // Specialists exist before the connector is registered.
  const c = calls(w)
  const addAt = c.findIndex((a) => a.includes('mcp') && a.includes('add'))
  for (const name of SPECIALISTS) {
    const at = c.findIndex((a) => a[0] === 'profile' && a[1] === 'create' && a[2] === name)
    assert.ok(at !== -1 && at < addAt, `${name} created before the team connector`)
  }
}

function assertAppConfig(w, family, brain, worker, sup, appModel = '') {
  const cfg = JSON.parse(readFileSync(join(w.repo, 'venom.config.json'), 'utf8'))
  assert.deepEqual(cfg, {
    ownerName: 'Test Owner',
    city: 'Test City',
    brain: { family, ...brain },
    worker,
    supervisorProfile: sup,
    appModel,
  })
}

/** The hermes commands the wizard itself issued (not the script's), in order, as strings. */
const wizardHermes = (r) => r.runs.filter((x) => x.cmd === r.hermesExe).map((x) => (x.interactive ? '[i] ' : '') + x.args.join(' '))

function expectedWizardCommands(sup, extraAfterTest = [], keyRoute = false) {
  return [
    'doctor',
    `profile show ${sup}`,
    `profile create ${sup} --description Supervisor: plans, delegates to the specialist agents through the team connector, checks their reports and answers the owner.`,
    ...(keyRoute ? [`-p ${sup} config env-path`, '--version'] : []),
    `[i] -p ${sup} model`,
    `-p ${sup} config get model.provider`,
    `-p ${sup} config get model.default`,
    `-p ${sup} chat -q ${TEST_QUESTION} -Q --source tool`,
    ...extraAfterTest,
    ...SPECIALISTS.map((n) => `-p ${n} chat -q ${TEST_QUESTION} -Q --source tool`),
    `-p ${sup} mcp list`,
    `-p ${sup} mcp test team`,
    `-p ${sup} chat -q ${linkPrompt('researcher', LINK_TOKEN_PREFIX + HEX)} -Q --source tool`,
  ]
}

// ------------------------------------------------------------- four paths

const CLOUD = [
  ['gpt', '1', 'openai-codex/test-gpt-model'],
  ['claude', '2', 'anthropic/test-claude-model'],
  ['gemini', '3', 'gemini/test-gemini-model'],
]

for (const [family, choice, pick] of CLOUD) {
  test(`wizard, ${family}: picker, test, team, app settings, custom supervisor name`, { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
    const w = world()
    const sup = `boss${family}`
    const r = await drive(w, { answers: plainAnswers(choice, sup), picks: [pick] })
    assert.equal(r.code, 0, r.out)
    const [provider, model] = pick.split('/')
    const brain = { provider, model }
    const keyRoute = family === 'gemini'
    assert.deepEqual(wizardHermes(r), expectedWizardCommands(sup, [], keyRoute))
    const script = r.runs.find((x) => x.cmd !== r.hermesExe && x.cmd !== process.execPath)
    assert.ok(script.interactive, 'the script runs with inherited stdio')
    const a = script.args.join(' ')
    for (const part of [sup, model, provider, w.repo.replace(/\\/g, '/')]) assert.ok(a.includes(part), `script args include ${part}: ${a}`)
    assert.match(a, /(--agents|-Agents) researcher,coder,operator,writer /)
    // The log path is passed as the screen shows it: the platform's own separator.
    assert.match(a, /(--log|-Log) \S+[\\/]logs[\\/]setup-profiles-\d{8}-\d{6}\.log/)
    assert.match(a, / (--no-next|-NoNext)\b/)
    assert.ok(!r.out.includes('Next: sign in'), 'the script leaves out its own Next line')
    const roster = JSON.parse(readFileSync(join(w.dir, 'venom.agents.json'), 'utf8')).agents
    assert.deepEqual(roster.map((x) => x.id), SPECIALISTS)
    assertTeam(w, sup, brain, brain)
    assertAppConfig(w, family, brain, brain, sup)
    for (const n of SPECIALISTS) assert.match(r.out, new RegExp(`\\[pass\\] ${n}: READY`))
    assert.match(r.out, /\[link OK\] researcher replied: LINK-OK-abcd1234/)
    assert.match(r.out, /Link test: passed/)
    assert.match(r.out, /^1\. Start Venom OS: npm start/m)
    assert.match(r.out, /\[note\] Claude Code is not installed/)
    // Gemini has no sign-in: its key went into the profile's .env, never into the output.
    assert.equal(r.asked.includes(Q.access), family !== 'gemini')
    assert.equal(existsSync(join(w.state, 'profiles', sup, '.env')), keyRoute)
    assert.ok(!r.out.includes(EDITOR_KEY) && !r.asked.join('\n').includes(EDITOR_KEY))
  })
}

test('wizard, local: lists Ollama and LM Studio models with sizes and honest guidance', { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
  const w = world()
  const urls = []
  const fetchJson = async (url) => {
    urls.push(url)
    if (url === 'http://127.0.0.1:11500/api/tags') {
      return {
        models: [
          { name: 'small-model:7b', size: 4_700_000_000, details: { parameter_size: '7.6B' } },
          { name: 'big-model:32b', size: 19_000_000_000, details: { parameter_size: '32.8B' } },
        ],
      }
    }
    if (url === 'http://localhost:1234/v1/models') return { data: [{ id: 'studio-model-12b' }] }
    throw new Error('refused')
  }
  const r = await drive(w, {
    answers: plainAnswers('4', 'localboss'),
    picks: ['custom/big-model:32b'],
    fetchJson,
    env: { OLLAMA_HOST: '127.0.0.1:11500' },
  })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(urls, ['http://127.0.0.1:11500/api/tags', 'http://localhost:1234/v1/models'])
  assert.match(r.out, /small-model:7b \(7\.6B, 4\.7 GB on disk\)\s+<- small/)
  assert.match(r.out, /big-model:32b \(32\.8B, 19\.0 GB on disk\)$/m)
  assert.match(r.out, /studio-model-12b/)
  assert.match(r.out, /under 14B parameters or about 8 GB/)
  assert.match(r.out, /below the cloud options/)
  assert.match(r.out, /Custom endpoint \(enter URL manually\)', enter http:\/\/127\.0\.0\.1:11500\/v1/)
  assert.match(r.out, /choose 'LM Studio'/)
  const brain = { provider: 'custom', model: 'big-model:32b' }
  assert.deepEqual(wizardHermes(r), expectedWizardCommands('localboss'))
  assertTeam(w, 'localboss', brain, brain)
  assertAppConfig(w, 'local', brain, brain, 'localboss')
})

test('wizard, local: a user-defined provider on localhost counts as local', { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
  const w = world()
  const fetchJson = async (url) => {
    if (url.endsWith('/api/tags')) return { models: [{ name: 'm:14b', size: 9e9 }] }
    throw new Error('refused')
  }
  const r = await drive(w, {
    answers: plainAnswers('4', 'venom'),
    picks: ['mybox/m:14b http://localhost:11434/v1'],
    fetchJson,
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.asked.some((q) => q.startsWith('Keep ')), 'no keep question for a localhost provider')
  assert.ok(wizardHermes(r).includes('-p venom config get model.base_url'))
  const brain = { provider: 'mybox', model: 'm:14b' }
  assertTeam(w, 'venom', brain, brain)
  assertAppConfig(w, 'local', brain, brain, 'venom')
})

// ------------------------------------------------------------- branches

test('wizard: missing Hermes offers the official install; declining exits 1 without running anything', async () => {
  const w = world()
  for (const [platform, step] of [
    ['win32', 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)'],
    ['linux', 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'],
  ]) {
    const r = await drive(w, { answers: [[Q_INSTALL, 'n']], platform, env: { HERMES_EXE: '', LOCALAPPDATA: join(w.dir, 'nowhere') } })
    assert.equal(r.code, 1)
    assert.ok(r.out.includes(step), r.out)
    assert.match(r.out, /Hermes Agent is not installed/)
    assert.match(r.out, /hermes-agent\.nousresearch\.com\/docs\/getting-started\/installation/)
    assert.equal(r.runs.length, 0, 'nothing was run')
  }
})

test('wizard: missing Chrome and old Node are reported first; no install is offered then', async () => {
  const w = world()
  const r = await drive(w, { answers: [], platform: 'linux', which: { 'google-chrome': '' }, nodeVersion: '22.11.0', env: { HERMES_EXE: '' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /\[missing\] Node\.js 22\.12 or newer \(found 22\.11\.0\)/)
  assert.match(r.out, /\[missing\] Google Chrome/)
  assert.match(r.out, /https:\/\/www\.google\.com\/chrome\//)
  assert.match(r.out, /\[missing\] Hermes Agent/)
  assert.equal(r.runs.length, 0, 'nothing was run')
})

test('nodeSupported compares major and minor against 22.12', () => {
  for (const v of ['22.12.0', 'v22.13.1', '23.0.0', '24.14.1']) assert.equal(nodeSupported(v), true, v)
  for (const v of ['22.11.9', '20.18.0', '', undefined, 'x']) assert.equal(nodeSupported(v), false, String(v))
})

test('wizard, local: no server answering stops before any profile is touched', async () => {
  const w = world()
  const r = await drive(w, { answers: [...brainAnswers('4')] })
  assert.equal(r.code, 1)
  assert.match(r.out, /https:\/\/ollama\.com\/download/)
  assert.match(r.out, /https:\/\/lmstudio\.ai/)
  assert.match(r.out, /run `npm run setup` again/)
  assert.deepEqual(wizardHermes(r), ['doctor'])
})

test('wizard: provider from another family asks before keeping it; N reopens the picker', { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
  const w = world()
  const r = await drive(w, {
    answers: [
      ...brainAnswers('1'),
      [Q.supervisor, ''],
      ...TEAM,
      [Q.keep('anthropic', 'other-model'), 'n'],
      [/^Use a cheaper model/, ''],
      [Q.fallback, 'n'],
      [/^The voice app itself/, 'test-app-model'],
    ],
    picks: ['anthropic/other-model', 'openai-api/test-gpt-model'],
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /not one of the OpenAI GPT providers/)
  assert.equal(wizardHermes(r).filter((c) => c === '[i] -p venom model').length, 2)
  const brain = { provider: 'openai-api', model: 'test-gpt-model' }
  assertTeam(w, 'venom', brain, brain)
  assertAppConfig(w, 'gpt', brain, brain, 'venom', 'test-app-model')
})

test('wizard: nothing chosen in the picker stops', async () => {
  const w = world()
  const r = await drive(w, { answers: [...brainAnswers('3'), [Q.supervisor, 'boss'], ...TEAM], picks: [''] })
  assert.equal(r.code, 1)
  assert.match(r.out, /No model was chosen in the picker/)
})

test('wizard: an existing profile is updated only with consent; N asks for another name', async () => {
  const w = world()
  fakeHermes(w, ['profile', 'create', 'taken', '--description', 'x'])
  fakeHermes(w, ['profile', 'create', 'kept', '--description', 'x'])
  const r = await drive(w, {
    answers: [
      ...brainAnswers('2'),
      [Q.supervisor, 'Bad Name!'],
      [Q.supervisor, 'coder'],
      [Q.supervisor, 'taken'],
      [Q.update('taken'), ''],
      [Q.supervisor, 'kept'],
      [Q.update('kept'), 'y'],
      ...TEAM,
    ],
    picks: [''],
  })
  assert.equal(r.code, 1) // stops after the empty pick; the name logic is what is checked
  assert.match(r.out, /Use lowercase letters and digits/)
  assert.match(r.out, /'coder' is taken/)
  assert.ok(!wizardHermes(r).some((c) => c.startsWith('profile create')), 'no profile created for an existing name')
  assert.ok(wizardHermes(r).includes('[i] -p kept model'))
})

test('wizard: a failing test shows the real error, redacted, and can reopen the picker', { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
  const w = world()
  const r = await drive(w, {
    answers: [
      ...brainAnswers('1'),
      [Q.supervisor, 'boss'],
      ...TEAM,
      [Q.retryPicker, ''],
      [/^Use a cheaper model/, ''],
      [Q.fallback, ''],
      [/^The voice app itself/, ''],
    ],
    picks: ['openai-api/test-gpt-model', 'openai-api/test-gpt-model'],
    chat: (profile, args, n) =>
      profile === 'boss' && n === 1
        ? {
            code: 1,
            stdout: '',
            stderr: `HTTP 401: Incorrect API key provided: ${FAKE_KEY}. OPENAI_API_KEY=${FAKE_KEY}\nAlso tried ${FAKE_GOOGLE_KEY}\n`,
          }
        : undefined,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\[fail\] boss did not answer \(exit code 1\)/)
  assert.match(r.out, /HTTP 401: Incorrect API key provided: sk-\*\*\*/)
  assert.match(r.out, /\[pass\] boss answered: READY/)
  // The key never shows up: not in the output, not in any file written.
  for (const key of [FAKE_KEY, FAKE_GOOGLE_KEY, 'FAKEab12CD34', '1234567890abcdefghij']) {
    assert.ok(!r.out.includes(key), `output leaks ${key}`)
    for (const f of walk(w.dir)) assert.ok(!readFileSync(f, 'utf8').includes(key), `${f} leaks ${key}`)
  }
})

test('wizard: worker model is tested with -m; a failure can fall back to the brain; fallback add runs the picker', { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
  const w = world()
  const r = await drive(w, {
    answers: [
      ...brainAnswers('2'),
      [Q.supervisor, 'boss'],
      ...TEAM,
      [Q.worker('test-claude-model'), 'broken-worker'],
      [Q.retryWorker, 'y'],
      [Q.worker('test-claude-model'), 'test-cheap-model'],
      [Q.fallback, 'y'],
      [/^The voice app itself/, ''],
    ],
    picks: ['anthropic/test-claude-model'],
    chat: (profile, args) => (args.includes('broken-worker') ? { code: 2, stdout: '', stderr: 'Error: model broken-worker not found' } : undefined),
  })
  assert.equal(r.code, 0, r.out)
  const cmds = wizardHermes(r)
  const q = `chat -q ${TEST_QUESTION} -Q --source tool`
  assert.deepEqual(
    cmds,
    expectedWizardCommands('boss', [
      `-p boss ${q} -m broken-worker --provider anthropic`,
      `-p boss ${q} -m test-cheap-model --provider anthropic`,
      '[i] -p boss fallback add',
    ]),
  )
  assert.match(r.out, /model broken-worker not found/)
  const brain = { provider: 'anthropic', model: 'test-claude-model' }
  const worker = { provider: 'anthropic', model: 'test-cheap-model' }
  assertTeam(w, 'boss', brain, worker)
  assertAppConfig(w, 'claude', brain, worker, 'boss')
})

test('wizard: worker failure with "n" keeps the brain model for the workers', { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
  const w = world()
  const r = await drive(w, {
    answers: [
      ...brainAnswers('3'),
      [Q.supervisor, 'boss'],
      ...TEAM,
      [/^Use a cheaper model/, 'nope-model'],
      [Q.retryWorker, 'n'],
      [Q.fallback, 'n'],
      [/^The voice app itself/, ''],
    ],
    picks: ['gemini/test-gemini-model'],
    chat: (profile, args) => (args.includes('nope-model') ? { code: 1, stdout: '', stderr: 'unknown model' } : undefined),
  })
  assert.equal(r.code, 0, r.out)
  const brain = { provider: 'gemini', model: 'test-gemini-model' }
  assertTeam(w, 'boss', brain, brain)
})

test('wizard: a specialist that fails its test gets the per-profile sign-in fix', { skip: !SHELL_OK && 'no pwsh/bash' }, async () => {
  const w = world()
  const r = await drive(w, {
    answers: plainAnswers('1', 'boss'),
    picks: ['openai-codex/test-gpt-model'],
    chat: (profile) => (profile === 'writer' ? { code: 1, stdout: '', stderr: 'Error: not signed in to openai-codex' } : undefined),
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\[fail\] writer \(exit code 1\)/)
  assert.match(r.out, /Fix: hermes -p writer model/)
  assert.match(r.out, /sign-ins .* are stored per profile and are not copied/)
  assert.match(r.out, /3 of 4 passed \(failed: writer\)/)
})

// ------------------------------------------------------------- helpers

test('redact masks key-shaped strings and keeps ordinary text', () => {
  const s = redact(`bad key ${FAKE_KEY} and ${FAKE_GOOGLE_KEY}; Authorization: Bearer abcdefghijklmnop123; ${'api_'}key=hunter2hunter2; ` +
    'hex 0123456789abcdef0123456789abcdef; https://hermes-agent.nousresearch.com/docs/getting-started/installation; model test-gpt-model')
  for (const leak of [FAKE_KEY, FAKE_GOOGLE_KEY, 'abcdefghijklmnop123', 'hunter2hunter2', '0123456789abcdef0123456789abcdef']) assert.ok(!s.includes(leak), s)
  assert.ok(s.includes('https://hermes-agent.nousresearch.com/docs/getting-started/installation'))
  assert.ok(s.includes('model test-gpt-model'))
})

test('ollamaBase reads OLLAMA_HOST in its usual shapes', () => {
  assert.equal(ollamaBase({}), 'http://localhost:11434')
  assert.equal(ollamaBase({ OLLAMA_HOST: '0.0.0.0' }), 'http://localhost:11434')
  assert.equal(ollamaBase({ OLLAMA_HOST: 'http://box:9000' }), 'http://box:9000')
})

test('probeLocal never throws when nothing answers', async () => {
  assert.deepEqual(await probeLocal({ fetchJson: async () => { throw new Error('x') }, env: {} }), [])
})

// ------------------------------------------------------------- setup.mjs entry

test('npm run setup refuses a non-TTY stdin; --check is read-only and exits 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'venom-setup-home-'))
  const env = { ...process.env, HOME: home, USERPROFILE: home, HERMES_EXE: join(home, 'no-hermes-here.exe'), VENOM_ROSTER_FILE: join(home, 'venom.agents.json') }
  const setup = join(ROOT, 'scripts', 'setup.mjs')
  const plain = spawnSync(process.execPath, [setup], { encoding: 'utf8', env, input: '' })
  assert.equal(plain.status, 1)
  assert.match(plain.stdout, /interactive wizard: run it in a terminal/)
  assert.match(plain.stdout, /npm run setup -- --check/)
  const check = spawnSync(process.execPath, [setup, '--check'], { encoding: 'utf8', env, input: '' })
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /VENOM preflight/)
})

// ------------------------------------------------------------- the scripts, end to end

function runScript(kind, w, args) {
  const env = fakeEnv(w, { HERMES_EXE: kind === 'ps1' && WIN ? w.cmdShim : w.shShim })
  const r =
    kind === 'ps1'
      ? spawnSync(PWSH, ['-NoProfile', '-File', join(KIT, 'create-profiles.ps1'), ...args], { encoding: 'utf8', env })
      : spawnSync(BASH, [join(KIT, 'create-profiles.sh').replace(/\\/g, '/'), ...args], { encoding: 'utf8', env })
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
}

const scriptArgs = (kind, o) =>
  kind === 'ps1'
    ? ['-Supervisor', o.sup, '-BrainModel', o.bm, '-BrainProvider', o.bp, '-WorkerModel', o.wm, '-WorkerProvider', o.wp, '-MaxWorkers', '5', '-RepoPath', o.repo, ...(o.noAlias ? ['-NoAlias'] : [])]
    : ['--supervisor', o.sup, '--brain-model', o.bm, '--brain-provider', o.bp, '--worker-model', o.wm, '--worker-provider', o.wp, '--max-workers', '5', '--repo-path', o.repo, ...(o.noAlias ? ['--no-alias'] : [])]

for (const kind of ['ps1', 'sh']) {
  const skip = kind === 'ps1' ? !PWSH && 'pwsh not found' : !BASH && 'bash not found'
  test(`create-profiles.${kind} end to end against fake-hermes: custom supervisor, idempotent, connector last`, { skip }, () => {
    const w = world()
    const o = { sup: 'chief', bm: 'test-brain-model', bp: 'custom', wm: 'test-worker-model', wp: 'custom', repo: w.repo.replace(/\\/g, '/'), noAlias: true }
    const first = runScript(kind, w, scriptArgs(kind, o))
    assert.equal(first.code, 0, first.out)
    assertTeam(w, 'chief', { model: 'test-brain-model', provider: 'custom' }, { model: 'test-worker-model', provider: 'custom' })
    const s = hermesState(w)
    for (const name of ['chief', ...SPECIALISTS]) assert.equal(s.profiles[name].noAlias, true, `${name} --no-alias`)
    assert.equal(s.profiles.chief.clonedFrom, null)

    // Again: nothing is recreated, the connector is not added twice, no SOUL backups.
    const before = calls(w).length
    const second = runScript(kind, w, scriptArgs(kind, o))
    assert.equal(second.code, 0, second.out)
    const again = calls(w).slice(before)
    assert.ok(!again.some((a) => a[0] === 'profile' && a[1] === 'create'), 'no profile created twice')
    assert.ok(!again.some((a) => a.includes('add')), 'connector not added twice')
    assert.match(second.out, /already registered on chief/)
    for (const name of ['chief', ...SPECIALISTS]) {
      assert.deepEqual(readdirSync(join(w.state, 'profiles', name)).filter((f) => f.includes('.bak-')), [], `${name}: no backup`)
    }
  })

  test(`create-profiles.${kind}: a team connector copied from the supervisor is removed from new specialists`, { skip }, () => {
    const w = world()
    fakeHermes(w, ['profile', 'create', 'chief', '--description', 'x'])
    fakeHermes(w, ['-p', 'chief', 'mcp', 'add', 'team', '--command', 'node', '--args', 'x/server.mjs'])
    const o = { sup: 'chief', bm: 'b', bp: 'p', wm: 'b', wp: 'p', repo: w.repo.replace(/\\/g, '/') }
    const r = runScript(kind, w, scriptArgs(kind, o))
    assert.equal(r.code, 0, r.out)
    const s = hermesState(w)
    for (const name of SPECIALISTS) {
      assert.equal(s.profiles[name].clonedFrom, 'chief')
      assert.deepEqual(Object.keys(s.profiles[name].mcp), [], `${name} has no team`)
    }
    assert.deepEqual(Object.keys(s.profiles.chief.mcp), ['team'])
    assert.match(r.out, /already registered on chief/)
  })

  test(`create-profiles.${kind}: refuses placeholders and a specialist's name as supervisor`, { skip }, () => {
    const w = world()
    const none = runScript(kind, w, [])
    assert.equal(none.code, 2, none.out)
    assert.match(none.out, /Still placeholders/)
    const bad = runScript(kind, w, kind === 'ps1' ? ['-Supervisor', 'writer', '-BrainModel', 'b', '-BrainProvider', 'p'] : ['--supervisor', 'writer', '--brain-model', 'b', '--brain-provider', 'p'])
    assert.equal(bad.code, 2, bad.out)
    assert.deepEqual(calls(w), [], 'hermes was never called')
  })
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
