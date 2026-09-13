import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { SlackDelivery } from "../../src/Slack/Delivery.ts"
import { SlackProcessor } from "../../src/Slack/Processor.ts"
import { SlackTransport } from "../../src/Slack/Transport.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { deliverSession } from "../../src/Agent/Handoff.ts"
import { RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import { Teammates, TeammatesConfig } from "../../src/Teammates.ts"
import { SlackConversation } from "../../src/Slack/Conversation.ts"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackWebhook } from "../../src/Slack/Webhook.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"

const config = {
  workspaceId: "T1",
  appId: "A1",
  botUserId: "UBOT",
  signingSecret: Redacted.make("secret"),
  token: Redacted.make("token"),
  accountUrl: "https://janitor.test/account",
}
const runner = new FakeRunner()
const onboarding: string[] = []
const slack: SlackTransport["Service"] = {
  channel: () => Effect.succeed({ is_private: true, is_member: true }),
  replies: (_channel, root, cursor) =>
    Effect.succeed({
      messages:
        cursor === ""
          ? [
              { type: "message", ts: root, user: "UHISTORY", text: "Earlier discussion" },
              {
                type: "message",
                ts: "200.000002",
                thread_ts: root,
                user: "U1",
                text: "second context",
              },
            ]
          : [{ type: "message", ts: root, user: "UHISTORY", text: "Earlier discussion" }],
      cursor: cursor === "" ? "next" : "",
    }),
  post: () => Effect.succeed("500.000001"),
  update: (_channel, ts) => Effect.succeed(ts),
  ephemeral: (_channel, user) =>
    Effect.sync(() => {
      onboarding.push(user)
    }),
}
const services = Layer.mergeAll(SlackWebhook.layer, SlackProcessor.layer, SlackDelivery.layer).pipe(
  Layer.provideMerge(Layer.succeed(SlackTransport, slack)),
  Layer.provideMerge(SlackConversation.layer),
  Layer.provideMerge(
    Teammates.layer.pipe(
      Layer.provide(Layer.succeed(TeammatesConfig, { initialAdmin: Option.none() })),
    ),
  ),
  Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
  Layer.provide(Layer.succeed(SlackConfig, config)),
)

