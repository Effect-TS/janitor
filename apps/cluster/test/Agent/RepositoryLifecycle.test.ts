// Repository pause, access loss, disconnection and reconnection as seen by
// agent sessions: fences with concrete reasons, retained work, and durable
// cleanup of remote state once a repository is explicitly disconnected.
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentCleanup } from "../../src/Agent/Cleanup.ts"
import { AgentEventProjection } from "../../src/Agent/EventProjection.ts"
import { deliverSession } from "../../src/Agent/Handoff.ts"
import { SessionObservation } from "../../src/Agent/Observation.ts"
import { RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { GitHubTransport } from "../../src/GitHub/Transport.ts"
import { GitHubWebhookJournal } from "../../src/GitHub/WebhookJournal.ts"
import { RepositoryConnections } from "../../src/RepositoryConnections.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { Teammates, TeammatesConfig } from "../../src/Teammates.ts"
import { TestPayloadCipher } from "../support/PayloadCipher.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "./support.ts"

const runner = new FakeRunner()
const actor = { issuer: "test", subject: "operator" }
const installation = {
  id: 77,
  account: { id: 1, login: "test", type: "Organization" },
  repository_selection: "selected",
  html_url: "https://github.com/settings/installations/77",
  suspended_at: null,
  permissions: { metadata: "read", issues: "write", pull_requests: "read", checks: "read" },
}
const repositories: Record<string, number> = { one: 9301, pause: 9302 }
const transport = Layer.succeed(
  GitHubTransport,
  GitHubTransport.of({
    request: (request) =>
      Effect.succeed({
        _tag: "Ok",
        status: 200,
        body: request.url.startsWith("/app/installations/")
          ? installation
          : { id: repositories[request.url.split("/").at(-1) ?? ""] ?? 0 },
        etag: Option.none(),
        link: Option.none(),
        requestId: Option.none(),
      }),
  }),
)
const Services = Layer.mergeAll(
  RepositoryConnections.layer,
  SessionObservation.layer,
  AgentCleanup.layer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SyncTargets.layer,
      GitHubReadModel.layer,
      GitHubWebhookJournal.layer,
      TestPayloadCipher,
      Teammates.layer.pipe(
        Layer.provide(
          Layer.succeed(TeammatesConfig, {
            initialAdmin: Option.some({ issuer: "test", subject: "founder" }),
          }),
        ),
      ),
    ),
  ),
  Layer.provide(transport),
  Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
)

const connectRepository = (id: string, repo: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1) ON CONFLICT DO NOTHING`
    yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence,automation_ready_at) VALUES(${id},'77','test',${repo},TRUE,TRUE,'accessible',1,CLOCK_TIMESTAMP())`
  })

const cleanupCalls = () => runner.calls.filter((call) => call.method === "cleanup")

