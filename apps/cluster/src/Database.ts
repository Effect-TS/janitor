import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Docker from "alchemy/Docker"
import * as Command from "alchemy/Command"
import { hashDirectory } from "alchemy/Command/Memo"
import * as Neon from "alchemy/Neon"
import * as Output from "alchemy/Output"
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

  yield* seedDevelopmentData(container.ports["5432/tcp"], container.id)

  return {
    databaseId: container.id,
    origin,
  }
})

/**
 * Wipes the local database and refills it with recognisable data.
 *
 * Declared only here, inside the local branch, so it cannot reach Neon: the
 * resource does not exist in a deploy at all. The seed script re-checks that
 * its target is loopback before it truncates anything, so a stray
 * `DATABASE_URL` in the environment cannot redirect it either.
 *
 * The connection string is built from the container rather than read from
 * `.env` because the host port is assigned at random (`external: 0`). Passing
 * it through `env` orders the command after container creation. The seed
 * retries connection acquisition while PostgreSQL initializes.
 *
 * Set `JANITOR_SEED=false` to skip it. Seed edits and container replacement
 * trigger a fresh seed. Ordinary restarts retain the data. Run `vp run seed`
 * to force a seed against the current container.
 */
const seedDevelopmentData = (port: Output.Output<number>, containerId: Output.Output<string>) =>
  Effect.gen(function* () {
    const isEnabled = yield* Config.Boolean("JANITOR_SEED").pipe(Config.withDefault(true))
    if (!isEnabled) return

    yield* Command.Exec("SeedDatabase", {
      command: "node apps/cluster/seed/main.ts",
      env: {
        // Re-seed a replacement even if Docker assigns it the same host port.
        JANITOR_DATABASE_INSTANCE: containerId,
        DATABASE_URL: Output.interpolate`postgres://janitor:janitor@127.0.0.1:${port}/janitor?sslmode=disable`,
      },
      memo: { include: ["apps/cluster/seed/**"] },
      timeout: "2 minutes",
    })
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
