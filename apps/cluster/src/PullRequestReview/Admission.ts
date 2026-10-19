import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/workflow/Activity"
import * as Workflow from "effect/workflow/Workflow"
import {
  GitHubCommentDatabaseId,
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
  GitHubUserDatabaseId,
} from "@janitor/domain/GitHub/Id"
import type {
  PullRequest,
  PullRequestWebhookPayload,
} from "@janitor/domain/GitHub/WebhookEvent/PullRequest"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { parseInvocation } from "@janitor/domain/PullRequestReview/Invocation"
import { RunId, type Trigger } from "@janitor/domain/PullRequestReview/Run"
import { AutomationIntegration } from "../AutomationIntegration.ts"
import { logWorkflowFailure } from "../GitHub/SyncSupport.ts"
import { RepositoryEligibility } from "../RepositoryEligibility.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { effectivePermission } from "./Authority.ts"
import { pullRequestReviewConfig, pullRequestReviewGate } from "./Config.ts"
import * as ReviewGitHub from "./GitHub.ts"
import { PullRequestScheduler, schedulerEntityId } from "./Scheduler.ts"
import { recordSkip } from "./Skip.ts"
import { PullRequestReviewStore } from "./Store.ts"

/**
 * PR review admission (EFF-1644), in two parts. The webhook hooks run inside
 * the projection's transaction, so they make only the cheap checks (the
 * deployment gate, the repository flag, public visibility, bot authors, open
 * and not a draft, and a comment's shape) and enqueue an outbox row with ids
 * only. After commit, the admission workflow makes the checks that need
 * GitHub (the invoker's effective permission and the size count for the
 * oversized check) and then tells the per-PR scheduler.
 */

export const PR_REVIEW_ADMISSION_TAG = "Janitor/PullRequestReviewAdmissionV1"

/** What the webhook said happened to the pull request. */
export const AdmissionEvent = Schema.TaggedUnion({
  /** Opened, ready for review or pushed to. */
  HeadChanged: { headSha: GitHubCommitSha },
  Reopened: { headSha: GitHubCommitSha },
  /** Closed or merged. */
  Closed: {},
  ConvertedToDraft: {},
  /** A human reply in a review thread, without requiring a command or write access. */
  Replied: { commentId: GitHubCommentDatabaseId },
  /** A top-level `/janitor` comment from a human, whose permission is not yet checked. */
  Invoked: {
    commentId: GitHubCommentDatabaseId,
    authorId: GitHubUserDatabaseId,
    authorLogin: Schema.NonEmptyString,
  },
}).annotate({ identifier: "PullRequestReviewAdmissionEvent" })
export type AdmissionEvent = typeof AdmissionEvent.Type

/** The outbox payload: ids only, never pull request or comment text. */
export const AdmissionPayload = Schema.Struct({
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The admitting delivery's journal sequence, so a repeated event is a new execution. */
  sequence: GitHubWebhookJournalSequence,
  event: AdmissionEvent,
}).annotate({ identifier: "PullRequestReviewAdmissionPayload" })
export type AdmissionPayload = typeof AdmissionPayload.Type

export class AdmissionError extends Schema.TaggedError<AdmissionError>()(
  "PullRequestReviewAdmissionError",
  { message: Schema.String },
) {}

const admissionKey = (payload: AdmissionPayload) =>
  `pr-review-admission:${payload.repositoryId}:${payload.number}:${payload.sequence}`

export const AdmitPullRequestReview = Workflow.make(PR_REVIEW_ADMISSION_TAG, {
  payload: AdmissionPayload,
  error: AdmissionError,
  idempotencyKey: admissionKey,
})

// HOOKS

/** Dependabot, Renovate, `github-actions[bot]` and every other App account. */
const isBot = (account: { readonly login: string; readonly type?: string | undefined }) =>
  account.type === "Bot" || account.login.endsWith("[bot]")

/**
 * What a `pull_request` action means for PR review. Close and conversion to
 * draft always reach the scheduler, to cancel; a new head only when the pull
 * request is open, not a draft and not from a bot.
 */
const pullRequestAdmission = (
  action: PullRequestWebhookPayload["action"],
  pull: PullRequest,
): AdmissionEvent | undefined => {
  switch (action) {
    case "closed":
      return { _tag: "Closed" }
    case "converted_to_draft":
      return { _tag: "ConvertedToDraft" }
    case "opened":
    case "ready_for_review":
    case "synchronize":
    case "reopened": {
      if (pull.state !== "open" || pull.draft || isBot(pull.user)) return undefined
      const headSha = pull.head.sha
      return action === "reopened"
        ? { _tag: "Reopened", headSha }
        : { _tag: "HeadChanged", headSha }
    }
    default:
      return undefined
  }
}

