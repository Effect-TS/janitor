import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Entity from "effect/unstable/cluster/Entity"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import type * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { TeammateId } from "@janitor/domain/Team/Account"
import { ContentPurge } from "../../src/ContentPurge.ts"
import { applyEvent } from "../../src/GitHub/ProjectWebhook.ts"
import { LabelingAutomationIntegrationLayer } from "../../src/Labeling/AutomationIntegration.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import {
  AdmitReview,
  AdmitReviewLayer,
  ADMIT_REVIEW_TAG,
  admissionReasons,
  IssueReviewAdmission,
} from "../../src/Review/Admission.ts"
import { ReviewActionDispatch } from "../../src/Review/Actions.ts"
import { ReviewAgent, ReviewAgentClient, ReviewAgentLayer } from "../../src/Review/Agent.ts"
import { ReviewWorkspaces } from "../../src/Review/Workspace.ts"
import { deniedReasons } from "../../src/Review/Authority.ts"
import { forbiddenReasons, IssueReviewControl } from "../../src/Review/Control.ts"
import {
  disabledNowReason,
  IssueReviewAvailable,
  unavailableReason,
} from "../../src/Review/Gate.ts"
import { IssueReviewScheduler } from "../../src/Review/Scheduler.ts"
import { IssueReviewSettings } from "../../src/Review/Settings.ts"
import { IssueReviewStore } from "../../src/Review/Store.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  github,
  LabelingLayer,
  repositoryId,
  seed,
  webhookNow,
} from "../Labeling/support.ts"

// The entity's in-memory client is created from the entity layer, which
// itself needs a client to start the next run; the reference is set once
// the harness has built it.
type AgentRpcs = typeof ReviewAgent extends Entity.Entity<"ReviewAgent", infer Rpcs> ? Rpcs : never
type AgentClient = (entityId: string) => Effect.Effect<RpcClient.RpcClient<AgentRpcs>>
let agentClient: AgentClient | undefined
const withAgent = <A, E>(
  runId: string,
  use: (client: RpcClient.RpcClient<AgentRpcs>) => Effect.Effect<A, E>,
) => Effect.suspend(() => agentClient!(runId)).pipe(Effect.flatMap(use))

const TestAgentClient = Layer.succeed(ReviewAgentClient, {
  start: (runId, messageId) => withAgent(runId, (client) => client.Start({ messageId })),
  cancel: (runId, message) => withAgent(runId, (client) => client.Cancel(message)),
  actionCompleted: (runId, messageId, sequence) =>
    withAgent(runId, (client) => client.ActionCompleted({ messageId, sequence })),
})

// This suite covers admission and the queue: scheduled actions stay in the
// outbox, and no run ever reaches a sandbox.
const NoDispatch = Layer.succeed(ReviewActionDispatch, { dispatch: () => Effect.void })
const NoWorkspaces = Layer.succeed(ReviewWorkspaces, {
  open: () => {
    const unavailable = Effect.die(new Error("Unexpected workspace use in this suite"))
    return {
      provision: () => unavailable,
      status: unavailable,
      listFiles: () => unavailable,
      readFile: () => unavailable,
      search: () => unavailable,
      release: unavailable,
      execute: () => unavailable,
    }
  },
})

const AgentHarness = Layer.effectDiscard(
  Effect.gen(function* () {
    agentClient = yield* Entity.makeTestClient(ReviewAgent, ReviewAgentLayer)
  }),
)

const ReviewLayer = Layer.mergeAll(
  AdmitReviewLayer,
  IssueReviewSettings.layer,
  IssueReviewControl.layer,
  IssueReviewAdmission.layer,
  AgentHarness,
).pipe(
  Layer.provideMerge(IssueReviewScheduler.layer),
  Layer.provideMerge(
    Layer.mergeAll(IssueReviewStore.layer, TestAgentClient, NoDispatch, NoWorkspaces),
  ),
  Layer.provide(ShardingConfig.layerDefaults),
)

const Services = Layer.mergeAll(LabelingAutomationIntegrationLayer, ContentPurge.layer).pipe(
  Layer.provideMerge(ReviewLayer),
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
  Layer.provide(Layer.succeed(IssueReviewAvailable, true)),
)

