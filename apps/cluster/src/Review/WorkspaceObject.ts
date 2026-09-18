import { Sandbox } from "@janitor/alchemy/AI/Sandbox"
import {
  layerContainer,
  layerContainerSession,
} from "@janitor/alchemy/Cloudflare/AI/SandboxContainer"
import * as Cloudflare from "alchemy/Cloudflare"
import { DurableObjectState } from "alchemy/Cloudflare/Workers"
import { ALCHEMY_PHASE } from "alchemy/Phase"
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
    return Effect.sync(() => {
      const workspace = makeReviewWorkspace(sandbox)
      return {
        provision: workspace.provision,
        execute: workspace.execute,
        status: () => workspace.status,
        listFiles: workspace.listFiles,
        readFile: (path, offset, limit) =>
          workspace.readFile(path, { offset: offset ?? undefined, limit: limit ?? undefined }),
        search: (pattern, path) => workspace.search(pattern, path ?? undefined),
        release: () =>
          workspace.release.pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                // Destroy also stops background children and work from a prior object instance.
                const state = yield* Effect.serviceOption(DurableObjectState)
                if (Option.isSome(state) && state.value.container !== undefined)
                  yield* Effect.promise(() => state.value.container!.destroy())
              }),
            ),
          ),
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
