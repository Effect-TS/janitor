import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import {
  ContainerNotAttached,
  ContainerUnavailable,
  makeContainerControl,
  promise,
  type Fetcher,
  type WorkspaceContainer,
} from "../../PullRequestReview/Sandbox/Container.ts"
import { CONTAINER_PORT } from "../../PullRequestReview/Sandbox/ContainerApp.ts"
import type { EgressProps } from "../../PullRequestReview/Sandbox/Egress.ts"
import { provisionRequest } from "./Provision.ts"

/**
 * One chat session's sandbox, driven from its workspace Durable Object
 * (EFF-3016). Unlike PR review's, it has no terminal release: the pool
 * decides how long a sandbox lives. Between turns the container keeps
 * running, until the pool destroys it or its inactivity timeout stops it.
 *
 * - `acquire` finds the session's warm container still running and
 *   provisions it again, or starts a fresh one without internet, routes its
 *   egress, and provisions it. Either way the container is held with the
 *   warm window as its inactivity timeout, so an abandoned sandbox stops on
 *   its own.
 * - `release` ends a turn and touches the container, so the warm window
 *   starts at the release.
 * - `destroy` stops the container: the pool evicted it, or its warm window
 *   ran out.
 * - `forward` passes executor RPC to the container's port as-is, but only
 *   from the grant the container is held under.
 *
 * Every call names the pool's grant generation, and the workspace keeps the
 * current one in storage: a call from an older grant changes nothing.
 */

/** The part of the Durable Object's `ctx` the workspace uses. */
export interface ChatWorkspaceState {
  readonly container: WorkspaceContainer
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
  }
  readonly exports: {
    readonly GitEgress: (options: { readonly props: EgressProps }) => Fetcher
  }
}

/** What a turn passes to `acquire`. Plain data, as it crosses Durable Object RPC. */
export interface ChatAcquireInput {
  readonly sessionId: string
  /** The pool kept no warm sandbox for the session: start a new container even if one runs. */
  readonly fresh: boolean
  /** The pool's generation for this grant; a destroy for an older one is ignored. */
  readonly generation: number
  /** The Multica workspace the sandbox's CLI acts in. */
  readonly multicaWorkspaceId: string
  /** How long to keep retrying a start that found no container instance, in milliseconds. */
  readonly startBudget: number
  /** The warm window, in milliseconds: the container's inactivity timeout. */
  readonly warmFor: number
}

/** Every provisioning attempt failed. */
export class ProvisionFailed extends Schema.TaggedError<ProvisionFailed>()("ProvisionFailed", {
  reason: Schema.String,
  attempts: Schema.Int,
}) {}

/**
 * A newer grant already acquired the workspace: this acquire arrived late,
 * after the pool had taken the sandbox over. The turn has no sandbox.
 */
export class GrantSuperseded extends Schema.TaggedError<GrantSuperseded>()("GrantSuperseded", {
  generation: Schema.Int,
  current: Schema.Int,
}) {}

export const ChatAcquireError = Schema.Union([
  ContainerUnavailable,
  ContainerNotAttached,
  ProvisionFailed,
  GrantSuperseded,
])
export type ChatAcquireError = typeof ChatAcquireError.Type

/** What `acquire` answers. */
export interface ChatAcquired {
  /** The container was started for this turn: nothing from earlier turns is in it. */
  readonly fresh: boolean
}

/** Backoff between provisioning attempts, as PR review's checkout. */
const PROVISION_RETRY_DELAYS = [Duration.seconds(5), Duration.seconds(15), Duration.seconds(30)]
const PROVISION_TIMEOUT = Duration.minutes(1)
const GENERATION_KEY = "generation"
const WARM_FOR_KEY = "warmFor"

/** The header executor calls carry their turn's grant generation in. */
export const CHAT_GENERATION_HEADER = "x-janitor-chat-generation"

