import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackDelivery } from "../../src/Slack/Delivery.ts"
import {
  SlackTransport,
  SlackTransportError,
  type SlackMessage,
} from "../../src/Slack/Transport.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"

const runner = new FakeRunner()
const messages: SlackMessage[] = []
let lost = true
let posts = 0
let wrongAuthor = false
let throttled = false
const updates: string[] = []
const transport: SlackTransport["Service"] = {
  channel: () => Effect.succeed({ is_private: true, is_member: true }),
  replies: () =>
    Effect.succeed({
      messages: wrongAuthor
        ? messages.map((message) => ({ ...message, user: "IMPOSTOR" }))
        : messages,
      cursor: "",
    }),
  post: (_channel, root, text, marker) =>
    Effect.suspend(() => {
      if (throttled) {
        throttled = false
        return Effect.fail(
          new SlackTransportError({ message: "Rate limited", disposition: "retry", retryAfter: 1 }),
        )
      }
      posts++
      const ts = `600.${String(posts).padStart(6, "0")}`
      messages.push({
        ts,
        thread_ts: root,
        user: "UBOT",
        text,
        metadata: { event_type: "janitor_output", event_payload: { marker } },
      })
      if (lost) {
        lost = false
        return Effect.fail(
          new SlackTransportError({
            message: "Lost send response",
            disposition: "uncertain",
            retryAfter: 1,
          }),
        )
      }
      return Effect.succeed(ts)
    }),
  update: (_channel, ts) =>
    Effect.sync(() => {
      updates.push(ts)
      return ts
    }),
  ephemeral: () => Effect.void,
}
const services = SlackDelivery.layer.pipe(
  Layer.provide(Layer.succeed(SlackTransport, transport)),
  Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
  Layer.provide(
    Layer.succeed(SlackConfig, {
      workspaceId: "T1",
      appId: "A1",
      botUserId: "UBOT",
      signingSecret: Redacted.make("secret"),
      token: Redacted.make("token"),
      accountUrl: "https://janitor.test/account",
    }),
  ),
)
const spacing = Effect.sleep(1100).pipe(
  Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
)
layer(services, { timeout: "3 minutes" })("Slack delivery", (it) => {
  it.effect(
    "reconciles a lost send receipt by author, thread and durable marker without reposting",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const sessions = yield* AgentSessions
        yield* sessions.start({ sessionId: "delivery", title: "Delivery" })
        yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context) VALUES ('delivery','T1','C1','600.000000','600.000000','ready','[]')`
        runner.push("delivery", {
          type: "session.text.ended",
          data: { text: "A substantive answer", assistantMessageID: "a1", ordinal: 0 },
        })
        const delivery = yield* SlackDelivery
        yield* delivery.catchUp("delivery")
        yield* delivery.deliver("delivery")
        assert.strictEqual((yield* delivery.inspect("delivery"))[0]?.state, "uncertain")
        yield* spacing
        yield* delivery.deliver("delivery")
        assert.strictEqual((yield* delivery.inspect("delivery"))[0]?.state, "sent")
        assert.strictEqual(posts, 1)
        yield* delivery.catchUp("delivery")
        assert.strictEqual((yield* delivery.inspect("delivery")).length, 1)
      }),
  )
  it.effect("holds an unmatched send and prevents later responses overtaking it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* (yield* AgentSessions).start({ sessionId: "uncertain", title: "Uncertain" })
      yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context) VALUES ('uncertain','T1','C2','601.000000','601.000000','ready','[]')`
      runner.push(
        "uncertain",
        { type: "session.text.ended", data: { text: "First" } },
        { type: "session.text.ended", data: { text: "Second" } },
      )
      const delivery = yield* SlackDelivery
      lost = true
      wrongAuthor = true
      const before = posts
      yield* delivery.catchUp("uncertain")
      yield* delivery.deliver("uncertain")
      yield* spacing
      yield* delivery.deliver("uncertain")
      yield* delivery.deliver("uncertain")
      const outputs = yield* delivery.inspect("uncertain")
      assert.deepEqual(
        outputs.map((output) => output.state),
        ["uncertain", "pending"],
      )
      assert.include(outputs[0]!.error!, "positive author")
      assert.strictEqual(posts - before, 1)
      wrongAuthor = false
    }),
  )
  it.effect(
    "coalesces pending progress without moving completion ahead of substantive replies",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* (yield* AgentSessions).start({ sessionId: "progress", title: "Progress" })
        yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context) VALUES ('progress','T1','C3','602.000000','602.000000','ready','[]')`
        runner.push(
          "progress",
          { type: "session.execution.started", data: {} },
          { type: "session.tool.success", data: {} },
          { type: "session.text.ended", data: { text: "Answer" } },
          { type: "session.execution.succeeded", data: {} },
        )
        const delivery = yield* SlackDelivery
        yield* delivery.catchUp("progress")
        const outputs = yield* delivery.inspect("progress")
        assert.deepEqual(
          outputs.map((output) => output.kind),
          ["progress", "response", "progress"],
        )
        assert.include(outputs[2]!.text, "Finished")
        const before = posts
        yield* delivery.deliver("progress")
        yield* spacing
        yield* delivery.deliver("progress")
        yield* spacing
        yield* delivery.deliver("progress")
        assert.strictEqual(posts - before, 2)
        assert.deepEqual(updates, [(yield* delivery.inspect("progress"))[0]!.message_ts])
      }),
  )
  it.effect(
    "retains throttled output, spaces channel sends and splits Unicode without data loss",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* (yield* AgentSessions).start({ sessionId: "unicode", title: "Unicode" })
        yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context) VALUES ('unicode','T1','C4','603.000000','603.000000','ready','[]')`
        const text = "😀".repeat(1500)
        runner.push("unicode", { type: "session.text.ended", data: { text } })
        const delivery = yield* SlackDelivery
        yield* delivery.catchUp("unicode")
        const outputs = yield* delivery.inspect("unicode")
        assert.strictEqual(outputs.length, 2)
        assert.strictEqual(outputs.map((output) => output.text).join(""), text)
        assert.isTrue(
          outputs.every((output) => new TextEncoder().encode(output.text).length <= 3900),
        )
        throttled = true
        yield* delivery.deliver("unicode")
        yield* delivery.deliver("unicode")
        assert.strictEqual((yield* delivery.inspect("unicode"))[0]?.state, "pending")
        yield* spacing
        yield* delivery.deliver("unicode")
        assert.strictEqual((yield* delivery.inspect("unicode"))[0]?.state, "sent")
      }),
  )
})
