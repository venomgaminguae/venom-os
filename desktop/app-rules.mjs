/**
 * Venom OS desktop app: the plain rules behind desktop/main.mjs.
 *
 * Everything here is a pure function or a constant: no Electron, no file or
 * network access, no side effects. main.mjs passes in whatever it needs
 * (process.env, an "is this port free" check, an "does this folder exist"
 * check), so every rule can be unit tested under plain Node
 * (test/app-rules.test.mjs). This file must never import 'electron'.
 */
import path from 'node:path'

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Who the app is and where it lives. */
export const APP = Object.freeze({
  name: 'Venom OS',
  aumid: 'org.venom-os.app',
  bridgePort: 8788,
  // 4188 first: that origin holds the saved microphone/voice choices and the
  // Kokoro model cache. The bridge already trusts 4173-4199 as dev origins.
  pagePorts: Object.freeze(range(4188, 4199)),
  shortcutName: 'Venom OS (app).lnk',
})

/** Defaults the bridge gets unless the owner's environment already says otherwise. */
export const BRIDGE_DEFAULTS = Object.freeze({
  VENOM_MCP_SERVERS: 'hermes,context7,firecrawl,sequential-thinking',
})

/** What the tray's "Stand down" runs in the page (the page listens for this event). */
export const STAND_DOWN_JS = "window.dispatchEvent(new Event('venom:stand-down'))"

/** Keys the bridge must not inherit: Venom uses the owner's own Claude Code login. */
export const STRIPPED_ENV = /^(ANTHROPIC|CLAUDE)/i

/**
 * Both spellings of a local origin (localhost and 127.0.0.1), so the bridge
 * accepts the page however it was addressed.
 */
export function localOriginForms(origin) {
  const u = new URL(origin)
  const port = u.port ? `:${u.port}` : ''
  const forms = [`${u.protocol}//localhost${port}`, `${u.protocol}//127.0.0.1${port}`]
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? forms : [u.origin]
}

/**
 * The environment for the bridge child process.
 * @param {Record<string, string|undefined>} processEnv  usually process.env (not modified)
 * @param {{ bridgePort: number, pageOrigin?: string, modelDir?: string|null }} opts
 */
export function bridgeEnv(processEnv, { bridgePort, pageOrigin, modelDir } = {}) {
  if (!Number.isInteger(bridgePort)) throw new Error('bridgeEnv needs a numeric bridgePort')
  const env = {}
  for (const [k, v] of Object.entries(processEnv ?? {})) {
    if (STRIPPED_ENV.test(k) || v === undefined) continue
    env[k] = String(v)
  }
  for (const [k, v] of Object.entries(BRIDGE_DEFAULTS)) if (env[k] === undefined) env[k] = v
  env.VENOM_BRIDGE_PORT = String(bridgePort)
  env.VENOM_LOCAL_STT = '1' // always: there is no browser speech recognition outside Chrome
  // Empty counts as unset here, as it does in bridge/stt-local.mjs (`||`).
  if (modelDir && !env.VENOM_STT_MODEL_DIR) env.VENOM_STT_MODEL_DIR = modelDir
  env.ELECTRON_RUN_AS_NODE = '1' // the app's own binary runs the bridge as plain Node
  if (pageOrigin) {
    const origins = (env.VENOM_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const o of localOriginForms(pageOrigin)) if (!origins.includes(o)) origins.push(o)
    env.VENOM_ALLOWED_ORIGINS = origins.join(',')
  }
  return env
}

/**
 * Where the speech-to-text model may be, in order of preference:
 * VENOM_STT_MODEL_DIR, ~/.venom/models, <projectRoot>/desktop/models (projectRoot
 * from desktop/build-info.json), <appRoot>/desktop/models. Missing inputs are skipped.
 */
export function modelDirCandidates({ env = {}, homeDir, projectRoot, appRoot } = {}) {
  const list = [
    env.VENOM_STT_MODEL_DIR || null,
    homeDir ? path.join(homeDir, '.venom', 'models') : null,
    projectRoot ? path.join(projectRoot, 'desktop', 'models') : null,
    appRoot ? path.join(appRoot, 'desktop', 'models') : null,
  ]
  return list.filter(Boolean).filter((p, i, all) => all.indexOf(p) === i)
}

/** First candidate for which exists(dir) is true, or null. */
export function pickModelDir(candidates, exists) {
  for (const dir of candidates ?? []) {
    if (dir && exists(dir)) return dir
  }
  return null
}

/**
 * First free port of the preferred list. isFree may be sync or async.
 * @returns {Promise<{ port: number|null, firstChoice: boolean }>}
 *   firstChoice is false when the first port was taken: another origin starts
 *   with empty saved choices and no cached voice model.
 */
