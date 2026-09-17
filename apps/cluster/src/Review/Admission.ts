import { mentionsDirectly, REVIEW_MENTION_HANDLE } from "@janitor/domain/Review/Mention"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as Workflow from "effect/unstable/workflow/Workflow"
import { logWorkflowFailure, withRateLimitWaits } from "../GitHub/SyncSupport.ts"
import { repositoryTarget } from "../Labeling/GitHubIssue.ts"
import { flushLive } from "../LiveUpdates.ts"
import { changedReason, RepositoryEligibility } from "../RepositoryEligibility.ts"
import { describeError } from "../SqlErrors.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { type Authority, checkInvocation, deniedReasons } from "./Authority.ts"
import { disabledReason, IssueReviewAvailable, unavailableReason } from "./Gate.ts"
import { IssueReviewScheduler } from "./Scheduler.ts"
import { IssueReviewStore } from "./Store.ts"

/**
 * Admission of GitHub invocations (ADR 0007). The webhook projection, inside
 * the repository fence, records a receipt for every comment that mentions
 * Janitor and schedules the admission workflow through the outbox. The
 * workflow then asks GitHub about the issue, the comment and the author's
 * permission, and either queues a run or settles the receipt as denied.
 * Delivery replay finds the receipt and creates nothing.
 */

export const ADMIT_REVIEW_TAG = "Janitor/AdmitReviewV1"

export const AdmitReviewPayload = Schema.Struct({
  repositoryId: Schema.String,
  commentId: Schema.String,
})
export type AdmitReviewPayload = typeof AdmitReviewPayload.Type

export const admitReviewKey = ({ repositoryId, commentId }: AdmitReviewPayload) =>
  `review-admit:${repositoryId}:${commentId}`

export interface CommentCreated {
  readonly repositoryId: string
  readonly deliveryId: string
  /** When the delivery arrived; a delivery without one is never admitted. */
  readonly receivedAt: Date | undefined
  readonly issueNumber: number
  readonly comment: {
    readonly id: string
    readonly body: string
    readonly user: { readonly id: string; readonly login: string; readonly type: string }
  }
}

export type AdmissionOutcome =
  | { readonly _tag: "Scheduled" }
  | { readonly _tag: "Ignored"; readonly reason: string }
  | { readonly _tag: "Denied"; readonly reason: string }

export const admissionReasons = {
  noMention: "no direct mention",
  duplicate: "the comment already has a receipt",
  disabled: disabledReason,
  beforeEnablement: "The comment was posted before issue review was enabled.",
  unknownReceipt: "The delivery carries no receipt time, so it cannot be placed after enablement.",
  edited: "The invoking comment was edited. Post a new invocation.",
  deleted: "The invoking comment was deleted. Post a new invocation.",
  issueClosed: "The issue was closed.",
} as const

export class IssueReviewAdmission extends Context.Service<
  IssueReviewAdmission,
  {
    /** A created comment on an issue, after the repository fence admitted the delivery. */
    readonly commentCreated: (request: CommentCreated) => Effect.Effect<AdmissionOutcome, Error>
    /** An edited or deleted comment: its invocation, if any, can no longer be used. */
    readonly commentChanged: (request: {
      readonly repositoryId: string
      readonly commentId: string
      readonly action: "edited" | "deleted"
      readonly deliveryId: string
    }) => Effect.Effect<void, Error>
    /** The issue was closed: its active run stops and queued runs are cancelled. */
    readonly issueClosed: (request: {
      readonly repositoryId: string
      readonly issueNumber: number
      readonly deliveryId: string
    }) => Effect.Effect<void, Error>
  }
