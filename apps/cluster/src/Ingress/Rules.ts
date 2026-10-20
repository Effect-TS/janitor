import { JanitorApi } from "@janitor/domain/Api"
import { inspectAiRule } from "@janitor/domain/Labeling/Policy/AiRule"
import { type CreateRuleRequest, RuleNotFound } from "@janitor/domain/Labeling/Policy/Configuration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { LabelingConfiguration } from "../Labeling/Configuration.ts"
import { LabelingRules, type NewRule } from "../Labeling/Rules.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"

const actor = Effect.map(CurrentAccessIdentity, (identity) => ({
  issuer: identity.issuer,
  subject: identity.subject,
}))

/** The legacy defaults for the keys a create request may omit. */
const withDefaults = (request: CreateRuleRequest): NewRule => ({
  ...request,
  onMatch: request.onMatch ?? "ensure-present",
  onNoMatch: request.onNoMatch ?? "no-action",
  group: request.group ?? null,
  priority: request.priority ?? 0,
  enabled: request.enabled ?? true,
})

/**
 * A repository's labeling rules. The service fails with the domain errors
 * each endpoint declares; its infrastructure failures die.
 */
export const RulesGroupLayer = HttpApiBuilder.group(JanitorApi, "rules", (handlers) =>
  handlers
    .handle("list", ({ params }) => LabelingRules.use((rules) => rules.list(params.repositoryId)))
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const rules = yield* (yield* LabelingRules).list(params.repositoryId)
        const rule = rules.find((candidate) => candidate.id === params.ruleId)
        return rule ?? (yield* new RuleNotFound({ ruleId: params.ruleId }))
      }),
    )
    .handle("create", ({ params, payload }) =>
      Effect.gen(function* () {
        const rules = yield* LabelingRules
        return yield* rules.create(params.repositoryId, withDefaults(payload), yield* actor)
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const rules = yield* LabelingRules
        return yield* rules.patch(params.repositoryId, params.ruleId, payload, yield* actor)
      }),
    )
    .handle("delete", ({ params, query }) =>
      Effect.gen(function* () {
        const rules = yield* LabelingRules
        yield* rules.remove(params.repositoryId, params.ruleId, query.version, yield* actor)
      }),
    )
    .handle("reorder", ({ params, payload }) =>
      Effect.gen(function* () {
        const rules = yield* LabelingRules
        return yield* rules.reorder(params.repositoryId, payload, yield* actor)
      }),
    )
    .handle("validate", ({ params, payload }) =>
      LabelingConfiguration.use((configuration) =>
        configuration.requireRepository(params.repositoryId),
      ).pipe(
        Effect.catchTag("LabelingConfigurationError", Effect.die),
        Effect.as(inspectAiRule(payload)),
      ),
    ),
)
