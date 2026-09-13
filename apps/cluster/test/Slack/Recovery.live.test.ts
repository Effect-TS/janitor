// Opt-in acceptance check. A participant removes and reinvites the bot between phases.
import { it, expect } from "vite-plus/test"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { parseEnv } from "node:util"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { SlackDelivery } from "../../src/Slack/Delivery.ts"
import { SlackTransport } from "../../src/Slack/Transport.ts"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"

it.skipIf(process.env.JANITOR_RUN_SLACK_RECOVERY_FIXTURE !== "1")(
  "retains production outbox replies through actual private-channel removal and reinvite",
  async () => {
    const env = parseEnv(readFileSync(process.env.JANITOR_SLACK_FIXTURE_ENV!, "utf8"))
    const reportPath = process.env.JANITOR_SLACK_FIXTURE_REPORT!
    const controlPath = process.env.JANITOR_SLACK_FIXTURE_CONTROL!
    if (!reportPath || !controlPath || env.SLACK_CHANNEL_NAME !== "janitor-test")
      throw new Error("Select the private janitor-test fixture and report/control paths")
    const channel = env.SLACK_CHANNEL_ID!
    const token = env.SLACK_BOT_TOKEN!
    const created: string[] = []
    const report: {
      phase: string
      root?: string
      outputIds?: string[]
      removalWarning?: string | null
      delivered?: boolean
      cleanup?: string[]
    } = { phase: "starting" }
    const save = () =>
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
    const call = async (method: string, parameters: Record<string, unknown>) => {
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(10000),
      })
      const body = await response.json()
      if (!response.ok || !body.ok)
        throw new Error(`Slack ${method}: ${body.error ?? response.status}`)
      return body
    }
    const auth = await call("auth.test", {})
    const info = await call("conversations.info", { channel })
    expect(info.channel.is_private).toBe(true)
    expect(info.channel.is_member).toBe(true)
    expect(info.channel.name).toBe("janitor-test")
    const runner = new FakeRunner()
    const services = SlackDelivery.layer.pipe(
      Layer.provideMerge(SlackTransport.layer),
      Layer.provide(
        Layer.succeed(SlackConfig, {
          workspaceId: auth.team_id,
          appId: env.SLACK_APP_ID!,
          botUserId: auth.user_id,
          token: Redacted.make(token),
          signingSecret: Redacted.make(env.SLACK_SIGNING_SECRET!),
          accountUrl: "https://janitor.test/account",
        }),
      ),
      Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
    )
    const waitFor = (phase: string) =>
      Effect.gen(function* () {
        report.phase = phase
        yield* Effect.sync(save)
        while (
          !(yield* Effect.sync(
            () => existsSync(controlPath) && readFileSync(controlPath, "utf8").trim() === phase,
          ))
        )
          yield* Effect.sleep("1 second")
      })
    save()
    try {
      report.phase = "creating-root"
      save()
      const root = await call("chat.postMessage", {
        channel,
        text: "Janitor recovery acceptance check. This disposable thread tests retained replies after bot removal and reinvite.",
        unfurl_links: false,
        unfurl_media: false,
      })
      created.push(root.ts)
      report.root = root.ts
      save()
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sessions = yield* AgentSessions
          const delivery = yield* SlackDelivery
          const transport = yield* SlackTransport
          yield* sessions.start({
            sessionId: "live-recovery",
            title: "Private channel recovery acceptance",
          })
          yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context) VALUES ('live-recovery',${auth.team_id},${channel},${root.ts},${root.ts},'ready','[]')`
          runner.push(
            "live-recovery",
            { type: "session.text.ended", data: { text: "Retained substantive reply." } },
            {
              type: "session.tool.failed",
              data: { error: { message: "Retained synthetic error reply." } },
            },
          )
          yield* delivery.catchUp("live-recovery")
          const original = yield* delivery.inspect("live-recovery")
          report.outputIds = original.map((output) => output.output_id)
          yield* waitFor("removed")
          yield* delivery.deliver("live-recovery")
          const blocked = yield* delivery.inspect("live-recovery")
          expect(blocked.map((output) => output.state)).toEqual(["pending", "pending"])
          report.removalWarning = (yield* sessions.view("live-recovery")).deliveryWarning
          expect(["not_in_channel", "channel_not_found"]).toContain(report.removalWarning)
          yield* waitFor("reinvited")
          const membership = yield* transport.channel(channel)
          expect(membership.is_member).toBe(true)
          // Advance only the fixture database's denial backoff. Production keeps its persisted deadline.
          yield* sql`UPDATE slack_channel_delivery SET due_at=CLOCK_TIMESTAMP()-interval '1 second' WHERE channel_id=${channel}`
          yield* delivery.deliver("live-recovery")
          yield* Effect.sleep("1100 millis")
          yield* delivery.deliver("live-recovery")
          const delivered = yield* delivery.inspect("live-recovery")
          for (const output of delivered) if (output.message_ts) created.push(output.message_ts)
          expect(delivered.map((output) => output.output_id)).toEqual(report.outputIds)
          expect(delivered.map((output) => output.state)).toEqual(["sent", "sent"])
          let cursor = ""
          const markers = new Set<string>()
          do {
            const page = yield* transport.replies(channel, root.ts, cursor)
            for (const message of page.messages)
              if (
                message.user === auth.user_id &&
                message.thread_ts === root.ts &&
                message.metadata?.event_type === "janitor_output"
              )
                markers.add(String(message.metadata.event_payload.marker))
            cursor = page.cursor
          } while (cursor !== "")
          for (const id of report.outputIds!) expect(markers.has(id)).toBe(true)
          expect((yield* sessions.view("live-recovery")).deliveryWarning).toBeNull()
          report.delivered = true
          report.phase = "passed"
          yield* Effect.sync(save)
        }).pipe(Effect.provide(services)),
      )
    } finally {
      report.cleanup = []
      for (const ts of created.reverse()) {
        try {
          await call("chat.delete", { channel, ts })
          report.cleanup.push(`deleted ${ts}`)
        } catch {
          report.cleanup.push(`cleanup pending ${ts}`)
        }
      }
      save()
    }
  },
  20 * 60 * 1000,
)
