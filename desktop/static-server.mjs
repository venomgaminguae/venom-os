/**
 * The desktop app's face: a tiny static server for the built interface (dist/).
 *
 * Plain node:http, no dependency, so it runs inside Electron's main process and
 * under `node --test` alike. It is deliberately narrow:
 *   - bound to 127.0.0.1 only, GET/HEAD only;
 *   - a Host header other than localhost:<port> / 127.0.0.1:<port> is refused,
 *     so a DNS-rebinding page on another name cannot read it;
 *   - every path is resolved against the real dist folder and must stay inside
 *     it (no \0, no backslash, no `..` segment raw or encoded, no symlink escape);
 *   - index.html is rewritten per request: the CSP's :8787 becomes the app's own
 *     bridge port (inside the CSP meta only), and window.__VENOM_DESKTOP__ is
 *     injected first in <head> so the page knows which bridge to talk to. With
 *     `silent` a silence guard follows it, before any module script runs.
 *     index.html is never cached.
 */

import http from 'node:http'
import { createReadStream, promises as fsp, realpathSync } from 'node:fs'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
}

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * The silence guard, run in the page before any module. It is stringified into
 * an inline script, so it must be self-contained (no closure over this module).
 *
 * Windows speech voices are played by the OS, not through Chromium's audio
 * output, so --mute-audio does not silence them: every utterance is forced to
 * volume 0 at speak() time. Media elements are forced muted, and every Web
 * Audio path to a live AudioContext's speakers goes through a zero-gain node
 * (the approach scripts/voice-proof.mjs uses). window.__VENOM_SILENT__ is set
 * last, and only when every guard is in place.
 */
