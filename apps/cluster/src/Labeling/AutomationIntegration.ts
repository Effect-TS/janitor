import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AutomationIntegration } from "../AutomationIntegration.ts"
import { IssueReviewAdmission } from "../Review/Admission.ts"
import { DirectLabelingAdmission } from "./DirectLabeling.ts"
import { type ObservedItem, observedIssue, observedPullRequest } from "./Facts.ts"

/**
 * Issue and pull request events admit direct labeling; the projection stays
 * unaware of labeling. Issue review, when the deployment builds it, admits
 * comment invocations and stops runs of closed issues; without it, comment
 * events only feed the cache.
 */
export const LabelingAutomationIntegrationLayer = Layer.effect(
  AutomationIntegration,
  Effect.gen(function* () {
    const admission = yield* DirectLabelingAdmission
    const review = yield* Effect.serviceOption(IssueReviewAdmission)
    const admit = (
      repositoryId: GitHubRepositoryDatabaseId,
      item: ObservedItem,
      sequence: GitHubWebhookJournalSequence,
    ) =>
      admission.admit({ repositoryId, item, sequence }).pipe(
        Effect.tap((result) =>
          result._tag === "Skipped"
            ? Effect.logDebug("Event not admitted for labeling").pipe(
                Effect.annotateLogs({
                  repositoryId,
                  number: item.number,
                  kind: item.kind,
                  reason: result.reason,
                }),
              )
            : Effect.void,
        ),
        Effect.asVoid,
      )
    return {
      issueEvent: (request) =>
        admit(request.repositoryId, observedIssue(request.issue), request.sequence).pipe(
          Effect.andThen(
            Option.isSome(review) &&
              request.issue.state === "closed" &&
              request.issue.pullRequest === undefined
              ? review.value.issueClosed({
                  repositoryId: request.repositoryId,
                  issueNumber: request.issue.number,
                  deliveryId: request.deliveryId,
                })
              : Effect.void,
          ),
        ),
      issueCommentEvent: (request) => {
        if (Option.isNone(review) || request.payload.issue.pull_request !== undefined)
          return Effect.void
        const { comment } = request.payload
        return request.payload.action === "created"
          ? review.value
              .commentCreated({
                repositoryId: request.repositoryId,
                deliveryId: request.deliveryId,
                receivedAt: request.receivedAt,
                issueNumber: request.payload.issue.number,
                comment: {
                  id: comment.id,
                  body: comment.body,
                  user: { id: comment.user.id, login: comment.user.login, type: comment.user.type },
                },
              })
              .pipe(
                Effect.tap((outcome) =>
                  outcome._tag === "Ignored"
                    ? Effect.void
                    : Effect.logInfo("Issue review invocation received").pipe(
                        Effect.annotateLogs({
                          repositoryId: request.repositoryId,
                          commentId: comment.id,
                          outcome: outcome._tag,
                        }),
                      ),
                ),
                Effect.asVoid,
              )
          : review.value.commentChanged({
              repositoryId: request.repositoryId,
              commentId: comment.id,
              action: request.payload.action,
              deliveryId: request.deliveryId,
            })
      },
      pullRequestEvent: (request) =>
        admit(request.repositoryId, observedPullRequest(request.pullRequest), request.sequence),
    }
  }),
).pipe(Layer.provide(DirectLabelingAdmission.layer))
