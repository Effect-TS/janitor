import { RepositoryBlocked, type RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import { flushLive } from "../LiveUpdates.ts"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RuleTestJob, TestRequest } from "@janitor/domain/Labeling/Policy/Test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Duration from "effect/Duration"
import * as Activity from "effect/workflow/Activity"
import * as Workflow from "effect/workflow/Workflow"
import * as SqlClient from "effect/sql/SqlClient"
import { isSqlError } from "effect/sql/SqlError"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { LabelingConfiguration } from "./Configuration.ts"
import { ClassifierError, EvaluationRetry } from "./Classifier.ts"
import { LabelingTest } from "./Test.ts"

const Payload = Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId, testId: Schema.String })
const Row = Schema.Struct({
  request: TestRequest,
  status: RuleTestJob.fields.status,
  response: RuleTestJob.fields.response,
  message: Schema.NullOr(Schema.String),
})
const TAG = "LabelingRuleTest"

/** A known repository that is no longer connected refuses its rule tests. */
const requireConnected = Effect.fnUntraced(function* (repositoryId: GitHubRepositoryDatabaseId) {
  const configuration = yield* LabelingConfiguration
  yield* configuration
    .requireRepository(repositoryId)
    .pipe(Effect.catchTag("LabelingConfigurationError", Effect.die))
  const sql = yield* SqlClient.SqlClient
  const connected =
    yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${repositoryId} AND connected`.pipe(
      Effect.orDie,
    )
  if (!connected.length)
    return yield* new RepositoryBlocked({ repositoryId, reason: "disconnected" })
})

/** Infrastructure failures die; the repository refusals stay typed. */
export const enqueueRuleTest = Effect.fn("enqueueRuleTest")(function* (
  repositoryId: GitHubRepositoryDatabaseId,
  request: TestRequest,
) {
  yield* requireConnected(repositoryId)
  const sql = yield* SqlClient.SqlClient
  const outbox = yield* WorkflowOutbox
  const testId = crypto.randomUUID()
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const membership =
          yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${repositoryId} AND connected FOR NO KEY UPDATE`
        if (!membership.length)
          return yield* new RepositoryBlocked({ repositoryId, reason: "disconnected" })
        yield* sql`DELETE FROM labeling_rule_test WHERE repository_id=${repositoryId} AND expires_at<CLOCK_TIMESTAMP()`
        yield* sql`INSERT INTO labeling_rule_test(test_id,repository_id,request) VALUES(${testId},${repositoryId},${JSON.stringify(request)}::jsonb)`
        yield* outbox
          .enqueue({ workflowTag: TAG, executionKey: testId, payload: { repositoryId, testId } })
          .pipe(Effect.orDie)
      }),
    )
    .pipe(Effect.catchIf(isSqlError, Effect.die))
  return { testId, status: "queued" as const, response: null, message: null }
})
/** A missing test is null; infrastructure and row decode failures die. */
export const getRuleTest = Effect.fn("getRuleTest")(function* (
  repositoryId: GitHubRepositoryDatabaseId,
  testId: string,
  includeInput = false,
) {
  yield* requireConnected(repositoryId)
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE labeling_rule_test SET status='failed',message='The test expired. Run it again.' WHERE repository_id=${repositoryId} AND test_id=${testId} AND expires_at<CLOCK_TIMESTAMP() AND status IN ('queued','running')`.pipe(
    Effect.orDie,
  )
  const rows =
    yield* sql`SELECT request,status,response,message FROM labeling_rule_test WHERE repository_id=${repositoryId} AND test_id=${testId} AND (expires_at>CLOCK_TIMESTAMP() OR NOT ${includeInput})`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
      Effect.orDie,
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
          Effect.provideService(EvaluationRetry, {
            isCurrent:
              sql`SELECT 1 FROM labeling_rule_test t JOIN github_repository r USING(repository_id)
              WHERE t.test_id=${testId} AND r.connected AND t.status='running' AND t.expires_at>CLOCK_TIMESTAMP()`.pipe(
                Effect.map((rows) => rows.length > 0),
                Effect.mapError(
                  (error) =>
                    new ClassifierError({ operation: "test status", message: error.message }),
                ),
              ),
            report: (message) =>
              sql`UPDATE labeling_rule_test SET message=${message} WHERE test_id=${testId} AND status='running'`.pipe(
                Effect.asVoid,
                Effect.andThen(flushLive),
                Effect.mapError(
                  (error) =>
                    new ClassifierError({ operation: "retry status", message: error.message }),
                ),
              ),
          }),
          Effect.timeout(Duration.seconds(270)),
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
    ) => Effect.Effect<RuleTestJob, RepositoryNotFound | RepositoryBlocked>
    readonly get: (
      repositoryId: GitHubRepositoryDatabaseId,
      testId: string,
      includeInput?: boolean,
    ) => Effect.Effect<RuleTestJob | null, RepositoryNotFound | RepositoryBlocked>
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
