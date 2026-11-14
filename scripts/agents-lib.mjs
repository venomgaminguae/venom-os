// The team commands behind `npm run add-agent`, `npm run agents` and
// `npm run remove-agent`. They change the team list (venom.agents.json, only
// through hermes-mcp/roster.mjs) and the Hermes profiles the agents run on.
//
// As in the setup wizard (scripts/setup-lib.mjs), every side effect goes
// through a `deps` object, so test/agents-commands.test.mjs drives these with
// scripted answers against scripts/fake-hermes.mjs:
//   { log(line), ask(question) -> answer, run(cmd, args, opts) -> { code, stdout, stderr },
//     exists(path), which(name), readFile(path), writeFile(path, text), copyFile(src, dest),
//     isDir(path), env, platform, repoRoot, homedir, now() -> Date,
//     rosterFile?, configFile?, templateFile?, noAlias?, quick?, target?, bridgeExe? }
// Each command returns an exit code. Importing this has no side effects.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  BRIDGE_IDS,
  ID_PATTERN,
  MAX_NAME,
  MAX_ROLE,
  MAX_TESTED_AGENTS,
  RESERVED_IDS,
  RosterError,
  loadRoster,
  profileOf,
  projectsRoot,
  resolveFolder,
  rosterPath,
  saveRoster,
} from '../hermes-mcp/roster.mjs'
import { teamRow } from './setup-hermes.mjs'
import { TEST_QUESTION, findHermes, hermesAnswer, redact, shownPath } from './setup-lib.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DEFAULT_SUPERVISOR = 'venom'
const MAX_TRIES = 3
const NEUTRAL_MODEL = 'the model chosen at setup'
export const BRIDGE_LABEL = { claude: 'Claude Code', gemini: 'Antigravity' }

/** The questions, word for word (the tests match on them). */
export const Q = {
  name: `What should the new agent be called? (one line, up to ${MAX_NAME} characters)`,
  job: 'What is its job? Describe it in your own words, in one paragraph (on one line):',
  kind: 'Is it a general specialist, or tied to one project folder? 1) general specialist  2) one project folder  (default 1)',
  folder: (root) => `Which folder? A full path, ~/..., or the name of a folder inside ${root}:`,
  id: 'Type a short id for it (2 to 32 lowercase letters, digits, - or _, starting with a letter):',
  recreate: 'Create its Hermes profile now, with a new job brief? (y/N)',
  replace: "Replace that agent's entry and job brief? (y/N)",
  existing:
    'What do you want to do? 1) add it to the team as it is (keep its job brief)  2) replace its job brief (the old one is kept as a backup)  3) cancel  (default 3)',
  which: 'Which agent do you want to remove? Type its id or its name:',
  remove: (name) => `Remove ${name} from the team? (y/N)`,
  deleteProfile: (p) => `Also delete its Hermes profile ${p}, with its memory and skills? This cannot be undone. (y/N)`,
}

const yes = (a) => /^y(es)?$/i.test(String(a ?? '').trim())
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const tail = (s, n = 1500) => (s.length > n ? '...' + s.slice(-n) : s)
const detailOf = (r) => redact(tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim())) || '(no output)'
const restart = (what) => `Restart Venom OS (close it and run \`npm start\`) so ${what}.`
const pad2 = (n) => String(n).padStart(2, '0')

/** A file-name stamp from a Date: year, month, day, a dash, hour, minute, second. */
export function stamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/** A safe id from a name, or '' when none can be made (then the person is asked). */
export function deriveId(name) {
  const id = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return ID_PATTERN.test(id) ? id : ''
}

/** The roster's one-line role from the person's paragraph; project leads get a prefix. */
export function roleLine(text, { name, folder } = {}) {
  let prefix = folder ? `${name}, project lead for the code in ${folder}: ` : ''
  if (MAX_ROLE - prefix.length < 80) prefix = folder ? `${name}, project lead: ` : ''
  const room = MAX_ROLE - prefix.length
  let body = oneLine(text)
  if (body.length > room) {
    const cut = body.slice(0, room)
    const sentences = /^.*[.!?](?=\s|$)/.exec(cut)?.[0] ?? ''
    body = sentences.length >= 20 ? sentences : `${cut.slice(0, room - 3).replace(/\s+\S*$/, '')}...`
  }
  return prefix + body
}

