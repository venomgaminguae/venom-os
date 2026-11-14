/**
 * Package the Venom OS desktop app (Electron) into release/Venom OS-win32-x64/.
 *
 *   node scripts/build-app.mjs                 vendor MediaPipe, Vite build, package
 *   node scripts/build-app.mjs --skip-web      reuse the existing dist/, package only
 *   node scripts/build-app.mjs --web-only      vendor MediaPipe + Vite build, no packaging
 *   node scripts/build-app.mjs --package-only  same as --skip-web
 *
 * Steps:
 *  1. Copy MediaPipe's WASM runtime into public/mediapipe (exactly as
 *     scripts/start.mjs does), so the built page serves it from its own origin.
 *  2. Vite production build through its JS API (vite.config.ts -> dist/). The
 *     type check (`tsc -b`) of `npm run build` is deliberately not run here.
 *  3. Write desktop/build-info.json { projectRoot, builtAt, commit }: the app
 *     uses projectRoot to find <repo>/desktop/models, which is not packaged.
 *  4. @electron/packager with the Electron version installed in node_modules,
 *     so the cached zip (%LOCALAPPDATA%\electron\Cache) is used when present.
 *     The packaged resources/app holds only what runs: package.json, LICENSE,
 *     venom.config.json (your settings from `npm run setup`, when present),
 *     desktop/ (without models), bridge/, hermes-mcp/, dist/ and the
 *     production node_modules.
 *  5. Print the output folder, exe path, size, file count and the largest
 *     packages in resources/app/node_modules.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

const args = process.argv.slice(2)
const skipWeb = args.includes('--skip-web') || args.includes('--package-only')
const webOnly = args.includes('--web-only')

const APP_NAME = 'Venom OS'
const OUT_DIR = join(ROOT, 'release')

const t0 = Date.now()
const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s'

/** Same as vendorWasm() in scripts/start.mjs. */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

async function buildWeb() {
  console.log('[build-app] Vite production build -> dist/')
  const { build } = await import('vite')
  await build({ root: ROOT, configFile: join(ROOT, 'vite.config.ts'), mode: 'production', logLevel: 'warn' })
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('Vite build produced no dist/index.html')
  console.log(`[build-app] web build done (${secs()})`)
}

function writeBuildInfo() {
  let commit = null
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    /* not a git checkout: leave null */
  }
  const info = { projectRoot: ROOT, builtAt: new Date().toISOString(), commit }
  writeFileSync(join(ROOT, 'desktop', 'build-info.json'), JSON.stringify(info, null, 2) + '\n')
  console.log(`[build-app] wrote desktop/build-info.json (commit ${commit})`)
}

// ---------------------------------------------------------------------------
// What goes into resources/app.
//
// Allow-list at the top level; everything else at the root (src, test, docs,
// public, assets, scripts, graphify-out, release, .git, *.md, *.bak*,
// Venom.cmd/.vbs, venom-app.ps1, tsconfig*, vite.config.ts, the root
// index.html, .graphifyignore, AUDIT*, .env*, ...) is left out.
// bridge/ and hermes-mcp/ import only each other and node_modules (checked by
// grepping their imports), so nothing else from the root is needed at run time.
const KEEP_TOP = new Set(['package.json', 'LICENSE', 'venom.config.json', 'desktop', 'bridge', 'hermes-mcp', 'dist', 'node_modules'])

// Packager's own default ignores. They are dropped when `ignore` is a
// function, so they are repeated here.
const DEFAULT_IGNORES = [
  /\/package-lock\.json$/,
  /\/yarn\.lock$/,
  /\/pnpm-lock\.yaml$/,
  /\/\.git($|\/)/,
  /\/node_modules\/\.bin($|\/)/,
  /\.o(bj)?$/,
  /\/node_gyp_bins($|\/)/,
]

