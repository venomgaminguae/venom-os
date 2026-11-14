// Rules of the desktop app (desktop/app-rules.mjs), held in place:
//  - the bridge child gets its own Claude login (no ANTHROPIC*/CLAUDE* keys),
//    the app's port and origin, local speech-to-text, and keeps the owner's values;
//  - model folder and page port choices follow the documented order;
//  - the shortcut is only ever "Venom OS (app).lnk", never "Venom OS.lnk";
//  - "Start with Windows" is off unless the system says it is on;
//  - permissions and navigation stay with the app's own origin.
// Pure: nothing is spawned, opened or written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  APP,
  BRIDGE_DEFAULTS,
  STAND_DOWN_JS,
  assertShortcutName,
  bridgeEnv,
  captureMode,
  chromiumSwitches,
  externalUrl,
  localOriginForms,
  modelDirCandidates,
  navigationAllowed,
  parsePort,
  permissionAllowed,
  pickModelDir,
  pickPagePort,
  shortcutPath,
  trayTemplate,
} from '../desktop/app-rules.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('app-rules.mjs never imports electron (it runs under plain node)', () => {
  const src = fs.readFileSync(path.join(root, 'desktop', 'app-rules.mjs'), 'utf8')
  assert.doesNotMatch(src, /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)|import\(\s*['"]electron['"]/)
})

test('APP identity', () => {
  assert.equal(APP.name, 'Venom OS')
  assert.equal(APP.aumid, 'org.venom-os.app')
  assert.equal(APP.bridgePort, 8788)
  assert.deepEqual([...APP.pagePorts], [4188, 4189, 4190, 4191, 4192, 4193, 4194, 4195, 4196, 4197, 4198, 4199])
  assert.equal(APP.shortcutName, 'Venom OS (app).lnk')
  assert.ok(Object.isFrozen(APP))
  assert.throws(() => APP.pagePorts.push(4200))
})

// ------------------------------------------------------------ bridgeEnv --
test('bridgeEnv strips every ANTHROPIC*/CLAUDE* key, any case', () => {
  const input = {
    ANTHROPIC_API_KEY: 'sk-x',
    ANTHROPIC_BASE_URL: 'http://x',
    anthropic_model: 'y',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    Claude_Config_Dir: 'z',
    PATH: 'C:\\bin',
    VENOM_CLAUDE_EXECUTABLE: 'C:\\claude.exe', // contains CLAUDE, but not at the start: kept
    MY_ANTHROPIC: 'kept',
  }
  const env = bridgeEnv(input, { bridgePort: 8788 })
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /^(anthropic|claude)/i, k)
  assert.equal(env.PATH, 'C:\\bin')
  assert.equal(env.VENOM_CLAUDE_EXECUTABLE, 'C:\\claude.exe')
  assert.equal(env.MY_ANTHROPIC, 'kept')
  assert.equal(input.ANTHROPIC_API_KEY, 'sk-x', 'the input is not modified')
})

test('bridgeEnv sets the defaults when nothing is set', () => {
  const env = bridgeEnv({}, { bridgePort: 8798, pageOrigin: 'http://localhost:4198', modelDir: 'D:\\models' })
  assert.equal(env.VENOM_MODEL, undefined, 'no model named: bridge/settings.mjs decides')
  assert.equal(env.VENOM_MCP_SERVERS, 'hermes,context7,firecrawl,sequential-thinking')
  assert.equal(env.VENOM_ALLOW_WRITES, undefined, 'read-only unless the user turns writes on')
  assert.equal(env.VENOM_BRIDGE_PORT, '8798')
  assert.equal(env.VENOM_LOCAL_STT, '1')
  assert.equal(env.VENOM_STT_MODEL_DIR, 'D:\\models')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.VENOM_ALLOWED_ORIGINS, 'http://localhost:4198,http://127.0.0.1:4198')
  assert.deepEqual(Object.keys(BRIDGE_DEFAULTS).sort(), ['VENOM_MCP_SERVERS'])
})

