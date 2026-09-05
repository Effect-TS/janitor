/**
 * Wipes the development database and refills it with recognisable data.
 *
 *   DATABASE_URL=postgres://... node apps/cluster/seed/main.ts
 *
 * `alchemy dev` runs this for you through a `Command.Exec` declared in
 * `apps/cluster/src/Database.ts`; `vp run seed` runs it on demand against the
 * container that is already up.
 *
 * The schema is never touched. Locally the migrations only run once, when the
 * Postgres container first initialises (`docker/postgres/Dockerfile` copies
 * them into `/docker-entrypoint-initdb.d/`), so there is no path back from a
 * dropped database short of destroying the container. This truncates rows and
 * leaves the tables alone.
 */
import * as PgClient from "@effect/sql-pg/PgClient"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Schedule from "effect/Schedule"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubReadModel } from "../src/GitHub/ReadModel.ts"
import { RulesetActivation } from "../src/Labeling/Activation.ts"
import { LabelingConfiguration } from "../src/Labeling/Configuration.ts"
import { Policies } from "../src/Labeling/Policies.ts"
import { LabelingRules } from "../src/Labeling/Rules.ts"
import { SnapshotHandoff } from "../src/Labeling/SnapshotHandoff.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import * as Fixtures from "./Fixtures.ts"

// GUARD

/**
 * Hosts this script is willing to destroy. The Alchemy resource that runs it
 * is only declared under `ALCHEMY_DEV`, so it cannot reach a deploy; this is
 * the second, independent gate, for the case where someone runs the script by
 * hand with the wrong `DATABASE_URL` exported. A managed Postgres host is
 * never loopback, so the check cannot pass by accident.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"])

export class NotALocalDatabase extends Data.TaggedError("NotALocalDatabase")<{
  readonly host: string
}> {
  override get message(): string {
    return (
      `Refusing to wipe ${this.host}: the seed only runs against a local database. ` +
      `Expected one of ${[...LOCAL_HOSTS].join(", ")}.`
    )
  }
}

/** Rejects any URL that does not point at this machine. */
export const requireLocalHost = (url: string): Effect.Effect<string, NotALocalDatabase> =>
  Effect.suspend(() => {
    const host = new URL(url).hostname
    return LOCAL_HOSTS.has(host)
      ? Effect.succeed(host)
      : Effect.fail(new NotALocalDatabase({ host }))
  })

// WIPE

/**
 * Empties every table in `public` in one statement. The list is read from the
 * catalogue rather than written down, so a new migration needs no change here.
 * `CASCADE` covers the foreign keys between the read model and labeling
 * tables; `RESTART IDENTITY` resets sequences so ids are stable across runs.
 */
const truncateAll = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly tablename: string
  }>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  const tables = rows.map((row) => row.tablename).sort()
  if (tables.length === 0) {
    return yield* Effect.logWarning(
      "No tables found. The container may still be initialising its migrations.",
    )
  }
  yield* sql.unsafe(
    `TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(", ")} RESTART IDENTITY CASCADE`,
  )
  yield* Effect.log(`wiped ${tables.length} tables`)
})

// SEED

const seedRepository = Effect.fnUntraced(function* (repository: Fixtures.SeedRepository) {
  const readModel = yield* GitHubReadModel
  const sql = yield* SqlClient.SqlClient
  const repositoryId = Fixtures.repositoryDatabaseId(repository.id)

  yield* readModel.applyRepositories({
    installationId: Fixtures.installationId,
    repositories: [
      {
        id: repositoryId,
        fullName: { owner: repository.owner, repo: repository.repo },
        isPrivate: false,
      },
    ],
    sequence: Fixtures.sequence,
  })

  // The read model starts every repository paused, and mutation is fenced on
  // it being enabled, so this has to happen before any labeling write.
  if (repository.isEnabled) {
    yield* sql`UPDATE github_repository SET enabled = TRUE WHERE repository_id = ${repositoryId}`
  }

  yield* readModel.applyLabelCatalog({
    repositoryId,
    labels: repository.labels.map((label) => ({
      id: Fixtures.labelDatabaseId(label.id),
      nodeId: Fixtures.labelNodeId(label.id),
      name: label.name,
    })),
    sequence: Fixtures.sequence,
  })

  for (const pullRequest of repository.pullRequests) {
    const issue = yield* Schema.decodeUnknownEffect(Fixtures.GitHubIssueApi)({
      id: Fixtures.issueId(repository.id, pullRequest.number),
      node_id: `I_${repository.id}_${pullRequest.number}`,
      number: pullRequest.number,
      title: pullRequest.title,
      body: null,
      state: pullRequest.state,
      user: { id: 9, login: "octocat" },
      labels: [],
      updated_at: Fixtures.updatedAt(pullRequest.number),
      pull_request: { url: "https://api.github.com/x" },
    })
    yield* readModel.applyIssue({ repositoryId, sequence: Fixtures.sequence, issue })
    yield* readModel.applyPullRequestDetails({
      repositoryId,
      sequence: Fixtures.sequence,
      pullRequest: {
        id: Fixtures.pullRequestId(repository.id, pullRequest.number),
        nodeId: Fixtures.pullRequestNodeId(repository.id, pullRequest.number),
        number: pullRequest.number,
        state: pullRequest.state,
        draft: pullRequest.isDraft,
        mergedAt: null,
        updatedAt: DateTime.makeUnsafe(Fixtures.updatedAt(pullRequest.number)),
        head: { sha: Fixtures.headSha },
        base: { ref: pullRequest.baseRef },
      },
    })
  }

  yield* seedPolicies(repository, repositoryId)
  yield* sql`UPDATE github_repository SET sync_enabled = FALSE WHERE repository_id = ${repositoryId}`
})

