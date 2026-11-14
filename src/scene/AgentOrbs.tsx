import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { orbShared } from './orbShared'
import { ORBS, orbLayout, orbPoint, type OrbSignal, type OrbSlot } from '../../hermes-mcp/orbs.mjs'

/**
 * The agent team as purple balls orbiting the reactor.
 *
 * Each roster agent gets a small glowing ball on a wide tilted ring outside the
 * core (the ring maths and every constant live in hermes-mcp/orbs.mjs, which
 * the tests cover). An agent that is working feeds the core: a thin beam from
 * its ball to the centre with bright pulses running inward along it, one train
 * of pulses per working run.
 *
 * Not one element in here is React, for the same reason as Orbits.tsx: the
 * roster changes while the scene runs, and expressing that as JSX would put
 * scene mounts on the React render path and rebuild materials on a re-render.
 * So the group is built by hand and reconciled inside useFrame when the
 * roster's array identity changes, and everything else is plain mutation.
 *
 * The contract with the HUD is src/scene/orbShared.ts. The HUD writes `order`,
 * `signals`, `hover`, `els` and `layer`; this file only reads those. Each frame
 * it writes every ball's window position into `at` (one reused object per
 * agent), moves the agent's DOM anchor there with a transform, and fades the
 * whole DOM layer in step with the balls, touching the DOM only when a value
 * actually changed.
 *
 * The feeds are one LineSegments and one Points for the whole team, so their
 * cost does not grow with how many agents are working: an agent that is not
 * feeding just has its vertices coloured black, which is invisible under
 * additive blending.
 */

const DEG = Math.PI / 180
/** Revolutions per minute to radians per second. */
const RPM = (Math.PI * 2) / 60

/** Most pulse trains one feed shows (orbSignal caps streams at 3 too). */
const MAX_STREAMS = 3

/* Look. All multipliers on the ball's colour; bloom kicks in above 0.3. */
/** Brightness of an idle ball: clearly there, calmer than the core. */
const IDLE_POWER = 0.75
/** Extra brightness while feeding, plus the breathing swing on top. */
const FEED_POWER = 0.55
const BREATHE_POWER = 0.3
/** Breathing rate of a feeding ball, radians per second. */
const BREATHE_RATE = 2.2
/** Size and brightness gained by the ball under the pointer. */
const HOVER_SCALE = 0.35
const HOVER_POWER = 0.6
/** Soft halo diameter as a multiple of the ball radius, and its strength. */
const HALO_SCALE = 4.2
const HALO_OPACITY = 0.32
/** Beam brightness at the ball end and at the core end. */
const BEAM_OUTER = 0.55
const BEAM_INNER = 0.12
/** Beam brightness under reduced motion, where it carries the whole signal. */
const BEAM_STEADY = 0.8
/**
 * Pulse brightness and sprite size per unit of fit. PointsMaterial's size
 * attenuation divides by distance but not by tan(fov / 2), so at fov 45 a
 * point draws about 0.41 of this in world units: 4 ball radii comes out near
 * the ball's own diameter, and the soft sprite makes it read smaller.
 */
const PULSE_POWER = 1.7
const PULSE_SIZE = ORBS.BALL * 4

const PURPLE = new THREE.Color(ORBS.PURPLE)
const ERROR = new THREE.Color(ORBS.ERROR)

const ballVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`

/*
 * Unlit, so the roundness has to be painted on: a fresnel rim for the edge, a
 * hot centre falling off towards it, and a small fixed highlight up and to the
 * left so the eye reads a sphere rather than a disc.
 */
const ballFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    float facing = clamp(dot(n, normalize(vView)), 0.0, 1.0);
    float rim = pow(1.0 - facing, 2.2);
    float core = pow(facing, 3.0);
    float spec = pow(max(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0), 18.0);
    vec3 col = uColor * (0.25 + rim * 1.5 + core * 0.8) + vec3(spec * 0.55);
    gl_FragColor = vec4(col * uPower, 1.0);
  }
`

