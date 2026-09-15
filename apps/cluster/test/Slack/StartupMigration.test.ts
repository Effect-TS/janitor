import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
const migration = readFileSync(
  new URL("../../migrations/0036_slack_startup.sql", import.meta.url),
  "utf8",
)
layer(MigratedPostgresLayer, { timeout: "2 minutes" })("Slack startup migration", (it) => {
  it.effect("adopts pending work while retaining history, leases and session identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE SCHEMA legacy_startup`
      yield* sql`CREATE TABLE legacy_startup.slack_thread (LIKE public.slack_thread INCLUDING ALL)`
      for (const column of [
        "input_revision",
        "startup_phase",
        "selection_reason",
        "inference_key",
        "inference_result",
        "retry_count",
        "retry_not_before",
      ])
        yield* sql.unsafe(`ALTER TABLE legacy_startup.slack_thread DROP COLUMN ${column} CASCADE`)
      yield* sql`CREATE TABLE legacy_startup.slack_contribution (LIKE public.slack_contribution INCLUDING ALL)`
      yield* sql`CREATE TABLE legacy_startup.github_repository (LIKE public.github_repository INCLUDING ALL)`
      yield* sql`CREATE TABLE legacy_startup.workflow_outbox (LIKE public.workflow_outbox INCLUDING ALL)`
      yield* sql`INSERT INTO legacy_startup.slack_thread(session_id,workspace_id,channel_id,thread_ts,boundary_ts,state,context_cursor,context_pages,lease_token,lease_until) VALUES
      ('pending','T','C1','1.0','1.1','initializing','page-2','[{"ts":"1.0","text":"retained"}]','old-owner',CLOCK_TIMESTAMP()+interval '10 seconds'),
      ('idle','T','C2','2.0','2.0','ready','','[]',NULL,NULL),
      ('buffered','T','C3','3.0','3.0','ready','','[]',NULL,NULL)`
      yield* sql`INSERT INTO legacy_startup.slack_contribution(workspace_id,channel_id,thread_ts,message_ts,author_id,author,text,decision) VALUES('T','C3','3.0','3.1','U','{}','new input','accepted')`
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL search_path TO legacy_startup,public`
          yield* sql.unsafe(migration)
        }),
      )
      const requests = yield* sql<{
        execution_key: string
      }>`SELECT execution_key FROM legacy_startup.workflow_outbox ORDER BY execution_key`
      assert.deepEqual(
        requests.map((r) => r.execution_key),
        ["buffered:0", "pending:0"],
      )
      const [pending] = yield* sql<{
        context_cursor: string
        lease_token: string
        context_pages: unknown
      }>`SELECT context_cursor,lease_token,context_pages FROM legacy_startup.slack_thread WHERE session_id='pending'`
      assert.strictEqual(pending!.context_cursor, "page-2")
      assert.strictEqual(pending!.lease_token, "old-owner")
      assert.deepEqual(pending!.context_pages, [{ ts: "1.0", text: "retained" }])
      const [idle] = yield* sql<{
        idle: boolean
      }>`SELECT due_at='infinity'::timestamptz AS idle FROM legacy_startup.slack_thread WHERE session_id='idle'`
      assert.isTrue(idle!.idle)
    }),
  )
})
