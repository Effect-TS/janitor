import { assert, layer } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RepositoryConnections } from "../src/RepositoryConnections.ts"
import { GitHubTransport } from "../src/GitHub/Transport.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"
const Services = RepositoryConnections.layer.pipe(
  Layer.provideMerge(SyncTargets.layer),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
  Layer.provide(
    Layer.succeed(
      GitHubTransport,
      GitHubTransport.of({
        request: (request) =>
          Effect.succeed({
            _tag: "Ok",
            status: 200,
            body: request.url === "/app" ? { slug: "janitor" } : { id: 9001 },
            etag: Option.none(),
            link: Option.none(),
            requestId: Option.none(),
          }),
      }),
    ),
  ),
)
const actor = { issuer: "test", subject: "operator" }
layer(Services, { timeout: "2 minutes" })("Repository connections", (it) => {
  it.effect("connects idempotently, disconnects durably, and reconnects paused", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connections = yield* RepositoryConnections
      yield* sql`INSERT INTO github_installation(installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES('77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1)`
      yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,access,projected_sequence) VALUES('9001','77','test','example',FALSE,'accessible',1)`
      assert.isFalse((yield* connections.inventory).repositories[0]!.connected)
      yield* connections.change("9001", "connect", actor)
      yield* connections.change("9001", "connect", actor)
      assert.isTrue((yield* connections.inventory).repositories[0]!.enabled)
      const audit = yield* sql`SELECT action FROM repository_connection_audit`
      assert.deepStrictEqual(audit, [{ action: "connect" }])
      assert.strictEqual((yield* sql`SELECT scope FROM sync_target`).length, 3)
      yield* connections.change("9001", "disconnect", actor)
      yield* connections.change("9001", "disconnect", actor)
      const disconnected = (yield* connections.inventory).repositories[0]!
      assert.isFalse(disconnected.connected)
      assert.isFalse(disconnected.enabled)
      assert.isTrue(disconnected.reconnect)
      assert.isFalse(
        (yield* sql<{
          eligible: boolean
        }>`SELECT sync_scope_enabled('{"_tag":"RepositoryTrack","repositoryId":"9001","track":"labels"}') AS eligible`)[0]!
          .eligible,
      )
      const denied = yield* Effect.flip(connections.change("9001", "resume", actor))
      assert.include(denied.message, "Reconnect")
      yield* connections.change("9001", "connect", actor)
      assert.isFalse((yield* connections.inventory).repositories[0]!.enabled)
      yield* connections.change("9001", "resume", actor)
      assert.isTrue((yield* connections.inventory).repositories[0]!.enabled)
      yield* sql`UPDATE github_repository SET access='lost' WHERE repository_id='9001'`
      yield* connections.change("9001", "pause", actor)
      assert.include(
        (yield* Effect.flip(connections.change("9001", "resume", actor))).message,
        "Restore GitHub access",
      )
    }),
  )
  it.effect("binds expiring GitHub return state to the operator and consumes it once", () =>
    Effect.gen(function* () {
      const connections = yield* RepositoryConnections
      const url = new URL(yield* connections.github(null, actor))
      assert.strictEqual(url.pathname, "/apps/janitor/installations/new")
      const state = url.searchParams.get("state")!
      yield* Effect.flip(connections.returned(state, { ...actor, subject: "someone-else" }))
      yield* connections.returned(state, actor)
      yield* Effect.flip(connections.returned(state, actor))
      const expired = new URL(yield* connections.github(null, actor)).searchParams.get("state")!
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE repository_connection_attempt SET expires_at=now()-interval '1 minute' WHERE state::text=${expired}`
      yield* Effect.flip(connections.returned(expired, actor))
    }),
  )
  it.effect("waits for an active repository write before completing disconnect", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connections = yield* RepositoryConnections
      yield* sql`UPDATE github_repository SET connected=TRUE,enabled=TRUE,access='accessible' WHERE repository_id='9001'`
      const locked = yield* Deferred.make<void>()
      yield* Effect.all(
        [
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id='9001' FOR UPDATE`
              yield* Deferred.succeed(locked, undefined)
              yield* sql`SELECT pg_sleep(0.1)`
              yield* sql`INSERT INTO repository_connection_audit(repository_id,action,issuer,subject) VALUES('9001','write-ended','test','worker')`
            }),
          ),
          Deferred.await(locked).pipe(
            Effect.flatMap(() => connections.change("9001", "disconnect", actor)),
          ),
        ],
        { concurrency: 2 },
      )
      assert.deepStrictEqual(
        (yield* sql<{
          action: string
        }>`SELECT action FROM repository_connection_audit ORDER BY id DESC LIMIT 2`).map(
          (row) => row.action,
        ),
        ["disconnect", "write-ended"],
      )
    }),
  )
})
