import * as Schema from "effect/Schema"

export const ValidatedPatch = Schema.Struct({
  id: Schema.String,
  baseCommit: Schema.String,
  diff: Schema.String,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, content: Schema.String, rationale: Schema.String }),
  ),
})
export type ValidatedPatch = typeof ValidatedPatch.Type
export const TestAttempt = Schema.Struct({
  id: Schema.String,
  patchId: Schema.NullOr(Schema.String),
  commitSha: Schema.String,
  kind: Schema.Literals(["setup", "test"]),
  command: Schema.String,
  testPath: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
  truncated: Schema.Boolean,
  integrity: Schema.Boolean,
  limitation: Schema.NullOr(Schema.String),
})
export type TestAttempt = typeof TestAttempt.Type
export const ReproductionOutcome = Schema.Literals([
  "reproduced",
  "not_reproduced",
  "inconclusive",
  "appears_fixed",
  "confirmed_fixed",
])

export const ReproductionAssessment = Schema.Struct({
  outcome: ReproductionOutcome,
  rationale: Schema.String,
  unverified: Schema.String,
  attemptIds: Schema.Array(Schema.String),
  duplicate: Schema.NullOr(
    Schema.Struct({ issueNumber: Schema.Int, url: Schema.String, rationale: Schema.String }),
  ),
})
export type ReproductionAssessment = typeof ReproductionAssessment.Type
export const Reproduction = Schema.Struct({
  patch: Schema.NullOr(ValidatedPatch),
  attempts: Schema.Array(TestAttempt),
  assessment: Schema.NullOr(ReproductionAssessment),
})
export type Reproduction = typeof Reproduction.Type
