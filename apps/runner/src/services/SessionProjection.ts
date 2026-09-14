import { Context, Effect, Layer } from "effect"
import {
  ProtocolError,
  type SessionId,
  type Inspection,
  type EventsRead,
  type UsageTotals,
  type ExecutionState,
} from "../Protocol.ts"
import { type RunnerStorage, type NativeSessionRow } from "../Storage.ts"
import { claimHeld } from "./SessionSupervision.ts"

/** Reads native state without starting the model, constructing a host or arming an alarm. */
export class SessionProjection extends Context.Service<
  SessionProjection,
  {
    readonly inspect: (sessionId: SessionId) => Effect.Effect<Inspection, unknown>
    readonly events: (
      sessionId: SessionId,
      after: number,
      limit: number,
    ) => Effect.Effect<EventsRead, unknown>
  }
>()("janitor/runner/SessionProjection") {
  static make(
    store: RunnerStorage,
    storage: DurableObjectStorage,
    guard: () => string | null,
    release: () => string,
  ): SessionProjection["Service"] {
    const reader = new ProjectionReader(store, storage, guard, release)
    return {
      inspect: Effect.fn("SessionProjection.inspect")((id) =>
        Effect.tryPromise({ try: () => reader.inspect(id), catch: (cause) => cause }),
      ),
      events: Effect.fn("SessionProjection.events")((id, after, limit) =>
        Effect.tryPromise({ try: () => reader.events(id, after, limit), catch: (cause) => cause }),
      ),
    }
  }
  static layer(
    store: RunnerStorage,
    storage: DurableObjectStorage,
    guard: () => string | null,
    release: () => string,
  ) {
    return Layer.sync(this, () => this.make(store, storage, guard, release))
  }
}

class ProjectionReader {
  constructor(
    private readonly store: RunnerStorage,
    private readonly storage: DurableObjectStorage,
    private readonly guard: () => string | null,
    private readonly currentRelease: () => string,
  ) {}
  private get release() {
    return this.currentRelease()
  }
  private usage(row: NativeSessionRow | undefined, nativeSessionId: string): UsageTotals | null {
    if (row === undefined) return null
    return {
      input: row.tokens.input,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
      cacheRead: row.tokens.cacheRead,
      cacheWrite: row.tokens.cacheWrite,
      seq: this.store.eventWatermark(nativeSessionId) ?? 0,
    }
  }

  private executionState(row: NativeSessionRow | undefined): {
    execution: ExecutionState
    reason: string | null
  } {
    const guard = this.guard()
    if (guard !== null) return { execution: "blocked", reason: guard }
    if (this.store.session === undefined) return { execution: "idle", reason: "not created" }
    if (claimHeld(row)) return { execution: "working", reason: "execution claim held" }
    if (this.store.supervision.obligation)
      return { execution: "working", reason: "supervision armed" }
    if (row?.idleOutcome === "failed")
      return { execution: "failed", reason: this.lastFailure(row.id) }
    return { execution: "idle", reason: null }
  }

  private lastFailure(nativeSessionId: string): string | null {
    return this.store.lastFailureMessage(nativeSessionId) ?? "execution failed"
  }

  // Inspection and event reads never construct a host, arm an alarm or touch execution.
  async inspect(sessionId: SessionId): Promise<Inspection> {
    const session = this.store.session
    const row =
      session === undefined ? undefined : this.store.nativeSession(session.nativeSessionId)
    const pending =
      session === undefined
        ? { total: 0, sinceIdle: 0 }
        : this.store.pendingInbox(session.nativeSessionId, null)
    const supervision = this.store.supervision
    const state = this.executionState(row)
    return {
      sessionId,
      generation:
        session?.generation ??
        this.store.intendedGeneration ??
        this.store.disconnection?.generation ??
        0,
      nativeSessionId: session?.nativeSessionId ?? null,
      modelConfigurationId: session?.modelConfigurationId ?? null,
      execution: state.execution,
      reason: state.reason,
      wakeObligation: supervision.obligation,
      supervisionRevision: supervision.revision,
      alarmAt: await this.storage.getAlarm(),
      pendingInputs: pending.total,
      admittedInputs: this.store.admittedInputCount,
      claimHeld: claimHeld(row),
      lastOutcome: row?.idleOutcome ?? null,
      maintenanceEpoch: this.store.maintenance.epoch,
      usage: session === undefined ? null : this.usage(row, session.nativeSessionId),
      release: this.release,
    }
  }

  async events(sessionId: SessionId, after: number, limit: number): Promise<EventsRead> {
    const session = this.store.session
    if (session === undefined) {
      if (this.store.disconnection !== undefined)
        throw new ProtocolError("stale_generation", `Session ${sessionId} was disconnected`)
      throw new ProtocolError("missing_session", `Session ${sessionId} has not been created`)
    }
    const events = this.store.events(session.nativeSessionId, after, limit)
    const row = this.store.nativeSession(session.nativeSessionId)
    return {
      sessionId,
      after,
      events: events.map((event) => ({
        seq: event.seq,
        id: event.id,
        type: event.type,
        version: event.version,
        created: event.created,
        data: event.data,
      })),
      next: events.length === 0 ? after : events[events.length - 1]!.seq,
      synced: this.store.eventWatermark(session.nativeSessionId),
      usage: this.usage(row, session.nativeSessionId),
      ...this.executionState(row),
    }
  }
}
