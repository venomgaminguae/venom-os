import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { ortRuntime } from './scripts/ort-runtime.mjs'

// https://vite.dev/config/
export default defineConfig({
  // ortRuntime: the ONNX runtime for Kokoro, from node_modules at /ort/.
  plugins: [react(), ortRuntime()],
  // window.__venomAsk (src/App.tsx) is compiled out here. Only
  // scripts/voice-proof.vite.config.mjs sets this to true.
  define: { __VENOM_PROOF_ASK__: 'false' },
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set VENOM_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // The packaged desktop app (release/) holds a copy of the built page;
    // rebuilding it must not reload the live window.
    watch: { ignored: ['**/release/**'] },
  },
  optimizeDeps: {
    // Only the app's own page: without this Vite also scans the built
    // index.html inside release/ at start-up.
    entries: ['index.html'],
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
