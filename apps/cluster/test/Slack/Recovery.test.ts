import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  GitHubFeedback,
  GitHubFeedbackApi,
  GitHubFeedbackConfig,
} from "../../src/GitHub/Feedback.ts"
import { SlackRecovery } from "../../src/Slack/Recovery.ts"
import { SlackConversation } from "../../src/Slack/Conversation.ts"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackTransport, type SlackMessage } from "../../src/Slack/Transport.ts"
import { Teammates, TeammatesConfig } from "../../src/Teammates.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"

let slackMessages: SlackMessage[] = []
const review = {
  id: "987",
  user: { id: "42", type: "User" },
  body: "Please correct the calculation",
  submitted_at: "2026-09-12T00:00:00Z",
  state: "COMMENTED",
}
const services = SlackRecovery.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(GitHubFeedback.layer, SlackConversation.layer)),
  Layer.provide(
    Layer.succeed(GitHubFeedbackApi, {
      review: () => Effect.succeed(review),
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
const setup = Effect.gen(function* () {
  slackMessages = []
  const sql = yield* SqlClient.SqlClient
  yield* sql`TRUNCATE github_feedback_receipt,github_feedback,slack_receipt,slack_contribution CASCADE`
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
layer(services, { timeout: "3 minutes" })("Slack thread recovery", (it) => {
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
})
