import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEncryptionKeyId } from "@janitor/domain/GitHub/WebhookEnvelope"
import * as PayloadCipher from "../src/PayloadCipher.ts"

const keyId = GitHubWebhookEncryptionKeyId.make("key-1")
const deliveryId = GitHubWebhookDeliveryId.make("delivery-1")
const key = new Uint8Array(32).map((_, index) => index)
const CipherLayer = Layer.effect(PayloadCipher.PayloadCipher, PayloadCipher.make({ key, keyId }))

describe("PayloadCipher", () => {
  it.effect("round-trips plaintext with a fresh IV per call", () =>
    Effect.gen(function* () {
      const cipher = yield* PayloadCipher.PayloadCipher
      const plaintext = new TextEncoder().encode('{"action":"opened"}')

      const first = yield* cipher.encrypt(deliveryId, plaintext)
      const second = yield* cipher.encrypt(deliveryId, plaintext)

      assert.strictEqual(first.encryption.algorithm, "AES-256-GCM")
      assert.strictEqual(first.encryption.keyId, keyId)
      assert.strictEqual(first.encryption.iv.byteLength, 12)
      assert.notDeepEqual(first.encryption.iv, second.encryption.iv)
      assert.notDeepEqual(first.ciphertext, second.ciphertext)
      assert.notDeepEqual(first.ciphertext, plaintext)
      assert.deepStrictEqual(
        yield* cipher.decrypt(deliveryId, first.encryption, first.ciphertext),
        plaintext,
      )
      assert.deepStrictEqual(
        yield* cipher.decrypt(deliveryId, second.encryption, second.ciphertext),
        plaintext,
      )
    }).pipe(Effect.provide(CipherLayer)),
  )

  it.effect("rejects tampered ciphertext", () =>
    Effect.gen(function* () {
      const cipher = yield* PayloadCipher.PayloadCipher
      const { encryption, ciphertext } = yield* cipher.encrypt(
        deliveryId,
        new TextEncoder().encode("{}"),
      )
      const tampered = new Uint8Array(ciphertext)
      tampered[0] = tampered[0] ^ 0xff

      const exit = yield* cipher.decrypt(deliveryId, encryption, tampered).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.provide(CipherLayer)),
  )

  it.effect("rejects ciphertext presented under a different delivery id", () =>
    Effect.gen(function* () {
      const cipher = yield* PayloadCipher.PayloadCipher
      const { encryption, ciphertext } = yield* cipher.encrypt(
        deliveryId,
        new TextEncoder().encode("{}"),
      )

      const exit = yield* cipher
        .decrypt(GitHubWebhookDeliveryId.make("delivery-2"), encryption, ciphertext)
        .pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.provide(CipherLayer)),
  )

  it.effect("rejects an unknown key id", () =>
    Effect.gen(function* () {
      const cipher = yield* PayloadCipher.PayloadCipher
      const { encryption, ciphertext } = yield* cipher.encrypt(
        deliveryId,
        new TextEncoder().encode("{}"),
      )

      const exit = yield* cipher
        .decrypt(
          deliveryId,
          { ...encryption, keyId: GitHubWebhookEncryptionKeyId.make("key-2") },
          ciphertext,
        )
        .pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.provide(CipherLayer)),
  )

  it.effect("rejects a key that is not 32 bytes", () =>
    Effect.gen(function* () {
      const exit = yield* PayloadCipher.make({ key: new Uint8Array(16), keyId }).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
    }),
  )

  it.effect("builds from config with a base64 key", () =>
    Effect.gen(function* () {
      const cipher = yield* PayloadCipher.PayloadCipher
      const plaintext = new TextEncoder().encode("{}")
      const { encryption, ciphertext } = yield* cipher.encrypt(deliveryId, plaintext)

      assert.strictEqual(encryption.keyId, "config-key")
      assert.deepStrictEqual(yield* cipher.decrypt(deliveryId, encryption, ciphertext), plaintext)
    }).pipe(
      Effect.provide(
        PayloadCipher.layer(
          PayloadCipher.config({
            key: "GITHUB_WEBHOOK_PAYLOAD_KEY",
            keyId: "GITHUB_WEBHOOK_PAYLOAD_KEY_ID",
          }),
        ).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                GITHUB_WEBHOOK_PAYLOAD_KEY: Encoding.encodeBase64(key),
                GITHUB_WEBHOOK_PAYLOAD_KEY_ID: "config-key",
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("fails the layer when the configured key is malformed", () =>
    Effect.gen(function* () {
      const exit = yield* Layer.build(
        PayloadCipher.layer(
          PayloadCipher.config({
            key: "GITHUB_WEBHOOK_PAYLOAD_KEY",
            keyId: "GITHUB_WEBHOOK_PAYLOAD_KEY_ID",
          }),
        ).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                GITHUB_WEBHOOK_PAYLOAD_KEY: Encoding.encodeBase64(new Uint8Array(16)),
                GITHUB_WEBHOOK_PAYLOAD_KEY_ID: "key",
              }),
            ),
          ),
        ),
      ).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
    }),
  )
})
