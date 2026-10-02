import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Docker from "alchemy/Docker"
import { hashDirectory } from "alchemy/Command/Memo"
import * as Neon from "alchemy/Neon"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { retain } from "alchemy/RemovalPolicy"
import { deployment } from "./Deployment.ts"

const LocalDatabasePassword = Redacted.make("janitor")

const LocalDatabase = Effect.gen(function* () {
  // A new logical resource forces a fresh container. Alchemy can treat a
  // changed image Output as an update and reuse the old container otherwise.
  // Local schema changes intentionally discard the old development database.
  const schemaHash = yield* hashDirectory({
    cwd: "apps/cluster",
    memo: { include: ["migrations/*.sql", "docker/postgres/Dockerfile"] },
  }).pipe(Effect.orDie)
  const image = yield* Docker.Image("PostgresImage", {
    tag: schemaHash,
    build: {
      context: "apps/cluster",
      dockerfile: "docker/postgres/Dockerfile",
    },
  })

  const container = yield* Docker.Container(`Postgres-${schemaHash}`, {
    image,
    environment: {
      POSTGRES_DB: "janitor",
      POSTGRES_USER: "janitor",
      POSTGRES_PASSWORD: LocalDatabasePassword,
    },
    ports: [{ external: 0, internal: 5432 }],
    healthcheck: {
      cmd: "pg_isready --username janitor --dbname janitor",
      interval: "1 second",
      timeout: "3 seconds",
      retries: 30,
    },
    start: true,
  })

  const origin: Alchemy.InputProps<Cloudflare.Hyperdrive.DevOrigin> = {
    scheme: "postgres",
    host: "127.0.0.1",
    port: container.ports["5432/tcp"],
    database: "janitor",
    user: "janitor",
    password: LocalDatabasePassword,
    sslmode: "disable",
  }

  return {
    databaseId: container.id,
    origin,
  }
})

export const NeonDatabase = Effect.gen(function* () {
  const target = yield* deployment
  const historyRetentionSeconds = yield* Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "NEON_HISTORY_RETENTION_SECONDS",
  ).pipe(Config.withDefault(7 * 24 * 60 * 60))
  const project = yield* Neon.Project("Database", {
    region: "aws-us-east-1",
    pgVersion: 18,
    migrations: "apps/cluster/migrations",
    historyRetentionSeconds,
  }).pipe(retain(target.retain))

  return {
    databaseId: project.projectId,
    origin: project.origin,
  }
})

export const JanitorDatabase = Effect.gen(function* () {
  const isDev = yield* Alchemy.ALCHEMY_DEV
  return yield* isDev ? LocalDatabase : NeonDatabase
})

export const JanitorHyperdrive = Effect.gen(function* () {
  const isDev = yield* Alchemy.ALCHEMY_DEV
  const database = yield* JanitorDatabase

  return yield* Cloudflare.Hyperdrive.Connection("Hyperdrive", {
    origin: database.origin,
    // Connection state, workflow coordination and sync progress require fresh reads.
    // Hyperdrive's default query cache is not invalidated by database writes.
    caching: { disabled: true },
    ...(isDev ? { dev: database.origin } : undefined),
  })
})
