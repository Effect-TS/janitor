import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CONTAINER_PORT } from "./ContainerApp.ts"

/**
 * Driving a sandbox container from the Durable Object that owns it, shared by
 * the PR review and chat workspaces. It uses workerd's `ctx.container`
 * directly: alchemy's `Containers.layer` starts the container on every
 * construction, and a reconstructed object must not restart anything.
 */

/** A Fetcher binding: the container's port, or a `ctx.exports` entrypoint. */
export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** The part of workerd's `ctx.container` the workspaces drive. */
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

/** No container could be started within the budget. */
export class ContainerUnavailable extends Schema.TaggedError<ContainerUnavailable>()(
  "ContainerUnavailable",
  { reason: Schema.String },
) {}

/**
 * The workspace's Durable Object namespace has no container application, as
 * after a deploy that failed partway. No retry can help, only a deploy.
 */
export class ContainerNotAttached extends Schema.TaggedError<ContainerNotAttached>()(
  "ContainerNotAttached",
  {},
) {}

const NO_INSTANCE = "no container instance"
const NOT_ATTACHED = "no container application assigned"
const HEALTH_POLL = Duration.millis(250)
const HEALTH_TIMEOUT = Duration.seconds(5)

/** The two start rejections janitor acts on, as fixed categories; any other is just a failed start. */
const startFailure = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined
  if (error.message.includes(NO_INSTANCE)) return NO_INSTANCE
  if (error.message.includes(NOT_ATTACHED)) return NOT_ATTACHED
  return undefined
}

/** workerd's rejections are free text from outside janitor, so they're dropped, never logged. */
export const promise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: () => "rejected" as const })

export const makeContainerControl = (container: WorkspaceContainer) => {
  /** Sets how long the container may go without a request before the runtime stops it. */
  const hold = (inactivityTimeout: Duration.Duration) =>
    promise(() => container.setInactivityTimeout(Duration.toMillis(inactivityTimeout))).pipe(
      Effect.catch(() => Effect.logWarning("Could not set the sandbox inactivity timeout")),
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
            exit = startFailure(error) ?? "the container failed"
          },
        )
      },
      catch: (error) => startFailure(error) ?? "the container did not start",
    }).pipe(Effect.match({ onFailure: (reason) => reason, onSuccess: () => undefined }))
    if (thrown !== undefined) return thrown
    while (true) {
      if (yield* health) return undefined
      if (exit !== undefined && !container.running) return exit
      yield* Effect.sleep(HEALTH_POLL)
    }
  })

  /**
   * Starts a fresh container, destroying any running one first, and retries
   * "no container instance"; the budget bounds the whole startup.
   */
  const start = (budget: Duration.Duration) =>
    Effect.gen(function* () {
      if (container.running) yield* promise(() => container.destroy()).pipe(Effect.ignore)
      let reason = "the executor did not answer"
      yield* Effect.gen(function* () {
        for (let retry = 0; ; retry++) {
          const exit = yield* startOnce
          if (exit === undefined) return
          if (exit === NOT_ATTACHED) return yield* new ContainerNotAttached()
          if (exit !== NO_INSTANCE) return yield* new ContainerUnavailable({ reason: exit })
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

  /** Passes a request to the container's port as-is. */
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

  const destroy = Effect.suspend(() =>
    container.running
      ? promise(() => container.destroy()).pipe(
          Effect.catch(() => Effect.logWarning("Could not destroy the sandbox container")),
        )
      : Effect.void,
  )

  return { hold, health, start, forward, destroy } as const
}