/** agent.SOUL.md with its placeholders filled. */
export function fillSoul(template, { name, job, folder, config = {} }) {
  const eol = template.includes('\r\n') ? '\r\n' : '\n'
  const section = folder
    ? [
        '',
        '## Your project folder',
        `You are the project lead for the code in \`${folder}\`. You work inside that folder: its files, its tests and its own instruction file (CLAUDE.md or README.md).`,
        "Never push, publish or deploy anything without the owner's go-ahead.",
        '',
      ].join(eol)
    : ''
  const values = {
    AGENT_NAME: name,
    AGENT_JOB: job,
    PROJECT_FOLDER_SECTION: section,
    BRAIN_MODEL: config?.brain?.model || NEUTRAL_MODEL,
    WORKER_MODEL: config?.worker?.model || config?.brain?.model || NEUTRAL_MODEL,
    MAX_WORKERS: String(config?.maxWorkers || 5),
    BROWSER: config?.browser || 'your default web browser',
    NOTES_DIR: config?.notesDir || '~/venom-notes',
    MARKET: config?.market || 'your own country, in its currency',
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => values[k] ?? m)
}

/** Lines of an aligned table (two spaces between columns). */
export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)))
  return rows.map((r) => r.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd())
}

const defaultIsDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** What all three commands share: settings, the roster, and Hermes calls. */
function context(deps) {
  const env = deps.env ?? {}
  const say = (...lines) => lines.forEach((l) => deps.log(l))
  const shown = (p) => shownPath(p, deps.platform ?? process.platform)
  const repoRoot = deps.repoRoot ?? REPO_ROOT
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  const root = projectsRoot(env)
  const home = deps.homedir ?? homedir()
  const isDir = deps.isDir ?? defaultIsDir
  const file = deps.rosterFile ?? rosterPath(env)
  const rosterOpts = { file, env, projectsRoot: root, home, exists: isDir }
  let config = {}
  try {
    config = JSON.parse(String(readFile(deps.configFile ?? join(repoRoot, 'venom.config.json'))).replace(/^\uFEFF/, '')) ?? {}
  } catch {
    config = {}
  }
  const sup = String(config.supervisorProfile || DEFAULT_SUPERVISOR)
  let hermes
  const c = {
    env,
    say,
    shown,
    root,
    home,
    isDir,
    file,
    config,
    sup,
    readFile,
    rosterOpts,
    hermes() {
      if (hermes === undefined) hermes = findHermes({ platform: deps.platform ?? process.platform, env, exists: deps.exists, which: deps.which ?? (() => '') })
      return hermes
    },
    H: (args, opts = {}) => deps.run(c.hermes(), args, opts),
    async profileExists(p) {
      return (await c.H(['profile', 'show', p])).code === 0
    },
    async profileDir(p) {
      const r = await c.H(['-p', p, 'config', 'path'])
      if (r.code !== 0) return ''
      const line = String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? ''
      return line ? dirname(line) : ''
    },
    async askReady(p) {
      const r = await c.H(['-p', p, 'chat', '-q', TEST_QUESTION, '-Q', '--source', 'tool'])
      const answer = hermesAnswer(r.stdout)
      return { ok: r.code === 0 && Boolean(answer), answer, code: r.code, detail: detailOf(r) }
    },
    loadTeam() {
      try {
        return loadRoster(rosterOpts)
      } catch (err) {
        if (!(err instanceof RosterError)) {
          say(`The team list ${shown(file)} cannot be used: ${err?.message ?? err}`, 'Nothing was changed.')
          return null
        }
        say('', 'The team list cannot be used:', ...err.errors.map((e) => `  ${e}`))
        say(`Edit ${shown(err.file)} to fix it (or rename it to go back to the starter team), then try again. Nothing was changed.`)
        return null
      }
    },
    noHermes() {
      say(
        env.HERMES_EXE
          ? `HERMES_EXE is set to ${shown(env.HERMES_EXE)}, but nothing is there. Fix or remove it, then try again.`
          : 'Hermes was not found on this PC. Run `npm run setup` first: it installs Hermes and sets up the team.',
      )
      return 1
    },
  }
  return c
}

