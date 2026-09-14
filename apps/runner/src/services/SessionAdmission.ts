import { Context, Effect, Layer } from "effect"
import { AbsolutePath, Location, Session } from "@opencode/sdk/effect"
import { WORKSPACE_PROVIDER, type Host } from "../Host.ts"
import { REPOSITORY_TOOLS, type RepositorySelection } from "../RepositoryWorkspace.ts"
import {
  findRecord,
  type ModelConfigurations,
  type ModelConfigurationError,
} from "../ModelConfiguration.ts"
import {
  ProtocolError,
  type SessionId,
  type CreateSession,
  type CreateSessionResult,
  type AdmitInput,
  type AdmitResult,
} from "../Protocol.ts"
import { payloadHash, type RunnerStorage, type SessionRecord } from "../Storage.ts"

interface Dependencies {
  store: RunnerStorage
  storage: DurableObjectStorage
  configurations: ModelConfigurations | ModelConfigurationError
  requireRunnable: () => void
  requireSession: (id: SessionId, generation: number) => SessionRecord
  ensureHost: () => Promise<Host>
  arm: () => Promise<void>
  beforeCreationRecord: () => Promise<void>
  afterAdmission: (inputId: string) => Promise<void>
}
/** Guidance attached to every session's native instructions. */
const CONVERSATION_GUIDANCE =
  "You collaborate with a team through a chat thread. Ask questions in ordinary replies and end your turn when you need a teammate's answer; the next message in the thread continues the conversation. Run commands in the foreground with a finite timeout."

/** Durable session identities and inbox receipts reconcile retries before native execution. */
export class SessionAdmission extends Context.Service<
  SessionAdmission,
  {
    readonly create: (
      id: SessionId,
      body: CreateSession,
    ) => Effect.Effect<CreateSessionResult, unknown>
    readonly admit: (id: SessionId, body: AdmitInput) => Effect.Effect<AdmitResult, unknown>
  }
