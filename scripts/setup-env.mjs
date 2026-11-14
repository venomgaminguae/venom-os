// The ".env step" of the setup wizard: find the API-key variable name Hermes
// expects, prepare the profile's .env file (with a dated backup), open it in a
// plain editor so the owner can paste the key, then check the result.
//
// Every side effect (running programs, questions, files, HTTP, the clock,
// output) goes through injected functions, so test/setup-env.test.mjs drives
// it with stubs. This module never logs, returns, throws with or writes
// anywhere but the .env itself the VALUE of any variable: results carry
// variable NAMES and plain words only.

/** Hermes provider id for each brain family that uses an API key. */
export const KEY_PROVIDER = { gpt: 'openai-api', claude: 'anthropic', gemini: 'gemini' }

/** The variable names last known to this setup, used only when Hermes cannot be asked. */
export const KEY_FALLBACK = { gpt: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', gemini: 'GOOGLE_API_KEY' }

/** Hermes's documentation page listing its environment variables. */
export const ENV_DOCS_URL = 'https://hermes-agent.nousresearch.com/docs/reference/environment-variables'

/** The raw markdown behind ENV_DOCS_URL. */
export const ENV_DOCS_RAW_URL =
  'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/reference/environment-variables.md'

/** The comment written directly above the empty key line. */
export const ENV_HINT = '# Paste your key after the = sign on the next line: no spaces, no quotes. Then save and close this file.'

/** Asked when the editor may still be open. */
export const ENV_Q_DONE = 'Press Enter here when you have saved the file and closed the editor:'

const VALID_NAME = /^[A-Z][A-Z0-9_]{2,63}$/
const FAST_MS = 3000

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ------------------------------------------------------------- key variable

/** First variable name of the provider's row in Hermes's hermes_cli/auth.py, or ''. */
function nameFromAuthPy(text, provider) {
  const re = new RegExp(
    `\\(\\s*"${escapeRe(provider)}"\\s*,\\s*"[^"]*"\\s*,\\s*"[^"]*"\\s*,\\s*\\(\\s*"([^"]+)"`,
  )
  const m = re.exec(String(text ?? ''))
  return m ? m[1] : ''
}

const DOC_MATCH = {
  gpt: (d) => /`openai-api`\s+provider/i.test(d),
  claude: (d) => /^Anthropic Console API key/i.test(d),
  gemini: (d) => /^Google AI Studio API key/i.test(d) && !/alias/i.test(d),
}

/** The variable name for a family from the environment-variables table, or ''. */
function nameFromDocs(text, family) {
  const match = DOC_MATCH[family]
  if (!match) return ''
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*\|\s*`([^`]+)`\s*\|\s*([^|]*)\|/.exec(line)
    if (m && match(m[2].trim())) return m[1].trim()
  }
  return ''
}

/**
 * Which environment variable Hermes reads the API key from for a family.
 * Asks the installed Hermes source first, then Hermes's live docs, then falls
 * back to KEY_FALLBACK. Never throws.
 *
 * @param {{ family: 'gpt'|'claude'|'gemini', hermes: string,
 *   run: (cmd: string, args: string[], opts: object) => Promise<{code: number, stdout: string, stderr: string}>,
 *   readFile: (path: string) => string|Promise<string>, exists: (path: string) => boolean|Promise<boolean>,
 *   fetchText: (url: string) => Promise<string> }} deps
 * @returns {Promise<{ name: string, source: string }>}
 */
export async function keyVariable({ family, hermes, run, readFile, exists, fetchText }) {
  const provider = KEY_PROVIDER[family]
  if (provider && hermes && run && readFile) {
    try {
      const r = await run(hermes, ['--version'], {})
      const m = /Install directory:\s*(.+)/i.exec(`${r?.stdout ?? ''}\n${r?.stderr ?? ''}`)
      if (m) {
        const dir = m[1].trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '')
        const file = `${dir}/hermes_cli/auth.py`
        if (!exists || (await exists(file))) {
          const name = nameFromAuthPy(await readFile(file), provider)
          if (VALID_NAME.test(name)) return { name, source: `Hermes's own provider list (${file})` }
        }
      }
    } catch {
      // fall through to the docs
    }
  }
  if (fetchText) {
    try {
      const name = nameFromDocs(await fetchText(ENV_DOCS_RAW_URL), family)
      if (VALID_NAME.test(name)) return { name, source: `Hermes's documentation (${ENV_DOCS_URL})` }
    } catch {
      // fall through to the built-in list
    }
  }
  return {
    name: KEY_FALLBACK[family] ?? '',
    source: `the last name known to this setup (Hermes could not be asked; check ${ENV_DOCS_URL})`,
  }
}

