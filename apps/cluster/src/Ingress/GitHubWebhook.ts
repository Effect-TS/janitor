import { RepositoryActivity } from "../RepositoryActivity.ts"
import { GitHubFeedback } from "../GitHub/Feedback.ts"
import { GitHubWebhookJournal } from "../GitHub/WebhookJournal.ts"
import * as Option from "effect/Option"
import { GitHubWebhookEventName } from "@janitor/domain/GitHub/WebhookEvent"
import {
  GitHubWebhookBodyV1,
  GitHubWebhookName,
  GitHubWebhookEnvelopeV1,
  GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as PayloadCipher from "../PayloadCipher.ts"
import * as WebhookVerifier from "./WebhookVerifier.ts"
import * as GitHubEventQueue from "../GitHub/EventQueue.ts"
import * as GitHubPayloadStore from "../GitHub/PayloadStore.ts"
import {
  GitHubWebhookDeliveryId,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
} from "@janitor/domain/GitHub/Id"
import * as Encoding from "effect/Encoding"
import * as Redacted from "effect/Redacted"
import * as DateTime from "effect/DateTime"

export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024

// Queue messages cap at 128 KB and base64 adds a third; keep headroom for the envelope.
export const MAX_INLINE_WEBHOOK_BODY_BYTES = 64 * 1024

const GitHubHeaders = Schema.Struct({
  "content-length": Schema.optional(Schema.FiniteFromString.check(Schema.isInt())),
  "x-hub-signature-256": Schema.NonEmptyString,
  "x-github-delivery": GitHubWebhookDeliveryId,
  "x-github-event": GitHubWebhookName,
})

const acceptedResponse = HttpServerResponse.text("Accepted", {
  status: 202,
})
const invalidWebhookSignatureResponse = HttpServerResponse.text("Invalid Webhook Signature", {
  status: 401,
})
// GitHub only needs to know a delivery arrived. Deliveries Janitor chooses not
// to process are acknowledged and dropped; only failures to process a
// delivery Janitor would otherwise accept return a non-2xx status.
const droppedResponse = acceptedResponse
const serviceUnavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "60" },
})

export class BodyTooLargeError extends Data.TaggedError("BodyTooLargeError")<{
  readonly maxBytes: number
}> {}

/**
 * Secrets the ingress needs. The Worker resolves them during init so Alchemy
 * binds them at deploy time; layers built later cannot register bindings.
 */
export interface IngressSecrets {
  readonly webhookSecret: Redacted.Redacted<string>
  readonly cipher: PayloadCipher.PayloadCipherConfig
}

export const ingressSecrets: Config.Wrap<IngressSecrets> = {
  webhookSecret: Config.Redacted("JANITOR_GITHUB_WEBHOOK_SECRET"),
  cipher: PayloadCipher.config({
    key: "JANITOR_GITHUB_WEBHOOK_PAYLOAD_KEY",
    keyId: "JANITOR_GITHUB_WEBHOOK_PAYLOAD_KEY_ID",
  }),
}