layer(Services, { timeout: "3 minutes" })("Repository access lifecycle", (it) => {
  it.effect(
    "disconnection ends sessions, deletes their data and cleans up the runner even after a crash",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const connections = yield* RepositoryConnections
        const sessions = yield* AgentSessions
        const observation = yield* SessionObservation
        const projection = yield* AgentEventProjection
        const cleanup = yield* AgentCleanup
        yield* connectRepository("9301", "one")
        for (const id of ["l-one", "l-two"]) {
          yield* sessions.start({ sessionId: id, title: id, repositoryId: "9301" })
          assert.strictEqual(yield* deliverSession(id), "settled")
        }
        const accepted = yield* sessions.accept({
          sessionId: "l-one",
          contributionKey: "slack:1",
          source: "slack",
          author: { displayName: "Ada" },
          text: "Run the tests and publish",
        })
        // A command attempt is in flight: its handoff was sent and no receipt is held.
        yield* sql`UPDATE agent_input SET handoff_state = 'uncertain' WHERE input_id = ${accepted.input_id}`
        yield* sql`INSERT INTO slack_thread (session_id, workspace_id, channel_id, thread_ts, boundary_ts, repository_id, pr_number, state)
          VALUES ('l-one', 'T1', 'C1', '1700000000.000100', '1700000000.000100', '9301', '5', 'ready')`
        yield* sql`INSERT INTO slack_output (session_id, sequence, kind, text, state) VALUES ('l-one', 1, 'progress', 'Working…', 'pending')`
        yield* sql`INSERT INTO github_feedback (session_id, contribution_key, review_id, reviewer_id, author, authorized)
          VALUES ('l-one', 'review:1', '1', '77', '{}', true)`
        runner.push("l-one", { type: "session.execution.started", data: {} })
        yield* projection.catchUp("l-one")
        assert.strictEqual((yield* observation.detail("l-one")).execution, "working")
        const inventory = (yield* connections.inventory).repositories.find(
          (row) => row.repositoryId === "9301",
        )!
        assert.strictEqual(inventory.sessionCount, 2)
        assert.strictEqual(inventory.pendingCleanups, 0)

        // The runner is unreachable while the disconnect request runs.
        runner.failures.push({
          method: "cleanup",
          error: new RunnerClientError({ code: "transport", message: "runner unreachable" }),
        })
        const callsBefore = cleanupCalls().length
        yield* connections.change("9301", "disconnect", actor)
        assert.strictEqual(cleanupCalls().length, callsBefore)
        for (const table of [
          "agent_session",
          "agent_input",
          "agent_session_projection",
          "agent_catchup",
          "slack_thread",
          "slack_output",
          "github_feedback",
        ])
          assert.deepStrictEqual(
            yield* sql`SELECT 1 FROM ${sql(table)} WHERE session_id IN ('l-one', 'l-two')`,
            [],
            table,
          )
        assert.deepStrictEqual(
          yield* sql`SELECT 1 FROM workflow_outbox WHERE payload->>'sessionId' IN ('l-one', 'l-two')`,
          [],
        )
        const tombstones = yield* sql<{
          session_id: string
          generation: number
          native_session_id: string | null
        }>`SELECT session_id, generation::int AS generation, native_session_id FROM agent_session_cleanup ORDER BY session_id`
        assert.deepStrictEqual(tombstones, [
          { session_id: "l-one", generation: 1, native_session_id: "ses_l-one" },
          { session_id: "l-two", generation: 1, native_session_id: "ses_l-two" },
        ])
        const after = (yield* connections.inventory).repositories.find(
          (row) => row.repositoryId === "9301",
        )!
        assert.strictEqual(after.sessionCount, 0)
        assert.strictEqual(after.pendingCleanups, 2)

        // Ended sessions are gone from observation and refuse new work; stale
        // work does not revive them.
        const page = yield* observation.list({ cursor: null, limit: 50 })
        assert.notInclude(
          page.sessions.map((session) => session.sessionId),
          "l-one",
        )
        assert.strictEqual(
          (yield* observation.detail("l-one").pipe(Effect.flip))._tag,
          "@janitor/cluster/Agent/AgentSessionNotFound",
        )
        assert.strictEqual(
          (yield* sessions
            .accept({
              sessionId: "l-one",
              contributionKey: "slack:2",
              source: "slack",
              author: {},
              text: "late",
            })
            .pipe(Effect.flip))._tag,
          "@janitor/cluster/Agent/AgentSessionNotFound",
        )
        const admissions = runner.calls.filter((call) => call.method === "admitInput").length
        assert.strictEqual(yield* deliverSession("l-one"), "settled")
        assert.strictEqual(
          runner.calls.filter((call) => call.method === "admitInput").length,
          admissions,
        )
        runner.push("l-one", { type: "session.execution.succeeded", data: {} })
        yield* projection.catchUp("l-one")
        assert.deepStrictEqual(
          yield* sql`SELECT 1 FROM agent_session_projection WHERE session_id = 'l-one'`,
          [],
        )
        assert.include(
          (yield* sessions
            .start({ sessionId: "l-one", title: "revived", repositoryId: "9301" })
            .pipe(Effect.flip)).message,
          "ended",
        )

        // Cleanup retries past the unreachable runner and leaves nothing behind.
        const first = yield* cleanup.processDue(10)
        assert.deepStrictEqual(
          first.map((outcome) => outcome.completed).sort((a, b) => Number(a) - Number(b)),
          [false, true],
        )
        const retained = yield* sql<{
          session_id: string
          attempts: number
          last_error: string | null
          overdue: boolean
        }>`SELECT session_id, attempts, last_error, due_at <= CLOCK_TIMESTAMP() AS overdue FROM agent_session_cleanup`
        assert.strictEqual(retained.length, 1)
        const stuck = retained[0]!
        assert.strictEqual(stuck.attempts, 1)
        assert.strictEqual(stuck.last_error, "runner unreachable")
        assert.isFalse(stuck.overdue)
        assert.deepStrictEqual(yield* cleanup.processDue(10), [])
        assert.isTrue(runner.sessions.has(stuck.session_id))
        assert.isFalse(runner.sessions.has(stuck.session_id === "l-one" ? "l-two" : "l-one"))
        yield* sql`UPDATE agent_session_cleanup SET due_at = CLOCK_TIMESTAMP()`
        assert.deepStrictEqual(
          (yield* cleanup.processDue(10)).map((outcome) => outcome.completed),
          [true],
        )
        assert.deepStrictEqual(yield* sql`SELECT 1 FROM agent_session_cleanup`, [])
        assert.isFalse(runner.sessions.has("l-one"))
        assert.isFalse(runner.sessions.has("l-two"))
        assert.deepStrictEqual(
          cleanupCalls()
            .slice(callsBefore)
            .map((call) => call.detail),
          [{ generation: 1 }, { generation: 1 }, { generation: 1 }],
        )

        // Janitor crashed after the runner confirmed but before the tombstone went:
        // the retry asks again and the runner's answer is idempotent.
        yield* sql`INSERT INTO agent_session_cleanup (session_id, repository_id, generation) VALUES ('l-two', '9301', 1)`
        assert.deepStrictEqual(
          (yield* cleanup.processDue(10)).map((outcome) => outcome.completed),
          [true],
        )
        assert.deepStrictEqual(yield* sql`SELECT 1 FROM agent_session_cleanup`, [])

        // Reconnection starts from nothing; a fresh session identity works.
        yield* connections.change("9301", "connect", actor)
        yield* sessions.start({ sessionId: "l-three", title: "three", repositoryId: "9301" })
        assert.strictEqual(yield* deliverSession("l-three"), "settled")
        assert.strictEqual(
          (yield* connections.inventory).repositories.find((row) => row.repositoryId === "9301")!
            .sessionCount,
          1,
        )
      }),
  )

  it.effect(
    "keeps a paused repository paused when access returns and resumes only when ready",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const connections = yield* RepositoryConnections
        const sessions = yield* AgentSessions
        const observation = yield* SessionObservation
        const projection = yield* AgentEventProjection
        yield* connectRepository("9302", "pause")
        yield* sessions.start({ sessionId: "l-pause", title: "pause", repositoryId: "9302" })
        assert.strictEqual(yield* deliverSession("l-pause"), "settled")
        runner.push(
          "l-pause",
          { type: "session.execution.started", data: {} },
          { type: "session.execution.succeeded", data: {} },
        )
        yield* projection.catchUp("l-pause")
        assert.strictEqual((yield* observation.detail("l-pause")).execution, "idle")

        yield* connections.change("9302", "pause", actor)
        let detail = yield* observation.detail("l-pause")
        assert.strictEqual(detail.execution, "blocked")
        assert.strictEqual(
          detail.reason,
          "This repository is paused in Janitor. Resume it to continue.",
        )
        // Inputs are still accepted and kept while the repository is fenced.
        yield* sessions.accept({
          sessionId: "l-pause",
          contributionKey: "slack:p1",
          source: "slack",
          author: { displayName: "Ada" },
          text: "Keep going when you can",
        })
        assert.strictEqual((yield* observation.detail("l-pause")).acceptedInputs, 1)

        yield* sql`UPDATE github_repository SET access = 'lost' WHERE repository_id = '9302'`
        detail = yield* observation.detail("l-pause")
        assert.include(detail.reason, "GitHub access to this repository is unavailable")
        yield* sql`UPDATE github_repository SET access = 'accessible' WHERE repository_id = '9302'`
        detail = yield* observation.detail("l-pause")
        assert.include(detail.reason, "paused")

        yield* connections.change("9302", "resume", actor)
        detail = yield* observation.detail("l-pause")
        assert.strictEqual(detail.execution, "blocked")
        assert.include(detail.reason, "synchronization is in progress")
        yield* sql`UPDATE github_repository SET automation_ready_at = CLOCK_TIMESTAMP() WHERE repository_id = '9302'`
        detail = yield* observation.detail("l-pause")
        assert.strictEqual(detail.execution, "working")
        assert.strictEqual(detail.reason, "input pending")
        const page = yield* observation.list({ cursor: null, limit: 50 })
        assert.strictEqual(
          page.sessions.find((session) => session.sessionId === "l-pause")?.execution,
          "working",
        )
      }),
  )

  it.effect("teammate removal alone never deletes shared sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const teammates = yield* Teammates
      const sessions = yield* AgentSessions
      const founder = yield* teammates.admit({
        issuer: "test",
        subject: "founder",
        email: undefined,
      })
      const member = yield* teammates.admit({ issuer: "test", subject: "member", email: undefined })
      assert.strictEqual(founder._tag, "Admitted")
      assert.strictEqual(member._tag, "Admitted")
      if (founder._tag !== "Admitted" || member._tag !== "Admitted") return
      yield* sessions.start({ sessionId: "l-shared", title: "shared", repositoryId: "9302" })
      yield* sessions.accept({
        sessionId: "l-shared",
        contributionKey: "slack:s1",
        source: "slack",
        author: { teammateId: member.teammate.teammateId, displayName: "Member" },
        text: "Please start",
      })
      yield* teammates.remove(founder.teammate.teammateId, member.teammate.teammateId)
      const view = yield* sessions.view("l-shared")
      assert.strictEqual(view.inputs.length, 1)
      assert.deepStrictEqual(view.inputs[0]!.author, {
        teammateId: member.teammate.teammateId,
        displayName: "Member",
      })
      assert.deepStrictEqual(yield* sql`SELECT 1 FROM agent_session_cleanup`, [])
    }),
  )
})
