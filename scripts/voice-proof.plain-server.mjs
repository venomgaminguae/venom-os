// The app exactly as vite.config.ts serves it, for check 6 of
// scripts/voice-proof.mjs (no ask hook on a normally served page). Only the
// port and the dependency cache differ: the default cache in
// node_modules/.vite belongs to the live dev server.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.VOICE_PROOF_PORT)
const cacheDir = process.env.VOICE_PROOF_CACHE
if (!port || !cacheDir) throw new Error('voice-proof.plain-server: VOICE_PROOF_PORT and VOICE_PROOF_CACHE are required')
if (port === 5173) throw new Error('voice-proof.plain-server: 5173 belongs to the live app')

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  cacheDir,
  clearScreen: false,
  server: { port, strictPort: true, host: 'localhost', hmr: false },
})
await server.listen()
console.log(`plain server on http://localhost:${port}/ (vite.config.ts)`)
