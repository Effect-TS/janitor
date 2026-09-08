import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import * as Layer from "effect/Layer"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { WorkflowDispatcher, type WorkflowRegistration } from "../src/WorkflowDispatcher.ts"
import {
  WorkflowOutbox,
  type ClaimOptions,
  type FencedReference,
  type OutboxRow,
} from "../src/WorkflowOutbox.ts"

interface Recorder {
  readonly claims: Array<ClaimOptions>
  readonly accepted: Array<FencedReference>
  readonly released: Array<[FencedReference, Duration.Duration]>
  readonly submitted: Array<unknown>
}

const makeRecorder = (): Recorder => ({ claims: [], accepted: [], released: [], submitted: [] })

const run = (
  recorder: Recorder,
  rows: ReadonlyArray<OutboxRow>,
  registrations: ReadonlyArray<WorkflowRegistration>,
) =>
  Effect.gen(function* () {
    const dispatcher = yield* WorkflowDispatcher
    return yield* dispatcher.dispatchDue({ limit: 10 })
  }).pipe(
    Effect.provide(
      WorkflowDispatcher.layer(registrations).pipe(
        Layer.provide(
          Layer.succeed(WorkflowOutbox, {
            enqueue: () => Effect.void,
            claimDue: (options) =>
              Effect.sync(() => {
                recorder.claims.push(options)
                return rows.slice(
                  (recorder.claims.length - 1) * 4,
                  (recorder.claims.length - 1) * 4 + options.limit,
                )
              }),
            markAccepted: (reference) =>
              Effect.sync(() => {
                recorder.accepted.push(reference)
                return true
              }),
            release: (reference, retryAfter) =>
              Effect.sync(() => {
                recorder.released.push([reference, retryAfter])
                return true
              }),
          }),
        ),
        Layer.provide(WorkflowEngine.layerMemory),
      ),
    ),
  )

const row = (tag: string, key: string, attempts = 1): OutboxRow => ({
  workflow_tag: tag,
  execution_key: key,
  payload: { key },
  attempts,
})

describe("WorkflowDispatcher", () => {
  it.effect(
    "dispatches other rows while one submission hangs, then releases the timed-out row",
    () =>
      Effect.gen(function* () {
        const recorder = makeRecorder()
        const fiber = yield* run(
          recorder,
          [row("Slow", "slow"), row("Fast", "fast")],
          [
            { tag: "Slow", submit: () => Effect.never },
            { tag: "Fast", submit: () => Effect.void },
          ],
        ).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(
          recorder.accepted.map((row) => row.executionKey),
          ["fast"],
        )
        yield* TestClock.adjust("20 seconds")
        assert.deepStrictEqual(yield* Fiber.join(fiber), { claimed: 2, accepted: 1, released: 1 })
        assert.strictEqual(recorder.released[0]?.[0].executionKey, "slow")
      }),
  )
  it.effect("submits claimed rows and marks them accepted with the claim token", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const summary = yield* run(
        recorder,
        [row("T", "one"), row("T", "two")],
        [
          {
            tag: "T",
            submit: (payload) => Effect.sync(() => void recorder.submitted.push(payload)),
          },
        ],
      )

      assert.deepStrictEqual(summary, { claimed: 2, accepted: 2, released: 0 })
      assert.deepStrictEqual(recorder.submitted, [{ key: "one" }, { key: "two" }])
      const token = recorder.claims[0]?.leaseToken
      assert.isDefined(token)
      assert.deepStrictEqual(recorder.accepted, [
        { workflowTag: "T", executionKey: "one", leaseToken: token },
        { workflowTag: "T", executionKey: "two", leaseToken: token },
      ])
    }),
  )

  it.effect("releases a row with backoff when submission fails", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const summary = yield* run(
        recorder,
        [row("T", "flaky", 3)],
        [{ tag: "T", submit: () => Effect.die("engine unavailable") }],
      )

      assert.deepStrictEqual(summary, { claimed: 1, accepted: 0, released: 1 })
      assert.deepStrictEqual(recorder.accepted, [])
      const released = recorder.released[0]
      assert.isDefined(released)
      if (released === undefined) return
      assert.strictEqual(released[0].executionKey, "flaky")
      assert.strictEqual(Duration.toSeconds(released[1]), 8)
    }),
  )

  it.effect("releases rows for unregistered tags without submitting", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder()

      const summary = yield* run(recorder, [row("Unknown", "x")], [])

      assert.deepStrictEqual(summary, { claimed: 1, accepted: 0, released: 1 })
      assert.deepStrictEqual(recorder.submitted, [])
      assert.strictEqual(Duration.toHours(recorder.released[0]?.[1] ?? Duration.zero), 1)
    }),
  )
})
