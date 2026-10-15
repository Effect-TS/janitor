import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { GitHubAppAuth } from "../../GitHub/AppAuth.ts"
import { mintSandboxToken } from "../GitHub.ts"
import { CheckoutOutcome, HeadShaMismatch, type CheckoutRequest } from "./Checkout.ts"
import { CONTAINER_PORT } from "./ContainerApp.ts"
import type { EgressProps } from "./Egress.ts"

/**
 * One run's sandbox, driven from its workspace Durable Object (EFF-1875,
 * EFF-1892). It uses workerd's `ctx.container` directly: alchemy's
 * `Containers.layer` starts the container on every construction, and a
 * reconstructed object must not restart anything.
 *
 * - `acquire` starts a fresh container without internet, holds it with an
 *   inactivity timeout, routes its HTTP and HTTPS egress to `GitEgress` with
 *   a fresh installation token, and checks out the pull request.
 * - `forward` passes executor RPC to the container's port as-is.
 * - `release` stops an acquire still in flight, then destroys the container,
 *   revokes the token, and leaves a marker in storage, so a later acquire on
 *   this run is refused even after the object is evicted.
 *
 * The token lives only in memory and in the intercepts' props. It is never
 * written to storage, logged, or put in an error.
 */

/** A Fetcher binding: the container's port, or a `ctx.exports` entrypoint. */
export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** The part of workerd's `ctx.container` the workspace drives. */
export interface WorkspaceContainer {
  readonly running: boolean
  start(options?: { readonly enableInternet?: boolean }): void
  monitor(): Promise<void>
  destroy(): Promise<void>
  getTcpPort(port: number): Fetcher
  setInactivityTimeout(durationMs: number): Promise<void>
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>
}

/** The part of the Durable Object's `ctx` the workspace uses. */
export interface WorkspaceState {
  readonly container: WorkspaceContainer
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
  }
  readonly exports: {
    readonly GitEgress: (options: { readonly props: EgressProps }) => Fetcher
  }
}

/**
 * What the run passes to `acquire`. It crosses Durable Object RPC, so it is
 * plain data: `startBudget` is milliseconds or a duration string.
 */
export interface AcquireInput {
  readonly runId: string
  readonly installationId: GitHubInstallationId | string
  /** The base repository's id, which the token is narrowed to. */
  readonly repositoryId: string
  /** The base repository. Fork pull requests are fetched from here too. */
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
  readonly baseSha: string
  /** The head SHA recorded at admission. */
  readonly headSha: string
  /** How long to keep retrying a start that found no container instance. */
  readonly startBudget: Duration.Input
}

/** No container could be started within the budget. */
export class ContainerUnavailable extends Schema.TaggedError<ContainerUnavailable>()(
  "ContainerUnavailable",
  { reason: Schema.String },
) {}

/** Every checkout attempt failed. The run ends without posting; the check run gives `reason`. */
export class CheckoutFailed extends Schema.TaggedError<CheckoutFailed>()("CheckoutFailed", {
  reason: Schema.String,
  attempts: Schema.Int,
}) {}

/** The run released this workspace; it can't be acquired again. */
export class WorkspaceReleased extends Schema.TaggedError<WorkspaceReleased>()(
  "WorkspaceReleased",
  {},
) {}

export { HeadShaMismatch }

export const AcquireError = Schema.Union([
  ContainerUnavailable,
  CheckoutFailed,
  HeadShaMismatch,
  WorkspaceReleased,
])
export type AcquireError = typeof AcquireError.Type

/** Bounds how long an orphaned container lives; `release` destroys it at run end. */
export const INACTIVITY_TIMEOUT = Duration.minutes(15)

/** Backoff between checkout attempts (EFF-1892 point 7). */
const CHECKOUT_RETRY_DELAYS = [Duration.seconds(5), Duration.seconds(15), Duration.seconds(30)]

const NO_INSTANCE = "no container instance"
const RELEASED_KEY = "released"
const HEALTH_POLL = Duration.millis(250)
const HEALTH_TIMEOUT = Duration.seconds(5)
const PROVISION_TIMEOUT = Duration.minutes(3)

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** A checkout attempt that may succeed if tried again. */
class AttemptFailed extends Schema.TaggedError<AttemptFailed>()("AttemptFailed", {
  reason: Schema.String,
}) {}

