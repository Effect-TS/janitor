import { isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import {
  diffMigrations,
  makePgMigrationExecutor,
  MigrationError,
  runMigrations,
  stampedOf,
} from "alchemy/SQL/Migrations/index"
import { importPg } from "alchemy/SQL/PostgresDriver"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

export interface PostgresMigrationsProps {
  /** The database the migrations run against, reached directly over verified TLS. */
  readonly origin: {
    readonly host: string
    readonly port: number
    readonly database: string
    readonly user: string
    readonly password: Redacted.Redacted<string>
  }
  /** Directory of `.sql` migrations, applied in file order. */
  readonly migrations: string
}

export type PostgresMigrations = Resource<
  "Janitor.PostgresMigrations",
  PostgresMigrationsProps,
  {
    /** The props' origin, resolved only after the migrations apply. */
    origin: PostgresMigrationsProps["origin"]
    migrationsTable: string | undefined
    migrationsHashes: Record<string, string>
  }
>

/**
 * Applies SQL migrations to a Postgres database that Alchemy does not manage,
 * using the same runner and `__alchemy_migrations` bookkeeping as Alchemy's
 * own database resources. Read the connection details from `origin` so that
 * dependents deploy against the migrated schema. Deleting the resource leaves
 * the schema in place.
 */
export const PostgresMigrations = Resource<PostgresMigrations>("Janitor.PostgresMigrations")

const toMigrationError = (host: string) => (cause: unknown) =>
  new MigrationError({ message: `Postgres at ${host}: ${String(cause)}`, cause })

const withClient = <A, E, R>(
  origin: PostgresMigrationsProps["origin"],
  use: (client: any) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const { Client } = yield* Effect.tryPromise({
        try: importPg,
        catch: toMigrationError(origin.host),
      })
      const client = new Client({
        host: origin.host,
        port: origin.port,
        database: origin.database,
        user: origin.user,
        password: Redacted.value(origin.password),
        ssl: { rejectUnauthorized: true },
      })
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: toMigrationError(origin.host),
      })
      return client
    }),
    use,
    (client) => Effect.promise(() => client.end().catch(() => {})),
  )

export const PostgresMigrationsProvider = Provider.succeed(PostgresMigrations, {
  diff: Effect.fn(function* ({ news, output }) {
    if (!output || !isResolved(news)) return undefined
    if (yield* diffMigrations({ news, output })) return { action: "update" } as const
    return undefined
  }),
  reconcile: ({ news, output }) =>
    runMigrations({
      input: { dir: news.migrations },
      stamped: stampedOf(output),
      withExecutor: (apply) =>
        withClient(news.origin, (client) => apply(makePgMigrationExecutor(client))),
    }).pipe(
      Effect.map((run) => ({
        origin: news.origin,
        migrationsTable: run.resolved.table,
        migrationsHashes: run.hashes,
      })),
    ),
  delete: () => Effect.void,
  read: ({ output }) => Effect.succeed(output),
})