export async function pickPagePort(preferred, isFree) {
  const list = [...(preferred ?? [])]
  for (const port of list) {
    if (await isFree(port)) return { port, firstChoice: port === list[0] }
  }
  return { port: null, firstChoice: false }
}

/** A port number from an env value; fallback when empty; throws on anything else. */
export function parsePort(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!/^\d+$/.test(String(raw).trim()) || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a port number (1-65535), got "${raw}"`)
  }
  return n
}

/**
 * Throws unless the file name is exactly "Venom OS (app).lnk". The Chrome
 * route's "Venom OS.lnk" (or anything else) is never written by the app.
 */
export function assertShortcutName(file) {
  const name = path.win32.basename(String(file ?? ''))
  if (name !== APP.shortcutName) {
    throw new Error(`refusing to write shortcut "${name}": only "${APP.shortcutName}" is allowed`)
  }
  return file
}

/** <desktop>\Venom OS (app).lnk, always. */
export function shortcutPath(desktopDir) {
  if (!desktopDir) throw new Error('shortcutPath needs the Desktop folder')
  return assertShortcutName(path.win32.join(desktopDir, APP.shortcutName))
}

/**
 * The tray menu as plain descriptors; main.mjs attaches the click handlers by id.
 * "Start with Windows" is unchecked unless the system says it is on, and can be
 * locked (disabled) so nothing can toggle it (screenshots, dev runs).
 */
export function trayTemplate({ startWithWindows = false, startWithWindowsLocked = false } = {}) {
  return [
    { id: 'show', label: 'Show' },
    { id: 'stand-down', label: 'Stand down' },
    { type: 'separator' },
    {
      id: 'start-with-windows',
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startWithWindows === true,
      enabled: !startWithWindowsLocked,
    },
    { type: 'separator' },
    { id: 'quit', label: 'Quit' },
  ]
}

/** Chromium switches set before the app is ready, as [name, value?] pairs. */
export function chromiumSwitches({ silent = false } = {}) {
  const list = [['autoplay-policy', 'no-user-gesture-required']]
  if (silent) list.push(['mute-audio'])
  return list
}

/**
 * VENOM_APP_CAPTURE=1 counts only with VENOM_APP_SILENT=1: the page's own audio
 * graph is left live for recording while Chromium stays muted. Never otherwise.
 */
export function captureMode(env = {}) {
  return env?.VENOM_APP_SILENT === '1' && env?.VENOM_APP_CAPTURE === '1'
}

/** Permissions the app's own page gets without a prompt. Everything else is denied. */
export const ALLOWED_PERMISSIONS = Object.freeze([
  'media',
  'fullscreen',
  'keyboardLock',
  'speaker-selection',
  'clipboard-sanitized-write',
])

export function originOf(u) {
  try {
    return new URL(u).origin
  } catch {
    return null
  }
}

/**
 * Whether a permission request/check is granted.
 * @param {object} q
 * @param {string} q.permission
 * @param {string|null} q.appOrigin        the page server's origin (null before it is up)
 * @param {string} q.requestingUrl          URL or origin asking
 * @param {boolean} [q.isMainFrame]         false = an embedded frame: denied
 * @param {string} [q.contentsUrl]          the asking webContents' current URL
 * @param {string} [q.embeddingOrigin]      top frame's origin (checks only)
 * @param {string[]} [q.mediaTypes]         'audio' / 'video' only (no screen capture)
 * @param {boolean} [q.check]               a permission CHECK, where Chromium may say 'unknown'
 */
export function permissionAllowed({ permission, appOrigin, requestingUrl, isMainFrame, contentsUrl, embeddingOrigin, mediaTypes, check = false }) {
  if (!ALLOWED_PERMISSIONS.includes(permission)) return false
  if (!appOrigin || originOf(requestingUrl) !== appOrigin) return false
  if (isMainFrame === false) return false
  if (contentsUrl !== undefined && originOf(contentsUrl) !== appOrigin) return false
  if (embeddingOrigin && originOf(embeddingOrigin) !== appOrigin) return false
  if (permission === 'media') {
    const ok = check ? ['audio', 'video', 'unknown'] : ['audio', 'video']
    if ((mediaTypes ?? []).some((t) => !ok.includes(t))) return false
  }
  return true
}

/** Whether a main-frame navigation may stay in the window (only the app's own origin). */
export function navigationAllowed(url, appOrigin) {
  return !!appOrigin && originOf(url) === appOrigin
}

/** Whether a link may be handed to Google Chrome: http(s) and not the app itself. */
export function externalUrl(raw, appOrigin) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (appOrigin && url.origin === appOrigin) return null
  return url.href
}
