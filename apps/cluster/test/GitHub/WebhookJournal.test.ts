import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookEncryptionKeyId,
  GitHubWebhookName,
  GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import {
  GitHubWebhookJournal,
  type GitHubWebhookJournalEntry,
} from "../../src/GitHub/WebhookJournal.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { pruneWebhookPayloads } from "../../src/GitHub/PruneWebhookPayloads.ts"

const JournalLayer = GitHubWebhookJournal.layer.pipe(
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

const entry = (deliveryId: string): GitHubWebhookJournalEntry => ({
  deliveryId: GitHubWebhookDeliveryId.make(deliveryId),
  eventName: GitHubWebhookName.make("pull_request"),
  receivedAt: DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"),
  payloadSha256: GitHubWebhookPayloadSha256.make("a".repeat(64)),
  encryption: {
    algorithm: "AES-256-GCM",
    keyId: GitHubWebhookEncryptionKeyId.make("key-1"),
    iv: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  },
  payload: Uint8Array.from([0, 13, 10, 0xff, 0xfe, 123, 125]),
})

layer(JournalLayer, { timeout: "2 minutes" })("GitHubWebhookJournal against Postgres", (it) => {
  it.effect("prunes terminal payloads while preserving pending work and duplicate protection", () =>
    Effect.gen(function* () {
      const journal = yield* GitHubWebhookJournal
      const sql = yield* SqlClient.SqlClient
      const statuses = ["pending", "projected", "unsupported", "failed"] as const
      for (const status of statuses) {
        yield* journal.record(entry(`prune-${status}`))
        yield* sql`UPDATE github_webhook_delivery SET projection_status=${status},
          projection_error='retained detail' WHERE delivery_id=${`prune-${status}`}`
      }
      yield* pruneWebhookPayloads
      for (const status of statuses) {
        const [row] = yield* sql<{
          bytes: number
          purged: boolean
          projection_status: string
          projection_error: string
        }>`SELECT octet_length(payload) AS bytes, purged_at IS NOT NULL AS purged,
          projection_status, projection_error FROM github_webhook_delivery
          WHERE delivery_id=${`prune-${status}`}`
        assert.strictEqual(row!.bytes, status === "pending" ? entry("unused").payload.length : 0)
        assert.strictEqual(row!.purged, status !== "pending")
        assert.strictEqual(row!.projection_status, status)
        assert.strictEqual(row!.projection_error, "retained detail")
        assert.isTrue((yield* journal.record(entry(`prune-${status}`))).duplicate)
      }
      assert.strictEqual(yield* pruneWebhookPayloads, 0)
    }),
  )
  it.effect("bounds pruning batches and drains the remaining backlog on the next run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* pruneWebhookPayloads
      yield* sql`INSERT INTO github_webhook_delivery
        (delivery_id, event_name, received_at, payload_sha256, encryption_algorithm,
         encryption_key_id, encryption_iv, payload, projection_status)
        SELECT 'prune-batch-' || n, 'ping', CLOCK_TIMESTAMP(), repeat('a', 64),
          'AES-256-GCM', 'key-1', ''::bytea, 'payload'::bytea, 'projected'
        FROM generate_series(1, 1001) AS n`
      assert.strictEqual(yield* pruneWebhookPayloads, 1000)
      assert.strictEqual(yield* pruneWebhookPayloads, 1)
      assert.strictEqual(yield* pruneWebhookPayloads, 0)
    }),
  )

  it.effect("records a delivery with a monotonic sequence and pending status", () =>
    Effect.gen(function* () {
      const journal = yield* GitHubWebhookJournal
      const sql = yield* SqlClient.SqlClient

      const first = yield* journal.record(entry("pg-delivery-1"))
      const second = yield* journal.record(entry("pg-delivery-2"))

      assert.isFalse(first.duplicate)
      assert.isFalse(second.duplicate)
      assert.isTrue(BigInt(second.sequence) > BigInt(first.sequence))

      const rows = yield* sql<{
        projection_status: string
        payload: Uint8Array
        encryption_iv: Uint8Array
        encryption_key_id: string
      }>`
        SELECT projection_status, payload, encryption_iv, encryption_key_id
        FROM github_webhook_delivery WHERE delivery_id = ${"pg-delivery-1"}
      `
      const row = rows[0]
      assert.isDefined(row)
      if (row === undefined) return
      assert.strictEqual(row.projection_status, "pending")

      const outbox = yield* sql<{ workflow_tag: string; payload: { deliveryId: string } }>`
        SELECT workflow_tag, payload FROM workflow_outbox WHERE execution_key = ${"pg-delivery-1"}
      `
      assert.deepStrictEqual(outbox, [
        {
          workflow_tag: "Janitor/ProjectGitHubWebhookV1",
          payload: { deliveryId: "pg-delivery-1" },
        },
      ])
      assert.strictEqual(row.encryption_key_id, "key-1")
      assert.deepStrictEqual(
        Uint8Array.from(row.payload),
        Uint8Array.from([0, 13, 10, 0xff, 0xfe, 123, 125]),
      )
      assert.deepStrictEqual(
        Uint8Array.from(row.encryption_iv),
        Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      )
    }),
  )

  it.effect("returns the original sequence for a duplicate delivery id", () =>
    Effect.gen(function* () {
      const journal = yield* GitHubWebhookJournal
      const sql = yield* SqlClient.SqlClient

      const first = yield* journal.record(entry("pg-delivery-dup"))
      const again = yield* journal.record({
        ...entry("pg-delivery-dup"),
        payload: Uint8Array.from([9]),
      })

      assert.isFalse(first.duplicate)
      assert.isTrue(again.duplicate)
      assert.strictEqual(again.sequence, first.sequence)

      const rows = yield* sql<{ payload: Uint8Array }>`
        SELECT payload FROM github_webhook_delivery WHERE delivery_id = ${"pg-delivery-dup"}
      `
      assert.strictEqual(rows.length, 1)
      assert.deepStrictEqual(
        Uint8Array.from(rows[0]?.payload ?? []),
        Uint8Array.from([0, 13, 10, 0xff, 0xfe, 123, 125]),
      )
    }),
  )

  it.effect("rejects a malformed digest at the database boundary", () =>
    Effect.gen(function* () {
      const journal = yield* GitHubWebhookJournal

      const exit = yield* journal
        .record({
          ...entry("pg-delivery-bad"),
          payloadSha256: GitHubWebhookPayloadSha256.make("A".repeat(64), { disableChecks: true }),
        })
        .pipe(Effect.exit)

      assert.isTrue(exit._tag === "Failure")
    }),
  )
})
