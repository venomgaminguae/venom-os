// The ".env step" of the setup wizard (scripts/setup-env.mjs) and the stand-in
// editor scripts/fake-editor.mjs.
//
// Nothing here runs the real hermes, reads a real .env or opens a window:
// every file lives in a fresh temp folder, Hermes's --version output and docs
// are stubs, and every "editor" is scripts/fake-editor.mjs run through node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENV_DOCS_RAW_URL,
  ENV_DOCS_URL,
  ENV_HINT,
  ENV_Q_DONE,
  KEY_FALLBACK,
  KEY_PROVIDER,
  checkEnvFile,
  editorCommand,
  envValueState,
  keyVariable,
  openEnvInEditor,
  parseEnv,
  prepareEnvFile,
  restoreChanged,
  tidyEnvValue,
} from '../scripts/setup-env.mjs'

const FAKE_EDITOR = fileURLToPath(new URL('../scripts/fake-editor.mjs', import.meta.url))
// Built at run time so no key-shaped literal sits in the repository.
const FAKE_KEY = 's' + 'k-ant-' + ['FAKEab12CD34', 'ef56GH78ij90KL'].join('')
const OTHER = {
  OPENAI_API_KEY: 's' + 'k-proj-' + ['OTHERa1', 'b2c3d4e5f6'].join(''),
  GOOGLE_API_KEY: 'AI' + 'za' + ['FAKEOTHER', 'zyxwvutsrq'].join(''),
  TELEGRAM_BOT_TOKEN: ['12345', 'FAKEtokenXYZ'].join(':'),
}
const OTHER_LINES = Object.entries(OTHER).map(([k, v]) => `${k}=${v}`)
const NAME = 'ANTHROPIC_API_KEY'

const tmp = () => mkdtempSync(join(tmpdir(), 'venom-env-'))
const read = (p) => readFileSync(p, 'utf8')
const fsDeps = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, t) => writeFileSync(p, t),
  exists: (p) => existsSync(p),
  copyFile: (a, b) => copyFileSync(a, b),
}
const fixedNow = () => new Date(2026, 10, 14, 9, 5, 7)
const STAMP = ['2026', '1114'].join('') + '-' + ['0905', '07'].join('')

/** Run the real fake editor on a file. */
function fakeEdit(file, mode, extra = {}) {
  const r = spawnSync(process.execPath, [FAKE_EDITOR, file], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_EDITOR_MODE: mode, FAKE_EDITOR_KEY: FAKE_KEY, ...extra },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  return r
}

// ------------------------------------------------------------ keyVariable

const AUTH_PY = [
  'PROVIDERS = [',
  '    ("openai-api", "OpenAI API", "https://api.openai.com/v1", ("OPENAI_API_KEY",), "OPENAI_BASE_URL"),',
  '    ("gemini", "Google AI Studio", "https://generativelanguage.googleapis.com/v1beta",',
  '     ("GOOGLE_API_KEY", "GEMINI_API_KEY"), "GEMINI_BASE_URL"),',
  '    ("anthropic", "Anthropic", "https://api.anthropic.com",',
  '     ("ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"), "ANTHROPIC_BASE_URL"),',
  ']',
  '',
].join('\n')

const DOCS_MD = [
  '| Variable | Description |',
  '|---|---|',
  '| `OPENAI_API_KEY` | OpenAI API key (`openai-api` provider), or a compatible key |',
  '| `ANTHROPIC_API_KEY` | Anthropic Console API key ([console.anthropic.com](https://console.anthropic.com)) |',
  '| `GEMINI_API_KEY` | Alias for `GOOGLE_API_KEY` (Google AI Studio API key) |',
  '| `GOOGLE_API_KEY` | Google AI Studio API key ([aistudio.google.com](https://aistudio.google.com)) |',
  '',
].join('\n')

