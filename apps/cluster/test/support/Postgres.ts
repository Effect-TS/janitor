import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { inject } from "vite-plus/test"
import type { TestProject } from "vite-plus/test/node"
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

/** The migrated database every test database is copied from. */
const TEMPLATE = "migrated"

const clientLayer = (url: string) =>
  PgClient.layer({
    url: Redacted.make(url, { label: "postgres-connection-url" }),
    types: PostgresTypes.types,
  })

const withDatabase = (url: string, database: string) => {
  const next = new URL(url)
  next.pathname = `/${database}`
  return next.toString()
}

/** Runs `effect` against `url` with a short-lived client. */
const usingDatabase = <A, E>(
  url: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Path.Path>,
) => effect.pipe(Effect.provide(Layer.merge(clientLayer(url), NodeServices.layer)), Effect.scoped)

/** Runs one statement that cannot run inside a transaction, such as `CREATE DATABASE`. */
const execute = (url: string, statement: string) =>
  usingDatabase(
    url,
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement).unprepared),
  )

declare module "vitest" {
  export interface ProvidedContext {
    /** Connection URL for the shared server's maintenance database. */
    readonly postgresUrl: string
  }
}

/**
 * Vitest global setup: starts one Postgres 18 server for the run and migrates
 * the template database. Tests never survive a crash, so durability is off.
 */
export const setup = (project: TestProject) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const container = yield* Effect.promise(() =>
        new PostgreSqlContainer("postgres:18-alpine")
          .withCommand([
            "postgres",
            "-c",
            "fsync=off",
            "-c",
            "synchronous_commit=off",
            "-c",
            "full_page_writes=off",
            "-c",
            "max_connections=500",
          ])
          .start(),
      )
      const url = container.getConnectionUri()
      yield* execute(url, `CREATE DATABASE ${TEMPLATE}`)
      yield* usingDatabase(withDatabase(url, TEMPLATE), applyMigrations)
      // Refusing connections keeps the template copyable by every worker at once.
      yield* execute(
        url,
        `ALTER DATABASE ${TEMPLATE} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
      )
      project.provide("postgresUrl", url)
      return () => container.stop()
    }),
  )

/**
 * Copies the migrated template into a new database on the shared server and
 * drops it when the scope closes. Returns the new database's connection URL.
 */
export const migratedDatabase = Effect.acquireRelease(
  Effect.gen(function* () {
    const server = inject("postgresUrl")
    // Not `Random`: test services may seed it, and names must differ across workers.
    const name = `test_${crypto.randomUUID().replaceAll("-", "")}`
    yield* execute(server, `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`)
    return { url: withDatabase(server, name), name, server }
  }).pipe(Effect.orDie),
  ({ name, server }) =>
    execute(server, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).pipe(Effect.ignore),
)

/** A fresh database with all migrations applied, on the run's shared server. */
export const MigratedPostgresLayer = Layer.unwrap(
  Effect.map(migratedDatabase, ({ url }) => clientLayer(url)),
)
