/**
 * PROTOTYPE (EFF-2304): a throwaway slice of janitor's `HttpApi` definition,
 * only the PR review routes, so the web app can try a derived client. The
 * group layout, names and error model are open on EFF-2301 and EFF-2303;
 * everything here is a placeholder for those decisions.
 */
import * as Schema from "effect/Schema"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiError from "effect/http-api/HttpApiError"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { RunId } from "../PullRequestReview/Run.ts"
import {
  RepositorySettings,
  RunPage,
  SetRepositorySettingsRequest,
} from "../PullRequestReview/Settings.ts"

/*
 * Errors are bare tags on the wire. The page that shows one owns its wording,
 * as Activity and PR reviews already do for 404s, so no `{ message }` body.
 */

/** The repository isn't one janitor knows. Replaces today's empty 404. */
export class RepositoryNotFound extends Schema.Error<RepositoryNotFound>(
  "janitor/RepositoryNotFound",
)({ _tag: Schema.tag("RepositoryNotFound") }, { httpApiStatus: 404 }) {}

/** PR review can't be enabled on a private repository. Today a 409 `{ message }`. */
export class PrivateRepository extends Schema.Error<PrivateRepository>("janitor/PrivateRepository")(
  { _tag: Schema.tag("PrivateRepository") },
  { httpApiStatus: 409 },
) {}

const params = { repositoryId: GitHubRepositoryDatabaseId }

export class PullRequestReviewGroup extends HttpApiGroup.make("pullRequestReview")
  .add(
    HttpApiEndpoint.get("getSettings", "/repositories/:repositoryId/pull-request-review", {
      params,
      success: RepositorySettings,
      error: [RepositoryNotFound, HttpApiError.ServiceUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.put("setSettings", "/repositories/:repositoryId/pull-request-review", {
      params,
      payload: SetRepositorySettingsRequest,
      success: RepositorySettings,
      error: [RepositoryNotFound, PrivateRepository, HttpApiError.ServiceUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRuns", "/repositories/:repositoryId/pull-request-review/runs", {
      params,
      query: { cursor: Schema.optionalKey(RunId) },
      success: RunPage,
      error: [RepositoryNotFound, HttpApiError.ServiceUnavailable],
    }),
  ) {}

export class JanitorApi extends HttpApi.make("janitor")
  .add(PullRequestReviewGroup)
  .prefix("/api/v1") {}