export const makeChatWorkspace = Effect.fnUntraced(function* (state: ChatWorkspaceState) {
  const { container } = state
  const control = makeContainerControl(container)
  const lock = yield* Semaphore.make(1)
  /** The grant the container was last acquired under; kept in storage across restarts. */
  let current = yield* promise(() => state.storage.get<number>(GENERATION_KEY)).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  /** The warm window the last acquire asked for, in milliseconds; kept the same way. */
  let warmFor = yield* promise(() => state.storage.get<number>(WARM_FOR_KEY)).pipe(
    Effect.orElseSucceed(() => undefined),
  )

  /** Routes the container's egress, then posts one provisioning request. */
  const provisionOnce = (input: ChatAcquireInput) =>
    Effect.gen(function* () {
      // PR review's allowlist and nothing else, with no token, until the chat
      // egress proxy (EFF-3017) replaces it.
      const egress = state.exports.GitEgress({
        props: { runId: input.sessionId, repo: "", prNumber: 0, token: "" },
      })
      yield* promise(async () => {
        await container.interceptAllOutboundHttp(egress)
        await container.interceptOutboundHttps("*", egress)
      }).pipe(Effect.mapError(() => "registering the egress failed"))
      const status = yield* promise(async () => {
        const response = await container
          .getTcpPort(CONTAINER_PORT)
          .fetch("http://container/provision", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(provisionRequest(input.multicaWorkspaceId)),
          })
        return response.status
      }).pipe(
        Effect.mapError(() => "provisioning failed"),
        Effect.timeoutOrElse({
          duration: PROVISION_TIMEOUT,
          orElse: () => Effect.fail("provisioning timed out"),
        }),
      )
      if (status < 200 || status >= 300)
        return yield* Effect.fail(`provisioning answered ${status}`)
    })

  const provision = (input: ChatAcquireInput) =>
    Effect.gen(function* () {
      for (let retry = 0; ; retry++) {
        const failure = yield* provisionOnce(input).pipe(
          Effect.as(undefined),
          Effect.catch((reason) => Effect.succeed(reason)),
        )
        if (failure === undefined) return
        const delay = PROVISION_RETRY_DELAYS[retry]
        if (delay === undefined) {
          return yield* new ProvisionFailed({ reason: failure, attempts: retry + 1 })
        }
        yield* Effect.logWarning("Chat sandbox provisioning failed; retrying", failure)
        yield* Effect.sleep(delay)
      }
    })

  const acquire = (input: ChatAcquireInput): Effect.Effect<ChatAcquired, ChatAcquireError> =>
    Effect.gen(function* () {
      // Never move the fence back: a late acquire from an older grant would
      // let that turn in and shut the newer one out.
      if (current !== undefined && input.generation < current) {
        return yield* new GrantSuperseded({ generation: input.generation, current })
      }
      current = input.generation
      warmFor = input.warmFor
      yield* promise(async () => {
        await state.storage.put(GENERATION_KEY, input.generation)
        await state.storage.put(WARM_FOR_KEY, input.warmFor)
      }).pipe(Effect.orDie)
      const warm = !input.fresh && container.running && (yield* control.health)
      if (!warm) yield* control.start(Duration.millis(input.startBudget))
      yield* control.hold(Duration.millis(input.warmFor))
      yield* provision(input)
      return { fresh: !warm }
    }).pipe(Effect.annotateLogs({ sessionId: input.sessionId }), Semaphore.withPermits(lock, 1))

  /** Stops the container, unless a grant newer than `generation` acquired it since. */
  const destroy = (generation: number) =>
    Effect.suspend(() =>
      current !== undefined && generation < current ? Effect.void : control.destroy,
    ).pipe(Semaphore.withPermits(lock, 1))

  /**
   * The turn holding `generation` ended. The container's inactivity clock
   * counts from its last request, which may be long before the release if
   * the model was quiet, so the release sends one: the warm window then
   * starts here, as the pool's does.
   */
  const release = (generation: number) =>
    Effect.gen(function* () {
      if (generation !== current || !container.running) return
      yield* control.health
      if (warmFor !== undefined) yield* control.hold(Duration.millis(warmFor))
    }).pipe(Semaphore.withPermits(lock, 1))

  /**
   * Passes executor RPC to the container, if it comes from the grant the
   * container is held under. A turn whose grant was taken over gets 409 on
   * its next call instead of running against the newer turn's sandbox.
   */
  const forward = (request: Request): Effect.Effect<Response> =>
    Effect.suspend(() =>
      current !== undefined && request.headers.get(CHAT_GENERATION_HEADER) !== String(current)
        ? Effect.succeed(
            new Response("the chat sandbox is held by a newer turn\n", { status: 409 }),
          )
        : control.forward(request),
    )

  return { acquire, release, destroy, forward } as const
})
