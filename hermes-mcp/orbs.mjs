/**
 * The agent orbs' rules: where each roster agent's ball sits on its ring round
 * the core, when a ball feeds a signal into the core, and what its hover label
 * says. The scene (src/scene/AgentOrbs.tsx) and the HUD layer
 * (src/ui/OrbLabels.tsx) draw what comes back; node --test covers it
 * (test/orbs.test.mjs). Pure functions only: no I/O, no DOM, no clock.
 *
 * Every string that came from an agent is untrusted. Nothing here produces
 * markup; the task and step go through the same one-line caps the tiles use
 * (headline, summaryLine in pinned.mjs).
 */
import { headline, summaryLine, when } from './pinned.mjs'

/*
 * The ring. Units follow ui_orbit (src/scene/Orbits.tsx): a radius is a share
 * of the frame's shorter axis read as a diameter, so 0.6 is the core ring
 * itself and the agents' 0.74 sits outside it. VENOM's image orbits default to
 * radius 0.55 and tilt +24; the agents get a wider ring tilted the other way
 * (negative: the near half is the lower half), so the two never share a path.
 *
 * At 1920x1080 the ring's widest point is 400px from the centre; the tile
 * columns start 484px out, and test/orbs.test.mjs holds the labels clear of
 * them and of each other at 1920x1080 and 2560x1440. The radius came down
 * from 0.78 to leave room for a fifteenth agent with a long name: a label
 * 59px to each side of its ball still clears the columns by 11px there.
 */
export const ORBS = {
  /** First ring's radius; each further ring adds RING_STEP. */
  RADIUS: 0.74,
  RING_STEP: 0.13,
  /** Degrees about the screen's horizontal axis. */
  TILT: -58,
  /** Revolutions per minute; odd rings turn the other way. */
  SPEED: 0.5,
  /** Balls on one ring before a second ring is opened. Names (capped at
   *  NAME_CHARS) stay apart up to 16 on one ring at 1920x1080 and 13 at
   *  1366x768 (test/layout-sizes.test.mjs); a second ring's names cross the
   *  first's, so it opens as late as that allows. */
  PER_RING: 16,
  /** Ball radius as a share of the frame's shorter axis. */
  BALL: 0.0105,
  /** The scene camera (Scene.tsx): distance from the core and vertical fov. */
  CAMERA_Z: 6.2,
  FOV: 45,
  /** The name under a ball: font px = clamp(MIN, VW * width, MAX). */
  FONT_MIN: 10,
  FONT_VW: 0.006,
  FONT_MAX: 14,
  /** Width of one label character in em (JetBrains Mono 0.6 + 0.08 tracking). */
  CHAR_EM: 0.68,
  /** Longest name shown under a ball, in characters; a longer one ends in an ellipsis (index.css .orb-name max-width). */
  NAME_CHARS: 14,
  /** Gap between the ball and its name, px. */
  LABEL_GAP: 5,
  /** Colours: the HUD's --interface purple, and the tiles' error colour. */
  PURPLE: '#b266ff',
  ERROR: '#ff6b6b',
  /** Pulses travelling down one feed at a time. */
  PULSES: 4,
  /** Seconds a pulse takes from the ball to the core. */
  PULSE_SECONDS: 1.6,
}

const DEG = Math.PI / 180
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * One slot per agent, in the order given: { ring, radius, tilt, speed, phase }.
 * phase is the starting angle in degrees. The agents are spread evenly over as
 * few rings as hold them (PER_RING each), ring 0 innermost.
 */
export function orbLayout(count) {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0))
  if (!n) return []
  const rings = Math.ceil(n / ORBS.PER_RING)
  const per = Math.ceil(n / rings)
  const out = []
  for (let i = 0; i < n; i++) {
    const ring = Math.floor(i / per)
    const onRing = Math.min(per, n - ring * per)
    const k = i - ring * per
    out.push({
      ring,
      radius: ORBS.RADIUS + ring * ORBS.RING_STEP,
      tilt: ORBS.TILT,
      speed: ring % 2 ? -ORBS.SPEED : ORBS.SPEED,
      // Half a step of offset per ring, so a second ring's balls sit between the first's.
      phase: (360 / onRing) * (k + (ring % 2 ? 0.5 : 0)),
    })
  }
  return out
}

/**
 * A slot's place in the world for an angle in radians. `fit` is the frame's
 * shorter axis in world units. The same maths as Orbits.tsx.
 */
