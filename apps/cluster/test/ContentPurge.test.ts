import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  GitHubAccountDatabaseId,
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubLabelDatabaseId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseId,
  GitHubWebhookDeliveryId,
} from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookName,
  GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { GitHubEncryptionKeyIdFixture } from "./support/Fixtures.ts"
import { ContentPurge, CONTENT_PURGE_GRACE } from "../src/ContentPurge.ts"
import { GitHubReadModel } from "../src/GitHub/ReadModel.ts"
import { GitHubWebhookJournal } from "../src/GitHub/WebhookJournal.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const PurgeLayer = Layer.mergeAll(
  ContentPurge.layer,
  GitHubReadModel.layer,
  GitHubWebhookJournal.layer,
).pipe(Layer.provideMerge(WorkflowOutbox.layer), Layer.provideMerge(MigratedPostgresLayer))

const installationId = GitHubInstallationId.make("900")
const repositoryId = GitHubRepositoryDatabaseId.make("901")
const seq = GitHubWebhookJournalSequence.make("1")

layer(PurgeLayer, { timeout: "2 minutes" })("ContentPurge against Postgres", (it) => {
  it.effect("removes content but keeps identity after the grace period", () =>
    Effect.gen(function* () {
      const purge = yield* ContentPurge
      const readModel = yield* GitHubReadModel
      const journal = yield* GitHubWebhookJournal
      const sql = yield* SqlClient.SqlClient
      const now = yield* DateTime.now

      yield* readModel.applyInstallation({
        installation: {
          id: installationId,
          account: { id: GitHubAccountDatabaseId.make("1"), login: "effect", type: "Organization" },
          repositorySelection: "all",
          htmlUrl: "https://github.com/settings/installations/900",
          suspendedAt: null,
        },
        status: "active",
        sequence: seq,
      })
      yield* readModel.applyPullRequest({
        installationId,
        repository: {
          id: repositoryId,
          nodeId: GitHubRepositoryNodeId.make("R_901"),
          fullName: { owner: "effect", repo: "private" },
        },
        sequence: seq,
        pullRequest: {
          id: GitHubPullRequestDatabaseId.make("1"),
          number: 1,
          nodeId: GitHubPullRequestNodeId.make("PR_1"),
          title: "Secret title",
          body: "Secret body",
          state: "open",
          draft: false,
          merged: false,
          updatedAt: now,
          labels: [{ id: GitHubLabelDatabaseId.make("5"), name: "secret-label" }],
          user: { id: GitHubUserDatabaseId.make("5"), login: "octocat" },
          head: { sha: GitHubCommitSha.make("a".repeat(40)) },
          base: { ref: "main" },
        },
      })
      const deliveryId = GitHubWebhookDeliveryId.make("purge-delivery")
      yield* journal.record({
        deliveryId,
        eventName: GitHubWebhookName.make("pull_request"),
        receivedAt: now,
        payloadSha256: GitHubWebhookPayloadSha256.make("a".repeat(64)),
        encryption: {
          algorithm: "AES-256-GCM",
          keyId: GitHubEncryptionKeyIdFixture,
          iv: new Uint8Array(12),
        },
        payload: Uint8Array.from([1, 2, 3]),
      })
      yield* journal.markProjection(
        deliveryId,
        "projected",
        Option.none(),
        Option.some(installationId),
      )

      yield* purge.schedule({ _tag: "installation", installationId }, "installation-deleted")
      const early = yield* purge.runDue(now)
      assert.deepStrictEqual(early, { purged: 0 })

      const late = yield* purge.runDue(
        DateTime.addDuration(now, Duration.sum(CONTENT_PURGE_GRACE, Duration.minutes(1))),
      )
      assert.deepStrictEqual(late, { purged: 1 })

      const entity = Option.getOrThrow(yield* readModel.getEntity(repositoryId, 1))
      assert.strictEqual(entity.entity.title, "")
      assert.isNull(entity.entity.body)
      assert.strictEqual(entity.entity.number, 1)
      const labels = yield* readModel.listLabels(repositoryId)
      assert.deepStrictEqual(
        labels.map((label) => label.name),
        [""],
      )
      const deliveries = yield* sql<{
        payload: Uint8Array
        payload_sha256: string
        purged_at: Date | null
      }>`
        SELECT payload, payload_sha256, purged_at FROM github_webhook_delivery WHERE delivery_id = ${deliveryId}
      `
      assert.strictEqual(deliveries[0]?.payload.byteLength, 0)
      assert.strictEqual(deliveries[0]?.payload_sha256, "a".repeat(64))
      assert.isNotNull(deliveries[0]?.purged_at)
      const repo = Option.getOrThrow(yield* readModel.getRepository(repositoryId))
      assert.strictEqual(repo.repo, "private")
    }),
  )

  it.effect("cancel removes a pending purge before it runs", () =>
    Effect.gen(function* () {
      const purge = yield* ContentPurge
      const now = yield* DateTime.now
      const repo = GitHubRepositoryDatabaseId.make("902")

      yield* purge.schedule({ _tag: "repository", repositoryId: repo }, "repository-removed")
      yield* purge.cancel({ _tag: "repository", repositoryId: repo })

      yield* purge.runDue(DateTime.addDuration(now, Duration.days(30)))
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT subject_id FROM content_purge WHERE subject_id = ${"902"}`
      assert.deepStrictEqual(rows, [])
    }),
  )
})
