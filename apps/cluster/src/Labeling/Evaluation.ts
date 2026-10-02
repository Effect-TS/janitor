import type { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import type {
  ConfigurationSnapshot,
  PolicyVersionId,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { evaluate, type Resolver } from "@janitor/domain/Labeling/Policy/Evaluate"
import type { FactSnapshot } from "@janitor/domain/Labeling/Policy/Facts"
import { plan, type RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import type { Evaluation } from "@janitor/domain/Labeling/Policy/Program"
import * as Effect from "effect/Effect"
import { classifyAiMany } from "./Classifier.ts"

export interface RuleEvaluation {
  readonly ruleId: RuleId
  readonly policyVersionId: PolicyVersionId
  readonly evaluation: Evaluation
}

/** Evaluate one item's loaded configuration. The caller owns retry context and recording. */
export const evaluateLabeling = Effect.fn("Labeling.evaluateLabeling")(function* (input: {
  readonly configuration: ConfigurationSnapshot
  readonly number: number
  readonly facts: FactSnapshot
  readonly currentLabels: ReadonlySet<GitHubLabelDatabaseId>
  readonly inspectInput?: boolean
}) {
  const { configuration, number, facts, currentLabels } = input
  const versions = new Map(configuration.versions.map((version) => [version.versionId, version]))
  const byPolicy = new Map(configuration.versions.map((version) => [version.policyId, version]))
  const resolve: Resolver = (policyId) => byPolicy.get(policyId)
  const enabled = configuration.rules.filter((rule) => rule.enabled)
  // An item's AI rules share their provider requests, so they are classified together.
  const classified = enabled.flatMap((rule) => {
    const version = versions.get(rule.policyVersionId)
    return version?.program.evaluator._tag === "Classifier"
      ? [
          {
            rule,
            input: {
              inspectInput: input.inspectInput ?? false,
              repositoryId: configuration.repositoryId,
              number,
              policyVersionId: version.versionId,
              rule,
              program: version.program,
              evaluator: version.program.evaluator,
              snapshot: facts,
              resolve,
            },
          },
        ]
      : []
  })
  const answers = yield* classifyAiMany(classified.map(({ input }) => input))
  const classifications = new Map(classified.map(({ rule }, i) => [rule.id, answers[i]!]))
  const evaluations = enabled.map((rule): RuleEvaluation => {
    const version = versions.get(rule.policyVersionId)
    const evaluation: Evaluation =
      version === undefined
        ? { outcome: "unknown", reason: "policy version is missing", trace: [] }
        : (classifications.get(rule.id) ??
          evaluate({ program: version.program, snapshot: facts, resolve }))
    return { ruleId: rule.id, policyVersionId: rule.policyVersionId, evaluation }
  })
  const outcomes = new Map<RuleId, Evaluation["outcome"]>(
    evaluations.map(({ ruleId, evaluation }) => [ruleId, evaluation.outcome]),
  )
  return {
    evaluations,
    plan: plan({ rules: configuration.rules, outcomes, currentLabels }),
  }
})
