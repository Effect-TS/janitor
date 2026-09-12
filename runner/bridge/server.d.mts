export function startBridge(options: {
  token: string
  generation: number
  cwd: string
  journalPath: string
  isolateProcesses?: boolean
  port?: number
  host?: string
}): Promise<{ url: string; epoch: string; close(): Promise<void> }>
