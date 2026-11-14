// Types for pinned.mjs, so the HUD (TypeScript) can use the same pinned-agent
// rules the bridge does.
type RunLike = {
  id: string
  agent: string
  task: string
  state: 'working' | 'done' | 'failed' | 'lost'
  startedAt: number
  endedAt: number | null
  steps: { text: string; ts: number }[]
  summary: string
}
export type PinnedJob = {
  id: string
  state: RunLike['state']
  headline: string
  when: string
  line: string
  startedAt: number
}
export declare const PINNED_JOBS: number
export declare const HEADLINE_CAP: number
export declare const LINE_CAP: number
export declare function keepRuns<T extends { agent: string; startedAt: number }>(
  runs: T[],
  max: number,
  pinned?: string[],
  perPinned?: number,
): T[]
export declare function headline(task: unknown, cap?: number): string
export declare function summaryLine(text: unknown, cap?: number): string
export declare function when(ts: number | null | undefined, now: number): string
export declare function jobsFor(runs: RunLike[], agent: string, now: number, limit?: number): PinnedJob[]
