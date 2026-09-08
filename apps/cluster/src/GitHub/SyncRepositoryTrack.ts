import { GitHubIssueApi, GitHubLabelApi, GitHubPullRequestApi } from "@janitor/domain/GitHub/Api"
import { GitHubInstallationId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { GitHubRepositoryRecord } from "@janitor/domain/GitHub/ReadModel"
import { GitHubRepositoryTrack, SyncGeneration, type SyncScope } from "@janitor/domain/GitHub/Sync"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceZero,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { SYNC_REPOSITORY_TRACK_TAG } from "../SyncRequests.ts"
import { SyncTargets } from "../SyncTargets.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { GitHubReadModel } from "./ReadModel.ts"
import {
  SyncActivityError,
  SyncRunOutcome,
  completeRun,
  failure,
  logWorkflowFailure,
  paginate,
  resolveRepository,
} from "./SyncSupport.ts"

export const SyncRepositoryTrackPayload = Schema.Struct({
  scope: Schema.TaggedStruct("RepositoryTrack", {
    repositoryId: GitHubRepositoryDatabaseId,
    track: GitHubRepositoryTrack,
  }),
  generation: SyncGeneration,
})
export type SyncRepositoryTrackPayload = typeof SyncRepositoryTrackPayload.Type

export const SyncRepositoryTrackResult = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  track: GitHubRepositoryTrack,
  generation: SyncGeneration,
  outcome: SyncRunOutcome,
  itemCount: Schema.Int,
})

export const SyncRepositoryTrack = Workflow.make(SYNC_REPOSITORY_TRACK_TAG, {
  payload: SyncRepositoryTrackPayload,
  success: SyncRepositoryTrackResult,
  error: SyncActivityError,
  idempotencyKey: ({ scope, generation }) => `${scope.repositoryId}:${scope.track}:${generation}`,
})

const BeginActivityResult = Schema.Union([
  Schema.TaggedStruct("Run", {
    generation: SyncGeneration,
    sequence: Schema.NullOr(GitHubWebhookJournalSequence),
    watermark: Schema.NullOr(Schema.DateTimeUtcFromString),
    full: Schema.Boolean,
    installationId: GitHubInstallationId,
    owner: Schema.String,
    repo: Schema.String,
  }),
  Schema.TaggedStruct("Blocked", { reason: Schema.String, generation: SyncGeneration }),
  Schema.TaggedStruct("Superseded", {}),
])

/** Incremental scans re-read this much history before the watermark to cover moving page boundaries. */
export const SCAN_OVERLAP = Duration.minutes(10)

const encodePath = (repository: { owner: string; repo: string }) =>
  `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`

/** Resolve the run: target generation, covered sequence, watermark, and repository names. */
const begin = (scope: SyncScope & { _tag: "RepositoryTrack" }, generation: SyncGeneration) =>
  Activity.make({
    name: "SyncRepositoryTrack/Begin",
    success: BeginActivityResult,
    error: SyncActivityError,
    execute: Effect.gen(function* () {
      const targets = yield* SyncTargets
      const run = yield* targets
        .begin(scope, generation)
        .pipe(Effect.mapError((error) => failure(error.message)))
      if (run._tag === "Superseded") {
        return { _tag: "Superseded" as const }
      }
      const repository = yield* resolveRepository(scope.repositoryId)
      if (repository._tag === "Blocked") {
        return { _tag: "Blocked" as const, reason: repository.reason, generation: run.generation }
      }
      return {
        _tag: "Run" as const,
        generation: run.generation,
        sequence: Option.getOrNull(run.sequence),
        watermark: run.full ? null : Option.getOrNull(run.watermark),
        full: run.full,
        installationId: repository.repository.installationId,
        owner: repository.repository.owner,
        repo: repository.repository.repo,
      }
    }),
  })

const blockedOn404 = (status: number): SyncRunOutcome | undefined =>
  status === 404 || status === 403 ? "blocked" : undefined

