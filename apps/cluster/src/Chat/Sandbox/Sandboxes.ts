import type * as AgentExecutor from "clanka/AgentExecutor"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  executorLayer,
  type WorkspaceNamespace,
} from "../../PullRequestReview/Sandbox/WorkspaceClient.ts"
import { chatSandboxConfig } from "../Config.ts"
import { SandboxBusy } from "./Pool.ts"
import { POOL_NAME, type ChatSandboxPoolShape, type PoolRelease } from "./PoolObject.ts"
import { ChatAcquireError } from "./Workspace.ts"
import type { ChatWorkspaceShape } from "./WorkspaceObject.ts"

/** How often a queued turn asks the pool for its position. */
const POSITION_POLL = Duration.seconds(3)

/** What a turn holds: its sandbox's executor, and whether the sandbox is new. */
export interface ChatSandbox {
  /** Nothing from the session's earlier turns is in the sandbox. */
  readonly fresh: boolean
  readonly executor: Layer.Layer<AgentExecutor.AgentExecutor>
}

/** Errors cross Durable Object RPC as plain objects; this turns them back into classes. */
const decodeFailure =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, S["Type"], R> =>
    effect.pipe(
      Effect.catch((error) =>
        Schema.decodeUnknownEffect(schema)(error).pipe(Effect.orDie, Effect.flatMap(Effect.fail)),
      ),
    )

/**
 * How a chat turn reaches its sandbox (EFF-3016): the pool grants the
 * session a sandbox, queueing if the pool is full, and the session's
 * workspace starts or reuses its container. `release` ends the turn and
 * leaves the sandbox warm.
 */
export class ChatSandboxes extends Context.Service<
  ChatSandboxes,
  {
    /**
     * `onQueued` hears how many turns are ahead while the turn waits for a
     * sandbox. `startBudget` bounds a container start that finds no instance.
     */
    readonly acquire: (input: {
      readonly sessionId: string
      readonly startBudget: Duration.Input
      readonly onQueued?: ((ahead: number) => Effect.Effect<void>) | undefined
    }) => Effect.Effect<ChatSandbox, SandboxBusy | ChatAcquireError>
    readonly release: (sessionId: string) => Effect.Effect<void>
  }
>()("@janitor/cluster/Chat/Sandbox/ChatSandboxes") {
  /**
   * `pools` and `workspaces` are alchemy's typed namespaces, for RPC.
   * `namespace` is the workspace's raw binding: alchemy's stub `fetch` drops
   * POST bodies, so executor RPC goes through the binding's own `fetch`.
   */
  static readonly layer = (options: {
    readonly pools: { readonly getByName: (name: string) => ChatSandboxPoolShape }
    readonly workspaces: { readonly getByName: (name: string) => ChatWorkspaceShape }
    readonly namespace: WorkspaceNamespace
  }) => {
    const pool = () => options.pools.getByName(POOL_NAME)

    const destroy = (released: ReadonlyArray<PoolRelease>) =>
      Effect.forEach(
        released,
        ({ sessionId, lease }) =>
          Effect.suspend(() => options.workspaces.getByName(sessionId).destroy({ lease })).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Could not destroy a chat sandbox the pool let go of"),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )

    const release = (sessionId: string) =>
      Effect.suspend(() => pool().release({ sessionId })).pipe(
        Effect.flatMap(({ destroy: released }) => destroy(released)),
      )

    /** Asks for the turn's queue position and passes each change on, until interrupted. */
    const watchQueue = (sessionId: string, onQueued: (ahead: number) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        let last: number | null = null
        while (true) {
          yield* Effect.sleep(POSITION_POLL)
          const ahead = yield* Effect.suspend(() => pool().queuePosition({ sessionId })).pipe(
            Effect.orElseSucceed(() => null),
          )
          if (ahead !== null && ahead !== last) yield* onQueued(ahead)
          last = ahead
        }
      })

    return Layer.succeed(ChatSandboxes, {
      acquire: ({ sessionId, startBudget, onQueued }) =>
        Effect.gen(function* () {
          const config = yield* Effect.orDie(chatSandboxConfig)
          const watcher =
            onQueued === undefined
              ? undefined
              : yield* Effect.forkChild(watchQueue(sessionId, onQueued))
          const grant = yield* Effect.suspend(() => pool().acquire({ sessionId })).pipe(
            decodeFailure(SandboxBusy),
            Effect.ensuring(watcher === undefined ? Effect.void : Fiber.interrupt(watcher)),
          )
          yield* destroy(grant.destroy)
          const acquired = yield* Effect.suspend(() =>
            options.workspaces.getByName(sessionId).acquire({
              sessionId,
              fresh: grant.fresh,
              lease: grant.lease,
              multicaWorkspaceId: config.multicaWorkspaceId,
              startBudget: Duration.toMillis(Duration.fromInputUnsafe(startBudget)),
              warmFor: Duration.toMillis(config.warmFor),
            }),
          ).pipe(
            decodeFailure(ChatAcquireError),
            // The slot goes back to the pool; the next turn finds no running container and starts one.
            Effect.tapError(() => release(sessionId)),
          )
          return {
            fresh: grant.fresh || acquired.fresh,
            executor: executorLayer(options.namespace.getByName(sessionId)),
          }
        }).pipe(Effect.annotateLogs({ sessionId })),
      release,
    })
  }
}