type Entry = {
  id: string
  slot: OrbSlot
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
  halo: THREE.Sprite
  /** Eased toward the tint; shared by reference with the shader uniform. */
  color: THREE.Color
  signal: OrbSignal | null
  /** 0..1, eased toward feeding so a signal fades rather than pops. */
  level: number
  /** 0..1, eased toward being hovered. */
  hover: number
  /** Breathing / pulse offset, so feeds do not beat in unison. */
  seed: number
  /** Reused object published in orbShared.at. */
  at: { x: number; y: number; scale: number }
  /** Last transform written, rounded to 0.1px, and the element it went to. */
  tx: number
  ty: number
  el: HTMLElement | null
}

/** A small round soft sprite for the halo and the pulses. */
function makeDot(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.7)')
    g.addColorStop(0.6, 'rgba(255,255,255,0.15)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  return new THREE.CanvasTexture(canvas)
}

function release(group: THREE.Group, entry: Entry) {
  entry.mesh.material.dispose()
  entry.halo.material.dispose()
  group.remove(entry.mesh)
  if (orbShared.at.get(entry.id) === entry.at) orbShared.at.delete(entry.id)
}

export function AgentOrbs() {
  const group = useMemo(() => {
    const g = new THREE.Group()
    g.visible = false
    return g
  }, [])
  /** One sphere for every ball; only scale and uniforms differ. */
  const sphere = useMemo(() => new THREE.SphereGeometry(1, 24, 16), [])
  const dot = useMemo(makeDot, [])
  const entries = useMemo(() => new Map<string, Entry>(), [])
  /** Entries in ring order, rebuilt with the roster; the feed buffers follow it. */
  const list = useMemo<Entry[]>(() => [], [])

  const beamMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  )
  const pulseMat = useMemo(
    () =>
      new THREE.PointsMaterial({
        map: dot,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [dot],
  )
  const beams = useMemo(() => {
    const l = new THREE.LineSegments(new THREE.BufferGeometry(), beamMat)
    l.frustumCulled = false
    group.add(l)
    return l
  }, [beamMat, group])
  const pulses = useMemo(() => {
    const p = new THREE.Points(new THREE.BufferGeometry(), pulseMat)
    p.frustumCulled = false
    group.add(p)
    return p
  }, [pulseMat, group])

  /** Everything the frame loop carries between frames, in one mutable object. */
  const run = useMemo(
    () => ({
      order: null as string[] | null,
      signals: null as Map<string, OrbSignal> | null,
      /** Shared ring angle, radians, accumulated so a hover stop is smooth. */
      turn: 0,
      /** 1 turning, eased to 0 while a ball is hovered. */
      speed: 1,
      /** 0..1 fade of balls, feeds and the DOM layer. */
      vis: 0,
      opacity: -1,
      visibility: '',
      layer: null as HTMLElement | null,
      /** Feed buffers were written last frame; one more write clears them. */
      lit: false,
      still: false,
      v: new THREE.Vector3(),
      /** The ball's world position, reused for every ball. */
      p: { x: 0, y: 0, z: 0 },
    }),
    [],
  )

  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    run.still = mql.matches
    const onChange = (e: MediaQueryListEvent) => {
      run.still = e.matches
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [run])

  useEffect(() => {
    return () => {
      for (const entry of entries.values()) release(group, entry)
      entries.clear()
      list.length = 0
      sphere.dispose()
      dot.dispose()
      beams.geometry.dispose()
      pulses.geometry.dispose()
      beamMat.dispose()
      pulseMat.dispose()
    }
  }, [entries, list, group, sphere, dot, beams, pulses, beamMat, pulseMat])

  function spawn(id: string, slot: OrbSlot): Entry {
    const color = PURPLE.clone()
    const material = new THREE.ShaderMaterial({
      vertexShader: ballVertex,
      fragmentShader: ballFragment,
      uniforms: { uColor: { value: color }, uPower: { value: IDLE_POWER } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    const mesh = new THREE.Mesh(sphere, material)
    mesh.frustumCulled = false
    // A child of the ball, so it inherits the ball's size and hover growth.
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: dot,
        color,
        transparent: true,
        opacity: HALO_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    halo.scale.setScalar(HALO_SCALE)
    mesh.add(halo)
    group.add(mesh)
    const at = { x: 0, y: 0, scale: 1 }
    orbShared.at.set(id, at)
    return {
      id,
      slot,
      mesh,
      halo,
      color,
      signal: null,
      level: 0,
      hover: 0,
      seed: Math.random() * Math.PI * 2,
      at,
      tx: NaN,
      ty: NaN,
      el: null,
    }
  }

  function sync(order: string[]) {
    const slots = orbLayout(order.length)
    const alive = new Set(order)
    for (const [id, entry] of entries) {
      if (alive.has(id)) continue
      release(group, entry)
      entries.delete(id)
    }
    list.length = 0
    order.forEach((id, i) => {
      let entry = entries.get(id)
      if (!entry) {
        entry = spawn(id, slots[i])
        entries.set(id, entry)
      }
      entry.slot = slots[i]
      entry.signal = orbShared.signals.get(id) ?? null
      list.push(entry)
    })

    // The feed buffers are sized by the roster, so they follow it and nothing
    // else. Dynamic usage: they are rewritten every frame something feeds.
    const n = list.length
    const bg = new THREE.BufferGeometry()
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage))
    bg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage))
    beams.geometry.dispose()
    beams.geometry = bg
    const per = ORBS.PULSES * MAX_STREAMS
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * per * 3), 3).setUsage(THREE.DynamicDrawUsage))
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * per * 3), 3).setUsage(THREE.DynamicDrawUsage))
    pulses.geometry.dispose()
    pulses.geometry = pg
    run.lit = false
  }

  useFrame((state, dt) => {
    const { order, signals, hover, els, layer } = orbShared
    if (order !== run.order) {
      run.order = order
      run.signals = signals
      sync(order)
    } else if (signals !== run.signals) {
      run.signals = signals
      for (const entry of list) entry.signal = signals.get(entry.id) ?? null
    }

    // Fade with the reactor: nothing of the team shows before it is powered on.
    const phase = useStore.getState().phase
    const want = phase === 'offline' || phase === 'boot' ? 0 : 1
    run.vis += (want - run.vis) * Math.min(1, dt * 2.5)
    if (want === 0 && run.vis < 0.002) run.vis = 0
    if (want === 1 && run.vis > 0.998) run.vis = 1
    const vis = run.vis

    // The layer can be swapped by the HUD; a new one gets the current values.
    if (layer !== run.layer) {
      run.layer = layer
      run.opacity = -1
      run.visibility = ''
    }
    if (layer) {
      // Compared as a rounded number so a steady layer costs no string.
      const opacity = Math.round(vis * 1000) / 1000
      if (opacity !== run.opacity) {
        run.opacity = opacity
        layer.style.opacity = String(opacity)
      }
      const visibility = vis === 0 ? 'hidden' : 'visible'
      if (visibility !== run.visibility) {
        run.visibility = visibility
        layer.style.visibility = visibility
      }
    }
    group.visible = vis > 0
    if (vis === 0 || list.length === 0) return

    const still = run.still
    // Hovering holds the rings still so the ball stays under the pointer.
    run.speed += ((hover === null ? 1 : 0) - run.speed) * Math.min(1, dt * 4)
    if (!still) run.turn += dt * ORBS.SPEED * RPM * run.speed

    const fit = Math.min(state.viewport.width, state.viewport.height)
    const radius = ORBS.BALL * fit
    const t = state.clock.elapsedTime
    const k = Math.min(1, dt * 4)
    const tintK = Math.min(1, dt * 3)
    const { width, height } = state.size
    const v = run.v

    const bPos = beams.geometry.getAttribute('position') as THREE.BufferAttribute
    const bCol = beams.geometry.getAttribute('color') as THREE.BufferAttribute
    const pPos = pulses.geometry.getAttribute('position') as THREE.BufferAttribute
    const pCol = pulses.geometry.getAttribute('color') as THREE.BufferAttribute
    const bp = bPos.array as Float32Array
    const bc = bCol.array as Float32Array
    const pp = pPos.array as Float32Array
    const pc = pCol.array as Float32Array
    const per = ORBS.PULSES * MAX_STREAMS
    let lit = false

    for (let i = 0; i < list.length; i++) {
      const entry = list[i]
      const slot = entry.slot
      const signal = entry.signal
      const feeding = signal?.feeding === true

      entry.level += ((feeding ? 1 : 0) - entry.level) * k
      if (!feeding && entry.level < 0.001) entry.level = 0
      entry.hover += ((hover === entry.id ? 1 : 0) - entry.hover) * k
      entry.color.lerp(signal?.tint === 'error' ? ERROR : PURPLE, tintK)

      // speed / SPEED is +1 or -1 per ring, so alternate rings counter-rotate.
      const angle = slot.phase * DEG + run.turn * (slot.speed / ORBS.SPEED)
      const p = orbPoint(slot, angle, fit, run.p)
      const mesh = entry.mesh
      mesh.position.set(p.x, p.y, p.z)

      const breathe = still ? 0.5 : Math.sin(t * BREATHE_RATE + entry.seed) * 0.5 + 0.5
      const level = entry.level
      mesh.scale.setScalar(radius * (1 + HOVER_SCALE * entry.hover) * (1 + 0.06 * level * breathe))
      mesh.material.uniforms.uPower.value =
        (IDLE_POWER + level * (FEED_POWER + BREATHE_POWER * breathe) + HOVER_POWER * entry.hover) * vis
      entry.halo.material.opacity = HALO_OPACITY * (1 + level * 0.6 + entry.hover * 0.5) * vis

      // Window position for the DOM anchor and the hover label.
      v.set(p.x, p.y, p.z).project(state.camera)
      const x = (v.x * 0.5 + 0.5) * width
      const y = (-v.y * 0.5 + 0.5) * height
      const at = entry.at
      at.x = x
      at.y = y
      at.scale = ORBS.CAMERA_Z / (ORBS.CAMERA_Z - p.z)
      // Compare rounded numbers rather than strings, so an unmoved anchor costs
      // no string at all.
      const el = els.get(entry.id) ?? null
      const tx = Math.round(x * 10) / 10
      const ty = Math.round(y * 10) / 10
      if (el && (el !== entry.el || tx !== entry.tx || ty !== entry.ty)) {
        el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
      }
      entry.el = el
      entry.tx = tx
      entry.ty = ty

      // Feeds. Only touched while something is lit; see run.lit below.
      if (level > 0.001) lit = true
      if (!lit && !run.lit) continue
      const r = entry.color.r * level * vis
      const g = entry.color.g * level * vis
      const b = entry.color.b * level * vis
      const beam = still ? BEAM_STEADY : BEAM_OUTER
      const o = i * 6
      bp[o] = p.x
      bp[o + 1] = p.y
      bp[o + 2] = p.z
      bp[o + 3] = 0
      bp[o + 4] = 0
      bp[o + 5] = 0
      bc[o] = r * beam
      bc[o + 1] = g * beam
      bc[o + 2] = b * beam
      bc[o + 3] = r * BEAM_INNER
      bc[o + 4] = g * BEAM_INNER
      bc[o + 5] = b * BEAM_INNER

      const streams = still || level === 0 ? 0 : Math.min(MAX_STREAMS, signal?.streams ?? 0)
      for (let s = 0; s < MAX_STREAMS; s++) {
        for (let q = 0; q < ORBS.PULSES; q++) {
          const j = (i * per + s * ORBS.PULSES + q) * 3
          if (s >= streams) {
            pc[j] = pc[j + 1] = pc[j + 2] = 0
            continue
          }
          // 0 at the ball, 1 at the core. Extra streams interleave between the
          // first stream's pulses rather than riding on top of them.
          const u =
            (t / ORBS.PULSE_SECONDS + (q + s / streams) / ORBS.PULSES + entry.seed) % 1
          const w = 1 - u
          pp[j] = p.x * w
          pp[j + 1] = p.y * w
          pp[j + 2] = p.z * w
          // Fades in leaving the ball and out arriving at the centre.
          const a = Math.sin(u * Math.PI) * PULSE_POWER
          pc[j] = r * a
          pc[j + 1] = g * a
          pc[j + 2] = b * a
        }
      }
    }

    pulseMat.size = PULSE_SIZE * fit
    // Write while anything is lit, and once more after the last one went dark
    // so the buffers end up black instead of frozen mid-pulse.
    if (lit || run.lit) {
      bPos.needsUpdate = true
      bCol.needsUpdate = true
      pPos.needsUpdate = true
      pCol.needsUpdate = true
    }
    run.lit = lit
  })

  return <primitive object={group} />
}