/**
 * The pull request, invocation and review-thread reply hooks. They read nothing from
 * GitHub and send no entity messages: what passes the cheap checks becomes
 * one outbox row in the projection's transaction. Bot and draft skips write
 * nothing. Production composes them with labeling's hooks.
 */
export const PullRequestReviewAutomationIntegrationLayer = Layer.effect(
  AutomationIntegration,
  Effect.gen(function* () {
    const eligibility = yield* RepositoryEligibility
    const store = yield* PullRequestReviewStore
    const outbox = yield* WorkflowOutbox
    const encode = Schema.encodeEffect(AdmissionPayload)

    /** The gate, the repository fence and the repository flag, in that order. */
    const reviewing = (repositoryId: GitHubRepositoryDatabaseId) =>
      Effect.gen(function* () {
        if (!(yield* pullRequestReviewGate)) return false
        const repository = yield* eligibility.get(repositoryId).pipe(Effect.result)
        if (repository._tag === "Failure") {
          if (repository.failure._tag === "RepositoryBlocked") return false
          return yield* repository.failure
        }
        return yield* store.isEnabled(repositoryId)
      })

    const enqueue = (payload: AdmissionPayload) =>
      Effect.gen(function* () {
        if (!(yield* reviewing(payload.repositoryId))) return
        yield* outbox.enqueue({
          workflowTag: PR_REVIEW_ADMISSION_TAG,
          executionKey: admissionKey(payload),
          payload: yield* encode(payload),
        })
      })

    return {
      issueEvent: () => Effect.void,
      reviewCommentEvent: (request) => {
        const { action, comment, pull_request: pull, repository } = request.payload
        if (
          action !== "created" ||
          comment.in_reply_to_id == null ||
          comment.user.type !== "User" ||
          isBot(comment.user) ||
          repository.private !== false ||
          pull.state !== "open" ||
          pull.draft !== false
        )
          return Effect.void
        return enqueue({
          repositoryId: request.repositoryId,
          number: pull.number,
          sequence: request.sequence,
          event: { _tag: "Replied", commentId: comment.id },
        })
      },
      pullRequestEvent: (request) => {
        if (request.repository.private !== false) return Effect.void
        const event = pullRequestAdmission(request.action, request.pullRequest)
        if (event === undefined) return Effect.void
        return enqueue({
          repositoryId: request.repositoryId,
          number: request.pullRequest.number,
          sequence: request.sequence,
          event,
        })
      },
      issueCommentEvent: (request) => {
        const { action, comment, issue, repository } = request.payload
        // Edits never trigger, and only a human's top-level comment on an open,
        // non-draft, public pull request counts.
        if (
          action !== "created" ||
          issue.pull_request === undefined ||
          issue.state !== "open" ||
          issue.draft === true ||
          repository.private !== false ||
          comment.user.type !== "User" ||
          isBot(comment.user) ||
          Option.isNone(parseInvocation(comment.body))
        )
          return Effect.void
        return enqueue({
          repositoryId: request.repositoryId,
          number: issue.number,
          sequence: request.sequence,
          event: {
            _tag: "Invoked",
            commentId: comment.id,
            authorId: comment.user.id,
            authorLogin: comment.user.login,
          },
        })
      },
    }
  }),
)

// WORKFLOW

/** The category only: the workflow failure log prints it, and messages can carry GitHub text. */
const failure = (error: { readonly _tag: string }) => new AdmissionError({ message: error._tag })

/**
 * Admits one event: what needs GitHub happens here, after the webhook's
 * transaction committed, and the scheduler hears ids only. `runId` names the
 * `skipped` row an oversized pull request gets.
 */