// ---------------------------------------------------------------------------
// node_modules: our own production-dependency walk instead of packager's
// `prune`. Packager's pruner (galactus) does not follow peerDependencies, and
// @modelcontextprotocol/sdk, which hermes-mcp/server.mjs imports, reaches us
// only as a peer dependency of @anthropic-ai/claude-agent-sdk: with
// `prune: true` it was silently left out and the Hermes MCP server could not
// start. The walk below follows dependencies, optionalDependencies and
// (installed) peerDependencies with Node's resolution rules.
//
// Front-end-only packages: the page is already bundled into dist/ by Vite, so
// these top-level dependencies are not walked from package.json. They are
// still packaged if anything the run-time code needs depends on them. Run-time
// imports, checked by grepping bridge/*.mjs, hermes-mcp/*.mjs and desktop/*.mjs:
// ws, zod, @anthropic-ai/claude-agent-sdk (+ its platform binary and peers
// @anthropic-ai/sdk, @modelcontextprotocol/sdk), @modelcontextprotocol/sdk,
// @huggingface/transformers (-> onnxruntime-node, onnxruntime-common, sharp),
// electron (built in). Update this list if the bridge starts importing one.
const FRONT_END_ONLY = [
  '@mediapipe/tasks-vision',
  '@picovoice/porcupine-web',
  '@picovoice/web-voice-processor',
  '@react-three/drei',
  '@react-three/fiber',
  '@react-three/postprocessing',
  'dompurify',
  'framer-motion',
  'kokoro-js',
  'react',
  'react-dom',
  'three',
  'zustand',
]
// Never packaged, even as a transitive dependency:
//  - electron: the runtime itself (also a devDependency).
//  - onnxruntime-web: a dependency of @huggingface/transformers, but its Node
//    build (dist/transformers.node.mjs, the "node" export the bridge loads)
//    marks it "(ignored)" and uses onnxruntime-node instead. ~90 MB.
const NEVER_PACKAGE = new Set(['electron', 'onnxruntime-web'])

/** Find `name` as Node would from package folder `fromDir` (absolute). */
function resolvePackage(fromDir, name) {
  let d = fromDir
  for (;;) {
    const c = join(d, 'node_modules', name)
    if (existsSync(join(c, 'package.json'))) return c
    if (d === ROOT) return null
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

/** Set of '/node_modules/...' package paths (root-relative) to package. */
function runtimeModules() {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const keep = new Set()
  const queue = []
  const add = (fromDir, name, optional) => {
    if (NEVER_PACKAGE.has(name)) return
    const dir = resolvePackage(fromDir, name)
    if (!dir) {
      if (!optional) console.warn(`[build-app] WARNING: dependency ${name} (needed from ${fromDir}) is not installed`)
      return
    }
    const rel = '/' + dir.slice(ROOT.length + 1).split('\\').join('/')
    if (keep.has(rel)) return
    keep.add(rel)
    queue.push(dir)
  }
  for (const name of Object.keys(rootPkg.dependencies || {})) {
    if (!FRONT_END_ONLY.includes(name)) add(ROOT, name, false)
  }
  for (const name of Object.keys(rootPkg.optionalDependencies || {})) add(ROOT, name, true)
  while (queue.length) {
    const dir = queue.shift()
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const name of Object.keys(p.dependencies || {})) add(dir, name, false)
    for (const name of Object.keys(p.optionalDependencies || {})) add(dir, name, true)
    // Peers are kept when installed; a missing peer is the package's own business.
    for (const name of Object.keys(p.peerDependencies || {})) add(dir, name, true)
  }
  return keep
}

let KEEP_MODULES = null // Set of package paths
let KEEP_MODULE_PARENTS = null // node_modules / @scope folders leading to them

function prepareModuleFilter() {
  KEEP_MODULES = runtimeModules()
  KEEP_MODULE_PARENTS = new Set()
  for (const m of KEEP_MODULES) {
    const parts = m.split('/')
    for (let i = 2; i < parts.length; i++) KEEP_MODULE_PARENTS.add(parts.slice(0, i).join('/'))
  }
}

/** For a path under /node_modules: keep it only inside a kept package. */
function ignoreModulePath(p) {
  if (KEEP_MODULE_PARENTS.has(p)) return false // /node_modules, /node_modules/@scope, nested node_modules
  // Caches and tool state inside node_modules (e.g. node_modules/.vite, and a
  // 300 MB Kokoro model cache in @huggingface/transformers/.cache) are never
  // read at run time: the bridge points transformers at its own cache dir.
  if (/\/\.(cache|vite)(\/|$)/.test(p)) return true
  // onnxruntime-node ships binaries for every OS (~175 MB that is not win32
  // x64); this build is win32 x64 only and the binding loads
  // bin/napi-v3/<platform>/<arch>.
  const ort = /\/onnxruntime-node\/bin\/napi-v3\/([^/]+)(?:\/([^/]+))?/.exec(p)
  if (ort && (ort[1] !== 'win32' || (ort[2] && ort[2] !== 'x64'))) return true
  // Deepest package folder containing p.
  const parts = p.split('/')
  let pkg = null
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] !== 'node_modules' || i + 1 >= parts.length) continue
    const scoped = parts[i + 1].startsWith('@')
    const end = scoped ? i + 3 : i + 2
    if (end > parts.length) return true // a scope folder that leads to nothing kept
    pkg = parts.slice(0, end).join('/')
  }
  return !pkg || !KEEP_MODULES.has(pkg)
}

