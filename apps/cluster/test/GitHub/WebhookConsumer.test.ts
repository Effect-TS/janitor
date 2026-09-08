import { assert, describe, it } from "@effect/vitest"
import * as RuntimeContext from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import type { GitHubWebhookR2ObjectKey } from "@janitor/domain/GitHub/WebhookEnvelope"
import {
  GitHubWebhookJournalSequence,
  type GitHubWebhookDeadLetterV1,
} from "@janitor/domain/GitHub/WebhookJournal"
import {
  DeadLetterError,
  GitHubEventsDeadLetter,
  GitHubPayloadReader,
  PayloadReadError,
  handleMessage,
  type ConsumerMessage,
} from "../../src/GitHub/WebhookConsumer.ts"
import {
  GitHubWebhookJournal,
  GitHubWebhookJournalError,
  type GitHubWebhookJournalEntry,
} from "../../src/GitHub/WebhookJournal.ts"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"

const runtimeContext = RuntimeContext.RuntimeContext.of({
  Type: "Test",
  id: "test",
  env: {},
  get: <A>() => Effect.succeed<A | undefined>(undefined),
  set: (id) => Effect.succeed(id),
})

const inlineBody = {
  schemaVersion: 1,
  deliveryId: "delivery-1",
  eventName: "pull_request",
  receivedAt: "2026-09-02T12:00:00.000Z",
  payloadSha256: "a".repeat(64),
  encryption: { algorithm: "AES-256-GCM", keyId: "key-1", iv: "AQIDBAUGBwgJCgsM" },
  body: { _tag: "Inline", payload: "AA0K//57fQ==" },
}

const r2Key = "github-webhooks/delivery-2"
const r2Body = {
  ...inlineBody,
  deliveryId: "delivery-2",
  body: { _tag: "R2", key: r2Key },
}

interface Recorder {
  readonly acked: Array<string>
  readonly retried: Array<string>
  readonly journaled: Array<GitHubWebhookJournalEntry>
  readonly deadLettered: Array<GitHubWebhookDeadLetterV1>
  readonly deleted: Array<string>
  readonly events: Array<string>
}

const makeRecorder = (): Recorder => ({
  acked: [],
  retried: [],
  journaled: [],
  deadLettered: [],
  deleted: [],
  events: [],
})

const message = (recorder: Recorder, body: unknown, id = "message-1"): ConsumerMessage => ({
  id,
  attempts: 1,
  body,
  ack: () => {
    recorder.acked.push(id)
    recorder.events.push("ack")
  },
  retry: () => {
    recorder.retried.push(id)
    recorder.events.push("retry")
  },
})

interface Stubs {
  readonly record?: (
    entry: GitHubWebhookJournalEntry,
  ) => Effect.Effect<
    { sequence: GitHubWebhookJournalSequence; duplicate: boolean },
    GitHubWebhookJournalError
  >
  readonly get?: (
    key: GitHubWebhookR2ObjectKey,
  ) => Effect.Effect<Option.Option<Uint8Array>, PayloadReadError>
  readonly send?: (entry: GitHubWebhookDeadLetterV1) => Effect.Effect<void, DeadLetterError>
}

const sequenceOne = GitHubWebhookJournalSequence.make("1")

const run = (recorder: Recorder, body: unknown, stubs: Stubs = {}) =>
  handleMessage(message(recorder, body)).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubWebhookJournal, {
          record:
            stubs.record ??
            ((entry) =>
              Effect.sync(() => {
                recorder.journaled.push(entry)
                recorder.events.push("journal")
                return { sequence: sequenceOne, duplicate: false }
              })),
          load: () => Effect.succeedNone,
          markProjection: () => Effect.void,
        }),
        Layer.succeed(WorkflowDispatcher, {
          dispatchDue: (options) =>
            Effect.sync(() => {
              recorder.events.push(`dispatch:${options?.only?.executionKey ?? "*"}`)
              return { claimed: 1, accepted: 1, released: 0 }
            }),
        }),
        Layer.succeed(GitHubPayloadReader, {
          get:
            stubs.get ??
            (() =>
              Effect.sync(() => {
                recorder.events.push("get")
                return Option.some(Uint8Array.from([1, 2, 3]))
              })),
          delete: (key) =>
            Effect.sync(() => {
              recorder.deleted.push(key)
              recorder.events.push("delete")
            }),
        }),
        Layer.succeed(GitHubEventsDeadLetter, {
          send:
            stubs.send ??
            ((entry) =>
              Effect.sync(() => {
                recorder.deadLettered.push(entry)
                recorder.events.push("deadLetter")
              })),
        }),
      ),
    ),
    Effect.provideService(RuntimeContext.RuntimeContext, runtimeContext),
  )

