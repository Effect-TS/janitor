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