function fakeInstall() {
  const dir = tmp()
  mkdirSync(join(dir, 'hermes_cli'))
  writeFileSync(join(dir, 'hermes_cli', 'auth.py'), AUTH_PY)
  return dir
}
const runVersion = (dir) => async (cmd, args) => {
  assert.equal(cmd, 'HERMES')
  assert.deepEqual(args, ['--version'])
  return { code: 0, stdout: `Hermes Agent v1.2.3\n${dir ? `Install directory: ${dir}\n` : ''}`, stderr: '' }
}

test('keyVariable reads the first name of the provider row from the installed Hermes source', async () => {
  const dir = fakeInstall()
  const want = { gpt: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', gemini: 'GOOGLE_API_KEY' }
  for (const family of Object.keys(KEY_PROVIDER)) {
    const r = await keyVariable({
      family,
      hermes: 'HERMES',
      run: runVersion(dir),
      ...fsDeps,
      fetchText: async () => assert.fail('docs should not be fetched'),
    })
    assert.equal(r.name, want[family])
    assert.equal(r.source, `Hermes's own provider list (${dir}/hermes_cli/auth.py)`)
  }
})

test('keyVariable falls back to the docs when there is no install dir or no auth.py', async () => {
  const urls = []
  const fetchText = async (u) => {
    urls.push(u)
    return DOCS_MD
  }
  const want = { gpt: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', gemini: 'GOOGLE_API_KEY' }
  for (const family of Object.keys(KEY_PROVIDER)) {
    const r = await keyVariable({ family, hermes: 'HERMES', run: runVersion(''), ...fsDeps, fetchText })
    assert.equal(r.name, want[family])
    assert.equal(r.source, `Hermes's documentation (${ENV_DOCS_URL})`)
  }
  const empty = tmp()
  const r = await keyVariable({ family: 'claude', hermes: 'HERMES', run: runVersion(empty), ...fsDeps, fetchText })
  assert.equal(r.name, 'ANTHROPIC_API_KEY')
  assert.match(r.source, /documentation/)
  assert.ok(urls.every((u) => u === ENV_DOCS_RAW_URL))
  // run throwing is survived too
  const thrown = await keyVariable({
    family: 'gpt',
    hermes: 'HERMES',
    run: async () => {
      throw new Error('spawn failed')
    },
    ...fsDeps,
    fetchText,
  })
  assert.equal(thrown.name, 'OPENAI_API_KEY')
})

test('keyVariable falls back to the built-in list when the docs cannot be fetched', async () => {
  for (const family of Object.keys(KEY_PROVIDER)) {
    const r = await keyVariable({
      family,
      hermes: 'HERMES',
      run: runVersion(''),
      ...fsDeps,
      fetchText: async () => {
        throw new Error('offline')
      },
    })
    assert.equal(r.name, KEY_FALLBACK[family])
    assert.equal(r.source, `the last name known to this setup (Hermes could not be asked; check ${ENV_DOCS_URL})`)
  }
})

test('keyVariable rejects a malformed name and moves on', async () => {
  const dir = tmp()
  mkdirSync(join(dir, 'hermes_cli'))
  writeFileSync(join(dir, 'hermes_cli', 'auth.py'), '("anthropic", "Anthropic", "x", ("bad name; rm",), "Y"),\n')
  const r = await keyVariable({
    family: 'claude',
    hermes: 'HERMES',
    run: runVersion(dir),
    ...fsDeps,
    fetchText: async () => '| `lower_case` | Anthropic Console API key |\n',
  })
  assert.equal(r.name, 'ANTHROPIC_API_KEY')
  assert.match(r.source, /last name known/)
})

// ------------------------------------------------- parseEnv / envValueState

test('parseEnv keeps active lines only and tolerates CRLF, BOM and export', () => {
  const text = '\uFEFFA_KEY=one\r\n# B_KEY=two\r\n\r\nexport C_KEY=three=3\r\n  D_KEY = x \r\n'
  assert.deepEqual(parseEnv(text), [
    { name: 'A_KEY', value: 'one', line: 0 },
    { name: 'C_KEY', value: 'three=3', line: 3 },
    { name: 'D_KEY', value: ' x ', line: 4 },
  ])
})

test('envValueState tells absent, commented, empty and filled apart', () => {
  assert.equal(envValueState('', NAME), 'absent')
  assert.equal(envValueState('OTHER=1\n', NAME), 'absent')
  assert.equal(envValueState(`# ${NAME}=\r\n`, NAME), 'commented')
  assert.equal(envValueState(`\uFEFF${NAME}=\r\n`, NAME), 'empty')
  assert.equal(envValueState(`${NAME}=  ""\n`, NAME), 'empty')
  assert.equal(envValueState(`export ${NAME}=x\n`, NAME), 'filled')
  assert.equal(envValueState(`${NAME}=x\n${NAME}=\n`, NAME), 'empty')
})

// ------------------------------------------------------------ prepareEnvFile

test('prepareEnvFile creates a new file with the hint and an empty line', () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  const r = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  assert.deepEqual(r, { backupPath: '', created: true, state: 'absent' })
  assert.equal(read(envPath), `${ENV_HINT}\n${NAME}=\n`)
})

test('prepareEnvFile backs up an existing file and keeps every other line and CRLF', () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  const original = `# my keys\r\n${OTHER_LINES.join('\r\n')}\r\n`
  writeFileSync(envPath, original)
  const r = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  assert.equal(r.backupPath, `${envPath}.backup-${STAMP}`)
  assert.equal(r.created, false)
  assert.equal(r.state, 'absent')
  assert.equal(read(r.backupPath), original)
  assert.equal(read(envPath), `${original}${ENV_HINT}\r\n${NAME}=\r\n`)
})