export const GitHubWebhookRoutesLayerNoDeps = Layer.unwrap(
  Effect.gen(function* () {
    const queue = yield* GitHubEventQueue.GitHubEventQueue
    const store = yield* GitHubPayloadStore.GitHubPayloadStore
    const cipher = yield* PayloadCipher.PayloadCipher
    const verifier = yield* WebhookVerifier.WebhookVerifier

    const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
    const isSupportedEventName = Schema.is(GitHubWebhookEventName)

    const sha256Hex = Effect.fnUntraced(function* (body: Uint8Array<ArrayBuffer>) {
      const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", body))
      return GitHubWebhookPayloadSha256.make(Encoding.encodeHex(new Uint8Array(digest)))
    })

    const readBodyBounded = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const chunks: Array<Uint8Array> = []

      let total = 0
      yield* request.stream.pipe(
        Stream.runForEach(
          Effect.fnUntraced(function* (chunk) {
            total += chunk.byteLength

            if (total > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
              return yield* new BodyTooLargeError({
                maxBytes: MAX_GITHUB_WEBHOOK_BODY_BYTES,
              })
            }

            chunks.push(chunk)
          }),
        ),
      )

      const body = new Uint8Array(total)

      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }

      return body
    })

    return HttpRouter.add(
      "POST",
      "/webhooks/github",
      Effect.gen(function* () {
        const receivedAt = yield* DateTime.now
        const request = yield* HttpServerRequest.HttpServerRequest

        const headers = yield* HttpServerRequest.schemaHeaders(GitHubHeaders).pipe(
          Effect.catch(
            Effect.fnUntraced(function* () {
              return yield* new HttpServerError.RequestParseError({
                request,
                description: "Missing required GitHub webhook headers",
              })
            }),
          ),
        )

        const deliveryId = headers["x-github-delivery"]
        const eventName = headers["x-github-event"]

        const drop = (reason: string) =>
          Effect.logInfo("Dropped GitHub webhook delivery", reason).pipe(
            Effect.annotateLogs({ id: deliveryId, event: eventName }),
            Effect.as(droppedResponse),
          )

        if (
          headers["content-length"] !== undefined &&
          headers["content-length"] > MAX_GITHUB_WEBHOOK_BODY_BYTES
        ) {
          return yield* drop("Declared body exceeds the size limit")
        }

        const body = yield* readBodyBounded(request).pipe(
          Effect.catchTags({
            BodyTooLargeError: () => Effect.undefined,
            HttpServerError: (cause) =>
              Effect.fail(
                new HttpServerError.RequestParseError({
                  cause,
                  request,
                  description: "Unable to read webhook body",
                }),
              ),
          }),
        )

        if (body === undefined) {
          return yield* drop("Body exceeds the size limit")
        }

        const hasValidSignature = yield* verifier.verify(headers["x-hub-signature-256"], body)

        if (!hasValidSignature) {
          return invalidWebhookSignatureResponse
        }

        const parsed = yield* parseJson(new TextDecoder().decode(body)).pipe(Effect.option)

        if (Option.isNone(parsed)) {
          return yield* drop("Body is not JSON")
        }

        if (!isSupportedEventName(eventName)) {
          return yield* drop("Unsupported event name")
        }

        const repository = Schema.decodeUnknownOption(
          Schema.Struct({
            repository: Schema.Struct({ id: GitHubRepositoryDatabaseIdFromStringOrNumber }),
          }),
        )(parsed.value)
        const accept = Effect.gen(function* () {
          const feedback = yield* Effect.serviceOption(GitHubFeedback)
          const payloadSha256 = yield* sha256Hex(body)

          const encrypted = yield* cipher.encrypt(deliveryId, body).pipe(
            Effect.catchCause(
              Effect.fnUntraced(function* (cause) {
                yield* Effect.logError("Failed to encrypt GitHub webhook payload", cause).pipe(
                  Effect.annotateLogs({ id: deliveryId, event: eventName }),
                )
                return undefined
              }),
            ),
          )

          if (encrypted === undefined) {
            return serviceUnavailableResponse
          }

          const { ciphertext, encryption } = encrypted

          // Repository payloads live in the database transaction protected by
          // disconnect. The outbox schedules projection without queue/R2 copies.
          if (
            Option.isSome(repository) &&
            eventName !== "installation" &&
            eventName !== "installation_repositories"
          ) {
            const journal = yield* GitHubWebhookJournal
            return yield* journal
              .record({
                repositoryId: repository.value.repository.id,
                deliveryId,
                eventName,
                receivedAt,
                payloadSha256,
                encryption,
                payload: ciphertext,
              })
              .pipe(
                Effect.andThen(
                  Option.isSome(feedback)
                    ? feedback.value.record(deliveryId, eventName, parsed.value)
                    : Effect.void,
                ),
                Effect.as(acceptedResponse),
              )
          }

          const envelopeBody: GitHubWebhookBodyV1 | undefined =
            ciphertext.byteLength <= MAX_INLINE_WEBHOOK_BODY_BYTES
              ? GitHubWebhookBodyV1.cases.Inline.make({ payload: ciphertext })
              : yield* Effect.flatMap(sha256Hex(ciphertext), (sha256) =>
                  store.put({ deliveryId, body: ciphertext, sha256 }),
                ).pipe(
                  Effect.map((key) => GitHubWebhookBodyV1.cases.R2.make({ key })),
                  Effect.catchCause(
                    Effect.fnUntraced(function* (cause) {
                      yield* Effect.logError("Failed to store GitHub webhook payload", cause).pipe(
                        Effect.annotateLogs({ id: deliveryId, event: eventName }),
                      )
                      return undefined
                    }),
                  ),
                )

          if (envelopeBody === undefined) {
            return serviceUnavailableResponse
          }

          const envelope: GitHubWebhookEnvelopeV1 = {
            schemaVersion: 1,
            deliveryId,
            eventName,
            receivedAt,
            payloadSha256,
            encryption,
            body: envelopeBody,
          }

          const enqueued = yield* queue.enqueue(envelope).pipe(
            Effect.as(true),
            Effect.catchCause(
              Effect.fnUntraced(function* (cause) {
                yield* Effect.logError("Failed to enqueue GitHub webhook envelope", cause).pipe(
                  Effect.annotateLogs({ id: deliveryId, event: eventName }),
                )
                return false
              }),
            ),
          )

          if (!enqueued && envelopeBody._tag === "R2") {
            // Best effort: the lifecycle rule removes anything this misses.
            yield* store.delete(envelopeBody.key).pipe(
              Effect.catchCause(
                Effect.fnUntraced(function* (cause) {
                  yield* Effect.logWarning("Failed to delete orphaned webhook payload", cause).pipe(
                    Effect.annotateLogs({ id: deliveryId, key: envelopeBody.key }),
                  )
                }),
              ),
            )
          }

          return enqueued ? acceptedResponse : serviceUnavailableResponse
        })
        // Installation inventory still discovers access, even when repositories are paused.
        if (
          eventName === "installation" ||
          eventName === "installation_repositories" ||
          Option.isNone(repository)
        )
          return yield* accept
        const activity = yield* RepositoryActivity
        return yield* activity
          .run(String(repository.value.repository.id), accept, DateTime.toDateUtc(receivedAt))
          .pipe(
            Effect.map(Option.getOrElse(() => acceptedResponse)),
            Effect.catchCause((cause) =>
              Effect.logError("Repository webhook fence failed", cause).pipe(
                Effect.as(serviceUnavailableResponse),
              ),
            ),
          )
      }),
    )
  }),
)

export const makeGitHubWebHookRoutesLayer = (secrets: IngressSecrets) =>
  GitHubWebhookRoutesLayerNoDeps.pipe(
    Layer.provide([
      GitHubEventQueue.layer,
      GitHubPayloadStore.layer,
      PayloadCipher.layerFrom(secrets.cipher),
      WebhookVerifier.layerFrom({ secret: secrets.webhookSecret }),
    ]),
  )
