import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

/**
 * The chat sandbox pool (EFF-3016): at most `capacity` sandboxes, one per
 * chat session, shared by every platform.
 *
 * - A turn acquires its session's sandbox and releases it when the turn
 *   ends. A released sandbox stays warm for `warmFor`: a turn of the same
 *   session that acquires within that window gets it back as it was. After
 *   the window the sandbox is destroyed, and the next turn starts on a
 *   fresh one.
 * - A turn that finds the pool full destroys the warm sandbox that has been
 *   idle longest. If every sandbox is running a turn, it waits in one
 *   first-come queue, told how many turns are ahead of it whenever that
 *   changes, and gives up as busy after `queueTimeout`.
 *
 * Expired sandboxes are destroyed when the pool next acquires or releases;
 * the container's own inactivity timeout stops it at the same time.
 */

/** Every sandbox was running a turn for the whole queue timeout. */
export class SandboxBusy extends Schema.TaggedError<SandboxBusy>()("SandboxBusy", {}) {}

/** What a turn holds while it runs. */
export interface Lease {
  /** No warm sandbox was kept for the session: its clones and edits are gone. */
  readonly fresh: boolean
}

/** One session's sandbox, as the pool keeps it. */
export const SandboxRecord = Schema.Struct({
  sessionId: Schema.String,
  running: Schema.Boolean,
  /** Epoch milliseconds of the release that made it idle; 0 while running. */
  idleSince: Schema.Finite,
})
export type SandboxRecord = typeof SandboxRecord.Type

export interface SandboxPoolOptions {
  /** `CHAT_SANDBOX_MAX_INSTANCES`. */
  readonly capacity: number
  /** `CHAT_SANDBOX_WARM_SECONDS`. */
  readonly warmFor: Duration.Duration
  /** `CHAT_QUEUE_TIMEOUT_SECONDS`. */
  readonly queueTimeout: Duration.Duration
  /** Destroys a session's sandbox container: evicted, or its warm window ran out. */
  readonly destroy: (sessionId: string) => Effect.Effect<void>
  /**
   * Keeps the sandboxes across restarts of whatever hosts the pool. The
   * queue isn't kept: its turns are waiting on the host, which stays up
   * while they do.
   */
  readonly storage?:
    | {
        readonly load: Effect.Effect<ReadonlyArray<SandboxRecord>>
        readonly save: (records: ReadonlyArray<SandboxRecord>) => Effect.Effect<void>
      }
    | undefined
}

export interface SandboxPool {
  /**
   * Waits for a sandbox for the session's turn. While queued, `onQueued` gets
   * the number of turns ahead, first when the turn joins the queue and again
   * each time that number changes.
   */
  readonly acquire: (
    sessionId: string,
    onQueued?: (ahead: number) => Effect.Effect<void>,
  ) => Effect.Effect<Lease, SandboxBusy>
  /** The session's turn ended; its sandbox stays warm. */
  readonly release: (sessionId: string) => Effect.Effect<void>
}

interface Sandbox {
  running: boolean
  idleSince: number
}

interface Waiter {
  readonly sessionId: string
  readonly granted: Deferred.Deferred<Lease>
  readonly onQueued: ((ahead: number) => Effect.Effect<void>) | undefined
  /** The position `onQueued` last heard. */
  ahead: number
}