test('prepareEnvFile keeps a missing final newline missing', () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  writeFileSync(envPath, 'A_KEY=1')
  prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  assert.equal(read(envPath), `A_KEY=1\n${ENV_HINT}\n${NAME}=`)
})

test('prepareEnvFile leaves a commented template line and appends the real line', () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  const original = `# ${NAME}=your-key-here\nA_KEY=1\n`
  writeFileSync(envPath, original)
  const r = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  assert.equal(r.state, 'commented')
  assert.equal(read(envPath), `${original}${ENV_HINT}\n${NAME}=\n`)
  // a second run neither duplicates the hint nor the line
  prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  assert.equal(read(envPath), `${original}${ENV_HINT}\n${NAME}=\n`)
})

test('prepareEnvFile leaves a filled key alone unless asked to replace it', () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  const original = `A_KEY=1\r\n${NAME}=${FAKE_KEY}\r\nB_KEY=2\r\n`
  writeFileSync(envPath, original)
  const kept = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  assert.equal(kept.state, 'filled')
  assert.equal(read(envPath), original)
  assert.equal(read(kept.backupPath), original)
  const replaced = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow, replace: true })
  assert.equal(replaced.state, 'filled')
  assert.equal(replaced.backupPath, `${kept.backupPath}-2`)
  assert.equal(read(envPath), `A_KEY=1\r\n${ENV_HINT}\r\n${NAME}=\r\nB_KEY=2\r\n`)
})

test('prepareEnvFile picks -2, -3 when the backup name is taken', () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  writeFileSync(envPath, 'A_KEY=1\n')
  const base = `${envPath}.backup-${STAMP}`
  writeFileSync(base, 'older')
  writeFileSync(`${base}-2`, 'older')
  const r = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  assert.equal(r.backupPath, `${base}-3`)
  assert.equal(read(base), 'older')
  assert.equal(read(r.backupPath), 'A_KEY=1\n')
})

// ------------------------------------------------------------ editorCommand

test('editorCommand honours VENOM_SETUP_EDITOR with a quoted path and args', () => {
  const e = editorCommand({
    platform: 'win32',
    env: { VENOM_SETUP_EDITOR: '"C:\\Program Files\\My Ed\\ed.exe" --wait -n', SystemRoot: 'C:\\Windows' },
    which: () => '',
    exists: () => true,
  })
  assert.equal(e.cmd, 'C:\\Program Files\\My Ed\\ed.exe')
  assert.deepEqual(e.args, ['--wait', '-n'])
  assert.equal(e.label, 'your VENOM_SETUP_EDITOR')
})