const signed = (event: unknown, eventId: string) =>
  Effect.gen(function* () {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event_id: eventId,
      event,
    })
    const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000))
    const signature = yield* Effect.promise(async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      const bytes = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)),
      )
      return `v0=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    })
    return { body, timestamp, signature }
  })

layer(services, { timeout: "3 minutes" })("Slack conversation", (it) => {
  it.effect("journals signed overlapping callbacks once and freezes rejection across linking", () =>
    Effect.gen(function* () {
      const webhook = yield* SlackWebhook
      const conversation = yield* SlackConversation
      const event = {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        ts: "100.000001",
        text: "<@UBOT> help",
      }
      const request = yield* signed(event, "Ev1")
      assert.strictEqual(
        (yield* webhook.receive({ ...request, signature: `v0=${"0".repeat(64)}` })).status,
        401,
      )
      assert.strictEqual((yield* webhook.receive({ ...request, timestamp: "1" })).status, 401)
      assert.strictEqual((yield* webhook.receive(request)).status, 200)
      const teammates = yield* Teammates
      const member = yield* teammates.admit({ issuer: "test", subject: "one", email: undefined })
      yield* teammates.link(member.teammate.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "One",
      })
      yield* webhook.receive(
        yield* signed({ ...event, type: "message", channel_type: "group" }, "Ev2"),
      )
      const view = yield* conversation.inspect("C1", "100.000001")
      assert.strictEqual(view.receipts, 2)
      assert.strictEqual(view.contributions.length, 1)
      assert.strictEqual(view.contributions[0]?.decision, "rejected")
      assert.isNull(view.thread)
      yield* webhook.receive(yield* signed({ ...event, ts: "100.000002" }, "Ev1"))
      assert.isNull((yield* conversation.inspect("C1", "100.000002")).thread)
    }),
  )
  it.effect(
    "buffers two teammates through paged initialization and admits ordinary replies once",
    () =>
      Effect.gen(function* () {
        const teammates = yield* Teammates
        for (const user of ["U2", "U3"]) {
          const member = yield* teammates.admit({ issuer: "test", subject: user, email: undefined })
          yield* teammates.link(member.teammate.teammateId, {
            platform: "slack",
            workspaceId: "T1",
            accountId: user,
            displayName: user,
          })
        }
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO github_installation (installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence,access_error) VALUES ('slack-i','1','team','Organization','all','active','https://github.com/team',1,NULL)`
        yield* sql`INSERT INTO github_repository (repository_id,installation_id,owner,repo,access,enabled,projected_sequence,automation_ready_at) VALUES ('12345','slack-i','team','repo','accessible',true,1,now())`
        const webhook = yield* SlackWebhook
        const conversation = yield* SlackConversation
        const processor = yield* SlackProcessor
        const mention = {
          type: "app_mention",
          channel: "C2",
          user: "U2",
          ts: "200.000003",
          thread_ts: "200.000001",
          text: "<@UBOT> help",
        }
        yield* webhook.receive(yield* signed(mention, "Ev3"))
        const before = yield* conversation.inspect("C2", "200.000001")
        const id = before.thread!.session_id
        yield* processor.process(id)
        yield* processor.process(id)
        assert.include(
          (yield* conversation.inspect("C2", "200.000001")).thread!.warning!,
          "Which connected repository",
        )
        assert.strictEqual(
          (yield* (yield* AgentSessions).view(id).pipe(Effect.flip))._tag,
          "@janitor/cluster/Agent/AgentSessionNotFound",
        )
        yield* webhook.receive(
          yield* signed(
            {
              type: "message",
              channel_type: "group",
              channel: "C2",
              user: "U3",
              ts: "200.000004",
              thread_ts: "200.000001",
              text: "Use team/repo",
            },
            "Ev4",
          ),
        )
        yield* Effect.all([processor.process(id), processor.process(id)], { concurrency: 2 })
        yield* processor.process(id)
        assert.isNull((yield* conversation.inspect("C2", "200.000001")).thread?.warning)
        const view = yield* (yield* AgentSessions).view(id)
        const selected = yield* sql<{
          repository_id: string
        }>`SELECT repository_id FROM agent_session WHERE session_id=${id}`
        assert.strictEqual(selected[0]?.repository_id, "12345")
        assert.strictEqual(view.inputs.length, 2)
        assert.strictEqual((view.inputs[0]!.author as { displayName: string }).displayName, "U2")
        assert.include(view.inputs[0]!.text, "Earlier discussion")
        assert.strictEqual(view.inputs[0]!.text.split("Earlier discussion").length, 2)
        assert.strictEqual(view.inputs[1]?.text, "Use team/repo")
        yield* webhook.receive(
          yield* signed({ ...mention, type: "message", channel_type: "group" }, "Ev5"),
        )
        yield* webhook.receive(
          yield* signed(
            {
              ...mention,
              type: "message",
              channel_type: "group",
              subtype: "message_changed",
              text: "edited",
            },
            "Ev6",
          ),
        )
        yield* processor.process(id)
        assert.strictEqual((yield* (yield* AgentSessions).view(id)).inputs.length, 2)
        assert.strictEqual(
          (yield* conversation.inspect("C2", "200.000001")).thread?.context?.length,
          2,
        )
        runner.failures.push({
          method: "admitInput",
          error: new RunnerClientError({
            code: "transport",
            message: "lost admission response",
            status: 503,
          }),
        })
        yield* deliverSession(id).pipe(Effect.flip)
        assert.strictEqual(runner.inputs.get(id)?.length, 1)
        runner.execution.set(id, "working")
        for (const [index, user] of ["U2", "U3"].entries()) {
          yield* webhook.receive(
            yield* signed(
              {
                type: "message",
                channel_type: "group",
                channel: "C2",
                user,
                ts: `200.00000${index + 5}`,
                thread_ts: "200.000001",
                text: "Please add tests too",
              },
              `working-${index}`,
            ),
          )
        }
        yield* processor.process(id)
        yield* deliverSession(id)
        assert.deepEqual(
          runner.inputs.get(id)?.map((input) => input.text),
          (yield* (yield* AgentSessions).view(id)).inputs.map((input) => input.text),
        )
        assert.strictEqual(runner.inputs.get(id)?.length, 4)
        yield* sql`INSERT INTO slack_output (session_id,sequence,kind,text,state) VALUES (${id},999,'response','A send whose response was lost','uncertain')`
        yield* webhook.receive(
          yield* signed(
            {
              type: "message",
              channel_type: "group",
              channel: "C2",
              user: "U2",
              ts: "200.000007",
              thread_ts: "200.000001",
              text: "Also check formatting",
            },
            "held-input",
          ),
        )
        yield* processor.process(id)
        assert.strictEqual((yield* (yield* AgentSessions).view(id)).inputs.length, 4)
        yield* sql`UPDATE slack_output SET state='sent' WHERE session_id=${id} AND sequence=999`
        yield* processor.process(id)
        assert.strictEqual((yield* (yield* AgentSessions).view(id)).inputs.length, 5)
      }),
  )
  it.effect("sends account-link guidance only ephemerally", () =>
    Effect.gen(function* () {
      yield* (yield* SlackWebhook).receive(
        yield* signed(
          {
            type: "message",
            channel_type: "group",
            channel: "CUNRELATED",
            user: "UUNLINKED",
            ts: "800.000001",
            text: "An unrelated conversation",
          },
          "unrelated",
        ),
      )
      yield* (yield* SlackProcessor).processDue
      assert.deepEqual(onboarding, ["U1"])
      yield* (yield* SlackProcessor).processDue
      assert.deepEqual(onboarding, ["U1"])
    }),
  )
  it.effect(
    "preserves a PR home when buffered follow-ups name its repository or source files",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,repository_id,pr_number,state,context) VALUES ('existing-pr-home','T1','CPR','700.000001','700.000001','12345','123','ready','[]')`
        for (const [index, text] of [
          "Use team/repo",
          "Fix src/components in team/repo",
          "Edit src/components",
        ].entries()) {
          const channel = `CPR${index}`
          const webhook = yield* SlackWebhook
          yield* webhook.receive(
            yield* signed(
              {
                type: "app_mention",
                channel,
                user: "U2",
                ts: "701.000001",
                text: "<@UBOT> https://github.com/team/repo/pull/123",
              },
              `pr-mention-${index}`,
            ),
          )
          yield* webhook.receive(
            yield* signed(
              {
                type: "message",
                channel_type: "group",
                channel,
                user: "U3",
                ts: "701.000002",
                thread_ts: "701.000001",
                text,
              },
              `pr-reply-${index}`,
            ),
          )
          const conversation = yield* SlackConversation
          const before = yield* conversation.inspect(channel, "701.000001")
          yield* (yield* SlackProcessor).process(before.thread!.session_id)
          assert.strictEqual(
            (yield* conversation.inspect(channel, "701.000001")).thread!.state,
            "redirected",
          )
        }
      }),
  )
  it.effect(
    "simultaneous teammate starts choose one blog PR home and retain its observation link",
    () =>
      Effect.gen(function* () {
        const webhook = yield* SlackWebhook
        const conversation = yield* SlackConversation
        const processor = yield* SlackProcessor
        const ids: string[] = []
        for (const [index, user] of ["U2", "U3"].entries()) {
          const channel = "CBLOG" + index
          yield* webhook.receive(
            yield* signed(
              {
                type: "app_mention",
                channel,
                user,
                ts: "900.000001",
                text:
                  "<@UBOT> improve https://github.com/team/repo/pull/" +
                  (index === 0 ? "007" : "7"),
              },
              "blog-start-" + index,
            ),
          )
          ids.push((yield* conversation.inspect(channel, "900.000001")).thread!.session_id)
        }
        yield* Effect.all(
          ids.map((id) => processor.process(id)),
          { concurrency: 2 },
        )
        const views = yield* Effect.all([
          conversation.inspect("CBLOG0", "900.000001"),
          conversation.inspect("CBLOG1", "900.000001"),
        ])
        assert.deepEqual(views.map((view) => view.thread!.state).sort(), ["ready", "redirected"])
        const home = views.find((view) => view.thread!.state === "ready")!.thread!
        const redirect = views.find((view) => view.thread!.state === "redirected")!.thread!
        assert.strictEqual(
          (yield* (yield* AgentSessions).view(redirect.session_id).pipe(Effect.flip))._tag,
          "@janitor/cluster/Agent/AgentSessionNotFound",
        )
        const view = yield* (yield* AgentSessions).view(home.session_id)
        assert.strictEqual(view.inputs.length, 1)
        assert.deepEqual(view.pullRequests, [
          { repositoryId: "12345", number: 7, url: "https://github.com/team/repo/pull/7" },
        ])
        yield* webhook.receive(
          yield* signed(
            {
              type: "message",
              channel_type: "group",
              channel: home.channel_id,
              user: "U3",
              ts: "900.000002",
              thread_ts: "900.000001",
              text: "Please improve the examples too",
            },
            "blog-followup",
          ),
        )
        yield* processor.process(home.session_id)
        assert.strictEqual((yield* (yield* AgentSessions).view(home.session_id)).inputs.length, 2)
        runner.push(home.session_id, {
          type: "session.tool.success",
          data: {
            metadata: {
              publication: {
                operationId: "a".repeat(64),
                repositoryId: "12345",
                number: 7,
                url: "https://github.com/team/repo/pull/7",
                title: "Blog examples",
                body: "Improved both examples and checked the links.",
              },
            },
          },
        })
        const delivery = yield* SlackDelivery
        yield* delivery.catchUp(home.session_id)
        yield* delivery.catchUp(home.session_id)
        assert.strictEqual(
          (yield* delivery.inspect(home.session_id)).filter((output) =>
            output.text.includes("Improved both examples"),
          ).length,
          1,
        )
        const other = (yield* conversation.inspect("C2", "200.000001")).thread!
        const beforeMention = (yield* (yield* AgentSessions).view(other.session_id)).inputs.length
        yield* webhook.receive(
          yield* signed(
            {
              type: "message",
              channel_type: "group",
              channel: "C2",
              user: "U2",
              ts: "901.000001",
              thread_ts: "200.000001",
              text: "<@UBOT> improve https://github.com/team/repo/pull/7",
            },
            "blog-other-session",
          ),
        )
        yield* processor.process(other.session_id)
        assert.strictEqual(
          (yield* (yield* AgentSessions).view(other.session_id)).inputs.length,
          beforeMention,
        )
        assert.isTrue(
          (yield* delivery.inspect(other.session_id)).some((output) =>
            output.text.includes(home.channel_id),
          ),
        )
      }),
  )
})