const admit = (payload: AdmissionPayload, runId: RunId) =>
  Effect.gen(function* () {
    const { repositoryId, number, event } = payload
    const eligibility = yield* RepositoryEligibility
    const found = yield* eligibility.get(repositoryId).pipe(Effect.result)
    if (found._tag === "Failure") {
      if (found.failure._tag === "RepositoryBlocked") return "repository-blocked"
      return yield* found.failure
    }
    const [owner] = found.success.name.split("/")
    const target = {
      installationId: GitHubInstallationId.make(found.success.installationId),
      owner: owner!,
      repo: found.success.name.slice(owner!.length + 1),
    }
    const scheduler = (yield* PullRequestScheduler.client)(schedulerEntityId(repositoryId, number))
    // The journal sequence lets the scheduler ignore an event whose admission finished late.
    const ids = { repositoryId, number, sequence: payload.sequence }

    if (event._tag === "Closed") {
      yield* scheduler.Closed(ids)
      return "closed"
    }
    if (event._tag === "ConvertedToDraft") {
      yield* scheduler.ConvertedToDraft(ids)
      return "converted-to-draft"
    }

    let invoker: { readonly login: string } | undefined
    if (event._tag === "Invoked") {
      const permission = yield* effectivePermission(target, event.authorLogin, event.authorId)
      if (permission._tag === "Insufficient") {
        yield* Effect.logInfo("PR review invocation denied").pipe(
          Effect.annotateLogs({ reason: permission.reason }),
        )
        return "denied"
      }
      invoker = permission
    }

    const config = yield* pullRequestReviewConfig
    const github = yield* ReviewGitHub.make({ ...target, number })
    const pull = yield* github.pullRequest
    if (
      event._tag === "Replied" &&
      (pull.state !== "open" ||
        pull.draft ||
        pull.visibility !== "public" ||
        (Option.isSome(pull.author) && isBot(pull.author.value)))
    )
      return "ineligible"
    const { size } = yield* github.changedFiles({
      baseSha: pull.baseSha,
      lockfiles: config.lockfiles,
    })
    const oversized = size.lines > config.maxChangedLines || size.files > config.maxChangedFiles

    if (event._tag === "Invoked") {
      // A write-access `/janitor` reviews an oversized pull request anyway, as forced.
      const trigger: Trigger = {
        _tag: oversized ? "Forced" : "Rerun",
        invoker: invoker!.login,
        commentId: event.commentId,
      }
      yield* scheduler.Rerun({ ...ids, headSha: GitHubCommitSha.make(pull.headSha), trigger })
      return trigger._tag === "Forced" ? "forced" : "rerun"
    }
    // A reply needs another pass even at the same SHA, but is not a privileged
    // invocation: retain the automatic run cap and never force oversized PRs.
    const headSha = event._tag === "Replied" ? GitHubCommitSha.make(pull.headSha) : event.headSha
    if (event._tag === "Replied") {
      // Rejecting an automatic reply must not revoke a forced review or its check.
      if (oversized) return "ineligible"
      yield* scheduler.Rerun({ ...ids, headSha, trigger: { _tag: "Automatic" } })
      return "scheduled"
    }
    if (oversized)
      yield* recordSkip(github, {
        runId,
        repositoryId,
        number,
        title: pull.title,
        headSha,
        baseSha: pull.baseSha,
        trigger: { _tag: "Automatic" },
        startedAt: yield* DateTime.now,
        reason: "oversized",
      })
    // An oversized head still reaches the scheduler: it cancels the active run,
    // drops the queued head and, on a reopen, the pending wipe.
    const head = { ...ids, headSha, oversized }
    yield* event._tag === "Reopened" ? scheduler.Reopened(head) : scheduler.HeadChanged(head)
    return oversized ? "oversized" : "scheduled"
  })

/** The admission workflow; registered with the dispatcher under `PR_REVIEW_ADMISSION_TAG`. */
export const AdmitPullRequestReviewLayer = AdmitPullRequestReview.toLayer((payload) =>
  Effect.gen(function* () {
    // Journaled, so a retried admission records the same skipped run.
    const runId = yield* Activity.make({
      name: "PullRequestReviewAdmission/RunId",
      success: RunId,
      execute: Effect.sync(() => RunId.make(crypto.randomUUID())),
    })
    const outcome = yield* Activity.make({
      name: "PullRequestReviewAdmission/Admit",
      success: Schema.String,
      error: AdmissionError,
      execute: admit(payload, runId).pipe(
        Effect.catchTag("ConfigError", Effect.die),
        Effect.mapError(failure),
      ),
    })
    const event = payload.event
    yield* Effect.logInfo("Admitted PR review event").pipe(
      Effect.annotateLogs({
        event: event._tag,
        outcome,
        ...("headSha" in event ? { headSha: event.headSha } : {}),
        // The `skipped` row an oversized head got.
        ...(outcome === "oversized" ? { runId } : {}),
      }),
    )
  }).pipe(
    logWorkflowFailure("AdmitPullRequestReview"),
    Effect.annotateLogs({ repositoryId: payload.repositoryId, number: payload.number }),
  ),
)

const decodePayload = Schema.decodeUnknownEffect(AdmissionPayload)

export const AdmitPullRequestReviewRegistration: WorkflowRegistration = {
  tag: PR_REVIEW_ADMISSION_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => AdmitPullRequestReview.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
