import { resumeRepositorySessions } from "../../src/Slack/ProcessingRequest.ts"
import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentHandoff } from "../../src/Agent/Handoff.ts"
import { RunnerClient } from "../../src/Agent/RunnerClient.ts"
import {
  type RepositoryInferenceRequest,
  type RepositoryInferenceResult,
} from "../../src/Agent/RunnerProtocol.ts"
import { SlackConfig } from "../../src/Slack/Config.ts"
import { SlackConversation } from "../../src/Slack/Conversation.ts"
import { SlackProcessor } from "../../src/Slack/Processor.ts"
import {
  SlackProcessing,
  SlackProcessingLayer,
  SlackProcessingRegistration,
} from "../../src/Slack/Processing.ts"
import { SlackTransport, SlackTransportError } from "../../src/Slack/Transport.ts"
import { SlackWebhook } from "../../src/Slack/Webhook.ts"
import { Teammates, TeammatesConfig } from "../../src/Teammates.ts"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { agentLayers, FakeRunner } from "../Agent/support.ts"

const config = {
  workspaceId: "T",
  appId: "A",
  botUserId: "BOT",
  signingSecret: Redacted.make("secret"),
  token: Redacted.make("token"),
  accountUrl: "https://test/account",
}
const runner = new FakeRunner()
let reads = 0
let channels = 0
let inferenceCalls = 0
let lastInference: RepositoryInferenceRequest | undefined
let inference: RepositoryInferenceResult = {
  kind: "selected",
  repositoryId: "1",
  reason: "The discussion names the Effect library.",
}
let entered: Deferred.Deferred<void> | undefined
let release: Deferred.Deferred<void> | undefined
let throttled = false
const services = Layer.mergeAll(SlackProcessingLayer, SlackWebhook.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(SlackProcessor.layer, SlackConversation.layer)),
  Layer.provideMerge(
    Layer.succeed(SlackTransport, {
      channel: () =>
        Effect.sync(() => {
          channels++
          return { is_private: true, is_member: true }
        }),
      replies: (_channel, root, cursor) =>
        Effect.suspend(() => {
          reads++
          if (throttled)
            return Effect.fail(
              new SlackTransportError({
                message: "Slack rate limited the request",
                disposition: "retry",
                retryAfter: 47,
              }),
            )
          return Effect.succeed({
            messages: [
              { type: "message", ts: root, user: "U", text: "The Effect library needs this fix." },
            ],
            cursor: cursor === "" ? "page-2" : cursor === "page-2" ? "page-3" : "",
          })
        }),
      post: () => Effect.succeed("9.0"),
      update: (_c, ts) => Effect.succeed(ts),
      ephemeral: () => Effect.void,
    }),
  ),
  Layer.provideMerge(
    Teammates.layer.pipe(
      Layer.provide(Layer.succeed(TeammatesConfig, { initialAdmin: Option.none() })),
    ),
  ),
  Layer.provideMerge(
    agentLayers(
      Layer.succeed(RunnerClient, {
        ...runner.client,
        inferRepository: (request) =>
          Effect.gen(function* () {
            inferenceCalls++
            lastInference = request
            if (entered) yield* Deferred.succeed(entered, undefined)
            if (release) yield* Deferred.await(release)
            return inference
          }),
      }),
      [SlackProcessingRegistration],
    ),
  ),
  Layer.provide(Layer.succeed(SlackConfig, config)),
)
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Clock.Clock, Clock.Clock.defaultValue())
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'startup','1','Effect-TS','Organization','all','active','https://github.com/Effect-TS',1) ON CONFLICT DO NOTHING`
  for (const [id, owner, repo] of [
    ["1", "Effect-TS", "effect"],
    ["2", "Effect-TS", "platform"],
    ["3", "other", "effect"],
  ])
    yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence,automation_ready_at) VALUES(${id},'startup',${owner},${repo},true,true,'accessible',1,CLOCK_TIMESTAMP()) ON CONFLICT DO NOTHING`
  const teammates = yield* Teammates
  const member = yield* teammates.admit({ issuer: "test", subject: "startup", email: undefined })
  yield* teammates.link(member.teammate.teammateId, {
    platform: "slack",
    workspaceId: "T",
    accountId: "U",
    displayName: "Teammate",
  })
})
const receive = (channel: string, text: string, existing = false, reply = false) =>
  Effect.gen(function* () {
    const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000))
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T",
      api_app_id: "A",
      event_id: `${channel}-${reply ? "reply" : "start"}`,
      event: {
        type: reply ? "message" : "app_mention",
        channel_type: "group",
        channel,
        user: "U",
        ts: reply ? "100.3" : "100.2",
        ...(existing || reply ? { thread_ts: "100.1" } : {}),
        text,
      },
    })
    const signature = yield* Effect.promise(async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("secret"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      const hash = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`v0:${timestamp}:${body}`),
      )
      return `v0=${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`
    })
    return yield* (yield* SlackWebhook).receive({ body, signature, timestamp })
  })
