import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackInteractivity } from "../../src/Slack/Interactivity.ts"
import { SlackTransport } from "../../src/Slack/Transport.ts"
import { Teammates, TeammatesConfig } from "../../src/Teammates.ts"
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
const ephemerals: string[] = []
const updates: Array<{ ts: string; text: string }> = []
const slack: SlackTransport["Service"] = {
  channel: () => Effect.succeed({ is_private: true, is_member: true }),
  replies: () => Effect.succeed({ messages: [], cursor: "" }),
  post: () => Effect.succeed("500.000001"),
  update: (_channel, ts, text) =>
    Effect.sync(() => {
      updates.push({ ts, text })
      return ts
    }),
  ephemeral: (_channel, _user, _root, text) =>
    Effect.sync(() => {
      ephemerals.push(text)
    }),
}
const services = SlackInteractivity.layer.pipe(
  Layer.provideMerge(Layer.succeed(SlackTransport, slack)),
  Layer.provideMerge(
    Teammates.layer.pipe(
      Layer.provide(Layer.succeed(TeammatesConfig, { initialAdmin: Option.none() })),
    ),
  ),
  Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
  Layer.provide(Layer.succeed(SlackConfig, config)),
)

const click = (user: string, action: "retry" | "skip", value: unknown, actionTs: string) =>
  Effect.gen(function* () {
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      api_app_id: "A1",
      user: { id: user },
      channel: { id: "C1" },
      message: { ts: "700.000002", thread_ts: "700.000001" },
      actions: [
        { action_id: `janitor_turn_${action}`, action_ts: actionTs, value: JSON.stringify(value) },
      ],
    }
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`
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

layer(services, { timeout: "3 minutes" })("Slack interactivity", (it) => {
  it.effect(
    "forwards an authorized teammate's Retry once and refuses stale or unauthorized clicks",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const interactivity = yield* SlackInteractivity
        const teammates = yield* Teammates
        const member = yield* teammates.admit({ issuer: "test", subject: "ada", email: undefined })
        yield* teammates.link(member.teammate.teammateId, {
          platform: "slack",
          workspaceId: "T1",
          accountId: "U1",
          displayName: "Ada",
        })
        const admitted = member.teammate
        yield* (yield* AgentSessions).start({ sessionId: "act", title: "Act" })
        yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context) VALUES ('act','T1','C1','700.000001','700.000001','ready','[]')`
        runner.sessions.set("act", { generation: 1, nativeSessionId: "ses_act" })
        runner.awaiting.set("act", { inputId: "msg_1", attempt: 1 })
        const value = { sessionId: "act", generation: 1, inputId: "msg_1", attempt: 1 }

        const forged = yield* click("U1", "retry", value, "1.1")
        assert.strictEqual(
          (yield* interactivity.receive({ ...forged, signature: `v0=${"0".repeat(64)}` })).status,
          401,
        )
        // An unlinked Slack account is told, and nothing reaches the runner.
        assert.strictEqual(
          (yield* interactivity.receive(yield* click("U9", "retry", value, "1.2"))).status,
          200,
        )
        assert.strictEqual(runner.actions.length, 0)
        assert.match(ephemerals.at(-1) ?? "", /authorized teammates/)

        assert.strictEqual(
          (yield* interactivity.receive(yield* click("U1", "retry", value, "1.3"))).status,
          200,
        )
        assert.strictEqual(runner.actions.length, 1)
        const forwarded = runner.actions[0]!.request
        assert.strictEqual(forwarded.action, "retry")
        assert.strictEqual(forwarded.actionId, "slack:U1:1.3")
        assert.strictEqual(forwarded.actor.teammateId, admitted.teammateId)
        // Buttons are removed from the message once the decision applied.
        assert.deepStrictEqual(updates.at(-1), {
          ts: "700.000002",
          text: "Ada retried this request.",
        })

        // The same button after the decision is stale: reported, never re-applied.
        assert.strictEqual(
          (yield* interactivity.receive(yield* click("U1", "skip", value, "1.4"))).status,
          200,
        )
        assert.strictEqual(runner.actions.length, 2)
        assert.match(ephemerals.at(-1) ?? "", /nothing awaiting/)
      }),
  )
})