export function orbPoint(slot, angle, fit, out = {}) {
  const d = slot.radius * fit * 0.5
  const tilt = slot.tilt * DEG
  const y = Math.sin(angle) * d
  // `out` lets the scene reuse one object for every ball, every frame.
  out.x = Math.cos(angle) * d
  out.y = y * Math.cos(tilt)
  out.z = y * Math.sin(tilt)
  return out
}

/** The frame's shorter axis in world units at the core's plane, for a window in px. */
export function orbFit(width, height) {
  const worldH = 2 * ORBS.CAMERA_Z * Math.tan((ORBS.FOV * DEG) / 2)
  return Math.min(worldH, (worldH * width) / height)
}

/**
 * Where a world point lands in the window, px from the top left, with the
 * camera at rest (the scene's own slow drift moves it by a few px). `scale`
 * is the perspective factor: above 1 nearer than the core, below 1 behind it.
 */
export function orbProject(point, width, height) {
  const worldH = 2 * ORBS.CAMERA_Z * Math.tan((ORBS.FOV * DEG) / 2)
  const px = height / worldH
  const scale = ORBS.CAMERA_Z / (ORBS.CAMERA_Z - point.z)
  return { x: width / 2 + point.x * scale * px, y: height / 2 - point.y * scale * px, scale }
}

/** The name's font size in px for a window width (index.css uses the same clamp). */
export const orbFont = (width) => clamp(ORBS.FONT_VW * width, ORBS.FONT_MIN, ORBS.FONT_MAX)

/**
 * The box a ball and the name under it take in the window, for a ball centred
 * at (x, y) px: { left, right, top, bottom }. Used by the tests to hold the
 * labels apart; the HUD lays the real ones out with CSS to the same numbers.
 */
export function orbBox(name, x, y, width, height, scale = 1) {
  const ball = ORBS.BALL * Math.min(width, height) * scale
  const font = orbFont(width)
  const half = Math.max(ball, (Math.min(String(name ?? '').length, ORBS.NAME_CHARS) * ORBS.CHAR_EM * font) / 2)
  return { left: x - half, right: x + half, top: y - ball, bottom: y + ball + ORBS.LABEL_GAP + font * 1.25 }
}

/**
 * What a ball shows, from the agent's tile (tileFor in tiles.mjs):
 *   feeding  a signal runs from the ball into the core (a run is working)
 *   streams  how many of its runs are working, at most 3 (extra pulses)
 *   tint     'error' when its newest run failed or was lost and nothing is
 *            working, otherwise 'purple'
 */
export function orbSignal(tile) {
  const status = tile?.status
  const feeding = status === 'working'
  return {
    feeding,
    streams: feeding ? clamp(Math.floor(tile.working) || 1, 1, 3) : 0,
    tint: status === 'failed' || status === 'lost' ? 'error' : 'purple',
  }
}

/** 45s · 3m 05s · 1h 02m (the tiles' format). */
export function orbElapsed(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const ENDED = { done: 'Done', failed: 'Failed', lost: 'Lost' }

/**
 * The hover label for an agent, from its tile: { state, title, lines }.
 *   working  title "Working · 3m 05s", lines: the live step ("Now: ...") and
 *            the task's headline, plus "+N more running" when several run
 *   idle     title "Idle", lines: "Last: <headline>" and "Done 5m ago" /
 *            "Failed 2h ago" / "Lost 10 Nov"; or "No jobs yet"
 * state is 'working', 'failed' (failed or lost, for the error colour) or 'idle'.
 * Plain text only, already capped.
 */
export function orbHover(tile, now) {
  const run = tile?.run ?? null
  if (tile?.status === 'working' && run) {
    const lines = [`Now: ${summaryLine(tile.step) || 'Working'}`, headline(run.task)]
    if (tile.working > 1) lines.push(`+${tile.working - 1} more running`)
    return { state: 'working', title: `Working · ${orbElapsed(now - run.startedAt)}`, lines }
  }
  if (!run) return { state: 'idle', title: 'Idle', lines: ['No jobs yet'] }
  const bad = run.state === 'failed' || run.state === 'lost'
  const ended = when(run.endedAt ?? run.startedAt, now)
  return {
    state: bad ? 'failed' : 'idle',
    title: 'Idle',
    lines: [`Last: ${headline(run.task)}`, `${ENDED[run.state] ?? 'Ended'}${ended ? ` ${ended}` : ''}`],
  }
}
