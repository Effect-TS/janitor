import { assert, describe, it } from "@effect/vitest"
import * as RuntimeContext from "alchemy/RuntimeContext"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import {
  GitHubWebhookEncryptionKeyId,
  type GitHubWebhookEnvelopeV1,
  type GitHubWebhookR2ObjectKey,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import { EnqueueError, GitHubEventQueue } from "../../src/GitHub/EventQueue.ts"
import { GitHubWebhookRoutesLayerNoDeps } from "../../src/Ingress/GitHubWebhook.ts"
import {
  GitHubPayloadStore,
  PayloadStoreError,
  payloadKey,
  type PutPayloadInput,
} from "../../src/GitHub/PayloadStore.ts"
import * as PayloadCipher from "../../src/PayloadCipher.ts"
import { WebhookVerifier } from "../../src/Ingress/WebhookVerifier.ts"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"

const runtimeContext = RuntimeContext.RuntimeContext.of({
  Type: "Test",
  id: "test",
  env: {},
  get: <A>() => Effect.succeed<A | undefined>(undefined),
  set: (id) => Effect.succeed(id),
})

const validSignature = "sha256=" + "ab".repeat(32)
const deliveryOneKey = payloadKey(GitHubWebhookDeliveryId.make("delivery-1"))

const VerifierStub = Layer.succeed(WebhookVerifier, {
  verify: (signature) => Effect.succeed(signature === validSignature),
})

const cipherKeyId = GitHubWebhookEncryptionKeyId.make("test-key")
const cipherKey = new Uint8Array(32).map((_, index) => index)
const CipherLayer = Layer.effect(
  PayloadCipher.PayloadCipher,
  PayloadCipher.make({ key: cipherKey, keyId: cipherKeyId }),
)

// AES-GCM appends a 16 byte authentication tag to every ciphertext.
const AES_GCM_TAG_BYTES = 16

const decrypt = (envelope: GitHubWebhookEnvelopeV1, ciphertext: Uint8Array) =>
  Effect.flatMap(PayloadCipher.make({ key: cipherKey, keyId: cipherKeyId }), (cipher) =>
    cipher.decrypt(envelope.deliveryId, envelope.encryption, ciphertext),
  )

interface StoreStub {
  readonly put?: (
    input: PutPayloadInput,
  ) => Effect.Effect<GitHubWebhookR2ObjectKey, PayloadStoreError>
  readonly delete?: (key: GitHubWebhookR2ObjectKey) => Effect.Effect<void, PayloadStoreError>
}

const makeHandler = (
  enqueue: (envelope: GitHubWebhookEnvelopeV1) => Effect.Effect<void, EnqueueError>,
  store: StoreStub = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        GitHubWebhookRoutesLayerNoDeps.pipe(
          Layer.provide([
            VerifierStub,
            CipherLayer,
            Layer.succeed(GitHubEventQueue, { enqueue }),
            Layer.succeed(GitHubPayloadStore, {
              put: store.put ?? ((input) => Effect.succeed(payloadKey(input.deliveryId))),
              delete: store.delete ?? (() => Effect.void),
            }),
          ]),
        ),
        {
          disableLogger: true,
          middleware: (app) =>
            app.pipe(
              Effect.orDie,
              Effect.provideService(RuntimeContext.RuntimeContext, runtimeContext),
            ),
        },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  ).pipe(Effect.map(({ handler }) => handler))

const post = (handler: (request: Request) => Promise<Response>, init: RequestInit) =>
  Effect.promise(() =>
    handler(new Request("https://example.com/webhooks/github", { method: "POST", ...init })),
  )

const headers = (overrides: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-hub-signature-256": validSignature,
  "x-github-delivery": "delivery-1",
  "x-github-event": "pull_request",
  ...overrides,
})

const paddedJson = (byteLength: number) =>
  new TextEncoder().encode(`{${" ".repeat(byteLength - 2)}}`)

const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.map(
    Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
    (digest) => Encoding.encodeHex(new Uint8Array(digest)),
  )