const decodeOutcome = Schema.decodeUnknownEffect(Schema.fromJsonString(CheckoutOutcome))

export const makeWorkspace = Effect.fnUntraced(function* (state: WorkspaceState) {
  const auth = yield* GitHubAppAuth
  const { container, storage } = state
  const lock = yield* Semaphore.make(1)
  let token: Redacted.Redacted<string> | undefined
  let released = false
  /** The acquire in flight, which `release` stops before cleaning up. */
  let acquiring: Fiber.Fiber<void, AcquireError> | undefined

  const promise = <A>(evaluate: () => Promise<A>) =>
    Effect.tryPromise({ try: evaluate, catch: message })

  const hold = promise(() =>
    container.setInactivityTimeout(Duration.toMillis(INACTIVITY_TIMEOUT)),
  ).pipe(
    Effect.catch((reason) =>
      Effect.logWarning("Could not set the sandbox inactivity timeout", reason),
    ),
  )

  // The runtime doesn't keep the timeout across object restarts.
  if (container.running) yield* hold

  const revoke = Effect.suspend(() => {
    const current = token
    token = undefined
    return current === undefined ? Effect.void : auth.revokeInstallationToken(current)
  }).pipe(
    Effect.catch((error) => Effect.logWarning("Could not revoke the sandbox token", error.message)),
  )

  const health = promise(() =>
    container.getTcpPort(CONTAINER_PORT).fetch("http://container/health"),
  ).pipe(
    Effect.timeoutOrElse({ duration: HEALTH_TIMEOUT, orElse: () => Effect.fail("timed out") }),
    Effect.map((response) => response.ok),
    Effect.orElseSucceed(() => false),
  )

  /** One `start()`: ready once `/health` answers, or the exit reason. */
  const startOnce = Effect.gen(function* () {
    let exit: string | undefined
    const thrown = yield* Effect.try({
      try: () => {
        container.start({ enableInternet: false })
        container.monitor().then(
          () => {
            exit = "the container exited"
          },
          (error: unknown) => {
            exit = message(error)
          },
        )
      },
      catch: message,
    }).pipe(Effect.match({ onFailure: (reason) => reason, onSuccess: () => undefined }))
    if (thrown !== undefined) return thrown
    while (true) {
      if (yield* health) return undefined
      if (exit !== undefined && !container.running) return exit
      yield* Effect.sleep(HEALTH_POLL)
    }
  })

  /** Starts the container, retrying "no container instance"; the budget bounds the whole startup. */
  const start = (budget: Duration.Duration) =>
    Effect.gen(function* () {
      if (container.running) yield* promise(() => container.destroy()).pipe(Effect.ignore)
      let reason = "the executor did not answer"
      yield* Effect.gen(function* () {
        for (let retry = 0; ; retry++) {
          const exit = yield* startOnce
          if (exit === undefined) return
          if (!exit.includes(NO_INSTANCE)) return yield* new ContainerUnavailable({ reason: exit })
          reason = exit
          yield* Effect.logInfo("No sandbox container instance yet; retrying")
          yield* Effect.sleep(Duration.min(Duration.seconds(2 ** retry), Duration.seconds(5)))
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: budget,
          orElse: () => Effect.fail(new ContainerUnavailable({ reason })),
        }),
      )
    })

  const ensureNotReleased = Effect.suspend(() =>
    released ? Effect.fail(new WorkspaceReleased()) : Effect.void,
  )

  /** Mints a token, points the intercepts at it, and runs one checkout. */
  const attempt = (input: AcquireInput) =>
    Effect.gen(function* () {
      yield* revoke
      // Minted and kept in one step: `release` can't stop it halfway and miss a token GitHub issued.
      const fresh = yield* mintSandboxToken({
        installationId: input.installationId as GitHubInstallationId,
        repositoryId: input.repositoryId,
      }).pipe(
        Effect.provideService(GitHubAppAuth, auth),
        Effect.tap((minted) =>
          Effect.sync(() => {
            token = minted
          }),
        ),
        Effect.uninterruptible,
        Effect.mapError((error) => new AttemptFailed({ reason: error.message })),
      )
      const egress = state.exports.GitEgress({
        props: {
          runId: input.runId,
          repo: `${input.owner}/${input.repo}`,
          prNumber: input.prNumber,
          token: Redacted.value(fresh),
        },
      })
      const register = promise(async () => {
        await container.interceptAllOutboundHttp(egress)
        await container.interceptOutboundHttps("*", egress)
      })
      yield* register.pipe(
        Effect.mapError((reason) => new AttemptFailed({ reason: `egress: ${reason}` })),
      )
      const request: CheckoutRequest = {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        baseSha: input.baseSha,
        headSha: input.headSha,
      }
      const body = yield* promise(async () => {
        const response = await container
          .getTcpPort(CONTAINER_PORT)
          .fetch("http://container/provision", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          })
        if (!response.ok) throw new Error(`provisioning answered ${response.status}`)
        return response.text()
      }).pipe(
        Effect.timeoutOrElse({
          duration: PROVISION_TIMEOUT,
          orElse: () => Effect.fail("provisioning timed out"),
        }),
        Effect.mapError((reason) => new AttemptFailed({ reason })),
      )
      const outcome = yield* decodeOutcome(body).pipe(
        Effect.mapError(() => new AttemptFailed({ reason: "unreadable provisioning answer" })),
      )
      switch (outcome._tag) {
        case "CheckedOut":
          return
        case "HeadShaMismatch":
          return yield* outcome
        case "GitCommandFailed":
          return yield* new AttemptFailed({
            reason: `git ${outcome.args[0] ?? ""} exited ${outcome.exitCode}: ${outcome.stderr.trim()}`,
          })
      }
    })

  const provision = (input: AcquireInput) =>
    Effect.gen(function* () {
      for (let retry = 0; ; retry++) {
        yield* ensureNotReleased
        const failure = yield* attempt(input).pipe(
          Effect.as(undefined),
          Effect.catchTag("AttemptFailed", (error) => Effect.succeed(error)),
        )
        if (failure === undefined) return
        const delay = CHECKOUT_RETRY_DELAYS[retry]
        if (delay === undefined) {
          return yield* new CheckoutFailed({ reason: failure.reason, attempts: retry + 1 })
        }
        yield* Effect.logWarning("Sandbox checkout failed; retrying", failure.reason)
        yield* Effect.sleep(delay)
      }
    })

  const acquire = (input: AcquireInput): Effect.Effect<void, AcquireError> =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          if (yield* promise(() => storage.get<boolean>(RELEASED_KEY)).pipe(Effect.orDie)) {
            released = true
          }
          yield* ensureNotReleased
          yield* start(Duration.fromInputUnsafe(input.startBudget))
          yield* hold
          yield* provision(input)
        }),
      )
      acquiring = fiber
      const exit = yield* Fiber.await(fiber)
      acquiring = undefined
      // Stopped by `release`, which cleans up after it.
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) && released) {
        return yield* new WorkspaceReleased()
      }
      return yield* exit
    }).pipe(Semaphore.withPermits(lock, 1))

  const forward = (request: Request): Effect.Effect<Response> =>
    Effect.suspend(() => {
      if (!container.running) {
        return Effect.succeed(
          new Response("the sandbox container is not running\n", { status: 503 }),
        )
      }
      const url = new URL(request.url)
      return promise(() =>
        container
          .getTcpPort(CONTAINER_PORT)
          .fetch(new Request(`http://container${url.pathname}${url.search}`, request)),
      ).pipe(
        Effect.catch((reason) =>
          Effect.succeed(
            new Response(`the sandbox container failed: ${reason}\n`, { status: 502 }),
          ),
        ),
      )
    })

  const release = Effect.gen(function* () {
    released = true
    if (acquiring !== undefined) yield* Fiber.interrupt(acquiring)
    yield* promise(() => storage.put(RELEASED_KEY, true)).pipe(Effect.orDie)
    if (container.running) {
      yield* promise(() => container.destroy()).pipe(
        Effect.catch((reason) =>
          Effect.logWarning("Could not destroy the sandbox container", reason),
        ),
      )
    }
    yield* revoke
  })

  return { acquire, forward, release } as const
})
