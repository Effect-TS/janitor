import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
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
        labels: [apiLabel("10", "bug"), apiLabel("11", "docs")],
        sequence: seq(30),
      })
      yield* readModel.applyLabelCatalog({
        repositoryId: scanRepo,
        labels: [apiLabel("10", "bug-renamed")],
        sequence: seq(31),
      })

      const labels = yield* readModel.listLabels(scanRepo)
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
