/**
 * The team roster as data: `venom.agents.json` in the repo root (or the file
 * named by VENOM_ROSTER_FILE), owned by whoever runs the app. Without that
 * file the four starter agents are used. The connector, the runner, the
 * bridge and scripts/log-run.mjs all read it through hermes-mcp/agents.mjs.
 *
 *   { "agents": [ { "id", "name", "kind", "role", "folder"?, "profile"?, "pinned"? } ] }
 *
 * - id: 2 to 32 characters, lowercase letters, digits, "-" and "_", starting
 *   with a letter; unique; never renamed later (the activity log, the HUD and
 *   the brain all key on it).
 * - name: what the HUD shows and the brain says; one line, at most 40
 *   characters, unique ignoring case.
 * - kind: `specialist` (general jobs), `project` (owns one codebase and runs
 *   inside its folder), `advisor` (read-only second opinion).
 * - role: one line, at most 400 characters. It goes into the `ask_agent` tool
 *   description, so the supervisor picks agents by it.
 * - folder: only for `project` (and required there); a full path, `~/...`,
 *   or a name inside PROJECTS_ROOT. It must exist. Any other kind with a
 *   folder is rejected, so a typo in `kind` cannot silently drop it.
 * - profile: the Hermes profile name, only when it differs from the id.
 * - pinned: true to keep the agent first on the dock and tiles.
 *
 * `claude` (Claude Code CLI) and `gemini` (Antigravity CLI) are optional
 * bridges: roster entries like any other, routed by id in runner.mjs.
 *
 * Importing this has no side effects. Every file operation can be passed in,
 * so the tests never touch a real roster.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROSTER_FILE_NAME = 'venom.agents.json'
/** Above this many agents it still works, but the dock and orbs are untested. */
export const MAX_TESTED_AGENTS = 12
export const ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/
export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const KINDS = ['specialist', 'project', 'advisor']
export const RESERVED_IDS = ['default', 'hermes', 'test', 'tmp', 'root', 'sudo']
export const BRIDGE_IDS = ['claude', 'gemini']
export const MAX_NAME = 40
export const MAX_ROLE = 400

/** The four agents that ship, used when there is no roster file. */
export const STARTER_AGENTS = Object.freeze([
  {
    id: 'researcher',
    name: 'Researcher',
    kind: 'specialist',
    role: 'Web research: finds, compares and verifies information, products, prices, competitors and sources; replies with links.',
    pinned: true,
  },
  {
    id: 'coder',
    name: 'Coder',
    kind: 'specialist',
    role: 'Software: writes, fixes, reviews and runs code and scripts, and verifies the result works.',
    pinned: true,
  },
  {
    id: 'operator',
    name: 'Operator',
    kind: 'specialist',
    role: 'This Windows PC: files and folders, documents, spreadsheets, PDFs, installs and routine tasks.',
  },
  {
    id: 'writer',
    name: 'Writer',
    kind: 'specialist',
    role: 'Writing: drafts emails, posts, product descriptions, documents and replies. Drafts only, never sends.',
  },
].map((a) => Object.freeze(a)))

/** The two optional bridges, offered by the setup wizard when installed. */
export const BRIDGE_AGENTS = Object.freeze([
  {
    id: 'claude',
    name: 'Claude Code',
    kind: 'specialist',
    role: "Claude Code itself, with the owner's plugins, subagents and hooks: larger coding and review jobs that benefit from its planning workflows. Edits files and runs tests inside the projects folder; cannot push, deploy or delete folders. Each run is a Claude Code session the owner can open in the Claude app.",
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'advisor',
    role: "Google's Gemini through Antigravity (the user's Google AI Pro plan): Google Search-grounded research, very long documents, and a second opinion from a different model family. Read-only: it can search and read files but cannot change anything.",
  },
].map((a) => Object.freeze(a)))

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIELDS = ['id', 'name', 'kind', 'role', 'folder', 'profile', 'pinned']

/** A roster that cannot be used. `errors` holds the plain sentences, one per problem. */
export class RosterError extends Error {
  constructor(message, { errors = [], file } = {}) {
    super(message)
    this.name = 'RosterError'
    this.errors = errors
    this.file = file
  }
}

/** The roster file: VENOM_ROSTER_FILE when set, else venom.agents.json in the repo root. */
export function rosterPath(env = process.env) {
  const own = String(env?.VENOM_ROSTER_FILE ?? '').trim()
  return own ? resolve(own) : join(REPO_ROOT, ROSTER_FILE_NAME)
}

/** Where relative project folders live: PROJECTS_ROOT, else ~/Projects (as runner.mjs). */
export function projectsRoot(env = process.env) {
  return env?.PROJECTS_ROOT || join(env?.USERPROFILE ?? env?.HOME ?? '', 'Projects')
}

