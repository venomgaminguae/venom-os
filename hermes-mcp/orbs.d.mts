// Types for orbs.mjs, so the scene and the HUD (TypeScript) use the same
// ring layout, signal and hover rules the tests cover.
import type { Tile } from './tiles.mjs'

export type OrbSlot = { ring: number; radius: number; tilt: number; speed: number; phase: number }
export type OrbPoint = { x: number; y: number; z: number }
export type OrbSignal = { feeding: boolean; streams: number; tint: 'purple' | 'error' }
export type OrbHover = { state: 'working' | 'idle' | 'failed'; title: string; lines: string[] }

export declare const ORBS: {
  RADIUS: number
  RING_STEP: number
  TILT: number
  SPEED: number
  PER_RING: number
  BALL: number
  CAMERA_Z: number
  FOV: number
  FONT_MIN: number
  FONT_VW: number
  FONT_MAX: number
  CHAR_EM: number
  NAME_CHARS: number
  LABEL_GAP: number
  PURPLE: string
  ERROR: string
  PULSES: number
  PULSE_SECONDS: number
}
export declare function orbLayout(count: number): OrbSlot[]
export declare function orbPoint(slot: OrbSlot, angle: number, fit: number, out?: OrbPoint): OrbPoint
export declare function orbFit(width: number, height: number): number
export declare function orbProject(point: OrbPoint, width: number, height: number): { x: number; y: number; scale: number }
export declare function orbFont(width: number): number
export declare function orbBox(
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  scale?: number,
): { left: number; right: number; top: number; bottom: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function orbSignal(tile: Pick<Tile<any>, 'status' | 'working'> | null | undefined): OrbSignal
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function orbHover(tile: Tile<any> | null | undefined, now: number): OrbHover
export declare function orbElapsed(ms: number): string
