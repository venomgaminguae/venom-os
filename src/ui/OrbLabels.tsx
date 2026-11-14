import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '../store'
import { tileFor, tileOrder } from '../../hermes-mcp/tiles.mjs'
import { orbHover, orbSignal } from '../../hermes-mcp/orbs.mjs'
import { orbShared } from '../scene/orbShared'
import { usePinnedRuns } from './pinnedRuns'
import { useAgentView } from './agentViewStore'
import { allRuns } from './teamData'

/**
 * The DOM half of the agent orbs (the balls are drawn by src/scene/AgentOrbs.tsx).
 *
 * One zero-size anchor per roster agent, registered in orbShared.els; the scene
 * moves each to its ball's centre every frame by writing style.transform, and
 * fades the whole layer with the balls. React never sets a style on an anchor,
 * so the two never fight. Each anchor holds a round hit area over the ball (a
 * button: click or pinch opens the agent view), the agent's name under it, and
 * for the hovered agent only, a label with what it is doing.
 *
 * Hover is read from one document-level pointermove listener, so the hand
 * pointer (src/lib/hands.ts, synthetic bubbling pointermoves) counts as a
 * mouse does. The hovered id goes into orbShared.hover too; while it is set the
 * scene holds the rings still and enlarges that ball.
 *
 * Mounted in the HUD before <TeamDock />, so the tiles, the blades and the
 * agent view paint over it. Agent text is untrusted: React text only.
 */

/** How long a finished run shows as done before it settles (the tiles' value). */
const DONE_HOLD_MS = 8000
/** A hand pointer that stops sending moves (hand gone) lets go of the hover after this long. */
const TOUCH_HOLD_MS = 1500
/** A ball whose centre is lower than this share of the window gets its label above it. */
const TIP_UP_AT = 0.62

/** Space and Enter activate the button and nothing else (Space is also the talk key). */
const keepKeys = (e: ReactKeyboardEvent) => {
  if (e.key === ' ' || e.key === 'Enter' || e.code === 'Space') e.stopPropagation()
}

type Hovered = { id: string; up: boolean } | null

export function OrbLabels() {
  const team = useStore((s) => s.team)
  const main = useStore((s) => s.runs)
  const kept = usePinnedRuns((s) => s.runs)
  const open = useAgentView((s) => s.open)

  const agents = useMemo(() => tileOrder(team), [team])
  const runs = useMemo(() => allRuns(main, kept), [main, kept])

  const [hover, setHoverState] = useState<Hovered>(null)
  const [now, setNow] = useState(() => Date.now())
  const current = useRef<string | null>(null)

  /** The one way the hover changes: a no-op unless the id does. */
  const setHover = useCallback((id: string | null) => {
    if (current.current === id) return
    current.current = id
    orbShared.hover = id
    if (!id) {
      setHoverState(null)
      return
    }
    const y = orbShared.at.get(id)?.y
    setNow(Date.now())
    setHoverState({ id, up: typeof y === 'number' && y > window.innerHeight * TIP_UP_AT })
  }, [])

  // HUD -> scene: ring order and what each ball shows.
  useEffect(() => {
    orbShared.order = agents.map((a) => a.id)
  }, [agents])

  useEffect(() => {
    const at = Date.now()
    orbShared.signals = new Map(agents.map((a) => [a.id, orbSignal(tileFor(runs, a.id, at, DONE_HOLD_MS))]))
  }, [runs, agents])

  useEffect(
    () => () => {
      orbShared.order = []
      orbShared.signals = new Map()
      orbShared.hover = null
      orbShared.layer = null
      orbShared.els.clear()
      current.current = null
    },
    [],
  )

  // Hover from the pointer (mouse, pen, touch and the hand pointer alike).
  useEffect(() => {
    let touchTimer = 0
    const stopTouch = () => {
      if (touchTimer) window.clearTimeout(touchTimer)
      touchTimer = 0
    }
    const onMove = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-orb]') : null
      setHover(el?.getAttribute('data-orb') ?? null)
      stopTouch()
      // A hand that leaves the camera sends nothing more, so a touch hover
      // lets go on its own once the moves stop.
      if (e.pointerType === 'touch') touchTimer = window.setTimeout(() => setHover(null), TOUCH_HOLD_MS)
    }
    const clear = () => {
      stopTouch()
      setHover(null)
    }
    const root = document.documentElement
    document.addEventListener('pointermove', onMove, { capture: true, passive: true })
    root.addEventListener('pointerleave', clear)
    window.addEventListener('blur', clear)
    return () => {
      stopTouch()
      document.removeEventListener('pointermove', onMove, { capture: true })
      root.removeEventListener('pointerleave', clear)
      window.removeEventListener('blur', clear)
    }
  }, [setHover])

  // The label's clock ("Working · 3m 05s"), only while something is hovered.
  const hoveredId = hover?.id ?? null
  useEffect(() => {
    if (!hoveredId) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [hoveredId])

  const layerRef = useCallback((el: HTMLDivElement | null) => {
    orbShared.layer = el
    return () => {
      if (orbShared.layer === el) orbShared.layer = null
    }
  }, [])

  return (
    <div className="orbs" ref={layerRef}>
      {agents.map((a) => {
        const info = orbHover(tileFor(runs, a.id, now, DONE_HOLD_MS), now)
        const isHover = hover?.id === a.id
        return (
          <div
            key={a.id}
            className={`orb orb-${info.state}${isHover ? ' is-hover' : ''}`}
            data-orb={a.id}
            ref={(el) => {
              if (!el) return
              orbShared.els.set(a.id, el)
              return () => {
                if (orbShared.els.get(a.id) === el) orbShared.els.delete(a.id)
              }
            }}
          >
            <button
              type="button"
              className="orb-hit"
              aria-label={`${a.name}: ${info.title}. ${info.lines.join('. ')}`}
              onClick={() => open(a.id)}
              onKeyDown={keepKeys}
              onFocus={() => setHover(a.id)}
              onBlur={() => {
                if (current.current === a.id) setHover(null)
              }}
            >
              <span className="orb-name">{a.name}</span>
            </button>
            {isHover && (
              <div className={`orb-tip orb-tip-${info.state}${hover.up ? ' orb-tip-up' : ''}`} role="tooltip">
                <span className="orb-tip-name">{a.name}</span>
                <span className="orb-tip-title">{info.title}</span>
                {info.lines.map((line, i) => (
                  <span key={i} className="orb-tip-line">
                    {line}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
