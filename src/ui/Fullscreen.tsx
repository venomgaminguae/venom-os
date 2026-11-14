import { useEffect, useState } from 'react'
import { DESKTOP } from '../config'

/**
 * Full screen.
 *
 * The launcher opens Chrome with --start-fullscreen: browser-level full
 * screen, like F11. There `(display-mode: fullscreen)` matches while
 * document.fullscreenElement is null, the page cannot leave it (F11 does), and
 * Esc still reaches the page (stand down). The control then just says so.
 *
 * In a normal window or tab, the button and F (not while typing, no
 * modifiers, no repeat) toggle the Fullscreen API on <html>. On entering it
 * asks for Chrome's Keyboard Lock on Escape, so Esc keeps meaning "stand
 * down" instead of silently leaving full screen (holding Esc still leaves, as
 * Chrome shows); where that is not available Esc leaves full screen first,
 * which is the browser's rule. Every failure is quiet.
 */

type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void }
const keyboard = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard

const LAUNCHER = '(display-mode: fullscreen)'

/**
 * Is the launcher's (window-level) full screen on? Chrome reports it through
 * the display-mode media query. The desktop app's window does not, so there a
 * page that fills the whole screen counts.
 */
function launcherOn() {
  if (window.matchMedia?.(LAUNCHER).matches) return true
  return DESKTOP && window.innerWidth >= screen.width && window.innerHeight >= screen.height
}

function enter() {
  const el = document.documentElement
  if (!el.requestFullscreen) return
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => keyboard()?.lock?.(['Escape']).catch(() => {}))
    .catch(() => {})
}

function leave() {
  try {
    keyboard()?.unlock?.()
  } catch {
    /* not supported */
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
}

/** F and the button: leave the API's full screen, or enter it unless the launcher's is on. */
function toggle() {
  if (document.fullscreenElement) leave()
  else if (!launcherOn()) enter()
}

export function Fullscreen() {
  const [api, setApi] = useState(() => !!document.fullscreenElement)
  const [launcher, setLauncher] = useState(launcherOn)

  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement
      setApi(on)
      if (!on) {
        try {
          keyboard()?.unlock?.()
        } catch {
          /* not supported */
        }
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    const mq = window.matchMedia?.(LAUNCHER)
    const onMq = () => setLauncher(launcherOn())
    mq?.addEventListener?.('change', onMq)
    window.addEventListener('resize', onMq)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      mq?.removeEventListener?.('change', onMq)
      window.removeEventListener('resize', onMq)
    }
  }, [])

  // In the launcher's full screen with the API off there is nothing the page
  // can do (F11 leaves), so F and the button do nothing there.
  const fixed = launcher && !api

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'f' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const label = api ? 'Exit full screen' : fixed ? 'Full screen · F11 exits' : 'Full screen'
  const title = api ? 'Leave full screen (F)' : fixed ? 'Full screen; press F11 to leave' : 'Full screen (F)'
  return (
    <button
      type="button"
      className={`fs-btn${fixed ? ' fs-fixed' : ''}`}
      onClick={fixed ? undefined : toggle}
      aria-disabled={fixed || undefined}
      aria-pressed={api || fixed}
      title={title}
      onKeyDown={(e) => {
        // Space/Enter press this button only, never the talk key too.
        if (e.key === ' ' || e.key === 'Enter') e.stopPropagation()
      }}
    >
      <span className="fs-icon" aria-hidden="true">
        {api || fixed ? '⤡' : '⤢'}
      </span>
      {label}
    </button>
  )
}