const seedPolicies = Effect.fnUntraced(function* (
  repository: Fixtures.SeedRepository,
  repositoryId: ReturnType<typeof Fixtures.repositoryDatabaseId>,
) {
  if (repository.policies.length === 0) {
    return
  }
  const policies = yield* Policies
  const rules = yield* LabelingRules
  const labelIdByName = new Map(
    repository.labels.map((label) => [label.name, Fixtures.labelDatabaseId(label.id)]),
  )

  let priority = 0
  for (const policy of repository.policies) {
    const created = yield* policies.create(repositoryId, policy.request, Fixtures.actor)
    if (!policy.isPublished) {
      continue
    }
    yield* policies.publish(
      repositoryId,
      created.policy.policyId,
      created.policy.version,
      Fixtures.actor,
    )
    const labelId = policy.labelName === null ? undefined : labelIdByName.get(policy.labelName)
    if (labelId === undefined) {
      continue
    }
    yield* rules.create(
      repositoryId,
      {
        labelId,
        policyId: created.policy.policyId,
        onNoMatch: "ensure-absent",
        group: null,
        priority,
        enabled: true,
      },
      Fixtures.actor,
    )
    priority = priority + 1
  }
})

const seed = Effect.gen(function* () {
  const readModel = yield* GitHubReadModel
  yield* readModel.applyInstallation({
    installation: {
      id: Fixtures.installationId,
      account: { id: Fixtures.accountId, login: "Effectful-Tech", type: "Organization" },
      repositorySelection: "all",
      htmlUrl: `https://github.com/settings/installations/${Fixtures.installationId}`,
      suspendedAt: null,
    },
    status: "active",
    sequence: Fixtures.sequence,
  })

  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE github_installation SET sync_enabled = FALSE WHERE installation_id = ${Fixtures.installationId}`

  for (const repository of Fixtures.repositories) {
    yield* seedRepository(repository)
    yield* Effect.log(`seeded ${repository.owner}/${repository.repo}`)
  }
})

// ENTRY

const DatabaseUrl = Config.schema(Schema.Redacted(Schema.String), "DATABASE_URL")

// Alchemy returns the container before PostgreSQL finishes initializing.
// Retry only connection acquisition; schema and seed errors still fail once.
const Database = PgClient.layerFrom(
  Effect.flatMap(DatabaseUrl, (url) =>
    PgClient.make({ url, connectTimeout: "1 second" }).pipe(
      Effect.retry({
        times: 30,
        schedule: Schedule.spaced("1 second"),
      }),
    ),
  ),
)

const Services = LabelingRules.layer.pipe(
  Layer.provideMerge(Policies.layer),
  Layer.provideMerge(LabelingConfiguration.layer),
  Layer.provideMerge(SnapshotHandoff.layer),
  Layer.provideMerge(
    Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer, RulesetActivation.layer),
  ),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(Database),
)

/** Wipe and refill atomically. Assumes the guard has already passed. */
const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* truncateAll
      yield* seed
    }),
  )
  yield* Effect.log("seed complete")
})

/**
 * The guard runs before `Services` is built, not inside `program`. `PgClient`
 * connects while its Layer is constructed, so checking the host inside the
 * program would open a connection to whatever `DATABASE_URL` names before
 * refusing it. Nothing destructive would follow — `requireLocalHost` still
 * precedes `truncateAll` — but a seed script has no business dialling a
 * production database at all.
 */
export const main = Effect.gen(function* () {
  const url = yield* DatabaseUrl
  const host = yield* requireLocalHost(Redacted.value(url))
  yield* Effect.log(`seeding ${host}`)
  yield* program.pipe(Effect.provide(Services))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  Effect.runPromise(main.pipe(Effect.scoped)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
