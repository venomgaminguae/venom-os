import type { Plugin } from 'vite'

export const ORT_BASE: '/ort/'
export const ORT_FILES: Readonly<Record<string, string>>
export function ortDir(root?: string): string
export function ortFile(url: string | undefined, root?: string): string | null
export function ortRuntime(): Plugin
