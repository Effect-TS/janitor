import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { fileName, parseTrustedDiff, validateAnchor } from "@janitor/domain/PullRequestReview/Diff"
import { Severity, ThreadJudgement } from "@janitor/domain/PullRequestReview/Finding"
import {
  fingerprint,
  type HeadBlob,
  type HeadMatch,
  matchAtHead,
} from "@janitor/domain/PullRequestReview/Fingerprint"
import {
  checkRunOutput,
  inlineComment,
  type ListedFinding,
  replyMarker,
  reviewBody,
  threadReplyBody,
} from "@janitor/domain/PullRequestReview/Render"
import { FinalStatus, RunId, Verdict } from "@janitor/domain/PullRequestReview/Run"
import { judgeThread, planReply } from "@janitor/domain/PullRequestReview/Threads"
import {
  allocateInline,
  checkRun as reviewCheckRun,
  decideReview,
  type ManifestChange,
  type RunOutcome,
} from "@janitor/domain/PullRequestReview/Verdict"
import { GitHubTransport } from "../GitHub/Transport.ts"
import type { LoopOutcome } from "./Agent.ts"
import { pullRequestReviewConfig } from "./Config.ts"
import { earlierThread, makeActors, rootComment } from "./EarlierThreads.ts"
import * as ReviewGitHub from "./GitHub.ts"
import { errorFields } from "./Log.ts"
import { RunPublisher } from "./RunEntity.ts"
import { type RunRecord, saveRunRecord, writeRunRecord } from "./RunRecord.ts"
import type { RunState, RunStorage } from "./RunStorage.ts"
import { PullRequestScheduler, schedulerEntityId } from "./Scheduler.ts"
import { GitHubLink, PullRequestReviewStore, RecordedFinding } from "./Store.ts"

/**
 * The `Publish` batch (EFF-1651 points 13 and 14, EFF-1649 rules 16 to 20,
 * EFF-1648 point 8, EFF-1848 point 1, EFF-1650 point 9). It decides what to
 * post against the live pull request, then posts one review through a GraphQL
 * pending review, dismisses janitor's earlier `REQUEST_CHANGES` reviews,
 * updates the check run, upserts the run record onto its start row and sends
 * `RunFinished`.
 *
 * Every step is journalled in `publish_steps` once it is done, so a replayed
 * `Publish` skips it. A create records its attempt first: a replay that finds
 * the attempt but no result looks for the run's marker on GitHub before it
 * writes again. A step that fails for good is recorded, never thrown.
 */

const Actor = Schema.Literals(["maintainer", "author", "other"])

const ThreadStateSchema = Schema.Struct({
  threadId: Schema.String,
  severity: Severity,
  judgement: ThreadJudgement,
  clearing: Schema.Literals(["standing", "dismissal", "approval"]),
  changed: Schema.Boolean,
})

const ThreadLinkSchema = Schema.Struct({
  url: Schema.String,
  state: ThreadStateSchema,
  outdated: Schema.Boolean,
  resolvedBy: Schema.optionalKey(Actor),
})

const GateFailureSchema = Schema.Union([
  Schema.TaggedStruct("HeadMoved", {}),
  Schema.TaggedStruct("Unfinished", {
    outcome: Schema.Literals(["steered", "interrupted", "errored"]),
  }),
  Schema.TaggedStruct("BlockingFindings", {}),
  Schema.TaggedStruct("Closed", {}),
  Schema.TaggedStruct("Draft", {}),
  Schema.TaggedStruct("BaseChanged", {}),
  Schema.TaggedStruct("Forced", {}),
  Schema.TaggedStruct("SensitivePaths", { paths: Schema.Array(Schema.String) }),
])

const ListedFindingSchema = Schema.Struct({
  path: Schema.String,
  line: Schema.Int,
  severity: Severity,
  comment: Schema.String,
})

