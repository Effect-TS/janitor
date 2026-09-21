import {
  ReproductionOutcome,
  type ReproductionAssessment,
} from "@janitor/domain/Review/Reproduction"
import * as Schema from "effect/Schema"

const Explanation = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))
export const AssessmentInput = Schema.Struct({
  outcome: ReproductionOutcome,
  rationale: Explanation,
  unverified: Schema.String.check(Schema.isMaxLength(4000)),
  tests: Schema.Array(
    Schema.Struct({
      attemptId: Schema.String,
      result: Schema.Literals(["behavior_failure", "passed", "setup_failure"]),
      testName: Explanation,
      outputExcerpt: Explanation,
      relevance: Explanation,
    }),
  ).check(Schema.isMaxLength(10)),
  duplicate: Schema.NullOr(
    Schema.Struct({
      issueNumber: Schema.Int,
      sameBehavior: Explanation,
      equivalentConditions: Explanation,
      trackingEvidence: Explanation,
      adequateReproduction: Schema.NullOr(Explanation),
      rationale: Explanation,
    }),
  ),
})

/** Record the model's interpretation for human review without judging its evidence. */
export const recordReproductionAssessment = (
  input: typeof AssessmentInput.Type,
  repository: string,
): ReproductionAssessment => ({
  outcome: input.outcome,
  rationale:
    input.rationale +
    input.tests
      .map((test) => `\n${test.attemptId}: ${test.relevance}\n${test.outputExcerpt}`)
      .join(""),
  unverified: input.unverified,
  attemptIds: input.tests.map((test) => test.attemptId),
  duplicate:
    input.duplicate === null
      ? null
      : {
          issueNumber: input.duplicate.issueNumber,
          url: `https://github.com/${repository}/issues/${input.duplicate.issueNumber}`,
          rationale:
            input.duplicate.rationale +
            "\nSame behavior: " +
            input.duplicate.sameBehavior +
            "\nEquivalent conditions: " +
            input.duplicate.equivalentConditions +
            "\nTracking: " +
            input.duplicate.trackingEvidence +
            (input.duplicate.adequateReproduction === null
              ? ""
              : "\nExisting reproduction: " + input.duplicate.adequateReproduction),
        },
})
