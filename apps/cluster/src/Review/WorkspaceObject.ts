import { Sandbox } from "@janitor/alchemy/AI/Sandbox"
import {
  layerContainer,
  layerContainerSession,
} from "@janitor/alchemy/Cloudflare/AI/ReviewSandboxContainer"
import * as Cloudflare from "alchemy/Cloudflare"
import { DurableObjectState } from "alchemy/Cloudflare/Workers"
import { ALCHEMY_PHASE } from "alchemy/Phase"
import * as Deferred from "effect/Deferred"
import * as Semaphore from "effect/Semaphore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  makeReviewWorkspace,
  type ExecutionRequest,
  type ProvisionOutcome,
  type ProvisionRequest,
  ReviewWorkspaces,
  type WorkspaceStatus,
} from "./Workspace.ts"

/**
 * The production workspace: one Durable Object per run owning one sandbox
 * container, like a Slack session's. The container starts on the first
 * workspace call, holds the checkout for the run's lifetime, and is
 * ephemeral: a replaced container reports the workspace absent, which the
 * agent records as an interrupted run.
 */

export interface ReviewWorkspaceObjectShape {
  readonly provision: (request: ProvisionRequest) => Effect.Effect<ProvisionOutcome, string>
  readonly status: () => Effect.Effect<WorkspaceStatus, string>
  readonly listFiles: (path: string) => Effect.Effect<string, string>
  readonly readFile: (
    path: string,
    offset: number | null,
    limit: number | null,
  ) => Effect.Effect<string, string>
  readonly search: (pattern: string, path: string | null) => Effect.Effect<string, string>
  readonly execute: (
    request: ExecutionRequest,
  ) => ReturnType<import("./Workspace.ts").ReviewWorkspace["execute"]>
  readonly release: () => Effect.Effect<void, string>
}

export class ReviewWorkspaceObject extends Cloudflare.DurableObject<
  ReviewWorkspaceObject,
  ReviewWorkspaceObjectShape
>()("ReviewWorkspace") {}

export const ReviewWorkspaceObjectLive = ReviewWorkspaceObject.make(
  Effect.gen(function* () {
    // Container attachment must be discovered while Alchemy plans this namespace.
    // Runtime construction stays lazy so an idle object does not start a guest.
    if ((yield* ALCHEMY_PHASE) === "plan") {
      yield* Sandbox.pipe(Effect.provide(layerContainer({ enableInternet: true })))
    }
    const sandbox = yield* Sandbox.pipe(
      Effect.provide(layerContainerSession({ enableInternet: true })),
    )
    const lock = yield* Semaphore.make(1)
    const stopped = yield* Deferred.make<never, string>()
    return Effect.sync(() => {
      const workspace = makeReviewWorkspace(sandbox)
      const guard = <A>(operation: Effect.Effect<A, string>) =>
        Effect.gen(function* () {
          const state = yield* Effect.serviceOption(DurableObjectState)
          if (
            Option.isSome(state) &&
            (yield* Effect.promise(() => state.value.raw.storage.get<boolean>("released")))
          )
            return yield* Effect.fail("Review workspace released.")
          return yield* operation
        }).pipe(Effect.raceFirst(Deferred.await(stopped)), Semaphore.withPermits(lock, 1))
      return {
        provision: (request) => guard(workspace.provision(request)),
        execute: (request) => guard(workspace.execute(request)),
        status: () => guard(workspace.status),
        listFiles: (path) => guard(workspace.listFiles(path)),
        readFile: (path, offset, limit) =>
          guard(
            workspace.readFile(path, { offset: offset ?? undefined, limit: limit ?? undefined }),
          ),
        search: (pattern, path) => guard(workspace.search(pattern, path ?? undefined)),
        release: () =>
          Effect.gen(function* () {
            const state = yield* Effect.serviceOption(DurableObjectState)
            // This marker survives object eviction and container replacement. Set it
            // before interrupting work so a delayed call cannot recreate the checkout.
            if (Option.isSome(state))
              yield* Effect.promise(() => state.value.raw.storage.put("released", true))
            yield* Deferred.fail(stopped, "Review workspace released.")
            yield* (
              Option.isSome(state) && state.value.container !== undefined
                ? Effect.promise(() => state.value.container!.destroy())
                : workspace.release
            ).pipe(Semaphore.withPermits(lock, 1))
          }),
      } satisfies ReviewWorkspaceObjectShape
    })
  }),
)

/** Workspaces reached through the bound namespace, one object per run. */
export const layerWorkspaceObjects = (objects: {
  readonly getByName: (name: string) => ReviewWorkspaceObjectShape
}) =>
  Layer.succeed(ReviewWorkspaces, {
    open: (runId) => {
      const stub = objects.getByName(runId)
      return {
        provision: (request) => stub.provision(request),
        execute: (request) => stub.execute(request),
        status: Effect.suspend(() => stub.status()),
        listFiles: (path) => stub.listFiles(path),
        readFile: (path, options) =>
          stub.readFile(path, options?.offset ?? null, options?.limit ?? null),
        search: (pattern, path) => stub.search(pattern, path ?? null),
        release: Effect.suspend(() => stub.release()),
      }
    },
  })
