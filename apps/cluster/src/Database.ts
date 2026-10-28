import * as Alchemy from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Docker from "@alchemy.run/docker"
import { hashDirectory } from "alchemy/Command/Memo"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { requiredText } from "./Deployment.ts"
import { PostgresMigrations } from "./PostgresMigrations.ts"

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

// Production runs on an Azure Database for PostgreSQL Flexible Server created
// outside Alchemy. Its firewall admits every address because Hyperdrive has no
// fixed egress IPs, so the server requires TLS.
export const AzureDatabase = Effect.gen(function* () {
  const host = yield* requiredText("POSTGRES_HOST")
  const migrations = yield* PostgresMigrations("Migrations", {
    origin: {
      host,
      port: 5432,
      database: "janitor",
      user: yield* requiredText("POSTGRES_USER"),
      password: yield* requiredText("POSTGRES_PASSWORD").pipe(Config.map(Redacted.make)),
    },
    migrations: "apps/cluster/migrations",
  })

  // Hyperdrive takes the origin from the migrations, so the Workers deploy
  // only after the schema is current.
  const origin: Alchemy.InputProps<Cloudflare.Hyperdrive.PublicOrigin> = {
    scheme: "postgres",
    host: migrations.origin.host,
    port: migrations.origin.port,
    database: migrations.origin.database,
    user: migrations.origin.user,
    password: migrations.origin.password,
  }

  return {
    databaseId: host,
    origin,
  }
})

export const JanitorDatabase = Effect.gen(function* () {
  const isDev = yield* Alchemy.ALCHEMY_DEV
  return yield* isDev ? LocalDatabase : AzureDatabase
})

export const JanitorHyperdrive = Effect.gen(function* () {
  const isDev = yield* Alchemy.ALCHEMY_DEV
  const database = yield* JanitorDatabase

  return yield* Cloudflare.Hyperdrive.Connection("Hyperdrive", {
    origin: database.origin,
    // Connection state, workflow coordination and sync progress require fresh reads.
    // Hyperdrive's default query cache is not invalidated by database writes.
    caching: { disabled: true },
    ...(isDev ? { dev: database.origin } : { mtls: { sslmode: "require" } }),
  })
})