// ---------------------------------------------------------------- .env text

/** Split text into lines that remember their own line ending, so a rewrite keeps every other byte. */
function splitDoc(text) {
  let body = String(text ?? '')
  let bom = ''
  if (body.startsWith('\uFEFF')) {
    bom = '\uFEFF'
    body = body.slice(1)
  }
  const lines = []
  const re = /\r?\n/g
  let last = 0
  let m
  while ((m = re.exec(body))) {
    lines.push({ text: body.slice(last, m.index), eol: m[0] })
    last = re.lastIndex
  }
  lines.push({ text: body.slice(last), eol: '' })
  return { bom, lines }
}

const joinDoc = (doc) => doc.bom + doc.lines.map((l) => l.text + l.eol).join('')
const eolOf = (text) => (/\r\n/.test(String(text ?? '')) ? '\r\n' : '\n')

/** `{ name, value }` for an active assignment line, else null. */
function parseLine(text) {
  const t = String(text)
  if (!t.trim() || t.trimStart().startsWith('#')) return null
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(t)
  return m ? { name: m[1], value: m[2] } : null
}

function entriesOf(doc) {
  const out = []
  doc.lines.forEach((l, line) => {
    const p = parseLine(l.text)
    if (p) out.push({ ...p, line })
  })
  return out
}

/** Append lines at the end, keeping the line-ending style and whether the file ended with a newline. */
function appendLines(doc, texts, eol) {
  const last = doc.lines[doc.lines.length - 1]
  if (last.text === '') {
    doc.lines.pop()
    for (const t of texts) doc.lines.push({ text: t, eol })
    doc.lines.push({ text: '', eol: '' })
  } else {
    last.eol = eol
    texts.forEach((t, i) => doc.lines.push({ text: t, eol: i === texts.length - 1 ? '' : eol }))
  }
}

function removeLine(doc, i) {
  const [gone] = doc.lines.splice(i, 1)
  if (gone.eol === '' && i > 0) doc.lines[i - 1].eol = ''
}

const bare = (value) => {
  let v = String(value ?? '').trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim()
  }
  return v
}

/**
 * The active assignment lines of a .env text (blank and `#` lines skipped;
 * `export NAME=` accepted; CRLF and a UTF-8 BOM tolerated). `line` is the
 * 0-based line index. Values stay in memory only.
 *
 * @param {string} text
 * @returns {{ name: string, value: string, line: number }[]}
 */
export function parseEnv(text) {
  return entriesOf(splitDoc(text))
}

/**
 * Whether a variable is missing, only present as a commented template, empty
 * (blank, whitespace or quotes only) or filled. Uses the last active line.
 *
 * @param {string} text
 * @param {string} name
 * @returns {'absent'|'commented'|'empty'|'filled'}
 */
