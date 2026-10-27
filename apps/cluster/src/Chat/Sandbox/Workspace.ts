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
 *   provisions it again, or starts a fresh one without internet, routes its egress, and
 *   provisions it. Either way the container is held with the warm window as
 *   its inactivity timeout, so an abandoned sandbox stops on its own.
 * - `destroy` stops the container: the pool evicted it, or its warm window
 *   ran out.
 * - `forward` passes executor RPC to the container's port as-is.
 */

/** The part of the Durable Object's `ctx` the workspace uses. */
export interface ChatWorkspaceState {
  readonly container: WorkspaceContainer
  readonly exports: {
    readonly GitEgress: (options: { readonly props: EgressProps }) => Fetcher
  }
}

/** What a turn passes to `acquire`. Plain data, as it crosses Durable Object RPC. */
export interface ChatAcquireInput {
  readonly sessionId: string
  /** The pool kept no warm sandbox for the session: start a new container even if one runs. */
  readonly fresh: boolean
  /** The pool's stamp for this grant; a destroy under an older one is ignored. */
  readonly lease: number
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

export const ChatAcquireError = Schema.Union([
  ContainerUnavailable,
  ContainerNotAttached,
  ProvisionFailed,
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

export const makeChatWorkspace = Effect.fnUntraced(function* (state: ChatWorkspaceState) {
  const { container } = state
  const control = makeContainerControl(container)
  const lock = yield* Semaphore.make(1)
  /** The grant the container was last acquired under; unknown after the object restarts. */
  let currentLease: number | undefined

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
      currentLease = input.lease
      const warm = !input.fresh && container.running && (yield* control.health)
      if (!warm) yield* control.start(Duration.millis(input.startBudget))
      yield* control.hold(Duration.millis(input.warmFor))
      yield* provision(input)
      return { fresh: !warm }
    }).pipe(Effect.annotateLogs({ sessionId: input.sessionId }), Semaphore.withPermits(lock, 1))

  /** Stops the container, unless a newer grant than `lease` acquired it since. */
  const destroy = (lease: number | null) =>
    Effect.suspend(() =>
      lease !== null && currentLease !== undefined && lease < currentLease
        ? Effect.void
        : control.destroy,
    ).pipe(Semaphore.withPermits(lock, 1))

  return { acquire, destroy, forward: control.forward } as const
})
