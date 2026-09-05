/** Disposable local Postgres benchmark. Never connects to production. */
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Tracer from "effect/Tracer"
import { GitHubReadModel } from "../src/GitHub/ReadModel.ts"
import { MigratedPostgresLayer } from "../test/support/Postgres.ts"
import {
  GitHubAccountDatabaseId,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
  GitHubIssueDatabaseId,
  GitHubEntityNodeId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"

const program = Effect.gen(function* () {
  const model = yield* GitHubReadModel
  const installationId = GitHubInstallationId.make("1")
  const sequence = GitHubWebhookJournalSequence.make("1")
  yield* model.applyInstallation({
    installation: {
      id: installationId,
      account: { id: GitHubAccountDatabaseId.make("1"), login: "benchmark", type: "Organization" },
      repositorySelection: "all",
      htmlUrl: "https://github.com/apps/benchmark",
      suspendedAt: null,
    },
    status: "active",
    sequence,
  })
  for (const count of [100, 1000, 10000]) {
    const issues = Array.from({ length: count }, (_, i) => ({
      id: GitHubIssueDatabaseId.make(String(i + 1)),
      nodeId: GitHubEntityNodeId.make(`I_${i}`),
      number: i + 1,
      title: `Benchmark issue ${i}`,
      body: "A representative issue body. ".repeat(40),
      state: "open" as const,
      user: null,
      updatedAt: DateTime.makeUnsafe("2026-09-05T12:00:00Z"),
      labels: [1, 2, 3].map((n) => ({
        id: GitHubLabelDatabaseId.make(String(n)),
        nodeId: GitHubLabelNodeId.make(`L_${n}`),
        name: `label-${n}`,
      })),
    }))
    for (const mode of ["single", "batch"] as const) {
      const repositoryId = GitHubRepositoryDatabaseId.make(
        String(count * 10 + (mode === "single" ? 1 : 2)),
      )
      const observations = issues.map((issue, i) => ({
        ...issue,
        id: GitHubIssueDatabaseId.make(String(Number(repositoryId) * 100000 + i)),
        nodeId: GitHubEntityNodeId.make(`I_${repositoryId}_${i}`),
      }))
      yield* model.applyRepositories({
        installationId,
        sequence,
        repositories: [
          {
            id: repositoryId,
            fullName: { owner: "benchmark", repo: `${count}-${mode}` },
            isPrivate: false,
          },
        ],
      })
      let statements = 0
      const tracer = Tracer.make({
        span(options) {
          if (options.name === "sql.execute") statements++
          return new Tracer.NativeSpan(options)
        },
      })
      const [duration] = yield* Effect.gen(function* () {
        // Same per-page transaction boundary in both modes; only projection batching differs.
        for (let offset = 0; offset < count; offset += 100) {
          const page = observations.slice(offset, offset + 100)
          yield* model.withTransaction(
            mode === "single"
              ? Effect.forEach(
                  page,
                  (issue) => model.applyIssue({ repositoryId, issue, sequence }),
                  { discard: true },
                )
              : model.applyIssues({ repositoryId, issues: page, sequence }),
          )
        }
      }).pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.timed)
      yield* Effect.logInfo("Sync projection benchmark", { count, mode, duration, statements })
    }
  }
})
Effect.runPromise(
  program.pipe(
    Effect.provide(GitHubReadModel.layer.pipe(Layer.provide(MigratedPostgresLayer))),
    Effect.scoped,
    Effect.tapCause((cause) => Effect.logError("Benchmark failed", cause)),
  ),
).catch(() => {
  process.exitCode = 1
})
