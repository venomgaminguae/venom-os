// The "choose your brain" setup wizard behind `npm run setup`. All logic lives
// here; every side effect (running programs, questions, HTTP probes, files,
// output) goes through the `deps` object, so test/setup-brain.test.mjs and
// test/setup-wizard.test.mjs can drive the whole flow with stubs.
// scripts/setup.mjs supplies the real ones.
//
// Keys and sign-ins: sign-ins happen only inside Hermes's own prompt
// (`hermes model`, run with inherited stdio). The owner pastes an API key
// into the profile's own .env file in a plain editor; this wizard never prints,
// logs, stores elsewhere or sends a key. It touches that file only through the
// helpers in setup-env.mjs, which return variable NAMES and plain words, and
// every Hermes output it prints goes through redact() first.
import { LINK_TOKEN_PREFIX, claudeStatus, healthCheck, healthFix, linkTest, offerInstall } from './setup-hermes.mjs'
import {
  checkEnvFile,
  editorCommand,
  envValueState,
  keyVariable,
  openEnvInEditor,
  prepareEnvFile,
  restoreChanged,
  tidyEnvValue,
} from './setup-env.mjs'
import { BRIDGE_AGENTS, BRIDGE_IDS, RosterError, STARTER_AGENTS, loadRoster, rosterPath, saveRoster } from '../hermes-mcp/roster.mjs'

/** The ids of the four starter agents, in their usual order. */
export const SPECIALISTS = STARTER_AGENTS.map((a) => a.id)

/** A few words on what a starter agent does: its role up to the first ";" or ".". */
export const shortRole = (role) => String(role ?? '').split(/[;.]/)[0].trim()

/** What each optional bridge is, in a few words, for the question that offers it. */
const BRIDGE_WORDS = {
  claude: 'the Claude Code on this PC, for larger coding and review jobs',
  gemini: "Google's Gemini through Antigravity, read-only: search-grounded research and a second opinion",
}

export const NO_TEAM_LINE = 'Nothing was created. Run npm run setup again and say yes to at least one agent.'

export const SUPERVISOR_DESCRIPTION =
  'Supervisor: plans, delegates to the specialist agents through the team connector, checks their reports and answers the owner.'

export const TEST_QUESTION = 'Reply with the single word READY.'

/** The oldest Node.js the installed tools run on (package.json engines). */
export const NODE_MIN = '22.12'

export const Q = {
  doctorGo: 'Go on with setup? (y/N)',
  brain:
    'Which brain do you want? 1) OpenAI GPT  2) Anthropic Claude  3) Google Gemini  4) A local model on this PC (Ollama or LM Studio)',
  voiceGo: 'Go on, or stop here? (Y/n)',
  access: 'How do you want to connect? 1) Sign in with my subscription  2) Paste an API key',
  supervisor: 'Name for the supervisor profile [venom]:',
  update: (name) => `Profile ${name} already exists. Update its model settings? (y/N)`,
  keepKey: (name) => `A key is already saved for ${name}. Keep it? (Y/n)`,
  keepChanged: (names) => `These other lines changed while the file was open: ${names}. Keep the changes? (y/N)`,
  reopenEnv: 'Open the file again? (Y/n)',
  tidy: 'Tidy that line for you? (Y/n)',
  reopenKey: 'Open the key file again? (Y/n)',
  keep: (provider, model) => `Keep ${provider}/${model} anyway? (y/N)`,
  worker: (model) =>
    `Use a cheaper model for the workers? Type a model id from the same provider, or press Enter to use ${model}:`,
  fallback: 'Add a fallback model for when the brain fails? (y/N)',
  retryPicker: 'Try the model picker again? (Y/n)',
  retryWorker: 'Try another worker model? (Y/n)',
  appModel:
    'The voice app itself runs on Claude Code (see README). Claude model id for the voice app, or press Enter to use your Claude Code default:',
  // mode: 'new' (no team list file yet: Enter = yes), 'keep' (on the existing
  // team list: Enter keeps it), 'offer' (a team list exists without it: Enter = no).
  agent: (a, mode = 'new') =>
    `${a.name} (${shortRole(a.role)}). ${mode === 'keep' ? 'Keep it on the team? (Y/n)' : mode === 'offer' ? 'Add it? (y/N)' : 'Add it? (Y/n)'}`,
  // keep: already on the existing team list, so Enter keeps it.
  bridge: (a, keep = false) =>
    keep
      ? `Keep ${a.name} as an agent (${BRIDGE_WORDS[a.id] ?? shortRole(a.role)})? (Y/n)`
      : `Also add ${a.name} as an agent (${BRIDGE_WORDS[a.id] ?? shortRole(a.role)})? (y/N)`,
  replaceRoster: 'Replace it with the team chosen here? (y/N)',
}

export const LINKS = {
  hermesDocs: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
  hermesWin: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)',
  hermesSh: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
  node: 'https://nodejs.org',
  chrome: 'https://www.google.com/chrome/',
  claudeCode: 'https://docs.claude.com/en/docs/claude-code',
  ollama: 'https://ollama.com/download',
  lmstudio: 'https://lmstudio.ai',
}

/**
 * The four brain families: the provider ids `hermes model` may write for each,
 * whether Hermes offers a subscription sign-in (with the facts the owner reads
 * before choosing), where to get an API key, and which entries to pick in
 * Hermes's own picker for each way in.
 */
