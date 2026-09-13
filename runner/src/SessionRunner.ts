// One Durable Object per Janitor agent session.
//
// The object owns the native OpenCode conversation, inbox and execution events
// through the pinned Workerd SDK, plus the `_janitor_*` coordination records:
// immutable input receipts, the supervision revision and wake obligation, the
// compatibility record and maintenance/blocker guards. Its alarm is a persisted
// check-in, never a prompt: it wakes admitted work, lets native recovery own
// interrupted turns and clears itself once the session is idle.
import { Duration, Effect } from "effect"
import { DurableObject } from "cloudflare:workers"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AbsolutePath, Location, Session } from "@opencode/sdk/effect"
import { createHost, SUPPORTED_NATIVE_MIGRATIONS, WORKSPACE_PROVIDER, type Host } from "./Host.ts"
import { decideCompatibility } from "./Compatibility.ts"
import {
  JANITOR_STATE_FORMAT,
  NATIVE_MIGRATION_TARGET,
  RELEASE_MANIFEST,
} from "./ReleaseManifest.ts"
import {
  DEFAULT_MODEL_INACTIVITY,
  ModelConfigurationError,
  findRecord,
  parseModelConfigurations,
  withInactivityDeadline,
  type ModelConfigurations,
} from "./ModelConfiguration.ts"
import {
  PROTOCOL_VERSION,
  ProtocolError,
  type AdmitInput,
  type AdmitResult,
  type Cleanup,
  type CleanupResult,
  type CreateSession,
  type CreateSessionResult,
  type EventsRead,
  type ExecutionState,
  type Inspection,
  type Maintenance,
  type MaintenanceCheck,
  type MaintenanceResult,
  type SessionId,
  type UsageTotals,
} from "./Protocol.ts"
import { errorResponse, jsonResponse, parseCommand, type Command } from "./Router.ts"
import { RunnerStorage, payloadHash, type NativeSessionRow, type SessionRecord } from "./Storage.ts"
import {
  RepositoryWorkspace,
  REPOSITORY_TOOLS,
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

/** How long past its finite timeout an admitted operation may take to settle before a hold gives up waiting. */
const DRAIN_GRACE_MS = 30_000

/** A native execution claim survives shutdown; its presence means work is owned or recoverable. */
const claimHeld = (row: NativeSessionRow | undefined) =>
  row !== undefined && row.timeSuspended !== null

/** Guidance attached to every session's native instructions. */
const CONVERSATION_GUIDANCE =
  "You collaborate with a team through a chat thread. Ask questions in ordinary replies and end your turn when you need a teammate's answer; the next message in the thread continues the conversation. Run commands in the foreground with a finite timeout."

export class SessionRunner extends DurableObject<RunnerEnv> {
  protected readonly store: RunnerStorage
  readonly incarnation = crypto.randomUUID()
  private host: Host | undefined
  private hostPromise: Promise<Host> | undefined
  private creating: Promise<CreateSessionResult> | undefined
  private readonly configurations: ModelConfigurations | ModelConfigurationError
  private repository: RepositoryWorkspace | undefined
  /** The in-flight maintenance drain; a hold answers from it instead of waiting on it. */
  private draining: Promise<void> | undefined

  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env)
    this.store = new RunnerStorage(ctx.storage)
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
        return base.execute(request)
      }),
    )
  }

  protected get release(): string {
    return this.env.JANITOR_AGENT_RUNNER_RELEASE ?? "development"
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const command = await parseCommand(request)
      return jsonResponse(await this.execute(command))
    } catch (error) {
      if (!(error instanceof ProtocolError))
        this.store.journal("command-failed", { error: String(error) })
      return errorResponse(error)
    }
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
  private stateProblem(): string | null {
    const blockers = this.store.blockers
    if (blockers.length > 0) return blockers[0]!
    if (this.configurations instanceof ModelConfigurationError) return this.configurations.message
    const decision = decideCompatibility({
      record: this.store.compatibility,
      nativeInitialized: this.store.nativeInitialized,
      applied: this.store.nativeMigrations,
    })
    if (decision.kind === "blocked") return decision.reason
    if (!decision.upgradeFormat && this.store.compatibility !== undefined)
      return this.checkpointProblem()
    return null
  }

  private checkpointIdentity() {
    const session = this.store.session
    const repositoryId = this.store.intendedRepositoryId
    if (session === undefined || !repositoryId) return undefined
    return { sessionId: session.sessionId, generation: session.generation, repositoryId }
  }

  private checkpointProblem(): string | null {
    if (WorkspaceCheckpoints.needsFormatUpgrade(this.ctx.storage)) return null
    return new WorkspaceCheckpoints(
      this.ctx.storage,
      this.env.WORKSPACE_CHECKPOINTS,
      this.checkpointIdentity(),
    ).validate()
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
    if (this.host !== undefined) return this.host
    if (this.hostPromise !== undefined) return this.hostPromise
    this.hostPromise = this.constructHost().finally(() => {
      this.hostPromise = undefined
    })
    return this.hostPromise
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
    const recorded = this.store.compatibility
    const decision = decideCompatibility({
      record: recorded,
      nativeInitialized: this.store.nativeInitialized,
      applied: this.store.nativeMigrations,
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
          : { target: NATIVE_MIGRATION_TARGET, release: this.release, startedAt: Date.now() }
      this.store.compatibility = {
        formatVersion: JANITOR_STATE_FORMAT,
        family: RELEASE_MANIFEST.family,
        protocol: PROTOCOL_VERSION,
        release: this.release,
        nativeMigrations: recorded?.nativeMigrations ?? [],
        inProgress: intent,
      }
      await this.ctx.storage.sync()
      this.store.journal(decision.resume ? "migration-resumed" : "migration-started", {
        target: intent.target,
        upgradeFormat: decision.upgradeFormat,
        applied: this.store.nativeMigrations.length,
      })
    }
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
      httpClient: withInactivityDeadline(
        this.heldTransport(),
        Duration.millis(this.options().modelInactivityMs),
      ),
      journal: (kind, data) => this.store.journal(kind, data),
    }).then((host) => {
      const applied = this.store.nativeMigrations
      const unknown = applied.filter((id) => !SUPPORTED_NATIVE_MIGRATIONS.includes(id))
      if (unknown.length > 0)
        throw new Error(`Native initialization produced unknown migrations ${unknown.join(", ")}`)
      if (applied.length !== SUPPORTED_NATIVE_MIGRATIONS.length || !this.store.nativeInitialized)
        throw new Error(
          `Native initialization recorded ${applied.length} of ${SUPPORTED_NATIVE_MIGRATIONS.length} migrations`,
        )
      // The Janitor-owned step of the upgrade runs after the native set is complete
      // and is idempotent, so a restart between it and the completion record repeats it.
      if (decision.upgradeFormat || WorkspaceCheckpoints.needsFormatUpgrade(this.ctx.storage)) {
        WorkspaceCheckpoints.upgradeFormat(this.ctx.storage, this.checkpointIdentity())
        this.store.journal("state-upgraded", { format: JANITOR_STATE_FORMAT })
      }
      const problem = this.checkpointProblem()
      if (problem !== null) throw new ProtocolError("blocked", problem, problem)
      if (decision.initialize)
        this.store.compatibility = {
          formatVersion: JANITOR_STATE_FORMAT,
          family: RELEASE_MANIFEST.family,
          protocol: PROTOCOL_VERSION,
          release: this.release,
          nativeMigrations: SUPPORTED_NATIVE_MIGRATIONS,
          inProgress: null,
        }
      this.host = host
      this.store.journal("host-created", { incarnation: this.incarnation })
      return host
    })
  }

  protected async disposeHost() {
    await this.hostPromise?.catch(() => undefined)
    const host = this.host
    this.host = undefined
    if (host === undefined) return
    await host.dispose()
    this.store.journal("host-disposed", { incarnation: this.incarnation })
  }

  // ---------------------------------------------------------------------------
  // Supervision.

  /** Sets the alarm no later than one interval from now, keeping an earlier alarm. */
  protected async rearm() {
    const due = Date.now() + this.options().intervalMs
    const existing = await this.ctx.storage.getAlarm()
    if (existing === null || existing > due) await this.ctx.storage.setAlarm(due)
    const supervision = this.store.supervision
    this.store.supervision = {
      ...supervision,
      dueAt: existing === null || existing > due ? due : existing,
    }
  }

  /** Persists a wake obligation for a new admission and arms the alarm before native work can start. */
  protected async arm() {
    const supervision = this.store.supervision
    this.store.supervision = {
      revision: supervision.revision + 1,
      obligation: true,
      dueAt: supervision.dueAt,
    }
    await this.rearm()
    this.store.journal("armed", { revision: supervision.revision + 1 })
  }

  override async alarm(): Promise<void> {
    this.store.journal("alarm-start", { incarnation: this.incarnation })
    // Cleanup also progresses while uncertain native execution remains held.
    try {
      await (
        this.repository?.checkpoints ??
        new WorkspaceCheckpoints(this.ctx.storage, this.env.WORKSPACE_CHECKPOINTS)
      ).prune()
    } catch (error) {
      this.store.journal("checkpoint-cleanup-error", { error: String(error) })
      await this.rearm()
      return
    }
    const supervision = this.store.supervision
    if (!supervision.obligation || this.store.disconnection !== undefined) {
      this.store.journal("alarm-noop")
      return
    }
    const guard = this.guardReason()
    if (guard !== null) {
      // The obligation survives; releasing the hold or repairing state re-arms it.
      this.store.journal("alarm-blocked", { reason: guard })
      await this.ctx.storage.deleteAlarm()
      return
    }
    // Rearm before fallible inspection so progress never depends on platform alarm retries alone.
    await this.rearm()
    const revision = supervision.revision
    try {
      await this.check(revision)
    } catch (error) {
      this.store.journal("inspection-error", { error: String(error) })
    }
    this.store.journal("alarm-end")
  }

  /** Hook for tests to delay the idle decision and race it against admissions. */
  protected async beforeIdleDecision(): Promise<void> {}

  private async check(revision: number) {
    const host = await this.ensureHost()
    const session = this.store.session
    if (session === undefined) {
      this.store.journal("inspected", { creating: true })
      return
    }
    const nativeId = Session.ID.make(session.nativeSessionId)
    const active = await host.run(host.execution.isActive(nativeId))
    const row = this.store.nativeSession(session.nativeSessionId)
    const pending = this.store.pendingInbox(session.nativeSessionId, row?.timeIdle ?? null)
    this.store.journal("inspected", {
      active,
      claimHeld: claimHeld(row),
      outcome: row?.idleOutcome ?? null,
      pending,
      revision,
      resumeAttempts: row?.resumeAttempts ?? 0,
    })
    if (active) return
    await this.repository?.checkpoints.prune()
    if (claimHeld(row)) {
      // An orphaned claim: native recovery runs from host construction with its durable
      // resumption accounting. A host older than two checks that still shows the claim held
      // and no local execution has finished its sweep, so restart through a fresh host
      // instead of resuming outside that accounting.
      if (Date.now() - host.createdAt > this.options().intervalMs * 2) {
        this.store.journal("recover-orphan", { resumeAttempts: row?.resumeAttempts ?? 0 })
        await this.disposeHost()
      }
      return
    }
    const runnable = row?.idleOutcome === "failed" ? pending.sinceIdle > 0 : pending.total > 0
    if (runnable) {
      this.store.journal("wake")
      await host.run(host.execution.wake(nativeId))
      return
    }
    await this.beforeIdleDecision()
    const cleared = this.store.transaction(() => {
      const current = this.store.supervision
      if (current.revision !== revision) return false
      this.store.supervision = { ...current, obligation: false, dueAt: null }
      return true
    })
    if (!cleared) {
      this.store.journal("idle-raced")
      return
    }
    await this.ctx.storage.deleteAlarm()
    // An admission between the transaction and the alarm deletion re-armed a newer obligation.
    if (this.store.supervision.revision !== revision) await this.rearm()
    this.store.journal("idle", { outcome: row?.idleOutcome ?? null })
  }

  // ---------------------------------------------------------------------------
  // Commands.

  protected async create(sessionId: SessionId, body: CreateSession): Promise<CreateSessionResult> {
    const disconnection = this.store.disconnection
    if (disconnection !== undefined)
      throw new ProtocolError(
        "stale_generation",
        `Session ${sessionId} was disconnected at generation ${disconnection.generation}; reconnection uses a new session`,
      )
    const existing = this.store.session
    if (existing !== undefined) {
      const selected = await this.ctx.storage.get<RepositorySelection>("_janitor_repository")
      if (selected?.repositoryId !== body.repositoryId)
        throw new ProtocolError("invalid_request", "Session repository selection is immutable")
      if (existing.generation !== body.generation)
        throw new ProtocolError(
          "stale_generation",
          `Session ${sessionId} exists at generation ${existing.generation}; the request carried ${body.generation}`,
        )
      return this.createResult(existing, false)
    }
    if (
      this.store.intendedRepositoryId !== undefined &&
      this.store.intendedRepositoryId !== (body.repositoryId ?? null)
    )
      throw new ProtocolError("invalid_request", "Session repository selection is immutable")
    if (this.creating !== undefined) return this.creating
    this.requireRunnable()
    const configurations = this.configurations as ModelConfigurations
    const intendedGeneration = this.store.intendedGeneration
    if (intendedGeneration !== undefined && intendedGeneration !== body.generation)
      throw new ProtocolError(
        "stale_generation",
        `Session ${sessionId} creation began at generation ${intendedGeneration}; the request carried ${body.generation}`,
      )
    const modelConfigurationId =
      this.store.intendedModelConfigurationId ?? body.modelConfigurationId ?? configurations.default
    if (findRecord(configurations, modelConfigurationId) === undefined)
      throw new ProtocolError(
        "invalid_request",
        `Model configuration ${modelConfigurationId} is not available`,
      )
    // Deterministic identities persist before native creation, so a retry or a crash after
    // native creation reconciles the same conversation instead of creating another.
    this.store.transaction(() => {
      if (this.store.intendedRepositoryId === undefined)
        this.store.intendedRepositoryId = body.repositoryId ?? null
      if (this.store.intendedGeneration === undefined)
        this.store.intendedGeneration = body.generation
      if (this.store.intendedModelConfigurationId === undefined)
        this.store.intendedModelConfigurationId = modelConfigurationId
      if (this.store.intendedNativeSessionId === undefined)
        this.store.intendedNativeSessionId = "ses_" + crypto.randomUUID().replaceAll("-", "")
    })
    const intended = this.store.intendedNativeSessionId!
    this.creating = (async () => {
      const selected = await this.ctx.storage.get<RepositorySelection>("_janitor_repository")
      if (selected && selected.repositoryId !== body.repositoryId)
        throw new ProtocolError("invalid_request", "Session repository selection changed")
      if (body.repositoryId && !selected)
        await this.ctx.storage.put("_janitor_repository", {
          sessionId,
          generation: body.generation,
          repositoryId: body.repositoryId,
        })
      const host = await this.ensureHost()
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
      await this.beforeCreationRecord()
      const record: SessionRecord = {
        sessionId,
        generation: body.generation,
        nativeSessionId: intended,
        modelConfigurationId,
        title: body.title,
        createdAt: Date.now(),
      }
      this.store.session = record
      this.store.journal("created", { nativeSessionId: intended, created })
      return this.createResult(record, created)
    })().finally(() => {
      this.creating = undefined
    })
    return this.creating
  }

  /** Hook for tests to crash between native creation and the durable mapping. */
  protected async beforeCreationRecord(): Promise<void> {}

  private createResult(record: SessionRecord, created: boolean): CreateSessionResult {
    return {
      sessionId: record.sessionId,
      generation: record.generation,
      nativeSessionId: record.nativeSessionId,
      modelConfigurationId: record.modelConfigurationId,
      created,
    }
  }

  protected async admit(sessionId: SessionId, body: AdmitInput): Promise<AdmitResult> {
    const session = this.requireSession(sessionId, body.generation)
    this.requireRunnable()
    const hash = await payloadHash(body.text, body.attribution)
    const existing = this.store.input(body.inputId)
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
      this.store.insertInput({
        inputId: body.inputId,
        payloadHash: hash,
        text: body.text,
        attribution: body.attribution,
        receivedAt: Date.now(),
        admittedAt: null,
      })
    const record = existing ?? this.store.input(body.inputId)!
    // The wake obligation and alarm exist before native admission can start work.
    await this.arm()
    const host = await this.ensureHost()
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
    this.store.markAdmitted(body.inputId, admittedAt)
    // A row received earlier but never natively admitted (a crash or failure before
    // admission) is a first admission now; only a held receipt makes this a duplicate.
    const duplicate = existing !== undefined && existing.admittedAt !== null
    this.store.journal("admitted", { inputId: body.inputId, duplicate })
    await this.afterAdmission(body.inputId)
    const stored = this.store.input(body.inputId)!
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

  /** Hook for tests to crash or drop the response after durable admission. */
  protected async afterAdmission(_inputId: string): Promise<void> {}

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
    const guard = this.guardReason()
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
  protected async inspect(sessionId: SessionId): Promise<Inspection> {
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
      alarmAt: await this.ctx.storage.getAlarm(),
      pendingInputs: pending.total,
      admittedInputs: this.store.admittedInputCount,
      claimHeld: claimHeld(row),
      lastOutcome: row?.idleOutcome ?? null,
      maintenanceEpoch: this.store.maintenance.epoch,
      usage: session === undefined ? null : this.usage(row, session.nativeSessionId),
      release: this.release,
    }
  }

  protected async events(sessionId: SessionId, after: number, limit: number): Promise<EventsRead> {
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
  protected async maintenance(body: Maintenance): Promise<MaintenanceResult> {
    const current = this.store.maintenance
    if (body.hold) {
      if (current.held && current.epoch !== null && current.epoch > body.epoch)
        return this.maintenanceStatus(current, [])
      if (!current.held || current.epoch !== body.epoch) {
        this.store.maintenance = { held: true, epoch: body.epoch }
        await this.ctx.storage.sync()
        this.store.journal("maintenance-held", { epoch: body.epoch })
      }
      await this.ctx.storage.deleteAlarm()
      if (
        this.draining === undefined &&
        (this.host !== undefined || this.hostPromise !== undefined || this.repository?.busy)
      ) {
        this.draining = this.drain().finally(() => {
          this.draining = undefined
        })
        this.ctx.waitUntil(this.draining)
      }
      // Give a drain with nothing to wait for the chance to finish before answering.
      if (this.draining !== undefined)
        await Promise.race([this.draining, new Promise((resolve) => setTimeout(resolve, 50))])
      return this.maintenanceStatus(this.store.maintenance, [])
    }
    if (this.store.disconnection !== undefined)
      return this.maintenanceStatus(current, [
        {
          name: "fence",
          ok: false,
          detail: "session was disconnected; the fence outranks release",
        },
      ])
    if (!current.held) return this.maintenanceStatus(current, [])
    if (current.epoch !== body.epoch)
      throw new ProtocolError(
        "invalid_request",
        `Maintenance epoch ${body.epoch} does not match the held epoch ${current.epoch}`,
      )
    const checks = await this.releaseChecks()
    if (checks.some((check) => !check.ok)) {
      this.store.journal("maintenance-release-refused", { epoch: body.epoch, checks })
      return this.maintenanceStatus(current, checks)
    }
    this.store.maintenance = { held: false, epoch: body.epoch }
    this.store.journal("maintenance-released", { epoch: body.epoch })
    if (this.store.supervision.obligation && this.guardReason() === null) await this.rearm()
    return this.maintenanceStatus(this.store.maintenance, checks)
  }

  private maintenanceStatus(
    state: { held: boolean; epoch: number | null },
    checks: ReadonlyArray<MaintenanceCheck>,
  ): MaintenanceResult {
    const repository = this.repository
    return {
      held: state.held,
      epoch: state.epoch,
      quiescent:
        this.host === undefined &&
        this.hostPromise === undefined &&
        this.draining === undefined &&
        !(repository?.busy ?? false),
      uncertain:
        this.store.blockers.length > 0 || (repository?.uncertain ?? this.persistedUncertainty()),
      checks,
    }
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

  /** Waits for admitted work to settle within its finite deadline, then disposes the runtime. */
  private async drain() {
    const started = Date.now()
    const deadline = started + this.toolDeadline() + DRAIN_GRACE_MS
    while (this.repository?.busy && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
    const settled = !this.repository?.busy
    // Beyond the deadline the operation stays admitted: its outcome is uncertain,
    // and recovery holds it for reconciliation instead of guessing.
    await this.disposeHost()
    await this.ctx.storage.deleteAlarm()
    this.store.journal("maintenance-quiescent", { waitedMs: Date.now() - started, settled })
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
