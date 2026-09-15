import { assert, layer } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { AgentCatchUpWake } from "../../src/Agent/EventProjection.ts"
import { RunnerNotices } from "../../src/Agent/RunnerNotices.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { RunnerEventRoutes } from "../../src/Ingress/RunnerEvents.ts"
import { SlackWake } from "../../src/Slack/Conversation.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"

layer(agentLayers(fakeRunnerLayer(new FakeRunner())))("runner event notices", (it) => {
  it.effect("hurries the thread read and the catch-up and wakes both singletons", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* (yield* AgentSessions).start({ sessionId: "notice", title: "Notice" })
      yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context,publication_due_at)
        VALUES ('notice','T1','C9','700.000000','700.000000','ready','[]',CLOCK_TIMESTAMP()+interval '5 minutes')`
      yield* sql`UPDATE agent_catchup SET due_at=CLOCK_TIMESTAMP()+interval '5 minutes' WHERE session_id='notice'`
      const woke = { slack: 0, catchUp: 0 }
      const notices = yield* RunnerNotices.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(SqlClient.SqlClient, sql),
            Layer.succeed(
              SlackWake,
              Effect.sync(() => {
                woke.slack++
              }),
            ),
            Layer.succeed(
              AgentCatchUpWake,
              Effect.sync(() => {
                woke.catchUp++
              }),
            ),
          ),
        ),
        Layer.build,
        Effect.map((services) => Context.get(services, RunnerNotices)),
        Effect.scoped,
      )
      const context = Context.make(RunnerNotices, notices).pipe(
        Context.add(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ REPOSITORY_SERVICE_TOKEN: "service-token" }),
        ),
      )
      const { handler, dispose } = HttpRouter.toWebHandler(RunnerEventRoutes, {
        disableLogger: true,
      })
      const post = (body: unknown, authorization = "Bearer service-token") =>
        Effect.promise(() =>
          handler(
            new Request("https://janitor.example/agent/events", {
              method: "POST",
              headers: { authorization, "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
            context,
          ),
        )
      assert.strictEqual(
        (yield* post({ sessionId: "notice", generation: 1 }, "Bearer wrong")).status,
        401,
      )
      assert.strictEqual((yield* post({ sessionId: "notice", generation: 1 })).status, 204)
      const [thread] = yield* sql<{
        due: boolean
      }>`SELECT publication_due_at<=CLOCK_TIMESTAMP() AS due FROM slack_thread WHERE session_id='notice'`
      const [catchUp] = yield* sql<{
        due: boolean
      }>`SELECT due_at<=CLOCK_TIMESTAMP() AS due FROM agent_catchup WHERE session_id='notice'`
      assert.isTrue(thread?.due)
      assert.isTrue(catchUp?.due)
      assert.deepStrictEqual(woke, { slack: 1, catchUp: 1 })
      // An unknown session is not an error; the notice simply has nothing to hurry.
      assert.strictEqual((yield* post({ sessionId: "missing", generation: 1 })).status, 204)
      yield* Effect.promise(() => dispose())
    }),
  )
})