export const FAMILIES = {
  gpt: {
    label: 'OpenAI GPT',
    providers: ['openai-codex', 'openai-api', 'openai'],
    keyLink: 'https://platform.openai.com/api-keys',
    signIn: {
      available: true,
      lines: [
        '  1) Sign in with my subscription: you sign in with your ChatGPT account; Hermes then uses the Codex models.',
        "     Hermes's documentation does not say which ChatGPT plans qualify or how the usage counts against your plan.",
        '  2) Paste an API key (from OpenAI, billed per use).',
      ],
    },
    pickSignIn: [
      "In Hermes's list choose 'OpenAI', then 'ChatGPT or Codex Subscription', and sign in with your ChatGPT account.",
      'Then pick a model from the list Hermes shows.',
    ],
    pickKey: ["In Hermes's list choose 'OpenAI', then 'OpenAI API'."],
  },
  claude: {
    label: 'Anthropic Claude',
    providers: ['anthropic'],
    keyLink: 'https://console.anthropic.com/settings/keys',
    signIn: {
      available: true,
      lines: [
        '  1) Sign in with my subscription: only with a Claude Max plan that has purchased extra-usage credits.',
        "     Hermes usage is billed to those extra credits, not to the plan's included usage. Claude Pro cannot use this: with Pro, choose 2.",
        '  2) Paste an API key (from Anthropic, billed per use).',
      ],
    },
    pickSignIn: [
      "In Hermes's list choose 'Anthropic', then sign in with your Claude account (the Max plan with extra-usage credits) when Hermes asks.",
      'Then pick a model from the list Hermes shows.',
    ],
    pickKey: ["In Hermes's list choose 'Anthropic', then the API key choice."],
  },
  gemini: {
    label: 'Google Gemini',
    providers: ['gemini', 'google'],
    keyLink: 'https://aistudio.google.com/apikey',
    signIn: {
      available: false,
      lines: [
        '  Google Gemini has no subscription sign-in in Hermes, so setup continues with an API key.',
        '  A free-tier key runs out after a few agent turns.',
      ],
    },
    pickSignIn: [],
    pickKey: ["In Hermes's list choose 'Google Gemini'."],
  },
  local: {
    label: 'a local model',
    providers: ['custom', 'lmstudio', 'ollama'],
    keyLink: '',
    signIn: { available: false, lines: [] },
    pickSignIn: [],
    pickKey: [],
  },
}

const FAMILY_BY_CHOICE = { 1: 'gpt', 2: 'claude', 3: 'gemini', 4: 'local' }
const RESERVED = new Set(['default', 'hermes', 'test', 'tmp', 'root', 'sudo', ...SPECIALISTS])
const LOCALHOST = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b/i
const PROBLEM_WORDS = {
  quotes: 'quotes around the key',
  spaces: 'spaces around the key or the = sign',
  duplicate: 'more than one line for it',
}

// ------------------------------------------------------------------ helpers

/**
 * Mask anything that looks like a credential: provider key prefixes, bearer
 * tokens, `key=value` secrets, and long hex or base64-like runs.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .replace(/\b(ghp|gho|ghu|ghs|github_pat|xox[abprs]|hf|glpat)[_-][A-Za-z0-9_-]{10,}/g, '$1_***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b([A-Za-z_]*(?:api[_-]?key|token|secret|password)[A-Za-z_]*)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1$2***')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (m) => {
      if (/^[0-9a-f]+$/i.test(m)) return '***'
      if (m.includes('/')) return m
      return /\d/.test(m) && /[A-Za-z]/.test(m) ? '***' : m
    })
}

/** Hermes's answer to a one-shot question: stdout minus session bookkeeping (as hermes-mcp/runner.mjs does). */
export function hermesAnswer(out) {
  return String(out ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(session_id:|Normalized |Resumed )/.test(l))
    .join('\n')
    .trim()
}

/** Whether a Node.js version string ("22.12.0", "v24.1.0") is NODE_MIN or newer. */
export function nodeSupported(version) {
  const [major, minor] = String(version ?? '').replace(/^v/, '').split('.').map(Number)
  const [minMajor, minMinor] = NODE_MIN.split('.').map(Number)
  if (!Number.isFinite(major)) return false
  return major > minMajor || (major === minMajor && (minor || 0) >= minMinor)
}

const tail = (s, n = 1500) => (s.length > n ? '...' + s.slice(-n) : s)
const yes = (a) => /^y(es)?$/i.test(String(a ?? '').trim())
const notNo = (a) => !/^n(o)?$/i.test(String(a ?? '').trim())
const slash = (p) => String(p).replace(/\\/g, '/')

/** A path as printed on screen: one separator, the platform's own (files keep what they store). */
export const shownPath = (p, platform = process.platform) =>
  platform === 'win32' ? String(p ?? '').replace(/\//g, '\\') : String(p ?? '')

/** Where Google Chrome is, or '' when it is not found. */
export function findChrome({ platform, env, exists, which }) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
    for (const r of roots) {
      const p = `${slash(r)}/Google/Chrome/Application/chrome.exe`
      if (exists(p)) return p
    }
    return ''
  }
  if (platform === 'darwin') {
    const app = '/Applications/Google Chrome.app'
    if (exists(app)) return app
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = which(name)
    if (p) return p
  }
  return ''
}