/** A project folder as an absolute path: absolute stays, `~/x` is under home, `x` is under `root`. */
export function resolveFolder(folder, root = projectsRoot(), home = homedir()) {
  const f = String(folder).trim()
  if (f === '~') return home
  if (/^~[\\/]/.test(f)) return resolve(home, f.slice(2))
  return isAbsolute(f) ? resolve(f) : resolve(root, f)
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const str = (v) => typeof v === 'string'
const oneLine = (s) => !/[\r\n\u2028\u2029]/.test(s)
const quote = (v) => JSON.stringify(String(v))

/**
 * Check a parsed roster. Returns `{ ok, agents, errors, warnings }`: `agents`
 * keeps only the known fields of each entry, `errors` are full sentences that
 * name the entry and say what to change. `exists(path)` checks a project
 * folder (default: it is a directory); `projectsRoot` resolves relative ones.
 */
export function validateRoster(data, { exists = isDir, projectsRoot: root = projectsRoot(), fileName = ROSTER_FILE_NAME, home = homedir() } = {}) {
  const errors = []
  const warnings = []
  const fail = () => ({ ok: false, agents: [], errors, warnings })
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.agents)) {
    errors.push(`${fileName} must hold an object with an "agents" list, like {"agents": [ ... ]}. Fix the file or run \`npm run agents\` to see the team, or \`npm run setup\` to build the list again.`)
    return fail()
  }
  if (!data.agents.length) {
    errors.push(`The "agents" list in ${fileName} is empty. Add at least one agent.`)
    return fail()
  }

  const agents = []
  const ids = new Map()
  const names = new Map()
  data.agents.forEach((a, i) => {
    const n = i + 1
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      errors.push(`Agent ${n} in ${fileName} is not an agent entry. Write each agent as {"id": ..., "name": ..., "kind": ..., "role": ...}.`)
      return
    }
    const label = str(a.id) && a.id.trim() ? quote(a.id) : str(a.name) && a.name.trim() ? quote(a.name) : ''
    const who = `Agent ${n}${label ? ` (${label})` : ''} in ${fileName}`
    const add = (s) => errors.push(`${who} ${s}`)

    if (!str(a.id) || !a.id.trim()) add('has no "id". Add a short lowercase id, such as "analyst".')
    else if (!ID_PATTERN.test(a.id)) add(`has the id ${quote(a.id)}, which is not allowed. Use 2 to 32 lowercase letters, digits, "-" or "_", starting with a letter.`)
    else if (RESERVED_IDS.includes(a.id)) add(`uses the id ${quote(a.id)}, which is reserved. Pick another id.`)
    else if (ids.has(a.id)) add(`uses the id ${quote(a.id)} again (agent ${ids.get(a.id)} has it). Give each agent its own id.`)
    else ids.set(a.id, n)

    if (!str(a.name) || !a.name.trim()) add('has no name. Add a "name", which is what the screen shows and the assistant says.')
    else if (!oneLine(a.name)) add('has a line break in its name. Keep the "name" on one line.')
    else if (a.name.trim().length > MAX_NAME) add(`has a name longer than ${MAX_NAME} characters. Shorten the "name".`)
    else {
      const key = a.name.trim().toLowerCase()
      if (names.has(key)) add(`uses the name ${quote(a.name.trim())} again (agent ${names.get(key)} has it). Give each agent its own name.`)
      else names.set(key, n)
    }

    if (!KINDS.includes(a.kind)) {
      add(`${a.kind === undefined ? 'has no "kind"' : `has the kind ${quote(a.kind)}`}. Set "kind" to "specialist", "project" or "advisor".`)
    }

    if (!str(a.role) || !a.role.trim()) add('has no role. Add a one-line "role" that says what it is for.')
    else if (!oneLine(a.role)) add('has a line break in its role. Keep the "role" on one line.')
    else if (a.role.length > MAX_ROLE) add(`has a role longer than ${MAX_ROLE} characters. Shorten the "role" to one or two sentences.`)

    if (a.kind === 'project') {
      if (!str(a.folder) || !a.folder.trim()) {
        add(`is a project lead but has no "folder". Add the folder of its project: a full path, or a folder name inside ${root}.`)
      } else {
        const abs = resolveFolder(a.folder, root, home)
        if (!exists(abs)) add(`has the folder ${quote(a.folder)}, which does not exist (looked for ${abs}). Create the folder or fix the path.`)
      }
    } else if (a.folder !== undefined && KINDS.includes(a.kind)) {
      add('has a "folder" but is not a project lead. Remove "folder", or set "kind" to "project".')
    }

    if (a.profile !== undefined && (!str(a.profile) || !PROFILE_PATTERN.test(a.profile))) {
      add(`has the profile ${quote(a.profile)}, which is not a Hermes profile name. Use lowercase letters, digits, "-" or "_", or remove "profile" to use the id.`)
    }
    if (a.pinned !== undefined && typeof a.pinned !== 'boolean') add('has a "pinned" that is not true or false. Set it to true or false, or remove it.')

    for (const k of Object.keys(a)) {
      if (!FIELDS.includes(k)) warnings.push(`${who} has an unknown field ${quote(k)}; it is ignored.`)
    }
    const clean = {}
    for (const k of FIELDS) if (a[k] !== undefined) clean[k] = str(a[k]) && k !== 'role' ? a[k].trim() : a[k]
    agents.push(clean)
  })

  if (data.agents.length > MAX_TESTED_AGENTS) {
    warnings.push(`${fileName} lists ${data.agents.length} agents. Up to ${MAX_TESTED_AGENTS} are tested; more work, but the team dock may get crowded.`)
  }
  return errors.length ? fail() : { ok: true, agents, errors, warnings }
}