test('bridgeEnv keeps the owner\'s existing values', () => {
  const env = bridgeEnv(
    {
      VENOM_MODEL: 'claude-other',
      VENOM_MCP_SERVERS: '', // deliberately none: an empty value is still the owner's choice
      VENOM_ALLOW_WRITES: '0',
      VENOM_STT_MODEL_DIR: 'E:\\mine',
      VENOM_MEMORY_DIR: 'E:\\mem',
      VENOM_HONCHO: '1',
    },
    { bridgePort: 8788, modelDir: 'D:\\other' },
  )
  assert.equal(env.VENOM_MODEL, 'claude-other')
  assert.equal(env.VENOM_MCP_SERVERS, '')
  assert.equal(env.VENOM_ALLOW_WRITES, '0')
  assert.equal(env.VENOM_STT_MODEL_DIR, 'E:\\mine')
  assert.equal(env.VENOM_MEMORY_DIR, 'E:\\mem')
  assert.equal(env.VENOM_HONCHO, '1')
})

test('bridgeEnv always forces the port, local STT and Node mode', () => {
  const env = bridgeEnv(
    { VENOM_BRIDGE_PORT: '8787', VENOM_LOCAL_STT: '0', ELECTRON_RUN_AS_NODE: '' },
    { bridgePort: 8788 },
  )
  assert.equal(env.VENOM_BRIDGE_PORT, '8788')
  assert.equal(env.VENOM_LOCAL_STT, '1')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
})

test('bridgeEnv: no model dir given or found -> VENOM_STT_MODEL_DIR stays unset; empty counts as unset', () => {
  assert.equal('VENOM_STT_MODEL_DIR' in bridgeEnv({}, { bridgePort: 8788 }), false)
  assert.equal('VENOM_STT_MODEL_DIR' in bridgeEnv({}, { bridgePort: 8788, modelDir: null }), false)
  assert.equal(bridgeEnv({ VENOM_STT_MODEL_DIR: '' }, { bridgePort: 8788, modelDir: 'D:\\m' }).VENOM_STT_MODEL_DIR, 'D:\\m')
})

test('bridgeEnv appends both origin forms to existing VENOM_ALLOWED_ORIGINS, without duplicates', () => {
  const env = bridgeEnv(
    { VENOM_ALLOWED_ORIGINS: 'https://example.test, http://127.0.0.1:4188' },
    { bridgePort: 8788, pageOrigin: 'http://127.0.0.1:4188' },
  )
  assert.equal(env.VENOM_ALLOWED_ORIGINS, 'https://example.test,http://127.0.0.1:4188,http://localhost:4188')
  assert.equal('VENOM_ALLOWED_ORIGINS' in bridgeEnv({}, { bridgePort: 8788 }), false, 'no page origin, nothing added')
  assert.deepEqual(localOriginForms('http://localhost:4190/'), ['http://localhost:4190', 'http://127.0.0.1:4190'])
})

test('bridgeEnv refuses a missing port and skips undefined values', () => {
  assert.throws(() => bridgeEnv({}, {}), /bridgePort/)
  const env = bridgeEnv({ A: undefined, B: 'b' }, { bridgePort: 1 })
  assert.equal('A' in env, false)
  assert.equal(env.B, 'b')
})

// --------------------------------------------------------- pickModelDir --
test('modelDirCandidates follows the documented order and skips missing inputs', () => {
  const home = 'C:\\Users\\x'
  assert.deepEqual(
    modelDirCandidates({ env: { VENOM_STT_MODEL_DIR: 'E:\\m' }, homeDir: home, projectRoot: 'C:\\proj', appRoot: 'C:\\app' }),
    ['E:\\m', path.join(home, '.venom', 'models'), path.join('C:\\proj', 'desktop', 'models'), path.join('C:\\app', 'desktop', 'models')],
  )
  // dev run: no build-info, projectRoot === appRoot -> no duplicate
  assert.deepEqual(modelDirCandidates({ env: {}, homeDir: home, projectRoot: 'C:\\p', appRoot: 'C:\\p' }), [
    path.join(home, '.venom', 'models'),
    path.join('C:\\p', 'desktop', 'models'),
  ])
})

test('pickModelDir returns the first existing candidate, else null', () => {
  const list = ['E:\\m', 'C:\\home\\.venom\\models', 'C:\\proj\\desktop\\models', 'C:\\app\\desktop\\models']
  const seen = []
  const exists = (set) => (d) => (seen.push(d), set.has(d))
  assert.equal(pickModelDir(list, exists(new Set(['C:\\proj\\desktop\\models', 'C:\\app\\desktop\\models']))), 'C:\\proj\\desktop\\models')
  assert.deepEqual(seen, list.slice(0, 3), 'stops at the first hit')
  assert.equal(pickModelDir(list, () => true), 'E:\\m', 'the env choice wins when it exists')
  assert.equal(pickModelDir(list, () => false), null)
  assert.equal(pickModelDir([], () => true), null)
  assert.equal(pickModelDir([null, '', 'X'], (d) => d === 'X'), 'X')
})