const settle = (work: {
  readonly payload: unknown
  readonly workflowTag: string
  readonly executionKey: string
}) =>
  Effect.gen(function* () {
    const payload = work.payload as { sessionId: string; revision: string }
    yield* (yield* WorkflowDispatcher).dispatchDue({ only: work, limit: 1 })
    yield* SlackProcessing.execute(payload)
    return payload.sessionId
  })
layer(services, { timeout: "3 minutes" })("Slack immediate startup", (it) => {
  it.effect(
    "signed intake drains three history pages and admits the runner without a scheduler tick",
    () =>
      live(
        Effect.gen(function* () {
          yield* setup
          const before = reads,
            models = inferenceCalls
          const started = yield* Clock.currentTimeMillis
          const result = yield* receive("pages", "<@BOT> fix other/effect", true)
          assert.strictEqual(result.status, 200)
          const id = yield* settle(result.work!)
          yield* AgentHandoff.execute({ sessionId: id, sequence: 1 })
          assert.strictEqual(reads - before, 3)
          assert.strictEqual(inferenceCalls, models)
          assert.strictEqual(
            (
              runner.calls.find((call) => call.sessionId === id && call.method === "createSession")
                ?.detail as { repositoryId: string } | undefined
            )?.repositoryId,
            "3",
          )
          assert.strictEqual(
            runner.inputs.get(id)?.length,
            1,
            JSON.stringify(
              yield* (yield* SqlClient.SqlClient)`SELECT s.runner_state,s.runner_error,t.warning,t.startup_phase FROM slack_thread t LEFT JOIN agent_session s USING(session_id) WHERE t.session_id=${id}`,
            ),
          )
          assert.include(runner.inputs.get(id)![0]!.text, "Earlier thread discussion")
          assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000)
          const channelCount = channels
          yield* (yield* SlackProcessor).processDue
          assert.strictEqual(channels, channelCount, "idle sessions should not read Slack")
        }),
      ),
  )
  it.effect("prefers Effect-TS shorthand and skips model inference", () =>
    live(
      Effect.gen(function* () {
        const before = inferenceCalls
        const result = yield* receive("shorthand", "<@BOT> fix effect")
        const id = yield* settle(result.work!)
        yield* AgentHandoff.execute({ sessionId: id, sequence: 1 })
        assert.strictEqual(
          (
            runner.calls.find((call) => call.sessionId === id && call.method === "createSession")
              ?.detail as { repositoryId: string } | undefined
          )?.repositoryId,
          "1",
        )
        assert.strictEqual(inferenceCalls, before)
      }),
    ),
  )
  it.effect(
    "infers from discussion and does not hold startup on an uncertain acknowledgement",
    () =>
      live(
        Effect.gen(function* () {
          const result = yield* receive("inferred", "<@BOT> please fix the library", true)
          const payload = result.work!.payload as { sessionId: string }
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE slack_output SET state='uncertain' WHERE session_id=${payload.sessionId}`
          const before = inferenceCalls
          const id = yield* settle(result.work!)
          yield* AgentHandoff.execute({ sessionId: id, sequence: 1 })
          assert.strictEqual(inferenceCalls, before + 1)
          assert.strictEqual(lastInference?.preferredOrganization, "Effect-TS")
          assert.include(lastInference!.discussion, "Effect library")
          assert.strictEqual(runner.inputs.get(id)?.length, 1)
          assert.strictEqual(
            (yield* sql`SELECT * FROM slack_output WHERE session_id=${id} AND state='uncertain'`)
              .length,
            1,
          )
        }),
      ),
  )
  it.effect("discards stale inference when a new explicit instruction arrives", () =>
    live(
      Effect.gen(function* () {
        const result = yield* receive("race", "<@BOT> fix the library", true)
        const { sessionId } = result.work!.payload as { sessionId: string }
        entered = yield* Deferred.make<void>()
        release = yield* Deferred.make<void>()
        const processor = yield* SlackProcessor
        const fiber = yield* Effect.forkChild(processor.process(sessionId))
        yield* Deferred.await(entered)
        const independent = yield* receive("independent", "<@BOT> fix other/effect")
        const independentId = yield* settle(independent.work!)
        yield* AgentHandoff.execute({ sessionId: independentId, sequence: 1 })
        assert.strictEqual(
          runner.inputs.get(independentId)?.length,
          1,
          "a slow inference must not block another session",
        )
        yield* receive("race", "Use other/effect", true, true)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)
        entered = undefined
        release = undefined
        const sql = yield* SqlClient.SqlClient
        const [state] = yield* sql<{
          repository_id: string | null
          due: boolean
        }>`SELECT repository_id,due_at<=CLOCK_TIMESTAMP() AS due FROM slack_thread WHERE session_id=${sessionId}`
        assert.isNull(state!.repository_id)
        assert.isTrue(state!.due)
        yield* processor.processDue
        yield* AgentHandoff.execute({ sessionId, sequence: 2 })
        assert.strictEqual(
          (
            runner.calls.find(
              (call) => call.sessionId === sessionId && call.method === "createSession",
            )?.detail as { repositoryId: string } | undefined
          )?.repositoryId,
          "3",
        )
        assert.strictEqual(runner.inputs.get(sessionId)?.length, 2)
      }),
    ),
  )
  it.effect("asks once for genuine ambiguity and rejects IDs outside the inventory", () =>
    live(
      Effect.gen(function* () {
        inference = { kind: "clarification", question: "Should I use effect or platform?" }
        const result = yield* receive("ambiguous", "<@BOT> fix the library")
        const id = yield* settle(result.work!)
        const before = inferenceCalls
        yield* (yield* SlackProcessor).process(id)
        assert.strictEqual(inferenceCalls, before, "same revision should reuse its result")
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual(
          (yield* sql`SELECT * FROM slack_output WHERE session_id=${id} AND kind='question'`)
            .length,
          1,
        )
        inference = { kind: "selected", repositoryId: "999", reason: "unsupported" }
        const invalid = yield* receive("invalid", "<@BOT> fix the library")
        const payload = invalid.work!.payload as { sessionId: string }
        yield* (yield* SlackProcessor).process(payload.sessionId)
        const [state] = yield* sql<{
          repository_id: string | null
          startup_phase: string
        }>`SELECT repository_id,startup_phase FROM slack_thread WHERE session_id=${payload.sessionId}`
        assert.isNull(state!.repository_id)
        assert.strictEqual(state!.startup_phase, "retry")
        // Keep this intentionally failed fixture out of subsequent due sweeps.
        yield* sql`UPDATE slack_thread SET due_at='infinity' WHERE session_id=${payload.sessionId}`
        inference = { kind: "selected", repositoryId: "1", reason: "The library" }
      }),
    ),
  )
  it.effect("honors rate-limit eligibility even when another message arrives", () =>
    live(
      Effect.gen(function* () {
        throttled = true
        const result = yield* receive("limited", "<@BOT> fix other/effect", true)
        const { sessionId } = result.work!.payload as { sessionId: string }
        const processor = yield* SlackProcessor
        yield* processor.process(sessionId)
        const before = reads
        yield* receive("limited", "Please add tests", true, true)
        yield* processor.process(sessionId)
        assert.strictEqual(reads, before)
        const sql = yield* SqlClient.SqlClient
        const [state] = yield* sql<{
          seconds: number
        }>`SELECT EXTRACT(EPOCH FROM retry_not_before-CLOCK_TIMESTAMP())::float8 AS seconds FROM slack_thread WHERE session_id=${sessionId}`
        assert.isAbove(state!.seconds, 45)
        throttled = false
      }),
    ),
  )
  it.effect("resumes a repository wait from its lifecycle event without polling Slack", () =>
    live(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE github_repository SET enabled=false WHERE repository_id='2'`
        const result = yield* receive("paused", "<@BOT> fix Effect-TS/platform")
        const id = yield* settle(result.work!)
        const [waiting] = yield* sql<{
          startup_phase: string
          idle: boolean
        }>`SELECT startup_phase,due_at='infinity'::timestamptz AS idle FROM slack_thread WHERE session_id=${id}`
        assert.strictEqual(waiting!.startup_phase, "repository")
        assert.isTrue(waiting!.idle)
        const before = channels
        yield* (yield* SlackProcessor).processDue
        assert.strictEqual(channels, before)
        yield* sql`UPDATE github_repository SET enabled=true WHERE repository_id='2'`
        yield* sql`UPDATE github_repository SET automation_ready_at=CLOCK_TIMESTAMP() WHERE repository_id='2'`
        yield* resumeRepositorySessions("2")
        const [revision] = yield* sql<{
          input_revision: string
        }>`SELECT input_revision FROM slack_thread WHERE session_id=${id}`
        yield* SlackProcessing.execute({ sessionId: id, revision: revision!.input_revision })
        yield* AgentHandoff.execute({ sessionId: id, sequence: 1 })
        assert.strictEqual(runner.inputs.get(id)?.length, 1)
      }),
    ),
  )
})
