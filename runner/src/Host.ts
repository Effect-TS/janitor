// Constructs the pinned OpenCode Workerd host for one session Durable Object.
//
// The host is the SDK's embedded runtime with the Workerd profile: Durable
// Object SQLite for the database, no local process plane, and Janitor's
// replacements for model execution and model resolution. Construction forks
// the native suspended-session recovery sweep immediately, so callers must run
// every pre-host guard before calling `createHost`.
import { Effect, Layer, ManagedRuntime, Stream, type Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { OpenCode, Tool } from "@opencode/sdk/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionExecution } from "@opencode/core/session/execution"
import { ServerWorkerd } from "@opencode/server/workerd"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { makeMemoryDriver } from "@opencode/core/environment/index"
import { migrations } from "@opencode/core/database/migration.gen"
import { resolverLayer, type ModelConfigurations, type SecretReader } from "./ModelConfiguration.ts"

/** Native migration ids this release's pinned SDK applies. Newer ids in storage mean newer code wrote it. */
export const SUPPORTED_NATIVE_MIGRATIONS: ReadonlyArray<string> = migrations.map(
  (migration) => migration.id,
)

/** The workspace provider name used until repository execution lands. */
export const WORKSPACE_PROVIDER = "janitor"

export interface HostDependencies {
  readonly storage: DurableObjectStorage
  readonly configurations: ModelConfigurations
  /** The session's persisted model configuration id. */
  readonly selection: () => string | undefined
  readonly secrets: SecretReader
  /** Model transport with the inactivity deadline already applied. */
  readonly httpClient: HttpClient.HttpClient
  readonly journal: (kind: string, data?: unknown) => void
}

export interface Host {
  readonly createdAt: number
  readonly sdk: <A, E>(
    f: (sdk: OpenCode.Interface) => Effect.Effect<A, E, Scope.Scope>,
  ) => Promise<A>
  readonly run: <A, E>(effect: Effect.Effect<A, E, OpenCode.Service>) => Promise<A>
  /** The host-scoped native execution coordinator, captured at construction. */
  readonly execution: SessionExecution.Interface
  readonly dispose: () => Promise<void>
}

export const createHost = (deps: HostDependencies): Promise<Host> => {
  let captured: SessionExecution.Interface | undefined
  const execution = SessionExecution.node.mapLayer((layer) =>
    Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const native = yield* SessionExecution.Service
        captured = native
        return native
      }),
    ).pipe(Layer.provide(layer)),
  )
  const executor = RequestExecutor.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, deps.httpClient)),
  )
  const client = LLMClient.layer.pipe(Layer.provide(executor))
  const driver = WorkspaceDriver.make({
    create: ({ workspaceID }) => Effect.succeed({ binding: { workspaceID } }),
    connect: () => Effect.succeed(makeMemoryDriver()),
    suspendForIdle: () => Effect.void,
    destroy: () => Effect.void,
  })
  const options = {
    storage: deps.storage,
    models: { fetch: false },
    config: { content: "{}" },
  }
  const runtime = ManagedRuntime.make(
    Layer.effect(
      OpenCode.Service,
      Effect.gen(function* () {
        const sdk = yield* OpenCode.create(
          {
            ...ServerWorkerd.serverOptions(options),
            workspaceProviders: { [WORKSPACE_PROVIDER]: driver },
          },
          {
            overrides: [
              ...ServerWorkerd.replacements(options),
              SessionExecution.node.replace(execution),
              llmClient.replace(client),
              SessionRunnerModel.node.replace(
                resolverLayer(deps.configurations, deps.selection, deps.secrets),
              ),
            ],
          },
        )
        // Ordinary conversational questions: the structured form tool is not advertised.
        yield* sdk.plugin({
          id: "janitor-plain-questions",
          effect: (context) => context.tool.transform((editor) => editor.remove("question")),
        })
        // Foreground-only commands with finite timeouts, rejected before the shell boundary.
        yield* sdk.plugin({
          id: "janitor-foreground-shell",
          effect: (context) =>
            context.tool.hook("execute.before", (event) => {
              if (event.tool !== "shell") return Effect.void
              const input = event.input as
                | { readonly timeout?: unknown; readonly background?: unknown }
                | undefined
              const timeout = input?.timeout
              const unlimited =
                timeout !== undefined &&
                (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
              if (input?.background === true || unlimited) {
                deps.journal("shell-rejected", { input })
                return Effect.fail(
                  new Tool.Error({
                    message:
                      "Janitor runs commands in the foreground with a finite timeout. Retry without `background` and with a positive `timeout` in milliseconds.",
                  }),
                )
              }
              return Effect.void
            }),
        })
        return sdk
      }),
    ),
  )
  const run: Host["run"] = (effect) => runtime.runPromise(effect)
  return run(Effect.map(OpenCode.Service, () => undefined)).then(() => {
    if (captured === undefined) throw new Error("Native execution service was not constructed")
    return {
      createdAt: Date.now(),
      run,
      sdk: (f) => run(Effect.flatMap(OpenCode.Service, (sdk) => Effect.scoped(f(sdk)))),
      execution: captured,
      dispose: () => runtime.dispose(),
    }
  })
}

export const collectLog = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)))
