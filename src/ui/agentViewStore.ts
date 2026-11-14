import { create } from 'zustand'

/**
 * Which agent's expanded full-screen view is open (AgentView.tsx), if any.
 * Opened from a tile; closed by its Close button or Esc.
 */
type AgentViewState = {
  agent: string | null
  open: (id: string) => void
  close: () => void
}

export const useAgentView = create<AgentViewState>((set) => ({
  agent: null,
  open: (agent) => set({ agent }),
  close: () => set({ agent: null }),
}))
