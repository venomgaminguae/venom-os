// The HUD takes the agent roster only from the bridge's team snapshot.
// hermes-mcp/agents.mjs and hermes-mcp/roster.mjs read the owner's roster file
// with node:fs, so nothing under src/ may import them by value: only
// `import type` (erased at build time) is allowed.
// Pure file reads: nothing is spawned, nothing is written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const NODE_ONLY = /(?:^|\/)hermes-mcp\/(?:agents|roster)\.m?js$/

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) sources(path, out)
    else if (/\.(?:m|c)?[jt]sx?$/.test(e.name)) out.push(path)
  }
  return out
}

/** Every module a file pulls in: { spec, typeOnly } for import/export ... from, bare and dynamic imports. */
function importsOf(code) {
  const out = []
  const from = /\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const m of code.matchAll(from)) out.push({ spec: m[4], typeOnly: !!m[2] })
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1], typeOnly: false })
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], typeOnly: false })
  return out
}

const offenders = (code) => importsOf(code).filter((i) => NODE_ONLY.test(i.spec) && !i.typeOnly).map((i) => i.spec)

test('the import scanner tells type-only imports from value imports', () => {
  assert.deepEqual(offenders(`import type { AgentInfo } from '../hermes-mcp/agents.mjs'`), [])
  assert.deepEqual(offenders(`export type { AgentInfo } from '../../hermes-mcp/roster.mjs'`), [])
  assert.equal(offenders(`import { AGENTS } from '../hermes-mcp/agents.mjs'`).length, 1)
  assert.equal(offenders(`import { AGENTS, type AgentInfo } from '../hermes-mcp/agents.mjs'`).length, 1)
  assert.equal(offenders(`import { type AgentInfo } from '../hermes-mcp/agents.mjs'`).length, 1)
  assert.equal(offenders(`import {\r\n  loadRoster,\r\n} from '../../hermes-mcp/roster.mjs'`).length, 1)
  assert.equal(offenders(`export { AGENTS } from '../hermes-mcp/agents.mjs'`).length, 1)
  assert.equal(offenders(`import '../hermes-mcp/roster.mjs'`).length, 1)
  assert.equal(offenders(`const m = await import('../hermes-mcp/agents.mjs')`).length, 1)
  assert.deepEqual(offenders(`import { tileOrder } from '../hermes-mcp/tiles.mjs'`), [])
})

test('nothing under src/ imports hermes-mcp/agents.mjs or roster.mjs by value', () => {
  const files = sources(SRC)
  assert.ok(files.length > 0, 'found the HUD sources')
  const bad = []
  for (const f of files) {
    for (const spec of offenders(readFileSync(f, 'utf8'))) bad.push(`${relative(ROOT, f)}: ${spec}`)
  }
  assert.deepEqual(bad, [], `use "import type" for these (the HUD gets the roster from the bridge):\n${bad.join('\n')}`)
})
