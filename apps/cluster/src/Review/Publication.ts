import { reviewIsRetained } from "./Retention.ts"
import { authorizePublication } from "./PublicationGuard.ts"
import { permittedSummaryLinks, summaryIntent } from "./Output.ts"
import type { ReviewPublication } from "@janitor/domain/Review/Publication"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RepositoryEligibility } from "../RepositoryEligibility.ts"
import { ReviewComments, type SummaryComment } from "./Comments.ts"
import { IssueReviewError, IssueReviewStore } from "./Store.ts"

const fingerprint = (body: string) =>
  Effect.promise(async () => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")
  })

/** Called inside the publication Activity. Intent and attempt survive its interruption. */
export class IssueReviewPublication extends Context.Service<IssueReviewPublication>()(
  "Review/Publication",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* IssueReviewStore
      const eligibility = yield* RepositoryEligibility
      const comments = yield* ReviewComments
      const context =
        yield* Effect.context<Effect.Services<ReturnType<typeof authorizePublication>>>()

      const publish = (runId: string) =>
        Effect.gen(function* () {
          const found = yield* store.run(runId)
          if (Option.isNone(found)) return
          const initial = found.value
          if (!["pending", "attempted"].includes(initial.publication.status)) return
          // Commit the attempted state BEFORE the external write. A rollback or
          // process loss after this point can only reconcile, never resend blindly.
          const claimed = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* store.lockIssue(initial.repositoryId, initial.issueNumber)
              const current = yield* store.lockRun(runId)
              if (Option.isNone(current) || current.value.publication.status !== "pending")
                return false
              const [issue] = yield* sql<{
                summary_comment_id: string | null
                publication_unresolved: boolean
              }>`
          SELECT summary_comment_id, publication_unresolved FROM issue_review_issue
          WHERE repository_id = ${initial.repositoryId} AND issue_number = ${initial.issueNumber}`
              if (issue!.publication_unresolved) {
                yield* store.savePublication(runId, {
                  ...current.value.publication,
                  status: "blocked",
                  reason: "An earlier publication is unresolved. Further writes are blocked.",
                })
                return false
              }
              const draft = current.value.draftPublication
              if (
                draft !== null &&
                draft.prNumber !== null &&
                draft.status !== "published" &&
                draft.text.reuseBlockedSummary === undefined
              ) {
                yield* store.savePublication(runId, {
                  ...current.value.publication,
                  status: "blocked",
                  reason:
                    "The saved result has no summary for an incomplete update to an existing PR. The previous summary is retained.",
                })
                return false
              }
              const intent =
                draft === null
                  ? current.value.publication
                  : summaryIntent(
                      current.value,
                      (yield* eligibility.list).find((r) => r.repositoryId === initial.repositoryId)
                        ?.name ?? "",
                      draft.status === "published" && draft.url !== null
                        ? draft.text.publishedSummary.replaceAll("{{pr_url}}", draft.url)
                        : draft.prNumber !== null && draft.url !== null
                          ? draft.text.reuseBlockedSummary!.replaceAll("{{pr_url}}", draft.url)
                          : draft.text.blockedSummary,
                    )
              if (intent.status === "rejected") {
                yield* store.savePublication(runId, intent)
                return false
              }
              yield* store.savePublication(runId, {
                ...intent,
                status: "attempted",
                commentId: issue!.summary_comment_id,
              })
              yield* sql`UPDATE issue_review_issue SET publication_unresolved = TRUE
          WHERE repository_id = ${initial.repositoryId} AND issue_number = ${initial.issueNumber}`
              return true
            }),
          )

          // Lock order matches repository controls: repository, issue, run.
          // Recovery reads do not require publication authority, even after cancellation.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${initial.repositoryId} FOR NO KEY UPDATE`
              const repository = (yield* eligibility.list).find(
                (r) => r.repositoryId === initial.repositoryId,
              )
              if (repository === undefined) return
              yield* store.lockIssue(initial.repositoryId, initial.issueNumber)
              const locked = yield* store.lockRun(runId)
              if (Option.isNone(locked)) return
              const run = locked.value
              const intent = run.publication
              if (intent.status !== "attempted" || intent.body === null) return
              const body = intent.body
              const [owner] = yield* sql<{
                summary_hash: string | null
              }>`SELECT summary_hash FROM issue_review_issue
          WHERE repository_id = ${run.repositoryId} AND issue_number = ${run.issueNumber}`
              const save = (
                status: ReviewPublication["status"],
                reason: string | null,
                comment?: SummaryComment,
              ) =>
                Effect.gen(function* () {
                  yield* store.savePublication(runId, {
                    ...intent,
                    status,
                    reason,
                    commentId: comment?.id ?? intent.commentId,
                    url:
                      comment === undefined
                        ? intent.url
                        : `https://github.com/${repository.name}/issues/${run.issueNumber}#issuecomment-${comment.id}`,
                  })
                  if (status === "published" && comment !== undefined) {
                    const hash = yield* fingerprint(comment.body)
                    yield* sql`UPDATE issue_review_issue SET summary_comment_id = ${comment.id}, summary_hash = ${hash}, publication_unresolved = FALSE
              WHERE repository_id = ${run.repositoryId} AND issue_number = ${run.issueNumber}`
                  } else if (status === "blocked" || status === "rejected") {
                    yield* sql`UPDATE issue_review_issue SET publication_unresolved = FALSE
              WHERE repository_id = ${run.repositoryId} AND issue_number = ${run.issueNumber}`
                  }
                })
              const reconcile = Effect.gen(function* () {
                const candidates =
                  intent.commentId === null
                    ? yield* comments.list(repository, run.issueNumber)
                    : [yield* comments.get(repository, intent.commentId)].filter(
                        (c): c is SummaryComment => c !== null,
                      )
                const matches = candidates.filter((c) => c.body === body)
                if (matches.length === 1) return yield* save("published", null, matches[0])
                yield* save(
                  "unresolved",
                  "GitHub could not establish whether the intended summary was written. Further writes are blocked.",
                )
              }).pipe(
                Effect.catch(() =>
                  save(
                    "unresolved",
                    "GitHub could not be read to reconcile the summary. Further writes are blocked.",
                  ),
                ),
              )
              if (!claimed) return yield* reconcile

              const authority = yield* authorizePublication(runId).pipe(
                Effect.provide(context),
                Effect.result,
              )
              if (authority._tag === "Failure")
                return yield* save(
                  "blocked",
                  typeof authority.failure === "string"
                    ? authority.failure
                    : "Publication authority could not be verified.",
                )
              const checked = yield* comments
                .checkLinks(repository, body, permittedSummaryLinks(run, repository.name))
                .pipe(Effect.result)
              if (checked._tag === "Failure")
                return yield* save(
                  "blocked",
                  "GitHub could not validate the summary's rendered links.",
                )
              if (!checked.success)
                return yield* save(
                  "rejected",
                  "GitHub rendered a summary link outside the permitted evidence.",
                )
              if (intent.commentId !== null) {
                const existing = yield* comments
                  .get(repository, intent.commentId)
                  .pipe(Effect.result)
                if (
                  existing._tag === "Failure" ||
                  existing.success === null ||
                  (yield* fingerprint(existing.success.body)) !== owner?.summary_hash
                )
                  return yield* save(
                    "blocked",
                    "The owned summary was deleted, edited, or could not be verified.",
                  )
              }
              if (!(yield* reviewIsRetained(runId))) {
                yield* sql`UPDATE issue_review_issue SET publication_unresolved = FALSE
                  WHERE repository_id = ${run.repositoryId} AND issue_number = ${run.issueNumber}`
                return
              }
              const written = yield* comments
                .write(repository, run.issueNumber, intent.commentId, body)
                .pipe(Effect.result)
              if (
                written._tag === "Success" &&
                written.success.body === body &&
                (intent.commentId === null || written.success.id === intent.commentId)
              )
                return yield* save("published", null, written.success)
              yield* reconcile
            }),
          )
        }).pipe(
          Effect.mapError(
            (error) =>
              new IssueReviewError({ operation: "publishSummary", message: String(error) }),
          ),
        )
      return { publish }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
