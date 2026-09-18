import { IssueReviewDraftPublication } from "./DraftPublication.ts"
import { IssueReviewPublication } from "./Publication.ts"
import * as Semaphore from "effect/Semaphore"
import { ReviewConclusion } from "@janitor/domain/Review/Findings"
import { ReproductionPrText } from "@janitor/domain/Review/Draft"
import type { Reproduction, TestAttempt } from "@janitor/domain/Review/Reproduction"
import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import * as Workflow from "effect/unstable/workflow/Workflow"
import {
  logWorkflowFailure,
  type SyncActivityError,
  type SyncRateLimited,
} from "../GitHub/SyncSupport.ts"
import { GitHubTransport } from "../GitHub/Transport.ts"
import { type RepositoryTarget, repositoryTarget } from "../Labeling/GitHubIssue.ts"
import { changedReason, RepositoryEligibility } from "../RepositoryEligibility.ts"
import { describeError } from "../SqlErrors.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import {
  actionMessageId,
  limitations,
  REVIEW_ACTION_TAG,
  ReviewActionPayload,
  reviewActionKey,
} from "./Actions.ts"
import { ReviewAgentClient } from "./Agent.ts"
import { checkInvocation } from "./Authority.ts"
import {
  ActionResult,
  buildPrompt,
  type ModelResult,
  type ObservedItem,
  type PrepareResult,
  type Prepared,
  type Round,
  type ToolRecord,
} from "./Conversation.ts"
import {
  fetchIssueEvidence,
  fetchTree,
  fetchBlob,
  fetchItem,
  fetchRevision,
  searchItems,
  waitsWithin,
} from "./Evidence.ts"
import { type ActionRow, IssueReviewStore, type RunRecord } from "./Store.ts"
import { ReviewWorkspaces } from "./Workspace.ts"
import { ProposedFiles, canonicalPath, validatePatch } from "./Patch.ts"
import { AssessmentInput, assessReproduction } from "./Reproduction.ts"

/**
 * The embedded action workflow of a review run (ADR 0012): one execution
 * per scheduled action, keyed by run and sequence. `prepare` refreshes the
 * invoker's authority, records the default-branch commit, gathers the
 * issue's evidence and provisions the sandbox; every later action is one
 * model invocation whose tool calls trusted handlers execute. The result is
 * recorded once and the agent is told; a resumed execution finds the
 * recorded result and repeats no model call.
 */

export class ReviewActionError extends Schema.TaggedError<ReviewActionError>()(
  "ReviewActionError",
  {
    message: Schema.String,
  },
) {}

export const ReviewActionOutcome = Schema.Struct({
  /** The tag of the recorded result. */
  result: Schema.String,
  /** Whether this execution recorded it, as opposed to finding it recorded. */
  recorded: Schema.Boolean,
})

export const ReviewAction = Workflow.make(REVIEW_ACTION_TAG, {
  payload: ReviewActionPayload,
  success: ReviewActionOutcome,
  error: ReviewActionError,
  idempotencyKey: reviewActionKey,
})

const failure = (error: { readonly message: string }) =>
  new ReviewActionError({ message: describeError(error) })

const TOOL_RESULT_LIMIT = 16_000
/** How long after the deadline a completion is still worth delivering. */
const NOTIFY_GRACE = Duration.minutes(5)

const bounded = (text: string) =>
  text.length > TOOL_RESULT_LIMIT
    ? `${text.slice(0, TOOL_RESULT_LIMIT)}\n[Output truncated. Narrow the request.]`
    : text

