import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Teammates, TeammatesConfig } from "../../src/Teammates.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { deliverSession } from "../../src/Agent/Handoff.ts"
import {
  GitHubFeedback,
  GitHubFeedbackApi,
  GitHubFeedbackConfig,
} from "../../src/GitHub/Feedback.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"
import { SlackDelivery } from "../../src/Slack/Delivery.ts"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackTransport } from "../../src/Slack/Transport.ts"
import {
  GitHubDelivery,
  GitHubCommentApi,
  GitHubCommentError,
} from "../../src/GitHub/FeedbackDelivery.ts"

const runner = new FakeRunner()
const pages = new Map<string, unknown[]>()
const reviews = new Map<string, unknown>()
let posted = 0
let sentMarker = ""
let reconcileMatches = false
const services = Layer.mergeAll(
  GitHubFeedback.layer,
  SlackDelivery.layer,
  GitHubDelivery.layer,
).pipe(
  Layer.provide(
    Layer.succeed(SlackConfig, {
      workspaceId: "T1",
      appId: "A1",
      botUserId: "BOT",
      token: Redacted.make("token"),
      signingSecret: Redacted.make("secret"),
      accountUrl: "https://janitor.test/account",
    }),
  ),
  Layer.provide(
    Layer.succeed(SlackTransport, {
      channel: () => Effect.die("unexpected Slack"),
      replies: () => Effect.die("unexpected Slack"),
      post: () => Effect.die("unexpected Slack"),
      update: () => Effect.die("unexpected Slack"),
      ephemeral: () => Effect.die("unexpected Slack"),
    }),
  ),
  Layer.provide(
    Layer.succeed(GitHubCommentApi, {
      post: (_session, _target, _text, marker) =>
        Effect.suspend(() => {
          posted++
          sentMarker = marker
          return Effect.fail(
            new GitHubCommentError({
              message: "Response lost",
              disposition: "uncertain",
              retryAfter: 0,
            }),
          )
        }),
      reconcile: (_session, _target, marker) =>
        Effect.succeed({ id: reconcileMatches && marker === sentMarker ? "900" : null, next: "" }),
    }),
  ),
  Layer.provide(Layer.succeed(GitHubFeedbackConfig, { botLogin: "janitor[bot]" })),
  Layer.provideMerge(
    Teammates.layer.pipe(
      Layer.provide(
        Layer.succeed(TeammatesConfig, {
          initialAdmin: Option.some({ issuer: "test", subject: "admin" }),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.succeed(GitHubFeedbackApi, {
      review: (_session, id) =>
        Effect.succeed(
          reviews.get(id) ?? {
            id: "100",
            user: { id: "42", type: "User" },
            body: "Overall",
            submitted_at: "2026-09-12T00:00:00Z",
            state: "COMMENTED",
          },
        ),
      comments: (_session, reviewId, cursor) =>
        Effect.succeed({
          comments:
            pages.get(`${reviewId}:${cursor}`) ??
            (reviewId === "100" ? pages.get(cursor) : []) ??
            [],
          next: (reviewId === "100" || reviewId === "700") && cursor === "" ? "page2" : "",
        }),
    }),
  ),
  Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
)
const user = { id: "42", type: "User" }
const review = {
  id: "100",
  user,
  body: "Overall",
  submitted_at: "2026-09-12T00:00:00Z",
  state: "commented",
}
const comment = {
  id: "101",
  user,
  body: "Fix the title",
  pull_request_review_id: "100",
  in_reply_to_id: null,
}
const envelope = { repository: { id: "12345" }, pull_request: { number: 7 } }

layer(services, { timeout: "3 minutes" })("GitHub feedback", (it) => {
  it.effect("groups inline-first paginated reviews once in shared session order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO github_installation (installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES ('feedback-i','1','team','Organization','all','active','https://github.com/team',1)`
      yield* sql`INSERT INTO github_repository (repository_id,installation_id,owner,repo,access,enabled,projected_sequence,automation_ready_at) VALUES ('12345','feedback-i','team','repo','accessible',true,1,now())`
      const sessions = yield* AgentSessions
      yield* sessions.start({ sessionId: "feedback", title: "Review", repositoryId: "12345" })
      yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,repository_id,pr_number,state) VALUES ('feedback','T1','C1','1','1','12345','7','ready')`
      const teammates = yield* Teammates
      const member = yield* teammates.admit({
        issuer: "test",
        subject: "reviewer",
        email: undefined,
      })
      yield* teammates.link(member.teammate.teammateId, {
        platform: "github",
        workspaceId: "github.com",
        accountId: "42",
        displayName: "Reviewer",
      })
      const feedback = yield* GitHubFeedback
      yield* feedback.record("inline", "pull_request_review_comment", {
        ...envelope,
        action: "created",
        comment,
      })
      yield* feedback.record("review", "pull_request_review", {
        ...envelope,
        action: "submitted",
        review,
      })
      pages.set("", [comment])
      pages.set("page2", [{ ...comment, id: "102", body: "Fix the ending" }])
      yield* feedback.processDue
      assert.strictEqual((yield* sessions.view("feedback")).inputs.length, 0)
      yield* feedback.processDue
      const view = yield* sessions.view("feedback")
      assert.strictEqual(view.inputs.length, 1)
      assert.include(view.inputs[0]!.text, "Overall")
      assert.include(view.inputs[0]!.text, "Fix the title")
      assert.include(view.inputs[0]!.text, "Fix the ending")
      yield* feedback.record("duplicate", "pull_request_review_comment", {
        ...envelope,
        action: "created",
        comment: { ...comment, body: "Edited" },
      })
      yield* feedback.processDue
      assert.strictEqual((yield* sessions.view("feedback")).inputs.length, 1)
      assert.notInclude((yield* sessions.view("feedback")).inputs[0]!.text, "Edited")
    }),
  )
  it.effect(
    "requires an exact App mention for conversation comments and excludes bots and edits",
    () =>
      Effect.gen(function* () {
        const feedback = yield* GitHubFeedback
        const sessions = yield* AgentSessions
        const base = {
          repository: envelope.repository,
          issue: { number: 7, pull_request: {} },
          action: "created",
        }
        const before = (yield* sessions.view("feedback")).inputs.length
        for (const [id, body] of [
          ["201", "ordinary discussion"],
          ["202", "@janitor[bot]-impostor please"],
          ["203", "@janitor[bot] fix the ending"],
        ]) {
          yield* feedback.record(id!, "issue_comment", { ...base, comment: { id, body, user } })
        }
        yield* feedback.record("bot", "issue_comment", {
          ...base,
          comment: { id: "204", body: "@janitor[bot] loop", user: { ...user, type: "Bot" } },
        })
        yield* feedback.record("edit", "issue_comment", {
          ...base,
          action: "edited",
          comment: { id: "201", body: "@janitor[bot] changed", user },
        })
        yield* feedback.processDue
        const inputs = (yield* sessions.view("feedback")).inputs
        assert.strictEqual(inputs.length, before + 1)
        assert.include(inputs.at(-1)!.text, "fix the ending")
        assert.strictEqual(
          (yield* feedback.inspect("feedback")).filter((row) => row.state === "context").length,
          2,
        )
      }),
  )
  it.effect("keeps GitHub results off Slack and reconciles a lost send without reposting", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const input = (yield* sessions.view("feedback")).inputs[0]!
      runner.push(
        "feedback",
        { type: "session.execution.started", data: {} },
        { type: "session.inbox.delivered", data: { inboxID: input.runner_message_id } },
        { type: "session.text.ended", data: { text: "Fixed the title and ending." } },
        { type: "session.execution.succeeded", data: {} },
      )
      const slack = yield* SlackDelivery
      yield* slack.catchUp("feedback")
      assert.strictEqual((yield* slack.inspect("feedback")).length, 0)
      const delivery = yield* GitHubDelivery
      yield* delivery.deliver("feedback")
      assert.strictEqual(posted, 1)
      assert.strictEqual((yield* delivery.inspect("feedback"))[0]!.state, "uncertain")
      yield* sessions.accept({
        sessionId: "feedback",
        contributionKey: "slack:after-review",
        source: "slack",
        author: {},
        text: "Continue after replying",
      })
      assert.strictEqual(yield* deliverSession("feedback"), "blocked")
      reconcileMatches = true
      yield* delivery.deliver("feedback")
      assert.strictEqual(posted, 1)
      assert.strictEqual((yield* delivery.inspect("feedback"))[0]!.state, "sent")
      assert.strictEqual(yield* deliverSession("feedback"), "settled")
      yield* slack.catchUp("feedback")
      assert.strictEqual((yield* delivery.inspect("feedback")).length, 1)
    }),
  )
  it.effect(
    "retains a pending-review reply through disconnection and admits later replies separately",
    () =>
      Effect.gen(function* () {
        const teammates = yield* Teammates
        const member = yield* teammates.admit({
          issuer: "test",
          subject: "pending-reviewer",
          email: undefined,
        })
        const proof = {
          platform: "github" as const,
          workspaceId: "github.com",
          accountId: "43",
          displayName: "Pending reviewer",
        }
        const account = yield* teammates.link(member.teammate.teammateId, proof)
        const feedback = yield* GitHubFeedback
        const sessions = yield* AgentSessions
        const before = (yield* sessions.view("feedback")).inputs.length
        const pendingUser = { id: "43", type: "User" }
        const reply = {
          id: "301",
          user: pendingUser,
          body: "Please fix this too",
          pull_request_review_id: "300",
          in_reply_to_id: "101",
        }
        reviews.set("300", {
          id: "300",
          user: pendingUser,
          body: null,
          state: "PENDING",
          submitted_at: null,
        })
        yield* feedback.record("pending-reply", "pull_request_review_comment", {
          ...envelope,
          action: "created",
          comment: reply,
        })
        yield* feedback.processDue
        assert.strictEqual((yield* sessions.view("feedback")).inputs.length, before)
        assert.include(
          (yield* feedback.inspect("feedback")).find((row) => row.review_id === "300")!.warning!,
          "pending",
        )
        yield* teammates.disconnect(member.teammate.teammateId, account.linkId)
        yield* feedback.record("pending-edit", "pull_request_review_comment", {
          ...envelope,
          action: "edited",
          comment: { ...reply, body: "changed" },
        })
        yield* feedback.record("submitted-reply", "pull_request_review", {
          ...envelope,
          action: "submitted",
          review: { ...review, id: "300", user: pendingUser, body: "" },
        })
        pages.set("300:", [reply])
        yield* feedback.processDue
        const accepted = (yield* sessions.view("feedback")).inputs
        assert.strictEqual(accepted.length, before + 1)
        assert.include(accepted.at(-1)!.text, "Please fix this too")
        assert.strictEqual(
          (yield* feedback.inspect("feedback")).find((row) => row.review_id === "300")!
            .inline_target,
          "101",
        )
        yield* teammates.link(member.teammate.teammateId, proof)
        const later = { ...reply, id: "311", pull_request_review_id: "310", body: "A later reply" }
        reviews.set("310", { ...review, id: "310", user: pendingUser, body: "" })
        pages.set("310:", [later])
        yield* feedback.record("later", "pull_request_review_comment", {
          ...envelope,
          action: "created",
          comment: later,
        })
        yield* feedback.processDue
        assert.strictEqual((yield* sessions.view("feedback")).inputs.length, before + 2)
      }),
  )
  it.effect(
    "keeps rejected feedback as context after linking and ignores empty state-only reviews",
    () =>
      Effect.gen(function* () {
        const feedback = yield* GitHubFeedback
        const sessions = yield* AgentSessions
        const before = (yield* sessions.view("feedback")).inputs.length
        const outsider = { id: "44", type: "User" }
        const outsideReview = { ...review, id: "400", user: outsider, body: "Outside suggestion" }
        yield* feedback.record("outside", "pull_request_review", {
          ...envelope,
          action: "submitted",
          review: outsideReview,
        })
        const teammates = yield* Teammates
        const member = yield* teammates.admit({
          issuer: "test",
          subject: "outside",
          email: undefined,
        })
        yield* teammates.link(member.teammate.teammateId, {
          platform: "github",
          workspaceId: "github.com",
          accountId: "44",
          displayName: "Now linked",
        })
        yield* feedback.record("outside-retry", "pull_request_review", {
          ...envelope,
          action: "submitted",
          review: outsideReview,
        })
        yield* feedback.record("empty", "pull_request_review", {
          ...envelope,
          action: "submitted",
          review: { ...review, id: "401", body: null },
        })
        yield* feedback.processDue
        assert.strictEqual((yield* sessions.view("feedback")).inputs.length, before)
        assert.strictEqual(
          (yield* feedback.inspect("feedback")).find((row) => row.review_id === "401")!.state,
          "empty",
        )
        const input = yield* sessions.accept({
          sessionId: "feedback",
          source: "slack",
          contributionKey: "slack:direction",
          author: {},
          text: "Implement the outside suggestion",
        })
        assert.strictEqual(input.sequence, before + 1)
        assert.include(input.text, "Outside suggestion")
        assert.include(input.text, "Implement the outside suggestion")
      }),
  )
  it.effect("keeps unclassified inline feedback visibly pending without executing it", () =>
    Effect.gen(function* () {
      const feedback = yield* GitHubFeedback
      const sessions = yield* AgentSessions
      const before = (yield* sessions.view("feedback")).inputs.length
      yield* feedback.record("unclassified", "pull_request_review_comment", {
        ...envelope,
        action: "created",
        comment: { id: "501", user, body: "Do not lose this", pull_request_review_id: null },
      })
      yield* feedback.processDue
      const pending = (yield* sessions.view("feedback")).feedback.find(
        (row) => row.key === "github:unclassified:501",
      )
      assert.strictEqual(pending?.state, "pending")
      assert.include(pending!.warning!, "classified")
      assert.strictEqual((yield* sessions.view("feedback")).inputs.length, before)
    }),
  )
  it.effect(
    "serializes removal with review capture and never changes the outcome on restoration",
    () =>
      Effect.gen(function* () {
        const teammates = yield* Teammates
        const admin = yield* teammates.admit({ issuer: "test", subject: "admin", email: undefined })
        const member = yield* teammates.admit({
          issuer: "test",
          subject: "racing-reviewer",
          email: undefined,
        })
        yield* teammates.link(member.teammate.teammateId, {
          platform: "github",
          workspaceId: "github.com",
          accountId: "45",
          displayName: "Racing reviewer",
        })
        const feedback = yield* GitHubFeedback
        const event = {
          ...envelope,
          action: "submitted",
          review: {
            ...review,
            id: "600",
            user: { id: "45", type: "User" },
            body: "Original direction",
          },
        }
        yield* Effect.all(
          [
            feedback.record("race", "pull_request_review", event),
            teammates.remove(admin.teammate.teammateId, member.teammate.teammateId),
          ],
          { concurrency: 2 },
        )
        const captured = (yield* feedback.inspect("feedback")).find(
          (row) => row.review_id === "600",
        )!
        yield* teammates.restore(admin.teammate.teammateId, member.teammate.teammateId)
        yield* feedback.record("race-retry", "pull_request_review", {
          ...event,
          review: { ...event.review, body: "Changed retry" },
        })
        yield* feedback.processDue
        const settled = (yield* feedback.inspect("feedback")).find(
          (row) => row.review_id === "600",
        )!
        assert.strictEqual(settled.state, captured.authorized ? "accepted" : "context")
        assert.strictEqual(settled.body, "Original direction")
      }),
  )
  it.effect(
    "preserves captured comments when paginated membership shifts after edits and deletion",
    () =>
      Effect.gen(function* () {
        const feedback = yield* GitHubFeedback
        const sessions = yield* AgentSessions
        const first = {
          ...comment,
          id: "701",
          pull_request_review_id: "700",
          body: "First captured text",
        }
        yield* feedback.record("mutable-review", "pull_request_review", {
          ...envelope,
          action: "submitted",
          review: { ...review, id: "700", body: "Review body" },
        })
        pages.set("700:", [first])
        yield* feedback.processDue
        yield* feedback.record("deleted-member", "pull_request_review_comment", {
          ...envelope,
          action: "deleted",
          comment: first,
        })
        pages.set("700:page2", [
          { ...first, body: "Edited later" },
          { ...first, id: "702", body: "Second member" },
        ])
        yield* feedback.processDue
        const input = (yield* sessions.view("feedback")).inputs.find(
          (row) => row.contribution_key === "github:review:700",
        )!
        assert.include(input.text, "First captured text")
        assert.include(input.text, "Second member")
        assert.notInclude(input.text, "Edited later")
      }),
  )

  it.effect("uses the root inline target when a later reply's review envelope arrives first", () =>
    Effect.gen(function* () {
      const feedback = yield* GitHubFeedback
      const reply = {
        ...comment,
        id: "801",
        pull_request_review_id: "800",
        in_reply_to_id: "101",
        body: "Later reply",
      }
      pages.set("800:", [reply])
      yield* feedback.record("review-first-reply", "pull_request_review", {
        ...envelope,
        action: "submitted",
        review: { ...review, id: "800", body: "" },
      })
      yield* feedback.processDue
      assert.strictEqual(
        (yield* feedback.inspect("feedback")).find((row) => row.review_id === "800")!.inline_target,
        "101",
      )
      yield* feedback.record("reply-after-review", "pull_request_review_comment", {
        ...envelope,
        action: "created",
        comment: reply,
      })
      assert.strictEqual(
        (yield* (yield* AgentSessions).view("feedback")).inputs.filter(
          (row) => row.contribution_key === "github:review:800",
        ).length,
        1,
      )
    }),
  )
})