/** @param {string} p path relative to the project root, '/'-separated, leading '/'. */
function ignore(p) {
  if (!p) return false // the root itself
  const top = p.split('/')[1]
  if (!KEEP_TOP.has(top)) return true
  if (DEFAULT_IGNORES.some((re) => re.test(p))) return true
  if (top === 'node_modules') return ignoreModulePath(p)
  if (p === '/desktop/models' || p.startsWith('/desktop/models/')) return true
  // Editor backups (*.bak*) in our own folders.
  return /\.bak[^/]*$/.test(p)
}

async function packageApp() {
  const { packager } = await import('@electron/packager')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const electronVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  const cacheZip = findCachedZip(electronVersion)
  console.log(
    `[build-app] packaging with Electron ${electronVersion} ` +
      (cacheZip ? `(cached zip: ${cacheZip})` : '(no cached zip found: packager will DOWNLOAD it)'),
  )
  if (!existsSync(join(ROOT, 'desktop', 'main.mjs'))) {
    console.warn('[build-app] WARNING: desktop/main.mjs does not exist yet; the packaged app will not start until it does.')
  }
  prepareModuleFilter()
  console.log(
    `[build-app] node_modules: ${KEEP_MODULES.size} run-time packages; not walked (front end, bundled in dist/): ` +
      `${FRONT_END_ONLY.join(', ')}; never packaged: ${[...NEVER_PACKAGE].join(', ')}`,
  )

  const appPaths = await packager({
    dir: ROOT,
    out: OUT_DIR,
    name: APP_NAME,
    executableName: APP_NAME,
    platform: 'win32',
    arch: 'x64',
    icon: join(ROOT, 'desktop', 'app-icon.ico'),
    asar: false,
    // Pruning is done by `ignore` (runtimeModules above), which also keeps
    // peer dependencies; packager's own prune would drop them.
    prune: false,
    overwrite: true,
    electronVersion,
    appVersion: pkg.version,
    win32metadata: {
      // The packager refuses to build for Windows without a CompanyName here or an
      // `author` in package.json. This is the app's own name, not a company.
      CompanyName: APP_NAME,
      FileDescription: APP_NAME,
      ProductName: APP_NAME,
      InternalName: APP_NAME,
      OriginalFilename: `${APP_NAME}.exe`,
    },
    ignore,
    afterCopy: [stubMissingMain],
  })
  return { appPath: appPaths[0], electronVersion, downloaded: !cacheZip }
}

/**
 * Packager refuses to finish when package.json's "main" is missing. While
 * desktop/main.mjs is still being written, put a clearly marked placeholder
 * into the PACKAGED copy only (never the source tree) that logs and quits, so
 * the rest of the build can be checked. Rebuild once the real file exists.
 */
