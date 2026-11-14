/**
 * VENOM OS as a desktop app: the Electron main process.
 *
 * In plain words: this opens Venom OS in its own window. It
 *   1. serves the built interface (dist/) from 127.0.0.1 on a page port
 *      (4188 first, 4188-4199) with desktop/static-server.mjs, which points the
 *      page at this app's own bridge;
 *   2. starts the Venom bridge (bridge/server.mjs, read-only unless
 *      VENOM_ALLOW_WRITES=1 is set) as a child process
 *      on its own port (8788, so the Chrome route keeps 8787), run by this very
 *      binary in Node mode, so no separate Node install is needed;
 *   3. waits until the bridge's local speech-to-text is ready, then opens one
 *      full-screen window (F11 toggles full screen, Esc belongs to the page);
 *   4. puts an icon in the tray: Show, Stand down, Start with Windows (off unless
 *      the owner turns it on), Quit.
 * Only one copy runs at a time. Closing the window or choosing Quit stops the
 * bridge with everything it started, and the page server. Nothing is left running.
 *
 * The plain rules (ports, bridge environment, tray menu, permissions, shortcut
 * name) live in desktop/app-rules.mjs and are unit tested.
 *
 * Run (dev):  node_modules/electron/dist/electron.exe desktop/main.mjs   (any cwd)
 * Packaged:   "Venom OS.exe"; "Venom OS.exe --make-shortcut" writes the Desktop
 *             shortcut "Venom OS (app).lnk" and exits.
 * Env: VENOM_APP_DATA (data + logs folder), VENOM_APP_PORT (page port),
 *   VENOM_APP_BRIDGE_PORT, VENOM_APP_DIST (built interface), VENOM_APP_NODE
 *   (node.exe for the bridge), VENOM_WINDOWED=1 (1400x850 window),
 *   VENOM_APP_SILENT=1 (tests: muted, silent page, no dialogs),
 *   VENOM_APP_CAPTURE=1 (with SILENT only: still muted, page audio graph left live to record),
 *   Everything else passes to the bridge.
 * --remote-debugging-port=N works as usual (Chromium handles it).
 */

// shell.openExternal is deliberately NOT used: it opens the default browser
// (possibly Edge); outside links go to Google Chrome by full path instead.
import { app, BrowserWindow, Menu, Tray, dialog, session, shell, nativeImage } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, truncateSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP,
  STAND_DOWN_JS,
  bridgeEnv,
  captureMode,
  chromiumSwitches,
  externalUrl,
  modelDirCandidates,
  navigationAllowed,
  parsePort,
  permissionAllowed,
  pickModelDir,
  pickPagePort,
  shortcutPath,
  trayTemplate,
} from './app-rules.mjs'
import { startStaticServer } from './static-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..') // the repo, or resources/app when packaged
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const ICON = path.join(HERE, 'app-icon.ico')

const SILENT = process.env.VENOM_APP_SILENT === '1'
const CAPTURE = captureMode(process.env) // only ever with SILENT
const WINDOWED = process.env.VENOM_WINDOWED === '1'
const MAKE_SHORTCUT = process.argv.includes('--make-shortcut')

// ---------------------------------------------------------------- identity --
app.setName(APP.name)
if (process.platform === 'win32') app.setAppUserModelId(APP.aumid)
const USER_DATA = process.env.VENOM_APP_DATA || path.join(os.homedir(), '.venom', 'desktop-app')
mkdirSync(USER_DATA, { recursive: true })
app.setPath('userData', USER_DATA)
const LOG_DIR = path.join(USER_DATA, 'logs')
mkdirSync(LOG_DIR, { recursive: true })
const APP_LOG = path.join(LOG_DIR, 'app.log')
const BRIDGE_LOG = path.join(LOG_DIR, 'bridge.log')