test('editorCommand on Windows is Notepad by full path, never start, cmd or Edge', () => {
  for (const env of [{ SystemRoot: 'D:\\Win' }, { windir: 'E:\\W' }, {}]) {
    const e = editorCommand({ platform: 'win32', env, which: () => 'C:\\x\\nano.exe', exists: () => true })
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
    assert.equal(e.cmd, `${root}\\System32\\notepad.exe`)
    assert.deepEqual(e.args, [])
    assert.equal(e.label, 'Notepad')
    const all = [e.cmd, ...e.args].join(' ').toLowerCase()
    assert.ok(!/\bstart\b|\bcmd(\.exe)?\b|edge/.test(all))
  }
})

test('editorCommand elsewhere uses VISUAL, then EDITOR, then nano, then vi', () => {
  const base = { platform: 'linux', exists: () => true }
  let e = editorCommand({ ...base, env: { VISUAL: 'code --wait', EDITOR: 'vim' }, which: () => '/usr/bin/nano' })
  assert.deepEqual([e.cmd, e.args, e.terminal], ['code', ['--wait'], true])
  e = editorCommand({ ...base, env: { EDITOR: '"/opt/my ed/ed" -x' }, which: () => '/usr/bin/nano' })
  assert.deepEqual([e.cmd, e.args, e.terminal], ['/opt/my ed/ed', ['-x'], true])
  e = editorCommand({ ...base, env: {}, which: (n) => (n === 'nano' ? '/usr/bin/nano' : '') })
  assert.deepEqual([e.cmd, e.label, e.terminal], ['nano', 'nano', true])
  e = editorCommand({ ...base, env: {}, which: () => '' })
  assert.deepEqual([e.cmd, e.label, e.terminal], ['vi', 'vi', true])
})

// ---------------------------------------------------------- openEnvInEditor

function clock(...times) {
  const q = [...times]
  return () => q.shift()
}

test('openEnvInEditor asks for Enter when the editor returns at once', async () => {
  const asked = []
  const runs = []
  const editor = { cmd: 'C:\\Windows\\System32\\notepad.exe', args: [], label: 'Notepad', terminal: false }
  const r = await openEnvInEditor({
    envPath: 'X/.env',
    editor,
    run: async (cmd, args, opts) => {
      runs.push({ cmd, args, opts })
      return { code: 0 }
    },
    ask: async (q) => asked.push(q),
    now: clock(1000, 1200),
    log: () => assert.fail('nothing to log'),
  })
  assert.deepEqual(r, { waited: true })
  assert.deepEqual(asked, [ENV_Q_DONE])
  assert.deepEqual(runs, [{ cmd: editor.cmd, args: ['X/.env'], opts: { interactive: false } }])
})

test('openEnvInEditor does not ask when the editor ran until closed', async () => {
  const r = await openEnvInEditor({
    envPath: 'X/.env',
    editor: { cmd: 'nano', args: ['-w'], label: 'nano', terminal: true },
    run: async (cmd, args, opts) => {
      assert.deepEqual(args, ['-w', 'X/.env'])
      assert.equal(opts.interactive, true)
      return { code: 0 }
    },
    ask: async () => assert.fail('should not ask'),
    now: clock(0, 45000),
    log: () => {},
  })
  assert.deepEqual(r, { waited: false })
})

test('openEnvInEditor asks after a non-zero exit, and logs the path when it cannot start', async () => {
  const asked = []
  const logs = []
  const ed = { cmd: 'ed', args: [], label: 'ed', terminal: true }
  let r = await openEnvInEditor({
    envPath: 'X/.env',
    editor: ed,
    run: async () => ({ code: 2 }),
    ask: async (q) => asked.push(q),
    now: clock(0, 9000),
    log: (l) => logs.push(l),
  })
  assert.deepEqual(r, { waited: true })
  assert.equal(logs.length, 0)
  r = await openEnvInEditor({
    envPath: 'Y/profile/.env',
    editor: ed,
    run: async () => ({ code: -1 }),
    ask: async (q) => asked.push(q),
    now: clock(0, 10),
    log: (l) => logs.push(l),
  })
  assert.deepEqual(r, { waited: true })
  assert.deepEqual(asked, [ENV_Q_DONE, ENV_Q_DONE])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /could not open/i)
  assert.ok(logs[0].includes('Y/profile/.env'))
})

