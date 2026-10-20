import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiError from "effect/http-api/HttpApiError"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { RepositoryBlocked, RepositoryNotFound } from "../GitHub/Repository.ts"
import { AiInputDetails } from "../Labeling/Policy/AiInput.ts"
import { PolicyInvalid, RuleTestNotFound } from "../Labeling/Policy/Configuration.ts"
import { RuleTestJob, TestEntity, TestRequest, TestResponse } from "../Labeling/Policy/Test.ts"

const repository = { repositoryId: GitHubRepositoryDatabaseId }
const ruleTest = { ...repository, testId: Schema.String }

/**
 * The test bench: evaluates a subject against open items without mutating
 * them. A rule test runs one item in the background, and the editor polls it.
 */
export class TestBenchGroup extends HttpApiGroup.make("testBench")
  .add(
    HttpApiEndpoint.get("listItems", "/repositories/:repositoryId/test/items", {
      params: repository,
      success: Schema.Array(TestEntity),
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("run", "/repositories/:repositoryId/test", {
      params: repository,
      payload: TestRequest,
      success: TestResponse,
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("startRuleTest", "/repositories/:repositoryId/rule-tests", {
      params: repository,
      payload: TestRequest,
      success: RuleTestJob.pipe(HttpApiSchema.status(202)),
      error: [RepositoryNotFound, RepositoryBlocked, PolicyInvalid, HttpApiError.BadRequest],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRuleTest", "/repositories/:repositoryId/rule-tests/:testId", {
      params: ruleTest,
      success: RuleTestJob,
      error: [RepositoryNotFound, RepositoryBlocked, RuleTestNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getRuleTestInput",
      "/repositories/:repositoryId/rule-tests/:testId/input",
      {
        params: ruleTest,
        success: AiInputDetails,
        error: [RepositoryNotFound, RepositoryBlocked, RuleTestNotFound],
      },
    ),
  ) {}