// --------------------------------------------------------- pickPagePort --
test('pickPagePort: first choice free', async () => {
  assert.deepEqual(await pickPagePort(APP.pagePorts, () => true), { port: 4188, firstChoice: true })
})

test('pickPagePort: first taken -> next free, flagged as not the first choice (async isFree)', async () => {
  const busy = new Set([4188, 4189])
  assert.deepEqual(await pickPagePort(APP.pagePorts, async (p) => !busy.has(p)), { port: 4190, firstChoice: false })
})

test('pickPagePort: all taken -> null', async () => {
  assert.deepEqual(await pickPagePort(APP.pagePorts, () => false), { port: null, firstChoice: false })
  assert.deepEqual(await pickPagePort([], () => true), { port: null, firstChoice: false })
})

test('parsePort: fallback when empty, numbers accepted, junk refused', () => {
  assert.equal(parsePort('X', undefined, 8788), 8788)
  assert.equal(parsePort('X', '', 0), 0)
  assert.equal(parsePort('X', '8798', 8788), 8798)
  for (const bad of ['0', '65536', 'abc', '87.5', '-1', '8798x']) assert.throws(() => parsePort('X', bad, 1), /X must be a port/, bad)
})

// ------------------------------------------------------------- shortcut --
test('shortcutPath is always <Desktop>\\Venom OS (app).lnk', () => {
  assert.equal(shortcutPath('C:\\Users\\x\\Desktop'), 'C:\\Users\\x\\Desktop\\Venom OS (app).lnk')
  assert.equal(shortcutPath('C:/Users/x/OneDrive/Desktop'), 'C:\\Users\\x\\OneDrive\\Desktop\\Venom OS (app).lnk')
  assert.throws(() => shortcutPath(''), /Desktop/)
})

test('the shortcut guard refuses "Venom OS.lnk" and every other name', () => {
  assert.equal(assertShortcutName('C:\\D\\Venom OS (app).lnk'), 'C:\\D\\Venom OS (app).lnk')
  assert.equal(assertShortcutName('C:/D/Venom OS (app).lnk'), 'C:/D/Venom OS (app).lnk')
  for (const bad of [
    'C:\\Users\\x\\Desktop\\Venom OS.lnk',
    'C:/Users/x/Desktop/Venom OS.lnk',
    'Venom OS.lnk',
    'C:\\D\\venom os.lnk',
    'C:\\D\\venom os (app).lnk',
    'C:\\D\\Venom OS (app).lnk.bak',
    'C:\\D\\Venom.cmd',
    '',
    undefined,
  ]) {
    assert.throws(() => assertShortcutName(bad), /refusing/, String(bad))
  }
})

// ----------------------------------------------------------------- tray --
test('trayTemplate: Show, Stand down, -, Start with Windows (unchecked by default), -, Quit', () => {
  const t = trayTemplate()
  assert.deepEqual(
    t.map((i) => i.type === 'separator' ? '-' : i.label),
    ['Show', 'Stand down', '-', 'Start with Windows', '-', 'Quit'],
  )
  const sww = t.find((i) => i.id === 'start-with-windows')
  assert.equal(sww.type, 'checkbox')
  assert.equal(sww.checked, false)
  assert.equal(sww.enabled, true)
  assert.equal(trayTemplate({}).find((i) => i.id === 'start-with-windows').checked, false)
  for (const i of t) assert.equal(typeof i.click, 'undefined', 'plain descriptors, no handlers')
})

test('trayTemplate reflects the system state and can be locked', () => {
  assert.equal(trayTemplate({ startWithWindows: true }).find((i) => i.id === 'start-with-windows').checked, true)
  assert.equal(trayTemplate({ startWithWindows: 'yes' }).find((i) => i.id === 'start-with-windows').checked, false, 'only true is on')
  const locked = trayTemplate({ startWithWindowsLocked: true }).find((i) => i.id === 'start-with-windows')
  assert.equal(locked.enabled, false)
  assert.equal(locked.checked, false)
})

test('Stand down dispatches the page\'s venom:stand-down event', () => {
  assert.equal(STAND_DOWN_JS, "window.dispatchEvent(new Event('venom:stand-down'))")
})

