/**
 * Runs the Venom bridge for the desktop app and makes sure it never outlives it.
 *
 * desktop/main.mjs starts this file instead of bridge/server.mjs directly. It
 * imports the bridge unchanged (same arguments, same environment), and once a
 * second checks that the app that started it is still there. When the app is
 * gone, however it went (closed, crashed, ended in Task Manager), this process
 * stops itself together with everything the bridge started (the Claude CLI,
 * the connectors, the speech-to-text worker), so nothing keeps the port.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const parent = process.ppid

function parentAlive() {
  try {
    process.kill(parent, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM' // it exists, we just may not signal it
  }
}

function stopEverything() {
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  process.exit(0)
}

const watch = setInterval(() => {
  if (parentAlive()) return
  clearInterval(watch)
  console.log('[venom] the desktop app is gone; stopping the bridge')
  stopEverything()
}, 1000)
watch.unref?.()

await import('../bridge/server.mjs')
