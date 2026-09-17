import { TestPayloadCipher } from "../support/PayloadCipher.ts"
import { assert, layer } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { RepositoryConnections } from "../../src/RepositoryConnections.ts"
import { LabelItem } from "../../src/Labeling/DirectLabeling.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  admit,
  baseMain,
  bug,
  DirectLabelingLayer,
  github,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
} from "./support.ts"

const Services = Layer.mergeAll(DirectLabelingLayer, RepositoryConnections.layer).pipe(
  Layer.provideMerge(TestPayloadCipher),
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(Services, { timeout: "2 minutes" })("Label writes across repository pause", (it) => {
  it.effect(
    "fences queued labels and drains an active GitHub write before pause takes effect",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        const policies = yield* Policies
        const rules = yield* LabelingRules
        const connections = yield* RepositoryConnections
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const order: Array<string> = []
        github.intercept = (request) =>
          request.method === "GET"
            ? Effect.succeed(undefined)
            : Effect.gen(function* () {
                order.push("label-started")
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                order.push("label-finished")
                return undefined
              })
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
        const queued = yield* admit(5)
        const configuration = yield* rules.list(repositoryId)
        yield* connections.change(repositoryId, "pause", actor)
        assert.strictEqual((yield* LabelItem.execute(queued)).outcome, "not-qualified")
        assert.deepStrictEqual(order, [])
        assert.deepStrictEqual(yield* rules.list(repositoryId), configuration)
        yield* connections.change(repositoryId, "resume", actor)
        // Resumption does not revive work accepted before the pause.
        assert.strictEqual((yield* LabelItem.execute(queued)).outcome, "not-qualified")
        assert.deepStrictEqual(order, [])

        const current = yield* admit(5)
        const applying = yield* LabelItem.execute(current).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const pause = yield* connections.change(repositoryId, "pause", actor).pipe(
          Effect.tap(() => Effect.sync(() => order.push("paused"))),
          Effect.forkChild,
        )
        yield* Deferred.succeed(release, undefined)
        assert.strictEqual((yield* Fiber.join(applying)).outcome, "evaluated")
        yield* Fiber.join(pause)
        assert.deepStrictEqual(order, ["label-started", "label-finished", "paused"])
        assert.isFalse((yield* connections.inventory).repositories[0]!.enabled)
        assert.deepStrictEqual(yield* rules.list(repositoryId), configuration)
        assert.deepStrictEqual(
          github.issues.get(5)!.labels.map((label) => label.name),
          ["bug"],
        )
      }),
  )
})
