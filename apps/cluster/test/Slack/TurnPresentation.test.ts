import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import { makeTurnPresentation } from "../../src/Slack/TurnPresentation.ts"
import { SlackTransport, SlackTransportError } from "../../src/Slack/Transport.ts"

const input = {
  workspace: "T1",
  channel: "C1",
  thread: "1.0",
  timestamp: "2.0",
  user: "U1",
  text: "Inspect the README",
  mentioned: false,
}
const unavailable = () => Effect.die("Unexpected Slack operation")

it.effect("keeps activity in one message, throttles updates and posts commentary separately", () =>
  Effect.gen(function* () {
    const posts: string[] = []
    const updates: string[] = []
    const slack = SlackTransport.of({
      channel: unavailable,
      replies: unavailable,
      ephemeral: unavailable,
      update: (channel, ts, text) =>
        Effect.sync(() => {
          assert.strictEqual(channel, input.channel)
          assert.strictEqual(ts, "3.0")
          updates.push(text)
          return ts
        }),
      post: (channel, thread, text) =>
        Effect.sync(() => {
          assert.strictEqual(channel, input.channel)
          assert.strictEqual(thread, input.thread)
          posts.push(text)
          return "3.0"
        }),
    })
    const presentation = yield* makeTurnPresentation(input).pipe(
      Effect.provideService(SlackTransport, slack),
    )
    yield* presentation.emit({ type: "tool-call", id: "a", name: "readFile" })
    assert.lengthOf(updates, 0)
    yield* TestClock.adjust("3 seconds")
    yield* presentation.refresh
    assert.deepStrictEqual(updates, ["Reading files · 3 seconds · 0 actions"])
    yield* presentation.emit({
      type: "commentary",
      text: "The README describes a TypeScript library.",
    })
    yield* presentation.emit({ type: "tool-result", id: "a" })
    yield* presentation.emit({ type: "tool-result", id: "a" })
    yield* presentation.finish("Finished")
    assert.deepStrictEqual(posts, [
      "Working · 0 seconds · 0 actions",
      "The README describes a TypeScript library.",
    ])
    assert.strictEqual(updates[1], "Finished · 3 seconds · 1 actions")
  }),
)

it.effect("presentation failures do not fail the turn or retry uncertain sends", () =>
  Effect.gen(function* () {
    let attempts = 0
    const failed = () =>
      Effect.fail(
        new SlackTransportError({
          message: "Unavailable",
          disposition: "uncertain",
          retryAfter: 1,
        }),
      )
    const presentation = yield* makeTurnPresentation(input).pipe(
      Effect.provideService(SlackTransport, {
        channel: unavailable,
        replies: unavailable,
        ephemeral: unavailable,
        update: unavailable,
        post: () =>
          Effect.sync(() => {
            attempts += 1
          }).pipe(Effect.andThen(failed())),
      }),
    )
    yield* presentation.emit({ type: "commentary", text: "Checking the README." })
    yield* presentation.emit({ type: "tool-call", id: "a", name: "readFile" })
    yield* presentation.finish("Stopped")
    assert.strictEqual(attempts, 2)
  }),
)
