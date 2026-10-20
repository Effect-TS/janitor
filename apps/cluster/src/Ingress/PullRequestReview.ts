import { JanitorApi } from "@janitor/domain/Api"
import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import {
  PrivateRepository,
  RunNotFound,
  TranscriptExpired,
} from "@janitor/domain/PullRequestReview/Settings"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import { pullRequestReviewDeployment } from "../PullRequestReview/Config.ts"
import { RunTranscripts } from "../PullRequestReview/RunEntity.ts"
import { RepositoryDisabler } from "../PullRequestReview/Scheduler.ts"
import { PullRequestReviewStore } from "../PullRequestReview/Store.ts"

/** Runs per page, as on Activity. */
const RUN_PAGE_SIZE = 50

/** The repository janitor knows; database failures die. */
const repository = (repositoryId: GitHubRepositoryDatabaseId) =>
  GitHubReadModel.use((readModel) => readModel.getRepository(repositoryId)).pipe(
    Effect.orDie,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RepositoryNotFound({ repositoryId })),
        onSome: Effect.succeed,
      }),
    ),
  )

const settings = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.gen(function* () {
    const store = yield* PullRequestReviewStore
    return {
      repositoryId,
      enabled: yield* store.isEnabled(repositoryId),
      deployment: yield* pullRequestReviewDeployment,
    }
  }).pipe(Effect.orDie)

/**
 * PR review's repository settings and runs list (EFF-1930), and a run's
 * transcript (EFF-2445). Infrastructure failures die: the store, the read
 * model, the deployment's config and a run entity that can't be reached. A
 * transcript is never logged.
 */
export const PullRequestReviewGroupLayer = HttpApiBuilder.group(
  JanitorApi,
  "pullRequestReview",
  (handlers) =>
    handlers
      .handle("getSettings", ({ params }) =>
        repository(params.repositoryId).pipe(Effect.andThen(settings(params.repositoryId))),
      )
      .handle("updateSettings", ({ params, payload }) =>
        Effect.gen(function* () {
          const { repositoryId } = params
          const found = yield* repository(repositoryId)
          if (payload.enabled) {
            // Unknown visibility counts as private, as in admission (EFF-1645 point 3).
            if (found.isPrivate !== false) return yield* new PrivateRepository({ repositoryId })
            yield* PullRequestReviewStore.use((store) => store.setEnabled(repositoryId, true)).pipe(
              Effect.orDie,
            )
          } else {
            yield* RepositoryDisabler.use((disabler) => disabler.disable(repositoryId)).pipe(
              Effect.orDie,
            )
          }
          yield* Effect.logInfo(payload.enabled ? "PR review enabled" : "PR review disabled").pipe(
            Effect.annotateLogs({ repositoryId }),
          )
          return yield* settings(repositoryId)
        }),
      )
      .handle("listRuns", ({ params, query }) =>
        Effect.gen(function* () {
          yield* repository(params.repositoryId)
          const page = yield* PullRequestReviewStore.use((store) =>
            store.runs(params.repositoryId, {
              limit: RUN_PAGE_SIZE,
              cursor: Option.fromNullishOr(query.cursor),
              search: query.search ?? "",
            }),
          ).pipe(Effect.orDie)
          // Encoding drops the store columns the runs list doesn't show.
          return { runs: page.runs, cursor: Option.getOrNull(page.next) }
        }),
      )
      .handle("getRunTranscript", ({ params }) =>
        Effect.gen(function* () {
          const { repositoryId, runId } = params
          yield* repository(repositoryId)
          // Found in the repository first, so a run id from another one is never read.
          const run = yield* PullRequestReviewStore.use((store) =>
            store.run(repositoryId, runId),
          ).pipe(Effect.orDie)
          if (Option.isNone(run)) return yield* new RunNotFound({ runId })
          const transcript = yield* RunTranscripts.use((transcripts) =>
            transcripts.get(runId),
          ).pipe(Effect.orDie)
          if (transcript._tag === "Expired") return yield* new TranscriptExpired({ runId })
          const { _tag, ...kept } = transcript
          return { run: run.value, ...kept }
        }),
      ),
)
