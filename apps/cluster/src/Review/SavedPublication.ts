import { GITHUB_WORKSPACE_ID, type TeammateId } from "@janitor/domain/Team/Account"
import type { SavedPublication } from "@janitor/domain/Review/Publication"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubTransport } from "../GitHub/Transport.ts"
import { repositoryTarget } from "../Labeling/GitHubIssue.ts"
import { RepositoryEligibility } from "../RepositoryEligibility.ts"
import { checkInvocationSource, effectivePermission } from "./Authority.ts"
import { IssueReviewAvailable } from "./Gate.ts"
import { IssueReviewStore, type RunRecord } from "./Store.ts"

export const linkedPublisher = (teammateId: TeammateId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [link] = yield* sql<{ account_id: string; display_name: string }>`
    SELECT l.account_id, l.display_name FROM teammate_link l
    JOIN teammate t ON t.teammate_id = l.teammate_id
    WHERE t.teammate_id::text = ${teammateId} AND t.status = 'active'
      AND l.platform = 'github' AND l.workspace_id = ${GITHUB_WORKSPACE_ID}
      AND l.status = 'active'`
    if (link === undefined)
      return yield* Effect.fail("Connect an active GitHub account to publish results.")
    return link
  })

/** The caller holds the repository, issue and run locks when granting or using authority. */
export const authorizeSavedPublication = (
  run: RunRecord,
  publisher: Pick<SavedPublication, "teammateId" | "githubId">,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const store = yield* IssueReviewStore
    const repository = yield* (yield* RepositoryEligibility).get(run.repositoryId)
    const settings = yield* store.settings(run.repositoryId)
    if (
      !(yield* IssueReviewAvailable) ||
      repository.generation !== run.eligibilityGeneration ||
      !Option.exists(settings, (s) => s.enabled) ||
      !run.dryRun ||
      run.status !== "completed" ||
      run.cancelReason !== null ||
      run.finishedAt === null ||
      run.findings === null
    )
      return yield* Effect.fail(
        "This saved result or repository is no longer eligible for publication.",
      )
    const [latest] = yield* sql<{
      run_id: string
      retained: boolean
    }>`SELECT run_id::text, accepted_at > CLOCK_TIMESTAMP() - INTERVAL '14 days' AS retained FROM issue_review_run
    WHERE repository_id = ${run.repositoryId} AND issue_number = ${run.issueNumber}
    ORDER BY accepted_at DESC, run_id DESC LIMIT 1`
    if (latest?.run_id === run.runId && !latest.retained)
      return yield* Effect.fail("The saved result has expired after 14 days.")
    const issue = yield* store.lockIssue(run.repositoryId, run.issueNumber)
    if (
      latest?.run_id !== run.runId ||
      (issue.activeRunId !== null && issue.activeRunId !== run.runId)
    )
      return yield* Effect.fail(
        "A newer invocation or active run blocks publication of this result.",
      )
    const link = yield* linkedPublisher(publisher.teammateId)
    if (link.account_id !== publisher.githubId)
      return yield* Effect.fail("The publisher's linked GitHub identity changed.")
    const transport = yield* GitHubTransport
    const target = repositoryTarget(repository)
    const source = yield* checkInvocationSource(target, run.repositoryId, {
      issueNumber: run.issueNumber,
      commentId: run.commentId,
      authorId: run.invokerId,
      authorLogin: run.invokerLogin,
      body: run.instructions,
    }).pipe(
      Effect.provideService(GitHubTransport, {
        request: (request) =>
          transport.request({
            ...request,
            repositoryPermission: { repositoryId: run.repositoryId, issues: "read" },
          }),
      }),
    )
    if (source._tag === "Denied") return yield* Effect.fail(source.reason)
    const permission = yield* effectivePermission(target, link.display_name, link.account_id)
    if (permission._tag === "Insufficient")
      return yield* Effect.fail(
        "The publisher needs current write or admin permission on this repository.",
      )
    return { run, repository, login: permission.login }
  })

export const savedPublicationOutcome = (run: RunRecord): SavedPublication["status"] => {
  const summary = run.publication.status
  const draft = run.draftPublication
  if (summary === "unresolved" || draft?.status === "unresolved") return "unresolved"
  if (summary === "published" && (draft === null || draft.status === "published"))
    return "completed"
  if (summary === "published" || draft?.status === "published" || draft?.commitSha != null)
    return "partial"
  return "blocked"
}
