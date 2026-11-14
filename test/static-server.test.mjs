// desktop/static-server.mjs: the desktop app's local server for dist/.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import vm from 'node:vm'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startStaticServer, rewriteIndex, mimeFor, SILENT_GUARD_SOURCE, CAPTURE_GUARD_SOURCE } from '../desktop/static-server.mjs'

const CSP_PORT = 8787 // the port index.html's CSP names; plain data here, nothing connects to it
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- the bridge on localhost:8787 is framed too -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'unsafe-inline';
        connect-src 'self' http://localhost:8787 http://127.0.0.1:8787
        ws://localhost:${CSP_PORT};
        img-src 'self' http://localhost:8787;"
    />
    <script type="module" crossorigin src="/assets/index-x.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`

const BRIDGE = 8797
let root
let distDir
let srv
let silentSrv
let captureOnlySrv
let captureSrv

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'venom-static-'))
  distDir = path.join(root, 'dist')
  mkdirSync(path.join(distDir, 'mediapipe'), { recursive: true })
  mkdirSync(path.join(distDir, 'assets'), { recursive: true })
  writeFileSync(path.join(distDir, 'index.html'), INDEX)
  writeFileSync(path.join(distDir, 'mediapipe', 'x.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  writeFileSync(path.join(distDir, 'assets', 'a.js'), 'console.log(1)')
  writeFileSync(path.join(root, 'secret.txt'), 'outside dist')
  srv = await startStaticServer({ distDir, port: 0, bridgePort: BRIDGE })
  silentSrv = await startStaticServer({ distDir, port: 0, bridgePort: BRIDGE, silent: true })
  captureOnlySrv = await startStaticServer({ distDir, port: 0, bridgePort: BRIDGE, capture: true })
  captureSrv = await startStaticServer({ distDir, port: 0, bridgePort: BRIDGE, silent: true, capture: true })
})

after(async () => {
  await srv?.close()
  await silentSrv?.close()
  await captureOnlySrv?.close()
  await captureSrv?.close()
  rmSync(root, { recursive: true, force: true })
})

/** Raw request: fetch() would normalise `..` and refuse to set Host. */
function req({ server = srv, method = 'GET', p = '/', host = `localhost:${server.port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: server.port, method, path: p, headers: { host, ...headers }, setHost: false },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    r.on('error', reject)
    r.end()
  })
}

const cspOf = (html) => /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/.exec(html)[0]
const configOf = (html) =>
  JSON.parse(/<script>window\.__VENOM_DESKTOP__=Object\.freeze\((\{.*?\})\)<\/script>/.exec(html)[1])

test('index.html: CSP points at the app bridge and the desktop config is injected first in <head>', async () => {
  for (const p of ['/', '/index.html']) {
    const res = await req({ p })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /^text\/html/)
    assert.equal(res.headers['cache-control'], 'no-store')
    const html = res.body.toString()
    const csp = cspOf(html)
    assert.ok(!csp.includes(':8787'), 'no :8787 left in the CSP')
    assert.ok(csp.includes(`http://localhost:${BRIDGE}`) && csp.includes(`http://127.0.0.1:${BRIDGE}`))
    assert.ok(csp.includes(`ws://localhost:${BRIDGE}`))
    assert.ok(html.includes('<head><script>window.__VENOM_DESKTOP__=Object.freeze('), 'script is the first thing in <head>')
    assert.deepEqual(configOf(html), { bridgeUrl: `ws://127.0.0.1:${BRIDGE}`, wakeRoute: 'local' })
    assert.ok(!html.includes('__VENOM_SILENT__'), 'no guard without silent')
  }
})

test('rewriteIndex: config has wakeRoute local and the given bridge port, no tts field', () => {
  const cfg = configOf(rewriteIndex(INDEX, 8788))
  assert.deepEqual(cfg, { bridgeUrl: 'ws://127.0.0.1:8788', wakeRoute: 'local' })
  assert.equal('tts' in cfg, false)
})

