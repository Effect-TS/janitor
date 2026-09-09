import { TestPayloadCipher } from "../support/PayloadCipher.ts"
import * as Context from "effect/Context"
import { assert, layer } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubTransport } from "../../src/GitHub/Transport.ts"
import { RepositoryConnections } from "../../src/RepositoryConnections.ts"
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  baseMain,
  bug,
  LabelingLayer,
  repositoryId,
  seedReady as seed,
  seedPullRequests,
  seq,
  verifyTrack,
} from "./support.ts"

class WriteControl extends Context.Service<
  WriteControl,
  { started: Deferred.Deferred<void>; release: Deferred.Deferred<void>; order: Array<string> }
>()("WriteControl") {}

const Services = Layer.mergeAll(ReconcileEntityLayer, RepositoryConnections.layer).pipe(
  Layer.provideMerge(TestPayloadCipher),
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)
const ready = Effect.gen(function* () {
  const targets = yield* SyncTargets
  const scope = { _tag: "Entity", repositoryId, number: 5 } as const
  const { generation } = yield* targets.invalidate({
    scope,
    sequence: Option.some(seq),
    webhookReceivedAt: new Date(),
  })
  yield* targets.begin(scope, generation)
  yield* targets.complete({
    scope,
    generation,
    outcome: { _tag: "Verified", watermark: Option.none() },
  })
  const published = yield* (yield* SnapshotHandoff).publish({
    repositoryId,
    number: 5,
    generation,
    sequence: seq,
  })
  assert.strictEqual(published._tag, "Published")
  if (published._tag !== "Published") return yield* Effect.die("Expected a qualified snapshot")
  return published.identity
})

layer(
  Layer.unwrap(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const order: Array<string> = []
      return Services.pipe(
        Layer.provideMerge(
          Layer.succeed(GitHubTransport, {
            request: (request) =>
              Effect.gen(function* () {
                if (request.method !== "GET") {
                  order.push("label-started")
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                  order.push("label-finished")
                }
                return {
                  _tag: "Ok" as const,
                  status: 200,
                  body: request.url.startsWith("/app/installations/")
                    ? {
                        id: 77,
                        account: { id: 1, login: "effect", type: "Organization" },
                        repository_selection: "all",
                        html_url: "https://github.com/settings/installations/77",
                        suspended_at: null,
                        permissions: {
                          metadata: "read",
                          issues: "write",
                          pull_requests: "read",
                          checks: "read",
                        },
                      }
                    : { id: 701 },
                  etag: Option.none(),
                  link: Option.none(),
                  requestId: Option.none(),
                }
              }),
          }),
        ),
        Layer.provideMerge(Layer.succeed(WriteControl, { started, release, order })),
      )
    }),
  ),
  { timeout: "2 minutes" },
)("Label writes across repository pause", (it) => {
  it.effect(
    "fences queued labels and drains an active GitHub write before pause takes effect",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        const policies = yield* Policies
        const rules = yield* LabelingRules
        const connections = yield* RepositoryConnections
        const control = yield* WriteControl
        const draft = yield* policies.create(
          repositoryId,
          { name: "Main", description: "", source: baseMain },
          actor,
        )
        yield* policies.publish(repositoryId, draft.policy.policyId, draft.policy.version, actor)
        yield* rules.create(
          repositoryId,
          {
            policyId: draft.policy.policyId,
            labelId: bug,
            onMatch: "ensure-present",
            onNoMatch: "no-action",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const queued = yield* ready
        const configuration = yield* rules.list(repositoryId)
        yield* connections.change(repositoryId, "pause", actor)
        yield* ReconcileEntity.execute(queued)
        assert.deepStrictEqual(control.order, [])
        assert.deepStrictEqual(yield* rules.list(repositoryId), configuration)
        yield* connections.change(repositoryId, "resume", actor)
        yield* ReconcileEntity.execute(queued)
        assert.deepStrictEqual(control.order, [])

        for (const track of ["labels", "entities", "pull_requests"] as const)
          yield* verifyTrack(track)
        const current = yield* ready
        const applying = yield* ReconcileEntity.execute(current).pipe(Effect.forkChild)
        yield* Deferred.await(control.started)
        const pause = yield* connections.change(repositoryId, "pause", actor).pipe(
          Effect.tap(() => Effect.sync(() => control.order.push("paused"))),
          Effect.forkChild,
        )
        yield* Deferred.succeed(control.release, undefined)
        yield* Fiber.join(applying)
        yield* Fiber.join(pause)
        assert.deepStrictEqual(control.order, ["label-started", "label-finished", "paused"])
        assert.isFalse((yield* connections.inventory).repositories[0]!.enabled)
        assert.deepStrictEqual(yield* rules.list(repositoryId), configuration)
      }),
  )
})
