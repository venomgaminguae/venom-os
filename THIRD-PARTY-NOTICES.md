# Third-party notices

VENOM's own code is MIT (see `LICENSE`). This file lists every third-party
asset that is **committed to this repository**, and every model, runtime or
font the app **downloads or references at run time**, with its licence and the
evidence checked. Items whose licence could not be confirmed are collected
under [Unconfirmed](#unconfirmed). Do not treat them as cleared.

Audit date: 2026-11-13. "node_modules" evidence means the licence field or
licence file of the installed package; URLs are the pages actually opened.

## 1. Assets committed to this repository

| Asset | Path | What it is | Licence | Redistribution in a public MIT repo | Evidence |
|---|---|---|---|---|---|
| Boot music | `public/audio/boot-music.mp3` | "Impact Prelude", Kevin MacLeod (ISRC USUAN1100617) | CC BY 4.0 | Yes, with attribution (kept in `public/audio/CREDITS.md`) | https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100617 |
| Ambient bed | `public/audio/ambient.mp3` | "Ossuary 6 - Air", Kevin MacLeod (ISRC USUAN1500048) | CC BY 4.0 | Yes, with attribution | https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1500048 |
| Work music | `public/audio/work.mp3` | "Mechanolith", Kevin MacLeod (ISRC USUAN1100879) | CC BY 4.0 | Yes, with attribution | https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100879 |
| Favicon | `public/favicon.svg` | The Vite lightning-bolt logo (purple bolt, same path data as `src/assets/vite.svg`) | MIT, as part of the create-vite template (Vite repository: "Copyright (c) 2019-present, VoidZero Inc. and Vite contributors") | Yes | Byte-identical (line endings aside) to https://raw.githubusercontent.com/vitejs/vite/main/packages/create-vite/template-react-ts/public/favicon.svg ; https://github.com/vitejs/vite/blob/main/LICENSE . The logo is Vite's mark: replace it if you rebrand |
| Vite logo | `src/assets/vite.svg` | The Vite logo (`<title>Vite</title>`), as shipped by the create-vite template | MIT, as above | Yes | Byte-identical (line endings aside) to `src/assets/vite.svg` in the same create-vite template |

The three tracks match the names and licence in `public/audio/CREDITS.md`
(each incompetech page shows the attribution code "Licensed under Creative
Commons: By Attribution 4.0 License"). I did not compare the audio content of
the MP3 files against the originals.

## 2. Downloaded or referenced at run time (not committed)

| Component | Where it comes from | Licence | Redistribution | Evidence |
|---|---|---|---|---|
| Kokoro TTS weights + voices | Hugging Face `onnx-community/Kokoro-82M-v1.0-ONNX` (downloaded by the browser via kokoro-js; id in `src/lib/kokoro.ts`, `scripts/speech-roundtrip.mjs`) | Apache-2.0 (ONNX conversion and base model `hexgrad/Kokoro-82M`) | Not redistributed here; download is allowed | https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX (`license:apache-2.0`), https://huggingface.co/hexgrad/Kokoro-82M ("Apache-licensed weights") |
| kokoro-js | npm, `node_modules/kokoro-js` (also ships `voices/*.bin`) | Apache-2.0 | npm dependency, not committed | node_modules/kokoro-js/LICENSE, package.json |
| phonemizer (used by kokoro-js) | npm, `node_modules/phonemizer`; eSpeak NG compiled to WASM | Package: Apache-2.0. See Unconfirmed for the embedded eSpeak NG | npm dependency, not committed | node_modules/phonemizer/LICENSE; https://github.com/xenova/phonemizer.js |
| Whisper (local hearing) | `onnx-community/whisper-base.en` (default `VENOM_STT_MODEL`, `bridge/stt-local.mjs`), placed by the user in `desktop/models/` (git-ignored) | Base model `openai/whisper-base.en`: Apache-2.0. The ONNX repo carries no licence tag of its own | Not committed; never downloaded automatically | https://huggingface.co/api/models/openai/whisper-base.en (`license:apache-2.0`); https://huggingface.co/api/models/onnx-community/whisper-base.en (no licence field) |
| transformers.js | npm `@huggingface/transformers` 3.8.1 | Apache-2.0 | npm dependency | node_modules package.json |
| ONNX Runtime | npm `onnxruntime-web` (browser, Kokoro) and `onnxruntime-node` (bridge, Whisper) | MIT | Not committed: `scripts/ort-runtime.mjs` serves the files from node_modules at `/ort/` in dev and emits them into `dist/ort/` on build (`dist` is git-ignored). No `public/ort` exists | node_modules package.json |
| MediaPipe Tasks Vision (hand tracking runtime) | npm `@mediapipe/tasks-vision`; `scripts/start.mjs` copies its `wasm/` into `public/mediapipe/` (git-ignored) | Apache-2.0 | npm dependency, copy is git-ignored | node_modules package.json |
| MediaPipe hand landmarker model | Fetched at run time from `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` (`src/lib/hands.ts`) | See Unconfirmed | Not committed | Could not open a model card stating its licence |
| Fonts: Chakra Petch, JetBrains Mono | Remote, Google Fonts CSS imported in `src/index.css` (`fonts.googleapis.com` / `fonts.gstatic.com`, allowed in the CSP in `index.html`). No font files are bundled | SIL OFL 1.1 | Not redistributed | https://raw.githubusercontent.com/google/fonts/main/ofl/chakrapetch/METADATA.pb, https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/METADATA.pb (`license: "OFL"`) |
| ElevenLabs voice "George" (`JBFqnCBsd6RMkjVDRZzb`) | ElevenLabs API, only with the user's own key | ElevenLabs terms of service | Only the public stock voice id is in the code; no audio is committed | n/a (remote service) |

## 3. npm dependencies

`package-lock.json` lists 386 packages, counting the platform-specific
optional binaries for every system (npm installs only the ones that match
yours). Their licence fields, read from the lock: 273 MIT, 26 Apache-2.0,
17 BSD-3-Clause, 15 ISC, 4 BSD-2-Clause, and the following others:

| Package | Licence | Why it is here | Notes |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` (+ `-win32-x64`) 0.3.321 | Proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements" | Runtime dependency of the bridge | Installed from npm by each user; not redistributed in this repo. Its use is governed by Anthropic's Commercial Terms, not MIT |
| `sharp` 0.34.5 / `@img/sharp-win32-x64` | Apache-2.0; the prebuilt libvips binary is LGPL-3.0-or-later | Pulled in by `@huggingface/transformers` | Not committed; LGPL binary is dynamically used, not shipped by this repo |
| `dompurify` 3.4.17 | MPL-2.0 OR Apache-2.0 | Runtime (HTML sanitising) | Use under Apache-2.0 |
| `lightningcss` 1.33.0 (+ win32 binary) | MPL-2.0 | Build tool (via Vite) | Dev/build only, not bundled into the app |
| `postprocessing` 6.39.4 | Zlib | Runtime (3D effects) | Permissive |
| `webgl-constants` 1.1.1 | No licence field; LICENSE file is MIT | via `detect-gpu` | Permissive |
| `chownr`, `minipass`, `tar`, `yallist`, `glob`, `minimatch`, `path-scurry`, `lru-cache`, `graceful-fs`, `@isaacs/nonrecursive-glob-match` | BlueOak-1.0.0 | Transitive | Permissive |
| `fast-sha256` | Unlicense | Transitive | Public-domain dedication |
| `electron` 45.3.1 (MIT), `@electron/packager` 20.3.0 (BSD-2-Clause) | see left | Dev dependencies for the desktop app | Not committed. A folder built with `npm run app:build` contains the Electron runtime (Chromium, FFmpeg and others under their own licences; Electron puts `LICENSE` and `LICENSES.chromium.html` in the folder), the production `node_modules`, and Anthropic's proprietary Claude Code program from `@anthropic-ai/claude-agent-sdk-win32-x64`. This repository ships no built folder; check those terms before you pass one on |
| `tslib` | 0BSD | Transitive | Permissive |
| `type-fest` 0.13.1 | MIT OR CC0-1.0 | Transitive | Permissive |

Three.js (`three`, MIT), React (`react`, MIT), `@react-three/*` (MIT),
`framer-motion` (MIT), `zustand` (MIT), `ws` (MIT), `zod` (MIT),
`@anthropic-ai/sdk` (MIT) and `@modelcontextprotocol/sdk` 1.32.2 (MIT, used
by the team connector in `hermes-mcp/`) are all under permissive licences. No
node_modules content is committed.

## Unconfirmed

1. **App icon**: the working copy this repository was made from has a Windows
   icon (`assets/venom.ico`) whose origin and licence could not be confirmed,
   so it is left out, and so is the desktop app's icon in that working copy
   (`desktop/icon.ico`), for the same reason. In their place `desktop/app-icon.ico` is a
   placeholder drawn from plain shapes by `scripts/make-icon.mjs` in this
   repository (same bytes on every run), under this project's licence. Replace
   that file with your own `.ico` if you want a different icon.
2. **MediaPipe `hand_landmarker.task`**: fetched from Google's storage bucket at
   run time. Licence not confirmed (the model-card page could not be opened).
   Not committed, so redistribution is not at stake, only use.
3. **eSpeak NG inside `phonemizer`**: the npm package is labelled Apache-2.0,
   but it embeds eSpeak NG, whose upstream licence I did not verify (eSpeak NG
   is commonly reported as GPL-3.0). Not committed here; it matters only if
   someone redistributes a built bundle.
4. **`onnx-community/whisper-base.en`**: the ONNX repo has no licence tag; I
   relied on its base model `openai/whisper-base.en` (Apache-2.0 on Hugging Face).
5. **Audio files**: names and licence verified on incompetech.com; the MP3
   content itself was not compared against the originals.
