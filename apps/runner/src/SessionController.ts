import { timed } from "./services/Telemetry.ts"
import { SessionAdmission } from "./services/SessionAdmission.ts"
import { SessionCompatibility } from "./services/SessionCompatibility.ts"
import { SessionCommands } from "./services/SessionCommands.ts"
import { SessionProjection } from "./services/SessionProjection.ts"
import { SessionMaintenance } from "./services/SessionMaintenance.ts"
import { NativeSession } from "./services/NativeSession.ts"
import { SessionSupervision } from "./services/SessionSupervision.ts"
// One Durable Object per Janitor agent session.
//
// The object owns the native OpenCode conversation, inbox and execution events
// through the pinned Workerd SDK, plus the `_janitor_*` coordination records:
// immutable input receipts, the supervision revision and wake obligation, the
// compatibility record and maintenance/blocker guards. Its alarm is a persisted
// check-in, never a prompt: it wakes admitted work, lets native recovery own
// interrupted turns and clears itself once the session is idle.
import { Duration, Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { createHost, type Host } from "./Host.ts"
import {
  DEFAULT_MODEL_INACTIVITY,
  ModelConfigurationError,
  withCredentialRedaction,
  findRecord,
  parseModelConfigurations,
  withInactivityDeadline,
  type ModelConfigurations,
} from "./ModelConfiguration.ts"
import {
  ProtocolError,
  type AdmitInput,
  type Cleanup,
  type CleanupResult,
  type CreateSession,
  type EventsRead,
  type Inspection,
  type Maintenance,
  type MaintenanceCheck,
  type MaintenanceResult,
  type SessionId,
} from "./Protocol.ts"
import type { Command } from "./Router.ts"
import { RunnerStorage, type SessionRecord } from "./Storage.ts"
import {
  RepositoryWorkspace,
  checkBridge,
  type RepositorySelection,
  type WorkspaceEnvironment,
} from "./RepositoryWorkspace.ts"
import { WorkspaceCheckpoints } from "./WorkspaceCheckpoints.ts"

export interface RunnerEnv extends WorkspaceEnvironment {
  readonly JANITOR_AGENT_RUNNER_TOKEN?: string
  readonly JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS?: string
  readonly JANITOR_AGENT_RUNNER_RELEASE?: string
  readonly [binding: string]: unknown
}

export interface RunnerOptions {
  /** Supervision check interval while runnable or recoverable work exists. */
  readonly intervalMs: number
  /** Model-response inactivity deadline applied at the HTTP boundary. */
  readonly modelInactivityMs: number
}

export const DEFAULT_OPTIONS: RunnerOptions = {
  intervalMs: 30_000,
  modelInactivityMs: Duration.toMillis(DEFAULT_MODEL_INACTIVITY),
}

export class SessionController {
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    | SessionCommands
    | SessionAdmission
    | SessionCompatibility
    | NativeSession
    | SessionSupervision
    | SessionProjection
    | SessionMaintenance,
    never
  >
  protected readonly store: RunnerStorage
  readonly incarnation = crypto.randomUUID()
  readonly commands: SessionCommands["Service"]
  private readonly compatibility: SessionCompatibility["Service"]
  private readonly native: NativeSession["Service"]
  private readonly supervision: SessionSupervision["Service"]
  private readonly projection: SessionProjection["Service"]
  private readonly admission: SessionAdmission["Service"]
  private readonly configurations: ModelConfigurations | ModelConfigurationError
  private repository: RepositoryWorkspace | undefined
  /** The in-flight maintenance drain; a hold answers from it instead of waiting on it. */
  private readonly maintenanceService: SessionMaintenance["Service"]

  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: RunnerEnv,
  ) {
    this.store = new RunnerStorage(ctx.storage)
    this.projection = SessionProjection.make(
      this.store,
      ctx.storage,
      () => this.guardReason(),
      () => this.release,
    )
    let configurations: ModelConfigurations | ModelConfigurationError
    try {
      configurations = parseModelConfigurations(env.JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS)
    } catch (cause) {
      configurations =
        cause instanceof ModelConfigurationError
          ? cause
          : new ModelConfigurationError(String(cause))
    }
    this.configurations = configurations
    this.compatibility = SessionCompatibility.make({
      store: this.store,
      storage: ctx.storage,
      bucket: env.WORKSPACE_CHECKPOINTS,
      configurations,
      release: () => this.release,
    })
    this.native = NativeSession.make(
      () => this.constructHost(),
      () => this.store.journal("host-disposed", { incarnation: this.incarnation }),
    )
    this.supervision = SessionSupervision.make({
      storage: ctx.storage,
      store: this.store,
      incarnation: this.incarnation,
      interval: () => this.options().intervalMs,
      guard: () => this.guardReason(),
      host: () => this.ensureHost(),
      disposeHost: () => this.disposeHost(),
      prune: () =>
        (
          this.repository?.checkpoints ??
          new WorkspaceCheckpoints(ctx.storage, env.WORKSPACE_CHECKPOINTS)
        ).prune(),
      beforeIdle: () => this.beforeIdleDecision(),
    })
    this.admission = SessionAdmission.make({
      store: this.store,
      storage: ctx.storage,
      configurations,
      requireRunnable: () => this.requireRunnable(),
      requireSession: (id, generation) => this.requireSession(id, generation),
      ensureHost: () => this.ensureHost(),
      arm: () => this.arm(),
      beforeCreationRecord: () => this.beforeCreationRecord(),
      afterAdmission: (id) => this.afterAdmission(id),
    })
    this.commands = SessionCommands.make({
      execute: (command) => this.execute(command),
      alarm: this.supervision.tick,
      journal: (kind, data) => this.store.journal(kind, data),
    })
    this.maintenanceService = SessionMaintenance.make({
      storage: ctx.storage,
      store: this.store,
      waitUntil: (work) => ctx.waitUntil(work),
      nativeActive: () => this.native.active(),
      workspaceBusy: () => this.repository?.busy ?? false,
      uncertain: () => this.repository?.uncertain ?? this.persistedUncertainty(),
      toolDeadline: () => this.toolDeadline(),
      stop: () => this.disposeHost(),
      checks: () => this.releaseChecks(),
      guard: () => this.guardReason(),
      rearm: () => this.rearm(),
    })
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(SessionCommands, this.commands),
        Layer.succeed(SessionAdmission, this.admission),
        Layer.succeed(SessionCompatibility, this.compatibility),
        Layer.succeed(NativeSession, this.native),
        Layer.succeed(SessionSupervision, this.supervision),
        Layer.succeed(SessionProjection, this.projection),
        Layer.succeed(SessionMaintenance, this.maintenanceService),
      ),
    )
    this.store.journal("constructed", { incarnation: this.incarnation })
    // Preserve an existing alarm; only restore one an obligation lost to a crash between arming steps.
    ctx.blockConcurrencyWhile(async () => {
      const supervision = this.store.supervision
      if (!supervision.obligation || this.guardReason() !== null) return
      if ((await ctx.storage.getAlarm()) === null) await this.rearm()
    })
  }

  protected makeRepository(selected: RepositorySelection) {
    return new RepositoryWorkspace(this.ctx.storage, this.env, selected)
  }

  // Deployment knobs; the test entry overrides these to accelerate timing.
  protected options(): RunnerOptions {
    return DEFAULT_OPTIONS
  }

  /** The model transport before the inactivity deadline is applied. */
  protected transport(): HttpClient.HttpClient {
    return Effect.runSync(Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer))
  }

  /**
   * Under a maintenance hold no fresh model request leaves the object: the
   * request waits until the drain disposes the runtime, which interrupts it as
   * a shutdown and keeps the native claim. Nothing is recorded as a provider
   * failure, so native retry accounting is untouched.
   */
  private heldTransport(): HttpClient.HttpClient {
    const base = this.transport()
    return HttpClient.make((request) =>
      Effect.suspend(() => {
        if (this.store.maintenance.held) {
          this.store.journal("model-request-held", { epoch: this.store.maintenance.epoch })
          return Effect.never
        }
        return base.execute(request).pipe(
          timed("model.response.headers", {
            sessionId: this.store.session?.sessionId ?? this.incarnation,
          }),
        )
      }),
    )
  }

  protected get release(): string {
    return this.env.JANITOR_AGENT_RUNNER_RELEASE ?? "development"
  }

  fetch(request: Request): Promise<Response> {
    return this.runtime.runPromise(
      Effect.flatMap(SessionCommands, (service) => service.handle(request)),
    )
  }

  protected async execute(command: Command): Promise<unknown> {
    switch (command.kind) {
      case "create":
        return this.create(command.sessionId, command.body)
      case "admit":
        return this.admit(command.sessionId, command.body)
      case "inspect":
        return this.inspect(command.sessionId)
      case "events":
        return this.events(command.sessionId, command.after, command.limit)
      case "maintenance":
        return this.maintenance(command.body)
      case "cleanup":
        return this.cleanup(command.sessionId, command.body)
    }
  }

  // ---------------------------------------------------------------------------
  // Guards evaluated before any host construction or execution.

  /** The concrete reason execution must not start, or null when the object may run work. */
  protected guardReason(): string | null {
    if (this.store.disconnection !== undefined) return "disconnected"
    const maintenance = this.store.maintenance
    if (maintenance.held) return `maintenance hold epoch ${maintenance.epoch}`
    return this.stateProblem()
  }

  /**
   * Blockers other than the maintenance hold itself: persisted uncertainty,
   * model configuration, the outer compatibility record against the native
   * migration journal, and the committed checkpoint's manifest. Read-only.
   */
  private stateProblem() {
    return Effect.runSync(this.compatibility.stateProblem)
  }
  private checkpointProblem() {
    return Effect.runSync(this.compatibility.checkpointProblem)
  }

  private requireRunnable() {
    const reason = this.guardReason()
    if (reason !== null) throw new ProtocolError("blocked", "The session cannot run work", reason)
  }

  private requireSession(sessionId: SessionId, generation: number): SessionRecord {
    const disconnection = this.store.disconnection
    if (disconnection !== undefined)
      throw new ProtocolError(
        "stale_generation",
        `Session ${sessionId} was disconnected at generation ${disconnection.generation}`,
      )
    const session = this.store.session
    if (session === undefined)
      throw new ProtocolError("missing_session", `Session ${sessionId} has not been created`)
    if (session.generation !== generation)
      throw new ProtocolError(
        "stale_generation",
        `Session ${sessionId} is at generation ${session.generation}; the request carried ${generation}`,
      )
    return session
  }

  // ---------------------------------------------------------------------------
  // Host lifecycle.

  protected async ensureHost(): Promise<Host> {
    return Effect.runPromise(this.native.get)
  }

  private async constructHost(): Promise<Host> {
    this.requireRunnable()
    const selected = await this.ctx.storage.get<RepositorySelection>("_janitor_repository")
    if (selected) {
      this.repository ??= this.makeRepository(selected)
      await this.repository.connect()
    }
    this.requireRunnable()
    const configurations = this.configurations as ModelConfigurations
    // Older sessions predate snapshots. Establish their baseline before starting
    // the host; deployment must retain the original records during this upgrade.
    const modelId =
      this.store.session?.modelConfigurationId ?? this.store.intendedModelConfigurationId
    if (modelId !== undefined && this.store.modelConfigurationSnapshot === undefined)
      this.store.modelConfigurationSnapshot = JSON.stringify(findRecord(configurations, modelId))
    const decision = await Effect.runPromise(this.compatibility.begin)
    return createHost({
      repository: this.repository,
      storage: this.ctx.storage,
      configurations,
      selection: () =>
        this.store.session?.modelConfigurationId ?? this.store.intendedModelConfigurationId,
      secrets: (binding) => {
        const value = this.env[binding]
        return typeof value === "string" ? value : undefined
      },
      httpClient: withCredentialRedaction(
        withInactivityDeadline(
          this.heldTransport(),
          Duration.millis(this.options().modelInactivityMs),
        ),
      ),
      journal: (kind, data) => this.store.journal(kind, data),
    }).then((host) => {
      Effect.runSync(this.compatibility.complete(decision))
      this.store.journal("host-created", { incarnation: this.incarnation })
      return host
    })
  }

  protected disposeHost() {
    return Effect.runPromise(this.native.stop)
  }
  protected rearm() {
    return Effect.runPromise(this.supervision.rearm)
  }
  protected arm() {
    return Effect.runPromise(this.supervision.arm)
  }
  alarm() {
    return this.runtime.runPromise(Effect.flatMap(SessionSupervision, (service) => service.tick))
  }
  protected async beforeIdleDecision(): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Commands.

  protected create(id: SessionId, body: CreateSession) {
    return this.runtime.runPromise(
      Effect.flatMap(SessionAdmission, (service) => service.create(id, body)),
    )
  }
  protected admit(id: SessionId, body: AdmitInput) {
    return this.runtime.runPromise(
      Effect.flatMap(SessionAdmission, (service) => service.admit(id, body)),
    )
  }
  protected async beforeCreationRecord(): Promise<void> {}

  /** Hook for tests to crash or drop the response after durable admission. */
  protected async afterAdmission(_inputId: string): Promise<void> {}

  protected inspect(sessionId: SessionId): Promise<Inspection> {
    return this.runtime.runPromise(
      Effect.flatMap(SessionProjection, (service) => service.inspect(sessionId)),
    )
  }
  protected events(sessionId: SessionId, after: number, limit: number): Promise<EventsRead> {
    return this.runtime.runPromise(
      Effect.flatMap(SessionProjection, (service) => service.events(sessionId, after, limit)),
    )
  }

  /**
   * Operator maintenance. A hold persists first, so alarms and restarts cannot
   * resume work, then drains: admitted foreground operations finish or reach
   * their finite timeout and commit their result and checkpoint, and only then
   * is the runtime disposed. Disposal is shutdown interruption, which keeps the
   * native execution claim for recovery. The hold answers immediately with
   * whether the object is quiescent; the caller asks again until it is.
   *
   * A release must carry the held epoch and passes only after the state,
   * checkpoint, model credential and bridge checks; otherwise the hold stays.
   * A newer disconnection outranks any release.
   */
  protected maintenance(body: Maintenance): Promise<MaintenanceResult> {
    return Effect.runPromise(this.maintenanceService.apply(body))
  }

  /** Uncertainty visible without a workspace object: admitted tool or bridge operations. */
  private persistedUncertainty(): boolean {
    return (
      new WorkspaceCheckpoints(this.ctx.storage, this.env.WORKSPACE_CHECKPOINTS).uncertain() ||
      (this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_janitor_operation'")
        .toArray().length === 1 &&
        this.ctx.storage.sql
          .exec("SELECT id FROM _janitor_operation WHERE state = 'admitted' LIMIT 1")
          .toArray().length > 0)
    )
  }

  /** The longest finite timeout an admitted foreground operation may still be using. */
  protected toolDeadline(): number {
    return this.repository?.currentToolTimeout ?? 120_000
  }

  /** Verifications a release requires; every failure keeps the hold. */
  private async releaseChecks(): Promise<ReadonlyArray<MaintenanceCheck>> {
    const checks: Array<MaintenanceCheck> = []
    const state = this.stateProblem()
    checks.push({ name: "state", ok: state === null, detail: state ?? "compatible" })
    const checkpoint = WorkspaceCheckpoints.needsFormatUpgrade(this.ctx.storage)
      ? null
      : this.checkpointProblem()
    checks.push({
      name: "checkpoint",
      ok: checkpoint === null,
      detail: checkpoint ?? "committed checkpoint is restorable or absent",
    })
    checks.push(this.modelCheck())
    checks.push(await this.bridgeCheck())
    return checks
  }

  private modelCheck(): MaintenanceCheck {
    if (this.configurations instanceof ModelConfigurationError)
      return { name: "model", ok: false, detail: this.configurations.message }
    const id =
      this.store.session?.modelConfigurationId ??
      this.store.intendedModelConfigurationId ??
      this.configurations.default
    const record = findRecord(this.configurations, id)
    if (record === undefined)
      return { name: "model", ok: false, detail: `model configuration ${id} is not available` }
    const secret = this.env[record.secretBinding]
    if (typeof secret !== "string" || secret === "")
      return {
        name: "model",
        ok: false,
        detail: `secret binding ${record.secretBinding} for model configuration ${id} is not set`,
      }
    return { name: "model", ok: true, detail: `model configuration ${id} has its credential` }
  }

  /**
   * The bridge this session would dispatch to must be the release's image. A
   * container that is not running is verified on its next start, before any
   * dispatch; one that answers must match now.
   */
  private async bridgeCheck(): Promise<MaintenanceCheck> {
    const selected = await this.ctx.storage.get<RepositorySelection>("_janitor_repository")
    if (!selected) return { name: "bridge", ok: true, detail: "no repository workspace" }
    const repository = (this.repository ??= this.makeRepository(selected))
    try {
      const meta = await repository.runningBridge()
      if (meta === undefined)
        return {
          name: "bridge",
          ok: true,
          detail: "bridge not running; verified before next dispatch",
        }
      checkBridge(meta, selected.generation)
      return {
        name: "bridge",
        ok: true,
        detail: `bridge ${meta.build?.sourceHash?.slice(0, 12)} matches the release`,
      }
    } catch (error) {
      return {
        name: "bridge",
        ok: false,
        detail: error instanceof ProtocolError ? (error.reason ?? error.message) : String(error),
      }
    }
  }

  protected async cleanup(sessionId: SessionId, body: Cleanup): Promise<CleanupResult> {
    const session = this.store.session
    const generation = session?.generation ?? this.store.intendedGeneration
    if (generation !== undefined && body.generation < generation)
      throw new ProtocolError(
        "stale_generation",
        `Session ${sessionId} is at generation ${generation}; cleanup carried ${body.generation}`,
      )
    const already = this.store.disconnection
    if (already !== undefined && !(await this.ctx.storage.get("_janitor_repository")))
      return { sessionId, cleaned: true }
    this.store.disconnection = { generation: body.generation, at: Date.now() }
    await this.ctx.storage.sync()
    await this.disposeHost()
    const selected = await this.ctx.storage.get<RepositorySelection>("_janitor_repository")
    if (selected) await (this.repository ?? this.makeRepository(selected)).destroy()
    await this.ctx.storage.deleteAlarm()
    // Only the tombstone survives: native conversation, inputs and journal are deleted.
    const tombstone = this.store.disconnection!
    await this.ctx.storage.deleteAll()
    const store = new RunnerStorage(this.ctx.storage)
    store.disconnection = tombstone
    store.journal("cleaned", { generation: body.generation })
    return { sessionId, cleaned: true }
  }
}