>()("@janitor/cluster/Review/IssueReviewAdmission", {
  make: Effect.gen(function* () {
    const store = yield* IssueReviewStore
    const eligibility = yield* RepositoryEligibility
    const outbox = yield* WorkflowOutbox
    const scheduler = yield* IssueReviewScheduler
    const available = yield* IssueReviewAvailable
    const toError = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
      Effect.mapError(effect, (error) => new Error(describeError(error)))

    const commentCreated = Effect.fn("IssueReviewAdmission.commentCreated")(function* (
      request: CommentCreated,
    ) {
      const { repositoryId, comment } = request
      if (!mentionsDirectly(comment.body, REVIEW_MENTION_HANDLE))
        return { _tag: "Ignored", reason: admissionReasons.noMention } as const
      const repository = yield* eligibility
        .get(repositoryId)
        .pipe(
          Effect.catchTag("@janitor/cluster/RepositoryEligibility/RepositoryBlocked", (blocked) =>
            Effect.succeed(blocked),
          ),
        )
      if ("reason" in repository) return { _tag: "Ignored", reason: repository.reason } as const
      const settings = yield* store.settings(repositoryId)
      // The whole judgement is recorded with the receipt so a replay finds it.
      const denied = !available
        ? unavailableReason
        : comment.user.type !== "User"
          ? deniedReasons.bot
          : Option.isNone(settings) || !settings.value.enabled
            ? admissionReasons.disabled
            : request.receivedAt === undefined
              ? admissionReasons.unknownReceipt
              : DateTime.toEpochMillis(settings.value.admitAfter) >= request.receivedAt.getTime()
                ? admissionReasons.beforeEnablement
                : undefined
      const recorded = yield* store.recordReceipt({
        repositoryId,
        commentId: comment.id,
        deliveryId: request.deliveryId,
        issueNumber: request.issueNumber,
        authorId: comment.user.id,
        authorLogin: comment.user.login,
        body: comment.body,
        receivedAt: request.receivedAt ?? new Date(0),
        eligibilityGeneration: repository.generation,
        denied,
      })
      if (!recorded) return { _tag: "Ignored", reason: admissionReasons.duplicate } as const
      if (denied !== undefined) {
        yield* Effect.logInfo("Denied issue review invocation").pipe(
          Effect.annotateLogs({ repositoryId, commentId: comment.id, reason: denied }),
        )
        return { _tag: "Denied", reason: denied } as const
      }
      const payload: AdmitReviewPayload = { repositoryId, commentId: comment.id }
      yield* outbox.enqueue({
        workflowTag: ADMIT_REVIEW_TAG,
        executionKey: admitReviewKey(payload),
        payload,
      })
      yield* Effect.logInfo("Scheduled issue review admission").pipe(
        Effect.annotateLogs({ repositoryId, commentId: comment.id, issue: request.issueNumber }),
      )
      return { _tag: "Scheduled" } as const
    }, toError)

    const commentChanged = Effect.fn("IssueReviewAdmission.commentChanged")(function* (request: {
      readonly repositoryId: string
      readonly commentId: string
      readonly action: "edited" | "deleted"
      readonly deliveryId: string
    }) {
      const reason =
        request.action === "edited" ? admissionReasons.edited : admissionReasons.deleted
      // A pending receipt settles as denied so the admission workflow queues nothing.
      yield* store.decideReceipt(request.repositoryId, request.commentId, {
        outcome: "denied",
        reason,
      })
      yield* scheduler.cancel(
        { repositoryId: request.repositoryId, commentId: request.commentId },
        { messageId: `comment-${request.action}:${request.deliveryId}`, reason, actor: null },
      )
    }, toError)

    const issueClosed = Effect.fn("IssueReviewAdmission.issueClosed")(function* (request: {
      readonly repositoryId: string
      readonly issueNumber: number
      readonly deliveryId: string
    }) {
      yield* scheduler.cancel(
        { repositoryId: request.repositoryId, issueNumber: request.issueNumber },
        {
          messageId: `issue-closed:${request.deliveryId}`,
          reason: admissionReasons.issueClosed,
          actor: null,
        },
      )
    }, toError)

    return { commentCreated, commentChanged, issueClosed }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// WORKFLOW

export class AdmitReviewError extends Schema.TaggedError<AdmitReviewError>()("AdmitReviewError", {
  message: Schema.String,
}) {}

export const AdmitReviewResult = Schema.Struct({
  outcome: Schema.Literals(["admitted", "denied", "settled"]),
  reason: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
})

export const AdmitReview = Workflow.make(ADMIT_REVIEW_TAG, {
  payload: AdmitReviewPayload,
  success: AdmitReviewResult,
  error: AdmitReviewError,
  idempotencyKey: admitReviewKey,
})

const failure = (error: { readonly message: string }) =>
  new AdmitReviewError({ message: describeError(error) })

/** The receipt was settled by an edit or deletion while the decision ran. */
class ReceiptSettled extends Schema.TaggedError<ReceiptSettled>()("ReceiptSettled", {}) {}

/**
 * Verifies the invocation against GitHub, then queues the run inside the
 * repository fence with the receipt still pending and the eligibility
 * generation unchanged. GitHub reads happen in the workflow body, so a
 * replay reads again; the decision is one memoized activity.
 */
export const AdmitReviewLayer = AdmitReview.toLayer(
  Effect.fnUntraced(function* (payload) {
    const { repositoryId, commentId } = payload
    const store = yield* IssueReviewStore
    const eligibility = yield* RepositoryEligibility
    const scheduler = yield* IssueReviewScheduler
    const available = yield* IssueReviewAvailable

    const receipt = yield* store.receipt(repositoryId, commentId).pipe(Effect.mapError(failure))
    if (Option.isNone(receipt)) return yield* failure({ message: "the receipt no longer exists" })
    if (receipt.value.outcome !== "pending")
      return {
        outcome: "settled",
        reason: receipt.value.reason,
        runId: receipt.value.runId,
      } as const

    const { issueNumber, authorId, authorLogin, body, eligibilityGeneration } = receipt.value
    const resolveAuthority = Effect.gen(function* () {
      const repository = yield* eligibility.get(repositoryId).pipe(Effect.result)
      if (repository._tag === "Failure") {
        if (repository.failure._tag !== "@janitor/cluster/RepositoryEligibility/RepositoryBlocked")
          return yield* failure(repository.failure)
        return { _tag: "Denied", reason: repository.failure.reason } satisfies Authority
      }
      if (repository.success.generation !== eligibilityGeneration)
        return { _tag: "Denied", reason: changedReason } satisfies Authority
      return yield* withRateLimitWaits("AdmitReview/GitHub", () =>
        checkInvocation(repositoryTarget(repository.success), repositoryId, {
          issueNumber,
          commentId,
          authorId,
          authorLogin,
          body,
        }),
      ).pipe(Effect.mapError(failure))
    })
    const authority: Authority = yield* resolveAuthority

    const decided = yield* Activity.make({
      name: "AdmitReview/Decide",
      success: AdmitReviewResult,
      error: AdmitReviewError,
      execute: Effect.gen(function* () {
        if (authority._tag === "Denied") {
          yield* store.decideReceipt(repositoryId, commentId, {
            outcome: "denied",
            reason: authority.reason,
          })
          return { outcome: "denied", reason: authority.reason, runId: null } as const
        }
        // The fence holds the repository row through the insert, so a pause
        // or disconnection waits for it and then cancels what it admitted.
        const admitted = yield* eligibility.run(
          repositoryId,
          Effect.gen(function* () {
            const settings = yield* store.settings(repositoryId)
            const current = yield* store.receipt(repositoryId, commentId)
            if (Option.isNone(current) || current.value.outcome !== "pending")
              return { outcome: "settled", reason: null, runId: null } as const
            const enabled = Option.isSome(settings) && settings.value.enabled
            if (!available || !enabled) {
              const denied = available ? admissionReasons.disabled : unavailableReason
              yield* store.decideReceipt(repositoryId, commentId, {
                outcome: "denied",
                reason: denied,
              })
              return { outcome: "denied", reason: denied, runId: null } as const
            }
            const run = yield* store.insertRun({
              repositoryId,
              issueNumber,
              issueId: authority.issueId,
              commentId,
              invokerId: authorId,
              invokerLogin: authority.login,
              instructions: authority.instructions,
              commentCreatedAt: authority.commentCreatedAt,
              eligibilityGeneration,
              dryRun: settings.value.dryRun,
            })
            // An edit or deletion that settled the receipt meanwhile wins:
            // the transaction rolls the run back.
            const admitted = yield* store.decideReceipt(repositoryId, commentId, {
              outcome: "admitted",
              runId: run.runId,
            })
            if (!admitted) return yield* new ReceiptSettled()
            return { outcome: "admitted", reason: null, runId: run.runId } as const
          }),
          { generation: eligibilityGeneration },
        )
        return admitted
      }).pipe(
        Effect.catchTag("ReceiptSettled", () =>
          Effect.succeed({ outcome: "settled", reason: null, runId: null } as const),
        ),
        Effect.catchTag("@janitor/cluster/RepositoryEligibility/RepositoryBlocked", (blocked) =>
          store
            .decideReceipt(repositoryId, commentId, { outcome: "denied", reason: blocked.reason })
            .pipe(Effect.as({ outcome: "denied", reason: blocked.reason, runId: null } as const)),
        ),
        Effect.mapError(failure),
      ),
    })

    if (decided.outcome === "admitted")
      yield* scheduler.advance(repositoryId, issueNumber).pipe(Effect.mapError(failure))
    yield* flushLive
    yield* Effect.logInfo("Decided issue review admission").pipe(
      Effect.annotateLogs({ repositoryId, commentId, outcome: decided.outcome }),
    )
    return decided
  }, logWorkflowFailure("AdmitReview")),
)

const decodePayload = Schema.decodeUnknownEffect(AdmitReviewPayload)

export const AdmitReviewRegistration: WorkflowRegistration = {
  tag: ADMIT_REVIEW_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => AdmitReview.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
