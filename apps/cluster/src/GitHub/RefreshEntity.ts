import {
  GitHubCheckRunsApi,
  GitHubCheckRunApi,
  GitHubIssueApi,
  GitHubPullRequestApi,
  GitHubPullRequestFileApi,
  GitHubPullRequestReviewApi,
} from "@janitor/domain/GitHub/Api"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceZero,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { SyncIntegration, type CollectionTrack } from "../SyncIntegration.ts"
import { REFRESH_ENTITY_TAG } from "../SyncRequests.ts"
import { SyncTargets } from "../SyncTargets.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { GitHubReadModel } from "./ReadModel.ts"
import {
  SyncActivityError,
  SyncRunOutcome,
  completeRun,
  failure,
  fetchInActivity,
  paginate,
  logWorkflowFailure,
  resolveRepository,
} from "./SyncSupport.ts"

export const RefreshEntityPayload = Schema.Struct({
  scope: Schema.TaggedStruct("Entity", {
    repositoryId: GitHubRepositoryDatabaseId,
    number: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  generation: SyncGeneration,
})
export type RefreshEntityPayload = typeof RefreshEntityPayload.Type

export const RefreshEntityResult = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int,
  generation: SyncGeneration,
  outcome: SyncRunOutcome,
})

/** Targeted refresh of one issue or pull request: background content verification. */
export const RefreshEntity = Workflow.make(REFRESH_ENTITY_TAG, {
  payload: RefreshEntityPayload,
  success: RefreshEntityResult,
  error: SyncActivityError,
  idempotencyKey: ({ scope, generation }) => `${scope.repositoryId}:${scope.number}:${generation}`,
})

const BeginActivityResult = Schema.Union([
  Schema.TaggedStruct("Run", {
    generation: SyncGeneration,
    sequence: Schema.NullOr(GitHubWebhookJournalSequence),
    installationId: GitHubInstallationId,
    owner: Schema.String,
    repo: Schema.String,
  }),
  Schema.TaggedStruct("Blocked", { reason: Schema.String, generation: SyncGeneration }),
  Schema.TaggedStruct("Superseded", {}),
])

const Collections = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: Schema.String })),
  filesComplete: Schema.Boolean,
  checksComplete: Schema.Boolean,
  reviewsComplete: Schema.Boolean,
  checks: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
  reviews: Schema.Array(Schema.Struct({ reviewer: Schema.String, state: Schema.String })),
})

/** How many changed files one refresh reads before marking the listing incomplete. */
export const MAX_CHANGED_FILES = 300
const PAGE = 100

const fetchCollections = (
  path: string,
  number: number,
  headSha: string,
  request: {
    scope: { _tag: "Installation"; installationId: typeof GitHubInstallationId.Type }
    priority: "background"
  },
  required: ReadonlyArray<CollectionTrack>,
) =>
  Effect.gen(function* () {
    const collections: typeof Collections.Type = {
      files: [],
      filesComplete: false,
      checksComplete: false,
      reviewsComplete: false,
      checks: [],
      reviews: [],
    }
    if (required.includes("changed_files")) {
      const files = yield* paginate({
        name: "RefreshEntity/Files",
        firstUrl: `${path}/pulls/${number}/files?per_page=${PAGE}`,
        request,
        page: Schema.Array(GitHubPullRequestFileApi),
        items: (items) => items,
        itemSchema: GitHubPullRequestFileApi,
        maxPages: MAX_CHANGED_FILES / PAGE,
        allowTruncate: true,
      })
      if (files._tag !== "Complete")
        return yield* failure(files._tag === "Failed" ? files.message : files.reason)
      Object.assign(collections, {
        files: files.items.map((file) => ({ path: file.filename, status: file.status })),
        filesComplete: files.complete,
      })
    }
    if (required.includes("checks")) {
      const checks = yield* paginate({
        name: "RefreshEntity/Checks",
        firstUrl: `${path}/commits/${headSha}/check-runs?per_page=${PAGE}`,
        request,
        page: GitHubCheckRunsApi,
        items: (body) => body.checkRuns,
        itemSchema: GitHubCheckRunApi,
      })
      if (checks._tag !== "Complete")
        return yield* failure(checks._tag === "Failed" ? checks.message : checks.reason)
      Object.assign(collections, {
        checksComplete: true,
        checks: checks.items.map((run) => ({
          name: run.name,
          state: run.conclusion ?? run.status,
        })),
      })
    }
    if (required.includes("reviews")) {
      const reviews = yield* paginate({
        name: "RefreshEntity/Reviews",
        firstUrl: `${path}/pulls/${number}/reviews?per_page=${PAGE}`,
        request,
        page: Schema.Array(GitHubPullRequestReviewApi),
        items: (items) => items,
        itemSchema: GitHubPullRequestReviewApi,
      })
      if (reviews._tag !== "Complete")
        return yield* failure(reviews._tag === "Failed" ? reviews.message : reviews.reason)
      const latest = new Map<string, string>()
      for (const review of [...reviews.items].sort((a, b) => a.id - b.id)) {
        const reviewer = review.user?.login.toLowerCase()
        if (reviewer === undefined) continue
        if (review.state === "DISMISSED") latest.delete(reviewer)
        else if (review.state !== "COMMENTED" && review.state !== "PENDING")
          latest.set(reviewer, review.state)
      }
      Object.assign(collections, {
        reviewsComplete: true,
        reviews: [...latest].map(([reviewer, state]) => ({ reviewer, state })),
      })
    }
    return collections
  })

