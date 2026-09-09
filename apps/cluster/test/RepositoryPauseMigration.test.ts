import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { MigratedPostgresLayer } from "./support/Postgres.ts"
import { describeError } from "../src/SqlErrors.ts"

const migration = readFileSync(
  new URL("../migrations/0018_repository_pause.sql", import.meta.url),
  "utf8",
)
layer(MigratedPostgresLayer, { timeout: "2 minutes" })("Repository pause migration", (it) => {
  it.effect("reports both conflicting legacy controls and preserves operator choices", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE SCHEMA legacy_pause`
      yield* sql`CREATE TABLE legacy_pause.github_repository (repository_id TEXT PRIMARY KEY, owner TEXT, repo TEXT, installation_id TEXT, connected BOOLEAN, enabled BOOLEAN, sync_enabled BOOLEAN)`
      yield* sql`CREATE TABLE legacy_pause.github_installation (installation_id TEXT, sync_enabled BOOLEAN)`
      yield* sql`CREATE TABLE legacy_pause.sync_target (LIKE public.sync_target INCLUDING ALL)`
      yield* sql`CREATE TABLE legacy_pause.workflow_outbox (LIKE public.workflow_outbox INCLUDING ALL)`
      yield* sql`INSERT INTO legacy_pause.github_repository VALUES
      ('1','test','automation-only','77',TRUE,TRUE,FALSE),
      ('2','test','sync-only','77',TRUE,FALSE,TRUE),
      ('3','test','paused','77',TRUE,FALSE,FALSE),
      ('4','test','disconnected','77',FALSE,FALSE,TRUE)`
      const migrate = sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL search_path TO legacy_pause, public`
          yield* sql.unsafe(migration)
        }),
      )
      const error = describeError(yield* Effect.flip(migrate))
      assert.include(error, "automation-only")
      assert.include(error, "sync-only")
      assert.include(error, "Ambiguous repository pause")
      yield* sql`UPDATE legacy_pause.github_repository SET enabled=TRUE,sync_enabled=TRUE WHERE repository_id='1'`
      yield* sql`UPDATE legacy_pause.github_repository SET enabled=FALSE,sync_enabled=FALSE WHERE repository_id='2'`
      yield* migrate
      assert.deepStrictEqual(
        yield* sql`SELECT repository_id, enabled, sync_enabled FROM legacy_pause.github_repository ORDER BY repository_id`,
        [
          { repository_id: "1", enabled: true, sync_enabled: true },
          { repository_id: "2", enabled: false, sync_enabled: false },
          { repository_id: "3", enabled: false, sync_enabled: false },
          { repository_id: "4", enabled: false, sync_enabled: false },
        ],
      )
      assert.include(
        describeError(
          yield* Effect.flip(
            sql`UPDATE legacy_pause.github_repository SET sync_enabled=FALSE WHERE repository_id='1'`,
          ),
        ),
        "can only be updated to DEFAULT",
      )
    }),
  )
})
