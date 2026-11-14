/**
 * Open VENOM in its own Google Chrome app window (never Edge): no tabs, no
 * address bar, full screen by default, on a Chrome profile of its own
 * (~/.venom/chrome-app, the same one venom-app.ps1 uses) so its speech
 * recogniser does not collide with your normal Chrome tabs.
 *
 * Used by `scripts/start.mjs --window` (Venom.cmd). F11 leaves full screen;
 * VENOM_WINDOWED=1 asks for a normal 1400x850 window instead. A second start
 * does not open a second window: Chrome holds `<profile>\lockfile` open while
 * it runs on that profile, and that is checked first.
 *
 * Importing this module does nothing; only openWindow() starts anything.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where Google Chrome lives. VENOM_CHROME overrides it, for tests only. */
export const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chromePath = () => process.env.VENOM_CHROME?.trim() || CHROME

/** The app window's own Chrome profile folder. */
export const defaultProfile = () => join(homedir(), '.venom', 'chrome-app')

/** Chrome's arguments for the app window. Pure. */
export function chromeArgs({ url, profile = defaultProfile(), fullscreen = true } = {}) {
  return [
    `--user-data-dir=${profile}`,
    `--app=${url}`,
    fullscreen ? '--start-fullscreen' : '--window-size=1400,850',
    '--no-first-run',
    '--no-default-browser-check',
  ]
}

/**
 * Is Chrome already running on this profile? On Windows the running Chrome
 * holds `<profile>\lockfile` open, so opening it for writing fails with
 * EBUSY or EPERM; elsewhere Chrome leaves a `SingletonLock` link. No file,
 * or a file nobody holds: false.
 */
export function windowAlreadyOpen(profile = defaultProfile()) {
  if (process.platform !== 'win32') {
    try {
      lstatSync(join(profile, 'SingletonLock'))
      return true
    } catch {
      return false
    }
  }
  let fd = null
  try {
    fd = openSync(join(profile, 'lockfile'), 'r+')
    return false
  } catch (err) {
    return err?.code === 'EBUSY' || err?.code === 'EPERM'
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const accepts = (port, host) =>
  new Promise((resolve) => {
    const s = connect({ port, host })
    const done = (ok) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(1000, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })

/**
 * Wait until every port accepts a connection on loopback (IPv4 or IPv6, as
 * Vite may listen on either). Resolves true, or false after `timeoutMs`.
 */
export async function waitForPorts(ports, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  const pending = new Set(ports)
  while (pending.size) {
    for (const port of [...pending]) {
      if ((await accepts(port, '127.0.0.1')) || (await accepts(port, '::1'))) pending.delete(port)
    }
    if (!pending.size) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return true
}

/**
 * Open the app window, unless Chrome already shows it on this profile.
 * Chrome is started detached, so it outlives this process. Never throws.
 * Returns 'opened', 'already-open' or 'no-chrome'.
 */
export function openWindow({ url, profile = defaultProfile(), fullscreen = true } = {}) {
  try {
    const exe = chromePath()
    if (!existsSync(exe)) return 'no-chrome'
    if (windowAlreadyOpen(profile)) return 'already-open'
    mkdirSync(profile, { recursive: true })
    const child = spawn(exe, chromeArgs({ url, profile, fullscreen }), { detached: true, stdio: 'ignore' })
    child.on('error', () => {}) // a failed start is reported as nothing more
    child.unref()
    return 'opened'
  } catch {
    return 'no-chrome'
  }
}
