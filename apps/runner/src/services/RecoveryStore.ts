// Recovery points for one session: a Sandbox directory backup in R2 plus the
// authoritative pointer in Durable Object SQLite. Upload and pointer commit are
// separate operations: only the committed pointer makes a backup the session's
// recovery point, and the predecessor is deleted only after that commit.
import { Context, Effect, Layer } from "effect"
import type { RecoveryPoint, RunnerStorage } from "../Storage.ts"
import {
  REPOSITORY_DIR,
  SandboxWorkspace,
  type BackupHandle,
  type WorkspaceError,
} from "./SandboxWorkspace.ts"

/** Backups must outlive the session; expiry is checked at restore, never during a turn. */
export const RECOVERY_TTL_SECONDS = 10 * 365 * 24 * 60 * 60

/** Disposable caches omitted from recovery points; everything else, including untracked work, is kept. */
export const DEFAULT_EXCLUDES: ReadonlyArray<string> = [
  "node_modules",
  ".pnpm-store",
  ".yarn/cache",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
]

export interface RecoveryOptions {
  readonly local: boolean
  readonly excludes?: ReadonlyArray<string>
}

export class RecoveryStore extends Context.Service<
  RecoveryStore,
  {
    readonly current: () => RecoveryPoint | undefined
    /** Uploads a backup of the quiescent repository. Nothing is authoritative until `commit`. */
    readonly capture: Effect.Effect<BackupHandle, WorkspaceError>
    /** Synchronous: runs inside the caller's transaction with the completed-turn record. */
    readonly commit: (backup: BackupHandle, inputId: string, attempt: number, now: number) => void
    readonly restore: (point: RecoveryPoint) => Effect.Effect<void, WorkspaceError>
    /** Deletes backups queued as obsolete; failures are journaled and retried on the next call. */
    readonly prune: Effect.Effect<void>
    /** Removes every backup the session still references. */
    readonly deleteAll: Effect.Effect<void>
  }
>()("janitor/runner/RecoveryStore") {
  static make(
    store: RunnerStorage,
    workspace: SandboxWorkspace["Service"],
    options: RecoveryOptions,
  ): RecoveryStore["Service"] {
    const excludes = options.excludes ?? DEFAULT_EXCLUDES
    const prune = Effect.gen(function* () {
      for (const obsolete of store.obsoleteBackups) {
        const deleted = yield* workspace.deleteBackup({ id: obsolete.backupId }).pipe(Effect.result)
        if (deleted._tag === "Failure") {
          store.journal("backup-delete-failed", {
            backupId: obsolete.backupId,
            error: deleted.failure.message,
          })
          continue
        }
        store.removeObsoleteBackup(obsolete.backupId)
      }
    })
    return {
      current: () => store.recoveryPoint,
      capture: workspace
        .createBackup({
          dir: REPOSITORY_DIR,
          excludes,
          ttlSeconds: RECOVERY_TTL_SECONDS,
          local: options.local,
        })
        .pipe(Effect.withSpan("RecoveryStore.capture")),
      commit: (backup, inputId, attempt, now) => {
        const previous = store.recoveryPoint
        store.recoveryPoint = { backup, inputId, attempt, committedAt: now }
        if (previous !== undefined && previous.backup.id !== backup.id)
          store.queueObsoleteBackup(previous.backup.id, previous.backup.localBucket === true, now)
      },
      restore: (point) =>
        workspace.restoreBackup(point.backup).pipe(Effect.withSpan("RecoveryStore.restore")),
      prune: prune.pipe(Effect.withSpan("RecoveryStore.prune")),
      deleteAll: Effect.gen(function* () {
        const current = store.recoveryPoint
        if (current !== undefined) {
          store.queueObsoleteBackup(
            current.backup.id,
            current.backup.localBucket === true,
            Date.now(),
          )
          store.recoveryPoint = undefined
        }
        yield* prune
      }),
    }
  }
  static layer(store: RunnerStorage, options: RecoveryOptions) {
    return Layer.effect(
      this,
      Effect.map(SandboxWorkspace, (workspace) => this.make(store, workspace, options)),
    )
  }
}