/** What the run posts, decided once against the live pull request. */
const Plan = Schema.Union([
  /** The head moved since the reviewed SHA: no review, the check run is cancelled. */
  Schema.TaggedStruct("Superseded", {}),
  /** The pull request couldn't be read, so nothing could be decided. */
  Schema.TaggedStruct("Failed", { message: Schema.String }),
  Schema.TaggedStruct("Review", {
    /**
     * The verdict; `null` when it posts no review of its own. Replies and
     * dismissals still go out then, in a `COMMENT` review.
     */
    event: Schema.NullOr(Verdict),
    summary: Schema.String,
    partial: Schema.Boolean,
    /** New findings that go inline, each with the form it takes in the body if it can't. */
    threads: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        line: Schema.Int,
        startLine: Schema.optionalKey(Schema.Int),
        body: Schema.String,
        fingerprint: Schema.String,
        listed: ListedFindingSchema,
      }),
    ),
    /** Findings listed in the body: unanchorable, or past the inline limit. */
    listed: Schema.Array(ListedFindingSchema),
    replies: Schema.Array(Schema.Struct({ threadId: Schema.String, body: Schema.String })),
    /** Optional so older journalled plans can still replay. */
    resolutions: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Janitor's earlier `REQUEST_CHANGES` reviews to dismiss. */
    dismiss: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        databaseId: Schema.Int,
        state: Schema.String,
        marker: Schema.Struct({ runId: RunId, reviewedSha: Schema.String }),
      }),
    ),
    gateFailures: Schema.Array(GateFailureSchema),
    conclusion: Schema.Literals(["success", "failure", "neutral"]),
    threadLinks: Schema.Array(ThreadLinkSchema),
    /** The run's status should it post nothing. */
    status: FinalStatus,
    findings: Schema.Array(RecordedFinding),
  }),
])
type Plan = typeof Plan.Type
type ReviewPlan = Extract<Plan, { readonly _tag: "Review" }>

const Done = Schema.Struct({})
const Created = Schema.Struct({ id: Schema.String, databaseId: Schema.Int })
const ThreadAdded = Schema.Union([
  Schema.TaggedStruct("Added", { threadId: Schema.String }),
  /** GitHub refused the line after all; the finding goes in the body. */
  Schema.TaggedStruct("Unresolvable", {}),
])
const ReplyAdded = Schema.Struct({ commentId: Schema.String })
/** What submit saw just before it sent the review: the event and whether the head had moved. */
const Observed = Schema.TaggedStruct("Submitted", { event: Verdict, headMoved: Schema.Boolean })
const ObservedJson = Schema.fromJsonString(Observed)
const Submitted = Schema.Union([
  Observed,
  /** An unexpected 422. */
  Schema.TaggedStruct("Refused", { message: Schema.String }),
])
const Posted = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Posted", {
    id: Schema.String,
    databaseId: Schema.Int,
    event: Verdict,
    headMoved: Schema.Boolean,
  }),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
])
type Posted = typeof Posted.Type
const Dismissal = Schema.Union([
  Schema.TaggedStruct("Dismissed", {}),
  Schema.TaggedStruct("Failed", { forbidden: Schema.Boolean }),
])

type Journalled = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

const EVENTS: Record<Verdict, ReviewGitHub.ReviewEvent> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
}

const SUBMITTED: Record<string, Verdict> = {
  APPROVED: "approve",
  CHANGES_REQUESTED: "request_changes",
  COMMENTED: "comment",
}

const STATUS: Record<Verdict, FinalStatus> = {
  approve: "approved",
  request_changes: "changes_requested",
  comment: "commented",
}

/** How many times a step meets a transient GitHub failure before it fails for good. */
const ATTEMPTS = 3

/** A failure's message for the run's logs and journal; a rate limit has none. */
const describe = (error: { readonly _tag: string }) =>
  "message" in error && typeof error.message === "string" ? error.message : error._tag

const isTransient = (error: { readonly _tag: string }) =>
  error._tag === "PullRequestGitHubError" || error._tag === "PullRequestGitHubRateLimited"

/** Waits before the next attempt: until a rate limit resets, or a short backoff. */
const backoff = (error: { readonly _tag: string }, attempt: number) =>
  error instanceof ReviewGitHub.RateLimited
    ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sleep(Duration.millis(Math.max(0, DateTime.toEpochMillis(error.until) - now))),
      )
    : Effect.sleep(Duration.seconds(2 ** attempt))

/** Retries transient failures of an idempotent GitHub call. */
const persist = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 1; ; attempt++) {
      const result = yield* Effect.result(effect)
      if (result._tag === "Success") return result.success
      if (attempt >= ATTEMPTS || !isTransient(result.failure))
        return yield* Effect.fail(result.failure)
      yield* backoff(result.failure, attempt)
    }
  })

const toRunOutcome = (outcome: LoopOutcome): RunOutcome =>
  outcome.unfinished === "deadline"
    ? "interrupted"
    : outcome.unfinished === "provider_failure"
      ? "errored"
      : outcome.steered
        ? "steered"
        : "completed"

