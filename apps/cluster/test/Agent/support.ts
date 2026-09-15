import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { WorkflowDispatcher, type WorkflowRegistration } from "../../src/WorkflowDispatcher.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { AgentEventProjection } from "../../src/Agent/EventProjection.ts"
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
  RunnerEvent,
  TurnActionRequest,
  TurnActionResult,
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
  /** Retry/Skip actions the runner received, and what it answered. */
  readonly actions: Array<{ readonly sessionId: string; readonly request: TurnActionRequest }> = []
  /** Which attempt each session is awaiting a decision on, if any. */
  readonly awaiting = new Map<string, { inputId: string; attempt: number }>()

  private failure(method: string, sessionId?: string) {
    const index = this.failures.findIndex(
      (failure) =>
        failure.method === method &&
        (failure.sessionId === undefined || failure.sessionId === sessionId),
    )
    if (index === -1) return undefined
    return this.failures.splice(index, 1)[0]!.error
  }

  push(sessionId: string, ...events: ReadonlyArray<Omit<RunnerEvent, "seq" | "created">>) {
    const list = this.events.get(sessionId) ?? []
    for (const event of events) {
      const seq = list.length + 1
      list.push({ seq, created: 1_000 + seq, ...event })
    }
    this.events.set(sessionId, list)
  }

  readonly client: RunnerClient["Service"] = {
    inferRepository: () =>
      Effect.succeed({
        kind: "clarification",
        question: "Which connected repository should I use?",
      }),
    createSession: (sessionId: AgentSessionId, request: CreateSessionRequest) =>
      Effect.suspend(() => {
        this.calls.push({ method: "createSession", sessionId, detail: request })
        const failure = this.failure("createSession")
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
          this.push(sessionId, { type: "turn.accepted", data: { inputId: request.inputId } })
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
          pendingInputs: 0,
          admittedInputs: this.inputs.get(sessionId)?.length ?? 0,
          awaiting: null,
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
    act: (sessionId, request) =>
      Effect.suspend(() => {
        this.calls.push({ method: "act", sessionId, detail: request })
        const failure = this.failure("act", sessionId)
        if (failure !== undefined) return Effect.fail(failure)
        this.actions.push({ sessionId, request })
        const awaiting = this.awaiting.get(sessionId)
        const answer = (
          outcome: TurnActionResult["outcome"],
          message: string,
        ): TurnActionResult => ({
          outcome,
          message,
          awaiting:
            awaiting === undefined
              ? null
              : { ...awaiting, kind: "interrupted", reason: "fake interruption", since: 1_000 },
        })
        if (awaiting === undefined)
          return Effect.succeed(answer("not_awaiting", "nothing awaiting"))
        if (awaiting.inputId !== request.inputId || awaiting.attempt !== request.attempt)
          return Effect.succeed(answer("stale", "stale button"))
        this.awaiting.delete(sessionId)
        return Effect.succeed({ outcome: "applied", message: request.action, awaiting: null })
      }),
    cleanup: (sessionId, generation) =>
      Effect.suspend(() => {
        this.calls.push({ method: "cleanup", sessionId, detail: { generation } })
        const failure = this.failure("cleanup")
        if (failure !== undefined) return Effect.fail(failure)
        this.sessions.delete(sessionId)
        this.inputs.delete(sessionId)
        this.awaiting.delete(sessionId)
        return Effect.succeed({ sessionId, cleaned: true })
      }),
  }
}

/** Everything Janitor needs for agent sessions, against Postgres and an in-memory engine. */
export const agentLayers = (
  runner: Layer.Layer<RunnerClient, never, never>,
  registrations: ReadonlyArray<WorkflowRegistration> = [],
) =>
  Layer.mergeAll(AgentHandoffLayer, AgentSessions.layer, AgentEventProjection.layer).pipe(
    Layer.provideMerge(WorkflowDispatcher.layer([AgentHandoffRegistration, ...registrations])),
    Layer.provideMerge(WorkflowOutbox.layer),
    Layer.provideMerge(runner),
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(MigratedPostgresLayer),
  )

export const fakeRunnerLayer = (runner: FakeRunner) => Layer.succeed(RunnerClient, runner.client)
