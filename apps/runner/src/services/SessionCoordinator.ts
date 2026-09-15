// The session coordinator: admission, attempt identity, the turn and recovery
// contract, interruption gating and teammate Retry/Skip. It owns the
// `_janitor_*` records and drives the sandbox, model host and recovery store
// through their ports, so its decisions are testable without workerd.
//
// One input runs at a time in acceptance order. A turn is: prepare or restore
// the workspace, run the model, stop background processes, save a recovery
// point, then commit the completed-turn record and its reply event together.
// Anything short of that leaves the session awaiting a teammate's Retry or
// Skip; native recovery never restarts the model on its own.
import { Context, Duration, Effect, Fiber, Layer } from "effect"
import {
  ProtocolError,
  type AdmitInput,
  type AdmitResult,
  type Awaiting,
  type CreateSession,
  type CreateSessionResult,
  type EventsRead,
  type ExecutionState,
  type Inspection,
  type SessionId,
  type TurnAction,
  type TurnActionResult,
  type TurnStage,
  type UsageTotals,
} from "../Protocol.ts"
import { describe } from "../Router.ts"
import {
  JANITOR_STATE_FORMAT,
  payloadHash,
  type AttemptRecord,
  type InputRecord,
  type RunnerStorage,
  type SessionRecord,
} from "../Storage.ts"
import { RecoveryStore } from "./RecoveryStore.ts"
import { RepositoryCheckout } from "./RepositoryCheckout.ts"
import { SandboxWorkspace, WorkspaceError } from "./SandboxWorkspace.ts"
import { HostError, TurnHost, TurnScheduler, type TurnOutcome } from "./TurnHost.ts"
import type { WorkspaceReadiness } from "./WorkspaceReadiness.ts"

export interface CoordinatorOptions {
  /** Overall allowance for one attempt, including preparation; exceeding it interrupts the turn. */
  readonly turnTimeoutMs: number
  /** How many times saving is retried without rerunning the model. */
  readonly saveRetries: number
  readonly saveRetryDelayMs: number
}

export const DEFAULT_COORDINATOR_OPTIONS: CoordinatorOptions = {
  turnTimeoutMs: 30 * 60_000,
  saveRetries: 3,
  saveRetryDelayMs: 5_000,
}

export interface CoordinatorDependencies {
  readonly store: RunnerStorage
  /** Identity of this object incarnation; attempts recorded by another one were interrupted. */
  readonly incarnation: string
  readonly options: () => CoordinatorOptions
  readonly clock: () => number
  readonly release: () => string
  /** The concrete reason work must not run, or null. */
  readonly guard: () => string | null
  /** Session creation may need deployment-level validation (model configuration). */
  readonly resolveModelConfiguration: (requested: string | undefined) => string
  /** Tells the API that new events are readable; fire-and-forget, the API's polling is the guarantee. */
  readonly notify: () => void
  /** The gate sandbox tools wait on until the turn's checkout is prepared. */
  readonly readiness: WorkspaceReadiness
}

const RESTORED_NOTE =
  "The workspace was restored to the last saved state. File changes made during the interrupted attempt are not present unless they were published to GitHub."

export class SessionCoordinator extends Context.Service<
  SessionCoordinator,
  {
    readonly create: (
      id: SessionId,
      body: CreateSession,
    ) => Effect.Effect<CreateSessionResult, ProtocolError>
    readonly admit: (id: SessionId, body: AdmitInput) => Effect.Effect<AdmitResult, ProtocolError>
    readonly act: (
      id: SessionId,
      body: TurnAction,
    ) => Effect.Effect<TurnActionResult, ProtocolError>
    /** Runs the next turn if one is due. Safe to call repeatedly; only one runs at a time. */
    readonly drive: Effect.Effect<void>
    /** Reconciles records left by a previous incarnation; called once at construction. */
    readonly recover: Effect.Effect<void>
    /** Interrupts the active attempt because its sandbox stopped. */
    readonly workspaceLost: Effect.Effect<void>
    readonly inspect: (id: SessionId) => Effect.Effect<Inspection, ProtocolError>
    readonly events: (
      id: SessionId,
      after: number,
      limit: number,
    ) => Effect.Effect<EventsRead, ProtocolError>
    readonly active: () => boolean
  }
