import { assert, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { scratchStack } from "alchemy/Test/Core"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/sql/SqlClient"
import { PostgresMigrations, PostgresMigrationsProvider } from "../src/PostgresMigrations.ts"
import { emptyDatabase, usingDatabase } from "./support/Postgres.ts"

const MIGRATIONS = "apps/cluster/migrations"

it.live(
  "a second deploy applies no migrations",
  () =>
    Effect.gen(function* () {
      const stack = scratchStack({ providers: PostgresMigrationsProvider }, "PostgresMigrations")
      const { url } = yield* emptyDatabase
      const server = new URL(url)
      const deploy = stack
        .deploy(
          PostgresMigrations("Migrations", {
            origin: {
              host: server.hostname,
              port: Number(server.port),
              database: server.pathname.slice(1),
              user: decodeURIComponent(server.username),
              password: Redacted.make(decodeURIComponent(server.password)),
              sslmode: "disable",
            },
            migrations: MIGRATIONS,
          }),
        )
        .pipe(Effect.orDie)
      const applied = usingDatabase(
        url,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{
            name: string
            applied_at: Date
          }>`SELECT name, applied_at FROM __alchemy_migrations ORDER BY id`
        }),
      )

      const files = (yield* (yield* FileSystem.FileSystem).readDirectory(MIGRATIONS))
        .filter((file) => file.endsWith(".sql"))
        .sort()

      yield* deploy
      const first = yield* applied
      assert.deepStrictEqual(
        first.map((row) => row.name),
        files,
      )
      const schema = yield* usingDatabase(
        url,
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{ table: string | null }>`SELECT to_regclass('pr_review_runs')::text AS table`,
        ),
      )
      assert.strictEqual(schema[0]?.table, "pr_review_runs")

      yield* deploy
      assert.deepStrictEqual(yield* applied, first)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
)