function log(msg) {
  try {
    appendFileSync(APP_LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`)
  } catch {
    /* logging must never take the app down */
  }
}

function capLog(file, max = 5 * 1024 * 1024) {
  try {
    if (existsSync(file) && statSync(file).size > max) truncateSync(file, 0)
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------- Chromium switches (pre-ready) --
for (const [name, value] of chromiumSwitches({ silent: SILENT })) {
  if (value === undefined) app.commandLine.appendSwitch(name)
  else app.commandLine.appendSwitch(name, value)
}

// ----------------------------------------------------------- start-up route --
if (MAKE_SHORTCUT) {
  makeShortcut()
} else if (!app.requestSingleInstanceLock()) {
  // The running copy gets 'second-instance' and shows its window; this one starts nothing.
  log('second launch: another instance holds the lock; it shows its window, this one exits')
  app.exit(0)
} else {
  capLog(APP_LOG)
  main()
}

/** --make-shortcut: write "<Desktop>\Venom OS (app).lnk" pointing at this exe, then exit. */
function makeShortcut() {
  app.whenReady().then(() => {
    if (!app.isPackaged) {
      const msg = '--make-shortcut works only from the packaged "Venom OS.exe"'
      console.error(msg)
      log(msg)
      return app.exit(1)
    }
    let file
    try {
      file = shortcutPath(app.getPath('desktop')) // refuses any name but "Venom OS (app).lnk"
      const ok = shell.writeShortcutLink(file, 'create', {
        target: process.execPath,
        cwd: path.dirname(process.execPath),
        icon: process.execPath,
        iconIndex: 0,
        appUserModelId: APP.aumid,
        description: 'Venom OS',
      })
      if (!ok) throw new Error('shell.writeShortcutLink returned false')
    } catch (e) {
      console.error(`shortcut not written: ${e.message}`)
      log(`shortcut not written: ${e.message}`)
      return app.exit(1)
    }
    console.log(file)
    log(`shortcut written: ${file}`)
    app.exit(0)
  })
}

function main() {
  let win = null
  let tray = null
  let bridge = null
  let bridgeReady = false
  let staticServer = null
  let appOrigin = null // http://localhost:<page port>, set once the page server is up
  let quitting = false
  let htmlFullscreen = false
  let showWhenReady = false // a second launch arrived before the window existed
  let reloadedAfterCrash = false

  log(`start: electron ${process.versions.electron}, root ${ROOT}, packaged ${app.isPackaged}, silent ${SILENT}`)
  if (CAPTURE) log('capture mode on: Chromium muted, system voices at volume 0, page audio graph left live for recording')

  app.on('second-instance', () => {
    log('second launch detected: showing the window')
    showWindow()
  })

  function showWindow() {
    if (!win) {
      showWhenReady = true
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  // --------------------------------------------------------- hardening ----
  /** Open an outside http(s) link in Google Chrome only (never the default browser). */
  function openExternal(raw) {
    const href = externalUrl(raw, appOrigin)
    if (!href) return
    if (!existsSync(CHROME)) return log(`Chrome not found; not opening ${href}`)
    try {
      const c = spawn(CHROME, [href], { detached: true, stdio: 'ignore', shell: false })
      c.on('error', (e) => log(`chrome spawn failed: ${e.message}`))
      c.unref()
    } catch (e) {
      log(`chrome spawn failed: ${e.message}`)
    }
  }

  function harden(contents) {
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    const guard = (event, url, isMainFrame) => {
      // Electron passes (event, url, isInPlace, isMainFrame, ...) and also event.url / event.isMainFrame.
      const mainFrame = event?.isMainFrame ?? isMainFrame
      if (mainFrame === false) return
      const target = event?.url ?? url
      if (navigationAllowed(target, appOrigin)) return
      event.preventDefault()
      openExternal(target)
    }
    contents.on('will-navigate', (event, url, _inPlace, isMainFrame) => guard(event, url, isMainFrame))
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => guard(event, url, isMainFrame))
    contents.on('will-attach-webview', (event) => event.preventDefault())
  }

  app.on('web-contents-created', (_e, contents) => harden(contents))

  function installPermissionHandlers(ses) {
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const ok = permissionAllowed({
        permission,
        appOrigin,
        requestingUrl: details?.requestingUrl,
        isMainFrame: details?.isMainFrame,
        contentsUrl: contents?.getURL?.() ?? '',
        mediaTypes: details?.mediaTypes,
      })
      if (!ok) log(`denied permission request ${permission} from ${details?.requestingUrl}`)
      callback(ok)
    })
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      permissionAllowed({
        permission,
        appOrigin,
        requestingUrl: requestingOrigin,
        isMainFrame: details?.isMainFrame,
        // contents is null for some checks (e.g. service workers); then the origin rules alone decide
        contentsUrl: contents ? (contents.getURL?.() ?? '') : undefined,
        embeddingOrigin: details?.embeddingOrigin,
        mediaTypes: details?.mediaType ? [details.mediaType] : [],
        check: true,
      }),
    )
  }

  // ------------------------------------------------------------- bridge ----
  function chooseModelDir() {
    let projectRoot = null
    try {
      projectRoot = JSON.parse(readFileSync(path.join(HERE, 'build-info.json'), 'utf8')).projectRoot ?? null
    } catch {
      /* no build-info.json in a dev run: appRoot is the project */
    }
    const candidates = modelDirCandidates({ env: process.env, homeDir: os.homedir(), projectRoot, appRoot: ROOT })
    const dir = pickModelDir(candidates, (d) => existsSync(d))
    log(dir ? `speech model folder: ${dir}` : `no speech model folder found (tried ${candidates.join(' | ')})`)
    return dir
  }

  function startBridge(bridgePort, modelDir) {
    capLog(BRIDGE_LOG)
    const exe = process.env.VENOM_APP_NODE || process.execPath
    const fd = openSync(BRIDGE_LOG, 'a')
    appendFileSync(BRIDGE_LOG, `\n--- ${new Date().toISOString()} desktop app starting the bridge on ${bridgePort} (${exe})\n`)
    // bridge-host.mjs runs bridge/server.mjs and stops it (with everything it
    // started) when this process is gone, however it went.
    const child = spawn(exe, [path.join(HERE, 'bridge-host.mjs')], {
      cwd: ROOT,
      env: bridgeEnv(process.env, { bridgePort, pageOrigin: appOrigin, modelDir }),
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      shell: false,
    })
    closeSync(fd)
    log(`bridge pid ${child.pid}`)
    child.on('error', (e) => log(`bridge spawn error: ${e.message}`))
    child.on('exit', (code, signal) => {
      log(`bridge exited code=${code} signal=${signal}`)
      if (bridge === child) bridge = null
      if (!quitting && bridgeReady) {
        fail('The Venom bridge stopped.', `Venom OS will close. The bridge log is at:\n${BRIDGE_LOG}`, 1)
      }
    })
    return child
  }

  /** Kill the bridge and everything it started (claude CLI, MCP servers, STT worker). */
  function killBridgeTree() {
    const child = bridge
    bridge = null
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const pid = child.pid
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      const r = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
      log(`taskkill /T /F ${pid}: status ${r.status} ${String(r.stdout || '').trim()} ${String(r.stderr || '').trim()}`)
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    log(`bridge ${pid} ${alive ? 'STILL ALIVE after kill' : 'gone'}`)
  }

  function shutdown() {
    quitting = true
    killBridgeTree()
    if (staticServer) {
      const s = staticServer
      staticServer = null
      Promise.resolve()
        .then(() => s.close())
        .catch(() => {})
    }
    if (tray) {
      tray.destroy()
      tray = null
    }
  }

  function quitAll() {
    shutdown()
    app.quit()
  }

  process.on('exit', () => {
    quitting = true
    killBridgeTree()
  })
  process.on('uncaughtException', (e) => fail('Venom OS hit an error and will close.', e?.stack ?? String(e), 1))
  app.on('before-quit', shutdown)
  app.on('will-quit', shutdown)
  app.on('window-all-closed', quitAll)

  /** Fatal error: dialog (log only when silent), stop everything, exit with code. */
  function fail(message, detail, code = 1) {
    log(`fatal (exit ${code}): ${message} ${detail ?? ''}`)
    quitting = true
    if (!SILENT) {
      try {
        dialog.showMessageBoxSync({ type: 'error', title: APP.name, message, detail })
      } catch {
        /* still exit */
      }
    }
    shutdown()
    app.exit(code)
  }

  // --------------------------------------------------------------- tray ----
  function startWithWindowsNow() {
    try {
      return app.getLoginItemSettings().openAtLogin === true
    } catch {
      return false
    }
  }

  function buildTrayMenu() {
    // Locked (disabled) in dev runs, where the login item would point at bare
    // electron.exe without the app.
    const template = trayTemplate({
      startWithWindows: startWithWindowsNow(),
      startWithWindowsLocked: !app.isPackaged,
    })
    const actions = {
      show: () => showWindow(),
      'stand-down': () => {
        if (!win) return
        win.webContents.executeJavaScript(STAND_DOWN_JS, true).catch((e) => log(`stand down failed: ${e.message}`))
        log('tray: stand down')
      },
      'start-with-windows': (item) => {
        // Only ever changed by the owner's click; the app never turns it on by itself.
        if (!app.isPackaged) return
        app.setLoginItemSettings({ openAtLogin: item.checked === true })
        log(`tray: start with Windows ${item.checked ? 'on' : 'off'}`)
        tray?.setContextMenu(buildTrayMenu())
      },
      quit: () => {
        log('tray: quit')
        quitAll()
      },
    }
    return Menu.buildFromTemplate(
      template.map(({ id, ...item }) => (id && actions[id] ? { ...item, id, click: (menuItem) => actions[id](menuItem) } : item)),
    )
  }

  function createTray() {
    tray = new Tray(nativeImage.createFromPath(ICON))
    tray.setToolTip(APP.name)
    tray.setContextMenu(buildTrayMenu())
    tray.on('click', () => showWindow())
  }

  // ------------------------------------------------------------ window ----
  function createWindow(pageUrl) {
    win = new BrowserWindow({
      title: 'VENOM OS',
      icon: existsSync(ICON) ? ICON : undefined,
      backgroundColor: '#01060c',
      width: 1400,
      height: 850,
      fullscreen: !WINDOWED,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
      },
    })
    win.setMenuBarVisibility(false)
    if (SILENT) win.webContents.setAudioMuted(true)
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
      log('window shown')
    })
    // The page owns its title ("VENOM"...); keep the window's own.
    win.on('page-title-updated', (e) => e.preventDefault())

    win.webContents.on('enter-html-full-screen', () => (htmlFullscreen = true))
    win.webContents.on('leave-html-full-screen', () => (htmlFullscreen = false))
    // F11 only; Esc is never intercepted (the page uses it to stand down).
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F11') return
      if (input.control || input.alt || input.meta || input.shift) return
      event.preventDefault()
      if (htmlFullscreen) {
        // The page's own Fullscreen API (its F key): leave that the page's way.
        win.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {})
      } else {
        win.setFullScreen(!win.isFullScreen())
      }
      log(`F11 (page full screen: ${htmlFullscreen})`)
    })
    win.on('enter-full-screen', () => log('window entered full screen'))
    win.on('leave-full-screen', () => log('window left full screen'))
    win.on('closed', () => {
      win = null
      log('window closed')
      quitAll()
    })
    // A dead page must not leave the bridge running behind a blank window:
    // reload once, quit if it dies again.
    win.webContents.on('render-process-gone', (_e, d) => {
      log(`renderer gone: ${d.reason}`)
      if (quitting || d.reason === 'clean-exit') return
      if (reloadedAfterCrash || !win) return fail('The Venom window stopped working.', `Reason: ${d.reason}. Start Venom OS again.`, 1)
      reloadedAfterCrash = true
      win.reload()
    })
    // Capture leaves the page's audio graph live: Chromium's mute is then the
    // only thing keeping the room silent, so no page without it.
    if (CAPTURE && win.webContents.isAudioMuted() !== true) {
      log('capture mode: the window is not muted; refusing to load the page')
      return fail('Venom OS capture mode needs a muted window.', 'webContents.isAudioMuted() is not true.', 1)
    }
    win.loadURL(pageUrl).catch((e) => log(`loadURL failed: ${e.message}`))
  }

  // -------------------------------------------------------------- start ----
  app.whenReady().then(() => start().catch((e) => fail('Venom OS could not start.', e?.stack ?? String(e), 1)))

  async function start() {
    Menu.setApplicationMenu(null)
    installPermissionHandlers(session.defaultSession)

    let bridgePort, fixedPagePort
    try {
      bridgePort = parsePort('VENOM_APP_BRIDGE_PORT', process.env.VENOM_APP_BRIDGE_PORT, APP.bridgePort)
      fixedPagePort = parsePort('VENOM_APP_PORT', process.env.VENOM_APP_PORT, 0)
    } catch (e) {
      return fail('Bad port setting.', e.message, 1)
    }
    log(`bridge port ${bridgePort}`)

    if (!(await portFree(bridgePort))) {
      return fail(
        `Port ${bridgePort} is already in use.`,
        `Venom OS runs its own bridge on port ${bridgePort}, and something else is listening there. ` +
          'Close that program (or another Venom OS) and start again.',
        2,
      )
    }

    let pagePort = fixedPagePort
    if (!pagePort) {
      const pick = await pickPagePort(APP.pagePorts, portFree)
      if (!pick.port) return fail('No free port for the interface.', 'Ports 4188-4199 on 127.0.0.1 are all in use.', 1)
      pagePort = pick.port
      if (!pick.firstChoice) {
        log(`page port ${APP.pagePorts[0]} is taken; using ${pagePort} (saved choices and voice cache start empty there)`)
      }
    }

    const distDir = process.env.VENOM_APP_DIST || path.join(ROOT, 'dist')
    if (!existsSync(path.join(distDir, 'index.html'))) {
      return fail('The Venom interface is not built.', `No index.html in ${distDir}.\nBuild it with: node scripts/build-app.mjs`, 1)
    }
    try {
      staticServer = await startStaticServer({ distDir, port: pagePort, bridgePort, silent: SILENT, capture: CAPTURE })
    } catch (e) {
      return fail('Could not serve the Venom interface.', `${e.message}\n(${distDir}, port ${pagePort})`, 1)
    }
    if (quitting) return shutdown()
    // 127.0.0.1, not localhost: the page server listens there only, and nothing
    // listening on the IPv6 loopback can pass itself off as the app's page.
    appOrigin = `http://127.0.0.1:${staticServer.port}`
    log(`page server on ${appOrigin} from ${distDir}`)

    bridge = startBridge(bridgePort, chooseModelDir())
    const up = await waitForPort(bridgePort, 30_000, () => !bridge)
    if (!up) {
      return fail('The Venom bridge did not start.', `It did not answer on port ${bridgePort} within 30 seconds.\nLog: ${BRIDGE_LOG}`, 1)
    }
    if (quitting) return shutdown()
    bridgeReady = true
    // The page asks /health once at boot which speech engine to use. Whisper
    // takes a couple of seconds to load, so wait for it here: a page that
    // probed too early would fall back to browser speech recognition, which
    // does not exist outside Chrome. After 20 s the window opens regardless.
    const stt = await waitForLocalStt(bridgePort, appOrigin, 20_000, () => !bridge)
    if (!bridge || quitting) return shutdown() // it died meanwhile (its exit handler already failed), or the app is closing
    log(stt ? 'local speech-to-text is ready' : 'local speech-to-text did NOT become ready in 20 s; see the bridge log')
    createTray()
    log('opening the window')
    createWindow(`${appOrigin}/`)
    if (showWhenReady) showWindow()
  }
}

// ---------------------------------------------------------------- helpers --
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.unref()
    s.once('error', () => resolve(false))
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)))
  })
}

/** Poll the bridge's /health (with the page's Origin) until it reports sttEngine "local". */
async function waitForLocalStt(port, origin, timeoutMs, gaveUp) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !gaveUp()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { origin },
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok && (await res.json()).sttEngine === 'local') return true
    } catch {
      /* not answering yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function waitForPort(port, timeoutMs, gaveUp) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (gaveUp()) return resolve(false)
      const sock = net.connect({ port, host: '127.0.0.1' })
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(tryOnce, 250)
      })
    }
    tryOnce()
  })
}