const octocat = { id: 9, login: "octocat", type: "User" }
const reader = { id: 10, login: "reader", type: "User" }
const bot = { id: 11, login: "janitor[bot]", type: "Bot" }

let sequence = 500
let deliveries = 0

interface Comment {
  readonly id: number
  readonly issue: number
  readonly body: string
  readonly user?: { id: number; login: string; type: string }
  readonly edited?: boolean
}

/** Puts the comment on GitHub and delivers its webhook through the projection. */
const deliver = (
  comment: Comment,
  options: {
    action?: "created" | "edited" | "deleted"
    pullRequest?: boolean
    /** `null` delivers without a receipt time. */
    receivedAt?: Date | null
    deliveryId?: string
  } = {},
) =>
  Effect.gen(function* () {
    const user = comment.user ?? octocat
    if (options.action !== "deleted")
      github.comments.set(comment.id, {
        id: comment.id,
        issueNumber: comment.issue,
        body: comment.body,
        user,
        ...(comment.edited ? { updatedAt: "2026-09-17T10:05:00Z" } : {}),
      })
    else github.comments.delete(comment.id)
    if (!github.issues.has(comment.issue))
      github.put({
        number: comment.issue,
        title: `Issue ${comment.issue}`,
        state: "open",
        labels: [],
      })
    const deliveryId = options.deliveryId ?? `delivery-${++deliveries}`
    const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)({
      id: deliveryId,
      name: "issue_comment",
      payload: {
        action: options.action ?? "created",
        repository: { id: 701 },
        comment: { id: comment.id, body: comment.body, user },
        issue: {
          number: comment.issue,
          ...(options.pullRequest ? { pull_request: { url: "https://api.github.com/x" } } : {}),
        },
      },
    })
    yield* applyEvent(
      event,
      GitHubWebhookJournalSequence.make(String(++sequence)),
      options.receivedAt === null ? undefined : (options.receivedAt ?? (yield* webhookNow)),
    )
    return deliveryId
  })

const closeIssue = (number: number) =>
  Effect.gen(function* () {
    const issue = github.issues.get(number)!
    issue.state = "closed"
    const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)({
      id: `delivery-${++deliveries}`,
      name: "issues",
      payload: {
        action: "closed",
        installation: { id: 77 },
        repository: { id: 701, full_name: "effect/one" },
        issue: {
          id: 1000 + number,
          node_id: `I_${number}`,
          number,
          title: issue.title,
          body: null,
          state: "closed",
          user: { id: 9, login: "octocat" },
          labels: [],
          updated_at: new Date().toISOString(),
        },
      },
    })
    yield* applyEvent(event, GitHubWebhookJournalSequence.make(String(++sequence)))
  })

const admit = (commentId: number) =>
  AdmitReview.execute({ repositoryId, commentId: String(commentId) })

const history = Effect.flatMap(IssueReviewStore, (store) => store.history(repositoryId))

const runFor = (commentId: number) =>
  Effect.map(history, (runs) => runs.find((run) => run.commentId === String(commentId)))

const queuedAdmissions = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ execution_key: string }>`
    SELECT execution_key FROM workflow_outbox WHERE workflow_tag = ${ADMIT_REVIEW_TAG}
    ORDER BY execution_key`,
)

const enable = (dryRun = true) =>
  Effect.flatMap(IssueReviewSettings, (settings) =>
    settings.set(repositoryId, { enabled: true, dryRun }, actor),
  )

const receipt = (commentId: number) =>
  Effect.flatMap(IssueReviewStore, (store) => store.receipt(repositoryId, String(commentId))).pipe(
    Effect.map(Option.getOrThrow),
  )

/** A teammate with a linked GitHub account, as the account page would create it. */
const linkedTeammate = (subject: string, account: { id: number; login: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ teammate_id: string }>`
      INSERT INTO teammate (issuer, subject, role) VALUES ('https://team.test', ${subject}, 'member')
      ON CONFLICT (issuer, subject) DO UPDATE SET updated_at = now() RETURNING teammate_id::text`
    yield* sql`INSERT INTO teammate_link (teammate_id, platform, workspace_id, account_id, display_name)
      VALUES (${row!.teammate_id}::uuid, 'github', 'github.com', ${String(account.id)}, ${account.login})
      ON CONFLICT DO NOTHING`
    return TeammateId.make(row!.teammate_id)
  })

