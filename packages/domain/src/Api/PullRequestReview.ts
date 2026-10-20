import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { RepositoryNotFound } from "../GitHub/Repository.ts"
import { RunId } from "../PullRequestReview/Run.ts"
import {
  PrivateRepository,
  RepositorySettings,
  RunNotFound,
  RunPage,
  RunTranscript,
  SetRepositorySettingsRequest,
  TranscriptExpired,
} from "../PullRequestReview/Settings.ts"

const params = { repositoryId: GitHubRepositoryDatabaseId }

/** PR review's repository settings and runs list (EFF-1930), and a run's transcript (EFF-2445). */
export class PullRequestReviewGroup extends HttpApiGroup.make("pullRequestReview")
  .add(
    HttpApiEndpoint.get("getSettings", "/repositories/:repositoryId/pull-request-review", {
      params,
      success: RepositorySettings,
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("updateSettings", "/repositories/:repositoryId/pull-request-review", {
      params,
      payload: SetRepositorySettingsRequest,
      success: RepositorySettings,
      error: [RepositoryNotFound, PrivateRepository],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRuns", "/repositories/:repositoryId/pull-request-review/runs", {
      params,
      query: {
        cursor: Schema.optionalKey(RunId),
        search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
      },
      success: RunPage,
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getRunTranscript",
      "/repositories/:repositoryId/pull-request-review/runs/:runId/transcript",
      {
        params: { ...params, runId: RunId },
        success: RunTranscript,
        error: [RepositoryNotFound, RunNotFound, TranscriptExpired],
      },
    ),
  ) {}
