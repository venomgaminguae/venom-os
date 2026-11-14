// Vite config for scripts/voice-proof.mjs only. Same app as vite.config.ts,
// but: its own port (strict), its own dependency cache in a scratch folder
// (the default node_modules/.vite belongs to the live dev server), and the
// page CSP widened to the scratch bridge on 8797, and window.__venomAsk
// switched on (the one place that is: see src/App.tsx).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { ortRuntime } from './ort-runtime.mjs'

const port = Number(process.env.VOICE_PROOF_PORT)
const cacheDir = process.env.VOICE_PROOF_CACHE
if (!port || !cacheDir) throw new Error('voice-proof.vite.config: VOICE_PROOF_PORT and VOICE_PROOF_CACHE are required')
if (port === 5173) throw new Error('voice-proof.vite.config: 5173 belongs to the live app')

export default defineConfig({
  plugins: [
    react(),
    ortRuntime(),
    {
      name: 'voice-proof-csp',
      transformIndexHtml(html) {
        // Only connect-src: the same 8787 pair also appears in frame-src,
        // img-src and media-src, so a plain replace() would widen the wrong one.
        const out = html.replace(/(connect-src[^;]*)/, '$1 http://localhost:8797 http://127.0.0.1:8797')
        if (out === html) throw new Error('voice-proof.vite.config: no connect-src in index.html')
        return out
      },
    },
  ],
  cacheDir,
  define: { __VENOM_PROOF_ASK__: 'true' },
  clearScreen: false,
  server: { port, strictPort: true, host: 'localhost', hmr: false },
  optimizeDeps: {
    // As in vite.config.ts: phonemizer's inline espeak WASM breaks when pre-bundled.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
