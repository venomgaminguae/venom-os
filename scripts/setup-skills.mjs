// The "skills step" of the setup wizard: copy the skills bundled in
// hermes-setup/skills/ into the skills folder of each Hermes profile, so every
// agent of the team can use them.
//
// Where the skills go (read from the Hermes source, release 2026.9.24): each
// profile loads skills from <its home>/skills, searched at any depth for
// SKILL.md (category/skill/SKILL.md and pack/skills/skill/SKILL.md both work).
// A named profile does not see the default profile's skills folder, so every
// profile gets its own copy. `hermes -p <profile> config path` prints
// <its home>/config.yaml, which is how the folder is found without guessing.
//
// Every side effect (running programs, questions, output, files) is injected,
// as in setup-hermes.mjs, so test/setup-skills.test.mjs drives it with temp
// folders and stubs. Nothing is ever overwritten: a skill folder that is
// already there is left alone, because the person or Hermes may have improved
// it. Symlinks are never followed or created, and nothing is written outside
// the resolved skills folder.
import { lstatSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { redact } from './setup-lib.mjs'

export const Q_SKILLS = 'Install these skills into your Hermes profiles? (Y/n)'
export const MANIFEST = 'manifest.json'

/** A plain-sentence problem with the bundled skills (missing or broken list, unsafe folder). */
export class SkillsError extends Error {
  constructor(message, code = 'invalid') {
    super(message)
    this.name = 'SkillsError'
    this.code = code
  }
}

const no = (a) => /^n(o)?$/i.test(String(a ?? '').trim())
const slash = (p) => String(p).replace(/\\/g, '/')

/**
 * Whether `name` is one plain folder name: letters, digits, dot, dash and
 * underscore, starting with a letter or digit. So no slashes, no '..', no
 * drive letters, no hidden folders.
 */
export function isSafeDirName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.includes('..')
}

/**
 * Read and check hermes-setup/skills/manifest.json.
 * @param {{ dir: string, readFile: (path: string) => string | Buffer }} o
 * @returns {{ skills: Array<{ name: string, dir: string, source: string, licence: string, description: string, count?: number }> }}
 * @throws {SkillsError} code 'missing' when the file cannot be read, 'invalid' otherwise
 */
export function readManifest({ dir, readFile }) {
  const file = join(dir, MANIFEST)
  let text
  try {
    text = String(readFile(file))
  } catch {
    throw new SkillsError('The list of bundled skills (hermes-setup/skills/manifest.json) was not found.', 'missing')
  }
  let data
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new SkillsError('The list of bundled skills (hermes-setup/skills/manifest.json) is not valid JSON.')
  }
  if (!data || !Array.isArray(data.skills)) {
    throw new SkillsError('The list of bundled skills (hermes-setup/skills/manifest.json) has no "skills" list.')
  }
  const seen = new Set()
  const skills = data.skills.map((s, i) => {
    const where = `Skill number ${i + 1} in hermes-setup/skills/manifest.json`
    if (!s || typeof s !== 'object') throw new SkillsError(`${where} is not an object.`)
    if (typeof s.name !== 'string' || !s.name.trim()) throw new SkillsError(`${where} has no name.`)
    if (!isSafeDirName(s.dir)) {
      throw new SkillsError(`${where} (${s.name}) has an unsafe folder name: it must be one plain folder name, without slashes or '..'.`)
    }
    const key = s.dir.toLowerCase()
    if (seen.has(key)) throw new SkillsError(`${where} (${s.name}) uses the folder ${s.dir} a second time.`)
    seen.add(key)
    const out = {
      name: s.name.trim(),
      dir: s.dir,
      source: typeof s.source === 'string' ? s.source.trim() : '',
      licence: typeof s.licence === 'string' ? s.licence.trim() : '',
      description: typeof s.description === 'string' ? s.description.trim() : '',
    }
    if (Number.isInteger(s.count) && s.count > 0) out.count = s.count
    return out
  })
  return { skills }
}

/**
 * The skills folder of one Hermes profile: the folder of the file printed by
 * `hermes [-p <profile>] config path`, plus /skills. '' when that fails.
 * @param {{ run: Function, hermes: string, profile?: string }} o
 * @returns {Promise<string>}
 */
export async function profileSkillsDir({ run, hermes, profile }) {
  const args = [...(profile ? ['-p', profile] : []), 'config', 'path']
  let r
  try {
    r = await run(hermes, args, {})
  } catch {
    return ''
  }
  if (r?.code !== 0) return ''
  const line =
    String(r?.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  if (!line || !isAbsolute(line)) return ''
  return join(dirname(line), 'skills')
}

/** Whether `to` is exactly one folder level inside `targetDir`. */
function staysInside(targetDir, to) {
  const rel = relative(resolve(targetDir), resolve(to))
  return Boolean(rel) && !isAbsolute(rel) && !rel.startsWith('..') && !/[\\/]/.test(rel)
}

/**
 * What to copy where. Never overwrites: a skill whose folder is already in
 * `targetDir` is a 'skip'.
 * @param {{ manifest: { skills: Array<{ name: string, dir: string }> }, sourceDir: string, targetDir: string, exists: Function }} o
 * @returns {Array<{ name: string, from: string, to: string, action: 'copy' | 'skip' }>}
 * @throws {SkillsError} when a folder name would leave `targetDir`
 */
export function planInstall({ manifest, sourceDir, targetDir, exists }) {
  return (manifest?.skills ?? []).map((s) => {
    const to = join(targetDir, String(s.dir))
    if (!isSafeDirName(s.dir) || !staysInside(targetDir, to)) {
      throw new SkillsError(`The skill ${s.name} would be copied outside the skills folder, so it is refused.`)
    }
    const from = join(sourceDir, s.dir)
    return { name: s.name, from, to, action: exists(to) ? 'skip' : 'copy' }
  })
}

/** Real lstat check: true for a symlink or a Windows junction, false when missing. */
function defaultIsLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Real read-only walk: the first symlink inside `dir` (never followed), or ''. */
function defaultFindLink(dir) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) return p
      if (e.isDirectory()) stack.push(p)
    }
  }
  return ''
}