function venomSilentGuard(capture) {
  'use strict'
  var w = typeof window !== 'undefined' ? window : globalThis
  var ok = { speech: false, media: false, webaudio: false }
  // capture (VENOM_APP_CAPTURE=1 with VENOM_APP_SILENT=1): speech stays at volume 0, but media
  // elements and Web Audio are left live so a test can record the page's own audio graph. The
  // room stays silent through Chromium's mute (--mute-audio, setAudioMuted; main.mjs checks it).
  capture = capture === true
  var refuse = function () {
    throw new Error('venom silent mode: speech is disabled')
  }

  // 1. Speech synthesis: volume 0 on every utterance, or no speech at all.
  try {
    var ss = w.speechSynthesis
    if (!ss) {
      ok.speech = true // no engine, nothing can speak
    } else {
      try {
        var origSpeak = ss.speak
        if (typeof origSpeak !== 'function') throw new Error('speechSynthesis.speak is not a function')
        var speak = function (u) {
          u.volume = 0
          if (u.volume !== 0) throw new Error('venom silent mode: refusing to speak at volume ' + u.volume)
          // Later writes to this utterance's volume are swallowed; the engine keeps 0.
          try {
            Object.defineProperty(u, 'volume', { get: function () { return 0 }, set: function () {}, configurable: false })
          } catch (e) {}
          return origSpeak.call(ss, u)
        }
        Object.defineProperty(ss, 'speak', { value: speak, writable: false, configurable: false })
        if (ss.speak !== speak) throw new Error('speak wrapper did not stick')
        // The prototype too, so speak.call(speechSynthesis, u) cannot go round it.
        try {
          var ssProto = Object.getPrototypeOf(ss)
          if (ssProto && ssProto !== Object.prototype) Object.defineProperty(ssProto, 'speak', { value: speak, writable: false, configurable: false })
        } catch (e) {}
        ok.speech = true
      } catch (e) {
        // Could not wrap: speak() must throw instead of speaking at full volume.
        try {
          Object.defineProperty(ss, 'speak', { value: refuse, writable: false, configurable: false })
        } catch (e2) {}
        if (ss.speak !== refuse) {
          try {
            var proto = Object.getPrototypeOf(ss)
            if (proto) Object.defineProperty(proto, 'speak', { value: refuse, writable: false, configurable: false })
          } catch (e3) {}
        }
      }
    }
  } catch (e) {}

  // 2. Media elements: muted with volume 0 whenever they play, and kept that way.
  try {
    var ME = w.HTMLMediaElement
    if (capture) {
      ok.media = true // capture: left live; Chromium's mute keeps the room silent
    } else if (typeof ME !== 'function') {
      ok.media = true // no media elements in this realm
    } else {
      var mp = ME.prototype
      var origPlay = mp.play
      var hush = function (el) {
        try {
          if (!el.muted) el.muted = true
          if (el.volume !== 0) el.volume = 0
        } catch (e) {}
      }
      var play = function () {
        this.muted = true
        this.volume = 0
        return origPlay.apply(this, arguments)
      }
      mp.play = play
      // autoplay starts without play(); unmuting later fires volumechange.
      if (typeof w.addEventListener === 'function') {
        var onEvent = function (ev) {
          var t = ev && ev.target
          if (t instanceof ME) hush(t)
        }
        w.addEventListener('play', onEvent, true)
        w.addEventListener('volumechange', onEvent, true)
      }
      ok.media = mp.play === play
    }
  } catch (e) {}

  // 3. Web Audio: a connection to a live AudioContext's destination goes through
  //    a zero-gain node instead. Other connections (analyser taps, offline
  //    rendering) are untouched.
  try {
    var AN = w.AudioNode
    if (capture) {
      ok.webaudio = true // capture: left live; Chromium's mute keeps the room silent
    } else if (typeof AN !== 'function') {
      ok.webaudio = true // no Web Audio in this realm
    } else {
      var np = AN.prototype
      var origConnect = np.connect
      var origDisconnect = np.disconnect
      var mutes = new WeakMap()
      var liveDest = function (dest) {
        if (!dest || typeof dest !== 'object') return null
        var ctx
        try {
          ctx = dest.context
        } catch (e) {
          return null
        }
        if (!ctx || ctx.destination !== dest) return null
        if (typeof w.OfflineAudioContext === 'function' && ctx instanceof w.OfflineAudioContext) return null
        return ctx
      }
      var muteFor = function (ctx) {
        var g = mutes.get(ctx)
        if (!g) {
          g = ctx.createGain()
          g.gain.value = 0
          origConnect.call(g, ctx.destination)
          mutes.set(ctx, g)
        }
        return g
      }
      var connect = function (dest) {
        var ctx = liveDest(dest)
        if (ctx) {
          var rest = Array.prototype.slice.call(arguments, 1)
          // A zero-gain node has one input: keep the output index, drop the input index.
          origConnect.call(this, muteFor(ctx), rest.length ? rest[0] : 0)
          return dest
        }
        return origConnect.apply(this, arguments)
      }
      np.connect = connect
      if (typeof origDisconnect === 'function') {
        np.disconnect = function (dest) {
          var ctx = liveDest(dest)
          if (ctx && mutes.has(ctx)) {
            var rest = Array.prototype.slice.call(arguments, 1)
            return origDisconnect.apply(this, [mutes.get(ctx)].concat(rest.slice(0, 1)))
          }
          return origDisconnect.apply(this, arguments)
        }
      }
      ok.webaudio = np.connect === connect
    }
  } catch (e) {}

  // 4. Only when every guard is in place.
  if (ok.speech && ok.media && ok.webaudio) {
    try {
      Object.defineProperty(w, '__VENOM_SILENT__', { value: true, writable: false, configurable: false, enumerable: true })
    } catch (e) {
      w.__VENOM_SILENT__ = true
    }
    if (capture) {
      try {
        Object.defineProperty(w, '__VENOM_CAPTURE__', { value: true, writable: false, configurable: false, enumerable: true })
      } catch (e) {
        w.__VENOM_CAPTURE__ = true
      }
    }
  } else if (w.console && typeof w.console.error === 'function') {
    w.console.error('venom silent mode: guard incomplete', JSON.stringify(ok))
  }
}

/** The guard as inline-script source. Checked so it can never end its <script> early. */
export const SILENT_GUARD_SOURCE = `(${venomSilentGuard.toString()})();`
if (/<\/script|<!--/i.test(SILENT_GUARD_SOURCE)) throw new Error('silent guard contains script-breaking text')
/** The guard in capture mode: speech at volume 0, the page's own audio graph left live. */
export const CAPTURE_GUARD_SOURCE = `(${venomSilentGuard.toString()})(true);`
if (/<\/script|<!--/i.test(CAPTURE_GUARD_SOURCE)) throw new Error('capture guard contains script-breaking text')

