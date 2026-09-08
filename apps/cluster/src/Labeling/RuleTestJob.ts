import { flushLive } from "../LiveUpdates.ts"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { TestRequest, TestResponse } from "@janitor/domain/Labeling/Policy/Test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Duration from "effect/Duration"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { LabelingConfiguration, RepositoryNotFound } from "./Configuration.ts"
import { LabelingTest } from "./Test.ts"

export const RuleTestJob = Schema.Struct({
  testId: Schema.String,
  status: Schema.Literals(["queued", "running", "done", "failed"]),
  response: Schema.NullOr(TestResponse),
  message: Schema.NullOr(Schema.String),
})
const Payload = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId, testId: Schema.String })
const Row = Schema.Struct({
  request: TestRequest,
  status: RuleTestJob.fields.status,
  response: RuleTestJob.fields.response,
  message: Schema.NullOr(Schema.String),
})
const TAG = "LabelingRuleTest"
export const enqueueRuleTest = Effect.fn("enqueueRuleTest")(function* (
  repositoryId: GitHubRepositoryDatabaseId,
  request: TestRequest,
) {
  const configuration = yield* LabelingConfiguration
  yield* configuration.requireRepository(repositoryId)
  const sql = yield* SqlClient.SqlClient
  const connected =
    yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${repositoryId} AND connected`
  if (!connected.length) return yield* new RepositoryNotFound({ repositoryId })
  const outbox = yield* WorkflowOutbox
  const testId = crypto.randomUUID()
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM labeling_rule_test WHERE repository_id=${repositoryId} AND expires_at<CLOCK_TIMESTAMP()`
      yield* sql`INSERT INTO labeling_rule_test(test_id,repository_id,request) VALUES(${testId},${repositoryId},${JSON.stringify(request)}::jsonb)`
      yield* outbox.enqueue({
        workflowTag: TAG,
        executionKey: testId,
        payload: { repositoryId, testId },
      })
    }),
  )
  return { testId, status: "queued" as const, response: null, message: null }
})
export const getRuleTest = Effect.fn("getRuleTest")(function* (
  repositoryId: GitHubRepositoryDatabaseId,
  testId: string,
  includeInput = false,
) {
  const configuration = yield* LabelingConfiguration
  yield* configuration.requireRepository(repositoryId)
  const sql = yield* SqlClient.SqlClient
  const connected =
    yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${repositoryId} AND connected`
  if (!connected.length) return yield* new RepositoryNotFound({ repositoryId })
  yield* sql`UPDATE labeling_rule_test SET status='failed',message='The test expired. Run it again.' WHERE repository_id=${repositoryId} AND test_id=${testId} AND expires_at<CLOCK_TIMESTAMP() AND status IN ('queued','running')`
  const rows =
    yield* sql`SELECT request,status,response,message FROM labeling_rule_test WHERE repository_id=${repositoryId} AND test_id=${testId} AND (expires_at>CLOCK_TIMESTAMP() OR NOT ${includeInput})`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
    )
  return rows[0]
    ? {
        testId,
        status: rows[0].status,
        response:
          !includeInput && rows[0].response?._tag === "Evaluated"
            ? {
                ...rows[0].response,
                entities: rows[0].response.entities.map((entity): typeof entity => {
                  if (!entity.evaluation) return entity
                  const { inputDetails: _details, ...evaluation } = entity.evaluation
                  return { ...entity, evaluation }
                }),
              }
            : rows[0].response,
        message: rows[0].message,
      }
    : null
})
export const TestWorkflow = Workflow.make(TAG, {
  payload: Payload,
  success: Schema.Void,
  error: Schema.String,
  idempotencyKey: (p) => p.testId,
})
export const RuleTestJobLayer = TestWorkflow.toLayer(
  Effect.fnUntraced(function* ({ repositoryId, testId }) {
    const sql = yield* SqlClient.SqlClient
    const test = yield* LabelingTest
    yield* Activity.make({
      name: "RuleTest/evaluate",
      success: Schema.Void,
      error: Schema.String,
      execute: Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE labeling_rule_test SET status='running' WHERE repository_id=${repositoryId} AND test_id=${testId} AND status IN ('queued','running') AND expires_at>CLOCK_TIMESTAMP() AND EXISTS(SELECT 1 FROM github_repository WHERE repository_id=${repositoryId} AND connected) RETURNING request,status,response,message`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
          )
        if (!rows[0]) return
        yield* flushLive
        const response = yield* test.run(repositoryId, rows[0].request).pipe(
          Effect.timeout(Duration.seconds(120)),
          Effect.match({
            onSuccess: (response) => ({ response, message: null }),
            onFailure: () => ({
              response: null,
              message: "The test could not finish. Try again.",
            }),
          }),
        )
        yield* sql`UPDATE labeling_rule_test SET status=${response.response ? "done" : "failed"},response=${response.response ? JSON.stringify(response.response) : null}::jsonb,message=${response.message} WHERE repository_id=${repositoryId} AND test_id=${testId} AND status='running'`
      }).pipe(
        Effect.mapError(() => "Unable to record test result"),
        Effect.ensuring(flushLive),
      ),
    })
  }),
)
export const RuleTestJobRegistration: WorkflowRegistration = {
  tag: TAG,
  submit: (payload) =>
    Schema.decodeUnknownEffect(Payload)(payload).pipe(
      Effect.flatMap((p) => TestWorkflow.execute(p, { discard: true })),
      Effect.asVoid,
    ),
}

export class RuleTestJobs extends Context.Service<
  RuleTestJobs,
  {
    readonly enqueue: (
      repositoryId: GitHubRepositoryDatabaseId,
      request: TestRequest,
    ) => Effect.Effect<typeof RuleTestJob.Type, unknown>
    readonly get: (
      repositoryId: GitHubRepositoryDatabaseId,
      testId: string,
      includeInput?: boolean,
    ) => Effect.Effect<typeof RuleTestJob.Type | null, unknown>
  }
>()("@janitor/Labeling/RuleTestJobs") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const configuration = yield* LabelingConfiguration
      const outbox = yield* WorkflowOutbox
      return {
        enqueue: (repositoryId: GitHubRepositoryDatabaseId, request: TestRequest) =>
          enqueueRuleTest(repositoryId, request).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(LabelingConfiguration, configuration),
            Effect.provideService(WorkflowOutbox, outbox),
          ),
        get: (repositoryId: GitHubRepositoryDatabaseId, testId: string, includeInput = false) =>
          getRuleTest(repositoryId, testId, includeInput).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(LabelingConfiguration, configuration),
          ),
      }
    }),
  )
}
