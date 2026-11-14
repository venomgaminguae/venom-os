// Vite config for scripts/mic-proof.mjs only. The app's own vite.config.ts
// (so every compile-time flag is exactly the normal one), plus a strict port
// and a dependency cache in a scratch folder: the default node_modules/.vite
// belongs to the live dev server, and node_modules is shared with it.
import { mergeConfig } from 'vite'
import base from '../vite.config.ts'

const port = Number(process.env.MIC_PROOF_PORT)
const cacheDir = process.env.MIC_PROOF_CACHE
if (!port || !cacheDir) throw new Error('mic-proof.vite.config: MIC_PROOF_PORT and MIC_PROOF_CACHE are required')
if (port === 5173) throw new Error('mic-proof.vite.config: 5173 belongs to the live app')
if (/node_modules/i.test(cacheDir)) throw new Error('mic-proof.vite.config: cacheDir must be outside node_modules')

export default mergeConfig(base, {
  cacheDir,
  clearScreen: false,
  server: { port, strictPort: true, host: 'localhost', hmr: false },
})