export const SyncRepositoryTrackLayer = SyncRepositoryTrack.toLayer(
  Effect.fnUntraced(function* (payload) {
    const scope = payload.scope
    const { repositoryId, track } = scope
    const result = (generation: SyncGeneration, outcome: SyncRunOutcome, itemCount: number) => ({
      repositoryId,
      track,
      generation,
      outcome,
      itemCount,
    })

    const begun = yield* begin(scope, payload.generation)
    if (begun._tag === "Superseded") {
      return result(payload.generation, "superseded", 0)
    }
    const generation = begun.generation
    if (begun._tag === "Blocked") {
      yield* completeRun("SyncRepositoryTrack", scope, generation, {
        _tag: "Blocked",
        reason: begun.reason,
      })
      return result(generation, "blocked", 0)
    }
    const sequence = begun.sequence ?? GitHubWebhookJournalSequenceZero
    const repository: Pick<GitHubRepositoryRecord, "owner" | "repo"> = begun
    const path = encodePath(repository)

    // The run-start cutoff becomes the next watermark only after every page commits.
    const cutoff = yield* Activity.make({
      name: "SyncRepositoryTrack/Cutoff",
      success: Schema.DateTimeUtcFromString,
      execute: DateTime.now,
    })
    const since = Option.map(Option.fromNullishOr(begun.watermark), (watermark) =>
      DateTime.subtractDuration(watermark, SCAN_OVERLAP),
    )
    const sinceQuery = Option.match(since, {
      onNone: () => "",
      onSome: (value) => `&since=${encodeURIComponent(DateTime.formatIso(value))}`,
    })
    const finish = (
      outcome:
        | { _tag: "Complete"; count: number }
        | { _tag: "Blocked"; reason: string }
        | { _tag: "Failed"; message: string },
    ) =>
      Effect.gen(function* () {
        switch (outcome._tag) {
          case "Complete": {
            yield* completeRun("SyncRepositoryTrack", scope, generation, {
              _tag: "Verified",
              watermark: Option.some(cutoff),
            })
            return result(generation, "verified", outcome.count)
          }
          case "Blocked": {
            yield* completeRun("SyncRepositoryTrack", scope, generation, outcome)
            return result(generation, "blocked", 0)
          }
          case "Failed": {
            yield* completeRun("SyncRepositoryTrack", scope, generation, {
              _tag: "Failed",
              error: outcome.message,
            })
            return result(generation, "failed", 0)
          }
        }
      })

    const readModel = yield* GitHubReadModel
    const targets = yield* SyncTargets
    const request = {
      scope: { _tag: "Installation" as const, installationId: begun.installationId },
      priority: "background" as const,
    }
    const applyPage = (
      name: string,
      ordinal: number,
      count: number,
      execute: Effect.Effect<unknown, Error>,
    ) =>
      Activity.make({
        name: `SyncRepositoryTrack/${name}/${ordinal}`,
        error: SyncActivityError,
        execute: targets.withRun(scope, generation, execute, { page: ordinal, items: count }).pipe(
          Effect.flatMap((applied) =>
            Option.isSome(applied) ? Effect.void : Effect.fail(failure("Run superseded")),
          ),
          Effect.mapError((error) => failure(error.message)),
        ),
      })

    switch (track) {
      case "labels": {
        const pages = yield* paginate({
          name: "SyncRepositoryTrack/Labels",
          firstUrl: `${path}/labels?per_page=100`,
          request,
          page: Schema.Array(GitHubLabelApi),
          items: (labels) => labels,
          itemSchema: GitHubLabelApi,
          onFailed: blockedOn404,
          cache: { repositoryId: Option.some(repositoryId) },
        })
        if (pages._tag !== "Complete") {
          return yield* finish(pages)
        }
        yield* Activity.make({
          name: "SyncRepositoryTrack/ApplyLabels",
          error: SyncActivityError,
          execute: readModel
            .withTransaction(
              targets.withRun(
                scope,
                generation,
                readModel.applyLabelCatalog({ repositoryId, labels: pages.items, sequence }),
              ),
            )
            .pipe(Effect.mapError((error) => failure(error.message))),
        })
        return yield* finish({ _tag: "Complete", count: pages.items.length })
      }
      case "entities": {
        const state = Option.isSome(since) ? "all" : "open"
        const pages = yield* paginate({
          name: "SyncRepositoryTrack/Issues",
          firstUrl: `${path}/issues?state=${state}&sort=${Option.isSome(since) ? "updated" : "created"}&direction=${Option.isSome(since) ? "desc" : "asc"}&per_page=100${sinceQuery}`,
          request,
          page: Schema.Array(GitHubIssueApi),
          items: (issues) => issues,
          itemSchema: GitHubIssueApi,
          onFailed: blockedOn404,
          // A changing since parameter is not a reusable representation.
          collect: false,
          onPage: (issues, ordinal) =>
            applyPage(
              "ApplyIssues",
              ordinal,
              issues.length,
              readModel.applyIssues({ repositoryId, issues, sequence }),
            ),
        })
        if (pages._tag !== "Complete") return yield* finish(pages)
        if (Option.isNone(since)) {
          yield* Activity.make({
            name: "SyncRepositoryTrack/VerifyAbsentOpen",
            error: SyncActivityError,
            execute: targets
              .withRun(
                scope,
                generation,
                Effect.gen(function* () {
                  const missing = yield* readModel.listOpenEntityNumbersBefore(repositoryId, cutoff)
                  for (const entity of missing)
                    yield* targets.invalidate({
                      scope: { _tag: "Entity", repositoryId, number: entity },
                      sequence: Option.some(sequence),
                    })
                }),
              )
              .pipe(
                Effect.asVoid,
                Effect.mapError((error) => failure(error.message)),
              ),
          })
        }
        return yield* finish({ _tag: "Complete", count: pages.count })
      }
      case "pull_requests": {
        const state = Option.isSome(since) ? "all" : "open"
        const pages = yield* paginate({
          name: "SyncRepositoryTrack/PullRequests",
          firstUrl: `${path}/pulls?state=${state}&sort=${Option.isSome(since) ? "updated" : "created"}&direction=${Option.isSome(since) ? "desc" : "asc"}&per_page=100`,
          request,
          page: Schema.Array(GitHubPullRequestApi),
          items: (pulls) =>
            Option.match(since, {
              onNone: () => pulls,
              // The pulls endpoint has no `since`; stop applying below the cutoff.
              onSome: (floor) =>
                pulls.filter((pull) => !DateTime.isLessThan(pull.updatedAt, floor)),
            }),
          itemSchema: GitHubPullRequestApi,
          stopAfter: (pulls) =>
            Option.isSome(since) &&
            pulls.some((pull) => DateTime.isLessThan(pull.updatedAt, since.value)),
          collect: false,
          onPage: (pulls, ordinal) =>
            applyPage(
              "ApplyPullRequests",
              ordinal,
              pulls.length,
              Effect.gen(function* () {
                const missing = yield* readModel.applyPullRequests({
                  repositoryId,
                  pulls,
                  sequence,
                })
                for (const number of missing)
                  yield* targets.invalidate({
                    scope: { _tag: "Entity", repositoryId, number },
                    sequence: Option.some(sequence),
                  })
              }),
            ),
          onFailed: blockedOn404,
          cache: { repositoryId: Option.some(repositoryId) },
        })
        if (pages._tag !== "Complete") {
          return yield* finish(pages)
        }
        return yield* finish({ _tag: "Complete", count: pages.count })
      }
    }
  }, logWorkflowFailure("SyncRepositoryTrack")),
)

const decodePayload = Schema.decodeUnknownEffect(SyncRepositoryTrackPayload)

export const SyncRepositoryTrackRegistration: WorkflowRegistration = {
  tag: SYNC_REPOSITORY_TRACK_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => SyncRepositoryTrack.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