// ----------------------------------------------------- chromium switches --
test('chromiumSwitches: autoplay always, mute only when silent', () => {
  assert.deepEqual(chromiumSwitches(), [['autoplay-policy', 'no-user-gesture-required']])
  assert.deepEqual(chromiumSwitches({ silent: true }), [['autoplay-policy', 'no-user-gesture-required'], ['mute-audio']])
})

test('captureMode: on only with VENOM_APP_SILENT=1 and VENOM_APP_CAPTURE=1, exactly', () => {
  assert.equal(captureMode({ VENOM_APP_SILENT: '1', VENOM_APP_CAPTURE: '1' }), true)
  // Off without SILENT: capture never makes a normal (audible) run different.
  assert.equal(captureMode({ VENOM_APP_CAPTURE: '1' }), false)
  assert.equal(captureMode({ VENOM_APP_SILENT: '0', VENOM_APP_CAPTURE: '1' }), false)
  assert.equal(captureMode({ VENOM_APP_SILENT: 'true', VENOM_APP_CAPTURE: '1' }), false)
  // Off when the value is not exactly '1'.
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 1, true]) {
    assert.equal(captureMode({ VENOM_APP_SILENT: '1', VENOM_APP_CAPTURE: v }), false, `VENOM_APP_CAPTURE=${String(v)}`)
  }
  assert.equal(captureMode({ VENOM_APP_SILENT: '1' }), false)
  assert.equal(captureMode({}), false)
  assert.equal(captureMode(), false)
  // The Chromium mute stays on in capture mode: main.mjs passes silent, not capture, here.
  assert.deepEqual(chromiumSwitches({ silent: true }).at(-1), ['mute-audio'])
})

// ---------------------------------------------------- permissions, links --
const ORIGIN = 'http://localhost:4188'
const ask = (over) =>
  permissionAllowed({ permission: 'media', appOrigin: ORIGIN, requestingUrl: `${ORIGIN}/`, isMainFrame: true, contentsUrl: `${ORIGIN}/`, mediaTypes: ['audio'], ...over })

test('permissions: the app\'s own main frame gets mic, camera, fullscreen, keyboard lock, speaker selection, clipboard write', () => {
  assert.equal(ask({}), true)
  assert.equal(ask({ mediaTypes: ['audio', 'video'] }), true)
  for (const p of ['fullscreen', 'keyboardLock', 'speaker-selection', 'clipboard-sanitized-write']) assert.equal(ask({ permission: p, mediaTypes: undefined }), true, p)
})

test('permissions: everything else is denied', () => {
  for (const p of ['geolocation', 'notifications', 'midi', 'clipboard-read', 'display-capture', 'openExternal', 'hid', 'serial', 'usb']) {
    assert.equal(ask({ permission: p }), false, p)
  }
  assert.equal(ask({ requestingUrl: 'https://evil.test/' }), false, 'other origin')
  assert.equal(ask({ requestingUrl: 'http://localhost:4189/' }), false, 'other port')
  assert.equal(ask({ isMainFrame: false }), false, 'embedded frame')
  assert.equal(ask({ contentsUrl: 'https://evil.test/' }), false, 'other contents')
  assert.equal(ask({ appOrigin: null }), false, 'before the page server is up')
  assert.equal(ask({ embeddingOrigin: 'https://evil.test' }), false, 'embedded elsewhere')
  assert.equal(ask({ mediaTypes: ['audio', 'screen'] }), false, 'no screen capture')
  assert.equal(ask({ mediaTypes: ['unknown'] }), false, 'requests must name audio/video')
  assert.equal(ask({ mediaTypes: ['unknown'], check: true, contentsUrl: undefined }), true, 'checks may say unknown')
})

test('navigation stays on the app origin; outside http(s) links go out, nothing else does', () => {
  assert.equal(navigationAllowed(`${ORIGIN}/x?y`, ORIGIN), true)
  assert.equal(navigationAllowed('https://example.com/', ORIGIN), false)
  assert.equal(navigationAllowed(`${ORIGIN}/`, null), false)
  assert.equal(externalUrl('https://example.com/a', ORIGIN), 'https://example.com/a')
  assert.equal(externalUrl('http://example.com', ORIGIN), 'http://example.com/')
  assert.equal(externalUrl(`${ORIGIN}/page`, ORIGIN), null)
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'not a url']) {
    assert.equal(externalUrl(bad, ORIGIN), null, bad)
  }
})