// ----------------------------------------------- check, end to end with the fake editor

/** A temp .env with other keys, prepared for NAME. */
function prepared(eol = '\r\n') {
  const dir = tmp()
  const envPath = join(dir, '.env')
  const original = `# keys${eol}${OTHER_LINES.join(eol)}${eol}`
  writeFileSync(envPath, original)
  const prep = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  return { dir, envPath, original, backupPath: prep.backupPath }
}
const valueOf = (text, name) => parseEnv(text).filter((e) => e.name === name).pop()?.value

test('fill gives ok and keeps the other keys', () => {
  const w = prepared()
  fakeEdit(w.envPath, 'fill')
  const r = checkEnvFile({ envPath: w.envPath, name: NAME, backupPath: w.backupPath, ...fsDeps })
  assert.deepEqual(r, { status: 'ok', problems: [], restored: [], changed: [] })
  assert.equal(read(w.envPath), `${w.original}${ENV_HINT}\r\n${NAME}=${FAKE_KEY}\r\n`)
})

test('empty gives empty', () => {
  const w = prepared()
  fakeEdit(w.envPath, 'empty')
  const r = checkEnvFile({ envPath: w.envPath, name: NAME, backupPath: w.backupPath, ...fsDeps })
  assert.equal(r.status, 'empty')
})

test('missing when the key line is gone', () => {
  const w = prepared('\n')
  writeFileSync(w.envPath, w.original)
  assert.equal(checkEnvFile({ envPath: w.envPath, name: NAME, backupPath: w.backupPath, ...fsDeps }).status, 'missing')
})

test('quotes gives untidy with both problems, and tidyEnvValue fixes it', () => {
  const w = prepared()
  fakeEdit(w.envPath, 'quotes')
  const r = checkEnvFile({ envPath: w.envPath, name: NAME, backupPath: w.backupPath, ...fsDeps })
  assert.equal(r.status, 'untidy')
  assert.deepEqual([...r.problems].sort(), ['quotes', 'spaces'])
  assert.equal(tidyEnvValue({ envPath: w.envPath, name: NAME, ...fsDeps }), true)
  assert.equal(tidyEnvValue({ envPath: w.envPath, name: NAME, ...fsDeps }), false)
  assert.equal(checkEnvFile({ envPath: w.envPath, name: NAME, backupPath: w.backupPath, ...fsDeps }).status, 'ok')
  assert.equal(valueOf(read(w.envPath), NAME), FAKE_KEY)
  assert.equal(read(w.envPath), `${w.original}${ENV_HINT}\r\n${NAME}=${FAKE_KEY}\r\n`)
})

test('a duplicate key line is reported and tidied away', () => {
  const w = prepared('\n')
  writeFileSync(w.envPath, `${NAME}=old\n${read(w.envPath)}`)
  fakeEdit(w.envPath, 'fill')
  const r = checkEnvFile({ envPath: w.envPath, name: NAME, ...fsDeps })
  assert.deepEqual([r.status, r.problems], ['untidy', ['duplicate']])
  tidyEnvValue({ envPath: w.envPath, name: NAME, ...fsDeps })
  assert.equal(parseEnv(read(w.envPath)).filter((e) => e.name === NAME).length, 1)
  assert.equal(checkEnvFile({ envPath: w.envPath, name: NAME, ...fsDeps }).status, 'ok')
})