/** One short line for the list shown before the question. */
function describe(s) {
  const what = s.count ? `${s.name} (${s.count} skill${s.count === 1 ? '' : 's'})` : s.name
  const from = s.source === 'in-house' || !s.source ? 'made for Venom OS' : `from ${s.source}`
  return `  - ${what}: ${from}${s.licence ? `, licence ${s.licence}` : ''}`
}

/**
 * The skills step. Reads the manifest, shows the list, asks once (Enter =
 * yes), then copies each missing skill folder into every profile's skills
 * folder. A profile that cannot be resolved, or a copy that fails, becomes a
 * note (said at once and returned); the step goes on.
 *
 * Optional extra deps: isLink(path) and findLink(dir) (defaults use lstat and
 * a read-only walk) so symlinks are never followed or created.
 * @param {{ ask: Function, say: Function, run: Function, exists: Function, readFile: Function,
 *   copyDir: Function, mkdir: Function, hermes: string, profiles: string[], sourceDir: string,
 *   platform?: string, isLink?: Function, findLink?: Function }} deps
 * @returns {Promise<{ status: 'done' | 'declined' | 'nothing' | 'failed', installed: number, skipped: number,
 *   profiles: Array<{ profile: string, skillsDir: string, installed: number, skipped: number, ok: boolean }>, notes: string[] }>}
 */
export async function skillsStage(deps) {
  const { ask, say, run, exists, readFile, copyDir, mkdir, hermes, sourceDir } = deps
  const isLink = deps.isLink ?? defaultIsLink
  const findLink = deps.findLink ?? defaultFindLink
  const notes = []
  const note = (line) => {
    notes.push(line)
    say(line)
  }
  const result = (status, more = {}) => ({ status, installed: 0, skipped: 0, profiles: [], notes, ...more })

  let manifest
  try {
    if (!exists(sourceDir)) {
      say('No bundled skills to install (the folder hermes-setup/skills is not there).')
      return result('nothing')
    }
    manifest = readManifest({ dir: sourceDir, readFile })
  } catch (err) {
    if (err instanceof SkillsError && err.code === 'missing') {
      say('No bundled skills to install (hermes-setup/skills has no manifest.json).')
      return result('nothing')
    }
    note(err instanceof SkillsError ? err.message : `The bundled skills could not be read: ${redact(err?.message ?? err)}`)
    return result('failed')
  }

  // Only skill folders that are really there and hold no symlinks.
  const skills = []
  for (const s of manifest.skills) {
    const from = join(sourceDir, s.dir)
    let link = ''
    try {
      link = !exists(from) ? null : isLink(from) ? from : findLink(from)
    } catch (err) {
      note(`The skill ${s.name} could not be read, so it is left out: ${redact(err?.message ?? err)}`)
      continue
    }
    if (link === null) note(`The skill ${s.name} is listed, but its folder hermes-setup/skills/${s.dir} is missing, so it is left out.`)
    else if (link) note(`The skill ${s.name} contains a link (${slash(relative(sourceDir, link))}), so it is left out.`)
    else skills.push(s)
  }
  if (!skills.length) {
    if (!manifest.skills.length) {
      say('No bundled skills to install (the list in hermes-setup/skills/manifest.json is empty).')
      return result('nothing')
    }
    return result('failed')
  }

  say('These skills come with Venom OS:', ...skills.map(describe))
  if (no(await ask(Q_SKILLS))) {
    say('Skills not installed. You can add them later by running npm run setup again.')
    return result('declined')
  }

  const list = deps.profiles?.length ? deps.profiles : ['']
  const done = []
  let installed = 0
  let skipped = 0
  for (const profile of list) {
    const label = profile || 'default'
    const row = { profile: label, skillsDir: '', installed: 0, skipped: 0, ok: false }
    done.push(row)
    const skillsDir = await profileSkillsDir({ run, hermes, profile })
    if (!skillsDir) {
      note(`${label}: skipped, its Hermes folder could not be found (hermes${profile ? ` -p ${profile}` : ''} config path failed).`)
      continue
    }
    row.skillsDir = skillsDir
    if (isLink(skillsDir)) {
      note(`${label}: skipped, its skills folder is a link to another place, so setup does not write into it.`)
      continue
    }
    let plan
    try {
      if (!exists(skillsDir)) mkdir(skillsDir)
      plan = planInstall({ manifest: { skills }, sourceDir, targetDir: skillsDir, exists: (p) => exists(p) || isLink(p) })
    } catch (err) {
      note(`${label}: skipped, ${err instanceof SkillsError ? err.message : redact(err?.message ?? err)}`)
      continue
    }
    row.ok = true
    for (const step of plan) {
      if (step.action === 'skip') {
        row.skipped++
        continue
      }
      try {
        copyDir(step.from, step.to)
        row.installed++
      } catch (err) {
        row.ok = false
        note(`${label}: could not copy ${step.name}: ${redact(err?.message ?? err)}`)
      }
    }
    installed += row.installed
    skipped += row.skipped
    say(`${label}: ${row.installed} installed, ${row.skipped} already there`)
  }

  const anyResolved = done.some((r) => r.skillsDir && (r.installed || r.skipped || r.ok))
  return result(anyResolved ? 'done' : 'failed', { installed, skipped, profiles: done })
}
