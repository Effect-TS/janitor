import * as Cloudflare from "alchemy/Cloudflare"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { promise } from "../../PullRequestReview/Sandbox/Container.ts"
import { chatSandboxConfig } from "../Config.ts"
import { makeSandboxPool, SandboxRecord, type SandboxBusy } from "./Pool.ts"

/**
 * The chat sandbox pool's Durable Object: one instance, named `POOL_NAME`,
 * holding the pool for every session. It doesn't reach the workspaces itself:
 * each answer names the sessions whose sandboxes the caller must destroy.
 *
 * `acquire` stays open while the turn is queued, which keeps the object
 * alive; the sandboxes are kept in storage for the stretches when no call
 * is open.
 */

export const POOL_NAME = "pool"

/**
 * A sandbox the pool let go of. `lease` is the grant it was let go under,
 * when the pool still knows it, so the workspace can ignore a destroy that
 * arrives after a newer grant.
 */
export interface PoolRelease {
  readonly sessionId: string
  readonly lease: number | null
}

/** A sandbox granted to a turn, and the sandboxes the pool let go of meanwhile. */
export interface PoolGrant {
  readonly fresh: boolean
  /** Stamps this grant: when it was made, in epoch milliseconds. */
  readonly lease: number
  readonly destroy: ReadonlyArray<PoolRelease>
}

export interface ChatSandboxPoolShape {
  readonly acquire: (input: { readonly sessionId: string }) => Effect.Effect<PoolGrant, SandboxBusy>
  readonly release: (input: {
    readonly sessionId: string
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

const SANDBOXES_KEY = "sandboxes"

const decodeRecords = Schema.decodeUnknownEffect(Schema.Array(SandboxRecord))

export const ChatSandboxPoolLive = ChatSandboxPool.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const storage = state.raw.storage as unknown as PoolStorage
      const config = yield* Effect.orDie(chatSandboxConfig)
      const destroyed: Array<PoolRelease> = []
      const leases = new Map<string, number>()
      const positions = new Map<string, number>()
      const drain = Effect.sync(() => destroyed.splice(0))

      const pool = yield* makeSandboxPool({
        capacity: config.maxInstances,
        warmFor: config.warmFor,
        queueTimeout: config.queueTimeout,
        destroy: (sessionId) =>
          Effect.sync(() => {
            destroyed.push({ sessionId, lease: leases.get(sessionId) ?? null })
            leases.delete(sessionId)
          }),
        storage: {
          load: promise(() => storage.get<unknown>(SANDBOXES_KEY)).pipe(
            Effect.flatMap((stored) =>
              stored === undefined ? Effect.succeed([]) : decodeRecords(stored),
            ),
            // A record that no longer decodes is dropped: the pool starts empty, and
            // each container's inactivity timeout stops what it forgot.
            Effect.orElseSucceed(() => []),
          ),
          save: (records) => promise(() => storage.put(SANDBOXES_KEY, records)).pipe(Effect.orDie),
        },
      })

      return {
        acquire: ({ sessionId }: { readonly sessionId: string }) =>
          pool
            .acquire(sessionId, (ahead) => Effect.sync(() => positions.set(sessionId, ahead)))
            .pipe(
              Effect.ensuring(Effect.sync(() => positions.delete(sessionId))),
              Effect.flatMap((granted) =>
                Effect.map(Clock.currentTimeMillis, (lease) => {
                  leases.set(sessionId, lease)
                  // Evicted earlier and granted again before anyone destroyed it:
                  // its fresh start replaces the old container instead.
                  const pending = destroyed.findIndex((entry) => entry.sessionId === sessionId)
                  if (pending !== -1) destroyed.splice(pending, 1)
                  return { fresh: granted.fresh, lease, destroy: destroyed.splice(0) }
                }),
              ),
            ),
        release: ({ sessionId }: { readonly sessionId: string }) =>
          pool.release(sessionId).pipe(
            Effect.andThen(drain),
            Effect.map((destroy) => ({ destroy })),
          ),
        queuePosition: ({ sessionId }: { readonly sessionId: string }) =>
          Effect.sync(() => positions.get(sessionId) ?? null),
      }
    })
  }),
)