test('rewriteIndex: :8787 is rewritten only inside the CSP meta', () => {
  const html = rewriteIndex(INDEX, 8788)
  assert.ok(html.includes('<!-- the bridge on localhost:8787 is framed too -->'), 'comment untouched')
  assert.ok(!cspOf(html).includes(':8787'))
  assert.equal(html.split(':8788').length - 1, 5, 'four CSP hits + the config')
  // Everything outside the CSP meta and the injected script is byte-identical.
  const strip = (s) => s.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/, '').replace(/<script>window[\s\S]*?<\/script>/, '')
  assert.equal(strip(html), strip(INDEX))
})

test('rewriteIndex refuses a bad port and a page without <head>', () => {
  assert.throws(() => rewriteIndex(INDEX, 'x'))
  assert.throws(() => rewriteIndex(INDEX, 70000))
  assert.throws(() => rewriteIndex(INDEX, 0))
  assert.throws(() => rewriteIndex('<html><body></body></html>', 8788))
})

test('silent false injects no guard; silent true injects it after the config and before any module script', async () => {
  assert.equal(rewriteIndex(INDEX, 8788, { silent: false }), rewriteIndex(INDEX, 8788))
  assert.ok(!rewriteIndex(INDEX, 8788).includes(SILENT_GUARD_SOURCE))
  for (const html of [rewriteIndex(INDEX, 8788, { silent: true }), (await req({ server: silentSrv })).body.toString()]) {
    const cfgAt = html.indexOf('<script>window.__VENOM_DESKTOP__')
    const guardAt = html.indexOf(`<script>${SILENT_GUARD_SOURCE}</script>`)
    const moduleAt = html.indexOf('<script type="module"')
    assert.ok(cfgAt > 0 && guardAt > cfgAt && moduleAt > guardAt, `${cfgAt} < ${guardAt} < ${moduleAt}`)
    assert.equal(html.indexOf(`</script>`, cfgAt) + '</script>'.length, guardAt, 'guard follows the config directly')
  }
})