layer(Services, { timeout: "2 minutes" })("Issue review", (it) => {
  it.effect("keeps review off by default and behind the deployment gate", () =>
    Effect.gen(function* () {
      yield* seed
      const settings = yield* IssueReviewSettings
      const initial = yield* settings.get(repositoryId)
      assert.deepStrictEqual(
        [initial.enabled, initial.dryRun, initial.available],
        [false, true, true],
      )
      // A deployment without the gate refuses to enable review.
      const gated = yield* IssueReviewSettings.make.pipe(
        Effect.provideService(IssueReviewAvailable, false),
      )
      const refused = yield* gated
        .set(repositoryId, { enabled: true, dryRun: true }, actor)
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "ReviewUnavailable")
      assert.strictEqual(refused.message, unavailableReason)
      const missing = yield* settings.get("999").pipe(Effect.flip)
      assert.strictEqual(missing._tag, "ReviewRepositoryMissing")
    }),
  )

  it.effect("admits one authorized invocation per comment and ignores delivery replay", () =>
    Effect.gen(function* () {
      yield* seed
      yield* enable()
      github.permissions.set("octocat", { id: 9, permission: "write" })
      const first = yield* deliver({
        id: 1,
        issue: 20,
        body: "@janitor is this a regression?",
      })
      assert.deepStrictEqual(
        (yield* queuedAdmissions).map((row) => row.execution_key),
        [`review-admit:${repositoryId}:1`],
      )
      // Admission is a local decision; GitHub is read by the workflow.
      assert.deepStrictEqual(github.requests, [])
      const decided = yield* admit(1)
      assert.strictEqual(decided.outcome, "admitted")
      const run = yield* runFor(1)
      assert.strictEqual(run?.status, "running")
      assert.strictEqual(run?.queuePosition, 1)
      assert.strictEqual(run?.invokerLogin, "octocat")
      assert.strictEqual(run?.invokerId, "9")
      assert.strictEqual(run?.instructions, "@janitor is this a regression?")
      assert.strictEqual(run?.dryRun, true)
      assert.isNotNull(run?.deadlineAt)
      assert.deepStrictEqual(
        github.reads.map((request) => request.url),
        [
          "/repos/effect/one",
          "/repos/effect/one/issues/20",
          "/repos/effect/one/issues/comments/1",
          "/repos/effect/one/collaborators/octocat/permission",
        ],
      )
      assert.deepStrictEqual(github.writes, [])

      // The same delivery again, and the same comment under a new delivery id.
      yield* deliver(
        { id: 1, issue: 20, body: "@janitor is this a regression?" },
        { deliveryId: first },
      )
      yield* deliver({ id: 1, issue: 20, body: "@janitor is this a regression?" })
      // The admission workflow is keyed by the comment: a replay returns the
      // recorded decision without another GitHub read or run.
      const reads = github.reads.length
      const again = yield* admit(1)
      assert.deepStrictEqual([again.outcome, again.runId], ["admitted", decided.runId])
      assert.strictEqual(github.reads.length, reads)
      assert.lengthOf(
        (yield* history).filter((run) => run.issueNumber === 20),
        1,
      )
      // A separately posted comment with identical text is its own invocation.
      yield* deliver({ id: 2, issue: 20, body: "@janitor is this a regression?" })
      yield* admit(2)
      const second = yield* runFor(2)
      assert.strictEqual(second?.status, "queued")
      assert.strictEqual(second?.queuePosition, 2)
    }),
  )

  it.effect("denies quoted, bot, pull request, edited and unauthorized invocations", () =>
    Effect.gen(function* () {
      github.permissions.set("reader", { id: 10, permission: "read" })
      const store = yield* IssueReviewStore
      // No direct mention: nothing is recorded at all.
      yield* deliver({ id: 30, issue: 21, body: "> @janitor look\n\nquoting the above" })
      yield* deliver({ id: 31, issue: 21, body: "run `@janitor` locally" })
      assert.isTrue(Option.isNone(yield* store.receipt(repositoryId, "30")))
      assert.isTrue(Option.isNone(yield* store.receipt(repositoryId, "31")))
      // A pull request conversation is not an issue.
      yield* deliver({ id: 32, issue: 22, body: "@janitor review" }, { pullRequest: true })
      assert.isTrue(Option.isNone(yield* store.receipt(repositoryId, "32")))
      // Bots are denied at once; the receipt records why.
      yield* deliver({ id: 33, issue: 21, body: "@janitor review", user: bot })
      assert.strictEqual((yield* receipt(33)).reason, deniedReasons.bot)
      // Read permission is not enough, and the receipt settles once.
      yield* deliver({ id: 34, issue: 21, body: "@janitor review", user: reader })
      const denied = yield* admit(34)
      assert.deepStrictEqual([denied.outcome, denied.reason], ["denied", deniedReasons.permission])
      assert.isUndefined(yield* runFor(34))
      // A permission lookup that fails denies too.
      yield* deliver({
        id: 35,
        issue: 21,
        body: "@janitor review",
        user: { id: 12, login: "ghost", type: "User" },
      })
      assert.strictEqual((yield* admit(35)).reason, deniedReasons.permissionUnavailable)
      // A comment edited before admission is not the comment that was posted.
      yield* deliver({ id: 36, issue: 21, body: "@janitor review", edited: true })
      assert.strictEqual((yield* admit(36)).reason, deniedReasons.commentEdited)
      // A forged author: GitHub names someone else as the comment's author.
      yield* deliver({ id: 37, issue: 21, body: "@janitor review" })
      github.comments.get(37)!.user = reader
      assert.strictEqual((yield* admit(37)).reason, deniedReasons.commentAuthor)
      // The issue closed between delivery and admission.
      yield* deliver({ id: 38, issue: 23, body: "@janitor review" })
      github.issues.get(23)!.state = "closed"
      assert.strictEqual((yield* admit(38)).reason, deniedReasons.issueClosed)
      assert.lengthOf(
        (yield* history).filter((run) => run.issueNumber === 21),
        0,
      )
    }),
  )

  it.effect("serializes runs per issue, runs issues concurrently and applies duplicates once", () =>
    Effect.gen(function* () {
      // Issue 20 already has a running run and a queued one; another issue
      // starts at once.
      yield* deliver({ id: 3, issue: 24, body: "@janitor check the docs" })
      yield* admit(3)
      assert.strictEqual((yield* runFor(3))?.status, "running")
      assert.strictEqual((yield* runFor(2))?.status, "queued")
      // Duplicate deliveries of the agent's own messages apply once.
      const head = (yield* runFor(1))!
      const before = head.deadlineAt
      const snapshot = yield* withAgent(head.runId, (client) =>
        client.Start({ messageId: `start:${head.runId}` }),
      )
      assert.strictEqual(snapshot.status, "running")
      assert.deepStrictEqual((yield* runFor(1))?.deadlineAt, before)
      const sql = yield* SqlClient.SqlClient
      const messages = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM issue_review_message WHERE run_id::text = ${head.runId}`
      assert.strictEqual(messages[0]?.count, "1")
      // Cancelling the head starts the next queued run of that issue only.
      const cancelled = yield* withAgent(head.runId, (client) =>
        client.Cancel({
          messageId: "test:cancel-1",
          reason: "Cancelled in the test.",
          actor: "tester",
        }),
      )
      assert.strictEqual(cancelled.status, "cancelled")
      const repeated = yield* withAgent(head.runId, (client) =>
        client.Cancel({
          messageId: "test:cancel-1",
          reason: "Cancelled in the test.",
          actor: "tester",
        }),
      )
      assert.strictEqual(repeated.status, "cancelled")
      const first = yield* runFor(1)
      assert.deepStrictEqual(
        [first?.status, first?.cancelReason, first?.cancelledBy, first?.queuePosition],
        ["cancelled", "Cancelled in the test.", "tester", null],
      )
      const next = yield* runFor(2)
      assert.deepStrictEqual([next?.status, next?.queuePosition], ["running", 1])
      assert.strictEqual((yield* runFor(3))?.status, "running")
    }),
  )

  it.effect("lets a linked teammate with write permission cancel a run from the frontend", () =>
    Effect.gen(function* () {
      const control = yield* IssueReviewControl
      const running = (yield* runFor(2))!
      const unlinked = yield* linkedTeammate("nobody", { id: 0, login: "unused" }).pipe(
        Effect.tap((teammateId) =>
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`DELETE FROM teammate_link WHERE teammate_id::text = ${teammateId}`,
          ),
        ),
      )
      const noLink = yield* control
        .cancel(repositoryId, running.runId, unlinked, undefined)
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [noLink._tag, (noLink as { message?: string }).message],
        ["ReviewForbidden", forbiddenReasons.unlinked],
      )
      const reading = yield* linkedTeammate("reader", { id: 10, login: "reader" })
      const insufficient = yield* control
        .cancel(repositoryId, running.runId, reading, undefined)
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [insufficient._tag, (insufficient as { message?: string }).message],
        ["ReviewForbidden", deniedReasons.permission],
      )
      const writer = yield* linkedTeammate("octocat", { id: 9, login: "octocat" })
      const snapshot = yield* control.cancel(
        repositoryId,
        running.runId,
        writer,
        "  Not needed anymore ",
      )
      assert.deepStrictEqual(
        [snapshot.status, snapshot.cancelReason],
        ["cancelled", "Not needed anymore"],
      )
      assert.strictEqual((yield* runFor(2))?.cancelledBy, "octocat")
      const finished = yield* control
        .cancel(repositoryId, running.runId, writer, undefined)
        .pipe(Effect.flip)
      assert.strictEqual(finished._tag, "ReviewRunFinished")
      const unknown = yield* control
        .cancel(repositoryId, "00000000-0000-0000-0000-000000000000", writer, undefined)
        .pipe(Effect.flip)
      assert.strictEqual(unknown._tag, "ReviewRunNotFound")
      assert.deepStrictEqual(github.writes, [])
    }),
  )

  it.effect("stops runs when the invoking comment changes or the issue closes", () =>
    Effect.gen(function* () {
      // Issue 24's run is running; an edit of its comment stops it and a
      // deleted comment cannot start anything later.
      yield* deliver(
        { id: 3, issue: 24, body: "@janitor check the docs (edited)" },
        { action: "edited" },
      )
      const edited = yield* runFor(3)
      assert.deepStrictEqual(
        [edited?.status, edited?.cancelReason],
        ["cancelled", admissionReasons.edited],
      )
      assert.strictEqual((yield* receipt(3)).outcome, "admitted")
      // A pending receipt whose comment is deleted before admission settles denied.
      yield* deliver({ id: 4, issue: 25, body: "@janitor please" })
      yield* deliver({ id: 4, issue: 25, body: "@janitor please" }, { action: "deleted" })
      assert.strictEqual((yield* admit(4)).outcome, "settled")
      assert.strictEqual((yield* receipt(4)).reason, admissionReasons.deleted)
      assert.isUndefined(yield* runFor(4))
      // Closing an issue cancels its active and queued runs, nothing else.
      yield* deliver({ id: 5, issue: 26, body: "@janitor one" })
      yield* deliver({ id: 6, issue: 26, body: "@janitor two" })
      yield* deliver({ id: 7, issue: 27, body: "@janitor other issue" })
      yield* admit(5)
      yield* admit(6)
      yield* admit(7)
      assert.deepStrictEqual(
        [(yield* runFor(5))?.status, (yield* runFor(6))?.status, (yield* runFor(7))?.status],
        ["running", "queued", "running"],
      )
      yield* closeIssue(26)
      assert.deepStrictEqual(
        [(yield* runFor(5))?.status, (yield* runFor(6))?.cancelReason, (yield* runFor(7))?.status],
        ["cancelled", admissionReasons.issueClosed, "running"],
      )
      // Reopening does not restart work: the issue's scheduling record is idle.
      github.issues.get(26)!.state = "open"
      yield* Effect.flatMap(IssueReviewScheduler, (scheduler) =>
        scheduler.advance(repositoryId, 26),
      )
      assert.strictEqual((yield* runFor(5))?.status, "cancelled")
    }),
  )

  it.effect("fences comments from disabled and paused periods and never revives old work", () =>
    Effect.gen(function* () {
      const settings = yield* IssueReviewSettings
      const sql = yield* SqlClient.SqlClient
      // Disabling review cancels the running run of issue 27, even while
      // its agent cannot be reached: the record is the authority.
      const reachable = agentClient
      agentClient = () => Effect.die(new Error("agent unreachable"))
      yield* settings.set(repositoryId, { enabled: false, dryRun: true }, actor)
      agentClient = reachable
      const disabled = yield* runFor(7)
      assert.deepStrictEqual(
        [disabled?.status, disabled?.cancelReason],
        ["cancelled", disabledNowReason],
      )
      // A comment posted while review was off is denied even after re-enabling.
      const whileOff = yield* webhookNow
      yield* enable()
      yield* deliver(
        { id: 8, issue: 28, body: "@janitor from the off period" },
        { receivedAt: whileOff },
      )
      assert.strictEqual((yield* receipt(8)).reason, admissionReasons.beforeEnablement)
      // A delivery whose receipt time is unknown cannot be placed after enablement.
      yield* deliver({ id: 13, issue: 28, body: "@janitor undated" }, { receivedAt: null })
      assert.strictEqual((yield* receipt(13)).reason, admissionReasons.unknownReceipt)
      yield* deliver({ id: 9, issue: 28, body: "@janitor after enabling" })
      yield* admit(9)
      assert.strictEqual((yield* runFor(9))?.status, "running")
      // A pause ends every live run with the repository's block reason.
      yield* deliver({ id: 10, issue: 28, body: "@janitor queued behind" })
      yield* admit(10)
      yield* sql`UPDATE github_repository SET enabled = FALSE WHERE repository_id = ${repositoryId}`
      const paused = yield* runFor(9)
      assert.strictEqual(paused?.status, "cancelled")
      assert.include(paused?.cancelReason, "paused")
      assert.strictEqual((yield* runFor(10))?.status, "cancelled")
      // The pause discarded pending admission work, and a comment arriving
      // while paused records nothing (the projection fence drops it first).
      yield* deliver({ id: 11, issue: 28, body: "@janitor during pause" })
      assert.isTrue(
        Option.isNone(
          yield* Effect.flatMap(IssueReviewStore, (store) => store.receipt(repositoryId, "11")),
        ),
      )
      assert.deepStrictEqual(yield* queuedAdmissions, [])
      // A delivery received before the resumption stays outside the fence.
      const beforeResume = yield* webhookNow
      yield* sql`UPDATE github_repository SET enabled = TRUE WHERE repository_id = ${repositoryId}`
      const eligibility = yield* RepositoryEligibility
      const stale = yield* eligibility.admit(repositoryId, Effect.succeed("admitted"), beforeResume)
      assert.isTrue(Option.isNone(stale))
      yield* Effect.flatMap(IssueReviewScheduler, (scheduler) =>
        scheduler.advance(repositoryId, 28),
      )
      assert.strictEqual((yield* runFor(9))?.status, "cancelled")
      assert.strictEqual((yield* runFor(10))?.status, "cancelled")
      // New work after resumption runs under the new generation.
      yield* deliver({ id: 12, issue: 28, body: "@janitor after resume" })
      yield* admit(12)
      assert.strictEqual((yield* runFor(12))?.status, "running")
    }),
  )

  it.effect("restores the agent from persisted state after a restart", () =>
    Effect.gen(function* () {
      // A fresh in-memory client stands in for a runner restart: the entity
      // has no memory of its own and reads the run record.
      agentClient = yield* Entity.makeTestClient(ReviewAgent, ReviewAgentLayer).pipe(
        Effect.provide(ShardingConfig.layerDefaults),
      )
      const running = (yield* runFor(12))!
      const restarted = yield* withAgent(running.runId, (client) =>
        client.Start({ messageId: `start:${running.runId}` }),
      )
      assert.strictEqual(restarted.status, "running")
      assert.deepStrictEqual((yield* runFor(12))?.deadlineAt, running.deadlineAt)
      const cancelled = yield* withAgent(running.runId, (client) =>
        client.Cancel({
          messageId: "test:restart-cancel",
          reason: "Stopped after restart.",
          actor: null,
        }),
      )
      assert.strictEqual(cancelled.status, "cancelled")
      const unknown = yield* withAgent("00000000-0000-0000-0000-000000000000", (client) =>
        client.Start({ messageId: "start:unknown" }),
      ).pipe(Effect.flip)
      assert.strictEqual(unknown._tag, "@janitor/cluster/Review/ReviewRunMissing")
      assert.deepStrictEqual(github.writes, [])
    }).pipe(Effect.scoped),
  )
})
