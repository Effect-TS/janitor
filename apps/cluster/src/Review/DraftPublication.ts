import type { DraftPublication } from "@janitor/domain/Review/Draft"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RepositoryEligibility } from "../RepositoryEligibility.ts"
import { ReviewComments } from "./Comments.ts"
import { draftIntent, permittedSummaryLinks } from "./Output.ts"
import { authorizePublication } from "./PublicationGuard.ts"
import { ReviewPullRequests, type ReproductionPullRequest } from "./PullRequests.ts"
import { IssueReviewError, IssueReviewStore } from "./Store.ts"

export const draftBody = (draft: DraftPublication, runId: string) =>
  `${draft.text.body}\n\n<!-- janitor-reproduction:${runId} -->`
const fingerprint = (text: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  })

/** Separate branch and PR action Activities call this service. Nothing invokes the model. */
export class IssueReviewDraftPublication extends Context.Service<IssueReviewDraftPublication>()(
  "Review/DraftPublication",
  {
    make: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* IssueReviewStore
      const eligibility = yield* RepositoryEligibility
      const github = yield* ReviewPullRequests
      const comments = yield* ReviewComments
      // Capture the dependencies now; authorization still executes inside every write attempt.
      const context =
        yield* Effect.context<Effect.Services<ReturnType<typeof authorizePublication>>>()
      const authorize = (runId: string) => authorizePublication(runId).pipe(Effect.provide(context))

      const publish = (runId: string, action: "branch" | "pr") =>
        Effect.gen(function* () {
          const found = yield* store.run(runId)
          if (Option.isNone(found) || found.value.draftPublication === null) return
          const initial = found.value
          let draft = initial.draftPublication!
          if (!["pending", "branch"].includes(draft.status)) return
          if (action === "pr" && draft.status !== "branch") return
          if (action === "branch" && draft.status === "branch") return
          const repository = (yield* eligibility.list).find(
            (r) => r.repositoryId === initial.repositoryId,
          )
          if (repository === undefined) return
          const save = (next: DraftPublication) =>
            Effect.gen(function* () {
              yield* store.saveDraft(runId, next)
              draft = next
            })
          const fence = (unresolved: boolean) =>
            sql`UPDATE issue_review_issue SET publication_unresolved = ${unresolved} WHERE repository_id = ${initial.repositoryId} AND issue_number = ${initial.issueNumber}`
          const stop = (status: "blocked" | "rejected" | "unresolved", reason: string) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* store.lockIssue(initial.repositoryId, initial.issueNumber)
                const locked = yield* store.lockRun(runId)
                if (Option.isNone(locked) || locked.value.draftPublication === null) return
                const current = locked.value.draftPublication
                if (JSON.stringify(current) !== JSON.stringify(draft)) {
                  draft = current
                  return
                }
                yield* save({
                  ...draft,
                  status,
                  reason:
                    reason +
                    (draft.reuse !== undefined && draft.status === "branch"
                      ? " The branch update completed; PR text was not confirmed."
                      : ""),
                })
                // An unrelated unresolved operation must never be cleared here.
                if (status === "unresolved") yield* fence(true)
                else if (draft.attempted !== null) yield* fence(false)
              }),
            )
          const owned = Effect.gen(function* () {
            const [owner] = yield* sql<{
              run_id: string
              commit_sha: string | null
              pr_hash: string | null
              pr_number: number | null
            }>`SELECT run_id, commit_sha, pr_hash, pr_number FROM issue_review_draft_owner WHERE repository_id = ${initial.repositoryId} AND branch = ${draft.branch}`
            return (
              owner?.run_id === (draft.reuse?.ownerRunId ?? runId) &&
              owner.commit_sha === (draft.reuse?.headSha ?? draft.commitSha) &&
              (draft.reuse === undefined ||
                (owner.pr_hash === draft.reuse.prHash && owner.pr_number === draft.prNumber))
            )
          })
          const matches = (pr: ReproductionPullRequest) =>
            pr.owned &&
            pr.open &&
            pr.draft &&
            (draft.reuse === undefined || pr.number === draft.prNumber) &&
            pr.repositoryId === initial.repositoryId &&
            pr.head === draft.branch &&
            pr.headSha === draft.commitSha &&
            pr.base === draft.defaultBranch &&
            pr.title === draft.text.title &&
            pr.body === draftBody(draft, runId)
          const recordPr = (pr: ReproductionPullRequest) =>
            Effect.gen(function* () {
              const hash = yield* fingerprint(JSON.stringify([pr.title, pr.body]))
              if (draft.reuse !== undefined && hash !== draft.reuse.newPrHash)
                return yield* stop(
                  "unresolved",
                  "The updated PR does not match the intended publication fingerprint.",
                )
              yield* sql`UPDATE issue_review_draft_owner SET pr_number = ${pr.number}, pr_hash = ${hash}, run_id = ${runId}, commit_sha = ${draft.commitSha} WHERE repository_id = ${initial.repositoryId} AND branch = ${draft.branch} AND run_id = ${draft.reuse?.ownerRunId ?? runId}`
              yield* save({
                ...draft,
                status: "published",
                attempted: null,
                prNumber: pr.number,
                url: `https://github.com/${repository.name}/pull/${pr.number}`,
                reason: null,
              })
              yield* fence(false)
            })
          const unchanged = (head: string) =>
            Effect.gen(function* () {
              if (!(yield* owned))
                return yield* Effect.fail(
                  "The reproduction branch is no longer recorded as Janitor-owned.",
                )
              const prs = yield* github.list(repository, draft.branch)
              const pr = prs.find((pr) => pr.number === draft.prNumber)
              if (
                prs.length !== 1 ||
                pr === undefined ||
                !pr.owned ||
                !pr.open ||
                !pr.draft ||
                pr.repositoryId !== initial.repositoryId ||
                pr.head !== draft.branch ||
                pr.base !== draft.reuse!.base ||
                pr.headSha !== head ||
                (yield* github.branch(repository, draft.branch)) !== head ||
                (yield* fingerprint(JSON.stringify([pr.title, pr.body]))) !== draft.reuse!.prHash
              )
                return yield* Effect.fail(
                  "The reproduction branch or PR changed, is missing, or is no longer an open draft. Proposed changes are retained.",
                )
            })
          const selectReuse = Effect.gen(function* () {
            if (draft.reuse !== undefined || draft.treeSha !== null) return
            const owners = yield* sql<{
              branch: string
              run_id: string
              commit_sha: string | null
              pr_number: number
              pr_hash: string | null
              default_branch: string | null
            }>`SELECT branch, run_id, commit_sha, pr_number, pr_hash, default_branch
              FROM issue_review_draft_owner WHERE repository_id = ${initial.repositoryId}
              AND issue_number = ${initial.issueNumber} AND pr_number IS NOT NULL`
            const candidates = []
            const retainPr = (branch: string, number: number) =>
              save({
                ...draft,
                branch,
                prNumber: number,
                url: `https://github.com/${repository.name}/pull/${number}`,
              })
            for (const owner of owners) {
              const prs = yield* github.list(repository, owner.branch)
              const pr = prs.find((pr) => pr.number === owner.pr_number)
              if (pr === undefined) {
                yield* retainPr(owner.branch, owner.pr_number)
                return yield* Effect.fail(
                  "The recorded reproduction PR could not be found. Proposed changes are retained.",
                )
              }
              if (pr.open) candidates.push({ owner, pr })
            }
            if (candidates.length === 0) return
            const { owner, pr } = candidates[0]!
            yield* retainPr(owner.branch, pr.number)
            if (candidates.length !== 1)
              return yield* Effect.fail("Multiple open reproduction PRs require human review.")
            if (
              owner.commit_sha === null ||
              owner.pr_hash === null ||
              owner.default_branch !== draft.defaultBranch
            )
              return yield* Effect.fail(
                "The previous publication fingerprints or tested base branch cannot be established.",
              )
            yield* save({
              ...draft,
              branch: owner.branch,
              prNumber: pr.number,
              url: `https://github.com/${repository.name}/pull/${pr.number}`,
              reuse: {
                ownerRunId: owner.run_id,
                headSha: owner.commit_sha,
                prHash: owner.pr_hash,
                base: owner.default_branch,
                newPrHash: yield* fingerprint(
                  JSON.stringify([draft.text.title, draftBody(draft, runId)]),
                ),
              },
            })
          })
          const reconcile = Effect.gen(function* () {
            if (!(yield* owned))
              return yield* stop("unresolved", "Publication ownership could not be established.")
            if (
              draft.attempted === "branch" &&
              draft.commitSha !== null &&
              (yield* github.branch(repository, draft.branch)) === draft.commitSha
            ) {
              yield* save({ ...draft, status: "branch", attempted: null, reason: null })
              yield* fence(false)
              return
            }
            if (draft.attempted === "pr") {
              const candidates = yield* github.list(repository, draft.branch)
              if (
                candidates.length === 1 &&
                matches(candidates[0]!) &&
                (yield* github.branch(repository, draft.branch)) === draft.commitSha
              )
                return yield* recordPr(candidates[0]!)
            }
            // Unreturned Git object IDs cannot safely be inferred. No ref is retried
            // and later writes stay fenced, including summary publication.
            yield* stop(
              "unresolved",
              "GitHub could not establish the attempted publication outcome. Further writes are blocked.",
            )
          }).pipe(
            Effect.catch(() =>
              stop(
                "unresolved",
                "GitHub could not be read to reconcile publication. Further writes are blocked.",
              ),
            ),
          )

          if (draft.attempted !== null) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT repository_id FROM github_repository WHERE repository_id = ${initial.repositoryId} FOR NO KEY UPDATE`
                yield* store.lockIssue(initial.repositoryId, initial.issueNumber)
                const locked = yield* store.lockRun(runId)
                if (Option.isNone(locked) || locked.value.draftPublication === null) return
                draft = locked.value.draftPublication
                if (draft.attempted !== null) yield* reconcile
              }),
            )
            return
          }

          const preflight = yield* sql.withTransaction(
            Effect.gen(function* () {
              const current = yield* authorize(runId)
              const [issue] = yield* sql<{
                publication_unresolved: boolean
              }>`SELECT publication_unresolved FROM issue_review_issue WHERE repository_id = ${initial.repositoryId} AND issue_number = ${initial.issueNumber}`
              if (issue!.publication_unresolved)
                return yield* Effect.fail(
                  "An earlier publication is unresolved. Further writes are blocked.",
                )
              const checked = draftIntent(current.run, repository.name, draft.text)
              if (
                checked?.status !== "pending" ||
                (draft.reuse === undefined && checked.branch !== draft.branch) ||
                checked.baseCommit !== draft.baseCommit ||
                checked.defaultBranch !== draft.defaultBranch
              )
                return yield* Effect.fail(
                  "The saved reproduction or publication text is not eligible.",
                )
              const links = [
                ...permittedSummaryLinks(current.run, repository.name),
                `https://github.com/${repository.name}/issues/${initial.issueNumber}`,
              ]
              for (const body of [
                draft.text.title,
                draft.text.body,
                draft.text.publishedSummary.replaceAll(
                  "{{pr_url}}",
                  `https://github.com/${repository.name}/issues/${initial.issueNumber}`,
                ),
                draft.text.blockedSummary,
                ...(draft.text.reuseBlockedSummary === undefined
                  ? []
                  : [
                      draft.text.reuseBlockedSummary.replaceAll(
                        "{{pr_url}}",
                        `https://github.com/${repository.name}/issues/${initial.issueNumber}`,
                      ),
                    ]),
              ]) {
                if (!(yield* comments.checkLinks(repository, body, links)))
                  return yield* Effect.fail(
                    "PR text renders a link outside the permitted evidence.",
                  )
              }
              if (action === "branch") yield* selectReuse
              if (draft.reuse !== undefined) {
                yield* unchanged(action === "pr" ? draft.commitSha! : draft.reuse.headSha)
                return current.run.reproduction.patch!
              }
              const head = yield* github.branch(repository, draft.branch)
              const prs = yield* github.list(repository, draft.branch)
              if (action === "branch") {
                if (head !== null || prs.length !== 0)
                  return yield* Effect.fail(
                    "The intended branch or PR already exists without a recorded publication. It will not be overwritten.",
                  )
                yield* sql`INSERT INTO issue_review_draft_owner (repository_id, branch, run_id, issue_number, default_branch) VALUES (${initial.repositoryId}, ${draft.branch}, ${runId}, ${initial.issueNumber}, ${draft.defaultBranch}) ON CONFLICT DO NOTHING`
                if (!(yield* owned))
                  return yield* Effect.fail("The publication identity is owned by another run.")
              } else if (!(yield* owned) || head !== draft.commitSha || prs.length !== 0)
                return yield* Effect.fail(
                  "The owned branch changed or an unrelated PR exists. It will not be overwritten.",
                )
              return current.run.reproduction.patch!
            }).pipe(Effect.result),
          )
          if (preflight._tag === "Failure") {
            yield* stop("blocked", String(preflight.failure))
            return
          }

          // The attempted marker commits independently before any remote mutation.
          const attempt = <A>(
            operation: NonNullable<DraftPublication["attempted"]>,
            write: Effect.Effect<A, unknown>,
            complete: (value: A) => Effect.Effect<void, unknown>,
          ) =>
            Effect.gen(function* () {
              const claimed = yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* store.lockIssue(initial.repositoryId, initial.issueNumber)
                  const locked = yield* store.lockRun(runId)
                  if (Option.isNone(locked) || locked.value.draftPublication === null) return false
                  const current = locked.value.draftPublication
                  if (
                    current.attempted !== null ||
                    current.status !== draft.status ||
                    current.treeSha !== draft.treeSha ||
                    current.commitSha !== draft.commitSha
                  )
                    return false
                  yield* save({ ...current, attempted: operation })
                  yield* fence(true)
                  return true
                }),
              )
              if (!claimed) return false
              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  const grant = yield* authorize(runId).pipe(Effect.result)
                  if (grant._tag === "Failure") {
                    yield* stop("blocked", String(grant.failure))
                    return false
                  }
                  // A concurrent recovery may already have settled this attempt.
                  if (JSON.stringify(grant.success.run.draftPublication) !== JSON.stringify(draft))
                    return false
                  if (draft.reuse !== undefined) {
                    const checked = yield* unchanged(
                      operation === "pr" ? draft.commitSha! : draft.reuse.headSha,
                    ).pipe(Effect.result)
                    if (checked._tag === "Failure") {
                      yield* stop("blocked", String(checked.failure))
                      return false
                    }
                  }
                  const result = yield* write.pipe(Effect.result)
                  if (result._tag === "Failure") {
                    yield* reconcile
                    return false
                  }
                  yield* complete(result.success)
                  if (draft.status !== "unresolved") yield* fence(false)
                  return true
                }),
              )
            })
          if (action === "branch") {
            const validated = yield* github
              .validate(repository, preflight.success)
              .pipe(Effect.result)
            if (validated._tag === "Failure")
              return yield* stop("rejected", String(validated.failure))
            if (
              draft.treeSha === null &&
              !(yield* attempt(
                "tree",
                github.tree(repository, validated.success, preflight.success),
                (treeSha) => save({ ...draft, treeSha, attempted: null }),
              ))
            )
              return
            if (
              draft.commitSha === null &&
              !(yield* attempt(
                "commit",
                github.commit(
                  repository,
                  draft.treeSha!,
                  draft.baseCommit,
                  `${draft.text.title}\n\nJanitor reproduction ${runId}\n`,
                ),
                (commitSha) =>
                  Effect.gen(function* () {
                    if (draft.reuse === undefined)
                      yield* sql`UPDATE issue_review_draft_owner SET commit_sha = ${commitSha} WHERE repository_id = ${initial.repositoryId} AND branch = ${draft.branch} AND run_id = ${runId}`
                    yield* save({ ...draft, commitSha, attempted: null })
                  }),
              ))
            )
              return
            yield* attempt(
              "branch",
              draft.reuse === undefined
                ? github.createBranch(repository, draft.branch, draft.commitSha!)
                : github.updateBranch(repository, draft.branch, draft.commitSha!),
              () => save({ ...draft, status: "branch", attempted: null }),
            )
          } else {
            yield* attempt(
              "pr",
              draft.reuse === undefined
                ? github.create(repository, draft, draftBody(draft, runId))
                : github.update(repository, draft, draftBody(draft, runId)),
              (pr) => (matches(pr) ? recordPr(pr) : reconcile),
            )
          }
        }).pipe(
          Effect.mapError(
            (error) => new IssueReviewError({ operation: "publishDraft", message: String(error) }),
          ),
        )
      return { publish }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