const makePublisher = Effect.gen(function* () {
  const transport = yield* GitHubTransport
  const store = yield* PullRequestReviewStore
  const schedulers = yield* PullRequestScheduler.client

  const publish = (run: {
    readonly runId: RunId
    readonly outcome: LoopOutcome
    readonly state: RunState
    readonly storage: RunStorage
  }) =>
    Effect.gen(function* () {
      const { runId, outcome, state, storage } = run
      const target = state.target
      // `Start` saves the target before the run can reach `Publish`.
      if (target === null) return
      const config = yield* pullRequestReviewConfig
      const client = yield* ReviewGitHub.make({
        installationId: GitHubInstallationId.make(target.installationId),
        owner: target.owner,
        repo: target.repo,
        number: state.number,
      }).pipe(Effect.provideService(GitHubTransport, transport))
      const repository = `${target.owner}/${target.repo}`
      const pullUrl = `https://github.com/${repository}/pull/${state.number}`
      const reviewUrl = (databaseId: number) => `${pullUrl}#pullrequestreview-${databaseId}`
      const runOutcome = toRunOutcome(outcome)

      /** Runs `effect` once; a recorded step returns its recorded output. */
      const once = <S extends Journalled, E, R>(
        step: string,
        schema: S,
        effect: Effect.Effect<S["Type"], E, R>,
      ): Effect.Effect<S["Type"], E, R> =>
        Effect.gen(function* () {
          const json = Schema.fromJsonString(schema)
          const recorded = yield* storage.publishStep(step).pipe(Effect.orDie)
          if (Option.isSome(recorded))
            return yield* Schema.decodeEffect(json)(recorded.value).pipe(Effect.orDie)
          const output = yield* effect
          const encoded = yield* Schema.encodeEffect(json)(output).pipe(Effect.orDie)
          yield* storage.recordPublishStep(step, encoded).pipe(Effect.orDie)
          return output
        })

      /**
       * A create, never retried blind: its attempt is recorded before the
       * request, and an attempt with no result, cut off by a restart or a
       * transient failure, is looked up with `find` before writing again.
       */
      const create = <S extends Journalled, E extends { readonly _tag: string }, R>(
        step: string,
        schema: S,
        find: Effect.Effect<Option.Option<S["Type"]>, E, R>,
        write: Effect.Effect<S["Type"], E, R>,
      ) =>
        once(
          step,
          schema,
          Effect.gen(function* () {
            const attempt = `${step}:attempt`
            let attempted = Option.isSome(yield* storage.publishStep(attempt).pipe(Effect.orDie))
            for (let tries = 1; ; tries++) {
              if (attempted) {
                const found = yield* persist(find)
                if (Option.isSome(found)) return found.value
              } else {
                yield* storage.recordPublishStep(attempt, "").pipe(Effect.orDie)
                attempted = true
              }
              const result = yield* Effect.result(write)
              if (result._tag === "Success") return result.success
              if (tries >= ATTEMPTS || !isTransient(result.failure))
                return yield* Effect.fail(result.failure)
              yield* backoff(result.failure, tries)
            }
          }),
        )

      /** Decides what to post against the live pull request (EFF-1648 point 8, EFF-1650). */
      const decide = Effect.gen(function* () {
        const pull = yield* client.pullRequest
        // The push has already queued a new run, which waits for this run's `RunFinished`.
        if (pull.headSha !== state.headSha) return { _tag: "Superseded" } as const
        const changed = yield* client.changedFiles({
          baseSha: state.baseSha,
          lockfiles: config.lockfiles,
        })
        const diff = parseTrustedDiff(changed.files)
        const history = yield* client.janitorHistory
        const { authorCanWrite: readAuthorCanWrite, actor } = makeActors(client, pull)
        const authorCanWrite = yield* readAuthorCanWrite

        const blobs = new Map<string, HeadBlob>()
        const headBlob = (path: string) =>
          Effect.gen(function* () {
            const cached = blobs.get(path)
            if (cached !== undefined) return cached
            const blob = yield* client.readFile(state.headSha, path)
            blobs.set(path, blob)
            return blob
          })

        // This run's findings, anchored against the trusted diff and fingerprinted.
        const findings = yield* Effect.forEach(
          outcome.records.flatMap((record) =>
            record._tag === "FindingReported" ? [record.finding] : [],
          ),
          (finding) =>
            Effect.gen(function* () {
              const anchor = validateAnchor(diff, finding)
              let lines: ReadonlyArray<string> = []
              if (anchor._tag === "Anchored") lines = anchor.lines
              else {
                const blob = yield* headBlob(finding.path)
                if (blob._tag === "Read")
                  lines = blob.text.split("\n").slice(finding.startLine - 1, finding.endLine)
              }
              return {
                ...finding,
                anchored: anchor._tag === "Anchored",
                fingerprint: yield* fingerprint(finding.path, lines),
              }
            }),
        )

        // Janitor's earlier threads, judged by the agent or by trusted code.
        const judgements = new Map<string, ThreadJudgement>()
        for (const record of outcome.records)
          if (record._tag === "ThreadUpdated") judgements.set(record.threadId, record.judgement)
        const threads = yield* Effect.forEach(history.threads, (thread) =>
          Effect.gen(function* () {
            const earlier = yield* earlierThread(thread, actor)
            const anchor = earlier.anchor
            const headMatch: HeadMatch =
              thread.line === null
                ? { _tag: "Unknown" }
                : yield* matchAtHead(
                    {
                      path: thread.path,
                      fingerprint: thread.fingerprint,
                      lineCount: anchor.endLine - anchor.startLine + 1,
                    },
                    yield* headBlob(thread.path),
                  )
            const judgement = judgements.get(thread.id)
            const judged = judgeThread(earlier, {
              diff,
              ...(judgement === undefined ? {} : { judgement }),
              headMatch,
              authorCanWrite,
            })
            const reply = planReply(earlier, judged, {
              repository,
              headSha: state.headSha,
              headMatch,
              authorCanWrite,
            })
            return { thread, earlier, judged, reply, judgedNow: judgement !== undefined }
          }),
        )

        // Dependency changes in manifests only matter for an author without write access.
        const manifests: Array<ManifestChange> = []
        if (!authorCanWrite)
          for (const file of changed.files) {
            if (!config.manifests.includes(fileName(file.filename))) continue
            const base = yield* client.readFile(
              state.baseSha,
              file.previous_filename ?? file.filename,
            )
            const head = yield* headBlob(file.filename)
            manifests.push({
              path: file.filename,
              ...(base._tag === "Read" ? { base: base.text } : {}),
              ...(head._tag === "Read" ? { head: head.text } : {}),
            })
          }

        const states = threads.map(({ judged }) => judged)
        const decision = decideReview({
          reviewedSha: state.headSha,
          baseRefAtStart: state.baseRef ?? pull.baseRef,
          outcome: runOutcome,
          forced: state.trigger._tag === "Forced",
          authorCanWrite,
          pullRequest: {
            state: pull.state,
            draft: pull.draft,
            headSha: pull.headSha,
            baseRef: pull.baseRef,
          },
          findings,
          threads: states,
          changedFiles: changed.files,
          manifests,
          sensitive: {
            globs: config.sensitivePaths,
            lockfiles: config.lockfiles,
            manifests: config.manifests,
          },
          earlierChangesRequested: history.reviews.some(
            (review) => review.state === "CHANGES_REQUESTED" && review.marker.runId !== runId,
          ),
          approvedAtHead: history.reviews.some(
            (review) => review.state === "APPROVED" && review.marker.reviewedSha === state.headSha,
          ),
        })
        const { inline, body } = allocateInline(findings, config.maxInlineComments)
        const listed = (finding: (typeof findings)[number]): ListedFinding => ({
          path: finding.path,
          line: finding.startLine,
          severity: finding.severity,
          comment: finding.comment,
        })
        const conclusion = reviewCheckRun({
          _tag: "Ended",
          outcome: runOutcome,
          findings,
          threads: states,
        })
        const plan: ReviewPlan = {
          _tag: "Review",
          event: decision.event,
          summary: outcome.summary ?? "",
          partial: runOutcome === "interrupted" || runOutcome === "errored",
          threads: inline.map((finding) => ({
            path: finding.path,
            line: finding.endLine,
            ...(finding.startLine === finding.endLine ? {} : { startLine: finding.startLine }),
            body: inlineComment(finding),
            fingerprint: finding.fingerprint,
            listed: listed(finding),
          })),
          listed: body.map(listed),
          resolutions: threads.flatMap(({ thread, judged }) =>
            !thread.isResolved && judged.judgement.judgement === "addressed" ? [thread.id] : [],
          ),
          replies: threads.flatMap(({ thread, judged, reply }) =>
            judged.judgement.judgement !== "addressed" && Option.isSome(reply)
              ? [
                  {
                    threadId: reply.value.threadId,
                    body: `${threadReplyBody(reply.value, { headSha: state.headSha })}\n\n${replyMarker(
                      {
                        judgement: reply.value.judgement,
                        outdated: thread.isOutdated,
                        resolved: thread.isResolved,
                      },
                    )}`,
                  },
                ]
              : [],
          ),
          dismiss: decision.dismissEarlier
            ? history.reviews.filter(
                (review) => review.state === "CHANGES_REQUESTED" && review.marker.runId !== runId,
              )
            : [],
          gateFailures: decision.gateFailures,
          conclusion:
            conclusion.status === "completed" && conclusion.conclusion !== "cancelled"
              ? conclusion.conclusion
              : "neutral",
          threadLinks: threads.map(({ thread, judged, earlier }) => ({
            url: thread.comments[0]?.url ?? `${pullUrl}/files`,
            state: judged,
            outdated: thread.isOutdated,
            ...(earlier.resolvedBy === undefined ? {} : { resolvedBy: earlier.resolvedBy }),
          })),
          status:
            conclusion.status === "completed" && conclusion.conclusion === "failure"
              ? "changes_requested"
              : decision.gateFailures.length === 0
                ? "approved"
                : "commented",
          findings: [
            ...findings.map((finding) => ({
              path: finding.path,
              startLine: finding.startLine,
              endLine: finding.endLine,
              severity: finding.severity,
              comment: finding.comment,
              fingerprint: finding.fingerprint,
              outcome: "new" as const,
            })),
            // An earlier thread is recorded while it is open, or when this run judged it.
            ...threads
              .filter(({ thread, judgedNow }) => !thread.isResolved || judgedNow)
              .map(({ thread, earlier, judged }) => ({
                path: thread.path,
                ...earlier.anchor,
                severity: earlier.severity,
                comment: rootComment(thread.comments[0]!.body),
                fingerprint: thread.fingerprint,
                outcome:
                  judged.judgement.judgement === "still_applies"
                    ? ("carried_over" as const)
                    : judged.judgement.judgement,
              })),
          ],
        }
        return plan
      })

      const plan: Plan = yield* once(
        "plan",
        Plan,
        persist(decide).pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning("Couldn't decide what a PR review run posts").pipe(
                Effect.annotateLogs(errorFields(error)),
              ),
              {
                _tag: "Failed",
                message: describe(error),
              } as const,
            ),
          ),
        ),
      )

      /**
       * The review body for `event`. Inline findings GitHub refused, by index,
       * are listed in it; `inBody` lists every inline finding instead.
       */
      const renderBody = (
        review: ReviewPlan,
        event: Verdict,
        options: {
          readonly headMoved: boolean
          readonly inBody: boolean
          readonly unresolvable: ReadonlySet<number>
        },
      ) => {
        const listedInBody = (index: number) => options.inBody || options.unresolvable.has(index)
        return reviewBody({
          runId,
          reviewedSha: state.headSha,
          event,
          summary: review.summary,
          partial: review.partial,
          inline: review.threads.flatMap((thread, index) =>
            listedInBody(index) ? [] : [thread.listed],
          ),
          listed: [
            ...review.threads.flatMap((thread, index) =>
              listedInBody(index) ? [thread.listed] : [],
            ),
            ...review.listed,
          ],
          gateFailures: options.headMoved
            ? [{ _tag: "HeadMoved" }, ...review.gateFailures]
            : review.gateFailures,
        })
      }

      const pendingCreated = client.pendingReview.pipe(
        Effect.map(Option.map((pending) => ({ id: pending.id, databaseId: pending.databaseId }))),
      )

      /**
       * Submits the pending review after re-reading the head: if it moved,
       * `APPROVE` drops to `COMMENT` and other events stay. The threads stay on
       * the reviewed commit and go outdated on their own.
       */
      const submit = (
        prefix: string,
        review: ReviewPlan,
        event: Verdict,
        pending: typeof Created.Type,
        options: { readonly inBody: boolean; readonly unresolvable: ReadonlySet<number> },
      ) => {
        const observedStep = `${prefix}/submit:observed`
        return create(
          `${prefix}/submit`,
          Submitted,
          Effect.gen(function* () {
            const found = yield* client.findReview(runId)
            if (Option.isNone(found)) return Option.none()
            // Cut off after it was sent: keep what submit saw then, never the head as it is now.
            const observed = yield* storage.publishStep(observedStep).pipe(Effect.orDie)
            if (Option.isSome(observed))
              return Option.some(
                yield* Schema.decodeEffect(ObservedJson)(observed.value).pipe(Effect.orDie),
              )
            // Unreachable while the observation is journalled before every send.
            const submitted = SUBMITTED[found.value.state] ?? event
            return Option.some({
              _tag: "Submitted" as const,
              event: submitted,
              headMoved: submitted !== event,
            })
          }),
          Effect.gen(function* () {
            const pull = yield* client.pullRequest
            const headMoved = pull.headSha !== state.headSha
            const submitted = headMoved && event === "approve" ? "comment" : event
            const observed = { _tag: "Submitted" as const, event: submitted, headMoved }
            // Journalled before the request, so a submit cut off mid-request keeps what it saw.
            yield* storage
              .recordPublishStep(
                observedStep,
                yield* Schema.encodeEffect(ObservedJson)(observed).pipe(Effect.orDie),
              )
              .pipe(Effect.orDie)
            yield* client.submitPendingReview(pending.id, {
              event: EVENTS[submitted],
              body: renderBody(review, submitted, { ...options, headMoved }),
            })
            return observed
          }).pipe(
            Effect.catchTag("PullRequestGitHubUnprocessable", (error) =>
              Effect.succeed({ _tag: "Refused" as const, message: error.message }),
            ),
          ),
        )
      }

      /** Adds the planned replies to earlier threads to a pending review. */
      const addReplies = (prefix: string, review: ReviewPlan, pending: typeof Created.Type) =>
        Effect.forEach(
          review.replies,
          (reply) =>
            create(
              `${prefix}/reply/${reply.threadId}`,
              ReplyAdded,
              Effect.map(client.pendingReview, (found) =>
                Option.flatMap(found, (pending) =>
                  Option.fromNullishOr(
                    pending.replies.find((added) => added.threadId === reply.threadId),
                  ),
                ),
              ),
              client.addReply(pending.id, reply),
            ),
          { discard: true },
        )

      /** Steps 1 to 4, with the 422 fallback (EFF-1648 point 8). */
      const postReview = (review: ReviewPlan, event: Verdict) =>
        Effect.gen(function* () {
          yield* once("review/delete", Done, Effect.as(persist(client.deletePendingReview), {}))
          const pending = yield* create(
            "review/create",
            Created,
            pendingCreated,
            client.createPendingReview(state.headSha),
          )
          yield* addReplies("review", review, pending)
          const unresolvable = new Set<number>()
          for (const [index, thread] of review.threads.entries()) {
            const added = yield* create(
              `review/thread/${index}`,
              ThreadAdded,
              Effect.map(client.pendingReview, (found) =>
                Option.flatMap(found, (pending) =>
                  Option.fromNullishOr(
                    pending.threads.find((added) => added.fingerprint === thread.fingerprint),
                  ),
                ).pipe(
                  Option.map((added) => ({ _tag: "Added" as const, threadId: added.threadId })),
                ),
              ),
              client
                .addThread(pending.id, {
                  path: thread.path,
                  line: thread.line,
                  ...(thread.startLine === undefined ? {} : { startLine: thread.startLine }),
                  body: thread.body,
                })
                .pipe(
                  Effect.map(({ threadId }) => ({ _tag: "Added" as const, threadId })),
                  Effect.catchTag("UnresolvableLine", () =>
                    Effect.succeed({ _tag: "Unresolvable" as const }),
                  ),
                ),
            )
            if (added._tag === "Unresolvable") unresolvable.add(index)
          }
          const first = yield* submit("review", review, event, pending, {
            inBody: false,
            unresolvable,
          })
          if (first._tag === "Submitted")
            return {
              _tag: "Posted" as const,
              ...pending,
              event: first.event,
              headMoved: first.headMoved,
            }

          // An unexpected 422: once more with every inline comment in the body.
          yield* Effect.logWarning("GitHub refused a PR review; retrying with the body only")
          yield* once("fallback/delete", Done, Effect.as(persist(client.deletePendingReview), {}))
          const fallback = yield* create(
            "fallback/create",
            Created,
            pendingCreated,
            client.createPendingReview(state.headSha),
          )
          // Replies can't move into the body, so they go on the new pending review.
          yield* addReplies("fallback", review, fallback)
          const second = yield* submit("fallback", review, event, fallback, {
            inBody: true,
            unresolvable: new Set(),
          })
          if (second._tag === "Submitted")
            return {
              _tag: "Posted" as const,
              ...fallback,
              event: second.event,
              headMoved: second.headMoved,
            }
          return { _tag: "Failed" as const, message: second.message }
        })

      // Replies and dismissals go out even when the verdict alone would post
      // nothing, in a `COMMENT` review that leaves the review state as it is.
      const event =
        plan._tag !== "Review"
          ? null
          : (plan.event ??
            (plan.replies.length > 0 || plan.dismiss.length > 0 ? ("comment" as const) : null))
      const posted: Posted = yield* once(
        "review",
        Posted,
        plan._tag === "Failed"
          ? Effect.succeed({ _tag: "Failed" as const, message: plan.message })
          : plan._tag === "Superseded" || event === null
            ? Effect.succeed({ _tag: "None" as const })
            : postReview(plan, event).pipe(
                Effect.catch((error) =>
                  Effect.as(
                    Effect.logWarning("Couldn't post a PR review").pipe(
                      Effect.annotateLogs(errorFields(error)),
                    ),
                    { _tag: "Failed" as const, message: describe(error) },
                  ),
                ),
              ),
      )

      // Resolution needs no new review. Re-read on each attempt to reconcile a lost response.
      if (plan._tag === "Review")
        for (const threadId of plan.resolutions ?? [])
          yield* once(
            `resolve/${threadId}`,
            Done,
            persist(
              Effect.gen(function* () {
                const history = yield* client.janitorHistory
                const thread = history.threads.find((thread) => thread.id === threadId)
                if (thread?.isResolved) return
                yield* client.resolveThread(threadId)
              }),
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Couldn't resolve a PR review thread").pipe(
                  Effect.annotateLogs({ ...errorFields(error), threadId }),
                ),
              ),
              Effect.as({}),
            ),
          )

      // Step 5: janitor's earlier `REQUEST_CHANGES` reviews, once no blocking finding stands.
      const dismissalFailures: Array<string> = []
      if (plan._tag === "Review" && posted._tag === "Posted")
        for (const review of plan.dismiss) {
          const dismissed = yield* create(
            `dismiss/${review.id}`,
            Dismissal,
            Effect.map(client.janitorHistory, ({ reviews }) =>
              reviews.some((found) => found.id === review.id && found.state === "DISMISSED")
                ? Option.some({ _tag: "Dismissed" as const })
                : Option.none(),
            ),
            client
              .dismissReview(
                review,
                `Dismissed by janitor: no blocking finding stands at ${state.headSha}.`,
              )
              .pipe(
                Effect.as({ _tag: "Dismissed" as const }),
                // A permanent failure is journalled with the step, so a replay doesn't send it again.
                Effect.catchIf(
                  (error) => !isTransient(error),
                  (error) =>
                    Effect.as(
                      Effect.logWarning("Couldn't dismiss a PR review").pipe(
                        Effect.annotateLogs(errorFields(error)),
                      ),
                      {
                        _tag: "Failed" as const,
                        forbidden: error._tag === "NotOnDismissalAllowList",
                      },
                    ),
                ),
              ),
          ).pipe(
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning("Couldn't dismiss a PR review").pipe(
                  Effect.annotateLogs(errorFields(error)),
                ),
                { _tag: "Failed" as const, forbidden: error._tag === "NotOnDismissalAllowList" },
              ),
            ),
          )
          if (dismissed._tag === "Failed") dismissalFailures.push(reviewUrl(review.databaseId))
        }

      const finishedAt = yield* once("finishedAt", Schema.Finite, Clock.currentTimeMillis)
      const failed = plan._tag === "Failed" || posted._tag === "Failed"
      // A head that moved before submit fails the gate, whatever the event posted.
      const gateFailures =
        plan._tag !== "Review"
          ? []
          : posted._tag === "Posted" && posted.headMoved
            ? [{ _tag: "HeadMoved" } as const, ...plan.gateFailures]
            : plan.gateFailures
      // This run's findings stand: inline ones link to the files view, listed
      // ones to the review that lists them.
      const newFindings =
        plan._tag !== "Review"
          ? []
          : [
              ...plan.threads.map((thread) => ({
                finding: thread.listed,
                url: `${pullUrl}/files`,
              })),
              ...plan.listed.map((finding) => ({
                finding,
                url: posted._tag === "Posted" ? reviewUrl(posted.databaseId) : pullUrl,
              })),
            ].map(({ finding, url }, index) => ({
              url,
              state: {
                threadId: `new/${index}`,
                severity: finding.severity,
                judgement: { judgement: "still_applies" as const },
                clearing: "standing" as const,
                changed: true,
              },
              outdated: false,
            }))

      // Step 6: the check run on the reviewed head.
      const checkRun = yield* once(
        "checkRun",
        Schema.NullOr(GitHubLink),
        persist(
          client.upsertCheckRun({
            headSha: state.headSha,
            ...(plan._tag === "Superseded"
              ? {
                  state: { status: "completed", conclusion: "cancelled" } as const,
                  output: checkRunOutput({ _tag: "Cancelled" }),
                }
              : failed || plan._tag !== "Review"
                ? {
                    state: { status: "completed", conclusion: "neutral" } as const,
                    output: checkRunOutput({ _tag: "Errored", error: "publish_failed" }),
                  }
                : {
                    // A partial review stays neutral, and still lists what it found and why it can't approve.
                    state: { status: "completed", conclusion: plan.conclusion } as const,
                    output: checkRunOutput({
                      _tag: "Reviewed",
                      threads: [...newFindings, ...plan.threadLinks],
                      gateFailures,
                      dismissalFailures,
                      incomplete: plan.conclusion === "neutral",
                    }),
                  }),
            ...(state.checkRun === null ? {} : { checkRunId: state.checkRun.id }),
          }),
        ).pipe(
          Effect.map((link): GitHubLink | null => link),
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning("Couldn't update the PR review check run").pipe(
                Effect.annotateLogs(errorFields(error)),
              ),
              null,
            ),
          ),
        ),
      )

      // Step 7: the run record, upserted onto the start row, with its findings.
      // It's journalled first, so the run entity can write it again until
      // Postgres takes it, without holding up `RunFinished`.
      const status: FinalStatus =
        plan._tag === "Superseded"
          ? "cancelled"
          : failed || plan._tag !== "Review"
            ? "failed"
            : plan.partial
              ? "partial"
              : posted._tag === "Posted" && plan.event !== null
                ? STATUS[posted.event]
                : plan.status
      const errorCategory = failed
        ? ("publish_failed" as const)
        : plan._tag === "Review" && plan.partial
          ? ("incomplete" as const)
          : null
      const record: RunRecord = {
        runId,
        repositoryId: state.repositoryId,
        number: state.number,
        title: state.title,
        headSha: state.headSha,
        baseSha: state.baseSha,
        trigger: state.trigger,
        startedAt: DateTime.makeUnsafe(state.startedAt),
        status,
        verdict: posted._tag === "Posted" ? posted.event : null,
        failedGates: gateFailures.map((gate) => gate._tag),
        standardsSources: state.standardsSources ?? null,
        resumeCount: Math.max(0, state.acquires - 1),
        errorCategory,
        finishedAt: DateTime.makeUnsafe(finishedAt),
        review:
          posted._tag === "Posted" ? { id: posted.id, url: reviewUrl(posted.databaseId) } : null,
        checkRun: checkRun ?? state.checkRun,
        findings: plan._tag === "Review" ? plan.findings : [],
      }
      yield* saveRunRecord(storage, record)
      const written = state.finalRowWritten || (yield* writeRunRecord(store, storage, record))

      // Step 8: the per-PR scheduler hears the run is final, once.
      yield* once(
        "runFinished",
        Done,
        schedulers(schedulerEntityId(state.repositoryId, state.number))
          .RunFinished({ runId, finishedAt: DateTime.makeUnsafe(finishedAt) }, { discard: true })
          .pipe(Effect.orDie, Effect.as({})),
      )

      yield* storage
        .update((current) =>
          current.phase !== "publishing"
            ? undefined
            : {
                ...current,
                phase: plan._tag === "Superseded" ? "cancelled" : "published",
                finishedAt,
                errorCategory,
                finalRowWritten: written,
                runFinishedSent: true,
              },
        )
        .pipe(Effect.orDie)
      yield* Effect.logInfo(
        plan._tag === "Superseded" ? "PR review run cancelled" : "PR review run published",
      ).pipe(
        Effect.annotateLogs({
          status,
          verdict: record.verdict ?? "none",
          failedGates: record.failedGates.join(",") || "none",
          ...(errorCategory === null ? {} : { errorCategory }),
          ...(written ? {} : { recorded: false }),
        }),
      )
    }).pipe(
      Effect.annotateLogs({
        runId: run.runId,
        repositoryId: run.state.repositoryId,
        number: run.state.number,
        headSha: run.state.headSha,
      }),
    )

  return RunPublisher.of({ publish: (run) => publish(run).pipe(Effect.orDie) })
})

/** The real `Publish` batch, for the run entity. */
export const RunPublisherLayer = Layer.effect(RunPublisher, makePublisher)
