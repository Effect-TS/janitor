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
import { CHAT_GENERATION_HEADER, ChatAcquireError } from "./Workspace.ts"
import type { ChatWorkspaceShape } from "./WorkspaceObject.ts"

/** The workspace's fetch, with every executor call stamped with the turn's grant. */
const fenced = (
  workspace: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  generation: number,
) => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    request.headers.set(CHAT_GENERATION_HEADER, String(generation))
    return workspace.fetch(request)
  },
})

/** How often a queued turn asks the pool for its position. */
const POSITION_POLL = Duration.seconds(3)

/**
 * When a turn first asks for its position. Soon, so a short wait is still
 * reported, but after the pool has had a moment to queue the turn: both calls
 * go out together, and an answer from before the queueing would be empty.
 */
const FIRST_POSITION_POLL = Duration.millis(250)

/** What a turn holds: its sandbox's executor, and whether the sandbox is new. */
export interface ChatSandbox {
  /** Nothing from the session's earlier turns is in the sandbox. */
  readonly fresh: boolean
  /** The pool's grant, which `release` hands back. */
  readonly generation: number
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
      /** The turn, for the egress proxy's logs. */
      readonly turnId?: string | undefined
      readonly startBudget: Duration.Input
      readonly onQueued?: ((ahead: number) => Effect.Effect<void>) | undefined
    }) => Effect.Effect<ChatSandbox, SandboxBusy | ChatAcquireError>
    /** Ends the turn holding `generation`; a newer turn's sandbox is left alone. */
    readonly release: (sessionId: string, generation: number) => Effect.Effect<void>
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
        ({ sessionId, generation }) =>
          Effect.suspend(() =>
            options.workspaces.getByName(sessionId).destroy({ generation }),
          ).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Could not destroy a chat sandbox the pool let go of"),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )

    const release = (sessionId: string, generation: number) =>
      Effect.suspend(() => options.workspaces.getByName(sessionId).release({ generation })).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Could not refresh a released chat sandbox's warm window"),
        ),
        Effect.andThen(Effect.suspend(() => pool().release({ sessionId, generation }))),
        Effect.flatMap(({ destroy: released }) => destroy(released)),
      )

    /** Asks for the turn's queue position and passes each change on, until interrupted. */
    const watchQueue = (sessionId: string, onQueued: (ahead: number) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        let last: number | null = null
        yield* Effect.sleep(FIRST_POSITION_POLL)
        while (true) {
          const ahead = yield* Effect.suspend(() => pool().queuePosition({ sessionId })).pipe(
            Effect.orElseSucceed(() => null),
          )
          if (ahead !== null && ahead !== last) yield* onQueued(ahead)
          last = ahead
          yield* Effect.sleep(POSITION_POLL)
        }
      })

    return Layer.succeed(ChatSandboxes, {
      acquire: ({ sessionId, turnId, startBudget, onQueued }) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const config = yield* Effect.orDie(chatSandboxConfig)
            const watcher =
              onQueued === undefined
                ? undefined
                : yield* Effect.forkChild(watchQueue(sessionId, onQueued))
            const grant = yield* restore(Effect.suspend(() => pool().acquire({ sessionId }))).pipe(
              decodeFailure(SandboxBusy),
              Effect.ensuring(watcher === undefined ? Effect.void : Fiber.interrupt(watcher)),
            )
            const acquired = yield* restore(
              Effect.gen(function* () {
                yield* destroy(grant.destroy)
                return yield* Effect.suspend(() =>
                  options.workspaces.getByName(sessionId).acquire({
                    sessionId,
                    turnId,
                    fresh: grant.fresh,
                    generation: grant.generation,
                    multicaWorkspaceId: config.multicaWorkspaceId,
                    startBudget: Duration.toMillis(Duration.fromInputUnsafe(startBudget)),
                    warmFor: Duration.toMillis(config.warmFor),
                  }),
                ).pipe(decodeFailure(ChatAcquireError))
              }),
            ).pipe(
              // Failed, died or stopped before the turn got its sandbox: the grant goes
              // back to the pool, and the next turn finds no running container and starts one.
              Effect.onError(() => release(sessionId, grant.generation)),
            )
            return {
              fresh: grant.fresh || acquired.fresh,
              generation: grant.generation,
              executor: executorLayer(
                fenced(options.namespace.getByName(sessionId), grant.generation),
              ),
            }
          }),
        ).pipe(Effect.annotateLogs({ sessionId })),
      release,
    })
  }
}
