import type { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookR2ObjectKey,
  type GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { retain } from "alchemy/RemovalPolicy"
import { deployment } from "../Deployment.ts"

// Must exceed Queue retention (4 days), the retry and dead-letter replay
// window, and a safety margin.
export const GITHUB_WEBHOOK_PAYLOAD_RETENTION_SECONDS = 14 * 24 * 60 * 60

const PAYLOAD_KEY_PREFIX = "github-webhooks/"

export class PayloadStoreError extends Data.TaggedError("PayloadStoreError")<{
  readonly key: GitHubWebhookR2ObjectKey
  readonly cause: unknown
}> {}

export interface PutPayloadInput {
  readonly deliveryId: GitHubWebhookDeliveryId
  readonly body: Uint8Array<ArrayBuffer>
  readonly sha256: GitHubWebhookPayloadSha256
}

/**
 * Writes and deletes GitHub webhook payloads that are too large to travel
 * inline in a Queue message.
 *
 * @effect-expect-leaking RuntimeContext
 */
export class GitHubPayloadStore extends Context.Service<
  GitHubPayloadStore,
  {
    readonly put: (
      input: PutPayloadInput,
    ) => Effect.Effect<GitHubWebhookR2ObjectKey, PayloadStoreError, RuntimeContext>
    readonly delete: (
      key: GitHubWebhookR2ObjectKey,
    ) => Effect.Effect<void, PayloadStoreError, RuntimeContext>
  }
>()("@janitor/cluster/GitHub/PayloadStore/GitHubPayloadStore") {}

export const payloadKey = (deliveryId: GitHubWebhookDeliveryId): GitHubWebhookR2ObjectKey =>
  GitHubWebhookR2ObjectKey.make(`${PAYLOAD_KEY_PREFIX}${deliveryId}`)

/** Encrypted overflow payloads referenced by queue envelopes. */
export const GitHubWebhookPayloadsBucket = Effect.gen(function* () {
  const target = yield* deployment
  return yield* Cloudflare.R2.Bucket("GitHubWebhookPayloads", {
    lifecycleRules: [
      {
        id: "expire-webhook-payloads",
        prefix: PAYLOAD_KEY_PREFIX,
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: GITHUB_WEBHOOK_PAYLOAD_RETENTION_SECONDS },
        },
      },
    ],
  }).pipe(retain(target.retain))
})

const make = Effect.gen(function* () {
  const bucket = yield* GitHubWebhookPayloadsBucket
  const client = yield* Cloudflare.R2.WriteBucket(bucket)

  const put = Effect.fn("GitHubPayloadStore.put")(function* ({
    deliveryId,
    body,
    sha256,
  }: PutPayloadInput) {
    const key = payloadKey(deliveryId)
    yield* client
      .put(key, body, { sha256, httpMetadata: { contentType: "application/json" } })
      .pipe(Effect.mapError((cause) => new PayloadStoreError({ key, cause })))
    return key
  })

  const del = Effect.fn("GitHubPayloadStore.delete")(function* (key: GitHubWebhookR2ObjectKey) {
    yield* client
      .delete(key)
      .pipe(Effect.mapError((cause) => new PayloadStoreError({ key, cause })))
  })

  return { put, delete: del }
})

export const layer = Layer.effect(GitHubPayloadStore, make)
