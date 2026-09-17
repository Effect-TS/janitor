import { assert, layer } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

layer(MigratedPostgresLayer, { timeout: "2 minutes" })("Legacy runner retirement", (it) => {
  it.effect("upgrades populated runner state and preserves repository operations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const fs = yield* FileSystem.FileSystem
      const directory = `${import.meta.dirname}/../migrations`
      const files = (yield* fs.readDirectory(directory))
        .filter((file) => file.endsWith(".sql"))
        .sort()
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE SCHEMA legacy_runner_upgrade`
          yield* sql`SET LOCAL search_path TO legacy_runner_upgrade`
          for (const file of files.filter((file) => file < "0037")) {
            yield* sql.unsafe(yield* fs.readFileString(`${directory}/${file}`))
          }
          yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1)`
          yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence,automation_ready_at) VALUES('9100','77','test','example',TRUE,TRUE,'accessible',1,CLOCK_TIMESTAMP())`
          yield* sql`INSERT INTO teammate(issuer,subject,role) VALUES('test','person','member')`
          yield* sql`INSERT INTO agent_session(session_id,title,repository_id) VALUES('old_session','Old conversation','9100')`
          yield* sql`INSERT INTO slack_thread(session_id,workspace_id,channel_id,thread_ts,boundary_ts,repository_id) VALUES('old_session','T1','C1','1.1','1.1','9100')`
          yield* sql`INSERT INTO agent_session_cleanup(session_id,repository_id,generation) VALUES('ended_session','9100',1)`
          yield* sql`INSERT INTO workflow_outbox(workflow_tag,execution_key,payload) VALUES
            ('Janitor/SlackProcessingV1','old_session:1','{"sessionId":"old_session"}'),
            ('Janitor/AgentRunnerHandoffV1','old_session','{"sessionId":"old_session"}'),
            ('unrelated','keep','{}')`

          yield* sql.unsafe(yield* fs.readFileString(`${directory}/0037_retire_legacy_runner.sql`))
          assert.deepStrictEqual(
            yield* sql`SELECT tablename FROM pg_tables WHERE schemaname='legacy_runner_upgrade'
              AND (tablename LIKE 'agent_%' OR tablename LIKE 'slack_%' OR tablename LIKE 'github_feedback%')`,
            [],
          )
          assert.deepStrictEqual(yield* sql`SELECT workflow_tag FROM workflow_outbox`, [
            { workflow_tag: "unrelated" },
          ])
          assert.lengthOf(yield* sql`SELECT * FROM teammate`, 1)
          assert.deepStrictEqual(yield* sql`SELECT repository_block_reason('9100') AS reason`, [
            { reason: null },
          ])
          yield* sql`UPDATE teammate SET status='removed'`
          yield* sql`UPDATE github_repository SET enabled=false WHERE repository_id='9100'`
          assert.lengthOf(
            yield* sql`SELECT * FROM live_notification WHERE repository_id='sessions'`,
            0,
          )
          yield* sql`SELECT delete_repository_data('9100')`
          assert.lengthOf(yield* sql`SELECT * FROM github_repository`, 1)
          assert.deepStrictEqual(yield* sql`SELECT workflow_tag FROM workflow_outbox`, [
            { workflow_tag: "unrelated" },
          ])
        }),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
