import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
} from "../../src/Labeling/Classifier.ts"
import { activityPage } from "../../src/Labeling/Activity.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
  DirectLabelingLayer,
  github,
  label,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
} from "./support.ts"

let requests = 0
const services = DirectLabelingLayer.pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(
    Layer.succeed(ClassifierProvider, {
      identity: { provider: "test", model: "test" },
      ask: (prompt) =>
        Effect.sync(() => {
          requests++
          return {
            matches: prompt.includes("Change 5"),
            confidence: 0.95,
            reason: "Accepted answer",
          }
        }),
    }),
  ),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(services, { timeout: "2 minutes" })("Configured AI label actions", (it) => {
  it.effect(
    "uses the same reversed and no-action rules in testing, automatic labeling, and activity",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* seedPullRequests
        requests = 0
        github.issues.get(5)!.labels = [{ id: 11, name: "bug" }]
        const rules = yield* LabelingRules
        const rule = yield* rules.create(
          repositoryId,
          {
            ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
            labelId: bug,
            onMatch: "ensure-absent",
            onNoMatch: "ensure-present",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        )
        const test = yield* LabelingTest
        const blocked = yield* test.run(repositoryId, {
          subject: { _tag: "Configuration" },
          numbers: [5, 6],
        })
        assert.strictEqual(blocked._tag, "Evaluated")
        if (blocked._tag !== "Evaluated") return
        assert.deepStrictEqual(
          blocked.entities.map((entity) => entity.plan?.actions),
          [[], []],
        )
        assert.deepStrictEqual(github.writes, [])
        yield* (yield* AiConsentService).set(repositoryId, true, actor)
        const preview = yield* test.run(repositoryId, {
          subject: { _tag: "Configuration" },
          numbers: [5, 6],
        })
        assert.strictEqual(preview._tag, "Evaluated")
        if (preview._tag !== "Evaluated") return
        assert.isTrue(preview.entities.every((entity) => entity.evaluation === null))
        assert.strictEqual(requests, 2)
        assert.deepStrictEqual(
          preview.entities.map((entity) => entity.plan?.actions),
          [
            [{ ruleId: rule.id, labelId: bug, action: "remove" }],
            [{ ruleId: rule.id, labelId: bug, action: "add" }],
          ],
        )
        assert.deepStrictEqual(github.writes, [])
        for (const entity of preview.entities) {
          const result = yield* label(entity.number)
          assert.deepStrictEqual(result.plan, entity.plan)
        }
        // Automatic labeling reuses the configured answers populated by the preview.
        assert.strictEqual(requests, 2)
        assert.deepStrictEqual(
          github.writes.map((request) => request.method),
          ["DELETE", "POST"],
        )
        const activity = yield* activityPage(repositoryId, {
          search: "",
          target: "all",
          cursor: null,
        })
        assert.deepStrictEqual(
          activity.entries
            .flatMap((entry) =>
              entry.actions.map((action) => [entry.number, action.action, action.status]),
            )
            .sort(),
          [
            [5, "remove", "applied"],
            [6, "add", "applied"],
          ],
        )
        yield* rules.patch(
          repositoryId,
          rule.id,
          { version: rule.version, onMatch: "no-action", onNoMatch: "no-action" },
          actor,
        )
        assert.strictEqual(github.writes.length, 2)
        const inactive = yield* test.run(repositoryId, {
          subject: { _tag: "Configuration" },
          numbers: [5, 6],
        })
        assert.strictEqual(inactive._tag, "Evaluated")
        if (inactive._tag !== "Evaluated") return
        assert.deepStrictEqual(
          inactive.entities.map((entity) => entity.plan?.actions),
          [[], []],
        )
        for (const number of [5, 6])
          assert.deepStrictEqual((yield* label(number)).plan?.actions, [])
        assert.strictEqual(github.writes.length, 2)
        const history = yield* activityPage(repositoryId, {
          search: "",
          target: "all",
          cursor: null,
        })
        assert.deepStrictEqual(
          history.entries.slice(0, 2).map((entry) => entry.plan?.rules[0]?.requestedAction),
          ["no-action", "no-action"],
        )
      }),
  )
})
