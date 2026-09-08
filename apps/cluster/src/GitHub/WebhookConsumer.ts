import type { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookEnvelopeV1,
  type GitHubWebhookR2ObjectKey,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import {
  GitHubWebhookDeadLetterV1,
  type GitHubWebhookJournalSequence,
} from "@janitor/domain/GitHub/WebhookJournal"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import type * as Cloudflare from "alchemy/Cloudflare"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { WorkflowDispatcher } from "../WorkflowDispatcher.ts"
import { projectGitHubWebhookRequest } from "./ProjectWebhookRequest.ts"
import { GitHubWebhookJournal } from "./WebhookJournal.ts"

export class PayloadReadError extends Data.TaggedError("PayloadReadError")<{
  readonly key: GitHubWebhookR2ObjectKey
  readonly cause: unknown
}> {}

/**
 * Reads and removes overflow payloads that ingress stored in R2.
 *
 * @effect-expect-leaking RuntimeContext
 */
export class GitHubPayloadReader extends Context.Service<
  GitHubPayloadReader,
  {
    readonly get: (
      key: GitHubWebhookR2ObjectKey,
    ) => Effect.Effect<Option.Option<Uint8Array>, PayloadReadError, RuntimeContext>
    readonly delete: (
      key: GitHubWebhookR2ObjectKey,
    ) => Effect.Effect<void, PayloadReadError, RuntimeContext>
  }
>()("@janitor/cluster/GitHub/WebhookConsumer/GitHubPayloadReader") {
  static readonly fromBucket = (client: Cloudflare.R2.ReadWriteBucketClient) =>
    Layer.succeed(this, {
      get: Effect.fn("GitHubPayloadReader.get")(
        function* (key: GitHubWebhookR2ObjectKey) {
          const object = yield* client.get(key)
          if (object === null) {
            return Option.none()
          }
          return Option.some(yield* object.bytes())
        },
        (effect, key) => Effect.mapError(effect, (cause) => new PayloadReadError({ key, cause })),
      ),
      delete: Effect.fn("GitHubPayloadReader.delete")(function* (key: GitHubWebhookR2ObjectKey) {
        yield* client
          .delete(key)
          .pipe(Effect.mapError((cause) => new PayloadReadError({ key, cause })))
      }),
    })
}

export class DeadLetterError extends Data.TaggedError("DeadLetterError")<{
  readonly messageId: string
  readonly cause: unknown
}> {}

/**
 * Parks messages the consumer cannot journal, with content-safe diagnostics.
 *
 * @effect-expect-leaking RuntimeContext
 */
export class GitHubEventsDeadLetter extends Context.Service<
  GitHubEventsDeadLetter,
  {
    readonly send: (
      entry: GitHubWebhookDeadLetterV1,
    ) => Effect.Effect<void, DeadLetterError, RuntimeContext>
  }
>()("@janitor/cluster/GitHub/WebhookConsumer/GitHubEventsDeadLetter") {
  static readonly fromQueue = (queue: Cloudflare.Queues.WriteQueueClient) => {
    const encode = Schema.encodeEffect(GitHubWebhookDeadLetterV1)
    return Layer.succeed(this, {
      send: Effect.fn("GitHubEventsDeadLetter.send")(
        function* (entry: GitHubWebhookDeadLetterV1) {
          const body = yield* encode(entry)
          yield* queue.send(body, { contentType: "json" })
        },
        (effect, entry) =>
          Effect.mapError(
            effect,
            (cause) => new DeadLetterError({ messageId: entry.messageId, cause }),
          ),
      ),
    })
  }
}

/** The subset of a Cloudflare queue message the consumer relies on. */
export interface ConsumerMessage {
  readonly id: string
  readonly attempts: number
  readonly body: unknown
  ack(): void
  retry(): void
}

export type ConsumerOutcome =
  | {
      readonly _tag: "Journaled"
      readonly deliveryId: GitHubWebhookDeliveryId
      readonly sequence: GitHubWebhookJournalSequence
      readonly duplicate: boolean
    }
  | { readonly _tag: "DeadLettered"; readonly reason: string }
  | { readonly _tag: "Retried"; readonly reason: string }

const decodeEnvelope = Schema.decodeUnknownEffect(GitHubWebhookEnvelopeV1)

/**
 * Journals one queue message. Acknowledges only after the journal transaction
 * committed or reported a duplicate; retries on transient failures; parks
 * messages that can never succeed on the dead-letter queue.
 */
export const handleMessage = Effect.fn("GitHubWebhookConsumer.handleMessage")(function* (
  message: ConsumerMessage,
) {
  const journal = yield* GitHubWebhookJournal
  const reader = yield* GitHubPayloadReader
  const deadLetter = yield* GitHubEventsDeadLetter
  const dispatcher = yield* WorkflowDispatcher

  const retry = (reason: string, cause: unknown) =>
    Effect.logError("Retrying GitHub webhook message", cause).pipe(
      Effect.annotateLogs({ messageId: message.id, reason }),
      Effect.map((): ConsumerOutcome => {
        message.retry()
        return { _tag: "Retried", reason }
      }),
    )

  const park = Effect.fnUntraced(function* (reason: string) {
    const sent = yield* deadLetter
      .send({
        schemaVersion: 1,
        messageId: message.id,
        attempts: message.attempts,
        reason,
        body: message.body,
      })
      .pipe(Effect.result)
    if (Result.isFailure(sent)) {
      return yield* retry(`Dead-letter write failed after: ${reason}`, sent.failure)
    }
    yield* Effect.logWarning("Dead-lettered GitHub webhook message").pipe(
      Effect.annotateLogs({ messageId: message.id, reason }),
    )
    message.ack()
    const outcome: ConsumerOutcome = { _tag: "DeadLettered", reason }
    return outcome
  })

  const envelope = yield* decodeEnvelope(message.body).pipe(Effect.result)
  if (Result.isFailure(envelope)) {
    return yield* park("Message body is not a GitHubWebhookEnvelopeV1")
  }
  const { deliveryId, eventName, body } = envelope.success

  let payload: Uint8Array
  if (body._tag === "Inline") {
    payload = body.payload
  } else {
    const stored = yield* reader.get(body.key).pipe(Effect.result)
    if (Result.isFailure(stored)) {
      return yield* retry("Overflow payload read failed", stored.failure)
    }
    if (Option.isNone(stored.success)) {
      return yield* park(`Overflow payload ${body.key} is missing from R2`)
    }
    payload = stored.success.value
  }

  const receipt = yield* journal
    .record({
      deliveryId,
      eventName,
      receivedAt: envelope.success.receivedAt,
      payloadSha256: envelope.success.payloadSha256,
      encryption: envelope.success.encryption,
      payload,
    })
    .pipe(Effect.result)
  if (Result.isFailure(receipt)) {
    return yield* retry("Journal transaction failed", receipt.failure)
  }

  if (body._tag === "R2") {
    // Best effort: the bucket lifecycle rule removes anything this misses.
    yield* reader.delete(body.key).pipe(
      Effect.catchCause(
        Effect.fnUntraced(function* (cause) {
          yield* Effect.logWarning("Failed to delete journaled webhook payload", cause).pipe(
            Effect.annotateLogs({ id: deliveryId, key: body.key }),
          )
        }),
      ),
    )
  }

  message.ack()

  // Post-commit dispatch attempt. A miss here is recovered by the cron singleton.
  const request = projectGitHubWebhookRequest(deliveryId)
  yield* dispatcher
    .dispatchDue({
      limit: 1,
      only: { workflowTag: request.workflowTag, executionKey: request.executionKey },
    })
    .pipe(
      Effect.catchCause(
        Effect.fnUntraced(function* (cause) {
          yield* Effect.logWarning("Immediate projection dispatch failed", cause).pipe(
            Effect.annotateLogs({ id: deliveryId }),
          )
        }),
      ),
    )

  yield* Effect.logInfo("Journaled GitHub webhook delivery").pipe(
    Effect.annotateLogs({
      id: deliveryId,
      event: eventName,
      sequence: receipt.success.sequence,
      duplicate: receipt.success.duplicate,
    }),
  )
  const outcome: ConsumerOutcome = {
    _tag: "Journaled",
    deliveryId,
    sequence: receipt.success.sequence,
    duplicate: receipt.success.duplicate,
  }
  return outcome
})