function checkPort(bridgePort) {
  const port = Number(bridgePort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad bridge port ${bridgePort}`)
  return port
}

/**
 * index.html as the desktop app serves it: CSP on the app's bridge port, config (and guard) injected.
 * capture only counts with silent: without silent the page is exactly what it is without capture.
 */
export function rewriteIndex(html, bridgePort, { silent = false, capture = false } = {}) {
  const port = checkPort(bridgePort)
  // Only inside the CSP meta: comments elsewhere mention :8787 too, harmlessly.
  const out = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][\s\S]*?>/i, (meta) =>
    meta.replaceAll(':8787', `:${port}`),
  )
  const config = JSON.stringify({ bridgeUrl: `ws://127.0.0.1:${port}`, wakeRoute: 'local' })
  let tags = `<script>window.__VENOM_DESKTOP__=Object.freeze(${config})</script>`
  if (silent) tags += `<script>${capture === true ? CAPTURE_GUARD_SOURCE : SILENT_GUARD_SOURCE}</script>`
  const head = /<head(\s[^>]*)?>/i
  if (!head.test(out)) throw new Error('index.html has no <head>')
  return out.replace(head, (m) => `${m}${tags}`)
}

function hostAllowed(host, port) {
  if (typeof host !== 'string') return false
  const h = host.toLowerCase()
  return h === `localhost:${port}` || h === `127.0.0.1:${port}`
}

/** Map a URL path to a file under root, or null if it is not a safe path. */
function resolveSafe(root, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  if (decoded.includes('\\')) return null
  // Any `..` segment, raw or encoded, is refused outright rather than normalised.
  if (decoded.split('/').some((seg) => seg === '..')) return null
  const rel = decoded.replace(/^\/+/, '')
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return full
}

/**
 * Serve distDir (the folder holding index.html) on host (127.0.0.1).
 * port 0 picks a free one. Resolves to { port, address, close() }.
 */
export async function startStaticServer({ distDir, port = 0, bridgePort, silent = false, capture = false, host = '127.0.0.1' } = {}) {
  if (!distDir) throw new Error('distDir is required')
  if (bridgePort == null) throw new Error('bridgePort is required')
  checkPort(bridgePort)
  // .native, like fsp.realpath below: the JS realpathSync keeps 8.3 short names
  // (C:\Users\LONGNA~1) and the containment check would then fail on every file.
  const distRoot = realpathSync.native(path.resolve(distDir))
  const indexPath = path.join(distRoot, 'index.html')
  let actualPort = port

  const server = http.createServer(async (req, res) => {
    const deny = (code, msg) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : msg)
    }
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        return deny(405, 'method not allowed')
      }
      if (!hostAllowed(req.headers.host, actualPort)) return deny(403, 'forbidden host')

      const urlPath = (req.url ?? '/').split('?')[0].split('#')[0]
      if (!urlPath.startsWith('/')) return deny(400, 'bad request')
      const file = resolveSafe(distRoot, urlPath === '/' ? '/index.html' : urlPath)
      if (!file) return deny(404, 'not found')

      let real
      try {
        real = await fsp.realpath(file)
      } catch {
        return deny(404, 'not found')
      }
      if (real !== distRoot && !real.startsWith(distRoot + path.sep)) return deny(404, 'not found')
      let stat = await fsp.stat(real)
      if (stat.isDirectory()) {
        // Resolve again: a link named index.html must not lead out of dist.
        try {
          real = await fsp.realpath(path.join(real, 'index.html'))
          stat = await fsp.stat(real)
        } catch {
          return deny(404, 'not found')
        }
        if (!real.startsWith(distRoot + path.sep)) return deny(404, 'not found')
      }
      if (!stat.isFile()) return deny(404, 'not found')

      const common = {
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      }

      if (real.toLowerCase() === indexPath.toLowerCase()) {
        const html = rewriteIndex(await fsp.readFile(real, 'utf8'), bridgePort, { silent, capture })
        const body = Buffer.from(html, 'utf8')
        res.writeHead(200, {
          ...common,
          'content-type': MIME['.html'],
          'content-length': body.length,
          'cache-control': 'no-store',
        })
        return res.end(req.method === 'HEAD' ? undefined : body)
      }

      const headers = {
        ...common,
        'content-type': mimeFor(real),
        'accept-ranges': 'bytes',
        'cache-control': urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      }
      const size = stat.size
      const range = req.headers.range
      const m = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
      if (m && (m[1] !== '' || m[2] !== '')) {
        let start
        let end
        if (m[1] === '') {
          start = Math.max(0, size - Number(m[2]))
          end = size - 1
        } else {
          start = Number(m[1])
          end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
        }
        if (start > end || start >= size) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
          return res.end()
        }
        res.writeHead(206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': end - start + 1,
        })
        if (req.method === 'HEAD') return res.end()
        return createReadStream(real, { start, end }).on('error', () => res.destroy()).pipe(res)
      }
      res.writeHead(200, { ...headers, 'content-length': size })
      if (req.method === 'HEAD') return res.end()
      createReadStream(real).on('error', () => res.destroy()).pipe(res)
    } catch {
      if (!res.headersSent) deny(500, 'error')
      else res.destroy()
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  actualPort = server.address().port

  return {
    port: actualPort,
    address: server.address(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