export const RefreshEntityLayer = RefreshEntity.toLayer(
  Effect.fnUntraced(function* (payload) {
    const scope = payload.scope
    const { repositoryId, number } = scope
    const result = (generation: SyncGeneration, outcome: SyncRunOutcome) => ({
      repositoryId,
      number,
      generation,
      outcome,
    })

    const begun = yield* Activity.make({
      name: "RefreshEntity/Begin",
      success: BeginActivityResult,
      error: SyncActivityError,
      execute: Effect.gen(function* () {
        const targets = yield* SyncTargets
        const run = yield* targets
          .begin(scope, payload.generation)
          .pipe(Effect.mapError((error) => failure(error.message)))
        if (run._tag === "Superseded") {
          return { _tag: "Superseded" as const }
        }
        const repository = yield* resolveRepository(repositoryId)
        if (repository._tag === "Blocked") {
          return { _tag: "Blocked" as const, reason: repository.reason, generation: run.generation }
        }
        return {
          _tag: "Run" as const,
          generation: run.generation,
          sequence: Option.getOrNull(run.sequence),
          installationId: repository.repository.installationId,
          owner: repository.repository.owner,
          repo: repository.repository.repo,
        }
      }),
    })
    if (begun._tag === "Superseded") {
      return result(payload.generation, "superseded")
    }
    if (begun._tag === "Blocked") {
      yield* completeRun("RefreshEntity", scope, begun.generation, {
        _tag: "Blocked",
        reason: begun.reason,
      })
      return result(begun.generation, "blocked")
    }
    const { generation } = begun
    const sequence = begun.sequence ?? GitHubWebhookJournalSequenceZero
    const path = `/repos/${encodeURIComponent(begun.owner)}/${encodeURIComponent(begun.repo)}`
    const request = {
      scope: { _tag: "Installation" as const, installationId: begun.installationId },
      priority: "background" as const,
    }

    const integration = yield* SyncIntegration
    const fetched = yield* Effect.gen(function* () {
      const issue = yield* fetchInActivity(
        "RefreshEntity/Issue",
        { ...request, method: "GET", url: `${path}/issues/${number}` },
        GitHubIssueApi,
      )
      if (issue._tag === "Failed") {
        return issue.status === 403 || issue.status === 404
          ? { _tag: "Ambiguous" as const, status: issue.status }
          : yield* failure(issue.message)
      }
      if (issue.body.pullRequest === undefined)
        return { _tag: "Found" as const, issue: issue.body, pullRequest: null, collections: null }
      const pull = yield* fetchInActivity(
        "RefreshEntity/Pull",
        { ...request, method: "GET", url: `${path}/pulls/${number}` },
        GitHubPullRequestApi,
      )
      if (pull._tag === "Failed") {
        return pull.status === 403 || pull.status === 404
          ? { _tag: "Ambiguous" as const, status: pull.status }
          : yield* failure(pull.message)
      }
      const required = yield* Activity.make({
        name: "RefreshEntity/Requirements",
        success: Schema.Array(Schema.Literals(["changed_files", "checks", "reviews"])),
        error: SyncActivityError,
        execute: integration
          .requiredCollections(repositoryId)
          .pipe(Effect.mapError((error) => failure(error.message))),
      })
      const collections =
        required.length === 0
          ? null
          : yield* fetchCollections(path, number, pull.body.head.sha, request, required)
      return { _tag: "Found" as const, issue: issue.body, pullRequest: pull.body, collections }
    }).pipe(Effect.result)

    if (fetched._tag === "Failure") {
      yield* completeRun("RefreshEntity", scope, generation, {
        _tag: "Failed",
        error: fetched.failure.message,
      })
      return result(generation, "failed")
    }
    if (fetched.success._tag === "Ambiguous") {
      yield* completeRun("RefreshEntity", scope, generation, {
        _tag: "Blocked",
        reason: `entity-http-${fetched.success.status}`,
      })
      return result(generation, "blocked")
    }
    const found = fetched.success

    yield* Activity.make({
      name: "RefreshEntity/Apply",
      error: SyncActivityError,
      execute: Effect.gen(function* () {
        const readModel = yield* GitHubReadModel
        const targets = yield* SyncTargets
        yield* targets
          .withRun(
            scope,
            generation,
            Effect.gen(function* () {
              const applied = yield* readModel.applyIssue({
                repositoryId,
                issue: found.issue,
                sequence,
              })
              if (applied._tag === "Stale") return yield* failure("Entity changed during refresh")
              if (found.pullRequest !== null) {
                const details = yield* readModel.applyPullRequestDetails({
                  repositoryId,
                  pullRequest: found.pullRequest,
                  sequence,
                })
                if (details._tag !== "Applied")
                  return yield* failure("Pull request changed during refresh")
                if (found.collections !== null) {
                  yield* readModel.applyPullRequestCollections({
                    repositoryId,
                    number,
                    collections: found.collections,
                  })
                }
              }
              yield* targets.complete({
                scope,
                generation,
                outcome: { _tag: "Verified", watermark: Option.none() },
              })
              yield* integration.entityVerified({ repositoryId, number, generation, sequence })
            }),
          )
          .pipe(Effect.mapError((error) => failure(error.message)))
      }),
    })
    return result(generation, "verified")
  }, logWorkflowFailure("RefreshEntity")),
)

const decodePayload = Schema.decodeUnknownEffect(RefreshEntityPayload)

export const RefreshEntityRegistration: WorkflowRegistration = {
  tag: REFRESH_ENTITY_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => RefreshEntity.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