for (const mode of ['stale', 'drop']) {
  test(`${mode}: lost keys come back from the backup next to the new key`, () => {
    const w = prepared()
    const extra = {}
    if (mode === 'stale') {
      const stale = join(w.dir, 'stale-copy.txt')
      writeFileSync(stale, `# keys\r\n${ENV_HINT}\r\n${NAME}=\r\n`)
      extra.FAKE_EDITOR_STALE_FILE = stale
    }
    fakeEdit(w.envPath, mode, extra)
    for (const l of OTHER_LINES) assert.ok(!read(w.envPath).includes(l))
    const r = checkEnvFile({ envPath: w.envPath, name: NAME, backupPath: w.backupPath, ...fsDeps })
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.restored, Object.keys(OTHER))
    assert.deepEqual(r.changed, [])
    const after = read(w.envPath)
    for (const l of OTHER_LINES) assert.ok(after.includes(`${l}\r\n`), l)
    assert.ok(after.includes(`${NAME}=${FAKE_KEY}\r\n`))
    assert.ok(!/(^|[^\r])\n/.test(after), 'still CRLF')
  })
}

test('a changed other value is reported by name and restoreChanged puts it back', () => {
  const w = prepared()
  fakeEdit(w.envPath, 'fill')
  const edited = read(w.envPath).replace(OTHER_LINES[1], 'GOOGLE_API_KEY=typo')
  writeFileSync(w.envPath, edited)
  const r = checkEnvFile({ envPath: w.envPath, name: NAME, backupPath: w.backupPath, ...fsDeps })
  assert.deepEqual(r, { status: 'ok', problems: [], restored: [], changed: ['GOOGLE_API_KEY'] })
  assert.equal(read(w.envPath), edited, 'check does not change a changed value')
  restoreChanged({ envPath: w.envPath, backupPath: w.backupPath, names: r.changed, ...fsDeps })
  assert.equal(read(w.envPath), `${w.original}${ENV_HINT}\r\n${NAME}=${FAKE_KEY}\r\n`)
})

// ------------------------------------------------------------------ secrecy

test('no value ever reaches a result, a log line, a question or another file', async () => {
  const dir = tmp()
  const envPath = join(dir, '.env')
  writeFileSync(envPath, `${OTHER_LINES.join('\n')}\n`)
  const seen = []
  const log = (l) => seen.push(String(l))
  const ask = async (q) => {
    seen.push(String(q))
    return ''
  }
  const prep = prepareEnvFile({ envPath, name: NAME, ...fsDeps, now: fixedNow })
  seen.push(JSON.stringify(prep))
  const editor = { cmd: process.execPath, args: [FAKE_EDITOR], label: 'fake', terminal: false }
  const run = async (cmd, args, opts) => {
    seen.push(JSON.stringify({ cmd, args, opts }))
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      env: { ...process.env, FAKE_EDITOR_MODE: 'quotes', FAKE_EDITOR_KEY: FAKE_KEY },
    })
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
  }
  seen.push(JSON.stringify(await openEnvInEditor({ envPath, editor, run, ask, now: clock(0, 5), log })))
  const check = checkEnvFile({ envPath, name: NAME, backupPath: prep.backupPath, ...fsDeps })
  seen.push(JSON.stringify(check))
  seen.push(JSON.stringify(tidyEnvValue({ envPath, name: NAME, ...fsDeps })))
  seen.push(JSON.stringify(checkEnvFile({ envPath, name: NAME, backupPath: prep.backupPath, ...fsDeps })))
  seen.push(
    JSON.stringify(
      await keyVariable({ family: 'claude', hermes: 'HERMES', run: runVersion(''), ...fsDeps, fetchText: async () => DOCS_MD }),
    ),
  )
  const all = seen.join('\n')
  for (const v of [FAKE_KEY, ...Object.values(OTHER)]) assert.ok(!all.includes(v), 'a value leaked')
  const holders = readdirSync(dir).filter((f) => read(join(dir, f)).includes(FAKE_KEY))
  assert.deepEqual(holders, ['.env'])
  assert.equal(valueOf(read(envPath), NAME), FAKE_KEY)
})
