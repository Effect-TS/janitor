import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { PolicyVersionId } from "@janitor/domain/Labeling/Policy/Configuration"
import { type Condition } from "@janitor/domain/Labeling/Policy/Condition"
import { AiClassifier, classifyOrUnknown } from "../../src/Labeling/Classifier.ts"

it.effect("stops rejected and unresolved gates before classifier lookup or calls", () =>
  Effect.gen(function* () {
    const evaluator = {
      _tag: "Classifier" as const,
      prompt: "Read {{fact:title}}",
      evidence: ["title"] as const,
      minimumConfidence: 0.8,
    }
    const rejected: Condition = {
      _tag: "Fact",
      fact: "title",
      operator: "equals",
      value: "not this title",
      caseSensitive: false,
    }
    const unresolved: Condition = {
      _tag: "Collection",
      fact: "changedFiles",
      quantifier: "every",
      where: { _tag: "Fact", fact: "path", operator: "notEmpty" },
    }
    let calls = 0
    for (const appliesWhen of [rejected, unresolved]) {
      const input = {
        repositoryId: GitHubRepositoryDatabaseId.make("1"),
        number: 7446,
        policyVersionId: PolicyVersionId.make("gate-test"),
        program: { target: "pull_request" as const, appliesWhen, evaluator },
        evaluator,
        snapshot: {
          kind: "pull_request" as const,
          facts: { title: { _tag: "Text" as const, value: "Version Packages" } },
          unavailableReasons: { changedFiles: "Only 3000 of 3100 changed files available" },
        },
        resolve: () => undefined,
      }
      const expected = appliesWhen === rejected ? "not-applicable" : "unknown"
      const missingService = yield* classifyOrUnknown(input)
      assert.strictEqual(missingService.outcome, expected)
      const providedService = yield* classifyOrUnknown(input).pipe(
        Effect.provideService(AiClassifier, {
          classify: () =>
            Effect.sync(() => {
              calls++
              return { outcome: "match" as const, reason: "unexpected", trace: [] }
            }),
        }),
      )
      assert.strictEqual(providedService.outcome, expected)
      if (expected === "unknown")
        assert.strictEqual(
          providedService.reason,
          "Gate unresolved: Only 3000 of 3100 changed files available",
        )
    }
    assert.strictEqual(calls, 0)
  }),
)
