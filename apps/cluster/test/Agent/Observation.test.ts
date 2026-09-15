import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentEventProjection } from "../../src/Agent/EventProjection.ts"
import { SessionObservation } from "../../src/Agent/Observation.ts"
import { RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "./support.ts"

const runner = new FakeRunner()

const usage = (input: number, seq: number) => ({
  input,
  output: 3,
  reasoning: 2,
  cacheRead: 5,
  cacheWrite: 7,
  seq,
})

const Services = SessionObservation.layer.pipe(
  Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
)

layer(Services, { timeout: "3 minutes" })("Session observation", (it) => {
  it.effect("lists working sessions first, then meaningful activity, with stable pages", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const projection = yield* AgentEventProjection
      const observation = yield* SessionObservation
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO github_installation (installation_id, account_database_id, account_handle, account_type, repository_selection, status, html_url, projected_sequence, access_error) VALUES ('1', '1', 'acme', 'Organization', 'all', 'active', 'https://github.com/acme', 1, NULL) ON CONFLICT DO NOTHING`
      // A ready repository: sessions on a fenced repository read as blocked instead.
      yield* sql`INSERT INTO github_repository (repository_id, installation_id, owner, repo, access, enabled, projected_sequence, automation_ready_at) VALUES ('901', '1', 'acme', 'widgets', 'accessible', TRUE, 0, CLOCK_TIMESTAMP()) ON CONFLICT DO NOTHING`
      for (const id of ["o-idle-old", "o-idle-new", "o-working", "o-failed"]) {
        yield* sessions.start({ sessionId: id, title: `Session ${id}`, repositoryId: "901" })
        runner.sessions.set(id, { generation: 1, nativeSessionId: `ses_${id}` })
      }
      runner.push(
        "o-idle-old",
        { type: "turn.started", data: { inputId: "msg_old", attempt: 1 } },
        { type: "turn.completed", data: { inputId: "msg_old", attempt: 1, text: "done" } },
      )
      runner.push(
        "o-idle-new",
        { type: "turn.started", data: { inputId: "msg_new", attempt: 1 } },
        { type: "turn.completed", data: { inputId: "msg_new", attempt: 1, text: "done" } },
      )
      runner.push("o-working", { type: "turn.started", data: { inputId: "msg_w", attempt: 1 } })
      runner.push(
        "o-failed",
        { type: "turn.started", data: { inputId: "msg_f", attempt: 1 } },
        { type: "turn.interrupted", data: { inputId: "msg_f", attempt: 1, reason: "boom" } },
      )
      for (const id of ["o-idle-old", "o-idle-new", "o-working", "o-failed"])
        yield* projection.catchUp(id)
      // Activity comes from event time; make the order explicit.
      yield* sql`UPDATE agent_session_projection SET activity_at = to_timestamp(100) WHERE session_id = 'o-idle-old'`
      yield* sql`UPDATE agent_session_projection SET activity_at = to_timestamp(300) WHERE session_id = 'o-idle-new'`
      yield* sql`UPDATE agent_session_projection SET activity_at = to_timestamp(50) WHERE session_id = 'o-working'`
      yield* sql`UPDATE agent_session_projection SET activity_at = to_timestamp(200) WHERE session_id = 'o-failed'`

      const first = yield* observation.list({ cursor: null, limit: 2 })
      assert.deepStrictEqual(
        first.sessions.map((session) => session.sessionId),
        ["o-working", "o-idle-new"],
      )
      assert.isNotNull(first.cursor)
      const working = first.sessions[0]!
      assert.strictEqual(working.execution, "working")
      assert.deepStrictEqual(working.repository, {
        repositoryId: "901",
        owner: "acme",
        repo: "widgets",
      })
      assert.isNull(working.homeThread)
      assert.deepStrictEqual(working.pullRequests, [])

      // A usage-only change and a heartbeat read arrive between pages: the page stays stable.
      runner.usage.set("o-idle-new", usage(11, 1))
      yield* projection.catchUp("o-idle-new")
      const second = yield* observation.list({ cursor: first.cursor, limit: 2 })
      assert.deepStrictEqual(
        second.sessions.map((session) => session.sessionId),
        ["o-failed", "o-idle-old"],
      )
      assert.isNull(second.cursor)
      const failed = second.sessions[0]!
      assert.strictEqual(failed.execution, "failed")
      assert.strictEqual(failed.reason, "Waiting for Retry or Skip: interrupted (boom)")
      const refreshed = yield* observation.list({ cursor: null, limit: 10 })
      assert.deepStrictEqual(
        refreshed.sessions.map((session) => session.sessionId),
        ["o-working", "o-idle-new", "o-failed", "o-idle-old"],
      )
    }),
  )

  it.effect("shows recorded usage as grouped totals and distinguishes unavailable from zero", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const projection = yield* AgentEventProjection
      const observation = yield* SessionObservation
      yield* sessions.start({ sessionId: "o-usage", title: "Usage" })
      runner.sessions.set("o-usage", { generation: 1, nativeSessionId: "ses_u" })
      runner.push("o-usage", { type: "session.execution.started", data: {} })
      yield* projection.catchUp("o-usage")
      let detail = yield* observation.detail("o-usage")
      assert.isNull(detail.usage)

      runner.usage.set("o-usage", usage(0, 1))
      yield* projection.catchUp("o-usage")
      detail = yield* observation.detail("o-usage")
      // A normalized zero is a recorded total, not an absence.
      assert.deepStrictEqual(detail.usage, { input: 12, output: 5 })

      // An older cumulative snapshot never wins over a newer one.
      runner.usage.set("o-usage", usage(999, 0))
      yield* projection.catchUp("o-usage")
      detail = yield* observation.detail("o-usage")
      assert.strictEqual(detail.usage?.input, 12)
    }),
  )

  it.effect("keeps execution state, delivery health and freshness independent", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const projection = yield* AgentEventProjection
      const observation = yield* SessionObservation
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO github_installation (installation_id, account_database_id, account_handle, account_type, repository_selection, status, html_url, projected_sequence, access_error) VALUES ('1', '1', 'acme', 'Organization', 'all', 'active', 'https://github.com/acme', 1, NULL) ON CONFLICT DO NOTHING`
      // A ready repository: sessions on a fenced repository read as blocked instead.
      yield* sql`INSERT INTO github_repository (repository_id, installation_id, owner, repo, access, enabled, projected_sequence, automation_ready_at) VALUES ('902', '1', 'acme', 'gadgets', 'accessible', TRUE, 0, CLOCK_TIMESTAMP()) ON CONFLICT DO NOTHING`
      yield* sessions.start({ sessionId: "o-delivery", title: "Delivery", repositoryId: "902" })
      runner.sessions.set("o-delivery", { generation: 1, nativeSessionId: "ses_d" })
      yield* sql`INSERT INTO slack_thread (session_id, workspace_id, channel_id, thread_ts, boundary_ts, repository_id, pr_number, state)
        VALUES ('o-delivery', 'T1', 'C1', '1700000000.000100', '1700000000.000100', '902', '17', 'ready')`
      yield* sql`INSERT INTO slack_output (session_id, sequence, kind, text, state, error)
        VALUES ('o-delivery', 1, 'response', 'done', 'pending', 'not_in_channel')`
      yield* sql`UPDATE slack_thread SET delivery_warning = 'Janitor is no longer in the channel' WHERE session_id = 'o-delivery'`
      runner.push(
        "o-delivery",
        { type: "session.execution.started", data: {} },
        { type: "session.execution.succeeded", data: {} },
      )
      yield* projection.catchUp("o-delivery")
      let detail = yield* observation.detail("o-delivery")
      assert.strictEqual(detail.execution, "idle")
      assert.strictEqual(detail.deliveryWarning, "Janitor is no longer in the channel")
      assert.deepStrictEqual(detail.homeThread, {
        platform: "slack",
        url: "https://app.slack.com/archives/C1/p1700000000000100",
      })
      assert.deepStrictEqual(detail.pullRequests, [
        { number: 17, url: "https://github.com/acme/gadgets/pull/17" },
      ])
      assert.deepStrictEqual(detail.pendingDelivery, [
        { platform: "slack", state: "pending", error: "not_in_channel" },
      ])
      assert.isNotNull(detail.freshness.readAt)
      assert.isNull(detail.freshness.error)

      // A failed read keeps the last known state and reports the read failure.
      runner.failures.push({
        method: "readEvents",
        error: new RunnerClientError({ code: "transport", message: "runner unreachable" }),
      })
      yield* projection.catchUp("o-delivery")
      detail = yield* observation.detail("o-delivery")
      assert.strictEqual(detail.execution, "idle")
      assert.strictEqual(detail.freshness.error, "runner unreachable")

      // A runner refusal is blocked with its reason; the next successful read releases it.
      runner.failures.push({
        method: "readEvents",
        error: new RunnerClientError({
          code: "blocked",
          message: "held",
          reason: "model configuration missing",
        }),
      })
      yield* projection.catchUp("o-delivery")
      detail = yield* observation.detail("o-delivery")
      assert.strictEqual(detail.execution, "blocked")
      assert.strictEqual(detail.reason, "model configuration missing")
      yield* projection.catchUp("o-delivery")
      detail = yield* observation.detail("o-delivery")
      assert.strictEqual(detail.execution, "idle")
    }),
  )

  it.effect("returns to idle after a turn, and a new input supersedes a historical failure", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const projection = yield* AgentEventProjection
      const observation = yield* SessionObservation
      yield* sessions.start({ sessionId: "o-history", title: "History" })
      runner.sessions.set("o-history", { generation: 1, nativeSessionId: "ses_h" })
      runner.push(
        "o-history",
        { type: "turn.started", data: { inputId: "msg_h1", attempt: 1 } },
        {
          type: "turn.interrupted",
          data: { inputId: "msg_h1", attempt: 1, reason: "provider down" },
        },
      )
      yield* projection.catchUp("o-history")
      let detail = yield* observation.detail("o-history")
      assert.strictEqual(detail.execution, "failed")
      assert.strictEqual(
        detail.latestError,
        "Waiting for Retry or Skip: interrupted (provider down)",
      )
      const before = detail.activityAt

      // An interruption waits for a teammate's decision: a later input queues behind it.
      const accepted = yield* sessions.accept({
        sessionId: "o-history",
        contributionKey: "retry-1",
        source: "slack",
        author: { displayName: "Ada" },
        text: "try again",
      })
      detail = yield* observation.detail("o-history")
      assert.strictEqual(detail.execution, "working")
      assert.strictEqual(detail.pendingInputs, 1)
      assert.isTrue(detail.activityAt.epochMilliseconds > before.epochMilliseconds)
      assert.isNotNull(detail.lastInputAt)

      runner.push(
        "o-history",
        { type: "turn.accepted", data: { inputId: accepted.runner_message_id } },
        { type: "turn.skipped", data: { inputId: "msg_h1", attempt: 1 } },
        { type: "turn.started", data: { inputId: accepted.runner_message_id, attempt: 1 } },
        {
          type: "turn.completed",
          data: { inputId: accepted.runner_message_id, attempt: 1, text: "ok" },
        },
      )
      yield* projection.catchUp("o-history")
      detail = yield* observation.detail("o-history")
      assert.strictEqual(detail.execution, "idle")
      assert.isNull(detail.latestError)
    }),
  )

  it.effect("lists a thread awaiting repository selection and hides disconnected sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const observation = yield* SessionObservation
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO slack_thread (session_id, workspace_id, channel_id, thread_ts, boundary_ts, state, warning)
        VALUES ('o-pending', 'T1', 'C2', '1700000500.000200', '1700000500.000200', 'initializing', 'Which repository should I use?')`
      yield* sessions.start({ sessionId: "o-gone", title: "Gone" })
      yield* sql`UPDATE agent_session SET runner_state = 'disconnected' WHERE session_id = 'o-gone'`
      const page = yield* observation.list({ cursor: null, limit: 50 })
      const ids = page.sessions.map((session) => session.sessionId)
      assert.include(ids, "o-pending")
      assert.notInclude(ids, "o-gone")
      const pending = page.sessions.find((session) => session.sessionId === "o-pending")!
      assert.strictEqual(pending.execution, "blocked")
      assert.strictEqual(pending.reason, "Which repository should I use?")
      assert.isNull(pending.repository)
      assert.isNull(pending.usage)
      assert.strictEqual(
        pending.homeThread?.url,
        "https://app.slack.com/archives/C2/p1700000500000200",
      )
      const missing = yield* observation.detail("o-gone").pipe(Effect.flip)
      assert.strictEqual(missing._tag, "@janitor/cluster/Agent/AgentSessionNotFound")
    }),
  )

  it.effect("commits invalidation intent with projection and delivery changes", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const projection = yield* AgentEventProjection
      const sql = yield* SqlClient.SqlClient
      const pending = () =>
        sql<{
          topic: string
        }>`SELECT topic FROM live_notification WHERE repository_id = 'sessions' ORDER BY topic`
      yield* sql`DELETE FROM live_notification WHERE repository_id = 'sessions'`
      yield* sessions.start({ sessionId: "o-live", title: "Live" })
      assert.deepStrictEqual(yield* pending(), [{ topic: "sessions" }])
      yield* sql`DELETE FROM live_notification WHERE repository_id = 'sessions'`

      // A rolled-back projection leaves no intent behind.
      runner.sessions.set("o-live", { generation: 1, nativeSessionId: "ses_l" })
      runner.push("o-live", { type: "session.execution.started", data: {} })
      const page = yield* runner.client.readEvents("o-live", 0)
      yield* sql
        .withTransaction(
          projection
            .applyPage("o-live", page)
            .pipe(Effect.andThen(Effect.fail(new Error("crash")))),
        )
        .pipe(Effect.ignore)
      assert.deepStrictEqual(yield* pending(), [])
      yield* projection.catchUp("o-live")
      assert.deepStrictEqual(yield* pending(), [{ topic: "sessions" }])
      yield* sql`DELETE FROM live_notification WHERE repository_id = 'sessions'`

      // Lease bookkeeping on the thread is not a change worth telling anyone about.
      yield* sql`INSERT INTO slack_thread (session_id, workspace_id, channel_id, thread_ts, boundary_ts, state)
        VALUES ('o-live', 'T1', 'C3', '1700000900.000300', '1700000900.000300', 'ready')`
      yield* sql`DELETE FROM live_notification WHERE repository_id = 'sessions'`
      yield* sql`UPDATE slack_thread SET lease_token = 'x', due_at = CLOCK_TIMESTAMP() WHERE session_id = 'o-live'`
      assert.deepStrictEqual(yield* pending(), [])
      yield* sql`UPDATE slack_thread SET delivery_warning = 'pending reply' WHERE session_id = 'o-live'`
      assert.deepStrictEqual(yield* pending(), [{ topic: "sessions" }])

      // Feedback hydration is visible, so it invalidates.
      yield* sql`DELETE FROM live_notification WHERE repository_id = 'sessions'`
      yield* sql`INSERT INTO github_feedback (session_id, contribution_key, review_id, reviewer_id, author, authorized)
        VALUES ('o-live', 'review:9', '9', '77', '{}', true)`
      assert.deepStrictEqual(yield* pending(), [{ topic: "sessions" }])
      yield* sql`DELETE FROM live_notification WHERE repository_id = 'sessions'`
      // Hydration rewrites its columns with every page; unchanged values stay silent.
      yield* sql`UPDATE github_feedback SET warning = NULL, cursor = 'comments-2' WHERE session_id = 'o-live' AND contribution_key = 'review:9'`
      assert.deepStrictEqual(yield* pending(), [])

      // Removal reaches open subscriptions through the same channel.
      yield* sql`DELETE FROM live_notification WHERE repository_id = 'sessions'`
      yield* sql`INSERT INTO teammate (issuer, subject, role) VALUES ('iss', 'removed-one', 'member')`
      yield* sql`UPDATE teammate SET status = 'removed' WHERE subject = 'removed-one'`
      assert.deepStrictEqual(yield* pending(), [{ topic: "membership" }])
    }),
  )
})