async function stubMissingMain({ buildPath }) {
  const main = JSON.parse(readFileSync(join(buildPath, 'package.json'), 'utf8')).main || 'index.js'
  const target = join(buildPath, main)
  if (existsSync(target)) return
  console.warn(`[build-app] WARNING: ${main} missing; packaged a PLACEHOLDER that quits at once. Rebuild when it exists.`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    "// PLACEHOLDER written by scripts/build-app.mjs: the real desktop/main.mjs did not exist at build time.\n" +
      "import { app } from 'electron'\n" +
      "console.error('Venom OS: this build has no desktop/main.mjs; rebuild with node scripts/build-app.mjs')\n" +
      'app.exit(3)\n',
  )
}

/** The Electron zip in @electron/get's default cache, if any. */
function findCachedZip(version) {
  const base = process.env.electron_config_cache || join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
  const name = `electron-v${version}-win32-x64.zip`
  if (!existsSync(base)) return null
  for (const d of readdirSync(base)) {
    const f = join(base, d, name)
    if (existsSync(f)) return f
  }
  return existsSync(join(base, name)) ? join(base, name) : null
}

/** { bytes, files } of a folder (no symlink following). */
function measure(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        bytes += lstatSync(p).size
        files++
      }
    }
  }
  return { bytes, files }
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB'

function report(appPath) {
  const exe = join(appPath, `${APP_NAME}.exe`)
  const total = measure(appPath)
  console.log('\n[build-app] done in ' + secs())
  console.log(`  output folder: ${appPath}`)
  console.log(`  exe:           ${exe}${existsSync(exe) ? '' : '  (MISSING!)'}`)
  console.log(`  total:         ${mb(total.bytes)} in ${total.files} files`)
  const app = join(appPath, 'resources', 'app')
  const nm = join(app, 'node_modules')
  if (existsSync(app)) {
    const a = measure(app)
    console.log(`  resources/app: ${mb(a.bytes)} in ${a.files} files`)
  }
  if (existsSync(nm)) {
    const sizes = []
    for (const e of readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      sizes.push({ name: e.name, ...measure(join(nm, e.name)) })
    }
    sizes.sort((x, y) => y.bytes - x.bytes)
    console.log('  largest top-level folders in resources/app/node_modules:')
    for (const s of sizes.slice(0, 5)) console.log(`    ${mb(s.bytes).padStart(10)}  ${s.name} (${s.files} files)`)
  }
  // What the app needs at run time, and what must not be there.
  const must = [
    'package.json', 'desktop/main.mjs', 'desktop/app-icon.ico', 'desktop/build-info.json', 'bridge/server.mjs',
    'hermes-mcp/server.mjs', 'dist/index.html', 'node_modules/ws', 'node_modules/zod',
    'node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64',
    'node_modules/@modelcontextprotocol/sdk', 'node_modules/@huggingface/transformers',
    'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node', 'node_modules/sharp',
  ]
  const mustNot = ['src', 'test', 'scripts', 'public', 'docs', '.git', 'desktop/models', 'node_modules/electron', 'node_modules/@electron', 'index.html', 'vite.config.ts']
  const missing = must.filter((f) => !existsSync(join(app, f)))
  const extra = mustNot.filter((f) => existsSync(join(app, f)))
  if (missing.length) console.warn(`  WARNING: missing from resources/app: ${missing.join(', ')}`)
  if (extra.length) console.warn(`  WARNING: should not be in resources/app: ${extra.join(', ')}`)
  if (!missing.length && !extra.length) console.log('  contents check: OK')
  if (missing.length || extra.length) process.exitCode = 1
}

try {
  vendorWasm()
  if (!skipWeb) await buildWeb()
  else if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Error('--skip-web given but dist/index.html is missing')
  if (webOnly) {
    console.log(`[build-app] --web-only: stopping before packaging (${secs()})`)
  } else {
    writeBuildInfo()
    const { appPath } = await packageApp()
    report(appPath)
  }
} catch (err) {
  console.error('[build-app] FAILED:', err?.stack || err)
  process.exitCode = 1
}
