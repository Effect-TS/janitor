import type { GitHubInstallationId, GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookEncryptionV1,
  GitHubWebhookName,
  type GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import {
  GitHubWebhookJournalSequence,
  GitHubWebhookJournalSequenceFromStringOrNumber,
  GitHubWebhookProjectionStatus,
} from "@janitor/domain/GitHub/WebhookJournal"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { projectGitHubWebhookRequest } from "./ProjectWebhookRequest.ts"

export class GitHubWebhookJournalError extends Schema.TaggedError<GitHubWebhookJournalError>()(
  "@janitor/cluster/GitHub/WebhookJournal/GitHubWebhookJournalError",
  {
    deliveryId: Schema.String,
    message: Schema.String,
  },
) {}

export interface GitHubWebhookJournalEntry {
  readonly deliveryId: GitHubWebhookDeliveryId
  readonly eventName: GitHubWebhookName
  readonly receivedAt: DateTime.Utc
  readonly payloadSha256: GitHubWebhookPayloadSha256
  readonly encryption: GitHubWebhookEncryptionV1
  /** Ciphertext. The journal never holds plaintext. */
  readonly payload: Uint8Array
}

export interface GitHubWebhookJournalReceipt {
  readonly sequence: GitHubWebhookJournalSequence
  /** True when the delivery ID was already journaled by an earlier attempt. */
  readonly duplicate: boolean
}

const Uint8ArrayFromBytea = Schema.instanceOf(Uint8Array)

export const GitHubWebhookJournaledDelivery = Schema.Struct({
  deliveryId: Schema.String,
  sequence: GitHubWebhookJournalSequence,
  eventName: GitHubWebhookName,
  encryption: Schema.Struct({
    algorithm: GitHubWebhookEncryptionV1.fields.algorithm,
    keyId: GitHubWebhookEncryptionV1.fields.keyId,
    iv: Uint8ArrayFromBytea,
  }),
  payload: Uint8ArrayFromBytea,
  projectionStatus: GitHubWebhookProjectionStatus,
})
export type GitHubWebhookJournaledDelivery = typeof GitHubWebhookJournaledDelivery.Type

/**
 * Durable record of every accepted webhook delivery. Delivery ID uniqueness
 * makes recording idempotent, so a lost acknowledgement retries safely.
 */
export class GitHubWebhookJournal extends Context.Service<
  GitHubWebhookJournal,
  {
    readonly record: (
      entry: GitHubWebhookJournalEntry,
    ) => Effect.Effect<GitHubWebhookJournalReceipt, GitHubWebhookJournalError>
    readonly load: (
      deliveryId: GitHubWebhookDeliveryId,
    ) => Effect.Effect<Option.Option<GitHubWebhookJournaledDelivery>, GitHubWebhookJournalError>
    /** Records the outcome and, when known, the installation the delivery belongs to for retention. */
    readonly markProjection: (
      deliveryId: GitHubWebhookDeliveryId,
      status: Exclude<GitHubWebhookProjectionStatus, "pending">,
      error: Option.Option<string>,
      installationId?: Option.Option<GitHubInstallationId>,
    ) => Effect.Effect<void, GitHubWebhookJournalError>
  }
>()("@janitor/cluster/GitHub/WebhookJournal/GitHubWebhookJournal", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const outbox = yield* WorkflowOutbox

    const SequenceRow = Schema.Struct({ sequence: GitHubWebhookJournalSequenceFromStringOrNumber })
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SequenceRow))

    const record = Effect.fn("GitHubWebhookJournal.record")(function* (
      entry: GitHubWebhookJournalEntry,
    ) {
      const row = {
        delivery_id: entry.deliveryId,
        event_name: entry.eventName,
        received_at: DateTime.toDateUtc(entry.receivedAt),
        payload_sha256: entry.payloadSha256,
        encryption_algorithm: entry.encryption.algorithm,
        encryption_key_id: entry.encryption.keyId,
        encryption_iv: entry.encryption.iv,
        payload: entry.payload,
      }

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const inserted = yield* sql`
              INSERT INTO github_webhook_delivery ${sql.insert(row)}
              ON CONFLICT (delivery_id) DO NOTHING
              RETURNING sequence
            `.pipe(Effect.flatMap(decodeRows))

            // Same transaction as the journal row, so a committed delivery
            // always has a projection request. Idempotent on duplicates.
            yield* outbox.enqueue(projectGitHubWebhookRequest(entry.deliveryId))

            const first = inserted[0]
            if (first !== undefined) {
              return { sequence: first.sequence, duplicate: false }
            }

            const existing = yield* sql`
              SELECT sequence FROM github_webhook_delivery
              WHERE delivery_id = ${entry.deliveryId}
            `.pipe(Effect.flatMap(decodeRows))

            const found = existing[0]
            if (found === undefined) {
              return yield* new GitHubWebhookJournalError({
                deliveryId: entry.deliveryId,
                message: "Delivery conflicted on insert but could not be read back",
              })
            }
            return { sequence: found.sequence, duplicate: true }
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (error) =>
              new GitHubWebhookJournalError({
                deliveryId: entry.deliveryId,
                message: error.message,
              }),
            SchemaError: (error) =>
              new GitHubWebhookJournalError({
                deliveryId: entry.deliveryId,
                message: `Journal returned an invalid sequence: ${error.message}`,
              }),
            "@janitor/cluster/WorkflowOutbox/WorkflowOutboxError": (error) =>
              new GitHubWebhookJournalError({
                deliveryId: entry.deliveryId,
                message: `Outbox request failed: ${error.message}`,
              }),
          }),
        )
    })

    const DeliveryRow = Schema.Struct({
      delivery_id: Schema.String,
      sequence: GitHubWebhookJournalSequenceFromStringOrNumber,
      event_name: GitHubWebhookName,
      encryption_algorithm: GitHubWebhookEncryptionV1.fields.algorithm,
      encryption_key_id: GitHubWebhookEncryptionV1.fields.keyId,
      encryption_iv: Uint8ArrayFromBytea,
      payload: Uint8ArrayFromBytea,
      projection_status: GitHubWebhookProjectionStatus,
    })
    const decodeDeliveryRows = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow))

    const load = Effect.fn("GitHubWebhookJournal.load")(function* (
      deliveryId: GitHubWebhookDeliveryId,
    ) {
      const rows = yield* sql`
        SELECT delivery_id, sequence, event_name, encryption_algorithm, encryption_key_id,
               encryption_iv, payload, projection_status
        FROM github_webhook_delivery
        WHERE delivery_id = ${deliveryId}
      `.pipe(
        Effect.flatMap(decodeDeliveryRows),
        Effect.catchTags({
          SqlError: (error) =>
            new GitHubWebhookJournalError({ deliveryId, message: error.message }),
          SchemaError: (error) =>
            new GitHubWebhookJournalError({
              deliveryId,
              message: `Journal row is invalid: ${error.message}`,
            }),
        }),
      )
      const row = rows[0]
      if (row === undefined) {
        return Option.none()
      }
      return Option.some({
        deliveryId: row.delivery_id,
        sequence: row.sequence,
        eventName: row.event_name,
        encryption: {
          algorithm: row.encryption_algorithm,
          keyId: row.encryption_key_id,
          iv: row.encryption_iv,
        },
        payload: row.payload,
        projectionStatus: row.projection_status,
      })
    })

    const markProjection = Effect.fn("GitHubWebhookJournal.markProjection")(function* (
      deliveryId: GitHubWebhookDeliveryId,
      status: Exclude<GitHubWebhookProjectionStatus, "pending">,
      error: Option.Option<string>,
      installationId: Option.Option<GitHubInstallationId> = Option.none(),
    ) {
      yield* sql`
        UPDATE github_webhook_delivery
        SET projection_status = ${status},
            projection_error = ${Option.getOrNull(error)},
            installation_id = COALESCE(${Option.getOrNull(installationId)}, installation_id),
            projected_at = CLOCK_TIMESTAMP()
        WHERE delivery_id = ${deliveryId}
      `.pipe(
        Effect.mapError(
          (cause) => new GitHubWebhookJournalError({ deliveryId, message: cause.message }),
        ),
      )
    })

    return { record, load, markProjection }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
