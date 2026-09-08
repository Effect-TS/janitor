import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { LabelingOverview } from "../../src/Labeling/Overview.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { actor, baseMain, bug, feature, repositoryId, seed, Services } from "./support.ts"

const OverviewServices = LabelingOverview.layer.pipe(Layer.provideMerge(Services))

layer(OverviewServices, { timeout: "2 minutes" })("Repository overview counts", (it) => {
  it.effect("counts policies and rules independently, including drafts and disabled rules", () =>
    Effect.gen(function* () {
      yield* seed
      const overview = yield* LabelingOverview
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const counts = Effect.map(overview.repositories, (repositories) => {
        const repository = repositories.find((entry) => entry.repositoryId === repositoryId)
        return [repository?.ruleCount, repository?.policyCount]
      })
      assert.deepStrictEqual(yield* counts, [0, 0])

      const first = yield* policies.create(
        repositoryId,
        { name: "Main branch", description: "", source: baseMain },
        actor,
      )
      yield* policies.create(
        repositoryId,
        { name: "Unpublished draft", description: "", source: baseMain },
        actor,
      )
      yield* policies.publish(repositoryId, first.policy.policyId, first.policy.version, actor)
      assert.deepStrictEqual(yield* counts, [0, 2])

      for (const labelId of [bug, feature]) {
        yield* rules.create(
          repositoryId,
          {
            labelId,
            policyId: first.policy.policyId,
            onNoMatch: "ensure-absent",
            group: null,
            priority: 0,
            enabled: labelId === bug,
          },
          actor,
        )
      }
      // Joining both one-to-many tables directly would inflate these to four.
      assert.deepStrictEqual(yield* counts, [2, 2])
    }),
  )
})