// ------------------------------------------------------------------ add

/** `npm run add-agent`: a new agent on the team, with its own Hermes profile and job brief. */
export async function addAgent(deps) {
  const c = context(deps)
  const { say } = c
  const ask = async (q) => String((await deps.ask(q)) ?? '')
  const giveUp = () => {
    say('That did not work after 3 tries, so I stopped. Nothing was changed.')
    return 1
  }
  say('', 'Add an agent to your Venom OS team.', '')

  if (!c.hermes()) return c.noHermes()
  if (!(await c.profileExists(c.sup))) {
    say(`The supervisor profile ${c.sup} does not exist yet, so there is nothing to copy the new agent from. Run \`npm run setup\` first, then try again.`)
    return 1
  }
  const team = c.loadTeam()
  if (!team) return 1
  const agents = team.agents

  // The name (and an agent whose profile went missing may be rebuilt).
  let name
  let target
  for (let i = 0; !name; i++) {
    if (i === MAX_TRIES) return giveUp()
    const a = oneLine(await ask(Q.name))
    if (!a) say('Type a name, such as Analyst.')
    else if (a.length > MAX_NAME) say(`That name has ${a.length} characters; use at most ${MAX_NAME}.`)
    else {
      const same = agents.find((x) => x.name.toLowerCase() === a.toLowerCase())
      if (!same) name = a
      else if (!BRIDGE_IDS.includes(same.id) && !(await c.profileExists(profileOf(same)))) {
        say(`${same.name} is already on the team, but its Hermes profile ${profileOf(same)} is missing.`)
        if (!yes(await ask(Q.recreate))) {
          say('Nothing was changed.')
          return 0
        }
        name = same.name
        target = same
      } else say(`There is already an agent called ${same.name}. Pick another name, or remove that one first with \`npm run remove-agent\`.`)
    }
  }

  let job
  for (let i = 0; !job; i++) {
    if (i === MAX_TRIES) return giveUp()
    job = oneLine(await ask(Q.job))
    if (!job) say('Describe its job in a sentence or more, on one line.')
  }

  const kind = /^\s*(2|p)/i.test(await ask(Q.kind)) ? 'project' : 'specialist'
  let folder
  if (kind === 'project') {
    for (let i = 0; !folder; i++) {
      if (i === MAX_TRIES) return giveUp()
      const a = String(await ask(Q.folder(c.shown(c.root)))).trim().replace(/^"(.*)"$/, '$1')
      if (!a) {
        say('Type the folder of the project.')
        continue
      }
      const abs = resolveFolder(a, c.root, c.home)
      if (c.isDir(abs)) folder = a
      else say(`There is no folder at ${c.shown(abs)}. Check the spelling, or create the folder first.`)
    }
  }

  // The id.
  let id = target?.id ?? ''
  if (!target) {
    id = deriveId(name)
    let tries = 0
    for (;;) {
      if (!id) {
        if (tries++ === MAX_TRIES) return giveUp()
        id = String(await ask(Q.id)).trim().toLowerCase()
        if (!ID_PATTERN.test(id)) {
          say('That id does not fit: use 2 to 32 lowercase letters, digits, - or _, starting with a letter.')
          id = ''
          continue
        }
      }
      const why = RESERVED_IDS.includes(id)
        ? 'reserved by Hermes'
        : BRIDGE_IDS.includes(id)
          ? `kept for the ${BRIDGE_LABEL[id]} bridge`
          : id === c.sup
            ? 'the name of the supervisor profile'
            : ''
      if (!why) break
      say(`The id "${id}" cannot be used: it is ${why}. Pick another id.`)
      id = ''
    }
    say(`Its id is "${id}": the name of its Hermes profile, and how the team list and the activity log refer to it. It never changes.`)
    const holder = agents.find((x) => x.id === id)
    if (holder) {
      say(`The id "${id}" already belongs to ${holder.name} on the team.`)
      if (!yes(await ask(Q.replace))) {
        say('Nothing was changed.')
        return 0
      }
      target = holder
    }
  }

  const profile = target ? profileOf(target) : id
  let exists = await c.profileExists(profile)
  let mode = 'brief' // write the job brief; 'keep' leaves the profile as it is
  if (!target && exists) {
    say(`A Hermes profile called ${profile} already exists, but it is not on the team.`)
    const a = String(await ask(Q.existing)).trim()
    if (a === '1') mode = 'keep'
    else if (a !== '2') {
      say('Cancelled. Nothing was changed.')
      return 0
    }
  }

  const role = roleLine(job, { name, folder })
  const entry = { id, name, kind, role, ...(folder ? { folder } : {}), ...(profile !== id ? { profile } : {}), ...(target?.pinned ? { pinned: true } : {}) }

  let created = false
  if (!exists) {
    say('', `Creating the Hermes profile ${profile}, copied from ${c.sup}...`)
    const r = await c.H(['profile', 'create', profile, '--clone-from', c.sup, '--description', role, ...(deps.noAlias ? ['--no-alias'] : [])])
    if (r.code !== 0) {
      say(`Hermes could not create the profile ${profile}:`, `  ${detailOf(r)}`, 'Nothing was changed.')
      return 1
    }
    created = true
    exists = true
  }

  if (mode === 'brief') {
    try {
      const dir = await c.profileDir(profile)
      if (!dir) throw new Error(`Hermes did not say where the profile ${profile} is`)
      const soulFile = join(dir, 'SOUL.md')
      const text = fillSoul(c.readFile(deps.templateFile ?? join(deps.repoRoot ?? REPO_ROOT, 'hermes-setup', 'souls', 'agent.SOUL.md')), {
        name,
        job,
        folder,
        config: c.config,
      })
      if (!created && deps.exists(soulFile)) {
        const bak = `${soulFile}.bak-${stamp(deps.now ? deps.now() : new Date())}`
        ;(deps.copyFile ?? copyFileSync)(soulFile, bak)
        say(`The old job brief is kept as ${c.shown(bak)}`)
      }
      deps.writeFile(soulFile, text)
      say(`Wrote its job brief: ${c.shown(soulFile)}`)
    } catch (err) {
      say(
        '',
        `The job brief could not be written (${err?.message ?? err}).`,
        created ? `The Hermes profile ${profile} now exists, but ${name} is not on the team: the team list was not changed.` : 'The team list was not changed.',
        `To finish, run \`npm run add-agent\` again with the same name and choose 2 (replace its job brief).${created ? ` To undo instead, run: hermes profile delete ${profile}` : ''}`,
      )
      return 1
    }
    // Only the supervisor hands out work: a copied `team` connector goes.
    const m = await c.H(['-p', profile, 'mcp', 'list'])
    if (m.code === 0 && teamRow(m.stdout).listed) {
      const rm = await c.H(['-p', profile, 'mcp', 'remove', 'team'])
      if (rm.code === 0) say(`Removed the team connector copied from ${c.sup} (only the supervisor hands out work).`)
      else say(`Note: ${profile} still has the team connector copied from ${c.sup}. Remove it with: hermes -p ${profile} mcp remove team`)
    }
  }

  const next = target ? agents.map((x) => (x.id === target.id ? entry : x)) : [...agents, entry]
  try {
    saveRoster(next, c.rosterOpts)
  } catch (err) {
    say(
      '',
      `The team list ${c.shown(c.file)} could not be saved:`,
      ...(err?.errors?.length ? err.errors : [String(err?.message ?? err)]).map((l) => `  ${l}`),
      `The Hermes profile ${profile} and its job brief exist, but ${name} is not on the team yet.`,
      `To finish, run \`npm run add-agent\` again with the same name and choose 1 (add it as it is). To undo instead, run: hermes profile delete ${profile}`,
    )
    return 1
  }
  say('', `${name} is on the team (saved in ${c.shown(c.file)}).`)
  if (team.source === 'starter') say('There was no team list file yet, so it now holds the starter agents plus the new one.')

  if (created) {
    say(
      '',
      `${profile} was copied from ${c.sup}, so any API key in the settings of ${c.sup} carried over to it.`,
      `A subscription sign-in (ChatGPT, Claude account and similar) is stored per profile and is not copied. If ${c.sup} uses one, sign in again with: hermes -p ${profile} model`,
    )
  }

  say('', `Asking ${name} the one-line test question...`)
  const t = await c.askReady(profile)
  if (t.ok) say(`[pass] ${name} answered: ${t.answer}`)
  else {
    say(
      `[fail] ${name} did not answer (exit code ${t.code}):`,
      `  ${t.detail}`,
      `${name} stays on the team. Sign it in with: hermes -p ${profile} model`,
      'Then check it with: npm run agents',
    )
  }

  if (next.length > MAX_TESTED_AGENTS) {
    say('', `The team now has ${next.length} agents. Up to ${MAX_TESTED_AGENTS} are tested; more work, but the team dock may get crowded.`)
  }
  say('', restart(`${name} appears`))
  return 0
}