describe("GitHubWebhookConsumer.handleMessage", () => {
  it.effect("journals an inline envelope and acknowledges after the journal commits", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const outcome = yield* run(recorder, inlineBody)

      assert.deepStrictEqual(outcome, {
        _tag: "Journaled",
        deliveryId: GitHubWebhookDeliveryId.make("delivery-1"),
        sequence: sequenceOne,
        duplicate: false,
      })
      assert.deepStrictEqual(recorder.events, ["journal", "ack", "dispatch:delivery-1"])
      const entry = recorder.journaled[0]
      assert.isDefined(entry)
      if (entry === undefined) return
      assert.strictEqual(entry.deliveryId, "delivery-1")
      assert.strictEqual(entry.eventName, "pull_request")
      assert.strictEqual(entry.encryption.keyId, "key-1")
      assert.deepStrictEqual(entry.payload, Uint8Array.from([0, 13, 10, 0xff, 0xfe, 123, 125]))
      assert.deepStrictEqual(recorder.deleted, [])
    }),
  )

  it.effect("loads an R2 payload and deletes it only after the journal succeeds", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const outcome = yield* run(recorder, r2Body)

      assert.strictEqual(outcome._tag, "Journaled")
      assert.deepStrictEqual(recorder.events, [
        "get",
        "journal",
        "delete",
        "ack",
        "dispatch:delivery-2",
      ])
      assert.deepStrictEqual(recorder.journaled[0]?.payload, Uint8Array.from([1, 2, 3]))
      assert.deepStrictEqual(recorder.deleted, [r2Key])
    }),
  )

  it.effect("acknowledges a duplicate delivery without treating it as an error", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const outcome = yield* run(recorder, inlineBody, {
        record: () => Effect.succeed({ sequence: sequenceOne, duplicate: true }),
      })

      assert.strictEqual(outcome._tag, "Journaled")
      if (outcome._tag === "Journaled") assert.isTrue(outcome.duplicate)
      assert.deepStrictEqual(recorder.acked, ["message-1"])
      assert.deepStrictEqual(recorder.retried, [])
    }),
  )

  it.effect("retries without acknowledging when the journal fails", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const outcome = yield* run(recorder, r2Body, {
        record: (entry) =>
          Effect.fail(
            new GitHubWebhookJournalError({ deliveryId: entry.deliveryId, message: "neon down" }),
          ),
      })

      assert.strictEqual(outcome._tag, "Retried")
      assert.deepStrictEqual(recorder.events, ["get", "retry"])
      assert.deepStrictEqual(recorder.deleted, [])
      assert.deepStrictEqual(recorder.deadLettered, [])
    }),
  )

  it.effect("retries when the R2 read fails", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const outcome = yield* run(recorder, r2Body, {
        get: (key) => Effect.fail(new PayloadReadError({ key, cause: new Error("r2 down") })),
      })

      assert.strictEqual(outcome._tag, "Retried")
      assert.deepStrictEqual(recorder.events, ["retry"])
      assert.deepStrictEqual(recorder.journaled, [])
    }),
  )

  it.effect("dead-letters and acknowledges a malformed envelope", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()
      const body = { ...inlineBody, encryption: undefined }

      const outcome = yield* run(recorder, body)

      assert.strictEqual(outcome._tag, "DeadLettered")
      assert.deepStrictEqual(recorder.events, ["deadLetter", "ack"])
      assert.deepStrictEqual(recorder.deadLettered[0], {
        schemaVersion: 1,
        messageId: "message-1",
        attempts: 1,
        reason: "Message body is not a GitHubWebhookEnvelopeV1",
        body,
      })
      assert.deepStrictEqual(recorder.journaled, [])
    }),
  )

  it.effect("dead-letters an envelope whose R2 payload is missing", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const outcome = yield* run(recorder, r2Body, { get: () => Effect.succeedNone })

      assert.strictEqual(outcome._tag, "DeadLettered")
      assert.deepStrictEqual(recorder.events, ["deadLetter", "ack"])
      assert.deepStrictEqual(recorder.journaled, [])
    }),
  )

  it.effect("retries when the dead-letter write fails", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const outcome = yield* run(recorder, null, {
        send: (entry) =>
          Effect.fail(
            new DeadLetterError({ messageId: entry.messageId, cause: new Error("dlq down") }),
          ),
      })

      assert.strictEqual(outcome._tag, "Retried")
      assert.deepStrictEqual(recorder.events, ["retry"])
      assert.deepStrictEqual(recorder.acked, [])
    }),
  )
})