export function envValueState(text, name) {
  const doc = splitDoc(text)
  const mine = entriesOf(doc).filter((e) => e.name === name)
  if (mine.length) return bare(mine[mine.length - 1].value).replace(/["'\s]/g, '') ? 'filled' : 'empty'
  const commented = new RegExp(`^\\s*#\\s*(?:export\\s+)?${escapeRe(name)}\\s*=`)
  return doc.lines.some((l) => commented.test(l.text)) ? 'commented' : 'absent'
}

const pad = (n) => String(n).padStart(2, '0')
const stamp = (d) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/**
 * Get the .env ready for the key: back it up beside itself
 * (`<envPath>.backup-YYYYMMDD-HHMMSS`, `-2`, `-3`... on collision), then make
 * sure exactly one empty `NAME=` line sits under ENV_HINT. A filled value is
 * left alone unless `replace` is true (then it is emptied in place). Every
 * other line is kept byte for byte.
 *
 * @param {{ envPath: string, name: string, readFile: (p: string) => string,
 *   writeFile: (p: string, text: string) => void, exists: (p: string) => boolean,
 *   copyFile: (src: string, dest: string) => void, now: () => Date, replace?: boolean }} deps
 * @returns {{ backupPath: string, created: boolean, state: 'absent'|'commented'|'empty'|'filled' }}
 */
export function prepareEnvFile({ envPath, name, readFile, writeFile, exists, copyFile, now, replace }) {
  if (!exists(envPath)) {
    writeFile(envPath, `${ENV_HINT}\n${name}=\n`)
    return { backupPath: '', created: true, state: 'absent' }
  }
  const base = `${envPath}.backup-${stamp(now())}`
  let backupPath = base
  for (let n = 2; exists(backupPath); n++) backupPath = `${base}-${n}`
  copyFile(envPath, backupPath)

  const text = readFile(envPath)
  const state = envValueState(text, name)
  if (state === 'filled' && replace !== true) return { backupPath, created: false, state }

  const doc = splitDoc(text)
  const eol = eolOf(text)
  const mine = entriesOf(doc).filter((e) => e.name === name)
  if (mine.length) {
    let keep = mine[mine.length - 1].line
    doc.lines[keep].text = `${name}=`
    for (const e of mine.slice(0, -1).reverse()) {
      removeLine(doc, e.line)
      keep--
    }
    if (doc.lines[keep - 1]?.text !== ENV_HINT) doc.lines.splice(keep, 0, { text: ENV_HINT, eol })
  } else {
    const content = doc.lines.filter((l) => l.text !== '')
    const hinted = content.length && content[content.length - 1].text === ENV_HINT
    appendLines(doc, hinted ? [`${name}=`] : [ENV_HINT, `${name}=`], eol)
  }
  const out = joinDoc(doc)
  if (out !== text) writeFile(envPath, out)
  return { backupPath, created: false, state }
}

// ------------------------------------------------------------------- editor

/** Split a command line into words, honouring double quotes. */
function splitCommand(s) {
  const words = []
  let cur = ''
  let quoted = false
  let any = false
  for (const ch of String(s ?? '')) {
    if (ch === '"') {
      quoted = !quoted
      any = true
    } else if (/\s/.test(ch) && !quoted) {
      if (any) words.push(cur)
      cur = ''
      any = false
    } else {
      cur += ch
      any = true
    }
  }
  if (any) words.push(cur)
  return words
}

/**
 * Which editor to open the .env in. VENOM_SETUP_EDITOR wins; on Windows it is
 * Notepad by its full path (never `start`, `cmd /c` or a default-app handler);
 * elsewhere VISUAL, EDITOR, nano, then vi. `args` exclude the file path.
 *
 * @param {{ platform: string, env: Record<string, string|undefined>,
 *   which: (name: string) => string, exists?: (p: string) => boolean }} deps
 * @returns {{ cmd: string, args: string[], label: string, terminal: boolean }}
 */
export function editorCommand({ platform, env, which }) {
  const override = splitCommand(env.VENOM_SETUP_EDITOR)
  if (override.length) {
    return { cmd: override[0], args: override.slice(1), label: 'your VENOM_SETUP_EDITOR', terminal: platform !== 'win32' }
  }
  if (platform === 'win32') {
    const root = String(env.SystemRoot || env.windir || 'C:\\Windows').replace(/[\\/]+$/, '')
    return { cmd: `${root}\\System32\\notepad.exe`, args: [], label: 'Notepad', terminal: false }
  }
  for (const key of ['VISUAL', 'EDITOR']) {
    const words = splitCommand(env[key])
    if (words.length) return { cmd: words[0], args: words.slice(1), label: `your ${key} (${words[0]})`, terminal: true }
  }
  if (which('nano')) return { cmd: 'nano', args: [], label: 'nano', terminal: true }
  return { cmd: 'vi', args: [], label: 'vi', terminal: true }
}

/**
 * Open the .env in the editor and wait for it. When the editor returns within
 * 3 s (Windows 11 Notepad and many GUI editors return while the window stays
 * open), exits non-zero or cannot start, ask the owner to press Enter.
 *
 * @param {{ envPath: string, editor: { cmd: string, args: string[], label: string, terminal: boolean },
 *   run: (cmd: string, args: string[], opts: object) => Promise<{code: number}>,
 *   ask: (q: string) => Promise<string>, now: () => number, log: (line: string) => void }} deps
 * @returns {Promise<{ waited: boolean }>}
 */
export async function openEnvInEditor({ envPath, editor, run, ask, now, log }) {
  const start = now()
  let code
  try {
    const r = await run(editor.cmd, [...editor.args, envPath], { interactive: editor.terminal })
    code = typeof r?.code === 'number' ? r.code : 0
  } catch {
    code = -1
  }
  const took = now() - start
  if (code === -1) log(`Could not open ${editor.label}. Open this file by hand, paste the key, save and close it: ${envPath}`)
  if (code !== 0 || took < FAST_MS) {
    await ask(ENV_Q_DONE)
    return { waited: true }
  }
  return { waited: false }
}

// -------------------------------------------------------------------- check

const lastOf = (entries, name) => {
  const mine = entries.filter((e) => e.name === name)
  return mine[mine.length - 1]
}

/**
 * Check the .env after editing. Lines the backup had but the file lost (an
 * editor that saved a stale copy) are put back from the backup and listed in
 * `restored`; other variables whose value changed are only listed in
 * `changed`. Status of the key line: 'missing', 'empty', 'untidy' (problems:
 * 'quotes', 'spaces', 'duplicate') or 'ok'. Names and words only.
 *
 * @param {{ envPath: string, name: string, backupPath?: string,
 *   readFile: (p: string) => string, writeFile: (p: string, text: string) => void }} deps
 * @returns {{ status: 'missing'|'empty'|'untidy'|'ok', problems: string[], restored: string[], changed: string[] }}
 */
export function checkEnvFile({ envPath, name, backupPath, readFile, writeFile }) {
  let text = readFile(envPath)
  const restored = []
  const changed = []
  if (backupPath) {
    const oldDoc = splitDoc(readFile(backupPath))
    const old = entriesOf(oldDoc)
    const now = entriesOf(splitDoc(text))
    const present = new Set(now.map((e) => e.name))
    const back = []
    for (const e of old) {
      if (e.name === name) continue
      if (!present.has(e.name)) {
        if (!restored.includes(e.name)) restored.push(e.name)
        back.push(oldDoc.lines[e.line].text)
      }
    }
    for (const n of new Set(old.map((e) => e.name))) {
      if (n === name || !present.has(n)) continue
      if (lastOf(old, n).value !== lastOf(now, n).value) changed.push(n)
    }
    if (back.length) {
      const doc = splitDoc(text)
      appendLines(doc, back, eolOf(text))
      text = joinDoc(doc)
      writeFile(envPath, text)
    }
  }
  const doc = splitDoc(text)
  const mine = entriesOf(doc).filter((e) => e.name === name)
  const problems = []
  if (!mine.length) return { status: 'missing', problems, restored, changed }
  const last = mine[mine.length - 1]
  if (!bare(last.value).replace(/["'\s]/g, '')) return { status: 'empty', problems, restored, changed }
  const raw = doc.lines[last.line].text
  const v = last.value
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) problems.push('quotes')
  if (v !== v.trim() || /^\s/.test(raw) || new RegExp(`${escapeRe(name)}\\s+=`).test(raw)) problems.push('spaces')
  if (mine.length > 1) problems.push('duplicate')
  return { status: problems.length ? 'untidy' : 'ok', problems, restored, changed }
}

/**
 * Rewrite the key line as `NAME=<value>` without surrounding quotes or
 * whitespace (and drop earlier duplicate lines of the same name).
 *
 * @param {{ envPath: string, name: string, readFile: (p: string) => string,
 *   writeFile: (p: string, text: string) => void }} deps
 * @returns {boolean} true when the file changed
 */
export function tidyEnvValue({ envPath, name, readFile, writeFile }) {
  const text = readFile(envPath)
  const doc = splitDoc(text)
  const mine = entriesOf(doc).filter((e) => e.name === name)
  if (!mine.length) return false
  const last = mine[mine.length - 1]
  doc.lines[last.line].text = `${name}=${bare(last.value)}`
  for (const e of mine.slice(0, -1).reverse()) removeLine(doc, e.line)
  const out = joinDoc(doc)
  if (out === text) return false
  writeFile(envPath, out)
  return true
}

/**
 * Put the listed variables back to their lines from the backup.
 *
 * @param {{ envPath: string, backupPath: string, names: string[],
 *   readFile: (p: string) => string, writeFile: (p: string, text: string) => void }} deps
 */
export function restoreChanged({ envPath, backupPath, names, readFile, writeFile }) {
  const oldDoc = splitDoc(readFile(backupPath))
  const old = entriesOf(oldDoc)
  const text = readFile(envPath)
  const doc = splitDoc(text)
  const append = []
  for (const n of names ?? []) {
    const src = lastOf(old, n)
    if (!src) continue
    const line = oldDoc.lines[src.line].text
    const mine = entriesOf(doc).filter((e) => e.name === n)
    if (!mine.length) {
      append.push(line)
      continue
    }
    doc.lines[mine[0].line].text = line
    for (const e of mine.slice(1).reverse()) removeLine(doc, e.line)
  }
  if (append.length) appendLines(doc, append, eolOf(text))
  const out = joinDoc(doc)
  if (out !== text) writeFile(envPath, out)
}