test('the guard source has no script-breaking text and parses', () => {
  assert.doesNotMatch(SILENT_GUARD_SOURCE, /<\/script|<!--/i)
  const html = rewriteIndex(INDEX, 8788, { silent: true })
  const body = /<script>(\(function venomSilentGuard[\s\S]*?)<\/script>/.exec(html)[1]
  assert.equal(body, SILENT_GUARD_SOURCE)
  assert.equal(typeof new Function(body), 'function')
})

// ---- the guard against small fakes of the browser APIs, in a vm context ----

const FAKES = `
var log = { spoken: [], played: [], edges: [], listeners: [] }
var window = globalThis
function addEventListener(type, fn, capture) { log.listeners.push({ type: type, fn: fn, capture: capture }) }
class SpeechSynthesisUtterance { constructor(text) { this.text = text; this.volume = 1 } }
class SpeechSynthesis { speak(u) { log.spoken.push({ text: u.text, volume: u.volume }) } }
var speechSynthesis = new SpeechSynthesis()
class HTMLMediaElement {
  constructor() { this.muted = false; this.volume = 1 }
  play() { log.played.push({ muted: this.muted, volume: this.volume }); return Promise.resolve() }
}
class AudioNode {
  constructor(ctx, kind) { this.context = ctx; this.kind = kind }
  connect(dest, out, inp) { log.edges.push([this.kind, dest.kind, out]); return dest }
  disconnect(dest) { log.edges.push([this.kind, 'x' + (dest ? dest.kind : '*')]) }
}
class AudioDestinationNode extends AudioNode {}
class GainNode extends AudioNode { constructor(ctx) { super(ctx, 'gain'); this.gain = { value: 1 } } }
class BaseAudioContext {
  constructor(name) { this.destination = new AudioDestinationNode(this, name + '.dest') }
  createGain() { return new GainNode(this) }
  createAnalyser() { return new AudioNode(this, 'analyser') }
  createSource(name) { return new AudioNode(this, name) }
}
class AudioContext extends BaseAudioContext {}
class OfflineAudioContext extends BaseAudioContext {}
// In a browser these are properties of window; class declarations are not.
Object.assign(globalThis, { SpeechSynthesisUtterance, SpeechSynthesis, HTMLMediaElement, AudioNode,
  AudioDestinationNode, GainNode, BaseAudioContext, AudioContext, OfflineAudioContext })
`

function runGuard(extra = '', source = SILENT_GUARD_SOURCE) {
  const ctx = vm.createContext({ console: { error() {} } })
  vm.runInContext(FAKES + extra, ctx)
  vm.runInContext(source, ctx)
  return ctx
}

test('guard: every utterance is spoken at volume 0 and stays at 0; __VENOM_SILENT__ is set', () => {
  const ctx = runGuard()
  const r = vm.runInContext(
    `var u = new SpeechSynthesisUtterance('hi'); u.volume = 1
     speechSynthesis.speak(u)
     u.volume = 1
     var after = u.volume
     speechSynthesis.speak(u)
     var replaced = true
     try { speechSynthesis.speak = function () {} } catch (e) { }
     replaced = speechSynthesis.speak.toString().indexOf('function () {}') === 0
     JSON.stringify({ spoken: log.spoken, after: after, replaced: replaced, silent: window.__VENOM_SILENT__ })`,
    ctx,
  )
  assert.deepEqual(JSON.parse(r), {
    spoken: [
      { text: 'hi', volume: 0 },
      { text: 'hi', volume: 0 },
    ],
    after: 0,
    replaced: false,
    silent: true,
  })
})

test('guard: media elements are muted with volume 0 when they play, autoplay included', () => {
  const ctx = runGuard()
  const r = vm.runInContext(
    `var a = new HTMLMediaElement(); a.play()
     var b = new HTMLMediaElement()
     log.listeners.filter(function (l) { return l.type === 'play' && l.capture }).forEach(function (l) { l.fn({ target: b }) })
     JSON.stringify({ played: log.played, b: { muted: b.muted, volume: b.volume } })`,
    ctx,
  )
  assert.deepEqual(JSON.parse(r), { played: [{ muted: true, volume: 0 }], b: { muted: true, volume: 0 } })
})

test('guard: Web Audio to a live destination goes through a zero gain; analyser taps and offline contexts are untouched', () => {
  const ctx = runGuard()
  const r = vm.runInContext(
    `var c = new AudioContext('live')
     var s = c.createSource('src'); var an = c.createAnalyser()
     var ret = s.connect(c.destination)
     s.connect(an)
     an.connect(c.destination, 0)
     s.disconnect(c.destination)
     var o = new OfflineAudioContext('offline'); o.createSource('osrc').connect(o.destination)
     JSON.stringify({ edges: log.edges, retIsDest: ret === c.destination })`,
    ctx,
  )
  assert.deepEqual(JSON.parse(r), {
    edges: [
      ['gain', 'live.dest', null], // one zero-gain node per context, wired once (JSON: undefined -> null)
      ['src', 'gain', 0],
      ['src', 'analyser', null],
      ['analyser', 'gain', 0],
      ['src', 'xgain'],
      ['osrc', 'offline.dest', null],
    ],
    retIsDest: true,
  })
  // The mute node really has gain 0: wire a fresh context and read back the node it made.
  const g = vm.runInContext(
    `var c2 = new AudioContext('two')
     var s2 = c2.createSource('s2'); var made = []
     var cg = c2.createGain; c2.createGain = function () { var n = cg.call(c2); made.push(n); return n }
     s2.connect(c2.destination); JSON.stringify(made.map(function (n) { return n.gain.value }))`,
    ctx,
  )
  assert.deepEqual(JSON.parse(g), [0])
})

test('guard: speak that cannot be wrapped is replaced by one that throws, and the page is not marked silent', () => {
  const ctx = runGuard(`speechSynthesis = { speak: null }`)
  const r = vm.runInContext(
    `var threw = false
     try { speechSynthesis.speak(new SpeechSynthesisUtterance('hi')) } catch (e) { threw = /silent mode/.test(e.message) }
     JSON.stringify({ threw: threw, silent: '__VENOM_SILENT__' in window })`,
    ctx,
  )
  assert.deepEqual(JSON.parse(r), { threw: true, silent: false })
})

test('guard: __VENOM_SILENT__ stays unset when a guard cannot be installed', () => {
  // Speech engine locked down: neither the wrapper nor the thrower can go in.
  const locked = runGuard(`Object.freeze(SpeechSynthesis.prototype); Object.freeze(speechSynthesis)`)
  assert.equal(vm.runInContext(`'__VENOM_SILENT__' in window`, locked), false)
  // Media prototype frozen: play cannot be patched.
  const media = runGuard(`Object.freeze(HTMLMediaElement.prototype)`)
  assert.equal(vm.runInContext(`'__VENOM_SILENT__' in window`, media), false)
  // AudioNode prototype frozen: connect cannot be patched.
  const audio = runGuard(`Object.freeze(AudioNode.prototype)`)
  assert.equal(vm.runInContext(`'__VENOM_SILENT__' in window`, audio), false)
})

// ---- capture mode (VENOM_APP_CAPTURE=1 with VENOM_APP_SILENT=1) ----

test('capture without silent changes nothing: no guard, same page as a normal run', async () => {
  assert.equal(rewriteIndex(INDEX, 8788, { capture: true }), rewriteIndex(INDEX, 8788))
  assert.equal(rewriteIndex(INDEX, 8788, { silent: false, capture: true }), rewriteIndex(INDEX, 8788))
  const served = (await req({ server: captureOnlySrv })).body.toString()
  const plain = (await req({ server: srv })).body.toString()
  assert.equal(served, plain, 'same bridge port, same page: byte for byte')
  for (const html of [served, rewriteIndex(INDEX, 8788, { capture: true })]) {
    assert.ok(!html.includes('venomSilentGuard') && !html.includes('__VENOM_SILENT__') && !html.includes('__VENOM_CAPTURE__'))
  }
  // capture must be exactly true; plain silent keeps the plain guard.
  assert.equal(rewriteIndex(INDEX, 8788, { silent: true, capture: 'yes' }), rewriteIndex(INDEX, 8788, { silent: true }))
  assert.equal(rewriteIndex(INDEX, 8788, { silent: true, capture: false }), rewriteIndex(INDEX, 8788, { silent: true }))
})

test('silent+capture injects the capture guard after the config and before any module script', async () => {
  assert.notEqual(CAPTURE_GUARD_SOURCE, SILENT_GUARD_SOURCE)
  assert.doesNotMatch(CAPTURE_GUARD_SOURCE, /<\/script|<!--/i)
  assert.match(CAPTURE_GUARD_SOURCE, /speechSynthesis/)
  assert.match(CAPTURE_GUARD_SOURCE, /__VENOM_CAPTURE__/)
  for (const html of [rewriteIndex(INDEX, 8788, { silent: true, capture: true }), (await req({ server: captureSrv })).body.toString()]) {
    assert.ok(!html.includes(`<script>${SILENT_GUARD_SOURCE}</script>`), 'not the plain silent guard')
    const cfgAt = html.indexOf('<script>window.__VENOM_DESKTOP__')
    const guardAt = html.indexOf(`<script>${CAPTURE_GUARD_SOURCE}</script>`)
    const moduleAt = html.indexOf('<script type="module"')
    assert.ok(cfgAt > 0 && guardAt > cfgAt && moduleAt > guardAt, `${cfgAt} < ${guardAt} < ${moduleAt}`)
    assert.equal(html.indexOf(`</script>`, cfgAt) + '</script>'.length, guardAt, 'guard follows the config directly')
  }
})

// Taken before the guard runs (passed as runGuard's extra), so "wrapped" means the guard replaced them.
const ORIGINALS = `var origConnect = AudioNode.prototype.connect; var origPlay = HTMLMediaElement.prototype.play`
const PROBE = `var u = new SpeechSynthesisUtterance('hi'); u.volume = 1
   speechSynthesis.speak(u); u.volume = 1
   var a = new HTMLMediaElement(); a.play()
   var b = new HTMLMediaElement()
   log.listeners.forEach(function (l) { l.fn({ target: b }) })
   var c = new AudioContext('live'); var s = c.createSource('src'); s.connect(c.destination)
   JSON.stringify({
     spoken: log.spoken, after: u.volume, played: log.played, b: { muted: b.muted, volume: b.volume },
     edges: log.edges, connectWrapped: AudioNode.prototype.connect !== origConnect,
     playWrapped: HTMLMediaElement.prototype.play !== origPlay, listeners: log.listeners.length,
     silent: window.__VENOM_SILENT__, capture: window.__VENOM_CAPTURE__, hasCapture: '__VENOM_CAPTURE__' in window,
   })`

test('capture guard: speech still at volume 0; media and Web Audio left alone; __VENOM_SILENT__ and __VENOM_CAPTURE__ set', () => {
  const ctx = runGuard(ORIGINALS, CAPTURE_GUARD_SOURCE)
  const r = JSON.parse(vm.runInContext(PROBE, ctx))
  assert.deepEqual(r, {
    spoken: [{ text: 'hi', volume: 0 }],
    after: 0,
    played: [{ muted: false, volume: 1 }],
    b: { muted: false, volume: 1 },
    edges: [['src', 'live.dest', null]],
    connectWrapped: false,
    playWrapped: false,
    listeners: 0,
    silent: true,
    capture: true,
    hasCapture: true,
  })
  // Both flags are non-writable.
  vm.runInContext(`try { window.__VENOM_CAPTURE__ = false } catch (e) {} try { window.__VENOM_SILENT__ = false } catch (e) {}`, ctx)
  assert.equal(vm.runInContext(`window.__VENOM_CAPTURE__ === true && window.__VENOM_SILENT__ === true`, ctx), true)
  const d = vm.runInContext(`JSON.stringify(Object.getOwnPropertyDescriptor(window, '__VENOM_CAPTURE__'))`, ctx)
  assert.deepEqual(JSON.parse(d), { value: true, writable: false, enumerable: true, configurable: false })
})

test('plain silent guard (same probe): media muted, Web Audio through a zero gain, no __VENOM_CAPTURE__', () => {
  const r = JSON.parse(vm.runInContext(PROBE, runGuard(ORIGINALS)))
  assert.deepEqual(r.spoken, [{ text: 'hi', volume: 0 }])
  assert.deepEqual(r.played, [{ muted: true, volume: 0 }])
  assert.deepEqual(r.b, { muted: true, volume: 0 })
  assert.deepEqual(r.edges, [['gain', 'live.dest', null], ['src', 'gain', 0]])
  assert.equal(r.connectWrapped, true)
  assert.equal(r.playWrapped, true)
  assert.equal(r.silent, true)
  assert.equal(r.capture, undefined)
  assert.equal(r.hasCapture, false)
})

test('capture guard: speech that cannot be guarded still refuses, and neither flag is set', () => {
  const unwrappable = runGuard(`speechSynthesis = { speak: null }`, CAPTURE_GUARD_SOURCE)
  const r = vm.runInContext(
    `var threw = false
     try { speechSynthesis.speak(new SpeechSynthesisUtterance('hi')) } catch (e) { threw = /silent mode/.test(e.message) }
     JSON.stringify({ threw: threw, silent: '__VENOM_SILENT__' in window, capture: '__VENOM_CAPTURE__' in window })`,
    unwrappable,
  )
  assert.deepEqual(JSON.parse(r), { threw: true, silent: false, capture: false })
  const locked = runGuard(`Object.freeze(SpeechSynthesis.prototype); Object.freeze(speechSynthesis)`, CAPTURE_GUARD_SOURCE)
  assert.equal(vm.runInContext(`'__VENOM_SILENT__' in window || '__VENOM_CAPTURE__' in window`, locked), false)
})

test('mimeFor covers the types the app serves', () => {
  assert.equal(mimeFor('a.wasm'), 'application/wasm')
  assert.equal(mimeFor('a.ONNX'), 'application/octet-stream')
  assert.match(mimeFor('a.mjs'), /^text\/javascript/)
  assert.equal(mimeFor('a.unknown'), 'application/octet-stream')
})

test('serves .wasm as application/wasm and .js as JavaScript', async () => {
  const w = await req({ p: '/mediapipe/x.wasm' })
  assert.equal(w.status, 200)
  assert.equal(w.headers['content-type'], 'application/wasm')
  assert.equal(w.body.length, 8)
  const j = await req({ p: '/assets/a.js' })
  assert.match(j.headers['content-type'], /^text\/javascript/)
  assert.match(j.headers['cache-control'], /immutable/)
})

test('Range requests return 206 with the requested bytes, 416 when out of range', async () => {
  const r = await req({ p: '/mediapipe/x.wasm', headers: { range: 'bytes=1-3' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], 'bytes 1-3/8')
  assert.deepEqual([...r.body], [97, 115, 109])
  const tail = await req({ p: '/mediapipe/x.wasm', headers: { range: 'bytes=-2' } })
  assert.equal(tail.status, 206)
  assert.deepEqual([...tail.body], [0, 0])
  const bad = await req({ p: '/mediapipe/x.wasm', headers: { range: 'bytes=9-' } })
  assert.equal(bad.status, 416)
  assert.equal(bad.headers['content-range'], 'bytes */8')
})

test('path traversal is refused, raw or encoded', async () => {
  for (const p of [
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/..%5csecret.txt',
    '/assets%2f..%2f..%2fsecret.txt',
    '/index.html%00.js',
    '/%ZZ',
  ]) {
    const res = await req({ p })
    assert.notEqual(res.status, 200, p)
    assert.ok(!res.body.toString().includes('outside dist'), p)
  }
  assert.equal((await req({ p: '/nope.js' })).status, 404)
})

test('a Host that is not localhost:<port> or 127.0.0.1:<port> is refused (DNS rebinding)', async () => {
  for (const host of ['evil.example', `evil.example:${srv.port}`, 'localhost', `localhost:${srv.port + 1}`, '']) {
    const res = await req({ host })
    assert.equal(res.status, 403, host)
  }
  assert.equal((await req({ host: `127.0.0.1:${srv.port}` })).status, 200)
})

test('only GET and HEAD are served', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const res = await req({ method })
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.allow, 'GET, HEAD')
  }
  const head = await req({ method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
})

test('bound to 127.0.0.1 only', async () => {
  assert.equal(srv.address.address, '127.0.0.1')
  // Not reachable on IPv6 loopback (where available).
  const reachable = await new Promise((resolve) => {
    const s = net.connect({ host: '::1', port: srv.port })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })
  assert.equal(reachable, false)
})

test('startStaticServer needs distDir and a valid bridgePort, and distDir is the folder holding index.html', async () => {
  await assert.rejects(startStaticServer({ bridgePort: BRIDGE }))
  await assert.rejects(startStaticServer({ distDir }))
  await assert.rejects(startStaticServer({ distDir, bridgePort: 'nope' }))
  await assert.rejects(startStaticServer({ distDir: path.join(root, 'missing'), bridgePort: BRIDGE }))
  // Pointing at the parent no longer serves dist/index.html at /.
  const parent = await startStaticServer({ distDir: root, bridgePort: BRIDGE })
  try {
    assert.equal((await req({ server: parent })).status, 404)
  } finally {
    await parent.close()
  }
})
