import { authorizeSavedPublication } from "./SavedPublication.ts"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubTransport } from "../GitHub/Transport.ts"
import { repositoryTarget } from "../Labeling/GitHubIssue.ts"
import { RepositoryEligibility } from "../RepositoryEligibility.ts"
import { checkInvocation } from "./Authority.ts"
import { IssueReviewAvailable } from "./Gate.ts"
import { IssueReviewStore } from "./Store.ts"

/** Call inside the write transaction, never through a cached authorization Activity. */
export const authorizePublication = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const store = yield* IssueReviewStore
    const eligibility = yield* RepositoryEligibility
    const available = yield* IssueReviewAvailable
    const transport = yield* GitHubTransport
    const found = yield* store.run(runId)
    if (Option.isNone(found)) return yield* Effect.fail("The review run no longer exists.")
    yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${found.value.repositoryId} FOR NO KEY UPDATE`
    const issue = yield* store.lockIssue(found.value.repositoryId, found.value.issueNumber)
    const locked = yield* store.lockRun(runId)
    if (Option.isNone(locked)) return yield* Effect.fail("The review run no longer exists.")
    const run = locked.value
    if (run.savedPublication?.status === "pending")
      return yield* authorizeSavedPublication(run, run.savedPublication)
    const repository = yield* eligibility.get(run.repositoryId)
    const settings = yield* store.settings(run.repositoryId)
    if (
      !available ||
      repository.generation !== run.eligibilityGeneration ||
      !Option.exists(settings, (s) => s.enabled) ||
      run.status !== "running" ||
      issue.activeRunId !== runId
    )
      return yield* Effect.fail("The run or repository is no longer eligible for publication.")
    if (run.dryRun || Option.exists(settings, (s) => s.dryRun))
      return yield* Effect.fail("Dry-run blocks automatic publication.")
    const authority = yield* checkInvocation(repositoryTarget(repository), run.repositoryId, {
      issueNumber: run.issueNumber,
      commentId: run.commentId,
      authorId: run.invokerId,
      authorLogin: run.invokerLogin,
      body: run.instructions,
    }).pipe(
      Effect.provideService(GitHubTransport, {
        request: (r) =>
          transport.request({
            ...r,
            repositoryPermission: { repositoryId: run.repositoryId, issues: "read" },
          }),
      }),
    )
    if (authority._tag === "Denied") return yield* Effect.fail(authority.reason)
    return { run, repository }
  })
