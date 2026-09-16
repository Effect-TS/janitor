import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"

export interface SandboxExecOptions {
  /** Workspace-relative working directory. Defaults to the workspace root. */
  readonly cwd?: string
  /** Variables added to or overriding the sandbox environment. */
  readonly env?: Record<string, string>
  /** Timeout in milliseconds. Defaults to 60_000. */
  readonly timeout?: number
  /** Retain the newest output bytes per stream. Defaults to 1_048_576. */
  readonly maxRetainedBytes?: number
}

export interface SandboxExecResult {
  /** Whether exitCode is zero. */
  readonly success: boolean
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Whether older stdout was dropped to meet the retention limit. */
  readonly stdoutTruncated: boolean
  /** Whether older stderr was dropped to meet the retention limit. */
  readonly stderrTruncated: boolean
  readonly durationMs: number
}

export interface SandboxEntry {
  readonly name: string
  readonly type: "file" | "directory" | "other"
}

/** Optional interactive terminals owned by the sandbox machine. */
export interface SandboxPty {
  /** Create a terminal or resize an existing one. cwd is workspace-relative. */
  readonly open: (
    id: string,
    cols: number,
    rows: number,
    cwd?: string,
  ) => Effect.Effect<void, string>
  /** Replay retained output, then stream live output until the shell exits. */
  readonly stream: (id: string) => Stream.Stream<Uint8Array, string>
  readonly input: (id: string, data: string) => Effect.Effect<void, string>
  readonly resize: (id: string, cols: number, rows: number) => Effect.Effect<void, string>
  readonly close: (id: string) => Effect.Effect<void, string>
}

/** Optional lifecycle operations for backends that own a machine. */
export interface SandboxLifecycle {
  /** Suspend compute while preserving machine state. */
  readonly suspend: Effect.Effect<void, string>
  readonly resume?: Effect.Effect<void, string>
  /** Terminate the machine and discard its disk. Idempotent. */
  readonly destroy: Effect.Effect<void, string>
}

/** Shell and file operations on a workspace, with string-valued failures. */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** Run shell text to completion. Separate args are shell-quoted and appended. */
    readonly exec: (
      command: string,
      args?: ReadonlyArray<string>,
      options?: SandboxExecOptions,
    ) => Effect.Effect<SandboxExecResult, string>
    /** Read UTF-8 text; reject binary files. */
    readonly readFile: (path: string) => Effect.Effect<string, string>
    /** Write atomically, creating parent directories as needed. */
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, string>
    readonly deleteFile: (path: string) => Effect.Effect<void, string>
    /** Create a directory recursively. */
    readonly mkdir: (path: string) => Effect.Effect<void, string>
    /** List immediate entries. Defaults to the workspace root. */
    readonly listFiles: (path?: string) => Effect.Effect<ReadonlyArray<SandboxEntry>, string>
    readonly exists: (path: string) => Effect.Effect<boolean, string>
    readonly pty?: SandboxPty
    readonly lifecycle?: SandboxLifecycle
  }
>()("@janitor/alchemy/AI/Sandbox") {}
