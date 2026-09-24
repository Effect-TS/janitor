import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as PostgresTypes from "../../src/PostgresTypes.ts"

/**
 * Splits a SQL script into statements. The Postgres driver only speaks the
 * extended protocol, which rejects more than one command per message, so a
 * migration file has to run one statement at a time. Semicolons inside string
 * literals, dollar-quoted bodies and comments do not end a statement.
 */
export const splitStatements = (script: string): ReadonlyArray<string> => {
  const statements: Array<string> = []
  let current = ""
  let index = 0
  const flush = () => {
    const text = current.trim()
    if (text.length > 0) statements.push(text)
    current = ""
  }
  while (index < script.length) {
    const rest = script.slice(index)
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest)
    if (dollar) {
      const close = script.indexOf(dollar[0], index + dollar[0].length)
      const end = close === -1 ? script.length : close + dollar[0].length
      current += script.slice(index, end)
      index = end
    } else if (rest.startsWith("--")) {
      const end = script.indexOf("\n", index)
      index = end === -1 ? script.length : end
    } else if (rest.startsWith("/*")) {
      const close = script.indexOf("*/", index + 2)
      index = close === -1 ? script.length : close + 2
    } else if (rest.startsWith("'")) {
      let end = index + 1
      while (end < script.length) {
        if (script[end] === "'" && script[end + 1] === "'") end += 2
        else if (script[end] === "'") break
        else end += 1
      }
      current += script.slice(index, end + 1)
      index = end + 1
    } else if (rest.startsWith(";")) {
      flush()
      index += 1
    } else {
      current += script[index]
      index += 1
    }
  }
  flush()
  return statements
}

/** Runs a multi-statement SQL script one statement at a time. */
export const runScript = (sql: SqlClient.SqlClient, script: string) =>
  Effect.forEach(splitStatements(script), (statement) => sql.unsafe(statement).unprepared, {
    discard: true,
  })

/** Applies every SQL migration in file order, as Neon and the local image do. */
const applyMigrations = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sql = yield* SqlClient.SqlClient

  const migrationsDir = path.resolve(import.meta.dirname, "../../migrations")
  const files = yield* fs.readDirectory(migrationsDir)

  for (const file of files.filter((name) => name.endsWith(".sql")).sort()) {
    const text = yield* fs.readFileString(path.join(migrationsDir, file), "utf8")
    yield* runScript(sql, text)
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
      types: PostgresTypes.types,
    })
  }),
)

/** A fresh Postgres 18 container with all migrations applied. */
export const MigratedPostgresLayer = Layer.effectDiscard(applyMigrations).pipe(
  Layer.provideMerge(PostgresLayer),
  Layer.provide(NodeServices.layer),
)
