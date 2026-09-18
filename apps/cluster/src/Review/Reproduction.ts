import {
  ReproductionOutcome,
  type Reproduction,
  type TestAttempt,
} from "@janitor/domain/Review/Reproduction"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ObservedItem } from "./Conversation.ts"

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

/** Model interpretation must point to actual execution and inspected issue evidence. */
export const assessReproduction = (
  input: typeof AssessmentInput.Type,
  saved: Reproduction,
  baseCommit: string,
  observed: ReadonlyArray<ObservedItem>,
  repository: string,
) =>
  Effect.gen(function* () {
    const failures: Array<TestAttempt> = []
    const passes: Array<TestAttempt> = []
    const testNames = new Map<string, string>()
    for (const test of input.tests) {
      const attempt = saved.attempts.find((attempt) => attempt.id === test.attemptId)
      if (attempt === undefined || attempt.kind !== "test")
        return yield* Effect.fail("Assessment refers to an unrecorded test.")
      if (test.result === "setup_failure") continue
      if (
        !attempt.integrity ||
        attempt.limitation !== null ||
        attempt.exitCode === null ||
        saved.patch === null ||
        attempt.patchId !== saved.patch.id ||
        !saved.patch.files.some((file) => file.path === attempt.testPath)
      )
        return yield* Effect.fail(
          "Only an intact execution of the current validated test patch can confirm a result.",
        )
      if (!attempt.output.includes(test.testName) || !attempt.output.includes(test.outputExcerpt))
        return yield* Effect.fail("Test name and output excerpt must occur in the recorded output.")
      testNames.set(attempt.id, test.testName)
      if (test.result === "behavior_failure") {
        if (
          attempt.exitCode === 0 ||
          !/(?:AssertionError|ERR_ASSERTION|assertion[^\n]*failed|E\s+assert\b|expect\(received\)\.(?:not\.)?to\w+\(expected\))/i.test(
            test.outputExcerpt,
          )
        )
          return yield* Effect.fail(
            "A nonzero exit with assertion evidence is required; setup failures are inconclusive.",
          )
        failures.push(attempt)
      } else {
        if (attempt.exitCode !== 0) return yield* Effect.fail("A passing test must exit zero.")
        passes.push(attempt)
      }
    }
    if (
      input.outcome === "reproduced" &&
      !failures.some((attempt) => attempt.commitSha === baseCommit)
    )
      return yield* Effect.fail(
        "Reproduction requires a relevant assertion failure at the recorded default-branch commit.",
      )
    if (
      input.outcome === "not_reproduced" &&
      !passes.some((attempt) => attempt.commitSha === baseCommit)
    )
      return yield* Effect.fail(
        "Not reproduced requires a relevant passing test; otherwise report inconclusive.",
      )
    if (
      input.outcome === "confirmed_fixed" &&
      !failures.some(
        (failed) =>
          failed.commitSha !== baseCommit &&
          passes.some(
            (passed) =>
              passed.commitSha === baseCommit &&
              passed.command === failed.command &&
              passed.testPath === failed.testPath &&
              testNames.get(passed.id) === testNames.get(failed.id),
          ),
      )
    )
      return yield* Effect.fail(
        "Confirmed fixed requires the same relevant test and command failing on an affected revision and passing at the recorded default-branch commit. Otherwise use appears_fixed.",
      )
    if (
      ["appears_fixed", "inconclusive", "not_reproduced"].includes(input.outcome) &&
      input.unverified.trim() === ""
    )
      return yield* Effect.fail(
        "State what remains unverified; this does not establish absence of the bug.",
      )
    let duplicate = null
    if (input.duplicate !== null) {
      if (input.outcome !== "reproduced")
        return yield* Effect.fail("Only a reproduced proposal can be suppressed as redundant.")
      const proposed = input.duplicate
      const issue = [...observed]
        .reverse()
        .find(
          (item) =>
            item.number === proposed.issueNumber &&
            item.kind === "issue" &&
            item.body !== undefined,
        )
      if (
        issue === undefined ||
        ![
          proposed.sameBehavior,
          proposed.equivalentConditions,
          proposed.trackingEvidence,
          ...(proposed.adequateReproduction === null ? [] : [proposed.adequateReproduction]),
        ].every((excerpt) => issue.body!.includes(excerpt))
      )
        return yield* Effect.fail(
          "Suppression needs inspected issue excerpts showing the same behavior, materially equivalent conditions and tracking or an adequate reproduction.",
        )
      if (issue.state !== "open" && proposed.adequateReproduction === null)
        return yield* Effect.fail("A closed issue alone cannot suppress a reproduction proposal.")
      duplicate = {
        issueNumber: issue.number,
        url: `https://github.com/${repository}/issues/${issue.number}`,
        rationale:
          proposed.rationale +
          "\nSame behavior: " +
          proposed.sameBehavior +
          "\nEquivalent conditions: " +
          proposed.equivalentConditions +
          "\nTracking: " +
          proposed.trackingEvidence +
          (proposed.adequateReproduction === null
            ? ""
            : "\nExisting reproduction: " + proposed.adequateReproduction),
      }
    }
    return {
      outcome: input.outcome,
      rationale:
        input.rationale +
        input.tests
          .map((test) => `\n${test.attemptId}: ${test.relevance}\n${test.outputExcerpt}`)
          .join(""),
      unverified: input.unverified,
      attemptIds: input.tests.map((test) => test.attemptId),
      duplicate,
    }
  })
