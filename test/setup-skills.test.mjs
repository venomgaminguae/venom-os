// scripts/setup-skills.mjs: the manifest check, where each profile's skills
// folder is, the copy plan and the whole skills step.
//
// Everything happens in temp folders: a made-up hermes-setup/skills with two
// small skills, and one temp "Hermes home" per profile. `run` is a stub that
// answers `config path` (one test also asks scripts/fake-hermes.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Q_SKILLS, SkillsError, isSafeDirName, planInstall, profileSkillsDir, readManifest, skillsStage } from '../scripts/setup-skills.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = join(ROOT, 'scripts', 'fake-hermes.mjs')
const HERMES = 'hermes-stub'

const MANIFEST = {
  skills: [
    { name: 'note-taking', dir: 'note-taking', source: 'in-house', licence: 'MIT', description: 'Take notes.' },
    { name: 'demo-pack', dir: 'demo-pack', source: 'https://example.org/demo-pack', licence: 'MIT', count: 2, description: 'Two skills.' },
  ],
}

/** A temp world: a source folder with the manifest and two skills, and one home per profile. */
function world({ manifest = MANIFEST, profiles = ['supervisor', 'researcher'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'venom-setup-skills-'))
  const source = join(dir, 'hermes-setup', 'skills')
  mkdirSync(join(source, 'note-taking'), { recursive: true })
  writeFileSync(join(source, 'note-taking', 'SKILL.md'), '---\nname: note-taking\n---\nTake notes.\n')
  for (const s of ['one', 'two']) {
    mkdirSync(join(source, 'demo-pack', 'skills', s), { recursive: true })
    writeFileSync(join(source, 'demo-pack', 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n`)
  }
  if (manifest !== null) writeFileSync(join(source, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  const homes = {}
  for (const p of profiles) homes[p] = join(dir, 'homes', p)
  return { dir, source, homes, profiles }
}

/** A stub `run` answering `hermes -p <name> config path` from the world's homes. */
function stubRun(w) {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    assert.equal(cmd, HERMES)
    const name = args[0] === '-p' ? args[1] : 'default'
    const rest = args[0] === '-p' ? args.slice(2) : args
    assert.deepEqual(rest, ['config', 'path'])
    const home = w.homes[name]
    if (!home) return { code: 1, stdout: '', stderr: `Profile '${name}' does not exist.` }
    return { code: 0, stdout: `${join(home, 'config.yaml')}\n`, stderr: '' }
  }
  return { run, calls }
}

/** Real side effects inside the temp world, plus a log of what was said and asked. */
function deps(w, { answer = '', run, profiles = w.profiles } = {}) {
  const said = []
  const asked = []
  return {
    said,
    asked,
    deps: {
      ask: async (q) => {
        asked.push(q)
        return answer
      },
      say: (...lines) => lines.forEach((l) => said.push(String(l))),
      run: run ?? stubRun(w).run,
      exists: existsSync,
      readFile: (p) => readFileSync(p, 'utf8'),
      copyDir: (from, to) => cpSync(from, to, { recursive: true, errorOnExist: true, force: false }),
      mkdir: (p) => mkdirSync(p, { recursive: true }),
      hermes: HERMES,
      profiles,
      sourceDir: w.source,
      platform: process.platform,
    },
  }
}

// ------------------------------------------------------------------ readManifest

test('readManifest: reads a good list', () => {
  const w = world()
  const m = readManifest({ dir: w.source, readFile: (p) => readFileSync(p, 'utf8') })
  assert.deepEqual(
    m.skills.map((s) => [s.name, s.dir, s.licence, s.count]),
    [
      ['note-taking', 'note-taking', 'MIT', undefined],
      ['demo-pack', 'demo-pack', 'MIT', 2],
    ],
  )
})

test('readManifest: missing file and bad JSON are plain-sentence SkillsErrors', () => {
  const w = world({ manifest: null })
  const read = (p) => readFileSync(p, 'utf8')
  assert.throws(() => readManifest({ dir: w.source, readFile: read }), (e) => e instanceof SkillsError && e.code === 'missing' && /not found/.test(e.message))
  writeFileSync(join(w.source, 'manifest.json'), '{ "skills": [ ')
  assert.throws(() => readManifest({ dir: w.source, readFile: read }), (e) => e instanceof SkillsError && e.code === 'invalid' && /not valid JSON/.test(e.message))
  writeFileSync(join(w.source, 'manifest.json'), '{ "other": [] }')
  assert.throws(() => readManifest({ dir: w.source, readFile: read }), /no "skills" list/)
})

test('readManifest: refuses folder names that are not one plain folder', () => {
  for (const dir of ['../evil', '..', '.', 'a/b', 'a\\b', 'C:evil', 'C:\\evil', '/abs', '.hidden', '', 'a..b', 42, undefined]) {
    assert.equal(isSafeDirName(dir), false, String(dir))
    const readFile = () => JSON.stringify({ skills: [{ name: 'x', dir, source: 'in-house', licence: 'MIT' }] })
    assert.throws(() => readManifest({ dir: 'unused', readFile }), (e) => e instanceof SkillsError && /unsafe folder name/.test(e.message), String(dir))
  }
  const twice = () => JSON.stringify({ skills: [{ name: 'a', dir: 'same' }, { name: 'b', dir: 'Same' }] })
  assert.throws(() => readManifest({ dir: 'unused', readFile: twice }), /a second time/)
  for (const ok of ['briefing-agents', 'agent_skills', 'pack.v2', 'A1']) assert.equal(isSafeDirName(ok), true, ok)
})

// ------------------------------------------------------------------ profileSkillsDir

test('profileSkillsDir: config path folder + skills; -p only for a named profile; "" on failure', async () => {
  const w = world()
  w.homes.default = join(w.dir, 'homes', 'main')
  const { run, calls } = stubRun(w)
  assert.equal(await profileSkillsDir({ run, hermes: HERMES, profile: 'supervisor' }), join(w.homes.supervisor, 'skills'))
  assert.equal(await profileSkillsDir({ run, hermes: HERMES, profile: '' }), join(w.homes.default, 'skills'))
  assert.equal(await profileSkillsDir({ run, hermes: HERMES }), join(w.homes.default, 'skills'))
  assert.deepEqual(calls[0], [HERMES, '-p', 'supervisor', 'config', 'path'])
  assert.deepEqual(calls[1], [HERMES, 'config', 'path'])
  assert.equal(await profileSkillsDir({ run, hermes: HERMES, profile: 'ghost' }), '')
  const throws = async () => {
    throw new Error('spawn ENOENT')
  }
  assert.equal(await profileSkillsDir({ run: throws, hermes: HERMES, profile: 'x' }), '')
  const relative = async () => ({ code: 0, stdout: 'config.yaml\n', stderr: '' })
  assert.equal(await profileSkillsDir({ run: relative, hermes: HERMES, profile: 'x' }), '')
})

test('profileSkillsDir: works against scripts/fake-hermes.mjs for a named profile', async () => {
  const state = mkdtempSync(join(tmpdir(), 'venom-setup-skills-fake-'))
  const env = { ...process.env, FAKE_HERMES_STATE: state }
  const fake = (args) => spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', env })
  assert.equal(fake(['profile', 'create', 'supervisor']).status, 0)
  const run = async (cmd, args) => {
    const r = fake(args)
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  assert.equal(await profileSkillsDir({ run, hermes: 'fake', profile: 'supervisor' }), join(state, 'profiles', 'supervisor', 'skills'))
  assert.equal(await profileSkillsDir({ run, hermes: 'fake', profile: 'nobody' }), '')
})

// ------------------------------------------------------------------ planInstall

test('planInstall: copy what is missing, skip what is already there', () => {
  const manifest = { skills: MANIFEST.skills }
  const target = join('t', 'skills')
  const there = new Set([join(target, 'demo-pack')])
  const plan = planInstall({ manifest, sourceDir: 'src', targetDir: target, exists: (p) => there.has(p) })
  assert.deepEqual(plan, [
    { name: 'note-taking', from: join('src', 'note-taking'), to: join(target, 'note-taking'), action: 'copy' },
    { name: 'demo-pack', from: join('src', 'demo-pack'), to: join(target, 'demo-pack'), action: 'skip' },
  ])
})

test('planInstall: a folder name that would leave the skills folder is refused', () => {
  for (const dir of ['../evil', '..', 'a/../../b', 'C:\\evil']) {
    const manifest = { skills: [{ name: 'evil', dir }] }
    assert.throws(() => planInstall({ manifest, sourceDir: 'src', targetDir: join('t', 'skills'), exists: () => false }), (e) => e instanceof SkillsError && /outside the skills folder/.test(e.message), dir)
  }
})

// ------------------------------------------------------------------ skillsStage

test('skillsStage: copies every skill into every profile, then a second run installs nothing', async () => {
  const w = world()
  const first = deps(w)
  const r = await skillsStage(first.deps)
  assert.equal(r.status, 'done')
  assert.equal(r.installed, 4)
  assert.equal(r.skipped, 0)
  assert.deepEqual(r.notes, [])
  assert.deepEqual(first.asked, [Q_SKILLS])
  assert.ok(first.said.some((l) => /note-taking: made for Venom OS, licence MIT/.test(l)))
  assert.ok(first.said.some((l) => /demo-pack \(2 skills\): from https:\/\/example\.org\/demo-pack, licence MIT/.test(l)))
  assert.ok(first.said.includes('supervisor: 2 installed, 0 already there'))
  assert.ok(first.said.includes('researcher: 2 installed, 0 already there'))
  for (const p of w.profiles) {
    const skills = join(w.homes[p], 'skills')
    assert.ok(existsSync(join(skills, 'note-taking', 'SKILL.md')))
    assert.ok(existsSync(join(skills, 'demo-pack', 'skills', 'two', 'SKILL.md')))
    assert.equal(existsSync(join(skills, 'manifest.json')), false)
  }

  // The person improved a skill: the second run must leave it alone.
  const mine = join(w.homes.supervisor, 'skills', 'note-taking', 'SKILL.md')
  writeFileSync(mine, 'my better version')
  const second = deps(w)
  const r2 = await skillsStage(second.deps)
  assert.equal(r2.status, 'done')
  assert.equal(r2.installed, 0)
  assert.equal(r2.skipped, 4)
  assert.ok(second.said.includes('supervisor: 0 installed, 2 already there'))
  assert.equal(readFileSync(mine, 'utf8'), 'my better version')
})

test('skillsStage: "n" declines and copies nothing', async () => {
  const w = world()
  const d = deps(w, { answer: 'n' })
  const r = await skillsStage(d.deps)
  assert.equal(r.status, 'declined')
  assert.equal(r.installed, 0)
  assert.match(d.said.at(-1), /running npm run setup again/)
  assert.equal(existsSync(join(w.dir, 'homes')), false)
})

test('skillsStage: no folder, no manifest or an empty list is "nothing", without a question', async () => {
  const w = world({ manifest: { skills: [] } })
  for (const sourceDir of [join(w.dir, 'missing'), w.source]) {
    const d = deps(w)
    d.deps.sourceDir = sourceDir
    const r = await skillsStage(d.deps)
    assert.equal(r.status, 'nothing')
    assert.equal(d.said.length, 1)
    assert.deepEqual(d.asked, [])
  }
  const w2 = world({ manifest: null })
  const d2 = deps(w2)
  assert.equal((await skillsStage(d2.deps)).status, 'nothing')
  assert.match(d2.said[0], /no manifest\.json/)
})

test('skillsStage: a profile that cannot be resolved is a note; the others still get their skills', async () => {
  const w = world()
  const d = deps(w, { profiles: ['supervisor', 'ghost', 'researcher'] })
  const r = await skillsStage(d.deps)
  assert.equal(r.status, 'done')
  assert.equal(r.installed, 4)
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0], /^ghost: skipped, .*hermes -p ghost config path failed/)
  assert.deepEqual(
    r.profiles.map((p) => [p.profile, p.installed]),
    [
      ['supervisor', 2],
      ['ghost', 0],
      ['researcher', 2],
    ],
  )
  const none = deps(w, { profiles: ['ghost'] })
  assert.equal((await skillsStage(none.deps)).status, 'failed')
})

test('skillsStage: a copy that throws is a note, not a stop', async () => {
  const w = world()
  const d = deps(w)
  const real = d.deps.copyDir
  d.deps.copyDir = (from, to) => {
    if (to.includes('supervisor') && to.endsWith('demo-pack')) throw new Error('disk full')
    real(from, to)
  }
  const r = await skillsStage(d.deps)
  assert.equal(r.status, 'done')
  assert.equal(r.installed, 3)
  assert.deepEqual(r.notes, ['supervisor: could not copy demo-pack: disk full'])
  assert.ok(d.said.includes('supervisor: 1 installed, 0 already there'))
})

test('skillsStage: a path-escape attempt in the manifest is refused and nothing is written', async () => {
  const evil = { skills: [{ name: 'evil', dir: '../../escaped', source: 'in-house', licence: 'MIT' }] }
  const w = world({ manifest: evil })
  const d = deps(w)
  const r = await skillsStage(d.deps)
  assert.equal(r.status, 'failed')
  assert.match(r.notes[0], /unsafe folder name/)
  assert.deepEqual(d.asked, [])
  assert.equal(existsSync(join(w.dir, 'homes')), false)
  assert.equal(existsSync(join(w.dir, 'escaped')), false)
})

test('skillsStage: a listed folder that is missing is left out with a note', async () => {
  const extra = { skills: [...MANIFEST.skills, { name: 'ghost-skill', dir: 'ghost-skill', source: 'in-house', licence: 'MIT' }] }
  const w = world({ manifest: extra, profiles: ['supervisor'] })
  const d = deps(w)
  const r = await skillsStage(d.deps)
  assert.equal(r.status, 'done')
  assert.equal(r.installed, 2)
  assert.match(r.notes[0], /ghost-skill is listed, but its folder .* is missing/)
})

test('skillsStage: links are never copied or written through', async (t) => {
  const w = world({ profiles: ['supervisor'] })
  const outside = join(w.dir, 'outside')
  mkdirSync(outside)
  try {
    symlinkSync(outside, join(w.source, 'note-taking', 'linked'), 'junction')
  } catch {
    t.skip('this system cannot create links here')
    return
  }
  const d = deps(w)
  const r = await skillsStage(d.deps)
  assert.equal(r.installed, 1)
  assert.match(r.notes[0], /note-taking contains a link/)
  assert.equal(existsSync(join(w.homes.supervisor, 'skills', 'note-taking')), false)

  // A profile whose skills folder is itself a link is skipped.
  const w2 = world({ profiles: ['supervisor'] })
  mkdirSync(w2.homes.supervisor, { recursive: true })
  symlinkSync(outside, join(w2.homes.supervisor, 'skills'), 'junction')
  const d2 = deps(w2)
  const r2 = await skillsStage(d2.deps)
  assert.equal(r2.status, 'failed')
  assert.match(r2.notes[0], /^supervisor: skipped, its skills folder is a link/)
  assert.equal(existsSync(join(outside, 'demo-pack')), false)
})
