import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"

/**
 * The PR review model's way onto the tailnet (docs/pr-review.md): one
 * container, owned by the tailnet egress Durable Object, that joins the
 * tailnet and forwards HTTP to the model endpoint's origin. It uses workerd's
 * `ctx.container` directly, as the sandbox workspace does.
 *
 * - The first request starts the container and waits until it answers
 *   `/healthz`, which it does only once it has joined the tailnet. A start
 *   with no instance available yet is retried until the start budget runs out.
 * - Requests then go to its port with the same method, path, headers and
 *   body, and streamed responses pass through.
 * - A failure answers 503 with a fixed reason, never workerd's free text, so
 *   the model client reports it as a provider error and the agent retries.
 */

/** The part of workerd's `ctx.container` the egress drives. */
export interface EgressContainer {
  readonly running: boolean
  start(options?: { readonly enableInternet?: boolean }): void
  monitor(): Promise<void>
  destroy(): Promise<void>
  getTcpPort(port: number): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
  setInactivityTimeout(durationMs: number | bigint): Promise<void>
}

/** The port the container listens on. */
export const EGRESS_PORT = 8080

/** How long an idle container lives; the next request starts a new one. */
export const INACTIVITY_TIMEOUT = Duration.minutes(15)

/** Bounds a start, including the tailnet join, before requests fail. */
export const START_BUDGET = Duration.minutes(2)

const NO_INSTANCE = "no container instance"
const NOT_ATTACHED = "no container application assigned"
const HEALTH_POLL = Duration.millis(250)
const HEALTH_TIMEOUT = Duration.seconds(5)

/** workerd's start rejections, as fixed categories. */
const startFailure = (error: unknown): string => {
  if (error instanceof Error && error.message.includes(NO_INSTANCE)) return NO_INSTANCE
  if (error instanceof Error && error.message.includes(NOT_ATTACHED)) return NOT_ATTACHED
  return "the container failed"
}

/**
 * The request as the container's port takes it. The port speaks plain HTTP,
 * so the endpoint's `https://` URL becomes `http://container` with the same
 * path and query; the container sends it to its fixed upstream.
 */
export const toContainer = (request: Request): Request => {
  const url = new URL(request.url)
  return new Request(new URL(`${url.pathname}${url.search}`, "http://container"), request)
}

const unavailable = (reason: string) =>
  new Response(`the tailnet egress is unavailable: ${reason}\n`, { status: 503 })

export const makeTailnetEgress = Effect.fnUntraced(function* (
  container: EgressContainer,
  options?: { readonly startBudget?: Duration.Duration },
) {
  const lock = yield* Semaphore.make(1)
  const startBudget = options?.startBudget ?? START_BUDGET

  /** workerd's rejections are free text from outside janitor, so they're dropped, never logged. */
  const promise = <A>(evaluate: () => Promise<A>) =>
    Effect.tryPromise({ try: evaluate, catch: () => "rejected" as const })

  const health = promise(() =>
    container.getTcpPort(EGRESS_PORT).fetch("http://container/healthz"),
  ).pipe(
    Effect.timeoutOrElse({ duration: HEALTH_TIMEOUT, orElse: () => Effect.fail("timed out") }),
    Effect.map((response) => response.ok),
    Effect.orElseSucceed(() => false),
  )

  /** One `start()`: undefined once `/healthz` answers, or why it didn't. */
  const startOnce = Effect.gen(function* () {
    let exit: string | undefined
    const thrown = yield* Effect.try({
      try: () => {
        container.start({ enableInternet: true })
        container.monitor().then(
          () => {
            exit = "the container exited"
          },
          (error: unknown) => {
            exit = startFailure(error)
          },
        )
      },
      catch: startFailure,
    }).pipe(Effect.match({ onFailure: (reason) => reason, onSuccess: () => undefined }))
    if (thrown !== undefined) return thrown
    while (true) {
      if (yield* health) return undefined
      if (exit !== undefined && !container.running) return exit
      yield* Effect.sleep(HEALTH_POLL)
    }
  })

  /** Starts the container, retrying "no container instance" within the budget. */
  const start = Effect.gen(function* () {
    if (container.running) yield* promise(() => container.destroy()).pipe(Effect.ignore)
    for (let retry = 0; ; retry++) {
      const exit = yield* startOnce
      if (exit === undefined) break
      if (exit !== NO_INSTANCE) return exit
      yield* Effect.logInfo("No tailnet egress container instance yet; retrying")
      yield* Effect.sleep(Duration.min(Duration.seconds(2 ** retry), Duration.seconds(5)))
    }
    yield* promise(() =>
      container.setInactivityTimeout(Duration.toMillis(INACTIVITY_TIMEOUT)),
    ).pipe(
      Effect.catch(() => Effect.logWarning("Could not set the tailnet egress inactivity timeout")),
    )
    yield* Effect.logInfo("Tailnet egress started")
    return undefined
  }).pipe(
    Effect.timeoutOrElse({ duration: startBudget, orElse: () => Effect.succeed("timed out") }),
  )

  /** Undefined once the container answers; one caller starts it while the others wait. */
  const ready = lock.withPermits(1)(
    Effect.gen(function* () {
      if (container.running && (yield* health)) return undefined
      return yield* start
    }),
  )

  const forward = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const failure = yield* ready
      if (failure !== undefined) {
        yield* Effect.logWarning("The tailnet egress did not start").pipe(
          Effect.annotateLogs({ reason: failure }),
        )
        return unavailable(failure)
      }
      return yield* promise(() =>
        container.getTcpPort(EGRESS_PORT).fetch(toContainer(request)),
      ).pipe(
        Effect.catch(() =>
          Effect.as(
            Effect.logWarning("The tailnet egress container did not answer"),
            unavailable("the container did not answer"),
          ),
        ),
      )
    })

  return { forward }
})