export const makeSandboxPool = (options: SandboxPoolOptions): Effect.Effect<SandboxPool> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    const locked = Semaphore.withPermits(lock, 1)
    const warmFor = Duration.toMillis(options.warmFor)
    const sandboxes = new Map<string, Sandbox>()
    const queue: Array<Waiter> = []

    for (const record of options.storage === undefined ? [] : yield* options.storage.load) {
      sandboxes.set(record.sessionId, { running: record.running, idleSince: record.idleSince })
    }

    const save = Effect.suspend(() =>
      options.storage === undefined
        ? Effect.void
        : options.storage.save(
            Array.from(sandboxes, ([sessionId, { running, idleSince }]) => ({
              sessionId,
              running,
              idleSince,
            })),
          ),
    )

    const destroy = (sessionId: string) =>
      Effect.suspend(() => {
        sandboxes.delete(sessionId)
        return options.destroy(sessionId)
      })

    /** Destroys the sandboxes whose warm window ran out. */
    const expire = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      for (const [sessionId, sandbox] of Array.from(sandboxes)) {
        if (!sandbox.running && now - sandbox.idleSince >= warmFor) yield* destroy(sessionId)
      }
    })

    /** The session's warm sandbox, a free slot, or the longest-idle sandbox's slot; none if all are running. */
    const take = (sessionId: string) =>
      Effect.gen(function* () {
        const warm = sandboxes.get(sessionId)
        if (warm !== undefined) {
          warm.running = true
          return { fresh: false } satisfies Lease
        }
        if (sandboxes.size >= options.capacity) {
          let idlest: string | undefined
          for (const [id, sandbox] of sandboxes) {
            if (sandbox.running) continue
            if (idlest === undefined || sandbox.idleSince < sandboxes.get(idlest)!.idleSince) {
              idlest = id
            }
          }
          if (idlest === undefined) return undefined
          yield* destroy(idlest)
        }
        sandboxes.set(sessionId, { running: true, idleSince: 0 })
        return { fresh: true } satisfies Lease
      })

    /** Tells each waiter whose position changed. */
    const announce = Effect.suspend(() =>
      Effect.forEach(
        queue.slice(),
        (waiter, ahead) => {
          if (waiter.ahead === ahead) return Effect.void
          waiter.ahead = ahead
          return waiter.onQueued?.(ahead) ?? Effect.void
        },
        { discard: true },
      ),
    )

    /** Hands freed sandboxes to the queue, first come, first served. */
    const serve = Effect.gen(function* () {
      while (queue.length > 0) {
        const lease = yield* take(queue[0]!.sessionId)
        if (lease === undefined) break
        yield* Deferred.succeed(queue.shift()!.granted, lease)
      }
      yield* announce
    })

    /** Takes a waiter out of the queue: busy, unless it was granted a sandbox in the meantime. */
    const leave = (waiter: Waiter) =>
      locked(
        Effect.gen(function* () {
          if (yield* Deferred.isDone(waiter.granted)) return yield* Deferred.await(waiter.granted)
          queue.splice(queue.indexOf(waiter), 1)
          yield* announce
          return yield* new SandboxBusy()
        }),
      )

    const release = (sessionId: string) =>
      locked(
        Effect.gen(function* () {
          const sandbox = sandboxes.get(sessionId)
          if (sandbox !== undefined && sandbox.running) {
            sandbox.running = false
            sandbox.idleSince = yield* Clock.currentTimeMillis
          }
          yield* expire
          yield* serve
          yield* save
        }),
      )

    const acquire = (
      sessionId: string,
      onQueued?: (ahead: number) => Effect.Effect<void>,
    ): Effect.Effect<Lease, SandboxBusy> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const taken = yield* locked(
            Effect.gen(function* () {
              yield* expire
              const lease = queue.length === 0 ? yield* take(sessionId) : undefined
              yield* save
              if (lease !== undefined) return lease
              const waiter: Waiter = {
                sessionId,
                granted: yield* Deferred.make<Lease>(),
                onQueued,
                ahead: queue.length,
              }
              queue.push(waiter)
              yield* onQueued?.(waiter.ahead) ?? Effect.void
              return waiter
            }),
          )
          if (!("granted" in taken)) return taken
          return yield* restore(Deferred.await(taken.granted)).pipe(
            Effect.timeoutOrElse({ duration: options.queueTimeout, orElse: () => leave(taken) }),
            // A turn stopped while queued gives back whatever it was granted.
            Effect.onInterrupt(() =>
              leave(taken).pipe(
                Effect.matchEffect({
                  onFailure: () => Effect.void,
                  onSuccess: () => release(sessionId),
                }),
              ),
            ),
          )
        }),
      )

    return { acquire, release } satisfies SandboxPool
  })
