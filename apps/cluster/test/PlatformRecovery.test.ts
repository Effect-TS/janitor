import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { GitHubAppAuth } from "../src/GitHub/AppAuth.ts"
import { GitHubRecovery } from "../src/GitHub/Recovery.ts"
import {
  GitHubRecoveryApi,
  RecoveryError,
  type DeliverySummary,
} from "../src/GitHub/RecoveryHttp.ts"
import { GitHubFeedback, GitHubFeedbackApi, GitHubFeedbackConfig } from "../src/GitHub/Feedback.ts"
import { SlackRecovery } from "../src/Slack/Recovery.ts"
import { SlackConversation } from "../src/Slack/Conversation.ts"
import { SlackConfig } from "../src/Slack/Config.ts"
import { SlackTransport, type SlackMessage } from "../src/Slack/Transport.ts"
import { Teammates, TeammatesConfig } from "../src/Teammates.ts"
import { AgentSessions } from "../src/Agent/Sessions.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "./Agent/support.ts"

let summaries: DeliverySummary[] = []
let cursor = ""
let unavailable = false
let throttle = false
let expiredCursor = false
const fetched: string[] = []
const cursors: string[] = []
let slackMessages: SlackMessage[] = []
const body = {
  action: "submitted",
  repository: { id: "12345" },
  pull_request: { number: 7 },
  review: {
    id: "987",
    user: { id: "42", type: "User" },
    body: "Please correct the calculation",
    submitted_at: "2026-09-12T00:00:00Z",
    state: "COMMENTED",
  },
}
const services = Layer.mergeAll(GitHubRecovery.layer, SlackRecovery.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(GitHubFeedback.layer, SlackConversation.layer)),
  Layer.provide(
    Layer.succeed(GitHubRecoveryApi, {
      list: (after) =>
        Effect.suspend(() => {
          cursors.push(after)
          if (expiredCursor && after !== "")
            return Effect.fail(
              new RecoveryError({ message: "Cursor expired", retryAfter: 30, unavailable: true }),
            )
          return Effect.succeed({ deliveries: summaries, cursor, retryAfter: 0 })
        }),
      payload: (id) =>
        Effect.suspend(() => {
          fetched.push(id)
          if (throttle)
            return Effect.fail(
              new RecoveryError({ message: "Throttle", retryAfter: 3600, unavailable: false }),
            )
          if (unavailable)
            return Effect.fail(
              new RecoveryError({ message: "Expired", retryAfter: 30, unavailable: true }),
            )
          return Effect.succeed({
            delivery: summaries.find((s) => s.id === id)!,
            payload: body,
            retryAfter: 0,
          })
        }),
    }),
  ),
  Layer.provide(
    Layer.succeed(GitHubFeedbackApi, {
      review: () => Effect.succeed(body.review),
      comments: () => Effect.succeed({ comments: [], next: "" }),
    }),
  ),
  Layer.provide(Layer.succeed(GitHubFeedbackConfig, { botLogin: "janitor[bot]" })),
  Layer.provide(
    Layer.succeed(SlackTransport, {
      channel: () => Effect.succeed({ is_private: true, is_member: true }),
      replies: () => Effect.succeed({ messages: slackMessages, cursor: "" }),
      post: () => Effect.die("Unexpected post"),
      update: () => Effect.die("Unexpected update"),
      ephemeral: () => Effect.void,
    }),
  ),
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
  Layer.provideMerge(
    Teammates.layer.pipe(
      Layer.provide(Layer.succeed(TeammatesConfig, { initialAdmin: Option.none() })),
    ),
  ),
  Layer.provideMerge(agentLayers(fakeRunnerLayer(new FakeRunner()))),
)
const summary = (id: string, guid: string): DeliverySummary => ({
  id,
  guid,
  event: "pull_request_review",
  action: "submitted",
  repository_id: "12345",
  delivered_at: "2026-09-12T00:00:00Z",
})
const due = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE platform_recovery SET due_at=CLOCK_TIMESTAMP()-interval '1 second'`
})
const setup = Effect.gen(function* () {
  fetched.length = 0
  cursors.length = 0
  summaries = []
  cursor = ""
  unavailable = false
  throttle = false
  expiredCursor = false
  slackMessages = []
  const sql = yield* SqlClient.SqlClient
  yield* sql`TRUNCATE github_recovery_attempt,github_feedback_receipt,github_feedback,slack_receipt,slack_contribution CASCADE`
  yield* sql`UPDATE platform_recovery SET cursor='',due_at=CLOCK_TIMESTAMP(),completed_at=NULL,warning=NULL,lease_until=NULL,lease_token=NULL`
  yield* sql`UPDATE slack_thread SET recovery_cursor='',recovery_oldest=NULL,recovery_highwater=NULL,recovery_due_at=CLOCK_TIMESTAMP(),recovery_completed_at=NULL,recovery_lease_until=NULL,recovery_lease_token=NULL`
  yield* sql`INSERT INTO github_installation (installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence,access_error) VALUES ('recovery-i','1','team','Organization','all','active','https://github.com/team',1,NULL) ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO github_repository (repository_id,installation_id,owner,repo,access,enabled,projected_sequence,automation_ready_at) VALUES ('12345','recovery-i','team','repo','accessible',true,1,now()) ON CONFLICT DO NOTHING`
  const sessions = yield* AgentSessions
  yield* sessions.start({ sessionId: "recovery", title: "Recovery", repositoryId: "12345" })
  yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,repository_id,pr_number,state,context) VALUES ('recovery','T1','C1','1.000001','1.000002','12345','7','ready','[]') ON CONFLICT DO NOTHING`
  const teammates = yield* Teammates
  const member = yield* teammates.admit({
    issuer: "test",
    subject: "member",
    email: undefined,
  })
  yield* teammates.link(member.teammate.teammateId, {
    platform: "github",
    workspaceId: "github.com",
    accountId: "42",
    displayName: "Reviewer",
  })
})
layer(services, { timeout: "3 minutes" })("Platform recovery", (it) => {
  it.effect("records expired cursor gaps and resumes discovery of the retained window", () =>
    Effect.gen(function* () {
      yield* setup
      const recovery = yield* GitHubRecovery
      cursor = "expired-page"
      yield* recovery.processDue
      expiredCursor = true
      yield* due
      yield* recovery.processDue
      expiredCursor = false
      cursor = ""
      yield* due
      yield* recovery.processDue
      assert.deepStrictEqual(cursors, ["", "expired-page", ""])
      assert.include(
        (yield* (yield* AgentSessions).view("recovery")).recovery.find(
          (row) => row.platform === "github",
        )!.gap!,
        "cursor",
      )
    }),
  )
  it.effect(
    "retains exact attempt IDs and opaque page progress while deduplicating redelivery GUIDs",
    () =>
      Effect.gen(function* () {
        yield* setup
        const recovery = yield* GitHubRecovery
        summaries = [
          summary("9007199254740993123", "same-guid"),
          { ...summary("2", "irrelevant"), event: "push", action: null },
        ]
        cursor = "opaque-next-page"
        yield* recovery.processDue
        assert.deepStrictEqual(fetched, [])
        yield* due
        yield* recovery.processDue
        assert.deepStrictEqual(fetched, ["9007199254740993123"])
        summaries = [summary("9007199254740993124", "same-guid")]
        cursor = ""
        yield* due
        yield* recovery.processDue
        assert.deepStrictEqual(cursors, ["", "opaque-next-page"])
        yield* due
        yield* recovery.processDue
        assert.deepStrictEqual(fetched, ["9007199254740993123"])
        const feedback = yield* GitHubFeedback
        assert.strictEqual((yield* feedback.inspect("recovery")).length, 1)
      }),
  )
  it.effect(
    "keeps throttled payloads pending and reports expired history without inventing feedback",
    () =>
      Effect.gen(function* () {
        yield* setup
        const recovery = yield* GitHubRecovery
        const sessions = yield* AgentSessions
        summaries = [summary("9007199254740993125", "expired-guid")]
        yield* due
        yield* recovery.processDue
        throttle = true
        yield* due
        yield* recovery.processDue
        const count = fetched.length
        yield* recovery.processDue
        assert.strictEqual(fetched.length, count)
        const before = (yield* sessions.view("recovery")).recovery.find(
          (row) => row.platform === "github",
        )!
        assert.strictEqual(before.incomplete, true)
        assert.strictEqual(before.warning, "Throttle")
        throttle = false
        unavailable = true
        yield* due
        yield* recovery.processDue
        unavailable = false
        const after = (yield* sessions.view("recovery")).recovery.find(
          (row) => row.platform === "github",
        )!
        assert.strictEqual(after.incomplete, false)
        assert.include(after.gap!, "expired")
        assert.strictEqual((yield* (yield* GitHubFeedback).inspect("recovery")).length, 0)
      }),
  )
  it.effect("overlaps known threads without replaying rejected inputs or initial context", () =>
    Effect.gen(function* () {
      yield* setup
      const conversation = yield* SlackConversation
      const message = {
        type: "message",
        channel: "C1",
        thread_ts: "1.000001",
        ts: "1.000003",
        user: "U1",
        text: "previously rejected",
      }
      yield* conversation.record("rejected", message, message)
      const teammates = yield* Teammates
      const member = yield* teammates.admit({
        issuer: "test",
        subject: "slack-member",
        email: undefined,
      })
      yield* teammates.link(member.teammate.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "Member",
      })
      slackMessages = [
        { ts: "1.000001", user: "U1", text: "Initial context" },
        { ...message },
        { ts: "1.000004", thread_ts: "1.000001", user: "U1", text: "new feedback" },
        { ts: "1.000005", thread_ts: "1.000001", user: "BOT", text: "bot output" },
        {
          ts: "1.000006",
          thread_ts: "1.000001",
          user: "U1",
          text: "edited",
          subtype: "message_changed",
        },
      ]
      const recovery = yield* SlackRecovery
      yield* recovery.processDue
      const view = yield* conversation.inspect("C1", "1.000001")
      assert.deepStrictEqual(
        view.contributions.map((row) => [row.text, row.decision]),
        [
          ["previously rejected", "rejected"],
          ["new feedback", "accepted"],
        ],
      )
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE slack_thread SET recovery_due_at=CLOCK_TIMESTAMP()-interval '1 second'`
      yield* recovery.processDue
      assert.strictEqual((yield* conversation.inspect("C1", "1.000001")).contributions.length, 2)
    }),
  )
  it.effect(
    "restarts through the real App HTTP adapter without rounding numeric attempt IDs or losing Retry-After",
    () =>
      Effect.gen(function* () {
        yield* setup
        const requests: string[] = []
        const json =
          '{"id":9007199254740993999,"guid":"http-guid","event":"pull_request_review","action":"submitted","repository_id":12345,"delivered_at":"2026-09-12T00:00:00Z"}'
        let limited = true
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            assert.strictEqual(request.headers.authorization, "Bearer test-app-jwt")
            requests.push(request.url)
            const listing = request.url.includes("?")
            const response = listing
              ? new Response(`[${json}]`)
              : limited
                ? new Response("", { status: 429, headers: { "retry-after": "3600" } })
                : new Response(
                    json.slice(0, -1) +
                      ',"request":{"payload":' +
                      JSON.stringify({ ...body, review: { ...body.review, id: "989" } }) +
                      "}}",
                  )
            return HttpClientResponse.fromWeb(request, response)
          }),
        )
        const liveAdapter = Layer.fresh(GitHubRecovery.layer).pipe(
          Layer.provide(
            GitHubRecoveryApi.layer.pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
              Layer.provide(
                Layer.succeed(GitHubAppAuth, {
                  appJwt: Effect.succeed(Redacted.make("test-app-jwt")),
                  installationToken: () =>
                    Effect.die("Installation tokens cannot list App deliveries"),
                  invalidateInstallationToken: () => Effect.void,
                }),
              ),
            ),
          ),
        )
        const restarted = Effect.gen(function* () {
          yield* (yield* GitHubRecovery).processDue
        }).pipe(Effect.provide(liveAdapter))
        yield* due
        yield* restarted
        assert.strictEqual(
          (yield* (yield* AgentSessions).view("recovery")).recovery.find(
            (row) => row.platform === "github",
          )?.warning,
          null,
        )
        yield* due
        yield* restarted
        assert.strictEqual(
          requests.at(-1),
          "https://api.github.com/app/hook/deliveries/9007199254740993999",
        )
        const count = requests.length
        yield* restarted
        assert.strictEqual(requests.length, count)
        limited = false
        yield* due
        yield* restarted
        assert.strictEqual((yield* (yield* GitHubFeedback).inspect("recovery")).length, 1)
      }),
  )
})
