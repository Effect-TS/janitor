export function startBridge(options: {
  token: string
  generation: number
  cwd: string
  journalPath: string
  isolateProcesses?: boolean
  port?: number
  cloneOrigin?: string
  host?: string
}): Promise<{ url: string; epoch: string; close(): Promise<void> }>
export const protocol: number
export const capabilities: ReadonlyArray<string>
export const build: { sourceHash: string } | null
