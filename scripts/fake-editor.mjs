// A stand-in "editor" for test/setup-env.test.mjs and scripted wizard runs:
// `node scripts/fake-editor.mjs <file>` edits the .env the way a person (or a
// misbehaving editor) would, then exits. It prints nothing and opens no
// window. Behaviour comes from the environment:
//   FAKE_EDITOR_MODE  fill   set the first empty `NAME=` line after the hint
//                            comment to FAKE_EDITOR_KEY
//                     empty  change nothing
//                     quotes write `NAME = "<key>" ` (quotes and spaces)
//                     stale  overwrite the file with FAKE_EDITOR_STALE_FILE's
//                            content, then fill (an editor saving an old copy)
//                     drop   fill, then delete every other active line
//   FAKE_EDITOR_KEY   the value to type
import { readFileSync, writeFileSync } from 'node:fs'
import { ENV_HINT } from './setup-env.mjs'

const file = process.argv[2]
const mode = process.env.FAKE_EDITOR_MODE ?? 'fill'
const key = process.env.FAKE_EDITOR_KEY ?? ''

if (!file || mode === 'empty') process.exit(0)

let text = readFileSync(file, 'utf8')
if (mode === 'stale') text = readFileSync(process.env.FAKE_EDITOR_STALE_FILE ?? '', 'utf8')

const parts = text.split(/(\r?\n)/)
let target = -1
let seenHint = false
for (let i = 0; i < parts.length; i += 2) {
  if (parts[i] === ENV_HINT) seenHint = true
  else if (seenHint && /^[A-Za-z_][A-Za-z0-9_]*=\s*$/.test(parts[i])) {
    target = i
    break
  }
}

if (target >= 0) {
  const name = parts[target].split('=')[0]
  parts[target] = mode === 'quotes' ? `${name} = "${key}" ` : `${name}=${key}`
}

if (mode === 'drop') {
  for (let i = parts.length - 1; i >= 0; i -= 2) {
    const t = parts[i]
    if (i === target || !t.trim() || t.trimStart().startsWith('#')) continue
    parts.splice(i, 2)
  }
}

writeFileSync(file, parts.join(''))
