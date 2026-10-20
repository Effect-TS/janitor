import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { RepositoryBlocked, RepositoryNotFound } from "../GitHub/Repository.ts"
import { AiRuleDefinition, AiRuleInspection } from "../Labeling/Policy/AiRule.ts"
import {
  CreateRuleRequest,
  GroupConflict,
  PatchRuleRequest,
  ReorderGroupRequest,
  RuleConflict,
  RuleInvalid,
  RuleNotFound,
  RuleRecord,
} from "../Labeling/Policy/Configuration.ts"
import { RuleId } from "../Labeling/Policy/Plan.ts"

const repository = { repositoryId: GitHubRepositoryDatabaseId }
const rule = { ...repository, ruleId: RuleId }

/**
 * A repository's labeling rules: each binds a label to a published policy
 * or an AI definition, and labeling groups order them by priority.
 */
export class RulesGroup extends HttpApiGroup.make("rules")
  .add(
    HttpApiEndpoint.get("list", "/repositories/:repositoryId/rules", {
      params: repository,
      success: Schema.Array(RuleRecord),
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/repositories/:repositoryId/rules/:ruleId", {
      params: rule,
      success: RuleRecord,
      error: [RepositoryNotFound, RuleNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/repositories/:repositoryId/rules", {
      params: repository,
      payload: CreateRuleRequest,
      success: RuleRecord.pipe(HttpApiSchema.status(201)),
      error: [RepositoryNotFound, RepositoryBlocked, RuleConflict, RuleInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/repositories/:repositoryId/rules/:ruleId", {
      params: rule,
      payload: PatchRuleRequest,
      success: RuleRecord,
      error: [RepositoryNotFound, RepositoryBlocked, RuleNotFound, RuleConflict, RuleInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.delete("delete", "/repositories/:repositoryId/rules/:ruleId", {
      params: rule,
      query: { version: Schema.Int },
      error: [RepositoryNotFound, RepositoryBlocked, RuleNotFound, RuleConflict],
    }),
  )
  .add(
    HttpApiEndpoint.post("reorder", "/repositories/:repositoryId/rules/reorder", {
      params: repository,
      payload: ReorderGroupRequest,
      success: Schema.Array(RuleRecord),
      error: [RepositoryNotFound, RepositoryBlocked, RuleInvalid, GroupConflict],
    }),
  )
  .add(
    HttpApiEndpoint.post("validate", "/repositories/:repositoryId/rules/validate", {
      params: repository,
      payload: AiRuleDefinition,
      success: AiRuleInspection,
      error: RepositoryNotFound,
    }),
  ) {}
