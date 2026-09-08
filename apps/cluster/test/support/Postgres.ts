import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Applies every SQL migration in file order, as Neon and the local image do. */
const applyMigrations = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sql = yield* SqlClient.SqlClient

  const migrationsDir = path.resolve(import.meta.dirname, "../../migrations")
  const files = yield* fs.readDirectory(migrationsDir)

  for (const file of files.filter((name) => name.endsWith(".sql")).sort()) {
    const text = yield* fs.readFileString(path.join(migrationsDir, file), "utf8")
    yield* sql.unsafe(text)
  }
})

const PostgresLayer = Layer.unwrap(
  Effect.gen(function* () {
    const container = yield* Effect.acquireRelease(
      Effect.promise((): Promise<StartedPostgreSqlContainer> =>
        new PostgreSqlContainer("postgres:18-alpine").start(),
      ),
      (container) => Effect.promise(() => container.stop()),
    )
    return PgClient.layer({
      url: Redacted.make(container.getConnectionUri(), { label: "postgres-connection-url" }),
    })
  }),
)

/** A fresh Postgres 18 container with all migrations applied. */
export const MigratedPostgresLayer = Layer.effectDiscard(applyMigrations).pipe(
  Layer.provideMerge(PostgresLayer),
  Layer.provide(NodeServices.layer),
)
