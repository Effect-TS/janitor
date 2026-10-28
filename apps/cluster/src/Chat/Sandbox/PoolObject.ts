import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { promise } from "../../PullRequestReview/Sandbox/Container.ts"
import { chatSandboxConfig } from "../Config.ts"
import { makeSandboxPool, PoolSnapshot, type SandboxBusy } from "./Pool.ts"

/**
 * The chat sandbox pool's Durable Object: one instance, named `POOL_NAME`,
 * holding the pool for every session. It doesn't reach the workspaces itself:
 * each answer names the sessions whose sandboxes the caller must destroy.
 *
 * `acquire` stays open while the turn is queued, which keeps the object
 * alive; the sandboxes and the last generation are kept in storage for the
 * stretches when no call is open.
 */

export const POOL_NAME = "pool"

/** A sandbox the pool let go of, and the grant it was last held under. */
export interface PoolRelease {
  readonly sessionId: string
  readonly generation: number
}

/** A sandbox granted to a turn, and the sandboxes the pool let go of meanwhile. */
export interface PoolGrant {
  readonly fresh: boolean
  readonly generation: number
  readonly destroy: ReadonlyArray<PoolRelease>
}

export interface ChatSandboxPoolShape {
  readonly acquire: (input: { readonly sessionId: string }) => Effect.Effect<PoolGrant, SandboxBusy>
  readonly release: (input: {
    readonly sessionId: string
    readonly generation: number
  }) => Effect.Effect<{ readonly destroy: ReadonlyArray<PoolRelease> }>
  /** How many turns are ahead of the session's queued turn; null when it isn't queued. */
  readonly queuePosition: (input: { readonly sessionId: string }) => Effect.Effect<number | null>
}

export class ChatSandboxPool extends Cloudflare.DurableObject<
  ChatSandboxPool,
  ChatSandboxPoolShape
>()("ChatSandboxPool") {}

/** The part of the Durable Object's storage the pool uses. */
interface PoolStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

const SNAPSHOT_KEY = "pool"

const decodeSnapshot = Schema.decodeUnknownEffect(PoolSnapshot)

export const ChatSandboxPoolLive = ChatSandboxPool.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const storage = state.raw.storage as unknown as PoolStorage
      const config = yield* Effect.orDie(chatSandboxConfig)
      const destroyed: Array<PoolRelease> = []
      const positions = new Map<string, number>()
      const drain = Effect.sync(() => destroyed.splice(0))

      const pool = yield* makeSandboxPool({
        capacity: config.maxInstances,
        warmFor: config.warmFor,
        queueTimeout: config.queueTimeout,
        abandonAfter: config.abandonAfter,
        destroy: (sessionId, generation) =>
          Effect.sync(() => {
            destroyed.push({ sessionId, generation })
          }),
        storage: {
          load: promise(() => storage.get<unknown>(SNAPSHOT_KEY)).pipe(
            Effect.flatMap((stored) =>
              stored === undefined ? Effect.succeed(undefined) : decodeSnapshot(stored),
            ),
            // A snapshot that no longer decodes is dropped: the pool starts empty, and
            // each container's inactivity timeout stops what it forgot.
            Effect.orElseSucceed(() => undefined),
          ),
          save: (snapshot) => promise(() => storage.put(SNAPSHOT_KEY, snapshot)).pipe(Effect.orDie),
        },
      })

      return {
        acquire: ({ sessionId }: { readonly sessionId: string }) =>
          pool
            .acquire(sessionId, (ahead) => Effect.sync(() => positions.set(sessionId, ahead)))
            .pipe(
              Effect.ensuring(Effect.sync(() => positions.delete(sessionId))),
              Effect.flatMap((lease) =>
                Effect.map(drain, (destroy) => ({
                  fresh: lease.fresh,
                  generation: lease.generation,
                  destroy,
                })),
              ),
            ),
        release: ({
          sessionId,
          generation,
        }: {
          readonly sessionId: string
          readonly generation: number
        }) =>
          pool.release(sessionId, generation).pipe(
            Effect.andThen(drain),
            Effect.map((destroy) => ({ destroy })),
          ),
        queuePosition: ({ sessionId }: { readonly sessionId: string }) =>
          Effect.sync(() => positions.get(sessionId) ?? null),
      }
    })
  }),
)
