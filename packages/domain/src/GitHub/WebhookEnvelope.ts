import * as Schema from "effect/Schema"
import { GitHubWebhookDeliveryId } from "./Id.ts"

export const GitHubWebhookName = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubWebhookName"),
).annotate({ identifier: "GitHubWebhookName" })
export type GitHubWebhookName = typeof GitHubWebhookName.Type

export const GitHubWebhookPayloadSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
  .pipe(Schema.brand("GitHubWebhookPayloadSha256"))
  .annotate({ identifier: "GitHubWebhookPayloadSha256" })
export type GitHubWebhookPayloadSha256 = typeof GitHubWebhookPayloadSha256.Type

export const GitHubWebhookR2ObjectKey = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubWebhookR2ObjectKey"),
).annotate({ identifier: "GitHubWebhookR2ObjectKey" })
export type GitHubWebhookR2ObjectKey = typeof GitHubWebhookR2ObjectKey.Type

export const GitHubWebhookBodyV1 = Schema.TaggedUnion({
  Inline: {
    payload: Schema.Uint8ArrayFromBase64,
    key: Schema.optionalKey(Schema.Never),
  },
  R2: {
    key: GitHubWebhookR2ObjectKey,
    payload: Schema.optionalKey(Schema.Never),
  },
}).annotate({ identifier: "GitHubWebhookBodyV1" })
export type GitHubWebhookBodyV1 = typeof GitHubWebhookBodyV1.Type

export const GitHubWebhookEncryptionKeyId = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubWebhookEncryptionKeyId"),
).annotate({ identifier: "GitHubWebhookEncryptionKeyId" })
export type GitHubWebhookEncryptionKeyId = typeof GitHubWebhookEncryptionKeyId.Type

/**
 * Describes how the body bytes were encrypted. The inline payload and the R2
 * object both hold ciphertext; `payloadSha256` on the envelope is the digest
 * of the plaintext.
 */
export const GitHubWebhookEncryptionV1 = Schema.Struct({
  algorithm: Schema.Literal("AES-256-GCM"),
  keyId: GitHubWebhookEncryptionKeyId,
  iv: Schema.Uint8ArrayFromBase64,
}).annotate({ identifier: "GitHubWebhookEncryptionV1" })
export type GitHubWebhookEncryptionV1 = typeof GitHubWebhookEncryptionV1.Type

export const GitHubWebhookEnvelopeV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  deliveryId: GitHubWebhookDeliveryId,
  eventName: GitHubWebhookName,
  receivedAt: Schema.DateTimeUtcFromString,
  payloadSha256: GitHubWebhookPayloadSha256,
  encryption: GitHubWebhookEncryptionV1,
  body: GitHubWebhookBodyV1,
}).annotate({ identifier: "GitHubWebhookEnvelopeV1" })
export type GitHubWebhookEnvelopeV1 = typeof GitHubWebhookEnvelopeV1.Type
