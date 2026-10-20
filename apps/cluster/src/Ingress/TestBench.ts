import { JanitorApi } from "@janitor/domain/Api"
import { PolicyInvalid, RuleTestNotFound } from "@janitor/domain/Labeling/Policy/Configuration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiError from "effect/http-api/HttpApiError"
import { Policies } from "../Labeling/Policies.ts"
import { RuleTestJobs } from "../Labeling/RuleTestJob.ts"
import { LabelingTest } from "../Labeling/Test.ts"

/**
 * The test bench. The services fail with the domain errors each endpoint
 * declares; their infrastructure failures die.
 */
export const TestBenchGroupLayer = HttpApiBuilder.group(JanitorApi, "testBench", (handlers) =>
  handlers
    .handle("listItems", ({ params }) =>
      LabelingTest.use((test) => test.items(params.repositoryId)).pipe(
        Effect.catchTags({ LabelingConfigurationError: Effect.die, LabelingTestError: Effect.die }),
      ),
    )
    .handle("run", ({ params, payload }) =>
      LabelingTest.use((test) => test.run(params.repositoryId, payload)).pipe(
        Effect.catchTags({ LabelingConfigurationError: Effect.die, LabelingTestError: Effect.die }),
      ),
    )
    .handle("startRuleTest", ({ params, payload }) =>
      Effect.gen(function* () {
        // A rule test evaluates one item against a draft or a published policy.
        if (payload.numbers?.length !== 1 || payload.subject._tag === "Configuration")
          return yield* new HttpApiError.BadRequest()
        if (payload.subject._tag === "Draft") {
          const validation = yield* (yield* Policies).validate(
            params.repositoryId,
            payload.subject.source,
            Option.none(),
          )
          if (validation._tag === "Invalid")
            return yield* new PolicyInvalid({ diagnostic: validation.message })
        }
        return yield* (yield* RuleTestJobs).enqueue(params.repositoryId, payload)
      }),
    )
    .handle("getRuleTest", ({ params }) =>
      Effect.gen(function* () {
        const job = yield* (yield* RuleTestJobs).get(params.repositoryId, params.testId)
        return job ?? (yield* new RuleTestNotFound({ testId: params.testId }))
      }),
    )
    .handle("getRuleTestInput", ({ params }) =>
      Effect.gen(function* () {
        // The input snapshot is gone once the test expires.
        const job = yield* (yield* RuleTestJobs).get(params.repositoryId, params.testId, true)
        const details =
          job?.response?._tag === "Evaluated"
            ? job.response.entities[0]?.evaluation?.inputDetails
            : undefined
        return details ?? (yield* new RuleTestNotFound({ testId: params.testId }))
      }),
    ),
)
