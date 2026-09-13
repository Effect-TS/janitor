import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { AgentEventProjection } from "../../src/Agent/EventProjection.ts"
import { AgentMaintenance } from "../../src/Agent/Maintenance.ts"
import { AgentHandoffLayer, AgentHandoffRegistration } from "../../src/Agent/Handoff.ts"
import { RunnerClient, RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import type {
  AdmitInputRequest,
  AdmitResult,
  AgentSessionId,
  CreateSessionRequest,
  CreateSessionResult,
  EventsRead,
  ExecutionState,
  Inspection,
  MaintenanceCheck,
  MaintenanceResult,
  RunnerEvent,
  RunnerHealth,
  UsageTotals,
} from "../../src/Agent/RunnerProtocol.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

/** An in-memory runner: idempotent creation and admission, scripted events, injectable failures. */
export class FakeRunner {
  readonly sessions = new Map<string, { generation: number; nativeSessionId: string }>()
  readonly inputs = new Map<string, Array<AdmitInputRequest>>()
  readonly events = new Map<string, Array<RunnerEvent>>()
  readonly usage = new Map<string, UsageTotals>()
  readonly execution = new Map<string, ExecutionState>()
  readonly calls: Array<{
    readonly method: string
    readonly sessionId: string
    readonly detail?: unknown
  }> = []
  /** Failures consumed in order by the named method (and session, when given) before it runs normally. */
  readonly failures: Array<{
    readonly method: string
    readonly sessionId?: string
    readonly error: RunnerClientError
  }> = []
  /** Pages served by readEvents; when empty, events are served from `events`. */
  readonly pages: Array<EventsRead> = []
  /** Maintenance holds by session: what the runner persisted and how it answers. */
  readonly holds = new Map<
    string,
    {
      epoch: number
      quiescent: boolean
      uncertain: boolean
      releaseChecks: Array<MaintenanceCheck>
    }
  >()
  /** Sessions whose hold acknowledgement names another epoch (a stale runner). */
  readonly staleAcknowledgement = new Map<string, number>()
  /** What the deployed runner answers on its health route. */
  health: RunnerHealth = {
    protocol: 2,
    release: "fake",
    manifest: {
      family: "janitor-runner-1",
      readableFamilies: ["janitor-runner-1"],
      commandProtocol: { version: 2, accepted: [2] },
      events: { contract: 1 },
      bridge: { protocol: 1, sourceHash: "f".repeat(64), imageDigest: "sha256:fake" },
    },
    problems: [],
  }

  private heldError(sessionId: string) {
    const hold = this.holds.get(sessionId)
    if (hold === undefined) return undefined
    return new RunnerClientError({
      code: "blocked",
      message: "The session cannot run work",
      reason: `maintenance hold epoch ${hold.epoch}`,
      status: 423,
    })
  }

  private failure(method: string, sessionId?: string) {
    const index = this.failures.findIndex(
      (failure) =>
        failure.method === method &&
        (failure.sessionId === undefined || failure.sessionId === sessionId),
    )
    if (index === -1) return undefined
    return this.failures.splice(index, 1)[0]!.error
  }

  push(
    sessionId: string,
    ...events: ReadonlyArray<Omit<RunnerEvent, "seq" | "id" | "created" | "version">>
  ) {
    const list = this.events.get(sessionId) ?? []
    for (const event of events) {
      const seq = list.length + 1
      list.push({ seq, id: `evt_${seq}`, created: 1_000 + seq, version: 1, ...event })
    }
    this.events.set(sessionId, list)
  }

  readonly client: RunnerClient["Service"] = {
    createSession: (sessionId: AgentSessionId, request: CreateSessionRequest) =>
      Effect.suspend(() => {
        this.calls.push({ method: "createSession", sessionId, detail: request })
        const failure = this.failure("createSession") ?? this.heldError(sessionId)
        if (failure !== undefined) return Effect.fail(failure)
        const existing = this.sessions.get(sessionId)
        const created = existing === undefined
        const session = existing ?? {
          generation: request.generation,
          nativeSessionId: `ses_${sessionId}`,
        }
        this.sessions.set(sessionId, session)
        return Effect.succeed<CreateSessionResult>({
          sessionId,
          generation: session.generation,
          nativeSessionId: session.nativeSessionId,
          modelConfigurationId: request.modelConfigurationId ?? "default",
          created,
        })
      }),
    admitInput: (sessionId: AgentSessionId, request: AdmitInputRequest) =>
      Effect.suspend(() => {
        this.calls.push({ method: "admitInput", sessionId, detail: request })
        const held = this.heldError(sessionId)
        if (held !== undefined) return Effect.fail(held)
        const failure = this.failure("admitInput")
        const session = this.sessions.get(sessionId)
        if (session === undefined)
          return Effect.fail(
            new RunnerClientError({ code: "missing_session", message: "not created", status: 404 }),
          )
        const list = this.inputs.get(sessionId) ?? []
        const duplicate = list.some((input) => input.inputId === request.inputId)
        // A lost reply still admits durably: the failure is injected after the side effect.
        if (!duplicate) {
          list.push(request)
          this.inputs.set(sessionId, list)
          this.push(sessionId, {
            type: "session.inbox.enqueued",
            data: { inboxID: request.inputId },
          })
        }
        if (failure !== undefined) return Effect.fail(failure)
        return Effect.succeed<AdmitResult>({
          inputId: request.inputId,
          nativeSessionId: session.nativeSessionId,
          status: "admitted",
          admittedAt: 1_000,
          payloadHash: "hash",
          duplicate,
          payloadMatches: true,
        })
      }),
    inspect: (sessionId: AgentSessionId) =>
      Effect.suspend(() => {
        this.calls.push({ method: "inspect", sessionId })
        const failure = this.failure("inspect")
        if (failure !== undefined) return Effect.fail(failure)
        const session = this.sessions.get(sessionId)
        return Effect.succeed<Inspection>({
          sessionId,
          generation: session?.generation ?? 0,
          nativeSessionId: session?.nativeSessionId ?? null,
          modelConfigurationId: "default",
          execution: "idle",
          reason: null,
          wakeObligation: false,
          supervisionRevision: 0,
          alarmAt: null,
          pendingInputs: 0,
          admittedInputs: this.inputs.get(sessionId)?.length ?? 0,
          claimHeld: false,
          lastOutcome: null,
          maintenanceEpoch: null,
          usage: this.usage.get(sessionId) ?? null,
          release: "fake",
        })
      }),
    readEvents: (sessionId: AgentSessionId, after: number, limit = 200) =>
      Effect.suspend(() => {
        this.calls.push({ method: "readEvents", sessionId, detail: { after, limit } })
        const failure = this.failure("readEvents")
        if (failure !== undefined) return Effect.fail(failure)
        const scripted = this.pages.shift()
        if (scripted !== undefined) return Effect.succeed(scripted)
        const all = this.events.get(sessionId) ?? []
        const events = all.filter((event) => event.seq > after).slice(0, limit)
        const synced = all.length === 0 ? null : all[all.length - 1]!.seq
        return Effect.succeed<EventsRead>({
          sessionId,
          after,
          events,
          next: events.length === 0 ? after : events[events.length - 1]!.seq,
          synced,
          usage: this.usage.get(sessionId) ?? null,
          execution: this.execution.get(sessionId) ?? "idle",
          reason: null,
        })
      }),
    maintenance: (sessionId, request) =>
      Effect.suspend(() => {
        this.calls.push({ method: "maintenance", sessionId, detail: request })
        const failure = this.failure("maintenance", sessionId)
        if (failure !== undefined) return Effect.fail(failure)
        const answer = (
          held: boolean,
          epoch: number | null,
          checks: ReadonlyArray<MaintenanceCheck> = [],
        ): MaintenanceResult => ({
          held,
          epoch,
          quiescent: this.holds.get(sessionId)?.quiescent ?? true,
          uncertain: this.holds.get(sessionId)?.uncertain ?? false,
          checks,
        })
        const current = this.holds.get(sessionId)
        if (request.hold) {
          const stale = this.staleAcknowledgement.get(sessionId)
          if (stale !== undefined) return Effect.succeed(answer(true, stale))
          if (current !== undefined && current.epoch > request.epoch)
            return Effect.succeed(answer(true, current.epoch))
          this.holds.set(sessionId, {
            epoch: request.epoch,
            quiescent: current?.quiescent ?? true,
            uncertain: current?.uncertain ?? false,
            releaseChecks: current?.releaseChecks ?? [],
          })
          return Effect.succeed(answer(true, request.epoch))
        }
        if (current === undefined) return Effect.succeed(answer(false, null))
        if (current.epoch !== request.epoch)
          return Effect.fail(
            new RunnerClientError({
              code: "invalid_request",
              message: `Maintenance epoch ${request.epoch} does not match the held epoch ${current.epoch}`,
              status: 400,
            }),
          )
        if (current.releaseChecks.some((check) => !check.ok))
          return Effect.succeed(answer(true, current.epoch, current.releaseChecks))
        this.holds.delete(sessionId)
        return Effect.succeed(answer(false, request.epoch, current.releaseChecks))
      }),
    health: Effect.suspend(() => {
      this.calls.push({ method: "health", sessionId: "" })
      const failure = this.failure("health")
      if (failure !== undefined) return Effect.fail(failure)
      return Effect.succeed(this.health)
    }),
    cleanup: (sessionId, generation) =>
      Effect.suspend(() => {
        this.calls.push({ method: "cleanup", sessionId, detail: { generation } })
        const failure = this.failure("cleanup")
        if (failure !== undefined) return Effect.fail(failure)
        this.sessions.delete(sessionId)
        this.inputs.delete(sessionId)
        this.holds.delete(sessionId)
        return Effect.succeed({ sessionId, cleaned: true })
      }),
  }
}

/** Everything Janitor needs for agent sessions, against Postgres and an in-memory engine. */
export const agentLayers = (runner: Layer.Layer<RunnerClient, never, never>) =>
  Layer.mergeAll(
    AgentHandoffLayer,
    AgentSessions.layer,
    AgentEventProjection.layer,
    AgentMaintenance.layer,
  ).pipe(
    Layer.provideMerge(WorkflowDispatcher.layer([AgentHandoffRegistration])),
    Layer.provideMerge(WorkflowOutbox.layer),
    Layer.provideMerge(runner),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(MigratedPostgresLayer),
  )

export const fakeRunnerLayer = (runner: FakeRunner) => Layer.succeed(RunnerClient, runner.client)