// ------------------------------------------------------------------ list

/** `npm run agents`: the team as a table, each agent's profile and whether it answers. */
export async function listAgents(deps) {
  const c = context(deps)
  const { say } = c
  const team = c.loadTeam()
  if (!team) return 1
  const hermes = c.hermes()
  const bridgeExe = deps.bridgeExe ?? {}
  const rows = [['ID', 'NAME', 'KIND', 'RUNS ON', 'PROFILE', 'ANSWERS']]
  const problems = []
  if (hermes && !deps.quick) say('', 'Asking each agent the one-line test question, one after another (add -- --quick to skip this)...')
  for (const a of team.agents) {
    if (BRIDGE_IDS.includes(a.id)) {
      const exe = bridgeExe[a.id] ?? ''
      const installed = Boolean(exe) && deps.exists(exe)
      rows.push([a.id, a.name, a.kind, BRIDGE_LABEL[a.id], installed ? 'installed' : 'not installed', '-'])
      if (!installed) {
        problems.push(`${a.name} needs ${BRIDGE_LABEL[a.id]}, which is not installed here${exe ? ` (looked for ${c.shown(exe)})` : ''}. Install it, or take ${a.name} off the team with \`npm run remove-agent\`.`)
      }
      continue
    }
    const p = profileOf(a)
    if (!hermes) {
      rows.push([a.id, a.name, a.kind, p, 'unknown', '-'])
      continue
    }
    const there = await c.profileExists(p)
    let answers = '-'
    if (!there) {
      problems.push(`${a.name}: its Hermes profile ${p} is missing. Create it with \`npm run add-agent\` (type the same name, ${a.name}), or take it off the team with \`npm run remove-agent\`.`)
    } else if (!deps.quick) {
      const t = await c.askReady(p)
      answers = t.ok ? 'yes' : 'no'
      if (!t.ok) problems.push(`${a.name} did not answer the test question. Sign it in with: hermes -p ${p} model`)
    }
    rows.push([a.id, a.name, a.kind, p, there ? 'exists' : 'missing', answers])
  }
  say('', `The team (${team.agents.length} agent${team.agents.length === 1 ? '' : 's'}):`, '', ...table(rows).map((l) => `  ${l}`), '')
  if (!hermes) say('Hermes was not found, so the profiles could not be checked. Run `npm run setup` first.')
  if (problems.length) say('To fix:', ...problems.map((p) => `- ${p}`))
  else if (hermes) say(deps.quick ? 'No problems found (the agents were not asked: run without --quick for that).' : 'No problems found.')
  for (const w of team.warnings) say(`Note: ${w}`)
  if (team.agents.length > MAX_TESTED_AGENTS) say(`Note: up to ${MAX_TESTED_AGENTS} agents are tested; more work, but the team dock may get crowded.`)
  say(
    '',
    team.source === 'file'
      ? `The team list is stored in ${c.shown(team.file)}`
      : `No team list file exists yet, so the starter team is in use. It is created at ${c.shown(team.file)} when you add or remove an agent.`,
  )
  return 0
}