/** The Hermes executable: HERMES_EXE, else `hermes` on PATH, else the Windows installer's location. */
export function findHermes({ platform, env, exists, which }) {
  if (env.HERMES_EXE) return exists(env.HERMES_EXE) ? env.HERMES_EXE : ''
  const onPath = which('hermes')
  if (onPath) return onPath
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const p = `${slash(env.LOCALAPPDATA)}/hermes/bin/hermes.exe`
    if (exists(p)) return p
  }
  return ''
}

/** Ollama's base URL from OLLAMA_HOST (which may lack a scheme or a port), else the default. */
export function ollamaBase(env) {
  let host = String(env.OLLAMA_HOST ?? '').trim()
  if (!host) return 'http://localhost:11434'
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`
  try {
    const u = new URL(host)
    if (u.hostname === '0.0.0.0') u.hostname = 'localhost'
    if (!u.port) u.port = '11434'
    return `${u.protocol}//${u.host}`
  } catch {
    return 'http://localhost:11434'
  }
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`
const paramsOf = (s) => {
  const m = /([\d.]+)\s*([BM])/i.exec(String(s ?? ''))
  if (!m) return undefined
  return Number(m[1]) / (m[2].toUpperCase() === 'M' ? 1000 : 1)
}

/** Ask Ollama and LM Studio which models they have. Never throws. */
export async function probeLocal({ fetchJson, env }) {
  const servers = []
  const base = ollamaBase(env)
  try {
    const data = await fetchJson(`${base}/api/tags`)
    const models = (Array.isArray(data?.models) ? data.models : []).map((m) => {
      const params = m?.details?.parameter_size
      const size = Number(m?.size)
      const billions = paramsOf(params) ?? paramsOf(m?.name)
      return {
        id: String(m?.name ?? m?.model ?? ''),
        size: Number.isFinite(size) && size > 0 ? size : undefined,
        params: params ? String(params) : undefined,
        small: (billions !== undefined && billions < 14) || (Number.isFinite(size) && size > 0 && size < 8e9),
      }
    })
    servers.push({ kind: 'ollama', name: 'Ollama', base, api: `${base}/v1`, models })
  } catch {
    // not running
  }
  try {
    const data = await fetchJson('http://localhost:1234/v1/models')
    const models = (Array.isArray(data?.data) ? data.data : []).map((m) => {
      const billions = paramsOf(m?.id)
      return { id: String(m?.id ?? ''), small: billions !== undefined && billions < 14 }
    })
    servers.push({ kind: 'lmstudio', name: 'LM Studio', base: 'http://localhost:1234', api: 'http://localhost:1234/v1', models })
  } catch {
    // not running
  }
  return servers
}

/** Merge the wizard's settings into the existing venom.config.json object; other keys stay. */
export function mergeAppConfig(existing, values) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  return { ...base, ...values }
}

/** The one status line about Claude Code (the voice app's engine). */
function claudeLine(status) {
  if (!status.installed) return `[note] Claude Code is not installed (${LINKS.claudeCode}): the talking interface needs it.`
  if (status.signedIn === true) return '[ok] Claude Code is installed and signed in.'
  if (status.signedIn === false) return '[note] Claude Code is installed, but not signed in: run claude once and log in.'
  return '[note] Claude Code is installed; could not tell whether it is signed in. Run claude once to check.'
}

/**
 * Where the two bridge programs live, as hermes-mcp/runner.mjs finds them
 * (its CLAUDE and AGY), read from the wizard's env so the tests can move them.
 * runner.mjs itself is not imported: importing it loads the roster.
 */
export function bridgePaths(env = {}) {
  return {
    claude: env.TEAM_CLAUDE_EXE || (env.USERPROFILE ? `${slash(env.USERPROFILE)}/.local/bin/claude.exe` : ''),
    gemini: env.AGY_EXE || (env.LOCALAPPDATA ? `${slash(env.LOCALAPPDATA)}/agy/bin/agy.exe` : ''),
  }
}

/** The first sentence of a text (a roster problem, for one-line reports). */
export const firstSentence = (text) => String(text ?? '').trim().split(/(?<=[.!?])\s+/)[0]

/**
 * The team question: one yes/no per starter, asked twice at most when every
 * answer is no; then the installed bridges; then what happens to an existing
 * roster file. Enter keeps what is there: with a usable team list, a starter
 * or bridge on it defaults to yes and one not on it to no; with no team list
 * file, starters default to yes and bridges to no. Returns
 * `{ starters, bridges, file, own, keepFile }` or null (stop, exit 1).
 */
async function chooseTeam({ ask, say, sup, env, deps, claudeInstalled }) {
  const shown = (p) => shownPath(p, deps.platform)
  // An existing roster file is never overwritten silently; it also sets the defaults.
  const file = rosterPath(env)
  const managed = new Set([...SPECIALISTS, ...BRIDGE_IDS])
  let onRoster = null // the ids on a usable existing team list
  let own = []
  let problem = null
  if (deps.exists(file)) {
    try {
      const loaded = loadRoster({ file, env, readFile: deps.readFile })
      onRoster = new Set(loaded.agents.map((a) => a.id))
      own = loaded.agents.filter((a) => !managed.has(a.id))
    } catch (err) {
      if (!(err instanceof RosterError)) throw err
      problem = err
    }
  }

  say('', `Your team: the supervisor ${sup} plus the starter agents you choose. You can add your own later with: npm run add-agent`)
  let starters = []
  for (let round = 1; ; round++) {
    starters = []
    for (const a of STARTER_AGENTS) {
      const mode = !onRoster ? 'new' : onRoster.has(a.id) ? 'keep' : 'offer'
      const answer = await ask(Q.agent(a, mode))
      if (mode === 'offer' ? yes(answer) : notNo(answer)) starters.push(a.id)
    }
    if (starters.length) break
    if (round === 2) {
      say('', NO_TEAM_LINE)
      return null
    }
    say('Venom OS needs at least one agent to hand work to, so please say yes to at least one of these four.')
  }

  const paths = bridgePaths(env)
  const installed = {
    claude: claudeInstalled || Boolean(paths.claude && deps.exists(paths.claude)),
    gemini: Boolean(paths.gemini && deps.exists(paths.gemini)),
  }
  const bridges = []
  for (const b of BRIDGE_AGENTS) {
    const keep = Boolean(onRoster?.has(b.id))
    if (installed[b.id]) {
      const answer = await ask(Q.bridge(b, keep))
      if (keep ? notNo(answer) : yes(answer)) bridges.push(b.id)
    } else if (keep) {
      // Not found here, but on the team list: it stays, as everything else there does.
      bridges.push(b.id)
      say(`${b.name} stays on the team, but its program was not found on this PC. npm run agents shows it; npm run remove-agent takes it off.`)
    }
  }

  let keepFile = false
  if (own.length) say(`Your team list ${shown(file)} also has your own agents: ${own.map((a) => a.name).join(', ')}. They stay as they are.`)
  if (problem) {
    say('', `Your team list ${shown(file)} cannot be used:`, ...problem.errors.map((e) => `  - ${e}`))
    if (!yes(await ask(Q.replaceRoster))) {
      keepFile = true
      say('The file stays as it is. Venom OS will not start until it is fixed: edit it, or run npm run setup again and replace it.')
    }
  }
  return { starters, bridges, file, own, keepFile }
}

/** The roster the answers make: chosen starters, chosen bridges, then the person's own agents. */
export function teamRoster({ starters, bridges, own = [] }) {
  return [
    ...STARTER_AGENTS.filter((a) => starters.includes(a.id)).map((a) => ({ ...a })),
    ...BRIDGE_AGENTS.filter((b) => bridges.includes(b.id)).map((b) => ({ ...b })),
    ...own,
  ]
}

/** A file-name stamp from a Date: YYYYMMDD-HHMMSS in local time. */
const stampOf = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ------------------------------------------------------------------ wizard

/**
 * Run the wizard. Returns the exit code.
 *
 * deps: {
 *   platform, env, nodeVersion, repoRoot, kitDir, noAlias, homedir,
 *   log(line), ask(question) -> Promise<string>,
 *   run(cmd, args, { interactive, env, showWindow }) -> Promise<{ code, stdout, stderr }>,
 *   fetchJson(url) -> Promise<object>, fetchText(url) -> Promise<string>,
 *   exists(path), which(name) -> path or '',
 *   readFile(path) -> string, writeFile(path, text), copyFile(src, dest),
 *   mkdir(dir) (recursive), rename(from, to), remove(path) (for the logs
 *   folder and the team list, venom.agents.json or VENOM_ROSTER_FILE),
 *   now() -> Date, nowMs() -> number, randomHex() -> 8 hex characters
 * }
 */
export async function wizard(deps) {
  const { log, ask, run } = deps
  const env = deps.env ?? {}
  const say = (...lines) => lines.forEach((l) => log(l))
  const shown = (p) => shownPath(p, deps.platform)
  const io = { readFile: deps.readFile, writeFile: deps.writeFile }

  say('', 'Venom OS setup: choose the brain for your Hermes agent team.', '')

  // (a) Prerequisites
  const missing = []
  if (!nodeSupported(deps.nodeVersion)) {
    missing.push([`Node.js ${NODE_MIN} or newer (found ${deps.nodeVersion || 'none'})`, `Install it from ${LINKS.node}`])
  } else say(`[ok] Node.js ${deps.nodeVersion}`)
  const chrome = findChrome({ ...deps, env })
  if (!chrome) missing.push(['Google Chrome', `Install it from ${LINKS.chrome}`])
  else say(`[ok] Google Chrome: ${shown(chrome)}`)
  let hermes = findHermes({ ...deps, env })
  if (hermes) say(`[ok] Hermes: ${shown(hermes)}`)
  else if (missing.length || env.HERMES_EXE) {
    missing.push([
      'Hermes Agent',
      ...(env.HERMES_EXE ? [`HERMES_EXE is set to ${shown(env.HERMES_EXE)}, but nothing is there. Fix or remove it.`] : []),
      deps.platform === 'win32' ? `Install it in PowerShell: ${LINKS.hermesWin}` : `Install it: ${LINKS.hermesSh}`,
      `Installation guide: ${LINKS.hermesDocs}`,
      'Then open a new terminal (or set HERMES_EXE to its full path).',
    ])
  }
  if (missing.length) {
    say('')
    for (const [what, ...how] of missing) say(`[missing] ${what}`, ...how.map((h) => `  ${h}`))
    say('', 'Install what is missing, then run `npm run setup` again.')
    return 1
  }
  if (!hermes) {
    say('')
    const installed = await offerInstall({
      platform: deps.platform,
      env,
      ask,
      run,
      log,
      exists: deps.exists,
      which: deps.which,
      findHermes,
      cwd: deps.repoRoot,
    })
    if (installed.status !== 'installed') return 1
    hermes = installed.hermes
  }

  const health = await healthCheck({ hermes, run })
  if (health.ok) say('[ok] Hermes health check passed (hermes doctor).')
  else if (!health.broken && !health.blocking.length) {
    // Notes only (no key yet, optional tools): show them in one block and go on.
    say('', '[ok] Hermes health check (hermes doctor): nothing blocks setup. Notes for later:')
    health.notes.forEach((note) => say(`  - ${note}`))
    say('A model or key that is not set up yet is expected here: the next steps do that.')
  } else {
    say('', "[problem] Hermes's own health check (hermes doctor) reports:")
    if (health.blocking.length) health.blocking.forEach((issue, i) => say(`  ${i + 1}. ${issue}`))
    else say(...String(health.detail || '(no details)').split(/\r?\n/).map((l) => `  ${l}`))
    say('', healthFix(health))
    return 1
  }

  const H = (args, opts) => run(hermes, args, opts)
  const configGet = async (profile, key) => {
    const r = await H(['-p', profile, 'config', 'get', key], {})
    if (r.code !== 0) return ''
    const v = hermesAnswer(r.stdout).split(/\r?\n/).pop()?.trim() ?? ''
    return /^(none|null)$/i.test(v) ? '' : v
  }
  const askQuestion = async (profile, extra = []) => {
    const r = await H(['-p', profile, 'chat', '-q', TEST_QUESTION, '-Q', '--source', 'tool', ...extra], {})
    const answer = hermesAnswer(r.stdout)
    return { ok: r.code === 0 && Boolean(answer), answer, code: r.code, detail: redact(tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim())) }
  }

  // (b) Q1: the brain, then what it means for the voice app
  let family
  say('')
  for (;;) {
    const a = String(await ask(Q.brain)).trim()
    family = FAMILY_BY_CHOICE[a]
    if (family) break
    say('Please type 1, 2, 3 or 4.')
  }
  const fam = FAMILIES[family]

  const claude = await claudeStatus({ run, which: deps.which })
  say('', claudeLine(claude))
  if (family !== 'claude') {
    say(
      `The agent team will use ${fam.label}. The talking interface (the voice app) does not follow that choice: it also needs Claude Code installed and signed in.`,
    )
    if (!notNo(await ask(Q.voiceGo))) {
      say('Stopped. Nothing was changed.')
      return 0
    }
  }

  // (c) How to connect (cloud) or which local server
  let route = 'local'
  let localServers = []
  if (family === 'local') {
    say('')
    localServers = await probeLocal({ fetchJson: deps.fetchJson, env })
    if (!localServers.length) {
      say(
        `No local model server answered (Ollama at ${ollamaBase(env)}, LM Studio at http://localhost:1234).`,
        `Install and start one of them: Ollama ${LINKS.ollama} or LM Studio ${LINKS.lmstudio}`,
        'Download a model in it, then run `npm run setup` again.',
      )
      return 1
    }
    for (const s of localServers) {
      say(`${s.name} is running at ${s.base}. Installed models:`)
      if (!s.models.length) say('  (none yet: download one in the app first)')
      for (const m of s.models) {
        const facts = [m.params, m.size ? `${gb(m.size)} on disk` : ''].filter(Boolean).join(', ')
        say(`  ${m.id}${facts ? ` (${facts})` : ''}${m.small ? '  <- small: expect weak tool use' : ''}`)
      }
    }
    say(
      '',
      'Be aware: the agents depend on tool use (calling functions, reading results, deciding the next step).',
      'A small local model, roughly under 14B parameters or about 8 GB, is weak at that.',
      'A bigger one needs enough RAM or graphics memory (VRAM) to run at a usable speed.',
      'Either way, expect the quality to be below the cloud options.',
    )
  } else {
    route = 'key'
    say(
      '',
      'Two different things: a subscription sign-in uses your plan; API keys are billed per use by the provider, separately from any subscription.',
      `${fam.label}:`,
      ...fam.signIn.lines,
    )
    if (fam.signIn.available) {
      for (;;) {
        const a = String(await ask(Q.access)).trim()
        if (a === '1' || a === '2') {
          route = a === '1' ? 'signin' : 'key'
          break
        }
        say('Please type 1 or 2.')
      }
    }
  }

  const pickLines = () => {
    if (route === 'signin') return [...fam.pickSignIn, "Sign in only inside Hermes's own prompt. This setup never sees it."]
    if (route === 'key') return [...fam.pickKey, 'Hermes finds the key you just saved; you only pick the model.']
    const lines = []
    const ollama = localServers.find((s) => s.kind === 'ollama')
    const lms = localServers.find((s) => s.kind === 'lmstudio')
    if (ollama) {
      lines.push(
        `For Ollama: choose 'Custom endpoint (enter URL manually)', enter ${ollama.api} as the URL`,
        '  (no key is needed; leave it empty if asked) and pick one of the models listed above.',
      )
    }
    if (lms) lines.push("For LM Studio: choose 'LM Studio' and pick one of the models listed above.")
    lines.push("Type your key or sign in only inside Hermes's prompt. This setup never sees it.")
    return lines
  }

  // (d) Q2: the supervisor profile
  let sup
  let supExists = false
  say('')
  for (;;) {
    const a = String(await ask(Q.supervisor)).trim().toLowerCase() || 'venom'
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(a)) {
      say('Use lowercase letters and digits (also - and _), starting with a letter or digit.')
      continue
    }
    if (RESERVED.has(a)) {
      say(`'${a}' is taken (reserved by Hermes or used by one of the four specialist agents). Pick another name.`)
      continue
    }
    const shown = await H(['profile', 'show', a], {})
    if (shown.code === 0) {
      if (yes(await ask(Q.update(a)))) {
        sup = a
        supExists = true
        break
      }
      continue
    }
    sup = a
    break
  }

  // Q2b: the team, asked before anything is created.
  const team = await chooseTeam({ ask, say, sup, env, deps, claudeInstalled: claude.installed })
  if (!team) return 1

  if (!supExists) {
    const created = await H(['profile', 'create', sup, '--description', SUPERVISOR_DESCRIPTION, ...(deps.noAlias ? ['--no-alias'] : [])], {})
    if (created.code !== 0) {
      say(`Could not create profile ${sup}:`, redact(tail(`${created.stdout}\n${created.stderr}`.trim())))
      return 1
    }
    say('', `Created profile ${sup}.`)
  }

  // (e) The API key goes into the profile's .env (key route only). Values
  // stay inside the setup-env helpers; only names and words come back.
  let key
  const editKey = async (replace) => {
    const { envPath, name } = key
    const editor = editorCommand({ platform: deps.platform, env, which: deps.which })
    say(
      '',
      `The key file of profile ${sup}: ${shown(envPath)}`,
      'Your key stays on this PC: in this file and, once the team is created, in the copy Hermes keeps for each agent profile.',
      'This setup never prints, logs or sends it.',
      `No key yet? Create one at ${fam.keyLink}`,
      `The file opens in ${editor.label} ${editor.terminal ? 'in this terminal' : 'in a new window'}.`,
      `Paste your key right after ${name}= (no spaces, no quotes), then save the file and close ${editor.label}.`,
    )
    let first = true
    for (;;) {
      // Only the first preparation makes a backup; later checks compare with it.
      const prepared = prepareEnvFile({
        envPath,
        name,
        ...io,
        exists: deps.exists,
        copyFile: key.backedUp ? () => {} : deps.copyFile,
        now: deps.now,
        replace: first && replace,
      })
      if (!key.backedUp) {
        key.backedUp = true
        key.backupPath = prepared.backupPath
        if (prepared.backupPath) say(`Backup of the file as it was: ${shown(prepared.backupPath)}`)
      }
      first = false
      await openEnvInEditor({
        envPath,
        editor,
        run: (cmd, args, opts) => run(cmd, args, { ...opts, showWindow: true }),
        ask,
        now: deps.nowMs,
        log,
      })
      let tidied = false
      for (;;) {
        const c = checkEnvFile({ envPath, name, backupPath: key.backupPath, ...io })
        if (c.restored.length) say(`The saved file had lost these lines; they were put back from the backup: ${c.restored.join(', ')}`)
        const changed = c.changed.filter((n) => !key.settled.has(n))
        if (changed.length) {
          changed.forEach((n) => key.settled.add(n))
          if (!yes(await ask(Q.keepChanged(changed.join(', '))))) {
            restoreChanged({ envPath, backupPath: key.backupPath, names: changed, ...io })
            say(`Put back as they were: ${changed.join(', ')}`)
          }
        }
        if (c.status === 'ok') {
          say(`[ok] A key is saved for ${name}.`)
          return true
        }
        if (c.status === 'untidy') {
          say(`The ${name} line has ${c.problems.map((p) => PROBLEM_WORDS[p] ?? p).join(', ')}.`)
          if (!tidied && notNo(await ask(Q.tidy))) {
            tidyEnvValue({ envPath, name, ...io })
            tidied = true
            continue
          }
        } else say(`No key was found after ${name}= in the file.`)
        break
      }
      if (notNo(await ask(Q.reopenEnv))) continue
      say('', `Nothing else was changed. When you have the key, run npm run setup again: it opens ${shown(envPath)} for you.`)
      return false
    }
  }

  if (route === 'key') {
    const r = await H(['-p', sup, 'config', 'env-path'], {})
    const envPath = hermesAnswer(r.stdout).split(/\r?\n/).pop()?.trim() ?? ''
    if (r.code !== 0 || !envPath) {
      say(
        '',
        `Could not ask Hermes where profile ${sup} keeps its keys (hermes -p ${sup} config env-path):`,
        redact(tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim())) || `(no output, exit code ${r.code})`,
      )
      return 1
    }
    const variable = await keyVariable({ family, hermes, run, readFile: deps.readFile, exists: deps.exists, fetchText: deps.fetchText })
    say('', `Hermes reads this key from the variable ${variable.name}.`, `  Where that name comes from: ${variable.source}.`)
    key = { envPath, name: variable.name, backupPath: '', backedUp: false, settled: new Set() }
    const filled = deps.exists(envPath) && envValueState(deps.readFile(envPath), variable.name) === 'filled'
    const keep = filled && notNo(await ask(Q.keepKey(variable.name)))
    if (!keep && !(await editKey(filled))) return 1
  }

  const isLocalProvider = async (provider) => {
    for (const k of ['model.base_url', `providers.${provider}.api`, `providers.${provider}.base_url`]) {
      if (LOCALHOST.test(await configGet(sup, k))) return true
    }
    return false
  }

  // The picker, read back, family check, and the one-line test, until it works.
  let brain
  for (;;) {
    say('', `Next, Hermes's own model picker opens for profile ${sup}.`, ...pickLines(), '')
    await H(['-p', sup, 'model'], { interactive: true })
    const provider = await configGet(sup, 'model.provider')
    const model = await configGet(sup, 'model.default')
    if (!provider || !model) {
      say('', 'No model was chosen in the picker, so nothing more was changed.', 'Run `npm run setup` again when you are ready.')
      return 1
    }
    say('', `Profile ${sup} now uses ${provider}/${model}.`)
    let fits = fam.providers.includes(provider)
    if (!fits && family === 'local') fits = await isLocalProvider(provider)
    if (!fits) {
      say(`That is not one of the ${fam.label} providers (${fam.providers.join(', ')}${family === 'local' ? ', or any provider on localhost' : ''}).`)
      if (!yes(await ask(Q.keep(provider, model)))) continue
    }
    say(`Testing it: asking ${sup} "${TEST_QUESTION}" (this can take a minute)...`)
    const t = await askQuestion(sup)
    if (t.ok) {
      say(`[pass] ${sup} answered: ${t.answer}`)
      brain = { provider, model }
      break
    }
    say(`[fail] ${sup} did not answer (exit code ${t.code}). What Hermes printed:`, t.detail || '(nothing)')
    if (route === 'key' && notNo(await ask(Q.reopenKey))) {
      if (!(await editKey(true))) return 1
      continue
    }
    if (notNo(await ask(Q.retryPicker))) continue
    say('', 'Fix the model or sign-in with `hermes -p ' + sup + ' model`, then run `npm run setup` again.')
    return 1
  }

  // (f) Q3: workers, Q4: fallback
  let worker = { ...brain }
  for (;;) {
    const a = String(await ask(Q.worker(brain.model))).trim()
    if (!a || a === brain.model) {
      worker = { ...brain }
      break
    }
    say(`Testing the worker model: asking ${sup} with -m ${a}...`)
    const t = await askQuestion(sup, ['-m', a, '--provider', brain.provider])
    if (t.ok) {
      say(`[pass] ${a} answered: ${t.answer}`)
      worker = { provider: brain.provider, model: a }
      break
    }
    say(`[fail] ${a} did not answer (exit code ${t.code}). What Hermes printed:`, t.detail || '(nothing)')
    if (notNo(await ask(Q.retryWorker))) continue
    say(`The workers will use ${brain.model}.`)
    worker = { ...brain }
    break
  }

  if (yes(await ask(Q.fallback))) {
    say('', `Hermes's picker opens again: choose the provider and model to fall back to.`, '')
    await H(['-p', sup, 'fallback', 'add'], { interactive: true })
  }

  // (g) Apply to the team through the hermes-setup script
  const kitDir = deps.kitDir ?? `${slash(deps.repoRoot)}/hermes-setup`
  const repoPath = slash(deps.repoRoot)
  const scriptEnv = { ...env, HERMES_EXE: hermes }
  const values = {
    supervisor: sup,
    brainModel: brain.model,
    brainProvider: brain.provider,
    workerModel: worker.model,
    workerProvider: worker.provider,
    maxWorkers: '5',
    repoPath,
    cloneFrom: sup,
  }
  let shell
  if (deps.platform === 'win32') {
    const pwsh = deps.which('pwsh')
    const gitBash = [env.ProgramFiles, env['ProgramW6432']]
      .filter(Boolean)
      .map((r) => `${slash(r)}/Git/bin/bash.exe`)
      .find((p) => deps.exists(p))
    if (pwsh) shell = { cmd: pwsh, kind: 'ps1' }
    else if (gitBash) shell = { cmd: gitBash, kind: 'sh' }
  } else {
    const bash = deps.which('bash')
    if (bash) shell = { cmd: bash, kind: 'sh' }
  }
  const logsDir = `${repoPath}/logs`
  const logPath = `${logsDir}/setup-profiles-${stampOf(deps.now())}.log`
  const agentsArg = team.starters.join(',')
  const ps1Args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${kitDir}/create-profiles.ps1`,
    '-Supervisor', values.supervisor, '-Agents', agentsArg,
    '-BrainModel', values.brainModel, '-BrainProvider', values.brainProvider,
    '-WorkerModel', values.workerModel, '-WorkerProvider', values.workerProvider,
    '-MaxWorkers', values.maxWorkers, '-RepoPath', values.repoPath, '-CloneFrom', values.cloneFrom,
    '-Log', shown(logPath),
    '-NoNext',
    ...(deps.noAlias ? ['-NoAlias'] : []),
  ]
  const shArgs = [
    `${kitDir}/create-profiles.sh`,
    '--supervisor', values.supervisor, '--agents', agentsArg,
    '--brain-model', values.brainModel, '--brain-provider', values.brainProvider,
    '--worker-model', values.workerModel, '--worker-provider', values.workerProvider,
    '--max-workers', values.maxWorkers, '--repo-path', values.repoPath, '--clone-from', values.cloneFrom,
    '--log', shown(logPath),
    '--no-next',
    ...(deps.noAlias ? ['--no-alias'] : []),
  ]
  if (!shell) {
    say(
      '',
      'Neither PowerShell 7 (pwsh) nor bash was found, so the team was not created.',
      'Install one of them and run `npm run setup` again, or run by hand:',
      `  pwsh ${ps1Args.slice(4).map((a) => (/^([A-Za-z]:)?\//.test(a) ? shown(a) : a)).join(' ')}`,
    )
    return 1
  }
  deps.mkdir?.(logsDir)
  say('', `Creating the team: ${sup} plus ${team.starters.join(', ')}. One line per agent:`, '')
  const applied = await run(shell.cmd, shell.kind === 'ps1' ? ps1Args : shArgs, { interactive: true, env: scriptEnv })
  if (applied.code !== 0) {
    say(
      '',
      `Creating the team stopped (exit code ${applied.code}). The lines above show the problem; every detail is in ${shown(logPath)}`,
      'Fix that and run `npm run setup` again (it is safe to repeat).',
    )
    return 1
  }
  say('', `[ok] Team created. If you need the details later, they are in ${shown(logPath.slice(repoPath.length + 1))} in this folder.`)

  // The roster file: what the app, the connector and the HUD read.
  const rosterAgents = teamRoster(team)
  let rosterSaved = false
  if (!team.keepFile) {
    try {
      saveRoster(rosterAgents, { file: team.file, env, writeFile: deps.writeFile, rename: deps.rename, mkdir: deps.mkdir, remove: deps.remove })
      rosterSaved = true
      say(`[ok] Team list saved: ${shown(team.file)}`)
    } catch (err) {
      if (!(err instanceof RosterError)) throw err
      say(`[problem] The team list ${shown(team.file)} could not be saved:`, ...err.errors.map((e) => `  - ${e}`))
    }
  }

  say('', 'Testing each agent with the same one-line question...')
  const results = []
  for (const name of team.starters) {
    const t = await askQuestion(name)
    results.push({ name, ok: t.ok })
    if (t.ok) say(`[pass] ${name}: ${t.answer}`)
    else say(`[fail] ${name} (exit code ${t.code}):`, t.detail || '(nothing)', `  Fix: hermes -p ${name} model`)
  }
  if (results.some((r) => !r.ok)) {
    say(
      '',
      `The new profiles were copied from ${sup}, so an API key in its .env carried over.`,
      'Account sign-ins (ChatGPT, Claude account and similar) are stored per profile and are not copied:',
      'run the fix command above for each failed agent and sign in there.',
    )
  }

  // (h) The link test: the supervisor hands one task to an agent through the team connector.
  const agent = results.find((r) => r.ok)?.name ?? team.starters[0]
  say('', `Link test: asking ${sup} to hand one task to ${agent} through the team connector (this can take a minute or two)...`)
  const token = LINK_TOKEN_PREFIX + String(deps.randomHex()).slice(0, 8)
  const link = await linkTest({
    hermes,
    run,
    sup,
    agent,
    repoRoot: deps.repoRoot,
    env,
    readFile: deps.readFile,
    exists: deps.exists,
    token,
    homedir: deps.homedir,
  })
  if (link.ok) say(`[link OK] ${agent} replied: ${link.reply}`)
  else {
    say(`[link FAILED] ${link.note || 'The link test did not complete.'}`)
    if (link.detail) say(...link.detail.split(/\r?\n/).map((l) => `  ${l}`))
    say(`Fix: ${link.fix || `hermes -p ${sup} doctor`}`, 'Then check again with: npm run setup')
  }

  // (i) App settings
  say('')
  const appModel = String(await ask(Q.appModel)).trim()

  const configPath = `${slash(deps.repoRoot)}/venom.config.json`
  let existing = {}
  if (deps.exists(configPath)) {
    try {
      existing = JSON.parse(deps.readFile(configPath))
    } catch {
      say(`${shown(configPath)} is not valid JSON; leaving it alone. Add the settings below by hand.`)
      existing = undefined
    }
  }
  const settings = {
    brain: { family, provider: brain.provider, model: brain.model },
    worker: { provider: worker.provider, model: worker.model },
    supervisorProfile: sup,
    appModel,
  }
  if (existing !== undefined) deps.writeFile(configPath, JSON.stringify(mergeAppConfig(existing, settings), null, 2) + '\n')

  const failed = results.filter((r) => !r.ok).map((r) => r.name)
  const teamFile = rosterSaved
    ? shown(team.file)
    : team.keepFile
      ? `${shown(team.file)} (not changed: fix it before starting Venom OS)`
      : `${shown(team.file)} (not saved, see above)`
  say(
    '',
    'Done.',
    `  Brain (${fam.label}): ${brain.provider}/${brain.model}`,
    `  Workers: ${worker.provider}/${worker.model}`,
    `  Supervisor profile: ${sup}`,
    team.keepFile
      ? '  Team: the team list was left as it is; it needs fixing before Venom OS starts'
      : `  Team: ${rosterAgents.map((a) => a.name).join(', ')}`,
    `  Team list: ${teamFile}`,
    `  Agents tested: ${results.length - failed.length} of ${results.length} passed${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`,
    `  Link test: ${link.ok ? 'passed' : 'FAILED (see above)'}`,
    `  Voice app model: ${appModel || 'your Claude Code default'}`,
    `  Saved in ${existing === undefined ? '(not saved)' : shown(configPath)}`,
    '',
    '1. Start Venom OS: npm start   then open the printed address (http://localhost:5173) in Google Chrome.',
    '2. You should see a ring with the word INITIALISE: click it, allow the microphone and say "Hey Venom".',
    '3. Change the team any time:',
    '   add your own agent: npm run add-agent',
    '   see the team: npm run agents',
    '   remove one: npm run remove-agent',
  )
  return link.ok ? 0 : 1
}
