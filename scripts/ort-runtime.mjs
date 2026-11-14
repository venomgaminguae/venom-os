// The ONNX runtime for the Kokoro voice, served from the app's own origin.
//
// transformers.js (which kokoro-js runs on) fetches these two files from
// cdn.jsdelivr.net unless told where else they are, and running a script from
// an outside host would need that host in the page's script-src. Instead the
// installed package's own copies are served at /ort/ (dev server) and emitted
// to dist/ort/ (build); src/lib/kokoro.ts points the runtime there with
// `env.wasmPaths`, the setting the package documents for this.
//
// Used by vite.config.ts and scripts/voice-proof.vite.config.mjs alike.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

export const ORT_BASE = '/ort/'
export const ORT_FILES = Object.freeze({
  'ort-wasm-simd-threaded.jsep.mjs': 'text/javascript',
  'ort-wasm-simd-threaded.jsep.wasm': 'application/wasm',
})

/** The folder of the installed @huggingface/transformers build that holds them. */
export function ortDir(root = process.cwd()) {
  const require = createRequire(path.join(root, 'package.json'))
  // The package's exports hide package.json; its entry file sits in dist/.
  return path.dirname(require.resolve('@huggingface/transformers'))
}

/** Absolute path for a request URL, or null. Only the two names above, never a path. */
export function ortFile(url, root = process.cwd()) {
  const pathname = String(url ?? '').split(/[?#]/)[0]
  if (!pathname.startsWith(ORT_BASE)) return null
  const name = pathname.slice(ORT_BASE.length)
  if (!Object.hasOwn(ORT_FILES, name)) return null
  return path.join(ortDir(root), name)
}

export function ortRuntime() {
  let root = process.cwd()
  return {
    name: 'venom-ort-runtime',
    configResolved(config) {
      root = config.root
    },
    configureServer(server) {
      // Registered before Vite's own middlewares, so the .mjs goes out as it
      // is on disk instead of through the module transform.
      server.middlewares.use((req, res, next) => {
        const file = (req.method === 'GET' || req.method === 'HEAD') && ortFile(req.url, root)
        if (!file) return next()
        let stat
        try {
          stat = fs.statSync(file)
        } catch {
          res.statusCode = 404
          return res.end('ONNX runtime file missing; run npm install')
        }
        const name = path.basename(file)
        res.setHeader('Content-Type', ORT_FILES[name])
        res.setHeader('Content-Length', stat.size)
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        if (req.method === 'HEAD') return res.end()
        fs.createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const name of Object.keys(ORT_FILES)) {
        this.emitFile({ type: 'asset', fileName: ORT_BASE.slice(1) + name, source: fs.readFileSync(path.join(ortDir(root), name)) })
      }
    },
  }
}
