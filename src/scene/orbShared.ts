import type { OrbSignal } from '../../hermes-mcp/orbs.mjs'

/**
 * The one place the 3D agent orbs (AgentOrbs.tsx, inside the canvas) and their
 * DOM layer (src/ui/OrbLabels.tsx, inside the HUD) meet. A plain mutable
 * object, not a store: the scene writes positions sixty times a second and
 * nothing here may cause a React render.
 *
 *   HUD  -> scene   order (agent ids, in ring order), signals (what each ball
 *                   shows), hover (the id under the pointer, or null)
 *   scene -> HUD    writes each registered element's transform directly, and
 *                   the layer's opacity; `at` holds the last px position of
 *                   each ball so the HUD can place the hover label
 */
export const orbShared = {
  /** Agent ids in ring order. Replaced (new array identity) when the roster changes. */
  order: [] as string[],
  /** What each ball shows, by agent id. Replaced (new Map identity) when a run changes. */
  signals: new Map<string, OrbSignal>(),
  /** The agent whose ball is under the pointer, or null. While set, the rings hold still. */
  hover: null as string | null,
  /** Each agent's DOM anchor (a zero-size box the scene moves to the ball's centre). */
  els: new Map<string, HTMLElement>(),
  /** The DOM layer holding the anchors; the scene fades it with the balls. */
  layer: null as HTMLElement | null,
  /** Last window position of each ball's centre in CSS px, and its perspective scale. */
  at: new Map<string, { x: number; y: number; scale: number }>(),
}
