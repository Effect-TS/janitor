// One Durable Object per Janitor agent session: the Sandbox SDK object that
// owns the session's Linux container, plus the coordinator, OpenCode host and
// recovery services composed over it. The SDK keeps its lifecycle, alarm and
// scheduler; Janitor schedules its own callbacks through them and keeps its
// tables distinct from the SDK's and OpenCode's.
import { Sandbox } from "@cloudflare/sandbox"
import { Duration, Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { makeTurnHost } from "./Host.ts"
import {
  DEFAULT_MODEL_INACTIVITY,
  ModelConfigurationError,
  findRecord,
  parseModelConfigurations,
  withCredentialRedaction,
  withInactivityDeadline,
  type ModelConfigurations,
} from "./ModelConfiguration.ts"
import { ProtocolError, type Cleanup, type CleanupResult, type SessionId } from "./Protocol.ts"
import { Publication, type RepositoryCredential } from "./Publication.ts"
import { errorResponse, jsonResponse, parseCommand, type Command } from "./Router.ts"
import { RunnerStorage, durableObjectSql } from "./Storage.ts"
import { KeyValue } from "./services/KeyValue.ts"
import { RecoveryStore } from "./services/RecoveryStore.ts"
import { RepositoryAuthority } from "./services/RepositoryAuthority.ts"
import { RepositoryCheckout } from "./services/RepositoryCheckout.ts"
import {
  REPOSITORY_DIR,
  SandboxWorkspace,
  WORKSPACE_USER,
  WorkspaceError,
  shellQuote,
  type BackupHandle,
  type ExecOptions,
  type ExecOutcome,
} from "./services/SandboxWorkspace.ts"
import { makeSandboxTools } from "./services/SandboxTools.ts"
import {
  DEFAULT_COORDINATOR_OPTIONS,
  SessionCoordinator,
  type CoordinatorOptions,
} from "./services/SessionCoordinator.ts"
import { TurnHost, TurnScheduler } from "./services/TurnHost.ts"
import { WorkspacePublication, githubRemote } from "./services/WorkspacePublication.ts"

export interface RunnerEnv {
  readonly JANITOR_AGENT_RUNNER_TOKEN?: string
  readonly JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS?: string
  readonly JANITOR_AGENT_RUNNER_RELEASE?: string
  readonly REPOSITORY_AUTHORITY?: { readonly fetch: (request: Request) => Promise<Response> }
  readonly REPOSITORY_SERVICE_TOKEN?: string
  /** The Sandbox SDK reads this binding for backups; presigned credentials come from the secrets below. */
  readonly BACKUP_BUCKET?: R2Bucket
  readonly BACKUP_BUCKET_NAME?: string
  readonly CLOUDFLARE_ACCOUNT_ID?: string
  readonly R2_ACCESS_KEY_ID?: string
  readonly R2_SECRET_ACCESS_KEY?: string
  /** Local development: backups use the R2 binding directly and the checkout comes from a fixture remote. */
  readonly JANITOR_SANDBOX_LOCAL?: string
  readonly JANITOR_LOCAL_GIT_REMOTE?: string
  readonly JANITOR_TURN_TIMEOUT_MS?: string
  readonly JANITOR_COMMAND_TIMEOUT_MS?: string
  readonly JANITOR_SAVE_RETRIES?: string
  /** Native HTTP fixture for GitHub in local Workers; production uses GitHub directly. */
  readonly GITHUB_API?: { readonly fetch: (request: Request) => Promise<Response> }
  readonly [binding: string]: unknown
}

export interface RunnerOptions extends CoordinatorOptions {
  readonly commandTimeoutMs: number
  readonly modelInactivityMs: number
}

export const DEFAULT_OPTIONS: RunnerOptions = {
  ...DEFAULT_COORDINATOR_OPTIONS,
  commandTimeoutMs: 10 * 60_000,
  modelInactivityMs: Duration.toMillis(DEFAULT_MODEL_INACTIVITY),
}

/** How long an idle container stays up after its last sandbox activity. */
export const SANDBOX_SLEEP_AFTER = "5m"

const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** The scheduled callback that drives the session's queue. */
const DRIVE_CALLBACK = "drive"

export class SessionRunner extends Sandbox<RunnerEnv> {
  override sleepAfter = SANDBOX_SLEEP_AFTER
  readonly incarnation = crypto.randomUUID()
  protected readonly store: RunnerStorage
  private readonly runtime: ManagedRuntime.ManagedRuntime<SessionCoordinator | TurnHost, never>
  private readonly configurations: ModelConfigurations | ModelConfigurationError
  /** Advances whenever the container stops, so in-flight work notices replacement. */
  private sandboxGeneration = 0
  private driving: Promise<void> | undefined

  constructor(ctx: DurableObjectState<{}>, env: RunnerEnv) {
    super(ctx, env)
    this.store = new RunnerStorage(durableObjectSql(ctx.storage))
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
    const store = this.store
    const local = env.JANITOR_SANDBOX_LOCAL === "true"
    const workspace = this.makeWorkspace()
    const kv = KeyValue.fromDurableObject(ctx.storage)
    const authority = RepositoryAuthority.make(
      env.REPOSITORY_AUTHORITY,
      env.REPOSITORY_SERVICE_TOKEN,
    )
    const remote = (credential: RepositoryCredential) =>
      env.JANITOR_LOCAL_GIT_REMOTE ?? githubRemote(credential)
    const selection = () => ({
      sessionId: store.session?.sessionId ?? "",
      generation: store.session?.generation ?? 0,
      repositoryId: store.session?.repositoryId ?? "",
    })
    const authorize = (
      token: boolean,
      permission: "read" | "push" | "pull_request" = "read",
      refresh = false,
    ) =>
      Effect.runPromise(
        authority.authorize({ ...selection(), token, permission, publication: true, refresh }),
      )
    const fence = async () => {
      if (store.disconnection !== undefined)
        throw new ProtocolError("stale_generation", "Workspace was disconnected")
    }
    const gitPublication = WorkspacePublication.make(workspace, kv, remote)
    const publication = () =>
      store.session?.repositoryId
        ? new Publication(kv, selection(), {
            authorize: (token, permission, refresh) => authorize(token, permission, refresh),
            fetch: (request) => env.GITHUB_API?.fetch(request) ?? fetch(request),
            fence,
            git: <A>(action: string, input: unknown) =>
              Effect.runPromise(gitPublication.execute(action, input)) as Promise<A>,
            checkpoint: async () => {},
          })
        : null
    const recovery = RecoveryStore.make(store, workspace, { local })
    const checkout = RepositoryCheckout.make(
      {
        store,
        credential: () =>
          store.session?.repositoryId
            ? Effect.tryPromise({
                try: () => authorize(true, "read"),
                catch: (cause) =>
                  cause instanceof ProtocolError
                    ? cause
                    : new ProtocolError("transport", String(cause)),
              })
            : Effect.succeed(null),
        associatedBranch: () =>
          Effect.tryPromise({
            try: async () => (await publication()?.workspace())?.branch ?? null,
            catch: (cause) =>
              cause instanceof ProtocolError
                ? cause
                : new ProtocolError("transport", String(cause)),
          }),
        remote,
        clock: () => Date.now(),
      },
      workspace,
      recovery,
      gitPublication,
    )
    const host = makeTurnHost({
      storage: ctx.storage,
      store,
      configurations:
        configurations instanceof ModelConfigurationError
          ? ({ default: "", records: [] } as unknown as ModelConfigurations)
          : configurations,
      selection: () => store.session?.modelConfigurationId ?? store.intendedModelConfigurationId,
      secrets: (binding) => {
        const value = env[binding]
        return typeof value === "string" ? value : undefined
      },
      httpClient: withCredentialRedaction(
        withInactivityDeadline(
          this.modelTransport(),
          Duration.millis(this.options().modelInactivityMs),
        ),
      ),
      tools: () =>
        makeSandboxTools({
          workspace,
          publication: publication(),
          hasRepository:
            store.session?.repositoryId !== null && store.session?.repositoryId !== undefined,
          commandTimeoutMs: this.options().commandTimeoutMs,
          published: (published) => {
            const running = store.runningAttempt()
            store.emit(
              "turn.published",
              {
                inputId: running?.inputId ?? null,
                attempt: running?.attempt ?? null,
                publication: published,
              },
              Date.now(),
            )
          },
          journal: (kind, data) => store.journal(kind, data),
        }),
      session: () => {
        const session = store.session
        return session === undefined
          ? undefined
          : {
              nativeSessionId: session.nativeSessionId,
              title: session.title,
              repositoryId: session.repositoryId,
            }
      },
      journal: (kind, data) => store.journal(kind, data),
    })
    const scheduler: TurnScheduler["Service"] = {
      wake: (delayMs) =>
        Effect.promise(async () => {
          await this.schedule(Math.ceil(delayMs / 1000), DRIVE_CALLBACK, {})
        }),
    }
    const coordinator = SessionCoordinator.make(
      {
        store,
        incarnation: this.incarnation,
        options: () => this.options(),
        clock: () => Date.now(),
        release: () => this.release,
        guard: () => this.guardReason(),
        resolveModelConfiguration: (requested) => {
          if (configurations instanceof ModelConfigurationError)
            throw new ProtocolError(
              "blocked",
              "The session cannot run work",
              configurations.message,
            )
          const id = requested ?? configurations.default
          if (findRecord(configurations, id) === undefined)
            throw new ProtocolError("invalid_request", `Model configuration ${id} is not available`)
          return id
        },
      },
      host,
      checkout,
      recovery,
      workspace,
      scheduler,
    )
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(Layer.succeed(SessionCoordinator, coordinator), Layer.succeed(TurnHost, host)),
    )
    this.store.journal("constructed", { incarnation: this.incarnation })
    ctx.blockConcurrencyWhile(() => this.runtime.runPromise(coordinator.recover))
  }

  // ---------------------------------------------------------------------------
  // Deployment knobs and guards.

  protected options(): RunnerOptions {
    return {
      ...DEFAULT_OPTIONS,
      turnTimeoutMs: integer(this.env.JANITOR_TURN_TIMEOUT_MS, DEFAULT_OPTIONS.turnTimeoutMs),
      commandTimeoutMs: integer(
        this.env.JANITOR_COMMAND_TIMEOUT_MS,
        DEFAULT_OPTIONS.commandTimeoutMs,
      ),
      saveRetries: integer(this.env.JANITOR_SAVE_RETRIES, DEFAULT_OPTIONS.saveRetries),
    }
  }

  /** The model transport before the inactivity deadline is applied. */
  protected modelTransport(): HttpClient.HttpClient {
    return Effect.runSync(Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer))
  }

  protected get release(): string {
    return this.env.JANITOR_AGENT_RUNNER_RELEASE ?? "development"
  }

  /** The concrete reason execution must not start, or null when the object may run work. */
  protected guardReason(): string | null {
    if (this.store.disconnection !== undefined) return "disconnected"
    if (this.store.retired)
      return "session state predates the sandbox runner; it is retired at cutover"
    if (this.configurations instanceof ModelConfigurationError) return this.configurations.message
    const id = this.store.session?.modelConfigurationId ?? this.store.intendedModelConfigurationId
    if (id !== undefined && findRecord(this.configurations, id) === undefined)
      return `model configuration ${id} is not available in this deployment`
    return null
  }

  // ---------------------------------------------------------------------------
  // The sandbox as a service.

  protected makeWorkspace(): SandboxWorkspace["Service"] {
    const failure = (reason: WorkspaceError["reason"], cause: unknown) =>
      new WorkspaceError({
        reason,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    const attempt = <A>(run: () => Promise<A>, reason: WorkspaceError["reason"] = "failed") => {
      const generation = this.sandboxGeneration
      return Effect.tryPromise({
        try: run,
        catch: (cause) =>
          this.sandboxGeneration !== generation ? failure("lost", cause) : failure(reason, cause),
      })
    }
    const killWorkspaceProcesses = () =>
      this.exec(`pkill -KILL -u ${WORKSPACE_USER} || true`).then(() => undefined)
    const exec = (command: string, options: ExecOptions = {}) =>
      attempt(async (): Promise<ExecOutcome> => {
        const started = Date.now()
        const controller = new AbortController()
        const timeoutMs = options.timeoutMs ?? this.options().commandTimeoutMs
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          void killWorkspaceProcesses().catch(() => undefined)
        }, timeoutMs)
        const onAbort = () => controller.abort()
        options.signal?.addEventListener("abort", onAbort, { once: true })
        try {
          const result = await this.exec(command, {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.env === undefined ? {} : { env: options.env }),
            signal: controller.signal,
            timeout: timeoutMs + 5_000,
          })
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut,
            durationMs: Date.now() - started,
          }
        } catch (cause) {
          if (timedOut)
            return {
              exitCode: 124,
              stdout: "",
              stderr: "",
              timedOut: true,
              durationMs: Date.now() - started,
            }
          throw cause
        } finally {
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", onAbort)
        }
      })
    return {
      generation: () => this.sandboxGeneration,
      exec,
      readFile: (path) =>
        attempt(async () => {
          const exists = await this.exists(path)
          if (!exists.exists) return null
          const file = await this.readFile(path)
          return file.content
        }),
      writeFile: (path, content) =>
        attempt(async () => {
          await this.writeFile(path, content)
        }),
      stopProcesses: attempt(async () => {
        await this.killAllProcesses().catch(() => 0)
        await killWorkspaceProcesses()
      }),
      createBackup: (request) =>
        attempt(async (): Promise<BackupHandle> => {
          const backup = await this.createBackup({
            dir: request.dir,
            ttl: request.ttlSeconds,
            excludes: [...request.excludes],
            ...(request.local ? { localBucket: true } : {}),
          })
          return {
            id: backup.id,
            dir: backup.dir,
            ...(backup.localBucket ? { localBucket: true } : {}),
          }
        }),
      restoreBackup: (backup) =>
        attempt(async () => {
          await this.restoreBackup({
            id: backup.id,
            dir: backup.dir,
            ...(backup.localBucket ? { localBucket: true } : {}),
          })
        }),
      deleteBackup: (backup) =>
        attempt(async () => {
          const bucket = this.env.BACKUP_BUCKET
          if (bucket === undefined) throw new Error("BACKUP_BUCKET is not bound")
          await bucket.delete([`backups/${backup.id}/data.sqsh`, `backups/${backup.id}/meta.json`])
        }),
      destroy: attempt(async () => {
        await this.destroy()
      }),
      renewActivity: () => this.renewActivityTimeout(),
    }
  }

  override async onStop(params?: Parameters<Sandbox<RunnerEnv>["onStop"]>[0]) {
    await super.onStop(params)
    this.sandboxGeneration++
    this.store.journal("sandbox-stopped", {
      reason: params?.reason ?? null,
      exitCode: params?.exitCode ?? null,
    })
    await this.runtime.runPromise(
      Effect.flatMap(SessionCoordinator, (coordinator) => coordinator.workspaceLost),
    )
  }

  // ---------------------------------------------------------------------------
  // Scheduled work.

  /** The Sandbox scheduler's callback: drives the queue while the alarm handler keeps the object alive. */
  async drive(_payload?: unknown) {
    if (this.driving !== undefined) return this.driving
    this.driving = this.runtime
      .runPromise(Effect.flatMap(SessionCoordinator, (coordinator) => coordinator.drive))
      .catch((cause) => {
        this.store.journal("drive-failed", { error: String(cause) })
      })
      .finally(() => {
        this.driving = undefined
      })
    return this.driving
  }

  // ---------------------------------------------------------------------------
  // Commands.

  override async fetch(request: Request): Promise<Response> {
    try {
      const command = await parseCommand(request)
      const mutates = command.kind !== "inspect" && command.kind !== "events"
      if (mutates) this.store.journal("command-received", { command: command.kind })
      return jsonResponse(await this.execute(command))
    } catch (error) {
      if (!(error instanceof ProtocolError))
        this.store.journal("command-failed", { error: String(error) })
      return errorResponse(error)
    }
  }

  protected execute(command: Command): Promise<unknown> {
    const coordinator = Effect.flatMap(
      SessionCoordinator,
      (service): Effect.Effect<unknown, unknown> => {
        switch (command.kind) {
          case "create":
            return service.create(command.sessionId, command.body)
          case "admit":
            return service.admit(command.sessionId, command.body)
          case "act":
            return service.act(command.sessionId, command.body)
          case "inspect":
            return service.inspect(command.sessionId)
          case "events":
            return service.events(command.sessionId, command.after, command.limit)
          case "cleanup":
            return Effect.promise(() => this.cleanup(command.sessionId, command.body))
        }
      },
    )
    return this.runtime.runPromise(coordinator)
  }

  protected async cleanup(sessionId: SessionId, body: Cleanup): Promise<CleanupResult> {
    const store = this.store
    const generation = store.session?.generation ?? store.intendedGeneration
    if (generation !== undefined && body.generation < generation)
      throw new ProtocolError(
        "stale_generation",
        `Session ${sessionId} is at generation ${generation}; cleanup carried ${body.generation}`,
      )
    if (store.disconnection !== undefined && store.session === undefined)
      return { sessionId, cleaned: true }
    store.disconnection = { generation: body.generation, at: Date.now() }
    await this.ctx.storage.sync()
    await this.runtime.runPromise(
      Effect.flatMap(SessionCoordinator, (coordinator) => coordinator.workspaceLost),
    )
    await this.runtime.runPromise(Effect.flatMap(TurnHost, (host) => host.dispose))
    await this.driving?.catch(() => undefined)
    const workspace = this.makeWorkspace()
    const recovery = RecoveryStore.make(store, workspace, {
      local: this.env.JANITOR_SANDBOX_LOCAL === "true",
    })
    await Effect.runPromise(recovery.deleteAll)
    await this.destroy().catch((cause) => store.journal("destroy-failed", { error: String(cause) }))
    await this.ctx.storage.deleteAlarm()
    // Only the tombstone survives: native conversation, inputs, events and journal are deleted.
    const tombstone = store.disconnection
    await this.ctx.storage.deleteAll()
    const fresh = new RunnerStorage(durableObjectSql(this.ctx.storage))
    fresh.disconnection = tombstone
    fresh.journal("cleaned", { generation: body.generation })
    return { sessionId, cleaned: true }
  }
}

export { REPOSITORY_DIR, shellQuote }
