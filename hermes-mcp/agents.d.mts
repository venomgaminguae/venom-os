// Types for agents.mjs. The roster itself is data (venom.agents.json, read
// by roster.mjs in Node); the HUD imports only these types and gets the
// roster from the bridge.
export type AgentKind = 'specialist' | 'project' | 'advisor'
export type AgentInfo = { id: string; name: string; role: string; kind: AgentKind; pinned?: boolean }
export declare const AGENTS: AgentInfo[]
export declare const AGENT_IDS: string[]
export declare const ROSTER_SOURCE: 'file' | 'starter'
export declare function rosterLines(): string