// ------------------------------------------------------------------ remove

/** `npm run remove-agent [id]`: an agent off the team; its Hermes profile only on a separate yes. */
export async function removeAgent(deps) {
  const c = context(deps)
  const { say } = c
  const team = c.loadTeam()
  if (!team) return 1
  const agents = team.agents
  const w = Math.max(...agents.map((a) => a.id.length))
  say('', 'The team:', ...agents.map((a) => `  ${a.id.padEnd(w)}  ${a.name}`), '')

  const pick = String(deps.target ?? '').trim() || String((await deps.ask(Q.which)) ?? '').trim()
  const key = pick.toLowerCase()
  const a = agents.find((x) => x.id === key) ?? agents.find((x) => x.name.toLowerCase() === key)
  if (!a) {
    say(pick ? `There is no agent "${pick}" on the team. Nothing was changed.` : 'No agent was chosen. Nothing was changed.', 'Run `npm run agents` to see the team.')
    return 1
  }
  if (agents.length === 1) {
    say(`${a.name} is the only agent on the team, and the team needs at least one, so it stays. Nothing was changed.`)
    return 1
  }
  if (!yes(await deps.ask(Q.remove(a.name)))) {
    say('Nothing was changed.')
    return 0
  }
  try {
    saveRoster(
      agents.filter((x) => x !== a),
      c.rosterOpts,
    )
  } catch (err) {
    say(`The team list ${c.shown(c.file)} could not be saved:`, ...(err?.errors?.length ? err.errors : [String(err?.message ?? err)]).map((l) => `  ${l}`), 'Nothing was changed.')
    return 1
  }
  say(`${a.name} is off the team (saved in ${c.shown(c.file)}).`)
  if (team.source === 'starter') say('There was no team list file yet, so it now holds the remaining starter agents.')

  if (!BRIDGE_IDS.includes(a.id) && c.hermes()) {
    const p = profileOf(a)
    if (p !== c.sup && (await c.profileExists(p))) {
      if (yes(await deps.ask(Q.deleteProfile(p)))) {
        const r = await c.H(['profile', 'delete', p, '--yes'])
        if (r.code === 0) say(`Deleted the Hermes profile ${p}.`)
        else say(`Hermes could not delete the profile ${p}:`, `  ${detailOf(r)}`, `${a.name} is off the team anyway. To delete the profile later, run: hermes profile delete ${p}`)
      } else say(`Its Hermes profile ${p} was kept, with its memory and skills. To delete it later, run: hermes profile delete ${p}`)
    }
  }
  say('', restart('the change appears'))
  return 0
}

// ------------------------------------------------------------------ real deps

function which(name) {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true })
    if (res.status !== 0 || !res.stdout) return ''
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    return lines.find((l) => /\.(exe|com)$/i.test(l)) ?? lines[0] ?? ''
  } catch {
    return ''
  }
}

function run(cmd, args, { interactive = false, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'], env: env ?? process.env, windowsHide: !interactive })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(`${question} `)
  } finally {
    rl.close()
  }
}

/** The real side effects, for the three CLIs. */
export function realDeps(extra = {}) {
  return {
    platform: process.platform,
    env: process.env,
    repoRoot: REPO_ROOT,
    log: (l) => console.log(l),
    ask,
    run,
    which,
    exists: (p) => existsSync(p),
    isDir: defaultIsDir,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, text) => writeFileSync(p, text),
    copyFile: (src, dest) => copyFileSync(src, dest),
    now: () => new Date(),
    homedir: homedir(),
    ...extra,
  }
}
