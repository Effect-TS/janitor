import * as AgentExecutor from "clanka/AgentExecutor"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Schema from "effect/Schema"
import { AcquireError, type AcquireInput } from "./Workspace.ts"
import type { ReviewWorkspaceShape } from "./WorkspaceObject.ts"

/** The workspace DO's raw namespace binding, as workerd hands it to the Worker. */
export interface WorkspaceNamespace {
  readonly getByName: (name: string) => {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
}

/**
 * How the run entity reaches its sandbox: `acquire` provisions the run's
 * workspace and only then hands back the executor, so a re-acquire never
 * builds a client against a container that isn't checked out yet.
 */
export class SandboxWorkspaces extends Context.Service<
  SandboxWorkspaces,
  {
    readonly acquire: (
      input: AcquireInput,
    ) => Effect.Effect<Layer.Layer<AgentExecutor.AgentExecutor>, AcquireError>
    readonly release: (runId: string) => Effect.Effect<void>
  }
>()("@janitor/cluster/PullRequestReview/Sandbox/SandboxWorkspaces") {
  /**
   * `stubs` is alchemy's typed namespace, for the `acquire` and `release`
   * RPC. `namespace` is the raw binding: alchemy's stub `fetch` drops POST
   * bodies, so executor RPC goes through the binding's own `fetch`.
   */
  static readonly layer = (options: {
    readonly stubs: { readonly getByName: (name: string) => ReviewWorkspaceShape }
    readonly namespace: WorkspaceNamespace
  }) =>
    Layer.succeed(SandboxWorkspaces, {
      acquire: (input) =>
        Effect.suspend(() =>
          options.stubs
            .getByName(input.runId)
            // Plain data across the RPC boundary.
            .acquire({
              ...input,
              startBudget: Duration.toMillis(Duration.fromInputUnsafe(input.startBudget)),
            }),
        ).pipe(
          // Failures cross the RPC boundary as plain objects.
          Effect.catch((error) =>
            Schema.decodeUnknownEffect(AcquireError)(error).pipe(
              Effect.orDie,
              Effect.flatMap(Effect.fail),
            ),
          ),
          Effect.as(executorLayer(options.namespace.getByName(input.runId))),
        ),
      release: (runId) => Effect.suspend(() => options.stubs.getByName(runId).release()),
    })
}

/**
 * clanka's executor over HTTP streaming to the workspace DO. The DO's fetch
 * is pinned inside this client only: the model's `HttpClient` keeps the
 * global fetch.
 */
const executorLayer = (workspace: {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}): Layer.Layer<AgentExecutor.AgentExecutor> => {
  const fetch: typeof globalThis.fetch = (input, init) => workspace.fetch(input, init)
  return AgentExecutor.layerRpc.pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url: "http://workspace/rpc",
        transformClient: HttpClient.transform((effect) =>
          Effect.provideService(effect, FetchHttpClient.Fetch, fetch),
        ),
      }),
    ),
    Layer.provide([RpcSerialization.layerNdjson, FetchHttpClient.layer]),
  )
}
