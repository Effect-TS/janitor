import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  GitHubAccountDatabaseId,
  GitHubCommitSha,
  GitHubEntityNodeId,
  GitHubInstallationId,
  GitHubIssueDatabaseId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseId,
} from "@janitor/domain/GitHub/Id"
import type { GitHubInstallationSummary } from "@janitor/domain/GitHub/Installation"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import type { PullRequest } from "@janitor/domain/GitHub/WebhookEvent/PullRequest"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const ReadModelLayer = GitHubReadModel.layer.pipe(Layer.provideMerge(MigratedPostgresLayer))

const seq = (n: number) => GitHubWebhookJournalSequence.make(String(n))
const installationId = GitHubInstallationId.make("789")
const repositoryId = GitHubRepositoryDatabaseId.make("456")

const installation: GitHubInstallationSummary = {
  id: installationId,
  account: { id: GitHubAccountDatabaseId.make("1"), login: "effect", type: "Organization" },
  repositorySelection: "selected",
  htmlUrl: "https://github.com/settings/installations/789",
  suspendedAt: null,
}

// Pull request tests use a repository the inventory tests never touch, so
// privacy stays unknown there.
const prRepositoryId = GitHubRepositoryDatabaseId.make("457")
const repository = {
  id: prRepositoryId,
  nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitorPr"),
  fullName: { owner: "effect", repo: "janitor-pr" },
}

const label = (id: string, name: string) => ({
  id: GitHubLabelDatabaseId.make(id),
  nodeId: GitHubLabelNodeId.make(`LA_${id}`),
  name,
})

const pullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  id: GitHubPullRequestDatabaseId.make("123"),
  number: 42,
  nodeId: GitHubPullRequestNodeId.make("PR_kwDOExample"),
  title: "Fix repository cleanup",
  body: null,
  state: "open",
  draft: false,
  merged: false,
  updatedAt: DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"),
  labels: [label("1", "bug")],
  user: { id: GitHubUserDatabaseId.make("102"), login: "octocat" },
  head: { sha: GitHubCommitSha.make("a".repeat(40)) },
  base: { ref: "main" },
  ...overrides,
})

