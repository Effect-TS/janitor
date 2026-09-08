import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookEncryptionKeyId,
  GitHubWebhookEnvelopeV1,
  GitHubWebhookName,
  GitHubWebhookPayloadSha256,
  GitHubWebhookR2ObjectKey,
} from "@janitor/domain/GitHub/WebhookEnvelope"

const receivedAt = "2026-09-01T12:34:56.000Z"
const payloadSha256 = "a".repeat(64)
const iv = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
const encryption = {
  algorithm: "AES-256-GCM" as const,
  keyId: "key-1",
  iv: "AQIDBAUGBwgJCgsM",
}

describe("GitHubWebhookEnvelopeV1", () => {
  it.effect("round-trips exact inline payload bytes", () =>
    Effect.gen(function* () {
      const payload = Uint8Array.from([0, 13, 10, 0xff, 0xfe, 123, 125])
      const encoded = {
        schemaVersion: 1 as const,
        deliveryId: "delivery-inline",
        eventName: "future_custom_event",
        receivedAt,
        payloadSha256,
        encryption,
        body: {
          _tag: "Inline" as const,
          payload: "AA0K//57fQ==",
        },
      }

      const decoded = yield* Schema.decodeUnknownEffect(GitHubWebhookEnvelopeV1)(encoded)

      assert.deepStrictEqual(decoded, {
        schemaVersion: 1,
        deliveryId: GitHubWebhookDeliveryId.make("delivery-inline"),
        eventName: GitHubWebhookName.make("future_custom_event"),
        receivedAt: DateTime.makeUnsafe(receivedAt),
        payloadSha256: GitHubWebhookPayloadSha256.make(payloadSha256),
        encryption: {
          algorithm: "AES-256-GCM",
          keyId: GitHubWebhookEncryptionKeyId.make("key-1"),
          iv,
        },
        body: { _tag: "Inline", payload },
      })
      assert.deepStrictEqual(yield* Schema.encodeEffect(GitHubWebhookEnvelopeV1)(decoded), encoded)
    }),
  )

  it.effect("round-trips an R2 payload reference", () =>
    Effect.gen(function* () {
      const encoded = {
        schemaVersion: 1 as const,
        deliveryId: "delivery-r2",
        eventName: "pull_request",
        receivedAt,
        payloadSha256,
        encryption,
        body: {
          _tag: "R2" as const,
          key: "github-webhooks/delivery-r2",
        },
      }

      const decoded = yield* Schema.decodeUnknownEffect(GitHubWebhookEnvelopeV1)(encoded)

      assert.deepStrictEqual(decoded.body, {
        _tag: "R2",
        key: GitHubWebhookR2ObjectKey.make("github-webhooks/delivery-r2"),
      })
      assert.deepStrictEqual(yield* Schema.encodeEffect(GitHubWebhookEnvelopeV1)(decoded), encoded)
    }),
  )

  it.effect("rejects malformed envelopes", () =>
    Effect.gen(function* () {
      const valid = {
        schemaVersion: 1,
        deliveryId: "delivery-r2",
        eventName: "pull_request",
        receivedAt,
        payloadSha256,
        encryption,
        body: { _tag: "R2", key: "github-webhooks/delivery-r2" },
      }
      const malformed = [
        { ...valid, schemaVersion: 2 },
        { ...valid, encryption: undefined },
        { ...valid, encryption: { ...encryption, algorithm: "AES-128-GCM" } },
        { ...valid, encryption: { ...encryption, keyId: "" } },
        { ...valid, encryption: { ...encryption, iv: "not base64" } },
        { ...valid, deliveryId: "" },
        { ...valid, eventName: "" },
        { ...valid, receivedAt: "not-a-date" },
        { ...valid, payloadSha256: "A".repeat(64) },
        { ...valid, payloadSha256: "a".repeat(63) },
        { ...valid, body: { _tag: "Unknown" } },
        { ...valid, body: { _tag: "Inline", payload: "not base64" } },
        { ...valid, body: { _tag: "R2", key: "" } },
        null,
      ]

      for (const input of malformed) {
        const exit = yield* Schema.decodeUnknownEffect(GitHubWebhookEnvelopeV1)(input).pipe(
          Effect.exit,
        )
        assert.isTrue(Exit.isFailure(exit))
      }
    }),
  )

  it.effect("rejects fields from the other body variant", () =>
    Effect.gen(function* () {
      const input = {
        schemaVersion: 1,
        deliveryId: "delivery-inline",
        eventName: "pull_request",
        receivedAt,
        payloadSha256,
        encryption,
        body: {
          _tag: "Inline",
          payload: "e30=",
          key: "github-webhooks/delivery-inline",
        },
      }

      const exit = yield* Schema.decodeUnknownEffect(GitHubWebhookEnvelopeV1)(input).pipe(
        Effect.exit,
      )

      assert.isTrue(Exit.isFailure(exit))
    }),
  )
})
