import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GitHubEntityKind } from "../../GitHub/ReadModel.ts"
import { PolicyId } from "./Condition.ts"
import { Plan } from "./Plan.ts"
import { Evaluation, ProgramSource } from "./Program.ts"

/**
 * The test bench (plan: "LabelingTest"). Evaluates a draft program, a
 * published policy, or the whole configured revision against chosen open
 * entities. Explicit, and never mutating.
 */

export const TestSubject = Schema.Union([
  Schema.TaggedStruct("Draft", {
    source: ProgramSource,
    policyId: Schema.optionalKey(PolicyId),
  }),
  Schema.TaggedStruct("Policy", { policyId: PolicyId }),
  Schema.TaggedStruct("Configuration", {}),
]).annotate({ identifier: "TestSubject" })
export type TestSubject = typeof TestSubject.Type

export const MAX_TEST_ENTITIES = 25

export const TestRequest = Schema.Struct({
  subject: TestSubject,
  /** Specific entities, or the most recently updated open ones when empty. */
  numbers: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0)))
    .check(Schema.isMaxLength(MAX_TEST_ENTITIES))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}).annotate({ identifier: "TestRequest" })
export type TestRequest = typeof TestRequest.Type

export const TestEntity = Schema.Struct({
  number: Schema.Int,
  kind: GitHubEntityKind,
  title: Schema.String,
  authorLogin: Schema.String,
  baseRef: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(Schema.Boolean),
  labels: Schema.Array(Schema.String),
  /** The subject's evaluation; for the configuration, the plan carries every rule. */
  evaluation: Schema.NullOr(Evaluation),
  plan: Schema.NullOr(Plan),
}).annotate({ identifier: "TestEntity" })
export type TestEntity = typeof TestEntity.Type

export const TestResponse = Schema.Union([
  Schema.TaggedStruct("Evaluated", { entities: Schema.Array(TestEntity) }),
  Schema.TaggedStruct("Rejected", { message: Schema.String }),
]).annotate({ identifier: "TestResponse" })
export type TestResponse = typeof TestResponse.Type
