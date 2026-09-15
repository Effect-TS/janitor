// The Linux sandbox as the coordinator sees it: commands, files, process
// control and directory backups. The Durable Object implements this over the
// Sandbox SDK it extends; tests provide an in-memory fake. Mutations are never
// retried here: an uncertain outcome belongs to the caller's recovery logic.
import { Context, Data, Effect, Layer } from "effect"

/** Where the session's repository checkout lives inside the container. */
export const REPOSITORY_DIR = "/workspace/repository"
/** The token file that identifies which prepared workspace a live container holds. */
export const RUNTIME_TOKEN_PATH = "/workspace/.janitor-runtime"
/** The unprivileged account that runs repository commands. */
export const WORKSPACE_USER = "janitor"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  /**
   * `unavailable`: the container could not be reached before any work started.
   * `lost`: the container was replaced while work was in flight.
   * `timeout`: the command exceeded its allowance and was stopped.
   * `failed`: the operation ran and reported a failure.
   */
  readonly reason: "unavailable" | "lost" | "timeout" | "failed"
  readonly message: string
}> {}

export interface ExecOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** Repository commands run unprivileged; infrastructure commands run as root. */
  readonly user?: "janitor" | "root"
}

export interface ExecOutcome {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
}

export interface BackupHandle {
  readonly id: string
  readonly dir: string
  readonly localBucket?: boolean
}

export interface BackupRequest {
  readonly dir: string
  readonly excludes: ReadonlyArray<string>
  readonly ttlSeconds: number
  readonly local: boolean
}

export class SandboxWorkspace extends Context.Service<
  SandboxWorkspace,
  {
    /** Advances every time the container stops; in-flight work compares it to detect replacement. */
    readonly generation: () => number
    readonly exec: (
      command: string,
      options?: ExecOptions,
    ) => Effect.Effect<ExecOutcome, WorkspaceError>
    /** UTF-8 file content, or null when the file does not exist. */
    readonly readFile: (path: string) => Effect.Effect<string | null, WorkspaceError>
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, WorkspaceError>
    /** Stops every repository process so the filesystem is quiescent. */
    readonly stopProcesses: Effect.Effect<void, WorkspaceError>
    readonly createBackup: (request: BackupRequest) => Effect.Effect<BackupHandle, WorkspaceError>
    readonly restoreBackup: (backup: BackupHandle) => Effect.Effect<void, WorkspaceError>
    /** Removes a backup's objects from the bucket; the container is not involved. */
    readonly deleteBackup: (backup: { readonly id: string }) => Effect.Effect<void, WorkspaceError>
    /** Destroys the container; the next use starts a fresh one. */
    readonly destroy: Effect.Effect<void, WorkspaceError>
    /** Keeps the container awake while a turn is in progress. */
    readonly renewActivity: () => void
  }
>()("janitor/runner/SandboxWorkspace") {
  static layer(service: SandboxWorkspace["Service"]) {
    return Layer.succeed(this, service)
  }
}

/** Quotes a string for POSIX sh. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Runs `command` as the workspace user with the repository as the working directory. */
export const asWorkspaceUser = (command: string, cwd = REPOSITORY_DIR) =>
  `cd ${shellQuote(cwd)} && runuser -u ${WORKSPACE_USER} -- bash -lc ${shellQuote(command)}`

/** Git credential and safety environment for one authenticated command. */
export const gitEnvironment = (token: string | undefined): Record<string, string> => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/true",
  ...(token === undefined
    ? {}
    : {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`,
      }),
})