/** The model's tools: typed reads of this repository and of the checkout, and `finish`. */
const tools = Toolkit.make(
  Tool.make("searchItems", {
    description:
      "Search this repository's open and closed issues and pull requests. Give a few distinctive words; the repository is fixed. Returns up to ten items with number, kind, state and a snippet.",
    parameters: Schema.Struct({ terms: Schema.String }),
    success: Schema.String,
  }),
  Tool.make("readItem", {
    description:
      "Read one issue or pull request of this repository by number, with its body and first page of comments.",
    parameters: Schema.Struct({ number: Schema.Int }),
    success: Schema.String,
  }),
  Tool.make("listFiles", {
    description: "List a directory of the checkout. Use . for the root.",
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.String,
  }),
  Tool.make("readFile", {
    description:
      "Read a UTF-8 file of the checkout with line numbers, at most 200 lines from the 1-based offset.",
    parameters: Schema.Struct({
      path: Schema.String,
      offset: Schema.NullOr(Schema.Int),
      limit: Schema.NullOr(Schema.Int),
    }),
    success: Schema.String,
  }),
  Tool.make("searchFiles", {
    description:
      "Search the checkout with a ripgrep regular expression, optionally under a path. Returns matching lines with file and line number.",
    parameters: Schema.Struct({ pattern: Schema.String, path: Schema.NullOr(Schema.String) }),
    success: Schema.String,
  }),
  Tool.make("proposeTests", {
    description:
      "Validate and save complete UTF-8 test files against the recorded base and discovered test layout. Replaces the previous proposal. No fixes or configuration changes.",
    parameters: Schema.Struct({ files: ProposedFiles }),
    success: Schema.String,
  }),
  Tool.make("execute", {
    description:
      "Execute setup or a minimal test inside the sandbox. Installation and testing share the run deadline. Test commands must name a proposed test path. null commitSha selects the recorded default-branch commit; a full historical SHA permits comparison. Tracked files are restored and the saved patch applied before each command. Results are persisted.",
    parameters: Schema.Struct({
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
      kind: Schema.Literals(["setup", "test"]),
      testPath: Schema.NullOr(Schema.String),
      commitSha: Schema.NullOr(Schema.String),
    }),
    success: Schema.String,
  }),
  Tool.make("assessReproduction", {
    description:
      "Record a reproduction assessment. Quote an actual test name and output excerpt for each attempt, explain relevance, and state unverified parts. Duplicate suppression requires excerpts from an inspected existing issue.",
    parameters: AssessmentInput,
    success: Schema.String,
  }),
  Tool.make("finish", {
    description:
      "Record the review and end the run. classification is bug, enhancement, question or unclear. findings and uncertainty are prose for a maintainer. evidence lists the issues, pull requests and files you looked at: kind is issue, pull_request or file; reference is the number or the path; note says why it matters.",
    parameters: Schema.Struct({
      reproductionPr: Schema.optionalKey(Schema.NullOr(ReproductionPrText)),
      classification: Schema.String,
      findings: Schema.String,
      uncertainty: Schema.String,
      evidence: Schema.Array(
        Schema.Struct({ kind: Schema.String, reference: Schema.String, note: Schema.String }),
      ),
    }),
    success: Schema.String,
  }),
)

const decodeConclusion = Schema.decodeUnknownEffect(ReviewConclusion)
const decodeResult = Schema.decodeUnknownEffect(ActionResult)

const providerFailure = (error: unknown, now: number) => {
  if (Cause.isTimeoutError(error)) return { _tag: "TimedOut" as const }
  if (!AiError.isAiError(error)) return { _tag: "Failed" as const, retryAfterMs: null }
  const reason = error.reason
  const headers = "http" in reason ? reason.http?.response?.headers : undefined
  const header = headers?.["retry-after"]
  const seconds = typeof header === "string" && header.trim() !== "" ? Number(header) : NaN
  const date = typeof header === "string" ? Date.parse(header) : NaN
  const guidance = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Number.isFinite(date)
      ? Math.max(0, date - now)
      : 0
  const retryAfterMs = Math.max(
    guidance,
    reason._tag === "RateLimitError" && reason.retryAfter
      ? Duration.toMillis(reason.retryAfter)
      : 0,
  )
  return reason.isRetryable
    ? { _tag: "Retry" as const, retryAfterMs: Math.max(retryAfterMs, 1_000) }
    : { _tag: "Failed" as const, category: reason._tag }
}

