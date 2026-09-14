import { Context, Effect, Layer } from "effect"
import { decideCompatibility, type CompatibilityDecision } from "../Compatibility.ts"
import {
  ModelConfigurationError,
  findRecord,
  type ModelConfigurations,
} from "../ModelConfiguration.ts"
import {
  JANITOR_STATE_FORMAT,
  NATIVE_MIGRATION_TARGET,
  RELEASE_MANIFEST,
  SUPPORTED_NATIVE_MIGRATIONS,
} from "../ReleaseManifest.ts"
import { PROTOCOL_VERSION, ProtocolError } from "../Protocol.ts"
import type { RunnerStorage } from "../Storage.ts"
import { WorkspaceCheckpoints } from "../WorkspaceCheckpoints.ts"

type Ready = Extract<CompatibilityDecision, { kind: "ready" }>
interface Dependencies {
  store: RunnerStorage
  storage: DurableObjectStorage
  bucket: R2Bucket | undefined
  configurations: ModelConfigurations | ModelConfigurationError
  release: () => string
}
/** Owns the migration intent and read compatibility barrier around native SDK initialization. */
export class SessionCompatibility extends Context.Service<
  SessionCompatibility,
  {
    readonly stateProblem: Effect.Effect<string | null>
    readonly checkpointProblem: Effect.Effect<string | null>
    readonly begin: Effect.Effect<Ready, unknown>
    readonly complete: (decision: Ready) => Effect.Effect<void, unknown>
  }
>()("janitor/runner/SessionCompatibility") {
  static make({
    store,
    storage,
    bucket,
    configurations,
    release,
  }: Dependencies): SessionCompatibility["Service"] {
    const stateProblem = (): string | null => {
      const blockers = store.blockers
      if (blockers.length > 0) return blockers[0]!
      if (configurations instanceof ModelConfigurationError) return configurations.message
      const modelId = store.session?.modelConfigurationId ?? store.intendedModelConfigurationId
      if (modelId !== undefined) {
        const record = findRecord(configurations, modelId)
        if (record === undefined)
          return `Model configuration ${modelId} is unavailable. Restore its record or start a new session if the model was retired.`
        if (
          store.modelConfigurationSnapshot !== undefined &&
          store.modelConfigurationSnapshot !== JSON.stringify(record)
        )
          return `Model configuration ${modelId} changed. Restore the original record; use a new configuration ID for new sessions.`
      }
      const decision = decideCompatibility({
        record: store.compatibility,
        nativeInitialized: store.nativeInitialized,
        applied: store.nativeMigrations,
      })
      if (decision.kind === "blocked") return decision.reason
      if (!decision.upgradeFormat && store.compatibility !== undefined) return checkpointProblem()
      return null
    }

    const checkpointIdentity = () => {
      const session = store.session
      const repositoryId = store.intendedRepositoryId
      if (session === undefined || !repositoryId) return undefined
      return { sessionId: session.sessionId, generation: session.generation, repositoryId }
    }

    const checkpointProblem = (): string | null => {
      if (WorkspaceCheckpoints.needsFormatUpgrade(storage)) return null
      return new WorkspaceCheckpoints(storage, bucket, checkpointIdentity()).validate()
    }

    return {
      stateProblem: Effect.sync(stateProblem),
      checkpointProblem: Effect.sync(checkpointProblem),
      begin: Effect.tryPromise({
        try: async () => {
          const recorded = store.compatibility
          const decision = decideCompatibility({
            record: recorded,
            nativeInitialized: store.nativeInitialized,
            applied: store.nativeMigrations,
          })
          if (decision.kind === "blocked")
            throw new ProtocolError("blocked", decision.reason, decision.reason)
          if (decision.initialize) {
            // Intent persists before native initialization. Each native step commits on
            // its own, so a crash leaves a partially migrated database behind: the intent
            // names the target so only the same release can resume it, and everything
            // else stays blocked for repair.
            const intent =
              decision.resume && recorded !== undefined && typeof recorded.inProgress === "object"
                ? recorded.inProgress!
                : { target: NATIVE_MIGRATION_TARGET, release: release(), startedAt: Date.now() }
            store.compatibility = {
              formatVersion: JANITOR_STATE_FORMAT,
              family: RELEASE_MANIFEST.family,
              protocol: PROTOCOL_VERSION,
              release: release(),
              nativeMigrations: recorded?.nativeMigrations ?? [],
              inProgress: intent,
            }
            await storage.sync()
            store.journal(decision.resume ? "migration-resumed" : "migration-started", {
              target: intent.target,
              upgradeFormat: decision.upgradeFormat,
              applied: store.nativeMigrations.length,
            })
          }

          return decision
        },
        catch: (cause) => cause,
      }).pipe(Effect.withSpan("SessionCompatibility.begin")),
      complete: Effect.fn("SessionCompatibility.complete")((decision) =>
        Effect.try({
          try: () => {
            const applied = store.nativeMigrations
            const unknown = applied.filter((id) => !SUPPORTED_NATIVE_MIGRATIONS.includes(id))
            if (unknown.length > 0)
              throw new Error(
                `Native initialization produced unknown migrations ${unknown.join(", ")}`,
              )
            if (applied.length !== SUPPORTED_NATIVE_MIGRATIONS.length || !store.nativeInitialized)
              throw new Error(
                `Native initialization recorded ${applied.length} of ${SUPPORTED_NATIVE_MIGRATIONS.length} migrations`,
              )
            // The Janitor-owned step of the upgrade runs after the native set is complete
            // and is idempotent, so a restart between it and the completion record repeats it.
            if (decision.upgradeFormat || WorkspaceCheckpoints.needsFormatUpgrade(storage)) {
              WorkspaceCheckpoints.upgradeFormat(storage, checkpointIdentity())
              store.journal("state-upgraded", { format: JANITOR_STATE_FORMAT })
            }
            const problem = checkpointProblem()
            if (problem !== null) throw new ProtocolError("blocked", problem, problem)
            if (decision.initialize)
              store.compatibility = {
                formatVersion: JANITOR_STATE_FORMAT,
                family: RELEASE_MANIFEST.family,
                protocol: PROTOCOL_VERSION,
                release: release(),
                nativeMigrations: SUPPORTED_NATIVE_MIGRATIONS,
                inProgress: null,
              }
          },
          catch: (cause) => cause,
        }),
      ),
    }
  }
  static layer(deps: Dependencies) {
    return Layer.sync(this, () => this.make(deps))
  }
}
