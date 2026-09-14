// Constructs the pinned OpenCode Workerd host for one session Durable Object.
//
// The host is the SDK's embedded runtime with the Workerd profile: Durable
// Object SQLite for the database, no local process plane, and Janitor's
// replacements for model execution and model resolution. Construction forks
// the native suspended-session recovery sweep immediately, so callers must run
// every pre-host guard before calling `createHost`.
import { Effect, Layer, ManagedRuntime, Stream, Semaphore, Schema, type Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { OpenCode, Tool } from "@opencode/sdk/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionExecution } from "@opencode/core/session/execution"
import { ServerWorkerd } from "@opencode/server/workerd"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { makeMemoryDriver } from "@opencode/core/environment/index"
import { resolverLayer, type ModelConfigurations, type SecretReader } from "./ModelConfiguration.ts"
import { redactModelEvents } from "./ModelCredentials.ts"
import { type RepositoryWorkspace, type WorkspaceToolInput } from "./RepositoryWorkspace.ts"

export { SUPPORTED_NATIVE_MIGRATIONS } from "./ReleaseManifest.ts"

/** The provider shared by repository-backed and conversation-only workspaces. */
export const WORKSPACE_PROVIDER = "janitor"

export interface HostDependencies {
  readonly repository?: RepositoryWorkspace
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
  const client = Layer.effect(
    LLMClient.Service,
    Effect.gen(function* () {
      const native = yield* LLMClient.Service
      return {
        ...native,
        stream: (request, options) => {
          const record = deps.configurations.records.find(
            (record) => record.id === deps.selection(),
          )
          return redactModelEvents(
            native.stream(request, options),
            record && deps.secrets(record.secretBinding),
          )
        },
      } satisfies typeof native
    }),
  ).pipe(Layer.provide(LLMClient.layer.pipe(Layer.provide(executor))))
  const driver =
    deps.repository?.driver() ??
    WorkspaceDriver.make({
      create: ({ workspaceID }) => Effect.succeed({ binding: { workspaceID } }),
      connect: () => Effect.succeed(makeMemoryDriver()),
      suspendForIdle: () => Effect.void,
      destroy: () => Effect.void,
    })
  const options = {
    storage: deps.storage,
    models: { fetch: false },
    config: { content: JSON.stringify({ experimental: { portable_shell_scanner: true } }) },
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
        yield* sdk.plugin({
          id: "janitor-sqlite-workspace",
          effect: (context) =>
            Effect.gen(function* () {
              const gate = yield* Semaphore.make(1)
              yield* context.tool.transform((editor) => {
                for (const tool of editor.list()) editor.remove(tool.id)
                if (!deps.repository) return
                const tool = (name: string, description: string, input: Schema.Codec<unknown>) =>
                  editor.add({
                    name,
                    description,
                    input,
                    options: { permission: name, codemode: false },
                    execute: (input, execution) =>
                      Effect.tryPromise({
                        try: () =>
                          deps.repository!.tool(
                            execution.messageID + ":" + execution.id,
                            name,
                            input as WorkspaceToolInput,
                          ),
                        catch: (cause) =>
                          new Tool.Error({
                            message:
                              cause instanceof Error ? cause.message : "Repository tool failed",
                          }),
                      }).pipe(gate.withPermits(1)),
                  })
                tool(
                  "read",
                  "Read UTF-8 repository content. offset/limit are character offsets. Files persist in SQLite across restarts.",
                  Schema.Struct({
                    path: Schema.String,
                    offset: Schema.optionalKey(Schema.Int),
                    limit: Schema.optionalKey(Schema.Int),
                  }),
                )
                tool(
                  "write",
                  "Create or replace a UTF-8 repository file. This stores an edit; it does not execute the file.",
                  Schema.Struct({ path: Schema.String, content: Schema.String }),
                )
                tool(
                  "edit",
                  "Replace exact text in a repository file. oldText must occur once unless replaceAll is true.",
                  Schema.Struct({
                    path: Schema.String,
                    oldText: Schema.String,
                    newText: Schema.String,
                    replaceAll: Schema.optionalKey(Schema.Boolean),
                  }),
                )
                tool(
                  "delete",
                  "Delete a repository file from the proposed changes.",
                  Schema.Struct({ path: Schema.String }),
                )
                tool(
                  "glob",
                  "List repository paths using SQLite glob syntax (*, ?, character classes). * can span directories. Results are bounded.",
                  Schema.Struct({
                    pattern: Schema.String,
                    path: Schema.optionalKey(Schema.String),
                  }),
                )
                tool(
                  "grep",
                  "Search for literal text in repository files. This is not a regular expression or shell command; narrow path for large repositories.",
                  Schema.Struct({
                    pattern: Schema.String,
                    path: Schema.optionalKey(Schema.String),
                  }),
                )
                tool(
                  "diff",
                  "Show proposed file edits relative to the repository snapshot. This does not run tests.",
                  Schema.Struct({}),
                )
                editor.add({
                  name: "publish",
                  options: { permission: "publish", codemode: false },
                  description:
                    "Publish workspace edits through GitHub to the session's existing PR or designated branch. Describe changes and actual validation. No shell, dependencies, builds or project tests run in this workspace; GitHub CI supplies executable checks. Never claim tests passed unless their results were observed. Retry this tool to reconcile uncertain responses. Humans decide whether to merge.",
                  input: Schema.Struct({
                    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
                    body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10000)),
                    base: Schema.optionalKey(Schema.String),
                  }),
                  execute: (input, execution) =>
                    Effect.tryPromise({
                      try: () =>
                        deps.repository!.publish(() =>
                          deps.repository!.publication.publish(
                            input,
                            execution.messageID + ":" + execution.id,
                          ),
                        ),
                      catch: (cause) =>
                        new Tool.Error({
                          message: cause instanceof Error ? cause.message : "Publication failed",
                        }),
                    }).pipe(gate.withPermits(1)),
                })
              })
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
