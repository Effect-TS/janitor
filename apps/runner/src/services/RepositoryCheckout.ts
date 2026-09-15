// Prepares the repository checkout a turn runs against. A live container that
// still holds the workspace from the last committed recovery point is reused;
// otherwise the latest recovery point is restored, and a session without one
// is cloned with a short-lived read credential. Every path finishes by
// reconciling publication effects an interrupted turn may have left on GitHub.
import { Context, Effect, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import type { RepositoryCredential } from "../Publication.ts"
import type { RunnerStorage } from "../Storage.ts"
import { RecoveryStore } from "./RecoveryStore.ts"
import {
  REPOSITORY_DIR,
  RUNTIME_TOKEN_PATH,
  SandboxWorkspace,
  WORKSPACE_USER,
  WorkspaceError,
  asWorkspaceUser,
  gitEnvironment,
  shellQuote,
} from "./SandboxWorkspace.ts"
import { WorkspacePublication } from "./WorkspacePublication.ts"

export type PreparedSource = "resumed" | "restored" | "cloned"

export interface Prepared {
  readonly source: PreparedSource
  readonly branch: string
}

export interface CheckoutDependencies {
  readonly store: RunnerStorage
  /** A read credential for cloning; null for conversation-only sessions. */
  readonly credential: () => Effect.Effect<RepositoryCredential | null, ProtocolError>
  /** The branch an associated pull request expects, or null for the default branch. */
  readonly associatedBranch: () => Effect.Effect<string | null, ProtocolError>
  readonly remote: (credential: RepositoryCredential) => string
  readonly clock: () => number
}

const CLONE_TIMEOUT_MS = 600_000

export class RepositoryCheckout extends Context.Service<
  RepositoryCheckout,
  {
    readonly prepare: Effect.Effect<Prepared, WorkspaceError | ProtocolError>
    /** True when the live container still holds the workspace the records describe. */
    readonly intact: Effect.Effect<boolean, WorkspaceError>
    /** A turn is about to change files; the container's contents no longer match a recovery point. */
    readonly markDirty: () => void
    /** The recovery point just committed describes the container's contents. */
    readonly markSaved: (restoredFrom: string | null) => void
  }
>()("janitor/runner/RepositoryCheckout") {
  static make(
    deps: CheckoutDependencies,
    workspace: SandboxWorkspace["Service"],
    recovery: RecoveryStore["Service"],
    publication: WorkspacePublication["Service"],
  ): RepositoryCheckout["Service"] {
    const { store } = deps
    const readToken = workspace.readFile(RUNTIME_TOKEN_PATH)
    const intact = Effect.gen(function* () {
      const state = store.workspace
      if (state === undefined) return false
      const token = yield* readToken
      return token !== null && token.trim() === state.token
    })
    const stamp = Effect.fn("RepositoryCheckout.stamp")(function* (
      restoredFrom: string | null,
      branch: string,
    ) {
      const token = crypto.randomUUID()
      yield* workspace.writeFile(RUNTIME_TOKEN_PATH, token)
      store.workspace = { token, dirty: false, restoredFrom, branch }
    })
    const currentBranch = workspace
      .exec(asWorkspaceUser("git rev-parse --abbrev-ref HEAD"), {
        cwd: REPOSITORY_DIR,
        user: "root",
      })
      .pipe(Effect.map((outcome) => (outcome.exitCode === 0 ? outcome.stdout.trim() : "HEAD")))

    const clone = Effect.fn("RepositoryCheckout.clone")(function* () {
      const credential = yield* deps.credential()
      if (credential === null) {
        yield* workspace.exec(
          `mkdir -p ${REPOSITORY_DIR} && chown -R ${WORKSPACE_USER}:${WORKSPACE_USER} ${REPOSITORY_DIR}`,
          { user: "root" },
        )
        yield* stamp(null, "")
        return { source: "cloned", branch: "" } satisfies Prepared
      }
      const branch = yield* deps.associatedBranch()
      const target = REPOSITORY_DIR
      const command = [
        `rm -rf ${shellQuote(target)}`,
        `mkdir -p /workspace && chown ${WORKSPACE_USER}:${WORKSPACE_USER} /workspace`,
        `runuser -u ${WORKSPACE_USER} -- git clone --quiet${branch === null ? "" : ` --branch ${shellQuote(branch)}`} ${shellQuote(deps.remote(credential))} ${shellQuote(target)}`,
      ].join(" && ")
      const cloned = yield* workspace.exec(command, {
        env: gitEnvironment(credential.token),
        timeoutMs: CLONE_TIMEOUT_MS,
        user: "root",
      })
      if (cloned.exitCode !== 0 || cloned.timedOut)
        return yield* Effect.fail(
          new ProtocolError(
            "blocked",
            cloned.timedOut
              ? "Cloning the repository exceeded its time allowance"
              : `Cloning the repository failed: ${redact(cloned.stderr, credential.token)}`,
          ),
        )
      const checkedOut = yield* currentBranch
      yield* stamp(null, checkedOut)
      return { source: "cloned", branch: checkedOut } satisfies Prepared
    })

    const restore = Effect.fn("RepositoryCheckout.restore")(function* (
      point: NonNullable<ReturnType<RecoveryStore["Service"]["current"]>>,
    ) {
      yield* workspace.exec(`mkdir -p ${REPOSITORY_DIR}`, { user: "root" })
      yield* recovery.restore(point)
      const verified = yield* workspace.exec(`test -d ${shellQuote(`${REPOSITORY_DIR}/.git`)}`, {
        user: "root",
      })
      if (verified.exitCode !== 0)
        return yield* Effect.fail(
          new WorkspaceError({
            reason: "failed",
            message: "The restored recovery point does not contain the repository",
          }),
        )
      yield* workspace
        .exec(`chown -R ${WORKSPACE_USER}:${WORKSPACE_USER} ${shellQuote(REPOSITORY_DIR)}`, {
          user: "root",
        })
        .pipe(Effect.ignore)
      const branch = yield* currentBranch
      yield* stamp(point.backup.id, branch)
      return { source: "restored", branch } satisfies Prepared
    })

    const prepare = Effect.gen(function* () {
      const generation = workspace.generation()
      const state = store.workspace
      let prepared: Prepared
      if (state !== undefined && !state.dirty && (yield* intact)) {
        prepared = { source: "resumed", branch: state.branch }
      } else {
        const point = recovery.current()
        prepared = point === undefined ? yield* clone() : yield* restore(point)
        if (state?.dirty) store.journal("workspace-rolled-back", { source: prepared.source })
      }
      if (prepared.branch !== "") yield* publication.reconcile
      if (workspace.generation() !== generation)
        return yield* Effect.fail(
          new WorkspaceError({
            reason: "lost",
            message: "The sandbox was replaced during preparation",
          }),
        )
      return prepared
    }).pipe(Effect.withSpan("RepositoryCheckout.prepare"))

    return {
      prepare,
      intact,
      markDirty: () => {
        const state = store.workspace
        if (state !== undefined) store.workspace = { ...state, dirty: true }
      },
      markSaved: (restoredFrom) => {
        const state = store.workspace
        if (state !== undefined) store.workspace = { ...state, dirty: false, restoredFrom }
      },
    }
  }
  static layer(deps: CheckoutDependencies) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const workspace = yield* SandboxWorkspace
        const recovery = yield* RecoveryStore
        const publication = yield* WorkspacePublication
        return RepositoryCheckout.make(deps, workspace, recovery, publication)
      }),
    )
  }
}

const redact = (text: string, token: string | undefined) =>
  token ? text.replaceAll(token, "[REDACTED]") : text
