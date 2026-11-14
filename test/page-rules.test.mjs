// Rules of the page itself, held in place:
//  - index.html lets scripts run from this origin only (no outside host);
//  - the ONNX runtime Kokoro needs is served from this origin (/ort/);
//  - window.__venomAsk exists only under the voice proof's own Vite config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORT_BASE, ORT_FILES, ortDir, ortFile, ortRuntime } from '../scripts/ort-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

function csp() {
  const m = read('index.html').match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)
  assert.ok(m, 'index.html has a Content-Security-Policy meta tag')
  const rules = new Map()
  for (const part of m[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/).filter(Boolean)
    if (name) rules.set(name, values)
  }
  return rules
}

test('script-src names no outside host', () => {
  const values = csp().get('script-src')
  assert.ok(values && values.length, 'script-src is present')
  // Keywords are quoted; blob: is the worker scheme. Anything else is a host or a wider scheme.
  const allowed = /^('self'|'unsafe-inline'|'unsafe-eval'|'wasm-unsafe-eval'|blob:)$/
  const outside = values.filter((v) => !allowed.test(v))
  assert.deepEqual(outside, [], `script-src must not name ${outside.join(' ')}`)
  assert.ok(values.includes("'self'"))
})

test('no rule falls back to a looser script source', () => {
  const rules = csp()
  assert.deepEqual(rules.get('default-src'), ["'self'"])
  assert.deepEqual(rules.get('worker-src'), ["'self'", 'blob:'])
  assert.equal(rules.has('script-src-elem'), false)
  assert.equal(rules.has('script-src-attr'), false)
})

test('nothing in the page or the app source names jsdelivr', () => {
  assert.doesNotMatch(read('index.html'), /jsdelivr/i)
  for (const [name, values] of csp()) assert.doesNotMatch(values.join(' '), /jsdelivr|cdn\./i, name)
  const hits = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|css|html)$/.test(e.name) && /https?:\/\/[^\s'"`]*jsdelivr/i.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p))
    }
  }
  walk(path.join(root, 'src'))
  assert.deepEqual(hits, [])
})

test('the ONNX runtime files exist in the installed package and are the only ones served', () => {
  const dir = ortDir(root)
  for (const name of Object.keys(ORT_FILES)) {
    assert.ok(fs.statSync(path.join(dir, name)).size > 10_000, `${name} is installed`)
    assert.equal(ortFile(ORT_BASE + name, root), path.join(dir, name))
    assert.equal(ortFile(`${ORT_BASE}${name}?v=1`, root), path.join(dir, name))
  }
  for (const bad of ['/ort/', '/ort/transformers.js', '/ort/../package.json', '/ort/..%2Fpackage.json', '/ort/sub/ort-wasm-simd-threaded.jsep.mjs', '/other/ort-wasm-simd-threaded.jsep.mjs', '/ort/ort-wasm-simd-threaded.jsep.wasm/x', '', undefined]) {
    assert.equal(ortFile(bad, root), null, String(bad))
  }
})

test('the app points the runtime at /ort/ and both Vite configs serve it', () => {
  assert.match(read('src/lib/kokoro.ts'), /env\.wasmPaths = `\$\{location\.origin\}\/ort\/`/)
  assert.equal(ORT_BASE, '/ort/')
  assert.match(read('vite.config.ts'), /plugins: \[react\(\), ortRuntime\(\)\]/)
  assert.match(read('scripts/voice-proof.vite.config.mjs'), /ortRuntime\(\)/)
  const plugin = ortRuntime()
  assert.equal(typeof plugin.configureServer, 'function')
  assert.equal(typeof plugin.generateBundle, 'function')
})

test('the dev middleware serves the runtime and passes everything else on', async () => {
  let handler
  ortRuntime().configureServer({ middlewares: { use: (h) => { handler = h } } })
  const call = (method, url) => new Promise((resolve) => {
    const headers = {}
    const res = { setHeader: (k, v) => { headers[k] = v }, end: () => resolve({ served: true, headers, status: res.statusCode }), statusCode: 200 }
    handler({ method, url }, res, () => resolve({ served: false }))
  })
  const head = await call('HEAD', '/ort/ort-wasm-simd-threaded.jsep.wasm')
  assert.equal(head.served, true)
  assert.equal(head.headers['Content-Type'], 'application/wasm')
  assert.ok(head.headers['Content-Length'] > 1_000_000)
  assert.equal((await call('HEAD', '/ort/ort-wasm-simd-threaded.jsep.mjs')).headers['Content-Type'], 'text/javascript')
  assert.equal((await call('GET', '/ort/../package.json')).served, false)
  assert.equal((await call('GET', '/src/main.tsx')).served, false)
  assert.equal((await call('POST', '/ort/ort-wasm-simd-threaded.jsep.mjs')).served, false)
})

test('__venomAsk is defined only behind the proof flag', () => {
  const app = read('src/App.tsx').replace(/\r\n/g, '\n')
  const uses = app.split('__venomAsk').length - 1
  assert.equal(uses, 1, '__venomAsk is assigned in exactly one place')
  const at = app.indexOf('__venomAsk')
  const guard = "if (typeof __VENOM_PROOF_ASK__ !== 'undefined' && __VENOM_PROOF_ASK__ === true) {\n"
  const g = app.lastIndexOf(guard, at)
  assert.ok(g >= 0, 'the assignment sits under the flag')
  // Nothing but the opening of the assignment between the guard and the name.
  assert.match(app.slice(g + guard.length, at), /^\s*;\(window as unknown as Record<string, unknown>\)\.$/)
  // No other switch (DEV, an env variable) can turn it on.
  assert.doesNotMatch(app.slice(g - 200, at), /import\.meta\.env/)
})

test('only the voice proof config sets the flag', () => {
  const setters = []
  const skip = new Set(['node_modules', 'dist', 'graphify-out', 'desktop', '.git', 'test'])
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts|d\.ts|mjs|cjs|js|json|html|cmd|vbs)$/.test(e.name) || e.name.startsWith('.env')) {
        const text = fs.readFileSync(p, 'utf8')
        if (text.includes('__VENOM_PROOF_ASK__')) setters.push(path.relative(root, p).replace(/\\/g, '/'))
      }
    }
  }
  walk(root)
  // App.tsx reads it, vite-env.d.ts declares it, the proof config makes it true,
  // and the proof script only asks a page whether it is there (check 6).
  // vite.config.ts compiles it to false, so no global set at run time can switch it on.
  assert.deepEqual(setters.sort(), ['scripts/voice-proof.mjs', 'scripts/voice-proof.vite.config.mjs', 'src/App.tsx', 'src/vite-env.d.ts', 'vite.config.ts'])
  assert.doesNotMatch(read('scripts/voice-proof.mjs'), /__VENOM_PROOF_ASK__\s*[:=][^=]/)
  assert.match(read('scripts/voice-proof.vite.config.mjs'), /define: \{ __VENOM_PROOF_ASK__: 'true' \}/)
  const normal = read('vite.config.ts')
  assert.match(normal, /define: \{ __VENOM_PROOF_ASK__: 'false' \}/)
  assert.equal(normal.split('__VENOM_PROOF_ASK__').length - 1, 1)
  assert.doesNotMatch(normal, /import[^\n]*voice-proof|process\.env\.[A-Z_]*PROOF/)
  assert.doesNotMatch(read('src/vite-env.d.ts'), /=/)
})