const howToFix = (file) => `To fix it, edit ${file} or run \`npm run agents\` to see the team, or \`npm run setup\` to build the list again.`

/**
 * The roster to use. No file: the starter agents (source 'starter'). A file
 * that cannot be read or parsed, or whose entries break a rule: throws a
 * RosterError whose message is the plain sentences plus how to fix it.
 */
export function loadRoster({ file, env = process.env, readFile = (p) => readFileSync(p, 'utf8'), exists, projectsRoot: root, home } = {}) {
  const path = file ?? rosterPath(env)
  const name = basename(path)
  let text
  try {
    text = readFile(path)
  } catch (err) {
    if (err?.code === 'ENOENT') return { agents: STARTER_AGENTS.map((a) => ({ ...a })), source: 'starter', file: path, warnings: [] }
    const e = `The team list ${path} cannot be read (${err?.code ?? err?.message ?? err}).`
    throw new RosterError(`${e}\n${howToFix(path)}`, { errors: [e], file: path })
  }
  let data
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''))
  } catch (err) {
    const e = `The team list ${name} is not valid JSON (${err?.message ?? err}). Check for a missing comma, quote or bracket.`
    throw new RosterError(`${e}\n${howToFix(path)}`, { errors: [e], file: path })
  }
  const res = validateRoster(data, { exists, projectsRoot: root ?? projectsRoot(env), fileName: name, ...(home ? { home } : {}) })
  if (!res.ok) throw new RosterError(`${res.errors.join('\n')}\n${howToFix(path)}`, { errors: res.errors, file: path })
  return { agents: res.agents, source: 'file', file: path, warnings: res.warnings }
}

/**
 * Write the roster (validated first; an invalid one is never written) as
 * pretty JSON, atomically: a temp file next to it, then a rename. Returns
 * `{ file, agents, warnings }`.
 */
export function saveRoster(
  agents,
  { file, env = process.env, writeFile = writeFileSync, rename = renameSync, remove = (p) => rmSync(p, { force: true }), mkdir = (d) => mkdirSync(d, { recursive: true }), exists, projectsRoot: root, home } = {},
) {
  const path = file ?? rosterPath(env)
  const res = validateRoster({ agents }, { exists, projectsRoot: root ?? projectsRoot(env), fileName: basename(path), ...(home ? { home } : {}) })
  if (!res.ok) throw new RosterError(`${res.errors.join('\n')}\nNothing was saved.`, { errors: res.errors, file: path })
  mkdir(dirname(path))
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFile(tmp, `${JSON.stringify({ agents: res.agents }, null, 2)}\n`)
    rename(tmp, path)
  } catch (err) {
    try {
      remove(tmp)
    } catch {
      // the temp file may not exist
    }
    throw err
  }
  return { file: path, agents: res.agents, warnings: res.warnings }
}

/** True when a roster file exists (the starter set is in use otherwise). */
export const hasRosterFile = (env = process.env) => existsSync(rosterPath(env))

// ------------------------------------------------------------ pure helpers

/** The ids, in roster order: the connector's `agent` enum. */
export const agentIds = (agents) => agents.map((a) => a.id)

/** One line per agent, as the connector's tool description lists them. */
export const rosterLines = (agents) => agents.map((a) => `- ${a.id}: ${a.role}`).join('\n')

/** { id: absolute folder } for every project lead. */
export function projectDirs(agents, root = projectsRoot()) {
  const out = {}
  for (const a of agents) if (a.kind === 'project' && str(a.folder) && a.folder) out[a.id] = resolveFolder(a.folder, root)
  return out
}

/** { id: profile } only where the Hermes profile differs from the id. */
export function profileIds(agents) {
  const out = {}
  for (const a of agents) if (str(a.profile) && a.profile && a.profile !== a.id) out[a.id] = a.profile
  return out
}

/** The Hermes profile an agent runs on. */
export const profileOf = (agent) => (str(agent.profile) && agent.profile ? agent.profile : agent.id)

/** The pinned ids, in roster order. */
export const pinnedIds = (agents) => agents.filter((a) => a.pinned === true).map((a) => a.id)

/** What the bridge sends the HUD: no folders or profiles; pinned always a boolean. */
export const publicRoster = (agents) =>
  agents.map(({ id, name, role, kind, pinned }) => ({ id, name, role, kind, pinned: pinned === true }))
