import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { RepositoryBlocked, RepositoryNotFound } from "../GitHub/Repository.ts"
import { PolicyId } from "../Labeling/Policy/Condition.ts"
import {
  CreatePolicyRequest,
  PolicyConflict,
  PolicyDetail,
  PolicyHistoryRetained,
  PolicyInUse,
  PolicyInvalid,
  PolicyNameTaken,
  PolicyNotFound,
  PolicyRecord,
  PolicyVersionRecord,
  PublishPolicyRequest,
  SavePolicyRequest,
  ValidatePolicyRequest,
  ValidatePolicyResponse,
} from "../Labeling/Policy/Configuration.ts"

const repository = { repositoryId: GitHubRepositoryDatabaseId }
const policy = { ...repository, policyId: PolicyId }

/**
 * A repository's policy library: each policy's draft and published
 * versions, and validating a draft before it is saved.
 */
export class PoliciesGroup extends HttpApiGroup.make("policies")
  .add(
    HttpApiEndpoint.get("list", "/repositories/:repositoryId/policies", {
      params: repository,
      success: Schema.Array(PolicyRecord),
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/repositories/:repositoryId/policies/:policyId", {
      params: policy,
      success: PolicyDetail,
      error: [RepositoryNotFound, PolicyNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("listVersions", "/repositories/:repositoryId/policies/:policyId/versions", {
      params: policy,
      success: Schema.Array(PolicyVersionRecord),
      error: [RepositoryNotFound, PolicyNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/repositories/:repositoryId/policies", {
      params: repository,
      payload: CreatePolicyRequest,
      success: PolicyDetail.pipe(HttpApiSchema.status(201)),
      error: [RepositoryNotFound, RepositoryBlocked, PolicyNameTaken, PolicyInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/repositories/:repositoryId/policies/:policyId", {
      params: policy,
      payload: SavePolicyRequest,
      success: PolicyDetail,
      error: [
        RepositoryNotFound,
        RepositoryBlocked,
        PolicyNotFound,
        PolicyConflict,
        PolicyNameTaken,
        PolicyInvalid,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("publish", "/repositories/:repositoryId/policies/:policyId/publish", {
      params: policy,
      payload: PublishPolicyRequest,
      success: PolicyDetail,
      error: [RepositoryNotFound, RepositoryBlocked, PolicyNotFound, PolicyConflict, PolicyInvalid],
    }),
  )
  .add(
    HttpApiEndpoint.delete("delete", "/repositories/:repositoryId/policies/:policyId", {
      params: policy,
      query: { version: Schema.Int },
      error: [
        RepositoryNotFound,
        RepositoryBlocked,
        PolicyNotFound,
        PolicyConflict,
        PolicyInUse,
        PolicyHistoryRetained,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("validate", "/repositories/:repositoryId/policies/validate", {
      params: repository,
      payload: ValidatePolicyRequest,
      success: ValidatePolicyResponse,
      error: RepositoryNotFound,
    }),
  ) {}