describe("GitHubWebhookRoutes", () => {
  it.effect("enqueues a versioned envelope with the exact payload bytes", () =>
    Effect.gen(function* () {
      const envelopes: Array<GitHubWebhookEnvelopeV1> = []
      const handler = yield* makeHandler((envelope) =>
        Effect.sync(() => void envelopes.push(envelope)),
      )
      const body = new TextEncoder().encode('{"action":"opened","number":1}')
      // The web handler runs in its own runtime with the real clock, not the test clock.
      const before = DateTime.toEpochMillis(DateTime.nowUnsafe())

      const response = yield* post(handler, { headers: headers(), body })

      const after = DateTime.toEpochMillis(DateTime.nowUnsafe())

      assert.strictEqual(response.status, 202)
      assert.strictEqual(envelopes.length, 1)
      const envelope = envelopes[0]
      assert.isDefined(envelope)
      if (envelope === undefined) return
      assert.strictEqual(envelope.schemaVersion, 1)
      assert.strictEqual(envelope.deliveryId, "delivery-1")
      assert.strictEqual(envelope.eventName, "pull_request")
      assert.strictEqual(envelope.payloadSha256, yield* sha256(body))
      assert.strictEqual(envelope.encryption.algorithm, "AES-256-GCM")
      assert.strictEqual(envelope.encryption.keyId, cipherKeyId)
      assert.strictEqual(envelope.body._tag, "Inline")
      if (envelope.body._tag !== "Inline") return
      assert.notDeepEqual(envelope.body.payload, body)
      assert.deepStrictEqual(yield* decrypt(envelope, envelope.body.payload), body)
      const receivedAt = DateTime.toEpochMillis(envelope.receivedAt)
      assert.isTrue(receivedAt >= before && receivedAt <= after)
    }),
  )

  it.effect("acknowledges unsupported event names without enqueueing", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, {
        headers: headers({ "x-github-event": "future_custom_event" }),
        body: '{"action":"something_new"}',
      })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("enqueues unknown actions of supported events", () =>
    Effect.gen(function* () {
      const envelopes: Array<GitHubWebhookEnvelopeV1> = []
      const handler = yield* makeHandler((envelope) =>
        Effect.sync(() => void envelopes.push(envelope)),
      )

      const response = yield* post(handler, {
        headers: headers({ "x-github-event": "pull_request" }),
        body: '{"action":"action_the_schema_does_not_model"}',
      })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(envelopes.length, 1)
      assert.strictEqual(envelopes[0]?.eventName, "pull_request")
    }),
  )

  it.effect("returns 503 and does not acknowledge when the queue write fails", () =>
    Effect.gen(function* () {
      const handler = yield* makeHandler((envelope) =>
        Effect.fail(
          new EnqueueError({ deliveryId: envelope.deliveryId, cause: new Error("down") }),
        ),
      )

      const response = yield* post(handler, { headers: headers(), body: "{}" })

      assert.strictEqual(response.status, 503)
      assert.strictEqual(response.headers.get("retry-after"), "60")
    }),
  )

  it.effect("rejects an invalid signature without enqueueing", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, {
        headers: headers({ "x-hub-signature-256": "sha256=" + "00".repeat(32) }),
        body: "{}",
      })

      assert.strictEqual(response.status, 401)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("rejects missing or empty GitHub headers with 400", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const missing = yield* post(handler, {
        headers: { "x-hub-signature-256": validSignature, "x-github-event": "ping" },
        body: "{}",
      })
      const empty = yield* post(handler, {
        headers: headers({ "x-github-delivery": "" }),
        body: "{}",
      })

      assert.strictEqual(missing.status, 400)
      assert.strictEqual(empty.status, 400)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("drops a non-JSON body with 202 after signature verification", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, { headers: headers(), body: "not json" })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("drops a declared oversized body with 202", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, {
        headers: headers({ "content-length": String(1024 * 1024 + 1) }),
        body: "{}",
      })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("drops an oversized body by actual bytes when Content-Length is absent", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))
      const body = new Uint8Array(1024 * 1024 + 1).fill(0x20)

      const response = yield* post(handler, { headers: headers(), body })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("drops an oversized body by actual bytes when Content-Length lies", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))
      const body = new Uint8Array(1024 * 1024 + 1).fill(0x20)

      const response = yield* post(handler, {
        headers: headers({ "content-length": "2" }),
        body,
      })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("accepts a body exactly at the limit", () =>
    Effect.gen(function* () {
      const envelopes: Array<GitHubWebhookEnvelopeV1> = []
      const inputs: Array<PutPayloadInput> = []
      const handler = yield* makeHandler(
        (envelope) => Effect.sync(() => void envelopes.push(envelope)),
        {
          put: (input) =>
            Effect.sync(() => {
              inputs.push(input)
              return payloadKey(input.deliveryId)
            }),
        },
      )
      const body = paddedJson(1024 * 1024)

      const response = yield* post(handler, { headers: headers(), body })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(inputs[0]?.body.byteLength, 1024 * 1024 + AES_GCM_TAG_BYTES)
      assert.deepStrictEqual(envelopes[0]?.body, { _tag: "R2", key: deliveryOneKey })
    }),
  )

  it.effect("keeps bodies at the inline limit out of R2", () =>
    Effect.gen(function* () {
      const envelopes: Array<GitHubWebhookEnvelopeV1> = []
      let puts = 0
      const handler = yield* makeHandler(
        (envelope) => Effect.sync(() => void envelopes.push(envelope)),
        {
          put: (input) =>
            Effect.sync(() => {
              puts++
              return payloadKey(input.deliveryId)
            }),
        },
      )
      const body = paddedJson(64 * 1024 - AES_GCM_TAG_BYTES)

      const response = yield* post(handler, { headers: headers(), body })

      assert.strictEqual(response.status, 202)
      assert.strictEqual(puts, 0)
      assert.strictEqual(envelopes[0]?.body._tag, "Inline")
    }),
  )

  it.effect("stores bodies over the inline limit in R2 before enqueueing", () =>
    Effect.gen(function* () {
      const order: Array<string> = []
      const inputs: Array<PutPayloadInput> = []
      const envelopes: Array<GitHubWebhookEnvelopeV1> = []
      const handler = yield* makeHandler(
        (envelope) =>
          Effect.sync(() => {
            order.push("enqueue")
            envelopes.push(envelope)
          }),
        {
          put: (input) =>
            Effect.sync(() => {
              order.push("put")
              inputs.push(input)
              return payloadKey(input.deliveryId)
            }),
        },
      )
      const body = paddedJson(64 * 1024 - AES_GCM_TAG_BYTES + 1)

      const response = yield* post(handler, { headers: headers(), body })

      assert.strictEqual(response.status, 202)
      assert.deepStrictEqual(order, ["put", "enqueue"])
      const stored = inputs[0]
      const envelope = envelopes[0]
      assert.isDefined(stored)
      assert.isDefined(envelope)
      if (stored === undefined || envelope === undefined) return
      assert.notDeepEqual(stored.body, body)
      assert.deepStrictEqual(yield* decrypt(envelope, stored.body), body)
      assert.strictEqual(stored.sha256, yield* sha256(stored.body))
      assert.strictEqual(envelope.payloadSha256, yield* sha256(body))
      assert.deepStrictEqual(envelope.body, { _tag: "R2", key: deliveryOneKey })
    }),
  )

  it.effect("returns 503 without enqueueing when the R2 write fails", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++), {
        put: (input) =>
          Effect.fail(
            new PayloadStoreError({
              key: payloadKey(input.deliveryId),
              cause: new Error("r2 down"),
            }),
          ),
      })
      const body = paddedJson(64 * 1024 + 1)

      const response = yield* post(handler, { headers: headers(), body })

      assert.strictEqual(response.status, 503)
      assert.strictEqual(calls, 0)
    }),
  )

  it.effect("deletes the stored payload when the queue write fails", () =>
    Effect.gen(function* () {
      const deleted: Array<string> = []
      const handler = yield* makeHandler(
        (envelope) =>
          Effect.fail(
            new EnqueueError({ deliveryId: envelope.deliveryId, cause: new Error("down") }),
          ),
        { delete: (key) => Effect.sync(() => void deleted.push(key)) },
      )
      const body = paddedJson(64 * 1024 + 1)

      const response = yield* post(handler, { headers: headers(), body })

      assert.strictEqual(response.status, 503)
      assert.deepStrictEqual(deleted, ["github-webhooks/delivery-1"])
    }),
  )

  it.effect("rejects an empty body with 400", () =>
    Effect.gen(function* () {
      let calls = 0
      const handler = yield* makeHandler(() => Effect.sync(() => void calls++))

      const response = yield* post(handler, { headers: headers() })

      assert.strictEqual(response.status, 400)
      assert.strictEqual(calls, 0)
    }),
  )
})
