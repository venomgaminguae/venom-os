// Types for tiles.mjs, so the HUD (TypeScript) can use the same tile, layout
// and result-formatting rules the tests cover.
type RunLike = {
  id: string
  agent: string
  task: string
  state: 'working' | 'done' | 'failed' | 'lost'
  startedAt: number
  endedAt: number | null
  steps: { text: string; ts: number }[]
  summary: string
  full?: boolean
}
export type TileStatus = 'idle' | 'working' | 'done' | 'failed' | 'lost'
export type TileJob = {
  id: string
  state: RunLike['state']
  headline: string
  when: string
  line: string
}
export type Tile<R extends RunLike = RunLike> = {
  status: TileStatus
  working: number
  run: R | null
  step: string
  job: TileJob | null
}
export type TileLayout = {
  mode: 'columns' | 'column' | 'strip'
  left: number
  right: number
  compact: boolean
  tileWidth: number
}
export type LinkPart = { text: string; href?: string }
export type ResultBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; parts: LinkPart[] }
  | { type: 'bullet'; depth: number; parts: LinkPart[] }
  | { type: 'para'; parts: LinkPart[] }
  | { type: 'code'; text: string }
  | { type: 'rule' }

export declare const LAYOUT: {
  EDGE: number
  GAP: number
  COLUMN_EDGE: number
  COLUMN_GAP: number
  TOP: number
  BOTTOM: number
  MIN_COLUMNS_HEIGHT: number
  MIN_FULL_TILE: number
  MIN_COLUMN: number
  MAX_COLUMN: number
  MIN_STRIP: number
  RING_FIT: number
}
export declare const RUN_ID: RegExp
export declare const RESULT_CAP: number
export declare const MAX_BLOCKS: number
export declare function tileOrder<T extends { id: string; pinned?: boolean }>(roster: T[], first?: string[]): T[]
export declare function tileFor<R extends RunLike>(runs: R[], agentId: string, now: number, doneHoldMs?: number): Tile<R>
export declare function ringSize(width: number, height: number): number
export declare function tileLayout(width: number, height: number, count: number): TileLayout
export declare function isRunId(s: unknown): s is string
export declare function mergeRuns<R extends RunLike>(fetched: R[], live: R[]): R[]
export declare function linkParts(line: unknown): LinkPart[]
export declare function formatResult(text: unknown, maxBlocks?: number): ResultBlock[]
