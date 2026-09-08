import type { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookEncryptionKeyId,
  type GitHubWebhookEncryptionV1,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const AES_GCM_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12

export class PayloadCipherError extends Data.TaggedError("PayloadCipherError")<{
  readonly operation: "encrypt" | "decrypt"
  readonly cause: unknown
}> {}

export class PayloadCipherKeyError extends Data.TaggedError("PayloadCipherKeyError")<{
  readonly reason: string
}> {}

export interface EncryptedPayload {
  readonly encryption: GitHubWebhookEncryptionV1
  readonly ciphertext: Uint8Array<ArrayBuffer>
}

/**
 * Encrypts webhook bodies with AES-256-GCM. The delivery id is bound to the
 * ciphertext as additional authenticated data, so a payload cannot be replayed
 * under another delivery's metadata.
 */
export class PayloadCipher extends Context.Service<
  PayloadCipher,
  {
    readonly encrypt: (
      deliveryId: GitHubWebhookDeliveryId,
      plaintext: Uint8Array<ArrayBuffer>,
    ) => Effect.Effect<EncryptedPayload, PayloadCipherError>
    readonly decrypt: (
      deliveryId: GitHubWebhookDeliveryId,
      encryption: GitHubWebhookEncryptionV1,
      ciphertext: Uint8Array,
    ) => Effect.Effect<Uint8Array<ArrayBuffer>, PayloadCipherError>
  }
>()("@janitor/cluster/PayloadCipher") {}

export interface PayloadCipherKey {
  readonly key: Uint8Array
  readonly keyId: GitHubWebhookEncryptionKeyId
}

/** Base64 encoding of a 32 byte AES key. */
export const AesGcmKeyFromBase64 = Schema.Uint8ArrayFromBase64.check(
  Schema.makeFilter((key) => key.byteLength === AES_GCM_KEY_BYTES, {
    expected: `a ${AES_GCM_KEY_BYTES} byte key`,
  }),
).annotate({ identifier: "AesGcmKeyFromBase64" })

export interface PayloadCipherConfig {
  readonly key: Redacted.Redacted<Uint8Array>
  /** Identifies the key so the consumer can select it during rotation. */
  readonly keyId: GitHubWebhookEncryptionKeyId
}

/**
 * Reads the key and key id from the named config paths and validates them at
 * the boundary, so misconfiguration surfaces as a `ConfigError`.
 */
export const config = (paths: {
  readonly key: string
  readonly keyId: string
}): Config.Wrap<PayloadCipherConfig> => ({
  key: Config.schema(Schema.RedactedFromValue(AesGcmKeyFromBase64), paths.key),
  keyId: Config.schema(GitHubWebhookEncryptionKeyId, paths.keyId),
})

export const make = Effect.fnUntraced(function* ({ key, keyId }: PayloadCipherKey) {
  if (key.byteLength !== AES_GCM_KEY_BYTES) {
    return yield* new PayloadCipherKeyError({
      reason: `Expected a ${AES_GCM_KEY_BYTES} byte key, received ${key.byteLength} bytes`,
    })
  }

  const cryptoKey = yield* Effect.promise(() =>
    crypto.subtle.importKey("raw", new Uint8Array(key), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]),
  )

  const additionalData = (deliveryId: GitHubWebhookDeliveryId) =>
    new TextEncoder().encode(deliveryId)

  const encrypt = Effect.fn("PayloadCipher.encrypt")(function* (
    deliveryId: GitHubWebhookDeliveryId,
    plaintext: Uint8Array<ArrayBuffer>,
  ) {
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
    const ciphertext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: additionalData(deliveryId) },
          cryptoKey,
          plaintext,
        ),
      catch: (cause) => new PayloadCipherError({ operation: "encrypt", cause }),
    })
    return {
      encryption: { algorithm: "AES-256-GCM" as const, keyId, iv },
      ciphertext: new Uint8Array(ciphertext),
    }
  })

  const decrypt = Effect.fn("PayloadCipher.decrypt")(function* (
    deliveryId: GitHubWebhookDeliveryId,
    encryption: GitHubWebhookEncryptionV1,
    ciphertext: Uint8Array,
  ) {
    if (encryption.keyId !== keyId) {
      return yield* new PayloadCipherError({
        operation: "decrypt",
        cause: new Error(`Unknown encryption key id: ${encryption.keyId}`),
      })
    }
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(encryption.iv),
            additionalData: additionalData(deliveryId),
          },
          cryptoKey,
          new Uint8Array(ciphertext),
        ),
      catch: (cause) => new PayloadCipherError({ operation: "decrypt", cause }),
    })
    return new Uint8Array(plaintext)
  })

  return { encrypt, decrypt }
})

/** Builds the cipher from an already resolved and validated config. */
export const layerFrom = ({ key, keyId }: PayloadCipherConfig): Layer.Layer<PayloadCipher> =>
  // The config schema already enforces the key length; a failure here is a defect.
  Layer.effect(PayloadCipher, make({ key: Redacted.value(key), keyId }).pipe(Effect.orDie))

export const layer = (
  config: Config.Wrap<PayloadCipherConfig>,
): Layer.Layer<PayloadCipher, Config.ConfigError> =>
  Layer.unwrap(Effect.map(Config.unwrap(config), layerFrom))
