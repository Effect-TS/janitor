import * as Layer from "effect/Layer"
import { GitHubWebhookEncryptionKeyId } from "@janitor/domain/GitHub/WebhookEnvelope"
import { PayloadCipher, make } from "../../src/PayloadCipher.ts"

export const TestPayloadCipher = Layer.effect(
  PayloadCipher,
  make({
    key: new Uint8Array(32),
    keyId: GitHubWebhookEncryptionKeyId.make("test"),
  }),
)