>()("janitor/runner/SessionAdmission") {
  static make(deps: Dependencies): SessionAdmission["Service"] {
    let creating: Promise<CreateSessionResult> | undefined
    const create = async (
      sessionId: SessionId,
      body: CreateSession,
    ): Promise<CreateSessionResult> => {
      const disconnection = deps.store.disconnection
      if (disconnection !== undefined)
        throw new ProtocolError(
          "stale_generation",
          `Session ${sessionId} was disconnected at generation ${disconnection.generation}; reconnection uses a new session`,
        )
      const existing = deps.store.session
      if (existing !== undefined) {
        const selected = await deps.storage.get<RepositorySelection>("_janitor_repository")
        if (selected?.repositoryId !== body.repositoryId)
          throw new ProtocolError("invalid_request", "Session repository selection is immutable")
        if (existing.generation !== body.generation)
          throw new ProtocolError(
            "stale_generation",
            `Session ${sessionId} exists at generation ${existing.generation}; the request carried ${body.generation}`,
          )
        return createResult(existing, false)
      }
      if (
        deps.store.intendedRepositoryId !== undefined &&
        deps.store.intendedRepositoryId !== (body.repositoryId ?? null)
      )
        throw new ProtocolError("invalid_request", "Session repository selection is immutable")
      if (creating !== undefined) return creating
      deps.requireRunnable()
      const configurations = deps.configurations as ModelConfigurations
      const intendedGeneration = deps.store.intendedGeneration
      if (intendedGeneration !== undefined && intendedGeneration !== body.generation)
        throw new ProtocolError(
          "stale_generation",
          `Session ${sessionId} creation began at generation ${intendedGeneration}; the request carried ${body.generation}`,
        )
      const modelConfigurationId =
        deps.store.intendedModelConfigurationId ??
        body.modelConfigurationId ??
        configurations.default
      if (findRecord(configurations, modelConfigurationId) === undefined)
        throw new ProtocolError(
          "invalid_request",
          `Model configuration ${modelConfigurationId} is not available`,
        )
      // Deterministic identities persist before native creation, so a retry or a crash after
      // native creation reconciles the same conversation instead of creating another.
      deps.store.transaction(() => {
        if (deps.store.intendedRepositoryId === undefined)
          deps.store.intendedRepositoryId = body.repositoryId ?? null
        if (deps.store.intendedGeneration === undefined)
          deps.store.intendedGeneration = body.generation
        if (deps.store.intendedModelConfigurationId === undefined)
          deps.store.intendedModelConfigurationId = modelConfigurationId
        if (deps.store.intendedNativeSessionId === undefined)
          deps.store.intendedNativeSessionId = "ses_" + crypto.randomUUID().replaceAll("-", "")
      })
      const intended = deps.store.intendedNativeSessionId!
      creating = (async () => {
        const selected = await deps.storage.get<RepositorySelection>("_janitor_repository")
        if (selected && selected.repositoryId !== body.repositoryId)
          throw new ProtocolError("invalid_request", "Session repository selection changed")
        if (body.repositoryId && !selected)
          await deps.storage.put("_janitor_repository", {
            sessionId,
            generation: body.generation,
            repositoryId: body.repositoryId,
          })
        const host = await deps.ensureHost()
        const nativeId = Session.ID.make(intended)
        const created = await host.sdk((sdk) =>
          Effect.gen(function* () {
            const found = yield* sdk.sessions.get({ sessionID: nativeId }).pipe(
              Effect.map(() => true),
              Effect.catch(() => Effect.succeed(false)),
            )
            if (found) return false
            const workspaceID = yield* sdk.workspace.create({ provider: WORKSPACE_PROVIDER })
            yield* sdk.sessions.create({
              id: nativeId,
              title: body.title,
              permissions: [
                { action: "*", resource: "*", effect: "deny" },
                ...REPOSITORY_TOOLS.map((action) => ({
                  action,
                  resource: "*",
                  effect: "allow" as const,
                })),
                {
                  action: "external_directory",
                  resource: "/workspace/.janitor-captures/*",
                  effect: "allow",
                },
              ],
              location: Location.Ref.make({
                directory: AbsolutePath.make(
                  body.repositoryId ? "/workspace/repository" : "/workspace",
                ),
                workspaceID,
              }),
            })
            yield* sdk.sessions.instructions.entry.put({
              sessionID: nativeId,
              key: "janitor-conversation",
              value: CONVERSATION_GUIDANCE,
            })
            return true
          }),
        )
        await deps.beforeCreationRecord()
        const record: SessionRecord = {
          sessionId,
          generation: body.generation,
          nativeSessionId: intended,
          modelConfigurationId,
          title: body.title,
          createdAt: Date.now(),
        }
        deps.store.session = record
        deps.store.journal("created", { nativeSessionId: intended, created })
        return createResult(record, created)
      })().finally(() => {
        creating = undefined
      })
      return creating
    }

    const createResult = (record: SessionRecord, created: boolean): CreateSessionResult => {
      return {
        sessionId: record.sessionId,
        generation: record.generation,
        nativeSessionId: record.nativeSessionId,
        modelConfigurationId: record.modelConfigurationId,
        created,
      }
    }

    const admit = async (sessionId: SessionId, body: AdmitInput): Promise<AdmitResult> => {
      const session = deps.requireSession(sessionId, body.generation)
      deps.requireRunnable()
      const hash = await payloadHash(body.text, body.attribution)
      const existing = deps.store.input(body.inputId)
      if (existing !== undefined && existing.admittedAt !== null)
        return {
          inputId: body.inputId,
          nativeSessionId: session.nativeSessionId,
          status: "admitted",
          admittedAt: existing.admittedAt,
          payloadHash: existing.payloadHash,
          duplicate: true,
          payloadMatches: existing.payloadHash === hash,
        }
      // Concurrent retries of one id both reach here; the insert ignores the loser.
      if (existing === undefined)
        deps.store.insertInput({
          inputId: body.inputId,
          payloadHash: hash,
          text: body.text,
          attribution: body.attribution,
          receivedAt: Date.now(),
          admittedAt: null,
        })
      const record = existing ?? deps.store.input(body.inputId)!
      // The wake obligation and alarm exist before native admission can start work.
      await deps.arm()
      const host = await deps.ensureHost()
      const nativeId = Session.ID.make(session.nativeSessionId)
      await host.sdk((sdk) =>
        sdk.sessions.prompt({
          sessionID: nativeId,
          id: body.inputId as Parameters<typeof sdk.sessions.prompt>[0]["id"],
          text: record.text,
          metadata: { janitor: record.attribution },
          delivery: "queue",
          resume: true,
        }),
      )
      const admittedAt = Date.now()
      deps.store.markAdmitted(body.inputId, admittedAt)
      // A row received earlier but never natively admitted (a crash or failure before
      // admission) is a first admission now; only a held receipt makes this a duplicate.
      const duplicate = existing !== undefined && existing.admittedAt !== null
      deps.store.journal("admitted", { inputId: body.inputId, duplicate })
      await deps.afterAdmission(body.inputId)
      const stored = deps.store.input(body.inputId)!
      return {
        inputId: body.inputId,
        nativeSessionId: session.nativeSessionId,
        status: "admitted",
        admittedAt: stored.admittedAt ?? admittedAt,
        payloadHash: stored.payloadHash,
        duplicate,
        payloadMatches: stored.payloadHash === hash,
      }
    }

    return {
      create: Effect.fn("SessionAdmission.create")((id, body) =>
        Effect.tryPromise({ try: () => create(id, body), catch: (cause) => cause }),
      ),
      admit: Effect.fn("SessionAdmission.admit")((id, body) =>
        Effect.tryPromise({ try: () => admit(id, body), catch: (cause) => cause }),
      ),
    }
  }
  static layer(deps: Dependencies) {
    return Layer.sync(this, () => this.make(deps))
  }
}
