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
import { classifyAi } from "./Classifier.ts"

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
  const outcomes = new Map<RuleId, Evaluation["outcome"]>()
  const evaluations: Array<RuleEvaluation> = []
  for (const rule of configuration.rules) {
    if (!rule.enabled) continue
    const version = versions.get(rule.policyVersionId)
    const evaluation: Evaluation =
      version === undefined
        ? { outcome: "unknown", reason: "policy version is missing", trace: [] }
        : version.program.evaluator._tag === "Classifier"
          ? yield* classifyAi({
              inspectInput: input.inspectInput ?? false,
              repositoryId: configuration.repositoryId,
              number,
              policyVersionId: version.versionId,
              rule,
              program: version.program,
              evaluator: version.program.evaluator,
              snapshot: facts,
              resolve,
            })
          : evaluate({ program: version.program, snapshot: facts, resolve })
    outcomes.set(rule.id, evaluation.outcome)
    evaluations.push({ ruleId: rule.id, policyVersionId: rule.policyVersionId, evaluation })
  }
  return {
    evaluations,
    plan: plan({ rules: configuration.rules, outcomes, currentLabels }),
  }
})