>()("janitor/runner/SessionCoordinator") {
  static make(
    deps: CoordinatorDependencies,
    host: TurnHost["Service"],
    checkout: RepositoryCheckout["Service"],
    recovery: RecoveryStore["Service"],
    workspace: SandboxWorkspace["Service"],
    scheduler: TurnScheduler["Service"],
  ): SessionCoordinator["Service"] {
    const { store } = deps
    const now = () => deps.clock()
    const emit = (type: string, data: unknown) => {
      const seq = store.emit(type, data, now())
      // Acceptance is already known to the caller; everything later is news.
      if (type !== "turn.accepted") deps.notify()
      return seq
    }
    let active:
      | { readonly inputId: string; readonly attempt: number; interrupt: (reason: string) => void }
      | undefined

    const requireSession = (sessionId: SessionId, generation: number): SessionRecord => {
      const disconnection = store.disconnection
      if (disconnection !== undefined)
        throw new ProtocolError(
          "stale_generation",
          `Session ${sessionId} was disconnected at generation ${disconnection.generation}`,
        )
      const session = store.session
      if (session === undefined)
        throw new ProtocolError("missing_session", `Session ${sessionId} has not been created`)
      if (session.generation !== generation)
        throw new ProtocolError(
          "stale_generation",
          `Session ${sessionId} is at generation ${session.generation}; the request carried ${generation}`,
        )
      return session
    }
    const requireRunnable = () => {
      const reason = deps.guard()
      if (reason !== null) throw new ProtocolError("blocked", "The session cannot run work", reason)
    }
    const protocol = <A>(body: () => A) =>
      Effect.try({
        try: body,
        catch: (cause) =>
          cause instanceof ProtocolError ? cause : new ProtocolError("transport", describe(cause)),
      })

    // -------------------------------------------------------------------------
    // Session identity and admission.

    const create = Effect.fn("SessionCoordinator.create")(
      (sessionId: SessionId, body: CreateSession) =>
        protocol((): CreateSessionResult => {
          const disconnection = store.disconnection
          if (disconnection !== undefined)
            throw new ProtocolError(
              "stale_generation",
              `Session ${sessionId} was disconnected at generation ${disconnection.generation}; reconnection uses a new session`,
            )
          const existing = store.session
          if (existing !== undefined) {
            if (existing.repositoryId !== (body.repositoryId ?? null))
              throw new ProtocolError(
                "invalid_request",
                "Session repository selection is immutable",
              )
            if (existing.generation !== body.generation)
              throw new ProtocolError(
                "stale_generation",
                `Session ${sessionId} exists at generation ${existing.generation}; the request carried ${body.generation}`,
              )
            return result(existing, false)
          }
          requireRunnable()
          const intendedGeneration = store.intendedGeneration
          if (intendedGeneration !== undefined && intendedGeneration !== body.generation)
            throw new ProtocolError(
              "stale_generation",
              `Session ${sessionId} creation began at generation ${intendedGeneration}; the request carried ${body.generation}`,
            )
          if (
            store.intendedRepositoryId !== undefined &&
            store.intendedRepositoryId !== (body.repositoryId ?? null)
          )
            throw new ProtocolError("invalid_request", "Session repository selection is immutable")
          const modelConfigurationId =
            store.intendedModelConfigurationId ??
            deps.resolveModelConfiguration(body.modelConfigurationId)
          // Deterministic identities persist before anything native exists, so a retry
          // or a crash reconciles the same conversation instead of creating another.
          const record = store.transaction((): SessionRecord => {
            if (store.format === undefined) store.format = JANITOR_STATE_FORMAT
            if (store.intendedRepositoryId === undefined)
              store.intendedRepositoryId = body.repositoryId ?? null
            if (store.intendedGeneration === undefined) store.intendedGeneration = body.generation
            if (store.intendedModelConfigurationId === undefined)
              store.intendedModelConfigurationId = modelConfigurationId
            if (store.intendedNativeSessionId === undefined)
              store.intendedNativeSessionId = "ses_" + crypto.randomUUID().replaceAll("-", "")
            const created: SessionRecord = {
              sessionId,
              generation: body.generation,
              nativeSessionId: store.intendedNativeSessionId!,
              modelConfigurationId,
              repositoryId: body.repositoryId ?? null,
              title: body.title,
              createdAt: now(),
            }
            store.session = created
            store.journal("created", { nativeSessionId: created.nativeSessionId }, now())
            return created
          })
          return result(record, true)
        }),
    )
    const result = (record: SessionRecord, created: boolean): CreateSessionResult => ({
      sessionId: record.sessionId,
      generation: record.generation,
      nativeSessionId: record.nativeSessionId,
      modelConfigurationId: record.modelConfigurationId,
      created,
    })

    const admit = Effect.fn("SessionCoordinator.admit")(function* (
      sessionId: SessionId,
      body: AdmitInput,
    ) {
      const session = yield* protocol(() => requireSession(sessionId, body.generation))
      yield* protocol(requireRunnable)
      const hash = yield* Effect.promise(() => payloadHash(body.text, body.attribution))
      const receipt = (record: InputRecord, duplicate: boolean): AdmitResult => ({
        inputId: body.inputId,
        nativeSessionId: session.nativeSessionId,
        status: "admitted",
        admittedAt: record.receivedAt,
        payloadHash: record.payloadHash,
        duplicate,
        payloadMatches: record.payloadHash === hash,
      })
      const existing = store.input(body.inputId)
      if (existing !== undefined) return receipt(existing, true)
      // Acceptance is durable before the acknowledgement leaves; the turn starts later.
      const record = store.transaction(() => {
        store.insertInput({
          inputId: body.inputId,
          payloadHash: hash,
          text: body.text,
          attribution: body.attribution,
          receivedAt: now(),
        })
        const stored = store.input(body.inputId)!
        emit("turn.accepted", { inputId: body.inputId })
        return stored
      })
      yield* scheduler.wake(0)
      return receipt(record, false)
    })

    // -------------------------------------------------------------------------
    // Teammate actions on an awaiting attempt.

    const act = Effect.fn("SessionCoordinator.act")(function* (
      sessionId: SessionId,
      body: TurnAction,
    ) {
      yield* protocol(() => requireSession(sessionId, body.generation))
      const answer = (outcome: TurnActionResult["outcome"], message: string): TurnActionResult => ({
        outcome,
        message,
        awaiting: store.awaiting ?? null,
      })
      const recorded = store.action(body.actionId)
      if (recorded !== undefined)
        return answer("duplicate", `This ${recorded.action} was already handled`)
      const awaiting = store.awaiting
      const record = (outcome: string) =>
        store.recordAction({
          actionId: body.actionId,
          inputId: body.inputId,
          attempt: body.attempt,
          action: body.action,
          actor: body.actor,
          outcome,
          at: now(),
        })
      if (awaiting === undefined) {
        record("not_awaiting")
        return answer("not_awaiting", "The session is not waiting for a decision")
      }
      if (awaiting.inputId !== body.inputId || awaiting.attempt !== body.attempt) {
        record("stale")
        return answer(
          "stale",
          "This button belongs to an earlier interruption; newer work is unaffected",
        )
      }
      store.transaction(() => {
        record("applied")
        store.awaiting = undefined
        if (body.action === "retry") {
          store.setInputStatus(body.inputId, "queued")
          emit("turn.retried", {
            inputId: body.inputId,
            attempt: awaiting.attempt + 1,
            actor: body.actor,
          })
        } else {
          store.setInputStatus(body.inputId, "skipped")
          store.finishAttempt(
            body.inputId,
            awaiting.attempt,
            "skipped",
            now(),
            "skipped by a teammate",
          )
          const pending = store.skipped
          store.skipped = [...pending, body.inputId]
          emit("turn.skipped", {
            inputId: body.inputId,
            attempt: awaiting.attempt,
            actor: body.actor,
          })
        }
      })
      yield* scheduler.wake(0)
      return answer("applied", body.action === "retry" ? "Retrying" : "Skipped")
    })

    // -------------------------------------------------------------------------
    // Turns.

    const stage = (input: InputRecord, attempt: number, value: TurnStage) => {
      store.transaction(() => {
        store.setAttemptStage(input.inputId, attempt, value)
        emit("turn.stage", { inputId: input.inputId, attempt, stage: value })
      })
      workspace.renewActivity()
    }

    const interrupt = (input: InputRecord, attempt: number, reason: string) => {
      store.transaction(() => {
        store.finishAttempt(input.inputId, attempt, "interrupted", now(), reason)
        const awaiting: Awaiting = {
          inputId: input.inputId,
          attempt,
          kind: "interrupted",
          reason,
          since: now(),
        }
        store.awaiting = awaiting
        emit("turn.interrupted", { inputId: input.inputId, attempt, reason })
      })
      store.journal("turn-interrupted", { inputId: input.inputId, attempt, reason }, now())
    }

    const saveFailed = (input: InputRecord, attempt: number, text: string, reason: string) => {
      store.transaction(() => {
        store.finishAttempt(input.inputId, attempt, "save_failed", now(), reason, { text })
        const awaiting: Awaiting = {
          inputId: input.inputId,
          attempt,
          kind: "save_failed",
          reason,
          since: now(),
        }
        store.awaiting = awaiting
        emit("turn.save_failed", { inputId: input.inputId, attempt, reason })
      })
    }

    /** Saves the quiescent workspace, retrying within the allowance; false leaves the session awaiting. */
    const save = Effect.fn("SessionCoordinator.save")(function* (
      input: InputRecord,
      attempt: number,
      text: string,
    ) {
      const options = deps.options()
      let lastError = "saving did not start"
      for (let round = 0; round <= options.saveRetries; round++) {
        if (round > 0) yield* Effect.sleep(Duration.millis(options.saveRetryDelayMs))
        const generation = workspace.generation()
        const captured = yield* recovery.capture.pipe(Effect.result)
        if (captured._tag === "Failure") {
          lastError = captured.failure.message
          store.journal(
            "save-failed",
            { inputId: input.inputId, attempt, round, error: lastError },
            now(),
          )
          if (captured.failure.reason === "lost" || workspace.generation() !== generation) break
          continue
        }
        // The pointer, the completed-turn record and the reply commit together.
        store.transaction(() => {
          recovery.commit(captured.success, input.inputId, attempt, now())
          checkout.markSaved(captured.success.id)
          store.finishAttempt(input.inputId, attempt, "completed", now(), null, { text })
          store.setInputStatus(input.inputId, "completed")
          emit("turn.completed", { inputId: input.inputId, attempt, text })
        })
        yield* recovery.prune
        return true
      }
      saveFailed(input, attempt, text, lastError)
      return false
    })

    const notesFor = (attempts: ReadonlyArray<AttemptRecord>) => {
      const notes: Array<string> = []
      const skipped = store.skipped
      if (skipped.length > 0)
        notes.push(
          `A teammate skipped ${skipped.length === 1 ? "the previous request" : `${skipped.length} earlier requests`} after an interruption. Do not continue that work; ${RESTORED_NOTE}`,
        )
      const previous = attempts.filter(
        (record) => record.state === "interrupted" || record.state === "save_failed",
      )
      if (previous.length > 0) {
        const last = previous[previous.length - 1]!
        notes.push(
          `Attempt ${last.attempt} of this request was interrupted: ${last.reason ?? "unknown reason"}. ${RESTORED_NOTE} Continue the request from the current files.`,
        )
      }
      return notes
    }

    const runTurn = Effect.fn("SessionCoordinator.runTurn")(function* (input: InputRecord) {
      const attempts = store.attempts(input.inputId)
      const last = attempts[attempts.length - 1]
      const attempt = store.transaction(() => {
        const number = store.beginAttempt(input.inputId, deps.incarnation, now())
        store.setInputStatus(input.inputId, "active")
        emit("turn.started", { inputId: input.inputId, attempt: number })
        return number
      })
      // Finished model work whose save failed is saved again without rerunning the
      // model when the container still holds it.
      if (last?.state === "save_failed" && last.result !== null) {
        const intact = yield* checkout.intact.pipe(Effect.orElseSucceed(() => false))
        if (intact) {
          stage(input, attempt, "saving")
          yield* workspace.stopProcesses.pipe(Effect.ignore)
          yield* save(input, attempt, last.result.text)
          return
        }
      }
      const readiness = deps.readiness
      const body = Effect.gen(function* () {
        stage(input, attempt, "preparing")
        readiness.reset()
        const prepare = checkout.prepare.pipe(
          Effect.tap((prepared) =>
            Effect.sync(() => {
              // From here the container diverges from its recovery point until the next save commits.
              checkout.markDirty()
              stage(input, attempt, "working")
              readiness.open()
              return prepared
            }),
          ),
          Effect.tapError((error) => Effect.sync(() => readiness.fail(error.message))),
        )
        const notes = notesFor(attempts)
        const cancel = store.skipped
        const run = (notes: ReadonlyArray<string>) =>
          host.run({
            inputId: input.inputId,
            attempt,
            text: input.text,
            attribution: input.attribution,
            notes,
            cancel,
            message: (ordinal, text) =>
              emit("turn.message", { inputId: input.inputId, attempt, ordinal, text }),
          })
        let outcome: TurnOutcome
        if (attempts.length === 0) {
          // A first attempt starts the model at once; its tools wait for the checkout.
          const [, result] = yield* Effect.all([prepare, run(notes)], {
            concurrency: "unbounded",
          })
          outcome = result
        } else {
          // A retry must know whether the workspace was restored before the model speaks.
          const prepared = yield* prepare
          if (prepared.source === "restored" && notes.length === 0) notes.push(RESTORED_NOTE)
          outcome = yield* run(notes)
        }
        if (cancel.length > 0) store.skipped = []
        return outcome
      })
      const outcome: TurnOutcome = yield* body.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(deps.options().turnTimeoutMs),
          orElse: () =>
            Effect.succeed<TurnOutcome>({
              type: "interrupted",
              reason: `The turn exceeded its ${Math.round(deps.options().turnTimeoutMs / 60_000)} minute allowance`,
            }),
        }),
        Effect.catchIf(
          (error): error is WorkspaceError | HostError | ProtocolError =>
            error instanceof WorkspaceError ||
            error instanceof HostError ||
            error instanceof ProtocolError,
          (error) =>
            Effect.succeed<TurnOutcome>({
              type: "interrupted",
              reason:
                error instanceof ProtocolError ? (error.reason ?? error.message) : error.message,
            }),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed<TurnOutcome>({ type: "interrupted", reason: describe(cause) }),
        ),
      )
      // A tool call that outlives the turn must not wait forever on a gate nobody opens.
      readiness.fail("The turn ended before its workspace was ready")
      yield* workspace.stopProcesses.pipe(Effect.ignore)
      if (outcome.type !== "completed") {
        interrupt(input, attempt, outcome.reason)
        return
      }
      stage(input, attempt, "saving")
      const saved = yield* save(input, attempt, outcome.text)
      if (saved && store.nextQueued() !== undefined) yield* scheduler.wake(0)
    })

    const drive = Effect.gen(function* () {
      if (active !== undefined) return
      if (store.disconnection !== undefined || store.awaiting !== undefined) return
      const guard = deps.guard()
      if (guard !== null) {
        store.journal("drive-blocked", { reason: guard }, now())
        return
      }
      const running = store.runningAttempt()
      if (running !== undefined) {
        interrupt(
          store.input(running.inputId)!,
          running.attempt,
          "The runner restarted while working on this request",
        )
        return
      }
      const input = store.nextQueued()
      if (input === undefined) return
      const handle = { inputId: input.inputId, attempt: 0, interrupt: (_reason: string) => {} }
      active = handle
      let cancelled: string | undefined
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runTurn(input))
        handle.interrupt = (reason) => {
          cancelled = reason
          store.journal("turn-cancelled", { inputId: input.inputId, reason }, now())
          Effect.runFork(Fiber.interrupt(fiber))
        }
        // Awaiting the exit, rather than joining, keeps an external cancellation of the
        // turn from cancelling this drive before it records the outcome.
        yield* Fiber.awaitAll([fiber])
        // An external cancellation ends the fiber before it records an outcome.
        const running = store.runningAttempt()
        if (running !== undefined && running.inputId === input.inputId)
          interrupt(input, running.attempt, cancelled ?? "The turn was cancelled")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active = undefined
          }),
        ),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => store.journal("drive-failed", { error: describe(cause) }, now())),
      ),
      Effect.withSpan("SessionCoordinator.drive"),
    )

    const recover = Effect.gen(function* () {
      const running = store.runningAttempt()
      if (running !== undefined && running.incarnation !== deps.incarnation) {
        const input = store.input(running.inputId)
        if (input !== undefined)
          interrupt(input, running.attempt, "The runner restarted while working on this request")
      }
      if (
        store.disconnection === undefined &&
        store.awaiting === undefined &&
        store.nextQueued() !== undefined
      )
        yield* scheduler.wake(0)
    })

    const workspaceLost = Effect.sync(() => {
      const current = active
      if (current === undefined) return
      current.interrupt("The sandbox stopped while the request was in progress")
    })

    // -------------------------------------------------------------------------
    // Projection.

    const state = (): { execution: ExecutionState; reason: string | null } => {
      const guard = deps.guard()
      if (guard !== null) return { execution: "blocked", reason: guard }
      if (store.session === undefined) return { execution: "idle", reason: "not created" }
      const awaiting = store.awaiting
      if (awaiting !== undefined)
        return {
          execution: "failed",
          reason:
            awaiting.kind === "interrupted"
              ? `Interrupted: ${awaiting.reason}. Waiting for Retry or Skip.`
              : `Work finished but could not be saved: ${awaiting.reason}. Waiting for Retry or Skip.`,
        }
      const running = store.runningAttempt()
      if (running !== undefined) return { execution: "working", reason: running.stage ?? "working" }
      if (store.nextQueued() !== undefined) return { execution: "working", reason: "input pending" }
      return { execution: "idle", reason: null }
    }
    const usage = (session: SessionRecord | undefined): UsageTotals | null => {
      if (session === undefined) return null
      const totals = store.nativeUsage(session.nativeSessionId)
      return totals === null ? null : { ...totals, seq: store.eventWatermark ?? 0 }
    }

    const inspect = Effect.fn("SessionCoordinator.inspect")((sessionId: SessionId) =>
      Effect.sync((): Inspection => {
        const session = store.session
        const current = state()
        return {
          sessionId,
          generation:
            session?.generation ?? store.intendedGeneration ?? store.disconnection?.generation ?? 0,
          nativeSessionId: session?.nativeSessionId ?? null,
          modelConfigurationId: session?.modelConfigurationId ?? null,
          execution: current.execution,
          reason: current.reason,
          pendingInputs: store.pendingInputCount,
          admittedInputs: store.admittedInputCount,
          awaiting: store.awaiting ?? null,
          usage: usage(session),
          release: deps.release(),
        }
      }),
    )

    const events = Effect.fn("SessionCoordinator.events")(
      (sessionId: SessionId, after: number, limit: number) =>
        protocol((): EventsRead => {
          const session = store.session
          if (session === undefined) {
            if (store.disconnection !== undefined)
              throw new ProtocolError("stale_generation", `Session ${sessionId} was disconnected`)
            throw new ProtocolError("missing_session", `Session ${sessionId} has not been created`)
          }
          const page = store.events(after, limit)
          return {
            sessionId,
            after,
            events: page.map((event) => ({ ...event })),
            next: page.length === 0 ? after : page[page.length - 1]!.seq,
            synced: store.eventWatermark,
            usage: usage(session),
            ...state(),
          }
        }),
    )

    return {
      create,
      admit,
      act,
      drive,
      recover,
      workspaceLost,
      inspect,
      events,
      active: () => active !== undefined,
    }
  }
  static layer(deps: CoordinatorDependencies) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const host = yield* TurnHost
        const checkout = yield* RepositoryCheckout
        const recovery = yield* RecoveryStore
        const workspace = yield* SandboxWorkspace
        const scheduler = yield* TurnScheduler
        return SessionCoordinator.make(deps, host, checkout, recovery, workspace, scheduler)
      }),
    )
  }
}