export const ReviewActionLayer = ReviewAction.toLayer(
  Effect.fnUntraced(function* (payload) {
    const { runId, sequence } = payload
    const store = yield* IssueReviewStore
    const eligibility = yield* RepositoryEligibility
    const workspaces = yield* ReviewWorkspaces
    const agents = yield* ReviewAgentClient
    const publication = yield* IssueReviewPublication
    const drafts = yield* IssueReviewDraftPublication
    const transport = yield* GitHubTransport
    const model = yield* Effect.serviceOption(LanguageModel.LanguageModel)

    const run = yield* store.run(runId).pipe(Effect.mapError(failure))
    if (Option.isNone(run)) return yield* failure({ message: "the run no longer exists" })
    const action = yield* store.action(runId, sequence).pipe(Effect.mapError(failure))
    if (Option.isNone(action)) return yield* failure({ message: "the action was never scheduled" })

    /** Records the result once; a repeated execution returns the recorded one. */
    const record = (result: ActionResult) =>
      Effect.gen(function* () {
        const recorded = yield* store.completeAction(runId, sequence, result)
        if (recorded) return { result: result._tag, recorded: true }
        const current = yield* store.action(runId, sequence)
        const stored = Option.isSome(current) ? yield* decodeResult(current.value.result) : result
        return { result: stored._tag, recorded: false }
      }).pipe(Effect.mapError(failure))

    const remaining = (deadline: DateTime.Utc) =>
      Effect.map(DateTime.now, (now) =>
        Duration.max(Duration.zero, DateTime.distance(now, deadline)),
      )

    /** A GitHub read under the run's deadline, with its result rather than a failure. */
    const read = <A>(
      deadline: DateTime.Utc,
      name: string,
      effect: Effect.Effect<A, SyncRateLimited | SyncActivityError, GitHubTransport>,
    ) =>
      waitsWithin(deadline)(name, effect).pipe(
        Effect.provideService(GitHubTransport, transport),
        Effect.result,
      )

    const unavailable = (what: string, detail: string): PrepareResult => ({
      _tag: "Unavailable",
      reason: `${what}: ${detail}`,
    })

    const prepare = Effect.fnUntraced(function* (current: RunRecord) {
      const repository = yield* eligibility.get(current.repositoryId).pipe(Effect.result)
      if (repository._tag === "Failure") {
        if (repository.failure._tag !== "@janitor/cluster/RepositoryEligibility/RepositoryBlocked")
          return yield* failure(repository.failure)
        return { _tag: "Unavailable", reason: repository.failure.reason } satisfies PrepareResult
      }
      if (repository.success.generation !== current.eligibilityGeneration)
        return { _tag: "Unavailable", reason: changedReason } satisfies PrepareResult
      const target = repositoryTarget(repository.success)
      if (current.deadlineAt === null)
        return { _tag: "Unavailable", reason: "The run has no deadline." } satisfies PrepareResult
      const deadline = current.deadlineAt
      // Fresh authority before any work: the comment must be unchanged and the
      // invoker must still hold write or admin permission.
      const authority = yield* read(
        deadline,
        "authority",
        checkInvocation(target, current.repositoryId, {
          issueNumber: current.issueNumber,
          commentId: current.commentId,
          authorId: current.invokerId,
          authorLogin: current.invokerLogin,
          body: current.instructions,
        }),
      )
      if (authority._tag === "Failure")
        return { _tag: "Unavailable", reason: authority.failure.message } satisfies PrepareResult
      if (authority.success._tag === "Denied")
        return { _tag: "Denied", reason: authority.success.reason } satisfies PrepareResult
      const revision = yield* read(deadline, "revision", fetchRevision(target))
      if (revision._tag === "Failure")
        return unavailable("The default branch could not be read", revision.failure.message)
      if (revision.success._tag === "Failed")
        return unavailable("The default branch could not be read", revision.success.message)
      yield* store.recordRevision(runId, revision.success.value).pipe(Effect.mapError(failure))
      const issue = yield* read(deadline, "issue", fetchIssueEvidence(target, current.issueNumber))
      if (issue._tag === "Failure")
        return unavailable("The issue could not be read", issue.failure.message)
      if (issue.success._tag === "Failed")
        return unavailable("The issue could not be read", issue.success.message)
      const budget = yield* remaining(deadline)
      const provisioned = yield* workspaces
        .open(runId)
        .provision({
          remoteUrl: `https://github.com/${repository.success.name}.git`,
          commitSha: revision.success.value.commitSha,
        })
        .pipe(
          Effect.timeout(budget),
          Effect.catch((error) =>
            Effect.succeed({
              _tag: "Failed" as const,
              reason: Cause.isTimeoutError(error) ? limitations.deadline : String(error),
            }),
          ),
        )
      if (provisioned._tag === "Failed")
        return {
          _tag: "Unavailable",
          reason: `The repository could not be provisioned into the sandbox: ${provisioned.reason}`,
        } satisfies PrepareResult
      // Earlier concluded runs of this issue are evidence for this one.
      const earlier = yield* store
        .priorConclusions(current.repositoryId, current.issueNumber, runId)
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({ ...row, acceptedAt: DateTime.formatIso(row.acceptedAt) })),
          ),
          Effect.mapError(failure),
        )
      return {
        _tag: "Ready",
        repository: repository.success.name,
        revision: revision.success.value,
        issue: issue.success.value,
        earlier,
      } satisfies PrepareResult
    })

    const invoke = Effect.fnUntraced(function* (
      current: RunRecord,
      prior: ReadonlyArray<ActionRow>,
    ) {
      const deadline = current.deadlineAt
      if (deadline === null)
        return { _tag: "Failed", reason: "The run has no deadline." } satisfies ModelResult
      if (Duration.isZero(yield* remaining(deadline)))
        return { _tag: "TimedOut" } satisfies ModelResult
      const results = yield* Effect.forEach(
        prior.filter((row) => row.status === "completed"),
        (row) => decodeResult(row.result),
      ).pipe(Effect.mapError(failure))
      const prepared = results.find((result): result is Prepared => result._tag === "Ready")
      if (prepared === undefined)
        return { _tag: "Failed", reason: "The run was never prepared." } satisfies ModelResult
      const rounds = results.filter((result): result is Round => result._tag === "Round")
      const workspace = workspaces.open(runId)
      const status = yield* workspace.status.pipe(
        Effect.catch((error) => Effect.succeed({ _tag: "Absent" as const, error })),
      )
      if (status._tag === "Absent")
        return { _tag: "Interrupted", reason: limitations.workspaceLost } satisfies ModelResult
      if (Option.isNone(model))
        return { _tag: "Failed", reason: limitations.noModel } satisfies ModelResult

      const repository = yield* eligibility.get(current.repositoryId).pipe(Effect.result)
      if (repository._tag === "Failure")
        return {
          _tag: "Failed",
          reason:
            repository.failure._tag === "@janitor/cluster/RepositoryEligibility/RepositoryBlocked"
              ? repository.failure.reason
              : repository.failure.message,
        } satisfies ModelResult
      const target: RepositoryTarget = repositoryTarget(repository.success)

      const observedItems = new Map<number, ObservedItem>()
      const observedFiles = new Set<string>()
      let conclusion: ReviewConclusion | null = null
      let reproduction: Reproduction = current.reproduction
      // A workflow retry may restore artifacts from an unfinished model action.
      // Never attach that evidence to a new proposal with a reused identity.
      let toolSequence = Math.max(
        0,
        ...[
          reproduction.patch?.id,
          ...reproduction.attempts.flatMap((attempt) => [attempt.id, attempt.patchId]),
        ].flatMap((id) =>
          id?.startsWith(`${sequence}:`) ? [Number(id.slice(id.indexOf(":") + 1)) || 0] : [],
        ),
      )
      const toolLock = yield* Semaphore.make(1)
      const saveReproduction = (value: Reproduction) =>
        store.saveReproduction(runId, value).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              reproduction = value
            }),
          ),
        )

      /**
       * Every tool answers with text within the run's remaining time, and
       * refuses once the run was cancelled, so a round in flight stops
       * investigating as soon as it next reaches for a tool.
       */
      const visible = <E, R>(use: Effect.Effect<string, E, R>) =>
        Effect.gen(function* () {
          const state = yield* store
            .run(runId)
            .pipe(Effect.catch(() => Effect.succeed(Option.none<RunRecord>())))
          if (Option.isNone(state) || state.value.status !== "running")
            return "Tool failed: the run has ended. Stop and do not call more tools."
          const budget = yield* remaining(deadline)
          return yield* use.pipe(
            Effect.timeout(budget),
            Effect.map(bounded),
            Effect.catch((error) =>
              Effect.succeed(
                Cause.isTimeoutError(error)
                  ? "Tool failed: the run's time allowance is exhausted."
                  : `Tool failed: ${typeof error === "string" ? error : describeError(error as { readonly message: string })}`,
              ),
            ),
          )
        })
      const github = <A>(
        name: string,
        effect: Effect.Effect<A, SyncRateLimited | SyncActivityError, GitHubTransport>,
      ) =>
        waitsWithin(deadline)(name, effect).pipe(Effect.provideService(GitHubTransport, transport))

      const toolkit = yield* tools.pipe(
        Effect.provide(
          tools.toLayer({
            searchItems: ({ terms }) =>
              visible(
                Effect.gen(function* () {
                  const found = yield* github(`search:${terms}`, searchItems(target, terms))
                  if (found._tag === "Failed") return yield* Effect.fail(found.message)
                  for (const item of found.value)
                    observedItems.set(item.number, {
                      number: item.number,
                      kind: item.kind,
                      title: item.title,
                    })
                  return found.value.length === 0
                    ? "No matching items."
                    : found.value
                        .map(
                          (item) =>
                            `#${item.number} [${item.kind}, ${item.state}] ${item.title} (by ${item.author}, updated ${item.updatedAt})${
                              item.labels.length === 0 ? "" : ` labels: ${item.labels.join(", ")}`
                            }\n${item.snippet}`,
                        )
                        .join("\n\n")
                }),
              ),
            readItem: ({ number }) =>
              visible(
                Effect.gen(function* () {
                  const item = yield* github(`item:${number}`, fetchItem(target, number))
                  if (item._tag === "Failed") return yield* Effect.fail(item.message)
                  observedItems.set(number, {
                    number,
                    kind: item.value.kind,
                    title: item.value.title,
                    state: item.value.state,
                    body:
                      item.value.body +
                      "\n" +
                      item.value.comments.map((comment) => comment.body).join("\n"),
                  })
                  const comments = item.value.comments
                    .map(
                      (comment) =>
                        `--- ${comment.author} (${comment.authorType}) at ${comment.createdAt}\n${comment.body}`,
                    )
                    .join("\n")
                  return `#${item.value.number} [${item.value.kind}, ${item.value.state}] ${item.value.title} by ${item.value.author}\n${item.value.body}\n\n${
                    comments === "" ? "No comments." : `Comments:\n${comments}`
                  }${item.value.commentsTruncated ? "\n[more comments not shown]" : ""}`
                }),
              ),
            listFiles: ({ path }) =>
              visible(
                Effect.tap(workspace.listFiles(path), () =>
                  Effect.sync(() =>
                    observedFiles.add(path.replace(/^\.\//, "").replace(/\/+$/, "") || "."),
                  ),
                ),
              ),
            readFile: ({ path, offset, limit }) =>
              visible(
                Effect.tap(
                  workspace.readFile(path, {
                    offset: offset ?? undefined,
                    limit: limit ?? undefined,
                  }),
                  () => Effect.sync(() => observedFiles.add(path.replace(/^\.\//, ""))),
                ),
              ),
            searchFiles: ({ pattern, path }) =>
              visible(
                Effect.tap(workspace.search(pattern, path ?? undefined), (output) =>
                  Effect.sync(() => {
                    for (const line of output.split("\n")) {
                      const file = /^([^:\n]+):\d+:/.exec(line)?.[1]
                      if (file !== undefined) observedFiles.add(file.replace(/^\.\//, ""))
                    }
                  }),
                ),
              ),
            proposeTests: ({ files }) =>
              visible(
                toolLock.withPermits(1)(
                  Effect.gen(function* () {
                    const tree = yield* github(
                      "patch-tree",
                      fetchTree(target, prepared.revision.commitSha),
                    )
                    const originals: Record<string, string> = {}
                    for (const file of files) {
                      const path = canonicalPath(file.path)
                      if (path === null) return yield* Effect.fail("Invalid patch path.")
                      const entry = tree.find((entry) => entry.path === path)
                      if (entry?.type === "blob" && entry.mode === "100644")
                        originals[path] = yield* github("patch-base", fetchBlob(target, entry.sha))
                    }
                    const patch = {
                      ...(yield* validatePatch({
                        baseCommit: prepared.revision.commitSha,
                        tree,
                        files,
                        originals,
                      })),
                      id: `${sequence}:${++toolSequence}`,
                    }
                    yield* saveReproduction({ ...reproduction, patch, assessment: null })
                    return `Validated and saved patch ${patch.id} at ${patch.baseCommit}: ${patch.files.map((file) => file.path).join(", ")}. Use execute to test it.`
                  }),
                ),
              ),
            execute: (params) =>
              visible(
                toolLock.withPermits(1)(
                  Effect.gen(function* () {
                    const commitSha = params.commitSha ?? prepared.revision.commitSha
                    if (!/^[a-f0-9]{40}$/.test(commitSha))
                      return yield* Effect.fail("Use a full commit SHA.")
                    const testPath =
                      params.testPath === null ? null : canonicalPath(params.testPath)
                    if (
                      params.kind === "test" &&
                      (testPath === null ||
                        !reproduction.patch?.files.some((file) => file.path === testPath) ||
                        !params.command.includes(testPath))
                    )
                      return yield* Effect.fail(
                        "A minimal test command must name a file from the validated patch.",
                      )
                    const attempt: TestAttempt = {
                      id: `${sequence}:${++toolSequence}`,
                      patchId: reproduction.patch?.id ?? null,
                      commitSha,
                      command: params.command,
                      kind: params.kind,
                      testPath,
                      exitCode: null,
                      output: "",
                      truncated: false,
                      integrity: false,
                      limitation:
                        "Execution did not complete. It may have timed out or lost its workspace; reproduction is inconclusive.",
                    }
                    yield* saveReproduction({
                      ...reproduction,
                      assessment: null,
                      attempts: [...reproduction.attempts, attempt],
                    })
                    const result = yield* workspace
                      .execute({
                        ...params,
                        remoteUrl: `https://github.com/${prepared.repository}.git`,
                        id: attempt.id,
                        testPath,
                        commitSha,
                        patch: reproduction.patch,
                        timeout: Math.max(1, Duration.toMillis(yield* remaining(deadline))),
                      })
                      .pipe(
                        Effect.catch((error) =>
                          Effect.succeed({ ...attempt, output: String(error).slice(0, 16000) }),
                        ),
                      )
                    yield* saveReproduction({
                      ...reproduction,
                      attempts: reproduction.attempts.map((entry) =>
                        entry.id === result.id ? result : entry,
                      ),
                    })
                    return JSON.stringify(result)
                  }),
                ),
              ),
            assessReproduction: (params) =>
              visible(
                toolLock.withPermits(1)(
                  Effect.gen(function* () {
                    if (params.duplicate?.issueNumber === current.issueNumber)
                      return yield* Effect.fail(
                        "An issue cannot suppress its own reproduction proposal.",
                      )
                    const assessment = yield* assessReproduction(
                      params,
                      reproduction,
                      prepared.revision.commitSha,
                      [
                        ...rounds.flatMap((round) => round.observed.items),
                        ...observedItems.values(),
                      ],
                      prepared.repository,
                    )
                    yield* saveReproduction({ ...reproduction, assessment })
                    return JSON.stringify(assessment)
                  }),
                ),
              ),
            finish: (params) =>
              decodeConclusion(params).pipe(
                Effect.map((decoded) => {
                  conclusion = decoded
                  return "Recorded. The run ends after this turn."
                }),
                Effect.catch((error) =>
                  Effect.succeed(
                    `Invalid: ${error.message}. Call finish again with a valid classification and bounded prose.`,
                  ),
                ),
              ),
          }),
        ),
      )

      const prompt = buildPrompt({
        invokerLogin: current.invokerLogin,
        instructions: current.instructions,
        commentId: current.commentId,
        prepared,
        rounds,
      })
      for (let attempt = 1; ; attempt++) {
        const budget = yield* remaining(deadline)
        if (Duration.isZero(budget)) return { _tag: "TimedOut" } satisfies ModelResult
        const response = yield* model.value
          .generateText({ prompt, toolkit })
          .pipe(Effect.timeout(budget), Effect.result)
        if (response._tag === "Success") {
          const results = new Map(
            response.success.toolResults.map((result) => [result.id, result] as const),
          )
          const records: Array<ToolRecord> = response.success.toolCalls.map((call) => {
            const result = results.get(call.id)
            return {
              id: call.id,
              name: call.name,
              params: call.params,
              result:
                typeof result?.result === "string" ? result.result : String(result?.result ?? ""),
              isFailure: result?.isFailure ?? true,
            }
          })
          return {
            _tag: "Round",
            text: response.success.text,
            tools: records,
            observed: { items: [...observedItems.values()], files: [...observedFiles] },
            conclusion,
          } satisfies ModelResult
        }
        const now = yield* DateTime.now
        const verdict = providerFailure(response.failure, DateTime.toEpochMillis(now))
        // Log the category only; provider errors can echo prompts and keys.
        yield* Effect.logWarning("Review model call failed").pipe(
          Effect.annotateLogs({ runId, sequence, attempt, verdict: verdict._tag }),
        )
        if (verdict._tag === "TimedOut") return { _tag: "TimedOut" } satisfies ModelResult
        if (verdict._tag === "Failed")
          return {
            _tag: "Failed",
            reason: `${limitations.provider} (${verdict.category ?? "unknown"})`,
          } satisfies ModelResult
        // Provider guidance is honoured within the remaining allowance, in
        // process; there is no separate cap on attempts.
        const wait = Duration.millis(verdict.retryAfterMs)
        if (Duration.isGreaterThan(wait, yield* remaining(deadline)))
          return { _tag: "TimedOut" } satisfies ModelResult
        yield* Effect.sleep(wait)
      }
    })

    const perform = Effect.gen(function* () {
      if (action.value.status === "completed")
        return yield* record(
          yield* decodeResult(action.value.result).pipe(Effect.mapError(failure)),
        )
      if (action.value.kind === "publish_branch" || action.value.kind === "publish_pr") {
        yield* drafts
          .publish(runId, action.value.kind === "publish_branch" ? "branch" : "pr")
          .pipe(Effect.mapError(failure))
        return yield* record({
          _tag: action.value.kind === "publish_branch" ? "BranchFinished" : "DraftFinished",
        })
      }
      if (action.value.kind === "publish") {
        yield* publication.publish(runId).pipe(Effect.mapError(failure))
        return yield* record({ _tag: "PublicationFinished" })
      }
      if (run.value.status !== "running") {
        // The run ended meanwhile: nothing runs, and the sandbox is let go.
        yield* workspaces.open(runId).release.pipe(Effect.ignore)
        return yield* record({ _tag: "Skipped" })
      }
      if (action.value.kind === "prepare") return yield* record(yield* prepare(run.value))
      const prior = yield* store.actions(runId).pipe(Effect.mapError(failure))
      return yield* record(
        yield* invoke(
          run.value,
          prior.filter((row) => row.sequence < sequence),
        ),
      )
    })

    const outcome = yield* Activity.make({
      name: `ReviewAction/${sequence}`,
      success: ReviewActionOutcome,
      error: ReviewActionError,
      execute: perform,
    })

    // The agent applies the completion once by its message identity. Delivery
    // is retried with durable waits while the run's allowance lasts, so a
    // runner restart resumes here rather than losing the completion; the
    // agent also resyncs whenever the scheduler starts it again.
    const notify = agents.actionCompleted(runId, actionMessageId(payload), sequence)
    for (let attempt = 0; ; attempt++) {
      const delivered = yield* notify.pipe(Effect.asVoid, Effect.result)
      if (delivered._tag === "Success") break
      const now = yield* DateTime.now
      const deadline = run.value.deadlineAt ?? now
      const overdue = DateTime.isGreaterThan(now, DateTime.addDuration(deadline, NOTIFY_GRACE))
      yield* Effect.logWarning(
        "Review action completion was not delivered",
        delivered.failure,
      ).pipe(Effect.annotateLogs({ runId, sequence, attempt, giveUp: overdue }))
      if (overdue) break
      yield* DurableClock.sleep({
        name: `ReviewAction/${sequence}/notify-${attempt}`,
        duration: Duration.seconds(Math.min(60, 2 ** Math.min(attempt, 6))),
      })
    }
    yield* Effect.logInfo("Review action finished").pipe(
      Effect.annotateLogs({ runId, sequence, result: outcome.result, recorded: outcome.recorded }),
    )
    return outcome
  }, logWorkflowFailure("ReviewAction")),
)

const decodePayload = Schema.decodeUnknownEffect(ReviewActionPayload)

export const ReviewActionRegistration: WorkflowRegistration = {
  tag: REVIEW_ACTION_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => ReviewAction.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