layer(ReadModelLayer, { timeout: "2 minutes" })("GitHubReadModel against Postgres", (it) => {
  it.effect("bulk pages preserve newer rows and labels and roll back atomically", () =>
    Effect.gen(function* () {
      const readModel = yield* GitHubReadModel
      const sql = yield* SqlClient.SqlClient
      const id = GitHubRepositoryDatabaseId.make("999")
      yield* readModel.applyInstallation({ installation, status: "active", sequence: seq(1) })
      yield* readModel.applyRepositories({
        installationId,
        repositories: [{ id, fullName: { owner: "batch", repo: "test" }, isPrivate: false }],
        sequence: seq(1),
      })
      const issues = Array.from({ length: 100 }, (_, index) => ({
        id: GitHubIssueDatabaseId.make(String(10000 + index)),
        nodeId: GitHubEntityNodeId.make(`I_batch_${index}`),
        number: index + 1,
        title: `Issue ${index}`,
        body: null,
        state: "open" as const,
        user: null,
        labels: [label("1000", "batch")],
        updatedAt: DateTime.makeUnsafe("2026-09-05T12:00:00Z"),
      }))
      yield* readModel.applyIssues({ repositoryId: id, issues, sequence: seq(2) })
      assert.strictEqual(
        (yield* sql<{
          count: string
        }>`SELECT count(*)::text AS count FROM github_entity WHERE repository_id=${id}`)[0]!.count,
        "100",
      )
      yield* readModel.applyIssues({
        repositoryId: id,
        issues: issues.map((issue) => ({ ...issue, title: "stale", labels: [] })),
        sequence: seq(1),
      })
      const retained = Option.getOrThrow(yield* readModel.getEntity(id, 1))
      assert.strictEqual(retained.entity.title, "Issue 0")
      assert.strictEqual(retained.labels.length, 1)
      yield* readModel.applyIssues({
        repositoryId: id,
        issues: [{ ...issues[0]!, labels: [] }],
        sequence: seq(3),
      })
      assert.strictEqual(Option.getOrThrow(yield* readModel.getEntity(id, 1)).labels.length, 0)
      assert.strictEqual(Option.getOrThrow(yield* readModel.getEntity(id, 2)).labels.length, 1)
      yield* Effect.flip(
        readModel.withTransaction(
          readModel
            .applyIssues({
              repositoryId: id,
              issues: issues.map((issue) => ({ ...issue, title: "rollback" })),
              sequence: seq(4),
            })
            .pipe(Effect.andThen(Effect.fail("rollback"))),
        ),
      )
      assert.strictEqual(
        Option.getOrThrow(yield* readModel.getEntity(id, 2)).entity.title,
        "Issue 1",
      )
      const pull = {
        ...pullRequest({
          number: 101,
          id: GitHubPullRequestDatabaseId.make("19999"),
          nodeId: GitHubPullRequestNodeId.make("PR_batch"),
          updatedAt: issues[0]!.updatedAt,
        }),
        mergedAt: null,
        labels: [label("1", "bug")],
        user: { id: GitHubUserDatabaseId.make("102"), login: "octocat" },
      }
      assert.deepStrictEqual(
        yield* readModel.applyPullRequests({ repositoryId: id, pulls: [pull], sequence: seq(5) }),
        [],
      )
      const bootstrapped = Option.getOrThrow(yield* readModel.getEntity(id, 101))
      assert.isNull(bootstrapped.entity.issueId)
      assert.strictEqual(bootstrapped.labels.length, 1)
      assert.strictEqual(Option.getOrThrow(bootstrapped.pullRequest).pullRequestId, "19999")
      yield* readModel.applyIssue({
        repositoryId: id,
        issue: {
          ...issues[0]!,
          id: GitHubIssueDatabaseId.make("29999"),
          nodeId: GitHubEntityNodeId.make("I_canonical"),
          number: 101,
          pullRequest: { url: "https://api.github.com/repos/batch/test/pulls/101" },
        },
        sequence: seq(6),
      })
      assert.strictEqual(
        Option.getOrThrow(yield* readModel.getEntity(id, 101)).entity.issueId,
        "29999",
      )
      yield* readModel.applyPullRequests({
        repositoryId: id,
        pulls: [{ ...pull, base: { ref: "stale" } }],
        sequence: seq(4),
      })
      assert.strictEqual(
        Option.getOrThrow(Option.getOrThrow(yield* readModel.getEntity(id, 101)).pullRequest)
          .baseRef,
        "main",
      )
    }),
  )
  it.effect("applies installations and repositories with a sequence fence", () =>
    Effect.gen(function* () {
      const readModel = yield* GitHubReadModel
      const repositories = [
        { id: repositoryId, fullName: { owner: "effect", repo: "janitor" }, isPrivate: true },
      ]

      yield* readModel.applyInstallation({ installation, status: "active", sequence: seq(5) })
      yield* readModel.applyRepositories({ installationId, repositories, sequence: seq(5) })
      // An older observation must not overwrite.
      yield* readModel.applyInstallation({ installation, status: "suspended", sequence: seq(4) })
      yield* readModel.applyRepositories({
        installationId,
        repositories: [{ ...repositories[0]!, fullName: { owner: "old", repo: "name" } }],
        sequence: seq(3),
      })

      const stored = yield* readModel.getInstallation(installationId)
      const repo = yield* readModel.getRepository(repositoryId)
      assert.strictEqual(Option.getOrThrow(stored).status, "active")
      assert.strictEqual(Option.getOrThrow(stored).accountHandle, "effect")
      assert.strictEqual(Option.getOrThrow(repo).repo, "janitor")
      assert.strictEqual(Option.getOrThrow(repo).isPrivate, true)
      assert.strictEqual(Option.getOrThrow(repo).access, "accessible")

      yield* readModel.markRepositoriesLost({ installationId, repositories, sequence: seq(6) })
      const lost = yield* readModel.getRepository(repositoryId)
      assert.strictEqual(Option.getOrThrow(lost).access, "lost")
      assert.strictEqual(Option.getOrThrow(lost).repo, "janitor")
    }),
  )

  it.effect("projects a pull request with its details and labels", () =>
    Effect.gen(function* () {
      const readModel = yield* GitHubReadModel

      const result = yield* readModel.applyPullRequest({
        installationId,
        repository,
        pullRequest: pullRequest(),
        sequence: seq(10),
      })

      assert.deepStrictEqual(result, { _tag: "Applied" })
      const stored = Option.getOrThrow(yield* readModel.getEntity(prRepositoryId, 42))
      assert.strictEqual(stored.entity.kind, "pull_request")
      assert.strictEqual(stored.entity.title, "Fix repository cleanup")
      assert.strictEqual(stored.entity.authorId, "102")
      assert.strictEqual(Option.getOrThrow(stored.pullRequest).baseRef, "main")
      assert.deepStrictEqual(
        stored.labels.map((entityLabel) => entityLabel.labelId),
        ["1"],
      )
      const labels = yield* readModel.listLabels(prRepositoryId)
      assert.deepStrictEqual(
        labels.map((stored) => [stored.labelId, stored.name, stored.availability]),
        [["1", "bug", "available"]],
      )
      const repo = Option.getOrThrow(yield* readModel.getRepository(prRepositoryId))
      assert.strictEqual(repo.isPrivate, null)
    }),
  )

  it.effect(
    "rejects an observation older than GitHub's update clock and replaces labels on newer ones",
    () =>
      Effect.gen(function* () {
        const readModel = yield* GitHubReadModel
        const base = pullRequest({
          number: 43,
          id: GitHubPullRequestDatabaseId.make("124"),
          nodeId: GitHubPullRequestNodeId.make("PR_kwDOExample43"),
        })

        yield* readModel.applyPullRequest({
          installationId,
          repository,
          pullRequest: base,
          sequence: seq(20),
        })

        const stale = yield* readModel.applyPullRequest({
          installationId,
          repository,
          pullRequest: {
            ...base,
            title: "Older",
            updatedAt: DateTime.makeUnsafe("2026-09-02T11:00:00.000Z"),
            labels: [],
          },
          sequence: seq(21),
        })
        assert.deepStrictEqual(stale, { _tag: "Stale" })
        let stored = Option.getOrThrow(yield* readModel.getEntity(prRepositoryId, 43))
        assert.strictEqual(stored.entity.title, "Fix repository cleanup")
        assert.strictEqual(stored.labels.length, 1)

        const sameClockOlderSequence = yield* readModel.applyPullRequest({
          installationId,
          repository,
          pullRequest: { ...base, title: "Replayed" },
          sequence: seq(19),
        })
        assert.deepStrictEqual(sameClockOlderSequence, { _tag: "Stale" })

        const newer = yield* readModel.applyPullRequest({
          installationId,
          repository,
          pullRequest: {
            ...base,
            title: "Newer",
            state: "closed",
            merged: true,
            updatedAt: DateTime.makeUnsafe("2026-09-02T13:00:00.000Z"),
            labels: [label("2", "enhancement"), label("3", "docs")],
          },
          sequence: seq(22),
        })
        assert.deepStrictEqual(newer, { _tag: "Applied" })
        stored = Option.getOrThrow(yield* readModel.getEntity(prRepositoryId, 43))
        assert.strictEqual(stored.entity.title, "Newer")
        assert.strictEqual(stored.entity.state, "closed")
        assert.strictEqual(Option.getOrThrow(stored.pullRequest).merged, true)
        assert.deepStrictEqual(
          stored.labels.map((entityLabel) => entityLabel.labelId),
          ["2", "3"],
        )
      }),
  )

  it.effect("applies a label catalog scan and marks unlisted labels suspect", () =>
    Effect.gen(function* () {
      const readModel = yield* GitHubReadModel
      const scanRepo = GitHubRepositoryDatabaseId.make("458")
      const apiLabel = (id: string, name: string) => ({
        id: GitHubLabelDatabaseId.make(id),
        nodeId: GitHubLabelNodeId.make(`LA_${id}`),
        name,
      })

      yield* readModel.applyLabelCatalog({
        repositoryId: scanRepo,
        labels: [{ ...apiLabel("10", "bug"), color: "d73a4a" }, apiLabel("11", "docs")],
        sequence: seq(30),
      })
      yield* readModel.applyLabelCatalog({
        repositoryId: scanRepo,
        labels: [apiLabel("10", "bug-renamed")],
        sequence: seq(31),
      })

      const labels = yield* readModel.listLabels(scanRepo)
      assert.strictEqual(labels.find((label) => label.labelId === "10")?.color, "d73a4a")
      yield* readModel.applyLabelCatalog({
        repositoryId: scanRepo,
        labels: [{ ...apiLabel("10", "bug-renamed"), color: "0052cc" }],
        sequence: seq(32),
      })
      assert.strictEqual(
        (yield* readModel.listLabels(scanRepo)).find((label) => label.labelId === "10")?.color,
        "0052cc",
      )
      assert.deepStrictEqual(
        labels.map((stored) => [stored.labelId, stored.name, stored.availability]),
        [
          ["10", "bug-renamed", "available"],
          ["11", "docs", "suspect"],
        ],
      )
    }),
  )

  it.effect("applies issues from a scan and binds pull request details", () =>
    Effect.gen(function* () {
      const readModel = yield* GitHubReadModel
      const scanRepo = GitHubRepositoryDatabaseId.make("459")

      const applied = yield* readModel.applyIssue({
        repositoryId: scanRepo,
        sequence: seq(40),
        issue: {
          id: GitHubIssueDatabaseId.make("9001"),
          nodeId: GitHubEntityNodeId.make("I_9001"),
          number: 7,
          title: "Scanned PR",
          body: "body",
          state: "open",
          user: { id: GitHubUserDatabaseId.make("5"), login: "octocat" },
          labels: [
            {
              id: GitHubLabelDatabaseId.make("20"),
              nodeId: GitHubLabelNodeId.make("LA_20"),
              name: "x",
            },
          ],
          updatedAt: DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"),
          pullRequest: { url: "https://api.github.com/repos/x/y/pulls/7" },
        },
      })
      assert.deepStrictEqual(applied, { _tag: "Applied" })

      const unknown = yield* readModel.applyPullRequestDetails({
        repositoryId: scanRepo,
        sequence: seq(40),
        pullRequest: {
          id: GitHubPullRequestDatabaseId.make("7099"),
          nodeId: GitHubPullRequestNodeId.make("PR_7099"),
          number: 99,
          state: "open",
          draft: false,
          mergedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"),
          head: { sha: GitHubCommitSha.make("c".repeat(40)) },
          base: { ref: "main" },
        },
      })
      assert.deepStrictEqual(unknown, { _tag: "Missing" })

      const detailsApplied = yield* readModel.applyPullRequestDetails({
        repositoryId: scanRepo,
        sequence: seq(40),
        pullRequest: {
          id: GitHubPullRequestDatabaseId.make("7007"),
          nodeId: GitHubPullRequestNodeId.make("PR_7007"),
          number: 7,
          state: "open",
          draft: true,
          mergedAt: null,
          updatedAt: DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"),
          head: { sha: GitHubCommitSha.make("b".repeat(40)) },
          base: { ref: "develop" },
        },
      })
      assert.deepStrictEqual(detailsApplied, { _tag: "Applied" })

      const stored = Option.getOrThrow(yield* readModel.getEntity(scanRepo, 7))
      assert.strictEqual(stored.entity.kind, "pull_request")
      assert.strictEqual(stored.entity.issueId, "9001")
      assert.strictEqual(stored.entity.issueNodeId, "I_9001")
      assert.deepStrictEqual(
        stored.labels.map((entityLabel) => entityLabel.labelId),
        ["20"],
      )
      const details = Option.getOrThrow(stored.pullRequest)
      assert.strictEqual(details.baseRef, "develop")
      assert.isTrue(details.draft)
      assert.isFalse(details.merged)
    }),
  )
  it.effect("inventory repairs a rename and suspect access without a new webhook", () =>
    Effect.gen(function* () {
      const readModel = yield* GitHubReadModel
      const id = GitHubRepositoryDatabaseId.make("901")
      yield* readModel.applyRepositories({
        installationId,
        repositories: [{ id, fullName: { owner: "old", repo: "name" }, isPrivate: true }],
        sequence: seq(100),
      })
      yield* readModel.markRepositoriesSuspect({ installationId, present: [], sequence: seq(100) })
      yield* readModel.applyRepositories({
        installationId,
        repositories: [{ id, fullName: { owner: "new", repo: "renamed" }, isPrivate: true }],
        sequence: seq(100),
        authoritative: true,
      })
      const recovered = Option.getOrThrow(yield* readModel.getRepository(id))
      assert.strictEqual(recovered.access, "accessible")
      assert.strictEqual(recovered.owner, "new")
      yield* readModel.markRepositoriesLost({
        installationId,
        repositories: [{ id, fullName: { owner: "new", repo: "renamed" }, isPrivate: true }],
        sequence: seq(101),
      })
      yield* readModel.applyRepositories({
        installationId,
        repositories: [{ id, fullName: { owner: "old", repo: "name" }, isPrivate: true }],
        sequence: seq(100),
        authoritative: true,
      })
      assert.strictEqual(Option.getOrThrow(yield* readModel.getRepository(id)).access, "lost")
    }),
  )
})
