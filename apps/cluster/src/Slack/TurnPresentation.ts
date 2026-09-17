import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import type { SessionInput } from "./Session.ts"
import { SlackTransport } from "./Transport.ts"
import type { TurnEvent } from "./TurnEvents.ts"

const activities: Readonly<Record<string, string>> = {
  listRepositories: "Finding repositories",
  selectRepository: "Preparing the checkout",
  readFile: "Reading files",
  listFiles: "Exploring the repository",
  exec: "Running a command",
}

export const makeTurnPresentation = Effect.fnUntraced(function* (input: SessionInput) {
  const slack = yield* SlackTransport
  const started = yield* Clock.currentTimeMillis
  const lock = yield* Semaphore.make(1)
  const marker = `chat:${input.timestamp}:activity`
  let activity = "Working"
  let updated = started
  let message: string | undefined
  let commentary = 0
  const completed = new Set<string>()
  const active = new Map<string, string>()
  const report = (operation: string) =>
    Effect.catch((error: { readonly disposition: string }) =>
      Effect.logWarning("Slack turn presentation failed", {
        operation,
        disposition: error.disposition,
      }),
    )

  yield* slack.post(input.channel, input.thread, "Working · 0 seconds · 0 actions", marker).pipe(
    Effect.tap((ts) =>
      Effect.sync(() => {
        message = ts
      }),
    ),
    report("start"),
  )

  const update = Effect.fnUntraced(
    function* (terminal: "Finished" | "Stopped" | undefined) {
      const now = yield* Clock.currentTimeMillis
      if (message === undefined || (terminal === undefined && now - updated < 3000)) return
      updated = now
      yield* slack
        .update(
          input.channel,
          message,
          `${terminal ?? activity} · ${Math.floor((now - started) / 1000)} seconds · ${completed.size} actions`,
          marker,
        )
        .pipe(report("update"))
    },
    Semaphore.withPermits(lock, 1),
  )

  return {
    emit: Effect.fnUntraced(function* (event: TurnEvent) {
      switch (event.type) {
        case "commentary":
          for (const [index, chunk] of (event.text.match(/[\s\S]{1,3500}/gu) ?? []).entries()) {
            if (index > 0) yield* Effect.sleep("1 second")
            yield* slack
              .post(
                input.channel,
                input.thread,
                chunk,
                `chat:${input.timestamp}:commentary:${commentary++}`,
              )
              .pipe(report("commentary"))
          }
          break
        case "tool-call":
          active.set(event.id, event.name)
          activity = activities[event.name] ?? "Using tools"
          yield* update(undefined)
          break
        case "tool-result":
          completed.add(event.id)
          active.delete(event.id)
          const name = active.values().next().value
          activity = name === undefined ? "Working" : (activities[name] ?? "Using tools")
          yield* update(undefined)
          break
      }
    }),
    finish: update,
    refresh: update(undefined),
  }
})
